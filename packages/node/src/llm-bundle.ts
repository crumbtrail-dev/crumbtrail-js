import fs from "node:fs";
import path from "node:path";
import {
  BROWSER_REDACTION_POLICY_V2,
  CAPTURE_GAP_EVENT_KIND,
  DB_DIFF_EVENT_KIND,
  redactTokenLikeString,
  redactValue,
  type BugEvent,
  type DbEngine,
  type EnvSnapshot,
} from "crumbtrail-core";
import {
  collectInteractiveElements,
  type InteractiveElement,
} from "./interactive-elements";
import { sanitizeSelector } from "./sanitize-selector";
import { groupDistinctBugs, type DistinctBug } from "./distinct-bugs";
import { redactedNetworkBodySnippet } from "./network-body";
import type { EvidenceCandidate } from "./evidence-index";
import type { CausalConfidence } from "./causal-graph";

export const BROWSER_REDACTION_POLICY =
  "crumbtrail.browser-redaction.v1" as const;
type RedactionAction = "redacted" | "dropped" | "summarized";

const REDACTED_VALUE = "[REDACTED]";

export interface SessionIndexLike {
  id?: string;
  start?: number;
  end?: number;
  dur?: number;
  evts?: number;
  errs?: Array<{ t: number; msg: string }>;
  failedReqs?: Array<{
    t: number;
    m: string;
    url: string;
    st: number;
    id?: string | number;
    reason?: string;
    code?: string;
    message?: string;
    phase?: string;
  }>;
  networkErrors?: Array<{
    t: number;
    id?: string | number;
    m?: string;
    method?: string;
    url?: string;
    msg?: string;
    transport?: string;
    offsetMs?: number;
  }>;
  consoleErrors?: Array<{
    t: number;
    lv?: string;
    msg: string;
    source?: string;
    offsetMs?: number;
  }>;
  navs?: Array<{ t: number; to: string }>;
  stats?: Record<string, number>;
  tabBoundaries?: unknown[];
  pageProbe?: Partial<LlmBundlePageProbeSummary>;
  storageSummary?: unknown;
  redaction?: LlmBundleRedactionSummary;
  audio?: {
    artifact?: string;
    bytes?: number;
    upload?: Record<string, unknown>;
    transcription?: {
      state?: string;
      code?: string;
      message?: string;
      transcriptFile?: string;
      eventCount?: number;
    };
  };
  fullStackRequests?: unknown;
}

type LlmBundleFullStackGapKind =
  | "frontend-only"
  | "backend-only"
  | "backend-generated-request-id"
  | "backend-missing-session"
  | "backend-missing-request-id"
  | "backend-missing-session-and-request-id"
  | "client-missing-request-id";

export interface LlmBundleFullStackEventRef {
  t: number;
  iso?: string;
  offsetMs?: number;
  kind?: string;
}

export interface LlmBundleFrontendRequestEvidenceSummary {
  ref?: LlmBundleFullStackEventRef;
  requestId?: string;
  sessionId?: string;
  method?: string;
  url?: string;
  status?: number;
  durationMs?: number;
  error?: {
    message?: string;
    transport?: string;
  };
}

export interface LlmBundleBackendRequestEvidenceSummary {
  requestId?: string;
  sessionId?: string;
  correlation?: {
    status?: string;
    sessionIdSource?: string;
    requestIdSource?: string;
  };
  start?: LlmBundleFullStackEventRef;
  end?: LlmBundleFullStackEventRef;
  errorRef?: LlmBundleFullStackEventRef;
  method?: string;
  url?: string;
  pathname?: string;
  route?: string;
  statusCode?: number;
  durationMs?: number;
  error?: {
    name?: string;
    code?: string;
    message?: string;
    statusCode?: number;
  };
}

export interface LlmBundleLinkedFullStackRequestSummary {
  requestId: string;
  sessionId: string;
  frontend: LlmBundleFrontendRequestEvidenceSummary;
  backend: LlmBundleBackendRequestEvidenceSummary;
}

export interface LlmBundleFullStackRequestGapSummary {
  type: LlmBundleFullStackGapKind;
  requestId?: string;
  sessionId?: string;
  frontend?: LlmBundleFrontendRequestEvidenceSummary;
  backend?: LlmBundleBackendRequestEvidenceSummary;
}

export interface LlmBundleFullStackEvidence {
  schemaVersion: 1;
  summary: {
    frontendRequests: number;
    backendRequests: number;
    linked: number;
    gaps: number;
    gapTypes: Partial<Record<LlmBundleFullStackGapKind, number>>;
  };
  linked: LlmBundleLinkedFullStackRequestSummary[];
  gaps: LlmBundleFullStackRequestGapSummary[];
  limitations: string[];
}

export interface LlmBundleArtifact {
  path: string;
  role: "generated" | "source" | "index" | "media" | "derived" | "directory";
  description: string;
  exists: boolean;
  bytes?: number;
  entries?: number;
}

export interface LlmBundleTimelineMoment {
  t: number;
  iso?: string;
  offsetMs?: number;
  k: string;
  summary: string;
}

export interface LlmBundleDegradedCapability {
  capability: string;
  state: string;
  source: "metadata" | "event" | "post-process" | "artifact";
  code?: string;
  message?: string;
  phase?: string;
  retryable?: boolean;
  artifact?: string;
  t?: number;
  offsetMs?: number;
}

export interface LlmBundleRedactionSummary {
  policy: typeof BROWSER_REDACTION_POLICY;
  browserFirst: true;
  renderedBundleSanitization: string[];
  eventsWithRedactionEvidence: number;
  redactedFields: number;
  payloadSummaries: number;
  reasons: Record<string, number>;
  actions: Partial<Record<RedactionAction, number>>;
  notes: string[];
}

/**
 * Deterministic capture completeness summary. A session is `complete` with zero gaps. It is
 * `degraded` when at least one gap exists but both a backend request event and a database diff
 * still provide the core request to database join evidence. Every other nonzero gap state is
 * `fragmentary`, because the differentiated path has little or no join evidence.
 */
export interface LlmBundleCompleteness {
  gapCount: number;
  gapsBySurface: Record<string, number>;
  gapsByReason: Record<string, number>;
  grade: "complete" | "degraded" | "fragmentary";
}

export interface LlmBundleFailedRequestSummary {
  t: number;
  iso?: string;
  offsetMs?: number;
  method?: string;
  url?: string;
  status?: number;
  reason?: string;
  code?: string;
  message?: string;
  phase?: string;
  /** Bounded, redacted request payload evidence when it was captured. */
  requestBody?: string;
  /** Bounded, redacted response payload evidence when it was captured. */
  responseBody?: string;
  /** Number of same-signature entries this exemplar represents. Present only when >= 2. */
  count?: number;
  /** Earliest `t` across the compacted same-signature run. Present only when `count` is. */
  firstAt?: number;
  /** Latest `t` across the compacted same-signature run. Present only when `count` is. */
  lastAt?: number;
}

export interface LlmBundleNetworkErrorSummary {
  t: number;
  iso?: string;
  offsetMs?: number;
  method?: string;
  url?: string;
  message?: string;
  transport?: string;
  /** Bounded, redacted request payload evidence when it was captured. */
  requestBody?: string;
  /** Number of same-signature entries this exemplar represents. Present only when >= 2. */
  count?: number;
  /** Earliest `t` across the compacted same-signature run. Present only when `count` is. */
  firstAt?: number;
  /** Latest `t` across the compacted same-signature run. Present only when `count` is. */
  lastAt?: number;
}

export interface LlmBundleConsoleErrorSummary {
  t: number;
  iso?: string;
  offsetMs?: number;
  level: string;
  message: string;
  source?: string;
  /** Number of same-signature entries this exemplar represents. Present only when >= 2. */
  count?: number;
  /** Earliest `t` across the compacted same-signature run. Present only when `count` is. */
  firstAt?: number;
  /** Latest `t` across the compacted same-signature run. Present only when `count` is. */
  lastAt?: number;
}

export interface LlmBundlePageProbeErrorSummary {
  t: number;
  iso?: string;
  offsetMs?: number;
  phase?: string;
  message?: string;
  source?: string;
}

export interface LlmBundlePageProbeSummary {
  requested: boolean;
  readyEvents: number;
  errorEvents: number;
  frameContexts: number;
  startedContexts: number;
  limitedContexts: number;
  features: Record<string, boolean>;
  errors: LlmBundlePageProbeErrorSummary[];
  limitations: string[];
}

export interface LlmBundleTabBoundaryDecisionSummary {
  t: number;
  iso?: string;
  offsetMs?: number;
  signal?: string;
  decision?: string;
  reason?: string;
  capture?: boolean;
  nonCapture?: boolean;
  previousCapturedOrigin?: string;
  root?: LlmBundleTabBoundaryLocationSummary;
  current?: LlmBundleTabBoundaryLocationSummary;
  candidate?: LlmBundleTabBoundaryLocationSummary;
  prompt?: {
    origin?: string;
    outcome?: string;
  };
}

export interface LlmBundleTabBoundaryLocationSummary {
  origin?: string;
  host?: string;
  scheme?: string;
  valid?: boolean;
  restricted?: boolean;
  opaque?: boolean;
  isLocalhost?: boolean;
}

export interface LlmBundleTabBoundarySummary {
  total: number;
  decisionCounts: Record<string, number>;
  nonCaptureCount: number;
  decisions: LlmBundleTabBoundaryDecisionSummary[];
}

export interface LlmBundleBrowserEvidence {
  pageProbe: LlmBundlePageProbeSummary;
  failedRequests: LlmBundleFailedRequestSummary[];
  networkErrors: LlmBundleNetworkErrorSummary[];
  consoleErrors: LlmBundleConsoleErrorSummary[];
  tabBoundaries: LlmBundleTabBoundarySummary;
  interactiveElements: InteractiveElement[];
}

export const AGENT_CONTEXT_SCHEMA_VERSION =
  "crumbtrail.agent_context.v1" as const;

export interface LlmBundleAgentContextTimelineEntry {
  t: number;
  iso?: string;
  offsetMs?: number;
  kind:
    "navigation" | "error" | "failed-request" | "click" | "input" | "key-count";
  summary: string;
  target?: string;
  field?: string;
  count?: number;
  requestBody?: string;
  responseBody?: string;
}

export interface LlmBundleAgentContext {
  schemaVersion: typeof AGENT_CONTEXT_SCHEMA_VERSION;
  timeline: LlmBundleAgentContextTimelineEntry[];
}

/**
 * Merged, redaction-aware environment snapshot surfaced from the session's `k:'env'` events
 * (initial snapshot + any `setEnv` deltas). Device fields are best-effort; `flags`/`config`
 * were redacted in the browser before capture. `null` when no env was captured.
 */
