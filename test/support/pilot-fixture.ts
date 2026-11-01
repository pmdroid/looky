import { commitAll, git, initRepo, write } from "./git-fixture";

/**
 * A small multi-subsystem repository shaped like the Paws pilot: a crash
 * recovery flow that spans a supervisor, the recovery module, checkpoint
 * storage and retry configuration, with tests, unrelated billing code and
 * a design doc that still describes a function the code no longer has.
 */
export const PILOT_FILES: Readonly<Record<string, string>> = {
  "src/worker/supervisor.ts": `import { resumeInterruptedRun } from "../recovery/recover-run";

/** Watches worker processes and hands crashed runs to recovery. */
export async function onWorkerExit(runId: string, exitCode: number): Promise<void> {
  if (exitCode === 0) return;
  // A non-zero exit means the worker crashed mid-run.
  await resumeInterruptedRun(runId);
}
`,
  "src/recovery/recover-run.ts": `import { loadCheckpoint, type Checkpoint } from "../storage/checkpoints";
import { RETRY_POLICY } from "../config/retry";

export interface RunState {
  readonly runId: string;
  readonly step: number;
}

/** Resume an interrupted run from its newest saved checkpoint. */
export async function resumeInterruptedRun(runId: string): Promise<RunState> {
  const checkpoint = await loadCheckpoint(runId);
  if (!checkpoint) throw new MissingCheckpointError(runId);
  return replayFromCheckpoint(checkpoint, RETRY_POLICY.maxReplayAttempts);
}

export class MissingCheckpointError extends Error {
  constructor(readonly runId: string) {
    super(\`No checkpoint for run \${runId}\`);
  }
}

function replayFromCheckpoint(checkpoint: Checkpoint, attempts: number): RunState {
  // Replays the steps recorded after the checkpoint, at most \`attempts\` times.
  return { runId: checkpoint.runId, step: checkpoint.step + Math.min(attempts, 1) };
}
`,
  "src/storage/checkpoints.ts": `export interface Checkpoint {
  readonly runId: string;
  readonly step: number;
  readonly savedAt: string;
}

const CHECKPOINTS = new Map<string, Checkpoint>();

/** Newest checkpoint for a run, or undefined when none was ever saved. */
export async function loadCheckpoint(runId: string): Promise<Checkpoint | undefined> {
  return CHECKPOINTS.get(runId);
}

export async function saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
  CHECKPOINTS.set(checkpoint.runId, checkpoint);
}
`,
  "src/config/retry.ts": `/** How often recovery replays a run before giving up. */
export const RETRY_POLICY = {
  maxReplayAttempts: 3,
  backoffMs: 500,
} as const;
`,
  "config/recovery.yaml": `recovery:
  max_replay_attempts: 3
  checkpoint_interval_seconds: 30
`,
  "test/recovery.test.ts": `import { resumeInterruptedRun, MissingCheckpointError } from "../src/recovery/recover-run";
import { saveCheckpoint } from "../src/storage/checkpoints";

test("resumes from the newest checkpoint", async () => {
  await saveCheckpoint({ runId: "r1", step: 4, savedAt: "now" });
  expect((await resumeInterruptedRun("r1")).step).toBe(5);
});

test("fails without a checkpoint", async () => {
  await expect(resumeInterruptedRun("missing")).rejects.toBeInstanceOf(MissingCheckpointError);
});
`,
  "docs/recovery.md": `# Recovery

Crashed runs are restarted by \`restartFromSnapshot\`, which reads the latest
snapshot from disk and replays it.

## Settings

Replay attempts are limited by \`max_replay_attempts\` in config/recovery.yaml.
`,
  "src/billing/invoice.ts": `export interface Invoice {
  readonly customerId: string;
  readonly totalCents: number;
}

/** Sum line items into an invoice total. */
export function computeInvoiceTotal(lines: readonly { cents: number }[]): number {
  return lines.reduce((sum, line) => sum + line.cents, 0);
}
`,
  "src/billing/tax.py": `def apply_sales_tax(total_cents, rate):
    return round(total_cents * (1 + rate))


def tax_rate_for_region(region):
    return {"eu": 0.2, "us": 0.07}.get(region, 0.0)
`,
  "README.md": `# Pilot

Workers, recovery and billing for the pilot service.
`,
};

/** Create the pilot repository and return its commit SHA. */
export function buildPilotRepo(repo: string): string {
  initRepo(repo);
  for (const [path, content] of Object.entries(PILOT_FILES)) write(repo, path, content);
  return commitAll(repo, "pilot");
}

/**
 * Second revision: recovery moves to `src/recovery/resume.ts`, the supervisor
 * is deleted, and checkpoints gain a new function. Returns the new SHA.
 */
export function refreshPilotRepo(repo: string): string {
  git(repo, "mv", "src/recovery/recover-run.ts", "src/recovery/resume.ts");
  git(repo, "rm", "--quiet", "src/worker/supervisor.ts");
  write(
    repo,
    "test/recovery.test.ts",
    PILOT_FILES["test/recovery.test.ts"]!.replace(
      "src/recovery/recover-run",
      "src/recovery/resume",
    ),
  );
  write(
    repo,
    "src/storage/checkpoints.ts",
    `${PILOT_FILES["src/storage/checkpoints.ts"]!}
export async function pruneCheckpoints(keep: number): Promise<number> {
  return Math.max(0, CHECKPOINTS.size - keep);
}
`,
  );
  return commitAll(repo, "move recovery");
}
