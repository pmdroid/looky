import type { LookyAskConfig } from "../config";
import { tightenBudget, type ModeBudget } from "../contract/budgets";
import { checkContext, type LookyRequestContext } from "../contract/context";
import { DEFAULT_MODE, isMode, parseAskProjectInput, type Mode } from "../contract/input";
import {
  isPolicyAwareProvider,
  LookyUnavailableError,
  ProviderConfigError,
  type AnswerEngine,
  type ClientAdapter,
  type EngineAnswer,
  type IndexCatalog,
  type ModelProvider,
  type Retriever,
  type SourceReader,
} from "../contract/ports";
import {
  ANSWER_OUTCOMES,
  type AnsweredResponse,
  type AskProjectResponse,
  type EvidenceRef,
  type FailureStage,
  type IndexIdentity,
  type ModeReport,
  type RevisionIdentity,
  type SourceScope,
} from "../contract/response";
import {
  AccessRevokedError,
  BudgetExhaustedError,
  ContractViolationError,
  GuardedSession,
} from "./session";

export interface AskProjectServices {
  readonly config: LookyAskConfig;
  readonly catalog: IndexCatalog;
  readonly retriever: Retriever;
  readonly sourceReader: SourceReader;
  readonly provider: ModelProvider;
  readonly engine: AnswerEngine;
  readonly now?: () => number;
  readonly newRequestId?: () => string;
}

export interface AskProjectOptions {
  /** Caller cancellation, such as the MCP request being cancelled. */
  readonly signal?: AbortSignal;
}

class TimeoutReason extends Error {
  override readonly name = "TimeoutReason";
}

/**
 * Handle one `ask_project` call.
 *
 * `rawArgs` are untrusted tool arguments. Repository, SHA, caller and client
 * scope come only from `adapter.resolveContext`. The SHA and index generation
 * are resolved once and pinned for the whole request; the response never
 * mixes revisions, substitutes another revision, or fabricates an answer.
 */
