import type { EventBus } from "../event-bus";
import type {
  CrumbtrailConfig,
  CollectorCleanup,
  CollectorContext,
} from "../types";
import {
  attachRedactionMetadata,
  redactHeaders,
  redactNetworkTextBody,
  redactUrl,
  summarizeBinaryPayload,
  summarizeOmittedPayload,
  type BodyRedactionResult,
  type RedactionMetadata,
} from "../redaction";
import {
  CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_SESSION_HEADER,
  W3C_TRACEPARENT_HEADER,
  canInjectCorrelationHeaders,
  resolveOutboundCorrelation,
} from "../correlation";
import { now } from "../utils";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

let nextId = 1;

const BINARY_CONTENT_TYPES = ["octet-stream", "image/", "audio/", "video/"];

/** Live map of in-flight requests, snapshotted at flag time via the `network.pending` state provider. */
type PendingRequestMap = Map<
  number,
  { method: string; url: string; startTime: number }
>;

/* ------------------------------------------------------------------ */
/* Body deduplication                                                  */
/* ------------------------------------------------------------------ */

const DEDUP_MAP_MAX = 1000;

// key = url + ":" + hash(body), value = first-seen timestamp (string)
const dedupMap = new Map<string, string>();

function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return h >>> 0; // unsigned 32-bit
}

function clearDedupMap(): void {
  dedupMap.clear();
}

/**
 * Checks whether this url+body combo was seen before.
 * - If new: stores it and returns undefined (caller emits normally).
 * - If duplicate: returns { ref, dedup } to replace the body field.
 */
function checkDedup(
  url: string,
  body: unknown,
  timestamp: string,
): { ref: string; dedup: true } | undefined {
  if (body == null || typeof body !== "string") return undefined;

  const key = url + ":" + djb2(url + body);

  if (dedupMap.has(key)) {
    return { ref: dedupMap.get(key)!, dedup: true };
  }

  // Evict oldest entry when cap is reached
  if (dedupMap.size >= DEDUP_MAP_MAX) {
    const oldest = dedupMap.keys().next().value;
    if (oldest !== undefined) dedupMap.delete(oldest);
  }

  dedupMap.set(key, timestamp);
  return undefined;
}

function isBinaryContentType(ct: string): boolean {
  const lower = ct.toLowerCase();
  return BINARY_CONTENT_TYPES.some((t) => lower.includes(t));
}

function isSSE(ct: string): boolean {
  return ct.toLowerCase().includes("text/event-stream");
}

function shouldExclude(url: string, config: CrumbtrailConfig): boolean {
  if (config.httpEndpoint && url.includes(config.httpEndpoint)) return true;
  return config.networkExcludeUrls.some((pattern) => url.includes(pattern));
}

function headersToRecord(
  headers: HeadersInit | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;

  const result: Record<string, string> = {};

  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      result[key] = value;
    });
  } else if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      result[key] = value;
    }
  } else {
    return headers as Record<string, string>;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function responseHeadersToRecord(
  response: Response,
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    result[key] = value;
  });
  return Object.keys(result).length > 0 ? result : undefined;
}

function extractUrlString(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return String(input);
}

function extractMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) return init.method.toUpperCase();
  if (input instanceof Request) return input.method.toUpperCase();
  return "GET";
}

function extractRequestBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): { body?: string; nonText: boolean } {
  const body =
    init?.body ?? (input instanceof Request ? input.body : undefined);
  if (body == null) return { nonText: false };
  if (typeof body === "string") return { body, nonText: false };
  return { nonText: true };
}

function getHeaderValue(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

function headersToInit(
  input: RequestInfo | URL,
  init?: RequestInit,
): Headers | undefined {
  try {
    if (init?.headers !== undefined) return new Headers(init.headers);
    if (input instanceof Request) return new Headers(input.headers);
    return undefined;
  } catch {
    return undefined;
  }
}

function headersToWritableInit(
  input: RequestInfo | URL,
  init?: RequestInit,
): Headers {
  return headersToInit(input, init) ?? new Headers();
}

function buildFetchArgsWithHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  headers: Headers,
): [RequestInfo | URL, RequestInit | undefined] {
  return [input, { ...init, headers }];
}

