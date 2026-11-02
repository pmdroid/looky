# Wiki pilot

`run.ts` (`bun run wiki:pilot`) records a real-provider wiki run. It generates at a pinned
commit, refreshes at a second commit, restarts the service, and exercises docs search and
one page question per mode through the production React build. The
[runbook](../../docs/wiki-runbook.md#8-record-a-real-provider-run) shows the command.

## Validation status

| Item                                                     | Status   | Detail                                                     |
| -------------------------------------------------------- | -------- | ---------------------------------------------------------- |
| Deterministic chain through the browser API              | Done     | `test/acceptance/wiki.test.ts`, adversarial scripted model |
| Runner dry run with the scripted provider                | Done     | 29 of 29 checks; fixture evidence, not model evidence      |
| Real OpenCode Go `minimax-m3.1-flash` run at two commits | Not done | No provider key reached the agent runner                   |
| Reviewed real corpus: overview, architecture, 2+2 pages  | Not done | Needs the real run                                         |
| React search and Fast/Deep page questions, real model    | Not done | Needs the real run                                         |

On 2026-11-02 the team decided to land the deterministic work without the real run and to
track the real-model evidence separately. PAS-1001's acceptance requires that evidence, so
the issue is not complete until a recorded run and its review are committed under
`pilot/results/`. No results from this runner exist yet; nothing here should be read as a
real-model result.
