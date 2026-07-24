import fs from "node:fs";
import path from "node:path";
import * as zlib from "node:zlib";
import type { BugEvent } from "crumbtrail-core";
import {
  BROWSER_REDACTION_POLICY_V2,
  REDACTED_VALUE,
  redactNetworkTextBody,
  redactTokenLikeString,
  redactUrl,
} from "crumbtrail-core";
import type { EvidenceCandidate } from "./evidence-index";
import type { LlmBundle, LlmBundleRedactionSummary } from "./llm-bundle";
import { defaultSessionStore } from "./session-store";

export const SESSION_MANIFEST_SCHEMA_VERSION = 1 as const;
export const TWO_PLANE_LAYOUT_VERSION = 1 as const;
export const COLD_EVENTS_ARTIFACT = "events.ndjson.zst" as const;
export const SIGNATURES_ARTIFACT = "signatures.json" as const;
export const MANIFEST_ARTIFACT = "manifest.json" as const;
export const BUNDLE_ALIAS_ARTIFACT = "bundle.json" as const;
export const CAPTURE_TRUNCATED_ARTIFACT = "capture-truncated.json" as const;

export interface CaptureTruncationSummary {
  truncated: true;
  reason: "session_event_bytes_cap";
  maxEventBytes: number;
  eventsAccepted: number;
  eventsDropped: number;
  bytesWritten: number;
  truncatedAt: number;
}

interface SessionIndexForManifest {
  id?: string;
  start?: number;
  end?: number;
  dur?: number;
  evts?: number;
  stats?: Record<string, number>;
  errs?: Array<{ t: number; msg?: string }>;
  failedReqs?: Array<{
    t: number;
    m?: string;
    url?: string;
    st?: number;
    reason?: string;
    code?: string;
  }>;
  redaction?: LlmBundleRedactionSummary;
  truncated?: CaptureTruncationSummary;
}

interface SignatureDictionaryEntry {
  id: number;
  sig: string;
  path?: string;
  tag?: string;
  firstSeen: number;
  firstEventKind: string;
}

interface SignatureDictionary {
  schemaVersion: 1;
  entries: SignatureDictionaryEntry[];
}

interface SignatureDictionaryBuildResult {
  dictionary: SignatureDictionary;
  signatureIds: Map<string, number>;
}

export interface WriteTwoPlaneSessionArtifactsInput {
  sessionDir: string;
  events: BugEvent[];
  index: SessionIndexForManifest;
  candidates: EvidenceCandidate[];
  bundle: LlmBundle;
  coldEvidence: ColdEvidenceArtifacts;
}

export interface WriteColdEvidenceArtifactsInput {
  sessionDir: string;
  events: BugEvent[];
}

export interface ColdEvidenceArtifacts {
  signatures: SignatureDictionary;
  sourceRawBytes: number;
  coldRawBytes: number;
  compressedBytes: number;
}

export async function writeColdEvidenceArtifacts(
  input: WriteColdEvidenceArtifactsInput,
): Promise<ColdEvidenceArtifacts> {
  const { dictionary: signatures, signatureIds } = buildSignatureDictionary(
    input.events,
  );
  await writeGeneratedArtifact(
    input.sessionDir,
    SIGNATURES_ARTIFACT,
    `${JSON.stringify(signatures, null, 2)}\n`,
  );

  const coldEvents = input.events.map((event) =>
    prepareColdEvent(event, signatureIds),
  );
  const coldNdjson =
    coldEvents.length > 0
      ? `${coldEvents.map((event) => JSON.stringify(event)).join("\n")}\n`
      : "";
  const compressed = compressColdEvents(Buffer.from(coldNdjson, "utf-8"));
  await writeGeneratedArtifact(
    input.sessionDir,
    COLD_EVENTS_ARTIFACT,
    compressed,
  );

  return {
    signatures,
    coldRawBytes: Buffer.byteLength(coldNdjson, "utf-8"),
    sourceRawBytes:
      existingFileBytes(path.join(input.sessionDir, "events.ndjson")) ??
      Buffer.byteLength(coldNdjson, "utf-8"),
    compressedBytes: compressed.byteLength,
  };
}

