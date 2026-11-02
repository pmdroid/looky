/**
 * The Looky service behind the MCP entrypoints. It owns one database, its
 * index builds and the question capacity of this host, and serves
 * `ask_project` for authorized sessions:
 *
 * 1. The session's trusted context pins repository and SHA.
 * 2. The index for exactly that SHA is reused when ready. Otherwise the
 *    request starts or joins its build (an incremental refresh when an
 *    ancestor is ready) and waits for it within `indexWaitMs`, then returns a
 *    typed retryable `indexing` result with the build id and progress.
 * 3. Research and answer synthesis run under a bounded admission: a fixed
 *    number of slots, a bounded queue and a bounded wait, then `busy`.
 * 4. Identical questions of one session share one piece of work. A caller
 *    that cancels detaches; the work is cancelled only when no caller is left.
 * 5. Before any result is delivered, the session must still be current, so a
 *    superseded generation or revoked session never receives a result.
 *
 * Builds run on index worker threads of this process, never on a client's
 * runner, so a caller holding its only runner slot cannot deadlock on Looky:
 * every call returns within the index wait, the admission wait and the mode's
 * elapsed-time budget.
 */
import type { Database } from "bun:sqlite";
import { hostname } from "node:os";
import { LookyAnswerEngine } from "../answer/engine";
import { askProject, type AskProjectServices } from "../ask/ask-project";
import {
  loadAnswerConfig,
  loadResearchConfig,
  loadWikiConfig,
  type LookyAskConfig,
  type LookyIndexConfig,
  type LookyWikiConfig,
} from "../config";
import type { BudgetOverrides } from "../contract/budgets";
import type { LookyRequestContext } from "../contract/context";
import { parseAskProjectInput, type Mode } from "../contract/input";
import {
  isPolicyAwareProvider,
  LookyUnavailableError,
  ProviderConfigError,
  type AnswerEngine,
  type AuthorizationDecision,
  type ClientAdapter,
  type ModelProvider,
  type ProviderPolicy,
} from "../contract/ports";
import type {
  AskProjectResponse,
  IndexProgress,
  ModeReport,
  UnavailableCode,
} from "../contract/response";
import { fetchCommit } from "../indexing/git-snapshot";
import { IndexService, progressOf } from "../indexing/index-service";
import { getBuild, type BuildRecord, type ScopeStatus } from "../indexing/store";
import { IndexRetriever } from "../retrieval/index-retriever";
import { GitSourceReader } from "../source/git-source-reader";
import { WikiGenerator, type WikiStartResult } from "../wiki/generator";
import { getWikiGeneration, type WikiGenerationRecord, type WikiStatus } from "../wiki/store";
import { Admission } from "./admission";
import {
  clientMayUse,
  type CapacityConfig,
  type ClientConfig,
  type RepositoryConfig,
} from "./config";
import { parseRegistration, RegistrationError, SessionStore, type SessionRecord } from "./sessions";

export const LOOKY_VERSION = "0.1.0";
/** Version of Looky's client protocol: session registration and operations. */
export const LOOKY_PROTOCOL_VERSION = "1";
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [LOOKY_PROTOCOL_VERSION];

/**
 * Who is asking, with the trusted context for every request. Sessions
 * registered by a client adapter are principals; so is the local stdio user.
 */
export interface Principal {
  /** Stable identity for coalescing and per-session limits, such as the session id. */
  readonly key: string;
  readonly context: LookyRequestContext;
  readonly providerPolicy?: ProviderPolicy;
  readonly budgetLimits?: BudgetOverrides;
  /** Current authorization, checked before work starts and before every delivery. */
  authorize(): AuthorizationDecision;
}

export interface AskOptions {
  /** Caller cancellation. The caller detaches; shared work continues for other callers. */
  readonly signal?: AbortSignal;
  /**
   * Client request identity, such as an MCP `_meta` key. A redelivery with the
   * same key joins the running work or receives the same result.
   */
  readonly requestKey?: string;
}

