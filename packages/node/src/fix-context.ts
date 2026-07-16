import path from "node:path";
import { resolveSessionDirById } from "./session-paths";
import { defaultSessionStore } from "./session-store";
import type { EvidenceCandidate } from "./evidence-index";
import type { CausalConfidence } from "./causal-graph";
import type {
  LlmBundle,
  LlmBundleBackendRequestEvidenceSummary,
  LlmBundleDbDiff,
  LlmBundleDbRead,
  LlmBundleDbActivity,
  LlmBundleFrontendRequestEvidenceSummary,
  LlmBundleLinkedFullStackRequestSummary,
} from "./llm-bundle";

/** A database row diff correlated to the primary window. See {@link LlmBundleDbDiff}. */
export type FixContextDbDiff = LlmBundleDbDiff;
export type FixContextDbRead = LlmBundleDbRead;
export type FixContextDbActivity = LlmBundleDbActivity;

/**
 * Versioned, correlated, LLM-ready "hand it to the model" bundle for a finalized
 * session. This is the keystone fix-context contract (V2.5).
 *
 * The shape is intentionally stable: `primary_window.db_diffs` defaults to an empty array
 * and `environment` defaults to null so later checkpoints (CP5 DB diffing, CP3 environment
 * capture) can populate them without breaking the contract.
 */
/**
 * @stability stable
 * Version-bump policy follows the same Fork A decision as fusion.v1 — see
 * wargames/wargames/01-solve-context-wargame-fields.md.
 */
export const FIX_CONTEXT_SCHEMA_VERSION = "fix-context.v2" as const;

export interface FixContextSession {
  id: string;
  name?: string;
  app?: string;
  source?: string;
  startMs: number;
  endMs: number;
  durationMs: number;
}

export interface FixContextReproHint {
  title?: string;
  detector?: string;
  severity?: EvidenceCandidate["severity"];
  route?: string;
  target?: EvidenceCandidate["anchor"]["target"];
  elementLabel?: string;
  errorCode?: string;
  message?: string;
  requestId?: string;
  offsetMs?: number;
}

export interface FixContextPrimaryWindow {
  frontend: {
    window: { start: number; end: number; windowId: string } | null;
    anchor: EvidenceCandidate["anchor"] | null;
    requests: LlmBundleFrontendRequestEvidenceSummary[];
  };
  backend: {
    requests: LlmBundleBackendRequestEvidenceSummary[];
  };
  /**
   * Database row diffs correlated to the primary window (CP5 DB diffing). Empty when the session
   * captured no `db.diff` events in the window. Consumers MUST treat `[]` as "no DB evidence".
   */
  db_diffs: FixContextDbDiff[];
  /**
   * Database rows read in the primary window (`db.read`, pre-state capture). Empty when read
   * capture is disabled or no reads matched the primary request/window.
   */
  db_reads: FixContextDbRead[];
  /**
   * OTel DB span activity in the primary window. These are statements/operations only, never
   * before/after row diffs.
   */
  db_activity: FixContextDbActivity[];
}

/** One downstream symptom of the primary root cause, resolved from `signals`. */
export interface FixContextCausalSymptom {
  id: string;
  detector: string;
  title: string;
  attributionConfidence?: CausalConfidence;
}

/**
 * The primary root-cause → symptom chain, derived ONLY from causal fields already present on the
 * signals (CP3). `null` when the primary candidate is isolated or has no attributed
 * symptoms. Purely a projection — no attribution is recomputed here.
 */
export interface FixContextCausalChain {
  root: { id: string; detector: string; title: string };
  symptoms: FixContextCausalSymptom[];
}

/**
 * A deterministic detector output. `basis` makes it explicit that `baseScore`
 * is a reproducible heuristic score, not a contextual model judgment.
 *
 * Candidates on disk intentionally remain unchanged for artifact compatibility;
 * this contract projects the audit fields at its boundary.
 */
export type FixContextSignal = EvidenceCandidate & {
  basis: "heuristic";
  baseScore: number;
};

