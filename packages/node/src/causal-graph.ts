import {
  redactTokenLikeString,
  redactUrl,
  type BugEvent,
} from "crumbtrail-core";

/**
 * Causal graph module. Pure, deterministic assembly of a typed node/edge graph from the event
 * stream; the output is attached to index.json (index.causalGraph) as the single correlation
 * mechanism. Every field placed on a node is a short REDACTED descriptor: raw URLs, bodies, and
 * input values never land here.
 */

export const CAUSAL_GRAPH_SCHEMA_VERSION = "causal-graph.v1" as const;

/**
 * 15 node kinds. The last three (`state.diff`, `decision`, `thirdparty.call`) are Phase 2
 * reserved: valid members of the union but never emitted by `buildCausalGraph` in CP1.
 */
export type CausalNodeKind =
  | "user.click"
  | "user.input"
  | "user.nav"
  | "net.req"
  | "net.res"
  | "backend.req"
  | "backend.error"
  | "db.write"
  | "otel.span"
  | "otel.log"
  | "frontend.error"
  | "console.error"
  | "state.diff" // Phase 2 reserved
  | "decision" // Phase 2 reserved
  | "thirdparty.call"; // Phase 2 reserved

export type CausalEdgeKind = "request" | "interaction" | "symptom" | "temporal";

export type CausalConfidence = "high" | "medium" | "low";

export interface CausalNode {
  id: string;
  kind: CausalNodeKind;
  t: number;
  requestId?: string;
  sig?: string;
  route?: string;
  brief: string;
  candidateId?: string;
}

export interface CausalEdge {
  from: string;
  to: string;
  kind: CausalEdgeKind;
  confidence: CausalConfidence;
}

export interface CausalGraph {
  schemaVersion: typeof CAUSAL_GRAPH_SCHEMA_VERSION;
  nodes: CausalNode[];
  edges: CausalEdge[];
}

// --- Confidence / window constants -----------------------------------------------------------
// Sole definition of the correlation window/banding (the legacy post-process chain mechanism that
// once carried an identical copy was retired in CP5).
const WINDOW_MS = 2000;
const HIGH_CONFIDENCE_MS = 500;

/** Two-band form: <=500 high, else medium. */
function confidence2(deltaMs: number): "high" | "medium" {
  return deltaMs <= HIGH_CONFIDENCE_MS ? "high" : "medium";
}

// --- REDACTION HELPERS (local reimplementations of post-process semantics) --------------------
// The post-process safeUrl/safePath/safeDiagnosticString/safeString helpers are non-exported, so
// small local equivalents are used here. They must NEVER let a raw URL/body/input value through.

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 120);
}

function redactPathTokens(value: string): string {
  return value
    .split("/")
    .map((segment) =>
      /^[A-Za-z0-9_-]{16,}$/.test(segment) ? "[REDACTED]" : segment,
    )
    .join("/");
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return safeString(redactPathTokens(redactUrl(value, "url").value));
}

function safePath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return safeString(
    redactPathTokens(redactTokenLikeString(value, "path").value),
  );
}

function safeDiagnosticString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return redactTokenLikeString(trimmed, "diagnostic").value.slice(0, 120);
}

function safeId(value: unknown): string | undefined {
  if (typeof value === "string") return safeString(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Body inspection is a coarse mirror of post-process.ts's isFailedNetworkResponse: a truthy
// application-failure marker or an ok:false payload flags failure.
function isFailedNetworkResponse(event: BugEvent): boolean {
  if (event.k !== "net.res") return false;
  if (typeof event.d.st === "number" && event.d.st >= 400) return true;
  const body = event.d.body;
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body);
      if (
        isRecord(parsed) &&
        (parsed.ok === false ||
          typeof parsed.error === "string" ||
          typeof parsed.code === "string")
      ) {
        return true;
      }
    } catch {
      // non-JSON body: not a structured application failure
    }
  } else if (
    isRecord(body) &&
    (body.ok === false ||
      typeof body.error === "string" ||
      typeof body.code === "string")
  ) {
    return true;
  }
  return false;
}

