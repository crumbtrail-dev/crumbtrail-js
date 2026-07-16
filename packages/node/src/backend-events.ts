import type { BugEvent, RedactionMetadata } from "crumbtrail-core";
import {
  CRUMBTRAIL_REQUEST_HEADER_LOWER as CORE_CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_SESSION_HEADER_LOWER as CORE_CRUMBTRAIL_SESSION_HEADER,
  W3C_TRACEPARENT_HEADER,
  attachRedactionMetadata,
  buildCaptureGapEvent,
  mergeRedactionMetadata,
  parseTraceparent,
  redactTokenLikeString,
  redactUrl,
} from "crumbtrail-core";

export const BACKEND_REQUEST_START_EVENT = "backend.req.start";
export const BACKEND_REQUEST_END_EVENT = "backend.req.end";
export const BACKEND_REQUEST_ERROR_EVENT = "backend.req.error";

export const CRUMBTRAIL_SESSION_HEADER = CORE_CRUMBTRAIL_SESSION_HEADER;
export const CRUMBTRAIL_REQUEST_HEADER = CORE_CRUMBTRAIL_REQUEST_HEADER;

const MAX_ID_LENGTH = 128;
const MAX_METHOD_LENGTH = 24;
const MAX_ROUTE_LENGTH = 256;
const MAX_ERROR_NAME_LENGTH = 120;
const MAX_ERROR_MESSAGE_LENGTH = 500;
const GENERATED_REQUEST_ID_PREFIX = "backend_req_";

type HeaderValue = string | number | readonly string[] | undefined;

export type BackendRequestHeaders = Record<string, HeaderValue>;

export type BackendCorrelationStatus =
  | "linked"
  | "missing-session"
  | "missing-request-id"
  | "generated-request-id"
  | "missing-session-and-request-id";

export type BackendCorrelationSource =
  "option" | "header" | "traceparent" | "generated" | "missing";

export interface BackendRequestEventInput {
  method?: string;
  url?: string;
  originalUrl?: string;
  path?: string;
  route?: string;
  headers?: BackendRequestHeaders;
  sessionId?: string;
  requestId?: string;
  sessionStartedAt?: number | Date;
  now?: number;
  /** Optional best-effort sink for completeness gaps discovered while resolving correlation. */
  emit?: (event: BugEvent) => void;
}

export interface BackendRequestEndEventInput extends BackendRequestEventInput {
  statusCode?: number;
  durationMs?: number;
}

export interface BackendRequestErrorEventInput extends BackendRequestEndEventInput {
  error: unknown;
}

export interface BackendRequestCorrelation {
  sessionId?: string;
  requestId: string;
  status: BackendCorrelationStatus;
  sessionIdSource: BackendCorrelationSource;
  requestIdSource: BackendCorrelationSource;
}

type Correlation = BackendRequestCorrelation;

/**
 * Resolves the inbound request correlation (sessionId + requestId) from the same request-scope
 * inputs the backend.req.* events use: the `X-Crumbtrail-Request-Id` / `X-Crumbtrail-Session-Id`
 * headers (the request id already equals the W3C trace id, set by the browser) or explicit
 * options. Reused by the `db/` module so a `db.diff` produced inside a request carries the SAME
 * requestId as that request's backend events — never a parallel correlation scheme.
 */
export function resolveBackendRequestCorrelation(
  input: BackendRequestEventInput,
): BackendRequestCorrelation {
  return resolveCorrelation(input);
}

interface SanitizedUrl {
  url?: string;
  pathname?: string;
  metadata?: RedactionMetadata;
}

interface SanitizedRoute {
  route?: string;
  truncated?: boolean;
  metadata?: RedactionMetadata;
}

interface SanitizedError {
  name: string;
  message: string;
  code?: string;
  statusCode?: number;
  metadata?: RedactionMetadata;
}

export function buildBackendRequestStartEvent(
  input: BackendRequestEventInput,
): BugEvent {
  const now = normalizeTimestamp(input.now);
  const correlation = resolveCorrelation(input);
  const payload = buildBasePayload(input, correlation);
  return buildEvent(
    BACKEND_REQUEST_START_EVENT,
    payload,
    now,
    input.sessionStartedAt,
    correlation.sessionId,
  );
}

export function buildBackendRequestEndEvent(
  input: BackendRequestEndEventInput,
): BugEvent {
  const now = normalizeTimestamp(input.now);
  const correlation = resolveCorrelation(input);
  const payload = buildBasePayload(input, correlation);
  if (Number.isFinite(input.statusCode)) payload.statusCode = input.statusCode;
  if (Number.isFinite(input.durationMs))
    payload.durationMs = Math.max(0, Math.round(input.durationMs as number));
  return buildEvent(
    BACKEND_REQUEST_END_EVENT,
    payload,
    now,
    input.sessionStartedAt,
    correlation.sessionId,
  );
}

