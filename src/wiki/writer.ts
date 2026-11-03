/**
 * Write one generated wiki page from verified evidence.
 *
 * The writer reuses Looky's answer pipeline: it researches through the
 * guarded {@link ResearchSession} (pinned repository, SHA and index
 * generation, re-authorized and budgeted), so every range it shows the model
 * was read from committed source and checked byte for byte against the index.
 * Research is restricted to the page's planned source files, which are the
 * page's source dependencies; the model cannot request other reads.
 *
 * Model output is untrusted. Only known JSON fields survive; web links, HTML
 * and links to pages outside the page's neighbourhood are removed; citation
 * markers and path references are validated against the inspected evidence
 * and invalid ones are removed and counted. A section without a verified
 * citation is dropped. Design intent is kept apart from observed behaviour and
 * is only presented as documented when cited documentation states it.
 */
import { validateCitations, type SourceLinkBuilder } from "../answer/citations";
import { fitPrompt } from "../answer/engine";
import { extractJson, ModelOutputError } from "../answer/model-output";
import { hasExplanatoryProse } from "../answer/prose";
import { BudgetExhaustedError } from "../ask/session";
import type { ResearchSession } from "../contract/ports";
import type { EvidenceRef } from "../contract/response";
import {
  type Evidence,
  type EvidenceBundle,
  followUpEvidence,
  type ResearchLimits,
} from "../retrieval/research";
import type { WikiPageKind, WikiSourceRef } from "./model";
import { type WikiNeighbour, wikiPagePrompt, wikiSystemPrompt } from "./prompts";
import type { InspectedBlob } from "./store";

/** Bump when the writer's research, validation or rendering changes generated pages. */
export const WIKI_WRITER_VERSION = 3;

/** Research limits for one page. Inside the page budget, so synthesis keeps its share. */
export const DEFAULT_WIKI_RESEARCH_LIMITS: ResearchLimits = {
  maxPasses: 12,
  maxReads: 30,
  maxReadBytes: 224 * 1024,
  maxReadLines: 200,
  maxHitsPerPass: 4,
  maxElapsedMs: 40_000,
};

const MAX_SECTIONS = 12;
const MAX_INTENT = 8;
const MAX_CAVEATS = 6;
const MAX_READS_PER_SOURCE = 3;

export interface WikiPageInput {
  readonly title: string;
  readonly kind: WikiPageKind;
  readonly description: string;
  readonly scopePath: string | null;
  readonly sources: readonly WikiSourceRef[];
  readonly neighbours: readonly WikiNeighbour[];
}

export interface WikiPageValidation {
  /** Citation markers or path references that matched no inspected evidence. */
  readonly invalidCitations: number;
  /** Backticked functions, types or paths that appear nowhere in the inspected evidence. */
  readonly unknownNames: number;
  /** Sections removed because no verified citation or explanatory prose supported them. */
  readonly droppedSections: number;
  /** `[[slug]]` links to pages outside this page's neighbourhood. */
  readonly invalidLinks: number;
  /** Web links, images and HTML removed from model text. */
  readonly removedMarkup: number;
  /** Intent the model called documented without citing documentation. */
  readonly downgradedIntent: number;
  readonly evidenceRanges: number;
  readonly evidenceFiles: number;
  /** Inspected ranges that did not fit the input budget. */
  readonly omittedEvidence: number;
  /** Model replies rejected before one was accepted. */
  readonly rejectedReplies: number;
}

export interface WrittenWikiPage {
  /** Markdown body with verified citations and `[Title](wiki:slug)` page links. */
  readonly body: string;
  /** Exact cited ranges, with the blob each was read from. */
  readonly citations: readonly WikiSourceRef[];
  /** Every blob the evidence came from, checked again before a cached draft is reused. */
  readonly inspected: readonly InspectedBlob[];
  readonly validation: WikiPageValidation;
}

/** The page could not be written from evidence. */
export class WikiPageError extends Error {
  override readonly name = "WikiPageError";
  constructor(
    readonly code: "no_evidence" | "invalid_output" | "ungrounded",
    message: string,
  ) {
    super(message);
  }
}