export interface LlmBundleEnvironment {
  userAgent?: string;
  browser?: { name: string; version?: string };
  os?: string;
  viewport?: { w: number; h: number };
  locale?: string;
  timezone?: string;
  flags?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

/**
 * Redaction-aware summary of one `k:'db.diff'` event (a row that changed during a request),
 * correlated to the request via `requestId`. CP5 DB diffing. Sensitive columns were dropped in the
 * shim; bundle build re-runs the redaction policy as defense-in-depth.
 */
export interface LlmBundleDbDiff {
  t: number;
  iso?: string;
  offsetMs?: number;
  engine: DbEngine;
  op: "insert" | "update" | "delete";
  table: string;
  pk: Record<string, unknown> | null;
  after?: Record<string, unknown>;
  before?: Record<string, unknown>;
  /**
   * Only set on an image-less statement-level fallback event (`pk: null`, no `after`/`before`)
   * where per-row images were unobtainable — records how many rows the statement changed so the
   * write stays visible to differencing.
   */
  rowCount?: number;
  requestId?: string;
}

export interface LlmBundleDbRead {
  t: number;
  iso?: string;
  offsetMs?: number;
  engine: DbEngine;
  table: string;
  pk: Record<string, unknown> | null;
  row: Record<string, unknown>;
  requestId?: string;
}

export interface LlmBundleDbActivity {
  t: number;
  iso?: string;
  offsetMs?: number;
  evidenceType: "otel_db_activity_statements_not_row_diffs";
  system?: string;
  operation?: string;
  statement?: string;
  spanName?: string;
  serviceName?: string;
  requestId?: string;
  upgradeHint: string;
}

export interface LlmBundle {
  schemaVersion: 1;
  kind: "crumbtrail.agent-session-bundle";
  generatedAt: number;
  generatedAtIso: string;
  /**
   * Earliest error-class evidence timestamp (ms) available at build time: failed requests,
   * network errors, console errors, and runtime errors from the index. Omitted entirely when
   * the session produced no error-class events.
   */
  firstErrorEventAt?: number;
  /**
   * Self-measured detect-to-bundle latency: `generatedAt - firstErrorEventAt`, clamped to >= 0.
   * Omitted whenever {@link LlmBundle.firstErrorEventAt} is omitted.
   */
  detectToBundleMs?: number;
  sessionDir: string;
  session: {
    id: string;
    name?: string;
    source?: string;
    app?: string;
    startMs: number;
    startIso?: string;
    endMs: number;
    endIso?: string;
    durationMs: number;
    metadata: Record<string, unknown>;
  };
  artifacts: LlmBundleArtifact[];
  eventCounts: Record<string, number>;
  keyTimelineMoments: LlmBundleTimelineMoment[];
  /** Compact, action-oriented context for coding agents. */
  agentContext: LlmBundleAgentContext;
  browserEvidence: LlmBundleBrowserEvidence;
  fullStackEvidence: LlmBundleFullStackEvidence;
  /**
   * Deterministic within-session grouping of detector signals into DISTINCT labeled bugs.
   * `[]` when no signals were detected. See {@link DistinctBug}.
   */
  distinctBugs: DistinctBug[];
  /** Redaction-aware environment snapshot for the session, or `null` when none was captured. */
  environment: LlmBundleEnvironment | null;
  /**
   * Root → symptom causal tree projected from detector signals' CP3 causal fields. Additive
   * and optional: absent when no candidate carries `causalRole: 'root'` with attributed symptoms.
   * Consumers MUST NOT treat its absence as "no bug"; it only means no root→symptom structure was
   * surfaced. Never recomputes attribution — a pure projection of `candidates`.
   */
  causalTree?: LlmBundleCausalRoot[];
  /** Redaction-aware row diffs captured during the session (`k:'db.diff'`); `[]` when none. */
  databaseDiffs: LlmBundleDbDiff[];
  /** Redaction-aware rows read during the session (`k:'db.read'`); `[]` when none. */
  databaseReads: LlmBundleDbRead[];
  /** OTel DB spans/statements (`db.*` attributes), explicitly not row diffs. */
  databaseActivity: LlmBundleDbActivity[];
  media: {
    alignment: {
      sessionStartMs: number;
      rules: string[];
    };
    video: MediaArtifactSummary;
    audio: MediaArtifactSummary & {
      upload?: Record<string, unknown>;
      transcription?: Record<string, unknown>;
    };
    transcript: MediaArtifactSummary & { eventCount: number };
    voiceMarkers: Array<{
      t: number;
      iso?: string;
      offsetMs?: number;
      label?: string;
      markerId?: string;
    }>;
  };
  degradedCapabilities: LlmBundleDegradedCapability[];
  /** Completeness contract derived only from the session's `capture_gap` events. */
  completeness: LlmBundleCompleteness;
  redaction: LlmBundleRedactionSummary;
  limitations: string[];
  inspectionGuide: Array<{ step: number; path: string; purpose: string }>;
}

/** A downstream symptom nested under a root in {@link LlmBundleCausalRoot}. */
export interface LlmBundleCausalSymptom {
  id: string;
  detector: string;
  title: string;
  attributionConfidence?: CausalConfidence;
}

/** A root cause with its nested symptoms, built from detector signal causal fields (CP4). */
export interface LlmBundleCausalRoot {
  id: string;
  detector: string;
  title: string;
  symptoms: LlmBundleCausalSymptom[];
}

interface MediaArtifactSummary {
  path: string;
  exists: boolean;
  bytes?: number;
  eventCount: number;
  firstState?: string;
  lastState?: string;
}

export interface WriteLlmBundleInput {
  sessionDir: string;
  events: BugEvent[];
  index: SessionIndexLike;
  /** Ranked evidence candidates for the session; grouped into `distinctBugs`. Defaults to `[]`. */
  candidates?: EvidenceCandidate[];
}

interface RedactionAccumulator {
  eventsWithRedactionEvidence: number;
  redactedFields: number;
  payloadSummaries: number;
  reasons: Record<string, number>;
  actions: Partial<Record<RedactionAction, number>>;
}

const KNOWN_ARTIFACTS: Array<{
  path: string;
  role: LlmBundleArtifact["role"];
  description: string;
  generated?: boolean;
}> = [
  {
    path: "CANDIDATES.md",
    role: "generated",
    description:
      "Primary deterministic ranked issue list; start here before raw replay artifacts.",
    generated: true,
  },
  {
    path: "candidates.jsonl",
    role: "generated",
    description:
      "Machine-readable normalized candidate rows with schemaVersion and stable candidate IDs.",
    generated: true,
  },
  {
    path: "timeline.md",
    role: "generated",
    description: "Five-minute bucketed session map for long recordings.",
    generated: true,
  },
  {
    path: "search.jsonl",
    role: "generated",
    description:
      "Redacted normalized grep friendly search corpus linked to detector signals.",
    generated: true,
  },
  {
    path: "windows",
    role: "directory",
    description: "Focused markdown evidence windows, one per candidate.",
    generated: true,
  },
  {
    path: "manifest.json",
    role: "index",
    description:
      "Hot-plane session manifest for ranked, bounded agent retrieval.",
    generated: true,
  },
  {
    path: "bundle.json",
    role: "generated",
    description: "V2 alias for the machine-readable agent bundle.",
    generated: true,
  },
  {
    path: "opinion.md",
    role: "generated",
    description:
      "Optional LLM produced opinion generated only when explicitly opted in.",
    generated: true,
  },
  {
    path: "opinion.json",
    role: "generated",
    description:
      "Machine readable optional LLM produced opinion generated only when explicitly opted in.",
    generated: true,
  },
  {
    path: "opinion.audit.json",
    role: "generated",
    description:
      "Audit record of the redacted evidence bundle and prompt sent for the optional opinion.",
    generated: true,
  },
  {
    path: "llm.md",
    role: "generated",
    description:
      "Human-readable guide for a future agent inspecting this session.",
    generated: true,
  },
  {
    path: "llm.json",
    role: "generated",
    description: "Machine-readable version of the agent inspection guide.",
    generated: true,
  },
  {
    path: "meta.json",
    role: "source",
    description: "Session metadata written by the local server.",
  },
  {
    path: "index.json",
    role: "index",
    description:
      "Post-processed event counts, navigation, failures, storage, and audio summary.",
  },
  {
    path: "events.ndjson",
    role: "source",
    description:
      "Raw timestamped event stream; inspect after reading the summaries and redaction notes.",
  },
  {
    path: "events.ndjson.zst",
    role: "source",
    description:
      "Cold-plane zstd-compressed, redaction-sanitized event stream generated at finalize.",
  },
  {
    path: "signatures.json",
    role: "index",
    description:
      "Cold-plane component signature dictionary used to deduplicate repeated element descriptors.",
  },
  {
    path: "capture-truncated.json",
    role: "index",
    description: "Session byte-cap marker written when capture stops early.",
  },
  {
    path: "recording.webm",
    role: "media",
    description: "Active-tab video recording, if video capture succeeded.",
  },
  {
    path: "audio.webm",
    role: "media",
    description:
      "Continuous microphone audio or voice-note-compatible audio, if captured.",
  },
  {
    path: "audio.json",
    role: "source",
    description: "Safe upload metadata for audio.webm.",
  },
  {
    path: "transcript.json",
    role: "derived",
    description: "Local speech-to-text output, if transcription succeeded.",
  },
  {
    path: "voice.webm",
    role: "media",
    description: "Legacy bug voice-note artifact, if present.",
  },
  {
    path: "frames",
    role: "directory",
    description: "Frame stills directory used by older snapshot/MCP workflows.",
  },
];

const IMPORTANT_EVENT_KINDS = new Set([
  "session.lifecycle",
  "nav",
  "tab.boundary",
  "err",
  "rej",
  "clk",
  "inp",
  "snap",
  "con",
  "probe.ready",
  "probe.error",
  "frame.ctx",
  "net.err",
  "perf",
  "media.video",
  "media.voice",
]);

export function writeLlmBundle(input: WriteLlmBundleInput): LlmBundle {
  const bundle = buildLlmBundle(input);
  const markdown = renderLlmMarkdown(bundle);

  fs.writeFileSync(path.join(input.sessionDir, "llm.md"), markdown);
  fs.writeFileSync(
    path.join(input.sessionDir, "llm.json"),
    `${JSON.stringify(bundle, null, 2)}\n`,
  );

  return bundle;
}

export function buildLlmBundle({
  sessionDir,
  events,
  index,
  candidates,
}: WriteLlmBundleInput): LlmBundle {
  const meta = readJsonRecord(path.join(sessionDir, "meta.json")) ?? {};
  const generatedAt = Date.now();
  const session = buildSessionSummary(sessionDir, meta, index, events);
  const artifacts = KNOWN_ARTIFACTS.map((artifact) =>
    describeArtifact(sessionDir, artifact),
  );
  const redaction = summarizeRedaction(events);
  const completeness = buildCompleteness(events);
  const degradedCapabilities = buildDegradedCapabilities(
    sessionDir,
    meta,
    index,
    events,
  );
  const browserEvidence = buildBrowserEvidence(index, events, session.startMs);
  const fullStackEvidence = buildFullStackEvidence(index, session.startMs);
  const media = buildMediaSummary(sessionDir, index, events, session.startMs);
  const limitations = buildLimitations(
    artifacts,
    events,
    redaction,
    degradedCapabilities,
    index,
    meta,
    browserEvidence,
    fullStackEvidence,
  );
  const causalTree = buildCausalTree(candidates ?? []);
  const firstErrorEventAt = computeFirstErrorEventAt(browserEvidence, index);

  return {
    schemaVersion: 1,
    kind: "crumbtrail.agent-session-bundle",
    generatedAt,
    generatedAtIso: iso(generatedAt) ?? new Date(generatedAt).toISOString(),
    // B5 self-measurement: both keys are omitted entirely when the session had no
    // error-class events (spread-conditional, matching the causalTree pattern below).
    ...(firstErrorEventAt !== undefined
      ? {
          firstErrorEventAt,
          detectToBundleMs: Math.max(0, generatedAt - firstErrorEventAt),
        }
      : {}),
    sessionDir: path.resolve(sessionDir),
    session,
    artifacts,
    eventCounts: stableStats(index.stats, events),
    keyTimelineMoments: buildKeyTimelineMoments(events, index, session.startMs),
    agentContext: buildAgentContext(events, index, session.startMs),
    browserEvidence,
    fullStackEvidence,
    distinctBugs: applyFlagNoteTitles(
      groupDistinctBugs(candidates ?? [], events),
      events,
    ),
    environment: buildEnvironment(events),
    ...(causalTree.length > 0 ? { causalTree } : {}),
    databaseDiffs: buildDatabaseDiffs(events, session.startMs),
    databaseReads: buildDatabaseReads(events, session.startMs),
    databaseActivity: buildDatabaseActivity(events, session.startMs),
    media,
    degradedCapabilities,
    completeness,
    redaction,
    limitations,
    inspectionGuide: buildInspectionGuide(artifacts),
  };
}

function buildCompleteness(events: BugEvent[]): LlmBundleCompleteness {
  const gapsBySurface: Record<string, number> = {};
  const gapsByReason: Record<string, number> = {};
  let gapCount = 0;

  for (const event of events) {
    if (event.k !== CAPTURE_GAP_EVENT_KIND) continue;
    gapCount += 1;
    const payload = isRecord(event.d) ? event.d : {};
    const surface =
      typeof payload.surface === "string" ? payload.surface : "unknown";
    const reason =
      typeof payload.reason === "string" ? payload.reason : "unknown";
    gapsBySurface[surface] = (gapsBySurface[surface] ?? 0) + 1;
    gapsByReason[reason] = (gapsByReason[reason] ?? 0) + 1;
  }

  const hasBackendEvidence = events.some((event) =>
    event.k.startsWith("backend.req."),
  );
  const hasDbDiffEvidence = events.some(
    (event) => event.k === DB_DIFF_EVENT_KIND,
  );
  const grade =
    gapCount === 0
      ? "complete"
      : hasBackendEvidence && hasDbDiffEvidence
        ? "degraded"
        : "fragmentary";

  return { gapCount, gapsBySurface, gapsByReason, grade };
}

/**
 * B5: earliest error-class evidence timestamp available at bundle-build time. Sources are the
 * already-built browser evidence summaries (a compacted exemplar carries its run's earliest
 * time in `firstAt`) plus runtime errors from the session index. Returns `undefined` when the
 * session produced no error-class events so the bundle omits the latency fields entirely.
 */
function computeFirstErrorEventAt(
  browserEvidence: LlmBundleBrowserEvidence,
  index: SessionIndexLike,
): number | undefined {
  let first: number | undefined;
  const consider = (value: number | undefined) => {
    if (value === undefined || !Number.isFinite(value)) return;
    if (first === undefined || value < first) first = value;
  };

  for (const entry of browserEvidence.failedRequests)
    consider(entry.firstAt ?? entry.t);
  for (const entry of browserEvidence.networkErrors)
    consider(entry.firstAt ?? entry.t);
  for (const entry of browserEvidence.consoleErrors)
    consider(entry.firstAt ?? entry.t);
  for (const entry of index.errs ?? []) consider(finiteNumber(entry?.t));

  return first;
}

/** Marker emitted by evidence detectors when an anchoring error's message was redacted away. */
const DEGRADED_TITLE_MARKER = "message unavailable";

/**
 * Replace degraded distinct-bug titles with the user's own `bug.flag` note when one exists
 * inside the bug's evidence window.
 *
 * When redaction empties the anchoring error's message, detector titles collapse to
 * placeholders like "Uncaught error: message unavailable". A user-authored flag note (which
 * survives redaction) is the best available human title for that bug, so it wins — but ONLY
 * for degraded titles; a real error message always beats the note. `representative` is left
 * untouched so the underlying evidence stays verbatim. Pure and deterministic: no flag events
 * (or no degraded titles) means the input is returned unchanged, and ties on distance to
 * `firstSeen` resolve to the earliest event in stream order.
 */
function applyFlagNoteTitles(
  bugs: DistinctBug[],
  events: BugEvent[],
): DistinctBug[] {
  if (bugs.length === 0) return bugs;

  const flagNotes: Array<{ t: number; note: string }> = [];
  for (const event of events) {
    if (event.k !== "bug.flag") continue;
    const note = event.d?.note;
    if (typeof note !== "string" || note.trim().length === 0) continue;
    const t = finiteNumber(event.t);
    if (t === undefined) continue;
    flagNotes.push({ t, note });
  }
  if (flagNotes.length === 0) return bugs;

  return bugs.map((bug) => {
    if (!bug.title.includes(DEGRADED_TITLE_MARKER)) return bug;

    let closest: { t: number; note: string } | undefined;
    for (const flag of flagNotes) {
      if (flag.t < bug.window.start || flag.t > bug.window.end) continue;
      if (
        closest === undefined ||
        Math.abs(flag.t - bug.firstSeen) < Math.abs(closest.t - bug.firstSeen)
      ) {
        closest = flag;
      }
    }
    if (closest === undefined) return bug;

    const title = safeText(closest.note, 100);
    if (title === undefined) return bug;
    return { ...bug, title };
  });
}

function buildSessionSummary(
  sessionDir: string,
  meta: Record<string, unknown>,
  index: SessionIndexLike,
  events: BugEvent[],
): LlmBundle["session"] {
  const firstEventTime =
    events.length > 0 ? finiteNumber(events[0].t) : undefined;
  const lastEventTime =
    events.length > 0 ? finiteNumber(events[events.length - 1].t) : undefined;
  const startMs =
    finiteNumber(index.start) ??
    finiteNumber(meta.start) ??
    firstEventTime ??
    0;
  const endMs =
    finiteNumber(index.end) ??
    finiteNumber(meta.end) ??
    lastEventTime ??
    startMs;
  const durationMs = finiteNumber(index.dur) ?? Math.max(0, endMs - startMs);

  return removeUndefined({
    id:
      safeText(meta.id, 120) ??
      safeText(index.id, 120) ??
      path.basename(sessionDir),
    name: safeText(meta.name, 160),
    source: safeText(meta.source, 120),
    app: safeText(meta.app, 120),
    startMs,
    startIso: iso(startMs),
    endMs,
    endIso: iso(endMs),
    durationMs,
    metadata: buildMetadataSummary(meta),
  });
}

function buildMetadataSummary(
  meta: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  copySafeString(out, meta, "source");
  copySafeString(out, meta, "name");
  copySafeString(out, meta, "app");
  copySafeUrl(out, meta, "url");
  copySafeUrl(out, meta, "rootUrl");
  copySafeString(out, meta, "rootOrigin");
  copySafeNumber(out, meta, "startedAt");
  copySafeNumber(out, meta, "end");

  const capabilities = sanitizeBooleanRecord(meta.capabilities);
  if (capabilities) out.capabilities = capabilities;

  const collection = sanitizeCollection(meta.collection);
  if (collection) out.collection = collection;

  const degradedCollection = stringArray(meta.degradedCollection, 80);
  if (degradedCollection.length > 0)
    out.degradedCollection = degradedCollection;

  const allowedOrigins = stringArray(meta.allowedOrigins, 240).map(
    (origin) => safeUrl(origin, "metadata.allowedOrigins") ?? origin,
  );
  if (allowedOrigins.length > 0) out.allowedOrigins = allowedOrigins;

  const tabBoundary = sanitizeTabBoundary(meta.tabBoundary);
  if (tabBoundary) out.tabBoundary = tabBoundary;

  out.metadataKeys = Object.keys(meta).sort();

  return out;
}

function sanitizeCollection(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue;
    const entry = removeUndefined({
      enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
      degraded: typeof raw.degraded === "boolean" ? raw.degraded : undefined,
      reason: safeText(raw.reason, 120),
      source: safeText(raw.source, 80),
      redaction: safeText(raw.redaction, 120),
    });
    if (Object.keys(entry).length > 0) out[key] = entry;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeTabBoundary(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const out = removeUndefined({
    enabled: typeof value.enabled === "boolean" ? value.enabled : undefined,
    eventKind: safeText(value.eventKind, 80),
    redaction: safeText(value.redaction, 120),
    rootOrigin: safeText(value.rootOrigin, 240),
    allowedOrigins: stringArray(value.allowedOrigins, 240).map(
      (origin) =>
        safeUrl(origin, "metadata.tabBoundary.allowedOrigins") ?? origin,
    ),
  });

  return Object.keys(out).length > 0 ? out : undefined;
}

function describeArtifact(
  sessionDir: string,
  artifact: {
    path: string;
    role: LlmBundleArtifact["role"];
    description: string;
    generated?: boolean;
  },
): LlmBundleArtifact {
  const artifactPath = path.join(sessionDir, artifact.path);
  if (fs.existsSync(artifactPath)) {
    const stat = fs.statSync(artifactPath);
    return removeUndefined({
      path: artifact.path,
      role: artifact.role,
      description: artifact.description,
      exists: true,
      bytes: stat.isFile() ? stat.size : undefined,
      entries: stat.isDirectory()
        ? fs.readdirSync(artifactPath).length
        : undefined,
    });
  }

  return {
    path: artifact.path,
    role: artifact.role,
    description: artifact.description,
    exists: artifact.generated === true,
  };
}

function stableStats(
  indexStats: Record<string, number> | undefined,
  events: BugEvent[],
): Record<string, number> {
  const stats =
    indexStats ??
    events.reduce<Record<string, number>>((acc, event) => {
      acc[event.k] = (acc[event.k] ?? 0) + 1;
      return acc;
    }, {});

  return Object.fromEntries(
    Object.entries(stats).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function buildKeyTimelineMoments(
  events: BugEvent[],
  index: SessionIndexLike,
  sessionStartMs: number,
): LlmBundleTimelineMoment[] {
  const moments: LlmBundleTimelineMoment[] = [];

  for (const event of events) {
    const summary = summarizeEvent(event, index);
    if (!summary) continue;
    moments.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        k: event.k,
        summary,
      }),
    );
  }

  if (
    events.length > 0 &&
    !moments.some(
      (moment) => moment.t === events[0].t && moment.k === events[0].k,
    )
  ) {
    const first = events[0];
    moments.unshift(
      removeUndefined({
        t: first.t,
        iso: iso(first.t),
        offsetMs:
          finiteNumber(first.offsetMs) ??
          offsetFromStart(first.t, sessionStartMs),
        k: first.k,
        summary: `first recorded event (${first.k})`,
      }),
    );
  }

  const last = events[events.length - 1];
  if (
    last &&
    !moments.some((moment) => moment.t === last.t && moment.k === last.k)
  ) {
    moments.push(
      removeUndefined({
        t: last.t,
        iso: iso(last.t),
        offsetMs:
          finiteNumber(last.offsetMs) ??
          offsetFromStart(last.t, sessionStartMs),
        k: last.k,
        summary: `last recorded event (${last.k})`,
      }),
    );
  }

  return moments.sort((a, b) => a.t - b.t).slice(0, 40);
}

const AGENT_CONTEXT_MAX_TIMELINE_ENTRIES = 80;
const AGENT_CONTEXT_MAX_INTERACTION_ENTRIES = 40;

function buildAgentContext(
  events: BugEvent[],
  index: SessionIndexLike,
  sessionStartMs: number,
): LlmBundleAgentContext {
  const timeline: LlmBundleAgentContextTimelineEntry[] = [];
  let keyCount = 0;
  let lastKeyEvent: BugEvent | undefined;

  for (const event of events) {
    if (event.k === "key") {
      keyCount += 1;
      lastKeyEvent = event;
      continue;
    }

    const base = {
      t: event.t,
      iso: iso(event.t),
      offsetMs:
        finiteNumber(event.offsetMs) ??
        offsetFromStart(event.t, sessionStartMs),
    };

    if (event.k === "nav") {
      timeline.push(
        removeUndefined({
          ...base,
          kind: "navigation" as const,
          summary: summarizeEvent(event, index) ?? "navigation captured",
        }),
      );
      continue;
    }

    if (event.k === "clk") {
      const target = interactionIdentifier(event);
      timeline.push(
        removeUndefined({
          ...base,
          kind: "click" as const,
          target,
          summary: target ? `click ${target}` : "click captured",
        }),
      );
      continue;
    }

    if (event.k === "inp") {
      const field = interactionIdentifier(event);
      timeline.push(
        removeUndefined({
          ...base,
          kind: "input" as const,
          field,
          summary: field
            ? `input ${field}; value redacted`
            : "input captured; value redacted",
        }),
      );
      continue;
    }

    if (event.k === "net.res" && isFailedNetworkResponse(event)) {
      const request = requestForNetworkEvent(events, event);
      timeline.push(
        removeUndefined({
          ...base,
          kind: "failed-request" as const,
          summary: summarizeEvent(event, index) ?? "failed request",
          requestBody: request
            ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
            : undefined,
          responseBody: redactedNetworkBodySnippet(
            event.d.body,
            event.d.bodySummary,
          ),
        }),
      );
      continue;
    }

    if (event.k === "net.err") {
      const request = requestForNetworkEvent(events, event);
      timeline.push(
        removeUndefined({
          ...base,
          kind: "failed-request" as const,
          summary: summarizeEvent(event, index) ?? "network request error",
          requestBody: request
            ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
            : undefined,
        }),
      );
      continue;
    }

    if (isAgentContextError(event)) {
      const summary = summarizeEvent(event, index);
      if (summary) timeline.push({ ...base, kind: "error", summary });
    }
  }

  if (lastKeyEvent) {
    timeline.push(
      removeUndefined({
        t: lastKeyEvent.t,
        iso: iso(lastKeyEvent.t),
        offsetMs:
          finiteNumber(lastKeyEvent.offsetMs) ??
          offsetFromStart(lastKeyEvent.t, sessionStartMs),
        kind: "key-count" as const,
        count: keyCount,
        summary: `${keyCount} keystroke${keyCount === 1 ? "" : "s"} captured; values redacted`,
      }),
    );
  }

  return {
    schemaVersion: AGENT_CONTEXT_SCHEMA_VERSION,
    timeline: boundAgentContextTimeline(timeline),
  };
}

function isAgentContextError(event: BugEvent): boolean {
  if (event.k === "err" || event.k === "rej" || event.k === "probe.error")
    return true;
  return (
    event.k === "con" &&
    ["err", "error"].includes(consoleLevel(event.d.lv) ?? "")
  );
}

function interactionIdentifier(event: BugEvent): string | undefined {
  if (!isRecord(event.d.el)) return undefined;
  const element = event.d.el;
  const selector =
    sanitizeSelector(element.path) ??
    sanitizeSelector(element.selector) ??
    sanitizeSelector(element.sig) ??
    sanitizeSelector(element.name, 120) ??
    sanitizeSelector(element.id, 120);
  return selector ? safeText(selector, 240) : undefined;
}

function boundAgentContextTimeline(
  timeline: LlmBundleAgentContextTimelineEntry[],
): LlmBundleAgentContextTimelineEntry[] {
  if (timeline.length <= AGENT_CONTEXT_MAX_TIMELINE_ENTRIES)
    return timeline.sort((a, b) => a.t - b.t);

  const interactions = timeline
    .filter((entry) => ["click", "input", "key-count"].includes(entry.kind))
    .slice(-AGENT_CONTEXT_MAX_INTERACTION_ENTRIES);
  const nonInteractions = timeline
    .filter((entry) => !["click", "input", "key-count"].includes(entry.kind))
    .slice(-(AGENT_CONTEXT_MAX_TIMELINE_ENTRIES - interactions.length));
  return [...nonInteractions, ...interactions].sort((a, b) => a.t - b.t);
}

function summarizeEvent(
  event: BugEvent,
  index: SessionIndexLike,
): string | undefined {
  const d = event.d;
  if (!IMPORTANT_EVENT_KINDS.has(event.k) && !isFailedNetworkResponse(event))
    return undefined;

  if (event.k === "session.lifecycle") {
    const action = safeText(d.action, 80) ?? "lifecycle";
    const reason = safeText(d.reason, 80);
    const root =
      safeUrl(d.rootUrl, "event.session.lifecycle.rootUrl") ??
      safeText(d.rootOrigin, 180);
    return joinParts([
      `session ${action}`,
      reason ? `reason ${reason}` : undefined,
      root ? `root ${root}` : undefined,
    ]);
  }

  if (event.k === "nav") {
    const to =
      safeUrl(d.to, "event.nav.to") ??
      safeText(d.to, 180) ??
      "unknown destination";
    return `navigation to ${to}`;
  }

  if (event.k === "tab.boundary") {
    if (!isRecord(d)) return "tab boundary event with malformed metadata";
    const decision = safeText(d.decision, 80) ?? "boundary decision";
    const reason = safeText(d.reason, 80);
    const candidate = isRecord(d.candidate)
      ? (safeOrigin(d.candidate.origin) ??
        safeOrigin(d.candidate.url) ??
        safeHost(d.candidate.host) ??
        safeText(d.candidate.scheme, 80))
      : undefined;
    return joinParts([
      `tab boundary ${decision}`,
      reason,
      candidate ? `candidate ${candidate}` : undefined,
    ]);
  }

  if (event.k === "probe.ready") {
    const features = isRecord(d.features)
      ? Object.entries(d.features)
          .filter(([, enabled]) => typeof enabled === "boolean" && enabled)
          .map(([name]) => safeText(name, 40))
          .filter((name): name is string => name !== undefined)
          .slice(0, 6)
          .join(", ")
      : undefined;
    return joinParts([
      "page probe ready",
      features ? `features ${features}` : undefined,
    ]);
  }

  if (event.k === "probe.error") {
    const phase = safeText(d.phase, 80);
    const message = safeText(d.message, 180) ?? "message unavailable";
    return joinParts([
      "page probe error",
      phase ? `phase ${phase}` : undefined,
      message,
    ]);
  }

  if (event.k === "frame.ctx") {
    const pageProbe = isRecord(d.pageProbe) ? d.pageProbe : undefined;
    if (!pageProbe) return "frame context captured";
    const requested =
      pageProbe.requested === true ? "requested" : "not requested";
    const started = pageProbe.started === true ? "started" : "not started";
    const reason = safeText(pageProbe.reason, 120);
    return joinParts([
      `page probe ${requested}`,
      started,
      pageProbe.limited === true ? "limited" : undefined,
      reason,
    ]);
  }

  if (event.k === "con") {
    const level = consoleLevel(d.lv);
    if (level !== "err" && level !== "error") return undefined;
    return `console error: ${consoleMessageFromPayload(d) ?? "message unavailable"}`;
  }

  if (event.k === "net.err") {
    const method = safeText(d.method, 20) ?? safeText(d.m, 20);
    const url = safeUrl(d.url, "event.net.err.url");
    const message = safeText(d.msg, 180);
    return joinParts(["network request error", method, url, message]);
  }

  if (event.k === "err" || event.k === "rej") {
    const msg = safeText(d.msg, 180) ?? "message unavailable";
    return `${event.k === "err" ? "error" : "rejection"}: ${msg}`;
  }

  if (event.k === "clk") {
    return "user click captured; inspect event descriptor for selectors and element context";
  }

  if (event.k === "inp") {
    return "user input captured; raw values are not repeated in this bundle";
  }

  if (event.k === "perf") {
    const metric =
      safeText(d.metric, 40) ?? safeText(d.entryType, 40) ?? "performance";
    const name = safeUrl(d.name, "event.perf.name") ?? safeText(d.name, 120);
    const duration = finiteNumber(d.duration);
    return joinParts([
      `performance ${metric}`,
      name,
      duration !== undefined ? `${duration} ms` : undefined,
    ]);
  }

  if (event.k === "snap") {
    return "storage/cookie snapshot summarized in index.json; raw values are not repeated in this bundle";
  }

  if (event.k === "media.video" || event.k === "media.voice") {
    const capability =
      safeText(d.capability, 80) ??
      (event.k === "media.video" ? "video" : "audio");
    const state = safeText(d.state, 80) ?? "status";
    const code = safeText(d.code, 80);
    const label =
      event.k === "media.voice" && d.state === "marker-added"
        ? safeText(d.label, 120)
        : undefined;
    return joinParts([
      `${capability} ${state}`,
      code ? `code ${code}` : undefined,
      label ? `marker ${label}` : undefined,
    ]);
  }

  if (event.k === "net.res" && isFailedNetworkResponse(event)) {
    const failedReq = findFailedRequest(index, event);
    const url = failedReq
      ? safeUrl(failedReq.url, "index.failedReqs.url")
      : undefined;
    const reason = safeText(failedReq?.reason, 80);
    const code = safeText(failedReq?.code, 120);
    const message = safeText(failedReq?.message, 160);
    return joinParts([
      reason === "application_failure"
        ? `application failure response (${String(d.st)})`
        : `HTTP ${String(d.st)} response`,
      failedReq?.m ? failedReq.m : undefined,
      url,
      code,
      message,
    ]);
  }

  return undefined;
}

function findFailedRequest(
  index: SessionIndexLike,
  event: BugEvent,
):
  | {
      t: number;
      m: string;
      url: string;
      st: number;
      reason?: string;
      code?: string;
      message?: string;
      phase?: string;
    }
  | undefined {
  const failedReqs = Array.isArray(index.failedReqs) ? index.failedReqs : [];
  return failedReqs.find((req) => req.t === event.t && req.st === event.d.st);
}

function isFailedNetworkResponse(event: BugEvent): boolean {
  return (
    event.k === "net.res" &&
    ((typeof event.d.st === "number" && event.d.st >= 400) ||
      summarizeApplicationFailure(event) !== undefined)
  );
}

function buildBrowserEvidence(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleBrowserEvidence {
  return {
    pageProbe: buildPageProbeSummary(index, events, sessionStartMs),
    failedRequests: buildFailedRequestSummaries(index, events, sessionStartMs),
    networkErrors: buildNetworkErrorSummaries(index, events, sessionStartMs),
    consoleErrors: buildConsoleErrorSummaries(index, events, sessionStartMs),
    tabBoundaries: buildTabBoundarySummary(index, events, sessionStartMs),
    interactiveElements: collectInteractiveElements(events),
  };
}

function buildEnvironment(events: BugEvent[]): LlmBundleEnvironment | null {
  const envEvents = events.filter((event) => event.k === "env");
  if (envEvents.length === 0) return null;

  // The initial snapshot carries device fields; later `setEnv` deltas only add flags/config.
  const base = (
    envEvents.find(
      (event) => (event.d as Partial<EnvSnapshot>).kind === "snapshot",
    ) ?? envEvents[0]
  ).d as Partial<EnvSnapshot>;

  const environment: LlmBundleEnvironment = removeUndefined({
    userAgent: safeText(base.userAgent, 400),
    browser: sanitizeBrowser(base.browser),
    os: safeText(base.os, 60),
    viewport: sanitizeViewport(base.viewport),
    locale: safeText(base.locale, 60),
    timezone: safeText(base.timezone, 80),
  });

  // Merge flags/config across the snapshot and every delta, preserving last-write-wins order.
  const flags: Record<string, unknown> = {};
  const config: Record<string, unknown> = {};
  let hasFlags = false;
  let hasConfig = false;
  for (const event of envEvents) {
    const d = event.d as Partial<EnvSnapshot>;
    if (isRecord(d.flags)) {
      Object.assign(flags, d.flags);
      hasFlags = true;
    }
    if (isRecord(d.config)) {
      Object.assign(config, d.config);
      hasConfig = true;
    }
  }
  // Defense-in-depth: flags/config are redacted in the browser, but re-run the redaction path
  // at bundle time so secret-looking values can never rest in the bundle even if a raw event
  // slipped through.
  if (hasFlags)
    environment.flags = redactValue(flags, "environment.flags").value;
  if (hasConfig)
    environment.config = redactValue(config, "environment.config").value;

  return environment;
}

/**
 * Projects a root → symptom causal tree from detector signal CP3 causal fields (`causalRole`,
 * `causes`, `attributionConfidence`). Pure and deterministic: never recomputes attribution.
 *
 * Ordering is stable and independent of map-iteration order: roots preserve the candidates' ranked
 * (root-first) file order; each root's symptoms follow that root's already-sorted `causes` list.
 * Returns `[]` when no candidate is a root with attributed symptoms.
 */
function buildCausalTree(
  candidates: EvidenceCandidate[],
): LlmBundleCausalRoot[] {
  const byId = new Map<string, EvidenceCandidate>();
  for (const candidate of candidates) byId.set(candidate.id, candidate);

  const roots: LlmBundleCausalRoot[] = [];
  // Iterate candidates in their emitted (ranked, root-first) order for deterministic root ordering.
  for (const candidate of candidates) {
    if (candidate.causalRole !== "root") continue;
    const causeIds = candidate.causes ?? [];
    if (causeIds.length === 0) continue;
    const symptoms: LlmBundleCausalSymptom[] = [];
    for (const id of causeIds) {
      const symptom = byId.get(id);
      if (!symptom) continue;
      symptoms.push(
        removeUndefined({
          id: symptom.id,
          detector: symptom.detector,
          title: symptom.title,
          attributionConfidence: symptom.attributionConfidence,
        }) as LlmBundleCausalSymptom,
      );
    }
    if (symptoms.length === 0) continue;
    roots.push({
      id: candidate.id,
      detector: candidate.detector,
      title: candidate.title,
      symptoms,
    });
  }
  return roots;
}

const DB_DIFF_OPS = new Set(["insert", "update", "delete"]);

const DB_ENGINES = new Set<DbEngine>(["postgres", "mysql", "mssql", "sqlite"]);

/**
 * Normalizes an event's `engine` tag to the {@link DbEngine} union. Legacy/unknown values default
 * to `"postgres"` — the only engine that ever emitted `db.diff`/`db.read` before multi-engine
 * support — so pre-existing sessions keep their (correct) postgres labeling. Shared by the
 * downstream db consumers (bundle, evidence index) so they stay engine-agnostic identically.
 */
export function normalizeDbEngine(value: unknown): DbEngine {
  return typeof value === "string" && DB_ENGINES.has(value as DbEngine)
    ? (value as DbEngine)
    : "postgres";
}

/**
 * Surfaces redaction-aware row diffs from the session's `k:'db.diff'` events. Sensitive columns
 * were already dropped in the shim; we re-run the shared redaction policy over each image as
 * defense-in-depth so secret-looking values can never rest in the bundle.
 */
function buildDatabaseDiffs(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleDbDiff[] {
  const diffs: LlmBundleDbDiff[] = [];
  for (const event of events) {
    if (event.k !== "db.diff" || !isRecord(event.d)) continue;
    const op = safeText(event.d.op, 20);
    const table = safeText(event.d.table, 200);
    if (!op || !DB_DIFF_OPS.has(op) || !table) continue;

    diffs.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        engine: normalizeDbEngine(event.d.engine),
        op: op as LlmBundleDbDiff["op"],
        table,
        pk: isRecord(event.d.pk)
          ? (redactValue(event.d.pk, "db.diff.pk").value as Record<
              string,
              unknown
            >)
          : null,
        after: isRecord(event.d.after)
          ? (redactValue(event.d.after, "db.diff.after").value as Record<
              string,
              unknown
            >)
          : undefined,
        before: isRecord(event.d.before)
          ? (redactValue(event.d.before, "db.diff.before").value as Record<
              string,
              unknown
            >)
          : undefined,
        rowCount: finiteNumber(event.d.rowCount),
        requestId: safeCorrelationId(event.d.requestId, 200),
      }) as LlmBundleDbDiff,
    );
  }
  return diffs.sort((a, b) => a.t - b.t).slice(0, 200);
}

