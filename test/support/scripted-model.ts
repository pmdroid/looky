import type { ModelProvider, ModelRequest } from "../../src/contract/ports";

export interface PromptEvidence {
  readonly id: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: string;
  readonly text: string;
}

export type CallKind = "plan" | "answer" | "check";

export interface ScriptedCall {
  readonly kind: CallKind;
  readonly request: ModelRequest;
  readonly evidence: readonly PromptEvidence[];
  readonly question: string;
}

export type Responder = (call: ScriptedCall) => unknown;

/** Evidence blocks exactly as Looky put them in the prompt. */
export function promptEvidence(prompt: string): PromptEvidence[] {
  const blocks: PromptEvidence[] = [];
  const pattern =
    /<evidence id="(E\d+)" path="([^"]+)" lines="(\d+)-(\d+)" kind="(\w+)"[^>]*>\n([\s\S]*?)\n<\/evidence>/g;
  for (const match of prompt.matchAll(pattern)) {
    blocks.push({
      id: match[1]!,
      path: match[2]!,
      startLine: Number(match[3]),
      endLine: Number(match[4]),
      kind: match[5]!,
      text: match[6]!,
    });
  }
  return blocks;
}

export function kindOf(request: ModelRequest): CallKind {
  if (request.system.includes("You plan read-only code research")) return "plan";
  if (request.system.includes("You are now reviewing a draft")) return "check";
  return "answer";
}

/** First evidence id for a path, for building citations like a model would. */
export function idFor(call: ScriptedCall, path: string): string | undefined {
  return call.evidence.find((item) => item.path === path)?.id;
}

/** Line in the prompt evidence whose text contains `needle`, as `[E3:12]`. */
export function lineCite(call: ScriptedCall, path: string, needle: string): string {
  for (const item of call.evidence.filter((entry) => entry.path === path)) {
    for (const line of item.text.split("\n")) {
      const match = /^(\d+)\| (.*)$/.exec(line);
      if (match && match[2]!.includes(needle)) return `[${item.id}:${match[1]}]`;
    }
  }
  return "";
}

export interface ScriptedModel extends ModelProvider {
  readonly calls: ScriptedCall[];
}

/**
 * A provider that answers from the prompt it receives, the way a real model
 * would see it. Responders return a JSON-serializable object or a raw string.
 */
export function scriptedModel(
  responders: Partial<Record<CallKind, Responder>>,
  options: { readonly id?: string; readonly outputTokens?: number } = {},
): ScriptedModel {
  const calls: ScriptedCall[] = [];
  return {
    id: options.id ?? "scripted",
    calls,
    async complete(request, signal) {
      signal.throwIfAborted();
      const kind = kindOf(request);
      const question = /<question>\n([\s\S]*?)\n<\/question>/.exec(request.prompt)?.[1] ?? "";
      const call: ScriptedCall = {
        kind,
        request,
        evidence: promptEvidence(request.prompt),
        question,
      };
      calls.push(call);
      const responder =
        responders[kind] ??
        (kind === "plan"
          ? () => ({ followUps: [], done: true })
          : kind === "check"
            ? () => ({ verdict: "ok" })
            : undefined);
      if (!responder) throw new Error(`No responder for ${kind}`);
      const reply = responder(call);
      const text = typeof reply === "string" ? reply : JSON.stringify(reply);
      return {
        text,
        inputTokens: Math.ceil((request.system.length + request.prompt.length) / 4),
        outputTokens: Math.min(request.maxOutputTokens, options.outputTokens ?? 200),
      };
    },
  };
}
