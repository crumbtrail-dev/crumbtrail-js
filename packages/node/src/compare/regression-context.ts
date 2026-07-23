import type { Divergence, EnvDiff, SessionComparison } from "./index";
import { comparisonTitle } from "./report";
import { buildFixContext } from "../fix-context";
import { defaultSessionStore } from "../session-store";

export const REGRESSION_CONTEXT_SCHEMA_VERSION =
  "regression-context.v1" as const;

export interface RegressionContext {
  schemaVersion: typeof REGRESSION_CONTEXT_SCHEMA_VERSION;
  /**
   * Release-first witness title, e.g. "R181 vs R182", falling back to bare
   * session ids when no release metadata exists. Lets a consumer name the
   * regression by release without re-deriving it from the comparison.
   */
  title: string;
  comparison: SessionComparison;
  divergent_interaction: { sig: string; label: string; path: string } | null;
  causal_window: {
    requestIds: string[];
    t0: number;
    t1: number;
    hints: string[];
  } | null;
  db_rows: Array<{
    table: string;
    pk: Record<string, unknown>;
    before: unknown;
    after: unknown;
  }>;
  /**
   * The "works in QA, fails in prod, here is the config delta" channel: the
   * structured added/removed/changed env/flag/config/release/build delta between
   * the two sessions. Null when the env plane did not diverge.
   */
  env_delta: EnvDiff | null;
  repro_hint: string;
}

export async function buildRegressionContext(
  comparison: SessionComparison,
  bDir: string,
): Promise<RegressionContext> {
  const reproHintText = await reproHint(bDir);
  const requestIds = unique(
    comparison.divergences.map((d) => d.requestId).filter(isString),
  );
  const times = (
    await Promise.all(
      requestIds.map((requestId) => requestTimesFromIndex(bDir, requestId)),
    )
  ).flat();
  const firstSig = comparison.divergences.map((d) => d.sig).find(isString);
  return {
    schemaVersion: REGRESSION_CONTEXT_SCHEMA_VERSION,
    title: comparisonTitle(comparison),
    comparison,
    divergent_interaction: firstSig
      ? await interactionForSig(bDir, firstSig)
      : null,
    causal_window:
      requestIds.length > 0
        ? {
            requestIds,
            t0: times.length > 0 ? Math.max(0, Math.min(...times) - 1000) : 0,
            t1: times.length > 0 ? Math.max(...times) + 1000 : 0,
            hints: [
              "Use getLinkedRequestContext for request ids in this window.",
              "Use getWindow with t0/t1 when raw chronological evidence is needed.",
            ],
          }
        : null,
    db_rows: comparison.divergences
      .filter((d) => d.plane === "db" && d.table)
      .map((d) => ({
        table: d.table as string,
        pk: d.pk ?? {},
        before: d.before,
        after: d.after,
      })),
    env_delta: comparison.envDelta ?? null,
    repro_hint: reproHintText,
  };
}

async function interactionForSig(
  sessionDir: string,
  sig: string,
): Promise<RegressionContext["divergent_interaction"]> {
  const signatures = await readSignatures(sessionDir);
  const signature = signatures.find((entry) => entry.sig === sig);
  return {
    sig,
    label: stringField(signature?.txt) ?? stringField(signature?.tag) ?? sig,
    path: stringField(signature?.path) ?? "",
  };
}

// Reads via the SessionStore seam: signatures.json is a finalize-time cold
// artifact, so under at-rest encryption fs would hand back an envelope.
async function readSignatures(
  sessionDir: string,
): Promise<Record<string, unknown>[]> {
  try {
    const raw = await defaultSessionStore.readArtifact(
      sessionDir,
      "signatures.json",
    );
    if (!raw) return [];
    const parsed = JSON.parse(raw.toString("utf-8")) as unknown;
    return isRecord(parsed) && Array.isArray(parsed.entries)
      ? parsed.entries.filter(isRecord)
      : [];
  } catch {
    return [];
  }
}

async function requestTimesFromIndex(
  sessionDir: string,
  requestId: string,
): Promise<number[]> {
  let index: unknown;
  try {
    const raw = await defaultSessionStore.readArtifact(sessionDir, "index.json");
    if (!raw) return [];
    index = JSON.parse(raw.toString("utf-8"));
  } catch {
    return [];
  }
  const fullStack =
    isRecord(index) && isRecord(index.fullStackRequests)
      ? index.fullStackRequests
      : undefined;
  const linked = Array.isArray(fullStack?.linked)
    ? fullStack.linked.filter(isRecord)
    : [];
  const match = linked.find((entry) => entry.requestId === requestId);
  if (!match) return [];
  const times: number[] = [];
  collectRefTimes(match.frontend, times);
  collectRefTimes(match.backend, times);
  return times;
}

function collectRefTimes(value: unknown, times: number[]): void {
  if (!isRecord(value)) return;
  const ref = isRecord(value.ref) ? value.ref : undefined;
  const start = isRecord(value.start) ? value.start : undefined;
  const end = isRecord(value.end) ? value.end : undefined;
  for (const candidate of [ref, start, end]) {
    if (typeof candidate?.t === "number" && Number.isFinite(candidate.t))
      times.push(candidate.t);
  }
}

async function reproHint(sessionDir: string): Promise<string> {
  try {
    const context = await buildFixContext(sessionDir);
    return (
      context.repro_hint?.title ?? "Replay the same recorded flow in session B."
    );
  } catch {
    return "Replay the same recorded flow in session B.";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