// --- Node model ------------------------------------------------------------------------------

interface DerivedNode extends CausalNode {
  /** Original source event kind, kept for edge-rule classification (not serialized). */
  srcKind: string;
  /** True when this net.res node represents a failed response (not serialized). */
  failedRes?: boolean;
}

const CONSOLE_ERROR_KIND = "con";
const DB_DIFF_KIND = "db.diff";
const OTEL_SPAN_KIND = "backend.otel.span";
const OTEL_LOG_KIND = "backend.otel.log";

function consoleIsError(value: unknown): boolean {
  const level = safeString(value)?.toLowerCase();
  if (!level) return false;
  const normalized = level === "error" ? "err" : level;
  return normalized.startsWith("err");
}

/**
 * Maps one BugEvent to a node kind, or undefined when the event is not a causal node. Grounded in
 * the real event-kind strings (post-process.ts / backend-events.ts / otel-adapter.ts).
 */
function nodeKindFor(event: BugEvent): CausalNodeKind | undefined {
  switch (event.k) {
    case "clk":
      return "user.click";
    case "inp":
      return "user.input";
    case "nav":
      return "user.nav";
    case "net.req":
      return "net.req";
    case "net.res":
      return "net.res";
    case "backend.req.start":
    case "backend.req.end":
      return "backend.req";
    case "backend.req.error":
      return "backend.error";
    // Auto-captured uncaught exceptions / unhandled rejections (crumbtrail-node's
    // AUTO_CAPTURE_ERROR_EVENT). Request-less, but still a backend failure, so it
    // maps onto the same backend.error node kind as backend.req.error.
    case "backend.uncaught":
      return "backend.error";
    case DB_DIFF_KIND:
      return "db.write";
    case OTEL_SPAN_KIND:
      return "otel.span";
    case OTEL_LOG_KIND:
      return "otel.log";
    case "err":
    case "rej":
      return "frontend.error";
    case CONSOLE_ERROR_KIND:
      return consoleIsError(event.d.lv) ? "console.error" : undefined;
    default:
      return undefined;
  }
}

/**
 * Deterministic per-event disambiguator for node ids -- NEVER an array index. Preference order:
 * requestId (backend/db/otel/network-with-requestId), else browser d.id (network), else spanId
 * (otel), else a redacted content signature. Residual collisions are resolved later by a stable
 * counter derived from a deterministic (t, then partial id) pre-sort.
 */
function disambiguatorFor(event: BugEvent, kind: CausalNodeKind): string {
  const requestId = safeId(event.d.requestId);
  if (requestId) return `r=${requestId}`;
  if (kind === "net.req" || kind === "net.res") {
    const browserId = safeId(event.d.id);
    if (browserId) return `b=${browserId}`;
  }
  if (kind === "otel.span" || kind === "otel.log") {
    const spanId = safeId(event.d.spanId);
    if (spanId) return `s=${spanId}`;
  }
  return `c=${contentSignature(event, kind)}`;
}

function contentSignature(event: BugEvent, kind: CausalNodeKind): string {
  const parts = [kind, routeFor(event) ?? "", sigFor(event, kind) ?? ""];
  return parts.join("|");
}

function routeFor(event: BugEvent): string | undefined {
  return safePath(event.d.route) ?? safePath(event.d.name);
}

function sigFor(event: BugEvent, kind: CausalNodeKind): string | undefined {
  switch (kind) {
    case "net.req":
    case "net.res":
      return safeUrl(event.d.url);
    case "otel.span":
      // Spans carry name/statusMessage (otel-adapter span conversion). Logs do NOT.
      return (
        safePath(event.d.name) ?? safeDiagnosticString(event.d.statusMessage)
      );
    case "otel.log":
      // Log records carry severityText/body (otel-adapter.ts convertOtlpLogsToEvents); name and
      // statusMessage are span-only fields and are undefined here. Source the sig from the log's
      // own fields, still REDACTED via safeDiagnosticString (120-char cap, no raw body).
      return (
        safeDiagnosticString(event.d.severityText) ??
        safeDiagnosticString(event.d.body)
      );
    case "frontend.error":
    case "console.error":
      return safeDiagnosticString(event.d.msg);
    case "backend.error":
      return (
        safeDiagnosticString(event.d.message) ??
        safeDiagnosticString(event.d.code)
      );
    default:
      return undefined;
  }
}

