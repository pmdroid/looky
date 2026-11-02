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
  {
    // Generated wiki document model (PAS-996). A wiki generation is one
    // immutable page set for exactly one repository, commit, index key and
    // generator fingerprint. `index_build_id` records the index generation the
    // plan was read from; it is provenance, not a foreign key, because index
    // retention may delete that build while the wiki for the commit stays
    // valid. Navigation (`wiki_pages`), page bodies, source references and
    // internal links are separate tables; composite foreign keys keep every
    // parent, link and source inside its own generation. Slug aliases outlive
    // generations so an old link resolves to the same page or to an explicit
    // removed outcome.
    version: 5,
    sql: `CREATE TABLE wiki_generations (
      id TEXT PRIMARY KEY NOT NULL,
      repository_id TEXT NOT NULL,
      sha TEXT NOT NULL,
      index_key TEXT NOT NULL,
      index_build_id TEXT NOT NULL,
      generator_key TEXT NOT NULL,
      generator_config TEXT NOT NULL,
      plan_report TEXT NOT NULL,
      page_count INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'failed', 'cancelled')),
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER CHECK (retryable IN (0, 1)),
      created_at TEXT NOT NULL,
      started_at TEXT,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      retired_at TEXT
    ) STRICT;
    CREATE UNIQUE INDEX wiki_generations_one_ready
      ON wiki_generations (repository_id, sha, index_key, generator_key)
      WHERE state = 'ready' AND retired_at IS NULL;
    CREATE UNIQUE INDEX wiki_generations_one_active
      ON wiki_generations (repository_id, sha, index_key, generator_key)
      WHERE state IN ('queued', 'running');
    CREATE INDEX wiki_generations_repository
      ON wiki_generations (repository_id, state, finished_at);

    CREATE TABLE wiki_pages (
      generation_id TEXT NOT NULL REFERENCES wiki_generations (id) ON DELETE CASCADE,
      page_id TEXT NOT NULL,
      concept_key TEXT NOT NULL,
      slug TEXT NOT NULL,
      kind TEXT NOT NULL
        CHECK (kind IN ('overview', 'architecture', 'section', 'module', 'workflow')),
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      parent_page_id TEXT,
      depth INTEGER NOT NULL CHECK (depth >= 0),
      ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
      scope_path TEXT,
      state TEXT NOT NULL
        CHECK (state IN ('unavailable', 'queued', 'running', 'ready', 'failed', 'cancelled')),
      unavailable_reason TEXT,
      error_message TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (generation_id, page_id),
      UNIQUE (generation_id, slug),
      UNIQUE (generation_id, concept_key),
      FOREIGN KEY (generation_id, parent_page_id)
        REFERENCES wiki_pages (generation_id, page_id) ON DELETE CASCADE,
      CHECK ((parent_page_id IS NULL) = (depth = 0)),
      CHECK ((state = 'unavailable') = (unavailable_reason IS NOT NULL))
    ) STRICT;
    CREATE UNIQUE INDEX wiki_pages_one_root ON wiki_pages (generation_id) WHERE parent_page_id IS NULL;
    CREATE UNIQUE INDEX wiki_pages_sibling_order
      ON wiki_pages (generation_id, parent_page_id, ordinal) WHERE parent_page_id IS NOT NULL;

    CREATE TABLE wiki_page_bodies (
      generation_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      body TEXT NOT NULL CHECK (length(body) > 0),
      body_hash TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      provenance TEXT NOT NULL,
      PRIMARY KEY (generation_id, page_id),
      FOREIGN KEY (generation_id, page_id)
        REFERENCES wiki_pages (generation_id, page_id) ON DELETE CASCADE
    ) STRICT;

    CREATE TABLE wiki_page_sources (
      generation_id TEXT NOT NULL,
      page_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('planned', 'cited')),
      ordinal INTEGER NOT NULL,
      path TEXT NOT NULL,
      blob_oid TEXT NOT NULL,
      start_line INTEGER NOT NULL CHECK (start_line >= 1),
      end_line INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('code', 'test', 'config', 'docs')),
      PRIMARY KEY (generation_id, page_id, role, ordinal),
      FOREIGN KEY (generation_id, page_id)
        REFERENCES wiki_pages (generation_id, page_id) ON DELETE CASCADE,
      CHECK (end_line >= start_line)
    ) STRICT;
    CREATE INDEX wiki_page_sources_path ON wiki_page_sources (generation_id, path);

    CREATE TABLE wiki_page_links (
      generation_id TEXT NOT NULL,
      from_page_id TEXT NOT NULL,
      to_page_id TEXT NOT NULL,
      relation TEXT NOT NULL CHECK (relation IN ('uses', 'related')),
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (generation_id, from_page_id, to_page_id),
      FOREIGN KEY (generation_id, from_page_id)
        REFERENCES wiki_pages (generation_id, page_id) ON DELETE CASCADE,
      FOREIGN KEY (generation_id, to_page_id)
        REFERENCES wiki_pages (generation_id, page_id) ON DELETE CASCADE,
      CHECK (from_page_id != to_page_id)
    ) STRICT;
    CREATE INDEX wiki_page_links_target ON wiki_page_links (generation_id, to_page_id);

    CREATE TABLE wiki_slug_aliases (
      repository_id TEXT NOT NULL,
      slug TEXT NOT NULL,
      page_id TEXT NOT NULL,
      concept_key TEXT NOT NULL,
      title TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, slug)
    ) STRICT;`,
  },
  {
    // Generated wiki prose. Validated page drafts are cached per repository
    // under a key of the page's planned sources, neighbourhood and writer
    // fingerprint, with the blobs they actually inspected, so a retry or a
    // restart reuses finished pages instead of paying for them again.
    // Generations and pages record budgets and usage.
    version: 6,
    sql: `CREATE TABLE wiki_page_drafts (
      repository_id TEXT NOT NULL,
      draft_key TEXT NOT NULL,
      page_id TEXT NOT NULL,
      concept_key TEXT NOT NULL,
      writer_key TEXT NOT NULL,
      body TEXT NOT NULL CHECK (length(body) > 0),
      body_hash TEXT NOT NULL,
      citations TEXT NOT NULL,
      inspected TEXT NOT NULL,
      provenance TEXT NOT NULL,
      usage TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, draft_key)
    ) STRICT;
    CREATE INDEX wiki_page_drafts_used ON wiki_page_drafts (repository_id, last_used_at);

    ALTER TABLE wiki_generations ADD COLUMN budget TEXT;
    ALTER TABLE wiki_generations ADD COLUMN usage TEXT;
    ALTER TABLE wiki_pages ADD COLUMN draft_key TEXT;
    ALTER TABLE wiki_pages ADD COLUMN usage TEXT;`,
  },
  {
    // Documentation search (PAS-999). Sections of the ready pages of a
    // published generation, split at their headings. Every row carries its
    // generation, and every search names one, so results never cross
    // repositories or commits. `wiki_search_generations` marks generations
    // already indexed; generations published before this version are indexed
    // on their first search. Deleting a generation deletes its rows.
    version: 7,
    sql: `CREATE VIRTUAL TABLE wiki_search_fts USING fts5(
      generation_id UNINDEXED, page_id UNINDEXED, anchor UNINDEXED,
      title, heading, body,
      tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"
    );
    CREATE TABLE wiki_search_generations (
      generation_id TEXT PRIMARY KEY NOT NULL
        REFERENCES wiki_generations (id) ON DELETE CASCADE,
      sections INTEGER NOT NULL,
      indexed_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER wiki_search_cleanup AFTER DELETE ON wiki_generations BEGIN
      DELETE FROM wiki_search_fts WHERE generation_id = old.id;
      DELETE FROM wiki_search_generations WHERE generation_id = old.id;
    END;`,
  },
  {
    // Incremental wiki refresh (PAS-998). A generation records the indexed
    // files it was planned from (`wiki_generation_files`), so a later commit
    // can be compared with it even after index retention deleted the build,
    // and the published generation it refreshed from. Pages record the
    // sha-neutral key of their inputs, the blobs they inspected and their
    // structural dependencies, so reuse is verified against the new commit
    // rather than assumed. Documentation search is the PAS-999 index of
    // version 7. Reader leases keep a retired generation readable until the
    // reader is done.
    version: 8,
    sql: `ALTER TABLE wiki_generations ADD COLUMN base_generation_id TEXT;
    ALTER TABLE wiki_generations ADD COLUMN refresh TEXT;
    ALTER TABLE wiki_pages ADD COLUMN input_key TEXT;
    ALTER TABLE wiki_pages ADD COLUMN inspected TEXT;
    ALTER TABLE wiki_pages ADD COLUMN dependencies TEXT;
    ALTER TABLE wiki_pages ADD COLUMN refresh_reason TEXT;

    CREATE TABLE wiki_generation_files (
      generation_id TEXT NOT NULL REFERENCES wiki_generations (id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      blob_oid TEXT NOT NULL,
      PRIMARY KEY (generation_id, path)
    ) STRICT;

    CREATE TABLE wiki_leases (
      id TEXT PRIMARY KEY NOT NULL,
      generation_id TEXT NOT NULL REFERENCES wiki_generations (id) ON DELETE CASCADE,
      acquired_at TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX wiki_leases_generation ON wiki_leases (generation_id, expires_at);`,
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
