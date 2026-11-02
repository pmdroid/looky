/**
 * Bounded, recoverable wiki generation jobs.
 *
 * `start` returns at once: it plans the wiki for an exact commit from a ready
 * index, stores the plan as a queued generation (or joins the generation
 * already queued or running for the same scope) and leaves the writing to a
 * background queue. A published generation of the same scope is returned
 * without any work or model call.
 *
 * A generation writes its pages with bounded concurrency. Every page runs in
 * its own {@link GuardedSession}, pinned to the repository, commit and index
 * generation and re-authorized before every search, read and model call. A
 * per-generation ledger reserves each page's budget from the generation's
 * finite totals before the page starts, so concurrent pages can never spend
 * more than the totals together, and the generation has a wall-clock limit.
 *
 * Every validated page is also kept as a draft keyed by its planned sources,
 * neighbourhood, commit and writer fingerprint (writer and prompt versions,
 * provider and model identity, page budget and research limits). A later
 * attempt for the same inputs reuses the draft without a model call, so a
 * retry, a restart after a crash or a cancelled run only pays for pages that
 * never finished. A different model or prompt gives a different key, so its
 * drafts are never reused.
 *
 * Pages are staged in the generation, which only publishes, atomically, once
 * every page is ready or explicitly unavailable and every internal link
 * resolves. Failed, cancelled, over-budget and interrupted generations stay
 * explicitly incomplete and never replace the last published one.
 */
import type { Database } from "bun:sqlite";
import type { SourceLinkBuilder } from "../answer/citations";
import { ModelOutputError } from "../answer/model-output";
import { AccessRevokedError, BudgetExhaustedError, GuardedSession } from "../ask/session";
import type { ModeBudget } from "../contract/budgets";
import { isFullCommitSha, type LookyRequestContext } from "../contract/context";
import {
  type ClientAdapter,
  type GenerationLease,
  LookyUnavailableError,
  type ModelProvider,
  type Retriever,
  type SourceReader,
} from "../contract/ports";
import type { IndexProgress } from "../contract/response";
import { IndexAccessDeniedError, type IndexService, progressOf } from "../indexing/index-service";
import type { BuildRecord } from "../indexing/store";
import type { ResearchLimits } from "../retrieval/research";
import {
  addWikiUsage,
  EMPTY_WIKI_USAGE,
  shortHash,
  type WikiGeneratorConfig,
  wikiGeneratorKey,
  type WikiPlanLimits,
  type WikiSourceRef,
  type WikiUsage,
} from "./model";
import { WIKI_PROMPT_VERSION, type WikiNeighbour } from "./prompts";
import {
  createWikiGeneration,
  findActiveWikiGeneration,
  findReadyWikiGeneration,
  findWikiDraft,
  finishWikiGenerationUnsuccessfully,
  getWikiGeneration,
  type InspectedBlob,
  publishWikiGeneration,
  recordWikiGenerationUsage,
  recordWikiPageUsage,
  setWikiPageState,
  startWikiGeneration,
  storeWikiDraft,
  storeWikiPageBody,
  touchWikiDraft,
  type WikiGenerationRecord,
  WikiIntegrityError,
  type WikiPageRecord,
  WikiStateError,
  type WikiScope,
  wikiIndex,
  wikiPage,
  type WikiStatus,
  wikiStatus,
} from "./store";
import {
  DEFAULT_WIKI_RESEARCH_LIMITS,
  WIKI_WRITER_VERSION,
  WikiPageError,
  type WikiPageInput,
  writeWikiPage,
} from "./writer";

// ---------------------------------------------------------------------------
// Settings

/** Finite totals for one generation, shared by all of its pages. */
export interface WikiGenerationTotals {
  readonly maxModelCalls: number;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  readonly maxSourceReads: number;
  readonly maxSourceBytes: number;
  /** Wall-clock time from start to a terminal state. */
  readonly maxElapsedMs: number;
}

export interface WikiGenerationSettings {
  /** Generations written at once; more wait in a queue. */
  readonly maxConcurrentGenerations: number;
  /** Pages of one generation written at once. */
  readonly maxConcurrentPages: number;
  /** Budget of one page's guarded session. Output-affecting, so part of the fingerprint. */
  readonly page: ModeBudget;
  /** Research limits inside the page budget. Output-affecting, so part of the fingerprint. */
  readonly research: ResearchLimits;
  readonly totals: WikiGenerationTotals;
}

