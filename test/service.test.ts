import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type {
  AnsweredResponse,
  AskProjectResponse,
  IndexingResponse,
} from "../src/contract/response";
import { DEFAULT_INDEX_LIMITS, indexKey } from "../src/indexing/policy";
import { insertQueuedBuild } from "../src/indexing/store";
import { ProviderRouter } from "../src/providers/router";
import type { LookyService } from "../src/service/looky-service";
import { RegistrationError } from "../src/service/sessions";
import { openDatabase } from "../src/storage/database";
import { join } from "node:path";
import { git } from "./support/git-fixture";
import { refreshPilotRepo } from "./support/pilot-fixture";
import {
  citingModel,
  createFixture,
  gatedModel,
  PAWS,
  QUESTION,
  type Fixture,
} from "./support/service-fixture";

function answered(response: AskProjectResponse): AnsweredResponse {
  if (response.status !== "answered") {
    throw new Error(`Expected an answer, got ${JSON.stringify(response)}`);
  }
  return response;
}

let fixture: Fixture;

beforeEach(() => {
  fixture = createFixture("looky-service-");
});

afterEach(async () => {
  await fixture.close();
});

async function session(service: LookyService, overrides = {}) {
  const registered = await service.registerSession(PAWS, fixture.registration(overrides));
  const record = service.sessions.fromToken(registered.token)!;
  return { registered, principal: service.principalFor(record, PAWS) };
}

describe("index readiness before answering", () => {
  test("first use builds the index and answers in both modes; repeats reuse it", async () => {
    const model = citingModel();
    const service = fixture.service({ provider: model });
    const { registered, principal } = await session(service);
    // Registration prewarms the exact SHA of the task.
    expect(["building", "ready"]).toContain(registered.index.state);

    const fast = answered(await service.ask(principal, { question: QUESTION }));
    expect(fast.mode).toEqual({ requested: "fast", executed: "fast" });
    expect(fast.index.sha).toBe(fixture.sha);
    expect(fast.answer.text).toContain("checkpoint");
    expect(fast.evidence.length).toBeGreaterThan(0);

    const deep = answered(await service.ask(principal, { question: QUESTION, mode: "deep" }));
    expect(deep.mode).toEqual({ requested: "deep", executed: "deep" });
    expect(deep.index.generationId).toBe(fast.index.generationId);

    const again = answered(await service.ask(principal, { question: QUESTION }));
    expect(again.index.generationId).toBe(fast.index.generationId);
    expect(service.index.builds({ repositoryId: "pilot" })).toHaveLength(1);
  });

  test("without time to wait, a typed retryable indexing result carries the build", async () => {
    const service = fixture.service({ capacity: { indexWaitMs: 0 } });
    const { principal } = await session(service);
    const first = await service.ask(principal, { question: QUESTION });
    expect(first.status).toBe("indexing");
    const indexing = first as IndexingResponse;
    expect(indexing.buildId).toStartWith("build_");
    expect(indexing.revision.sha).toBe(fixture.sha);
    expect(indexing.retryAfterMs).toBeGreaterThan(0);
    expect(indexing.mode.executed).toBeNull();

    await service.index.waitForBuild(indexing.buildId);
    const later = answered(await service.ask(principal, { question: QUESTION }));
    expect(later.index.generationId).toBe(indexing.buildId);
  });

  test("a new requested commit refreshes before answering and fences the old generation", async () => {
    const service = fixture.service();
    const first = await session(service);
    answered(await service.ask(first.principal, { question: QUESTION }));

    const next = refreshPilotRepo(fixture.repo);
    const second = await session(service, { sequence: 2, clientGeneration: "run-2", sha: next });
    expect(second.registered.superseded).toEqual([first.registered.session.id]);

    const response = answered(await service.ask(second.principal, { question: QUESTION }));
    expect(response.index.sha).toBe(next);
    expect(response.evidence.every((ref) => ref.path !== "src/recovery/recover-run.ts")).toBe(true);
    const build = getBuildOf(service, response.index.generationId);
    expect(build.refresh.mode).toBe("incremental");

    const stale = await service.ask(first.principal, { question: QUESTION });
    expect(stale.status).toBe("denied");
    expect(stale.status === "denied" && stale.reason).toBe("stale_session");
  });

  test("status is truthful while building and after a failure", async () => {
    const service = fixture.service({
      capacity: { indexWaitMs: 0 },
      index: {
        limits: { ...DEFAULT_INDEX_LIMITS, maxFiles: 2 },
        maxConcurrentBuilds: 1,
        retention: {
          retainReadyPerRepository: 3,
          retainFailedPerRepository: 20,
          leaseTtlMs: 60_000,
        },
      },
    });
    const { registered, principal } = await session(service);
    expect(registered.index.state).toBe("building");
    expect(registered.index.active?.buildId).toBeDefined();
    await service.index.waitForBuild(registered.index.active!.buildId);

    const view = service.status(PAWS, { repositoryId: "pilot", sha: fixture.sha });
    expect(view.state).toBe("failed");
    expect(view.failure?.code).toBe("limit_exceeded");
    expect(view.failure?.retryable).toBe(false);

    const response = await service.ask(principal, { question: QUESTION });
    expect(response.status).toBe("failed");
    expect(response.status === "failed" && response.stage).toBe("index");
    expect(response.status === "failed" && response.buildId).toBe(view.failure!.buildId);

    // An explicit retry starts a new attempt rather than reporting the old one.
    const retried = await service.retry(PAWS, view.failure!.buildId);
    expect(retried.state).toBe("building");
  });
});