export async function askProject(
  rawArgs: unknown,
  adapter: ClientAdapter,
  services: AskProjectServices,
  options: AskProjectOptions = {},
): Promise<AskProjectResponse> {
  const now = services.now ?? Date.now;
  const requestId = services.newRequestId ? services.newRequestId() : crypto.randomUUID();
  const startedAt = now();

  const parsed = parseAskProjectInput(rawArgs, {
    maxQuestionChars: services.config.maxQuestionChars,
  });
  if (!parsed.ok) {
    const requestedMode = requestedModeOf(rawArgs);
    return {
      status: "invalid_request",
      requestId,
      mode: { requested: requestedMode, executed: null },
      limitations: [],
      error: { code: parsed.code, message: parsed.message },
    };
  }
  const { question, mode } = parsed.input;
  const budget = tightenBudget(services.config.budgets[mode], adapter.budgetLimits?.[mode]);

  // One deadline covers context resolution, index lookup, research and delivery.
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new TimeoutReason(`ask_project exceeded ${budget.maxElapsedMs}ms`)),
    budget.maxElapsedMs,
  );
  const signals = [timeout.signal];
  if (options.signal) signals.push(options.signal);
  const signal = AbortSignal.any(signals);

  const notRun: ModeReport = { requested: mode, executed: null };
  const ran: ModeReport = { requested: mode, executed: mode };
  let session: GuardedSession | undefined;
  let stage: FailureStage = "context";

  try {
    const context = await raceAbort(adapter.resolveContext(signal), signal);
    const problem = checkContext(context);
    if (problem?.kind === "invalid_context") {
      return denied(requestId, notRun, "invalid_context", problem.message);
    }
    if (problem?.kind === "unsupported_revision") {
      return {
        status: "unsupported_revision",
        requestId,
        mode: notRun,
        limitations: [problem.message],
        message: problem.message,
      };
    }

    const revision = revisionOf(context);
    const decision = await raceAbort(adapter.authorize(context, signal), signal);
    if (!decision.allowed) {
      return denied(
        requestId,
        notRun,
        decision.reason,
        decision.message ?? defaultDenial(decision.reason),
      );
    }

    stage = "index";
    const resolution = await raceAbort(
      services.catalog.resolve({ repositoryId: context.repositoryId, sha: context.sha }, signal),
      signal,
    );
    switch (resolution.state) {
      case "unsupported_revision":
        return {
          status: "unsupported_revision",
          requestId,
          mode: notRun,
          limitations: [resolution.message],
          message: resolution.message,
          revision,
        };
      case "building":
        return {
          status: "indexing",
          requestId,
          mode: notRun,
          limitations: indexingLimitations(context, resolution.staleGeneration),
          revision,
          buildId: resolution.buildId,
          progress: resolution.progress,
          retryAfterMs: services.config.indexRetryAfterMs,
          ...(resolution.staleGeneration ? { staleIndex: resolution.staleGeneration } : {}),
        };
      case "failed":
        return {
          status: "failed",
          requestId,
          mode: notRun,
          limitations: [],
          stage: "index",
          code: "index_failed",
          message: resolution.message,
          retryable: resolution.retryable,
          buildId: resolution.buildId,
        };
      case "ready":
        break;
    }
    const generation = resolution.generation;
    if (generation.sha !== context.sha) {
      throw new ContractViolationError(
        `Index catalog returned generation ${generation.generationId} for ${generation.sha}, ` +
          `not the pinned ${context.sha}`,
      );
    }

    stage = "answer";
    const provider = providerFor(services.provider, adapter);
    session = new GuardedSession({
      question,
      mode,
      budget,
      signal,
      context,
      generation,
      adapter,
      retriever: services.retriever,
      sourceReader: services.sourceReader,
      provider,
      now,
      startedAt,
    });
    const engineAnswer = await raceAbort(services.engine.answer(session), signal);
    session.close();
    const answer = validateAnswer(engineAnswer, session, mode, budget);

    // Delivery is the last access: a revoked or stale session receives nothing.
    const delivery = await raceAbort(adapter.authorize(context, signal), signal);
    if (!delivery.allowed) throw new AccessRevokedError(delivery);
    signal.throwIfAborted();

    const response: AnsweredResponse = {
      status: "answered",
      requestId,
      mode: ran,
      limitations: scopeLimitations(context),
      answer: {
        text: answer.text,
        outcome: answer.outcome,
        caveats: [...(answer.caveats ?? [])],
      },
      evidence: answer.evidence.map((ref) => ({ ...ref })),
      revision,
      index: { generationId: generation.generationId, sha: generation.sha },
      scope: scopeOf(context),
      usage: session.usage(),
      providers: session.providers(),
      ...(mode === "fast" && answer.suggestDeep ? { suggestedMode: "deep" as const } : {}),
      ...(answer.suggestedHumanQuestion
        ? { suggestedHumanQuestion: { ...answer.suggestedHumanQuestion } }
        : {}),
    };
    return response;
  } catch (error) {
    session?.close();
    const executed = session ? ran : notRun;
    const usage = session ? { usage: session.usage() } : {};
    if (timeout.signal.aborted) {
      return {
        status: "timed_out",
        requestId,
        mode: executed,
        limitations: [],
        limitMs: budget.maxElapsedMs,
        ...usage,
      };
    }
    if (options.signal?.aborted) {
      return { status: "cancelled", requestId, mode: executed, limitations: [], ...usage };
    }
    if (error instanceof AccessRevokedError) {
      return denied(requestId, executed, error.decision.reason, error.message);
    }
    if (error instanceof LookyUnavailableError) {
      return {
        status: "unavailable",
        requestId,
        mode: executed,
        limitations: [],
        message: error.message,
        retryable: true,
      };
    }
    if (error instanceof BudgetExhaustedError) {
      return {
        status: "failed",
        requestId,
        mode: executed,
        limitations: [
          `The ${mode} budget limit ${error.limit} was reached before an answer was produced.`,
        ],
        stage: "answer",
        code: "budget_exhausted",
        message: error.message,
        retryable: mode === "fast",
        exhaustedLimit: error.limit,
        ...(mode === "fast" ? { suggestedMode: "deep" as const } : {}),
        ...usage,
      };
    }
    if (error instanceof ProviderConfigError) {
      return {
        status: "failed",
        requestId,
        mode: executed,
        limitations: [],
        stage,
        code: "provider_not_configured",
        message: error.message,
        retryable: false,
        ...usage,
      };
    }
    return {
      status: "failed",
      requestId,
      mode: executed,
      limitations: [],
      stage,
      code: error instanceof ContractViolationError ? "contract_violation" : "internal_error",
      message: error instanceof Error ? error.message : String(error),
      retryable: false,
      ...usage,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Apply the client's provider policy. A policy is a selection among providers
 * Looky configured; a provider that cannot honor one fails closed rather than
 * silently ignoring the client's choice.
 */
function providerFor(provider: ModelProvider, adapter: ClientAdapter): ModelProvider {
  const policy = adapter.providerPolicy;
  if (policy === undefined) return provider;
  if (!isPolicyAwareProvider(provider)) {
    throw new ProviderConfigError(
      `The client selected provider ${policy.selected}, but provider ${provider.id} does not ` +
        "support provider selection",
    );
  }
  return provider.withPolicy(policy);
}

function requestedModeOf(rawArgs: unknown): Mode {
  if (typeof rawArgs === "object" && rawArgs !== null && "mode" in rawArgs) {
    const mode = (rawArgs as { mode: unknown }).mode;
    if (isMode(mode)) return mode;
  }
  return DEFAULT_MODE;
}

function denied(
  requestId: string,
  mode: ModeReport,
  reason: "unauthorized" | "revoked" | "stale_session" | "invalid_context",
  message: string,
): AskProjectResponse {
  return { status: "denied", requestId, mode, limitations: [], reason, message };
}

function defaultDenial(reason: string): string {
  return `Access denied: ${reason}`;
}

/** Resolve or reject with the signal's reason, so a hung port cannot outlive the request. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function revisionOf(context: LookyRequestContext): RevisionIdentity {
  return {
    repositoryId: context.repositoryId,
    sha: context.sha,
    ...(context.snapshotId !== undefined ? { snapshotId: context.snapshotId } : {}),
    ...(context.ref !== undefined ? { ref: context.ref } : {}),
  };
}

function scopeOf(context: LookyRequestContext): SourceScope {
  const uncommittedChanges =
    context.worktree.state === "clean"
      ? "none"
      : context.worktree.state === "dirty"
        ? "excluded"
        : "unknown";
  return { source: "committed", sha: context.sha, uncommittedChanges };
}

function scopeLimitations(context: LookyRequestContext): string[] {
  const limitations: string[] = [];
  const short = context.sha.slice(0, 12);
  if (context.worktree.state === "dirty") {
    const count = context.worktree.changedPaths;
    limitations.push(
      `Uncommitted worktree changes${count === undefined ? "" : ` (${count} paths)`} were ` +
        `excluded. This answer covers only commit ${short}.`,
    );
  } else if (context.worktree.state === "unknown") {
    limitations.push(
      `Worktree state is unknown. This answer covers only commit ${short}; any uncommitted ` +
        "changes were not read.",
    );
  }
  if (context.ref !== undefined) {
    limitations.push(
      `Pinned to ${short}, resolved from ${context.ref} when the request started. Later movement ` +
        `of ${context.ref} is not reflected.`,
    );
  }
  return limitations;
}

function indexingLimitations(
  context: LookyRequestContext,
  stale: IndexIdentity | undefined,
): string[] {
  const limitations = [
    `No ready index exists for commit ${context.sha.slice(0, 12)} yet. No answer was produced.`,
  ];
  if (stale) {
    limitations.push(
      `An index for a different commit ${stale.sha.slice(0, 12)} exists but is stale for this ` +
        "request and was not used.",
    );
  }
  return limitations;
}

/** Strip fenced code blocks and quoted snippet lines, leaving the explanatory prose. */
function proseOf(text: string): string {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .split("\n")
    .filter((line) => !/^\s*(?:>|\d+[:|]\s)/.test(line))
    .join(" ")
    .trim();
}

function validEvidenceRef(ref: EvidenceRef): boolean {
  return (
    typeof ref.path === "string" &&
    Number.isSafeInteger(ref.startLine) &&
    Number.isSafeInteger(ref.endLine) &&
    ref.startLine >= 1 &&
    ref.endLine >= ref.startLine
  );
}

/**
 * Enforce the answer contract: complete prose distinct from evidence, a
 * truthful outcome, citations limited to ranges actually read at the pinned
 * revision, mode-specific suggestions and the answer length budget.
 */
function validateAnswer(
  answer: EngineAnswer,
  session: GuardedSession,
  mode: Mode,
  budget: ModeBudget,
): EngineAnswer {
  if (!(ANSWER_OUTCOMES as readonly string[]).includes(answer.outcome)) {
    throw new ContractViolationError(`Unknown answer outcome: ${String(answer.outcome)}`);
  }
  const text = typeof answer.text === "string" ? answer.text.trim() : "";
  if (text.length === 0) throw new ContractViolationError("Answer text is empty");
  // Snippets alone are not an answer: require a sentence of explanatory prose.
  if (!/[A-Za-z]{2,}[^.!?]*[.!?]/.test(proseOf(text))) {
    throw new ContractViolationError(
      "Answer text has no explanatory prose; code snippets alone are not an answer",
    );
  }
  if (text.length > budget.maxAnswerChars) throw new BudgetExhaustedError("maxAnswerChars");
  if (!Array.isArray(answer.evidence)) throw new ContractViolationError("Evidence must be a list");
  for (const ref of answer.evidence) {
    if (!validEvidenceRef(ref)) throw new ContractViolationError("Malformed evidence reference");
    if (!session.wasRead(ref)) {
      throw new ContractViolationError(
        `Evidence ${ref.path}:${ref.startLine}-${ref.endLine} was not read at the pinned revision`,
      );
    }
  }
  if (answer.outcome !== "unknown" && answer.evidence.length === 0) {
    throw new ContractViolationError(`A ${answer.outcome} answer requires supporting evidence`);
  }
  if (answer.suggestDeep && mode !== "fast") {
    throw new ContractViolationError("Only Fast answers may suggest Deep");
  }
  const human = answer.suggestedHumanQuestion;
  if (
    human !== undefined &&
    (typeof human.question !== "string" ||
      human.question.trim().length === 0 ||
      typeof human.reason !== "string")
  ) {
    throw new ContractViolationError("Malformed suggested human question");
  }
  return { ...answer, text };
}
