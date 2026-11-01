/**
 * Temporary Git repositories for browser tests, built on the core pilot
 * fixture (`test/support/pilot-fixture.ts`) instead of a separate corpus.
 *
 * - `pilot`: the pilot's recovery, checkpoint, retry and billing code, a
 *   Unicode design note, and optionally a filler corpus so the first index
 *   build lasts long enough to be watched from the page.
 * - `notes`: a second small repository the browser may also use.
 * - `vault`: configured on the service but not for the browser client.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { commitAll, git, initRepo, write } from "../../test/support/git-fixture";
import { buildPilotRepo } from "../../test/support/pilot-fixture";

export const UNICODE_DOC = "docs/überblick.md";

export const UNICODE_DOC_TEXT = `# Überblick der Wiederherstellung

Die Wiederherstellung lädt den neuesten Checkpoint und spielt den Lauf erneut ab.
日本語: 復旧は最新のチェックポイントから再開します。
العربية: تبدأ الاستعادة من آخر نقطة حفظ.
`;

export interface Repos {
  readonly root: string;
  readonly pilot: string;
  readonly notes: string;
  readonly vault: string;
  /** `main` of pilot. */
  readonly pilotSha: string;
  /** `feature` of pilot, one commit after `main`. */
  readonly featureSha: string;
  readonly notesSha: string;
}

/** `files` filler modules of `lines` lines each, with words no question uses. */
function writeCorpus(repo: string, files: number, lines: number): void {
  const directory = join(repo, "corpus");
  mkdirSync(directory, { recursive: true });
  for (let file = 0; file < files; file += 1) {
    const body: string[] = [];
    for (let line = 0; line < lines; line += 1) {
      body.push(`export const ledger${file}x${line} = ${line}; // tally quill ${file} ${line}`);
    }
    writeFileSync(join(directory, `ledger-${file}.ts`), `${body.join("\n")}\n`);
  }
}

export function createRepos(root: string, options: { readonly corpusFiles?: number } = {}): Repos {
  const pilot = join(root, "repos", "pilot");
  const notes = join(root, "repos", "notes");
  const vault = join(root, "repos", "vault");
  for (const directory of [pilot, notes, vault]) mkdirSync(directory, { recursive: true });

  buildPilotRepo(pilot);
  write(pilot, UNICODE_DOC, UNICODE_DOC_TEXT);
  if (options.corpusFiles) writeCorpus(pilot, options.corpusFiles, 40);
  const pilotSha = commitAll(pilot, "pilot with notes");
  git(pilot, "tag", "v1");
  git(pilot, "checkout", "--quiet", "-b", "feature");
  write(
    pilot,
    "src/recovery/backoff.ts",
    `import { RETRY_POLICY } from "../config/retry";

/** Delay before the next replay attempt. */
export function replayBackoffMs(attempt: number): number {
  return RETRY_POLICY.backoffMs * 2 ** attempt;
}
`,
  );
  const featureSha = commitAll(pilot, "add replay backoff");
  git(pilot, "checkout", "--quiet", "main");

  initRepo(notes);
  write(
    notes,
    "src/notebook.ts",
    `/** Saves a note under its title, replacing an older note with that title. */
export function saveNote(store: Map<string, string>, title: string, body: string): void {
  store.set(title.trim(), body);
}
`,
  );
  write(notes, "README.md", "# Notes\n\nA tiny notebook used by browser tests.\n");
  const notesSha = commitAll(notes, "notes");

  initRepo(vault);
  write(vault, "src/vault.ts", "export const vaultName = 'internal-only';\n");
  commitAll(vault, "vault");

  return { root, pilot, notes, vault, pilotSha, featureSha, notesSha };
}
