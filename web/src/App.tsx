/**
 * Looky's app: sign in, choose an authorized repository and committed
 * revision, then either ask a code question in Fast or Deep, or read the
 * revision's generated wiki and ask about one of its pages.
 *
 * State lives in memory only. Question text survives errors and a new
 * sign-in, but nothing is written to browser storage. The view, repository,
 * ref and wiki page are mirrored in the URL (see `route.ts`), so a reload, a
 * shared link or Back/Forward returns to the same place, never to a question
 * or an answer.
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
  BrowserApi,
  isAbort,
  type Mode,
  type RefListing,
  type RevisionState,
  type SessionState,
} from "./api";
import { AskRunner, type AskPage, type AskSnapshot, type AskState } from "./ask-runner";
import { AnswerView } from "./AnswerView";
import { watchIndex } from "./index-watch";
import {
  type Action,
  announce,
  describeAsk,
  describeIndex,
  displayRef,
  MODE_LABEL,
  refValue,
  shortSha,
} from "./presentation";
import { parseRoute, routeHref, type Route, type View } from "./route";
import { WikiView } from "./WikiView";

const AUTH_CODES = new Set(["unauthenticated", "session_expired"]);
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

type Auth =
  | { readonly kind: "checking" }
  | {
      readonly kind: "signed_out";
      readonly auth: "local" | "token";
      readonly expired?: boolean;
      readonly error?: string;
    }
  | { readonly kind: "signed_in"; readonly session: SessionState }
  | { readonly kind: "unreachable"; readonly message: string };

export function App(props: { readonly api?: BrowserApi }) {
  const [api] = useState(() => props.api ?? new BrowserApi());
  const [auth, setAuth] = useState<Auth>({ kind: "checking" });
  // Kept here so an expired session or an error never loses what was typed.
  const [question, setQuestion] = useState("");
  const [pageQuestion, setPageQuestion] = useState("");
  const [mode, setMode] = useState<Mode>("fast");
  const [view, setView] = useState<View>(() => parseRoute(window.location).view);

  // One session check at a time, even when an effect runs twice.
  const loading = useRef<Promise<void> | undefined>(undefined);
  const load = useCallback((): Promise<void> => {
    loading.current ??= (async () => {
      try {
        const session = await api.session();
        if (session.authenticated) {
          setAuth({ kind: "signed_in", session });
        } else if (session.auth === "local") {
          // Local sign-in needs no credential; Looky allows it only on loopback.
          setAuth({ kind: "signed_in", session: await api.signIn() });
        } else {
          setAuth({
            kind: "signed_out",
            auth: session.auth,
            ...(session.expired ? { expired: true } : {}),
          });
        }
      } catch (error) {
        setAuth({
          kind: "unreachable",
          message: error instanceof ApiError ? error.message : "Looky could not be reached.",
        });
      } finally {
        loading.current = undefined;
      }
    })();
    return loading.current;
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  const check = useCallback(() => {
    setAuth({ kind: "checking" });
    void load();
  }, [load]);

  const onSessionLost = useCallback(() => {
    api.forget();
    check();
  }, [api, check]);

  const signOut = useCallback(async () => {
    try {
      await api.signOut();
    } catch {
      // Signed out locally either way.
    }
    check();
  }, [api, check]);

  return (
    <div className="shell">
      {view === "wiki" ? (
        <a
          className="skip-link"
          href="#wiki-main"
          onClick={(event) => {
            // Focus without a fragment, so the page's own heading anchor stays in the URL.
            event.preventDefault();
            document.getElementById("wiki-main")?.focus();
          }}
        >
          Skip to the page
        </a>
      ) : (
        <a className="skip-link" href="#question">
          Skip to the question
        </a>
      )}
      <header className="masthead">
        <p className="wordmark">
          Looky<span className="wordmark-note">code answers</span>
        </p>
        {auth.kind === "signed_in" && auth.session.auth === "token" ? (
          <button type="button" className="button button-quiet" onClick={() => void signOut()}>
            Sign out
          </button>
        ) : null}
      </header>
      {auth.kind === "checking" ? (
        <main className="centered" aria-busy="true">
          <p role="status">Connecting to Looky…</p>
        </main>
      ) : auth.kind === "unreachable" ? (
        <main className="centered">
          <div className="notice notice-danger" role="alert">
            <p className="notice-title">Looky is not reachable</p>
            <p>{auth.message}</p>
            <button type="button" className="button" onClick={check}>
              Try again
            </button>
          </div>
        </main>
      ) : auth.kind === "signed_out" ? (
        <SignIn
          api={api}
          state={auth}
          onSignedIn={(session) => setAuth({ kind: "signed_in", session })}
        />
      ) : (
        <Workspace
          api={api}
          question={question}
          onQuestion={setQuestion}
          pageQuestion={pageQuestion}
          onPageQuestion={setPageQuestion}
          onView={setView}
          mode={mode}
          onMode={setMode}
          onSessionLost={onSessionLost}
        />
      )}
    </div>
  );
}

function SignIn(props: {
  readonly api: BrowserApi;
  readonly state: Extract<Auth, { kind: "signed_out" }>;
  readonly onSignedIn: (session: SessionState) => void;
}) {
  const [token, setToken] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(props.state.error);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(undefined);
    try {
      const session = await props.api.signIn(props.state.auth === "token" ? token : undefined);
      setToken("");
      props.onSignedIn(session);
    } catch (failure) {
      setError(failure instanceof ApiError ? failure.message : "Sign-in failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="centered">
      <form className="sign-in" onSubmit={(event) => void submit(event)}>
        <h1>Sign in to Looky</h1>
        {props.state.expired ? <p>Your session ended. Sign in again to keep asking.</p> : null}
        {props.state.auth === "token" ? (
          <div className="field">
            <label htmlFor="token">Access token</label>
            <input
              id="token"
              type="password"
              autoComplete="current-password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              required
              aria-describedby="token-help"
            />
            <p id="token-help" className="hint">
              The token is sent once. This page does not store it.
            </p>
          </div>
        ) : null}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="button button-primary" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}

type Repos =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly ids: readonly string[] }
  | { readonly status: "error"; readonly message: string };

type Refs =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly repositoryId: string }
  | { readonly status: "ready"; readonly repositoryId: string; readonly listing: RefListing }
  | { readonly status: "error"; readonly repositoryId: string; readonly message: string };

type Selection =
  | { readonly status: "none" }
  | { readonly status: "resolving"; readonly repositoryId: string; readonly ref: string }
  | { readonly status: "ready"; readonly state: RevisionState }
  | {
      readonly status: "error";
      readonly repositoryId: string;
      readonly ref: string;
      readonly message: string;
    };

/** A repository and ref the person asked for; `nonce` forces a fresh resolution. */
interface Target {
  readonly repositoryId: string;
  readonly ref: string;
  readonly nonce: number;
}

