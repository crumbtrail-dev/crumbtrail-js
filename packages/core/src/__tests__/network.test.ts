import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent, CrumbtrailConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import { networkCollector } from "../collectors/network";
import {
  CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_SESSION_HEADER,
  W3C_TRACEPARENT_HEADER,
  parseTraceparent,
} from "../correlation";

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function makeConfig(
  overrides: Partial<CrumbtrailConfig> = {},
): CrumbtrailConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function collect(
  config?: Partial<CrumbtrailConfig>,
  sessionId = "sess_test_123",
) {
  const events: BugEvent[] = [];
  const bus = new EventBus();
  const configWithBackendAllowlist =
    config?.networkCorrelationHeaders === true &&
    config.networkCorrelationAllowedOrigins === undefined
      ? {
          networkCorrelationAllowedOrigins: ["https://api.example.com"],
          ...config,
        }
      : config;
  bus.subscribe((batch) => events.push(...batch));
  const cleanup = networkCollector(
    bus,
    makeConfig(configWithBackendAllowlist),
    { sessionId },
  );
  return { events, bus, cleanup, sessionId };
}

function getMockFetchHeaders(
  fetchMock: ReturnType<typeof vi.fn>,
  callIndex = 0,
): Headers {
  const [input, init] = fetchMock.mock.calls[callIndex] as [
    RequestInfo | URL,
    RequestInit | undefined,
  ];
  if (init?.headers !== undefined) return new Headers(init.headers);
  if (input instanceof Request) return new Headers(input.headers);
  return new Headers();
}

/* ------------------------------------------------------------------ */
/* Mock XMLHttpRequest                                                 */
/* ------------------------------------------------------------------ */

class MockXHR {
  static instances: MockXHR[] = [];

  method = "";
  url = "";
  requestHeaders: Record<string, string> = {};
  status = 200;
  responseText = "";
  readyState = 0;
  _listeners: Record<string, Function[]> = {};
  _responseHeaders: Record<string, string> = {};

  constructor() {
    MockXHR.instances.push(this);
  }

  open(method: string, url: string | URL) {
    this.method = method;
    this.url = typeof url === "string" ? url : url.toString();
  }

  setRequestHeader(name: string, value: string) {
    this.requestHeaders[name] = value;
  }

  send(body?: Document | XMLHttpRequestBodyInit | null) {
    // Simulate async load after microtask
  }

