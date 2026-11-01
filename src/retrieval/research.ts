/**
 * Mode-specific evidence research on a guarded {@link ResearchSession}.
 *
 * Fast runs one ranked retrieval pass for the question, reads the best hits
 * and follows at most one companion lead (a missing definition or tests).
 * Deep iterates: it follows definitions of identifiers the evidence uses,
 * call sites, tests, configuration and docs, refines the query with symbols
 * it found, and checks whether identifiers that docs mention exist in code.
 *
 * Both modes use only the session's tools, so every pass and read is pinned to
 * one repository, SHA and index generation, re-authorized and charged against
 * the mode budget. Research has its own, smaller pass/read/byte/time limits so
 * synthesis keeps the rest. Every read is checked byte for byte against the
 * indexed chunk; only verified reads become evidence. Fast never escalates to
 * Deep; it reports leads it did not follow instead.
 */
import { BudgetExhaustedError } from "../ask/session";
import type { BudgetField } from "../contract/budgets";
import type { Mode } from "../contract/input";
import type {
  EvidenceKind,
  ResearchSession,
  RetrievalHit,
  RetrievalOptions,
  SourceText,
} from "../contract/ports";
import type { EvidenceRef } from "../contract/response";
import { splitLines } from "../indexing/chunker";
import { SourceRangeError } from "../source/git-source-reader";
import {
  definedKeys,
  documentedIdentifiers,
  escapeRegExp,
  referencedIdentifiers,
} from "./definitions";
import { evidenceKind } from "./kinds";
import { analyzeQuery, identifierKey, identifierParts, stem, type QueryAnalysis } from "./query";

// ---------------------------------------------------------------------------
// Limits

/** Research limits for one mode. Every field is a positive integer. */
export interface ResearchLimits {
  /** Retrieval passes (searches). */
  readonly maxPasses: number;
  /** Exact source reads. */
  readonly maxReads: number;
  /** Total bytes of source read. */
  readonly maxReadBytes: number;
  /** Lines in one read. */
  readonly maxReadLines: number;
  /** Hits requested per pass. */
  readonly maxHitsPerPass: number;
  /** Wall-clock time for research, leaving the rest of the request for synthesis. */
  readonly maxElapsedMs: number;
}

export type ResearchLimitField = keyof ResearchLimits;
export type ResearchLimitsByMode = Readonly<Record<Mode, ResearchLimits>>;

export const RESEARCH_LIMIT_FIELDS: readonly ResearchLimitField[] = [
  "maxPasses",
  "maxReads",
  "maxReadBytes",
  "maxReadLines",
  "maxHitsPerPass",
  "maxElapsedMs",
];

/** Documented defaults. They sit inside the mode budgets so synthesis keeps an allowance. */
export const DEFAULT_RESEARCH_LIMITS: ResearchLimitsByMode = {
  fast: {
    maxPasses: 2,
    maxReads: 6,
    maxReadBytes: 48 * 1024,
    maxReadLines: 120,
    maxHitsPerPass: 8,
    maxElapsedMs: 10_000,
  },
  deep: {
    maxPasses: 8,
    maxReads: 36,
    maxReadBytes: 384 * 1024,
    maxReadLines: 160,
    maxHitsPerPass: 16,
    maxElapsedMs: 90_000,
  },
};

/** Every limit is a positive integer, Deep is never smaller, and Deep has more passes. */
export function validateResearchLimits(limits: ResearchLimitsByMode): void {
  for (const mode of ["fast", "deep"] as const) {
    for (const field of RESEARCH_LIMIT_FIELDS) {
      const value = limits[mode][field];
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(
          `research ${mode}.${field} must be a positive integer, got ${String(value)}`,
        );
      }
    }
  }
  for (const field of RESEARCH_LIMIT_FIELDS) {
    if (limits.deep[field] < limits.fast[field]) {
      throw new Error(`research deep.${field} must not be smaller than fast.${field}`);
    }
  }
  if (limits.deep.maxPasses <= limits.fast.maxPasses) {
    throw new Error("research deep.maxPasses must exceed fast.maxPasses");
  }
}

