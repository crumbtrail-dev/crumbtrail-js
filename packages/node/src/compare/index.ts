import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import type { BugEvent, DbDiffOp, DbEngine } from "crumbtrail-core";
import {
  SESSION_COMPARE_SCHEMA_VERSION,
  type ComparableSession,
  type CompareOptions,
  type ComparisonConfidence,
  type Divergence,
  type EnvChannelDelta,
  type EnvDiff,
  type EnvValueChange,
  type FlowStep,
  type NetworkCall,
  type SessionComparison,
} from "./types";
import { divergencesToEvidence } from "./evidence-map";
import { defaultSessionStore } from "../session-store";

export class CompareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompareError";
  }
}

const DEFAULT_ALIGNMENT_WINDOW = 2;
export const LATENCY_MIN_DELTA_MS = 250;
export const LATENCY_MIN_RATIO = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseNdjsonEvents(content: string): BugEvent[] {
  const trimmed = content.trim();
  if (!trimmed) return [];
  const events: BugEvent[] = [];
  for (const line of trimmed.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.t === "number" &&
        typeof parsed.k === "string" &&
        isRecord(parsed.d)
      ) {
        events.push(parsed as unknown as BugEvent);
      }
    } catch {
      // Ignore partial lines in finalized streams.
    }
  }
  return events;
}

// Session artifacts are read through the SessionStore seam so a storage
// decorator (the hosted cloud's at-rest envelope encryption) can open them.
// stub-behavior.json is a harness-authored file that never goes through the
// seam, so it stays on fs.
async function readEvents(sessionDir: string): Promise<BugEvent[]> {
  const stub = path.join(sessionDir, "stub-behavior.json");
  let coldEvents: BugEvent[] | null = null;
  const withStubBehavior = (events: BugEvent[]): BugEvent[] => {
    if (!fs.existsSync(stub)) return events;
    return [...events, ...readStubBehaviorEvents(stub)];
  };
  const coldRaw = await defaultSessionStore.readArtifact(
    sessionDir,
    "events.ndjson.zst",
  );
  if (coldRaw) {
    if (typeof zlib.zstdDecompressSync !== "function") {
      throw new CompareError(
        "Node.js >= 22.15.0 is required to read events.ndjson.zst",
      );
    }
    coldEvents = await rehydrateSignatureRefs(
      sessionDir,
      parseNdjsonEvents(zlib.zstdDecompressSync(coldRaw).toString("utf8")),
    );
  }
  const plainRaw = await defaultSessionStore.readArtifact(
    sessionDir,
    "events.ndjson",
  );
  if (plainRaw) {
    const plainEvents = parseNdjsonEvents(plainRaw.toString("utf-8"));
    if (!coldEvents || plainEvents.length > coldEvents.length)
      return withStubBehavior(plainEvents);
  }
  if (coldEvents) return withStubBehavior(coldEvents);
  if (fs.existsSync(stub)) return readStubBehaviorEvents(stub);
  throw new CompareError(`no events.ndjson(.zst) found in ${sessionDir}`);
}

async function readSignatureDictionary(
  sessionDir: string,
): Promise<Map<number, Record<string, unknown>>> {
  try {
    const raw = await defaultSessionStore.readArtifact(
      sessionDir,
      "signatures.json",
    );
    if (!raw) return new Map();
    const parsed = JSON.parse(raw.toString("utf-8")) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.entries)) return new Map();
    const byId = new Map<number, Record<string, unknown>>();
    for (const entry of parsed.entries) {
      if (!isRecord(entry) || !Number.isInteger(entry.id)) continue;
      byId.set(Number(entry.id), entry);
    }
    return byId;
  } catch {
    return new Map();
  }
}

