/**
 * Typed client for Looky's client adapter API. A client such as Paws uses it
 * to register a session for each task generation, hand the returned session
 * token and MCP URL to its agent, forward index status, retry and rebuild,
 * and revoke the session when the task generation ends.
 *
 * It depends only on `fetch` so an adapter can vendor it. Every call sends
 * the protocol version, and {@link LookyClient.connect} refuses a service that
 * does not speak it, so an incompatible Looky is detected before use.
 */
import type { BudgetOverrides } from "../contract/budgets";
import type { WorktreeState } from "../contract/context";
import type { ProviderPolicy } from "../contract/ports";
import type { IndexProgress } from "../contract/response";

export const CLIENT_PROTOCOL_VERSION = "1";

export interface RegisterSessionRequest {
  readonly taskId: string;
  readonly sequence: number;
  readonly clientGeneration: string;
  readonly callerId: string;
  readonly repositoryId: string;
  readonly snapshotId?: string;
  readonly sha: string;
  readonly ref?: string;
  readonly worktree: WorktreeState;
  readonly providerPolicy?: ProviderPolicy;
  readonly budgetLimits?: BudgetOverrides;
}

export interface IndexStatusView {
  readonly repositoryId: string;
  readonly sha: string;
  readonly state: "not_indexed" | "building" | "ready" | "failed";
  readonly ready?: { readonly buildId: string; readonly sha: string };
  readonly active?: {
    readonly buildId: string;
    readonly state: string;
    readonly progress: IndexProgress;
  };
  readonly failure?: {
    readonly buildId: string;
    readonly code: string | null;
    readonly message: string | null;
    readonly retryable: boolean;
  };
}

export interface ServiceLocation {
  readonly host: string;
  readonly pid: number;
  readonly dataDir: string;
  readonly indexKey: string;
}

export interface RegisteredSession {
  readonly protocolVersion: string;
  readonly created: boolean;
  /** Bearer token for the agent's MCP connection. Treat as a secret. */
  readonly token: string;
  readonly session: {
    readonly id: string;
    readonly taskId: string;
    readonly sequence: number;
    readonly repositoryId: string;
    readonly sha: string;
    readonly expiresAt: string;
  };
  readonly superseded: readonly string[];
  readonly index: IndexStatusView;
  readonly service: ServiceLocation;
}

export interface ServiceInfo extends ServiceLocation {
  readonly name: string;
  readonly version: string;
  readonly protocolVersions: readonly string[];
  readonly repositories: readonly string[];
}

export class LookyClientError extends Error {
  override readonly name = "LookyClientError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface LookyClientOptions {
  /** Service base URL, such as `http://127.0.0.1:7341`. */
  readonly url: string;
  /** The client adapter's token. Never forward it to agents. */
  readonly token: string;
  readonly fetch?: typeof fetch;
}

export class LookyClient {
  readonly #base: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(options: LookyClientOptions) {
    this.#base = options.url.replace(/\/+$/, "");
    this.#token = options.token;
    this.#fetch = options.fetch ?? fetch;
  }

  /** Create a client after checking the service speaks this protocol version. */
  static async connect(options: LookyClientOptions): Promise<LookyClient> {
    const client = new LookyClient(options);
    const info = await client.service();
    if (!info.protocolVersions.includes(CLIENT_PROTOCOL_VERSION)) {
      throw new LookyClientError(
        400,
        "unsupported_protocol_version",
        `Looky at ${options.url} speaks ${info.protocolVersions.join(", ")}, not ${CLIENT_PROTOCOL_VERSION}`,
      );
    }
    return client;
  }

  /** URL the agent's MCP client connects to, with the session token as bearer. */
  get mcpUrl(): string {
    return `${this.#base}/mcp`;
  }

  service(signal?: AbortSignal): Promise<ServiceInfo> {
    return this.#call("GET", "/v1/service", undefined, signal);
  }

  /** Idempotent for the same task, sequence and payload; a higher sequence fences older ones. */
  registerSession(
    request: RegisterSessionRequest,
    signal?: AbortSignal,
  ): Promise<RegisteredSession> {
    return this.#call("POST", "/v1/sessions", request, signal);
  }

  revokeSession(sessionId: string, signal?: AbortSignal): Promise<{ id: string; state: string }> {
    return this.#call("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`, undefined, signal);
  }

  indexStatus(repositoryId: string, sha: string, signal?: AbortSignal): Promise<IndexStatusView> {
    const query = new URLSearchParams({ repositoryId, sha });
    return this.#call("GET", `/v1/index?${query.toString()}`, undefined, signal);
  }

  rebuild(repositoryId: string, sha: string, signal?: AbortSignal): Promise<IndexStatusView> {
    return this.#call("POST", "/v1/index/rebuild", { repositoryId, sha }, signal);
  }

  retry(buildId: string, signal?: AbortSignal): Promise<IndexStatusView> {
    return this.#call("POST", `/v1/builds/${encodeURIComponent(buildId)}/retry`, undefined, signal);
  }

  cancelBuild(
    buildId: string,
    signal?: AbortSignal,
  ): Promise<{ buildId: string; cancelled: boolean }> {
    return this.#call(
      "POST",
      `/v1/builds/${encodeURIComponent(buildId)}/cancel`,
      undefined,
      signal,
    );
  }

  async #call<T>(method: string, path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const response = await this.#fetch(`${this.#base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        "looky-protocol-version": CLIENT_PROTOCOL_VERSION,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    const payload = (await response.json().catch(() => undefined)) as
      | { error?: { code?: string; message?: string } }
      | undefined;
    if (!response.ok) {
      throw new LookyClientError(
        response.status,
        payload?.error?.code ?? "http_error",
        payload?.error?.message ?? `Looky returned HTTP ${response.status}`,
      );
    }
    return payload as T;
  }
}