export interface WriteWikiPageOptions {
  readonly research?: ResearchLimits;
  readonly sourceLink?: SourceLinkBuilder;
  readonly now?: () => number;
}

export async function writeWikiPage(
  session: ResearchSession,
  input: WikiPageInput,
  options: WriteWikiPageOptions = {},
): Promise<WrittenWikiPage> {
  const bundle = await researchPage(session, input, options);
  if (bundle.evidence.length === 0) {
    throw new WikiPageError(
      "no_evidence",
      `None of the ${input.sources.length} planned sources could be read and verified at ` +
        `commit ${bundle.sha.slice(0, 12)}`,
    );
  }
  const maxChars = session.budget.maxAnswerChars;
  const system = wikiSystemPrompt(input.kind, maxChars);
  const first = session.remaining();
  const fitted = fitPrompt(system, first.maxInputTokens, bundle.evidence, (packed) =>
    wikiPagePrompt({
      title: input.title,
      kind: input.kind,
      description: input.description,
      scopePath: input.scopePath,
      sha: bundle.sha,
      neighbours: input.neighbours,
      bundle,
      packed,
    }),
  );
  if (!fitted) throw new BudgetExhaustedError("maxInputTokens");

  let prompt = fitted.prompt;
  let rejected = 0;
  for (;;) {
    const remaining = session.remaining();
    const share = remaining.maxModelCalls > 1 ? 0.6 : 1;
    const reply = await session.model({
      system,
      prompt,
      maxOutputTokens: Math.max(1, Math.floor(remaining.maxOutputTokens * share)),
    });
    try {
      return render(reply.text, bundle, input, {
        // Only evidence the model was shown can support its claims.
        included: fitted.packed.included,
        omitted: fitted.packed.omitted.length,
        rejected,
        maxChars,
        ...(options.sourceLink ? { sourceLink: options.sourceLink } : {}),
      });
    } catch (error) {
      if (!(error instanceof ModelOutputError || error instanceof WikiPageError)) throw error;
      rejected += 1;
      const left = session.remaining();
      if (left.maxModelCalls < 1 || left.maxOutputTokens < 1) {
        throw error instanceof WikiPageError
          ? error
          : new WikiPageError("invalid_output", error.message);
      }
      prompt =
        `${fitted.prompt}\n\nYour previous reply was rejected: ${error.message}. Reply with only ` +
        "the JSON object. Every section needs explanatory sentences and citation markers that " +
        "use ids and lines shown in the evidence.";
    }
  }
}

// ---------------------------------------------------------------------------
// Research

async function researchPage(
  session: ResearchSession,
  input: WikiPageInput,
  options: WriteWikiPageOptions,
): Promise<EvidenceBundle> {
  const configured = options.research ?? DEFAULT_WIKI_RESEARCH_LIMITS;
  const sources = input.sources.slice(0, configured.maxPasses);
  const reads = Math.max(
    1,
    Math.min(MAX_READS_PER_SOURCE, Math.floor(configured.maxReads / Math.max(1, sources.length))),
  );
  const empty: EvidenceBundle = {
    mode: session.mode,
    question: session.question,
    repositoryId: session.repositoryId,
    sha: session.generation.sha,
    generationId: session.generation.generationId,
    evidence: [],
    gaps: [],
    conflicts: [],
    trace: [],
    usage: { passes: 0, reads: 0, bytes: 0, elapsedMs: 0 },
    limits: configured,
    stop: { reason: "complete" },
    suggestDeep: false,
  };
  // One exact-path search per planned file. The query is the path itself, so
  // the index returns that file's chunks and nothing outside the plan.
  const bundle = await followUpEvidence(
    session,
    empty,
    sources.map((source) => ({
      query: source.path,
      options: { pathPrefix: source.path },
      reason: `planned ${source.kind} source for ${input.title}`,
      reads,
    })),
    { limits: configured, ...(options.now ? { now: options.now } : {}) },
  );
  const planned = new Map(input.sources.map((source) => [source.path, source.blobOid]));
  // Defence in depth: evidence must come from a planned file at its planned blob.
  const evidence = bundle.evidence.filter(
    (item) =>
      planned.has(item.path) && (item.blobOid ?? planned.get(item.path)) === planned.get(item.path),
  );
  const missing = input.sources.length - new Set(evidence.map((item) => item.path)).size;
  const gaps =
    missing > 0
      ? [
          ...bundle.gaps,
          `${missing} of ${input.sources.length} planned source files were not inspected for this page.`,
        ]
      : bundle.gaps;
  return { ...bundle, evidence, gaps };
}

