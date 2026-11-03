/**
 * What the wiki reader says about a revision's generated wiki, and which
 * controls it offers. Pure, so every state is testable without a DOM.
 *
 * Generation costs model calls, so `generate` and `retry` are only ever
 * offered as buttons the person presses. Nothing here starts work, and a
 * failed or cancelled generation is never retried by itself.
 */
import {
  ApiError,
  type IndexView,
  type WikiGenerationView,
  type WikiIndexView,
  type WikiPageKind,
  type WikiPageMeta,
  type WikiPageState,
  type WikiSourceView,
  type WikiStatusView,
} from "./api";
import { shortSha, type Tone } from "./presentation";

export type WikiControl =
  /** Plan and write a wiki for this commit. */
  | { readonly kind: "generate"; readonly label: string }
  /** Stop the generation being written. */
  | { readonly kind: "cancel"; readonly label: string; readonly generationId: string }
  /** A new attempt after a failed or cancelled generation; finished pages are reused. */
  | { readonly kind: "retry"; readonly label: string; readonly generationId: string }
  /** Select the commit an older wiki was generated for, to read it there. */
  | { readonly kind: "select"; readonly label: string; readonly sha: string };

export interface WikiStatusText {
  readonly tone: Tone;
  readonly title: string;
  readonly detail?: string;
  readonly busy: boolean;
  readonly controls: readonly WikiControl[];
}

export const KIND_LABEL: Record<WikiPageKind, string> = {
  overview: "Overview",
  architecture: "Architecture",
  section: "Section",
  module: "Module",
  workflow: "Workflow",
};

const PAGE_STATE: Record<WikiPageState, string> = {
  unavailable: "not generated",
  queued: "waiting",
  running: "being written",
  ready: "ready",
  failed: "failed",
  cancelled: "cancelled",
};

export function pageStateLabel(state: WikiPageState): string {
  return PAGE_STATE[state];
}

const FAILURE: Record<string, string> = {
  interrupted:
    "Looky stopped while the wiki was being written. A new attempt reuses the pages that finished.",
  service_stopped:
    "The Looky service stopped during generation. A new attempt reuses the pages that finished.",
  budget_exhausted:
    "Generation reached its model call, token, source read or time budget before every page was written.",
  unavailable:
    "The model provider was not available or refused the request. Check the provider configuration, then try again.",
  access_revoked: "Access to this repository ended during generation.",
  internal_error: "Looky hit an internal error while writing the wiki.",
  cancelled: "Generation was cancelled before it finished.",
};

/** A failed generation's code in words. */
export function describeFailure(code: string | null): string {
  if (!code) return "Generation did not finish.";
  return FAILURE[code] ?? `Generation did not finish (${code.replace(/_/g, " ")}).`;
}

/** Pages written so far, from the counts Looky reported for a running generation. */
export function generationProgress(generation: WikiGenerationView): {
  readonly done: number;
  readonly total: number;
  readonly text: string;
} {
  const pages = generation.pages ?? {};
  const total = generation.pageCount;
  const ready = pages.ready ?? 0;
  const settled = ready + (pages.failed ?? 0) + (pages.unavailable ?? 0) + (pages.cancelled ?? 0);
  const running = pages.running ?? 0;
  const parts = [`${ready} of ${total} pages written`];
  if (running > 0) parts.push(`${running} being written`);
  if (pages.failed) parts.push(`${pages.failed} failed`);
  return { done: Math.min(settled, total), total, text: parts.join(", ") };
}

const STALE_REASON: Record<"revision" | "index" | "configuration", string> = {
  revision: "another commit",
  index: "an older index",
  configuration: "another model or configuration",
};

/** Words for a wiki that exists but is not current for this commit. */
export function describeStale(stale: NonNullable<WikiStatusView["stale"]>): string {
  const reasons = stale.reasons.map((reason) => STALE_REASON[reason]).join(" and ");
  return (
    `An earlier wiki exists for ${reasons} (commit ${shortSha(stale.generation.sha)}). ` +
    "It is not shown here, because it may not describe this commit."
  );
}

/**
 * The wiki's state for this revision. Indexing and generation are separate
 * steps: a wiki is planned from a ready index, then its pages are written.
 */