export interface LookyServiceOptions {
  /** Looky's database. The service owns it from now on and closes it in {@link LookyService.close}. */
  readonly db: Database;
  /** Directory holding the database, reported as the index storage location. */
  readonly dataDir: string;
  readonly repositories: ReadonlyMap<string, RepositoryConfig>;
  readonly ask: LookyAskConfig;
  readonly index: LookyIndexConfig;
  readonly capacity: CapacityConfig;
  /** Generated wiki limits and generation budgets. Default: from the environment. */
  readonly wiki?: LookyWikiConfig;
  /** Configured model provider. Without one, questions that need a model are unavailable. */
  readonly provider?: ModelProvider;
  /**
   * Provider ids, kinds and models in fallback order, for the wiki generator
   * fingerprint. Without it, only the provider id is known.
   */
  readonly modelIdentity?: string;
  readonly engine?: AnswerEngine;
  readonly executor?: "worker" | "inline";
  readonly now?: () => number;
  /** Interval for expiring sessions and dropping old results. Default one minute. */
  readonly sweepIntervalMs?: number;
}

/** Index lifecycle of one repository and SHA, as clients see it. */
export interface IndexView {
  readonly repositoryId: string;
  readonly sha: string;
  readonly state: ScopeStatus["state"];
  readonly ready?: { readonly buildId: string; readonly sha: string };
  readonly active?: {
    readonly buildId: string;
    readonly state: string;
    readonly progress: IndexProgress;
    readonly refresh: BuildRecord["refresh"];
  };
  readonly failure?: {
    readonly buildId: string;
    readonly code: string | null;
    readonly message: string | null;
    readonly retryable: boolean;
  };
}

export class OperationError extends Error {
  override readonly name = "OperationError";
  constructor(
    readonly code: "not_found" | "forbidden" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

interface SharedWork {
  readonly requestId: string;
  readonly principalKey: string;
  readonly fingerprint: string;
  readonly controller: AbortController;
  promise: Promise<AskProjectResponse>;
  joiners: number;
  done: boolean;
}

interface StoredResult {
  readonly fingerprint: string;
  readonly response: AskProjectResponse;
  readonly expiresAt: number;
}

const NEVER = new AbortController().signal;
const BUILD_POLL_MS = 250;
const PRUNE_ENDED_SESSIONS_MS = 7 * 24 * 60 * 60 * 1000;

/** Results a redelivery may receive again. Anything else is worth recomputing. */
const KEPT_STATUSES = new Set<AskProjectResponse["status"]>([
  "answered",
  "invalid_request",
  "unsupported_revision",
]);

const missingProvider: ModelProvider = {
  id: "unconfigured",
  complete: async () => {
    throw new LookyUnavailableError(
      "No model provider is configured for this Looky service; set LOOKY_PROVIDER",
    );
  },
};

export class LookyService {
  readonly index: IndexService;
  /** Background wiki generation for authorized repositories. */
  readonly wiki: WikiGenerator;
  readonly sessions: SessionStore;
  readonly #options: LookyServiceOptions;
  readonly #now: () => number;
  readonly #admission: Admission;
  readonly #askServices: AskProjectServices;
  readonly #works = new Map<string, SharedWork>();
  readonly #results = new Map<string, StoredResult>();
  readonly #fetches = new Map<string, Promise<boolean>>();
  /** Builds an operator started; ending client sessions never cancels them. */
  readonly #operatorBuilds = new Set<string>();
  readonly #startedAt = new Date().toISOString();
  readonly #sweep: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(options: LookyServiceOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    const directory = (id: string) => options.repositories.get(id)?.path;
    this.index = new IndexService({
      db: options.db,
      repositories: directory,
      limits: options.index.limits,
      maxConcurrentBuilds: options.index.maxConcurrentBuilds,
      retention: options.index.retention,
      ...(options.executor ? { executor: options.executor } : {}),
    });
    const retriever = new IndexRetriever({ db: options.db, repositories: directory });
    const sourceReader = new GitSourceReader(directory);
    const wiki = options.wiki ?? loadWikiConfig();
    this.wiki = new WikiGenerator({
      db: options.db,
      index: this.index,
      repositories: directory,
      retriever,
      sourceReader,
      ...(options.provider ? { provider: options.provider } : {}),
      modelIdentity:
        options.modelIdentity ?? `${options.provider?.id ?? "unconfigured"}:model-unknown`,
      limits: wiki.limits,
      settings: wiki.generation,
      ...(wiki.sourceLink ? { sourceLink: wiki.sourceLink } : {}),
      ...(wiki.sourceLinkTemplate ? { sourceLinkTemplate: wiki.sourceLinkTemplate } : {}),
      now: this.#now,
    });
    this.sessions = new SessionStore(options.db, this.#now);
    this.#admission = new Admission(
      options.capacity.maxConcurrentAsks,
      options.capacity.maxQueuedAsks,
    );
    this.#askServices = {
      config: options.ask,
      catalog: this.index,
      retriever,
      sourceReader,
      provider: options.provider ?? missingProvider,
      engine:
        options.engine ??
        new LookyAnswerEngine({ ...loadAnswerConfig(), research: loadResearchConfig() }),
      now: this.#now,
    };
    this.#sweep = setInterval(() => this.sweep(), options.sweepIntervalMs ?? 60_000);
    this.#sweep.unref?.();
  }

