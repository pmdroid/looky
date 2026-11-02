/**
 * The generated wiki in the production browser app, against the real Looky
 * service.
 *
 * Nothing here is fixture content: the wiki is planned from Looky's index of
 * temporary Git repositories and written page by page by Looky's own
 * generator through its real HTTP provider client, then published and
 * served by the browser adapter. Only the model's replies are scripted, from
 * the evidence each prompt shows, as a model would see it.
 *
 * Tests run in order and share one service, as one person's session would:
 * generate, browse, search, ask, move between revisions, then sign in again.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { commitAll, git, write } from "../test/support/git-fixture";
import {
  answer,
  launchBrowser,
  open,
  pageFetch,
  staysWithoutAnswer,
  statusTitle,
  waitIndexReady,
  waitFocused,
  waitPinned,
  type Browser,
  type Opened,
  type Page,
} from "./support/app";
import {
  buildApp,
  LINK_TEMPLATE,
  LookyProcess,
  serviceEnv,
  tempRoot,
  WEB_TOKEN,
  type Env,
} from "./support/looky";
import { type Hold, ScriptedProvider } from "./support/provider";
import { createRepos, type Repos } from "./support/repos";

const LONG = 120_000;

let root: ReturnType<typeof tempRoot>;
let repos: Repos;
/** `slim` of pilot: billing renamed to invoicing, the worker deleted. */
let slimSha: string;
let provider: ScriptedProvider;
let looky: LookyProcess;
let env: Env;
let browser: Browser;
/** One person's tab, kept across tests. */
let main: Opened;
const extra: Opened[] = [];
const holds: Hold[] = [];

/** Browser API calls that start, cancel or retry generation. */
const wikiPosts: string[] = [];

async function signIn(page: Page): Promise<void> {
  await page.getByRole("heading", { name: "Sign in to Looky" }).waitFor();
  await page.getByLabel("Access token").fill(WEB_TOKEN);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function openSignedIn(
  path: string,
  viewport?: { width: number; height: number },
): Promise<Opened> {
  const opened = await open(browser, `${looky.url}${path}`, viewport ? { viewport } : {});
  await signIn(opened.page);
  return opened;
}

/** Wait until the page with this title is shown. */
async function pageTitle(page: Page, title: string, timeout = 30_000): Promise<void> {
  await page
    .locator("#wiki-page-title", { hasText: new RegExp(`^${title}$`) })
    .waitFor({ timeout });
}

function path(page: Page): string {
  const url = new URL(page.url());
  return `${url.pathname}${url.hash}`;
}

function sidebar(page: Page) {
  return page.getByRole("navigation", { name: "Wiki" });
}

/** The start of every source link Looky builds for pilot at `sha`, up to the file path. */
function linkPrefix(sha: string): string {
  return LINK_TEMPLATE.slice(0, LINK_TEMPLATE.indexOf("{path}"))
    .replace("{repositoryId}", "pilot")
    .replace("{sha}", sha);
}

function holdWiki(): Hold {
  const held = provider.holdWiki();
  holds.push(held);
  return held;
}

function holdAnswer(marker: string): Hold {
  const held = provider.hold(marker);
  holds.push(held);
  return held;
}

/** Every link in the shown page body goes to a wiki page in the app or to a cited source. */
async function bodyLinksAreSafe(page: Page): Promise<void> {
  const hrefs = await page
    .locator(".wiki-prose a")
    .evaluateAll((items) => items.map((item) => item.getAttribute("href") ?? ""));
  for (const href of hrefs) {
    expect(href.startsWith("/wiki/") || href.startsWith("https://code.example.test/pilot/")).toBe(
      true,
    );
  }
  expect(
    await page.locator(".wiki-prose img, .wiki-prose script, .wiki-prose iframe").count(),
  ).toBe(0);
}

beforeAll(async () => {
  root = tempRoot("looky-e2e-wiki-");
  repos = createRepos(root.path);
  git(repos.pilot, "checkout", "--quiet", "-b", "slim");
  git(repos.pilot, "mv", "src/billing", "src/invoicing");
  git(repos.pilot, "rm", "-r", "--quiet", "src/worker");
  slimSha = commitAll(repos.pilot, "rename billing, drop the worker");
  git(repos.pilot, "checkout", "--quiet", "main");

  provider = new ScriptedProvider();
  // The Config page's model reply tries markup, script links and images.
  provider.scriptWiki((call) => {
    if (call.page?.title !== "Config") return undefined;
    const first = call.evidence[0]!;
    return {
      json: {
        summary: `Config holds the retry policy [${first.id}]. <img src=x onerror="alert('summary')">`,
        sections: [
          {
            heading: "Retry policy <script>alert('heading')</script>",
            basis: "observed",
            body:
              `The policy limits replays [${first.id}]. [Open me](javascript:alert('link')) ` +
              `and ![tracker](https://evil.test/p.png) and <a href="https://evil.test">this</a>.`,
          },
        ],
        intent: [],
        caveats: [],
      },
    };
  });
  const assets = await buildApp(join(root.path, "web"));
  env = serviceEnv({
    repos,
    provider,
    assetsDir: assets,
    dataDir: join(root.path, "data"),
    extra: { LOOKY_BROWSER_AUTH: "token" },
  });
  looky = await LookyProcess.start(env);
  browser = await launchBrowser();
  main = await openSignedIn("/wiki?repo=pilot&ref=HEAD");
  main.page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "POST" && /\/wiki\/(generate|generations\/)/.test(url.pathname)) {
      wikiPosts.push(url.pathname.replace(/^.*\/wiki\//, ""));
    }
  });
}, LONG);

