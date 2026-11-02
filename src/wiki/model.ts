/**
 * The generated wiki's document model: states, valid transitions, limits and
 * the generator fingerprint. Storage lives in `./store`, planning in
 * `./planner`. The wiki reads Looky's existing source index; it is not a
 * second code index.
 *
 * A wiki generation is one immutable page set for exactly one repository,
 * commit, index key and generator fingerprint. Its pages are planned up front
 * (navigation), then filled with bodies, and the generation publishes
 * atomically once every page is ready or explicitly unavailable.
 */
import type { EvidenceKind } from "../contract/ports";

/** Bump when planning changes which pages, slugs or sources a plan contains. */
export const WIKI_PLANNER_VERSION = 1;

export const WIKI_GENERATION_STATES = [
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
] as const;
export type WikiGenerationState = (typeof WIKI_GENERATION_STATES)[number];

/**
 * - `unavailable`: planned section with no supporting evidence. It carries a
 *   reason and never gets a body; it is disclosed rather than invented.
 * - `queued` → `running` → `ready` | `failed` | `cancelled` while generating.
 * - `failed` and `cancelled` pages can be queued again while their generation
 *   is still queued or running.
 */
export const WIKI_PAGE_STATES = [
  "unavailable",
  "queued",
  "running",
  "ready",
  "failed",
  "cancelled",
] as const;
export type WikiPageState = (typeof WIKI_PAGE_STATES)[number];

export const WIKI_PAGE_KINDS = [
  "overview",
  "architecture",
  "section",
  "module",
  "workflow",
] as const;
export type WikiPageKind = (typeof WIKI_PAGE_KINDS)[number];

export type WikiLinkRelation = "uses" | "related";

const GENERATION_TRANSITIONS: Readonly<
  Record<WikiGenerationState, readonly WikiGenerationState[]>
> = {
  queued: ["running", "failed", "cancelled"],
  running: ["ready", "failed", "cancelled"],
  ready: [],
  failed: [],
  cancelled: [],
};

const PAGE_TRANSITIONS: Readonly<Record<WikiPageState, readonly WikiPageState[]>> = {
  unavailable: [],
  queued: ["running", "failed", "cancelled"],
  running: ["ready", "failed", "cancelled"],
  ready: [],
  failed: ["queued"],
  cancelled: ["queued"],
};

export function canTransitionGeneration(from: WikiGenerationState, to: WikiGenerationState) {
  return GENERATION_TRANSITIONS[from].includes(to);
}

export function canTransitionPage(from: WikiPageState, to: WikiPageState): boolean {
  return PAGE_TRANSITIONS[from].includes(to);
}

/** States a page may be in when its generation publishes. */
export const PUBLISHABLE_PAGE_STATES: readonly WikiPageState[] = ["ready", "unavailable"];

// ---------------------------------------------------------------------------
// Limits

export interface WikiPlanLimits {
  /** Most pages in one generation, including the fixed overview and section pages. */
  readonly maxPages: number;
  /**
   * Deepest page level. The overview is depth 0, the architecture, modules
   * and workflows sections depth 1, module and workflow pages depth 2, and
   * submodule pages depth 3. At least 2.
   */
  readonly maxDepth: number;
  /** Most module pages. Larger modules are chosen first. */
  readonly maxModules: number;
  /** Most workflow pages. Flows reaching more modules are chosen first. */
  readonly maxWorkflows: number;
  /** Most planned source files per page. */
  readonly maxSourcesPerPage: number;
}

export const DEFAULT_WIKI_PLAN_LIMITS: WikiPlanLimits = {
  maxPages: 40,
  maxDepth: 3,
  maxModules: 16,
  maxWorkflows: 8,
  maxSourcesPerPage: 12,
};

/** Overview, architecture, modules section and workflows section. */
export const FIXED_WIKI_PAGES = 4;

