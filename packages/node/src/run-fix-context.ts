import { resolve } from "node:path";
import { defaultCliConfig } from "./config";
import {
  buildFixContext,
  FixContextError,
  type FixContext,
} from "./fix-context";
import { resolveLatestIssue } from "./latest-issue";

/** Flags whose next argv entry is a value, not a positional target. */
const VALUE_FLAGS = ["--output", "--interval", "--timeout"];

export interface RunFixContextOptions {
  /**
   * `--follow` poll interval in ms when the flag is absent (default 1000).
   * Injectable so tests never sleep for real-world durations.
   */
  intervalMs?: number;
  /** `--follow` overall timeout in ms when the flag is absent (default 60000). */
  timeoutMs?: number;
}

/**
 * `crumbtrail-server fix-context <session>` — emit the versioned, ranked, correlated fix-context
 * contract for a finalized session. Default output is a human-readable summary; `--json`
 * emits the raw contract.
 *
 * `--latest` replaces the positional session arg, resolving the most recent finalized
 * session with error-class evidence via the SAME shared resolver the `getLatestIssue`
 * MCP tool uses. `--follow` polls (via the public buildFixContext, whose index.json
 * requirement IS the finalize signal) until the context builds or `--timeout` elapses;
 * poll progress goes to stderr, the context to stdout.
 */
export async function runFixContext(
  rest: string[],
  opts: RunFixContextOptions = {},
): Promise<number> {
  const json = rest.includes("--json");
  const latest = rest.includes("--latest");
  const follow = rest.includes("--follow");
  const outputIdx = rest.indexOf("--output");
  const outputDir =
    outputIdx >= 0 && rest[outputIdx + 1]
      ? rest[outputIdx + 1]
      : defaultCliConfig().output;
  const intervalMs = numericFlag(rest, "--interval") ?? opts.intervalMs ?? 1000;
  const timeoutMs = numericFlag(rest, "--timeout") ?? opts.timeoutMs ?? 60000;
  const target = rest.find(
    (arg, i) => !arg.startsWith("--") && !VALUE_FLAGS.includes(rest[i - 1]),
  );

  if (!latest && !target) {
    process.stderr.write(
      "crumbtrail-server fix-context: a session id or directory is required (or pass --latest).\n",
    );
    return 1;
  }

  const describeTarget = latest
    ? "the latest issue (--latest)"
    : String(target);

  // One build attempt. A miss (latest resolver empty, or buildFixContext's
  // session-not-found) returns a reason instead of throwing so --follow can
  // poll on it; unexpected errors still propagate.
  const tryOnce = async (): Promise<{
    context?: FixContext;
    reason: string;
  }> => {
    if (latest) {
      const hit = await resolveLatestIssue({ outputDir });
      if (!hit) {
        return {
          reason: `No finalized session with error-class evidence found under ${outputDir}; run a session and wait for finalize, or pass a session id.`,
        };
      }
      try {
        return {
          context: await buildFixContext(hit.dir, { outputDir }),
          reason: "",
        };
      } catch (err) {
        if (err instanceof FixContextError) return { reason: err.message };
        throw err;
      }
    }
    try {
      return {
        context: await buildFixContext(resolveTarget(target as string), {
          outputDir,
        }),
        reason: "",
      };
    } catch (err) {
      if (err instanceof FixContextError) return { reason: err.message };
      throw err;
    }
  };

  let outcome = await tryOnce();
  if (!outcome.context && follow) {
    process.stderr.write(
      `crumbtrail-server fix-context: waiting for ${describeTarget} (interval ${intervalMs}ms, timeout ${timeoutMs}ms)...\n`,
    );
    const deadline = Date.now() + timeoutMs;
    while (!outcome.context && Date.now() < deadline) {
      await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
      outcome = await tryOnce();
    }
  }

  if (!outcome.context) {
    if (follow) {
      process.stderr.write(
        `crumbtrail-server fix-context: timed out after ${timeoutMs}ms waiting for ${describeTarget}: ${outcome.reason}\n`,
      );
    } else {
      process.stderr.write(
        `crumbtrail-server fix-context: ${outcome.reason}\n`,
      );
    }
    return 1;
  }

  const context = outcome.context;
  if (json) {
    process.stdout.write(`${JSON.stringify(context, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatFixContext(context)}\n`);
  }
  return 0;
}

function numericFlag(rest: string[], name: string): number | undefined {
  const idx = rest.indexOf(name);
  if (idx < 0) return undefined;
  const value = Number.parseInt(rest[idx + 1] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function resolveTarget(target: string): string {
  // A path-like argument resolves against cwd; a bare id is passed through so the session
  // resolver can locate it against the sessions dir (flat OR the V2 partition layout).
  if (
    target.includes("/") ||
    target.includes("\\") ||
    target === "." ||
    target.startsWith(".")
  ) {
    return resolve(target);
  }
  return target;
}

export function formatFixContext(context: FixContext): string {
  const lines: string[] = [];
  const s = context.session;
  lines.push(`crumbtrail-server fix-context — ${s.id}`);
  lines.push(`  Schema:      ${context.schemaVersion}`);
  lines.push(
    `  App:         ${s.app ?? "unknown"}${s.source ? ` (${s.source})` : ""}`,
  );
  lines.push(`  Duration:    ${s.durationMs} ms`);
  lines.push(`  Signals:     ${context.signals.length}`);

  for (const signal of context.signals.slice(0, 5)) {
    lines.push(
      `    ${signal.id} [${signal.detector}] score ${signal.baseScore} — ${signal.title}`,
    );
  }

  const window = context.primary_window.frontend.window;
  lines.push(
    `  Primary window: ${window ? `[${window.start}..${window.end}] ${window.windowId}` : "none"}` +
      ` · linked frontend ${context.primary_window.frontend.requests.length}` +
      ` / backend ${context.primary_window.backend.requests.length}`,
  );

  lines.push(`  Repro hint:  ${context.repro_hint?.title ?? "none"}`);
  lines.push(
    `  Environment: ${context.environment === null ? "not captured" : "captured"}`,
  );
  lines.push(
    `  DB diffs:    ${context.primary_window.db_diffs.length === 0 ? "none" : String(context.primary_window.db_diffs.length)}`,
  );
  return lines.join("\n");
}