// ---------------------------------------------------------------------------
// Results

/** One verified, inspected source range at the pinned revision. */
export interface Evidence {
  /** Stable within one bundle: E1, E2, … */
  readonly id: string;
  readonly repositoryId: string;
  readonly sha: string;
  readonly generationId: string;
  readonly path: string;
  /** 1-based inclusive range actually read. */
  readonly startLine: number;
  readonly endLine: number;
  /** SHA-256 of `text`, the exact inspected bytes. */
  readonly contentHash: string;
  readonly blobOid?: string;
  readonly kind: EvidenceKind;
  readonly symbols: readonly string[];
  /** Exact committed source text of the range. */
  readonly text: string;
  /** Why this range was inspected, such as `definition of normalizeUserId`. */
  readonly reason: string;
  /** Retrieval pass that found it. */
  readonly pass: number;
  readonly score: number;
}

/** Docs and code that disagree. Both sides stay in the evidence. */
export interface EvidenceConflict {
  /** Evidence id of the docs range making the claim. */
  readonly docsEvidenceId: string;
  readonly identifier: string;
  readonly finding: "not_defined_in_code";
  readonly message: string;
}

export type ResearchPurpose =
  | "question"
  | "definition"
  | "references"
  | "tests"
  | "config_docs"
  | "docs_check"
  | "refine";

export type ResearchStep =
  | {
      readonly type: "retrieve";
      readonly pass: number;
      readonly purpose: ResearchPurpose;
      readonly query: string;
      readonly options?: RetrievalOptions;
      readonly hits: number;
      readonly elapsedMs: number;
    }
  | {
      readonly type: "read";
      readonly pass: number;
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly bytes: number;
      readonly outcome: "evidence" | "covered" | "missing" | "mismatch";
      readonly evidenceId?: string;
    }
  | {
      readonly type: "not_followed";
      readonly purpose: ResearchPurpose;
      readonly query: string;
      readonly reason: string;
    };

export type ResearchStop =
  | { readonly reason: "complete" }
  | { readonly reason: "limit"; readonly limit: ResearchLimitField | BudgetField }
  | { readonly reason: "time" };

export interface ResearchUsage {
  readonly passes: number;
  readonly reads: number;
  readonly bytes: number;
  readonly elapsedMs: number;
}

export interface EvidenceBundle {
  readonly mode: Mode;
  readonly question: string;
  readonly repositoryId: string;
  readonly sha: string;
  readonly generationId: string;
  readonly evidence: readonly Evidence[];
  /** Truthful statements of context that research looked for and did not establish. */
  readonly gaps: readonly string[];
  readonly conflicts: readonly EvidenceConflict[];
  readonly trace: readonly ResearchStep[];
  readonly usage: ResearchUsage;
  /** Limits in force: configured research limits clamped to the session's remaining budget. */
  readonly limits: ResearchLimits;
  readonly stop: ResearchStop;
  /** Fast only: leads remained that Deep could follow. Never acted on automatically. */
  readonly suggestDeep: boolean;
}

/** Evidence as citations for an answer. Each lies within a range the session read. */
export function evidenceRefs(evidence: readonly Evidence[]): EvidenceRef[] {
  return evidence.map((item) => ({
    path: item.path,
    startLine: item.startLine,
    endLine: item.endLine,
    ...(item.symbols[0] ? { symbol: item.symbols[0] } : {}),
    note: item.reason,
  }));
}

// ---------------------------------------------------------------------------
// Research

export interface ResearchOptions {
  readonly limits?: ResearchLimitsByMode;
  readonly now?: () => number;
}

interface Lead {
  readonly purpose: ResearchPurpose;
  readonly query: string;
  readonly options?: RetrievalOptions;
  readonly reason: string;
  /** Lower runs first. */
  readonly priority: number;
  /** Reads to spend on this lead's hits. */
  readonly reads: number;
  /** Follow-up depth from the question. */
  readonly depth: number;
  /** The question itself names this identifier, so a miss is a gap worth reporting. */
  readonly fromQuestion?: boolean;
  /** For docs checks: the docs evidence making the claim. */
  readonly docsEvidenceId?: string;
}

