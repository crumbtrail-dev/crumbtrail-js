import { assembleBundle } from "crumbtrail-core";
import type {
  EvidenceGap,
  EvidenceItem,
  EvidenceLane,
  EvidenceQuery,
  EvidenceRef,
  Located,
  RankedBundle,
  Symptom,
} from "crumbtrail-core";
import {
  evidenceSourcesFromEnv,
  fetchAdapterEvidence,
  type AdapterSourceStats,
  type EvidenceSource,
  type FetchAdapterEvidenceOptions,
} from "./evidence-sources";
import type { DistinctBug, DistinctBugEvidenceRef } from "./distinct-bugs";
import {
  bugProfile,
  scoreLocalIssue,
  tokenizeIssueText,
  type LocalIssueProfile,
  type RecallStore,
} from "./recall";

// --- Incident-location engine v1 ("which recorded session IS this ticket?") ---
//
// recallLocal answers "have we seen something that RHYMES with this?" and is a
// discovery surface — it keeps anything with a positive score. locateIncident
// makes a DECISION: given only a ticket/symptom, it ranks the recorded sessions
// and, if the top candidate clears a confidence bar, treats that session as the
// incident and auto-populates evidence from it. Because that decision acts on a
// single top candidate as if it were the real incident, the bar is deliberately
// higher than recall's "surface anything" behavior.
//
// The base ranking reuses recall's 4-facet scorer (text / route / error-family /
// env) verbatim — we CALL scoreLocalIssue + bugProfile, we do not copy weights.
// Two bounded, incident-specific signals refine that base score:
//   - time-proximity: a ticket usually refers to something that happened
//     recently, so a session nearer the reference time is preferred.
//   - release-hint: a ticket that names a release should prefer sessions
//     recorded on that release.
// Both are capped so they refine the ranking without overpowering the semantic
// base; a candidate must already have base signal (base > 0) to be considered,
// so "it's merely recent" can never, by itself, locate an incident.

/** Bounded contribution of the time-proximity signal to the combined score. */
const TIME_PROXIMITY_WEIGHT = 0.1;
/** Half-life for time-proximity decay: a session this old contributes half of
 *  {@link TIME_PROXIMITY_WEIGHT}. Chosen at 7 days — long enough that a ticket
 *  filed a few days after the incident still benefits, short enough that stale
 *  sessions decay out. */
const TIME_PROXIMITY_HALF_LIFE_MS = 7 * 24 * 60 * 60 * 1000;
/** Bounded contribution of the release-hint signal to the combined score. */
const RELEASE_HINT_WEIGHT = 0.1;

/**
 * Confidence bar for calling a locate a MATCH. Justification: recall's own
 * cutoffs are discovery bars — scoreLocalIssue uses 0.3 only to attach the
 * "semantic" reason LABEL, and recallLocal keeps everything scoring > 0 so a
 * human can browse near-misses. Neither is a decision to act. Auto-populating a
 * fusion bundle from the top candidate is such a decision, so the bar is set at
 * 0.5. Given the base weights (0.6 text + 0.2 route + 0.1 error + 0.1 env) plus
 * the two bounded refinement signals (0.1 time-proximity + 0.1 release-hint,
 * ≤0.2 combined), 0.5 is reachable two ways: strong text similarity alone
 * (~0.83 text → 0.5), or a full structural anchor — same route AND same error
 * family (0.3) — carried by full time+release refinement (0.2) with zero text
 * overlap. A single structural anchor alone (route-only 0.2, or error-only
 * 0.1) plus full refinement tops out at 0.4/0.3 and still cannot reach 0.5
 * without text. That guarantees a matched locate is backed by corroborating
 * signal, not a single weak facet. Anything below stays "inconclusive" and is
 * returned only as a near-miss, never promoted. The comparison is `>=`
 * (inclusive): a candidate landing exactly on the documented bar is the
 * minimum acceptable confidence, so it matches.
 */
export const DEFAULT_MATCH_THRESHOLD = 0.5;

/**
 * Minimum score lead over the runner-up required to treat a located session as
 * conclusive. A candidate that clears the confidence threshold without this
 * lead remains ambiguous so its evidence is never attributed to one session.
 */
export const DEFAULT_MATCH_MARGIN = 0.15;

