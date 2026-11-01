/**
 * Adapter boundary between Looky's ask_project contract and the parts that
 * implement it. Clients (Paws first) implement {@link ClientAdapter}. Looky's
 * index, retrieval and answer engine implement the other ports. Engines only
 * ever see the guarded {@link ResearchSession}, which pins repository, SHA and
 * index generation and enforces the mode budget.
 */

import type { BudgetOverrides, ModeBudget } from "./budgets";
import type { LookyRequestContext } from "./context";
import type { Mode } from "./input";
import type {
  AnswerOutcome,
  EvidenceRef,
  IndexIdentity,
  IndexProgress,
  SuggestedHumanQuestion,
} from "./response";

// ---------------------------------------------------------------------------
// Client adapter

export type AuthorizationDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: "unauthorized" | "revoked" | "stale_session";
      readonly message?: string;
    };

export interface ClientAdapter {
  /**
   * Derive the trusted context from the client's authenticated session, such
   * as a Paws workspace and task/run generation. Must not read tool arguments.
   * The SHA is resolved here once and never re-resolved during the request.
   */
  resolveContext(signal: AbortSignal): Promise<LookyRequestContext>;
  /**
   * Confirm the context is still authorized and its client generation is
   * current. Looky calls this before the request starts, before every
   * retrieval and source read, and again before delivery.
   */
  authorize(context: LookyRequestContext, signal: AbortSignal): Promise<AuthorizationDecision>;
  /** Optional limits that can only tighten Looky's configured budgets. */
  readonly budgetLimits?: BudgetOverrides;
  /**
   * Optional provider choice for this client, such as Paws' existing provider
   * policy. It selects among providers Looky has configured; it can never add
   * a provider, credentials or an endpoint.
   */
  readonly providerPolicy?: ProviderPolicy;
}

/** Which configured provider serves model calls, and which may stand in when it cannot. */
export interface ProviderPolicy {
  /** Configured provider id tried first for every call. */
  readonly selected: string;
  /** Configured provider ids tried in order only when the selected one cannot serve. */
  readonly fallback?: readonly string[];
}

// ---------------------------------------------------------------------------
// Index catalog

