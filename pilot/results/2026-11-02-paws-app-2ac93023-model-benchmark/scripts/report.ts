import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const R = join(import.meta.dir, "..");
const questions = JSON.parse(readFileSync(join(R, "../../questions.json"), "utf8"))
  .questions as any[];
const { summary, spend } = JSON.parse(readFileSync(join(R, "summary.json"), "utf8"));
const runs = Object.fromEntries(
  readdirSync(join(R, "runs")).map((f) => [
    f.replace(/\.json$/, ""),
    JSON.parse(readFileSync(join(R, "runs", f), "utf8")),
  ]),
);
const scores = Object.fromEntries(
  readdirSync(join(R, "scores")).map((f) => [
    f.replace(/\.json$/, ""),
    JSON.parse(readFileSync(join(R, "scores", f), "utf8")).scores,
  ]),
);
const ui = JSON.parse(readFileSync(join(R, "ui/ui.json"), "utf8"));
const baseline = JSON.parse(
  readFileSync(join(R, "baseline/model-free-pilot-results.json"), "utf8"),
);
const patch = readFileSync(join(R, "reasoning-effort.patch"), "utf8");
const png = (name: string) =>
  `data:image/png;base64,${readFileSync(join(R, "ui", name)).toString("base64")}`;

const esc = (s: unknown) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const sec = (ms: number | null) => (ms == null ? "–" : `${(ms / 1000).toFixed(1)} s`);
const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 3 : 2)}`;
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k` : String(n));
const prose = (text: string) =>
  esc(text)
    .split(/\n{2,}/)
    .map(
      (p) =>
        `<p>${p
          .replace(/`([^`]+)`/g, "<code>$1</code>")
          .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
          .replace(/\n/g, "<br>")}</p>`,
    )
    .join("");

const FULL = [
  {
    run: "full-minimax-m3.1-flash-low",
    label: "MiniMax M3.1 Flash",
    sub: "OpenCode Go · effort low",
  },
  {
    run: "full-or-gemini-3.8-flash-low",
    label: "Gemini 3.8 Flash",
    sub: "OpenRouter · effort low",
  },
  { run: "full-glm-5.3-flash", label: "GLM 5.3 Flash", sub: "OpenCode Go · default effort" },
];
const sumOf = (run: string) => summary.find((s: any) => s.run === run);

const glance = FULL.map((f) => {
  const s = sumOf(f.run);
  return s.modes
    .map(
      (m: any) => `<tr>
  <th scope="row"><span class="model">${esc(f.label)}</span><span class="sub">${esc(f.sub)}</span></th>
  <td><span class="mode mode-${m.mode}">${m.mode}</span></td>
  <td class="num"><span class="meter ${m.useful >= 8 ? "ok" : "bad"}">${m.useful}/10</span></td>
  <td class="num">${m.answered}/10</td>
  <td class="num">${sec(m.medianTotalMs)}</td>
  <td class="num">${sec(m.minTotalMs)}–${sec(m.maxTotalMs)}</td>
  <td class="num">${sec(m.medianModelMs)}</td>
  <td class="num">${m.medianNonModelMs} ms</td>
  <td class="num">${m.modelCalls}</td>
  <td class="num">${m.repairCalls}</td>
  <td class="num">${m.lengthStops}</td>
  <td class="num">${k(m.inputTokens)} / ${k(m.outputTokens)}</td>
  <td class="num">${usd(m.estUsd)}</td>
  <td class="num">${m.citationProblems}</td>
</tr>`,
    )
    .join("");
}).join("");

const grid = questions
  .map((q) => {
    const cells = FULL.flatMap((f) =>
      ["fast", "deep"].map((mode) => {
        const s = scores[f.run].find((x: any) => x.q === q.id && x.mode === mode);
        const row = runs[f.run].rows.find((r: any) => r.q === q.id && r.mode === mode);
        const total = s.correct + s.useful + s.clear + s.uncertainty + s.citations;
        return `<td class="cell ${s.isUseful ? "yes" : "no"}" title="${esc(s.note)}"><a href="#a-${f.run}-${q.id}-${mode}">${s.isUseful ? "useful" : "not useful"}</a><span>${total}/10 · ${sec(row.totalMs)}</span></td>`;
      }),
    );
    return `<tr><th scope="row"><span class="qid">${q.id}</span> ${esc(q.category)}</th>${cells.join("")}</tr>`;
  })
  .join("");

const smokeRows: [string, string, string, string, string][] = [
  [
    "glm-5.3-flash",
    "OpenCode Go",
    "default",
    "smoke-glm-5.3-flash",
    "Passes cleanly; little hidden reasoning.",
  ],
  [
    "deepseek-v4.1-flash",
    "OpenCode Go",
    "default",
    "smoke-deepseek-v4.1-flash",
    "Reasoning used all 1,500 Fast output tokens; empty reply.",
  ],
  [
    "minimax-m3.1-flash",
    "OpenCode Go",
    "default",
    "smoke-minimax-m3.1-flash",
    "Reasoning used the whole output budget; empty reply.",
  ],
  [
    "mimo-v2.6-flash",
    "OpenCode Go",
    "default",
    "smoke-mimo-v2.6-flash",
    "Slow endpoint; Deep synthesis hit the 60 s per-call timeout.",
  ],
  [
    "claude-haiku-5-5",
    "OpenCode Go",
    "default",
    "smoke-claude-haiku-5-5",
    "Hit the output limit; Fast JSON truncated.",
  ],
  [
    "qwen3.8-flash",
    "OpenCode Go",
    "default",
    "smoke-qwen3.8-flash",
    "Too slow; ignored max_tokens (1,571 of 600).",
  ],
  [
    "deepseek-v4.1-flash",
    "OpenCode Go",
    "low",
    "smoke-low-deepseek-v4.1-flash",
    "Still hit the limit in Fast; a separate debug run passed in 9 s. Inconsistent.",
  ],
  [
    "minimax-m3.1-flash",
    "OpenCode Go",
    "low",
    "smoke-low-minimax-m3.1-flash",
    "Fixed by low effort; fastest clean pass.",
  ],
  [
    "qwen3.8-flash",
    "OpenCode Go",
    "low",
    "smoke-low-qwen3.8-flash",
    "Fast passes slowly; Deep cross-check timed out.",
  ],
  [
    "google/gemini-3.8-flash",
    "OpenRouter",
    "low",
    "smoke-or-low-google_gemini-3.8-flash",
    "Passes; Deep partial.",
  ],
  [
    "google/gemini-3.1-flash-lite",
    "OpenRouter",
    "low",
    "smoke-or-low-google_gemini-3.1-flash-lite",
    "Fast repair also truncated.",
  ],
  [
    "stepfun/step-3.7-flash",
    "OpenRouter",
    "low",
    "smoke-or-low-stepfun_step-3.7-flash",
    "Fast hit the output limit; Deep 90 s.",
  ],
  [
    "z-ai/glm-5.3-flash",
    "OpenRouter",
    "low",
    "smoke-or-low-z-ai_glm-5.3-flash",
    "Passes; one JSON repair in Fast.",
  ],
  [
    "minimax/minimax-m3.1-flash",
    "OpenRouter",
    "low",
    "smoke-or-low-minimax_minimax-m3.1-flash",
    "Passes; one JSON repair in Deep.",
  ],
  [
    "inclusionai/ling-3.1-flash",
    "OpenRouter",
    "default (no effort support)",
    "smoke-or-inclusionai_ling-3.1-flash",
    "Fast timed out; Deep plan hit the limit.",
  ],
];
const smoke = smokeRows
  .map(([model, provider, effort, run, cause]) => {
    const s = sumOf(run);
    const cell = (m: any) => {
      const r = runs[run].rows.find((x: any) => x.mode === m.mode);
      const ok = r.response.status === "answered";
      const label = ok
        ? r.response.answer.outcome
        : `${r.response.status}${r.response.code ? ` · ${r.response.code}` : ""}`;
      return `<td><span class="pill ${ok ? "ok" : "bad"}">${esc(label)}</span><span class="t">${sec(r.totalMs)}</span></td>`;
    };
    return `<tr><th scope="row"><code>${esc(model)}</code></th><td>${provider}</td><td>${esc(effort)}</td>${s.modes.map(cell).join("")}<td>${esc(cause)}</td></tr>`;
  })
  .join("");

const baselineRows = (["fast", "deep"] as const)
  .map((mode) => {
    const rows = (baseline.retrieval ?? []).filter(
      (r: any) => r.mode === mode && !String(r.id).includes("after"),
    );
    const hit = rows.reduce((a: number, r: any) => a + (r.coverage?.rangesHit ?? 0), 0);
    const pins = rows.reduce((a: number, r: any) => a + (r.coverage?.pins ?? 0), 0);
    return rows.length
      ? `<tr><td><span class="mode mode-${mode}">${mode}</span></td><td class="num">${hit}/${pins}</td></tr>`
      : "";
  })
  .join("");

const answers = FULL.flatMap((f) =>
  questions.flatMap((q) =>
    ["fast", "deep"].map((mode) => {
      const row = runs[f.run].rows.find((r: any) => r.q === q.id && r.mode === mode);
      const s = scores[f.run].find((x: any) => x.q === q.id && x.mode === mode);
      const r = row.response;
      const calls = row.calls
        .map(
          (c: any) =>
            `<li><code>${c.kind}</code> ${c.status ?? c.networkError ?? c.refused} · ${sec(c.ms)} · ${c.inputTokens ?? "–"} in / ${c.outputTokens ?? "–"} out${c.reasoningTokens ? ` (${c.reasoningTokens} reasoning)` : ""} · ${c.finishReason ?? "–"}</li>`,
        )
        .join("");
      const evidence = (r.evidence ?? [])
        .map((e: any) => `<li><code>${esc(e.path)}:${e.startLine}–${e.endLine}</code></li>`)
        .join("");
      const body = r.answer
        ? `${prose(r.answer.text)}
<h5>Caveats</h5><ul>${r.answer.caveats.map((c: string) => `<li>${esc(c)}</li>`).join("")}</ul>
${r.suggestedHumanQuestion ? `<h5>Question for the team</h5><p>${esc(r.suggestedHumanQuestion.question)}</p>` : ""}`
        : `<p class="fail">${esc(r.status)} ${esc(r.code ?? "")} ${esc(r.message ?? "")}</p>`;
      return `<details class="answer" id="a-${f.run}-${q.id}-${mode}" data-model="${f.run}" data-mode="${mode}" data-q="${q.id}" data-useful="${s.isUseful}">
<summary><span class="qid">${q.id}</span><span class="mode mode-${mode}">${mode}</span><span class="model">${esc(f.label)}</span><span class="pill ${s.isUseful ? "ok" : "bad"}">${s.isUseful ? "useful" : "not useful"}</span><span class="t">${sec(row.totalMs)}</span><span class="qtext">${esc(q.question)}</span></summary>
<div class="answer-body">
<div class="scorebar">${(["correct", "useful", "clear", "uncertainty", "citations"] as const).map((key) => `<span><b>${s[key]}</b>/2 ${key}</span>`).join("")}<span>outcome <b>${esc(r.answer?.outcome ?? r.status)}</b></span></div>
<p class="note"><strong>Review:</strong> ${esc(s.note)}</p>
<div class="cols"><div class="text">${body}</div>
<aside><h5>Expected (reviewer key)</h5><p class="expected">${esc(q.expected)}</p>
<h5>Timing</h5><p>Total ${sec(row.totalMs)} · model ${sec(row.modelMs)} · retrieval and overhead ${row.nonModelMs} ms</p>
<h5>Model calls</h5><ul class="calls">${calls}</ul>
<h5>Cited ranges (${(r.evidence ?? []).length})</h5><ul class="ev">${evidence}</ul>
${row.citationProblems.length ? `<p class="fail">${esc(row.citationProblems.join("; "))}</p>` : `<p class="okline">All cited ranges exist at 2ac93023.</p>`}
</aside></div></div></details>`;
    }),
  ),
).join("\n");

const uiSteps = ui.steps
  .map(
    (s: any) =>
      `<tr><td>${esc(s.name)}</td><td>${esc(s.status)}/${esc(s.outcome)}</td><td class="num">${sec(s.browserMs)}</td><td class="num">${s.linkCount}</td><td>${s.linksChecked} checked, ${s.linkProblems.length} problems</td><td class="num">${s.proxyCalls.length}</td></tr>`,
  )
  .join("");

const status: [string, string, string][] = [
  [
    "done",
    "Endpoint, API format and model list verified",
    "opencode.ai/docs/go and the public /inference/go/v1/models catalogue; Chat Completions at /inference/go/openai/v1.",
  ],
  [
    "done",
    "paws-app pinned and index verified",
    "2ac93023, 1,775 files, 6,791 chunks, cold build 2.0 s; all 37 model-free pilot checks pass on Looky 1c806ba.",
  ],
  [
    "done",
    "Ten pilot questions, both modes, three models",
    "60 real answers, identical questions, revision and default budgets.",
  ],
  [
    "done",
    "Scored by hand against reviewer keys",
    "Every answer read; key citations checked against the commit.",
  ],
  [
    "done",
    "React UI with real answers",
    "Fast, Deep, rationale question, source links, cancel. Headless Chromium, 127.0.0.1 only.",
  ],
  [
    "done",
    "Reasoning-effort setting added",
    "LOOKY_PROVIDER_<ID>_REASONING_EFFORT, 29 lines incl. test; pmdroid/looky#13.",
  ],
  [
    "blocked",
    "Gemini Flash on OpenCode Go",
    "Not offered by Go. Tested gemini-3.8-flash through OpenRouter instead, with a separate $3 key.",
  ],
  [
    "blocked",
    "Actual Paws coding session through Looky",
    "paws-app main (2038ffd7e) has no Looky adapter. Not substituted with a mock.",
  ],
  [
    "skipped",
    "UI revision switch during a question",
    "The clone has one commit; the deterministic browser tests cover it.",
  ],
  [
    "skipped",
    "OpenCode Go allowance per request",
    "Go returned no opencode.allowance field or header; Go spend is a list-price estimate.",
  ],
  ["skipped", "p95 latency", "Ten questions per cell is too few; medians and ranges only."],
];

const html = `<title>Looky Model Benchmark</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+Condensed:wght@500;600;700&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">
<style>
/* Layout: single reading column for prose, full-width tables in their own scrollers, answers as an archive at the end. */
:root {
  --bg: #f6f7f8; --surface: #ffffff; --ink: #18202a; --muted: #5b6673; --rule: #dde2e7;
  --accent: #1f5f8b; --accent-soft: #e3eef6; --ok: #1d6b45; --ok-soft: #e1f2e8; --bad: #9a3324; --bad-soft: #f8e4e0;
  --warn: #8a5a00; --warn-soft: #fbefd5; --code: #eef1f4;
  --display: "IBM Plex Sans Condensed", "Arial Narrow", sans-serif;
  --body: "IBM Plex Sans", system-ui, sans-serif;
  --mono: "IBM Plex Mono", ui-monospace, monospace;
}
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) {
  --bg: #11161c; --surface: #19212a; --ink: #e4e9ee; --muted: #9aa6b2; --rule: #2c3640;
  --accent: #7fb6dd; --accent-soft: #1d3446; --ok: #7fd1a3; --ok-soft: #173326; --bad: #f09a87; --bad-soft: #3a1f1a;
  --warn: #e9c06a; --warn-soft: #3a2e14; --code: #232d37; color-scheme: dark } }
:root[data-theme="dark"] {
  --bg: #11161c; --surface: #19212a; --ink: #e4e9ee; --muted: #9aa6b2; --rule: #2c3640;
  --accent: #7fb6dd; --accent-soft: #1d3446; --ok: #7fd1a3; --ok-soft: #173326; --bad: #f09a87; --bad-soft: #3a1f1a;
  --warn: #e9c06a; --warn-soft: #3a2e14; --code: #232d37; color-scheme: dark }
body { background: var(--bg); color: var(--ink); font: 15px/1.6 var(--body); }
.wrap { max-width: 1180px; margin: 0 auto; padding-block: 32px 80px; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); display: grid; gap: 40px; }
h1, h2, h3 { font-family: var(--display); text-wrap: balance; line-height: 1.15; margin: 0; }
h1 { font-size: clamp(30px, 4.5vw, 44px); font-weight: 700; }
h2 { font-size: 26px; font-weight: 600; padding-bottom: 8px; border-bottom: 2px solid var(--ink); }
h3 { font-size: 19px; font-weight: 600; }
h5 { font: 600 12px/1.4 var(--body); text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 14px 0 4px; }
p { margin: 0; max-width: 72ch; }
section { display: grid; gap: 16px; min-width: 0; }
code { font: 13px var(--mono); background: var(--code); padding: 1px 4px; border-radius: 3px; overflow-wrap: anywhere; }
pre { font: 12.5px/1.5 var(--mono); background: var(--code); padding: 14px; border-radius: 6px; overflow-x: auto; margin: 0; }
pre code { background: none; padding: 0; }
a { color: var(--accent); }
.meta { color: var(--muted); font: 13px var(--mono); display: flex; flex-wrap: wrap; gap: 6px 18px; }
.lede { font-size: 17px; max-width: 70ch; }
.verdict { background: var(--surface); border: 1px solid var(--rule); border-left: 6px solid var(--accent); padding: 20px 22px; border-radius: 4px; display: grid; gap: 14px; }
.picks { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 14px; }
.pick { display: grid; gap: 4px; }
.pick .k { font: 600 12px var(--body); text-transform: uppercase; letter-spacing: .07em; color: var(--muted); }
.pick .v { font: 600 22px var(--display); }
.pick p { font-size: 14px; color: var(--muted); }
.scroll { overflow-x: auto; background: var(--surface); border: 1px solid var(--rule); border-radius: 4px; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
th, td { padding: 8px 10px; text-align: left; border-bottom: 1px solid var(--rule); vertical-align: top; }
thead th { font: 600 12px var(--body); text-transform: uppercase; letter-spacing: .04em; color: var(--muted); background: var(--bg); white-space: nowrap; }
tbody th { font-weight: 500; }
.num { text-align: right; font-variant-numeric: tabular-nums; font-family: var(--mono); font-size: 13px; white-space: nowrap; }
.model { font-weight: 600; display: block; }
.sub { display: block; font-size: 12px; color: var(--muted); }
.mode { font: 500 11px var(--mono); text-transform: uppercase; padding: 2px 6px; border-radius: 3px; border: 1px solid var(--rule); }
.mode-fast { background: var(--accent-soft); }
.mode-deep { background: var(--code); }
.meter, .pill { font: 600 12px var(--mono); padding: 2px 7px; border-radius: 10px; white-space: nowrap; }
.ok { background: var(--ok-soft); color: var(--ok); }
.bad { background: var(--bad-soft); color: var(--bad); }
.t { font: 12px var(--mono); color: var(--muted); margin-left: 6px; }
.grid td.cell { font-size: 12px; min-width: 96px; }
.grid td.cell a { font-weight: 600; text-decoration: none; display: block; }
.grid td.cell span { font: 11px var(--mono); color: var(--muted); }
.grid td.yes { background: var(--ok-soft); } .grid td.yes a { color: var(--ok); }
.grid td.no { background: var(--bad-soft); } .grid td.no a { color: var(--bad); }
.qid { font: 600 12px var(--mono); color: var(--accent); }
.findings { display: grid; gap: 12px; padding: 0; margin: 0; list-style: none; }
.findings li { background: var(--surface); border: 1px solid var(--rule); border-radius: 4px; padding: 14px 16px; display: grid; gap: 4px; }
.findings b { font-family: var(--display); font-size: 16px; }
.sev { font: 600 11px var(--mono); text-transform: uppercase; letter-spacing: .05em; }
.sev.high { color: var(--bad); } .sev.med { color: var(--warn); } .sev.low { color: var(--muted); }
.status { display: grid; gap: 8px; padding: 0; margin: 0; list-style: none; }
.status li { display: grid; grid-template-columns: 90px 1fr; gap: 12px; align-items: baseline; }
.status .s { font: 600 11px var(--mono); text-transform: uppercase; text-align: center; padding: 2px 0; border-radius: 3px; }
.s.done { background: var(--ok-soft); color: var(--ok); } .s.blocked { background: var(--bad-soft); color: var(--bad); } .s.skipped { background: var(--warn-soft); color: var(--warn); }
.status small { display: block; color: var(--muted); font-size: 13px; }
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
.shots figure { margin: 0; background: var(--surface); border: 1px solid var(--rule); border-radius: 4px; padding: 8px; display: grid; gap: 6px; }
.shots img { max-height: 420px; object-fit: cover; object-position: top; width: 100%; border-radius: 2px; }
.shots figcaption { font-size: 12px; color: var(--muted); }
.filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: end; }
.filters label { display: grid; gap: 2px; font-size: 12px; color: var(--muted); }
.filters select { font: 14px var(--body); padding: 6px 8px; border: 1px solid var(--rule); border-radius: 4px; background: var(--surface); color: var(--ink); }
.answers { display: grid; gap: 8px; }
details.answer { background: var(--surface); border: 1px solid var(--rule); border-radius: 4px; }
details.answer summary { cursor: pointer; padding: 10px 14px; display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
details.answer summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
details.answer .model { display: inline; }
.qtext { flex-basis: 100%; color: var(--muted); font-size: 13px; }
.answer-body { padding: 0 16px 18px; display: grid; gap: 12px; border-top: 1px solid var(--rule); }
.scorebar { display: flex; flex-wrap: wrap; gap: 6px 16px; font-size: 13px; color: var(--muted); padding-top: 12px; }
.scorebar b { color: var(--ink); font-family: var(--mono); }
.note { background: var(--accent-soft); padding: 8px 12px; border-radius: 4px; font-size: 14px; max-width: none; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 340px); gap: 22px; }
.cols .text { display: grid; gap: 10px; min-width: 0; }
.cols .text ul, aside ul { margin: 0; padding-left: 18px; font-size: 14px; }
aside { font-size: 13px; min-width: 0; }
aside p { font-size: 13px; }
.expected { color: var(--muted); }
.calls, .ev { font-size: 12px !important; }
.fail { color: var(--bad); font-weight: 500; }
.okline { color: var(--ok); }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; }
.card { background: var(--surface); border: 1px solid var(--rule); border-radius: 4px; padding: 16px; display: grid; gap: 8px; min-width: 0; }
dl.kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 14px; margin: 0; font-size: 14px; }
dl.kv dt { color: var(--muted); } dl.kv dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 760px) { .cols { grid-template-columns: 1fr; } .status li { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
</style>
<div class="wrap">
<header style="display:grid;gap:12px">
  <h1>Looky Model Benchmark</h1>
  <div class="meta"><span>2026-11-02</span><span>Looky 1c806ba + reasoning-effort patch</span><span>paws-app 2ac93023</span><span>10 pilot questions × Fast and Deep</span></div>
  <p class="lede">Real models answered the ten paws-app pilot questions through Looky's MCP endpoint and its React app. Every answer below is the model's own text, scored by hand against the pilot's reviewer key and checked against the pinned commit.</p>
</header>

<section class="verdict" aria-labelledby="rec">
  <h2 id="rec" style="border:0;padding:0">Recommendation</h2>
  <div class="picks">
    <div class="pick"><span class="k">Fast default</span><span class="v">minimax-m3.1-flash, effort low</span><p>OpenCode Go. 8/10 useful, median 5.1 s, 10 calls with no repairs and no truncation. Cheapest answer per question.</p></div>
    <div class="pick"><span class="k">Deep default</span><span class="v">minimax-m3.1-flash, effort low</span><p>9/10 useful, median 36 s. Ties the others on quality and stays on the Go plan. Looky picks one provider per session, so one model serves both modes today.</p></div>
    <div class="pick"><span class="k">If Deep latency matters</span><span class="v">gemini-3.8-flash, effort low</span><p>OpenRouter. Same 8/10 and 9/10, Deep median 22 s, but about 5× the cost per Deep answer and it labels too many answers "supported".</p></div>
  </div>
  <p>All three full-run models clear the 8/10 bar in Deep. In Fast, MiniMax and Gemini reach 8/10 and GLM 5.3 Flash reaches 6/10. No answer cited a range outside its revision or invented evidence. MiniMax only works with the new <code>REASONING_EFFORT=low</code> setting; without it the model returns empty replies.</p>
</section>

<section aria-labelledby="glance">
  <h2 id="glance">Results at a glance</h2>
  <p>Useful means an engineer could use the answer without rewriting it. Model time is the sum of provider call durations measured at a local proxy; the rest is Looky's retrieval, verification and overhead. Ranges are min–max over ten questions; ten samples are too few for a p95.</p>
  <div class="scroll"><table>
  <thead><tr><th>Model</th><th>Mode</th><th class="num">Useful</th><th class="num">Answered</th><th class="num">Median</th><th class="num">Range</th><th class="num">Model median</th><th class="num">Non-model median</th><th class="num">Calls</th><th class="num">JSON repairs</th><th class="num">Length stops</th><th class="num">Tokens in / out</th><th class="num">Est. cost</th><th class="num">Bad citations</th></tr></thead>
  <tbody>${glance}</tbody></table></div>
</section>

<section aria-labelledby="perq">
  <h2 id="perq">Per question</h2>
  <p>Each cell links to the answer. The score is the sum of five 0–2 ratings: correctness, usefulness, clarity, uncertainty and citations. Hover for the review note.</p>
  <div class="scroll"><table class="grid">
  <thead><tr><th>Question</th>${FULL.map((f) => `<th colspan="2">${esc(f.label)}</th>`).join("")}</tr>
  <tr><th></th>${FULL.map(() => `<th>Fast</th><th>Deep</th>`).join("")}</tr></thead>
  <tbody>${grid}</tbody></table></div>
  <p>q08 (stale documentation) failed for every model in both modes. Deep never retrieved the <code>[queue]</code> and <code>[caps]</code> branches of <code>assignConfig</code> that silently ignore unknown keys, so no model could see that the docs overstate the check. That is a retrieval gap, not a model choice.</p>
</section>

<section aria-labelledby="find">
  <h2 id="find">What the benchmark found in Looky</h2>
  <ul class="findings">
    <li><span class="sev high">High · fixed on branch</span><b>Reasoning models spend the whole output budget before answering</b><p>DeepSeek V4.1 Flash, MiniMax M3.1 Flash and Haiku 5.5 returned empty or truncated replies: reasoning tokens equalled <code>max_tokens</code> (1,500 in Fast, 600 for a Deep plan). Looky had no way to ask for less reasoning. The new optional <code>LOOKY_PROVIDER_&lt;ID&gt;_REASONING_EFFORT</code> sends <code>reasoning_effort</code> on the OpenAI-compatible kind and turns MiniMax from 0/2 to a clean pass.</p></li>
    <li><span class="sev med">Medium</span><b>Fast synthesis leaves no room for its own JSON repair</b><p>Fast gives the synthesis call the whole output budget, so when that reply is truncated the repair call has nothing left (GLM q05, Haiku, Gemini Flash-Lite). Reserving part of the budget, or capping synthesis below it, would let the repair run.</p></li>
    <li><span class="sev med">Medium</span><b>Fast retrieval bounds Fast quality</b><p>Model-free Fast research hits 11 of 29 pinned ranges and Deep 16 of 29. Fast q06 found only docs for every model, and q01 Fast quality varied with how much a model could infer from five ranges.</p></li>
    <li><span class="sev low">Low</span><b>Unparsed citation markers leak into prose</b><p>Markers such as <code>[E1:56,85]</code> and <code>[E2:5,36,79-81]</code>, with comma-separated lines, are neither linked nor removed.</p></li>
    <li><span class="sev low">Low</span><b>Rationale guard fires on questions that ask no "why"</b><p>"The answer described a reason that no cited documentation states" and a generic question for the team appear on q02 and q03, which ask what happens, not why.</p></li>
    <li><span class="sev low">Low</span><b>Caveats are cut at 400 characters mid-sentence; backticks show raw in the UI</b><p>One GLM caveat ends in "looks counterintuitive; the". Caveat text renders <code>\`code\`</code> literally in the React app.</p></li>
    <li><span class="sev low">Low</span><b>One provider serves both modes</b><p>A session selects one provider policy, so Fast and Deep cannot use different models without two configured providers and client-side routing.</p></li>
  </ul>
</section>

<section aria-labelledby="smoke">
  <h2 id="smoke">Smoke test: q01, Fast and Deep</h2>
  <p>Fifteen configurations were tried on q01 before choosing three for the full run. "Default" sends no reasoning setting; "low" uses the new effort setting.</p>
  <div class="scroll"><table>
  <thead><tr><th>Model</th><th>Provider</th><th>Effort</th><th>Fast</th><th>Deep</th><th>What happened</th></tr></thead>
  <tbody>${smoke}</tbody></table></div>
</section>

<section aria-labelledby="ui">
  <h2 id="ui">React app with real answers</h2>
  <p>The built app was served on 127.0.0.1 with local auth and driven in headless Chromium against MiniMax M3.1 Flash at low effort. The page pinned <code>${esc(ui.pinned)}</code> (equal to the clone's HEAD) and reported the index ready after ${sec(ui.indexReadyMs)}. For each answer the first three source links were checked to name the pinned SHA and lines that exist in the file. A Deep question cancelled after 3 s showed "Cancelled", and no answer appeared in the next 15 s. No page errors or dialogs occurred.</p>
  <div class="scroll"><table>
  <thead><tr><th>Step</th><th>Result</th><th class="num">In browser</th><th class="num">Links</th><th>Link check</th><th class="num">Model calls</th></tr></thead>
  <tbody>${uiSteps}<tr><td>cancel-deep-q04</td><td>cancelled, no answer shown</td><td class="num">–</td><td class="num">–</td><td>–</td><td class="num">${ui.cancel.proxyCalls}</td></tr></tbody></table></div>
  <div class="shots">
    <figure><img src="${png("fast-q01.png")}" alt="Fast answer to q01 in the Looky app"><figcaption>Fast answer, q01</figcaption></figure>
    <figure><img src="${png("deep-q01.png")}" alt="Deep answer to q01 in the Looky app"><figcaption>Deep answer, q01</figcaption></figure>
    <figure><img src="${png("fast-q09-rationale.png")}" alt="Rationale question answered as partly established with a question for the team"><figcaption>Rationale question: "The code does not say why"</figcaption></figure>
    <figure><img src="${png("cancelled.png")}" alt="Cancelled Deep question"><figcaption>Cancelled Deep question</figcaption></figure>
  </div>
</section>

<section aria-labelledby="val">
  <h2 id="val">Validation status</h2>
  <ul class="status">${status.map(([s, t, d]) => `<li><span class="s ${s}">${s}</span><span>${esc(t)}<small>${esc(d)}</small></span></li>`).join("")}</ul>
</section>

<section aria-labelledby="setup">
  <h2 id="setup">Setup and reproduction</h2>
  <div class="two">
    <div class="card"><h3>Revision and index</h3><dl class="kv">
      <dt>Looky</dt><dd><code>1c806ba</code> in a clean worktree, plus the reasoning-effort patch below</dd>
      <dt>Codebase</dt><dd>pmdroid/paws-app at <code>2ac93023d31bab6f0ef26690a7e6e8e8d2540bff</code></dd>
      <dt>Index</dt><dd>1,775 files indexed, 18 excluded, 6,791 chunks, cold build 2.0 s</dd>
      <dt>Budgets</dt><dd>Looky defaults for both modes (Fast 2 calls, 1,500 output tokens, 30 s; Deep 10 calls, 8,000 output tokens, 180 s)</dd>
      <dt>Retrieval</dt><dd>Model-free pinned-range hits:<table style="width:auto;margin-top:4px"><tbody>${baselineRows}</tbody></table></dd>
    </dl></div>
    <div class="card"><h3>Providers</h3><dl class="kv">
      <dt>OpenCode Go</dt><dd><code>https://opencode.ai/inference/go/openai/v1/chat/completions</code>, Looky kind <code>openai</code>, key from <code>LOOKY_OPENCODE_APIKEY</code></dd>
      <dt>OpenRouter</dt><dd><code>https://openrouter.ai/api/v1/chat/completions</code>, temporary $3 key supplied for this run</dd>
      <dt>Proxy</dt><dd>One local proxy per provider on 127.0.0.1 holds the key, enforces a spend and request cap, and logs call metadata only (no prompts, no replies)</dd>
      <dt>Isolation</dt><dd>Separate data directories, no <code>.env.local</code> in the worktree, no production config touched</dd>
    </dl></div>
  </div>
  <h3>Commands</h3>
<pre><code>git worktree add --detach $W 1c806ba &amp;&amp; git -C $W apply reasoning-effort.patch
(cd $W &amp;&amp; bun install --frozen-lockfile &amp;&amp; bun run web:build)
bun run $W/pilot/run.ts --source ~/work/paws-app --work $T/pilot0/work --out $T/pilot0/results
git clone ~/work/paws-app $B/paws-app &amp;&amp; git -C $B/paws-app checkout --detach 2ac93023d31bab6f0ef26690a7e6e8e8d2540bff

bun run scripts/proxy.ts --envFile ~/work/looky/.env.local --log calls.jsonl --port 7399 --capUsd 3 --capRequests 500
OPENROUTER_BENCH_KEY=… bun run scripts/proxy.ts --keyEnv OPENROUTER_BENCH_KEY \\
  --upstream https://openrouter.ai/api/v1/chat/completions --catalogue https://openrouter.ai/api/v1/models \\
  --log calls-openrouter.jsonl --port 7400 --capUsd 2.8 --capRequests 400

bun run scripts/bench.ts --looky $W --model minimax-m3.1-flash --effort low --run full-minimax-m3.1-flash-low \\
  --repo $B/paws-app --data $B/data --proxy http://127.0.0.1:7399 --proxyLog calls.jsonl --out runs
bun run scripts/bench.ts --looky $W --model google/gemini-3.8-flash --effort low --run full-or-gemini-3.8-flash-low \\
  --repo $B/paws-app --data $B/data-or --proxy http://127.0.0.1:7400 --proxyLog calls-openrouter.jsonl --out runs
bun run scripts/bench.ts --looky $W --model glm-5.3-flash --run full-glm-5.3-flash \\
  --repo $B/paws-app --data $B/data --proxy http://127.0.0.1:7399 --proxyLog calls.jsonl --out runs
bun run scripts/ui.ts --looky $W --model minimax-m3.1-flash --effort low --repo $B/paws-app --data $B/data-ui \\
  --proxyLog calls.jsonl --out ui
bun run scripts/aggregate.ts &amp;&amp; bun run scripts/report.ts</code></pre>
  <h3>Reasoning-effort patch</h3>
  <pre><code>${esc(patch)}</code></pre>
</section>

<section aria-labelledby="spend">
  <h2 id="spend">Spend</h2>
  <div class="two">
    <div class="card"><h3>OpenCode Go</h3><p>${spend.opencodeGo.requests} requests including probes and the UI run. Estimated <strong>${usd(spend.opencodeGo.estUsd)}</strong> at catalogue list prices, with DeepSeek's peak-hour multiplier applied. Go did not report <code>opencode.allowance</code> on any response, so the plan allowance used is not measured. Hard cap $3.00 / 500 requests was never reached.</p></div>
    <div class="card"><h3>OpenRouter</h3><p>${spend.openRouter.requests} requests. <strong>${usd(spend.openRouter.usd)}</strong> from the cost OpenRouter reports per response; the key's own usage counter read $0.62 of its $3.00 limit afterwards. Proxy cap $2.80 was never reached.</p></div>
  </div>
</section>

<section aria-labelledby="all">
  <h2 id="all">Every answer</h2>
  <div class="filters">
    <label for="f-model">Model<select id="f-model"><option value="">All</option>${FULL.map((f) => `<option value="${f.run}">${esc(f.label)}</option>`).join("")}</select></label>
    <label for="f-mode">Mode<select id="f-mode"><option value="">Both</option><option>fast</option><option>deep</option></select></label>
    <label for="f-q">Question<select id="f-q"><option value="">All</option>${questions.map((q) => `<option>${q.id}</option>`).join("")}</select></label>
    <label for="f-u">Verdict<select id="f-u"><option value="">Any</option><option value="true">Useful</option><option value="false">Not useful</option></select></label>
  </div>
  <div class="answers">${answers}</div>
</section>
</div>
<script>
const sel = ["f-model", "f-mode", "f-q", "f-u"].map((id) => document.getElementById(id));
function apply() {
  const [m, mo, q, u] = sel.map((s) => s.value);
  document.querySelectorAll("details.answer").forEach((d) => {
    d.hidden = (m && d.dataset.model !== m) || (mo && d.dataset.mode !== mo) || (q && d.dataset.q !== q) || (u && d.dataset.useful !== u);
  });
}
sel.forEach((s) => s.addEventListener("change", apply));
function openHash() {
  const el = location.hash && document.getElementById(location.hash.slice(1));
  if (el && el.tagName === "DETAILS") { el.hidden = false; el.open = true; el.scrollIntoView(); }
}
window.addEventListener("hashchange", openHash);
openHash();
</script>
`;
writeFileSync(join(R, "report.html"), html);
console.log(`wrote report.html (${(html.length / 1024).toFixed(0)} KB)`);
