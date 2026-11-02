import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  answer,
  chooseMode,
  launchBrowser,
  open,
  pinnedSha,
  sourceLabels,
  staysWithoutAnswer,
  statusTitle,
} from "../../../../e2e/support/app";

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    looky: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    repo: { type: "string" },
    data: { type: "string" },
    proxy: { type: "string", default: "http://127.0.0.1:7399" },
    proxyLog: { type: "string" },
    out: { type: "string" },
  },
});

const LOOKY = resolve(args.looky!);
const out = resolve(args.out!);
mkdirSync(out, { recursive: true });
const repo = resolve(args.repo!);
const questions = JSON.parse(readFileSync(join(LOOKY, "pilot/questions.json"), "utf8"))
  .questions as {
  id: string;
  question: string;
}[];
const byId = (id: string) => questions.find((q) => q.id === id)!.question;
const LINK = "https://github.com/pmdroid/paws-app/blob/{sha}/{path}#L{startLine}-L{endLine}";

const proc = Bun.spawn(["bun", "run", "src/cli.ts", "serve"], {
  cwd: LOOKY,
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    LOOKY_DATA_DIR: resolve(args.data!),
    LOOKY_HOST: "127.0.0.1",
    LOOKY_PORT: "0",
    LOOKY_REPOSITORIES: "paws-app",
    LOOKY_REPOSITORY_PAWS_APP_PATH: repo,
    LOOKY_CLIENTS: "web",
    LOOKY_CLIENT_WEB_TOKEN: randomBytes(24).toString("hex"),
    LOOKY_CLIENT_WEB_REPOSITORIES: "paws-app",
    LOOKY_BROWSER_CLIENT: "web",
    LOOKY_BROWSER_ASSETS_DIR: join(LOOKY, "dist/web"),
    LOOKY_SOURCE_LINK_TEMPLATE: LINK,
    LOOKY_PROVIDER: "ocgo",
    LOOKY_PROVIDER_OCGO_KIND: "openai",
    LOOKY_PROVIDER_OCGO_MODEL: args.model!,
    LOOKY_PROVIDER_OCGO_BASE_URL: `${args.proxy}/openai/v1`,
    ...(args.effort ? { LOOKY_PROVIDER_OCGO_REASONING_EFFORT: args.effort } : {}),
  },
  stdout: "ignore",
  stderr: "pipe",
});
let captured = "";
const listening = Promise.withResolvers<string>();
void (async () => {
  for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
    captured += new TextDecoder().decode(chunk);
    const m = /listening on (http:\/\/\S+?);/.exec(captured);
    if (m) listening.resolve(m[1]!);
  }
  listening.reject(new Error(`service exited: ${captured.trim().slice(-500)}`));
})();
const url = await listening.promise;

function proxyCalls(tag: string): any[] {
  return readFileSync(args.proxyLog!, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.run === tag);
}
async function setTag(tag: string) {
  await fetch(`${args.proxy}/_bench/tag`, {
    method: "POST",
    body: JSON.stringify({ run: tag, q: "-", mode: "-" }),
  });
}

function checkLink(href: string, pinned: string): string | null {
  const m = /blob\/([0-9a-f]{40})\/(.+)#L(\d+)-L(\d+)$/.exec(href);
  if (!m) return `unparseable link ${href}`;
  const [, sha, path, start, end] = m;
  if (sha !== pinned) return `${href} not at pinned sha`;
  const blob = Bun.spawnSync(["git", "-C", repo, "cat-file", "blob", `${sha}:${path}`]);
  if (blob.exitCode !== 0) return `${path} missing at ${sha}`;
  const n = blob.stdout.toString().replace(/\n$/, "").split("\n").length;
  if (Number(start) < 1 || Number(end) > n || Number(end) < Number(start))
    return `${href} outside ${n} lines`;
  return null;
}

async function ask(page: any, question: string, mode: "fast" | "deep") {
  await chooseMode(page, mode);
  await page.getByLabel("Your question about the code").fill(question);
  await page
    .locator("form")
    .getByRole("button", { name: `Ask in ${mode === "fast" ? "Fast" : "Deep"}` })
    .click();
}

const browser = await launchBrowser();
const result: any = {
  model: args.model,
  effort: args.effort ?? null,
  url: "127.0.0.1 (local auth)",
  steps: [],
};
try {
  const { page, traffic } = await open(browser, url);
  page.setDefaultTimeout(240_000);
  const pinned = await pinnedSha(page);
  const head = Bun.spawnSync(["git", "-C", repo, "rev-parse", "HEAD"]).stdout.toString().trim();
  result.pinned = pinned;
  result.pinnedEqualsHead = pinned === head;
  const indexStarted = performance.now();
  await page.getByText("Index ready for this commit.").waitFor();
  result.indexReadyMs = Math.round(performance.now() - indexStarted);
  await page.screenshot({ path: join(out, "01-ready.png"), fullPage: true });

  const cases: [string, string, "fast" | "deep"][] = [
    ["fast-q01", "q01", "fast"],
    ["deep-q01", "q01", "deep"],
    ["fast-q09-rationale", "q09", "fast"],
  ];
  for (const [name, qid, mode] of cases) {
    const tag = `ui-${name}`;
    await setTag(tag);
    const started = performance.now();
    await ask(page, byId(qid), mode);
    const article = await answer(page, mode);
    const ms = Math.round(performance.now() - started);
    await page.waitForTimeout(500);
    const text = await article.innerText();
    const hrefs = await page
      .locator("ol.sources a.source-link")
      .evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).href));
    const labels = await sourceLabels(page);
    const linkProblems = hrefs
      .slice(0, 3)
      .map((h) => checkLink(h, pinned))
      .filter(Boolean);
    const view = await traffic.completed(byId(qid));
    await page.screenshot({ path: join(out, `${name}.png`), fullPage: true });
    result.steps.push({
      name,
      q: qid,
      mode,
      browserMs: ms,
      status: view?.response?.status,
      outcome: view?.response?.answer?.outcome,
      usage: view?.response?.usage,
      linksChecked: Math.min(3, hrefs.length),
      linkCount: hrefs.length,
      linkProblems,
      sampleLinks: hrefs.slice(0, 3),
      sourceLabels: labels,
      articleText: text,
      proxyCalls: proxyCalls(tag).map((c) => ({
        kind: c.kind,
        status: c.status,
        ms: c.ms,
        inputTokens: c.inputTokens,
        outputTokens: c.outputTokens,
        estUsd: c.estUsd,
      })),
    });
    console.error(
      `[ui] ${name}: ${view?.response?.status}/${view?.response?.answer?.outcome} in ${ms} ms, ${hrefs.length} links, problems ${linkProblems.length}`,
    );
  }

  await setTag("ui-cancel-deep");
  await ask(page, byId("q04"), "deep");
  await page.waitForTimeout(3_000);
  await page.getByRole("button", { name: "Cancel" }).click();
  await statusTitle(page, "Cancelled");
  await staysWithoutAnswer(page, 15_000);
  await page.screenshot({ path: join(out, "cancelled.png"), fullPage: true });
  result.cancel = {
    cancelled: true,
    answerShownWithin15s: false,
    proxyCalls: proxyCalls("ui-cancel-deep").length,
  };
  console.error(`[ui] cancel: cancelled, no answer shown in 15 s`);
  result.pageErrors = traffic.errors;
  result.dialogs = traffic.dialogs;
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  console.error(`[ui] error: ${result.error}`);
} finally {
  await browser.close();
  proc.kill("SIGTERM");
  await proc.exited;
  writeFileSync(join(out, "ui.json"), JSON.stringify(result, null, 2));
}
