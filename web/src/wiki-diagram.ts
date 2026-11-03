import type { WikiIndexView, WikiPageMeta } from "./api";

export const NODE_WIDTH = 168;
export const NODE_HEIGHT = 36;
const GAP_X = 20;
const GAP_Y = 64;

export interface DiagramNode {
  readonly pageId: string;
  readonly slug: string;
  readonly title: string;
  readonly ready: boolean;
  readonly focus: boolean;
  readonly x: number;
  readonly y: number;
}

export interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface Diagram {
  readonly kind: "modules" | "module" | "workflow";
  readonly nodes: readonly DiagramNode[];
  readonly edges: readonly DiagramEdge[];
  readonly width: number;
  readonly height: number;
}

type Arrow = readonly [from: string, to: string];

export function structureDiagram(index: WikiIndexView, pageId: string): Diagram | undefined {
  const byId = new Map(index.pages.map((page) => [page.pageId, page]));
  const page = byId.get(pageId);
  if (!page) return undefined;
  const modules = new Set(
    index.pages.filter((item) => item.kind === "module").map((item) => item.pageId),
  );
  const imports: Arrow[] = index.links
    .filter((link) => link.relation === "uses")
    .filter((link) => modules.has(link.fromPageId) && modules.has(link.toPageId))
    .filter((link) => link.fromPageId !== link.toPageId)
    .map((link) => [link.fromPageId, link.toPageId]);

  const pick = (): { kind: Diagram["kind"]; ids: Set<string>; arrows: Arrow[] } | undefined => {
    const holdsModules = index.pages.some(
      (item) => item.parentPageId === pageId && item.kind === "module",
    );
    if (page.kind === "overview" || page.kind === "architecture" || holdsModules) {
      return { kind: "modules", ids: new Set(imports.flat()), arrows: imports };
    }
    if (page.kind === "module") {
      const arrows = imports.filter(([from, to]) => from === pageId || to === pageId);
      return { kind: "module", ids: new Set([pageId, ...arrows.flat()]), arrows };
    }
    if (page.kind === "workflow") {
      const ids = new Set(
        index.links
          .filter((link) => link.fromPageId === pageId && modules.has(link.toPageId))
          .map((link) => link.toPageId),
      );
      return {
        kind: "workflow",
        ids,
        arrows: imports.filter(([from, to]) => ids.has(from) && ids.has(to)),
      };
    }
    return undefined;
  };

  const picked = pick();
  if (!picked || picked.ids.size < 2 || picked.arrows.length === 0) return undefined;
  return layout(
    picked.kind,
    [...picked.ids].map((id) => byId.get(id)!),
    picked.arrows,
    pageId,
  );
}

function layers(ids: readonly string[], arrows: readonly Arrow[]): Map<string, number> {
  const out = new Map<string, string[]>();
  for (const [from, to] of arrows) out.set(from, [...(out.get(from) ?? []), to]);
  const depth = new Map<string, number>();
  const visiting = new Set<string>();
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const below = (out.get(id) ?? []).map((to) => visit(to) + 1);
    visiting.delete(id);
    const value = Math.max(0, ...below);
    depth.set(id, value);
    return value;
  };
  for (const id of ids) visit(id);
  return depth;
}

function layout(
  kind: Diagram["kind"],
  pages: readonly WikiPageMeta[],
  arrows: readonly Arrow[],
  focusId: string,
): Diagram {
  const depth = layers(
    pages.map((page) => page.pageId),
    arrows,
  );
  const top = Math.max(...depth.values());
  const rows: WikiPageMeta[][] = Array.from({ length: top + 1 }, () => []);
  for (const page of pages) rows[top - depth.get(page.pageId)!]!.push(page);
  for (const row of rows) row.sort((a, b) => a.title.localeCompare(b.title));
  const widest = Math.max(...rows.map((row) => row.length));
  const width = widest * NODE_WIDTH + (widest - 1) * GAP_X;
  const height = rows.length * NODE_HEIGHT + (rows.length - 1) * GAP_Y;

  const nodes = new Map<string, DiagramNode>();
  rows.forEach((row, at) => {
    const rowWidth = row.length * NODE_WIDTH + (row.length - 1) * GAP_X;
    row.forEach((page, column) => {
      nodes.set(page.pageId, {
        pageId: page.pageId,
        slug: page.slug,
        title: page.title,
        ready: page.state === "ready",
        focus: page.pageId === focusId,
        x: (width - rowWidth) / 2 + column * (NODE_WIDTH + GAP_X),
        y: at * (NODE_HEIGHT + GAP_Y),
      });
    });
  });

  const edges = arrows.map(([fromId, toId]) => {
    const from = nodes.get(fromId)!;
    const to = nodes.get(toId)!;
    const down = to.y > from.y;
    return {
      from: from.slug,
      to: to.slug,
      x1: from.x + NODE_WIDTH / 2,
      y1: down ? from.y + NODE_HEIGHT : from.y,
      x2: to.x + NODE_WIDTH / 2,
      y2: down ? to.y : to.y + NODE_HEIGHT,
    };
  });
  return { kind, nodes: [...nodes.values()], edges, width, height };
}
