/**
 * Persistence for generated wiki generations. Navigation metadata
 * (`wiki_pages`, `wiki_page_links`), page bodies with provenance
 * (`wiki_page_bodies`) and exact source references (`wiki_page_sources`) are
 * stored separately and always scoped by generation, which is itself scoped
 * by repository, commit, index key and generator fingerprint.
 *
 * Every read takes the repository the caller is authorized for and refuses a
 * generation of another repository. Only a published (`ready`) generation is
 * served as current; a generation for another commit or generator key is
 * reported as stale, never as ready.
 */
import type { Database } from "bun:sqlite";
import { EVIDENCE_KINDS } from "../contract/ports";
import { now } from "../indexing/store";
import {
  canTransitionGeneration,
  canTransitionPage,
  type PlannedPage,
  PUBLISHABLE_PAGE_STATES,
  type WikiGenerationState,
  type WikiGeneratorConfig,
  wikiGeneratorKey,
  type WikiLinkRelation,
  type WikiPageKind,
  type WikiPageState,
  type WikiPlan,
  type WikiPlanReport,
  type WikiSourceRef,
  type WikiUsage,
} from "./model";
import type { PriorWikiPage, WikiHistory } from "./planner";

export class WikiStateError extends Error {
  override readonly name = "WikiStateError";
}

/** A generation of another repository was requested. */
export class WikiAccessDeniedError extends Error {
  override readonly name = "WikiAccessDeniedError";
}

/** A plan or generation failed a structural check, such as a dangling link. */
export class WikiIntegrityError extends Error {
  override readonly name = "WikiIntegrityError";
  constructor(readonly problems: readonly string[]) {
    super(`Wiki integrity check failed: ${problems.join("; ")}`);
  }
}

export interface WikiScope {
  readonly repositoryId: string;
  readonly sha: string;
  readonly indexKey: string;
  readonly generatorKey: string;
}

export interface WikiGenerationRecord extends WikiScope {
  readonly id: string;
  readonly indexBuildId: string;
  readonly generatorConfig: WikiGeneratorConfig;
  readonly report: WikiPlanReport;
  readonly pageCount: number;
  readonly state: WikiGenerationState;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
  /** Set when a newer generation of the same scope published or retention retired it. */
  readonly retiredAt: string | null;
  /** Limits the generation ran under, once it started. */
  readonly budget: Readonly<Record<string, unknown>> | null;
  /** What it spent so far, once it started. */
  readonly usage: WikiUsage | null;
}

interface GenerationRow {
  id: string;
  repository_id: string;
  sha: string;
  index_key: string;
  index_build_id: string;
  generator_key: string;
  generator_config: string;
  plan_report: string;
  page_count: number;
  state: WikiGenerationState;
  error_code: string | null;
  error_message: string | null;
  retryable: number | null;
  created_at: string;
  started_at: string | null;
  updated_at: string;
  finished_at: string | null;
  retired_at: string | null;
  budget: string | null;
  usage: string | null;
}

function toGeneration(row: GenerationRow): WikiGenerationRecord {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    sha: row.sha,
    indexKey: row.index_key,
    generatorKey: row.generator_key,
    indexBuildId: row.index_build_id,
    generatorConfig: JSON.parse(row.generator_config) as WikiGeneratorConfig,
    report: JSON.parse(row.plan_report) as WikiPlanReport,
    pageCount: row.page_count,
    state: row.state,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    retryable: row.retryable === null ? null : row.retryable === 1,
    createdAt: row.created_at,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
    retiredAt: row.retired_at,
    budget: row.budget === null ? null : (JSON.parse(row.budget) as Record<string, unknown>),
    usage: row.usage === null ? null : (JSON.parse(row.usage) as WikiUsage),
  };
}

export interface WikiPageRecord {
  readonly generationId: string;
  readonly pageId: string;
  readonly conceptKey: string;
  readonly slug: string;
  readonly kind: WikiPageKind;
  readonly title: string;
  readonly description: string;
  readonly parentPageId: string | null;
  readonly depth: number;
  readonly ordinal: number;
  readonly scopePath: string | null;
  readonly state: WikiPageState;
  readonly unavailableReason: string | null;
  readonly errorMessage: string | null;
  readonly updatedAt: string;
  /** Cache key of the draft that wrote or would write this page. */
  readonly draftKey: string | null;
  /** What writing this page spent; zero calls when a cached draft was reused. */
  readonly usage: (WikiUsage & { readonly reused?: boolean }) | null;
}

interface PageRow {
  generation_id: string;
  page_id: string;
  concept_key: string;
  slug: string;
  kind: WikiPageKind;
  title: string;
  description: string;
  parent_page_id: string | null;
  depth: number;
  ordinal: number;
  scope_path: string | null;
  state: WikiPageState;
  unavailable_reason: string | null;
  error_message: string | null;
  updated_at: string;
  draft_key: string | null;
  usage: string | null;
}

function toPage(row: PageRow): WikiPageRecord {
  return {
    generationId: row.generation_id,
    pageId: row.page_id,
    conceptKey: row.concept_key,
    slug: row.slug,
    kind: row.kind,
    title: row.title,
    description: row.description,
    parentPageId: row.parent_page_id,
    depth: row.depth,
    ordinal: row.ordinal,
    scopePath: row.scope_path,
    state: row.state,
    unavailableReason: row.unavailable_reason,
    errorMessage: row.error_message,
    updatedAt: row.updated_at,
    draftKey: row.draft_key,
    usage: row.usage === null ? null : (JSON.parse(row.usage) as WikiUsage),
  };
}

// ---------------------------------------------------------------------------
// Plan validation

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/**
 * Structural checks a plan must pass before it is stored: within limits,
 * unique ids, concepts and slugs, exactly one root, parents listed before
 * children at depth + 1, no dangling links, and sources only on pages that
 * will be generated.
 */
