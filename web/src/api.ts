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
  /** The wiki page this question is about, at the same commit as the answer. */
  readonly wikiPage?: {
    readonly generationId: string;
    readonly pageId: string;
    readonly slug: string;
    readonly title: string;
    readonly sha: string;
  };
}

export interface SubmitBody {
  readonly revisionId: string;
  readonly question: string;
  readonly mode: Mode;
  readonly clientRequestId: string;
  /** Ask about a wiki page. Looky resolves it and refuses a page of another commit. */
  readonly wikiPage?: { readonly generationId: string; readonly pageId: string };
}

// ---------------------------------------------------------------------------
// Generated wiki

export type WikiGenerationState = "queued" | "running" | "ready" | "failed" | "cancelled";
export type WikiPageState = "unavailable" | "queued" | "running" | "ready" | "failed" | "cancelled";
export type WikiPageKind = "overview" | "architecture" | "section" | "module" | "workflow";

export interface WikiGenerationView {
  readonly id: string;
  readonly repositoryId: string;
  readonly sha: string;
  readonly state: WikiGenerationState;
  readonly pageCount: number;
  /** Pages per state, for a generation being written. */
  readonly pages?: Readonly<Partial<Record<WikiPageState, number>>>;
  /** True when this is the wiki served now for its commit. */
  readonly current?: boolean;
  readonly retired: boolean;
  readonly errorCode: string | null;
  readonly retryable: boolean | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly usage?: Readonly<Record<string, number>>;
}

export interface WikiStatusView {
  readonly revisionId: string;
  readonly repositoryId: string;
  readonly sha: string;
  readonly state: "unavailable" | WikiGenerationState;
  readonly ready?: WikiGenerationView;
  readonly active?: WikiGenerationView;
  readonly latest?: WikiGenerationView;
  /** A wiki of another commit or configuration. Never current; select its commit to read it. */
  readonly stale?: {
    readonly generation: WikiGenerationView;
    readonly reasons: readonly ("revision" | "index" | "configuration")[];
  };
}

export type WikiStartView =
  | { readonly state: "ready"; readonly generation: WikiGenerationView }
  | {
      readonly state: "queued" | "running";
      readonly created: boolean;
      readonly generation: WikiGenerationView;
    }
  | { readonly state: "indexing"; readonly index: { buildId: string; progress: IndexProgress } }
  | {
      readonly state: "index_failed";
      readonly index: { buildId: string; code: string | null; retryable: boolean };
    }
  | { readonly state: "unsupported_revision" };

export type WikiStartReply = WikiStartView & {
  readonly revisionId: string;
  readonly wiki: WikiStatusView;
};

export interface WikiPageMeta {
  readonly pageId: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: WikiPageKind;
  readonly description: string;
  readonly parentPageId: string | null;
  readonly depth: number;
  readonly ordinal: number;
  readonly scopePath: string | null;
  readonly state: WikiPageState;
  readonly unavailableReason: string | null;
}

export interface WikiTocEntry {
  readonly pageId: string;
  readonly slug: string;
  readonly title: string;
  readonly kind: WikiPageKind;
  readonly state: WikiPageState;
  readonly unavailableReason: string | null;
  readonly description: string;
  readonly children: readonly WikiTocEntry[];
}

export interface WikiIndexView {
  readonly revisionId: string;
  readonly generation: WikiGenerationView;
  /** Generated documentation is context, not source evidence. */
  readonly notice: string;
  readonly toc: WikiTocEntry;
  readonly pages: readonly WikiPageMeta[];
  readonly truncated: boolean;
  readonly links: readonly {
    readonly fromPageId: string;
    readonly toPageId: string;
    readonly relation: "uses" | "related";
  }[];
  readonly report: unknown;
}

export interface WikiSourceView {
  readonly path: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly kind: "code" | "test" | "config" | "docs";
  /** Code host link at the page's commit, from Looky's template, or null. */
  readonly link: string | null;
}

export interface WikiPageView {
  readonly revisionId: string;
  readonly generation: WikiGenerationView;
  readonly notice: string;
  /** The requested slug when it was renamed; `page.slug` is the current one. */
  readonly redirectedFrom?: string;
  readonly page: WikiPageMeta;
  /** Markdown without HTML. Only `wiki:` links to ready pages and cited source links remain. */
  readonly body?: {
    readonly format: "markdown";
    readonly html: false;
    readonly markdown: string;
    readonly generatedAt: string;
  };
  readonly headings: readonly { level: number; text: string; anchor: string }[];
  readonly pageLinks: readonly { slug: string; pageId: string; title: string }[];
  readonly citations: readonly WikiSourceView[];
  readonly plannedSources: readonly WikiSourceView[];
}

