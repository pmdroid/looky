import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { askProject } from "../src/ask/ask-project";
import { LookyUnavailableError, type AnswerEngine } from "../src/contract/ports";
import { IndexAccessDeniedError, IndexService } from "../src/indexing/index-service";
import { DEFAULT_INDEX_LIMITS, indexKey, type IndexLimits } from "../src/indexing/policy";
import {
  activeLeases,
  type BuildRecord,
  coverageReport,
  getBuild,
  IndexNotReadyError,
  insertQueuedBuild,
  listChunks,
  searchChunks,
  type IndexedChunk,
} from "../src/indexing/store";
import { IndexRetriever } from "../src/retrieval/index-retriever";
import { GitSourceReader } from "../src/source/git-source-reader";
import { Database as SqliteDatabase } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { openDatabase } from "../src/storage/database";
import { migrate, migrations } from "../src/storage/migrations";
import { makeAdapter, makeContext, makeServices } from "./support/ask-fakes";
import { buildFixtureRepo, commitAll, git, write } from "./support/git-fixture";

const LIMITS: IndexLimits = { ...DEFAULT_INDEX_LIMITS, maxFileBytes: 65_536 };
const signal = new AbortController().signal;

describe("versioned index refresh and recovery", () => {
  let root: string;
  let repo: string;
  let dataDir: string;
  let base: string;
  let authorized: Set<string>;
  const open: { db?: Database; services: IndexService[] } = { services: [] };

  function database(): Database {
    open.db = openDatabase({ dataDir });
    return open.db;
  }

  function service(
    db: Database,
    options: Partial<ConstructorParameters<typeof IndexService>[0]> = {},
  ): IndexService {
    const created = new IndexService({
      db,
      repositories: (id) => (authorized.has(id) ? repo : undefined),
      limits: LIMITS,
      executor: "inline",
      ...options,
    });
    open.services.push(created);
    return created;
  }

  async function closeAll() {
    for (const created of open.services.splice(0)) await created.close();
    open.db?.close();
    delete open.db;
  }

  async function ready(svc: IndexService, sha: string, rebuild = false): Promise<BuildRecord> {
    const started = await svc.startBuild({ repositoryId: "fixture", sha }, { rebuild });
    if (started.state === "unsupported_revision") throw new Error(started.message);
    const build = await svc.waitForBuild(started.build.id);
    expect(build).toMatchObject({ state: "ready", errorCode: null });
    return build;
  }

  function paths(db: Database, buildId: string, query: string): string[] {
    return [
      ...new Set(searchChunks(db, { buildId, query, limit: 50 }).map((hit) => hit.path)),
    ].sort();
  }

  /** Path, lines, text and blob of every chunk: what search results and citations rely on. */
  function manifest(chunks: IndexedChunk[]) {
    return chunks.map(({ path, startLine, endLine, text, blobOid, symbols }) => ({
      path,
      startLine,
      endLine,
      text,
      blobOid,
      symbols,
    }));
  }

  async function expectExactProvenance(build: BuildRecord, chunks: IndexedChunk[]) {
    const reader = new GitSourceReader(() => repo);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      expect(chunk.sha).toBe(build.sha);
      expect(chunk.buildId).toBe(build.id);
      const source = await reader.read(
        { ...chunk, repositoryId: "fixture", maxBytes: 1_000_000 },
        signal,
      );
      expect(source.text).toBe(chunk.text);
      expect(chunk.blobOid).toBe(git(repo, "rev-parse", `${chunk.sha}:${chunk.path}`));
    }
  }

  /** Add, edit, delete and rename on top of the fixture commit. */
  function changeRepository(): string {
    write(repo, "src/orders/place-order.ts", "export function placeOrderNow() {\n  return 1;\n}\n");
    write(
      repo,
      "src/users/ids.js",
      "export function normalizeUserId(raw) {\n  return String(raw).normalizeEditedMarker();\n}\n",
    );
    git(repo, "rm", "--quiet", "config/app.yaml");
    git(repo, "mv", "README.md", "docs/OVERVIEW.md");
    // Stage only these paths: the fixture's synthetic submodule entry has no directory.
    git(repo, "add", "src/orders/place-order.ts", "src/users/ids.js");
    git(repo, "commit", "--quiet", "-m", "add, edit, delete and rename");
    return git(repo, "rev-parse", "HEAD");
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "looky-refresh-"));
    repo = join(root, "repo");
    dataDir = join(root, "data");
    authorized = new Set(["fixture"]);
    Bun.spawnSync(["mkdir", "-p", repo]);
    base = buildFixtureRepo(repo);
  });

  afterEach(async () => {
    try {
      await closeAll();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("add, edit, delete and rename refresh incrementally to exact new-revision results", async () => {
    const db = database();
    const svc = service(db);
    const first = await ready(svc, base);
    expect(first.refresh).toMatchObject({ mode: "full", reason: "no_base" });
    const next = changeRepository();

    const refreshed = await ready(svc, next);
    expect(refreshed.refresh).toMatchObject({
      mode: "incremental",
      baseBuildId: first.id,
      baseSha: base,
      added: 1,
      modified: 1,
      deleted: 1,
      renamed: 1,
    });
    // Unchanged entries were carried without being read again; coverage is complete.
    expect(refreshed.refresh.carried).toBe(refreshed.filesTotal - 3);
    expect(refreshed.filesReused).toBe(refreshed.filesIndexed - 2);
    const coverage = coverageReport(db, refreshed.id)!;
    expect(coverage.complete).toBe(true);
    expect(coverage.build.refresh.mode).toBe("incremental");
    expect(refreshed.filesTotal).toBe(
      git(repo, "ls-tree", "-r", "--name-only", next).split("\n").length,
    );

    // New revision: added and renamed code is found, deleted and replaced code is gone.
    expect(paths(db, refreshed.id, "placeOrderNow")).toEqual(["src/orders/place-order.ts"]);
    expect(paths(db, refreshed.id, "normalizeEditedMarker")).toEqual(["src/users/ids.js"]);
    expect(paths(db, refreshed.id, "toLowerCase")).toEqual([]);
    expect(paths(db, refreshed.id, "maxAttempts")).toEqual([]);
    expect(listChunks(db, refreshed.id, { path: "config/app.yaml" })).toEqual([]);
    expect(listChunks(db, refreshed.id, { path: "README.md" })).toEqual([]);
    expect(paths(db, refreshed.id, "Explains")).toEqual(["docs/OVERVIEW.md"]);
    await expectExactProvenance(refreshed, listChunks(db, refreshed.id));

    // The old generation still answers for its own revision only.
    expect(paths(db, first.id, "placeOrderNow")).toEqual([]);
    expect(paths(db, first.id, "maxAttempts")).toEqual(["config/app.yaml"]);
    expect(paths(db, first.id, "toLowerCase")).toEqual(["src/users/ids.js"]);

    // An incremental refresh is identical to a full build of the same commit.
    const incremental = manifest(listChunks(db, refreshed.id));
    const full = await ready(svc, next, true);
    expect(full.refresh).toMatchObject({ mode: "full", reason: "rebuild_requested" });
    expect(manifest(listChunks(db, full.id))).toEqual(incremental);
    const fullCoverage = coverageReport(db, full.id)!;
    expect(fullCoverage.excluded).toEqual(coverage.excluded);
    expect(fullCoverage.indexedByLanguage).toEqual(coverage.indexedByLanguage);
    // The replaced generation was retired atomically and, unheld, collected.
    expect(getBuild(db, refreshed.id)).toBeUndefined();
  });

  test("a non-ancestor branch or force-moved ref falls back to a full build", async () => {
    const db = database();
    const svc = service(db);
    write(repo, "src/main-only.ts", "export const mainOnlyFeature = 1;\n");
    const mainHead = commitAll(repo, "main work");
    await ready(svc, mainHead);

    // Rewrite history: a branch from the fixture commit that main's head is not an ancestor of.
    git(repo, "checkout", "--quiet", "-b", "rewritten", base);
    write(repo, "src/rewritten.ts", "export const rewrittenFeature = 1;\n");
    const rewritten = commitAll(repo, "rewritten");

    const build = await ready(svc, rewritten);
    expect(build.refresh).toMatchObject({ mode: "full", reason: "not_ancestor", carried: 0 });
    expect(paths(db, build.id, "mainOnlyFeature")).toEqual([]);
    expect(paths(db, build.id, "rewrittenFeature")).toEqual(["src/rewritten.ts"]);
    await expectExactProvenance(build, listChunks(db, build.id));
  });

  test("a changed index schema is never served and rebuilds without reusing old chunks", async () => {
    const db = database();
    const old = await ready(service(db), base);
    await closeAll();

    const changed = { ...LIMITS, chunkLines: 20, chunkOverlapLines: 2 };
    expect(indexKey(changed)).not.toBe(indexKey(LIMITS));
    const reopened = database();
    const svc = service(reopened, { limits: changed });
    // Opening under a new key retires the incompatible generation.
    expect(getBuild(reopened, old.id)).toBeUndefined();
    const resolution = await svc.resolve({ repositoryId: "fixture", sha: base }, signal);
    expect(resolution.state).toBe("building");
    const build = await svc.waitForBuild((resolution as { buildId: string }).buildId);
    expect(build).toMatchObject({ state: "ready", filesReused: 0, indexKey: indexKey(changed) });
    expect(build.refresh).toMatchObject({ mode: "full", reason: "no_base" });
    const python = listChunks(reopened, build.id, { path: "tools/retry_policy.py" });
    expect(python.every((chunk) => chunk.endLine - chunk.startLine + 1 <= 20)).toBe(true);
  });

  test("concurrent old and new revision requests each see one complete generation", async () => {
    const db = database();
    const svc = service(db);
    const first = await ready(svc, base);
    const before = manifest(listChunks(db, first.id));
    const next = changeRepository();

    const [newer, older] = await Promise.all([
      svc.resolve({ repositoryId: "fixture", sha: next }, signal),
      svc.resolve({ repositoryId: "fixture", sha: base }, signal),
    ]);
    // The new SHA is building; the old generation is disclosed but never used for it.
    expect(newer).toMatchObject({
      state: "building",
      staleGeneration: { generationId: first.id, sha: base },
    });
    expect(older).toMatchObject({ state: "ready", generation: { generationId: first.id } });
    // While the refresh is staged, the old generation is unchanged.
    expect(manifest(listChunks(db, first.id))).toEqual(before);
    expect(() => listChunks(db, (newer as { buildId: string }).buildId)).toThrow(
      IndexNotReadyError,
    );

    const refreshed = await svc.waitForBuild((newer as { buildId: string }).buildId);
    expect(refreshed.state).toBe("ready");
    expect(manifest(listChunks(db, first.id))).toEqual(before);
    for (const chunk of listChunks(db, refreshed.id)) {
      expect(chunk.sha).toBe(next);
      expect(chunk.blobOid).toBe(git(repo, "rev-parse", `${next}:${chunk.path}`));
    }
    (older as { lease?: { release(): void } }).lease?.release();
  });

  test("a requested SHA that is not ready blocks answering with an explicit indexing result", async () => {
    const db = database();
    const svc = service(db);
    const first = await ready(svc, base);
    const next = changeRepository();
    const { services, recorded } = makeServices({ catalog: svc });

    const response = await askProject(
      { question: "How are orders placed?" },
      makeAdapter(makeContext({ repositoryId: "fixture", sha: next })),
      services,
    );
    expect(response).toMatchObject({
      status: "indexing",
      mode: { executed: null },
      revision: { sha: next },
      staleIndex: { generationId: first.id, sha: base },
    });
    expect(recorded.searches).toEqual([]);
    expect(recorded.modelCalls).toEqual([]);

    await svc.waitForBuild((response as { buildId: string }).buildId);
    const answered = await askProject(
      { question: "How are orders placed?" },
      makeAdapter(makeContext({ repositoryId: "fixture", sha: next })),
      services,
    );
    expect(answered).toMatchObject({ status: "answered", index: { sha: next } });
    expect((answered as { index: { generationId: string } }).index.generationId).not.toBe(first.id);
  });

  test("ask_project pins its generation with a lease for exactly the request", async () => {
    const db = database();
    const svc = service(db);
    const build = await ready(svc, base);
    const held: number[] = [];
    const engine: AnswerEngine = {
      async answer(session) {
        held.push(activeLeases(db, session.generation.generationId));
        return {
          text: "The indexed revision does not establish this.",
          outcome: "unknown",
          evidence: [],
        };
      },
    };
    const { services } = makeServices({ catalog: svc, engine });
    const response = await askProject(
      { question: "Anything?" },
      makeAdapter(makeContext({ repositoryId: "fixture", sha: base })),
      services,
    );
    expect(response.status).toBe("answered");
    expect(held).toEqual([1]);
    expect(activeLeases(db, build.id)).toBe(0);
  });

  test("retention never removes a generation an active query holds, and cleans up after", async () => {
    const db = database();
    const svc = service(db, { retention: { retainReadyPerRepository: 1 } });
    const first = await ready(svc, base);
    const pinned = await svc.resolve({ repositoryId: "fixture", sha: base }, signal);
    expect(pinned).toMatchObject({ state: "ready", generation: { generationId: first.id } });

    const next = changeRepository();
    const second = await ready(svc, next);
    // Retention keeps one generation per repository: the old one is retired, not deleted.
    const retired = getBuild(db, first.id)!;
    expect(retired.retiredAt).not.toBeNull();
    expect(paths(db, first.id, "maxAttempts")).toEqual(["config/app.yaml"]);
    expect(svc.collectGarbage()).toMatchObject({ retainedForReaders: 1, buildsDeleted: 0 });
    // Retired generations are not served to new requests for their SHA.
    expect(svc.indexStatus({ repositoryId: "fixture", sha: base }).state).not.toBe("ready");

    (pinned as { lease: { release(): void } }).lease.release();
    expect(getBuild(db, first.id)).toBeUndefined();
    expect(() => listChunks(db, first.id)).toThrow(IndexNotReadyError);
    // Content only the deleted generation used is gone; shared content stays.
    const orphans = db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM index_contents c
         WHERE NOT EXISTS (SELECT 1 FROM index_files f WHERE f.content_id = c.id)`,
      )
      .get()!.n;
    expect(orphans).toBe(0);
    expect(paths(db, second.id, "toLowerCase")).toEqual([]);
    expect(paths(db, second.id, "getUserById").length).toBeGreaterThan(0);
  });

  test("expired leases do not pin storage forever", async () => {
    const db = database();
    const svc = service(db, { retention: { retainReadyPerRepository: 1, leaseTtlMs: 1 } });
    const first = await ready(svc, base);
    await svc.resolve({ repositoryId: "fixture", sha: base }, signal);
    await Bun.sleep(5);
    await ready(svc, changeRepository());
    expect(getBuild(db, first.id)).toBeUndefined();
  });

  test("a crash before publication leaves the last ready generation served and rebuilds", async () => {
    const db = database();
    const first = await ready(service(db), base);
    await closeAll();

    // A rebuild of the same SHA crashed mid-way, leaving staged rows behind.
    const crashedDb = database();
    insertQueuedBuild(crashedDb, {
      id: "crashed",
      repositoryId: "fixture",
      sha: base,
      indexKey: indexKey(LIMITS),
      requestedMode: "full",
    });
    crashedDb.query("UPDATE index_builds SET state = 'running' WHERE id = 'crashed'").run();
    crashedDb
      .query(
        `INSERT INTO index_files (build_id, path, status, reason, mode, byte_size)
         VALUES ('crashed', 'partial.txt', 'excluded', 'empty', '100644', 0)`,
      )
      .run();

    const svc = service(crashedDb);
    expect(svc.status("crashed")).toMatchObject({
      state: "failed",
      errorCode: "interrupted",
      retryable: true,
    });
    const staged = crashedDb
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM index_files WHERE build_id = 'crashed'")
      .get()!.n;
    expect(staged).toBe(0);
    const resolution = await svc.resolve({ repositoryId: "fixture", sha: base }, signal);
    expect(resolution).toMatchObject({ state: "ready", generation: { generationId: first.id } });
  });

  test("a crash after publication keeps exactly one truthful ready generation", async () => {
    const db = database();
    const first = await ready(service(db), base);
    // The process died without closing: its ownership record names a dead process.
    db.query(
      "UPDATE app_metadata SET value = json_set(value, '$.pid', 2147483646, '$.token', 'dead') WHERE key = 'index_build_owner'",
    ).run();
    open.services.splice(0);
    open.db?.close();
    delete open.db;

    const reopened = database();
    const svc = service(reopened);
    expect(await svc.resolve({ repositoryId: "fixture", sha: base }, signal)).toMatchObject({
      state: "ready",
      generation: { generationId: first.id },
    });
    expect(svc.indexStatus({ repositoryId: "fixture", sha: base })).toMatchObject({
      state: "ready",
      ready: { id: first.id },
    });
  });

  test("duplicate build attempts share one work identity and one publisher", async () => {
    const db = database();
    const svc = service(db);
    const attempts = await Promise.all([
      svc.startBuild({ repositoryId: "fixture", sha: base }),
      svc.startBuild({ repositoryId: "fixture", sha: base }),
      svc.resolve({ repositoryId: "fixture", sha: base }, signal),
    ]);
    const ids = attempts.map((attempt) =>
      "build" in attempt ? attempt.build.id : (attempt as { buildId: string }).buildId,
    );
    expect(new Set(ids).size).toBe(1);
    // A second publisher for the same scope is refused by the database itself.
    expect(() =>
      insertQueuedBuild(db, {
        id: "duplicate",
        repositoryId: "fixture",
        sha: base,
        indexKey: indexKey(LIMITS),
        requestedMode: "auto",
      }),
    ).toThrow();
    await svc.waitForBuild(ids[0]!);
    const rebuilds = await Promise.all([
      svc.rebuild({ repositoryId: "fixture", sha: base }),
      svc.rebuild({ repositoryId: "fixture", sha: base }),
    ]);
    expect((rebuilds[0] as { build: BuildRecord }).build.id).toBe(
      (rebuilds[1] as { build: BuildRecord }).build.id,
    );
    await svc.waitForBuild((rebuilds[0] as { build: BuildRecord }).build.id);
    const servedReady = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM index_builds WHERE sha = ? AND state = 'ready' AND retired_at IS NULL",
      )
      .get(base)!.n;
    expect(servedReady).toBe(1);
  });

  test("an explicit rebuild serves the old generation until it publishes; cancelling keeps it", async () => {
    const db = database();
    const svc = service(db);
    const first = await ready(svc, base);

    const cancelled = await svc.rebuild({ repositoryId: "fixture", sha: base });
    const cancelledId = (cancelled as { build: BuildRecord }).build.id;
    expect(svc.indexStatus({ repositoryId: "fixture", sha: base })).toMatchObject({
      state: "ready",
      ready: { id: first.id },
      active: { id: cancelledId },
    });
    expect(await svc.resolve({ repositoryId: "fixture", sha: base }, signal)).toMatchObject({
      state: "ready",
      generation: { generationId: first.id },
    });
    expect(svc.cancel(cancelledId)).toBe(true);
    expect((await svc.waitForBuild(cancelledId)).state).toBe("cancelled");
    expect(svc.indexStatus({ repositoryId: "fixture", sha: base })).toMatchObject({
      state: "ready",
      ready: { id: first.id },
    });

    // Retrying the cancelled rebuild rebuilds again rather than reporting the
    // generation it was meant to replace.
    const retried = await svc.retry(cancelledId);
    expect(retried.state).toBe("building");
    const retriedBuild = await svc.waitForBuild((retried as { build: BuildRecord }).build.id);
    expect(retriedBuild).toMatchObject({
      state: "ready",
      refresh: { mode: "full", reason: "rebuild_requested" },
    });
    expect(retriedBuild.id).not.toBe(first.id);

    const rebuilt = await ready(svc, base, true);
    expect(rebuilt.id).not.toBe(retriedBuild.id);
    expect(await svc.resolve({ repositoryId: "fixture", sha: base }, signal)).toMatchObject({
      state: "ready",
      generation: { generationId: rebuilt.id },
    });
  });

  test("status, failure and retry are explicit through the service", async () => {
    const db = database();
    const limited = service(db, { limits: { ...LIMITS, maxFiles: 5 } });
    const scope = { repositoryId: "fixture", sha: base };
    expect(limited.indexStatus(scope)).toMatchObject({ state: "not_indexed" });
    const started = await limited.startBuild(scope);
    expect(limited.indexStatus(scope).state).toBe("building");
    const failed = await limited.waitForBuild((started as { build: BuildRecord }).build.id);
    expect(failed).toMatchObject({ state: "failed", errorCode: "limit_exceeded" });
    expect(limited.indexStatus(scope)).toMatchObject({
      state: "failed",
      retryable: false,
      latest: { id: failed.id },
    });
    // maxFiles bounds work and is not part of the index key, so a retry can succeed.
    await limited.close();
    const svc = service(db);
    const retried = await svc.retry(failed.id);
    expect(retried.state).toBe("building");
    const build = await svc.waitForBuild((retried as { build: BuildRecord }).build.id);
    expect(build.state).toBe("ready");
    expect(svc.indexStatus(scope)).toMatchObject({ state: "ready", ready: { id: build.id } });
    // Retrying a scope that is ready returns the ready generation instead of rebuilding.
    expect(await svc.retry(failed.id)).toMatchObject({ state: "ready", build: { id: build.id } });
  });

  test("builds from before the versioned index key are never served after upgrade", async () => {
    mkdirSync(dataDir, { recursive: true });
    const legacy = new SqliteDatabase(join(dataDir, "looky.sqlite"), {
      create: true,
      strict: true,
    });
    migrate(legacy, migrations.slice(0, 2));
    const stamp = new Date().toISOString();
    legacy
      .query(
        `INSERT INTO index_builds (id, repository_id, sha, policy_version, state, phase, created_at, updated_at, finished_at)
         VALUES ('legacy-ready', 'fixture', ?, 1, 'ready', 'ready', ?, ?, ?)`,
      )
      .run(base, stamp, stamp, stamp);
    legacy.close();

    const db = database();
    expect(getBuild(db, "legacy-ready")).toMatchObject({ indexKey: "legacy" });
    const svc = service(db);
    // Opening the service retires and collects the incompatible generation.
    expect(getBuild(db, "legacy-ready")).toBeUndefined();
    expect((await svc.resolve({ repositoryId: "fixture", sha: base }, signal)).state).toBe(
      "building",
    );
  });

  test("missing storage rebuilds instead of reporting false readiness", async () => {
    let db = database();
    await ready(service(db), base);
    await closeAll();
    rmSync(dataDir, { recursive: true, force: true });

    db = database();
    const svc = service(db);
    expect(svc.indexStatus({ repositoryId: "fixture", sha: base }).state).toBe("not_indexed");
    expect((await svc.resolve({ repositoryId: "fixture", sha: base }, signal)).state).toBe(
      "building",
    );
  });

  test("a ready generation with lost rows is retired and rebuilt, never served", async () => {
    const db = database();
    const first = await ready(service(db), base);
    await closeAll();

    const damaged = database();
    const ids = damaged
      .query<{ content_id: number }, [string]>(
        "SELECT content_id FROM index_files WHERE build_id = ? AND path = 'src/users/ids.js'",
      )
      .get(first.id)!.content_id;
    damaged.query("DELETE FROM index_chunks WHERE content_id = ?").run(ids);

    const svc = service(damaged);
    const resolution = await svc.resolve({ repositoryId: "fixture", sha: base }, signal);
    expect(resolution.state).toBe("building");
    const rebuilt = await svc.waitForBuild((resolution as { buildId: string }).buildId);
    expect(rebuilt.state).toBe("ready");
    expect(rebuilt.refresh.mode).toBe("full");
    // The lost chunks were re-read and repaired.
    expect(listChunks(damaged, rebuilt.id, { path: "src/users/ids.js" })[0]!.text).toContain(
      "toLowerCase",
    );
    await expectExactProvenance(rebuilt, listChunks(damaged, rebuilt.id));

    // A missing manifest row is detected the same way.
    damaged
      .query("DELETE FROM index_files WHERE build_id = ? AND path = 'README.md'")
      .run(rebuilt.id);
    await svc.close();
    const again = service(damaged);
    expect((await again.resolve({ repositoryId: "fixture", sha: base }, signal)).state).toBe(
      "building",
    );
  });

  test("access revocation stops further index reads and lookups", async () => {
    const db = database();
    const svc = service(db);
    const build = await ready(svc, base);
    const read = { repositoryId: "fixture", generationId: build.id };
    expect(svc.searchChunks({ ...read, query: "getUserById", limit: 5 }).length).toBeGreaterThan(0);
    expect(() =>
      svc.searchChunks({ repositoryId: "other", generationId: build.id, query: "x", limit: 5 }),
    ).toThrow(IndexAccessDeniedError);

    authorized.delete("fixture");
    expect(() => svc.searchChunks({ ...read, query: "getUserById", limit: 5 })).toThrow(
      IndexAccessDeniedError,
    );
    expect(() => svc.listChunks(read)).toThrow(IndexAccessDeniedError);
    expect(() => svc.indexStatus({ repositoryId: "fixture", sha: base })).toThrow(
      IndexAccessDeniedError,
    );
    await expect(
      svc.resolve({ repositoryId: "fixture", sha: base }, signal),
    ).rejects.toBeInstanceOf(LookyUnavailableError);
    const retriever = new IndexRetriever({
      db,
      repositories: (id) => (authorized.has(id) ? repo : undefined),
    });
    await expect(
      retriever.search(
        {
          generation: { generationId: build.id, sha: base },
          repositoryId: "fixture",
          query: "getUserById",
          limit: 5,
        },
        signal,
      ),
    ).rejects.toBeInstanceOf(IndexAccessDeniedError);
    const { services } = makeServices({ catalog: svc });
    const response = await askProject(
      { question: "How are users loaded?" },
      makeAdapter(makeContext({ repositoryId: "fixture", sha: base })),
      services,
    );
    expect(response.status).toBe("unavailable");
  });

  test("the CLI reports scope status, retries failed builds and collects garbage", async () => {
    const cli = (env: Record<string, string>, ...args: string[]) =>
      Bun.spawnSync(["bun", "run", resolve(import.meta.dir, "../src/cli.ts"), ...args], {
        env: {
          ...process.env,
          LOOKY_DATA_DIR: dataDir,
          LOOKY_INDEX_MAX_FILE_BYTES: "65536",
          ...env,
        },
      });
    const status = () =>
      JSON.parse(cli({}, "status", "--id", "fixture", "--sha", base).stdout.toString());
    expect(status()).toMatchObject({ state: "not_indexed" });

    const failed = cli(
      { LOOKY_INDEX_MAX_FILES: "5" },
      "index",
      "--repo",
      repo,
      "--id",
      "fixture",
      "--sha",
      base,
    );
    expect(failed.exitCode).toBe(1);
    const failedId = JSON.parse(failed.stdout.toString()).build.id as string;
    expect(status()).toMatchObject({ state: "failed", retryable: false });

    const retried = cli({}, "retry", failedId, "--repo", repo);
    expect(retried.exitCode).toBe(0);
    expect(JSON.parse(retried.stdout.toString())).toMatchObject({
      complete: true,
      build: { state: "ready", refresh: { mode: "full" } },
    });
    expect(status()).toMatchObject({ state: "ready" });

    const gc = cli({}, "gc");
    expect(gc.exitCode).toBe(0);
    expect(JSON.parse(gc.stdout.toString())).toMatchObject({ buildsDeleted: 0 });
  });
});
