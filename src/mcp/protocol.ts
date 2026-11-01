/**
 * Minimal Model Context Protocol server over JSON-RPC 2.0, shared by the
 * stdio and HTTP transports. It implements what a tool server needs:
 * `initialize`, `ping`, `tools/list`, `tools/call` and the
 * `notifications/cancelled` notification, which detaches the cancelled call.
 */
import { askProjectToolDefinition, toToolResult } from "../ask/tool";
import type { LookyAskConfig } from "../config";
import type { LookyService, Principal } from "../service/looky-service";
import { LOOKY_VERSION } from "../service/looky-service";

/** MCP revisions this server speaks, newest first. */
export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

/** `tools/call` `_meta` key carrying the caller's stable request identity. */
export const REQUEST_KEY_META = "looky/requestKey";
const MAX_REQUEST_KEY_CHARS = 200;

export type JsonRpcId = string | number;

export interface JsonRpcResponse {
  readonly jsonrpc: "2.0";
  readonly id: JsonRpcId | null;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

export const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
}

export interface ToolResult {
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
  readonly structuredContent?: unknown;
  readonly isError: boolean;
}

export interface ToolCall {
  readonly signal: AbortSignal;
  readonly requestKey?: string;
}

/** The tools one MCP connection may call, already bound to its principal. */
export interface ToolHost {
  readonly instructions: string;
  listTools(): readonly ToolDefinition[];
  /** Returns undefined for a tool this host does not have. */
  callTool(name: string, args: unknown, call: ToolCall): Promise<ToolResult | undefined>;
}

export const INDEX_STATUS_TOOL_NAME = "index_status";

const INSTRUCTIONS =
  "Looky answers questions about the repository this session is authorized for, at the exact " +
  "committed revision the session pinned. Call ask_project with a question; mode defaults to " +
  '"fast", and "deep" must be requested explicitly. If the result status is "indexing", the ' +
  "index for that revision is still being built: wait retryAfterMs and call again, or call " +
  "index_status. Results with isError are not answers and carry a typed status.";

/**
 * Tools for one principal: `ask_project` and a read-only `index_status` for
 * the session's own repository and revision. `principal` is resolved for
 * every call, so a client whose revision moves pins the new SHA per request.
 */
