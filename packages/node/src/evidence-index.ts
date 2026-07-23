import fs from "node:fs";
import path from "node:path";
import {
  redactTokenLikeString,
  redactUrl as redactCoreUrl,
  type BrowserRedactionPolicy,
  type BugEvent,
  type TargetDescriptor,
} from "crumbtrail-core";
import { BROWSER_REDACTION_POLICY, normalizeDbEngine } from "./llm-bundle";
import { redactedNetworkBodySnippet } from "./network-body";
import { attributeCandidates } from "./causal-graph";
import type { CausalConfidence, CausalGraph } from "./causal-graph";

export const CANDIDATE_SCHEMA_VERSION = 1 as const;
const MAX_EVIDENCE_CANDIDATES = 200;

/**
 * Tunable constants for confidence-gated causal re-ranking (CP3).
 *  - MAP_WINDOW_MS: temporal window for candidate→node fallback mapping (mirrors CAUSAL_MAP_WINDOW_MS
 *    in causal-graph.ts; 2s matches the graph's own edge WINDOW_MS so a symptom that got a graph edge
 *    is reliably mappable).
 *  - MAX_BLAST_BOOST: hard cap on how much a root's *ranking* score can rise from its symptom cluster,
 *    so a root with many symptoms cannot leapfrog an unrelated higher-severity issue by an unbounded
 *    amount. 12 keeps a boosted 90-score backend root under a 100+ hypothetical while comfortably
 *    clearing the 58/82 FE-symptom scores it must outrank.
 *  - BLAST_PER_SYMPTOM: per-symptom contribution before weighting; 2 × severity weight.
 *  - SEVERITY_WEIGHT: keyed to the EvidenceCandidate severity enum ('critical'|'high'|'medium'|'low').
 */
export const CAUSAL_RANK_CONSTANTS = {
  MAP_WINDOW_MS: 2000,
  MAX_BLAST_BOOST: 12,
  BLAST_PER_SYMPTOM: 2,
  SEVERITY_WEIGHT: { critical: 4, high: 3, medium: 2, low: 1 },
} as const;

/**
 * Heuristic denylist of third-party analytics / advertising beacon host patterns. A "Failed to
 * fetch" (or network error) whose target host matches one of these is almost never the user facing
 * bug: it is a tracking or ads beacon blocked by the browser's tracking prevention or an ad blocker.
 * Such failures are downranked and their severity reduced (never suppressed) so they cannot drown a
 * genuine first-party failure.
 *
 * This list is intentionally non-exhaustive and safe to extend. Matching is case-insensitive and
 * host-suffix based, so subdomains (for example `www.google-analytics.com`) are covered. A pattern
 * containing a `/` is matched against `host + pathname` so collector paths on otherwise generic
 * hosts (for example `google.com/g/collect`) can be flagged without denylisting the whole host.
 */
export const TRACKER_BEACON_HOST_PATTERNS: readonly string[] = [
  // Google analytics / tag manager / ads
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "googletagservices.com",
  "googlesyndication.com",
  "pagead2.googlesyndication.com",
  "doubleclick.net",
  "stats.g.doubleclick.net",
  "adservice.google.com",
  "google.com/g/collect",
  "google.com/pagead",
  "google.com/ads",
  // Meta / Facebook
  "connect.facebook.net",
  "graph.facebook.com",
  "facebook.com/tr",
  // Product analytics / session replay
  "hotjar.com",
  "segment.com",
  "segment.io",
  "mixpanel.com",
  "cdn.mxpnl.com",
  "amplitude.com",
  "cdn.amplitude.com",
  "fullstory.com",
  "clarity.ms",
  "quantserve.com",
  "scorecardresearch.com",
];

// Correlation window: a fetch-level rejection fired within this many ms of a blocked beacon request
// is treated as that beacon's downstream rejection. Kept tight so we only fold in the beacon's own
// unhandled rejection, not an unrelated failure that merely happened nearby.
const TRACKER_BEACON_CORRELATION_MS = 2_000;

// Ceiling score applied to a confirmed tracker-beacon failure. Low enough to sit beneath a
// first-party 4xx (70) while staying above pure-noise signals, so it is reordered, not hidden.
const TRACKER_BEACON_SCORE = 15;

// Fetch-level rejection detectors that carry no url of their own, so they must be correlated to a
// nearby blocked beacon request to be recognised as beacon noise.
const FETCH_REJECTION_DETECTORS = new Set([
  "unhandled_rejection",
  "uncaught_error",
]);

// Messages that indicate a bare network/fetch failure (the shape a blocked beacon produces). Used
// only to gate the nearby-beacon correlation, never on its own.
const FETCH_FAILURE_MESSAGE_PATTERN =
  /failed to fetch|networkerror|load failed|fetch failed|err_(?:blocked|failed|network)|net::err|blocked by client/i;

export interface EvidenceIndexInput {
  sessionDir: string;
  events: BugEvent[];
  index: {
    id?: string;
    start?: number;
    end?: number;
    dur?: number;
    failedReqs?: Array<{
      t: number;
      m?: string;
      url?: string;
      st?: number;
      id?: string | number;
      reason?: string;
      code?: string;
      message?: string;
      phase?: string;
    }>;
    networkErrors?: Array<{
      t: number;
      offsetMs?: number;
      id?: string | number;
      method?: string;
      m?: string;
      url?: string;
      msg?: string;
      transport?: string;
    }>;
    consoleErrors?: Array<{
      t: number;
      offsetMs?: number;
      lv?: string;
      msg?: string;
      source?: string;
    }>;
    errs?: Array<{
      t: number;
      msg?: string;
      file?: string;
      line?: number;
      col?: number;
      stk?: string;
    }>;
    navs?: Array<{ t: number; to?: string }>;
    tabBoundaries?: Array<{
      t: number;
      offsetMs?: number;
      decision?: string;
      reason?: string;
      nonCapture?: boolean;
      capture?: boolean;
      root?: unknown;
      current?: unknown;
      candidate?: unknown;
      prompt?: unknown;
    }>;
    pageProbe?: {
      errors?: Array<{
        t: number;
        offsetMs?: number;
        phase?: string;
        message?: string;
        source?: string;
      }>;
    };
  };
  /**
   * Optional causal graph (index.causalGraph) used ONLY to re-rank candidates so a downstream
   * symptom cannot outrank its backend root. Treated as read-only; absence → today's behavior.
   */
  causalGraph?: CausalGraph;
}

export interface EvidenceCandidate {
  schemaVersion: typeof CANDIDATE_SCHEMA_VERSION;
  id: string;
  detector: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  score: number;
  confidence: "high" | "medium" | "low";
  anchor: {
    t: number;
    offsetMs?: number;
    route?: string;
    elementLabel?: string;
    requestId?: string;
    method?: string;
    url?: string;
    status?: number;
    errorCode?: string;
    message?: string;
    /**
     * Free-form provenance label: where this signal came from, not where the
     * code is. Values include "backend", a transport name, a probe phase. Do
     * NOT read this as a code location; use `frame`.
     */
    source?: string;
    /**
     * Source location of the failing code as `file:line:col`, when the browser
     * captured one. Minified unless the app ships readable builds; Crumbtrail
     * does not resolve source maps today.
     */
    frame?: string;
    target?: TargetDescriptor;
  };
  /** Causal role assigned by the confidence-gated re-rank (CP3). Additive/optional. */
  causalRole?: "root" | "symptom" | "isolated";
  /** For a symptom, the candidate id of its attributed root cause. */
  rootCauseId?: string;
  /** For a root, the sorted candidate ids of the symptoms attributed to it. */
  causes?: string[];
  /** Weakest edge confidence along the causal path from root to this symptom. */
  attributionConfidence?: CausalConfidence;
  evidenceWindow: { start: number; end: number; windowId: string };
}

interface CandidateDraft extends Omit<
  EvidenceCandidate,
  "schemaVersion" | "id" | "evidenceWindow"
> {
  wideWindow?: boolean;
  dedupeKey: string;
  causalRole?: "root" | "symptom" | "isolated";
  rootCauseId?: string;
  causes?: string[];
  attributionConfidence?: CausalConfidence;
}

interface RequestInfo {
  id: string;
  t: number;
  offsetMs?: number;
  method?: string;
  url?: string;
  route?: string;
}

export function writeEvidenceIndex(
  input: EvidenceIndexInput,
): EvidenceCandidate[] {
  const events = normalizeEvidenceEvents(input.events);
  const index = withNavigationContext(events, input.index);
  const candidates = buildEvidenceCandidates(events, index, input.causalGraph);
  const normalizedInput = { ...input, index };
  const windowsDir = path.join(input.sessionDir, "windows");
  fs.rmSync(windowsDir, { recursive: true, force: true });
  fs.mkdirSync(windowsDir, { recursive: true });

  fs.writeFileSync(
    path.join(input.sessionDir, "CANDIDATES.md"),
    renderCandidatesMarkdown(candidates, normalizedInput),
  );
  fs.writeFileSync(
    path.join(input.sessionDir, "candidates.jsonl"),
    renderCandidatesJsonl(candidates),
  );
  fs.writeFileSync(
    path.join(input.sessionDir, "timeline.md"),
    renderTimelineMarkdown(events, index),
  );
  fs.writeFileSync(
    path.join(input.sessionDir, "search.jsonl"),
    renderSearchJsonl(events, candidates, index),
  );

  for (const candidate of candidates) {
    fs.writeFileSync(
      path.join(windowsDir, `${candidate.id}.md`),
      renderWindowMarkdown(candidate, events, index),
    );
  }

  return candidates;
}

function normalizeEvidenceEvents(events: BugEvent[]): BugEvent[] {
  return events.flatMap((event) => {
    const t = finiteSafeTimestamp(event.t);
    const k =
      typeof event.k === "string" && event.k.length > 0 ? event.k : undefined;
    if (t === undefined || k === undefined) return [];
    return [{ ...event, t, k, d: isRecord(event.d) ? event.d : {} }];
  });
}

