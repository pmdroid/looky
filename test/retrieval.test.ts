import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { askProject } from "../src/ask/ask-project";
import { AccessRevokedError, ContractViolationError, GuardedSession } from "../src/ask/session";
import { DEFAULT_BUDGETS, type ModeBudget } from "../src/contract/budgets";
import type { Mode } from "../src/contract/input";
import {
  LookyUnavailableError,
  type AnswerEngine,
  type ClientAdapter,
  type SourceReader,
} from "../src/contract/ports";
import type { IndexIdentity } from "../src/contract/response";
import { IndexService } from "../src/indexing/index-service";
import { DEFAULT_INDEX_LIMITS } from "../src/indexing/policy";
import { finishUnsuccessfully, listChunks } from "../src/indexing/store";
import { IndexRetriever } from "../src/retrieval/index-retriever";
import {
  DEFAULT_RESEARCH_LIMITS,
  evidenceRefs,
  researchEvidence,
  type EvidenceBundle,
  type ResearchLimits,
} from "../src/retrieval/research";
import { GitSourceReader, SourceRangeError } from "../src/source/git-source-reader";
import { openDatabase } from "../src/storage/database";
import { makeAdapter, makeContext, makeServices } from "./support/ask-fakes";
import { commitAll, git, initRepo, write } from "./support/git-fixture";
import { buildPilotRepo, refreshPilotRepo } from "./support/pilot-fixture";

const sha256 = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

let root: string;
let db: Database;
let service: IndexService;
const repos: Record<string, string> = {};
let sha1: string;
let sha2: string;
let gen1: IndexIdentity;
let gen2: IndexIdentity;
let otherGen: IndexIdentity;
let longGen: IndexIdentity;
let longSha: string;

async function ready(repositoryId: string, sha: string): Promise<IndexIdentity> {
  const started = await service.startBuild({ repositoryId, sha });
  if (started.state === "unsupported_revision") throw new Error(started.message);
  const build = await service.waitForBuild(started.build.id);
  expect(build.state).toBe("ready");
  return { generationId: build.id, sha: build.sha };
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "looky-retrieval-"));
  repos.pilot = join(root, "pilot");
  repos.other = join(root, "other");
  repos.long = join(root, "long");
  for (const directory of Object.values(repos)) Bun.spawnSync(["mkdir", "-p", directory]);
  db = openDatabase({ dataDir: join(root, "data") });
  service = new IndexService({
    db,
    repositories: (id) => repos[id],
    limits: DEFAULT_INDEX_LIMITS,
    executor: "inline",
  });

  sha1 = buildPilotRepo(repos.pilot);
  gen1 = await ready("pilot", sha1);
  sha2 = refreshPilotRepo(repos.pilot);
  gen2 = await ready("pilot", sha2);

  // Another repository defining the same names must never leak into pilot searches.
  initRepo(repos.other);
  write(
    repos.other,
    "src/secret-recovery.ts",
    "export async function loadCheckpoint(id: string) {\n  return OTHER_REPOSITORY_ONLY;\n}\n",
  );
  otherGen = await ready("other", commitAll(repos.other, "other"));

  // A long plain-text file chunked into overlapping windows, and a final line without a newline.
  initRepo(repos.long);
  write(
    repos.long,
    "notes/replay.txt",
    Array.from({ length: 400 }, (_, i) => `replay journal entry ${i}\n`).join(""),
  );
  write(repos.long, "src/no-newline.ts", "export const first = 1;\nexport const lastReplay = 2;");
  longSha = commitAll(repos.long, "long");
  longGen = await ready("long", longSha);
});

