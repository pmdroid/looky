import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AskProjectResponse } from "../src/contract/response";
import { buildPilotRepo } from "./support/pilot-fixture";
import { promptEvidence } from "./support/scripted-model";

let root: string;
let repo: string;
let sha: string;
let server: ReturnType<typeof Bun.serve>;
const received: { model: string; authorization: string | null }[] = [];

const CLI = resolve(import.meta.dir, "../src/cli.ts");

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "looky-ask-cli-"));
  repo = join(root, "pilot");
  Bun.spawnSync(["mkdir", "-p", repo]);
  sha = buildPilotRepo(repo);
  // A local OpenAI-compatible endpoint that answers from the evidence it is sent.
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as {
        model: string;
        messages: { role: string; content: string }[];
      };
      received.push({ model: body.model, authorization: request.headers.get("authorization") });
      const prompt = body.messages.find((message) => message.role === "user")!.content;
      const evidence = promptEvidence(prompt);
      const checkpoints = evidence.find((item) => item.path === "src/storage/checkpoints.ts");
      const answer = {
        outcome: checkpoints ? "supported" : "unknown",
        answer: checkpoints
          ? `\`loadCheckpoint\` returns undefined when no checkpoint was ever saved [${checkpoints.id}].`
          : "The evidence does not show this.",
        rationale: "not_asked",
      };
      return Response.json({
        choices: [{ message: { content: JSON.stringify(answer) } }],
        usage: { prompt_tokens: Math.ceil(prompt.length / 4), completion_tokens: 40 },
      });
    },
  });
});

afterAll(() => {
  void server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

function cli(args: string[], env: Record<string, string> = {}) {
  return Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, LOOKY_DATA_DIR: join(root, "data"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
}

test("looky ask answers through a configured OpenAI-compatible provider", async () => {
  const index = cli(["index", "--repo", repo, "--sha", sha, "--id", "pilot"]);
  expect(await index.exited).toBe(0);

  const ask = cli(
    [
      "ask",
      "--repo",
      repo,
      "--sha",
      sha,
      "--id",
      "pilot",
      "What does loadCheckpoint return when nothing is stored?",
    ],
    {
      LOOKY_PROVIDER: "local",
      LOOKY_PROVIDER_LOCAL_KIND: "openai",
      LOOKY_PROVIDER_LOCAL_MODEL: "local-coder",
      LOOKY_PROVIDER_LOCAL_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
      LOOKY_PROVIDER_LOCAL_API_KEY: "local-key",
      LOOKY_SOURCE_LINK_TEMPLATE:
        "https://code.example/pilot/blob/{sha}/{path}#L{startLine}-L{endLine}",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    ask.exited,
    new Response(ask.stdout).text(),
    new Response(ask.stderr).text(),
  ]);
  expect(stderr).toBe("");
  expect(code).toBe(0);
  const response = JSON.parse(stdout) as AskProjectResponse;
  if (response.status !== "answered") throw new Error(stdout);
  expect(response.mode).toEqual({ requested: "fast", executed: "fast" });
  expect(response.index.sha).toBe(sha);
  expect(response.providers).toEqual(["local"]);
  expect(response.answer.text).toContain(
    `https://code.example/pilot/blob/${sha}/src/storage/checkpoints.ts#L`,
  );
  expect(response.evidence[0]!.path).toBe("src/storage/checkpoints.ts");
  expect(received).toEqual([{ model: "local-coder", authorization: "Bearer local-key" }]);
});

test("looky ask without a provider explains how to configure one", async () => {
  const ask = cli(["ask", "--repo", repo, "--sha", sha, "--id", "pilot", "anything"], {
    LOOKY_PROVIDER: "",
  });
  expect(await ask.exited).toBe(1);
  expect(await new Response(ask.stderr).text()).toContain("set LOOKY_PROVIDER");
});
