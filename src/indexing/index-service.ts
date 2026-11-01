import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { LookyUnavailableError, type IndexCatalog, type IndexResolution } from "../contract/ports";
import { isFullCommitSha } from "../contract/context";
import type { IndexProgress } from "../contract/response";
import type { WorkerRequest, WorkerResponse } from "./build-worker";
import { commitExists, repositoryAccessible } from "./git-snapshot";
import { runIndexBuild } from "./ingest";
import { DEFAULT_INDEX_LIMITS, type IndexLimits, validateLimits } from "./policy";
import {
  type BuildRecord,
  coverageReport,
  type CoverageReport,
  failInterruptedBuilds,
  findActiveBuild,
  findLatestBuild,
  findOtherReadyBuild,
  findReadyBuild,
  finishUnsuccessfully,
  getBuild,
  insertQueuedBuild,
  listBuilds,
} from "./store";

export interface IndexServiceOptions {
  /** Looky's database. Worker execution requires a file-backed database. */
  readonly db: Database;
  /**
   * Map an authorized repository id to its local Git directory. Unknown ids
   * are refused; there is no global or cross-repository index.
   */
  readonly repositories: (repositoryId: string) => string | undefined;
  readonly limits?: IndexLimits;
  readonly maxConcurrentBuilds?: number;
  /**
   * `worker` (default) runs each build on a worker thread with its own
   * connection. `inline` runs on the caller's thread, for tests and tools.
   */
  readonly executor?: "worker" | "inline";
}

export type StartBuildResult =
  | { readonly state: "ready"; readonly build: BuildRecord }
  | { readonly state: "building"; readonly build: BuildRecord }
  | { readonly state: "failed"; readonly build: BuildRecord }
  | { readonly state: "unsupported_revision"; readonly message: string };

interface RunningBuild {
  cancel(): void;
}

interface QueuedBuild {
  readonly id: string;
  readonly directory: string;
}

/**
 * Owns index builds for authorized repositories: exact-SHA catalog lookups,
 * one shared build per scope, a bounded build queue, cancellation and
 * restart recovery. Implements the ask_project {@link IndexCatalog} port.
 *
 * A single service process owns a database. On construction, builds left
 * queued or running by a previous process are marked failed (`interrupted`,
 * retryable) and are never served; the next request starts a fresh build.
 */
export class IndexService implements IndexCatalog {
  private readonly db: Database;
  private readonly limits: IndexLimits;
  private readonly maxConcurrent: number;
  private readonly executor: "worker" | "inline";
  private readonly queue: QueuedBuild[] = [];
  private readonly running = new Map<string, RunningBuild>();
  private readonly settled = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  private closed = false;

  constructor(private readonly options: IndexServiceOptions) {
    this.db = options.db;
    this.limits = options.limits ?? DEFAULT_INDEX_LIMITS;
    validateLimits(this.limits);
    this.maxConcurrent = options.maxConcurrentBuilds ?? 1;
    if (!Number.isSafeInteger(this.maxConcurrent) || this.maxConcurrent < 1) {
      throw new Error("maxConcurrentBuilds must be a positive integer");
    }
    this.executor = options.executor ?? "worker";
    if (this.executor === "worker" && !this.db.filename) {
      throw new Error("Worker index builds require a file-backed database");
    }
    acquireBuildOwnership(this.db, this.ownerToken);
    failInterruptedBuilds(this.db);
  }

  private readonly ownerToken = `${process.pid}:${crypto.randomUUID()}`;

  /** IndexCatalog: the ready generation for exactly this SHA, or the build serving it. */
  async resolve(
    scope: { readonly repositoryId: string; readonly sha: string },
    signal: AbortSignal,
  ): Promise<IndexResolution> {
    const result = await this.startBuild(scope, { signal });
    switch (result.state) {
      case "unsupported_revision":
        return result;
      case "ready":
        return {
          state: "ready",
          generation: { generationId: result.build.id, sha: result.build.sha },
        };
      case "failed":
        return {
          state: "failed",
          buildId: result.build.id,
          message: failureMessage(result.build),
          retryable: false,
        };
      case "building": {
        const stale = findOtherReadyBuild(this.db, scope.repositoryId, scope.sha);
        return {
          state: "building",
          buildId: result.build.id,
          progress: progressOf(result.build),
          ...(stale ? { staleGeneration: { generationId: stale.id, sha: stale.sha } } : {}),
        };
      }
    }
  }

