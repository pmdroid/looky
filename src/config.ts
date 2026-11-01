import {
  BUDGET_FIELDS,
  DEFAULT_BUDGETS,
  type BudgetField,
  type ModeBudget,
  type ModeBudgets,
  validateBudgets,
} from "./contract/budgets";
import { DEFAULT_MAX_QUESTION_CHARS, MODES } from "./contract/input";

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