export interface FixContext {
  schemaVersion: typeof FIX_CONTEXT_SCHEMA_VERSION;
  session: FixContextSession;
  signals: FixContextSignal[];
  primary_window: FixContextPrimaryWindow;
  /**
   * Account/environment state snapshot. Defaults to `null`; CP3 (environment capture)
   * populates this. Consumers MUST treat null as "not captured".
   */
  environment: Record<string, unknown> | null;
  /**
   * Primary root-cause → symptom chain projected from the signals' causal fields (CP4).
   * `null` when the top candidate is isolated or attributes no symptoms. Consumers MUST treat null
   * as "no causal structure surfaced".
   */
  causal_chain: FixContextCausalChain | null;
  repro_hint: FixContextReproHint | null;
}

export interface BuildFixContextOptions {
  /** Base sessions directory used to resolve a bare session id to a directory. */
  outputDir?: string;
}

export class FixContextError extends Error {
  constructor(
    readonly code: "session-not-found",
    message: string,
  ) {
    super(message);
    this.name = "FixContextError";
  }
}

/**
 * Builds the fix-context contract for a finalized session by reading hot-plane artifacts
 * (index.json, candidates.jsonl, llm.json). It never reads raw NDJSON at query time.
 */
export function buildFixContext(
  sessionDirOrId: string,
  opts: BuildFixContextOptions = {},
): FixContext {
  const sessionDir = resolveSessionDir(sessionDirOrId, opts);
  if (!defaultSessionStore.statArtifact(sessionDir, "index.json")) {
    throw new FixContextError(
      "session-not-found",
      `No finalized session found at ${sessionDir} (missing index.json). Run post-processing first.`,
    );
  }

  const index = readJsonRecord(sessionDir, "index.json") ?? {};
  const bundle = readBundle(sessionDir);
  const ranked = readCandidates(sessionDir);

  return buildFixContextFromArtifacts(sessionDir, index, bundle, ranked);
}

/**
 * Assembles the fix-context contract from already-read finalized artifacts.
 * This lets alternate read backends preserve the stable local contract without
 * duplicating the projection and ranking logic.
 */
export function buildFixContextFromArtifacts(
  sessionDir: string,
  index: Record<string, unknown>,
  bundle: LlmBundle | undefined,
  ranked: EvidenceCandidate[],
): FixContext {
  const session = buildSession(sessionDir, index, bundle);
  const primaryWindow = buildPrimaryWindow(ranked, bundle);
  const reproHint = buildReproHint(ranked);
  const environment = buildEnvironment(bundle);
  const causalChain = buildCausalChain(ranked);

  return {
    schemaVersion: FIX_CONTEXT_SCHEMA_VERSION,
    session,
    signals: ranked.map(toSignal),
    primary_window: primaryWindow,
    environment,
    causal_chain: causalChain,
    repro_hint: reproHint,
  };
}

function toSignal(candidate: EvidenceCandidate): FixContextSignal {
  return {
    ...candidate,
    basis: "heuristic",
    baseScore: candidate.score,
  };
}

/**
 * Projects the primary root-cause → symptom chain from causal fields already present on the ranked
 * candidates (CP3). Does NOT recompute attribution and does NOT re-sort candidates: it reads the
 * root-first order that `candidates.jsonl` already carries.
 *
 * Primary root resolution:
 *   - if `ranked[0].causalRole === 'root'` → ranked[0] is the root;
 *   - else if ranked[0] is a symptom → resolve its `rootCauseId` against `signals`;
 *   - else (isolated / no candidates) → null.
 * Symptoms are the root's own `causes` (candidate ids), resolved against `signals` in the
 * root's already-sorted `causes` order, so output is deterministic with no map-iteration leaks.
 */