/**
 * Lead order, lowest first; follow-ups add their depth. Deep checks call
 * sites, tests and configuration before chasing unrelated definitions.
 */
const PRIORITY = {
  questionDefinition: 1,
  relevantDefinition: 2,
  refine: 3,
  references: 3.5,
  tests: 4,
  configDocs: 4.5,
  otherDefinition: 5,
  docsCheck: 5.5,
} as const;

class StopResearch extends Error {
  constructor(readonly stop: ResearchStop) {
    super(stop.reason);
  }
}

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/** Collect verified evidence for the session's question within the mode's research limits. */
export async function researchEvidence(
  session: ResearchSession,
  options: ResearchOptions = {},
): Promise<EvidenceBundle> {
  const research = new Research(session, options);
  return research.run();
}

class Research {
  private readonly now: () => number;
  private readonly startedAt: number;
  private readonly limits: ResearchLimits;
  private readonly evidence: Evidence[] = [];
  private readonly trace: ResearchStep[] = [];
  private readonly gaps: string[] = [];
  private readonly conflicts: EvidenceConflict[] = [];
  private readonly leads: Lead[] = [];
  private readonly leadKeys = new Set<string>();
  private readonly analysis: QueryAnalysis;
  private passes = 0;
  private reads = 0;
  private bytes = 0;

  constructor(
    private readonly session: ResearchSession,
    options: ResearchOptions,
  ) {
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.analysis = analyzeQuery(session.question);
    const configured = (options.limits ?? DEFAULT_RESEARCH_LIMITS)[session.mode];
    const remaining = session.remaining();
    this.limits = {
      maxPasses: Math.min(configured.maxPasses, remaining.maxRetrievalPasses),
      maxReads: Math.min(configured.maxReads, remaining.maxSourceReads),
      maxReadBytes: Math.min(configured.maxReadBytes, remaining.maxSourceBytes),
      maxReadLines: configured.maxReadLines,
      maxHitsPerPass: Math.min(configured.maxHitsPerPass, remaining.maxResultsPerPass),
      maxElapsedMs: Math.min(configured.maxElapsedMs, remaining.maxElapsedMs),
    };
  }

  async run(): Promise<EvidenceBundle> {
    let stop: ResearchStop = { reason: "complete" };
    try {
      await (this.session.mode === "fast" ? this.fast() : this.deep());
    } catch (error) {
      if (error instanceof StopResearch) stop = error.stop;
      else if (error instanceof BudgetExhaustedError)
        stop = { reason: "limit", limit: error.limit };
      else throw error;
    }
    for (const lead of this.leads.splice(0)) {
      this.trace.push({
        type: "not_followed",
        purpose: lead.purpose,
        query: lead.query,
        reason: stop.reason === "complete" ? `${this.session.mode} research plan` : stop.reason,
      });
    }
    this.finalGaps(stop);
    const notFollowed = this.trace.some((step) => step.type === "not_followed");
    return {
      mode: this.session.mode,
      question: this.session.question,
      repositoryId: this.session.repositoryId,
      sha: this.session.generation.sha,
      generationId: this.session.generation.generationId,
      evidence: [...this.evidence],
      gaps: [...this.gaps],
      conflicts: [...this.conflicts],
      trace: [...this.trace],
      usage: {
        passes: this.passes,
        reads: this.reads,
        bytes: this.bytes,
        elapsedMs: Math.max(0, this.now() - this.startedAt),
      },
      limits: this.limits,
      stop,
      suggestDeep:
        this.session.mode === "fast" &&
        (notFollowed || this.evidence.length === 0 || stop.reason !== "complete"),
    };
  }

  // -------------------------------------------------------------------------
  // Mode plans

