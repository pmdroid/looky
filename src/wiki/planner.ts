/**
 * Deterministic, bounded wiki planning from one ready index build.
 *
 * The plan is derived only from what the index stored: indexed paths, blob
 * ids, line counts, extracted symbols and the import lines of code files.
 * Nothing is read from the worktree and no model is called, so the same
 * build, limits and prior pages always give the same plan.
 *
 * Structure, with depths:
 *
 *   0  Overview                      (always planned)
 *   1  Architecture                  (needs at least two code modules)
 *   1  Modules                       (needs at least one code module)
 *   2    one page per major module   (largest first, up to maxModules)
 *   3      submodule pages           (large modules only, maxDepth >= 3)
 *   1  Workflows                     (needs a cross-module import flow)
 *   2    one page per key workflow   (widest flows first, up to maxWorkflows)
 *
 * A section without evidence is planned as `unavailable` with its reason, so
 * readers see what is missing instead of invented content. Modules or
 * workflows beyond the limits are disclosed, and their files are reported as
 * uncovered. It never plans one page per file.
 */
import type { Database } from "bun:sqlite";
import { posix } from "node:path";
import type { EvidenceKind } from "../contract/ports";
import { coverageReport, getBuild } from "../indexing/store";
import { evidenceKind } from "../retrieval/kinds";
import {
  FIXED_WIKI_PAGES,
  type PlannedLink,
  type PlannedPage,
  shortHash,
  type UncoveredReason,
  type WikiDisclosure,
  type WikiPageKind,
  type WikiPlan,
  type WikiPlanLimits,
  type WikiSourceRef,
  validateWikiPlanLimits,
} from "./model";

/** A page of an earlier generation, used to keep identities stable. */
export interface PriorWikiPage {
  readonly pageId: string;
  readonly conceptKey: string;
  readonly kind: WikiPageKind;
  /** Blob ids of the page's planned sources. */
  readonly blobOids: readonly string[];
}

export interface PlanWikiOptions {
  readonly limits: WikiPlanLimits;
  /** Pages of the repository's previous generation, for stable identities across renames. */
  readonly prior?: readonly PriorWikiPage[];
  /** Most uncovered paths listed in the report. Counts are always complete. */
  readonly uncoveredListLimit?: number;
}

/** Share of identical blobs at which a renamed module or workflow keeps its page id. */
export const RENAME_SIMILARITY = 0.5;

export class WikiPlanError extends Error {
  override readonly name = "WikiPlanError";
}

interface IndexedFile {
  readonly path: string;
  readonly blobOid: string;
  readonly lines: number;
  readonly kind: EvidenceKind;
  readonly symbols: number;
}

const SOURCE_ROOTS = new Set(["src", "lib", "app", "source", "internal", "pkg", "cmd"]);
const PACKAGE_ROOTS = new Set(["packages", "apps", "libs", "services", "crates", "modules"]);
const ENTRY_STEMS = new Set(["index", "main", "mod", "__init__", "lib", "app"]);
const MANIFESTS = new Set([
  "package.json",
  "cargo.toml",
  "go.mod",
  "pyproject.toml",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "gemfile",
  "composer.json",
  "dockerfile",
  "makefile",
]);
const ARCHITECTURE_DOC = /(?:^|[/_-])(?:architecture|design|overview|adr)/i;
const MAX_MODULE_LINKS = 8;
const MAX_SUBMODULES_PER_MODULE = 6;
const SUBMODULE_MIN_FILES = 3;
const MAX_TESTS_PER_PAGE = 2;
const WORKFLOW_IMPORT_DEPTH = 4;