export function validateWikiPlan(plan: WikiPlan): void {
  const problems: string[] = [];
  const { pages, limits } = plan;
  if (pages.length > limits.maxPages) {
    problems.push(`${pages.length} pages exceed the limit of ${limits.maxPages}`);
  }
  const seen = new Map<string, PlannedPage>();
  const slugs = new Set<string>();
  const concepts = new Set<string>();
  const siblings = new Set<string>();
  let roots = 0;
  for (const page of pages) {
    if (seen.has(page.pageId)) problems.push(`duplicate page id ${page.pageId}`);
    if (slugs.has(page.slug)) problems.push(`duplicate slug ${page.slug}`);
    if (concepts.has(page.conceptKey)) problems.push(`duplicate concept ${page.conceptKey}`);
    if (!SLUG.test(page.slug)) problems.push(`invalid slug ${JSON.stringify(page.slug)}`);
    if (page.depth > limits.maxDepth) {
      problems.push(`page ${page.slug} at depth ${page.depth} exceeds ${limits.maxDepth}`);
    }
    if (page.parentPageId === null) {
      roots += 1;
      if (page.depth !== 0) problems.push(`root page ${page.slug} must have depth 0`);
    } else {
      const parent = seen.get(page.parentPageId);
      if (!parent) problems.push(`page ${page.slug} has no preceding parent ${page.parentPageId}`);
      else if (parent.depth + 1 !== page.depth) {
        problems.push(`page ${page.slug} depth does not follow its parent`);
      }
      const sibling = `${page.parentPageId}#${page.ordinal}`;
      if (siblings.has(sibling)) problems.push(`page ${page.slug} repeats a sibling position`);
      siblings.add(sibling);
    }
    if ((page.state === "unavailable") !== (page.unavailableReason !== null)) {
      problems.push(`page ${page.slug} must have a reason exactly when unavailable`);
    }
    if (page.state === "unavailable" && page.sources.length > 0) {
      problems.push(`unavailable page ${page.slug} must not list sources`);
    }
    if (page.sources.length > limits.maxSourcesPerPage) {
      problems.push(`page ${page.slug} exceeds ${limits.maxSourcesPerPage} sources`);
    }
    for (const source of page.sources) problems.push(...sourceProblems(page.slug, source));
    seen.set(page.pageId, page);
    slugs.add(page.slug);
    concepts.add(page.conceptKey);
  }
  if (roots !== 1) problems.push(`a plan needs exactly one root page, found ${roots}`);
  for (const page of pages) {
    const targets = new Set<string>();
    for (const link of page.links) {
      if (!seen.has(link.toPageId))
        problems.push(`page ${page.slug} links to missing ${link.toPageId}`);
      if (link.toPageId === page.pageId) problems.push(`page ${page.slug} links to itself`);
      if (targets.has(link.toPageId)) problems.push(`page ${page.slug} repeats a link`);
      targets.add(link.toPageId);
    }
  }
  if (problems.length > 0) throw new WikiIntegrityError(problems);
}

