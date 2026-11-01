/**
 * Citation validation. A model cites evidence with `[E3]` or `[E3:14-18]`
 * markers. Each marker is checked against the inspected evidence records:
 * the id must exist and the lines must lie inside that record's range. Valid
 * markers become source links and evidence references; invalid ones are
 * removed and counted. Path-and-line references written directly in the prose
 * are checked the same way, so an unverified reference is never delivered as
 * a citation.
 */
import type { EvidenceRef } from "../contract/response";
import type { Evidence } from "../retrieval/research";

/** Build a link for a verified range, such as a code host URL pinned to the SHA. */
export type SourceLinkBuilder = (target: {
  readonly repositoryId: string;
  readonly sha: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}) => string | undefined;

export interface CitedAnswer {
  readonly text: string;
  readonly evidence: readonly EvidenceRef[];
  /** Markers or prose references that did not match inspected evidence and were removed. */
  readonly invalid: readonly string[];
  /** Ids of evidence records the answer cites. */
  readonly citedIds: ReadonlySet<string>;
}

const ONE = String.raw`E\d+(?::\d+(?:-\d+)?)?`;
const MARKER = new RegExp(String.raw`\[\s*(${ONE}(?:\s*[,;]\s*${ONE})*)\s*\]`, "g");
const PART = /^E(\d+)(?::(\d+)(?:-(\d+))?)?$/;
/** `path/to/file.ext:12` or `:12-20`, optionally in backticks. */
const PROSE_REF =
  /(?<![\w/:.@-])(`?)((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][A-Za-z0-9]*):(\d+)(?:-(\d+))?\1(?![\w/])/g;

function label(path: string, start: number, end: number): string {
  return start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
}

export function validateCitations(
  draft: string,
  evidence: readonly Evidence[],
  link?: SourceLinkBuilder,
): CitedAnswer {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  const refs = new Map<string, EvidenceRef>();
  const invalid: string[] = [];
  const citedIds = new Set<string>();

  const cite = (item: Evidence, start: number, end: number): string => {
    citedIds.add(item.id);
    const key = `${item.path}\0${start}\0${end}`;
    if (!refs.has(key)) {
      refs.set(key, {
        path: item.path,
        startLine: start,
        endLine: end,
        ...(item.symbols[0] ? { symbol: item.symbols[0] } : {}),
        note: item.reason,
      });
    }
    const text = label(item.path, start, end);
    const url = link?.({
      repositoryId: item.repositoryId,
      sha: item.sha,
      path: item.path,
      startLine: start,
      endLine: end,
    });
    return url ? `[${text}](${url})` : `\`${text}\``;
  };

  // Prose references first, so rendered links are not re-scanned.
  let text = draft.replace(
    PROSE_REF,
    (whole, _tick: string, path: string, startRaw: string, endRaw?: string) => {
      const start = Number(startRaw);
      const end = endRaw === undefined ? start : Number(endRaw);
      const item = evidence.find(
        (candidate) =>
          candidate.path === path &&
          start >= candidate.startLine &&
          end <= candidate.endLine &&
          start <= end,
      );
      if (item) return cite(item, start, end);
      // Only a path that research inspected can be claimed; unknown paths stay as text.
      invalid.push(whole.replace(/`/g, ""));
      return `\`${path}\``;
    },
  );

  text = text.replace(MARKER, (_whole, inner: string) => {
    const links: string[] = [];
    for (const raw of inner.split(/\s*[,;]\s*/)) {
      const match = PART.exec(raw.trim());
      const item = match ? byId.get(`E${match[1]}`) : undefined;
      if (!match || !item) {
        invalid.push(raw.trim());
        continue;
      }
      const start = match[2] === undefined ? item.startLine : Number(match[2]);
      const end =
        match[3] === undefined ? (match[2] === undefined ? item.endLine : start) : Number(match[3]);
      if (start < item.startLine || end > item.endLine || start > end) {
        invalid.push(raw.trim());
        continue;
      }
      links.push(cite(item, start, end));
    }
    return links.length > 0 ? `(${links.join(", ")})` : "";
  });

  // Tidy spaces left by removed markers.
  text = text.replace(/[ \t]+([.,;:!?])/g, "$1").replace(/[ \t]{2,}/g, " ");
  return { text: text.trim(), evidence: [...refs.values()], invalid, citedIds };
}

/**
 * Links from a template such as
 * `https://github.com/org/repo/blob/{sha}/{path}#L{startLine}-L{endLine}`.
 * `{repositoryId}` is also available. Path segments are URL-encoded.
 */
export function sourceLinkFromTemplate(template: string): SourceLinkBuilder {
  let parsed: URL;
  try {
    parsed = new URL(template.replace(/\{\w+\}/g, "x"));
  } catch {
    throw new Error("The source link template must be an absolute URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("The source link template must be an http or https URL");
  }
  return (target) =>
    template.replace(/\{(repositoryId|sha|path|startLine|endLine)\}/g, (_whole, key: string) => {
      switch (key) {
        case "path":
          return target.path.split("/").map(encodeURIComponent).join("/");
        case "repositoryId":
          return encodeURIComponent(target.repositoryId);
        case "sha":
          return target.sha;
        case "startLine":
          return String(target.startLine);
        default:
          return String(target.endLine);
      }
    });
}
