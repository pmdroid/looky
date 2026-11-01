import { describe, expect, test } from "bun:test";
import { chunkFile, chunkerId, identifierTerms, splitLines } from "../src/indexing/chunker";
import { DEFAULT_INDEX_LIMITS, INDEX_POLICY_VERSION } from "../src/indexing/policy";

const limits = { ...DEFAULT_INDEX_LIMITS, chunkLines: 10, chunkOverlapLines: 2, chunkBytes: 4_000 };

/** Every chunk must equal the exact original lines it claims. */
function expectFaithful(text: string, language: string, options = limits) {
  const lines = splitLines(text);
  const chunks = chunkFile(text, language, options);
  for (const chunk of chunks) {
    expect(chunk.text).toBe(lines.slice(chunk.startLine - 1, chunk.endLine).join(""));
    expect(chunk.endLine - chunk.startLine + 1).toBeLessThanOrEqual(options.chunkLines);
    expect(Buffer.byteLength(chunk.text)).toBeLessThanOrEqual(options.chunkBytes);
  }
  // Every line is covered, in order, from the first to the last.
  expect(chunks[0]?.startLine).toBe(1);
  expect(chunks.at(-1)?.endLine).toBe(lines.length);
  for (let index = 1; index < chunks.length; index += 1) {
    expect(chunks[index]!.startLine).toBeLessThanOrEqual(chunks[index - 1]!.endLine + 1);
    expect(chunks[index]!.startLine).toBeGreaterThan(chunks[index - 1]!.startLine);
  }
  return chunks;
}

describe("chunkFile", () => {
  test("splits TypeScript at top-level declarations and records their names", () => {
    const source = [
      'import { db } from "./db";',
      "",
      "/** Loads a user. */",
      "export async function getUserById(id: string) {",
      "  return db.users.find(id);",
      "}",
      "",
      "@injectable()",
      "export class UserRepository {",
      "  save() {}",
      "  remove() {}",
      "  list() {}",
      "  count() {}",
      "}",
      "",
      "export interface UserRecord { id: string }",
      "export type UserId = string;",
      "const enum Role { Admin }",
      "export default function () {}",
    ].join("\n");
    const chunks = expectFaithful(source, "typescript");
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 7],
      [8, 17],
      [18, 19],
    ]);
    // Small adjacent declarations are packed together up to the chunk bounds.
    expect(chunks.map((chunk) => chunk.symbols)).toEqual([
      ["getUserById"],
      ["UserRepository", "UserRecord", "UserId"],
      ["Role"],
    ]);
    // The doc comment and decorator stay with their declaration.
    expect(chunks[1]!.text.startsWith("@injectable()\n")).toBe(true);
  });

  test("ignores declarations inside block comments", () => {
    const source = "/*\nexport function hidden() {}\n*/\nexport const shown = 1;\n";
    const chunks = expectFaithful(source, "javascript");
    expect(chunks.flatMap((chunk) => chunk.symbols)).toEqual(["shown"]);
  });

  test("splits an oversized declaration into overlapping windows", () => {
    const body = Array.from({ length: 25 }, (_, index) => `  step${index}();`);
    const source = ["export function longFlow() {", ...body, "}", ""].join("\n");
    const chunks = expectFaithful(source, "typescript");
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 10],
      [9, 18],
      [17, 26],
      [25, 27],
    ]);
    expect(chunks[0]!.symbols).toEqual(["longFlow"]);
    expect(chunks.slice(1).flatMap((chunk) => chunk.symbols)).toEqual([]);
  });

  test("uses faithful overlapping windows for languages without a parser", () => {
    const source = Array.from(
      { length: 23 },
      (_, index) => `def handler_${index}(request):\n    return request`,
    )
      .join("\n")
      .split("\n")
      .slice(0, 23)
      .join("\n");
    const chunks = expectFaithful(source, "python");
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 10],
      [9, 18],
      [17, 23],
    ]);
    expect(chunks.every((chunk) => chunk.symbols.length === 0)).toBe(true);
  });

  test("bounds chunks by bytes as well as lines", () => {
    const line = `${"x".repeat(99)}\n`;
    const chunks = expectFaithful(line.repeat(12), "text", {
      ...limits,
      chunkBytes: 300,
      maxLineBytes: 100,
    });
    expect(chunks.every((chunk) => chunk.endLine - chunk.startLine + 1 <= 3)).toBe(true);
  });

  test("splits Markdown at headings outside code fences", () => {
    const source = "# Title\nintro\n```\n# not a heading\n```\n## Usage\nrun it\n";
    const chunks = chunkFile(source, "markdown", { ...limits, chunkLines: 4 });
    expect(chunks.map((chunk) => [chunk.startLine, chunk.endLine])).toEqual([
      [1, 4],
      [3, 5],
      [6, 7],
    ]);
  });

  test("keeps CRLF and a missing final newline exactly", () => {
    const source = "export const a = 1;\r\nexport const b = 2;";
    const chunks = expectFaithful(source, "typescript");
    expect(chunks.map((chunk) => chunk.text).join("")).toBe(source);
  });

  test("chunker ids change with the policy version, strategy and chunking limits", () => {
    expect(chunkerId("typescript", limits)).toStartWith(`ecmascript@${INDEX_POLICY_VERSION}:`);
    expect(chunkerId("go", limits)).toStartWith(`text@${INDEX_POLICY_VERSION}:`);
    expect(chunkerId("go", { ...limits, chunkLines: limits.chunkLines + 1 })).not.toBe(
      chunkerId("go", limits),
    );
    // Limits that do not change chunk output keep reuse possible.
    expect(chunkerId("go", { ...limits, maxFiles: 3 })).toBe(chunkerId("go", limits));
  });
});

describe("identifierTerms", () => {
  test("splits camelCase, PascalCase, acronyms and snake_case", () => {
    const terms = identifierTerms("getUserById parseHTTPResponse MAX_RETRY_COUNT plain").split(" ");
    expect(terms).toEqual(
      expect.arrayContaining([
        "get",
        "user",
        "by",
        "id",
        "parse",
        "http",
        "response",
        "max",
        "retry",
        "count",
      ]),
    );
    expect(terms).not.toContain("plain");
  });
});
