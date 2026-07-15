// The one module that mutates the filesystem. It applies a Plan all-or-nothing:
// every touched file's pre-image is captured first, and if any write throws, all
// pre-images are restored so a failed run leaves the repo byte-identical.
//
// Uses only node:fs / node:path — no networking.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { prependIntoSource, withTrailingNewline } from "./text";
import type { Plan } from "./types";

/** Write boundary for the executor — swappable in tests. */
export interface ExecutorIO {
  exists(p: string): boolean;
  readFile(p: string): string | null;
  writeFile(p: string, content: string): void;
  mkdirp(dir: string): void;
  remove(p: string): void;
}

export const defaultExecutorIO: ExecutorIO = {
  exists: (p) => existsSync(p),
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  },
  writeFile: (p, content) => writeFileSync(p, content),
  mkdirp: (dir) => {
    mkdirSync(dir, { recursive: true });
  },
  remove: (p) => {
    rmSync(p, { force: true });
  },
};

export interface ExecuteOptions {
  /** Apply a `needs-confirm-dirty` plan (the user confirmed / passed --force). */
  confirmDirty?: boolean;
}

export interface ExecuteResult {
  kind: Plan["kind"];
  /** Absolute paths actually written. */
  written: string[];
  /** True when nothing was written (skip / fallback / unconfirmed-dirty). */
  skipped: boolean;
  message: string;
}

type FileOp =
  | { op: "create"; path: string; content: string }
  | { op: "prepend"; path: string; block: string };

interface PreImage {
  path: string;
  existed: boolean;
  content: string | null;
}

function applyAllOrNothing(ops: FileOp[], io: ExecutorIO): string[] {
  const preimages: PreImage[] = [];
  const written: string[] = [];
  try {
    for (const op of ops) {
      const existed = io.exists(op.path);
      const prior = existed ? io.readFile(op.path) : null;
      preimages.push({ path: op.path, existed, content: prior });

      let next: string;
      switch (op.op) {
        case "create":
          if (existed) {
            throw new Error(`refusing to overwrite existing file: ${op.path}`);
          }
          next = op.content;
          break;
        case "prepend":
          next = prependIntoSource(prior ?? "", op.block);
          break;
      }
      io.mkdirp(path.dirname(op.path));
      io.writeFile(op.path, next);
      written.push(op.path);
    }
    return written;
  } catch (err) {
    // Roll back in reverse so the repo is byte-identical to the pre-image.
    for (const pre of preimages.reverse()) {
      if (!pre.existed) io.remove(pre.path);
      else if (pre.content != null) io.writeFile(pre.path, pre.content);
    }
    throw err;
  }
}

/**
 * Execute a Plan. skip/fallback plans (and unconfirmed dirty plans) perform no
 * writes. create/prepend plans are applied all-or-nothing. The installer never
 * writes the ingest key (hands-off), so there is no `.env` write to apply.
 */
export function executePlan(
  plan: Plan,
  io: ExecutorIO = defaultExecutorIO,
  options: ExecuteOptions = {},
): ExecuteResult {
  if (plan.kind === "skip-already-wired") {
    return {
      kind: plan.kind,
      written: [],
      skipped: true,
      message: "Already wired — skipped.",
    };
  }
  if (plan.kind === "fallback-ai") {
    return {
      kind: plan.kind,
      written: [],
      skipped: true,
      message:
        "Ambiguous — emitted snippet + AI prompt instead of editing files.",
    };
  }
  if (plan.kind === "otlp-guidance") {
    // Non-JS OTLP backend: never mutate the filesystem — the wizard prints the
    // OTLP setup guidance instead. Guarded explicitly so it can never fall
    // through to the create/prepend op assembly below.
    return {
      kind: plan.kind,
      written: [],
      skipped: true,
      message:
        "OTLP backend — printed setup guidance instead of editing files.",
    };
  }
  if (plan.kind === "needs-confirm-dirty" && !options.confirmDirty) {
    return {
      kind: plan.kind,
      written: [],
      skipped: true,
      message: "Target is dirty — confirm or pass force to apply.",
    };
  }

  const ops: FileOp[] = [];
  if (plan.targetPath && plan.content != null) {
    if (plan.kind === "create") {
      ops.push({
        op: "create",
        path: plan.targetPath,
        content: withTrailingNewline(plan.content),
      });
    } else {
      // prepend, or a confirmed needs-confirm-dirty plan
      ops.push({ op: "prepend", path: plan.targetPath, block: plan.content });
    }
  }

  const written = applyAllOrNothing(ops, io);
  return {
    kind: plan.kind,
    written,
    skipped: written.length === 0,
    message:
      written.length === 0
        ? "Nothing to write."
        : `Wrote ${written.length} file(s).`,
  };
}