export function buildEvidenceCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  causalGraph?: CausalGraph,
): EvidenceCandidate[] {
  index = withNavigationContext(events, index);
  const requestById = collectRequests(events);
  const responseIds = new Set<string>();
  const drafts: CandidateDraft[] = [];

  for (const event of events) {
    if (event.k === "net.res") responseIds.add(String(event.d.id ?? ""));
  }

  for (const failed of index.failedReqs ?? []) {
    // Network-level failures (no HTTP response) are counted in failedReqs but
    // already surface as network_error candidates via index.networkErrors —
    // an "HTTP 0" candidate here would double-count the same failure.
    if (failed.reason === "network_error") continue;
    const response = responseForFailedRequest(events, failed);
    const reqId = requestIdForEvent(response);
    const req = reqId ? requestById.get(reqId) : undefined;
    const detector =
      failed.reason === "application_failure"
        ? "app_2xx_failure"
        : "http_error";
    drafts.push({
      detector,
      title:
        failed.reason === "application_failure"
          ? `Application failure in ${failed.m || req?.method || "request"} ${redactUrl(failed.url || req?.url || "")}`
          : `HTTP ${failed.st ?? "error"} from ${failed.m || req?.method || "request"} ${redactUrl(failed.url || req?.url || "")}`,
      severity:
        failed.reason === "application_failure" || (failed.st ?? 0) >= 500
          ? "high"
          : "medium",
      score:
        failed.reason === "application_failure"
          ? 95
          : (failed.st ?? 0) >= 500
            ? 90
            : 70,
      confidence: "high",
      anchor: removeUndefined({
        t: failed.t,
        offsetMs:
          offsetForEvent(response) ?? offsetFromStart(failed.t, index.start),
        route: routeAt(index.navs ?? [], failed.t),
        requestId: reqId,
        method: failed.m || req?.method,
        url: redactUrl(failed.url || req?.url),
        status: failed.st,
        errorCode: scrubText(failed.code, 160),
        message: scrubText(failed.message, 220),
        source: failed.reason,
      }),
      dedupeKey: `failed:${reqId ?? failed.t}:${failed.reason ?? ""}:${failed.st ?? ""}:${failed.code ?? ""}`,
    });
  }

  for (const entry of index.networkErrors ?? []) {
    const requestId = requestIdForValue(entry);
    drafts.push({
      detector: "network_error",
      title: `Network error from ${entry.method || entry.m || "request"} ${redactUrl(entry.url || "")}`,
      severity: "high",
      score: 86,
      confidence: "high",
      anchor: removeUndefined({
        t: entry.t,
        offsetMs: entry.offsetMs ?? offsetFromStart(entry.t, index.start),
        route: routeAt(index.navs ?? [], entry.t),
        requestId,
        method: entry.method || entry.m,
        url: redactUrl(entry.url),
        message: scrubText(entry.msg, 220),
        source: entry.transport,
      }),
      dedupeKey: `neterr:${requestId ?? entry.t}:${entry.method ?? entry.m ?? ""}:${entry.url ?? ""}:${entry.msg ?? ""}`,
    });
  }

  for (const entry of index.consoleErrors ?? []) {
    drafts.push({
      detector: "console_error",
      title: `Console error: ${scrubText(entry.msg, 100) ?? "message unavailable"}`,
      severity: "medium",
      score: 58,
      confidence: "medium",
      anchor: removeUndefined({
        t: entry.t,
        offsetMs: entry.offsetMs ?? offsetFromStart(entry.t, index.start),
        route: routeAt(index.navs ?? [], entry.t),
        message: scrubText(entry.msg, 220),
        source: entry.source,
      }),
      // Key on content signature (message+route), not the volatile timestamp, so a component that
      // re-renders and re-logs the same console error collapses into one candidate (dedupeDrafts
      // keeps the earliest anchor). Aligns with distinct-bugs.ts normalizeSignature.
      dedupeKey: `console:${normalizeErrorSignature(entry.msg)}:${routeAt(index.navs ?? [], entry.t) ?? ""}`,
    });
  }

  for (const entry of index.errs ?? []) {
    const event = events.find(
      (candidate) =>
        candidate.t === entry.t &&
        (candidate.k === "err" || candidate.k === "rej"),
    );
    drafts.push({
      detector: event?.k === "rej" ? "unhandled_rejection" : "uncaught_error",
      title: `${event?.k === "rej" ? "Unhandled rejection" : "Uncaught error"}: ${scrubText(entry.msg, 100) ?? "message unavailable"}`,
      severity: "high",
      score: 82,
      confidence: "high",
      anchor: removeUndefined({
        t: entry.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(entry.t, index.start),
        route: routeAt(index.navs ?? [], entry.t),
        message: scrubText(entry.msg, 220),
        frame: codeFrameOf(entry),
      }),
      // Content-signature dedupe: a repeatedly re-thrown TypeError (same message + route) collapses
      // to one candidate instead of one-per-timestamp. Keep err vs rej distinct (different bug type).
      dedupeKey: `runtime:${event?.k === "rej" ? "rej" : "err"}:${normalizeErrorSignature(entry.msg)}:${routeAt(index.navs ?? [], entry.t) ?? ""}`,
    });
  }

  for (const entry of index.pageProbe?.errors ?? []) {
    drafts.push({
      detector: "page_probe_failure",
      title: `Page probe failure${entry.phase ? ` during ${entry.phase}` : ""}`,
      severity: "medium",
      score: 62,
      confidence: "high",
      anchor: removeUndefined({
        t: entry.t,
        offsetMs: entry.offsetMs ?? offsetFromStart(entry.t, index.start),
        route: routeAt(index.navs ?? [], entry.t),
        message: scrubText(entry.message, 220),
        source: entry.source ?? entry.phase,
      }),
      dedupeKey: `probe:${entry.t}:${entry.phase ?? ""}:${entry.message ?? ""}`,
    });
  }

  for (const boundary of index.tabBoundaries ?? []) {
    if (boundary.nonCapture !== true && boundary.capture !== false) continue;
    drafts.push({
      detector: "tab_boundary_gap",
      title: `Tab boundary non-capture${boundary.reason ? `: ${boundary.reason}` : ""}`,
      severity: "low",
      score: 35,
      confidence: "high",
      anchor: removeUndefined({
        t: boundary.t,
        offsetMs: boundary.offsetMs ?? offsetFromStart(boundary.t, index.start),
        route: routeAt(index.navs ?? [], boundary.t),
        message: scrubText(boundary.reason, 180),
        source: boundary.decision,
      }),
      dedupeKey: `tab:${boundary.t}:${boundary.decision ?? ""}:${boundary.reason ?? ""}`,
    });
  }

  addRepeatedClickCandidates(events, index, drafts);
  addSlowRequestCandidates(events, index, requestById, drafts);
  addPendingRequestCandidates(index, requestById, responseIds, drafts);
  addIneffectiveSubmitCandidates(events, index, drafts);
  addMediaDegradationCandidates(events, index, drafts);
  addVoiceMarkerCandidates(events, index, drafts);
  addTranscriptComplaintCandidates(events, index, drafts);
  addConsoleWarningCandidates(events, index, drafts);
  addOtelErrorCandidates(events, index, drafts);
  addBackendErrorCandidates(events, index, drafts);
  addDbDiffCandidates(events, index, drafts);
  const mutatingRequests = collectMutatingRequests(events);
  addDbDeltaMismatchCandidates(events, index, drafts, mutatingRequests);
  addIneffectiveInputCandidates(events, index, drafts, mutatingRequests);
  addUiArithmeticMismatchCandidates(events, index, drafts);
  addUiApiDivergenceCandidates(events, index, drafts);
  addOtelDbActivityCandidates(events, index, drafts);

  // Downrank known third-party analytics/ads beacon failures before dedupe/ranking so a blocked
  // tracker beacon cannot outrank (or drown) a genuine first-party failure. Ranking-only in spirit:
  // it lowers score/severity for beacon noise but never removes a candidate.
  downrankTrackerBeacons(drafts, events, index);

  const deduped = dedupeDrafts(drafts);
  // Baseline order (score desc, anchor.t asc, dedupeKey asc). The causal re-rank below only reorders
  // symptoms relative to their roots; absent a graph it is a no-op and this order is preserved.
  const ordered = deduped.sort(
    (a, b) =>
      b.score - a.score ||
      a.anchor.t - b.anchor.t ||
      a.dedupeKey.localeCompare(b.dedupeKey),
  );

  // --- Confidence-gated causal re-rank ---------------------------------------------------------
  // Ranking-only: never mutates the emitted `score`. Uses dedupeKey as the stable per-candidate id
  // (final cand_XXXX ids do not exist yet). Absent/empty graph → attribution is all-isolated → the
  // comparator degrades to the baseline order above.
  applyCausalRerank(ordered, causalGraph);

  // Cap emitted candidates after re-ranking so the highest-priority items survive the truncation.
  ordered.splice(MAX_EVIDENCE_CANDIDATES);

  const windows = mergeWindowRanges(
    ordered.map((draft) => ({
      start: Math.max(0, draft.anchor.t - (draft.wideWindow ? 30_000 : 15_000)),
      end: draft.anchor.t + (draft.wideWindow ? 90_000 : 45_000),
    })),
  );

  // Map dedupeKey → final candidate id (available only after ordering) so rootCauseId/causes can
  // reference emitted ids rather than internal dedupe keys.
  const idByDedupeKey = new Map<string, string>();
  ordered.forEach((draft, index) =>
    idByDedupeKey.set(
      draft.dedupeKey,
      `cand_${String(index + 1).padStart(4, "0")}`,
    ),
  );

  return ordered.map((draft, index) => {
    const id = `cand_${String(index + 1).padStart(4, "0")}`;
    const window = windows.find(
      (candidateWindow) =>
        draft.anchor.t >= candidateWindow.start &&
        draft.anchor.t <= candidateWindow.end,
    ) ?? { start: draft.anchor.t, end: draft.anchor.t };
    const rootCauseId = draft.rootCauseId
      ? idByDedupeKey.get(draft.rootCauseId)
      : undefined;
    const causes = draft.causes
      ? draft.causes
          .map((key) => idByDedupeKey.get(key))
          .filter((v): v is string => v !== undefined)
          .sort((a, b) => a.localeCompare(b))
      : undefined;
    return {
      schemaVersion: CANDIDATE_SCHEMA_VERSION,
      id,
      detector: draft.detector,
      title: draft.title,
      severity: draft.severity,
      score: draft.score,
      confidence: draft.confidence,
      anchor: draft.anchor,
      ...(draft.causalRole ? { causalRole: draft.causalRole } : {}),
      ...(rootCauseId ? { rootCauseId } : {}),
      ...(causes && causes.length > 0 ? { causes } : {}),
      ...(draft.attributionConfidence
        ? { attributionConfidence: draft.attributionConfidence }
        : {}),
      evidenceWindow: {
        start: window.start,
        end: window.end,
        windowId: `win_${String(windows.indexOf(window) + 1).padStart(4, "0")}`,
      },
    };
  });
}

/**
 * Confidence-gated, causal-graph-driven re-rank. RANKING-ONLY: mutates draft ordering (and the
 * additive causal tag fields) but NEVER the emitted `score`. Uses `dedupeKey` as each draft's stable
 * identity. With no/empty graph, attribution is all-isolated and the baseline order is preserved.
 *
 * Gates (per attributionConfidence of the symptom→root link):
 *  - high symptom   → collapse: never eligible for ranked[0]; ordered strictly after ALL roots (kept
 *                     in output, appended to its root's causes).
 *  - medium symptom → demote+keep: ordered strictly after its own root, but may interleave with other
 *                     roots by score (still after all roots via tier, actually — see rankTier).
 *  - low symptom    → annotate only: order preserved; tags only.
 *
 * The comparator produces a total, deterministic order derived solely from per-draft fields.
 */
function applyCausalRerank(
  ordered: CandidateDraft[],
  causalGraph?: CausalGraph,
): void {
  // Baseline rank position (from the score-sorted `ordered`) is the stable fallback key so that,
  // absent causal relations, order is byte-identical to today.
  const baselineRank = new Map<string, number>();
  ordered.forEach((draft, i) => baselineRank.set(draft.dedupeKey, i));

  if (causalGraph && causalGraph.nodes.length > 0) {
    const detectorByKey = new Map<string, string>();
    for (const draft of ordered)
      detectorByKey.set(draft.dedupeKey, draft.detector);

    const attribution = attributeCandidates(
      causalGraph,
      ordered.map((draft) => ({
        id: draft.dedupeKey,
        anchor: {
          t: draft.anchor.t,
          requestId: draft.anchor.requestId,
          route: draft.anchor.route,
        },
      })),
      (id) => detectorByKey.get(id),
    );

    for (const draft of ordered) {
      const attr = attribution.get(draft.dedupeKey);
      if (!attr) continue;
      draft.causalRole = attr.causalRole;
      if (attr.rootCauseId !== undefined) draft.rootCauseId = attr.rootCauseId;
      if (attr.causes !== undefined) draft.causes = attr.causes;
      if (attr.attributionConfidence !== undefined)
        draft.attributionConfidence = attr.attributionConfidence;
    }
  }

  // Blast-radius boost (ranking-only): each root's effective score rises by a bounded amount driven
  // by the severity of the symptoms it explains. Symptoms/isolated get no boost.
  const boostByKey = new Map<string, number>();
  for (const draft of ordered) {
    if (
      draft.causalRole !== "root" ||
      !draft.causes ||
      draft.causes.length === 0
    )
      continue;
    let raw = 0;
    for (const symptomKey of draft.causes) {
      const symptom = ordered.find((d) => d.dedupeKey === symptomKey);
      const weight = symptom
        ? CAUSAL_RANK_CONSTANTS.SEVERITY_WEIGHT[symptom.severity]
        : 1;
      raw += weight * CAUSAL_RANK_CONSTANTS.BLAST_PER_SYMPTOM;
    }
    boostByKey.set(
      draft.dedupeKey,
      Math.min(CAUSAL_RANK_CONSTANTS.MAX_BLAST_BOOST, raw),
    );
  }

  // Rank tier: roots + isolated (0) precede high/medium demoted symptoms (1). Low symptoms are NOT
  // demoted (annotate-only) → tier 0, order preserved.
  const rankTier = (draft: CandidateDraft): number => {
    if (
      draft.causalRole === "symptom" &&
      (draft.attributionConfidence === "high" ||
        draft.attributionConfidence === "medium")
    ) {
      return 1;
    }
    return 0;
  };
  const effectiveScore = (draft: CandidateDraft): number =>
    draft.score + (boostByKey.get(draft.dedupeKey) ?? 0);

  ordered.sort((a, b) => {
    const ta = rankTier(a);
    const tb = rankTier(b);
    if (ta !== tb) return ta - tb;
    // Within a tier, higher effective (ranking) score first.
    const sa = effectiveScore(a);
    const sb = effectiveScore(b);
    if (sa !== sb) return sb - sa;
    // Deterministic tie-breaks: anchor time asc, then dedupeKey asc (matches the historical order).
    if (a.anchor.t !== b.anchor.t) return a.anchor.t - b.anchor.t;
    return a.dedupeKey.localeCompare(b.dedupeKey);
  });

  // Guarantee: every demoted (high/medium) symptom orders strictly AFTER its root. The tier already
  // pushes all demoted symptoms below all roots, so any symptom whose root is a tier-0 draft is
  // satisfied. A symptom attributed to another (rare) demoted symptom is still after its root because
  // the root precedes it in the same tier by effective score / tie-break; enforce explicitly for
  // safety without disturbing determinism.
  enforceRootBeforeSymptom(ordered, baselineRank);
}

/**
 * Deterministic stable pass ensuring each symptom appears after its rootCauseId. Uses a single
 * left-to-right sweep: if a symptom is encountered before its root, the root is spliced in just
 * before the symptom. Order among already-correct items is untouched. Idempotent.
 */
function enforceRootBeforeSymptom(
  ordered: CandidateDraft[],
  _baselineRank: Map<string, number>,
): void {
  const indexByKey = () => {
    const m = new Map<string, number>();
    ordered.forEach((d, i) => m.set(d.dedupeKey, i));
    return m;
  };
  let moved = true;
  let guard = 0;
  while (moved && guard < ordered.length + 1) {
    moved = false;
    guard++;
    const pos = indexByKey();
    for (let i = 0; i < ordered.length; i++) {
      const draft = ordered[i];
      const rootKey = draft.rootCauseId;
      if (!rootKey) continue;
      const rootPos = pos.get(rootKey);
      if (rootPos === undefined) continue;
      if (rootPos > i) {
        // Root is after its symptom: move the root to just before the symptom.
        const [root] = ordered.splice(rootPos, 1);
        ordered.splice(i, 0, root);
        moved = true;
        break;
      }
    }
  }
}

function addRepeatedClickCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const clicksByLabel = new Map<string, BugEvent[]>();
  for (const event of events) {
    if (event.k !== "clk") continue;
    const label = elementLabel(event) ?? "unknown element";
    const clicks = clicksByLabel.get(label) ?? [];
    clicks.push(event);
    clicksByLabel.set(label, clicks);
  }

  for (const [label, clicks] of clicksByLabel) {
    clicks.sort((a, b) => a.t - b.t);
    let start = 0;
    let end = 0;
    while (start < clicks.length) {
      const first = clicks[start];
      while (end < clicks.length && clicks[end].t - first.t <= 3_000) end++;
      const groupLength = end - start;
      if (groupLength < 3) {
        start++;
        if (end < start) end = start;
        continue;
      }
      drafts.push({
        detector: "repeated_clicks",
        title: `Repeated clicks on ${scrubText(label, 100)}`,
        severity: "medium",
        score: 55 + Math.min(10, groupLength),
        confidence: "medium",
        anchor: removeUndefined({
          t: first.t,
          offsetMs:
            offsetForEvent(first) ?? offsetFromStart(first.t, index.start),
          route: routeAt(index.navs ?? [], first.t),
          target: targetForEvent(first),
          elementLabel: scrubText(label, 160),
          message: `${groupLength} clicks within 3s`,
        }),
        dedupeKey: `repeat:${label}:${first.t}`,
      });
      start = end;
    }
  }
}

function addSlowRequestCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  requests: Map<string, RequestInfo>,
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const dur = finiteNumber(event.d.dur);
    if (dur === undefined || dur < 5_000) continue;
    const requestId = safeText(event.d.id, 120);
    const req = requestId ? requests.get(requestId) : undefined;
    drafts.push({
      detector: "slow_request",
      title:
        `Slow request ${req?.method ?? ""} ${redactUrl(req?.url ?? "")}`.trim(),
      severity: dur >= 15_000 ? "high" : "medium",
      score: dur >= 15_000 ? 78 : 64,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        method: req?.method,
        url: redactUrl(req?.url),
        status: finiteNumber(event.d.st),
        message: `${Math.round(dur)} ms`,
      }),
      dedupeKey: `slow:${requestId ?? event.t}`,
    });
  }
}

function addPendingRequestCandidates(
  index: EvidenceIndexInput["index"],
  requests: Map<string, RequestInfo>,
  responseIds: Set<string>,
  drafts: CandidateDraft[],
): void {
  const sessionEnd = finiteNumber(index.end) ?? 0;
  for (const req of requests.values()) {
    if (responseIds.has(req.id)) continue;
    drafts.push({
      detector: "pending_request",
      title:
        `Pending request ${req.method ?? ""} ${redactUrl(req.url ?? "")}`.trim(),
      severity: "medium",
      score: 60,
      confidence: "high",
      anchor: removeUndefined({
        t: sessionEnd > 0 ? sessionEnd : req.t,
        offsetMs: offsetFromStart(
          sessionEnd > 0 ? sessionEnd : req.t,
          index.start,
        ),
        route: routeAt(index.navs ?? [], req.t),
        requestId: req.id,
        method: req.method,
        url: redactUrl(req.url),
        message: "Request had no matching response by session end",
      }),
      dedupeKey: `pending:${req.id}`,
    });
  }
}

function addIneffectiveSubmitCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const activityTimes = events
    .filter(
      (event) =>
        isNavigationEvent(event) ||
        event.k === "net.req" ||
        event.k === "net.res",
    )
    .map((event) => event.t)
    .sort((a, b) => a - b);
  for (const event of events) {
    if (event.k !== "clk") continue;
    const label = elementLabel(event) ?? "";
    if (
      !/(submit|save|sync|continue|checkout|send|create|update|confirm)/i.test(
        label,
      )
    )
      continue;
    const hasActivity = hasActivityWithin(activityTimes, event.t, 3_000);
    if (hasActivity) continue;
    drafts.push({
      detector: "ineffective_submit",
      title: `Submit-like click had no navigation or network activity: ${scrubText(label, 100)}`,
      severity: "medium",
      score: 52,
      confidence: "medium",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        target: targetForEvent(event),
        elementLabel: scrubText(label, 160),
        message: "No nav, net.req, or net.res within 3s",
      }),
      dedupeKey: `ineffective:${event.t}:${label}`,
    });
  }
}

function hasActivityWithin(
  activityTimes: number[],
  t: number,
  windowMs: number,
): boolean {
  let lo = 0;
  let hi = activityTimes.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (activityTimes[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo < activityTimes.length && activityTimes[lo] - t <= windowMs;
}

function addMediaDegradationCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "media.video" && event.k !== "media.voice") continue;
    const state = safeText(event.d.state, 80);
    const code = safeText(event.d.code, 120);
    if (state !== "error" && state !== "degraded" && code === undefined)
      continue;
    const capability =
      safeText(event.d.capability, 80) ??
      (event.k === "media.video" ? "video" : "audio");
    drafts.push({
      detector: "media_degradation",
      title: `${capability} capture degraded${code ? `: ${code}` : ""}`,
      severity: event.k === "media.video" ? "medium" : "low",
      score: event.k === "media.video" ? 56 : 42,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        errorCode: scrubText(code, 160),
        message: scrubText(event.d.message, 220),
        source: capability,
      }),
      dedupeKey: `media:${event.t}:${event.k}:${code ?? state ?? ""}`,
    });
  }
}

function addVoiceMarkerCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "media.voice" || event.d.state !== "marker-added") continue;
    const label = safeText(event.d.label, 160);
    drafts.push({
      detector: "user_marker",
      title: `User marker${label ? `: ${scrubText(label, 100)}` : ""}`,
      severity: "low",
      score: 45,
      confidence: "high",
      wideWindow: true,
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        message: scrubText(label, 220),
        source: safeText(event.d.markerId, 120),
      }),
      dedupeKey: `marker:${event.t}:${label ?? ""}`,
    });
  }
}

function addTranscriptComplaintCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const complaintPattern =
    /\b(error|failed|failure|broken|stuck|not working|doesn'?t work|can't|cannot|won't|problem|issue)\b/i;
  for (const event of events) {
    if (event.k !== "tx") continue;
    const text = safeText(event.d.text, 500);
    if (!text || !complaintPattern.test(text)) continue;
    drafts.push({
      detector: "transcript_complaint",
      title: `Transcript complaint: ${scrubText(text, 100)}`,
      severity: "low",
      score: 48,
      confidence: "medium",
      wideWindow: true,
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        message: scrubText(text, 220),
      }),
      dedupeKey: `tx:${event.t}:${text}`,
    });
  }
}

const OTEL_SPAN_KIND = "backend.otel.span";
const OTEL_LOG_KIND = "backend.otel.log";

function otelHttpStatus(attributes: unknown): number | undefined {
  if (!isRecord(attributes)) return undefined;
  return (
    finiteNumber(attributes["http.response.status_code"]) ??
    finiteNumber(attributes["http.status_code"])
  );
}

function addConsoleWarningCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  // Maximum visibility: surface every console.warn (deduped by content), not just errors.
  // console.warn is never summarized into the index, so scan raw events.
  for (const event of events) {
    if (event.k !== "con") continue;
    if (!safeText(event.d.lv, 20)?.toLowerCase().startsWith("warn")) continue;
    const message = scrubText(consoleMessage(event.d), 220);
    drafts.push({
      detector: "console_warning",
      title: `Console warning: ${scrubText(consoleMessage(event.d), 100) ?? "message unavailable"}`,
      severity: "low",
      score: 50,
      confidence: "low",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        message,
        source: safeText(event.d.source, 80),
      }),
      // Content-signature dedupe (message + route), not the volatile timestamp, so a warning that
      // re-fires every render (React key/deprecation warnings) collapses into one candidate.
      // Mirrors the console_error/runtime dedupe above; dedupeDrafts keeps the earliest anchor.
      dedupeKey: `conwarn:${normalizeErrorSignature(consoleMessage(event.d))}:${routeAt(index.navs ?? [], event.t) ?? ""}`,
    });
  }
}

function addBackendErrorCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  // Backend errors are NOT summarized into the SessionIndex — scan raw events.
  // Shared dedupe namespace collapses a request that emits both backend.req.error
  // and backend.req.end into a single candidate (the higher score wins via dedupeDrafts).
  for (const event of events) {
    // backend.uncaught (auto-captured crash) is request-less but still a backend
    // error: fold it into the same high-severity backend_request_error candidate
    // path as backend.req.error (its dedupeKey falls back to the event time).
    const isError =
      event.k === "backend.req.error" || event.k === "backend.uncaught";
    const isEnd = event.k === "backend.req.end";
    if (!isError && !isEnd) continue;

    const error = isRecord(event.d.error) ? event.d.error : undefined;
    const status =
      finiteNumber(event.d.statusCode) ?? finiteNumber(error?.statusCode);
    const requestId = safeText(event.d.requestId, 120);

    let detector: string;
    let severity: CandidateDraft["severity"];
    let score: number;
    if (isError) {
      detector = "backend_request_error";
      severity = "high";
      score = 90;
    } else if ((status ?? 0) >= 500) {
      detector = "backend_http_error";
      severity = "high";
      score = 89;
    } else if ((status ?? 0) >= 400) {
      detector = "backend_http_client_error";
      severity = "medium";
      score = 66;
    } else {
      continue;
    }

    const method = safeText(event.d.method, 20);
    const route = redactUrl(event.d.route) ?? redactUrl(event.d.pathname);
    const errorCode = safeText(error?.code, 160) ?? safeText(error?.name, 160);
    const message = scrubText(error?.message, 220);

    drafts.push({
      detector,
      title:
        `Backend ${status ? `HTTP ${status}` : "error"} from ${method ?? "request"} ${route ?? ""}`.trim(),
      severity,
      score,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route,
        requestId,
        method,
        status,
        errorCode,
        message,
        source: "backend",
      }),
      // Key on requestId alone (not status): a thrown error event often carries no statusCode
      // while the response's end event carries e.g. 500 — including status would split one
      // request into two candidates. dedupeDrafts keeps the higher-scored error.
      dedupeKey: `backend:${requestId ?? event.t}`,
    });
  }
}

function addOtelErrorCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k === OTEL_SPAN_KIND) {
      const status = otelHttpStatus(event.d.attributes);
      const isError = event.d.statusCode === "ERROR" || (status ?? 0) >= 500;
      if (!isError) continue;
      const name = scrubText(event.d.name, 160);
      const service = safeText(event.d.serviceName, 80);
      const traceId = safeText(event.d.traceId, 120);
      drafts.push({
        detector: "otel_span_error",
        title: `OTel span error${status ? ` (HTTP ${status})` : ""}: ${name ?? "span"}${service ? ` [${service}]` : ""}`,
        severity: "high",
        score: 88,
        confidence: "high",
        anchor: removeUndefined({
          t: event.t,
          offsetMs:
            offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
          route: routeAt(index.navs ?? [], event.t),
          requestId: traceId,
          status,
          message:
            scrubText(event.d.statusMessage, 220) ?? scrubText(name, 220),
          source: service,
        }),
        dedupeKey: `otelspan:${safeText(event.d.spanId, 120) ?? event.t}:${event.d.statusCode ?? ""}:${status ?? ""}`,
      });
    } else if (event.k === OTEL_LOG_KIND) {
      const severityNumber = finiteNumber(event.d.severityNumber);
      const severityText = safeText(event.d.severityText, 40)?.toUpperCase();
      const isError =
        (severityNumber !== undefined && severityNumber >= 17) ||
        severityText === "ERROR" ||
        severityText === "FATAL";
      if (!isError) continue;
      const service = safeText(event.d.serviceName, 80);
      const traceId = safeText(event.d.traceId, 120);
      const body = scrubText(event.d.body, 100);
      drafts.push({
        detector: "otel_log_error",
        title: `OTel ${severityText ?? "error"} log: ${body ?? "message unavailable"}`,
        severity: "high",
        score: 80,
        confidence: "high",
        anchor: removeUndefined({
          t: event.t,
          offsetMs:
            offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
          route: routeAt(index.navs ?? [], event.t),
          requestId: traceId,
          message: scrubText(event.d.body, 220),
          source: service,
        }),
        dedupeKey: `otellog:${event.t}:${traceId ?? ""}:${body ?? ""}`,
      });
    }
  }
}

const DB_DIFF_ADJACENCY_MS = 5_000;

interface ErrorMoment {
  t: number;
  requestId?: string;
}

function collectErrorMoments(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): ErrorMoment[] {
  const moments: ErrorMoment[] = [];

  for (const event of events) {
    if (
      event.k === "net.res" &&
      finiteNumber(event.d.st) !== undefined &&
      (finiteNumber(event.d.st) ?? 0) >= 400
    ) {
      moments.push({ t: event.t, requestId: safeText(event.d.requestId, 120) });
    } else if (event.k === "err" || event.k === "rej") {
      moments.push({ t: event.t });
    } else if (
      event.k === "backend.req.error" ||
      event.k === "backend.uncaught"
    ) {
      // backend.uncaught carries no requestId; safeText returns undefined then.
      moments.push({ t: event.t, requestId: safeText(event.d.requestId, 120) });
    } else if (event.k === "net.err") {
      moments.push({ t: event.t });
    } else if (
      event.k === "con" &&
      safeText(event.d.lv, 20)?.toLowerCase().startsWith("err")
    ) {
      moments.push({ t: event.t });
    } else if (event.k === "backend.otel.span") {
      const status = otelHttpStatus(event.d.attributes);
      if (event.d.statusCode === "ERROR" || (status ?? 0) >= 500) {
        moments.push({
          t: event.t,
          requestId:
            safeText(event.d.traceId, 120) ?? safeText(event.d.requestId, 120),
        });
      }
    } else if (event.k === "backend.otel.log") {
      const severityNumber = finiteNumber(event.d.severityNumber);
      const severityText = safeText(event.d.severityText, 40)?.toUpperCase();
      if (
        (severityNumber !== undefined && severityNumber >= 17) ||
        severityText === "ERROR" ||
        severityText === "FATAL"
      ) {
        moments.push({ t: event.t, requestId: safeText(event.d.traceId, 120) });
      }
    }
  }

  for (const failed of index.failedReqs ?? []) moments.push({ t: failed.t });
  for (const entry of index.networkErrors ?? []) moments.push({ t: entry.t });
  for (const entry of index.consoleErrors ?? []) moments.push({ t: entry.t });
  for (const entry of index.errs ?? []) moments.push({ t: entry.t });

  return moments;
}

function addDbDiffCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const dbDiffs = events.filter((event) => event.k === "db.diff");
  if (dbDiffs.length === 0) return;

  // Maximum visibility: always surface db.diffs (the subtle data-correctness bugs a logger
  // most wants to catch). A diff adjacent to an error ranks high (88); a standalone diff ranks
  // low (40) so it never buries real errors but still appears — and, absent any error, becomes
  // ranked[0] so its evidence window covers the diff for fix-context.
  const errorMoments = collectErrorMoments(events, index);

  for (const event of dbDiffs) {
    const requestId = safeText(event.d.requestId, 120);
    const op = safeText(event.d.op, 20) ?? "mutation";
    const table = safeText(event.d.table, 200) ?? "unknown table";

    const adjacent = errorMoments.some(
      (moment) =>
        Math.abs(moment.t - event.t) <= DB_DIFF_ADJACENCY_MS ||
        (requestId !== undefined &&
          moment.requestId !== undefined &&
          moment.requestId === requestId),
    );

    drafts.push({
      detector: "db_mutation",
      // A db.diff adjacent to an error is high-value evidence (ranked like an otel_span_error);
      // a standalone db.diff is surfaced at a low score so it is visible without out-ranking errors.
      title: adjacent
        ? `Database ${op} on ${scrubText(table, 100) ?? "table"} near an error`
        : `Database ${op} on ${scrubText(table, 100) ?? "table"}`,
      severity: adjacent ? "high" : "low",
      score: adjacent ? 88 : 40,
      confidence: adjacent ? "high" : "low",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        message: `${op} on ${table}`,
        source: normalizeDbEngine(event.d.engine),
      }),
      dedupeKey: `dbdiff:${event.t}:${requestId ?? ""}:${op}:${table}`,
    });
  }
}

// ─── Cross-plane invariant detectors (payload ↔ db.diff ↔ response) ───
//
// Both detectors operate per requestId on the correlated triple
// net.req ↔ net.res ↔ db.diff[] and are deliberately silent on ANY ambiguity:
// unparseable or legacy "[REDACTED]" bodies, fuzzy id matches, multi-column
// diffs, and composite pks all produce no signal rather than a guess.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/**
 * Id-like field names: exactly "id"/"ID", snake_case "*_id", or camelCase
 * "*Id" (case-SENSITIVE suffix so "paid"/"valid"/"grid" never match).
 */
const ID_EXACT = /^id$/i;
const ID_CAMEL_SUFFIX = /[a-z0-9]Id$/;
const ID_SNAKE_SUFFIX = /_id$/i;
function isIdLikeField(name: string): boolean {
  return (
    ID_EXACT.test(name) ||
    ID_CAMEL_SUFFIX.test(name) ||
    ID_SNAKE_SUFFIX.test(name)
  );
}
const QTY_LIKE_FIELD = /^(qty|quantity|count|units)$/i;
/** Field names whose values must never be echoed or reasoned about (deny-biased superset of the redaction v2 deny list). */
const SENSITIVE_INPUT_FIELD =
  /pass|pwd|token|secret|auth|key|card|cvv|cvc|ssn|social|email|phone|tel|address|account|iban|pin|otp|credential|session|cookie|bearer/i;
/**
 * Extensible stem→synonym map for ineffective_input. A payload field stem on the
 * left matches response fields / db.diff table names containing the stem itself
 * or any listed synonym.
 */
const INEFFECTIVE_INPUT_STEM_SYNONYMS: Readonly<
  Record<string, readonly string[]>
> = {
  coupon: ["discount", "redemption", "promo"],
  search: ["results"],
  query: ["results"],
};
const MAX_INEFFECTIVE_INPUT_CANDIDATES = 3;
const MAX_BODY_SCOPE_DEPTH = 6;

/** Parses a structured (JSON) network body. Legacy "[REDACTED]", non-JSON, or missing bodies → undefined (no evidence). */
function parseStructuredBody(value: unknown): unknown | undefined {
  if (isRecord(value) || Array.isArray(value)) return value;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text === "[REDACTED]") return undefined;
  if (!text.startsWith("{") && !text.startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) || Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * True for structured-redaction v2 placeholders
 * ({ $redacted: "[REDACTED]", len, charset, hash8? }). These are opaque
 * redacted leaves — their shape metadata must never be enumerated as if it
 * were payload data.
 */
function isRedactedPlaceholder(value: unknown): boolean {
  return isRecord(value) && "$redacted" in value;
}

/** Collects every object scope (top level plus array elements / nested objects) up to a bounded depth. Redacted-placeholder objects are opaque leaves. */
function collectObjectScopes(
  value: unknown,
  out: Record<string, unknown>[] = [],
  depth = 0,
): Record<string, unknown>[] {
  if (depth > MAX_BODY_SCOPE_DEPTH) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectObjectScopes(item, out, depth + 1);
    return out;
  }
  if (!isRecord(value) || isRedactedPlaceholder(value)) return out;
  out.push(value);
  for (const inner of Object.values(value)) {
    if (isRecord(inner) || Array.isArray(inner)) {
      collectObjectScopes(inner, out, depth + 1);
    }
  }
  return out;
}

interface CorrelatedRequest {
  requestId: string;
  reqEvent: BugEvent;
  method: string;
  url?: string;
  body: unknown;
  resBody?: unknown;
  status?: number;
}

/** Maps requestId → mutating net.req (+ correlated net.res body/status). */
function collectMutatingRequests(
  events: BugEvent[],
): Map<string, CorrelatedRequest> {
  const requests = new Map<string, CorrelatedRequest>();
  // db.diff correlation runs on the propagated correlation id (d.requestId),
  // not the transport-local counter (d.id) — browser events carry both and the
  // counter never matches a diff. Legacy fixtures without d.requestId fall back
  // to the transport id so old sessions keep whatever correlation they had.
  for (const event of events) {
    if (event.k !== "net.req") continue;
    const id = safeText(event.d.requestId, 120) ?? requestIdForEvent(event);
    if (!id) continue;
    const method = (
      safeText(event.d.m, 20) ??
      safeText(event.d.method, 20) ??
      ""
    ).toUpperCase();
    if (!MUTATING_METHODS.has(method)) continue;
    requests.set(id, {
      requestId: id,
      reqEvent: event,
      method,
      url: safeText(event.d.url, 400),
      body: event.d.body,
    });
  }
  for (const event of events) {
    if (event.k !== "net.res") continue;
    const id = safeText(event.d.requestId, 120) ?? requestIdForEvent(event);
    if (!id) continue;
    const entry = requests.get(id);
    if (!entry) continue;
    entry.resBody = event.d.body;
    entry.status = finiteNumber(event.d.st);
  }
  return requests;
}

interface PayloadIdQty {
  idField: string;
  qtyField: string;
  qtySum: number;
  lines: number;
}

/**
 * Extracts unambiguous (id, qty) pairs from a structured payload. A scope
 * contributes only when it has EXACTLY one id-like and EXACTLY one qty-like
 * field; multiple payload lines targeting the same id are aggregated (summed).
 */
function extractIdQtyPairs(payload: unknown): Map<string, PayloadIdQty> {
  const pairs = new Map<string, PayloadIdQty>();
  for (const scope of collectObjectScopes(payload)) {
    const idEntries = Object.entries(scope).filter(
      ([name, value]) =>
        isIdLikeField(name) &&
        (typeof value === "string" || toFiniteNumber(value) !== undefined),
    );
    const qtyEntries = Object.entries(scope).filter(
      ([name, value]) =>
        QTY_LIKE_FIELD.test(name) && toFiniteNumber(value) !== undefined,
    );
    if (idEntries.length !== 1 || qtyEntries.length !== 1) continue;
    const [idField, idValue] = idEntries[0];
    const [qtyField, qtyValue] = qtyEntries[0];
    const qty = toFiniteNumber(qtyValue);
    if (qty === undefined || qty < 0) continue;
    const key = String(idValue);
    const existing = pairs.get(key);
    if (existing) {
      if (existing.idField !== idField || existing.qtyField !== qtyField) {
        // Conflicting field names for the same id — ambiguous, drop the id entirely.
        pairs.set(key, { idField, qtyField, qtySum: Number.NaN, lines: 0 });
        continue;
      }
      existing.qtySum += qty;
      existing.lines += 1;
    } else {
      pairs.set(key, { idField, qtyField, qtySum: qty, lines: 1 });
    }
  }
  for (const [key, value] of pairs) {
    if (!Number.isFinite(value.qtySum)) pairs.delete(key);
  }
  return pairs;
}

interface InterpretedDiff {
  event: BugEvent;
  table: string;
  column: string;
  delta: number;
}

/**
 * Interprets one db.diff as a single-numeric-column update for the given pk
 * value. Returns undefined when the diff does not target the pk; returns null
 * when it targets the pk but is ambiguous (composite pk, missing images, more
 * than one changed column, or a non-numeric change) — ambiguity silences the pk.
 */
function interpretDiffForPk(
  event: BugEvent,
  pkValue: string,
): InterpretedDiff | null | undefined {
  if (safeText(event.d.op, 20) !== "update") return undefined;
  const pk = event.d.pk;
  if (!isRecord(pk)) return undefined;
  const pkEntries = Object.entries(pk);
  const matches = pkEntries.some(([, value]) => String(value) === pkValue);
  if (!matches) return undefined;
  if (pkEntries.length !== 1) return null; // composite pk → ambiguous
  const before = event.d.before;
  const after = event.d.after;
  if (!isRecord(before) || !isRecord(after)) return null;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    if (String(before[key]) !== String(after[key])) changed.push(key);
  }
  if (changed.length !== 1) return null;
  const column = changed[0];
  const beforeNum = toFiniteNumber(before[column]);
  const afterNum = toFiniteNumber(after[column]);
  if (beforeNum === undefined || afterNum === undefined) return null;
  const table = safeText(event.d.table, 200) ?? "unknown table";
  // Signed per-diff delta; the aggregation takes |sum| so compensated writes net out.
  return { event, table, column, delta: afterNum - beforeNum };
}

/**
 * db_delta_mismatch: payload says "change by qty", the correlated db.diff changed a
 * single numeric column by a different amount. Exact-pairing only; silent on
 * any ambiguity. Uncapped — exact by construction.
 */
function addDbDeltaMismatchCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  mutatingRequests: Map<string, CorrelatedRequest>,
): void {
  const dbDiffs = events.filter((event) => event.k === "db.diff");
  if (dbDiffs.length === 0) return;
  const diffsByRequest = new Map<string, BugEvent[]>();
  for (const event of dbDiffs) {
    const requestId = safeText(event.d.requestId, 120);
    if (!requestId) continue;
    const list = diffsByRequest.get(requestId) ?? [];
    list.push(event);
    diffsByRequest.set(requestId, list);
  }

  for (const request of mutatingRequests.values()) {
    const diffs = diffsByRequest.get(request.requestId);
    if (!diffs || diffs.length === 0) continue;
    const payload = parseStructuredBody(request.body);
    if (payload === undefined) continue; // redacted/unparseable → no evidence
    for (const [pkValue, pair] of extractIdQtyPairs(payload)) {
      let ambiguous = false;
      const matched: InterpretedDiff[] = [];
      for (const diff of diffs) {
        const interpreted = interpretDiffForPk(diff, pkValue);
        if (interpreted === null) {
          ambiguous = true;
          break;
        }
        if (interpreted) matched.push(interpreted);
      }
      if (ambiguous || matched.length === 0) continue;
      // All matched diffs must describe the same table.column, otherwise the
      // summed delta mixes unrelated writes — ambiguous, stay silent.
      const table = matched[0].table;
      const column = matched[0].column;
      if (
        matched.some((diff) => diff.table !== table || diff.column !== column)
      )
        continue;
      // |sum of signed deltas|: compensated writes cancel; epsilon absorbs FP artifacts.
      const deltaSum = Math.abs(
        matched.reduce((sum, diff) => sum + diff.delta, 0),
      );
      if (Math.abs(deltaSum - pair.qtySum) <= 1e-9) continue;
      const anchorEvent = matched[0].event;
      // pkValue comes from a request payload — scrub and length-cap it before
      // echoing into human-readable draft text (same policy as other drafts).
      const safePk = scrubText(pkValue, 120) ?? "[REDACTED]";
      drafts.push({
        detector: "db_delta_mismatch",
        title: `DB delta mismatch: payload ${pair.qtyField}=${pair.qtySum} but ${table}.${column} changed by ${deltaSum}`,
        severity: "high",
        score: 72,
        confidence: "high",
        anchor: removeUndefined({
          t: anchorEvent.t,
          offsetMs:
            offsetForEvent(anchorEvent) ??
            offsetFromStart(anchorEvent.t, index.start),
          route: routeAt(index.navs ?? [], anchorEvent.t),
          requestId: request.requestId,
          method: request.method,
          url: redactUrl(request.url),
          message: `payload ${pair.idField}=${safePk} ${pair.qtyField}=${pair.qtySum} (${pair.lines} line${pair.lines === 1 ? "" : "s"}) vs ${table}.${column} |after−before|=${deltaSum}`,
          source: normalizeDbEngine(anchorEvent.d.engine),
        }),
        dedupeKey: `dbdelta:${request.requestId}:${pkValue}:${table}:${column}`,
      });
    }
  }
}

/** Stems a payload field name: lowercased leading token of camel/snake case (couponCode → coupon). */
function stemFieldName(name: string): string {
  const tokens = name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
  return tokens[0] ?? name.toLowerCase();
}

function matchTermsForStem(stem: string): string[] {
  return [stem, ...(INEFFECTIVE_INPUT_STEM_SYNONYMS[stem] ?? [])];
}