afterEach(async () => {
  for (const held of holds.splice(0)) held.release();
  for (const opened of extra.splice(0)) await opened.context.close();
});

afterAll(async () => {
  await browser?.close();
  await looky?.stop();
  await provider?.stop();
  root?.cleanup();
});

describe("generating", () => {
  test(
    "generation starts only from its button, shows progress, cancels, and retries only when asked",
    async () => {
      const { page } = main;
      await waitPinned(page, repos.pilotSha);
      await waitIndexReady(page);
      await page.getByRole("heading", { name: "No wiki for this commit yet" }).waitFor();
      await page.waitForTimeout(500);
      expect(wikiPosts).toEqual([]);
      expect(provider.calls.filter((call) => call.kind === "wiki")).toHaveLength(0);

      const held = holdWiki();
      // A double click starts one generation, not two.
      await page.getByRole("button", { name: "Generate wiki" }).dblclick();
      await held.started;
      await page.getByRole("heading", { name: "Writing the wiki for this commit" }).waitFor();
      await page.getByText(/0 of 10 pages written, 2 being written/).waitFor();
      expect(await page.getByRole("progressbar", { name: "Wiki pages written" }).count()).toBe(1);
      expect(wikiPosts).toEqual(["generate"]);

      await page.getByRole("button", { name: "Cancel generation" }).click();
      await page.getByRole("heading", { name: "Wiki generation was cancelled" }).waitFor();
      await page.getByText("Nothing is retried automatically").waitFor();
      held.release();
      await page.waitForTimeout(1_500);
      expect(wikiPosts.filter((item) => !item.endsWith("/cancel"))).toEqual(["generate"]);

      await page.getByRole("button", { name: "Try generation again" }).click();
      await pageTitle(page, "Overview", 60_000);
      expect(wikiPosts.filter((item) => item.endsWith("/retry"))).toHaveLength(1);
      expect(wikiPosts.filter((item) => item === "generate")).toHaveLength(1);
      expect(path(page)).toBe("/wiki");
    },
    LONG,
  );
});

