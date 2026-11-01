import type { Database } from "bun:sqlite";
import { INDEX_POLICY_VERSION, type ExclusionReason } from "./policy";

/**
 * Read and write access to persisted index builds. Every query that returns
 * indexed content requires a ready build, so queued, running, failed or
 * cancelled builds can never be served.
 */

export const BUILD_STATES = ["queued", "running", "ready", "failed", "cancelled"] as const;
export type BuildState = (typeof BUILD_STATES)[number];

export interface BuildRecord {
  readonly id: string;
  readonly repositoryId: string;
  readonly sha: string;
  readonly policyVersion: number;
  readonly state: BuildState;
  readonly phase: string;
  readonly filesTotal: number;
  readonly filesDone: number;
  readonly filesIndexed: number;
  readonly filesExcluded: number;
  /** Indexed files whose chunks were reused from an earlier build of the same blob. */
  readonly filesReused: number;
  readonly chunkCount: number;
  readonly indexedBytes: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

interface BuildRow {
  id: string;
  repository_id: string;
  sha: string;
  policy_version: number;
  state: BuildState;
  phase: string;
  files_total: number;
  files_done: number;
  files_indexed: number;
  files_excluded: number;
  files_reused: number;
  chunk_count: number;
  indexed_bytes: number;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
}

function toRecord(row: BuildRow): BuildRecord {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    sha: row.sha,
    policyVersion: row.policy_version,
    state: row.state,
    phase: row.phase,
    filesTotal: row.files_total,
    filesDone: row.files_done,
    filesIndexed: row.files_indexed,
    filesExcluded: row.files_excluded,
    filesReused: row.files_reused,
    chunkCount: row.chunk_count,
    indexedBytes: row.indexed_bytes,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryable: row.retryable === null ? null : row.retryable === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
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

/** The published build for exactly this repository, SHA and the current policy version. */
export function findReadyBuild(
  db: Database,
  repositoryId: string,
  sha: string,
): BuildRecord | undefined {
  const row = db
    .query<BuildRow, [string, string, number]>(
      `SELECT * FROM index_builds
       WHERE repository_id = ? AND sha = ? AND policy_version = ? AND state = 'ready'`,
    )
    .get(repositoryId, sha, INDEX_POLICY_VERSION);
  return row ? toRecord(row) : undefined;
}

export function findActiveBuild(
  db: Database,
  repositoryId: string,
  sha: string,
): BuildRecord | undefined {
  const row = db
    .query<BuildRow, [string, string, number]>(
      `SELECT * FROM index_builds
       WHERE repository_id = ? AND sha = ? AND policy_version = ?
         AND state IN ('queued', 'running')`,
    )
    .get(repositoryId, sha, INDEX_POLICY_VERSION);
  return row ? toRecord(row) : undefined;
}

/** Most recent build attempt for the scope under the current policy, in any state. */
export function findLatestBuild(
  db: Database,
  repositoryId: string,
  sha: string,
): BuildRecord | undefined {
  const row = db
    .query<BuildRow, [string, string, number]>(
      `SELECT * FROM index_builds
       WHERE repository_id = ? AND sha = ? AND policy_version = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(repositoryId, sha, INDEX_POLICY_VERSION);
  return row ? toRecord(row) : undefined;
}

/** Latest ready build of the repository at another SHA, for disclosure only. */
export function findOtherReadyBuild(
  db: Database,
  repositoryId: string,
  sha: string,
): BuildRecord | undefined {
  const row = db
    .query<BuildRow, [string, string, number]>(
      `SELECT * FROM index_builds
       WHERE repository_id = ? AND sha != ? AND policy_version = ? AND state = 'ready'
       ORDER BY finished_at DESC LIMIT 1`,
    )
    .get(repositoryId, sha, INDEX_POLICY_VERSION);
  return row ? toRecord(row) : undefined;
}

export function insertQueuedBuild(
  db: Database,
  build: { readonly id: string; readonly repositoryId: string; readonly sha: string },
): BuildRecord {
  const timestamp = now();
  db.query(
    `INSERT INTO index_builds (id, repository_id, sha, policy_version, state, phase, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'queued', 'queued', ?, ?)`,
  ).run(build.id, build.repositoryId, build.sha, INDEX_POLICY_VERSION, timestamp, timestamp);
  return getBuild(db, build.id)!;
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