/** Plan a wiki for one ready build. Throws {@link WikiPlanError} if the build is not ready. */
export function planWiki(db: Database, buildId: string, options: PlanWikiOptions): WikiPlan {
  const { limits } = options;
  validateWikiPlanLimits(limits);
  const build = getBuild(db, buildId);
  if (!build || build.state !== "ready") {
    throw new WikiPlanError(`Index build ${buildId} is not ready`);
  }
  const files = loadIndexedFiles(db, buildId);
  const byPath = new Map(files.map((file) => [file.path, file]));
  const imports = loadImports(db, buildId, byPath);

  // ---- Modules ------------------------------------------------------------
  const moduleFiles = new Map<string, IndexedFile[]>();
  for (const file of files) {
    if (file.kind !== "code") continue;
    const key = moduleOf(file.path);
    if (key === undefined) continue;
    const list = moduleFiles.get(key) ?? [];
    list.push(file);
    moduleFiles.set(key, list);
  }
  const rankedModules = [...moduleFiles.entries()]
    .map(([path, members]) => ({
      path,
      members,
      lines: members.reduce((total, file) => total + file.lines, 0),
    }))
    .sort(
      (a, b) => b.members.length - a.members.length || b.lines - a.lines || compare(a.path, b.path),
    );
  const moduleBudget = Math.min(limits.maxModules, limits.maxPages - FIXED_WIKI_PAGES);
  const plannedModules = rankedModules
    .slice(0, moduleBudget)
    .sort((a, b) => compare(a.path, b.path));
  const plannedModuleSet = new Set(plannedModules.map((module) => module.path));

  // ---- Workflows ----------------------------------------------------------
  const importedBy = new Map<string, Set<string>>();
  for (const [from, targets] of imports) {
    if (byPath.get(from)?.kind !== "code") continue;
    for (const target of targets) {
      const set = importedBy.get(target) ?? new Set();
      set.add(from);
      importedBy.set(target, set);
    }
  }
  const candidates: { root: IndexedFile; closure: string[]; modules: string[] }[] = [];
  for (const file of files) {
    if (file.kind !== "code" || importedBy.has(file.path)) continue;
    const closure = importClosure(file.path, imports, byPath);
    const modules = unique(
      closure.map((path) => moduleOf(path)).filter((key): key is string => key !== undefined),
    );
    if (modules.length >= 2) candidates.push({ root: file, closure, modules });
  }
  candidates.sort(
    (a, b) =>
      b.modules.length - a.modules.length ||
      b.closure.length - a.closure.length ||
      compare(a.root.path, b.root.path),
  );
  const workflowBudget = Math.min(
    limits.maxWorkflows,
    limits.maxPages - FIXED_WIKI_PAGES - plannedModules.length,
  );
  const chosenWorkflows: typeof candidates = [];
  for (const candidate of candidates) {
    if (chosenWorkflows.length >= workflowBudget) break;
    const covered = chosenWorkflows.some((chosen) =>
      candidate.closure.every((path) => chosen.closure.includes(path)),
    );
    if (!covered) chosenWorkflows.push(candidate);
  }
  const distinctWorkflows = candidates.filter(
    (candidate, index) =>
      !candidates
        .slice(0, index)
        .some((earlier) => candidate.closure.every((path) => earlier.closure.includes(path))),
  ).length;
  chosenWorkflows.sort((a, b) => compare(a.root.path, b.root.path));

  // ---- Submodules ---------------------------------------------------------
  let submoduleBudget =
    limits.maxDepth >= 3
      ? limits.maxPages - FIXED_WIKI_PAGES - plannedModules.length - chosenWorkflows.length
      : 0;
  let submodulesFound = 0;
  const submodules = new Map<string, { path: string; members: IndexedFile[] }[]>();
  for (const module of plannedModules) {
    const groups = new Map<string, IndexedFile[]>();
    for (const file of module.members) {
      const rest = file.path.slice(module.path.length + 1).split("/");
      if (rest.length < 2) continue;
      const key = `${module.path}/${rest[0]}`;
      groups.set(key, [...(groups.get(key) ?? []), file]);
    }
    const eligible = [...groups.entries()]
      .filter(([, members]) => members.length >= SUBMODULE_MIN_FILES)
      .map(([path, members]) => ({ path, members }))
      .sort((a, b) => b.members.length - a.members.length || compare(a.path, b.path));
    if (eligible.length < 2) continue;
    submodulesFound += eligible.length;
    const take = Math.min(eligible.length, MAX_SUBMODULES_PER_MODULE, submoduleBudget);
    submoduleBudget -= take;
    if (take > 0) {
      submodules.set(
        module.path,
        eligible.slice(0, take).sort((a, b) => compare(a.path, b.path)),
      );
    }
  }

  // ---- Pages --------------------------------------------------------------
  const ids = new IdAssigner(options.prior ?? []);
  const disclosures: WikiDisclosure[] = [];
  const drafts: Draft[] = [];
  const pick = (candidatesForPage: readonly IndexedFile[]) =>
    uniqueFiles(candidatesForPage).slice(0, limits.maxSourcesPerPage);
  const testsFor = (paths: readonly string[]) => {
    const targets = new Set(paths);
    return files
      .filter(
        (file) =>
          file.kind === "test" && [...(imports.get(file.path) ?? [])].some((p) => targets.has(p)),
      )
      .slice(0, MAX_TESTS_PER_PAGE);
  };
  const topOf = (members: readonly IndexedFile[]) => rankWithin(members)[0]!;
  const rootFiles = files.filter((file) => !file.path.includes("/"));
  const rootDocs = rootFiles.filter((file) => file.kind === "docs");
  const readme = rootDocs.filter((file) => /^readme(?:\.|$)/i.test(file.path));
  const manifests = rootFiles.filter((file) => MANIFESTS.has(file.path.toLowerCase()));
  const docsFiles = files.filter((file) => file.kind === "docs" && file.path.includes("/"));

  // Overview
  const overview: Draft = {
    conceptKey: "overview",
    kind: "overview",
    slug: "overview",
    title: "Overview",
    description:
      files.length === 0
        ? "No indexed files at this commit."
        : `Repository overview from ${files.length} indexed files.`,
    parent: null,
    scopePath: null,
    unavailableReason:
      files.length === 0 ? "The index has no eligible files at this commit." : null,
    sources: pick([
      ...readme,
      ...rootDocs,
      ...manifests,
      ...docsFiles.slice(0, 3),
      ...plannedModules.map((module) => topOf(module.members)),
    ]),
    links: [],
  };
  drafts.push(overview);

  // Architecture
  const architecture: Draft = {
    conceptKey: "architecture",
    kind: "architecture",
    slug: "architecture",
    title: "Architecture",
    description: `How ${plannedModules.length} modules fit together.`,
    parent: overview,
    scopePath: null,
    unavailableReason:
      plannedModules.length >= 2
        ? null
        : "Fewer than two code modules were found, so there is no cross-module structure to describe.",
    sources: pick([
      ...docsFiles.filter((file) => ARCHITECTURE_DOC.test(file.path)),
      ...rootDocs.filter((file) => ARCHITECTURE_DOC.test(file.path)),
      ...manifests,
      ...chosenWorkflows.map((workflow) => workflow.root),
      ...plannedModules.map((module) => topOf(module.members)),
      ...files.filter((file) => file.kind === "config"),
    ]),
    links: [],
  };
  drafts.push(architecture);

  // Modules
  const modulesSection: Draft = {
    conceptKey: "section:modules",
    kind: "section",
    slug: "modules",
    title: "Modules",
    description: `${plannedModules.length} major modules.`,
    parent: overview,
    scopePath: null,
    unavailableReason:
      plannedModules.length > 0 ? null : "No code modules were found among the indexed files.",
    sources: pick(plannedModules.map((module) => topOf(module.members))),
    links: [],
  };
  drafts.push(modulesSection);
  const moduleDrafts = new Map<string, Draft>();
  for (const module of plannedModules) {
    const members = rankWithin(module.members);
    const draft: Draft = {
      conceptKey: `module:${module.path}`,
      kind: "module",
      slug: `modules/${slugify(lastSegment(module.path))}`,
      title: moduleTitle(module.path),
      description: `${module.members.length} code files in ${module.path}/.`,
      parent: modulesSection,
      scopePath: module.path,
      origin: module.path,
      unavailableReason: null,
      sources: pick([
        ...members.slice(0, Math.max(1, limits.maxSourcesPerPage - MAX_TESTS_PER_PAGE - 1)),
        ...testsFor(module.members.map((file) => file.path)),
        ...files.filter((file) => file.kind === "docs" && file.path.startsWith(`${module.path}/`)),
        ...members,
      ]),
      links: [],
    };
    drafts.push(draft);
    moduleDrafts.set(module.path, draft);
    for (const sub of submodules.get(module.path) ?? []) {
      drafts.push({
        conceptKey: `module:${sub.path}`,
        kind: "module",
        slug: `modules/${slugify(lastSegment(module.path))}/${slugify(lastSegment(sub.path))}`,
        title: `${moduleTitle(module.path)}: ${humanize(lastSegment(sub.path))}`,
        description: `${sub.members.length} code files in ${sub.path}/.`,
        parent: draft,
        scopePath: sub.path,
        origin: sub.path,
        unavailableReason: null,
        sources: pick([
          ...rankWithin(sub.members),
          ...testsFor(sub.members.map((file) => file.path)),
        ]),
        links: [],
      });
    }
  }
  // Module links: modules this module imports from.
  for (const module of plannedModules) {
    const used = new Set<string>();
    for (const file of module.members) {
      for (const target of imports.get(file.path) ?? []) {
        const key = moduleOf(target);
        if (key && key !== module.path && plannedModuleSet.has(key)) used.add(key);
      }
    }
    moduleDrafts.get(module.path)!.links.push(
      ...[...used]
        .sort(compare)
        .slice(0, MAX_MODULE_LINKS)
        .map((key) => ({ to: moduleDrafts.get(key)!, relation: "uses" as const })),
    );
  }

  // Workflows
  const workflowsSection: Draft = {
    conceptKey: "section:workflows",
    kind: "section",
    slug: "workflows",
    title: "Workflows",
    description: `${chosenWorkflows.length} key flows across modules.`,
    parent: overview,
    scopePath: null,
    unavailableReason:
      chosenWorkflows.length > 0
        ? null
        : candidates.length > 0
          ? "The page limit was reached before any workflow page could be planned."
          : "No cross-module flow was found: no entry file's resolvable imports reach two or more " +
            "modules. Import resolution covers relative JavaScript/TypeScript and Python imports.",
    sources: pick(chosenWorkflows.map((workflow) => workflow.root)),
    links: [],
  };
  drafts.push(workflowsSection);
  const workflowDrafts: Draft[] = [];
  for (const workflow of chosenWorkflows) {
    const draft: Draft = {
      conceptKey: `workflow:${workflow.root.path}`,
      kind: "workflow",
      slug: `workflows/${slugify(workflowName(workflow.root.path))}`,
      title: `${humanize(workflowName(workflow.root.path))} flow`,
      description:
        `Starts in ${workflow.root.path} and reaches ` +
        `${workflow.modules.map(lastSegment).join(", ")}.`,
      parent: workflowsSection,
      scopePath: null,
      origin: workflow.root.path,
      unavailableReason: null,
      sources: pick([
        ...workflow.closure
          .slice(0, Math.max(1, limits.maxSourcesPerPage - MAX_TESTS_PER_PAGE))
          .map((path) => byPath.get(path)!),
        ...testsFor(workflow.closure),
        ...workflow.closure.map((path) => byPath.get(path)!),
      ]),
      links: workflow.modules
        .filter((key) => moduleDrafts.has(key))
        .map((key) => ({ to: moduleDrafts.get(key)!, relation: "uses" as const })),
    };
    drafts.push(draft);
    workflowDrafts.push(draft);
  }

  // Cross links among the fixed pages, only to pages with content.
  const available = (draft: Draft) => draft.unavailableReason === null;
  for (const target of [architecture, modulesSection, workflowsSection]) {
    if (available(target)) overview.links.push({ to: target, relation: "related" });
  }
  if (available(architecture)) {
    for (const draft of [...moduleDrafts.values(), ...workflowDrafts]) {
      architecture.links.push({ to: draft, relation: "uses" });
    }
  }

  // Unavailable pages have no sources to generate from.
  for (const draft of drafts) if (!available(draft)) draft.sources = [];

  for (const draft of drafts) {
    if (!available(draft)) {
      disclosures.push({
        conceptKey: draft.conceptKey,
        code: "section_unavailable",
        message: `${draft.title}: ${draft.unavailableReason}`,
      });
    }
  }
  if (rankedModules.length > plannedModules.length) {
    disclosures.push({
      conceptKey: "section:modules",
      code: "modules_truncated",
      message:
        `${rankedModules.length - plannedModules.length} smaller modules have no page because of ` +
        `the module or page limit: ${rankedModules
          .slice(plannedModules.length)
          .map((module) => module.path)
          .slice(0, 10)
          .join(", ")}${rankedModules.length - plannedModules.length > 10 ? ", …" : ""}.`,
    });
  }
  if (distinctWorkflows > chosenWorkflows.length && chosenWorkflows.length > 0) {
    disclosures.push({
      conceptKey: "section:workflows",
      code: "workflows_truncated",
      message: `${distinctWorkflows - chosenWorkflows.length} further cross-module flows have no page because of the workflow or page limit.`,
    });
  }
  const submodulesPlanned = [...submodules.values()].reduce((n, list) => n + list.length, 0);
  if (limits.maxDepth >= 3 && submodulesFound > submodulesPlanned) {
    disclosures.push({
      conceptKey: "section:modules",
      code: "submodules_truncated",
      message: `${submodulesFound - submodulesPlanned} submodules have no page of their own because of the page limit; their parent module page covers them.`,
    });
  }

  const pages = finalize(drafts, ids);

  // ---- Coverage -----------------------------------------------------------
  const planned = new Set(pages.flatMap((page) => page.sources.map((source) => source.path)));
  const uncovered: { path: string; reason: UncoveredReason }[] = [];
  let coveredFiles = 0;
  for (const file of files) {
    const key = moduleOf(file.path);
    const inPlannedModule = key !== undefined && plannedModuleSet.has(key);
    if (inPlannedModule || planned.has(file.path)) {
      coveredFiles += 1;
      continue;
    }
    const reason: UncoveredReason =
      file.kind === "code" && key !== undefined ? "module_limit" : "not_selected";
    uncovered.push({ path: file.path, reason });
  }
  const uncoveredByReason: Partial<Record<UncoveredReason, number>> = {};
  for (const item of uncovered) {
    uncoveredByReason[item.reason] = (uncoveredByReason[item.reason] ?? 0) + 1;
  }
  const indexCoverage = coverageReport(db, buildId, { excludedLimit: 0 })!;
  const excludedByReason: Record<string, number> = {};
  for (const [reason, count] of Object.entries(indexCoverage.excludedByReason)) {
    if (count) excludedByReason[reason] = count;
  }

  return {
    repositoryId: build.repositoryId,
    sha: build.sha,
    indexKey: build.indexKey,
    indexBuildId: build.id,
    limits,
    pages,
    coverage: {
      indexedFiles: files.length,
      coveredFiles,
      uncoveredByReason,
      uncovered: uncovered.slice(0, options.uncoveredListLimit ?? 200),
      excludedFiles: Object.values(excludedByReason).reduce((total, n) => total + n, 0),
      excludedByReason,
      modules: { found: rankedModules.length, planned: plannedModules.length },
      workflows: { found: distinctWorkflows, planned: chosenWorkflows.length },
    },
    disclosures,
  };
}

