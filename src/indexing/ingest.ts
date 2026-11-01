import type { Database } from "bun:sqlite";
import { chunkerId, chunkFile, identifierTerms, splitLines, type Chunk } from "./chunker";
import {
  BlobReader,
  diffTrees,
  GitSnapshotError,
  isAncestor,
  listTree,
  type TreeChange,
  type TreeEntry,
} from "./git-snapshot";
import {
  checkContent,
  classifyPath,
  type ExclusionReason,
  type IndexLimits,
  validateLimits,
} from "./policy";
import {
  type BuildRecord,
  finishUnsuccessfully,
  getBuild,
  listReadyBuilds,
  now,
  snapshotIntact,
} from "./store";

/**
 * Runs one index build to completion: enumerate the commit's tree, classify
 * every entry, read and chunk eligible blobs, and publish. The build becomes
 * `ready` in a single transaction only after every tracked entry has been
 * recorded as indexed or excluded. Any error or cancellation leaves it
 * `failed` or `cancelled`, which are never served.
 *
 * Refresh: when a ready build of the same repository and index key exists at
 * an ancestor commit, only paths `git diff-tree` reports as changed are
 * classified and read; every other entry's manifest row is copied from that
 * base after its blob id, mode and size are verified against the new tree.
 * A non-ancestor base (another branch, a force-moved ref), a failed diff, a
 * mismatch or an explicit rebuild falls back to a full build, which is still
 * bounded by `maxFiles` and `maxIndexedBytes` and still reuses stored chunks
 * of identical blobs.
 *
 * Messages stored on failure are written by Looky and never contain file content.
 */

export interface IngestOptions {
  readonly db: Database;
  readonly buildId: string;
  /** Local Git directory the repository id is authorized to read. */
  readonly directory: string;
  readonly limits: IndexLimits;
  readonly signal: AbortSignal;
}

export type IngestResult =
  | { readonly state: "ready" }
  | {
      readonly state: "failed" | "cancelled";
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
    };

class IngestLimitError extends Error {
  override readonly name = "IngestLimitError";
}

/** The build was cancelled or failed by another party while it ran. */
class BuildStoppedError extends Error {
  override readonly name = "BuildStoppedError";
}

interface FileResult {
  readonly entry: TreeEntry;
  readonly language?: string;
  readonly reason?: ExclusionReason;
  /** Existing content row to reuse. */
  readonly contentId?: number;
  /** Newly read content to store. */
  readonly content?: {
    readonly chunker: string;
    readonly hash: string;
    readonly bytes: number;
    readonly lines: number;
    readonly chunks: readonly Chunk[];
  };
}

const FLUSH_FILES = 256;
const FLUSH_BYTES = 8 * 1024 * 1024;

export async function runIndexBuild(options: IngestOptions): Promise<IngestResult> {
  const { db, buildId, signal } = options;
  try {
    validateLimits(options.limits);
    return await ingest(options);
  } catch (error) {
    const outcome = describeFailure(error, signal);
    finishUnsuccessfully(db, buildId, outcome);
    return outcome;
  }
}

function describeFailure(error: unknown, signal: AbortSignal) {
  if (signal.aborted) {
    return {
      state: "cancelled" as const,
      code: "cancelled",
      message: "The build was cancelled",
      retryable: true,
    };
  }
  if (error instanceof BuildStoppedError) {
    return {
      state: "cancelled" as const,
      code: "stopped",
      message: "The build was stopped by another request",
      retryable: true,
    };
  }
  if (error instanceof IngestLimitError) {
    return {
      state: "failed" as const,
      code: "limit_exceeded",
      message: error.message,
      retryable: false,
    };
  }
  if (error instanceof GitSnapshotError) {
    return {
      state: "failed" as const,
      code: error.code,
      message: error.message,
      retryable: error.code === "git_failed",
    };
  }
  return {
    state: "failed" as const,
    code: "internal_error",
    message: error instanceof Error ? `${error.name}: ${error.message}` : "Unknown error",
    retryable: true,
  };
}

