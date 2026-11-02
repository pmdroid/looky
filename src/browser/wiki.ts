/**
 * What of the generated wiki a browser may see, and how a page becomes
 * context for a question.
 *
 * - Generation views keep states, counts, codes and usage. Error messages,
 *   generator configuration and budgets are dropped: they can carry provider
 *   text or host details and a reader does not need them.
 * - Page bodies are Markdown without HTML. Links are rewritten so only two
 *   kinds survive: `wiki:` links to a ready page of the same generation, and
 *   http(s) links Looky itself built for one of the page's cited ranges at
 *   the page's commit. Every other link and every image keeps only its text.
 * - A page question carries bounded hints built from planner metadata (title,
 *   kind, covered directory and source paths), never from generated prose:
 *   the page is context for retrieval, not evidence and not instructions.
 */
import type { WikiPageKind, WikiSourceRef } from "../wiki/model";
import {
  isControl,
  MAX_SEARCH_OFFSET,
  plainText,
  type WikiHeading,
  wikiHeadings,
  type WikiSearchPage,
} from "../wiki/search";
import type {
  WikiGenerationRecord,
  WikiIndex,
  WikiPageContent,
  WikiPageRecord,
  WikiStatus,
  WikiTocEntry,
} from "../wiki/store";

/** Pages listed in one index response; plans are far smaller by default. */
export const MAX_INDEX_PAGES = 500;
/** Longest page body served, in characters. Bodies are bounded at generation already. */
export const MAX_BODY_CHARS = 64 * 1024;
/** Most source paths named in a page question's hints. */
export const MAX_HINT_PATHS = 8;
/** Longest hint block appended to a page question. */
export const MAX_HINT_CHARS = 800;

export const DOCS_NOTICE =
  "Generated documentation for this exact commit. It explains the source but is not source " +
  "evidence; check cited ranges before relying on it.";

export type PageCounts = Readonly<Partial<Record<string, number>>>;

export function generationView(
  generation: WikiGenerationRecord,
  options: { readonly current?: boolean; readonly pages?: PageCounts } = {},
) {
  return {
    id: generation.id,
    repositoryId: generation.repositoryId,
    sha: generation.sha,
    state: generation.state,
    pageCount: generation.pageCount,
    ...(options.pages ? { pages: options.pages } : {}),
    ...(options.current !== undefined ? { current: options.current } : {}),
    retired: generation.retiredAt !== null,
    errorCode: generation.errorCode,
    retryable: generation.retryable,
    createdAt: generation.createdAt,
    startedAt: generation.startedAt,
    finishedAt: generation.finishedAt,
    ...(generation.usage ? { usage: generation.usage } : {}),
  };
}

export function wikiStatusView(status: WikiStatus, counts: (generationId: string) => PageCounts) {
  return {
    repositoryId: status.repositoryId,
    sha: status.sha,
    state: status.state,
    ...(status.ready ? { ready: generationView(status.ready, { current: true }) } : {}),
    ...(status.active
      ? { active: generationView(status.active, { pages: counts(status.active.id) }) }
      : {}),
    ...(status.latest ? { latest: generationView(status.latest) } : {}),
    // A wiki of another commit or configuration, disclosed as stale and never served as current.
    ...(status.stale
      ? {
          stale: {
            generation: generationView(status.stale.generation, { current: false }),
            reasons: status.stale.reasons,
          },
        }
      : {}),
  };
}

function pageMeta(page: WikiPageRecord) {
  return {
    pageId: page.pageId,
    slug: page.slug,
    title: page.title,
    kind: page.kind,
    description: page.description,
    parentPageId: page.parentPageId,
    depth: page.depth,
    ordinal: page.ordinal,
    scopePath: page.scopePath,
    state: page.state,
    unavailableReason: page.unavailableReason,
  };
}

interface TocView {
  readonly pageId: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: WikiPageKind;
  readonly state: string;
  readonly unavailableReason: string | null;
  readonly description: string;
  readonly children: readonly TocView[];
}

function tocView(entry: WikiTocEntry, keep: ReadonlySet<string>): TocView {
  return {
    pageId: entry.pageId,
    slug: entry.slug,
    title: entry.title,
    kind: entry.kind,
    state: entry.state,
    unavailableReason: entry.unavailableReason,
    description: entry.description,
    children: entry.children
      .filter((child) => keep.has(child.pageId))
      .map((child) => tocView(child, keep)),
  };
}

