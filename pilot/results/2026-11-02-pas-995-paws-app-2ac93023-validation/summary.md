# PAS-995 validation on paws-app 2ac93023

This record checks the remaining PAS-995 requirements against committed evidence and one new
model-free pilot run. **PAS-995 is not complete.** Restart reuse and the source revision change
pass. Revision switching during a question passes only in deterministic tests. The real Paws
coding session is blocked by a missing Paws-side adapter. A real-provider check of the revision
switch needs a paid run that this issue does not authorize, and this runner has no provider
credentials.

No paid model call was made for this record. No credential value appears in it.

## Status

| Requirement                                    | Status           | Evidence                                                              |
| ---------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
| Useful real answers, 8 of 10 per mode          | Done earlier     | `../2026-11-02-paws-app-2ac93023-model-benchmark/summary.md`, reused  |
| Real-provider browser smoke                    | Done earlier     | `docs/browser-smoke.md` record and the benchmark `ui/` folder         |
| Restart reuses the persisted index and session | Pass, model-free | This run, the two restart checks in `report.md`                       |
| A real-provider answer after a restart         | Not recorded     | No real-provider run restarted the service                            |
| One source revision change and refresh         | Pass, model-free | This run, refresh checks; real answers at the new commit not recorded |
| Revision switch during a question, MCP         | Not exercised    | Without a model the question ends before the switch                   |
| Revision switch during a question, browser     | Pass, scripted   | `e2e/interrupts.e2e.ts`, 9 of 9 tests, scripted model replies         |
| One real Paws coding-session MCP call per mode | Blocked          | paws-app `e4866dc1` has no Looky adapter, see below                   |

Model-free and scripted results show the lifecycle and pinning logic. They are not real-provider
acceptance, and this record does not count them as such.

## The new pilot run

Looky `4ad5983` plus the revision-switch phase added to `pilot/run.ts` in this change. Bun 1.4.4.
A fresh clone of `pmdroid/paws-app` at `2ac93023d31bab6f0ef26690a7e6e8e8d2540bff`. No provider was
configured. All 39 checks passed. `report.md` and `results.json` in this folder hold the full run.
The data directory and work paths in `results.json` were temporary and no longer exist.

```sh
bun install --frozen-lockfile
env -u LOOKY_PROVIDER bun run pilot --work <empty directory>
```

### Restart and reuse

- The cold build `build_defd3001-0d47-4494-8049-8c2f5eb298a9` indexed 1775 files in 1.7 s.
- After a clean stop and restart, index status for `2ac93023` was `ready` on the same build.
  No new build ran.
- The session token registered before the restart was accepted after it. The question came back
  `unavailable` because no provider was configured, not `denied`.
- The earlier runs agree. The 2026-11-01 pilot and the benchmark's model-free baseline recorded
  the same restart checks as passing on their own builds.

The benchmark scripts never restarted the service, so no real answer after a restart exists.

### Source revision change

The pilot committed `14321c797b0e897ade534b7cdf0836d6cf4f0716` on top of `2ac93023`. It renames
`src/closeout/rounds.ts`, edits three importers, adds a docs note and deletes a fixture.

- The refresh was incremental from the cold build. It counted 2 added, 3 modified and 2 deleted
  paths and reused 1770 files.
- The base commit kept serving its own build.
- Research at the new commit cited `src/closeout/round-summary.ts` and never the old path. Research
  at the base still cited `src/closeout/rounds.ts` and never the new one.
- The deleted file was searchable only at the base. The added file was searchable only at the new
  commit.
- The superseded session was denied as `stale_session`.

### Revision switch during a question

The new phase starts a Deep question on the base session, waits 250 ms, then registers the next
session sequence at the new commit while the question is still running. When the question was
still running at the switch, the pilot requires it to end `denied` with `stale_session`, so the
old revision receives no result. When it had already ended, the pilot records the overlap as not
exercised and only checks that it did not answer from another revision.

In this run the question ended `unavailable` after 135 ms, before the switch. The overlap was
therefore not exercised. With a provider a Deep question takes 21 to 61 seconds, so the same
command exercises it.

The service-level test for the same rule passes with a scripted model. It is "a superseded client
generation gets no result for running work" in `test/acceptance/safety.test.ts`.

The browser tests in `e2e/interrupts.e2e.ts` passed 9 of 9 with scripted model replies. They
include switching repository mid-question, a late result of an earlier revision never showing,
and back and forward between revisions.

## The Paws-side adapter

paws-app at `e4866dc1f490ed4104d6e16cb428522b7e4c860d`, its main on 2026-11-02, has no Looky code.
The only MCP server a coding agent receives is the local stdio `paws` server. The work below is in
paws-app and belongs to its own issue. Looky needs no change for it.

1. **Configuration.** Add a Looky base URL and a client adapter token to the control plane. Store
   the token as a secret file, like the other `~/.paws/secrets/` entries. Add a per-repository
   mapping from `owner/repo` to a Looky `repositoryId`, since Looky only serves configured
   repositories.
2. **Session registration.** For each run of a mapped repository, the control plane calls
   `POST /v1/sessions` through the client in `src/client/looky-client.ts`. It sends the task id,
   the run generation as `sequence` and `clientGeneration`, the repository id, `baseSha` as `sha`
   and a clean worktree state. The command is assembled in `src/runner-backend/index.ts` around
   lines 1378 to 1410, where `repository.baseSha` is known.
3. **Token delivery.** Pass the returned MCP URL and session token to the runner in the run
   command, then into `RunAgentOptions` in `src/acp/types.ts`. Signed run commands are stored in
   `runner_command.envelope`, so the token must not be kept there in plain text, or must be
   delivered another way.
4. **MCP attachment.** Append an HTTP MCP entry with an `Authorization: Bearer` header to the
   `mcpServers` list in `src/acp/run.ts` near line 482. Today that list holds only the stdio bridge.
   If an agent does not advertise HTTP MCP support, wrap the HTTP endpoint in a stdio proxy.
5. **Lifecycle.** Revoke the Looky session with `DELETE /v1/sessions/{id}` when the run generation
   ends. A higher `sequence` fences older generations automatically.
6. **Network.** Runners can be on other hosts than the control plane, so the Looky URL must be
   reachable from every runner that receives it.

After that lands, record one coding-session `ask_project` call in each mode from a real Paws run
on a mapped repository. A pilot harness call does not count.

## Required decisions

- **Paws-side adapter.** The team must open and authorize the paws-app change above. Paws cannot
  produce the real-session evidence until it is deployed.
- **Paid validation run.** The real-provider checks still missing are a Deep question during a
  revision switch, an answer after a restart and answers at the changed commit. One run of the
  command below covers them. With the benchmark's OpenCode Go `minimax-m3.1-flash` at effort low it
  asks about 33 questions, 17 Fast and 16 Deep. That is under $0.20 at the benchmark's list-price
  estimates. It needs explicit
  approval and provider credentials on the machine that runs it.

```sh
LOOKY_PROVIDER=<configured provider> <LOOKY_PROVIDER_* variables from the README> \
  bun run pilot --work <empty directory>
```

## Unavailable values

- **Real-provider latency, usage and cost.** This run has none, because it made no model call.
- **Answers and citations.** This run has no answers. The full scored answers from real models
  are in the benchmark folder.
- **OpenCode Go per-request allowance.** Go returned none in the benchmark. Its cost there is a
  list-price estimate.