afterAll(async () => {
  await service.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const fakeProvider = {
  id: "fake",
  complete: async () => ({ text: "Unused.", inputTokens: 1, outputTokens: 1 }),
};

function session(options: {
  question: string;
  mode?: Mode;
  repositoryId?: string;
  sha?: string;
  generation?: IndexIdentity;
  adapter?: ClientAdapter;
  sourceReader?: SourceReader;
  budget?: Partial<ModeBudget>;
  now?: () => number;
}): GuardedSession {
  const mode = options.mode ?? "fast";
  const repositoryId = options.repositoryId ?? "pilot";
  const sha = options.sha ?? sha1;
  const context = makeContext({ repositoryId, sha });
  return new GuardedSession({
    question: options.question,
    mode,
    budget: { ...DEFAULT_BUDGETS[mode], ...options.budget },
    signal: new AbortController().signal,
    context,
    generation: options.generation ?? gen1,
    adapter: options.adapter ?? makeAdapter(context),
    retriever: new IndexRetriever({ db }),
    sourceReader: options.sourceReader ?? new GitSourceReader((id) => repos[id]),
    provider: fakeProvider,
    now: options.now ?? Date.now,
    startedAt: (options.now ?? Date.now)(),
  });
}

async function research(
  question: string,
  mode: Mode,
  extra: Partial<Parameters<typeof session>[0]> & { limits?: Partial<ResearchLimits> } = {},
): Promise<EvidenceBundle> {
  const { limits, ...rest } = extra;
  const s = session({ question, mode, ...rest });
  return researchEvidence(s, {
    limits: { ...DEFAULT_RESEARCH_LIMITS, [mode]: { ...DEFAULT_RESEARCH_LIMITS[mode], ...limits } },
    ...(rest.now ? { now: rest.now } : {}),
  });
}

const paths = (bundle: EvidenceBundle) => bundle.evidence.map((item) => item.path);

/** Evidence must be the exact committed bytes at the bundle's SHA, with matching identity. */
function expectExactEvidence(bundle: EvidenceBundle, repo: string) {
  for (const item of bundle.evidence) {
    expect(item.repositoryId).toBe(bundle.repositoryId);
    expect(item.sha).toBe(bundle.sha);
    expect(item.generationId).toBe(bundle.generationId);
    const file = git(repo, "show", `${item.sha}:${item.path}`);
    const lines = file.split("\n").map((line) => `${line}\n`);
    expect(item.text.trimEnd()).toBe(
      lines
        .slice(item.startLine - 1, item.endLine)
        .join("")
        .trimEnd(),
    );
    expect(item.contentHash).toBe(sha256(item.text));
    expect(item.blobOid).toBe(git(repo, "rev-parse", `${item.sha}:${item.path}`));
  }
}

describe("pilot question set", () => {
  const cases: {
    kind: string;
    question: string;
    expected: string[];
    /** Additional evidence Deep's larger budget must find. */
    deepAlso?: string[];
    first?: boolean;
  }[] = [
    {
      kind: "paraphrase without the function name",
      question: "How does a crashed run get resumed after the worker dies?",
      expected: ["src/recovery/recover-run.ts", "src/worker/supervisor.ts"],
    },
    {
      kind: "identifier",
      question: "What does loadCheckpoint return when nothing is stored?",
      expected: ["src/storage/checkpoints.ts"],
      first: true,
    },
    {
      kind: "identifier in another spelling",
      question: "where is load_checkpoint defined",
      expected: ["src/storage/checkpoints.ts"],
      first: true,
    },
    {
      kind: "path-specific",
      question: "What does src/worker/supervisor.ts do?",
      expected: ["src/worker/supervisor.ts"],
      first: true,
    },
    {
      kind: "configuration",
      question: "How many times is a run replayed before giving up?",
      expected: ["src/config/retry.ts"],
      deepAlso: ["config/recovery.yaml"],
    },
    {
      kind: "language without symbol extraction",
      question: "How is sales tax applied to a total?",
      expected: ["src/billing/tax.py"],
      first: true,
    },
    {
      kind: "multi-file flow",
      question:
        "Walk through what happens from a worker crash until the run is replayed from its checkpoint",
      expected: [
        "src/worker/supervisor.ts",
        "src/recovery/recover-run.ts",
        "src/storage/checkpoints.ts",
      ],
    },
  ];

  for (const mode of ["fast", "deep"] as const) {
    for (const item of cases) {
      test(`${mode}: ${item.kind}`, async () => {
        const bundle = await research(item.question, mode);
        expect(bundle.mode).toBe(mode);
        const expected = [...item.expected, ...(mode === "deep" ? (item.deepAlso ?? []) : [])];
        expect(paths(bundle)).toEqual(expect.arrayContaining(expected));
        if (item.first) expect(bundle.evidence[0]!.path).toBe(item.expected[0]!);
        expectExactEvidence(bundle, repos.pilot!);
      });
    }
  }
});

describe("Fast and Deep research", () => {
  const flow =
    "Walk through what happens from a worker crash until the run is replayed from its checkpoint";

  test("Fast is one small pass plus at most one companion lead, and never runs Deep", async () => {
    const bundle = await research(flow, "fast");
    const limits = DEFAULT_RESEARCH_LIMITS.fast;
    expect(bundle.usage.passes).toBeLessThanOrEqual(limits.maxPasses);
    expect(bundle.usage.reads).toBeLessThanOrEqual(limits.maxReads);
    expect(bundle.usage.bytes).toBeLessThanOrEqual(limits.maxReadBytes);
    const purposes = bundle.trace.filter((s) => s.type === "retrieve").map((s) => s.purpose);
    expect(purposes[0]).toBe("question");
    expect(purposes.length).toBeLessThanOrEqual(2);
    expect(purposes).not.toContain("references");
    expect(purposes).not.toContain("refine");
    expect(purposes).not.toContain("docs_check");
  });

  test("Deep follows symbols, call sites, tests, configuration and docs across files", async () => {
    const fast = await research(flow, "fast");
    const deep = await research(flow, "deep");
    expect(deep.usage.passes).toBeGreaterThan(fast.usage.passes);
    expect(deep.usage.passes).toBeLessThanOrEqual(DEFAULT_RESEARCH_LIMITS.deep.maxPasses);
    const purposes = new Set(
      deep.trace.filter((s) => s.type === "retrieve").map((step) => step.purpose),
    );
    for (const purpose of ["question", "refine", "references", "tests", "docs_check"] as const) {
      expect(purposes.has(purpose)).toBe(true);
    }
    expect(new Set(paths(deep)).size).toBeGreaterThan(new Set(paths(fast)).size);
    expect(paths(deep)).toEqual(
      expect.arrayContaining(["test/recovery.test.ts", "src/config/retry.ts", "docs/recovery.md"]),
    );
    // Evidence found by follow-up passes says why it was read.
    expect(deep.evidence.some((item) => item.pass > 1)).toBe(true);
    expectExactEvidence(deep, repos.pilot!);
  });

  test("Deep follows a definition into another file", async () => {
    const bundle = await research("What does src/worker/supervisor.ts do?", "deep");
    const definition = bundle.evidence.find(
      (item) =>
        item.reason === "definition of resumeInterruptedRun, used in src/worker/supervisor.ts",
    );
    expect(definition?.path).toBe("src/recovery/recover-run.ts");
  });

  test("docs versus code conflicts stay visible", async () => {
    const question = "How does restartFromSnapshot work?";
    const deep = await research(question, "deep");
    const docs = deep.evidence.find((item) => item.path === "docs/recovery.md")!;
    expect(docs).toBeDefined();
    expect(deep.conflicts).toContainEqual(
      expect.objectContaining({
        docsEvidenceId: docs.id,
        identifier: "restartFromSnapshot",
        finding: "not_defined_in_code",
      }),
    );
    // The code that does exist stays in the evidence next to the stale docs.
    expect(paths(deep)).toContain("src/recovery/recover-run.ts");
    expect(deep.gaps).toContain(
      "No definition of `restartFromSnapshot` was found in the index at this revision.",
    );
    const fast = await research(question, "fast");
    expect(fast.conflicts.map((conflict) => conflict.identifier)).toEqual(["restartFromSnapshot"]);
  });

  test("Fast notes docs claims it did not check", async () => {
    const bundle = await research(
      "How does a crashed run get resumed after the worker dies?",
      "fast",
    );
    expect(paths(bundle)).toContain("docs/recovery.md");
    expect(bundle.gaps.some((gap) => gap.includes("Fast did not check"))).toBe(true);
  });

  test("an unanswerable question returns a truthful evidence gap", async () => {
    for (const mode of ["fast", "deep"] as const) {
      const bundle = await research("How is GraphQL federation configured?", mode);
      expect(bundle.evidence).toEqual([]);
      expect(bundle.gaps[0]).toStartWith("No indexed source at this revision matched the question");
      expect(bundle.suggestDeep).toBe(mode === "fast");
    }
  });
});

describe("research budgets", () => {
  const question = "How does a crashed run get resumed after the worker dies?";

  test("each limit is enforced separately", async () => {
    const reads = await research(question, "deep", { limits: { maxReads: 2 } });
    expect(reads.usage.reads).toBe(2);
    expect(reads.stop).toEqual({ reason: "limit", limit: "maxReads" });

    const passes = await research(question, "deep", { limits: { maxPasses: 3 } });
    expect(passes.usage.passes).toBe(3);
    expect(passes.stop).toEqual({ reason: "limit", limit: "maxPasses" });
    expect(passes.trace.some((step) => step.type === "not_followed")).toBe(true);

    const bytes = await research(question, "deep", { limits: { maxReadBytes: 600 } });
    expect(bytes.usage.bytes).toBeLessThanOrEqual(600);
    expect(bytes.stop).toEqual({ reason: "limit", limit: "maxReadBytes" });

    const lines = await research(question, "deep", { limits: { maxReadLines: 3 } });
    for (const item of lines.evidence)
      expect(item.endLine - item.startLine + 1).toBeLessThanOrEqual(3);

    let clock = 0;
    const time = await research(question, "deep", {
      limits: { maxElapsedMs: 10 },
      now: () => (clock += 4),
    });
    expect(time.stop).toEqual({ reason: "time" });
    expect(time.gaps.at(-1)).toBe("Research stopped at the deep research time limit.");
  });

  test("research never exceeds the session's remaining mode budget", async () => {
    const bundle = await research(question, "deep", {
      budget: { maxRetrievalPasses: 2, maxSourceReads: 3, maxSourceBytes: 4096 },
    });
    expect(bundle.limits).toMatchObject({ maxPasses: 2, maxReads: 3, maxReadBytes: 4096 });
    expect(bundle.usage.passes).toBeLessThanOrEqual(2);
    expect(bundle.usage.reads).toBeLessThanOrEqual(3);
  });

  test("overlapping windows are trimmed so no line is read twice", async () => {
    const retriever = new IndexRetriever({ db });
    const hits = await retriever.search(
      { generation: longGen, repositoryId: "long", query: "replay journal entry", limit: 20 },
      new AbortController().signal,
    );
    expect(hits.filter((hit) => hit.path === "notes/replay.txt").length).toBeLessThanOrEqual(3);
    for (const [index, hit] of hits.entries()) {
      for (const other of hits.slice(0, index)) {
        const contained =
          other.path === hit.path &&
          other.startLine <= hit.startLine &&
          hit.endLine <= other.endLine;
        expect(contained).toBe(false);
      }
    }

    const bundle = await research("replay journal entry", "deep", {
      repositoryId: "long",
      sha: longSha,
      generation: longGen,
    });
    const ranges = bundle.evidence
      .filter((item) => item.path === "notes/replay.txt")
      .sort((a, b) => a.startLine - b.startLine);
    expect(ranges.length).toBeGreaterThan(1);
    for (let index = 1; index < ranges.length; index += 1) {
      expect(ranges[index]!.startLine).toBeGreaterThan(ranges[index - 1]!.endLine);
    }
    expect(bundle.trace.some((step) => step.type === "read" && step.outcome === "covered")).toBe(
      true,
    );
    expectExactEvidence(bundle, repos.long!);
  });

  test("a final line without a newline is read byte for byte", async () => {
    const bundle = await research("lastReplay", "fast", {
      repositoryId: "long",
      sha: longSha,
      generation: longGen,
    });
    const item = bundle.evidence.find((entry) => entry.path === "src/no-newline.ts")!;
    expect(item.text).toBe("export const first = 1;\nexport const lastReplay = 2;");
    const chunk = listChunks(db, longGen.generationId, { path: "src/no-newline.ts" })[0]!;
    expect(item.contentHash).toBe(chunk.contentHash);
  });
});

describe("pinning, authorization and refresh", () => {
  const question = "How does a crashed run get resumed after the worker dies?";

  test("authorization is rechecked before every pass and read", async () => {
    const context = makeContext({ repositoryId: "pilot", sha: sha1 });
    const adapter = makeAdapter(context);
    const s = session({ question, mode: "deep", adapter });
    const bundle = await researchEvidence(s);
    expect(adapter.authorizeCalls).toBe(bundle.usage.passes + bundle.usage.reads);
  });

  test("revocation mid-research stops with a denial, not a partial bundle", async () => {
    const context = makeContext({ repositoryId: "pilot", sha: sha1 });
    const adapter = makeAdapter(context);
    adapter.decide = (call) =>
      call >= 3 ? { allowed: false, reason: "revoked" } : { allowed: true };
    const s = session({ question, mode: "deep", adapter });
    await expect(researchEvidence(s)).rejects.toBeInstanceOf(AccessRevokedError);
    expect(adapter.authorizeCalls).toBe(3);
  });

  test("a refreshed revision never cites deleted or renamed paths", async () => {
    for (const mode of ["fast", "deep"] as const) {
      const bundle = await research(question, mode, { sha: sha2, generation: gen2 });
      expect(bundle.sha).toBe(sha2);
      expect(bundle.generationId).toBe(gen2.generationId);
      expect(paths(bundle)).not.toContain("src/recovery/recover-run.ts");
      expect(paths(bundle)).not.toContain("src/worker/supervisor.ts");
      expect(paths(bundle)).toContain("src/recovery/resume.ts");
      expectExactEvidence(bundle, repos.pilot!);
    }
    // The earlier generation still serves only requests pinned to its own SHA.
    const old = await research(question, "fast", { sha: sha1, generation: gen1 });
    expect(paths(old)).toContain("src/recovery/recover-run.ts");
  });

  test("the retriever refuses generations that do not match the pinned scope", async () => {
    const retriever = new IndexRetriever({ db });
    const signal = new AbortController().signal;
    const search = (generation: IndexIdentity, repositoryId = "pilot") =>
      retriever.search({ generation, repositoryId, query: "checkpoint", limit: 5 }, signal);
    await expect(search({ generationId: gen1.generationId, sha: sha2 })).rejects.toBeInstanceOf(
      ContractViolationError,
    );
    await expect(search(gen1, "other")).rejects.toBeInstanceOf(ContractViolationError);
    await expect(search({ generationId: "build_missing", sha: sha1 })).rejects.toBeInstanceOf(
      LookyUnavailableError,
    );
    for (const hit of await search(gen1)) {
      expect(hit).toMatchObject({
        generationId: gen1.generationId,
        sha: sha1,
        repositoryId: "pilot",
      });
    }
    const otherHits = await search(otherGen, "other");
    expect(otherHits.map((hit) => hit.path)).toEqual(["src/secret-recovery.ts"]);
    const pilotHits = await retriever.search(
      {
        generation: gen1,
        repositoryId: "pilot",
        query: "OTHER_REPOSITORY_ONLY loadCheckpoint",
        limit: 20,
      },
      signal,
    );
    expect(pilotHits.some((hit) => hit.preview.includes("OTHER_REPOSITORY_ONLY"))).toBe(false);
  });

  test("the session rejects hits from another revision or repository", async () => {
    const hit = {
      generationId: gen1.generationId,
      path: "src/a.ts",
      startLine: 1,
      endLine: 1,
      score: 1,
      preview: "x\n",
    };
    for (const extra of [{ sha: sha2 }, { repositoryId: "other" }]) {
      const context = makeContext({ repositoryId: "pilot", sha: sha1 });
      const s = new GuardedSession({
        question: "q",
        mode: "fast",
        budget: DEFAULT_BUDGETS.fast,
        signal: new AbortController().signal,
        context,
        generation: gen1,
        adapter: makeAdapter(context),
        retriever: { search: async () => [{ ...hit, ...extra }] },
        sourceReader: new GitSourceReader((id) => repos[id]),
        provider: fakeProvider,
        now: Date.now,
        startedAt: Date.now(),
      });
      await expect(s.retrieve("q")).rejects.toBeInstanceOf(ContractViolationError);
    }
  });

  test("a build that is no longer ready is never searched", async () => {
    initRepo(repos.other!);
    write(repos.other!, "src/later.ts", "export const laterValue = 1;\n");
    const sha = commitAll(repos.other!, "later");
    const started = await service.startBuild({ repositoryId: "other", sha });
    if (started.state !== "building") throw new Error(`unexpected ${started.state}`);
    // Mark the queued build cancelled before it publishes.
    finishUnsuccessfully(db, started.build.id, {
      state: "cancelled",
      code: "cancelled",
      message: "test",
      retryable: true,
    });
    await service.waitForBuild(started.build.id);
    const retriever = new IndexRetriever({ db });
    await expect(
      retriever.search(
        {
          generation: { generationId: started.build.id, sha },
          repositoryId: "other",
          query: "laterValue",
          limit: 5,
        },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(LookyUnavailableError);
  });

  test("source that differs from the index is never cited", async () => {
    const real = new GitSourceReader((id) => repos[id]);
    const tampered: SourceReader = {
      read: async (request, signal) => {
        const source = await real.read(request, signal);
        return { ...source, text: source.text.replace(/checkpoint/g, "CHECKPOINT") };
      },
    };
    const bundle = await research(question, "fast", { sourceReader: tampered });
    for (const item of bundle.evidence) expect(item.text).not.toContain("CHECKPOINT");
    expect(bundle.trace.some((step) => step.type === "read" && step.outcome === "mismatch")).toBe(
      true,
    );
    expect(bundle.gaps.some((gap) => gap.includes("did not match the index"))).toBe(true);

    const missing: SourceReader = {
      read: async () => {
        throw new SourceRangeError("gone");
      },
    };
    const gone = await research(question, "fast", { sourceReader: missing });
    expect(gone.evidence).toEqual([]);
    expect(gone.gaps.some((gap) => gap.includes("could not be read at this revision"))).toBe(true);
  });
});

describe("ask_project integration", () => {
  /** A minimal engine: research, then cite every evidence range. Synthesis is PAS-968. */
  const evidenceEngine: AnswerEngine = {
    async answer(s) {
      const bundle = await researchEvidence(s);
      if (bundle.evidence.length === 0) {
        return {
          text: "The indexed revision does not establish this.",
          outcome: "unknown",
          evidence: [],
        };
      }
      return {
        text: `Research found ${bundle.evidence.length} relevant source ranges.`,
        outcome: "supported",
        evidence: evidenceRefs(bundle.evidence),
        ...(s.mode === "fast" ? { suggestDeep: bundle.suggestDeep } : {}),
      };
    },
  };

  test("citations from both modes pass ask_project's read-range validation", async () => {
    for (const mode of ["fast", "deep"] as const) {
      const context = makeContext({ repositoryId: "pilot", sha: sha1 });
      const { services } = makeServices({
        engine: evidenceEngine,
        retriever: new IndexRetriever({ db }),
        sourceReader: new GitSourceReader((id) => repos[id]),
        catalog: service,
      });
      const response = await askProject(
        { question: "How does a crashed run get resumed after the worker dies?", mode },
        makeAdapter(context),
        services,
      );
      if (response.status !== "answered") throw new Error(JSON.stringify(response));
      expect(response.mode).toEqual({ requested: mode, executed: mode });
      expect(response.index).toEqual(gen1);
      expect(response.evidence.map((ref) => ref.path)).toContain("src/recovery/recover-run.ts");
      expect(response.usage.retrievalPasses).toBeLessThanOrEqual(
        DEFAULT_BUDGETS[mode].maxRetrievalPasses,
      );
    }
  });
});
