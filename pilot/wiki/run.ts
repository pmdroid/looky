/**
 * Real-provider wiki run: generate a bounded wiki of one repository at a
 * pinned commit, refresh it at a second commit, restart the service, and
 * exercise docs search and one page question per mode through the
 * production React build. Everything goes through the documented `serve`
 * process and its browser API; nothing in Looky is replaced.
 *
 *   LOOKY_PROVIDER=… LOOKY_PROVIDER_<ID>_… \
 *   bun run wiki:pilot --repo <git-dir> --id <repository-id> \
 *     --sha <first commit> --next <second commit> --out <dir> \
 *     [--link-template <url>] [--query <docs query>]… [--question <page question>] \
 *     [--page <slug>] [--data <dir>] [--price-in <usd per Mtok>] [--price-out <usd per Mtok>]
 *
 * The provider comes from the operator's `LOOKY_PROVIDER*` environment, and
 * `LOOKY_WIKI_*` budgets pass through unchanged. Output, never containing a
 * credential:
 *
 *   <out>/run.json                 configuration, timings, usage, checks
 *   <out>/<phase>/index.json       page index of each generation
 *   <out>/<phase>/pages/<slug>.md  every published page as served to the browser
 *   <out>/<phase>/citations.json   every citation with the exact cited lines from git
 *   <out>/<phase>/search.json      docs search results
 *   <out>/ui/                      React screenshots and the page answers
 *   <out>/report.md                generated summary; reviewer notes are added by hand
 *
 * Exit code 0 means the run finished and every automatic check passed. The
 * automatic checks are necessary, not sufficient: a person still reviews the
 * prose against the cited source.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright-core";
import { buildWeb } from "../../web/build";

const ROOT = resolve(import.meta.dir, "..", "..");
const NOT_FOUND = "(not found in the inspected source)";
const CARRIED = "Carried forward unchanged from commit";

// ---------------------------------------------------------------------------
// Arguments and configuration

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    id: { type: "string" },
    sha: { type: "string" },
    next: { type: "string" },
    out: { type: "string" },
    data: { type: "string" },
    "link-template": { type: "string" },
    query: { type: "string", multiple: true },
    question: { type: "string" },
    page: { type: "string" },
    "price-in": { type: "string" },
    "price-out": { type: "string" },
    "skip-ui": { type: "boolean" },
  },
});

function die(message: string): never {
  console.error(`wiki pilot: ${message}`);
  process.exit(2);
}

const repo = values.repo ? resolve(values.repo) : die("--repo is required");
const repositoryId = values.id ?? die("--id is required");
const sha1 = values.sha ?? die("--sha is required");
const sha2 = values.next ?? die("--next is required");
const out = values.out ? resolve(values.out) : die("--out is required");
for (const sha of [sha1, sha2]) {
  if (!/^[0-9a-f]{40}$/.test(sha)) die(`${sha} is not a full lowercase commit SHA`);
}
if (!process.env.LOOKY_PROVIDER) die("configure a provider with LOOKY_PROVIDER and its variables");
const queries = values.query?.length ? values.query : ["recovery", "configuration", "error"];
const question = values.question ?? "What does this part do, step by step, and where can it fail?";

function git(...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${new TextDecoder().decode(result.stderr)}`);
  }
  return new TextDecoder().decode(result.stdout);
}

/** Provider settings without credentials: id, kind, model, effort and endpoint origin. */
function providerRecord(): unknown[] {
  const env = process.env;
  const ids = [env.LOOKY_PROVIDER!, ...(env.LOOKY_PROVIDER_FALLBACK ?? "").split(",")]
    .map((id) => id.trim())
    .filter(Boolean);
  return ids.map((id) => {
    const key = (field: string) =>
      env[`LOOKY_PROVIDER_${id.toUpperCase().replace(/-/g, "_")}_${field}`];
    let origin: string | null = null;
    try {
      origin = key("BASE_URL") ? new URL(key("BASE_URL")!).origin : null;
    } catch {
      origin = "(invalid URL)";
    }
    return {
      id,
      kind: key("KIND") ?? null,
      model: key("MODEL") ?? null,
      reasoningEffort: key("REASONING_EFFORT") ?? null,
      endpoint: origin,
      timeoutMs: key("TIMEOUT_MS") ?? null,
      apiKey: key("API_KEY") ? "set (not recorded)" : "unset",
    };
  });
}

