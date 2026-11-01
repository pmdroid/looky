import { isFullCommitSha } from "../contract/context";

/**
 * Exact, read-only access to one commit in a local Git object database.
 *
 * Only plumbing commands run (`cat-file`, `ls-tree`, `diff-tree`, `merge-base`), always with an argument
 * vector and never through a shell. They read objects by id, so the worktree,
 * index, checkout filters, textconv and hooks are never involved. Replace refs,
 * lazy fetches from promisor remotes, fsmonitor and system/global config are
 * disabled so the bytes are exactly the objects named by the commit.
 */

export class GitSnapshotError extends Error {
  override readonly name = "GitSnapshotError";
  constructor(
    readonly code: "revision_not_found" | "git_failed" | "limit_exceeded",
    message: string,
  ) {
    super(message);
  }
}

export type TreeEntryType = "blob" | "symlink" | "submodule";

export interface TreeEntry {
  /** Repository-relative path. Lossily decoded if the raw name was not UTF-8. */
  readonly path: string;
  /** False when the raw path bytes were not valid UTF-8. */
  readonly pathIsUtf8: boolean;
  readonly type: TreeEntryType;
  readonly mode: string;
  readonly oid: string;
  /** Blob size in bytes; 0 for submodules. */
  readonly size: number;
}

const SCRUBBED_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_EXTERNAL_DIFF",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
];

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !SCRUBBED_ENV.includes(key)) env[key] = value;
  }
  return {
    ...env,
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_ATTR_NOSYSTEM: "1",
    LC_ALL: "C",
  };
}

function gitArgv(directory: string, args: readonly string[]): string[] {
  return [
    "git",
    "--no-replace-objects",
    "-c",
    "core.fsmonitor=false",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "protocol.allow=never",
    "-C",
    directory,
    ...args,
  ];
}

export async function runGit(directory: string, args: readonly string[], signal: AbortSignal) {
  signal.throwIfAborted();
  const child = Bun.spawn(gitArgv(directory, args), {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: gitEnv(),
    signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).bytes(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  signal.throwIfAborted();
  return { stdout, stderr, exitCode };
}

/** Confirm `sha` names a commit in the repository. Never resolves refs or short ids. */
export async function commitExists(
  directory: string,
  sha: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!isFullCommitSha(sha)) return false;
  const result = await runGit(directory, ["cat-file", "-t", sha], signal);
  return result.exitCode === 0 && new TextDecoder().decode(result.stdout).trim() === "commit";
}

/**
 * Fetch exactly one commit from a configured remote of a Looky-owned clone,
 * for a request whose SHA this host has not seen yet. Only the object is
 * fetched: no tags, no submodules, no refs updated and no FETCH_HEAD, and
 * hooks stay disabled. The `ext` transport, which runs commands, is refused.
 * Returns whether the commit exists afterwards.
 */
export async function fetchCommit(
  directory: string,
  remote: string,
  sha: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!isFullCommitSha(sha) || !/^[A-Za-z0-9._-]+$/.test(remote)) return false;
  signal.throwIfAborted();
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "protocol.ext.allow=never",
      "-C",
      directory,
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-recurse-submodules",
      "--no-write-fetch-head",
      remote,
      sha,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: gitEnv(), signal },
  );
  await Promise.all([new Response(child.stderr).text(), child.exited]);
  signal.throwIfAborted();
  return commitExists(directory, sha, signal);
}

