import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { defaultCliConfig } from "./config";
import { reanalyzeSession, type ReanalyzeSessionResult } from "./post-process";
import { resolveSessionDirById } from "./session-paths";

interface ReanalyzeReport {
  sessionId: string;
  sessionDir: string;
  status: "reanalyzed" | "skipped" | "failed";
  events?: number;
  reason?: string;
}

/**
 * `crumbtrail-server reanalyze <session|--all>` — rebuild finalized sessions'
 * derived artifacts by replaying their cold event stream through the current
 * analyzer.
 *
 * Session artifacts are written once at finalize time, so a session analyzed by
 * an older build keeps that build's output even after the analyzer improves.
 * This re-runs the analysis over evidence already on disk. It reads
 * `events.ndjson.zst` and never rewrites it.
 */
export async function runReanalyze(rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const all = rest.includes("--all");
  const dryRun = rest.includes("--dry-run");
  const outputIdx = rest.indexOf("--output");
  const outputDir =
    outputIdx >= 0 && rest[outputIdx + 1]
      ? rest[outputIdx + 1]
      : defaultCliConfig().output;
  const target = rest.find(
    (arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--output",
  );

  if (!all && !target) {
    process.stderr.write(
      "crumbtrail-server reanalyze: a session id or directory is required (or --all).\n",
    );
    return 1;
  }
  if (all && target) {
    process.stderr.write(
      "crumbtrail-server reanalyze: pass a session or --all, not both.\n",
    );
    return 1;
  }

  const sessionDirs = all
    ? findFinalizedSessionDirs(outputDir)
    : [resolveTarget(target as string, outputDir)];

  if (sessionDirs.length === 0) {
    process.stderr.write(
      `crumbtrail-server reanalyze: no finalized sessions found under ${outputDir}.\n`,
    );
    return 1;
  }

  const reports: ReanalyzeReport[] = [];
  for (const sessionDir of sessionDirs) {
    reports.push(await reanalyzeOne(sessionDir, dryRun));
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReports(reports, dryRun)}\n`);
  }
  // A single failure fails the run so a batch repair does not report success
  // while leaving sessions behind.
  return reports.some((report) => report.status === "failed") ? 1 : 0;
}

async function reanalyzeOne(
  sessionDir: string,
  dryRun: boolean,
): Promise<ReanalyzeReport> {
  const sessionId = path.basename(sessionDir);
  if (dryRun) {
    const cold = path.join(sessionDir, "events.ndjson.zst");
    return fs.existsSync(cold)
      ? { sessionId, sessionDir, status: "reanalyzed" }
      : {
          sessionId,
          sessionDir,
          status: "skipped",
          reason: "no cold event stream",
        };
  }
  let result: ReanalyzeSessionResult;
  try {
    result = await reanalyzeSession(sessionDir);
  } catch (err) {
    return {
      sessionId,
      sessionDir,
      status: "failed",
      reason: err instanceof Error ? err.message : String(err),
    };
  }
  return result.reanalyzed
    ? { sessionId, sessionDir, status: "reanalyzed", events: result.events }
    : {
        sessionId,
        sessionDir,
        status: "skipped",
        reason: "no cold event stream",
      };
}

/**
 * Walks the sessions tree for directories holding a cold event stream. Covers
 * both the flat layout and the V2 `{tenant}/{app}/{date}/{sessionId}` partition
 * without assuming a fixed depth.
 */
function findFinalizedSessionDirs(outputDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((entry) => entry.name === "events.ndjson.zst")) {
      found.push(dir);
      return; // A session directory never nests another session.
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), depth + 1);
    }
  };
  walk(outputDir, 0);
  return found.sort();
}

function formatReports(reports: ReanalyzeReport[], dryRun: boolean): string {
  const lines = dryRun ? ["Dry run — nothing was written."] : [];
  for (const report of reports) {
    const detail =
      report.status === "reanalyzed"
        ? report.events !== undefined
          ? `${report.events} events`
          : "would reanalyze"
        : (report.reason ?? "");
    lines.push(`${report.status.padEnd(11)} ${report.sessionId}  ${detail}`);
  }
  const counts = {
    reanalyzed: reports.filter((r) => r.status === "reanalyzed").length,
    skipped: reports.filter((r) => r.status === "skipped").length,
    failed: reports.filter((r) => r.status === "failed").length,
  };
  lines.push(
    "",
    `${counts.reanalyzed} reanalyzed, ${counts.skipped} skipped, ${counts.failed} failed`,
  );
  return lines.join("\n");
}

function resolveTarget(target: string, outputDir: string): string {
  if (
    target.includes("/") ||
    target.includes("\\") ||
    target === "." ||
    target.startsWith(".")
  ) {
    return resolve(target);
  }
  return resolveSessionDirById(target, outputDir);
}