function applyFetchCorrelationHeaders(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  config: CrumbtrailConfig,
  context?: CollectorContext,
): {
  input: RequestInfo | URL;
  init?: RequestInit;
  requestHeaders?: Record<string, string>;
  sessionId?: string;
  requestId?: string;
  traceId?: string;
  spanId?: string;
} {
  const existingHeaders = headersToInit(input, init);
  const url = extractUrlString(input);

  if (
    !config.networkCorrelationHeaders ||
    !canInjectCorrelationHeaders(url, config.networkCorrelationAllowedOrigins)
  ) {
    return { input, init, requestHeaders: headersToRecord(existingHeaders) };
  }

  const sessionId =
    existingHeaders?.get(CRUMBTRAIL_SESSION_HEADER) ?? context?.sessionId;
  if (!sessionId) {
    return { input, init, requestHeaders: headersToRecord(existingHeaders) };
  }

  try {
    const headers = headersToWritableInit(input, init);
    const existingSessionId = headers.get(CRUMBTRAIL_SESSION_HEADER);
    const existingRequestId = headers.get(CRUMBTRAIL_REQUEST_HEADER);
    const existingTraceparent = headers.get(W3C_TRACEPARENT_HEADER);
    const correlation = resolveOutboundCorrelation({
      sessionId: existingSessionId ?? sessionId,
      existingRequestId: existingRequestId ?? undefined,
      existingTraceparent: existingTraceparent ?? undefined,
    });

    if (!existingSessionId)
      headers.set(CRUMBTRAIL_SESSION_HEADER, correlation.sessionId);
    if (!existingRequestId)
      headers.set(CRUMBTRAIL_REQUEST_HEADER, correlation.requestId);
    if (!existingTraceparent)
      headers.set(W3C_TRACEPARENT_HEADER, correlation.traceparent);

    const [nextInput, nextInit] = buildFetchArgsWithHeaders(
      input,
      init,
      headers,
    );
    return {
      input: nextInput,
      init: nextInit,
      requestHeaders: headersToRecord(headers),
      sessionId: correlation.sessionId,
      requestId: correlation.requestId,
      traceId: correlation.traceId,
      spanId: correlation.spanId,
    };
  } catch {
    return { input, init, requestHeaders: headersToRecord(existingHeaders) };
  }
}

function applyBodyResult(
  target: Record<string, unknown>,
  result: BodyRedactionResult,
): void {
  if (result.body !== undefined) target.body = result.body;
  if (result.bodySummary) target.bodySummary = result.bodySummary;
}

/* ------------------------------------------------------------------ */
/* Fetch wrapper                                                       */
/* ------------------------------------------------------------------ */