async function ingest({
  db,
  buildId,
  directory,
  limits,
  signal,
}: IngestOptions): Promise<IngestResult> {
  const build = getBuild(db, buildId);
  if (!build) throw new Error(`Unknown index build ${buildId}`);
  const started = db
    .query(
      `UPDATE index_builds SET state = 'running', phase = 'enumerating', started_at = ?, updated_at = ?
       WHERE id = ? AND state = 'queued'`,
    )
    .run(now(), now(), buildId);
  if (started.changes !== 1) throw new Error(`Index build ${buildId} is not queued`);

  let entries: TreeEntry[];
  try {
    entries = await listTree(directory, build.sha, { maxFiles: limits.maxFiles, signal });
  } catch (error) {
    if (error instanceof GitSnapshotError && error.code === "limit_exceeded") {
      throw new IngestLimitError(error.message);
    }
    throw error;
  }
  signal.throwIfAborted();
  db.query(
    `UPDATE index_builds SET phase = 'planning', files_total = ?, updated_at = ? WHERE id = ?`,
  ).run(entries.length, now(), buildId);

  const plan = await planRefresh(db, build, directory, entries, signal);
  signal.throwIfAborted();
  recordPlan(db, buildId, plan);

  // Reuse stored content only when every chunk row is still present.
  const findContent = db.query<{ id: number }, [string, string]>(
    `SELECT id FROM index_contents ic WHERE blob_oid = ? AND chunker = ?
       AND chunk_count = (SELECT COUNT(*) FROM index_chunks WHERE content_id = ic.id)`,
  );
  const counters = { done: 0, indexed: 0, excluded: 0, reused: 0, chunks: 0, bytes: 0 };
  const checkBytes = () => {
    if (counters.bytes > limits.maxIndexedBytes) {
      throw new IngestLimitError(
        `Eligible source exceeds ${limits.maxIndexedBytes} bytes (maxIndexedBytes)`,
      );
    }
  };
  if (plan.mode === "incremental") {
    carryForward(db, buildId, plan.base.id, plan.skipCarry, counters);
    checkBytes();
  }

  const pending: FileResult[] = [];
  let pendingBytes = 0;
  const flush = () => {
    if (pending.length > 0) writeBatch(db, buildId, pending.splice(0), counters);
    pendingBytes = 0;
  };
  const record = (result: FileResult) => {
    if (result.reason === undefined) {
      counters.bytes += result.entry.size;
      checkBytes();
    }
    pending.push(result);
    pendingBytes += result.content?.bytes ?? 0;
    if (pending.length >= FLUSH_FILES || pendingBytes >= FLUSH_BYTES) flush();
  };

  // Classify by path and metadata first; only eligible, unseen blobs are read.
  const toRead: { entry: TreeEntry; language: string; chunker: string }[] = [];
  for (const entry of entries) {
    signal.throwIfAborted();
    if (plan.mode === "incremental" && !plan.reprocess.has(entry.path)) continue;
    const decision = classifyEntry(entry, limits);
    if ("reason" in decision) {
      record({ entry, reason: decision.reason });
      continue;
    }
    const chunker = chunkerId(decision.language, limits);
    const existing = findContent.get(entry.oid, chunker);
    if (existing) record({ entry, language: decision.language, contentId: existing.id });
    else toRead.push({ entry, language: decision.language, chunker });
  }

  const readers = Array.from(
    { length: Math.min(limits.readConcurrency, toRead.length) },
    () => new BlobReader(directory, signal),
  );
  try {
    let next = 0;
    let failure: unknown;
    await Promise.all(
      readers.map(async (reader) => {
        while (failure === undefined && next < toRead.length) {
          const item = toRead[next++]!;
          try {
            signal.throwIfAborted();
            const bytes = await reader.read(item.entry.oid);
            signal.throwIfAborted();
            record(processBlob(item, bytes, limits));
          } catch (error) {
            failure ??= error;
          }
        }
      }),
    );
    if (failure !== undefined) throw failure;
  } finally {
    await Promise.all(readers.map((reader) => reader.close()));
  }
  signal.throwIfAborted();
  flush();
  publish(db, buildId, entries.length);
  return { state: "ready" };
}

// ---------------------------------------------------------------------------
// Refresh planning

type RefreshPlan =
  | { readonly mode: "full"; readonly reason: string }
  | {
      readonly mode: "incremental";
      readonly base: BuildRecord;
      /** Paths of the new tree that must be classified again; all others are carried. */
      readonly reprocess: ReadonlySet<string>;
      /** Base paths not carried over: everything changed, deleted or reprocessed. */
      readonly skipCarry: ReadonlySet<string>;
      readonly added: number;
      readonly modified: number;
      readonly deleted: number;
      readonly renamed: number;
    };

/** Ready builds considered as a refresh base, newest first. */
const BASE_CANDIDATES = 8;