describe("execution host", () => {
  test("a host whose clone lacks the requested commit fetches it before indexing", async () => {
    const mirror = join(fixture.root, "mirror.git");
    git(fixture.root, "clone", "--quiet", "--bare", fixture.repo, mirror);
    const next = refreshPilotRepo(fixture.repo);
    const repositories = new Map([["pilot", { id: "pilot", path: mirror, fetchRemote: "origin" }]]);
    const service = fixture.service({ repositories });
    const { principal } = await session(service, { sha: next });
    const response = answered(await service.ask(principal, { question: QUESTION }));
    expect(response.index.sha).toBe(next);
  });

  test("without a fetch remote a missing commit is an unsupported revision, never another SHA", async () => {
    const mirror = join(fixture.root, "mirror.git");
    git(fixture.root, "clone", "--quiet", "--bare", fixture.repo, mirror);
    const next = refreshPilotRepo(fixture.repo);
    const service = fixture.service({
      repositories: new Map([["pilot", { id: "pilot", path: mirror }]]),
    });
    const { principal } = await session(service, { sha: next });
    const response = await service.ask(principal, { question: QUESTION });
    expect(response.status).toBe("unsupported_revision");
  });
});

describe("restart", () => {
  test("a restarted service reuses the ready index and the session token", async () => {
    const first = fixture.service();
    const { registered, principal } = await session(first);
    const before = answered(await first.ask(principal, { question: QUESTION }));
    await first.close();

    const second = fixture.service();
    const record = second.sessions.fromToken(registered.token)!;
    expect(record.id).toBe(registered.session.id);
    const after = answered(
      await second.ask(second.principalFor(record, PAWS), { question: QUESTION }),
    );
    expect(after.index.generationId).toBe(before.index.generationId);
    expect(second.index.builds({ repositoryId: "pilot" })).toHaveLength(1);
  });

  test("a build interrupted by a crash is reported retryable and rebuilt on the next request", async () => {
    const db = openDatabase({ dataDir: fixture.dataDir });
    const key = indexKey({ ...DEFAULT_INDEX_LIMITS, maxFileBytes: 65_536 });
    const orphan = insertQueuedBuild(db, {
      id: "build_orphan",
      repositoryId: "pilot",
      sha: fixture.sha,
      indexKey: key,
      requestedMode: "auto",
    });
    db.close();

    const service = fixture.service();
    const interrupted = service.index.status(orphan.id)!;
    expect(interrupted.state).toBe("failed");
    expect(interrupted.errorCode).toBe("interrupted");
    expect(interrupted.retryable).toBe(true);

    const { principal } = await session(service);
    const response = answered(await service.ask(principal, { question: QUESTION }));
    expect(response.index.generationId).not.toBe(orphan.id);
  });
});