/**
 * Rehydrates the cold event stream back into analyzable {@link BugEvent}s.
 *
 * This is the read inverse of {@link writeColdEvidenceArtifacts}: it
 * decompresses `events.ndjson.zst` and expands each `d.el = { sigRef }` back
 * into the `{ sig, path, tag }` shape the analyzer expects, using
 * `signatures.json` as the dictionary. Without that expansion every element
 * anchored detector sees a bare numeric ref and silently stops matching.
 *
 * Returns undefined when the session has no cold artifact (a live session that
 * has not finalized yet, where `events.ndjson` is still the source of truth).
 * Cold events are already sanitized, so callers must not re-sanitize them.
 */
export function readColdEvents(sessionDir: string): BugEvent[] | undefined {
  const coldPath = path.join(sessionDir, COLD_EVENTS_ARTIFACT);
  if (!fs.existsSync(coldPath)) return undefined;
  if (typeof zlib.zstdDecompressSync !== "function") {
    throw new Error(
      "Crumbtrail cold storage requires Node.js >=22.15.0 for zstd decompression.",
    );
  }
  const raw = zlib.zstdDecompressSync(fs.readFileSync(coldPath)).toString(
    "utf-8",
  );
  const bySigRef = readSignatureDictionaryById(sessionDir);
  const events: BugEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // Match readEvents: skip malformed lines rather than fail the replay.
    }
    if (!isRecord(parsed)) continue;
    events.push(rehydrateColdEvent(parsed as unknown as BugEvent, bySigRef));
  }
  return events;
}

/**
 * Reports the cold plane exactly as it already exists on disk, so a re-analysis
 * can rebuild the manifest without rewriting `events.ndjson.zst`.
 *
 * Byte counts come from the previous manifest when it is readable, because
 * `sourceRawBytes` records the size of the original `events.ndjson`, which is
 * gone by the time a session is cold and cannot be recovered from the
 * compressed copy. Falling back to the on-disk sizes keeps the ratio honest
 * (it reports cold-to-compressed) rather than inventing a figure.
 */
export function readColdEvidenceArtifacts(
  sessionDir: string,
): ColdEvidenceArtifacts | undefined {
  const compressedBytes = existingFileBytes(
    path.join(sessionDir, COLD_EVENTS_ARTIFACT),
  );
  if (compressedBytes === undefined) return undefined;
  const signatures = readSignatureDictionary(sessionDir);
  const manifest = readJsonRecord(path.join(sessionDir, MANIFEST_ARTIFACT));
  const cold = isRecord(manifest?.cold) ? manifest.cold : undefined;
  const compression = isRecord(cold?.compression) ? cold.compression : undefined;
  const coldRawBytes = finiteNumber(compression?.coldRawBytes);
  const sourceRawBytes = finiteNumber(compression?.sourceRawBytes);
  return {
    signatures,
    coldRawBytes: coldRawBytes ?? compressedBytes,
    sourceRawBytes: sourceRawBytes ?? coldRawBytes ?? compressedBytes,
    compressedBytes,
  };
}

function readSignatureDictionary(sessionDir: string): SignatureDictionary {
  const parsed = readJsonRecord(path.join(sessionDir, SIGNATURES_ARTIFACT));
  const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
  return {
    schemaVersion: 1,
    entries: entries.filter(
      (entry): entry is SignatureDictionaryEntry =>
        isRecord(entry) && finiteNumber(entry.id) !== undefined,
    ),
  };
}

function readSignatureDictionaryById(
  sessionDir: string,
): Map<number, SignatureDictionaryEntry> {
  const byId = new Map<number, SignatureDictionaryEntry>();
  for (const entry of readSignatureDictionary(sessionDir).entries)
    byId.set(entry.id, entry);
  return byId;
}

/** Expands `d.el = { sigRef }` back to the dictionary entry it points at. */
function rehydrateColdEvent(
  event: BugEvent,
  bySigRef: Map<number, SignatureDictionaryEntry>,
): BugEvent {
  const data = isRecord(event.d) ? event.d : undefined;
  if (!data) return event;
  const el = isRecord(data.el) ? data.el : undefined;
  const sigRef = finiteNumber(el?.sigRef);
  if (sigRef === undefined) return event;
  const entry = bySigRef.get(sigRef);
  // A dangling ref means signatures.json is missing or truncated. Drop the
  // placeholder rather than leave `{ sigRef }` behind, so detectors treat the
  // element as absent instead of matching against a meaningless shape.
  const rehydrated = entry
    ? removeUndefined({ sig: entry.sig, path: entry.path, tag: entry.tag })
    : undefined;
  const nextData = { ...data };
  if (rehydrated) nextData.el = rehydrated;
  else delete nextData.el;
  return { ...event, d: nextData } as BugEvent;
}

