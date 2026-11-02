import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WIKI_PLAN_LIMITS } from "../src/wiki/model";
import { diffManifests, relabelWikiBody } from "../src/wiki/refresh";
import { parseSearchQuery, searchWiki } from "../src/wiki/search";
import {
  acquireWikiLease,
  collectWikiGarbage,
  createWikiGeneration,
  getWikiGeneration,
  pinnedWikiPage,
  publishWikiGeneration,
  releaseWikiLease,
  resolveWikiSlug,
  setWikiPageState,
  startWikiGeneration,
  storeWikiPageBody,
  wikiBodyLinks,
  type WikiGenerationRecord,
  wikiIndex,
  WikiIntegrityError,
  wikiPage,
  type WikiPageContent,
  WikiRevisionMismatchError,
} from "../src/wiki/store";
import { commitAll, git, write } from "./support/git-fixture";
import { buildPilotRepo } from "./support/pilot-fixture";
import {
  groundedPage,
  type WikiHarness,
  wikiHarness,
  wikiModel,
  type WikiModel,
} from "./support/wiki-fixture";

const REPO_ID = "pilot";

/**
 * Second commit of the pilot repository, with every kind of change:
 *
 * - added:      src/notify/email.ts, a new module
 * - edited:     src/storage/checkpoints.ts
 * - renamed:    src/recovery/recover-run.ts → src/recovery/resume.ts
 * - deleted:    src/worker/supervisor.ts, which removes the worker module and
 *               the supervisor workflow (a structural change)
 * - unchanged:  src/billing and src/config, whose pages must be reused
 */
function secondCommit(repo: string): string {
  git(repo, "mv", "src/recovery/recover-run.ts", "src/recovery/resume.ts");
  git(repo, "rm", "--quiet", "src/worker/supervisor.ts");
  write(
    repo,
    "test/recovery.test.ts",
    git(repo, "show", "HEAD:test/recovery.test.ts").replace(
      "src/recovery/recover-run",
      "src/recovery/resume",
    ),
  );
  write(
    repo,
    "src/storage/checkpoints.ts",
    `${git(repo, "show", "HEAD:src/storage/checkpoints.ts")}

/** Drop all but the newest \`keep\` checkpoints. */
export async function pruneCheckpoints(keep: number): Promise<number> {
  return Math.max(0, CHECKPOINTS.size - keep);
}
`,
  );
  write(
    repo,
    "src/notify/email.ts",
    `import { loadCheckpoint } from "../storage/checkpoints";

/** Email the owner of a run that could not be resumed. */
export async function notifyUnrecoverable(runId: string): Promise<string> {
  const checkpoint = await loadCheckpoint(runId);
  return checkpoint ? "resumable" : \`run \${runId} has no checkpoint\`;
}
`,
  );
  return commitAll(repo, "second commit");
}

