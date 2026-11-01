import { describe, expect, test } from "bun:test";
import { askProject } from "../src/ask/ask-project";
import {
  LookyUnavailableError,
  type AnswerEngine,
  type ResearchSession,
} from "../src/contract/ports";
import type { AskProjectResponse } from "../src/contract/response";
import {
  makeAdapter,
  makeContext,
  makeServices,
  SHA_A,
  SHA_B,
  simpleEngine,
} from "./support/ask-fakes";

function expectStatus<S extends AskProjectResponse["status"]>(
  response: AskProjectResponse,
  status: S,
): Extract<AskProjectResponse, { status: S }> {
  expect(response.status).toBe(status);
  return response as Extract<AskProjectResponse, { status: S }>;
}

const never = <T>() => new Promise<T>(() => {});

describe("askProject answers", () => {
  test("Fast default returns prose separate from evidence with pinned identity", async () => {
    const { services, recorded } = makeServices();
    const response = expectStatus(
      await askProject({ question: "How does recovery work?" }, makeAdapter(), services),
      "answered",
    );
    expect(response.mode).toEqual({ requested: "fast", executed: "fast" });
    expect(response.answer.text).toContain("Recovery restarts the run");
    expect(response.answer.outcome).toBe("supported");
    expect(response.evidence).toEqual([{ path: "src/recovery.ts", startLine: 3, endLine: 6 }]);
    expect(response.answer.text).not.toContain("src/recovery.ts");
    expect(response.revision).toEqual({ repositoryId: "repo-paws", sha: SHA_A });
    expect(response.index).toEqual({ generationId: "gen-a", sha: SHA_A });
    expect(response.scope).toEqual({ source: "committed", sha: SHA_A, uncommittedChanges: "none" });
    expect(response.usage).toMatchObject({ retrievalPasses: 1, sourceReads: 1, modelCalls: 1 });
    expect(response.suggestedMode).toBeUndefined();
    expect(recorded.searches).toEqual([
      {
        generationId: "gen-a",
        repositoryId: "repo-paws",
        query: "How does recovery work?",
        limit: 10,
      },
    ]);
    expect(
      recorded.reads.every((read) => read.sha === SHA_A && read.repositoryId === "repo-paws"),
    ).toBe(true);
  });

  test("explicit Deep runs with the Deep budget and reports it", async () => {
    let seen: ResearchSession | undefined;
    const engine: AnswerEngine = {
      answer: (session) => {
        seen = session;
        return simpleEngine.answer(session);
      },
    };
    const { services } = makeServices({ engine });
    const response = expectStatus(
      await askProject({ question: "Trace recovery", mode: "deep" }, makeAdapter(), services),
      "answered",
    );
    expect(response.mode).toEqual({ requested: "deep", executed: "deep" });
    expect(seen?.mode).toBe("deep");
    expect(seen?.budget).toEqual(services.config.budgets.deep);
  });

  test("Fast may suggest Deep but never upgrades itself", async () => {
    const engine: AnswerEngine = {
      async answer(session) {
        const base = await simpleEngine.answer(session);
        return { ...base, outcome: "partial", suggestDeep: true };
      },
    };
    const { services } = makeServices({ engine });
    const response = expectStatus(
      await askProject({ question: "q" }, makeAdapter(), services),
      "answered",
    );
    expect(response.mode.executed).toBe("fast");
    expect(response.suggestedMode).toBe("deep");
    expect(response.answer.outcome).toBe("partial");
  });

  test("factual unknown is an answer, distinct from execution failures", async () => {
    const engine: AnswerEngine = {
      answer: async () => ({
        text: "The committed code does not show why retries are capped at three.",
        outcome: "unknown",
        evidence: [],
      }),
    };
    const { services } = makeServices({ engine });
    const response = expectStatus(
      await askProject({ question: "Why three retries?" }, makeAdapter(), services),
      "answered",
    );
    expect(response.answer.outcome).toBe("unknown");
    expect(response.evidence).toEqual([]);
  });

  test("dirty worktree changes are disclosed as excluded", async () => {
    const context = makeContext({
      worktree: { state: "dirty", changedPaths: 3 },
      ref: "feature/x",
    });
    const { services } = makeServices();
    const response = expectStatus(
      await askProject({ question: "q" }, makeAdapter(context), services),
      "answered",
    );
    expect(response.scope.uncommittedChanges).toBe("excluded");
    expect(response.revision.ref).toBe("feature/x");
    expect(response.limitations.join("\n")).toContain("Uncommitted worktree changes (3 paths)");
    expect(response.limitations.join("\n")).toContain("Later movement of feature/x");
  });
});