// ---------------------------------------------------------------------------
// Parsing and validation

interface DraftSection {
  readonly heading: string;
  readonly basis: "observed" | "inferred";
  readonly body: string;
}

interface DraftPage {
  readonly summary: string;
  readonly sections: readonly DraftSection[];
  readonly intent: readonly {
    readonly statement: string;
    readonly basis: "documented" | "unknown";
  }[];
  readonly caveats: readonly string[];
}

function text(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function records(value: unknown, max: number): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
        )
        .slice(0, max)
    : [];
}

/** Only known fields with the expected types survive. */
export function parseWikiReply(reply: string): DraftPage {
  const value = extractJson(reply);
  const sections = records(value.sections, MAX_SECTIONS)
    .map((item) => ({
      heading: text(item.heading, 120)
        .replace(/[\r\n]+/g, " ")
        .replace(/^#+\s*/, ""),
      // Anything not explicitly observed is treated as inference.
      basis: item.basis === "observed" ? ("observed" as const) : ("inferred" as const),
      body: text(item.body, 20_000),
    }))
    .filter((section) => section.heading.length > 0 && section.body.length > 0);
  if (sections.length === 0) throw new ModelOutputError("The model reply has no page sections");
  return {
    summary: text(value.summary, 4_000),
    sections,
    intent: records(value.intent, MAX_INTENT)
      .map((item) => ({
        statement: text(item.statement, 1_000),
        basis: item.basis === "documented" ? ("documented" as const) : ("unknown" as const),
      }))
      .filter((item) => item.statement.length > 0),
    caveats: (Array.isArray(value.caveats) ? value.caveats : [])
      .map((item) => text(item, 400))
      .filter((item) => item.length > 0)
      .slice(0, MAX_CAVEATS),
  };
}

const IMAGE = /!\[([^\]\n]*)\]\([^)\n]*\)/g;
const MD_LINK = /\[([^\]\n]*)\]\([^)\n]*\)/g;
const AUTOLINK = /<(?:[a-z][a-z0-9+.-]*:|www\.)[^>\s]*>/gi;
const URL_TEXT =
  /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s)\]>`]+|\b(?:javascript|data|vbscript|file|mailto):[^\s)\]>`]+/gi;
const HTML = /<\/?[A-Za-z][^>\n]*>/g;
/** A rendered citation group such as ``(`a.ts:1-4`, [b.ts:2](https://…))``. */
const CITATION_GROUP =
  /\s*\((?:`[^`]*`|\[[^\]]*\]\([^)]*\))(?:, (?:`[^`]*`|\[[^\]]*\]\([^)]*\)))*\)/g;
const PAGE_LINK = /\[\[\s*([^\][\s]+)\s*\]\]/g;

interface Scrubbed {
  readonly text: string;
  readonly removed: number;
  readonly invalidLinks: number;
  readonly links: readonly string[];
}

/**
 * Remove model-supplied web links, images and HTML, and replace allowed
 * `[[slug]]` page links with placeholders that citation validation leaves
 * alone. Linked text keeps its words; the target is dropped.
 */