function sourceProblems(slug: string, source: WikiSourceRef): string[] {
  const problems: string[] = [];
  if (
    source.path.length === 0 ||
    source.path.startsWith("/") ||
    source.path.split("/").includes("..")
  ) {
    problems.push(`page ${slug} has an unsafe source path`);
  }
  if (!Number.isSafeInteger(source.startLine) || source.startLine < 1) {
    problems.push(`page ${slug} source ${source.path} has an invalid start line`);
  }
  if (!Number.isSafeInteger(source.endLine) || source.endLine < source.startLine) {
    problems.push(`page ${slug} source ${source.path} has an invalid end line`);
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(source.blobOid)) {
    problems.push(`page ${slug} source ${source.path} has an invalid blob id`);
  }
  if (!(EVIDENCE_KINDS as readonly string[]).includes(source.kind)) {
    problems.push(`page ${slug} source ${source.path} has an invalid kind`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Generations

/**
 * Slugs that the repository already published for a different page id. A
 * published slug belongs to its page for good, so reusing it would silently
 * send old links to unrelated content.
 */
function slugConflicts(
  db: Database,
  repositoryId: string,
  pages: readonly ({ readonly slug: string } & (
    | { readonly pageId: string }
    | { readonly page_id: string }
  ))[],
): string[] {
  const owner = db.query<{ page_id: string }, [string, string]>(
    "SELECT page_id FROM wiki_slug_aliases WHERE repository_id = ? AND slug = ?",
  );
  return pages.flatMap((page) => {
    const pageId = "pageId" in page ? page.pageId : page.page_id;
    const published = owner.get(repositoryId, page.slug)?.page_id;
    return published !== undefined && published !== pageId
      ? [`slug ${page.slug} was published for another page, ${published}`]
      : [];
  });
}

export function getWikiGeneration(db: Database, id: string): WikiGenerationRecord | undefined {
  const row = db
    .query<GenerationRow, [string]>("SELECT * FROM wiki_generations WHERE id = ?")
    .get(id);
  return row ? toGeneration(row) : undefined;
}

export function listWikiGenerations(
  db: Database,
  filter: { readonly repositoryId: string; readonly sha?: string; readonly limit?: number },
): WikiGenerationRecord[] {
  return db
    .query<GenerationRow, [string, string | null, number]>(
      `SELECT * FROM wiki_generations
       WHERE repository_id = ?1 AND (?2 IS NULL OR sha = ?2)
       ORDER BY created_at DESC, rowid DESC LIMIT ?3`,
    )
    .all(filter.repositoryId, filter.sha ?? null, filter.limit ?? 50)
    .map(toGeneration);
}

function findGeneration(
  db: Database,
  scope: WikiScope,
  where: string,
): WikiGenerationRecord | undefined {
  const row = db
    .query<GenerationRow, [string, string, string, string]>(
      `SELECT * FROM wiki_generations
       WHERE repository_id = ? AND sha = ? AND index_key = ? AND generator_key = ? AND ${where}
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(scope.repositoryId, scope.sha, scope.indexKey, scope.generatorKey);
  return row ? toGeneration(row) : undefined;
}

export function findReadyWikiGeneration(db: Database, scope: WikiScope) {
  return findGeneration(db, scope, "state = 'ready' AND retired_at IS NULL");
}

export function findActiveWikiGeneration(db: Database, scope: WikiScope) {
  return findGeneration(db, scope, "state IN ('queued', 'running')");
}

/**
 * Store a plan as a queued generation, or return the generation already
 * queued or running for the same scope so concurrent callers share it. The
 * plan's scope comes from the index build it was read from.
 */
export function createWikiGeneration(
  db: Database,
  plan: WikiPlan,
  generator: WikiGeneratorConfig["generator"],
): { readonly created: boolean; readonly generation: WikiGenerationRecord } {
  validateWikiPlan(plan);
  const config: WikiGeneratorConfig = { limits: plan.limits, generator };
  const scope: WikiScope = {
    repositoryId: plan.repositoryId,
    sha: plan.sha,
    indexKey: plan.indexKey,
    generatorKey: wikiGeneratorKey(config),
  };
  return db
    .transaction(() => {
      const active = findActiveWikiGeneration(db, scope);
      if (active) return { created: false, generation: active };
      const conflicts = slugConflicts(db, scope.repositoryId, plan.pages);
      if (conflicts.length > 0) throw new WikiIntegrityError(conflicts);
      const id = `wiki_${crypto.randomUUID()}`;
      const timestamp = now();
      const report: WikiPlanReport = { coverage: plan.coverage, disclosures: plan.disclosures };
      db.query(
        `INSERT INTO wiki_generations (id, repository_id, sha, index_key, index_build_id,
           generator_key, generator_config, plan_report, page_count, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)`,
      ).run(
        id,
        scope.repositoryId,
        scope.sha,
        scope.indexKey,
        plan.indexBuildId,
        scope.generatorKey,
        JSON.stringify(config),
        JSON.stringify(report),
        plan.pages.length,
        timestamp,
        timestamp,
      );
      const insertPage = db.query(
        `INSERT INTO wiki_pages (generation_id, page_id, concept_key, slug, kind, title,
           description, parent_page_id, depth, ordinal, scope_path, state, unavailable_reason,
           updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const page of plan.pages) {
        insertPage.run(
          id,
          page.pageId,
          page.conceptKey,
          page.slug,
          page.kind,
          page.title,
          page.description,
          page.parentPageId,
          page.depth,
          page.ordinal,
          page.scopePath,
          page.state,
          page.unavailableReason,
          timestamp,
        );
      }
      for (const page of plan.pages) {
        insertSources(db, id, page.pageId, "planned", page.sources);
        page.links.forEach((link, ordinal) => {
          db.query(
            `INSERT INTO wiki_page_links (generation_id, from_page_id, to_page_id, relation, ordinal)
             VALUES (?, ?, ?, ?, ?)`,
          ).run(id, page.pageId, link.toPageId, link.relation, ordinal);
        });
      }
      return { created: true, generation: getWikiGeneration(db, id)! };
    })
    .immediate();
}

function insertSources(
  db: Database,
  generationId: string,
  pageId: string,
  role: "planned" | "cited",
  sources: readonly WikiSourceRef[],
): void {
  const insert = db.query(
    `INSERT INTO wiki_page_sources (generation_id, page_id, role, ordinal, path, blob_oid,
       start_line, end_line, kind)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  sources.forEach((source, ordinal) =>
    insert.run(
      generationId,
      pageId,
      role,
      ordinal,
      source.path,
      source.blobOid,
      source.startLine,
      source.endLine,
      source.kind,
    ),
  );
}

function transitionGeneration(
  db: Database,
  id: string,
  to: WikiGenerationState,
  set: string = "",
  params: (string | number | null)[] = [],
): WikiGenerationRecord {
  const current = getWikiGeneration(db, id);
  if (!current) throw new WikiStateError(`Unknown wiki generation ${id}`);
  if (!canTransitionGeneration(current.state, to)) {
    throw new WikiStateError(`Wiki generation ${id} cannot move from ${current.state} to ${to}`);
  }
  const timestamp = now();
  const changed = db
    .query(`UPDATE wiki_generations SET state = ?, updated_at = ?${set} WHERE id = ? AND state = ?`)
    .run(to, timestamp, ...params, id, current.state).changes;
  if (changed !== 1) throw new WikiStateError(`Wiki generation ${id} changed concurrently`);
  return getWikiGeneration(db, id)!;
}

/** queued → running, recording the budget it runs under. */
export function startWikiGeneration(
  db: Database,
  id: string,
  budget?: Readonly<Record<string, unknown>>,
): WikiGenerationRecord {
  return db
    .transaction(() =>
      transitionGeneration(db, id, "running", ", started_at = ?, budget = ?", [
        now(),
        budget === undefined ? null : JSON.stringify(budget),
      ]),
    )
    .immediate();
}

/** Record what a generation has spent so far. Allowed in any state, so a failed run keeps its cost. */
export function recordWikiGenerationUsage(db: Database, id: string, usage: WikiUsage): void {
  db.query("UPDATE wiki_generations SET usage = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(usage),
    now(),
    id,
  );
}

/** Record a page's draft key and what writing it spent, in any state. */
export function recordWikiPageUsage(
  db: Database,
  generationId: string,
  pageId: string,
  record: {
    readonly draftKey?: string;
    readonly usage?: WikiUsage & { readonly reused?: boolean };
  },
): void {
  db.query(
    `UPDATE wiki_pages SET draft_key = coalesce(?, draft_key), usage = coalesce(?, usage)
     WHERE generation_id = ? AND page_id = ?`,
  ).run(
    record.draftKey ?? null,
    record.usage === undefined ? null : JSON.stringify(record.usage),
    generationId,
    pageId,
  );
}

/**
 * Move a queued or running generation to failed or cancelled. Its queued and
 * running pages move to the same state. Returns false if it had already
 * finished; a ready generation is never changed.
 */
export function finishWikiGenerationUnsuccessfully(
  db: Database,
  id: string,
  outcome: {
    readonly state: "failed" | "cancelled";
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
  },
): boolean {
  return db
    .transaction(() => {
      const timestamp = now();
      const changed = db
        .query(
          `UPDATE wiki_generations
           SET state = ?, error_code = ?, error_message = ?, retryable = ?, updated_at = ?,
               finished_at = ?
           WHERE id = ? AND state IN ('queued', 'running')`,
        )
        .run(
          outcome.state,
          outcome.code,
          outcome.message,
          outcome.retryable ? 1 : 0,
          timestamp,
          timestamp,
          id,
        ).changes;
      if (changed === 1) {
        db.query(
          `UPDATE wiki_pages SET state = ?, error_message = ?, updated_at = ?
           WHERE generation_id = ? AND state IN ('queued', 'running')`,
        ).run(outcome.state, outcome.message, timestamp, id);
      }
      return changed === 1;
    })
    .immediate();
}

/**
 * Generations left queued or running by a previous process cannot finish.
 * Mark them failed and retryable so they are never served.
 */
export function failInterruptedWikiGenerations(db: Database): number {
  const ids = db
    .query<{ id: string }, []>(
      "SELECT id FROM wiki_generations WHERE state IN ('queued', 'running')",
    )
    .all();
  for (const { id } of ids) {
    finishWikiGenerationUnsuccessfully(db, id, {
      state: "failed",
      code: "interrupted",
      message: "The service stopped before this wiki generation finished",
      retryable: true,
    });
  }
  return ids.length;
}

// ---------------------------------------------------------------------------
// Pages

function requireGenerationState(
  db: Database,
  id: string,
  states: readonly WikiGenerationState[],
): WikiGenerationRecord {
  const generation = getWikiGeneration(db, id);
  if (!generation) throw new WikiStateError(`Unknown wiki generation ${id}`);
  if (!states.includes(generation.state)) {
    throw new WikiStateError(`Wiki generation ${id} is ${generation.state}`);
  }
  return generation;
}

function getPageRow(db: Database, generationId: string, pageId: string): PageRow | undefined {
  return (
    db
      .query<PageRow, [string, string]>(
        "SELECT * FROM wiki_pages WHERE generation_id = ? AND page_id = ?",
      )
      .get(generationId, pageId) ?? undefined
  );
}

/**
 * Change a page's state along a valid transition while its generation is
 * queued or running. `ready` is reached only through {@link storeWikiPageBody}.
 */
export function setWikiPageState(
  db: Database,
  generationId: string,
  pageId: string,
  to: Exclude<WikiPageState, "ready" | "unavailable">,
  errorMessage?: string,
): WikiPageRecord {
  return db
    .transaction(() => {
      requireGenerationState(db, generationId, ["queued", "running"]);
      const row = getPageRow(db, generationId, pageId);
      if (!row) throw new WikiStateError(`Unknown wiki page ${pageId}`);
      if (!canTransitionPage(row.state, to)) {
        throw new WikiStateError(`Wiki page ${pageId} cannot move from ${row.state} to ${to}`);
      }
      db.query(
        `UPDATE wiki_pages SET state = ?, error_message = ?, updated_at = ?
         WHERE generation_id = ? AND page_id = ?`,
      ).run(
        to,
        to === "failed" ? (errorMessage ?? "Generation failed") : null,
        now(),
        generationId,
        pageId,
      );
      return toPage(getPageRow(db, generationId, pageId)!);
    })
    .immediate();
}

export interface WikiPageProvenance {
  /** What wrote the body, such as a generator name and version. */
  readonly generator: string;
  readonly provider?: string;
  readonly model?: string;
  readonly promptVersion?: string;
  readonly [key: string]: string | number | boolean | undefined;
}

/**
 * Store a running page's natural-language body with the exact source ranges
 * it cites and its provenance, and mark the page ready. The body, citations
 * and provenance are kept apart from navigation metadata.
 */
export function storeWikiPageBody(
  db: Database,
  input: {
    readonly generationId: string;
    readonly pageId: string;
    readonly body: string;
    readonly citations: readonly WikiSourceRef[];
    readonly provenance: WikiPageProvenance;
    readonly draftKey?: string;
    readonly usage?: WikiUsage & { readonly reused?: boolean };
  },
): WikiPageRecord {
  if (input.body.trim().length === 0) throw new WikiIntegrityError(["page body is empty"]);
  const problems = input.citations.flatMap((source) => sourceProblems(input.pageId, source));
  if (problems.length > 0) throw new WikiIntegrityError(problems);
  return db
    .transaction(() => {
      requireGenerationState(db, input.generationId, ["running"]);
      const row = getPageRow(db, input.generationId, input.pageId);
      if (!row) throw new WikiStateError(`Unknown wiki page ${input.pageId}`);
      if (!canTransitionPage(row.state, "ready")) {
        throw new WikiStateError(`Wiki page ${input.pageId} is ${row.state}, not running`);
      }
      const timestamp = now();
      db.query(
        `INSERT INTO wiki_page_bodies (generation_id, page_id, body, body_hash, generated_at,
           provenance)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        input.generationId,
        input.pageId,
        input.body,
        new Bun.CryptoHasher("sha256").update(input.body).digest("hex"),
        timestamp,
        JSON.stringify(input.provenance),
      );
      insertSources(db, input.generationId, input.pageId, "cited", input.citations);
      db.query(
        `UPDATE wiki_pages SET state = 'ready', error_message = NULL, updated_at = ?
         WHERE generation_id = ? AND page_id = ?`,
      ).run(timestamp, input.generationId, input.pageId);
      recordWikiPageUsage(db, input.generationId, input.pageId, {
        ...(input.draftKey !== undefined ? { draftKey: input.draftKey } : {}),
        ...(input.usage !== undefined ? { usage: input.usage } : {}),
      });
      return toPage(getPageRow(db, input.generationId, input.pageId)!);
    })
    .immediate();
}