// ---------------------------------------------------------------------------
// The service

const scratch = mkdtempSync(join(tmpdir(), "looky-wiki-pilot-"));
const dataDir = values.data ? resolve(values.data) : join(scratch, "data");
const webToken = `web-${crypto.randomUUID()}`;
const opsToken = `ops-${crypto.randomUUID()}`;

function serviceEnv(assetsDir: string): Record<string, string> {
  const passed = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && /^LOOKY_(PROVIDER|WIKI_|ASK_|INDEX_)/.test(entry[0]),
    ),
  );
  const upper = repositoryId.toUpperCase().replace(/-/g, "_");
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...passed,
    LOOKY_HOST: "127.0.0.1",
    LOOKY_PORT: "0",
    LOOKY_DATA_DIR: dataDir,
    LOOKY_REPOSITORIES: repositoryId,
    [`LOOKY_REPOSITORY_${upper}_PATH`]: repo,
    LOOKY_CLIENTS: "web,ops",
    LOOKY_CLIENT_WEB_TOKEN: webToken,
    LOOKY_CLIENT_WEB_REPOSITORIES: repositoryId,
    LOOKY_CLIENT_OPS_TOKEN: opsToken,
    LOOKY_CLIENT_OPS_REPOSITORIES: repositoryId,
    LOOKY_BROWSER_CLIENT: "web",
    LOOKY_BROWSER_AUTH: "token",
    LOOKY_BROWSER_ASSETS_DIR: assetsDir,
    ...(values["link-template"] ? { LOOKY_SOURCE_LINK_TEMPLATE: values["link-template"] } : {}),
  };
}

interface Service {
  readonly url: string;
  readonly log: string[];
  stop(): Promise<void>;
}

