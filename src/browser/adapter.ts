/**
 * Looky's same-origin browser adapter. It lets a person sign in, choose an
 * authorized repository and committed revision, ask Fast or Deep questions,
 * watch the result and cancel, using the existing service flow only:
 *
 *   GET    /browser/v1/session                 sign-in state and the CSRF token
 *   POST   /browser/v1/session                 sign in (`{ token }` in token mode)
 *   DELETE /browser/v1/session                 sign out
 *   GET    /browser/v1/repositories            repositories this browser may use
 *   GET    /browser/v1/repositories/:id/refs   branches, tags and HEAD with SHAs
 *   POST   /browser/v1/revisions               resolve `{ repositoryId, ref }` once to a SHA
 *   GET    /browser/v1/revisions/:id           the selection and its index readiness
 *   POST   /browser/v1/questions               submit `{ revisionId, question, mode, clientRequestId }`
 *   GET    /browser/v1/questions/:id?waitMs=   the question, waiting up to `waitMs` for its result
 *   POST   /browser/v1/questions/:id/cancel    cancel this browser's question
 *
 * Generated wiki of a selected revision (all under `/browser/v1/revisions/:id/wiki`):
 *
 *   GET    …/wiki                              wiki status of exactly this commit
 *   POST   …/wiki/generate                     start or join generation (paid; explicit only)
 *   POST   …/wiki/generations/:gid/cancel      cancel a queued or running generation
 *   POST   …/wiki/generations/:gid/retry       new attempt after a failed or cancelled one
 *   GET    …/wiki/generations/:gid             navigation index of a published generation
 *   GET    …/wiki/generations/:gid/pages/:slug a page by slug; renamed slugs redirect in-body
 *   GET    …/wiki/generations/:gid/search?q=&limit=&offset=   documentation search
 *
 * A question about a page is an ordinary question with
 * `wikiPage: { generationId, pageId }`. Looky resolves the page and its
 * generation itself, refuses a page of another commit with
 * `wiki_revision_mismatch`, and asks the existing Fast or Deep pipeline about
 * the revision's own SHA with bounded hints from the page's metadata. The
 * page's prose is never sent as evidence.
 *
 * Wiki reads, search and generation controls re-check the revision selection
 * and the client's repository access on every request. A generation of
 * another repository is reported as missing; one of another commit than the
 * selection is a typed `wiki_revision_mismatch` naming its commit, so the
 * browser can select that commit explicitly instead of mixing revisions.
 *
 * Boundary:
 * - The browser acts as one configured client (`LOOKY_BROWSER_CLIENT`) and
 *   sees only that client's repositories. It sends repository ids and ref
 *   names, never paths or URLs.
 * - A browser session is an opaque random cookie, HttpOnly and
 *   SameSite=Strict, kept only in memory and expiring after its TTL. Every
 *   state-changing request needs an allowed Origin, a JSON body and the
 *   session's CSRF token. No CORS header is ever sent.
 * - Each selected revision registers an ordinary Looky session for the
 *   browser client, so index prewarm, fencing, admission, per-session limits,
 *   provider routing, coalescing and cancellation are the service's own. Its
 *   session token is never created for the browser and never leaves Looky.
 * - Results go through {@link browserResponse}: answers whole, every other
 *   outcome typed with a fixed message. An answered question also carries
 *   `sourceLinks`, one per evidence reference, built only from the configured
 *   source link template and the answer's own repository and SHA, so the app
 *   never has to derive a URL from answer text.
 * - Questions belong to the browser session that submitted them. Cancelling
 *   or abandoning one (no poll within `abandonAfterMs`) detaches only that
 *   caller; shared builds and other callers' questions continue.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SourceLinkBuilder } from "../answer/citations";
import type { Mode } from "../contract/input";
import type { AskProjectResponse } from "../contract/response";
import {
  clientMayUse,
  hashToken,
  type BrowserConfig,
  type ClientConfig,
  type RepositoryConfig,
} from "../service/config";
import { OperationError, type LookyService, type Principal } from "../service/looky-service";
import { RegistrationError } from "../service/sessions";
import { listRefs, resolveRevision } from "./revisions";
import { LookyUnavailableError } from "../contract/ports";
import { IndexAccessDeniedError } from "../indexing/index-service";
import type { WikiStartResult } from "../wiki/generator";
import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_OFFSET,
  parseSearchQuery,
} from "../wiki/search";
import type { WikiGenerationRecord, WikiPageRecord } from "../wiki/store";
import { browserIndex, browserResponse } from "./sanitize";
import {
  composePageQuestion,
  generationView,
  type PageTargets,
  pageHints,
  wikiIndexView,
  wikiPageView,
  wikiSearchView,
  wikiStatusView,
} from "./wiki";

export const BROWSER_PREFIX = "/browser/v1/";
export const CSRF_HEADER = "x-looky-csrf";

export interface BrowserLimits {
  /** Signed-in browser sessions kept at once; the oldest is signed out beyond this. */
  readonly maxSessions: number;
  /** Revision selections per browser session; the least recently used ends beyond this. */
  readonly maxRevisionsPerSession: number;
  /** Questions one browser session may have running. */
  readonly maxRunningPerSession: number;
  /** Questions, running or finished, kept per browser session. */
  readonly maxRetainedPerSession: number;
  /** How long a finished question's result can be read again. */
  readonly resultRetentionMs: number;
  /** A running question nobody polled for this long is cancelled as abandoned. */
  readonly abandonAfterMs: number;
  /** Longest wait one poll may ask for. */
  readonly maxWaitMs: number;
  /** Failed sign-ins accepted per minute before sign-in is refused for a while. */
  readonly signInFailuresPerMinute: number;
}

export const DEFAULT_BROWSER_LIMITS: BrowserLimits = {
  maxSessions: 64,
  maxRevisionsPerSession: 8,
  maxRunningPerSession: 4,
  maxRetainedPerSession: 32,
  resultRetentionMs: 10 * 60 * 1000,
  abandonAfterMs: 45_000,
  maxWaitMs: 25_000,
  signInFailuresPerMinute: 10,
};

