import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import { redactTokenLikeString, redactUrl } from "crumbtrail-core";
import {
  summarizeRedaction,
  writeLlmBundle,
  type LlmBundleRedactionSummary,
} from "./llm-bundle";
import { writeEvidenceIndex } from "./evidence-index";
import {
  readCaptureTruncationMarker,
  type CaptureTruncationSummary,
  writeColdEvidenceArtifacts,
  writeTwoPlaneSessionArtifacts,
} from "./storage-plane";
import { buildCausalGraph, type CausalGraph } from "./causal-graph";
import { defaultSessionStore } from "./session-store";

interface BugEvent {
  t: number;
  k: string;
  d: Record<string, unknown>;
  sessionId?: string;
  offsetMs?: number;
}

interface StorageSummary {
  localStorageKeys: number;
  sessionStorageKeys: number;
  cookies: number;
  idbDatabases?: number;
  cacheNames?: number;
}

interface BoundaryLocationIndexSummary {
  valid?: boolean;
  restricted?: boolean;
  opaque?: boolean;
  scheme?: string;
  origin?: string;
  host?: string;
  isLocalhost?: boolean;
}

interface TabBoundaryIndexSummary {
  total: number;
  decisionCounts: Record<string, number>;
  nonCaptureCount: number;
}

interface TabBoundaryIndexEntry {
  t: number;
  offsetMs?: number;
  signal?: string;
  decision?: string;
  reason?: string;
  capture?: boolean;
  nonCapture?: boolean;
  tabId?: number;
  previousCapturedOrigin?: string;
  root?: BoundaryLocationIndexSummary;
  current?: BoundaryLocationIndexSummary;
  candidate?: BoundaryLocationIndexSummary;
  prompt?: {
    origin?: string;
    outcome?: string;
    requestedAt?: number;
  };
}

interface ConsoleErrorIndexEntry {
  t: number;
  offsetMs?: number;
  lv: string;
  msg: string;
  source?: string;
}

interface NetworkErrorIndexEntry {
  t: number;
  offsetMs?: number;
  m?: string;
  method?: string;
  url?: string;
  msg?: string;
  transport?: string;
}

type FullStackGapKind =
  | "frontend-only"
  | "backend-only"
  | "backend-generated-request-id"
  | "backend-missing-session"
  | "backend-missing-request-id"
  | "backend-missing-session-and-request-id"
  | "client-missing-request-id";

interface FullStackEventRef {
  t: number;
  offsetMs?: number;
  k: string;
}

