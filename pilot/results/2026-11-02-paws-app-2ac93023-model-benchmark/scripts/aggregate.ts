import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..");
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
};

const runs = readdirSync(join(dir, "runs"))
  .filter((f) => f.endsWith(".json"))
  .map((f) => JSON.parse(readFileSync(join(dir, "runs", f), "utf8")));

const summary = runs.map((run) => {
  const scores = (() => {
    try {
      return JSON.parse(readFileSync(join(dir, "scores", `${run.run}.json`), "utf8")).scores;
    } catch {
      return null;
    }
  })();
  const modes = ["fast", "deep"].map((mode) => {
    const rows = run.rows.filter((r: any) => r.mode === mode);
    const calls = rows.flatMap((r: any) => r.calls);
    const ok = calls.filter((c: any) => c.status === 200);
    const answered = rows.filter((r: any) => r.response.status === "answered");
    const s = scores?.filter((x: any) => x.mode === mode) ?? [];
    return {
      mode,
      questions: rows.length,
      answered: answered.length,
      outcomes: Object.fromEntries(
        ["supported", "partial", "conflicting", "unknown"].map((o) => [
          o,
          answered.filter((r: any) => r.response.answer.outcome === o).length,
        ]),
      ),
      failures: rows
        .filter((r: any) => r.response.status !== "answered")
        .map(
          (r: any) => `${r.q}: ${r.response.status}${r.response.code ? ` ${r.response.code}` : ""}`,
        ),
      useful: scores ? s.filter((x: any) => x.isUseful).length : null,
      scoreSums: scores
        ? Object.fromEntries(
            ["correct", "useful", "clear", "uncertainty", "citations"].map((k) => [
              k,
              s.reduce((a: number, x: any) => a + x[k], 0),
            ]),
          )
        : null,
      medianTotalMs: median(rows.map((r: any) => r.totalMs)),
      maxTotalMs: Math.max(...rows.map((r: any) => r.totalMs)),
      minTotalMs: Math.min(...rows.map((r: any) => r.totalMs)),
      medianModelMs: median(rows.map((r: any) => r.modelMs)),
      medianNonModelMs: median(rows.map((r: any) => r.nonModelMs)),
      medianSourceReads: median(answered.map((r: any) => r.response.usage.sourceReads)),
      modelCalls: calls.length,
      callsByKind: calls.reduce((a: any, c: any) => ((a[c.kind] = (a[c.kind] ?? 0) + 1), a), {}),
      repairCalls: calls.filter((c: any) => c.kind === "repair").length,
      lengthStops: ok.filter((c: any) => c.finishReason === "length").length,
      callErrors: calls.filter((c: any) => c.status !== 200).length,
      inputTokens: ok.reduce((a: number, c: any) => a + (c.inputTokens ?? 0), 0),
      outputTokens: ok.reduce((a: number, c: any) => a + (c.outputTokens ?? 0), 0),
      reasoningTokens: ok.reduce((a: number, c: any) => a + (c.reasoningTokens ?? 0), 0),
      estUsd: Number(calls.reduce((a: number, c: any) => a + (c.estUsd ?? 0), 0).toFixed(4)),
      citationProblems: rows.reduce((a: number, r: any) => a + r.citationProblems.length, 0),
    };
  });
  return {
    run: run.run,
    model: run.model,
    effort: run.effort ?? null,
    provider: (run.proxy ?? "http://127.0.0.1:7399").endsWith("7400")
      ? "OpenRouter"
      : "OpenCode Go",
    generationId: run.generationId,
    questions: [...new Set(run.rows.map((r: any) => r.q))],
    modes,
  };
});

const logs = ["calls-opencode-go.jsonl", "calls-openrouter.jsonl"].map((f) =>
  readFileSync(join(dir, f), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l)),
);
const spend = {
  opencodeGo: {
    requests: logs[0]!.length,
    estUsd: Number(logs[0]!.reduce((a, c) => a + (c.estUsd ?? 0), 0).toFixed(4)),
  },
  openRouter: {
    requests: logs[1]!.length,
    usd: Number(logs[1]!.reduce((a, c) => a + (c.estUsd ?? 0), 0).toFixed(4)),
  },
  allowanceReported: logs[0]!.some((c) => c.allowance != null),
};
writeFileSync(join(dir, "summary.json"), JSON.stringify({ summary, spend }, null, 2));
for (const s of summary) {
  for (const m of s.modes) {
    console.log(
      [
        s.run.padEnd(42),
        m.mode,
        `ans ${m.answered}/${m.questions}`,
        `useful ${m.useful ?? "-"}`,
        `med ${m.medianTotalMs}`,
        `max ${m.maxTotalMs}`,
        `model ${m.medianModelMs}`,
        `nonmodel ${m.medianNonModelMs}`,
        `calls ${m.modelCalls}`,
        `rep ${m.repairCalls}`,
        `len ${m.lengthStops}`,
        `in ${m.inputTokens}`,
        `out ${m.outputTokens}`,
        `$${m.estUsd}`,
      ].join(" | "),
    );
  }
}
console.log(JSON.stringify(spend));
