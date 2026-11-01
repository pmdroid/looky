# Looky

Bun/TypeScript foundations for Looky's indexed Fast/Deep code answers. This bootstrap
provides tooling and durable SQLite storage. Indexing, retrieval, answers, and MCP
are subsequent work in PAS-966 through PAS-973.

## Prerequisites and installation

Use Bun **1.4.4**, pinned in `mise.toml`, `package.json`, and CI. With
[mise](https://mise.jdx.dev/getting-started.html) installed, run `mise install`,
then activate mise in your shell. Alternatively install that exact Bun version
using the [Bun installation instructions](https://bun.sh/docs/installation).
Confirm `bun --version` prints `1.4.4`.

From a clean checkout, install the committed dependency versions and run every
check with one command:

```sh
bun install --frozen-lockfile && bun run check
```

Installation needs registry access. Checks run locally without provider
credentials, API calls, or external services. Pull request CI uses the same
runtime and commands. Runtime code uses Bun built-ins only.

## Development commands

| Command                | Operation                                                                |
| ---------------------- | ------------------------------------------------------------------------ |
| `bun run check`        | Format check, lint, TypeScript check, and tests, without rewriting files |
| `bun run format:check` | Check formatting with oxfmt                                              |
| `bun run format:fix`   | Rewrite formatting with oxfmt                                            |
| `bun run lint`         | Check with oxlint and reject warnings                                    |
| `bun run lint:fix`     | Apply oxlint's automatic fixes                                           |
| `bun run typecheck`    | Check TypeScript without emitting files                                  |
| `bun test`             | Run isolated database and entrypoint tests                               |
| `bun test --watch`     | Rerun tests during development                                           |
| `bun start`            | Open storage, verify FTS5, migrate, report readiness, and close          |

Tool configurations exclude dependencies, build output, coverage, and local
database/index directories. The formatter also excludes the generated lockfile.

## Local storage

`bun start` creates `.looky/looky.sqlite` relative to the working directory.
Set `LOOKY_DATA_DIR` to choose another directory. Relative paths resolve against
the working directory; an empty value is an error. For example:

```sh
LOOKY_DATA_DIR=/absolute/path/to/looky-data bun start
```

`openDatabase({ dataDir })` also accepts an explicit directory, which takes
precedence over the environment. It creates missing directories and returns a
`bun:sqlite` Database. Call `db.close()` in a `finally` block. Use Bun's
synchronous `db.transaction(() => { ... })()` for atomic writes; thrown errors
roll back the transaction. Do not use async callbacks or swallow errors inside
transactions. Foreign keys are enabled and lock contention waits up to five
seconds before failing. SQLite's default rollback journal provides durable
transactions; no database service or ORM is required.

The trusted SQL migrations in `src/storage/migrations.ts` use SQLite's
`user_version` as their schema version. Append consecutive versions starting at
1, and leave released migration SQL unchanged. A transaction acquires the write
lock before reading the version, applies pending migrations, and advances the
version atomically. Reopening skips applied migrations. Failure rolls back the
whole pending batch, including DDL and version changes. A database from a newer
schema is rejected rather than downgraded. Version 1 only establishes an
`app_metadata` table; the persistent code index belongs to subsequent issues.

Every open creates a temporary FTS5 table, inserts text, and verifies a real
`MATCH` query before dropping the probe. Failure reports that working SQLite
FTS5 support is required. Tests also create a persistent full-text table and
verify search after close/reopen on Bun 1.4.4. The probe does not add documents
to developer data.

Tests create unique directories under the system temporary directory, close
their connections, and remove only those directories. They never use the
developer database, even when `LOOKY_DATA_DIR` is set. The smoke test runs the
entrypoint in a child process with its own temporary data directory.

Generated databases, `.looky/`, `data/`, `index-artifacts/`, and local `.env`
files are ignored. Keep any custom data directory outside the checkout or add
it to your local Git excludes. No secrets are needed for this bootstrap.