interface FrontendRequestEvidence {
  ref: FullStackEventRef;
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

interface BackendRequestEvidence {
  requestId?: string;
  sessionId?: string;
  correlation?: {
    status?: string;
    sessionIdSource?: string;
    requestIdSource?: string;
  };
  start?: FullStackEventRef;
  end?: FullStackEventRef;
  errorRef?: FullStackEventRef;
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

interface LinkedFullStackRequestMoment {
  requestId: string;
  sessionId: string;
  frontend: FrontendRequestEvidence;
  backend: BackendRequestEvidence;
}

interface FullStackRequestGapEntry {
  type: FullStackGapKind;
  requestId?: string;
  sessionId?: string;
  frontend?: FrontendRequestEvidence;
  backend?: BackendRequestEvidence;
}

interface FullStackRequestsIndexSection {
  schemaVersion: 1;
  summary: {
    frontendRequests: number;
    backendRequests: number;
    linked: number;
    gaps: number;
    gapTypes: Record<FullStackGapKind, number>;
  };
  linked: LinkedFullStackRequestMoment[];
  gaps: FullStackRequestGapEntry[];
}

interface PageProbeIndexError {
  t: number;
  offsetMs?: number;
  phase?: string;
  message?: string;
  source?: string;
}

interface PageProbeIndexSummary {
  requested: boolean;
  readyEvents: number;
  errorEvents: number;
  frameContexts: number;
  startedContexts: number;
  limitedContexts: number;
  features: Record<string, boolean>;
  errors: PageProbeIndexError[];
  limitations: string[];
}

export type AudioTranscriptionState =
  | "not-requested"
  | "transcription-ready"
  | "transcription-unavailable"
  | "transcription-error";

export interface PostProcessAudioSummary {
  artifact: "audio.webm";
  bytes: number;
  upload?: {
    metadataFile: "audio.json";
    uploadedAt?: number;
    contentType?: string;
    mimeType?: string;
    durationMs?: number;
    chunkCount?: number;
    transcriptionRequested?: boolean;
  };
  transcription: {
    state: AudioTranscriptionState;
    code?: "transcription_unavailable" | "transcription_failed";
    message?: string;
    transcriptFile?: "transcript.json";
    eventCount?: number;
  };
}

interface SessionIndex {
  id: string;
  start: number;
  end: number;
  dur: number;
  evts: number;
  errs: Array<{ t: number; msg: string; method?: string; url?: string }>;
  failedReqs: Array<{
    t: number;
    m: string;
    url: string;
    st: number;
    reason?: string;
    code?: string;
    message?: string;
    phase?: string;
  }>;
  networkErrors?: NetworkErrorIndexEntry[];
  consoleErrors?: ConsoleErrorIndexEntry[];
  navs: Array<{ t: number; to: string }>;
  stats: Record<string, number>;
  tabBoundaries?: TabBoundaryIndexEntry[];
  tabBoundarySummary?: TabBoundaryIndexSummary;
  pageProbe?: PageProbeIndexSummary;
  storageSummary?: StorageSummary;
  redaction: LlmBundleRedactionSummary;
  audio?: PostProcessAudioSummary;
  fullStackRequests?: FullStackRequestsIndexSection;
  causalGraph?: CausalGraph;
  truncated?: CaptureTruncationSummary;
}

interface AudioProcessResult {
  events: BugEvent[];
  audio?: PostProcessAudioSummary;
}

export async function postProcess(
  sessionDir: string,
  whisperModel?: string,
): Promise<void> {
  const eventsPath = path.join(sessionDir, "events.ndjson");
  const events = fs.existsSync(eventsPath) ? await readEvents(eventsPath) : [];
  const truncation = readCaptureTruncationMarker(sessionDir);

  // Process audio transcription if audio.webm exists. Audio failures are non-fatal and
  // are exposed through index.audio instead of throwing away usable artifacts.
  const audioResult = await processAudio(sessionDir, events, whisperModel);
  const mergedEvents = audioResult.events;

  if (mergedEvents.length === 0) {
    const index = writeEmptyIndex(sessionDir, audioResult.audio, truncation);
    const candidates = writeEvidenceIndex({
      sessionDir,
      events: mergedEvents,
      index,
      causalGraph: undefined,
    });
    const coldEvidence = writeColdEvidenceArtifacts({
      sessionDir,
      events: mergedEvents,
    });
    const bundle = writeLlmBundle({
      sessionDir,
      events: mergedEvents,
      index,
      candidates,
    });
    writeTwoPlaneSessionArtifacts({
      sessionDir,
      events: mergedEvents,
      index,
      candidates,
      bundle,
      coldEvidence,
    });
    return;
  }

  const errs: SessionIndex["errs"] = [];
  const failedReqs: SessionIndex["failedReqs"] = [];
  const recentNetErrs: Array<{ t: number; m: string; url: string }> = [];
  const networkErrors: NetworkErrorIndexEntry[] = [];
  const consoleErrors: ConsoleErrorIndexEntry[] = [];
  const navs: SessionIndex["navs"] = [];
  const stats: Record<string, number> = {};
  const netReqs = new Map<string, { m: string; url: string }>();
  const tabBoundaries: TabBoundaryIndexEntry[] = [];
  const pageProbe = createPageProbeSummary();
  let storageSummary: StorageSummary | undefined;

  for (const event of mergedEvents) {
    stats[event.k] = (stats[event.k] || 0) + 1;
    updatePageProbeSummary(pageProbe, event);

    const consoleError = summarizeConsoleErrorEvent(event);
    if (consoleError) consoleErrors.push(consoleError);

    if (event.k === "tab.boundary") {
      const boundary = summarizeTabBoundaryEvent(event);
      if (boundary) tabBoundaries.push(boundary);
    }

    if (event.k === "err" || event.k === "rej") {
      const msg = safeDiagnosticString(event.d.msg) ?? "";
      const entry: SessionIndex["errs"][number] = { t: event.t, msg };
      // A fetch network failure surfaces twice: as a net.err and, when uncaught,
      // as a rejection moments later. Attach the request identity to the error
      // entry so the failing URL is visible from the error itself.
      const linked = isNetworkFailureMessage(msg)
        ? findRecentNetworkFailure(recentNetErrs, event.t)
        : undefined;
      if (linked?.m) entry.method = linked.m;
      if (linked?.url) entry.url = linked.url;
      errs.push(entry);
    }

    if (event.k === "net.req") {
      netReqs.set(String(event.d.id), {
        m: String(event.d.m || event.d.method || ""),
        url: safeUrl(event.d.url) ?? "",
      });
    }

    if (event.k === "net.res" && isFailedNetworkResponse(event)) {
      const req = netReqs.get(String(event.d.id));
      const applicationFailure = summarizeApplicationFailure(event);
      failedReqs.push({
        t: event.t,
        m: req?.m || "",
        url: req?.url || "",
        st: typeof event.d.st === "number" ? event.d.st : 0,
        ...(applicationFailure ?? { reason: "http_status" }),
      });
    }

    if (event.k === "net.err") {
      const networkError = summarizeNetworkErrorEvent(event);
      if (networkError) networkErrors.push(networkError);

      // SDK-observed network failures count as failed requests (st 0, no HTTP
      // response). Aborts are routine cancellations and page-probe events are
      // page-world-untrusted corroboration, so neither counts.
      if (isCountableNetworkFailure(event)) {
        const req = netReqs.get(String(event.d.id));
        const method =
          safeString(event.d.method) ?? safeString(event.d.m) ?? req?.m ?? "";
        const url = safeUrl(event.d.url) ?? req?.url ?? "";
        const message = safeDiagnosticString(event.d.msg);
        failedReqs.push({
          t: event.t,
          m: method,
          url,
          st: 0,
          reason: "network_error",
          ...(message !== undefined ? { message } : {}),
        });
        recentNetErrs.push({ t: event.t, m: method, url });
        if (recentNetErrs.length > RECENT_NETWORK_FAILURES_MAX)
          recentNetErrs.shift();
      }
    }

    if (isNavigationEvent(event)) {
      navs.push({
        t: event.t,
        to: safeUrl(event.d.to) ?? safeDiagnosticString(event.d.to) ?? "",
      });
    }

    if (event.k === "snap" && storageSummary === undefined) {
      const d = event.d as Record<string, unknown>;
      const ls = d.localStorage as Record<string, string> | undefined;
      const ss = d.sessionStorage as Record<string, string> | undefined;
      const cookies = d.cookies as Record<string, string> | undefined;
      const idb = d.idb as unknown[] | undefined;
      const cacheApi = d.cacheApi as unknown[] | undefined;
      storageSummary = {
        localStorageKeys: ls ? Object.keys(ls).length : 0,
        sessionStorageKeys: ss ? Object.keys(ss).length : 0,
        cookies: cookies ? Object.keys(cookies).length : 0,
        ...(idb !== undefined ? { idbDatabases: idb.length } : {}),
        ...(cacheApi !== undefined ? { cacheNames: cacheApi.length } : {}),
      };
    }
  }

  const fullStackRequests = buildFullStackRequestsIndex(mergedEvents);
  const causalGraph = buildCausalGraph({ events: mergedEvents });
  const redaction = summarizeRedaction(mergedEvents);
  const pageProbeSummary = finalizePageProbeSummary(pageProbe);

  const start = mergedEvents[0].t;
  const end = mergedEvents[mergedEvents.length - 1].t;

  const index: SessionIndex = {
    id: path.basename(sessionDir),
    start,
    end,
    dur: end - start,
    evts: mergedEvents.length,
    errs,
    failedReqs,
    ...(networkErrors.length > 0 ? { networkErrors } : {}),
    ...(consoleErrors.length > 0 ? { consoleErrors } : {}),
    navs,
    stats,
    ...(tabBoundaries.length > 0
      ? {
          tabBoundaries,
          tabBoundarySummary: summarizeTabBoundaryEntries(tabBoundaries),
        }
      : {}),
    ...(pageProbeSummary !== undefined ? { pageProbe: pageProbeSummary } : {}),
    ...(storageSummary !== undefined ? { storageSummary } : {}),
    redaction,
    ...(audioResult.audio !== undefined ? { audio: audioResult.audio } : {}),
    ...(fullStackRequests !== undefined ? { fullStackRequests } : {}),
    causalGraph,
    ...(truncation !== undefined ? { truncated: truncation } : {}),
  };

  fs.writeFileSync(path.join(sessionDir, "index.json"), JSON.stringify(index));
  const candidates = writeEvidenceIndex({
    sessionDir,
    events: mergedEvents,
    index,
    causalGraph,
  });
  const coldEvidence = writeColdEvidenceArtifacts({
    sessionDir,
    events: mergedEvents,
  });
  const bundle = writeLlmBundle({
    sessionDir,
    events: mergedEvents,
    index,
    candidates,
  });
  writeTwoPlaneSessionArtifacts({
    sessionDir,
    events: mergedEvents,
    index,
    candidates,
    bundle,
    coldEvidence,
  });
}

function isNavigationEvent(event: BugEvent): boolean {
  return event.k === "nav" || event.k === "navigation";
}

async function readEvents(eventsPath: string): Promise<BugEvent[]> {
  const events: BugEvent[] = [];
  const fileStream = fs.createReadStream(eventsPath, "utf-8");
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (line.trim()) {
      try {
        events.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
  }

  return events;
}

function createPageProbeSummary(): PageProbeIndexSummary {
  return {
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
}

function updatePageProbeSummary(
  summary: PageProbeIndexSummary,
  event: BugEvent,
): void {
  if (event.k === "probe.ready") {
    summary.requested = true;
    summary.readyEvents += 1;
    copyBooleanFeatures(summary.features, event.d.features);
    return;
  }

  if (event.k === "probe.error") {
    summary.requested = true;
    summary.errorEvents += 1;
    summary.errors.push(
      removeUndefined({
        t: event.t,
        offsetMs:
          nonNegativeNumber(event.offsetMs) ??
          nonNegativeNumber(event.d.offsetMs),
        phase: safeString(event.d.phase),
        message: safeDiagnosticString(event.d.message),
        source: safeString(event.d.source),
      }),
    );
    return;
  }

  if (event.k !== "frame.ctx") return;

  summary.frameContexts += 1;
  const pageProbe = isRecord(event.d.pageProbe) ? event.d.pageProbe : undefined;
  if (!pageProbe) return;

  if (pageProbe.requested === true) summary.requested = true;
  if (pageProbe.started === true) summary.startedContexts += 1;
  if (pageProbe.limited === true) {
    summary.limitedContexts += 1;
    const reason = safeString(pageProbe.reason);
    summary.limitations.push(
      reason
        ? `Page probe was limited: ${reason}.`
        : "Page probe was limited for at least one frame.",
    );
  }
}

function finalizePageProbeSummary(
  summary: PageProbeIndexSummary,
): PageProbeIndexSummary | undefined {
  const hasEvidence =
    summary.requested ||
    summary.readyEvents > 0 ||
    summary.errorEvents > 0 ||
    summary.frameContexts > 0;
  if (!hasEvidence) return undefined;

  const limitations = [...summary.limitations];
  if (summary.requested && summary.readyEvents === 0) {
    limitations.push(
      "Page probe was requested but no probe.ready event was captured.",
    );
  }
  if (summary.errorEvents > 0) {
    limitations.push(
      `${summary.errorEvents} page probe error event(s) were captured.`,
    );
  }

  return {
    ...summary,
    features: Object.fromEntries(
      Object.entries(summary.features).sort(([a], [b]) => a.localeCompare(b)),
    ),
    errors: summary.errors.slice(0, 20),
    limitations: Array.from(new Set(limitations)),
  };
}

function copyBooleanFeatures(
  target: Record<string, boolean>,
  value: unknown,
): void {
  if (!isRecord(value)) return;
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = safeString(rawKey);
    if (key && typeof rawValue === "boolean") target[key] = rawValue;
  }
}

function summarizeConsoleErrorEvent(
  event: BugEvent,
): ConsoleErrorIndexEntry | undefined {
  if (event.k !== "con") return undefined;
  const level = consoleLevel(event.d.lv);
  if (level !== "err") return undefined;
  const message = consoleMessage(event.d);
  if (!message) return undefined;

  return removeUndefined({
    t: event.t,
    offsetMs:
      nonNegativeNumber(event.offsetMs) ?? nonNegativeNumber(event.d.offsetMs),
    lv: level,
    msg: message,
    source: safeString(event.d.source),
  });
}

function consoleLevel(value: unknown): string | undefined {
  const level = safeString(value)?.toLowerCase();
  if (!level) return undefined;
  return level === "error" ? "err" : level;
}

function consoleMessage(data: Record<string, unknown>): string | undefined {
  const msg = safeDiagnosticString(data.msg);
  if (msg) return msg;
  if (!Array.isArray(data.args)) return undefined;
  const text = data.args
    .slice(0, 6)
    .map((entry) => (typeof entry === "string" ? entry : JSON.stringify(entry)))
    .filter(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim().length > 0,
    )
    .join(" ");
  return safeDiagnosticString(text);
}

/** How far back a rejection can look to claim a network failure as its cause. */
const NETWORK_FAILURE_REJ_WINDOW_MS = 2000;
const RECENT_NETWORK_FAILURES_MAX = 20;

/** Browser/runtime phrasings of a fetch/XHR network-level failure. */
const NETWORK_FAILURE_MESSAGE = /failed to fetch|networkerror|network error|load failed|network request failed|fetch failed/i;

function isNetworkFailureMessage(msg: string): boolean {
  return NETWORK_FAILURE_MESSAGE.test(msg);
}

function findRecentNetworkFailure(
  recent: Array<{ t: number; m: string; url: string }>,
  at: number,
): { t: number; m: string; url: string } | undefined {
  for (let i = recent.length - 1; i >= 0; i--) {
    const candidate = recent[i];
    if (candidate.t > at) continue;
    if (at - candidate.t > NETWORK_FAILURE_REJ_WINDOW_MS) return undefined;
    return candidate;
  }
  return undefined;
}

/** Aborts are routine cancellations; page-probe events are page-world-untrusted. */
function isCountableNetworkFailure(event: BugEvent): boolean {
  return (
    event.k === "net.err" &&
    event.d.name !== "AbortError" &&
    event.d.source !== "page-probe" &&
    event.d.evidenceTrust !== "page-world-untrusted"
  );
}

function summarizeNetworkErrorEvent(
  event: BugEvent,
): NetworkErrorIndexEntry | undefined {
  if (event.k !== "net.err") return undefined;
  return removeUndefined({
    t: event.t,
    offsetMs:
      nonNegativeNumber(event.offsetMs) ?? nonNegativeNumber(event.d.offsetMs),
    m: safeString(event.d.m),
    method: safeString(event.d.method),
    url: safeUrl(event.d.url),
    msg: safeDiagnosticString(event.d.msg),
    transport: safeString(event.d.transport),
  });
}

function summarizeTabBoundaryEvent(
  event: BugEvent,
): TabBoundaryIndexEntry | undefined {
  const d = event.d;
  if (!isRecord(d)) return undefined;

  const decision = safeBoundaryLabel(d.decision);
  const reason = safeBoundaryLabel(d.reason);
  const candidate = summarizeBoundaryLocation(d.candidate);
  const current = summarizeBoundaryLocation(d.current);
  const root = summarizeBoundaryLocation(d.root);
  const prompt = summarizeBoundaryPrompt(d.prompt);
  const previousCapturedOrigin =
    safeOrigin(d.previousCapturedOrigin) ?? current?.origin ?? root?.origin;
  const capture =
    typeof d.capture === "boolean"
      ? d.capture
      : decision === "follow"
        ? true
        : undefined;
  const nonCapture =
    typeof d.nonCapture === "boolean"
      ? d.nonCapture
      : decision && decision !== "follow"
        ? true
        : undefined;
  const entry = removeUndefined({
    t: event.t,
    offsetMs:
      nonNegativeNumber(event.offsetMs) ?? nonNegativeNumber(d.offsetMs),
    signal: safeBoundaryLabel(d.signal),
    decision,
    reason,
    capture,
    nonCapture,
    tabId: safeBoundaryTabId(d, decision, capture),
    previousCapturedOrigin,
    root,
    current,
    candidate,
    prompt,
  });

  return Object.keys(entry).length > 1 ? entry : undefined;
}

function summarizeTabBoundaryEntries(
  entries: TabBoundaryIndexEntry[],
): TabBoundaryIndexSummary {
  const decisionCounts: Record<string, number> = {};
  let nonCaptureCount = 0;
  for (const entry of entries) {
    const decision = entry.decision ?? "unknown";
    decisionCounts[decision] = (decisionCounts[decision] ?? 0) + 1;
    if (
      entry.nonCapture === true ||
      entry.capture === false ||
      (entry.decision !== undefined && entry.decision !== "follow")
    ) {
      nonCaptureCount += 1;
    }
  }
  return {
    total: entries.length,
    decisionCounts: Object.fromEntries(
      Object.entries(decisionCounts).sort(([a], [b]) => a.localeCompare(b)),
    ),
    nonCaptureCount,
  };
}

function summarizeBoundaryLocation(
  value: unknown,
): BoundaryLocationIndexSummary | undefined {
  if (!isRecord(value)) return undefined;

  const origin =
    safeOrigin(value.origin) ?? safeOrigin(value.url) ?? safeOrigin(value.href);
  const host = origin ? undefined : safeHost(value.host);
  const scheme =
    safeScheme(value.scheme) ??
    (origin
      ? schemeFromOrigin(origin)
      : safeSchemeFromUrl(value.url ?? value.href));
  const summary = removeUndefined({
    valid: typeof value.valid === "boolean" ? value.valid : undefined,
    restricted:
      typeof value.restricted === "boolean" ? value.restricted : undefined,
    opaque: typeof value.opaque === "boolean" ? value.opaque : undefined,
    scheme,
    origin,
    host,
    isLocalhost:
      typeof value.isLocalhost === "boolean" ? value.isLocalhost : undefined,
  });

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function summarizeBoundaryPrompt(
  value: unknown,
): TabBoundaryIndexEntry["prompt"] | undefined {
  if (!isRecord(value)) return undefined;

  const prompt = removeUndefined({
    origin: safeOrigin(value.origin) ?? safeOrigin(value.url),
    outcome: safeBoundaryLabel(value.outcome),
    requestedAt: nonNegativeNumber(value.requestedAt),
  });

  return Object.keys(prompt).length > 0 ? prompt : undefined;
}

function safeBoundaryTabId(
  data: Record<string, unknown>,
  decision: string | undefined,
  capture: boolean | undefined,
): number | undefined {
  const tabId = nonNegativeInteger(data.tabId);
  if (tabId === undefined) return undefined;

  const previousTabId = nonNegativeInteger(data.previousTabId);
  return capture === true || decision === "follow" || previousTabId === tabId
    ? tabId
    : undefined;
}

function safeBoundaryLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[a-z][a-z0-9_.:-]{0,79}$/i.test(trimmed) ? trimmed : undefined;
}

function safeOrigin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : undefined;
  } catch {
    return undefined;
  }
}

function safeScheme(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toLowerCase().replace(/:$/, "");
  return /^[a-z][a-z0-9+.-]{0,31}$/.test(trimmed) ? trimmed : undefined;
}

function safeSchemeFromUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    return safeScheme(new URL(value).protocol);
  } catch {
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(value.trim());
    return match ? safeScheme(match[1]) : undefined;
  }
}

