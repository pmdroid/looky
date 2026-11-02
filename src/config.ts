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
import { type SourceLinkBuilder, sourceLinkFromTemplate } from "./answer/citations";
import {
  DEFAULT_WIKI_GENERATION_SETTINGS,
  validateWikiGenerationSettings,
  type WikiGenerationSettings,
} from "./wiki/generator";
import { DEFAULT_MAX_QUESTION_CHARS, MODES } from "./contract/input";
import { DEFAULT_INDEX_RETENTION, type IndexRetention } from "./indexing/index-service";
import { DEFAULT_INDEX_LIMITS, type IndexLimits, validateLimits } from "./indexing/policy";
import {
  DEFAULT_WIKI_PLAN_LIMITS,
  validateWikiPlanLimits,
  type WikiPlanLimits,
} from "./wiki/model";
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
  /** Snapshot retention and reader lease duration. */
  readonly retention: IndexRetention;
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
    retention: {
      retainReadyPerRepository:
        readPositiveInt(env, "LOOKY_INDEX_RETAIN_READY") ??
        DEFAULT_INDEX_RETENTION.retainReadyPerRepository,
      retainFailedPerRepository:
        readPositiveInt(env, "LOOKY_INDEX_RETAIN_FAILED") ??
        DEFAULT_INDEX_RETENTION.retainFailedPerRepository,
      leaseTtlMs:
        readPositiveInt(env, "LOOKY_INDEX_LEASE_TTL_MS") ?? DEFAULT_INDEX_RETENTION.leaseTtlMs,
    },
  };
}

/** Environment variable for one wiki plan limit, such as `LOOKY_WIKI_MAX_PAGES`. */
export function wikiLimitEnvName(field: keyof WikiPlanLimits): string {
  return `LOOKY_WIKI_${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
}

/**
 * Load wiki plan limits from `LOOKY_WIKI_*` environment variables over
 * documented defaults. `LOOKY_WIKI_MAX_MODULES` and `LOOKY_WIKI_MAX_WORKFLOWS`
 * accept 0 to plan no pages of that kind.
 */
export function loadWikiConfig(
  env: Record<string, string | undefined> = process.env,
): LookyWikiConfig {
  const limits: Record<string, number> = { ...DEFAULT_WIKI_PLAN_LIMITS };
  for (const field of Object.keys(DEFAULT_WIKI_PLAN_LIMITS) as (keyof WikiPlanLimits)[]) {
    const name = wikiLimitEnvName(field);
    if ((field === "maxModules" || field === "maxWorkflows") && env[name]?.trim() === "0") {
      limits[field] = 0;
      continue;
    }
    const value = readPositiveInt(env, name);
    if (value !== undefined) limits[field] = value;
  }
  const result = limits as unknown as WikiPlanLimits;
  validateWikiPlanLimits(result);

  const defaults = DEFAULT_WIKI_GENERATION_SETTINGS;
  const group = <T extends object>(prefix: string, base: T): T => {
    const values: Record<string, number> = { ...(base as Record<string, number>) };
    for (const field of Object.keys(base)) {
      const value = readPositiveInt(env, wikiSettingEnvName(prefix, field));
      if (value !== undefined) values[field] = value;
    }
    return values as T;
  };
  const generation: WikiGenerationSettings = {
    maxConcurrentGenerations:
      readPositiveInt(env, "LOOKY_WIKI_MAX_CONCURRENT_GENERATIONS") ??
      defaults.maxConcurrentGenerations,
    maxConcurrentPages:
      readPositiveInt(env, "LOOKY_WIKI_MAX_CONCURRENT_PAGES") ?? defaults.maxConcurrentPages,
    page: group("PAGE", defaults.page),
    research: group("RESEARCH", defaults.research),
    totals: group("TOTAL", defaults.totals),
  };
  validateWikiGenerationSettings(generation);
  const template = env.LOOKY_SOURCE_LINK_TEMPLATE?.trim();
  return {
    limits: result,
    generation,
    ...(template
      ? { sourceLinkTemplate: template, sourceLink: sourceLinkFromTemplate(template) }
      : {}),
  };
}

export interface LookyWikiConfig {
  readonly limits: WikiPlanLimits;
  readonly generation: WikiGenerationSettings;
  /** Template for citation links in generated pages; part of the generator fingerprint. */
  readonly sourceLinkTemplate?: string;
  readonly sourceLink?: SourceLinkBuilder;
}

/** `LOOKY_WIKI_<GROUP>_<FIELD>`, such as `LOOKY_WIKI_PAGE_MAX_MODEL_CALLS` or `LOOKY_WIKI_TOTAL_MAX_ELAPSED_MS`. */
export function wikiSettingEnvName(group: string, field: string): string {
  return `LOOKY_WIKI_${group}_${field.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`;
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
