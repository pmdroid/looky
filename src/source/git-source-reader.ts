import { isFullCommitSha } from "../contract/context";
import { LookyUnavailableError, type SourceReader, type SourceText } from "../contract/ports";
import { BudgetExhaustedError } from "../ask/session";
import { splitLines } from "../indexing/chunker";
import { runGit } from "../indexing/git-snapshot";

/** The requested path or line range does not exist at the pinned commit. */
export class SourceRangeError extends Error {
  override readonly name = "SourceRangeError";
}

/**
 * Reads committed blobs from a local Git object database with
 * `git cat-file blob <sha>:<path>`. It never reads worktree files, checks out,
 * stashes or commits, so dirty or moving worktrees cannot affect results.
 * Replace refs, lazy fetches, hooks and system/global config are disabled.
 */
export class GitSourceReader implements SourceReader {
  constructor(
    /** Map an authorized repository id to a local Git directory. Unknown ids are refused. */
    private readonly repositoryPath: (repositoryId: string) => string | undefined,
  ) {}

  async read(
    request: Parameters<SourceReader["read"]>[0],
    signal: AbortSignal,
  ): Promise<SourceText> {
    const directory = this.repositoryPath(request.repositoryId);
    if (directory === undefined) {
      throw new LookyUnavailableError(`No source access configured for ${request.repositoryId}`);
    }
    if (!isFullCommitSha(request.sha)) throw new SourceRangeError("A full commit SHA is required");

    const blob = await git(
      directory,
      ["cat-file", "blob", `${request.sha}:${request.path}`],
      signal,
    );
    if (blob.exitCode !== 0) {
      throw new SourceRangeError(`${request.path} does not exist at ${request.sha}`);
    }
    // Same line split as the chunker, so a final line without a newline stays exact.
    const lines = splitLines(blob.stdout);
    if (request.startLine > lines.length) {
      throw new SourceRangeError(
        `${request.path} has ${lines.length} lines; line ${request.startLine} requested`,
      );
    }

    const selected: string[] = [];
    let bytes = 0;
    const last = Math.min(request.endLine, lines.length);
    for (let index = request.startLine - 1; index < last; index += 1) {
      const line = lines[index]!;
      const size = Buffer.byteLength(line, "utf8");
      if (bytes + size > request.maxBytes) break;
      selected.push(line);
      bytes += size;
    }
    if (selected.length === 0) throw new BudgetExhaustedError("maxSourceBytes");
    return {
      path: request.path,
      startLine: request.startLine,
      endLine: request.startLine + selected.length - 1,
      text: selected.join(""),
    };
  }
}

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Same hardened, shell-free invocation the indexer uses, so reads match indexed bytes. */
async function git(directory: string, args: string[], signal: AbortSignal) {
  const result = await runGit(directory, args, signal);
  return { stdout: decoder.decode(result.stdout), exitCode: result.exitCode };
}
