# Looky real-codebase pilot

Looky bc88d804e3207beb22f9673835093542d1665130 on Bun 1.4.4; pilot repository paws-app from https://github.com/pmdroid/paws-app.git at 2ac93023d31bab6f0ef26690a7e6e8e8d2540bff.
Model provider configured: no. Started 2026-11-02T00:11:03.614Z, finished 2026-11-02T00:11:20.926Z.

## Checks

| Check                                                                      | Result | Detail                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| pinned revision checked out                                                | pass   | 2ac93023d31bab6f0ef26690a7e6e8e8d2540bff                                                                                                                                                                                                                                                                                                                            |
| pinned evidence holds at the base commit                                   | pass   | 29 pins                                                                                                                                                                                                                                                                                                                                                             |
| registration starts a build of the requested SHA                           | pass   | building                                                                                                                                                                                                                                                                                                                                                            |
| cold index is ready                                                        | pass   | 1775 files, 6791 chunks in 2330 ms                                                                                                                                                                                                                                                                                                                                  |
| cold build is a full build                                                 | pass   | {"mode":"full","reason":"no_base","baseBuildId":null,"baseSha":null,"added":0,"modified":0,"deleted":0,"renamed":0,"carried":0}                                                                                                                                                                                                                                     |
| fast: mode is never switched                                               | pass   | requested fast, executed fast                                                                                                                                                                                                                                                                                                                                       |
| fast: no provider is a truthful typed result                               | pass   | unavailable: No model provider is configured for this Looky service; set LOOKY_PROVIDER                                                                                                                                                                                                                                                                             |
| deep: mode is never switched                                               | pass   | requested deep, executed deep                                                                                                                                                                                                                                                                                                                                       |
| deep: no provider is a truthful typed result                               | pass   | unavailable: No model provider is configured for this Looky service; set LOOKY_PROVIDER                                                                                                                                                                                                                                                                             |
| every retrieved range is the exact committed text of the pinned generation | pass   | 219 ranges                                                                                                                                                                                                                                                                                                                                                          |
| retrieval stays within configured research limits                          | pass   | passes, reads and bytes per bundle                                                                                                                                                                                                                                                                                                                                  |
| every bundle comes from the cold generation                                | pass   | build_515923a5-8a7e-41ad-8087-426254bf1a92                                                                                                                                                                                                                                                                                                                          |
| duplicate registration returns the same session                            | pass   | ses_23fa63e6-77dc-4984-832b-5cfe04dab212                                                                                                                                                                                                                                                                                                                            |
| warm repeats reuse the cold index                                          | pass   | 1 builds                                                                                                                                                                                                                                                                                                                                                            |
| restart serves the persisted index without rebuilding                      | pass   | ready build_515923a5-8a7e-41ad-8087-426254bf1a92                                                                                                                                                                                                                                                                                                                    |
| session token survives the restart                                         | pass   | unavailable                                                                                                                                                                                                                                                                                                                                                         |
| change question pins hold at the new commit                                | pass   | 163ae9601785516a3be6d53033602796094da977                                                                                                                                                                                                                                                                                                                            |
| refresh is incremental from the cold build                                 | pass   | {"mode":"incremental","reason":null,"baseBuildId":"build_515923a5-8a7e-41ad-8087-426254bf1a92","baseSha":"2ac93023d31bab6f0ef26690a7e6e8e8d2540bff","added":2,"modified":3,"deleted":2,"renamed":0,"carried":1788}                                                                                                                                                  |
| refresh counts the added, changed, deleted and renamed paths               | pass   | added 2, modified 3, deleted 2, renamed 0, carried 1788, reused 1770                                                                                                                                                                                                                                                                                                |
| no answer is served from an incomplete or other snapshot during refresh    | pass   | unavailable                                                                                                                                                                                                                                                                                                                                                         |
| the base revision keeps its own published index                            | pass   | ready build_515923a5-8a7e-41ad-8087-426254bf1a92                                                                                                                                                                                                                                                                                                                    |
| the superseded session is fenced                                           | pass   | denied stale_session                                                                                                                                                                                                                                                                                                                                                |
| new revision cites the renamed path and never the old one                  | pass   | src/closeout/round-summary.ts, src/loop/review-findings.ts, src/db/review-findings.ts, scripts/verify-finding-issues-ui.ts, src/closeout-spec/types.ts, src/closeout/run.ts, src/closeout-spec/facade.ts, src/loop/open-findings.ts, src/web/src/client/link-ask.ts, src/web/src/client/review-findings.ts, src/web/src/contract.ts, .agents/probes/api-contract.ts |
| base revision still cites the old path                                     | pass   | src/closeout/rounds.ts, src/loop/review-findings.ts, src/db/review-findings.ts, scripts/verify-finding-issues-ui.ts, src/closeout-spec/types.ts, src/closeout/run.ts, src/closeout-spec/facade.ts, src/loop/open-findings.ts, src/web/src/client/link-ask.ts, src/web/src/client/review-findings.ts, src/web/src/contract.ts, .agents/probes/api-contract.ts        |
| refreshed retrieval matches the new commit's text                          | pass   | build_1c39b4f2-6481-402f-8748-6294adebf57d                                                                                                                                                                                                                                                                                                                          |
| the changed code is retrieved in both modes at the new commit              | pass   | fast 1/2 (missed docs/closeout-round-summary.md:1-3); deep 1/2 (missed docs/closeout-round-summary.md:1-3)                                                                                                                                                                                                                                                          |
| deleted file is gone from the new snapshot only                            | pass   | base hits 1, new hits 0                                                                                                                                                                                                                                                                                                                                             |
| added file appears in the new snapshot only                                | pass   | base hits 0, new hits 1                                                                                                                                                                                                                                                                                                                                             |
| an over-limit build fails explicitly                                       | pass   | limit_exceeded: The commit has more than 100 tracked entries (maxFiles)                                                                                                                                                                                                                                                                                             |
| a question on the failed index gets a typed index failure                  | pass   | failed                                                                                                                                                                                                                                                                                                                                                              |
| a deterministic failure is reported, not silently retried                  | pass   | failed                                                                                                                                                                                                                                                                                                                                                              |
| retry through the API publishes the revision                               | pass   | {"mode":"incremental","reason":null,"baseBuildId":"build_1c39b4f2-6481-402f-8748-6294adebf57d","baseSha":"163ae9601785516a3be6d53033602796094da977","added":1,"modified":0,"deleted":0,"renamed":0,"carried":1793}                                                                                                                                                  |
| a rebuild was killed while running                                         | pass   | running indexing 256/1794                                                                                                                                                                                                                                                                                                                                           |
| the killed build is reported as interrupted and retryable                  | pass   | failed interrupted retryable true                                                                                                                                                                                                                                                                                                                                   |
| the previous generation keeps serving after the kill                       | pass   | ready build_46516112-5d66-44dc-a954-f42b3e476a88                                                                                                                                                                                                                                                                                                                    |
| retry of the interrupted rebuild rebuilds and publishes a new generation   | pass   | ready build_a134ddee-c22a-4d75-a3dc-8f179d85ebe4                                                                                                                                                                                                                                                                                                                    |
| a cancelled rebuild leaves the ready generation serving                    | pass   | cancelled; serving build_a134ddee-c22a-4d75-a3dc-8f179d85ebe4                                                                                                                                                                                                                                                                                                       |