export function describeWiki(status: WikiStatusView, index: IndexView): WikiStatusText {
  const active = status.active;
  if (active && (active.state === "queued" || active.state === "running")) {
    const progress = generationProgress(active);
    return {
      tone: "progress",
      title: status.ready
        ? "A newer wiki is being written for this commit"
        : active.state === "queued"
          ? "Wiki generation is queued"
          : "Writing the wiki for this commit",
      detail:
        active.state === "queued"
          ? "It starts when a generation slot is free. Pages appear once every page is written."
          : `${progress.text}. The wiki is published only once every page is written.`,
      busy: true,
      controls: [{ kind: "cancel", label: "Cancel generation", generationId: active.id }],
    };
  }
  if (status.ready) {
    return {
      tone: "success",
      title: "Wiki ready for this commit",
      busy: false,
      controls: [],
    };
  }
  const stale =
    status.stale && status.stale.reasons.includes("revision") ? status.stale : undefined;
  const select: WikiControl[] = stale
    ? [
        {
          kind: "select",
          label: `Read the wiki of ${shortSha(stale.generation.sha)}`,
          sha: stale.generation.sha,
        },
      ]
    : [];
  const latest = status.latest;
  if (latest && (latest.state === "failed" || latest.state === "cancelled")) {
    const retryable = latest.state === "cancelled" || latest.retryable !== false;
    return {
      tone: latest.state === "cancelled" ? "warning" : "danger",
      title:
        latest.state === "cancelled" ? "Wiki generation was cancelled" : "Wiki generation failed",
      detail:
        `${describeFailure(latest.state === "cancelled" ? "cancelled" : latest.errorCode)} ` +
        (retryable
          ? "Nothing is retried automatically; a new attempt uses model calls."
          : "This attempt cannot be retried. Ask the Looky operator."),
      busy: false,
      controls: [
        ...(retryable
          ? [{ kind: "retry" as const, label: "Try generation again", generationId: latest.id }]
          : []),
        ...select,
      ],
    };
  }
  if (index.state !== "ready") {
    return {
      tone: index.state === "failed" ? "danger" : "neutral",
      title:
        index.state === "failed"
          ? "This commit could not be indexed"
          : index.state === "building"
            ? "Indexing this commit"
            : "This commit is not indexed yet",
      detail:
        index.state === "failed"
          ? "A wiki is planned from the code index, so it cannot be generated until indexing succeeds."
          : "A wiki is planned from the code index. Generating starts indexing first, then writes pages once the index is ready.",
      busy: index.state === "building",
      controls:
        index.state === "failed"
          ? select
          : [{ kind: "generate", label: "Generate wiki" }, ...select],
    };
  }
  return {
    tone: "neutral",
    title: "No wiki for this commit yet",
    detail:
      "Looky can write a wiki from this commit's index: an overview, architecture, modules and workflows, each citing exact lines. Generation uses model calls within the configured budget.",
    busy: false,
    controls: [{ kind: "generate", label: "Generate wiki" }, ...select],
  };
}

/** A browser API failure of a wiki call in words. */
export function describeWikiError(error: unknown): string {
  if (!(error instanceof ApiError)) return "Something went wrong in this page.";
  switch (error.code) {
    case "wiki_unavailable":
      return "Wiki generation is not available on this Looky service. A model provider must be configured and reachable.";
    case "repository_not_permitted":
      return "This repository is not available to this browser client.";
    case "revision_inactive":
      return "This revision selection ended. Re-resolve the revision to continue.";
    case "wiki_not_retryable":
      return "Only a failed or cancelled generation can be tried again.";
    case "wiki_invalid_state":
      return "The wiki changed state in the meantime. Its current state is shown.";
    case "wiki_not_ready":
      return "This wiki is not published yet.";
    case "wiki_revision_mismatch":
      return "This wiki belongs to another commit.";
    default:
      return error.message;
  }
}

function count(value: number, noun: string): string {
  return `${value.toLocaleString()} ${noun}${value === 1 ? "" : "s"}`;
}

interface Coverage {
  readonly indexedFiles: number;
  readonly coveredFiles: number;
  readonly excludedFiles: number;
  readonly modules: { readonly found: number; readonly planned: number };
  readonly workflows: { readonly found: number; readonly planned: number };
}

interface Report {
  readonly coverage?: Coverage;
  readonly disclosures?: readonly { readonly message: string }[];
}

function isReport(value: unknown): value is Report {
  return typeof value === "object" && value !== null;
}

