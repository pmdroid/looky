/**
 * Untrusted `ask_project` tool arguments.
 *
 * The arguments carry only the question and the requested mode. Repository,
 * revision, caller and client scope come from the trusted request context the
 * client adapter derives from its authenticated session, never from here.
 */

export const MODES = ["fast", "deep"] as const;
export type Mode = (typeof MODES)[number];
export const DEFAULT_MODE: Mode = "fast";

export const DEFAULT_MAX_QUESTION_CHARS = 4000;

export interface AskProjectInput {
  readonly question: string;
  readonly mode: Mode;
}

export type InputParseResult =
  | { readonly ok: true; readonly input: AskProjectInput }
  | { readonly ok: false; readonly code: InputErrorCode; readonly message: string };

export type InputErrorCode =
  | "not_an_object"
  | "unexpected_argument"
  | "question_missing"
  | "question_empty"
  | "question_too_long"
  | "invalid_mode";

const ALLOWED_KEYS = new Set(["question", "mode"]);

export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value);
}

/**
 * Validate raw tool arguments. Unknown keys are rejected rather than ignored so
 * a caller cannot believe it selected a repository, revision or scope.
 */
export function parseAskProjectInput(
  raw: unknown,
  options: { readonly maxQuestionChars?: number } = {},
): InputParseResult {
  const maxChars = options.maxQuestionChars ?? DEFAULT_MAX_QUESTION_CHARS;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return fail("not_an_object", "ask_project arguments must be an object");
  }
  const record = raw as Record<string, unknown>;
  const unexpected = Object.keys(record).filter((key) => !ALLOWED_KEYS.has(key));
  if (unexpected.length > 0) {
    return fail(
      "unexpected_argument",
      `Unsupported ask_project arguments: ${unexpected.join(", ")}. Repository, revision and ` +
        "scope come from the authorized session, not from tool arguments.",
    );
  }

  const { question, mode } = record;
  if (typeof question !== "string") return fail("question_missing", "question must be a string");
  const trimmed = question.trim();
  if (trimmed.length === 0) return fail("question_empty", "question must not be empty");
  if (trimmed.length > maxChars) {
    return fail("question_too_long", `question exceeds ${maxChars} characters`);
  }

  if (mode !== undefined && !isMode(mode)) {
    return fail("invalid_mode", `mode must be one of: ${MODES.join(", ")}`);
  }
  return { ok: true, input: { question: trimmed, mode: mode ?? DEFAULT_MODE } };
}

function fail(code: InputErrorCode, message: string): InputParseResult {
  return { ok: false, code, message };
}