describe("reading", () => {
  test(
    "overview, then a module, then a workflow, then a citation at the exact commit",
    async () => {
      const { page, traffic } = main;
      const coverage = page.locator(".wiki-coverage");
      await coverage.getByText("11 indexed files of 11 fall within a page.").waitFor();
      await coverage.getByText("5 of 5 modules and 1 of 1 workflow have pages.").waitFor();
      await page
        .locator(".wiki-prose")
        .getByText(/Overview is explained here/)
        .waitFor();
      expect(await page.locator(".wiki-provenance code.sha").first().getAttribute("title")).toBe(
        repos.pilotSha,
      );
      expect(await page.locator(".wiki-provenance code.sha").nth(1).getAttribute("title")).toBe(
        repos.pilotSha,
      );
      await page.getByText("Generated documentation for this exact commit.").waitFor();

      await sidebar(page).getByRole("link", { name: "Recovery", exact: true }).click();
      await pageTitle(page, "Recovery");
      expect(path(page)).toBe("/wiki/modules/recovery");
      // The address names the commit HEAD resolved to, not HEAD, so it never moves.
      expect(new URL(page.url()).search).toBe(`?repo=pilot&ref=${repos.pilotSha}`);
      const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
      expect(await crumbs.getByRole("link").allInnerTexts()).toEqual(["Overview", "Modules"]);
      expect(
        await sidebar(page)
          .getByRole("link", { name: "Recovery", exact: true })
          .getAttribute("aria-current"),
      ).toBe("page");
      const toc = page.getByRole("navigation", { name: "On this page" });
      expect(await toc.getByRole("link").allInnerTexts()).toContain("How the parts connect");
      const related = page.locator(".related");
      await related.getByRole("link", { name: "Config" }).waitFor();
      expect(await related.innerText()).toContain("Used by");
      await bodyLinksAreSafe(page);

      await related.getByRole("link", { name: "Supervisor flow" }).click();
      await pageTitle(page, "Supervisor flow");
      expect(path(page)).toBe("/wiki/workflows/supervisor");
      await page.locator(".wiki-head").getByText("Workflow", { exact: true }).waitFor();
      const citations = page.locator("section[aria-labelledby='citations-title'] > ol.sources a");
      expect(await citations.count()).toBeGreaterThan(0);
      const href = (await citations.first().getAttribute("href"))!;
      expect(href.startsWith(linkPrefix(repos.pilotSha))).toBe(true);
      expect(await citations.first().getAttribute("target")).toBe("_blank");
      expect(await citations.first().getAttribute("rel")).toBe("noopener noreferrer nofollow");
      // Every citation in the page body is one of the page's own source links at this commit.
      const listed = new Set(
        await citations.evaluateAll((items) => items.map((item) => item.getAttribute("href"))),
      );
      const inBody = await page
        .locator(".wiki-prose a[target=_blank]")
        .evaluateAll((items) => items.map((item) => item.getAttribute("href")));
      expect(inBody.length).toBeGreaterThan(0);
      for (const cited of inBody) expect(listed.has(cited)).toBe(true);

      // A link inside the generated text moves within the app, without a reload.
      await page.evaluate(() => {
        (window as unknown as { marker: number }).marker = 1;
      });
      const wikiLink = page.locator(".wiki-prose a[data-wiki-slug]").first();
      const slug = (await wikiLink.getAttribute("data-wiki-slug"))!;
      await wikiLink.click();
      await page.waitForURL((url) => url.pathname === `/wiki/${slug}`);
      await page.locator("#wiki-page-title").waitFor();
      expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
      expect(traffic.errors).toEqual([]);
    },
    LONG,
  );

  test("generated markup is shown as text and only allowed links survive", async () => {
    const { page, traffic } = main;
    await sidebar(page).getByRole("link", { name: "Config", exact: true }).click();
    await pageTitle(page, "Config");
    await page
      .locator(".wiki-prose")
      .getByText(/Config holds the retry policy/)
      .waitFor();
    await bodyLinksAreSafe(page);
    expect(await page.locator(".wiki-prose").innerHTML()).not.toContain("javascript:");
    await page.waitForTimeout(300);
    expect(traffic.dialogs).toEqual([]);
    expect(traffic.errors).toEqual([]);
  }, 60_000);

  test(
    "a heading link, Back, Forward, reload and a shared link all land on the same place",
    async () => {
      const { page } = main;
      await sidebar(page).getByRole("link", { name: "Storage", exact: true }).click();
      await pageTitle(page, "Storage");
      await page
        .getByRole("navigation", { name: "On this page" })
        .getByRole("link", { name: "How the parts connect" })
        .click();
      expect(path(page)).toBe("/wiki/modules/storage#how-the-parts-connect");
      await waitFocused(page, "wiki-h-how-the-parts-connect");

      await page.goBack();
      expect(path(page)).toBe("/wiki/modules/storage");
      await page.goBack();
      await pageTitle(page, "Config");
      expect(path(page)).toBe("/wiki/modules/config");
      await page.goForward();
      await pageTitle(page, "Storage");
      await page.goForward();
      await waitFocused(page, "wiki-h-how-the-parts-connect");

      await page.reload();
      await pageTitle(page, "Storage");
      await waitFocused(page, "wiki-h-how-the-parts-connect");

      // Another person opens the same link in a new browser and signs in.
      const shared = await openSignedIn(
        "/wiki/modules/storage?repo=pilot&ref=HEAD#how-the-parts-connect",
      );
      extra.push(shared);
      await pageTitle(shared.page, "Storage");
      await waitFocused(shared.page, "wiki-h-how-the-parts-connect");
      expect(await shared.page.locator("#repository").inputValue()).toBe("pilot");
    },
    LONG,
  );

  test("docs search finds a heading and opens its page at that heading", async () => {
    const { page } = main;
    const searches: string[] = [];
    const onRequest = (request: { url(): string }) => {
      const url = new URL(request.url());
      if (url.pathname.endsWith("/search")) searches.push(url.pathname);
    };
    page.on("request", onRequest);
    await page.getByLabel("Search the docs").fill("cooperate");
    await page.getByLabel("Search the docs").press("Enter");
    const results = page.locator(".search-results");
    await results.getByRole("heading", { name: /matches? for “cooperate”/ }).waitFor();
    const hit = results.getByRole("link", { name: /^Billing › How the parts connect$/ });
    await hit.click();
    await pageTitle(page, "Billing");
    expect(path(page)).toBe("/wiki/modules/billing#how-the-parts-connect");
    await waitFocused(page, "wiki-h-how-the-parts-connect");
    // Every hit is a page of this wiki, and the search named this revision's published wiki.
    const slugs = await sidebar(page)
      .locator(".toc-tree a")
      .evaluateAll((items) =>
        items.map((item) => new URL((item as HTMLAnchorElement).href).pathname),
      );
    const hits = await results
      .getByRole("link")
      .evaluateAll((items) =>
        items.map((item) => new URL((item as HTMLAnchorElement).href).pathname),
      );
    expect(hits.length).toBeGreaterThan(1);
    for (const hitPath of hits) expect(slugs).toContain(hitPath);
    expect(searches.length).toBeGreaterThan(0);
    for (const search of searches) {
      expect(search).toMatch(
        /^\/browser\/v1\/revisions\/[^/]+\/wiki\/generations\/wiki_[^/]+\/search$/,
      );
    }
    // Escape clears the search.
    await page.getByLabel("Search the docs").press("Escape");
    expect(await results.count()).toBe(0);
    page.off("request", onRequest);
  }, 60_000);
});

