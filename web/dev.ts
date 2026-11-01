/**
 * Development loop: rebuild the browser app into `dist/web` whenever a file
 * under `web/` changes, and run `bun run serve` with that directory as
 * `LOOKY_BROWSER_ASSETS_DIR`. Reload the page after a rebuild. Every other
 * `LOOKY_*` setting comes from the environment, as for `bun run serve`.
 *
 *   LOOKY_REPOSITORIES=… LOOKY_CLIENTS=web … LOOKY_BROWSER_CLIENT=web bun run web:dev
 */
import { watch } from "node:fs";
import { resolve } from "node:path";
import { buildWeb, DEFAULT_WEB_OUTDIR } from "./build";

const outdir = process.env.LOOKY_BROWSER_ASSETS_DIR
  ? resolve(process.env.LOOKY_BROWSER_ASSETS_DIR)
  : DEFAULT_WEB_OUTDIR;

async function rebuild(): Promise<void> {
  const started = performance.now();
  try {
    await buildWeb(outdir, { minify: false });
    console.error(`web: built in ${Math.round(performance.now() - started)} ms`);
  } catch (error) {
    console.error("web: build failed:", error instanceof AggregateError ? error.errors : error);
  }
}

await rebuild();

let timer: ReturnType<typeof setTimeout> | undefined;
const watcher = watch(import.meta.dir, { recursive: true }, (_event, file) => {
  if (!file || file === "dev.ts") return;
  clearTimeout(timer);
  timer = setTimeout(() => void rebuild(), 100);
});

const server = Bun.spawn(["bun", "run", resolve(import.meta.dir, "..", "src", "cli.ts"), "serve"], {
  env: { ...process.env, LOOKY_BROWSER_ASSETS_DIR: outdir },
  stdio: ["inherit", "inherit", "inherit"],
});

function stop() {
  watcher.close();
  server.kill("SIGTERM");
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.exitCode = await server.exited;
watcher.close();
