/**
 * Acceptance: index lifecycle through the real MCP tool interface, with a
 * real Git repository and real SQLite storage. Covers initial indexing,
 * restart/reopen, rebuild, failed-build retry, a process killed between
 * staging and publishing, and missing or stale indexes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { loadIndexConfig } from "../../src/config";
import { DEFAULT_INDEX_LIMITS } from "../../src/indexing/policy";
import { searchChunks } from "../../src/indexing/store";
import {
  answerOf,
  expectEvidenceAt,
  expectPromptEvidenceAt,
  startLooky,
  type Looky,
} from "../support/acceptance";
import { refreshPilotRepo } from "../support/pilot-fixture";
import { citingModel, createFixture, QUESTION, type Fixture } from "../support/service-fixture";

let fixture: Fixture;
const running: Looky[] = [];

function looky(options: Parameters<typeof startLooky>[1] = {}): Looky {
  const started = startLooky(fixture, options);
  running.push(started);
  return started;
}

async function stop(instance: Looky): Promise<void> {
  running.splice(running.indexOf(instance), 1);
  await instance.stop();
}

beforeEach(() => {
  fixture = createFixture("looky-accept-life-");
});

afterEach(async () => {
  for (const instance of running.splice(0)) await instance.stop().catch(() => undefined);
  await fixture.close();
});

describe("initial indexing, restart, rebuild and retry", () => {
  test("first use indexes, a restart reopens the same generation, and a rebuild replaces it", async () => {
    const model = citingModel();
    const first = looky({ provider: model, capacity: { indexWaitMs: 0 } });
    const agent = await first.open();
    // Registration starts the build for the task's exact SHA.
    expect(agent.registered.index.state).toBe("building");

    const indexing = await agent.ask({ question: QUESTION });
    expect(indexing.isError).toBe(true);
    expect(indexing.structuredContent.status).toBe("indexing");
    expect(indexing.content[0]!.text).not.toContain("checkpoint");
    expect(model.calls).toHaveLength(0);
    const buildId =
      indexing.structuredContent.status === "indexing" ? indexing.structuredContent.buildId : "";
    expect((await first.service.index.waitForBuild(buildId)).state).toBe("ready");
    expect(await agent.indexStatus()).toMatchObject({ state: "ready" });

    const answered = answerOf(await agent.ask({ question: QUESTION }));
    expect(answered.index).toEqual({ generationId: buildId, sha: fixture.sha });
    expectEvidenceAt(answered, fixture.repo, fixture.sha);
    expectPromptEvidenceAt(model.calls, fixture.repo, fixture.sha);
    await stop(first);

    // Restart on the same data directory: the published generation is reused.
    const second = looky({ provider: citingModel() });
    const reopened = await second.open();
    expect(reopened.registered.index.state).toBe("ready");
    const afterRestart = answerOf(await reopened.ask({ question: QUESTION }));
    expect(afterRestart.index.generationId).toBe(buildId);
    expect(second.service.index.builds({ repositoryId: "pilot" })).toHaveLength(1);

    // An operator rebuild publishes a new generation and retires the old one.
    const rebuilding = await second.client.rebuild("pilot", fixture.sha);
    expect(rebuilding.ready?.buildId).toBe(buildId);
    const rebuildId = rebuilding.active!.buildId;
    expect((await second.service.index.waitForBuild(rebuildId)).state).toBe("ready");
    const rebuilt = answerOf(await reopened.ask({ question: "Where are checkpoints loaded?" }));
    expect(rebuilt.index.generationId).toBe(rebuildId);
    // The old generation is retired, and collected once no reader holds it.
    expect((await second.client.indexStatus("pilot", fixture.sha)).ready?.buildId).toBe(rebuildId);
    expect(second.service.index.status(buildId)?.retiredAt ?? "collected").not.toBeNull();
  });

  test("a failed build is reported, survives a restart unretried, and an explicit retry recovers", async () => {
    const index = loadIndexConfig({});
    const failing = looky({
      index: { ...index, limits: { ...DEFAULT_INDEX_LIMITS, maxFileBytes: 65_536, maxFiles: 3 } },
    });
    const agent = await failing.open();
    const failed = (await agent.ask({ question: QUESTION })).structuredContent;
    expect(failed).toMatchObject({
      status: "failed",
      stage: "index",
      code: "index_failed",
      retryable: false,
      mode: { requested: "fast", executed: null },
    });
    const failedId = failed.status === "failed" ? failed.buildId! : "";
    await stop(failing);

    // The limit that failed is fixed, but a deterministic failure is not retried on its own.
    const fixed = looky();
    const again = await fixed.open();
    const still = (await again.ask({ question: QUESTION })).structuredContent;
    expect(still).toMatchObject({ status: "failed", buildId: failedId });

    const retried = await fixed.client.retry(failedId);
    const retryId = retried.active!.buildId;
    expect(retryId).not.toBe(failedId);
    await fixed.service.index.waitForBuild(retryId);
    const answered = answerOf(await again.ask({ question: QUESTION }));
    expect(answered.index.generationId).toBe(retryId);
  });
});

describe("a process killed between staging and publishing", () => {
  async function crashDuring(mode: "refresh" | "rebuild", sha: string) {
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "../support/publish-crash-child.ts"),
        fixture.dataDir,
        fixture.repo,
        "pilot",
        sha,
        mode,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const reader = child.stdout.getReader();
    let output = "";
    while (!output.includes("\n")) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += new TextDecoder().decode(chunk.value);
    }
    expect(output).toBe("staged\n");

    // The child is inside the publish transaction with every entry staged.
    const db = new Database(join(fixture.dataDir, "looky.sqlite"), { readonly: true });
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      const staged = db
        .query<{ id: string; state: string; files_done: number; files_total: number }, [string]>(
          "SELECT id, state, files_done, files_total FROM index_builds WHERE sha = ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(sha)!;
      expect(staged.state).toBe("running");
      expect(staged.files_done).toBe(staged.files_total);
      const ready = db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM index_builds WHERE id = ? AND state = 'ready'",
        )
        .get(staged.id)!.n;
      expect(ready).toBe(0);
      child.kill("SIGKILL");
      await child.exited;
      return { stagedId: staged.id, db };
    } catch (error) {
      child.kill("SIGKILL");
      db.close();
      throw error;
    }
  }

  test("a killed refresh never becomes ready; readers stay on the old revision; the next request rebuilds", async () => {
    const setup = looky({ provider: citingModel() });
    const before = answerOf(await (await setup.open()).ask({ question: QUESTION }));
    await stop(setup);

    const next = refreshPilotRepo(fixture.repo);
    const { stagedId, db } = await crashDuring("refresh", next);
    try {
      // A reader of the old generation still sees exactly its revision.
      const hits = searchChunks(db, {
        buildId: before.index.generationId,
        query: "resumeInterruptedRun",
        limit: 20,
      });
      expect(hits.map((hit) => hit.path)).toContain("src/recovery/recover-run.ts");
      expect(hits.every((hit) => hit.sha === fixture.sha)).toBe(true);
    } finally {
      db.close();
    }

    const model = citingModel();
    const recovered = looky({ provider: model });
    const crashed = recovered.service.index.status(stagedId)!;
    expect(crashed).toMatchObject({ state: "failed", errorCode: "interrupted", retryable: true });

    const old = answerOf(await (await recovered.open()).ask({ question: QUESTION }));
    expect(old.index.generationId).toBe(before.index.generationId);

    const moved = await recovered.open({ sequence: 2, clientGeneration: "run-2", sha: next });
    const seen = model.calls.length;
    const fresh = answerOf(await moved.ask({ question: QUESTION, mode: "deep" }));
    expect(fresh.index.sha).toBe(next);
    expect(fresh.index.generationId).not.toBe(stagedId);
    expectEvidenceAt(fresh, fixture.repo, next);
    expectPromptEvidenceAt(model.calls.slice(seen), fixture.repo, next);
  });

  test("a killed rebuild leaves the previous generation ready and unretired", async () => {
    const setup = looky();
    const before = answerOf(await (await setup.open()).ask({ question: QUESTION }));
    await stop(setup);

    const { stagedId, db } = await crashDuring("rebuild", fixture.sha);
    db.close();

    const recovered = looky();
    expect(recovered.service.index.status(stagedId)?.state).toBe("failed");
    const view = await recovered.client.indexStatus("pilot", fixture.sha);
    expect(view).toMatchObject({ state: "ready", ready: { buildId: before.index.generationId } });
    const after = answerOf(await (await recovered.open()).ask({ question: QUESTION }));
    expect(after.index.generationId).toBe(before.index.generationId);
  });
});

describe("missing and stale indexes", () => {
  test("a new revision with a stale index returns indexing with progress, never the old answer", async () => {
    const model = citingModel();
    const service = looky({ provider: model, capacity: { indexWaitMs: 0 } });
    const agent = await service.open();
    const prewarm = agent.registered.index.active!.buildId;
    await service.service.index.waitForBuild(prewarm);
    const old = answerOf(await agent.ask({ question: QUESTION }));
    const calls = model.calls.length;

    const next = refreshPilotRepo(fixture.repo);
    const moved = await service.open({ sequence: 2, clientGeneration: "run-2", sha: next });
    const pending = await moved.ask({ question: QUESTION });
    expect(pending.isError).toBe(true);
    const response = pending.structuredContent;
    expect(response).toMatchObject({
      status: "indexing",
      revision: { sha: next },
      staleIndex: { generationId: old.index.generationId, sha: fixture.sha },
      mode: { requested: "fast", executed: null },
    });
    expect(response.status === "indexing" && response.progress.phase).toBeTruthy();
    expect(response.limitations.join(" ")).toContain("stale for this request and was not used");
    expect("answer" in response).toBe(false);
    expect(model.calls.length).toBe(calls);
    expect(await moved.indexStatus()).toMatchObject({ sha: next });
  });

  test("lost storage rebuilds instead of answering from an empty index", async () => {
    const setup = looky();
    answerOf(await (await setup.open()).ask({ question: QUESTION }));
    await stop(setup);
    rmSync(fixture.dataDir, { recursive: true, force: true });

    const model = citingModel();
    const fresh = looky({ provider: model, capacity: { indexWaitMs: 0 } });
    const agent = await fresh.open();
    const response = (await agent.ask({ question: QUESTION })).structuredContent;
    expect(response.status).toBe("indexing");
    expect(model.calls).toHaveLength(0);
    if (response.status === "indexing") await fresh.service.index.waitForBuild(response.buildId);
    const answered = answerOf(await agent.ask({ question: QUESTION }));
    expect(answered.coverage?.indexedFiles).toBeGreaterThan(0);
  });
});
