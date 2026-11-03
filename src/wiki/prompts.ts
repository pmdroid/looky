/**
 * Prompts for writing one generated wiki page. Repository text is untrusted
 * evidence, fenced and neutralized exactly as for answers; the page plan and
 * neighbouring page titles come from Looky's own planner but are still fenced,
 * because titles and paths derive from repository names.
 */
import { fenceSafe, type PackedEvidence, UNTRUSTED } from "../answer/prompts";
import type { EvidenceBundle } from "../retrieval/research";
import type { WikiPageKind } from "./model";

/** Bump when a prompt change can change generated pages. Part of the writer fingerprint. */
export const WIKI_PROMPT_VERSION = 3;

export const WIKI_SYSTEM_MARKER = "You are Looky, writing one page of a generated code wiki";

const SCOPE: Record<WikiPageKind, string> = {
  overview:
    "the whole repository: what it is for, its main parts and how a request or job moves through them",
  architecture:
    "how the major modules fit together: boundaries, dependencies, data and control flow",
  section: "a group of pages: what the group covers and how its members relate",
  module:
    "one module: its responsibilities, the few types and functions a reader needs, how it is used and tested",
  workflow:
    "one flow across modules: where it starts, each step in order, failure paths and where it ends",
};

export interface WikiNeighbour {
  readonly slug: string;
  readonly title: string;
  readonly relation: "parent" | "child" | "uses" | "related";
}

export function wikiSystemPrompt(kind: WikiPageKind, maxChars: number): string {
  return `${WIKI_SYSTEM_MARKER} for a codebase. Explain the system the way one
engineer explains it to another, using only the evidence you are given from one exact commit.
This page covers ${SCOPE[kind]}.

${UNTRUSTED}

What to write:
- Write for an engineer who is new to this codebase. Say in plain words what a part does
  and why it matters before naming any code.
- A short summary of what this part is responsible for.
- Sections that explain responsibilities, key mechanisms, relationships to other parts,
  workflows in order, error handling and relevant caveats. Choose headings that name the
  concept, not the file; do not force a template, and skip anything the evidence does not show.
- Open every section with one or two plain sentences that say what it is about. Then use
  the form that fits the content:
  - paragraphs to explain behaviour and how the pieces work together;
  - a numbered list for steps that happen in order;
  - a short bulleted list for the few functions or settings a reader needs, one name per
    item followed by what it does;
  - a table for settings, states, limits or constants and their values.
  Cover what matters and leave out the rest; do not list everything the evidence contains.
- Be concrete: give the defaults, limits, timeouts, commands, file locations and other values
  the evidence shows, rather than saying that something is configurable.
- Put a function, type, file or setting in backticks only when a reader needs the name to
  find the code or change a setting: at most about two names per paragraph, and
  one name per item in lists and tables. Do not put ordinary words in backticks.
  No code blocks.
- Stay under about ${maxChars} characters in total.

Citations:
- Put one citation group at the end of each paragraph, list item or table row, covering
  what it relies on: [E3] for a whole evidence block, [E3:14-18] for lines inside it, or
  [E3:14-18; E5] for several. Do not cite after every sentence. Every section needs at
  least one, and so does the summary. A summary without a citation group is dropped.
- Use only ids and line numbers that appear in the evidence. Never invent paths, lines,
  symbols or URLs, and do not write web links; they are removed.
- You may link to a neighbouring wiki page with [[slug]], using only the slugs listed for
  this page. Other links are removed.

Observed versus inferred:
- "basis": "observed" for a section that states what the cited code does.
- "basis": "inferred" for a section that draws a conclusion the code does not state
  directly, such as how pieces are probably meant to be combined. Say it is an inference.
- Never present design intent, history or business rationale as fact. Put every statement
  about why something exists or was built a certain way in "intent". Use
  "basis": "documented" only when you cite documentation that states the reason;
  otherwise use "basis": "unknown" and phrase it as an open question.
- When a document in the evidence explains why, cite it in the statement and use
  "basis": "documented".
- Caveats are limits of the code itself, such as a case it does not handle, each with a
  citation; not what the evidence did or did not show.

Reply with one JSON object and nothing else:
{
  "summary": "two to four plain sentences, with one citation group at the end",
  "sections": [
    { "heading": "short heading", "basis": "observed" | "inferred",
      "body": "Markdown paragraphs, each ending with a citation group" }
  ],
  "intent": [
    { "statement": "the reason or the open question", "basis": "documented" | "unknown" }
  ],
  "caveats": ["a limit of the code, with a citation group"]
}`;
}

export function wikiPagePrompt(input: {
  readonly title: string;
  readonly kind: WikiPageKind;
  readonly description: string;
  readonly scopePath: string | null;
  readonly sha: string;
  readonly neighbours: readonly WikiNeighbour[];
  readonly bundle: EvidenceBundle;
  readonly packed: PackedEvidence;
}): string {
  const files = new Set(input.bundle.evidence.map((item) => item.path)).size;
  const neighbours =
    input.neighbours.length > 0
      ? input.neighbours
          .map((n) => `- [[${n.slug}]] ${fenceSafe(n.title)} (${n.relation})`)
          .join("\n")
      : "- none";
  const notes = [
    ...input.bundle.gaps.map((gap) => `- Gap: ${fenceSafe(gap)}`),
    ...(input.bundle.stop.reason !== "complete"
      ? ["- Research stopped at a limit; some planned source was not inspected."]
      : []),
  ];
  return `<page>
Title: ${fenceSafe(input.title)}
Kind: ${input.kind}
Plan note: ${fenceSafe(input.description)}${input.scopePath ? `\nDirectory: ${fenceSafe(input.scopePath)}` : ""}
</page>

Neighbouring pages you may link to:
${neighbours}

Commit ${input.sha}. Research inspected ${input.bundle.evidence.length} source ranges in ${files} files planned for this page; nothing else in the repository was read.

Research notes:
${notes.length > 0 ? notes.join("\n") : "- none"}

${input.packed.text}

${input.packed.omitted.length > 0 ? `${input.packed.omitted.length} further inspected ranges did not fit the input budget and are not shown.\n\n` : ""}Write the page from this evidence only.`;
}
