/**
 * Access, failure outcomes, keyboard use and small screens in the production
 * browser app against the real Looky service.
 *
 * This service uses token sign-in, one question slot without a queue (so a
 * second question is `busy`) and a short Fast time limit (so a held provider
 * call ends as `timed_out`). Held questions that must outlive that limit use Deep.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  answer,
  ask,
  launchBrowser,
  open,
  pageFetch,
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
  LookyProcess,
  PAWS_TOKEN,
  serviceEnv,
  tempRoot,
  WEB_TOKEN,
} from "./support/looky";
import { cite, groundedAnswer, ScriptedProvider, type Hold } from "./support/provider";
import { createRepos, type Repos } from "./support/repos";

const FAST_LIMIT_MS = 5_000;

let root: ReturnType<typeof tempRoot>;
let repos: Repos;
let provider: ScriptedProvider;
let looky: LookyProcess;
let browser: Browser;
const pages: Opened[] = [];
const holds: Hold[] = [];

async function signIn(page: Page, token = WEB_TOKEN): Promise<void> {
  await page.getByRole("heading", { name: "Sign in to Looky" }).waitFor();
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Sign in" }).click();
}

async function signedIn(path = "/", viewport?: { width: number; height: number }): Promise<Opened> {
  const opened = await open(browser, `${looky.url}${path}`, viewport ? { viewport } : {});
  pages.push(opened);
  await signIn(opened.page);
  await waitIndexReady(opened.page);
  return opened;
}

function hold(marker: string): Hold {
  const held = provider.hold(marker);
  holds.push(held);
  return held;
}

beforeAll(async () => {
  root = tempRoot("looky-e2e-access-");
  repos = createRepos(root.path);
  provider = new ScriptedProvider();
  const assets = await buildApp(join(root.path, "web"));
  looky = await LookyProcess.start(
    serviceEnv({
      repos,
      provider,
      assetsDir: assets,
      dataDir: join(root.path, "data"),
      extra: {
        LOOKY_BROWSER_AUTH: "token",
        LOOKY_MAX_CONCURRENT_ASKS: "1",
        LOOKY_MAX_QUEUED_ASKS: "0",
        LOOKY_ADMISSION_WAIT_MS: "0",
        LOOKY_FAST_MAX_ELAPSED_MS: String(FAST_LIMIT_MS),
        LOOKY_FAST_RESEARCH_MAX_ELAPSED_MS: "4000",
      },
    }),
  );
  browser = await launchBrowser();
}, 120_000);

afterEach(async () => {
  for (const held of holds.splice(0)) held.release();
  for (const opened of pages.splice(0)) await opened.context.close();
});

afterAll(async () => {
  await browser?.close();
  await looky?.stop();
  await provider?.stop();
  root?.cleanup();
});

describe("sign-in and access", () => {
  test("only the browser client's token signs in, and nothing is kept in page storage", async () => {
    const opened = await open(browser, looky.url);
    pages.push(opened);
    const { page, context } = opened;
    await signIn(page, "not-the-token-0123456789abcdef0123456789");
    await page.getByRole("alert").filter({ hasText: "Sign-in failed" }).waitFor();
    // An agent adapter's token is not a browser credential.
    await signIn(page, PAWS_TOKEN);
    await page.getByRole("alert").filter({ hasText: "Sign-in failed" }).waitFor();
    await signIn(page, WEB_TOKEN);
    await waitPinned(page, repos.pilotSha);

    const cookies = await context.cookies();
    expect(cookies).toHaveLength(1);
    expect(cookies[0]).toMatchObject({ name: "looky_browser", httpOnly: true, sameSite: "Strict" });
    expect(cookies[0]!.value).not.toContain(WEB_TOKEN);
    const storage = await page.evaluate(() => [localStorage.length, sessionStorage.length]);
    expect(storage).toEqual([0, 0]);
    expect(await page.content()).not.toContain(WEB_TOKEN);

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.getByRole("heading", { name: "Sign in to Looky" }).waitFor();
    expect((await pageFetch(page, "/browser/v1/repositories")).status).toBe(401);
  }, 60_000);

  test("only authorized repositories are offered; others, paths and forged requests are refused", async () => {
    const { page } = await signedIn("/?repo=vault&ref=HEAD");
    // A repository outside the browser client's list is ignored in the URL and never listed.
    await waitPinned(page, repos.pilotSha);
    const options = await page.getByLabel("Repository").locator("option").allInnerTexts();
    expect(options).toEqual(["pilot", "notes"]);

    const select = (body: unknown, csrf = true) =>
      pageFetch(page, "/browser/v1/revisions", { method: "POST", body, csrf });
    const vault = await select({ repositoryId: "vault", ref: "HEAD" });
    expect(vault).toMatchObject({
      status: 403,
      body: { error: { code: "repository_not_permitted" } },
    });
    expect((await select({ repositoryId: repos.vault, ref: "HEAD" })).status).toBe(403);
    expect((await select({ repositoryId: "../vault", ref: "HEAD" })).status).toBe(403);
    expect((await pageFetch(page, "/browser/v1/repositories/vault/refs")).status).toBe(403);
    const extra = await select({ repositoryId: "pilot", ref: "HEAD", path: "/etc" });
    expect(extra).toMatchObject({ status: 400, body: { error: { code: "invalid_request" } } });
    const forged = await select({ repositoryId: "pilot", ref: "HEAD" }, false);
    expect(forged).toMatchObject({ status: 403, body: { error: { code: "csrf_failed" } } });
    // Nothing of the vault repository was ever indexed for anyone.
    const vaultHead = Bun.spawnSync(["git", "-C", repos.vault, "rev-parse", "HEAD"]);
    expect((await looky.index("vault", vaultHead.stdout.toString().trim())).state).toBe(
      "not_indexed",
    );
  }, 60_000);

  test("invalid and unknown revisions are refused with a visible reason", async () => {
    const opened = await open(browser, `${looky.url}/?repo=pilot&ref=main~1`);
    pages.push(opened);
    const { page } = opened;
    await signIn(page);
    await page.getByText("ref must be a branch, tag, HEAD or full SHA").waitFor();
    expect(await page.getByRole("button", { name: "Ask in Fast" }).isDisabled()).toBe(true);

    const sha = page.getByLabel("Or a commit SHA");
    await sha.fill("abc123");
    await page.getByRole("button", { name: "Use" }).click();
    await page.getByText("Enter a full commit SHA: 40 or 64 hexadecimal characters.").waitFor();
    await sha.fill("0123456789abcdef0123456789abcdef01234567");
    await page.getByRole("button", { name: "Use" }).click();
    await page.getByText("No such committed revision in this repository").waitFor();
    expect(await page.getByRole("button", { name: "Ask in Fast" }).isDisabled()).toBe(true);

    // A full SHA that exists is pinned exactly.
    await sha.fill(repos.featureSha);
    await page.getByRole("button", { name: "Use" }).click();
    await waitPinned(page, repos.featureSha);
  }, 60_000);
});

describe("failure outcomes", () => {
  test("an unavailable provider is shown without its error text, and Retry answers once it recovers", async () => {
    const question = "How does loadCheckpoint work? (provider down)";
    let down = true;
    provider.script("(provider down)", (call) =>
      down && call.kind === "answer"
        ? {
            status: 503,
            body: { error: { type: "upstream_overloaded", message: "trace at /srv/model/secret" } },
          }
        : groundedAnswer(call),
    );
    const { page, traffic } = await signedIn();
    await ask(page, question, "fast");
    await statusTitle(page, "Looky is busy");
    const detail = await page.locator(".status-detail").innerText();
    expect(detail).toContain("Looky cannot answer right now.");
    const seen = traffic.bodies.join("\n") + (await page.content());
    for (const leaked of ["upstream_overloaded", "/srv/model/secret", "HTTP 503", "scripted"]) {
      expect(seen).not.toContain(leaked);
    }
    expect(provider.callsFor("(provider down)", "answer").length).toBeGreaterThanOrEqual(1);

    down = false;
    const retry = page.getByRole("button", { name: "Retry" });
    await retry.waitFor();
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent === "Retry" && !button.disabled,
        ),
      undefined,
      { timeout: 10_000 },
    );
    await retry.click();
    await answer(page, "fast");
    expect(traffic.submissions.filter((item) => item.question === question)).toHaveLength(2);
  }, 60_000);

  test("a second question while the only slot is taken is busy, and Retry runs it once after", async () => {
    const holder = "Walk through checkpoint replay end to end (busy holder)";
    const other = "Where is RETRY_POLICY defined? (busy other)";
    const held = hold("(busy holder)");
    const a = await signedIn();
    const b = await signedIn();
    await ask(a.page, holder, "deep");
    await held.started;

    await ask(b.page, other, "fast");
    await statusTitle(b.page, "Looky is busy");
    expect(await b.page.locator(".status-detail").innerText()).toContain(
      "Looky is answering other questions.",
    );
    // Retry waits for Looky's retryAfterMs, and the busy question did no research.
    expect(await b.page.getByRole("button", { name: "Retry" }).isDisabled()).toBe(true);
    expect(provider.callsFor("(busy other)")).toHaveLength(0);

    held.release();
    await answer(a.page, "deep");
    await b.page.waitForFunction(
      () =>
        [...document.querySelectorAll("button")].some(
          (button) => button.textContent === "Retry" && !button.disabled,
        ),
      undefined,
      { timeout: 10_000 },
    );
    await b.page.getByRole("button", { name: "Retry" }).click();
    await answer(b.page, "fast");
    expect(provider.callsFor("(busy other)", "answer")).toHaveLength(1);
    expect(provider.callsFor("(busy holder)", "answer")).toHaveLength(1);
  }, 60_000);

  test("a question that exceeds the Fast time limit times out and never becomes Deep by itself", async () => {
    const question = "How does replayFromCheckpoint bound attempts? (timeout)";
    const held = hold("(timeout)");
    const { page, traffic } = await signedIn();
    await ask(page, question, "fast");
    const call = await held.started;
    await statusTitle(page, "Timed out");
    expect(await page.locator(".status-detail").innerText()).toContain(
      `Looky stopped after its ${FAST_LIMIT_MS / 1000} s limit for Fast.`,
    );
    await provider.waitFor(() => call.status === "aborted");
    await page.getByRole("button", { name: "Ask again" }).waitFor();
    await page.getByRole("button", { name: "Ask in Deep" }).waitFor();
    await page.waitForTimeout(1_500);
    expect(traffic.submissions.map((item) => item.mode)).toEqual(["fast"]);
    expect(await page.getByRole("radio", { name: /^Fast/ }).isChecked()).toBe(true);
  }, 60_000);

  test("Fast without evidence says so and offers Deep only as a button", async () => {
    const question = "How does the zyxwvut quasar flux capacitor calibrate?";
    const { page, traffic } = await signedIn();
    await ask(page, question, "fast");
    const article = await answer(page, "fast");
    expect(await article.locator(".outcome").innerText()).toContain("Not established.");
    await article.getByText("Deep may establish more").waitFor();
    // No synthesis call is made without evidence, and nothing moved to Deep.
    expect(provider.callsFor("zyxwvut")).toHaveLength(0);
    await page.waitForTimeout(1_000);
    expect(traffic.submissions.map((item) => item.mode)).toEqual(["fast"]);

    await article.getByRole("button", { name: "Ask in Deep" }).click();
    await answer(page, "deep");
    expect(traffic.submissions.map((item) => item.mode)).toEqual(["fast", "deep"]);
  }, 60_000);
});

describe("keyboard and small screens", () => {
  test("the whole flow works from the keyboard", async () => {
    const question = "How does onWorkerExit hand a crash to recovery? (keyboard)";
    const { page, traffic } = await signedIn();
    // Start from a fresh load, as a returning keyboard user does; the session cookie persists.
    await page.reload();
    await waitIndexReady(page);
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
      "Skip to the question",
    );
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("question");
    await page.keyboard.type(question);
    // Tab to the mode radios and choose Deep with an arrow key.
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => (document.activeElement as HTMLInputElement).value)).toBe(
      "fast",
    );
    await page.keyboard.press("ArrowDown");
    expect(await page.getByRole("radio", { name: /^Deep/ }).isChecked()).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Control+Enter");
    await answer(page, "deep");
    await waitFocused(page, "answer-title");
    expect(traffic.submissions.map((item) => item.mode)).toEqual(["deep"]);
    // Source links are reachable with Tab from the answer.
    let reached = false;
    for (let step = 0; step < 30 && !reached; step += 1) {
      await page.keyboard.press("Tab");
      reached = await page.evaluate(
        () => document.activeElement?.classList.contains("source-link") ?? false,
      );
    }
    expect(reached).toBe(true);
    // The live region announced the outcome.
    expect(await page.locator('[role="status"]').innerText()).toContain("Deep answer");
  }, 60_000);

  test("the skip link moves focus without dropping the answer or the selection", async () => {
    const question = "How does saveCheckpoint store a checkpoint? (skip link)";
    const { page } = await signedIn();
    await ask(page, question, "fast");
    await answer(page, "fast");
    let selections = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/browser/v1/revisions")) {
        selections += 1;
      }
    });
    await page.locator(".skip-link").focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("question");
    expect(new URL(page.url()).hash).toBe("#question");
    // A fragment link fires popstate; the app must not treat it as a new selection.
    await page.waitForTimeout(500);
    expect(selections).toBe(0);
    expect(await page.locator("article.answer").count()).toBe(1);
    expect(await page.getByRole("button", { name: "Ask in Fast" }).isDisabled()).toBe(false);
  }, 60_000);

  test("a 320 px wide phone shows every control and a long answer without page overflow", async () => {
    const question = "Explain checkpoint recovery with an example (narrow screen)";
    provider.script("(narrow screen)", (call) =>
      call.kind === "answer"
        ? {
            json: {
              outcome: "supported",
              answer: [
                `Recovery loads the newest checkpoint for the run ${cite(call, "src/recovery/recover-run.ts")}.`,
                "A very long identifier such as resumeInterruptedRunFromTheNewestCheckpointWithoutGuessingAnything stays readable.",
                "```ts\nconst state = await resumeInterruptedRun(runId); // a deliberately long line that is wider than a phone screen\n```",
                "The example above shows the call a supervisor makes after a crash.",
              ].join("\n\n"),
              rationale: "not_asked",
            },
          }
        : { json: { verdict: "ok" } },
    );
    const { page } = await signedIn("/", { width: 320, height: 640 });
    await ask(page, question, "fast");
    const article = await answer(page, "fast");

    const layout = await page.evaluate(() => ({
      page: document.documentElement.scrollWidth,
      viewport: document.documentElement.clientWidth,
      pre: (() => {
        const pre = document.querySelector(".prose pre") as HTMLElement;
        return { scroll: pre.scrollWidth, client: pre.clientWidth, tabIndex: pre.tabIndex };
      })(),
    }));
    expect(layout.viewport).toBe(320);
    expect(layout.page).toBeLessThanOrEqual(320);
    // The wide code scrolls inside its own focusable box, not the page.
    expect(layout.pre.scroll).toBeGreaterThan(layout.pre.client);
    expect(layout.pre.tabIndex).toBe(0);
    for (const control of [
      page.getByLabel("Repository"),
      page.getByLabel("Revision"),
      page.getByLabel("Your question about the code"),
      page.getByRole("radio", { name: /^Deep/ }),
      page.getByRole("button", { name: "Ask in Fast" }),
      article.locator("ol.sources a").first(),
    ]) {
      const box = (await control.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(320.5);
    }
  }, 60_000);
});