function buildCausalChain(
  ranked: EvidenceCandidate[],
): FixContextCausalChain | null {
  const top = ranked[0];
  if (!top) return null;

  const byId = new Map<string, EvidenceCandidate>();
  for (const candidate of ranked) byId.set(candidate.id, candidate);

  let root: EvidenceCandidate | undefined;
  if (top.causalRole === "root") {
    root = top;
  } else if (top.causalRole === "symptom" && top.rootCauseId) {
    root = byId.get(top.rootCauseId);
  }
  if (!root || root.causalRole !== "root") return null;

  const causeIds = root.causes ?? [];
  const symptoms: FixContextCausalSymptom[] = [];
  for (const id of causeIds) {
    const symptom = byId.get(id);
    if (!symptom) continue;
    symptoms.push(
      removeUndefined({
        id: symptom.id,
        detector: symptom.detector,
        title: symptom.title,
        attributionConfidence: symptom.attributionConfidence,
      }) as FixContextCausalSymptom,
    );
  }
  if (symptoms.length === 0) return null;

  return {
    root: { id: root.id, detector: root.detector, title: root.title },
    symptoms,
  };
}

function resolveSessionDir(
  sessionDirOrId: string,
  opts: BuildFixContextOptions,
): string {
  return resolveSessionDirById(sessionDirOrId, opts.outputDir);
}

function buildSession(
  sessionDir: string,
  index: Record<string, unknown>,
  bundle: LlmBundle | undefined,
): FixContextSession {
  const fallbackId = path.basename(sessionDir);
  if (bundle) {
    return removeUndefined({
      id: bundle.session.id || fallbackId,
      name: bundle.session.name,
      app: bundle.session.app,
      source: bundle.session.source,
      startMs: bundle.session.startMs,
      endMs: bundle.session.endMs,
      durationMs: bundle.session.durationMs,
    }) as FixContextSession;
  }

  const start = finiteNumber(index.start) ?? 0;
  const end = finiteNumber(index.end) ?? start;
  return removeUndefined({
    id: safeString(index.id) ?? fallbackId,
    startMs: start,
    endMs: end,
    durationMs: finiteNumber(index.dur) ?? Math.max(0, end - start),
  }) as FixContextSession;
}

function buildPrimaryWindow(
  ranked: EvidenceCandidate[],
  bundle: LlmBundle | undefined,
): FixContextPrimaryWindow {
  const top = ranked[0];
  const window = top ? top.evidenceWindow : null;
  const linked: LlmBundleLinkedFullStackRequestSummary[] =
    bundle?.fullStackEvidence?.linked ?? [];

  const matched = linked.filter((entry) => {
    if (top?.anchor.requestId && entry.requestId === top.anchor.requestId)
      return true;
    const t = entry.frontend?.ref?.t;
    if (window && typeof t === "number")
      return t >= window.start && t <= window.end;
    return false;
  });

  return {
    frontend: {
      window,
      anchor: top?.anchor ?? null,
      requests: matched.map((entry) => entry.frontend),
    },
    backend: {
      requests: matched.map((entry) => entry.backend),
    },
    db_diffs: selectPrimaryWindowDbDiffs(bundle, window, top, matched),
    db_reads: selectPrimaryWindowDbReads(bundle, window, top, matched),
    db_activity: selectPrimaryWindowDbActivity(bundle, window, top, matched),
  };
}

/**
 * Selects the `db.diff` rows correlated to the primary window: those whose timestamp falls inside
 * the top candidate's evidence window, or whose `requestId` matches the anchor / a linked
 * full-stack request. Reads only the finalized bundle (never raw NDJSON).
 */
function selectPrimaryWindowDbDiffs(
  bundle: LlmBundle | undefined,
  window: { start: number; end: number } | null,
  top: EvidenceCandidate | undefined,
  matched: LlmBundleLinkedFullStackRequestSummary[],
): FixContextDbDiff[] {
  const diffs = Array.isArray(bundle?.databaseDiffs)
    ? bundle!.databaseDiffs
    : [];
  if (diffs.length === 0) return [];

  const requestIds = new Set<string>();
  if (top?.anchor.requestId) requestIds.add(top.anchor.requestId);
  for (const entry of matched) requestIds.add(entry.requestId);

  return diffs.filter((diff) => {
    if (
      window &&
      typeof diff.t === "number" &&
      diff.t >= window.start &&
      diff.t <= window.end
    )
      return true;
    return diff.requestId !== undefined && requestIds.has(diff.requestId);
  });
}

