import fs from "node:fs";
import path from "node:path";
import {
  redactTokenLikeString,
  redactUrl as redactCoreUrl,
  type BugEvent,
  type TargetDescriptor,
} from "crumbtrail-core";
import { BROWSER_REDACTION_POLICY, normalizeDbEngine } from "./llm-bundle";
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
      reason?: string;
      code?: string;
      message?: string;
      phase?: string;
    }>;
    networkErrors?: Array<{
      t: number;
      offsetMs?: number;
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
    errs?: Array<{ t: number; msg?: string }>;
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
    source?: string;
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
  const responseByTimeStatus = collectResponsesByTimeStatus(events);
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
    const response = findResponseEvent(
      responseByTimeStatus,
      failed.t,
      failed.st,
    );
    const reqId = response ? safeText(response.d.id, 120) : undefined;
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
        method: entry.method || entry.m,
        url: redactUrl(entry.url),
        message: scrubText(entry.msg, 220),
        source: entry.transport,
      }),
      dedupeKey: `neterr:${entry.t}:${entry.method ?? entry.m ?? ""}:${entry.url ?? ""}:${entry.msg ?? ""}`,
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
  addOtelDbActivityCandidates(events, index, drafts);

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
    for (const event of windowEvents.slice(0, 120))
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
  return value.length <= maxLength
    ? value
    : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function evidenceRedactionPolicy(): typeof BROWSER_REDACTION_POLICY {
  return BROWSER_REDACTION_POLICY;
}