export function wikiIndexView(index: WikiIndex, current: boolean) {
  const pages = index.pages.slice(0, MAX_INDEX_PAGES);
  const keep = new Set(pages.map((page) => page.pageId));
  return {
    generation: generationView(index.generation, { current }),
    notice: DOCS_NOTICE,
    toc: tocView(index.toc, keep),
    pages: pages.map(pageMeta),
    truncated: index.pages.length > pages.length,
    // Only links between listed pages, so navigation has no orphan references.
    links: index.links.filter((link) => keep.has(link.fromPageId) && keep.has(link.toPageId)),
    report: index.report,
  };
}

export type SourceLinker = (source: WikiSourceRef) => string | null;

export interface PageTargets {
  /** Slug to page id and title, for ready pages of the same generation. */
  readonly ready: ReadonlyMap<string, { readonly pageId: string; readonly title: string }>;
}

/** Private-use markers around a kept link while the rest of the line is escaped. */
const KEEP_OPEN = "\uE002";
const KEEP_CLOSE = "\uE003";
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
/**
 * Text that could form a link, image, reference definition, autolink or HTML
 * if a renderer disagreed with Looky about where code starts or ends.
 */
const LINK_LIKE = /\]\s*[([:]|</;

/** Backslash-escape everything that can start a link, image, reference, autolink or HTML. */
function escapeMarkup(text: string): string {
  return text.replace(/[\\[\]<>]/g, (char) => `\\${char}`);
}

/**
 * Markdown restricted to links this page may show, by construction: kept
 * links are taken out first, then every remaining `[`, `]`, `<`, `>` and
 * backslash is escaped, so no other inline link, image, reference-style link,
 * link reference definition, autolink or raw HTML can form in any CommonMark
 * renderer. Code is left as written only when it holds nothing link-like, so
 * a renderer that disagrees about code boundaries cannot uncover a link.
 * Control characters are removed.
 */
export function safeWikiMarkdown(
  body: string,
  targets: PageTargets,
  allowedUrls: ReadonlySet<string>,
): { readonly markdown: string; readonly pageLinks: readonly string[] } {
  const linked = new Set<string>();
  const kept: string[] = [];
  const keepLinks = (text: string): string =>
    text
      // Images never load: keep their alt text only.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_, alt: string) => alt)
      .replace(/\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/g, (_, label: string, target: string) => {
        let destination: string | undefined;
        if (target.startsWith("wiki:")) {
          const slug = target.slice("wiki:".length);
          if (targets.ready.has(slug)) {
            linked.add(slug);
            destination = `wiki:${slug}`;
          }
        } else if (allowedUrls.has(target)) {
          destination = target;
        }
        if (destination === undefined) return label;
        kept.push(`[${escapeMarkup(label)}](${destination})`);
        return `${KEEP_OPEN}${kept.length - 1}${KEEP_CLOSE}`;
      });
  const prose = (text: string): string =>
    escapeMarkup(keepLinks(text)).replace(
      new RegExp(`${KEEP_OPEN}(\\d+)${KEEP_CLOSE}`, "g"),
      (_, index: string) => kept[Number(index)]!,
    );
  const code = (text: string): string => (LINK_LIKE.test(text) ? escapeMarkup(text) : text);

  let fence: string | undefined;
  const lines = body
    .slice(0, MAX_BODY_CHARS)
    .replace(/./gsu, (char) =>
      isControl(char) || char === KEEP_OPEN || char === KEEP_CLOSE ? "" : char,
    )
    .split("\n")
    .map((line) => {
      if (fence !== undefined) {
        if (line.trimStart().startsWith(fence)) fence = undefined;
        return code(line);
      }
      const opened = FENCE.exec(line);
      if (opened) {
        fence = opened[1]!;
        return code(line);
      }
      // Inline code spans stay as written unless they hold something link-like.
      return line
        .split(/(`+[^`]*?`+)/)
        .map((part, index) => (index % 2 === 1 ? code(part) : prose(part)))
        .join("");
    });
  return { markdown: lines.join("\n"), pageLinks: [...linked] };
}

export function safeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username !== "" || url.password !== "") return null;
    return url.href;
  } catch {
    return null;
  }
}

export function wikiPageView(
  content: WikiPageContent,
  generation: WikiGenerationRecord,
  options: {
    readonly current: boolean;
    readonly targets: PageTargets;
    readonly link: SourceLinker;
    readonly redirectedFrom?: string;
  },
) {
  const source = (ref: WikiSourceRef) => ({
    path: ref.path,
    startLine: ref.startLine,
    endLine: ref.endLine,
    kind: ref.kind,
    link: safeHttpUrl(options.link(ref)),
  });
  const citations = content.citations.map(source);
  const allowed = new Set(citations.flatMap((citation) => (citation.link ? [citation.link] : [])));
  const body =
    content.page.state === "ready" && content.body
      ? safeWikiMarkdown(content.body.text, options.targets, allowed)
      : undefined;
  // From the stored body, as the search index does, so search anchors and page anchors agree.
  const headings: WikiHeading[] = body && content.body ? wikiHeadings(content.body.text) : [];
  return {
    generation: generationView(generation, { current: options.current }),
    notice: DOCS_NOTICE,
    ...(options.redirectedFrom !== undefined ? { redirectedFrom: options.redirectedFrom } : {}),
    page: pageMeta(content.page),
    ...(body && content.body
      ? {
          body: {
            format: "markdown" as const,
            html: false,
            markdown: body.markdown,
            generatedAt: content.body.generatedAt,
          },
        }
      : {}),
    headings,
    pageLinks: (body?.pageLinks ?? []).map((slug) => ({
      slug,
      pageId: options.targets.ready.get(slug)!.pageId,
      title: options.targets.ready.get(slug)!.title,
    })),
    citations,
    plannedSources: content.plannedSources.map(source),
  };
}

export function wikiSearchView(
  result: WikiSearchPage,
  generation: WikiGenerationRecord,
  pages: ReadonlyMap<string, WikiPageRecord>,
  request: { readonly query: string; readonly limit: number; readonly offset: number },
  current: boolean,
) {
  const hits = result.hits.flatMap((hit) => {
    const page = pages.get(hit.pageId);
    // Only pages still listed and ready are offered, so results have no orphan links.
    if (!page || page.state !== "ready") return [];
    return [
      {
        pageId: page.pageId,
        slug: page.slug,
        title: page.title,
        kind: page.kind,
        heading: hit.heading,
        anchor: hit.anchor,
        snippet: hit.snippet,
      },
    ];
  });
  const next = request.offset + result.hits.length;
  return {
    // Generated documentation, not raw-source retrieval; ask a question for source evidence.
    kind: "docs" as const,
    notice: DOCS_NOTICE,
    generation: generationView(generation, { current }),
    query: request.query,
    offset: request.offset,
    limit: request.limit,
    total: result.total,
    totalCapped: result.totalCapped,
    hits,
    // Only offsets the endpoint accepts are offered; beyond that, refine the query.
    ...(next < result.total && result.hits.length === request.limit && next <= MAX_SEARCH_OFFSET
      ? { nextOffset: next }
      : {}),
  };
}

function hintText(value: string, max: number): string {
  return plainText(value)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/["<>`]/g, "")
    .slice(0, max)
    .trim();
}

/**
 * Bounded retrieval hints for a question about a page: planner metadata only.
 * Returns undefined when nothing useful remains.
 */
export function pageHints(content: WikiPageContent): string {
  const page = content.page;
  const paths = [
    ...new Set([...content.citations, ...content.plannedSources].map((ref) => ref.path)),
  ]
    .map((path) => hintText(path, 160))
    .filter(Boolean)
    .slice(0, MAX_HINT_PATHS);
  const parts = [
    `Context: the reader is viewing the generated wiki page titled ${JSON.stringify(
      hintText(page.title, 120),
    )} (${page.kind}${page.scopePath ? `, covering ${hintText(page.scopePath, 160)}` : ""}).`,
    "That page is generated documentation, not evidence; answer from the committed source.",
    ...(paths.length > 0 ? [`Files the page draws on: ${paths.join(", ")}.`] : []),
  ];
  let text = parts.join(" ");
  while (text.length > MAX_HINT_CHARS && paths.length > 0) {
    paths.pop();
    text = [
      parts[0],
      parts[1],
      ...(paths.length > 0 ? [`Files the page draws on: ${paths.join(", ")}.`] : []),
    ].join(" ");
  }
  return text.slice(0, MAX_HINT_CHARS);
}

/** The question with its page hints, or undefined when the question leaves no room for them. */
export function composePageQuestion(
  question: string,
  hints: string,
  maxChars: number,
): string | undefined {
  const trimmed = question.trim();
  const composed = `${trimmed}\n\n${hints}`;
  return composed.length <= maxChars ? composed : undefined;
}
