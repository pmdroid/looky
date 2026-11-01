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

/** The set of links this answer may show: its validated source links. */
export class LinkPolicy {
  readonly #allowed: ReadonlySet<string>;

  constructor(sourceLinks: readonly (string | null)[]) {
    const allowed = new Set<string>();
    for (const link of sourceLinks) {
      const safe = safeHttpUrl(link);
      if (safe) allowed.add(safe);
    }
    this.#allowed = allowed;
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