export const DEFAULT_WIKI_PAGE_BUDGET: ModeBudget = {
  maxRetrievalPasses: 12,
  maxResultsPerPass: 4,
  maxSourceReads: 32,
  maxSourceBytes: 256 * 1024,
  maxModelCalls: 2,
  maxInputTokens: 48_000,
  maxOutputTokens: 4_000,
  maxAnswerChars: 12_000,
  maxElapsedMs: 120_000,
};

export const DEFAULT_WIKI_GENERATION_SETTINGS: WikiGenerationSettings = {
  maxConcurrentGenerations: 1,
  maxConcurrentPages: 2,
  page: DEFAULT_WIKI_PAGE_BUDGET,
  research: DEFAULT_WIKI_RESEARCH_LIMITS,
  totals: {
    maxModelCalls: 80,
    maxInputTokens: 1_600_000,
    maxOutputTokens: 120_000,
    maxSourceReads: 1_200,
    maxSourceBytes: 8 * 1024 * 1024,
    maxElapsedMs: 30 * 60 * 1000,
  },
};

const TIME_LIMIT_MESSAGE = "The wiki generation reached its time limit (maxElapsedMs)";

/** A page is not started with less than this left in the generation's totals. */
const MIN_PAGE_INPUT_TOKENS = 1_000;
const MIN_PAGE_OUTPUT_TOKENS = 100;

