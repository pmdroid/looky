/**
 * Acceptance: revision-correct answers through the real MCP tool interface.
 * Covers incremental refresh of added, edited, deleted and renamed files,
 * concurrent old- and new-revision questions, and a branch that advances
 * while research is running.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LookyAnswerEngine } from "../../src/answer/engine";
import { DEFAULT_RESEARCH_LIMITS } from "../../src/retrieval/research";
import {
  answerOf,
  expectEvidenceAt,
  expectPromptEvidenceAt,
  linesAt,
  startLooky,
  treePaths,
  type Looky,
} from "../support/acceptance";
import { commitAll, write } from "../support/git-fixture";
import { refreshPilotRepo } from "../support/pilot-fixture";
import { idFor, scriptedModel, type ScriptedCall } from "../support/scripted-model";
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
  fixture = createFixture("looky-accept-fresh-");
});

afterEach(async () => {
  await looky?.stop().catch(() => undefined);
  looky = undefined;
  await fixture.close();
});

/** True when every evidence line a model saw is exactly that line at `sha`. */
function shownAt(call: ScriptedCall, sha: string): boolean {
  const paths = treePaths(fixture.repo, sha);
  return call.evidence.every((item) => {
    if (!paths.has(item.path)) return false;
    const lines = linesAt(fixture.repo, sha, item.path);
    return item.text.split("\n").every((line) => {
      const match = /^(\d+)\| (.*)$/.exec(line);
      return !match || lines[Number(match[1]) - 1] === match[2]!.replaceAll("​", "");
    });
  });
}

describe("incremental refresh", () => {
  test("added, edited, deleted and renamed files refresh exactly and old paths never leak", async () => {
    const model = citingModel();
    looky = startLooky(fixture, { provider: model });
    const before = await looky.open();
    const old = answerOf(await before.ask({ question: QUESTION }));
    expect(old.evidence.map((ref) => ref.path)).toContain("src/recovery/recover-run.ts");

    // Rename recover-run.ts to resume.ts, delete the supervisor, edit
    // checkpoints and the test, and add a new backoff module.
    refreshPilotRepo(fixture.repo);
    write(
      fixture.repo,
      "src/recovery/backoff.ts",
      "/** Delay before the next replay attempt. */\nexport function replayBackoffMs(attempt: number): number {\n  return 500 * 2 ** attempt;\n}\n",
    );
    const next = commitAll(fixture.repo, "add backoff");

    const after = await looky.open({ sequence: 2, clientGeneration: "run-2", sha: next });
    const seen = model.calls.length;
    const questions = [
      { question: QUESTION, mode: "deep" },
      { question: "How does onWorkerExit hand a crashed run to recovery?", mode: "fast" },
      { question: "What does pruneCheckpoints return?", mode: "fast" },
      { question: "How is replayBackoffMs computed?", mode: "fast" },
    ];
    const answers = [];
    for (const args of questions) answers.push(answerOf(await after.ask(args)));
    for (const answer of answers) {
      expect(answer.index.sha).toBe(next);
      for (const ref of answer.evidence) {
        expect(ref.path).not.toBe("src/recovery/recover-run.ts");
        expect(ref.path).not.toBe("src/worker/supervisor.ts");
      }
    }
    expectEvidenceAt(answers[0]!, fixture.repo, next);
    expect(answers[0]!.evidence.map((ref) => ref.path)).toContain("src/recovery/resume.ts");

    // No model ever saw a deleted or pre-rename path, or a line from the old revision.
    const shown = model.calls.slice(seen);
    const shownPaths = new Set(shown.flatMap((call) => call.evidence.map((item) => item.path)));
    expect(shownPaths.has("src/recovery/recover-run.ts")).toBe(false);
    expect(shownPaths.has("src/worker/supervisor.ts")).toBe(false);
    expect(shownPaths.has("src/recovery/backoff.ts")).toBe(true);
    expect(
      shown.some((call) => call.evidence.some((item) => item.text.includes("pruneCheckpoints"))),
    ).toBe(true);
    expectPromptEvidenceAt(shown, fixture.repo, next);

    // The refresh was incremental and reused the renamed file's unchanged chunks.
    const build = looky.service.index.status(answers[0]!.index.generationId)!;
    expect(build.refresh).toMatchObject({
      mode: "incremental",
      baseBuildId: old.index.generationId,
      baseSha: fixture.sha,
      added: 1,
      modified: 2,
      deleted: 1,
      renamed: 1,
    });
    expect(build.refresh.carried).toBeGreaterThan(0);
    expect(build.filesReused).toBeGreaterThanOrEqual(1);
  });
});