describe("asking about a page", () => {
  test(
    "a page question runs in Fast or Deep on the same commit, and ordinary questions are unchanged",
    async () => {
      const { page, traffic } = main;
      await sidebar(page).getByRole("link", { name: "Recovery", exact: true }).click();
      await pageTitle(page, "Recovery");
      const fast = "Which errors can recovery raise? (page fast)";
      await page.getByLabel("Your question about the page Recovery").fill(fast);
      await page.getByRole("radio", { name: /^Fast/ }).check();
      await page.getByRole("button", { name: "Ask in Fast" }).click();
      const article = await answer(page, "fast");
      await article.getByText("About the wiki page “Recovery”").waitFor();
      const submitted = traffic.submissions.findLast(
        (item) => item.question === fast,
      ) as unknown as {
        wikiPage?: { generationId: string; pageId: string };
        mode: string;
      };
      expect(submitted.mode).toBe("fast");
      expect(submitted.wikiPage?.generationId).toMatch(/^wiki_/);
      const view = await traffic.completed(fast);
      expect(view?.sha).toBe(repos.pilotSha);
      // The page is context for retrieval, never evidence: only its planner metadata is added.
      const call = provider.callsFor("(page fast)", "answer")[0]!;
      expect(call.question).toContain(
        'Context: the reader is viewing the generated wiki page titled "Recovery"',
      );
      expect(call.question).not.toContain("is explained here from the committed source");
      expect(path(page)).toBe("/wiki/modules/recovery");

      const deep = "Walk through recovery across files (page deep)";
      await page.getByLabel("Your question about the page Recovery").fill(deep);
      await page.getByRole("radio", { name: /^Deep/ }).check();
      await page.getByRole("button", { name: "Ask in Deep" }).click();
      const deepArticle = await answer(page, "deep");
      await deepArticle.getByText("About the wiki page “Recovery”").waitFor();
      expect(provider.callsFor("(page deep)", "plan").length).toBeGreaterThan(0);

      // The code question screen is still there, and its questions name no page.
      await page
        .getByRole("navigation", { name: "Views" })
        .getByRole("link", { name: "Ask" })
        .click();
      expect(path(page)).toBe("/");
      const plain = "How does resumeInterruptedRun recover a crashed run? (plain)";
      await page.getByRole("radio", { name: /^Fast/ }).check();
      await page.getByLabel("Your question about the code").fill(plain);
      await page.getByRole("button", { name: "Ask in Fast" }).click();
      const plainArticle = await answer(page, "fast");
      expect(await plainArticle.getByText(/About the wiki page/).count()).toBe(0);
      const sent = traffic.submissions.findLast((item) => item.question === plain)!;
      expect(sent).not.toHaveProperty("wikiPage");

      await page
        .getByRole("navigation", { name: "Views" })
        .getByRole("link", { name: "Wiki" })
        .click();
      await pageTitle(page, "Overview");
    },
    LONG,
  );

  test(
    "a late answer never appears under another page or another revision",
    async () => {
      const { page, traffic } = main;
      await sidebar(page).getByRole("link", { name: "Recovery", exact: true }).click();
      await pageTitle(page, "Recovery");
      await page.getByRole("radio", { name: /^Fast/ }).check();

      const late = holdAnswer("(late page)");
      await page
        .getByLabel("Your question about the page Recovery")
        .fill("Why replay? (late page)");
      await page.getByRole("button", { name: "Ask in Fast" }).click();
      const held = await late.started;
      await statusTitle(page, "Working on the Fast answer");
      await sidebar(page).getByRole("link", { name: "Storage", exact: true }).click();
      await pageTitle(page, "Storage");
      await provider.waitFor(() => held.status === "aborted", 15_000);
      expect(traffic.cancels.length).toBeGreaterThan(0);
      late.release();
      await staysWithoutAnswer(page);
      expect(await page.locator(".status-title").count()).toBe(0);

      const moved = holdAnswer("(late revision)");
      await page.getByLabel("Your question about the page Storage").fill("Where? (late revision)");
      await page.getByRole("button", { name: "Ask in Fast" }).click();
      const heldMoved = await moved.started;
      await statusTitle(page, "Working on the Fast answer");
      await page.getByLabel("Revision").selectOption("refs/heads/feature");
      await waitPinned(page, repos.featureSha);
      await provider.waitFor(() => heldMoved.status === "aborted", 15_000);
      moved.release();
      await staysWithoutAnswer(page);
      // The same page address at the new revision, which has no wiki yet.
      expect(path(page)).toBe("/wiki/modules/storage");
      expect(new URL(page.url()).searchParams.get("ref")).toBe(repos.featureSha);
      await page.getByRole("heading", { name: "No wiki for this commit yet" }).waitFor();
      expect(await page.locator("#wiki-page-title").count()).toBe(0);
    },
    LONG,
  );
});

