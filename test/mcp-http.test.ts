import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LookyClient, LookyClientError } from "../src/client/looky-client";
import { startHttpServer, type RunningHttpServer } from "../src/mcp/http";
import type { LookyService } from "../src/service/looky-service";
import {
  CLIENT_TOKEN,
  createFixture,
  gatedModel,
  PAWS,
  QUESTION,
  type Fixture,
} from "./support/service-fixture";

let fixture: Fixture;
let service: LookyService;
let http: RunningHttpServer;

function start(options: Parameters<Fixture["service"]>[0] = {}): void {
  service = fixture.service(options);
  http = startHttpServer({
    service,
    config: {
      host: "127.0.0.1",
      port: 0,
      clients: new Map([["paws", PAWS]]),
      allowedOrigins: [],
    },
    askConfig: { maxQuestionChars: 4000 },
  });
}

beforeEach(() => {
  fixture = createFixture("looky-http-");
});

afterEach(async () => {
  await http?.stop();
  await fixture.close();
});

let nextId = 1;

async function rpc(
  token: string,
  method: string,
  params?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${http.url}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : undefined,
    headers: response.headers,
  };
}

describe("MCP over HTTP", () => {
  test("an agent connects with its session token, builds the index and gets full answers", async () => {
    start();
    const client = await LookyClient.connect({ url: http.url, token: CLIENT_TOKEN });
    const registered = await client.registerSession(fixture.registration());
    expect(registered.service.dataDir).toBe(fixture.dataDir);
    expect(client.mcpUrl).toBe(`${http.url}/mcp`);

    const init = await rpc(registered.token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.body.result.protocolVersion).toBe("2025-06-18");
    expect(init.body.result.serverInfo.name).toBe("looky");
    const mcpSession = init.headers.get("mcp-session-id")!;
    expect(mcpSession).toBeTruthy();

    const tools = await rpc(registered.token, "tools/list", undefined, {
      "mcp-session-id": mcpSession,
    });
    expect(tools.body.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "ask_project",
      "index_status",
    ]);

    for (const mode of ["fast", "deep"]) {
      const call = await rpc(
        registered.token,
        "tools/call",
        { name: "ask_project", arguments: { question: QUESTION, mode } },
        { "mcp-session-id": mcpSession },
      );
      const result = call.body.result;
      expect(result.isError).toBe(false);
      expect(result.structuredContent.status).toBe("answered");
      expect(result.structuredContent.index.sha).toBe(fixture.sha);
      expect(result.content[0].text).toContain("checkpoint");
    }

    const status = await rpc(registered.token, "tools/call", {
      name: "index_status",
      arguments: {},
    });
    expect(status.body.result.structuredContent.state).toBe("ready");

    // Arguments can never select another repository or revision.
    const scoped = await rpc(registered.token, "tools/call", {
      name: "ask_project",
      arguments: { question: QUESTION, sha: "b".repeat(40) },
    });
    expect(scoped.body.result.structuredContent.status).toBe("invalid_request");
  });

  test("unauthenticated, wrong-protocol and foreign-origin requests are refused", async () => {
    start();
    expect((await rpc("lks_not-a-token", "ping")).status).toBe(401);
    expect((await fetch(`${http.url}/v1/service`)).status).toBe(401);

    const noVersion = await fetch(`${http.url}/v1/service`, {
      headers: { authorization: `Bearer ${CLIENT_TOKEN}` },
    });
    expect(noVersion.status).toBe(400);
    expect(((await noVersion.json()) as any).error.code).toBe("unsupported_protocol_version");

    const client = new LookyClient({ url: http.url, token: CLIENT_TOKEN });
    const { token } = await client.registerSession(fixture.registration());
    const foreign = await rpc(token, "ping", undefined, { origin: "https://evil.example" });
    expect(foreign.status).toBe(403);

    // A session token is not a client token.
    const wrong = new LookyClient({ url: http.url, token });
    await expect(wrong.service()).rejects.toBeInstanceOf(LookyClientError);
  });

  test("a superseded session's tool call is denied with stale_session", async () => {
    start();
    const client = new LookyClient({ url: http.url, token: CLIENT_TOKEN });
    const old = await client.registerSession(fixture.registration());
    await client.registerSession(fixture.registration({ sequence: 2, clientGeneration: "run-2" }));
    const call = await rpc(old.token, "tools/call", {
      name: "ask_project",
      arguments: { question: QUESTION },
    });
    expect(call.body.result.isError).toBe(true);
    expect(call.body.result.structuredContent.reason).toBe("stale_session");
  });

  test("notifications/cancelled detaches a running call", async () => {
    const gated = gatedModel();
    start({ provider: gated.provider });
    const client = new LookyClient({ url: http.url, token: CLIENT_TOKEN });
    const { token } = await client.registerSession(fixture.registration());
    const init = await rpc(token, "initialize", { protocolVersion: "2025-06-18" });
    const headers = { "mcp-session-id": init.headers.get("mcp-session-id")! };

    const id = nextId++;
    const pending = fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name: "ask_project", arguments: { question: QUESTION } },
      }),
    });
    await gated.firstCall;
    const notified = await fetch(`${http.url}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...headers },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/cancelled",
        params: { requestId: id },
      }),
    });
    expect(notified.status).toBe(202);
    const body = (await (await pending).json()) as any;
    expect(body.result.structuredContent.status).toBe("cancelled");
    expect(gated.signals[0]!.aborted).toBe(true);
  });

  test("the operational API reports status and runs rebuild, retry and revoke", async () => {
    start({ capacity: { indexWaitMs: 0 } });
    const client = await LookyClient.connect({ url: http.url, token: CLIENT_TOKEN });
    const info = await client.service();
    expect(info.repositories).toEqual(["pilot"]);
    expect(info.host).toBeTruthy();

    const registered = await client.registerSession(fixture.registration());
    const buildId = registered.index.active!.buildId;
    await service.index.waitForBuild(buildId);
    expect((await client.indexStatus("pilot", fixture.sha)).state).toBe("ready");

    const rebuilding = await client.rebuild("pilot", fixture.sha);
    expect(rebuilding.state).toBe("ready");
    expect(rebuilding.active?.buildId).toBeDefined();
    const cancelled = await client.cancelBuild(rebuilding.active!.buildId);
    expect(cancelled.cancelled).toBe(true);
    await service.index.waitForBuild(rebuilding.active!.buildId);
    // Cancelling a rebuild leaves the ready generation serving.
    expect((await client.indexStatus("pilot", fixture.sha)).ready?.buildId).toBe(buildId);

    await expect(client.indexStatus("other", fixture.sha)).rejects.toMatchObject({ status: 403 });
    await expect(client.retry("build_unknown")).rejects.toMatchObject({ status: 404 });

    const revoked = await client.revokeSession(registered.session.id);
    expect(revoked.state).toBe("revoked");
    const call = await rpc(registered.token, "tools/call", {
      name: "ask_project",
      arguments: { question: QUESTION },
    });
    expect(call.body.result.structuredContent.reason).toBe("revoked");
  });
});
