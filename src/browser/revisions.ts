/**
 * Committed revisions a browser may choose: the branches and tags of an
 * authorized repository, and resolution of one of them to an exact SHA.
 *
 * The browser names a repository by its configured id and a revision by a
 * branch or tag name, `HEAD` or a full commit SHA. It never sends a path, a
 * URL or Git revision syntax: names are checked against a strict pattern and
 * looked up only under `refs/heads/` and `refs/tags/`, so `main~1`, `:/text`,
 * `@{-1}` or an option such as `--upload-pack` can never reach Git.
 */
import { isFullCommitSha } from "../contract/context";
import { commitExists, runGit } from "../indexing/git-snapshot";
import type { RepositoryConfig } from "../service/config";

/** Refs listed for one repository. More are not offered; a SHA can still be entered. */
export const MAX_LISTED_REFS = 200;
const MAX_REF_CHARS = 200;

/** Branch and tag names: no revision syntax, no option, no traversal, no lock files. */
const REF_NAME = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/;

export interface RefChoice {
  readonly kind: "branch" | "tag";
  /** Name without `refs/heads/` or `refs/tags/`. */
  readonly name: string;
  /** Commit the ref points at now. Resolve again before asking; refs move. */
  readonly sha: string;
}

export interface RefListing {
  readonly head?: { readonly sha: string; readonly branch?: string };
  readonly refs: readonly RefChoice[];
  /** True when more refs exist than were listed. */
  readonly truncated: boolean;
}

export type Resolution =
  | { readonly ok: true; readonly sha: string; readonly ref?: string }
  | { readonly ok: false; readonly code: "invalid_ref" | "unknown_revision" };

export function isSafeRefName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_REF_CHARS &&
    REF_NAME.test(name) &&
    !name.includes("..") &&
    !name.includes("//") &&
    !name.endsWith("/") &&
    !name.endsWith(".") &&
    !name.endsWith(".lock") &&
    !name.split("/").some((part) => part.startsWith("."))
  );
}

function text(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).trim();
}

async function commitOf(
  repository: RepositoryConfig,
  fullRef: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  const result = await runGit(
    repository.path,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${fullRef}^{commit}`],
    signal,
  );
  const sha = text(result.stdout);
  return result.exitCode === 0 && isFullCommitSha(sha) ? sha : undefined;
}

export async function listRefs(
  repository: RepositoryConfig,
  signal: AbortSignal,
): Promise<RefListing> {
  const result = await runGit(
    repository.path,
    [
      "for-each-ref",
      `--count=${MAX_LISTED_REFS + 1}`,
      "--sort=-creatordate",
      "--format=%(refname)%09%(objectname)%09%(*objectname)",
      "refs/heads",
      "refs/tags",
    ],
    signal,
  );
  if (result.exitCode !== 0) throw new Error(`Could not list refs of ${repository.id}`);
  const refs: RefChoice[] = [];
  for (const line of text(result.stdout).split("\n")) {
    if (line === "") continue;
    const [refname = "", object = "", peeled = ""] = line.split("\t");
    const kind = refname.startsWith("refs/heads/")
      ? "branch"
      : refname.startsWith("refs/tags/")
        ? "tag"
        : undefined;
    const sha = peeled || object;
    if (!kind || !isFullCommitSha(sha)) continue;
    const name = refname.slice(kind === "branch" ? "refs/heads/".length : "refs/tags/".length);
    // Names a browser could not send back are not offered.
    if (isSafeRefName(name)) refs.push({ kind, name, sha });
  }
  const truncated = refs.length > MAX_LISTED_REFS;
  const headSha = await commitOf(repository, "HEAD", signal);
  let branch: string | undefined;
  if (headSha) {
    const symbolic = await runGit(
      repository.path,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      signal,
    );
    const name = text(symbolic.stdout);
    if (symbolic.exitCode === 0 && isSafeRefName(name)) branch = name;
  }
  return {
    ...(headSha ? { head: { sha: headSha, ...(branch ? { branch } : {}) } } : {}),
    refs: refs.slice(0, MAX_LISTED_REFS),
    truncated,
  };
}

/**
 * Resolve a browser's revision choice to an exact commit, once. A full SHA
 * is accepted when the commit is here, or when the repository may fetch it.
 */
export async function resolveRevision(
  repository: RepositoryConfig,
  ref: string,
  signal: AbortSignal,
): Promise<Resolution> {
  if (isFullCommitSha(ref)) {
    if (repository.fetchRemote || (await commitExists(repository.path, ref, signal))) {
      return { ok: true, sha: ref };
    }
    return { ok: false, code: "unknown_revision" };
  }
  if (ref === "HEAD") {
    const sha = await commitOf(repository, "HEAD", signal);
    return sha ? { ok: true, sha, ref } : { ok: false, code: "unknown_revision" };
  }
  if (!isSafeRefName(ref)) return { ok: false, code: "invalid_ref" };
  const candidates =
    ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/")
      ? [ref]
      : [`refs/heads/${ref}`, `refs/tags/${ref}`];
  for (const candidate of candidates) {
    const sha = await commitOf(repository, candidate, signal);
    if (sha) return { ok: true, sha, ref };
  }
  return { ok: false, code: "unknown_revision" };
}
