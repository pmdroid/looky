import { describe, expect, test } from "bun:test";
import { loadResearchConfig, researchLimitEnvName } from "../src/config";
import {
  definedKeys,
  documentedIdentifiers,
  referencedIdentifiers,
} from "../src/retrieval/definitions";
import { evidenceKind } from "../src/retrieval/kinds";
import {
  analyzeQuery,
  ftsExpression,
  identifierKey,
  identifierSpellings,
  stem,
} from "../src/retrieval/query";
import {
  DEFAULT_RESEARCH_LIMITS,
  RESEARCH_LIMIT_FIELDS,
  validateResearchLimits,
} from "../src/retrieval/research";

describe("query analysis", () => {
  test("normalizes common identifier spellings to one key", () => {
    for (const spelling of [
      "getUserById",
      "GetUserById",
      "get_user_by_id",
      "GET_USER_BY_ID",
      "get-user-by-id",
    ]) {
      expect(identifierKey(spelling)).toBe("getuserbyid");
    }
    expect(identifierSpellings(["load", "checkpoint"])).toEqual([
      "loadCheckpoint",
      "LoadCheckpoint",
      "load_checkpoint",
      "LOAD_CHECKPOINT",
      "load-checkpoint",
    ]);
  });

  test("extracts identifiers, paths, fragments and concepts", () => {
    const analysis = analyzeQuery(
      "Why does `load_checkpoint()` in src/storage/checkpoints.ts return nothing for the user service?",
    );
    const keys = analysis.identifiers.map((identifier) => identifier.key);
    expect(keys).toContain("loadcheckpoint");
    expect(analysis.identifiers.find((i) => i.key === "loadcheckpoint")?.explicit).toBe(true);
    // Adjacent words name a possible compound identifier and file name.
    expect(analysis.identifiers.find((i) => i.key === "userservice")?.explicit).toBe(false);
    expect(analysis.pathFragments).toContain("user-service");
    expect(analysis.paths).toEqual(["src/storage/checkpoints.ts"]);
    const words = analysis.concepts.map((concept) => concept.word);
    expect(words).toContain("return");
    expect(words).not.toContain("the");
    expect(words).not.toContain("does");
  });

  test("stems and synonyms let paraphrases reach code words", () => {
    expect(stem("retries")).toBe("retr");
    expect(stem("resumed")).toBe("resum");
    expect(stem("loading")).toBe("load");
    const resume = analyzeQuery("how are runs resumed").concepts.find((c) => c.word === "resumed")!;
    expect(resume.prefixes).toContain("resum");
    const recover = analyzeQuery("how does recovery work").concepts.find(
      (c) => c.word === "recovery",
    )!;
    expect(recover.terms).toEqual(expect.arrayContaining(["resume", "restart", "recover"]));
  });

  test("FTS expressions quote all user text", () => {
    const expression = ftsExpression(
      analyzeQuery('ignore "quotes" NEAR(a b) col:value * OR AND -x {y} ^z'),
    )!;
    expect(expression).toBeDefined();
    for (const part of expression.split(" OR ")) expect(part).toMatch(/^"[^"]+"\*?$/);
    expect(ftsExpression(analyzeQuery("?? !! ..."))).toBeUndefined();
  });

  test("long questions produce bounded signals", () => {
    const analysis = analyzeQuery(
      Array.from({ length: 300 }, (_, i) => `word${i} someIdentifier${i} dir/file${i}.ts`).join(
        " ",
      ),
    );
    expect(analysis.concepts.length).toBeLessThanOrEqual(16);
    expect(analysis.identifiers.length).toBeLessThanOrEqual(12);
    expect(analysis.paths.length).toBeLessThanOrEqual(6);
  });
});

describe("evidence kinds", () => {
  test("classifies code, tests, config and docs", () => {
    expect(evidenceKind("src/recovery/recover-run.ts", "typescript")).toBe("code");
    expect(evidenceKind("test/recovery.test.ts", "typescript")).toBe("test");
    expect(evidenceKind("src/a.spec.js", "javascript")).toBe("test");
    expect(evidenceKind("pkg/server_test.go", "go")).toBe("test");
    expect(evidenceKind("tests/test_tax.py", "python")).toBe("test");
    expect(evidenceKind("config/recovery.yaml", "yaml")).toBe("config");
    expect(evidenceKind("package.json", "json")).toBe("config");
    expect(evidenceKind(".github/workflows/check.yml", "yaml")).toBe("config");
    expect(evidenceKind("Dockerfile", "dockerfile")).toBe("config");
    expect(evidenceKind("docs/recovery.md", "markdown")).toBe("docs");
    expect(evidenceKind("README.md", "markdown")).toBe("docs");
    expect(evidenceKind("docs/notes.txt", "text")).toBe("docs");
  });
});

