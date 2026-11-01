import {
  BUDGET_FIELDS,
  DEFAULT_BUDGETS,
  type BudgetField,
  type ModeBudget,
  type ModeBudgets,
  validateBudgets,
} from "./contract/budgets";
import type { AnswerEngineOptions } from "./answer/engine";
import { DEFAULT_FOLLOW_UP_LIMITS } from "./answer/engine";
import { sourceLinkFromTemplate } from "./answer/citations";
import { DEFAULT_MAX_QUESTION_CHARS, MODES } from "./contract/input";
import { DEFAULT_INDEX_LIMITS, type IndexLimits, validateLimits } from "./indexing/policy";
import {
  DEFAULT_RESEARCH_LIMITS,
  RESEARCH_LIMIT_FIELDS,
  type ResearchLimitField,
  type ResearchLimits,
  type ResearchLimitsByMode,
  validateResearchLimits,
} from "./retrieval/research";

export interface LookyAskConfig {
  readonly maxQuestionChars: number;
  /** Suggested client retry delay while an index build is in progress. */
  readonly indexRetryAfterMs: number;
  readonly budgets: ModeBudgets;
}

export const DEFAULT_INDEX_RETRY_AFTER_MS = 5_000;

/** `maxSourceBytes` -> `MAX_SOURCE_BYTES`. */
function envSuffix(field: BudgetField): string {
  return field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase();
}

/** Environment variable for one mode limit, such as `LOOKY_DEEP_MAX_SOURCE_BYTES`. */
export function budgetEnvName(mode: string, field: BudgetField): string {
  return `LOOKY_${mode.toUpperCase()}_${envSuffix(field)}`;
}

function readPositiveInt(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (!/^[1-9][0-9]*$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return Number(trimmed);
}

/** Load ask_project limits from `LOOKY_*` environment variables over documented defaults. */
export function loadAskConfig(
  env: Record<string, string | undefined> = process.env,
): LookyAskConfig {
  const budgets = Object.fromEntries(
    MODES.map((mode) => {
      const budget: Record<BudgetField, number> = { ...DEFAULT_BUDGETS[mode] };
      for (const field of BUDGET_FIELDS) {
        const value = readPositiveInt(env, budgetEnvName(mode, field));
        if (value !== undefined) budget[field] = value;
      }
      return [mode, budget satisfies ModeBudget];
    }),
  ) as unknown as ModeBudgets;
  validateBudgets(budgets);
  return {
    maxQuestionChars:
      readPositiveInt(env, "LOOKY_MAX_QUESTION_CHARS") ?? DEFAULT_MAX_QUESTION_CHARS,
    indexRetryAfterMs:
      readPositiveInt(env, "LOOKY_INDEX_RETRY_AFTER_MS") ?? DEFAULT_INDEX_RETRY_AFTER_MS,
    budgets,
  };
}

export interface LookyIndexConfig {
  readonly limits: IndexLimits;
  /** Index builds that may run at once; further builds wait in a queue. */
  readonly maxConcurrentBuilds: number;
}

export const DEFAULT_MAX_CONCURRENT_BUILDS = 1;

/** Environment variable for one index limit, such as `LOOKY_INDEX_MAX_FILE_BYTES`. */
export function indexLimitEnvName(field: keyof IndexLimits): string {
  return `LOOKY_INDEX_${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

/** Load index limits from `LOOKY_INDEX_*` environment variables over documented defaults. */
export function loadIndexConfig(
  env: Record<string, string | undefined> = process.env,
): LookyIndexConfig {
  const limits: Record<string, number> = { ...DEFAULT_INDEX_LIMITS };
  for (const field of Object.keys(DEFAULT_INDEX_LIMITS) as (keyof IndexLimits)[]) {
    const name = indexLimitEnvName(field);
    if (field === "chunkOverlapLines" && env[name]?.trim() === "0") {
      limits[field] = 0;
      continue;
    }
    const value = readPositiveInt(env, name);
    if (value !== undefined) limits[field] = value;
  }
  const result = limits as unknown as IndexLimits;
  validateLimits(result);
  return {
    limits: result,
    maxConcurrentBuilds:
      readPositiveInt(env, "LOOKY_INDEX_MAX_CONCURRENT_BUILDS") ?? DEFAULT_MAX_CONCURRENT_BUILDS,
  };
}

/** Environment variable for one research limit, such as `LOOKY_DEEP_RESEARCH_MAX_PASSES`. */
export function researchLimitEnvName(mode: string, field: ResearchLimitField): string {
  return `LOOKY_${mode.toUpperCase()}_RESEARCH_${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

/** Load Fast/Deep evidence research limits from `LOOKY_*_RESEARCH_*` variables over defaults. */
export function loadResearchConfig(
  env: Record<string, string | undefined> = process.env,
): ResearchLimitsByMode {
  const limits = Object.fromEntries(
    MODES.map((mode) => {
      const values: Record<ResearchLimitField, number> = { ...DEFAULT_RESEARCH_LIMITS[mode] };
      for (const field of RESEARCH_LIMIT_FIELDS) {
        const value = readPositiveInt(env, researchLimitEnvName(mode, field));
        if (value !== undefined) values[field] = value;
      }
      return [mode, values satisfies ResearchLimits];
    }),
  ) as unknown as ResearchLimitsByMode;
  validateResearchLimits(limits);
  return limits;
}

/** Environment variable for one Deep follow-up limit, such as `LOOKY_DEEP_FOLLOW_UP_MAX_READS`. */
export function followUpLimitEnvName(field: ResearchLimitField): string {
  return `LOOKY_DEEP_FOLLOW_UP_${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

/**
 * Load answer engine settings: Deep follow-up rounds and limits, and an
 * optional source link template. Research limits come from
 * {@link loadResearchConfig}.
 */
export function loadAnswerConfig(
  env: Record<string, string | undefined> = process.env,
): Omit<AnswerEngineOptions, "research" | "now"> {
  const followUp: Record<ResearchLimitField, number> = { ...DEFAULT_FOLLOW_UP_LIMITS };
  for (const field of RESEARCH_LIMIT_FIELDS) {
    const value = readPositiveInt(env, followUpLimitEnvName(field));
    if (value !== undefined) followUp[field] = value;
  }
  const rawRounds = env.LOOKY_DEEP_ROUNDS?.trim();
  let deepRounds: number | undefined;
  if (rawRounds !== undefined) {
    if (!/^[0-9]+$/.test(rawRounds) || Number(rawRounds) > 10) {
      throw new Error(
        `LOOKY_DEEP_ROUNDS must be an integer from 0 to 10, got ${JSON.stringify(rawRounds)}`,
      );
    }
    deepRounds = Number(rawRounds);
  }
  const maxFollowUpsPerRound = readPositiveInt(env, "LOOKY_DEEP_MAX_FOLLOW_UPS_PER_ROUND");
  const template = env.LOOKY_SOURCE_LINK_TEMPLATE?.trim();
  return {
    followUp,
    ...(deepRounds !== undefined ? { deepRounds } : {}),
    ...(maxFollowUpsPerRound !== undefined ? { maxFollowUpsPerRound } : {}),
    ...(template ? { sourceLink: sourceLinkFromTemplate(template) } : {}),
  };
}
