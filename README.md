# Looky

Bun/TypeScript foundations for Looky's indexed Fast/Deep code answers. The repository
provides tooling, durable SQLite storage, a persistent codebase index with versioned
refresh and recovery, Fast/Deep evidence retrieval,
[natural-language answers](#answers) through a [configurable model
provider](#model-providers), the `ask_project` contract described below and Looky's own
[MCP service](#mcp-service) that agents connect to, with a same-origin
[browser API](#browser-access) for people.

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
runtime and commands. The service's runtime code uses Bun built-ins only. React is a
development dependency, bundled into the [browser app](#the-browser-app) at build time.

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
| `bun run serve`        | Run the [MCP service](#mcp-service) over HTTP                                     |
| `bun run web:build`    | Build the [browser app](#the-browser-app) into `dist/web`                         |
| `bun run web:dev`      | Rebuild the browser app on change and run `serve` with it                         |
| `bun run looky …`      | Build, inspect and search codebase indexes; see [Codebase index](#codebase-index) |

Tool configurations exclude dependencies, build output, coverage, and local
database/index directories. The formatter also excludes the generated lockfile.

### Acceptance tests

`test/acceptance` verifies the release end to end. Each test uses a real temporary
Git repository, real SQLite storage and the real HTTP MCP endpoint and operational
API. Only the model provider is scripted, so no test calls Linear, GitHub or a model.
The tests check delivered evidence and every line shown to a model against
`git cat-file` at the pinned commit, so they check budgets and grounding without
scoring answer quality.

| File                | Covers                                                                                                                                                                          |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lifecycle.test.ts` | Initial indexing, restart reuse, rebuild, failed-build retry, a process killed inside the publish transaction, stale and lost indexes                                           |
| `freshness.test.ts` | Incremental add, edit, delete and rename with chunk reuse; concurrent old and new revisions; a branch advancing during Deep research                                            |
| `grounding.test.ts` | Dirty worktrees, unsupported revisions, excluded and oversized files, coverage, prompt injection, fabricated citations, unsupported rationale, complete answers versus snippets |
| `safety.test.ts`    | Repository and workspace isolation, revocation, path escapes, Fast and Deep budgets, quota, cancellation, retry, duplicates, stale generations, one-slot admission              |

The kill test runs `test/support/publish-crash-child.ts` in a child process. The
child builds a real index, stops inside the publish transaction once every entry is
staged, and is killed with `SIGKILL`.

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

## MCP service

Looky serves `ask_project` through its own MCP server. It needs no Paws process.

| Entrypoint                       | Transport                                     | Who supplies the trusted context              |
| -------------------------------- | --------------------------------------------- | --------------------------------------------- |
| `bun run serve`                  | MCP Streamable HTTP at `/mcp`, JSON responses | A client adapter registers a session per task |
| `bun run looky mcp --repo <dir>` | MCP over stdio, one JSON-RPC message per line | The local user; `--ref` (default `HEAD`)      |

Both expose two tools. `ask_project` takes only `question` and `mode`. `index_status`
reports the index of the session's own repository and SHA and starts nothing. The server
speaks MCP `2025-06-18`, `2025-03-26` and `2024-11-05`, handles `notifications/cancelled`
and returns the typed response in `structuredContent`.

### Local use over stdio

```sh
LOOKY_PROVIDER=… bun run looky mcp --repo /path/to/repo [--id <repository-id>] [--ref HEAD]
```

Each call resolves `--ref` to a commit once and pins it, so new commits are picked up by
the next question. Uncommitted changes are never read and the answer discloses the
worktree state as unknown. An MCP client configuration looks like this:

```json
{
  "mcpServers": {
    "looky": {
      "command": "bun",
      "args": ["run", "/path/to/looky/src/cli.ts", "mcp", "--repo", "/path/to/repo"],
      "env": { "LOOKY_DATA_DIR": "/path/to/looky-data", "LOOKY_PROVIDER": "…" }
    }
  }
}
```

The stdio process owns index builds for its data directory. Give it its own
`LOOKY_DATA_DIR`, or stop `serve` on that directory first; a second owner on the same
host is refused with an explicit error.

### Running the HTTP service

```sh
LOOKY_DATA_DIR=/var/lib/looky \
LOOKY_REPOSITORIES=paws-app \
LOOKY_REPOSITORY_PAWS_APP_PATH=/var/lib/looky/repos/paws-app.git \
LOOKY_REPOSITORY_PAWS_APP_FETCH_REMOTE=origin \
LOOKY_CLIENTS=paws \
LOOKY_CLIENT_PAWS_TOKEN=<random secret, at least 32 characters> \
LOOKY_CLIENT_PAWS_REPOSITORIES=paws-app \
LOOKY_PROVIDER=… \
bun run serve
```

It listens on `127.0.0.1:7341` by default and stops on SIGINT or SIGTERM. `GET /healthz`
needs no token and reports the protocol versions.

| Variable                             | Meaning                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------- |
| `LOOKY_HOST`, `LOOKY_PORT`           | Listen address, default `127.0.0.1` and `7341`                            |
| `LOOKY_REPOSITORIES`                 | Comma-separated repository ids this service may index                     |
| `LOOKY_REPOSITORY_<ID>_PATH`         | Local Git directory of that repository on this host, bare or not          |
| `LOOKY_REPOSITORY_<ID>_FETCH_REMOTE` | Optional remote to fetch an exact missing commit from                     |
| `LOOKY_CLIENTS`                      | Comma-separated client adapter ids, such as `paws`                        |
| `LOOKY_CLIENT_<ID>_TOKEN`            | The adapter's secret, at least 32 characters                              |
| `LOOKY_CLIENT_<ID>_REPOSITORIES`     | Repository ids the adapter may register sessions for, or `*`              |
| `LOOKY_ALLOWED_ORIGINS`              | Browser origins allowed to call; requests with any other `Origin` get 403 |

`<ID>` is the id upper-cased, with `-` and `.` written as `_`. Provider, index, budget
and research variables are the same as for the CLI. Every setting is validated before
storage is opened.

### Ownership, storage and host

One Looky service process owns the index of its `LOOKY_DATA_DIR`, on the host it runs
on. Builds run on that process's worker threads, never on a client's runner.
`GET /v1/service` and every session registration report the host, process id, data
directory and index key, so it is explicit where an index lives.

A repository's index is reachable wherever the service is reachable. A client on any
host connects to the same service URL instead of assuming a local cache. When a client
asks for a commit the service's clone does not have yet, such as a commit pushed from
another machine, a configured `FETCH_REMOTE` fetches exactly that commit before
indexing. The fetch is shared and limited by `LOOKY_FETCH_TIMEOUT_MS`, but a request waits
for it only within its index wait. If the wait ends first, the result is `unavailable`
with `code: "fetching_revision"` and `retryAfterMs`. Without a fetch remote, the request
is `unsupported_revision`. Looky never substitutes another SHA. The fetch runs with hooks disabled and the `ext` transport refused, writes
no refs, and uses only credentials the clone itself is configured with. Point
`_PATH` at a clone Looky owns when you enable fetching.

### Client adapters and sessions

A client adapter, such as Paws, holds the client token and never gives it to an agent.
For each task generation it registers a session with the trusted context it derived:

```http
POST /v1/sessions
Authorization: Bearer <client token>
Looky-Protocol-Version: 1

{
  "taskId": "PAS-123",
  "sequence": 4,
  "clientGeneration": "run-4",
  "callerId": "agent-run-4",
  "repositoryId": "paws-app",
  "sha": "<full commit SHA>",
  "ref": "main",
  "worktree": { "state": "dirty", "changedPaths": 3 },
  "providerPolicy": { "selected": "local", "fallback": ["hosted"] },
  "budgetLimits": { "deep": { "maxModelCalls": 6 } }
}
```

The response holds a session `token`, the session, the index status and the service
location. The agent's MCP client connects to `<service URL>/mcp` with
`Authorization: Bearer <session token>`. Arguments still carry only the question and
mode; repository, SHA and scope always come from the session.

- **Prewarm.** Registration starts or joins the index build for the SHA, so it runs while the agent works.
- **Fencing.** Each client task has at most one active session. A higher `sequence` supersedes the previous one; its in-flight questions stop, and its later calls and results are denied as `stale_session`. A lower sequence is refused with 409.
- **Duplicate delivery.** Repeating a registration with the same sequence and body returns the same session and token. The same sequence with a different body is refused with 409.
- **Provider policy.** `providerPolicy` chooses among providers this service configured. Registration fails if it names another. `budgetLimits` can only tighten budgets. Unknown fields, such as an API key, are rejected and never echoed or stored.
- **Lifetime.** Sessions expire after `LOOKY_SESSION_TTL_MS` (default 12 hours). Tokens survive a service restart. Revoke a session with `DELETE /v1/sessions/:id` when the task generation ends.

Revocation, expiry or supersession also cancels the session's index build when no other
live session needs that repository and SHA and no operator started it. A build shared
with another session keeps running. Ready indexes are never deleted by this.

`src/client/looky-client.ts` is a dependency-free typed client for this API. Its
`LookyClient.connect` refuses a service that does not speak protocol version `1`. A
service refuses requests without a supported `Looky-Protocol-Version` header with
`unsupported_protocol_version`.

### Operational API

Every route needs the client token and the protocol header, and works only on the
client's authorized repositories. A build of another repository is reported as not found.

| Route                            | Operation                                                                 |
| -------------------------------- | ------------------------------------------------------------------------- |
| `GET /v1/service`                | Version, protocol versions, host, data directory, repositories, capacity  |
| `GET /v1/sessions/:id`           | Session state, sequence, expiry and index status                          |
| `DELETE /v1/sessions/:id`        | Revoke the session                                                        |
| `GET /v1/index?repositoryId&sha` | `not_indexed`, `building` with progress, `ready`, or `failed` with reason |
| `POST /v1/index/rebuild`         | Full rebuild of `{ repositoryId, sha }`; the ready index keeps serving    |
| `GET /v1/builds/:id`             | One build with progress, refresh report and failure                       |
| `POST /v1/builds/:id/retry`      | New attempt after a failed or cancelled build                             |
| `POST /v1/builds/:id/cancel`     | Cancel a queued or running build                                          |

### Readiness, capacity and cancellation

Every `ask_project` call ends within a bound: the index wait, then the admission wait,
then the mode's `maxElapsedMs`. An agent that holds the only runner slot of its client
therefore never deadlocks on Looky. It gets an answer or a typed retryable result.

1. **Index.** A ready index for exactly the session's SHA is reused. Otherwise the call starts or joins the build, an incremental refresh when an ancestor is ready, and waits up to `LOOKY_INDEX_WAIT_MS`. If the build is still running, the result is `indexing` with the build id, progress and `retryAfterMs`. A failed build is `failed` with stage `index`.
2. **Admission.** Research and synthesis take one of `LOOKY_MAX_CONCURRENT_ASKS` slots. Waiting for an index takes none. When every slot and queue place is taken, or no slot frees within `LOOKY_ADMISSION_WAIT_MS`, the result is `unavailable` with `code: "busy"` and `retryAfterMs`.
3. **Per session.** One session may have `LOOKY_MAX_ASKS_PER_SESSION` distinct questions in flight. Another is `unavailable` with `code: "session_limit"`. Looky never starts other agents or nested sessions.
4. **Coalescing.** The same question and mode from the same session, at the same commit, joins the running work and receives the same `requestId`. A `tools/call` may carry `_meta: { "looky/requestKey": "<id>" }`. A redelivery with that key joins the running work, or receives the stored result for `LOOKY_RESULT_TTL_MS`. A key reused for another question is `invalid_request`.
5. **Cancellation.** `notifications/cancelled`, a closed HTTP request or closed stdin detaches that caller with `cancelled`. The work stops when its last caller detaches, and its slot is released. Index builds are not cancelled by a question; they are shared and durable.
6. **Delivery.** Before a result is returned, the session must still be current. A revoked or superseded session receives `denied`, never an answer computed for it earlier.

Looky only returns tool results. It never completes, fails or resumes a client's task;
a failed question is a typed result for the caller to handle.

| Setting             | Default  | Variable                     |
| ------------------- | -------- | ---------------------------- |
| `maxConcurrentAsks` | 2        | `LOOKY_MAX_CONCURRENT_ASKS`  |
| `maxQueuedAsks`     | 8        | `LOOKY_MAX_QUEUED_ASKS`      |
| `maxAsksPerSession` | 2        | `LOOKY_MAX_ASKS_PER_SESSION` |
| `admissionWaitMs`   | 10000    | `LOOKY_ADMISSION_WAIT_MS`    |
| `indexWaitMs`       | 20000    | `LOOKY_INDEX_WAIT_MS`        |
| `sessionTtlMs`      | 43200000 | `LOOKY_SESSION_TTL_MS`       |
| `resultTtlMs`       | 600000   | `LOOKY_RESULT_TTL_MS`        |
| `fetchTimeoutMs`    | 120000   | `LOOKY_FETCH_TIMEOUT_MS`     |

`maxQueuedAsks`, `admissionWaitMs` and `indexWaitMs` may be 0, which returns the
retryable result at once. Index build concurrency is `LOOKY_INDEX_MAX_CONCURRENT_BUILDS`.
HTTP connections stay open up to 255 seconds, above the default Deep budget plus both
waits; keep custom budgets within that.

### Restart

Stopping the service cancels queued and running builds and in-flight questions. On the
next start, ready indexes and sessions are served again from the database. Builds left
behind by a crash are marked `failed` with code `interrupted`, which is retryable, and the
next request starts a new build that refreshes from the last ready index.

### Paws integration

Paws is the first client. Its adapter lives in pmdroid/paws-app and stays thin: derive
the task, run generation, authorized repository and resolved commit SHA from the task;
register a session with the next `sequence` and the selected provider policy; give the
agent the MCP URL and session token; forward index status, retry and rebuild if needed;
revoke the session when the run ends. It must not copy credentials into the
registration or import Looky internals, and should gate on protocol version `1` with
`LookyClient.connect`.

## Browser access

`bun run serve` can also serve a same-origin browser API at `/browser/v1` for the React
app. A person signs in, chooses a repository and committed revision, asks in Fast or
Deep mode and reads the same structured result agents get. The adapter has no index or
answer engine of its own. Each revision a browser selects registers an ordinary Looky
session for the browser client. Readiness, prewarm, admission, per-session limits,
provider routing, coalescing and cancellation therefore behave exactly as for agents. The
session token of that registration is never issued to the browser.

### Local launch

Configure a dedicated browser client and name it in `LOOKY_BROWSER_CLIENT`. Its
repository list is everything the browser may see. Keep it separate from an agent
adapter's client, such as `paws`.

```sh
LOOKY_REPOSITORIES=paws-app \
LOOKY_REPOSITORY_PAWS_APP_PATH=/var/lib/looky/repos/paws-app.git \
LOOKY_CLIENTS=paws,web \
LOOKY_CLIENT_PAWS_TOKEN=<secret> LOOKY_CLIENT_PAWS_REPOSITORIES=paws-app \
LOOKY_CLIENT_WEB_TOKEN=<another secret> LOOKY_CLIENT_WEB_REPOSITORIES=paws-app \
LOOKY_BROWSER_CLIENT=web \
LOOKY_BROWSER_ASSETS_DIR=dist/web \
LOOKY_SOURCE_LINK_TEMPLATE='https://github.com/org/paws-app/blob/{sha}/{path}#L{startLine}-L{endLine}' \
LOOKY_PROVIDER=… \
bun run serve
```

Run `bun run web:build` first to produce `dist/web`. Open `http://127.0.0.1:7341/`. With the default `LOOKY_BROWSER_AUTH=local`, signing in
needs no credential. Looky accepts that only while `LOOKY_HOST` is a loopback address.
Requests must also name a loopback host, which defeats DNS rebinding. On a shared
machine every local user can reach the port, so use token sign-in there.

### Safe remote configuration

Looky refuses to start with local sign-in on a non-loopback address. Remote use needs
all of the following.

```sh
LOOKY_HOST=10.0.0.5 \
LOOKY_BROWSER_CLIENT=web \
LOOKY_BROWSER_AUTH=token \
LOOKY_BROWSER_ORIGINS=https://looky.example.com \
bun run serve
```

- **Token sign-in.** The person enters the browser client's token once in the sign-in form. It is compared in constant time and never stored or returned. Failed attempts are limited per minute. Agent adapter tokens are not accepted.
- **HTTPS origin.** `LOOKY_BROWSER_ORIGINS` lists the exact origins the page is served from. Remote origins must use https. The session cookie then becomes `__Host-looky_browser` with `Secure`.
- **TLS in front.** Terminate TLS at a reverse proxy that forwards to Looky's private address. Do not expose the plain HTTP port.

| Variable                       | Meaning                                                            |
| ------------------------------ | ------------------------------------------------------------------ |
| `LOOKY_BROWSER_CLIENT`         | Configured client the browser acts as; unset turns the adapter off |
| `LOOKY_BROWSER_AUTH`           | `local` (default, loopback only) or `token`                        |
| `LOOKY_BROWSER_ORIGINS`        | Origins of the page; required off loopback, https when remote      |
| `LOOKY_BROWSER_SESSION_TTL_MS` | Browser session lifetime, default 8 hours                          |
| `LOOKY_BROWSER_ASSETS_DIR`     | Optional built app directory, served at `/` with a strict CSP      |

### Browser boundary

- **Sessions.** A browser session is an opaque random HttpOnly, SameSite=Strict cookie. It is kept only in memory, so a restart signs everyone out. It expires after its TTL. Signing out or expiring stops its questions and revokes its Looky sessions; builds other sessions need keep running.
- **Same origin only.** Every request with an `Origin` must use an allowed origin. Every state-changing request needs that `Origin`, a JSON body and the `X-Looky-CSRF` token from `GET /browser/v1/session`. Keep that token in memory, never in `localStorage`. Cross-site `Sec-Fetch-Site` is refused and no CORS header is ever sent.
- **No paths.** The browser names repositories by id and revisions by branch, tag, `HEAD` or full SHA. Revision syntax such as `main~1` or `:/text` is refused, as are unknown fields. A ref is resolved once, and the selection keeps that SHA for every question.
- **Ownership.** Revisions and questions belong to the browser session that created them. Another session gets 404 for them, including on cancel.
- **Safe results.** Answers come back whole. Every other outcome keeps its typed fields with a fixed message. These are `indexing` with build and progress, `failed` with stage and code, `unavailable` with `busy` and `retryAfterMs`, `cancelled`, `timed_out` and `denied`. Provider error text, host paths and session or client ids never reach the browser. Index build failures report their code without the message.

| Route                                   | Operation                                                                 |
| --------------------------------------- | ------------------------------------------------------------------------- |
| `GET /browser/v1/session`               | Sign-in state, CSRF token and expiry                                      |
| `POST /browser/v1/session`              | Sign in; `{ "token": … }` in token mode                                   |
| `DELETE /browser/v1/session`            | Sign out                                                                  |
| `GET /browser/v1/repositories`          | Repositories this browser may use                                         |
| `GET /browser/v1/repositories/:id/refs` | `HEAD`, branches and tags with their SHAs, at most 200                    |
| `POST /browser/v1/revisions`            | Resolve `{ repositoryId, ref }` to a SHA; returns the selection and index |
| `GET /browser/v1/revisions/:id`         | The selection and its index readiness                                     |
| `POST /browser/v1/questions`            | Submit `{ revisionId, question, mode, clientRequestId }`; `202` running   |
| `GET /browser/v1/questions/:id`         | The question; `?waitMs=` waits up to 25 seconds for its result            |
| `POST /browser/v1/questions/:id/cancel` | Cancel this browser's question; other callers and shared builds continue  |

`mode` is required, so the app always makes the Fast or Deep choice explicitly.
`clientRequestId` is generated by the browser per question. Resending it returns the same
question and result, so a retried delivery never pays for research twice. Reusing it for
another question is `409 request_key_reused`.

An answered question also carries `sourceLinks`: one link or `null` per `evidence`
entry, built from `LOOKY_SOURCE_LINK_TEMPLATE` with the answer's own repository and SHA.
Only http and https links are offered. Without a template every entry is `null`.

A running question that nobody polls for 45 seconds is cancelled as abandoned. One browser
session may run 4 questions at once and keep 32. It may hold 8 revision selections; the
least recently used selection ends beyond that. Finished results are kept for 10
minutes.

### The browser app

`web/` holds a single React screen for people. It uses the browser API above and has no
index, answer engine or storage of its own.

```sh
bun run web:build              # dist/web, or: bun run web:build <outdir>
LOOKY_BROWSER_ASSETS_DIR=dist/web … bun run serve
```

The build uses Bun's HTML bundler with `web/index.html` as the only entry. It emits hashed
script and style files with absolute URLs and no inline script or style, so the CSP that
Looky serves assets with holds. Production builds are minified and have no source maps.
For development, `bun run web:dev` rebuilds into `dist/web` on every change under `web/`
and runs `bun run serve` with `LOOKY_BROWSER_ASSETS_DIR` pointing there. Every other
`LOOKY_*` setting comes from the environment as usual. Reload the page after a rebuild.

- **Selection.** Repositories and branches, tags and `HEAD` come from the API, or a full
  commit SHA can be entered. A choice is resolved once to a SHA, and the screen shows the
  pinned SHA and index readiness. The repository and ref are kept in the URL, as
  `?repo=…&ref=…`, so a reload selects them again. Questions and answers are not kept
  in the URL, and nothing is written to `localStorage` or `sessionStorage`.
- **Asking.** Fast is selected by default and Deep is an explicit choice. Ask is disabled
  while a question runs, so a double click never submits twice. A lost submission is resent
  with the same `clientRequestId`. Cancel stops the question at Looky and says so.
  Choosing another repository or revision, signing out or leaving the page cancels the
  running question. Every result is checked against the question's snapshot of its mode,
  repository, selection and SHA, so a late or mismatched response is never shown.
- **Waiting.** Each poll is a bounded long poll, with a limited number of them. Index
  readiness is checked at the server's `retryAfterMs`, clamped to 1 to 15 seconds, for at
  most 10 minutes. Then the person decides whether to keep waiting. Progress appears only
  when Looky supplies it. The app never invents percentages or streaming.
- **Retries.** An `indexing` result means no research ran. The app therefore asks the same
  question again once the index is ready. After `busy`, a retryable failure or a timeout,
  the app shows a Retry or Ask again button, enabled after any `retryAfterMs`. "Ask in
  Deep" is only a button. A Fast question never becomes Deep by itself.
- **Answers.** The full prose comes first. Caveats, the certainty (outcome and any
  question for the team), the cited ranges at the SHA, and the mode, revision and
  committed-source scope follow. Answer text is untrusted. It is rendered through a small
  Markdown subset directly to React elements, without an HTML path. A link is clickable
  only when it equals one of the answer's `sourceLinks` and uses http or https.
- **Access.** The screen works from 320 px wide to desktop. All controls are labelled and
  reachable by keyboard. Ctrl or ⌘ + Enter asks and Escape cancels. Status changes are
  announced in a live region, and focus moves to the outcome when a question ends.
  Unicode and right-to-left text render as written.

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
bun run looky retry <build-id> --repo /path/to/repo
bun run looky status [<build-id>] [--id <repository-id>] [--sha <sha>]
bun run looky coverage <build-id> [--excluded]
bun run looky search <build-id> <words…> [--limit <n>]
bun run looky retrieve --repo /path/to/repo --sha <sha> [--id <repository-id>] [--mode fast|deep] [--text] <question…>
bun run looky ask --repo /path/to/repo --sha <sha> [--id <repository-id>] [--mode fast|deep] <question…>
bun run looky cancel <build-id>
bun run looky gc
```

Every command prints JSON and uses `LOOKY_DATA_DIR` like `bun start`. `index` and
`retry` wait for the build, print progress to stderr and exit non-zero unless the
build is ready. `index --rebuild` runs a full build even when the SHA is ready. `--id`
defaults to the repository directory name. `status` with `--id` and `--sha` reports
that scope's lifecycle state: `not_indexed`, `building`, `ready` or `failed`, with the
ready, active and latest builds. Without both it lists builds. `coverage` reports
indexed files by language, exclusions by reason, how the build was refreshed and, with
`--excluded`, every excluded path. `gc` applies retention immediately. `retrieve`
runs [evidence research](#evidence-retrieval) against the ready index of exactly that
SHA, without calling a model, and prints the evidence bundle; `--text` includes the
source text of each range. `ask` answers the question through the full `ask_project`
path with the [configured provider](#model-providers) and prints the typed response;
Ctrl-C cancels it.

In code, `IndexService` implements the `IndexCatalog` port. Its `repositories`
callback maps an authorized repository id to a local Git directory and refuses unknown
ids; there is no global index. `resolve` returns the ready build for exactly the
requested SHA, or starts or joins one shared build for that scope and returns its
progress. It never substitutes another SHA, though it discloses a ready build of
another SHA as `staleGeneration`. A SHA that is not a commit in the repository is
`unsupported_revision`. A ready result carries a lease that pins the generation;
`askProject` releases it when the request ends. `startBuild` prewarms a SHA, for
example at task admission, through the same shared build. `rebuild`, `retry`,
`indexStatus`, `status`, `builds`, `coverage`, `cancel` and `collectGarbage` expose the
same operations as the CLI. The service's `listChunks` and `searchChunks` check that
the repository is still authorized on every call and throw `IndexAccessDeniedError`
once the `repositories` callback stops returning it. The store functions of the same
names read ready builds only and throw `IndexNotReadyError` for anything else.

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
chunker, where the chunker id includes the chunking limits, so a later build reuses
unchanged blobs without reading them again. Content whose chunk rows are incomplete is
never reused; the next build reads the blob again and repairs it. Full-text
search uses FTS5 over symbols, chunk text and the parts of compound identifiers, so
`getUserById` matches both the whole name and `user`.

### Build lifecycle

| State       | Meaning                                                            | Served |
| ----------- | ------------------------------------------------------------------ | ------ |
| `queued`    | Waiting for a build slot                                           | No     |
| `running`   | Planning or indexing; `filesDone`/`filesTotal` show progress       | No     |
| `ready`     | Every tracked entry is recorded; published in a single transaction | Yes    |
| `failed`    | `errorCode` and `retryable` explain why; nothing is published      | No     |
| `cancelled` | Cancelled by a caller, the CLI or service shutdown                 | No     |

A build is one immutable generation of exactly one repository, commit SHA and index
key. The index key combines the policy version in `src/indexing/policy.ts` with every
limit that changes eligibility or chunking: `maxFileBytes`, `maxLineBytes`,
`chunkLines`, `chunkBytes` and `chunkOverlapLines`. Only ready builds under the
service's current key are served. Changing one of those limits or bumping the policy
version therefore rebuilds every index on request instead of serving incompatible
data. Bump the policy version when eligibility, chunking or symbol extraction code
changes. Builds made before the key existed carry the key `legacy` and are never
served. The database schema itself is versioned by the migrations above.

Builds run on a worker thread with their own database connection, off the service's
event loop, and at most `LOOKY_INDEX_MAX_CONCURRENT_BUILDS` run at once. Concurrent
requests for the same scope join one build, and a unique database index on queued and
running builds per scope prevents a second publisher. Exceeding `maxFiles` or
`maxIndexedBytes` fails the build with `limit_exceeded` rather than publishing partial
coverage. Such deterministic failures are reported to later requests instead of
retried; `retry` starts a new attempt for the scope. Cancelled and retryable failures
start a new build on the next request. A build cancelled from another process stops
at its next batch write. Failure messages are written by Looky and never contain file
content or matched secrets.

One process owns index builds for a database. A second `IndexService` on the same
database fails while the owner's process is alive on the same host. On startup, builds
left queued or running by a process that died are marked `failed` with code
`interrupted`, their staged rows are deleted, and the next request starts a new build
that refreshes from the last ready generation.

### Refresh

A request for an unindexed SHA starts a build for exactly that SHA. If a ready build of
the same repository and index key exists at an ancestor commit, the build refreshes
from the nearest one. `git diff-tree --no-renames` lists the changed paths. Every
unchanged entry of the new tree must match the base manifest by path, blob id, mode
and size; its manifest row is then copied without reading or classifying the blob.
Only added and modified paths are classified and read, and deleted paths are dropped.
A rename is a deletion plus an addition. When the blob is unchanged its stored chunks
are reused, and its chunks carry the new path. Entries the base could not read are
read again.

A build falls back to a full build when the SHA has no ready ancestor, when history was
rewritten or a ref was force-moved so no ready commit is an ancestor, when the diff
fails, when the base manifest does not match the new tree, when the base snapshot is
incomplete, or for an explicit rebuild. Full builds are still bounded by `maxFiles`
and `maxIndexedBytes` and reuse stored chunks of identical blobs.

Each build reports `refresh`: `mode` (`incremental` or `full`), `reason` for a full
build (`no_base`, `not_ancestor`, `diff_failed`, `base_mismatch` or
`rebuild_requested`), the base build and SHA, and how many paths were `added`,
`modified`, `deleted`, `renamed` and `carried`. `filesReused` counts indexed files
whose chunks were not re-read.

### Publication and readers

All rows of a build are staged under its own build id and are never visible to
readers. Publication checks that every tracked entry is recorded and marks the build
`ready` in one transaction. For an explicit rebuild of a ready SHA, the same
transaction retires the previous generation, so readers see either the old complete
generation or the new one. The old one keeps serving until then, and cancelling or
failing the rebuild leaves it untouched.

A ready generation is served only for its own SHA. Before serving, the service checks
once per process that its manifest and chunk rows are complete. A generation with
missing rows is retired and rebuilt, never reported as ready. An empty or new data
directory has no ready generations, so every SHA is rebuilt on request.

Readers pin one generation with a lease. `resolve` acquires it together with the
lookup and `askProject` releases it when the request ends. A retired generation stays
readable by its lease holders until they release it. Leases expire after
`LOOKY_INDEX_LEASE_TTL_MS` so a crashed reader cannot pin storage forever.

### Retention and cleanup

Garbage collection runs on startup, when builds go idle, when the last lease on a
retired generation is released, and with `looky gc`. It never runs while a build is
queued or running. In one transaction it:

1. Expires leases past their deadline.
2. Retires ready generations of another index key, and generations beyond
   `LOOKY_INDEX_RETAIN_READY` per repository, least recently used first. A retired
   SHA is rebuilt on its next request.
3. Deletes retired generations that no reader holds a lease on.
4. Deletes staged rows of failed and cancelled builds, and keeps at most
   `LOOKY_INDEX_RETAIN_FAILED` of their records per repository.
5. Deletes stored chunk content that no remaining build references.

| Setting                     | Default | Variable                    |
| --------------------------- | ------- | --------------------------- |
| `retainReadyPerRepository`  | 3       | `LOOKY_INDEX_RETAIN_READY`  |
| `retainFailedPerRepository` | 20      | `LOOKY_INDEX_RETAIN_FAILED` |
| `leaseTtlMs`                | 1800000 | `LOOKY_INDEX_LEASE_TTL_MS`  |

SQLite reuses the pages freed by deleted rows for later builds; the file does not
shrink on its own.

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
bound the disk one generation uses; retention bounds how many generations are kept.

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
A generation for any other SHA is refused as a contract violation. A ready resolution
may carry a lease, which `askProject` releases when the request ends, so retention
never deletes the generation a request is reading. If no ready
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
| `unavailable`          | A dependency cannot serve, or Looky is at capacity (`code`)    |
| `cancelled`            | The caller cancelled the request                               |
| `timed_out`            | The mode's elapsed-time limit was reached                      |

Only `answered` has `answer.text`. Its `answer.outcome` is `supported`, `partial`,
`conflicting` or `unknown`. `unknown` is a factual result about the indexed code,
distinct from execution failures. Evidence references are separate metadata and
must lie within source ranges the session read at the pinned SHA. Non-`unknown`
outcomes require evidence. Text consisting only of code snippets is rejected. A
Fast answer may set `suggestedMode: "deep"`; the caller decides whether to retry.
`suggestedHumanQuestion: { question, reason }` is present when intent or rationale is
not documented; the caller may ask people, for example through Paws `ask_team`, but
Looky never posts it. `providers` lists the configured providers that served model
calls.

`scope` states that only committed source at the SHA was used and whether
uncommitted changes were `none`, `excluded` or `unknown`. Dirty and unknown
worktrees, and the ref the SHA came from, are disclosed in `limitations`.

`coverage` reports what the pinned generation covers: `indexedFiles`, `excludedFiles`
and `excludedByReason`, using the [eligibility](#eligibility) reasons. When any tracked
entry was excluded, `limitations` also says how many and why, because excluded files
were never searched, read or sent to a model.

The MCP result from `callAskProjectTool` puts the answer prose, or a "Not answered"
status message, in `content` and the full typed response in `structuredContent`.
For an answer with limitations, the text ends with a `Limitations:` list, so a
caller that reads only text still sees excluded worktree changes, excluded files and
a moved ref. Every status except `answered` sets `isError`.

### Mode budgets

Each request runs under finite limits enforced by the guarded session. Exceeding
one returns `failed` with `code: "budget_exhausted"` and `exhaustedLimit`, plus
`suggestedMode: "deep"` for Fast. Engines can check `session.remaining()` to stop
early with a `partial` answer instead. Elapsed time covers the whole request.

<!-- budgets:start -->

| Limit                | Fast  | Deep   | Fast variable                     |
| -------------------- | ----- | ------ | --------------------------------- |
| `maxRetrievalPasses` | 2     | 14     | `LOOKY_FAST_MAX_RETRIEVAL_PASSES` |
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

| Port            | Implemented by            | Responsibility                                      |
| --------------- | ------------------------- | --------------------------------------------------- |
| `ClientAdapter` | Client, such as Paws      | Session context, generation, authorization, limits  |
| `IndexCatalog`  | Looky `IndexService`      | Exact-SHA generation lookup and build status        |
| `Retriever`     | Looky `IndexRetriever`    | Search within the pinned generation                 |
| `SourceReader`  | Looky or client           | Committed source ranges at the SHA                  |
| `ModelProvider` | Looky `ProviderRouter`    | Model calls with selection, fallback and quotas     |
| `AnswerEngine`  | Looky `LookyAnswerEngine` | Fast or Deep research and synthesis via the session |

A client adapter may also set `providerPolicy: { selected, fallback? }`, such as Paws'
existing provider policy. It chooses among providers Looky configured and can never
add an endpoint or credentials; naming an unconfigured provider fails with
`provider_not_configured`.

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
ready build is `unavailable`. It never falls back to another build. Given the
`repositories` callback the `IndexService` uses, it also refuses every search with
`IndexAccessDeniedError` once the repository is no longer authorized. A retired
generation stays searchable for requests that pinned it with a lease.

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

## Answers

`LookyAnswerEngine` turns verified evidence into a complete explanation, the way one
engineer explains a system to another. It starts with the direct answer, then explains
the flow, the connections between files and the important exceptions in ordinary
prose, with source links next to the claims they support. It uses only the guarded
session, so its tools are scoped index search and pinned source reads. It cannot edit
files, run scripts or shell commands, fetch URLs, create issues or start other
research.

| Mode | Steps                                                                                                                                                                                                                                                                                                         |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fast | The Fast evidence pass, then one synthesis call, plus one repair call only if the reply cannot be parsed. Thin evidence gives a clearly limited answer with `suggestedMode: "deep"`. Fast never runs Deep's stages.                                                                                           |
| Deep | The Deep evidence plan, then up to `LOOKY_DEEP_ROUNDS` (default 2) rounds where the model plans follow-up searches from a digest of the evidence. Those searches run as research passes with the same byte-exact verification. Then synthesis, then a cross-check of the draft against the evidence it cites. |

A Deep follow-up can only be a search: words, `definitionOf`, `referencesOf`, `kinds`
or a path prefix. Any other field the model returns is discarded. Follow-ups have their
own limits on top of the Deep research limits, and each round gets what is left.
`LOOKY_DEEP_MAX_FOLLOW_UPS_PER_ROUND` (default 4) caps the searches in one round.

<!-- follow-up-limits:start -->

| Limit            | Default | Variable                                 |
| ---------------- | ------- | ---------------------------------------- |
| `maxPasses`      | 6       | `LOOKY_DEEP_FOLLOW_UP_MAX_PASSES`        |
| `maxReads`       | 10      | `LOOKY_DEEP_FOLLOW_UP_MAX_READS`         |
| `maxReadBytes`   | 98304   | `LOOKY_DEEP_FOLLOW_UP_MAX_READ_BYTES`    |
| `maxReadLines`   | 160     | `LOOKY_DEEP_FOLLOW_UP_MAX_READ_LINES`    |
| `maxHitsPerPass` | 8       | `LOOKY_DEEP_FOLLOW_UP_MAX_HITS_PER_PASS` |
| `maxElapsedMs`   | 45000   | `LOOKY_DEEP_FOLLOW_UP_MAX_ELAPSED_MS`    |

<!-- follow-up-limits:end -->

Every model call is still charged to the mode budget. Evidence that does not fit the
input token budget is left out and disclosed, never cut mid-range. An answer over
`maxAnswerChars` is shortened at a paragraph or sentence boundary and says so.

An answer must explain in sentences. A draft that only quotes code, or only quotes
code and cites it, is treated like an unparseable reply: Fast asks for a repair once,
then the request fails with `code: "model_output_invalid"`, which is retryable.
`askProject` applies the same check to every engine's text before delivery and
rejects snippets with `contract_violation`. Fenced and numbered code, inline code,
links, citation markers and file names do not count as sentences.

### Grounding and citations

Repository and index text is untrusted. Evidence goes to the model in fenced,
line-numbered blocks that cannot close their fence, and the instructions say text in
them is data, never instructions. The model cites with `[E3]` or `[E3:14-18]`. Before
delivery each marker is checked against the inspected evidence records. The id must
exist and the lines must lie inside that record. Path-and-line references written in
the prose, such as `src/a.ts:12`, are checked the same way.

Valid citations become links and `evidence` references. Invalid ones are removed, the
answer says how many were removed, and a `supported` outcome becomes `partial`. An
answer with no valid citation is delivered as `unknown`, never as verified. Set
`LOOKY_SOURCE_LINK_TEMPLATE` to link to a code host, for example
`https://github.com/org/repo/blob/{sha}/{path}#L{startLine}-L{endLine}`.
`{repositoryId}` is also available. Without a template, links are plain
`path:lines` labels.

### Honest outcomes

- **Code, docs and inference.** The answer states what the code does with citations,
  attributes what docs say, and marks inferences.
- **Stale docs.** A research conflict is always listed in `caveats`. When the question
  or the cited docs involve it, the outcome becomes `conflicting`.
- **Rationale.** A reason counts as documented only if the answer cites docs. Otherwise
  the rationale is unknown, the answer says so, and `suggestedHumanQuestion` carries a
  question for the team.
- **Coverage.** `caveats` lists research gaps, limits reached and how many ranges and
  files were inspected. They never claim the whole repository was read. When research
  stopped early or the outcome is partial, the prose ends with one sentence saying so.
- **No evidence.** When research finds nothing, the answer is `unknown` and no
  synthesis call is made.

The guarded session reads only paths that a search of the pinned generation returned.
A secret, oversized or otherwise excluded file is never in the index, so no engine can
read it even though it is committed. `GitSourceReader` also refuses any path that is
not a plain repository path, such as `./a`, `../a`, `/a` or `.git/config`.

Authorization runs before every search, read and model call and again before delivery.
Cancellation, revocation or a stale client generation stops research immediately and
no answer is delivered.

## Model providers

Looky calls models only through a provider it is configured with. No provider is
required, and Claude is not required. `ProviderRouter` tries the selected provider for
every call. It moves to a fallback only when the selected one cannot serve: its local
quota is spent, it reported a quota or rate limit, or it is down. A fallback is never
consulted while the selected provider works, so an unused provider's exhausted quota
never blocks an answer. A provider that reported a quota or rate limit is skipped
until its `Retry-After` passes, or one minute without a hint; a spent quota waits 15
minutes. Cancellation is never retried on another provider. Rejected requests, such as
HTTP 400, fail instead of falling back.

| Kind        | Endpoint                              | Default base URL            |
| ----------- | ------------------------------------- | --------------------------- |
| `openai`    | OpenAI-compatible `/chat/completions` | `https://api.openai.com/v1` |
| `anthropic` | Anthropic Messages API `/v1/messages` | `https://api.anthropic.com` |

The `openai` kind also fits many hosted and local model servers that speak the same
protocol. Configure providers with environment variables. `<ID>` is the provider id
upper-cased, with `-` written as `_`.

| Variable                                      | Meaning                                                          |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `LOOKY_PROVIDER`                              | Selected provider id. Unset means no provider                    |
| `LOOKY_PROVIDER_FALLBACK`                     | Optional comma-separated fallback ids, tried in order            |
| `LOOKY_PROVIDERS`                             | Optional list of every configured id, if more than the above     |
| `LOOKY_PROVIDER_<ID>_KIND`                    | `openai` or `anthropic`                                          |
| `LOOKY_PROVIDER_<ID>_MODEL`                   | Model name sent to the provider                                  |
| `LOOKY_PROVIDER_<ID>_BASE_URL`                | Optional endpoint base URL                                       |
| `LOOKY_PROVIDER_<ID>_API_KEY`                 | Optional credential                                              |
| `LOOKY_PROVIDER_<ID>_TIMEOUT_MS`              | Per-call timeout, default 60000                                  |
| `LOOKY_PROVIDER_<ID>_MAX_TOKENS_FIELD`        | `openai` only: `max_tokens` (default) or `max_completion_tokens` |
| `LOOKY_PROVIDER_<ID>_MAX_REQUESTS_PER_MINUTE` | Optional local request quota                                     |
| `LOOKY_PROVIDER_<ID>_MAX_TOKENS_PER_MINUTE`   | Optional local token quota, input plus output                    |

For example, a local server with a hosted fallback:

```sh
LOOKY_PROVIDER=local LOOKY_PROVIDER_FALLBACK=hosted \
LOOKY_PROVIDER_LOCAL_KIND=openai LOOKY_PROVIDER_LOCAL_MODEL=<model> \
LOOKY_PROVIDER_LOCAL_BASE_URL=http://127.0.0.1:11434/v1 \
LOOKY_PROVIDER_HOSTED_KIND=anthropic LOOKY_PROVIDER_HOSTED_MODEL=<model> \
LOOKY_PROVIDER_HOSTED_API_KEY=<key> \
bun run looky ask --repo /path/to/repo --sha <sha> "How does recovery work?"
```

Error messages report the HTTP status and the provider's error type, never credentials
or response bodies. Usage a provider does not report is charged as an estimate. In code,
`createConfiguredProvider()` builds the router from the environment, and
`new ProviderRouter({ providers, policy })` accepts any `ModelProvider`
implementations with optional quotas.