describe("wiki refresh across commits", () => {
  let root: string;
  let repo: string;
  let dataDir: string;
  let sha1: string;
  let sha2: string;
  const open: WikiHarness[] = [];
  const repositories = (id: string) => (id === REPO_ID ? repo : undefined);

  function harness(provider?: WikiModel, modelIdentity?: string): WikiHarness {
    const created = wikiHarness({
      dataDir,
      repositories,
      ...(provider ? { provider } : {}),
      ...(modelIdentity ? { modelIdentity } : {}),
    });
    open.push(created);
    return created;
  }

  async function closeAll() {
    for (const created of open.splice(0).reverse()) await created.close();
  }

  async function queued(
    h: WikiHarness,
    sha: string,
    options: { readonly rebuild?: boolean } = {},
  ): Promise<WikiGenerationRecord> {
    for (;;) {
      const started = await h.generator.start({ repositoryId: REPO_ID, sha }, options);
      if (started.state === "indexing") {
        await h.index.waitForBuild(started.buildId);
        continue;
      }
      if (started.state === "ready" || started.state === "queued" || started.state === "running") {
        return started.generation;
      }
      throw new Error(`unexpected start result ${started.state}`);
    }
  }

  async function generate(
    h: WikiHarness,
    sha: string,
    options: { readonly rebuild?: boolean } = {},
  ): Promise<WikiGenerationRecord> {
    return h.generator.wait((await queued(h, sha, options)).id);
  }

  function contents(h: WikiHarness, generationId: string): WikiPageContent[] {
    return wikiIndex(h.db, { repositoryId: REPO_ID, generationId })!.pages.map((page) =>
      wikiPage(h.db, { repositoryId: REPO_ID, generationId, pageId: page.pageId })!,
    );
  }

  function bySlug(h: WikiHarness, generationId: string): Map<string, WikiPageContent> {
    return new Map(contents(h, generationId).map((content) => [content.page.slug, content]));
  }

  /** Every page is exactly at the generation's commit, and links and search entries resolve. */
  function expectSingleRevision(h: WikiHarness, generation: WikiGenerationRecord) {
    const sha = generation.sha;
    const pages = contents(h, generation.id);
    const ready = new Set(
      pages.filter((content) => content.page.state === "ready").map((c) => c.page.slug),
    );
    for (const content of pages) {
      if (content.page.state !== "ready") continue;
      const body = content.body!.text;
      expect(content.body!.provenance.sha).toBe(sha);
      expect(body).toContain(`Generated from commit \`${sha.slice(0, 12)}\``);
      // Another commit may only be named in the note saying where reused prose came from.
      const withoutNote = body.replace(/\n\n\*Carried forward unchanged from commit[^\n]*\*$/, "");
      for (const other of [sha1, sha2].filter((candidate) => candidate !== sha)) {
        expect(withoutNote).not.toContain(other.slice(0, 12));
      }
      expect(content.citations.length).toBeGreaterThan(0);
      for (const source of [...content.citations, ...content.plannedSources]) {
        expect(source.blobOid).toBe(git(repo, "rev-parse", `${sha}:${source.path}`));
      }
      for (const blob of content.page.inspected ?? []) {
        expect(blob.blobOid).toBe(git(repo, "rev-parse", `${sha}:${blob.path}`));
      }
      for (const slug of wikiBodyLinks(body)) expect(ready.has(slug)).toBe(true);
    }
    // Search entries, written when the generation published: exactly its ready pages.
    const indexed = new Set(
      h.db
        .query<{ page_id: string }, [string]>(
          "SELECT DISTINCT page_id FROM wiki_search_fts WHERE generation_id = ?",
        )
        .all(generation.id)
        .map((row) => row.page_id),
    );
    const readyIds = pages
      .filter((content) => content.page.state === "ready")
      .map((content) => content.page.pageId);
    expect([...indexed].sort()).toEqual(readyIds.sort());
  }

  /** Search rows that do not name a ready page of a published generation. */
  function orphanSearchEntries(h: WikiHarness): number {
    return h.db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM wiki_search_fts e WHERE NOT EXISTS (
           SELECT 1 FROM wiki_pages p JOIN wiki_generations g ON g.id = p.generation_id
           WHERE p.generation_id = e.generation_id AND p.page_id = e.page_id
             AND p.state = 'ready' AND g.state = 'ready')`,
      )
      .get()!.n;
  }

  function searchRows(h: WikiHarness, generationId: string): number {
    return h.db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM wiki_search_fts WHERE generation_id = ?",
      )
      .get(generationId)!.n;
  }

  /** Docs search of one generation, with each hit's slug. */
  function search(h: WikiHarness, generationId: string, text: string, limit = 25) {
    const query = parseSearchQuery(text);
    if (!query.ok) throw new Error(query.code);
    const slugs = new Map(
      wikiIndex(h.db, { repositoryId: REPO_ID, generationId })!.pages.map((page) => [
        page.pageId,
        page.slug,
      ]),
    );
    return searchWiki(h.db, {
      generationId,
      expression: query.expression,
      limit,
      offset: 0,
    }).hits.map((hit) => ({ ...hit, slug: slugs.get(hit.pageId) }));
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "looky-wiki-refresh-"));
    repo = join(root, "pilot");
    dataDir = join(root, "data");
    mkdirSync(repo);
    sha1 = buildPilotRepo(repo);
    sha2 = secondCommit(repo);
  });

  afterEach(async () => {
    await closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  test("regenerates affected pages, reuses unaffected ones and publishes one revision", async () => {
    const model = wikiModel();
    const h = harness(model);
    const first = await generate(h, sha1);
    expect(first.state).toBe("ready");
    expect(first.refresh?.mode).toBe("initial");
    const firstPages = bySlug(h, first.id);
    expect(firstPages.get("modules/worker")?.page.state).toBe("ready");

    // Before the refresh, the new commit has no wiki; the old one is only historical.
    const before = h.generator.status({ repositoryId: REPO_ID, sha: sha2 });
    expect(before.state).toBe("unavailable");
    expect(before.selectedSha).toBe(sha2);
    expect(before.freshness).toBe("stale");
    expect(before.generatedSha).toBe(sha1);
    expect(before.stale?.reasons).toEqual(["revision"]);
    expect(() =>
      pinnedWikiPage(h.db, {
        repositoryId: REPO_ID,
        sha: sha2,
        generationId: first.id,
        slug: "overview",
      }),
    ).toThrow(WikiRevisionMismatchError);

    const callsBefore = model.calls.length;
    const second = await generate(h, sha2);
    expect(second.state).toBe("ready");
    expect(second.baseGenerationId).toBe(first.id);

    // Changes since the base commit.
    const refresh = second.refresh!;
    expect(refresh.mode).toBe("refresh");
    expect(refresh.base).toEqual({ generationId: first.id, sha: sha1 });
    expect(refresh.changes!.paths.added).toEqual(["src/notify/email.ts"]);
    expect(refresh.changes!.paths.changed).toEqual([
      "src/storage/checkpoints.ts",
      "test/recovery.test.ts",
    ]);
    expect(refresh.changes!.paths.renamed).toEqual([
      { from: "src/recovery/recover-run.ts", to: "src/recovery/resume.ts" },
    ]);
    expect(refresh.changes!.paths.deleted).toEqual(["src/worker/supervisor.ts"]);
    expect(refresh.removedPages.map((page) => page.slug)).toContain("modules/worker");

    // Correct invalidation, page by page.
    const pages = bySlug(h, second.id);
    const reason = (slug: string) => pages.get(slug)?.page.refreshReason;
    expect(reason("modules/billing")).toBe("reused");
    expect(reason("modules/config")).toBe("reused");
    expect(reason("modules/storage")).toBe("inputs_changed");
    expect(reason("modules/recovery")).toBe("inputs_changed");
    expect(reason("modules/notify")).toBe("new_page");
    for (const slug of ["overview", "architecture", "modules"]) {
      expect(reason(slug)).not.toBe("reused");
    }
    expect(pages.has("modules/worker")).toBe(false);

    // Measurable reuse: reused pages cost no model call and are counted.
    const reused = [...pages.values()].filter((c) => c.page.refreshReason === "reused");
    const written = [...pages.values()].filter(
      (c) => c.page.state === "ready" && c.page.refreshReason !== "reused",
    );
    expect(reused.length).toBeGreaterThanOrEqual(2);
    expect(second.usage!.pagesReused).toBe(reused.length);
    expect(second.usage!.pagesWritten).toBe(written.length);
    expect(model.calls.length - callsBefore).toBe(written.length);
    expect(getWikiGeneration(h.db, second.id)!.refresh!.pages).toMatchObject({
      reused: reused.length,
      regenerated: written.length,
    });
    for (const call of model.calls.slice(callsBefore)) {
      expect(["Billing", "Config"]).not.toContain(call.title);
    }

    // Reused prose keeps its citations, now verified and labelled at the new commit.
    const billing = pages.get("modules/billing")!;
    const oldBilling = firstPages.get("modules/billing")!;
    expect(billing.citations).toEqual(oldBilling.citations);
    expect(billing.body!.provenance).toMatchObject({
      sha: sha2,
      reused: true,
      reusedFromSha: sha1,
      reusedFromGeneration: first.id,
    });
    expect(billing.body!.text).toContain(
      `Carried forward unchanged from commit \`${sha1.slice(0, 12)}\``,
    );

    // Fresh citations, no mixed revisions, and every link and search entry resolves.
    expectSingleRevision(h, second);
    expectSingleRevision(h, first);
    expect(orphanSearchEntries(h)).toBe(0);

    // A removed concept answers clearly; a renamed file's page stays put.
    const removed = resolveWikiSlug(h.db, {
      repositoryId: REPO_ID,
      generationId: second.id,
      slug: "modules/worker",
    });
    expect(removed.outcome).toBe("removed");
    expect(
      search(h, second.id, "Worker").every(
        (hit) => hit.slug !== undefined && pages.get(hit.slug)?.page.state === "ready",
      ),
    ).toBe(true);
    expect(search(h, second.id, "Billing").map((hit) => hit.slug)).toContain("modules/billing");
    for (const hit of search(h, second.id, "Worker supervisor")) {
      expect(hit.pageId).not.toBe(firstPages.get("modules/worker")!.page.pageId);
    }

    // The new commit is current; the old generation is only readable pinned to its commit.
    const after = h.generator.status({ repositoryId: REPO_ID, sha: sha2 });
    expect(after).toMatchObject({ state: "ready", freshness: "current", generatedSha: sha2 });
    const old = pinnedWikiPage(h.db, {
      repositoryId: REPO_ID,
      sha: sha1,
      generationId: first.id,
      slug: "modules/worker",
      keys: { indexKey: h.index.indexKey, generatorKey: h.generator.generatorKey },
    })!;
    expect(old.sha).toBe(sha1);
    expect(old.content?.page.slug).toBe("modules/worker");

    // A third generation with no change reuses every page without a model call.
    const callsAfter = model.calls.length;
    const sha3 = commitAll(repo, "empty");
    const third = await generate(h, sha3);
    expect(third.state).toBe("ready");
    expect(model.calls.length).toBe(callsAfter);
    expect(third.usage!.pagesWritten).toBe(0);
    expectSingleRevision(h, { ...third, sha: sha3 });
  });

  test("retention keeps leased generations readable, then deletes them with their search entries", async () => {
    const h = harness(wikiModel());
    const first = await generate(h, sha1);
    const second = await generate(h, sha2);
    expect(second.state).toBe("ready");
    const lease = acquireWikiLease(h.db, first.id, 60_000)!;
    expect(lease).toBeDefined();

    const kept = collectWikiGarbage(h.db, {
      retainReadyPerRepository: 1,
      retainFailedPerRepository: 1,
    });
    expect(kept.retired).toBe(1);
    expect(kept.deleted).toBe(0);
    // A reader holding the lease still reads it, explicitly as historical content of its commit.
    const pinned = pinnedWikiPage(h.db, {
      repositoryId: REPO_ID,
      sha: sha1,
      generationId: first.id,
      slug: "overview",
    })!;
    expect(pinned.currency).toBe("historical");
    expect(pinned.content?.body?.text).toContain(sha1.slice(0, 12));
    expect(h.generator.status({ repositoryId: REPO_ID, sha: sha1 }).state).not.toBe("ready");

    releaseWikiLease(h.db, lease.leaseId);
    const collected = collectWikiGarbage(h.db, {
      retainReadyPerRepository: 1,
      retainFailedPerRepository: 1,
    });
    expect(collected.deleted).toBe(1);
    expect(getWikiGeneration(h.db, first.id)).toBeUndefined();
    expect(searchRows(h, first.id)).toBe(0);
    expect(orphanSearchEntries(h)).toBe(0);
    expect(
      h.db
        .query<{ n: number }, [string]>(
          "SELECT COUNT(*) AS n FROM wiki_search_generations WHERE generation_id = ?",
        )
        .get(first.id)!.n,
    ).toBe(0);
    // Old links still explain themselves after the generation is gone.
    expect(
      resolveWikiSlug(h.db, {
        repositoryId: REPO_ID,
        generationId: second.id,
        slug: "modules/worker",
      }).outcome,
    ).toBe("removed");
    // A later refresh compares with the newest published generation.
    const sha3 = commitAll(repo, "empty");
    const third = await generate(h, sha3);
    expect(third.refresh?.base?.generationId).toBe(second.id);
  });

  test("a failed refresh keeps the last snapshot and a retry publishes without mixed revisions", async () => {
    const h = harness(wikiModel());
    const first = await generate(h, sha1);
    const hashes = contents(h, first.id).map((content) => content.body?.bodyHash);
    await closeAll();

    // The provider fails one page of the refresh; the others finish and are kept as drafts.
    let failures = 0;
    const flaky = wikiModel((call) => {
      if (call.title === "Storage") {
        failures += 1;
        return "not json";
      }
      return groundedPage(call);
    });
    const broken = harness(flaky);
    const failed = await generate(broken, sha2);
    expect(failed.state).toBe("failed");
    expect(failures).toBeGreaterThan(0);
    const during = broken.generator.status({ repositoryId: REPO_ID, sha: sha2 });
    expect(during.state).toBe("failed");
    expect(during.freshness).toBe("stale");
    expect(during.stale?.generation.id).toBe(first.id);
    // The last valid snapshot is untouched and still served for its own commit.
    expect(contents(broken, first.id).map((content) => content.body?.bodyHash)).toEqual(hashes);
    expect(broken.generator.status({ repositoryId: REPO_ID, sha: sha1 }).ready?.id).toBe(first.id);
    const written = flaky.calls.filter((call) => call.title !== "Storage").length;
    await closeAll();

    const model = wikiModel();
    const h2 = harness(model);
    const retried = await h2.generator.retry(failed.id);
    if (retried.state !== "queued") throw new Error(retried.state);
    const ready = await h2.generator.wait(retried.generation.id);
    expect(ready.state).toBe("ready");
    expect(ready.refresh?.mode).toBe("refresh");
    expectSingleRevision(h2, ready);
    // Pages that finished in the failed attempt are not paid for again.
    const pages = contents(h2, ready.id).filter((content) => content.page.state === "ready");
    const writtenNow = pages.filter((c) => c.page.refreshReason !== "reused").length;
    expect(model.calls.length).toBe(writtenNow);
    expect(ready.usage!.pagesReused).toBeGreaterThanOrEqual(written);
    expect(model.calls.map((call) => call.title)).toContain("Storage");
  });

  test("a cancelled refresh keeps the last snapshot and the next start completes it", async () => {
    const h0 = harness(wikiModel());
    const first = await generate(h0, sha1);
    await closeAll();

    let blocked!: () => void;
    const isBlocked = new Promise<void>((resolve) => (blocked = resolve));
    const slow = wikiModel(groundedPage, {
      before: async (call, index) => {
        if (index < 1) return;
        blocked();
        await new Promise<void>((resolve) =>
          call.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      },
    });
    const h = wikiHarness({
      dataDir,
      repositories,
      provider: slow,
      settings: { maxConcurrentPages: 1 },
    });
    open.push(h);
    const generation = await queued(h, sha2);
    await isBlocked;
    expect(h.generator.cancel(generation.id)).toBe(true);
    const cancelled = await h.generator.wait(generation.id);
    expect(cancelled.state).toBe("cancelled");
    const status = h.generator.status({ repositoryId: REPO_ID, sha: sha2 });
    expect(status.state).toBe("cancelled");
    expect(status.generatedSha).toBe(sha1);
    expect(status.stale?.generation.id).toBe(first.id);
    await closeAll();

    const h2 = harness(wikiModel());
    const ready = await generate(h2, sha2);
    expect(ready.state).toBe("ready");
    expectSingleRevision(h2, ready);
    expect(orphanSearchEntries(h2)).toBe(0);
  });

  test("a configuration change invalidates every page and a rebuild rewrites a published scope", async () => {
    const original = harness(wikiModel(), "local:openai:model-a");
    const first = await generate(original, sha1);
    await closeAll();

    const modelB = wikiModel();
    const changed = harness(modelB, "local:openai:model-b");
    const second = await generate(changed, sha2);
    expect(second.state).toBe("ready");
    const reasons = contents(changed, second.id)
      .filter((content) => content.page.state === "ready")
      .map((content) => content.page.refreshReason);
    // Pages kept by the plan name the configuration; new concepts are simply new.
    expect(reasons).toContain("configuration_changed");
    expect(reasons.every((r) => r === "configuration_changed" || r === "new_page")).toBe(true);
    expect(second.usage!.pagesReused).toBe(0);
    expect(first.generatorKey).not.toBe(second.generatorKey);

    // A deliberate rebuild of a published scope writes every page again and
    // replaces the published generation only when it publishes.
    const calls = modelB.calls.length;
    const rebuilt = await generate(changed, sha2, { rebuild: true });
    expect(rebuilt.id).not.toBe(second.id);
    expect(rebuilt.state).toBe("ready");
    expect(rebuilt.refresh?.mode).toBe("rebuild");
    expect(rebuilt.usage!.pagesReused).toBe(0);
    expect(modelB.calls.length - calls).toBe(rebuilt.usage!.pagesWritten);
    expect(getWikiGeneration(changed.db, second.id)!.retiredAt).not.toBeNull();
    expect(changed.generator.status({ repositoryId: REPO_ID, sha: sha2 }).ready?.id).toBe(
      rebuilt.id,
    );
    expectSingleRevision(changed, rebuilt);
  });

  test("pages without a dependency record are regenerated rather than trusted", async () => {
    const h = harness(wikiModel());
    const first = await generate(h, sha1);
    // As for a page published before dependencies were recorded.
    h.db
      .query("UPDATE wiki_pages SET inspected = NULL WHERE generation_id = ? AND slug = ?")
      .run(first.id, "modules/billing");
    h.db.query("DELETE FROM wiki_page_drafts").run();
    const second = await generate(h, sha2);
    const pages = bySlug(h, second.id);
    expect(pages.get("modules/billing")!.page.refreshReason).toBe("dependency_unknown");
    expect(pages.get("modules/config")!.page.refreshReason).toBe("reused");
    // The Modules section describes billing, so it is written again as well.
    expect(pages.get("modules")!.page.refreshReason).not.toBe("reused");
  });

  test("publishing refuses evidence from another commit", async () => {
    const h = harness();
    await h.index.waitForBuild(
      (
        (await h.index.startBuild({ repositoryId: REPO_ID, sha: sha2 })) as {
          build: { id: string };
        }
      ).build.id,
    );
    const plan = h.index.planWiki({ repositoryId: REPO_ID, sha: sha2 }, DEFAULT_WIKI_PLAN_LIMITS)!;
    const { generation } = createWikiGeneration(h.db, plan, { writer: "test" });
    startWikiGeneration(h.db, generation.id);
    const oldBlob = git(repo, "rev-parse", `${sha1}:src/storage/checkpoints.ts`);
    const index = wikiIndex(h.db, { repositoryId: REPO_ID, generationId: generation.id })!;
    for (const page of index.pages.filter((p) => p.state === "queued")) {
      setWikiPageState(h.db, generation.id, page.pageId, "running");
      const source = wikiPage(h.db, {
        repositoryId: REPO_ID,
        generationId: generation.id,
        pageId: page.pageId,
      })!.plannedSources[0]!;
      storeWikiPageBody(h.db, {
        generationId: generation.id,
        pageId: page.pageId,
        body: "Explains the code.",
        citations: [{ ...source, startLine: 1, endLine: 1 }],
        provenance: { generator: "test", sha: sha2 },
        inspected: [{ path: source.path, blobOid: source.blobOid }],
      });
    }
    // One page claims a blob of the first commit.
    const storage = index.pages.find((page) => page.slug === "modules/storage")!;
    h.db
      .query(
        `UPDATE wiki_page_sources SET blob_oid = ?
         WHERE generation_id = ? AND page_id = ? AND role = 'cited'`,
      )
      .run(oldBlob, generation.id, storage.pageId);
    expect(() => publishWikiGeneration(h.db, generation.id)).toThrow(WikiIntegrityError);
    try {
      publishWikiGeneration(h.db, generation.id);
    } catch (error) {
      expect(String(error)).toContain("from another commit");
    }
    expect(getWikiGeneration(h.db, generation.id)!.state).toBe("running");
    expect(searchRows(h, generation.id)).toBe(0);
  });
});

