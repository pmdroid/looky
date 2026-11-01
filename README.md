# Looky

Bun/TypeScript foundations for Looky's indexed Fast/Deep code answers. The repository
provides tooling, durable SQLite storage and the `ask_project` contract described below.
Indexing, retrieval, answer synthesis and the MCP server are subsequent work in PAS-967
through PAS-973.

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

## The ask_project contract

`ask_project({ question, mode?: "fast" | "deep" })` is the single tool for indexed
code questions. The contract, validated types and enforcing orchestrator live in
`src/contract/` and `src/ask/`; `src/index.ts` exports them for clients and engines.

### Arguments and trusted context

Tool arguments contain only `question` and `mode`. `mode` defaults to `fast`; `deep`
must be requested explicitly. Empty questions, questions over the configured length
and any other argument, such as `repositoryId` or `sha`, are rejected as
`invalid_request`. Arguments can never select a repository, revision or client scope.

A client adapter derives a `LookyRequestContext` from its authenticated session:
client id and generation (for Paws, the task/run generation), caller id, authorized
repository and optional snapshot, the exact committed SHA, the display-only ref it
came from and whether the worktree was dirty. Only full lowercase commit SHAs are
accepted; branch names and short SHAs return `unsupported_revision`. The adapter
resolves the SHA once. Looky never re-resolves the ref, so branch movement during a
request has no effect.

The adapter's `authorize` runs before index lookup, before every retrieval, source
read and model call, and before delivery. A denial returns `denied` with reason
`unauthorized`, `revoked` or `stale_session`, and no answer text is delivered after
revocation. A malformed context fails closed as `denied` with `invalid_context`.

### Pinned index generation

The `IndexCatalog` port resolves exactly one generation for the repository and SHA.
A generation for any other SHA is refused as a contract violation. If no ready
generation exists, the response is `indexing` with the request id, build id,
progress, `retryAfterMs` and any stale generation that was deliberately not used.
Index failures return `failed` with stage `index` and the build id. Engines receive
only a guarded `ResearchSession` that pins repository, SHA and generation, rejects
retrieval hits from another generation and refuses calls after the request ends.

### Responses

Every response carries `requestId`, `mode: { requested, executed }` and explicit
`limitations`. `executed` is null when no research ran and otherwise equals
`requested`; Looky never upgrades or downgrades a mode.

| Status                 | Meaning                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `answered`             | Complete prose answer with outcome, evidence and identity      |
| `invalid_request`      | Arguments failed validation                                    |
| `denied`               | Unauthorized, revoked, stale session or invalid context        |
| `unsupported_revision` | The revision is not an exact committed SHA the index can serve |
| `indexing`             | No ready index for the SHA yet; retry with the given build id  |
| `failed`               | Index or answer failure, including `budget_exhausted`          |
| `unavailable`          | A dependency, such as the provider, cannot serve right now     |
| `cancelled`            | The caller cancelled the request                               |
| `timed_out`            | The mode's elapsed-time limit was reached                      |

Only `answered` has `answer.text`. Its `answer.outcome` is `supported`, `partial`,
`conflicting` or `unknown`. `unknown` is a factual result about the indexed code,
distinct from execution failures. Evidence references are separate metadata and
must lie within source ranges the session read at the pinned SHA. Non-`unknown`
outcomes require evidence. Text consisting only of code snippets is rejected. A
Fast answer may set `suggestedMode: "deep"`; the caller decides whether to retry.

`scope` states that only committed source at the SHA was used and whether
uncommitted changes were `none`, `excluded` or `unknown`. Dirty and unknown
worktrees, and the ref the SHA came from, are disclosed in `limitations`.

The MCP result from `callAskProjectTool` puts the answer prose, or a "Not answered"
status message, in `content` and the full typed response in `structuredContent`.
Every status except `answered` sets `isError`.

### Mode budgets

Each request runs under finite limits enforced by the guarded session. Exceeding
one returns `failed` with `code: "budget_exhausted"` and `exhaustedLimit`, plus
`suggestedMode: "deep"` for Fast. Engines can check `session.remaining()` to stop
early with a `partial` answer instead. Elapsed time covers the whole request.

<!-- budgets:start -->

| Limit                | Fast  | Deep   | Fast variable                     |
| -------------------- | ----- | ------ | --------------------------------- |
| `maxRetrievalPasses` | 2     | 8      | `LOOKY_FAST_MAX_RETRIEVAL_PASSES` |
| `maxResultsPerPass`  | 10    | 20     | `LOOKY_FAST_MAX_RESULTS_PER_PASS` |
| `maxSourceReads`     | 8     | 48     | `LOOKY_FAST_MAX_SOURCE_READS`     |
| `maxSourceBytes`     | 65536 | 524288 | `LOOKY_FAST_MAX_SOURCE_BYTES`     |
| `maxModelCalls`      | 2     | 10     | `LOOKY_FAST_MAX_MODEL_CALLS`      |
| `maxInputTokens`     | 24000 | 200000 | `LOOKY_FAST_MAX_INPUT_TOKENS`     |
| `maxOutputTokens`    | 1500  | 8000   | `LOOKY_FAST_MAX_OUTPUT_TOKENS`    |
| `maxAnswerChars`     | 6000  | 24000  | `LOOKY_FAST_MAX_ANSWER_CHARS`     |
| `maxElapsedMs`       | 30000 | 180000 | `LOOKY_FAST_MAX_ELAPSED_MS`       |

<!-- budgets:end -->

Deep variables use the `LOOKY_DEEP_` prefix. Values must be positive integers.
Deep must be at least as large as Fast in every limit and allow more retrieval
passes. `LOOKY_MAX_QUESTION_CHARS` (default 4000) and `LOOKY_INDEX_RETRY_AFTER_MS`
(default 5000) configure question length and the indexing retry hint. A client
adapter's `budgetLimits` can only tighten these limits, never raise them.

### Adapter boundary

| Port            | Implemented by        | Responsibility                                        |
| --------------- | --------------------- | ----------------------------------------------------- |
| `ClientAdapter` | Client, such as Paws  | Session context, generation, authorization, limits    |
| `IndexCatalog`  | Looky index (PAS-967) | Exact-SHA generation lookup and build status          |
| `Retriever`     | Looky (PAS-973)       | Search within the pinned generation                   |
| `SourceReader`  | Looky or client       | Committed source ranges at the SHA                    |
| `ModelProvider` | Selected provider     | Model calls; `LookyUnavailableError` when unavailable |
| `AnswerEngine`  | Looky (PAS-968)       | Fast or Deep research and synthesis via the session   |

Cancellation flows through the `AbortSignal` passed to every port. `GitSourceReader`
reads blobs with `git cat-file` at the SHA, so it never reads worktree files, checks
out, stashes or commits.
