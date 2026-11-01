/**
 * Bounded admission: at most `slots` holders at once, at most `maxQueued`
 * waiters, and every wait ends by a deadline. A request that cannot be
 * admitted gets a refusal it can report, never an unbounded wait, so a
 * caller that holds its own only runner slot cannot deadlock on Looky.
 */
export type AdmissionResult =
  | { readonly admitted: true; release(): void }
  | { readonly admitted: false; readonly reason: "queue_full" | "timeout" };

interface Waiter {
  grant(): void;
}

export class Admission {
  #active = 0;
  readonly #queue: Waiter[] = [];

  constructor(
    readonly slots: number,
    readonly maxQueued: number,
  ) {
    if (!Number.isSafeInteger(slots) || slots < 1) throw new Error("slots must be positive");
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new Error("maxQueued must be non-negative");
    }
  }

  get active(): number {
    return this.#active;
  }

  get queued(): number {
    return this.#queue.length;
  }

  /**
   * Take a slot, waiting at most `waitMs`. Rejects with the signal's reason
   * when it aborts while waiting; the place in the queue is given up.
   */
  acquire(waitMs: number, signal: AbortSignal): Promise<AdmissionResult> {
    signal.throwIfAborted();
    if (this.#active < this.slots && this.#queue.length === 0) {
      this.#active += 1;
      return Promise.resolve(this.#granted());
    }
    if (this.#queue.length >= this.maxQueued || waitMs <= 0) {
      return Promise.resolve({
        admitted: false,
        reason: this.#queue.length >= this.maxQueued ? "queue_full" : "timeout",
      });
    }
    return new Promise<AdmissionResult>((resolve, reject) => {
      const leave = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        const index = this.#queue.indexOf(waiter);
        if (index !== -1) this.#queue.splice(index, 1);
      };
      const waiter: Waiter = {
        grant: () => {
          leave();
          resolve(this.#granted());
        },
      };
      const onAbort = () => {
        leave();
        reject(signal.reason);
      };
      const timer = setTimeout(() => {
        leave();
        resolve({ admitted: false, reason: "timeout" });
      }, waitMs);
      signal.addEventListener("abort", onAbort, { once: true });
      this.#queue.push(waiter);
    });
  }

  #granted(): AdmissionResult {
    let released = false;
    return {
      admitted: true,
      release: () => {
        if (released) return;
        released = true;
        const next = this.#queue[0];
        // Hand the slot straight to the next waiter so no newcomer can overtake it.
        if (next) next.grant();
        else this.#active -= 1;
      },
    };
  }
}
