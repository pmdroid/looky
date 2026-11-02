/**
 * Pure helpers for the real-codebase pilot: the question set and its pinned
 * evidence, checks of retrieved evidence against Git, and the report. The
 * orchestration that starts the service and talks to it lives in `run.ts`.
 */
import { createHash } from "node:crypto";

export type Mode = "fast" | "deep";
export const MODES: readonly Mode[] = ["fast", "deep"];

/** A source range a correct answer has to rest on, fixed before any answer exists. */
export interface PinnedEvidence {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  /** Exact text that must occur within the range at the pinned commit. */
  readonly anchor: string;
  readonly why: string;
}

export interface PilotQuestion {
  readonly id: string;
  readonly category: string;
  readonly subsystem: string;
  readonly question: string;
  /** Reviewer key: what a correct answer says, including caveats. */
  readonly expected: string;
  readonly evidence: readonly PinnedEvidence[];
  /** True when the answer needs evidence from several files. */
  readonly deepNeeded: boolean;
}

/** The commit the pilot makes on top of the pinned revision. */
export interface PilotChange {
  readonly message: string;
  readonly rename: { readonly from: string; readonly to: string };
  /** Literal replacements, applied after the rename; `all` replaces every occurrence. */
  readonly edits: readonly {
    readonly path: string;
    readonly find: string;
    readonly replace: string;
    readonly all?: boolean;
  }[];
  /** `probe` is a word only the added file contains, used to search for it. */
  readonly add: { readonly path: string; readonly content: string; readonly probe: string };
  /** `probe` is a word the deleted file contains, used to show it is gone. */
  readonly delete: { readonly path: string; readonly probe: string };
  /** Question asked again at the new commit, with evidence pinned there. */
  readonly question: PilotQuestion;
}

export interface QuestionSet {
  readonly repositoryId: string;
  readonly source: string;
  readonly sha: string;
  readonly questions: readonly PilotQuestion[];
  readonly change: PilotChange;
}

/** Reads a tracked file at a commit, or undefined when it is not there. */
export type BlobReader = (sha: string, path: string) => string | undefined;

export function splitLines(text: string): string[] {
  return text.replace(/\r?\n$/, "").split(/\r?\n/);
}

export function parseQuestionSet(value: unknown): QuestionSet {
  const set = value as QuestionSet;
  if (!set || typeof set !== "object") throw new Error("question set must be an object");
  if (!/^[0-9a-f]{40}$/.test(set.sha ?? "")) throw new Error("question set needs a full sha");
  if (!Array.isArray(set.questions) || set.questions.length === 0) {
    throw new Error("question set needs questions");
  }
  const ids = new Set<string>();
  for (const question of [...set.questions, set.change?.question]) {
    if (!question) throw new Error("question set needs change.question");
    if (ids.has(question.id)) throw new Error(`duplicate question id ${question.id}`);
    ids.add(question.id);
    if (!question.question?.trim()) throw new Error(`${question.id} has no question`);
    if (!Array.isArray(question.evidence) || question.evidence.length === 0) {
      throw new Error(`${question.id} has no pinned evidence`);
    }
  }
  return set;
}

/**
 * Every pinned range exists at `sha` and contains its anchor. Returns one
 * problem per bad pin; an empty list means the pins hold.
 */
export function validatePins(
  read: BlobReader,
  sha: string,
  questions: readonly PilotQuestion[],
): string[] {
  const problems: string[] = [];
  for (const question of questions) {
    for (const pin of question.evidence) {
      const where = `${question.id} ${pin.path}:${pin.startLine}-${pin.endLine}`;
      const text = read(sha, pin.path);
      if (text === undefined) {
        problems.push(`${where}: not tracked at ${sha}`);
        continue;
      }
      const lines = splitLines(text);
      if (pin.startLine < 1 || pin.endLine < pin.startLine || pin.endLine > lines.length) {
        problems.push(`${where}: range outside the file's ${lines.length} lines`);
        continue;
      }
      const range = lines.slice(pin.startLine - 1, pin.endLine).join("\n");
      if (!range.includes(pin.anchor)) problems.push(`${where}: anchor not in range`);
    }
  }
  return problems;
}

export interface RetrievedEvidence {
  readonly id: string;
  readonly repositoryId: string;
  readonly sha: string;
  readonly generationId: string;
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentHash: string;
  readonly kind: string;
  readonly text?: string;
  readonly pass: number;
}

export interface Coverage {
  /** Pins whose range overlaps a retrieved range of the same file. */
  readonly rangesHit: number;
  /** Pins whose file appears among retrieved evidence. */
  readonly filesHit: number;
  readonly pins: number;
  readonly missed: readonly string[];
}

export function coverage(
  pins: readonly PinnedEvidence[],
  evidence: readonly RetrievedEvidence[],
): Coverage {
  let rangesHit = 0;
  let filesHit = 0;
  const missed: string[] = [];
  for (const pin of pins) {
    const sameFile = evidence.filter((item) => item.path === pin.path);
    if (sameFile.length > 0) filesHit += 1;
    if (sameFile.some((item) => item.startLine <= pin.endLine && item.endLine >= pin.startLine)) {
      rangesHit += 1;
    } else {
      missed.push(`${pin.path}:${pin.startLine}-${pin.endLine}`);
    }
  }
  return { rangesHit, filesHit, pins: pins.length, missed };
}

/**
 * Problems with retrieved evidence as citations: another repository,
 * revision or generation, an untracked path, a range past the end of the
 * file, or text or hash that differs from the committed lines.
 */
export function citationProblems(
  read: BlobReader,
  expected: { readonly repositoryId: string; readonly sha: string; readonly generationId: string },
  evidence: readonly RetrievedEvidence[],
): string[] {
  const problems: string[] = [];
  for (const item of evidence) {
    const where = `${item.id} ${item.path}:${item.startLine}-${item.endLine}`;
    if (item.repositoryId !== expected.repositoryId) problems.push(`${where}: other repository`);
    if (item.sha !== expected.sha) problems.push(`${where}: other revision ${item.sha}`);
    if (item.generationId !== expected.generationId) problems.push(`${where}: other generation`);
    const text = read(expected.sha, item.path);
    if (text === undefined) {
      problems.push(`${where}: not tracked at ${expected.sha}`);
      continue;
    }
    const lines = splitLines(text);
    if (item.startLine < 1 || item.endLine > lines.length || item.endLine < item.startLine) {
      problems.push(`${where}: outside the file`);
      continue;
    }
    if (item.text === undefined) continue;
    const committed = text
      .split(/(?<=\n)/)
      .slice(item.startLine - 1, item.endLine)
      .join("");
    if (item.text !== committed && item.text !== committed.replace(/\r?\n$/, "")) {
      problems.push(`${where}: text differs from the commit`);
    }
    if (createHash("sha256").update(item.text).digest("hex") !== item.contentHash) {
      problems.push(`${where}: content hash differs from its text`);
    }
  }
  return problems;
}

export interface Check {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]!
    : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}

/** A Markdown table cell: one line, pipes escaped. */
export function cell(value: unknown): string {
  return String(value ?? "")
    .replace(/\r?\n/g, " ")
    .replaceAll("|", "\\|");
}

export function table(header: readonly string[], rows: readonly (readonly unknown[])[]): string {
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ].join("\n");
}
