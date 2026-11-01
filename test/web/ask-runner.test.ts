import { describe, expect, test } from "bun:test";
import {
  ApiError,
  type AskProjectResponse,
  type QuestionView,
  type RevisionState,
  type SubmitBody,
} from "../../web/src/api";
import {
  AskRunner,
  clampRetryAfter,
  type AskApi,
  type AskSnapshot,
  type AskState,
} from "../../web/src/ask-runner";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);

const SNAPSHOT: AskSnapshot = {
  question: "How does recovery work?",
  mode: "fast",
  repositoryId: "pilot",
  sha: SHA,
  revisionId: "rev_1",
  ref: "main",
};

function answered(overrides: Partial<Record<string, unknown>> = {}): AskProjectResponse {
  return {
    status: "answered",
    requestId: "req_1",
    mode: { requested: "fast", executed: "fast" },
    limitations: [],
    answer: { text: "Recovery replays the newest checkpoint.", outcome: "supported", caveats: [] },
    evidence: [{ path: "src/recover.ts", startLine: 1, endLine: 4 }],
    revision: { repositoryId: "pilot", sha: SHA, ref: "main" },
    index: { generationId: "gen_1", sha: SHA },
    scope: { source: "committed", sha: SHA, uncommittedChanges: "none" },
    usage: {
      retrievalPasses: 1,
      sourceReads: 1,
      sourceBytes: 10,
      modelCalls: 1,
      inputTokens: 10,
      outputTokens: 10,
      elapsedMs: 5,
    },
    providers: ["scripted"],
    ...overrides,
  } as AskProjectResponse;
}

function indexing(retryAfterMs = 3_000): AskProjectResponse {
  return {
    status: "indexing",
    requestId: "req_i",
    mode: { requested: "fast", executed: null },
    limitations: [],
    revision: { repositoryId: "pilot", sha: SHA },
    buildId: "build_1",
    progress: { phase: "chunking", filesDone: 3, filesTotal: 10 },
    retryAfterMs,
  };
}

function view(
  id: string,
  state: "running" | "completed",
  response?: AskProjectResponse,
  extra: Partial<QuestionView> = {},
): QuestionView {
  return {
    id,
    clientRequestId: "web_x",
    revisionId: SNAPSHOT.revisionId,
    repositoryId: SNAPSHOT.repositoryId,
    sha: SNAPSHOT.sha,
    mode: SNAPSHOT.mode,
    state,
    submittedAt: new Date(0).toISOString(),
    ...(response ? { response } : {}),
    ...extra,
  };
}

function revisionState(state: "building" | "ready" | "failed"): RevisionState {
  return {
    revision: {
      id: SNAPSHOT.revisionId,
      repositoryId: "pilot",
      sha: SHA,
      selectedAt: new Date(0).toISOString(),
      active: true,
    },
    index: { repositoryId: "pilot", sha: SHA, state },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A scripted API; each call takes the next scripted reply. */
class FakeApi implements AskApi {
  readonly submits: SubmitBody[] = [];
  readonly observes: string[] = [];
  readonly cancels: { id: string; keepalive: boolean }[] = [];
  readonly revisions: string[] = [];
  submitReplies: (() => Promise<QuestionView>)[] = [];
  observeReplies: ((signal?: AbortSignal) => Promise<QuestionView>)[] = [];
  revisionReplies: (() => Promise<RevisionState>)[] = [];
  cancelReply: (id: string) => Promise<QuestionView> = async (id) =>
    view(id, "completed", { ...indexing(), status: "cancelled" } as AskProjectResponse, {
      cancelRequested: true,
    });

  submit(body: SubmitBody): Promise<QuestionView> {
    this.submits.push(body);
    const next = this.submitReplies.shift();
    if (!next) throw new Error("unexpected submit");
    return next();
  }

  observe(id: string, _waitMs: number, signal?: AbortSignal): Promise<QuestionView> {
    this.observes.push(id);
    const next = this.observeReplies.shift();
    if (!next) throw new Error("unexpected observe");
    return next(signal);
  }

  cancel(id: string, keepalive = false): Promise<QuestionView> {
    this.cancels.push({ id, keepalive });
    return this.cancelReply(id);
  }

  revision(id: string): Promise<RevisionState> {
    this.revisions.push(id);
    const next = this.revisionReplies.shift();
    if (!next) throw new Error("unexpected revision");
    return next();
  }
}

/** An observe that only settles when aborted (like a long poll in flight). */
function hangingObserve(signal?: AbortSignal): Promise<QuestionView> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
      once: true,
    });
  });
}