async function startService(env: Record<string, string>): Promise<Service> {
  const child = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts"), "serve"], {
    cwd: ROOT,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const log: string[] = [];
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Looky did not start:\n${log.join("")}`)),
      60_000,
    );
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
        log.push(decoder.decode(chunk));
        const match = /listening on (http:\/\/[^;\s]+);/.exec(log.join(""));
        if (match) {
          clearTimeout(timer);
          resolveUrl(match[1]!);
        }
      }
      reject(new Error(`Looky exited before listening:\n${log.join("")}`));
    })().catch(reject);
  });
  return {
    url,
    log,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      const done = await Promise.race([child.exited, Bun.sleep(20_000).then(() => "timeout")]);
      if (done === "timeout") child.kill("SIGKILL");
    },
  };
}

/** The browser API as a signed-in tab uses it: cookie, CSRF and same origin. */
class Tab {
  #cookie: string | undefined;
  #csrf: string | undefined;
  constructor(readonly url: string) {}

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
    const headers: Record<string, string> = { origin: this.url };
    if (this.#cookie) headers.cookie = this.#cookie;
    if (this.#csrf && method !== "GET") headers["x-looky-csrf"] = this.#csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const cookie = response.headers.get("set-cookie");
    if (cookie) this.#cookie = cookie.split(";")[0];
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : undefined };
  }

  async signIn(): Promise<void> {
    const reply = await this.call("POST", "/browser/v1/session", { token: webToken });
    if (reply.status !== 201) throw new Error(`sign-in failed: HTTP ${reply.status}`);
    this.#csrf = reply.body.csrfToken;
  }

  async select(ref: string): Promise<string> {
    const reply = await this.call("POST", "/browser/v1/revisions", { repositoryId, ref });
    if (reply.status !== 200 && reply.status !== 201) {
      throw new Error(`selecting ${ref}: HTTP ${reply.status} ${JSON.stringify(reply.body)}`);
    }
    return reply.body.revision.id;
  }

  wiki(revisionId: string, rest = ""): string {
    return `/browser/v1/revisions/${revisionId}/wiki${rest}`;
  }
}

// ---------------------------------------------------------------------------
// Checks

interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const checks: Check[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  checks.push({ name, ok, detail });
  console.error(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

const treeCache = new Map<string, Set<string>>();
function tree(sha: string): Set<string> {
  let paths = treeCache.get(sha);
  if (!paths) {
    paths = new Set(git("ls-tree", "-r", "--name-only", "-z", sha).split("\0").filter(Boolean));
    treeCache.set(sha, paths);
  }
  return paths;
}

const fileCache = new Map<string, string[]>();
function lines(sha: string, path: string): string[] {
  const key = `${sha}:${path}`;
  let text = fileCache.get(key);
  if (!text) {
    text = git("show", key).replace(/\n$/, "").split("\n");
    fileCache.set(key, text);
  }
  return text;
}

// ---------------------------------------------------------------------------
// One commit: generate, export and verify

interface Phase {
  readonly name: string;
  readonly sha: string;
  readonly revisionId: string;
  readonly generation: any;
  readonly index: any;
  readonly pages: Map<string, any>;
  readonly wallMs: number;
  readonly statusBefore: any;
}

async function generate(tab: Tab, name: string, sha: string): Promise<Phase> {
  const dir = join(out, name);
  mkdirSync(join(dir, "pages"), { recursive: true });
  const revisionId = await tab.select(sha);
  const statusBefore = (await tab.call("GET", tab.wiki(revisionId))).body;
  const started = Date.now();
  let generationId: string | undefined;
  for (;;) {
    const reply = await tab.call("POST", tab.wiki(revisionId, "/generate"), {});
    if (reply.status !== 200 && reply.status !== 202) {
      throw new Error(`${name}: generate HTTP ${reply.status} ${JSON.stringify(reply.body)}`);
    }
    if (reply.body.state === "indexing") {
      await Bun.sleep(1_000);
      continue;
    }
    generationId = reply.body.generation.id;
    break;
  }
  let generation: any;
  let lastLog = 0;
  for (;;) {
    const status = (await tab.call("GET", tab.wiki(revisionId))).body;
    if (status.ready?.id === generationId) {
      generation = status.ready;
      break;
    }
    const latest = status.latest?.id === generationId ? status.latest : status.active;
    if (latest && ["failed", "cancelled"].includes(latest.state)) {
      generation = latest;
      break;
    }
    if (Date.now() - lastLog > 15_000 && status.active?.pages) {
      lastLog = Date.now();
      console.error(`${name}: ${JSON.stringify(status.active.pages)}`);
    }
    await Bun.sleep(2_000);
  }
  const wallMs = Date.now() - started;
  writeFileSync(join(dir, "status-before.json"), `${JSON.stringify(statusBefore, null, 2)}\n`);
  writeFileSync(join(dir, "generation.json"), `${JSON.stringify(generation, null, 2)}\n`);
  check(`${name}: generation published`, generation.state === "ready", generation.errorCode ?? "");
  if (generation.state !== "ready") {
    return {
      name,
      sha,
      revisionId,
      generation,
      index: null,
      pages: new Map(),
      wallMs,
      statusBefore,
    };
  }

  const index = (await tab.call("GET", tab.wiki(revisionId, `/generations/${generationId}`))).body;
  writeFileSync(join(dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  const pages = new Map<string, any>();
  const citations: unknown[] = [];
  let unverifiable = 0;
  let unknownNames = 0;
  for (const meta of index.pages) {
    if (meta.state !== "ready") continue;
    const view = (
      await tab.call("GET", tab.wiki(revisionId, `/generations/${generationId}/pages/${meta.slug}`))
    ).body;
    pages.set(meta.slug, view);
    writeFileSync(
      join(dir, "pages", `${meta.slug.replace(/\//g, "__")}.md`),
      `${view.body.markdown}\n`,
    );
    unknownNames += view.body.markdown.split(NOT_FOUND).length - 1;
    for (const citation of view.citations) {
      const exists = tree(sha).has(citation.path);
      const file = exists ? lines(sha, citation.path) : [];
      const inRange =
        exists &&
        citation.startLine >= 1 &&
        citation.endLine >= citation.startLine &&
        citation.endLine <= file.length;
      if (!inRange) unverifiable += 1;
      citations.push({
        page: meta.slug,
        path: citation.path,
        startLine: citation.startLine,
        endLine: citation.endLine,
        kind: citation.kind,
        link: citation.link,
        verified: inRange,
        text: inRange ? file.slice(citation.startLine - 1, citation.endLine).join("\n") : null,
      });
    }
  }
  writeFileSync(join(dir, "citations.json"), `${JSON.stringify(citations, null, 2)}\n`);

  const ready = new Set(pages.keys());
  const kinds = new Set(index.pages.map((page: any) => page.kind));
  check(
    `${name}: overview, architecture, module and workflow pages`,
    ["overview", "architecture", "module", "workflow"].every((kind) => kinds.has(kind)),
    [...kinds].join(", "),
  );
  check(
    `${name}: every citation is an exact range at ${sha.slice(0, 12)}`,
    unverifiable === 0,
    `${citations.length} citations, ${unverifiable} unverifiable`,
  );
  check(
    `${name}: every page cites source`,
    [...pages.values()].every((view) => view.citations.length > 0),
  );
  const broken = [...pages.entries()].flatMap(([slug, view]) =>
    [...view.body.markdown.matchAll(/\]\(wiki:([^)]+)\)/g)]
      .map((match) => match[1]!)
      .filter((target) => !ready.has(target))
      .map((target) => `${slug} -> ${target}`),
  );
  check(`${name}: every page link reaches a ready page`, broken.length === 0, broken.join("; "));
  const listed = new Set(index.pages.map((page: any) => page.pageId));
  check(
    `${name}: navigation links have no orphans`,
    index.links.every((link: any) => listed.has(link.fromPageId) && listed.has(link.toPageId)),
  );
  const pinned = [...pages.values()].every((view) =>
    view.body.markdown.includes(`Generated from commit \`${sha.slice(0, 12)}\``),
  );
  check(`${name}: every page names its own commit`, pinned);
  check(`${name}: names marked not found`, true, String(unknownNames));
  if (values["link-template"]) {
    const prefix = values["link-template"]
      .split("{sha}")[0]!
      .replace("{repositoryId}", repositoryId);
    const wrong = citations.filter(
      (item: any) => !item.link || !String(item.link).startsWith(`${prefix}${sha}`),
    );
    check(
      `${name}: every source link is pinned to the commit`,
      wrong.length === 0,
      `${wrong.length} not pinned`,
    );
  }

  const search: Record<string, unknown> = {};
  for (const query of queries) {
    const reply = await tab.call(
      "GET",
      tab.wiki(
        revisionId,
        `/generations/${generationId}/search?q=${encodeURIComponent(query)}&limit=10`,
      ),
    );
    search[query] = reply.body;
    const hits = reply.body?.hits ?? [];
    check(
      `${name}: search "${query}" returns only pages of this wiki`,
      reply.status === 200 && hits.every((hit: any) => ready.has(hit.slug)),
      `${hits.length} hits`,
    );
  }
  writeFileSync(join(dir, "search.json"), `${JSON.stringify(search, null, 2)}\n`);
  return { name, sha, revisionId, generation, index, pages, wallMs, statusBefore };
}