/**
 * Problems that keep a generation from publishing: pages not ready or
 * unavailable, ready pages without a body, unavailable pages with one,
 * dangling parents or links, broken depth or a page count that disagrees with
 * the plan. Empty when the generation is complete.
 */
export function wikiIntegrityProblems(db: Database, generationId: string): string[] {
  const generation = getWikiGeneration(db, generationId);
  if (!generation) return [`unknown wiki generation ${generationId}`];
  const problems: string[] = [];
  const pages = db
    .query<PageRow & { has_body: number }, [string]>(
      `SELECT p.*, EXISTS (SELECT 1 FROM wiki_page_bodies b
                            WHERE b.generation_id = p.generation_id AND b.page_id = p.page_id)
                     AS has_body
       FROM wiki_pages p WHERE p.generation_id = ?`,
    )
    .all(generationId);
  problems.push(...slugConflicts(db, generation.repositoryId, pages));
  if (pages.length !== generation.pageCount) {
    problems.push(`${pages.length} pages stored, ${generation.pageCount} planned`);
  }
  const byId = new Map(pages.map((page) => [page.page_id, page]));
  if (pages.filter((page) => page.parent_page_id === null).length !== 1) {
    problems.push("the generation needs exactly one root page");
  }
  for (const page of pages) {
    if (!PUBLISHABLE_PAGE_STATES.includes(page.state)) {
      problems.push(`page ${page.slug} is ${page.state}`);
    }
    if (page.state === "ready" && page.has_body !== 1)
      problems.push(`page ${page.slug} has no body`);
    if (page.state === "unavailable" && page.has_body === 1) {
      problems.push(`unavailable page ${page.slug} has a body`);
    }
    if (page.parent_page_id !== null) {
      const parent = byId.get(page.parent_page_id);
      if (!parent) problems.push(`page ${page.slug} has a missing parent`);
      else if (parent.depth + 1 !== page.depth)
        problems.push(`page ${page.slug} has a wrong depth`);
    }
    if (page.depth > generation.generatorConfig.limits.maxDepth) {
      problems.push(`page ${page.slug} exceeds the depth limit`);
    }
  }
  const dangling = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM wiki_page_links l
       WHERE l.generation_id = ?1 AND NOT EXISTS (
         SELECT 1 FROM wiki_pages p WHERE p.generation_id = ?1 AND p.page_id = l.to_page_id)`,
    )
    .get(generationId)!.n;
  if (dangling > 0) problems.push(`${dangling} links point to missing pages`);
  // Links written into bodies must reach a page of this generation that will be served.
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const bodies = db
    .query<{ page_id: string; body: string }, [string]>(
      "SELECT page_id, body FROM wiki_page_bodies WHERE generation_id = ?",
    )
    .all(generationId);
  for (const { page_id, body } of bodies) {
    for (const slug of wikiBodyLinks(body)) {
      const target = bySlug.get(slug);
      if (!target)
        problems.push(`page ${byId.get(page_id)?.slug ?? page_id} links to missing ${slug}`);
      else if (target.state !== "ready") {
        problems.push(
          `page ${byId.get(page_id)?.slug ?? page_id} links to ${target.state} ${slug}`,
        );
      }
    }
  }
  return problems;
}

/** Internal page links in a stored body, written as `[Title](wiki:slug)`. */
export const WIKI_LINK = /\]\(wiki:([^)\s]*)\)/g;

export function wikiBodyLinks(body: string): string[] {
  return [...body.matchAll(WIKI_LINK)].map((match) => match[1]!);
}

/**
 * Publish a running generation atomically: check integrity, retire the
 * previously served generation of the same scope, record slug aliases for
 * redirects and mark it ready, all in one transaction. A failed check leaves
 * the generation running and throws {@link WikiIntegrityError}; partial pages
 * never masquerade as a finished wiki.
 */
export function publishWikiGeneration(db: Database, generationId: string): WikiGenerationRecord {
  return db
    .transaction(() => {
      const generation = requireGenerationState(db, generationId, ["running"]);
      const problems = wikiIntegrityProblems(db, generationId);
      if (problems.length > 0) throw new WikiIntegrityError(problems);
      const timestamp = now();
      db.query(
        `UPDATE wiki_generations SET retired_at = ?
         WHERE repository_id = ? AND sha = ? AND index_key = ? AND generator_key = ?
           AND state = 'ready' AND retired_at IS NULL`,
      ).run(
        timestamp,
        generation.repositoryId,
        generation.sha,
        generation.indexKey,
        generation.generatorKey,
      );
      db.query(
        `INSERT INTO wiki_slug_aliases (repository_id, slug, page_id, concept_key, title,
           generation_id, recorded_at)
         SELECT ?1, slug, page_id, concept_key, title, generation_id, ?2
         FROM wiki_pages WHERE generation_id = ?3
         ON CONFLICT (repository_id, slug) DO UPDATE SET
           concept_key = excluded.concept_key, title = excluded.title,
           generation_id = excluded.generation_id, recorded_at = excluded.recorded_at
         WHERE wiki_slug_aliases.page_id = excluded.page_id`,
      ).run(generation.repositoryId, timestamp, generationId);
      return transitionGeneration(db, generationId, "ready", ", finished_at = ?", [timestamp]);
    })
    .immediate();
}

// ---------------------------------------------------------------------------
// Status

export type WikiStatusState = "unavailable" | WikiGenerationState;

export interface WikiStatus extends WikiScope {
  /**
   * `ready` only for a published generation of exactly this scope. Otherwise
   * the latest attempt's state, or `unavailable` when there was none.
   */
  readonly state: WikiStatusState;
  readonly ready?: WikiGenerationRecord;
  readonly active?: WikiGenerationRecord;
  readonly latest?: WikiGenerationRecord;
  /**
   * The repository's most recent published generation for another commit or
   * generator configuration, for explicit display as stale. Never current.
   */
  readonly stale?: {
    readonly generation: WikiGenerationRecord;
    readonly reasons: readonly ("revision" | "index" | "configuration")[];
  };
}

export function wikiStatus(db: Database, scope: WikiScope): WikiStatus {
  const ready = findReadyWikiGeneration(db, scope);
  const active = findActiveWikiGeneration(db, scope);
  const latest = findGeneration(db, scope, "1 = 1");
  const base = {
    ...scope,
    ...(ready ? { ready } : {}),
    ...(active ? { active } : {}),
    ...(latest ? { latest } : {}),
  };
  if (ready) return { ...base, state: "ready" };
  const staleRow = db
    .query<GenerationRow, [string]>(
      `SELECT * FROM wiki_generations
       WHERE repository_id = ? AND state = 'ready' AND retired_at IS NULL
       ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    )
    .get(scope.repositoryId);
  const stale = staleRow ? toGeneration(staleRow) : undefined;
  const withStale = stale
    ? {
        ...base,
        stale: {
          generation: stale,
          reasons: [
            ...(stale.sha !== scope.sha ? (["revision"] as const) : []),
            ...(stale.indexKey !== scope.indexKey ? (["index"] as const) : []),
            ...(stale.generatorKey !== scope.generatorKey ? (["configuration"] as const) : []),
          ],
        },
      }
    : base;
  if (active) return { ...withStale, state: active.state };
  if (latest) return { ...withStale, state: latest.state };
  return { ...withStale, state: "unavailable" };
}