function scrub(raw: string, allowed: ReadonlySet<string>): Scrubbed {
  let removed = 0;
  let invalidLinks = 0;
  const links: string[] = [];
  const keep = (_whole: string, words?: string) => {
    removed += 1;
    return typeof words === "string" ? words : "";
  };
  const drop = () => {
    removed += 1;
    return "";
  };
  // Placeholder characters are reserved for page links.
  let value = raw
    .replace(/[\uE000\uE001]/g, "")
    .replace(IMAGE, keep)
    .replace(MD_LINK, keep)
    .replace(AUTOLINK, drop)
    .replace(URL_TEXT, drop)
    .replace(HTML, drop);
  value = value.replace(PAGE_LINK, (_whole, slug: string) => {
    if (!allowed.has(slug)) {
      invalidLinks += 1;
      return "";
    }
    links.push(slug);
    return `\uE000${links.length - 1}\uE001`;
  });
  // Section structure belongs to the page; nested headings stay below it.
  value = value.replace(/^#{1,2}(?=\s)/gm, "###");
  return { text: value, removed, invalidLinks, links };
}

function restoreLinks(
  value: string,
  links: readonly string[],
  titles: ReadonlyMap<string, string>,
): string {
  return value.replace(/\uE000(\d+)\uE001/g, (_whole, index: string) => {
    const slug = links[Number(index)]!;
    return `[${escapeLinkText(titles.get(slug) ?? slug)}](wiki:${slug})`;
  });
}

function escapeLinkText(title: string): string {
  return title.replace(/[[\]\\]/g, "\\$&");
}

interface Checked {
  readonly text: string;
  readonly evidence: readonly EvidenceRef[];
  readonly citedIds: ReadonlySet<string>;
  readonly invalid: number;
  readonly unknownNames: number;
  readonly removed: number;
  readonly invalidLinks: number;
}

/** `path:12` or `path:12-20`, optionally in backticks, including absolute and extensionless paths. */
const PATH_REF =
  /(?<![\w/:.@-])(`?)((?:\.{1,2}\/|\/)?(?:[\w.-]+\/)*[\w.-]+):(\d+)(?:-(\d+))?\1(?![\w/])/g;

/**
 * Turn every path-and-line reference into an evidence marker when it lies
 * inside inspected evidence, and strip the line numbers when it does not.
 * Citation validation alone only recognizes paths with a file extension, so
 * a reference like `/etc/passwd:1` or `src/Makefile:3` would otherwise stay
 * in the text looking like a verified citation. Bare words such as
 * `localhost:8080` are left alone.
 */
function pathReferences(
  value: string,
  evidence: readonly Evidence[],
): { readonly text: string; readonly invalid: number } {
  let invalid = 0;
  const text = value.replace(
    PATH_REF,
    (whole, _tick: string, path: string, startRaw: string, endRaw?: string) => {
      if (!path.includes("/") && !/\.[A-Za-z][A-Za-z0-9]*$/.test(path)) return whole;
      const start = Number(startRaw);
      const end = endRaw === undefined ? start : Number(endRaw);
      const item = evidence.find(
        (candidate) =>
          candidate.path === path &&
          start <= end &&
          start >= candidate.startLine &&
          end <= candidate.endLine,
      );
      if (item) return `[${item.id}:${start}-${end}]`;
      invalid += 1;
      return `\`${path}\``;
    },
  );
  return { text, invalid };
}

/** What the model was shown: every word, path and directory of the included evidence. */
export interface EvidenceVocabulary {
  readonly words: ReadonlySet<string>;
  readonly paths: ReadonlySet<string>;
  readonly text: string;
}

const WORD = /[A-Za-z_$][\w$]*/g;
/** A code span that names something: an identifier, member, call or path, without spaces. */
const NAME_SPAN = /^[A-Za-z_$./][\w$./-]*(?:\(\))?$/;
/** Language literals a page may name without the evidence spelling them out. */
const LITERALS = new Set(["true", "false", "null", "undefined", "None", "nil", "NaN"]);
export const NOT_FOUND_LABEL = "(not found in the inspected source)";
const DRAFT_NOTES = "Notes on this draft, not checked against the source:";

export function evidenceVocabulary(
  evidence: readonly Evidence[],
  extraPaths: readonly string[] = [],
): EvidenceVocabulary {
  const words = new Set<string>();
  const paths = new Set<string>();
  for (const item of evidence) {
    for (const match of item.text.matchAll(WORD)) words.add(match[0]);
    for (const symbol of item.symbols)
      for (const match of symbol.matchAll(WORD)) words.add(match[0]);
  }
  for (const path of [...evidence.map((item) => item.path), ...extraPaths]) {
    const parts = path.split("/");
    paths.add(path);
    paths.add(parts.at(-1)!);
    for (let end = 1; end < parts.length; end += 1) paths.add(parts.slice(0, end).join("/"));
  }
  return { words, paths, text: evidence.map((item) => item.text).join("\n") };
}