async function planRefresh(
  db: Database,
  build: BuildRecord,
  directory: string,
  entries: readonly TreeEntry[],
  signal: AbortSignal,
): Promise<RefreshPlan> {
  if (build.requestedMode === "full") return { mode: "full", reason: "rebuild_requested" };
  const candidates = listReadyBuilds(db, build.repositoryId, build.indexKey, BASE_CANDIDATES + 1)
    .filter((candidate) => candidate.sha !== build.sha)
    .slice(0, BASE_CANDIDATES);
  if (candidates.length === 0) return { mode: "full", reason: "no_base" };

  let base: BuildRecord | undefined;
  for (const candidate of candidates) {
    // A damaged snapshot is never a base: its rows would be carried forward.
    if (!snapshotIntact(db, candidate)) continue;
    if (await isAncestor(directory, candidate.sha, build.sha, signal)) {
      base = candidate;
      break;
    }
  }
  if (!base) return { mode: "full", reason: "not_ancestor" };

  let changes: TreeChange[];
  try {
    changes = await diffTrees(directory, base.sha, build.sha, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof GitSnapshotError) return { mode: "full", reason: "diff_failed" };
    throw error;
  }

  // Verify the carried part by content identity: every unchanged entry of the
  // new tree must match the base manifest exactly, and nothing else may remain.
  const changed = new Set(changes.map((change) => change.path));
  const baseRows = new Map(
    db
      .query<
        {
          path: string;
          reason: string | null;
          blob_oid: string | null;
          mode: string;
          byte_size: number;
        },
        [string]
      >("SELECT path, reason, blob_oid, mode, byte_size FROM index_files WHERE build_id = ?")
      .all(base.id)
      .map((row) => [row.path, row]),
  );
  const reprocess = new Set<string>();
  let carried = 0;
  for (const entry of entries) {
    if (changed.has(entry.path)) {
      reprocess.add(entry.path);
      continue;
    }
    const row = baseRows.get(entry.path);
    if (
      !row ||
      row.mode !== entry.mode ||
      row.byte_size !== entry.size ||
      (entry.type === "blob" && row.blob_oid !== entry.oid)
    ) {
      return { mode: "full", reason: "base_mismatch" };
    }
    // A blob that could not be read before may be readable now.
    if (row.reason === "unreadable") reprocess.add(entry.path);
    else carried += 1;
  }
  let carriedInBase = 0;
  for (const [path, row] of baseRows) {
    if (!changed.has(path) && row.reason !== "unreadable") carriedInBase += 1;
  }
  if (carriedInBase !== carried) return { mode: "full", reason: "base_mismatch" };

  // Report a deletion and addition of the same blob as one rename.
  const deletedOids = new Map<string, number>();
  for (const change of changes) {
    if (change.status === "deleted" && change.oldOid) {
      deletedOids.set(change.oldOid, (deletedOids.get(change.oldOid) ?? 0) + 1);
    }
  }
  let added = 0;
  let modified = 0;
  let deleted = 0;
  let renamed = 0;
  for (const change of changes) {
    if (change.status === "modified") modified += 1;
    else if (change.status === "deleted") deleted += 1;
    else if (change.newOid && (deletedOids.get(change.newOid) ?? 0) > 0) {
      deletedOids.set(change.newOid, deletedOids.get(change.newOid)! - 1);
      renamed += 1;
    } else added += 1;
  }
  deleted -= renamed;
  const skipCarry = new Set([...changed, ...reprocess]);
  return { mode: "incremental", base, reprocess, skipCarry, added, modified, deleted, renamed };
}

function recordPlan(db: Database, buildId: string, plan: RefreshPlan): void {
  const incremental = plan.mode === "incremental" ? plan : undefined;
  db.query(
    `UPDATE index_builds
     SET phase = 'indexing', refresh_mode = ?, refresh_reason = ?, base_build_id = ?, base_sha = ?,
         files_added = ?, files_modified = ?, files_deleted = ?, files_renamed = ?, updated_at = ?
     WHERE id = ? AND state = 'running'`,
  ).run(
    plan.mode,
    plan.mode === "full" ? plan.reason : null,
    incremental?.base.id ?? null,
    incremental?.base.sha ?? null,
    incremental?.added ?? 0,
    incremental?.modified ?? 0,
    incremental?.deleted ?? 0,
    incremental?.renamed ?? 0,
    now(),
    buildId,
  );
}

/**
 * Copy the base manifest rows of every unchanged entry into this build in one
 * transaction. Chunk content is shared by id, so nothing is read or chunked.
 */
