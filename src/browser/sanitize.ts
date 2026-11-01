/**
 * What of a service result a browser may see.
 *
 * An answered response is passed through whole: answer text, evidence,
 * revision, index identity, scope, usage and provider ids. Every other status
 * keeps its typed fields (status, code, stage, reason, retryability, build id,
 * progress, budgets) but its free-form message is replaced by a fixed text.
 * Messages built inside Looky can carry provider error text, file system
 * paths, session ids or client ids, and none of that belongs in a browser.
 */
import type { AskProjectResponse, DeniedReason } from "../contract/response";
import type { IndexView } from "../service/looky-service";

const DENIED: Record<DeniedReason, string> = {
  unauthorized: "This browser session may not ask about this revision.",
  revoked: "This revision selection ended; choose the revision again.",
  stale_session: "A newer selection replaced this one; ask again with the current revision.",
  invalid_context: "Looky could not establish a valid context for this revision.",
};

const UNAVAILABLE: Record<string, string> = {
  busy: "Looky is answering other questions. Retry shortly.",
  session_limit: "Too many questions are running for this revision. Wait for one to finish.",
  fetching_revision: "The commit is still being fetched to the Looky host. Retry shortly.",
};

const FAILED: Record<string, string> = {
  index_failed: "Indexing this revision failed.",
  budget_exhausted: "The research budget ran out before an answer was produced.",
  provider_not_configured: "No usable model provider is configured for this Looky service.",
};

/** Fixed limitation strings Looky writes for these statuses; others are dropped. */
const KEEP_LIMITATIONS = new Set<AskProjectResponse["status"]>([
  "answered",
  "indexing",
  "cancelled",
  "unavailable",
]);

/** Input validation codes whose messages Looky writes from fixed templates. */
const SAFE_INPUT_CODES = new Set([
  "not_an_object",
  "unexpected_argument",
  "question_missing",
  "question_empty",
  "question_too_long",
  "invalid_mode",
  "request_key_reused",
]);

export function browserResponse(response: AskProjectResponse): AskProjectResponse {
  const limitations =
    KEEP_LIMITATIONS.has(response.status) ||
    (response.status === "failed" && response.code === "budget_exhausted")
      ? response.limitations
      : [];
  switch (response.status) {
    case "answered":
    case "indexing":
    case "cancelled":
    case "timed_out":
      return { ...response, limitations };
    case "invalid_request":
      return {
        ...response,
        limitations,
        error: SAFE_INPUT_CODES.has(response.error.code)
          ? response.error
          : { code: "invalid_request", message: "The question could not be accepted." },
      };
    case "denied":
      return { ...response, limitations, message: DENIED[response.reason] };
    case "unsupported_revision":
      return {
        ...response,
        limitations,
        message: "This revision is not a commit Looky can read in this repository.",
      };
    case "unavailable":
      return {
        ...response,
        limitations,
        message:
          (response.code && UNAVAILABLE[response.code]) ??
          "Looky cannot answer right now. Retry later.",
      };
    case "failed":
      return {
        ...response,
        limitations,
        message: FAILED[response.code] ?? "Looky could not produce an answer for this question.",
      };
  }
}

/** Index status without build failure messages, which may name host paths. */
export function browserIndex(view: IndexView): IndexView {
  if (!view.failure) return view;
  return { ...view, failure: { ...view.failure, message: null } };
}