describe("revisions", () => {
  test(
    "switching revision while a wiki is written shows only the chosen revision's wiki",
    async () => {
      const { page } = main;
      await waitIndexReady(page);
      const held = holdWiki();
      await page.getByRole("button", { name: "Generate wiki" }).click();
      await held.started;
      await page.getByRole("heading", { name: "Writing the wiki for this commit" }).waitFor();

      await page.getByLabel("Revision").selectOption("HEAD");
      await waitPinned(page, repos.pilotSha);
      await pageTitle(page, "Storage");
      expect(await page.locator(".wiki-provenance code.sha").nth(1).getAttribute("title")).toBe(
        repos.pilotSha,
      );
      expect(await page.getByRole("heading", { name: /Writing the wiki/ }).count()).toBe(0);
      held.release();
      await page.waitForTimeout(1_000);
      expect(await page.getByRole("heading", { name: /Writing the wiki/ }).count()).toBe(0);

      // Back at the feature branch, its own wiki finished without another start.
      await page.getByLabel("Revision").selectOption("refs/heads/feature");
      await waitPinned(page, repos.featureSha);
      await pageTitle(page, "Storage", 60_000);
      expect(await page.locator(".wiki-provenance code.sha").nth(1).getAttribute("title")).toBe(
        repos.featureSha,
      );
      expect(wikiPosts.filter((item) => item === "generate")).toHaveLength(2);
    },
    LONG,
  );

  test(
    "a renamed page redirects and a removed or unknown page says so",
    async () => {
      const { page } = main;
      await page.getByLabel("Revision").selectOption("refs/heads/slim");
      await waitPinned(page, slimSha);
      await waitIndexReady(page);
      await page.getByRole("button", { name: "Generate wiki" }).click();
      await pageTitle(page, "Storage", 60_000);

      await page.goto(`${looky.url}/wiki/modules/billing?repo=pilot&ref=refs%2Fheads%2Fslim`);
      await pageTitle(page, "Invoicing");
      expect(path(page)).toBe("/wiki/modules/invoicing");
      await page.getByText("This page moved from").waitFor();

      await page.goto(`${looky.url}/wiki/modules/worker?repo=pilot&ref=refs%2Fheads%2Fslim`);
      await page.getByRole("heading", { name: "This page was removed" }).waitFor();
      await page.getByText("“Worker” is not part of the wiki at this commit any more").waitFor();
      await page.getByRole("link", { name: "Go to the wiki overview" }).click();
      await pageTitle(page, "Overview");
      expect(await sidebar(page).getByRole("link", { name: "Worker" }).count()).toBe(0);

      await page.goto(`${looky.url}/wiki/modules/nothing-here?repo=pilot&ref=refs%2Fheads%2Fslim`);
      await page.getByRole("heading", { name: "No such page" }).waitFor();
      await page.goto(`${looky.url}/wiki/Not%20A%20Slug?repo=pilot&ref=refs%2Fheads%2Fslim`);
      await page.getByRole("heading", { name: "No such page" }).waitFor();

      // The same addresses at main still show the pages that exist there.
      await page.goto(`${looky.url}/wiki/modules/worker?repo=pilot&ref=HEAD`);
      await pageTitle(page, "Worker");
    },
    LONG,
  );

  test(
    "a wiki address keeps its commit after the branch it was opened from moves",
    async () => {
      const { page } = main;
      const selections: string[] = [];
      const onRequest = (request: { method(): string; url(): string }) => {
        if (request.method() === "POST" && request.url().endsWith("/browser/v1/revisions")) {
          selections.push(request.url());
        }
      };
      page.on("request", onRequest);
      try {
        await page.goto(`${looky.url}/wiki/modules/storage?repo=pilot&ref=refs%2Fheads%2Fslim`);
        await pageTitle(page, "Storage");
        await page.waitForURL((url) => url.searchParams.get("ref") === slimSha);
        await page
          .getByRole("navigation", { name: "On this page" })
          .getByRole("link", { name: "How the parts connect" })
          .click();
        await waitFocused(page, "wiki-h-how-the-parts-connect");
        const url = new URL(page.url());
        expect(url.searchParams.get("ref")).toBe(slimSha);
        expect(url.hash).toBe("#how-the-parts-connect");
        expect(
          await page.locator(".wiki-prose a[data-wiki-slug]").first().getAttribute("href"),
        ).toContain(`ref=${slimSha}`);

        // Back and Forward between pages of the pinned commit keep the same selection.
        const before = selections.length;
        await page.goBack();
        await page.goForward();
        await waitFocused(page, "wiki-h-how-the-parts-connect");
        expect(selections.length).toBe(before);

        // The branch moves on. The address still shows the commit it was opened at.
        git(repos.pilot, "checkout", "--quiet", "slim");
        write(repos.pilot, "src/storage/notes.md", "Checkpoints are kept per run.\n");
        const advanced = commitAll(repos.pilot, "advance slim");
        git(repos.pilot, "checkout", "--quiet", "main");
        expect(advanced).not.toBe(slimSha);
        await page.reload();
        await waitPinned(page, slimSha);
        await pageTitle(page, "Storage");
        await waitFocused(page, "wiki-h-how-the-parts-connect");
        expect(await page.locator(".wiki-provenance code.sha").nth(1).getAttribute("title")).toBe(
          slimSha,
        );

        // The branch itself now names the new commit, which has no wiki yet.
        await page.goto(`${looky.url}/wiki/modules/storage?repo=pilot&ref=refs%2Fheads%2Fslim`);
        await waitPinned(page, advanced);
        await page.getByRole("heading", { name: "No wiki for this commit yet" }).waitFor();
        expect(new URL(page.url()).searchParams.get("ref")).toBe(advanced);
      } finally {
        page.off("request", onRequest);
      }
      await page.goto(`${looky.url}/wiki/modules/worker?repo=pilot&ref=HEAD`);
      await pageTitle(page, "Worker");
    },
    LONG,
  );
});

