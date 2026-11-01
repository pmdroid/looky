import { describe, expect, test } from "bun:test";
import {
  LookyUnavailableError,
  ProviderConfigError,
  ProviderQuotaError,
  type ModelProvider,
} from "../src/contract/ports";
import { createConfiguredProvider, loadProviderConfig } from "../src/providers/config";
import { createHttpProvider } from "../src/providers/http";
import { ProviderRouter } from "../src/providers/router";

const request = { system: "sys", prompt: "question", maxOutputTokens: 300 };
const signal = () => new AbortController().signal;

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function fakeFetch(
  respond: (captured: Captured) => Response | Promise<Response>,
  captured: Captured[] = [],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const item: Captured = {
      url: String(input),
      headers: init?.headers as Record<string, string>,
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    captured.push(item);
    init?.signal?.throwIfAborted();
    return respond(item);
  }) as typeof fetch;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("HTTP providers", () => {
  test("OpenAI-compatible request and response", async () => {
    const captured: Captured[] = [];
    const provider = createHttpProvider({
      id: "local",
      kind: "openai",
      model: "qwen-coder",
      baseUrl: "http://127.0.0.1:11434/v1/",
      fetch: fakeFetch(
        () =>
          json(200, {
            choices: [{ message: { content: "The answer." } }],
            usage: { prompt_tokens: 12, completion_tokens: 3 },
          }),
        captured,
      ),
    });
    const result = await provider.complete(request, signal());
    expect(result).toEqual({ text: "The answer.", inputTokens: 12, outputTokens: 3 });
    expect(captured[0]!.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(captured[0]!.headers.authorization).toBeUndefined();
    expect(captured[0]!.body).toEqual({
      model: "qwen-coder",
      max_tokens: 300,
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "question" },
      ],
    });
  });

  test("Anthropic request and response", async () => {
    const captured: Captured[] = [];
    const provider = createHttpProvider({
      id: "hosted",
      kind: "anthropic",
      model: "some-model",
      apiKey: "secret-key",
      fetch: fakeFetch(
        () =>
          json(200, {
            content: [
              { type: "text", text: "Part one. " },
              { type: "text", text: "Part two." },
            ],
            usage: { input_tokens: 20, output_tokens: 5 },
          }),
        captured,
      ),
    });
    const result = await provider.complete(request, signal());
    expect(result.text).toBe("Part one. Part two.");
    expect(captured[0]!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(captured[0]!.headers["x-api-key"]).toBe("secret-key");
    expect(captured[0]!.headers["anthropic-version"]).toBe("2023-06-01");
    expect(captured[0]!.body).toMatchObject({ system: "sys", max_tokens: 300 });
  });

  test("missing usage is estimated within the output allowance", async () => {
    const provider = createHttpProvider({
      id: "p",
      kind: "openai",
      model: "m",
      fetch: fakeFetch(() => json(200, { choices: [{ message: { content: "x".repeat(4000) } }] })),
    });
    const result = await provider.complete(request, signal());
    expect(result.outputTokens).toBe(300);
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  test("errors are typed for fallback and never echo credentials or bodies", async () => {
    const make = (response: () => Response) =>
      createHttpProvider({
        id: "p",
        kind: "openai",
        model: "m",
        apiKey: "sk-should-not-leak",
        fetch: fakeFetch(response),
      });
    const rate = make(() => json(429, { error: { type: "rate_limit" } }, { "retry-after": "7" }));
    const rateError = await rate.complete(request, signal()).catch((error: unknown) => error);
    expect(rateError).toBeInstanceOf(ProviderQuotaError);
    expect((rateError as ProviderQuotaError).retryAfterMs).toBe(7000);

    const quota = make(() => json(429, { error: { code: "insufficient_quota" } }));
    const quotaError = (await quota
      .complete(request, signal())
      .catch((e: unknown) => e)) as ProviderQuotaError;
    expect(quotaError.retryAfterMs).toBe(15 * 60_000);

    for (const status of [401, 403, 500, 503, 529]) {
      const error = await make(() => json(status, { error: { message: "sk-should-not-leak" } }))
        .complete(request, signal())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LookyUnavailableError);
      expect(String((error as Error).message)).not.toContain("sk-should-not-leak");
    }
    const bad = await make(() => json(400, { error: { type: "invalid_request_error" } }))
      .complete(request, signal())
      .catch((e: unknown) => e);
    expect(bad).not.toBeInstanceOf(LookyUnavailableError);
    expect((bad as Error).message).toContain("invalid_request_error");

    const network = await make(() => {
      throw new TypeError("connect ECONNREFUSED");
    })
      .complete(request, signal())
      .catch((e: unknown) => e);
    expect(network).toBeInstanceOf(LookyUnavailableError);
  });

  test("caller cancellation propagates; provider timeouts are unavailable", async () => {
    const slowFetch: typeof fetch = ((input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        void input;
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as typeof fetch;
    const controller = new AbortController();
    const cancelled = createHttpProvider({ id: "p", kind: "openai", model: "m", fetch: slowFetch });
    const pending = cancelled.complete(request, controller.signal).catch((e: unknown) => e);
    controller.abort(new Error("caller cancelled"));
    expect(((await pending) as Error).message).toBe("caller cancelled");

    const timed = createHttpProvider({
      id: "p",
      kind: "openai",
      model: "m",
      timeoutMs: 5,
      fetch: slowFetch,
    });
    const error = await timed.complete(request, signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LookyUnavailableError);
    expect((error as Error).message).toContain("timed out");
  });

  test("invalid provider options are configuration errors", () => {
    expect(() =>
      createHttpProvider({ id: "p", kind: "openai", model: "m", baseUrl: "file:///etc" }),
    ).toThrow(ProviderConfigError);
    expect(() => createHttpProvider({ id: "p", kind: "openai", model: " " })).toThrow(
      ProviderConfigError,
    );
  });
});

describe("provider router", () => {
  const ok = (id: string): ModelProvider & { calls: number } => {
    const provider = {
      id,
      calls: 0,
      async complete() {
        provider.calls += 1;
        return { text: id, inputTokens: 10, outputTokens: 10 };
      },
    };
    return provider;
  };

  test("policies may only name configured providers, once each", () => {
    const providers = [ok("a"), ok("b")];
    expect(() => new ProviderRouter({ providers, policy: { selected: "c" } })).toThrow(
      ProviderConfigError,
    );
    expect(
      () => new ProviderRouter({ providers, policy: { selected: "a", fallback: ["a"] } }),
    ).toThrow(ProviderConfigError);
    expect(
      () => new ProviderRouter({ providers: [ok("a"), ok("a")], policy: { selected: "a" } }),
    ).toThrow(ProviderConfigError);
    const router = new ProviderRouter({ providers, policy: { selected: "a" } });
    expect(() => router.withPolicy({ selected: "z" })).toThrow(ProviderConfigError);
  });

  test("token quotas admit calls on their worst case and charge actual usage", async () => {
    let clock = 0;
    const a = ok("a");
    const b = ok("b");
    const router = new ProviderRouter({
      providers: [{ provider: a, quota: { maxTokensPerMinute: 400 } }, b],
      policy: { selected: "a", fallback: ["b"] },
      now: () => clock,
    });
    // Worst case 1 + 300 fits; actual 20 is charged, so a second call still fits.
    expect((await router.complete(request, signal())).providerId).toBe("a");
    expect((await router.complete(request, signal())).providerId).toBe("a");
    const big = { ...request, maxOutputTokens: 390 };
    expect((await router.complete(big, signal())).providerId).toBe("b");
    clock += 60_001;
    expect((await router.complete(big, signal())).providerId).toBe("a");
  });

  test("a cancelled call is not retried on the fallback", async () => {
    const controller = new AbortController();
    const a: ModelProvider = {
      id: "a",
      complete: async () => {
        controller.abort(new Error("stop"));
        throw new LookyUnavailableError("aborted mid-call");
      },
    };
    const b = ok("b");
    const router = new ProviderRouter({
      providers: [a, b],
      policy: { selected: "a", fallback: ["b"] },
    });
    await expect(router.complete(request, controller.signal)).rejects.toThrow("aborted mid-call");
    expect(b.calls).toBe(0);
  });

  test("other errors are not masked by fallback", async () => {
    const a: ModelProvider = {
      id: "a",
      complete: async () => {
        throw new Error("Provider a rejected the request (HTTP 400)");
      },
    };
    const b = ok("b");
    const router = new ProviderRouter({
      providers: [a, b],
      policy: { selected: "a", fallback: ["b"] },
    });
    await expect(router.complete(request, signal())).rejects.toThrow("HTTP 400");
    expect(b.calls).toBe(0);
  });

  test("when every provider is out of quota the error says so", async () => {
    const spent = (id: string): ModelProvider => ({
      id,
      complete: async () => {
        throw new ProviderQuotaError(id, "spent", 5_000);
      },
    });
    const router = new ProviderRouter({
      providers: [spent("a"), spent("b")],
      policy: { selected: "a", fallback: ["b"] },
      now: () => 0,
    });
    const error = (await router
      .complete(request, signal())
      .catch((e: unknown) => e)) as ProviderQuotaError;
    expect(error).toBeInstanceOf(ProviderQuotaError);
    expect(error.retryAfterMs).toBe(5_000);
    expect(error.message).toContain("a: quota exhausted");
    expect(error.message).toContain("b: quota exhausted");
  });
});

describe("provider configuration", () => {
  test("no selected provider means no configuration", () => {
    expect(loadProviderConfig({})).toBeUndefined();
    expect(() => loadProviderConfig({ LOOKY_PROVIDER_FALLBACK: "x" })).toThrow(ProviderConfigError);
  });

  test("selected, fallback and per-provider settings and quotas", () => {
    const config = loadProviderConfig({
      LOOKY_PROVIDER: "local",
      LOOKY_PROVIDER_FALLBACK: "hosted",
      LOOKY_PROVIDER_LOCAL_KIND: "openai",
      LOOKY_PROVIDER_LOCAL_MODEL: "qwen",
      LOOKY_PROVIDER_LOCAL_BASE_URL: "http://127.0.0.1:11434/v1",
      LOOKY_PROVIDER_LOCAL_MAX_TOKENS_FIELD: "max_completion_tokens",
      LOOKY_PROVIDER_HOSTED_KIND: "anthropic",
      LOOKY_PROVIDER_HOSTED_MODEL: "m",
      LOOKY_PROVIDER_HOSTED_API_KEY: "k",
      LOOKY_PROVIDER_HOSTED_MAX_REQUESTS_PER_MINUTE: "30",
      LOOKY_PROVIDER_HOSTED_MAX_TOKENS_PER_MINUTE: "100000",
    })!;
    expect(config.policy).toEqual({ selected: "local", fallback: ["hosted"] });
    expect(config.providers).toEqual([
      {
        id: "local",
        kind: "openai",
        model: "qwen",
        timeoutMs: 60_000,
        baseUrl: "http://127.0.0.1:11434/v1",
        maxTokensField: "max_completion_tokens",
        quota: {},
      },
      {
        id: "hosted",
        kind: "anthropic",
        model: "m",
        timeoutMs: 60_000,
        apiKey: "k",
        quota: { maxRequestsPerMinute: 30, maxTokensPerMinute: 100_000 },
      },
    ]);
  });

  test("invalid settings are rejected", () => {
    const base = {
      LOOKY_PROVIDER: "p",
      LOOKY_PROVIDER_P_KIND: "openai",
      LOOKY_PROVIDER_P_MODEL: "m",
    };
    expect(() => loadProviderConfig({ ...base, LOOKY_PROVIDER_P_KIND: "claude-only" })).toThrow(
      "LOOKY_PROVIDER_P_KIND",
    );
    expect(() => loadProviderConfig({ ...base, LOOKY_PROVIDER_P_MODEL: "" })).toThrow(
      "LOOKY_PROVIDER_P_MODEL",
    );
    expect(() => loadProviderConfig({ ...base, LOOKY_PROVIDER_P_TIMEOUT_MS: "-1" })).toThrow(
      "LOOKY_PROVIDER_P_TIMEOUT_MS",
    );
    expect(() => loadProviderConfig({ ...base, LOOKY_PROVIDER: "Bad Id" })).toThrow(
      ProviderConfigError,
    );
  });

  test("a configured router serves through the HTTP adapter", async () => {
    const router = createConfiguredProvider(
      { LOOKY_PROVIDER: "p", LOOKY_PROVIDER_P_KIND: "openai", LOOKY_PROVIDER_P_MODEL: "m" },
      {
        fetch: fakeFetch(() =>
          json(200, {
            choices: [{ message: { content: "ok" } }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }),
        ),
      },
    )!;
    expect(router.order).toEqual(["p"]);
    expect(await router.complete(request, signal())).toEqual({
      text: "ok",
      inputTokens: 1,
      outputTokens: 1,
      providerId: "p",
    });
  });
});