export function validateWikiPlanLimits(limits: WikiPlanLimits): void {
  const minimum: Record<keyof WikiPlanLimits, number> = {
    maxPages: FIXED_WIKI_PAGES,
    maxDepth: 2,
    maxModules: 0,
    maxWorkflows: 0,
    maxSourcesPerPage: 1,
  };
  for (const [name, least] of Object.entries(minimum) as [keyof WikiPlanLimits, number][]) {
    const value = limits[name];
    if (!Number.isSafeInteger(value) || value < least) {
      throw new Error(`Wiki limit ${name} must be an integer of at least ${least}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Generator fingerprint

/**
 * Everything that changes generated output: planner limits plus the
 * generator's own settings, such as provider, model and prompt version.
 * Never put credentials here; it is stored and shown.
 */
export interface WikiGeneratorConfig {
  readonly limits: WikiPlanLimits;
  readonly generator: Readonly<Record<string, string | number | boolean>>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function shortHash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Generator/configuration fingerprint. A wiki generation is only current for
 * the exact key it was made with; any other key makes it stale.
 */
export function wikiGeneratorKey(config: WikiGeneratorConfig): string {
  return `w${WIKI_PLANNER_VERSION}-${shortHash(JSON.stringify(canonical(config)))}`;
}

// ---------------------------------------------------------------------------
// Usage

/**
 * What a page or generation spent. Token counts are the providers' reported
 * numbers where they reported them; `estimatedCalls` and `unknownCalls` say
 * how many calls were counted by Looky's estimate instead, so totals are
 * never presented as more exact than they are.
 */
export interface WikiUsage {
  readonly modelCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Calls whose provider reported both token counts. */
  readonly reportedCalls: number;
  /** Calls whose provider omitted usage; Looky charged a conservative estimate. */
  readonly estimatedCalls: number;
  /** Calls whose provider did not say whether its counts were reported. */
  readonly unknownCalls: number;
  readonly retrievalPasses: number;
  readonly sourceReads: number;
  readonly sourceBytes: number;
  readonly elapsedMs: number;
  /** Pages written by a model in this generation. */
  readonly pagesWritten: number;
  /** Pages taken from a validated earlier draft without a model call. */
  readonly pagesReused: number;
  readonly pagesFailed: number;
}

export const EMPTY_WIKI_USAGE: WikiUsage = {
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  reportedCalls: 0,
  estimatedCalls: 0,
  unknownCalls: 0,
  retrievalPasses: 0,
  sourceReads: 0,
  sourceBytes: 0,
  elapsedMs: 0,
  pagesWritten: 0,
  pagesReused: 0,
  pagesFailed: 0,
};

export function addWikiUsage(a: WikiUsage, b: Partial<WikiUsage>): WikiUsage {
  const result: Record<keyof WikiUsage, number> = { ...a };
  for (const key of Object.keys(EMPTY_WIKI_USAGE) as (keyof WikiUsage)[]) {
    result[key] += b[key] ?? 0;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Plans

export interface WikiSourceRef {
  readonly path: string;
  readonly blobOid: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: EvidenceKind;
}

export interface PlannedLink {
  readonly toPageId: string;
  readonly relation: WikiLinkRelation;
}

export interface PlannedPage {
  /** Stable identity of the concept, kept across regenerations. */
  readonly pageId: string;
  /** What the page is about, such as `module:src/billing`. Unique within a generation. */
  readonly conceptKey: string;
  readonly slug: string;
  readonly kind: WikiPageKind;
  readonly title: string;
  /** One factual navigation line derived from the index, not generated prose. */
  readonly description: string;
  readonly parentPageId: string | null;
  readonly depth: number;
  /** Position among siblings. */
  readonly ordinal: number;
  /** Directory the page covers, for module pages. */
  readonly scopePath: string | null;
  readonly state: "queued" | "unavailable";
  readonly unavailableReason: string | null;
  /** Indexed files the page is planned from, whole-file line ranges at the pinned commit. */
  readonly sources: readonly WikiSourceRef[];
  readonly links: readonly PlannedLink[];
}

export type UncoveredReason = "module_limit" | "not_selected";

export interface WikiDisclosure {
  /** The page or section concerned, when there is one. */
  readonly conceptKey: string | null;
  readonly code:
    | "section_unavailable"
    | "modules_truncated"
    | "workflows_truncated"
    | "submodules_truncated";
  readonly message: string;
}

export interface WikiPlanCoverage {
  readonly indexedFiles: number;
  /** Indexed files inside a planned module's directory or planned as a page source. */
  readonly coveredFiles: number;
  readonly uncoveredByReason: Readonly<Partial<Record<UncoveredReason, number>>>;
  /** Uncovered files in path order, at most `uncoveredListLimit`. */
  readonly uncovered: readonly { readonly path: string; readonly reason: UncoveredReason }[];
  /** Tracked files the index excluded, which no page can use. */
  readonly excludedFiles: number;
  readonly excludedByReason: Readonly<Record<string, number>>;
  readonly modules: { readonly found: number; readonly planned: number };
  readonly workflows: { readonly found: number; readonly planned: number };
}

/** Coverage and disclosures, persisted with a generation. */
export interface WikiPlanReport {
  readonly coverage: WikiPlanCoverage;
  readonly disclosures: readonly WikiDisclosure[];
}

export interface WikiPlan extends WikiPlanReport {
  readonly repositoryId: string;
  readonly sha: string;
  readonly indexKey: string;
  readonly indexBuildId: string;
  readonly limits: WikiPlanLimits;
  /** Pages in hierarchy order: every parent precedes its children. */
  readonly pages: readonly PlannedPage[];
}
