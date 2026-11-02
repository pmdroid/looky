import { readFileSync } from "node:fs";

const [runPath, questionsPath, repo] = process.argv.slice(2);
const run = JSON.parse(readFileSync(runPath!, "utf8"));
const questions = new Map<string, any>(
  JSON.parse(readFileSync(questionsPath!, "utf8")).questions.map((q: any) => [q.id, q]),
);

function lines(path: string, start: number, end: number): string {
  const r = Bun.spawnSync(["git", "-C", repo!, "cat-file", "blob", `${run.sha}:${path}`]);
  if (r.exitCode !== 0) return "(missing)";
  return r.stdout
    .toString()
    .split("\n")
    .slice(start - 1, end)
    .map((l, i) => `${start + i}: ${l}`)
    .join("\n");
}

for (const row of run.rows) {
  const q = questions.get(row.q);
  const r = row.response;
  console.log(`\n==================== ${run.model} ${row.q} ${row.mode} ====================`);
  console.log(`Q: ${q.question}`);
  console.log(`EXPECTED: ${q.expected}`);
  console.log(
    `PINS: ${q.evidence.map((e: any) => `${e.path}:${e.startLine}-${e.endLine}`).join(", ")}`,
  );
  console.log(
    `STATUS: ${r.status}${r.answer ? `/${r.answer.outcome}` : ""} ${r.code ?? ""} ${r.message ?? ""} total=${row.totalMs} model=${row.modelMs} calls=${row.calls.map((c: any) => c.kind).join(",")} problems=${row.citationProblems.join(";")}`,
  );
  if (!r.answer) continue;
  console.log(`--- ANSWER ---\n${r.answer.text}`);
  console.log(`--- CAVEATS ---\n${r.answer.caveats.join("\n")}`);
  if (r.suggestedHumanQuestion) console.log(`HUMAN Q: ${JSON.stringify(r.suggestedHumanQuestion)}`);
  console.log(`--- EVIDENCE ---`);
  for (const ref of r.evidence) {
    console.log(`# ${ref.path}:${ref.startLine}-${ref.endLine}`);
    console.log(lines(ref.path, ref.startLine, Math.min(ref.endLine, ref.startLine + 24)));
  }
}
