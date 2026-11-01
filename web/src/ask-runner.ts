/**
 * One question at a time, from submission to a typed result.
 *
 * - Every run holds a snapshot of its question, mode, repository, revision
 *   selection and SHA. A result is shown only while its run is current and
 *   only if it names that same selection and SHA.
 * - A second `ask` while a run is active is refused, so a double click or a
 *   repeated Enter never pays for research twice. A network retry of the same
 *   submission reuses its `clientRequestId`, which Looky deduplicates.
 * - `detach` (new selection, leaving the page) stops the run silently and
 *   cancels its question; `cancel` does the same visibly. A detached run never
 *   reports again, so a late response cannot replace a newer answer.
 * - All waiting is bounded: long polls are limited in number, transient
 *   failures are retried a few times, and an `indexing` result is followed by
 *   readiness checks at the server's `retryAfterMs` within a total limit.
 *   An `indexing` result means no research ran, so asking again once the
 *   index is ready is the same question, not a paid retry. Every other retry,
 *   and any switch to Deep, is left to the person.
 */
import {
  ApiError,
  isAbort,
  type AskProjectResponse,
  type BrowserApi,
  type IndexProgress,
  type Mode,
  type QuestionView,
  type RevisionState,
} from "./api";

export interface AskSnapshot {
  readonly question: string;
  readonly mode: Mode;
  readonly repositoryId: string;
  readonly sha: string;
  readonly revisionId: string;
  readonly ref?: string;
}

