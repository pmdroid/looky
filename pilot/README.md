# Real-codebase pilot

The pilot runs Looky against a real repository, paws-app, and records what a Paws
agent session would see. It starts the documented `serve` entrypoint as a child
process and uses only supported interfaces:

- the client adapter API, as the Paws adapter registers sessions, reads index status,
  retries, rebuilds and cancels builds,
- the MCP endpoint, as the Paws agent calls `index_status` and `ask_project`,
- the `looky` CLI for coverage, search and model-free evidence research.

It never edits the database, and it never writes to the source repository. It clones
the source into its own work directory and makes its test commits there. They are never
pushed.

## Running it

From a clean install of this repository:

```sh
bun install --frozen-lockfile
bun run pilot [--source <git url or directory>] [--work <dir>] [--out <dir>]
```

`--source` defaults to the `source` in `pilot/questions.json`. `--work` defaults to a new
temporary directory, and `--out` to `<work>/results`. The run writes `results.json` and
`report.md` there, and exits non-zero when any check fails.

Provider variables (`LOOKY_PROVIDER*`, see the main README) are passed to the service
from the environment and never written to the results. Without a provider every phase
except answer generation runs, and the report says answers are pending. With one, the
pilot asks every question in both modes over MCP and writes each full answer, its
evidence, index identity and model usage into the report with an empty reviewer row.

## What it does

1. Clones the source and checks out the pinned commit. Every pinned evidence range in
   `questions.json` must exist and contain its anchor text there, before any answer exists.
2. Starts the service, registers a session for the commit and waits for the cold index,
   recording progress, build time, coverage and database size.
3. Asks the first question in both modes over MCP and checks the executed mode equals the
   requested one and the outcome is typed.
4. Runs Fast and Deep evidence research for every question twice, cold then repeated.
   It measures overlap with the pinned ranges, research usage against the configured
   limits, and whether every retrieved range is byte-for-byte the committed text of the
   pinned generation.
5. Repeats the registration and questions warm, then restarts the service and checks
   the persisted index and session token are reused without a new build.
6. Commits a change on top of the pinned commit that renames, edits, adds and deletes
   files, registers the next session sequence and checks the incremental refresh. It
   checks nothing is answered from an incomplete snapshot, the old session is fenced,
   the base commit keeps its own generation, and evidence at the new commit cites only
   new paths while the base still cites old ones.
7. Restarts with `LOOKY_INDEX_MAX_FILES=100` to force an explicit `limit_exceeded`
   failure, then retries it through the API after restoring the limit.
8. Kills the service with `SIGKILL` during a rebuild, restarts it, and checks the build
   is reported `interrupted` and retryable, the previous generation still serves, and
   the retry rebuilds and publishes.
9. Cancels a rebuild and checks the ready generation keeps serving.
10. Asks every question in both modes when a provider is configured.

## Question set

`questions.json` holds ten questions on paws-app at a fixed commit, covering recovery and
other subsystems. They include straightforward control flow, an exception path,
cross-file behavior, configuration, stale documentation, a rationale the source does not
establish and a module the change commit renames and edits. Each question names the
source ranges a correct answer must rest on and a reviewer key describing the expected
answer and its caveats. `change.question` repeats the changed-module question at the new
commit with evidence pinned there.

## Reviewing answers

The reviewer scores each answer in each mode on directness, completeness, natural
explanation, correct mechanism and caveats, evidence, and uncertainty, and says whether it
is useful without rewriting. Compare the answer with the question's `expected` key and its
pinned ranges. An answer that cites a range outside its revision, reads another
repository or states a rationale the source does not support fails regardless of the
other scores. At least eight of ten questions must be useful in each mode.

## Results

`results/` holds the reports of recorded runs. Each names the Looky commit, the pilot
commit and whether a model provider was configured.
