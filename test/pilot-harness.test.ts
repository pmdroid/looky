import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  citationProblems,
  coverage,
  parseQuestionSet,
  validatePins,
  type BlobReader,
  type PilotQuestion,
  type RetrievedEvidence,
} from "../pilot/harness";

const SHA = "a".repeat(40);
const FILES: Record<string, string> = {
  "src/recovery.ts": "line one\nexport function resume() {}\nline three\nline four\n",
};
const read: BlobReader = (sha, path) => (sha === SHA ? FILES[path] : undefined);

const question: PilotQuestion = {
  id: "q",
  category: "control flow",
  subsystem: "recovery",
  question: "How does resume work?",
  expected: "It resumes.",
  deepNeeded: false,
  evidence: [
    { path: "src/recovery.ts", startLine: 2, endLine: 2, anchor: "function resume", why: "def" },
  ],
};

function evidence(overrides: Partial<RetrievedEvidence> = {}): RetrievedEvidence {
  const text = "export function resume() {}\nline three\n";
  return {
    id: "E1",
    repositoryId: "paws-app",
    sha: SHA,
    generationId: "build_1",
    path: "src/recovery.ts",
    startLine: 2,
    endLine: 3,
    contentHash: createHash("sha256").update(text).digest("hex"),
    kind: "code",
    text,
    pass: 1,
    ...overrides,
  };
}

const expected = { repositoryId: "paws-app", sha: SHA, generationId: "build_1" };

describe("pilot harness", () => {
  test("pins must exist at the commit and contain their anchor", () => {
    expect(validatePins(read, SHA, [question])).toEqual([]);
    const moved = {
      ...question,
      evidence: [{ ...question.evidence[0]!, startLine: 3, endLine: 4 }],
    };
    expect(validatePins(read, SHA, [moved])[0]).toContain("anchor not in range");
    const missing = { ...question, evidence: [{ ...question.evidence[0]!, path: "gone.ts" }] };
    expect(validatePins(read, SHA, [missing])[0]).toContain("not tracked");
    const past = { ...question, evidence: [{ ...question.evidence[0]!, endLine: 9 }] };
    expect(validatePins(read, SHA, [past])[0]).toContain("outside the file");
  });

  test("coverage counts overlapping ranges and files separately", () => {
    expect(coverage(question.evidence, [evidence()])).toMatchObject({ rangesHit: 1, filesHit: 1 });
    const elsewhere = coverage(question.evidence, [evidence({ startLine: 3, endLine: 4 })]);
    expect(elsewhere).toMatchObject({ rangesHit: 0, filesHit: 1, missed: ["src/recovery.ts:2-2"] });
  });

  test("citations must be the exact committed text of the expected generation", () => {
    expect(citationProblems(read, expected, [evidence()])).toEqual([]);
    expect(citationProblems(read, expected, [evidence({ text: "edited\nline three\n" })])).toEqual(
      expect.arrayContaining([expect.stringContaining("text differs")]),
    );
    expect(citationProblems(read, expected, [evidence({ repositoryId: "other" })])[0]).toContain(
      "other repository",
    );
    expect(citationProblems(read, expected, [evidence({ generationId: "build_2" })])[0]).toContain(
      "other generation",
    );
    expect(citationProblems(read, expected, [evidence({ path: "gone.ts" })])[0]).toContain(
      "not tracked",
    );
  });

  test("the committed question set parses and pins every question", () => {
    const set = parseQuestionSet(
      JSON.parse(readFileSync(join(import.meta.dir, "../pilot/questions.json"), "utf8")),
    );
    expect(set.questions).toHaveLength(10);
    expect(new Set(set.questions.map((q) => q.category))).toEqual(
      new Set([
        "control flow",
        "exception path",
        "cross-file behavior",
        "configuration",
        "stale documentation",
        "unestablished rationale",
        "changed source",
      ]),
    );
    expect(set.change.question.evidence[0]!.path).toBe(set.change.rename.to);
  });
});