describe("askProject scope and revision pinning", () => {
  test("question arguments cannot select repository, revision or client scope", async () => {
    const { services, recorded } = makeServices();
    const response = expectStatus(
      await askProject(
        { question: "q", repositoryId: "other-repo", sha: SHA_B },
        makeAdapter(),
        services,
      ),
      "invalid_request",
    );
    expect(response.error.code).toBe("unexpected_argument");
    expect(recorded.catalogLookups).toEqual([]);
  });

  test("the context SHA is resolved once even if the branch moves mid-request", async () => {
    let resolutions = 0;
    let branchHead = SHA_A;
    const adapter = makeAdapter();
    adapter.resolveContext = async () => {
      resolutions += 1;
      return makeContext({ sha: branchHead, ref: "main" });
    };
    const engine: AnswerEngine = {
      async answer(session) {
        branchHead = SHA_B; // The branch moves while research runs.
        return simpleEngine.answer(session);
      },
    };
    const { services, recorded } = makeServices({ engine });
    const response = expectStatus(
      await askProject({ question: "q" }, adapter, services),
      "answered",
    );
    expect(resolutions).toBe(1);
    expect(response.revision.sha).toBe(SHA_A);
    expect(response.index.sha).toBe(SHA_A);
    expect(recorded.catalogLookups).toEqual([{ repositoryId: "repo-paws", sha: SHA_A }]);
    expect(recorded.reads.map((read) => read.sha)).toEqual([SHA_A]);
  });

  test("a generation for another SHA is never used", async () => {
    const { services } = makeServices({
      resolution: { state: "ready", generation: { generationId: "gen-b", sha: SHA_B } },
    });
    const response = expectStatus(
      await askProject({ question: "q" }, makeAdapter(), services),
      "failed",
    );
    expect(response).toMatchObject({ stage: "index", code: "contract_violation" });
  });

  test("retrieval hits from another index generation are rejected", async () => {
    const { services } = makeServices({
      retriever: {
        search: async () => [
          {
            generationId: "gen-old",
            path: "src/a.ts",
            startLine: 1,
            endLine: 2,
            score: 1,
            preview: "x",
          },
        ],
      },
    });
    const response = expectStatus(
      await askProject({ question: "q" }, makeAdapter(), services),
      "failed",
    );
    expect(response.code).toBe("contract_violation");
    expect(response.message).toContain("mixed index generations");
  });

  test("short SHAs and branch names are unsupported revisions", async () => {
    for (const sha of ["main", "abc1234"]) {
      const { services, recorded } = makeServices();
      const response = expectStatus(
        await askProject({ question: "q" }, makeAdapter(makeContext({ sha })), services),
        "unsupported_revision",
      );
      expect(response.limitations).toHaveLength(1);
      expect(recorded.catalogLookups).toEqual([]);
    }
  });

  test("catalog-reported unsupported revisions are explicit", async () => {
    const { services } = makeServices({
      resolution: { state: "unsupported_revision", message: "Commit not found in repository" },
    });
    const response = expectStatus(
      await askProject({ question: "q" }, makeAdapter(), services),
      "unsupported_revision",
    );
    expect(response.revision?.sha).toBe(SHA_A);
  });
});

