import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AskProjectResponse } from "../../web/src/api";
import { AnswerView } from "../../web/src/AnswerView";
import { LinkPolicy, safeHttpUrl } from "../../web/src/links";
import { Markdown, parseBlocks } from "../../web/src/markdown";

const SHA = "c0ffee".padEnd(40, "0");
const LINK = `https://code.example.com/org/repo/blob/${SHA}/src/a.ts#L3-L9`;

function md(text: string, links: readonly (string | null)[] = []): string {
  return renderToStaticMarkup(<Markdown text={text} links={new LinkPolicy(links)} />);
}

describe("markdown subset", () => {
  test("raw HTML in answer text is shown as text, never as markup", () => {
    const html = md('Hello <script>alert(1)</script> <img src=x onerror="alert(2)"> & done');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&amp; done");
  });

  test("only configured source links become links; everything else is text", () => {
    const html = md(
      [
        `Cited [src/a.ts:3-9](${LINK}).`,
        "Bad [click](javascript:alert(1)) and [data](data:text/html,hi).",
        "Untrusted [site](https://evil.example/phish) and [rel](/browser/v1/session).",
        "Credentials [x](https://user:pw@code.example.com/a).",
      ].join("\n\n"),
      [LINK],
    );
    expect(html).toContain(`<a href="${LINK}" target="_blank" rel="noopener noreferrer nofollow">`);
    expect(html.match(/<a /g)).toHaveLength(1);
    // Unlinked text may still spell a URL out, but nothing else is ever an href.
    expect(html.match(/href="([^"]*)"/g)).toEqual([`href="${LINK}"`]);
    expect(html).not.toContain("data:text");
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("/browser/v1/session");
    expect(html).toContain("click");
    expect(html).toContain("site");
  });

  test("a link policy refuses non-http protocols even when listed", () => {
    const policy = new LinkPolicy(["javascript:alert(1)", "mailto:a@b.c", "ftp://x/y", LINK]);
    expect(policy.href("javascript:alert(1)")).toBeUndefined();
    expect(policy.href("mailto:a@b.c")).toBeUndefined();
    expect(policy.href("ftp://x/y")).toBeUndefined();
    expect(policy.href(LINK)).toBe(LINK);
    expect(safeHttpUrl("  ")).toBeUndefined();
    expect(safeHttpUrl("http://localhost:7341/x")).toBe("http://localhost:7341/x");
  });

  test("paragraphs, lists, code, emphasis and headings render structurally", () => {
    const html = md(
      [
        "## Flow",
        "First **bold** and *em* with `code<b>` and snake_case_name.",
        "",
        "1. load the checkpoint",
        "2. replay events",
        "",
        "- a",
        "- b",
        "",
        "```ts",
        "const x = 1 < 2;",
        "```",
        "",
        "> quoted",
      ].join("\n"),
    );
    expect(html).toContain('<h4 dir="auto">Flow</h4>');
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>em</em>");
    expect(html).toContain("<code>code&lt;b&gt;</code>");
    expect(html).toContain("snake_case_name");
    expect(html).toContain('<ol start="1">');
    expect(html).toContain('<li dir="auto">replay events</li>');
    expect(html).toContain("<ul>");
    expect(html).toContain("const x = 1 &lt; 2;");
    expect(html).toContain("<blockquote>");
  });

  test("Unicode and right-to-left text pass through unchanged", () => {
    const text = "Überprüfung läuft — 日本語の説明 🙂 and مرحبا";
    const html = md(text);
    expect(html).toContain(text);
    expect(html).toContain('dir="auto"');
  });

  test("a pipe table renders as a scrollable table with inline markup in its cells", () => {
    const text = [
      "Waits park the job:",
      "| Reason | Poll | Backstop |",
      "| :--- | ---: | --- |",
      "| `ci` | 10 s | **45 min** |",
      "| ahead \\| queued | 30 s |",
      "",
      "After the table.",
    ].join("\n");
    expect(parseBlocks(text)).toEqual([
      { type: "paragraph", text: "Waits park the job:" },
      {
        type: "table",
        header: ["Reason", "Poll", "Backstop"],
        rows: [
          ["`ci`", "10 s", "**45 min**"],
          ["ahead \\| queued", "30 s", ""],
        ],
      },
      { type: "paragraph", text: "After the table." },
    ]);
    const html = md(text);
    expect(html).toContain('<div class="table-scroll" tabindex="0"><table>');
    expect(html).toContain('<thead><tr><th dir="auto">Reason</th>');
    expect(html).toContain('<td dir="auto"><code>ci</code></td>');
    expect(html).toContain('<td dir="auto"><strong>45 min</strong></td>');
    expect(html).toContain('<td dir="auto">ahead | queued</td>');
  });

  test("pipes without a delimiter row stay a paragraph", () => {
    expect(parseBlocks("a | b\nc | d")).toEqual([{ type: "paragraph", text: "a | b c | d" }]);
  });

  test("an unclosed fence or deep nesting does not break parsing", () => {
    expect(parseBlocks("```\nnever closed")).toEqual([{ type: "code", text: "never closed" }]);
    const deep = md(`${"> ".repeat(50)}deep`);
    expect(deep).toContain("deep");
  });
});