export async function writeTwoPlaneSessionArtifacts(
  input: WriteTwoPlaneSessionArtifactsInput,
): Promise<void> {
  await writeGeneratedArtifact(
    input.sessionDir,
    BUNDLE_ALIAS_ARTIFACT,
    `${JSON.stringify(input.bundle, null, 2)}\n`,
  );

  const manifest = await buildManifest(input, input.coldEvidence);
  await writeGeneratedArtifact(
    input.sessionDir,
    MANIFEST_ARTIFACT,
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

async function writeGeneratedArtifact(
  sessionDir: string,
  name: string,
  data: string | Buffer,
): Promise<void> {
  await defaultSessionStore.writeArtifact(sessionDir, name, data);
}

export function readCaptureTruncationMarker(
  sessionDir: string,
): CaptureTruncationSummary | undefined {
  const markerPath = path.join(sessionDir, CAPTURE_TRUNCATED_ARTIFACT);
  if (!fs.existsSync(markerPath)) return undefined;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(markerPath, "utf-8"));
    if (
      !isRecord(parsed) ||
      parsed.truncated !== true ||
      parsed.reason !== "session_event_bytes_cap"
    )
      return undefined;
    const marker = removeUndefined({
      truncated: true as const,
      reason: "session_event_bytes_cap" as const,
      maxEventBytes: finiteNumber(parsed.maxEventBytes),
      eventsAccepted: finiteNumber(parsed.eventsAccepted),
      eventsDropped: finiteNumber(parsed.eventsDropped),
      bytesWritten: finiteNumber(parsed.bytesWritten),
      truncatedAt: finiteNumber(parsed.truncatedAt),
    });
    return typeof marker.maxEventBytes === "number" &&
      typeof marker.eventsAccepted === "number" &&
      typeof marker.eventsDropped === "number" &&
      typeof marker.bytesWritten === "number" &&
      typeof marker.truncatedAt === "number"
      ? (marker as CaptureTruncationSummary)
      : undefined;
  } catch {
    return undefined;
  }
}

export function sanitizeEventForStorage(event: BugEvent): BugEvent {
  return sanitizeRecord(
    event as unknown as Record<string, unknown>,
    "event",
  ) as unknown as BugEvent;
}

function buildSignatureDictionary(
  events: BugEvent[],
): SignatureDictionaryBuildResult {
  const bySig = new Map<string, SignatureDictionaryEntry>();
  const signatureIds = new Map<string, number>();

  for (const event of events) {
    const data = isRecord(event.d) ? event.d : {};
    const el = isRecord(data.el) ? data.el : undefined;
    const sig = safeId(el?.sig);
    if (!el || !sig || bySig.has(sig)) continue;
    const id = bySig.size + 1;
    signatureIds.set(sig, id);
    const sanitized = sanitizeRecord(el, "d.el");
    bySig.set(
      sig,
      removeUndefined({
        id,
        sig: sanitizeIdentifier(sig, "d.el.sig"),
        path: safeString(sanitized.path),
        tag: safeString(sanitized.tag),
        firstSeen: finiteNumber(event.t) ?? 0,
        firstEventKind: safeString(event.k) ?? "unknown",
      }),
    );
  }

  return {
    dictionary: { schemaVersion: 1, entries: [...bySig.values()] },
    signatureIds,
  };
}

function prepareColdEvent(
  event: BugEvent,
  signatureIds: Map<string, number>,
): BugEvent {
  const sanitized = sanitizeEventForStorage(event);
  const data = isRecord(event.d) ? event.d : {};
  const el = isRecord(data.el) ? data.el : undefined;
  const sig = safeId(el?.sig);
  const sigRef = sig ? signatureIds.get(sig) : undefined;
  if (!isRecord(sanitized.d)) sanitized.d = {};
  if (sigRef !== undefined) {
    sanitized.d = { ...sanitized.d, el: { sigRef } };
  }
  return sanitized;
}