describe("askProject authorization", () => {
  test("unauthorized and stale sessions are denied before any index access", async () => {
    for (const reason of ["unauthorized", "stale_session"] as const) {
      const adapter = makeAdapter();
      adapter.decide = () => ({ allowed: false, reason });
      const { services, recorded } = makeServices();
      const response = expectStatus(
        await askProject({ question: "q" }, adapter, services),
        "denied",
      );
      expect(response.reason).toBe(reason);
      expect(response.mode.executed).toBeNull();
      expect(recorded.catalogLookups).toEqual([]);
    }
  });

  test("malformed adapter context fails closed", async () => {
    const { services } = makeServices();
    const response = expectStatus(
      await askProject({ question: "q" }, makeAdapter(makeContext({ repositoryId: "" })), services),
      "denied",
    );
    expect(response.reason).toBe("invalid_context");
  });

  test("revocation mid-request stops further reads and delivery", async () => {
    const adapter = makeAdapter();
    // 1: start, 2: retrieve, 3: first read, 4: second read (revoked).
    adapter.decide = (call) =>
      call >= 4 ? { allowed: false, reason: "revoked" } : { allowed: true };
    const engine: AnswerEngine = {
      async answer(session) {
        await session.retrieve("q");
        await session.read({ path: "src/a.ts", startLine: 1, endLine: 2 });
        await session.read({ path: "src/b.ts", startLine: 1, endLine: 2 });
        throw new Error("unreachable");
      },
    };
    const { services, recorded } = makeServices({ engine });
    const response = expectStatus(await askProject({ question: "q" }, adapter, services), "denied");
    expect(response.reason).toBe("revoked");
    expect(recorded.reads.map((read) => read.path)).toEqual(["src/a.ts"]);
    expect(JSON.stringify(response)).not.toContain("Recovery restarts");
  });

  test("revocation after research withholds the answer", async () => {
    const adapter = makeAdapter();
    // start, retrieve, read, model all allowed; delivery check denies.
    adapter.decide = (call) =>
      call >= 5 ? { allowed: false, reason: "revoked" } : { allowed: true };
    const { services, recorded } = makeServices();
    const response = expectStatus(await askProject({ question: "q" }, adapter, services), "denied");
    expect(recorded.modelCalls).toHaveLength(1);
    expect("answer" in response).toBe(false);
    expect(JSON.stringify(response)).not.toContain("Recovery restarts");
  });
});

describe("askProject index readiness", () => {
  test("indexing returns build identity and retry information, not an answer", async () => {
    const { services } = makeServices({
      resolution: {
        state: "building",
        buildId: "build-7",
        progress: { phase: "chunking", filesDone: 10, filesTotal: 40 },
        staleGeneration: { generationId: "gen-old", sha: SHA_B },
      },
    });
    const response = expectStatus(
      await askProject({ question: "q" }, makeAdapter(), services),
      "indexing",
    );
    expect(response).toMatchObject({
      requestId: "req-1",
      buildId: "build-7",
      progress: { phase: "chunking", filesDone: 10, filesTotal: 40 },
      retryAfterMs: 2500,
      staleIndex: { generationId: "gen-old", sha: SHA_B },
      mode: { requested: "fast", executed: null },
    });
    expect("answer" in response).toBe(false);
    expect(response.limitations.join("\n")).toContain("stale for this request");
  });

  test("failed index builds are typed failures with build identity", async () => {
    const { services } = makeServices({
      resolution: { state: "failed", buildId: "build-8", message: "disk full", retryable: true },
    });
    const response = expectStatus(
      await askProject({ question: "q" }, makeAdapter(), services),
      "failed",
    );
    expect(response).toMatchObject({
      stage: "index",
      code: "index_failed",
      buildId: "build-8",
      retryable: true,
    });
  });

  test("an unavailable dependency is distinct from a failure", async () => {
    const { services } = makeServices({
      catalog: {
        resolve: async () => {
          throw new LookyUnavailableError("index store offline");
        },
      },
    });
    const response = expectStatus(
      await askProject({ question: "q" }, makeAdapter(), services),
      "unavailable",
    );
    expect(response.message).toBe("index store offline");
  });
});

