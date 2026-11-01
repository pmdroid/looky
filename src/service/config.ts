/**
 * Looky service configuration from `LOOKY_*` environment variables.
 *
 *   LOOKY_HOST=127.0.0.1  LOOKY_PORT=7341
 *   LOOKY_REPOSITORIES=paws-app,looky                  authorized repository ids
 *   LOOKY_REPOSITORY_<ID>_PATH=/srv/looky/paws-app.git local Git directory on this host
 *   LOOKY_REPOSITORY_<ID>_FETCH_REMOTE=origin          optional: fetch missing commits
 *   LOOKY_CLIENTS=paws                                 client adapter ids
 *   LOOKY_CLIENT_<ID>_TOKEN=…                          client adapter secret
 *   LOOKY_CLIENT_<ID>_REPOSITORIES=paws-app            repositories it may register, or *
 *   LOOKY_BROWSER_CLIENT=web                           optional: enable the browser adapter
 *   LOOKY_BROWSER_AUTH=local|token                     local needs a loopback LOOKY_HOST
 *   LOOKY_BROWSER_ORIGINS=https://looky.example.com    origins the browser page is served from
 *
 * `<ID>` is the id upper-cased with `-` as `_`.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { isAbsolute, resolve } from "node:path";

type Env = Record<string, string | undefined>;

export interface RepositoryConfig {
  readonly id: string;
  /** Local Git directory, bare or not, on the host that runs this service. */
  readonly path: string;
  /** Remote to fetch an exact missing commit from, or undefined to never fetch. */
  readonly fetchRemote?: string;
}

export interface ClientConfig {
  readonly id: string;
  /** SHA-256 of the client token. The token itself is not kept. */
  readonly tokenHash: Buffer;
  /** Repository ids the client may register sessions for, or "*" for every configured one. */
  readonly repositories: "*" | ReadonlySet<string>;
}

/** Bounded admission for questions and bounded waits for index readiness. */
export interface CapacityConfig {
  /** Questions researched and answered at once. */
  readonly maxConcurrentAsks: number;
  /** Questions waiting for a slot. Beyond this a request is refused as busy at once. */
  readonly maxQueuedAsks: number;
  /** Distinct questions one session may have in flight. Duplicates join and do not count. */
  readonly maxAsksPerSession: number;
  /** How long a question waits for a slot before it is refused as busy. */
  readonly admissionWaitMs: number;
  /** How long a request waits for its index to become ready before returning `indexing`. */
  readonly indexWaitMs: number;
  /** Session lifetime after registration. */
  readonly sessionTtlMs: number;
  /** How long a result is kept for redelivery under the same request key. */
  readonly resultTtlMs: number;
  /** Time limit for fetching a missing commit. */
  readonly fetchTimeoutMs: number;
}

export const DEFAULT_CAPACITY: CapacityConfig = {
  maxConcurrentAsks: 2,
  maxQueuedAsks: 8,
  maxAsksPerSession: 2,
  admissionWaitMs: 10_000,
  indexWaitMs: 20_000,
  sessionTtlMs: 12 * 60 * 60 * 1000,
  resultTtlMs: 10 * 60 * 1000,
  fetchTimeoutMs: 120_000,
};

const CAPACITY_ENV: Readonly<Record<keyof CapacityConfig, string>> = {
  maxConcurrentAsks: "LOOKY_MAX_CONCURRENT_ASKS",
  maxQueuedAsks: "LOOKY_MAX_QUEUED_ASKS",
  maxAsksPerSession: "LOOKY_MAX_ASKS_PER_SESSION",
  admissionWaitMs: "LOOKY_ADMISSION_WAIT_MS",
  indexWaitMs: "LOOKY_INDEX_WAIT_MS",
  sessionTtlMs: "LOOKY_SESSION_TTL_MS",
  resultTtlMs: "LOOKY_RESULT_TTL_MS",
  fetchTimeoutMs: "LOOKY_FETCH_TIMEOUT_MS",
};

export interface ServerConfig {
  readonly host: string;
  readonly port: number;
  readonly repositories: ReadonlyMap<string, RepositoryConfig>;
  readonly clients: ReadonlyMap<string, ClientConfig>;
  readonly capacity: CapacityConfig;
  /** Browser origins allowed to call the service. Empty refuses every request with an Origin. */
  readonly allowedOrigins: readonly string[];
  /** The same-origin browser adapter, or undefined when it is off. */
  readonly browser?: BrowserConfig;
}