/** Where in the app: the view and, for the wiki, the page and heading. */
type Place = Pick<Route, "view" | "page" | "anchor">;

function readLocation(): Route {
  return parseRoute(window.location);
}

function placeOf(route: Route): Place {
  return {
    view: route.view,
    ...(route.page !== undefined ? { page: route.page } : {}),
    ...(route.anchor !== undefined ? { anchor: route.anchor } : {}),
  };
}

/** The commit a choice resolved to; `nonce` names the choice. */
interface Pinned {
  readonly nonce: number;
  readonly sha: string;
}

/**
 * The URL for a place at a choice. A wiki address names the exact commit the
 * choice resolved to, never a branch or tag that can move: reloading or
 * sharing it shows the same documentation. Until the choice resolves, and on
 * the code question screen, it names the ref as chosen.
 */
function hrefOf(target: Target | undefined, place: Place, pinned: Pinned | undefined): string {
  const sha =
    place.view === "wiki" && pinned && pinned.nonce === target?.nonce ? pinned.sha : undefined;
  return routeHref({
    ...place,
    ...(target ? { repo: target.repositoryId, ref: sha ?? target.ref } : {}),
  });
}

function writeLocation(
  target: Target | undefined,
  place: Place,
  push: boolean,
  pinned: Pinned | undefined,
): void {
  const next = hrefOf(target, place, pinned);
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) return;
  if (push) window.history.pushState(null, "", next);
  else window.history.replaceState(null, "", next);
}

function plainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

function refLabel(listing: RefListing | undefined, ref: string): string {
  if (ref === "HEAD") {
    return listing?.head?.branch ? `HEAD (${listing.head.branch})` : "HEAD";
  }
  return displayRef(ref);
}

