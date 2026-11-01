import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, verifyFullTextSupport } from "../src/storage/database";
import { migrate, migrations, schemaVersion } from "../src/storage/migrations";

describe("file-backed SQLite", () => {
  let directory: string;
  const connections: Database[] = [];

  function open(): Database {
    const db = openDatabase({ dataDir: directory });
    connections.push(db);
    return db;
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "looky-test-"));
  });

  afterEach(() => {
    try {
      for (const db of connections.splice(0)) db.close();
    } finally {
      // Only remove the directory this test created, never LOOKY_DATA_DIR.
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("opens a real file, closes, and retains data after reopen", () => {
    const db = open();
    expect(existsSync(join(directory, "looky.sqlite"))).toBe(true);
    db.query("INSERT INTO app_metadata VALUES (?, ?)").run("test", "durable");
    db.close();
    expect(() => db.query("SELECT 1").get()).toThrow();
    expect(open().query("SELECT value FROM app_metadata WHERE key = 'test'").get()).toEqual({
      value: "durable",
    });
  });

  test("commits transactions and rolls back every write on failure", () => {
    const db = open();
    db.transaction(() => db.exec("INSERT INTO app_metadata VALUES ('committed', 'yes')"))();
    expect(() =>
      db.transaction(() => {
        db.exec("INSERT INTO app_metadata VALUES ('partial', 'no')");
        db.exec("INSERT INTO app_metadata VALUES ('committed', 'duplicate')");
      })(),
    ).toThrow();
    expect(db.query("SELECT key FROM app_metadata").all()).toEqual([{ key: "committed" }]);
  });

  test("migrations are idempotent and preserve existing data", () => {
    const db = open();
    db.exec("INSERT INTO app_metadata VALUES ('keep', 'value')");
    migrate(db);
    migrate(db);
    expect(schemaVersion(db)).toBe(migrations.length);
    expect(db.query("SELECT * FROM app_metadata").all()).toHaveLength(1);
    db.close();
    expect(schemaVersion(open())).toBe(migrations.length);
  });

  test("failed migrations roll back DDL, data, and schema version", () => {
    const db = open();
    expect(() =>
      migrate(db, [
        ...migrations,
        {
          version: migrations.length + 1,
          sql: "CREATE TABLE partial (id INTEGER); INSERT INTO app_metadata VALUES ('partial', 'no');",
        },
        { version: migrations.length + 2, sql: "INSERT INTO missing_table VALUES (1)" },
      ]),
    ).toThrow();
    expect(schemaVersion(db)).toBe(migrations.length);
    expect(db.query("SELECT * FROM app_metadata").all()).toEqual([]);
    expect(db.query("SELECT name FROM sqlite_master WHERE name = 'partial'").all()).toEqual([]);
    migrate(db, [
      ...migrations,
      { version: migrations.length + 1, sql: "CREATE TABLE recovered (id INTEGER)" },
    ]);
    expect(schemaVersion(db)).toBe(migrations.length + 1);
  });

  test("rejects future schemas and invalid migration ordering", () => {
    const db = open();
    expect(() => migrate(db, [{ version: 2, sql: "SELECT 1" }])).toThrow("consecutive");
    db.exec("PRAGMA user_version = 99");
    db.close();
    expect(() => open()).toThrow("newer than supported");
    const raw = new Database(join(directory, "looky.sqlite"));
    connections.push(raw);
    expect(schemaVersion(raw)).toBe(99);
  });

  test("FTS5 indexes, retrieves, and persists a real full-text table", () => {
    const db = open();
    verifyFullTextSupport(db);
    verifyFullTextSupport(db);
    db.exec("CREATE VIRTUAL TABLE documents USING fts5(body)");
    db.query("INSERT INTO documents(body) VALUES (?)").run("durable repository indexing");
    db.close();
    expect(
      open().query("SELECT body FROM documents WHERE documents MATCH 'repository'").all(),
    ).toEqual([{ body: "durable repository indexing" }]);
  });

  test("reports missing full-text support clearly", () => {
    const db = open();
    db.exec("PRAGMA query_only = ON");
    expect(() => verifyFullTextSupport(db)).toThrow("requires SQLite FTS5");
  });

  test("entrypoint smoke uses an explicit directory", () => {
    const result = Bun.spawnSync([process.execPath, "run", "src/main.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, LOOKY_DATA_DIR: directory },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain(`schema ${migrations.length}, FTS5 verified`);
    expect(existsSync(join(directory, "looky.sqlite"))).toBe(true);
  });

  test("rejects empty directory configuration", () => {
    expect(() => openDatabase({ dataDir: " " })).toThrow("must not be empty");
  });
});