export interface LocateIncidentOptions {
  /** Reference "now" for the time-proximity signal. Defaults to Date.now(). */
  now?: number;
  /** Override the match confidence bar. Defaults to {@link DEFAULT_MATCH_THRESHOLD}. */
  threshold?: number;
  /** Override the required lead over the runner-up. Defaults to {@link DEFAULT_MATCH_MARGIN}. */
  margin?: number;
  /** Narrow candidates to this account when a candidate's account is known. */
  accountId?: string;
}

/** One ranked recorded session/bug scored against the ticket symptom. Carries
 *  the source {@link DistinctBug} so the caller can adapt its evidence without a
 *  second lookup; the sessionId is always one returned by store.listSessions(),
 *  never fabricated. */
export interface RankedCandidate {
  sessionId: string;
  bugId: string;
  /** Combined confidence in [0,1]. */
  confidence: number;
  reasons: string[];
  /** Most recent known activity time, used as the secondary rank. */
  sessionTime?: number;
  bug: DistinctBug;
}

export interface LocateIncidentResult {
  outcome: "matched" | "ambiguous" | "inconclusive";
  candidates: RankedCandidate[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** First non-empty string among the given keys — mirrors McpServer.firstString. */
function firstString(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = stringField(record[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * Build a recall query profile from a ticket symptom. Reuses tokenizeIssueText
 * so the query is tokenized exactly like a bug profile:
 *  - tokens      ← title + description
 *  - route       ← symptom.url
 *  - errorFamily ← symptom.errorSig
 *  - facetTokens ← tokenized symptom.release
 */
export function symptomProfile(symptom: Symptom): LocalIssueProfile {
  const tokens = tokenizeIssueText(
    [symptom.title, symptom.description]
      .filter((v): v is string => Boolean(v))
      .join(" "),
  );
  return {
    tokens,
    route: symptom.url,
    errorFamily: symptom.errorSig,
    facetTokens: tokenizeIssueText(symptom.release ?? ""),
  };
}

/** Most recent known activity time for a candidate session, or undefined. Reads
 *  index.json (start/end ms) first, then the bundle's session.startMs/endMs.
 *  Prefers the session END (closest to when the incident finished). */
async function candidateSessionTime(
  dir: string,
  store: RecallStore,
  bundle: Record<string, unknown>,
): Promise<number | undefined> {
  const index = await store.readJsonRecord(dir, "index.json");
  const indexEnd = numberField(index?.end);
  const indexStart = numberField(index?.start);
  if (indexEnd !== undefined) return indexEnd;
  if (indexStart !== undefined) return indexStart;
  const session = isRecord(bundle.session) ? bundle.session : undefined;
  return numberField(session?.endMs) ?? numberField(session?.startMs);
}

/** Release recorded for a candidate session, mirroring firstString usage in
 *  mcp-server.ts (release / releaseId / version from meta.json). */
async function candidateRelease(
  dir: string,
  store: RecallStore,
): Promise<string | undefined> {
  const meta = await store.readJsonRecord(dir, "meta.json");
  if (!meta) return undefined;
  return firstString(meta, ["release", "releaseId", "version"]);
}

/**
 * Account recorded for a candidate session, when available. The account may
 * have been written before or after the session index, so inspect both session
 * records. Absence is intentionally preserved as unknown rather than treated
 * as a mismatch by account narrowing.
 */
async function candidateAccountId(
  dir: string,
  store: RecallStore,
): Promise<string | undefined> {
  for (const name of ["meta.json", "index.json"]) {
    const record = await store.readJsonRecord(dir, name);
    if (!record) continue;
    const direct = firstString(record, ["accountId", "account_id"]);
    if (direct) return direct;
    const identity = isRecord(record.identity) ? record.identity : undefined;
    const nested = identity ? stringField(identity.accountId) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

/** Bounded time-proximity boost: exponential decay by session age vs the
 *  reference time. Returns { boost, recent } where `recent` (age within one
 *  half-life) drives whether a reason is attached — the boost itself is smooth. */
function timeProximity(
  now: number,
  candidateTime: number | undefined,
): { boost: number; recent: boolean } {
  if (candidateTime === undefined) return { boost: 0, recent: false };
  const ageMs = Math.max(0, now - candidateTime);
  const decay = Math.pow(0.5, ageMs / TIME_PROXIMITY_HALF_LIFE_MS);
  return { boost: TIME_PROXIMITY_WEIGHT * decay, recent: decay >= 0.5 };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Rank the recorded sessions against a ticket symptom and decide whether any of
 * them IS the incident. Iterates store.listSessions() / store.readDistinctBugs()
 * exactly like recallLocal, scoring each distinct bug with the shared 4-facet
 * scorer, then refining with the two bounded incident signals. Returns ALL
 * scored candidates (base signal > 0) ranked deterministically, even when the
 * outcome is "inconclusive", so near-misses stay visible but are never promoted.
 */
export async function locateIncident(
  symptom: Symptom,
  store: RecallStore,
  opts: LocateIncidentOptions = {},
): Promise<LocateIncidentResult> {
  const now = opts.now ?? Date.now();
  const threshold = opts.threshold ?? DEFAULT_MATCH_THRESHOLD;
  const margin = opts.margin ?? DEFAULT_MATCH_MARGIN;
  const query = symptomProfile(symptom);
  const symptomRelease = symptom.release?.trim();

  const candidates: RankedCandidate[] = [];
  for (const { id, dir } of await store.listSessions()) {
    const bundle =
      (await store.readJsonRecord(dir, "llm.json")) ??
      (await store.readJsonRecord(dir, "bundle.json")) ??
      {};
    const candidateAccount = await candidateAccountId(dir, store);
    if (
      opts.accountId !== undefined &&
      candidateAccount !== undefined &&
      candidateAccount !== opts.accountId
    ) {
      continue;
    }
    const sessionTime = await candidateSessionTime(dir, store, bundle);
    const release = await candidateRelease(dir, store);
    for (const raw of await store.readDistinctBugs(dir)) {
      if (!store.isDistinctBugRecord(raw)) continue;
      const bug = raw as unknown as DistinctBug;
      const base = scoreLocalIssue(query, bugProfile(bug, bundle));
      // Candidacy requires base signal: a session can only be the incident if it
      // textually/structurally rhymes with the symptom. Time/release only refine.
      if (base.score <= 0) continue;

      const reasons = [...base.reasons];
      const time = timeProximity(now, sessionTime);
      if (time.recent) reasons.push("time-proximity");

      let releaseBoost = 0;
      if (
        symptomRelease &&
        release &&
        symptomRelease.toLowerCase() === release.trim().toLowerCase()
      ) {
        releaseBoost = RELEASE_HINT_WEIGHT;
        reasons.push("release-hint");
      }

      candidates.push({
        sessionId: id,
        bugId: bug.bugId,
        confidence: clamp01(base.score + time.boost + releaseBoost),
        reasons,
        sessionTime,
        bug,
      });
    }
  }

  // Deterministic total order: confidence desc, then a more-recent session
  // first (unknown times last), then bugId asc. sessionId resolves the only
  // remaining impossible-to-rank duplicate so list/read order never leaks in.
  candidates.sort((a, b) => {
    const confidenceOrder = b.confidence - a.confidence;
    if (confidenceOrder !== 0) return confidenceOrder;
    if (a.sessionTime !== b.sessionTime) {
      if (a.sessionTime === undefined) return 1;
      if (b.sessionTime === undefined) return -1;
      return b.sessionTime - a.sessionTime;
    }
    return (
      a.bugId.localeCompare(b.bugId) || a.sessionId.localeCompare(b.sessionId)
    );
  });

  const top1 = candidates[0]?.confidence;
  const top2 = candidates[1]?.confidence ?? 0;
  const outcome: LocateIncidentResult["outcome"] =
    top1 === undefined || top1 < threshold
      ? "inconclusive"
      : top1 - top2 >= margin
        ? "matched"
        : "ambiguous";

  logLocate(outcome, candidates);
  return { outcome, candidates };
}

/** One structured score line per call, to STDERR only — stdout is reserved for
 *  the JSON-RPC transport. Logs a compact projection (never the full bug). */
function logLocate(
  outcome: LocateIncidentResult["outcome"],
  candidates: RankedCandidate[],
): void {
  const top1 = candidates[0]?.confidence ?? 0;
  const top2 = candidates[1]?.confidence ?? 0;
  const accepted = outcome === "matched" || outcome === "ambiguous";
  const line = {
    event: "locate-incident",
    outcome,
    // Keep the top score and its achieved lead explicit for calibration. A
    // single candidate has a runner up score of zero, so its margin is top1.
    ...(accepted ? { score: top1, margin: top1 - top2 } : {}),
    candidates: candidates.map((c) => ({
      sessionId: c.sessionId,
      bugId: c.bugId,
      confidence: Math.round(c.confidence * 1000) / 1000,
      reasons: c.reasons,
    })),
  };
  process.stderr.write(`${JSON.stringify(line)}\n`);
}

/** Lane a distinct-bug evidence class maps onto for located (single-session)
 *  evidence: front-end signals are browser-observed, back-end signals ride the
 *  network lane, db diffs are db. */
function refToEvidence(
  ref: DistinctBugEvidenceRef,
  lane: EvidenceLane,
  sessionId: string,
): EvidenceItem {
  const evidenceRef: EvidenceRef = { sessionId };
  if (ref.requestId !== undefined) evidenceRef.requestId = ref.requestId;
  const briefParts = [ref.message, ref.route, ref.detector].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );
  return {
    id: ref.candidateId,
    lane,
    kind: ref.detector,
    brief: briefParts.join(" · ") || ref.candidateId,
    ref: evidenceRef,
    // No-baseline semantics: a located session is a single observation with no
    // baseline to diff against, so there is no "before" value — `before` is
    // undefined and `after` carries the observed signal (the recorded message).
    before: undefined,
    after: ref.message,
    // Preserve the ref's observation time so located evidence still carries
    // "when" even though it has no baseline to diff against.
    whenObserved: ref.t,
  };
}

/**
 * Adapt a matched {@link DistinctBug}'s evidence refs into neutral
 * {@link EvidenceItem}s for the located session. This is intentionally NOT the
 * diff-based compare/evidence-map adapter: there is no baseline here, so every
 * item is single-sided (before undefined, after = observed). Emits front-end,
 * then back-end, then db evidence for stable ordering.
 */
export function locatedEvidence(
  bug: DistinctBug,
  sessionId: string,
): EvidenceItem[] {
  const frontend = Array.isArray(bug.frontendEvidence)
    ? bug.frontendEvidence
    : [];
  const backend = Array.isArray(bug.backendEvidence) ? bug.backendEvidence : [];
  const db = Array.isArray(bug.dbDiffs) ? bug.dbDiffs : [];
  return [
    ...frontend.map((ref) => refToEvidence(ref, "browser", sessionId)),
    ...backend.map((ref) => refToEvidence(ref, "network", sessionId)),
    ...db.map((ref) => refToEvidence(ref, "db", sessionId)),
  ];
}

// --- Shared locate → assemble helper (one source of truth) -----------------
//
// The MCP tool (McpServer.toolSolveContext) and the inner HTTP endpoint
// (packages/node/src/server.ts POST /api/solve-context) must not each re-derive
// the "locate the incident, adapt its evidence, assemble a bundle" sequence.
// locateEvidence owns the locate + evidence-adaptation slice; toolSolveContext
// calls it to populate its evidence (behavior byte-identical to its former
// inline block). locateAndAssemble composes locateEvidence with assembleBundle
// and is what the inner endpoint returns.

/** The decision the locate engine reached, in the pinned envelope shape the
 *  inner /api/solve-context endpoint returns (and CP4 consumes verbatim).
 *  sessionId is present ONLY when a session was matched — never fabricated. */
export interface LocateMatch {
  sessionId?: string;
  confidence: number;
  outcome: LocateIncidentResult["outcome"];
  reasons: string[];
  /** Compact ranked candidates for an ambiguous decision, never full bug data. */
  candidates?: Array<{
    sessionId: string;
    bugId: string;
    confidence: number;
    reasons: string[];
  }>;
}

/** Gap emitted for an inconclusive locate, mirroring toolSolveContext's
 *  gaps-only fallback so an inconclusive inner bundle reads the same as the MCP
 *  tool's no-evidence path. */
export const NO_LOCATED_SESSION_GAP: EvidenceGap = {
  lane: "network",
  reason: "no recorded session matched this symptom",
  suggestion: "provide baselineSession + currentSession, or widen capture",
};

/** Gap emitted alongside the standard no-session gap when several candidates
 * are too close to attribute evidence honestly to one session. */
export const AMBIGUOUS_LOCATED_SESSION_GAP: EvidenceGap = {
  lane: "network",
  reason:
    "multiple candidate sessions scored within the decision margin; none is conclusive",
  suggestion: "review the candidate sessions before acting",
};

function projectCandidates(
  candidates: RankedCandidate[],
): NonNullable<LocateMatch["candidates"]> {
  return candidates.slice(0, 3).map((candidate) => ({
    sessionId: candidate.sessionId,
    bugId: candidate.bugId,
    confidence: candidate.confidence,
    reasons: candidate.reasons,
  }));
}

/**
 * Locate the incident for a symptom and adapt the top matched candidate into
 * neutral evidence. On a match, evidence is the located session's evidence and
 * match.sessionId is set; on an inconclusive locate, evidence is [] and
 * match.sessionId is absent. Only ambiguous outcomes retain a compact near-miss
 * list; inconclusive envelopes keep their established shape. Neither adapts
 * session evidence. This is the exact locate → evidence slice toolSolveContext
 * used inline; it is factored here so the inner endpoint shares it.
 */
export async function locateEvidence(
  symptom: Symptom,
  store: RecallStore,
  opts: LocateIncidentOptions = {},
): Promise<{ evidence: EvidenceItem[]; match: LocateMatch }> {
  const located = await locateIncident(symptom, store, opts);
  const top = located.candidates[0];
  if (located.outcome === "matched" && top) {
    return {
      evidence: locatedEvidence(top.bug, top.sessionId),
      match: {
        sessionId: top.sessionId,
        confidence: top.confidence,
        outcome: "matched",
        reasons: top.reasons,
      },
    };
  }
  if (located.outcome === "ambiguous") {
    return {
      evidence: [],
      match: {
        confidence: top?.confidence ?? 0,
        outcome: "ambiguous",
        reasons: top?.reasons ?? [],
        candidates: projectCandidates(located.candidates),
      },
    };
  }
  return {
    evidence: [],
    match: {
      confidence: top?.confidence ?? 0,
      outcome: "inconclusive",
      reasons: top?.reasons ?? [],
    },
  };
}

// --- Adapter (evidence-source) phase ---------------------------------------
//
// After the incident window is located, query the client's EXISTING
// observability tools (the CP1 evidence-source framework) for neutral
// evidence.v1 items inside that window and merge them ALONGSIDE session-derived
// evidence — the one fusion path (assembleBundle) ranks the mixed set; adapter
// items are never special-cased or re-ranked. Two windows feed the query:
//   - matched locate → the located session's observed-time span + its
//     correlation keys (sessionId, requestId/traceId) plus symptom keys.
//   - NO session matched (sessionless "Mode A") → a bounded fallback window
//     ending at the ticket's reference time, reaching SESSIONLESS_LOOKBACK_MS
//     back, keyed only by symptom-extractable keys (url/release/user).
// The phase is advisory: with zero sources configured it is a no-op, so the
// session-matched path stays byte-identical to today; a dead/slow source
// degrades to a gap inside fetchAdapterEvidence, never a thrown error.

/**
 * Sessionless (Mode A) lookback: how far BEFORE a ticket's reference time to
 * scan a client's evidence sources when NO Crumbtrail session matched. 24h is a
 * deliberate guess — long enough to catch a ticket filed the morning after an
 * incident, short enough to bound adapter egress. TUNE ME (raise for
 * slow-to-report teams, lower to cut noise/cost). Intentionally a named
 * constant and NOT yet a config surface (see brief Assumptions). The window is
 * capped by this lookback; per-source `maxItems`/`maxBytes` bound volume.
 */
export const SESSIONLESS_LOOKBACK_MS = 24 * 60 * 60 * 1000;

/**
 * Default egress bounds for an adapter {@link EvidenceQuery}. maxItems/maxBytes
 * cap volume (important for the wide sessionless window); timeoutMs bounds a
 * slow source. Mirrors the framework's own byte-cap discipline.
 */
export const DEFAULT_EVIDENCE_QUERY_LIMITS: EvidenceQuery["limits"] = {
  maxItems: 50,
  maxBytes: 512 * 1024,
  timeoutMs: 10_000,
};

/** Injection + tuning seam for the adapter phase (production defaults to env). */
export interface AdapterPhaseOptions {
  /** Injected evidence sources (DI seam). Defaults to evidenceSourcesFromEnv(). */
  sources?: EvidenceSource[];
  /** Reference "now" for the sessionless fallback window. Defaults to Date.now(). */
  now?: number;
  /** Ticket created-time (ms) for the sessionless window when known; else `now`. */
  ticketCreatedAt?: number;
  /** EvidenceQuery limits. Defaults to {@link DEFAULT_EVIDENCE_QUERY_LIMITS}. */
  limits?: EvidenceQuery["limits"];
  /** fetchAdapterEvidence options (clock / byte-cap overrides for tests). */
  fetchOptions?: FetchAdapterEvidenceOptions;
}

/**
 * Build the {@link EvidenceQuery} for the adapter phase from the located
 * incident (matched → observed-time span + correlation keys; sessionless →
 * bounded fallback window). Pure and deterministic; exported for direct testing.
 */
export function buildEvidenceQuery(
  symptom: Symptom,
  located: { evidence: EvidenceItem[]; match: LocateMatch },
  opts: AdapterPhaseOptions = {},
): EvidenceQuery {
  const now = opts.now ?? Date.now();
  const limits = opts.limits ?? DEFAULT_EVIDENCE_QUERY_LIMITS;

  // Symptom-extractable keys apply to BOTH paths (matched + sessionless).
  const keys: EvidenceQuery["keys"] = {};
  if (symptom.url) keys.url = symptom.url;
  if (symptom.release) keys.release = symptom.release;
  if (symptom.user) keys.user = symptom.user;

  // A matched locate ALWAYS contributes its session's correlation keys, even in
  // the (rare) matched-but-empty-evidence case: the sessionId is a real key an
  // adapter can filter by, and dropping it would silently degrade a matched
  // ticket to a symptom-only fetch. requestId/traceId + the observed-time window
  // are derived from the located evidence and only apply when evidence exists.
  const matched = located.match.outcome === "matched";
  if (matched && located.match.sessionId) {
    keys.sessionId = located.match.sessionId;
  }

  if (matched && located.evidence.length > 0) {
    // requestId doubles as traceId in the repo's correlation model — feed both
    // so an adapter can filter by whichever it declares.
    const requestId = located.evidence.find((item) => item.ref?.requestId)?.ref
      ?.requestId;
    if (requestId) {
      keys.requestId = requestId;
      keys.traceId = requestId;
    }
    const times = located.evidence
      .map((item) => item.whenObserved)
      .filter((t): t is number => typeof t === "number");
    const start =
      times.length > 0 ? Math.min(...times) : now - SESSIONLESS_LOOKBACK_MS;
    const end = times.length > 0 ? Math.max(...times) : now;
    return { window: { start, end }, keys, symptom, limits };
  }

  // Sessionless Mode A (and the matched-but-empty guard above): a bounded
  // fallback window ending at the ticket's reference time (created-time when
  // known so a stale ticket anchors to incident time, not "now"), reaching
  // SESSIONLESS_LOOKBACK_MS back. Any matched sessionId is already in `keys`.
  const reference = opts.ticketCreatedAt ?? now;
  return {
    window: { start: reference - SESSIONLESS_LOOKBACK_MS, end: reference },
    keys,
    symptom,
    limits,
  };
}

/**
 * Per-source health summary threaded up to the cloud layer so the webhook can
 * record connector success/failure for each evidence source. Deliberately
 * minimal (provider + the framework's `ok` verdict + the already-sanitized
 * error) — it carries NO items/gaps and no raw provider payload, so it is safe
 * to serialize across the inner /api/solve-context boundary. `ok` follows the
 * framework invariant: false iff the source could not deliver primary evidence
 * (see {@link AdapterSourceStats}).
 */
export interface EvidenceSourceHealth {
  provider: string;
  ok: boolean;
  /** Sanitized failure reason when `ok` is false (never a raw secret/token). */
  error?: string;
}

/** Project the framework's per-source stats onto the minimal cloud-facing
 *  health summary. Drops volume/latency detail the connector-status surface
 *  does not need. */
function toSourceHealth(stats: AdapterSourceStats[]): EvidenceSourceHealth[] {
  return stats.map((s) => ({
    provider: s.provider,
    ok: s.ok,
    ...(s.error ? { error: s.error } : {}),
  }));
}

/**
 * Adapter phase: query the client's configured evidence sources for the located
 * incident window and return neutral evidence.v1 items + gaps to merge into the
 * bundle ALONGSIDE session-derived evidence, plus a minimal per-source health
 * summary for the cloud connector-status surface. Never throws — a dead/slow
 * source degrades to a gap inside fetchAdapterEvidence. With ZERO sources
 * configured this returns `{ items: [], gaps: [], sources: [] }`, so the
 * caller's behavior is identical to the pre-adapter path.
 */
export async function gatherAdapterEvidence(
  symptom: Symptom,
  located: { evidence: EvidenceItem[]; match: LocateMatch },
  opts: AdapterPhaseOptions = {},
): Promise<{
  items: EvidenceItem[];
  gaps: EvidenceGap[];
  sources: EvidenceSourceHealth[];
}> {
  const sources = opts.sources ?? evidenceSourcesFromEnv();
  if (sources.length === 0) return { items: [], gaps: [], sources: [] };
  const query = buildEvidenceQuery(symptom, located, opts);
  const { items, gaps, stats } = await fetchAdapterEvidence(
    sources,
    query,
    opts.fetchOptions,
  );
  return { items, gaps, sources: toSourceHealth(stats) };
}

/**
 * Locate + assemble in one call: produce the persisted RankedBundle for a
 * symptom (always assembleBundle output, never hand-assembled) alongside the
 * pinned {@link LocateMatch}. A matched locate assembles the located session's
 * evidence; a no-session locate assembles a bundle built purely from adapter
 * evidence (sessionless Mode A) when sources are configured, or empty evidence
 * with the standard "no session matched" gap when they are not. Either way a
 * no-session bundle carries {@link NO_LOCATED_SESSION_GAP} stating that no
 * Crumbtrail session matched. Adapter items are ranked through the one fusion
 * path (never special-cased). Used by the inner /api/solve-context endpoint, so
 * the cloud webhook picks up the adapter phase for free.
 */
export async function locateAndAssemble(
  symptom: Symptom,
  store: RecallStore,
  opts: LocateIncidentOptions & AdapterPhaseOptions = {},
): Promise<{
  bundle: RankedBundle;
  match: LocateMatch;
  sources: EvidenceSourceHealth[];
}> {
  const located = await locateEvidence(symptom, store, opts);
  const adapter = await gatherAdapterEvidence(symptom, located, opts);
  const evidence = [...located.evidence, ...adapter.items];
  // A no-session locate ALWAYS states that no Crumbtrail session matched —
  // whether the bundle ends up empty (today's inconclusive) or populated purely
  // from adapter evidence (Mode A). A matched locate carries only adapter gaps.
  // An ambiguous decision names its ambiguity separately so consumers can route
  // the candidates to review rather than treat it as a normal no-match.
  const gaps =
    located.evidence.length === 0
      ? [
          NO_LOCATED_SESSION_GAP,
          ...(located.match.outcome === "ambiguous"
            ? [AMBIGUOUS_LOCATED_SESSION_GAP]
            : []),
          ...adapter.gaps,
        ]
      : [...adapter.gaps];
  // Thread the locate decision onto the bundle (RankedBundle.located) so the
  // persisted bundle carries it uniformly with the MCP tool's output; the
  // separate `match` return stays for back-compat. method "fuzzy": scored
  // locate engine (War-game 02's token join sets "token" via the same field).
  const located_: Located = {
    outcome: located.match.outcome,
    confidence: located.match.confidence,
    method: "fuzzy",
    ...(located.match.sessionId ? { sessionId: located.match.sessionId } : {}),
    reasons: located.match.reasons,
    ...(located.match.outcome === "ambiguous" && located.match.candidates
      ? { candidates: located.match.candidates }
      : {}),
  };
  const bundle = assembleBundle({
    symptom,
    evidence,
    intent: [],
    gaps,
    located: located_,
  });
  // `sources` is the per-source health summary the inner endpoint surfaces so
  // the cloud webhook can record connector success/failure. Advisory only.
  return { bundle, match: located.match, sources: adapter.sources };
}