/** True when the directory is a readable Git repository (bare or not). */
export async function repositoryAccessible(
  directory: string,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    const result = await runGit(directory, ["rev-parse", "--git-dir"], signal);
    return result.exitCode === 0;
  } catch (error) {
    signal.throwIfAborted();
    // A missing directory makes spawn itself fail.
    if (error instanceof Error) return false;
    throw error;
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const lossy = new TextDecoder("utf-8");

/**
 * Enumerate every entry of the commit's tree recursively. Fails with
 * `limit_exceeded` rather than returning a truncated listing.
 */
export async function listTree(
  directory: string,
  sha: string,
  options: { readonly maxFiles: number; readonly signal: AbortSignal },
): Promise<TreeEntry[]> {
  if (!(await commitExists(directory, sha, options.signal))) {
    throw new GitSnapshotError("revision_not_found", `Commit ${sha} is not in the repository`);
  }
  const result = await runGit(
    directory,
    ["ls-tree", "-r", "-z", "-l", "--full-tree", sha],
    options.signal,
  );
  if (result.exitCode !== 0) {
    throw new GitSnapshotError("git_failed", `git ls-tree failed: ${result.stderr.trim()}`);
  }
  const entries: TreeEntry[] = [];
  let start = 0;
  const out = result.stdout;
  while (start < out.length) {
    const end = out.indexOf(0, start);
    const record = out.subarray(start, end === -1 ? out.length : end);
    start = end === -1 ? out.length : end + 1;
    if (record.length === 0) continue;
    if (entries.length >= options.maxFiles) {
      throw new GitSnapshotError(
        "limit_exceeded",
        `The commit has more than ${options.maxFiles} tracked entries (maxFiles)`,
      );
    }
    entries.push(parseTreeRecord(record));
  }
  return entries;
}

function decodePath(raw: Uint8Array): { path: string; pathIsUtf8: boolean } {
  try {
    return { path: utf8.decode(raw), pathIsUtf8: true };
  } catch {
    return { path: lossy.decode(raw), pathIsUtf8: false };
  }
}

function parseTreeRecord(record: Uint8Array): TreeEntry {
  const tab = record.indexOf(9);
  if (tab === -1) throw new GitSnapshotError("git_failed", "Unexpected git ls-tree output");
  const header = lossy.decode(record.subarray(0, tab)).trim().split(/\s+/);
  const [mode, objectType, oid, size] = header;
  if (!mode || !objectType || !oid || size === undefined) {
    throw new GitSnapshotError("git_failed", "Unexpected git ls-tree output");
  }
  const { path, pathIsUtf8 } = decodePath(record.subarray(tab + 1));
  const type: TreeEntryType =
    objectType === "commit" ? "submodule" : mode === "120000" ? "symlink" : "blob";
  return { path, pathIsUtf8, type, mode, oid, size: size === "-" ? 0 : Number(size) };
}

// ---------------------------------------------------------------------------
// Revision differences

/**
 * True when `ancestor` is reachable from `descendant`. Any failure, such as a
 * base commit that no longer exists after a force push and garbage
 * collection, is reported as not an ancestor so callers fall back safely.
 */
export async function isAncestor(
  directory: string,
  ancestor: string,
  descendant: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (!isFullCommitSha(ancestor) || !isFullCommitSha(descendant)) return false;
  const result = await runGit(
    directory,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    signal,
  );
  return result.exitCode === 0;
}

export type TreeChangeStatus = "added" | "modified" | "deleted";

export interface TreeChange {
  readonly path: string;
  readonly status: TreeChangeStatus;
  /** Blob or gitlink id before the change; null when added. */
  readonly oldOid: string | null;
  /** Blob or gitlink id after the change; null when deleted. */
  readonly newOid: string | null;
}

const ZERO_OID = /^0+$/;

/**
 * Every path whose tree entry differs between two commits, recursively.
 * Renames are reported as a deletion plus an addition (`--no-renames`), and
 * type or mode changes as modifications. Paths are decoded like `listTree`.
 */
export async function diffTrees(
  directory: string,
  from: string,
  to: string,
  signal: AbortSignal,
): Promise<TreeChange[]> {
  const result = await runGit(
    directory,
    ["diff-tree", "-r", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", from, to],
    signal,
  );
  if (result.exitCode !== 0) {
    throw new GitSnapshotError("git_failed", `git diff-tree failed: ${result.stderr.trim()}`);
  }
  const fields: Uint8Array[] = [];
  const out = result.stdout;
  let start = 0;
  while (start < out.length) {
    const end = out.indexOf(0, start);
    fields.push(out.subarray(start, end === -1 ? out.length : end));
    start = end === -1 ? out.length : end + 1;
  }
  const changes: TreeChange[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const header = lossy.decode(fields[index]!);
    // ":<old mode> <new mode> <old oid> <new oid> <status>"
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(header);
    if (!match) throw new GitSnapshotError("git_failed", "Unexpected git diff-tree output");
    const [, , , oldOid, newOid, code] = match;
    const status: TreeChangeStatus = code === "A" ? "added" : code === "D" ? "deleted" : "modified";
    changes.push({
      path: decodePath(fields[index + 1]!).path,
      status,
      oldOid: ZERO_OID.test(oldOid!) ? null : oldOid!,
      newOid: ZERO_OID.test(newOid!) ? null : newOid!,
    });
  }
  return changes;
}

// ---------------------------------------------------------------------------
// Blob reads

/**
 * One long-lived `git cat-file --batch` process. Requests are serialized;
 * run several readers for bounded parallelism.
 */
export class BlobReader {
  private readonly child;
  private readonly reader: { read(): Promise<{ done: boolean; value?: Uint8Array | undefined }> };
  private buffer = new Uint8Array(0);
  private offset = 0;
  private pending: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(directory: string, signal: AbortSignal) {
    this.child = Bun.spawn(gitArgv(directory, ["cat-file", "--batch"]), {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
      env: gitEnv(),
      signal,
    });
    this.reader = this.child.stdout.getReader();
  }

  /** Read a blob by object id. Returns undefined when the object is missing or not a blob. */
  read(oid: string): Promise<Uint8Array | undefined> {
    const next = this.pending.then(() => this.readOne(oid));
    this.pending = next.catch(() => undefined);
    return next;
  }

  private async readOne(oid: string): Promise<Uint8Array | undefined> {
    if (this.closed) throw new GitSnapshotError("git_failed", "Blob reader is closed");
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(oid)) {
      throw new GitSnapshotError("git_failed", "Invalid object id");
    }
    this.child.stdin.write(`${oid}\n`);
    await this.child.stdin.flush();
    const header = lossy.decode(await this.readLine()).split(" ");
    if (header[1] === "missing" || header.length !== 3) return undefined;
    const size = Number(header[2]);
    const body = await this.readExact(size + 1);
    if (header[1] !== "blob") return undefined;
    return body.subarray(0, size);
  }

  private available(): number {
    return this.buffer.length - this.offset;
  }

  private async fill(): Promise<void> {
    const { value, done } = await this.reader.read();
    if (done || value === undefined)
      throw new GitSnapshotError("git_failed", "git cat-file exited unexpectedly");
    const rest = this.buffer.subarray(this.offset);
    const merged = new Uint8Array(rest.length + value.length);
    merged.set(rest, 0);
    merged.set(value, rest.length);
    this.buffer = merged;
    this.offset = 0;
  }

  private async readLine(): Promise<Uint8Array> {
    for (;;) {
      const newline = this.buffer.indexOf(10, this.offset);
      if (newline !== -1) {
        const line = this.buffer.slice(this.offset, newline);
        this.offset = newline + 1;
        return line;
      }
      await this.fill();
    }
  }

  private async readExact(size: number): Promise<Uint8Array> {
    while (this.available() < size) await this.fill();
    const bytes = this.buffer.slice(this.offset, this.offset + size);
    this.offset += size;
    return bytes;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.child.stdin.end();
    } catch {
      // The process may already have exited; it is killed below either way.
    }
    this.child.kill();
    await this.child.exited;
  }
}