function answer(overrides: Record<string, unknown> = {}) {
  return {
    status: "answered",
    requestId: "req_1",
    mode: { requested: "fast", executed: "fast" },
    limitations: ["Only committed files at this revision were read."],
    answer: {
      text: `Recovery loads the newest checkpoint and replays the run ([src/a.ts:3-9](${LINK})).\n\nSecond paragraph.`,
      outcome: "partial",
      caveats: ["Inspected 2 ranges in 1 file."],
    },
    evidence: [
      { path: "src/a.ts", startLine: 3, endLine: 9, symbol: "recover", note: "defines recover" },
      { path: "docs/<b>x</b>.md", startLine: 1, endLine: 1 },
    ],
    revision: { repositoryId: "pilot", sha: SHA, ref: "main" },
    index: { generationId: "gen_1", sha: SHA },
    coverage: { indexedFiles: 12, excludedFiles: 2, excludedByReason: { secret_path: 2 } },
    scope: { source: "committed", sha: SHA, uncommittedChanges: "none" },
    suggestedMode: "deep",
    suggestedHumanQuestion: { question: "Why replay?", reason: "Not documented." },
    usage: {
      retrievalPasses: 1,
      sourceReads: 2,
      sourceBytes: 100,
      modelCalls: 1,
      inputTokens: 10,
      outputTokens: 20,
      elapsedMs: 2_500,
    },
    providers: ["scripted"],
    ...overrides,
  } as Extract<AskProjectResponse, { status: "answered" }>;
}

describe("answer view", () => {
  const snapshot = {
    question: "How does recovery work?",
    mode: "fast" as const,
    repositoryId: "pilot",
    sha: SHA,
    revisionId: "rev_1",
  };

  test("prose first, then caveats, certainty, sources pinned to the SHA, and scope", () => {
    const html = renderToStaticMarkup(
      <AnswerView
        snapshot={snapshot}
        response={answer()}
        sourceLinks={[LINK, null]}
        onDeep={() => {}}
      />,
    );
    const order = [
      "Recovery loads the newest checkpoint",
      "Second paragraph.",
      "Caveats",
      "Inspected 2 ranges in 1 file.",
      "Certainty",
      "Partly answered",
      "Why replay?",
      "Ask in Deep",
      "Sources at",
      "src/a.ts:3–9",
      "About this answer",
    ].map((text) => html.indexOf(text));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);

    expect(html).toContain(SHA);
    expect(html).toContain("Fast requested, Fast ran");
    expect(html).toContain("Committed files at this SHA only.");
    expect(html).toContain("secret path: 2");
    // The second source has no configured link: plain, escaped text.
    expect(html).toContain("docs/&lt;b&gt;x&lt;/b&gt;.md:1");
    expect(html.match(/<a /g)).toHaveLength(2);
    expect(html.match(new RegExp(`href="${LINK.replace(/[.?#/]/g, "\\$&")}"`, "g"))).toHaveLength(
      2,
    );
  });

  test("without a source link template, citations are plain path and line text", () => {
    const html = renderToStaticMarkup(
      <AnswerView
        snapshot={snapshot}
        response={answer({
          answer: { text: "Plain `src/a.ts:3-9` citation.", outcome: "supported", caveats: [] },
          suggestedMode: undefined,
          suggestedHumanQuestion: undefined,
        })}
        sourceLinks={[null, null]}
      />,
    );
    expect(html).not.toContain("<a ");
    expect(html).toContain("<code>src/a.ts:3-9</code>");
    expect(html).toContain("Supported");
    expect(html).not.toContain("Ask in Deep");
  });

  test("a link that is not among this answer's source links is not clickable", () => {
    const html = renderToStaticMarkup(
      <AnswerView
        snapshot={snapshot}
        response={answer({
          answer: {
            text: "See [the code](https://github.com/org/repo/blob/main/src/a.ts).",
            outcome: "supported",
            caveats: [],
          },
        })}
        sourceLinks={[null, null]}
      />,
    );
    expect(html).not.toContain("github.com");
    expect(html).toContain("the code");
  });
});
