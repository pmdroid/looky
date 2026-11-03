import type { Database } from "bun:sqlite";
import type { ModelProvider, ModelRequest, ModelResult } from "../../src/contract/ports";
import { IndexService } from "../../src/indexing/index-service";
import { DEFAULT_INDEX_LIMITS } from "../../src/indexing/policy";
import { IndexRetriever } from "../../src/retrieval/index-retriever";
import { GitSourceReader } from "../../src/source/git-source-reader";
import { openDatabase } from "../../src/storage/database";
import {
  DEFAULT_WIKI_GENERATION_SETTINGS,
  WikiGenerator,
  type WikiGenerationSettings,
} from "../../src/wiki/generator";
import { DEFAULT_WIKI_PLAN_LIMITS, type WikiPlanLimits } from "../../src/wiki/model";
import { WIKI_SYSTEM_MARKER } from "../../src/wiki/prompts";
import { type PromptEvidence, promptEvidence } from "./scripted-model";

export interface WikiCall {
  readonly request: ModelRequest;
  readonly evidence: readonly PromptEvidence[];
  readonly title: string;
  readonly neighbours: readonly string[];
  /** The writer asked again after rejecting a reply. */
  readonly repair: boolean;
  readonly signal: AbortSignal;
}

export type WikiResponder = (call: WikiCall) => unknown;

/** A grounded page built from the evidence exactly as the prompt showed it. */
export function groundedPage(call: WikiCall): Record<string, unknown> {
  const first = call.evidence[0]!;
  const last = call.evidence.at(-1)!;
  const link = call.neighbours[0] ? ` See [[${call.neighbours[0]}]] for related context.` : "";
  return {
    summary: `${call.title} is explained here from the committed source [${first.id}].`,
    sections: [
      {
        heading: "Responsibilities",
        basis: "observed",
        body:
          `The page draws on ${call.evidence.length} inspected ranges. The first range sets out ` +
          `the main behaviour [${first.id}:${first.startLine}-${Math.min(first.endLine, first.startLine + 1)}].${link}`,
      },
      {
        heading: "How the parts connect",
        basis: "inferred",
        body: `Taken together, the ranges suggest that these files cooperate as one unit [${last.id}].`,
      },
    ],
    intent: [{ statement: "Why the code is split this way is not stated.", basis: "unknown" }],
    caveats: [],
  };
}

export interface WikiModel extends ModelProvider {
  readonly calls: WikiCall[];
}

export function isWikiRequest(request: ModelRequest): boolean {
  return request.system.startsWith(WIKI_SYSTEM_MARKER);
}

/** A provider that writes wiki pages from the prompt it receives, the way a model would see it. */
export function wikiModel(
  responder: WikiResponder = groundedPage,
  options: {
    readonly id?: string;
    readonly usageReported?: boolean;
    readonly outputTokens?: (call: WikiCall) => number;
    /** Runs before the reply; may wait or throw, for cancellation and crash tests. */
    readonly before?: (call: WikiCall, index: number) => Promise<void> | void;
  } = {},
): WikiModel {
  const calls: WikiCall[] = [];
  return {
    id: options.id ?? "scripted",
    calls,
    async complete(request, signal): Promise<ModelResult> {
      signal.throwIfAborted();
      if (!isWikiRequest(request)) throw new Error("Not a wiki page request");
      const call: WikiCall = {
        request,
        evidence: promptEvidence(request.prompt),
        title: /^Title: (.*)$/m.exec(request.prompt)?.[1] ?? "",
        neighbours: [...request.prompt.matchAll(/^- \[\[([^\]]+)\]\]/gm)].map((m) => m[1]!),
        repair: request.prompt.includes("Your previous reply was rejected"),
        signal,
      };
      calls.push(call);
      await options.before?.(call, calls.length - 1);
      signal.throwIfAborted();
      const reply = responder(call);
      const text = typeof reply === "string" ? reply : JSON.stringify(reply);
      return {
        text,
        inputTokens: Math.ceil((request.system.length + request.prompt.length) / 4),
        outputTokens: options.outputTokens?.(call) ?? Math.min(request.maxOutputTokens, 300),
        ...(options.usageReported !== undefined ? { usageReported: options.usageReported } : {}),
      };
    },
  };
}

/** Same index limits as the acceptance fixture, so builds share an index key. */
export const WIKI_TEST_INDEX_LIMITS = { ...DEFAULT_INDEX_LIMITS, maxFileBytes: 65_536 };

export interface WikiHarness {
  readonly db: Database;
  readonly index: IndexService;
  readonly generator: WikiGenerator;
  close(): Promise<void>;
}

/** Index, retriever, source reader and generator over one database, as the service wires them. */
export function wikiHarness(options: {
  readonly dataDir: string;
  readonly repositories: (id: string) => string | undefined;
  readonly provider?: ModelProvider;
  readonly modelIdentity?: string;
  readonly settings?: Partial<WikiGenerationSettings>;
  readonly limits?: WikiPlanLimits;
}): WikiHarness {
  const db = openDatabase({ dataDir: options.dataDir });
  const index = new IndexService({
    db,
    repositories: options.repositories,
    limits: WIKI_TEST_INDEX_LIMITS,
    executor: "inline",
  });
  const generator = new WikiGenerator({
    db,
    index,
    repositories: options.repositories,
    retriever: new IndexRetriever({ db, repositories: options.repositories }),
    sourceReader: new GitSourceReader(options.repositories),
    ...(options.provider ? { provider: options.provider } : {}),
    modelIdentity: options.modelIdentity ?? "scripted:test-model",
    limits: options.limits ?? DEFAULT_WIKI_PLAN_LIMITS,
    settings: { ...DEFAULT_WIKI_GENERATION_SETTINGS, ...options.settings },
  });
  return {
    db,
    index,
    generator,
    async close() {
      await generator.close();
      await index.close();
      db.close();
    },
  };
}