  // -------------------------------------------------------------------------
  // Questions

  /** Answer one `ask_project` call for a principal. Never throws for request outcomes. */
  async ask(
    principal: Principal,
    rawArgs: unknown,
    options: AskOptions = {},
  ): Promise<AskProjectResponse> {
    const signal = options.signal ?? NEVER;
    const parsed = parseAskProjectInput(rawArgs, {
      maxQuestionChars: this.#options.ask.maxQuestionChars,
    });
    if (!parsed.ok) {
      // Validation only; no index, capacity or provider is touched.
      return askProject(rawArgs, this.#adapter(principal), this.#askServices, { signal });
    }
    const { question, mode } = parsed.input;
    const notRun: ModeReport = { requested: mode, executed: null };
    if (this.#closed) {
      return unavailable(crypto.randomUUID(), notRun, "The Looky service is shutting down");
    }
    const decision = principal.authorize();
    if (!decision.allowed) {
      return {
        status: "denied",
        requestId: crypto.randomUUID(),
        mode: notRun,
        limitations: [],
        reason: decision.reason,
        message: decision.message ?? `Access denied: ${decision.reason}`,
      };
    }

    const fingerprint = `${mode}\n${question}`;
    // The pinned revision is part of the identity: a principal whose ref moved
    // must never join work or receive a stored result for another commit.
    const pinned = `${principal.key}\0${principal.context.repositoryId}\0${principal.context.sha}`;
    const key =
      options.requestKey !== undefined
        ? `${pinned}\0key\0${options.requestKey}`
        : `${pinned}\0question\0${fingerprint}`;
    this.#dropExpiredResults();
    const stored = this.#results.get(key);
    const running = this.#works.get(key);
    if ((stored ?? running) && (stored ?? running)!.fingerprint !== fingerprint) {
      return {
        status: "invalid_request",
        requestId: crypto.randomUUID(),
        mode: notRun,
        limitations: [],
        error: {
          code: "request_key_reused",
          message: "This request key was already used for a different question or mode",
        },
      };
    }
    if (stored) return this.#deliver(principal, stored.response);

    let work = running;
    if (!work) {
      if (this.#inFlight(principal.key) >= this.#options.capacity.maxAsksPerSession) {
        return unavailable(
          crypto.randomUUID(),
          notRun,
          `This session already has ${this.#options.capacity.maxAsksPerSession} questions in ` +
            "flight; wait for one to finish",
          "session_limit",
          this.#options.ask.indexRetryAfterMs,
        );
      }
      work = this.#start(
        principal,
        { question, mode },
        key,
        fingerprint,
        options.requestKey !== undefined,
      );
    }
    return this.#join(work, principal, mode, signal);
  }

  #inFlight(principalKey: string): number {
    let count = 0;
    for (const work of this.#works.values()) if (work.principalKey === principalKey) count += 1;
    return count;
  }