describe("sessions and failures", () => {
  test(
    "an expired login asks to sign in again and returns to the page being opened",
    async () => {
      const { page } = main;
      await pageTitle(page, "Worker");
      const ended = await pageFetch(page, "/browser/v1/session", { method: "DELETE", csrf: true });
      expect(ended.status).toBe(204);
      await sidebar(page).getByRole("link", { name: "Recovery", exact: true }).click();
      await signIn(page);
      await pageTitle(page, "Recovery");
      expect(path(page)).toBe("/wiki/modules/recovery");
    },
    LONG,
  );

  test(
    "a provider failure is explained and retried only from its button",
    async () => {
      const { page } = main;
      provider.scriptWiki(() => ({ status: 401, body: { error: { type: "invalid_api_key" } } }));
      await page.getByLabel("Repository").selectOption("notes");
      await waitPinned(page, repos.notesSha);
      await waitIndexReady(page);
      const before = wikiPosts.length;
      await page.getByRole("button", { name: "Generate wiki" }).click();
      await page
        .getByRole("heading", { name: "Wiki generation failed" })
        .waitFor({ timeout: 60_000 });
      await page.getByText(/model provider was not available/).waitFor();
      await page.getByRole("button", { name: "Try generation again" }).waitFor();
      await page.waitForTimeout(1_500);
      expect(wikiPosts.slice(before)).toEqual(["generate"]);
    },
    LONG,
  );

  test(
    "a service without a model provider says generation is unavailable",
    async () => {
      const bare: Env = { ...env, LOOKY_DATA_DIR: join(root.path, "bare-data") };
      for (const key of Object.keys(bare)) if (key.startsWith("LOOKY_PROVIDER")) delete bare[key];
      const service = await LookyProcess.start(bare);
      try {
        const opened = await open(browser, `${service.url}/wiki?repo=notes&ref=HEAD`);
        extra.push(opened);
        await signIn(opened.page);
        await waitIndexReady(opened.page);
        await opened.page.getByRole("button", { name: "Generate wiki" }).click();
        await opened.page
          .getByText("Wiki generation is not available on this Looky service.")
          .waitFor();
        // Code questions are a separate feature and stay available.
        expect(await opened.page.getByRole("link", { name: "Ask" }).count()).toBe(1);
      } finally {
        await service.stop();
      }
    },
    LONG,
  );
});

describe("keyboard and small screens", () => {
  test("a 320 px phone reads a page without page overflow, and the skip link reaches it", async () => {
    const opened = await openSignedIn("/wiki/modules/recovery?repo=pilot&ref=HEAD", {
      width: 320,
      height: 640,
    });
    extra.push(opened);
    const { page } = opened;
    await pageTitle(page, "Recovery");
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(320);
    for (const control of [
      page.getByLabel("Search the docs"),
      page.locator("#wiki-page-title"),
      page.getByLabel("Your question about the page Recovery"),
      page.locator("ol.sources a").first(),
    ]) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320.5);
    }
    await page.reload();
    await pageTitle(page, "Recovery");
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Skip to the page");
    await page.keyboard.press("Enter");
    await waitFocused(page, "wiki-main");
  }, 60_000);
});
