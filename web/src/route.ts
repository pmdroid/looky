/**
 * The app's URLs. Each names a view, a repository and ref, and for the wiki a
 * page and heading, so a reload, a shared link and Back/Forward all return to
 * the same place:
 *
 *   /?repo=…&ref=…                      the code question screen
 *   /wiki?repo=…&ref=…                  the wiki of that revision, from its overview
 *   /wiki/<slug>?repo=…&ref=…#<anchor>  one page, at one heading
 *
 * Slugs have no dots, so Looky's asset server answers every such path with
 * the app. Questions and answers are never part of a URL.
 */
import { WIKI_SLUG } from "./links";

export type View = "ask" | "wiki";

export interface Route {
  readonly view: View;
  readonly repo?: string;
  readonly ref?: string;
  /** Wiki page slug; none for the wiki's landing page. */
  readonly page?: string;
  /** Heading anchor on the page. */
  readonly anchor?: string;
}

const WIKI_PREFIX = "/wiki";
const ANCHOR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_CHARS = 200;

interface LocationLike {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}

function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

export function parseRoute(location: LocationLike): Route {
  const params = new URLSearchParams(location.search);
  const repo = params.get("repo") || undefined;
  const ref = params.get("ref") || undefined;
  const base = { ...(repo ? { repo } : {}), ...(ref ? { ref } : {}) };
  const path = location.pathname.replace(/\/+$/, "");
  if (path !== WIKI_PREFIX && !path.startsWith(`${WIKI_PREFIX}/`)) {
    return { view: "ask", ...base };
  }
  const rest = path.slice(WIKI_PREFIX.length + 1);
  // An unreadable slug is kept as given, so the reader can say the page does not exist.
  const page = rest ? (decode(rest) ?? rest).slice(0, MAX_SLUG_CHARS) : undefined;
  const hash = decode(location.hash.replace(/^#/, "")) ?? "";
  const anchor = page && ANCHOR.test(hash) ? hash : undefined;
  return {
    view: "wiki",
    ...base,
    ...(page ? { page } : {}),
    ...(anchor ? { anchor } : {}),
  };
}

/** Path, query and fragment for a route. */
export function routeHref(route: Route): string {
  const params = new URLSearchParams();
  if (route.repo) params.set("repo", route.repo);
  if (route.ref) params.set("ref", route.ref);
  const query = params.toString();
  let path = "/";
  if (route.view === "wiki") {
    path = WIKI_PREFIX;
    if (route.page) {
      path += `/${route.page.split("/").map(encodeURIComponent).join("/")}`;
    }
  }
  const hash = route.view === "wiki" && route.page && route.anchor ? `#${route.anchor}` : "";
  return `${path}${query ? `?${query}` : ""}${hash}`;
}

/** Whether a slug can name a page at all; others are reported missing without a request. */
export function validSlug(slug: string): boolean {
  return slug.length <= MAX_SLUG_CHARS && WIKI_SLUG.test(slug);
}

/** Same view, page and heading; the repository and ref are compared separately. */
export function samePlace(a: Route, b: Route): boolean {
  return a.view === b.view && a.page === b.page && a.anchor === b.anchor;
}
