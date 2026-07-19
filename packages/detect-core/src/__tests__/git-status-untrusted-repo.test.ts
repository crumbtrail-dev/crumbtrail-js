// Regression test for repo-local command execution during git status.
//
// `git status` (and `git ls-files -m`, and anything else that compares the
// working tree to the index) hashes the working-tree file, and hashing runs it
// through its clean filter. The filter command is read from the repository's
// own .git/config and selected by a .gitattributes that need not even be
// committed. Inspecting a hostile repository therefore used to hand it
// arbitrary command execution.
//
// These tests plant exactly that trap and assert we never spring it, while
// still returning the same answers the porcelain implementation returned.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultInjectIO } from "../inject/io";

let repo: string;

function run(args: string[]): void {
  execFileSync("git", args, {
    cwd: repo,
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
}

const CANARY = () => join(repo, "PWNED");
const target = () => join(repo, "target.txt");

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "ct-git-untrusted-"));
  run(["init", "-q", "."]);
  writeFileSync(target(), "hello\n");
  run(["add", "target.txt"]);
  run(["commit", "-qm", "init"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** Arm the repository with a clean filter that touches a canary file. */
function armFilterTrap(): void {
  run([
    "config",
    "filter.evil.clean",
    `sh -c 'touch ${JSON.stringify(CANARY())}; cat'`,
  ]);
  // Uncommitted on purpose: the attack does not require committing anything.
  writeFileSync(join(repo, ".gitattributes"), "target.txt filter=evil\n");
}

describe("gitStatus against an untrusted repository", () => {
  it("does not execute a repo-local clean filter", () => {
    armFilterTrap();
    // Skew the mtime so git cannot shortcut via cached stat data. This is what
    // makes the filter fire in practice, and it is the normal state after a
    // tarball unpack, cache restore, or volume mount.
    execFileSync("touch", ["-t", "203001010000", target()]);

    defaultInjectIO.gitStatus(repo, target());

    expect(existsSync(CANARY())).toBe(false);
  });

  it("does not execute the filter when the file is genuinely modified", () => {
    armFilterTrap();
    writeFileSync(target(), "hello\nCHANGED\n");

    const status = defaultInjectIO.gitStatus(repo, target());

    expect(existsSync(CANARY())).toBe(false);
    expect(status.dirty).toBe(true);
  });
});

// The answers below must match what `git status --porcelain` produced before,
// or recipes silently change which branch they take.
describe("gitStatus answers match the previous porcelain behaviour", () => {
  it("reports a committed, unmodified file as tracked and clean", () => {
    expect(defaultInjectIO.gitStatus(repo, target())).toEqual({
      isRepo: true,
      tracked: true,
      dirty: false,
    });
  });

  it("reports a modified tracked file as dirty", () => {
    writeFileSync(target(), "hello\nmore\n");
    expect(defaultInjectIO.gitStatus(repo, target())).toEqual({
      isRepo: true,
      tracked: true,
      dirty: true,
    });
  });

  it("reports an untracked existing file as untracked and dirty", () => {
    const untracked = join(repo, "new.txt");
    writeFileSync(untracked, "x\n");
    expect(defaultInjectIO.gitStatus(repo, untracked)).toEqual({
      isRepo: true,
      tracked: false,
      dirty: true,
    });
  });

  it("treats a path that does not exist yet as clean so a create needs no confirmation", () => {
    expect(defaultInjectIO.gitStatus(repo, join(repo, "nope.ts"))).toEqual({
      isRepo: true,
      tracked: true,
      dirty: false,
    });
  });

  it("reports a tracked file deleted from the working tree as dirty", () => {
    rmSync(target());
    expect(defaultInjectIO.gitStatus(repo, target())).toEqual({
      isRepo: true,
      tracked: true,
      dirty: true,
    });
  });

  it("reports isRepo false outside a work tree", () => {
    const plain = mkdtempSync(join(tmpdir(), "ct-not-a-repo-"));
    try {
      expect(defaultInjectIO.gitStatus(plain, join(plain, "a.txt"))).toEqual({
        isRepo: false,
        tracked: false,
        dirty: false,
      });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});
