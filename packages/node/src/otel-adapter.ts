import {
  REDACTED_VALUE,
  mergeRedactionMetadata,
  redactNetworkTextBody,
  redactValue,
  type BodyRedactionResult,
  type BugEvent,
  type RedactionMetadata,
  type RedactionResult,
} from "crumbtrail-core";
import {
  attributesToMap,
  unixNanoToMillis,
  type OtlpKeyValue,
} from "./otel-attributes";

export const OTEL_SPAN_EVENT = "backend.otel.span";
export const OTEL_LOG_EVENT = "backend.otel.log";
export const CRUMBTRAIL_SESSION_ATTRIBUTE = "crumbtrail.session.id";

const STATUS_CODE_MAP: Record<number, string> = {
  0: "UNSET",
  1: "OK",
  2: "ERROR",
};

export interface OtlpSpanEvent {
  timeUnixNano?: string | number;
  name?: string;
  attributes?: OtlpKeyValue[];
}

export interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string | number;
  endTimeUnixNano?: string | number;
  attributes?: OtlpKeyValue[];
  /**
   * Where an SDK's `recordException()` lands: a span event named "exception"
   * carrying exception.type, exception.message and exception.stacktrace. This
   * is the ONLY place most backends report a stacktrace, so ingesting only
   * span attributes left every backend error without a code location.
   */
  events?: OtlpSpanEvent[];
  status?: { code?: number; message?: string };
}

export interface OtlpScopeSpans {
  scope?: { name?: string; version?: string };
  spans?: OtlpSpan[];
}

export interface OtlpResourceSpans {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeSpans?: OtlpScopeSpans[];
}

export interface OtlpTraceRequest {
  resourceSpans?: OtlpResourceSpans[];
}

