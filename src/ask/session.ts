import type { BudgetField, ModeBudget } from "../contract/budgets";
import type { LookyRequestContext } from "../contract/context";
import type { Mode } from "../contract/input";
import type {
  AuthorizationDecision,
  ClientAdapter,
  ModelProvider,
  ModelRequest,
  ModelResult,
  ResearchSession,
  RetrievalHit,
  RetrievalOptions,
  Retriever,
  SourceRange,
  SourceReader,
  SourceText,
} from "../contract/ports";
import type { EvidenceRef, IndexIdentity, UsageCounters } from "../contract/response";

/** A mode budget dimension ran out. */
export class BudgetExhaustedError extends Error {
  override readonly name = "BudgetExhaustedError";
  constructor(readonly limit: BudgetField) {
    super(`Budget exhausted: ${limit}`);
  }
}

/** Authorization was withdrawn or the client generation went stale mid-request. */
export class AccessRevokedError extends Error {
  override readonly name = "AccessRevokedError";
  constructor(readonly decision: Extract<AuthorizationDecision, { allowed: false }>) {
    super(decision.message ?? `Access ${decision.reason}`);
  }
}

/** A port returned data that breaks the pinned-scope contract. */
export class ContractViolationError extends Error {
  override readonly name = "ContractViolationError";
}

/** The session was used after its request ended. */
export class SessionClosedError extends Error {
  override readonly name = "SessionClosedError";
}

/** Rough provider-neutral pre-call estimate: about four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith("/") || path.includes("\\") || path.includes("\0")) {
    return false;
  }
  return path.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function checkRange(range: SourceRange): void {
  if (!isSafeRelativePath(range.path)) {
    throw new ContractViolationError(`Invalid repository-relative path: ${range.path}`);
  }
  if (
    !Number.isSafeInteger(range.startLine) ||
    !Number.isSafeInteger(range.endLine) ||
    range.startLine < 1 ||
    range.endLine < range.startLine
  ) {
    throw new ContractViolationError(
      `Invalid line range ${range.path}:${range.startLine}-${range.endLine}`,
    );
  }
}

export interface GuardedSessionDeps {
  readonly question: string;
  readonly mode: Mode;
  readonly budget: ModeBudget;
  readonly signal: AbortSignal;
  readonly context: LookyRequestContext;
  readonly generation: IndexIdentity;
  readonly adapter: ClientAdapter;
  readonly retriever: Retriever;
  readonly sourceReader: SourceReader;
  readonly provider: ModelProvider;
  readonly now: () => number;
  readonly startedAt: number;
}

/**
 * The only tools an answer engine receives. Every call is pinned to the
 * request's repository, SHA and index generation, charged against the mode
 * budget, re-authorized, and refused once the request has ended.
 */
export class GuardedSession implements ResearchSession {
  readonly question: string;
  readonly mode: Mode;
  readonly budget: ModeBudget;
  readonly signal: AbortSignal;
  readonly generation: IndexIdentity;
  readonly repositoryId: string;

  readonly #deps: GuardedSessionDeps;
  readonly #reads: SourceText[] = [];
  /** Paths the pinned generation returned. Only these are indexed and eligible to read. */
  readonly #retrievedPaths = new Set<string>();
  readonly #providers: string[] = [];
  #closed = false;
  #retrievalPasses = 0;
  #sourceReads = 0;
  #sourceBytes = 0;
  #modelCalls = 0;
  #inputTokens = 0;
  #outputTokens = 0;

  constructor(deps: GuardedSessionDeps) {
    this.#deps = deps;
    this.question = deps.question;
    this.mode = deps.mode;
    this.budget = deps.budget;
    this.signal = deps.signal;
    this.generation = Object.freeze({ ...deps.generation });
    this.repositoryId = deps.context.repositoryId;
  }

  close(): void {
    this.#closed = true;
  }

  usage(): UsageCounters {
    return {
      retrievalPasses: this.#retrievalPasses,
      sourceReads: this.#sourceReads,
      sourceBytes: this.#sourceBytes,
      modelCalls: this.#modelCalls,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      elapsedMs: Math.max(0, this.#deps.now() - this.#deps.startedAt),
    };
  }

