# Model benchmark on paws-app 2ac93023

Looky `1c806ba` with the reasoning-effort setting from pmdroid/looky#13 answered the ten pilot
questions in `pilot/questions.json` against `pmdroid/paws-app` at
`2ac93023d31bab6f0ef26690a7e6e8e8d2540bff`, in Fast and Deep, through the MCP endpoint as a Paws
agent would. Every answer is the model's own text. Each was read and scored against the
question's reviewer key, and its citations were checked against the pinned commit.
`report.html` has every answer, score, timing and model call; open it in a browser.

## Recommendation

| Mode | Default                                      | Useful | Median | Notes                                                |
| ---- | -------------------------------------------- | ------ | ------ | ---------------------------------------------------- |
| Fast | OpenCode Go `minimax-m3.1-flash`, effort low | 8/10   | 5.1 s  | No JSON repairs, no truncated replies                |
| Deep | OpenCode Go `minimax-m3.1-flash`, effort low | 9/10   | 36 s   | Ties the other two models on quality; on the Go plan |

OpenRouter `google/gemini-3.8-flash` at effort low matched it (8/10 Fast, 9/10 Deep) with a
faster Deep median of 22 s, at about five times the cost per Deep answer, and it labelled more
partial answers `supported`. A session selects one provider policy, so one model serves both
modes.

## Full runs

Default Looky budgets, identical questions and revision. Model time is measured per call at a
local proxy. Ten questions per cell are too few for a p95, so medians and ranges are given.

| Model                         | Provider    | Mode | Useful | Answered | Median | Range       | Calls | Repairs | Est. cost |
| ----------------------------- | ----------- | ---- | ------ | -------- | ------ | ----------- | ----- | ------- | --------- |
| minimax-m3.1-flash, low       | OpenCode Go | Fast | 8/10   | 10/10    | 5.1 s  | 3.3–14.5 s  | 10    | 0       | $0.011    |
| minimax-m3.1-flash, low       | OpenCode Go | Deep | 9/10   | 10/10    | 35.8 s | 21.0–61.0 s | 41    | 1       | $0.093    |
| google/gemini-3.8-flash, low  | OpenRouter  | Fast | 8/10   | 10/10    | 6.3 s  | 3.4–14.5 s  | 10    | 0       | $0.060    |
| google/gemini-3.8-flash, low  | OpenRouter  | Deep | 9/10   | 10/10    | 22.0 s | 16.9–51.1 s | 40    | 0       | $0.463    |
| glm-5.3-flash, default effort | OpenCode Go | Fast | 6/10   | 9/10     | 12.1 s | 6.7–24.8 s  | 13    | 3       | $0.014    |
| glm-5.3-flash, default effort | OpenCode Go | Deep | 9/10   | 10/10    | 49.1 s | 26.8–95.0 s | 42    | 2       | $0.091    |

No answer cited a range outside its revision or evidence it had not read. Time outside the model
(retrieval, verification, overhead) had a median of 65–90 ms in Fast and 250–300 ms in Deep.

q08 (stale documentation) was not useful for any model in either mode: research never reached
the `assignConfig` branches that ignore unknown keys in `[queue]` and `[caps]`.

## Smoke runs

Fifteen configurations answered q01 in both modes first. Without a reasoning setting, DeepSeek
V4.1 Flash, MiniMax M3.1 Flash and Claude Haiku 5.5 hit the output limit and returned empty or
truncated replies; MiMo V2.6 Flash and Qwen 3.8 Flash timed out. At effort low MiniMax, Gemini
3.8 Flash and GLM 5.3 Flash on OpenRouter passed; DeepSeek still failed Fast once. `runs/smoke-*`
holds each run.

## React app

`ui/ui.json` and the screenshots record the browser smoke with real answers. It is also recorded
in `docs/browser-smoke.md`.

## Validation status

| Item                                    | Status  | Detail                                                                |
| --------------------------------------- | ------- | --------------------------------------------------------------------- |
| Ten questions, both modes, three models | Done    | 60 answers scored in `scores/`                                        |
| React app with a real provider          | Done    | Fast, Deep, rationale question, source links, cancel                  |
| Gemini Flash on OpenCode Go             | Blocked | Go offers no Gemini Flash; Gemini 3.8 Flash ran through OpenRouter    |
| Paws coding session through Looky       | Blocked | paws-app `2038ffd7e` has no Looky adapter; not replaced by a mock     |
| Revision switch during a question       | Skipped | The clone had one commit                                              |
| OpenCode Go allowance per request       | Skipped | Go returned no `opencode.allowance`; Go cost is a list-price estimate |

## Spend

OpenCode Go: 162 requests, about $0.31 at list price. OpenRouter: 79 requests, $0.62 as reported
per response by OpenRouter. Hard caps of $3.00 and $2.80 at the local proxies were not reached.

## Files

- `runs/`: every response with per-call timing and token usage.
- `scores/`: per-answer ratings and review notes.
- `summary.json`: aggregates used by the report.
- `calls-*.jsonl`: per-call metadata from the proxies, without prompts, replies or keys.
- `baseline/`: the model-free pilot run on the same revision.
- `scripts/`: the proxy, runner, browser smoke, aggregation and report generator.
- `reasoning-effort.patch`: the change from pmdroid/looky#13 the runs used.