## Index

| Build                                      | SHA          | Refresh                 | Files indexed | Excluded | Reused | Chunks | Indexed bytes | Build ms | Wait ms | Database bytes |
| ------------------------------------------ | ------------ | ----------------------- | ------------- | -------- | ------ | ------ | ------------- | -------- | ------- | -------------- |
| build_515923a5-8a7e-41ad-8087-426254bf1a92 | 2ac93023d31b | full (cold)             | 1775          | 18       | 0      | 6791   | 14148510      | 2330     | 2345    | 29954048       |
| build_1c39b4f2-6481-402f-8748-6294adebf57d | 163ae9601785 | incremental +2 ~3 -2 r0 | 1775          | 18       | 1770   | 6791   | 14147750      | 57       | 0       |                |

Cold progress: building queued ?/? → building indexing 0/1793 → building indexing 256/1793 → building indexing 512/1793 → building indexing 768/1793 → building indexing 1024/1793 → building indexing 1280/1793 → building indexing 1536/1793 → ready

Exclusions: {"binary":9,"generated":3,"long_lines":1,"secret_content":4,"secret_path":1}. Languages: {"css":2,"html":2,"javascript":16,"json":37,"markdown":48,"python":21,"shell":2,"text":20,"toml":3,"typescript":1600,"yaml":24}.

## Retrieval against pinned evidence

Ranges hit counts pinned ranges overlapped by a retrieved range; files hit counts pinned files present at all. Times are research time inside Looky, first then repeated.

