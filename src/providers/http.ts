/**
 * HTTP model providers. Two wire formats cover most deployments:
 *
 * - `openai`: an OpenAI-compatible `POST {baseUrl}/chat/completions`, also
 *   served by many hosted and local model servers.
 * - `anthropic`: the Anthropic Messages API, `POST {baseUrl}/v1/messages`.
 *
 * Neither is required. Errors are typed so the router can fall back: quota and
 * rate limits throw {@link ProviderQuotaError}, outages, timeouts and rejected
 * credentials throw {@link LookyUnavailableError}. Error messages carry the
 * status and the provider's error type, never credentials or response bodies.
 */
import { estimateTokens } from "../ask/session";
import {
  LookyUnavailableError,
  ProviderConfigError,
  ProviderQuotaError,
  type ModelProvider,
  type ModelRequest,
  type ModelResult,
} from "../contract/ports";

export const PROVIDER_KINDS = ["openai", "anthropic"] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export const DEFAULT_BASE_URLS: Readonly<Record<ProviderKind, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
};

export const DEFAULT_PROVIDER_TIMEOUT_MS = 60_000;
/** Cooldown after a provider reports its quota, not just its rate, is spent. */
const QUOTA_COOLDOWN_MS = 15 * 60_000;
const ANTHROPIC_VERSION = "2023-06-01";

export interface HttpProviderOptions {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly model: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  /** Per-call timeout; the request's own deadline still applies. */
  readonly timeoutMs?: number;
  /** OpenAI only: the output limit field, `max_tokens` (default) or `max_completion_tokens`. */
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
  readonly fetch?: typeof fetch;
}

class ProviderTimeout extends Error {
  override readonly name = "ProviderTimeout";
}

/** Create one HTTP provider from explicit options. */
export function createHttpProvider(options: HttpProviderOptions): ModelProvider {
  if (!(PROVIDER_KINDS as readonly string[]).includes(options.kind)) {
    throw new ProviderConfigError(`Provider ${options.id} has unknown kind ${options.kind}`);
  }
  if (options.model.trim().length === 0) {
    throw new ProviderConfigError(`Provider ${options.id} needs a model`);
  }
  const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URLS[options.kind]).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(
      options.kind === "openai" ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/messages`,
    );
  } catch {
    throw new ProviderConfigError(`Provider ${options.id} has an invalid base URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ProviderConfigError(`Provider ${options.id} base URL must be http or https`);
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  const doFetch = options.fetch ?? fetch;

  return {
    id: options.id,
    async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new ProviderTimeout(`after ${timeoutMs}ms`)),
        timeoutMs,
      );
      const combined = AbortSignal.any([signal, timeout.signal]);
      let response: Response;
      let text: string;
      try {
        response = await doFetch(url, {
          method: "POST",
          headers: headersFor(options),
          body: JSON.stringify(bodyFor(options, request)),
          signal: combined,
          redirect: "error",
        });
        text = await response.text();
      } catch (error) {
        if (signal.aborted) throw signal.reason ?? error;
        if (timeout.signal.aborted) {
          throw new LookyUnavailableError(`Provider ${options.id} timed out after ${timeoutMs}ms`);
        }
        if (error instanceof LookyUnavailableError) throw error;
        throw new LookyUnavailableError(
          `Provider ${options.id} request failed: ${error instanceof Error ? error.name : "error"}`,
        );
      } finally {
        clearTimeout(timer);
      }
      // Outside the network handler, so a rejected request is not mistaken for an outage.
      return parseResponse(options, request, response, text);
    },
  };
}

function headersFor(options: HttpProviderOptions): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.kind === "anthropic") {
    headers["anthropic-version"] = ANTHROPIC_VERSION;
    if (options.apiKey) headers["x-api-key"] = options.apiKey;
  } else if (options.apiKey) {
    headers.authorization = `Bearer ${options.apiKey}`;
  }
  return headers;
}

function bodyFor(options: HttpProviderOptions, request: ModelRequest): Record<string, unknown> {
  if (options.kind === "anthropic") {
    return {
      model: options.model,
      max_tokens: request.maxOutputTokens,
      system: request.system,
      messages: [{ role: "user", content: request.prompt }],
    };
  }
  return {
    model: options.model,
    [options.maxTokensField ?? "max_tokens"]: request.maxOutputTokens,
    messages: [
      { role: "system", content: request.system },
      { role: "user", content: request.prompt },
    ],
  };
}

function errorType(body: unknown): string | undefined {
  const error = (body as { error?: unknown } | undefined)?.error;
  if (typeof error === "string") return error.slice(0, 80);
  if (typeof error === "object" && error !== null) {
    const record = error as { type?: unknown; code?: unknown };
    for (const value of [record.code, record.type]) {
      if (typeof value === "string" && /^[\w.-]{1,80}$/.test(value)) return value;
    }
  }
  return undefined;
}

function retryAfterMs(response: Response): number | undefined {
  const raw = response.headers.get("retry-after");
  if (raw === null) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function tryJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function parseResponse(
  options: HttpProviderOptions,
  request: ModelRequest,
  response: Response,
  text: string,
): ModelResult {
  const body = tryJson(text);
  const id = options.id;
  if (!response.ok) {
    const type = errorType(body);
    const detail = `HTTP ${response.status}${type ? ` ${type}` : ""}`;
    if (response.status === 429) {
      const quotaSpent = type === "insufficient_quota" || type === "billing_error";
      throw new ProviderQuotaError(
        id,
        `Provider ${id} quota or rate limit reached (${detail})`,
        retryAfterMs(response) ?? (quotaSpent ? QUOTA_COOLDOWN_MS : undefined),
      );
    }
    if (response.status === 402) {
      throw new ProviderQuotaError(id, `Provider ${id} quota spent (${detail})`, QUOTA_COOLDOWN_MS);
    }
    if (
      response.status === 401 ||
      response.status === 403 ||
      response.status === 408 ||
      response.status >= 500
    ) {
      throw new LookyUnavailableError(`Provider ${id} cannot serve right now (${detail})`);
    }
    throw new Error(`Provider ${id} rejected the request (${detail})`);
  }

  let output: string | undefined;
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;
  if (options.kind === "anthropic") {
    const record = body as {
      content?: { type?: unknown; text?: unknown }[];
      usage?: { input_tokens?: unknown; output_tokens?: unknown };
    };
    if (Array.isArray(record?.content)) {
      output = record.content
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
    }
    inputTokens = count(record?.usage?.input_tokens);
    outputTokens = count(record?.usage?.output_tokens);
  } else {
    const record = body as {
      choices?: { message?: { content?: unknown } }[];
      usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
    };
    const content = record?.choices?.[0]?.message?.content;
    if (typeof content === "string") output = content;
    inputTokens = count(record?.usage?.prompt_tokens);
    outputTokens = count(record?.usage?.completion_tokens);
  }
  if (output === undefined) {
    throw new LookyUnavailableError(`Provider ${id} returned a response without text`);
  }
  return {
    text: output,
    // Providers that omit usage are charged a conservative estimate.
    inputTokens: inputTokens ?? estimateTokens(request.system + request.prompt),
    outputTokens: outputTokens ?? Math.min(estimateTokens(output), request.maxOutputTokens),
  };
}