export interface BrowserAdapterOptions {
  readonly service: LookyService;
  readonly config: BrowserConfig;
  readonly client: ClientConfig;
  readonly repositories: ReadonlyMap<string, RepositoryConfig>;
  /** Origins of this server itself when it listens on loopback. */
  readonly localOrigins: readonly string[];
  readonly limits?: Partial<BrowserLimits>;
  readonly now?: () => number;
  /** Code host links for cited ranges, from `LOOKY_SOURCE_LINK_TEMPLATE`. */
  readonly sourceLink?: SourceLinkBuilder;
  /** Longest question the service accepts. Default: the service's own limit. */
  readonly maxQuestionChars?: number;
}

/** The wiki page a question is about, resolved by Looky, never by the browser. */
interface PageContext {
  readonly generationId: string;
  readonly pageId: string;
  readonly slug: string;
  readonly title: string;
  readonly repositoryId: string;
  readonly sha: string;
}

interface BrowserRevision {
  readonly id: string;
  readonly repositoryId: string;
  readonly sha: string;
  readonly ref?: string;
  readonly slot: number;
  readonly lookySessionId: string;
  readonly principal: Principal;
  readonly createdAt: number;
  lastUsed: number;
}

interface BrowserQuestion {
  readonly id: string;
  readonly clientRequestId: string;
  readonly revisionId: string;
  readonly repositoryId: string;
  readonly sha: string;
  readonly mode: Mode;
  readonly fingerprint: string;
  readonly controller: AbortController;
  readonly submittedAt: number;
  readonly settled: Promise<void>;
  readonly page?: PageContext;
  lastSeenAt: number;
  watchers: number;
  result?: AskProjectResponse;
  completedAt?: number;
}

interface BrowserSession {
  /** Public id used in the Looky sessions registered for it. Never a credential. */
  readonly id: string;
  /** SHA-256 of the cookie value; the value itself is not kept. */
  readonly key: string;
  readonly csrf: string;
  readonly expiresAt: number;
  readonly revisions: Map<string, BrowserRevision>;
  readonly questions: Map<string, BrowserQuestion>;
  /** Revision id holding each slot, reserved before registration starts. */
  readonly slots: (string | undefined)[];
  readonly sequences: number[];
  ended: boolean;
}

class BrowserError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Typed, browser-safe fields that let the app act, such as the other commit. */
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

const COOKIE = "looky_browser";
const SECURE_COOKIE = "__Host-looky_browser";
const MAX_BODY_BYTES = 64 * 1024;
const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const REPOSITORY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CANCEL_WAIT_MS = 5_000;
const GENERATION_ID = /^wiki_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PAGE_ID = /^[A-Za-z0-9_:.-]{1,200}$/;
const WIKI_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;
const MAX_SLUG_CHARS = 200;

const SECURITY_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
};

export class BrowserAdapter {
  readonly #service: LookyService;
  readonly #config: BrowserConfig;
  readonly #client: ClientConfig;
  readonly #repositories: ReadonlyMap<string, RepositoryConfig>;
  readonly #limits: BrowserLimits;
  readonly #now: () => number;
  readonly #sourceLink: SourceLinkBuilder | undefined;
  readonly #maxQuestionChars: number;
  readonly #origins: ReadonlySet<string>;
  readonly #secureCookie: boolean;
  readonly #sessions = new Map<string, BrowserSession>();
  readonly #signInFailures: number[] = [];
  readonly #sweep: ReturnType<typeof setInterval>;

