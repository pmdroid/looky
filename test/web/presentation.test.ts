import { describe, expect, test } from "bun:test";
import type { AskProjectResponse, IndexView } from "../../web/src/api";
import type { AskSnapshot } from "../../web/src/ask-runner";
import {
  describeAsk,
  describeIndex,
  describeProgress,
  describeResponse,
} from "../../web/src/presentation";

const SHA = "d".repeat(40);
const SNAPSHOT: AskSnapshot = {
  question: "q",
  mode: "fast",
  repositoryId: "pilot",
  sha: SHA,
  revisionId: "rev_1",
};

const base = { requestId: "r", limitations: [] };
const fast = { requested: "fast", executed: "fast" } as const;
const none = { requested: "fast", executed: null } as const;

describe("state copy and next actions", () => {
  test("every status has a title, and only explicit buttons start new research", () => {
    const responses: AskProjectResponse[] = [
      {
        ...base,
        status: "invalid_request",
        mode: none,
        error: { code: "question_empty", message: "Ask something." },
      },
      { ...base, status: "denied", mode: none, reason: "revoked", message: "Ended." },
      { ...base, status: "denied", mode: none, reason: "unauthorized", message: "No." },
      { ...base, status: "unsupported_revision", mode: none, message: "Not a commit." },
      {
        ...base,
        status: "indexing",
        mode: none,
        revision: { repositoryId: "pilot", sha: SHA },
        buildId: "b",
        progress: { phase: "chunking" },
        retryAfterMs: 2_000,
      },
      {
        ...base,
        status: "failed",
        mode: fast,
        stage: "answer",
        code: "provider_not_configured",
        message: "No provider.",
        retryable: false,
      },
      {
        ...base,
        status: "failed",
        mode: fast,
        stage: "answer",
        code: "budget_exhausted",
        message: "Ran out.",
        retryable: true,
        suggestedMode: "deep",
      },
      {
        ...base,
        status: "unavailable",
        mode: none,
        message: "Busy.",
        retryable: true,
        code: "busy",
        retryAfterMs: 4_000,
      },
      { ...base, status: "cancelled", mode: fast },
      { ...base, status: "timed_out", mode: fast, limitMs: 60_000 },
    ];
    const views = responses.map((response) => describeResponse(response));
    for (const view of views) {
      expect(view.title.length).toBeGreaterThan(0);
      expect(view.busy).toBe(false);
    }
    const [
      invalid,
      revoked,
      unauthorized,
      unsupported,
      indexing,
      broken,
      budget,
      busy,
      cancelled,
      timedOut,
    ] = views.map((view) => view.actions.map((action) => action.kind));
    expect(invalid).toEqual(["edit"]);
    expect(revoked).toEqual(["reselect"]);
    expect(unauthorized).toEqual([]);
    expect(unsupported).toEqual([]);
    expect(indexing).toEqual(["retry"]);
    expect(broken).toEqual([]);
    expect(budget).toEqual(["retry", "deep"]);
    expect(busy).toEqual(["retry"]);
    expect(views[7]!.actions[0]).toMatchObject({ notBeforeMs: 4_000 });
    expect(cancelled).toEqual(["retry"]);
    expect(timedOut).toEqual(["retry", "deep"]);
    expect(views[9]!.detail).toContain("60 s limit");
  });

  test("Deep is never offered for a Deep question", () => {
    const view = describeResponse({
      ...base,
      status: "timed_out",
      mode: { requested: "deep", executed: "deep" },
      limitMs: 120_000,
    });
    expect(view.actions.map((action) => action.kind)).toEqual(["retry"]);
  });

  test("progress is described only from supplied numbers, never invented", () => {
    expect(describeProgress(undefined)).toBeUndefined();
    expect(describeProgress({ phase: "listing_files" })).toBe("listing files");
    expect(describeProgress({ phase: "chunking", filesDone: 5 })).toBe("chunking: 5 files so far");
    expect(describeProgress({ phase: "chunking", filesDone: 5, filesTotal: 20 })).toBe(
      "chunking: 5 of 20 files",
    );
    for (const text of [
      describeProgress({ phase: "chunking", filesDone: 5, filesTotal: 20 }),
      describeAsk({ kind: "indexing", snapshot: SNAPSHOT, retryAfterMs: 2_000 })?.detail,
      describeAsk({ kind: "running", snapshot: SNAPSHOT, questionId: "q" })?.detail,
    ]) {
      expect(text).not.toContain("%");
    }
  });

  test("index readiness states", () => {
    const index = (state: IndexView["state"], extra: Partial<IndexView> = {}): IndexView => ({
      repositoryId: "pilot",
      sha: SHA,
      state,
      ...extra,
    });
    expect(describeIndex(index("ready")).tone).toBe("success");
    expect(describeIndex(index("building")).busy).toBe(true);
    expect(
      describeIndex(
        index("building", {
          active: {
            buildId: "b",
            state: "running",
            progress: { phase: "chunking", filesDone: 1, filesTotal: 2 },
          },
        }),
      ).text,
    ).toContain("1 of 2 files");
    expect(describeIndex(index("not_indexed")).text).toContain("Not indexed yet");
    expect(
      describeIndex(
        index("failed", { failure: { buildId: "b", code: "interrupted", retryable: true } }),
      ).text,
    ).toContain("starts a new attempt");
    expect(
      describeIndex(index("failed", { failure: { buildId: "b", code: "x", retryable: false } }))
        .text,
    ).toContain("Choose another revision");
  });

  test("in-flight states are busy and offer no research actions", () => {
    for (const state of [
      { kind: "submitting", snapshot: SNAPSHOT },
      { kind: "running", snapshot: SNAPSHOT, questionId: "q" },
      { kind: "indexing", snapshot: SNAPSHOT, retryAfterMs: 1_000 },
      { kind: "cancelling", snapshot: SNAPSHOT },
    ] as const) {
      const view = describeAsk(state)!;
      expect(view.busy).toBe(true);
      expect(view.actions).toEqual([]);
    }
    expect(describeAsk({ kind: "idle" })).toBeUndefined();
    expect(describeAsk({ kind: "cancelled", snapshot: SNAPSHOT, confirmed: true })!.title).toBe(
      "Cancelled",
    );
    expect(
      describeAsk({
        kind: "error",
        snapshot: SNAPSHOT,
        status: 404,
        code: "revision_not_found",
        message: "x",
      })!.actions.map((action) => action.kind),
    ).toEqual(["reselect"]);
  });
});
