/**
 * The real Looky service for browser tests: `bun run src/cli.ts serve` in a
 * child process, configured only through the documented environment
 * variables, with a persistent SQLite data directory, the production browser
 * build and the scripted provider. Nothing in the service is replaced.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildWeb } from "../../web/build";
import { PROVIDER_API_KEY, type ScriptedProvider } from "./provider";
import type { Repos } from "./repos";

export const ROOT = resolve(import.meta.dir, "..", "..");
export const WEB_TOKEN = "web-e2e-browser-token-0123456789abcdef";
export const PAWS_TOKEN = "paws-e2e-agent-token-0123456789abcdef";
export const LINK_TEMPLATE =
  "https://code.example.test/{repositoryId}/blob/{sha}/{path}#L{startLine}-L{endLine}";

export type Env = Record<string, string>;

/** A temporary directory removed by `cleanup`. */
export function tempRoot(prefix: string): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/** Build the production app (minified, no source maps) into `outdir`. */
export async function buildApp(outdir: string): Promise<string> {
  await buildWeb(outdir);
  return outdir;
}

/** Documented configuration for one service with the browser adapter. */
export function serviceEnv(options: {
  readonly repos: Repos;
  readonly provider: ScriptedProvider;
  readonly assetsDir: string;
  readonly dataDir: string;
  readonly extra?: Env;
}): Env {
  const { repos } = options;
  return {
    LOOKY_HOST: "127.0.0.1",
    LOOKY_PORT: "0",
    LOOKY_DATA_DIR: options.dataDir,
    LOOKY_REPOSITORIES: "pilot,notes,vault",
    LOOKY_REPOSITORY_PILOT_PATH: repos.pilot,
    LOOKY_REPOSITORY_NOTES_PATH: repos.notes,
    LOOKY_REPOSITORY_VAULT_PATH: repos.vault,
    LOOKY_CLIENTS: "web,paws",
    LOOKY_CLIENT_WEB_TOKEN: WEB_TOKEN,
    LOOKY_CLIENT_WEB_REPOSITORIES: "pilot,notes",
    LOOKY_CLIENT_PAWS_TOKEN: PAWS_TOKEN,
    LOOKY_CLIENT_PAWS_REPOSITORIES: "*",
    LOOKY_BROWSER_CLIENT: "web",
    LOOKY_BROWSER_ASSETS_DIR: options.assetsDir,
    LOOKY_SOURCE_LINK_TEMPLATE: LINK_TEMPLATE,
    LOOKY_PROVIDER: "scripted",
    LOOKY_PROVIDER_SCRIPTED_KIND: "openai",
    LOOKY_PROVIDER_SCRIPTED_MODEL: "scripted-e2e",
    LOOKY_PROVIDER_SCRIPTED_BASE_URL: options.provider.baseUrl,
    LOOKY_PROVIDER_SCRIPTED_API_KEY: PROVIDER_API_KEY,
    // A question on an unready index returns `indexing` at once, so the page's
    // own wait-and-ask-again path is what reaches the answer.
    LOOKY_INDEX_WAIT_MS: "0",
    LOOKY_INDEX_RETRY_AFTER_MS: "1000",
    LOOKY_INDEX_MAX_FILE_BYTES: "65536",
    ...options.extra,
  };
}

export interface IndexStatus {
  readonly state: "not_indexed" | "building" | "ready" | "failed";
  readonly ready?: { readonly buildId: string; readonly sha: string };
  readonly active?: { readonly buildId: string };
}

export interface Build {
  readonly id: string;
  readonly state: string;
  readonly refresh?: { readonly mode: "full" | "incremental"; readonly reason?: string };
}

export class LookyProcess {
  readonly url: string;
  readonly #child: ReturnType<typeof Bun.spawn>;
  readonly #log: string[];

  private constructor(url: string, child: ReturnType<typeof Bun.spawn>, log: string[]) {
    this.url = url;
    this.#child = child;
    this.#log = log;
  }

  /** Start `serve` and wait until it reports its URL. */
  static async start(env: Env): Promise<LookyProcess> {
    const child = Bun.spawn(["bun", "run", join(ROOT, "src", "cli.ts"), "serve"], {
      cwd: ROOT,
      // Only what the documented configuration names, plus what Bun and Git need.
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const log: string[] = [];
    const url = await new Promise<string>((resolveUrl, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Looky did not start:\n${log.join("")}`)),
        30_000,
      );
      void (async () => {
        const decoder = new TextDecoder();
        for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
          log.push(decoder.decode(chunk));
          const match = /listening on (http:\/\/[^;\s]+);/.exec(log.join(""));
          if (match) {
            clearTimeout(timer);
            resolveUrl(match[1]!);
          }
        }
        clearTimeout(timer);
        reject(new Error(`Looky exited before listening:\n${log.join("")}`));
      })().catch(reject);
    });
    return new LookyProcess(url, child, log);
  }

  /** Everything the service wrote to stderr so far. */
  log(): string {
    return this.#log.join("");
  }

  /** Stop with SIGTERM, as an operator would, and wait for the process to exit. */
  async stop(): Promise<void> {
    if (this.#child.exitCode !== null) return;
    this.#child.kill("SIGTERM");
    const exited = await Promise.race([
      this.#child.exited,
      Bun.sleep(15_000).then(() => "timeout"),
    ]);
    if (exited === "timeout") this.#child.kill("SIGKILL");
  }

  async #operator<T>(path: string): Promise<T> {
    const response = await fetch(`${this.url}${path}`, {
      headers: { authorization: `Bearer ${PAWS_TOKEN}`, "looky-protocol-version": "1" },
    });
    if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${await response.text()}`);
    return (await response.json()) as T;
  }

  /** Index status through the operational API, as an operator sees it. */
  index(repositoryId: string, sha: string): Promise<IndexStatus> {
    return this.#operator(`/v1/index?repositoryId=${repositoryId}&sha=${sha}`);
  }

  build(id: string): Promise<Build> {
    return this.#operator(`/v1/builds/${id}`);
  }

  /** Wait until the index for this SHA is ready, through the operational API. */
  async ready(repositoryId: string, sha: string, timeoutMs = 60_000): Promise<IndexStatus> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.index(repositoryId, sha);
      if (status.state === "ready") return status;
      if (status.state === "failed") throw new Error(`Index of ${sha} failed`);
      if (Date.now() > deadline) throw new Error(`Index of ${sha} not ready`);
      await Bun.sleep(100);
    }
  }
}
