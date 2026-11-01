/**
 * MCP over stdio: one JSON-RPC message per line on stdin and stdout. Calls run
 * concurrently so `notifications/cancelled` can detach a running call. Logs
 * go to stderr; stdout carries only protocol messages.
 */
import type { McpConnection } from "./protocol";

export interface StdioOptions {
  readonly input?: ReadableStream<Uint8Array>;
  readonly write?: (line: string) => void;
}

export async function serveStdio(
  connection: McpConnection,
  options: StdioOptions = {},
): Promise<void> {
  const input = options.input ?? Bun.stdin.stream();
  const write = options.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
  const pending = new Set<Promise<void>>();
  const decoder = new TextDecoder();
  let buffer = "";

  const dispatch = (line: string) => {
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line) as unknown;
    } catch {
      write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        }),
      );
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    const task = Promise.all(messages.map((item) => connection.handle(item))).then((responses) => {
      const sent = responses.filter((response) => response !== undefined);
      if (sent.length === 0) return;
      write(JSON.stringify(Array.isArray(message) ? sent : sent[0]));
    });
    const tracked = task.catch((error: unknown) => {
      console.error("looky: stdio message failed:", error instanceof Error ? error.message : error);
    });
    pending.add(tracked);
    void tracked.finally(() => pending.delete(tracked));
  };

  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      dispatch(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  dispatch(buffer + decoder.decode());
  // The client closed its end: nobody can receive results any more.
  connection.abortAll("The MCP client closed stdin");
  await Promise.all(pending);
}
