/**
 * Looky's HTTP service: the MCP endpoint for agents and a small operational
 * API for client adapters.
 *
 *   GET    /healthz                    liveness and protocol versions, no auth
 *   POST   /mcp                        MCP Streamable HTTP (JSON responses), session token
 *   DELETE /mcp                        end an MCP connection, session token
 *
 *   Client adapter API, client token and `Looky-Protocol-Version` header:
 *   GET    /v1/service                 ownership, storage location, host and capacity
 *   POST   /v1/sessions                register a task session (idempotent), prewarm its index
 *   GET    /v1/sessions/:id            session and its index status
 *   DELETE /v1/sessions/:id            revoke a session
 *   GET    /v1/index?repositoryId&sha  index status of a repository and SHA
 *   POST   /v1/index/rebuild           full rebuild of a repository and SHA
 *   GET    /v1/builds/:id              one build with progress and failure
 *   POST   /v1/builds/:id/retry        new attempt after a failure
 *   POST   /v1/builds/:id/cancel       cancel a queued or running build
 */
import type { LookyAskConfig } from "../config";
import { clientForToken, type ClientConfig, type ServerConfig } from "../service/config";
import {
  LOOKY_PROTOCOL_VERSION,
  LOOKY_VERSION,
  OperationError,
  SUPPORTED_PROTOCOL_VERSIONS,
  type LookyService,
} from "../service/looky-service";
import { RegistrationError, type SessionRecord } from "../service/sessions";
import { lookyToolHost, McpConnection, MCP_PROTOCOL_VERSIONS, PARSE_ERROR } from "./protocol";

export const PROTOCOL_HEADER = "looky-protocol-version";
const MCP_SESSION_HEADER = "mcp-session-id";
/** MCP connections kept per Looky session; the least recently used is dropped beyond this. */
const MAX_CONNECTIONS_PER_SESSION = 16;
const CONNECTION_IDLE_MS = 60 * 60 * 1000;
/** Bun's longest idle timeout, above the Deep budget plus the index and admission waits. */
const IDLE_TIMEOUT_SECONDS = 255;
const MAX_BODY_BYTES = 1024 * 1024;

export interface HttpServerOptions {
  readonly service: LookyService;
  readonly config: Pick<ServerConfig, "host" | "port" | "clients" | "allowedOrigins">;
  readonly askConfig: Pick<LookyAskConfig, "maxQuestionChars">;
}

export interface RunningHttpServer {
  readonly url: string;
  stop(): Promise<void>;
}

interface Connection {
  readonly id: string;
  readonly sessionId: string;
  readonly mcp: McpConnection;
  lastUsed: number;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function startHttpServer(options: HttpServerOptions): RunningHttpServer {
  const { service, config } = options;
  const connections = new Map<string, Connection>();

  function bearer(request: Request): string {
    const header = request.headers.get("authorization") ?? "";
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) throw new HttpError(401, "unauthorized", "A bearer token is required");
    return match[1]!;
  }

