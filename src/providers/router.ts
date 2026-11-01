/**
 * Provider selection, fallback and per-provider quotas.
 *
 * A {@link ProviderRouter} holds the providers Looky is configured with. Every
 * call tries the selected provider first and moves to a fallback only when the
 * selected one cannot serve: its local quota is spent, it reported a quota or
 * rate limit, or it is unavailable. A fallback is never consulted while the
 * selected provider works, so an unused provider's exhausted quota can never
 * block an answer. Cancellation is never retried on another provider.
 */
import { estimateTokens } from "../ask/session";
import {
  LookyUnavailableError,
  ProviderConfigError,
  ProviderQuotaError,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
  type PolicyAwareProvider,
  type ProviderPolicy,
} from "../contract/ports";

/** Local usage limits for one provider over a rolling one-minute window. */
export interface ProviderQuota {
  readonly maxRequestsPerMinute?: number;
  /** Input plus output tokens. Calls are admitted on their worst case before they run. */
  readonly maxTokensPerMinute?: number;
}

export interface ProviderEntry {
  readonly provider: ModelProvider;
  readonly quota?: ProviderQuota;
}

export interface ProviderRouterOptions {
  readonly providers: readonly (ProviderEntry | ModelProvider)[];
  readonly policy: ProviderPolicy;
  readonly now?: () => number;
  /** Cooldown after a quota error that gave no retry hint. Default one minute. */
  readonly defaultCooldownMs?: number;
}

const WINDOW_MS = 60_000;
const DEFAULT_COOLDOWN_MS = 60_000;

interface ProviderState {
  readonly entry: ProviderEntry;
  /** Admitted calls in the window: time and admitted token cost. */
  readonly calls: { at: number; tokens: number }[];
  cooldownUntil: number;
}

/** Why one provider did not serve a call, for the final unavailable message. */
interface Attempt {
  readonly id: string;
  readonly reason: string;
}

function entryOf(item: ProviderEntry | ModelProvider): ProviderEntry {
  return "provider" in item ? item : { provider: item };
}

function checkQuota(id: string, quota: ProviderQuota | undefined): void {
  for (const field of ["maxRequestsPerMinute", "maxTokensPerMinute"] as const) {
    const value = quota?.[field];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw new ProviderConfigError(`Provider ${id} ${field} must be a positive integer`);
    }
  }
}

export class ProviderRouter implements PolicyAwareProvider {
  readonly id: string;
  readonly #states: ReadonlyMap<string, ProviderState>;
  readonly #order: readonly string[];
  readonly #now: () => number;
  readonly #defaultCooldownMs: number;

  constructor(options: ProviderRouterOptions) {
    const states = new Map<string, ProviderState>();
    for (const item of options.providers) {
      const entry = entryOf(item);
      const id = entry.provider.id;
      if (typeof id !== "string" || id.length === 0) {
        throw new ProviderConfigError("Every provider needs an id");
      }
      if (states.has(id)) throw new ProviderConfigError(`Provider ${id} is configured twice`);
      checkQuota(id, entry.quota);
      states.set(id, { entry, calls: [], cooldownUntil: 0 });
    }
    this.#states = states;
    this.#now = options.now ?? Date.now;
    this.#defaultCooldownMs = options.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.#order = this.#resolve(options.policy);
    this.id = this.#order[0]!;
  }

  /** Configured provider ids. */
  get providerIds(): readonly string[] {
    return [...this.#states.keys()];
  }

  /** Provider order for this router: selected first, then fallbacks. */
  get order(): readonly string[] {
    return this.#order;
  }

  /**
   * A view of the same providers and quota state with a client's policy. The
   * policy may only name configured providers.
   */
  withPolicy(policy: ProviderPolicy): ModelProvider {
    return this.#view(policy);
  }

  async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
    return this.#complete(this.#order, request, signal);
  }

  #view(policy: ProviderPolicy): ModelProvider {
    const order = this.#resolve(policy);
    return {
      id: order[0]!,
      complete: (request, signal) => this.#complete(order, request, signal),
    };
  }

  #resolve(policy: ProviderPolicy): readonly string[] {
    if (typeof policy?.selected !== "string" || policy.selected.length === 0) {
      throw new ProviderConfigError("A provider policy must select a provider");
    }
    const order = [policy.selected, ...(policy.fallback ?? [])];
    for (const id of order) {
      if (!this.#states.has(id)) {
        throw new ProviderConfigError(`Provider ${id} is not configured in Looky`);
      }
    }
    if (new Set(order).size !== order.length) {
      throw new ProviderConfigError("A provider may appear only once in a policy");
    }
    return order;
  }

  async #complete(
    order: readonly string[],
    request: ModelRequest,
    signal: AbortSignal,
  ): Promise<ModelResult> {
    const attempts: Attempt[] = [];
    const cost = estimateTokens(request.system + request.prompt) + request.maxOutputTokens;
    for (const id of order) {
      signal.throwIfAborted();
      const state = this.#states.get(id)!;
      const admitted = this.#admit(state, cost);
      if (typeof admitted === "string") {
        attempts.push({ id, reason: admitted });
        continue;
      }
      try {
        const result = await state.entry.provider.complete(request, signal);
        // Charge the quota with what the provider reported, not the worst case.
        admitted.tokens = result.inputTokens + result.outputTokens;
        return { ...result, providerId: id };
      } catch (error) {
        // Cancellation and timeouts belong to the request, not the provider.
        if (signal.aborted) throw error;
        if (error instanceof ProviderQuotaError) {
          state.cooldownUntil = this.#now() + (error.retryAfterMs ?? this.#defaultCooldownMs);
          attempts.push({ id, reason: `quota exhausted (${error.message})` });
          continue;
        }
        if (error instanceof LookyUnavailableError) {
          attempts.push({ id, reason: `unavailable (${error.message})` });
          continue;
        }
        throw error;
      }
    }
    const tried = attempts.map((attempt) => `${attempt.id}: ${attempt.reason}`).join("; ");
    const allQuota = attempts.every((attempt) => attempt.reason.startsWith("quota"));
    const message = `No configured model provider could serve the request. ${tried}`;
    throw allQuota
      ? new ProviderQuotaError(order[0]!, message, this.#retryAfter(order))
      : new LookyUnavailableError(message);
  }

  /** Admit a call against the provider's local quota and cooldown, or say why not. */
  #admit(state: ProviderState, cost: number): { at: number; tokens: number } | string {
    const now = this.#now();
    if (state.cooldownUntil > now) {
      return `quota exhausted, cooling down for ${state.cooldownUntil - now}ms`;
    }
    while (state.calls.length > 0 && state.calls[0]!.at <= now - WINDOW_MS) state.calls.shift();
    const quota = state.entry.quota;
    if (quota?.maxRequestsPerMinute !== undefined) {
      if (state.calls.length >= quota.maxRequestsPerMinute) {
        return "quota exhausted: maxRequestsPerMinute";
      }
    }
    if (quota?.maxTokensPerMinute !== undefined) {
      const used = state.calls.reduce((sum, call) => sum + call.tokens, 0);
      if (used + cost > quota.maxTokensPerMinute) return "quota exhausted: maxTokensPerMinute";
    }
    const call = { at: now, tokens: cost };
    state.calls.push(call);
    return call;
  }

  #retryAfter(order: readonly string[]): number | undefined {
    const now = this.#now();
    const waits = order
      .map((id) => this.#states.get(id)!.cooldownUntil - now)
      .filter((wait) => wait > 0);
    return waits.length > 0 ? Math.min(...waits) : undefined;
  }
}
