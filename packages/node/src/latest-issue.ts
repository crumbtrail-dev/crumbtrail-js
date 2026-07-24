import { defaultSessionStore } from "./session-store";

/**
 * Shared "latest issue" resolver behind BOTH the `getLatestIssue` MCP tool and
 * the `fix-context --latest` CLI flag, so the two surfaces always agree on
 * which session "the latest issue" means.
 *
 * Pinned definition (mirrored by latest-issue.test.ts):
 * - Scan every session under `outputDir` via the storage seam
 *   (`defaultSessionStore.listSessions`).
 * - A session QUALIFIES iff its `index.json` exists (index.json presence IS the
 *   finalize signal) AND it carries error-class evidence: `index.errs`
 *   non-empty, OR `index.failedReqs` non-empty, OR `index.consoleErrors`
 *   non-empty, OR any `candidates.jsonl` row with severity `"critical"` or
 *   `"high"`. See `hasErrorClassEvidence` for why each clause is error-class on
 *   its own terms and why `index.networkErrors` is excluded.
 * - RECENCY is `index.end`, falling back to `index.start`, then `meta.start`,
 *   then 0. Remaining ties break by session id descending, then session dir
 *   descending (plain code-unit comparison — never locale-dependent).
 * - Deterministic and hot-plane only: reads index.json, candidates.jsonl and
 *   meta.json — NEVER the cold event stream (events.ndjson / events.ndjson.zst).
 */
export interface LatestIssue {
  sessionId: string;
  dir: string;
}

export async function resolveLatestIssue(opts: {
  outputDir: string;
}): Promise<LatestIssue | undefined> {
  let best: { sessionId: string; dir: string; recency: number } | undefined;

  for (const { id, dir } of await defaultSessionStore.listSessions(
    opts.outputDir,
  )) {
    const index = await readJsonRecord(dir, "index.json");
    if (!index) continue; // not finalized
    if (!(await hasErrorClassEvidence(dir, index))) continue;

    const recency = await recencyOf(dir, index);
    if (!best || beats({ sessionId: id, dir, recency }, best)) {
      best = { sessionId: id, dir, recency };
    }
  }

  return best ? { sessionId: best.sessionId, dir: best.dir } : undefined;
}

function beats(
  candidate: { sessionId: string; dir: string; recency: number },
  incumbent: { sessionId: string; dir: string; recency: number },
): boolean {
  if (candidate.recency !== incumbent.recency)
    return candidate.recency > incumbent.recency;
  if (candidate.sessionId !== incumbent.sessionId)
    return candidate.sessionId > incumbent.sessionId;
  return candidate.dir > incumbent.dir;
}

/**
 * Does this session contain error-class evidence?
 *
 * Every clause names evidence that is error-class on its own terms. None of them infers "an error
 * happened" from how some other candidate was ranked:
 *
 *  - `index.errs` uncaught errors and unhandled rejections (`err` / `rej` events).
 *  - `index.failedReqs` failed HTTP responses, plus the network failures post-process judged to be
 *    real failures rather than routine cancellations.
 *  - `index.consoleErrors` `con` events the capture already narrowed to level `error`
 *    (`summarizeConsoleErrorEvent` drops every other level). An application that logged
 *    `console.error` and nothing else has still reported an error, and no clause above covers it.
 *  - a `critical` or `high` `candidates.jsonl` row, for error-class evidence no index array carries
 *    at all: backend request errors, OTel span errors, `db_delta_mismatch`.
 *
 * `index.consoleErrors` is load bearing rather than redundant. A console error moment carries no
 * request id, so a database write near it grades `temporal` (`medium`/64) rather than `request`
 * (`high`/88). Before database writes were graded by linkage, such a session qualified only because
 * the write was boosted to `high`, which made qualification depend on whether an unrelated write
 * happened to exist. That is not a property of the error. This clause states the evidence directly.
 *
 * `index.networkErrors` is deliberately NOT a clause. post-process pushes every `net.err` into it
 * unconditionally, then applies `isCountableNetworkFailure` before promoting survivors into
 * `failedReqs`. Adding it would widen this gate by exactly the set post-process already judged not
 * to be a failure, so a fetch the user cancelled by navigating away would make its session the
 * latest issue.
 */
async function hasErrorClassEvidence(
  dir: string,
  index: Record<string, unknown>,
): Promise<boolean> {
  if (Array.isArray(index.errs) && index.errs.length > 0) return true;
  if (Array.isArray(index.failedReqs) && index.failedReqs.length > 0)
    return true;
  if (Array.isArray(index.consoleErrors) && index.consoleErrors.length > 0)
    return true;
  return (await candidateSeverities(dir)).some(
    (severity) => severity === "critical" || severity === "high",
  );
}

async function recencyOf(
  dir: string,
  index: Record<string, unknown>,
): Promise<number> {
  const end = finiteNumber(index.end);
  if (end !== undefined) return end;
  const start = finiteNumber(index.start);
  if (start !== undefined) return start;
  const meta = await readJsonRecord(dir, "meta.json");
  return finiteNumber(meta?.start) ?? 0;
}

/** Severities of the detector signal rows in candidates.jsonl, rank order. */
async function candidateSeverities(dir: string): Promise<string[]> {
  const buf = await defaultSessionStore.readArtifact(dir, "candidates.jsonl");
  if (!buf) return [];
  const severities: string[] = [];
  for (const line of buf.toString("utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        typeof (parsed as Record<string, unknown>).severity === "string"
      ) {
        severities.push((parsed as Record<string, unknown>).severity as string);
      }
    } catch {
      // candidates.jsonl is written deterministically; skip malformed lines defensively.
    }
  }
  return severities;
}

async function readJsonRecord(
  dir: string,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const buf = await defaultSessionStore.readArtifact(dir, name);
    if (!buf) return undefined;
    const parsed: unknown = JSON.parse(buf.toString("utf-8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}