  /** Configured providers that served model calls, in first-use order. */
  providers(): readonly string[] {
    return [...this.#providers];
  }

  remaining(): ModeBudget {
    const b = this.budget;
    const elapsed = this.#deps.now() - this.#deps.startedAt;
    return {
      maxRetrievalPasses: b.maxRetrievalPasses - this.#retrievalPasses,
      maxResultsPerPass: b.maxResultsPerPass,
      maxSourceReads: b.maxSourceReads - this.#sourceReads,
      maxSourceBytes: b.maxSourceBytes - this.#sourceBytes,
      maxModelCalls: b.maxModelCalls - this.#modelCalls,
      maxInputTokens: Math.max(0, b.maxInputTokens - this.#inputTokens),
      maxOutputTokens: Math.max(0, b.maxOutputTokens - this.#outputTokens),
      maxAnswerChars: b.maxAnswerChars,
      maxElapsedMs: Math.max(0, b.maxElapsedMs - elapsed),
    };
  }

  /** True when the cited range lies within a range this session actually read. */
  wasRead(ref: EvidenceRef): boolean {
    return this.#reads.some(
      (read) =>
        read.path === ref.path && read.startLine <= ref.startLine && ref.endLine <= read.endLine,
    );
  }

  async retrieve(
    query: string,
    limit?: number,
    options?: RetrievalOptions,
  ): Promise<readonly RetrievalHit[]> {
    await this.#gate();
    if (typeof query !== "string" || query.trim().length === 0) {
      throw new ContractViolationError("Retrieval query must not be empty");
    }
    if (this.#retrievalPasses >= this.budget.maxRetrievalPasses) {
      throw new BudgetExhaustedError("maxRetrievalPasses");
    }
    const max = this.budget.maxResultsPerPass;
    const effectiveLimit =
      limit === undefined ? max : Math.max(1, Math.min(max, Math.floor(limit)));
    this.#retrievalPasses += 1;
    const hits = await this.#deps.retriever.search(
      {
        generation: this.generation,
        repositoryId: this.#deps.context.repositoryId,
        query,
        limit: effectiveLimit,
        ...(options ? { options } : {}),
      },
      this.signal,
    );
    this.#ensureOpen();
    if (hits.length > effectiveLimit) {
      throw new ContractViolationError(
        `Retriever returned ${hits.length} hits; limit was ${effectiveLimit}`,
      );
    }
    for (const hit of hits) {
      if (hit.generationId !== this.generation.generationId) {
        throw new ContractViolationError(
          `Retriever mixed index generations: ${hit.generationId} != ${this.generation.generationId}`,
        );
      }
      if (hit.sha !== undefined && hit.sha !== this.generation.sha) {
        throw new ContractViolationError(
          `Retriever returned a hit at ${hit.sha}, not the pinned ${this.generation.sha}`,
        );
      }
      if (hit.repositoryId !== undefined && hit.repositoryId !== this.repositoryId) {
        throw new ContractViolationError(
          `Retriever returned a hit from repository ${hit.repositoryId}, not ${this.repositoryId}`,
        );
      }
      checkRange(hit);
    }
    for (const hit of hits) this.#retrievedPaths.add(hit.path);
    return hits;
  }

  async read(range: SourceRange): Promise<SourceText> {
    await this.#gate();
    checkRange(range);
    // Excluded files (secrets, oversized, generated) and arbitrary paths are
    // never in the index, so a read must name a path retrieval returned.
    if (!this.#retrievedPaths.has(range.path)) {
      throw new ContractViolationError(
        `${range.path} was not returned by the pinned index generation and cannot be read`,
      );
    }
    if (this.#sourceReads >= this.budget.maxSourceReads) {
      throw new BudgetExhaustedError("maxSourceReads");
    }
    const maxBytes = this.budget.maxSourceBytes - this.#sourceBytes;
    if (maxBytes <= 0) throw new BudgetExhaustedError("maxSourceBytes");
    this.#sourceReads += 1;
    const result = await this.#deps.sourceReader.read(
      {
        repositoryId: this.#deps.context.repositoryId,
        sha: this.#deps.context.sha,
        path: range.path,
        startLine: range.startLine,
        endLine: range.endLine,
        maxBytes,
      },
      this.signal,
    );
    this.#ensureOpen();
    const bytes = Buffer.byteLength(result.text, "utf8");
    if (bytes > maxBytes) {
      throw new ContractViolationError(`Source reader returned ${bytes} bytes; limit ${maxBytes}`);
    }
    if (
      result.path !== range.path ||
      result.startLine !== range.startLine ||
      result.endLine < result.startLine ||
      result.endLine > range.endLine
    ) {
      throw new ContractViolationError(
        `Source reader returned a different range for ${range.path}`,
      );
    }
    this.#sourceBytes += bytes;
    const text = Object.freeze({ ...result });
    this.#reads.push(text);
    return text;
  }

  async model(request: ModelRequest): Promise<ModelResult> {
    await this.#gate();
    if (this.#modelCalls >= this.budget.maxModelCalls) {
      throw new BudgetExhaustedError("maxModelCalls");
    }
    const remainingOutput = this.budget.maxOutputTokens - this.#outputTokens;
    if (remainingOutput <= 0) throw new BudgetExhaustedError("maxOutputTokens");
    const remainingInput = this.budget.maxInputTokens - this.#inputTokens;
    if (estimateTokens(request.system + request.prompt) > remainingInput) {
      throw new BudgetExhaustedError("maxInputTokens");
    }
    const maxOutputTokens = Math.max(
      1,
      Math.min(Math.floor(request.maxOutputTokens), remainingOutput),
    );
    this.#modelCalls += 1;
    const result = await this.#deps.provider.complete({ ...request, maxOutputTokens }, this.signal);
    this.#ensureOpen();
    this.#inputTokens += result.inputTokens;
    this.#outputTokens += result.outputTokens;
    const servedBy = result.providerId ?? this.#deps.provider.id;
    if (!this.#providers.includes(servedBy)) this.#providers.push(servedBy);
    // Refuse provider output that overran the request's allowance.
    if (this.#inputTokens > this.budget.maxInputTokens) {
      throw new BudgetExhaustedError("maxInputTokens");
    }
    if (result.outputTokens > maxOutputTokens || this.#outputTokens > this.budget.maxOutputTokens) {
      throw new BudgetExhaustedError("maxOutputTokens");
    }
    return result;
  }

  #ensureOpen(): void {
    if (this.#closed) throw new SessionClosedError("Research session has ended");
    this.signal.throwIfAborted();
  }

  async #gate(): Promise<void> {
    this.#ensureOpen();
    const decision = await this.#deps.adapter.authorize(this.#deps.context, this.signal);
    this.#ensureOpen();
    if (!decision.allowed) throw new AccessRevokedError(decision);
  }
}