function buildDatabaseReads(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleDbRead[] {
  const reads: LlmBundleDbRead[] = [];
  for (const event of events) {
    if (event.k !== "db.read" || !isRecord(event.d)) continue;
    const table = safeText(event.d.table, 200);
    if (!table || !isRecord(event.d.row)) continue;

    reads.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        engine: normalizeDbEngine(event.d.engine),
        table,
        pk: isRecord(event.d.pk)
          ? (redactValue(event.d.pk, "db.read.pk").value as Record<
              string,
              unknown
            >)
          : null,
        row: redactValue(event.d.row, "db.read.row").value as Record<
          string,
          unknown
        >,
        requestId: safeText(event.d.requestId, 200),
      }) as LlmBundleDbRead,
    );
  }
  return reads.sort((a, b) => a.t - b.t).slice(0, 200);
}

function buildDatabaseActivity(
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleDbActivity[] {
  const activity: LlmBundleDbActivity[] = [];
  for (const event of events) {
    if (
      event.k !== "backend.otel.span" ||
      !isRecord(event.d) ||
      !isRecord(event.d.attributes)
    )
      continue;
    const attrs = event.d.attributes;
    const system =
      safeText(attrs["db.system"], 80) ?? safeText(attrs["db.name"], 80);
    const operation =
      safeText(attrs["db.operation"], 80) ??
      safeText(attrs["db.operation.name"], 80);
    const statementRaw =
      safeText(attrs["db.statement"], 1000) ??
      safeText(attrs["db.query.text"], 1000);
    if (!system && !operation && !statementRaw) continue;
    const statement = statementRaw
      ? (redactValue(statementRaw, "otel.db.statement").value as string)
      : undefined;

    activity.push(
      removeUndefined({
        t: event.t,
        iso: iso(event.t),
        offsetMs:
          finiteNumber(event.offsetMs) ??
          offsetFromStart(event.t, sessionStartMs),
        evidenceType: "otel_db_activity_statements_not_row_diffs" as const,
        system,
        operation,
        statement,
        spanName: safeText(event.d.name, 200),
        serviceName: safeText(event.d.serviceName, 120),
        requestId:
          safeText(event.d.traceId, 200) ?? safeText(event.d.requestId, 200),
        upgradeHint:
          "Statements only; row diffs unavailable from external OTLP. Add Crumbtrail DB instrumentation for before/after row state.",
      }) as LlmBundleDbActivity,
    );
  }
  return activity.sort((a, b) => a.t - b.t).slice(0, 200);
}

function sanitizeBrowser(
  value: unknown,
): { name: string; version?: string } | undefined {
  if (!isRecord(value)) return undefined;
  const name = safeText(value.name, 60);
  if (!name) return undefined;
  return removeUndefined({ name, version: safeText(value.version, 60) }) as {
    name: string;
    version?: string;
  };
}

function sanitizeViewport(
  value: unknown,
): { w: number; h: number } | undefined {
  if (!isRecord(value)) return undefined;
  const w = finiteNumber(value.w);
  const h = finiteNumber(value.h);
  if (w === undefined || h === undefined) return undefined;
  return { w, h };
}

// One seam behind the index/event duality: prefer index entries, else `eventKind`
// events; map, drop undefined, optionally compact same-signature runs, cap.
// `excludeUntrusted` filters page-world-untrusted. `signatureOf` opts a call site in to
// run compaction (B3); call sites without it (tab boundaries) are byte-identical to before.
function selectSummaries<T extends { t: number }>(options: {
  indexEntries: unknown;
  fromIndex: (value: unknown) => T | undefined;
  events?: BugEvent[];
  eventKind?: string;
  fromEvent?: (event: BugEvent) => T | undefined;
  excludeUntrusted?: boolean;
  cap?: number;
  /** Opt-in run compaction: same-signature entries collapse to one annotated exemplar. */
  signatureOf?: (entry: T) => string;
}): T[] {
  const { events, fromEvent, eventKind, excludeUntrusted, cap, signatureOf } =
    options;
  const keepRecord = (entry: unknown) =>
    !excludeUntrusted || !isPageWorldUntrustedRecord(entry);
  const keepEvent = (event: BugEvent) =>
    (eventKind === undefined || event.k === eventKind) &&
    (!excludeUntrusted || !isPageWorldUntrustedEvent(event));

  const indexed = (
    Array.isArray(options.indexEntries) ? options.indexEntries : []
  )
    .filter(keepRecord)
    .map((entry) => options.fromIndex(entry))
    .filter((entry): entry is T => entry !== undefined);

  const selected =
    indexed.length > 0 || !events || !fromEvent
      ? indexed
      : events
          .filter(keepEvent)
          .map((event) => fromEvent(event))
          .filter((entry): entry is T => entry !== undefined);

  // Compact BEFORE the cap so the cap counts exemplars, not raw duplicates.
  const compacted = signatureOf
    ? compactSummaryRuns(selected, signatureOf)
    : selected;

  return cap === undefined ? compacted : compacted.slice(0, cap);
}

/**
 * B3 run compaction: collapses same-signature entries into ONE exemplar — a verbatim copy of
 * the earliest entry in stream order (already redacted upstream; nothing is synthesized or
 * merged) — annotated with `count` (run size), `firstAt` (min `t`), and `lastAt` (max `t`).
 * The annotations are added ONLY when a signature occurs 2+ times, so singleton entries stay
 * byte-identical to the uncompacted output. Deterministic: exemplars keep the stream-order
 * position of their signature's first occurrence.
 */
function compactSummaryRuns<T extends { t: number }>(
  entries: T[],
  signatureOf: (entry: T) => string,
): T[] {
  const groups = new Map<
    string,
    { exemplar: T; count: number; firstAt: number; lastAt: number }
  >();
  for (const entry of entries) {
    const signature = signatureOf(entry);
    const group = groups.get(signature);
    if (!group) {
      groups.set(signature, {
        exemplar: entry,
        count: 1,
        firstAt: entry.t,
        lastAt: entry.t,
      });
    } else {
      group.count += 1;
      group.firstAt = Math.min(group.firstAt, entry.t);
      group.lastAt = Math.max(group.lastAt, entry.t);
    }
  }

  return [...groups.values()].map((group) =>
    group.count < 2
      ? group.exemplar
      : {
          ...group.exemplar,
          count: group.count,
          firstAt: group.firstAt,
          lastAt: group.lastAt,
        },
  );
}

// Mirrors evidence-index.ts normalizeErrorSignature (module-private there, and that file is
// out of scope to edit; precedent: evidence-index.ts itself mirrors distinct-bugs.ts
// normalizeSignature). Lowercase, drop redaction markers, collapse digits to '#', normalize
// whitespace — so bundle-level run compaction keys the same way as candidate-level dedupe.
function normalizeSummarySignature(value: unknown): string {
  const text = safeText(value, 300);
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/\[redacted\]/g, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

// Field separator for composite signature keys; a control character keeps distinct fields
// from colliding across boundaries (normalized summary text never contains it).
const SIGNATURE_SEPARATOR = "\u0000";

function failedRequestSignature(entry: LlmBundleFailedRequestSummary): string {
  return [
    entry.method ?? "",
    normalizeSummarySignature(entry.url),
    entry.status !== undefined ? String(entry.status) : "",
    entry.reason ?? "",
    entry.code ?? "",
    normalizeSummarySignature(entry.requestBody),
    normalizeSummarySignature(entry.responseBody),
  ].join(SIGNATURE_SEPARATOR);
}

function networkErrorSignature(entry: LlmBundleNetworkErrorSummary): string {
  return [
    entry.method ?? "",
    normalizeSummarySignature(entry.url),
    normalizeSummarySignature(entry.message),
    entry.transport ?? "",
    normalizeSummarySignature(entry.requestBody),
  ].join(SIGNATURE_SEPARATOR);
}

function consoleErrorSignature(entry: LlmBundleConsoleErrorSummary): string {
  return [
    entry.level,
    normalizeSummarySignature(entry.message),
    entry.source ?? "",
  ].join(SIGNATURE_SEPARATOR);
}

function buildFailedRequestSummaries(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleFailedRequestSummary[] {
  return selectSummaries({
    indexEntries: index.failedReqs,
    fromIndex: (req) => failedRequestFromIndex(req, events, sessionStartMs),
    excludeUntrusted: true,
    cap: 40,
    signatureOf: failedRequestSignature,
  });
}

function failedRequestFromIndex(
  value: unknown,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleFailedRequestSummary | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  if (t === undefined) return undefined;

  const networkEvent =
    safeText(value.reason, 80) === "network_error"
      ? networkErrorForIndex(events, value, t)
      : responseForFailedRequest(events, value, t);
  const request = networkEvent
    ? requestForNetworkEvent(events, networkEvent)
    : undefined;

  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs:
      finiteNumber(value.offsetMs) ?? offsetFromStart(t, sessionStartMs),
    method: safeText(value.m, 20) ?? safeText(value.method, 20),
    url: safeUrl(value.url, "index.failedReqs.url"),
    status: finiteNumber(value.st),
    reason: safeText(value.reason, 80),
    code: safeText(value.code, 120),
    message: safeText(value.message, 160),
    phase: safeText(value.phase, 120),
    requestBody: request
      ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
      : undefined,
    responseBody: networkEvent?.k === "net.res"
      ? redactedNetworkBodySnippet(
          networkEvent.d.body,
          networkEvent.d.bodySummary,
        )
      : undefined,
  });
}

function requestForNetworkEvent(
  events: BugEvent[],
  event: BugEvent,
): BugEvent | undefined {
  const id = requestIdForEvent(event);
  if (!id) return undefined;
  return events.find(
    (candidate) =>
      candidate.k === "net.req" && requestIdForEvent(candidate) === id,
  );
}

function responseForFailedRequest(
  events: BugEvent[],
  value: Record<string, unknown>,
  t: number,
): BugEvent | undefined {
  const id = requestIdForValue(value);
  if (id) {
    const matches = events.filter(
      (event) => event.k === "net.res" && requestIdForEvent(event) === id,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  const matches = events.filter(
    (event) =>
      event.k === "net.res" &&
      event.t === t &&
      finiteNumber(event.d.st) === finiteNumber(value.st),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function requestIdForEvent(event: BugEvent | undefined): string | undefined {
  return event ? requestIdForValue(event.d) : undefined;
}

function requestIdForValue(value: Record<string, unknown>): string | undefined {
  const numericId = finiteNumber(value.id);
  return numericId !== undefined ? String(numericId) : safeText(value.id, 120);
}

function summarizeApplicationFailure(event: BugEvent):
  | {
      reason: "application_failure";
      code?: string;
      message?: string;
      phase?: string;
    }
  | undefined {
  const failure = findApplicationFailure(readResponseBody(event.d.body));
  if (!failure) return undefined;
  return removeUndefined({
    reason: "application_failure" as const,
    code: safeText(failure.code, 120),
    message: safeText(failure.message, 160),
    phase: safeText(failure.phase, 120),
  });
}

function readResponseBody(body: unknown): unknown {
  if (typeof body === "string") return body;
  if (isRecord(body) && body.dedup === true) return undefined;
  return body;
}

function findApplicationFailure(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value === "string") return findApplicationFailureInText(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const failure = findApplicationFailure(item);
      if (failure) return failure;
    }
    return undefined;
  }

  if (!isRecord(value)) return undefined;
  if (value.ok === false || value.status === "failed") return value;

  for (const nested of Object.values(value)) {
    const failure = findApplicationFailure(nested);
    if (failure) return failure;
  }

  return undefined;
}

function findApplicationFailureInText(
  text: string,
): Record<string, unknown> | undefined {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      const failure = findApplicationFailure(JSON.parse(candidate));
      if (failure) return failure;
    } catch {
      // Framework response streams can include non-JSON chunks around JSON records.
    }
  }
  return undefined;
}

function extractJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = new Set<string>();
  if (trimmed.startsWith("{") || trimmed.startsWith("["))
    candidates.add(trimmed);

  for (const line of trimmed.split(/\r?\n/)) {
    const chunk = line.trim();
    if (!chunk) continue;
    const framed = chunk.match(/^\d+:(.*)$/);
    const unframed = (framed?.[1] ?? chunk).trim();
    if (unframed.startsWith("{") || unframed.startsWith("["))
      candidates.add(unframed);
    const objectStart = unframed.indexOf("{");
    if (objectStart >= 0) candidates.add(unframed.slice(objectStart));
  }

  return [...candidates];
}

