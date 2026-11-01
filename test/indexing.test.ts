import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { askProject } from "../src/ask/ask-project";
import { LookyUnavailableError } from "../src/contract/ports";
import { IndexService } from "../src/indexing/index-service";
import {
  DEFAULT_INDEX_LIMITS,
  INDEX_POLICY_VERSION,
  type IndexLimits,
} from "../src/indexing/policy";
import {
  coverageReport,
  finishUnsuccessfully,
  IndexNotReadyError,
  listBuilds,
  listChunks,
  searchChunks,
  type IndexedChunk,
} from "../src/indexing/store";
import { GitSourceReader } from "../src/source/git-source-reader";
import { openDatabase } from "../src/storage/database";
import { makeAdapter, makeContext, makeServices } from "./support/ask-fakes";
import {
  buildFixtureRepo,
  commitAll,
  FIXTURE_EXPECTED,
  git,
  initRepo,
  SECRETS,
  write,
} from "./support/git-fixture";

const LIMITS: IndexLimits = { ...DEFAULT_INDEX_LIMITS, maxFileBytes: 65_536 };
const signal = new AbortController().signal;
const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

describe("persistent codebase index", () => {
  let root: string;
  let repo: string;
  let dataDir: string;
  let sha: string;
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
      repositories: (id) => (id === "fixture" ? repo : undefined),
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

  async function buildReady(svc: IndexService, scopeSha = sha) {
    const started = await svc.startBuild({ repositoryId: "fixture", sha: scopeSha });
    if (started.state === "unsupported_revision") throw new Error(started.message);
    const build = await svc.waitForBuild(started.build.id);
    expect(build).toMatchObject({ state: "ready", errorCode: null });
    return build;
  }

  async function expectExactProvenance(buildId: string, directory: string, chunks: IndexedChunk[]) {
    const reader = new GitSourceReader(() => directory);
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const source = await reader.read(
        {
          repositoryId: chunk.repositoryId,
          sha: chunk.sha,
          path: chunk.path,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          maxBytes: 1_000_000,
        },
        signal,
      );
      expect(source.text).toBe(chunk.text);
      expect(source.endLine).toBe(chunk.endLine);
      expect(chunk.contentHash).toBe(sha256(chunk.text));
      expect(chunk.blobOid).toBe(git(directory, "rev-parse", `${chunk.sha}:${chunk.path}`));
      expect(chunk.buildId).toBe(buildId);
    }
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "looky-index-"));
    repo = join(root, "repo");
    dataDir = join(root, "data");
    Bun.spawnSync(["mkdir", "-p", repo]);
    sha = buildFixtureRepo(repo);
  });

  afterEach(async () => {
    try {
      await closeAll();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("enumerates every tracked entry with documented eligibility and inspectable exclusions", async () => {
    // Uncommitted edits and untracked files must not leak into the index.
    writeFileSync(join(repo, "src/users/ids.js"), "export const DIRTY_WORKTREE_EDIT = 1;\n");
    writeFileSync(join(repo, "untracked.ts"), "export const UNTRACKED = 1;\n");

    const db = database();
    const build = await buildReady(service(db));
    const tracked = git(repo, "ls-tree", "-r", "-z", "--name-only", sha)
      .split("\0")
      .filter(Boolean);
    expect(build.filesTotal).toBe(tracked.length);
    expect(build.filesTotal).toBe(Object.keys(FIXTURE_EXPECTED).length);

    const report = coverageReport(db, build.id)!;
    const chunks = listChunks(db, build.id);
    const observed: Record<string, string> = Object.fromEntries(
      report.excluded.map((entry) => [entry.path, entry.reason]),
    );
    for (const chunk of chunks) observed[chunk.path] = "indexed";
    expect(observed).toEqual(FIXTURE_EXPECTED);
    expect(report.complete).toBe(true);
    expect(build.filesIndexed + build.filesExcluded).toBe(build.filesTotal);
    expect(report.indexedByLanguage).toEqual({
      javascript: 1,
      markdown: 1,
      python: 1,
      typescript: 3,
      yaml: 1,
    });
    expect(report.excludedByReason).toMatchObject({ secret_path: 2, secret_content: 2, binary: 3 });

    const all = chunks.map((chunk) => chunk.text).join("");
    expect(all).not.toContain("DIRTY_WORKTREE_EDIT");
    expect(all).not.toContain("UNTRACKED");
    expect(all).toContain("toLowerCase()");
  });

  test("every chunk resolves to the exact path and line bytes at its SHA", async () => {
    const db = database();
    const build = await buildReady(service(db));
    const chunks = listChunks(db, build.id);
    await expectExactProvenance(build.id, repo, chunks);

    const crlf = chunks.find((chunk) => chunk.path === "src/legacy/crlf.ts")!;
    expect(crlf.text).toBe("﻿export const legacyFlag = true;\r\nexport const other = 1;\r\n");
  });

  test("records reliable TypeScript/JavaScript symbols and generic chunks for other languages", async () => {
    const db = database();
    const build = await buildReady(service(db));
    const symbols = (path: string) => listChunks(db, build.id, { path }).flatMap((c) => c.symbols);
    expect(symbols("src/users/user-service.ts")).toEqual([
      "getUserById",
      "UserRecord",
      "USER_CACHE",
    ]);
    expect(symbols("src/users/ids.js")).toEqual(["normalizeUserId"]);

    const python = listChunks(db, build.id, { path: "tools/retry_policy.py" });
    expect(python.length).toBeGreaterThan(2);
    expect(python.every((chunk) => chunk.symbols.length === 0)).toBe(true);
    // Generic windows overlap so no context is lost at chunk edges.
    expect(python[1]!.startLine).toBe(python[0]!.endLine - LIMITS.chunkOverlapLines + 1);
    expect(python.at(-1)!.endLine).toBe(240);
  });

  test("full-text search finds identifiers whole, split and across files", async () => {
    const db = database();
    const build = await buildReady(service(db));
    const paths = (query: string) =>
      [
        ...new Set(
          searchChunks(db, { buildId: build.id, query, limit: 20 }).map((hit) => hit.path),
        ),
      ].sort();

    expect(paths("getUserById")).toEqual([
      "README.md",
      "src/users/user-service.ts",
      "test/user-service.test.ts",
    ]);
    expect(paths("normalizeUserId")).toEqual(["src/users/ids.js", "src/users/user-service.ts"]);
    expect(paths("compute_retry_backoff_7")).toEqual(["tools/retry_policy.py"]);
    // camelCase and snake_case parts are searchable too.
    expect(paths("backoff")).toContain("tools/retry_policy.py");
    expect(paths("normalize")).toContain("src/users/ids.js");
    // FTS syntax in user text is treated literally.
    expect(paths('user" OR NEAR(')).toContain("src/users/user-service.ts");
    expect(paths("***")).toEqual([]);
  });

  test("secrets and out-of-scope bytes never reach persisted storage", async () => {
    const db = database();
    const build = await buildReady(service(db));
    const texts = listChunks(db, build.id)
      .map((chunk) => chunk.text)
      .join("\n");
    for (const secret of Object.values(SECRETS)) expect(texts).not.toContain(secret);
    await closeAll();

    const raw = readFileSync(join(dataDir, "looky.sqlite")).toString("latin1");
    for (const secret of Object.values(SECRETS)) expect(raw).not.toContain(secret);
    expect(raw).not.toContain("module.exports = () => {}");
    expect(raw).not.toContain("console.log('built')");
    expect(raw).not.toContain("x".repeat(1_000));
  });

  test("a ready index stays queryable after restart without rescanning", async () => {
    const first = await buildReady(service(database()));
    await closeAll();

    const db = database();
    const restarted = service(db);
    const resolution = await restarted.resolve({ repositoryId: "fixture", sha }, signal);
    expect(resolution).toMatchObject({
      state: "ready",
      generation: { generationId: first.id, sha },
    });
    expect(listBuilds(db, { repositoryId: "fixture" })).toHaveLength(1);
    expect(
      searchChunks(db, { buildId: first.id, query: "getUserById", limit: 5 }).length,
    ).toBeGreaterThan(0);
  });

  test("a CLI build in another process runs on a worker and is reused after it exits", async () => {
    const cli = (...args: string[]) =>
      Bun.spawnSync(["bun", "run", resolve(import.meta.dir, "../src/cli.ts"), ...args], {
        env: { ...process.env, LOOKY_DATA_DIR: dataDir, LOOKY_INDEX_MAX_FILE_BYTES: "65536" },
      });
    const indexed = cli("index", "--repo", repo, "--id", "fixture", "--sha", sha);
    expect(indexed.stderr.toString()).not.toContain("looky:");
    expect(indexed.exitCode).toBe(0);
    const summary = JSON.parse(indexed.stdout.toString());
    expect(summary).toMatchObject({ complete: true, build: { state: "ready", filesTotal: 23 } });

    const coverage = JSON.parse(cli("coverage", summary.build.id, "--excluded").stdout.toString());
    expect(coverage.excluded).toContainEqual({ path: ".env", reason: "secret_path" });
    const status = JSON.parse(cli("status", "--id", "fixture").stdout.toString());
    expect(status.map((build: { id: string }) => build.id)).toEqual([summary.build.id]);
    const hits = JSON.parse(cli("search", summary.build.id, "getUserById").stdout.toString());
    expect(hits.length).toBeGreaterThan(0);

    const db = database();
    expect(await service(db).resolve({ repositoryId: "fixture", sha }, signal)).toMatchObject({
      state: "ready",
      generation: { generationId: summary.build.id, sha },
    });
  });

  test("worker execution publishes the same exact index", async () => {
    const db = database();
    const build = await buildReady(service(db, { executor: "worker" }));
    expect(build.filesTotal).toBe(23);
    await expectExactProvenance(build.id, repo, listChunks(db, build.id));
  });

  test("builds that exceed repository limits fail instead of publishing partial coverage", async () => {
    const db = database();
    const limited = service(db, { limits: { ...LIMITS, maxFiles: 5 } });
    const started = await limited.startBuild({ repositoryId: "fixture", sha });
    const failed = await limited.waitForBuild((started as { build: { id: string } }).build.id);
    expect(failed).toMatchObject({
      state: "failed",
      errorCode: "limit_exceeded",
      retryable: false,
    });
    expect(() => listChunks(db, failed.id)).toThrow(IndexNotReadyError);
    expect(() => searchChunks(db, { buildId: failed.id, query: "user", limit: 5 })).toThrow(
      IndexNotReadyError,
    );
    expect(coverageReport(db, failed.id)!.complete).toBe(false);

    // A deterministic failure is reported, not retried automatically.
    const resolution = await limited.resolve({ repositoryId: "fixture", sha }, signal);
    expect(resolution).toMatchObject({ state: "failed", buildId: failed.id, retryable: false });
    await limited.close();

    const bytesLimited = service(db, { limits: { ...LIMITS, maxIndexedBytes: 200 } });
    const rebuilt = await bytesLimited.startBuild(
      { repositoryId: "fixture", sha },
      { rebuild: true },
    );
    expect(
      await bytesLimited.waitForBuild((rebuilt as { build: { id: string } }).build.id),
    ).toMatchObject({
      state: "failed",
      errorCode: "limit_exceeded",
    });
    await bytesLimited.close();

    // An explicit rebuild with adequate limits succeeds.
    const fixed = service(db);
    const again = await fixed.startBuild({ repositoryId: "fixture", sha }, { rebuild: true });
    expect(again.state).toBe("building");
    await fixed.waitForBuild((again as { build: { id: string } }).build.id);
    expect(await fixed.resolve({ repositoryId: "fixture", sha }, signal)).toMatchObject({
      state: "ready",
    });
  });

  test("cancelled builds are never served and the next request starts a new build", async () => {
    const db = database();
    const svc = service(db);
    const started = await svc.startBuild({ repositoryId: "fixture", sha });
    expect(started.state).toBe("building");
    const buildId = (started as { build: { id: string } }).build.id;
    expect(svc.cancel(buildId)).toBe(true);
    const cancelled = await svc.waitForBuild(buildId);
    expect(cancelled.state).toBe("cancelled");
    expect(() => listChunks(db, buildId)).toThrow(IndexNotReadyError);

    const resolution = await svc.resolve({ repositoryId: "fixture", sha }, signal);
    expect(resolution.state).toBe("building");
    const next = (resolution as { buildId: string }).buildId;
    expect(next).not.toBe(buildId);
    expect((await svc.waitForBuild(next)).state).toBe("ready");
  });

  test("a build stopped from outside the service stays non-queryable", async () => {
    const db = database();
    const svc = service(db);
    write(repo, "src/extra.ts", "export const extra = 1;\n");
    const second = commitAll(repo, "second");
    const first = await svc.startBuild({ repositoryId: "fixture", sha });
    const queued = await svc.startBuild({ repositoryId: "fixture", sha: second });
    const queuedId = (queued as { build: { id: string; state: string } }).build.id;
    expect((queued as { build: { state: string } }).build.state).toBe("queued");
    // What `looky cancel <build-id>` does from another process.
    expect(
      finishUnsuccessfully(db, queuedId, {
        state: "cancelled",
        code: "cancelled",
        message: "cli",
        retryable: true,
      }),
    ).toBe(true);
    await svc.waitForBuild((first as { build: { id: string } }).build.id);
    expect((await svc.waitForBuild(queuedId)).state).toBe("cancelled");
    expect(() => listChunks(db, queuedId)).toThrow(IndexNotReadyError);
  });

  test("builds interrupted by a crash are failed on startup and rebuilt", async () => {
    const db = database();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO index_builds (id, repository_id, sha, policy_version, state, phase, created_at, updated_at)
       VALUES ('crashed', 'fixture', ?, ?, 'running', 'indexing', ?, ?)`,
    ).run(sha, INDEX_POLICY_VERSION, now, now);
    const svc = service(db);
    expect(svc.status("crashed")).toMatchObject({
      state: "failed",
      errorCode: "interrupted",
      retryable: true,
    });
    const resolution = await svc.resolve({ repositoryId: "fixture", sha }, signal);
    expect(resolution).toMatchObject({ state: "building" });
    expect((resolution as { buildId: string }).buildId).not.toBe("crashed");
  });

  test("indexes built under another policy version are rebuilt, never misread", async () => {
    const db = database();
    const now = new Date().toISOString();
    db.query(
      `INSERT INTO index_builds (id, repository_id, sha, policy_version, state, phase, created_at, updated_at)
       VALUES ('old-policy', 'fixture', ?, ?, 'ready', 'ready', ?, ?)`,
    ).run(sha, INDEX_POLICY_VERSION - 1, now, now);
    const resolution = await service(db).resolve({ repositoryId: "fixture", sha }, signal);
    expect(resolution.state).toBe("building");
    expect((resolution as { buildId: string }).buildId).not.toBe("old-policy");
  });

  test("concurrent requests share one build per scope", async () => {
    const db = database();
    const svc = service(db);
    const [a, b] = await Promise.all([
      svc.resolve({ repositoryId: "fixture", sha }, signal),
      svc.resolve({ repositoryId: "fixture", sha }, signal),
    ]);
    expect(a.state).toBe("building");
    expect((b as { buildId: string }).buildId).toBe((a as { buildId: string }).buildId);
    expect(listBuilds(db)).toHaveLength(1);
  });

  test("only one service process owns builds for a database", async () => {
    const db = database();
    const owner = service(db);
    expect(() => service(db)).toThrow(LookyUnavailableError);
    await owner.close();
    expect(() => service(db)).not.toThrow();
  });

  test("refuses unknown repositories and revisions it cannot serve", async () => {
    const svc = service(database());
    await expect(svc.resolve({ repositoryId: "other", sha }, signal)).rejects.toBeInstanceOf(
      LookyUnavailableError,
    );
    expect(await svc.resolve({ repositoryId: "fixture", sha: "main" }, signal)).toMatchObject({
      state: "unsupported_revision",
    });
    expect(
      await svc.resolve({ repositoryId: "fixture", sha: "e".repeat(40) }, signal),
    ).toMatchObject({
      state: "unsupported_revision",
    });
    // A tree or blob id is not a commit.
    const tree = git(repo, "rev-parse", `${sha}^{tree}`);
    expect(await svc.resolve({ repositoryId: "fixture", sha: tree }, signal)).toMatchObject({
      state: "unsupported_revision",
    });
  });

  test("a new commit reuses unchanged blobs and never mixes revisions", async () => {
    const db = database();
    const svc = service(db);
    const first = await buildReady(svc);
    write(
      repo,
      "src/users/ids.js",
      "export function normalizeUserId(raw) {\n  return String(raw);\n}\n",
    );
    const second = commitAll(repo, "change ids");

    const resolution = await svc.resolve({ repositoryId: "fixture", sha: second }, signal);
    expect(resolution).toMatchObject({
      state: "building",
      staleGeneration: { generationId: first.id, sha },
    });
    const build = await svc.waitForBuild((resolution as { buildId: string }).buildId);
    expect(build.state).toBe("ready");
    expect(build.filesReused).toBe(build.filesIndexed - 1);

    const ids = (buildId: string) => listChunks(db, buildId, { path: "src/users/ids.js" })[0]!.text;
    expect(ids(first.id)).toContain("toLowerCase()");
    expect(ids(build.id)).not.toContain("toLowerCase()");
    await expectExactProvenance(build.id, repo, listChunks(db, build.id));
  });

  test("serves ask_project as the index catalog: indexing first, then the pinned generation", async () => {
    const db = database();
    const catalog = service(db);
    const context = makeContext({ repositoryId: "fixture", sha });
    const { services } = makeServices({ catalog });

    const first = await askProject(
      { question: "How are users loaded?" },
      makeAdapter(context),
      services,
    );
    expect(first).toMatchObject({ status: "indexing", mode: { executed: null } });
    await catalog.waitForBuild((first as { buildId: string }).buildId);

    const second = await askProject(
      { question: "How are users loaded?" },
      makeAdapter(context),
      services,
    );
    expect(second).toMatchObject({
      status: "answered",
      index: { generationId: (first as { buildId: string }).buildId, sha },
    });
  });
});

describe("indexing a real repository", () => {
  test("Looky's own committed tree is fully enumerated with exact provenance", async () => {
    const repo = resolve(import.meta.dir, "..");
    const sha = git(repo, "rev-parse", "HEAD");
    const dataDir = mkdtempSync(join(tmpdir(), "looky-self-"));
    const db = openDatabase({ dataDir });
    const svc = new IndexService({ db, repositories: () => repo });
    try {
      const started = await svc.startBuild({ repositoryId: "looky", sha });
      const build = await svc.waitForBuild((started as { build: { id: string } }).build.id);
      expect(build.state).toBe("ready");
      const tracked = git(repo, "ls-tree", "-r", "-z", "--name-only", sha)
        .split("\0")
        .filter(Boolean);
      expect(build.filesTotal).toBe(tracked.length);
      const report = coverageReport(db, build.id)!;
      const chunks = listChunks(db, build.id);
      const indexed = new Set(chunks.map((chunk) => chunk.path));
      const excluded = new Set(report.excluded.map((entry) => entry.path));
      expect(indexed.size + excluded.size).toBe(tracked.length);
      for (const path of tracked) expect(indexed.has(path) || excluded.has(path)).toBe(true);
      expect(indexed.has("src/indexing/ingest.ts")).toBe(true);
      expect(report.excluded).toContainEqual({ path: "bun.lock", reason: "generated" });

      const reader = new GitSourceReader(() => repo);
      for (const chunk of chunks) {
        const source = await reader.read(
          { ...chunk, maxBytes: 1_000_000 },
          new AbortController().signal,
        );
        expect(source.text).toBe(chunk.text);
      }
    } finally {
      await svc.close();
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe("fixture helpers", () => {
  test("initRepo creates an empty repository", () => {
    const directory = mkdtempSync(join(tmpdir(), "looky-empty-"));
    try {
      initRepo(directory);
      expect(git(directory, "rev-parse", "--is-inside-work-tree")).toBe("true");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
