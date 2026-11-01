import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { LookyUnavailableError, type IndexCatalog, type IndexResolution } from "../contract/ports";
import { isFullCommitSha } from "../contract/context";
import type { IndexCoverage, IndexProgress } from "../contract/response";
import type { WorkerRequest, WorkerResponse } from "./build-worker";
import { commitExists, repositoryAccessible } from "./git-snapshot";
import { runIndexBuild } from "./ingest";
import { DEFAULT_INDEX_LIMITS, indexKey, type IndexLimits, validateLimits } from "./policy";
import {
  acquireLease,
  type BuildRecord,
  collectGarbage,
  coverageReport,
  type CoverageReport,
  failInterruptedBuilds,
  findActiveBuild,
  findLatestBuild,
  findOtherReadyBuild,
  findReadyBuild,
  finishUnsuccessfully,
  type GarbageReport,
  getBuild,
  type IndexedChunk,
  type IndexScope,
  insertQueuedBuild,
  listBuilds,
  listChunks,
  releaseLease,
  retireBuild,
  scopeStatus,
  type ScopeStatus,
  searchChunks,
  snapshotIntact,
} from "./store";

export interface IndexRetention {
  /** Served generations kept per repository; least recently used are retired first. */
  readonly retainReadyPerRepository: number;
  /** Failed and cancelled build records kept per repository for diagnostics. */
  readonly retainFailedPerRepository: number;
  /** How long a reader lease pins a generation unless released earlier. */
  readonly leaseTtlMs: number;
}

export const DEFAULT_INDEX_RETENTION: IndexRetention = {
  retainReadyPerRepository: 3,
  retainFailedPerRepository: 20,
  leaseTtlMs: 30 * 60 * 1000,
};

export interface IndexServiceOptions {
  /** Looky's database. Worker execution requires a file-backed database. */
  readonly db: Database;
  /**
   * Map an authorized repository id to its local Git directory. Unknown ids
   * are refused; there is no global or cross-repository index. The callback
   * is consulted on every operation and read, so returning undefined revokes
   * access immediately.
   */
  readonly repositories: (repositoryId: string) => string | undefined;
  readonly limits?: IndexLimits;
  readonly maxConcurrentBuilds?: number;
  readonly retention?: Partial<IndexRetention>;
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

/**
 * The repository is not, or no longer, authorized for this service. It is a
 * {@link LookyUnavailableError}, so `ask_project` reports it as unavailable.
 */
export class IndexAccessDeniedError extends LookyUnavailableError {}

interface RunningBuild {
  cancel(): void;
}

interface QueuedBuild {
  readonly id: string;
  readonly directory: string;
}

type Scope = { readonly repositoryId: string; readonly sha: string };

/**
 * Owns the versioned index lifecycle for authorized repositories: exact-SHA
 * catalog lookups with reader leases, one shared build per repository, SHA
 * and index key, incremental refresh, explicit rebuild and retry, a bounded
 * build queue, cancellation, restart recovery and bounded retention.
 * Implements the ask_project {@link IndexCatalog} port.
 *
 * A single service process owns a database. On construction, builds left
 * queued or running by a previous process are marked failed (`interrupted`,
 * retryable) and are never served; their staged rows are collected and the
 * next request starts a fresh build that can refresh from the last ready one.
 */
export class IndexService implements IndexCatalog {
  private readonly db: Database;
  private readonly limits: IndexLimits;
  /** Index/chunk schema key of every build this service starts and serves. */
  readonly indexKey: string;
  private readonly retention: IndexRetention;
  private readonly maxConcurrent: number;
  private readonly executor: "worker" | "inline";
  private readonly queue: QueuedBuild[] = [];
  private readonly running = new Map<string, RunningBuild>();
  private readonly settled = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  /** Ready builds whose stored snapshot was checked complete by this process. */
  private readonly verified = new Set<string>();
  private readonly ownerToken = `${process.pid}:${crypto.randomUUID()}`;
  private closed = false;

