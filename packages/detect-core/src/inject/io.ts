// The read-only I/O boundary the plan-builders depend on. Splitting it out lets
// the bulk of the recipe tests run against an in-memory fake with zero disk I/O,
// while the golden-file / fixture tests use the real filesystem + git.
//
// NOTE: this module intentionally uses only node:fs, node:path and node:child_process
// (git). No HTTP client and no network egress of any kind — networking is CP4's job.

import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

export interface GitTargetStatus {
  /** false when `cwd` is not inside a git work tree. */
  isRepo: boolean;
  /** false for an untracked (never-committed) file. */
  tracked: boolean;
  /** true when the target has uncommitted changes or is untracked. */
  dirty: boolean;
}

/** Read-only inspection surface consumed by the injection plan-builders. */
export interface InjectIO {
  exists(p: string): boolean;
  /** File contents, or null when it does not exist / cannot be read. */
  readFile(p: string): string | null;
  /** git porcelain status for a single target path. */
  gitStatus(cwd: string, target: string): GitTargetStatus;
}

// Ask about the repo at `cwd`, never the one a surrounding git hook points at:
// hooks export GIT_DIR / GIT_INDEX_FILE / GIT_WORK_TREE for THEIR repo, and
// inheriting them makes this query answer for the wrong tree (e.g. wizard run
// from husky, or the test suite under pre-push). GIT_CONFIG_GLOBAL/SYSTEM are
// neutralised so a developer's machine config cannot change the answer either.
function gitEnv(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_SYSTEM = "/dev/null";
  return env;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: gitEnv(),
  });
}

/** git's blob object id for a byte buffer: sha1("blob <len>\0" + bytes). */
function blobSha(bytes: Buffer): string {
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

// SECURITY: this deliberately does NOT run `git status`, `git ls-files -m`, or
// any other command that compares the working tree against the index.
//
// Deciding "is this file modified" forces git to hash the working-tree file,
// and hashing runs the file through its clean filter. The filter's command is
// resolved from the *repository's own* .git/config and selected by an
// uncommitted .gitattributes, so on a hostile repository that is arbitrary
// command execution. `-c core.fsmonitor=false` does not cover it (different
// config key) and GIT_CONFIG_GLOBAL/SYSTEM do not either (repo-local config is
// neither global nor system). Git exposes no switch to disable filters wholesale.
//
// So we read the index only — `ls-files -s` never touches the working tree —
// and do the content comparison ourselves in-process.
//
// Known conservative inaccuracy: in a repository that legitimately uses clean
// filters (Git LFS) or autocrlf, the index holds the SHA of the *converted*
// bytes, so our raw-bytes SHA differs and we report dirty for a file that is
// actually clean. That direction is safe: dirty only ever adds a confirmation
// prompt before we touch the file. The reverse error would silently overwrite
// uncommitted work.
function realGitStatus(cwd: string, target: string): GitTargetStatus {
  let indexEntry: string;
  try {
    git(cwd, ["rev-parse", "--is-inside-work-tree"]);
    indexEntry = git(cwd, ["ls-files", "-s", "--", target]);
  } catch {
    // git missing, or not a work tree.
    return { isRepo: false, tracked: false, dirty: false };
  }

  const path = resolve(cwd, target);
  const onDisk = existsSync(path);
  const line = indexEntry.split("\n").find((l) => l.trim().length > 0);

  if (!line) {
    // Not in the index. Matches the previous porcelain behaviour: an existing
    // file is untracked ("??" => tracked false, dirty true), while a path that
    // does not exist yet produced no status line at all and was treated as
    // clean so a fresh create needs no confirmation.
    return onDisk
      ? { isRepo: true, tracked: false, dirty: true }
      : { isRepo: true, tracked: true, dirty: false };
  }

  // "<mode> <sha> <stage>\t<path>"
  const staged = line.split(/\s+/)[1] ?? "";
  if (!onDisk) {
    // Tracked but deleted from the working tree: porcelain reported " D".
    return { isRepo: true, tracked: true, dirty: true };
  }
  let dirty: boolean;
  try {
    dirty = blobSha(readFileSync(path)) !== staged;
  } catch {
    // Unreadable working-tree file: cannot prove it is clean, so assume it is
    // not, and let the caller confirm rather than overwrite blindly.
    dirty = true;
  }
  return { isRepo: true, tracked: true, dirty };
}

/** The default real-filesystem + git implementation. */
export const defaultInjectIO: InjectIO = {
  exists: (p) => existsSync(p),
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  gitStatus: realGitStatus,
};