export interface WikiSearchView {
  readonly revisionId: string;
  /** Documentation search over generated pages, not raw-source retrieval. */
  readonly kind: "docs";
  readonly notice: string;
  readonly generation: WikiGenerationView;
  readonly query: string;
  readonly offset: number;
  readonly limit: number;
  readonly total: number;
  readonly totalCapped: boolean;
  readonly nextOffset?: number;
  readonly hits: readonly {
    readonly pageId: string;
    readonly slug: string;
    readonly title: string;
    readonly kind: WikiPageKind;
    readonly heading: string | null;
    readonly anchor: string | null;
    /** Plain text; `match` marks the matched words. Never HTML. */
    readonly snippet: readonly { text: string; match: boolean }[];
  }[];
}

export interface WikiCancelView {
  readonly generationId: string;
  readonly cancelled: boolean;
  readonly wiki: WikiStatusView;
}

/** A failed API call. `status` 0 means the request never got an HTTP response. */
export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Typed fields of the error, such as the commit of a wiki of another revision. */
    readonly details?: Readonly<Record<string, unknown>>,
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
      const failure = (
        payload as { error?: { code?: unknown; message?: unknown; details?: unknown } }
      )?.error;
      const details =
        typeof failure?.details === "object" && failure.details !== null
          ? (failure.details as Record<string, unknown>)
          : undefined;
      throw new ApiError(
        response.status,
        typeof failure?.code === "string" ? failure.code : "http_error",
        typeof failure?.message === "string"
          ? failure.message
          : `Request failed (${response.status})`,
        details,
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

  #wiki(revisionId: string, rest = ""): string {
    return `/revisions/${encodeURIComponent(revisionId)}/wiki${rest}`;
  }

  wikiStatus(revisionId: string, signal?: AbortSignal): Promise<WikiStatusView> {
    return this.#call("GET", this.#wiki(revisionId), { signal });
  }

  /** Start or join generation. Costs model calls; call only on an explicit request. */
  wikiGenerate(revisionId: string, signal?: AbortSignal): Promise<WikiStartReply> {
    return this.#call("POST", this.#wiki(revisionId, "/generate"), { body: {}, signal });
  }

  wikiCancel(revisionId: string, generationId: string): Promise<WikiCancelView> {
    return this.#call(
      "POST",
      this.#wiki(revisionId, `/generations/${encodeURIComponent(generationId)}/cancel`),
      { body: {} },
    );
  }

  /** A new attempt after a failed or cancelled generation. Explicit only; never automatic. */
  wikiRetry(revisionId: string, generationId: string): Promise<WikiStartReply> {
    return this.#call(
      "POST",
      this.#wiki(revisionId, `/generations/${encodeURIComponent(generationId)}/retry`),
      { body: {} },
    );
  }

  wikiIndex(
    revisionId: string,
    generationId: string,
    signal?: AbortSignal,
  ): Promise<WikiIndexView> {
    return this.#call(
      "GET",
      this.#wiki(revisionId, `/generations/${encodeURIComponent(generationId)}`),
      { signal },
    );
  }

  wikiPage(
    revisionId: string,
    generationId: string,
    slug: string,
    signal?: AbortSignal,
  ): Promise<WikiPageView> {
    const path = slug.split("/").map(encodeURIComponent).join("/");
    return this.#call(
      "GET",
      this.#wiki(revisionId, `/generations/${encodeURIComponent(generationId)}/pages/${path}`),
      { signal },
    );
  }

  wikiSearch(
    revisionId: string,
    generationId: string,
    query: { readonly q: string; readonly limit?: number; readonly offset?: number },
    signal?: AbortSignal,
  ): Promise<WikiSearchView> {
    const params = new URLSearchParams({ q: query.q });
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.offset !== undefined) params.set("offset", String(query.offset));
    return this.#call(
      "GET",
      this.#wiki(
        revisionId,
        `/generations/${encodeURIComponent(generationId)}/search?${params.toString()}`,
      ),
      { signal },
    );
  }
}
