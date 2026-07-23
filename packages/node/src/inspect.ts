import path from "node:path";
import { resolveSessionDirById } from "./session-paths";
import { defaultSessionStore } from "./session-store";

/**
 * Concise, hot-plane-only summary of a finalized session. `crumbtrail-server inspect <session>` reads
 * the session manifest (manifest.json) when present and otherwise falls back to index.json. It
 * never reads raw events.ndjson — counts come from the pre-computed index/manifest.
 */
export interface SessionInspectionArtifact {
  name: string;
  bytes: number;
}

export interface SessionInspection {
  id: string;
  durationMs: number;
  eventCount: number;
  errorCount: number;
  failedRequestCount: number;
  candidateCount: number;
  truncated: boolean;
  /** Which hot-plane artifact the summary was primarily derived from. */
  source: "manifest" | "index";
  /**
   * Earliest error-class evidence timestamp stamped into llm.json by bundle build.
   * Omitted when the bundle carries no latency self-measurement (or llm.json is absent).
   */
  firstErrorEventAt?: number;
  /** Self-measured detect-to-bundle latency (ms) stamped into llm.json. Omitted when absent. */
  detectToBundleMs?: number;
  artifacts: SessionInspectionArtifact[];
}

export interface InspectSessionOptions {
  /** Base sessions directory used to resolve a bare session id to a directory. */
  outputDir?: string;
}

export class InspectError extends Error {
  constructor(
    readonly code: "session-not-found",
    message: string,
  ) {
    super(message);
    this.name = "InspectError";
  }
}

export async function inspectSession(
  sessionDirOrId: string,
  opts: InspectSessionOptions = {},
): Promise<SessionInspection> {
  const sessionDir = resolveSessionDir(sessionDirOrId, opts);
  const manifest = await readJsonRecord(sessionDir, "manifest.json");
  const index = await readJsonRecord(sessionDir, "index.json");
  // llm.json is hot-plane; only the bundle's self-measured latency stamp is read from it.
  const llmBundle = await readJsonRecord(sessionDir, "llm.json");

  if (!manifest && !index) {
    throw new InspectError(
      "session-not-found",
      `No finalized session found at ${sessionDir} (missing manifest.json and index.json). Run post-processing first.`,
    );
  }

  const session = isRecord(manifest?.session) ? manifest!.session : undefined;
  const timeline = isRecord(manifest?.timeline)
    ? manifest!.timeline
    : undefined;

  const errs = Array.isArray(index?.errs) ? index!.errs : undefined;
  const failedReqs = Array.isArray(index?.failedReqs)
    ? index!.failedReqs
    : undefined;
  const errorMarkers = Array.isArray(timeline?.errorMarkers)
    ? timeline!.errorMarkers
    : undefined;
  const failedMarkers = Array.isArray(timeline?.failedRequests)
    ? timeline!.failedRequests
    : undefined;
  const candidates = Array.isArray(manifest?.candidates)
    ? manifest!.candidates
    : undefined;
  const firstErrorEventAt = finiteNumber(llmBundle?.firstErrorEventAt);
  const detectToBundleMs = finiteNumber(llmBundle?.detectToBundleMs);

  // Hoisted: both now read through the async store seam.
  const candidateCount =
    candidates?.length ?? (await countCandidateLines(sessionDir));
  const artifacts = await collectArtifacts(sessionDir, manifest);

  return {
    id:
      safeString(session?.id) ??
      safeString(index?.id) ??
      path.basename(sessionDir),
    durationMs:
      finiteNumber(session?.durationMs) ?? finiteNumber(index?.dur) ?? 0,
    eventCount:
      finiteNumber(session?.eventCount) ?? finiteNumber(index?.evts) ?? 0,
    errorCount: errs?.length ?? errorMarkers?.length ?? 0,
    failedRequestCount: failedReqs?.length ?? failedMarkers?.length ?? 0,
    candidateCount,
    truncated: Boolean((session?.truncated as unknown) ?? index?.truncated),
    source: manifest ? "manifest" : "index",
    // Keys omitted entirely when llm.json carries no latency stamp, so --json output
    // stays clean for sessions without error-class evidence.
    ...(firstErrorEventAt !== undefined ? { firstErrorEventAt } : {}),
    ...(detectToBundleMs !== undefined ? { detectToBundleMs } : {}),
    artifacts,
  };
}

