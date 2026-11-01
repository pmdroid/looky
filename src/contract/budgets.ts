import type { Mode } from "./input";

/** Finite limits for one request. Every field is a positive integer. */
export interface ModeBudget {
  /** Index retrieval passes (searches) against the pinned index generation. */
  readonly maxRetrievalPasses: number;
  /** Maximum hits returned by one retrieval pass. */
  readonly maxResultsPerPass: number;
  /** Exact source range reads at the pinned revision. */
  readonly maxSourceReads: number;
  /** Total bytes returned by source reads. */
  readonly maxSourceBytes: number;
  /** Model (provider) calls. */
  readonly maxModelCalls: number;
  /** Total model input tokens across calls. */
  readonly maxInputTokens: number;
  /** Total model output tokens across calls. */
  readonly maxOutputTokens: number;
  /** Characters in the delivered answer text. */
  readonly maxAnswerChars: number;
  /** Wall-clock time for the whole request, in milliseconds. */
  readonly maxElapsedMs: number;
}

export type BudgetField = keyof ModeBudget;
export type ModeBudgets = Readonly<Record<Mode, ModeBudget>>;
export type BudgetOverrides = Partial<Record<Mode, Partial<ModeBudget>>>;

export const BUDGET_FIELDS: readonly BudgetField[] = [
  "maxRetrievalPasses",
  "maxResultsPerPass",
  "maxSourceReads",
  "maxSourceBytes",
  "maxModelCalls",
  "maxInputTokens",
  "maxOutputTokens",
  "maxAnswerChars",
  "maxElapsedMs",
];

/**
 * Documented defaults. Fast is a small bounded pass; Deep allows multi-step
 * research with strictly larger, still finite limits.
 */
export const DEFAULT_BUDGETS: ModeBudgets = {
  fast: {
    maxRetrievalPasses: 2,
    maxResultsPerPass: 10,
    maxSourceReads: 8,
    maxSourceBytes: 64 * 1024,
    maxModelCalls: 2,
    maxInputTokens: 24_000,
    maxOutputTokens: 1_500,
    maxAnswerChars: 6_000,
    maxElapsedMs: 30_000,
  },
  deep: {
    maxRetrievalPasses: 8,
    maxResultsPerPass: 20,
    maxSourceReads: 48,
    maxSourceBytes: 512 * 1024,
    maxModelCalls: 10,
    maxInputTokens: 200_000,
    maxOutputTokens: 8_000,
    maxAnswerChars: 24_000,
    maxElapsedMs: 180_000,
  },
};

/**
 * Validate a complete budget table. Deep must allow multi-step research and be
 * at least as large as Fast in every dimension, with more retrieval passes.
 */
export function validateBudgets(budgets: ModeBudgets): void {
  for (const mode of ["fast", "deep"] as const) {
    for (const field of BUDGET_FIELDS) {
      const value = budgets[mode][field];
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new Error(`${mode}.${field} must be a positive integer, got ${String(value)}`);
      }
    }
  }
  for (const field of BUDGET_FIELDS) {
    if (budgets.deep[field] < budgets.fast[field]) {
      throw new Error(`deep.${field} must not be smaller than fast.${field}`);
    }
  }
  if (budgets.deep.maxRetrievalPasses <= budgets.fast.maxRetrievalPasses) {
    throw new Error("deep.maxRetrievalPasses must exceed fast.maxRetrievalPasses");
  }
}

/**
 * Apply client-adapter limits. Adapters may only tighten Looky's configured
 * limits; a larger value is clamped to the configured one.
 */
export function tightenBudget(base: ModeBudget, overrides: Partial<ModeBudget> = {}): ModeBudget {
  const result: Record<BudgetField, number> = { ...base };
  for (const field of BUDGET_FIELDS) {
    const value = overrides[field];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`adapter budget ${field} must be a positive integer, got ${String(value)}`);
    }
    result[field] = Math.min(base[field], value);
  }
  return result;
}