function schemeFromOrigin(origin: string): string | undefined {
  try {
    return safeScheme(new URL(origin).protocol);
  } catch {
    return undefined;
  }
}

function safeHost(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return normalizeBoundaryHost(value);
}

function normalizeBoundaryHost(value: string): string | undefined {
  const trimmed = value
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)]$/, "$1");
  if (trimmed.length === 0 || trimmed.length > 253) return undefined;
  if (/[/\\?#@\s]/.test(trimmed)) return undefined;
  if (!/^[a-z0-9.:-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function isFailedNetworkResponse(event: BugEvent): boolean {
  return (
    event.k === "net.res" &&
    ((typeof event.d.st === "number" && event.d.st >= 400) ||
      summarizeApplicationFailure(event) !== undefined)
  );
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
    code: safeDiagnosticString(failure.code),
    message: safeDiagnosticString(failure.message),
    phase: safeString(failure.phase),
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
  if (typeof value === "string") {
    return findApplicationFailureInText(value);
  }

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
      const parsed = JSON.parse(candidate);
      const failure = findApplicationFailure(parsed);
      if (failure) return failure;
    } catch {
      // Response bodies often contain framework framing; skip non-JSON chunks.
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

const FULL_STACK_BACKEND_KINDS = new Set([
  "backend.req.start",
  "backend.req.end",
  "backend.req.error",
  // Auto-captured uncaught exceptions / unhandled rejections
  // (crumbtrail-node AUTO_CAPTURE_ERROR_EVENT). Request-less, so they land in the
  // backend-missing-request-id bucket rather than a linked full-stack moment, but
  // their error still surfaces via mergeBackendEvent (mirrors backend.req.error).
  "backend.uncaught",
  // OTLP-ingested spans join via the adapter's traceId → requestId bridge, so a
  // telemetry-only backend (Path C) still links to the front-end request.
  "backend.otel.span",
]);

interface ClientRequestAccumulator {
  id: string;
  req?: BugEvent;
  res?: BugEvent;
  err?: BugEvent;
}

function buildFullStackRequestsIndex(
  events: BugEvent[],
): FullStackRequestsIndexSection | undefined {
  const clientByBrowserId = new Map<string, ClientRequestAccumulator>();
  const backendByRequestId = new Map<string, BackendRequestEvidence>();
  const backendWithoutRequestId: BackendRequestEvidence[] = [];

  for (const event of events) {
    if (
      event.k === "net.req" ||
      event.k === "net.res" ||
      event.k === "net.err"
    ) {
      const browserId = safeId(event.d.id);
      if (!browserId) continue;
      const entry = clientByBrowserId.get(browserId) ?? { id: browserId };
      if (event.k === "net.req") entry.req = event;
      else if (event.k === "net.res") entry.res = event;
      else entry.err = event;
      clientByBrowserId.set(browserId, entry);
      continue;
    }

    if (!FULL_STACK_BACKEND_KINDS.has(event.k)) continue;
    const requestId = safeId(event.d.requestId);
    if (!requestId) {
      const backend: BackendRequestEvidence = {};
      mergeBackendEvent(backend, event);
      backendWithoutRequestId.push(backend);
      continue;
    }
    const existing = backendByRequestId.get(requestId) ?? { requestId };
    mergeBackendEvent(existing, event);
    backendByRequestId.set(requestId, existing);
  }

  const frontendRequests = [...clientByBrowserId.values()]
    .map(summarizeFrontendRequest)
    .filter((entry): entry is FrontendRequestEvidence => entry !== undefined);
  const frontendWithRequestId = new Map<string, FrontendRequestEvidence>();
  for (const frontend of frontendRequests) {
    if (frontend.requestId)
      frontendWithRequestId.set(frontend.requestId, frontend);
  }

  const linked: LinkedFullStackRequestMoment[] = [];
  const gaps: FullStackRequestGapEntry[] = [];
  const linkedRequestIds = new Set<string>();

  for (const backend of backendByRequestId.values()) {
    const requestId = backend.requestId;
    if (!requestId) continue;
    const frontend = frontendWithRequestId.get(requestId);
    if (
      frontend &&
      frontend.sessionId &&
      backend.sessionId &&
      frontend.sessionId === backend.sessionId
    ) {
      linked.push({
        requestId,
        sessionId: frontend.sessionId,
        frontend,
        backend,
      });
      linkedRequestIds.add(requestId);
      continue;
    }

    const gapType = backendGapType(backend, frontend);
    gaps.push(
      removeUndefined({
        type: gapType,
        requestId,
        sessionId: backend.sessionId ?? frontend?.sessionId,
        frontend,
        backend,
      }),
    );
  }

  for (const frontend of frontendRequests) {
    if (frontend.requestId && linkedRequestIds.has(frontend.requestId))
      continue;
    if (frontend.requestId && backendByRequestId.has(frontend.requestId))
      continue;
    const type: FullStackGapKind = frontend.requestId
      ? "frontend-only"
      : "client-missing-request-id";
    gaps.push(
      removeUndefined({
        type,
        requestId: frontend.requestId,
        sessionId: frontend.sessionId,
        frontend,
      }),
    );
  }

  for (const backend of backendWithoutRequestId) {
    gaps.push(
      removeUndefined({
        type: "backend-missing-request-id" as const,
        sessionId: backend.sessionId,
        backend,
      }),
    );
  }

  if (linked.length === 0 && gaps.length === 0) return undefined;

  linked.sort(compareLinkedFullStackRequests);
  gaps.sort(compareFullStackGaps);

  const gapTypes = createEmptyGapTypes();
  for (const gap of gaps) gapTypes[gap.type] += 1;

  return {
    schemaVersion: 1,
    summary: {
      frontendRequests: frontendRequests.length,
      backendRequests: backendByRequestId.size + backendWithoutRequestId.length,
      linked: linked.length,
      gaps: gaps.length,
      gapTypes,
    },
    linked,
    gaps,
  };
}

function summarizeFrontendRequest(
  entry: ClientRequestAccumulator,
): FrontendRequestEvidence | undefined {
  const source = entry.req ?? entry.res ?? entry.err;
  if (!source) return undefined;
  const requestId = safeId(
    entry.req?.d.requestId ?? entry.res?.d.requestId ?? entry.err?.d.requestId,
  );
  const sessionId = safeId(
    entry.req?.d.sessionId ?? entry.res?.d.sessionId ?? entry.err?.d.sessionId,
  );
  const responseStatus = finiteNumber(entry.res?.d.st);
  const responseDuration = nonNegativeNumber(entry.res?.d.dur);
  const errorMessage = safeAlreadyRedactedString(entry.err?.d.msg);
  const errorTransport = safeLabel(entry.err?.d.transport);
  const error = removeUndefined({
    message: errorMessage,
    transport: errorTransport,
  });

  return removeUndefined({
    ref: eventRef(source),
    requestId,
    sessionId,
    method: safeMethod(
      entry.req?.d.method ??
        entry.req?.d.m ??
        entry.err?.d.method ??
        entry.err?.d.m,
    ),
    url: safeUrl(entry.req?.d.url ?? entry.err?.d.url),
    status: responseStatus,
    durationMs: responseDuration,
    error: Object.keys(error).length > 0 ? error : undefined,
  });
}

function mergeBackendEvent(
  target: BackendRequestEvidence,
  event: BugEvent,
): void {
  const d = event.d;
  target.requestId = target.requestId ?? safeId(d.requestId);
  target.sessionId =
    target.sessionId ?? safeId(d.sessionId) ?? safeId(event.sessionId);
  target.method = target.method ?? safeMethod(d.method);
  target.url = target.url ?? safeUrl(d.url);
  target.pathname = target.pathname ?? safePath(d.pathname);
  target.route = target.route ?? safePath(d.route);
  // OTLP spans report status as a string label ('ERROR'/'OK'/'UNSET') and carry any HTTP
  // status in their attribute map, so resolve a numeric status from there for these.
  const statusCode = finiteNumber(d.statusCode) ?? otelHttpStatusCode(event);
  const durationMs = nonNegativeNumber(d.durationMs);
  if (event.k === "backend.req.end") {
    target.statusCode = statusCode ?? target.statusCode;
    target.durationMs = durationMs ?? target.durationMs;
  } else {
    target.statusCode = target.statusCode ?? statusCode;
    target.durationMs = target.durationMs ?? durationMs;
  }

  const correlation = summarizeBackendCorrelation(d.correlation);
  if (correlation) target.correlation = target.correlation ?? correlation;

  if (event.k === "backend.req.start")
    target.start = target.start ?? eventRef(event);
  if (event.k === "backend.req.end") target.end = target.end ?? eventRef(event);
  if (event.k === "backend.req.error" || event.k === "backend.uncaught") {
    target.errorRef = target.errorRef ?? eventRef(event);
    const error = summarizeBackendError(d.error);
    if (error) target.error = target.error ?? error;
  }
  if (event.k === "backend.otel.span") mergeOtelSpan(target, event);
}

/** Reads a numeric HTTP status from common OTel semantic-convention attributes. */
function otelHttpStatusCode(event: BugEvent): number | undefined {
  const attrs = event.d.attributes;
  if (!isRecord(attrs)) return undefined;
  return (
    finiteNumber(attrs["http.response.status_code"]) ??
    finiteNumber(attrs["http.status_code"])
  );
}

/**
 * Maps an OTLP span onto backend request evidence: the span IS the backend moment, so it
 * anchors `start`, and an ERROR span surfaces an error ref + summary so the front-end
 * interaction links straight to the back-end failure on the OTLP path.
 */
function mergeOtelSpan(target: BackendRequestEvidence, event: BugEvent): void {
  const d = event.d;
  target.start = target.start ?? eventRef(event);
  target.route = target.route ?? safePath(d.route ?? d.name);
  // Honest provenance: this correlation key came from the OTLP trace id, not a Crumbtrail header.
  target.correlation = target.correlation ?? {
    requestIdSource: "otlp-trace-id",
    sessionIdSource: safeId(event.sessionId) ? "otlp-session-attr" : "missing",
  };
  if (safeLabel(d.statusCode) === "ERROR") {
    target.errorRef = target.errorRef ?? eventRef(event);
    const error = summarizeBackendError({
      name: d.name,
      message: d.statusMessage,
      statusCode: target.statusCode,
    });
    if (error) target.error = target.error ?? error;
  }
}

function summarizeBackendCorrelation(
  value: unknown,
): BackendRequestEvidence["correlation"] | undefined {
  if (!isRecord(value)) return undefined;
  const correlation = removeUndefined({
    status: safeLabel(value.status),
    sessionIdSource: safeLabel(value.sessionIdSource),
    requestIdSource: safeLabel(value.requestIdSource),
  });
  return Object.keys(correlation).length > 0 ? correlation : undefined;
}

function summarizeBackendError(
  value: unknown,
): BackendRequestEvidence["error"] | undefined {
  if (!isRecord(value)) return undefined;
  const error = removeUndefined({
    name: safeAlreadyRedactedString(value.name),
    code: safeAlreadyRedactedString(value.code),
    message: safeAlreadyRedactedString(value.message),
    statusCode: finiteNumber(value.statusCode),
  });
  return Object.keys(error).length > 0 ? error : undefined;
}

function backendGapType(
  backend: BackendRequestEvidence,
  frontend?: FrontendRequestEvidence,
): FullStackGapKind {
  const status = backend.correlation?.status;
  if (status === "generated-request-id") return "backend-generated-request-id";
  if (status === "missing-session") return "backend-missing-session";
  if (status === "missing-request-id") return "backend-missing-request-id";
  if (status === "missing-session-and-request-id")
    return "backend-missing-session-and-request-id";
  if (frontend && !frontend.requestId) return "client-missing-request-id";
  return "backend-only";
}

function eventRef(event: BugEvent): FullStackEventRef {
  return removeUndefined({
    t: event.t,
    offsetMs:
      nonNegativeNumber(event.offsetMs) ?? nonNegativeNumber(event.d.offsetMs),
    k: event.k,
  });
}

function createEmptyGapTypes(): Record<FullStackGapKind, number> {
  return {
    "frontend-only": 0,
    "backend-only": 0,
    "backend-generated-request-id": 0,
    "backend-missing-session": 0,
    "backend-missing-request-id": 0,
    "backend-missing-session-and-request-id": 0,
    "client-missing-request-id": 0,
  };
}

function compareLinkedFullStackRequests(
  a: LinkedFullStackRequestMoment,
  b: LinkedFullStackRequestMoment,
): number {
  const frontendDelta = a.frontend.ref.t - b.frontend.ref.t;
  if (frontendDelta !== 0) return frontendDelta;
  const backendDelta = (a.backend.start?.t ?? 0) - (b.backend.start?.t ?? 0);
  if (backendDelta !== 0) return backendDelta;
  return a.requestId.localeCompare(b.requestId);
}

function compareFullStackGaps(
  a: FullStackRequestGapEntry,
  b: FullStackRequestGapEntry,
): number {
  return (
    gapSortTime(a) - gapSortTime(b) ||
    a.type.localeCompare(b.type) ||
    String(a.requestId ?? "").localeCompare(String(b.requestId ?? ""))
  );
}

function gapSortTime(gap: FullStackRequestGapEntry): number {
  return (
    gap.frontend?.ref.t ??
    gap.backend?.start?.t ??
    gap.backend?.end?.t ??
    gap.backend?.errorRef?.t ??
    0
  );
}

function safeId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const trimmed = String(value).trim();
  if (trimmed.length === 0 || trimmed.length > 128) return undefined;
  return /^[a-z0-9_.:-]+$/i.test(trimmed) ? trimmed : undefined;
}

function safeMethod(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const method = value.trim().toUpperCase();
  return /^[A-Z]{1,24}$/.test(method) ? method : undefined;
}

function safeLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[a-z][a-z0-9_.:-]{0,79}$/i.test(trimmed) ? trimmed : undefined;
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

function redactPathTokens(value: string): string {
  return value
    .split("/")
    .map((segment) => {
      if (/^[A-Za-z0-9_-]{16,}$/.test(segment)) return "[REDACTED]";
      return segment;
    })
    .join("/");
}

function safeAlreadyRedactedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const result = redactTokenLikeString(trimmed, "value");
  if (result.metadata) return undefined;
  return safeString(trimmed);
}

async function processAudio(
  sessionDir: string,
  events: BugEvent[],
  whisperModel?: string,
): Promise<AudioProcessResult> {
  const audioPath = path.join(sessionDir, "audio.webm");
  if (!fs.existsSync(audioPath)) return { events };

  const wavPath = path.join(sessionDir, "audio.wav");
  const transcriptBasePath = path.join(sessionDir, "transcript");
  const transcriptPath = `${transcriptBasePath}.json`;
  const upload = readAudioUploadMetadata(sessionDir);
  const summaryBase = {
    artifact: "audio.webm" as const,
    bytes: fs.statSync(audioPath).size,
    ...(upload ? { upload } : {}),
  };

  if (upload?.transcriptionRequested === false) {
    return {
      events,
      audio: {
        ...summaryBase,
        transcription: { state: "not-requested" },
      },
    };
  }

  try {
    // Convert to WAV
    try {
      execFileSync(
        "ffmpeg",
        [
          "-i",
          audioPath,
          "-ar",
          "16000",
          "-ac",
          "1",
          "-f",
          "wav",
          "-y",
          wavPath,
        ],
        { stdio: "pipe" },
      );
    } catch (err) {
      throw new AudioProcessingError("ffmpeg", err);
    }

    // Run whisper
    try {
      const model = whisperModel || "base";
      execFileSync(
        "whisper-cpp",
        ["-m", model, "-f", wavPath, "-oj", "-of", transcriptBasePath],
        { stdio: "pipe" },
      );
    } catch (err) {
      throw new AudioProcessingError("whisper-cpp", err);
    }

    if (!fs.existsSync(transcriptPath)) {
      throw new AudioProcessingError(
        "transcript",
        new AudioTranscriptionUnavailableError(),
      );
    }

    const txEvents = readTranscriptEvents(transcriptPath, events, sessionDir);

    // Merge and re-sort. Drop existing tx events so repeated successful post-process runs don't duplicate.
    const baseEvents = events.filter((e) => e.k !== "tx");
    const allEvents = [...baseEvents, ...txEvents].sort((a, b) => a.t - b.t);

    // Re-write events.ndjson with merged events.
    writeEvents(sessionDir, allEvents);

    return {
      events: allEvents,
      audio: {
        ...summaryBase,
        transcription: {
          state: "transcription-ready",
          transcriptFile: "transcript.json",
          eventCount: txEvents.length,
        },
      },
    };
  } catch (err) {
    return {
      events,
      audio: {
        ...summaryBase,
        transcription: describeAudioFailure(err),
      },
    };
  }
}

function readTranscriptEvents(
  transcriptPath: string,
  events: BugEvent[],
  sessionDir: string,
): BugEvent[] {
  let transcript: unknown;
  try {
    transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf-8"));
  } catch (err) {
    throw new AudioProcessingError("transcript", err);
  }

  const startTime = events[0]?.t ?? readMetaStart(sessionDir) ?? 0;
  const txEvents: BugEvent[] = [];
  const segments =
    isRecord(transcript) && Array.isArray(transcript.transcription)
      ? transcript.transcription
      : [];

  for (const seg of segments) {
    if (!isRecord(seg)) continue;
    const offsets = isRecord(seg.offsets) ? seg.offsets : undefined;
    const from = typeof offsets?.from === "number" ? offsets.from : 0;
    txEvents.push({
      t: startTime + Math.round((from * 1000) / 100),
      k: "tx",
      d: { text: typeof seg.text === "string" ? seg.text.trim() : "" },
    });
  }

  return txEvents;
}

function writeEvents(sessionDir: string, events: BugEvent[]): void {
  const eventsPath = path.join(sessionDir, "events.ndjson");
  const content =
    events.length > 0
      ? events.map((e) => JSON.stringify(e)).join("\n") + "\n"
      : "";
  fs.writeFileSync(eventsPath, content);
}

class AudioProcessingError extends Error {
  constructor(
    readonly phase: "ffmpeg" | "whisper-cpp" | "transcript",
    readonly cause: unknown,
  ) {
    super(`Audio processing failed during ${phase}`);
    this.name = "AudioProcessingError";
  }
}

class AudioTranscriptionUnavailableError extends Error {
  constructor() {
    super("Transcript output was not produced");
    this.name = "AudioTranscriptionUnavailableError";
  }
}

function describeAudioFailure(
  err: unknown,
): PostProcessAudioSummary["transcription"] {
  const phase = err instanceof AudioProcessingError ? err.phase : "transcript";
  const cause = err instanceof AudioProcessingError ? err.cause : err;
  const unavailable =
    cause instanceof AudioTranscriptionUnavailableError ||
    isToolUnavailableError(cause);

  if (unavailable) {
    return {
      state: "transcription-unavailable",
      code: "transcription_unavailable",
      message: `Audio was preserved, but local transcription is unavailable during ${phase}.`,
    };
  }

  return {
    state: "transcription-error",
    code: "transcription_failed",
    message: `Audio was preserved, but local transcription failed during ${phase}.`,
  };
}

function isToolUnavailableError(err: unknown): boolean {
  if (!isRecord(err)) return false;
  return err.code === "ENOENT" || err.code === "EACCES";
}

function readAudioUploadMetadata(
  sessionDir: string,
): PostProcessAudioSummary["upload"] | undefined {
  const metadataPath = path.join(sessionDir, "audio.json");
  if (!fs.existsSync(metadataPath)) return undefined;

  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(metadataPath, "utf-8"));
    if (!isRecord(parsed)) return undefined;
    return removeUndefined({
      metadataFile: "audio.json" as const,
      uploadedAt: finiteNumber(parsed.uploadedAt),
      contentType: safeString(parsed.contentType),
      mimeType: safeString(parsed.mimeType),
      durationMs: nonNegativeNumber(parsed.durationMs),
      chunkCount: nonNegativeInteger(parsed.chunkCount),
      transcriptionRequested:
        typeof parsed.transcriptionRequested === "boolean"
          ? parsed.transcriptionRequested
          : undefined,
    });
  } catch {
    return undefined;
  }
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === "number" && value >= 0
    ? value
    : undefined;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, 200);
}

