import { describe, expect, test } from "bun:test";
import { Admission } from "../src/service/admission";
import {
  clientForToken,
  clientMayUse,
  DEFAULT_CAPACITY,
  loadCapacityConfig,
  loadServerConfig,
} from "../src/service/config";

const signal = new AbortController().signal;
const TOKEN = "x".repeat(40);

describe("Admission", () => {
  test("grants slots in order, refuses a full queue and times out waiters", async () => {
    const admission = new Admission(1, 1);
    const first = await admission.acquire(1000, signal);
    expect(first.admitted).toBe(true);
    const queued = admission.acquire(1000, signal);
    expect(await admission.acquire(1000, signal)).toEqual({
      admitted: false,
      reason: "queue_full",
    });
    if (first.admitted) first.release();
    const second = await queued;
    expect(second.admitted).toBe(true);
    expect(await admission.acquire(10, signal)).toEqual({ admitted: false, reason: "timeout" });
    if (second.admitted) {
      second.release();
      second.release();
    }
    expect(admission.active).toBe(0);
  });

  test("a waiter that aborts leaves the queue", async () => {
    const admission = new Admission(1, 2);
    const held = await admission.acquire(0, signal);
    const controller = new AbortController();
    const waiting = admission.acquire(1000, controller.signal);
    controller.abort(new Error("gone"));
    await expect(waiting).rejects.toThrow("gone");
    expect(admission.queued).toBe(0);
    if (held.admitted) held.release();
    expect(admission.active).toBe(0);
  });
});

describe("service configuration", () => {
  const env = {
    LOOKY_REPOSITORIES: "paws-app,looky",
    LOOKY_REPOSITORY_PAWS_APP_PATH: "/srv/paws-app.git",
    LOOKY_REPOSITORY_PAWS_APP_FETCH_REMOTE: "origin",
    LOOKY_REPOSITORY_LOOKY_PATH: "/srv/looky.git",
    LOOKY_CLIENTS: "paws",
    LOOKY_CLIENT_PAWS_TOKEN: TOKEN,
    LOOKY_CLIENT_PAWS_REPOSITORIES: "paws-app",
    LOOKY_PORT: "0",
  };

  test("repositories, clients and their scopes come from the environment", () => {
    const config = loadServerConfig(env);
    expect(config.port).toBe(0);
    expect(config.host).toBe("127.0.0.1");
    expect(config.repositories.get("paws-app")).toEqual({
      id: "paws-app",
      path: "/srv/paws-app.git",
      fetchRemote: "origin",
    });
    const client = clientForToken(config.clients, TOKEN)!;
    expect(client.id).toBe("paws");
    expect(clientMayUse(client, "paws-app")).toBe(true);
    expect(clientMayUse(client, "looky")).toBe(false);
    expect(clientForToken(config.clients, "y".repeat(40))).toBeUndefined();
    expect(config.capacity).toEqual(DEFAULT_CAPACITY);
  });

  test("weak tokens, unknown repositories and bad limits are refused", () => {
    expect(() => loadServerConfig({ ...env, LOOKY_CLIENT_PAWS_TOKEN: "short" })).toThrow(
      "at least 32",
    );
    expect(() => loadServerConfig({ ...env, LOOKY_CLIENT_PAWS_REPOSITORIES: "other" })).toThrow(
      "not in LOOKY_REPOSITORIES",
    );
    expect(() => loadServerConfig({ ...env, LOOKY_REPOSITORY_LOOKY_PATH: "" })).toThrow(
      "LOOKY_REPOSITORY_LOOKY_PATH is required",
    );
    expect(() => loadCapacityConfig({ LOOKY_MAX_CONCURRENT_ASKS: "0" })).toThrow();
    expect(loadCapacityConfig({ LOOKY_INDEX_WAIT_MS: "0" }).indexWaitMs).toBe(0);
  });
});