/**
 * The browser adapter at `/browser/v1`. It acts as one configured client, so a
 * person in the browser sees only that client's repositories.
 *
 * - `local`: signing in needs no credential. Allowed only while Looky listens
 *   on a loopback address, and requests must name a loopback host.
 * - `token`: signing in needs the browser client's token, sent once and never
 *   stored by the browser. Required for any non-loopback listen address,
 *   together with an explicit https origin.
 */
export interface BrowserConfig {
  /** Configured client the browser acts as. Use a dedicated client, not an agent adapter's. */
  readonly clientId: string;
  readonly auth: "local" | "token";
  /** Origins the browser page is served from, besides the loopback origins in local operation. */
  readonly origins: readonly string[];
  /** Browser session lifetime after sign-in. */
  readonly sessionTtlMs: number;
  /** Optional directory of built browser assets, served same-origin at `/`. */
  readonly assetsDir?: string;
}

export const DEFAULT_BROWSER_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

/** Whether a listen address only accepts connections from this host. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return bare === "localhost" || bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

export function loadBrowserConfig(
  env: Env,
  host: string,
  clients: ReadonlyMap<string, ClientConfig>,
): BrowserConfig | undefined {
  const clientId = env.LOOKY_BROWSER_CLIENT?.trim();
  if (!clientId) return undefined;
  if (!clients.has(clientId)) {
    throw new Error(`LOOKY_BROWSER_CLIENT names ${clientId}, which is not in LOOKY_CLIENTS`);
  }
  const auth = env.LOOKY_BROWSER_AUTH?.trim() || "local";
  if (auth !== "local" && auth !== "token") {
    throw new Error("LOOKY_BROWSER_AUTH must be local or token");
  }
  const loopback = isLoopbackHost(host);
  if (auth === "local" && !loopback) {
    throw new Error(
      `LOOKY_BROWSER_AUTH=local only works while LOOKY_HOST is a loopback address, not ${host}; ` +
        "set LOOKY_BROWSER_AUTH=token and LOOKY_BROWSER_ORIGINS for remote use",
    );
  }
  const origins = list(env.LOOKY_BROWSER_ORIGINS);
  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`LOOKY_BROWSER_ORIGINS has ${origin}, which is not an origin`);
    }
    if (parsed.origin !== origin) {
      throw new Error(`LOOKY_BROWSER_ORIGINS has ${origin}; write it as ${parsed.origin}`);
    }
    if (parsed.protocol !== "https:" && !isLoopbackHost(parsed.hostname)) {
      throw new Error(`LOOKY_BROWSER_ORIGINS has ${origin}; remote origins must use https`);
    }
  }
  if (!loopback && origins.length === 0) {
    throw new Error("LOOKY_BROWSER_ORIGINS is required when LOOKY_HOST is not a loopback address");
  }
  const assetsDir = env.LOOKY_BROWSER_ASSETS_DIR?.trim();
  return {
    clientId,
    auth,
    origins,
    sessionTtlMs: nonNegativeInt(
      env,
      "LOOKY_BROWSER_SESSION_TTL_MS",
      DEFAULT_BROWSER_SESSION_TTL_MS,
    ),
    ...(assetsDir ? { assetsDir: isAbsolute(assetsDir) ? assetsDir : resolve(assetsDir) } : {}),
  };
}

export const DEFAULT_PORT = 7341;
const ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MIN_TOKEN_CHARS = 32;

/** `paws-app` + `PATH` -> `LOOKY_REPOSITORY_PAWS_APP_PATH`. */
export function scopedEnvName(kind: "REPOSITORY" | "CLIENT", id: string, field: string): string {
  return `LOOKY_${kind}_${id.toUpperCase().replace(/[-.]/g, "_")}_${field}`;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function nonNegativeInt(env: Env, name: string, fallback: number, allowZero = false): number {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const pattern = allowZero ? /^(?:0|[1-9][0-9]*)$/ : /^[1-9][0-9]*$/;
  if (!pattern.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Error(`${name} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return Number(raw);
}

export function hashToken(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

/** The client a bearer token belongs to, compared in constant time. */
export function clientForToken(
  clients: ReadonlyMap<string, ClientConfig>,
  token: string,
): ClientConfig | undefined {
  const hash = hashToken(token);
  let match: ClientConfig | undefined;
  for (const client of clients.values()) {
    if (timingSafeEqual(client.tokenHash, hash)) match = client;
  }
  return match;
}

export function clientMayUse(client: ClientConfig, repositoryId: string): boolean {
  return client.repositories === "*" || client.repositories.has(repositoryId);
}

export function loadCapacityConfig(env: Env = process.env): CapacityConfig {
  const values: Record<string, number> = {};
  for (const [field, name] of Object.entries(CAPACITY_ENV) as [keyof CapacityConfig, string][]) {
    // Zero disables waiting: a request returns its typed retryable result at once.
    const zeroOk =
      field === "admissionWaitMs" || field === "indexWaitMs" || field === "maxQueuedAsks";
    values[field] = nonNegativeInt(env, name, DEFAULT_CAPACITY[field], zeroOk);
  }
  return values as unknown as CapacityConfig;
}

export function loadRepositories(env: Env = process.env): Map<string, RepositoryConfig> {
  const repositories = new Map<string, RepositoryConfig>();
  for (const id of list(env.LOOKY_REPOSITORIES)) {
    if (!ID.test(id)) {
      throw new Error(
        `Repository id ${JSON.stringify(id)} must be lowercase letters, digits, ., - or _`,
      );
    }
    const pathName = scopedEnvName("REPOSITORY", id, "PATH");
    const path = env[pathName]?.trim();
    if (!path) throw new Error(`${pathName} is required`);
    const fetchRemote = env[scopedEnvName("REPOSITORY", id, "FETCH_REMOTE")]?.trim();
    if (fetchRemote !== undefined && fetchRemote !== "" && !/^[A-Za-z0-9._-]+$/.test(fetchRemote)) {
      throw new Error(`${scopedEnvName("REPOSITORY", id, "FETCH_REMOTE")} must be a remote name`);
    }
    repositories.set(id, {
      id,
      path: isAbsolute(path) ? path : resolve(path),
      ...(fetchRemote ? { fetchRemote } : {}),
    });
  }
  return repositories;
}

export function loadClients(
  env: Env,
  repositories: ReadonlyMap<string, RepositoryConfig>,
): Map<string, ClientConfig> {
  const clients = new Map<string, ClientConfig>();
  for (const id of list(env.LOOKY_CLIENTS)) {
    if (!ID.test(id)) {
      throw new Error(
        `Client id ${JSON.stringify(id)} must be lowercase letters, digits, ., - or _`,
      );
    }
    const tokenName = scopedEnvName("CLIENT", id, "TOKEN");
    const token = env[tokenName]?.trim();
    if (!token || token.length < MIN_TOKEN_CHARS) {
      throw new Error(
        `${tokenName} must be set to a secret of at least ${MIN_TOKEN_CHARS} characters`,
      );
    }
    const reposName = scopedEnvName("CLIENT", id, "REPOSITORIES");
    const allowed = list(env[reposName]);
    if (allowed.length === 0) throw new Error(`${reposName} is required (repository ids or *)`);
    let scope: "*" | Set<string>;
    if (allowed.length === 1 && allowed[0] === "*") {
      scope = "*";
    } else {
      for (const repo of allowed) {
        if (!repositories.has(repo)) {
          throw new Error(`${reposName} names ${repo}, which is not in LOOKY_REPOSITORIES`);
        }
      }
      scope = new Set(allowed);
    }
    const hash = hashToken(token);
    for (const other of clients.values()) {
      if (timingSafeEqual(other.tokenHash, hash)) {
        throw new Error(`Clients ${other.id} and ${id} share a token`);
      }
    }
    clients.set(id, { id, tokenHash: hash, repositories: scope });
  }
  return clients;
}

export function loadServerConfig(env: Env = process.env): ServerConfig {
  const repositories = loadRepositories(env);
  const port = nonNegativeInt(env, "LOOKY_PORT", DEFAULT_PORT, true);
  if (port > 65_535) throw new Error("LOOKY_PORT must be at most 65535");
  const host = env.LOOKY_HOST?.trim() || "127.0.0.1";
  const clients = loadClients(env, repositories);
  const browser = loadBrowserConfig(env, host, clients);
  return {
    host,
    port,
    repositories,
    clients,
    capacity: loadCapacityConfig(env),
    allowedOrigins: list(env.LOOKY_ALLOWED_ORIGINS),
    ...(browser ? { browser } : {}),
  };
}