function buildNetworkErrorSummaries(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleNetworkErrorSummary[] {
  return selectSummaries({
    indexEntries: index.networkErrors,
    fromIndex: (entry) => networkErrorFromIndex(entry, events, sessionStartMs),
    events,
    eventKind: "net.err",
    fromEvent: (event) => networkErrorFromEvent(event, events, sessionStartMs),
    excludeUntrusted: true,
    cap: 40,
    signatureOf: networkErrorSignature,
  });
}

function networkErrorFromIndex(
  value: unknown,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleNetworkErrorSummary | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  if (t === undefined) return undefined;

  const networkError = networkErrorForIndex(events, value, t);
  const request = networkError
    ? requestForNetworkEvent(events, networkError)
    : undefined;

  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs:
      finiteNumber(value.offsetMs) ?? offsetFromStart(t, sessionStartMs),
    method: safeText(value.m, 20) ?? safeText(value.method, 20),
    url: safeUrl(value.url, "index.networkErrors.url"),
    message: safeText(value.msg, 180),
    transport: safeText(value.transport, 40),
    requestBody: request
      ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
      : undefined,
  });
}

function networkErrorForIndex(
  events: BugEvent[],
  value: Record<string, unknown>,
  t: number,
): BugEvent | undefined {
  const id = requestIdForValue(value);
  const matches = events.filter(
    (event) =>
      event.k === "net.err" &&
      (id ? requestIdForEvent(event) === id : event.t === t),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function networkErrorFromEvent(
  event: BugEvent,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleNetworkErrorSummary | undefined {
  if (event.k !== "net.err") return undefined;
  const request = requestForNetworkEvent(events, event);
  return removeUndefined({
    t: event.t,
    iso: iso(event.t),
    offsetMs:
      finiteNumber(event.offsetMs) ?? offsetFromStart(event.t, sessionStartMs),
    method: safeText(event.d.method, 20) ?? safeText(event.d.m, 20),
    url: safeUrl(event.d.url, "event.net.err.url"),
    message: safeText(event.d.msg, 180),
    transport: safeText(event.d.transport, 40),
    requestBody: request
      ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
      : undefined,
  });
}

function buildConsoleErrorSummaries(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleConsoleErrorSummary[] {
  return selectSummaries({
    indexEntries: index.consoleErrors,
    fromIndex: (entry) => consoleErrorFromIndex(entry, sessionStartMs),
    events,
    eventKind: "con",
    fromEvent: (event) => consoleErrorFromEvent(event, sessionStartMs),
    excludeUntrusted: true,
    cap: 40,
    signatureOf: consoleErrorSignature,
  });
}

function consoleErrorFromIndex(
  value: unknown,
  sessionStartMs: number,
): LlmBundleConsoleErrorSummary | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  const message = safeText(value.msg, 240);
  if (t === undefined || message === undefined) return undefined;

  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs:
      finiteNumber(value.offsetMs) ?? offsetFromStart(t, sessionStartMs),
    level: consoleLevel(value.lv) ?? "err",
    message,
    source: safeText(value.source, 80),
  });
}

function consoleErrorFromEvent(
  event: BugEvent,
  sessionStartMs: number,
): LlmBundleConsoleErrorSummary | undefined {
  const level = consoleLevel(event.d.lv);
  if (level !== "err" && level !== "error") return undefined;
  const message = consoleMessageFromPayload(event.d);
  if (!message) return undefined;

  return removeUndefined({
    t: event.t,
    iso: iso(event.t),
    offsetMs:
      finiteNumber(event.offsetMs) ?? offsetFromStart(event.t, sessionStartMs),
    level,
    message,
    source: safeText(event.d.source, 80),
  });
}

function consoleLevel(value: unknown): string | undefined {
  const level = safeText(value, 20)?.toLowerCase();
  if (!level) return undefined;
  return level === "error" ? "err" : level;
}

function consoleMessageFromPayload(
  payload: Record<string, unknown>,
): string | undefined {
  const msg = safeText(payload.msg, 240);
  if (msg) return msg;
  if (!Array.isArray(payload.args)) return undefined;

  const joined = payload.args
    .slice(0, 6)
    .map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg)))
    .filter(
      (arg): arg is string => typeof arg === "string" && arg.trim().length > 0,
    )
    .join(" ");
  return safeText(joined, 240);
}

