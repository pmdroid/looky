export interface CitedRange {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
}

const CITATION_LINK = /\[([^[\]\n]+)\]\(([^()\s]+)\)/g;
const CITATION_GROUPS = /(?:[ \t]*\((?:[ \t]*\[[^[\]\n]+\]\([^()\s]+\)[ \t]*,?)+[ \t]*\))+/g;

function sourceLabel(source: CitedRange): string {
  return source.startLine === source.endLine
    ? `${source.path}:${source.startLine}`
    : `${source.path}:${source.startLine}-${source.endLine}`;
}

export function compactCitations(markdown: string, citations: readonly CitedRange[]): string {
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