async function buildManifest(
  input: WriteTwoPlaneSessionArtifactsInput,
  storage: {
    signatures: SignatureDictionary;
    sourceRawBytes: number;
    coldRawBytes: number;
    compressedBytes: number;
  },
): Promise<Record<string, unknown>> {
  const meta = readJsonRecord(path.join(input.sessionDir, "meta.json")) ?? {};
  const start =
    finiteNumber(input.index.start) ??
    finiteNumber(meta.start) ??
    input.events[0]?.t ??
    0;
  const end =
    finiteNumber(input.index.end) ??
    finiteNumber(meta.end) ??
    input.events.at(-1)?.t ??
    start;
  const partitionStart = finiteNumber(meta.start) ?? start;
  const tenant = partitionSegment(meta.tenant, "local");
  const app = partitionSegment(meta.app, "unknown-app");
  const sessionId =
    safeSessionId(meta.id) ??
    safeSessionId(input.index.id) ??
    path.basename(input.sessionDir);
  const date = isoDate(partitionStart);
  const partitionPath = path.join(tenant, app, date, sessionId);
  const compressionRatio =
    storage.compressedBytes > 0
      ? Number((storage.sourceRawBytes / storage.compressedBytes).toFixed(2))
      : storage.sourceRawBytes === 0
        ? 1
        : storage.sourceRawBytes;

  // Hoisted out of the manifest literal because describeArtifacts now stats
  // through the async store seam. Order is preserved (hot, then cold).
  const hotArtifacts = await describeArtifacts(input.sessionDir, [
    MANIFEST_ARTIFACT,
    BUNDLE_ALIAS_ARTIFACT,
    "llm.json",
    "llm.md",
    "index.json",
    "candidates.jsonl",
    "CANDIDATES.md",
    "timeline.md",
    "search.jsonl",
  ]);
  const coldArtifacts = await describeArtifacts(input.sessionDir, [
    COLD_EVENTS_ARTIFACT,
    SIGNATURES_ARTIFACT,
    "recording.webm",
    "audio.webm",
    "frames",
  ]);

  return {
    schemaVersion: SESSION_MANIFEST_SCHEMA_VERSION,
    kind: "crumbtrail.session-manifest",
    generatedAt: input.bundle.generatedAt,
    generatedAtIso: input.bundle.generatedAtIso,
    session: removeUndefined({
      id:
        safeString(meta.id) ??
        safeString(input.index.id) ??
        path.basename(input.sessionDir),
      tenant,
      app,
      startMs: start,
      endMs: end,
      durationMs: finiteNumber(input.index.dur) ?? Math.max(0, end - start),
      eventCount: finiteNumber(input.index.evts) ?? input.events.length,
      truncated: input.index.truncated?.truncated,
    }),
    partition: {
      convention: "{tenant}/{app}/{YYYY-MM-DD}/{sessionId}",
      tenant,
      app,
      date,
      sessionId,
      path: partitionPath,
      appliedToPath: sessionDirMatchesPartition(
        input.sessionDir,
        partitionPath,
      ),
    },
    hot: {
      layoutVersion: TWO_PLANE_LAYOUT_VERSION,
      artifacts: hotArtifacts.map((artifact) =>
        artifact.path === MANIFEST_ARTIFACT
          ? { ...artifact, exists: true }
          : artifact,
      ),
    },
    cold: {
      layoutVersion: TWO_PLANE_LAYOUT_VERSION,
      transcode: {
        format: "ndjson+zstd",
        status: "parquet-deferred",
        parquetDecision:
          "Deferred until a dependency-light Parquet writer is chosen; the plane split ships now with zstd-compressed NDJSON fallback.",
        redaction: "sanitized-before-cold-write",
      },
      artifacts: coldArtifacts,
      compression: {
        sourceRawBytes: storage.sourceRawBytes,
        coldRawBytes: storage.coldRawBytes,
        compressedBytes: storage.compressedBytes,
        ratio: compressionRatio,
      },
      signatures: {
        path: SIGNATURES_ARTIFACT,
        count: storage.signatures.entries.length,
      },
    },
    timeline: {
      eventCounts: Object.fromEntries(
        Object.entries(input.index.stats ?? {}).sort(([a], [b]) =>
          a.localeCompare(b),
        ),
      ),
      errorMarkers: (input.index.errs ?? []).slice(0, 20).map((entry) =>
        removeUndefined({
          t: entry.t,
          msg: safeString(entry.msg),
        }),
      ),
      failedRequests: (input.index.failedReqs ?? []).slice(0, 20).map((entry) =>
        removeUndefined({
          t: entry.t,
          method: safeString(entry.m),
          url: safeUrlString(entry.url),
          status: entry.st,
          reason: safeString(entry.reason),
          code: safeString(entry.code),
        }),
      ),
    },
    candidates: input.candidates.slice(0, 20).map((candidate) => ({
      id: candidate.id,
      detector: candidate.detector,
      severity: candidate.severity,
      basis: "heuristic" as const,
      baseScore: candidate.score,
      score: candidate.score,
      anchor: candidate.anchor,
      evidenceWindow: candidate.evidenceWindow,
    })),
    redaction: input.index.redaction,
    ...(input.index.truncated ? { truncation: input.index.truncated } : {}),
    accessPattern: [
      "Read manifest.json first.",
      "Use candidates.jsonl and windows/*.md for bounded drill-down.",
      "Open events.ndjson.zst only when raw chronological evidence is required.",
    ],
  };
}