/** What the wiki covers, from the plan report Looky stored with the generation. */
export function describeCoverage(index: WikiIndexView): {
  readonly lines: readonly string[];
  readonly disclosures: readonly string[];
} {
  const report = isReport(index.report) ? index.report : {};
  const coverage = report.coverage;
  const lines: string[] = [];
  if (coverage && typeof coverage.indexedFiles === "number") {
    lines.push(
      `${count(coverage.coveredFiles, "indexed file")} of ${coverage.indexedFiles.toLocaleString()} fall within a page.`,
    );
    if (coverage.modules && coverage.workflows) {
      lines.push(
        `${coverage.modules.planned} of ${count(coverage.modules.found, "module")} and ` +
          `${coverage.workflows.planned} of ${count(coverage.workflows.found, "workflow")} have pages.`,
      );
    }
    if (coverage.excludedFiles > 0) {
      lines.push(`${count(coverage.excludedFiles, "tracked file")} were excluded from the index.`);
    }
  }
  const ready = index.pages.filter((page) => page.state === "ready").length;
  if (ready < index.pages.length) {
    lines.push(`${ready} of ${count(index.pages.length, "planned page")} have generated text.`);
  }
  if (index.truncated) lines.push("Only the first pages of this wiki are listed.");
  const disclosures = (report.disclosures ?? [])
    .map((item) => (typeof item?.message === "string" ? item.message : ""))
    .filter(Boolean);
  return { lines, disclosures };
}

/** The chain of pages from the root to `pageId`, for breadcrumbs. Stops at cycles. */
export function breadcrumbs(
  pages: readonly WikiPageMeta[],
  pageId: string,
): readonly WikiPageMeta[] {
  const byId = new Map(pages.map((page) => [page.pageId, page]));
  const chain: WikiPageMeta[] = [];
  const seen = new Set<string>();
  let current = byId.get(pageId);
  while (current && !seen.has(current.pageId)) {
    seen.add(current.pageId);
    chain.unshift(current);
    current = current.parentPageId ? byId.get(current.parentPageId) : undefined;
  }
  return chain;
}

export interface RelatedPage {
  readonly page: WikiPageMeta;
  readonly relation: "child" | "uses" | "used_by" | "related";
}

/** Ready pages related to `pageId`: its children, then pages it uses, is used by or relates to. */
export function relatedPages(index: WikiIndexView, pageId: string): readonly RelatedPage[] {
  const byId = new Map(index.pages.map((page) => [page.pageId, page]));
  const seen = new Set<string>([pageId]);
  const out: RelatedPage[] = [];
  const add = (id: string, relation: RelatedPage["relation"]) => {
    const page = byId.get(id);
    if (!page || page.state !== "ready" || seen.has(id)) return;
    seen.add(id);
    out.push({ page, relation });
  };
  index.pages
    .filter((page) => page.parentPageId === pageId)
    .sort((a, b) => a.ordinal - b.ordinal)
    .forEach((page) => add(page.pageId, "child"));
  for (const link of index.links) {
    if (link.fromPageId === pageId)
      add(link.toPageId, link.relation === "uses" ? "uses" : "related");
  }
  for (const link of index.links) {
    if (link.toPageId === pageId)
      add(link.fromPageId, link.relation === "uses" ? "used_by" : "related");
  }
  return out;
}

export const RELATION_LABEL: Record<RelatedPage["relation"], string> = {
  child: "In this section",
  uses: "Uses",
  used_by: "Used by",
  related: "Related",
};

const CITATION_LINK = /\[([^[\]\n]+)\]\(([^()\s]+)\)/g;
const CITATION_GROUPS = /(?:[ \t]*\((?:[ \t]*\[[^[\]\n]+\]\([^()\s]+\)[ \t]*,?)+[ \t]*\))+/g;

function sourceLabel(source: WikiSourceView): string {
  return source.startLine === source.endLine
    ? `${source.path}:${source.startLine}`
    : `${source.path}:${source.startLine}-${source.endLine}`;
}

export function compactCitations(markdown: string, citations: readonly WikiSourceView[]): string {
  const numbers = new Map(citations.map((source, index) => [sourceLabel(source), index + 1]));
  return markdown.replace(CITATION_GROUPS, (whole) => {
    const cited = new Map<number, string>();
    for (const [, label, href] of whole.matchAll(CITATION_LINK)) {
      const number = numbers.get(label!);
      if (number === undefined) return whole;
      cited.set(number, href!);
    }
    const links = [...cited]
      .sort(([a], [b]) => a - b)
      .map(([number, href]) => `[\\[${number}\\]](${href})`);
    return ` ${links.join("")}`;
  });
}