export function buildBackendRequestErrorEvent(
  input: BackendRequestErrorEventInput,
): BugEvent {
  const now = normalizeTimestamp(input.now);
  const correlation = resolveCorrelation(input);
  const payload = buildBasePayload(input, correlation);
  if (Number.isFinite(input.statusCode)) payload.statusCode = input.statusCode;
  if (Number.isFinite(input.durationMs))
    payload.durationMs = Math.max(0, Math.round(input.durationMs as number));

  const error = sanitizeError(input.error);
  payload.error = omitMetadata(error);
  attachRedactionMetadata(payload, error.metadata);

  return buildEvent(
    BACKEND_REQUEST_ERROR_EVENT,
    payload,
    now,
    input.sessionStartedAt,
    correlation.sessionId,
  );
}

function buildEvent(
  kind: string,
  payload: Record<string, unknown>,
  now: number,
  sessionStartedAt: BackendRequestEventInput["sessionStartedAt"],
  sessionId?: string,
): BugEvent {
  const event: BugEvent = { t: now, k: kind, d: payload };
  if (sessionId) event.sessionId = sessionId;

  const startedAt = normalizeSessionStartedAt(sessionStartedAt);
  if (startedAt !== undefined) event.offsetMs = Math.max(0, now - startedAt);

  return event;
}

function buildBasePayload(
  input: BackendRequestEventInput,
  correlation: Correlation,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    requestId: correlation.requestId,
    correlation: {
      status: correlation.status,
      sessionIdSource: correlation.sessionIdSource,
      requestIdSource: correlation.requestIdSource,
    },
  };

  if (correlation.sessionId) payload.sessionId = correlation.sessionId;

  const method = sanitizeMethod(input.method);
  if (method) payload.method = method;

  const sanitizedUrl = sanitizeUrl(
    input.originalUrl ?? input.url ?? input.path,
  );
  if (sanitizedUrl.url) payload.url = sanitizedUrl.url;
  if (sanitizedUrl.pathname) payload.pathname = sanitizedUrl.pathname;

  const route = sanitizeRoute(input.route);
  if (route.route) {
    payload.route = route.route;
    if (route.truncated) payload.routeTruncated = true;
  }

  attachRedactionMetadata(payload, sanitizedUrl.metadata, route.metadata);

  return payload;
}

function resolveCorrelation(input: BackendRequestEventInput): Correlation {
  const headerSessionId = readHeader(input.headers, CRUMBTRAIL_SESSION_HEADER);
  const headerRequestId = readHeader(input.headers, CRUMBTRAIL_REQUEST_HEADER);
  const traceparent = parseTraceparent(
    readHeader(input.headers, W3C_TRACEPARENT_HEADER),
  );
  const optionSessionId = normalizeId(input.sessionId);
  const optionRequestId = normalizeId(input.requestId);

  const sessionId = optionSessionId ?? normalizeId(headerSessionId);
  const crumbtrailRequestId = optionRequestId ?? normalizeId(headerRequestId);
  const rawRequestId = crumbtrailRequestId ?? traceparent?.traceId;
  const requestId = rawRequestId ?? generateBackendRequestId();

  const sessionIdSource: BackendCorrelationSource = optionSessionId
    ? "option"
    : headerSessionId && sessionId
      ? "header"
      : "missing";
  const requestIdSource: BackendCorrelationSource = optionRequestId
    ? "option"
    : headerRequestId && rawRequestId
      ? "header"
      : traceparent && rawRequestId
        ? "traceparent"
        : "generated";

  let status: BackendCorrelationStatus;
  if (sessionId && rawRequestId) status = "linked";
  else if (sessionId && !rawRequestId) status = "generated-request-id";
  else if (!sessionId && rawRequestId) status = "missing-session";
  else status = "missing-session-and-request-id";

  if (traceparent && !sessionId) {
    emitCorrelationGap(input, {
      reason:
        !headerSessionId && !headerRequestId
          ? "header_stripped"
          : "missing_session_id",
      detail: "traceparent correlation",
    });
  }

  return { sessionId, requestId, status, sessionIdSource, requestIdSource };
}

function emitCorrelationGap(
  input: BackendRequestEventInput,
  gap: {
    reason: "missing_session_id" | "header_stripped";
    detail: string;
  },
): void {
  if (!input.emit) return;
  try {
    input.emit(
      buildCaptureGapEvent({
        surface: "backend_request",
        reason: gap.reason,
        detail: gap.detail,
        sessionId:
          normalizeId(input.sessionId) ??
          normalizeId(readHeader(input.headers, CRUMBTRAIL_SESSION_HEADER)),
        t: input.now,
        sessionStartedAt: input.sessionStartedAt,
      }),
    );
  } catch (error) {
    // Completeness reporting is best effort and cannot affect the application request.
    void error;
  }
}

function readHeader(
  headers: BackendRequestHeaders | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, rawValue] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value === undefined) return undefined;
    return String(value);
  }
  return undefined;
}