async function describeArtifacts(
  sessionDir: string,
  names: string[],
): Promise<Array<Record<string, unknown>>> {
  const described: Array<Record<string, unknown>> = [];
  // Serial (not Promise.all) so the emitted order matches `names` exactly and
  // the store sees the same one-at-a-time access pattern it did when sync.
  for (const name of names) {
    const stat = await defaultSessionStore.statArtifact(sessionDir, name);
    if (!stat) {
      described.push({ path: name, exists: false });
      continue;
    }
    const entries = stat.isDir
      ? (await defaultSessionStore.listArtifacts(path.join(sessionDir, name)))
          .length
      : undefined;
    described.push(
      removeUndefined({
        path: name,
        exists: true,
        bytes: !stat.isDir ? stat.bytes : undefined,
        entries,
      }),
    );
  }
  return described;
}

function compressColdEvents(input: Buffer): Buffer {
  if (typeof zlib.zstdCompressSync !== "function") {
    throw new Error(
      "Crumbtrail cold storage requires Node.js >=22.15.0 for zstd compression.",
    );
  }
  return zlib.zstdCompressSync(input);
}

function sanitizeValue(value: unknown, fieldPath: string): unknown {
  if (typeof value === "string") {
    if (isSafeSdkDescriptorValue(fieldPath, value)) return value;
    if (
      isSafeCorrelationPath(fieldPath) &&
      isSafeCorrelationValue(fieldPath, value)
    )
      return value;
    if (isSensitiveField(fieldPath)) return REDACTED_VALUE;
    return sanitizeString(value, fieldPath);
  }
  if (Array.isArray(value))
    return value.map((entry, index) =>
      sanitizeValue(entry, `${fieldPath}[${index}]`),
    );
  if (isRecord(value)) return sanitizeRecord(value, fieldPath);
  return value;
}

function sanitizeRecord(
  value: Record<string, unknown>,
  fieldPath: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const safeKey = sanitizeKey(key, fieldPath);
    const childPath = `${fieldPath}.${safeKey}`;
    if (
      typeof raw === "string" &&
      isSafeCorrelationPath(childPath) &&
      isSafeCorrelationValue(childPath, raw)
    ) {
      out[safeKey] = raw;
      continue;
    }
    if (
      key === "body" &&
      fieldPath === "event.d" &&
      typeof raw === "string" &&
      declaresStructuredBodyRedaction(value)
    ) {
      out[safeKey] = sanitizeStructuredBody(raw);
      continue;
    }
    if (
      (isSensitiveName(key) && !isSafeMetadataField(key)) ||
      isSensitiveField(childPath) ||
      safeKey === REDACTED_VALUE
    ) {
      out[safeKey] = REDACTED_VALUE;
      continue;
    }
    out[safeKey] = sanitizeValue(raw, childPath);
  }
  return out;
}

/**
 * A network event body is kept at rest only when the emitting SDK declared
 * structured (v2) redaction for the event AND the server's own structured
 * classifier successfully re-processes it. The client declaration is a hint,
 * never a grant: every value in the body is re-classified here, so a client
 * that lies about its policy still cannot store secrets. Anything that fails
 * the re-run (non-JSON, oversized, parse error) collapses to the blanket
 * REDACTED_VALUE this sanitizer always used.
 */
function declaresStructuredBodyRedaction(
  record: Record<string, unknown>,
): boolean {
  const redaction = record.redaction;
  return (
    isRecord(redaction) && redaction.policy === BROWSER_REDACTION_POLICY_V2
  );
}

