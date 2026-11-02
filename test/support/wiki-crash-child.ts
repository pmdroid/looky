/**
 * Child process for the wiki interruption test. It writes the first page of a
 * wiki generation, then blocks inside the second page's model call and
 * reports `blocked`. The parent kills it with SIGKILL, so nothing gets to
 * clean up, exactly as in a crash.
 *
 * Usage: bun wiki-crash-child.ts <dataDir> <repo> <repositoryId> <sha>
 */
import { writeSync } from "node:fs";
import { wikiHarness, wikiModel } from "./wiki-fixture";

const [dataDir, repo, repositoryId, sha] = process.argv.slice(2);
if (!dataDir || !repo || !repositoryId || !sha) {
  throw new Error("usage: <dataDir> <repo> <repositoryId> <sha>");
}

const model = wikiModel(undefined, {
  before: async (_call, index) => {
    if (index === 0) return;
    writeSync(1, "blocked\n");
    await new Promise(() => {});
  },
});
const harness = wikiHarness({
  dataDir,
  repositories: (id) => (id === repositoryId ? repo : undefined),
  provider: model,
  settings: { maxConcurrentPages: 1 },
});
const started = await harness.generator.start({ repositoryId, sha });
if (started.state !== "queued")
  throw new Error(`expected a queued generation, got ${started.state}`);
writeSync(1, `generation ${started.generation.id}\n`);
await harness.generator.wait(started.generation.id);
// Reaching this line means the generation finished; the parent fails the test.
writeSync(1, "finished\n");
