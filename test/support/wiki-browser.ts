import { expect } from "bun:test";

export interface Reply {
  readonly status: number;
  readonly body: any;
  readonly text: string;
}

/** A signed-in browser tab speaking Looky's same-origin browser API, cookie and CSRF included. */
export class WikiBrowser {
  cookie: string | undefined;
  csrf: string | undefined;
  readonly seen: string[] = [];

  constructor(
    private readonly url: () => string,
    private readonly waitFor: (generationId: string) => Promise<{ readonly state: string }>,
  ) {}

  async call(method: string, path: string, body?: unknown, csrf = true): Promise<Reply> {
    const headers: Record<string, string> = { origin: this.url() };
    if (this.cookie) headers.cookie = this.cookie;
    if (csrf && this.csrf && method !== "GET") headers["x-looky-csrf"] = this.csrf;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.url()}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const setCookie = response.headers.get("set-cookie");
    if (setCookie) {
      const pair = setCookie.split(";")[0]!;
      this.cookie = pair.endsWith("=") ? undefined : pair;
    }
    const text = await response.text();
    this.seen.push(text);
    return { status: response.status, body: text ? JSON.parse(text) : undefined, text };
  }

  async signIn(): Promise<void> {
    const reply = await this.call("POST", "/browser/v1/session", {});
    expect(reply.status).toBe(201);
    this.csrf = reply.body.csrfToken;
  }

  async select(repositoryId = "pilot", ref = "main"): Promise<string> {
    const reply = await this.call("POST", "/browser/v1/revisions", { repositoryId, ref });
    expect([200, 201]).toContain(reply.status);
    return reply.body.revision.id;
  }

  wiki(revisionId: string, rest = ""): string {
    return `/browser/v1/revisions/${revisionId}/wiki${rest}`;
  }

  /** Start generation from the browser and wait until it is published. */
  async generate(revisionId: string): Promise<string> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const started = await this.call("POST", this.wiki(revisionId, "/generate"), {});
      expect([200, 202]).toContain(started.status);
      if (started.body.state === "indexing") {
        await Bun.sleep(25);
        continue;
      }
      const id = started.body.generation.id as string;
      const done = await this.waitFor(id);
      expect(done.state).toBe("ready");
      return id;
    }
    throw new Error("indexing never finished");
  }

  async ask(revisionId: string, body: Record<string, unknown>): Promise<Reply> {
    return this.call("POST", "/browser/v1/questions", { revisionId, ...body });
  }

  async result(id: string): Promise<Reply> {
    return this.call("GET", `/browser/v1/questions/${id}?waitMs=20000`);
  }
}