async function rehydrateSignatureRefs(
  sessionDir: string,
  events: BugEvent[],
): Promise<BugEvent[]> {
  const signatures = await readSignatureDictionary(sessionDir);
  if (signatures.size === 0) return events;
  return events.map((event) => {
    const d = isRecord(event.d) ? event.d : {};
    const el = isRecord(d.el) ? d.el : undefined;
    const sigRef =
      typeof el?.sigRef === "number"
        ? el.sigRef
        : typeof el?.sigRef === "string"
          ? Number(el.sigRef)
          : NaN;
    if (!Number.isInteger(sigRef)) return event;
    const signature = signatures.get(sigRef);
    if (!signature) return event;
    return {
      ...event,
      d: {
        ...d,
        el: {
          ...el,
          sig:
            typeof signature.sig === "string"
              ? signature.sig
              : `sigRef:${sigRef}`,
          path: typeof signature.path === "string" ? signature.path : undefined,
          tag: typeof signature.tag === "string" ? signature.tag : undefined,
        },
      },
    };
  });
}

function readStubBehaviorEvents(filePath: string): BugEvent[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!isRecord(parsed) || typeof parsed.behaviorHash !== "string") {
    throw new CompareError(
      `invalid stub-behavior.json in ${path.dirname(filePath)}`,
    );
  }
  const steps = Number.isInteger(parsed.steps)
    ? Math.max(1, Math.min(Number(parsed.steps), 20))
    : 3;
  const events: BugEvent[] = [];
  for (let idx = 0; idx < steps; idx += 1) {
    events.push({
      t: 1000 + idx * 100,
      k: "clk",
      d: { el: { sig: `stub-step-${idx}`, txt: `Step ${idx + 1}` } },
    });
  }
  events.push(
    {
      t: 1000 + steps * 100,
      k: "net.req",
      d: {
        id: "stub-req",
        requestId: "stub-req",
        method: "POST",
        url: "/api/stub-behavior",
      },
    },
    {
      t: 1100 + steps * 100,
      k: "net.res",
      d: {
        id: "stub-req",
        requestId: "stub-req",
        st: 200,
        body: { behaviorHash: parsed.behaviorHash },
      },
    },
    {
      t: 1200 + steps * 100,
      k: "db.diff",
      d: {
        table: "orders",
        op: "insert",
        pk: { id: 1 },
        after: { behavior_hash: parsed.behaviorHash },
        requestId: "stub-req",
      },
    },
  );
  return events;
}

async function readSessionId(sessionDir: string): Promise<string> {
  for (const name of ["index.json", "meta.json", "manifest.json"]) {
    try {
      const raw = await defaultSessionStore.readArtifact(sessionDir, name);
      if (!raw) continue;
      const parsed = JSON.parse(raw.toString("utf-8")) as unknown;
      if (!isRecord(parsed)) continue;
      const nested = isRecord(parsed.session) ? parsed.session.id : undefined;
      const id = parsed.id ?? parsed.sessionId ?? nested;
      if (typeof id === "string" && id.trim()) return id;
    } catch {
      // Try the next finalized artifact.
    }
  }
  const stub = path.join(sessionDir, "stub-behavior.json");
  if (fs.existsSync(stub)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(stub, "utf8")) as unknown;
      if (
        isRecord(parsed) &&
        typeof parsed.sessionId === "string" &&
        parsed.sessionId.trim()
      )
        return parsed.sessionId;
    } catch {
      // Fall back to basename.
    }
  }
  return path.basename(sessionDir);
}

async function readSessionMeta(
  sessionDir: string,
): Promise<Record<string, unknown>> {
  try {
    const raw = await defaultSessionStore.readArtifact(sessionDir, "meta.json");
    if (!raw) return {};
    const parsed = JSON.parse(raw.toString("utf-8")) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function eventTime(event: BugEvent): number {
  return Number.isFinite(event.offsetMs)
    ? event.offsetMs!
    : Number.isFinite(event.t)
      ? event.t
      : 0;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(url, "http://crumbtrail.local");
    return parsed.pathname
      .split("/")
      .map((segment) => (/^\d{2,}$/.test(segment) ? "<id>" : segment))
      .join("/");
  } catch {
    return url;
  }
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`,
    )
    .join(",")}}`;
}

function normalizeValue(value: unknown, rules: Set<string>): unknown {
  if (typeof value === "string") {
    return value
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
        () => {
          rules.add("value.uuid");
          return "<uuid>";
        },
      )
      .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?\b/g, () => {
        rules.add("value.timestamp-iso");
        return "<ts>";
      })
      .replace(/\b[0-9a-f]{16,}\b/gi, () => {
        rules.add("value.hex-id");
        return "<hex>";
      });
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (
      (value >= 978307200 && value <= 4102444800) ||
      (value >= 978307200000 && value <= 4102444800000)
    ) {
      rules.add("value.timestamp-epoch");
      return "<ts>";
    }
  }
  if (Array.isArray(value))
    return value.map((item) => normalizeValue(item, rules));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort())
      out[key] = normalizeValue(value[key], rules);
    return out;
  }
  return value;
}