function briefFor(event: BugEvent, kind: CausalNodeKind): string {
  const method = safeString(event.d.m ?? event.d.method);
  switch (kind) {
    case "user.click":
      return "user click";
    case "user.input":
      return "user input";
    case "user.nav":
      return `nav ${safeUrl(event.d.to) ?? ""}`.trim();
    case "net.req":
      return `${method ?? "req"} ${safeUrl(event.d.url) ?? ""}`.trim();
    case "net.res": {
      const st = typeof event.d.st === "number" ? event.d.st : undefined;
      return `res ${st ?? ""} ${safeUrl(event.d.url) ?? ""}`.trim();
    }
    case "backend.req":
      return `backend ${routeFor(event) ?? ""}`.trim();
    case "backend.error":
      return `backend error ${sigFor(event, kind) ?? ""}`.trim();
    case "db.write":
      return `db ${safeString(event.d.op) ?? "write"} ${safeString(event.d.table) ?? ""}`.trim();
    case "otel.span":
      return `span ${safePath(event.d.name) ?? ""}`.trim();
    case "otel.log":
      return `log ${sigFor(event, kind) ?? ""}`.trim();
    case "frontend.error":
      return `frontend error ${sigFor(event, kind) ?? ""}`.trim();
    case "console.error":
      return `console error ${sigFor(event, kind) ?? ""}`.trim();
    default:
      return kind;
  }
}

/** Node kinds treated as "network request roots" for interaction back-scan. */
const NET_REQ_KINDS = new Set<CausalNodeKind>(["net.req"]);
const USER_INTERACTION_KINDS = new Set<CausalNodeKind>([
  "user.click",
  "user.input",
]);
const SYMPTOM_TARGET_KINDS = new Set<CausalNodeKind>([
  "frontend.error",
  "console.error",
]);

/**
 * Pure, deterministic. Assembles a CausalGraph from the event stream. No fs/IO, no Date.now, no
 * randomness, no input mutation.
 */