  addEventListener(event: string, fn: Function) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }

  removeEventListener(event: string, fn: Function) {
    if (this._listeners[event]) {
      this._listeners[event] = this._listeners[event].filter((f) => f !== fn);
    }
  }

  getResponseHeader(name: string): string | null {
    return this._responseHeaders[name.toLowerCase()] ?? null;
  }

  getAllResponseHeaders(): string {
    return Object.entries(this._responseHeaders)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");
  }

  // Test helper: simulate a successful response
  _respond(status: number, body: string, headers: Record<string, string> = {}) {
    this.status = status;
    this.responseText = body;
    this.readyState = 4;
    this._responseHeaders = Object.fromEntries(
      Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    for (const fn of this._listeners["load"] ?? []) {
      fn();
    }
  }

  _error() {
    this.status = 0;
    for (const fn of this._listeners["error"] ?? []) {
      fn();
    }
  }

  _timeout() {
    this.status = 0;
    for (const fn of this._listeners["timeout"] ?? []) {
      fn();
    }
  }

  _abort() {
    this.status = 0;
    for (const fn of this._listeners["abort"] ?? []) {
      fn();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Setup / teardown                                                    */
/* ------------------------------------------------------------------ */

let originalFetch: typeof globalThis.fetch;
let originalXHR: typeof globalThis.XMLHttpRequest;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  originalXHR = globalThis.XMLHttpRequest;
  MockXHR.instances = [];

  // Provide a mock XMLHttpRequest so tests don't depend on happy-dom's
  globalThis.XMLHttpRequest = MockXHR as unknown as typeof XMLHttpRequest;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  globalThis.XMLHttpRequest = originalXHR;
});

/* ================================================================== */
/* Fetch tests                                                         */
/* ================================================================== */

describe("networkCollector — fetch", () => {
  it("emits net.req and net.res events with correct fields", async () => {
    const mockResponse = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);
    const { events, bus, cleanup } = collect();

    await globalThis.fetch("https://api.example.com/data", {
      method: "POST",
      body: '{"a":1}',
    });
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");

    expect(req).toBeDefined();
    expect(req!.d.method).toBe("POST");
    expect(req!.d.url).toBe("https://api.example.com/data");
    expect(req!.d.id).toBeDefined();

    expect(res).toBeDefined();
    expect(res!.d.st).toBe(200);
    expect(res!.d.id).toBe(req!.d.id);
    expect(typeof res!.d.dur).toBe("number");

    cleanup();
  });

  it("defaults to GET when method is omitted", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));
    const { events, bus, cleanup } = collect();

    await globalThis.fetch("https://api.example.com/data");
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    expect(req!.d.method).toBe("GET");

    cleanup();
  });

  it("skips URLs matching networkExcludeUrls", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));
    const { events, bus, cleanup } = collect({
      networkExcludeUrls: ["analytics.example.com"],
    });

    await globalThis.fetch("https://analytics.example.com/v1/track");
    bus.flush();

    expect(events.filter((e) => e.k === "net.req")).toHaveLength(0);
    expect(events.filter((e) => e.k === "net.res")).toHaveLength(0);

    cleanup();
  });

  it("auto-excludes httpEndpoint (transport URL)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response("ok"));
    const { events, bus, cleanup } = collect({
      httpEndpoint: "http://localhost:9898",
    });

    await globalThis.fetch("http://localhost:9898/api/events");
    bus.flush();

    expect(events.filter((e) => e.k === "net.req")).toHaveLength(0);

    cleanup();
  });

  it("truncates response body at networkMaxBodySize", async () => {
    const bigBody = "x".repeat(200);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(bigBody, {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
    );
    const { events, bus, cleanup } = collect({ networkMaxBodySize: 50 });

    await globalThis.fetch("https://api.example.com/big");
    bus.flush();

    const res = events.find((e) => e.k === "net.res");
    expect(res).toBeDefined();
    expect(res!.d.body).toBeUndefined();
    expect(res!.d.bodySummary).toMatchObject({
      kind: "text",
      action: "summarized",
      reason: "payload_too_large",
      originalLength: 200,
      limit: 50,
    });

    cleanup();
  });

  it("drops malformed JSON responses instead of persisting raw sensitive fields", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"password":"fetch-secret", "ok": true', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { events, bus, cleanup } = collect();

    await globalThis.fetch(
      "https://api.example.com/bad-json?token=query-secret#frag",
    );
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");
    expect(req!.d.url).toBe(
      `https://api.example.com/bad-json?token=${encodeURIComponent("[REDACTED]")}`,
    );
    expect(res!.d.body).toBeUndefined();
    expect(res!.d.bodySummary).toMatchObject({
      kind: "json",
      action: "dropped",
      reason: "malformed_json_body",
    });
    expect(res!.d.redaction).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
    });
    expect(JSON.stringify(events)).not.toContain("fetch-secret");
    expect(JSON.stringify(events)).not.toContain("query-secret");
    expect(JSON.stringify(events)).not.toContain("#frag");

    cleanup();
  });

  it("detects binary response and logs as [bin:{size}]", async () => {
    const binaryData = new ArrayBuffer(1024);
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(binaryData, {
        status: 200,
        headers: { "content-type": "image/png", "content-length": "1024" },
      }),
    );
    const { events, bus, cleanup } = collect();

    await globalThis.fetch("https://api.example.com/image.png");
    bus.flush();

    const res = events.find((e) => e.k === "net.res");
    expect(res).toBeDefined();
    expect(res!.d.body).toBe("[bin:1024]");

    cleanup();
  });

  it("includes headers when networkCaptureHeaders is true", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("ok", {
        status: 200,
        headers: { "content-type": "text/plain", "x-custom": "value" },
      }),
    );
    const { events, bus, cleanup } = collect({ networkCaptureHeaders: true });

    await globalThis.fetch("https://api.example.com/data", {
      headers: { Authorization: "Bearer token" },
    });
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");

    expect(req!.d.hdrs).toBeDefined();
    expect(res!.d.hdrs).toBeDefined();

    cleanup();
  });

  it("excludes headers when networkCaptureHeaders is false", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const { events, bus, cleanup } = collect({ networkCaptureHeaders: false });

    await globalThis.fetch("https://api.example.com/data", {
      headers: { Authorization: "Bearer token" },
    });
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");

    expect(req!.d.hdrs).toBeUndefined();
    expect(res!.d.hdrs).toBeUndefined();

    cleanup();
  });

  it("skips body read for SSE (text/event-stream)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("data: hello\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const { events, bus, cleanup } = collect();

    await globalThis.fetch("https://api.example.com/stream");
    bus.flush();

    const res = events.find((e) => e.k === "net.res");
    expect(res).toBeDefined();
    expect(res!.d.body).toBeUndefined();

    cleanup();
  });

  it("injects fetch correlation headers and emits matching top-level IDs when enabled", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock;
    const { events, bus, cleanup, sessionId } = collect({
      networkCorrelationHeaders: true,
      networkCaptureHeaders: false,
    });

    await globalThis.fetch("https://api.example.com/data");
    bus.flush();

    const outgoingHeaders = getMockFetchHeaders(fetchMock);
    const outgoingSessionId = outgoingHeaders.get(CRUMBTRAIL_SESSION_HEADER);
    const outgoingRequestId = outgoingHeaders.get(CRUMBTRAIL_REQUEST_HEADER);
    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");

    const outgoingTraceparent = outgoingHeaders.get(W3C_TRACEPARENT_HEADER);

    expect(outgoingSessionId).toBe(sessionId);
    expect(outgoingRequestId).toMatch(/^[0-9a-f]{32}$/); // unified request id == W3C trace id
    // Spec-valid traceparent carrying a trace id the browser controls, equal to the request id.
    expect(outgoingTraceparent).toBe(
      `00-${outgoingRequestId}-${req!.d.spanId}-01`,
    );
    expect(parseTraceparent(outgoingTraceparent ?? undefined)).toMatchObject({
      traceId: outgoingRequestId,
      flags: 1,
    });
    expect(req!.d.traceId).toBe(outgoingRequestId);
    expect(req!.d.sessionId).toBe(outgoingSessionId);
    expect(req!.d.requestId).toBe(outgoingRequestId);
    expect(req!.d.hdrs).toBeUndefined();
    expect(res!.d.sessionId).toBe(outgoingSessionId);
    expect(res!.d.requestId).toBe(outgoingRequestId);
    expect(res!.d.traceId).toBe(outgoingRequestId);

    cleanup();
  });

  it("injects fetch correlation headers into same-origin requests by default", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock;
    const { events, bus, cleanup, sessionId } = collect();

    await globalThis.fetch("/api/data");
    bus.flush();

    const outgoingHeaders = getMockFetchHeaders(fetchMock);
    const req = events.find((e) => e.k === "net.req");

    expect(outgoingHeaders.get(CRUMBTRAIL_SESSION_HEADER)).toBe(sessionId);
    expect(outgoingHeaders.get(CRUMBTRAIL_REQUEST_HEADER)).toBe(
      String(req!.d.requestId),
    );
    expect(outgoingHeaders.get(W3C_TRACEPARENT_HEADER)).toContain(
      String(req!.d.requestId),
    );

    cleanup();
  });

  it("does not inject default fetch correlation headers into unallowlisted cross-origin requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = fetchMock;
    const { events, bus, cleanup } = collect();

    await globalThis.fetch("https://third-party.example.com/data");
    bus.flush();

    const outgoingHeaders = getMockFetchHeaders(fetchMock);
    const req = events.find((e) => e.k === "net.req");

    expect(outgoingHeaders.get(CRUMBTRAIL_SESSION_HEADER)).toBeNull();
    expect(outgoingHeaders.get(CRUMBTRAIL_REQUEST_HEADER)).toBeNull();
    expect(outgoingHeaders.get(W3C_TRACEPARENT_HEADER)).toBeNull();
    expect(req!.d.requestId).toBeUndefined();

    cleanup();
  });

  it("adopts a caller-provided traceparent as the request correlation key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = fetchMock;
    const { events, bus, cleanup } = collect({
      networkCorrelationHeaders: true,
    });

    const callerTraceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const callerTraceparent = `00-${callerTraceId}-00f067aa0ba902b7-01`;
    await globalThis.fetch("https://api.example.com/data", {
      headers: { [W3C_TRACEPARENT_HEADER]: callerTraceparent },
    });
    bus.flush();

    const outgoingHeaders = getMockFetchHeaders(fetchMock);
    const req = events.find((e) => e.k === "net.req");

    // Existing W3C propagation is respected, not overwritten, and we join on the user's trace.
    expect(outgoingHeaders.get(W3C_TRACEPARENT_HEADER)).toBe(callerTraceparent);
    expect(req!.d.traceId).toBe(callerTraceId);
    expect(req!.d.requestId).toBe(callerTraceId);
    expect(outgoingHeaders.get(CRUMBTRAIL_REQUEST_HEADER)).toBe(callerTraceId);

    cleanup();
  });

  it("preserves caller-provided Crumbtrail correlation IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = fetchMock;
    const { events, bus, cleanup } = collect({
      networkCorrelationHeaders: true,
    });

    await globalThis.fetch("https://api.example.com/data", {
      headers: {
        [CRUMBTRAIL_SESSION_HEADER]: "caller-session",
        [CRUMBTRAIL_REQUEST_HEADER]: "caller-request",
      },
    });
    bus.flush();

    const outgoingHeaders = getMockFetchHeaders(fetchMock);
    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");

    expect(outgoingHeaders.get(CRUMBTRAIL_SESSION_HEADER)).toBe(
      "caller-session",
    );
    expect(outgoingHeaders.get(CRUMBTRAIL_REQUEST_HEADER)).toBe(
      "caller-request",
    );
    expect(req!.d.sessionId).toBe("caller-session");
    expect(req!.d.requestId).toBe("caller-request");
    expect(res!.d.sessionId).toBe("caller-session");
    expect(res!.d.requestId).toBe("caller-request");

    cleanup();
  });

  it("supports Request inputs without mutating the caller-owned Headers object", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = fetchMock;
    const originalHeaders = new Headers({ "x-custom": "value" });
    const request = new Request("https://api.example.com/from-request", {
      method: "POST",
      headers: originalHeaders,
      body: "payload",
    });
    const { events, bus, cleanup, sessionId } = collect({
      networkCorrelationHeaders: true,
    });

    await globalThis.fetch(request);
    bus.flush();

    const outgoingHeaders = getMockFetchHeaders(fetchMock);
    const req = events.find((e) => e.k === "net.req");

    expect(originalHeaders.get(CRUMBTRAIL_SESSION_HEADER)).toBeNull();
    expect(originalHeaders.get(CRUMBTRAIL_REQUEST_HEADER)).toBeNull();
    expect(outgoingHeaders.get("x-custom")).toBe("value");
    expect(outgoingHeaders.get(CRUMBTRAIL_SESSION_HEADER)).toBe(sessionId);
    expect(outgoingHeaders.get(CRUMBTRAIL_REQUEST_HEADER)).toBe(
      String(req!.d.requestId),
    );
    expect(req!.d.method).toBe("POST");

    cleanup();
  });

  it("adds top-level IDs even when captured headers contain redacted values", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = fetchMock;
    const { events, bus, cleanup } = collect({
      networkCorrelationHeaders: true,
      networkCaptureHeaders: true,
    });

    await globalThis.fetch("https://api.example.com/data", {
      headers: { Authorization: "Bearer secret-token" },
    });
    bus.flush();

    const outgoingHeaders = getMockFetchHeaders(fetchMock);
    const req = events.find((e) => e.k === "net.req");
    const hdrs = req!.d.hdrs as Record<string, string>;

    const redactedAuth = Object.entries(hdrs).find(
      ([key]) => key.toLowerCase() === "authorization",
    )?.[1];

    expect(redactedAuth).toBe("[REDACTED]");
    expect(req!.d.sessionId).toBe(
      outgoingHeaders.get(CRUMBTRAIL_SESSION_HEADER),
    );
    expect(req!.d.requestId).toBe(
      outgoingHeaders.get(CRUMBTRAIL_REQUEST_HEADER),
    );

    cleanup();
  });

  it("does not inject correlation headers into excluded httpEndpoint fetches", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = fetchMock;
    const { events, bus, cleanup } = collect({
      httpEndpoint: "http://localhost:9898",
      networkCorrelationHeaders: true,
    });

    await globalThis.fetch("http://localhost:9898/api/events");
    bus.flush();

    const outgoingHeaders = getMockFetchHeaders(fetchMock);
    expect(outgoingHeaders.get(CRUMBTRAIL_SESSION_HEADER)).toBeNull();
    expect(outgoingHeaders.get(CRUMBTRAIL_REQUEST_HEADER)).toBeNull();
    expect(events.filter((e) => e.k === "net.req")).toHaveLength(0);
    expect(events.filter((e) => e.k === "net.res")).toHaveLength(0);

    cleanup();
  });

  it("keeps the original fetch rejection behavior when correlated requests fail", async () => {
    const fetchError = new TypeError("network down");
    const fetchMock = vi.fn().mockRejectedValue(fetchError);
    globalThis.fetch = fetchMock;
    const { events, bus, cleanup } = collect({
      networkCorrelationHeaders: true,
    });

    await expect(globalThis.fetch("https://api.example.com/fail")).rejects.toBe(
      fetchError,
    );
    bus.flush();

    expect(events.filter((e) => e.k === "net.req")).toHaveLength(1);
    expect(events.filter((e) => e.k === "net.res")).toHaveLength(0);

    cleanup();
  });

  it("supports correlated fetch-only environments without XMLHttpRequest", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    const fetchBeforeCollect = fetchMock as unknown as typeof globalThis.fetch;
    globalThis.fetch = fetchBeforeCollect;
    delete (globalThis as Partial<typeof globalThis>).XMLHttpRequest;

    const { events, bus, cleanup, sessionId } = collect({
      networkCorrelationHeaders: true,
      networkCaptureHeaders: false,
    });

    await expect(
      globalThis.fetch("https://api.example.com/fetch-only"),
    ).resolves.toBeInstanceOf(Response);
    bus.flush();

    const outgoingHeaders = getMockFetchHeaders(fetchMock);
    const outgoingSessionId = outgoingHeaders.get(CRUMBTRAIL_SESSION_HEADER);
    const outgoingRequestId = outgoingHeaders.get(CRUMBTRAIL_REQUEST_HEADER);
    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");

    expect(outgoingSessionId).toBe(sessionId);
    expect(outgoingRequestId).toMatch(/^[0-9a-f]{32}$/); // unified request id == W3C trace id
    expect(req!.d.sessionId).toBe(outgoingSessionId);
    expect(req!.d.requestId).toBe(outgoingRequestId);
    expect(res!.d.sessionId).toBe(outgoingSessionId);
    expect(res!.d.requestId).toBe(outgoingRequestId);

    cleanup();

    expect(globalThis.fetch).toBe(fetchBeforeCollect);
    expect(globalThis.XMLHttpRequest).toBeUndefined();
  });

  it("does not throw when both fetch and XMLHttpRequest are unavailable", () => {
    delete (globalThis as Partial<typeof globalThis>).fetch;
    delete (globalThis as Partial<typeof globalThis>).XMLHttpRequest;

    const { cleanup } = collect({ networkCorrelationHeaders: true });

    expect(globalThis.fetch).toBeUndefined();
    expect(globalThis.XMLHttpRequest).toBeUndefined();
    expect(() => cleanup()).not.toThrow();
    expect(globalThis.fetch).toBeUndefined();
    expect(globalThis.XMLHttpRequest).toBeUndefined();
  });

  it("cleanup restores original fetch", () => {
    const origFetch = globalThis.fetch;
    const { cleanup } = collect();

    // After init, fetch should be wrapped
    expect(globalThis.fetch).not.toBe(origFetch);

    cleanup();

    // After cleanup, fetch should be restored
    expect(globalThis.fetch).toBe(origFetch);
  });
});