/** Collects lowercase field-name → value entries from a parsed JSON body. */
function collectFieldEntries(
  value: unknown,
  out: Array<[string, unknown]> = [],
  depth = 0,
): Array<[string, unknown]> {
  if (depth > MAX_BODY_SCOPE_DEPTH) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectFieldEntries(item, out, depth + 1);
    return out;
  }
  if (!isRecord(value) || isRedactedPlaceholder(value)) return out;
  for (const [name, inner] of Object.entries(value)) {
    out.push([name.toLowerCase(), inner]);
    collectFieldEntries(inner, out, depth + 1);
  }
  return out;
}

/**
 * Collects numeric [fieldName, value] entries from a parsed JSON body,
 * placeholder-opaque like collectFieldEntries but PRESERVING the original
 * casing so camelCase names ("totalItems") still stem correctly ("total").
 */
function collectNumericFieldEntries(
  value: unknown,
  out: Array<[string, number]> = [],
  depth = 0,
): Array<[string, number]> {
  if (depth > MAX_BODY_SCOPE_DEPTH) return out;
  if (Array.isArray(value)) {
    for (const item of value) collectNumericFieldEntries(item, out, depth + 1);
    return out;
  }
  if (!isRecord(value) || isRedactedPlaceholder(value)) return out;
  for (const [name, inner] of Object.entries(value)) {
    const num = toFiniteNumber(inner);
    if (num !== undefined) out.push([name, num]);
    else collectNumericFieldEntries(inner, out, depth + 1);
  }
  return out;
}

function isZeroOrEmpty(value: unknown): boolean {
  if (value === null || value === false) return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed === "" || toFiniteNumber(trimmed) === 0;
  }
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

/**
 * ineffective_input: a user-input-shaped string field was accepted (2xx) but neither the
 * response body nor any touched db table shows a trace of it. Hint-grade:
 * confidence low, capped at 3 per session, deduped by field name.
 */
function addIneffectiveInputCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
  mutatingRequests: Map<string, CorrelatedRequest>,
): void {
  const tablesByRequest = new Map<string, string[]>();
  for (const event of events) {
    if (event.k !== "db.diff") continue;
    const requestId = safeText(event.d.requestId, 120);
    const table = safeText(event.d.table, 200);
    if (!requestId || !table) continue;
    const list = tablesByRequest.get(requestId) ?? [];
    list.push(table.toLowerCase());
    tablesByRequest.set(requestId, list);
  }

  const byField = new Map<string, CandidateDraft>();
  for (const request of mutatingRequests.values()) {
    if (
      request.status === undefined ||
      request.status < 200 ||
      request.status >= 300
    )
      continue;
    const payload = parseStructuredBody(request.body);
    if (payload === undefined) continue; // legacy "[REDACTED]"/unparseable → silent
    const responseBody = parseStructuredBody(request.resBody);
    if (responseBody === undefined) continue; // no readable response → no evidence
    const responseEntries = collectFieldEntries(responseBody);
    const touchedTables = tablesByRequest.get(request.requestId) ?? [];

    for (const scope of collectObjectScopes(payload)) {
      for (const [name, value] of Object.entries(scope)) {
        if (typeof value !== "string") continue;
        const trimmed = value.trim();
        if (!trimmed || trimmed.length > 64 || trimmed === "[REDACTED]")
          continue;
        if (isIdLikeField(name) || QTY_LIKE_FIELD.test(name)) continue;
        if (SENSITIVE_INPUT_FIELD.test(name)) continue;
        const stem = stemFieldName(name);
        if (SENSITIVE_INPUT_FIELD.test(stem)) continue;
        const terms = matchTermsForStem(stem);
        const matchesTerm = (candidate: string): boolean =>
          terms.some((term) => candidate.includes(term));

        if (touchedTables.some(matchesTerm)) continue; // effect visible in db
        const matchingResponse = responseEntries.filter(([fieldName]) =>
          matchesTerm(fieldName),
        );
        const hasEffect = matchingResponse.some(
          ([, fieldValue]) => !isZeroOrEmpty(fieldValue),
        );
        if (hasEffect) continue;

        const anchorEvent = request.reqEvent;
        const existing = byField.get(name);
        if (existing && existing.anchor.t <= anchorEvent.t) continue;
        byField.set(name, {
          detector: "ineffective_input",
          title: `Input \`${name}\` accepted (${request.status}) but produced no observable effect`,
          severity: "medium",
          score: 55,
          confidence: "low",
          anchor: removeUndefined({
            t: anchorEvent.t,
            offsetMs:
              offsetForEvent(anchorEvent) ??
              offsetFromStart(anchorEvent.t, index.start),
            route: routeAt(index.navs ?? [], anchorEvent.t),
            requestId: request.requestId,
            method: request.method,
            url: redactUrl(request.url),
            status: request.status,
            message: `field \`${name}\` (stem \`${stem}\`) has no matching non-empty response field and no touched table match`,
          }),
          dedupeKey: `ineffinput:${name}`,
        });
      }
    }
  }

  const emitted = [...byField.values()]
    .sort((a, b) => a.anchor.t - b.anchor.t)
    .slice(0, MAX_INEFFECTIVE_INPUT_CANDIDATES);
  drafts.push(...emitted);
}

// ─── Display detectors (ui.num snapshots): ui_arithmetic_mismatch / ui_api_divergence ───
//
// Both operate on `ui.num` snapshots ({region, items:[{label, value, unit?}]})
// emitted by the browser ui-numbers collector. Same deny-biased posture as the
// cross-plane detectors: redacted labels, ambiguous roles, and conflicting response fields
// silence the detector rather than guess.

const MAX_UI_API_DIVERGENCE_CANDIDATES = 3;
/** One cent: the display tolerance unit for on-screen currency comparisons. */
const UI_CENT_EPSILON = 0.01;
/** Absorbs binary-float artifacts on exact-boundary comparisons. */
const UI_FLOAT_SLACK = 1e-9;
const SUBTOTAL_LABEL_RE = /sub[\s_-]?total/i;
const TOTAL_LABEL_RE = /\btotal\b/i;
/** Count-style labels ("Total items", "Item count", "Qty") are counts, never currency totals. */
const COUNT_LABEL_RE = /\b(items?|counts?|qty|quantity|units?)\b/i;
type UiComponentRole = "subtotal" | "tax" | "fee" | "shipping" | "discount";
const UI_COMPONENT_ROLES: ReadonlyArray<[UiComponentRole, RegExp]> = [
  ["subtotal", SUBTOTAL_LABEL_RE],
  ["tax", /\btax(es)?\b/i],
  ["fee", /\bfees?\b/i],
  ["shipping", /\bshipping\b/i],
  ["discount", /\bdiscount\b/i],
];

interface UiNumItem {
  label: string;
  value: number;
  unit?: string;
}

/** Extracts well-formed {label, value, unit?} items from a ui.num snapshot; malformed entries are dropped. */
function uiNumItems(event: BugEvent): UiNumItem[] {
  const items = event.d.items;
  if (!Array.isArray(items)) return [];
  const out: UiNumItem[] = [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const label = safeText(item.label, 120);
    const value = finiteNumber(item.value);
    if (label === undefined || value === undefined) continue;
    const unit = safeText(item.unit, 20);
    out.push(unit === undefined ? { label, value } : { label, value, unit });
  }
  return out;
}

/**
 * Maps a display label to its arithmetic role. Component patterns are checked
 * before the bare total pattern so "Subtotal"/"Sub Total" never reads as a
 * total and qualified totals like "Total tax"/"Total fees"/"Total discount"
 * classify as the component they name, not as THE total. Count-style total
 * labels ("Total items") are counts, not totals → no role.
 */
function uiLabelRole(label: string): UiComponentRole | "total" | undefined {
  for (const [role, pattern] of UI_COMPONENT_ROLES) {
    if (pattern.test(label)) return role;
  }
  if (TOTAL_LABEL_RE.test(label)) {
    if (COUNT_LABEL_RE.test(label)) return undefined;
    return "total";
  }
  return undefined;
}

function formatCents(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

/**
 * ui_arithmetic_mismatch: within one ui.num snapshot the labeled component amounts
 * (subtotal/tax/fee/shipping, minus discount) disagree with the labeled total
 * beyond ε = 1 cent per component. Arithmetic either holds or it doesn't →
 * confidence high, uncapped. Silent on redacted labels, ambiguous roles
 * (no total, multiple totals, or no components), and unit disagreement.
 * qty×price vs line total deferred — ui.num items carry no per-line pairing;
 * the playground display-total regression only needs component-vs-total.
 */
function addUiArithmeticMismatchCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  for (const event of events) {
    if (event.k !== "ui.num") continue;
    const items = uiNumItems(event);
    if (items.length === 0) continue;
    if (items.some((item) => item.label.includes("[REDACTED]"))) continue;
    const region = safeText(event.d.region, 200) ?? "unknown region";

    const totals: UiNumItem[] = [];
    const components: Array<UiNumItem & { role: UiComponentRole }> = [];
    for (const item of items) {
      const role = uiLabelRole(item.label);
      if (role === "total") totals.push(item);
      else if (role !== undefined) components.push({ ...item, role });
    }
    // Ambiguous roles → silent: exactly one total and at least one component required.
    if (totals.length !== 1 || components.length === 0) continue;
    const total = totals[0];
    // When units are present they must agree: a count total vs $ components
    // (or any mixed units among total+components) is not an arithmetic claim.
    const units = new Set(
      [total, ...components]
        .map((item) => item.unit?.trim().toLowerCase())
        .filter((unit): unit is string => unit !== undefined && unit !== ""),
    );
    if (units.size > 1) continue;
    // Discounts are displayed either as positive amounts ("Discount 20") or
    // already-negated ("Discount −20"); subtract the magnitude either way.
    const sum = components.reduce(
      (acc, item) =>
        acc + (item.role === "discount" ? -Math.abs(item.value) : item.value),
      0,
    );
    const epsilon = UI_CENT_EPSILON * components.length;
    if (Math.abs(sum - total.value) <= epsilon + UI_FLOAT_SLACK) continue;

    // Evidence: the snapshot items verbatim (labels already passed the capture-side classifier).
    const itemsText = items
      .map((item) => `${item.label}:${item.value}`)
      .join(", ");
    drafts.push({
      detector: "ui_arithmetic_mismatch",
      title: `UI arithmetic mismatch in ${region}: components sum to ${formatCents(sum)} but ${total.label} shows ${formatCents(total.value)}`,
      severity: "medium",
      score: 60,
      confidence: "high",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        message: scrubText(itemsText, 220),
      }),
      // Region + the two mismatch amounts: re-emits of the same broken region collapse.
      dedupeKey: `uiarith:${region}:${formatCents(sum)}:${formatCents(total.value)}`,
    });
  }
}

/** Normalizes a label/field name for exact matching: lowercase, separators stripped. */
function normalizeFieldName(name: string): string {
  return name.toLowerCase().replace(/[\s_-]+/g, "");
}

const COUNT_SUFFIX_RE = /^(items?|counts?|qty|nums?|numbers?)\b/i;

/**
 * Resolves which response-field entries a UI label compares against. Exact
 * case-normalized full-name matches win; the stem fallback applies only when
 * exactly one distinct same-stem field name exists AND that name does not
 * continue with a count-like suffix ("totalItems"/"totalCount" are counts,
 * not the on-screen amount).
 */
function resolveDivergenceMatches(
  label: string,
  stem: string,
  entries: Array<{ name: string; value: number; requestId?: string }>,
): Array<{ name: string; value: number; requestId?: string }> | undefined {
  const target = normalizeFieldName(label);
  const exact = entries.filter(
    (entry) => normalizeFieldName(entry.name) === target,
  );
  if (exact.length > 0) return exact;
  const stemMatches = entries.filter(
    (entry) => stemFieldName(entry.name) === stem,
  );
  if (stemMatches.length === 0) return undefined;
  const distinctNames = new Set(
    stemMatches.map((entry) => normalizeFieldName(entry.name)),
  );
  if (distinctNames.size !== 1) return undefined;
  const suffix = stemMatches[0].name
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(" ")
    .filter(Boolean)
    .slice(1)
    .join(" ");
  if (suffix && COUNT_SUFFIX_RE.test(suffix)) return undefined;
  return stemMatches;
}

/**
 * C2: a labeled on-screen number differs by more than one cent from a
 * matching numeric field in a net.res body received since the last
 * navigation. Exact (case-normalized) field-name matches are preferred; a
 * stem match is a fallback only when it is unambiguous and not count-like.
 * Silent when no response body parses, the label is redacted, or multiple
 * candidate response fields conflict. Confidence medium, capped at 3 per
 * session, deduped by label stem.
 */
function addUiApiDivergenceCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const uiEvents = events.filter((event) => event.k === "ui.num");
  if (uiEvents.length === 0) return;
  const responses = events.filter((event) => event.k === "net.res");
  const navs = index.navs ?? [];

  const byStem = new Map<string, CandidateDraft>();
  for (const event of uiEvents) {
    // Only responses received since the last navigation before this snapshot
    // count. `navs` is assumed sorted ascending by t. A response at the nav
    // instant belongs to the old page, so the boundary is exclusive (<=).
    let navBoundary = Number.NEGATIVE_INFINITY;
    for (const nav of navs) {
      if (nav.t > event.t) break;
      navBoundary = nav.t;
    }

    const fieldEntries: Array<{
      name: string;
      value: number;
      requestId?: string;
    }> = [];
    for (const response of responses) {
      if (response.t <= navBoundary || response.t > event.t) continue;
      const body = parseStructuredBody(response.d.body);
      if (body === undefined) continue; // unreadable response → no evidence
      const requestId = requestIdForEvent(response);
      for (const [name, value] of collectNumericFieldEntries(body)) {
        fieldEntries.push(
          requestId === undefined ? { name, value } : { name, value, requestId },
        );
      }
    }
    if (fieldEntries.length === 0) continue;

    for (const item of uiNumItems(event)) {
      if (item.label.includes("[REDACTED]")) continue;
      const stem = stemFieldName(item.label);
      if (byStem.has(stem)) continue; // dedupe by label stem, keep the earliest
      const matches = resolveDivergenceMatches(item.label, stem, fieldEntries);
      if (!matches || matches.length === 0) continue;
      // Conflicting candidate response values → ambiguous, stay silent.
      const apiValue = matches[0].value;
      if (
        matches.some(
          (candidate) =>
            Math.abs(candidate.value - apiValue) >
            UI_CENT_EPSILON + UI_FLOAT_SLACK,
        )
      )
        continue;
      if (Math.abs(item.value - apiValue) <= UI_CENT_EPSILON + UI_FLOAT_SLACK)
        continue;

      byStem.set(stem, {
        detector: "ui_api_divergence",
        title: `UI shows ${item.label} ${formatCents(item.value)} but the API reported ${formatCents(apiValue)}`,
        severity: "medium",
        score: 55,
        confidence: "medium",
        anchor: removeUndefined({
          t: event.t,
          offsetMs:
            offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
          route: routeAt(index.navs ?? [], event.t),
          requestId: matches[0].requestId,
          message: scrubText(
            `on-screen \`${item.label}\`=${item.value} vs response field stem \`${stem}\`=${apiValue}`,
            220,
          ),
        }),
        dedupeKey: `uidiverge:${stem}`,
      });
    }
  }

  const emitted = [...byStem.values()]
    .sort((a, b) => a.anchor.t - b.anchor.t)
    .slice(0, MAX_UI_API_DIVERGENCE_CANDIDATES);
  drafts.push(...emitted);
}

function addOtelDbActivityCandidates(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
  drafts: CandidateDraft[],
): void {
  const dbSpans = events.filter(
    (event) =>
      event.k === OTEL_SPAN_KIND &&
      isRecord(event.d.attributes) &&
      hasOtelDbAttributes(event.d.attributes),
  );
  if (dbSpans.length === 0) return;

  const errorMoments = collectErrorMoments(events, index);
  for (const event of dbSpans) {
    const attrs = event.d.attributes as Record<string, unknown>;
    const requestId =
      safeText(event.d.traceId, 120) ?? safeText(event.d.requestId, 120);
    const system =
      safeText(attrs["db.system"], 80) ??
      safeText(attrs["db.name"], 80) ??
      "database";
    const operation =
      safeText(attrs["db.operation"], 80) ??
      safeText(attrs["db.operation.name"], 80);
    const statement =
      scrubText(attrs["db.statement"], 220) ??
      scrubText(attrs["db.query.text"], 220);
    const adjacent = errorMoments.some(
      (moment) =>
        Math.abs(moment.t - event.t) <= DB_DIFF_ADJACENCY_MS ||
        (requestId !== undefined &&
          moment.requestId !== undefined &&
          moment.requestId === requestId),
    );

    drafts.push({
      detector: "otel_db_activity",
      title: adjacent
        ? `OTel DB activity near an error: ${operation ?? statement ?? system}`
        : `OTel DB activity: ${operation ?? statement ?? system}`,
      severity: adjacent ? "high" : "low",
      score: adjacent ? 88 : 40,
      confidence: adjacent ? "high" : "low",
      anchor: removeUndefined({
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        requestId,
        message: statement ?? operation ?? system,
        source: `otel db activity (${system}); statements, not row diffs`,
      }),
      dedupeKey: `oteldb:${safeText(event.d.spanId, 120) ?? event.t}:${requestId ?? ""}:${operation ?? ""}:${statement ?? ""}`,
    });
  }
}

function hasOtelDbAttributes(attrs: Record<string, unknown>): boolean {
  return (
    safeText(attrs["db.system"], 80) !== undefined ||
    safeText(attrs["db.statement"], 220) !== undefined ||
    safeText(attrs["db.operation"], 80) !== undefined ||
    safeText(attrs["db.operation.name"], 80) !== undefined ||
    safeText(attrs["db.query.text"], 220) !== undefined
  );
}

function collectRequests(events: BugEvent[]): Map<string, RequestInfo> {
  const requests = new Map<string, RequestInfo>();
  const navs = collectNavigationContext(events);
  for (const event of events) {
    if (event.k !== "net.req") continue;
    const id = safeText(event.d.id, 120);
    if (!id) continue;
    requests.set(
      id,
      removeUndefined({
        id,
        t: event.t,
        offsetMs: offsetForEvent(event),
        method: safeText(event.d.m, 20) ?? safeText(event.d.method, 20),
        url: safeText(event.d.url, 400),
        route: routeAt(navs, event.t),
      }),
    );
  }
  return requests;
}

function withNavigationContext(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): EvidenceIndexInput["index"] {
  const eventNavs = collectNavigationContext(events);
  if (eventNavs.length === 0) return index;
  const navs = [...(index.navs ?? []), ...eventNavs].sort((a, b) => a.t - b.t);
  return { ...index, navs };
}

function collectNavigationContext(
  events: BugEvent[],
): Array<{ t: number; to?: string }> {
  return events.filter(isNavigationEvent).map((event) =>
    removeUndefined({
      t: event.t,
      to:
        safeText(event.d.to, 240) ??
        safeText(event.d.route, 240) ??
        safeText(event.d.screen, 240) ??
        safeText(event.d.path, 240) ??
        safeText(event.d.name, 240),
    }),
  );
}

function isNavigationEvent(event: BugEvent): boolean {
  return event.k === "nav" || event.k === "navigation";
}

/**
 * Matches the location tail of a stack frame: `file:line:col`, in either the V8
 * (`at fn (URL:12:3)`) or SpiderMonkey (`fn@URL:12:3`) shape. Anchored on the
 * trailing digits so a bare `https://host/a.js` with no position never matches
 * and no half-location is reported as a code frame.
 */
const STACK_FRAME_LOCATION = /((?:https?:\/\/|\/|[A-Za-z]:\\|\w)[^\s()]*?:\d+:\d+)/;

/**
 * The `file:line:col` of the failing code, or undefined when the session never
 * captured one. Prefers the browser's explicit ErrorEvent fields; falls back to
 * the top frame of the stack, which is the only source a rejection has.
 *
 * Returns undefined rather than a partial location: a file with no line sends a
 * reader to the top of a minified bundle, which is not a starting point.
 */
function codeFrameOf(entry: {
  file?: string;
  line?: number;
  col?: number;
  stk?: string;
}): string | undefined {
  if (entry.file && typeof entry.line === "number") {
    const col = typeof entry.col === "number" ? `:${entry.col}` : "";
    return safeText(`${entry.file}:${entry.line}${col}`, 300);
  }
  if (typeof entry.stk !== "string") return undefined;
  // Skip the header line ("TypeError: ..."), which can itself contain a URL.
  for (const line of entry.stk.split("\n").slice(1)) {
    const match = STACK_FRAME_LOCATION.exec(line);
    if (match) return safeText(match[1], 300);
  }
  return undefined;
}

// Normalizes an error message into a stable content signature for dedupe: lowercased, redaction
// markers dropped, digits collapsed to '#', whitespace normalized. Mirrors distinct-bugs.ts
// normalizeSignature so candidate-level dedupe and downstream bug grouping agree.
function normalizeErrorSignature(value: unknown): string {
  const text = safeText(value, 300);
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/\[redacted\]/g, "")
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reduces the score/severity of candidates that are (or correlate to) a blocked third-party
 * analytics/ads beacon. Two paths, both conservative:
 *  - Direct: a candidate whose own failing request targets a denylisted tracker host (network_error /
 *    http_error carry the url or request id).
 *  - Correlated: a bare fetch-level rejection (no url of its own) fired within
 *    {@link TRACKER_BEACON_CORRELATION_MS} of a blocked beacon request.
 * Candidates with unknown or first-party targets are left untouched.
 */
function downrankTrackerBeacons(
  drafts: CandidateDraft[],
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): void {
  const beaconFailures = collectTrackerBeaconFailures(events, index);
  if (beaconFailures.length === 0) return;
  const beaconRequestIds = new Set(
    beaconFailures
      .map((failure) => failure.requestId)
      .filter((id): id is string => id !== undefined),
  );
  for (const draft of drafts) {
    if (!isTrackerBeaconDraft(draft, beaconFailures, beaconRequestIds)) continue;
    draft.score = Math.min(draft.score, TRACKER_BEACON_SCORE);
    draft.severity = "low";
  }
}

function isTrackerBeaconDraft(
  draft: CandidateDraft,
  beaconFailures: Array<{ t: number; requestId?: string }>,
  beaconRequestIds: Set<string>,
): boolean {
  // Direct: this candidate IS the blocked beacon request.
  if (draft.anchor.requestId && beaconRequestIds.has(draft.anchor.requestId)) {
    return true;
  }
  if (matchTrackerBeaconHost(draft.anchor.url)) return true;
  // Correlated: a bare fetch failure rejection fired next to a blocked beacon.
  if (
    FETCH_REJECTION_DETECTORS.has(draft.detector) &&
    FETCH_FAILURE_MESSAGE_PATTERN.test(draft.anchor.message ?? draft.title)
  ) {
    return beaconFailures.some(
      (failure) =>
        Math.abs(failure.t - draft.anchor.t) <= TRACKER_BEACON_CORRELATION_MS,
    );
  }
  return false;
}

function collectTrackerBeaconFailures(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): Array<{ t: number; requestId?: string }> {
  const failures: Array<{ t: number; requestId?: string }> = [];
  for (const event of events) {
    if (event.k !== "net.err") continue;
    if (matchTrackerBeaconHost(safeText(event.d.url, 400))) {
      failures.push(
        removeUndefined({ t: event.t, requestId: requestIdForEvent(event) }),
      );
    }
  }
  for (const entry of index.networkErrors ?? []) {
    if (matchTrackerBeaconHost(entry.url)) {
      failures.push(
        removeUndefined({ t: entry.t, requestId: requestIdForValue(entry) }),
      );
    }
  }
  for (const failed of index.failedReqs ?? []) {
    if (matchTrackerBeaconHost(failed.url)) {
      failures.push(
        removeUndefined({ t: failed.t, requestId: requestIdForValue(failed) }),
      );
    }
  }
  return failures;
}

/** True when the url's host (or host+path) matches the heuristic tracker-beacon denylist. */
function matchTrackerBeaconHost(url: unknown): boolean {
  if (typeof url !== "string" || url.trim().length === 0) return false;
  const raw = url.trim();
  let host: string;
  let hostPath: string;
  try {
    const parsed = new URL(
      /^[a-z][a-z\d+.-]*:\/\//i.test(raw)
        ? raw
        : `https://${raw.replace(/^\/+/, "")}`,
    );
    host = parsed.host.toLowerCase();
    hostPath = `${host}${parsed.pathname.toLowerCase()}`;
  } catch {
    return false;
  }
  if (!host) return false;
  return TRACKER_BEACON_HOST_PATTERNS.some((pattern) =>
    pattern.includes("/")
      ? hostPath.includes(pattern)
      : host === pattern || host.endsWith(`.${pattern}`),
  );
}

function collectResponsesByTimeStatus(
  events: BugEvent[],
): Map<string, BugEvent> {
  const responses = new Map<string, BugEvent>();
  for (const event of events) {
    if (event.k !== "net.res") continue;
    responses.set(responseLookupKey(event.t, event.d.st), event);
    responses.set(responseLookupKey(event.t, undefined), event);
  }
  return responses;
}

function responseLookupKey(t: number, status: unknown): string {
  return `${t}:${status === undefined ? "*" : String(status)}`;
}

function dedupeDrafts(drafts: CandidateDraft[]): CandidateDraft[] {
  const byKey = new Map<string, CandidateDraft>();
  for (const draft of drafts) {
    const existing = byKey.get(draft.dedupeKey);
    if (
      !existing ||
      draft.score > existing.score ||
      (draft.score === existing.score && draft.anchor.t < existing.anchor.t)
    ) {
      byKey.set(draft.dedupeKey, draft);
    }
  }
  return [...byKey.values()];
}

function mergeWindowRanges(
  ranges: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number }> {
  const sorted = ranges.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (!last || range.start > last.end) merged.push({ ...range });
    else last.end = Math.max(last.end, range.end);
  }
  return merged;
}

function renderCandidatesMarkdown(
  candidates: EvidenceCandidate[],
  input: EvidenceIndexInput,
): string {
  const lines = [
    `# Signal Evidence Index`,
    "",
    "Deterministic, redacted issue signals generated from local Crumbtrail events. This uppercase entry point is intentional: start here before raw replay artifacts.",
    "",
    `* Schema version: ${CANDIDATE_SCHEMA_VERSION}`,
    `* Session: ${input.index.id ?? path.basename(input.sessionDir)}`,
    `* Signals: ${candidates.length}`,
    `* Ordering: score desc, anchor time asc, deterministic dedupe key asc; stable signal IDs are assigned after ranking`,
    "",
    "## Signals",
    "",
  ];

  if (candidates.length === 0) {
    lines.push("_No deterministic issue signals were detected._", "");
  } else {
    for (const candidate of candidates) {
      lines.push(`### ${candidate.id} · ${candidate.title}`);
      lines.push("");
      lines.push(`* Detector: ${candidate.detector}`);
      lines.push(`* Severity: ${candidate.severity}`);
      lines.push(`* basis: "heuristic"`);
      lines.push(`* baseScore: ${candidate.score}`);
      lines.push(`* Confidence: ${candidate.confidence}`);
      lines.push(
        `* Anchor: ${formatOffset(candidate.anchor.offsetMs, candidate.anchor.t)}${candidate.anchor.route ? ` on ${candidate.anchor.route}` : ""}`,
      );
      if (
        candidate.anchor.method ||
        candidate.anchor.status ||
        candidate.anchor.url
      )
        lines.push(
          `* Request: ${[candidate.anchor.method, candidate.anchor.status, candidate.anchor.url].filter((part) => part !== undefined && part !== "").join(" ")}`,
        );
      if (candidate.anchor.errorCode)
        lines.push(`* Error code: ${candidate.anchor.errorCode}`);
      if (candidate.anchor.message)
        lines.push(`* Message: ${candidate.anchor.message}`);
      if (candidate.anchor.elementLabel)
        lines.push(`* Element: ${candidate.anchor.elementLabel}`);
      // Causal structure (CP4): additive per-candidate lines from the CP3 re-rank fields.
      if (candidate.causalRole)
        lines.push(`* Causal role: ${candidate.causalRole}`);
      if (candidate.causalRole === "symptom" && candidate.rootCauseId) {
        lines.push(`* Root cause: ${candidate.rootCauseId}`);
        if (candidate.attributionConfidence)
          lines.push(
            `* Attribution confidence: ${candidate.attributionConfidence}`,
          );
      }
      lines.push(
        `* Evidence window: [windows/${candidate.id}.md](windows/${candidate.id}.md)`,
      );
      lines.push("");
    }
  }

  lines.push("## Search corpus");
  lines.push("");
  lines.push(
    "Use `search.jsonl` for normalized, redacted grep friendly rows linked back to signals. It is not a replacement for `events.ndjson`; it avoids raw payloads, storage values, auth material, and raw input values.",
  );
  lines.push("");
  return lines.join("\n");
}