| Question | Mode | Ranges hit | Files hit | Files | Passes | Reads | Bytes | Stop            | Suggest Deep | Cold ms | Warm ms | Missed                                                                                               |
| -------- | ---- | ---------- | --------- | ----- | ------ | ----- | ----- | --------------- | ------------ | ------- | ------- | ---------------------------------------------------------------------------------------------------- |
| q01      | fast | 2/2        | 2/2       | 5     | 2      | 5     | 13768 | complete        | true         | 77      | 65      |                                                                                                      |
| q01      | deep | 2/2        | 2/2       | 15    | 8      | 17    | 36531 | limit:maxPasses | false        | 171     | 166     |                                                                                                      |
| q02      | fast | 1/4        | 1/4       | 4     | 2      | 6     | 12234 | complete        | false        | 65      | 62      | src/db/decisions.ts:91-111, src/db/restart-hold.ts:5-6, src/core/limits.ts:4-4                       |
| q02      | deep | 3/4        | 3/4       | 13    | 8      | 18    | 48950 | limit:maxPasses | false        | 180     | 187     | src/core/limits.ts:4-4                                                                               |
| q03      | fast | 1/2        | 2/2       | 3     | 2      | 4     | 6609  | complete        | true         | 72      | 73      | src/index.ts:1567-1577                                                                               |
| q03      | deep | 2/2        | 2/2       | 13    | 8      | 15    | 35913 | limit:maxPasses | false        | 188     | 180     |                                                                                                      |
| q04      | fast | 1/4        | 1/4       | 4     | 2      | 6     | 11767 | complete        | true         | 75      | 72      | src/server/serve.ts:665-669, src/linear/intake-queue.ts:36-50, src/index.ts:428-430                  |
| q04      | deep | 1/4        | 2/4       | 13    | 8      | 18    | 34332 | limit:maxPasses | false        | 196     | 197     | src/server/serve.ts:665-669, src/linear/intake-queue.ts:36-50, src/index.ts:428-430                  |
| q05      | fast | 1/4        | 1/4       | 5     | 2      | 5     | 10783 | complete        | true         | 60      | 63      | src/loop/closeout-recovery.ts:14-54, src/loop/orchestrator.ts:3480-3480, src/closeout/run.ts:144-144 |
| q05      | deep | 2/4        | 3/4       | 14    | 8      | 16    | 32720 | limit:maxPasses | false        | 170     | 180     | src/loop/orchestrator.ts:3480-3480, src/closeout/run.ts:144-144                                      |
| q06      | fast | 0/3        | 0/3       | 4     | 2      | 6     | 24973 | complete        | false        | 109     | 114     | src/config/queue.ts:3-19, src/config/file.ts:550-554, src/loop/orchestrator.ts:4690-4705             |
| q06      | deep | 1/3        | 3/3       | 14    | 8      | 16    | 54496 | limit:maxPasses | false        | 159     | 169     | src/config/file.ts:550-554, src/loop/orchestrator.ts:4690-4705                                       |
| q07      | fast | 2/2        | 2/2       | 4     | 2      | 6     | 13276 | complete        | true         | 78      | 81      |                                                                                                      |
| q07      | deep | 2/2        | 2/2       | 11    | 8      | 18    | 41025 | limit:maxPasses | false        | 178     | 165     |                                                                                                      |
| q08      | fast | 1/4        | 4/4       | 4     | 2      | 4     | 15981 | complete        | true         | 88      | 80      | src/config/file.ts:499-508, src/config/file.ts:550-554, src/config/file.ts:563-567                   |
| q08      | deep | 1/4        | 4/4       | 14    | 8      | 16    | 44323 | limit:maxPasses | false        | 211     | 215     | src/config/file.ts:499-508, src/config/file.ts:550-554, src/config/file.ts:563-567                   |
| q09      | fast | 1/2        | 2/2       | 3     | 2      | 5     | 20117 | complete        | true         | 70      | 71      | src/db/recovery.ts:39-39                                                                             |
| q09      | deep | 1/2        | 2/2       | 12    | 8      | 16    | 45746 | limit:maxPasses | false        | 193     | 191     | src/db/recovery.ts:39-39                                                                             |
| q10      | fast | 1/2        | 1/2       | 5     | 2      | 6     | 10022 | complete        | true         | 76      | 80      | src/closeout/rounds.test.ts:9-17                                                                     |
| q10      | deep | 1/2        | 1/2       | 10    | 8      | 16    | 38125 | limit:maxPasses | false        | 194     | 181     | src/closeout/rounds.test.ts:9-17                                                                     |

| Mode | Ranges hit | Files hit | Questions with a pinned file | Median files | Median cold ms | Median warm ms |
| ---- | ---------- | --------- | ---------------------------- | ------------ | -------------- | -------------- |
| fast | 11/29      | 16/29     | 9                            | 4            | 76             | 73             |
| deep | 16/29      | 24/29     | 10                           | 13           | 184            | 181            |

