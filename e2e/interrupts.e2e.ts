/**
 * Interrupted and repeated questions in the production browser app against
 * the real Looky service. The scripted provider holds answer calls open, so
 * a test decides when a result arrives and sees whether Looky aborted the
 * call. Assertions check both sides: what the page shows, and how much
 * research the provider was asked to do.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  answer,
  ask,
  launchBrowser,
  open,
  pageFetch,
  pinnedSha,
  statusTitle,
  staysWithoutAnswer,
  waitIndexReady,
  waitPinned,
  type Browser,
  type Opened,
} from "./support/app";
import { buildApp, LookyProcess, serviceEnv, tempRoot } from "./support/looky";
import { ScriptedProvider } from "./support/provider";
import { createRepos, type Repos } from "./support/repos";

let root: ReturnType<typeof tempRoot>;
let repos: Repos;
let provider: ScriptedProvider;
let looky: LookyProcess;
let browser: Browser;
const pages: Opened[] = [];

async function page1(path = "/") {
  const opened = await open(browser, `${looky.url}${path}`);
  pages.push(opened);
  await waitIndexReady(opened.page);
  return opened;
}

beforeAll(async () => {
  root = tempRoot("looky-e2e-interrupts-");
  repos = createRepos(root.path);
  provider = new ScriptedProvider();
  const assets = await buildApp(join(root.path, "web"));
  looky = await LookyProcess.start(
    serviceEnv({ repos, provider, assetsDir: assets, dataDir: join(root.path, "data") }),
  );
  browser = await launchBrowser();
}, 120_000);

afterEach(async () => {
  for (const opened of pages.splice(0)) await opened.context.close();
});

afterAll(async () => {
  await browser?.close();
  await looky?.stop();
  await provider?.stop();
  root?.cleanup();
});

describe("interrupted and repeated questions", () => {
  test("a double click and repeated Ctrl+Enter submit one question and research it once", async () => {
    const question = "Where is saveCheckpoint defined? (double submit)";
    const hold = provider.hold("double submit");
    const { page, traffic } = await page1();
    await page.getByLabel("Your question about the code").fill(question);
    await page.getByRole("button", { name: "Ask in Fast" }).dblclick();
    await page.getByLabel("Your question about the code").press("Control+Enter");
    await page.getByLabel("Your question about the code").press("Control+Enter");
    await hold.started;
    await statusTitle(page, "Working on the Fast answer");
    expect(await page.getByRole("button", { name: "Ask in Fast" }).isDisabled()).toBe(true);
    hold.release();
    await answer(page, "fast");

    expect(traffic.submissions.filter((item) => item.question === question)).toHaveLength(1);
    expect(provider.callsFor("double submit", "answer")).toHaveLength(1);
  }, 60_000);

  test("a submission whose response is lost is resent with the same id and researched once", async () => {
    const question = "How does loadCheckpoint find the newest checkpoint? (lost response)";
    const { page, traffic } = await page1();
    let dropped = 0;
    await page.route("**/browser/v1/questions", async (route) => {
      if (route.request().method() !== "POST" || dropped > 0) return route.continue();
      dropped += 1;
      // Looky receives and accepts the question; the page never sees the reply.
      await route.fetch();
      await route.abort("connectionreset");
    });
    await ask(page, question, "fast");
    await answer(page, "fast");

    const sent = traffic.submissions.filter((item) => item.question === question);
    expect(sent).toHaveLength(2);
    expect(sent[1]!.clientRequestId).toBe(sent[0]!.clientRequestId);
    expect(provider.callsFor("lost response", "answer")).toHaveLength(1);
  }, 60_000);

  test("Cancel stops the question at Looky, its late result never shows, and Ask again researches once", async () => {
    const question = "Explain replayFromCheckpoint attempts (cancel button)";
    const hold = provider.hold("cancel button");
    const { page, traffic } = await page1();
    await ask(page, question, "fast");
    const held = await hold.started;
    await page.getByRole("button", { name: "Cancel" }).click();
    await statusTitle(page, "Cancelled");
    await page.getByText("No answer is shown for this question.").waitFor();
    await provider.waitFor(() => held.status === "aborted");
    expect(traffic.cancels).toHaveLength(1);

    // The provider would now reply; nothing from that cancelled question appears.
    hold.release();
    await staysWithoutAnswer(page);
    expect(await page.locator(".status-title").innerText()).toBe("Cancelled");

    await page.getByRole("button", { name: "Ask again" }).click();
    await answer(page, "fast");
    const calls = provider.callsFor("cancel button", "answer");
    expect(calls.map((call) => call.status)).toEqual(["aborted", "replied"]);
    expect(traffic.submissions.filter((item) => item.question === question)).toHaveLength(2);
  }, 60_000);

  test("Escape cancels from the keyboard and focus moves to the outcome", async () => {
    const question = "What does onWorkerExit do with exit code zero? (escape key)";
    const hold = provider.hold("escape key");
    const { page } = await page1();
    const box = page.getByLabel("Your question about the code");
    await box.fill(question);
    await box.press("Control+Enter");
    const held = await hold.started;
    await box.press("Escape");
    await statusTitle(page, "Cancelled");
    await provider.waitFor(() => held.status === "aborted");
    await page.waitForFunction(() => document.activeElement?.className === "status-title");
    hold.release();
    await staysWithoutAnswer(page);
  }, 60_000);

  test("cancelling in one browser session leaves another session's same question running", async () => {
    const question = "How does resumeInterruptedRun use the retry policy? (two sessions)";
    const hold = provider.hold("two sessions");
    const a = await page1();
    const b = await page1();
    await ask(a.page, question, "fast");
    await ask(b.page, question, "fast");
    await provider.waitFor(() => provider.callsFor("two sessions", "answer").length === 2);

    // B cannot see or cancel A's question: it belongs to A's browser session.
    const aQuestion = a.traffic.views.find((view) => view.state === "running")!.id;
    expect((await pageFetch(b.page, `/browser/v1/questions/${aQuestion}`)).status).toBe(404);
    const foreign = await pageFetch(b.page, `/browser/v1/questions/${aQuestion}/cancel`, {
      method: "POST",
      body: {},
      csrf: true,
    });
    expect(foreign.status).toBe(404);
    expect(provider.callsFor("two sessions", "answer").map((call) => call.status)).toEqual([
      "running",
      "running",
    ]);

    await a.page.getByRole("button", { name: "Cancel" }).click();
    await statusTitle(a.page, "Cancelled");
    await provider.waitFor(() =>
      provider.callsFor("two sessions", "answer").some((call) => call.status === "aborted"),
    );
    expect(
      provider.callsFor("two sessions", "answer").filter((call) => call.status === "running"),
    ).toHaveLength(1);

    hold.release();
    await answer(b.page, "fast");
    await staysWithoutAnswer(a.page);
    expect(
      provider
        .callsFor("two sessions", "answer")
        .map((call) => call.status)
        .sort(),
    ).toEqual(["aborted", "replied"]);
  }, 60_000);

  test("choosing another repository mid-question cancels it and its answer never appears", async () => {
    const question = "How is a run replayed after a crash? (switch repository)";
    const hold = provider.hold("switch repository");
    const { page, traffic } = await page1();
    await ask(page, question, "fast");
    const held = await hold.started;
    await page.getByLabel("Repository").selectOption("notes");
    await waitPinned(page, repos.notesSha);
    await provider.waitFor(() => held.status === "aborted");
    expect(traffic.cancels).toHaveLength(1);
    hold.release();
    await staysWithoutAnswer(page);
    expect(await page.locator(".status-title").count()).toBe(0);

    // The new repository answers from its own commit only.
    await waitIndexReady(page);
    await ask(page, "How does saveNote store a note?", "fast");
    await answer(page, "fast");
    const response = (await traffic.completed("How does saveNote store a note?"))!.response!;
    expect(response.revision).toMatchObject({ repositoryId: "notes", sha: repos.notesSha });
    expect(response.evidence!.map((ref) => ref.path)).toContain("src/notebook.ts");
  }, 60_000);

  test("a late result of an earlier revision never shows, even after switching back to it", async () => {
    const question = "Where does the retry backoff come from? (switch revision)";
    const hold = provider.hold("switch revision");
    const { page, traffic } = await page1();
    await ask(page, question, "fast");
    const held = await hold.started;
    await page.getByLabel("Revision").selectOption("refs/heads/feature");
    await waitPinned(page, repos.featureSha);
    // Back to the original revision before the held result is released.
    await page.getByLabel("Revision").selectOption("HEAD");
    await waitPinned(page, repos.pilotSha);
    await provider.waitFor(() => held.status === "aborted");
    hold.release();
    await staysWithoutAnswer(page);

    await page.getByLabel("Revision").selectOption("refs/heads/feature");
    await waitPinned(page, repos.featureSha);
    await waitIndexReady(page);
    await ask(page, question, "fast");
    const article = await answer(page, "fast");
    expect((await traffic.completed(question, repos.featureSha))!.response!.revision!.sha).toBe(
      repos.featureSha,
    );
    expect(await article.locator(".sha-full").innerText()).toBe(repos.featureSha);
    expect(provider.callsFor("switch revision", "answer").map((call) => call.status)).toEqual([
      "aborted",
      "replied",
    ]);
  }, 60_000);

  test("back and forward move between revisions, and answers never follow them", async () => {
    const { page } = await page1();
    expect(new URL(page.url()).searchParams.get("ref")).toBe("HEAD");
    await page.getByLabel("Revision").selectOption("refs/heads/feature");
    await waitPinned(page, repos.featureSha);
    expect(new URL(page.url()).search).toBe("?repo=pilot&ref=refs%2Fheads%2Ffeature");
    await waitIndexReady(page);
    await ask(page, "What does replayBackoffMs return? (history)", "fast");
    await answer(page, "fast");

    await page.goBack();
    await waitPinned(page, repos.pilotSha);
    expect(await page.locator("article.answer").count()).toBe(0);
    expect(await page.getByLabel("Revision").inputValue()).toBe("HEAD");

    await page.goForward();
    await waitPinned(page, repos.featureSha);
    // The answer was for an earlier visit; it is not restored as current.
    expect(await page.locator("article.answer").count()).toBe(0);
    expect(await page.getByLabel("Revision").inputValue()).toBe("refs/heads/feature");

    await page.reload();
    await waitPinned(page, repos.featureSha);
    expect(await page.getByLabel("Your question about the code").inputValue()).toBe("");
    expect(await page.locator("article.answer").count()).toBe(0);
  }, 60_000);

  test("reloading during a question cancels it at Looky and shows no stale answer", async () => {
    const question = "How does computeInvoiceTotal sum line items? (reload)";
    const hold = provider.hold("(reload)");
    const { page } = await page1();
    await ask(page, question, "fast");
    const held = await hold.started;
    await page.reload();
    await waitIndexReady(page);
    expect(await pinnedSha(page)).toBe(repos.pilotSha);
    // The page sends its cancel while unloading, so Looky stops the research.
    await provider.waitFor(() => held.status === "aborted", 15_000);
    hold.release();
    await staysWithoutAnswer(page);
    expect(await page.locator(".status-title").count()).toBe(0);
  }, 60_000);
});
