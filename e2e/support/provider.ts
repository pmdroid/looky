/**
 * A controlled model provider for browser tests: a real HTTP server that
 * speaks the OpenAI-compatible `/v1/chat/completions` format, so Looky's own
 * HTTP provider client, provider router, budgets and cancellation run exactly
 * as they do against a hosted model. Only the model's reply is scripted.
 *
 * Replies are built from the prompt Looky sent, like a model sees it: the
 * question and the line-numbered evidence blocks. Every call is recorded with
 * its kind (plan, answer, check), question and whether Looky aborted it, so
 * tests can count research work and see cancellation reach the provider.
 *
 * This is not a fixture for the UI: the browser only ever sees what Looky
 * produced from these replies after its own citation checks.
 */
import type { ModelRequest } from "../../src/contract/ports";
import { WIKI_SYSTEM_MARKER } from "../../src/wiki/prompts";
import {
  kindOf,
  promptEvidence,
  type CallKind,
  type PromptEvidence,
} from "../../test/support/scripted-model";
import { groundedPage, type WikiCall } from "../../test/support/wiki-fixture";

export type CallStatus = "running" | "replied" | "aborted";

export interface ProviderCall {
  readonly seq: number;
  /** `wiki` for a call that writes one generated wiki page. */
  readonly kind: CallKind | "wiki";
  readonly question: string;
  /** For a wiki call: the page title and the neighbouring slugs it may link to. */
  readonly page?: { readonly title: string; readonly neighbours: readonly string[] };
  readonly evidence: readonly PromptEvidence[];
  readonly model: string;
  /** Whether Looky sent the configured API key, which never reaches a browser. */
  readonly authorized: boolean;
  status: CallStatus;
}

export type Reply =
  /** A model reply whose text is this value as JSON. */
  | { readonly json: unknown }
  /** A model reply with this exact text. */
  | { readonly text: string }
  /** An HTTP error from the provider, such as an outage. */
  | {
      readonly status: number;
      readonly body?: unknown;
      readonly headers?: Record<string, string>;
    };

export type Script = (call: ProviderCall, signal: AbortSignal) => Reply | Promise<Reply>;

/** A wiki page script; undefined passes the call on to earlier scripts and then the default. */
export type WikiScript = (
  call: ProviderCall,
  signal: AbortSignal,
) => Reply | undefined | Promise<Reply | undefined>;

export interface Hold {
  /** Resolves with the first held call once Looky makes it. */
  readonly started: Promise<ProviderCall>;
  /** Let held calls (and later ones for the same question) reply. */
  release(): void;
}

interface Rule {
  readonly marker: string;
  readonly script: Script;
}

export const PROVIDER_API_KEY = "sk-e2e-scripted-provider-key-never-in-browser";

/** First evidence id shown for a path, as `[E3]`, or "" when it was not shown. */
export function cite(call: ProviderCall, path: string): string {
  const id = call.evidence.find((item) => item.path === path)?.id;
  return id ? `[${id}]` : "";
}

/** Distinct evidence paths in prompt order. */
export function shownPaths(call: ProviderCall): string[] {
  return [...new Set(call.evidence.map((item) => item.path))];
}

/**
 * A grounded answer that explains in sentences and cites one range per file
 * it was shown, up to `maxFiles`.
 */
export function groundedAnswer(call: ProviderCall, maxFiles = 4): Reply {
  const paths = shownPaths(call).slice(0, maxFiles);
  if (paths.length === 0) {
    return {
      json: {
        outcome: "unknown",
        answer: "The indexed code at this revision does not show how this works.",
        rationale: "not_asked",
      },
    };
  }
  const sentences = paths.map(
    (path) => `The code in ${path} takes part in this ${cite(call, path)}.`,
  );
  return {
    json: {
      outcome: "supported",
      answer: `This is established by ${paths.length} indexed files. ${sentences.join(" ")}`,
      rationale: "not_asked",
    },
  };
}

/** A grounded wiki page from the evidence the prompt showed, as a model would write it. */
export function wikiPage(call: ProviderCall): Reply {
  return {
    json: groundedPage({
      evidence: call.evidence,
      title: call.page?.title ?? "",
      neighbours: call.page?.neighbours ?? [],
    } as unknown as WikiCall),
  };
}

function defaultScript(call: ProviderCall): Reply {
  if (call.kind === "wiki") return wikiPage(call);
  if (call.kind === "plan") return { json: { followUps: [], done: true } };
  if (call.kind === "check") return { json: { verdict: "ok" } };
  return groundedAnswer(call);
}

export class ScriptedProvider {
  readonly calls: ProviderCall[] = [];
  readonly #rules: Rule[] = [];
  readonly #wikiRules: WikiScript[] = [];
  readonly #server: ReturnType<typeof Bun.serve>;