export function buildCausalGraph(input: { events: BugEvent[] }): CausalGraph {
  const { events } = input;

  // --- 1. Build a browser-id -> requestId join for network events (mirrors post-process) --------
  const browserIdToRequestId = new Map<string, string>();
  for (const event of events) {
    if (
      event.k === "net.req" ||
      event.k === "net.res" ||
      event.k === "net.err"
    ) {
      const browserId = safeId(event.d.id);
      const requestId = safeId(event.d.requestId);
      if (browserId && requestId && !browserIdToRequestId.has(browserId)) {
        browserIdToRequestId.set(browserId, requestId);
      }
    }
  }

  // --- 2. Derive nodes (no array-index ids) ----------------------------------------------------
  const derived: DerivedNode[] = [];
  for (const event of events) {
    const kind = nodeKindFor(event);
    if (!kind) continue;

    let requestId = safeId(event.d.requestId);
    if (!requestId && (kind === "net.req" || kind === "net.res")) {
      const browserId = safeId(event.d.id);
      if (browserId) requestId = browserIdToRequestId.get(browserId);
    }

    const disambiguator = disambiguatorFor(event, kind);
    const baseId = `${kind}:${event.t}:${disambiguator}`;

    derived.push({
      id: baseId,
      kind,
      t: event.t,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(sigFor(event, kind) !== undefined
        ? { sig: sigFor(event, kind) }
        : {}),
      ...(routeFor(event) !== undefined ? { route: routeFor(event) } : {}),
      brief: briefFor(event, kind),
      srcKind: event.k,
      ...(kind === "net.res" && isFailedNetworkResponse(event)
        ? { failedRes: true }
        : {}),
    });
  }

  // --- 3. Resolve residual id collisions deterministically -------------------------------------
  // Pre-sort by (t, then baseId) -- never iteration order -- so a colliding pair gets a stable
  // counter suffix that is identical across builds regardless of input order.
  const collisionSort = [...derived].sort(
    (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const seen = new Map<string, number>();
  for (const node of collisionSort) {
    const count = seen.get(node.id) ?? 0;
    seen.set(node.id, count + 1);
    if (count > 0) node.id = `${node.id}#${count}`;
  }

  // --- 4. Derive edges -------------------------------------------------------------------------
  const edges: CausalEdge[] = [];
  const edgeSeen = new Set<string>();
  // Track which "effect" nodes already have a stronger (non-temporal) edge keyed to them, so the
  // temporal fallback (rule 4) never double-emits.
  const strongerEdgeTargets = new Set<string>();

  function addEdge(
    from: string,
    to: string,
    kind: CausalEdgeKind,
    conf: CausalConfidence,
  ): void {
    if (from === to) return;
    const key = JSON.stringify([from, to, kind]);
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ from, to, kind, confidence: conf });
    if (kind !== "temporal") strongerEdgeTargets.add(to);
  }

  const byTime = [...derived].sort(
    (a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // Rule 1 -- request (high): per requestId, order that request's nodes by t and connect the spine.
  const byRequestId = new Map<string, DerivedNode[]>();
  for (const node of byTime) {
    if (!node.requestId) continue;
    const list = byRequestId.get(node.requestId) ?? [];
    list.push(node);
    byRequestId.set(node.requestId, list);
  }
  for (const [, group] of byRequestId) {
    // group is already t-sorted (byTime is sorted). Connect the HTTP spine in canonical order.
    connectRequestSpine(group, addEdge);
  }
  // OTLP: net.req ->(traceId===requestId) otel.span -> otel.log is handled inside connectRequestSpine
  // since span/log share the same requestId (=traceId) as the network node.

  // Rule 2 -- interaction: backward-scan from a net.req node to the nearest preceding
  // user.click/user.input within WINDOW_MS.
  for (let i = 0; i < byTime.length; i++) {
    const node = byTime[i];
    if (!NET_REQ_KINDS.has(node.kind)) continue;
    const trigger = scanBackward(byTime, i, USER_INTERACTION_KINDS);
    if (!trigger) continue;
    const delta = node.t - trigger.t;
    const sameContext =
      (node.route !== undefined && node.route === trigger.route) ||
      (node.sig !== undefined && node.sig === trigger.sig);
    const conf: CausalConfidence =
      delta <= HIGH_CONFIDENCE_MS && sameContext ? "high" : "medium";
    addEdge(trigger.id, node.id, "interaction", conf);
  }

  // Rule 3 -- symptom: from a failed net.res or backend.error node to a FOLLOWING
  // frontend.error/console.error within WINDOW_MS.
  for (let i = 0; i < byTime.length; i++) {
    const source = byTime[i];
    const isFailedRes = source.kind === "net.res" && source.failedRes === true;
    const isBackendError = source.kind === "backend.error";
    if (!isFailedRes && !isBackendError) continue;
    // forward scan for the nearest following symptom within window
    for (let j = i + 1; j < byTime.length; j++) {
      const target = byTime[j];
      if (target.t - source.t > WINDOW_MS) break;
      if (!SYMPTOM_TARGET_KINDS.has(target.kind)) continue;
      const conf = confidence2(target.t - source.t);
      addEdge(source.id, target.id, "symptom", conf);
      break; // nearest following only
    }
  }

  // Rule 4 -- temporal (low): from an err/rej/con(error) node to the nearest preceding trigger
  // within WINDOW_MS, ONLY when no stronger edge already keys that node.
  const TEMPORAL_TRIGGER_KINDS = new Set<CausalNodeKind>([
    "user.click",
    "user.input",
    "user.nav",
    "net.res",
    "net.req",
  ]);
  for (let i = 0; i < byTime.length; i++) {
    const node = byTime[i];
    if (!SYMPTOM_TARGET_KINDS.has(node.kind)) continue;
    if (strongerEdgeTargets.has(node.id)) continue; // stronger edge already covers it
    const trigger = scanBackward(byTime, i, TEMPORAL_TRIGGER_KINDS);
    if (!trigger) continue;
    addEdge(trigger.id, node.id, "temporal", "low");
  }

  // --- 5. Sort for byte-identical output -------------------------------------------------------
  const nodes: CausalNode[] = derived
    .map(stripDerived)
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  edges.sort((a, b) =>
    a.from < b.from
      ? -1
      : a.from > b.from
        ? 1
        : a.to < b.to
          ? -1
          : a.to > b.to
            ? 1
            : a.kind < b.kind
              ? -1
              : a.kind > b.kind
                ? 1
                : 0,
  );

  return { schemaVersion: CAUSAL_GRAPH_SCHEMA_VERSION, nodes, edges };
}

function stripDerived(node: DerivedNode): CausalNode {
  const { srcKind: _srcKind, failedRes: _failedRes, ...rest } = node;
  return rest;
}

// --- Candidate -> node attribution (CP3) -------------------------------------------------------
// Pure, deterministic, no IO, no input mutation. Maps evidence candidates onto graph nodes, then
// classifies each candidate as a root cause, a downstream symptom, or isolated by walking the
// causal ancestry. The caller (evidence-index ranker) uses this to demote symptoms below their
// root while keeping the emitted candidate set unchanged.
//
// The input graph is treated as READ-ONLY: candidateId association lives entirely in local side
// maps here and never mutates `graph.nodes`.

/** Temporal window (ms) for the fallback candidate->node mapping (step 2 of the precedence). */
export const CAUSAL_MAP_WINDOW_MS = 2000;

export type CausalRole = "root" | "symptom" | "isolated";

export interface CandidateAttribution {
  causalRole: CausalRole;
  rootCauseId?: string;
  causes?: string[];
  attributionConfidence?: CausalConfidence;
}

export interface AttributableCandidate {
  id: string;
  anchor: { t: number; requestId?: string; route?: string };
}

/**
 * Maps a candidate detector family onto the node kinds it can attribute to. Deterministic; used
 * only by the temporal fallback (precedence step 2) when a candidate has no requestId match.
 */
function nodeKindsForDetector(detector: string): Set<CausalNodeKind> {
  if (detector.startsWith("backend_"))
    return new Set(["backend.error", "backend.req"]);
  switch (detector) {
    case "http_error":
    case "app_2xx_failure":
    case "network_error":
    case "slow_request":
    case "pending_request":
      return new Set(["net.res", "net.req"]);
    case "uncaught_error":
    case "unhandled_rejection":
      return new Set(["frontend.error"]);
    case "console_error":
      return new Set(["console.error"]);
    // console_warning is intentionally NOT mapped: warn-level `con` events never become graph nodes
    // (nodeKindFor only emits console.error for error-level), so a warning has no node of its own.
    // Falling through to the empty default keeps it isolated instead of stealing a real
    // console.error node from a genuine console_error candidate.
    // db_field_divergence and duplicate_write read the same plane as
    // db_mutation. Both anchor on a write they name explicitly, so when the
    // requestId match in precedence step 1 does not apply they should still
    // reach a db.write node rather than falling through to isolated.
    case "db_mutation":
    case "db_field_divergence":
    case "duplicate_write":
      return new Set(["db.write"]);
    default:
      if (detector.startsWith("otel_"))
        return new Set(["otel.span", "otel.log"]);
      return new Set();
  }
}

const CONFIDENCE_RANK: Record<CausalConfidence, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

/** Returns the weaker of two confidences (min over high>medium>low). */
function weakerConfidence(
  a: CausalConfidence,
  b: CausalConfidence,
): CausalConfidence {
  return CONFIDENCE_RANK[a] <= CONFIDENCE_RANK[b] ? a : b;
}

/**
 * Pure, deterministic candidate->node attribution over a prebuilt CausalGraph.
 *
 * Mapping precedence (anchor -> at most one node):
 *   1. requestId match: nearest |delta-t|, tie-break node id asc.
 *   2. temporal + compatible-kind fallback within CAUSAL_MAP_WINDOW_MS: nearest t, tie-break id asc.
 *   3. no match -> isolated.
 * One candidate per node: on contention the smaller anchor.t (then smaller candidate id) wins; the
 * loser falls back to (2)/(3).
 *
 * Classification (over reverse adjacency effect->cause): nearest candidate-bearing ancestor = root;
 * this candidate becomes a symptom whose rootCauseId is that ancestor and whose attributionConfidence
 * is the WEAKEST edge confidence along the path. A candidate node with no candidate-bearing ancestor
 * is a root, and its `causes` are the sorted candidate ids of the symptoms attributed to it.
 */
export function attributeCandidates(
  graph: CausalGraph,
  candidates: AttributableCandidate[],
  /**
   * Optional detector lookup (candidate id -> detector). When provided, the temporal fallback
   * (mapping precedence step 2) restricts to node kinds compatible with the candidate's detector
   * family; when omitted, step 2 falls back to any unowned node in the window. Pure/deterministic
   * either way. The evidence-index ranker always supplies this.
   */
  detectorById?: (id: string) => string | undefined,
): Map<string, CandidateAttribution> {
  if (graph.nodes.length === 0 || candidates.length === 0) {
    const empty = new Map<string, CandidateAttribution>();
    for (const c of candidates) empty.set(c.id, { causalRole: "isolated" });
    return empty;
  }
  return attributeCandidatesInternal(
    graph,
    candidates,
    detectorById ?? (() => undefined),
  );
}

function attributeCandidatesInternal(
  graph: CausalGraph,
  candidates: AttributableCandidate[],
  detectorById: (id: string) => string | undefined,
): Map<string, CandidateAttribution> {
  // --- 1. Map each candidate to at most one node (with per-node contention arbitration) --------
  // Process candidates in a deterministic order (anchor.t asc, then id asc) so contention winners
  // are stable regardless of input order.
  const sortedCandidates = [...candidates].sort(
    (a, b) =>
      a.anchor.t - b.anchor.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  // node id -> candidate id currently owning it.
  const nodeToCandidate = new Map<string, string>();
  // candidate id -> node id it maps to (undefined until resolved / isolated).
  const candidateToNode = new Map<string, string | undefined>();

  const nodes = graph.nodes;

  function findRequestIdNode(
    anchor: AttributableCandidate["anchor"],
  ): CausalNode | undefined {
    if (!anchor.requestId) return undefined;
    const matches = nodes.filter((n) => n.requestId === anchor.requestId);
    if (matches.length === 0) return undefined;
    return [...matches].sort((a, b) => {
      const da = Math.abs(a.t - anchor.t);
      const db = Math.abs(b.t - anchor.t);
      if (da !== db) return da - db;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })[0];
  }

  function findTemporalNode(
    candidateId: string,
    anchor: AttributableCandidate["anchor"],
    excluded: Set<string>,
  ): CausalNode | undefined {
    const detector = detectorById(candidateId);
    // When a detector is known, restrict to its compatible node-kind family. A KNOWN detector with
    // NO causal node family (e.g. page_probe_failure, media_degradation, tab_boundary_gap,
    // user_marker, repeated_clicks) must NOT temporal-match arbitrary nodes -- it stays isolated so it
    // never steals a request-spine node from the candidate that actually belongs to it. Only when no
    // detector is supplied at all (detectorById -> undefined) do we allow an unrestricted match.
    const kinds =
      detector !== undefined ? nodeKindsForDetector(detector) : undefined;
    if (kinds !== undefined && kinds.size === 0) return undefined;
    const matches = nodes.filter((n) => {
      if (excluded.has(n.id)) return false;
      if (Math.abs(n.t - anchor.t) > CAUSAL_MAP_WINDOW_MS) return false;
      if (kinds && !kinds.has(n.kind)) return false;
      return true;
    });
    if (matches.length === 0) return undefined;
    return [...matches].sort((a, b) => {
      const da = Math.abs(a.t - anchor.t);
      const db = Math.abs(b.t - anchor.t);
      if (da !== db) return da - db;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    })[0];
  }

  // Resolve one candidate to a node, arbitrating contention. Returns the node id or undefined.
  function resolve(candidate: AttributableCandidate): string | undefined {
    const excluded = new Set<string>(nodeToCandidate.keys());

    // Precedence 1: requestId match (may already be owned -> arbitrate).
    const reqNode = findRequestIdNode(candidate.anchor);
    if (reqNode) {
      const owner = nodeToCandidate.get(reqNode.id);
      if (owner === undefined) {
        nodeToCandidate.set(reqNode.id, candidate.id);
        return reqNode.id;
      }
      // Contention: smaller anchor.t, then smaller id wins. Since sortedCandidates is processed in
      // (t, id) order, the incumbent always wins requestId contention; loser falls through.
    }

    // Precedence 2: temporal + compatible-kind fallback over still-unowned nodes.
    const tempNode = findTemporalNode(candidate.id, candidate.anchor, excluded);
    if (tempNode) {
      nodeToCandidate.set(tempNode.id, candidate.id);
      return tempNode.id;
    }

    // Precedence 3: isolated.
    return undefined;
  }

  for (const candidate of sortedCandidates) {
    const nodeId = resolve(candidate);
    candidateToNode.set(candidate.id, nodeId);
  }

  // --- 2. Reverse adjacency (effect -> causes) --------------------------------------------------
  const causesByEffect = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = causesByEffect.get(edge.to) ?? [];
    list.push(edge.from);
    causesByEffect.set(edge.to, list);
  }
  const confByPair = new Map<string, CausalConfidence>();
  for (const edge of graph.edges) {
    // For a given (effect,cause) pair keep the STRONGEST edge confidence (best available link);
    // path weakness is then the min across the path's per-hop best links. Deterministic.
    const key = JSON.stringify([edge.to, edge.from]);
    const existing = confByPair.get(key);
    if (
      existing === undefined ||
      CONFIDENCE_RANK[edge.confidence] > CONFIDENCE_RANK[existing]
    ) {
      confByPair.set(key, edge.confidence);
    }
  }

  // --- 3. For each mapped candidate, walk ancestors to the nearest candidate-bearing ancestor ---
  // Returns { rootNodeId, weakestConfidence } or undefined when no candidate-bearing ancestor.
  function nearestCandidateAncestor(
    startNodeId: string,
  ): { rootNodeId: string; conf: CausalConfidence } | undefined {
    // BFS over reverse adjacency, tracking the weakest confidence along each path. Deterministic
    // frontier ordering (sorted) + visited guard against cycles. First candidate-bearing ancestor
    // reached (by fewest hops, tie-broken by node id) wins.
    const visited = new Set<string>([startNodeId]);
    // frontier entries: [nodeId, weakestConfAlongPath]
    let frontier: Array<[string, CausalConfidence | undefined]> = [
      [startNodeId, undefined],
    ];
    while (frontier.length > 0) {
      const next: Array<[string, CausalConfidence | undefined]> = [];
      // Expand this hop-level, collecting candidate-bearing hits deterministically.
      const hits: Array<{ rootNodeId: string; conf: CausalConfidence }> = [];
      for (const [nodeId, pathConf] of frontier) {
        const causes = [...(causesByEffect.get(nodeId) ?? [])].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        );
        for (const causeId of causes) {
          if (visited.has(causeId)) continue;
          visited.add(causeId);
          const hopConf =
            confByPair.get(JSON.stringify([nodeId, causeId])) ?? "low";
          const newPathConf =
            pathConf === undefined
              ? hopConf
              : weakerConfidence(pathConf, hopConf);
          if (nodeToCandidate.has(causeId)) {
            hits.push({ rootNodeId: causeId, conf: newPathConf });
          } else {
            next.push([causeId, newPathConf]);
          }
        }
      }
      if (hits.length > 0) {
        hits.sort((a, b) =>
          a.rootNodeId < b.rootNodeId
            ? -1
            : a.rootNodeId > b.rootNodeId
              ? 1
              : 0,
        );
        return hits[0];
      }
      frontier = next;
    }
    return undefined;
  }

  const attribution = new Map<string, CandidateAttribution>();
  // symptoms grouped by root candidate id, for the root's `causes` list.
  const symptomsByRoot = new Map<string, string[]>();

  for (const candidate of candidates) {
    const nodeId = candidateToNode.get(candidate.id);
    if (nodeId === undefined) {
      attribution.set(candidate.id, { causalRole: "isolated" });
      continue;
    }
    const ancestor = nearestCandidateAncestor(nodeId);
    if (ancestor) {
      const rootCandidateId = nodeToCandidate.get(ancestor.rootNodeId)!;
      attribution.set(candidate.id, {
        causalRole: "symptom",
        rootCauseId: rootCandidateId,
        attributionConfidence: ancestor.conf,
      });
      const list = symptomsByRoot.get(rootCandidateId) ?? [];
      list.push(candidate.id);
      symptomsByRoot.set(rootCandidateId, list);
    } else {
      // Provisional root; `causes` filled in below once all symptoms are known.
      attribution.set(candidate.id, { causalRole: "root" });
    }
  }

  // Fill each root's sorted `causes` list (omit when empty so undefined never serializes).
  for (const [rootId, attr] of attribution) {
    if (attr.causalRole !== "root") continue;
    const symptoms = symptomsByRoot.get(rootId);
    if (symptoms && symptoms.length > 0) {
      attr.causes = [...symptoms].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    }
  }

  return attribution;
}

/**
 * Backward-scan: break when effectTime - n.t exceeds WINDOW_MS, return the first (nearest)
 * preceding node whose kind matches. Operates over derived nodes sorted by time.
 */
function scanBackward(
  nodes: DerivedNode[],
  effectIdx: number,
  kinds: Set<CausalNodeKind>,
): DerivedNode | undefined {
  const effectTime = nodes[effectIdx].t;
  for (let i = effectIdx - 1; i >= 0; i--) {
    const n = nodes[i];
    if (effectTime - n.t > WINDOW_MS) break;
    if (kinds.has(n.kind)) return n;
  }
  return undefined;
}

/**
 * Connects the request spine (high confidence) for one requestId's time-ordered nodes:
 *   net.req -> backend.req(start) -> db.write* -> (backend.error | backend.req(end)) -> net.res
 * OTLP variant (same requestId===traceId):
 *   net.req -> otel.span -> otel.log
 * Emits sequential edges between the canonical stages present, in time order.
 */
function connectRequestSpine(
  group: DerivedNode[],
  addEdge: (
    from: string,
    to: string,
    kind: CausalEdgeKind,
    conf: CausalConfidence,
  ) => void,
): void {
  // Canonical stage ranking within a request. Lower rank precedes higher rank; equal-rank nodes
  // (e.g. multiple db.write) are chained in time order.
  const rankOf = (kind: CausalNodeKind): number => {
    switch (kind) {
      case "net.req":
        return 0;
      case "backend.req":
        return 1;
      case "otel.span":
        return 1;
      case "db.write":
        return 2;
      case "otel.log":
        return 2;
      case "backend.error":
        return 3;
      case "net.res":
        return 4;
      default:
        return -1;
    }
  };

  // Primary order is time (per spec: "order that request's nodes by t"); the canonical stage rank
  // is only a deterministic tiebreak for events that share a timestamp.
  const spine = group
    .filter((n) => rankOf(n.kind) >= 0)
    .sort((a, b) => {
      if (a.t !== b.t) return a.t - b.t;
      const ra = rankOf(a.kind);
      const rb = rankOf(b.kind);
      if (ra !== rb) return ra - rb;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  for (let i = 0; i + 1 < spine.length; i++) {
    addEdge(spine[i].id, spine[i + 1].id, "request", "high");
  }
}
