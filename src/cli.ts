/**
 * Index diagnostics and operations without direct database edits.
 *
 *   bun run looky index --repo <git-dir> --sha <commit> [--id <repository-id>] [--rebuild]
 *   bun run looky retry <build-id> --repo <git-dir>
 *   bun run looky status [<build-id>] [--id <repository-id>] [--sha <commit>]
 *   bun run looky gc
 *   bun run looky coverage <build-id> [--excluded]
 *   bun run looky search <build-id> <query> [--limit <n>]
 *   bun run looky retrieve --repo <git-dir> --sha <commit> [--id <id>] [--mode fast|deep] [--text] <question…>
 *   bun run looky ask --repo <git-dir> --sha <commit> [--id <id>] [--mode fast|deep] <question…>
 *   bun run looky cancel <build-id>
 *
 * Output is JSON on stdout. Data lives in LOOKY_DATA_DIR (default `.looky`).
 */
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { LookyAnswerEngine } from "./answer/engine";
import { askProject } from "./ask/ask-project";
import { GuardedSession } from "./ask/session";
import { loadAnswerConfig, loadAskConfig, loadIndexConfig, loadResearchConfig } from "./config";
import type { LookyRequestContext } from "./contract/context";
import { DEFAULT_MODE, isMode } from "./contract/input";
import { LookyUnavailableError } from "./contract/ports";
import { createConfiguredProvider } from "./providers/config";
import { IndexService, progressOf, type StartBuildResult } from "./indexing/index-service";
import { indexKey } from "./indexing/policy";
import {
  coverageReport,
  findReadyBuild,
  finishUnsuccessfully,
  getBuild,
  listBuilds,
  scopeStatus,
  searchChunks,
} from "./indexing/store";
import { IndexRetriever } from "./retrieval/index-retriever";
import { researchEvidence } from "./retrieval/research";
import { GitSourceReader } from "./source/git-source-reader";
import { openDatabase } from "./storage/database";

const USAGE = `Usage:
  looky index --repo <git-dir> --sha <commit> [--id <repository-id>] [--rebuild]
  looky retry <build-id> --repo <git-dir>
  looky status [<build-id>] [--id <repository-id>] [--sha <commit>]
  looky gc
  looky coverage <build-id> [--excluded]
  looky search <build-id> <query> [--limit <n>]
  looky retrieve --repo <git-dir> --sha <commit> [--id <id>] [--mode fast|deep] [--text] <question>
  looky ask --repo <git-dir> --sha <commit> [--id <id>] [--mode fast|deep] <question>
  looky cancel <build-id>`;

function print(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      repo: { type: "string" },
      id: { type: "string" },
      sha: { type: "string" },
      rebuild: { type: "boolean", default: false },
      excluded: { type: "boolean", default: false },
      limit: { type: "string" },
      mode: { type: "string" },
      text: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, ...rest] = positionals;
  if (values.help || command === undefined) {
    console.log(USAGE);
    return command === undefined && !values.help ? 2 : 0;
  }

  const db = openDatabase();
  try {
    switch (command) {
      case "index":
        return await index(db, values);
      case "retry":
        return await retry(db, rest[0], values.repo);
      case "gc": {
        const service = openService(db, () => undefined);
        try {
          print(service.collectGarbage());
        } finally {
          await service.close();
        }
        return 0;
      }
      case "status": {
        const buildId = rest[0];
        if (buildId) {
          const build = getBuild(db, buildId);
          if (!build) return fail(`Unknown build ${buildId}`);
          print({ ...build, progress: progressOf(build) });
        } else if (values.id && values.sha) {
          // Lifecycle of one exact scope under the configured index key.
          const key = indexKey(loadIndexConfig().limits);
          print(scopeStatus(db, { repositoryId: values.id, sha: values.sha, indexKey: key }));
        } else {
          print(
            listBuilds(db, {
              ...(values.id ? { repositoryId: values.id } : {}),
              ...(values.sha ? { sha: values.sha } : {}),
            }),
          );
        }
        return 0;
      }
      case "coverage": {
        const report = rest[0] ? coverageReport(db, rest[0]) : undefined;
        if (!report) return fail(`Unknown build ${rest[0] ?? "(missing build id)"}`);
        print(values.excluded ? report : { ...report, excluded: undefined });
        return 0;
      }
      case "search": {
        const [buildId, ...words] = rest;
        if (!buildId || words.length === 0) return fail("search needs a build id and a query");
        const limit = values.limit ? Number(values.limit) : 10;
        print(
          searchChunks(db, { buildId, query: words.join(" "), limit }).map((hit) => ({
            path: hit.path,
            startLine: hit.startLine,
            endLine: hit.endLine,
            symbols: hit.symbols,
            score: hit.score,
          })),
        );
        return 0;
      }
      case "retrieve":
        return await retrieve(db, values, rest.join(" "));
      case "ask":
        return await ask(db, values, rest.join(" "));
      case "cancel": {
        const buildId = rest[0];
        if (!buildId) return fail("cancel needs a build id");
        const changed = finishUnsuccessfully(db, buildId, {
          state: "cancelled",
          code: "cancelled",
          message: "Cancelled from the command line",
          retryable: true,
        });
        print({ buildId, cancelled: changed });
        return changed ? 0 : 1;
      }
      default:
        return fail(`Unknown command ${command}\n${USAGE}`);
    }
  } finally {
    db.close();
  }
}