function canonicalize(value: unknown, rules: Set<string>): string {
  return stableStringify(normalizeValue(value, rules));
}

function hasDisabledRule(
  beforeRules: Set<string>,
  afterRules: Set<string>,
  disabled: Set<string>,
): boolean {
  return [...beforeRules, ...afterRules].some((rule) => disabled.has(rule));
}

function addSuppressedRules(
  target: Set<string>,
  beforeRules: Set<string>,
  afterRules: Set<string>,
  disabled: Set<string>,
): void {
  for (const rule of [...beforeRules, ...afterRules]) {
    if (!disabled.has(rule)) target.add(rule);
  }
}

function elementSig(el: unknown): string {
  if (!isRecord(el)) return "";
  return String(
    el.sig ??
      el.testId ??
      el.id ??
      el.name ??
      el.text ??
      el.txt ??
      el.label ??
      el.role ??
      el.path ??
      el.selector ??
      el.tag ??
      "",
  );
}

function elementLabel(el: unknown): string | undefined {
  if (!isRecord(el)) return undefined;
  const label = el.txt ?? el.text ?? el.label ?? el.name ?? el.role ?? el.tag;
  return typeof label === "string" && label ? label : undefined;
}

function extractSteps(events: BugEvent[]): FlowStep[] {
  const steps: FlowStep[] = [];
  for (const event of events) {
    const d = event.d ?? {};
    if (event.k === "clk" || event.k === "inp") {
      const sig = elementSig(d.el) || stableStringify(d.el ?? {});
      steps.push({
        idx: steps.length,
        t: eventTime(event),
        kind: event.k,
        sig,
        label: elementLabel(d.el),
      });
    } else if (event.k === "nav") {
      const to =
        typeof d.to === "string"
          ? d.to
          : typeof d.url === "string"
            ? d.url
            : "";
      steps.push({
        idx: steps.length,
        t: eventTime(event),
        kind: "nav",
        sig: `nav:${normalizeUrl(to)}`,
        label: normalizeUrl(to),
      });
    }
  }
  return steps;
}

