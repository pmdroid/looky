import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { WikiPlan } from "../src/wiki/model";
import { buildPilotRepo } from "./support/pilot-fixture";

const CLI = resolve(import.meta.dir, "../src/cli.ts");
let root: string;
let repo: string;
let sha: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "looky-wiki-cli-"));
  repo = join(root, "pilot");
  mkdirSync(repo);
  sha = buildPilotRepo(repo);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

async function cli(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, LOOKY_DATA_DIR: join(root, "data"), ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("wiki plan prints a bounded plan with coverage for a ready index, without storing it", async () => {
  const missing = await cli(["wiki", "plan", "--repo", repo, "--sha", sha, "--id", "pilot"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("No ready index");

  expect((await cli(["index", "--repo", repo, "--sha", sha, "--id", "pilot"])).code).toBe(0);
  const planned = await cli(["wiki", "plan", "--repo", repo, "--sha", sha, "--id", "pilot"], {
    LOOKY_WIKI_MAX_PAGES: "6",
  });
  expect(planned.code).toBe(0);
  const plan = JSON.parse(planned.stdout) as WikiPlan;
  expect(plan).toMatchObject({ repositoryId: "pilot", sha, limits: { maxPages: 6 } });
  expect(plan.pages.length).toBeLessThanOrEqual(6);
  expect(plan.pages[0]!.slug).toBe("overview");
  expect(plan.coverage.modules).toEqual({ found: 5, planned: 2 });
  expect(plan.disclosures.map((item) => item.code)).toContain("modules_truncated");

  const status = await cli(["wiki", "status", "--id", "pilot"]);
  expect(JSON.parse(status.stdout)).toEqual([]);
  const unknown = await cli(["wiki", "index", "wiki_missing", "--id", "pilot"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("Unknown wiki generation");
}, 60_000);
