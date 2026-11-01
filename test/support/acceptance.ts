/**
 * Harness for the acceptance suite: a real Looky service over its real HTTP
 * MCP endpoint, a real temporary Git repository and real SQLite storage.
 * Only the model provider is scripted, so no test needs a network service.
 */
import { expect } from "bun:test";
import { LookyClient } from "../../src/client/looky-client";
import type { AskProjectResponse } from "../../src/contract/response";
import { startHttpServer, type RunningHttpServer } from "../../src/mcp/http";
import { hashToken, type ClientConfig } from "../../src/service/config";
import type { LookyService } from "../../src/service/looky-service";
import type { SessionRegistration } from "../../src/service/sessions";
import { git } from "./git-fixture";
import type { ScriptedCall } from "./scripted-model";
import { CLIENT_TOKEN, PAWS, type Fixture } from "./service-fixture";

export interface ToolResult {
  readonly content: readonly { readonly type: string; readonly text: string }[];
  readonly structuredContent: AskProjectResponse;
  readonly isError: boolean;
}

export interface McpSession {
  readonly token: string;
  readonly sessionId: string;
  readonly registered: Awaited<ReturnType<LookyClient["registerSession"]>>;
  /** `tools/call` for `ask_project`; `requestKey` goes in `_meta`. */
  ask(
    args: Record<string, unknown>,
    options?: { readonly requestKey?: string; readonly id?: number },
  ): Promise<ToolResult>;
  /** `tools/call` for `index_status`. */
  indexStatus(): Promise<Record<string, unknown>>;
  /** Send `notifications/cancelled` for a JSON-RPC id. */
  cancel(id: number): Promise<number>;
}

export interface Looky {
  readonly service: LookyService;
  readonly http: RunningHttpServer;
  /** Operational client for Paws. */
  readonly client: LookyClient;
  open(overrides?: Partial<SessionRegistration>, client?: LookyClient): Promise<McpSession>;
  stop(): Promise<void>;
}

let nextId = 1;
export function rpcId(): number {
  return nextId++;
}

/** Start a fixture service behind the HTTP MCP endpoint with Paws and any extra clients. */
export function startLooky(
  fixture: Fixture,
  options: Parameters<Fixture["service"]>[0] = {},
  extraClients: readonly ClientConfig[] = [],
): Looky {
  const service = fixture.service(options);
  const http = startHttpServer({
    service,
    config: {
      host: "127.0.0.1",
      port: 0,
      clients: new Map([PAWS, ...extraClients].map((client) => [client.id, client])),
      allowedOrigins: [],
    },
    askConfig: { maxQuestionChars: 4000 },
  });
  const client = new LookyClient({ url: http.url, token: CLIENT_TOKEN });

  async function post(token: string, mcpSession: string, body: unknown): Promise<Response> {
    return fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "mcp-session-id": mcpSession,
      },
      body: JSON.stringify(body),
    });
  }

  return {
    service,
    http,
    client,
    async open(overrides = {}, as = client) {
      const registered = await as.registerSession(fixture.registration(overrides));
      const init = await fetch(`${http.url}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${registered.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: rpcId(),
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
        }),
      });
      expect(init.status).toBe(200);
      const mcpSession = init.headers.get("mcp-session-id")!;
      const call = async (name: string, args: unknown, meta?: unknown, id = rpcId()) => {
        const response = await post(registered.token, mcpSession, {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args, ...(meta ? { _meta: meta } : {}) },
        });
        const body = (await response.json()) as { result?: unknown; error?: unknown };
        if (!body.result) throw new Error(`tools/call failed: ${JSON.stringify(body)}`);
        return body.result;
      };
      return {
        token: registered.token,
        sessionId: registered.session.id,
        registered,
        async ask(args, { requestKey, id } = {}) {
          return (await call(
            "ask_project",
            args,
            requestKey ? { "looky/requestKey": requestKey } : undefined,
            id,
          )) as ToolResult;
        },
        async indexStatus() {
          const result = (await call("index_status", {})) as {
            structuredContent: Record<string, unknown>;
          };
          return result.structuredContent;
        },
        async cancel(id) {
          const response = await post(registered.token, mcpSession, {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: id },
          });
          return response.status;
        },
      };
    },
    async stop() {
      await http.stop();
      await service.close();
    },
  };
}

/** A second client with its own token and repository scope. */
export function otherClient(id: string, repositories: readonly string[]) {
  const token = `${id}-client-token-0123456789abcdef0123456789`;
  const config: ClientConfig = {
    id,
    tokenHash: hashToken(token),
    repositories: new Set(repositories),
  };
  return { config, token };
}

/** Narrow a tool result to an answer, failing with the typed response otherwise. */
export function answerOf(result: ToolResult) {
  const response = result.structuredContent;
  if (response.status !== "answered" || result.isError) {
    throw new Error(`Expected an answer, got ${JSON.stringify(response)}`);
  }
  return response;
}

/** Tracked file paths at a commit. */
export function treePaths(repo: string, sha: string): Set<string> {
  return new Set(git(repo, "ls-tree", "-r", "--name-only", sha).split("\n").filter(Boolean));
}

/** Exact lines of a file at a commit, 1-based like citations. */
export function linesAt(repo: string, sha: string, path: string): string[] {
  const result = Bun.spawnSync(["git", "-C", repo, "cat-file", "blob", `${sha}:${path}`]);
  if (result.exitCode !== 0) throw new Error(`${path} is not at ${sha}`);
  return result.stdout
    .toString()
    .replace(/\r?\n$/, "")
    .split(/\r?\n/);
}

/**
 * Every evidence block a model was shown came from exactly `sha`: its path is
 * tracked there and each numbered line equals that commit's line.
 */
export function expectPromptEvidenceAt(
  calls: readonly ScriptedCall[],
  repo: string,
  sha: string,
): void {
  const paths = treePaths(repo, sha);
  let checked = 0;
  for (const call of calls) {
    for (const item of call.evidence) {
      expect(paths.has(item.path)).toBe(true);
      const lines = linesAt(repo, sha, item.path);
      for (const line of item.text.split("\n")) {
        const match = /^(\d+)\| (.*)$/.exec(line);
        if (!match) continue;
        // Prompts neutralize fence tags in untrusted text with a zero-width space.
        expect(lines[Number(match[1]) - 1]).toBe(match[2]!.replaceAll("\u200b", ""));
        checked += 1;
      }
    }
  }
  expect(checked).toBeGreaterThan(0);
}

/** Every delivered evidence reference names a range that exists at `sha`. */
export function expectEvidenceAt(
  response: { readonly evidence: readonly { path: string; startLine: number; endLine: number }[] },
  repo: string,
  sha: string,
): void {
  const paths = treePaths(repo, sha);
  expect(response.evidence.length).toBeGreaterThan(0);
  for (const ref of response.evidence) {
    expect(paths.has(ref.path)).toBe(true);
    expect(ref.endLine).toBeLessThanOrEqual(linesAt(repo, sha, ref.path).length);
  }
}
