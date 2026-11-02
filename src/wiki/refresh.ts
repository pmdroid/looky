/**
 * Incremental wiki refresh: what changed since the repository's last
 * published wiki, and whether an earlier page body may be carried forward.
 *
 * Reuse is never assumed. A page keeps earlier prose only when
 *
 * 1. its sha-neutral input key is identical: plan text, planned sources with
 *    their blobs, structural scope, link neighbourhood, planner version and
 *    writer fingerprint;
 * 2. the earlier page recorded which blobs it read, and every one of them,
 *    and every cited blob, is the blob indexed at the new commit;
 * 3. its commit label and any commit-pinned source links can be rewritten to
 *    the new commit with no trace of the old one left; and
 * 4. for navigation pages, every child and linked page was reused as well.
 *
 * Anything that cannot be established is regenerated.
 */
import type { Database } from "bun:sqlite";
import {
  WIKI_CHANGE_LIST_LIMIT,
  type WikiPathChanges,
  type WikiPlan,
  type WikiRefreshMode,
  type WikiRefreshReport,
} from "./model";
import { wikiGenerationFiles } from "./store";

/** The latest published generation of a repository, retired or not, while it is stored. */
export function latestPublishedWikiGeneration(
  db: Database,
  repositoryId: string,
): { readonly id: string; readonly sha: string } | undefined {
  return (
    db
      .query<{ id: string; sha: string }, [string]>(
        `SELECT id, sha FROM wiki_generations WHERE repository_id = ? AND state = 'ready'
         ORDER BY finished_at DESC, rowid DESC LIMIT 1`,
      )
      .get(repositoryId) ?? undefined
  );
}

/** Path → blob of the indexed files of one index build. */
export function indexedFiles(db: Database, buildId: string): Map<string, string> {
  return new Map(
    db
      .query<{ path: string; blob_oid: string }, [string]>(
        "SELECT path, blob_oid FROM index_files WHERE build_id = ? AND status = 'indexed'",
      )
      .all(buildId)
      .map((row) => [row.path, row.blob_oid]),
  );
}

/**
 * Added, changed, deleted and renamed paths between two file manifests. A
 * deleted path whose exact blob appears at an added path is a rename; each
 * blob pairs at most once, in path order.
 */
export function diffManifests(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): WikiPathChanges {
  const added: string[] = [];
  const changed: string[] = [];
  const deleted: string[] = [];
  for (const [path, blob] of after) {
    const old = before.get(path);
    if (old === undefined) added.push(path);
    else if (old !== blob) changed.push(path);
  }
  for (const path of before.keys()) if (!after.has(path)) deleted.push(path);
  added.sort(compare);
  changed.sort(compare);
  deleted.sort(compare);
  const addedByBlob = new Map<string, string[]>();
  for (const path of added) {
    const blob = after.get(path)!;
    addedByBlob.set(blob, [...(addedByBlob.get(blob) ?? []), path]);
  }
  const renamed: { from: string; to: string }[] = [];
  const renamedFrom = new Set<string>();
  const renamedTo = new Set<string>();
  for (const path of deleted) {
    const candidates = addedByBlob.get(before.get(path)!);
    const to = candidates?.shift();
    if (to === undefined) continue;
    renamed.push({ from: path, to });
    renamedFrom.add(path);
    renamedTo.add(to);
  }
  const finalAdded = added.filter((path) => !renamedTo.has(path));
  const finalDeleted = deleted.filter((path) => !renamedFrom.has(path));
  return {
    added: finalAdded.length,
    changed: changed.length,
    deleted: finalDeleted.length,
    renamed: renamed.length,
    paths: {
      added: finalAdded.slice(0, WIKI_CHANGE_LIST_LIMIT),
      changed: changed.slice(0, WIKI_CHANGE_LIST_LIMIT),
      deleted: finalDeleted.slice(0, WIKI_CHANGE_LIST_LIMIT),
      renamed: renamed.slice(0, WIKI_CHANGE_LIST_LIMIT),
    },
  };
}

/**
 * The refresh report of a new plan: its base generation, the indexed paths
 * that changed since the base commit and the base pages the plan drops.
 */
export function wikiRefreshReport(
  db: Database,
  plan: WikiPlan,
  options: { readonly rebuild?: boolean } = {},
): WikiRefreshReport {
  const base = latestPublishedWikiGeneration(db, plan.repositoryId);
  if (!base) {
    return {
      mode: options.rebuild ? "rebuild" : "initial",
      base: null,
      changes: null,
      removedPages: [],
    };
  }
  const mode: WikiRefreshMode = options.rebuild ? "rebuild" : "refresh";
  const planned = new Set(plan.pages.map((page) => page.pageId));
  const removedPages = db
    .query<{ page_id: string; slug: string; title: string }, [string]>(
      "SELECT page_id, slug, title FROM wiki_pages WHERE generation_id = ? ORDER BY slug",
    )
    .all(base.id)
    .filter((page) => !planned.has(page.page_id))
    .map((page) => ({ pageId: page.page_id, slug: page.slug, title: page.title }));
  const before = wikiGenerationFiles(db, base.id);
  if (before.size === 0) {
    return {
      mode,
      base: { generationId: base.id, sha: base.sha },
      baseUnavailable:
        "The base generation has no file manifest, so changed paths are unknown; no page is reused",
      changes: null,
      removedPages,
    };
  }
  return {
    mode,
    base: { generationId: base.id, sha: base.sha },
    changes: diffManifests(before, indexedFiles(db, plan.indexBuildId)),
    removedPages,
  };
}

// ---------------------------------------------------------------------------
// Commit relabelling

const FOOTER = /Generated from commit `([0-9a-f]{12})`/g;
const CARRIED = /\n\n\*Carried forward unchanged from commit `[0-9a-f]{12}`[^\n]*\*$/;

/**
 * Rewrite a body written at `fromSha` for `toSha`, after the caller verified
 * that every blob behind it is identical at `toSha`. Commit-pinned source
 * links and the commit label are rewritten and a note records where the prose
 * came from. Returns undefined when any trace of the old commit would remain,
 * so the page is written again instead of being mislabelled.
 */
export function relabelWikiBody(
  body: string,
  fromSha: string,
  toSha: string,
  verifiedBlobs: number,
): string | undefined {
  if (fromSha === toSha) return body;
  const short = fromSha.slice(0, 12);
  const footers = [...body.matchAll(FOOTER)];
  if (footers.length !== 1 || footers[0]![1] !== short) return undefined;
  const relabelled = body
    .replace(CARRIED, "")
    .split(fromSha)
    .join(toSha)
    .replace(FOOTER, `Generated from commit \`${toSha.slice(0, 12)}\``);
  if (relabelled.includes(short)) return undefined;
  return (
    `${relabelled}\n\n*Carried forward unchanged from commit \`${short}\`: all ` +
    `${verifiedBlobs} source file${verifiedBlobs === 1 ? "" : "s"} it was written from ` +
    "are byte-identical at this commit, so its citations were checked rather than assumed.*"
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
