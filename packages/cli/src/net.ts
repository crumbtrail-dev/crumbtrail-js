// Shared HTTP client for the networked wizard modules (auth / provision /
// verify). Every failure message carries method + URL so self-hosters can debug
// a bad endpoint. Transient failures (connection reset/refused, 5xx) are retried
// exactly once, per plans/cli-setup-wizard-design.md §4.

/**
 * Default cloud endpoint. The CLI talks to the dedicated API host, NOT the app
 * host — `app.crumbtrail.ai` serves the browser dashboard, `api.crumbtrail.ai`
 * serves the CLI/ingest API (both are the same service, split by Host header;
 * the API host never returns the SPA shell). This is the ONLY hardcoded
 * endpoint; `--endpoint` and CRUMBTRAIL_BASE_URL both override it. If this URL is
 * ever wrong, the fix is here — never guess elsewhere.
 */
export const DEFAULT_ENDPOINT = "https://api.crumbtrail.ai";

/**
 * Default browser dashboard host. The CLI hits the API host (DEFAULT_ENDPOINT),
 * but user-facing links — mint the key, open the dashboard, session deep-links —
 * must point at the app host, which is the one that serves the SPA shell.
 */
export const DEFAULT_APP_URL = "https://app.crumbtrail.ai";

/** Strip trailing slashes so `${base}/api/...` never doubles up. */
export function normalizeBase(base: string): string {
  return base.replace(/\/+$/, "");
}

/**
 * Map a resolved API base to the browser dashboard base for user-facing links.
 * Only the default cloud endpoint is rewritten (api → app host, which serves the
 * SPA); a custom `--endpoint` / CRUMBTRAIL_BASE_URL is returned unchanged, since
 * a self-host typically serves the API and dashboard from one origin.
 */
export function dashboardBase(base: string): string {
  return normalizeBase(base) === DEFAULT_ENDPOINT ? DEFAULT_APP_URL : base;
}

/**
 * Resolve the cloud endpoint. Precedence (binding orchestrator decision):
 *   --endpoint flag → CRUMBTRAIL_BASE_URL env → DEFAULT_ENDPOINT.
 * Returns the normalized base. `env` is injectable for tests.
 */
export function resolveEndpoint(
  flagEndpoint?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const chosen =
    (flagEndpoint && flagEndpoint.trim()) ||
    (env.CRUMBTRAIL_BASE_URL && env.CRUMBTRAIL_BASE_URL.trim()) ||
    DEFAULT_ENDPOINT;
  return normalizeBase(chosen);
}

export class ApiError extends Error {
  readonly status: number;
  /** Machine-readable `code` from the cloud jsonError envelope, when present. */
  readonly code?: string;
  /** Parsed JSON body, when the response carried one. */
  readonly body?: unknown;
  constructor(
    message: string,
    opts: { status: number; code?: string; body?: unknown },
  ) {
    super(message);
    this.name = "ApiError";
    this.status = opts.status;
    this.code = opts.code;
    this.body = opts.body;
  }
}

/** Network-layer failure (never got an HTTP status). Carries method+URL context. */
export class NetworkError extends Error {
  readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "NetworkError";
    this.cause = cause;
  }
}

function isTransient(err: unknown): boolean {
  const code =
    err && typeof err === "object" && "code" in err
      ? String((err as { code?: unknown }).code)
      : "";
  const causeCode =
    err &&
    typeof err === "object" &&
    "cause" in err &&
    (err as { cause?: unknown }).cause &&
    typeof (err as { cause?: unknown }).cause === "object" &&
    "code" in ((err as { cause: Record<string, unknown> }).cause as object)
      ? String(
          (
            (err as { cause: Record<string, unknown> }).cause as {
              code?: unknown;
            }
          ).code,
        )
      : "";
  return [code, causeCode].some((c) =>
    ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE"].includes(c),
  );
}

export interface RequestOptions {
  method?: string;
  /** Bearer token (CLI `bl_cli_…` or Supabase). */
  token?: string;
  /** JSON body — serialized and sent with application/json. */
  body?: unknown;
  /** Extra headers (e.g. the ingest X-Crumbtrail-Auth key). */
  headers?: Record<string, string>;
  /** Retry once on ECONNREFUSED/ECONNRESET/5xx (default true). */
  retry?: boolean;
  /** Injected fetch for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** AbortSignal for cancellable polls. */
  signal?: AbortSignal;
}

interface RawResponse {
  status: number;
  text: string;
}

async function rawRequest(
  method: string,
  url: string,
  opts: RequestOptions,
): Promise<RawResponse> {
  const doFetch = opts.fetchImpl ?? fetch;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let bodyInit: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = headers["content-type"] ?? "application/json";
    bodyInit = JSON.stringify(opts.body);
  }
  const res = await doFetch(url, {
    method,
    headers,
    body: bodyInit,
    signal: opts.signal,
  });
  const text = await res.text();
  return { status: res.status, text };
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Perform a JSON request against the cloud, applying the single-retry policy.
 * Resolves with the parsed body for 2xx; throws ApiError for a non-2xx status
 * and NetworkError when no response was obtained. Both carry method + URL.
 */
export async function requestJson<T = unknown>(
  url: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = (opts.method ?? "GET").toUpperCase();
  const retry = opts.retry !== false;
  const where = `${method} ${url}`;

  let raw: RawResponse;
  try {
    raw = await rawRequest(method, url, opts);
  } catch (err) {
    if (retry && isTransient(err)) {
      try {
        raw = await rawRequest(method, url, opts);
      } catch (err2) {
        throw new NetworkError(
          `Request failed (${where}): ${describe(err2)}`,
          err2,
        );
      }
    } else {
      throw new NetworkError(
        `Request failed (${where}): ${describe(err)}`,
        err,
      );
    }
  }

  // A 5xx is a transient server error — retry once too.
  if (raw.status >= 500 && retry) {
    try {
      raw = await rawRequest(method, url, opts);
    } catch (err) {
      throw new NetworkError(
        `Request failed (${where}): ${describe(err)}`,
        err,
      );
    }
  }

  const parsed = parseJson(raw.text);
  if (raw.status >= 200 && raw.status < 300) {
    return parsed as T;
  }
  const envelope =
    parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  const code = typeof envelope.code === "string" ? envelope.code : undefined;
  const errMsg =
    typeof envelope.error === "string"
      ? envelope.error
      : typeof envelope.message === "string"
        ? envelope.message
        : raw.text || "request failed";
  throw new ApiError(`${errMsg} (${where}) [${raw.status}]`, {
    status: raw.status,
    code,
    body: parsed,
  });
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