describe("askProject answer contract", () => {
  async function answerWith(answer: Awaited<ReturnType<AnswerEngine["answer"]>>, mode = "fast") {
    const engine: AnswerEngine = {
      async answer(session) {
        await session.read({ path: "src/recovery.ts", startLine: 1, endLine: 10 });
        return answer;
      },
    };
    const { services } = makeServices({ engine });
    return askProject({ question: "q", mode }, makeAdapter(), services);
  }

  test("citations outside ranges read at the pinned revision are rejected", async () => {
    const response = expectStatus(
      await answerWith({
        text: "Recovery is handled in another file.",
        outcome: "supported",
        evidence: [{ path: "src/other.ts", startLine: 1, endLine: 2 }],
      }),
      "failed",
    );
    expect(response.message).toContain("was not read at the pinned revision");
    const widened = expectStatus(
      await answerWith({
        text: "Recovery reads state.",
        outcome: "supported",
        evidence: [{ path: "src/recovery.ts", startLine: 5, endLine: 20 }],
      }),
      "failed",
    );
    expect(widened.code).toBe("contract_violation");
  });

  test("snippets alone are not an answer", async () => {
    const response = expectStatus(
      await answerWith({
        text: "```ts\nfunction recover() {}\n```",
        outcome: "supported",
        evidence: [{ path: "src/recovery.ts", startLine: 1, endLine: 2 }],
      }),
      "failed",
    );
    expect(response.message).toContain("snippets alone are not an answer");
  });

  test("supported answers need evidence and Deep cannot suggest Deep", async () => {
    expectStatus(
      await answerWith({ text: "It just works.", outcome: "supported", evidence: [] }),
      "failed",
    );
    const deep = expectStatus(
      await answerWith(
        {
          text: "Recovery reads state.",
          outcome: "partial",
          evidence: [{ path: "src/recovery.ts", startLine: 1, endLine: 2 }],
          suggestDeep: true,
        },
        "deep",
      ),
      "failed",
    );
    expect(deep.message).toContain("Only Fast answers may suggest Deep");
  });
});