function nearestAnchor(steps: FlowStep[], t: number): string | undefined {
  let anchor: FlowStep | undefined;
  for (const step of steps) {
    if (step.t <= t) anchor = step;
    else break;
  }
  return anchor?.sig;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function extractNetwork(events: BugEvent[], steps: FlowStep[]): NetworkCall[] {
  const reqs = new Map<string, BugEvent>();
  const calls: NetworkCall[] = [];
  for (const event of events) {
    const d = event.d ?? {};
    if (event.k === "net.req") {
      reqs.set(
        String(
          d.id ??
            d.requestId ??
            `${d.method ?? d.m}:${d.url}:${eventTime(event)}`,
        ),
        event,
      );
      continue;
    }
    if (event.k !== "net.res") continue;
    const id = String(d.id ?? d.requestId ?? "");
    const req = reqs.get(id);
    const reqD = req?.d ?? {};
    const t = eventTime(req ?? event);
    const hdrs = isRecord(d.hdrs)
      ? Object.fromEntries(
          Object.entries(d.hdrs).map(([key, value]) => [key, String(value)]),
        )
      : undefined;
    calls.push({
      t,
      method: String(reqD.method ?? reqD.m ?? "GET").toUpperCase(),
      route: normalizeUrl(String(reqD.url ?? reqD.path ?? "")),
      status: Number(d.st ?? d.status ?? d.statusCode ?? 0),
      durMs: nonNegativeNumber(d.dur),
      requestId: stringOrUndefined(reqD.requestId ?? d.requestId),
      anchorSig: nearestAnchor(steps, t),
      responseHeaders: hdrs,
      body: d.body ?? d.bodySummary ?? null,
    });
  }
  return calls;
}

const DB_ENGINES = new Set<DbEngine>(["postgres", "mysql", "mssql", "sqlite"]);

/**
 * Normalizes a `db.diff` event's `engine` tag to the {@link DbEngine} union. Missing/unknown values
 * default to `"postgres"` — the only engine that ever emitted `db.diff` before multi-engine support —
 * so legacy engineless writes bucket together with explicit-postgres writes.
 */
function normalizeDbEngine(value: unknown): DbEngine {
  return typeof value === "string" && DB_ENGINES.has(value as DbEngine)
    ? (value as DbEngine)
    : "postgres";
}

function extractDbWrites(
  events: BugEvent[],
  steps: FlowStep[],
): ComparableSession["dbWrites"] {
  return events
    .filter((event) => event.k === "db.diff")
    .map((event) => {
      const d = event.d ?? {};
      const t = eventTime(event);
      return {
        t,
        engine: normalizeDbEngine(d.engine),
        op: (d.op === "update" || d.op === "delete"
          ? d.op
          : "insert") as DbDiffOp,
        table: String(d.table ?? "unknown"),
        pk: isRecord(d.pk) ? d.pk : null,
        before: isRecord(d.before) ? d.before : undefined,
        after: isRecord(d.after) ? d.after : undefined,
        requestId: String(d.requestId ?? ""),
        anchorSig: nearestAnchor(steps, t),
      };
    });
}

function mergeRecord(
  target: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  if (!isRecord(value)) return;
  const current = isRecord(target[key])
    ? (target[key] as Record<string, unknown>)
    : {};
  target[key] = { ...current, ...value };
}

function extractEnvironment(events: BugEvent[]): Record<string, unknown> {
  const environment: Record<string, unknown> = {};
  for (const event of events) {
    if (event.k !== "env") continue;
    const d = event.d ?? {};
    for (const [key, value] of Object.entries(d)) {
      if (key === "kind" || key === "redaction") continue;
      if (key === "flags" || key === "config")
        mergeRecord(environment, key, value);
      else environment[key] = value;
    }
  }
  return environment;
}

function comparableEnvironment(
  environment: Record<string, unknown>,
  release: string | undefined,
  build: string | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isRecord(environment.flags)) out.flags = environment.flags;
  if (isRecord(environment.config)) out.config = environment.config;
  const envRelease = stringOrUndefined(
    environment.release ?? environment.releaseId ?? environment.version,
  );
  const envBuild = stringOrUndefined(
    environment.build ??
      environment.buildId ??
      environment.commit ??
      environment.sha,
  );
  if (release ?? envRelease) out.release = release ?? envRelease;
  if (build ?? envBuild) out.build = build ?? envBuild;
  return out;
}

async function loadComparableSession(
  sessionDir: string,
): Promise<ComparableSession> {
  const events = await readEvents(sessionDir);
  const steps = extractSteps(events);
  const meta = await readSessionMeta(sessionDir);
  const release = stringOrUndefined(
    meta.release ?? meta.releaseId ?? meta.version,
  );
  const build = stringOrUndefined(
    meta.build ?? meta.buildId ?? meta.commit ?? meta.sha,
  );
  const environment = extractEnvironment(events);
  return {
    sessionId: await readSessionId(sessionDir),
    dir: sessionDir,
    events,
    steps,
    network: extractNetwork(events, steps),
    dbWrites: extractDbWrites(events, steps),
    environment: comparableEnvironment(environment, release, build),
    release,
    build,
  };
}

interface AlignmentResult {
  matchedSteps: number;
  unmatchedA: FlowStep[];
  unmatchedB: FlowStep[];
  jitterCount: number;
}

