/**
 * Parse model replies. Model output is untrusted: only known fields with the
 * expected types are kept, and anything else is discarded.
 */
import { ANSWER_OUTCOMES, type AnswerOutcome } from "../contract/response";
import { EVIDENCE_KINDS, type EvidenceKind, type RetrievalOptions } from "../contract/ports";
import type { FollowUpRequest } from "../retrieval/research";

export type Rationale = "not_asked" | "documented" | "unknown";

export interface DraftAnswer {
  readonly outcome: AnswerOutcome;
  readonly answer: string;
  readonly caveats: readonly string[];
  readonly rationale: Rationale;
  readonly humanQuestion?: string;
}

export class ModelOutputError extends Error {
  override readonly name = "ModelOutputError";
}

/** The JSON object in a reply, tolerating code fences and text around it. */
export function extractJson(text: string): Record<string, unknown> {
  const unfenced = text.replace(/^\s*```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new ModelOutputError("The model reply has no JSON object");
  let value: unknown;
  try {
    value = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    throw new ModelOutputError("The model reply is not valid JSON");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ModelOutputError("The model reply is not a JSON object");
  }
  return value as Record<string, unknown>;
}

function shortStrings(value: unknown, max: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .slice(0, max)
    .map((item) => item.slice(0, maxLength));
}

export function parseDraft(value: Record<string, unknown>): DraftAnswer {
  const answer = typeof value.answer === "string" ? value.answer.trim() : "";
  if (answer.length === 0) throw new ModelOutputError("The model reply has no answer text");
  const outcome = (ANSWER_OUTCOMES as readonly unknown[]).includes(value.outcome)
    ? (value.outcome as AnswerOutcome)
    : "partial";
  const rationale: Rationale =
    value.rationale === "documented" || value.rationale === "unknown"
      ? value.rationale
      : "not_asked";
  const humanQuestion =
    typeof value.humanQuestion === "string" && value.humanQuestion.trim().length > 0
      ? value.humanQuestion.trim().slice(0, 500)
      : undefined;
  return {
    outcome,
    answer,
    caveats: shortStrings(value.caveats, 6, 400),
    rationale,
    ...(humanQuestion !== undefined ? { humanQuestion } : {}),
  };
}

export function parseAnswerReply(text: string): DraftAnswer {
  return parseDraft(extractJson(text));
}

export type CheckReply =
  | { readonly verdict: "ok" }
  | {
      readonly verdict: "revised";
      readonly draft: DraftAnswer;
      readonly issues: readonly string[];
    };

export function parseCheckReply(text: string): CheckReply {
  const value = extractJson(text);
  if (value.verdict === "ok" && typeof value.answer !== "string") return { verdict: "ok" };
  return {
    verdict: "revised",
    draft: parseDraft(value),
    issues: shortStrings(value.issues, 8, 300),
  };
}

const IDENTIFIER = /^[A-Za-z_$][\w$.-]{0,127}$/;

function hasControl(text: string): boolean {
  for (const char of text) if (char.charCodeAt(0) < 0x20 || char === "\x7f") return true;
  return false;
}

function safePathPrefix(path: string): boolean {
  if (path.length === 0 || path.length > 300 || path.startsWith("/") || path.includes("\\")) {
    return false;
  }
  return path
    .replace(/\/+$/, "")
    .split("/")
    .every((part) => part !== "" && part !== "." && part !== ".." && !hasControl(part));
}

/**
 * Follow-up searches from a planner reply. Only search fields survive: the
 * planner cannot request reads, writes, commands, URLs or other repositories.
 */
export function parsePlanReply(text: string, maxFollowUps: number): FollowUpRequest[] {
  const value = extractJson(text);
  if (!Array.isArray(value.followUps)) return [];
  const requests: FollowUpRequest[] = [];
  for (const raw of value.followUps) {
    if (requests.length >= maxFollowUps) break;
    if (typeof raw !== "object" || raw === null) continue;
    const item = raw as Record<string, unknown>;
    const query = typeof item.query === "string" ? item.query.trim().slice(0, 200) : "";
    if (query.length === 0) continue;
    const options: {
      definitionOf?: string;
      referencesOf?: string;
      kinds?: EvidenceKind[];
      pathPrefix?: string;
    } = {};
    if (typeof item.definitionOf === "string" && IDENTIFIER.test(item.definitionOf.trim())) {
      options.definitionOf = item.definitionOf.trim();
    } else if (typeof item.referencesOf === "string" && IDENTIFIER.test(item.referencesOf.trim())) {
      options.referencesOf = item.referencesOf.trim();
    }
    const kinds = Array.isArray(item.kinds)
      ? item.kinds.filter((kind): kind is EvidenceKind =>
          (EVIDENCE_KINDS as readonly unknown[]).includes(kind),
        )
      : [];
    if (kinds.length > 0) options.kinds = [...new Set(kinds)];
    if (typeof item.path === "string" && safePathPrefix(item.path.trim())) {
      options.pathPrefix = item.path.trim();
    }
    const reason =
      typeof item.reason === "string" && item.reason.trim().length > 0
        ? `follow-up: ${item.reason.trim().slice(0, 160)}`
        : `follow-up: ${query}`;
    requests.push({
      query,
      reason,
      ...(Object.keys(options).length > 0 ? { options: options as RetrievalOptions } : {}),
    });
  }
  return requests;
}
