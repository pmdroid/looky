import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadWikiConfig } from "../src/config";
import { IndexService } from "../src/indexing/index-service";
import { openDatabase } from "../src/storage/database";
import { migrate, migrations, schemaVersion } from "../src/storage/migrations";
import {
  canTransitionGeneration,
  canTransitionPage,
  DEFAULT_WIKI_PLAN_LIMITS,
  type WikiPlan,
  type WikiPlanLimits,
  wikiGeneratorKey,
} from "../src/wiki/model";
import { planWiki, slugify } from "../src/wiki/planner";
import { parseSearchQuery, searchWiki } from "../src/wiki/search";
import {
  collectWikiGarbage,
  createWikiGeneration,
  finishWikiGenerationUnsuccessfully,
  getWikiGeneration,
  publishWikiGeneration,
  resolveWikiSlug,
  setWikiPageState,
  startWikiGeneration,
  storeWikiPageBody,
  validateWikiPlan,
  WikiAccessDeniedError,
  wikiIndex,
  WikiIntegrityError,
  wikiIntegrityProblems,
  wikiPage,
  type WikiScope,
  WikiStateError,
  wikiStatus,
  type WikiTocEntry,
} from "../src/wiki/store";
import { commitAll, git, initRepo, write } from "./support/git-fixture";
import { buildPilotRepo, refreshPilotRepo } from "./support/pilot-fixture";

const LIMITS = DEFAULT_WIKI_PLAN_LIMITS;
const GENERATOR = { generator: "test-writer", promptVersion: "1" } as const;

