/**
 * Indexed Fast and Deep answers through the production browser app.
 *
 * One real Looky service (`serve` in a child process) indexes temporary Git
 * repositories into a persistent SQLite data directory and serves the built
 * app. Only the model's replies are scripted, behind Looky's real HTTP
 * provider client. Tests run in order and share the service, as one person's
 * day with Looky would: first index, both modes, restart, new commit.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { refreshPilotRepo } from "../test/support/pilot-fixture";
import {
  answer,
  ask,
  launchBrowser,
  open,
  pinnedSha,
  rangeLabel,
  sourceLabels,
  statusTitle,
  waitIndexReady,
  waitPinned,
  type Browser,
  type Opened,
} from "./support/app";
import {
  buildApp,
  LINK_TEMPLATE,
  LookyProcess,
  PAWS_TOKEN,
  serviceEnv,
  tempRoot,
  type Env,
  WEB_TOKEN,
} from "./support/looky";
import { cite, PROVIDER_API_KEY, ScriptedProvider, type ProviderCall } from "./support/provider";
import { createRepos, UNICODE_DOC, type Repos } from "./support/repos";

const RECOVERY = "How does resumeInterruptedRun recover a crashed run?";
const DEEP = "Walk through crash recovery from the worker exit to the replay";
const UNICODE = "Was sagt der Überblick zur Wiederherstellung? 復旧 الاستعادة";
const HOSTILE = "How is the invoice total computed by computeInvoiceTotal?";

let root: ReturnType<typeof tempRoot>;
let repos: Repos;
let provider: ScriptedProvider;
let looky: LookyProcess;
let env: Env;
let browser: Browser;
const pages: Opened[] = [];

function sourceLink(sha: string, ref: { path: string; startLine: number; endLine: number }) {
  return LINK_TEMPLATE.replace("{repositoryId}", "pilot")
    .replace("{sha}", sha)
    .replace("{path}", ref.path)
    .replace("{startLine}", String(ref.startLine))
    .replace("{endLine}", String(ref.endLine));
}

/** A recovery explanation that cites every recovery file the model was shown. */
function recoveryAnswer(call: ProviderCall) {
  const recovery =
    cite(call, "src/recovery/recover-run.ts") || cite(call, "src/recovery/resume.ts");
  const parts = [
    `When a run crashes, recovery loads the newest saved checkpoint for it ${recovery}.`,
    cite(call, "src/storage/checkpoints.ts") &&
      `Checkpoints are kept per run and the newest one is returned ${cite(call, "src/storage/checkpoints.ts")}.`,
    cite(call, "src/config/retry.ts") &&
      `Replays are limited by the retry policy ${cite(call, "src/config/retry.ts")}.`,
    cite(call, "src/worker/supervisor.ts") &&
      `The supervisor hands a crashed worker's run to recovery ${cite(call, "src/worker/supervisor.ts")}.`,
    "Without a checkpoint, recovery fails with MissingCheckpointError instead of guessing.",
  ];
  return {
    json: {
      outcome: "supported",
      answer: parts.filter(Boolean).join(" "),
      caveats: ["Only committed source at this revision was read."],
      rationale: "not_asked",
    },
  };
}

function open1(url = looky.url, viewport?: { width: number; height: number }) {
  return open(browser, url, viewport ? { viewport } : {}).then((opened) => {
    pages.push(opened);
    return opened;
  });
}

async function closePages() {
  for (const opened of pages.splice(0)) await opened.context.close();
}

beforeAll(async () => {
  root = tempRoot("looky-e2e-answers-");
  // Large enough that the first build is still running when the page asks.
  repos = createRepos(root.path, { corpusFiles: 6_000 });
  provider = new ScriptedProvider();
  provider.script(RECOVERY, (call) =>
    call.kind === "answer" ? recoveryAnswer(call) : { json: { verdict: "ok" } },
  );
  const assets = await buildApp(join(root.path, "web"));
  env = serviceEnv({
    repos,
    provider,
    assetsDir: assets,
    dataDir: join(root.path, "data"),
    extra: { LOOKY_INDEX_MAX_FILES: "20000" },
  });
  looky = await LookyProcess.start(env);
  browser = await launchBrowser();
}, 120_000);

afterAll(async () => {
  await closePages();
  await browser?.close();
  await looky?.stop();
  await provider?.stop();
  root?.cleanup();
});