function renderCandidatesJsonl(candidates: EvidenceCandidate[]): string {
  return (
    candidates.map((candidate) => JSON.stringify(candidate)).join("\n") +
    (candidates.length > 0 ? "\n" : "")
  );
}

function renderTimelineMarkdown(
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): string {
  const validTimes = events
    .map((event) => finiteSafeTimestamp(event.t))
    .filter((time): time is number => time !== undefined);
  const fallbackStart = validTimes[0] ?? 0;
  const start = finiteSafeTimestamp(index.start) ?? fallbackStart;
  const rawEnd =
    finiteSafeTimestamp(index.end) ??
    validTimes[validTimes.length - 1] ??
    start;
  const bucketMs = 5 * 60 * 1000;
  const maxBuckets = 288;
  const end = Math.min(rawEnd, start + bucketMs * (maxBuckets - 1));
  const lines = [
    "# Session Timeline",
    "",
    "Five-minute deterministic buckets for long-session navigation and evidence discovery.",
    "",
  ];

  for (
    let bucketStart = start, bucketIndex = 0;
    bucketStart <= end && bucketIndex < maxBuckets;
    bucketIndex += 1
  ) {
    const bucketEnd = Math.min(bucketStart + bucketMs, end);
    const bucketEvents = events.filter((event) => {
      const eventTime = finiteSafeTimestamp(event.t);
      return (
        eventTime !== undefined &&
        eventTime >= bucketStart &&
        eventTime <= bucketEnd
      );
    });
    lines.push(
      `## ${formatOffset(offsetFromStart(bucketStart, start), bucketStart)} - ${formatOffset(offsetFromStart(bucketEnd, start), bucketEnd)}`,
    );
    lines.push("");
    if (bucketEvents.length === 0) {
      lines.push("- No events captured.");
    } else {
      const counts = countBy(bucketEvents.map((event) => event.k));
      lines.push(
        `- Events: ${bucketEvents.length} (${Object.entries(counts)
          .map(([kind, count]) => `${kind}:${count}`)
          .join(", ")})`,
      );
      const notable = bucketEvents.filter(isTimelineNotable).slice(0, 12);
      for (const event of notable)
        lines.push(
          `- ${formatOffset(offsetForEvent(event) ?? offsetFromStart(event.t, start), event.t)} ${event.k}: ${eventSummary(event)}`,
        );
    }
    lines.push("");
    const nextBucketStart = bucketStart + bucketMs;
    if (nextBucketStart <= bucketStart) break;
    bucketStart = nextBucketStart;
  }
  return lines.join("\n");
}

function finiteSafeTimestamp(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    Math.abs(value) <= 8_640_000_000_000_000
    ? value
    : undefined;
}

function renderSearchJsonl(
  events: BugEvent[],
  candidates: EvidenceCandidate[],
  index: EvidenceIndexInput["index"],
): string {
  const rows: Array<Record<string, unknown>> = [];
  const candidateIdsByEventIndex = buildCandidateIdsByEventIndex(
    events,
    candidates,
  );
  for (const candidate of candidates) {
    rows.push(
      removeUndefined({
        schemaVersion: CANDIDATE_SCHEMA_VERSION,
        type: "candidate",
        candidateId: candidate.id,
        detector: candidate.detector,
        t: candidate.anchor.t,
        offsetMs: candidate.anchor.offsetMs,
        route: candidate.anchor.route,
        text: scrubText(
          [
            candidate.title,
            candidate.anchor.errorCode,
            candidate.anchor.message,
            candidate.anchor.elementLabel,
            candidate.anchor.url,
          ]
            .filter(Boolean)
            .join(" "),
          500,
        ),
      }),
    );
  }

  for (let eventIndex = 0; eventIndex < events.length; eventIndex++) {
    const event = events[eventIndex];
    const text = eventSummary(event);
    if (!text) continue;
    rows.push(
      removeUndefined({
        schemaVersion: CANDIDATE_SCHEMA_VERSION,
        type: "event",
        k: event.k,
        t: event.t,
        offsetMs:
          offsetForEvent(event) ?? offsetFromStart(event.t, index.start),
        route: routeAt(index.navs ?? [], event.t),
        candidateIds: candidateIdsByEventIndex.get(eventIndex) ?? [],
        text: scrubText(text, 500),
      }),
    );
  }

  return (
    rows.map((row) => JSON.stringify(row)).join("\n") +
    (rows.length > 0 ? "\n" : "")
  );
}

function buildCandidateIdsByEventIndex(
  events: BugEvent[],
  candidates: EvidenceCandidate[],
): Map<number, string[]> {
  const indexedEvents = events
    .map((event, index) => ({ event, index }))
    .sort((a, b) => a.event.t - b.event.t);
  const indexedCandidates = candidates
    .slice()
    .sort((a, b) => a.evidenceWindow.start - b.evidenceWindow.start);
  const result = new Map<number, string[]>();
  let candidateStart = 0;

  for (const { event, index } of indexedEvents) {
    while (
      candidateStart < indexedCandidates.length &&
      indexedCandidates[candidateStart].evidenceWindow.end < event.t
    ) {
      candidateStart++;
    }
    const ids: string[] = [];
    for (
      let i = candidateStart;
      i < indexedCandidates.length &&
      indexedCandidates[i].evidenceWindow.start <= event.t;
      i++
    ) {
      if (event.t <= indexedCandidates[i].evidenceWindow.end)
        ids.push(indexedCandidates[i].id);
    }
    result.set(index, ids);
  }

  return result;
}

function renderWindowMarkdown(
  candidate: EvidenceCandidate,
  events: BugEvent[],
  index: EvidenceIndexInput["index"],
): string {
  const windowEvents = events.filter(
    (event) =>
      event.t >= candidate.evidenceWindow.start &&
      event.t <= candidate.evidenceWindow.end,
  );
  const lines = [
    `# Evidence Window ${candidate.id}`,
    "",
    `- Candidate: ${candidate.title}`,
    `- Detector: ${candidate.detector}`,
    `- Anchor: ${formatOffset(candidate.anchor.offsetMs, candidate.anchor.t)}`,
    `- Window: ${formatOffset(offsetFromStart(candidate.evidenceWindow.start, index.start), candidate.evidenceWindow.start)} to ${formatOffset(offsetFromStart(candidate.evidenceWindow.end, index.start), candidate.evidenceWindow.end)}`,
    "",
    "## Compact event timeline",
    "",
  ].filter((line): line is string => line !== undefined);

  if (windowEvents.length === 0) lines.push("_No events in this window._");
  else
    for (const event of selectCompactTimelineEvents(candidate, windowEvents))
      lines.push(
        `- ${formatOffset(offsetForEvent(event) ?? offsetFromStart(event.t, index.start), event.t)} ${event.k}: ${eventSummary(event)}`,
      );

  lines.push("", "## Network summaries", "");
  const networkEvents = windowEvents.filter(
    (event) =>
      event.k === "net.req" || event.k === "net.res" || event.k === "net.err",
  );
  if (networkEvents.length === 0)
    lines.push("_No network events in this window._");
  else
    for (const event of networkEvents.slice(0, 80))
      lines.push(
        `- ${formatOffset(offsetForEvent(event) ?? offsetFromStart(event.t, index.start), event.t)} ${eventSummary(event)}`,
      );

  const failedRequestBodies = failedRequestBodySnippets(
    candidate,
    windowEvents,
  );
  if (failedRequestBodies.request || failedRequestBodies.response) {
    lines.push("", "## Failed request bodies", "");
    if (failedRequestBodies.request)
      lines.push(`- Request body: ${failedRequestBodies.request}`);
    if (failedRequestBodies.response)
      lines.push(`- Response body: ${failedRequestBodies.response}`);
  }

  lines.push("", "## Console and runtime errors", "");
  const errorEvents = windowEvents.filter(
    (event) =>
      event.k === "con" ||
      event.k === "err" ||
      event.k === "rej" ||
      event.k === "probe.error",
  );
  if (errorEvents.length === 0)
    lines.push("_No console/runtime errors in this window._");
  else
    for (const event of errorEvents.slice(0, 80))
      lines.push(
        `- ${formatOffset(offsetForEvent(event) ?? offsetFromStart(event.t, index.start), event.t)} ${event.k}: ${eventSummary(event)}`,
      );

  lines.push("", "## Transcript slice", "");
  const txEvents = windowEvents.filter((event) => event.k === "tx");
  if (txEvents.length === 0)
    lines.push("_No transcript events in this window._");
  else
    for (const event of txEvents.slice(0, 40))
      lines.push(
        `- ${formatOffset(offsetForEvent(event) ?? offsetFromStart(event.t, index.start), event.t)} ${scrubText(event.d.text, 220)}`,
      );

  lines.push("", "## Media offsets", "");
  lines.push(
    `- Review video/audio around ${formatOffset(candidate.anchor.offsetMs, candidate.anchor.t)} if media artifacts exist.`,
  );
  return lines.join("\n") + "\n";
}

const COMPACT_TIMELINE_MAX_EVENTS = 120;
const COMPACT_TIMELINE_BUDGETS = {
  errors: 36,
  interactions: 24,
  network: 24,
  lowSignal: 18,
  context: 15,
} as const;

function selectCompactTimelineEvents(
  candidate: EvidenceCandidate,
  windowEvents: BugEvent[],
): BugEvent[] {
  // Preserve the complete chronology when it already fits. Per-kind quotas only
  // shape an overflowed timeline; they must not discard useful context otherwise.
  if (windowEvents.length <= COMPACT_TIMELINE_MAX_EVENTS) return windowEvents;

  const indexedEvents = windowEvents.map((event, index) => ({ event, index }));
  const selected = new Set<number>();
  const add = (entry: { event: BugEvent; index: number } | undefined) => {
    if (entry && selected.size < COMPACT_TIMELINE_MAX_EVENTS)
      selected.add(entry.index);
  };
  const byProximity = (entries: typeof indexedEvents) =>
    entries
      .slice()
      .sort(
        (a, b) =>
          Math.abs(a.event.t - candidate.anchor.t) -
            Math.abs(b.event.t - candidate.anchor.t) ||
          a.event.t - b.event.t ||
          a.index - b.index,
      );
  const firstMatching = (
    predicate: (event: BugEvent) => boolean,
  ): { event: BugEvent; index: number } | undefined =>
    byProximity(indexedEvents.filter(({ event }) => predicate(event)))[0];
  const requestId = candidate.anchor.requestId;
  const response = findResponseEvent(
    collectResponsesByTimeStatus(windowEvents),
    candidate.anchor.t,
    candidate.anchor.status,
  );
  const responseEntry = response
    ? indexedEvents.find(({ event }) => event === response)
    : undefined;
  const detectorAnchorKind = compactAnchorEventKind(candidate.detector);
  const anchor = requestId
    ? (firstMatching(
        (event) =>
          event.t === candidate.anchor.t &&
          requestIdForEvent(event) === requestId,
      ) ??
      responseEntry ??
      firstMatching((event) => event.t === candidate.anchor.t))
    : ((detectorAnchorKind
        ? firstMatching((event) => event.k === detectorAnchorKind)
        : undefined) ??
      responseEntry ??
      firstMatching((event) => event.t === candidate.anchor.t) ??
      firstMatching(() => true));
  add(anchor);

  const correlatedRequestId = requestId ?? requestIdForEvent(anchor?.event);
  if (correlatedRequestId) {
    add(
      firstMatching(
        (event) =>
          event.k === "net.req" &&
          requestIdForEvent(event) === correlatedRequestId,
      ),
    );
    add(
      firstMatching(
        (event) =>
          event.k === "net.res" &&
          requestIdForEvent(event) === correlatedRequestId,
      ),
    );
  }

  const addBudgeted = (
    budget: number,
    predicate: (event: BugEvent) => boolean,
  ) => {
    const remaining = COMPACT_TIMELINE_MAX_EVENTS - selected.size;
    for (const entry of byProximity(
      indexedEvents.filter(
        ({ event, index }) => !selected.has(index) && predicate(event),
      ),
    ).slice(0, Math.min(budget, remaining)))
      add(entry);
  };

  addBudgeted(COMPACT_TIMELINE_BUDGETS.errors, isCompactErrorEvent);
  addBudgeted(COMPACT_TIMELINE_BUDGETS.interactions, (event) =>
    ["clk", "inp", "key"].includes(event.k),
  );
  addBudgeted(
    COMPACT_TIMELINE_BUDGETS.network,
    (event) =>
      event.k === "net.req" || event.k === "net.res" || event.k === "net.err",
  );
  addBudgeted(COMPACT_TIMELINE_BUDGETS.lowSignal, isCompactLowSignalEvent);
  addBudgeted(
    COMPACT_TIMELINE_BUDGETS.context,
    (event) =>
      !isCompactErrorEvent(event) &&
      !["clk", "inp", "key", "net.req", "net.res", "net.err"].includes(
        event.k,
      ) &&
      !isCompactLowSignalEvent(event),
  );

  // Quotas preserve a useful mix, then unused capacity goes to the events most
  // relevant to the candidate rather than leaving the compact timeline sparse.
  for (const entry of byProximity(
    indexedEvents.filter(({ index }) => !selected.has(index)),
  ).slice(0, COMPACT_TIMELINE_MAX_EVENTS - selected.size))
    add(entry);

  return indexedEvents
    .filter(({ index }) => selected.has(index))
    .sort((a, b) => a.event.t - b.event.t || a.index - b.index)
    .map(({ event }) => event);
}