  constructor(options: BrowserAdapterOptions) {
    this.#service = options.service;
    this.#config = options.config;
    this.#client = options.client;
    this.#repositories = options.repositories;
    this.#limits = { ...DEFAULT_BROWSER_LIMITS, ...options.limits };
    this.#now = options.now ?? Date.now;
    this.#sourceLink = options.sourceLink;
    this.#maxQuestionChars = options.maxQuestionChars ?? options.service.maxQuestionChars;
    this.#origins = new Set([...options.config.origins, ...options.localOrigins]);
    this.#secureCookie = options.config.origins.some((origin) => origin.startsWith("https:"));
    const interval = Math.max(50, Math.min(5_000, Math.floor(this.#limits.abandonAfterMs / 3)));
    this.#sweep = setInterval(() => this.sweep(), interval);
    this.#sweep.unref?.();
  }

  async handle(request: Request, url: URL): Promise<Response> {
    try {
      return withHeaders(await this.#route(request, url));
    } catch (failure) {
      return withHeaders(errorResponse(failure));
    }
  }

  // -------------------------------------------------------------------------
  // Request checks

  #checkRequest(request: Request): void {
    if (this.#config.auth === "local") {
      // DNS rebinding: a page on another name resolving to 127.0.0.1 is refused.
      const host = request.headers.get("host") ?? "";
      if (![...this.#origins].some((origin) => new URL(origin).host === host)) {
        throw new BrowserError(403, "forbidden_host", "This host name may not reach Looky");
      }
    }
    const origin = request.headers.get("origin");
    const safe = request.method === "GET" || request.method === "HEAD";
    if (origin !== null ? !this.#origins.has(origin) : !safe) {
      throw new BrowserError(403, "forbidden_origin", "This origin may not call Looky");
    }
    const site = request.headers.get("sec-fetch-site");
    if (site !== null && site !== "same-origin" && site !== "none") {
      throw new BrowserError(403, "forbidden_origin", "Cross-site requests are refused");
    }
  }

  #checkCsrf(request: Request, session: BrowserSession): void {
    const given = Buffer.from(request.headers.get(CSRF_HEADER) ?? "");
    const expected = Buffer.from(session.csrf);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new BrowserError(403, "csrf_failed", "The request is missing a valid CSRF token");
    }
  }

  async #body(request: Request, keys: readonly string[]): Promise<Record<string, unknown>> {
    const type = request.headers.get("content-type") ?? "";
    if (!/^application\/json(?:\s*;|$)/i.test(type)) {
      throw new BrowserError(415, "unsupported_media_type", "Send a JSON body");
    }
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES)
      throw new BrowserError(413, "too_large", "Request body is too large");
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      throw new BrowserError(413, "too_large", "Request body is too large");
    }
    let value: unknown;
    try {
      value = text.trim() === "" ? {} : JSON.parse(text);
    } catch {
      throw new BrowserError(400, "invalid_json", "Request body is not valid JSON");
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new BrowserError(400, "invalid_request", "Request body must be an object");
    }
    const unexpected = Object.keys(value).filter((key) => !keys.includes(key));
    if (unexpected.length > 0) {
      // Names only, never values: an unexpected field may hold a credential.
      throw new BrowserError(
        400,
        "invalid_request",
        `Unsupported fields: ${unexpected.map((key) => key.slice(0, 40)).join(", ")}`,
      );
    }
    return value as Record<string, unknown>;
  }

  #cookieValue(request: Request): string | undefined {
    const name = this.#secureCookie ? SECURE_COOKIE : COOKIE;
    for (const part of (request.headers.get("cookie") ?? "").split(";")) {
      const [key, ...rest] = part.trim().split("=");
      if (key === name) return rest.join("=");
    }
    return undefined;
  }

  #lookup(request: Request): BrowserSession | "expired" | undefined {
    const value = this.#cookieValue(request);
    if (!value) return undefined;
    const key = digest(value);
    const session = this.#sessions.get(key);
    if (!session) return undefined;
    if (session.expiresAt <= this.#now()) {
      this.#end(session);
      return "expired";
    }
    return session;
  }

  #require(request: Request): BrowserSession {
    const found = this.#lookup(request);
    if (found === "expired") {
      throw new BrowserError(401, "session_expired", "The browser session expired; sign in again");
    }
    if (!found) throw new BrowserError(401, "unauthenticated", "Sign in first");
    if (request.method !== "GET" && request.method !== "HEAD") this.#checkCsrf(request, found);
    return found;
  }

  // -------------------------------------------------------------------------
  // Routes

  async #route(request: Request, url: URL): Promise<Response> {
    this.#checkRequest(request);
    const parts = url.pathname.slice(BROWSER_PREFIX.length).split("/").filter(Boolean);
    const method = request.method;
    const [resource, id, action] = parts;

    if (resource === "session" && parts.length === 1) {
      if (method === "GET") return this.#sessionState(request);
      if (method === "POST") return await this.#signIn(request);
      if (method === "DELETE") return this.#signOut(request);
    }
    const session = this.#require(request);
    if (resource === "repositories" && parts.length === 1 && method === "GET") {
      return Response.json({ repositories: this.#permitted().map((repo) => ({ id: repo })) });
    }
    if (resource === "repositories" && id && action === "refs" && parts.length === 3) {
      if (method === "GET") return await this.#refs(id, request.signal);
    }
    if (resource === "revisions" && parts.length === 1 && method === "POST") {
      return await this.#selectRevision(session, request);
    }
    if (resource === "revisions" && id && parts.length === 2 && method === "GET") {
      const revision = this.#revision(session, id);
      return Response.json(this.#revisionState(revision));
    }
    if (resource === "revisions" && id && action === "wiki") {
      return await this.#wikiRoute(session, id, parts.slice(3), request, url);
    }
    if (resource === "questions" && parts.length === 1 && method === "POST") {
      return await this.#submit(session, request);
    }
    if (resource === "questions" && id && parts.length === 2 && method === "GET") {
      return await this.#observe(session, id, url, request.signal);
    }
    if (resource === "questions" && id && action === "cancel" && parts.length === 3) {
      if (method === "POST") return await this.#cancel(session, id);
    }
    throw new BrowserError(404, "not_found", "No such browser route");
  }

  #sessionState(request: Request): Response {
    const found = this.#lookup(request);
    if (!found || found === "expired") {
      return Response.json({
        authenticated: false,
        auth: this.#config.auth,
        ...(found === "expired" ? { expired: true } : {}),
      });
    }
    return Response.json({
      authenticated: true,
      auth: this.#config.auth,
      csrfToken: found.csrf,
      expiresAt: new Date(found.expiresAt).toISOString(),
    });
  }

  async #signIn(request: Request): Promise<Response> {
    const body = await this.#body(request, this.#config.auth === "token" ? ["token"] : []);
    if (this.#config.auth === "token") {
      const now = this.#now();
      while (this.#signInFailures.length > 0 && this.#signInFailures[0]! <= now - 60_000) {
        this.#signInFailures.shift();
      }
      if (this.#signInFailures.length >= this.#limits.signInFailuresPerMinute) {
        throw new BrowserError(429, "too_many_attempts", "Too many failed sign-ins; wait a minute");
      }
      const token = body.token;
      const valid =
        typeof token === "string" &&
        token.length > 0 &&
        token.length <= 1024 &&
        timingSafeEqual(hashToken(token), this.#client.tokenHash);
      if (!valid) {
        this.#signInFailures.push(now);
        throw new BrowserError(401, "invalid_credentials", "Sign-in failed");
      }
    }
    const previous = this.#lookup(request);
    if (previous && previous !== "expired") this.#end(previous);
    while (this.#sessions.size >= this.#limits.maxSessions) {
      const oldest = [...this.#sessions.values()].sort((a, b) => a.expiresAt - b.expiresAt)[0]!;
      this.#end(oldest);
    }
    const value = randomBytes(32).toString("base64url");
    const session: BrowserSession = {
      id: `bs_${crypto.randomUUID()}`,
      key: digest(value),
      csrf: randomBytes(24).toString("base64url"),
      expiresAt: this.#now() + this.#config.sessionTtlMs,
      revisions: new Map(),
      questions: new Map(),
      slots: [],
      sequences: [],
      ended: false,
    };
    this.#sessions.set(session.key, session);
    const response = Response.json(
      {
        authenticated: true,
        auth: this.#config.auth,
        csrfToken: session.csrf,
        expiresAt: new Date(session.expiresAt).toISOString(),
      },
      { status: 201 },
    );
    response.headers.append(
      "set-cookie",
      this.#cookie(value, Math.floor(this.#config.sessionTtlMs / 1000)),
    );
    return response;
  }

  #signOut(request: Request): Response {
    const found = this.#lookup(request);
    if (found && found !== "expired") {
      this.#checkCsrf(request, found);
      this.#end(found);
    }
    const response = new Response(null, { status: 204 });
    response.headers.append("set-cookie", this.#cookie("", 0));
    return response;
  }

  #cookie(value: string, maxAge: number): string {
    const name = this.#secureCookie ? SECURE_COOKIE : COOKIE;
    return (
      `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` +
      (this.#secureCookie ? "; Secure" : "")
    );
  }

  #permitted(): string[] {
    return [...this.#repositories.keys()].filter((id) => clientMayUse(this.#client, id));
  }

  #repository(id: unknown): RepositoryConfig {
    const repository =
      typeof id === "string" && REPOSITORY_ID.test(id) && clientMayUse(this.#client, id)
        ? this.#repositories.get(id)
        : undefined;
    // Unknown and unauthorized repositories are refused alike.
    if (!repository) {
      throw new BrowserError(403, "repository_not_permitted", "This repository is not available");
    }
    return repository;
  }

  async #refs(id: string, signal: AbortSignal): Promise<Response> {
    const repository = this.#repository(id);
    try {
      return Response.json({
        repositoryId: repository.id,
        ...(await listRefs(repository, signal)),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      console.error(`looky: listing refs of ${repository.id} failed:`, errorText(error));
      throw new BrowserError(503, "repository_unavailable", "The repository cannot be read now");
    }
  }

  async #selectRevision(session: BrowserSession, request: Request): Promise<Response> {
    const body = await this.#body(request, ["repositoryId", "ref"]);
    const repository = this.#repository(body.repositoryId);
    if (typeof body.ref !== "string" || body.ref.length === 0) {
      throw new BrowserError(400, "invalid_ref", "ref must be a branch, tag, HEAD or full SHA");
    }
    let resolved;
    try {
      resolved = await resolveRevision(repository, body.ref, request.signal);
    } catch (error) {
      if (request.signal.aborted) throw error;
      console.error(`looky: resolving a ref of ${repository.id} failed:`, errorText(error));
      throw new BrowserError(503, "repository_unavailable", "The repository cannot be read now");
    }
    if (!resolved.ok) {
      throw resolved.code === "invalid_ref"
        ? new BrowserError(400, "invalid_ref", "ref must be a branch, tag, HEAD or full SHA")
        : new BrowserError(
            422,
            "unknown_revision",
            "No such committed revision in this repository",
          );
    }
    const { sha, ref } = resolved;

    for (const existing of session.revisions.values()) {
      if (
        existing.repositoryId === repository.id &&
        existing.sha === sha &&
        existing.ref === ref &&
        existing.principal.authorize().allowed
      ) {
        existing.lastUsed = this.#now();
        return Response.json(this.#revisionState(existing));
      }
    }

    const id = `rev_${crypto.randomUUID()}`;
    const slot = this.#reserveSlot(session, id);
    const sequence = (session.sequences[slot] ?? 0) + 1;
    session.sequences[slot] = sequence;
    let registered: Awaited<ReturnType<LookyService["registerSession"]>>;
    try {
      // The same registration an agent adapter makes. Its token stays here unused.
      registered = await this.#service.registerSession(this.#client, {
        taskId: `browser:${session.id}:${slot}`,
        sequence,
        clientGeneration: session.id,
        callerId: `browser:${session.id}`,
        repositoryId: repository.id,
        sha,
        ...(ref !== undefined ? { ref } : {}),
        // A browser asks about a commit; there is no worktree to disclose.
        worktree: { state: "clean" },
      });
    } catch (error) {
      if (session.slots[slot] === id) session.slots[slot] = undefined;
      if (error instanceof RegistrationError) {
        throw new BrowserError(409, "selection_failed", "This revision could not be selected");
      }
      throw error;
    }
    const record = this.#service.sessions.get(registered.session.id);
    if (session.ended || session.slots[slot] !== id || !record) {
      // Signed out or replaced while registering: end what was just registered.
      if (record) this.#revoke(record.id);
      throw new BrowserError(
        409,
        "selection_replaced",
        "This selection was replaced; choose again",
      );
    }
    const base = this.#service.principalFor(record, this.#client);
    const principal: Principal = {
      ...base,
      authorize: () =>
        !session.ended && session.expiresAt > this.#now()
          ? base.authorize()
          : { allowed: false, reason: "revoked", message: "The browser session ended" },
    };
    const now = this.#now();
    const revision: BrowserRevision = {
      id,
      repositoryId: repository.id,
      sha,
      ...(ref !== undefined ? { ref } : {}),
      slot,
      lookySessionId: record.id,
      principal,
      createdAt: now,
      lastUsed: now,
    };
    session.revisions.set(id, revision);
    return Response.json(this.#revisionState(revision), { status: 201 });
  }

  /** A free slot, or the least recently used selection's slot, which ends that selection. */
  #reserveSlot(session: BrowserSession, id: string): number {
    const max = this.#limits.maxRevisionsPerSession;
    for (let slot = 0; slot < max; slot += 1) {
      if (session.slots[slot] === undefined) {
        session.slots[slot] = id;
        return slot;
      }
    }
    const oldest = [...session.revisions.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!oldest) {
      throw new BrowserError(429, "too_many_selections", "Too many revisions are being selected");
    }
    // The next registration in this slot supersedes the old Looky session,
    // which stops its questions; nothing more is delivered for it.
    session.revisions.delete(oldest.id);
    session.slots[oldest.slot] = id;
    return oldest.slot;
  }

  #revision(session: BrowserSession, id: string): BrowserRevision {
    const revision = session.revisions.get(id);
    if (!revision) throw new BrowserError(404, "revision_not_found", "No such revision selection");
    revision.lastUsed = this.#now();
    return revision;
  }

  #revisionState(revision: BrowserRevision) {
    let index;
    try {
      index = browserIndex(
        this.#service.status(this.#client, {
          repositoryId: revision.repositoryId,
          sha: revision.sha,
        }),
      );
    } catch (error) {
      if (error instanceof OperationError) {
        throw new BrowserError(403, "repository_not_permitted", "This repository is not available");
      }
      throw error;
    }
    return {
      revision: {
        id: revision.id,
        repositoryId: revision.repositoryId,
        sha: revision.sha,
        ...(revision.ref !== undefined ? { ref: revision.ref } : {}),
        selectedAt: new Date(revision.createdAt).toISOString(),
        active: revision.principal.authorize().allowed,
      },
      index,
    };
  }

  async #submit(session: BrowserSession, request: Request): Promise<Response> {
    const body = await this.#body(request, [
      "revisionId",
      "question",
      "mode",
      "clientRequestId",
      "wikiPage",
    ]);
    const { revisionId, question, mode, clientRequestId, wikiPage } = body;
    if (typeof clientRequestId !== "string" || !CLIENT_REQUEST_ID.test(clientRequestId)) {
      throw new BrowserError(
        400,
        "invalid_request",
        "clientRequestId must be 8 to 100 letters, digits, - or _",
      );
    }
    if (mode !== "fast" && mode !== "deep") {
      throw new BrowserError(400, "invalid_request", "mode must be fast or deep");
    }
    if (typeof question !== "string") {
      throw new BrowserError(400, "invalid_request", "question must be a string");
    }
    if (typeof revisionId !== "string") {
      throw new BrowserError(400, "invalid_request", "revisionId is required");
    }
    const pageRef = parsePageRef(wikiPage);
    const fingerprint =
      `${revisionId}\n${mode}\n${question}` +
      (pageRef ? `\nwiki\n${pageRef.generationId}\n${pageRef.pageId}` : "");
    // A repeated delivery returns the same question; nothing is researched twice.
    for (const existing of session.questions.values()) {
      if (existing.clientRequestId !== clientRequestId) continue;
      if (existing.fingerprint !== fingerprint) {
        throw new BrowserError(
          409,
          "request_key_reused",
          "This clientRequestId was already used for a different question",
        );
      }
      existing.lastSeenAt = this.#now();
      return Response.json(this.#questionView(existing));
    }
    const revision = this.#revision(session, revisionId);
    // The page and its generation are resolved here, against this selection's
    // repository and commit; a page of another commit is refused, not mixed in.
    let page: PageContext | undefined;
    let asked = question;
    if (pageRef) {
      const resolved = this.#pageContext(revision, pageRef);
      page = resolved.page;
      const composed = composePageQuestion(question, resolved.hints, this.#maxQuestionChars);
      if (question.trim().length > 0 && composed === undefined) {
        throw new BrowserError(
          400,
          "question_too_long",
          "The question is too long to ask together with its page context",
        );
      }
      // An empty question stays empty so the service rejects it as such.
      if (question.trim().length > 0) asked = composed!;
    }
    this.#prune(session);
    const running = [...session.questions.values()].filter((item) => !item.result).length;
    if (running >= this.#limits.maxRunningPerSession) {
      throw new BrowserError(
        429,
        "too_many_questions",
        `At most ${this.#limits.maxRunningPerSession} questions may run at once`,
      );
    }
    if (session.questions.size >= this.#limits.maxRetainedPerSession) {
      throw new BrowserError(429, "too_many_questions", "Too many questions are retained");
    }

    const controller = new AbortController();
    const now = this.#now();
    let entry!: BrowserQuestion;
    const settled = this.#service
      .ask(
        revision.principal,
        { question: asked, mode },
        {
          signal: controller.signal,
          // Scoped by the service to this revision's Looky session.
          requestKey: `browser:${clientRequestId}`,
        },
      )
      .catch((error: unknown): AskProjectResponse => {
        console.error("looky: browser question failed unexpectedly:", errorText(error));
        return {
          status: "failed",
          requestId: entry.id,
          mode: { requested: mode, executed: null },
          limitations: [],
          stage: "answer",
          code: "internal_error",
          message: "",
          retryable: false,
        };
      })
      .then((response) => {
        entry.result = browserResponse(page ? samePageRevision(response, page) : response);
        entry.completedAt = this.#now();
      });
    entry = {
      id: `brq_${crypto.randomUUID()}`,
      clientRequestId,
      revisionId: revision.id,
      repositoryId: revision.repositoryId,
      sha: revision.sha,
      mode,
      fingerprint,
      controller,
      submittedAt: now,
      settled,
      ...(page ? { page } : {}),
      lastSeenAt: now,
      watchers: 0,
    };
    session.questions.set(entry.id, entry);
    return Response.json(this.#questionView(entry), { status: 202 });
  }

  #question(session: BrowserSession, id: string): BrowserQuestion {
    // Another browser session's question is reported as missing.
    const question = session.questions.get(id);
    if (!question) throw new BrowserError(404, "question_not_found", "No such question");
    return question;
  }

  async #observe(
    session: BrowserSession,
    id: string,
    url: URL,
    signal: AbortSignal,
  ): Promise<Response> {
    const question = this.#question(session, id);
    const raw = url.searchParams.get("waitMs");
    const waitMs = raw === null ? 0 : Number(raw);
    if (!Number.isSafeInteger(waitMs) || waitMs < 0) {
      throw new BrowserError(400, "invalid_request", "waitMs must be a non-negative integer");
    }
    question.lastSeenAt = this.#now();
    if (!question.result && waitMs > 0) {
      question.watchers += 1;
      try {
        await waitFor(question.settled, Math.min(waitMs, this.#limits.maxWaitMs), signal);
      } finally {
        question.watchers -= 1;
        question.lastSeenAt = this.#now();
      }
    }
    return Response.json(this.#questionView(question));
  }

  async #cancel(session: BrowserSession, id: string): Promise<Response> {
    const question = this.#question(session, id);
    const cancelled = !question.result;
    if (cancelled) {
      question.controller.abort(new Error("The browser cancelled this question"));
      await waitFor(question.settled, CANCEL_WAIT_MS);
    }
    return Response.json({ ...this.#questionView(question), cancelRequested: cancelled });
  }

  #questionView(question: BrowserQuestion) {
    return {
      id: question.id,
      clientRequestId: question.clientRequestId,
      revisionId: question.revisionId,
      repositoryId: question.repositoryId,
      sha: question.sha,
      mode: question.mode,
      ...(question.page
        ? {
            wikiPage: {
              generationId: question.page.generationId,
              pageId: question.page.pageId,
              slug: question.page.slug,
              title: question.page.title,
              sha: question.page.sha,
            },
          }
        : {}),
      state: question.result ? "completed" : "running",
      submittedAt: new Date(question.submittedAt).toISOString(),
      ...(question.completedAt !== undefined
        ? { completedAt: new Date(question.completedAt).toISOString() }
        : {}),
      ...(question.result ? { response: question.result } : {}),
      ...(question.result?.status === "answered"
        ? { sourceLinks: this.#links(question.result) }
        : {}),
    };
  }

  /**
   * One link or null per evidence reference, pinned to the answer's SHA. Only
   * http and https links from the configured template are offered.
   */
  #links(response: Extract<AskProjectResponse, { status: "answered" }>): (string | null)[] {
    return response.evidence.map((ref) =>
      this.#link(response.revision.repositoryId, response.revision.sha, ref),
    );
  }

  #link(
    repositoryId: string,
    sha: string,
    ref: { readonly path: string; readonly startLine: number; readonly endLine: number },
  ): string | null {
    if (!this.#sourceLink) return null;
    let url: string | undefined;
    try {
      url = this.#sourceLink({
        repositoryId,
        sha,
        path: ref.path,
        startLine: ref.startLine,
        endLine: ref.endLine,
      });
    } catch {
      return null;
    }
    if (!url) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Generated wiki

  async #wikiRoute(
    session: BrowserSession,
    revisionId: string,
    rest: readonly string[],
    request: Request,
    url: URL,
  ): Promise<Response> {
    const method = request.method;
    const revision = this.#revision(session, revisionId);
    this.#reauthorize(revision);
    const [sub, generationId, action, ...slugParts] = rest;
    if (rest.length === 0 && method === "GET") return Response.json(this.#wikiStatus(revision));
    if (sub === "generate" && rest.length === 1 && method === "POST") {
      await this.#body(request, []);
      return await this.#wikiStart(revision, () =>
        this.#service.wikiGenerate(this.#client, {
          repositoryId: revision.repositoryId,
          sha: revision.sha,
        }),
      );
    }
    if (sub === "generations" && generationId) {
      if (rest.length === 2 && method === "GET") {
        const generation = this.#wikiGeneration(revision, generationId, true);
        const index = this.#wikiCall(() => this.#service.wikiIndex(this.#client, generation.id));
        if (!index) throw new BrowserError(404, "wiki_generation_not_found", "No such wiki");
        return Response.json({
          revisionId: revision.id,
          ...wikiIndexView(index, this.#isCurrent(revision, generation)),
        });
      }
      if (action === "cancel" && rest.length === 3 && method === "POST") {
        await this.#body(request, []);
        const generation = this.#wikiGeneration(revision, generationId, false);
        const result = this.#wikiCall(() => this.#service.wikiCancel(this.#client, generation.id));
        return Response.json({
          generationId: generation.id,
          cancelled: result.cancelled,
          wiki: this.#wikiStatus(revision),
        });
      }
      if (action === "retry" && rest.length === 3 && method === "POST") {
        await this.#body(request, []);
        const generation = this.#wikiGeneration(revision, generationId, false);
        if (generation.state !== "failed" && generation.state !== "cancelled") {
          throw new BrowserError(
            409,
            "wiki_not_retryable",
            "Only a failed or cancelled wiki generation can be retried",
            { state: generation.state },
          );
        }
        return await this.#wikiStart(revision, () =>
          this.#service.wikiRetry(this.#client, generation.id),
        );
      }
      if (action === "pages" && slugParts.length > 0 && method === "GET") {
        return this.#wikiPage(revision, generationId, slugParts.join("/"));
      }
      if (action === "search" && rest.length === 3 && method === "GET") {
        return this.#wikiSearch(revision, generationId, url);
      }
    }
    throw new BrowserError(404, "not_found", "No such browser route");
  }

  /** The selection must still be live and its repository still configured for this client. */
  #reauthorize(revision: BrowserRevision): void {
    if (!revision.principal.authorize().allowed) {
      throw new BrowserError(
        403,
        "revision_inactive",
        "This revision selection ended; choose the revision again",
      );
    }
    this.#repository(revision.repositoryId);
  }

  /** Run a service wiki call, mapping its typed failures to browser errors with fixed messages. */
  #wikiCall<T>(call: () => T): T {
    try {
      return call();
    } catch (error) {
      throw wikiFailure(error);
    }
  }

  #wikiStatus(revision: BrowserRevision) {
    const status = this.#wikiCall(() =>
      this.#service.wikiStatus(this.#client, {
        repositoryId: revision.repositoryId,
        sha: revision.sha,
      }),
    );
    return {
      revisionId: revision.id,
      ...wikiStatusView(status, (id) =>
        this.#wikiCall(() => this.#service.wikiPageCounts(this.#client, id)),
      ),
    };
  }

  async #wikiStart(
    revision: BrowserRevision,
    start: () => Promise<WikiStartResult>,
  ): Promise<Response> {
    let started: WikiStartResult;
    try {
      started = await start();
    } catch (error) {
      throw wikiFailure(error);
    }
    // Delivery re-checks the selection, as answers do.
    this.#reauthorize(revision);
    const view = (() => {
      switch (started.state) {
        case "ready":
          return { state: "ready", generation: generationView(started.generation) };
        case "queued":
        case "running":
          return {
            state: started.state,
            created: started.created,
            generation: generationView(started.generation),
          };
        case "indexing":
          return {
            state: "indexing",
            index: { buildId: started.buildId, progress: started.progress },
          };
        case "index_failed":
          return {
            state: "index_failed",
            index: {
              buildId: started.build.id,
              code: started.build.errorCode,
              retryable: started.build.retryable ?? false,
            },
          };
        case "unsupported_revision":
          return { state: "unsupported_revision" };
      }
    })();
    const status = started.state === "queued" ? 202 : 200;
    return Response.json(
      { revisionId: revision.id, ...view, wiki: this.#wikiStatus(revision) },
      { status },
    );
  }

  /**
   * A generation this selection may read: same repository (otherwise missing)
   * and same commit (otherwise a typed mismatch naming the other commit).
   */
  #wikiGeneration(
    revision: BrowserRevision,
    generationId: string,
    published: boolean,
  ): WikiGenerationRecord {
    if (!GENERATION_ID.test(generationId)) {
      throw new BrowserError(404, "wiki_generation_not_found", "No such wiki generation");
    }
    let generation: WikiGenerationRecord;
    try {
      generation = this.#service.wikiGeneration(this.#client, generationId);
    } catch (error) {
      throw wikiFailure(error);
    }
    if (generation.repositoryId !== revision.repositoryId) {
      throw new BrowserError(404, "wiki_generation_not_found", "No such wiki generation");
    }
    if (generation.sha !== revision.sha) {
      throw new BrowserError(
        409,
        "wiki_revision_mismatch",
        "This wiki was generated for another commit; select that commit to read it",
        { generationId: generation.id, generationSha: generation.sha, revisionSha: revision.sha },
      );
    }
    if (published && generation.state !== "ready") {
      throw new BrowserError(409, "wiki_not_ready", "This wiki generation is not published", {
        state: generation.state,
      });
    }
    return generation;
  }

  /** Whether the generation is the one served now for its commit, rather than a retired one. */
  #isCurrent(revision: BrowserRevision, generation: WikiGenerationRecord): boolean {
    try {
      const status = this.#service.wikiStatus(this.#client, {
        repositoryId: revision.repositoryId,
        sha: revision.sha,
      });
      return status.ready?.id === generation.id;
    } catch {
      return false;
    }
  }

  #targets(generationId: string): {
    readonly targets: PageTargets;
    readonly pages: ReadonlyMap<string, WikiPageRecord>;
  } {
    const index = this.#wikiCall(() => this.#service.wikiIndex(this.#client, generationId));
    const pages = new Map((index?.pages ?? []).map((page) => [page.pageId, page]));
    const ready = new Map(
      [...pages.values()]
        .filter((page) => page.state === "ready")
        .map((page) => [page.slug, { pageId: page.pageId, title: page.title }]),
    );
    return { targets: { ready }, pages };
  }

  #wikiPage(revision: BrowserRevision, generationId: string, slug: string): Response {
    const generation = this.#wikiGeneration(revision, generationId, true);
    if (slug.length > MAX_SLUG_CHARS || !WIKI_SLUG.test(slug)) {
      throw new BrowserError(404, "page_not_found", "No such wiki page");
    }
    const resolution = this.#wikiCall(() =>
      this.#service.wikiResolveSlug(this.#client, generation.id, slug),
    );
    if (resolution.outcome === "not_found") {
      throw new BrowserError(404, "page_not_found", "No such wiki page");
    }
    if (resolution.outcome === "removed") {
      throw new BrowserError(410, "page_removed", "This page is not part of this wiki any more", {
        slug: resolution.slug,
        lastTitle: resolution.lastTitle,
      });
    }
    const content = this.#wikiCall(() =>
      this.#service.wikiPage(this.#client, generation.id, resolution.page.pageId),
    );
    if (!content) throw new BrowserError(404, "page_not_found", "No such wiki page");
    const { targets } = this.#targets(generation.id);
    return Response.json({
      revisionId: revision.id,
      ...wikiPageView(content, generation, {
        current: this.#isCurrent(revision, generation),
        targets,
        link: (ref) => this.#link(generation.repositoryId, generation.sha, ref),
        // A renamed slug is answered with the same page and its new slug; never another page.
        ...(resolution.outcome === "redirect" ? { redirectedFrom: resolution.fromSlug } : {}),
      }),
    });
  }

  #wikiSearch(revision: BrowserRevision, generationId: string, url: URL): Response {
    const generation = this.#wikiGeneration(revision, generationId, true);
    const query = url.searchParams.get("q") ?? "";
    const parsed = parseSearchQuery(query);
    if (!parsed.ok) {
      throw new BrowserError(
        400,
        parsed.code,
        parsed.code === "query_empty"
          ? "Enter at least one word to search for"
          : "The search text is too long",
      );
    }
    const limit = boundedInteger(
      url.searchParams.get("limit"),
      DEFAULT_SEARCH_LIMIT,
      1,
      MAX_SEARCH_LIMIT,
    );
    const offset = boundedInteger(url.searchParams.get("offset"), 0, 0, MAX_SEARCH_OFFSET);
    const result = this.#wikiCall(() =>
      this.#service.wikiSearch(this.#client, generation.id, {
        expression: parsed.expression,
        limit,
        offset,
      }),
    );
    const { pages } = this.#targets(generation.id);
    return Response.json({
      revisionId: revision.id,
      ...wikiSearchView(
        result,
        generation,
        pages,
        { query, limit, offset },
        this.#isCurrent(revision, generation),
      ),
    });
  }

  /** Resolve a page question's page against the selection; refuse anything that would mix commits. */
  #pageContext(
    revision: BrowserRevision,
    ref: { readonly generationId: string; readonly pageId: string },
  ): { readonly page: PageContext; readonly hints: string } {
    this.#reauthorize(revision);
    const generation = this.#wikiGeneration(revision, ref.generationId, true);
    const content = this.#wikiCall(() =>
      this.#service.wikiPage(this.#client, generation.id, ref.pageId),
    );
    if (!content) throw new BrowserError(404, "page_not_found", "No such wiki page");
    if (content.page.state !== "ready") {
      throw new BrowserError(409, "page_unavailable", "This page has no generated content", {
        state: content.page.state,
      });
    }
    return {
      page: {
        generationId: generation.id,
        pageId: content.page.pageId,
        slug: content.page.slug,
        title: content.page.title,
        repositoryId: generation.repositoryId,
        sha: generation.sha,
      },
      hints: pageHints(content),
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle

  #prune(session: BrowserSession): void {
    const now = this.#now();
    for (const [id, question] of session.questions) {
      if (
        question.completedAt !== undefined &&
        now - question.completedAt > this.#limits.resultRetentionMs
      ) {
        session.questions.delete(id);
      }
    }
    // Over the cap, the oldest finished questions go first.
    const finished = [...session.questions.values()]
      .filter((question) => question.completedAt !== undefined)
      .sort((a, b) => a.completedAt! - b.completedAt!);
    while (session.questions.size >= this.#limits.maxRetainedPerSession && finished.length > 0) {
      session.questions.delete(finished.shift()!.id);
    }
  }

  #revoke(lookySessionId: string): void {
    try {
      this.#service.revokeSession(this.#client, lookySessionId);
    } catch (error) {
      console.error("looky: could not end a browser revision session:", errorText(error));
    }
  }

  /** Sign a browser session out: stop its questions and end its Looky sessions. */
  #end(session: BrowserSession): void {
    if (session.ended) return;
    session.ended = true;
    this.#sessions.delete(session.key);
    for (const question of session.questions.values()) {
      if (!question.result) question.controller.abort(new Error("The browser session ended"));
    }
    for (const revision of session.revisions.values()) this.#revoke(revision.lookySessionId);
    session.revisions.clear();
  }

  /** Expire sessions, cancel abandoned questions and drop old results. */
  sweep(): void {
    const now = this.#now();
    for (const session of this.#sessions.values()) {
      if (session.expiresAt <= now) {
        this.#end(session);
        continue;
      }
      for (const question of session.questions.values()) {
        if (
          !question.result &&
          question.watchers === 0 &&
          now - question.lastSeenAt > this.#limits.abandonAfterMs
        ) {
          question.controller.abort(new Error("The browser stopped watching this question"));
        }
      }
      this.#prune(session);
    }
  }

  /** Sign every browser out. Called before the service stops. */
  stop(): void {
    clearInterval(this.#sweep);
    for (const session of this.#sessions.values()) this.#end(session);
  }
}

/** `{ generationId, pageId }` of a page question, or undefined when absent. */
function parsePageRef(
  value: unknown,
): { readonly generationId: string; readonly pageId: string } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new BrowserError(400, "invalid_request", "wikiPage must be an object");
  }
  const record = value as Record<string, unknown>;
  const extra = Object.keys(record).filter((key) => key !== "generationId" && key !== "pageId");
  if (extra.length > 0) {
    throw new BrowserError(400, "invalid_request", "wikiPage takes only generationId and pageId");
  }
  const { generationId, pageId } = record;
  if (typeof generationId !== "string" || !GENERATION_ID.test(generationId)) {
    throw new BrowserError(
      400,
      "invalid_request",
      "wikiPage.generationId is not a wiki generation id",
    );
  }
  if (typeof pageId !== "string" || !PAGE_ID.test(pageId)) {
    throw new BrowserError(400, "invalid_request", "wikiPage.pageId is not a page id");
  }
  return { generationId, pageId };
}