// ---------------------------------------------------------------------------
// The production React build

async function reactSmoke(url: string, phase: Phase): Promise<unknown> {
  const dir = join(out, "ui");
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const result: Record<string, unknown> = {};
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page: Page = await context.newPage();
    page.setDefaultTimeout(60_000);
    const answers: unknown[] = [];
    page.on("response", (response) => {
      if (!/\/browser\/v1\/questions\/[^/?]+/.test(response.url())) return;
      void response
        .json()
        .then((body) => {
          if (body?.response) answers.push(body);
        })
        .catch(() => undefined);
    });
    const query = `repo=${encodeURIComponent(repositoryId)}&ref=${phase.sha}`;
    await page.goto(`${url}/wiki?${query}`);
    await page.getByRole("heading", { name: "Sign in to Looky" }).waitFor();
    await page.getByLabel("Access token").fill(webToken);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.locator("#wiki-page-title").waitFor();
    await page.screenshot({ path: join(dir, "overview.png"), fullPage: true });

    const term = queries[0]!;
    await page.getByLabel("Search the docs").fill(term);
    await page.getByLabel("Search the docs").press("Enter");
    const results = page.locator(".search-results");
    await results.getByRole("heading", { name: /match/ }).waitFor();
    const hits = await results.getByRole("link").allInnerTexts();
    await page.screenshot({ path: join(dir, "search.png"), fullPage: true });
    result.search = { query: term, hits };
    if (hits.length > 0) {
      await results.getByRole("link").first().click();
      await page.locator("#wiki-page-title").waitFor();
      result.searchOpened = {
        title: await page.locator("#wiki-page-title").innerText(),
        path: new URL(page.url()).pathname + new URL(page.url()).hash,
      };
    }
    check(
      "ui: docs search through the React build",
      hits.length > 0,
      `${hits.length} hits for "${term}"`,
    );

    const target =
      (values.page && phase.pages.get(values.page)) ??
      [...phase.pages.values()].find((view) => view.page.kind === "workflow") ??
      [...phase.pages.values()].find((view) => view.page.kind === "module")!;
    await page.goto(`${url}/wiki/${target.page.slug}?${query}`);
    await page.locator("#wiki-page-title", { hasText: target.page.title }).waitFor();
    for (const mode of ["fast", "deep"] as const) {
      const label = mode === "fast" ? "Fast" : "Deep";
      const started = Date.now();
      await page.getByLabel(`Your question about the page ${target.page.title}`).fill(question);
      await page.getByRole("radio", { name: new RegExp(`^${label}`) }).check();
      await page.getByRole("button", { name: `Ask in ${label}` }).click();
      const article = page.locator("article.answer");
      await article
        .getByRole("heading", { name: `${label} answer`, exact: true })
        .waitFor({ timeout: 240_000 });
      const text = await article.innerText();
      await page.screenshot({ path: join(dir, `page-question-${mode}.png`), fullPage: true });
      await Bun.sleep(500);
      const response = (answers.at(-1) as any)?.response;
      result[mode] = {
        page: target.page.slug,
        question,
        latencyMs: Date.now() - started,
        status: response?.status ?? null,
        mode: response?.mode ?? null,
        sha: response?.revision?.sha ?? null,
        usage: response?.usage ?? null,
        evidence: response?.evidence ?? null,
        text,
      };
      check(
        `ui: page question in ${label}`,
        response?.mode?.executed === mode && response?.revision?.sha === phase.sha,
        `${response?.status ?? "no response"} at ${String(response?.revision?.sha ?? "").slice(0, 12)}`,
      );
    }
    await context.close();
  } finally {
    await browser.close();
  }
  writeFileSync(join(dir, "ui.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

// ---------------------------------------------------------------------------
// Report

function usageLine(generation: any): Record<string, unknown> {
  const usage = generation.usage ?? {};
  const priceIn = values["price-in"] ? Number(values["price-in"]) : undefined;
  const priceOut = values["price-out"] ? Number(values["price-out"]) : undefined;
  const cost =
    priceIn !== undefined && priceOut !== undefined
      ? ((usage.inputTokens ?? 0) * priceIn + (usage.outputTokens ?? 0) * priceOut) / 1e6
      : null;
  return { ...usage, estimatedCostUsd: cost };
}

function pageTable(phase: Phase): string {
  const rows = phase.index.pages.map((meta: any) => {
    const view = phase.pages.get(meta.slug);
    const reused = view?.body.markdown.includes(CARRIED) ? "reused" : view ? "written" : meta.state;
    const files = view ? new Set(view.citations.map((c: any) => c.path)).size : 0;
    return `| \`${meta.slug}\` | ${meta.kind} | ${meta.title} | ${meta.state} | ${reused} | ${view?.citations.length ?? 0} | ${files} |`;
  });
  return [
    "| Slug | Kind | Title | State | Prose | Citations | Cited files |",
    "| ---- | ---- | ----- | ----- | ----- | --------- | ----------- |",
    ...rows,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Run

mkdirSync(out, { recursive: true });
const assets = join(scratch, "web");
const record: Record<string, unknown> = { startedAt: new Date().toISOString() };
let service: Service | undefined;
const done: Phase[] = [];
try {
  const lookyCommit = new TextDecoder()
    .decode(Bun.spawnSync(["git", "-C", ROOT, "rev-parse", "HEAD"]).stdout)
    .trim();
  record.looky = { commit: lookyCommit };
  record.repository = { id: repositoryId, first: sha1, second: sha2 };
  record.providers = providerRecord();
  record.wikiSettings = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith("LOOKY_WIKI_")),
  );
  record.changes = git("diff", "--name-status", "-M", sha1, sha2)
    .trim()
    .split("\n")
    .filter(Boolean);

  await buildWeb(assets);
  const env = serviceEnv(assets);
  service = await startService(env);
  const tab = new Tab(service.url);
  await tab.signIn();

  const first = await generate(tab, "first", sha1);
  done.push(first);
  if (first.generation.state !== "ready") throw new Error("the first generation did not publish");

  const second = await generate(tab, "second", sha2);
  done.push(second);
  check(
    "second: the first wiki is disclosed as stale before the refresh",
    second.statusBefore?.stale?.generation?.sha === sha1 && !second.statusBefore?.ready,
  );
  if (second.generation.state === "ready") {
    const usage = second.generation.usage ?? {};
    check(
      "second: unchanged pages reused without a model call",
      (usage.pagesReused ?? 0) > 0,
      `${usage.pagesWritten ?? 0} written, ${usage.pagesReused ?? 0} reused`,
    );
    check("second: affected pages rewritten", (usage.pagesWritten ?? 0) > 0);
    const deleted = new Set(
      (record.changes as string[]).flatMap((line) => {
        const [status, path] = line.split("\t");
        return status === "D" || status!.startsWith("R") ? [path!] : [];
      }),
    );
    const stale = [...second.pages.values()].flatMap((view) =>
      [...view.citations, ...view.plannedSources]
        .filter((ref: any) => deleted.has(ref.path))
        .map((ref: any) => `${view.page.slug}: ${ref.path}`),
    );
    check("second: no page cites a deleted or renamed path", stale.length === 0, stale.join("; "));
    const previous = [...first.pages.keys()];
    const outcomes: Record<string, number> = {};
    for (const slug of previous) {
      const reply = await tab.call(
        "GET",
        tab.wiki(second.revisionId, `/generations/${second.generation.id}/pages/${slug}`),
      );
      const key =
        reply.status === 200
          ? reply.body.redirectedFrom
            ? "redirect"
            : "same"
          : String(reply.status);
      outcomes[key] = (outcomes[key] ?? 0) + 1;
    }
    check(
      "second: every earlier slug resolves, redirects or answers removed",
      Object.keys(outcomes).every((key) => ["same", "redirect", "410"].includes(key)),
      JSON.stringify(outcomes),
    );
    record.oldSlugs = outcomes;
  }

  // Restart: the published wiki is served from SQLite and costs nothing again.
  await service.stop();
  service = await startService(env);
  const after = new Tab(service.url);
  await after.signIn();
  const revision = await after.select(sha2);
  const reopened = (await after.call("GET", after.wiki(revision))).body;
  const again = (await after.call("POST", after.wiki(revision, "/generate"), {})).body;
  check(
    "restart: the refreshed wiki is reused",
    reopened.ready?.id === second.generation.id &&
      again.state === "ready" &&
      again.generation?.id === second.generation.id,
  );

  if (!values["skip-ui"] && second.generation.state === "ready") {
    record.ui = await reactSmoke(service.url, second);
  }

  record.phases = Object.fromEntries(
    [first, second].map((phase) => [
      phase.name,
      {
        sha: phase.sha,
        generationId: phase.generation.id,
        state: phase.generation.state,
        errorCode: phase.generation.errorCode,
        pageCount: phase.generation.pageCount,
        readyPages: phase.pages.size,
        wallMs: phase.wallMs,
        usage: usageLine(phase.generation),
      },
    ]),
  );
} catch (error) {
  record.error = error instanceof Error ? error.message : String(error);
  check("run finished", false, String(record.error).slice(0, 400));
} finally {
  await service?.stop();
  record.finishedAt = new Date().toISOString();
  record.checks = checks;
  writeFileSync(join(out, "run.json"), `${JSON.stringify(record, null, 2)}\n`);
  if (service)
    writeFileSync(
      join(out, "service.log"),
      service.log.join("").replaceAll(webToken, "<web token>").replaceAll(opsToken, "<ops token>"),
    );
  if (!values.data) rmSync(scratch, { recursive: true, force: true });
}

const phases = (record.phases ?? {}) as Record<string, any>;
const report = [
  `# Wiki run on ${repositoryId}`,
  "",
  `Looky \`${(record.looky as any)?.commit ?? "?"}\`, first commit \`${sha1}\`, second commit \`${sha2}\`.`,
  "",
  "## Configuration",
  "",
  "```json",
  JSON.stringify({ providers: record.providers, wikiSettings: record.wikiSettings }, null, 2),
  "```",
  "",
  "## Generations",
  "",
  "| Commit | State | Pages | Written | Reused | Model calls | Input tokens | Output tokens | Wall time |",
  "| ------ | ----- | ----- | ------- | ------ | ----------- | ------------ | ------------- | --------- |",
  ...Object.values(phases).map(
    (phase: any) =>
      `| \`${phase.sha.slice(0, 12)}\` | ${phase.state} | ${phase.readyPages} | ${phase.usage.pagesWritten ?? "?"} | ${phase.usage.pagesReused ?? "?"} | ${phase.usage.modelCalls ?? "?"} | ${phase.usage.inputTokens ?? "?"} | ${phase.usage.outputTokens ?? "?"} | ${(phase.wallMs / 1000).toFixed(0)} s |`,
  ),
  "",
  ...done.flatMap((phase) =>
    phase.index ? [`## Page index at \`${phase.sha.slice(0, 12)}\``, "", pageTable(phase), ""] : [],
  ),
  "## Checks",
  "",
  ...checks.map(
    (item) =>
      `- ${item.ok ? "Pass" : "**Fail**"}: ${item.name}${item.detail ? `. ${item.detail}` : ""}`,
  ),
  "",
  "## Review",
  "",
  "**Status: not reviewed.** Automatic checks prove citations, links, refresh and restart, not",
  "that the prose is true. This run is not acceptance evidence until a reviewer reads the",
  "overview, architecture, two module pages and two workflow pages, checks each substantive",
  "claim against `citations.json` at the pinned commit, records supported, qualified or",
  "unsupported per claim here, and changes the status line.",
  "",
].join("\n");
writeFileSync(join(out, "report.md"), report);
const failed = checks.filter((item) => !item.ok);
console.error(
  `\n${checks.length - failed.length}/${checks.length} checks passed; output in ${out}`,
);
process.exit(failed.length === 0 ? 0 : 1);