export function formatInspection(inspection: SessionInspection): string {
  const lines: string[] = [];
  lines.push(`crumbtrail-server inspect — ${inspection.id}`);
  lines.push(`  Source:        ${inspection.source}.json`);
  lines.push(`  Duration:      ${inspection.durationMs} ms`);
  lines.push(`  Events:        ${inspection.eventCount}`);
  lines.push(`  Errors:        ${inspection.errorCount}`);
  lines.push(`  Failed reqs:   ${inspection.failedRequestCount}`);
  lines.push(`  Candidates:    ${inspection.candidateCount}`);
  lines.push(`  Truncated:     ${inspection.truncated ? "yes" : "no"}`);
  if (inspection.detectToBundleMs !== undefined) {
    lines.push(`  Detect→bundle: ${inspection.detectToBundleMs} ms`);
  }
  lines.push(`  Artifacts (${inspection.artifacts.length}):`);
  if (inspection.artifacts.length === 0) {
    lines.push("    (none)");
  } else {
    for (const artifact of inspection.artifacts) {
      lines.push(`    ${artifact.name}  ${artifact.bytes} bytes`);
    }
  }
  return lines.join("\n");
}

function resolveSessionDir(
  sessionDirOrId: string,
  opts: InspectSessionOptions,
): string {
  return resolveSessionDirById(sessionDirOrId, opts.outputDir);
}

/**
 * Lists hot-plane artifacts present on disk with their sizes. Prefers the manifest's declared
 * hot+cold artifact lists (so the output reflects the canonical layout) and falls back to a
 * directory listing when no manifest exists. Directories and the raw events.ndjson are excluded.
 */
async function collectArtifacts(
  sessionDir: string,
  manifest: Record<string, unknown> | undefined,
): Promise<SessionInspectionArtifact[]> {
  const seen = new Set<string>();
  const artifacts: SessionInspectionArtifact[] = [];

  const add = async (name: string): Promise<void> => {
    if (seen.has(name)) return;
    if (path.basename(name) === "events.ndjson") return; // never surface the raw cold log
    const stat = await defaultSessionStore.statArtifact(sessionDir, name);
    if (!stat || stat.isDir) return;
    seen.add(name);
    artifacts.push({ name, bytes: stat.bytes });
  };

  if (manifest) {
    for (const plane of ["hot", "cold"] as const) {
      const section = isRecord(manifest[plane])
        ? (manifest[plane] as Record<string, unknown>)
        : undefined;
      const declared = Array.isArray(section?.artifacts)
        ? section!.artifacts
        : [];
      for (const entry of declared) {
        if (
          isRecord(entry) &&
          entry.exists === true &&
          typeof entry.path === "string"
        )
          await add(entry.path);
      }
    }
  } else {
    const names = await defaultSessionStore.listArtifacts(sessionDir);
    for (const name of names.sort()) {
      await add(name);
    }
  }

  return artifacts;
}

async function countCandidateLines(sessionDir: string): Promise<number> {
  try {
    const buf = await defaultSessionStore.readArtifact(
      sessionDir,
      "candidates.jsonl",
    );
    if (!buf) return 0;
    const content = buf.toString("utf-8").trim();
    if (!content) return 0;
    return content.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

async function readJsonRecord(
  sessionDir: string,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const buf = await defaultSessionStore.readArtifact(sessionDir, name);
    if (!buf) return undefined;
    const parsed: unknown = JSON.parse(buf.toString("utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