function buildPageProbeSummary(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundlePageProbeSummary {
  const summary: LlmBundlePageProbeSummary = {
    requested: false,
    readyEvents: 0,
    errorEvents: 0,
    frameContexts: 0,
    startedContexts: 0,
    limitedContexts: 0,
    features: {},
    errors: [],
    limitations: [],
  };

  const hasPageProbeEvents = events.some(
    (event) =>
      event.k === "probe.ready" ||
      event.k === "probe.error" ||
      event.k === "frame.ctx",
  );
  if (!hasPageProbeEvents)
    applyIndexedPageProbeSummary(summary, index.pageProbe);

  for (const event of events) {
    if (event.k === "probe.ready") {
      summary.readyEvents += 1;
      summary.requested = true;
      copyBooleanFeatures(summary.features, event.d.features);
      continue;
    }

    if (event.k === "probe.error") {
      summary.errorEvents += 1;
      summary.requested = true;
      const error = pageProbeErrorFromEvent(event, sessionStartMs);
      if (error) summary.errors.push(error);
      continue;
    }

    if (event.k === "frame.ctx") {
      summary.frameContexts += 1;
      const pageProbe = isRecord(event.d.pageProbe)
        ? event.d.pageProbe
        : undefined;
      if (!pageProbe) continue;
      if (pageProbe.requested === true) summary.requested = true;
      if (pageProbe.started === true) summary.startedContexts += 1;
      if (pageProbe.limited === true) {
        summary.limitedContexts += 1;
        const reason = safeText(pageProbe.reason, 120);
        summary.limitations.push(
          reason
            ? `Page probe was limited: ${reason}.`
            : "Page probe was limited for at least one frame.",
        );
      }
    }
  }

  if (summary.requested && summary.readyEvents === 0) {
    summary.limitations.push(
      "Page probe was requested but no probe.ready event was captured.",
    );
  }
  if (summary.errorEvents > 0) {
    summary.limitations.push(
      `${summary.errorEvents} page probe error event(s) were captured.`,
    );
  }
  if (events.some(isPageWorldUntrustedEvent)) {
    summary.limitations.push(
      "Page-probe events are page-world-untrusted and are included only as corroboration hints, not authoritative evidence.",
    );
  }

  return {
    ...summary,
    features: Object.fromEntries(
      Object.entries(summary.features).sort(([a], [b]) => a.localeCompare(b)),
    ),
    errors: summary.errors.slice(0, 20),
    limitations: Array.from(new Set(summary.limitations)),
  };
}

function applyIndexedPageProbeSummary(
  summary: LlmBundlePageProbeSummary,
  value: unknown,
): void {
  if (!isRecord(value)) return;

  if (value.requested === true) summary.requested = true;
  summary.readyEvents = Math.max(
    summary.readyEvents,
    finiteNumber(value.readyEvents) ?? 0,
  );
  summary.errorEvents = Math.max(
    summary.errorEvents,
    finiteNumber(value.errorEvents) ?? 0,
  );
  summary.frameContexts = Math.max(
    summary.frameContexts,
    finiteNumber(value.frameContexts) ?? 0,
  );
  summary.startedContexts = Math.max(
    summary.startedContexts,
    finiteNumber(value.startedContexts) ?? 0,
  );
  summary.limitedContexts = Math.max(
    summary.limitedContexts,
    finiteNumber(value.limitedContexts) ?? 0,
  );
  copyBooleanFeatures(summary.features, value.features);

  if (Array.isArray(value.errors)) {
    for (const error of value.errors) {
      const sanitized = pageProbeErrorFromIndex(error);
      if (sanitized) summary.errors.push(sanitized);
    }
  }
  if (Array.isArray(value.limitations)) {
    for (const limitation of value.limitations) {
      const sanitized = safeText(limitation, 180);
      if (sanitized) summary.limitations.push(sanitized);
    }
  }
}

function pageProbeErrorFromEvent(
  event: BugEvent,
  sessionStartMs: number,
): LlmBundlePageProbeErrorSummary | undefined {
  return removeUndefined({
    t: event.t,
    iso: iso(event.t),
    offsetMs:
      finiteNumber(event.offsetMs) ?? offsetFromStart(event.t, sessionStartMs),
    phase: safeText(event.d.phase, 80),
    message: safeText(event.d.message, 180),
    source: safeText(event.d.source, 80),
  });
}

function pageProbeErrorFromIndex(
  value: unknown,
): LlmBundlePageProbeErrorSummary | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  if (t === undefined) return undefined;
  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs: finiteNumber(value.offsetMs),
    phase: safeText(value.phase, 80),
    message: safeText(value.message, 180),
    source: safeText(value.source, 80),
  });
}

function copyBooleanFeatures(
  target: Record<string, boolean>,
  value: unknown,
): void {
  if (!isRecord(value)) return;
  for (const [key, enabled] of Object.entries(value)) {
    const safeKey = safeText(key, 60);
    if (safeKey && typeof enabled === "boolean") target[safeKey] = enabled;
  }
}

function buildTabBoundarySummary(
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundleTabBoundarySummary {
  const decisions = selectSummaries({
    indexEntries: index.tabBoundaries,
    fromIndex: (entry) => tabBoundaryFromIndex(entry, sessionStartMs),
    events,
    eventKind: "tab.boundary",
    fromEvent: (event) => tabBoundaryFromEvent(event, sessionStartMs),
  });
  const decisionCounts: Record<string, number> = {};
  let nonCaptureCount = 0;

  for (const decision of decisions) {
    const key = decision.decision ?? "unknown";
    decisionCounts[key] = (decisionCounts[key] ?? 0) + 1;
    if (
      decision.nonCapture === true ||
      decision.capture === false ||
      (decision.decision !== undefined && decision.decision !== "follow")
    ) {
      nonCaptureCount += 1;
    }
  }

  return {
    total: decisions.length,
    decisionCounts: sortRecord(decisionCounts),
    nonCaptureCount,
    decisions: decisions.slice(0, 40),
  };
}

// One tab-boundary mapper; the wrappers only adapt source + the `t` guard.
function tabBoundaryDecision(
  record: Record<string, unknown>,
  t: number,
  offsetMs: number | undefined,
  sessionStartMs: number,
): LlmBundleTabBoundaryDecisionSummary {
  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs: offsetMs ?? offsetFromStart(t, sessionStartMs),
    signal: safeText(record.signal, 80),
    decision: safeText(record.decision, 80),
    reason: safeText(record.reason, 120),
    capture: typeof record.capture === "boolean" ? record.capture : undefined,
    nonCapture:
      typeof record.nonCapture === "boolean" ? record.nonCapture : undefined,
    previousCapturedOrigin: safeOrigin(record.previousCapturedOrigin),
    root: boundaryLocationFromValue(record.root),
    current: boundaryLocationFromValue(record.current),
    candidate: boundaryLocationFromValue(record.candidate),
    prompt: boundaryPromptFromValue(record.prompt),
  });
}

function tabBoundaryFromIndex(
  value: unknown,
  sessionStartMs: number,
): LlmBundleTabBoundaryDecisionSummary | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  if (t === undefined) return undefined;
  const offset = finiteNumber(value.offsetMs);
  return tabBoundaryDecision(value, t, offset, sessionStartMs);
}

function tabBoundaryFromEvent(
  event: BugEvent,
  sessionStartMs: number,
): LlmBundleTabBoundaryDecisionSummary | undefined {
  const offset = finiteNumber(event.offsetMs);
  return tabBoundaryDecision(event.d, event.t, offset, sessionStartMs);
}

function boundaryLocationFromValue(
  value: unknown,
): LlmBundleTabBoundaryLocationSummary | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = removeUndefined({
    origin:
      safeOrigin(value.origin) ??
      safeOrigin(value.url) ??
      safeOrigin(value.href),
    host: safeHost(value.host),
    scheme: safeText(value.scheme, 40),
    valid: typeof value.valid === "boolean" ? value.valid : undefined,
    restricted:
      typeof value.restricted === "boolean" ? value.restricted : undefined,
    opaque: typeof value.opaque === "boolean" ? value.opaque : undefined,
    isLocalhost:
      typeof value.isLocalhost === "boolean" ? value.isLocalhost : undefined,
  });
  return Object.keys(candidate).length > 0 ? candidate : undefined;
}

function boundaryPromptFromValue(
  value: unknown,
): LlmBundleTabBoundaryDecisionSummary["prompt"] | undefined {
  if (!isRecord(value)) return undefined;
  const prompt = removeUndefined({
    origin: safeOrigin(value.origin) ?? safeOrigin(value.url),
    outcome: safeText(value.outcome, 80),
  });
  return Object.keys(prompt).length > 0 ? prompt : undefined;
}

function buildFullStackEvidence(
  index: SessionIndexLike,
  sessionStartMs: number,
): LlmBundleFullStackEvidence {
  const empty: LlmBundleFullStackEvidence = {
    schemaVersion: 1,
    summary: {
      frontendRequests: 0,
      backendRequests: 0,
      linked: 0,
      gaps: 0,
      gapTypes: {},
    },
    linked: [],
    gaps: [],
    limitations: [],
  };

  if (!isRecord(index.fullStackRequests)) return empty;
  const summary = isRecord(index.fullStackRequests.summary)
    ? index.fullStackRequests.summary
    : {};
  const linked = Array.isArray(index.fullStackRequests.linked)
    ? index.fullStackRequests.linked
        .map((entry) => linkedFullStackRequestFromIndex(entry, sessionStartMs))
        .filter(
          (entry): entry is LlmBundleLinkedFullStackRequestSummary =>
            entry !== undefined,
        )
        .slice(0, 40)
    : [];
  const gaps = Array.isArray(index.fullStackRequests.gaps)
    ? index.fullStackRequests.gaps
        .map((entry) => fullStackGapFromIndex(entry, sessionStartMs))
        .filter(
          (entry): entry is LlmBundleFullStackRequestGapSummary =>
            entry !== undefined,
        )
        .slice(0, 40)
    : [];
  const summaryGapTypes = sanitizeGapTypes(summary.gapTypes);
  const gapTypes =
    Object.keys(summaryGapTypes).length > 0
      ? summaryGapTypes
      : countGapTypes(gaps);
  const frontendRequests = finiteNumber(summary.frontendRequests) ?? 0;
  const backendRequests = finiteNumber(summary.backendRequests) ?? 0;
  const linkedTotal = finiteNumber(summary.linked) ?? linked.length;
  const gapsTotal = finiteNumber(summary.gaps) ?? gaps.length;
  const limitations: string[] = [];

  if (linked.length < linkedTotal) {
    limitations.push(
      `Full-stack linked request summaries are capped at 40 of ${linkedTotal}.`,
    );
  }
  if (gaps.length < gapsTotal) {
    limitations.push(
      `Full-stack linkage gap summaries are capped at 40 of ${gapsTotal}.`,
    );
  }
  if (gapsTotal > 0) {
    limitations.push(
      "Partial full-stack linkage exists; do not assume every frontend request has backend evidence or every backend request has frontend evidence.",
    );
  }

  return {
    schemaVersion: 1,
    summary: {
      frontendRequests,
      backendRequests,
      linked: linkedTotal,
      gaps: gapsTotal,
      gapTypes,
    },
    linked,
    gaps,
    limitations,
  };
}