function sanitizeStructuredBody(body: string): string {
  try {
    const result = redactNetworkTextBody(body, {
      contentType: "application/json",
      path: "event.d.body",
      mode: "structured",
    });
    if (
      typeof result.body === "string" &&
      result.bodySummary?.reason === "structured_redaction"
    ) {
      return result.body;
    }
  } catch {
    /* fall through to blanket redaction */
  }
  return REDACTED_VALUE;
}

function sanitizeKey(key: string, fieldPath: string): string {
  if (isPrototypeSpecialKey(key)) return REDACTED_VALUE;
  if (isSafeStructuralKey(key, fieldPath)) return key;
  const sanitized = sanitizeString(key, `${fieldPath}.$key`);
  if (sanitized === key) return key;
  return REDACTED_VALUE;
}

function sanitizeString(value: string, fieldPath: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) return value;
  const urlRedacted =
    isUrlField(fieldPath) || looksUrlLike(trimmed)
      ? redactUrl(trimmed, fieldPath).value
      : trimmed;
  return redactTokenLikeString(urlRedacted, fieldPath).value;
}

function sanitizeIdentifier(value: string, fieldPath: string): string {
  const sanitized = sanitizeString(value, fieldPath);
  return sanitized === value ? value : REDACTED_VALUE;
}

function isSensitiveField(fieldPath: string): boolean {
  return fieldPath
    .split(/[.[\]]+/)
    .filter(Boolean)
    .filter((segment) => !isSafeMetadataField(segment))
    .some((segment) => isSensitiveName(segment));
}

function isSafeCorrelationField(segment: string): boolean {
  return SAFE_CORRELATION_FIELD_NAMES.has(segment);
}

function isSafeSdkDescriptorValue(fieldPath: string, value: string): boolean {
  if (fieldPath !== "event.sdk.name" && fieldPath !== "event.sdk.version")
    return false;
  if (redactTokenLikeString(value, fieldPath).value !== value) return false;
  return /^[@A-Za-z0-9_.:/-]{1,128}$/.test(value);
}

function isSafeCorrelationPath(fieldPath: string): boolean {
  const leaf = fieldPath
    .split(/[.[\]]+/)
    .filter(Boolean)
    .at(-1);
  return SAFE_CORRELATION_VALUE_FIELD_NAMES.has(leaf ?? "");
}

function isSafeCorrelationValue(fieldPath: string, value: string): boolean {
  const leaf = fieldPath
    .split(/[.[\]]+/)
    .filter(Boolean)
    .at(-1);
  if (leaf === "traceId")
    return /^[a-f0-9]{32}$/i.test(value) && !/^0{32}$/.test(value);
  if (leaf === "spanId" || leaf === "parentSpanId")
    return /^[a-f0-9]{16}$/i.test(value) && !/^0{16}$/.test(value);
  if (
    leaf === "requestId" &&
    /^[a-f0-9]{32}$/i.test(value) &&
    !/^0{32}$/.test(value)
  )
    return true;
  if (leaf === "sessionId") {
    if (fieldPath !== "event.sessionId" && fieldPath !== "event.d.sessionId")
      return false;
    if (redactTokenLikeString(value, fieldPath).value !== value) return false;
    return /^sess?[A-Za-z0-9_.:-]{1,124}$/.test(value);
  }
  if (redactTokenLikeString(value, fieldPath).value !== value) return false;
  if (leaf === "requestIdSource" || leaf === "sessionIdSource")
    return /^[A-Za-z0-9_.:-]{1,40}$/.test(value);
  return /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}

function isSafeMetadataField(segment: string): boolean {
  return SAFE_METADATA_FIELD_NAMES.has(segment);
}

function isSafeStructuralKey(key: string, fieldPath: string): boolean {
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(key)) return false;
  if (isPrototypeSpecialKey(key)) return false;
  if (isSensitiveName(key) && !isSafeMetadataField(key)) return false;
  if (isSensitiveField(`${fieldPath}.${key}`)) return false;
  return sanitizeString(key, `${fieldPath}.$key`) === key;
}

function isPrototypeSpecialKey(key: string): boolean {
  return key === "__proto__" || key === "constructor" || key === "prototype";
}

function isUrlField(fieldPath: string): boolean {
  return /(^|\.)(url|href|to|from|rootUrl|pathname|name)(\.|$)/i.test(
    fieldPath,
  );
}

