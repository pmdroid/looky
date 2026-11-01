/**
 * Driving the built React app in Chromium through its labelled controls, the
 * way a person uses it, and recording what crossed the browser boundary.
 */
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";

export type { Browser, BrowserContext, Page };

export const WAIT_MS = 30_000;

/** Headless Chromium from Playwright's browser cache (`bun run e2e:install`). */
export function launchBrowser(): Promise<Browser> {
  return chromium.launch({ headless: true });
}

export interface QuestionView {
  readonly id: string;
  readonly clientRequestId: string;
  readonly revisionId: string;
  readonly sha: string;
  readonly mode: "fast" | "deep";
  readonly state: "running" | "completed";
  readonly response?: {
    readonly status: string;
    readonly requestId: string;
    readonly revision?: { readonly repositoryId: string; readonly sha: string };
    readonly index?: { readonly sha: string; readonly generationId: string };
    readonly evidence?: readonly { path: string; startLine: number; endLine: number }[];
    readonly answer?: { readonly text: string; readonly outcome: string };
    readonly mode: { readonly requested: string; readonly executed: string | null };
    readonly [key: string]: unknown;
  };
  readonly sourceLinks?: readonly (string | null)[];
}

/** Browser API traffic of one page, kept for assertions. */
export class Traffic {
  readonly submissions: { clientRequestId: string; question: string; mode: string }[] = [];
  readonly cancels: string[] = [];
  readonly views: QuestionView[] = [];
  /** Every browser API response body the page received. */
  readonly bodies: string[] = [];
  /** Every page error or console error, which a test expects to stay empty. */
  readonly errors: string[] = [];
  /** Dialogs (alert, confirm) opened by the page; injected script would open one. */
  readonly dialogs: string[] = [];

  constructor(page: Page) {
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.pathname === "/browser/v1/questions") {
        this.submissions.push(JSON.parse(request.postData() ?? "{}"));
      }
      const cancel = /^\/browser\/v1\/questions\/([^/]+)\/cancel$/.exec(url.pathname);
      if (request.method() === "POST" && cancel) this.cancels.push(cancel[1]!);
    });
    page.on("response", (response) => {
      const url = new URL(response.url());
      if (!url.pathname.startsWith("/browser/v1/")) return;
      void response
        .text()
        .then((text) => {
          this.bodies.push(text);
          if (url.pathname.startsWith("/browser/v1/questions") && response.ok()) {
            this.views.push(JSON.parse(text) as QuestionView);
          }
        })
        .catch(() => undefined);
    });
    page.on("pageerror", (error) => this.errors.push(error.message));
    page.on("dialog", (dialog) => {
      this.dialogs.push(dialog.message());
      void dialog.dismiss();
    });
  }

  /**
   * The last completed view for a question (at `sha`, when given), as the page
   * received it. Response bodies are read asynchronously, so this waits briefly.
   */
  async completed(question: string, sha?: string): Promise<QuestionView | undefined> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const ids = new Set(
        this.submissions.filter((item) => item.question === question).map((s) => s.clientRequestId),
      );
      const view = this.views.findLast(
        (item) =>
          item.state === "completed" &&
          ids.has(item.clientRequestId) &&
          (sha === undefined || item.sha === sha),
      );
      if (view || Date.now() > deadline) return view;
      await Bun.sleep(25);
    }
  }
}

export interface Opened {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly traffic: Traffic;
}

/** A new browser context, which is a separate cookie jar and so a separate browser session. */
export async function open(
  browser: Browser,
  url: string,
  options: { readonly viewport?: { width: number; height: number } } = {},
): Promise<Opened> {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1280, height: 900 },
    ...(options.viewport && options.viewport.width < 500 ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await context.newPage();
  const traffic = new Traffic(page);
  page.setDefaultTimeout(WAIT_MS);
  await page.goto(url);
  return { context, page, traffic };
}

/** The full SHA the page pinned, once it shows one. */
export async function pinnedSha(page: Page): Promise<string> {
  const sha = page.locator(".selection-line code.sha");
  await sha.waitFor();
  return (await sha.getAttribute("title")) ?? "";
}

/** Wait until the page shows `sha` as pinned. */
export async function waitPinned(page: Page, sha: string): Promise<void> {
  await page.locator(`.selection-line code.sha[title="${sha}"]`).waitFor();
}

export async function waitIndexReady(page: Page): Promise<void> {
  await page.getByText("Index ready for this commit.").waitFor();
}

export async function chooseMode(page: Page, mode: "fast" | "deep"): Promise<void> {
  await page.getByRole("radio", { name: mode === "fast" ? /^Fast/ : /^Deep/ }).check();
}

/** Type a question and press the Ask button. */
export async function ask(page: Page, question: string, mode: "fast" | "deep" = "fast") {
  await chooseMode(page, mode);
  await page.getByLabel("Your question about the code").fill(question);
  await page.getByRole("button", { name: `Ask in ${mode === "fast" ? "Fast" : "Deep"}` }).click();
}

/** The answer article once it is shown. */
export async function answer(page: Page, mode: "fast" | "deep" = "fast") {
  const article = page.locator("article.answer");
  await page
    .getByRole("heading", { name: `${mode === "fast" ? "Fast" : "Deep"} answer` })
    .waitFor();
  return article;
}

/** The status heading text, such as "Cancelled" or "Looky is busy". */
export async function statusTitle(page: Page, title: string | RegExp): Promise<void> {
  await page.locator(".status-title", { hasText: title }).waitFor();
}

/** Source references listed under the answer, as `path:start–end` labels. */
export async function sourceLabels(page: Page): Promise<string[]> {
  return page
    .locator("ol.sources > li")
    .evaluateAll((items) =>
      items.map((item) =>
        (item.querySelector(".source-link, .source-path")?.textContent ?? "").trim(),
      ),
    );
}

/** Same as the app's range label: `12` or `12–18`. */
export function rangeLabel(ref: { path: string; startLine: number; endLine: number }): string {
  return `${ref.path}:${ref.startLine === ref.endLine ? ref.startLine : `${ref.startLine}–${ref.endLine}`}`;
}

/** Wait a while and check that no answer appeared, for results that must never show. */
export async function staysWithoutAnswer(page: Page, ms = 1_500): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if ((await page.locator("article.answer").count()) > 0) {
      throw new Error("An answer appeared that must not be shown");
    }
    await page.waitForTimeout(100);
  }
}

/** Call the browser API from the page itself, with its cookie and CSRF rules. */
export async function pageFetch(
  page: Page,
  path: string,
  init: { method?: string; body?: unknown; csrf?: boolean } = {},
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ path, init }) => {
      const headers: Record<string, string> = { accept: "application/json" };
      if (init.csrf) {
        const session = await (await fetch("/browser/v1/session")).json();
        headers["x-looky-csrf"] = session.csrfToken;
      }
      if (init.body !== undefined) headers["content-type"] = "application/json";
      const response = await fetch(path, {
        method: init.method ?? "GET",
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
      const text = await response.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Not JSON; keep the text.
      }
      return { status: response.status, body };
    },
    { path, init },
  );
}
