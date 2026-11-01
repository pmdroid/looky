/**
 * Build a {@link LookyService} from the environment for the `serve` and `mcp`
 * entrypoints, and the local principal the stdio entrypoint uses.
 */
import { resolve } from "node:path";
import { userInfo } from "node:os";
import { loadAskConfig, loadIndexConfig } from "../config";
import type { LookyRequestContext } from "../contract/context";
import { runGit } from "../indexing/git-snapshot";
import { createConfiguredProvider } from "../providers/config";
import { openDatabase } from "../storage/database";
import type { CapacityConfig, RepositoryConfig } from "./config";
import { LookyService, type Principal } from "./looky-service";

type Env = Record<string, string | undefined>;

export function dataDirFrom(env: Env = process.env): string {
  const configured = env.LOOKY_DATA_DIR ?? ".looky";
  if (!configured.trim()) throw new Error("LOOKY_DATA_DIR must not be empty");
  return resolve(configured);
}

export function createLookyService(options: {
  readonly repositories: ReadonlyMap<string, RepositoryConfig>;
  readonly capacity: CapacityConfig;
  readonly env?: Env;
}): LookyService {
  const env = options.env ?? process.env;
  const dataDir = dataDirFrom(env);
  // Validate everything before opening storage, so a bad setting changes nothing.
  const ask = loadAskConfig(env);
  const index = loadIndexConfig(env);
  const provider = createConfiguredProvider(env);
  const db = openDatabase({ dataDir });
  try {
    return new LookyService({
      db,
      dataDir,
      repositories: options.repositories,
      ask,
      index,
      capacity: options.capacity,
      ...(provider ? { provider } : {}),
    });
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * The local user of a stdio connection. Each call resolves `ref` to an exact
 * commit once and pins it for that request, so new commits are picked up by
 * the next question. Uncommitted changes are never read and are disclosed as
 * unknown.
 */
export function localPrincipal(
  repository: RepositoryConfig,
  ref: string,
): (signal: AbortSignal) => Promise<Principal> {
  let user = "local";
  try {
    user = userInfo().username || user;
  } catch {
    // Some sandboxes have no passwd entry; the caller id is informational.
  }
  return async (signal) => {
    const result = await runGit(
      repository.path,
      ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`],
      signal,
    );
    const sha = new TextDecoder().decode(result.stdout).trim();
    if (result.exitCode !== 0 || sha === "") {
      throw new Error(`Could not resolve ${ref} to a commit in ${repository.id}`);
    }
    const context: LookyRequestContext = {
      clientId: "local",
      clientGeneration: "stdio",
      callerId: user,
      repositoryId: repository.id,
      sha,
      ref,
      worktree: { state: "unknown" },
    };
    return { key: `local:${repository.id}`, context, authorize: () => ({ allowed: true }) };
  };
}