/** Whether a backticked name is something the evidence shows. Unclassifiable spans pass. */
export function nameIsSupported(span: string, vocabulary: EvidenceVocabulary): boolean {
  if (span.length < 3 || !NAME_SPAN.test(span) || LITERALS.has(span)) return true;
  const name = span.replace(/\(\)$/, "").replace(/^\.\//, "").replace(/\/+$/, "");
  if (name.length === 0 || vocabulary.paths.has(name)) return true;
  if (name.includes("/") && !looksLikeFile(span, name, vocabulary)) {
    return vocabulary.text.includes(name);
  }
  if (name.includes("/")) {
    // A path is known only as an inspected or planned file or directory, or as an
    // import specifier the evidence uses for one. Being mentioned in source text is
    // not enough: repository text can name any path.
    const stem = name.replace(/^(?:\.{1,2}\/)+/, "").replace(/\.[A-Za-z0-9]+$/, "");
    return (
      vocabulary.text.includes(name) &&
      [...vocabulary.paths].some((path) => {
        const bare = path.replace(/\.[A-Za-z0-9]+$/, "");
        return bare === stem || bare.endsWith(`/${stem}`);
      })
    );
  }
  // Whole identifiers only: `dispatch` is not shown by evidence that only has `dispatchAll`.
  const segments = name.match(WORD) ?? [];
  return segments.length > 0 && segments.every((segment) => vocabulary.words.has(segment));
}

function looksLikeFile(span: string, name: string, vocabulary: EvidenceVocabulary): boolean {
  const first = name.replace(/^(?:\.{1,2}\/)+/, "").split("/")[0]!;
  return (
    /\.[A-Za-z0-9]+$/.test(name) ||
    span.trim().endsWith("/") ||
    name.startsWith(".") ||
    vocabulary.paths.has(first)
  );
}

/**
 * Citation markers prove a range exists, not that the prose about it is
 * true. A function, type or file named in backticks that appears nowhere in
 * the evidence the model was shown is invented or unverified: it is marked
 * as not found instead of being stated as fact.
 */
function unknownNames(
  value: string,
  vocabulary: EvidenceVocabulary,
): { readonly text: string; readonly unknown: number } {
  let unknown = 0;
  const text = value.replace(/`([^`\n]{1,200})`(?! \(not found)/g, (whole, span: string) => {
    if (nameIsSupported(span.trim(), vocabulary)) return whole;
    unknown += 1;
    return `${whole} ${NOT_FOUND_LABEL}`;
  });
  return { text, unknown };
}

function check(
  raw: string,
  evidence: readonly Evidence[],
  allowed: ReadonlySet<string>,
  titles: ReadonlyMap<string, string>,
  link: SourceLinkBuilder | undefined,
  vocabulary: EvidenceVocabulary,
): Checked {
  const scrubbed = scrub(raw, allowed);
  const refs = pathReferences(scrubbed.text, evidence);
  const names = unknownNames(refs.text, vocabulary);
  const cited = validateCitations(names.text, evidence, link);
  return {
    text: restoreLinks(cited.text, scrubbed.links, titles),
    evidence: cited.evidence,
    citedIds: cited.citedIds,
    invalid: cited.invalid.length + refs.invalid,
    unknownNames: names.unknown,
    removed: scrubbed.removed,
    invalidLinks: scrubbed.invalidLinks,
  };
}

function render(
  reply: string,
  bundle: EvidenceBundle,
  input: WikiPageInput,
  context: {
    readonly included: readonly Evidence[];
    readonly omitted: number;
    readonly rejected: number;
    readonly maxChars: number;
    readonly sourceLink?: SourceLinkBuilder;
  },
): WrittenWikiPage {
  const draft = parseWikiReply(reply);
  const allowed = new Set(input.neighbours.map((n) => n.slug));
  const titles = new Map(input.neighbours.map((n) => [n.slug, n.title]));
  const evidence = context.included;
  const docsIds = new Set(evidence.filter((item) => item.kind === "docs").map((item) => item.id));
  const vocabulary = evidenceVocabulary(evidence, [
    ...input.sources.map((source) => source.path),
    ...(input.scopePath ? [input.scopePath] : []),
  ]);
  const run = (raw: string) =>
    check(raw, evidence, allowed, titles, context.sourceLink, vocabulary);

  let invalid = 0;
  let unknown = 0;
  let removed = 0;
  let invalidLinks = 0;
  const refs: EvidenceRef[] = [];
  const tally = (checked: Checked) => {
    invalid += checked.invalid;
    unknown += checked.unknownNames;
    removed += checked.removed;
    invalidLinks += checked.invalidLinks;
  };

  const summary = run(draft.summary);
  tally(summary);
  const parts: string[] = [];
  // The summary makes claims too: it is kept only with a verified citation.
  const summaryKept = summary.citedIds.size > 0 && hasExplanatoryProse(summary.text);
  if (summaryKept) {
    parts.push(summary.text);
    refs.push(...summary.evidence);
  }

  let dropped = 0;
  let kept = 0;
  let length = parts.join("\n\n").length;
  for (const section of draft.sections) {
    const body = run(section.body);
    tally(body);
    // A section must explain something in sentences and cite verified evidence.
    if (body.citedIds.size === 0 || !hasExplanatoryProse(body.text)) {
      dropped += 1;
      continue;
    }
    // Headings carry no citations or links; the section body holds the evidence.
    const heading =
      run(section.heading)
        .text.replace(CITATION_GROUP, "")
        .replace(/\[[^\]]*\]\(wiki:[^)]*\)/g, "")
        .trim() || "Notes";
    const label =
      section.basis === "inferred"
        ? "*Inferred from the cited code; the source does not state this directly.*\n\n"
        : "";
    const block = `## ${heading}\n\n${label}${body.text}`;
    if (kept > 0 && length + block.length > context.maxChars * 1.25) {
      dropped += 1;
      continue;
    }
    parts.push(block);
    refs.push(...body.evidence);
    length += block.length + 2;
    kept += 1;
  }
  if (kept === 0) {
    throw new WikiPageError(
      "ungrounded",
      `No section of the page cited inspected evidence (${invalid} invalid references removed)`,
    );
  }

  let downgraded = 0;
  const intentLines: string[] = [];
  for (const item of draft.intent) {
    const statement = run(item.statement);
    tally(statement);
    if (statement.text.length === 0) continue;
    const citesDocs = [...statement.citedIds].some((id) => docsIds.has(id));
    if (item.basis === "documented" && citesDocs) {
      intentLines.push(`- **Documented:** ${statement.text}`);
      refs.push(...statement.evidence);
    } else {
      if (item.basis === "documented") downgraded += 1;
      // Unverified intent is stated as an open question, without citations that would lend it weight.
      const plain = statement.text.replace(CITATION_GROUP, "");
      intentLines.push(`- **Not documented:** ${plain}`);
    }
  }
  if (intentLines.length > 0)
    parts.push(`## Intent and open questions\n\n${intentLines.join("\n")}`);

  const caveats: string[] = [];
  const notes: string[] = [];
  for (const caveat of draft.caveats) {
    const checked = run(caveat);
    tally(checked);
    if (checked.text.length === 0) continue;
    if (checked.citedIds.size > 0) {
      caveats.push(checked.text);
      refs.push(...checked.evidence);
    } else {
      // A caveat is a claim too. Without verified support it is labelled, not stated as fact.
      const plain = checked.text.replace(CITATION_GROUP, "").trim();
      if (plain.length > 0) notes.push(plain);
    }
  }
  if (draft.summary.trim().length > 0 && !summaryKept) {
    notes.push("The drafted summary was left out because it cited no inspected evidence.");
  }
  if (invalid > 0) {
    notes.push(
      `${invalid} source reference${invalid === 1 ? "" : "s"} in the draft did not match ` +
        "inspected evidence and " +
        `${invalid === 1 ? "was" : "were"} removed.`,
    );
  }
  if (unknown > 0) {
    notes.push(
      `${unknown} name${unknown === 1 ? "" : "s"} in the draft did not appear in the inspected ` +
        `source and ${unknown === 1 ? "is" : "are"} marked as not found; treat ` +
        `${unknown === 1 ? "it" : "them"} as unverified.`,
    );
  }
  if (dropped > 0) {
    notes.push(
      `${dropped} drafted section${dropped === 1 ? " was" : "s were"} left out because ` +
        `${dropped === 1 ? "it was" : "they were"} not supported by cited evidence or did not fit.`,
    );
  }
  if (downgraded > 0) {
    notes.push(
      "A stated reason was not backed by cited documentation, so it is listed as an open question.",
    );
  }
  if (context.omitted > 0) {
    notes.push(
      `${context.omitted} inspected source range${context.omitted === 1 ? "" : "s"} did not fit ` +
        "the input budget and were not used.",
    );
  }
  for (const gap of bundle.gaps) notes.push(gap);
  if (caveats.length > 0) {
    parts.push(`## Caveats\n\n${[...new Set(caveats)].map((item) => `- ${item}`).join("\n")}`);
  }

  const files = new Set(evidence.map((item) => item.path)).size;
  parts.push(
    `---\n\n*Generated from commit \`${bundle.sha.slice(0, 12)}\` using ${evidence.length} ` +
      `inspected source range${evidence.length === 1 ? "" : "s"} in ${files} file` +
      `${files === 1 ? "" : "s"}. Cited lines refer to that commit. Sections marked inferred ` +
      "are conclusions drawn from the code, and intent is only called documented when cited " +
      "documentation states it.*",
  );
  if (notes.length > 0) {
    parts.push(`${DRAFT_NOTES}\n\n${[...new Set(notes)].map((item) => `- ${item}`).join("\n")}`);
  }

  return {
    body: parts.join("\n\n"),
    citations: citationsOf(refs, evidence, input.sources),
    inspected: inspectedOf(evidence, input.sources),
    validation: {
      invalidCitations: invalid,
      unknownNames: unknown,
      droppedSections: dropped,
      invalidLinks,
      removedMarkup: removed,
      downgradedIntent: downgraded,
      evidenceRanges: evidence.length,
      evidenceFiles: files,
      omittedEvidence: context.omitted,
      rejectedReplies: context.rejected,
    },
  };
}