function carryForward(
  db: Database,
  buildId: string,
  baseId: string,
  skip: ReadonlySet<string>,
  counters: {
    done: number;
    indexed: number;
    excluded: number;
    reused: number;
    chunks: number;
    bytes: number;
  },
): void {
  db.transaction(() => {
    db.query(
      `INSERT INTO index_files (build_id, path, status, reason, language, blob_oid, mode, byte_size, content_id)
       SELECT ?1, path, status, reason, language, blob_oid, mode, byte_size, content_id
       FROM index_files
       WHERE build_id = ?2 AND path NOT IN (SELECT value FROM json_each(?3))`,
    ).run(buildId, baseId, JSON.stringify([...skip]));
    const totals = db
      .query<{ files: number; indexed: number; bytes: number; chunks: number }, [string]>(
        `SELECT COUNT(*) AS files,
                COALESCE(SUM(f.status = 'indexed'), 0) AS indexed,
                COALESCE(SUM(CASE WHEN f.status = 'indexed' THEN f.byte_size END), 0) AS bytes,
                COALESCE(SUM(c.chunk_count), 0) AS chunks
         FROM index_files f LEFT JOIN index_contents c ON c.id = f.content_id
         WHERE f.build_id = ?`,
      )
      .get(buildId)!;
    counters.done += totals.files;
    counters.indexed += totals.indexed;
    counters.excluded += totals.files - totals.indexed;
    counters.reused += totals.indexed;
    counters.chunks += totals.chunks;
    counters.bytes += totals.bytes;
    const progress = db
      .query(
        `UPDATE index_builds
         SET files_carried = ?, files_done = ?, files_indexed = ?, files_excluded = ?,
             files_reused = ?, chunk_count = ?, updated_at = ?
         WHERE id = ? AND state = 'running'`,
      )
      .run(
        totals.files,
        counters.done,
        counters.indexed,
        counters.excluded,
        counters.reused,
        counters.chunks,
        now(),
        buildId,
      );
    if (progress.changes !== 1) throw new BuildStoppedError(`Index build ${buildId} was stopped`);
  })();
}

function classifyEntry(
  entry: TreeEntry,
  limits: IndexLimits,
): { reason: ExclusionReason } | { language: string } {
  if (entry.type === "symlink") return { reason: "symlink" };
  if (entry.type === "submodule") return { reason: "submodule" };
  if (!entry.pathIsUtf8) return { reason: "unsafe_path" };
  const classification = classifyPath(entry.path);
  if (!classification.eligible) return { reason: classification.reason };
  if (entry.size > limits.maxFileBytes) return { reason: "oversized" };
  return { language: classification.language };
}

function processBlob(
  item: { entry: TreeEntry; language: string; chunker: string },
  bytes: Uint8Array | undefined,
  limits: IndexLimits,
): FileResult {
  const { entry, language } = item;
  if (bytes === undefined) return { entry, reason: "unreadable" };
  // Never trust the listed size alone: bound what was actually read.
  if (bytes.length > limits.maxFileBytes) return { entry, reason: "oversized" };
  const check = checkContent(bytes, limits);
  if (!check.eligible) return { entry, reason: check.reason };
  const chunks = chunkFile(check.text, language, limits);
  return {
    entry,
    language,
    content: {
      chunker: item.chunker,
      hash: sha256(bytes),
      bytes: bytes.length,
      lines: splitLines(check.text).length,
      chunks,
    },
  };
}

function sha256(data: Uint8Array | string): string {
  return new Bun.CryptoHasher("sha256").update(data).digest("hex");
}