describe("bounded capacity", () => {
  test("with one question slot and no queue, a second question is refused at once as busy", async () => {
    const gated = gatedModel();
    const service = fixture.service({
      provider: gated.provider,
      capacity: { maxConcurrentAsks: 1, maxQueuedAsks: 0 },
    });
    const a = await session(service);
    const b = await session(service, { taskId: "task-2" });
    const holding = service.ask(a.principal, { question: QUESTION });
    await gated.firstCall;

    const started = Date.now();
    const refused = await service.ask(b.principal, { question: QUESTION });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(refused.status).toBe("unavailable");
    expect(refused.status === "unavailable" && refused.code).toBe("busy");
    expect(refused.status === "unavailable" && refused.retryable).toBe(true);

    gated.release();
    answered(await holding);
    // The slot is released on the terminal path; the next question is admitted.
    answered(await service.ask(b.principal, { question: QUESTION }));
  });

  test("a queued question gives up after the admission wait instead of waiting forever", async () => {
    const gated = gatedModel();
    const service = fixture.service({
      provider: gated.provider,
      capacity: { maxConcurrentAsks: 1, maxQueuedAsks: 4, admissionWaitMs: 50 },
    });
    const a = await session(service);
    const b = await session(service, { taskId: "task-2" });
    const holding = service.ask(a.principal, { question: QUESTION });
    await gated.firstCall;
    const refused = await service.ask(b.principal, { question: QUESTION });
    expect(refused.status === "unavailable" && refused.code).toBe("busy");
    gated.release();
    answered(await holding);
  });

  test("one session cannot fan out beyond its in-flight limit", async () => {
    const gated = gatedModel();
    const service = fixture.service({
      provider: gated.provider,
      capacity: { maxAsksPerSession: 1 },
    });
    const { principal } = await session(service);
    const holding = service.ask(principal, { question: QUESTION });
    await gated.firstCall;
    const refused = await service.ask(principal, { question: "Where are checkpoints stored?" });
    expect(refused.status === "unavailable" && refused.code).toBe("session_limit");
    gated.release();
    answered(await holding);
  });
});

describe("request identity, cancellation and fencing", () => {
  test("duplicate deliveries share one piece of work and one request id", async () => {
    const model = citingModel();
    const service = fixture.service({ provider: model });
    const { principal } = await session(service);
    const [one, two] = await Promise.all([
      service.ask(principal, { question: QUESTION }),
      service.ask(principal, { question: QUESTION }),
    ]);
    expect(answered(one).requestId).toBe(answered(two).requestId);
    expect(model.calls.filter((call) => call.kind === "answer")).toHaveLength(1);
  });

  test("a redelivered request key returns the same result without new work", async () => {
    const model = citingModel();
    const service = fixture.service({ provider: model });
    const { principal } = await session(service);
    const first = answered(
      await service.ask(principal, { question: QUESTION }, { requestKey: "k1" }),
    );
    const again = answered(
      await service.ask(principal, { question: QUESTION }, { requestKey: "k1" }),
    );
    expect(again.requestId).toBe(first.requestId);
    expect(model.calls.filter((call) => call.kind === "answer")).toHaveLength(1);

    const reused = await service.ask(
      principal,
      { question: "something else" },
      { requestKey: "k1" },
    );
    expect(reused.status).toBe("invalid_request");
  });

  test("a cancelling caller detaches while a joined caller still gets the answer", async () => {
    const gated = gatedModel();
    const service = fixture.service({ provider: gated.provider });
    const { principal } = await session(service);
    const leaving = new AbortController();
    const first = service.ask(principal, { question: QUESTION }, { signal: leaving.signal });
    const second = service.ask(principal, { question: QUESTION });
    await gated.firstCall;
    leaving.abort();
    expect((await first).status).toBe("cancelled");
    expect(gated.signals[0]!.aborted).toBe(false);
    gated.release();
    answered(await second);
  });

  test("the last caller cancelling stops unshared work and frees its slot", async () => {
    const gated = gatedModel();
    const service = fixture.service({
      provider: gated.provider,
      capacity: { maxConcurrentAsks: 1, maxQueuedAsks: 0 },
    });
    const { principal } = await session(service);
    const leaving = new AbortController();
    const pending = service.ask(principal, { question: QUESTION }, { signal: leaving.signal });
    await gated.firstCall;
    leaving.abort();
    expect((await pending).status).toBe("cancelled");
    expect(gated.signals[0]!.aborted).toBe(true);
    await Bun.sleep(10);
    expect(service.info().capacity.asksActive).toBe(0);
    expect(service.info().capacity.requestsInFlight).toBe(0);
  });

  test("a revoked session receives no result for work already running", async () => {
    const gated = gatedModel();
    const service = fixture.service({ provider: gated.provider });
    const { registered, principal } = await session(service);
    const pending = service.ask(principal, { question: QUESTION });
    await gated.firstCall;
    service.revokeSession(PAWS, registered.session.id);
    const response = await pending;
    expect(response.status).toBe("denied");
    expect(gated.signals[0]!.aborted).toBe(true);
  });

  test("ending a session cancels its unshared build but not one another session needs", async () => {
    const service = fixture.service({ capacity: { indexWaitMs: 0 } });
    const next = refreshPilotRepo(fixture.repo);

    const lone = await session(service, { taskId: "lone", sha: next });
    const buildId = lone.registered.index.active!.buildId;
    service.revokeSession(PAWS, lone.registered.session.id);
    const cancelled = await service.index.waitForBuild(buildId);
    expect(cancelled.state).toBe("cancelled");

    const a = await session(service, { taskId: "a" });
    await session(service, { taskId: "b" });
    const shared = a.registered.index.active!.buildId;
    service.revokeSession(PAWS, a.registered.session.id);
    expect((await service.index.waitForBuild(shared)).state).toBe("ready");
  });
});

