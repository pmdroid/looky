/**
 * The generated wiki of one selected revision: its state and generation
 * controls, a hierarchical page index with docs search, and one page with its
 * table of contents, breadcrumbs, related pages, exact-commit citations and a
 * question box about the page.
 *
 * - Mounted per revision selection (the caller keys it by revision id), so
 *   nothing of one revision's wiki is ever shown for another. Every request
 *   is aborted when its revision, generation or page is no longer the one on
 *   screen, and a response is applied only if it still names that place.
 * - Generation costs model calls and starts only from a button. A failed or
 *   cancelled generation is retried only from a button. The only follow-up
 *   the reader makes by itself is to ask again once the index it was waiting
 *   for is ready, which is the same request: Looky had planned nothing yet.
 * - Page text is untrusted. It is rendered through the Markdown subset, links
 *   are limited to ready pages of the same generation and to the page's own
 *   cited source links, and no HTML from the page is ever executed.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import {
  ApiError,
  isAbort,
  type BrowserApi,
  type RevisionState,
  type WikiIndexView,
  type WikiPageView,
  type WikiSearchView,
  type WikiSourceView,
  type WikiStatusView,
  type WikiTocEntry,
} from "./api";
import { abortableSleep, type AskPage } from "./ask-runner";
import { LinkPolicy } from "./links";
import { Markdown } from "./markdown";
import { shortSha } from "./presentation";
import { watchIndex } from "./index-watch";
import { validSlug } from "./route";
import {
  breadcrumbs,
  describeCoverage,
  describeStale,
  describeWiki,
  describeWikiError,
  generationProgress,
  KIND_LABEL,
  pageStateLabel,
  RELATION_LABEL,
  relatedPages,
  type WikiControl,
} from "./wiki-presentation";

/** Status checks while a generation is written: growing intervals, then the person decides. */
export const WIKI_WATCH_DELAYS_MS = [1_000, 2_000, 3_000, 5_000, 8_000, 13_000, 15_000] as const;
export const WIKI_WATCH_LIMIT_MS = 30 * 60_000;
const SEARCH_LIMIT = 10;

/** Element id of a heading on the page; prefixed so page anchors never clash with the app's ids. */
export function headingId(anchor: string): string {
  return `wiki-h-${anchor}`;
}

type Status =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly view: WikiStatusView }
  | { readonly kind: "error"; readonly message: string };

type IndexState =
  | { readonly kind: "ready"; readonly key: string; readonly view: WikiIndexView }
  | { readonly kind: "error"; readonly key: string; readonly message: string };

type PageState =
  | { readonly kind: "loading"; readonly key: string }
  | {
      readonly kind: "ready";
      readonly key: string;
      readonly view: WikiPageView;
      readonly redirectedFrom?: string;
    }
  | { readonly kind: "removed"; readonly key: string; readonly lastTitle?: string }
  | { readonly kind: "missing"; readonly key: string }
  | { readonly kind: "error"; readonly key: string; readonly message: string };

type Action =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly label: string }
  /** Generation asked for while the index is built; asked again once it is ready. */
  | { readonly kind: "waiting_index" }
  | { readonly kind: "notice"; readonly tone: "warning" | "danger"; readonly message: string };

type Search =
  | { readonly kind: "idle" }
  | { readonly kind: "loading"; readonly query: string }
  | { readonly kind: "ready"; readonly query: string; readonly view: WikiSearchView }
  | { readonly kind: "error"; readonly query: string; readonly message: string };

export interface WikiViewProps {
  readonly api: BrowserApi;
  readonly state: RevisionState;
  readonly page?: string | undefined;
  readonly anchor?: string | undefined;
  /** The app URL for a page and heading at this repository and revision. */
  readonly hrefFor: (page: string | undefined, anchor?: string) => string;
  readonly navigate: (
    page: string | undefined,
    anchor?: string,
    options?: { readonly replace?: boolean },
  ) => void;
  /** True when the error ended the session; the app then asks to sign in again. */
  readonly lost: (error: unknown) => boolean;
  /** Fresh revision state, such as index readiness seen by the reader. */
  readonly onRevisionState: (state: RevisionState) => void;
  /** Select another commit of this repository explicitly. */
  readonly onSelectSha: (sha: string) => void;
  /** Re-resolve the selection, after it ended. */
  readonly onReselect: () => void;
  /** Source controls, shown above the page index. */
  readonly controls: ReactNode;
  /** The question box for a page. */
  readonly renderAsk: (page: AskPage) => ReactNode;
}

