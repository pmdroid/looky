import type { Database } from "bun:sqlite";

export interface Migration {
  readonly version: number;
  readonly sql: string;
}

// Append migrations. Never change the SQL of an already released version.
export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `CREATE TABLE app_metadata (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL
    ) STRICT;`,
  },
];

export function schemaVersion(db: Database): number {
  return db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
}

/** Only trusted, synchronous application SQL belongs in this migration list. */
export function migrate(db: Database, steps: readonly Migration[] = migrations): void {
  for (const [index, step] of steps.entries()) {
    if (step.version !== index + 1) {
      throw new Error("Migration versions must be consecutive integers starting at 1");
    }
  }

  // Lock before reading the version so concurrent openers cannot both apply a step.
  db.transaction(() => {
    const current = schemaVersion(db);
    if (current > steps.length) {
      throw new Error(`Database schema ${current} is newer than supported schema ${steps.length}`);
    }
    for (const step of steps) {
      if (step.version <= current) continue;
      db.exec(step.sql);
      db.exec(`PRAGMA user_version = ${step.version}`);
    }
  }).immediate();
}
