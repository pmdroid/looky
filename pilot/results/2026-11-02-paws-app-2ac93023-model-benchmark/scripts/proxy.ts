import { appendFileSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    envFile: { type: "string" },
    keyEnv: { type: "string" },
    upstream: {
      type: "string",
      default: "https://opencode.ai/inference/go/openai/v1/chat/completions",
    },
    catalogue: { type: "string", default: "https://opencode.ai/inference/go/v1/models" },
    log: { type: "string" },
    port: { type: "string", default: "7399" },
    capUsd: { type: "string", default: "3" },
    capRequests: { type: "string", default: "500" },
  },
});

const UPSTREAM = args.upstream!;
const CATALOGUE = args.catalogue!;
const capUsd = Number(args.capUsd);
const capRequests = Number(args.capRequests);
const logPath = args.log!;

const keyLine = args.envFile
  ? readFileSync(args.envFile, "utf8")
      .split("\n")
      .find((line) => line.startsWith("LOOKY_OPENCODE_APIKEY="))
  : undefined;
const key = args.keyEnv
  ? process.env[args.keyEnv]
  : keyLine
      ?.slice("LOOKY_OPENCODE_APIKEY=".length)
      .trim()
      .replace(/^["']|["']$/g, "");
if (!key) throw new Error("API key not found");

type Price = { price: number; overrides?: { when: { context: { gt: number } }; price: number }[] };
interface CatalogueModel {
  id: string;
  pricing?: { prompt: string; completion: string };
  cost: { text: { input: Price; output: Price }; multipliers?: { when: any; factor: number }[] };
}
const catalogue = new Map<string, CatalogueModel>(
  ((await (await fetch(CATALOGUE)).json()) as { data: CatalogueModel[] }).data.map((m) => [
    m.id,
    m,
  ]),
);

function priced(price: Price, context: number): number {
  const override = price.overrides?.find((o) => context > o.when.context.gt);
  return override?.price ?? price.price;
}

function hourIn(now: Date, range: any): boolean {
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  const at = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));
  const parts = range.all as { utc_hours: { gte?: string; lt?: string } }[];
  return parts.every(({ utc_hours: h }) =>
    h.gte !== undefined ? minutes >= at(h.gte) : minutes < at(h.lt!),
  );
}

function multiplier(model: CatalogueModel, now: Date): number {
  let factor = 1;
  for (const m of model.cost.multipliers ?? []) {
    const days = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const w = m.when;
    if (w.date?.gte && now.toISOString().slice(0, 10) < w.date.gte) continue;
    if (w.utc_days && !w.utc_days.in.includes(days[now.getUTCDay()])) continue;
    if (w.any && !w.any.some((range: any) => hourIn(now, range))) continue;
    factor *= m.factor;
  }
  return factor;
}

function estimateUsd(modelId: string, input: number, output: number, now: Date): number {
  const model = catalogue.get(modelId);
  if (!model) return Number.POSITIVE_INFINITY;
  if (model.pricing) {
    return input * Number(model.pricing.prompt) + output * Number(model.pricing.completion);
  }
  const factor = multiplier(model, now);
  return (
    ((input * priced(model.cost.text.input, input) +
      output * priced(model.cost.text.output, input)) /
      1e6) *
    factor
  );
}

function kindOf(system: string, prompt: string): string {
  if (system.startsWith("You plan read-only code research")) return "plan";
  if (system.includes("You are now reviewing a draft answer")) return "check";
  if (prompt.includes("Your previous reply was rejected")) return "repair";
  if (system.startsWith("You are Looky.")) return "synthesis";
  return "other";
}

let spentUsd = 0;
let requests = 0;
let tag: Record<string, string> = {};

Bun.serve({
  hostname: "127.0.0.1",
  port: Number(args.port),
  idleTimeout: 255,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/_bench/tag" && request.method === "POST") {
      tag = (await request.json()) as Record<string, string>;
      return Response.json({ ok: true });
    }
    if (url.pathname === "/_bench/state") {
      return Response.json({ spentUsd, requests, capUsd, capRequests });
    }
    if (url.pathname !== "/openai/v1/chat/completions" || request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }
    const body = (await request.json()) as {
      model: string;
      messages: { role: string; content: string }[];
    };
    const system = body.messages.find((m) => m.role === "system")?.content ?? "";
    const prompt = body.messages.find((m) => m.role === "user")?.content ?? "";
    const record: Record<string, unknown> = {
      ...tag,
      at: new Date().toISOString(),
      model: body.model,
      kind: kindOf(system, prompt),
      maxTokens: (body as any).max_tokens ?? (body as any).max_completion_tokens,
    };
    if (spentUsd >= capUsd || requests >= capRequests) {
      appendFileSync(logPath, `${JSON.stringify({ ...record, refused: "bench_cap" })}\n`);
      return Response.json(
        { error: { type: "bench_cap", code: "bench_cap" } },
        { status: 429, headers: { "retry-after": "3600" } },
      );
    }
    requests += 1;
    const started = performance.now();
    let upstream: Response;
    let text: string;
    try {
      upstream = await fetch(UPSTREAM, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
          "user-agent": "looky-bench/0.1",
          "x-opencode-session": `looky-bench-${tag.run ?? "none"}-${tag.q ?? ""}-${tag.mode ?? ""}`,
        },
        body: JSON.stringify(body),
        signal: request.signal,
        redirect: "error",
      });
      text = await upstream.text();
    } catch (error) {
      appendFileSync(
        logPath,
        `${JSON.stringify({ ...record, ms: Math.round(performance.now() - started), networkError: error instanceof Error ? error.name : "error" })}\n`,
      );
      throw error;
    }
    const ms = Math.round(performance.now() - started);
    let parsed: any;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    const usage = parsed?.usage ?? {};
    const input = usage.prompt_tokens ?? 0;
    const output = usage.completion_tokens ?? 0;
    const usd =
      typeof usage.cost === "number"
        ? usage.cost
        : upstream.ok || input + output > 0
          ? estimateUsd(body.model, input, output, new Date())
          : 0;
    spentUsd += usd;
    const message = parsed?.choices?.[0]?.message ?? {};
    appendFileSync(
      logPath,
      `${JSON.stringify({
        ...record,
        status: upstream.status,
        ms,
        inputTokens: input,
        outputTokens: output,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens,
        reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
        finishReason: parsed?.choices?.[0]?.finish_reason,
        contentChars: typeof message.content === "string" ? message.content.length : null,
        reasoningChars:
          typeof (message.reasoning_content ?? message.reasoning) === "string"
            ? (message.reasoning_content ?? message.reasoning).length
            : null,
        allowance: parsed?.opencode?.allowance,
        extraKeys: parsed
          ? Object.keys(parsed).filter(
              (k) =>
                ![
                  "id",
                  "object",
                  "created",
                  "model",
                  "choices",
                  "usage",
                  "system_fingerprint",
                ].includes(k),
            )
          : undefined,
        meterHeaders: Object.fromEntries(
          [...upstream.headers].filter(([name]) => /opencode|allowance|ratelimit/i.test(name)),
        ),
        errorType: upstream.ok ? undefined : (parsed?.error?.type ?? parsed?.error?.code),
        estUsd: Number(usd.toFixed(6)),
        spentUsd: Number(spentUsd.toFixed(6)),
      })}\n`,
    );
    const headers = new Headers({ "content-type": "application/json" });
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers.set("retry-after", retryAfter);
    return new Response(text, { status: upstream.status, headers });
  },
});
console.error(`proxy listening on http://127.0.0.1:${args.port}`);