function wrapFetch(
  bus: EventBus,
  config: CrumbtrailConfig,
  originalFetch: typeof globalThis.fetch,
  context: CollectorContext | undefined,
  pending: PendingRequestMap,
): typeof globalThis.fetch {
  return async function instrumentedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const url = extractUrlString(input);

    if (shouldExclude(url, config)) {
      return originalFetch(input, init);
    }

    const id = nextId++;
    const method = extractMethod(input, init);
    const startTime = now();
    const fetchArgs = applyFetchCorrelationHeaders(
      input,
      init,
      config,
      context,
    );

    const urlResult = redactUrl(url, "url");
    const reqMetadata: Array<RedactionMetadata | undefined> = [
      urlResult.metadata,
    ];
    const reqData: Record<string, unknown> = {
      id,
      method,
      url: urlResult.value,
    };
    if (fetchArgs.sessionId) reqData.sessionId = fetchArgs.sessionId;
    if (fetchArgs.requestId) reqData.requestId = fetchArgs.requestId;
    if (fetchArgs.traceId) reqData.traceId = fetchArgs.traceId;
    if (fetchArgs.spanId) reqData.spanId = fetchArgs.spanId;

    const requestHeaders = config.networkCaptureHeaders
      ? fetchArgs.requestHeaders
      : undefined;
    if (requestHeaders) {
      const headersResult = redactHeaders(requestHeaders, "hdrs");
      reqData.hdrs = headersResult.value;
      reqMetadata.push(headersResult.metadata);
    }

    const requestBody = extractRequestBody(input, init);
    if (requestBody.body !== undefined) {
      const bodyResult = redactNetworkTextBody(requestBody.body, {
        contentType: getHeaderValue(requestHeaders, "content-type"),
        maxLength: config.networkMaxBodySize,
        path: "body",
      });
      applyBodyResult(reqData, bodyResult);
      reqMetadata.push(bodyResult.metadata);
    } else if (requestBody.nonText) {
      const bodyResult = summarizeOmittedPayload(
        "non_text_request_body",
        "body",
      );
      applyBodyResult(reqData, bodyResult);
      reqMetadata.push(bodyResult.metadata);
    }

    attachRedactionMetadata(reqData, ...reqMetadata);

    bus.emit({ t: startTime, k: "net.req", d: reqData });

    pending.set(id, { method, url: urlResult.value, startTime });
    let response: Response;
    try {
      response = await originalFetch(fetchArgs.input, fetchArgs.init);
    } catch (error) {
      // Network-level failure (offline, DNS, CORS, abort): there is no Response,
      // so emit a net.err carrying the request identity instead of a net.res.
      const errData: Record<string, unknown> = {
        id,
        method,
        url: urlResult.value,
        dur: now() - startTime,
        msg: error instanceof Error ? error.message : String(error),
        transport: "fetch",
      };
      if (error instanceof Error && error.name && error.name !== "Error")
        errData.name = error.name;
      if (fetchArgs.sessionId) errData.sessionId = fetchArgs.sessionId;
      if (fetchArgs.requestId) errData.requestId = fetchArgs.requestId;
      if (fetchArgs.traceId) errData.traceId = fetchArgs.traceId;
      if (fetchArgs.spanId) errData.spanId = fetchArgs.spanId;
      attachRedactionMetadata(errData, urlResult.metadata);
      bus.emit({ t: now(), k: "net.err", d: errData });
      throw error;
    } finally {
      pending.delete(id);
    }
    const dur = now() - startTime;

    const resMetadata: Array<RedactionMetadata | undefined> = [];
    const resData: Record<string, unknown> = { id, st: response.status, dur };
    if (fetchArgs.sessionId) resData.sessionId = fetchArgs.sessionId;
    if (fetchArgs.requestId) resData.requestId = fetchArgs.requestId;
    if (fetchArgs.traceId) resData.traceId = fetchArgs.traceId;
    if (fetchArgs.spanId) resData.spanId = fetchArgs.spanId;

    if (config.networkCaptureHeaders) {
      const hdrs = responseHeadersToRecord(response);
      if (hdrs) {
        const headersResult = redactHeaders(hdrs, "hdrs");
        resData.hdrs = headersResult.value;
        resMetadata.push(headersResult.metadata);
      }
    }

    const contentType = response.headers.get("content-type") ?? "";

    if (isSSE(contentType)) {
      const bodyResult = summarizeOmittedPayload("stream_payload", "body");
      applyBodyResult(resData, bodyResult);
      resMetadata.push(bodyResult.metadata);
    } else if (isBinaryContentType(contentType)) {
      const bodyResult = summarizeBinaryPayload(
        contentType,
        response.headers.get("content-length"),
        "body",
      );
      applyBodyResult(resData, bodyResult);
      resMetadata.push(bodyResult.metadata);
    } else {
      try {
        const cloned = response.clone();
        const text = await cloned.text();
        if (text) {
          const bodyResult = redactNetworkTextBody(text, {
            contentType,
            maxLength: config.networkMaxBodySize,
            path: "body",
          });
          if (bodyResult.body !== undefined) {
            const ts = String(now());
            const dedupResult = checkDedup(
              urlResult.value,
              bodyResult.body,
              ts,
            );
            if (dedupResult) {
              resData.body = dedupResult;
              resData.dedup = true;
            } else {
              resData.body = bodyResult.body;
            }
          }
          if (bodyResult.bodySummary)
            resData.bodySummary = bodyResult.bodySummary;
          resMetadata.push(bodyResult.metadata);
        }
      } catch {
        const bodyResult = summarizeOmittedPayload("body_read_failed", "body");
        applyBodyResult(resData, bodyResult);
        resMetadata.push(bodyResult.metadata);
      }
    }

    attachRedactionMetadata(resData, ...resMetadata);

    bus.emit({ t: now(), k: "net.res", d: resData });

    return response;
  };
}