/* ================================================================== */
/* XHR tests                                                           */
/* ================================================================== */

describe("networkCollector — XHR", () => {
  it("emits net.req and net.res events with correct fields", () => {
    const { events, bus, cleanup } = collect();

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/data");
    xhr.send();

    // Simulate response
    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, '{"ok":true}', { "content-type": "application/json" });
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");

    expect(req).toBeDefined();
    expect(req!.d.method).toBe("GET");
    expect(req!.d.url).toBe("https://api.example.com/data");
    expect(req!.d.id).toBeDefined();

    expect(res).toBeDefined();
    expect(res!.d.st).toBe(200);
    expect(res!.d.id).toBe(req!.d.id);
    expect(typeof res!.d.dur).toBe("number");

    cleanup();
  });

  it("skips URLs matching networkExcludeUrls", () => {
    const { events, bus, cleanup } = collect({
      networkExcludeUrls: ["analytics.example.com"],
    });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://analytics.example.com/v1/track");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, "ok");
    bus.flush();

    expect(events.filter((e) => e.k === "net.req")).toHaveLength(0);
    expect(events.filter((e) => e.k === "net.res")).toHaveLength(0);

    cleanup();
  });

  it("auto-excludes httpEndpoint", () => {
    const { events, bus, cleanup } = collect({
      httpEndpoint: "http://localhost:9898",
    });

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "http://localhost:9898/api/events");
    xhr.send("data");

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, "ok");
    bus.flush();

    expect(events.filter((e) => e.k === "net.req")).toHaveLength(0);

    cleanup();
  });

  it("truncates response body at networkMaxBodySize", () => {
    const { events, bus, cleanup } = collect({ networkMaxBodySize: 30 });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/big");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, "y".repeat(200), { "content-type": "text/plain" });
    bus.flush();

    const res = events.find((e) => e.k === "net.res");
    expect(res).toBeDefined();
    expect(res!.d.body).toBeUndefined();
    expect(res!.d.bodySummary).toMatchObject({
      kind: "text",
      action: "summarized",
      reason: "payload_too_large",
      originalLength: 200,
      limit: 30,
    });

    cleanup();
  });

  it("detects binary response and logs as [bin:{size}]", () => {
    const { events, bus, cleanup } = collect();

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/image.png");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, "", {
      "content-type": "image/png",
      "content-length": "2048",
    });
    bus.flush();

    const res = events.find((e) => e.k === "net.res");
    expect(res).toBeDefined();
    expect(res!.d.body).toBe("[bin:2048]");

    cleanup();
  });

  it("includes headers when networkCaptureHeaders is true", () => {
    const { events, bus, cleanup } = collect({ networkCaptureHeaders: true });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/data");
    xhr.setRequestHeader("X-Custom", "value");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, "ok", { "content-type": "text/plain" });
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");

    expect(req!.d.hdrs).toBeDefined();
    expect(res!.d.hdrs).toBeDefined();

    cleanup();
  });

  it("excludes headers when networkCaptureHeaders is false", () => {
    const { events, bus, cleanup } = collect({ networkCaptureHeaders: false });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/data");
    xhr.setRequestHeader("X-Custom", "value");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, "ok");
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");

    expect(req!.d.hdrs).toBeUndefined();
    expect(res!.d.hdrs).toBeUndefined();

    cleanup();
  });

  it("injects XHR correlation headers and emits matching top-level IDs when enabled", () => {
    const { events, bus, cleanup, sessionId } = collect({
      networkCorrelationHeaders: true,
      networkCaptureHeaders: false,
    });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/data");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, "ok");
    bus.flush();

    const outgoingSessionId = mock.requestHeaders[CRUMBTRAIL_SESSION_HEADER];
    const outgoingRequestId = mock.requestHeaders[CRUMBTRAIL_REQUEST_HEADER];
    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");

    const outgoingTraceparent = mock.requestHeaders[W3C_TRACEPARENT_HEADER];

    expect(outgoingSessionId).toBe(sessionId);
    expect(outgoingRequestId).toMatch(/^[0-9a-f]{32}$/); // unified request id == W3C trace id
    expect(outgoingTraceparent).toBe(
      `00-${outgoingRequestId}-${req!.d.spanId}-01`,
    );
    expect(req!.d.traceId).toBe(outgoingRequestId);
    expect(req!.d.sessionId).toBe(outgoingSessionId);
    expect(req!.d.requestId).toBe(outgoingRequestId);
    expect(req!.d.hdrs).toBeUndefined();
    expect(res!.d.sessionId).toBe(outgoingSessionId);
    expect(res!.d.requestId).toBe(outgoingRequestId);
    expect(res!.d.traceId).toBe(outgoingRequestId);

    cleanup();
  });

  it("injects XHR correlation headers into same-origin requests by default", () => {
    const { events, bus, cleanup, sessionId } = collect();

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/data");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, "ok");
    bus.flush();

    const req = events.find((e) => e.k === "net.req");

    expect(mock.requestHeaders[CRUMBTRAIL_SESSION_HEADER]).toBe(sessionId);
    expect(mock.requestHeaders[CRUMBTRAIL_REQUEST_HEADER]).toBe(
      String(req!.d.requestId),
    );
    expect(mock.requestHeaders[W3C_TRACEPARENT_HEADER]).toContain(
      String(req!.d.requestId),
    );

    cleanup();
  });

  it("does not inject default XHR correlation headers into unallowlisted cross-origin requests", () => {
    const { events, bus, cleanup } = collect();

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://third-party.example.com/data");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, "ok");
    bus.flush();

    const req = events.find((e) => e.k === "net.req");

    expect(mock.requestHeaders[CRUMBTRAIL_SESSION_HEADER]).toBeUndefined();
    expect(mock.requestHeaders[CRUMBTRAIL_REQUEST_HEADER]).toBeUndefined();
    expect(mock.requestHeaders[W3C_TRACEPARENT_HEADER]).toBeUndefined();
    expect(req!.d.requestId).toBeUndefined();

    cleanup();
  });

  it("preserves caller-provided XHR Crumbtrail correlation IDs", () => {
    const { events, bus, cleanup } = collect({
      networkCorrelationHeaders: true,
    });

    const xhr = new XMLHttpRequest();
    xhr.open("POST", "https://api.example.com/data");
    xhr.setRequestHeader(CRUMBTRAIL_SESSION_HEADER, "caller-session");
    xhr.setRequestHeader(CRUMBTRAIL_REQUEST_HEADER, "caller-request");
    xhr.send("payload");

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(201, "ok");
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const res = events.find((e) => e.k === "net.res");

    expect(mock.requestHeaders[CRUMBTRAIL_SESSION_HEADER]).toBe(
      "caller-session",
    );
    expect(mock.requestHeaders[CRUMBTRAIL_REQUEST_HEADER]).toBe(
      "caller-request",
    );
    expect(req!.d.sessionId).toBe("caller-session");
    expect(req!.d.requestId).toBe("caller-request");
    expect(res!.d.sessionId).toBe("caller-session");
    expect(res!.d.requestId).toBe("caller-request");

    cleanup();
  });

  it("links XHR failure events with the request correlation IDs", () => {
    const { events, bus, cleanup, sessionId } = collect({
      networkCorrelationHeaders: true,
    });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/fail");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._error();
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const err = events.find((e) => e.k === "net.err");

    expect(req!.d.sessionId).toBe(sessionId);
    expect(req!.d.requestId).toBe(
      mock.requestHeaders[CRUMBTRAIL_REQUEST_HEADER],
    );
    expect(err!.d.sessionId).toBe(req!.d.sessionId);
    expect(err!.d.requestId).toBe(req!.d.requestId);

    cleanup();
  });

  it("does not inject correlation headers into excluded XHR requests", () => {
    const { events, bus, cleanup } = collect({
      networkExcludeUrls: ["analytics.example.com"],
      networkCorrelationHeaders: true,
    });

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://analytics.example.com/v1/track");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, "ok");
    bus.flush();

    expect(mock.requestHeaders[CRUMBTRAIL_SESSION_HEADER]).toBeUndefined();
    expect(mock.requestHeaders[CRUMBTRAIL_REQUEST_HEADER]).toBeUndefined();
    expect(events.filter((e) => e.k === "net.req")).toHaveLength(0);
    expect(events.filter((e) => e.k === "net.res")).toHaveLength(0);

    cleanup();
  });

  it("emits net.err (not net.res) for XHR error events", () => {
    const { events, bus, cleanup } = collect();

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/fail");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._error();
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const err = events.find((e) => e.k === "net.err");
    expect(err).toBeDefined();
    expect(err!.d.id).toBe(req!.d.id);
    expect(err!.d.method).toBe("GET");
    expect(err!.d.url).toBe("https://api.example.com/fail");
    expect(err!.d.msg).toBe("network error");
    expect(err!.d.transport).toBe("xhr");
    expect(typeof err!.d.dur).toBe("number");
    expect(events.filter((e) => e.k === "net.res")).toHaveLength(0);

    cleanup();
  });

  it("emits net.err for XHR timeout events", () => {
    const { events, bus, cleanup } = collect();

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/slow");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._timeout();
    bus.flush();

    const err = events.find((e) => e.k === "net.err");
    expect(err).toBeDefined();
    expect(err!.d.msg).toBe("request timed out");
    expect(err!.d.name).toBe("TimeoutError");
    expect(events.filter((e) => e.k === "net.res")).toHaveLength(0);

    cleanup();
  });

  it("emits net.err with an AbortError marker for XHR abort events", () => {
    const { events, bus, cleanup } = collect();

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/cancelled");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._abort();
    bus.flush();

    const err = events.find((e) => e.k === "net.err");
    expect(err).toBeDefined();
    expect(err!.d.msg).toBe("request aborted");
    expect(err!.d.name).toBe("AbortError");
    expect(events.filter((e) => e.k === "net.res")).toHaveLength(0);

    cleanup();
  });

  it("cleanup restores original XHR methods", () => {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    const { cleanup } = collect();

    // After init, methods should be wrapped
    expect(XMLHttpRequest.prototype.open).not.toBe(origOpen);
    expect(XMLHttpRequest.prototype.send).not.toBe(origSend);

    cleanup();

    // After cleanup, methods should be restored
    expect(XMLHttpRequest.prototype.open).toBe(origOpen);
    expect(XMLHttpRequest.prototype.send).toBe(origSend);
  });

  it("skips body for SSE (text/event-stream) responses", () => {
    const { events, bus, cleanup } = collect();

    const xhr = new XMLHttpRequest();
    xhr.open("GET", "https://api.example.com/stream");
    xhr.send();

    const mock = MockXHR.instances[MockXHR.instances.length - 1];
    mock._respond(200, "data: hello\n\n", {
      "content-type": "text/event-stream",
    });
    bus.flush();

    const res = events.find((e) => e.k === "net.res");
    expect(res).toBeDefined();
    expect(res!.d.body).toBeUndefined();

    cleanup();
  });
});