describe("refresh helpers", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);

  test("diffs manifests into added, changed, deleted and renamed paths", () => {
    const before = new Map([
      ["keep.ts", "1"],
      ["edit.ts", "2"],
      ["old.ts", "3"],
      ["gone.ts", "4"],
    ]);
    const after = new Map([
      ["keep.ts", "1"],
      ["edit.ts", "22"],
      ["new.ts", "3"],
      ["added.ts", "5"],
    ]);
    const diff = diffManifests(before, after);
    expect(diff).toMatchObject({ added: 1, changed: 1, deleted: 1, renamed: 1 });
    expect(diff.paths).toEqual({
      added: ["added.ts"],
      changed: ["edit.ts"],
      deleted: ["gone.ts"],
      renamed: [{ from: "old.ts", to: "new.ts" }],
    });
  });

  test("relabels a body to the new commit, or refuses when the old commit would remain", () => {
    const body =
      `Text ([x.ts:1](https://example.test/${a}/x.ts#L1)).\n\n---\n\n` +
      `*Generated from commit \`${a.slice(0, 12)}\` using 1 inspected source range in 1 file.*`;
    const relabelled = relabelWikiBody(body, a, b, 1)!;
    expect(relabelled).toContain(`https://example.test/${b}/x.ts#L1`);
    expect(relabelled).toContain(`Generated from commit \`${b.slice(0, 12)}\``);
    expect(relabelled.replace(/\n\n\*Carried forward[^\n]*\*$/, "")).not.toContain(a.slice(0, 12));
    // Relabelling again replaces the earlier note instead of stacking stale commits.
    const c = "c".repeat(40);
    const twice = relabelWikiBody(relabelled, b, c, 1)!;
    expect(twice).not.toContain(a.slice(0, 12));
    expect(twice.match(/Carried forward/g)?.length).toBe(1);
    // A body that mentions the old commit elsewhere is not relabelled.
    expect(relabelWikiBody(`${body}\nSee ${a.slice(0, 12)}.`, a, b, 1)).toBeUndefined();
    expect(relabelWikiBody("No footer.", a, b, 1)).toBeUndefined();
  });
});