function compactAnchorEventKind(detector: string): BugEvent["k"] | undefined {
  if (detector === "unhandled_rejection") return "rej";
  if (detector === "console_error") return "con";
  if (detector === "uncaught_error") return "err";
  return undefined;
}

function requestIdForEvent(event: BugEvent | undefined): string | undefined {
  if (!event) return undefined;
  return requestIdForValue(event.d);
}

function requestIdForValue(value: Record<string, unknown>): string | undefined {
  const numericId = finiteNumber(value.id);
  return numericId !== undefined ? String(numericId) : safeText(value.id, 120);
}

function responseForFailedRequest(
  events: BugEvent[],
  failed: NonNullable<EvidenceIndexInput["index"]["failedReqs"]>[number],
): BugEvent | undefined {
  const id = requestIdForValue(failed);
  if (id) {
    const matches = events.filter(
      (event) => event.k === "net.res" && requestIdForEvent(event) === id,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  const matches = events.filter(
    (event) =>
      event.k === "net.res" &&
      requestIdForEvent(event) === undefined &&
      event.t === failed.t &&
      finiteNumber(event.d.st) === finiteNumber(failed.st),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function networkAnchorForCandidate(
  candidate: EvidenceCandidate,
  windowEvents: BugEvent[],
): BugEvent | undefined {
  const id = candidate.anchor.requestId;
  if (id) {
    const matches = windowEvents.filter(
      (event) =>
        (event.k === "net.res" || event.k === "net.err") &&
        requestIdForEvent(event) === id,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }

  const matches = windowEvents.filter(
    (event) =>
      event.t === candidate.anchor.t &&
      (event.k === "net.res" || event.k === "net.err") &&
      (candidate.anchor.status === undefined ||
        event.k !== "net.res" ||
        event.d.st === candidate.anchor.status),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function failedRequestBodySnippets(
  candidate: EvidenceCandidate,
  windowEvents: BugEvent[],
): { request?: string; response?: string } {
  const anchor = networkAnchorForCandidate(candidate, windowEvents);
  if (!anchor) return {};

  const requestId = candidate.anchor.requestId ?? requestIdForEvent(anchor);
  const request = requestId
    ? windowEvents.find(
        (event) =>
          event.k === "net.req" && requestIdForEvent(event) === requestId,
      )
    : undefined;

  return removeUndefined({
    request: request
      ? redactedNetworkBodySnippet(request.d.body, request.d.bodySummary)
      : undefined,
    response:
      anchor.k === "net.res"
        ? redactedNetworkBodySnippet(anchor.d.body, anchor.d.bodySummary)
        : undefined,
  });
}

function isCompactErrorEvent(event: BugEvent): boolean {
  return ["con", "err", "rej", "probe.error", "native-crash"].includes(event.k);
}

function isCompactLowSignalEvent(event: BugEvent): boolean {
  return ["stor", "cookie", "perf", "hb", "snap"].includes(event.k);
}

function findResponseEvent(
  responses: Map<string, BugEvent>,
  t: number,
  status: unknown,
): BugEvent | undefined {
  return (
    responses.get(responseLookupKey(t, status)) ??
    responses.get(responseLookupKey(t, undefined))
  );
}

function routeAt(
  navs: Array<{ t: number; to?: string }>,
  t: number,
): string | undefined {
  let route: string | undefined;
  for (const nav of navs) {
    if (nav.t > t) break;
    route = redactUrl(nav.to);
  }
  return route;
}

function elementLabel(event: BugEvent): string | undefined {
  const d = event.d;
  const el = isRecord(d.el) ? d.el : undefined;
  const target = targetForEvent(event);
  return (
    safeText(target?.label, 180) ??
    safeText(target?.accessibilityId, 180) ??
    safeText(target?.role, 180) ??
    safeText(target?.testID, 180) ??
    safeText(target?.componentName, 180) ??
    safeText(target?.routePath, 180) ??
    safeText(target?.ancestryHash, 180) ??
    safeText(target?.text, 180) ??
    safeText(target?.accessibilityLabel, 180) ??
    safeText(target?.testId, 180) ??
    safeText(target?.selector, 180) ??
    safeText(target?.viewName, 180) ??
    safeText(el?.txt, 180) ??
    safeText(el?.aria, 180) ??
    safeText(el?.label, 180) ??
    safeText(d.tgt, 180) ??
    safeText(d.selector, 180)
  );
}

function targetForEvent(event: BugEvent): TargetDescriptor | undefined {
  if (isRecord(event.target)) return event.target as TargetDescriptor;
  if (isRecord(event.d.target)) return event.d.target as TargetDescriptor;
  return undefined;
}

function eventSummary(event: BugEvent): string {
  const d = isRecord(event.d) ? event.d : {};
  const kind = typeof event.k === "string" ? event.k : "unknown";
  if (!isRecord(event.d)) return `${kind} event with malformed payload`;
  if (kind === "nav" || kind === "navigation")
    return `navigation to ${redactUrl(d.to ?? d.route ?? d.screen ?? d.path ?? d.name) ?? "unknown"}`;
  if (kind === "app-lifecycle")
    return `app lifecycle ${safeText(d.state, 80) ?? safeText(d.phase, 80) ?? "unknown"}`;
  if (kind === "native-crash") {
    const screenshot = scrubText(d.screenshotUri ?? d.screenshot ?? d.uri, 180);
    return [
      "native crash",
      scrubText(d.message, 220) ??
        safeText(d.exceptionType, 120) ??
        "message unavailable",
      screenshot ? `screenshot ${screenshot}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (kind === "view-snapshot")
    return `view snapshot ${
      scrubText(elementLabel(event), 180) ??
      safeText(d.screen ?? d.routePath ?? d.uri, 120) ??
      "unknown view"
    }`;
  if (kind === "clk")
    return `click ${scrubText(elementLabel(event), 180) ?? "unknown element"}`;
  if (kind === "inp") return "input changed; raw value omitted";
  if (kind === "perf")
    return `performance ${safeText(d.metric, 40) ?? safeText(d.entryType, 40) ?? "entry"} ${redactUrl(d.name) ?? ""}`.trim();
  if (kind === "net.req")
    return `request ${safeText(d.m, 20) ?? safeText(d.method, 20) ?? ""} ${redactUrl(d.url) ?? ""}`.trim();
  if (kind === "net.res")
    return `response ${safeText(d.id, 80) ?? ""} status ${finiteNumber(d.st) ?? "unknown"} dur ${finiteNumber(d.dur) ?? "unknown"} ms`;
  if (kind === "net.err")
    return `network error ${safeText(d.method, 20) ?? safeText(d.m, 20) ?? ""} ${redactUrl(d.url) ?? ""} ${scrubText(d.msg, 180) ?? ""}`.trim();
  if (kind === "backend.otel.span")
    return `otel span ${scrubText(d.name, 120) ?? ""} [${safeText(d.serviceName, 80) ?? "service"}] status ${safeText(d.statusCode, 20) ?? "UNSET"}`.trim();
  if (kind === "backend.otel.log")
    return `otel log ${safeText(d.severityText, 40) ?? ""}: ${scrubText(d.body, 220) ?? "message unavailable"}`.trim();
  if (kind === "tab.boundary") {
    const decision = safeText(d.decision, 80) ?? "unknown";
    const reason = safeText(d.reason, 120);
    const candidate = isRecord(d.candidate)
      ? (safeOriginSummary(d.candidate.origin) ??
        safeOriginSummary(d.candidate.url) ??
        safeOriginSummary(d.candidate.href) ??
        safeText(d.candidate.scheme, 40))
      : undefined;
    const prompt = isRecord(d.prompt)
      ? safeText(d.prompt.outcome, 80)
      : undefined;
    return [
      "tab boundary",
      decision,
      reason,
      candidate ? `candidate ${candidate}` : undefined,
      prompt ? `prompt ${prompt}` : undefined,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (kind === "con")
    return `console ${safeText(d.lv, 20) ?? ""}: ${scrubText(consoleMessage(d), 220) ?? "message unavailable"}`;
  if (kind === "err" || kind === "rej")
    return `${kind}: ${scrubText(d.msg, 220) ?? "message unavailable"}`;
  if (kind === "probe.error")
    return `page probe error ${safeText(d.phase, 80) ?? ""}: ${scrubText(d.message, 220) ?? "message unavailable"}`;
  if (kind === "media.voice" && d.state === "marker-added")
    return `voice marker ${scrubText(d.label, 180) ?? safeText(d.markerId, 80) ?? ""}`.trim();
  if (kind === "tx") return `transcript: ${scrubText(d.text, 220) ?? ""}`;
  if (kind === "snap") return "storage/cookie snapshot; values omitted";
  return scrubText(JSON.stringify(summarizePayload(d)), 220) ?? kind;
}

function isTimelineNotable(event: BugEvent): boolean {
  return [
    "session.lifecycle",
    "nav",
    "navigation",
    "app-lifecycle",
    "native-crash",
    "view-snapshot",
    "clk",
    "inp",
    "snap",
    "net.req",
    "net.res",
    "net.err",
    "con",
    "err",
    "rej",
    "probe.error",
    "perf",
    "media.voice",
    "media.video",
    "tx",
    "backend.otel.span",
    "backend.otel.log",
  ].includes(event.k);
}

function consoleMessage(data: Record<string, unknown>): string | undefined {
  const msg = safeText(data.msg, 300);
  if (msg) return msg;
  if (!Array.isArray(data.args)) return undefined;
  return data.args
    .slice(0, 6)
    .map((entry) =>
      typeof entry === "string"
        ? entry
        : JSON.stringify(summarizePayload(entry)),
    )
    .join(" ");
}

function summarizePayload(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 6).map(summarizePayload);
  if (!isRecord(value))
    return typeof value === "string" ? scrubText(value, 100) : value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/cookie|storage|token|authorization|password|secret|value/i.test(key))
      out[key] = "[REDACTED]";
    else if (typeof entry === "string")
      out[key] = scrubText(
        key === "url" || key === "to" ? redactUrl(entry) : entry,
        100,
      );
    else if (typeof entry === "number" || typeof entry === "boolean")
      out[key] = entry;
  }
  return out;
}

function safeOriginSummary(value: unknown): string | undefined {
  const text = safeText(value, 2_000);
  if (!text) return undefined;
  try {
    const parsed = new URL(text);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function scrubText(value: unknown, maxLength: number): string | undefined {
  const text = safeText(value, 10_000);
  if (!text) return undefined;
  return truncate(redactTokenLikeText(redactUrlLikeText(text)), maxLength);
}

function redactUrl(value: unknown): string | undefined {
  const text = safeText(value, 2_000);
  if (!text) return undefined;
  return truncate(redactTokenLikeText(redactCoreUrl(text).value), 240);
}

function redactUrlLikeText(value: string): string {
  return value.replace(
    /https?:\/\/[^\s)\]}>,]+|\/[A-Za-z0-9._~!$&'()*+,;:@%-]+(?:[/?#][^\s)\]}>,]*)?/g,
    (match) => {
      try {
        return redactCoreUrl(match).value;
      } catch {
        return redactTokenLikeText(
          match.replace(/([?&][^=&#\s]+)=([^&#\s]+)/g, "$1=[REDACTED]"),
        );
      }
    },
  );
}

function redactTokenLikeText(value: string): string {
  return redactTokenLikeString(value).value;
}

function safeText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return undefined;
  return truncate(trimmed, maxLength);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/** Coercing variant of `finiteNumber`: also parses numeric strings ("3" → 3); strict `finiteNumber` accepts numbers only. */
function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function offsetForEvent(event: BugEvent | undefined): number | undefined {
  if (!event) return undefined;
  return (
    finiteNumber(event.offsetMs) ??
    (isRecord(event.d) ? finiteNumber(event.d.offsetMs) : undefined)
  );
}

function offsetFromStart(t: number, start: unknown): number | undefined {
  const startMs = finiteNumber(start);
  return startMs === undefined ? undefined : Math.max(0, t - startMs);
}

function formatOffset(offsetMs: number | undefined, t: unknown): string {
  const safeOffset = finiteNumber(offsetMs);
  if (safeOffset !== undefined) return `${safeOffset} ms`;
  const safeTime = finiteSafeTimestamp(t);
  return safeTime === undefined
    ? "unknown time"
    : new Date(safeTime).toISOString();
}

function countBy(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)),
  );
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

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Baseline policy tag for evidence produced by this indexer. Typed as the
 * v1|v2 union: individual events may carry either tag (structured v2 network
 * bodies included), even though the indexer's own baseline remains v1.
 */
export function evidenceRedactionPolicy(): BrowserRedactionPolicy {
  return BROWSER_REDACTION_POLICY;
}