function writeBatch(
  db: Database,
  buildId: string,
  batch: readonly FileResult[],
  counters: { done: number; indexed: number; excluded: number; reused: number; chunks: number },
): void {
  const findContent = db.query<
    { id: number; chunk_count: number; stored: number },
    [string, string]
  >(
    `SELECT id, chunk_count, (SELECT COUNT(*) FROM index_chunks WHERE content_id = ic.id) AS stored
     FROM index_contents ic WHERE blob_oid = ? AND chunker = ?`,
  );
  const deleteChunks = db.query("DELETE FROM index_chunks WHERE content_id = ?");
  const updateContent = db.query(
    `UPDATE index_contents SET content_hash = ?, byte_size = ?, line_count = ?, chunk_count = ?
     WHERE id = ?`,
  );
  const chunkCount = db.query<{ chunk_count: number }, [number]>(
    "SELECT chunk_count FROM index_contents WHERE id = ?",
  );
  const insertContent = db.query<{ id: number }, [string, string, string, number, number, number]>(
    `INSERT INTO index_contents (blob_oid, chunker, content_hash, byte_size, line_count, chunk_count)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
  );
  const insertChunk = db.query(
    `INSERT INTO index_chunks (content_id, ordinal, start_line, end_line, content_hash, text, symbols, terms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFile = db.query(
    `INSERT INTO index_files (build_id, path, status, reason, language, blob_oid, mode, byte_size, content_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const result of batch) {
      const { entry } = result;
      const blobOid = entry.type === "blob" ? entry.oid : null;
      if (result.reason !== undefined) {
        insertFile.run(
          buildId,
          entry.path,
          "excluded",
          result.reason,
          null,
          blobOid,
          entry.mode,
          entry.size,
          null,
        );
        counters.excluded += 1;
        counters.done += 1;
        continue;
      }
      let contentId = result.contentId;
      let chunks: number;
      if (contentId !== undefined) {
        chunks = chunkCount.get(contentId)!.chunk_count;
        counters.reused += 1;
      } else {
        const content = result.content!;
        const existing = findContent.get(entry.oid, content.chunker);
        if (existing && existing.stored === existing.chunk_count) {
          contentId = existing.id;
          chunks = existing.chunk_count;
        } else {
          if (existing) {
            // Stored content lost chunk rows. The same blob and chunker always
            // produce the same chunks, so rewrite them in place.
            contentId = existing.id;
            deleteChunks.run(contentId);
            updateContent.run(
              content.hash,
              content.bytes,
              content.lines,
              content.chunks.length,
              contentId,
            );
          } else {
            contentId = insertContent.get(
              entry.oid,
              content.chunker,
              content.hash,
              content.bytes,
              content.lines,
              content.chunks.length,
            )!.id;
          }
          for (const chunk of content.chunks) {
            insertChunk.run(
              contentId,
              chunk.ordinal,
              chunk.startLine,
              chunk.endLine,
              sha256(chunk.text),
              chunk.text,
              chunk.symbols.join(" "),
              identifierTerms(`${chunk.symbols.join(" ")}\n${chunk.text}`),
            );
          }
          chunks = content.chunks.length;
        }
      }
      insertFile.run(
        buildId,
        entry.path,
        "indexed",
        null,
        result.language!,
        blobOid,
        entry.mode,
        entry.size,
        contentId,
      );
      counters.indexed += 1;
      counters.chunks += chunks;
      counters.done += 1;
    }
    const progress = db
      .query(
        `UPDATE index_builds
       SET files_done = ?, files_indexed = ?, files_excluded = ?, files_reused = ?,
           chunk_count = ?, updated_at = ?
       WHERE id = ? AND state = 'running'`,
      )
      .run(
        counters.done,
        counters.indexed,
        counters.excluded,
        counters.reused,
        counters.chunks,
        now(),
        buildId,
      );
    // Rolls back this batch: the build was stopped elsewhere, so stop work too.
    if (progress.changes !== 1) throw new BuildStoppedError(`Index build ${buildId} was stopped`);
  })();
}

/**
 * Atomically publish the build if every tracked entry is accounted for. A
 * previously served generation of the same scope, which exists only when this
 * is an explicit rebuild, is retired in the same transaction, so readers see
 * either the old complete generation or the new one and never neither.
 */
function publish(db: Database, buildId: string, filesTotal: number): void {
  db.transaction(() => {
    const build = getBuild(db, buildId);
    if (!build) throw new Error(`Unknown index build ${buildId}`);
    const totals = db
      .query<{ files: number; bytes: number }, [string]>(
        `SELECT COUNT(*) AS files,
                COALESCE(SUM(CASE WHEN status = 'indexed' THEN byte_size END), 0) AS bytes
         FROM index_files WHERE build_id = ?`,
      )
      .get(buildId)!;
    if (totals.files !== filesTotal) {
      throw new Error(`Recorded ${totals.files} of ${filesTotal} tracked entries; not publishing`);
    }
    const timestamp = now();
    db.query(
      `UPDATE index_builds SET retired_at = ?
       WHERE repository_id = ? AND sha = ? AND index_key = ? AND id != ?
         AND state = 'ready' AND retired_at IS NULL`,
    ).run(timestamp, build.repositoryId, build.sha, build.indexKey, buildId);
    const result = db
      .query(
        `UPDATE index_builds
         SET state = 'ready', phase = 'ready', indexed_bytes = ?, updated_at = ?, finished_at = ?
         WHERE id = ? AND state = 'running' AND files_done = files_total`,
      )
      .run(totals.bytes, timestamp, timestamp, buildId);
    if (result.changes !== 1) throw new Error(`Index build ${buildId} could not be published`);
  }).immediate();
}