## MCP queries

| Phase                    | Mode | Status      | Executed mode | ms            |
| ------------------------ | ---- | ----------- | ------------- | ------------- |
| first (cold)             | fast | unavailable | fast          | 71            |
| first (cold)             | deep | unavailable | deep          | 157           |
| warm x3                  | fast | unavailable | fast          | 58, 56, 56    |
| warm x3                  | deep | unavailable | deep          | 155, 149, 170 |
| after restart            | fast | unavailable | fast          | 84            |
| new SHA while refreshing | fast | unavailable | fast          | 136           |
| on failed index          | fast | failed      |               |               |

## Change commit

2ac93023d31b → 163ae9601785

```
A	docs/closeout-round-summary.md
M	src/closeout/index.ts
R099	src/closeout/rounds.ts	src/closeout/round-summary.ts
M	src/closeout/rounds.test.ts
M	src/closeout/run.ts
D	test/fixtures/runner-answer-uid.ts
```

## Questions and pinned evidence

### q01 · control flow · recovery

What does Paws do with work items that were in flight when the process starts up again?

Expected: recoverOnStartup runs in one immediate transaction: it shifts runner leases for downtime, lists items in awaiting_input, running, verifying, recovering and merge_queue, skips items that already have a restart question, a parked capacity wait, a pending answer resume or a pending transient retry, and asks decideStartup what to do. decideStartup returns none for non-resumable states, keep_place for a merge-queue item whose run is not active, reverify when a merge was in progress or the runner still holds a verifying item, resume with reattach when the runner holds work, ask_restart when the item was already resumed within RESUME_AGAIN_AFTER_MS, reverify for a verifying item with a candidate, and otherwise a fresh-session resume from the checkpoint. Resumes are staggered five seconds apart.

- `src/db/recovery.ts:41-101` Startup loop that filters items and applies each decision
- `src/core/recovery.ts:75-106` The decision table for each in-flight item

### q02 · exception path · recovery

What happens when Paws restarts again while a task it already resumed once after a restart is still unfinished?

Expected: decideStartup returns ask_restart when recoveryAttempts is at least 1 and less than RESUME_AGAIN_AFTER_MS (30 minutes) passed since the resume. applyAskRestart fails the item with resume_already_attempted when it has no Linear session; otherwise it moves a running or verifying item to recovering, records a restart hold, cancels its open jobs, releases run capacity and enqueues the RESTART_QUESTION asking in Linear whether to start it again. Caveat: after 30 minutes a further restart resumes again instead of asking.

- `src/core/recovery.ts:101-102` Condition that turns a second restart into a question
- `src/db/decisions.ts:91-111` What asking a restart question does, including the no-session failure
- `src/db/restart-hold.ts:5-6` The question posted in Linear
- `src/core/limits.ts:4-4` The 30 minute window

### q03 · control flow · recovery

What does Paws do to running work items when it shuts down on SIGTERM?

Expected: The shutdown flush calls prepareShutdown with a callback that commits dirty files on each in-flight item's worktree as 'wip: shutdown' when the item has a run commit policy; a failed commit is journaled and does not stop shutdown. Then, in one transaction, it marks Paws alive and, for running and verifying items that are not parked on capacity and not held by a runner, marks the run lost and moves the item to recovering unless it is verifying with a candidate. Merge-queue items keep their place unless their run is still active. This does not spend the one resume attempt.

- `src/db/recovery.ts:165-202` WIP commits and state changes at shutdown
- `src/index.ts:1567-1577` Where the shutdown flush wires the WIP commit

### q04 · cross-file behavior · linear intake

How does a Linear webhook delivery become work for the orchestrator?

Expected: The server routes POST /webhooks/linear to handleLinearWebhook when webhooks are enabled. The handler checks the HMAC signature and a 60 second timestamp window, requires a delivery id, parses the agent event, records it durably in the inbox store and answers 200 without waiting. Created and prompted events go to the intake queue, which posts the first activity on arrival and runs at most two intakes at once, oldest first, keeping each session in order. Each intake calls followUp, which hands the event to orchestrator.onLinearEvent and then reconciles the linked work item.

- `src/server/serve.ts:665-669` Route to the webhook handler
- `src/linear/webhook.ts:102-153` Verification, dedupe and hand-off to intake
- `src/linear/intake-queue.ts:36-50` The durable intake worker
- `src/index.ts:428-430` Where intake reaches the orchestrator

### q05 · cross-file behavior · closeout

How does a person's bypass of a failed Closeout check reach the Closeout decision?