  /** One question pass, then at most one companion lead. */
  private async fast(): Promise<void> {
    const hits = await this.retrieve({
      purpose: "question",
      query: this.session.question,
      reason: "matches the question",
      priority: 0,
      reads: this.limits.maxReads,
      depth: 0,
    });
    // Keep reads for the companion lead when a second pass is allowed.
    const reserve = this.limits.maxPasses > 1 ? Math.min(2, this.limits.maxReads - 1) : 0;
    await this.inspect(hits, this.limits.maxReads - reserve, "matches the question", 1);
    this.planLeads(0);
    this.docsNotes();
    const lead = this.leads.shift();
    if (lead) await this.follow(lead);
  }

  /** Iterative refinement and cross-file investigation until leads or limits run out. */
  private async deep(): Promise<void> {
    const hits = await this.retrieve({
      purpose: "question",
      query: this.session.question,
      reason: "matches the question",
      priority: 0,
      reads: 6,
      depth: 0,
    });
    await this.inspect(hits, Math.min(6, this.limits.maxReads), "matches the question", 1);
    this.planLeads(0);
    this.planQuestionLeads();
    for (;;) {
      const lead = this.leads.shift();
      if (!lead) break;
      const before = this.evidence.length;
      await this.follow(lead);
      if (lead.depth < 2) this.planLeads(lead.depth + 1, before);
    }
  }

  private async follow(lead: Lead): Promise<void> {
    const hits = await this.retrieve(lead);
    if (lead.purpose === "docs_check") {
      if (hits.length === 0 && lead.docsEvidenceId) {
        const docs = this.evidence.find((item) => item.id === lead.docsEvidenceId)!;
        this.conflicts.push({
          docsEvidenceId: docs.id,
          identifier: lead.query,
          finding: "not_defined_in_code",
          message:
            `${docs.path}:${docs.startLine}-${docs.endLine} mentions \`${lead.query}\`, but no ` +
            "indexed code at this revision defines it. The docs may be stale.",
        });
        return;
      }
    } else if (lead.purpose === "definition" && hits.length === 0 && lead.fromQuestion) {
      this.gaps.push(`No definition of \`${lead.query}\` was found in the index at this revision.`);
      return;
    }
    await this.inspect(hits, lead.reads, lead.reason, this.passes);
  }

  // -------------------------------------------------------------------------
  // Leads

  private enqueue(lead: Lead): void {
    const key = `${lead.purpose}\0${lead.query}\0${JSON.stringify(lead.options ?? {})}`;
    if (this.leadKeys.has(key)) return;
    this.leadKeys.add(key);
    const index = this.leads.findIndex((other) => other.priority > lead.priority);
    if (index === -1) this.leads.push(lead);
    else this.leads.splice(index, 0, lead);
  }

  /** How many question concepts an identifier's parts mention. */
  private relevance(name: string): number {
    const parts = identifierParts(name).map(stem);
    return this.analysis.concepts.filter((concept) =>
      concept.forms.some((form) =>
        parts.some((part) => part.startsWith(form) || form.startsWith(part)),
      ),
    ).length;
  }

  /** Most question concepts on one line of `text` that uses `name`. */
  private contextRelevance(name: string, text: string): number {
    const pattern = new RegExp(`(?:^|[^\\w$])${escapeRegExp(name)}(?![\\w$])`);
    let best = 0;
    for (const line of text.split("\n")) {
      if (!pattern.test(line)) continue;
      const lower = line.toLowerCase();
      const count = this.analysis.concepts.filter((concept) =>
        concept.forms.some((form) => lower.includes(form)),
      ).length;
      best = Math.max(best, count);
    }
    return best;
  }

  /** Keys of identifiers some evidence defines, by recorded symbol or definition heuristic. */
  private definedByEvidence(): Set<string> {
    const keys = new Set<string>();
    for (const item of this.evidence) {
      for (const symbol of item.symbols) keys.add(identifierKey(symbol));
      for (const key of definedKeys(item.text, item.kind)) keys.add(key);
    }
    return keys;
  }