// ---------------------------------------------------------------------------
// Authorized reads

/** The generation, refused if it belongs to another repository. */
export function authorizedGeneration(
  db: Database,
  repositoryId: string,
  generationId: string,
): WikiGenerationRecord | undefined {
  const generation = getWikiGeneration(db, generationId);
  if (generation && generation.repositoryId !== repositoryId) {
    throw new WikiAccessDeniedError(
      `Wiki generation ${generationId} does not belong to ${repositoryId}`,
    );
  }
  return generation;
}

export interface WikiTocEntry {
  readonly pageId: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: WikiPageKind;
  readonly state: WikiPageState;
  readonly unavailableReason: string | null;
  readonly description: string;
  readonly children: readonly WikiTocEntry[];
}

export interface WikiLink {
  readonly fromPageId: string;
  readonly toPageId: string;
  readonly relation: WikiLinkRelation;
}

/** Navigation of one generation: table of contents, internal links and plan report. No bodies. */
export interface WikiIndex {
  readonly generation: WikiGenerationRecord;
  readonly toc: WikiTocEntry;
  readonly pages: readonly WikiPageRecord[];
  readonly links: readonly WikiLink[];
  readonly report: WikiPlanReport;
}

export function wikiIndex(
  db: Database,
  request: { readonly repositoryId: string; readonly generationId: string },
): WikiIndex | undefined {
  const generation = authorizedGeneration(db, request.repositoryId, request.generationId);
  if (!generation) return undefined;
  const pages = db
    .query<PageRow, [string]>(
      "SELECT * FROM wiki_pages WHERE generation_id = ? ORDER BY depth, parent_page_id, ordinal",
    )
    .all(generation.id)
    .map(toPage);
  const links = db
    .query<{ from_page_id: string; to_page_id: string; relation: WikiLinkRelation }, [string]>(
      `SELECT from_page_id, to_page_id, relation FROM wiki_page_links
       WHERE generation_id = ? ORDER BY from_page_id, ordinal`,
    )
    .all(generation.id)
    .map((row) => ({
      fromPageId: row.from_page_id,
      toPageId: row.to_page_id,
      relation: row.relation,
    }));
  const children = new Map<string | null, WikiPageRecord[]>();
  for (const page of pages) {
    children.set(page.parentPageId, [...(children.get(page.parentPageId) ?? []), page]);
  }
  const build = (page: WikiPageRecord): WikiTocEntry => ({
    pageId: page.pageId,
    slug: page.slug,
    title: page.title,
    kind: page.kind,
    state: page.state,
    unavailableReason: page.unavailableReason,
    description: page.description,
    children: (children.get(page.pageId) ?? []).sort((a, b) => a.ordinal - b.ordinal).map(build),
  });
  const root = children.get(null)?.[0];
  if (!root) return undefined;
  return { generation, toc: build(root), pages, links, report: generation.report };
}

