/**
 * The built React app against the real Looky HTTP service: production assets
 * served same-origin under the CSP, and the app's own API client and question
 * runner driving real indexed questions through `/browser/v1`. Only the model
 * provider is scripted.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { sourceLinkFromTemplate } from "../../src/answer/citations";
import { LookyAnswerEngine } from "../../src/answer/engine";
import { startHttpServer, type RunningHttpServer } from "../../src/mcp/http";
import { DEFAULT_RESEARCH_LIMITS } from "../../src/retrieval/research";
import { hashToken, type ClientConfig } from "../../src/service/config";
import type { LookyService } from "../../src/service/looky-service";
import { buildWeb } from "../../web/build";
import { BrowserApi } from "../../web/src/api";
import { AnswerView } from "../../web/src/AnswerView";
import { AskRunner, type AskSnapshot, type AskState } from "../../web/src/ask-runner";
import { refValue } from "../../web/src/presentation";
import { git } from "../support/git-fixture";
import {
  createFixture,
  gatedModel,
  PAWS,
  QUESTION,
  type Fixture,
} from "../support/service-fixture";

const TEMPLATE = "https://code.example.com/org/pilot/blob/{sha}/{path}#L{startLine}-L{endLine}";
const WEB: ClientConfig = {
  id: "web",
  tokenHash: hashToken("web-browser-token-0123456789abcdef01234"),
  repositories: new Set(["pilot"]),
};

let assets: string;
let fixture: Fixture;
let service: LookyService;
let http: RunningHttpServer;

beforeAll(async () => {
  assets = mkdtempSync(join(tmpdir(), "looky-web-assets-"));
  await buildWeb(assets);
});

afterAll(() => {
  rmSync(assets, { recursive: true, force: true });
});

beforeEach(() => {
  fixture = createFixture("looky-web-app-");
});

afterEach(async () => {
  await http?.stop();
  await fixture.close();
});

function start(
  options: { links?: boolean; provider?: ReturnType<typeof gatedModel>["provider"] } = {},
) {
  const links = options.links ?? true;
  const sourceLink = links ? sourceLinkFromTemplate(TEMPLATE) : undefined;
  service = fixture.service({
    engine: new LookyAnswerEngine({
      research: DEFAULT_RESEARCH_LIMITS,
      deepRounds: 0,
      ...(sourceLink ? { sourceLink } : {}),
    }),
    ...(options.provider ? { provider: options.provider } : {}),
  });
  http = startHttpServer({
    service,
    config: {
      host: "127.0.0.1",
      port: 0,
      clients: new Map([
        ["paws", PAWS],
        ["web", WEB],
      ]),
      allowedOrigins: [],
      repositories: new Map([["pilot", { id: "pilot", path: fixture.repo }]]),
      browser: {
        clientId: "web",
        auth: "local",
        origins: [],
        sessionTtlMs: 60_000,
        assetsDir: assets,
      },
    },
    askConfig: { maxQuestionChars: 4000 },
    ...(sourceLink ? { sourceLink } : {}),
  });
}

/** What a browser tab does for the app: same origin, cookie jar. */
function tabFetch() {
  let cookie: string | undefined;
  return async (input: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("origin", http.url);
    headers.set("sec-fetch-site", "same-origin");
    if (cookie) headers.set("cookie", cookie);
    const response = await fetch(`${http.url}${input}`, { ...init, headers });
    const set = response.headers.get("set-cookie");
    if (set) {
      const pair = set.split(";")[0]!;
      cookie = pair.endsWith("=") ? undefined : pair;
    }
    return response;
  };
}

async function signedIn(): Promise<BrowserApi> {
  const api = new BrowserApi(tabFetch());
  const session = await api.session();
  expect(session).toMatchObject({ authenticated: false, auth: "local" });
  expect((await api.signIn()).authenticated).toBe(true);
  return api;
}

