import type { Database } from "bun:sqlite";
import type { ExclusionReason } from "./policy";

/**
 * Read and write access to persisted index builds. Every query that returns
 * indexed content requires a ready build, so queued, running, failed or
 * cancelled builds can never be served.
 *
 * A build is one immutable generation of exactly one repository, SHA and
 * index key. It is staged in `index_files` rows that only it owns and becomes
 * `ready` in one transaction. A ready build is never changed afterwards,
 * except that it can be retired (no longer served to new requests) and,
 * once no reader holds a lease on it, deleted by garbage collection.
 */

export const BUILD_STATES = ["queued", "running", "ready", "failed", "cancelled"] as const;
export type BuildState = (typeof BUILD_STATES)[number];

/** How a build was produced from Git. */
export interface RefreshReport {
  /** `incremental` carried unchanged entries over from `baseBuildId`. Null until decided. */
  readonly mode: "full" | "incremental" | null;
  /** Why a full build ran, such as `no_base`, `not_ancestor` or `rebuild_requested`. */
  readonly reason: string | null;
  readonly baseBuildId: string | null;
  readonly baseSha: string | null;
  /** Paths added, modified, deleted and renamed between the base and this SHA. */
  readonly added: number;
  readonly modified: number;
  readonly deleted: number;
  /** Delete/add pairs of the same blob, counted here instead of in `added` and `deleted`. */
  readonly renamed: number;
  /** Unchanged entries copied from the base build without reading or classifying. */
  readonly carried: number;
}

export interface BuildRecord {
  readonly id: string;
  readonly repositoryId: string;
  readonly sha: string;
  readonly policyVersion: number;
  /** Index/chunk schema key the build was made under; only the current key is served. */
  readonly indexKey: string;
  /** `full` when an explicit rebuild disabled incremental refresh. */
  readonly requestedMode: "auto" | "full";
  readonly state: BuildState;
  readonly phase: string;
  readonly filesTotal: number;
  readonly filesDone: number;
  readonly filesIndexed: number;
  readonly filesExcluded: number;
  /** Indexed files whose chunks were reused from earlier stored content of the same blob. */
  readonly filesReused: number;
  readonly chunkCount: number;
  readonly indexedBytes: number;
  readonly refresh: RefreshReport;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  /** Set when a ready build stopped being served to new requests. */
  readonly retiredAt: string | null;
  readonly lastUsedAt: string | null;
}

interface BuildRow {
  id: string;
  repository_id: string;
  sha: string;
  policy_version: number;
  index_key: string;
  requested_mode: "auto" | "full";
  state: BuildState;
  phase: string;
  files_total: number;
  files_done: number;
  files_indexed: number;
  files_excluded: number;
  files_reused: number;
  chunk_count: number;
  indexed_bytes: number;
  refresh_mode: "full" | "incremental" | null;
  refresh_reason: string | null;
  base_build_id: string | null;
  base_sha: string | null;
  files_added: number;
  files_modified: number;
  files_deleted: number;
  files_renamed: number;
  files_carried: number;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  retired_at: string | null;
  last_used_at: string | null;
}

function toRecord(row: BuildRow): BuildRecord {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    sha: row.sha,
    policyVersion: row.policy_version,
    indexKey: row.index_key,
    requestedMode: row.requested_mode,
    state: row.state,
    phase: row.phase,
    filesTotal: row.files_total,
    filesDone: row.files_done,
    filesIndexed: row.files_indexed,
    filesExcluded: row.files_excluded,
    filesReused: row.files_reused,
    chunkCount: row.chunk_count,
    indexedBytes: row.indexed_bytes,
    refresh: {
      mode: row.refresh_mode,
      reason: row.refresh_reason,
      baseBuildId: row.base_build_id,
      baseSha: row.base_sha,
      added: row.files_added,
      modified: row.files_modified,
      deleted: row.files_deleted,
      renamed: row.files_renamed,
      carried: row.files_carried,
    },
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryable: row.retryable === null ? null : row.retryable === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    retiredAt: row.retired_at,
    lastUsedAt: row.last_used_at,
  };
}