function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function WikiView(props: WikiViewProps) {
  const { api, lost, navigate, onRevisionState } = props;
  const revisionId = props.state.revision.id;
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  const [statusNonce, setStatusNonce] = useState(0);
  const [watch, setWatch] = useState<"idle" | "gave_up">("idle");
  const [action, setAction] = useState<Action>({ kind: "idle" });
  const [index, setIndex] = useState<IndexState | undefined>();
  const [indexNonce, setIndexNonce] = useState(0);
  const [page, setPage] = useState<PageState | undefined>();
  const [pageNonce, setPageNonce] = useState(0);
  // The key of a page already shown under its new slug after a redirect, so it is not fetched again.
  const redirected = useRef<string | undefined>(undefined);
  // Latest props, for async work that outlives a render.
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });
  const titleRef = useRef<HTMLHeadingElement>(null);
  // Aborted when this revision's reader goes away; ends every wait it started.
  const life = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    return () => controller.abort();
  }, []);

  const statusView = status.kind === "ready" ? status.view : undefined;
  const generation = statusView?.ready;
  const generationId = generation?.id;

  // Wiki status of this commit; followed with growing intervals while a generation is written.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const started = Date.now();
      for (let attempt = 0; ; attempt += 1) {
        let view: WikiStatusView;
        try {
          view = await api.wikiStatus(revisionId, signal);
        } catch (error) {
          if (isAbort(error) || signal.aborted || lost(error)) return;
          setStatus({ kind: "error", message: describeWikiError(error) });
          return;
        }
        if (signal.aborted || view.revisionId !== revisionId) return;
        setStatus({ kind: "ready", view });
        const running =
          view.active && (view.active.state === "queued" || view.active.state === "running");
        if (!running) return;
        const delay = WIKI_WATCH_DELAYS_MS[Math.min(attempt, WIKI_WATCH_DELAYS_MS.length - 1)]!;
        if (Date.now() - started + delay > WIKI_WATCH_LIMIT_MS) {
          setWatch("gave_up");
          return;
        }
        try {
          await abortableSleep(delay, signal);
        } catch {
          return;
        }
      }
    })();
    return () => controller.abort();
  }, [api, revisionId, statusNonce, lost]);

  const refreshStatus = useCallback(() => {
    setWatch("idle");
    setStatusNonce((value) => value + 1);
  }, []);

  // The published generation's navigation index.
  const indexKey = generationId ? `${generationId}\n${indexNonce}` : undefined;
  useEffect(() => {
    if (!generationId || !indexKey) return;
    const controller = new AbortController();
    api
      .wikiIndex(revisionId, generationId, controller.signal)
      .then((view) => {
        if (controller.signal.aborted || view.generation.id !== generationId) return;
        setIndex({ kind: "ready", key: indexKey, view });
      })
      .catch((error: unknown) => {
        if (isAbort(error) || controller.signal.aborted || lost(error)) return;
        if (error instanceof ApiError && error.status === 409) refreshStatus();
        setIndex({ kind: "error", key: indexKey, message: describeWikiError(error) });
      });
    return () => controller.abort();
  }, [api, revisionId, generationId, indexKey, lost, refreshStatus]);

  // A retry keeps the index on screen while it reloads.
  const indexShown = index && index.key === indexKey ? index : undefined;
  const indexView =
    index?.kind === "ready" && index.view.generation.id === generationId ? index.view : undefined;
  // The landing page is the root of the index, the repository overview.
  const slug = props.page ?? indexView?.toc.slug;
  const pageKey = generationId && slug ? `${generationId}\n${slug}\n${pageNonce}` : undefined;

  // One page of the published generation.
  useEffect(() => {
    if (!generationId || !slug || !pageKey || !validSlug(slug)) return;
    // Already here after following a renamed slug to its new one.
    if (redirected.current === pageKey) {
      redirected.current = undefined;
      return;
    }
    const controller = new AbortController();
    api
      .wikiPage(revisionId, generationId, slug, controller.signal)
      .then((view) => {
        if (controller.signal.aborted || view.generation.id !== generationId) return;
        if (view.redirectedFrom !== undefined && view.page.slug !== slug) {
          // A renamed page: the same page under its current slug, never another page.
          const key = `${generationId}\n${view.page.slug}\n${pageNonce}`;
          redirected.current = key;
          setPage({ kind: "ready", key, view, redirectedFrom: view.redirectedFrom });
          navigate(view.page.slug, latest.current.anchor, { replace: true });
          return;
        }
        setPage({ kind: "ready", key: pageKey, view });
      })
      .catch((error: unknown) => {
        if (isAbort(error) || controller.signal.aborted || lost(error)) return;
        if (error instanceof ApiError && error.code === "page_removed") {
          const lastTitle = error.details?.lastTitle;
          setPage({
            kind: "removed",
            key: pageKey,
            ...(typeof lastTitle === "string" ? { lastTitle } : {}),
          });
        } else if (error instanceof ApiError && error.code === "page_not_found") {
          setPage({ kind: "missing", key: pageKey });
        } else {
          if (error instanceof ApiError && error.status === 409) refreshStatus();
          setPage({ kind: "error", key: pageKey, message: describeWikiError(error) });
        }
      });
    return () => controller.abort();
  }, [api, revisionId, generationId, slug, pageKey, pageNonce, lost, navigate, refreshStatus]);

  // Only the page for this generation and slug is shown; anything else is still loading.
  const shown: PageState | undefined = !pageKey
    ? undefined
    : slug && !validSlug(slug)
      ? { kind: "missing", key: pageKey }
      : page && page.key === pageKey
        ? page
        : { kind: "loading", key: pageKey };
  const shownPage = shown?.kind === "ready" ? shown.view : undefined;

  // Move to the heading in the URL, or to the page title when the page changes.
  const lastFocus = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!shownPage) return;
    const place = `${shownPage.generation.id}\n${shownPage.page.pageId}#${props.anchor ?? ""}`;
    if (lastFocus.current === place) return;
    const first = lastFocus.current === undefined;
    lastFocus.current = place;
    const target = props.anchor ? document.getElementById(headingId(props.anchor)) : null;
    if (target) {
      target.scrollIntoView({ block: "start" });
      target.focus({ preventScroll: true });
    } else if (!first) {
      titleRef.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0 });
    }
  }, [shownPage, props.anchor]);

  /**
   * Start, retry or cancel generation, only ever from a button. When Looky
   * must index the commit first it plans nothing and charges nothing, so the
   * same request is made once more when the index is ready.
   */
  const start = useCallback(
    async (control: WikiControl) => {
      if (control.kind === "select") {
        latest.current.onSelectSha(control.sha);
        return;
      }
      const signal = life.current?.signal;
      if (!signal || signal.aborted) return;
      setAction({ kind: "pending", label: control.label });
      try {
        if (control.kind === "cancel") {
          await api.wikiCancel(revisionId, control.generationId);
          if (signal.aborted) return;
          setAction({ kind: "idle" });
          refreshStatus();
          return;
        }
        let reply =
          control.kind === "retry"
            ? await api.wikiRetry(revisionId, control.generationId)
            : await api.wikiGenerate(revisionId);
        if (signal.aborted || reply.revisionId !== revisionId) return;
        if (reply.state === "indexing") {
          setStatus({ kind: "ready", view: reply.wiki });
          setAction({ kind: "waiting_index" });
          const settled = await watchIndex({
            api,
            revisionId,
            signal,
            onState: onRevisionState,
          });
          if (signal.aborted) return;
          const state = await api.revision(revisionId, signal);
          if (signal.aborted) return;
          onRevisionState(state);
          if (settled === "gave_up" || state.index.state !== "ready") {
            setAction({
              kind: "notice",
              tone: "danger",
              message:
                state.index.state === "failed"
                  ? "Indexing this commit failed, so no wiki can be planned."
                  : "The index is still not ready. Generate again once it is.",
            });
            refreshStatus();
            return;
          }
          setAction({ kind: "pending", label: control.label });
          reply = await api.wikiGenerate(revisionId);
          if (signal.aborted || reply.revisionId !== revisionId) return;
        }
        setStatus({ kind: "ready", view: reply.wiki });
        switch (reply.state) {
          case "indexing":
            setAction({
              kind: "notice",
              tone: "warning",
              message: "Looky is indexing this commit again. Generate once the index is ready.",
            });
            break;
          case "index_failed":
            setAction({
              kind: "notice",
              tone: "danger",
              message: `Indexing this commit failed${reply.index.code ? ` (${reply.index.code})` : ""}, so no wiki can be planned.`,
            });
            break;
          case "unsupported_revision":
            setAction({
              kind: "notice",
              tone: "danger",
              message: "Looky cannot generate a wiki for this revision.",
            });
            break;
          default:
            setAction({ kind: "idle" });
        }
        refreshStatus();
      } catch (error) {
        if (signal.aborted || isAbort(error) || lost(error)) return;
        setAction({ kind: "notice", tone: "danger", message: describeWikiError(error) });
        if (error instanceof ApiError && error.status === 409) refreshStatus();
      }
    },
    [api, revisionId, lost, onRevisionState, refreshStatus],
  );

  const wikiHref = props.hrefFor;

  const go = useCallback(
    (event: MouseEvent, target: string | undefined, anchor?: string) => {
      if (!plainClick(event)) return;
      event.preventDefault();
      navigate(target, anchor);
    },
    [navigate],
  );

  const sidebar = (
    <div className="side">
      {props.controls}
      {generationId && indexView ? (
        <WikiNav
          api={api}
          revisionId={revisionId}
          generationId={generationId}
          index={indexView}
          currentPageId={shownPage?.page.pageId}
          hrefFor={wikiHref}
          go={go}
          lost={lost}
        />
      ) : null}
    </div>
  );

  const described =
    statusView !== undefined ? describeWiki(statusView, props.state.index) : undefined;

  return (
    <>
      {sidebar}
      <section
        id="wiki-main"
        className="wiki-main"
        tabIndex={-1}
        aria-labelledby="wiki-title-heading"
      >
        <h2 id="wiki-title-heading" className="visually-hidden">
          Generated wiki
        </h2>
        {status.kind === "loading" ? (
          <p className="hint" role="status">
            Loading the wiki state…
          </p>
        ) : status.kind === "error" ? (
          <div className="notice notice-danger" role="alert">
            <p>{status.message}</p>
            <button type="button" className="button" onClick={refreshStatus}>
              Try again
            </button>
          </div>
        ) : null}

        {statusView && described && (!generation || described.busy) ? (
          <WikiState
            text={described}
            status={statusView}
            action={action}
            watch={watch}
            onControl={(control) => void start(control)}
            onCheckAgain={refreshStatus}
            onReselect={props.onReselect}
          />
        ) : null}
        {action.kind === "notice" && generation ? (
          <p className={`notice notice-${action.tone}`} role="alert">
            {action.message}
          </p>
        ) : null}

        {generation ? (
          indexShown?.kind === "error" ? (
            <div className="notice notice-danger" role="alert">
              <p>{indexShown.message}</p>
              <button
                type="button"
                className="button"
                onClick={() => setIndexNonce((value) => value + 1)}
              >
                Try again
              </button>
            </div>
          ) : !shown || shown.kind === "loading" ? (
            <p className="hint" role="status" aria-busy="true">
              Loading the page…
            </p>
          ) : shown.kind === "ready" && indexView ? (
            <WikiPage
              view={shown.view}
              index={indexView}
              landing={props.page === undefined}
              redirectedFrom={shown.redirectedFrom}
              sourceSha={props.state.revision.sha}
              titleRef={titleRef}
              hrefFor={wikiHref}
              go={go}
              renderAsk={props.renderAsk}
            />
          ) : shown.kind === "ready" ? (
            <p className="hint" role="status" aria-busy="true">
              Loading the page index…
            </p>
          ) : shown.kind === "removed" ? (
            <PageGone
              title="This page was removed"
              detail={
                shown.lastTitle
                  ? `“${shown.lastTitle}” is not part of the wiki at this commit any more. Its topic may have moved; try the index or search.`
                  : "This page is not part of the wiki at this commit any more. Try the index or search."
              }
              hrefFor={wikiHref}
              go={go}
            />
          ) : shown.kind === "missing" ? (
            <PageGone
              title="No such page"
              detail="This wiki has no page at this address. The link may be mistyped, or the page may only exist at another commit."
              hrefFor={wikiHref}
              go={go}
            />
          ) : (
            <div className="notice notice-danger" role="alert">
              <p>{shown.message}</p>
              <button
                type="button"
                className="button"
                onClick={() => setPageNonce((value) => value + 1)}
              >
                Try again
              </button>
            </div>
          )
        ) : null}
      </section>
    </>
  );
}

