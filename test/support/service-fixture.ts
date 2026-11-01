import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LookyAnswerEngine } from "../../src/answer/engine";
import { loadAskConfig, loadIndexConfig } from "../../src/config";
import type { ModelProvider, ModelRequest, ModelResult } from "../../src/contract/ports";
import { DEFAULT_INDEX_LIMITS } from "../../src/indexing/policy";
import { DEFAULT_RESEARCH_LIMITS } from "../../src/retrieval/research";
import {
  DEFAULT_CAPACITY,
  hashToken,
  type CapacityConfig,
  type ClientConfig,
} from "../../src/service/config";
import { LookyService, type LookyServiceOptions } from "../../src/service/looky-service";
import type { SessionRegistration } from "../../src/service/sessions";
import { openDatabase } from "../../src/storage/database";
import { buildPilotRepo } from "./pilot-fixture";
import { idFor, scriptedModel, type ScriptedModel } from "./scripted-model";

export const QUESTION = "How does resumeInterruptedRun recover a crashed run?";
export const CLIENT_TOKEN = "paws-client-token-0123456789abcdef0123";

export const PAWS: ClientConfig = {
  id: "paws",
  tokenHash: hashToken(CLIENT_TOKEN),
  repositories: new Set(["pilot"]),
};

/** A model that cites the first recovery or checkpoint evidence it was shown. */
export function citingModel(id = "scripted"): ScriptedModel {
  return scriptedModel(
    {
      answer: (call) => {
        const cite =
          idFor(call, "src/recovery/recover-run.ts") ??
          idFor(call, "src/recovery/resume.ts") ??
          idFor(call, "src/storage/checkpoints.ts") ??
          call.evidence[0]?.id;
        return {
          outcome: "supported",
          answer: `Recovery loads the newest checkpoint and replays the run from it [${cite}].`,
          rationale: "not_asked",
        };
      },
    },
    { id },
  );
}

/**
 * A provider whose calls wait until released, to hold a question slot. It
 * records the abort signal of every call so tests can see unshared work stop.
 */
export function gatedModel(inner: ModelProvider = citingModel()) {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const signals: AbortSignal[] = [];
  let started!: () => void;
  const firstCall = new Promise<void>((resolve) => (started = resolve));
  const provider: ModelProvider = {
    id: inner.id,
    async complete(request: ModelRequest, signal: AbortSignal): Promise<ModelResult> {
      signals.push(signal);
      started();
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        void gate.then(resolve);
      });
      return inner.complete(request, signal);
    },
  };
  return { provider, release: () => open(), signals, firstCall };
}

export interface Fixture {
  readonly root: string;
  readonly repo: string;
  readonly dataDir: string;
  readonly sha: string;
  service(
    options?: Partial<Omit<LookyServiceOptions, "capacity">> & {
      capacity?: Partial<CapacityConfig>;
    },
  ): LookyService;
  registration(overrides?: Partial<SessionRegistration>): SessionRegistration;
  close(): Promise<void>;
}

export function createFixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const repo = join(root, "pilot");
  mkdirSync(repo);
  const dataDir = join(root, "data");
  const sha = buildPilotRepo(repo);
  const services: LookyService[] = [];
  return {
    root,
    repo,
    dataDir,
    sha,
    service(options = {}) {
      const { capacity, ...rest } = options;
      const index = loadIndexConfig({});
      const service = new LookyService({
        db: openDatabase({ dataDir }),
        dataDir,
        repositories: new Map([["pilot", { id: "pilot", path: repo }]]),
        ask: loadAskConfig({}),
        index: { ...index, limits: { ...DEFAULT_INDEX_LIMITS, maxFileBytes: 65_536 } },
        capacity: { ...DEFAULT_CAPACITY, ...capacity },
        engine: new LookyAnswerEngine({ research: DEFAULT_RESEARCH_LIMITS, deepRounds: 0 }),
        provider: citingModel(),
        executor: "inline",
        ...rest,
      });
      services.push(service);
      return service;
    },
    registration(overrides = {}) {
      return {
        taskId: "task-1",
        sequence: 1,
        clientGeneration: "run-1",
        callerId: "agent-1",
        repositoryId: "pilot",
        sha,
        worktree: { state: "clean" },
        ...overrides,
      };
    },
    async close() {
      for (const service of services) await service.close().catch(() => undefined);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
