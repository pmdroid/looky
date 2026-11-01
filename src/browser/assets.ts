/**
 * Built browser assets, served from one configured directory so the page and
 * `/browser/v1` share an origin. Paths are confined to that directory: dot
 * segments, dotfiles, backslashes and NUL are refused, and a path without a
 * file extension falls back to `index.html` for client-side routing. Assets
 * are static files; Looky never injects configuration or credentials into them.
 */
import { resolve, sep } from "node:path";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const HEADERS: Record<string, string> = {
  "content-security-policy": CONTENT_SECURITY_POLICY,
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
};

/** The asset for a request, or undefined when no asset matches. */
export async function serveAsset(
  directory: string,
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (request.method !== "GET" && request.method !== "HEAD") return undefined;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
  const segments = path.split("/").filter(Boolean);
  if (
    path.includes("\\") ||
    path.includes("\0") ||
    segments.some((segment) => segment.startsWith("."))
  ) {
    return undefined;
  }
  const root = resolve(directory);
  const target = resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + sep)) return undefined;

  const last = segments.at(-1) ?? "";
  let file = Bun.file(segments.length === 0 ? resolve(root, "index.html") : target);
  if (!(await file.exists())) {
    if (last.includes(".")) return undefined;
    file = Bun.file(resolve(root, "index.html"));
    if (!(await file.exists())) return undefined;
  }
  const html = file.type.startsWith("text/html");
  return new Response(request.method === "HEAD" ? null : file, {
    headers: {
      ...HEADERS,
      "content-type": file.type,
      "cache-control": html ? "no-cache" : "public, max-age=300",
    },
  });
}