function WikiState(props: {
  readonly text: ReturnType<typeof describeWiki>;
  readonly status: WikiStatusView;
  readonly action: Action;
  readonly watch: "idle" | "gave_up";
  readonly onControl: (control: WikiControl) => void;
  readonly onCheckAgain: () => void;
  readonly onReselect: () => void;
}) {
  const { text, status, action } = props;
  const active = status.active;
  const progress = active ? generationProgress(active) : undefined;
  const pending = action.kind === "pending" || action.kind === "waiting_index";
  return (
    <div className={`status wiki-state tone-${text.tone}`} aria-busy={text.busy || pending}>
      <h3 className="status-title">
        {text.busy || pending ? <span className="spinner" aria-hidden="true" /> : null}
        {action.kind === "waiting_index"
          ? "Indexing this commit before writing the wiki"
          : text.title}
      </h3>
      <p className="status-detail" role="status">
        {action.kind === "waiting_index"
          ? "The wiki is planned from the code index. Generation starts as soon as the index is ready."
          : text.detail}
      </p>
      {progress && text.busy && progress.total > 0 ? (
        <progress
          className="index-progress"
          value={progress.done}
          max={progress.total}
          aria-label="Wiki pages written"
        />
      ) : null}
      {status.stale && !status.ready ? <p className="hint">{describeStale(status.stale)}</p> : null}
      {action.kind === "notice" ? (
        <p className="field-error" role="alert">
          {action.message}
          {action.message.includes("selection ended") ? (
            <>
              {" "}
              <button type="button" className="link-button" onClick={props.onReselect}>
                Re-resolve revision
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {props.watch === "gave_up" ? (
        <p className="hint">
          Stopped checking automatically.{" "}
          <button type="button" className="link-button" onClick={props.onCheckAgain}>
            Check again
          </button>
        </p>
      ) : null}
      {text.controls.length > 0 && action.kind !== "waiting_index" ? (
        <div className="status-actions">
          {text.controls.map((control) => (
            <button
              key={control.kind}
              type="button"
              className={
                control.kind === "generate" || control.kind === "retry"
                  ? "button button-primary"
                  : "button"
              }
              disabled={pending}
              onClick={() => props.onControl(control)}
            >
              {action.kind === "pending" && action.label === control.label
                ? `${control.label}…`
                : control.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PageGone(props: {
  readonly title: string;
  readonly detail: string;
  readonly hrefFor: (page: string | undefined, anchor?: string) => string;
  readonly go: (event: MouseEvent, page: string | undefined) => void;
}) {
  const ref = useRef<HTMLHeadingElement>(null);
  useEffect(() => ref.current?.focus({ preventScroll: true }), []);
  return (
    <div className="notice notice-warning page-gone">
      <h3 className="notice-title" ref={ref} tabIndex={-1}>
        {props.title}
      </h3>
      <p>{props.detail}</p>
      <p>
        <a href={props.hrefFor(undefined)} onClick={(event) => props.go(event, undefined)}>
          Go to the wiki overview
        </a>
      </p>
    </div>
  );
}

function SourceList(props: { readonly sources: readonly WikiSourceView[] }) {
  const links = new LinkPolicy(props.sources.map((source) => source.link));
  return (
    <ol className="sources">
      {props.sources.map((source) => {
        const label = `${source.path}:${source.startLine === source.endLine ? source.startLine : `${source.startLine}–${source.endLine}`}`;
        const href = links.href(source.link ?? "");
        return (
          <li key={`${source.path}:${source.startLine}:${source.endLine}`}>
            {href ? (
              <a
                className="source-link"
                href={href}
                target="_blank"
                rel="noopener noreferrer nofollow"
              >
                {label}
              </a>
            ) : (
              <code className="source-path">{label}</code>
            )}
            {source.kind !== "code" ? <span className="source-symbol"> {source.kind}</span> : null}
          </li>
        );
      })}
    </ol>
  );
}

function WikiPage({
  titleRef,
  ...props
}: {
  readonly view: WikiPageView;
  readonly index: WikiIndexView;
  readonly landing: boolean;
  readonly redirectedFrom: string | undefined;
  readonly sourceSha: string;
  readonly titleRef: RefObject<HTMLHeadingElement | null>;
  readonly hrefFor: (page: string | undefined, anchor?: string) => string;
  readonly go: (event: MouseEvent, page: string | undefined, anchor?: string) => void;
  readonly renderAsk: (page: AskPage) => ReactNode;
}) {
  const { view, index, go, hrefFor } = props;
  const { page, generation } = view;
  const readySlugs = new Set(
    index.pages.filter((item) => item.state === "ready").map((item) => item.slug),
  );
  const links = new LinkPolicy(
    view.citations.map((citation) => citation.link),
    { slugs: readySlugs, href: (slug) => hrefFor(slug) },
  );
  const crumbs = breadcrumbs(index.pages, page.pageId);
  const related = relatedPages(index, page.pageId);
  const coverage = props.landing ? describeCoverage(index) : undefined;
  const anchors = { list: view.headings.map((heading) => heading.anchor), idFor: headingId };
  const askPage: AskPage | undefined =
    page.state === "ready" && view.body
      ? { generationId: generation.id, pageId: page.pageId, slug: page.slug, title: page.title }
      : undefined;

  // In-page wiki links move within the app, like the index links do.
  function onProseClick(event: MouseEvent<HTMLDivElement>) {
    const anchor = (event.target as Element).closest?.("a[data-wiki-slug]");
    if (!anchor) return;
    const slug = anchor.getAttribute("data-wiki-slug");
    if (slug) go(event, slug);
  }

  return (
    <article className="wiki-page" aria-labelledby="wiki-page-title">
      {crumbs.length > 1 ? (
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <ol>
            {crumbs.map((crumb, position) => (
              <li key={crumb.pageId}>
                {position === crumbs.length - 1 ? (
                  <span aria-current="page">{crumb.title}</span>
                ) : (
                  <a href={hrefFor(crumb.slug)} onClick={(event) => go(event, crumb.slug)}>
                    {crumb.title}
                  </a>
                )}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      <header className="wiki-head">
        <p className="wiki-kind">{KIND_LABEL[page.kind]}</p>
        <h1 id="wiki-page-title" ref={titleRef} tabIndex={-1} dir="auto">
          {page.title}
        </h1>
        {page.description ? (
          <p className="wiki-description" dir="auto">
            {page.description}
          </p>
        ) : null}
        <dl className="wiki-provenance">
          <div>
            <dt>Source revision</dt>
            <dd>
              <code className="sha" title={props.sourceSha}>
                {shortSha(props.sourceSha)}
              </code>
            </dd>
          </div>
          <div>
            <dt>Generated from</dt>
            <dd>
              <code className="sha" title={generation.sha}>
                {shortSha(generation.sha)}
              </code>
              {view.body ? ` on ${new Date(view.body.generatedAt).toLocaleString()}` : ""}
            </dd>
          </div>
          {page.scopePath ? (
            <div>
              <dt>Covers</dt>
              <dd>
                <code className="source-path">{page.scopePath}</code>
              </dd>
            </div>
          ) : null}
        </dl>
        {generation.current === false ? (
          <p className="notice notice-warning">
            This is not the current wiki for this commit. A newer generation replaced it.
          </p>
        ) : null}
        <p className="wiki-notice">{view.notice}</p>
      </header>

      {props.redirectedFrom ? (
        <p className="notice" role="status">
          This page moved from <code>{props.redirectedFrom}</code>. The address now shows its
          current name.
        </p>
      ) : null}

      {coverage && (coverage.lines.length > 0 || coverage.disclosures.length > 0) ? (
        <section className="wiki-coverage" aria-labelledby="coverage-title">
          <h2 id="coverage-title" className="section-title">
            Coverage
          </h2>
          <ul>
            {coverage.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
            {coverage.disclosures.map((line) => (
              <li key={line} dir="auto">
                {line}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.headings.length > 1 ? (
        <nav className="page-toc" aria-labelledby="page-toc-title">
          <h2 id="page-toc-title" className="section-title">
            On this page
          </h2>
          <ol>
            {view.headings.map((heading) => (
              <li key={heading.anchor} className={`toc-level-${Math.min(heading.level, 4)}`}>
                <a
                  href={hrefFor(page.slug, heading.anchor)}
                  onClick={(event) => go(event, page.slug, heading.anchor)}
                  dir="auto"
                >
                  {heading.text}
                </a>
              </li>
            ))}
          </ol>
        </nav>
      ) : null}

      {view.body ? (
        // oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions
        <div className="prose wiki-prose" onClick={onProseClick}>
          <Markdown text={view.body.markdown} links={links} headingBase={1} anchors={anchors} />
        </div>
      ) : (
        <div className="notice notice-warning">
          <p className="notice-title">
            This page has no generated text ({pageStateLabel(page.state)})
          </p>
          <p>
            {page.unavailableReason ??
              "Its sources are listed below; ask a question about them for an explanation."}
          </p>
        </div>
      )}

      {related.length > 0 ? (
        <section className="answer-section" aria-labelledby="related-title">
          <h2 id="related-title" className="section-title">
            Related pages
          </h2>
          <ul className="related">
            {related.map(({ page: other, relation }) => (
              <li key={other.pageId}>
                <span className="related-relation">{RELATION_LABEL[relation]}</span>{" "}
                <a href={hrefFor(other.slug)} onClick={(event) => go(event, other.slug)} dir="auto">
                  {other.title}
                </a>
                {other.description ? (
                  <span className="related-description" dir="auto">
                    {" "}
                    {other.description}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="answer-section" aria-labelledby="citations-title">
        <h2 id="citations-title" className="section-title">
          Sources at <code className="sha">{shortSha(generation.sha)}</code>
        </h2>
        {view.citations.length > 0 ? (
          <SourceList sources={view.citations} />
        ) : (
          <p className="hint">This page cites no source ranges.</p>
        )}
        {view.plannedSources.length > 0 ? (
          <details className="planned">
            <summary>Files this page was planned from ({view.plannedSources.length})</summary>
            <SourceList sources={view.plannedSources} />
          </details>
        ) : null}
      </section>

      {askPage ? props.renderAsk(askPage) : null}
    </article>
  );
}

function WikiNav(props: {
  readonly api: BrowserApi;
  readonly revisionId: string;
  readonly generationId: string;
  readonly index: WikiIndexView;
  readonly currentPageId: string | undefined;
  readonly hrefFor: (page: string | undefined, anchor?: string) => string;
  readonly go: (event: MouseEvent, page: string | undefined, anchor?: string) => void;
  readonly lost: (error: unknown) => boolean;
}) {
  const { api, revisionId, generationId, lost } = props;
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<Search>({ kind: "idle" });
  const [more, setMore] = useState(false);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);

  async function run(q: string, offset = 0) {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    if (offset === 0) setSearch({ kind: "loading", query: q });
    else setMore(true);
    try {
      const view = await api.wikiSearch(
        revisionId,
        generationId,
        { q, limit: SEARCH_LIMIT, offset },
        current.signal,
      );
      if (current.signal.aborted || view.generation.id !== generationId) return;
      setSearch((previous) =>
        offset > 0 && previous.kind === "ready" && previous.query === q
          ? {
              kind: "ready",
              query: q,
              view: { ...view, hits: [...previous.view.hits, ...view.hits] },
            }
          : { kind: "ready", query: q, view },
      );
    } catch (error) {
      if (isAbort(error) || current.signal.aborted || lost(error)) return;
      setSearch({
        kind: "error",
        query: q,
        message:
          error instanceof ApiError && error.code === "query_empty"
            ? "Enter at least one word to search for."
            : describeWikiError(error),
      });
    } finally {
      if (controller.current === current) setMore(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = query.trim();
    if (!q) return;
    void run(q);
  }

  function clear() {
    controller.current?.abort();
    setQuery("");
    setSearch({ kind: "idle" });
  }

  function onKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape" && (query || search.kind !== "idle")) {
      event.preventDefault();
      clear();
    }
  }

  return (
    <nav className="wiki-nav" aria-label="Wiki">
      <form role="search" className="field wiki-search" onSubmit={submit}>
        <label htmlFor="wiki-search">Search the docs</label>
        <div className="inline-row">
          <input
            id="wiki-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKey}
            autoComplete="off"
            maxLength={200}
            aria-describedby="wiki-search-help"
          />
          <button type="submit" className="button">
            Search
          </button>
        </div>
        <p id="wiki-search-help" className="hint">
          Searches this commit's generated pages, not the source.
        </p>
      </form>

      <div aria-live="polite">
        {search.kind === "loading" ? <p className="hint">Searching…</p> : null}
        {search.kind === "error" ? <p className="field-error">{search.message}</p> : null}
        {search.kind === "ready" ? (
          <section className="search-results" aria-labelledby="search-results-title">
            <h2 id="search-results-title" className="section-title">
              {search.view.total === 0
                ? `No pages match “${search.query}”`
                : `${search.view.total.toLocaleString()}${search.view.totalCapped ? "+" : ""} ${search.view.total === 1 ? "match" : "matches"} for “${search.query}”`}
            </h2>
            <ol>
              {search.view.hits.map((hit, position) => (
                <li key={`${hit.pageId}:${hit.anchor ?? ""}:${position}`}>
                  <a
                    href={props.hrefFor(hit.slug, hit.anchor ?? undefined)}
                    onClick={(event) => props.go(event, hit.slug, hit.anchor ?? undefined)}
                  >
                    <span className="hit-title" dir="auto">
                      {hit.title}
                    </span>
                    {hit.heading ? (
                      <span className="hit-heading" dir="auto">
                        {" "}
                        › {hit.heading}
                      </span>
                    ) : null}
                  </a>
                  <p className="hit-snippet" dir="auto">
                    {hit.snippet.map((part, at) =>
                      part.match ? (
                        <mark key={at}>{part.text}</mark>
                      ) : (
                        <span key={at}>{part.text}</span>
                      ),
                    )}
                  </p>
                </li>
              ))}
            </ol>
            <div className="inline-row">
              {search.view.nextOffset !== undefined ? (
                <button
                  type="button"
                  className="link-button"
                  disabled={more}
                  onClick={() => void run(search.query, search.view.nextOffset)}
                >
                  {more ? "Loading…" : "More results"}
                </button>
              ) : null}
              <button type="button" className="link-button" onClick={clear}>
                Clear search
              </button>
            </div>
          </section>
        ) : null}
      </div>

      <h2 className="section-title" id="wiki-index-title">
        Pages
      </h2>
      <TocTree
        entries={[props.index.toc]}
        current={props.currentPageId}
        hrefFor={props.hrefFor}
        go={props.go}
        labelledBy="wiki-index-title"
      />
    </nav>
  );
}

function TocTree(props: {
  readonly entries: readonly WikiTocEntry[];
  readonly current: string | undefined;
  readonly hrefFor: (page: string | undefined, anchor?: string) => string;
  readonly go: (event: MouseEvent, page: string | undefined) => void;
  readonly labelledBy?: string;
}) {
  return (
    <ul className="toc-tree" {...(props.labelledBy ? { "aria-labelledby": props.labelledBy } : {})}>
      {props.entries.map((entry) => (
        <li key={entry.pageId}>
          {entry.state === "ready" ? (
            <a
              href={props.hrefFor(entry.slug)}
              onClick={(event) => props.go(event, entry.slug)}
              aria-current={entry.pageId === props.current ? "page" : undefined}
              title={entry.description || undefined}
              dir="auto"
            >
              {entry.title}
            </a>
          ) : (
            <span className="toc-unavailable" title={entry.unavailableReason ?? undefined}>
              <span dir="auto">{entry.title}</span>{" "}
              <span className="toc-state">({pageStateLabel(entry.state)})</span>
            </span>
          )}
          {entry.children.length > 0 ? (
            <TocTree
              entries={entry.children}
              current={props.current}
              hrefFor={props.hrefFor}
              go={props.go}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
}
