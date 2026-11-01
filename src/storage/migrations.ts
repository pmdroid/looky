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
  {
    // Persistent codebase index (PAS-967). Builds publish atomically by moving
    // to 'ready'; only ready builds are served. Chunked content is stored once
    // per (blob, chunker) so unchanged blobs are never re-read or re-chunked.
    version: 2,
    sql: `CREATE TABLE index_builds (
      id TEXT PRIMARY KEY NOT NULL,
      repository_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed', 'cancelled')),
      phase TEXT NOT NULL,
      files_total INTEGER NOT NULL DEFAULT 0,
      files_done INTEGER NOT NULL DEFAULT 0,
      files_indexed INTEGER NOT NULL DEFAULT 0,
      files_excluded INTEGER NOT NULL DEFAULT 0,
      files_reused INTEGER NOT NULL DEFAULT 0,
      chunk_count INTEGER NOT NULL DEFAULT 0,
      indexed_bytes INTEGER NOT NULL DEFAULT 0,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER CHECK (retryable IN (0, 1)),
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX index_builds_one_ready
      ON index_builds (repository_id, sha, policy_version) WHERE state = 'ready';
    CREATE UNIQUE INDEX index_builds_one_active
      ON index_builds (repository_id, sha, policy_version) WHERE state IN ('queued', 'running');
    CREATE INDEX index_builds_scope ON index_builds (repository_id, sha, created_at);

    CREATE TABLE index_contents (
      id INTEGER PRIMARY KEY,
      blob_oid TEXT NOT NULL,
      chunker TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      line_count INTEGER NOT NULL,
      chunk_count INTEGER NOT NULL,
      UNIQUE (blob_oid, chunker)
    ) STRICT;

    CREATE TABLE index_chunks (
      id INTEGER PRIMARY KEY,
      content_id INTEGER NOT NULL REFERENCES index_contents (id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      text TEXT NOT NULL,
      symbols TEXT NOT NULL,
      terms TEXT NOT NULL,
      UNIQUE (content_id, ordinal)
    ) STRICT;

    CREATE TABLE index_files (
      build_id TEXT NOT NULL REFERENCES index_builds (id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('indexed', 'excluded')),
      reason TEXT,
      language TEXT,
      blob_oid TEXT,
      mode TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      content_id INTEGER REFERENCES index_contents (id),
      PRIMARY KEY (build_id, path),
      CHECK ((status = 'indexed') = (content_id IS NOT NULL AND reason IS NULL))
    ) STRICT;
    CREATE INDEX index_files_content ON index_files (content_id);

    CREATE VIRTUAL TABLE index_chunks_fts USING fts5(
      symbols, terms, text,
      content = 'index_chunks', content_rowid = 'id',
      tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
    );
    CREATE TRIGGER index_chunks_fts_insert AFTER INSERT ON index_chunks BEGIN
      INSERT INTO index_chunks_fts (rowid, symbols, terms, text)
        VALUES (new.id, new.symbols, new.terms, new.text);
    END;
    CREATE TRIGGER index_chunks_fts_delete AFTER DELETE ON index_chunks BEGIN
      INSERT INTO index_chunks_fts (index_chunks_fts, rowid, symbols, terms, text)
        VALUES ('delete', old.id, old.symbols, old.terms, old.text);
    END;`,
  },
  {
    // Versioned refresh lifecycle (PAS-972). Builds are keyed by repository,
    // SHA and index key (policy version plus output-affecting limits). Builds
    // from version 2 carry the key 'legacy', so they are never served and are
    // rebuilt on request. A published build is retired when a newer build of
    // the same scope publishes or retention evicts it; it stays readable by
    // lease holders until garbage collection deletes it. Readers hold leases
    // so retention never deletes a generation in use.
    version: 3,
    sql: `ALTER TABLE index_builds ADD COLUMN index_key TEXT NOT NULL DEFAULT 'legacy';
    ALTER TABLE index_builds ADD COLUMN requested_mode TEXT NOT NULL DEFAULT 'auto'
      CHECK (requested_mode IN ('auto', 'full'));
    ALTER TABLE index_builds ADD COLUMN refresh_mode TEXT
      CHECK (refresh_mode IN ('full', 'incremental'));
    ALTER TABLE index_builds ADD COLUMN refresh_reason TEXT;
    ALTER TABLE index_builds ADD COLUMN base_build_id TEXT;
    ALTER TABLE index_builds ADD COLUMN base_sha TEXT;
    ALTER TABLE index_builds ADD COLUMN files_added INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE index_builds ADD COLUMN files_modified INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE index_builds ADD COLUMN files_deleted INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE index_builds ADD COLUMN files_renamed INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE index_builds ADD COLUMN files_carried INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE index_builds ADD COLUMN retired_at TEXT;
    ALTER TABLE index_builds ADD COLUMN last_used_at TEXT;

    DROP INDEX index_builds_one_ready;
    DROP INDEX index_builds_one_active;
    CREATE UNIQUE INDEX index_builds_one_ready
      ON index_builds (repository_id, sha, index_key) WHERE state = 'ready' AND retired_at IS NULL;
    CREATE UNIQUE INDEX index_builds_one_active
      ON index_builds (repository_id, sha, index_key) WHERE state IN ('queued', 'running');
    CREATE INDEX index_builds_repository_ready
      ON index_builds (repository_id, index_key, state, retired_at);

    CREATE TABLE index_leases (
      id TEXT PRIMARY KEY NOT NULL,
      build_id TEXT NOT NULL REFERENCES index_builds (id) ON DELETE CASCADE,
      acquired_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX index_leases_build ON index_leases (build_id, expires_at);`,
  },
  {
    // Client sessions for the MCP service (PAS-969). A trusted client adapter
    // registers one session per task generation; agents present its token.
    // At most one session per client task is active. A higher sequence
    // supersedes it, so obsolete generations are fenced. `registration` is the
    // validated JSON the adapter sent; it never contains credentials.
    version: 4,
    sql: `CREATE TABLE client_sessions (
      id TEXT PRIMARY KEY NOT NULL,
      client_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      repository_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      registration TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'superseded', 'revoked', 'expired')),
      created_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      ended_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX client_sessions_one_active
      ON client_sessions (client_id, task_id) WHERE state = 'active';
    CREATE UNIQUE INDEX client_sessions_sequence
      ON client_sessions (client_id, task_id, sequence);
    CREATE INDEX client_sessions_scope
      ON client_sessions (repository_id, sha, state, expires_at);`,
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