export function lookyToolHost(
  service: LookyService,
  askConfig: Pick<LookyAskConfig, "maxQuestionChars">,
  principal: (signal: AbortSignal) => Promise<Principal>,
): ToolHost {
  const tools: ToolDefinition[] = [
    askProjectToolDefinition(askConfig),
    {
      name: INDEX_STATUS_TOOL_NAME,
      description:
        "Report the index lifecycle for this session's repository and exact revision: " +
        "not_indexed, building with progress, ready, or failed with whether a retry is automatic. " +
        "Starts nothing.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
  return {
    instructions: INSTRUCTIONS,
    listTools: () => tools,
    async callTool(name, args, call) {
      if (name === tools[0]!.name) {
        const who = await principal(call.signal);
        const response = await service.ask(who, args, {
          signal: call.signal,
          ...(call.requestKey !== undefined ? { requestKey: call.requestKey } : {}),
        });
        return toToolResult(response) as ToolResult;
      }
      if (name === INDEX_STATUS_TOOL_NAME) {
        const who = await principal(call.signal);
        const decision = who.authorize();
        if (!decision.allowed) {
          return {
            content: [{ type: "text", text: `Access denied (${decision.reason})` }],
            structuredContent: { status: "denied", reason: decision.reason },
            isError: true,
          };
        }
        const view = service.indexView({
          repositoryId: who.context.repositoryId,
          sha: who.context.sha,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(view) }],
          structuredContent: view,
          isError: false,
        };
      }
      return undefined;
    },
  };
}

/**
 * One MCP connection: tracks in-flight tool calls so `notifications/cancelled`
 * can detach them. Transports feed it parsed JSON messages.
 */
export class McpConnection {
  readonly #inflight = new Map<JsonRpcId, AbortController>();

  constructor(private readonly host: ToolHost) {}

  /**
   * Handle one message. Returns the response for a request, or undefined for
   * notifications and client responses. `signal` aborts when the transport
   * gives up on the call, such as an HTTP client disconnecting.
   */
  async handle(message: unknown, signal?: AbortSignal): Promise<JsonRpcResponse | undefined> {
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      return error(null, INVALID_REQUEST, "A JSON-RPC message must be an object");
    }
    const { jsonrpc, id, method, params } = message as Record<string, unknown>;
    const hasId = typeof id === "string" || typeof id === "number";
    if (jsonrpc !== "2.0" || (id !== undefined && !hasId)) {
      return error(hasId ? id : null, INVALID_REQUEST, "Invalid JSON-RPC 2.0 message");
    }
    if (typeof method !== "string") {
      // A response from the client to a server request; this server sends none.
      return hasId ? undefined : error(null, INVALID_REQUEST, "Missing method");
    }
    if (!hasId) {
      this.#notify(method, params);
      return undefined;
    }
    try {
      return { jsonrpc: "2.0", id, result: await this.#request(id, method, params, signal) };
    } catch (failure) {
      if (failure instanceof RpcError) return error(id, failure.code, failure.message);
      return error(id, -32603, failure instanceof Error ? failure.message : String(failure));
    }
  }

  #notify(method: string, params: unknown): void {
    if (method === "notifications/cancelled") {
      const requestId = (params as { requestId?: unknown } | undefined)?.requestId;
      if (typeof requestId === "string" || typeof requestId === "number") {
        this.#inflight.get(requestId)?.abort(new Error("Cancelled by the client"));
      }
    }
    // notifications/initialized and others need no action.
  }

  async #request(
    id: JsonRpcId,
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    switch (method) {
      case "initialize": {
        const requested = (params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const protocolVersion = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(requested)
          ? (requested as string)
          : MCP_PROTOCOL_VERSIONS[0];
        return {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "looky", version: LOOKY_VERSION },
          instructions: this.host.instructions,
        };
      }
      case "ping":
        return {};
      case "tools/list":
        return { tools: this.host.listTools() };
      case "tools/call":
        return this.#callTool(id, params, signal);
      default:
        throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
    }
  }

  async #callTool(id: JsonRpcId, params: unknown, signal: AbortSignal | undefined) {
    if (typeof params !== "object" || params === null) {
      throw new RpcError(INVALID_PARAMS, "tools/call needs params");
    }
    const { name, arguments: args, _meta: meta } = params as Record<string, unknown>;
    if (typeof name !== "string") throw new RpcError(INVALID_PARAMS, "tools/call needs a name");
    const requestKey = (meta as Record<string, unknown> | undefined)?.[REQUEST_KEY_META];
    if (
      requestKey !== undefined &&
      (typeof requestKey !== "string" ||
        requestKey.length === 0 ||
        requestKey.length > MAX_REQUEST_KEY_CHARS)
    ) {
      throw new RpcError(
        INVALID_PARAMS,
        `${REQUEST_KEY_META} must be a non-empty string of at most ${MAX_REQUEST_KEY_CHARS} characters`,
      );
    }
    if (this.#inflight.has(id)) {
      throw new RpcError(INVALID_REQUEST, `Request id ${String(id)} is already in flight`);
    }
    const controller = new AbortController();
    this.#inflight.set(id, controller);
    try {
      const callSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      const result = await this.host.callTool(name, args ?? {}, {
        signal: callSignal,
        ...(requestKey !== undefined ? { requestKey: requestKey as string } : {}),
      });
      if (!result) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${name}`);
      return result;
    } finally {
      this.#inflight.delete(id);
    }
  }

  /** Abort every in-flight call, such as when the transport closes. */
  abortAll(reason: string): void {
    for (const controller of this.#inflight.values()) controller.abort(new Error(reason));
  }
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function error(id: JsonRpcId | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