function readSessionId(attrs: Record<string, unknown>): string | undefined {
  const value = attrs[CRUMBTRAIL_SESSION_ATTRIBUTE];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readServiceName(attrs: Record<string, unknown>): string | undefined {
  const value = attrs["service.name"];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function publicResourceAttributes(
  attrs: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const entries = Object.entries(attrs).filter(
    ([key]) => key !== CRUMBTRAIL_SESSION_ATTRIBUTE,
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function redactAttributes(
  attrs: Record<string, unknown>,
  path: string,
): RedactionResult<Record<string, unknown>> {
  return redactValue(attrs, path);
}

function redactText(value: string, path: string): BodyRedactionResult {
  const result = redactNetworkTextBody(value, { path });
  return { ...result, body: result.body ?? REDACTED_VALUE };
}

/**
 * Upper bound on span events carried per span. A retry loop or a chatty tracer
 * can attach hundreds; the exception is what this exists for, and an unbounded
 * array would bloat every session artifact for no diagnostic gain.
 */
const MAX_SPAN_EVENTS = 32;

/**
 * Converts span events, redacting their attributes through the SAME boundary as
 * span attributes. This matters more here than elsewhere: an exception message
 * and stacktrace routinely quote the values that caused the failure, so
 * skipping redaction would make span events the one un-scrubbed channel in the
 * OTLP path.
 */
function convertSpanEvents(events: OtlpSpanEvent[] | undefined): {
  value: Array<Record<string, unknown>>;
  metadata: Array<RedactionMetadata | undefined>;
} {
  const value: Array<Record<string, unknown>> = [];
  const metadata: Array<RedactionMetadata | undefined> = [];

  for (const spanEvent of (events ?? []).slice(0, MAX_SPAN_EVENTS)) {
    const attrs = attributesToMap(spanEvent.attributes);
    const redacted = redactAttributes(attrs, "otel.span.event.attributes");
    metadata.push(redacted.metadata);

    const entry: Record<string, unknown> = {};
    const name =
      typeof spanEvent.name === "string" ? spanEvent.name : undefined;
    if (name) entry.name = name;
    const t = unixNanoToMillis(spanEvent.timeUnixNano);
    if (t !== undefined) entry.t = t;
    if (Object.keys(redacted.value).length > 0)
      entry.attributes = redacted.value;
    if (Object.keys(entry).length > 0) value.push(entry);
  }

  return { value, metadata };
}

export function convertOtlpTraceToEvents(
  payload: OtlpTraceRequest | undefined,
): BugEvent[] {
  const events: BugEvent[] = [];
  for (const rs of payload?.resourceSpans ?? []) {
    const resourceAttrs = attributesToMap(rs.resource?.attributes);
    const serviceName = readServiceName(resourceAttrs);
    const resourceSessionId = readSessionId(resourceAttrs);
    const redactedResourceAttrs = redactAttributes(
      publicResourceAttributes(resourceAttrs) ?? {},
      "otel.resource.attributes",
    );
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const startMs = unixNanoToMillis(span.startTimeUnixNano);
        const endMs = unixNanoToMillis(span.endTimeUnixNano);
        const t = startMs ?? Date.now();
        const spanAttrs = attributesToMap(span.attributes);
        const sessionId = readSessionId(spanAttrs) ?? resourceSessionId;
        const traceId =
          typeof span.traceId === "string" && span.traceId.length > 0
            ? span.traceId
            : undefined;
        const redactedSpanAttrs = redactAttributes(
          spanAttrs,
          "otel.span.attributes",
        );
        const redactedStatusMessage = span.status?.message
          ? redactText(span.status.message, "otel.span.statusMessage")
          : undefined;

        const d: Record<string, unknown> = {
          traceId,
          spanId:
            typeof span.spanId === "string" && span.spanId.length > 0
              ? span.spanId
              : undefined,
          parentSpanId:
            typeof span.parentSpanId === "string" &&
            span.parentSpanId.length > 0
              ? span.parentSpanId
              : undefined,
          name: typeof span.name === "string" ? span.name : undefined,
          kind: Number.isFinite(span.kind) ? span.kind : undefined,
          serviceName,
          statusCode: STATUS_CODE_MAP[span.status?.code ?? 0] ?? "UNSET",
          attributes: redactedSpanAttrs.value,
        };
        if (Object.keys(redactedResourceAttrs.value).length > 0)
          d.resourceAttributes = redactedResourceAttrs.value;
        if (redactedStatusMessage) d.statusMessage = redactedStatusMessage.body;
        const spanEvents = convertSpanEvents(span.events);
        if (spanEvents.value.length > 0) d.spanEvents = spanEvents.value;
        const redaction = mergeRedactionMetadata(
          redactedResourceAttrs.metadata,
          redactedSpanAttrs.metadata,
          redactedStatusMessage?.metadata,
          ...spanEvents.metadata,
        );
        if (redaction) d.redaction = redaction;
        if (startMs !== undefined && endMs !== undefined)
          d.durationMs = Math.max(0, endMs - startMs);
        if (traceId) d.requestId = traceId; // bridge to existing request-id correlation

        const event: BugEvent = { t, k: OTEL_SPAN_EVENT, d };
        if (sessionId) event.sessionId = sessionId;
        events.push(event);
      }
    }
  }
  return events;
}

export interface OtlpLogRecord {
  timeUnixNano?: string | number;
  observedTimeUnixNano?: string | number;
  severityText?: string;
  severityNumber?: number;
  body?: { stringValue?: string };
  traceId?: string;
  spanId?: string;
  attributes?: OtlpKeyValue[];
}

export interface OtlpScopeLogs {
  scope?: { name?: string };
  logRecords?: OtlpLogRecord[];
}

export interface OtlpResourceLogs {
  resource?: { attributes?: OtlpKeyValue[] };
  scopeLogs?: OtlpScopeLogs[];
}

export interface OtlpLogsRequest {
  resourceLogs?: OtlpResourceLogs[];
}

export function convertOtlpLogsToEvents(
  payload: OtlpLogsRequest | undefined,
): BugEvent[] {
  const events: BugEvent[] = [];
  for (const rl of payload?.resourceLogs ?? []) {
    const resourceAttrs = attributesToMap(rl.resource?.attributes);
    const serviceName = readServiceName(resourceAttrs);
    const resourceSessionId = readSessionId(resourceAttrs);
    const redactedResourceAttrs = redactAttributes(
      publicResourceAttributes(resourceAttrs) ?? {},
      "otel.resource.attributes",
    );
    for (const sl of rl.scopeLogs ?? []) {
      for (const log of sl.logRecords ?? []) {
        const t =
          unixNanoToMillis(log.timeUnixNano) ??
          unixNanoToMillis(log.observedTimeUnixNano) ??
          Date.now();
        const logAttrs = attributesToMap(log.attributes);
        const sessionId = readSessionId(logAttrs) ?? resourceSessionId;
        const traceId =
          typeof log.traceId === "string" && log.traceId.length > 0
            ? log.traceId
            : undefined;
        const redactedLogAttrs = redactAttributes(
          logAttrs,
          "otel.log.attributes",
        );
        const redactedBody =
          typeof log.body?.stringValue === "string"
            ? redactText(log.body.stringValue, "otel.log.body")
            : undefined;

        const d: Record<string, unknown> = {
          traceId,
          spanId:
            typeof log.spanId === "string" && log.spanId.length > 0
              ? log.spanId
              : undefined,
          severityText:
            typeof log.severityText === "string" ? log.severityText : undefined,
          severityNumber: Number.isFinite(log.severityNumber)
            ? log.severityNumber
            : undefined,
          serviceName,
          body: redactedBody?.body,
          attributes: redactedLogAttrs.value,
        };
        if (Object.keys(redactedResourceAttrs.value).length > 0)
          d.resourceAttributes = redactedResourceAttrs.value;
        const redaction = mergeRedactionMetadata(
          redactedResourceAttrs.metadata,
          redactedLogAttrs.metadata,
          redactedBody?.metadata,
        );
        if (redaction) d.redaction = redaction;
        if (traceId) d.requestId = traceId; // bridge to existing request-id correlation

        const event: BugEvent = { t, k: OTEL_LOG_EVENT, d };
        if (sessionId) event.sessionId = sessionId;
        events.push(event);
      }
    }
  }
  return events;
}