export interface WikiPageContent {
  readonly page: WikiPageRecord;
  readonly body?: {
    readonly text: string;
    readonly bodyHash: string;
    readonly generatedAt: string;
    readonly provenance: WikiPageProvenance;
  };
  readonly plannedSources: readonly WikiSourceRef[];
  readonly citations: readonly WikiSourceRef[];
}

export function wikiPage(
  db: Database,
  request: {
    readonly repositoryId: string;
    readonly generationId: string;
    readonly pageId: string;
  },
): WikiPageContent | undefined {
  if (!authorizedGeneration(db, request.repositoryId, request.generationId)) return undefined;
  const row = getPageRow(db, request.generationId, request.pageId);
  if (!row) return undefined;
  const body = db
    .query<
      { body: string; body_hash: string; generated_at: string; provenance: string },
      [string, string]
    >(
      `SELECT body, body_hash, generated_at, provenance FROM wiki_page_bodies
       WHERE generation_id = ? AND page_id = ?`,
    )
    .get(request.generationId, request.pageId);
  const sources = db
    .query<
      {
        role: "planned" | "cited";
        path: string;
        blob_oid: string;
        start_line: number;
        end_line: number;
        kind: WikiSourceRef["kind"];
      },
      [string, string]
    >(
      `SELECT role, path, blob_oid, start_line, end_line, kind FROM wiki_page_sources
       WHERE generation_id = ? AND page_id = ? ORDER BY role, ordinal`,
    )
    .all(request.generationId, request.pageId);
  const toRef = (source: (typeof sources)[number]): WikiSourceRef => ({
    path: source.path,
    blobOid: source.blob_oid,
    startLine: source.start_line,
    endLine: source.end_line,
    kind: source.kind,
  });
  return {
    page: toPage(row),
    ...(body
      ? {
          body: {
            text: body.body,
            bodyHash: body.body_hash,
            generatedAt: body.generated_at,
            provenance: JSON.parse(body.provenance) as WikiPageProvenance,
          },
        }
      : {}),
    plannedSources: sources.filter((source) => source.role === "planned").map(toRef),
    citations: sources.filter((source) => source.role === "cited").map(toRef),
  };
}

