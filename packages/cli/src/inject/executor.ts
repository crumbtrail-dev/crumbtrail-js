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
import {
  prependIntoSource,
  withTrailingNewline,
  type Plan,
} from "crumbtrail-detect-core";

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

export interface MaterializedPlan {
  kind: Plan["kind"];
  edits: Array<{
    path: string;
    mode: "create" | "update";
    content: string;
  }>;
  warnings: string[];
  keyEnvVar?: string;
}

interface PreImage {
  path: string;
  existed: boolean;
  content: string | null;
}

function applyAllOrNothing(
  edits: MaterializedPlan["edits"],
  io: ExecutorIO,
): string[] {
  const preimages: PreImage[] = [];
  const written: string[] = [];
  try {
    for (const edit of edits) {
      const existed = io.exists(edit.path);
      // Reasserted at write time, not just at materialization time. The gap
      // between the two is a TOCTOU window, and a multi edit array could
      // otherwise clobber a file created by an earlier edit in the same batch.
      if (existed && edit.mode === "create") {
        throw new Error(`refusing to overwrite existing file: ${edit.path}`);
      }
      const prior = existed ? io.readFile(edit.path) : null;
      preimages.push({ path: edit.path, existed, content: prior });

      io.mkdirp(path.dirname(edit.path));
      io.writeFile(edit.path, edit.content);
      written.push(edit.path);
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
 * Resolve a Plan into exact file bytes without writing them. This is shared by
 * the CLI writer and cloud callers so both materialize injection output by the
 * same construction.
 *
 * `kind` on the result is always the ORIGINAL plan kind, so a caller can still
 * tell that a plan needed confirmation. The dirty gate itself is CLI-only.
 *
 * Known divergence for cloud callers: `io.exists` follows symlinks, so a
 * symlinked targetPath materializes as an update and the CLI writes through to
 * the link target, whereas a GitHub update would replace the symlink blob
 * itself. Different files receive the bytes. Resolve symlinks before calling if
 * a repository may contain them.
 */
export function materializePlan(plan: Plan, io: ExecutorIO): MaterializedPlan {
  const materialized: MaterializedPlan = {
    kind: plan.kind,
    edits: [],
    // Copied, not aliased: a cloud caller mutating this must not reach the Plan.
    warnings: [...plan.warnings],
    keyEnvVar: plan.keyEnvVar,
  };

  if (
    plan.kind === "skip-already-wired" ||
    plan.kind === "fallback-ai" ||
    plan.kind === "otlp-guidance" ||
    !plan.targetPath ||
    plan.content == null ||
    plan.content === ""
  ) {
    return materialized;
  }

  // needs-confirm-dirty carries its real write shape in applyMode. Resolving it
  // here rather than in executePlan is what stops a cloud caller from silently
  // receiving zero edits for a plan that should produce a pull request.
  const effectiveKind =
    plan.kind === "needs-confirm-dirty"
      ? plan.applyMode === "rewrite"
        ? "rewrite"
        : "prepend"
      : plan.kind;

  if (effectiveKind === "create") {
    if (io.exists(plan.targetPath)) {
      throw new Error(`refusing to overwrite existing file: ${plan.targetPath}`);
    }
    materialized.edits.push({
      path: plan.targetPath,
      mode: "create",
      content: withTrailingNewline(plan.content),
    });
  } else if (effectiveKind === "rewrite") {
    // mode is derived, never assumed: the cloud picks GitHub create vs update
    // from it, and an update needs a blob SHA that a new path does not have.
    materialized.edits.push({
      path: plan.targetPath,
      mode: io.exists(plan.targetPath) ? "update" : "create",
      content: withTrailingNewline(plan.content),
    });
  } else {
    const existed = io.exists(plan.targetPath);
    const prior = existed ? io.readFile(plan.targetPath) : null;
    materialized.edits.push({
      path: plan.targetPath,
      // prependIntoSource("", block) legitimately produces a new file.
      mode: existed ? "update" : "create",
      content: prependIntoSource(prior ?? "", plan.content),
    });
  }

  return materialized;
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

  // The dirty *gate* above is CLI-only: a working tree is not a concept the
  // cloud has. Resolving applyMode into a kind is plan semantics, though, so it
  // lives inside materializePlan where both callers share it.
  const materialized = materializePlan(plan, io);
  const written = applyAllOrNothing(materialized.edits, io);
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