function linkedFullStackRequestFromIndex(
  value: unknown,
  sessionStartMs: number,
): LlmBundleLinkedFullStackRequestSummary | undefined {
  if (!isRecord(value)) return undefined;
  const requestId = safeCorrelationId(value.requestId);
  const sessionId = safeCorrelationId(value.sessionId);
  const frontend = frontendRequestEvidenceFromIndex(
    value.frontend,
    sessionStartMs,
  );
  const backend = backendRequestEvidenceFromIndex(
    value.backend,
    sessionStartMs,
  );
  if (!requestId || !sessionId || !frontend || !backend) return undefined;

  return { requestId, sessionId, frontend, backend };
}

function fullStackGapFromIndex(
  value: unknown,
  sessionStartMs: number,
): LlmBundleFullStackRequestGapSummary | undefined {
  if (!isRecord(value) || !isFullStackGapKind(value.type)) return undefined;
  const gap = removeUndefined({
    type: value.type,
    requestId: safeCorrelationId(value.requestId),
    sessionId: safeCorrelationId(value.sessionId),
    frontend: frontendRequestEvidenceFromIndex(value.frontend, sessionStartMs),
    backend: backendRequestEvidenceFromIndex(value.backend, sessionStartMs),
  });
  return gap.frontend || gap.backend || gap.requestId || gap.sessionId
    ? gap
    : undefined;
}

function frontendRequestEvidenceFromIndex(
  value: unknown,
  sessionStartMs: number,
): LlmBundleFrontendRequestEvidenceSummary | undefined {
  if (!isRecord(value)) return undefined;
  const frontend = removeUndefined({
    ref: fullStackEventRefFromIndex(value.ref, sessionStartMs),
    requestId: safeCorrelationId(value.requestId),
    sessionId: safeCorrelationId(value.sessionId),
    method: safeText(value.method, 20),
    url: safeUrl(value.url, "index.fullStackRequests.frontend.url"),
    status: finiteNumber(value.status),
    durationMs: finiteNumber(value.durationMs),
    error: fullStackFrontendErrorFromIndex(value.error),
  });
  return Object.keys(frontend).length > 0 ? frontend : undefined;
}

function backendRequestEvidenceFromIndex(
  value: unknown,
  sessionStartMs: number,
): LlmBundleBackendRequestEvidenceSummary | undefined {
  if (!isRecord(value)) return undefined;
  const backend = removeUndefined({
    requestId: safeCorrelationId(value.requestId),
    sessionId: safeCorrelationId(value.sessionId),
    correlation: fullStackCorrelationFromIndex(value.correlation),
    start: fullStackEventRefFromIndex(value.start, sessionStartMs),
    end: fullStackEventRefFromIndex(value.end, sessionStartMs),
    errorRef: fullStackEventRefFromIndex(value.errorRef, sessionStartMs),
    method: safeText(value.method, 20),
    url: safeUrl(value.url, "index.fullStackRequests.backend.url"),
    pathname: safeUrl(
      value.pathname,
      "index.fullStackRequests.backend.pathname",
    ),
    route: safeText(value.route, 160),
    statusCode: finiteNumber(value.statusCode),
    durationMs: finiteNumber(value.durationMs),
    error: fullStackBackendErrorFromIndex(value.error),
  });
  return Object.keys(backend).length > 0 ? backend : undefined;
}

function fullStackEventRefFromIndex(
  value: unknown,
  sessionStartMs: number,
): LlmBundleFullStackEventRef | undefined {
  if (!isRecord(value)) return undefined;
  const t = finiteNumber(value.t);
  if (t === undefined) return undefined;
  return removeUndefined({
    t,
    iso: iso(t),
    offsetMs:
      finiteNumber(value.offsetMs) ?? offsetFromStart(t, sessionStartMs),
    kind: safeText(value.k, 80) ?? safeText(value.kind, 80),
  });
}

function fullStackCorrelationFromIndex(
  value: unknown,
): LlmBundleBackendRequestEvidenceSummary["correlation"] | undefined {
  if (!isRecord(value)) return undefined;
  const correlation = removeUndefined({
    status: safeText(value.status, 80),
    sessionIdSource: safeText(value.sessionIdSource, 80),
    requestIdSource: safeText(value.requestIdSource, 80),
  });
  return Object.keys(correlation).length > 0 ? correlation : undefined;
}

function fullStackFrontendErrorFromIndex(
  value: unknown,
): LlmBundleFrontendRequestEvidenceSummary["error"] | undefined {
  if (!isRecord(value)) return undefined;
  const error = removeUndefined({
    message: safeText(value.message, 180),
    transport: safeText(value.transport, 40),
  });
  return Object.keys(error).length > 0 ? error : undefined;
}

function fullStackBackendErrorFromIndex(
  value: unknown,
): LlmBundleBackendRequestEvidenceSummary["error"] | undefined {
  if (!isRecord(value)) return undefined;
  const error = removeUndefined({
    name: safeText(value.name, 80),
    code: safeText(value.code, 120),
    message: safeText(value.message, 180),
    statusCode: finiteNumber(value.statusCode),
  });
  return Object.keys(error).length > 0 ? error : undefined;
}

function sanitizeGapTypes(
  value: unknown,
): Partial<Record<LlmBundleFullStackGapKind, number>> {
  if (!isRecord(value)) return {};
  const out: Partial<Record<LlmBundleFullStackGapKind, number>> = {};
  for (const [key, count] of Object.entries(value)) {
    if (isFullStackGapKind(key)) out[key] = finiteNumber(count) ?? 0;
  }
  return sortRecord(out as Record<string, number>) as Partial<
    Record<LlmBundleFullStackGapKind, number>
  >;
}

function countGapTypes(
  gaps: LlmBundleFullStackRequestGapSummary[],
): Partial<Record<LlmBundleFullStackGapKind, number>> {
  const out: Partial<Record<LlmBundleFullStackGapKind, number>> = {};
  for (const gap of gaps) out[gap.type] = (out[gap.type] ?? 0) + 1;
  return sortRecord(out as Record<string, number>) as Partial<
    Record<LlmBundleFullStackGapKind, number>
  >;
}

function isFullStackGapKind(
  value: unknown,
): value is LlmBundleFullStackGapKind {
  return (
    value === "frontend-only" ||
    value === "backend-only" ||
    value === "backend-generated-request-id" ||
    value === "backend-missing-session" ||
    value === "backend-missing-request-id" ||
    value === "backend-missing-session-and-request-id" ||
    value === "client-missing-request-id"
  );
}

function buildMediaSummary(
  sessionDir: string,
  index: SessionIndexLike,
  events: BugEvent[],
  sessionStartMs: number,
): LlmBundle["media"] {
  const videoEvents = events.filter((event) => event.k === "media.video");
  const voiceEvents = events.filter((event) => event.k === "media.voice");
  const transcriptEvents = events.filter((event) => event.k === "tx");
  const video = mediaArtifactSummary(sessionDir, "recording.webm", videoEvents);
  const audio = {
    ...mediaArtifactSummary(sessionDir, "audio.webm", voiceEvents),
    ...(isRecord(index.audio?.upload)
      ? { upload: sanitizeUploadMetadata(index.audio.upload) }
      : {}),
    ...(isRecord(index.audio?.transcription)
      ? { transcription: sanitizeTranscription(index.audio.transcription) }
      : {}),
  };
  const transcript = {
    ...mediaArtifactSummary(sessionDir, "transcript.json", transcriptEvents),
    eventCount:
      finiteNumber(index.audio?.transcription?.eventCount) ??
      transcriptEvents.length,
  };

  return {
    alignment: {
      sessionStartMs,
      rules: [
        "Event `t` values are absolute Unix epoch milliseconds.",
        "`offsetMs` is milliseconds elapsed from the session start clock when the recorder supplied it.",
        "For video/audio playback, compare a timeline moment offset to the same elapsed time in recording.webm or audio.webm.",
        "`media.video` and `media.voice` events show recorder state changes and upload/degradation moments.",
        "`tx` transcript events use the same event clock; transcript text stays in transcript.json/events.ndjson and is not repeated here.",
      ],
    },
    video,
    audio,
    transcript,
    voiceMarkers: voiceEvents
      .filter((event) => event.d.state === "marker-added")
      .map((event) =>
        removeUndefined({
          t: event.t,
          iso: iso(event.t),
          offsetMs:
            finiteNumber(event.offsetMs) ??
            offsetFromStart(event.t, sessionStartMs),
          label: safeText(event.d.label, 120),
          markerId: safeText(event.d.markerId, 120),
        }),
      ),
  };
}

function mediaArtifactSummary(
  sessionDir: string,
  relativePath: string,
  events: BugEvent[],
): MediaArtifactSummary {
  const artifactPath = path.join(sessionDir, relativePath);
  const exists = fs.existsSync(artifactPath);
  const stat = exists ? fs.statSync(artifactPath) : undefined;
  const states = events
    .map((event) => safeText(event.d.state, 80))
    .filter((state): state is string => state !== undefined);

  return removeUndefined({
    path: relativePath,
    exists,
    bytes: stat?.isFile() ? stat.size : undefined,
    eventCount: events.length,
    firstState: states[0],
    lastState: states[states.length - 1],
  });
}

function sanitizeUploadMetadata(
  upload: Record<string, unknown>,
): Record<string, unknown> {
  return removeUndefined({
    metadataFile: safeText(upload.metadataFile, 80),
    uploadedAt: finiteNumber(upload.uploadedAt),
    contentType: safeText(upload.contentType, 120),
    mimeType: safeText(upload.mimeType, 120),
    durationMs: finiteNumber(upload.durationMs),
    chunkCount: finiteNumber(upload.chunkCount),
    transcriptionRequested:
      typeof upload.transcriptionRequested === "boolean"
        ? upload.transcriptionRequested
        : undefined,
  });
}

function sanitizeTranscription(
  transcription: Record<string, unknown>,
): Record<string, unknown> {
  return removeUndefined({
    state: safeText(transcription.state, 120),
    code: safeText(transcription.code, 120),
    message: safeText(transcription.message, 240),
    transcriptFile: safeText(transcription.transcriptFile, 120),
    eventCount: finiteNumber(transcription.eventCount),
  });
}

function buildDegradedCapabilities(
  sessionDir: string,
  meta: Record<string, unknown>,
  index: SessionIndexLike,
  events: BugEvent[],
): LlmBundleDegradedCapability[] {
  const degraded: LlmBundleDegradedCapability[] = [];
  const seen = new Set<string>();
  const add = (entry: LlmBundleDegradedCapability): void => {
    const key = [
      entry.capability,
      entry.state,
      entry.code,
      entry.phase,
      entry.artifact,
      entry.t,
    ].join("|");
    if (seen.has(key)) return;
    seen.add(key);
    degraded.push(entry);
  };

  for (const capability of stringArray(meta.degradedCollection, 80)) {
    add({
      capability,
      state: "degraded-at-start",
      source: "metadata",
      message: "Session metadata listed this capability in degradedCollection.",
    });
  }

  if (isRecord(meta.collection)) {
    for (const [capability, raw] of Object.entries(meta.collection)) {
      if (!isRecord(raw)) continue;
      const enabled =
        typeof raw.enabled === "boolean" ? raw.enabled : undefined;
      const markedDegraded = raw.degraded === true || enabled === false;
      if (!markedDegraded) continue;
      add(
        removeUndefined({
          capability,
          state: enabled === false ? "disabled" : "degraded",
          source: "metadata" as const,
          message: safeText(raw.reason, 180),
        }),
      );
    }
  }

  for (const event of events) {
    if (event.k !== "media.video" && event.k !== "media.voice") continue;
    const state = safeText(event.d.state, 80);
    const code = safeText(event.d.code, 80);
    const isDegraded =
      state === "error" || state === "degraded" || code !== undefined;
    if (!isDegraded) continue;
    add(
      removeUndefined({
        capability:
          safeText(event.d.capability, 80) ??
          (event.k === "media.video" ? "video" : "audio"),
        state: state ?? "degraded",
        source: "event" as const,
        code,
        phase: safeText(event.d.phase, 80),
        message: safeText(event.d.message, 240),
        retryable:
          typeof event.d.retryable === "boolean"
            ? event.d.retryable
            : undefined,
        artifact: event.k === "media.video" ? "recording.webm" : "audio.webm",
        t: event.t,
        offsetMs: finiteNumber(event.offsetMs),
      }),
    );
  }

  for (const event of events) {
    if (event.k === "probe.error") {
      add(
        removeUndefined({
          capability: "page-probe",
          state: "error",
          source: "event" as const,
          code: safeText(event.d.phase, 80),
          message: safeText(event.d.message, 240),
          retryable:
            typeof event.d.retryable === "boolean"
              ? event.d.retryable
              : undefined,
          t: event.t,
          offsetMs: finiteNumber(event.offsetMs),
        }),
      );
      continue;
    }

    if (
      event.k === "frame.ctx" &&
      isRecord(event.d.pageProbe) &&
      event.d.pageProbe.limited === true
    ) {
      add(
        removeUndefined({
          capability: "page-probe",
          state: "limited",
          source: "event" as const,
          code: safeText(event.d.pageProbe.reason, 120),
          message: "Frame context reported limited page-probe collection.",
          t: event.t,
          offsetMs: finiteNumber(event.offsetMs),
        }),
      );
    }
  }

  const audioState = index.audio?.transcription?.state;
  if (
    audioState === "transcription-unavailable" ||
    audioState === "transcription-error"
  ) {
    add(
      removeUndefined({
        capability: "audio-transcription",
        state: audioState,
        source: "post-process" as const,
        code: safeText(index.audio?.transcription?.code, 120),
        message: safeText(index.audio?.transcription?.message, 240),
        artifact: "transcript.json",
      }),
    );
  }

  if (
    expectsCapability(meta, "video", events, "media.video") &&
    !fs.existsSync(path.join(sessionDir, "recording.webm"))
  ) {
    add({
      capability: "video",
      state: "artifact-missing",
      source: "artifact",
      artifact: "recording.webm",
      message:
        "Video was expected or emitted media.video events, but recording.webm is not present.",
    });
  }

  if (
    expectsCapability(meta, "audio", events, "media.voice") &&
    !fs.existsSync(path.join(sessionDir, "audio.webm"))
  ) {
    add({
      capability: "audio",
      state: "artifact-missing",
      source: "artifact",
      artifact: "audio.webm",
      message:
        "Audio was expected or emitted media.voice events, but audio.webm is not present.",
    });
  }

  return degraded;
}

function expectsCapability(
  meta: Record<string, unknown>,
  capability: string,
  events: BugEvent[],
  eventKind: string,
): boolean {
  if (events.some((event) => event.k === eventKind)) return true;

  if (isRecord(meta.capabilities) && meta.capabilities[capability] === true)
    return true;
  if (isRecord(meta.collection)) {
    const collectionEntry = meta.collection[capability];
    if (isRecord(collectionEntry) && collectionEntry.enabled === true)
      return true;
  }

  return false;
}