export function now(): string {
  return new Date().toISOString();
}

export function getBuild(db: Database, buildId: string): BuildRecord | undefined {
  const row = db.query<BuildRow, [string]>("SELECT * FROM index_builds WHERE id = ?").get(buildId);
  return row ? toRecord(row) : undefined;
}

export function listBuilds(
  db: Database,
  filter: { readonly repositoryId?: string; readonly sha?: string; readonly limit?: number } = {},
): BuildRecord[] {
  return db
    .query<BuildRow, [string | null, string | null, number]>(
      `SELECT * FROM index_builds
       WHERE (?1 IS NULL OR repository_id = ?1) AND (?2 IS NULL OR sha = ?2)
       ORDER BY created_at DESC, rowid DESC LIMIT ?3`,
    )
    .all(filter.repositoryId ?? null, filter.sha ?? null, filter.limit ?? 50)
    .map(toRecord);
}

/** An exact index scope: repository, commit and index key. */
export interface IndexScope {
  readonly repositoryId: string;
  readonly sha: string;
  readonly indexKey: string;
}

/** The served generation for exactly this repository, SHA and index key. */
export function findReadyBuild(db: Database, scope: IndexScope): BuildRecord | undefined {
  const row = db
    .query<BuildRow, [string, string, string]>(
      `SELECT * FROM index_builds
       WHERE repository_id = ? AND sha = ? AND index_key = ?
         AND state = 'ready' AND retired_at IS NULL`,
    )
    .get(scope.repositoryId, scope.sha, scope.indexKey);
  return row ? toRecord(row) : undefined;
}

export function findActiveBuild(db: Database, scope: IndexScope): BuildRecord | undefined {
  const row = db
    .query<BuildRow, [string, string, string]>(
      `SELECT * FROM index_builds
       WHERE repository_id = ? AND sha = ? AND index_key = ? AND state IN ('queued', 'running')`,
    )
    .get(scope.repositoryId, scope.sha, scope.indexKey);
  return row ? toRecord(row) : undefined;
}

/** Most recent build attempt for the scope, in any state. */
export function findLatestBuild(db: Database, scope: IndexScope): BuildRecord | undefined {
  const row = db
    .query<BuildRow, [string, string, string]>(
      `SELECT * FROM index_builds
       WHERE repository_id = ? AND sha = ? AND index_key = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(scope.repositoryId, scope.sha, scope.indexKey);
  return row ? toRecord(row) : undefined;
}

/** Latest served build of the repository at another SHA, for disclosure only. */
export function findOtherReadyBuild(db: Database, scope: IndexScope): BuildRecord | undefined {
  const row = db
    .query<BuildRow, [string, string, string]>(
      `SELECT * FROM index_builds
       WHERE repository_id = ? AND sha != ? AND index_key = ?
         AND state = 'ready' AND retired_at IS NULL
       ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    )
    .get(scope.repositoryId, scope.sha, scope.indexKey);
  return row ? toRecord(row) : undefined;
}

/** Served builds of the repository under the key, most recently published first. */
export function listReadyBuilds(
  db: Database,
  repositoryId: string,
  indexKey: string,
  limit: number,
): BuildRecord[] {
  return db
    .query<BuildRow, [string, string, number]>(
      `SELECT * FROM index_builds
       WHERE repository_id = ? AND index_key = ? AND state = 'ready' AND retired_at IS NULL
       ORDER BY finished_at DESC, rowid DESC LIMIT ?`,
    )
    .all(repositoryId, indexKey, limit)
    .map(toRecord);
}

export function insertQueuedBuild(
  db: Database,
  build: IndexScope & { readonly id: string; readonly requestedMode: "auto" | "full" },
): BuildRecord {
  const timestamp = now();
  db.query(
    `INSERT INTO index_builds (id, repository_id, sha, policy_version, index_key, requested_mode,
                               state, phase, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?)`,
  ).run(
    build.id,
    build.repositoryId,
    build.sha,
    policyVersionOf(build.indexKey),
    build.indexKey,
    build.requestedMode,
    timestamp,
    timestamp,
  );
  return getBuild(db, build.id)!;
}