function alignSteps(
  a: FlowStep[],
  b: FlowStep[],
  window: number,
): AlignmentResult {
  const matchedA = new Set<number>();
  const matchedB = new Set<number>();
  let jitterCount = 0;
  for (let i = 0; i < a.length; i += 1) {
    let found = -1;
    for (let delta = 0; delta <= window; delta += 1) {
      for (const j of [i - delta, i + delta]) {
        if (j < 0 || j >= b.length || matchedB.has(j)) continue;
        if (a[i]?.kind === b[j]?.kind && a[i]?.sig === b[j]?.sig) {
          found = j;
          break;
        }
      }
      if (found >= 0) break;
    }
    if (found >= 0) {
      matchedA.add(i);
      matchedB.add(found);
      if (found !== i) jitterCount += 1;
    }
  }
  return {
    matchedSteps: matchedA.size,
    unmatchedA: a.filter((step) => !matchedA.has(step.idx)),
    unmatchedB: b.filter((step) => !matchedB.has(step.idx)),
    jitterCount,
  };
}

function diffFlow(
  alignment: AlignmentResult,
  rules: Set<string>,
): Divergence[] {
  const divergences: Divergence[] = [];
  if (alignment.jitterCount > 0) rules.add("flow.order-jitter");
  for (const step of alignment.unmatchedA) {
    divergences.push({
      plane: "flow",
      kind: "flow.step-missing",
      sig: step.sig,
      before: `${step.kind}:${step.sig}`,
      after: null,
      brief: `flow step present in session A but missing in session B: ${step.kind} ${step.sig}`,
    });
  }
  for (const step of alignment.unmatchedB) {
    divergences.push({
      plane: "flow",
      kind: "flow.step-added",
      sig: step.sig,
      before: null,
      after: `${step.kind}:${step.sig}`,
      brief: `flow step present in session B but missing in session A: ${step.kind} ${step.sig}`,
    });
  }
  return divergences;
}

function networkKey(call: NetworkCall): string {
  return `${call.anchorSig ?? "unanchored"}:${call.method}:${call.route}`;
}

export function latencyVerdict(
  before: NetworkCall,
  after: NetworkCall,
): "regression" | "jitter" | "none" {
  if (before.durMs === undefined || after.durMs === undefined) return "none";
  if (
    !Number.isFinite(before.durMs) ||
    !Number.isFinite(after.durMs) ||
    before.durMs < 0 ||
    after.durMs < 0
  ) {
    return "none";
  }
  if (after.durMs <= before.durMs) return "none";
  const delta = after.durMs - before.durMs;
  const ratio =
    before.durMs === 0 ? Number.POSITIVE_INFINITY : after.durMs / before.durMs;
  if (delta >= LATENCY_MIN_DELTA_MS && ratio >= LATENCY_MIN_RATIO)
    return "regression";
  return "jitter";
}