/* ================================================================== */
/* Fetch failure tests                                                 */
/* ================================================================== */

describe("networkCollector — fetch failures", () => {
  it("emits net.err and rethrows when fetch rejects", async () => {
    const failure = new TypeError("Failed to fetch");
    globalThis.fetch = vi.fn().mockRejectedValue(failure);
    const { events, bus, cleanup } = collect();

    await expect(
      globalThis.fetch("https://api.example.com/data", { method: "POST" }),
    ).rejects.toBe(failure);
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const err = events.find((e) => e.k === "net.err");
    expect(err).toBeDefined();
    expect(err!.d.id).toBe(req!.d.id);
    expect(err!.d.method).toBe("POST");
    expect(err!.d.url).toBe("https://api.example.com/data");
    expect(err!.d.msg).toBe("Failed to fetch");
    expect(err!.d.name).toBe("TypeError");
    expect(err!.d.transport).toBe("fetch");
    expect(typeof err!.d.dur).toBe("number");
    expect(events.filter((e) => e.k === "net.res")).toHaveLength(0);

    cleanup();
  });

  it("marks aborted fetches with the AbortError name", async () => {
    const failure = new DOMException(
      "The operation was aborted.",
      "AbortError",
    );
    globalThis.fetch = vi.fn().mockRejectedValue(failure);
    const { events, bus, cleanup } = collect();

    await expect(
      globalThis.fetch("https://api.example.com/cancelled"),
    ).rejects.toBe(failure);
    bus.flush();

    const err = events.find((e) => e.k === "net.err");
    expect(err).toBeDefined();
    expect(err!.d.name).toBe("AbortError");

    cleanup();
  });

  it("carries correlation IDs on net.err when header injection is enabled", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { events, bus, cleanup, sessionId } = collect({
      networkCorrelationHeaders: true,
    });

    await expect(
      globalThis.fetch("https://api.example.com/data"),
    ).rejects.toThrow("Failed to fetch");
    bus.flush();

    const req = events.find((e) => e.k === "net.req");
    const err = events.find((e) => e.k === "net.err");
    expect(err!.d.sessionId).toBe(sessionId);
    expect(err!.d.requestId).toBe(req!.d.requestId);
    expect(err!.d.requestId).toBeDefined();

    cleanup();
  });

  it("redacts sensitive query params in the net.err url", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const { events, bus, cleanup } = collect();

    await expect(
      globalThis.fetch("https://api.example.com/data?token=supersecret"),
    ).rejects.toThrow();
    bus.flush();

    const err = events.find((e) => e.k === "net.err");
    expect(String(err!.d.url)).not.toContain("supersecret");

    cleanup();
  });
});