// ---------------------------------------------------------------------------
// Drafts to pages

interface Draft {
  readonly conceptKey: string;
  readonly kind: WikiPageKind;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly parent: Draft | null;
  readonly scopePath: string | null;
  /** Module directory or workflow root file, shown when two titles would be equal. */
  readonly origin?: string;
  readonly unavailableReason: string | null;
  sources: readonly IndexedFile[];
  readonly links: { to: Draft; relation: PlannedLink["relation"] }[];
}

/** Assign ids and unique slugs, and order pages so parents precede children. */
function finalize(drafts: readonly Draft[], ids: IdAssigner): PlannedPage[] {
  const pageIds = ids.assign(drafts);
  const slugs = uniqueSlugs(drafts);
  const children = new Map<Draft | null, Draft[]>();
  for (const draft of drafts) {
    children.set(draft.parent, [...(children.get(draft.parent) ?? []), draft]);
  }
  const titleCounts = new Map<string, number>();
  for (const draft of drafts) titleCounts.set(draft.title, (titleCounts.get(draft.title) ?? 0) + 1);
  const titleOf = (draft: Draft) =>
    (titleCounts.get(draft.title) ?? 0) > 1 && draft.origin
      ? `${draft.title} (${draft.origin})`
      : draft.title;
  const pages: PlannedPage[] = [];
  const visit = (draft: Draft, depth: number, ordinal: number) => {
    const sources: WikiSourceRef[] = draft.sources.map((file) => ({
      path: file.path,
      blobOid: file.blobOid,
      startLine: 1,
      endLine: Math.max(1, file.lines),
      kind: file.kind,
    }));
    pages.push({
      pageId: pageIds.get(draft)!,
      conceptKey: draft.conceptKey,
      slug: slugs.get(draft)!,
      kind: draft.kind,
      title: titleOf(draft),
      description: draft.description,
      parentPageId: draft.parent ? pageIds.get(draft.parent)! : null,
      depth,
      ordinal,
      scopePath: draft.scopePath,
      state: draft.unavailableReason === null ? "queued" : "unavailable",
      unavailableReason: draft.unavailableReason,
      sources,
      links: draft.links.map((link) => ({
        toPageId: pageIds.get(link.to)!,
        relation: link.relation,
      })),
    });
    (children.get(draft) ?? []).forEach((child, index) => visit(child, depth + 1, index));
  };
  const roots = children.get(null) ?? [];
  if (roots.length !== 1) throw new Error("A wiki plan needs exactly one root page");
  visit(roots[0]!, 0, 0);
  return pages;
}