export function summarizeRedaction(
  events: BugEvent[],
): LlmBundleRedactionSummary {
  const acc: RedactionAccumulator = {
    eventsWithRedactionEvidence: 0,
    redactedFields: 0,
    payloadSummaries: 0,
    reasons: {},
    actions: {},
  };

  for (const event of events) {
    const beforeFields = acc.redactedFields;
    const beforeSummaries = acc.payloadSummaries;
    collectRedaction(event.d, acc);
    if (
      acc.redactedFields > beforeFields ||
      acc.payloadSummaries > beforeSummaries
    ) {
      acc.eventsWithRedactionEvidence += 1;
    }
  }

  const notes = [
    "Collectors are expected to redact sensitive data in the browser before persistence and attach redaction metadata when fields change.",
    "This bundle sanitizes rendered URLs and does not copy raw request/response bodies, storage values, input values, or transcript text.",
  ];
  if (acc.eventsWithRedactionEvidence === 0) {
    notes.push(
      "No event-level redaction evidence was found; inspect raw files as potentially sensitive despite bundle-level URL sanitization.",
    );
  }

  return {
    policy: BROWSER_REDACTION_POLICY,
    browserFirst: true,
    renderedBundleSanitization: [
      "navigation URLs",
      "failed request URLs",
      "full-stack request URLs and path-like fields",
      "timeline URL-like fields",
      "metadata URL-like fields",
      "token-like prose snippets in errors, media messages, and full-stack summaries",
    ],
    eventsWithRedactionEvidence: acc.eventsWithRedactionEvidence,
    redactedFields: acc.redactedFields,
    payloadSummaries: acc.payloadSummaries,
    reasons: sortRecord(acc.reasons),
    actions: acc.actions,
    notes,
  };
}

function collectRedaction(value: unknown, acc: RedactionAccumulator): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectRedaction(entry, acc);
    return;
  }

  if (!isRecord(value)) return;

  if (isRedactionMetadata(value)) {
    for (const field of value.fields) {
      const reason = safeText(field.reason, 120) ?? "unknown";
      const action = isRedactionAction(field.action)
        ? field.action
        : "redacted";
      acc.redactedFields += 1;
      acc.reasons[reason] = (acc.reasons[reason] ?? 0) + 1;
      acc.actions[action] = (acc.actions[action] ?? 0) + 1;
    }
    const summaries = Array.isArray(value.summaries) ? value.summaries : [];
    for (const summary of summaries) {
      if (isRecord(summary)) collectPayloadSummary(summary, acc);
    }
    return;
  }

  if (isPayloadSummary(value)) {
    collectPayloadSummary(value, acc);
    return;
  }

  for (const entry of Object.values(value)) collectRedaction(entry, acc);
}

function isRedactionMetadata(value: Record<string, unknown>): value is {
  policy: string;
  fields: Array<{ reason?: unknown; action?: unknown }>;
  summaries?: unknown[];
} {
  return (
    (value.policy === BROWSER_REDACTION_POLICY ||
      value.policy === BROWSER_REDACTION_POLICY_V2) &&
    Array.isArray(value.fields)
  );
}

function isPayloadSummary(
  value: Record<string, unknown>,
): value is { reason?: unknown; action?: unknown } {
  return (
    typeof value.kind === "string" &&
    typeof value.action === "string" &&
    typeof value.reason === "string"
  );
}

function collectPayloadSummary(
  value: { reason?: unknown; action?: unknown },
  acc: RedactionAccumulator,
): void {
  const reason = safeText(value.reason, 120) ?? "unknown";
  const action = isRedactionAction(value.action) ? value.action : "summarized";
  acc.payloadSummaries += 1;
  acc.reasons[reason] = (acc.reasons[reason] ?? 0) + 1;
  acc.actions[action] = (acc.actions[action] ?? 0) + 1;
}

function isRedactionAction(value: unknown): value is RedactionAction {
  return value === "redacted" || value === "dropped" || value === "summarized";
}

function buildLimitations(
  artifacts: LlmBundleArtifact[],
  events: BugEvent[],
  redaction: LlmBundleRedactionSummary,
  degradedCapabilities: LlmBundleDegradedCapability[],
  index: SessionIndexLike,
  meta: Record<string, unknown>,
  browserEvidence: LlmBundleBrowserEvidence,
  fullStackEvidence: LlmBundleFullStackEvidence,
): string[] {
  const limitations = new Set<string>();
  const artifact = (relativePath: string): LlmBundleArtifact | undefined =>
    artifacts.find((entry) => entry.path === relativePath);

  limitations.add(
    "This bundle is an inspection guide, not a replay UI; align raw media manually using the offset rules.",
  );

  if (events.length === 0 || index.evts === 0) {
    limitations.add(
      "No events were available during post-processing; events.ndjson is missing or empty.",
    );
  }

  if (
    expectsCapability(meta, "video", events, "media.video") &&
    artifact("recording.webm")?.exists !== true
  ) {
    limitations.add(
      "recording.webm is missing, so active-tab video cannot be inspected for this session.",
    );
  }

  if (
    expectsCapability(meta, "audio", events, "media.voice") &&
    artifact("audio.webm")?.exists !== true
  ) {
    limitations.add(
      "audio.webm is missing, so continuous microphone audio cannot be inspected for this session.",
    );
  }

  if (
    index.audio?.transcription?.state &&
    index.audio.transcription.state !== "transcription-ready"
  ) {
    limitations.add(
      `Audio transcription state is ${index.audio.transcription.state}; use audio.webm and media.voice markers for alignment.`,
    );
  }

  if (redaction.eventsWithRedactionEvidence === 0) {
    limitations.add(
      "No per-event redaction metadata was found in the event stream. Treat raw files as potentially sensitive.",
    );
  }

  for (const limitation of browserEvidence.pageProbe.limitations) {
    limitations.add(limitation);
  }

  if (browserEvidence.networkErrors.length > 0) {
    limitations.add(
      `${browserEvidence.networkErrors.length} network request error(s) occurred before an HTTP response was captured.`,
    );
  }

  if (browserEvidence.tabBoundaries.nonCaptureCount > 0) {
    limitations.add(
      `${browserEvidence.tabBoundaries.nonCaptureCount} tab-boundary decision(s) intentionally marked non-capture; outside-boundary pages were not silently recorded.`,
    );
  }

  for (const limitation of fullStackEvidence.limitations) {
    limitations.add(limitation);
  }

  for (const degraded of degradedCapabilities) {
    limitations.add(
      `${degraded.capability} is ${degraded.state}${degraded.code ? ` (${degraded.code})` : ""}.`,
    );
  }

  return Array.from(limitations);
}

function buildInspectionGuide(
  artifacts: LlmBundleArtifact[],
): LlmBundle["inspectionGuide"] {
  const exists = (relativePath: string): boolean =>
    artifacts.some(
      (artifact) => artifact.path === relativePath && artifact.exists,
    );
  const guide = [
    {
      step: 1,
      path: "CANDIDATES.md",
      purpose:
        "Start here for the deterministic ranked issue list and links to focused evidence windows.",
    },
    {
      step: 2,
      path: "search.jsonl",
      purpose:
        "Grep normalized, redacted candidate-linked evidence rows without opening raw payloads.",
    },
    {
      step: 3,
      path: "timeline.md",
      purpose: "Use five-minute buckets to orient inside long recordings.",
    },
    {
      step: 4,
      path: "llm.md",
      purpose:
        "Read the human-readable session map, media alignment rules, limitations, and redaction notes.",
    },
    {
      step: 5,
      path: "llm.json",
      purpose:
        "Use this machine-readable summary for automated triage or query planning.",
    },
    {
      step: 6,
      path: "index.json",
      purpose:
        "Inspect post-processed counts, errors, failed requests, navigation, storage summary, tab boundaries, and audio state.",
    },
    {
      step: 7,
      path: "events.ndjson",
      purpose:
        "Read raw chronological evidence only after candidate artifacts; one JSON event per line and potentially sensitive.",
    },
  ];

  if (exists("recording.webm")) {
    guide.push({
      step: guide.length + 1,
      path: "recording.webm",
      purpose:
        "Open around offsets called out in keyTimelineMoments to inspect the active-tab video.",
    });
  }
  if (exists("audio.webm")) {
    guide.push({
      step: guide.length + 1,
      path: "audio.webm",
      purpose:
        "Open around media.voice offsets and transcript event offsets to inspect continuous audio.",
    });
  }
  if (exists("transcript.json")) {
    guide.push({
      step: guide.length + 1,
      path: "transcript.json",
      purpose:
        "Inspect speech-to-text output; transcript text is intentionally not copied into llm.md.",
    });
  }

  return guide;
}

export function renderLlmMarkdown(bundle: LlmBundle): string {
  const lines = [
    `# Crumbtrail session ${bundle.session.id}`,
    "",
    "Agent-first inspection bundle generated by local post-processing.",
    "",
    "## Session",
    "",
    `- Session directory: \`${bundle.sessionDir}\``,
    `- Name: ${bundle.session.name ?? "not provided"}`,
    `- Source: ${bundle.session.source ?? "not provided"}`,
    `- App: ${bundle.session.app ?? "not provided"}`,
    `- Start: ${bundle.session.startIso ?? bundle.session.startMs}`,
    `- End: ${bundle.session.endIso ?? bundle.session.endMs}`,
    `- Duration: ${bundle.session.durationMs} ms`,
    // B5 latency mirror: present only when the bundle carries the self-measured fields.
    ...(bundle.detectToBundleMs !== undefined
      ? [`- Detect→bundle latency: ${bundle.detectToBundleMs} ms`]
      : []),
    "",
    ...renderEnvironmentSection(bundle.environment),
    "## Artifact Map",
    "",
    table(
      ["Path", "Role", "Status", "Description"],
      bundle.artifacts.map((artifact) => [
        `\`${artifact.path}\``,
        artifact.role,
        artifact.exists
          ? `present${artifact.bytes !== undefined ? ` (${artifact.bytes} bytes)` : artifact.entries !== undefined ? ` (${artifact.entries} entries)` : ""}`
          : "missing",
        artifact.description,
      ]),
    ),
    "",
    "## Event Counts",
    "",
    table(
      ["Kind", "Count"],
      Object.entries(bundle.eventCounts).map(([kind, count]) => [
        kind,
        String(count),
      ]),
    ),
    "",
    "## Browser Evidence Summary",
    "",
    `- Page probe: ${bundle.browserEvidence.pageProbe.requested ? "requested" : "not requested"}; ready events: ${bundle.browserEvidence.pageProbe.readyEvents}; errors: ${bundle.browserEvidence.pageProbe.errorEvents}; limited frame contexts: ${bundle.browserEvidence.pageProbe.limitedContexts}`,
    `- Failed requests: ${bundle.browserEvidence.failedRequests.length}`,
    `- Network request errors: ${bundle.browserEvidence.networkErrors.length}`,
    `- Console errors: ${bundle.browserEvidence.consoleErrors.length}`,
    `- Tab boundary decisions: ${bundle.browserEvidence.tabBoundaries.total}; non-capture decisions: ${bundle.browserEvidence.tabBoundaries.nonCaptureCount}`,
    "",
    ...(bundle.browserEvidence.failedRequests.length > 0
      ? [
          "### Failed Requests",
          "",
          table(
            [
              "Offset",
              "Method",
              "Status",
              "Reason",
              "Code",
              "URL",
              "Request body",
              "Response body",
            ],
            bundle.browserEvidence.failedRequests
              .slice(0, 10)
              .map((req) => [
                req.offsetMs !== undefined ? `${req.offsetMs} ms` : "unknown",
                req.method ?? "",
                req.status !== undefined ? String(req.status) : "",
                req.reason ?? "",
                req.code ?? req.message ?? "",
                req.url ?? "",
                req.requestBody ?? "",
                req.responseBody ?? "",
              ]),
          ),
          "",
        ]
      : []),
    "## Agent Context Timeline",
    "",
    `- Schema: ${bundle.agentContext.schemaVersion}`,
    ...(bundle.agentContext.timeline.length > 0
      ? [
          "",
          table(
            ["Offset", "Kind", "Summary"],
            bundle.agentContext.timeline
              .slice(0, 40)
              .map((entry) => [
                entry.offsetMs !== undefined
                  ? `${entry.offsetMs} ms`
                  : "unknown",
                entry.kind,
                entry.summary,
              ]),
          ),
        ]
      : [
          "",
          "_No navigation, error, failed request, or interaction events captured._",
        ]),
    "",
    ...(bundle.browserEvidence.networkErrors.length > 0
      ? [
          "### Network Errors",
          "",
          table(
            ["Offset", "Method", "Transport", "URL", "Message", "Request body"],
            bundle.browserEvidence.networkErrors
              .slice(0, 10)
              .map((entry) => [
                entry.offsetMs !== undefined
                  ? `${entry.offsetMs} ms`
                  : "unknown",
                entry.method ?? "",
                entry.transport ?? "",
                entry.url ?? "",
                entry.message ?? "",
                entry.requestBody ?? "",
              ]),
          ),
          "",
        ]
      : []),
    ...(bundle.browserEvidence.consoleErrors.length > 0
      ? [
          "### Console Errors",
          "",
          table(
            ["Offset", "Level", "Message", "Source"],
            bundle.browserEvidence.consoleErrors
              .slice(0, 10)
              .map((entry) => [
                entry.offsetMs !== undefined
                  ? `${entry.offsetMs} ms`
                  : "unknown",
                entry.level,
                entry.message,
                entry.source ?? "",
              ]),
          ),
          "",
        ]
      : []),
    ...(bundle.browserEvidence.tabBoundaries.total > 0
      ? [
          "### Tab Boundary Decisions",
          "",
          table(
            [
              "Offset",
              "Decision",
              "Reason",
              "Root",
              "Current",
              "Candidate",
              "Prompt",
              "Capture",
            ],
            bundle.browserEvidence.tabBoundaries.decisions
              .slice(0, 10)
              .map((entry) => [
                entry.offsetMs !== undefined
                  ? `${entry.offsetMs} ms`
                  : "unknown",
                entry.decision ?? "",
                entry.reason ?? "",
                formatBoundaryLocation(entry.root),
                formatBoundaryLocation(entry.current),
                formatBoundaryLocation(entry.candidate),
                [entry.prompt?.outcome, entry.prompt?.origin]
                  .filter(Boolean)
                  .join(" "),
                entry.capture === true
                  ? "yes"
                  : entry.nonCapture === true || entry.capture === false
                    ? "no"
                    : "unknown",
              ]),
          ),
          "",
        ]
      : []),
    "## Full-Stack Request Evidence",
    "",
    `- Frontend requests: ${bundle.fullStackEvidence.summary.frontendRequests}`,
    `- Backend requests: ${bundle.fullStackEvidence.summary.backendRequests}`,
    `- Linked request moments: ${bundle.fullStackEvidence.summary.linked}`,
    `- Partial-linkage gaps: ${bundle.fullStackEvidence.summary.gaps}`,
    ...(Object.keys(bundle.fullStackEvidence.summary.gapTypes).length > 0
      ? [
          `- Gap types: ${Object.entries(
            bundle.fullStackEvidence.summary.gapTypes,
          )
            .map(([type, count]) => `${type}: ${count}`)
            .join(", ")}`,
        ]
      : []),
    ...(bundle.fullStackEvidence.summary.gaps > 0
      ? [
          "- Guidance: do not assume every frontend request has backend evidence when gaps exist; inspect index.json/events.ndjson for raw chronology only as needed.",
        ]
      : []),
    "",
    ...(bundle.fullStackEvidence.linked.length > 0
      ? [
          "### Linked Request Moments",
          "",
          table(
            [
              "Offset",
              "Request ID",
              "Session ID",
              "Frontend",
              "Backend",
              "Status",
            ],
            bundle.fullStackEvidence.linked
              .slice(0, 10)
              .map((entry) => [
                entry.frontend.ref?.offsetMs !== undefined
                  ? `${entry.frontend.ref.offsetMs} ms`
                  : entry.backend.start?.offsetMs !== undefined
                    ? `${entry.backend.start.offsetMs} ms`
                    : "unknown",
                entry.requestId,
                entry.sessionId,
                summarizeFrontendRequestForMarkdown(entry.frontend),
                summarizeBackendRequestForMarkdown(entry.backend),
                entry.frontend.status !== undefined ||
                entry.backend.statusCode !== undefined
                  ? [entry.frontend.status, entry.backend.statusCode]
                      .filter((status) => status !== undefined)
                      .join(" / ")
                  : "",
              ]),
          ),
          "",
        ]
      : []),
    ...(bundle.fullStackEvidence.gaps.length > 0
      ? [
          "### Partial-Linkage Gaps",
          "",
          table(
            ["Type", "Request ID", "Session ID", "Frontend", "Backend"],
            bundle.fullStackEvidence.gaps
              .slice(0, 10)
              .map((entry) => [
                entry.type,
                entry.requestId ??
                  entry.frontend?.requestId ??
                  entry.backend?.requestId ??
                  "",
                entry.sessionId ??
                  entry.frontend?.sessionId ??
                  entry.backend?.sessionId ??
                  "",
                entry.frontend
                  ? summarizeFrontendRequestForMarkdown(entry.frontend)
                  : "",
                entry.backend
                  ? summarizeBackendRequestForMarkdown(entry.backend)
                  : "",
              ]),
          ),
          "",
        ]
      : []),
    ...(bundle.fullStackEvidence.limitations.length > 0
      ? [
          ...bundle.fullStackEvidence.limitations.map((entry) => `- ${entry}`),
          "",
        ]
      : []),
    ...renderDatabaseActivitySection(bundle.databaseActivity),
    ...renderCausalStructureSection(bundle.causalTree),
    "## Key Timeline Moments",
    "",
    table(
      ["Offset", "Time", "Kind", "Summary"],
      bundle.keyTimelineMoments.map((moment) => [
        moment.offsetMs !== undefined ? `${moment.offsetMs} ms` : "unknown",
        moment.iso ?? String(moment.t),
        moment.k,
        moment.summary,
      ]),
    ),
    "",
    "## Media Alignment Rules",
    "",
    ...bundle.media.alignment.rules.map((rule) => `- ${rule}`),
    "",
    `- Video: ${bundle.media.video.exists ? `\`${bundle.media.video.path}\`` : "missing"}; events: ${bundle.media.video.eventCount}; last state: ${bundle.media.video.lastState ?? "unknown"}`,
    `- Audio: ${bundle.media.audio.exists ? `\`${bundle.media.audio.path}\`` : "missing"}; events: ${bundle.media.audio.eventCount}; last state: ${bundle.media.audio.lastState ?? "unknown"}`,
    `- Transcript: ${bundle.media.transcript.exists ? `\`${bundle.media.transcript.path}\`` : "missing"}; tx events: ${bundle.media.transcript.eventCount}`,
    "",
    "## Degraded Capabilities and Limitations",
    "",
    ...(bundle.limitations.length > 0
      ? bundle.limitations.map((entry) => `- ${entry}`)
      : ["- None recorded."]),
    "",
    "## Redaction Summary",
    "",
    `- Policy: \`${bundle.redaction.policy}\``,
    `- Events with redaction evidence: ${bundle.redaction.eventsWithRedactionEvidence}`,
    `- Redacted fields: ${bundle.redaction.redactedFields}`,
    `- Payload summaries: ${bundle.redaction.payloadSummaries}`,
    `- Bundle sanitizes: ${bundle.redaction.renderedBundleSanitization.join(", ")}`,
    "",
    ...(Object.keys(bundle.redaction.reasons).length > 0
      ? [
          table(
            ["Reason", "Count"],
            Object.entries(bundle.redaction.reasons).map(([reason, count]) => [
              reason,
              String(count),
            ]),
          ),
          "",
        ]
      : []),
    ...bundle.redaction.notes.map((note) => `- ${note}`),
    "",
    "## How to Inspect Raw Files",
    "",
    ...bundle.inspectionGuide.map(
      (step) => `${step.step}. \`${step.path}\` — ${step.purpose}`,
    ),
    "",
    "Raw artifacts may contain user workflow data. Prefer this summary and `index.json` first, then inspect raw files only as needed.",
    "",
  ];

  return lines.join("\n");
}