function openService(
  db: ReturnType<typeof openDatabase>,
  repositories: (id: string) => string | undefined,
): IndexService {
  const config = loadIndexConfig();
  return new IndexService({
    db,
    repositories,
    limits: config.limits,
    maxConcurrentBuilds: config.maxConcurrentBuilds,
    retention: config.retention,
  });
}

async function index(
  db: ReturnType<typeof openDatabase>,
  values: {
    repo?: string | undefined;
    id?: string | undefined;
    sha?: string | undefined;
    rebuild?: boolean | undefined;
  },
): Promise<number> {
  if (!values.repo || !values.sha) return fail("index needs --repo and --sha");
  const directory = resolve(values.repo);
  const repositoryId = values.id ?? basename(directory);
  const sha = values.sha;
  return runToCompletion(db, repositoryId, directory, (service) =>
    service.startBuild({ repositoryId, sha }, { rebuild: values.rebuild ?? false }),
  );
}

async function retry(
  db: ReturnType<typeof openDatabase>,
  buildId: string | undefined,
  repo: string | undefined,
): Promise<number> {
  if (!buildId || !repo) return fail("retry needs a build id and --repo");
  const build = getBuild(db, buildId);
  if (!build) return fail(`Unknown build ${buildId}`);
  return runToCompletion(db, build.repositoryId, resolve(repo), (service) =>
    service.retry(buildId),
  );
}

/** Start or join a build for one repository, wait for it and print its coverage. */
async function runToCompletion(
  db: ReturnType<typeof openDatabase>,
  repositoryId: string,
  directory: string,
  start: (service: IndexService) => Promise<StartBuildResult>,
): Promise<number> {
  const service = openService(db, (id) => (id === repositoryId ? directory : undefined));
  const interrupt = () => void service.close();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const started = await start(service);
    if (started.state === "unsupported_revision") return fail(started.message);
    let build = started.build;
    if (started.state === "building") {
      const timer = setInterval(() => {
        const current = service.status(build.id);
        if (current)
          console.error(`${current.phase}: ${current.filesDone}/${current.filesTotal} files`);
      }, 2_000);
      try {
        build = await service.waitForBuild(build.id);
      } finally {
        clearInterval(timer);
      }
    }
    const report = coverageReport(db, build.id)!;
    print({ ...report, excluded: undefined });
    return build.state === "ready" ? 0 : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    await service.close();
  }
}

/**
 * Run Fast or Deep evidence research for a question against the ready index
 * of exactly one commit, with the same guarded session ask_project uses. No
 * model is called. Prints the evidence bundle, its trace and usage.
 */