function safeDiagnosticString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return redactUrlLikeText(
    redactTokenLikeString(trimmed, "diagnostic").value,
  ).slice(0, 200);
}

function redactUrlLikeText(value: string): string {
  return value.replace(
    /https?:\/\/[^\s)\]}>,]+|\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+\?[^\s)\]}>,]+/g,
    (match) => {
      try {
        const parsed = match.startsWith("http")
          ? new URL(match)
          : new URL(match, "http://local.invalid");
        parsed.username = "";
        parsed.password = "";
        for (const key of Array.from(parsed.searchParams.keys())) {
          const values = parsed.searchParams.getAll(key);
          parsed.searchParams.delete(key);
          for (const entry of values)
            parsed.searchParams.append(key, entry === "" ? "" : "[REDACTED]");
        }
        parsed.hash = "";
        const redacted = match.startsWith("http")
          ? parsed.toString()
          : `${parsed.pathname}${parsed.search}`;
        return redactTokenLikeString(redacted, "diagnostic.url").value;
      } catch {
        return redactTokenLikeString(
          match.replace(/([?&][^=&#\s]+)=([^&#\s]+)/g, "$1=[REDACTED]"),
          "diagnostic.url",
        ).value;
      }
    },
  );
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readMetaStart(sessionDir: string): number | undefined {
  try {
    const buf = defaultSessionStore.readArtifact(sessionDir, "meta.json");
    if (!buf) return undefined;
    const meta = JSON.parse(buf.toString("utf-8"));
    return finiteNumber(meta.start);
  } catch {
    return undefined;
  }
}

function writeEmptyIndex(
  sessionDir: string,
  audio?: PostProcessAudioSummary,
  truncation?: CaptureTruncationSummary,
): SessionIndex {
  const index: SessionIndex = {
    id: path.basename(sessionDir),
    start: 0,
    end: 0,
    dur: 0,
    evts: 0,
    errs: [],
    failedReqs: [],
    navs: [],
    stats: {},
    redaction: summarizeRedaction([]),
    ...(audio !== undefined ? { audio } : {}),
    ...(truncation !== undefined ? { truncated: truncation } : {}),
  };
  fs.writeFileSync(path.join(sessionDir, "index.json"), JSON.stringify(index));
  return index;
}
