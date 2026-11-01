/**
 * Follow a selected revision's index until it is ready or failed, with
 * growing intervals and a total limit. It only reads status; it never starts
 * a build or a question. After the limit the person decides to check again.
 */
import type { BrowserApi, RevisionState } from "./api";
import { abortableSleep } from "./ask-runner";

export const INDEX_WATCH_DELAYS_MS = [1_000, 2_000, 3_000, 5_000, 8_000, 13_000, 15_000] as const;
export const INDEX_WATCH_LIMIT_MS = 10 * 60_000;

export async function watchIndex(options: {
  readonly api: Pick<BrowserApi, "revision">;
  readonly revisionId: string;
  readonly signal: AbortSignal;
  readonly onState: (state: RevisionState) => void;
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  readonly limitMs?: number;
}): Promise<"settled" | "gave_up"> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? abortableSleep;
  const limit = options.limitMs ?? INDEX_WATCH_LIMIT_MS;
  const started = now();
  for (let attempt = 0; ; attempt += 1) {
    const delay = INDEX_WATCH_DELAYS_MS[Math.min(attempt, INDEX_WATCH_DELAYS_MS.length - 1)]!;
    if (now() - started + delay > limit) return "gave_up";
    await sleep(delay, options.signal);
    const state = await options.api.revision(options.revisionId, options.signal);
    if (options.signal.aborted) return "settled";
    if (state.revision.id !== options.revisionId) return "settled";
    options.onState(state);
    if (state.index.state === "ready" || state.index.state === "failed") return "settled";
  }
}
