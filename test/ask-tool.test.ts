import { describe, expect, test } from "bun:test";
import { askProjectToolDefinition, callAskProjectTool } from "../src/ask/tool";
import { makeAdapter, makeServices, SHA_A } from "./support/ask-fakes";

/** Simulate a JSON-RPC tools/call: arguments and results cross a JSON boundary. */
async function callOverJson(argumentsJson: string) {
  const { services } = makeServices();
  const result = await callAskProjectTool(JSON.parse(argumentsJson), makeAdapter(), services);
  return JSON.parse(JSON.stringify(result));
}

describe("ask_project tool", () => {
  test("definition exposes only question and mode, defaulting to fast", () => {
    const definition = askProjectToolDefinition({ maxQuestionChars: 4000 });
    expect(definition.name).toBe("ask_project");
    expect(definition.inputSchema.required).toEqual(["question"]);
    expect(Object.keys(definition.inputSchema.properties)).toEqual(["question", "mode"]);
    expect(definition.inputSchema.properties.mode).toMatchObject({
      enum: ["fast", "deep"],
      default: "fast",
    });
    expect(definition.inputSchema.additionalProperties).toBe(false);
  });

  test("Fast default round-trips through a JSON tool request and response", async () => {
    const result = await callOverJson(JSON.stringify({ question: "How does recovery work?" }));
    expect(result.isError).toBe(false);
    expect(result.structuredContent.mode).toEqual({ requested: "fast", executed: "fast" });
    expect(result.content[0].text).toBe(result.structuredContent.answer.text);
    expect(result.structuredContent.evidence[0]).toMatchObject({ path: "src/recovery.ts" });
    expect(result.structuredContent.revision.sha).toBe(SHA_A);
  });

  test("explicit Deep round-trips through a JSON tool request and response", async () => {
    const result = await callOverJson(JSON.stringify({ question: "Trace recovery", mode: "deep" }));
    expect(result.isError).toBe(false);
    expect(result.structuredContent.mode).toEqual({ requested: "deep", executed: "deep" });
  });

  test("indexing status is an error result, never answer text", async () => {
    const { services } = makeServices({
      resolution: { state: "building", buildId: "build-1", progress: { phase: "scanning" } },
    });
    const result = await callAskProjectTool({ question: "q" }, makeAdapter(), services);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toStartWith("Not answered:");
    expect(result.content[0].text).toContain("build-1");
    expect(result.structuredContent.status).toBe("indexing");
  });
});
