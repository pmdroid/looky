# Generated wiki runbook

How to install Looky, configure a provider, generate a wiki for one commit, browse and
search it, refresh it at a new commit, and recover from failures. Every command here
uses the existing Bun and SQLite deployment. Nothing needs a database edit.

The [README](../README.md#generated-wiki-model) explains how planning, generation,
refresh and publication work. This page is the operator's sequence.

## 1. Install

```sh
git clone https://github.com/pmdroid/looky && cd looky
mise install                  # or install Bun 1.4.4 another way
bun install --frozen-lockfile
bun run check                 # format, lint, typecheck and unit/acceptance tests
bun run web:build             # production React build in dist/web
bun run e2e:install           # Chromium, only for browser tests and the wiki pilot
```

## 2. Configure

Looky keeps everything in one SQLite file under `LOOKY_DATA_DIR`. Keep it outside the
checkout. The repository must be a local Git clone. Looky reads only committed source.

```sh
export LOOKY_DATA_DIR=/var/lib/looky/data
export LOOKY_REPOSITORIES=paws-app
export LOOKY_REPOSITORY_PAWS_APP_PATH=/var/lib/looky/repos/paws-app
```

The provider is configured only by environment variables, and the key stays server
side. The model recommended by the benchmark in
`pilot/results/2026-11-02-paws-app-2ac93023-model-benchmark` is OpenCode Go
`minimax-m3.1-flash` at reasoning effort `low`:

```sh
export LOOKY_PROVIDER=ocgo
export LOOKY_PROVIDER_OCGO_KIND=openai
export LOOKY_PROVIDER_OCGO_BASE_URL=https://opencode.ai/inference/go/openai/v1
export LOOKY_PROVIDER_OCGO_MODEL=minimax-m3.1-flash
export LOOKY_PROVIDER_OCGO_REASONING_EFFORT=low
export LOOKY_PROVIDER_OCGO_API_KEY=<key>
export LOOKY_PROVIDER_OCGO_TIMEOUT_MS=120000
```

Generation budgets are finite by default. A generation stops at 80 model calls, 1.6 M
input tokens, 120 k output tokens or 30 minutes, whichever comes first, and then stays
unpublished. Tighten them for a first run, for example:

```sh
export LOOKY_WIKI_TOTAL_MAX_MODEL_CALLS=40
export LOOKY_WIKI_MAX_CONCURRENT_PAGES=2
```

Set `LOOKY_SOURCE_LINK_TEMPLATE` to turn citations into links pinned to the commit:

```sh
export LOOKY_SOURCE_LINK_TEMPLATE='https://github.com/org/paws-app/blob/{sha}/{path}#L{startLine}-L{endLine}'
```

## 3. Generate

Pin an exact commit. A branch name moves; a full SHA does not.

```sh
SHA=$(git -C "$LOOKY_REPOSITORY_PAWS_APP_PATH" rev-parse HEAD)
bun run looky index --repo "$LOOKY_REPOSITORY_PAWS_APP_PATH" --sha "$SHA" --id paws-app
bun run looky wiki plan --repo "$LOOKY_REPOSITORY_PAWS_APP_PATH" --sha "$SHA" --id paws-app
bun run looky wiki generate --repo "$LOOKY_REPOSITORY_PAWS_APP_PATH" --sha "$SHA" --id paws-app
```

`wiki plan` prints the bounded page plan and its coverage without storing it or calling
a model. It needs a ready index, so run `looky index` first. `wiki generate` indexes when
needed, writes every page and publishes the wiki in one transaction. Running it again
for the same commit and configuration returns the published wiki without a model call.
Ctrl-C cancels it, and nothing is published.

## 4. Browse, search and ask

From the command line:

```sh
bun run looky wiki status --id paws-app --sha "$SHA"
bun run looky wiki index <generation-id> --id paws-app
bun run looky wiki page <generation-id> overview --id paws-app
bun run looky wiki search <generation-id> "recovery" --id paws-app --limit 5
```

In the browser, configure a browser client and start the service:

```sh
export LOOKY_CLIENTS=web
export LOOKY_CLIENT_WEB_TOKEN=<secret> LOOKY_CLIENT_WEB_REPOSITORIES=paws-app
export LOOKY_BROWSER_CLIENT=web LOOKY_BROWSER_ASSETS_DIR=dist/web
bun run serve
```

Open `http://127.0.0.1:7341/wiki?repo=paws-app&ref=<sha>`. The sidebar is the page
index. "Search the docs" searches the published pages of that commit. A page's question
box asks about the page in Fast or Deep, pinned to the same repository and commit. The
page is retrieval context only; the answer is grounded in source evidence.

## 5. Refresh at a new commit

Generate again with the new SHA:

```sh
NEW=$(git -C "$LOOKY_REPOSITORY_PAWS_APP_PATH" rev-parse HEAD)
bun run looky wiki generate --repo "$LOOKY_REPOSITORY_PAWS_APP_PATH" --sha "$NEW" --id paws-app
```

The index refreshes incrementally first. The new wiki is planned from the new commit
and compared with the last published one. Pages whose inputs and blobs are unchanged
are carried forward without a model call and say "Carried forward unchanged from
commit …". Every other page is written again, with its reason in the output. Until the
new wiki publishes, the browser shows the old one only as stale, and never as the new
commit's wiki. Slugs of removed pages answer `410 page_removed`, and renamed slugs
redirect.

## 6. Inspect stale and failed state

`wiki status` lists every generation of a repository, newest first. The fields that
matter are `state`, `errorCode`, `errorMessage`, `retryable`, `usage` and `refresh`.
To print just those:

```sh
bun run --silent looky wiki status --id paws-app --sha "$SHA" | bun -e '
  for (const g of JSON.parse(await Bun.stdin.text()))
    console.log(g.id, g.sha.slice(0, 12), g.state, g.errorCode ?? "", g.retryable ?? "",
      JSON.stringify({ calls: g.usage?.modelCalls, written: g.usage?.pagesWritten,
        reused: g.usage?.pagesReused, failed: g.usage?.pagesFailed }))'
```

| State       | Meaning                                             | What to do                |
| ----------- | --------------------------------------------------- | ------------------------- |
| `queued`    | Waiting for a generation slot                       | Wait                      |
| `running`   | Pages are being written                             | Wait, or cancel           |
| `ready`     | Published; served for its commit                    | Nothing                   |
| `failed`    | Stopped; `errorCode` says why; never served         | Fix the cause, then retry |
| `cancelled` | Stopped by Ctrl-C, the browser or `service_stopped` | Retry when wanted         |

Common error codes are `budget_exhausted`, a budget ran out; `unavailable`, the provider
could not serve; `interrupted`, the process died; and `pages_failed`, a page could not
be grounded. A published generation of another commit or configuration is reported as
`stale` with reasons such as `revision` or `configuration`. The browser API reports the
same thing at `GET /browser/v1/revisions/<id>/wiki`.

For a closer look, open the database read-only. Never write to it by hand:

```sh
bun -e "import { Database } from 'bun:sqlite';
  const db = new Database('$LOOKY_DATA_DIR/looky.sqlite', { readonly: true });
  console.table(db.query('SELECT id, substr(sha,1,12) sha, state, error_code, retryable, retired_at FROM wiki_generations ORDER BY created_at DESC').all());
  console.table(db.query('SELECT generation_id, state, refresh_reason, count(*) n FROM wiki_pages GROUP BY 1,2,3').all());"
```

## 7. Recover

| Situation                        | Command                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| Failed or cancelled generation   | Run the same `wiki generate` again, with `--rebuild` if the failed one was a rebuild |
| Process killed mid-generation    | Restart; the generation is marked `interrupted`, then run `wiki generate`            |
| Configuration changed on purpose | Run `wiki generate`; every page is rewritten                                         |
| Suspect output for a commit      | `wiki generate --rebuild`; the old wiki serves until it publishes                    |
| Index build failed               | `looky status --id <repo> --sha <sha>`, then `looky retry <build-id> --repo <dir>`   |
| Old generations and builds       | `looky gc`                                                                           |

A new attempt reuses every page an earlier attempt finished, so it pays only for the
rest. Nothing is retried automatically. In the browser, failed and cancelled
generations show a Retry button, and running ones a Cancel button.

## 8. Record a real-provider run

`bun run wiki:pilot` runs steps 3 to 6 against the production service and the
production React build. It writes the page index, every page, every citation with its
exact lines, search results, usage, timings and automatic checks to `--out`:

```sh
bun run wiki:pilot --repo "$LOOKY_REPOSITORY_PAWS_APP_PATH" --id paws-app \
  --sha <first-sha> --next <second-sha> --out pilot/results/<date>-wiki-<repo>-<sha> \
  --link-template "$LOOKY_SOURCE_LINK_TEMPLATE" --query recovery --query configuration
```

It uses the configured `LOOKY_PROVIDER*` and `LOOKY_WIKI_*` settings and never records
a credential. The automatic checks are necessary but not enough. A person still reads
the overview, architecture, two module pages and two workflow pages against
`citations.json`, and adds the findings to `report.md`.
