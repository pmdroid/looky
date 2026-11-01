import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { migrate } from "./migrations";

/** Exercise the actual SQLite extension, rather than trusting compile flags. */
export function verifyFullTextSupport(db: Database): void {
  try {
    db.exec("CREATE VIRTUAL TABLE temp.looky_fts_probe USING fts5(body)");
    db.query("INSERT INTO temp.looky_fts_probe(body) VALUES (?)").run("looky capability probe");
    const result = db
      .query<{ body: string }, [string]>(
        "SELECT body FROM temp.looky_fts_probe WHERE looky_fts_probe MATCH ?",
      )
      .get("capability");
    if (result?.body !== "looky capability probe") throw new Error("FTS5 search returned no match");
  } catch (cause) {
    throw new Error(
      "Looky requires SQLite FTS5 with working insert/search support. Use Bun 1.4.4.",
      {
        cause,
      },
    );
  } finally {
    db.exec("DROP TABLE IF EXISTS temp.looky_fts_probe");
  }
}

export function openDatabase(options: { dataDir?: string } = {}): Database {
  const configuredDir = options.dataDir ?? process.env.LOOKY_DATA_DIR ?? ".looky";
  if (!configuredDir.trim()) throw new Error("LOOKY_DATA_DIR must not be empty");
  const dataDir = resolve(configuredDir);
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new Database(join(dataDir, "looky.sqlite"), { create: true, strict: true });
  try {
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    verifyFullTextSupport(db);
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
