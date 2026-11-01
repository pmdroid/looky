import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LookyAnswerEngine, type AnswerEngineOptions } from "../src/answer/engine";
import { askProject, type AskProjectServices } from "../src/ask/ask-project";
import { DEFAULT_BUDGETS, type ModeBudgets } from "../src/contract/budgets";
import type { Mode } from "../src/contract/input";
import {
  LookyUnavailableError,
  ProviderQuotaError,
  type ClientAdapter,
  type ModelProvider,
  type SourceReader,
} from "../src/contract/ports";
import type { AskProjectResponse } from "../src/contract/response";
import { IndexService } from "../src/indexing/index-service";
import { DEFAULT_INDEX_LIMITS } from "../src/indexing/policy";
import { ProviderRouter } from "../src/providers/router";
import { IndexRetriever } from "../src/retrieval/index-retriever";
import { DEFAULT_RESEARCH_LIMITS } from "../src/retrieval/research";
import { GitSourceReader } from "../src/source/git-source-reader";
import { openDatabase } from "../src/storage/database";
import { makeAdapter, makeContext } from "./support/ask-fakes";
import { git } from "./support/git-fixture";
import { buildPilotRepo } from "./support/pilot-fixture";
import {
  idFor,
  lineCite,
  scriptedModel,
  type Responder,
  type ScriptedCall,
} from "./support/scripted-model";

let root: string;
let db: Database;
let service: IndexService;
let repo: string;
let sha: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "looky-answer-"));
  repo = join(root, "pilot");
  Bun.spawnSync(["mkdir", "-p", repo]);
  db = openDatabase({ dataDir: join(root, "data") });
  service = new IndexService({
    db,
    repositories: (id) => (id === "pilot" ? repo : undefined),
    limits: DEFAULT_INDEX_LIMITS,
    executor: "inline",
  });
  sha = buildPilotRepo(repo);
  const started = await service.startBuild({ repositoryId: "pilot", sha });
  if (started.state === "unsupported_revision") throw new Error(started.message);
  expect((await service.waitForBuild(started.build.id)).state).toBe("ready");
});

