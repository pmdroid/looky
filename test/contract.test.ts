import { describe, expect, test } from "bun:test";
import { budgetEnvName, loadAskConfig } from "../src/config";
import {
  BUDGET_FIELDS,
  DEFAULT_BUDGETS,
  tightenBudget,
  validateBudgets,
} from "../src/contract/budgets";
import { checkContext, isFullCommitSha } from "../src/contract/context";
import { parseAskProjectInput } from "../src/contract/input";
import { makeContext, SHA_A } from "./support/ask-fakes";

describe("ask_project input", () => {
  test("defaults to fast and accepts explicit deep", () => {
    expect(parseAskProjectInput({ question: "How does recovery work?" })).toEqual({
      ok: true,
      input: { question: "How does recovery work?", mode: "fast" },
    });
    expect(parseAskProjectInput({ question: " q ", mode: "deep" })).toEqual({
      ok: true,
      input: { question: "q", mode: "deep" },
    });
  });

  test("rejects empty, oversized and malformed questions", () => {
    expect(parseAskProjectInput({ question: "   " })).toMatchObject({ code: "question_empty" });
    expect(parseAskProjectInput({})).toMatchObject({ code: "question_missing" });
    expect(parseAskProjectInput({ question: 4 })).toMatchObject({ code: "question_missing" });
    expect(
      parseAskProjectInput({ question: "x".repeat(11) }, { maxQuestionChars: 10 }),
    ).toMatchObject({ code: "question_too_long" });
    expect(parseAskProjectInput(null)).toMatchObject({ code: "not_an_object" });
    expect(parseAskProjectInput(["q"])).toMatchObject({ code: "not_an_object" });
    expect(parseAskProjectInput({ question: "q", mode: "turbo" })).toMatchObject({
      code: "invalid_mode",
    });
  });

  test("refuses repository, revision or scope arguments instead of ignoring them", () => {
    for (const key of ["repository", "repositoryId", "sha", "ref", "clientId", "snapshotId"]) {
      const result = parseAskProjectInput({ question: "q", [key]: "other" });
      expect(result).toMatchObject({ ok: false, code: "unexpected_argument" });
    }
  });
});

describe("request context", () => {
  test("accepts only full lowercase commit SHAs", () => {
    expect(isFullCommitSha(SHA_A)).toBe(true);
    expect(isFullCommitSha("c".repeat(64))).toBe(true);
    for (const bad of ["main", "HEAD", "abc1234", SHA_A.toUpperCase(), `${SHA_A}0`]) {
      expect(isFullCommitSha(bad)).toBe(false);
      expect(checkContext(makeContext({ sha: bad }))?.kind).toBe("unsupported_revision");
    }
  });

  test("fails closed on missing identity fields", () => {
    expect(checkContext(makeContext())).toBeUndefined();
    expect(checkContext(makeContext({ repositoryId: " " }))?.kind).toBe("invalid_context");
    expect(checkContext(makeContext({ callerId: "" }))?.kind).toBe("invalid_context");
    expect(checkContext(makeContext({ snapshotId: "" }))?.kind).toBe("invalid_context");
  });
});

describe("mode budgets", () => {
  test("defaults are finite and Deep is strictly larger for multi-step research", () => {
    validateBudgets(DEFAULT_BUDGETS);
    for (const field of BUDGET_FIELDS) {
      expect(Number.isFinite(DEFAULT_BUDGETS.fast[field])).toBe(true);
      expect(DEFAULT_BUDGETS.deep[field]).toBeGreaterThan(DEFAULT_BUDGETS.fast[field]);
    }
  });

  test("configuration overrides limits through LOOKY_* variables", () => {
    expect(budgetEnvName("deep", "maxSourceBytes")).toBe("LOOKY_DEEP_MAX_SOURCE_BYTES");
    const config = loadAskConfig({
      LOOKY_FAST_MAX_SOURCE_READS: "3",
      LOOKY_DEEP_MAX_ELAPSED_MS: "60000",
      LOOKY_MAX_QUESTION_CHARS: "500",
      LOOKY_INDEX_RETRY_AFTER_MS: "1000",
    });
    expect(config.budgets.fast.maxSourceReads).toBe(3);
    expect(config.budgets.deep.maxElapsedMs).toBe(60_000);
    expect(config.budgets.fast.maxModelCalls).toBe(DEFAULT_BUDGETS.fast.maxModelCalls);
    expect(config.maxQuestionChars).toBe(500);
    expect(config.indexRetryAfterMs).toBe(1000);
    expect(loadAskConfig({})).toMatchObject({ budgets: DEFAULT_BUDGETS });
  });

  test("rejects invalid or unbounded configuration", () => {
    for (const value of ["0", "-1", "1.5", "abc", "", "Infinity"]) {
      expect(() => loadAskConfig({ LOOKY_FAST_MAX_MODEL_CALLS: value })).toThrow(
        "LOOKY_FAST_MAX_MODEL_CALLS must be a positive integer",
      );
    }
    expect(() => loadAskConfig({ LOOKY_FAST_MAX_SOURCE_READS: "1000" })).toThrow(
      "deep.maxSourceReads must not be smaller than fast.maxSourceReads",
    );
    expect(() => loadAskConfig({ LOOKY_DEEP_MAX_RETRIEVAL_PASSES: "2" })).toThrow(
      "deep.maxRetrievalPasses must exceed fast.maxRetrievalPasses",
    );
  });

  test("client adapters can only tighten limits", () => {
    const tightened = tightenBudget(DEFAULT_BUDGETS.fast, {
      maxSourceReads: 2,
      maxModelCalls: 1_000,
    });
    expect(tightened.maxSourceReads).toBe(2);
    expect(tightened.maxModelCalls).toBe(DEFAULT_BUDGETS.fast.maxModelCalls);
    expect(() => tightenBudget(DEFAULT_BUDGETS.fast, { maxSourceReads: 0 })).toThrow();
  });
});

describe("documented budgets", () => {
  test("README budget table matches the enforced defaults and variable names", async () => {
    const readme = await Bun.file(new URL("../README.md", import.meta.url)).text();
    const table = readme.split("<!-- budgets:start -->")[1]?.split("<!-- budgets:end -->")[0] ?? "";
    for (const field of BUDGET_FIELDS) {
      const row = table.split("\n").find((line) => line.includes(`\`${field}\``));
      const cells = row?.split("|").map((cell) => cell.trim());
      expect(cells?.slice(2, 5)).toEqual([
        String(DEFAULT_BUDGETS.fast[field]),
        String(DEFAULT_BUDGETS.deep[field]),
        `\`${budgetEnvName("fast", field)}\``,
      ]);
    }
  });
});
