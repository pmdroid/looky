/**
 * Real-codebase pilot for Looky. Runs the documented `serve` entrypoint as a
 * child process against a fresh clone of the pilot repository and drives it
 * only through supported interfaces: the client adapter API (as Paws does),
 * the MCP endpoint (as a Paws agent does) and the `looky` CLI. It never edits
 * the database.
 *
 *   bun run pilot [--source <git url or dir>] [--work <dir>] [--out <dir>]
 *                 [--questions pilot/questions.json]
 *
 * Phases: pin check, cold index, first MCP query, retrieval coverage, warm
 * repeats, restart reuse, a commit with added/changed/deleted/renamed files
 * and its refresh, a failed build and its retry, a rebuild killed mid-way and
 * its recovery, a cancelled rebuild, and answers when a provider is
 * configured. Writes `results.json` and `report.md` to `--out`.
 *
 * Provider settings (`LOOKY_PROVIDER*`) are passed through from the
 * environment and never written to the results. Without them every step
 * except answer generation still runs, and the report says so.
 */
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  LookyClient,
  type IndexStatusView,
  type RegisterSessionRequest,
} from "../src/client/looky-client";
import { loadAskConfig, loadIndexConfig, loadResearchConfig } from "../src/config";
import type { AskProjectResponse } from "../src/contract/response";
import {
  citationProblems,
  coverage,
  median,
  MODES,
  parseQuestionSet,
  splitLines,
  table,
  validatePins,
  type Check,
  type Coverage,
  type Mode,
  type PilotQuestion,
  type QuestionSet,
  type RetrievedEvidence,
} from "./harness";

const LOOKY_ROOT = resolve(import.meta.dir, "..");
const REPOSITORY_ID = "paws-app";
const CLIENT_ID = "paws";
const TASK_ID = "PAS-971-pilot";
const PILOT_AUTHOR = {
  GIT_AUTHOR_NAME: "Looky Pilot",
  GIT_AUTHOR_EMAIL: "pilot@looky.invalid",
  GIT_COMMITTER_NAME: "Looky Pilot",
  GIT_COMMITTER_EMAIL: "pilot@looky.invalid",
};

// ---------------------------------------------------------------------------
// Arguments and recording

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    source: { type: "string" },
    work: { type: "string" },
    out: { type: "string" },
    questions: { type: "string", default: join(LOOKY_ROOT, "pilot/questions.json") },
  },
});

const set: QuestionSet = parseQuestionSet(JSON.parse(readFileSync(args.questions!, "utf8")));
const work = resolve(args.work ?? mkdtempSync(join(tmpdir(), "looky-pilot-")));
const out = resolve(args.out ?? join(work, "results"));
const repo = join(work, REPOSITORY_ID);
const dataDir = join(work, "data");
mkdirSync(out, { recursive: true });

const checks: Check[] = [];
const results: Record<string, unknown> = {};
const logPath = join(work, "service.log");

function check(name: string, passed: boolean, detail: string): boolean {
  checks.push({ name, passed, detail });
  console.error(`${passed ? "PASS" : "FAIL"} ${name}: ${detail}`);
  return passed;
}

function log(message: string): void {
  console.error(`[pilot] ${message}`);
}

const providerConfigured = Boolean(process.env.LOOKY_PROVIDER?.trim());

// ---------------------------------------------------------------------------
// Git