function runner(api: BrowserApi) {
  const states: AskState[] = [];
  let done!: (state: AskState) => void;
  let finished = new Promise<AskState>((resolve) => (done = resolve));
  const instance = new AskRunner({
    api,
    pollWaitMs: 5_000,
    onState: (state) => {
      states.push(state);
      if (state.kind === "result" || state.kind === "error" || state.kind === "cancelled") {
        done(state);
        finished = new Promise<AskState>((resolve) => (done = resolve));
      }
    },
  });
  return { instance, states, next: () => finished };
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(10);
  }
}

describe("production assets", () => {
  test("the build has one HTML entry with external hashed script and style only", () => {
    const files = readdirSync(assets);
    expect(files).toContain("index.html");
    const html = readFileSync(join(assets, "index.html"), "utf8");
    expect(html).toMatch(
      /<script type="module" crossorigin src="\/chunk-[a-z0-9]+\.js"><\/script>/,
    );
    expect(html).toMatch(/<link rel="stylesheet" crossorigin href="\/chunk-[a-z0-9]+\.css">/);
    // No inline script or style: the CSP allows neither.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toContain("<style");
    expect(html).not.toContain("style=");
    expect(files.some((file) => file.endsWith(".map"))).toBe(false);
  });

  test("Looky serves the app same-origin with its CSP, including under a deep path", async () => {
    start();
    const page = await fetch(`${http.url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("script-src 'self'");
    const html = await page.text();
    const script = /src="(\/chunk-[a-z0-9]+\.js)"/.exec(html)![1]!;
    const style = /href="(\/chunk-[a-z0-9]+\.css)"/.exec(html)![1]!;
    const js = await fetch(`${http.url}${script}`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("javascript");
    const code = await js.text();
    expect(code).not.toContain("localStorage");
    expect(code).not.toContain("sessionStorage");
    expect(code).not.toContain("dangerouslySetInnerHTML:");
    expect((await fetch(`${http.url}${style}`)).headers.get("content-type")).toContain("text/css");
    const deep = await fetch(`${http.url}/some/deep/path?repo=pilot&ref=main`);
    expect(await deep.text()).toBe(html);
  });
});

describe("the app against Looky", () => {
  test("repositories and revisions come from the API, and both modes show full cited answers", async () => {
    start();
    const api = await signedIn();
    const { repositories } = await api.repositories();
    expect(repositories).toEqual([{ id: "pilot" }]);
    const refs = await api.refs("pilot");
    expect(refs.head?.sha).toBe(fixture.sha);
    const selected = await api.selectRevision("pilot", "HEAD");
    expect(selected.revision).toMatchObject({ repositoryId: "pilot", sha: fixture.sha });
    await service.index.waitForBuild(
      selected.index.active?.buildId ?? selected.index.ready!.buildId,
    );

    const { instance, next } = runner(api);
    for (const mode of ["fast", "deep"] as const) {
      const snapshot: AskSnapshot = {
        question: QUESTION,
        mode,
        repositoryId: "pilot",
        sha: selected.revision.sha,
        revisionId: selected.revision.id,
      };
      expect(instance.ask(snapshot)).toBe(true);
      const state = await next();
      expect(state.kind).toBe("result");
      if (state.kind !== "result" || state.response.status !== "answered") {
        throw new Error(`expected an answer, got ${JSON.stringify(state)}`);
      }
      const { response, sourceLinks } = state;
      expect(response.mode).toEqual({ requested: mode, executed: mode });
      expect(response.revision.sha).toBe(fixture.sha);
      expect(sourceLinks).toHaveLength(response.evidence.length);
      for (const [index, ref] of response.evidence.entries()) {
        expect(sourceLinks[index]).toBe(
          `https://code.example.com/org/pilot/blob/${fixture.sha}/${ref.path}#L${ref.startLine}-L${ref.endLine}`,
        );
      }

      const html = renderToStaticMarkup(
        <AnswerView snapshot={snapshot} response={response} sourceLinks={sourceLinks} />,
      );
      expect(html).toContain("Recovery loads the newest checkpoint and replays the run");
      expect(html).toContain(fixture.sha);
      // The citation inside the prose and the source list both link to the pinned range.
      const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((match) => match[1]!);
      expect(hrefs.length).toBeGreaterThanOrEqual(2);
      for (const href of hrefs) {
        expect(href.startsWith(`https://code.example.com/org/pilot/blob/${fixture.sha}/`)).toBe(
          true,
        );
      }
    }
  });

  test("a tag sharing a branch's name is selected as the tag, not the branch", async () => {
    git(fixture.repo, "commit", "--allow-empty", "-m", "after the branch point");
    const tagged = git(fixture.repo, "rev-parse", "HEAD").trim();
    git(fixture.repo, "tag", "release", tagged);
    git(fixture.repo, "branch", "release", fixture.sha);
    expect(tagged).not.toBe(fixture.sha);
    start();
    const api = await signedIn();
    const listing = await api.refs("pilot");
    const branch = listing.refs.find((ref) => ref.kind === "branch" && ref.name === "release")!;
    const tag = listing.refs.find((ref) => ref.kind === "tag" && ref.name === "release")!;
    expect(branch.sha).toBe(fixture.sha);
    expect(tag.sha).toBe(tagged);
    expect((await api.selectRevision("pilot", refValue(tag))).revision.sha).toBe(tagged);
    expect((await api.selectRevision("pilot", refValue(branch))).revision.sha).toBe(fixture.sha);
  });

  test("without a configured template the API offers no links and none are rendered", async () => {
    start({ links: false });
    const api = await signedIn();
    const selected = await api.selectRevision("pilot", "main");
    const { instance, next } = runner(api);
    const snapshot: AskSnapshot = {
      question: QUESTION,
      mode: "fast",
      repositoryId: "pilot",
      sha: selected.revision.sha,
      revisionId: selected.revision.id,
    };
    instance.ask(snapshot);
    const state = await next();
    if (state.kind !== "result" || state.response.status !== "answered") {
      throw new Error(`expected an answer, got ${JSON.stringify(state)}`);
    }
    expect(state.sourceLinks.every((link) => link === null)).toBe(true);
    const html = renderToStaticMarkup(
      <AnswerView snapshot={snapshot} response={state.response} sourceLinks={state.sourceLinks} />,
    );
    expect(html).not.toContain("<a ");
    expect(html).toContain("src/");
  });

  test("changing the selection mid-question cancels it at Looky and its late result is never shown", async () => {
    const gated = gatedModel();
    start({ provider: gated.provider });
    const api = await signedIn();
    const selected = await api.selectRevision("pilot", "main");
    const { instance, states } = runner(api);
    instance.ask({
      question: QUESTION,
      mode: "fast",
      repositoryId: "pilot",
      sha: selected.revision.sha,
      revisionId: selected.revision.id,
    });
    await gated.firstCall;
    await until(() => states.some((state) => state.kind === "running"));
    instance.detach();
    expect(states.at(-1)).toEqual({ kind: "idle" });
    await until(() => gated.signals.every((signal) => signal.aborted));
    gated.release();
    await Bun.sleep(50);
    expect(states.at(-1)).toEqual({ kind: "idle" });
    expect(states.some((state) => state.kind === "result")).toBe(false);
  });

  test("a visible cancel ends in a confirmed cancelled state and Looky stops the research", async () => {
    const gated = gatedModel();
    start({ provider: gated.provider });
    const api = await signedIn();
    const selected = await api.selectRevision("pilot", "main");
    const { instance, states, next } = runner(api);
    instance.ask({
      question: QUESTION,
      mode: "deep",
      repositoryId: "pilot",
      sha: selected.revision.sha,
      revisionId: selected.revision.id,
    });
    await gated.firstCall;
    instance.cancel();
    expect(states.at(-1)?.kind).toBe("cancelling");
    const state = await next();
    expect(state).toMatchObject({ kind: "cancelled", confirmed: true });
    await until(() => gated.signals.every((signal) => signal.aborted));
    gated.release();
  });
});