  constructor(private readonly options: IndexServiceOptions) {
    this.db = options.db;
    this.limits = options.limits ?? DEFAULT_INDEX_LIMITS;
    validateLimits(this.limits);
    this.indexKey = indexKey(this.limits);
    this.retention = { ...DEFAULT_INDEX_RETENTION, ...options.retention };
    for (const [name, value] of Object.entries(this.retention)) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Index retention ${name} must be a positive integer`);
      }
    }
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
    this.collectGarbage();
  }

  /**
   * IndexCatalog: the ready generation for exactly this SHA, pinned by a
   * lease, or the build serving it. Prewarming, for example at task
   * admission, is the same call without using the result.
   */
  async resolve(scope: Scope, signal: AbortSignal): Promise<IndexResolution> {
    for (let attempt = 0; ; attempt += 1) {
      const result = await this.startBuild(scope, { signal });
      switch (result.state) {
        case "unsupported_revision":
          return result;
        case "ready": {
          // Pin before returning. If the generation was collected in between, look again.
          const lease = acquireLease(this.db, result.build.id, this.retention.leaseTtlMs);
          if (!lease) {
            if (attempt < 2) continue;
            throw new LookyUnavailableError("The index generation changed during lookup; retry");
          }
          const coverage = coverageSummary(this.db, result.build.id);
          return {
            state: "ready",
            generation: { generationId: result.build.id, sha: result.build.sha },
            lease: { release: () => this.releaseLease(lease.leaseId, result.build.id) },
            ...(coverage ? { coverage } : {}),
          };
        }
        case "failed":
          return {
            state: "failed",
            buildId: result.build.id,
            message: failureMessage(result.build),
            retryable: false,
          };
        case "building": {
          const stale = findOtherReadyBuild(this.db, this.keyed(scope));
          return {
            state: "building",
            buildId: result.build.id,
            progress: progressOf(result.build),
            ...(stale ? { staleGeneration: { generationId: stale.id, sha: stale.sha } } : {}),
          };
        }
      }
    }
  }

  /**
   * Return the ready build, join the active build, or queue a new one. The
   * new build refreshes incrementally from the nearest ready ancestor.
   *
   * - `rebuild: true` starts a full build even if the SHA is ready; the ready
   *   generation keeps serving until the new one publishes and replaces it.
   * - `retry: true` starts a new attempt after a non-retryable failure.
   *
   * A build that failed with a non-retryable error is otherwise reported
   * instead of retried automatically.
   */
  async startBuild(
    scope: Scope,
    options: {
      readonly rebuild?: boolean;
      readonly retry?: boolean;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<StartBuildResult> {
    if (this.closed) throw new LookyUnavailableError("The index service is closed");
    const signal = options.signal ?? new AbortController().signal;
    const directory = this.directoryOf(scope.repositoryId);
    if (!isFullCommitSha(scope.sha)) {
      return { state: "unsupported_revision", message: "A full lowercase commit SHA is required" };
    }
    const keyed = this.keyed(scope);
    const rebuild = options.rebuild ?? false;
    const retry = options.retry ?? false;

    const known = this.existing(keyed, rebuild, retry);
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
    if (this.closed) throw new LookyUnavailableError("The index service is closed");

    // Check again and insert under the write lock so concurrent callers share
    // one build: the unique active-build index makes the work identity idempotent.
    const outcome = this.db
      .transaction((): StartBuildResult => {
        const raced = this.existing(keyed, rebuild, retry);
        if (raced) return raced;
        const build = insertQueuedBuild(this.db, {
          id: `build_${crypto.randomUUID()}`,
          ...keyed,
          requestedMode: rebuild ? "full" : "auto",
        });
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

  /** Start a full build of the SHA. See {@link startBuild}. */
  rebuild(scope: Scope, signal?: AbortSignal): Promise<StartBuildResult> {
    return this.startBuild(scope, { rebuild: true, ...(signal ? { signal } : {}) });
  }

  /**
   * Start a new attempt for the scope of a failed or cancelled build. Returns
   * the ready or active build instead when the scope no longer needs one.
   */
  retry(buildId: string, signal?: AbortSignal): Promise<StartBuildResult> {
    const build = getBuild(this.db, buildId);
    if (!build) throw new Error(`Unknown index build ${buildId}`);
    return this.startBuild(
      { repositoryId: build.repositoryId, sha: build.sha },
      { retry: true, ...(signal ? { signal } : {}) },
    );
  }

  /** Lifecycle status of a repository and SHA under the current index key. Starts nothing. */
  indexStatus(scope: Scope): ScopeStatus {
    this.directoryOf(scope.repositoryId);
    return scopeStatus(this.db, this.keyed(scope));
  }

  private keyed(scope: Scope): IndexScope {
    return { repositoryId: scope.repositoryId, sha: scope.sha, indexKey: this.indexKey };
  }

  private directoryOf(repositoryId: string): string {
    const directory = this.options.repositories(repositoryId);
    if (directory === undefined) {
      throw new IndexAccessDeniedError(`No source access configured for ${repositoryId}`);
    }
    return directory;
  }

  private existing(
    scope: IndexScope,
    rebuild: boolean,
    retry: boolean,
  ): StartBuildResult | undefined {
    if (!rebuild) {
      const ready = findReadyBuild(this.db, scope);
      if (ready) {
        if (this.intact(ready)) return { state: "ready", build: ready };
        // Missing or partial storage is never reported as ready: stop serving it and rebuild.
        retireBuild(this.db, ready.id);
      }
    }
    const active = findActiveBuild(this.db, scope);
    if (active) return { state: "building", build: active };
    const latest = findLatestBuild(this.db, scope);
    if (!rebuild && !retry && latest?.state === "failed" && latest.retryable === false) {
      return { state: "failed", build: latest };
    }
    return undefined;
  }

  private intact(build: BuildRecord): boolean {
    if (this.verified.has(build.id)) return true;
    if (!snapshotIntact(this.db, build)) return false;
    this.verified.add(build.id);
    return true;
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
        this.collectWhenIdle();
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

  /**
   * Cancel a queued or running build. Returns false if it had already
   * finished. A ready generation, including the one a cancelled rebuild would
   * have replaced, is never touched.
   */
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
    const changed = finishUnsuccessfully(this.db, buildId, {
      state: "cancelled",
      code: "cancelled",
      message: "The build was cancelled",
      retryable: true,
    });
    this.collectWhenIdle();
    return changed;
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

  // -------------------------------------------------------------------------
  // Authorized reads of one pinned generation

  /** Chunks of a ready generation. Refused once the repository is no longer authorized. */
  listChunks(
    request: { readonly repositoryId: string; readonly generationId: string },
    options: { readonly path?: string } = {},
  ): IndexedChunk[] {
    this.authorizeRead(request);
    return listChunks(this.db, request.generationId, options);
  }

  /** Full-text search within a ready generation. Refused once access is revoked. */
  searchChunks(request: {
    readonly repositoryId: string;
    readonly generationId: string;
    readonly query: string;
    readonly limit: number;
  }): (IndexedChunk & { readonly score: number })[] {
    this.authorizeRead(request);
    return searchChunks(this.db, {
      buildId: request.generationId,
      query: request.query,
      limit: request.limit,
    });
  }

  private authorizeRead(request: {
    readonly repositoryId: string;
    readonly generationId: string;
  }): void {
    this.directoryOf(request.repositoryId);
    const build = getBuild(this.db, request.generationId);
    if (build && build.repositoryId !== request.repositoryId) {
      throw new IndexAccessDeniedError(
        `Generation ${request.generationId} does not belong to ${request.repositoryId}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Retention

  private releaseLease(leaseId: string, buildId: string): void {
    try {
      releaseLease(this.db, leaseId);
      if (getBuild(this.db, buildId)?.retiredAt) this.collectWhenIdle();
    } catch (error) {
      // Releasing runs as a request ends and must not replace its result. An
      // unreleased lease only delays cleanup until it expires.
      console.error("looky: could not release index lease:", errorText(error));
    }
  }

  /**
   * Apply retention now: retire generations beyond the per-repository limit or
   * of another index key, delete retired generations no reader holds, drop
   * staged rows of failed builds and unreferenced chunk content. Skipped while
   * a build is queued or running; it runs again when builds go idle.
   */
  collectGarbage(): GarbageReport {
    const report = collectGarbage(this.db, {
      indexKey: this.indexKey,
      retainReadyPerRepository: this.retention.retainReadyPerRepository,
      retainFailedPerRepository: this.retention.retainFailedPerRepository,
    });
    for (const buildId of this.verified) {
      if (!getBuild(this.db, buildId)) this.verified.delete(buildId);
    }
    return report;
  }

  private collectWhenIdle(): void {
    if (this.closed || this.running.size > 0 || this.queue.length > 0) return;
    try {
      this.collectGarbage();
    } catch (error) {
      // Runs from build completion callbacks. Retention is retried at the next
      // idle point, so a failed pass, such as a busy database, is only reported.
      console.error("looky: index garbage collection failed:", errorText(error));
    }
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureMessage(build: BuildRecord): string {
  return `Index build ${build.id} failed (${build.errorCode ?? "unknown"}): ${build.errorMessage ?? ""}`.trim();
}

/** Indexed and excluded entry counts of a build, without listing excluded paths. */
function coverageSummary(db: Database, buildId: string): IndexCoverage | undefined {
  const report = coverageReport(db, buildId, { excludedLimit: 0 });
  if (!report) return undefined;
  const sum = (counts: Readonly<Record<string, number | undefined>>) =>
    Object.values(counts).reduce<number>((total, files) => total + (files ?? 0), 0);
  const excludedByReason: Record<string, number> = {};
  for (const [reason, files] of Object.entries(report.excludedByReason)) {
    if (files) excludedByReason[reason] = files;
  }
  return {
    indexedFiles: sum(report.indexedByLanguage),
    excludedFiles: sum(excludedByReason),
    excludedByReason,
  };
}
