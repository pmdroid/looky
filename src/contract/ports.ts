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
import type { AnswerOutcome, EvidenceRef, IndexIdentity, IndexProgress } from "./response";

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

export interface RetrievalHit {
  readonly generationId: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly symbol?: string;
  readonly score: number;
  /** Indexed chunk text. Evidence for the engine, never delivered as the answer. */
  readonly preview: string;
}

export interface Retriever {
  search(
    request: {
      readonly generation: IndexIdentity;
      readonly repositoryId: string;
      readonly query: string;
      readonly limit: number;
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
}

/** Selected model provider. Throw {@link LookyUnavailableError} when it cannot serve. */
export interface ModelProvider {
  readonly id: string;
  complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
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
  retrieve(query: string, limit?: number): Promise<readonly RetrievalHit[]>;
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
