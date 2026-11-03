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

describe("wiki page prompt, shaped like a reference page", () => {
  const prompt = wikiSystemPrompt("module", 12_000);

  test("lets a section use numbered steps, short lists and tables where they fit", () => {
    expect(prompt).toContain("a numbered list for steps that happen in order");
    expect(prompt).toContain("a table for settings, states, limits or constants");
    expect(prompt).toContain("one name per item");
  });

  test("asks for the concrete values a reader needs", () => {
    expect(prompt).toContain("defaults, limits, timeouts, commands, file locations");
  });

  test("tells the model what gets a summary or reason dropped or downgraded", () => {
    expect(prompt).toContain("A summary without a citation group is dropped");
    expect(prompt).toContain("When a document in the evidence explains why");
  });

  test("keeps caveats to limits of the code, not of what was inspected", () => {
    expect(prompt).toContain("not what the evidence did or did not show");
  });
});