export type SlugResolution =
  | { readonly outcome: "page"; readonly page: WikiPageRecord }
  /** The slug was renamed; the same page now lives at `page.slug`. */
  | { readonly outcome: "redirect"; readonly fromSlug: string; readonly page: WikiPageRecord }
  /** The slug once named a page that this generation no longer has. */
  | {
      readonly outcome: "removed";
      readonly slug: string;
      readonly pageId: string;
      readonly lastTitle: string;
      readonly lastGenerationId: string;
    }
  | { readonly outcome: "not_found"; readonly slug: string };

/**
 * Resolve a slug within one generation. A slug of this generation is served
 * directly. A slug the repository published before redirects only to the very
 * same page id; if that page is gone the outcome is `removed`. Nothing ever
 * redirects to a different page.
 */
export function resolveWikiSlug(
  db: Database,
  request: { readonly repositoryId: string; readonly generationId: string; readonly slug: string },
): SlugResolution {
  const generation = authorizedGeneration(db, request.repositoryId, request.generationId);
  if (!generation) return { outcome: "not_found", slug: request.slug };
  const direct = db
    .query<PageRow, [string, string]>(
      "SELECT * FROM wiki_pages WHERE generation_id = ? AND slug = ?",
    )
    .get(generation.id, request.slug);
  if (direct) return { outcome: "page", page: toPage(direct) };
  const alias = db
    .query<{ page_id: string; title: string; generation_id: string }, [string, string]>(
      "SELECT page_id, title, generation_id FROM wiki_slug_aliases WHERE repository_id = ? AND slug = ?",
    )
    .get(request.repositoryId, request.slug);
  if (!alias) return { outcome: "not_found", slug: request.slug };
  const current = getPageRow(db, generation.id, alias.page_id);
  if (current) return { outcome: "redirect", fromSlug: request.slug, page: toPage(current) };
  return {
    outcome: "removed",
    slug: request.slug,
    pageId: alias.page_id,
    lastTitle: alias.title,
    lastGenerationId: alias.generation_id,
  };
}

/**
 * Pages of the repository's most recently published generation, used by the
 * planner to keep identities stable. Any commit and generator key qualifies,
 * because page identity follows the concept, not the configuration.
 */
export function priorWikiPages(db: Database, repositoryId: string): PriorWikiPage[] {
  const latest = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM wiki_generations WHERE repository_id = ? AND state = 'ready'
       ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
    )
    .get(repositoryId);
  if (!latest) return [];
  const pages = db
    .query<{ page_id: string; concept_key: string; kind: WikiPageKind }, [string]>(
      "SELECT page_id, concept_key, kind FROM wiki_pages WHERE generation_id = ? ORDER BY page_id",
    )
    .all(latest.id);
  const blobs = db
    .query<{ page_id: string; blob_oid: string }, [string]>(
      `SELECT page_id, blob_oid FROM wiki_page_sources
       WHERE generation_id = ? AND role = 'planned' ORDER BY page_id, ordinal`,
    )
    .all(latest.id);
  return pages.map((page) => ({
    pageId: page.page_id,
    conceptKey: page.concept_key,
    kind: page.kind,
    blobOids: blobs.filter((row) => row.page_id === page.page_id).map((row) => row.blob_oid),
  }));
}

/**
 * Every slug and page id the repository published, for the planner. Slug
 * history survives retention, so it outlives deleted generations.
 */
export function wikiHistory(db: Database, repositoryId: string): WikiHistory {
  const rows = db
    .query<{ slug: string; page_id: string; concept_key: string }, [string]>(
      `SELECT slug, page_id, concept_key FROM wiki_slug_aliases WHERE repository_id = ?
       ORDER BY recorded_at, slug`,
    )
    .all(repositoryId);
  const slugOwners = new Map<string, string>();
  const pageConcepts = new Map<string, string>();
  for (const row of rows) {
    slugOwners.set(row.slug, row.page_id);
    // Rows are in publication order, so the latest concept of a page wins.
    pageConcepts.set(row.page_id, row.concept_key);
  }
  return { slugOwners, pageConcepts };
}

// ---------------------------------------------------------------------------
// Draft cache

/** A blob a draft actually read, checked again before the draft is reused. */
export interface InspectedBlob {
  readonly path: string;
  readonly blobOid: string;
}

/**
 * A validated page draft, kept apart from any generation. Its key covers the
 * page's planned sources, its link neighbourhood and the writer fingerprint
 * (generator, prompt, model and output-affecting budgets), so a draft is only
 * found for the same inputs and the same writer.
 */
export interface WikiDraftRecord {
  readonly repositoryId: string;
  readonly draftKey: string;
  readonly pageId: string;
  readonly conceptKey: string;
  readonly writerKey: string;
  readonly body: string;
  readonly bodyHash: string;
  readonly citations: readonly WikiSourceRef[];
  readonly inspected: readonly InspectedBlob[];
  readonly provenance: WikiPageProvenance;
  readonly usage: WikiUsage;
  readonly createdAt: string;
  readonly lastUsedAt: string;
}