describe("indexed answers in the browser", () => {
  test("the first question waits for initial indexing, then gets a grounded Fast answer", async () => {
    expect((await looky.index("pilot", repos.pilotSha)).state).toBe("not_indexed");
    const { page, traffic } = await open1();
    await waitPinned(page, repos.pilotSha);
    // Asked at once: the index for this new commit is still being built.
    await ask(page, RECOVERY, "fast");
    await statusTitle(page, "Waiting for the index");
    const article = await answer(page, "fast");

    // The page asked once, got `indexing` (no research), and asked again once ready.
    expect(traffic.submissions.filter((item) => item.question === RECOVERY)).toHaveLength(2);
    expect(provider.callsFor(RECOVERY, "answer")).toHaveLength(1);
    expect(provider.calls.every((call) => call.authorized)).toBe(true);

    const view = (await traffic.completed(RECOVERY))!;
    const response = view.response!;
    expect(response.status).toBe("answered");
    expect(response.revision!.sha).toBe(repos.pilotSha);
    expect(response.index!.sha).toBe(repos.pilotSha);
    expect(response.mode).toEqual({ requested: "fast", executed: "fast" });
    const ready = await looky.ready("pilot", repos.pilotSha);
    expect(response.index!.generationId).toBe(ready.ready!.buildId);
    expect((await looky.build(ready.ready!.buildId)).refresh?.mode).toBe("full");

    // The page shows the answer Looky delivered, its SHA and its exact sources.
    await expect(article.locator(".prose").innerText()).resolves.toContain(
      "recovery loads the newest saved checkpoint",
    );
    await expect(article.locator(".outcome").innerText()).resolves.toContain("Supported.");
    await expect(article.locator(".sha-full").innerText()).resolves.toBe(repos.pilotSha);
    expect(await article.locator("dd", { hasText: "Fast requested" }).innerText()).toBe(
      "Fast requested, Fast ran",
    );
    const evidence = response.evidence!;
    const paths = new Set(evidence.map((ref) => ref.path));
    expect(paths.has("src/recovery/recover-run.ts")).toBe(true);
    expect(paths.size).toBeGreaterThanOrEqual(2);
    expect(await sourceLabels(page)).toEqual(evidence.map(rangeLabel));
    const hrefs = await article
      .locator("ol.sources a.source-link")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
    expect(hrefs).toEqual(evidence.map((ref) => sourceLink(repos.pilotSha, ref)));
    // Focus moves to the answer, so it is read out and reachable.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("answer-title");
    expect(traffic.errors).toEqual([]);
  }, 90_000);

  test("Deep follows the flow across files with more research than Fast", async () => {
    provider.script(DEEP, (call) => {
      if (call.kind === "plan") {
        return {
          json: {
            followUps: [
              { query: "onWorkerExit crashed worker", definitionOf: "onWorkerExit" },
              { query: "loadCheckpoint newest checkpoint", definitionOf: "loadCheckpoint" },
            ],
            done: true,
          },
        };
      }
      if (call.kind === "check") return { json: { verdict: "ok" } };
      return {
        json: {
          outcome: "supported",
          answer: [
            `A worker that exits with a non-zero code is treated as crashed and its run goes to recovery ${cite(call, "src/worker/supervisor.ts")}.`,
            `Recovery then loads the newest checkpoint and replays from it ${cite(call, "src/recovery/recover-run.ts")}.`,
            `The checkpoint store returns the newest checkpoint per run ${cite(call, "src/storage/checkpoints.ts")}.`,
            `How often a run is replayed comes from the retry policy ${cite(call, "src/config/retry.ts")}.`,
          ].join("\n\n"),
          rationale: "not_asked",
        },
      };
    });
    const { page, traffic } = await open1();
    await waitIndexReady(page);
    await ask(page, DEEP, "deep");
    const article = await answer(page, "deep");

    const response = (await traffic.completed(DEEP))!.response!;
    expect(response.mode).toEqual({ requested: "deep", executed: "deep" });
    expect(response.revision!.sha).toBe(repos.pilotSha);
    const files = new Set(response.evidence!.map((ref) => ref.path));
    for (const path of [
      "src/worker/supervisor.ts",
      "src/recovery/recover-run.ts",
      "src/storage/checkpoints.ts",
    ]) {
      expect(files.has(path)).toBe(true);
    }
    // Deep planned follow-ups and cross-checked its draft; Fast made one call.
    const kinds = provider.callsFor(DEEP).map((call) => call.kind);
    expect(kinds).toContain("plan");
    expect(kinds).toContain("answer");
    expect(kinds).toContain("check");
    expect(provider.callsFor(RECOVERY)).toHaveLength(1);
    // Four paragraphs of explanation, each tied to a cited source.
    expect(await article.locator(".prose p").count()).toBe(4);
    expect(await article.locator(".prose p a[href]").count()).toBeGreaterThanOrEqual(3);
    expect(await article.locator("dd", { hasText: "Deep requested" }).innerText()).toBe(
      "Deep requested, Deep ran",
    );
    expect(await sourceLabels(page)).toEqual(response.evidence!.map(rangeLabel));
  }, 60_000);

  test("Unicode and right-to-left text render as written", async () => {
    provider.script(UNICODE, (call) =>
      call.kind === "answer"
        ? {
            json: {
              outcome: "supported",
              answer: [
                `Der Überblick sagt: Die Wiederherstellung lädt den neuesten Checkpoint ${cite(call, UNICODE_DOC)}.`,
                "日本語では、復旧は最新のチェックポイントから再開すると書かれています。",
                "تقول الوثيقة إن الاستعادة تبدأ من آخر نقطة حفظ.",
                "Emoji and symbols stay intact: 🚀 ✓ — “quoted” ½.",
              ].join("\n\n"),
              rationale: "not_asked",
            },
          }
        : { json: { verdict: "ok" } },
    );
    const { page, traffic } = await open1();
    await waitIndexReady(page);
    await ask(page, UNICODE, "fast");
    const article = await answer(page, "fast");

    const response = (await traffic.completed(UNICODE))!.response!;
    expect(response.evidence!.some((ref) => ref.path === UNICODE_DOC)).toBe(true);
    const paragraphs = await article.locator(".prose p").allInnerTexts();
    expect(paragraphs[0]).toStartWith("Der Überblick sagt: Die Wiederherstellung lädt");
    expect(paragraphs[1]).toBe(
      "日本語では、復旧は最新のチェックポイントから再開すると書かれています。",
    );
    expect(paragraphs[2]).toBe("تقول الوثيقة إن الاستعادة تبدأ من آخر نقطة حفظ.");
    expect(paragraphs[3]).toBe("Emoji and symbols stay intact: 🚀 ✓ — “quoted” ½.");
    // `dir="auto"` lets the Arabic paragraph run right to left and the others left to right.
    const directions = await article
      .locator(".prose p")
      .evaluateAll((items) => items.map((item) => getComputedStyle(item).direction));
    expect(directions).toEqual(["ltr", "ltr", "rtl", "ltr"]);
    expect(await article.locator(".answer-question").innerText()).toBe(UNICODE);
    expect(await sourceLabels(page)).toContain(
      rangeLabel(response.evidence!.find((ref) => ref.path === UNICODE_DOC)!),
    );
  }, 60_000);

  test("hostile answer text is shown as text and only Looky's source links are clickable", async () => {
    provider.script(HOSTILE, (call) =>
      call.kind === "answer"
        ? {
            json: {
              outcome: "supported",
              answer: [
                `The invoice total is the sum of the line items ${cite(call, "src/billing/invoice.ts")}.`,
                'This text tries <script>window.__pwned = 1</script> and <img src=x onerror="window.__pwned = 2"> injection.',
                "It also links [a phishing page](https://evil.example/steal), [a script](javascript:window.__pwned=3) and [data](data:text/html,<b>x</b>).",
                'A raw <a href="https://evil.example/raw">anchor</a> and <iframe src="https://evil.example"></iframe> stay text.',
              ].join("\n\n"),
              caveats: ['<b onmouseover="window.__pwned=4">caveat</b> stays text'],
              rationale: "not_asked",
            },
          }
        : { json: { verdict: "ok" } },
    );
    const { page, traffic } = await open1();
    await waitIndexReady(page);
    await ask(page, `${HOSTILE} <img src=x onerror="window.__pwned=5">`, "fast");
    const article = await answer(page, "fast");
    const prose = await article.locator(".prose").innerText();

    expect(prose).toContain("<script>window.__pwned = 1</script>");
    expect(prose).toContain('<img src=x onerror="window.__pwned = 2">');
    expect(prose).toContain("a phishing page");
    expect(await article.locator(".caveats").innerText()).toContain(
      '<b onmouseover="window.__pwned=4">caveat</b> stays text',
    );
    expect(await article.locator(".answer-question").innerText()).toContain(
      '<img src=x onerror="window.__pwned=5">',
    );
    const elements = await article.evaluate((node) => ({
      injected: node.querySelectorAll("script, img, iframe, object, embed, b").length,
      handlers: [...node.querySelectorAll("*")].filter((element) =>
        [...element.attributes].some((attribute) => attribute.name.startsWith("on")),
      ).length,
      hrefs: [...node.querySelectorAll("a")].map((link) => link.getAttribute("href") ?? ""),
    }));
    expect(elements.injected).toBe(0);
    expect(elements.handlers).toBe(0);
    // Every link is a source link Looky built for this answer's SHA; the cited one is clickable.
    const prefix = `https://code.example.test/pilot/blob/${repos.pilotSha}/`;
    expect(elements.hrefs.length).toBeGreaterThanOrEqual(2);
    for (const href of elements.hrefs) expect(href).toStartWith(prefix);
    expect(await article.locator('.prose a[href*="src/billing/invoice.ts"]').count()).toBe(1);
    await page.locator(".prose a").first().hover();
    await article.locator(".caveats li").first().hover();
    expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(traffic.dialogs).toEqual([]);
    expect(traffic.errors).toEqual([]);
  }, 60_000);

  test("a ready index is reused after the service restarts", async () => {
    const before = await looky.index("pilot", repos.pilotSha);
    expect(before.state).toBe("ready");
    await closePages();
    await looky.stop();
    looky = await LookyProcess.start(env);

    const { page, traffic } = await open1();
    await waitPinned(page, repos.pilotSha);
    // Ready on the first status the page gets: nothing is rebuilt.
    await waitIndexReady(page);
    const after = await looky.index("pilot", repos.pilotSha);
    expect(after.ready!.buildId).toBe(before.ready!.buildId);
    expect(after.active).toBeUndefined();

    await ask(page, RECOVERY, "fast");
    await answer(page, "fast");
    expect(traffic.submissions).toHaveLength(1);
    expect((await traffic.completed(RECOVERY))!.response!.index!.generationId).toBe(
      before.ready!.buildId,
    );
  }, 90_000);

  test("a new commit is refreshed and answered only from that commit", async () => {
    const { page, traffic } = await open1();
    await waitIndexReady(page);
    await ask(page, RECOVERY, "fast");
    await answer(page, "fast");

    // Recovery moves to resume.ts and the supervisor is deleted on main.
    const next = refreshPilotRepo(repos.pilot);
    await page.getByRole("button", { name: "Re-resolve revision" }).click();
    await waitPinned(page, next);
    // The old answer belongs to the old SHA and is gone at once.
    expect(await page.locator("article.answer").count()).toBe(0);
    await ask(page, RECOVERY, "fast");
    const article = await answer(page, "fast");

    const response = (await traffic.completed(RECOVERY, next))!.response!;
    expect(response.revision!.sha).toBe(next);
    expect(response.index!.sha).toBe(next);
    const paths = response.evidence!.map((ref) => ref.path);
    expect(paths).toContain("src/recovery/resume.ts");
    expect(paths).not.toContain("src/recovery/recover-run.ts");
    expect(paths).not.toContain("src/worker/supervisor.ts");
    await expect(article.locator(".sha-full").innerText()).resolves.toBe(next);
    for (const href of await article
      .locator("a.source-link")
      .evaluateAll((links) => links.map((link) => link.getAttribute("href") ?? ""))) {
      expect(href).toContain(`/blob/${next}/`);
    }
    const status = await looky.index("pilot", next);
    expect((await looky.build(status.ready!.buildId)).refresh?.mode).toBe("incremental");
    // The old commit stays served only to requests pinned to it.
    expect((await looky.index("pilot", repos.pilotSha)).state).toBe("ready");
    expect(await pinnedSha(page)).toBe(next);
  }, 90_000);

  test("provider credentials, client tokens and host paths never reach the browser", async () => {
    const { page, traffic } = await open1();
    await waitIndexReady(page);
    await ask(page, RECOVERY, "deep");
    await answer(page, "deep");
    const seen = [...traffic.bodies, await page.content()].join("\n");
    expect(traffic.bodies.length).toBeGreaterThan(5);
    for (const secret of [PROVIDER_API_KEY, WEB_TOKEN, PAWS_TOKEN, root.path, "scripted-e2e"]) {
      expect(seen).not.toContain(secret);
    }
  }, 60_000);
});