function Workspace(props: {
  readonly api: BrowserApi;
  readonly question: string;
  readonly onQuestion: (value: string) => void;
  readonly pageQuestion: string;
  readonly onPageQuestion: (value: string) => void;
  readonly mode: Mode;
  readonly onMode: (mode: Mode) => void;
  readonly onView: (view: View) => void;
  readonly onSessionLost: () => void;
}) {
  const { api, onSessionLost, onView } = props;
  const [repos, setRepos] = useState<Repos>({ status: "loading" });
  const [refs, setRefs] = useState<Refs>({ status: "idle" });
  const [target, setTarget] = useState<Target | undefined>();
  const [selection, setSelection] = useState<Selection>({ status: "none" });
  const [place, setPlace] = useState<Place>(() => placeOf(readLocation()));
  const [shaInput, setShaInput] = useState("");
  const [shaError, setShaError] = useState<string | undefined>();
  const [ask, setAsk] = useState<AskState>({ kind: "idle" });
  // Counts state changes, so a next-action button starts fresh for each outcome.
  const [askSeq, setAskSeq] = useState(0);
  const [watch, setWatch] = useState<"idle" | "gave_up">("idle");
  const [watchNonce, setWatchNonce] = useState(0);
  const runnerRef = useRef<AskRunner | undefined>(undefined);
  const questionRef = useRef<HTMLTextAreaElement>(null);
  const resultRef = useRef<HTMLHeadingElement>(null);
  const nonce = useRef(0);
  // The latest choice and place, for history events that arrive between renders.
  const targetRef = useRef<Target | undefined>(undefined);
  const placeRef = useRef<Place>(place);
  // The commit the current choice resolved to, for addresses that must not move.
  const [pinned, setPinned] = useState<Pinned | undefined>();
  const pinnedRef = useRef<Pinned | undefined>(undefined);

  useEffect(() => onView(place.view), [place.view, onView]);

  const lost = useCallback(
    (error: unknown): boolean => {
      if (error instanceof ApiError && error.status === 401 && AUTH_CODES.has(error.code)) {
        onSessionLost();
        return true;
      }
      return false;
    },
    [onSessionLost],
  );

  // One runner for this signed-in workspace; leaving or unmounting cancels its question.
  useEffect(() => {
    const runner = new AskRunner({
      api,
      onState: (state) => {
        setAsk(state);
        setAskSeq((value) => value + 1);
      },
      onIndex: (state) =>
        setSelection((current) =>
          current.status === "ready" && current.state.revision.id === state.revision.id
            ? { status: "ready", state }
            : current,
        ),
    });
    runnerRef.current = runner;
    const leave = () => runner.detach({ keepalive: true });
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      runner.detach();
      runnerRef.current = undefined;
    };
  }, [api]);

  // A finished question that ended in a lost session sends the person to sign in.
  useEffect(() => {
    if (ask.kind === "error" && ask.status === 401 && AUTH_CODES.has(ask.code)) onSessionLost();
  }, [ask, onSessionLost]);

  /** Forget the running question and its answer: they belong to the place being left. */
  const leaveQuestion = useCallback(() => {
    runnerRef.current?.detach();
    // Cleared here as well, whether or not a question is running: a finished
    // answer or error, and the actions bound to its snapshot, never outlive it.
    setAsk({ kind: "idle" });
    setAskSeq((value) => value + 1);
  }, []);

  /**
   * Choose a repository and ref. The running question is detached and the
   * current answer cleared, so nothing from the previous selection is shown
   * against the new one. The view and wiki page stay, so the same page can be
   * read at another revision.
   */
  const choose = useCallback(
    (repositoryId: string, ref: string, push = true) => {
      leaveQuestion();
      nonce.current += 1;
      const next = { repositoryId, ref, nonce: nonce.current };
      writeLocation(next, placeRef.current, push, undefined);
      setRefs((current) =>
        current.status !== "idle" && current.repositoryId === repositoryId
          ? current
          : { status: "loading", repositoryId },
      );
      setSelection({ status: "resolving", repositoryId, ref });
      setWatch("idle");
      targetRef.current = next;
      setTarget(next);
    },
    [leaveQuestion],
  );

  /**
   * Go to a view, wiki page or heading at the current selection. Another view
   * or page detaches the running question, so a late answer never appears
   * under a page it was not asked about. A heading on the same page keeps it.
   */
  const go = useCallback(
    (next: Place, options: { readonly replace?: boolean } = {}) => {
      const current = placeRef.current;
      if (current.view !== next.view || current.page !== next.page) leaveQuestion();
      placeRef.current = next;
      writeLocation(targetRef.current, next, !options.replace, pinnedRef.current);
      setPlace(next);
    },
    [leaveQuestion],
  );

  const navigateWiki = useCallback(
    (page: string | undefined, anchor?: string, options?: { readonly replace?: boolean }) =>
      go(
        {
          view: "wiki",
          ...(page !== undefined ? { page } : {}),
          ...(page !== undefined && anchor !== undefined ? { anchor } : {}),
        },
        options,
      ),
    [go],
  );

  const wikiHref = useCallback(
    (page: string | undefined, anchor?: string) =>
      hrefOf(
        target,
        {
          view: "wiki",
          ...(page !== undefined ? { page } : {}),
          ...(page !== undefined && anchor !== undefined ? { anchor } : {}),
        },
        pinned,
      ),
    [target, pinned],
  );

  // Authorized repositories.
  useEffect(() => {
    const controller = new AbortController();
    api
      .repositories(controller.signal)
      .then(({ repositories }) => {
        const ids = repositories.map((repo) => repo.id);
        setRepos({ status: "ready", ids });
        const wanted = readLocation();
        const repositoryId = wanted.repo && ids.includes(wanted.repo) ? wanted.repo : ids[0];
        if (repositoryId) {
          choose(
            repositoryId,
            wanted.repo === repositoryId && wanted.ref ? wanted.ref : "HEAD",
            false,
          );
        }
      })
      .catch((error: unknown) => {
        if (isAbort(error) || lost(error)) return;
        setRepos({
          status: "error",
          message: error instanceof ApiError ? error.message : "Repositories could not be loaded.",
        });
      });
    return () => controller.abort();
  }, [api, choose, lost]);

  // Back and forward move between selections, views and pages like any other change.
  useEffect(() => {
    const onPop = () => {
      const wanted = readLocation();
      const nextPlace = placeOf(wanted);
      const currentPlace = placeRef.current;
      if (nextPlace.view !== currentPlace.view || nextPlace.page !== currentPlace.page) {
        leaveQuestion();
      }
      // A fragment link, such as the skip link, also fires popstate. Outside
      // the wiki the place stays, so its question and answer stay too.
      if (nextPlace.view === "wiki" || currentPlace.view === "wiki") {
        placeRef.current = nextPlace;
        setPlace(nextPlace);
      }
      if (repos.status !== "ready") return;
      const repositoryId =
        wanted.repo && repos.ids.includes(wanted.repo) ? wanted.repo : repos.ids[0];
      const ref = wanted.ref ?? "HEAD";
      const current = targetRef.current;
      // A wiki address names the commit the current choice resolved to: the same choice.
      const sha = pinnedRef.current?.nonce === current?.nonce ? pinnedRef.current?.sha : undefined;
      if (
        current &&
        current.repositoryId === repositoryId &&
        (current.ref === ref || sha === ref)
      ) {
        return;
      }
      if (repositoryId) choose(repositoryId, ref, false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [repos, choose, leaveQuestion]);

  const repositoryId = target?.repositoryId;

  // Branches and tags of the chosen repository.
  useEffect(() => {
    if (!repositoryId) return;
    const controller = new AbortController();
    api
      .refs(repositoryId, controller.signal)
      .then((listing) => {
        if (listing.repositoryId === repositoryId) {
          setRefs({ status: "ready", repositoryId, listing });
        }
      })
      .catch((error: unknown) => {
        if (isAbort(error) || lost(error)) return;
        setRefs({
          status: "error",
          repositoryId,
          message: error instanceof ApiError ? error.message : "Branches could not be loaded.",
        });
      });
    return () => controller.abort();
  }, [api, repositoryId, lost]);

  // Resolve the chosen ref to an exact commit. A new choice detaches the running question.
  useEffect(() => {
    if (!target) return;
    const controller = new AbortController();
    api
      .selectRevision(target.repositoryId, target.ref, controller.signal)
      .then((state) => {
        if (controller.signal.aborted || state.revision.repositoryId !== target.repositoryId)
          return;
        setSelection({ status: "ready", state });
        const resolved = { nonce: target.nonce, sha: state.revision.sha };
        pinnedRef.current = resolved;
        setPinned(resolved);
        // A wiki address now names the exact commit, so a reload shows the same wiki.
        if (targetRef.current === target) {
          writeLocation(target, placeRef.current, false, resolved);
        }
      })
      .catch((error: unknown) => {
        if (isAbort(error) || lost(error)) return;
        setSelection({
          status: "error",
          repositoryId: target.repositoryId,
          ref: target.ref,
          message:
            error instanceof ApiError ? error.message : "The revision could not be selected.",
        });
      });
    return () => controller.abort();
  }, [api, target, lost]);

  const revisionId = selection.status === "ready" ? selection.state.revision.id : undefined;
  const indexState = selection.status === "ready" ? selection.state.index.state : undefined;
  const runnerIndexing = ask.kind === "indexing";

  const onRevisionState = useCallback(
    (state: RevisionState) =>
      setSelection((current) =>
        current.status === "ready" && current.state.revision.id === state.revision.id
          ? { status: "ready", state }
          : current,
      ),
    [],
  );

  // Follow index readiness with bounded, growing intervals until ready or failed.
  useEffect(() => {
    if (!revisionId || runnerIndexing) return;
    if (indexState !== "building" && indexState !== "not_indexed") return;
    const controller = new AbortController();
    watchIndex({
      api,
      revisionId,
      signal: controller.signal,
      onState: onRevisionState,
    })
      .then((result) => {
        if (!controller.signal.aborted) setWatch(result === "gave_up" ? "gave_up" : "idle");
      })
      .catch((error: unknown) => {
        if (isAbort(error) || controller.signal.aborted || lost(error)) return;
        setWatch("gave_up");
      });
    return () => controller.abort();
  }, [api, revisionId, indexState, runnerIndexing, watchNonce, lost, onRevisionState]);

  // Move focus to the outcome so it is read out and reachable from the keyboard.
  const finished = ask.kind === "result" || ask.kind === "error" || ask.kind === "cancelled";
  useEffect(() => {
    if (finished) resultRef.current?.focus();
  }, [ask, finished]);

  const active = ask.kind !== "idle" && !finished;
  const ready = selection.status === "ready" && selection.state.revision.active;
  const ended = selection.status === "ready" && !selection.state.revision.active;

  function start(snapshot: AskSnapshot) {
    runnerRef.current?.ask(snapshot);
  }

  function submitWith(text: string, page?: AskPage) {
    if (!text.trim() || !ready || active || selection.status !== "ready") return;
    const { revision } = selection.state;
    start({
      question: text,
      mode: props.mode,
      repositoryId: revision.repositoryId,
      sha: revision.sha,
      revisionId: revision.id,
      ...(revision.ref !== undefined ? { ref: revision.ref } : {}),
      ...(page ? { wikiPage: page } : {}),
    });
  }

  function act(action: Action) {
    const previous = ask.kind === "idle" ? undefined : "snapshot" in ask ? ask.snapshot : undefined;
    // A snapshot only ever repeats against the selection it was taken for.
    const snapshot =
      previous &&
      selection.status === "ready" &&
      selection.state.revision.active &&
      selection.state.revision.id === previous.revisionId &&
      selection.state.revision.sha === previous.sha &&
      selection.state.revision.repositoryId === previous.repositoryId
        ? previous
        : undefined;
    switch (action.kind) {
      case "edit":
        questionRef.current?.focus();
        return;
      case "reselect":
        if (target) choose(target.repositoryId, target.ref, false);
        return;
      case "retry":
        if (snapshot) start(snapshot);
        return;
      case "deep":
        if (snapshot) {
          props.onMode("deep");
          start({ ...snapshot, mode: "deep" });
        }
        return;
    }
  }

  function submitSha(event: FormEvent) {
    event.preventDefault();
    const sha = shaInput.trim().toLowerCase();
    if (!FULL_SHA.test(sha)) {
      setShaError("Enter a full commit SHA: 40 or 64 hexadecimal characters.");
      return;
    }
    setShaError(undefined);
    if (repositoryId) choose(repositoryId, sha);
  }

  const listing = refs.status === "ready" ? refs.listing : undefined;
  const currentRef = target?.ref ?? "HEAD";
  const knownRef =
    currentRef === "HEAD" ||
    (listing?.refs.some((ref) => refValue(ref) === currentRef) ?? false) ||
    FULL_SHA.test(currentRef);
  const indexInfo = selection.status === "ready" ? describeIndex(selection.state.index) : undefined;

  const controls = (
    <section className="controls" aria-labelledby="controls-title">
      <h2 id="controls-title" className="section-title">
        Source
      </h2>
      {repos.status === "error" ? (
        <p className="field-error" role="alert">
          {repos.message}
        </p>
      ) : repos.status === "ready" && repos.ids.length === 0 ? (
        <p className="notice notice-warning">
          No repository is available to this browser client. Ask the Looky operator to allow one.
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="repository">Repository</label>
        <select
          id="repository"
          value={repositoryId ?? ""}
          disabled={repos.status !== "ready" || repos.ids.length === 0}
          onChange={(event) => choose(event.target.value, "HEAD")}
        >
          {repos.status !== "ready" ? <option value="">Loading…</option> : null}
          {repos.status === "ready"
            ? repos.ids.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))
            : null}
        </select>
      </div>

      <div className="field">
        <label htmlFor="revision">Revision</label>
        <select
          id="revision"
          value={currentRef}
          disabled={!repositoryId || refs.status === "loading"}
          onChange={(event) => repositoryId && choose(repositoryId, event.target.value)}
          aria-describedby="revision-help"
        >
          <option value="HEAD">{refLabel(listing, "HEAD")}</option>
          {!knownRef ? <option value={currentRef}>{refLabel(listing, currentRef)}</option> : null}
          {FULL_SHA.test(currentRef) ? (
            <option value={currentRef}>Commit {shortSha(currentRef)}</option>
          ) : null}
          {listing && listing.refs.some((ref) => ref.kind === "branch") ? (
            <optgroup label="Branches">
              {listing.refs
                .filter((ref) => ref.kind === "branch")
                .map((ref) => (
                  <option key={`b:${ref.name}`} value={refValue(ref)}>
                    {ref.name}
                  </option>
                ))}
            </optgroup>
          ) : null}
          {listing && listing.refs.some((ref) => ref.kind === "tag") ? (
            <optgroup label="Tags">
              {listing.refs
                .filter((ref) => ref.kind === "tag")
                .map((ref) => (
                  <option key={`t:${ref.name}`} value={refValue(ref)}>
                    {ref.name}
                  </option>
                ))}
            </optgroup>
          ) : null}
        </select>
        <p id="revision-help" className="hint">
          {refs.status === "error"
            ? refs.message
            : listing?.truncated
              ? "Only the most recent branches and tags are listed. Enter a commit SHA for others."
              : "Looky answers from the committed source of the chosen revision."}
        </p>
      </div>

      <form className="field sha-form" onSubmit={submitSha}>
        <label htmlFor="sha">Or a commit SHA</label>
        <div className="inline-row">
          <input
            id="sha"
            className="mono"
            inputMode="text"
            autoComplete="off"
            spellCheck={false}
            value={shaInput}
            onChange={(event) => setShaInput(event.target.value)}
            aria-invalid={shaError ? true : undefined}
            aria-describedby={shaError ? "sha-error" : undefined}
            placeholder="Full 40-character SHA"
          />
          <button type="submit" className="button" disabled={!repositoryId}>
            Use
          </button>
        </div>
        {shaError ? (
          <p id="sha-error" className="field-error">
            {shaError}
          </p>
        ) : null}
      </form>

      <div className="selection" aria-live="polite">
        {selection.status === "resolving" ? (
          <p className="selection-line">Resolving {refLabel(listing, selection.ref)}…</p>
        ) : selection.status === "error" ? (
          <div className="notice notice-danger">
            <p>{selection.message}</p>
            <button
              type="button"
              className="button"
              onClick={() => choose(selection.repositoryId, selection.ref, false)}
            >
              Try again
            </button>
          </div>
        ) : selection.status === "ready" ? (
          <>
            <p className="selection-line">
              <span className="selection-label">Pinned to</span>{" "}
              <code className="sha" title={selection.state.revision.sha}>
                {shortSha(selection.state.revision.sha)}
              </code>
              {selection.state.revision.ref ? (
                <span className="selection-ref">
                  {" "}
                  from {refLabel(listing, selection.state.revision.ref)}
                </span>
              ) : null}
            </p>
            {indexInfo ? (
              <p className={`index-line tone-${indexInfo.tone}`}>
                <span className="dot" aria-hidden="true" />
                {indexInfo.text}
              </p>
            ) : null}
            {selection.state.index.state === "building" &&
            selection.state.index.active?.progress.filesDone !== undefined &&
            selection.state.index.active.progress.filesTotal ? (
              <progress
                className="index-progress"
                value={selection.state.index.active.progress.filesDone}
                max={selection.state.index.active.progress.filesTotal}
                aria-label="Indexed files"
              />
            ) : null}
            {watch === "gave_up" ? (
              <p className="hint">
                Stopped checking automatically.{" "}
                <button
                  type="button"
                  className="link-button"
                  onClick={() => {
                    setWatch("idle");
                    setWatchNonce((value) => value + 1);
                  }}
                >
                  Check again
                </button>
              </p>
            ) : null}
            {ended ? (
              <p className="field-error">
                This selection ended. Re-resolve the revision to ask again.
              </p>
            ) : null}
            <div className="selection-actions">
              <button
                type="button"
                className="link-button"
                onClick={() => choose(selection.state.revision.repositoryId, currentRef, false)}
                title="Resolve the branch or tag again, in case it moved"
              >
                Re-resolve revision
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );

  const panel = (options: {
    readonly page?: AskPage;
    readonly text: string;
    readonly onText: (value: string) => void;
  }) => {
    // Only the outcome of a question asked here is shown here.
    const mine =
      ask.kind !== "idle" &&
      (options.page
        ? ask.snapshot.wikiPage?.pageId === options.page.pageId &&
          ask.snapshot.wikiPage.generationId === options.page.generationId
        : ask.snapshot.wikiPage === undefined);
    return (
      <QuestionPanel
        page={options.page}
        question={options.text}
        onQuestion={options.onText}
        mode={props.mode}
        onMode={props.onMode}
        ask={mine ? ask : { kind: "idle" }}
        askSeq={askSeq}
        active={active}
        ready={ready}
        resolving={selection.status === "resolving"}
        questionRef={questionRef}
        resultRef={resultRef}
        onSubmit={() => submitWith(options.text, options.page)}
        onCancel={() => runnerRef.current?.cancel()}
        onAct={act}
      />
    );
  };

  const selectedState = selection.status === "ready" ? selection.state : undefined;

  return (
    <main className={`workspace${place.view === "wiki" ? " workspace-wiki" : ""}`}>
      <h1 className="visually-hidden">
        {place.view === "wiki" ? "Looky wiki" : "Ask Looky about your code"}
      </h1>
      <nav className="views" aria-label="Views">
        <a
          href={hrefOf(target, { view: "ask" }, pinned)}
          aria-current={place.view === "ask" ? "page" : undefined}
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            if (place.view !== "ask") go({ view: "ask" });
          }}
        >
          Ask
        </a>
        <a
          href={hrefOf(target, { view: "wiki" }, pinned)}
          aria-current={place.view === "wiki" ? "page" : undefined}
          onClick={(event) => {
            if (!plainClick(event)) return;
            event.preventDefault();
            go({ view: "wiki" });
          }}
        >
          Wiki
        </a>
      </nav>
      {place.view === "ask" ? (
        <>
          {controls}
          <section className="ask" aria-labelledby="ask-title">
            {panel({ text: props.question, onText: props.onQuestion })}
          </section>
        </>
      ) : selectedState ? (
        <WikiView
          key={selectedState.revision.id}
          api={api}
          state={selectedState}
          page={place.page}
          anchor={place.anchor}
          hrefFor={wikiHref}
          navigate={navigateWiki}
          lost={lost}
          onRevisionState={onRevisionState}
          onSelectSha={(sha) => repositoryId && choose(repositoryId, sha)}
          onReselect={() => target && choose(target.repositoryId, target.ref, false)}
          controls={controls}
          renderAsk={(page) =>
            panel({ page, text: props.pageQuestion, onText: props.onPageQuestion })
          }
        />
      ) : (
        <>
          <div className="side">{controls}</div>
          <section className="wiki-main" aria-label="Generated wiki">
            <p className="hint" role="status">
              {selection.status === "error"
                ? "Choose a revision to read its wiki."
                : "Resolving the revision…"}
            </p>
          </section>
        </>
      )}
    </main>
  );
}

/**
 * The question form, its live status and its outcome. Used for ordinary
 * source questions and, with `page`, for questions about one wiki page.
 */
function QuestionPanel({
  questionRef,
  resultRef,
  ...props
}: {
  readonly page: AskPage | undefined;
  readonly question: string;
  readonly onQuestion: (value: string) => void;
  readonly mode: Mode;
  readonly onMode: (mode: Mode) => void;
  readonly ask: AskState;
  readonly askSeq: number;
  readonly active: boolean;
  readonly ready: boolean;
  readonly resolving: boolean;
  readonly questionRef: RefObject<HTMLTextAreaElement | null>;
  readonly resultRef: RefObject<HTMLHeadingElement | null>;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly onAct: (action: Action) => void;
}) {
  const { ask, page } = props;
  const prefix = page ? "page-" : "";
  const answered = ask.kind === "result" && ask.response.status === "answered" ? ask : undefined;
  // An answer leads with its prose; its outcome follows inside the answer.
  const status = answered ? undefined : describeAsk(ask);
  const canAsk = props.ready && !props.active && props.question.trim() !== "";

  function submit(event?: FormEvent) {
    event?.preventDefault();
    if (canAsk) props.onSubmit();
  }

  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      submit();
    } else if (event.key === "Escape" && props.active) {
      event.preventDefault();
      props.onCancel();
    }
  }

  const body: ReactNode = (
    <>
      <form className="question-form" onSubmit={submit} aria-busy={props.active}>
        <h2 id={`${prefix}ask-title`} className="section-title">
          {page ? "Ask about this page" : "Question"}
        </h2>
        {page ? (
          <p className="hint" id="page-ask-help">
            Looky answers from the committed source at this commit, using the page only to know
            where to look. The page itself is not evidence.
          </p>
        ) : null}
        <div className="field">
          <label htmlFor={`${prefix}question`} className="visually-hidden">
            {page ? `Your question about the page ${page.title}` : "Your question about the code"}
          </label>
          <textarea
            id={`${prefix}question`}
            ref={questionRef}
            rows={page ? 3 : 4}
            dir="auto"
            value={props.question}
            onChange={(event) => props.onQuestion(event.target.value)}
            onKeyDown={onKey}
            placeholder={
              page
                ? "For example: which tests cover this, and what happens when it fails?"
                : "For example: how does a refresh reuse unchanged files from the previous index?"
            }
            aria-describedby={`${prefix}question-help`}
          />
          <p id={`${prefix}question-help`} className="hint">
            Ctrl or ⌘ + Enter to ask. Escape cancels a running question.
          </p>
        </div>

        <fieldset className="modes">
          <legend>Mode</legend>
          <label className="mode">
            <input
              type="radio"
              name={`${prefix}mode`}
              value="fast"
              checked={props.mode === "fast"}
              onChange={() => props.onMode("fast")}
            />
            <span className="mode-body">
              <span className="mode-name">Fast</span>
              <span className="mode-detail">Small research budget, concise answer</span>
            </span>
          </label>
          <label className="mode">
            <input
              type="radio"
              name={`${prefix}mode`}
              value="deep"
              checked={props.mode === "deep"}
              onChange={() => props.onMode("deep")}
            />
            <span className="mode-body">
              <span className="mode-name">Deep</span>
              <span className="mode-detail">Follows code across files, larger budget</span>
            </span>
          </label>
        </fieldset>

        <div className="submit-row">
          <button type="submit" className="button button-primary" disabled={!canAsk}>
            Ask in {MODE_LABEL[props.mode]}
          </button>
          {props.active && ask.kind !== "idle" ? (
            <button
              type="button"
              className="button"
              onClick={props.onCancel}
              disabled={ask.kind === "cancelling"}
            >
              {ask.kind === "cancelling" ? "Cancelling…" : "Cancel"}
            </button>
          ) : null}
          {!props.ready && !props.resolving ? (
            <span className="hint">Choose a revision first.</span>
          ) : null}
        </div>
      </form>

      <p className="visually-hidden" role="status" aria-live="polite">
        {announce(ask)}
      </p>

      {status ? (
        <div className={`status tone-${status.tone}`} aria-busy={status.busy}>
          <h2 className="status-title" ref={resultRef} tabIndex={-1}>
            {status.busy ? <span className="spinner" aria-hidden="true" /> : null}
            {status.title}
          </h2>
          {status.detail ? <p className="status-detail">{status.detail}</p> : null}
          {status.actions.length > 0 ? (
            <div className="status-actions">
              {status.actions.map((action) => (
                <ActionButton
                  key={`${props.askSeq}:${action.kind}`}
                  action={action}
                  onAct={props.onAct}
                  disabled={props.active}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : answered || page ? null : (
        <div className="empty">
          <p>
            Ask how something works in the selected revision. Looky explains it in plain prose and
            cites the exact files and lines it read.
          </p>
        </div>
      )}

      {answered && answered.response.status === "answered" ? (
        <AnswerView
          snapshot={answered.snapshot}
          response={answered.response}
          sourceLinks={answered.sourceLinks}
          titleRef={resultRef}
          {...(answered.snapshot.mode === "fast"
            ? { onDeep: () => props.onAct({ kind: "deep", label: "Ask in Deep" }) }
            : {})}
        />
      ) : null}
    </>
  );

  return page ? (
    <section className="page-ask" aria-labelledby="page-ask-title">
      {body}
    </section>
  ) : (
    body
  );
}

/** A next action. A `notBeforeMs` retry is enabled once Looky's suggested delay has passed. */
function ActionButton(props: {
  readonly action: Action;
  readonly onAct: (action: Action) => void;
  readonly disabled: boolean;
}) {
  const { action } = props;
  // Remounted per outcome (see its key), so this initial value is per outcome too.
  const [waiting, setWaiting] = useState(
    action.kind === "retry" && action.notBeforeMs !== undefined,
  );
  useEffect(() => {
    if (action.kind !== "retry" || action.notBeforeMs === undefined) return;
    const timer = setTimeout(() => setWaiting(false), Math.min(action.notBeforeMs, 60_000));
    return () => clearTimeout(timer);
  }, [action]);
  return (
    <button
      type="button"
      className={action.kind === "deep" ? "button button-primary" : "button"}
      disabled={props.disabled || waiting}
      onClick={() => props.onAct(action)}
    >
      {action.label}
    </button>
  );
}
