import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WikiPlan } from "../src/wiki/model";
import { buildPilotRepo } from "./support/pilot-fixture";
import { promptEvidence } from "./support/scripted-model";
import { groundedPage } from "./support/wiki-fixture";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
let root: string;
let repo: string;
let sha: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "looky-wiki-cli-"));
  repo = join(root, "pilot");
  mkdirSync(repo);
  sha = buildPilotRepo(repo);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function cli(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, LOOKY_DATA_DIR: join(root, "data"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("wiki plan prints a bounded plan with coverage for a ready index, without storing it", async () => {
  const missing = await cli(["wiki", "plan", "--repo", repo, "--sha", sha, "--id", "pilot"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("No ready index");

  expect((await cli(["index", "--repo", repo, "--sha", sha, "--id", "pilot"])).code).toBe(0);
  const planned = await cli(["wiki", "plan", "--repo", repo, "--sha", sha, "--id", "pilot"], {
    LOOKY_WIKI_MAX_PAGES: "6",
  });
  expect(planned.code).toBe(0);
  const plan = JSON.parse(planned.stdout) as WikiPlan;
  expect(plan).toMatchObject({ repositoryId: "pilot", sha, limits: { maxPages: 6 } });
  expect(plan.pages.length).toBeLessThanOrEqual(6);
  expect(plan.pages[0]!.slug).toBe("overview");
  expect(plan.coverage.modules).toEqual({ found: 5, planned: 2 });
  expect(plan.disclosures.map((item) => item.code)).toContain("modules_truncated");

  const status = await cli(["wiki", "status", "--id", "pilot"]);
  expect(JSON.parse(status.stdout)).toEqual([]);
  const unknown = await cli(["wiki", "index", "wiki_missing", "--id", "pilot"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("Unknown wiki generation");
}, 60_000);

/** A local OpenAI-compatible server that writes grounded wiki pages from the prompt it gets. */
function fakeProvider() {
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      requests += 1;
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const prompt = body.messages.find((message) => message.role === "user")!.content;
      const page = groundedPage({
        request: { system: "", prompt, maxOutputTokens: 1 },
        evidence: promptEvidence(prompt),
        title: /^Title: (.*)$/m.exec(prompt)?.[1] ?? "",
        neighbours: [],
        repair: false,
        signal: new AbortController().signal,
      });
      return Response.json({
        choices: [{ message: { content: JSON.stringify(page) } }],
        usage: { prompt_tokens: 100, completion_tokens: 50 },
      });
    },
  });
  return {
    get requests() {
      return requests;
    },
    env: {
      LOOKY_PROVIDER: "fake",
      LOOKY_PROVIDER_FAKE_KIND: "openai",
      LOOKY_PROVIDER_FAKE_MODEL: "fake-model",
      LOOKY_PROVIDER_FAKE_BASE_URL: `http://127.0.0.1:${server.port}`,
    },
    stop: () => server.stop(true),
  };
}

test("wiki generate indexes, writes and publishes, then reuses the published wiki", async () => {
  const provider = fakeProvider();
  const dataDir = join(root, "generate-data");
  try {
    const args = ["wiki", "generate", "--repo", repo, "--sha", sha, "--id", "pilot"];
    const first = await cli(args, { ...provider.env, LOOKY_DATA_DIR: dataDir });
    expect(first.code).toBe(0);
    const result = JSON.parse(first.stdout) as {
      generation: { state: string; usage: { modelCalls: number; reportedCalls: number } };
      published: boolean;
    };
    expect(result.published).toBe(true);
    expect(result.generation.state).toBe("ready");
    expect(result.generation.usage.reportedCalls).toBe(result.generation.usage.modelCalls);
    const calls = provider.requests;
    expect(calls).toBe(result.generation.usage.modelCalls);

    const again = await cli(args, { ...provider.env, LOOKY_DATA_DIR: dataDir });
    expect(again.code).toBe(0);
    expect(provider.requests).toBe(calls);
  } finally {
    provider.stop();
  }
}, 60_000);

test("Ctrl-C while the commit is indexing stops before any generation or model call", async () => {
  const provider = fakeProvider();
  const dataDir = join(root, "interrupt-data");
  try {
    const child = Bun.spawn(
      ["bun", "run", CLI, "wiki", "generate", "--repo", repo, "--sha", sha, "--id", "pilot"],
      {
        env: { ...process.env, ...provider.env, LOOKY_DATA_DIR: dataDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const reader = child.stderr.getReader();
    let stderr = "";
    while (!stderr.includes("looky: indexing")) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`exited before indexing: ${stderr}`);
      stderr += new TextDecoder().decode(value);
    }
    child.kill("SIGINT");
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      stderr += new TextDecoder().decode(value);
    }
    expect(await child.exited).toBe(130);
    expect(stderr).toContain("interrupted; no wiki generation was started");
    expect(provider.requests).toBe(0);
    const status = await cli(["wiki", "status", "--id", "pilot"], { LOOKY_DATA_DIR: dataDir });
    expect(JSON.parse(status.stdout)).toEqual([]);
  } finally {
    provider.stop();
  }
}, 60_000);