  /** Leads from the question itself and from evidence gathered since `from`. */
  private planLeads(depth: number, from = 0): void {
    const defined = this.definedByEvidence();
    const isFast = this.session.mode === "fast";

    // Identifiers the question names but no evidence defines yet.
    for (const identifier of this.analysis.identifiers) {
      if (!identifier.explicit || defined.has(identifier.key)) continue;
      this.enqueue({
        purpose: "definition",
        query: identifier.raw,
        options: { definitionOf: identifier.raw },
        reason: `definition of ${identifier.raw}, named in the question`,
        priority: PRIORITY.questionDefinition,
        fromQuestion: true,
        reads: 2,
        depth,
      });
    }

    const fresh = this.evidence.slice(from);
    const code = fresh.filter((item) => item.kind === "code");
    // Definitions of what the best code evidence imports from the repository or calls.
    // Names related to the question come first; unrelated names only in Deep, last.
    const candidates = new Map<string, { name: string; path: string; relevance: number }>();
    for (const item of code.slice(0, isFast ? 1 : 3)) {
      for (const reference of referencedIdentifiers(item.text)) {
        const key = identifierKey(reference.name);
        if (defined.has(key) || candidates.has(key)) continue;
        const own = this.relevance(reference.name);
        const relevance = own + this.contextRelevance(reference.name, item.text);
        // Method names are usually library calls; follow them only when they name a question concept.
        if (reference.source === "member_call" && own === 0) continue;
        if (relevance < 2 && isFast) continue;
        if (relevance === 0 && reference.source === "import") continue;
        candidates.set(key, { name: reference.name, path: item.path, relevance });
      }
    }
    const definitions = [...candidates.values()].sort((a, b) => b.relevance - a.relevance);
    for (const [index, { name, path, relevance }] of definitions
      .slice(0, isFast ? 1 : 4)
      .entries()) {
      // At most two relevant definitions per round go ahead of call sites, tests and config.
      const relevant = relevance >= 2 && index < 2;
      this.enqueue({
        purpose: "definition",
        query: name,
        options: { definitionOf: name },
        reason: `definition of ${name}, used in ${path}`,
        priority:
          (relevant ? PRIORITY.relevantDefinition : PRIORITY.otherDefinition) +
          depth -
          relevance / 100,
        reads: 2,
        depth,
      });
    }
    // Call sites and tests of the most relevant symbol of the best code evidence.
    for (const item of code.slice(0, isFast ? 1 : 2)) {
      const symbol = [...item.symbols].sort((a, b) => this.relevance(b) - this.relevance(a))[0];
      if (!symbol) continue;
      if (!isFast) {
        this.enqueue({
          purpose: "references",
          query: symbol,
          options: { referencesOf: symbol },
          reason: `call site of ${symbol}`,
          priority: PRIORITY.references + depth,
          reads: 2,
          depth,
        });
      }
      this.enqueue({
        purpose: "tests",
        query: symbol,
        options: { kinds: ["test"] },
        reason: `test covering ${symbol}`,
        priority: PRIORITY.tests + depth,
        reads: isFast ? 2 : 1,
        depth,
      });
    }
    if (isFast) return;
    // Docs that name identifiers: check they still exist in code.
    for (const item of fresh.filter((entry) => entry.kind === "docs")) {
      for (const name of documentedIdentifiers(item.text).slice(0, 3)) {
        if (defined.has(identifierKey(name))) continue;
        this.enqueue({
          purpose: "docs_check",
          query: name,
          options: { definitionOf: name },
          reason: `definition of ${name}, mentioned in ${item.path}`,
          priority: PRIORITY.docsCheck + depth,
          reads: 1,
          depth,
          docsEvidenceId: item.id,
        });
      }
    }
  }

