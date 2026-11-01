import type { AskProjectServices } from "../../src/ask/ask-project";
import { BudgetExhaustedError } from "../../src/ask/session";
import { DEFAULT_BUDGETS } from "../../src/contract/budgets";
import type { LookyRequestContext } from "../../src/contract/context";
import type {
  AnswerEngine,
  AuthorizationDecision,
  ClientAdapter,
  IndexCatalog,
  IndexResolution,
  ModelProvider,
  ResearchSession,
  Retriever,
  EngineAnswer,
  SourceReader,
} from "../../src/contract/ports";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

export function makeContext(overrides: Partial<LookyRequestContext> = {}): LookyRequestContext {
  return {
    clientId: "paws",
    clientGeneration: "run-1",
    callerId: "agent-1",
    repositoryId: "repo-paws",
    sha: SHA_A,
    worktree: { state: "clean" },
    ...overrides,
  };
}

export interface FakeAdapter extends ClientAdapter {
  authorizeCalls: number;
  decide: (call: number) => AuthorizationDecision;
}

export function makeAdapter(
  context: LookyRequestContext = makeContext(),
  extra: Partial<Pick<ClientAdapter, "budgetLimits">> = {},
): FakeAdapter {
  const adapter: FakeAdapter = {
    authorizeCalls: 0,
    decide: () => ({ allowed: true }),
    resolveContext: async () => context,
    authorize: async () => {
      adapter.authorizeCalls += 1;
      return adapter.decide(adapter.authorizeCalls);
    },
    ...extra,
  };
  return adapter;
}

export const FILE_LINES = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of recovery.ts`);

export interface Recorded {
  searches: { generationId: string; repositoryId: string; query: string; limit: number }[];
  reads: { repositoryId: string; sha: string; path: string; maxBytes: number }[];
  modelCalls: { maxOutputTokens: number }[];
  catalogLookups: { repositoryId: string; sha: string }[];
}

/** Engine that does one retrieval, one read and one model call, citing what it read. */
export const simpleEngine: AnswerEngine = {
  async answer(session: ResearchSession): Promise<EngineAnswer> {
    const [hit] = await session.retrieve(session.question);
    if (!hit) {
      return {
        text: "The indexed revision does not establish this.",
        outcome: "unknown",
        evidence: [],
      };
    }
    const source = await session.read(hit);
    const result = await session.model({
      system: "Explain the code.",
      prompt: `${session.question}\n${source.text}`,
      maxOutputTokens: 500,
    });
    return {
      text: result.text,
      outcome: "supported",
      evidence: [{ path: source.path, startLine: source.startLine, endLine: source.endLine }],
      ...(session.mode === "fast" ? { suggestDeep: false } : {}),
    };
  },
};

export function makeServices(
  options: {
    resolution?: IndexResolution;
    engine?: AnswerEngine;
    retriever?: Retriever;
    sourceReader?: SourceReader;
    provider?: ModelProvider;
    catalog?: IndexCatalog;
  } = {},
): { services: AskProjectServices; recorded: Recorded } {
  const recorded: Recorded = { searches: [], reads: [], modelCalls: [], catalogLookups: [] };
  const resolution: IndexResolution = options.resolution ?? {
    state: "ready",
    generation: { generationId: "gen-a", sha: SHA_A },
  };
  const services: AskProjectServices = {
    config: { maxQuestionChars: 200, indexRetryAfterMs: 2500, budgets: DEFAULT_BUDGETS },
    catalog: options.catalog ?? {
      resolve: async (scope) => {
        recorded.catalogLookups.push({ ...scope });
        return resolution;
      },
    },
    retriever: options.retriever ?? {
      search: async (request) => {
        recorded.searches.push({
          generationId: request.generation.generationId,
          repositoryId: request.repositoryId,
          query: request.query,
          limit: request.limit,
        });
        return [
          {
            generationId: request.generation.generationId,
            path: "src/recovery.ts",
            startLine: 3,
            endLine: 6,
            score: 1,
            preview: "line 3 of recovery.ts",
          },
        ];
      },
    },
    sourceReader: options.sourceReader ?? {
      read: async (request) => {
        recorded.reads.push({
          repositoryId: request.repositoryId,
          sha: request.sha,
          path: request.path,
          maxBytes: request.maxBytes,
        });
        const end = Math.min(request.endLine, FILE_LINES.length);
        const text = FILE_LINES.slice(request.startLine - 1, end).join("\n") + "\n";
        // Like GitSourceReader, never return more than the remaining byte allowance.
        if (Buffer.byteLength(text) > request.maxBytes) {
          throw new BudgetExhaustedError("maxSourceBytes");
        }
        return { path: request.path, startLine: request.startLine, endLine: end, text };
      },
    },
    provider: options.provider ?? {
      id: "fake",
      complete: async (request) => {
        recorded.modelCalls.push({ maxOutputTokens: request.maxOutputTokens });
        return {
          text: "Recovery restarts the run from its last checkpoint. It reads the saved state first.",
          inputTokens: 100,
          outputTokens: 40,
        };
      },
    },
    engine: options.engine ?? simpleEngine,
    newRequestId: () => "req-1",
  };
  return { services, recorded };
}
