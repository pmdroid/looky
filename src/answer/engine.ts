/**
 * Looky's answer engine: complete natural-language answers from verified
 * evidence, in Fast or Deep mode.
 *
 * Fast runs the bounded Fast evidence pass and one synthesis call. When the
 * evidence is thin it says what is missing and suggests Deep; it never runs
 * Deep's plan or spends Deep's budget.
 *
 * Deep runs the Deep evidence plan, then up to `deepRounds` model-planned
 * rounds of read-only follow-up searches, synthesizes, and finally
 * cross-checks the draft against the evidence it cites before delivery.
 *
 * Both modes use only the guarded session, so every search, read and model
 * call is pinned to one repository, SHA and index generation, re-authorized
 * and budgeted. Citations are validated against inspected evidence records;
 * gaps, conflicts, limits and coverage are disclosed rather than hidden.
 */
import { BudgetExhaustedError, estimateTokens } from "../ask/session";
import type { AnswerOutcome, EvidenceRef, SuggestedHumanQuestion } from "../contract/response";
import type { AnswerEngine, EngineAnswer, ResearchSession } from "../contract/ports";
import type { Mode } from "../contract/input";
import { analyzeQuery, identifierKey } from "../retrieval/query";
import {
  DEFAULT_RESEARCH_LIMITS,
  followUpEvidence,
  researchEvidence,
  type EvidenceBundle,
  type ResearchLimits,
  type ResearchLimitsByMode,
} from "../retrieval/research";
import { validateCitations, type SourceLinkBuilder } from "./citations";
import {
  ModelOutputError,
  parseAnswerReply,
  parseCheckReply,
  parsePlanReply,
  type DraftAnswer,
} from "./model-output";
import {
  answerSystemPrompt,
  checkPrompt,
  checkSystemPrompt,
  packEvidence,
  type PackedEvidence,
  planPrompt,
  planSystemPrompt,
  synthesisPrompt,
} from "./prompts";

/** Limits for Deep's model-planned follow-up stage, on top of the Deep research limits. */
export const DEFAULT_FOLLOW_UP_LIMITS: ResearchLimits = {
  maxPasses: 6,
  maxReads: 10,
  maxReadBytes: 96 * 1024,
  maxReadLines: 160,
  maxHitsPerPass: 8,
  maxElapsedMs: 45_000,
};

export interface AnswerEngineOptions {
  readonly research?: ResearchLimitsByMode;
  /** Deep follow-up stage limits; each round gets what is left. */
  readonly followUp?: ResearchLimits;
  /** Model-planned follow-up rounds in Deep. Default 2; 0 disables planning. */
  readonly deepRounds?: number;
  /** Follow-up searches one planning round may request. Default 4. */
  readonly maxFollowUpsPerRound?: number;
  /** Links for verified citations, such as code host URLs pinned to the SHA. */
  readonly sourceLink?: SourceLinkBuilder;
  readonly now?: () => number;
}

/** Output tokens a planning call may use. */
const PLAN_OUTPUT_TOKENS = 600;
/** Characters kept free for the closing disclosure sentence. */
const DISCLOSURE_RESERVE = 400;

const WHY = /\b(?:why|rationale|intent|intention|motivation)\b/i;

export class LookyAnswerEngine implements AnswerEngine {
  readonly #options: AnswerEngineOptions;

  constructor(options: AnswerEngineOptions = {}) {
    const rounds = options.deepRounds ?? 2;
    if (!Number.isSafeInteger(rounds) || rounds < 0) {
      throw new Error("deepRounds must be a non-negative integer");
    }
    this.#options = options;
  }

  async answer(session: ResearchSession): Promise<EngineAnswer> {
    const now = this.#options.now;
    let bundle = await researchEvidence(session, {
      limits: this.#options.research ?? DEFAULT_RESEARCH_LIMITS,
      ...(now ? { now } : {}),
    });
    const notes: string[] = [];
    if (session.mode === "deep") bundle = await this.#followUps(session, bundle, notes);
    if (bundle.evidence.length === 0) return nothingFound(session, bundle);

    const maxChars = Math.max(200, session.budget.maxAnswerChars - DISCLOSURE_RESERVE);
    let draft = await this.#synthesize(session, bundle, maxChars, notes);
    if (session.mode === "deep")
      draft = await this.#crossCheck(session, bundle, draft, maxChars, notes);
    return this.#deliver(session, bundle, draft, notes);
  }

  // -------------------------------------------------------------------------
  // Deep research rounds

