import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { InjectIO } from "../inject/io";
import type { ExecutorIO } from "../inject/executor";

/** Create a throwaway temp directory and populate it with files. */
export function makeTmpRepo(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), "bl-cli-"));
  writeFiles(root, files);
  return root;
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
}

export function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Init a git repo in `root` and optionally commit everything currently in it. */
export function gitInit(root: string, commitAll = true): void {
  // When the suite runs inside a git hook (pre-push etc.), git exports GIT_DIR /
  // GIT_INDEX_FILE / GIT_WORK_TREE pointing at the PARENT repo — inheriting them
  // makes every command below operate on that repo instead of the temp dir
  // (this once flipped the real repo's core.bare and identity). Strip them so
  // the temp repo is always self-contained.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore", env });
  run(["init"]);
  run(["config", "user.email", "test@crumbtrail.ai"]);
  run(["config", "user.name", "Test"]);
  run(["config", "commit.gpgsign", "false"]);
  if (commitAll) {
    run(["add", "-A"]);
    run(["commit", "-m", "init", "--no-verify"]);
  }
}

/** An in-memory, zero-disk InjectIO for pure plan-builder tests. */
export function fakeInjectIO(
  files: Record<string, string>,
  opts: {
    dirty?: string[];
    untracked?: string[];
    gitignore?: string | null;
    noRepo?: boolean;
  } = {},
): InjectIO {
  return {
    exists: (p) => p in files,
    readFile: (p) => (p in files ? files[p] : null),
    gitStatus: (_cwd, target) => {
      if (opts.noRepo) return { isRepo: false, tracked: false, dirty: false };
      if ((opts.untracked ?? []).includes(target))
        return { isRepo: true, tracked: false, dirty: true };
      const dirty = (opts.dirty ?? []).includes(target);
      return { isRepo: true, tracked: true, dirty };
    },
  };
}

/** In-memory ExecutorIO; `failOn` forces writeFile to throw for one path. */
export function memExecutorIO(
  initial: Record<string, string> = {},
  failOn?: string,
): { io: ExecutorIO; files: Record<string, string | undefined> } {
  const files: Record<string, string | undefined> = { ...initial };
  const io: ExecutorIO = {
    exists: (p) => p in files && files[p] !== undefined,
    readFile: (p) => (p in files && files[p] !== undefined ? files[p]! : null),
    writeFile: (p, content) => {
      if (failOn && p === failOn) throw new Error(`boom writing ${p}`);
      files[p] = content;
    },
    mkdirp: () => {},
    remove: (p) => {
      files[p] = undefined;
    },
  };
  return { io, files };
}