function policyVersionOf(indexKey: string): number {
  const match = /^p(\d+)-/.exec(indexKey);
  if (!match) throw new Error(`Malformed index key ${indexKey}`);
  return Number(match[1]);
}

/**
 * Move an unfinished build to failed or cancelled. Ready builds are never
 * changed. Returns false when the build had already finished.
 */
export function finishUnsuccessfully(
  db: Database,
  buildId: string,
  outcome: {
    readonly state: "failed" | "cancelled";
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  },
): boolean {
  const timestamp = now();
  const result = db
    .query(
      `UPDATE index_builds
       SET state = ?, phase = ?, error_code = ?, error_message = ?, retryable = ?,
           updated_at = ?, finished_at = ?
       WHERE id = ? AND state IN ('queued', 'running')`,
    )
    .run(
      outcome.state,
      outcome.state,
      outcome.code,
      outcome.message,
      outcome.retryable ? 1 : 0,
      timestamp,
      timestamp,
      buildId,
    );
  return result.changes === 1;
}

/**
 * Builds left queued or running by a previous process cannot complete. Mark
 * them failed and retryable so they are never served and a new build starts.
 * Their staged rows are removed by the next garbage collection.
 */
export function failInterruptedBuilds(db: Database): number {
  const timestamp = now();
  return db
    .query(
      `UPDATE index_builds
       SET state = 'failed', phase = 'failed', error_code = 'interrupted',
           error_message = 'The service stopped before this build finished', retryable = 1,
           updated_at = ?, finished_at = ?
       WHERE state IN ('queued', 'running')`,
    )
    .run(timestamp, timestamp).changes;
}

/** Stop serving a ready build to new requests. Lease holders can still read it. */
export function retireBuild(db: Database, buildId: string): boolean {
  return (
    db
      .query(
        `UPDATE index_builds SET retired_at = ?
         WHERE id = ? AND state = 'ready' AND retired_at IS NULL`,
      )
      .run(now(), buildId).changes === 1
  );
}

/**
 * Check that a ready build's stored snapshot is complete: one manifest row per
 * tracked entry and every chunk of every indexed file present. A snapshot that
 * lost rows (for example after manual edits or partial restores) must be
 * rebuilt, never reported as ready.
 */
export function snapshotIntact(db: Database, build: BuildRecord): boolean {
  const files = db
    .query<{ files: number; indexed: number }, [string]>(
      `SELECT COUNT(*) AS files, COALESCE(SUM(status = 'indexed'), 0) AS indexed
       FROM index_files WHERE build_id = ?`,
    )
    .get(build.id)!;
  if (files.files !== build.filesTotal || files.indexed !== build.filesIndexed) return false;
  const chunks = db
    .query<{ chunks: number }, [string]>(
      `SELECT COUNT(*) AS chunks
       FROM index_files f JOIN index_chunks c ON c.content_id = f.content_id
       WHERE f.build_id = ?`,
    )
    .get(build.id)!;
  return chunks.chunks === build.chunkCount;
}

// ---------------------------------------------------------------------------
// Reader leases

/**
 * Pin a ready build for one reader. Garbage collection never deletes a build
 * with an unexpired lease. Leases expire on their own so a crashed reader
 * cannot pin storage forever. Returns undefined if the build is not ready.
 */
export function acquireLease(
  db: Database,
  buildId: string,
  ttlMs: number,
): { readonly leaseId: string; readonly expiresAt: number } | undefined {
  return db
    .transaction(() => {
      const build = getBuild(db, buildId);
      if (!build || build.state !== "ready") return undefined;
      const leaseId = `lease_${crypto.randomUUID()}`;
      const expiresAt = Date.now() + ttlMs;
      const timestamp = now();
      db.query(
        "INSERT INTO index_leases (id, build_id, acquired_at, expires_at) VALUES (?, ?, ?, ?)",
      ).run(leaseId, buildId, timestamp, expiresAt);
      db.query("UPDATE index_builds SET last_used_at = ? WHERE id = ?").run(timestamp, buildId);
      return { leaseId, expiresAt };
    })
    .immediate();
}

