import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LookyClient } from "../../../../src/client/looky-client";

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    looky: { type: "string" },
    model: { type: "string" },
    effort: { type: "string" },
    run: { type: "string" },
    questions: { type: "string", default: "all" },
    modes: { type: "string", default: "fast,deep" },
    repo: { type: "string" },
    data: { type: "string" },
    proxy: { type: "string", default: "http://127.0.0.1:7399" },
    proxyLog: { type: "string" },
    out: { type: "string" },
  },
});

const LOOKY = resolve(args.looky!);
const set = JSON.parse(readFileSync(join(LOOKY, "pilot/questions.json"), "utf8")) as {
  sha: string;
  questions: { id: string; question: string }[];
};
const SHA = set.sha;
const wanted = args.questions === "all" ? undefined : new Set(args.questions!.split(","));
const questions = set.questions.filter((q) => !wanted || wanted.has(q.id));
const modes = args.modes!.split(",") as ("fast" | "deep")[];
const repo = resolve(args.repo!);
const token = randomBytes(24).toString("hex");

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
    LOOKY_CLIENTS: "paws",
    LOOKY_CLIENT_PAWS_TOKEN: token,
    LOOKY_CLIENT_PAWS_REPOSITORIES: "paws-app",
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
const base = await listening.promise;
const client = await LookyClient.connect({ url: base, token });

const registered = await client.registerSession({
  taskId: `bench-${args.run}`,
  sequence: 1,
  clientGeneration: "bench-1",
  callerId: "bench-agent",
  repositoryId: "paws-app",
  sha: SHA,
  ref: "bench",
  worktree: { state: "clean" },
} as any);
const indexStarted = performance.now();
let indexState = "";
for (;;) {
  const status = await client.indexStatus("paws-app", SHA);
  indexState = status.state;
  if (indexState === "ready" || indexState === "failed") break;
  await Bun.sleep(100);
}
const indexWaitMs = Math.round(performance.now() - indexStarted);
if (indexState !== "ready") throw new Error(`index ${indexState}`);

let rpcId = 1;
let mcpSession = "";
async function post(body: unknown): Promise<Response> {
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${registered.token}`,
      "content-type": "application/json",
      ...(mcpSession ? { "mcp-session-id": mcpSession } : {}),
    },
    body: JSON.stringify(body),
  });
}
const init = await post({
  jsonrpc: "2.0",
  id: rpcId++,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "bench", version: "1" },
  },
});
mcpSession = init.headers.get("mcp-session-id") ?? "";
await post({ jsonrpc: "2.0", method: "notifications/initialized" });

function proxyCalls(tag: Record<string, string>): any[] {
  if (!existsSync(args.proxyLog!)) return [];
  return readFileSync(args.proxyLog!, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((r) => r.run === tag.run && r.q === tag.q && r.mode === tag.mode);
}

const rows: any[] = [];
for (const question of questions) {
  for (const mode of modes) {
    const tag = { run: args.run!, q: question.id, mode, model: args.model! };
    await fetch(`${args.proxy}/_bench/tag`, { method: "POST", body: JSON.stringify(tag) });
    const started = performance.now();
    const response = await post({
      jsonrpc: "2.0",
      id: rpcId++,
      method: "tools/call",
      params: { name: "ask_project", arguments: { question: question.question, mode } },
    });
    const ms = Math.round(performance.now() - started);
    const body = (await response.json()) as any;
    const result = body.result?.structuredContent ?? { rpcError: body.error ?? body };
    const calls = proxyCalls(tag);
    const modelMs = calls.reduce((sum, c) => sum + (c.ms ?? 0), 0);
    const problems: string[] = [];
    if (result.status === "answered") {
      if (result.revision?.sha !== SHA) problems.push(`answered at ${result.revision?.sha}`);
      for (const ref of result.evidence ?? []) {
        const blob = Bun.spawnSync(["git", "-C", repo, "cat-file", "blob", `${SHA}:${ref.path}`]);
        if (blob.exitCode !== 0) {
          problems.push(`${ref.path} not at ${SHA}`);
          continue;
        }
        const lines = blob.stdout.toString().replace(/\n$/, "").split("\n").length;
        if (ref.startLine < 1 || ref.endLine > lines)
          problems.push(`${ref.path}:${ref.startLine}-${ref.endLine} outside file`);
      }
    }
    const row = {
      ...tag,
      totalMs: ms,
      modelMs,
      nonModelMs: ms - modelMs,
      calls: calls.map(({ run: _r, q: _q, mode: _m, model: _mo, ...c }) => c),
      citationProblems: problems,
      response: result,
    };
    rows.push(row);
    console.error(
      `[${args.run}] ${question.id} ${mode}: ${result.status ?? "rpc-error"}${result.answer ? `/${result.answer.outcome}` : ""}${result.error?.code ? ` ${result.error.code}` : ""} total ${ms} ms model ${modelMs} ms calls ${calls.map((c) => `${c.kind}:${c.status ?? c.refused}:${c.ms ?? 0}ms:${c.finishReason ?? ""}`).join(",")}`,
    );
  }
}

proc.kill("SIGTERM");
await proc.exited;
mkdirSync(resolve(args.out!), { recursive: true });
writeFileSync(
  join(resolve(args.out!), `${args.run}.json`),
  JSON.stringify(
    {
      run: args.run,
      model: args.model,
      effort: args.effort ?? null,
      proxy: args.proxy,
      sha: SHA,
      lookyCommit: Bun.spawnSync(["git", "-C", LOOKY, "rev-parse", "HEAD"])
        .stdout.toString()
        .trim(),
      generationId: rows.find((r) => r.response.index)?.response.index.generationId,
      indexWaitMs,
      rows,
    },
    null,
    2,
  ),
);