export function validateWikiGenerationSettings(settings: WikiGenerationSettings): void {
  const check = (name: string, value: number) => {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Wiki generation setting ${name} must be a positive integer`);
    }
  };
  check("maxConcurrentGenerations", settings.maxConcurrentGenerations);
  check("maxConcurrentPages", settings.maxConcurrentPages);
  for (const [name, value] of Object.entries(settings.page)) check(`page.${name}`, value);
  for (const [name, value] of Object.entries(settings.research)) check(`research.${name}`, value);
  for (const [name, value] of Object.entries(settings.totals)) check(`totals.${name}`, value);
  if (settings.page.maxInputTokens < MIN_PAGE_INPUT_TOKENS) {
    throw new Error(`Wiki page.maxInputTokens must be at least ${MIN_PAGE_INPUT_TOKENS}`);
  }
}

// ---------------------------------------------------------------------------
// Results

export type WikiStartResult =
  | {
      /** A published generation of exactly this scope. Nothing new ran. */
      readonly state: "ready";
      readonly generation: WikiGenerationRecord;
    }
  | {
      readonly state: "queued" | "running";
      readonly generation: WikiGenerationRecord;
      /** False when an equivalent generation was already queued or running and was joined. */
      readonly created: boolean;
    }
  | {
      /** The commit's index is not ready yet. Ask again once it is. */
      readonly state: "indexing";
      readonly buildId: string;
      readonly progress: IndexProgress;
    }
  | { readonly state: "index_failed"; readonly build: BuildRecord }
  | { readonly state: "unsupported_revision"; readonly message: string };

export interface WikiGeneratorOptions {
  readonly db: Database;
  /** The service's index lifecycle, used for exact-commit plans and reader leases. */
  readonly index: IndexService;
  /** The same authorization callback the index uses; undefined revokes access. */
  readonly repositories: (repositoryId: string) => string | undefined;
  readonly retriever: Retriever;
  readonly sourceReader: SourceReader;
  /** Without a provider, generation is unavailable; ready generations are still returned. */
  readonly provider?: ModelProvider;
  /**
   * Provider and model identity that changes output, such as provider ids,
   * kinds and model names in fallback order. Never credentials.
   */
  readonly modelIdentity: string;
  readonly limits: WikiPlanLimits;
  readonly settings?: WikiGenerationSettings;
  readonly sourceLink?: SourceLinkBuilder;
  /** The template behind `sourceLink`, which changes rendered bodies. */
  readonly sourceLinkTemplate?: string;
  readonly now?: () => number;
}

type Scope = { readonly repositoryId: string; readonly sha: string };

type AbortKind = "cancel" | "timeout" | "close";

interface RunningGeneration {
  readonly controller: AbortController;
  abortKind?: AbortKind;
}

export class WikiGenerator {
  readonly #db: Database;
  readonly #options: WikiGeneratorOptions;
  readonly #settings: WikiGenerationSettings;
  readonly #now: () => number;
  readonly #config: WikiGeneratorConfig;
  /** Fingerprint of everything that changes a page body for the same inputs. */
  readonly writerKey: string;
  /** The generation fingerprint: plan limits plus the writer fingerprint. */
  readonly generatorKey: string;
  readonly #queue: string[] = [];
  readonly #running = new Map<string, RunningGeneration>();
  readonly #settled = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  #closed = false;

  constructor(options: WikiGeneratorOptions) {
    this.#db = options.db;
    this.#options = options;
    this.#settings = options.settings ?? DEFAULT_WIKI_GENERATION_SETTINGS;
    validateWikiGenerationSettings(this.#settings);
    this.#now = options.now ?? Date.now;
    const generator: Record<string, string | number | boolean> = {
      writer: "looky-wiki",
      writerVersion: WIKI_WRITER_VERSION,
      promptVersion: WIKI_PROMPT_VERSION,
      model: options.modelIdentity,
      sourceLink: options.sourceLinkTemplate ?? "",
    };
    for (const [name, value] of Object.entries(this.#settings.page))
      generator[`page.${name}`] = value;
    for (const [name, value] of Object.entries(this.#settings.research)) {
      generator[`research.${name}`] = value;
    }
    this.#config = { limits: options.limits, generator };
    this.writerKey = `ww${WIKI_WRITER_VERSION}-${shortHash(JSON.stringify(sorted(generator)))}`;
    this.generatorKey = wikiGeneratorKey(this.#config);
  }

  get settings(): WikiGenerationSettings {
    return this.#settings;
  }

  /** The wiki scope of a repository and commit under this service's index and generator keys. */
  scope(scope: Scope): WikiScope {
    return {
      repositoryId: scope.repositoryId,
      sha: scope.sha,
      indexKey: this.#options.index.indexKey,
      generatorKey: this.generatorKey,
    };
  }

  /** Lifecycle of the scope's wiki. Starts nothing. */
  status(scope: Scope): WikiStatus {
    this.#authorize(scope.repositoryId);
    return wikiStatus(this.#db, this.scope(scope));
  }

  /**
   * Return the published wiki of this exact scope, join the generation
   * already queued or running for it, or plan and queue a new one. Never
   * waits for pages to be written.
   */
  async start(
    scope: Scope,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<WikiStartResult> {
    if (this.#closed) throw new LookyUnavailableError("The wiki generator is closed");
    this.#authorize(scope.repositoryId);
    if (!isFullCommitSha(scope.sha)) {
      return { state: "unsupported_revision", message: "A full lowercase commit SHA is required" };
    }
    const keyed = this.scope(scope);
    const ready = findReadyWikiGeneration(this.#db, keyed);
    if (ready) return { state: "ready", generation: ready };
    const active = this.#join(keyed);
    if (active)
      return { state: active.state as "queued" | "running", generation: active, created: false };
    if (!this.#options.provider) {
      throw new LookyUnavailableError(
        "No model provider is configured for this Looky service; set LOOKY_PROVIDER",
      );
    }

    const started = await this.#options.index.startBuild(
      scope,
      options.signal ? { signal: options.signal } : {},
    );
    if (started.state === "unsupported_revision") return started;
    if (started.state === "failed") return { state: "index_failed", build: started.build };
    if (started.state === "building") {
      return { state: "indexing", buildId: started.build.id, progress: progressOf(started.build) };
    }
    const plan = this.#options.index.planWiki(scope, this.#options.limits);
    if (!plan) {
      return { state: "indexing", buildId: started.build.id, progress: progressOf(started.build) };
    }
    if (this.#closed) throw new LookyUnavailableError("The wiki generator is closed");
    // The store shares one queued or running generation per scope under its write lock.
    const { created, generation } = createWikiGeneration(this.#db, plan, this.#config.generator);
    if (created) this.#enqueue(generation.id);
    else this.#join(keyed);
    return { state: generation.state as "queued" | "running", generation, created };
  }

  /**
   * Start a new attempt after a failed or cancelled generation. Pages that
   * finished before are reused from their drafts, so only unfinished pages
   * cost model calls. Returns the published or active generation instead
   * when the scope no longer needs one.
   */
  async retry(generationId: string, signal?: AbortSignal): Promise<WikiStartResult> {
    const generation = getWikiGeneration(this.#db, generationId);
    if (!generation) throw new Error(`Unknown wiki generation ${generationId}`);
    this.#authorize(generation.repositoryId);
    if (generation.state !== "failed" && generation.state !== "cancelled") {
      throw new Error(
        `Wiki generation ${generationId} is ${generation.state}, not failed or cancelled`,
      );
    }
    return this.start(
      { repositoryId: generation.repositoryId, sha: generation.sha },
      signal ? { signal } : {},
    );
  }

  /**
   * Cancel a queued or running generation. In-flight model calls are aborted;
   * pages that already finished stay cached for a later attempt. Returns
   * false if it had already finished. A published generation is never touched.
   */
  cancel(generationId: string): boolean {
    const queued = this.#queue.indexOf(generationId);
    if (queued !== -1) this.#queue.splice(queued, 1);
    const running = this.#running.get(generationId);
    if (running) {
      running.abortKind ??= "cancel";
      running.controller.abort(new Error("The wiki generation was cancelled"));
      return true;
    }
    const changed = finishWikiGenerationUnsuccessfully(this.#db, generationId, {
      state: "cancelled",
      code: "cancelled",
      message: "The wiki generation was cancelled",
      retryable: true,
    });
    this.#settle(generationId);
    return changed;
  }

  /** Wait until a generation this service runs reaches a terminal state, then return it. */
  async wait(generationId: string, signal?: AbortSignal): Promise<WikiGenerationRecord> {
    const pending = this.#settled.get(generationId);
    if (pending) {
      await (signal
        ? Promise.race([
            pending.promise,
            new Promise<never>((_, reject) => {
              if (signal.aborted) reject(signal.reason);
              signal.addEventListener("abort", () => reject(signal.reason), { once: true });
            }),
          ])
        : pending.promise);
    }
    const generation = getWikiGeneration(this.#db, generationId);
    if (!generation) throw new Error(`Unknown wiki generation ${generationId}`);
    return generation;
  }

  /** Stop accepting work, cancel queued and running generations, and wait for them to stop. */
  async close(): Promise<void> {
    this.#closed = true;
    for (const id of this.#queue.splice(0)) {
      finishWikiGenerationUnsuccessfully(this.#db, id, {
        state: "cancelled",
        code: "service_stopped",
        message: "The service stopped before this wiki generation started",
        retryable: true,
      });
      this.#settle(id);
    }
    const waits = [...this.#settled.values()].map((entry) => entry.promise);
    for (const running of this.#running.values()) {
      running.abortKind ??= "close";
      running.controller.abort(new Error("The Looky service is stopping"));
    }
    await Promise.all(waits);
  }

  // -------------------------------------------------------------------------
  // Queue

  #authorize(repositoryId: string): void {
    if (this.#options.repositories(repositoryId) === undefined) {
      throw new IndexAccessDeniedError(`No source access configured for ${repositoryId}`);
    }
  }

  /**
   * The active generation of a scope. One this process does not track can
   * only be left over from another process; it can never finish, so it is
   * marked interrupted and a fresh one is planned.
   */
  #join(scope: WikiScope): WikiGenerationRecord | undefined {
    const active = findActiveWikiGeneration(this.#db, scope);
    if (!active) return undefined;
    if (this.#running.has(active.id) || this.#queue.includes(active.id)) return active;
    finishWikiGenerationUnsuccessfully(this.#db, active.id, {
      state: "failed",
      code: "interrupted",
      message: "No running service owned this wiki generation",
      retryable: true,
    });
    return undefined;
  }

  #enqueue(id: string): void {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => (resolve = done));
    this.#settled.set(id, { promise, resolve });
    this.#queue.push(id);
    this.#pump();
  }

  #settle(id: string): void {
    this.#settled.get(id)?.resolve();
    this.#settled.delete(id);
  }

  #pump(): void {
    while (
      !this.#closed &&
      this.#running.size < this.#settings.maxConcurrentGenerations &&
      this.#queue.length > 0
    ) {
      const id = this.#queue.shift()!;
      const entry: RunningGeneration = { controller: new AbortController() };
      this.#running.set(id, entry);
      void this.#run(id, entry)
        .catch((error: unknown) => {
          console.error("looky: wiki generation failed unexpectedly:", errorText(error));
          finishWikiGenerationUnsuccessfully(this.#db, id, {
            state: "failed",
            code: "internal_error",
            message: errorText(error),
            retryable: true,
          });
        })
        .finally(() => {
          this.#running.delete(id);
          this.#settle(id);
          this.#pump();
        });
    }
  }

  // -------------------------------------------------------------------------
  // One generation

  async #run(id: string, entry: RunningGeneration): Promise<void> {
    const db = this.#db;
    const settings = this.#settings;
    const startedAt = this.#now();
    const record = getWikiGeneration(db, id);
    if (!record || record.state !== "queued") return;
    startWikiGeneration(db, id, {
      page: settings.page,
      research: settings.research,
      totals: settings.totals,
    });
    const { controller } = entry;
    const timer = setTimeout(() => {
      entry.abortKind ??= "timeout";
      controller.abort(new Error("The wiki generation reached its time limit"));
    }, settings.totals.maxElapsedMs);
    let usage: WikiUsage = EMPTY_WIKI_USAGE;
    let lease: GenerationLease | undefined;
    const save = () =>
      recordWikiGenerationUsage(db, id, {
        ...usage,
        elapsedMs: Math.max(0, this.#now() - startedAt),
      });
    try {
      const scope = { repositoryId: record.repositoryId, sha: record.sha };
      this.#authorize(scope.repositoryId);
      // Pin a ready index generation of exactly this commit while pages read it.
      const resolved = await this.#options.index.resolve(scope, controller.signal);
      if (resolved.state !== "ready") {
        this.#fail(
          id,
          "index_unavailable",
          `The index of ${record.sha} is ${resolved.state}`,
          true,
        );
        return;
      }
      lease = resolved.lease;
      const indexGeneration = resolved.generation;
      const files = indexedBlobs(db, indexGeneration.generationId);
      const index = wikiIndex(db, { repositoryId: record.repositoryId, generationId: id });
      if (!index) throw new Error(`Wiki generation ${id} has no pages`);
      const pages = index.pages.filter((page) => page.state === "queued");
      const neighbours = neighbourhoods(index);

      // Reuse validated drafts first: no model call, no spend.
      const toWrite: { page: WikiPageRecord; input: WikiPageInput; draftKey: string }[] = [];
      for (const page of pages) {
        const sources = wikiPage(db, {
          repositoryId: record.repositoryId,
          generationId: id,
          pageId: page.pageId,
        })!.plannedSources;
        const input: WikiPageInput = {
          title: page.title,
          kind: page.kind,
          description: page.description,
          scopePath: page.scopePath,
          sources,
          neighbours: neighbours.get(page.pageId) ?? [],
        };
        const draftKey = this.#draftKey(record, page, input);
        recordWikiPageUsage(db, id, page.pageId, { draftKey });
        if (this.#reuse(record, page, draftKey, files)) {
          usage = addWikiUsage(usage, { pagesReused: 1 });
          continue;
        }
        toWrite.push({ page, input, draftKey });
      }
      save();

      const ledger = new Ledger(settings.totals, settings.page);
      let stop: { code: string; message: string; retryable: boolean } | undefined;
      let failed = 0;
      const context: LookyRequestContext = {
        clientId: "looky-wiki",
        clientGeneration: id,
        callerId: "wiki-generator",
        repositoryId: record.repositoryId,
        sha: record.sha,
        worktree: { state: "unknown" },
      };
      const adapter: ClientAdapter = {
        resolveContext: async () => context,
        authorize: async () =>
          this.#options.repositories(record.repositoryId) === undefined
            ? {
                allowed: false,
                reason: "revoked",
                message: `Access to ${record.repositoryId} was revoked`,
              }
            : { allowed: true },
      };

      await pool(toWrite, settings.maxConcurrentPages, async ({ page, input, draftKey }) => {
        if (controller.signal.aborted || stop) return;
        const remainingMs = () => settings.totals.maxElapsedMs - (this.#now() - startedAt);
        const budget = await ledger.reserve(remainingMs);
        if (controller.signal.aborted || stop) {
          if (budget) ledger.settle(budget, EMPTY_WIKI_USAGE);
          return;
        }
        if (!budget) {
          stop ??= {
            code: "budget_exhausted",
            message:
              remainingMs() < 1
                ? TIME_LIMIT_MESSAGE
                : "The generation's model call, token or read totals ran out before every page was written",
            retryable: true,
          };
          return;
        }
        setWikiPageState(db, id, page.pageId, "running");
        const counter = countingProvider(this.#options.provider!);
        const pageStarted = this.#now();
        const session = new GuardedSession({
          question: `Write the wiki page "${page.title}"`,
          mode: "deep",
          budget,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(budget.maxElapsedMs)]),
          context,
          generation: indexGeneration,
          adapter,
          retriever: this.#options.retriever,
          sourceReader: this.#options.sourceReader,
          provider: counter,
          now: this.#now,
          startedAt: pageStarted,
        });
        let pageUsage: WikiUsage = EMPTY_WIKI_USAGE;
        try {
          const written = await writeWikiPage(session, input, {
            research: settings.research,
            now: this.#now,
            ...(this.#options.sourceLink ? { sourceLink: this.#options.sourceLink } : {}),
          });
          pageUsage = sessionUsage(session, counter, { pagesWritten: 1 });
          const provenance = {
            generator: "looky-wiki",
            writerVersion: WIKI_WRITER_VERSION,
            promptVersion: String(WIKI_PROMPT_VERSION),
            writerKey: this.writerKey,
            model: this.#options.modelIdentity,
            provider: session.providers().join(","),
            sha: record.sha,
            indexGenerationId: indexGeneration.generationId,
            ...written.validation,
          };
          // Keep the validated draft first, so even a cancelled run never pays for it twice.
          storeWikiDraft(db, {
            repositoryId: record.repositoryId,
            draftKey,
            pageId: page.pageId,
            conceptKey: page.conceptKey,
            writerKey: this.writerKey,
            body: written.body,
            citations: written.citations,
            inspected: written.inspected,
            provenance,
            usage: pageUsage,
          });
          if (!controller.signal.aborted) {
            storeWikiPageBody(db, {
              generationId: id,
              pageId: page.pageId,
              body: written.body,
              citations: written.citations,
              provenance,
              draftKey,
              usage: pageUsage,
            });
          }
        } catch (error) {
          pageUsage = sessionUsage(session, counter, {});
          if (controller.signal.aborted) return;
          failed += 1;
          pageUsage = addWikiUsage(pageUsage, { pagesFailed: 1 });
          if (error instanceof AccessRevokedError || error instanceof IndexAccessDeniedError) {
            stop = { code: "access_revoked", message: error.message, retryable: false };
          } else if (error instanceof LookyUnavailableError) {
            // The provider or index cannot serve; stop spending on further pages.
            stop ??= { code: "unavailable", message: error.message, retryable: true };
          }
          try {
            setWikiPageState(db, id, page.pageId, "failed", pageFailure(error));
          } catch (stateError) {
            // The generation already ended, for example by cancellation; its pages moved with it.
            if (!(stateError instanceof WikiStateError)) throw stateError;
          }
        } finally {
          session.close();
          ledger.settle(budget, pageUsage);
          usage = addWikiUsage(usage, pageUsage);
          recordWikiPageUsage(db, id, page.pageId, { usage: pageUsage });
          save();
        }
      });

      if (controller.signal.aborted) {
        this.#aborted(id, entry.abortKind);
        return;
      }
      if (stop) {
        this.#fail(id, stop.code, stop.message, stop.retryable);
        return;
      }
      if (failed > 0) {
        this.#fail(
          id,
          "pages_failed",
          `${failed} page${failed === 1 ? "" : "s"} could not be written from verified evidence`,
          true,
        );
        return;
      }
      this.#authorize(record.repositoryId);
      try {
        publishWikiGeneration(db, id);
      } catch (error) {
        if (!(error instanceof WikiIntegrityError)) throw error;
        this.#fail(id, "integrity", error.message, false);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        this.#aborted(id, entry.abortKind);
        return;
      }
      if (error instanceof IndexAccessDeniedError) {
        this.#fail(id, "access_revoked", error.message, false);
        return;
      }
      if (error instanceof LookyUnavailableError) {
        this.#fail(id, "unavailable", error.message, true);
        return;
      }
      throw error;
    } finally {
      clearTimeout(timer);
      save();
      lease?.release();
    }
  }

  #fail(id: string, code: string, message: string, retryable: boolean): void {
    finishWikiGenerationUnsuccessfully(this.#db, id, { state: "failed", code, message, retryable });
  }

  #aborted(id: string, kind: AbortKind | undefined): void {
    if (kind === "timeout") {
      this.#fail(id, "budget_exhausted", TIME_LIMIT_MESSAGE, true);
      return;
    }
    finishWikiGenerationUnsuccessfully(this.#db, id, {
      state: "cancelled",
      code: kind === "close" ? "service_stopped" : "cancelled",
      message:
        kind === "close"
          ? "The service stopped before this wiki generation finished"
          : "The wiki generation was cancelled",
      retryable: true,
    });
  }

  /**
   * The draft key: commit, page identity and plan inputs, planned sources
   * with their blobs, the page's link neighbourhood and the writer fingerprint.
   */
  #draftKey(record: WikiGenerationRecord, page: WikiPageRecord, input: WikiPageInput): string {
    const material = {
      writerKey: this.writerKey,
      repositoryId: record.repositoryId,
      sha: record.sha,
      pageId: page.pageId,
      conceptKey: page.conceptKey,
      kind: page.kind,
      title: page.title,
      description: page.description,
      scopePath: page.scopePath,
      sources: input.sources.map((s) => [s.path, s.blobOid, s.startLine, s.endLine, s.kind]),
      neighbours: input.neighbours.map((n) => [n.slug, n.title, n.relation]),
    };
    return `wd-${new Bun.CryptoHasher("sha256").update(JSON.stringify(material)).digest("hex")}`;
  }

  /** Store a cached draft as the page's body when every blob it read is unchanged. */
  #reuse(
    record: WikiGenerationRecord,
    page: WikiPageRecord,
    draftKey: string,
    files: ReadonlyMap<string, string>,
  ): boolean {
    const draft = findWikiDraft(this.#db, record.repositoryId, draftKey);
    if (!draft || draft.writerKey !== this.writerKey || draft.pageId !== page.pageId) return false;
    if (!blobsCurrent(draft.inspected, files) || !blobsCurrent(draft.citations, files))
      return false;
    setWikiPageState(this.#db, record.id, page.pageId, "running");
    storeWikiPageBody(this.#db, {
      generationId: record.id,
      pageId: page.pageId,
      body: draft.body,
      citations: draft.citations,
      provenance: { ...draft.provenance, reusedDraft: true, draftCreatedAt: draft.createdAt },
      draftKey,
      usage: { ...EMPTY_WIKI_USAGE, pagesReused: 1, reused: true },
    });
    touchWikiDraft(this.#db, record.repositoryId, draftKey);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Budget ledger

type Spend = Record<
  "maxModelCalls" | "maxInputTokens" | "maxOutputTokens" | "maxSourceReads" | "maxSourceBytes",
  number
>;

const SPEND_FIELDS = [
  "maxModelCalls",
  "maxInputTokens",
  "maxOutputTokens",
  "maxSourceReads",
  "maxSourceBytes",
] as const;

/**
 * Reserves each page's budget from the generation totals before it starts
 * and settles actual spend afterwards, so pages running at once can never
 * exceed the totals together.
 */
class Ledger {
  readonly #spent: Spend = zeroSpend();
  readonly #reserved: Spend = zeroSpend();
  #inFlight = 0;
  #waiters: (() => void)[] = [];

  constructor(
    private readonly totals: WikiGenerationTotals,
    private readonly page: ModeBudget,
  ) {}

  /**
   * Reserve a page budget. When the totals cannot cover a page while other
   * pages hold reservations, wait for one of them to settle and try again,
   * since a page usually spends less than it reserved. Undefined once nothing
   * is in flight and the totals still cannot cover a page.
   */
  async reserve(remainingMs: () => number): Promise<ModeBudget | undefined> {
    for (;;) {
      const grant = this.#tryReserve(remainingMs());
      if (grant || this.#inFlight === 0) return grant;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
  }

  #tryReserve(remainingMs: number): ModeBudget | undefined {
    const grant = {} as Spend;
    for (const field of SPEND_FIELDS) {
      grant[field] = Math.min(
        this.page[field],
        this.totals[field] - this.#spent[field] - this.#reserved[field],
      );
    }
    if (
      grant.maxModelCalls < 1 ||
      grant.maxInputTokens < MIN_PAGE_INPUT_TOKENS ||
      grant.maxOutputTokens < MIN_PAGE_OUTPUT_TOKENS ||
      grant.maxSourceReads < 1 ||
      grant.maxSourceBytes < 1 ||
      remainingMs < 1
    ) {
      return undefined;
    }
    for (const field of SPEND_FIELDS) this.#reserved[field] += grant[field];
    this.#inFlight += 1;
    return { ...this.page, ...grant, maxElapsedMs: Math.min(this.page.maxElapsedMs, remainingMs) };
  }

  settle(grant: ModeBudget, used: WikiUsage): void {
    this.#inFlight -= 1;
    for (const field of SPEND_FIELDS) this.#reserved[field] -= grant[field];
    this.#spent.maxModelCalls += used.modelCalls;
    this.#spent.maxInputTokens += used.inputTokens;
    this.#spent.maxOutputTokens += used.outputTokens;
    this.#spent.maxSourceReads += used.sourceReads;
    this.#spent.maxSourceBytes += used.sourceBytes;
    for (const waiter of this.#waiters.splice(0)) waiter();
  }
}

function zeroSpend(): Spend {
  return {
    maxModelCalls: 0,
    maxInputTokens: 0,
    maxOutputTokens: 0,
    maxSourceReads: 0,
    maxSourceBytes: 0,
  };
}

// ---------------------------------------------------------------------------
// Helpers

interface CountingProvider extends ModelProvider {
  readonly counts: { reported: number; estimated: number; unknown: number };
}

/** Records whether each call's token counts were reported by the provider. */
function countingProvider(provider: ModelProvider): CountingProvider {
  const counts = { reported: 0, estimated: 0, unknown: 0 };
  return {
    id: provider.id,
    counts,
    async complete(request, signal) {
      const result = await provider.complete(request, signal);
      if (result.usageReported === true) counts.reported += 1;
      else if (result.usageReported === false) counts.estimated += 1;
      else counts.unknown += 1;
      return result;
    },
  };
}

function sessionUsage(
  session: GuardedSession,
  counter: CountingProvider,
  extra: Partial<WikiUsage>,
): WikiUsage {
  const used = session.usage();
  return addWikiUsage(EMPTY_WIKI_USAGE, {
    modelCalls: used.modelCalls,
    inputTokens: used.inputTokens,
    outputTokens: used.outputTokens,
    reportedCalls: counter.counts.reported,
    estimatedCalls: counter.counts.estimated,
    // Calls that failed before returning cannot say; they are unknown, not free.
    unknownCalls:
      counter.counts.unknown +
      Math.max(
        0,
        used.modelCalls -
          counter.counts.reported -
          counter.counts.estimated -
          counter.counts.unknown,
      ),
    retrievalPasses: used.retrievalPasses,
    sourceReads: used.sourceReads,
    sourceBytes: used.sourceBytes,
    elapsedMs: used.elapsedMs,
    ...extra,
  });
}

function pageFailure(error: unknown): string {
  if (error instanceof WikiPageError) return `${error.code}: ${error.message}`;
  if (error instanceof ModelOutputError) return `invalid_output: ${error.message}`;
  if (error instanceof BudgetExhaustedError) return `budget_exhausted: ${error.limit}`;
  return errorText(error);
}

/** Path → blob of every indexed file in an index generation. */
function indexedBlobs(db: Database, buildId: string): Map<string, string> {
  return new Map(
    db
      .query<{ path: string; blob_oid: string }, [string]>(
        "SELECT path, blob_oid FROM index_files WHERE build_id = ? AND status = 'indexed'",
      )
      .all(buildId)
      .map((row) => [row.path, row.blob_oid]),
  );
}

function blobsCurrent(
  blobs: readonly (InspectedBlob | WikiSourceRef)[],
  files: ReadonlyMap<string, string>,
): boolean {
  return blobs.every((blob) => files.get(blob.path) === blob.blobOid);
}

/**
 * Pages each page may link to: its parent, children and planned links, never
 * an unavailable page, which has no body to link to.
 */
function neighbourhoods(
  index: NonNullable<ReturnType<typeof wikiIndex>>,
): Map<string, WikiNeighbour[]> {
  const byId = new Map(index.pages.map((page) => [page.pageId, page]));
  const result = new Map<string, WikiNeighbour[]>();
  const add = (from: string, to: string | null, relation: WikiNeighbour["relation"]) => {
    const target = to === null ? undefined : byId.get(to);
    if (!target || target.state === "unavailable" || target.pageId === from) return;
    const list = result.get(from) ?? [];
    if (list.some((item) => item.slug === target.slug)) return;
    list.push({ slug: target.slug, title: target.title, relation });
    result.set(from, list);
  };
  for (const page of index.pages) {
    add(page.pageId, page.parentPageId, "parent");
    for (const child of index.pages.filter((other) => other.parentPageId === page.pageId)) {
      add(page.pageId, child.pageId, "child");
    }
  }
  for (const link of index.links) add(link.fromPageId, link.toPageId, link.relation);
  return result;
}

/** Run `work` over `items` with at most `limit` running at once. */
async function pool<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next]!;
      next += 1;
      await work(item);
    }
  });
  await Promise.all(runners);
}

function sorted(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, value[key]]),
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
