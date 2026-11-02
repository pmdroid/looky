# Real-provider browser smoke

The [browser tests](../README.md#browser-tests) prove the browser flow with scripted model
replies. They cannot show whether real answers are useful. This manual smoke runs the same
production app against a configured real provider and a real codebase. Record every run
below. The browser app is not fully validated until the record has a run that passed.

This is a quick check of the browser path, not the answer-quality pilot. The roughly ten
pilot questions and their scoring belong to PAS-971, the agent and MCP pilot. Take the
questions from that pilot's list where one exists, so both use one corpus.

## Before you start

- Bun 1.4.4 and a checkout of this repository at the commit under test.
- A local clone of the codebase to ask about, such as `pmdroid/paws-app`. Point Looky at a
  clone it may read. Looky reads committed Git objects only and never changes the clone.
- Credentials for one model provider, hosted or local. See
  [Model providers](../README.md#model-providers).

## Procedure

1. Install and build the app:

   ```sh
   bun install --frozen-lockfile && bun run web:build
   ```

2. Start the service with a separate data directory, the browser client and the provider.
   Replace the angle-bracket values:

   ```sh
   LOOKY_DATA_DIR=$HOME/looky-smoke-data \
   LOOKY_REPOSITORIES=paws-app \
   LOOKY_REPOSITORY_PAWS_APP_PATH=<path to the paws-app clone> \
   LOOKY_CLIENTS=web \
   LOOKY_CLIENT_WEB_TOKEN=<random secret, at least 32 characters> \
   LOOKY_CLIENT_WEB_REPOSITORIES=paws-app \
   LOOKY_BROWSER_CLIENT=web \
   LOOKY_BROWSER_ASSETS_DIR=dist/web \
   LOOKY_SOURCE_LINK_TEMPLATE='https://github.com/pmdroid/paws-app/blob/{sha}/{path}#L{startLine}-L{endLine}' \
   LOOKY_PROVIDER=hosted \
   LOOKY_PROVIDER_HOSTED_KIND=<openai or anthropic> \
   LOOKY_PROVIDER_HOSTED_MODEL=<model> \
   LOOKY_PROVIDER_HOSTED_API_KEY=<key> \
   bun run serve
   ```

3. Open `http://127.0.0.1:7341/`. Choose `paws-app` and `HEAD`. Note the pinned SHA and
   check that it equals `git -C <clone> rev-parse HEAD`. Wait for "Index ready for this
   commit.", and note how long the first index took.
4. Ask in **Fast**: a multi-file question from the pilot, such as how an interrupted run
   is recovered.
5. Ask the same question in **Deep**.
6. Ask one question whose intent the code cannot show, such as why a design was chosen.
   Expect "Not established" or a question for the team, not a confident rationale.
7. For each answer, open two or three source links. Check that each link opens the cited
   lines at the pinned SHA, and that those lines support the sentence next to the citation.
8. Spot-check interruptions. Cancel a running Deep question, then switch the revision while
   a question runs. Confirm that no answer appears for either question.
9. Stop the service with Ctrl-C and add a row to the record below.

## Wiki reader

Run this part after the question steps, on the same service and commit.

1. Open the **Wiki** view. Check that it says "No wiki for this commit yet" and that
   nothing has been generated yet. Press **Generate wiki** once and watch the page count
   rise. Note the time it took and the usage the service logged.
2. Read the overview, then one module and one workflow. For each, open two cited source
   links and check that they open the cited lines at the pinned SHA and support the text.
3. Search the docs for a word from one section heading, and open the result. Check that
   the page opens at that heading.
4. On a module page, use **Ask about this page** in Fast and then in Deep. Check that the
   answers cite source, not the page.
5. Reload a page at a heading, then use Back and Forward. Check that each returns to the
   same page and heading.

Record the wiki run as its own row, with the mode column set to `wiki`.

## What to record

For each question, record the following:

- Date, Looky commit, codebase, the exact SHA and the mode.
- Provider kind and model. Never record the key.
- Outcome shown, elapsed time, source reads and model calls, from "About this answer".
- Answer quality: whether it is a complete explanation, and whether anything was wrong or
  unsupported.
- Citation quality: how many links you opened, and whether every one supported its claim.
- Whether it passed. Record any defect with enough detail to reproduce it.

## Record

| Date       | Looky commit  | Codebase and SHA  | Mode | Provider and model                           | Ran | Answer and citation quality                                                                                                                     | Result                 |
| ---------- | ------------- | ----------------- | ---- | -------------------------------------------- | --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| 2026-11-01 | PAS-983       | none              | none | none                                         | No  | Not observed                                                                                                                                    | Blocked, see the note. |
| 2026-11-02 | 1c806ba + #13 | paws-app 2ac93023 | Fast | OpenCode Go `minimax-m3.1-flash`, effort low | Yes | q01 supported in 6.4 s, 10 links; q09 partial in 4.3 s with "the code does not say why" and a question for the team; 3 links per answer checked | Passed                 |
| 2026-11-02 | 1c806ba + #13 | paws-app 2ac93023 | Deep | OpenCode Go `minimax-m3.1-flash`, effort low | Yes | q01 supported in 23.5 s, 19 links, 3 checked; cancelled Deep q04 showed Cancelled and no answer in 15 s                                         | Passed                 |

**Note for 2026-11-01.** The PAS-983 agent environment had no provider credentials and no
`paws-app` clone. The smoke therefore did not run, and no real answer or citation was
observed. Only the deterministic browser tests ran, with all 26 passing against scripted
replies. They do not validate answer quality. Pascal, or anyone with credentials, should run
the procedure above and add a row.

**Note for 2026-11-02.** Run in headless Chromium on 127.0.0.1 with local auth by
`scripts/ui.ts` in [the model benchmark](../pilot/results/2026-11-02-paws-app-2ac93023-model-benchmark/summary.md).
The page pinned `2ac93023d31bab6f0ef26690a7e6e8e8d2540bff`, equal to the clone's HEAD, and
showed the index ready after 3.3 s. Each checked link named the pinned SHA and lines that
exist in the file. No page errors or dialogs. The revision switch in step 8 was not exercised,
because the clone had a single commit.