/* ------------------------------------------------------------------ */
/* XHR wrapper                                                         */
/* ------------------------------------------------------------------ */

function wrapXHR(
  bus: EventBus,
  config: CrumbtrailConfig,
  xhrPrototype: typeof XMLHttpRequest.prototype,
  context: CollectorContext | undefined,
  pending: PendingRequestMap,
): {
  origOpen: typeof XMLHttpRequest.prototype.open;
  origSend: typeof XMLHttpRequest.prototype.send;
  origSetRequestHeader: typeof XMLHttpRequest.prototype.setRequestHeader;
} {
  const origOpen = xhrPrototype.open;
  const origSend = xhrPrototype.send;
  const origSetRequestHeader = xhrPrototype.setRequestHeader;

  // Metadata stored per-instance via WeakMap
  const xhrMeta = new WeakMap<
    XMLHttpRequest,
    {
      id: number;
      method: string;
      url: string;
      startTime: number;
      excluded: boolean;
      requestHeaders: Record<string, string>;
      sessionId?: string;
      requestId?: string;
      traceId?: string;
      spanId?: string;
    }
  >();

  xhrPrototype.open = function (
    method: string,
    url: string | URL,
    ...rest: unknown[]
  ) {
    const urlStr = typeof url === "string" ? url : url.toString();
    const excluded = shouldExclude(urlStr, config);

    xhrMeta.set(this, {
      id: nextId++,
      method: method.toUpperCase(),
      url: urlStr,
      startTime: 0,
      excluded,
      requestHeaders: {},
    });

    return (
      origOpen as unknown as (
        this: XMLHttpRequest,
        method: string,
        url: string | URL,
        ...args: unknown[]
      ) => void
    ).call(this, method, url, ...rest);
  };

  // Intercept setRequestHeader to track request headers
  xhrPrototype.setRequestHeader = function (name: string, value: string) {
    const meta = xhrMeta.get(this);
    if (meta) {
      meta.requestHeaders[name] = value;
    }
    return origSetRequestHeader.call(this, name, value);
  };

  xhrPrototype.send = function (
    body?: Document | XMLHttpRequestBodyInit | null,
  ) {
    const meta = xhrMeta.get(this);
    if (!meta || meta.excluded) {
      return origSend.call(this, body);
    }

    if (
      config.networkCorrelationHeaders &&
      canInjectCorrelationHeaders(
        meta.url,
        config.networkCorrelationAllowedOrigins,
      )
    ) {
      const existingSessionId = getHeaderValue(
        meta.requestHeaders,
        CRUMBTRAIL_SESSION_HEADER,
      );
      const existingRequestId = getHeaderValue(
        meta.requestHeaders,
        CRUMBTRAIL_REQUEST_HEADER,
      );
      const existingTraceparent = getHeaderValue(
        meta.requestHeaders,
        W3C_TRACEPARENT_HEADER,
      );
      const sessionId = existingSessionId ?? context?.sessionId;

      if (sessionId) {
        const correlation = resolveOutboundCorrelation({
          sessionId,
          existingRequestId,
          existingTraceparent,
        });

        meta.sessionId = correlation.sessionId;
        meta.requestId = correlation.requestId;
        meta.traceId = correlation.traceId;
        meta.spanId = correlation.spanId;

        if (!existingSessionId) {
          try {
            origSetRequestHeader.call(
              this,
              CRUMBTRAIL_SESSION_HEADER,
              meta.sessionId,
            );
            meta.requestHeaders[CRUMBTRAIL_SESSION_HEADER] = meta.sessionId;
          } catch {
            meta.sessionId = undefined;
          }
        }

        if (!existingRequestId) {
          try {
            origSetRequestHeader.call(
              this,
              CRUMBTRAIL_REQUEST_HEADER,
              meta.requestId,
            );
            meta.requestHeaders[CRUMBTRAIL_REQUEST_HEADER] = meta.requestId;
          } catch {
            meta.requestId = undefined;
          }
        }

        if (!existingTraceparent) {
          try {
            origSetRequestHeader.call(
              this,
              W3C_TRACEPARENT_HEADER,
              correlation.traceparent,
            );
            meta.requestHeaders[W3C_TRACEPARENT_HEADER] =
              correlation.traceparent;
          } catch {
            meta.traceId = undefined;
            meta.spanId = undefined;
          }
        }
      }
    }

    meta.startTime = now();

    const urlResult = redactUrl(meta.url, "url");
    const reqMetadata: Array<RedactionMetadata | undefined> = [
      urlResult.metadata,
    ];
    const reqData: Record<string, unknown> = {
      id: meta.id,
      method: meta.method,
      url: urlResult.value,
    };
    if (meta.sessionId) reqData.sessionId = meta.sessionId;
    if (meta.requestId) reqData.requestId = meta.requestId;
    if (meta.traceId) reqData.traceId = meta.traceId;
    if (meta.spanId) reqData.spanId = meta.spanId;

    if (
      config.networkCaptureHeaders &&
      Object.keys(meta.requestHeaders).length > 0
    ) {
      const headersResult = redactHeaders({ ...meta.requestHeaders }, "hdrs");
      reqData.hdrs = headersResult.value;
      reqMetadata.push(headersResult.metadata);
    }

    if (body != null && typeof body === "string") {
      const bodyResult = redactNetworkTextBody(body, {
        contentType: getHeaderValue(meta.requestHeaders, "content-type"),
        maxLength: config.networkMaxBodySize,
        path: "body",
      });
      applyBodyResult(reqData, bodyResult);
      reqMetadata.push(bodyResult.metadata);
    } else if (body != null) {
      const bodyResult = summarizeOmittedPayload(
        "non_text_request_body",
        "body",
      );
      applyBodyResult(reqData, bodyResult);
      reqMetadata.push(bodyResult.metadata);
    }

    attachRedactionMetadata(reqData, ...reqMetadata);

    bus.emit({ t: meta.startTime, k: "net.req", d: reqData });

    const emitResponse = () => {
      const dur = now() - meta.startTime;
      const resMetadata: Array<RedactionMetadata | undefined> = [];
      const resData: Record<string, unknown> = {
        id: meta.id,
        st: this.status,
        dur,
      };
      if (meta.sessionId) resData.sessionId = meta.sessionId;
      if (meta.requestId) resData.requestId = meta.requestId;
      if (meta.traceId) resData.traceId = meta.traceId;
      if (meta.spanId) resData.spanId = meta.spanId;

      if (config.networkCaptureHeaders) {
        const rawHeaders = this.getAllResponseHeaders();
        if (rawHeaders) {
          const hdrs: Record<string, string> = {};
          rawHeaders
            .split("\r\n")
            .filter(Boolean)
            .forEach((line: string) => {
              const idx = line.indexOf(": ");
              if (idx > -1) {
                hdrs[line.slice(0, idx)] = line.slice(idx + 2);
              }
            });
          if (Object.keys(hdrs).length > 0) {
            const headersResult = redactHeaders(hdrs, "hdrs");
            resData.hdrs = headersResult.value;
            resMetadata.push(headersResult.metadata);
          }
        }
      }

      const contentType = this.getResponseHeader("content-type") ?? "";

      if (isSSE(contentType)) {
        const bodyResult = summarizeOmittedPayload("stream_payload", "body");
        applyBodyResult(resData, bodyResult);
        resMetadata.push(bodyResult.metadata);
      } else if (isBinaryContentType(contentType)) {
        const bodyResult = summarizeBinaryPayload(
          contentType,
          this.getResponseHeader("content-length"),
          "body",
        );
        applyBodyResult(resData, bodyResult);
        resMetadata.push(bodyResult.metadata);
      } else {
        const text = this.responseText;
        if (text) {
          const bodyResult = redactNetworkTextBody(text, {
            contentType,
            maxLength: config.networkMaxBodySize,
            path: "body",
          });
          if (bodyResult.body !== undefined) {
            const ts = String(now());
            const dedupResult = checkDedup(
              urlResult.value,
              bodyResult.body,
              ts,
            );
            if (dedupResult) {
              resData.body = dedupResult;
              resData.dedup = true;
            } else {
              resData.body = bodyResult.body;
            }
          }
          if (bodyResult.bodySummary)
            resData.bodySummary = bodyResult.bodySummary;
          resMetadata.push(bodyResult.metadata);
        }
      }

      attachRedactionMetadata(resData, ...resMetadata);

      bus.emit({ t: now(), k: "net.res", d: resData });
    };

    // error/timeout/abort settle the XHR without an HTTP response (status 0),
    // so they emit a net.err carrying the request identity instead of a net.res.
    const emitFailure = (msg: string, name?: string) => {
      const errData: Record<string, unknown> = {
        id: meta.id,
        method: meta.method,
        url: urlResult.value,
        dur: now() - meta.startTime,
        msg,
        transport: "xhr",
      };
      if (name) errData.name = name;
      if (meta.sessionId) errData.sessionId = meta.sessionId;
      if (meta.requestId) errData.requestId = meta.requestId;
      if (meta.traceId) errData.traceId = meta.traceId;
      if (meta.spanId) errData.spanId = meta.spanId;
      attachRedactionMetadata(errData, urlResult.metadata);
      bus.emit({ t: now(), k: "net.err", d: errData });
    };

    this.addEventListener("load", emitResponse);
    this.addEventListener("error", () => emitFailure("network error"));
    this.addEventListener("timeout", () =>
      emitFailure("request timed out", "TimeoutError"),
    );
    this.addEventListener("abort", () =>
      emitFailure("request aborted", "AbortError"),
    );

    pending.set(meta.id, {
      method: meta.method,
      url: urlResult.value,
      startTime: meta.startTime,
    });
    // loadend fires after load/error/timeout/abort — covers every way an XHR settles.
    this.addEventListener("loadend", () => pending.delete(meta.id));

    return origSend.call(this, body);
  };

  return { origOpen, origSend, origSetRequestHeader };
}

