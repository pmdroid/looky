/**
 * The wiki reader's pure parts: URLs, the Markdown subset over sanitized page
 * bodies, link policy, status wording and controls, navigation helpers, and
 * the runner's page checks. The browser flow itself is in `e2e/wiki.e2e.ts`.
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { safeWikiMarkdown } from "../src/browser/wiki";
import { wikiHeadings } from "../src/wiki/search";
import type {
  AskProjectResponse,
  IndexView,
  QuestionView,
  SubmitBody,
  WikiGenerationView,
  WikiIndexView,
  WikiPageMeta,
  WikiStatusView,
} from "../web/src/api";
import { AskRunner, type AskSnapshot, type AskState } from "../web/src/ask-runner";
import { LinkPolicy } from "../web/src/links";
import { Markdown } from "../web/src/markdown";
import { parseRoute, routeHref, validSlug } from "../web/src/route";
import {
  breadcrumbs,
  compactCitations,
  describeCoverage,
  describeFailure,
  describeWiki,
  generationProgress,
  relatedPages,
} from "../web/src/wiki-presentation";
import { headingId } from "../web/src/WikiView";

const SHA = "a".repeat(40);

function location(href: string) {
  const url = new URL(href, "http://looky.test");
  return { pathname: url.pathname, search: url.search, hash: url.hash };
}

describe("wiki URLs", () => {
  test("a page URL names the view, repository, ref, page and heading", () => {
    const route = parseRoute(
      location("/wiki/modules/billing?repo=pilot&ref=refs%2Fheads%2Fmain#how-totals-work"),
    );
    expect(route).toEqual({
      view: "wiki",
      repo: "pilot",
      ref: "refs/heads/main",
      page: "modules/billing",
      anchor: "how-totals-work",
    });
    expect(routeHref(route)).toBe(
      "/wiki/modules/billing?repo=pilot&ref=refs%2Fheads%2Fmain#how-totals-work",
    );
  });

  test("the landing page and the question screen", () => {
    expect(parseRoute(location("/wiki?repo=pilot&ref=HEAD"))).toEqual({
      view: "wiki",
      repo: "pilot",
      ref: "HEAD",
    });
    expect(parseRoute(location("/wiki/?repo=pilot"))).toEqual({ view: "wiki", repo: "pilot" });
    expect(parseRoute(location("/?repo=pilot&ref=HEAD#question"))).toEqual({
      view: "ask",
      repo: "pilot",
      ref: "HEAD",
    });
    expect(routeHref({ view: "ask", repo: "pilot", ref: "HEAD" })).toBe("/?repo=pilot&ref=HEAD");
    // A heading needs a page; the landing page has none in its URL.
    expect(routeHref({ view: "wiki", repo: "pilot", anchor: "x" })).toBe("/wiki?repo=pilot");
  });

  test("odd input stays a missing page, never a script or another path", () => {
    const odd = parseRoute(location("/wiki/%E0%A4%A?repo=pilot"));
    expect(odd.view).toBe("wiki");
    expect(validSlug(odd.page ?? "")).toBe(false);
    const upper = parseRoute(location("/wiki/Modules/Billing"));
    expect(validSlug(upper.page ?? "")).toBe(false);
    expect(validSlug("modules/api-2")).toBe(true);
    expect(validSlug("modules/")).toBe(false);
    // Only plain anchors are kept.
    expect(parseRoute(location("/wiki/overview#<img>")).anchor).toBeUndefined();
    expect(routeHref({ view: "wiki", page: "a/b c" })).toBe("/wiki/a/b%20c");
  });
});

describe("page bodies", () => {
  const body = [
    "Billing totals invoices [src/billing.ts:1-4](https://code.test/pilot/blob/aaa/src/billing.ts#L1-L4).",
    "",
    "## How totals work",
    "",
    "It sums lines <script>alert(1)</script> and links [elsewhere](https://evil.test) and",
    "[the recovery page](wiki:workflows/recovery) and [gone](wiki:modules/gone).",
    "",
    "## How totals work",
    "",
    "![tracker](https://evil.test/pixel.png) Second section with `a <b>` code.",
    "",
    "---",
    "",
    "*Generated from commit `aaaaaaaaaaaa`.*",
  ].join("\n");
  const link = "https://code.test/pilot/blob/aaa/src/billing.ts#L1-L4";

  function render() {
    const safe = safeWikiMarkdown(
      body,
      { ready: new Map([["workflows/recovery", { pageId: "workflow:recovery", title: "R" }]]) },
      new Set([link]),
    );
    const anchors = wikiHeadings(body).map((heading) => heading.anchor);
    const links = new LinkPolicy([link], {
      slugs: new Set(["workflows/recovery"]),
      href: (slug) => `/wiki/${slug}?repo=pilot&ref=HEAD`,
    });
    return renderToStaticMarkup(
      <Markdown
        text={safe.markdown}
        links={links}
        headingBase={1}
        anchors={{ list: anchors, idFor: headingId }}
      />,
    );
  }

  test("sanitized Markdown renders as text, with only allowed links", () => {
    const html = render();
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("evil.test");
    expect(html).not.toContain("<img");
    // The cited source link opens outside; the wiki link stays in the app.
    expect(html).toContain(`href="${link}" target="_blank" rel="noopener noreferrer nofollow"`);
    expect(html).toContain(
      '<a href="/wiki/workflows/recovery?repo=pilot&amp;ref=HEAD" data-wiki-slug="workflows/recovery">the recovery page</a>',
    );
    expect(html).toContain("gone");
    expect(html).not.toContain("wiki:");
    expect(html).toContain("<hr/>");
  });

  test("headings get the ids of Looky's anchors, so search hits and the TOC land on them", () => {
    const html = render();
    expect(html).toContain('<h2 dir="auto" id="wiki-h-how-totals-work" tabindex="-1">');
    expect(html).toContain('<h2 dir="auto" id="wiki-h-how-totals-work-2" tabindex="-1">');
  });

  test("each heading gets the anchor of its own line, however the renderer reads the lines", () => {
    const tricky = [
      "Intro.",
      "",
      "- an item",
      "  ### Nested",
      "## After",
      "",
      "```",
      "## not a heading inside code",
      "```",
      "",
      "> ## quoted, not a section",
      "",
      "## Last",
    ].join("\n");
    const safe = safeWikiMarkdown(tricky, { ready: new Map() }, new Set());
    const anchors = wikiHeadings(tricky).map((heading) => heading.anchor);
    expect(anchors).toEqual(["nested", "after", "last"]);
    const html = renderToStaticMarkup(
      <Markdown
        text={safe.markdown}
        links={LinkPolicy.none()}
        headingBase={1}
        anchors={{ list: anchors, idFor: headingId }}
      />,
    );
    expect(html).toContain('id="wiki-h-nested" tabindex="-1">Nested<');
    expect(html).toContain('id="wiki-h-after" tabindex="-1">After<');
    expect(html).toContain('id="wiki-h-last" tabindex="-1">Last<');
    expect(html.match(/id="wiki-h-/g)).toHaveLength(3);
  });

  test("a wiki link is allowed only to a listed, well-formed slug", () => {
    const links = new LinkPolicy([], { slugs: new Set(["overview"]), href: (s) => `/wiki/${s}` });
    expect(links.internal("wiki:overview")).toEqual({ slug: "overview", href: "/wiki/overview" });
    expect(links.internal("wiki:modules/x")).toBeUndefined();
    expect(links.internal("wiki:../overview")).toBeUndefined();
    expect(links.internal("javascript:alert(1)")).toBeUndefined();
    expect(LinkPolicy.none().internal("wiki:overview")).toBeUndefined();
    expect(links.href("wiki:overview")).toBeUndefined();
  });
});

function generation(overrides: Partial<WikiGenerationView> = {}): WikiGenerationView {
  return {
    id: "wiki_00000000-0000-4000-8000-000000000001",
    repositoryId: "pilot",
    sha: SHA,
    state: "ready",
    pageCount: 6,
    retired: false,
    errorCode: null,
    retryable: null,
    createdAt: "2026-11-02T00:00:00.000Z",
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

function status(overrides: Partial<WikiStatusView> = {}): WikiStatusView {
  return {
    revisionId: "rev_1",
    repositoryId: "pilot",
    sha: SHA,
    state: "unavailable",
    ...overrides,
  };
}

const INDEX_READY: IndexView = { repositoryId: "pilot", sha: SHA, state: "ready" };

describe("compact citations", () => {
  const url = (path: string) => `https://code.test/blob/${SHA}/${path}`;
  const source = (path: string, startLine: number, endLine: number) => ({
    path,
    startLine,
    endLine,
    kind: "code" as const,
    link: url(path),
  });
  const citations = [source("src/a.ts", 1, 80), source("src/a.ts", 81, 118), source("src/b.ts", 5, 5)];

  test("citation groups become numbers of the page's source list, merged and in order", () => {
    const text =
      `Loads the file. ([src/a.ts:81-118](${url("src/a.ts")}))([src/a.ts:1-80](${url("src/a.ts")}), ` +
      `[src/b.ts:5](${url("src/b.ts")}))\n\nAgain ([src/a.ts:1-80](${url("src/a.ts")})).`;
    expect(compactCitations(text, citations)).toBe(
      `Loads the file. [\\[1\\]](${url("src/a.ts")})[\\[2\\]](${url("src/a.ts")})[\\[3\\]](${url("src/b.ts")})` +
        `\n\nAgain [\\[1\\]](${url("src/a.ts")}).`,
    );
  });

  test("a numbered citation renders as a short link to its source", () => {
    const html = renderToStaticMarkup(
      <Markdown
        text={compactCitations(`Loads it ([src/b.ts:5](${url("src/b.ts")})).`, citations)}
        links={new LinkPolicy([url("src/b.ts")])}
      />,
    );
    expect(html).toContain(`>[3]</a>`);
    expect(html).not.toContain("src/b.ts:5");
  });

  test("links that are not listed sources stay as written", () => {
    const text = "See ([Overview](wiki:overview)) and ([src/c.ts:1-2](https://code.test/c)).";
    expect(compactCitations(text, citations)).toBe(text);
  });
});

describe("wiki state", () => {
  test("no wiki yet: generation is offered as a button, never started", () => {
    const text = describeWiki(status(), INDEX_READY);
    expect(text.title).toBe("No wiki for this commit yet");
    expect(text.controls).toEqual([{ kind: "generate", label: "Generate wiki" }]);
    expect(text.detail).toContain("model calls");
  });

  test("indexing is a separate step from writing pages", () => {
    const text = describeWiki(status(), { ...INDEX_READY, state: "building" });
    expect(text.title).toBe("Indexing this commit");
    expect(text.detail).toContain("planned from the code index");
    const failed = describeWiki(status(), { ...INDEX_READY, state: "failed" });
    expect(failed.controls).toEqual([]);
  });

  test("a generation being written shows progress and a cancel control", () => {
    const active = generation({
      state: "running",
      pages: { ready: 2, running: 2, queued: 2 },
    });
    const text = describeWiki(status({ state: "running", active }), INDEX_READY);
    expect(text.busy).toBe(true);
    expect(text.detail).toContain("2 of 6 pages written, 2 being written");
    expect(text.controls).toEqual([
      { kind: "cancel", label: "Cancel generation", generationId: active.id },
    ]);
    expect(generationProgress(active)).toMatchObject({ done: 2, total: 6 });
  });

  test("failed and cancelled generations are retried only from a button", () => {
    const failed = generation({ state: "failed", errorCode: "budget_exhausted", retryable: true });
    const text = describeWiki(status({ state: "failed", latest: failed }), INDEX_READY);
    expect(text.title).toBe("Wiki generation failed");
    expect(text.detail).toContain("budget");
    expect(text.detail).toContain("Nothing is retried automatically");
    expect(text.controls).toEqual([
      { kind: "retry", label: "Try generation again", generationId: failed.id },
    ]);
    const final = generation({ state: "failed", errorCode: "access_revoked", retryable: false });
    expect(describeWiki(status({ latest: final }), INDEX_READY).controls).toEqual([]);
    const cancelled = describeWiki(
      status({ state: "cancelled", latest: generation({ state: "cancelled" }) }),
      INDEX_READY,
    );
    expect(cancelled.title).toBe("Wiki generation was cancelled");
    expect(cancelled.controls.map((c) => c.kind)).toEqual(["retry"]);
    expect(describeFailure("unavailable")).toContain("provider");
    expect(describeFailure("something_new")).toContain("something new");
  });

  test("a ready wiki needs no controls; a wiki of another commit is offered explicitly", () => {
    expect(
      describeWiki(status({ state: "ready", ready: generation() }), INDEX_READY),
    ).toMatchObject({ tone: "success", controls: [] });
    const other = "b".repeat(40);
    const text = describeWiki(
      status({ stale: { generation: generation({ sha: other }), reasons: ["revision"] } }),
      INDEX_READY,
    );
    expect(text.controls).toContainEqual({
      kind: "select",
      label: `Read the wiki of ${other.slice(0, 12)}`,
      sha: other,
    });
  });
});

function meta(pageId: string, parentPageId: string | null, extra: Partial<WikiPageMeta> = {}) {
  return {
    pageId,
    slug: pageId.replace(":", "/"),
    title: pageId,
    kind: "module",
    description: "",
    parentPageId,
    depth: 0,
    ordinal: 0,
    scopePath: null,
    state: "ready",
    unavailableReason: null,
    ...extra,
  } satisfies WikiPageMeta;
}

describe("navigation", () => {
  const pages = [
    meta("overview", null, { kind: "overview" }),
    meta("modules", "overview", { kind: "section" }),
    meta("module:billing", "modules", { ordinal: 1 }),
    meta("module:api", "modules", { ordinal: 0 }),
    meta("module:empty", "modules", { ordinal: 2, state: "unavailable" }),
    meta("workflow:checkout", "overview", { kind: "workflow" }),
  ];
  const index = {
    revisionId: "rev_1",
    generation: generation(),
    notice: "",
    toc: {
      pageId: "overview",
      slug: "overview",
      title: "Overview",
      kind: "overview",
      state: "ready",
      unavailableReason: null,
      description: "",
      children: [],
    },
    pages,
    truncated: false,
    links: [
      { fromPageId: "module:billing", toPageId: "module:api", relation: "uses" as const },
      { fromPageId: "workflow:checkout", toPageId: "module:billing", relation: "uses" as const },
      { fromPageId: "module:billing", toPageId: "module:empty", relation: "related" as const },
    ],
    report: {
      coverage: {
        indexedFiles: 40,
        coveredFiles: 31,
        excludedFiles: 3,
        modules: { found: 5, planned: 3 },
        workflows: { found: 1, planned: 1 },
      },
      disclosures: [{ message: "2 modules were left out at the module limit." }],
    },
  } satisfies WikiIndexView;

  test("breadcrumbs run from the overview to the page", () => {
    expect(breadcrumbs(pages, "module:billing").map((page) => page.pageId)).toEqual([
      "overview",
      "modules",
      "module:billing",
    ]);
    const cyclic = [meta("a", "b"), meta("b", "a")];
    expect(breadcrumbs(cyclic, "a").map((page) => page.pageId)).toEqual(["b", "a"]);
  });

  test("related pages are ready pages only: children, uses and used by", () => {
    expect(relatedPages(index, "modules").map((item) => [item.relation, item.page.pageId])).toEqual(
      [
        ["child", "module:api"],
        ["child", "module:billing"],
      ],
    );
    expect(
      relatedPages(index, "module:billing").map((item) => [item.relation, item.page.pageId]),
    ).toEqual([
      ["uses", "module:api"],
      ["used_by", "workflow:checkout"],
    ]);
  });

  test("coverage says what the wiki covers and what it left out", () => {
    const coverage = describeCoverage(index);
    expect(coverage.lines).toEqual([
      "31 indexed files of 40 fall within a page.",
      "3 of 5 modules and 1 of 1 workflow have pages.",
      "3 tracked files were excluded from the index.",
      "5 of 6 planned pages have generated text.",
    ]);
    expect(coverage.disclosures).toEqual(["2 modules were left out at the module limit."]);
  });
});

describe("page questions in the runner", () => {
  const page = {
    generationId: generation().id,
    pageId: "module:billing",
    slug: "modules/billing",
    title: "Billing",
  };
  const snapshot: AskSnapshot = {
    question: "Which tests cover this?",
    mode: "deep",
    repositoryId: "pilot",
    sha: SHA,
    revisionId: "rev_1",
    wikiPage: page,
  };

  function answered(): AskProjectResponse {
    return {
      status: "answered",
      revision: { repositoryId: "pilot", sha: SHA },
      index: { sha: SHA },
    } as unknown as AskProjectResponse;
  }

  async function run(
    asked: AskSnapshot,
    wikiPage: QuestionView["wikiPage"],
  ): Promise<{ state: AskState; bodies: SubmitBody[] }> {
    const bodies: SubmitBody[] = [];
    const states: AskState[] = [];
    const runner = new AskRunner({
      api: {
        async submit(body) {
          bodies.push(body);
          return {
            id: "q_1",
            clientRequestId: body.clientRequestId,
            revisionId: "rev_1",
            repositoryId: "pilot",
            sha: SHA,
            mode: body.mode,
            state: "completed",
            submittedAt: "",
            response: answered(),
            ...(wikiPage ? { wikiPage } : {}),
          };
        },
        observe: () => Promise.reject(new Error("not polled")),
        cancel: () => Promise.reject(new Error("not cancelled")),
        revision: () => Promise.reject(new Error("not indexed")),
      },
      onState: (state) => states.push(state),
    });
    runner.ask(asked);
    for (let i = 0; i < 50 && runner.active; i += 1) await Bun.sleep(1);
    return { state: states.at(-1)!, bodies };
  }

  test("a page question names its page and accepts only an answer about it", async () => {
    const { state, bodies } = await run(snapshot, { ...page, sha: SHA });
    expect(bodies[0]?.wikiPage).toEqual({ generationId: page.generationId, pageId: page.pageId });
    expect(bodies[0]?.mode).toBe("deep");
    expect(state.kind).toBe("result");
  });

  test("an answer about another page or commit is never shown", async () => {
    const other = await run(snapshot, { ...page, pageId: "module:api", sha: SHA });
    expect(other.state).toMatchObject({ kind: "error", code: "mismatch" });
    const commit = await run(snapshot, { ...page, sha: "c".repeat(40) });
    expect(commit.state).toMatchObject({ kind: "error", code: "mismatch" });
    const missing = await run(snapshot, undefined);
    expect(missing.state).toMatchObject({ kind: "error", code: "mismatch" });
  });

  test("an ordinary question sends no page and refuses a page answer", async () => {
    const { wikiPage: _, ...plain } = snapshot;
    const ok = await run(plain, undefined);
    expect(ok.bodies[0]).not.toHaveProperty("wikiPage");
    expect(ok.state.kind).toBe("result");
    const paged = await run(plain, { ...page, sha: SHA });
    expect(paged.state).toMatchObject({ kind: "error", code: "mismatch" });
  });
});
