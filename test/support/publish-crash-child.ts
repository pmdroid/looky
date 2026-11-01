/**
 * Child process for the kill-before-publish acceptance test. It runs one
 * real index build against the test's database and, once every entry is
 * staged, stops inside the publish transaction, just before the statement
 * that would mark the build ready. The parent then kills it with SIGKILL.
 *
 * Usage: bun publish-crash-child.ts <dataDir> <repo> <repositoryId> <sha> <refresh|rebuild>
 */
import { Database } from "bun:sqlite";
import { writeSync } from "node:fs";
import { IndexService } from "../../src/indexing/index-service";
import { DEFAULT_INDEX_LIMITS } from "../../src/indexing/policy";
import { openDatabase } from "../../src/storage/database";

const [dataDir, repo, repositoryId, sha, mode] = process.argv.slice(2);
if (!dataDir || !repo || !repositoryId || !sha || (mode !== "refresh" && mode !== "rebuild")) {
  throw new Error("usage: <dataDir> <repo> <repositoryId> <sha> <refresh|rebuild>");
}

const PUBLISH = "SET state = 'ready', phase = 'ready'";
const query = Database.prototype.query;
Database.prototype.query = function (this: Database, sql: string) {
  if (sql.includes(PUBLISH)) {
    // Synchronous, so the publish transaction stays open while the parent kills us.
    writeSync(1, "staged\n");
    Bun.sleepSync(120_000);
  }
  return query.call(this, sql);
} as typeof Database.prototype.query;

const db = openDatabase({ dataDir });
const index = new IndexService({
  db,
  repositories: (id) => (id === repositoryId ? repo : undefined),
  // Same limits, and so the same index key, as the acceptance fixture service.
  limits: { ...DEFAULT_INDEX_LIMITS, maxFileBytes: 65_536 },
  executor: "inline",
});
const started = await index.startBuild({ repositoryId, sha }, { rebuild: mode === "rebuild" });
if (started.state !== "building") throw new Error(`expected a build, got ${started.state}`);
const build = await index.waitForBuild(started.build.id);
// Reaching this line means the build published; the parent fails the test.
writeSync(1, `finished ${build.state}\n`);
