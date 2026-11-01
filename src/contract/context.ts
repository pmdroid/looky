/**
 * Client-neutral, trusted request context.
 *
 * A client adapter (Paws is the first) derives this from its authenticated
 * session. Looky treats it as the only source of repository, revision, caller
 * and client scope for a request.
 */

export interface LookyRequestContext {
  /** Client that derived this context, such as "paws". */
  readonly clientId: string;
  /**
   * Client session generation, such as a Paws task/run generation. The adapter
   * rejects requests whose generation is no longer current.
   */
  readonly clientGeneration: string;
  /** Authenticated caller identity as asserted by the client adapter. */
  readonly callerId: string;
  /** Repository the caller is authorized to read. */
  readonly repositoryId: string;
  /** Optional client snapshot of that repository, such as a workspace id. */
  readonly snapshotId?: string;
  /** Exact committed revision, resolved once by the adapter before the request. */
  readonly sha: string;
  /** Ref the SHA was resolved from, for display only. Never re-resolved. */
  readonly ref?: string;
  /** Whether the client's worktree had uncommitted changes, which are never indexed. */
  readonly worktree: WorktreeState;
}

export type WorktreeState =
  | { readonly state: "clean" }
  | { readonly state: "dirty"; readonly changedPaths?: number }
  | { readonly state: "unknown" };

/** Full-length lowercase Git object ids (SHA-1 or SHA-256). Refs and short SHAs are rejected. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export function isFullCommitSha(value: string): boolean {
  return FULL_SHA.test(value);
}

export type ContextProblem =
  | { readonly kind: "invalid_context"; readonly message: string }
  | { readonly kind: "unsupported_revision"; readonly message: string };

const ID_FIELDS = ["clientId", "clientGeneration", "callerId", "repositoryId"] as const;

/**
 * Check the adapter-supplied context. Adapters are trusted, but a malformed
 * context must fail closed instead of widening scope.
 */
export function checkContext(context: LookyRequestContext): ContextProblem | undefined {
  for (const field of ID_FIELDS) {
    const value: unknown = context[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      return { kind: "invalid_context", message: `request context ${field} is required` };
    }
  }
  if (context.snapshotId !== undefined && context.snapshotId.trim().length === 0) {
    return { kind: "invalid_context", message: "request context snapshotId must not be empty" };
  }
  const state: unknown = context.worktree?.state;
  if (state !== "clean" && state !== "dirty" && state !== "unknown") {
    return { kind: "invalid_context", message: "request context worktree state is required" };
  }
  if (typeof context.sha !== "string" || !isFullCommitSha(context.sha)) {
    return {
      kind: "unsupported_revision",
      message:
        "Looky answers only for an exact committed revision given as a full lowercase commit SHA; " +
        "branch names, short SHAs and uncommitted states are not supported.",
    };
  }
  return undefined;
}
