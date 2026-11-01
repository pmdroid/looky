import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { McpConnection, type ToolHost } from "../src/mcp/protocol";
import { serveStdio } from "../src/mcp/stdio";
import { buildPilotRepo } from "./support/pilot-fixture";
import { promptEvidence } from "./support/scripted-model";
import { QUESTION } from "./support/service-fixture";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
let root: string;
let repo: string;
let sha: string;
let provider: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "looky-stdio-"));
  repo = join(root, "pilot");
  mkdirSync(repo);
  sha = buildPilotRepo(repo);
  // A local OpenAI-compatible endpoint that answers from the evidence it is sent.
  provider = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages: { role: string; content: string }[] };
      const prompt = body.messages.find((message) => message.role === "user")!.content;
      const evidence = promptEvidence(prompt);
      const cite =
        evidence.find((item) => item.path === "src/recovery/recover-run.ts") ?? evidence[0];
      const answer = {
        outcome: "supported",
        answer: `Recovery loads the newest checkpoint and replays the run from it [${cite!.id}].`,
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
  void provider.stop(true);
  rmSync(root, { recursive: true, force: true });
});

test("looky mcp serves ask_project over stdio for a local repository without Paws", async () => {
  const child = Bun.spawn(["bun", "run", CLI, "mcp", "--repo", repo, "--id", "pilot"], {
    env: {
      ...process.env,
      LOOKY_DATA_DIR: join(root, "data"),
      LOOKY_PROVIDER: "local",
      LOOKY_PROVIDER_LOCAL_KIND: "openai",
      LOOKY_PROVIDER_LOCAL_MODEL: "test-model",
      LOOKY_PROVIDER_LOCAL_BASE_URL: `http://127.0.0.1:${provider.port}/v1`,
      LOOKY_INDEX_WAIT_MS: "60000",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const reader = child.stdout.getReader();
  let buffer = "";
  const next = async (): Promise<any> => {
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline !== -1) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        return JSON.parse(line);
      }
      const { value, done } = await reader.read();
      if (done) throw new Error(`stdout closed: ${await new Response(child.stderr).text()}`);
      buffer += new TextDecoder().decode(value);
    }
  };

  send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
  expect((await next()).result.protocolVersion).toBe("2025-03-26");
  send({ jsonrpc: "2.0", method: "notifications/initialized" });
  send({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "ask_project", arguments: { question: QUESTION } },
  });
  const answer = await next();
  expect(answer.id).toBe(2);
  const response = answer.result.structuredContent;
  expect(response.status).toBe("answered");
  expect(response.revision).toMatchObject({ repositoryId: "pilot", sha, ref: "HEAD" });
  expect(response.scope.uncommittedChanges).toBe("unknown");
  expect(answer.result.content[0].text).toContain("checkpoint");

  send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } });
  expect((await next()).error.code).toBe(-32602);

  child.stdin.end();
  expect(await child.exited).toBe(0);
}, 60_000);

test("serveStdio answers concurrently so a cancellation reaches a running call", async () => {
  let release!: () => void;
  const host: ToolHost = {
    instructions: "",
    listTools: () => [],
    callTool: (_name, _args, call) =>
      new Promise((resolve) => {
        release = () => resolve({ content: [{ type: "text", text: "done" }], isError: false });
        call.signal.addEventListener("abort", () =>
          resolve({ content: [{ type: "text", text: "cancelled" }], isError: true }),
        );
      }),
  };
  const lines: string[] = [];
  const encoder = new TextEncoder();
  let push!: (line: string) => void;
  let finish!: () => void;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (line) => controller.enqueue(encoder.encode(`${line}\n`));
      finish = () => controller.close();
    },
  });
  const served = serveStdio(new McpConnection(host), { input, write: (line) => lines.push(line) });
  push(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "x" } }));
  push(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 7 } }),
  );
  await Bun.sleep(20);
  expect(lines.map((line) => JSON.parse(line).result.content[0].text)).toEqual(["cancelled"]);
  release();
  finish();
  await served;
});