function uniqueSlugs(drafts: readonly Draft[]): Map<Draft, string> {
  const result = new Map<Draft, string>();
  const used = new Set<string>();
  // Fixed pages keep their slugs; others are deduplicated in concept order.
  const ordered = [...drafts].sort(
    (a, b) =>
      Number(a.kind === "module" || a.kind === "workflow") -
        Number(b.kind === "module" || b.kind === "workflow") || compare(a.conceptKey, b.conceptKey),
  );
  for (const draft of ordered) {
    let slug = draft.slug;
    for (let suffix = 2; used.has(slug); suffix += 1) slug = `${draft.slug}-${suffix}`;
    used.add(slug);
    result.set(draft, slug);
  }
  return result;
}

/**
 * Stable page identities. A concept keeps the id it had in the prior
 * generation. A module or workflow whose concept key is new takes over the id
 * of a prior page of the same kind that disappeared, when at least half of
 * their source blobs are identical (a rename or move). Otherwise the id is
 * derived from the concept key, so it is the same on every planning run.
 */
class IdAssigner {
  constructor(private readonly prior: readonly PriorWikiPage[]) {}

  assign(drafts: readonly Draft[]): Map<Draft, string> {
    const result = new Map<Draft, string>();
    const priorByConcept = new Map(this.prior.map((page) => [page.conceptKey, page]));
    const currentConcepts = new Set(drafts.map((draft) => draft.conceptKey));
    const taken = new Set<string>();
    for (const draft of drafts) {
      const prior = priorByConcept.get(draft.conceptKey);
      if (prior && prior.kind === draft.kind) {
        result.set(draft, prior.pageId);
        taken.add(prior.pageId);
      }
    }
    const vanished = this.prior
      .filter((page) => !currentConcepts.has(page.conceptKey) && !taken.has(page.pageId))
      .sort((a, b) => compare(a.conceptKey, b.conceptKey));
    const unmatched = drafts
      .filter((draft) => !result.has(draft))
      .sort((a, b) => compare(a.conceptKey, b.conceptKey));
    for (const draft of unmatched) {
      if (draft.kind === "module" || draft.kind === "workflow") {
        const blobs = new Set(draft.sources.map((file) => file.blobOid));
        let best: { page: PriorWikiPage; score: number } | undefined;
        for (const page of vanished) {
          if (page.kind !== draft.kind || taken.has(page.pageId)) continue;
          const score = jaccard(blobs, new Set(page.blobOids));
          if (score >= RENAME_SIMILARITY && (!best || score > best.score)) best = { page, score };
        }
        if (best) {
          result.set(draft, best.page.pageId);
          taken.add(best.page.pageId);
          continue;
        }
      }
      let id = `pg_${shortHash(draft.conceptKey)}`;
      for (let n = 2; taken.has(id); n += 1) id = `pg_${shortHash(`${draft.conceptKey}#${n}`)}`;
      result.set(draft, id);
      taken.add(id);
    }
    return result;
  }
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let shared = 0;
  for (const item of a) if (b.has(item)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// ---------------------------------------------------------------------------
// Index reads

function loadIndexedFiles(db: Database, buildId: string): IndexedFile[] {
  const rows = db
    .query<
      { path: string; language: string; blob_oid: string; line_count: number; symbols: number },
      [string]
    >(
      `SELECT f.path, f.language, f.blob_oid, c.line_count,
              (SELECT COUNT(*) FROM index_chunks ch
                WHERE ch.content_id = f.content_id AND ch.symbols != '') AS symbols
       FROM index_files f JOIN index_contents c ON c.id = f.content_id
       WHERE f.build_id = ? AND f.status = 'indexed'
       ORDER BY f.path`,
    )
    .all(buildId);
  return rows.map((row) => ({
    path: row.path,
    blobOid: row.blob_oid,
    lines: row.line_count,
    kind: evidenceKind(row.path, row.language),
    symbols: row.symbols,
  }));
}

const JS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
const JS_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']*)["']/gm;
const PY_FROM = /^\s*from\s+(\.*)([\w.]*)\s+import\b/gm;
const PY_IMPORT = /^\s*import\s+([\w.]+)/gm;

/** Resolved imports between indexed files, read from the first chunks of code and test files. */
function loadImports(
  db: Database,
  buildId: string,
  byPath: ReadonlyMap<string, IndexedFile>,
): Map<string, Set<string>> {
  const rows = db
    .query<{ path: string; text: string }, [string]>(
      `SELECT f.path, ch.text
       FROM index_files f JOIN index_chunks ch ON ch.content_id = f.content_id
       WHERE f.build_id = ? AND f.status = 'indexed' AND ch.ordinal < 2
       ORDER BY f.path, ch.ordinal`,
    )
    .all(buildId);
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    const file = byPath.get(row.path);
    if (!file || (file.kind !== "code" && file.kind !== "test")) continue;
    const targets = result.get(row.path) ?? new Set<string>();
    for (const target of resolveImports(row.path, row.text, byPath)) {
      if (target !== row.path) targets.add(target);
    }
    if (targets.size > 0) result.set(row.path, targets);
  }
  return result;
}