async function retrieve(
  db: ReturnType<typeof openDatabase>,
  values: {
    repo?: string | undefined;
    id?: string | undefined;
    sha?: string | undefined;
    mode?: string | undefined;
    text?: boolean | undefined;
  },
  question: string,
): Promise<number> {
  if (!values.repo || !values.sha) return fail("retrieve needs --repo and --sha");
  if (question.trim().length === 0) return fail("retrieve needs a question");
  const mode = values.mode ?? DEFAULT_MODE;
  if (!isMode(mode)) return fail(`--mode must be fast or deep, got ${mode}`);
  const directory = resolve(values.repo);
  const repositoryId = values.id ?? basename(directory);
  const build = findReadyBuild(db, {
    repositoryId,
    sha: values.sha,
    indexKey: indexKey(loadIndexConfig().limits),
  });
  if (!build) {
    return fail(`No ready index for ${repositoryId}@${values.sha}; run \`looky index\` first`);
  }
  const askConfig = loadAskConfig();
  const context: LookyRequestContext = {
    clientId: "looky-cli",
    clientGeneration: "cli",
    callerId: "cli",
    repositoryId,
    sha: values.sha,
    worktree: { state: "unknown" },
  };
  const controller = new AbortController();
  const session = new GuardedSession({
    question,
    mode,
    budget: askConfig.budgets[mode],
    signal: controller.signal,
    context,
    generation: { generationId: build.id, sha: build.sha },
    adapter: {
      resolveContext: async () => context,
      authorize: async () => ({ allowed: true }),
    },
    retriever: new IndexRetriever({ db }),
    sourceReader: new GitSourceReader((id) => (id === repositoryId ? directory : undefined)),
    provider: {
      id: "none",
      complete: async () => {
        throw new LookyUnavailableError("retrieve does not call a model");
      },
    },
    now: Date.now,
    startedAt: Date.now(),
  });
  try {
    const bundle = await researchEvidence(session, { limits: loadResearchConfig() });
    print({
      ...bundle,
      evidence: bundle.evidence.map((item) =>
        values.text ? item : { ...item, text: undefined, lines: item.endLine - item.startLine + 1 },
      ),
    });
    return 0;
  } finally {
    session.close();
  }
}

/**
 * Answer a question with the configured provider against the ready index of
 * exactly one commit, through the same ask_project path clients use. Prints
 * the typed response. Ctrl-C cancels the request.
 */
async function ask(
  db: ReturnType<typeof openDatabase>,
  values: {
    repo?: string | undefined;
    id?: string | undefined;
    sha?: string | undefined;
    mode?: string | undefined;
  },
  question: string,
): Promise<number> {
  if (!values.repo || !values.sha) return fail("ask needs --repo and --sha");
  const mode = values.mode ?? DEFAULT_MODE;
  if (!isMode(mode)) return fail(`--mode must be fast or deep, got ${mode}`);
  const provider = createConfiguredProvider();
  if (!provider) return fail("ask needs a model provider; set LOOKY_PROVIDER (see README)");
  const directory = resolve(values.repo);
  const repositoryId = values.id ?? basename(directory);
  const build = findReadyBuild(db, {
    repositoryId,
    sha: values.sha,
    indexKey: indexKey(loadIndexConfig().limits),
  });
  if (!build) {
    return fail(`No ready index for ${repositoryId}@${values.sha}; run \`looky index\` first`);
  }
  const context: LookyRequestContext = {
    clientId: "looky-cli",
    clientGeneration: "cli",
    callerId: "cli",
    repositoryId,
    sha: values.sha,
    worktree: { state: "unknown" },
  };
  const controller = new AbortController();
  const interrupt = () => controller.abort(new Error("Interrupted"));
  process.once("SIGINT", interrupt);
  try {
    const response = await askProject(
      { question, mode },
      { resolveContext: async () => context, authorize: async () => ({ allowed: true }) },
      {
        config: loadAskConfig(),
        catalog: {
          resolve: async () => ({
            state: "ready",
            generation: { generationId: build.id, sha: build.sha },
          }),
        },
        retriever: new IndexRetriever({ db }),
        sourceReader: new GitSourceReader((id) => (id === repositoryId ? directory : undefined)),
        provider,
        engine: new LookyAnswerEngine({
          ...loadAnswerConfig(),
          research: loadResearchConfig(),
        }),
      },
      { signal: controller.signal },
    );
    print(response);
    return response.status === "answered" ? 0 : 1;
  } finally {
    process.off("SIGINT", interrupt);
  }
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error("looky:", error instanceof Error ? error.message : error);
  return 1;
});