describe("generated wiki model", () => {
  let root: string;
  let repo: string;
  let otherRepo: string;
  let dataDir: string;
  let sha: string;
  const open: { db?: Database; services: IndexService[] } = { services: [] };

  function database(): Database {
    open.db = openDatabase({ dataDir });
    return open.db;
  }

  function service(db: Database): IndexService {
    const created = new IndexService({
      db,
      repositories: (id) => (id === "pilot" ? repo : id === "other" ? otherRepo : undefined),
      executor: "inline",
    });
    open.services.push(created);
    return created;
  }

  async function closeAll() {
    for (const created of open.services.splice(0)) await created.close();
    open.db?.close();
    delete open.db;
  }

  async function plan(
    svc: IndexService,
    scopeSha = sha,
    limits: WikiPlanLimits = LIMITS,
    repositoryId = "pilot",
  ): Promise<WikiPlan> {
    const started = await svc.startBuild({ repositoryId, sha: scopeSha });
    if (started.state === "unsupported_revision") throw new Error(started.message);
    expect((await svc.waitForBuild(started.build.id)).state).toBe("ready");
    const result = svc.planWiki({ repositoryId, sha: scopeSha }, limits);
    if (!result) throw new Error("no plan");
    return result;
  }

  /** Generate every queued page with a stub body and publish, as PAS-997's generator will. */
  function generateAll(db: Database, generationId: string) {
    startWikiGeneration(db, generationId);
    const index = wikiIndex(db, {
      repositoryId: getWikiGeneration(db, generationId)!.repositoryId,
      generationId,
    })!;
    for (const page of index.pages) {
      if (page.state !== "queued") continue;
      setWikiPageState(db, generationId, page.pageId, "running");
      const planned = wikiPage(db, {
        repositoryId: index.generation.repositoryId,
        generationId,
        pageId: page.pageId,
      })!.plannedSources;
      storeWikiPageBody(db, {
        generationId,
        pageId: page.pageId,
        body: `${page.title} explained from ${planned.length} sources.`,
        citations: planned.slice(0, 1),
        provenance: { generator: "test-writer", model: "scripted" },
      });
    }
    return publishWikiGeneration(db, generationId);
  }

  function scopeOf(p: WikiPlan, generator: Record<string, string> = GENERATOR): WikiScope {
    return {
      repositoryId: p.repositoryId,
      sha: p.sha,
      indexKey: p.indexKey,
      generatorKey: wikiGeneratorKey({ limits: p.limits, generator }),
    };
  }

  function flatten(entry: WikiTocEntry): WikiTocEntry[] {
    return [entry, ...entry.children.flatMap(flatten)];
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "looky-wiki-"));
    repo = join(root, "pilot");
    otherRepo = join(root, "other");
    dataDir = join(root, "data");
    mkdirSync(repo);
    mkdirSync(otherRepo);
    sha = buildPilotRepo(repo);
  });

  afterEach(async () => {
    await closeAll();
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Migration and restart

  test("migration 5 upgrades an existing database without touching index data", () => {
    const file = join(root, "legacy.sqlite");
    const legacy = new Database(file, { create: true, strict: true });
    migrate(legacy, migrations.slice(0, 4));
    legacy
      .query(
        `INSERT INTO index_builds (id, repository_id, sha, policy_version, index_key, state, phase,
           created_at, updated_at)
         VALUES ('b1', 'pilot', ?, 1, 'p1-x', 'failed', 'failed', 'now', 'now')`,
      )
      .run(sha);
    legacy.close();

    const upgraded = new Database(file, { strict: true });
    migrate(upgraded);
    expect(schemaVersion(upgraded)).toBe(migrations.length);
    expect(
      upgraded
        .query<{ id: string }, []>("SELECT id FROM index_builds")
        .all()
        .map((r) => r.id),
    ).toEqual(["b1"]);
    const tables = upgraded
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'wiki_%' ORDER BY name",
      )
      .all()
      .map((row) => row.name);
    expect(tables).toEqual([
      "wiki_generation_files",
      "wiki_generations",
      "wiki_leases",
      "wiki_page_bodies",
      "wiki_page_drafts",
      "wiki_page_links",
      "wiki_page_sources",
      "wiki_pages",
      "wiki_search_fts",
      "wiki_search_fts_config",
      "wiki_search_fts_content",
      "wiki_search_fts_data",
      "wiki_search_fts_docsize",
      "wiki_search_fts_idx",
      "wiki_search_generations",
      "wiki_slug_aliases",
    ]);
    migrate(upgraded);
    expect(schemaVersion(upgraded)).toBe(migrations.length);
    upgraded.close();
  });

  test("pages published before the search and refresh migrations stay searchable", () => {
    const file = join(root, "published.sqlite");
    const old = new Database(file, { create: true, strict: true });
    old.exec("PRAGMA foreign_keys = ON");
    migrate(old, migrations.slice(0, 6));
    const insertGeneration = old.query(
      `INSERT INTO wiki_generations (id, repository_id, sha, index_key, index_build_id,
         generator_key, generator_config, plan_report, page_count, state, created_at, updated_at)
       VALUES (?, 'pilot', ?, 'k', 'b', 'g', '{}', '{}', 1, ?, 'now', 'now')`,
    );
    const insertPage = old.query(
      `INSERT INTO wiki_pages (generation_id, page_id, concept_key, slug, kind, title, description,
         depth, ordinal, state, updated_at)
       VALUES (?, 'pg_root', 'overview', 'overview', 'overview', 'Overview', '', 0, 0, 'ready', 'now')`,
    );
    const insertBody = old.query(
      `INSERT INTO wiki_page_bodies (generation_id, page_id, body, body_hash, generated_at, provenance)
       VALUES (?, 'pg_root', ?, 'h', 'now', '{}')`,
    );
    insertGeneration.run("wiki_published", sha, "ready");
    insertPage.run("wiki_published");
    insertBody.run("wiki_published", "Recovery replays checkpoints after a crash.");
    // A failed generation's staged page must not become searchable.
    insertGeneration.run("wiki_failed", sha, "failed");
    insertPage.run("wiki_failed");
    insertBody.run("wiki_failed", "Recovery draft that never published.");
    old.close();

    const upgraded = new Database(file, { strict: true });
    upgraded.exec("PRAGMA foreign_keys = ON");
    migrate(upgraded);
    const query = parseSearchQuery("checkpoints");
    if (!query.ok) throw new Error(query.code);
    const found = searchWiki(upgraded, {
      generationId: "wiki_published",
      expression: query.expression,
      limit: 5,
      offset: 0,
    });
    expect(found.hits.map((hit) => hit.pageId)).toEqual(["pg_root"]);
    // Only the published generation was indexed; the failed one stays out of search.
    expect(
      upgraded
        .query<{ generation_id: string }, []>("SELECT DISTINCT generation_id FROM wiki_search_fts")
        .all()
        .map((row) => row.generation_id),
    ).toEqual(["wiki_published"]);
    upgraded.close();
  });

  test("a published wiki survives restart and an interrupted one is failed, never served", async () => {
    let db = database();
    let svc = service(db);
    const p = await plan(svc);
    const published = createWikiGeneration(db, p, GENERATOR).generation;
    generateAll(db, published.id);
    const rebuilt = createWikiGeneration(db, p, GENERATOR).generation;
    expect(rebuilt.id).not.toBe(published.id);
    startWikiGeneration(db, rebuilt.id);
    await closeAll();

    db = database();
    svc = service(db);
    const status = wikiStatus(db, scopeOf(p));
    expect(status.state).toBe("ready");
    expect(status.ready?.id).toBe(published.id);
    expect(getWikiGeneration(db, rebuilt.id)).toMatchObject({
      state: "failed",
      errorCode: "interrupted",
      retryable: true,
    });
    const index = wikiIndex(db, { repositoryId: "pilot", generationId: published.id })!;
    expect(
      index.pages.every((page) => page.state === "ready" || page.state === "unavailable"),
    ).toBe(true);
    const overview = wikiPage(db, {
      repositoryId: "pilot",
      generationId: published.id,
      pageId: index.toc.pageId,
    })!;
    expect(overview.body?.text).toContain("Overview explained");
    expect(overview.body?.provenance).toEqual({ generator: "test-writer", model: "scripted" });
    expect(overview.citations).toHaveLength(1);
    expect(overview.citations[0]!.path).toBe(overview.plannedSources[0]!.path);
  });

  // -------------------------------------------------------------------------
  // Planning

  test("plans a coherent overview, architecture, module and workflow structure", async () => {
    const db = database();
    const p = await plan(service(db));
    const outline = p.pages.map((page) => [page.depth, page.slug, page.state]);
    expect(outline).toEqual([
      [0, "overview", "queued"],
      [1, "architecture", "queued"],
      [1, "modules", "queued"],
      [2, "modules/billing", "queued"],
      [2, "modules/config", "queued"],
      [2, "modules/recovery", "queued"],
      [2, "modules/storage", "queued"],
      [2, "modules/worker", "queued"],
      [1, "workflows", "queued"],
      [2, "workflows/supervisor", "queued"],
    ]);
    const bySlug = new Map(p.pages.map((page) => [page.slug, page]));
    const overview = bySlug.get("overview")!;
    expect(overview.sources.map((source) => source.path)).toContain("README.md");
    const workflow = bySlug.get("workflows/supervisor")!;
    expect(workflow.title).toBe("Supervisor flow");
    expect(workflow.sources.map((source) => source.path)).toEqual([
      "src/worker/supervisor.ts",
      "src/recovery/recover-run.ts",
      "src/config/retry.ts",
      "src/storage/checkpoints.ts",
      "test/recovery.test.ts",
    ]);
    const linked = workflow.links.map((link) => p.pages.find((x) => x.pageId === link.toPageId)!);
    expect(linked.map((page) => page.slug).sort()).toEqual([
      "modules/config",
      "modules/recovery",
      "modules/storage",
      "modules/worker",
    ]);
    const recovery = bySlug.get("modules/recovery")!;
    expect(recovery.sources.map((source) => source.path)).toEqual([
      "src/recovery/recover-run.ts",
      "test/recovery.test.ts",
    ]);
    expect(bySlug.get("architecture")!.sources.map((s) => s.path)).toContain(
      "config/recovery.yaml",
    );
    for (const page of p.pages) {
      for (const source of page.sources) {
        expect(source.startLine).toBe(1);
        expect(source.endLine).toBeGreaterThanOrEqual(1);
        expect(source.blobOid).toBe(git(repo, "rev-parse", `${sha}:${source.path}`));
      }
    }
    expect(p.coverage).toMatchObject({
      indexedFiles: 10,
      coveredFiles: 10,
      uncovered: [],
      modules: { found: 5, planned: 5 },
      workflows: { found: 1, planned: 1 },
    });
    expect(p.disclosures).toEqual([]);
  });

  test("planning is deterministic for the same index, limits and history", async () => {
    const db = database();
    const svc = service(db);
    const first = await plan(svc);
    const second = await plan(svc);
    expect(second).toEqual(first);

    // A separate database indexing the same commit plans identical pages.
    await closeAll();
    dataDir = join(root, "data-2");
    const fresh = await plan(service(database()));
    const strip = (p: WikiPlan) => p.pages;
    expect(strip(fresh)).toEqual(strip(first));
  });

  test("respects page, module, workflow, source and depth limits and discloses truncation", async () => {
    const db = database();
    const tight: WikiPlanLimits = {
      maxPages: 6,
      maxDepth: 2,
      maxModules: 2,
      maxWorkflows: 1,
      maxSourcesPerPage: 2,
    };
    const p = await plan(service(db), sha, tight);
    expect(p.pages.length).toBeLessThanOrEqual(6);
    expect(Math.max(...p.pages.map((page) => page.depth))).toBeLessThanOrEqual(2);
    expect(p.pages.every((page) => page.sources.length <= 2)).toBe(true);
    expect(p.pages.filter((page) => page.kind === "module")).toHaveLength(2);
    expect(p.coverage.modules).toEqual({ found: 5, planned: 2 });
    expect(p.disclosures.map((d) => d.code)).toContain("modules_truncated");
    expect(p.coverage.uncoveredByReason.module_limit).toBeGreaterThan(0);
    expect(p.coverage.uncovered.some((item) => item.reason === "module_limit")).toBe(true);
    expect(() => validateWikiPlan(p)).not.toThrow();

    // The workflow page lost the budget: the section is disclosed as unavailable.
    const workflows = p.pages.find((page) => page.slug === "workflows")!;
    expect(workflows.state).toBe("unavailable");
    expect(workflows.unavailableReason).toContain("page limit");
  });

  test("submodule pages appear only within the depth limit", async () => {
    initRepo(otherRepo);
    for (const sub of ["api", "jobs"]) {
      for (const name of ["a", "b", "c"]) {
        write(otherRepo, `src/server/${sub}/${name}.ts`, `export const ${sub}_${name} = 1;\n`);
      }
    }
    write(otherRepo, "src/client/main.ts", 'import { api_a } from "../server/api/a";\n');
    const otherSha = commitAll(otherRepo, "nested");
    const db = database();
    const svc = service(db);
    const deep = await plan(svc, otherSha, LIMITS, "other");
    expect(deep.pages.filter((page) => page.depth === 3).map((page) => page.slug)).toEqual([
      "modules/server/api",
      "modules/server/jobs",
    ]);
    const shallow = await plan(svc, otherSha, { ...LIMITS, maxDepth: 2 }, "other");
    expect(shallow.pages.some((page) => page.depth > 2)).toBe(false);
  });

  test("sections without evidence are disclosed as unavailable, not invented", async () => {
    initRepo(otherRepo);
    write(otherRepo, "README.md", "# Notes\n\nOnly prose here.\n");
    write(otherRepo, "lib/only.go", "package lib\n\nfunc Only() int { return 1 }\n");
    const otherSha = commitAll(otherRepo, "docs");
    const db = database();
    const p = await plan(service(db), otherSha, LIMITS, "other");
    const bySlug = new Map(p.pages.map((page) => [page.slug, page]));
    expect(bySlug.get("overview")!.state).toBe("queued");
    expect(bySlug.get("modules/lib")!.state).toBe("queued");
    for (const slug of ["architecture", "workflows"]) {
      const page = bySlug.get(slug)!;
      expect(page.state).toBe("unavailable");
      expect(page.unavailableReason!.length).toBeGreaterThan(10);
      expect(page.sources).toEqual([]);
      expect(page.links).toEqual([]);
    }
    expect(bySlug.get("overview")!.links).toHaveLength(1);
    expect(p.disclosures.filter((d) => d.code === "section_unavailable")).toHaveLength(2);

    // An unavailable page publishes as unavailable; it never gets a body.
    const generation = createWikiGeneration(db, p, GENERATOR).generation;
    const ready = generateAll(db, generation.id);
    expect(ready.state).toBe("ready");
    const architecture = wikiPage(db, {
      repositoryId: "other",
      generationId: generation.id,
      pageId: bySlug.get("architecture")!.pageId,
    })!;
    expect(architecture.page.state).toBe("unavailable");
    expect(architecture.body).toBeUndefined();
  });

  test("planning needs an authorized repository and a ready index of the exact commit", async () => {
    const db = database();
    const svc = service(db);
    expect(svc.planWiki({ repositoryId: "pilot", sha }, LIMITS)).toBeUndefined();
    expect(() => svc.planWiki({ repositoryId: "stranger", sha }, LIMITS)).toThrow(
      "No source access configured",
    );
  });

  // -------------------------------------------------------------------------
  // Storage contracts

  test("stores unique slugs, a valid hierarchy and internal links with no dangling entries", async () => {
    const db = database();
    const p = await plan(service(db));
    const { generation } = createWikiGeneration(db, p, GENERATOR);
    const index = wikiIndex(db, { repositoryId: "pilot", generationId: generation.id })!;
    const entries = flatten(index.toc);
    expect(entries).toHaveLength(p.pages.length);
    expect(new Set(entries.map((entry) => entry.slug)).size).toBe(entries.length);
    expect(entries.map((entry) => entry.slug)).toEqual(p.pages.map((page) => page.slug));
    const ids = new Set(index.pages.map((page) => page.pageId));
    for (const link of index.links) {
      expect(ids.has(link.fromPageId)).toBe(true);
      expect(ids.has(link.toPageId)).toBe(true);
    }
    expect(index.links.length).toBe(p.pages.reduce((n, page) => n + page.links.length, 0));
    expect(index.report.coverage.indexedFiles).toBe(10);

    // The database itself refuses dangling links, parents and duplicate slugs.
    expect(() =>
      db
        .query(
          `INSERT INTO wiki_page_links (generation_id, from_page_id, to_page_id, relation, ordinal)
           VALUES (?, ?, 'pg_missing', 'related', 99)`,
        )
        .run(generation.id, index.toc.pageId),
    ).toThrow();
    expect(() =>
      db
        .query(
          `INSERT INTO wiki_pages (generation_id, page_id, concept_key, slug, kind, title,
             description, parent_page_id, depth, ordinal, state, updated_at)
           VALUES (?, 'pg_orphan', 'orphan', 'orphan', 'module', 'Orphan', '', 'pg_missing', 1, 9,
             'queued', 'now')`,
        )
        .run(generation.id),
    ).toThrow();
    expect(() =>
      db
        .query(
          `INSERT INTO wiki_pages (generation_id, page_id, concept_key, slug, kind, title,
             description, parent_page_id, depth, ordinal, state, updated_at)
           VALUES (?, 'pg_dup', 'dup', 'modules', 'module', 'Dup', '', ?, 1, 9, 'queued', 'now')`,
        )
        .run(generation.id, index.toc.pageId),
    ).toThrow();
  });

  test("rejects plans with dangling links, duplicate slugs or broken hierarchy", async () => {
    const db = database();
    const p = await plan(service(db));
    const broken = (change: (pages: WikiPlan["pages"][number][]) => void) => {
      const pages = p.pages.map((page) => ({ ...page }));
      change(pages);
      return { ...p, pages };
    };
    const cases: [string, WikiPlan][] = [
      [
        "links to missing",
        broken((pages) => {
          pages[0] = { ...pages[0]!, links: [{ toPageId: "pg_nope", relation: "related" }] };
        }),
      ],
      ["duplicate slug", broken((pages) => (pages[2] = { ...pages[2]!, slug: pages[1]!.slug }))],
      ["depth does not follow", broken((pages) => (pages[3] = { ...pages[3]!, depth: 1 }))],
      ["exactly one root", broken((pages) => (pages[1] = { ...pages[1]!, parentPageId: null }))],
      ["invalid slug", broken((pages) => (pages[1] = { ...pages[1]!, slug: "Bad Slug" }))],
      ["exceed the limit", { ...p, limits: { ...p.limits, maxPages: 4 } }],
    ];
    for (const [message, plan] of cases) {
      expect(() => validateWikiPlan(plan)).toThrow(message);
      expect(() => createWikiGeneration(db, plan, GENERATOR)).toThrow(WikiIntegrityError);
    }
    expect(db.query("SELECT COUNT(*) AS n FROM wiki_generations").get()).toEqual({ n: 0 });
  });

  test("valid state transitions only, and partial generations never publish", async () => {
    const db = database();
    const p = await plan(service(db));
    expect(canTransitionGeneration("queued", "running")).toBe(true);
    expect(canTransitionGeneration("ready", "running")).toBe(false);
    expect(canTransitionGeneration("failed", "ready")).toBe(false);
    expect(canTransitionPage("unavailable", "queued")).toBe(false);
    expect(canTransitionPage("failed", "queued")).toBe(true);
    expect(canTransitionPage("ready", "failed")).toBe(false);

    const first = createWikiGeneration(db, p, GENERATOR);
    const joined = createWikiGeneration(db, p, GENERATOR);
    expect(first.created).toBe(true);
    expect(joined).toEqual({ created: false, generation: first.generation });

    const id = first.generation.id;
    const pages = wikiIndex(db, { repositoryId: "pilot", generationId: id })!.pages;
    const overview = pages.find((page) => page.kind === "overview")!;
    expect(() => publishWikiGeneration(db, id)).toThrow(WikiStateError);
    startWikiGeneration(db, id);
    expect(() =>
      storeWikiPageBody(db, {
        generationId: id,
        pageId: overview.pageId,
        body: "Too early",
        citations: [],
        provenance: { generator: "t" },
      }),
    ).toThrow("not running");
    setWikiPageState(db, id, overview.pageId, "running");
    setWikiPageState(db, id, overview.pageId, "failed", "provider timeout");
    setWikiPageState(db, id, overview.pageId, "queued");
    expect(() => setWikiPageState(db, id, overview.pageId, "cancelled")).not.toThrow();
    expect(wikiIntegrityProblems(db, id)).toContain("page overview is cancelled");
    expect(() => publishWikiGeneration(db, id)).toThrow(WikiIntegrityError);
    expect(getWikiGeneration(db, id)!.state).toBe("running");
    expect(wikiStatus(db, scopeOf(p)).state).toBe("running");

    expect(
      finishWikiGenerationUnsuccessfully(db, id, {
        state: "cancelled",
        code: "cancelled",
        message: "Stopped by the user",
        retryable: true,
      }),
    ).toBe(true);
    const after = wikiIndex(db, { repositoryId: "pilot", generationId: id })!.pages;
    expect(after.every((page) => ["cancelled", "unavailable"].includes(page.state))).toBe(true);
    expect(() => startWikiGeneration(db, id)).toThrow(WikiStateError);
    expect(wikiStatus(db, scopeOf(p))).toMatchObject({ state: "cancelled" });
    expect(wikiStatus(db, scopeOf(p)).ready).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Isolation and staleness

  test("isolates repositories, revisions and generator configurations", async () => {
    initRepo(otherRepo);
    for (const [path, content] of Object.entries({
      "src/a/one.ts": 'import { two } from "../b/two";\nexport const one = two;\n',
      "src/b/two.ts": "export const two = 2;\n",
    })) {
      write(otherRepo, path, content);
    }
    const otherSha = commitAll(otherRepo, "other");
    const db = database();
    const svc = service(db);
    const pilot = await plan(svc);
    const other = await plan(svc, otherSha, LIMITS, "other");
    const pilotGen = generateAll(db, createWikiGeneration(db, pilot, GENERATOR).generation.id);
    const otherGen = generateAll(db, createWikiGeneration(db, other, GENERATOR).generation.id);

    expect(() => wikiIndex(db, { repositoryId: "other", generationId: pilotGen.id })).toThrow(
      WikiAccessDeniedError,
    );
    expect(() =>
      resolveWikiSlug(db, { repositoryId: "pilot", generationId: otherGen.id, slug: "overview" }),
    ).toThrow(WikiAccessDeniedError);
    expect(() =>
      wikiPage(db, { repositoryId: "other", generationId: pilotGen.id, pageId: "x" }),
    ).toThrow(WikiAccessDeniedError);
    expect(wikiStatus(db, scopeOf(other)).ready?.id).toBe(otherGen.id);

    // Another commit of the pilot: the published wiki is stale, not ready.
    write(repo, "src/billing/discount.ts", "export const discount = 0.1;\n");
    const nextSha = commitAll(repo, "discount");
    const next = await plan(svc, nextSha);
    const atNext = wikiStatus(db, scopeOf(next));
    expect(atNext.state).toBe("unavailable");
    expect(atNext.ready).toBeUndefined();
    expect(atNext.stale).toMatchObject({ generation: { id: pilotGen.id }, reasons: ["revision"] });

    // Another generator configuration at the same commit is stale too.
    const reconfigured = wikiStatus(
      db,
      scopeOf(pilot, { generator: "test-writer", promptVersion: "2" }),
    );
    expect(reconfigured.state).toBe("unavailable");
    expect(reconfigured.stale?.reasons).toEqual(["configuration"]);

    // The other repository's wiki never appears as the pilot's.
    expect(atNext.stale?.generation.repositoryId).toBe("pilot");
  });

  // -------------------------------------------------------------------------
  // Stable identity, redirects and removal

  test("keeps page ids across regeneration, redirects renamed slugs and reports removed pages", async () => {
    const db = database();
    const svc = service(db);
    const before = await plan(svc);
    const first = generateAll(db, createWikiGeneration(db, before, GENERATOR).generation.id);
    const idOf = (p: WikiPlan, slug: string) => p.pages.find((page) => page.slug === slug)?.pageId;

    // Unchanged commit, new generation: identical identities.
    expect((await plan(svc)).pages.map((page) => page.pageId)).toEqual(
      before.pages.map((page) => page.pageId),
    );

    // Billing moves to src/invoicing with the same files; the supervisor is deleted.
    git(repo, "mv", "src/billing", "src/invoicing");
    refreshPilotRepo(repo);
    const movedSha = git(repo, "rev-parse", "HEAD");
    const after = await plan(svc, movedSha);
    expect(idOf(after, "modules/invoicing")).toBe(idOf(before, "modules/billing")!);
    expect(idOf(after, "overview")).toBe(idOf(before, "overview")!);
    expect(idOf(after, "modules/recovery")).toBe(idOf(before, "modules/recovery")!);
    expect(idOf(after, "modules/worker")).toBeUndefined();
    expect(idOf(after, "workflows/supervisor")).toBeUndefined();
    const second = generateAll(db, createWikiGeneration(db, after, GENERATOR).generation.id);

    const resolve = (generationId: string, slug: string) =>
      resolveWikiSlug(db, { repositoryId: "pilot", generationId, slug });
    expect(resolve(second.id, "modules/invoicing")).toMatchObject({ outcome: "page" });
    expect(resolve(second.id, "modules/billing")).toMatchObject({
      outcome: "redirect",
      fromSlug: "modules/billing",
      page: { slug: "modules/invoicing", pageId: idOf(before, "modules/billing") },
    });
    expect(resolve(second.id, "workflows/supervisor")).toEqual({
      outcome: "removed",
      slug: "workflows/supervisor",
      pageId: idOf(before, "workflows/supervisor")!,
      lastTitle: "Supervisor flow",
      lastGenerationId: first.id,
    });
    expect(resolve(second.id, "modules/worker")).toMatchObject({ outcome: "removed" });
    expect(resolve(second.id, "never-existed")).toEqual({
      outcome: "not_found",
      slug: "never-existed",
    });
    // The older revision still resolves its own slugs directly.
    expect(resolve(first.id, "modules/billing")).toMatchObject({ outcome: "page" });
    // A new slug from the newer generation redirects to the same concept in the old one.
    expect(resolve(first.id, "modules/invoicing")).toMatchObject({
      outcome: "redirect",
      page: { slug: "modules/billing" },
    });

    // The next regeneration keeps the carried id under its new concept key.
    expect(idOf(await plan(svc, movedSha), "modules/invoicing")).toBe(
      idOf(before, "modules/billing")!,
    );
  });

  test("a published slug stays with its page when a new concept sorts before it", async () => {
    const db = database();
    const svc = service(db);
    const before = await plan(svc);
    const first = generateAll(db, createWikiGeneration(db, before, GENERATOR).generation.id);
    const storageId = before.pages.find((page) => page.slug === "modules/storage")!.pageId;

    // module:apps/storage sorts before module:src/storage and prefers the same slug.
    write(repo, "apps/storage/disk.ts", "export const disk = 1;\n");
    const nextSha = commitAll(repo, "apps storage");
    const after = await plan(svc, nextSha);
    const bySlug = new Map(after.pages.map((page) => [page.slug, page]));
    expect(bySlug.get("modules/storage")).toMatchObject({
      pageId: storageId,
      conceptKey: "module:src/storage",
    });
    expect(bySlug.get("modules/storage-2")!.conceptKey).toBe("module:apps/storage");
    const second = generateAll(db, createWikiGeneration(db, after, GENERATOR).generation.id);
    expect(
      resolveWikiSlug(db, {
        repositoryId: "pilot",
        generationId: second.id,
        slug: "modules/storage",
      }),
    ).toMatchObject({ outcome: "page", page: { pageId: storageId } });

    // A plan made without the history would hand the slug to the newcomer; storage refuses it.
    const unaware = planWiki(db, after.indexBuildId, { limits: LIMITS });
    expect(unaware.pages.find((page) => page.slug === "modules/storage")!.conceptKey).toBe(
      "module:apps/storage",
    );
    write(repo, "apps/storage/more.ts", "export const more = 2;\n");
    const thirdSha = commitAll(repo, "more");
    const stale = planWiki(db, (await plan(svc, thirdSha)).indexBuildId, { limits: LIMITS });
    expect(() => createWikiGeneration(db, stale, GENERATOR)).toThrow(
      "was published for another page",
    );
    expect(wikiStatus(db, scopeOf(before)).ready?.id).toBe(first.id);
  });

  test("a retired page identity never passes to an unrelated concept", async () => {
    initRepo(otherRepo);
    write(otherRepo, "src/alpha/one.ts", "export const one = 1;\n");
    write(otherRepo, "src/alpha/two.ts", "export const two = 2;\n");
    write(otherRepo, "src/keep/keep.ts", "export const keep = 0;\n");
    const firstSha = commitAll(otherRepo, "alpha");
    const db = database();
    const svc = service(db);
    const publish = async (scopeSha: string) => {
      const p = await plan(svc, scopeSha, LIMITS, "other");
      return {
        plan: p,
        generation: generateAll(db, createWikiGeneration(db, p, GENERATOR).generation.id),
      };
    };
    const idOf = (p: WikiPlan, slug: string) => p.pages.find((page) => page.slug === slug)?.pageId;
    const first = await publish(firstSha);
    const alphaId = idOf(first.plan, "modules/alpha")!;

    // Alpha moves to beta with identical files and keeps its identity.
    git(otherRepo, "mv", "src/alpha", "src/beta");
    const moved = await publish(commitAll(otherRepo, "move"));
    expect(idOf(moved.plan, "modules/beta")).toBe(alphaId);

    // Beta is deleted and unrelated code appears under the old alpha path.
    git(otherRepo, "rm", "-r", "--quiet", "src/beta");
    write(otherRepo, "src/alpha/fresh.ts", "export function unrelated() { return 42; }\n");
    const replaced = await publish(commitAll(otherRepo, "replace"));
    const fresh = replaced.plan.pages.find((page) => page.conceptKey === "module:src/alpha")!;
    expect(fresh.pageId).not.toBe(alphaId);
    expect(fresh.slug).toBe("modules/alpha-2");
    const resolve = (slug: string) =>
      resolveWikiSlug(db, { repositoryId: "other", generationId: replaced.generation.id, slug });
    expect(resolve("modules/beta")).toMatchObject({ outcome: "removed", pageId: alphaId });
    expect(resolve("modules/alpha")).toMatchObject({ outcome: "removed", pageId: alphaId });
    expect(resolve("modules/alpha-2")).toMatchObject({
      outcome: "page",
      page: { pageId: fresh.pageId },
    });
  });

  test("a concept that returns after an absence reclaims its id and slug", async () => {
    const db = database();
    const svc = service(db);
    const before = await plan(svc);
    generateAll(db, createWikiGeneration(db, before, GENERATOR).generation.id);
    const billingId = before.pages.find((page) => page.slug === "modules/billing")!.pageId;

    git(repo, "rm", "-r", "--quiet", "src/billing");
    const without = await plan(svc, commitAll(repo, "drop billing"));
    expect(without.pages.some((page) => page.pageId === billingId)).toBe(false);
    generateAll(db, createWikiGeneration(db, without, GENERATOR).generation.id);

    git(repo, "checkout", "--quiet", sha, "--", "src/billing");
    const restored = await plan(svc, commitAll(repo, "restore billing"));
    expect(restored.pages.find((page) => page.conceptKey === "module:src/billing")).toMatchObject({
      pageId: billingId,
      slug: "modules/billing",
    });
  });

  test("the overview of a repository with only root-level code is planned from that code", async () => {
    initRepo(otherRepo);
    write(otherRepo, "main.py", "def main():\n    return 0\n");
    const otherSha = commitAll(otherRepo, "script");
    const db = database();
    const p = await plan(service(db), otherSha, LIMITS, "other");
    const overview = p.pages.find((page) => page.slug === "overview")!;
    expect(overview.state).toBe("queued");
    expect(overview.sources.map((source) => source.path)).toEqual(["main.py"]);
    expect(
      p.pages.filter((page) => page.state === "queued").every((page) => page.sources.length > 0),
    ).toBe(true);
  });

  test("retention retires old wiki generations and keeps slug history", async () => {
    const db = database();
    const svc = service(db);
    const first = generateAll(
      db,
      createWikiGeneration(db, await plan(svc), GENERATOR).generation.id,
    );
    write(repo, "src/billing/discount.ts", "export const discount = 0.1;\n");
    const nextSha = commitAll(repo, "discount");
    const second = generateAll(
      db,
      createWikiGeneration(db, await plan(svc, nextSha), GENERATOR).generation.id,
    );
    expect(
      collectWikiGarbage(db, { retainReadyPerRepository: 1, retainFailedPerRepository: 1 }),
    ).toEqual({ retired: 1, deleted: 1 });
    expect(getWikiGeneration(db, first.id)).toBeUndefined();
    expect(
      db.query("SELECT COUNT(*) AS n FROM wiki_pages WHERE generation_id = ?").get(first.id),
    ).toEqual({ n: 0 });
    expect(getWikiGeneration(db, second.id)?.state).toBe("ready");
    expect(
      resolveWikiSlug(db, { repositoryId: "pilot", generationId: second.id, slug: "overview" }),
    ).toMatchObject({ outcome: "page" });
  });

  // -------------------------------------------------------------------------
  // Configuration

  test("loads documented wiki limits from the environment", () => {
    expect(loadWikiConfig({}).limits).toEqual(DEFAULT_WIKI_PLAN_LIMITS);
    expect(
      loadWikiConfig({
        LOOKY_WIKI_MAX_PAGES: "12",
        LOOKY_WIKI_MAX_DEPTH: "2",
        LOOKY_WIKI_MAX_WORKFLOWS: "0",
        LOOKY_WIKI_MAX_SOURCES_PER_PAGE: "5",
      }).limits,
    ).toEqual({ maxPages: 12, maxDepth: 2, maxModules: 16, maxWorkflows: 0, maxSourcesPerPage: 5 });
    expect(() => loadWikiConfig({ LOOKY_WIKI_MAX_PAGES: "3" })).toThrow("maxPages");
    expect(() => loadWikiConfig({ LOOKY_WIKI_MAX_DEPTH: "1" })).toThrow("maxDepth");
    expect(() => loadWikiConfig({ LOOKY_WIKI_MAX_PAGES: "lots" })).toThrow("LOOKY_WIKI_MAX_PAGES");
  });

  test("slugs are lowercase ASCII words", () => {
    expect(slugify("Crème Brûlée_Service")).toBe("creme-brulee-service");
    expect(slugify("userService")).toBe("user-service");
    expect(slugify("日本")).toBe("page");
  });
});