function resolveImports(
  path: string,
  text: string,
  byPath: ReadonlyMap<string, IndexedFile>,
): string[] {
  const dir = posix.dirname(path);
  const found: string[] = [];
  const add = (candidate: string | undefined) => {
    if (candidate !== undefined) found.push(candidate);
  };
  const extension = posix.extname(path).toLowerCase();
  if (JS_EXTENSIONS.includes(extension)) {
    for (const match of text.matchAll(JS_IMPORT)) {
      add(resolveJs(posix.normalize(posix.join(dir, match[1]!)), byPath));
    }
  } else if (extension === ".py") {
    for (const match of text.matchAll(PY_FROM)) {
      const dots = match[1]!.length;
      const dotted = match[2]!;
      if (dots > 0) {
        let base = dir;
        for (let level = 1; level < dots; level += 1) base = posix.dirname(base);
        add(resolvePython(base, dotted, byPath));
      } else {
        add(resolvePython("", dotted, byPath) ?? resolvePython("src", dotted, byPath));
      }
    }
    for (const match of text.matchAll(PY_IMPORT)) {
      add(resolvePython("", match[1]!, byPath) ?? resolvePython("src", match[1]!, byPath));
    }
  }
  return found;
}

function resolveJs(target: string, byPath: ReadonlyMap<string, IndexedFile>): string | undefined {
  if (target.startsWith("../") || target === "..") return undefined;
  const stripped = target.replace(/\.(?:m|c)?js$|\.jsx$/, "");
  const candidates = [
    target,
    ...JS_EXTENSIONS.map((ext) => `${stripped}${ext}`),
    ...JS_EXTENSIONS.map((ext) => `${target}/index${ext}`),
  ];
  return candidates.find((candidate) => byPath.has(candidate));
}