describe("askProject budgets", () => {
  test("source reads beyond the Fast limit are refused and Deep is suggested", async () => {
    const engine: AnswerEngine = {
      async answer(session) {
        for (;;) await session.read({ path: "src/recovery.ts", startLine: 1, endLine: 1 });
      },
    };
    const { services, recorded } = makeServices({ engine });
    const response = expectStatus(
      await askProject({ question: "q" }, makeAdapter(), services),
      "failed",
    );
    expect(response).toMatchObject({
      code: "budget_exhausted",
      exhaustedLimit: "maxSourceReads",
      suggestedMode: "deep",
      mode: { requested: "fast", executed: "fast" },
    });
    expect(recorded.reads).toHaveLength(services.config.budgets.fast.maxSourceReads);
  });

  test("engines can stop within budget and return a partial answer", async () => {
    const engine: AnswerEngine = {
      async answer(session) {
        const reads = [];
        while (session.remaining().maxSourceReads > 0) {
          reads.push(await session.read({ path: "src/recovery.ts", startLine: 1, endLine: 2 }));
        }
        return {
          text: "Only part of the flow was traced within the Fast budget.",
          outcome: "partial",
          evidence: [{ path: "src/recovery.ts", startLine: 1, endLine: 2 }],
          suggestDeep: true,
        };
      },
    };
    const { services } = makeServices({ engine });
    const response = expectStatus(
      await askProject({ question: "q" }, makeAdapter(), services),
      "answered",
    );
    expect(response.usage.sourceReads).toBe(services.config.budgets.fast.maxSourceReads);
    expect(response.suggestedMode).toBe("deep");
  });

  test("retrieval passes, source bytes, model calls and tokens are enforced", async () => {
    const cases: [string, AnswerEngine["answer"], string][] = [
      [
        "passes",
        async (s) => {
          for (;;) await s.retrieve("q");
        },
        "maxRetrievalPasses",
      ],
      [
        "calls",
        async (s) => {
          for (;;) await s.model({ system: "", prompt: "p", maxOutputTokens: 100 });
        },
        "maxModelCalls",
      ],
      [
        "input",
        async (s) => {
          await s.model({ system: "", prompt: "x".repeat(200_000), maxOutputTokens: 1 });
          throw new Error("unreachable");
        },
        "maxInputTokens",
      ],
    ];
    for (const [, answer, limit] of cases) {
      const { services } = makeServices({ engine: { answer } });
      const response = expectStatus(
        await askProject({ question: "q" }, makeAdapter(), services),
        "failed",
      );
      expect(response.exhaustedLimit).toBe(limit as never);
    }

    const adapter = makeAdapter(makeContext(), { budgetLimits: { fast: { maxSourceBytes: 30 } } });
    const bytesEngine: AnswerEngine = {
      async answer(s) {
        for (;;) await s.read({ path: "src/recovery.ts", startLine: 1, endLine: 1 });
      },
    };
    const { services: byteServices, recorded } = makeServices({ engine: bytesEngine });
    const byteResponse = expectStatus(
      await askProject({ question: "q" }, adapter, byteServices),
      "failed",
    );
    expect(byteResponse.exhaustedLimit).toBe("maxSourceBytes");
    expect(recorded.reads.map((read) => read.maxBytes)).toEqual([30, 8]);
  });

  test("model output is clamped and provider overruns are refused", async () => {
    const adapter = makeAdapter(makeContext(), {
      budgetLimits: { fast: { maxOutputTokens: 100 } },
    });
    const { services, recorded } = makeServices({
      engine: {
        async answer(s) {
          await s.model({ system: "", prompt: "p", maxOutputTokens: 10_000 });
          throw new Error("unreachable");
        },
      },
      provider: {
        id: "overrun",
        complete: async (request) => {
          recorded.modelCalls.push({ maxOutputTokens: request.maxOutputTokens });
          return { text: "x", inputTokens: 1, outputTokens: 500 };
        },
      },
    });
    const response = expectStatus(await askProject({ question: "q" }, adapter, services), "failed");
    expect(recorded.modelCalls).toEqual([{ maxOutputTokens: 100 }]);
    expect(response.exhaustedLimit).toBe("maxOutputTokens");
  });

  test("answers longer than the mode limit are refused", async () => {
    const adapter = makeAdapter(makeContext(), { budgetLimits: { fast: { maxAnswerChars: 20 } } });
    const { services } = makeServices();
    const response = expectStatus(await askProject({ question: "q" }, adapter, services), "failed");
    expect(response.exhaustedLimit).toBe("maxAnswerChars");
  });

  test("elapsed time is enforced as timed_out, even for a hung engine", async () => {
    const adapter = makeAdapter(makeContext(), { budgetLimits: { fast: { maxElapsedMs: 20 } } });
    let session: ResearchSession | undefined;
    const { services, recorded } = makeServices({
      engine: {
        answer: (s) => {
          session = s;
          return never();
        },
      },
    });
    const response = expectStatus(
      await askProject({ question: "q" }, adapter, services),
      "timed_out",
    );
    expect(response.limitMs).toBe(20);
    expect(response.mode.executed).toBe("fast");
    // The ended session refuses late tool calls.
    await expect(session?.read({ path: "src/a.ts", startLine: 1, endLine: 1 })).rejects.toThrow();
    expect(recorded.reads).toEqual([]);
  });

  test("caller cancellation is reported as cancelled", async () => {
    const controller = new AbortController();
    const { services } = makeServices({
      engine: {
        answer: () => {
          controller.abort();
          return never();
        },
      },
    });
    const response = await askProject({ question: "q" }, makeAdapter(), services, {
      signal: controller.signal,
    });
    expect(response.status).toBe("cancelled");
    expect(response.mode).toEqual({ requested: "fast", executed: "fast" });
  });
});