export type IndexResolution =
  | { readonly state: "ready"; readonly generation: IndexIdentity }
  | {
      readonly state: "building";
      readonly buildId: string;
      readonly progress: IndexProgress;
      /** A ready generation for a different SHA that must not be used for this request. */
      readonly staleGeneration?: IndexIdentity;
    }
  | {
      readonly state: "failed";
      readonly buildId: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | { readonly state: "unsupported_revision"; readonly message: string };

export interface IndexCatalog {
  /**
   * Return the published generation for exactly this repository and SHA, or
   * start/join a scoped build and report it. Never substitutes another SHA.
   */
  resolve(
    scope: { readonly repositoryId: string; readonly sha: string },
    signal: AbortSignal,
  ): Promise<IndexResolution>;
}

// ---------------------------------------------------------------------------
// Retrieval, source access and model provider

/** What role an indexed file plays, derived from its path and language. */
export const EVIDENCE_KINDS = ["code", "test", "config", "docs"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** How a hit was found, for observability and ranking explanations. */
export type MatchChannel = "path" | "symbol" | "definition" | "reference" | "text";

export interface RetrievalHit {
  readonly generationId: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
  readonly score: number;
  /**
   * Indexed chunk text: exactly lines `startLine..endLine` at the pinned SHA.
   * Evidence for the engine, never delivered as the answer.
   */
  readonly preview: string;
  /** Repository and SHA of the generation. When present they must match the pinned request. */
  readonly repositoryId?: string;
  readonly sha?: string;
  /** SHA-256 of `preview`, the indexed chunk's content identity. */
  readonly contentHash?: string;
  /** Git blob id of the file at the pinned SHA. */
  readonly blobOid?: string;
  readonly kind?: EvidenceKind;
  readonly language?: string;
  /** Declarations recorded for the chunk. */
  readonly symbols?: readonly string[];
  readonly matchedBy?: readonly MatchChannel[];
}

/** Structured narrowing for one retrieval pass. All filters apply within the pinned generation. */
export interface RetrievalOptions {
  /** Only files of these kinds. */
  readonly kinds?: readonly EvidenceKind[];
  /** Only chunks that define this identifier, in any common spelling. */
  readonly definitionOf?: string;
  /** Only chunks that mention this identifier without defining it. */
  readonly referencesOf?: string;
  /** Only this path or paths under this directory. */
  readonly pathPrefix?: string;
  /** Never return these paths. */
  readonly excludePaths?: readonly string[];
}

export interface Retriever {
  search(
    request: {
      readonly generation: IndexIdentity;
      readonly repositoryId: string;
      readonly query: string;
      readonly limit: number;
      readonly options?: RetrievalOptions;
    },
    signal: AbortSignal,
  ): Promise<readonly RetrievalHit[]>;
}

export interface SourceRange {
  readonly path: string;
  /** 1-based inclusive. */
  readonly startLine: number;
  readonly endLine: number;
}

export interface SourceText {
  readonly path: string;
  readonly startLine: number;
  /** Actual last line returned; may be below the requested end at end of file. */
  readonly endLine: number;
  readonly text: string;
}

/** Scoped committed-source access. Reads Git objects at a SHA, never a worktree. */
export interface SourceReader {
  read(
    request: SourceRange & {
      readonly repositoryId: string;
      readonly sha: string;
      readonly maxBytes: number;
    },
    signal: AbortSignal,
  ): Promise<SourceText>;
}

export interface ModelRequest {
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens: number;
}

export interface ModelResult {
  readonly text: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Configured provider that actually served the call, when routed. */
  readonly providerId?: string;
}

/**
 * Selected model provider. Throw {@link LookyUnavailableError} when it cannot
 * serve, or {@link ProviderQuotaError} when its quota or rate limit is spent.
 */
export interface ModelProvider {
  readonly id: string;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
}

/** A provider that can apply a client's {@link ProviderPolicy} for one request. */
export interface PolicyAwareProvider extends ModelProvider {
  /** Throws {@link ProviderConfigError} when the policy names a provider that is not configured. */
  withPolicy(policy: ProviderPolicy): ModelProvider;
}

export function isPolicyAwareProvider(provider: ModelProvider): provider is PolicyAwareProvider {
  return typeof (provider as Partial<PolicyAwareProvider>).withPolicy === "function";
}

// ---------------------------------------------------------------------------
// Answer engine

/** Guarded tools for one request. All calls are pinned, budgeted and authorized. */
export interface ResearchSession {
  readonly question: string;
  readonly mode: Mode;
  readonly budget: ModeBudget;
  readonly signal: AbortSignal;
  readonly generation: IndexIdentity;
  /** The authorized repository every call is pinned to. */
  readonly repositoryId: string;
  retrieve(
    query: string,
    limit?: number,
    options?: RetrievalOptions,
  ): Promise<readonly RetrievalHit[]>;
  read(range: SourceRange): Promise<SourceText>;
  model(request: ModelRequest): Promise<ModelResult>;
  /** Remaining allowance per budget dimension. */
  remaining(): ModeBudget;
}

export interface EngineAnswer {
  readonly text: string;
  readonly outcome: AnswerOutcome;
  readonly evidence: readonly EvidenceRef[];
  readonly caveats?: readonly string[];
  /** Fast only: the engine believes Deep could establish more. */
  readonly suggestDeep?: boolean;
  /**
   * A question only people can answer, such as missing design intent. Returned
   * to the caller as data (for example for Paws ask_team), never posted.
   */
  readonly suggestedHumanQuestion?: SuggestedHumanQuestion;
}

/** Runs the mode-specific research and synthesis using only the session tools. */
export interface AnswerEngine {
  answer(session: ResearchSession): Promise<EngineAnswer>;
}

// ---------------------------------------------------------------------------
// Typed errors that ports may throw

/** A dependency (provider, index store, source access) cannot serve right now. */
export class LookyUnavailableError extends Error {
  override readonly name = "LookyUnavailableError";
}

/** A provider's quota or rate limit is spent. Another configured provider may still serve. */
export class ProviderQuotaError extends LookyUnavailableError {
  constructor(
    readonly providerId: string,
    message: string,
    /** How long the provider asked callers to wait, when it said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}

/** A provider policy or provider configuration is invalid. Not retryable. */
export class ProviderConfigError extends Error {
  override readonly name = "ProviderConfigError";
}
