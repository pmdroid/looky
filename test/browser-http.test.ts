import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BrowserLimits } from "../src/browser/adapter";
import { browserIndex, browserResponse } from "../src/browser/sanitize";
import type { ModelProvider } from "../src/contract/ports";
import { startHttpServer, type RunningHttpServer } from "../src/mcp/http";
import {
  hashToken,
  loadServerConfig,
  type BrowserConfig,
  type ClientConfig,
  type RepositoryConfig,
} from "../src/service/config";
import type { LookyService } from "../src/service/looky-service";
import { git } from "./support/git-fixture";
import {
  citingModel,
  CLIENT_TOKEN,
  createFixture,
  gatedModel,
  PAWS,
  QUESTION,
  type Fixture,
} from "./support/service-fixture";

const WEB_TOKEN = "web-browser-token-0123456789abcdef01234";
const WEB: ClientConfig = {
  id: "web",
  tokenHash: hashToken(WEB_TOKEN),
  repositories: new Set(["pilot"]),
};

let fixture: Fixture;
let service: LookyService;
let http: RunningHttpServer;

interface StartOptions {
  readonly service?: Parameters<Fixture["service"]>[0];
  readonly browser?: Partial<BrowserConfig>;
  readonly limits?: Partial<BrowserLimits>;
  readonly host?: string;
}

function start(options: StartOptions = {}): void {
  const repositories = new Map<string, RepositoryConfig>([
    ["pilot", { id: "pilot", path: fixture.repo }],
    // Configured on the service, but not for the browser client.
    ["secret", { id: "secret", path: fixture.repo }],
  ]);
  service = fixture.service({ repositories, ...options.service });
  http = startHttpServer({
    service,
    config: {
      host: options.host ?? "127.0.0.1",
      port: 0,
      clients: new Map([
        ["paws", PAWS],
        ["web", WEB],
      ]),
      allowedOrigins: [],
      repositories,
      browser: {
        clientId: "web",
        auth: "local",
        origins: [],
        sessionTtlMs: 60_000,
        ...options.browser,
      },
    },
    askConfig: { maxQuestionChars: 4000 },
    ...(options.limits ? { browserLimits: options.limits } : {}),
  });
}

beforeEach(() => {
  fixture = createFixture("looky-browser-");
});

afterEach(async () => {
  await http?.stop();
  await fixture.close();
});

interface Reply {
  readonly status: number;
  readonly body: any;
  readonly headers: Headers;
  readonly text: string;
}

/** A browser tab: a cookie jar, the CSRF token in memory and its page origin. */
class Browser {
  cookie: string | undefined;
  csrf: string | undefined;
  readonly seen: string[] = [];

  constructor(readonly origin: string | null = http.url) {}

