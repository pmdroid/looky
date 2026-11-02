/**
 * Which URLs the app may turn into links. Answer and source text are
 * untrusted: a link is rendered only when Looky's browser adapter built it
 * from the configured source link template for a cited range of this answer,
 * and only for http or https. No URL is ever derived from answer text.
 */

/** The normalized URL when it is an absolute http or https URL without credentials. */
export function safeHttpUrl(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  return url.href;
}

/** A wiki slug as Looky issues them: lowercase words joined by hyphens, in `/`-separated parts. */
export const WIKI_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)*$/;

/** Links between pages of one generated wiki. */
export interface WikiLinks {
  /** Slugs of ready pages of the same generation; only these become links. */
  readonly slugs: ReadonlySet<string>;
  /** The app's own URL for a page, at the same repository and revision. */
  readonly href: (slug: string) => string;
}

/** An in-app link to a wiki page. */
export interface InternalLink {
  readonly slug: string;
  readonly href: string;
}

/**
 * The set of links this text may show: its validated source links and, for a
 * wiki page, `wiki:` links to ready pages of the same generation.
 */
export class LinkPolicy {
  readonly #allowed: ReadonlySet<string>;
  readonly #wiki: WikiLinks | undefined;

  constructor(sourceLinks: readonly (string | null)[], wiki?: WikiLinks) {
    const allowed = new Set<string>();
    for (const link of sourceLinks) {
      const safe = safeHttpUrl(link);
      if (safe) allowed.add(safe);
    }
    this.#allowed = allowed;
    this.#wiki = wiki;
  }

  /** The in-app link for a `wiki:slug` target, or undefined when it is not an allowed page. */
  internal(raw: string): InternalLink | undefined {
    if (!this.#wiki || !raw.startsWith("wiki:")) return undefined;
    const slug = raw.slice("wiki:".length);
    if (!WIKI_SLUG.test(slug) || !this.#wiki.slugs.has(slug)) return undefined;
    return { slug, href: this.#wiki.href(slug) };
  }

  /** The URL to link to, or undefined to render the link text only. */
  href(raw: string): string | undefined {
    const safe = safeHttpUrl(raw);
    return safe && this.#allowed.has(safe) ? safe : undefined;
  }

  static none(): LinkPolicy {
    return new LinkPolicy([]);
  }
}