function diffNetwork(
  a: NetworkCall[],
  b: NetworkCall[],
  rules: Set<string>,
  disabled: Set<string>,
): Divergence[] {
  const buckets = new Map<string, NetworkCall[]>();
  for (const call of b)
    buckets.set(networkKey(call), [
      ...(buckets.get(networkKey(call)) ?? []),
      call,
    ]);
  const divergences: Divergence[] = [];
  for (const before of a) {
    const bucket = buckets.get(networkKey(before)) ?? [];
    const after = bucket.shift();
    if (!after) {
      if (isRedactedCallPresenceNoise(before, disabled)) {
        rules.add("network.redacted-call-presence");
        continue;
      }
      divergences.push({
        plane: "network",
        kind: "net.call-missing",
        sig: before.anchorSig,
        requestId: before.requestId,
        before,
        after: null,
        brief: `network call present in session A but missing in session B: ${before.method} ${before.route}`,
      });
      continue;
    }
    if (before.status !== after.status) {
      divergences.push({
        plane: "network",
        kind: "net.status",
        sig: after.anchorSig ?? before.anchorSig,
        requestId: after.requestId ?? before.requestId,
        before: before.status,
        after: after.status,
        brief: `network status changed for ${before.method} ${before.route}: ${before.status} -> ${after.status}`,
      });
    }
    const latency = latencyVerdict(before, after);
    if (latency === "regression") {
      divergences.push({
        plane: "network",
        kind: "net.latency",
        sig: after.anchorSig ?? before.anchorSig,
        requestId: after.requestId ?? before.requestId,
        before: before.durMs,
        after: after.durMs,
        brief: `network latency regressed for ${before.method} ${before.route}: ${before.durMs} ms -> ${after.durMs} ms`,
      });
    } else if (latency === "jitter") {
      rules.add("network.latency-jitter");
    }
    const beforeRules = new Set<string>();
    const afterRules = new Set<string>();
    const beforeBody = canonicalize(before.body, beforeRules);
    const afterBody = canonicalize(after.body, afterRules);
    const rawBodiesDiffer =
      stableStringify(before.body) !== stableStringify(after.body);
    if (
      beforeBody !== afterBody ||
      (rawBodiesDiffer && hasDisabledRule(beforeRules, afterRules, disabled))
    ) {
      divergences.push({
        plane: "network",
        kind: "net.body",
        sig: after.anchorSig ?? before.anchorSig,
        requestId: after.requestId ?? before.requestId,
        before: before.body,
        after: after.body,
        brief: `network body changed for ${before.method} ${before.route}`,
      });
    } else if (rawBodiesDiffer) {
      addSuppressedRules(rules, beforeRules, afterRules, disabled);
    }
  }
  for (const bucket of buckets.values()) {
    for (const after of bucket) {
      if (isRedactedCallPresenceNoise(after, disabled)) {
        rules.add("network.redacted-call-presence");
        continue;
      }
      divergences.push({
        plane: "network",
        kind: "net.call-added",
        sig: after.anchorSig,
        requestId: after.requestId,
        before: null,
        after,
        brief: `network call present in session B but missing in session A: ${after.method} ${after.route}`,
      });
    }
  }
  return divergences;
}

function isRedactedCallPresenceNoise(
  call: NetworkCall,
  disabled: Set<string>,
): boolean {
  if (disabled.has("network.redacted-call-presence")) return false;
  return (
    call.body === "[REDACTED]" ||
    (isRecord(call.body) && call.body.action === "redacted")
  );
}

function dbKey(write: ComparableSession["dbWrites"][number]): string {
  return `${write.anchorSig ?? "unanchored"}:${write.engine}:${write.table}:${write.op}`;
}

function pkColumnNames(
  ...pks: Array<Record<string, unknown> | null | undefined>
): Set<string> {
  const columns = new Set<string>();
  for (const pk of pks) {
    if (!isRecord(pk)) continue;
    for (const key of Object.keys(pk)) columns.add(key);
  }
  return columns;
}

function omitColumns(value: unknown, columns: Set<string>): unknown {
  if (!isRecord(value) || columns.size === 0) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!columns.has(key)) out[key] = item;
  }
  return out;
}

function diffDb(
  a: ComparableSession["dbWrites"],
  b: ComparableSession["dbWrites"],
  rules: Set<string>,
  disabled: Set<string>,
): Divergence[] {
  const buckets = new Map<string, ComparableSession["dbWrites"]>();
  for (const write of b)
    buckets.set(dbKey(write), [...(buckets.get(dbKey(write)) ?? []), write]);
  const divergences: Divergence[] = [];
  for (const before of a) {
    const bucket = buckets.get(dbKey(before)) ?? [];
    const after = bucket.shift();
    if (!after) {
      divergences.push({
        plane: "db",
        kind: "db.write-missing",
        sig: before.anchorSig,
        requestId: before.requestId,
        table: before.table,
        pk: before.pk ?? undefined,
        before: before.after ?? before.before ?? null,
        after: null,
        brief: `database write present in session A but missing in session B: ${before.table}`,
      });
      continue;
    }
    const beforeRules = new Set<string>();
    const afterRules = new Set<string>();
    const pkColumns = pkColumnNames(before.pk, after.pk);
    const beforeValue = omitColumns(
      before.after ?? before.before ?? null,
      pkColumns,
    );
    const afterValue = omitColumns(
      after.after ?? after.before ?? null,
      pkColumns,
    );
    const normalizedBefore = canonicalize(beforeValue, beforeRules);
    const normalizedAfter = canonicalize(afterValue, afterRules);
    const rawValuesDiffer =
      stableStringify(beforeValue) !== stableStringify(afterValue);
    if (
      normalizedBefore !== normalizedAfter ||
      (rawValuesDiffer && hasDisabledRule(beforeRules, afterRules, disabled))
    ) {
      divergences.push({
        plane: "db",
        kind: "db.row-value",
        sig: after.anchorSig ?? before.anchorSig,
        requestId: after.requestId || before.requestId,
        table: before.table,
        pk: before.pk ?? undefined,
        before: beforeValue,
        after: afterValue,
        brief: `database row value changed for ${before.table} ${stableStringify(before.pk ?? {})}`,
      });
    } else if (rawValuesDiffer) {
      addSuppressedRules(rules, beforeRules, afterRules, disabled);
    }
  }
  for (const bucket of buckets.values()) {
    for (const after of bucket) {
      divergences.push({
        plane: "db",
        kind: "db.write-added",
        sig: after.anchorSig,
        requestId: after.requestId,
        table: after.table,
        pk: after.pk ?? undefined,
        before: null,
        after: after.after ?? after.before ?? null,
        brief: `database write present in session B but missing in session A: ${after.table}`,
      });
    }
  }
  return divergences;
}

