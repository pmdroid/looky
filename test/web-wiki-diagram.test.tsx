import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { WikiIndexView, WikiPageKind, WikiPageMeta } from "../web/src/api";
import { structureDiagram } from "../web/src/wiki-diagram";
import { WikiDiagram } from "../web/src/WikiDiagram";

function page(slug: string, kind: WikiPageKind, parent: string | null = null): WikiPageMeta {
  return {
    pageId: `pg_${slug}`,
    slug,
    title: slug,
    kind,
    description: "",
    parentPageId: parent === null ? null : `pg_${parent}`,
    depth: 0,
    ordinal: 0,
    scopePath: null,
    state: "ready",
    unavailableReason: null,
  };
}

const uses = (from: string, to: string) => ({
  fromPageId: `pg_${from}`,
  toPageId: `pg_${to}`,
  relation: "uses" as const,
});

const index = {
  pages: [
    page("overview", "overview"),
    page("architecture", "architecture", "overview"),
    page("modules", "section", "overview"),
    page("modules/core", "module", "modules"),
    page("modules/db", "module", "modules"),
    page("modules/loop", "module", "modules"),
    page("modules/web", "module", "modules"),
    page("modules/lone", "module", "modules"),
    page("workflows/run", "workflow"),
  ],
  links: [
    uses("modules/db", "modules/core"),
    uses("modules/loop", "modules/db"),
    uses("modules/loop", "modules/core"),
    uses("modules/web", "modules/db"),
    uses("architecture", "modules/core"),
    uses("workflows/run", "modules/loop"),
    uses("workflows/run", "modules/db"),
  ],
} as unknown as WikiIndexView;

const slugs = (diagram: ReturnType<typeof structureDiagram>) =>
  diagram?.nodes.map((node) => node.slug).sort();
const arrows = (diagram: ReturnType<typeof structureDiagram>) =>
  diagram?.edges.map((edge) => `${edge.from}>${edge.to}`).sort();

describe("structure diagrams", () => {
  test("overview, architecture and the modules section show every module and their imports", () => {
    expect(slugs(structureDiagram(index, "pg_overview"))).toHaveLength(4);
    expect(slugs(structureDiagram(index, "pg_modules"))).toHaveLength(4);
    const diagram = structureDiagram(index, "pg_architecture");
    expect(slugs(diagram)).toEqual(["modules/core", "modules/db", "modules/loop", "modules/web"]);
    expect(arrows(diagram)).toEqual([
      "modules/db>modules/core",
      "modules/loop>modules/core",
      "modules/loop>modules/db",
      "modules/web>modules/db",
    ]);
  });

  test("the module overview leaves out modules without imports either way", () => {
    expect(slugs(structureDiagram(index, "pg_architecture"))).not.toContain("modules/lone");
  });

  test("a module page shows what it imports and what imports it", () => {
    const diagram = structureDiagram(index, "pg_modules/db");
    expect(slugs(diagram)).toEqual(["modules/core", "modules/db", "modules/loop", "modules/web"]);
    expect(arrows(diagram)).toEqual([
      "modules/db>modules/core",
      "modules/loop>modules/db",
      "modules/web>modules/db",
    ]);
    expect(diagram?.nodes.find((node) => node.focus)?.slug).toBe("modules/db");
  });

  test("a workflow page shows the modules it reaches and their imports", () => {
    const diagram = structureDiagram(index, "pg_workflows/run");
    expect(slugs(diagram)).toEqual(["modules/db", "modules/loop"]);
    expect(arrows(diagram)).toEqual(["modules/loop>modules/db"]);
  });

  test("an importer sits above what it imports", () => {
    const diagram = structureDiagram(index, "pg_architecture")!;
    const y = (slug: string) => diagram.nodes.find((node) => node.slug === slug)!.y;
    expect(y("modules/loop")).toBeLessThan(y("modules/db"));
    expect(y("modules/db")).toBeLessThan(y("modules/core"));
    expect(y("modules/web")).toBeLessThan(y("modules/db"));
  });

  test("an import cycle still lays out", () => {
    const cyclic = {
      ...index,
      links: [...index.links, uses("modules/core", "modules/loop")],
    } as WikiIndexView;
    expect(structureDiagram(cyclic, "pg_architecture")?.nodes).toHaveLength(4);
  });

  test("pages without import structure get no diagram", () => {
    expect(structureDiagram(index, "pg_modules/web")?.nodes).toHaveLength(2);
    const lonely = { ...index, links: [] } as unknown as WikiIndexView;
    expect(structureDiagram(lonely, "pg_modules/core")).toBeUndefined();
  });

  test("the diagram links other ready pages and needs no inline styles", () => {
    const html = renderToStaticMarkup(
      <WikiDiagram
        diagram={structureDiagram(index, "pg_modules/db")!}
        hrefFor={(slug) => `/wiki/${slug}`}
        go={() => undefined}
      />,
    );
    expect(html).toContain(`href="/wiki/modules/core"`);
    expect(html).not.toContain(`href="/wiki/modules/db"`);
    expect(html).toContain("diagram-node-focus");
    expect(html).toContain("What this module imports");
    expect(html).not.toContain("style=");
  });
});