function setup(options: Partial<ConstructorParameters<typeof AskRunner>[0]> = {}) {
  const api = new FakeApi();
  const states: AskState[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  let ids = 0;
  const runner = new AskRunner({
    api,
    onState: (state) => states.push(state),
    now: () => clock,
    sleep: async (ms, signal) => {
      sleeps.push(ms);
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      clock += ms;
      await Promise.resolve();
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
    },
    newRequestId: () => `web_request_${++ids}`,
    ...options,
  });
  const settled = async () => {
    for (let i = 0; i < 50; i += 1) await Promise.resolve();
    await Bun.sleep(1);
  };
  return { api, runner, states, sleeps, settled, advance: (ms: number) => (clock += ms) };
}

describe("ask runner", () => {
  test("submits once, long-polls and delivers the answer for its own snapshot", async () => {
    const { api, runner, states, settled } = setup();
    api.submitReplies.push(async () => view("q1", "running"));
    api.observeReplies.push(async () => view("q1", "running"));
    api.observeReplies.push(async () =>
      view("q1", "completed", answered(), { sourceLinks: ["https://code.example/a#L1-L4"] }),
    );
    expect(runner.ask(SNAPSHOT)).toBe(true);
    await settled();
    expect(api.submits).toEqual([
      {
        revisionId: "rev_1",
        question: SNAPSHOT.question,
        mode: "fast",
        clientRequestId: "web_request_1",
      },
    ]);
    expect(api.observes).toEqual(["q1", "q1"]);
    expect(states.map((state) => state.kind)).toEqual([
      "submitting",
      "running",
      "running",
      "result",
    ]);
    const last = states.at(-1)!;
    expect(last.kind === "result" && last.response.status).toBe("answered");
    expect(last.kind === "result" && last.sourceLinks).toEqual(["https://code.example/a#L1-L4"]);
    expect(runner.active).toBe(false);
  });

  test("a second ask while one is active is refused, so a double click pays once", async () => {
    const { api, runner, settled } = setup();
    const submit = deferred<QuestionView>();
    api.submitReplies.push(() => submit.promise);
    expect(runner.ask(SNAPSHOT)).toBe(true);
    expect(runner.ask(SNAPSHOT)).toBe(false);
    expect(runner.ask({ ...SNAPSHOT, mode: "deep" })).toBe(false);
    submit.resolve(view("q1", "completed", answered()));
    await settled();
    expect(api.submits).toHaveLength(1);
  });

  test("a lost submission is resent with the same clientRequestId, then stops", async () => {
    const { api, runner, states, settled, sleeps } = setup();
    for (let i = 0; i < 4; i += 1) {
      api.submitReplies.push(async () => {
        throw new ApiError(0, "network", "offline");
      });
    }
    runner.ask(SNAPSHOT);
    await settled();
    expect(api.submits).toHaveLength(4);
    expect(new Set(api.submits.map((body) => body.clientRequestId)).size).toBe(1);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    const last = states.at(-1)!;
    expect(last).toMatchObject({ kind: "error", code: "network", status: 0 });
  });

  test("detach stops reporting, cancels the question and ignores the late result", async () => {
    const { api, runner, states, settled } = setup();
    api.submitReplies.push(async () => view("q1", "running"));
    const late = deferred<QuestionView>();
    api.observeReplies.push(() => late.promise);
    runner.ask(SNAPSHOT);
    await settled();
    runner.detach();
    expect(states.at(-1)).toEqual({ kind: "idle" });
    const before = states.length;
    late.resolve(view("q1", "completed", answered()));
    await settled();
    expect(states).toHaveLength(before);
    expect(api.cancels).toEqual([{ id: "q1", keepalive: false }]);
    expect(runner.active).toBe(false);
  });

  test("detach after a question finished still clears its answer and actions", async () => {
    const { api, runner, states, settled } = setup();
    api.submitReplies.push(async () => view("q1", "completed", answered()));
    runner.ask(SNAPSHOT);
    await settled();
    expect(states.at(-1)).toMatchObject({ kind: "result" });
    expect(runner.active).toBe(false);
    runner.detach();
    expect(states.at(-1)).toEqual({ kind: "idle" });
    expect(api.cancels).toEqual([]);
  });

  test("leaving the page cancels with keepalive at once", async () => {
    const { api, runner, settled } = setup();
    api.submitReplies.push(async () => view("q1", "running"));
    api.observeReplies.push(hangingObserve);
    runner.ask(SNAPSHOT);
    await settled();
    runner.detach({ keepalive: true });
    expect(api.cancels).toEqual([{ id: "q1", keepalive: true }]);
    await settled();
    expect(api.cancels).toHaveLength(1);
  });

  test("detach before the submission returns cancels the question once it is known", async () => {
    const { api, runner, states, settled } = setup();
    const submit = deferred<QuestionView>();
    api.submitReplies.push(() => submit.promise);
    runner.ask(SNAPSHOT);
    runner.detach();
    submit.resolve(view("q1", "running"));
    await settled();
    expect(api.cancels.map((cancel) => cancel.id)).toEqual(["q1"]);
    expect(api.observes).toEqual([]);
    expect(states.at(-1)).toEqual({ kind: "idle" });
  });

  test("cancel is visible: cancelling, then cancelled, and the question is cancelled at Looky", async () => {
    const { api, runner, states, settled } = setup();
    api.submitReplies.push(async () => view("q1", "running"));
    api.observeReplies.push(hangingObserve);
    runner.ask(SNAPSHOT);
    await settled();
    runner.cancel();
    expect(states.at(-1)?.kind).toBe("cancelling");
    expect(runner.active).toBe(true);
    await settled();
    expect(api.cancels.map((cancel) => cancel.id)).toEqual(["q1"]);
    expect(states.at(-1)).toMatchObject({ kind: "cancelled", confirmed: true });
    expect(runner.active).toBe(false);
  });

  test("a cancel that loses the race shows the answer that already finished", async () => {
    const { api, runner, states, settled } = setup();
    api.submitReplies.push(async () => view("q1", "running"));
    api.observeReplies.push(hangingObserve);
    api.cancelReply = async (id) => view(id, "completed", answered(), { cancelRequested: false });
    runner.ask(SNAPSHOT);
    await settled();
    runner.cancel();
    await settled();
    expect(states.at(-1)).toMatchObject({ kind: "result", response: { status: "answered" } });
  });

  test("an unconfirmed cancel says so", async () => {
    const { api, runner, states, settled } = setup();
    api.submitReplies.push(async () => view("q1", "running"));
    api.observeReplies.push(hangingObserve);
    api.cancelReply = async () => {
      throw new ApiError(0, "network", "offline");
    };
    runner.ask(SNAPSHOT);
    await settled();
    runner.cancel();
    await settled();
    expect(states.at(-1)).toMatchObject({ kind: "cancelled", confirmed: false });
  });

  test("a result for another revision is discarded, never shown", async () => {
    const { api, runner, states, settled } = setup();
    api.submitReplies.push(async () => view("q1", "running"));
    api.observeReplies.push(async () =>
      view("q1", "completed", answered({ revision: { repositoryId: "pilot", sha: OTHER_SHA } })),
    );
    runner.ask(SNAPSHOT);
    await settled();
    expect(states.some((state) => state.kind === "result")).toBe(false);
    expect(states.at(-1)).toMatchObject({ kind: "error", code: "mismatch" });
    expect(api.cancels).toEqual([]);
  });

  test("a question view for another selection is discarded and cancelled", async () => {
    const { api, runner, states, settled } = setup();
    api.submitReplies.push(async () => view("q1", "running", undefined, { sha: OTHER_SHA }));
    runner.ask(SNAPSHOT);
    await settled();
    expect(states.at(-1)).toMatchObject({ kind: "error", code: "mismatch" });
    expect(api.cancels.map((cancel) => cancel.id)).toEqual(["q1"]);
  });

  test("indexing waits at the clamped retry-after, then asks again once ready", async () => {
    const { api, runner, states, sleeps, settled } = setup();
    api.submitReplies.push(async () => view("q1", "completed", indexing(100)));
    api.revisionReplies.push(async () => revisionState("building"));
    api.revisionReplies.push(async () => revisionState("ready"));
    api.submitReplies.push(async () => view("q2", "completed", answered()));
    runner.ask(SNAPSHOT);
    await settled();
    expect(sleeps).toEqual([1_000, 1_000]);
    expect(api.revisions).toEqual(["rev_1", "rev_1"]);
    expect(api.submits.map((body) => body.clientRequestId)).toEqual([
      "web_request_1",
      "web_request_2",
    ]);
    expect(api.submits.every((body) => body.mode === "fast")).toBe(true);
    const indexingState = states.find((state) => state.kind === "indexing");
    expect(indexingState).toMatchObject({
      progress: { phase: "chunking", filesDone: 3, filesTotal: 10 },
    });
    expect(states.at(-1)).toMatchObject({ kind: "result", response: { status: "answered" } });
  });

  test("waiting for an index is bounded and hands the choice back", async () => {
    const { api, runner, states, settled } = setup({ maxIndexWaitMs: 30_000 });
    api.submitReplies.push(async () => view("q1", "completed", indexing(15_000)));
    api.revisionReplies.push(async () => revisionState("building"));
    api.revisionReplies.push(async () => revisionState("building"));
    runner.ask(SNAPSHOT);
    await settled();
    expect(api.revisions).toHaveLength(2);
    expect(api.submits).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({
      kind: "result",
      waitEnded: true,
      response: { status: "indexing" },
    });
  });

  test("long polls are bounded; past the limit the question is cancelled", async () => {
    const { api, runner, states, settled } = setup({ maxPolls: 2 });
    api.submitReplies.push(async () => view("q1", "running"));
    api.observeReplies.push(async () => view("q1", "running"));
    api.observeReplies.push(async () => view("q1", "running"));
    runner.ask(SNAPSHOT);
    await settled();
    expect(api.observes).toHaveLength(2);
    expect(api.cancels.map((cancel) => cancel.id)).toEqual(["q1"]);
    expect(states.at(-1)).toMatchObject({ kind: "error", code: "wait_limit" });
  });

  test("busy, failed and Fast-suggests-Deep results are never retried or upgraded automatically", async () => {
    for (const response of [
      {
        status: "unavailable",
        requestId: "r",
        mode: { requested: "fast", executed: null },
        limitations: [],
        message: "busy",
        retryable: true,
        code: "busy",
        retryAfterMs: 2_000,
      },
      {
        status: "failed",
        requestId: "r",
        mode: { requested: "fast", executed: "fast" },
        limitations: [],
        stage: "answer",
        code: "budget_exhausted",
        message: "out",
        retryable: true,
        suggestedMode: "deep",
      },
      answered({ suggestedMode: "deep", answer: { text: "x", outcome: "partial", caveats: [] } }),
    ] as AskProjectResponse[]) {
      const { api, runner, states, settled } = setup();
      api.submitReplies.push(async () => view("q1", "completed", response));
      runner.ask(SNAPSHOT);
      await settled();
      expect(api.submits).toHaveLength(1);
      expect(api.submits[0]!.mode).toBe("fast");
      expect(states.at(-1)).toMatchObject({
        kind: "result",
        response: { status: response.status },
      });
    }
  });

  test("an expired session ends the run with its typed error", async () => {
    const { api, runner, states, settled } = setup();
    api.submitReplies.push(async () => {
      throw new ApiError(401, "session_expired", "The browser session expired; sign in again");
    });
    runner.ask(SNAPSHOT);
    await settled();
    expect(api.submits).toHaveLength(1);
    expect(states.at(-1)).toMatchObject({ kind: "error", status: 401, code: "session_expired" });
  });

  test("retry-after is clamped to a sane range", () => {
    expect(clampRetryAfter(undefined)).toBe(2_000);
    expect(clampRetryAfter(5)).toBe(1_000);
    expect(clampRetryAfter(3_000)).toBe(3_000);
    expect(clampRetryAfter(10 * 60_000)).toBe(15_000);
    expect(clampRetryAfter(Number.NaN)).toBe(2_000);
  });
});