function git(...gitArgs: string[]): string {
  const result = Bun.spawnSync(["git", "-C", repo, ...gitArgs], {
    env: { PATH: process.env.PATH ?? "", HOME: work, GIT_CONFIG_NOSYSTEM: "1", ...PILOT_AUTHOR },
  });
  if (result.exitCode !== 0) {
    throw new Error(`git ${gitArgs.join(" ")} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString().trim();
}

const blobCache = new Map<string, string | undefined>();
function readBlob(sha: string, path: string): string | undefined {
  const key = `${sha}:${path}`;
  if (!blobCache.has(key)) {
    const result = Bun.spawnSync(["git", "-C", repo, "cat-file", "blob", key]);
    blobCache.set(key, result.exitCode === 0 ? result.stdout.toString() : undefined);
  }
  return blobCache.get(key);
}

// ---------------------------------------------------------------------------
// Service process

const clientToken = randomBytes(24).toString("hex");

interface Service {
  readonly url: string;
  readonly client: LookyClient;
  readonly proc: ReturnType<typeof Bun.spawn>;
  stop(): Promise<{ cpuMs: number; maxRssMb: number; exitCode: number | null }>;
  kill(): Promise<void>;
}

function serviceEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? work,
    LOOKY_DATA_DIR: dataDir,
    LOOKY_HOST: "127.0.0.1",
    LOOKY_PORT: "0",
    LOOKY_REPOSITORIES: REPOSITORY_ID,
    LOOKY_REPOSITORY_PAWS_APP_PATH: repo,
    LOOKY_CLIENTS: CLIENT_ID,
    LOOKY_CLIENT_PAWS_TOKEN: clientToken,
    LOOKY_CLIENT_PAWS_REPOSITORIES: REPOSITORY_ID,
  };
  for (const [name, value] of Object.entries(process.env)) {
    if (name.startsWith("LOOKY_") && !(name in env) && value !== undefined) env[name] = value;
  }
  return { ...env, ...extra };
}

async function startService(label: string, extra: Record<string, string> = {}): Promise<Service> {
  const proc = Bun.spawn(["bun", "run", "src/cli.ts", "serve"], {
    cwd: LOOKY_ROOT,
    env: serviceEnv(extra),
    stdout: "ignore",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  let url: string | undefined;
  let captured = "";
  const ready = Promise.withResolvers<string>();
  void (async () => {
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      const text = decoder.decode(chunk);
      captured += text;
      writeFileSync(logPath, `[${label}] ${text}`, { flag: "a" });
      const match = /listening on (http:\/\/\S+?);/.exec(captured);
      if (match && !url) {
        url = match[1]!;
        ready.resolve(url);
      }
    }
    ready.reject(new Error(`service ${label} exited before listening: ${captured.trim()}`));
  })();
  const timeout = setTimeout(
    () => ready.reject(new Error(`service ${label} did not start`)),
    30_000,
  );
  const base = await ready.promise.finally(() => clearTimeout(timeout));
  const health = await fetch(`${base}/healthz`);
  if (!health.ok) throw new Error(`service ${label} is not healthy: ${health.status}`);
  const client = await LookyClient.connect({ url: base, token: clientToken });
  log(`service ${label} pid ${proc.pid} at ${base}`);
  return {
    url: base,
    client,
    proc,
    async stop() {
      proc.kill("SIGTERM");
      const exitCode = await proc.exited;
      const usage = proc.resourceUsage();
      return {
        exitCode,
        cpuMs: usage ? Math.round(Number(usage.cpuTime.total) / 1000) : -1,
        maxRssMb: usage ? Math.round(usage.maxRSS / 1024) : -1,
      };
    },
    async kill() {
      proc.kill("SIGKILL");
      await proc.exited;
    },
  };
}

async function operational<T>(service: Service, method: string, path: string): Promise<T> {
  const response = await fetch(`${service.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${clientToken}`, "looky-protocol-version": "1" },
  });
  const body = (await response.json()) as T;
  if (!response.ok)
    throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(body)}`);
  return body;
}

interface BuildView {
  readonly id: string;
  readonly sha: string;
  readonly state: string;
  readonly phase: string;
  readonly filesTotal: number;
  readonly filesDone: number;
  readonly filesIndexed: number;
  readonly filesExcluded: number;
  readonly filesReused: number;
  readonly chunkCount: number;
  readonly indexedBytes: number;
  readonly refresh: Record<string, unknown> | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
}

async function getBuild(service: Service, id: string): Promise<BuildView> {
  const body = await operational<{ build?: BuildView } & BuildView>(
    service,
    "GET",
    `/v1/builds/${encodeURIComponent(id)}`,
  );
  return body.build ?? body;
}

interface Waited {
  readonly status: IndexStatusView;
  readonly elapsedMs: number;
  readonly samples: readonly string[];
}

/** Poll `GET /v1/builds/:id` until the build reaches a terminal state. */
async function waitForBuild(service: Service, id: string, timeoutMs = 600_000): Promise<BuildView> {
  const started = performance.now();
  for (;;) {
    const build = await getBuild(service, id);
    if (!["queued", "running"].includes(build.state)) return build;
    if (performance.now() - started > timeoutMs) throw new Error(`build ${id} timed out`);
    await Bun.sleep(50);
  }
}

/** Poll `GET /v1/index` until the SHA is ready or failed, keeping distinct progress lines. */
async function waitForIndex(service: Service, sha: string, timeoutMs = 600_000): Promise<Waited> {
  const started = performance.now();
  const samples: string[] = [];
  for (;;) {
    const status = await service.client.indexStatus(REPOSITORY_ID, sha);
    const progress = status.active?.progress;
    const line = progress
      ? `${status.state} ${progress.phase} ${progress.filesDone ?? "?"}/${progress.filesTotal ?? "?"}`
      : status.state;
    if (samples.at(-1) !== line) samples.push(line);
    if (status.state === "ready" || status.state === "failed") {
      return { status, elapsedMs: Math.round(performance.now() - started), samples };
    }
    if (performance.now() - started > timeoutMs) throw new Error(`index of ${sha} timed out`);
    await Bun.sleep(50);
  }
}

// ---------------------------------------------------------------------------
// Sessions and MCP, as a Paws adapter and its agent use them

let sequence = 0;

function registration(sha: string, taskId = TASK_ID): RegisterSessionRequest {
  sequence += 1;
  return {
    taskId,
    sequence,
    clientGeneration: `pilot-${sequence}`,
    callerId: `pilot-agent-${sequence}`,
    repositoryId: REPOSITORY_ID,
    sha,
    ref: "looky-pilot",
    worktree: { state: "clean" },
  };
}

class McpAgent {
  #id = 1;
  #session = "";
  constructor(
    readonly url: string,
    readonly token: string,
  ) {}

  async #post(body: unknown): Promise<Response> {
    return fetch(`${this.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
        ...(this.#session ? { "mcp-session-id": this.#session } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  async #rpc(method: string, params: unknown): Promise<Record<string, unknown>> {
    const response = await this.#post({ jsonrpc: "2.0", id: this.#id++, method, params });
    const body = (await response.json()) as { result?: Record<string, unknown>; error?: unknown };
    if (!body.result) throw new Error(`${method}: HTTP ${response.status} ${JSON.stringify(body)}`);
    return body.result;
  }

  async initialize(): Promise<{ protocolVersion: string; tools: string[] }> {
    const response = await this.#post({
      jsonrpc: "2.0",
      id: this.#id++,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "paws-pilot", version: "1" },
      },
    });
    const body = (await response.json()) as { result?: { protocolVersion: string } };
    if (!body.result) throw new Error(`initialize: HTTP ${response.status}`);
    this.#session = response.headers.get("mcp-session-id") ?? "";
    await this.#post({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = (await this.#rpc("tools/list", {})) as { tools: { name: string }[] };
    return {
      protocolVersion: body.result.protocolVersion,
      tools: listed.tools.map((tool) => tool.name),
    };
  }

  async indexStatus(): Promise<Record<string, unknown>> {
    const result = await this.#rpc("tools/call", { name: "index_status", arguments: {} });
    return result.structuredContent as Record<string, unknown>;
  }

  async ask(question: string, mode: Mode): Promise<{ response: AskProjectResponse; ms: number }> {
    const started = performance.now();
    const result = await this.#rpc("tools/call", {
      name: "ask_project",
      arguments: { question, mode },
    });
    return {
      response: result.structuredContent as AskProjectResponse,
      ms: Math.round(performance.now() - started),
    };
  }
}

async function openAgent(service: Service, token: string): Promise<McpAgent> {
  const agent = new McpAgent(service.url, token);
  await agent.initialize();
  return agent;
}

/** The parts of a typed response worth keeping when it is not an answer. */
function summarize(response: AskProjectResponse): Record<string, unknown> {
  const { requestId: _requestId, ...rest } = response as AskProjectResponse &
    Record<string, unknown>;
  return rest;
}

// ---------------------------------------------------------------------------
// CLI, as a person operating Looky uses it

function cli(cliArgs: string[], extra: Record<string, string> = {}): { json: unknown; ms: number } {
  const started = performance.now();
  const result = Bun.spawnSync(["bun", "run", "src/cli.ts", ...cliArgs], {
    cwd: LOOKY_ROOT,
    env: { ...serviceEnv(), ...extra },
  });
  const ms = Math.round(performance.now() - started);
  if (result.exitCode !== 0) {
    throw new Error(`looky ${cliArgs[0]} failed: ${result.stderr.toString().trim()}`);
  }
  return { json: JSON.parse(result.stdout.toString()), ms };
}

interface Bundle {
  readonly mode: Mode;
  readonly generationId: string;
  readonly evidence: readonly RetrievedEvidence[];
  readonly gaps: readonly string[];
  readonly conflicts: readonly unknown[];
  readonly trace: readonly { type: string }[];
  readonly usage: { passes: number; reads: number; bytes: number; elapsedMs: number };
  readonly limits: Record<string, number>;
  readonly stop: { reason: string; limit?: string };
  readonly suggestDeep: boolean;
}

function retrieve(sha: string, mode: Mode, question: string): { bundle: Bundle; ms: number } {
  const { json, ms } = cli([
    "retrieve",
    "--repo",
    repo,
    "--id",
    REPOSITORY_ID,
    "--sha",
    sha,
    "--mode",
    mode,
    "--text",
    question,
  ]);
  return { bundle: json as Bundle, ms };
}

interface RetrievalRow {
  readonly id: string;
  readonly mode: Mode;
  readonly sha: string;
  readonly generationId: string;
  readonly coverage: Coverage;
  readonly citationProblems: readonly string[];
  readonly evidence: readonly string[];
  readonly files: number;
  readonly usage: Bundle["usage"];
  readonly stop: Bundle["stop"];
  readonly gaps: readonly string[];
  readonly conflicts: number;
  readonly suggestDeep: boolean;
  readonly withinLimits: boolean;
  readonly coldMs: number;
  readonly warmMs: number;
}

function retrievalRow(question: PilotQuestion, sha: string, mode: Mode): RetrievalRow {
  const cold = retrieve(sha, mode, question.question);
  const warm = retrieve(sha, mode, question.question);
  const { bundle } = cold;
  const limits = bundle.limits;
  return {
    id: question.id,
    mode,
    sha,
    generationId: bundle.generationId,
    coverage: coverage(question.evidence, bundle.evidence),
    citationProblems: citationProblems(
      readBlob,
      { repositoryId: REPOSITORY_ID, sha, generationId: bundle.generationId },
      bundle.evidence,
    ),
    evidence: bundle.evidence.map((item) => `${item.path}:${item.startLine}-${item.endLine}`),
    files: new Set(bundle.evidence.map((item) => item.path)).size,
    usage: bundle.usage,
    stop: bundle.stop,
    gaps: bundle.gaps,
    conflicts: bundle.conflicts.length,
    suggestDeep: bundle.suggestDeep,
    withinLimits:
      bundle.usage.passes <= limits.maxPasses! &&
      bundle.usage.reads <= limits.maxReads! &&
      bundle.usage.bytes <= limits.maxReadBytes!,
    coldMs: cold.bundle.usage.elapsedMs,
    warmMs: warm.bundle.usage.elapsedMs,
  };
}

function databaseBytes(): number {
  return readdirSync(dataDir)
    .filter((name) => name.startsWith("looky.sqlite"))
    .reduce((total, name) => total + statSync(join(dataDir, name)).size, 0);
}

function buildCount(): number {
  return (cli(["status"]).json as { builds?: unknown[] } | unknown[]) instanceof Array
    ? (cli(["status"]).json as unknown[]).length
    : ((cli(["status"]).json as { builds: unknown[] }).builds?.length ?? 0);
}

// ---------------------------------------------------------------------------
// Answers

interface AnswerRow {
  readonly id: string;
  readonly mode: Mode;
  readonly sha: string;
  readonly ms: number;
  readonly response: Record<string, unknown>;
  readonly citationProblems: readonly string[];
  readonly coverage?: Coverage;
}

async function askAll(
  agent: McpAgent,
  sha: string,
  questions: readonly PilotQuestion[],
): Promise<AnswerRow[]> {
  const rows: AnswerRow[] = [];
  for (const question of questions) {
    for (const mode of MODES) {
      const { response, ms } = await agent.ask(question.question, mode);
      const row: AnswerRow = {
        id: question.id,
        mode,
        sha,
        ms,
        response: summarize(response),
        citationProblems: [],
      };
      if (response.status === "answered") {
        const lines = (path: string) => splitLines(readBlob(sha, path) ?? "").length;
        const problems = response.evidence
          .filter((ref) => readBlob(sha, ref.path) === undefined || ref.endLine > lines(ref.path))
          .map((ref) => `${ref.path}:${ref.startLine}-${ref.endLine} is not at ${sha}`);
        if (response.revision.sha !== sha) problems.push(`answered at ${response.revision.sha}`);
        const refs = response.evidence.map((ref, index) => ({
          ...ref,
          id: `R${index + 1}`,
          repositoryId: REPOSITORY_ID,
          sha,
          generationId: "",
          contentHash: "",
          kind: "",
          pass: 0,
        }));
        rows.push({
          ...row,
          citationProblems: problems,
          coverage: coverage(question.evidence, refs),
        });
      } else {
        rows.push(row);
      }
      log(`ask ${question.id} ${mode}: ${response.status} in ${ms} ms`);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Pilot

async function main(): Promise<number> {
  const startedAt = new Date().toISOString();
  const lookySha = Bun.spawnSync(["git", "-C", LOOKY_ROOT, "rev-parse", "HEAD"])
    .stdout.toString()
    .trim();
  const lookyDirty =
    Bun.spawnSync(["git", "-C", LOOKY_ROOT, "status", "--porcelain"]).stdout.toString().trim() !==
    "";
  results.environment = {
    startedAt,
    bun: Bun.version,
    looky: { sha: lookySha, dirty: lookyDirty },
    source: args.source ?? set.source,
    work,
    providerConfigured,
    configuredLimits: {
      index: loadIndexConfig(serviceEnv()).limits,
      budgets: loadAskConfig(serviceEnv()).budgets,
      research: loadResearchConfig(serviceEnv()),
    },
  };

  // Setup: a fresh clone the pilot owns. The source is never written to.
  log(`cloning ${args.source ?? set.source} into ${repo}`);
  const clone = Bun.spawnSync([
    "git",
    "clone",
    "--quiet",
    "--no-hardlinks",
    args.source ?? set.source,
    repo,
  ]);
  if (clone.exitCode !== 0) throw new Error(`clone failed: ${clone.stderr.toString().trim()}`);
  git("switch", "--quiet", "-c", "looky-pilot", set.sha);
  const base = git("rev-parse", "HEAD");
  check("pinned revision checked out", base === set.sha, base);

  // Pins are fixed before any answer exists.
  const allQuestions = [...set.questions];
  const pinProblems = validatePins(readBlob, base, allQuestions);
  if (
    !check(
      "pinned evidence holds at the base commit",
      pinProblems.length === 0,
      pinProblems.join("; ") || `${allQuestions.reduce((n, q) => n + q.evidence.length, 0)} pins`,
    )
  ) {
    return finish(1);
  }

  // 1. Cold index through session registration (Paws prewarm).
  let service = await startService("s1");
  results.service = await service.client.service();
  const coldRegistration = registration(base);
  const registered = await service.client.registerSession(coldRegistration);
  check(
    "registration starts a build of the requested SHA",
    registered.index.state !== "ready",
    registered.index.state,
  );
  const cold = await waitForIndex(service, base);
  const coldBuild = await getBuild(service, cold.status.ready!.buildId);
  const buildMs = Date.parse(coldBuild.finishedAt!) - Date.parse(coldBuild.startedAt!);
  const coverageReport = cli(["coverage", coldBuild.id, "--excluded"]).json;
  results.cold = {
    buildId: coldBuild.id,
    waitMs: cold.elapsedMs,
    buildMs,
    progress: cold.samples,
    build: coldBuild,
    databaseBytes: databaseBytes(),
    coverage: coverageReport,
  };
  check(
    "cold index is ready",
    cold.status.state === "ready",
    `${coldBuild.filesIndexed} files, ${coldBuild.chunkCount} chunks in ${buildMs} ms`,
  );
  check(
    "cold build is a full build",
    coldBuild.refresh?.mode === "full",
    JSON.stringify(coldBuild.refresh),
  );

  // 2. A query over MCP with the session token, as the Paws agent asks.
  let agent = await openAgent(service, registered.token);
  const firstQuestion = set.questions[0]!;
  const mcpStatus = await agent.indexStatus();
  const first: Record<string, unknown> = { indexStatus: mcpStatus };
  for (const mode of MODES) {
    const asked = await agent.ask(firstQuestion.question, mode);
    first[mode] = { ms: asked.ms, response: summarize(asked.response) };
    const executed = asked.response.mode.executed;
    check(
      `${mode}: mode is never switched`,
      executed === null || executed === mode,
      `requested ${mode}, executed ${executed}`,
    );
    if (!providerConfigured) {
      check(
        `${mode}: no provider is a truthful typed result`,
        asked.response.status !== "answered" && asked.response.status !== "indexing",
        `${asked.response.status}${"message" in asked.response ? `: ${asked.response.message}` : ""}`,
      );
    }
  }
  results.firstQuery = first;

  // 3. Retrieval coverage against pinned evidence, both modes, cold then warm.
  const retrieval: RetrievalRow[] = [];
  for (const question of set.questions) {
    for (const mode of MODES) {
      const row = retrievalRow(question, base, mode);
      retrieval.push(row);
      log(
        `retrieve ${question.id} ${mode}: ${row.coverage.rangesHit}/${row.coverage.pins} pinned ranges, ${row.files} files`,
      );
    }
  }
  results.retrieval = retrieval;
  const badCitations = retrieval.flatMap((row) =>
    row.citationProblems.map((p) => `${row.id} ${row.mode} ${p}`),
  );
  check(
    "every retrieved range is the exact committed text of the pinned generation",
    badCitations.length === 0,
    badCitations.slice(0, 5).join("; ") ||
      `${retrieval.reduce((n, r) => n + r.evidence.length, 0)} ranges`,
  );
  check(
    "retrieval stays within configured research limits",
    retrieval.every((row) => row.withinLimits),
    "passes, reads and bytes per bundle",
  );
  check(
    "every bundle comes from the cold generation",
    retrieval.every((row) => row.generationId === coldBuild.id),
    coldBuild.id,
  );

  // 4. Warm repeats: duplicate registration, same index, no new build.
  const buildsBeforeWarm = buildCount();
  const again = await service.client.registerSession(coldRegistration);
  check(
    "duplicate registration returns the same session",
    !again.created && again.session.id === registered.session.id,
    again.session.id,
  );
  const warmAsk: Record<string, unknown> = {};
  for (const mode of MODES) {
    const times: number[] = [];
    let status = "";
    for (let i = 0; i < 3; i += 1) {
      const asked = await agent.ask(firstQuestion.question, mode);
      times.push(asked.ms);
      status = asked.response.status;
    }
    warmAsk[mode] = { status, ms: times, medianMs: median(times) };
  }
  const warmStatus = await service.client.indexStatus(REPOSITORY_ID, base);
  results.warm = { ask: warmAsk, indexStatus: warmStatus };
  check(
    "warm repeats reuse the cold index",
    warmStatus.ready?.buildId === coldBuild.id && buildCount() === buildsBeforeWarm,
    `${buildCount()} builds`,
  );

  // 5. Restart: the persisted index and session are reused.
  const s1 = await service.stop();
  service = await startService("s2");
  const restartStatus = await service.client.indexStatus(REPOSITORY_ID, base);
  agent = await openAgent(service, registered.token);
  const afterRestart = await agent.ask(firstQuestion.question, "fast");
  results.restart = {
    stoppedService: s1,
    indexStatus: restartStatus,
    mcpIndexStatus: await agent.indexStatus(),
    firstAsk: { ms: afterRestart.ms, status: afterRestart.response.status },
    builds: buildCount(),
  };
  check(
    "restart serves the persisted index without rebuilding",
    restartStatus.state === "ready" &&
      restartStatus.ready?.buildId === coldBuild.id &&
      buildCount() === buildsBeforeWarm,
    `${restartStatus.state} ${restartStatus.ready?.buildId}`,
  );
  check(
    "session token survives the restart",
    afterRestart.response.status !== "denied",
    afterRestart.response.status,
  );

  // 6. A commit with added, changed, deleted and renamed files, then refresh.
  const change = set.change;
  git("mv", change.rename.from, change.rename.to);
  for (const edit of change.edits) {
    const file = join(repo, edit.path);
    const text = readFileSync(file, "utf8");
    if (!text.includes(edit.find)) throw new Error(`edit target not found in ${edit.path}`);
    const edited = edit.all
      ? text.replaceAll(edit.find, edit.replace)
      : text.replace(edit.find, edit.replace);
    writeFileSync(file, edited);
  }
  mkdirSync(dirname(join(repo, change.add.path)), { recursive: true });
  writeFileSync(join(repo, change.add.path), change.add.content);
  git("rm", "--quiet", change.delete.path);
  git("add", "--all");
  git("commit", "--quiet", "-m", change.message);
  const next = git("rev-parse", "HEAD");
  const nameStatus = git("diff", "--name-status", "-M", base, next);
  const changeQuestion = change.question;
  const changePins = validatePins(readBlob, next, [changeQuestion]);
  check(
    "change question pins hold at the new commit",
    changePins.length === 0,
    changePins.join("; ") || next,
  );

  const nextRegistration = registration(next);
  const nextSession = await service.client.registerSession(nextRegistration);
  const nextAgent = await openAgent(service, nextSession.token);
  const duringBuild = await nextAgent.ask(changeQuestion.question, "fast");
  const refreshed = await waitForIndex(service, next);
  const refreshBuild = await getBuild(service, refreshed.status.ready!.buildId);
  const baseStill = await service.client.indexStatus(REPOSITORY_ID, base);
  const oldAgentAsk = await agent.ask(firstQuestion.question, "fast");
  const searchAt = (buildId: string, words: string) =>
    cli(["search", buildId, words, "--limit", "20"]).json as
      | { hits?: { path: string }[] }
      | { path: string }[];
  const hitPaths = (value: ReturnType<typeof searchAt>) =>
    (Array.isArray(value) ? value : (value.hits ?? [])).map((hit) => hit.path);
  const afterRows = MODES.map((mode) => retrievalRow(changeQuestion, next, mode));
  const beforeRows = MODES.map((mode) => retrievalRow(changeQuestion, base, mode));
  results.refresh = {
    base,
    next,
    nameStatus: nameStatus.split("\n"),
    duringBuild: { ms: duringBuild.ms, response: summarize(duringBuild.response) },
    waitMs: refreshed.elapsedMs,
    progress: refreshed.samples,
    build: refreshBuild,
    buildMs: Date.parse(refreshBuild.finishedAt!) - Date.parse(refreshBuild.startedAt!),
    baseStill,
    supersededSession: {
      status: oldAgentAsk.response.status,
      reason: (oldAgentAsk.response as { reason?: string }).reason,
    },
    retrievalAfter: afterRows,
    retrievalBefore: beforeRows,
    search: {
      deletedAtBase: hitPaths(searchAt(coldBuild.id, change.delete.probe)).filter(
        (p) => p === change.delete.path,
      ),
      deletedAtNext: hitPaths(searchAt(refreshBuild.id, change.delete.probe)).filter(
        (p) => p === change.delete.path,
      ),
      addedAtBase: hitPaths(searchAt(coldBuild.id, change.add.probe)).filter(
        (p) => p === change.add.path,
      ),
      addedAtNext: hitPaths(searchAt(refreshBuild.id, change.add.probe)).filter(
        (p) => p === change.add.path,
      ),
    },
  };
  const refresh = refreshBuild.refresh as Record<string, number | string | null>;
  check(
    "refresh is incremental from the cold build",
    refresh.mode === "incremental" && refresh.baseBuildId === coldBuild.id,
    JSON.stringify(refresh),
  );
  check(
    "refresh counts the added, changed, deleted and renamed paths",
    Number(refresh.added) >= 1 &&
      Number(refresh.deleted) >= 1 &&
      (Number(refresh.renamed) >= 1 || Number(refresh.modified) >= 1),
    `added ${refresh.added}, modified ${refresh.modified}, deleted ${refresh.deleted}, renamed ${refresh.renamed}, carried ${refresh.carried}, reused ${refreshBuild.filesReused}`,
  );
  check(
    "no answer is served from an incomplete or other snapshot during refresh",
    duringBuild.response.status !== "answered" ||
      (duringBuild.response.revision.sha === next &&
        duringBuild.response.index.generationId === refreshBuild.id),
    duringBuild.response.status,
  );
  check(
    "the base revision keeps its own published index",
    baseStill.ready?.buildId === coldBuild.id,
    `${baseStill.state} ${baseStill.ready?.buildId}`,
  );
  check(
    "the superseded session is fenced",
    oldAgentAsk.response.status === "denied",
    `${oldAgentAsk.response.status} ${(oldAgentAsk.response as { reason?: string }).reason ?? ""}`,
  );
  const afterPaths = afterRows.flatMap((row) => row.evidence.map((ref) => ref.split(":")[0]!));
  const beforePaths = beforeRows.flatMap((row) => row.evidence.map((ref) => ref.split(":")[0]!));
  check(
    "new revision cites the renamed path and never the old one",
    afterPaths.includes(change.rename.to) && !afterPaths.includes(change.rename.from),
    [...new Set(afterPaths)].join(", "),
  );
  check(
    "base revision still cites the old path",
    beforePaths.includes(change.rename.from) && !beforePaths.includes(change.rename.to),
    [...new Set(beforePaths)].join(", "),
  );
  check(
    "refreshed retrieval matches the new commit's text",
    afterRows.every(
      (row) => row.citationProblems.length === 0 && row.generationId === refreshBuild.id,
    ),
    afterRows.flatMap((row) => row.citationProblems).join("; ") || refreshBuild.id,
  );
  // The first pin is the changed code; other pins are reported as coverage.
  const changedPin = changeQuestion.evidence[0]!;
  const changedRange = `${changedPin.path}:${changedPin.startLine}-${changedPin.endLine}`;
  check(
    "the changed code is retrieved in both modes at the new commit",
    afterRows.every((row) => !row.coverage.missed.includes(changedRange)),
    afterRows
      .map(
        (row) =>
          `${row.mode} ${row.coverage.rangesHit}/${row.coverage.pins}` +
          (row.coverage.missed.length ? ` (missed ${row.coverage.missed.join(", ")})` : ""),
      )
      .join("; "),
  );
  const { search } = results.refresh as { search: Record<string, string[]> };
  check(
    "deleted file is gone from the new snapshot only",
    search.deletedAtBase!.length > 0 && search.deletedAtNext!.length === 0,
    `base hits ${search.deletedAtBase!.length}, new hits ${search.deletedAtNext!.length}`,
  );
  check(
    "added file appears in the new snapshot only",
    search.addedAtBase!.length === 0 && search.addedAtNext!.length > 0,
    `base hits ${search.addedAtBase!.length}, new hits ${search.addedAtNext!.length}`,
  );

  // 7. A build that fails, reported through the interface, then retried.
  writeFileSync(
    join(repo, "LOOKY_PILOT.md"),
    "# Looky pilot\n\nA marker commit for the failure and retry phase.\n",
  );
  git("add", "LOOKY_PILOT.md");
  git("commit", "--quiet", "-m", "Looky pilot: marker commit for build failure and retry");
  const third = git("rev-parse", "HEAD");
  const s2 = await service.stop();
  service = await startService("s3-limited", { LOOKY_INDEX_MAX_FILES: "100" });
  const failRegistration = registration(third);
  const failSession = await service.client.registerSession(failRegistration);
  const failed = await waitForIndex(service, third);
  const failAgent = await openAgent(service, failSession.token);
  const failAsk = await failAgent.ask(firstQuestion.question, "fast");
  const s3 = await service.stop();
  service = await startService("s4");
  const stillFailed = await service.client.indexStatus(REPOSITORY_ID, third);
  const retried = await service.client.retry(failed.status.failure!.buildId);
  const retriedWait = await waitForIndex(service, third);
  const retriedBuild = await getBuild(service, retriedWait.status.ready!.buildId);
  results.failure = {
    sha: third,
    limit: { LOOKY_INDEX_MAX_FILES: 100 },
    status: failed.status,
    progress: failed.samples,
    ask: summarize(failAsk.response),
    afterRestart: stillFailed,
    retry: { accepted: retried, progress: retriedWait.samples, build: retriedBuild },
    stoppedServices: [s2, s3],
  };
  check(
    "an over-limit build fails explicitly",
    failed.status.state === "failed" && failed.status.failure?.code === "limit_exceeded",
    `${failed.status.failure?.code}: ${failed.status.failure?.message}`,
  );
  check(
    "a question on the failed index gets a typed index failure",
    failAsk.response.status === "failed" &&
      (failAsk.response as { stage?: string }).stage === "index",
    failAsk.response.status,
  );
  check(
    "a deterministic failure is reported, not silently retried",
    stillFailed.state === "failed",
    stillFailed.state,
  );
  check(
    "retry through the API publishes the revision",
    retriedWait.status.state === "ready" && retriedBuild.refresh?.mode === "incremental",
    JSON.stringify(retriedBuild.refresh),
  );

  // 8. A rebuild killed mid-way, and its recovery after restart.
  const rebuildStarted = await service.client.rebuild(REPOSITORY_ID, third);
  const killedBuildId = rebuildStarted.active?.buildId;
  let observed: IndexStatusView = rebuildStarted;
  for (let i = 0; i < 2000 && killedBuildId; i += 1) {
    observed = await service.client.indexStatus(REPOSITORY_ID, third);
    const progress = observed.active?.progress;
    if (!observed.active || (progress?.filesDone ?? 0) > 0) break;
    await Bun.sleep(5);
  }
  const killedWhile = observed.active
    ? `${observed.active.state} ${observed.active.progress.phase} ${observed.active.progress.filesDone}/${observed.active.progress.filesTotal}`
    : "finished";
  await service.kill();
  service = await startService("s5");
  const killedBuild = killedBuildId ? await getBuild(service, killedBuildId) : undefined;
  const afterKill = await service.client.indexStatus(REPOSITORY_ID, third);
  const recovered = killedBuildId ? await service.client.retry(killedBuildId) : afterKill;
  const recoveryBuild = recovered.active
    ? await waitForBuild(service, recovered.active.buildId)
    : undefined;
  const recoveredWait = await waitForIndex(service, third);
  results.interrupted = {
    rebuildStarted,
    killedWhile,
    killedBuild,
    servedAfterKill: afterKill,
    retry: recovered,
    recoveryBuild,
    recovered: recoveredWait.status,
  };
  check(
    "a rebuild was killed while running",
    Boolean(killedBuildId) && killedWhile !== "finished",
    killedWhile,
  );
  check(
    "the killed build is reported as interrupted and retryable",
    killedBuild?.state === "failed" &&
      killedBuild.errorCode === "interrupted" &&
      killedBuild.retryable === true,
    `${killedBuild?.state} ${killedBuild?.errorCode} retryable ${killedBuild?.retryable}`,
  );
  check(
    "the previous generation keeps serving after the kill",
    afterKill.state === "ready" && afterKill.ready?.buildId === retriedBuild.id,
    `${afterKill.state} ${afterKill.ready?.buildId}`,
  );
  check(
    "retry of the interrupted rebuild rebuilds and publishes a new generation",
    recoveryBuild?.state === "ready" &&
      recoveryBuild.refresh?.reason === "rebuild_requested" &&
      recoveredWait.status.ready?.buildId === recoveryBuild.id &&
      recoveryBuild.id !== retriedBuild.id,
    `${recoveryBuild?.state ?? recovered.state} ${recoveryBuild?.id ?? recoveredWait.status.ready?.buildId}`,
  );

  // 9. Cancellation through the API leaves the ready index serving.
  const cancelStarted = await service.client.rebuild(REPOSITORY_ID, third);
  const cancelId = cancelStarted.active?.buildId;
  const cancelled = cancelId ? await service.client.cancelBuild(cancelId) : undefined;
  const afterCancelBuild = cancelId ? await waitForBuild(service, cancelId) : undefined;
  const afterCancel = await service.client.indexStatus(REPOSITORY_ID, third);
  results.cancellation = { cancelled, build: afterCancelBuild, indexStatus: afterCancel };
  check(
    "a cancelled rebuild leaves the ready generation serving",
    afterCancel.state === "ready" &&
      afterCancel.ready?.buildId === recoveredWait.status.ready?.buildId &&
      (afterCancelBuild?.state === "cancelled" || afterCancelBuild?.state === "ready"),
    `${afterCancelBuild?.state}; serving ${afterCancel.ready?.buildId}`,
  );

  // 10. Answers in both modes, when a provider is configured.
  if (providerConfigured) {
    const answerRegistration = registration(base, `${TASK_ID}-answers-base`);
    const answerSession = await service.client.registerSession(answerRegistration);
    const answerAgent = await openAgent(service, answerSession.token);
    const baseAnswers = await askAll(answerAgent, base, set.questions);
    const changeRegistration = registration(next, `${TASK_ID}-answers-next`);
    const changeSession = await service.client.registerSession(changeRegistration);
    const changeAgent = await openAgent(service, changeSession.token);
    const changeAnswers = await askAll(changeAgent, next, [changeQuestion]);
    results.answers = [...baseAnswers, ...changeAnswers];
    const fabricated = [...baseAnswers, ...changeAnswers].flatMap((row) => row.citationProblems);
    check(
      "no answer cites a range outside its revision",
      fabricated.length === 0,
      fabricated.slice(0, 5).join("; ") || "all citations exist",
    );
    await service.client.revokeSession(answerSession.session.id);
    await service.client.revokeSession(changeSession.session.id);
  } else {
    results.answers = {
      skipped:
        "No model provider configured (LOOKY_PROVIDER unset); answers and reviewer scores are pending.",
    };
  }

  await service.client.revokeSession(nextSession.session.id);
  await service.client.revokeSession(failSession.session.id);
  results.finalService = await service.stop();
  results.finalDatabaseBytes = databaseBytes();
  return finish(checks.every((item) => item.passed) ? 0 : 1);
}

function finish(code: number): number {
  results.checks = checks;
  results.finishedAt = new Date().toISOString();
  writeFileSync(join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  writeFileSync(join(out, "report.md"), report());
  log(
    `wrote ${join(out, "results.json")} and report.md; ${checks.filter((c) => !c.passed).length} failed checks`,
  );
  return code;
}

// ---------------------------------------------------------------------------
// Report

function report(): string {
  const r = results as Record<string, any>;
  const lines: string[] = ["# Looky real-codebase pilot", ""];
  const env = r.environment ?? {};
  lines.push(
    `Looky ${env.looky?.sha ?? "?"}${env.looky?.dirty ? " (dirty)" : ""} on Bun ${env.bun}; pilot repository ${set.repositoryId} from ${env.source} at ${set.sha}.`,
    `Model provider configured: ${env.providerConfigured ? "yes" : "no"}. Started ${env.startedAt}, finished ${r.finishedAt}.`,
    "",
    "## Checks",
    "",
    table(
      ["Check", "Result", "Detail"],
      checks.map((c) => [c.name, c.passed ? "pass" : "FAIL", c.detail]),
    ),
    "",
  );
  if (r.cold) {
    const b = r.cold.build;
    lines.push(
      "## Index",
      "",
      table(
        [
          "Build",
          "SHA",
          "Refresh",
          "Files indexed",
          "Excluded",
          "Reused",
          "Chunks",
          "Indexed bytes",
          "Build ms",
          "Wait ms",
          "Database bytes",
        ],
        [
          [
            b.id,
            b.sha.slice(0, 12),
            "full (cold)",
            b.filesIndexed,
            b.filesExcluded,
            b.filesReused,
            b.chunkCount,
            b.indexedBytes,
            r.cold.buildMs,
            r.cold.waitMs,
            r.cold.databaseBytes,
          ],
          ...(r.refresh
            ? [
                [
                  r.refresh.build.id,
                  r.refresh.build.sha.slice(0, 12),
                  `${r.refresh.build.refresh.mode} +${r.refresh.build.refresh.added} ~${r.refresh.build.refresh.modified} -${r.refresh.build.refresh.deleted} r${r.refresh.build.refresh.renamed}`,
                  r.refresh.build.filesIndexed,
                  r.refresh.build.filesExcluded,
                  r.refresh.build.filesReused,
                  r.refresh.build.chunkCount,
                  r.refresh.build.indexedBytes,
                  r.refresh.buildMs,
                  r.refresh.waitMs,
                  "",
                ],
              ]
            : []),
        ],
      ),
      "",
      `Cold progress: ${r.cold.progress.join(" → ")}`,
      "",
      `Exclusions: ${JSON.stringify(r.cold.coverage?.excludedByReason ?? {})}. Languages: ${JSON.stringify(r.cold.coverage?.indexedByLanguage ?? {})}.`,
      "",
    );
  }
  if (Array.isArray(r.retrieval)) {
    lines.push(
      "## Retrieval against pinned evidence",
      "",
      "Ranges hit counts pinned ranges overlapped by a retrieved range; files hit counts pinned files present at all. Times are research time inside Looky, first then repeated.",
      "",
      table(
        [
          "Question",
          "Mode",
          "Ranges hit",
          "Files hit",
          "Files",
          "Passes",
          "Reads",
          "Bytes",
          "Stop",
          "Suggest Deep",
          "Cold ms",
          "Warm ms",
          "Missed",
        ],
        (r.retrieval as RetrievalRow[]).map((row) => [
          row.id,
          row.mode,
          `${row.coverage.rangesHit}/${row.coverage.pins}`,
          `${row.coverage.filesHit}/${row.coverage.pins}`,
          row.files,
          row.usage.passes,
          row.usage.reads,
          row.usage.bytes,
          row.stop.reason + (row.stop.limit ? `:${row.stop.limit}` : ""),
          row.suggestDeep,
          row.coldMs,
          row.warmMs,
          row.coverage.missed.join(", "),
        ]),
      ),
      "",
    );
    const totals = MODES.map((mode) => {
      const rows = (r.retrieval as RetrievalRow[]).filter((row) => row.mode === mode);
      const hit = rows.reduce((n, row) => n + row.coverage.rangesHit, 0);
      const pins = rows.reduce((n, row) => n + row.coverage.pins, 0);
      const files = rows.reduce((n, row) => n + row.coverage.filesHit, 0);
      return [
        mode,
        `${hit}/${pins}`,
        `${files}/${pins}`,
        rows.filter((row) => row.coverage.filesHit > 0).length,
        median(rows.map((row) => row.files)),
        median(rows.map((row) => row.coldMs)),
        median(rows.map((row) => row.warmMs)),
      ];
    });
    lines.push(
      table(
        [
          "Mode",
          "Ranges hit",
          "Files hit",
          "Questions with a pinned file",
          "Median files",
          "Median cold ms",
          "Median warm ms",
        ],
        totals,
      ),
      "",
    );
  }
  if (r.firstQuery) {
    lines.push(
      "## MCP queries",
      "",
      table(
        ["Phase", "Mode", "Status", "Executed mode", "ms"],
        [
          ...MODES.map((mode) => [
            "first (cold)",
            mode,
            r.firstQuery[mode].response.status,
            r.firstQuery[mode].response.mode?.executed,
            r.firstQuery[mode].ms,
          ]),
          ...MODES.map((mode) => [
            "warm x3",
            mode,
            r.warm?.ask?.[mode]?.status,
            mode,
            (r.warm?.ask?.[mode]?.ms ?? []).join(", "),
          ]),
          ["after restart", "fast", r.restart?.firstAsk?.status, "fast", r.restart?.firstAsk?.ms],
          [
            "new SHA while refreshing",
            "fast",
            r.refresh?.duringBuild?.response?.status,
            r.refresh?.duringBuild?.response?.mode?.executed,
            r.refresh?.duringBuild?.ms,
          ],
          ["on failed index", "fast", r.failure?.ask?.status, r.failure?.ask?.mode?.executed, ""],
        ],
      ),
      "",
    );
  }
  if (r.refresh) {
    lines.push(
      "## Change commit",
      "",
      `${r.refresh.base.slice(0, 12)} → ${r.refresh.next.slice(0, 12)}`,
      "",
      "```",
      ...r.refresh.nameStatus,
      "```",
      "",
    );
  }
  lines.push("## Questions and pinned evidence", "");
  for (const question of [...set.questions, set.change.question]) {
    lines.push(
      `### ${question.id} · ${question.category} · ${question.subsystem}`,
      "",
      question.question,
      "",
      `Expected: ${question.expected}`,
      "",
    );
    for (const pin of question.evidence)
      lines.push(`- \`${pin.path}:${pin.startLine}-${pin.endLine}\` ${pin.why}`);
    lines.push("");
    const answers = Array.isArray(r.answers)
      ? (r.answers as AnswerRow[]).filter((row) => row.id === question.id)
      : [];
    for (const row of answers) {
      const response = row.response as Record<string, any>;
      lines.push(
        `**${row.mode}** at ${row.sha.slice(0, 12)}, index ${response.index?.generationId ?? "-"}: ${response.status} in ${row.ms} ms, ${response.usage?.modelCalls ?? 0} model calls, ${response.usage?.inputTokens ?? 0}/${response.usage?.outputTokens ?? 0} tokens.`,
        "",
      );
      if (response.answer)
        lines.push(
          ...String(response.answer.text)
            .split("\n")
            .map((line) => `> ${line}`),
          "",
        );
      if (response.evidence)
        lines.push(
          `Evidence: ${(response.evidence as { path: string; startLine: number; endLine: number }[]).map((e) => `${e.path}:${e.startLine}-${e.endLine}`).join(", ")}`,
          "",
        );
      lines.push(
        "Reviewer: directness _, completeness _, natural explanation _, mechanism/caveats _, evidence _, uncertainty _; useful without rewriting: _",
        "",
      );
    }
  }
  if (!Array.isArray(r.answers)) {
    lines.push("## Answers and reviewer scores", "", r.answers?.skipped ?? "Not run.", "");
  }
  return `${lines.join("\n")}\n`;
}

process.exitCode = await main().catch((error: unknown) => {
  console.error("pilot:", error instanceof Error ? (error.stack ?? error.message) : error);
  check("pilot ran to completion", false, error instanceof Error ? error.message : String(error));
  return finish(2);
});
