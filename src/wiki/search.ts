/**
 * Documentation search over generated wiki pages.
 *
 * Each published generation's ready pages are split into sections at their
 * Markdown headings and stored in the `wiki_search_fts` FTS5 table, keyed by
 * generation. A search always names one generation, which the caller has
 * already authorized, so results never cross repositories or commits. This
 * searches generated prose, not source: callers present it as documentation
 * and keep raw-source retrieval separate.
 *
 * Search text is untrusted. It never reaches SQLite as query syntax: it is
 * reduced to plain word tokens, each quoted, so FTS5 operators, column
 * filters and `NEAR` cannot be injected. Snippets come back as plain text
 * segments with a match flag, never as HTML.
 */
import type { Database } from "bun:sqlite";
import { now } from "../indexing/store";

export const MAX_SEARCH_QUERY_CHARS = 200;
export const MAX_SEARCH_TERMS = 8;
export const MAX_SEARCH_LIMIT = 25;
export const DEFAULT_SEARCH_LIMIT = 10;
/** Deepest result offset; refine the query instead of paging further. */
export const MAX_SEARCH_OFFSET = 200;
/** Matches counted for `total`; more are reported as `totalCapped`. */
const MAX_COUNTED = 1000;
const MAX_ANCHOR_CHARS = 80;

/** Private-use markers that delimit matches inside snippets; stripped from indexed text. */
const OPEN = "";
const CLOSE = "";

export interface WikiHeading {
  readonly level: number;
  readonly text: string;
  /** Unique within its page; the reader uses it as the element id. */
  readonly anchor: string;
}

export interface WikiSection {
  /** Null for the text before the first heading. */
  readonly heading: WikiHeading | null;
  readonly text: string;
}

const HEADING = /^ {0,3}(#{2,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** C0 controls other than tab, newline and carriage return, and DEL. */
export function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
}

/** Heading text as a reader sees it: link targets and emphasis markers removed. */
export function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]+/g, "")
    .replace(/./gsu, (char) => (isControl(char) || char === OPEN || char === CLOSE ? "" : char))
    .trim();
}

/** A URL fragment for a heading: lowercase ASCII words joined by hyphens. */
export function headingAnchor(text: string): string {
  const base = plainText(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ANCHOR_CHARS)
    .replace(/-+$/g, "");
  return base || "section";
}

/** Split a page body at its level 2 to 6 headings, outside fenced code. */
export function wikiSections(body: string): WikiSection[] {
  const sections: WikiSection[] = [];
  const used = new Map<string, number>();
  let heading: WikiHeading | null = null;
  let lines: string[] = [];
  let fence: string | undefined;
  const flush = () => {
    const text = lines.join("\n").trim();
    if (heading || text) sections.push({ heading, text });
  };
  for (const line of body.replace(/\r\n?/g, "\n").split("\n")) {
    const opened = FENCE.exec(line);
    if (fence) {
      if (line.trimStart().startsWith(fence)) fence = undefined;
      lines.push(line);
      continue;
    }
    if (opened) {
      fence = opened[1]!;
      lines.push(line);
      continue;
    }
    const match = HEADING.exec(line);
    if (!match) {
      lines.push(line);
      continue;
    }
    flush();
    const text = plainText(match[2]!);
    const base = headingAnchor(text);
    const count = (used.get(base) ?? 0) + 1;
    used.set(base, count);
    heading = { level: match[1]!.length, text, anchor: count === 1 ? base : `${base}-${count}` };
    lines = [];
  }
  flush();
  return sections;
}

export function wikiHeadings(body: string): WikiHeading[] {
  return wikiSections(body).flatMap((section) => (section.heading ? [section.heading] : []));
}