afterAll(async () => {
  await service.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

interface Recorder {
  reads: string[];
  searches: string[];
}

function services(
  provider: ModelProvider,
  options: {
    engine?: AnswerEngineOptions;
    budgets?: ModeBudgets;
    sourceReader?: SourceReader;
    recorder?: Recorder;
  } = {},
): AskProjectServices {
  const reader =
    options.sourceReader ?? new GitSourceReader((id) => (id === "pilot" ? repo : undefined));
  const retriever = new IndexRetriever({ db });
  const recorder = options.recorder;
  return {
    config: {
      maxQuestionChars: 4000,
      indexRetryAfterMs: 1000,
      budgets: options.budgets ?? DEFAULT_BUDGETS,
    },
    catalog: service,
    retriever: recorder
      ? {
          search: (request, signal) => {
            recorder.searches.push(request.query);
            return retriever.search(request, signal);
          },
        }
      : retriever,
    sourceReader: recorder
      ? {
          read: (request, signal) => {
            recorder.reads.push(`${request.path}:${request.startLine}-${request.endLine}`);
            return reader.read(request, signal);
          },
        }
      : reader,
    provider,
    engine: new LookyAnswerEngine({
      sourceLink: ({ sha: at, path, startLine, endLine }) =>
        `https://code.example/pilot/blob/${at}/${path}#L${startLine}-L${endLine}`,
      ...options.engine,
    }),
  };
}

function adapter(extra: Partial<ClientAdapter> = {}) {
  const context = makeContext({ repositoryId: "pilot", sha });
  return Object.assign(makeAdapter(context), extra);
}

function answered(response: AskProjectResponse) {
  if (response.status !== "answered") throw new Error(JSON.stringify(response, null, 2));
  return response;
}

const FLOW =
  "Walk through what happens from a worker crash until the run is replayed from its checkpoint";

/** Explains the crash recovery flow from whatever evidence it was given, like a model would. */
const flowAnswer: Responder = (call: ScriptedCall) => {
  const supervisor = idFor(call, "src/worker/supervisor.ts");
  const recovery = idFor(call, "src/recovery/recover-run.ts");
  const checkpoints = idFor(call, "src/storage/checkpoints.ts");
  const throwLine = lineCite(
    call,
    "src/recovery/recover-run.ts",
    "throw new MissingCheckpointError",
  );
  const parts = [
    `When a worker exits with a non-zero code, the supervisor treats the run as crashed and hands it to \`resumeInterruptedRun\` [${supervisor}].`,
    `That function loads the newest checkpoint for the run [${checkpoints}] and replays the steps recorded after it, bounded by the retry policy [${recovery}].`,
    `The important exception is a run that never saved a checkpoint: \`loadCheckpoint\` returns nothing and recovery throws \`MissingCheckpointError\` instead of replaying ${throwLine}.`,
  ];
  return {
    outcome: "supported",
    answer: parts.join("\n\n"),
    caveats: [],
    rationale: "not_asked",
  };
};

describe("both modes produce cited explanatory prose", () => {
  for (const mode of ["fast", "deep"] as const) {
    test(`${mode}: a multi-file flow with its exception`, async () => {
      const model = scriptedModel({ answer: flowAnswer });
      const response = answered(
        await askProject({ question: FLOW, mode }, adapter(), services(model)),
      );
      expect(response.mode).toEqual({ requested: mode, executed: mode });
      expect(response.index.sha).toBe(sha);
      expect(response.revision.sha).toBe(sha);
      expect(response.answer.outcome).toBe("supported");

      // The model saw all three files of the flow, line-numbered, from the pinned revision.
      const synthesis = model.calls.find((call) => call.kind === "answer")!;
      const seen = synthesis.evidence.map((item) => item.path);
      for (const path of [
        "src/worker/supervisor.ts",
        "src/recovery/recover-run.ts",
        "src/storage/checkpoints.ts",
      ]) {
        expect(seen).toContain(path);
      }

      // Markers became links pinned to the SHA; the prose stays prose.
      const text = response.answer.text;
      expect(text).toStartWith("When a worker exits with a non-zero code");
      expect(text).not.toMatch(/\[E\d+/);
      expect(text).toContain(`https://code.example/pilot/blob/${sha}/src/worker/supervisor.ts#L`);
      expect(text).toContain("MissingCheckpointError");
      expect(text).not.toContain("```");

      // Every reference is real committed source at the SHA, including the exception's line.
      const file = (path: string) => git(repo, "show", `${sha}:${path}`).split("\n");
      const throwRef = response.evidence.find(
        (ref) => ref.path === "src/recovery/recover-run.ts" && ref.startLine === ref.endLine,
      )!;
      expect(file(throwRef.path)[throwRef.startLine - 1]).toContain(
        "throw new MissingCheckpointError",
      );
      for (const ref of response.evidence) {
        expect(file(ref.path).length).toBeGreaterThanOrEqual(ref.endLine);
      }
      expect(response.answer.caveats.at(-1)).toContain("the rest of the repository was not read");
      expect(response.providers).toEqual(["scripted"]);
    });
  }

  test("Fast is one bounded pass and one model call; Deep plans, follows up and cross-checks", async () => {
    const fastModel = scriptedModel({ answer: flowAnswer });
    const fastRecorder: Recorder = { reads: [], searches: [] };
    const fast = answered(
      await askProject(
        { question: FLOW, mode: "fast" },
        adapter(),
        services(fastModel, { recorder: fastRecorder }),
      ),
    );
    expect(fastModel.calls.map((call) => call.kind)).toEqual(["answer"]);
    expect(fast.usage.retrievalPasses).toBeLessThanOrEqual(DEFAULT_RESEARCH_LIMITS.fast.maxPasses);
    expect(fast.usage.sourceReads).toBeLessThanOrEqual(DEFAULT_RESEARCH_LIMITS.fast.maxReads);
    expect(fast.usage.modelCalls).toBe(1);

    let planned = 0;
    const deepModel = scriptedModel({
      plan: () => {
        planned += 1;
        return planned === 1
          ? {
              followUps: [
                {
                  query: "RETRY_POLICY maxReplayAttempts",
                  definitionOf: "RETRY_POLICY",
                  reason: "how many replays are allowed",
                },
                { query: "saveCheckpoint", referencesOf: "saveCheckpoint", reason: "who saves" },
              ],
              done: false,
            }
          : { followUps: [], done: true };
      },
      answer: flowAnswer,
      check: (call) => {
        const draft = flowAnswer(call) as { answer: string };
        const limit = lineCite(call, "src/config/retry.ts", "maxReplayAttempts");
        return {
          ...draft,
          verdict: "revised",
          issues: ["missing the retry limit"],
          answer: `${draft.answer}\n\nReplays are capped by \`RETRY_POLICY.maxReplayAttempts\`, which is 3 ${limit}.`,
        };
      },
    });
    const deepRecorder: Recorder = { reads: [], searches: [] };
    const deep = answered(
      await askProject(
        { question: FLOW, mode: "deep" },
        adapter(),
        services(deepModel, { recorder: deepRecorder }),
      ),
    );
    const kinds = deepModel.calls.map((call) => call.kind);
    expect(kinds[0]).toBe("plan");
    expect(kinds.slice(-2)).toEqual(["answer", "check"]);
    expect(deepRecorder.searches).toContain("RETRY_POLICY maxReplayAttempts");
    expect(deepRecorder.searches).toContain("saveCheckpoint");
    expect(deepRecorder.searches.length).toBeGreaterThan(fastRecorder.searches.length);
    expect(deepRecorder.reads.length).toBeGreaterThan(fastRecorder.reads.length);
    // The cross-check revision, not the first draft, is delivered, and its new claim is cited.
    expect(deep.answer.text).toContain("RETRY_POLICY.maxReplayAttempts");
    expect(deep.evidence.map((ref) => ref.path)).toContain("src/config/retry.ts");
    for (const [field, value] of Object.entries(deep.usage)) {
      if (field === "elapsedMs") continue;
      const limit = {
        retrievalPasses: DEFAULT_BUDGETS.deep.maxRetrievalPasses,
        sourceReads: DEFAULT_BUDGETS.deep.maxSourceReads,
        sourceBytes: DEFAULT_BUDGETS.deep.maxSourceBytes,
        modelCalls: DEFAULT_BUDGETS.deep.maxModelCalls,
        inputTokens: DEFAULT_BUDGETS.deep.maxInputTokens,
        outputTokens: DEFAULT_BUDGETS.deep.maxOutputTokens,
      }[field]!;
      expect(value).toBeLessThanOrEqual(limit);
    }
  });

  test("planner requests outside read-only search are ignored", async () => {
    const recorder: Recorder = { reads: [], searches: [] };
    const model = scriptedModel({
      plan: () => ({
        followUps: [
          { query: "checkpoint", path: "../../etc", run: "rm -rf /", url: "https://evil.example" },
        ],
      }),
      answer: flowAnswer,
    });
    answered(
      await askProject({ question: FLOW, mode: "deep" }, adapter(), services(model, { recorder })),
    );
    expect(recorder.searches).toContain("checkpoint");
    expect(recorder.reads.every((read) => !read.includes(".."))).toBe(true);
  });
});

describe("citations are validated against inspected evidence", () => {
  test("invented ids, out-of-range lines and unread paths are removed and disclosed", async () => {
    const model = scriptedModel({
      answer: (call) => {
        const recovery = idFor(call, "src/recovery/recover-run.ts")!;
        return {
          outcome: "supported",
          answer:
            `Recovery loads the newest checkpoint and replays it [${recovery}]. ` +
            "It also writes an audit log [E99] in `src/audit/log.ts:4` " +
            `and retries forever [${recovery}:900-905].`,
          rationale: "not_asked",
        };
      },
    });
    const response = answered(
      await askProject(
        { question: "How does a crashed run get resumed after the worker dies?" },
        adapter(),
        services(model),
      ),
    );
    expect(response.answer.outcome).toBe("partial");
    expect(response.answer.text).not.toContain("E99");
    expect(response.answer.text).not.toContain("src/audit/log.ts:4");
    expect(response.answer.text).not.toContain("900");
    expect(response.evidence.map((ref) => ref.path)).toEqual(["src/recovery/recover-run.ts"]);
    expect(response.answer.caveats[0]).toStartWith(
      "3 source references in the draft did not match",
    );
  });

  test("an answer with no valid citation is never delivered as supported", async () => {
    const model = scriptedModel({
      answer: () => ({
        outcome: "supported",
        answer: "Recovery is handled by a background daemon [E42].",
        rationale: "not_asked",
      }),
    });
    const response = answered(
      await askProject(
        { question: "How does a crashed run get resumed after the worker dies?" },
        adapter(),
        services(model),
      ),
    );
    expect(response.answer.outcome).toBe("unknown");
    expect(response.evidence).toEqual([]);
    expect(response.answer.caveats).toContain(
      "No statement in this answer could be tied to inspected evidence, so it is unverified.",
    );
    expect(response.suggestedMode).toBe("deep");
  });

  test("a prose path:line reference inside inspected evidence becomes a verified citation", async () => {
    const model = scriptedModel({
      answer: (call) => {
        const item = call.evidence.find((entry) => entry.path === "src/storage/checkpoints.ts")!;
        return {
          outcome: "supported",
          answer: `Checkpoints live in an in-memory map, see src/storage/checkpoints.ts:${item.startLine}.`,
          rationale: "not_asked",
        };
      },
    });
    const response = answered(
      await askProject(
        { question: "What does loadCheckpoint return when nothing is stored?" },
        adapter(),
        services(model),
      ),
    );
    expect(response.answer.outcome).toBe("supported");
    expect(response.evidence[0]!.path).toBe("src/storage/checkpoints.ts");
    expect(response.answer.text).toContain("](https://code.example/pilot/blob/");
  });
});

describe("stale docs, rationale and missing evidence", () => {
  test("stale docs produce a qualified conflict, even when the model calls it supported", async () => {
    for (const mode of ["fast", "deep"] as const) {
      const model = scriptedModel({
        answer: (call) => ({
          outcome: "supported",
          answer:
            `The docs say crashed runs are restarted by \`restartFromSnapshot\` [${idFor(call, "docs/recovery.md")}], ` +
            `but the code resumes them with \`resumeInterruptedRun\` [${idFor(call, "src/recovery/recover-run.ts")}].`,
          rationale: "not_asked",
        }),
      });
      const response = answered(
        await askProject(
          { question: "How does restartFromSnapshot work?", mode },
          adapter(),
          services(model),
        ),
      );
      expect(response.answer.outcome).toBe("conflicting");
      expect(response.answer.caveats.some((caveat) => caveat.includes("may be stale"))).toBe(true);
      // The model was told about the conflict research found.
      const synthesis = model.calls.find((call) => call.kind === "answer")!;
      expect(synthesis.request.prompt).toContain("Conflict found by research");
    }
  });

  test("undocumented rationale stays unknown and yields a question for people", async () => {
    const model = scriptedModel({
      answer: (call) => ({
        outcome: "supported",
        answer: `Recovery replays at most three times because the business wants low costs [${idFor(call, "src/config/retry.ts") ?? idFor(call, "src/recovery/recover-run.ts")}].`,
        rationale: "documented",
      }),
    });
    const response = answered(
      await askProject(
        { question: "Why does recovery replay a run at most three times?" },
        adapter(),
        services(model),
      ),
    );
    expect(response.suggestedHumanQuestion?.question).toContain("Why does recovery replay");
    expect(response.answer.caveats).toContain(
      "The answer described a reason that no cited documentation states, so the rationale is treated as unknown.",
    );

    const honest = scriptedModel({
      answer: (call) => ({
        outcome: "partial",
        answer: `The limit of three comes from \`RETRY_POLICY\` [${idFor(call, "src/config/retry.ts") ?? idFor(call, "src/recovery/recover-run.ts")}]. Why three was chosen is not documented at this revision.`,
        rationale: "unknown",
        humanQuestion: "Why was the replay limit set to three attempts?",
      }),
    });
    const second = answered(
      await askProject(
        { question: "Why does recovery replay a run at most three times?" },
        adapter(),
        services(honest),
      ),
    );
    expect(second.suggestedHumanQuestion).toEqual({
      question: "Why was the replay limit set to three attempts?",
      reason: expect.stringContaining("states the intent or rationale"),
    });
  });

  test("no matching evidence is an honest unknown without a model call", async () => {
    for (const mode of ["fast", "deep"] as const) {
      const model = scriptedModel({});
      const response = answered(
        await askProject(
          { question: "How is GraphQL federation configured?", mode },
          adapter(),
          services(model),
        ),
      );
      // Deep may plan new searches for a lexical miss; neither mode synthesizes from nothing.
      expect(model.calls.filter((call) => call.kind !== "plan")).toEqual([]);
      if (mode === "fast") expect(model.calls).toEqual([]);
      expect(response.answer.outcome).toBe("unknown");
      expect(response.evidence).toEqual([]);
      expect(response.answer.text).toContain("could not find source in the index");
      expect(response.suggestedMode).toBe(mode === "fast" ? "deep" : undefined);
    }
  });

  test("budget exhaustion is disclosed in the answer and caveats", async () => {
    const model = scriptedModel({ answer: flowAnswer });
    const response = answered(
      await askProject(
        { question: FLOW, mode: "fast" },
        adapter(),
        services(model, {
          engine: {
            research: {
              ...DEFAULT_RESEARCH_LIMITS,
              fast: { ...DEFAULT_RESEARCH_LIMITS.fast, maxPasses: 1 },
            },
          },
        }),
      ),
    );
    expect(response.answer.caveats).toContain("Research stopped at the fast limit maxPasses.");
    expect(response.answer.text).toContain("research stopped at the fast limit maxPasses");
    expect(response.answer.text).toContain('mode "deep"');
    expect(response.suggestedMode).toBe("deep");
    expect(response.mode.executed).toBe("fast");
  });

  test("overlong answers are shortened to the mode limit, not refused", async () => {
    const model = scriptedModel({
      answer: (call) => ({
        outcome: "supported",
        answer: Array.from(
          { length: 80 },
          (_, i) =>
            `Paragraph ${i} explains recovery in detail [${idFor(call, "src/recovery/recover-run.ts")}].`,
        ).join("\n\n"),
        rationale: "not_asked",
      }),
    });
    const budgets = {
      ...DEFAULT_BUDGETS,
      fast: { ...DEFAULT_BUDGETS.fast, maxAnswerChars: 2000 },
    };
    const response = answered(
      await askProject({ question: FLOW }, adapter(), services(model, { budgets })),
    );
    expect(response.answer.text.length).toBeLessThanOrEqual(2000);
    expect(response.answer.caveats).toContain(
      "The answer was shortened to fit the answer length limit.",
    );
  });

  test("an unparseable reply is retried once in Fast, then fails without answer text", async () => {
    let calls = 0;
    const model = scriptedModel({
      answer: (call) => {
        calls += 1;
        return calls === 1 ? "Sure! Here is the answer: recovery works." : flowAnswer(call);
      },
    });
    answered(await askProject({ question: FLOW }, adapter(), services(model)));
    expect(calls).toBe(2);

    const broken = scriptedModel({ answer: () => "not json" });
    const response = await askProject({ question: FLOW }, adapter(), services(broken));
    expect(response.status).toBe("failed");
    expect(broken.calls.length).toBe(2);
  });
});

describe("provider selection and fallback", () => {
  const quotaSpent = (id: string): ModelProvider & { calls: number } => {
    const provider = {
      id,
      calls: 0,
      async complete() {
        provider.calls += 1;
        throw new ProviderQuotaError(id, `${id} quota spent`, 60_000);
      },
    };
    return provider;
  };

  test("the selected provider serves; an exhausted unused fallback does not block", async () => {
    const primary = scriptedModel({ answer: flowAnswer }, { id: "primary" });
    const fallback = quotaSpent("backup");
    const router = new ProviderRouter({
      providers: [primary, fallback],
      policy: { selected: "primary", fallback: ["backup"] },
    });
    const response = answered(await askProject({ question: FLOW }, adapter(), services(router)));
    expect(response.providers).toEqual(["primary"]);
    expect(fallback.calls).toBe(0);
  });

  test("a spent selected provider falls back and is skipped while cooling down", async () => {
    const primary = quotaSpent("primary");
    const backup = scriptedModel({ answer: flowAnswer }, { id: "backup" });
    const router = new ProviderRouter({
      providers: [primary, backup],
      policy: { selected: "primary", fallback: ["backup"] },
    });
    for (let i = 0; i < 2; i += 1) {
      const response = answered(await askProject({ question: FLOW }, adapter(), services(router)));
      expect(response.providers).toEqual(["backup"]);
    }
    expect(primary.calls).toBe(1);
  });

  test("a local per-provider quota moves calls to the fallback", async () => {
    const primary = scriptedModel({ answer: flowAnswer }, { id: "primary" });
    const backup = scriptedModel({ answer: flowAnswer }, { id: "backup" });
    const router = new ProviderRouter({
      providers: [{ provider: primary, quota: { maxRequestsPerMinute: 1 } }, backup],
      policy: { selected: "primary", fallback: ["backup"] },
    });
    const first = answered(await askProject({ question: FLOW }, adapter(), services(router)));
    const second = answered(await askProject({ question: FLOW }, adapter(), services(router)));
    expect(first.providers).toEqual(["primary"]);
    expect(second.providers).toEqual(["backup"]);
  });

  test("the client's provider policy applies, and only configured providers can be chosen", async () => {
    const primary = scriptedModel({ answer: flowAnswer }, { id: "primary" });
    const backup = scriptedModel({ answer: flowAnswer }, { id: "backup" });
    const router = new ProviderRouter({
      providers: [primary, backup],
      policy: { selected: "primary" },
    });
    const chosen = answered(
      await askProject(
        { question: FLOW },
        adapter({ providerPolicy: { selected: "backup" } }),
        services(router),
      ),
    );
    expect(chosen.providers).toEqual(["backup"]);
    expect(primary.calls).toEqual([]);

    const unknown = await askProject(
      { question: FLOW },
      adapter({ providerPolicy: { selected: "elsewhere" } }),
      services(router),
    );
    expect(unknown).toMatchObject({ status: "failed", code: "provider_not_configured" });
  });

  test("no provider able to serve is unavailable, not a fabricated answer", async () => {
    const down: ModelProvider = {
      id: "down",
      complete: async () => {
        throw new LookyUnavailableError("down for maintenance");
      },
    };
    const router = new ProviderRouter({
      providers: [quotaSpent("primary"), down],
      policy: { selected: "primary", fallback: ["down"] },
    });
    const response = await askProject({ question: FLOW }, adapter(), services(router));
    expect(response.status).toBe("unavailable");
    expect("answer" in response).toBe(false);
  });
});

describe("cancellation, revocation and stale sessions", () => {
  test("cancellation during a model call stops the request with no further reads", async () => {
    const controller = new AbortController();
    const recorder: Recorder = { reads: [], searches: [] };
    let readsAtCancel = -1;
    const hanging: ModelProvider = {
      id: "hanging",
      complete: (_request, signal) =>
        new Promise((_resolve, reject) => {
          readsAtCancel = recorder.reads.length;
          signal.addEventListener("abort", () => reject(signal.reason));
          controller.abort();
        }),
    };
    const response = await askProject(
      { question: FLOW, mode: "deep" },
      adapter(),
      services(hanging, { recorder }),
      { signal: controller.signal },
    );
    expect(response.status).toBe("cancelled");
    expect(recorder.reads.length).toBe(readsAtCancel);
  });

  for (const reason of ["revoked", "stale_session"] as const) {
    test(`${reason} during Deep research stops reads and withholds the answer`, async () => {
      const recorder: Recorder = { reads: [], searches: [] };
      const context = makeContext({ repositoryId: "pilot", sha });
      const client = makeAdapter(context);
      client.decide = (call) => (call > 6 ? { allowed: false, reason } : { allowed: true });
      const model = scriptedModel({ answer: flowAnswer });
      const response = await askProject(
        { question: FLOW, mode: "deep" },
        client,
        services(model, { recorder }),
      );
      expect(response).toMatchObject({ status: "denied", reason });
      // Five accesses were authorized after the initial check; the next one was refused.
      expect(recorder.reads.length + recorder.searches.length).toBe(5);
      expect(model.calls).toEqual([]);
    });
  }

  test("a stale client generation at delivery withholds a finished answer", async () => {
    const context = makeContext({ repositoryId: "pilot", sha });
    const client = makeAdapter(context);
    const model = scriptedModel({ answer: flowAnswer });
    let finished = false;
    const wrapped: ModelProvider = {
      id: "scripted",
      complete: async (request, signal) => {
        const result = await model.complete(request, signal);
        finished = true;
        return result;
      },
    };
    client.decide = () =>
      finished ? { allowed: false, reason: "stale_session" } : { allowed: true };
    const response = await askProject({ question: FLOW }, client, services(wrapped));
    expect(response).toMatchObject({ status: "denied", reason: "stale_session" });
    expect(finished).toBe(true);
  });
});

describe("modes are distinct, never upgraded", () => {
  test("Fast never spends Deep's budget or runs Deep stages", async () => {
    for (const mode of ["fast", "deep"] as Mode[]) {
      const model = scriptedModel({ answer: flowAnswer });
      const response = answered(
        await askProject({ question: FLOW, mode }, adapter(), services(model)),
      );
      const kinds = new Set(model.calls.map((call) => call.kind));
      expect(kinds.has("plan")).toBe(mode === "deep");
      expect(kinds.has("check")).toBe(mode === "deep");
      expect(response.usage.modelCalls).toBeLessThanOrEqual(DEFAULT_BUDGETS[mode].maxModelCalls);
      expect(response.mode).toEqual({ requested: mode, executed: mode });
    }
  });
});