function normalizeId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, MAX_ID_LENGTH);
}

function generateBackendRequestId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return `${GENERATED_REQUEST_ID_PREFIX}${time}_${random}`.slice(
    0,
    MAX_ID_LENGTH,
  );
}

function sanitizeMethod(method: string | undefined): string | undefined {
  const normalized = method?.trim().toUpperCase();
  if (!normalized) return undefined;
  return normalized.replace(/[^A-Z0-9_-]/g, "").slice(0, MAX_METHOD_LENGTH);
}

function sanitizeUrl(rawUrl: string | undefined): SanitizedUrl {
  const url = rawUrl?.trim();
  if (!url) return {};

  const redacted = redactUrl(url, "url");
  const pathname = extractPathname(url);
  return {
    url: redacted.value,
    ...(pathname ? { pathname } : {}),
    ...(redacted.metadata ? { metadata: redacted.metadata } : {}),
  };
}

function extractPathname(rawUrl: string): string | undefined {
  try {
    const parsed = /^[a-z][a-z\d+.-]*:/i.test(rawUrl)
      ? new URL(rawUrl)
      : new URL(
          rawUrl.startsWith("/") ? rawUrl : `/${rawUrl}`,
          "http://crumbtrail.local",
        );
    return parsed.pathname || "/";
  } catch {
    const withoutHash = rawUrl.split("#", 1)[0] ?? rawUrl;
    const withoutQuery = withoutHash.split("?", 1)[0] ?? withoutHash;
    return withoutQuery.startsWith("/") ? withoutQuery : `/${withoutQuery}`;
  }
}

function sanitizeRoute(rawRoute: string | undefined): SanitizedRoute {
  const route = rawRoute?.trim();
  if (!route) return {};

  const tokenResult = redactTokenLikeString(route, "route");
  const truncated = tokenResult.value.length > MAX_ROUTE_LENGTH;
  const bounded = truncated
    ? `${tokenResult.value.slice(0, MAX_ROUTE_LENGTH)}…`
    : tokenResult.value;

  const metadata = truncated
    ? mergeRedactionMetadata(tokenResult.metadata, {
        policy: "crumbtrail.browser-redaction.v1",
        fields: [
          { path: "route", reason: "route_too_long", action: "summarized" },
        ],
      })
    : tokenResult.metadata;

  return {
    route: bounded,
    ...(truncated ? { truncated } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function sanitizeError(error: unknown): SanitizedError {
  const errorRecord = isRecord(error) ? error : undefined;
  const name = sanitizeErrorText(
    typeof errorRecord?.name === "string"
      ? errorRecord.name
      : error instanceof Error
        ? error.name
        : typeof error,
    MAX_ERROR_NAME_LENGTH,
    "error.name",
  );
  const message = sanitizeErrorText(
    typeof errorRecord?.message === "string"
      ? errorRecord.message
      : error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Non-Error thrown",
    MAX_ERROR_MESSAGE_LENGTH,
    "error.message",
  );

  const code =
    typeof errorRecord?.code === "string"
      ? sanitizeErrorText(errorRecord.code, MAX_ERROR_NAME_LENGTH, "error.code")
      : undefined;
  const statusCode =
    typeof errorRecord?.statusCode === "number"
      ? errorRecord.statusCode
      : typeof errorRecord?.status === "number"
        ? errorRecord.status
        : undefined;
  const metadata = mergeRedactionMetadata(
    name.metadata,
    message.metadata,
    code?.metadata,
  );

  return {
    name: name.value || "Error",
    message: message.value || "Error",
    ...(code?.value ? { code: code.value } : {}),
    ...(Number.isFinite(statusCode) ? { statusCode } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function sanitizeErrorText(
  value: string,
  maxLength: number,
  path: string,
): { value: string; metadata?: RedactionMetadata } {
  const tokenResult = redactTokenLikeString(value, path);
  if (tokenResult.value.length <= maxLength) return tokenResult;

  const truncated = `${tokenResult.value.slice(0, maxLength)}…`;
  const metadata = mergeRedactionMetadata(tokenResult.metadata, {
    policy: "crumbtrail.browser-redaction.v1",
    fields: [{ path, reason: "error_field_too_long", action: "summarized" }],
  });

  return { value: truncated, metadata };
}

function omitMetadata<T extends { metadata?: RedactionMetadata }>(
  value: T,
): Omit<T, "metadata"> {
  const { metadata: _metadata, ...rest } = value;
  return rest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function normalizeTimestamp(now: number | undefined): number {
  return Number.isFinite(now) ? Math.round(now as number) : Date.now();
}

function normalizeSessionStartedAt(
  startedAt: BackendRequestEventInput["sessionStartedAt"],
): number | undefined {
  if (startedAt instanceof Date) {
    const time = startedAt.getTime();
    return Number.isFinite(time) ? time : undefined;
  }
  return Number.isFinite(startedAt)
    ? Math.round(startedAt as number)
    : undefined;
}