function resolvePython(
  base: string,
  dotted: string,
  byPath: ReadonlyMap<string, IndexedFile>,
): string | undefined {
  if (dotted === "") return undefined;
  const stem = posix.join(base, ...dotted.split("."));
  if (stem.startsWith("../")) return undefined;
  return [`${stem}.py`, `${stem}/__init__.py`].find((candidate) => byPath.has(candidate));
}

/** Code files reachable by imports from `root`, breadth first, bounded in depth. */
function importClosure(
  root: string,
  imports: ReadonlyMap<string, ReadonlySet<string>>,
  byPath: ReadonlyMap<string, IndexedFile>,
): string[] {
  const seen = new Set([root]);
  let frontier = [root];
  for (let depth = 0; depth < WORKFLOW_IMPORT_DEPTH && frontier.length > 0; depth += 1) {
    const next: string[] = [];
    for (const path of frontier) {
      for (const target of [...(imports.get(path) ?? [])].sort(compare)) {
        if (seen.has(target) || byPath.get(target)?.kind !== "code") continue;
        seen.add(target);
        next.push(target);
      }
    }
    frontier = next;
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// Naming

/**
 * The module a path belongs to: the first directory below a source root
 * (`src/billing`), a package (`packages/api`), or the top-level directory.
 * Files at the repository root belong to no module.
 */
export function moduleOf(path: string): string | undefined {
  const dirs = path.split("/").slice(0, -1);
  if (dirs.length === 0) return undefined;
  const first = dirs[0]!;
  if (SOURCE_ROOTS.has(first) || PACKAGE_ROOTS.has(first)) {
    return dirs.length >= 2 ? `${first}/${dirs[1]}` : first;
  }
  return first;
}

/** Entry-like files first, then files with more extracted symbols, longer files, then path. */
function rankWithin(members: readonly IndexedFile[]): IndexedFile[] {
  return [...members].sort(
    (a, b) =>
      Number(ENTRY_STEMS.has(stemOf(b.path))) - Number(ENTRY_STEMS.has(stemOf(a.path))) ||
      b.symbols - a.symbols ||
      b.lines - a.lines ||
      compare(a.path, b.path),
  );
}

function uniqueFiles(files: readonly IndexedFile[]): IndexedFile[] {
  const seen = new Set<string>();
  return files.filter((file) => !seen.has(file.path) && Boolean(seen.add(file.path)));
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function stemOf(path: string): string {
  const name = lastSegment(path);
  const dot = name.indexOf(".");
  return (dot > 0 ? name.slice(0, dot) : name).toLowerCase();
}

function lastSegment(path: string): string {
  return path.split("/").at(-1) ?? path;
}

/** The root file's stem, prefixed by its nearest directory that is not a source root. */
function workflowName(path: string): string {
  const stem = stemOf(path);
  const dirs = path
    .split("/")
    .slice(0, -1)
    .filter((dir) => !SOURCE_ROOTS.has(dir) && !PACKAGE_ROOTS.has(dir));
  return dirs.length > 0 && ENTRY_STEMS.has(stem) ? `${dirs.at(-1)!}-${stem}` : stem;
}

function moduleTitle(path: string): string {
  return SOURCE_ROOTS.has(path) || PACKAGE_ROOTS.has(path)
    ? `Top-level ${path} files`
    : humanize(lastSegment(path));
}

function humanize(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.length > 0 ? words[0]!.toUpperCase() + words.slice(1) : name;
}

/** Lowercase ASCII words joined by hyphens; never empty. */
export function slugify(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "page";
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