describe("revisions never mix", () => {
  test("concurrent old- and new-revision questions each see only their own revision", async () => {
    const inner = citingModel();
    const gated = gatedModel(inner);
    looky = startLooky(fixture, {
      provider: gated.provider,
      capacity: { maxConcurrentAsks: 2 },
    });
    const oldAgent = await looky.open({ taskId: "old-task" });
    const next = refreshPilotRepo(fixture.repo);
    const newAgent = await looky.open({ taskId: "new-task", sha: next });
    // Both generations are ready before the race starts.
    await looky.service.index.resolve(
      { repositoryId: "pilot", sha: next },
      new AbortController().signal,
    );

    const asks = [
      oldAgent.ask({ question: QUESTION, mode: "deep" }),
      newAgent.ask({ question: QUESTION, mode: "deep" }),
      oldAgent.ask({ question: "Where is the retry policy configured?" }),
      newAgent.ask({ question: "Where is the retry policy configured?" }),
    ];
    await gated.firstCall;
    gated.release();
    const [oldDeep, newDeep, oldFast, newFast] = (await Promise.all(asks)).map(answerOf);

    for (const answer of [oldDeep!, oldFast!]) {
      expect(answer.index.sha).toBe(fixture.sha);
      expectEvidenceAt(answer, fixture.repo, fixture.sha);
    }
    for (const answer of [newDeep!, newFast!]) {
      expect(answer.index.sha).toBe(next);
      expectEvidenceAt(answer, fixture.repo, next);
    }
    expect(oldDeep!.index.generationId).not.toBe(newDeep!.index.generationId);
    expect(oldDeep!.evidence.map((ref) => ref.path)).toContain("src/recovery/recover-run.ts");
    expect(newDeep!.evidence.map((ref) => ref.path)).toContain("src/recovery/resume.ts");

    // Every single model call saw evidence from exactly one revision.
    expect(inner.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of inner.calls) {
      expect(shownAt(call, fixture.sha) || shownAt(call, next)).toBe(true);
    }
    expect(inner.calls.some((call) => shownAt(call, fixture.sha) && !shownAt(call, next))).toBe(
      true,
    );
    expect(inner.calls.some((call) => shownAt(call, next) && !shownAt(call, fixture.sha))).toBe(
      true,
    );
  });

  test("a branch that advances during Deep research does not change the pinned answer", async () => {
    let planned = 0;
    const inner = scriptedModel({
      // Deep follow-ups run after the branch moved: they must still read the pinned commit.
      plan: () =>
        planned++ === 0
          ? {
              followUps: [
                { query: "RETRY_POLICY maxReplayAttempts", definitionOf: "RETRY_POLICY" },
                { query: "saveCheckpoint", referencesOf: "saveCheckpoint" },
              ],
              done: false,
            }
          : { followUps: [], done: true },
      answer: (call) => ({
        outcome: "supported",
        answer: `Recovery replays from the newest checkpoint [${idFor(call, "src/recovery/recover-run.ts") ?? call.evidence[0]!.id}].`,
        rationale: "not_asked",
      }),
    });
    const gated = gatedModel(inner);
    looky = startLooky(fixture, {
      provider: gated.provider,
      engine: new LookyAnswerEngine({ research: DEFAULT_RESEARCH_LIMITS, deepRounds: 2 }),
    });
    const agent = await looky.open({ ref: "main" });
    const prewarm = agent.registered.index.active?.buildId;
    if (prewarm) await looky.service.index.waitForBuild(prewarm);

    const pending = agent.ask({ question: QUESTION, mode: "deep" });
    await gated.firstCall;
    // The branch advances and the worktree gets dirty while research is paused.
    const MARKER = "BRANCH_ADVANCED_MARKER_5c1e";
    write(
      fixture.repo,
      "src/config/retry.ts",
      `export const RETRY_POLICY = { maxReplayAttempts: 99, note: "${MARKER}" } as const;\n`,
    );
    write(fixture.repo, "src/recovery/recover-run.ts", `// ${MARKER}\n`);
    const moved = commitAll(fixture.repo, "advance main");
    write(fixture.repo, "src/storage/checkpoints.ts", `// dirty ${MARKER}\n`);
    gated.release();

    const answer = answerOf(await pending);
    expect(moved).not.toBe(fixture.sha);
    expect(answer.index.sha).toBe(fixture.sha);
    expect(answer.revision).toMatchObject({ sha: fixture.sha, ref: "main" });
    expect(answer.limitations.join(" ")).toContain("Later movement of main is not reflected");
    expectEvidenceAt(answer, fixture.repo, fixture.sha);
    expect(planned).toBeGreaterThanOrEqual(1);
    expect(inner.calls.length).toBeGreaterThanOrEqual(3);
    for (const call of inner.calls) {
      expect(call.request.prompt).not.toContain(MARKER);
      expect(shownAt(call, fixture.sha)).toBe(true);
    }
    expect(JSON.stringify(answer)).not.toContain(MARKER);
  });
});
