import type { Database } from "bun:sqlite";
import { chunkerId, chunkFile, identifierTerms, splitLines, type Chunk } from "./chunker";
import { BlobReader, GitSnapshotError, listTree, type TreeEntry } from "./git-snapshot";
import {
  checkContent,
  classifyPath,
  type ExclusionReason,
  type IndexLimits,
  validateLimits,
} from "./policy";
import { finishUnsuccessfully, getBuild, now } from "./store";

/**
 * Runs one index build to completion: enumerate the commit's tree, classify
 * every entry, read and chunk eligible blobs, and publish. The build becomes
 * `ready` in a single transaction only after every tracked entry has been
 * recorded as indexed or excluded. Any error or cancellation leaves it
 * `failed` or `cancelled`, which are never served.
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
    `UPDATE index_builds SET phase = 'indexing', files_total = ?, updated_at = ? WHERE id = ?`,
  ).run(entries.length, now(), buildId);

  const findContent = db.query<{ id: number }, [string, string]>(
    "SELECT id FROM index_contents WHERE blob_oid = ? AND chunker = ?",
  );
  const counters = { done: 0, indexed: 0, excluded: 0, reused: 0, chunks: 0, bytes: 0 };
  const pending: FileResult[] = [];
  let pendingBytes = 0;
  const flush = () => {
    if (pending.length > 0) writeBatch(db, buildId, pending.splice(0), counters);
    pendingBytes = 0;
  };
  const record = (result: FileResult) => {
    if (result.reason === undefined) {
      counters.bytes += result.entry.size;
      if (counters.bytes > limits.maxIndexedBytes) {
        throw new IngestLimitError(
          `Eligible source exceeds ${limits.maxIndexedBytes} bytes (maxIndexedBytes)`,
        );
      }
    }
    pending.push(result);
    pendingBytes += result.content?.bytes ?? 0;
    if (pending.length >= FLUSH_FILES || pendingBytes >= FLUSH_BYTES) flush();
  };

  // Classify by path and metadata first; only eligible, unseen blobs are read.
  const toRead: { entry: TreeEntry; language: string; chunker: string }[] = [];
  for (const entry of entries) {
    signal.throwIfAborted();
    const decision = classifyEntry(entry, limits);
    if ("reason" in decision) {
      record({ entry, reason: decision.reason });
      continue;
    }
    const chunker = chunkerId(decision.language);
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
  const findContent = db.query<{ id: number; chunk_count: number }, [string, string]>(
    "SELECT id, chunk_count FROM index_contents WHERE blob_oid = ? AND chunker = ?",
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
        if (existing) {
          contentId = existing.id;
          chunks = existing.chunk_count;
        } else {
          contentId = insertContent.get(
            entry.oid,
            content.chunker,
            content.hash,
            content.bytes,
            content.lines,
            content.chunks.length,
          )!.id;
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

/** Atomically publish the build if every tracked entry is accounted for. */
function publish(db: Database, buildId: string, filesTotal: number): void {
  db.transaction(() => {
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