Expected: A bypass is approved on the item page, not by a Linear reply. recoveryOptions reads the item's Closeout recoveries and, for link asks decided 'approve', turns each approved check with a reason into a CloseoutBypass carrying task, base, head and policy digest. The orchestrator spreads recoveryOptions into the Closeout gate options, and evaluateCandidate applies applyBypasses to the native evaluation. A bypass only counts when task, base, head and policy digest match exactly and the check is bypassable; the outcome becomes accepted only when nothing else remains, and the summary lists who approved each bypass.

- `src/loop/closeout-recovery.ts:14-54` Builds bypasses from approved checks
- `src/loop/orchestrator.ts:3480-3480` Passes them into the gate
- `src/closeout/bypass.ts:21-61` Matching rules and the resulting outcome
- `src/closeout/run.ts:144-144` Where the evaluation applies them

### q06 · configuration · queue settings

Where is the queue start timeout configured, what is its default, and how is it validated?

Expected: It is [queue] start_timeout_hours in ~/.paws/config.toml. The parser accepts any non-negative integer; readQueueSettings defaults a missing value to 24 hours and clamps it to 1..720. Settings updates through parseQueueSettings reject anything but a whole number from 1 to 720. The orchestrator re-reads it on every dispatch and falls back to 24 when the file cannot be read, journaling the error.

- `src/config/queue.ts:3-19` Default and clamping
- `src/config/file.ts:550-554` config.toml key parsing
- `src/loop/orchestrator.ts:4690-4705` Read on every dispatch with a fallback

### q07 · exception path · linear intake

What happens when a Linear intake fails, and how is it retried?

Expected: The intake worker catches the error and journals it. A missing AgentSession is marked handled and skipped. A Linear rate limit pauses the whole queue for its retry-after and reschedules the event without counting an attempt, waiting at least 30 seconds. Any other failure counts an attempt and reschedules that event after 30 s, 1 min, 2 min, 5 min, then every 10 min, without blocking other events, and logs the retry. Nothing is retried after the queue is stopped.

- `src/linear/intake-queue.ts:9-19` Concurrency and retry schedule
- `src/linear/intake-queue.ts:102-143` Failure handling per error type

### q08 · stale documentation · configuration

Does Paws refuse to start when config.toml contains an unknown key?

Expected: Only partly. docs/configuration.md says an unknown section or key stops Paws at startup. The parser does reject unknown sections and unknown keys in [linear], [tracker] and [merge], but it silently ignores unknown keys in [queue], [github], [caps], [checkout] and [agents]. A correct answer says the documentation overstates the check and cites both the doc and the parser.

- `docs/configuration.md:5-5` The documented promise
- `src/config/file.ts:499-508` A section that does reject unknown keys
- `src/config/file.ts:550-554` A section that silently ignores them
- `src/config/file.ts:563-567` Another section that ignores them

### q09 · unestablished rationale · recovery

Why does Paws wait five seconds between resuming tasks after a restart instead of resuming them all at once?

Expected: The source shows what happens, not why: STARTUP_RESUME_SPACING_MS = 5_000 and each resume recoverOnStartup enqueues gets run_at = now + 5 s times its place in line, oldest first. No comment or document in the indexed source states the reason. A correct answer describes the mechanism and says the rationale is not established by the source, possibly suggesting asking the team; it must not invent a confident reason.

- `src/db/recovery.ts:39-39` The spacing constant
- `src/db/recovery.ts:55-56` How each resume is scheduled

### q10 · changed source · closeout

How does Closeout decide a review finding's bug class, and when is a finding unclassified?

Expected: bugClass takes the lead of the finding's explanation up to the first colon, em dash, ' - ', period, semicolon or newline, trims and lowercases it. An empty lead or one longer than CLASS_LIMIT (60 characters) is UNCLASSIFIED. summarizeReviewRounds counts classes across rounds, ignoring unclassified findings, and the most frequent class wins with the later one breaking ties.

- `src/closeout/rounds.ts:16-29` The rule and the limit at the base commit
- `src/closeout/rounds.test.ts:9-17` Tests of the rule

### q10-after · changed source · closeout

How does Closeout decide a review finding's bug class, and when is a finding unclassified?

Expected: Same rule as q10, now in src/closeout/round-summary.ts with CLASS_LIMIT 40: a lead longer than 40 characters is UNCLASSIFIED. The new docs note states the 40 character limit. A correct answer cites only the new path and the new limit at the new commit.

- `src/closeout/round-summary.ts:16-29` The renamed module with the changed limit
- `docs/closeout-round-summary.md:1-3` The added note

## Answers and reviewer scores

No model provider configured (LOOKY_PROVIDER unset); answers and reviewer scores are pending.
