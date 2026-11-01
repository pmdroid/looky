import { INDEX_POLICY_VERSION, type IndexLimits } from "./policy";

/**
 * Splits a file into chunks of whole, unmodified source lines. Concatenating a
 * chunk's lines `startLine..endLine` of the original file reproduces its text
 * byte for byte, including line terminators.
 *
 * - ECMAScript (TypeScript/JavaScript): chunks break before top-level
 *   declarations, and the names of those declarations are recorded.
 * - Markdown: chunks break before headings.
 * - Everything else: faithful sliding line windows with overlap.
 *
 * Any segment over the size bounds falls back to overlapping windows, so no
 * chunk exceeds `chunkLines` lines or `chunkBytes` bytes.
 */

export interface Chunk {
  readonly ordinal: number;
  /** 1-based inclusive. */
  readonly startLine: number;
  readonly endLine: number;
  readonly text: string;
  /** Declaration names that start inside this chunk. */
  readonly symbols: readonly string[];
}

export type ChunkStrategy = "ecmascript" | "markdown" | "text";

export function chunkStrategy(language: string): ChunkStrategy {
  if (language === "typescript" || language === "javascript") return "ecmascript";
  if (language === "markdown") return "markdown";
  return "text";
}

/** Identifies how a blob was chunked, so stored chunks are only reused under the same policy. */
export function chunkerId(language: string): string {
  return `${chunkStrategy(language)}@${INDEX_POLICY_VERSION}`;
}

/** Split into lines, each keeping its own `\n` terminator (the last may lack one). */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length - 1; index += 1) lines[index] += "\n";
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

const DECLARATION =
  /^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|type|enum|const\s+enum|const|let|var|namespace|module)\s+([A-Za-z_$][\w$]*)/;
const EXPORT_DEFAULT_ANONYMOUS = /^export\s+default\s/;
const LEADING_TRIVIA = /^(?:\/\/|\/\*|\*|\s+\*|@[A-Za-z_$])/;
const HEADING = /^#{1,6}\s/;

interface Boundary {
  readonly line: number;
  readonly symbol?: string;
}

function ecmascriptBoundaries(lines: readonly string[]): Boundary[] {
  const boundaries: Boundary[] = [];
  let inBlockComment = false;
  for (const [index, line] of lines.entries()) {
    if (inBlockComment) {
      if (line.includes("*/")) inBlockComment = false;
      continue;
    }
    if (line.startsWith("/*") && !line.includes("*/")) {
      inBlockComment = true;
      continue;
    }
    const match = DECLARATION.exec(line);
    if (match) {
      boundaries.push({ line: attachTrivia(lines, index), symbol: match[1]! });
    } else if (EXPORT_DEFAULT_ANONYMOUS.test(line)) {
      boundaries.push({ line: attachTrivia(lines, index) });
    }
  }
  return boundaries;
}

/** Move a boundary up over directly preceding comments and decorators. */
function attachTrivia(lines: readonly string[], index: number): number {
  let start = index;
  while (start > 0 && LEADING_TRIVIA.test(lines[start - 1]!)) start -= 1;
  return start;
}

