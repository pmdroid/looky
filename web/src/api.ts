/**
 * Typed client for Looky's same-origin browser API at `/browser/v1`.
 *
 * The CSRF token lives only in this object's memory. Nothing here writes to
 * `localStorage`, `sessionStorage` or cookies; the session cookie is HttpOnly
 * and handled by the browser.
 */
import type { Mode } from "../../src/contract/input";
import type { AskProjectResponse, IndexProgress } from "../../src/contract/response";

export type { Mode };
export type { AskProjectResponse, IndexProgress };

export interface SessionState {
  readonly authenticated: boolean;
  readonly auth: "local" | "token";
  readonly csrfToken?: string;
  readonly expiresAt?: string;
  readonly expired?: boolean;
}

export interface RefChoice {
  readonly kind: "branch" | "tag";
  readonly name: string;
  readonly sha: string;
}

export interface RefListing {
  readonly repositoryId: string;
  readonly head?: { readonly sha: string; readonly branch?: string };
  readonly refs: readonly RefChoice[];
  readonly truncated: boolean;
}

export type IndexState = "not_indexed" | "building" | "ready" | "failed";

export interface IndexView {
  readonly repositoryId: string;
  readonly sha: string;
  readonly state: IndexState;
  readonly ready?: { readonly buildId: string; readonly sha: string };
  readonly active?: {
    readonly buildId: string;
    readonly state: string;
    readonly progress: IndexProgress;
  };
  readonly failure?: {
    readonly buildId: string;
    readonly code: string | null;
    readonly retryable: boolean;
  };
}

export interface RevisionView {
  readonly id: string;
  readonly repositoryId: string;
  readonly sha: string;
  readonly ref?: string;
  readonly selectedAt: string;
  readonly active: boolean;
}

export interface RevisionState {
  readonly revision: RevisionView;
  readonly index: IndexView;
}

export interface QuestionView {
  readonly id: string;
  readonly clientRequestId: string;
  readonly revisionId: string;
  readonly repositoryId: string;
  readonly sha: string;
  readonly mode: Mode;
  readonly state: "running" | "completed";
  readonly submittedAt: string;
  readonly completedAt?: string;
  readonly response?: AskProjectResponse;
  /** One code host link or null per evidence reference, from Looky's configured template. */
  readonly sourceLinks?: readonly (string | null)[];
  readonly cancelRequested?: boolean;
}

export interface SubmitBody {
  readonly revisionId: string;
  readonly question: string;
  readonly mode: Mode;
  readonly clientRequestId: string;
}

/** A failed API call. `status` 0 means the request never got an HTTP response. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }

  /** Worth sending again unchanged: no response, or a gateway that did not reach Looky. */
  get transient(): boolean {
    return this.status === 0 || this.status === 502 || this.status === 504;
  }
}

export function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error as { name: unknown }).name === "AbortError"
  );
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

interface CallOptions {
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  /** Let the request outlive the page, for a cancel sent while leaving. */
  readonly keepalive?: boolean;
}

export class BrowserApi {
  #csrf: string | undefined;
  readonly #fetch: Fetch;
  readonly #base: string;

  constructor(fetchImpl?: Fetch, base = "/browser/v1") {
    this.#fetch = fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
    this.#base = base;
  }

  /** Forget the CSRF token, for example after the session expired. */
  forget(): void {
    this.#csrf = undefined;
  }

  async #call<T>(method: string, path: string, options: CallOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (method !== "GET" && this.#csrf) headers["x-looky-csrf"] = this.#csrf;
    if (options.body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.#fetch(`${this.#base}${path}`, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.keepalive ? { keepalive: true } : {}),
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ApiError(0, "network", "Looky could not be reached. Check the connection.");
    }
    if (response.status === 204) return undefined as T;
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (isAbort(error)) throw error;
      throw new ApiError(response.status, "bad_response", "Looky sent an unreadable response.");
    }
    if (!response.ok) {
      const failure = (payload as { error?: { code?: unknown; message?: unknown } })?.error;
      throw new ApiError(
        response.status,
        typeof failure?.code === "string" ? failure.code : "http_error",
        typeof failure?.message === "string"
          ? failure.message
          : `Request failed (${response.status})`,
      );
    }
    return payload as T;
  }

  async session(): Promise<SessionState> {
    const state = await this.#call<SessionState>("GET", "/session");
    this.#csrf = state.authenticated ? state.csrfToken : undefined;
    return state;
  }

  async signIn(token?: string): Promise<SessionState> {
    const state = await this.#call<SessionState>("POST", "/session", {
      body: token === undefined ? {} : { token },
    });
    this.#csrf = state.csrfToken;
    return state;
  }

  async signOut(): Promise<void> {
    try {
      await this.#call<void>("DELETE", "/session");
    } finally {
      this.#csrf = undefined;
    }
  }

  repositories(signal?: AbortSignal): Promise<{ repositories: { id: string }[] }> {
    return this.#call("GET", "/repositories", { signal });
  }

  refs(repositoryId: string, signal?: AbortSignal): Promise<RefListing> {
    return this.#call("GET", `/repositories/${encodeURIComponent(repositoryId)}/refs`, { signal });
  }

  selectRevision(repositoryId: string, ref: string, signal?: AbortSignal): Promise<RevisionState> {
    return this.#call("POST", "/revisions", { body: { repositoryId, ref }, signal });
  }

  revision(id: string, signal?: AbortSignal): Promise<RevisionState> {
    return this.#call("GET", `/revisions/${encodeURIComponent(id)}`, { signal });
  }

  submit(body: SubmitBody, signal?: AbortSignal): Promise<QuestionView> {
    return this.#call("POST", "/questions", { body, signal });
  }

  observe(id: string, waitMs: number, signal?: AbortSignal): Promise<QuestionView> {
    return this.#call("GET", `/questions/${encodeURIComponent(id)}?waitMs=${waitMs}`, { signal });
  }

  cancel(id: string, keepalive = false): Promise<QuestionView> {
    return this.#call("POST", `/questions/${encodeURIComponent(id)}/cancel`, {
      body: {},
      keepalive,
    });
  }
}