  function client(request: Request): ClientConfig {
    const found = clientForToken(config.clients, bearer(request));
    if (!found) throw new HttpError(401, "unauthorized", "Unknown client token");
    const version = request.headers.get(PROTOCOL_HEADER);
    if (version === null || !SUPPORTED_PROTOCOL_VERSIONS.includes(version)) {
      throw new HttpError(
        400,
        "unsupported_protocol_version",
        `Send ${PROTOCOL_HEADER} with one of: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
      );
    }
    return found;
  }

  function session(request: Request): SessionRecord {
    // Ended sessions still connect, so their tool calls get a typed denial.
    const found = service.sessions.fromToken(bearer(request));
    if (!found) throw new HttpError(401, "unauthorized", "Unknown or invalid session token");
    return found;
  }

  function checkOrigin(request: Request): void {
    const origin = request.headers.get("origin");
    if (origin !== null && !config.allowedOrigins.includes(origin)) {
      throw new HttpError(403, "forbidden_origin", "This origin may not call Looky");
    }
  }

  function connectionFor(request: Request, record: SessionRecord, initialize: boolean): Connection {
    const now = Date.now();
    for (const [id, item] of connections) {
      if (now - item.lastUsed > CONNECTION_IDLE_MS) {
        item.mcp.abortAll("MCP connection expired");
        connections.delete(id);
      }
    }
    const requested = request.headers.get(MCP_SESSION_HEADER);
    if (requested !== null && !initialize) {
      const existing = connections.get(requested);
      if (!existing || existing.sessionId !== record.id) {
        throw new HttpError(404, "mcp_session_not_found", "Unknown MCP session; initialize again");
      }
      existing.lastUsed = now;
      return existing;
    }
    const owned = [...connections.values()]
      .filter((item) => item.sessionId === record.id)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    if (!initialize) {
      // Stateless clients that never sent a session id share one connection per session.
      const shared = owned.find((item) => item.id === `${record.id}:default`);
      if (shared) {
        shared.lastUsed = now;
        return shared;
      }
    }
    while (owned.length >= MAX_CONNECTIONS_PER_SESSION) {
      const oldest = owned.shift()!;
      oldest.mcp.abortAll("MCP connection replaced");
      connections.delete(oldest.id);
    }
    const principal = service.principalFor(record, clientOf(record));
    const created: Connection = {
      id: initialize ? crypto.randomUUID() : `${record.id}:default`,
      sessionId: record.id,
      mcp: new McpConnection(lookyToolHost(service, options.askConfig, async () => principal)),
      lastUsed: now,
    };
    connections.set(created.id, created);
    return created;
  }

  function clientOf(record: SessionRecord): ClientConfig | undefined {
    return config.clients.get(record.clientId);
  }

  async function readJson(request: Request): Promise<unknown> {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > MAX_BODY_BYTES) throw new HttpError(413, "too_large", "Request body is too large");
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES)
      throw new HttpError(413, "too_large", "Request body is too large");
    if (text.trim() === "") return {};
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new HttpError(400, "invalid_json", "Request body is not valid JSON");
    }
  }

  async function mcp(request: Request): Promise<Response> {
    checkOrigin(request);
    const record = session(request);
    if (request.method === "DELETE") {
      const id = request.headers.get(MCP_SESSION_HEADER);
      const existing = id === null ? undefined : connections.get(id);
      if (existing && existing.sessionId === record.id) {
        existing.mcp.abortAll("MCP connection closed");
        connections.delete(existing.id);
      }
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST, DELETE" } });
    }
    let body: unknown;
    try {
      body = await readJson(request);
    } catch (failure) {
      if (failure instanceof HttpError && failure.code === "invalid_json") {
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Parse error" } },
          { status: 400 },
        );
      }
      throw failure;
    }
    const messages = Array.isArray(body) ? body : [body];
    const initialize = messages.some(
      (message) => (message as { method?: unknown } | null)?.method === "initialize",
    );
    const connection = connectionFor(request, record, initialize);
    const responses = (
      await Promise.all(messages.map((message) => connection.mcp.handle(message, request.signal)))
    ).filter((response) => response !== undefined);
    const headers: Record<string, string> = {};
    if (initialize) headers[MCP_SESSION_HEADER] = connection.id;
    if (responses.length === 0) return new Response(null, { status: 202, headers });
    return Response.json(Array.isArray(body) ? responses : responses[0], { headers });
  }

  async function api(request: Request, url: URL): Promise<Response> {
    checkOrigin(request);
    const caller = client(request);
    const parts = url.pathname.split("/").filter(Boolean).slice(1);
    const method = request.method;
    const [resource, id, action] = parts;

    if (resource === "service" && parts.length === 1 && method === "GET") {
      return Response.json(service.info(caller));
    }
    if (resource === "sessions" && parts.length === 1 && method === "POST") {
      const result = await service.registerSession(caller, await readJson(request));
      return Response.json(result, { status: result.created ? 201 : 200 });
    }
    if (resource === "sessions" && id && parts.length === 2) {
      if (method === "DELETE") {
        const revoked = service.revokeSession(caller, id);
        return Response.json({ id: revoked.id, state: revoked.state });
      }
      if (method === "GET") {
        const found = service.sessions.get(id);
        if (!found || found.clientId !== caller.id) {
          throw new OperationError("not_found", `No session ${id} for client ${caller.id}`);
        }
        const { repositoryId, sha } = found.registration;
        return Response.json({
          id: found.id,
          state: service.sessions.check(found).allowed ? "active" : found.state,
          expiresAt: new Date(found.expiresAt).toISOString(),
          taskId: found.registration.taskId,
          sequence: found.registration.sequence,
          index: service.status(caller, { repositoryId, sha }),
        });
      }
    }
    if (resource === "index" && parts.length === 1 && method === "GET") {
      return Response.json(service.status(caller, scopeFrom(url.searchParams)));
    }
    if (resource === "index" && id === "rebuild" && parts.length === 2 && method === "POST") {
      return Response.json(await service.rebuild(caller, scopeFrom(await readJson(request))));
    }
    if (resource === "builds" && id) {
      if (parts.length === 2 && method === "GET") return Response.json(service.build(caller, id));
      if (action === "retry" && method === "POST") {
        return Response.json(await service.retry(caller, id));
      }
      if (action === "cancel" && method === "POST") {
        return Response.json(service.cancelBuild(caller, id));
      }
    }
    throw new HttpError(404, "not_found", `No route ${method} ${url.pathname}`);
  }

  const server = Bun.serve({
    hostname: config.host,
    port: config.port,
    idleTimeout: IDLE_TIMEOUT_SECONDS,
    async fetch(request) {
      const url = new URL(request.url);
      try {
        if (url.pathname === "/healthz" && request.method === "GET") {
          return Response.json({
            ok: true,
            name: "looky",
            version: LOOKY_VERSION,
            protocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
            mcpProtocolVersions: MCP_PROTOCOL_VERSIONS,
          });
        }
        if (url.pathname === "/mcp") return await mcp(request);
        if (url.pathname.startsWith("/v1/")) return await api(request, url);
        throw new HttpError(404, "not_found", `No route ${request.method} ${url.pathname}`);
      } catch (failure) {
        return errorResponse(failure);
      }
    },
  });

  return {
    url: `http://${config.host.includes(":") ? `[${config.host}]` : config.host}:${server.port}`,
    async stop() {
      for (const connection of connections.values()) connection.mcp.abortAll("Looky is stopping");
      connections.clear();
      await server.stop(true);
    },
  };
}

function scopeFrom(source: unknown): { repositoryId: string; sha: string } {
  const get = (name: string): unknown =>
    source instanceof URLSearchParams
      ? (source.get(name) ?? undefined)
      : (source as Record<string, unknown> | null)?.[name];
  const repositoryId = get("repositoryId");
  const sha = get("sha");
  if (typeof repositoryId !== "string" || typeof sha !== "string" || !repositoryId || !sha) {
    throw new HttpError(400, "invalid_request", "repositoryId and sha are required");
  }
  return { repositoryId, sha };
}

const REGISTRATION_STATUS: Record<RegistrationError["code"], number> = {
  invalid_registration: 400,
  unsupported_revision: 422,
  repository_not_authorized: 403,
  stale_session: 409,
  conflict: 409,
};

const OPERATION_STATUS: Record<OperationError["code"], number> = {
  invalid: 422,
  forbidden: 403,
  not_found: 404,
};

function errorResponse(failure: unknown): Response {
  if (failure instanceof HttpError) {
    return Response.json(
      { error: { code: failure.code, message: failure.message } },
      { status: failure.status },
    );
  }
  if (failure instanceof RegistrationError) {
    return Response.json(
      { error: { code: failure.code, message: failure.message } },
      { status: REGISTRATION_STATUS[failure.code] },
    );
  }
  if (failure instanceof OperationError) {
    return Response.json(
      { error: { code: failure.code, message: failure.message } },
      { status: OPERATION_STATUS[failure.code] },
    );
  }
  console.error("looky: request failed:", failure instanceof Error ? failure.message : failure);
  return Response.json(
    { error: { code: "internal_error", message: "Looky could not handle the request" } },
    { status: 500 },
  );
}

export { LOOKY_PROTOCOL_VERSION };
