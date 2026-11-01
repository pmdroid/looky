import type { BudgetField } from "./budgets";
import type { Mode } from "./input";

/**
 * Truthful support level of a delivered answer.
 * - supported: the evidence establishes the answer.
 * - partial: some of the question is established; the rest is stated as missing.
 * - conflicting: evidence disagrees; the answer explains the conflict.
 * - unknown: the indexed revision does not establish an answer. This is a
 *   factual result, distinct from execution failures such as denied or timed out.
 */
export const ANSWER_OUTCOMES = ["supported", "partial", "conflicting", "unknown"] as const;
export type AnswerOutcome = (typeof ANSWER_OUTCOMES)[number];

/** A cited source range at the pinned revision. Metadata only, never the answer itself. */
export interface EvidenceRef {
  readonly path: string;
  /** 1-based inclusive line range. */
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
  /** Short reason this range supports the answer. */
  readonly note?: string;
}

/**
 * A question for people, produced when the code and docs cannot establish
 * something such as design intent or business rationale. The caller decides
 * whether to ask it; Looky never posts it anywhere.
 */
export interface SuggestedHumanQuestion {
  readonly question: string;
  /** Why the indexed revision could not answer it. */
  readonly reason: string;
}

export interface RevisionIdentity {
  readonly repositoryId: string;
  readonly snapshotId?: string;
  readonly sha: string;
  /** Display-only ref the client resolved; the SHA is authoritative. */
  readonly ref?: string;
}

export interface IndexIdentity {
  readonly generationId: string;
  readonly sha: string;
}

/** What source the request covers. Looky only ever reads committed objects. */
export interface SourceScope {
  readonly source: "committed";
  readonly sha: string;
  /** Uncommitted worktree changes are never indexed or read; this states whether any existed. */
  readonly uncommittedChanges: "none" | "excluded" | "unknown";
}

export type UsageCounters = Readonly<Record<UsageField, number>>;
export type UsageField =
  | "retrievalPasses"
  | "sourceReads"
  | "sourceBytes"
  | "modelCalls"
  | "inputTokens"
  | "outputTokens"
  | "elapsedMs";

export interface ModeReport {
  readonly requested: Mode;
  /**
   * Mode research ran in, or null when the request stopped before research
   * (invalid, denied, indexing, unsupported revision). When set it always
   * equals `requested`: Looky never silently upgrades or downgrades a mode.
   */
  readonly executed: Mode | null;
}

interface ResponseBase {
  readonly requestId: string;
  readonly mode: ModeReport;
  /** Explicit statements of what this response does not cover. */
  readonly limitations: readonly string[];
}

/** A complete natural-language answer. The only status that carries answer text. */
export interface AnsweredResponse extends ResponseBase {
  readonly status: "answered";
  readonly answer: {
    /** Complete explanatory prose for the caller. */
    readonly text: string;
    readonly outcome: AnswerOutcome;
    readonly caveats: readonly string[];
  };
  /** Supporting references, separate from the prose. */
  readonly evidence: readonly EvidenceRef[];
  readonly revision: RevisionIdentity;
  readonly index: IndexIdentity;
  readonly scope: SourceScope;
  /** Present only for Fast: Deep may establish more. Never acted on automatically. */
  readonly suggestedMode?: "deep";
  /** Missing intent or rationale the caller may ask people about. Never posted by Looky. */
  readonly suggestedHumanQuestion?: SuggestedHumanQuestion;
  readonly usage: UsageCounters;
  /** Configured providers that served model calls, in first-use order. */
  readonly providers: readonly string[];
}

export interface InvalidRequestResponse extends ResponseBase {
  readonly status: "invalid_request";
  readonly error: { readonly code: string; readonly message: string };
}

export type DeniedReason = "unauthorized" | "revoked" | "stale_session" | "invalid_context";

export interface DeniedResponse extends ResponseBase {
  readonly status: "denied";
  readonly reason: DeniedReason;
  readonly message: string;
}

export interface UnsupportedRevisionResponse extends ResponseBase {
  readonly status: "unsupported_revision";
  readonly message: string;
  readonly revision?: RevisionIdentity;
}

export interface IndexProgress {
  readonly phase: string;
  readonly filesDone?: number;
  readonly filesTotal?: number;
}

/** No ready index exists for the pinned SHA yet. Not an answer; retry later. */
export interface IndexingResponse extends ResponseBase {
  readonly status: "indexing";
  readonly revision: RevisionIdentity;
  readonly buildId: string;
  readonly progress: IndexProgress;
  readonly retryAfterMs: number;
  /** A ready generation for another SHA, which is deliberately not used. */
  readonly staleIndex?: IndexIdentity;
}

export type FailureStage = "context" | "index" | "answer";

export interface FailedResponse extends ResponseBase {
  readonly status: "failed";
  readonly stage: FailureStage;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly buildId?: string;
  /** Present when Fast ran out of budget: Deep has a larger allowance. Never automatic. */
  readonly suggestedMode?: "deep";
  /** Budget dimension that ran out, when code is `budget_exhausted`. */
  readonly exhaustedLimit?: BudgetField;
  readonly usage?: UsageCounters;
}

/**
 * Why a request was refused before research for capacity reasons:
 * - busy: every question slot and queue place is taken, or the wait for one ran out.
 * - session_limit: this session already has its maximum of distinct questions in flight.
 * - fetching_revision: the requested commit is still being fetched to this host.
 */
export type UnavailableCode = "busy" | "session_limit" | "fetching_revision";

export interface UnavailableResponse extends ResponseBase {
  readonly status: "unavailable";
  readonly message: string;
  readonly retryable: true;
  /** Set when Looky refused the request for capacity or a pending fetch; absent for outages. */
  readonly code?: UnavailableCode;
  /** Suggested delay before retrying, when Looky can estimate one. */
  readonly retryAfterMs?: number;
}

export interface CancelledResponse extends ResponseBase {
  readonly status: "cancelled";
  readonly usage?: UsageCounters;
}

export interface TimedOutResponse extends ResponseBase {
  readonly status: "timed_out";
  readonly limitMs: number;
  readonly usage?: UsageCounters;
}

export type AskProjectResponse =
  | AnsweredResponse
  | InvalidRequestResponse
  | DeniedResponse
  | UnsupportedRevisionResponse
  | IndexingResponse
  | FailedResponse
  | UnavailableResponse
  | CancelledResponse
  | TimedOutResponse;

export type AskProjectStatus = AskProjectResponse["status"];