describe("session registration", () => {
  test("duplicate registration is idempotent; older and conflicting ones are refused", async () => {
    const service = fixture.service();
    const first = await service.registerSession(PAWS, fixture.registration());
    const again = await service.registerSession(PAWS, fixture.registration());
    expect(again.created).toBe(false);
    expect(again.token).toBe(first.token);

    await service.registerSession(PAWS, fixture.registration({ sequence: 3 }));
    await expectCode(
      service.registerSession(PAWS, fixture.registration({ sequence: 2 })),
      "stale_session",
    );
    await expectCode(
      service.registerSession(PAWS, fixture.registration({ sequence: 3, callerId: "other" })),
      "conflict",
    );
  });

  test("credentials and unknown scope fields are rejected without echoing values", async () => {
    const service = fixture.service();
    const secret = "sk-live-should-never-be-stored";
    const failure = await service
      .registerSession(PAWS, { ...fixture.registration(), apiKey: secret })
      .catch((error: unknown) => error as RegistrationError);
    expect(failure).toBeInstanceOf(RegistrationError);
    expect((failure as RegistrationError).message).not.toContain(secret);

    await expectCode(
      service.registerSession(PAWS, fixture.registration({ repositoryId: "other" })),
      "repository_not_authorized",
    );
    await expectCode(
      service.registerSession(PAWS, fixture.registration({ sha: "main" })),
      "unsupported_revision",
    );
  });

  test("the session's provider policy selects among configured providers", async () => {
    const primary = citingModel("primary");
    const secondary = citingModel("secondary");
    const service = fixture.service({
      provider: new ProviderRouter({
        providers: [primary, secondary],
        policy: { selected: "primary" },
      }),
    });
    await expectCode(
      service.registerSession(PAWS, fixture.registration({ providerPolicy: { selected: "nope" } })),
      "invalid_registration",
    );
    const { principal } = await session(service, { providerPolicy: { selected: "secondary" } });
    const response = answered(await service.ask(principal, { question: QUESTION }));
    expect(response.providers).toEqual(["secondary"]);
    expect(primary.calls).toHaveLength(0);
  });
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const failure = await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(RegistrationError);
  expect((failure as RegistrationError).code).toBe(code as RegistrationError["code"]);
}

function getBuildOf(service: LookyService, buildId: string) {
  const build = service.index.status(buildId);
  if (!build) throw new Error(`No build ${buildId}`);
  return build;
}