/**
 * A page question's answer must be about the page's own repository and
 * commit. The selection pins both, so this never fires unless a defect mixed
 * revisions; then the answer is withheld rather than shown against the page.
 */
function samePageRevision(response: AskProjectResponse, page: PageContext): AskProjectResponse {
  if (response.status !== "answered") return response;
  if (
    response.revision.repositoryId === page.repositoryId &&
    response.revision.sha === page.sha &&
    response.index.sha === page.sha
  ) {
    return response;
  }
  return {
    status: "failed",
    requestId: response.requestId,
    mode: response.mode,
    limitations: [],
    stage: "context",
    code: "revision_mismatch",
    message: "",
    retryable: false,
  };
}

function boundedInteger(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new BrowserError(400, "invalid_request", `Expected an integer from ${min} to ${max}`);
  }
  return value;
}

/** Typed service failures of wiki calls as browser errors with fixed messages. */
function wikiFailure(error: unknown): unknown {
  if (error instanceof BrowserError) return error;
  if (error instanceof OperationError) {
    if (error.code === "forbidden") {
      return new BrowserError(403, "repository_not_permitted", "This repository is not available");
    }
    if (error.code === "not_found") {
      return new BrowserError(404, "wiki_generation_not_found", "No such wiki generation");
    }
    return new BrowserError(
      409,
      "wiki_invalid_state",
      "The wiki cannot do that in its current state",
    );
  }
  if (error instanceof IndexAccessDeniedError) {
    return new BrowserError(403, "repository_not_permitted", "This repository is not available");
  }
  if (error instanceof LookyUnavailableError) {
    return new BrowserError(
      503,
      "wiki_unavailable",
      "Wiki generation is not available on this Looky service now",
    );
  }
  return error;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Wait for the promise, at most `ms`, or until the signal aborts. Never rejects. */
function waitFor(promise: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
    if (signal?.aborted) done();
    void promise.then(done, done);
  });
}

function withHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

function errorResponse(failure: unknown): Response {
  if (failure instanceof BrowserError) {
    return Response.json(
      {
        error: {
          code: failure.code,
          message: failure.message,
          ...(failure.details ? { details: failure.details } : {}),
        },
      },
      { status: failure.status },
    );
  }
  console.error("looky: browser request failed:", errorText(failure));
  return Response.json(
    { error: { code: "internal_error", message: "Looky could not handle the request" } },
    { status: 500 },
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