function blobFor(
  path: string,
  evidence: readonly Evidence[],
  sources: readonly WikiSourceRef[],
): string | undefined {
  return (
    evidence.find((item) => item.path === path && item.blobOid)?.blobOid ??
    sources.find((source) => source.path === path)?.blobOid
  );
}

function citationsOf(
  refs: readonly EvidenceRef[],
  evidence: readonly Evidence[],
  sources: readonly WikiSourceRef[],
): WikiSourceRef[] {
  const seen = new Set<string>();
  const result: WikiSourceRef[] = [];
  for (const ref of refs) {
    const key = `${ref.path}\0${ref.startLine}\0${ref.endLine}`;
    if (seen.has(key)) continue;
    const item = evidence.find(
      (candidate) =>
        candidate.path === ref.path &&
        candidate.startLine <= ref.startLine &&
        ref.endLine <= candidate.endLine,
    );
    const blobOid = blobFor(ref.path, evidence, sources);
    if (!item || !blobOid) continue;
    seen.add(key);
    result.push({
      path: ref.path,
      blobOid,
      startLine: ref.startLine,
      endLine: ref.endLine,
      kind: item.kind,
    });
  }
  return result;
}

function inspectedOf(
  evidence: readonly Evidence[],
  sources: readonly WikiSourceRef[],
): InspectedBlob[] {
  const result = new Map<string, string>();
  for (const item of evidence) {
    const blobOid = blobFor(item.path, evidence, sources);
    if (blobOid) result.set(item.path, blobOid);
  }
  return [...result]
    .map(([path, blobOid]) => ({ path, blobOid }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
