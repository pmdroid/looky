/**
 * What the screen says about a question's state, and which next actions it
 * offers. Pure, so every state and its actions are testable without a DOM.
 *
 * Actions that start new research (`retry`, `deep`) are only ever offered as
 * buttons; nothing here runs them. Fast never becomes Deep by itself.
 */
import type { AskProjectResponse, IndexProgress, IndexView, Mode, RefChoice } from "./api";
import type { AskState } from "./ask-runner";

export type Tone = "neutral" | "progress" | "success" | "warning" | "danger";

export type Action =
  /** Ask the same question in the same mode: new research, possibly paid. */
  | { readonly kind: "retry"; readonly label: string; readonly notBeforeMs?: number }
  /** Ask the same question in Deep: larger budget, chosen by the person. */
  | { readonly kind: "deep"; readonly label: string }
  /** Select the same repository and ref again, for an ended selection. */
  | { readonly kind: "reselect"; readonly label: string }
  /** Move focus to the question box to change the question. */
  | { readonly kind: "edit"; readonly label: string };

export interface StatusView {
  readonly tone: Tone;
  readonly title: string;
  readonly detail?: string;
  readonly busy: boolean;
  readonly actions: readonly Action[];
}

export const MODE_LABEL: Record<Mode, string> = { fast: "Fast", deep: "Deep" };

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

/**
 * The value a listed branch or tag is selected by. It is qualified, so a tag
 * that shares a name with a branch still resolves to the tag's commit.
 */
export function refValue(ref: RefChoice): string {
  return `${ref.kind === "branch" ? "refs/heads/" : "refs/tags/"}${ref.name}`;
}