export function releaseLease(db: Database, leaseId: string): void {
  db.query("DELETE FROM index_leases WHERE id = ?").run(leaseId);
}

/** Unexpired leases on a build. */
export function activeLeases(db: Database, buildId: string): number {
  return db
    .query<{ leases: number }, [string, number]>(
      "SELECT COUNT(*) AS leases FROM index_leases WHERE build_id = ? AND expires_at > ?",
    )
    .get(buildId, Date.now())!.leases;
}

// ---------------------------------------------------------------------------
// Scope status

export type ScopeState = "not_indexed" | "building" | "ready" | "failed";

/** Lifecycle status of one repository, SHA and index key, without starting work. */
export interface ScopeStatus extends IndexScope {
  readonly state: ScopeState;
  /** The served generation for this exact SHA. */
  readonly ready?: BuildRecord;
  /** The queued or running build for this exact SHA, such as a rebuild of a ready SHA. */
  readonly active?: BuildRecord;
  /** The latest attempt, which explains a failure. */
  readonly latest?: BuildRecord;
  /** For `failed`: whether the next request or `retry` starts a new attempt automatically. */
  readonly retryable?: boolean;
}

export function scopeStatus(db: Database, scope: IndexScope): ScopeStatus {
  const ready = findReadyBuild(db, scope);
  const active = findActiveBuild(db, scope);
  const latest = findLatestBuild(db, scope);
  const base = {
    ...scope,
    ...(ready ? { ready } : {}),
    ...(active ? { active } : {}),
    ...(latest ? { latest } : {}),
  };
  if (ready) return { ...base, state: "ready" };
  if (active) return { ...base, state: "building" };
  if (latest && (latest.state === "failed" || latest.state === "cancelled")) {
    return { ...base, state: "failed", retryable: latest.retryable ?? true };
  }
  return { ...base, state: "not_indexed" };
}

// ---------------------------------------------------------------------------
// Retention and garbage collection

export interface RetentionPolicy {
  /** The index key builds are served under; ready builds of other keys are retired. */
  readonly indexKey: string;
  /** Served generations kept per repository, least recently used retired first. */
  readonly retainReadyPerRepository: number;
  /** Failed and cancelled build records kept per repository for diagnostics. */
  readonly retainFailedPerRepository: number;
}

export interface GarbageReport {
  /** Set when collection did not run because a build was queued or running. */
  readonly skipped?: "builds_active";
  readonly leasesExpired: number;
  readonly retired: number;
  /** Retired generations kept because a reader still holds a lease. */
  readonly retainedForReaders: number;
  readonly buildsDeleted: number;
  readonly stagedFilesDeleted: number;
  readonly contentsDeleted: number;
}

/**
 * Bound storage. In one transaction: expire leases, retire ready builds of
 * other index keys or beyond the per-repository retention, delete retired
 * builds no reader holds, drop staged rows of failed and cancelled builds,
 * bound their records, and delete chunk content no build references.
 *
 * It never runs while a build is queued or running, because a build may be
 * about to reference stored content or carry rows from its base build. At
 * least one served generation of every repository is always kept.
 */