  async #followUps(
    session: ResearchSession,
    initial: EvidenceBundle,
    notes: string[],
  ): Promise<EvidenceBundle> {
    let bundle = initial;
    const rounds = this.#options.deepRounds ?? 2;
    const perRound = this.#options.maxFollowUpsPerRound ?? 4;
    const stage = { ...(this.#options.followUp ?? DEFAULT_FOLLOW_UP_LIMITS) };
    for (let round = 0; round < rounds; round += 1) {
      const remaining = session.remaining();
      // Keep a synthesis call and a cross-check call.
      if (remaining.maxModelCalls < 3 || remaining.maxRetrievalPasses < 1) break;
      if (stage.maxPasses <= 0 || stage.maxReads <= 0 || stage.maxReadBytes <= 0) break;
      const digestTokens = Math.floor(remaining.maxInputTokens * 0.15);
      const system = planSystemPrompt(perRound);
      let requests;
      try {
        const reply = await session.model({
          system,
          prompt: planPrompt(session.question, bundle, digestTokens),
          maxOutputTokens: Math.min(PLAN_OUTPUT_TOKENS, Math.floor(remaining.maxOutputTokens / 4)),
        });
        requests = parsePlanReply(reply.text, perRound);
      } catch (error) {
        if (error instanceof ModelOutputError) {
          notes.push("A Deep research plan could not be read, so planning stopped early.");
          break;
        }
        if (error instanceof BudgetExhaustedError) break;
        throw error;
      }
      const run = new Set(
        bundle.trace
          .filter((step) => step.type === "retrieve")
          .map((step) => `${step.query}\0${JSON.stringify(step.options ?? {})}`),
      );
      requests = requests.filter(
        (request) => !run.has(`${request.query}\0${JSON.stringify(request.options ?? {})}`),
      );
      if (requests.length === 0) break;
      const before = bundle;
      bundle = await followUpEvidence(session, bundle, requests, {
        limits: stage,
        ...(this.#options.now ? { now: this.#options.now } : {}),
      });
      // Later rounds get what this stage has left.
      stage.maxPasses -= bundle.usage.passes - before.usage.passes;
      stage.maxReads -= bundle.usage.reads - before.usage.reads;
      stage.maxReadBytes -= bundle.usage.bytes - before.usage.bytes;
      stage.maxElapsedMs -= bundle.usage.elapsedMs - before.usage.elapsedMs;
      if (bundle.evidence.length === before.evidence.length || bundle.stop.reason !== "complete") {
        break;
      }
    }
    return bundle;
  }

  // -------------------------------------------------------------------------
  // Synthesis and cross-check

  async #synthesize(
    session: ResearchSession,
    bundle: EvidenceBundle,
    maxChars: number,
    notes: string[],
  ): Promise<DraftAnswer> {
    const system = answerSystemPrompt(session.mode, maxChars);
    const remaining = session.remaining();
    // Deep keeps part of its input budget for the cross-check.
    const share = session.mode === "deep" ? 0.55 : 1;
    const fitted = fitPrompt(
      system,
      Math.floor(remaining.maxInputTokens * share),
      bundle.evidence,
      (packed) => synthesisPrompt(session.question, bundle, packed),
    );
    if (!fitted) throw new BudgetExhaustedError("maxInputTokens");
    const { packed, prompt } = fitted;
    if (packed.omitted.length > 0) {
      notes.push(
        `${packed.omitted.length} inspected source ranges did not fit the ${session.mode} input ` +
          "token budget and were not used for the answer.",
      );
    }
    const outputShare = session.mode === "deep" ? 0.5 : 1;
    const maxOutputTokens = Math.max(1, Math.floor(remaining.maxOutputTokens * outputShare));
    const reply = await session.model({ system, prompt, maxOutputTokens });
    try {
      return parseAnswerReply(reply.text);
    } catch (error) {
      if (!(error instanceof ModelOutputError)) throw error;
      // One repair attempt when the budget allows it; otherwise fail visibly.
      const left = session.remaining();
      if (left.maxModelCalls < 1 || left.maxOutputTokens < 1) throw error;
      const retry = await session.model({
        system,
        prompt:
          `${prompt}\n\nYour previous reply was rejected: ${error.message}. Reply with only the ` +
          "JSON object, with the answer written as explanatory sentences.",
        maxOutputTokens: left.maxOutputTokens,
      });
      return parseAnswerReply(retry.text);
    }
  }

  async #crossCheck(
    session: ResearchSession,
    bundle: EvidenceBundle,
    draft: DraftAnswer,
    maxChars: number,
    notes: string[],
  ): Promise<DraftAnswer> {
    const remaining = session.remaining();
    const unchecked = "The Deep cross-check of this answer against its evidence did not run.";
    if (remaining.maxModelCalls < 1 || remaining.maxOutputTokens < 1) {
      notes.push(unchecked);
      return draft;
    }
    const system = checkSystemPrompt(session.mode, maxChars);
    // The check sees the evidence the draft cites first, then the rest as budget allows.
    const cited = validateCitations(draft.answer, bundle.evidence).citedIds;
    const ordered = [
      ...bundle.evidence.filter((item) => cited.has(item.id)),
      ...bundle.evidence.filter((item) => !cited.has(item.id)),
    ];
    const draftJson = JSON.stringify(draft, null, 2);
    const fitted = fitPrompt(system, remaining.maxInputTokens, ordered, (packed) =>
      checkPrompt(session.question, bundle, draftJson, packed),
    );
    if (!fitted) {
      notes.push(unchecked);
      return draft;
    }
    try {
      const reply = await session.model({
        system,
        prompt: fitted.prompt,
        maxOutputTokens: remaining.maxOutputTokens,
      });
      const check = parseCheckReply(reply.text);
      return check.verdict === "ok" ? draft : check.draft;
    } catch (error) {
      if (error instanceof ModelOutputError || error instanceof BudgetExhaustedError) {
        notes.push(unchecked);
        return draft;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Delivery checks

  #deliver(
    session: ResearchSession,
    bundle: EvidenceBundle,
    draft: DraftAnswer,
    notes: string[],
  ): EngineAnswer {
    const cited = validateCitations(draft.answer, bundle.evidence, this.#options.sourceLink);
    const caveats: string[] = [];
    let outcome: AnswerOutcome = draft.outcome;

    if (cited.invalid.length > 0) {
      caveats.push(
        `${cited.invalid.length} source reference${cited.invalid.length === 1 ? "" : "s"} in ` +
          "the draft did not match inspected evidence and " +
          `${cited.invalid.length === 1 ? "was" : "were"} removed; the statements ` +
          `${cited.invalid.length === 1 ? "it was" : "they were"} attached to are unverified.`,
      );
      if (outcome === "supported") outcome = "partial";
    }
    let evidence: EvidenceRef[] = [...cited.evidence];
    if (evidence.length === 0 && outcome !== "unknown") {
      caveats.push(
        "No statement in this answer could be tied to inspected evidence, so it is unverified.",
      );
      outcome = "unknown";
    }

    // Stale docs: research found docs naming code that does not exist at this revision.
    const questionKeys = new Set(analyzeQuery(session.question).identifiers.map((id) => id.key));
    for (const conflict of bundle.conflicts) {
      caveats.push(conflict.message);
      const relevant =
        questionKeys.has(identifierKey(conflict.identifier)) ||
        cited.citedIds.has(conflict.docsEvidenceId);
      if (relevant && (outcome === "supported" || outcome === "partial")) outcome = "conflicting";
    }

    // Rationale must be backed by cited docs; otherwise it stays unknown.
    let rationale = draft.rationale;
    const citesDocs = bundle.evidence.some(
      (item) => item.kind === "docs" && cited.citedIds.has(item.id),
    );
    if (rationale === "documented" && !citesDocs) {
      caveats.push(
        "The answer described a reason that no cited documentation states, so the rationale " +
          "is treated as unknown.",
      );
      rationale = "unknown";
    }
    if (rationale === "not_asked" && WHY.test(session.question) && !citesDocs) {
      rationale = "unknown";
    }
    let suggestedHumanQuestion: SuggestedHumanQuestion | undefined;
    if (rationale === "unknown") {
      suggestedHumanQuestion = {
        question:
          draft.humanQuestion ??
          `What is the intended reason behind this behavior: ${session.question}`,
        reason:
          `Neither the code nor the documentation inspected at ${bundle.sha.slice(0, 12)} states ` +
          "the intent or rationale.",
      };
      caveats.push("The intent or rationale is not documented in the inspected evidence.");
    }

    for (const caveat of draft.caveats) caveats.push(caveat);
    for (const gap of bundle.gaps) caveats.push(gap);
    caveats.push(...notes);
    const files = new Set(bundle.evidence.map((item) => item.path)).size;
    caveats.push(
      `Based on ${bundle.evidence.length} inspected source range${bundle.evidence.length === 1 ? "" : "s"} ` +
        `in ${files} file${files === 1 ? "" : "s"} at commit ${bundle.sha.slice(0, 12)}; the rest ` +
        "of the repository was not read for this answer.",
    );

    const limited = bundle.stop.reason !== "complete";
    const suggestDeep =
      session.mode === "fast" &&
      (bundle.suggestDeep || outcome === "partial" || outcome === "unknown");
    let text = cited.text;
    const disclosure = closingSentence(session.mode, bundle, outcome, limited, suggestDeep);
    const maxChars = session.budget.maxAnswerChars;
    const room = maxChars - (disclosure ? disclosure.length + 2 : 0);
    if (text.length > room) {
      text = truncateProse(text, room);
      caveats.push("The answer was shortened to fit the answer length limit.");
      // Drop references whose links no longer appear in the shortened text.
      evidence = evidence.filter((ref) => text.includes(ref.path));
    }
    if (disclosure) text = `${text}\n\n${disclosure}`;
    if (evidence.length === 0 && outcome !== "unknown") outcome = "unknown";

    return {
      text,
      outcome,
      evidence,
      caveats: [...new Set(caveats)],
      ...(session.mode === "fast" ? { suggestDeep } : {}),
      ...(suggestedHumanQuestion ? { suggestedHumanQuestion } : {}),
    };
  }
}

/**
 * Pack as much evidence as fits so that system plus prompt stay within
 * `allowance` estimated tokens. Undefined when not even one range fits.
 */
function fitPrompt(
  system: string,
  allowance: number,
  evidence: EvidenceBundle["evidence"],
  build: (packed: PackedEvidence) => string,
): { packed: PackedEvidence; prompt: string } | undefined {
  let evidenceTokens = allowance - estimateTokens(system);
  for (let attempt = 0; attempt < 4 && evidenceTokens > 0; attempt += 1) {
    const packed = packEvidence(evidence, evidenceTokens);
    if (packed.included.length === 0) return undefined;
    const prompt = build(packed);
    const overflow = estimateTokens(system + prompt) - allowance;
    if (overflow <= 0) return { packed, prompt };
    evidenceTokens -= overflow + 50;
  }
  return undefined;
}

/** A short, natural statement of how limited the answer is, when it is. */
function closingSentence(
  mode: Mode,
  bundle: EvidenceBundle,
  outcome: AnswerOutcome,
  limited: boolean,
  suggestDeep: boolean,
): string | undefined {
  if (!limited && !suggestDeep && outcome !== "partial" && outcome !== "unknown") return undefined;
  const files = new Set(bundle.evidence.map((item) => item.path)).size;
  const scope = `This is based on ${bundle.evidence.length} source range${bundle.evidence.length === 1 ? "" : "s"} in ${files} file${files === 1 ? "" : "s"}`;
  const stop = limited
    ? `, and research stopped at the ${mode} ${bundle.stop.reason === "limit" ? `limit ${bundle.stop.limit}` : "time limit"}, so other relevant code may not have been inspected`
    : ", not the whole repository";
  const next = suggestDeep ? ' Asking again with mode "deep" can follow the remaining leads.' : "";
  return `${scope}${stop}.${next}`;
}

/** Cut at a paragraph or sentence boundary under `max` characters. */
function truncateProse(text: string, max: number): string {
  const head = text.slice(0, Math.max(0, max - 1));
  const paragraph = head.lastIndexOf("\n\n");
  if (paragraph > max * 0.5) return head.slice(0, paragraph).trimEnd();
  const sentence = Math.max(head.lastIndexOf(". "), head.lastIndexOf(".\n"));
  if (sentence > max * 0.3) return head.slice(0, sentence + 1).trimEnd();
  return `${head.trimEnd()}…`;
}

/** No evidence matched: an honest unknown without spending a model call. */
function nothingFound(session: ResearchSession, bundle: EvidenceBundle): EngineAnswer {
  const short = bundle.sha.slice(0, 12);
  const deep =
    session.mode === "fast"
      ? ' Asking again with mode "deep" runs a wider search, though it may still find nothing.'
      : "";
  return {
    text:
      `I could not find source in the index for commit ${short} that addresses this question, ` +
      "so I cannot explain it from the code. The search is lexical, so code that uses " +
      `different names than the question may have been missed.${deep}`,
    outcome: "unknown",
    evidence: [],
    caveats: [...new Set(bundle.gaps)],
    ...(session.mode === "fast" ? { suggestDeep: true } : {}),
  };
}