interface DraftRow {
  repository_id: string;
  draft_key: string;
  page_id: string;
  concept_key: string;
  writer_key: string;
  body: string;
  body_hash: string;
  citations: string;
  inspected: string;
  provenance: string;
  usage: string;
  created_at: string;
  last_used_at: string;
}

export function findWikiDraft(
  db: Database,
  repositoryId: string,
  draftKey: string,
): WikiDraftRecord | undefined {
  const row = db
    .query<DraftRow, [string, string]>(
      "SELECT * FROM wiki_page_drafts WHERE repository_id = ? AND draft_key = ?",
    )
    .get(repositoryId, draftKey);
  if (!row) return undefined;
  return {
    repositoryId: row.repository_id,
    draftKey: row.draft_key,
    pageId: row.page_id,
    conceptKey: row.concept_key,
    writerKey: row.writer_key,
    body: row.body,
    bodyHash: row.body_hash,
    citations: JSON.parse(row.citations) as WikiSourceRef[],
    inspected: JSON.parse(row.inspected) as InspectedBlob[],
    provenance: JSON.parse(row.provenance) as WikiPageProvenance,
    usage: JSON.parse(row.usage) as WikiUsage,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
  };
}

/** Keep a validated draft for reuse. A later draft for the same key replaces it. */
export function storeWikiDraft(
  db: Database,
  draft: Omit<WikiDraftRecord, "bodyHash" | "createdAt" | "lastUsedAt">,
): void {
  if (draft.body.trim().length === 0) throw new WikiIntegrityError(["draft body is empty"]);
  const problems = draft.citations.flatMap((source) => sourceProblems(draft.pageId, source));
  if (problems.length > 0) throw new WikiIntegrityError(problems);
  const timestamp = now();
  db.query(
    `INSERT INTO wiki_page_drafts (repository_id, draft_key, page_id, concept_key, writer_key,
       body, body_hash, citations, inspected, provenance, usage, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (repository_id, draft_key) DO UPDATE SET
       page_id = excluded.page_id, concept_key = excluded.concept_key,
       writer_key = excluded.writer_key, body = excluded.body, body_hash = excluded.body_hash,
       citations = excluded.citations, inspected = excluded.inspected,
       provenance = excluded.provenance, usage = excluded.usage,
       created_at = excluded.created_at, last_used_at = excluded.last_used_at`,
  ).run(
    draft.repositoryId,
    draft.draftKey,
    draft.pageId,
    draft.conceptKey,
    draft.writerKey,
    draft.body,
    new Bun.CryptoHasher("sha256").update(draft.body).digest("hex"),
    JSON.stringify(draft.citations),
    JSON.stringify(draft.inspected),
    JSON.stringify(draft.provenance),
    JSON.stringify(draft.usage),
    timestamp,
    timestamp,
  );
}

export function touchWikiDraft(db: Database, repositoryId: string, draftKey: string): void {
  db.query(
    "UPDATE wiki_page_drafts SET last_used_at = ? WHERE repository_id = ? AND draft_key = ?",
  ).run(now(), repositoryId, draftKey);
}

export function deleteWikiDraft(db: Database, repositoryId: string, draftKey: string): void {
  db.query("DELETE FROM wiki_page_drafts WHERE repository_id = ? AND draft_key = ?").run(
    repositoryId,
    draftKey,
  );
}

// ---------------------------------------------------------------------------
// Retention

export interface WikiRetention {
  /** Served generations kept per repository, most recently published first. */
  readonly retainReadyPerRepository: number;
  /** Failed and cancelled generations kept per repository for diagnostics. */
  readonly retainFailedPerRepository: number;
  /** Cached page drafts kept per repository, most recently used first. Default 1000. */
  readonly retainDraftsPerRepository?: number;
}

/**
 * Bound wiki storage: retire served generations beyond the per-repository
 * limit, delete retired ones and old failed or cancelled ones. Never touches
 * queued or running generations. Slug aliases are kept so old links keep
 * resolving to a redirect or an explicit removed outcome.
 */
export function collectWikiGarbage(
  db: Database,
  retention: WikiRetention,
): { readonly retired: number; readonly deleted: number } {
  return db
    .transaction(() => {
      const retired = db
        .query(
          `UPDATE wiki_generations SET retired_at = ?1 WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY repository_id ORDER BY finished_at DESC, rowid DESC) AS rank
               FROM wiki_generations WHERE state = 'ready' AND retired_at IS NULL
             ) WHERE rank > ?2)`,
        )
        .run(now(), retention.retainReadyPerRepository).changes;
      const deletedRetired = db
        .query("DELETE FROM wiki_generations WHERE state = 'ready' AND retired_at IS NOT NULL")
        .run().changes;
      const deletedFailed = db
        .query(
          `DELETE FROM wiki_generations WHERE id IN (
             SELECT id FROM (
               SELECT id, ROW_NUMBER() OVER (
                 PARTITION BY repository_id ORDER BY created_at DESC, rowid DESC) AS rank
               FROM wiki_generations WHERE state IN ('failed', 'cancelled')
             ) WHERE rank > ?)`,
        )
        .run(retention.retainFailedPerRepository).changes;
      db.query(
        `DELETE FROM wiki_page_drafts WHERE rowid IN (
           SELECT rowid FROM (
             SELECT rowid, ROW_NUMBER() OVER (
               PARTITION BY repository_id ORDER BY last_used_at DESC, rowid DESC) AS rank
             FROM wiki_page_drafts
           ) WHERE rank > ?)`,
      ).run(retention.retainDraftsPerRepository ?? 1000);
      return { retired, deleted: deletedRetired + deletedFailed };
    })
    .immediate();
}