/* ------------------------------------------------------------------ */
/* Collector export                                                     */
/* ------------------------------------------------------------------ */

export function networkCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
  context?: CollectorContext,
): CollectorCleanup {
  const originalFetch = globalThis.fetch;
  const shouldPatchFetch = typeof originalFetch === "function";

  const xhrPrototype = globalThis.XMLHttpRequest?.prototype;
  const shouldPatchXHR = Boolean(
    xhrPrototype &&
    typeof xhrPrototype.open === "function" &&
    typeof xhrPrototype.send === "function" &&
    typeof xhrPrototype.setRequestHeader === "function",
  );

  const pending: PendingRequestMap = new Map();

  const originalXHRMethods = shouldPatchXHR
    ? wrapXHR(bus, config, xhrPrototype, context, pending)
    : undefined;

  if (shouldPatchFetch) {
    globalThis.fetch = wrapFetch(bus, config, originalFetch, context, pending);
  }

  const unregisterPendingProvider = context?.registerStateProvider?.(
    "network.pending",
    () =>
      Array.from(pending.values()).map((request) => ({
        method: request.method,
        url: request.url,
        ageMs: now() - request.startTime,
      })),
  );

  return () => {
    if (shouldPatchFetch) {
      globalThis.fetch = originalFetch;
    }

    if (shouldPatchXHR && originalXHRMethods) {
      xhrPrototype.open = originalXHRMethods.origOpen;
      xhrPrototype.send = originalXHRMethods.origSend;
      xhrPrototype.setRequestHeader = originalXHRMethods.origSetRequestHeader;
    }

    unregisterPendingProvider?.();
    pending.clear();
    clearDedupMap();
  };
}