describe("definition heuristics", () => {
  test("finds definitions across languages and ignores imports", () => {
    const ts = `import { loadCheckpoint, type Checkpoint } from "./checkpoints";
export async function resumeRun(id: string) {}
export const RETRY_POLICY = { max: 3 };
class Supervisor {
  async onExit(code: number): Promise<void> {
  }
}
const handler = async (event) => event;
`;
    const keys = definedKeys(ts, "code");
    for (const key of ["resumerun", "retrypolicy", "supervisor", "onexit", "handler"]) {
      expect(keys.has(key)).toBe(true);
    }
    expect(keys.has("loadcheckpoint")).toBe(false);
    expect(keys.has("checkpoint")).toBe(false);
    expect(
      definedKeys("def apply_sales_tax(total):\n    pass\n", "code").has("applysalestax"),
    ).toBe(true);
    expect(definedKeys("func (s *Server) HandleCrash() {}\n", "code").has("handlecrash")).toBe(
      true,
    );
    expect(definedKeys("retry:\n  max_attempts: 3\n", "config").has("maxattempts")).toBe(true);
    expect(definedKeys("retry:\n  max_attempts: 3\n", "code").has("maxattempts")).toBe(false);
  });

  test("references prefer repository imports and skip globals, comments and strings", () => {
    const text = `import { loadCheckpoint } from "../storage/checkpoints";
import { readFile } from "node:fs";
// Calls restartEverything() when the moon is full.
export async function resume(id: string) {
  const at = Date.now();
  setTimeout(() => {}, 5);
  log("callMeMaybe(now)");
  await loadCheckpoint(id);
  return replayFromCheckpoint(id).values();
}`;
    const references = referencedIdentifiers(text);
    expect(references[0]).toEqual({ name: "loadCheckpoint", source: "repo_import" });
    const names = references.map((reference) => reference.name);
    expect(names).toContain("replayFromCheckpoint");
    expect(names).toContain("readFile");
    for (const absent of ["Date", "setTimeout", "restartEverything", "callMeMaybe", "now"]) {
      expect(names).not.toContain(absent);
    }
  });

  test("docs identifiers include backticked and compound names", () => {
    expect(
      documentedIdentifiers("Use `restartFromSnapshot` and max_replay_attempts, not `run`."),
    ).toEqual(["restartFromSnapshot", "max_replay_attempts"]);
  });
});

describe("research limits", () => {
  test("defaults keep Deep strictly larger and inside the mode budgets", () => {
    validateResearchLimits(DEFAULT_RESEARCH_LIMITS);
    expect(DEFAULT_RESEARCH_LIMITS.deep.maxPasses).toBeGreaterThan(
      DEFAULT_RESEARCH_LIMITS.fast.maxPasses,
    );
  });

  test("environment overrides are validated", () => {
    expect(researchLimitEnvName("fast", "maxReadBytes")).toBe("LOOKY_FAST_RESEARCH_MAX_READ_BYTES");
    const limits = loadResearchConfig({ LOOKY_DEEP_RESEARCH_MAX_PASSES: "12" });
    expect(limits.deep.maxPasses).toBe(12);
    expect(limits.fast).toEqual(DEFAULT_RESEARCH_LIMITS.fast);
    expect(() => loadResearchConfig({ LOOKY_FAST_RESEARCH_MAX_READS: "0" })).toThrow();
    expect(() => loadResearchConfig({ LOOKY_FAST_RESEARCH_MAX_PASSES: "8" })).toThrow(
      "deep.maxPasses must exceed",
    );
    expect(() => loadResearchConfig({ LOOKY_FAST_RESEARCH_MAX_READS: "100" })).toThrow(
      "must not be smaller",
    );
  });
});

describe("documented research limits", () => {
  test("README table matches the enforced defaults and variable names", async () => {
    const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
    const table =
      readme.split("<!-- research-limits:start -->")[1]?.split("<!-- research-limits:end -->")[0] ??
      "";
    for (const field of RESEARCH_LIMIT_FIELDS) {
      const row = table.split("\n").find((line) => line.includes(`\`${field}\``));
      const cells = row?.split("|").map((cell) => cell.trim());
      expect(cells?.slice(2, 5)).toEqual([
        String(DEFAULT_RESEARCH_LIMITS.fast[field]),
        String(DEFAULT_RESEARCH_LIMITS.deep[field]),
        `\`${researchLimitEnvName("fast", field)}\``,
      ]);
    }
  });
});