export type AskState =
  | { readonly kind: "idle" }
  /** Sent to Looky, not yet acknowledged. */
  | { readonly kind: "submitting"; readonly snapshot: AskSnapshot }
  /** Looky accepted it and is waiting for a slot, researching or writing. */
  | { readonly kind: "running"; readonly snapshot: AskSnapshot; readonly questionId: string }
  /** No index for this SHA yet; waiting for it before asking again. */
  | {
      readonly kind: "indexing";
      readonly snapshot: AskSnapshot;
      readonly progress?: IndexProgress;
      readonly retryAfterMs: number;
    }
  | { readonly kind: "cancelling"; readonly snapshot: AskSnapshot }
  | { readonly kind: "cancelled"; readonly snapshot: AskSnapshot; readonly confirmed: boolean }
  | {
      readonly kind: "result";
      readonly snapshot: AskSnapshot;
      readonly response: AskProjectResponse;
      readonly sourceLinks: readonly (string | null)[];
      /** For `indexing`: the app stopped waiting at its limit. */
      readonly waitEnded?: boolean;
    }
  | {
      readonly kind: "error";
      readonly snapshot: AskSnapshot;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

export type AskApi = Pick<BrowserApi, "submit" | "observe" | "cancel" | "revision">;

export interface AskRunnerOptions {
  readonly api: AskApi;
  readonly onState: (state: AskState) => void;
  /** Index readiness seen while waiting for an index. */
  readonly onIndex?: (state: RevisionState) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly newRequestId?: () => string;
  /** One long poll's wait. Looky caps it at 25 seconds. */
  readonly pollWaitMs?: number;
  /** Long polls per submission before the app gives up and cancels. */
  readonly maxPolls?: number;
  /** Total time to wait for an index before handing the choice back. */
  readonly maxIndexWaitMs?: number;
  /** Retries of one call after a transient failure. */
  readonly maxTransientRetries?: number;
}

/** Bounds for following `retryAfterMs`. */
export const MIN_RETRY_AFTER_MS = 1_000;
export const MAX_RETRY_AFTER_MS = 15_000;

export function clampRetryAfter(ms: number | undefined): number {
  if (ms === undefined || !Number.isFinite(ms)) return 2_000;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(MIN_RETRY_AFTER_MS, Math.round(ms)));
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function newClientRequestId(): string {
  return `web_${crypto.randomUUID().replace(/-/g, "")}`;
}

interface Run {
  readonly snapshot: AskSnapshot;
  /** Aborts waits and polls. Submissions are never aborted, so a question is never orphaned. */
  readonly controller: AbortController;
  questionId?: string | undefined;
  stop?: "cancel" | "detach";
  keepalive?: boolean;
  /** Question id a cancel was already sent for. */
  cancelSent?: string;
}

class Stopped extends Error {}

class Mismatch extends Error {}

export class AskRunner {
  readonly #api: AskApi;
  readonly #onState: (state: AskState) => void;
  readonly #onIndex: ((state: RevisionState) => void) | undefined;
  readonly #now: () => number;
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly #newRequestId: () => string;
  readonly #pollWaitMs: number;
  readonly #maxPolls: number;
  readonly #maxIndexWaitMs: number;
  readonly #maxTransientRetries: number;
  #run: Run | undefined;

  constructor(options: AskRunnerOptions) {
    this.#api = options.api;
    this.#onState = options.onState;
    this.#onIndex = options.onIndex;
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#newRequestId = options.newRequestId ?? newClientRequestId;
    this.#pollWaitMs = options.pollWaitMs ?? 20_000;
    this.#maxPolls = options.maxPolls ?? 30;
    this.#maxIndexWaitMs = options.maxIndexWaitMs ?? 10 * 60_000;
    this.#maxTransientRetries = options.maxTransientRetries ?? 3;
  }

  /** Whether a question is being submitted, answered, waited for or cancelled. */
  get active(): boolean {
    return this.#run !== undefined;
  }

  /** Start a question. Refused (false) while another one is active. */
  ask(snapshot: AskSnapshot): boolean {
    if (this.#run) return false;
    const run: Run = { snapshot, controller: new AbortController() };
    this.#run = run;
    void this.#drive(run);
    return true;
  }

  /** Stop the current question visibly and ask Looky to cancel it. */
  cancel(): void {
    const run = this.#run;
    if (!run || run.stop) return;
    run.stop = "cancel";
    this.#emit(run, { kind: "cancelling", snapshot: run.snapshot });
    run.controller.abort();
  }

  /**
   * Stop the current question without reporting anything more about it, for
   * a new selection or when leaving the page. Its question is cancelled.
   * Always reports `idle`, also when the last question already finished.
   */
  detach(options: { keepalive?: boolean } = {}): void {
    const run = this.#run;
    if (!run) {
      // A finished question is cleared too, so its answer and its
      // snapshot-bound retry actions never outlive a new selection.
      this.#onState({ kind: "idle" });
      return;
    }
    this.#run = undefined;
    if (run.stop !== "cancel") run.stop = "detach";
    if (options.keepalive) run.keepalive = true;
    run.controller.abort();
    // Sent now, while the page is still here; otherwise the drive loop sends
    // it as soon as a pending submission returns the question id.
    if (run.questionId) void this.#sendCancel(run, run.questionId);
    this.#onState({ kind: "idle" });
  }

  #emit(run: Run, state: AskState): void {
    if (this.#run === run) this.#onState(state);
  }

  #finish(run: Run, state: AskState): void {
    if (this.#run !== run) return;
    this.#run = undefined;
    this.#onState(state);
  }

  #sendCancel(run: Run, questionId: string): Promise<QuestionView | undefined> {
    if (run.cancelSent === questionId) return Promise.resolve(undefined);
    run.cancelSent = questionId;
    return this.#api.cancel(questionId, run.keepalive ?? false).catch(() => undefined);
  }

  #checkView(run: Run, view: QuestionView): QuestionView {
    const { snapshot } = run;
    if (
      view.revisionId !== snapshot.revisionId ||
      view.repositoryId !== snapshot.repositoryId ||
      view.sha !== snapshot.sha ||
      view.mode !== snapshot.mode
    ) {
      throw new Mismatch("Looky returned a question for another selection.");
    }
    const response = view.response;
    if (response && "revision" in response && response.revision) {
      if (
        response.revision.repositoryId !== snapshot.repositoryId ||
        response.revision.sha !== snapshot.sha
      ) {
        throw new Mismatch("Looky returned a result for another revision.");
      }
    }
    if (response?.status === "answered" && response.index.sha !== snapshot.sha) {
      throw new Mismatch("Looky returned an answer from another index.");
    }
    return view;
  }

  /** Call again after a transient failure, a bounded number of times. */
  async #transient<T>(run: Run, call: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      if (run.stop) throw new Stopped();
      try {
        return await call();
      } catch (error) {
        if (run.stop || isAbort(error)) throw new Stopped();
        if (!(error instanceof ApiError) || !error.transient) throw error;
        if (attempt >= this.#maxTransientRetries) throw error;
        await this.#sleep(1_000 * 2 ** attempt, run.controller.signal);
      }
    }
  }

  async #drive(run: Run): Promise<void> {
    const { snapshot } = run;
    const signal = run.controller.signal;
    let indexWaitSince: number | undefined;
    try {
      for (;;) {
        const clientRequestId = this.#newRequestId();
        this.#emit(run, { kind: "submitting", snapshot });
        let view = await this.#transient(run, () =>
          this.#api.submit({
            revisionId: snapshot.revisionId,
            question: snapshot.question,
            mode: snapshot.mode,
            clientRequestId,
          }),
        );
        run.questionId = view.state === "running" ? view.id : undefined;
        if (run.stop) throw new Stopped();
        view = this.#checkView(run, view);

        let polls = 0;
        while (view.state === "running") {
          this.#emit(run, { kind: "running", snapshot, questionId: view.id });
          if (polls >= this.#maxPolls) {
            await this.#sendCancel(run, view.id);
            this.#finish(run, {
              kind: "error",
              snapshot,
              status: 0,
              code: "wait_limit",
              message:
                "Looky did not finish within the time this page waits. The question was cancelled.",
            });
            return;
          }
          polls += 1;
          const id = view.id;
          const next = await this.#transient(run, () =>
            this.#api.observe(id, this.#pollWaitMs, signal),
          );
          // A finished question needs no cancel, even if its result is discarded.
          if (next.state === "completed") run.questionId = undefined;
          view = this.#checkView(run, next);
        }
        run.questionId = undefined;
        const response = view.response;
        if (!response) throw new ApiError(0, "bad_response", "Looky sent no result.");
        if (response.status !== "indexing") {
          this.#finish(run, {
            kind: "result",
            snapshot,
            response,
            sourceLinks: view.sourceLinks ?? [],
          });
          return;
        }

        // No research ran. Wait for the index, then ask the same question once more.
        indexWaitSince ??= this.#now();
        let progress: IndexProgress | undefined = response.progress;
        const retryAfterMs = clampRetryAfter(response.retryAfterMs);
        for (;;) {
          if (this.#now() - indexWaitSince >= this.#maxIndexWaitMs) {
            this.#finish(run, {
              kind: "result",
              snapshot,
              response,
              sourceLinks: [],
              waitEnded: true,
            });
            return;
          }
          this.#emit(run, {
            kind: "indexing",
            snapshot,
            retryAfterMs,
            ...(progress ? { progress } : {}),
          });
          await this.#sleep(retryAfterMs, signal);
          const state = await this.#transient(run, () =>
            this.#api.revision(snapshot.revisionId, signal),
          );
          if (
            state.revision.sha !== snapshot.sha ||
            state.revision.repositoryId !== snapshot.repositoryId
          ) {
            throw new Mismatch("Looky reported another revision for this selection.");
          }
          if (this.#run === run) this.#onIndex?.(state);
          if (state.index.state !== "building") break;
          progress = state.index.active?.progress;
        }
      }
    } catch (error) {
      if (run.stop) {
        await this.#stopped(run);
        return;
      }
      if (error instanceof Stopped) return;
      if (run.questionId) await this.#sendCancel(run, run.questionId);
      this.#finish(run, {
        kind: "error",
        snapshot,
        status: error instanceof ApiError ? error.status : 0,
        code:
          error instanceof ApiError
            ? error.code
            : error instanceof Mismatch
              ? "mismatch"
              : "client_error",
        message:
          error instanceof ApiError || error instanceof Mismatch
            ? error.message
            : "Something went wrong in this page.",
      });
    }
  }

  /** After cancel or detach: cancel the question at Looky and report cancel only. */
  async #stopped(run: Run): Promise<void> {
    const id = run.questionId;
    const view = id ? await this.#sendCancel(run, id) : undefined;
    if (run.stop !== "cancel") return;
    // Finished before the cancel reached Looky: that result is still this question's.
    if (view && view.cancelRequested === false && view.response) {
      try {
        this.#checkView(run, view);
        if (view.response.status === "answered") {
          this.#finish(run, {
            kind: "result",
            snapshot: run.snapshot,
            response: view.response,
            sourceLinks: view.sourceLinks ?? [],
          });
          return;
        }
      } catch {
        // A mismatching result is never shown.
      }
    }
    // Unconfirmed only when a running question's cancel did not reach Looky.
    this.#finish(run, {
      kind: "cancelled",
      snapshot: run.snapshot,
      confirmed: id === undefined || view !== undefined,
    });
  }
}
