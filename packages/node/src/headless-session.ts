import type { BugEvent } from "crumbtrail-core";

export interface HeadlessSessionOptions {
  endpoint: string;
  sessionId: string;
  metadata?: Record<string, unknown>;
  authToken?: string;
  fetchImpl?: typeof fetch;
}

export interface HeadlessSession {
  sessionId: string;
  record(events: BugEvent | BugEvent[]): Promise<void>;
  end(): Promise<Record<string, unknown>>;
}

/**
 * Thrown when an ingest request returns a non-2xx. Carries the HTTP `status` and,
 * when the response supplied a `Retry-After` header, a parsed `retryAfterMs` so a
 * caller can respect the server's backoff floor before retrying. (A transport
 * failure — TLS/DNS/connection refused — surfaces as the raw fetch rejection, not
 * this error, since there is no response to read a header from.)
 */
export class HeadlessRequestError extends Error {
  readonly status: number;
  readonly retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = "HeadlessRequestError";
    this.status = status;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

export async function startHeadlessSession(
  options: HeadlessSessionOptions,
): Promise<HeadlessSession> {
  const fetcher = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint.replace(/\/+$/, "");
  const headers = buildHeaders(options.authToken);
  await postJson(fetcher, `${endpoint}/api/session/start`, headers, {
    sessionId: options.sessionId,
    metadata: {
      ...options.metadata,
      source: "headless",
    },
  });

  return {
    sessionId: options.sessionId,
    async record(events) {
      const batch = Array.isArray(events) ? events : [events];
      await postJson(fetcher, `${endpoint}/api/events`, headers, {
        sessionId: options.sessionId,
        events: batch,
      });
    },
    async end() {
      return postJson(fetcher, `${endpoint}/api/session/end`, headers, {
        sessionId: options.sessionId,
      });
    },
  };
}

function buildHeaders(authToken: string | undefined): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(authToken ? { "x-crumbtrail-auth": authToken } : {}),
  };
}

async function postJson(
  fetcher: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetcher(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? (JSON.parse(text) as unknown) : {};
  } catch {
    parsed = { error: text || `HTTP ${response.status}` };
  }
  if (!response.ok) {
    const message =
      isRecord(parsed) && typeof parsed.error === "string"
        ? parsed.error
        : `HTTP ${response.status}`;
    throw new HeadlessRequestError(
      `Crumbtrail headless session request failed: ${message}`,
      response.status,
      parseRetryAfter(response.headers.get("retry-after")),
    );
  }
  return isRecord(parsed) ? parsed : {};
}

/**
 * Parse an HTTP `Retry-After` header into milliseconds. Supports both forms:
 * delta-seconds (`"120"`) and an HTTP date (`"Wed, 21 Oct 2026 07:28:00 GMT"`).
 * Returns undefined when absent or unparseable, and clamps negatives to 0.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
