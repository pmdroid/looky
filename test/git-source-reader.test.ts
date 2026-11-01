import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetExhaustedError } from "../src/ask/session";
import { LookyUnavailableError } from "../src/contract/ports";
import { GitSourceReader, SourceRangeError } from "../src/source/git-source-reader";

function git(directory: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Looky Test",
      GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Looky Test",
      GIT_COMMITTER_EMAIL: "test@example.invalid",
    },
  });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

describe("GitSourceReader", () => {
  let repo: string;
  let firstSha: string;
  const signal = new AbortController().signal;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "looky-git-"));
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "commit.gpgsign", "false");
    writeFileSync(join(repo, "a.ts"), "one\ntwo\nthree\n");
    git(repo, "add", "a.ts");
    git(repo, "commit", "--quiet", "-m", "first");
    firstSha = git(repo, "rev-parse", "HEAD");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  function reader() {
    return new GitSourceReader((id) => (id === "repo" ? repo : undefined));
  }

  function read(path: string, startLine: number, endLine: number, maxBytes = 1024, sha = firstSha) {
    return reader().read({ repositoryId: "repo", sha, path, startLine, endLine, maxBytes }, signal);
  }

  test("reads the pinned commit even after the branch moves and the worktree is dirty", async () => {
    writeFileSync(join(repo, "a.ts"), "ONE\nTWO\nTHREE\nFOUR\n");
    git(repo, "commit", "--quiet", "-am", "second");
    writeFileSync(join(repo, "a.ts"), "dirty worktree\n");
    writeFileSync(join(repo, "untracked.ts"), "never committed\n");

    expect(await read("a.ts", 2, 3)).toEqual({
      path: "a.ts",
      startLine: 2,
      endLine: 3,
      text: "two\nthree\n",
    });
    await expect(read("untracked.ts", 1, 1)).rejects.toBeInstanceOf(SourceRangeError);
  });

  test("clamps to end of file and to the byte allowance at whole lines", async () => {
    expect(await read("a.ts", 2, 99)).toMatchObject({ endLine: 3, text: "two\nthree\n" });
    expect(await read("a.ts", 1, 3, 8)).toMatchObject({ endLine: 2, text: "one\ntwo\n" });
    await expect(read("a.ts", 1, 3, 2)).rejects.toBeInstanceOf(BudgetExhaustedError);
    await expect(read("a.ts", 9, 9)).rejects.toBeInstanceOf(SourceRangeError);
  });

  test("refuses unknown repositories and non-SHA revisions", async () => {
    await expect(
      reader().read(
        {
          repositoryId: "other",
          sha: firstSha,
          path: "a.ts",
          startLine: 1,
          endLine: 1,
          maxBytes: 10,
        },
        signal,
      ),
    ).rejects.toBeInstanceOf(LookyUnavailableError);
    await expect(read("a.ts", 1, 1, 10, "main")).rejects.toBeInstanceOf(SourceRangeError);
  });
});