function markdownBoundaries(lines: readonly string[]): Boundary[] {
  const boundaries: Boundary[] = [];
  let fenced = false;
  for (const [index, line] of lines.entries()) {
    if (/^(?:```|~~~)/.test(line)) fenced = !fenced;
    else if (!fenced && HEADING.test(line)) boundaries.push({ line: index });
  }
  return boundaries;
}

interface Segment {
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
  readonly bytes: number;
}

export function chunkFile(text: string, language: string, limits: IndexLimits): Chunk[] {
  const lines = splitLines(text);
  if (lines.length === 0) return [];
  const sizes = lines.map((line) => Buffer.byteLength(line, "utf8"));
  const strategy = chunkStrategy(language);
  const boundaries =
    strategy === "ecmascript"
      ? ecmascriptBoundaries(lines)
      : strategy === "markdown"
        ? markdownBoundaries(lines)
        : [];

  // Symbols are attributed by the line their declaration keyword is on.
  const symbolLines: { line: number; name: string }[] = [];
  if (strategy === "ecmascript") {
    for (const [index, line] of lines.entries()) {
      const match = DECLARATION.exec(line);
      if (match && boundaries.some((boundary) => boundary.symbol === match[1])) {
        symbolLines.push({ line: index, name: match[1]! });
      }
    }
  }

  const ranges: [number, number][] = [];
  if (boundaries.length === 0) {
    windows(0, lines.length, sizes, limits, ranges);
  } else {
    const starts = [...new Set([0, ...boundaries.map((boundary) => boundary.line)])].sort(
      (a, b) => a - b,
    );
    const segments: Segment[] = starts.map((start, index) => {
      const end = starts[index + 1] ?? lines.length;
      let bytes = 0;
      for (let line = start; line < end; line += 1) bytes += sizes[line]!;
      return { start, end, bytes };
    });
    pack(segments, sizes, limits, ranges);
  }

  return ranges.map(([start, end], ordinal) => ({
    ordinal,
    startLine: start + 1,
    endLine: end,
    text: lines.slice(start, end).join(""),
    symbols: [
      ...new Set(
        symbolLines.filter((entry) => entry.line >= start && entry.line < end).map((s) => s.name),
      ),
    ],
  }));
}

/** Group adjacent segments up to the bounds; split any oversized segment into windows. */
function pack(
  segments: readonly Segment[],
  sizes: readonly number[],
  limits: IndexLimits,
  out: [number, number][],
): void {
  let current: { start: number; end: number; bytes: number } | undefined;
  const flush = () => {
    if (current) out.push([current.start, current.end]);
    current = undefined;
  };
  for (const segment of segments) {
    const lineCount = segment.end - segment.start;
    if (lineCount > limits.chunkLines || segment.bytes > limits.chunkBytes) {
      flush();
      windows(segment.start, segment.end, sizes, limits, out);
      continue;
    }
    if (
      current &&
      (segment.end - current.start > limits.chunkLines ||
        current.bytes + segment.bytes > limits.chunkBytes)
    ) {
      flush();
    }
    if (current) {
      current.end = segment.end;
      current.bytes += segment.bytes;
    } else {
      current = { ...segment };
    }
  }
  flush();
}

/** Sliding windows over `[start, end)` bounded by lines and bytes, with line overlap. */
function windows(
  start: number,
  end: number,
  sizes: readonly number[],
  limits: IndexLimits,
  out: [number, number][],
): void {
  let windowStart = start;
  for (;;) {
    let windowEnd = windowStart;
    let bytes = 0;
    while (
      windowEnd < end &&
      windowEnd - windowStart < limits.chunkLines &&
      bytes + sizes[windowEnd]! <= limits.chunkBytes
    ) {
      bytes += sizes[windowEnd]!;
      windowEnd += 1;
    }
    // A single line always fits because chunkBytes >= maxLineBytes; guard anyway.
    if (windowEnd === windowStart) windowEnd += 1;
    out.push([windowStart, windowEnd]);
    if (windowEnd >= end) return;
    windowStart = Math.max(windowStart + 1, windowEnd - limits.chunkOverlapLines);
  }
}

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

/**
 * Extra search terms from compound identifiers: `getUserById` and
 * `get_user_by_id` both add `get user by id`. Whole identifiers stay
 * searchable in the chunk text itself.
 */
export function identifierTerms(text: string): string {
  const terms = new Set<string>();
  for (const [identifier] of text.matchAll(IDENTIFIER)) {
    const parts = identifier
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[\s_$]+/)
      .filter((part) => part.length > 1);
    if (parts.length > 1) for (const part of parts) terms.add(part.toLowerCase());
  }
  return [...terms].join(" ");
}
