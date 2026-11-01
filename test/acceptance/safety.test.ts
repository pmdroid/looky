/**
 * Acceptance: authorization, mode budgets and failure termination through
 * the real MCP tool interface and operational API. Covers repository and
 * workspace isolation, revocation, path escapes, enforced Fast and Deep
 * budgets, quota and outages, cancellation, retries, duplicate requests,
 * stale client generations and one-slot admission.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { LookyAnswerEngine } from "../../src/answer/engine";
import { LookyClient } from "../../src/client/looky-client";
import { BUDGET_FIELDS, DEFAULT_BUDGETS } from "../../src/contract/budgets";
import {
  LookyUnavailableError,
  ProviderQuotaError,
  type ModelProvider,
} from "../../src/contract/ports";
import type { UsageCounters } from "../../src/contract/response";
import { DEFAULT_RESEARCH_LIMITS } from "../../src/retrieval/research";
import { GitSourceReader, SourceRangeError } from "../../src/source/git-source-reader";
import { answerOf, otherClient, rpcId, startLooky, type Looky } from "../support/acceptance";
import { commitAll, initRepo, write } from "../support/git-fixture";
import { refreshPilotRepo } from "../support/pilot-fixture";
import { scriptedModel } from "../support/scripted-model";
import {
  citingModel,
  createFixture,
  gatedModel,
  QUESTION,
  type Fixture,
} from "../support/service-fixture";

let fixture: Fixture;
let looky: Looky | undefined;

beforeEach(() => {
  fixture = createFixture("looky-accept-safe-");
});

afterEach(async () => {
  await looky?.stop().catch(() => undefined);
  looky = undefined;
  await fixture.close();
});

async function ready(instance: Looky, buildId: string | undefined): Promise<void> {
  if (buildId) expect((await instance.service.index.waitForBuild(buildId)).state).toBe("ready");
}

function idle(instance: Looky): void {
  const capacity = instance.service.info().capacity;
  expect(capacity.asksActive).toBe(0);
  expect(capacity.asksQueued).toBe(0);
  expect(capacity.requestsInFlight).toBe(0);
}

describe("authorization and isolation", () => {
  const LEDGER = "computeAcmeLedgerSecret";

  function billingRepo(): { path: string; sha: string } {
    const path = join(fixture.root, "billing");
    mkdirSync(path);
    initRepo(path);
    write(
      path,
      "src/ledger.ts",
      `/** Acme-only ledger with checkpoint replay. */\nexport function ${LEDGER}(): number {\n  return 42;\n}\n`,
    );
    return { path, sha: commitAll(path, "billing") };
  }

  test("clients reach only their repositories across sessions, status, builds, search and answers", async () => {
    const billing = billingRepo();
    const acme = otherClient("acme", ["billing"]);
    const model = citingModel();
    looky = startLooky(
      fixture,
      {
        provider: model,
        repositories: new Map([
          ["pilot", { id: "pilot", path: fixture.repo }],
          ["billing", { id: "billing", path: billing.path }],
        ]),
      },
      [acme.config],
    );
    const acmeClient = new LookyClient({ url: looky.http.url, token: acme.token });

    // Acme indexes its own repository.
    const acmeAgent = await looky.open({ repositoryId: "billing", sha: billing.sha }, acmeClient);
    await ready(looky, acmeAgent.registered.index.active?.buildId);
    const acmeView = await acmeClient.indexStatus("billing", billing.sha);
    const acmeBuild = acmeView.ready!.buildId;

    // Paws can neither register for, inspect nor operate on it, and the build looks absent.
    await expect(looky.open({ repositoryId: "billing", sha: billing.sha })).rejects.toMatchObject({
      status: 403,
      code: "repository_not_authorized",
    });
    await expect(looky.client.indexStatus("billing", billing.sha)).rejects.toMatchObject({
      status: 403,
    });
    for (const call of [
      () => looky!.client.retry(acmeBuild),
      () => looky!.client.cancelBuild(acmeBuild),
      () => looky!.client.rebuild("billing", billing.sha),
    ]) {
      await expect(call()).rejects.toMatchObject({ status: expect.any(Number) });
    }
    expect(looky.service.index.status(acmeBuild)?.state).toBe("ready");
    expect((await looky.client.service()).repositories).toEqual(["pilot"]);

    // Paws questions about Acme's code never search or read Acme's index.
    const paws = await looky.open();
    const seen = model.calls.length;
    const result = await paws.ask({ question: `What does ${LEDGER} return?`, mode: "deep" });
    const text = JSON.stringify(result);
    expect(text).not.toContain(LEDGER.slice(0, 15) + "(");
    expect(text).not.toContain("src/ledger.ts");
    for (const call of model.calls.slice(seen)) {
      expect(call.evidence.every((item) => item.path !== "src/ledger.ts")).toBe(true);
      expect(call.request.prompt).not.toContain("Acme-only ledger");
    }
  });

  test("request keys and results never leak between sessions or workspaces", async () => {
    const model = citingModel();
    looky = startLooky(fixture, { provider: model });
    const a = await looky.open({ taskId: "task-a", snapshotId: "workspace-a" });
    const b = await looky.open({ taskId: "task-b", snapshotId: "workspace-b" });
    const first = answerOf(await a.ask({ question: QUESTION }, { requestKey: "shared-key" }));
    const second = answerOf(await b.ask({ question: QUESTION }, { requestKey: "shared-key" }));
    expect(second.requestId).not.toBe(first.requestId);
    expect(first.revision.snapshotId).toBe("workspace-a");
    expect(second.revision.snapshotId).toBe("workspace-b");
    expect(model.calls.filter((call) => call.kind === "answer")).toHaveLength(2);
  });

  test("revocation during research stops reads and delivery, then denies every tool", async () => {
    const gated = gatedModel(citingModel());
    looky = startLooky(fixture, { provider: gated.provider });
    const agent = await looky.open();
    await ready(looky, agent.registered.index.active?.buildId);

    const pending = agent.ask({ question: QUESTION, mode: "deep" });
    await gated.firstCall;
    await looky.client.revokeSession(agent.sessionId);
    gated.release();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ status: "denied", reason: "revoked" });
    expect("answer" in result.structuredContent).toBe(false);
    expect(result.content[0]!.text).not.toContain("checkpoint");
    expect(gated.signals[0]!.aborted).toBe(true);

    expect((await agent.ask({ question: QUESTION })).structuredContent).toMatchObject({
      status: "denied",
      reason: "revoked",
    });
    expect(await agent.indexStatus()).toMatchObject({ status: "denied", reason: "revoked" });
    idle(looky);
  });

  test("source paths that escape the pinned tree fail closed", async () => {
    const reader = new GitSourceReader((id) => (id === "pilot" ? fixture.repo : undefined));
    const signal = new AbortController().signal;
    const read = (path: string, repositoryId = "pilot") =>
      reader.read(
        { repositoryId, sha: fixture.sha, path, startLine: 1, endLine: 1, maxBytes: 1_000 },
        signal,
      );
    for (const path of [
      "../pilot/README.md",
      "./README.md",
      "/etc/passwd",
      "src/../README.md",
      ".git/config",
      "src\\recovery\\recover-run.ts",
    ]) {
      await expect(read(path)).rejects.toBeInstanceOf(SourceRangeError);
    }
    await expect(read("README.md", "billing")).rejects.toBeInstanceOf(LookyUnavailableError);
    expect((await read("README.md")).text).toBe("# Pilot\n");
  });
});

describe("Fast and Deep budgets", () => {
  function within(usage: UsageCounters, mode: "fast" | "deep"): void {
    const budget = DEFAULT_BUDGETS[mode];
    expect(usage.retrievalPasses).toBeLessThanOrEqual(budget.maxRetrievalPasses);
    expect(usage.sourceReads).toBeLessThanOrEqual(budget.maxSourceReads);
    expect(usage.sourceBytes).toBeLessThanOrEqual(budget.maxSourceBytes);
    expect(usage.modelCalls).toBeLessThanOrEqual(budget.maxModelCalls);
    expect(usage.inputTokens).toBeLessThanOrEqual(budget.maxInputTokens);
    expect(usage.outputTokens).toBeLessThanOrEqual(budget.maxOutputTokens);
  }

  test("Fast is the default; Deep runs a different, larger and still finite research", async () => {
    let plans = 0;
    // A planner that always wants more: only Looky's limits can stop Deep.
    const model = scriptedModel({
      plan: () => ({
        followUps: [{ query: `checkpoint replay attempt ${plans++}` }],
        done: false,
      }),
      answer: (call) => ({
        outcome: "supported",
        answer: `Recovery loads the newest checkpoint and replays it [${call.evidence[0]!.id}].`,
        rationale: "not_asked",
      }),
    });
    looky = startLooky(fixture, {
      provider: model,
      engine: new LookyAnswerEngine({ research: DEFAULT_RESEARCH_LIMITS, deepRounds: 50 }),
    });
    const agent = await looky.open();

    const fastCalls = model.calls.length;
    const fast = answerOf(await agent.ask({ question: QUESTION }));
    const fastKinds = model.calls.slice(fastCalls).map((call) => call.kind);
    const deepCalls = model.calls.length;
    const deep = answerOf(await agent.ask({ question: QUESTION, mode: "deep" }));
    const deepKinds = model.calls.slice(deepCalls).map((call) => call.kind);

    expect(fast.mode).toEqual({ requested: "fast", executed: "fast" });
    expect(deep.mode).toEqual({ requested: "deep", executed: "deep" });
    expect(fastKinds).toEqual(["answer"]);
    expect(deepKinds[0]).toBe("plan");
    expect(deepKinds).toContain("check");
    within(fast.usage, "fast");
    within(deep.usage, "deep");
    expect(deep.usage.retrievalPasses).toBeGreaterThan(DEFAULT_BUDGETS.fast.maxRetrievalPasses);
    expect(deep.usage.modelCalls).toBeGreaterThan(fast.usage.modelCalls);
    // Each model call was capped at its mode's output allowance.
    for (const call of model.calls.slice(fastCalls, deepCalls)) {
      expect(call.request.maxOutputTokens).toBeLessThanOrEqual(
        DEFAULT_BUDGETS.fast.maxOutputTokens,
      );
    }
    expect(plans).toBeLessThan(50);
  });

  test("Fast cannot silently escalate: thin evidence and tight limits suggest Deep and stay Fast", async () => {
    // Honest about the unanswerable question, citing for the recovery one.
    const model = scriptedModel({
      answer: (call) =>
        call.question.includes("GraphQL")
          ? {
              outcome: "unknown",
              answer: "The inspected evidence does not show any GraphQL schema or federation.",
              rationale: "not_asked",
            }
          : {
              outcome: "supported",
              answer: `Recovery loads the newest checkpoint [${call.evidence[0]!.id}].`,
              rationale: "not_asked",
            },
    });
    looky = startLooky(fixture, { provider: model });
    const agent = await looky.open({ budgetLimits: { fast: { maxSourceReads: 1 } } });
    const seen = model.calls.length;
    const results = [
      await agent.ask({ question: "How is the GraphQL schema federated across services?" }),
      await agent.ask({ question: QUESTION }),
    ];
    for (const result of results) {
      const response = result.structuredContent;
      expect(response.mode.requested).toBe("fast");
      expect(response.mode.executed).toBe("fast");
      if (response.status === "answered") {
        expect(response.usage.sourceReads).toBeLessThanOrEqual(1);
        within(response.usage, "fast");
      } else {
        expect(response).toMatchObject({ status: "failed", code: "budget_exhausted" });
      }
      expect("suggestedMode" in response && response.suggestedMode).toBe("deep");
    }
    expect(model.calls.slice(seen).every((call) => call.kind === "answer")).toBe(true);
  });

  test("adapter limits only tighten, never raise, either mode", async () => {
    const model = citingModel();
    looky = startLooky(fixture, { provider: model });
    const raised = Object.fromEntries(BUDGET_FIELDS.map((field) => [field, 10_000_000]));
    const agent = await looky.open({ budgetLimits: { fast: raised, deep: raised } });
    const fast = answerOf(await agent.ask({ question: QUESTION }));
    within(fast.usage, "fast");
    for (const call of model.calls) {
      expect(call.request.maxOutputTokens).toBeLessThanOrEqual(
        DEFAULT_BUDGETS.fast.maxOutputTokens,
      );
    }
  });
});

describe("failures terminate safely", () => {
  test("quota and outages are retryable unavailability; a retry with the same key answers", async () => {
    const inner = citingModel();
    let failure: Error | undefined = new ProviderQuotaError("flaky", "quota spent", 1_000);
    const provider: ModelProvider = {
      id: "flaky",
      async complete(request, signal) {
        if (failure) throw failure;
        return inner.complete(request, signal);
      },
    };
    looky = startLooky(fixture, { provider });
    const agent = await looky.open();
    for (const error of [failure, new LookyUnavailableError("provider is down")]) {
      failure = error;
      const result = await agent.ask({ question: QUESTION }, { requestKey: "retry-key" });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "unavailable", retryable: true });
      expect(result.content[0]!.text).toStartWith("Not answered:");
    }
    failure = undefined;
    const retried = answerOf(await agent.ask({ question: QUESTION }, { requestKey: "retry-key" }));
    // A redelivery after success returns the stored answer, without new work.
    const again = answerOf(await agent.ask({ question: QUESTION }, { requestKey: "retry-key" }));
    expect(again.requestId).toBe(retried.requestId);
    expect(inner.calls.filter((call) => call.kind === "answer")).toHaveLength(1);
    idle(looky);
  });

  test("duplicate deliveries share one piece of work; cancelling one caller keeps the other", async () => {
    const inner = citingModel();
    const gated = gatedModel(inner);
    looky = startLooky(fixture, { provider: gated.provider });
    const agent = await looky.open();
    await ready(looky, agent.registered.index.active?.buildId);

    const leavingId = rpcId();
    const leaving = agent.ask({ question: QUESTION }, { requestKey: "dup", id: leavingId });
    const staying = agent.ask({ question: QUESTION }, { requestKey: "dup" });
    await gated.firstCall;
    expect(await agent.cancel(leavingId)).toBe(202);
    expect((await leaving).structuredContent.status).toBe("cancelled");
    expect(gated.signals[0]!.aborted).toBe(false);
    gated.release();
    answerOf(await staying);
    expect(inner.calls.filter((call) => call.kind === "answer")).toHaveLength(1);
    idle(looky);
  });

  test("a superseded client generation gets no result for running work", async () => {
    const gated = gatedModel(citingModel());
    looky = startLooky(fixture, { provider: gated.provider });
    const old = await looky.open();
    await ready(looky, old.registered.index.active?.buildId);
    const pending = old.ask({ question: QUESTION });
    await gated.firstCall;
    const current = await looky.open({ sequence: 2, clientGeneration: "run-2" });
    expect(current.registered.superseded).toEqual([old.sessionId]);
    gated.release();
    const result = await pending;
    expect(result.structuredContent).toMatchObject({ status: "denied", reason: "stale_session" });
    expect(gated.signals[0]!.aborted).toBe(true);
    answerOf(await current.ask({ question: QUESTION }));
    idle(looky);
  });

  test("with one question slot, indexing never waits for the slot and a busy slot refuses at once", async () => {
    const gated = gatedModel(citingModel());
    looky = startLooky(fixture, {
      provider: gated.provider,
      executor: "worker",
      capacity: { maxConcurrentAsks: 1, maxQueuedAsks: 0, indexWaitMs: 200 },
    });
    const holder = await looky.open({ taskId: "holder" });
    await ready(looky, holder.registered.index.active?.buildId);
    const holding = holder.ask({ question: QUESTION });
    await gated.firstCall;

    // Another task's new revision builds on Looky's own worker, not on a slot.
    const next = refreshPilotRepo(fixture.repo);
    const other = await looky.open({ taskId: "other", sha: next });
    let started = Date.now();
    const first = (await other.ask({ question: QUESTION })).structuredContent;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(["indexing", "unavailable"]).toContain(first.status);
    if (first.status === "indexing") await ready(looky, first.buildId);
    else await ready(looky, other.registered.index.active?.buildId);

    started = Date.now();
    const busy = (await other.ask({ question: QUESTION })).structuredContent;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(busy).toMatchObject({ status: "unavailable", code: "busy", retryable: true });

    gated.release();
    answerOf(await holding);
    expect(answerOf(await other.ask({ question: QUESTION })).index.sha).toBe(next);
    idle(looky);
  });
});