  constructor() {
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      // Held calls must stay open while a test decides when they reply.
      idleTimeout: 0,
      fetch: (request) => this.#handle(request),
    });
  }

  /** Base URL for `LOOKY_PROVIDER_<ID>_BASE_URL`. */
  get baseUrl(): string {
    return `http://127.0.0.1:${this.#server.port}/v1`;
  }

  /** Script calls whose question contains `marker`. Later scripts win. */
  script(marker: string, script: Script): void {
    this.#rules.unshift({ marker, script });
  }

  /** Script wiki page calls. Later scripts win; a script returning undefined passes on. */
  scriptWiki(script: WikiScript): void {
    this.#wikiRules.unshift(script);
  }

  async #wikiReply(call: ProviderCall, signal: AbortSignal): Promise<Reply> {
    for (const script of this.#wikiRules) {
      const reply = await script(call, signal);
      if (reply) return reply;
    }
    return wikiPage(call);
  }

  /** Hold every wiki page call until released, then write the page as usual. */
  holdWiki(): Hold {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    let started!: (call: ProviderCall) => void;
    const first = new Promise<ProviderCall>((resolve) => (started = resolve));
    let released = false;
    this.scriptWiki(async (call, signal) => {
      if (released) return undefined;
      started(call);
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void opened.then(resolve);
      });
      return undefined;
    });
    return {
      started: first,
      release: () => {
        released = true;
        release();
      },
    };
  }

  /**
   * Hold answer calls for questions containing `marker` until released, then
   * reply with `then` (a grounded answer by default). Plan and check calls
   * pass through so Deep can reach its answer call.
   */
  hold(marker: string, then: Script = defaultScript): Hold {
    let release!: () => void;
    const opened = new Promise<void>((resolve) => (release = resolve));
    let started!: (call: ProviderCall) => void;
    const first = new Promise<ProviderCall>((resolve) => (started = resolve));
    this.script(marker, async (call, signal) => {
      if (call.kind !== "answer") return then(call, signal);
      started(call);
      await new Promise<void>((resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void opened.then(resolve);
      });
      return then(call, signal);
    });
    return { started: first, release };
  }

  /** Calls for questions containing `marker`, optionally of one kind. */
  callsFor(marker: string, kind?: CallKind): ProviderCall[] {
    return this.calls.filter(
      (call) => call.question.includes(marker) && (kind === undefined || call.kind === kind),
    );
  }

  /** Resolves once `predicate` holds for the recorded calls, or rejects after `timeoutMs`. */
  async waitFor(
    predicate: (calls: readonly ProviderCall[]) => boolean,
    timeoutMs = 10_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.calls)) {
      if (Date.now() > deadline) throw new Error("The provider never saw the expected calls");
      await Bun.sleep(25);
    }
  }

  async stop(): Promise<void> {
    await this.#server.stop(true);
  }

  async #handle(request: Request): Promise<Response> {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions") {
      return Response.json({ error: { type: "not_found" } }, { status: 404 });
    }
    const body = (await request.json()) as {
      model: string;
      messages: { role: string; content: string }[];
      max_tokens?: number;
    };
    const system = body.messages.find((message) => message.role === "system")?.content ?? "";
    const prompt = body.messages.find((message) => message.role === "user")?.content ?? "";
    const wiki = system.startsWith(WIKI_SYSTEM_MARKER);
    const call: ProviderCall = {
      seq: this.calls.length + 1,
      kind: wiki ? "wiki" : kindOf({ system, prompt } as ModelRequest),
      question: /<question>\n([\s\S]*?)\n<\/question>/.exec(prompt)?.[1] ?? "",
      ...(wiki
        ? {
            page: {
              title: /^Title: (.*)$/m.exec(prompt)?.[1] ?? "",
              neighbours: [...prompt.matchAll(/^- \[\[([^\]]+)\]\]/gm)].map((m) => m[1]!),
            },
          }
        : {}),
      evidence: promptEvidence(prompt),
      model: body.model,
      authorized: request.headers.get("authorization") === `Bearer ${PROVIDER_API_KEY}`,
      status: "running",
    };
    this.calls.push(call);
    const signal = request.signal;
    signal.addEventListener(
      "abort",
      () => {
        if (call.status === "running") call.status = "aborted";
      },
      { once: true },
    );
    const rule = wiki ? undefined : this.#rules.find((item) => call.question.includes(item.marker));
    const script: Script = wiki
      ? (item, abort) => this.#wikiReply(item, abort)
      : (rule?.script ?? defaultScript);
    let reply: Reply;
    try {
      reply = await script(call, signal);
    } catch (error) {
      if (signal.aborted) {
        call.status = "aborted";
        return new Response(null, { status: 499 });
      }
      throw error;
    }
    if (signal.aborted) {
      call.status = "aborted";
      return new Response(null, { status: 499 });
    }
    call.status = "replied";
    if ("status" in reply) {
      return Response.json(reply.body ?? { error: { type: "scripted_error" } }, {
        status: reply.status,
        ...(reply.headers ? { headers: reply.headers } : {}),
      });
    }
    const text = "json" in reply ? JSON.stringify(reply.json) : reply.text;
    return Response.json({
      id: `chatcmpl-${call.seq}`,
      object: "chat.completion",
      model: body.model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: Math.ceil((system.length + prompt.length) / 4),
        completion_tokens: Math.min(body.max_tokens ?? 200, Math.ceil(text.length / 4)),
      },
    });
  }
}
