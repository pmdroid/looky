# Looky

Bun/TypeScript foundations for Looky's indexed Fast/Deep code answers. The repository
provides tooling, durable SQLite storage, a persistent codebase index, Fast/Deep
evidence retrieval and the `ask_project` contract described below. Answer synthesis,
index refresh and the MCP server are subsequent work in PAS-968 through PAS-972.

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

| Command                | Operation                                                                         |
| ---------------------- | --------------------------------------------------------------------------------- |
| `bun run check`        | Format check, lint, TypeScript check, and tests, without rewriting files          |
| `bun run format:check` | Check formatting with oxfmt                                                       |
| `bun run format:fix`   | Rewrite formatting with oxfmt                                                     |
| `bun run lint`         | Check with oxlint and reject warnings                                             |
| `bun run lint:fix`     | Apply oxlint's automatic fixes                                                    |
| `bun run typecheck`    | Check TypeScript without emitting files                                           |
| `bun test`             | Run isolated database and entrypoint tests                                        |
| `bun test --watch`     | Rerun tests during development                                                    |
| `bun start`            | Open storage, verify FTS5, migrate, report readiness, and close                   |
| `bun run looky …`      | Build, inspect and search codebase indexes; see [Codebase index](#codebase-index) |

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

## Codebase index

Looky indexes one exact commit of an explicitly authorized local Git repository into
the SQLite database. Only Git objects are read: `git ls-tree` enumerates the commit's
tree and `git cat-file --batch` reads blobs by object id. The worktree, Git index,
checkout filters, textconv, hooks, replace refs, lazy fetches from promisor remotes and
system/global Git config are never used, and no command goes through a shell or runs
repository scripts. Dirty or untracked files therefore never enter an index.

### Building and inspecting indexes

```sh
bun run looky index --repo /path/to/repo --sha <full-commit-sha> [--id <repository-id>] [--rebuild]
bun run looky status [<build-id>] [--id <repository-id>] [--sha <sha>]
bun run looky coverage <build-id> [--excluded]
bun run looky search <build-id> <words…> [--limit <n>]
bun run looky retrieve --repo /path/to/repo --sha <sha> [--id <repository-id>] [--mode fast|deep] [--text] <question…>
bun run looky cancel <build-id>
```

Every command prints JSON and uses `LOOKY_DATA_DIR` like `bun start`. `index` waits
for the build, prints progress to stderr and exits non-zero unless the build is ready.
`--id` defaults to the repository directory name. `coverage` reports indexed files by
language, exclusions by reason and, with `--excluded`, every excluded path. `retrieve`
runs [evidence research](#evidence-retrieval) against the ready index of exactly that
SHA, without calling a model, and prints the evidence bundle; `--text` includes the
source text of each range.

In code, `IndexService` implements the `IndexCatalog` port. Its `repositories`
callback maps an authorized repository id to a local Git directory and refuses unknown
ids; there is no global index. `resolve` returns the ready build for exactly the
requested SHA, or starts or joins one shared build for that scope and returns its
progress. It never substitutes another SHA, though it discloses a ready build of
another SHA as `staleGeneration`. A SHA that is not a commit in the repository is
`unsupported_revision`. `status`, `builds`, `coverage` and `cancel` expose the same
diagnostics as the CLI. `listChunks` and `searchChunks` read ready builds only and
throw `IndexNotReadyError` for anything else.

### Eligibility

Every tracked entry is recorded as `indexed` or `excluded` with one reason. Path rules
run before any bytes are read. Content rules run on the read bytes before anything is
stored. A file with a secret is excluded whole, so no part of it is stored or reaches a
provider, and diagnostics never include the matched value.

| Reason           | Rule                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------- |
| `unsafe_path`    | Absolute, `..`, empty or `.git` segments, backslashes, control characters or non-UTF-8 names    |
| `symlink`        | Symbolic links are never followed                                                               |
| `submodule`      | Gitlinks; their contents are another repository                                                 |
| `dependency`     | Under `node_modules`, `vendor`, `bower_components`, `.yarn`, `.venv` and similar directories    |
| `secret_path`    | `.env*`, `*.env`, keys and certificates such as `*.pem` or `id_rsa`, `.npmrc`, credential files |
| `generated`      | Under `dist`, `build`, `out`, `coverage`, `target` and similar; lockfiles, `*.min.js`, `*.map`  |
| `binary`         | Binary extensions, NUL bytes or invalid UTF-8                                                   |
| `oversized`      | Blob larger than `maxFileBytes`; never read                                                     |
| `empty`          | Empty or whitespace-only content                                                                |
| `long_lines`     | A line longer than `maxLineBytes`, typical of minified or data files                            |
| `secret_content` | Private key blocks, cloud, GitHub, Slack, npm and API tokens, URLs with real passwords          |
| `generated`      | `@generated`, `DO NOT EDIT` or `auto-generated by` in the first lines                           |
| `unreadable`     | The blob is missing from the object database                                                    |

Everything else is indexed: source, tests, configuration and docs in any language.
The full rules are in `src/indexing/policy.ts`.

### Chunks and provenance

Chunks are whole, unmodified source lines. TypeScript and JavaScript break before
top-level declarations, keeping their leading comments and decorators, and record the
declared names as symbols. Markdown breaks before headings. Every other language gets
faithful sliding line windows that overlap by `chunkOverlapLines`. A declaration or
section over the size bounds is split into overlapping windows. No chunk exceeds
`chunkLines` lines or `chunkBytes` bytes.

Each chunk records the repository id, build id, commit SHA, path, blob id, 1-based
inclusive line range, SHA-256 of its text, the text and its symbols. Reading those
lines at that SHA with `GitSourceReader` returns the chunk text byte for byte,
including CRLF line endings and a UTF-8 BOM. Chunk content is stored once per blob and
chunker, so a later build reuses unchanged blobs without reading them again. Full-text
search uses FTS5 over symbols, chunk text and the parts of compound identifiers, so
`getUserById` matches both the whole name and `user`.

### Build lifecycle

| State       | Meaning                                                            | Served |
| ----------- | ------------------------------------------------------------------ | ------ |
| `queued`    | Waiting for a build slot                                           | No     |
| `running`   | Enumerating or indexing; `filesDone`/`filesTotal` show progress    | No     |
| `ready`     | Every tracked entry is recorded; published in a single transaction | Yes    |
| `failed`    | `errorCode` and `retryable` explain why; nothing is published      | No     |
| `cancelled` | Cancelled by a caller, the CLI or service shutdown                 | No     |

Builds run on a worker thread with their own database connection, off the service's
event loop, and at most `LOOKY_INDEX_MAX_CONCURRENT_BUILDS` run at once. Exceeding
`maxFiles` or `maxIndexedBytes` fails the build with `limit_exceeded` rather than
publishing partial coverage. Such deterministic failures are reported to later
requests instead of retried; `index --rebuild` or `startBuild(..., { rebuild: true })`
starts a new attempt. Cancelled and retryable failures start a new build on the next
request. A build cancelled from another process stops at its next batch write.

One process owns index builds for a database. A second `IndexService` on the same
database fails while the owner's process is alive on the same host. On startup, builds
left queued or running by a process that died are marked `failed` with code
`interrupted`, and the next request rebuilds them.

The policy version in `src/indexing/policy.ts` is recorded on every build. Bump it
when eligibility, chunking or symbol extraction changes; builds made under another
version are never served and are rebuilt on request. The schema itself is versioned by
the migrations above.

### Index limits

| Limit               | Default    | Variable                          |
| ------------------- | ---------- | --------------------------------- |
| `maxFileBytes`      | 1048576    | `LOOKY_INDEX_MAX_FILE_BYTES`      |
| `maxLineBytes`      | 4000       | `LOOKY_INDEX_MAX_LINE_BYTES`      |
| `maxFiles`          | 200000     | `LOOKY_INDEX_MAX_FILES`           |
| `maxIndexedBytes`   | 1073741824 | `LOOKY_INDEX_MAX_INDEXED_BYTES`   |
| `chunkLines`        | 80         | `LOOKY_INDEX_CHUNK_LINES`         |
| `chunkBytes`        | 8000       | `LOOKY_INDEX_CHUNK_BYTES`         |
| `chunkOverlapLines` | 8          | `LOOKY_INDEX_CHUNK_OVERLAP_LINES` |
| `readConcurrency`   | 4          | `LOOKY_INDEX_READ_CONCURRENCY`    |

`LOOKY_INDEX_MAX_CONCURRENT_BUILDS` defaults to 1. Values must be positive integers,
except that `chunkOverlapLines` may be 0. `chunkBytes` must be at least `maxLineBytes`
and the overlap must be below `chunkLines`. `maxFiles` and `maxIndexedBytes` also
bound the disk an index uses.

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

| Port            | Implemented by         | Responsibility                                        |
| --------------- | ---------------------- | ----------------------------------------------------- |
| `ClientAdapter` | Client, such as Paws   | Session context, generation, authorization, limits    |
| `IndexCatalog`  | Looky `IndexService`   | Exact-SHA generation lookup and build status          |
| `Retriever`     | Looky `IndexRetriever` | Search within the pinned generation                   |
| `SourceReader`  | Looky or client        | Committed source ranges at the SHA                    |
| `ModelProvider` | Selected provider      | Model calls; `LookyUnavailableError` when unavailable |
| `AnswerEngine`  | Looky (PAS-968)        | Fast or Deep research and synthesis via the session   |

Cancellation flows through the `AbortSignal` passed to every port. `GitSourceReader`
reads blobs with `git cat-file` at the SHA, with the same hardened Git invocation as
the indexer, so it never reads worktree files, checks out, stashes or commits.

## Evidence retrieval

Answer engines gather evidence with `researchEvidence(session)`, which runs on the
guarded `ResearchSession`. Every search and read therefore stays on the request's
repository, SHA and index generation, is re-authorized first and is charged against the
mode budget. Nothing runs shell commands or scripts, fetches URLs or reads another
repository.

### Search

`IndexRetriever` implements the `Retriever` port over the SQLite index. It searches only
a `ready` build of exactly the requested repository and SHA under the current index
policy. Another repository or SHA is a contract violation, and a missing or no longer
ready build is `unavailable`. It never falls back to another build.

Each search combines four lexical channels over code-aware chunks:

- **Paths.** Paths, file names and kebab-case fragments in the question, such as
  `src/ask/session.ts`, `session.ts` or "user service" for `user-service.ts`.
- **Symbols.** Declarations the indexer recorded, matched in any common spelling.
  `getUserById`, `GetUserById`, `get_user_by_id`, `GET_USER_BY_ID` and `get-user-by-id`
  are the same identifier, and adjacent question words can spell one.
- **Definitions.** A language-agnostic heuristic for `function`, `def`, `fn`, `func`,
  `class`, assignments, methods and configuration keys, so languages without symbol
  extraction can still be followed. Imports never count as definitions.
- **Full text.** BM25 over symbols, identifier parts and chunk text. Question words
  are stemmed and expanded with a small table of code synonyms, such as resume,
  restart and recover. All user text is quoted, never parsed as FTS5 syntax.

Results are reranked by how many question concepts a chunk covers. Tests and docs rank
slightly below code unless the question asks about them. A hit inside a better hit of
the same file is dropped, and one file contributes at most three hits per pass. Options
narrow a pass to `kinds` (`code`, `test`, `config`, `docs`), definitions of a name,
references to a name, a path prefix or excluded paths. Hits carry repository, SHA,
generation, path, line range, chunk content hash, blob id, kind, symbols and the
channels that matched.

### Fast and Deep research

| Mode | Research                                                                                                                                                                                                                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fast | One ranked pass for the question, reads of the best hits, then at most one companion lead: a definition the question names, a question-related definition the top code uses, or its tests. Docs claims it did not check are listed as gaps.                                                             |
| Deep | The same first pass, then a priority queue of leads: definitions named by the question or used near question terms, a query refined with symbols found, call sites, tests, docs claims checked against code, configuration and docs, and other definitions. Follow-ups are found up to two levels deep. |

Fast never runs Deep's plan and never upgrades itself. When leads remain or nothing
matched, the bundle sets `suggestDeep` and lists them as `not_followed` in the trace.

Each read covers only lines no earlier evidence covered, so overlapping chunks are read
once. Before a read becomes evidence, its text must equal the indexed chunk lines byte
for byte, and the content hash must match for a whole chunk. A mismatch or a range that
no longer exists is reported as a gap and never cited. Evidence records repository,
SHA, generation, path, exact line range, SHA-256 of the inspected bytes, blob id, kind,
symbols, text, the reason it was read and its pass. `evidenceRefs(bundle.evidence)`
turns evidence into citations that `ask_project` accepts.

The bundle also carries:

- **`gaps`.** Truthful statements of what was not established, such as no matching
  source, a definition the question names that the index lacks, or a limit reached.
- **`conflicts`.** Docs that mention an identifier no indexed code or configuration at
  this revision defines. The docs range and the code stay in the evidence.
- **`trace`.** Every pass with purpose, query, options and hit count, every read with
  its outcome (`evidence`, `covered`, `missing` or `mismatch`), and leads not followed.
- **`usage`, `limits` and `stop`.** Passes, reads, bytes and elapsed time, the limits in
  force and whether research completed or stopped at a limit or the time limit.

If lexical retrieval misses the context, the result is an empty or partial bundle with
gaps. Engines must not explain what the evidence does not show.

### Research limits

Research limits are separate from, and clamped to, the remaining mode budget, so
synthesis keeps the rest. Each is enforced on its own; reaching one stops research with
`stop: { reason: "limit", limit }` and a gap.

<!-- research-limits:start -->

| Limit            | Fast  | Deep   | Fast variable                           |
| ---------------- | ----- | ------ | --------------------------------------- |
| `maxPasses`      | 2     | 8      | `LOOKY_FAST_RESEARCH_MAX_PASSES`        |
| `maxReads`       | 6     | 36     | `LOOKY_FAST_RESEARCH_MAX_READS`         |
| `maxReadBytes`   | 49152 | 393216 | `LOOKY_FAST_RESEARCH_MAX_READ_BYTES`    |
| `maxReadLines`   | 120   | 160    | `LOOKY_FAST_RESEARCH_MAX_READ_LINES`    |
| `maxHitsPerPass` | 8     | 16     | `LOOKY_FAST_RESEARCH_MAX_HITS_PER_PASS` |
| `maxElapsedMs`   | 10000 | 90000  | `LOOKY_FAST_RESEARCH_MAX_ELAPSED_MS`    |

<!-- research-limits:end -->

Deep variables use the `LOOKY_DEEP_RESEARCH_` prefix. `loadResearchConfig()` reads them.
Values must be positive integers, Deep must be at least as large as Fast in every limit,
and Deep must allow more passes.