function diffEnvironment(
  a: ComparableSession["environment"],
  b: ComparableSession["environment"],
  rules: Set<string>,
  disabled: Set<string>,
): Divergence[] {
  const beforeRules = new Set<string>();
  const afterRules = new Set<string>();
  const before = canonicalize(a, beforeRules);
  const after = canonicalize(b, afterRules);
  const rawValuesDiffer = stableStringify(a) !== stableStringify(b);
  const disabledNoiseExposesDiff =
    rawValuesDiffer && hasDisabledRule(beforeRules, afterRules, disabled);
  if (before === after && !disabledNoiseExposesDiff) {
    if (rawValuesDiffer)
      addSuppressedRules(rules, beforeRules, afterRules, disabled);
    return [];
  }
  const envDelta = buildEnvDiff(a, b, disabled);
  return [
    {
      plane: "env",
      kind: "env.snapshot",
      before: a,
      after: b,
      brief: envBrief(envDelta),
      envDelta,
    },
  ];
}

/**
 * Builds the structured added/removed/changed delta of the declared env between
 * two comparable sessions. `changed`-ness is decided with the same noise model
 * used by the divergence channel, so timestamp/uuid churn stays suppressed
 * unless the caller disabled the rule.
 */
function buildEnvDiff(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  disabled: Set<string>,
): EnvDiff {
  const delta: EnvDiff = {
    flags: channelDelta(recordField(a.flags), recordField(b.flags), disabled),
    config: channelDelta(
      recordField(a.config),
      recordField(b.config),
      disabled,
    ),
  };
  const releaseBefore = stringOrUndefined(a.release);
  const releaseAfter = stringOrUndefined(b.release);
  if (releaseBefore !== releaseAfter) {
    delta.release = {
      ...(releaseBefore !== undefined ? { before: releaseBefore } : {}),
      ...(releaseAfter !== undefined ? { after: releaseAfter } : {}),
    };
  }
  const buildBefore = stringOrUndefined(a.build);
  const buildAfter = stringOrUndefined(b.build);
  if (buildBefore !== buildAfter) {
    delta.build = {
      ...(buildBefore !== undefined ? { before: buildBefore } : {}),
      ...(buildAfter !== undefined ? { after: buildAfter } : {}),
    };
  }
  return delta;
}