/** Prose for the index: link text kept, link targets, code fences markers and markers dropped. */
function searchable(markdown: string): string {
  return plainText(markdown.replace(/^ {0,3}(`{3,}|~{3,}).*$/gm, ""));
}

/**
 * Make a published generation searchable. Idempotent: a generation that was
 * already indexed is left alone. Runs inside the caller's transaction when
 * there is one, so publication and its search rows commit together.
 */
export function indexWikiSearch(db: Database, generationId: string): number {
  const done = db
    .query<{ sections: number }, [string]>(
      "SELECT sections FROM wiki_search_generations WHERE generation_id = ?",
    )
    .get(generationId);
  if (done) return done.sections;
  const pages = db
    .query<{ page_id: string; title: string; description: string; body: string }, [string]>(
      `SELECT p.page_id, p.title, p.description, b.body
       FROM wiki_pages p JOIN wiki_page_bodies b
         ON b.generation_id = p.generation_id AND b.page_id = p.page_id
       WHERE p.generation_id = ? AND p.state = 'ready'
       ORDER BY p.depth, p.ordinal`,
    )
    .all(generationId);
  const insert = db.query(
    `INSERT INTO wiki_search_fts (generation_id, page_id, anchor, title, heading, body)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  for (const page of pages) {
    const title = plainText(page.title);
    for (const [index, section] of wikiSections(page.body).entries()) {
      const intro = index === 0 && !section.heading ? `${plainText(page.description)}\n` : "";
      insert.run(
        generationId,
        page.page_id,
        section.heading?.anchor ?? null,
        title,
        section.heading?.text ?? "",
        `${intro}${searchable(section.text)}`,
      );
      count += 1;
    }
  }
  db.query(
    "INSERT INTO wiki_search_generations (generation_id, sections, indexed_at) VALUES (?, ?, ?)",
  ).run(generationId, count, now());
  return count;
}

export type SearchQuery =
  | { readonly ok: true; readonly expression: string; readonly terms: readonly string[] }
  | { readonly ok: false; readonly code: "query_empty" | "query_too_long" };

/** Untrusted search text as a safe FTS5 expression: quoted word tokens, the last one a prefix. */
export function parseSearchQuery(raw: string): SearchQuery {
  if (raw.length > MAX_SEARCH_QUERY_CHARS) return { ok: false, code: "query_too_long" };
  const terms = [
    ...new Set(
      (raw.normalize("NFKC").match(/[\p{L}\p{N}_]+/gu) ?? []).map((term) =>
        term.toLowerCase().slice(0, 64),
      ),
    ),
  ].slice(0, MAX_SEARCH_TERMS);
  if (terms.length === 0) return { ok: false, code: "query_empty" };
  const quoted = terms.map((term) => `"${term}"`);
  quoted[quoted.length - 1] = `${quoted.at(-1)}*`;
  return { ok: true, expression: quoted.join(" "), terms };
}

export interface SnippetSegment {
  readonly text: string;
  readonly match: boolean;
}

export interface WikiSearchHit {
  readonly pageId: string;
  /** Null when the match is in the text before the page's first heading. */
  readonly anchor: string | null;
  readonly heading: string | null;
  readonly snippet: readonly SnippetSegment[];
}

export interface WikiSearchPage {
  readonly hits: readonly WikiSearchHit[];
  readonly total: number;
  readonly totalCapped: boolean;
}

/** Ranked sections of one generation matching an already parsed query. */
export function searchWiki(
  db: Database,
  request: {
    readonly generationId: string;
    readonly expression: string;
    readonly limit: number;
    readonly offset: number;
  },
): WikiSearchPage {
  indexWikiSearch(db, request.generationId);
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, request.limit));
  const offset = Math.max(0, Math.min(MAX_SEARCH_OFFSET, request.offset));
  const rows = db
    .query<
      { page_id: string; anchor: string | null; heading: string; snippet: string },
      [string, string, number, number]
    >(
      `SELECT page_id, anchor, heading,
              snippet(wiki_search_fts, -1, '${OPEN}', '${CLOSE}', '…', 24) AS snippet
       FROM wiki_search_fts
       WHERE wiki_search_fts MATCH ?1 AND generation_id = ?2
       ORDER BY bm25(wiki_search_fts, 0, 0, 0, 8.0, 4.0, 1.0), rowid
       LIMIT ?3 OFFSET ?4`,
    )
    .all(request.expression, request.generationId, limit, offset);
  const counted = db
    .query<{ n: number }, [string, string, number]>(
      `SELECT count(*) AS n FROM (
         SELECT 1 FROM wiki_search_fts
         WHERE wiki_search_fts MATCH ?1 AND generation_id = ?2 LIMIT ?3)`,
    )
    .get(request.expression, request.generationId, MAX_COUNTED + 1)!.n;
  return {
    hits: rows.map((row) => ({
      pageId: row.page_id,
      anchor: row.anchor,
      heading: row.anchor === null ? null : row.heading,
      snippet: segments(row.snippet),
    })),
    total: Math.min(counted, MAX_COUNTED),
    totalCapped: counted > MAX_COUNTED,
  };
}

function segments(snippet: string): SnippetSegment[] {
  const result: SnippetSegment[] = [];
  for (const [index, part] of snippet.split(OPEN).entries()) {
    if (index === 0) {
      if (part) result.push({ text: part, match: false });
      continue;
    }
    const close = part.indexOf(CLOSE);
    const matched = close === -1 ? part : part.slice(0, close);
    const rest = close === -1 ? "" : part.slice(close + CLOSE.length);
    if (matched) result.push({ text: matched, match: true });
    if (rest) result.push({ text: rest, match: false });
  }
  return result;
}