function selectPrimaryWindowDbReads(
  bundle: LlmBundle | undefined,
  window: { start: number; end: number } | null,
  top: EvidenceCandidate | undefined,
  matched: LlmBundleLinkedFullStackRequestSummary[],
): FixContextDbRead[] {
  const reads = Array.isArray(bundle?.databaseReads)
    ? bundle!.databaseReads
    : [];
  if (reads.length === 0) return [];

  const requestIds = new Set<string>();
  if (top?.anchor.requestId) requestIds.add(top.anchor.requestId);
  for (const entry of matched) requestIds.add(entry.requestId);

  return reads.filter((read) => {
    if (
      window &&
      typeof read.t === "number" &&
      read.t >= window.start &&
      read.t <= window.end
    )
      return true;
    return read.requestId !== undefined && requestIds.has(read.requestId);
  });
}

function selectPrimaryWindowDbActivity(
  bundle: LlmBundle | undefined,
  window: { start: number; end: number } | null,
  top: EvidenceCandidate | undefined,
  matched: LlmBundleLinkedFullStackRequestSummary[],
): FixContextDbActivity[] {
  const activity = Array.isArray(bundle?.databaseActivity)
    ? bundle!.databaseActivity
    : [];
  if (activity.length === 0) return [];

  const requestIds = new Set<string>();
  if (top?.anchor.requestId) requestIds.add(top.anchor.requestId);
  for (const entry of matched) requestIds.add(entry.requestId);

  return activity.filter((entry) => {
    if (
      window &&
      typeof entry.t === "number" &&
      entry.t >= window.start &&
      entry.t <= window.end
    )
      return true;
    return entry.requestId !== undefined && requestIds.has(entry.requestId);
  });
}

/**
 * Reads the redaction-aware environment snapshot from the finalized bundle (llm.json). CP3
 * env capture: returns the bundle's `environment` object when present, or `null` when no env
 * was captured (consumers MUST treat null as "not captured"). Never reads raw events here.
 */
function buildEnvironment(
  bundle: LlmBundle | undefined,
): Record<string, unknown> | null {
  const env = bundle?.environment;
  if (!isRecord(env) || Object.keys(env).length === 0) return null;
  return env;
}

function buildReproHint(
  ranked: EvidenceCandidate[],
): FixContextReproHint | null {
  const top = ranked[0];
  if (!top) return null;
  return removeUndefined({
    title: top.title,
    detector: top.detector,
    severity: top.severity,
    route: top.anchor.route,
    target: top.anchor.target,
    elementLabel: top.anchor.elementLabel,
    errorCode: top.anchor.errorCode,
    message: top.anchor.message,
    requestId: top.anchor.requestId,
    offsetMs: top.anchor.offsetMs,
  }) as FixContextReproHint;
}

function readCandidates(sessionDir: string): EvidenceCandidate[] {
  const buf = defaultSessionStore.readArtifact(sessionDir, "candidates.jsonl");
  if (!buf) return [];
  const content = buf.toString("utf-8").trim();
  if (!content) return [];
  const candidates: EvidenceCandidate[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      candidates.push(JSON.parse(trimmed) as EvidenceCandidate);
    } catch {
      // candidates.jsonl is deterministic and pre-redacted; skip any malformed line defensively.
    }
  }
  return candidates;
}

function readBundle(sessionDir: string): LlmBundle | undefined {
  const record =
    readJsonRecord(sessionDir, "llm.json") ??
    readJsonRecord(sessionDir, "bundle.json");
  return record as LlmBundle | undefined;
}

function readJsonRecord(
  sessionDir: string,
  name: string,
): Record<string, unknown> | undefined {
  try {
    const buf = defaultSessionStore.readArtifact(sessionDir, name);
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

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
