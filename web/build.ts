/**
 * Build the browser app into `dist/web` (or the directory given as the first
 * argument) with Bun's own HTML bundler: one HTML entry, hashed script and
 * stylesheet files, no inline script or style, so Looky's strict CSP holds.
 *
 *   bun run web:build [outdir]
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";

export const WEB_ENTRY = resolve(import.meta.dir, "index.html");
export const DEFAULT_WEB_OUTDIR = resolve(import.meta.dir, "..", "dist", "web");

export async function buildWeb(
  outdir = DEFAULT_WEB_OUTDIR,
  options: { readonly minify?: boolean } = {},
): Promise<string[]> {
  rmSync(outdir, { recursive: true, force: true });
  const result = await Bun.build({
    entrypoints: [WEB_ENTRY],
    outdir,
    target: "browser",
    minify: options.minify ?? true,
    // Absolute asset URLs, so the page also loads under a deep path.
    publicPath: "/",
    sourcemap: options.minify === false ? "linked" : "none",
    define: {
      "process.env.NODE_ENV": JSON.stringify(
        options.minify === false ? "development" : "production",
      ),
    },
  });
  if (!result.success) {
    throw new AggregateError(result.logs, "The browser app failed to build");
  }
  return result.outputs.map((output) => output.path);
}

if (import.meta.main) {
  const outdir = resolve(process.argv[2] ?? DEFAULT_WEB_OUTDIR);
  const files = await buildWeb(outdir);
  console.error(`Built ${files.length} files into ${outdir}`);
}