  /** Deep only: configuration/docs for the question and a query refined with found symbols. */
  private planQuestionLeads(): void {
    const kinds = new Set(this.evidence.map((item) => item.kind));
    if (!kinds.has("config") || !kinds.has("docs")) {
      this.enqueue({
        purpose: "config_docs",
        query: this.session.question,
        options: { kinds: ["config", "docs"] },
        reason: "configuration or documentation for the question",
        priority: PRIORITY.configDocs,
        reads: 2,
        depth: 1,
      });
    }
    const symbols = [...new Set(this.evidence.flatMap((item) => item.symbols))].slice(0, 4);
    if (symbols.length > 0) {
      this.enqueue({
        purpose: "refine",
        query: `${this.session.question} ${symbols.join(" ")}`,
        options: { excludePaths: [...new Set(this.evidence.map((item) => item.path))] },
        reason: "matches the question refined with symbols found so far",
        priority: PRIORITY.refine,
        reads: 3,
        depth: 1,
      });
    }
  }

  /** Fast does not check docs claims; it says so for docs it read. */
  private docsNotes(): void {
    const defined = this.definedByEvidence();
    for (const item of this.evidence.filter((entry) => entry.kind === "docs")) {
      const unchecked = documentedIdentifiers(item.text).filter(
        (name) => !defined.has(identifierKey(name)),
      );
      if (unchecked.length > 0) {
        this.gaps.push(
          `${item.path}:${item.startLine}-${item.endLine} mentions ` +
            `${unchecked
              .slice(0, 3)
              .map((name) => `\`${name}\``)
              .join(", ")}; Fast did not ` +
            "check these against code at this revision.",
        );
      }
    }
  }

  private finalGaps(stop: ResearchStop): void {
    if (this.evidence.length === 0) {
      this.gaps.unshift(
        "No indexed source at this revision matched the question. Lexical retrieval may have " +
          "missed context phrased differently from the code.",
      );
    }
    if (stop.reason === "limit") {
      this.gaps.push(`Research stopped at the ${this.session.mode} limit ${stop.limit}.`);
    } else if (stop.reason === "time") {
      this.gaps.push(`Research stopped at the ${this.session.mode} research time limit.`);
    }
  }

  // -------------------------------------------------------------------------
  // Budgeted tools

  private checkTime(): void {
    if (this.now() - this.startedAt >= this.limits.maxElapsedMs) {
      throw new StopResearch({ reason: "time" });
    }
  }

  private async retrieve(lead: Lead): Promise<readonly RetrievalHit[]> {
    this.checkTime();
    if (this.passes >= this.limits.maxPasses) {
      this.leads.unshift(lead);
      throw new StopResearch({ reason: "limit", limit: "maxPasses" });
    }
    this.passes += 1;
    const started = this.now();
    const hits = await this.session.retrieve(lead.query, this.limits.maxHitsPerPass, lead.options);
    this.trace.push({
      type: "retrieve",
      pass: this.passes,
      purpose: lead.purpose,
      query: lead.query,
      ...(lead.options ? { options: lead.options } : {}),
      hits: hits.length,
      elapsedMs: Math.max(0, this.now() - started),
    });
    return hits;
  }

  /** Read up to `count` hits not already covered by evidence. */
  private async inspect(
    hits: readonly RetrievalHit[],
    count: number,
    reason: string,
    pass: number,
  ): Promise<void> {
    let used = 0;
    for (const hit of hits) {
      if (used >= count) break;
      const range = this.uncovered(hit);
      if (!range) {
        this.trace.push({
          type: "read",
          pass,
          path: hit.path,
          startLine: hit.startLine,
          endLine: hit.endLine,
          bytes: 0,
          outcome: "covered",
        });
        continue;
      }
      used += 1;
      await this.read(hit, range, reason, pass);
    }
  }

  /** The first part of a hit no evidence covers, capped at the per-read line limit. */
  private uncovered(hit: RetrievalHit): { startLine: number; endLine: number } | undefined {
    const covered = this.evidence
      .filter((item) => item.path === hit.path)
      .map((item) => [item.startLine, item.endLine] as const)
      .sort((a, b) => a[0] - b[0]);
    let start = hit.startLine;
    let end = hit.endLine;
    for (const [from, to] of covered) {
      if (to < start || from > end) continue;
      if (from <= start) start = Math.max(start, to + 1);
      else end = Math.min(end, from - 1);
      if (start > end) return undefined;
    }
    return { startLine: start, endLine: Math.min(end, start + this.limits.maxReadLines - 1) };
  }

  /** The hit's symbols, limited to those declared inside a trimmed read. */
  private symbolsIn(hit: RetrievalHit, source: SourceText): string[] {
    const symbols = [...(hit.symbols ?? (hit.symbol !== undefined ? [hit.symbol] : []))];
    if (source.startLine === hit.startLine && source.endLine === hit.endLine) return symbols;
    const keys = definedKeys(source.text, hit.kind ?? "code");
    return symbols.filter((symbol) => keys.has(identifierKey(symbol)));
  }

  private async read(
    hit: RetrievalHit,
    range: { startLine: number; endLine: number },
    reason: string,
    pass: number,
  ): Promise<void> {
    this.checkTime();
    if (this.reads >= this.limits.maxReads) {
      throw new StopResearch({ reason: "limit", limit: "maxReads" });
    }
    // The preview is the exact indexed text of the hit, so sizes are known before reading.
    const indexedLines = splitLines(hit.preview);
    const offset = range.startLine - hit.startLine;
    const remainingBytes = this.limits.maxReadBytes - this.bytes;
    let endLine = range.startLine - 1;
    let size = 0;
    for (let line = range.startLine; line <= range.endLine; line += 1) {
      const lineBytes = Buffer.byteLength(indexedLines[line - hit.startLine] ?? "", "utf8");
      if (size + lineBytes > remainingBytes) break;
      size += lineBytes;
      endLine = line;
    }
    if (endLine < range.startLine) {
      throw new StopResearch({ reason: "limit", limit: "maxReadBytes" });
    }

    this.reads += 1;
    let source: SourceText;
    try {
      source = await this.session.read({ path: hit.path, startLine: range.startLine, endLine });
    } catch (error) {
      if (!(error instanceof SourceRangeError)) throw error;
      this.trace.push({
        type: "read",
        pass,
        path: hit.path,
        startLine: range.startLine,
        endLine,
        bytes: 0,
        outcome: "missing",
      });
      this.gaps.push(
        `Indexed range ${hit.path}:${range.startLine}-${endLine} could not be read at this ` +
          "revision and was not used.",
      );
      return;
    }
    const bytes = Buffer.byteLength(source.text, "utf8");
    this.bytes += bytes;

    // Cite only bytes that match the index exactly; anything else is not evidence.
    const expected = indexedLines
      .slice(offset, offset + (source.endLine - source.startLine + 1))
      .join("");
    if (
      source.text !== expected ||
      (hit.contentHash !== undefined &&
        source.startLine === hit.startLine &&
        source.endLine === hit.endLine &&
        sha256(source.text) !== hit.contentHash)
    ) {
      this.trace.push({
        type: "read",
        pass,
        path: hit.path,
        startLine: source.startLine,
        endLine: source.endLine,
        bytes,
        outcome: "mismatch",
      });
      this.gaps.push(
        `Committed source at ${hit.path}:${source.startLine}-${source.endLine} did not match ` +
          "the index and was not used.",
      );
      return;
    }

    const id = `E${this.evidence.length + 1}`;
    const kind = hit.kind ?? evidenceKind(hit.path, hit.language ?? "text");
    this.evidence.push({
      id,
      repositoryId: this.session.repositoryId,
      sha: this.session.generation.sha,
      generationId: this.session.generation.generationId,
      path: source.path,
      startLine: source.startLine,
      endLine: source.endLine,
      contentHash: sha256(source.text),
      ...(hit.blobOid !== undefined ? { blobOid: hit.blobOid } : {}),
      kind,
      symbols: this.symbolsIn(hit, source),
      text: source.text,
      reason,
      pass,
      score: hit.score,
    });
    this.trace.push({
      type: "read",
      pass,
      path: source.path,
      startLine: source.startLine,
      endLine: source.endLine,
      bytes,
      outcome: "evidence",
      evidenceId: id,
    });
  }
}