  #start(
    principal: Principal,
    input: { readonly question: string; readonly mode: Mode },
    key: string,
    fingerprint: string,
    keep: boolean,
  ): SharedWork {
    const work: SharedWork = {
      requestId: crypto.randomUUID(),
      principalKey: principal.key,
      fingerprint,
      controller: new AbortController(),
      promise: Promise.resolve(undefined as never),
      joiners: 0,
      done: false,
    };
    work.promise = this.#run(principal, input, work)
      .catch((error: unknown): AskProjectResponse => {
        // #run reports request outcomes itself; anything else is a Looky defect.
        console.error("looky: ask_project failed unexpectedly:", errorText(error));
        return {
          status: "failed",
          requestId: work.requestId,
          mode: { requested: input.mode, executed: null },
          limitations: [],
          stage: "answer",
          code: "internal_error",
          message: errorText(error),
          retryable: false,
        };
      })
      .then((response) => {
        work.done = true;
        this.#works.delete(key);
        if (keep && KEPT_STATUSES.has(response.status)) {
          this.#results.set(key, {
            fingerprint,
            response,
            expiresAt: this.#now() + this.#options.capacity.resultTtlMs,
          });
        }
        return response;
      });
    this.#works.set(key, work);
    return work;
  }

  async #run(
    principal: Principal,
    input: { readonly question: string; readonly mode: Mode },
    work: SharedWork,
  ): Promise<AskProjectResponse> {
    const signal = work.controller.signal;
    const scope = { repositoryId: principal.context.repositoryId, sha: principal.context.sha };
    const services: AskProjectServices = {
      ...this.#askServices,
      newRequestId: () => work.requestId,
    };
    const adapter = this.#adapter(principal);

    try {
      if ((await this.#awaitIndex(scope, signal)) === "fetching") {
        // Not unsupported yet: the commit is still being fetched for this host.
        return unavailable(
          work.requestId,
          { requested: input.mode, executed: null },
          `Commit ${scope.sha} is not on this host yet and is being fetched from the ` +
            `repository's remote; retry shortly`,
          "fetching_revision",
          this.#options.ask.indexRetryAfterMs,
        );
      }
    } catch (error) {
      // Cancellation is reported by askProject below; other lookup errors are
      // raised again, and reported, by its own catalog resolution.
      if (!signal.aborted) console.error("looky: index wait failed:", errorText(error));
    }

    // Research holds a slot; returning `indexing` or a failure does not.
    let release: (() => void) | undefined;
    if (!signal.aborted && this.#readyNow(scope)) {
      try {
        const slot = await this.#admission.acquire(this.#options.capacity.admissionWaitMs, signal);
        if (!slot.admitted) {
          return unavailable(
            work.requestId,
            { requested: input.mode, executed: null },
            slot.reason === "queue_full"
              ? "Looky is at capacity and its queue is full; retry later"
              : `No question slot became free within ${this.#options.capacity.admissionWaitMs}ms; retry later`,
            "busy",
            this.#options.ask.indexRetryAfterMs,
          );
        }
        release = slot.release;
      } catch {
        // Aborted while queued: askProject reports the cancellation.
      }
    }
    try {
      return await askProject(input, adapter, services, { signal });
    } finally {
      release?.();
    }
  }

  #readyNow(scope: { readonly repositoryId: string; readonly sha: string }): boolean {
    try {
      return this.index.indexStatus(scope).state === "ready";
    } catch {
      return false;
    }
  }

  /**
   * Start or join the build for the scope and wait for it within
   * `indexWaitMs`. Fetches a commit this host does not have when the
   * repository allows it. Returns when ready, failed or out of time.
   */
  async #awaitIndex(
    scope: { readonly repositoryId: string; readonly sha: string },
    signal: AbortSignal,
  ): Promise<"settled" | "fetching"> {
    const deadline = this.#now() + this.#options.capacity.indexWaitMs;
    let fetched = false;
    for (;;) {
      signal.throwIfAborted();
      const started = await this.index.startBuild(scope, { signal });
      if (started.state === "unsupported_revision") {
        if (fetched) return "settled";
        // The shared fetch continues in the background; this caller waits only
        // for what is left of its index-wait budget.
        const fetch = this.#fetchMissing(scope);
        if (fetch === undefined) return "settled";
        const budget = Math.max(0, deadline - this.#now());
        const wait = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
        let found: boolean;
        try {
          found = await raceSignal(fetch, wait);
        } catch (error) {
          signal.throwIfAborted();
          if (wait.aborted) return "fetching";
          throw error;
        }
        if (!found) return "settled";
        fetched = true;
        continue;
      }
      if (started.state !== "building") return "settled";
      const remaining = deadline - this.#now();
      if (remaining <= 0) return "settled";
      const wait = AbortSignal.any([signal, AbortSignal.timeout(remaining)]);
      try {
        const build = await this.index.waitForBuild(started.build.id, wait);
        if (build.state === "queued" || build.state === "running") {
          await sleep(Math.min(BUILD_POLL_MS, remaining), wait);
        }
      } catch (error) {
        signal.throwIfAborted();
        if (wait.aborted) return "settled";
        throw error;
      }
    }
  }

  /**
   * Fetch an exact missing commit once per repository and SHA at a time.
   * Returns the shared fetch, bounded only by `fetchTimeoutMs`, or undefined
   * when the repository has no fetch remote.
   */
  #fetchMissing(scope: {
    readonly repositoryId: string;
    readonly sha: string;
  }): Promise<boolean> | undefined {
    const repository = this.#options.repositories.get(scope.repositoryId);
    if (!repository?.fetchRemote) return undefined;
    const key = `${scope.repositoryId}\0${scope.sha}`;
    let pending = this.#fetches.get(key);
    if (!pending) {
      // Shared by every caller, so one caller's cancellation does not stop it.
      pending = fetchCommit(
        repository.path,
        repository.fetchRemote,
        scope.sha,
        AbortSignal.timeout(this.#options.capacity.fetchTimeoutMs),
      )
        .catch((error: unknown) => {
          console.error(
            `looky: fetching ${scope.sha} for ${scope.repositoryId} failed:`,
            errorText(error),
          );
          return false;
        })
        .finally(() => this.#fetches.delete(key));
      this.#fetches.set(key, pending);
    }
    return pending;
  }

  async #join(
    work: SharedWork,
    principal: Principal,
    mode: Mode,
    signal: AbortSignal,
  ): Promise<AskProjectResponse> {
    work.joiners += 1;
    try {
      const response = await raceSignal(work.promise, signal);
      return this.#deliver(principal, response);
    } catch (error) {
      if (!signal.aborted) throw error;
      return {
        status: "cancelled",
        requestId: work.requestId,
        mode: { requested: mode, executed: null },
        limitations: ["The caller cancelled; no result is delivered for this request."],
      };
    } finally {
      work.joiners -= 1;
      // Unshared work is cancelled with its last caller; shared work continues.
      if (work.joiners === 0 && !work.done) {
        work.controller.abort(new Error("Every caller of this request detached"));
      }
    }
  }

  /** The last check before a result leaves Looky: the session must still be current. */
  #deliver(principal: Principal, response: AskProjectResponse): AskProjectResponse {
    const decision = principal.authorize();
    if (decision.allowed) return response;
    return {
      status: "denied",
      requestId: response.requestId,
      mode: response.mode,
      limitations: [],
      reason: decision.reason,
      message: decision.message ?? `Access denied: ${decision.reason}`,
    };
  }

  #adapter(principal: Principal): ClientAdapter {
    return {
      resolveContext: async () => principal.context,
      authorize: async () => principal.authorize(),
      ...(principal.budgetLimits ? { budgetLimits: principal.budgetLimits } : {}),
      ...(principal.providerPolicy ? { providerPolicy: principal.providerPolicy } : {}),
    };
  }

  #dropExpiredResults(): void {
    const now = this.#now();
    for (const [key, stored] of this.#results) {
      if (stored.expiresAt <= now) this.#results.delete(key);
    }
  }

  // -------------------------------------------------------------------------
  // Sessions

  /** A principal for a registered session. Authorization re-reads the session every time. */
  principalFor(session: SessionRecord, client: ClientConfig | undefined): Principal {
    const registration = session.registration;
    const context: LookyRequestContext = {
      clientId: session.clientId,
      clientGeneration: registration.clientGeneration,
      callerId: registration.callerId,
      repositoryId: registration.repositoryId,
      sha: registration.sha,
      worktree: registration.worktree,
      ...(registration.snapshotId !== undefined ? { snapshotId: registration.snapshotId } : {}),
      ...(registration.ref !== undefined ? { ref: registration.ref } : {}),
    };
    return {
      key: session.id,
      context,
      ...(registration.providerPolicy ? { providerPolicy: registration.providerPolicy } : {}),
      ...(registration.budgetLimits ? { budgetLimits: registration.budgetLimits } : {}),
      authorize: () => {
        const decision = this.sessions.check(this.sessions.get(session.id));
        if (!decision.allowed) return decision;
        if (
          client === undefined ||
          !this.#options.repositories.has(registration.repositoryId) ||
          !clientMayUse(client, registration.repositoryId)
        ) {
          return {
            allowed: false,
            reason: "revoked",
            message: `Access to ${registration.repositoryId} is no longer configured for this client`,
          };
        }
        return { allowed: true };
      },
    };
  }

  /**
   * Register a session for a client task generation and prewarm its index.
   * Throws {@link RegistrationError}.
   */
  async registerSession(client: ClientConfig, raw: unknown) {
    const registration = parseRegistration(raw);
    if (
      !this.#options.repositories.has(registration.repositoryId) ||
      !clientMayUse(client, registration.repositoryId)
    ) {
      throw new RegistrationError(
        "repository_not_authorized",
        `Client ${client.id} may not use repository ${registration.repositoryId}`,
      );
    }
    if (registration.providerPolicy) this.#checkPolicy(registration.providerPolicy);
    const result = this.sessions.register(
      client.id,
      registration,
      this.#options.capacity.sessionTtlMs,
    );
    this.#ended(result.superseded);
    const scope = { repositoryId: registration.repositoryId, sha: registration.sha };
    // First use starts or joins the build now, so it runs while the agent works.
    await this.#prewarm(scope);
    return {
      protocolVersion: LOOKY_PROTOCOL_VERSION,
      created: result.created,
      token: this.sessions.tokenFor(result.session),
      session: sessionView(result.session),
      superseded: result.superseded.map((session) => session.id),
      index: this.indexView(scope),
      service: this.#location(),
    };
  }

  #checkPolicy(policy: ProviderPolicy): void {
    const provider = this.#options.provider;
    try {
      if (!provider) {
        throw new ProviderConfigError("No model provider is configured for this Looky service");
      }
      if (!isPolicyAwareProvider(provider)) {
        throw new ProviderConfigError(
          `Provider ${provider.id} does not support provider selection`,
        );
      }
      provider.withPolicy(policy);
    } catch (error) {
      throw new RegistrationError("invalid_registration", errorText(error));
    }
  }

  async #prewarm(scope: { readonly repositoryId: string; readonly sha: string }): Promise<void> {
    try {
      const started = await this.index.startBuild(scope);
      if (started.state === "unsupported_revision") {
        // A host that lacks the commit fetches it in the background, if allowed.
        void this.#fetchMissing(scope)?.then((found) =>
          found ? this.index.startBuild(scope).catch(logPrewarm) : undefined,
        );
      }
    } catch (error) {
      logPrewarm(error);
    }
  }

  /** End a client's session: its in-flight work stops and nothing more is delivered to it. */
  revokeSession(client: ClientConfig, sessionId: string): SessionRecord {
    const revoked = this.sessions.revoke(client.id, sessionId);
    if (!revoked) {
      const existing = this.sessions.get(sessionId);
      if (!existing || existing.clientId !== client.id) {
        throw new OperationError("not_found", `No session ${sessionId} for client ${client.id}`);
      }
      return existing;
    }
    this.#ended([revoked]);
    return revoked;
  }

  /**
   * Sessions that ended: stop their questions and cancel builds no live
   * session needs any more. Builds other sessions share, and builds an
   * operator started, keep running. Ready indexes are never touched.
   */
  #ended(sessions: readonly SessionRecord[]): void {
    for (const session of sessions) {
      for (const work of this.#works.values()) {
        if (work.principalKey === session.id) {
          work.controller.abort(new Error(`Session ${session.id} ended`));
        }
      }
      for (const key of this.#results.keys()) {
        if (key.startsWith(`${session.id}\0`)) this.#results.delete(key);
      }
      const { repositoryId, sha } = session.registration;
      if (this.sessions.hasInterest(repositoryId, sha)) continue;
      try {
        const active = this.index.indexStatus({ repositoryId, sha }).active;
        if (active && !this.#operatorBuilds.has(active.id)) this.index.cancel(active.id);
      } catch (error) {
        console.error(
          `looky: could not cancel the build for ${repositoryId}@${sha}:`,
          errorText(error),
        );
      }
    }
  }

  /** Expire sessions past their deadline and drop old results and session records. */
  sweep(): void {
    if (this.#closed) return;
    try {
      this.#ended(this.sessions.expire());
      this.sessions.prune(PRUNE_ENDED_SESSIONS_MS);
      this.#dropExpiredResults();
    } catch (error) {
      console.error("looky: session sweep failed:", errorText(error));
    }
  }

  // -------------------------------------------------------------------------
  // Operations, scoped to a client's authorized repositories

  indexView(scope: { readonly repositoryId: string; readonly sha: string }): IndexView {
    const status = this.index.indexStatus(scope);
    const failed = status.state === "failed" ? status.latest : undefined;
    return {
      repositoryId: scope.repositoryId,
      sha: scope.sha,
      state: status.state,
      ...(status.ready ? { ready: { buildId: status.ready.id, sha: status.ready.sha } } : {}),
      ...(status.active
        ? {
            active: {
              buildId: status.active.id,
              state: status.active.state,
              progress: progressOf(status.active),
              refresh: status.active.refresh,
            },
          }
        : {}),
      ...(failed
        ? {
            failure: {
              buildId: failed.id,
              code: failed.errorCode,
              message: failed.errorMessage,
              retryable: status.retryable ?? false,
            },
          }
        : {}),
    };
  }

  #allowed(client: ClientConfig, repositoryId: string): void {
    if (!this.#options.repositories.has(repositoryId) || !clientMayUse(client, repositoryId)) {
      throw new OperationError("forbidden", `Client ${client.id} may not use ${repositoryId}`);
    }
  }

  #ownBuild(client: ClientConfig, buildId: string): BuildRecord {
    const build = getBuild(this.#options.db, buildId);
    // An unauthorized build is reported as missing so its existence does not leak.
    if (
      !build ||
      !this.#options.repositories.has(build.repositoryId) ||
      !clientMayUse(client, build.repositoryId)
    ) {
      throw new OperationError("not_found", `Unknown index build ${buildId}`);
    }
    return build;
  }

  status(
    client: ClientConfig,
    scope: { readonly repositoryId: string; readonly sha: string },
  ): IndexView {
    this.#allowed(client, scope.repositoryId);
    return this.indexView(scope);
  }

  build(client: ClientConfig, buildId: string) {
    const build = this.#ownBuild(client, buildId);
    return { ...build, progress: progressOf(build) };
  }

  /** Start a full rebuild; the ready generation keeps serving until it publishes. */
  async rebuild(
    client: ClientConfig,
    scope: { readonly repositoryId: string; readonly sha: string },
  ) {
    this.#allowed(client, scope.repositoryId);
    const started = await this.index.rebuild(scope);
    if (started.state === "unsupported_revision")
      throw new OperationError("invalid", started.message);
    if (started.state === "building") this.#operatorBuilds.add(started.build.id);
    return this.indexView(scope);
  }

  /** Start a new attempt after a failed or cancelled build. */
  async retry(client: ClientConfig, buildId: string) {
    const build = this.#ownBuild(client, buildId);
    const started = await this.index.retry(buildId);
    if (started.state === "unsupported_revision")
      throw new OperationError("invalid", started.message);
    if (started.state === "building") this.#operatorBuilds.add(started.build.id);
    return this.indexView({ repositoryId: build.repositoryId, sha: build.sha });
  }

  cancelBuild(client: ClientConfig, buildId: string) {
    const build = this.#ownBuild(client, buildId);
    const cancelled = this.index.cancel(buildId);
    return {
      buildId,
      cancelled,
      index: this.indexView({ repositoryId: build.repositoryId, sha: build.sha }),
    };
  }

  // -------------------------------------------------------------------------
  // Generated wiki

  #ownWikiGeneration(client: ClientConfig, generationId: string): WikiGenerationRecord {
    const generation = getWikiGeneration(this.#options.db, generationId);
    // An unauthorized generation is reported as missing so its existence does not leak.
    if (
      !generation ||
      !this.#options.repositories.has(generation.repositoryId) ||
      !clientMayUse(client, generation.repositoryId)
    ) {
      throw new OperationError("not_found", `Unknown wiki generation ${generationId}`);
    }
    return generation;
  }

  wikiStatus(
    client: ClientConfig,
    scope: { readonly repositoryId: string; readonly sha: string },
  ): WikiStatus {
    this.#allowed(client, scope.repositoryId);
    return this.wiki.status(scope);
  }

  /**
   * Return the published wiki of this commit, join its running generation or
   * queue a new one. Returns at once; pages are written in the background.
   */
  async wikiGenerate(
    client: ClientConfig,
    scope: { readonly repositoryId: string; readonly sha: string },
  ): Promise<WikiStartResult> {
    this.#allowed(client, scope.repositoryId);
    const started = await this.wiki.start(scope);
    if (started.state === "unsupported_revision") {
      throw new OperationError("invalid", started.message);
    }
    if (started.state === "indexing") this.#operatorBuilds.add(started.buildId);
    return started;
  }

  /** Start a new attempt after a failed or cancelled generation, reusing finished pages. */
  async wikiRetry(client: ClientConfig, generationId: string): Promise<WikiStartResult> {
    const generation = this.#ownWikiGeneration(client, generationId);
    if (generation.state !== "failed" && generation.state !== "cancelled") {
      throw new OperationError("invalid", `Wiki generation ${generationId} is ${generation.state}`);
    }
    return this.wikiGenerate(client, {
      repositoryId: generation.repositoryId,
      sha: generation.sha,
    });
  }

  wikiCancel(client: ClientConfig, generationId: string) {
    const generation = this.#ownWikiGeneration(client, generationId);
    const cancelled = this.wiki.cancel(generationId);
    return {
      generationId,
      cancelled,
      wiki: this.wiki.status({ repositoryId: generation.repositoryId, sha: generation.sha }),
    };
  }

  #location() {
    return {
      host: hostname(),
      pid: process.pid,
      dataDir: this.#options.dataDir,
      indexKey: this.index.indexKey,
    };
  }

  /** Who owns the indexes, where they are stored and what this service can serve. */
  info(client?: ClientConfig) {
    const repositories = [...this.#options.repositories.keys()].filter(
      (id) => client === undefined || clientMayUse(client, id),
    );
    return {
      name: "looky",
      version: LOOKY_VERSION,
      protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      startedAt: this.#startedAt,
      ...this.#location(),
      repositories,
      capacity: {
        ...this.#options.capacity,
        asksActive: this.#admission.active,
        asksQueued: this.#admission.queued,
        requestsInFlight: this.#works.size,
        maxConcurrentBuilds: this.#options.index.maxConcurrentBuilds,
      },
    };
  }

  /** Stop accepting work, stop in-flight questions and builds, and wait for them. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#sweep);
    const pending = [...this.#works.values()];
    for (const work of pending) work.controller.abort(new Error("The Looky service is stopping"));
    await Promise.allSettled(pending.map((work) => work.promise));
    try {
      await this.wiki.close();
      await this.index.close();
    } finally {
      this.#options.db.close();
    }
  }
}

function sessionView(session: SessionRecord) {
  return {
    id: session.id,
    state: session.state,
    taskId: session.registration.taskId,
    sequence: session.registration.sequence,
    clientGeneration: session.registration.clientGeneration,
    repositoryId: session.registration.repositoryId,
    sha: session.registration.sha,
    createdAt: session.createdAt,
    expiresAt: new Date(session.expiresAt).toISOString(),
  };
}

function unavailable(
  requestId: string,
  mode: ModeReport,
  message: string,
  code?: UnavailableCode,
  retryAfterMs?: number,
): AskProjectResponse {
  return {
    status: "unavailable",
    requestId,
    mode,
    limitations: ["No research ran and no answer was produced."],
    message,
    retryable: true,
    ...(code ? { code } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** Settle with the promise, or reject with the signal's reason when it aborts first. */
function raceSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return raceSignal(new Promise<void>((resolve) => setTimeout(resolve, ms)), signal);
}

function logPrewarm(error: unknown): void {
  console.error("looky: could not start the index build:", errorText(error));
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