  async call(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply> {
    const sent: Record<string, string> = {};
    if (this.origin !== null) sent.origin = this.origin;
    if (this.cookie) sent.cookie = this.cookie;
    if (this.csrf && method !== "GET") sent["x-looky-csrf"] = this.csrf;
    if (body !== undefined) sent["content-type"] = "application/json";
    const response = await fetch(`${http.url}${path}`, {
      method,
      headers: { ...sent, ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0]!;
      this.cookie = pair.endsWith("=") ? undefined : pair;
    }
    const text = await response.text();
    this.seen.push(text);
    return {
      status: response.status,
      body: text ? JSON.parse(text) : undefined,
      headers: response.headers,
      text,
    };
  }

  async signIn(body: unknown = {}): Promise<Reply> {
    const reply = await this.call("POST", "/browser/v1/session", body);
    if (reply.status === 201) this.csrf = reply.body.csrfToken;
    return reply;
  }

  async select(ref = "main", repositoryId = "pilot"): Promise<Reply> {
    return this.call("POST", "/browser/v1/revisions", { repositoryId, ref });
  }

  async ask(
    revisionId: string,
    mode: "fast" | "deep",
    clientRequestId: string,
    question = QUESTION,
  ) {
    return this.call("POST", "/browser/v1/questions", {
      revisionId,
      question,
      mode,
      clientRequestId,
    });
  }

  async result(id: string, waitMs = 20_000): Promise<Reply> {
    return this.call("GET", `/browser/v1/questions/${id}?waitMs=${waitMs}`);
  }
}

async function until(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await Bun.sleep(10);
  }
}

describe("browser adapter: answers", () => {
  test("a browser selects a permitted repository and revision and gets full answers in both modes", async () => {
    start();
    git(fixture.repo, "tag", "v1");
    const tab = new Browser();
    const signedIn = await tab.signIn();
    expect(signedIn.status).toBe(201);
    const cookie = signedIn.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(signedIn.body.csrfToken).toBeTruthy();

    const session = await tab.call("GET", "/browser/v1/session");
    expect(session.body).toMatchObject({ authenticated: true, auth: "local" });

    const repositories = await tab.call("GET", "/browser/v1/repositories");
    expect(repositories.body.repositories).toEqual([{ id: "pilot" }]);

    const refs = await tab.call("GET", "/browser/v1/repositories/pilot/refs");
    expect(refs.status).toBe(200);
    expect(refs.body.head).toEqual({ sha: fixture.sha, branch: "main" });
    expect(refs.body.refs).toContainEqual({ kind: "branch", name: "main", sha: fixture.sha });
    expect(refs.body.refs).toContainEqual({ kind: "tag", name: "v1", sha: fixture.sha });
    expect(refs.text).not.toContain(fixture.repo);

    const selected = await tab.select("main");
    expect(selected.status).toBe(201);
    expect(selected.body.revision).toMatchObject({
      repositoryId: "pilot",
      sha: fixture.sha,
      ref: "main",
      active: true,
    });
    const revisionId = selected.body.revision.id;
    // Selecting the same revision again reuses the selection.
    expect((await tab.select("main")).body.revision.id).toBe(revisionId);
    expect((await tab.select(fixture.sha)).body.revision.sha).toBe(fixture.sha);

    for (const mode of ["fast", "deep"] as const) {
      const submitted = await tab.ask(revisionId, mode, `request-${mode}-0001`);
      expect(submitted.status).toBe(202);
      expect(submitted.body).toMatchObject({ state: "running", mode, sha: fixture.sha });
      expect(submitted.body.id).toMatch(/^brq_/);
      const done = await tab.result(submitted.body.id);
      expect(done.body.state).toBe("completed");
      const response = done.body.response;
      expect(response.status).toBe("answered");
      expect(response.mode).toEqual({ requested: mode, executed: mode });
      expect(response.revision).toMatchObject({
        repositoryId: "pilot",
        sha: fixture.sha,
        ref: "main",
      });
      expect(response.index.sha).toBe(fixture.sha);
      expect(response.scope).toEqual({
        source: "committed",
        sha: fixture.sha,
        uncommittedChanges: "none",
      });
      expect(response.answer.text).toContain("checkpoint");
      expect(response.evidence.length).toBeGreaterThan(0);
      expect(response.evidence[0].path).toMatch(/^src\//);
    }

    const state = await tab.call("GET", `/browser/v1/revisions/${revisionId}`);
    expect(state.body.index.state).toBe("ready");

    // No credential or host path ever reached the browser.
    for (const text of tab.seen) {
      expect(text).not.toContain("lks_");
      expect(text).not.toContain(WEB_TOKEN);
      expect(text).not.toContain(CLIENT_TOKEN);
      expect(text).not.toContain(fixture.root);
    }
  });

  test("an index that is not ready yet is a typed indexing result, never an empty answer", async () => {
    start({ service: { capacity: { indexWaitMs: 0 } } });
    const tab = new Browser();
    await tab.signIn();
    const selected = await tab.select();
    const buildId = selected.body.index.active?.buildId;
    expect(buildId).toBeDefined();
    const submitted = await tab.ask(selected.body.revision.id, "fast", "indexing-0001");
    const done = await tab.result(submitted.body.id);
    expect(done.body.response.status).toBe("indexing");
    expect(done.body.response.buildId).toBe(buildId);
    expect(done.body.response.answer).toBeUndefined();

    await service.index.waitForBuild(buildId);
    const again = await tab.ask(selected.body.revision.id, "fast", "indexing-0002");
    expect((await tab.result(again.body.id)).body.response.status).toBe("answered");
  });

  test("a repeated delivery returns the same question and researches once", async () => {
    const model = citingModel();
    start({ service: { provider: model } });
    const tab = new Browser();
    await tab.signIn();
    const revisionId = (await tab.select()).body.revision.id;
    const first = await tab.ask(revisionId, "fast", "repeat-0001");
    const second = await tab.ask(revisionId, "fast", "repeat-0001");
    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
    await tab.result(first.body.id);
    const calls = model.calls.length;
    expect(calls).toBeGreaterThan(0);
    const third = await tab.ask(revisionId, "fast", "repeat-0001");
    expect(third.body.id).toBe(first.body.id);
    expect(third.body.response.status).toBe("answered");
    expect(model.calls.length).toBe(calls);

    const reused = await tab.ask(revisionId, "deep", "repeat-0001");
    expect(reused.status).toBe(409);
    expect(reused.body.error.code).toBe("request_key_reused");
  });
});

describe("browser adapter: access boundary", () => {
  test("foreign origins, cross-site requests, rebinding hosts and missing CSRF are refused", async () => {
    start();
    expect((await new Browser("https://evil.example").signIn()).status).toBe(403);
    expect((await new Browser(null).signIn()).status).toBe(403);
    const crossSite = await new Browser().call("GET", "/browser/v1/session", undefined, {
      "sec-fetch-site": "cross-site",
    });
    expect(crossSite.status).toBe(403);
    const port = new URL(http.url).port;
    const rebound = await new Browser().call("GET", "/browser/v1/session", undefined, {
      host: `evil.example:${port}`,
    });
    expect(rebound.status).toBe(403);
    expect(rebound.body.error.code).toBe("forbidden_host");

    const anonymous = await new Browser().call("GET", "/browser/v1/repositories");
    expect(anonymous.status).toBe(401);
    expect(anonymous.body.error.code).toBe("unauthenticated");

    const tab = new Browser();
    await tab.signIn();
    const csrf = tab.csrf;
    tab.csrf = undefined;
    const noCsrf = await tab.select();
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe("csrf_failed");
    tab.csrf = "wrong";
    expect((await tab.select()).status).toBe(403);
    tab.csrf = csrf;

    const form = await tab.call("POST", "/browser/v1/revisions", undefined, {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(form.status).toBe(415);

    // Never a permissive CORS answer.
    const preflight = await fetch(`${http.url}/browser/v1/questions`, {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "POST" },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();
    const ok = await tab.call("GET", "/browser/v1/repositories");
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(ok.headers.get("cache-control")).toBe("no-store");

    // The browser cannot reach the agent and client adapter APIs.
    expect((await tab.call("GET", "/v1/service")).status).toBe(403);
  });

  test("unauthorized repositories, paths and revision syntax are refused", async () => {
    start();
    const tab = new Browser();
    await tab.signIn();
    for (const repositoryId of ["secret", "unknown", "../pilot", fixture.repo, "file:///etc"]) {
      const reply = await tab.select("main", repositoryId);
      expect(reply.status).toBe(403);
      expect(reply.body.error.code).toBe("repository_not_permitted");
    }
    expect((await tab.call("GET", "/browser/v1/repositories/secret/refs")).status).toBe(403);
    for (const ref of [
      "main~1",
      "main^",
      ":/pilot",
      "HEAD@{1}",
      "--upload-pack=touch /tmp/x",
      "-c",
      "../../etc/passwd",
      "refs/heads/../x",
      "main.lock",
      ".git/config",
      "a b",
    ]) {
      const reply = await tab.select(ref);
      expect(reply.status).toBe(400);
      expect(reply.body.error.code).toBe("invalid_ref");
    }
    expect((await tab.select("no-such-branch")).status).toBe(422);
    expect((await tab.select("b".repeat(40))).status).toBe(422);

    const injected = await tab.call("POST", "/browser/v1/revisions", {
      repositoryId: "pilot",
      ref: "main",
      path: fixture.repo,
    });
    expect(injected.status).toBe(400);
    expect(injected.text).not.toContain(fixture.repo);

    const revisionId = (await tab.select()).body.revision.id;
    const scoped = await tab.call("POST", "/browser/v1/questions", {
      revisionId,
      question: QUESTION,
      mode: "fast",
      clientRequestId: "scoped-0001",
      sha: "b".repeat(40),
    });
    expect(scoped.status).toBe(400);
    expect((await tab.ask("rev_unknown", "fast", "unknown-0001")).status).toBe(404);
  });

  test("another browser cannot read or cancel a question, and sign-out ends the selections", async () => {
    const gated = gatedModel();
    start({ service: { provider: gated.provider } });
    const owner = new Browser();
    await owner.signIn();
    const revisionId = (await owner.select()).body.revision.id;
    const question = (await owner.ask(revisionId, "fast", "owned-0001")).body.id;
    await gated.firstCall;

    const other = new Browser();
    await other.signIn();
    expect((await other.result(question, 0)).status).toBe(404);
    const forged = await other.call("POST", `/browser/v1/questions/${question}/cancel`);
    expect(forged.status).toBe(404);
    expect((await other.call("GET", `/browser/v1/revisions/${revisionId}`)).status).toBe(404);
    expect(gated.signals[0]!.aborted).toBe(false);

    expect((await owner.call("DELETE", "/browser/v1/session")).status).toBe(204);
    expect(owner.cookie).toBeUndefined();
    await until(() => gated.signals[0]!.aborted);
    expect(service.sessions.hasInterest("pilot", fixture.sha)).toBe(false);
    gated.release();
  });

  test("an expired browser session is refused", async () => {
    start({ browser: { sessionTtlMs: 150 } });
    const tab = new Browser();
    await tab.signIn();
    expect((await tab.call("GET", "/browser/v1/repositories")).status).toBe(200);
    await Bun.sleep(250);
    const expired = await tab.call("GET", "/browser/v1/repositories");
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe("session_expired");
  });

  test("token sign-in needs the browser client's own token and limits failures", async () => {
    start({ browser: { auth: "token" }, limits: { signInFailuresPerMinute: 3 } });
    const tab = new Browser();
    expect((await tab.signIn({})).status).toBe(401);
    expect((await tab.signIn({ token: CLIENT_TOKEN })).status).toBe(401);
    expect((await tab.signIn({ token: WEB_TOKEN, extra: 1 })).status).toBe(400);
    expect((await tab.signIn({ token: "wrong" })).status).toBe(401);
    expect((await tab.signIn({ token: WEB_TOKEN })).status).toBe(429);
  });

  test("token sign-in succeeds with the configured token", async () => {
    start({ browser: { auth: "token" } });
    const tab = new Browser();
    const signedIn = await tab.signIn({ token: WEB_TOKEN });
    expect(signedIn.status).toBe(201);
    expect(signedIn.text).not.toContain(WEB_TOKEN);
    expect((await tab.call("GET", "/browser/v1/repositories")).status).toBe(200);
  });
});

describe("browser adapter: cancellation and failures", () => {
  test("cancelling one browser's question leaves another caller's question and the build running", async () => {
    const gated = gatedModel();
    start({ service: { provider: gated.provider } });
    const first = new Browser();
    await first.signIn();
    const firstRevision = (await first.select()).body.revision.id;
    const cancelled = (await first.ask(firstRevision, "fast", "cancel-0001")).body.id;
    await gated.firstCall;

    const second = new Browser();
    await second.signIn();
    const secondRevision = (await second.select()).body.revision.id;
    const kept = (await second.ask(secondRevision, "fast", "cancel-0002")).body.id;
    await until(() => gated.signals.length === 2);

    const reply = await first.call("POST", `/browser/v1/questions/${cancelled}/cancel`);
    expect(reply.body.cancelRequested).toBe(true);
    expect(reply.body.response.status).toBe("cancelled");
    expect(gated.signals[0]!.aborted).toBe(true);
    expect(gated.signals[1]!.aborted).toBe(false);

    gated.release();
    expect((await second.result(kept)).body.response.status).toBe("answered");
  });

  test("cancelling a question while its index builds does not cancel the build", async () => {
    start({ service: { capacity: { indexWaitMs: 60_000 } } });
    const tab = new Browser();
    await tab.signIn();
    const selected = await tab.select();
    const buildId = selected.body.index.active?.buildId;
    const id = (await tab.ask(selected.body.revision.id, "deep", "build-0001")).body.id;
    const reply = await tab.call("POST", `/browser/v1/questions/${id}/cancel`);
    expect(reply.body.response.status).toBe("cancelled");
    expect(buildId).toBeDefined();
    expect((await service.index.waitForBuild(buildId)).state).toBe("ready");
    expect(service.index.indexStatus({ repositoryId: "pilot", sha: fixture.sha }).state).toBe(
      "ready",
    );
  });

  test("a question nobody watches any more is cancelled", async () => {
    const gated = gatedModel();
    start({ service: { provider: gated.provider }, limits: { abandonAfterMs: 100 } });
    const tab = new Browser();
    await tab.signIn();
    const revisionId = (await tab.select()).body.revision.id;
    const id = (await tab.ask(revisionId, "fast", "abandon-0001")).body.id;
    await gated.firstCall;
    await until(() => gated.signals[0]!.aborted);
    expect((await tab.result(id)).body.response.status).toBe("cancelled");
  });

  test("busy and provider failures are typed, retryable where true, and never leak provider text", async () => {
    const leaky: ModelProvider = {
      id: "leaky",
      complete: async () => {
        throw new Error("upstream 500 for key sk-live-SECRET123 reading /home/looky/.config/key");
      },
    };
    start({ service: { provider: leaky } });
    const tab = new Browser();
    await tab.signIn();
    const revisionId = (await tab.select()).body.revision.id;
    const id = (await tab.ask(revisionId, "fast", "leak-0001")).body.id;
    const done = await tab.result(id);
    expect(["failed", "unavailable"]).toContain(done.body.response.status);
    expect(done.text).not.toContain("sk-live");
    expect(done.text).not.toContain("/home/looky");
  });

  test("a full service is reported busy", async () => {
    const gated = gatedModel();
    start({
      service: {
        provider: gated.provider,
        capacity: { maxConcurrentAsks: 1, maxQueuedAsks: 0 },
      },
    });
    const first = new Browser();
    await first.signIn();
    await first.ask((await first.select()).body.revision.id, "fast", "busy-0001");
    await gated.firstCall;
    const second = new Browser();
    await second.signIn();
    const id = (await second.ask((await second.select()).body.revision.id, "fast", "busy-0002"))
      .body.id;
    const response = (await second.result(id)).body.response;
    expect(response).toMatchObject({ status: "unavailable", code: "busy", retryable: true });
    expect(response.message).toBe("Looky is answering other questions. Retry shortly.");
    gated.release();
  });

  test("selecting beyond the limit ends the least recently used selection", async () => {
    start({ limits: { maxRevisionsPerSession: 1 } });
    const tab = new Browser();
    await tab.signIn();
    const first = (await tab.select("main")).body.revision.id;
    const second = (await tab.select("HEAD")).body.revision.id;
    expect(second).not.toBe(first);
    expect((await tab.call("GET", `/browser/v1/revisions/${first}`)).status).toBe(404);
    expect((await tab.call("GET", `/browser/v1/revisions/${second}`)).body.revision.active).toBe(
      true,
    );
  });
});

describe("browser adapter: assets and configuration", () => {
  test("built assets are served same-origin from their directory only", async () => {
    const assets = join(fixture.root, "assets");
    mkdirSync(assets);
    writeFileSync(join(assets, "index.html"), "<!doctype html><title>Looky</title>");
    writeFileSync(join(assets, "app.js"), "console.log('looky')");
    writeFileSync(join(assets, ".env"), "SECRET=1");
    writeFileSync(join(fixture.root, "outside.txt"), "outside");
    start({ browser: { assetsDir: assets } });

    const index = await fetch(`${http.url}/`);
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<title>Looky</title>");
    expect(index.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(index.headers.get("access-control-allow-origin")).toBeNull();
    expect((await fetch(`${http.url}/app.js`)).status).toBe(200);
    expect(await (await fetch(`${http.url}/questions/42`)).text()).toContain("<title>");
    for (const path of ["/.env", "/%2e%2e/outside.txt", "/..%2foutside.txt", "/missing.js"]) {
      expect((await fetch(`${http.url}${path}`)).status).toBe(404);
    }
  });

  test("local sign-in is refused for a non-loopback listen address", () => {
    const base = {
      LOOKY_REPOSITORIES: "pilot",
      LOOKY_REPOSITORY_PILOT_PATH: "/srv/pilot.git",
      LOOKY_CLIENTS: "web",
      LOOKY_CLIENT_WEB_TOKEN: WEB_TOKEN,
      LOOKY_CLIENT_WEB_REPOSITORIES: "pilot",
    };
    expect(loadServerConfig(base).browser).toBeUndefined();
    expect(loadServerConfig({ ...base, LOOKY_BROWSER_CLIENT: "web" }).browser).toMatchObject({
      clientId: "web",
      auth: "local",
    });
    expect(() => loadServerConfig({ ...base, LOOKY_BROWSER_CLIENT: "paws" })).toThrow(
      /not in LOOKY_CLIENTS/,
    );
    const remote = { ...base, LOOKY_HOST: "0.0.0.0", LOOKY_BROWSER_CLIENT: "web" };
    expect(() => loadServerConfig(remote)).toThrow(/only works while LOOKY_HOST is a loopback/);
    expect(() => loadServerConfig({ ...remote, LOOKY_BROWSER_AUTH: "token" })).toThrow(
      /LOOKY_BROWSER_ORIGINS is required/,
    );
    expect(() =>
      loadServerConfig({
        ...remote,
        LOOKY_BROWSER_AUTH: "token",
        LOOKY_BROWSER_ORIGINS: "http://looky.example.com",
      }),
    ).toThrow(/must use https/);
    expect(
      loadServerConfig({
        ...remote,
        LOOKY_BROWSER_AUTH: "token",
        LOOKY_BROWSER_ORIGINS: "https://looky.example.com",
      }).browser,
    ).toMatchObject({ auth: "token", origins: ["https://looky.example.com"] });
  });

  test("secure origins get a __Host- cookie with Secure", async () => {
    start({ browser: { origins: ["https://looky.example.com"] } });
    const tab = new Browser();
    const signedIn = await tab.signIn();
    const cookie = signedIn.headers.get("set-cookie")!;
    expect(cookie).toStartWith("__Host-looky_browser=");
    expect(cookie).toContain("Secure");
  });

  test("messages that may carry paths or provider text are replaced", () => {
    const base = { requestId: "r", mode: { requested: "fast" as const, executed: null } };
    const unsupported = browserResponse({
      ...base,
      status: "unsupported_revision",
      limitations: ["/srv/secret/pilot.git: bad object"],
      message: "/srv/secret/pilot.git: bad object",
    });
    expect(JSON.stringify(unsupported)).not.toContain("/srv");
    const failed = browserResponse({
      ...base,
      status: "failed",
      limitations: [],
      stage: "answer",
      code: "internal_error",
      message: "fetch failed: Authorization: Bearer sk-123",
      retryable: false,
    });
    expect(failed).toMatchObject({ status: "failed", code: "internal_error", retryable: false });
    expect(JSON.stringify(failed)).not.toContain("sk-123");
    const denied = browserResponse({
      ...base,
      status: "denied",
      limitations: [],
      reason: "stale_session",
      message: "Session ses_123 was superseded",
    });
    expect(JSON.stringify(denied)).not.toContain("ses_123");
    const index = browserIndex({
      repositoryId: "pilot",
      sha: "a".repeat(40),
      state: "failed",
      failure: { buildId: "b", code: "git_failed", message: "/srv/x: denied", retryable: true },
    });
    expect(index.failure).toEqual({
      buildId: "b",
      code: "git_failed",
      message: null,
      retryable: true,
    });
  });
});