function renderEnvironmentSection(
  environment: LlmBundleEnvironment | null,
): string[] {
  if (!environment) return [];
  const lines = ["## Environment", ""];
  if (environment.userAgent)
    lines.push(`- User agent: ${environment.userAgent}`);
  if (environment.browser)
    lines.push(
      `- Browser: ${environment.browser.name}${environment.browser.version ? ` ${environment.browser.version}` : ""}`,
    );
  if (environment.os) lines.push(`- OS: ${environment.os}`);
  if (environment.viewport)
    lines.push(
      `- Viewport: ${environment.viewport.w}x${environment.viewport.h}`,
    );
  if (environment.locale) lines.push(`- Locale: ${environment.locale}`);
  if (environment.timezone) lines.push(`- Timezone: ${environment.timezone}`);
  if (environment.flags)
    lines.push(
      `- Feature flags: ${Object.keys(environment.flags).sort().join(", ") || "none"} (values redacted in browser before capture)`,
    );
  if (environment.config)
    lines.push(
      `- Config keys: ${Object.keys(environment.config).sort().join(", ") || "none"} (values redacted in browser before capture)`,
    );
  lines.push("");
  return lines;
}

function renderDatabaseActivitySection(
  activity: LlmBundleDbActivity[],
): string[] {
  if (activity.length === 0) return [];
  return [
    "## Database Activity Statements",
    "",
    "OTel DB spans report statements and operations only; they are not before/after row diffs.",
    "",
    table(
      ["Offset", "System", "Operation", "Statement", "Request ID"],
      activity
        .slice(0, 20)
        .map((entry) => [
          entry.offsetMs !== undefined ? `${entry.offsetMs} ms` : "unknown",
          entry.system ?? "",
          entry.operation ?? "",
          entry.statement ?? entry.spanName ?? "",
          entry.requestId ?? "",
        ]),
    ),
    "",
    ...activity.slice(0, 3).map((entry) => `- ${entry.upgradeHint}`),
    "",
  ];
}

/**
 * Renders the deterministic root → symptom causal tree as ONE bounded section, inserted at a fixed
 * position (right after Full-Stack Request Evidence). Empty array → no section. Ordering mirrors
 * {@link buildCausalTree}: roots in ranked order, symptoms in each root's `causes` order.
 */
function renderCausalStructureSection(
  causalTree: LlmBundleCausalRoot[] | undefined,
): string[] {
  if (!causalTree || causalTree.length === 0) return [];
  const lines = ["## Causal Structure", ""];
  lines.push(
    "Root causes with the downstream symptoms attributed to them (deterministic; from detector signal causal fields).",
  );
  lines.push("");
  for (const root of causalTree) {
    lines.push(`- Root: ${root.id} · ${root.detector} — ${root.title}`);
    for (const symptom of root.symptoms) {
      const conf = symptom.attributionConfidence
        ? ` (attribution ${symptom.attributionConfidence})`
        : "";
      lines.push(
        `  - Symptom: ${symptom.id} · ${symptom.detector} — ${symptom.title}${conf}`,
      );
    }
  }
  lines.push("");
  return lines;
}

function summarizeFrontendRequestForMarkdown(
  frontend: LlmBundleFrontendRequestEvidenceSummary,
): string {
  return joinParts([
    frontend.method,
    frontend.url,
    frontend.durationMs !== undefined ? `${frontend.durationMs} ms` : undefined,
    frontend.error?.transport,
    frontend.error?.message,
  ]);
}

function summarizeBackendRequestForMarkdown(
  backend: LlmBundleBackendRequestEvidenceSummary,
): string {
  return joinParts([
    backend.method,
    backend.url ?? backend.pathname ?? backend.route,
    backend.durationMs !== undefined ? `${backend.durationMs} ms` : undefined,
    backend.correlation?.status,
    backend.error?.code ?? backend.error?.message,
  ]);
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(filePath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function copySafeString(
  out: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = safeText(source[key], 180);
  if (value !== undefined) out[key] = value;
}

function copySafeUrl(
  out: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = safeUrl(source[key], `metadata.${key}`);
  if (value !== undefined) out[key] = value;
}

function copySafeNumber(
  out: Record<string, unknown>,
  source: Record<string, unknown>,
  key: string,
): void {
  const value = finiteNumber(source[key]);
  if (value !== undefined) out[key] = value;
}

function sanitizeBooleanRecord(
  value: unknown,
): Record<string, boolean> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, boolean> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "boolean") out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function safeUrl(value: unknown, _fieldPath: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return truncate(redactUrlLikeString(trimmed).replace(/\s+/g, " "), 240);
}

function safeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function safeHost(value: unknown): string | undefined {
  const text = safeText(value, 253)?.toLowerCase();
  if (!text || /[/\\?#@\s]/.test(text) || !/^[a-z0-9.:-]+$/.test(text))
    return undefined;
  return text;
}

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (trimmed.length === 0) return undefined;
  return truncate(redactTokenLikeText(trimmed), maxLength);
}

// The only correlation identifiers that can bypass token redaction are formats that
// Crumbtrail itself mints plus the W3C identifiers it explicitly adopts. This must
// stay deliberately narrow: arbitrary URL-safe strings include API keys and JWTs.
const W3C_TRACE_ID_RE = /^[0-9a-f]{32}$/;
const W3C_SPAN_ID_RE = /^[0-9a-f]{16}$/;
const W3C_TRACEPARENT_RE = /^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/;
const CRUMBTRAIL_REQUEST_ID_RE = /^req_[a-z0-9]+_[a-z0-9]{12}$/;
const BACKEND_REQUEST_ID_RE = /^backend_req_[a-z0-9]+_[a-z0-9]{8}$/;
const CRUMBTRAIL_SESSION_ID_RE = /^ses_\d{8}_\d{6}_[0-9a-f]{12}$/;
const AWS_ACCESS_KEY_RE = /^(?:AKIA|ASIA)[0-9A-Z]{16}$/;
const TOKEN_PREFIX_RE = /^(?:sk|pk)_[A-Za-z0-9_-]{8,}$/;
const BEARER_TOKEN_RE = /^bearer\s+\S+$/i;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const LONG_OPAQUE_TOKEN_RE = /^[A-Za-z0-9._~+/=-]{33,}$/;

function isSafeCorrelationId(value: string): boolean {
  return (
    W3C_TRACE_ID_RE.test(value) ||
    W3C_SPAN_ID_RE.test(value) ||
    W3C_TRACEPARENT_RE.test(value) ||
    CRUMBTRAIL_REQUEST_ID_RE.test(value) ||
    BACKEND_REQUEST_ID_RE.test(value) ||
    CRUMBTRAIL_SESSION_ID_RE.test(value)
  );
}

/**
 * Like {@link safeText} but does NOT run token-like redaction.
 *
 * Correlation ids that Crumbtrail mints or explicitly adopts are emitted verbatim. A
 * W3C trace id is exactly 32 lowercase hex and would otherwise be scrubbed by the
 * MD5/SHA shaped redaction rule, silently breaking front end to back end correlation in
 * the LLM bundle. Everything else uses normal token redaction before it can rest here.
 */
function safeCorrelationId(
  value: unknown,
  maxLength = 128,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (isSafeCorrelationId(trimmed)) return truncate(trimmed, maxLength);
  if (
    AWS_ACCESS_KEY_RE.test(trimmed) ||
    TOKEN_PREFIX_RE.test(trimmed) ||
    BEARER_TOKEN_RE.test(trimmed) ||
    JWT_RE.test(trimmed) ||
    LONG_OPAQUE_TOKEN_RE.test(trimmed)
  ) {
    return REDACTED_VALUE;
  }
  return safeText(trimmed, maxLength);
}

function redactUrlLikeString(value: string): string {
  const withNoHash = dropUrlHash(value);
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(withNoHash);

  if (hasScheme) {
    try {
      const parsed = new URL(withNoHash);
      parsed.username = "";
      parsed.password = "";
      redactSearchParams(parsed.searchParams);
      return redactTokenLikeText(parsed.toString());
    } catch {
      return redactRelativeUrlLikeString(withNoHash);
    }
  }

  return redactRelativeUrlLikeString(withNoHash);
}

function redactRelativeUrlLikeString(value: string): string {
  const queryIndex = value.indexOf("?");
  if (queryIndex < 0) return redactTokenLikeText(value);

  const base = value.slice(0, queryIndex);
  const query = value.slice(queryIndex + 1);
  const params = new URLSearchParams(query);
  redactSearchParams(params);
  const serialized = params.toString();
  return redactTokenLikeText(`${base}${serialized ? `?${serialized}` : ""}`);
}

function redactSearchParams(params: URLSearchParams): void {
  for (const key of Array.from(params.keys())) {
    const values = params.getAll(key);
    params.delete(key);
    for (const value of values) {
      params.append(key, value === "" ? "" : REDACTED_VALUE);
    }
  }
}

function dropUrlHash(value: string): string {
  const hashIndex = value.indexOf("#");
  return hashIndex >= 0 ? value.slice(0, hashIndex) : value;
}

function redactTokenLikeText(value: string): string {
  return redactTokenLikeString(value).value;
}

function stringArray(value: unknown, maxLength: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => safeText(entry, maxLength))
    .filter((entry): entry is string => entry !== undefined);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function offsetFromStart(t: number, startMs: number): number | undefined {
  if (!Number.isFinite(t) || !Number.isFinite(startMs) || startMs === 0)
    return undefined;
  return Math.max(0, t - startMs);
}

function iso(value: number): string | undefined {
  if (!Number.isFinite(value) || value <= 0) return undefined;
  try {
    return new Date(value).toISOString();
  } catch {
    return undefined;
  }
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  return value.length <= maxLength
    ? value
    : `${value.slice(0, truncateEnd(value, maxLength - 1))}…`;
}

function truncateEnd(value: string, maxLength: number): number {
  const end = Math.max(0, maxLength);
  const lastCodeUnit = value.charCodeAt(end - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? end - 1 : end;
}

function joinParts(parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("; ");
}

function formatBoundaryLocation(
  value: LlmBundleTabBoundaryLocationSummary | undefined,
): string {
  if (!value) return "";
  return value.origin ?? value.host ?? value.scheme ?? "";
}

function table(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "_None._";
  return [
    `| ${headers.map(escapeTableCell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`),
  ].join("\n");
}

function escapeTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, "<br>");
}

function sortRecord(record: Record<string, number>): Record<string, number> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isPageWorldUntrustedEvent(event: BugEvent): boolean {
  return isPageWorldUntrustedRecord(event.d);
}

function isPageWorldUntrustedRecord(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.source === "page-probe" ||
      value.evidenceTrust === "page-world-untrusted")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