function recordField(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function channelDelta(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  disabled: Set<string>,
): EnvChannelDelta {
  const added: EnvValueChange[] = [];
  const removed: EnvValueChange[] = [];
  const changed: EnvValueChange[] = [];
  for (const key of Object.keys(a).sort()) {
    if (!(key in b)) {
      removed.push({ key, before: a[key] });
    } else if (envValuesDiffer(a[key], b[key], disabled)) {
      changed.push({ key, before: a[key], after: b[key] });
    }
  }
  for (const key of Object.keys(b).sort()) {
    if (!(key in a)) added.push({ key, after: b[key] });
  }
  return { added, removed, changed };
}

/**
 * True when two env values are meaningfully different — i.e. their canonical
 * (noise-normalized) forms differ, or they differ only by a normalization the
 * caller explicitly disabled. Mirrors the network/db body gating.
 */
function envValuesDiffer(
  before: unknown,
  after: unknown,
  disabled: Set<string>,
): boolean {
  const beforeRules = new Set<string>();
  const afterRules = new Set<string>();
  if (canonicalize(before, beforeRules) !== canonicalize(after, afterRules))
    return true;
  const rawDiffers = stableStringify(before) !== stableStringify(after);
  return rawDiffers && hasDisabledRule(beforeRules, afterRules, disabled);
}

function envBrief(delta: EnvDiff): string {
  const counts =
    delta.flags.added.length +
    delta.flags.removed.length +
    delta.flags.changed.length +
    delta.config.added.length +
    delta.config.removed.length +
    delta.config.changed.length +
    (delta.release ? 1 : 0) +
    (delta.build ? 1 : 0);
  const parts: string[] = [];
  const flagCount =
    delta.flags.added.length +
    delta.flags.removed.length +
    delta.flags.changed.length;
  const configCount =
    delta.config.added.length +
    delta.config.removed.length +
    delta.config.changed.length;
  if (flagCount > 0) parts.push(`${flagCount} flag(s)`);
  if (configCount > 0) parts.push(`${configCount} config value(s)`);
  if (delta.release) parts.push("release");
  if (delta.build) parts.push("build");
  if (counts === 0 || parts.length === 0)
    return "feature flag, config, release, or build snapshot changed between sessions";
  return `environment delta between sessions: ${parts.join(", ")} changed`;
}

function confidenceFor(divergences: Divergence[]): ComparisonConfidence {
  if (divergences.length === 0) return "high";
  if (
    divergences.some(
      (divergence) =>
        divergence.plane === "db" ||
        divergence.plane === "flow" ||
        divergence.plane === "env",
    )
  )
    return "high";
  if (divergences.some((divergence) => divergence.kind === "net.status"))
    return "medium";
  return "low";
}

export async function compareSessions(
  aDir: string,
  bDir: string,
  options: CompareOptions = {},
): Promise<SessionComparison> {
  const a = await loadComparableSession(aDir);
  const b = await loadComparableSession(bDir);
  const rules = new Set<string>();
  const disabled = new Set(options.disableNoiseRules ?? []);
  const alignment = alignSteps(
    a.steps,
    b.steps,
    options.alignmentWindow ?? DEFAULT_ALIGNMENT_WINDOW,
  );
  const divergences = [
    ...diffFlow(alignment, rules),
    ...diffNetwork(a.network, b.network, rules, disabled),
    ...diffDb(a.dbWrites, b.dbWrites, rules, disabled),
    ...diffEnvironment(a.environment, b.environment, rules, disabled),
  ];
  const envDelta = divergences.find(
    (divergence) => divergence.kind === "env.snapshot",
  )?.envDelta;
  return {
    schemaVersion: SESSION_COMPARE_SCHEMA_VERSION,
    verdict: divergences.length > 0 ? "regression" : "clean",
    confidence: confidenceFor(divergences),
    a: {
      sessionId: a.sessionId,
      ...(a.release ? { release: a.release } : {}),
      ...(a.build ? { build: a.build } : {}),
    },
    b: {
      sessionId: b.sessionId,
      ...(b.release ? { release: b.release } : {}),
      ...(b.build ? { build: b.build } : {}),
    },
    alignment: {
      matchedSteps: alignment.matchedSteps,
      unmatchedA: alignment.unmatchedA.length,
      unmatchedB: alignment.unmatchedB.length,
    },
    divergences,
    noise: { suppressedCount: rules.size, rules: [...rules].sort() },
    evidence: divergencesToEvidence(divergences),
    intent: [],
    ...(envDelta ? { envDelta } : {}),
  };
}

export { SESSION_COMPARE_SCHEMA_VERSION } from "./types";
export type {
  CompareOptions,
  ComparisonConfidence,
  ComparisonVerdict,
  Divergence,
  EnvChannelDelta,
  EnvDiff,
  EnvValueChange,
  SessionComparison,
} from "./types";