function looksUrlLike(value: string): boolean {
  return /^https?:\/\//i.test(value) || /^\/[^ ]*\?/.test(value);
}

function safeUrlString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return safeString(redactUrl(value, "url").value);
}

function existingFileBytes(filePath: string): number | undefined {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return undefined;
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isoDate(value: number): string {
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return "1970-01-01";
  }
}

function sessionDirMatchesPartition(
  sessionDir: string,
  partitionPath: string,
): boolean {
  const actualSuffix = path
    .normalize(sessionDir)
    .split(path.sep)
    .filter(Boolean)
    .slice(-4)
    .join(path.sep);
  return actualSuffix === partitionPath;
}

function partitionSegment(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  const normalized = text
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return normalized || fallback;
}

function safeSessionId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return /^[A-Za-z0-9._-]+$/.test(text) ? text : undefined;
}

function safeId(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return /^[a-z0-9_.:-]{1,160}$/i.test(text) ? text : undefined;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 240) : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-session-id",
]);

const SENSITIVE_NAME_RE =
  /(^|[^a-z0-9])(access[-_]?token|api[-_]?key|auth|authorization|bearer|body|card|client[-_]?secret|cookie|credential|csrf|id[-_]?token|jwt|mfa|otp|pass(code|word)?|passwd|private[-_]?key|raw[-_]?payload|refresh[-_]?token|secret|session|sid|ssn|token|xsrf)([^a-z0-9]|$)/i;
const PII_NAME_RE =
  /(^|[^a-z0-9])(email|phone|address|dob|birthdate|postal|zip)([^a-z0-9]|$)/i;
const SENSITIVE_COMPACT_NAMES = new Set([
  "accesskey",
  "accesstoken",
  "apikey",
  "apikeys",
  "auth",
  "authentication",
  "authenticationinfo",
  "authkey",
  "authtoken",
  "authorization",
  "authorizationinfo",
  "bearer",
  "body",
  "cardnumber",
  "clientsecret",
  "cookie",
  "credentials",
  "creds",
  "csrf",
  "csrfkey",
  "csrftoken",
  "cvc",
  "cvv",
  "idtoken",
  "jsessionid",
  "jwt",
  "mfa",
  "otp",
  "passcode",
  "passphrase",
  "passwd",
  "password",
  "passwordconfirmation",
  "passwords",
  "pin",
  "privatekey",
  "proxyauthentication",
  "proxyauthenticationinfo",
  "pwd",
  "rawpayload",
  "refreshtoken",
  "secret",
  "secrets",
  "securitycode",
  "session",
  "sessionid",
  "sid",
  "ssn",
  "token",
  "tokenkey",
  "tokens",
  "verificationcode",
  "xapikey",
  "xauthkey",
  "xauthtoken",
  "xcsrf",
  "xcsrfkey",
  "xcsrftoken",
  "xsrf",
  "xsrfkey",
  "xsrftoken",
  "xxsrf",
  "xxsrfkey",
  "xxsrftoken",
]);
const SAFE_CORRELATION_FIELD_NAMES = new Set([
  "id",
  "requestId",
  "requestIdSource",
  "sessionId",
  "sessionIdSource",
  "spanId",
  "traceId",
  "parentSpanId",
]);
const SAFE_CORRELATION_VALUE_FIELD_NAMES = new Set([
  "requestId",
  "requestIdSource",
  "sessionId",
  "sessionIdSource",
  "spanId",
  "traceId",
  "parentSpanId",
]);
const SAFE_METADATA_FIELD_NAMES = new Set([
  "bodySummary",
  "hrefSummary",
  "newValSummary",
  "oldValSummary",
  "payloadSummary",
  "textSummary",
  "valSummary",
  "valueSummary",
]);

function isSensitiveName(name: string | undefined): boolean {
  if (!name) return false;
  const lower = name.toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(lower)) return true;
  const normalized = name.replace(/([a-z])([A-Z])/g, "$1_$2");
  const compact = normalized.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (
    SENSITIVE_NAME_RE.test(name) ||
    PII_NAME_RE.test(name) ||
    SENSITIVE_NAME_RE.test(normalized) ||
    PII_NAME_RE.test(normalized) ||
    SENSITIVE_COMPACT_NAMES.has(compact)
  );
}