  /**
   * Return the ready build, join the active build, or queue a new one.
   * A build that failed with a non-retryable error is reported instead of
   * retried automatically; pass `rebuild: true` to start a new attempt.
   */
  async startBuild(
    scope: { readonly repositoryId: string; readonly sha: string },
    options: { readonly rebuild?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<StartBuildResult> {
    if (this.closed) throw new LookyUnavailableError("The index service is closed");
    const signal = options.signal ?? new AbortController().signal;
    const directory = this.options.repositories(scope.repositoryId);
    if (directory === undefined) {
      throw new LookyUnavailableError(`No source access configured for ${scope.repositoryId}`);
    }
    if (!isFullCommitSha(scope.sha)) {
      return { state: "unsupported_revision", message: "A full lowercase commit SHA is required" };
    }

    const known = this.existing(scope, options.rebuild ?? false);
    if (known) return known;

    if (!(await commitExists(directory, scope.sha, signal))) {
      if (!(await repositoryAccessible(directory, signal))) {
        throw new LookyUnavailableError(`Repository ${scope.repositoryId} is not accessible`);
      }
      return {
        state: "unsupported_revision",
        message: `Commit ${scope.sha} does not exist in repository ${scope.repositoryId}`,
      };
    }
    signal.throwIfAborted();

    // Check again and insert under the write lock so concurrent callers share one build.
    const outcome = this.db
      .transaction((): StartBuildResult => {
        const raced = this.existing(scope, options.rebuild ?? false);
        if (raced) return raced;
        const build = insertQueuedBuild(this.db, { id: `build_${crypto.randomUUID()}`, ...scope });
        return { state: "building", build };
      })
      .immediate();
    if (
      outcome.state === "building" &&
      outcome.build.state === "queued" &&
      !this.isTracked(outcome.build.id)
    ) {
      this.enqueue({ id: outcome.build.id, directory });
    }
    return outcome;
  }

  private existing(
    scope: { readonly repositoryId: string; readonly sha: string },
    rebuild: boolean,
  ): StartBuildResult | undefined {
    const ready = findReadyBuild(this.db, scope.repositoryId, scope.sha);
    if (ready) return { state: "ready", build: ready };
    const active = findActiveBuild(this.db, scope.repositoryId, scope.sha);
    if (active) return { state: "building", build: active };
    const latest = findLatestBuild(this.db, scope.repositoryId, scope.sha);
    if (!rebuild && latest?.state === "failed" && latest.retryable === false) {
      return { state: "failed", build: latest };
    }
    return undefined;
  }

  private isTracked(buildId: string): boolean {
    return this.running.has(buildId) || this.queue.some((item) => item.id === buildId);
  }

  private enqueue(item: QueuedBuild): void {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    this.settled.set(item.id, { promise, resolve });
    this.queue.push(item);
    this.pump();
  }

  private pump(): void {
    while (!this.closed && this.running.size < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      const finish = () => {
        this.running.delete(item.id);
        this.settled.get(item.id)?.resolve();
        this.settled.delete(item.id);
        this.pump();
      };
      this.running.set(
        item.id,
        this.executor === "worker" ? this.runInWorker(item, finish) : this.runInline(item, finish),
      );
    }
  }

  private runInline(item: QueuedBuild, finish: () => void): RunningBuild {
    const controller = new AbortController();
    void runIndexBuild({
      db: this.db,
      buildId: item.id,
      directory: item.directory,
      limits: this.limits,
      signal: controller.signal,
    }).finally(finish);
    return { cancel: () => controller.abort() };
  }

  private runInWorker(item: QueuedBuild, finish: () => void): RunningBuild {
    const worker = new Worker(new URL("./build-worker.ts", import.meta.url).href);
    let done = false;
    const end = (crash?: string) => {
      if (done) return;
      done = true;
      if (crash !== undefined) {
        finishUnsuccessfully(this.db, item.id, {
          state: "failed",
          code: "worker_failed",
          message: crash,
          retryable: true,
        });
      }
      worker.terminate();
      finish();
    };
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (event.data.type === "done") end();
    };
    worker.onerror = (event) => end(`Index worker failed: ${event.message}`);
    worker.addEventListener("close", () => end("Index worker exited before finishing"));
    worker.postMessage({
      type: "start",
      databaseFile: this.db.filename,
      buildId: item.id,
      directory: item.directory,
      limits: this.limits,
    } satisfies WorkerRequest);
    return { cancel: () => worker.postMessage({ type: "cancel" } satisfies WorkerRequest) };
  }

  /** Cancel a queued or running build. Returns false if it had already finished. */
  cancel(buildId: string): boolean {
    const queued = this.queue.findIndex((item) => item.id === buildId);
    if (queued !== -1) {
      this.queue.splice(queued, 1);
      this.settled.get(buildId)?.resolve();
      this.settled.delete(buildId);
    }
    const running = this.running.get(buildId);
    if (running) {
      running.cancel();
      return true;
    }
    return finishUnsuccessfully(this.db, buildId, {
      state: "cancelled",
      code: "cancelled",
      message: "The build was cancelled",
      retryable: true,
    });
  }

  /** Wait until a build started by this service finishes, then return its record. */
  async waitForBuild(buildId: string, signal?: AbortSignal): Promise<BuildRecord> {
    const pending = this.settled.get(buildId);
    if (pending) {
      await (signal
        ? Promise.race([
            pending.promise,
            new Promise<never>((_, reject) => {
              if (signal.aborted) reject(signal.reason);
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          ])
        : pending.promise);
    }
    const build = getBuild(this.db, buildId);
    if (!build) throw new Error(`Unknown index build ${buildId}`);
    return build;
  }

  status(buildId: string): BuildRecord | undefined {
    return getBuild(this.db, buildId);
  }

  builds(filter: Parameters<typeof listBuilds>[1] = {}): BuildRecord[] {
    return listBuilds(this.db, filter);
  }

  coverage(
    buildId: string,
    options?: { readonly excludedLimit?: number },
  ): CoverageReport | undefined {
    return coverageReport(this.db, buildId, options);
  }

  /** Stop accepting builds, cancel queued and running ones, and wait for them to stop. */
  async close(): Promise<void> {
    this.closed = true;
    for (const item of this.queue.splice(0)) {
      finishUnsuccessfully(this.db, item.id, {
        state: "cancelled",
        code: "service_stopped",
        message: "The service stopped before this build started",
        retryable: true,
      });
      this.settled.get(item.id)?.resolve();
      this.settled.delete(item.id);
    }
    const waits = [...this.settled.values()].map((entry) => entry.promise);
    for (const running of this.running.values()) running.cancel();
    await Promise.all(waits);
    releaseBuildOwnership(this.db, this.ownerToken);
  }
}

const OWNER_KEY = "index_build_owner";

/**
 * One process per database runs index builds. Ownership is recorded in
 * `app_metadata` with the owner's pid; a live owner on this host blocks
 * another service, and a dead owner's claim is taken over.
 */
function acquireBuildOwnership(db: Database, token: string): void {
  db.transaction(() => {
    const row = db
      .query<{ value: string }, [string]>("SELECT value FROM app_metadata WHERE key = ?")
      .get(OWNER_KEY);
    if (row) {
      const owner = JSON.parse(row.value) as { pid: number; host: string; token: string };
      if (owner.token !== token && owner.host === hostname() && processAlive(owner.pid)) {
        throw new LookyUnavailableError(
          `Index builds in this database are owned by running process ${owner.pid}`,
        );
      }
    }
    db.query("INSERT OR REPLACE INTO app_metadata (key, value) VALUES (?, ?)").run(
      OWNER_KEY,
      JSON.stringify({ pid: process.pid, host: hostname(), token }),
    );
  }).immediate();
}

function releaseBuildOwnership(db: Database, token: string): void {
  db.query("DELETE FROM app_metadata WHERE key = ? AND json_extract(value, '$.token') = ?").run(
    OWNER_KEY,
    token,
  );
}

function processAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function progressOf(build: BuildRecord): IndexProgress {
  return {
    phase: build.phase,
    ...(build.filesTotal > 0 ? { filesDone: build.filesDone, filesTotal: build.filesTotal } : {}),
  };
}

function failureMessage(build: BuildRecord): string {
  return `Index build ${build.id} failed (${build.errorCode ?? "unknown"}): ${build.errorMessage ?? ""}`.trim();
}