/** A ref as people read it: `refs/heads/main` is `main`, `refs/tags/v1` is `v1 (tag)`. */
export function displayRef(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/tags/")) return `${ref.slice("refs/tags/".length)} (tag)`;
  if (/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ref)) return shortSha(ref);
  return ref;
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.max(0, Math.round(ms))} ms`;
  const seconds = Math.round(ms / 1_000);
  if (seconds < 120) return `${seconds} s`;
  return `${Math.round(seconds / 60)} min`;
}

/** Index progress in words, only from what Looky supplied. */
export function describeProgress(progress: IndexProgress | undefined): string | undefined {
  if (!progress) return undefined;
  const phase = progress.phase.replace(/_/g, " ");
  if (progress.filesDone !== undefined && progress.filesTotal !== undefined) {
    return `${phase}: ${progress.filesDone.toLocaleString()} of ${progress.filesTotal.toLocaleString()} files`;
  }
  if (progress.filesDone !== undefined) {
    return `${phase}: ${progress.filesDone.toLocaleString()} files so far`;
  }
  return phase;
}

export function describeIndex(index: IndexView): { tone: Tone; text: string; busy: boolean } {
  switch (index.state) {
    case "ready":
      return { tone: "success", text: "Index ready for this commit.", busy: false };
    case "building": {
      const progress = describeProgress(index.active?.progress);
      return {
        tone: "progress",
        text: progress ? `Indexing this commit (${progress}).` : "Indexing this commit.",
        busy: true,
      };
    }
    case "not_indexed":
      return {
        tone: "neutral",
        text: "Not indexed yet. Indexing starts for this commit and a question waits for it.",
        busy: false,
      };
    case "failed":
      return {
        tone: "danger",
        text:
          `Indexing failed${index.failure?.code ? ` (${index.failure.code})` : ""}. ` +
          (index.failure?.retryable
            ? "Asking a question starts a new attempt."
            : "Choose another revision or ask the Looky operator to rebuild it."),
        busy: false,
      };
  }
}

const OUTCOME: Record<
  Extract<AskProjectResponse, { status: "answered" }>["answer"]["outcome"],
  { label: string; detail: string; tone: Tone }
> = {
  supported: {
    label: "Supported",
    detail: "The cited evidence establishes this answer.",
    tone: "success",
  },
  partial: {
    label: "Partly answered",
    detail: "Some of the question is established; the answer says what is missing.",
    tone: "warning",
  },
  conflicting: {
    label: "Conflicting evidence",
    detail: "Sources at this revision disagree; the answer explains the conflict.",
    tone: "warning",
  },
  unknown: {
    label: "Not established",
    detail: "This revision does not establish an answer to the question.",
    tone: "warning",
  },
};

export function describeOutcome(
  outcome: Extract<AskProjectResponse, { status: "answered" }>["answer"]["outcome"],
) {
  return OUTCOME[outcome];
}

function deepOffer(mode: Mode, suggested: boolean): Action[] {
  return mode === "fast" && suggested ? [{ kind: "deep", label: "Ask in Deep" }] : [];
}

export function describeResponse(response: AskProjectResponse, waitEnded = false): StatusView {
  const mode = response.mode.requested;
  switch (response.status) {
    case "answered": {
      const outcome = OUTCOME[response.answer.outcome];
      return {
        tone: outcome.tone,
        title: `${MODE_LABEL[mode]} answer: ${outcome.label.toLowerCase()}`,
        busy: false,
        actions: deepOffer(mode, response.suggestedMode === "deep"),
      };
    }
    case "indexing":
      return {
        tone: "warning",
        title: "The index is still building",
        detail: waitEnded
          ? "This page stopped waiting for it. Nothing was researched yet, so asking again costs nothing until the index is ready."
          : "Nothing was researched yet.",
        busy: false,
        actions: [{ kind: "retry", label: "Keep waiting and ask" }],
      };
    case "invalid_request":
      return {
        tone: "danger",
        title: "The question was not accepted",
        detail: response.error.message,
        busy: false,
        actions: [{ kind: "edit", label: "Edit the question" }],
      };
    case "denied":
      return {
        tone: "danger",
        title: "Access denied",
        detail: response.message,
        busy: false,
        actions:
          response.reason === "revoked" || response.reason === "stale_session"
            ? [{ kind: "reselect", label: "Select the revision again" }]
            : [],
      };
    case "unsupported_revision":
      return {
        tone: "danger",
        title: "Looky cannot read this revision",
        detail: `${response.message} Choose another branch, tag or commit.`,
        busy: false,
        actions: [],
      };
    case "failed":
      return {
        tone: "danger",
        title: response.stage === "index" ? "Indexing failed" : "No answer was produced",
        detail:
          response.message +
          (response.retryable ? " Asking again starts new research." : "") +
          (response.suggestedMode === "deep" && mode === "fast"
            ? " Deep has a larger research budget."
            : ""),
        busy: false,
        actions: [
          ...(response.retryable ? [{ kind: "retry", label: "Ask again" } as const] : []),
          ...deepOffer(mode, response.suggestedMode === "deep"),
        ],
      };
    case "unavailable":
      return {
        tone: "warning",
        title: response.code === "fetching_revision" ? "Fetching the commit" : "Looky is busy",
        detail:
          response.message +
          (response.retryAfterMs !== undefined
            ? ` Retry in about ${formatDuration(response.retryAfterMs)}.`
            : ""),
        busy: false,
        actions: [
          {
            kind: "retry",
            label: "Retry",
            ...(response.retryAfterMs !== undefined ? { notBeforeMs: response.retryAfterMs } : {}),
          },
        ],
      };
    case "cancelled":
      return {
        tone: "neutral",
        title: "Cancelled",
        detail: "Looky stopped this question. No answer is shown for it.",
        busy: false,
        actions: [{ kind: "retry", label: "Ask again" }],
      };
    case "timed_out":
      return {
        tone: "danger",
        title: "Timed out",
        detail:
          `Looky stopped after its ${formatDuration(response.limitMs)} limit for ${MODE_LABEL[mode]}. ` +
          "Asking again starts new research.",
        busy: false,
        actions: [{ kind: "retry", label: "Ask again" }, ...deepOffer(mode, true)],
      };
  }
}

export function describeAsk(state: AskState): StatusView | undefined {
  switch (state.kind) {
    case "idle":
      return undefined;
    case "submitting":
      return {
        tone: "progress",
        title: "Sending the question",
        busy: true,
        actions: [],
      };
    case "running":
      return {
        tone: "progress",
        title: `Working on the ${MODE_LABEL[state.snapshot.mode]} answer`,
        detail:
          "Looky may wait for a free slot, then researches the indexed code and writes the answer. " +
          "It arrives complete.",
        busy: true,
        actions: [],
      };
    case "indexing": {
      const progress = describeProgress(state.progress);
      return {
        tone: "progress",
        title: "Waiting for the index",
        detail:
          `${progress ? `${progress[0]!.toUpperCase()}${progress.slice(1)}. ` : ""}` +
          `The question is asked once the index is ready; checking every ${formatDuration(state.retryAfterMs)}.`,
        busy: true,
        actions: [],
      };
    }
    case "cancelling":
      return { tone: "neutral", title: "Cancelling", busy: true, actions: [] };
    case "cancelled":
      return {
        tone: "neutral",
        title: "Cancelled",
        detail: state.confirmed
          ? "No answer is shown for this question."
          : "Looky could not confirm the cancel; it stops questions nobody is waiting for within a minute.",
        busy: false,
        actions: [{ kind: "retry", label: "Ask again" }],
      };
    case "error":
      return describeError(state.status, state.code, state.message);
    case "result":
      return describeResponse(state.response, state.waitEnded);
  }
}

function describeError(status: number, code: string, message: string): StatusView {
  switch (code) {
    case "revision_not_found":
    case "selection_replaced":
      return {
        tone: "danger",
        title: "This revision selection ended",
        detail: "Select the revision again to keep asking.",
        busy: false,
        actions: [{ kind: "reselect", label: "Select the revision again" }],
      };
    case "too_many_questions":
      return {
        tone: "warning",
        title: "Too many questions",
        detail: message,
        busy: false,
        actions: [{ kind: "retry", label: "Retry", notBeforeMs: 5_000 }],
      };
    case "mismatch":
      return {
        tone: "danger",
        title: "Result discarded",
        detail: `${message} Nothing from it is shown.`,
        busy: false,
        actions: [{ kind: "retry", label: "Ask again" }],
      };
    case "wait_limit":
      return {
        tone: "danger",
        title: "Stopped waiting",
        detail: message,
        busy: false,
        actions: [{ kind: "retry", label: "Ask again" }],
      };
    default:
      return {
        tone: "danger",
        title: status === 0 ? "Connection problem" : "The request failed",
        detail: message,
        busy: false,
        actions: [{ kind: "retry", label: "Ask again" }],
      };
  }
}

/** One short sentence for the live region. */
export function announce(state: AskState): string {
  const view = describeAsk(state);
  return view ? `${view.title}.` : "";
}
