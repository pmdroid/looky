# Pilot run on paws-app 2ac93023

Looky 8584994 on Bun 1.4.4 ran from a clean install against a fresh clone of
`pmdroid/paws-app` at `2ac93023d31bab6f0ef26690a7e6e8e8d2540bff`. All 37 lifecycle and
grounding checks passed. No model provider was configured, so this run has no answers
and no reviewer scores. `report.md` has every check, table and pinned question, and
`results.json` holds the raw data.

## Status against PAS-971

| Requirement                                          | Status                        |
| ---------------------------------------------------- | ----------------------------- |
| Clean install, real repository, documented service   | Done                          |
| Cold index, warm repeats, restart reuse              | Done                          |
| Add, change, delete and rename refresh               | Done                          |
| Explicit failure, retry, interrupted rebuild, cancel | Done                          |
| Pinned evidence and retrieval coverage per mode      | Done                          |
| Ten questions answered in both modes and scored      | Pending a model provider      |
| Answer token and model usage per mode                | Pending a model provider      |
| A real Paws coding session using the MCP endpoint    | Pending the Paws-side adapter |

The harness drives the endpoints exactly as the Paws adapter and agent would. It is not
a Paws process, so the last row stays open until a Paws task connects through its own
adapter.

## Index

| Measure                                              | Value      |
| ---------------------------------------------------- | ---------- |
| Tracked files                                        | 1793       |
| Indexed files                                        | 1775       |
| Excluded files                                       | 18         |
| Chunks                                               | 6791       |
| Indexed bytes                                        | 14,148,510 |
| Cold build                                           | 2.4 s      |
| Database after the cold build                        | 30.0 MB    |
| Database after all phases                            | 31.4 MB    |
| Service CPU through the cold build and first queries | 4.0 s      |
| Service peak memory                                  | 103 MB     |
| Incremental refresh                                  | 51 ms      |
| Files reused by the refresh                          | 1770       |

Exclusions were 9 binary, 4 secret content, 3 generated, 1 secret path and 1 long-line
file.

## Lifecycle

- **Restart.** After a clean stop the restarted service served the same build id and
  the same session token, and no new build ran.
- **Refresh.** The change commit added a docs note, renamed `src/closeout/rounds.ts`,
  lowered its class limit, updated three importers and deleted an unused fixture. The
  refresh reported 2 added, 3 modified and 2 deleted paths, because Looky records a
  rename as a deletion plus an addition. Research at the new commit cited only the new
  path and the base commit still cited only the old one. The superseded session was
  denied as `stale_session`.
- **Failure and retry.** With `LOOKY_INDEX_MAX_FILES=100` the build failed with
  `limit_exceeded`. A question on it got a typed index failure, a restart kept
  reporting it, and the API retry published the commit.
- **Interrupted rebuild.** A `SIGKILL` at 256 of 1794 files left the build `failed`
  with `interrupted` and retryable, while the previous generation kept serving. The
  retry rebuilt and published a new generation.
- **Cancel.** A cancelled rebuild ended `cancelled` and the ready generation kept
  serving.

## Retrieval against pinned evidence

| Mode | Pinned ranges hit | Pinned files hit | Median files read | Median research time |
| ---- | ----------------- | ---------------- | ----------------- | -------------------- |
| Fast | 11 of 29          | 16 of 29         | 4                 | 74 ms                |
| Deep | 16 of 29          | 24 of 29         | 13                | 184 ms               |

Every retrieved range was the exact committed text of the pinned generation. Every
bundle stayed within the configured research limits. Fast never ran more than two
passes and suggested Deep on 8 of 10 questions. Deep reached at least one pinned range
on every question.

## Gaps found and fixed in this pilot

- **Retrieval ranked tests and stray symbols above code.** The first run hit only 3
  of 29 pinned ranges in Fast and 6 in Deep. A capitalized product name counted as an
  explicit identifier, prose like "starts up" never reached `startup`, and tests that
  restate a question outranked the code. The query analyzer and ranker were fixed in
  general ways, with unit tests.
- **Retrying an interrupted rebuild dropped the rebuild.** The retry reported the old
  generation and never rebuilt. A retry of a rebuild now rebuilds.

## Limitations still visible

- **Retrieval is lexical.** Fast misses pinned ranges on most multi-file questions,
  such as the intake flow, the bypass flow and queue configuration. Answers built on
  these bundles must say what they could not establish, which only a provider-backed
  run can show.
- **Deep always stops at its research pass limit.** Every Deep bundle ended at
  `maxPasses`, so Deep's budget, not the question, bounds how far it follows leads.
- **Stale-documentation evidence is partial.** For the config question both modes
  found the documentation line and the parser file, but not the specific sections
  that ignore unknown keys.
- **Added docs are not always retrieved.** The new docs note was indexed and
  searchable, but research for the changed question did not pick it.

## Completing the pilot

Set the provider variables from the main README and rerun `bun run pilot`. The report
then includes each full answer, its evidence, index identity and token usage per mode,
with an empty reviewer row for each answer. Score those rows as described in
`pilot/README.md`.
