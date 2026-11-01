/**
 * Index diagnostics and operations without direct database edits.
 *
 *   bun run looky index --repo <git-dir> --sha <commit> [--id <repository-id>] [--rebuild]
 *   bun run looky status [<build-id>] [--id <repository-id>] [--sha <commit>]
 *   bun run looky coverage <build-id> [--excluded]
 *   bun run looky search <build-id> <query> [--limit <n>]
 *   bun run looky cancel <build-id>
 *
 * Output is JSON on stdout. Data lives in LOOKY_DATA_DIR (default `.looky`).
 */
import { basename, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadIndexConfig } from "./config";
import { IndexService, progressOf } from "./indexing/index-service";
import {
  coverageReport,
  finishUnsuccessfully,
  getBuild,
  listBuilds,
  searchChunks,
} from "./indexing/store";
import { openDatabase } from "./storage/database";

const USAGE = `Usage:
  looky index --repo <git-dir> --sha <commit> [--id <repository-id>] [--rebuild]
  looky status [<build-id>] [--id <repository-id>] [--sha <commit>]
  looky coverage <build-id> [--excluded]
  looky search <build-id> <query> [--limit <n>]
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
      case "status": {
        const buildId = rest[0];
        if (buildId) {
          const build = getBuild(db, buildId);
          if (!build) return fail(`Unknown build ${buildId}`);
          print({ ...build, progress: progressOf(build) });
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
  const config = loadIndexConfig();
  const service = new IndexService({
    db,
    repositories: (id) => (id === repositoryId ? directory : undefined),
    limits: config.limits,
    maxConcurrentBuilds: config.maxConcurrentBuilds,
  });
  const interrupt = () => void service.close();
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  try {
    const started = await service.startBuild(
      { repositoryId, sha: values.sha },
      { rebuild: values.rebuild ?? false },
    );
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

function fail(message: string): number {
  console.error(message);
  return 1;
}

process.exitCode = await main(process.argv.slice(2)).catch((error: unknown) => {
  console.error("looky:", error instanceof Error ? error.message : error);
  return 1;
});
