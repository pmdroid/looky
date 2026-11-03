import { describe, expect, test } from "bun:test";
import { wikiSystemPrompt } from "../src/wiki/prompts";

describe("wiki page prompt", () => {
  const prompt = wikiSystemPrompt("module", 12_000);

  test("asks for plain explanation before code names, with few names per paragraph", () => {
    expect(prompt).toContain("new to this codebase");
    expect(prompt).toContain("at most about two names per paragraph");
    expect(prompt).not.toContain("Name functions, types and settings inline in backticks");
  });

  test("asks for one citation group per paragraph instead of one per claim", () => {
    expect(prompt).toContain("one citation group at the end of each paragraph");
    expect(prompt).not.toContain("right after the claims");
  });
});