export function collectGarbage(db: Database, policy: RetentionPolicy): GarbageReport {
  if (policy.retainReadyPerRepository < 1 || policy.retainFailedPerRepository < 1) {
    throw new Error("Retention limits must be at least 1");
  }
  return db
    .transaction((): GarbageReport => {
      const active = db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM index_builds WHERE state IN ('queued', 'running')",
        )
        .get()!.n;
      if (active > 0) {
        return {
          skipped: "builds_active",
          leasesExpired: 0,
          retired: 0,
          retainedForReaders: 0,
          buildsDeleted: 0,
          stagedFilesDeleted: 0,
          contentsDeleted: 0,
        };
      }
      const timestamp = now();
      const leasesExpired = db
        .query("DELETE FROM index_leases WHERE expires_at <= ?")
        .run(Date.now()).changes;
      const incompatible = db
        .query(
          `UPDATE index_builds SET retired_at = ?
           WHERE state = 'ready' AND retired_at IS NULL AND index_key != ?`,
        )
        .run(timestamp, policy.indexKey).changes;
      const evicted = db
        .query(
          `UPDATE index_builds SET retired_at = ?1
           WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY repository_id
                 ORDER BY COALESCE(last_used_at, finished_at) DESC, finished_at DESC, rowid DESC
               ) AS rank
               FROM index_builds
               WHERE state = 'ready' AND retired_at IS NULL AND index_key = ?2
             ) WHERE rank > ?3
           )`,
        )
        .run(timestamp, policy.indexKey, policy.retainReadyPerRepository).changes;
      const buildsDeleted = db
        .query(
          `DELETE FROM index_builds
           WHERE state = 'ready' AND retired_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM index_leases l WHERE l.build_id = index_builds.id)`,
        )
        .run().changes;
      const retainedForReaders = db
        .query<{ n: number }, []>(
          "SELECT COUNT(*) AS n FROM index_builds WHERE state = 'ready' AND retired_at IS NOT NULL",
        )
        .get()!.n;
      const stagedFilesDeleted = db
        .query(
          `DELETE FROM index_files WHERE build_id IN (
             SELECT id FROM index_builds WHERE state IN ('failed', 'cancelled'))`,
        )
        .run().changes;
      const failedDeleted = db
        .query(
          `DELETE FROM index_builds WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY repository_id ORDER BY created_at DESC, rowid DESC
               ) AS rank
               FROM index_builds WHERE state IN ('failed', 'cancelled')
             ) WHERE rank > ?
           )`,
        )
        .run(policy.retainFailedPerRepository).changes;
      const contentsDeleted = db
        .query(
          `DELETE FROM index_contents
           WHERE NOT EXISTS (SELECT 1 FROM index_files f WHERE f.content_id = index_contents.id)`,
        )
        .run().changes;
      return {
        leasesExpired,
        retired: incompatible + evicted,
        retainedForReaders,
        buildsDeleted: buildsDeleted + failedDeleted,
        stagedFilesDeleted,
        contentsDeleted,
      };
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// Coverage

export interface CoverageReport {
  readonly build: BuildRecord;
  /** True only for a ready build: every tracked entry is indexed or excluded with a reason. */
  readonly complete: boolean;
  readonly indexedByLanguage: Readonly<Record<string, number>>;
  readonly excludedByReason: Readonly<Partial<Record<ExclusionReason, number>>>;
  readonly excluded: readonly { readonly path: string; readonly reason: ExclusionReason }[];
}

export function coverageReport(
  db: Database,
  buildId: string,
  options: { readonly excludedLimit?: number } = {},
): CoverageReport | undefined {
  const build = getBuild(db, buildId);
  if (!build) return undefined;
  const languages = db
    .query<{ language: string; files: number }, [string]>(
      `SELECT language, COUNT(*) AS files FROM index_files
       WHERE build_id = ? AND status = 'indexed' GROUP BY language ORDER BY language`,
    )
    .all(buildId);
  const reasons = db
    .query<{ reason: ExclusionReason; files: number }, [string]>(
      `SELECT reason, COUNT(*) AS files FROM index_files
       WHERE build_id = ? AND status = 'excluded' GROUP BY reason ORDER BY reason`,
    )
    .all(buildId);
  const excluded = db
    .query<{ path: string; reason: ExclusionReason }, [string, number]>(
      `SELECT path, reason FROM index_files
       WHERE build_id = ? AND status = 'excluded' ORDER BY path LIMIT ?`,
    )
    .all(buildId, options.excludedLimit ?? 10_000);
  return {
    build,
    complete: build.state === "ready" && build.filesDone === build.filesTotal,
    indexedByLanguage: Object.fromEntries(languages.map((row) => [row.language, row.files])),
    excludedByReason: Object.fromEntries(reasons.map((row) => [row.reason, row.files])),
    excluded,
  };
}

// ---------------------------------------------------------------------------
// Indexed content of ready builds

export class IndexNotReadyError extends Error {
  override readonly name = "IndexNotReadyError";
}

function requireReady(db: Database, buildId: string): BuildRecord {
  const build = getBuild(db, buildId);
  if (!build || build.state !== "ready") {
    throw new IndexNotReadyError(`Index build ${buildId} is not ready`);
  }
  return build;
}

export interface IndexedChunk {
  readonly chunkId: number;
  readonly repositoryId: string;
  readonly sha: string;
  readonly buildId: string;
  readonly path: string;
  readonly language: string;
  readonly blobOid: string;
  readonly ordinal: number;
  readonly startLine: number;
  readonly endLine: number;
  /** SHA-256 of the chunk text. */
  readonly contentHash: string;
  readonly text: string;
  readonly symbols: readonly string[];
}

interface ChunkRow {
  chunk_id: number;
  path: string;
  language: string;
  blob_oid: string;
  ordinal: number;
  start_line: number;
  end_line: number;
  content_hash: string;
  text: string;
  symbols: string;
}

function toChunk(build: BuildRecord, row: ChunkRow): IndexedChunk {
  return {
    chunkId: row.chunk_id,
    repositoryId: build.repositoryId,
    sha: build.sha,
    buildId: build.id,
    path: row.path,
    language: row.language,
    blobOid: row.blob_oid,
    ordinal: row.ordinal,
    startLine: row.start_line,
    endLine: row.end_line,
    contentHash: row.content_hash,
    text: row.text,
    symbols: row.symbols === "" ? [] : row.symbols.split(" "),
  };
}

const CHUNK_COLUMNS = `c.id AS chunk_id, f.path, f.language, f.blob_oid, c.ordinal,
  c.start_line, c.end_line, c.content_hash, c.text, c.symbols`;

/** Chunks of a ready build in path and line order, optionally for one path. */
export function listChunks(
  db: Database,
  buildId: string,
  options: { readonly path?: string } = {},
): IndexedChunk[] {
  const build = requireReady(db, buildId);
  return db
    .query<ChunkRow, [string, string | null]>(
      `SELECT ${CHUNK_COLUMNS}
       FROM index_files f JOIN index_chunks c ON c.content_id = f.content_id
       WHERE f.build_id = ?1 AND f.status = 'indexed' AND (?2 IS NULL OR f.path = ?2)
       ORDER BY f.path, c.ordinal`,
    )
    .all(buildId, options.path ?? null)
    .map((row) => toChunk(build, row));
}

/** Quote every word so user text is matched literally, never parsed as FTS5 syntax. */
export function literalFtsQuery(query: string): string | undefined {
  const words = query.match(/[\p{L}\p{N}_]+/gu);
  return words ? words.map((word) => `"${word}"`).join(" OR ") : undefined;
}

/**
 * Full-text search within one ready build. A minimal lexical query used to
 * prove the persisted index is queryable; mode-specific retrieval builds on it.
 */
export function searchChunks(
  db: Database,
  request: { readonly buildId: string; readonly query: string; readonly limit: number },
): (IndexedChunk & { readonly score: number })[] {
  const build = requireReady(db, request.buildId);
  const match = literalFtsQuery(request.query);
  if (!match) return [];
  return db
    .query<ChunkRow & { score: number }, [string, string, number]>(
      `SELECT ${CHUNK_COLUMNS}, -bm25(index_chunks_fts, 4.0, 1.0, 2.0) AS score
       FROM index_chunks_fts
       JOIN index_chunks c ON c.id = index_chunks_fts.rowid
       JOIN index_files f ON f.content_id = c.content_id AND f.build_id = ?1
       WHERE index_chunks_fts MATCH ?2
       ORDER BY score DESC, f.path, c.ordinal
       LIMIT ?3`,
    )
    .all(request.buildId, match, request.limit)
    .map((row) => ({ ...toChunk(build, row), score: row.score }));
}
