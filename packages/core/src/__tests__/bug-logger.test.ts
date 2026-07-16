import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Crumbtrail } from "../bug-logger";
import {
  CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_REQUEST_ID_MAX_LENGTH,
  CRUMBTRAIL_SESSION_HEADER,
  DEFAULT_CONFIG,
  generateRequestId,
} from "../index";

describe("Crumbtrail", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response('{"ok":true}')),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("initializes and returns Crumbtrail instance", () => {
    const logger = Crumbtrail.init({
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });
    expect(logger).toBeInstanceOf(Crumbtrail);
    return logger.stop();
  });

  it("stop() returns sessionId matching expected pattern", async () => {
    const logger = Crumbtrail.init({
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });
    const result = await logger.stop();
    expect(result.sessionId).toMatch(/^ses_\d{8}_\d{6}_[0-9a-f]{12}$/);
  });

  it("getSessionId() matches stop() and is available before startSession completion", async () => {
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockRejectedValue(new Error("start failed")),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: mockTransport,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    const activeSessionId = logger.getSessionId();
    expect(activeSessionId).toMatch(/^ses_\d{8}_\d{6}_[0-9a-f]{12}$/);

    const result = await logger.stop();
    expect(result.sessionId).toBe(activeSessionId);
  });

  it("createRequestHeaders() uses the active session and preserves caller request IDs", async () => {
    const logger = Crumbtrail.init({
      network: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    const headers = logger.createRequestHeaders("caller-request-1");
    expect(headers[CRUMBTRAIL_SESSION_HEADER]).toBe(logger.getSessionId());
    expect(headers[CRUMBTRAIL_REQUEST_HEADER]).toBe("caller-request-1");

    await logger.stop();
  });

  it("createRequestHeaders() regenerates oversized request IDs", async () => {
    const logger = Crumbtrail.init({
      network: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    const oversized = "x".repeat(CRUMBTRAIL_REQUEST_ID_MAX_LENGTH + 1);
    const headers = logger.createRequestHeaders(oversized);
    expect(headers[CRUMBTRAIL_REQUEST_HEADER]).not.toBe(oversized);
    expect(headers[CRUMBTRAIL_REQUEST_HEADER].length).toBeLessThanOrEqual(
      CRUMBTRAIL_REQUEST_ID_MAX_LENGTH,
    );
    expect(headers[CRUMBTRAIL_REQUEST_HEADER]).toMatch(
      /^req_[a-z0-9]+_[a-z0-9]+$/,
    );

    await logger.stop();
  });

  it("generateRequestId() produces bounded request IDs", () => {
    const requestId = generateRequestId();
    expect(requestId.length).toBeLessThanOrEqual(
      CRUMBTRAIL_REQUEST_ID_MAX_LENGTH,
    );
    expect(requestId).toMatch(/^req_[a-z0-9]+_[a-z0-9]+$/);
  });

  it("keeps network correlation header injection enabled by default with no cross-origin allowlist", () => {
    expect(DEFAULT_CONFIG.networkCorrelationHeaders).toBe(true);
    expect(DEFAULT_CONFIG.networkCorrelationAllowedOrigins).toEqual([]);
  });

  it("mark() emits mark event without throwing", async () => {
    const logger = Crumbtrail.init({
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });
    expect(() => logger.mark("test label")).not.toThrow();
    await logger.stop();
  });

  it("addEvent() emits custom event without throwing", async () => {
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: mockTransport,
      flushIntervalMs: 100_000,
      flushBufferSize: 1,
    });
    expect(() =>
      logger.addEvent({
        type: "cust",
        data: { label: "test" },
        platform: "react-native",
        sdk: { name: "crumbtrail-react-native" },
        capabilities: ["navigation"],
      }),
    ).not.toThrow();
    expect(mockTransport.sendEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        k: "cust",
        d: { label: "test" },
        platform: "react-native",
        sdk: { name: "crumbtrail-react-native" },
        capabilities: ["navigation"],
      }),
    ]);
    await logger.stop();
  });

  it("pause() and resume() work without error", async () => {
    const logger = Crumbtrail.init({
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });
    logger.pause();
    logger.mark("while paused");
    logger.resume();
    await logger.stop();
  });

  it("respects collector toggle flags", async () => {
    const logger = Crumbtrail.init({
      console: false,
      errors: false,
      interactions: false,
      keystrokes: false,
      scroll: false,
      visibility: false,
      clipboard: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });
    const result = await logger.stop();
    expect(result.sessionId).toBeDefined();
  });

  it("uses custom transportInstance when provided", async () => {
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };

    const logger = Crumbtrail.init({
      transportInstance: mockTransport,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    await new Promise((r) => setTimeout(r, 0));
    expect(mockTransport.startSession).toHaveBeenCalledTimes(1);

    await logger.stop();
    expect(mockTransport.endSession).toHaveBeenCalledTimes(1);
  });

  it("autoFlagOnSignals auto-captures a rage-click cluster (no error thrown)", async () => {
    vi.useFakeTimers();
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      autoFlagOnSignals: true,
      rageClickThreshold: 4,
      rageClickWindowMs: 1500,
      autoFlagDebounceMs: 2000,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    const el = { sig: "btn-checkout" };
    for (let i = 0; i < 4; i++) {
      logger.addEvent({ type: "clk", data: { el } });
    }
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockTransport.sendBugReport).toHaveBeenCalledTimes(1);
    const report = mockTransport.sendBugReport.mock.calls[0][0];
    expect(report.tags).toContain("auto:rage-click");

    vi.useRealTimers();
    await logger.stop();
  });

  it("autoFlagOnSignals auto-captures an abandoned flow (inputs then page hidden, no submit)", async () => {
    vi.useFakeTimers();
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      autoFlagOnSignals: true,
      abandonedFlowMinInputs: 2,
      abandonedFlowWindowMs: 30000,
      autoFlagDebounceMs: 2000,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    logger.addEvent({ type: "inp", data: { el: { sig: "email" }, val: "a" } });
    logger.addEvent({ type: "inp", data: { el: { sig: "email" }, val: "ab" } });
    logger.addEvent({ type: "vis", data: { state: "hidden" } });
    await vi.advanceTimersByTimeAsync(2000);

    expect(mockTransport.sendBugReport).toHaveBeenCalledTimes(1);
    expect(mockTransport.sendBugReport.mock.calls[0][0].tags).toContain(
      "auto:abandoned-flow",
    );

    vi.useRealTimers();
    await logger.stop();
  });

  it("flagBug captures registered state providers into snapshot", async () => {
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });
    logger.registerStateProvider("react", () => ({ count: 3 }));

    await logger.flagBug({ note: "state snapshot" });
    const sentEvents = mockTransport.sendBugReport.mock.calls[0][1];
    expect(sentEvents.some((e: any) => e.k === "state.snap")).toBe(true);

    await logger.stop();
  });

  it("flagBug redacts registered state provider snapshots by default", async () => {
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });
    logger.registerStateProvider("react", () => ({
      count: 3,
      password: "hunter2",
    }));

    await logger.flagBug({ note: "state snapshot" });
    const sentEvents = mockTransport.sendBugReport.mock.calls[0][1];
    const snap = sentEvents.find(
      (e: any) => e.k === "state.snap" && e.d.name === "react",
    );
    expect(snap.d.json).toContain("[REDACTED]");
    expect(snap.d.json).not.toContain("hunter2");
    expect(snap.d.redaction).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
    });

    await logger.stop();
  });

  it("flagBug captures raw state snapshots only when explicitly opted in", async () => {
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
      captureRawState: true,
    });
    logger.registerStateProvider("react", () => ({ password: "hunter2" }));

    await logger.flagBug({ note: "state snapshot" });
    const sentEvents = mockTransport.sendBugReport.mock.calls[0][1];
    const snap = sentEvents.find(
      (e: any) => e.k === "state.snap" && e.d.name === "react",
    );
    expect(snap.d.json).toContain("hunter2");
    expect(snap.d.redaction).toBeUndefined();

    await logger.stop();
  });

  it("flagBug does not rest raw malformed JSON-like sensitive state provider errors by default", async () => {
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });
    logger.registerStateProvider("react", () => {
      throw new Error('{"password":"hunter2",}');
    });

    await logger.flagBug({ note: "state provider failed" });
    const sentEvents = mockTransport.sendBugReport.mock.calls[0][1];
    const err = sentEvents.find((e: any) => e.k === "state.err");
    expect(err.d.msg).toBe("[dropped:malformed_json_body]");
    expect(err.d.msg).not.toContain("hunter2");
    expect(err.d.msg).not.toContain("password");
    expect(err.d.msgSummary).toMatchObject({
      kind: "json",
      action: "dropped",
      reason: "malformed_json_body",
    });
    expect(err.d.redaction).toMatchObject({
      policy: "crumbtrail.browser-redaction.v1",
    });

    await logger.stop();
  });

  it("flagBug counts 200 responses with application failure payloads as failed requests", async () => {
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    logger.addEvent({
      type: "net.res",
      data: {
        st: 200,
        body: '1:{"ok":false,"status":"failed","message":"Billing subscription state was not found before metering usage.","code":"BILLING_USAGE_SUBSCRIPTION_NOT_FOUND"}',
      },
    });

    await logger.flagBug({ note: "sync failed" });

    expect(
      mockTransport.sendBugReport.mock.calls[0][0].summary.failedRequestCount,
    ).toBe(1);

    await logger.stop();
  });

  it("emits an env snapshot at session start by default", async () => {
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    await logger.flagBug({ note: "env snapshot" });
    const sentEvents = mockTransport.sendBugReport.mock.calls[0][1];
    const envEvents = sentEvents.filter((e: any) => e.k === "env");
    expect(envEvents.length).toBe(1);
    expect(envEvents[0].d.kind).toBe("snapshot");

    await logger.stop();
  });

  it("setEnv() merges declared flags/config and emits a redacted env delta", async () => {
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    logger.setEnv({
      flags: { newCheckout: true, apiKey: "sk_fake_abcdefghijklmnopqrstuvwx" },
      config: { region: "eu", password: "hunter2-very-secret" },
    });

    await logger.flagBug({ note: "env delta" });
    const sentEvents = mockTransport.sendBugReport.mock.calls[0][1];
    const envEvents = sentEvents.filter((e: any) => e.k === "env");

    // initial snapshot + setEnv delta
    expect(envEvents.map((e: any) => e.d.kind)).toEqual(["snapshot", "delta"]);
    const delta = envEvents[1];
    expect(delta.d.flags.newCheckout).toBe(true);
    expect(delta.d.config.region).toBe("eu");

    const serialized = JSON.stringify(envEvents);
    expect(serialized).not.toContain("sk_fake_abcdefghijklmnopqrstuvwx");
    expect(serialized).not.toContain("hunter2-very-secret");

    await logger.stop();
  });

  it("setEnv() does not emit a delta when the environment collector is disabled", async () => {
    const mockTransport = {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
    const logger = Crumbtrail.init({
      environment: false,
      transportInstance: mockTransport as any,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    expect(() => logger.setEnv({ flags: { a: 1 } })).not.toThrow();
    await logger.flagBug({ note: "no env" });
    const sentEvents = mockTransport.sendBugReport.mock.calls[0][1];
    expect(sentEvents.some((e: any) => e.k === "env")).toBe(false);

    await logger.stop();
  });

  it("Crumbtrail.init() uses default (passive) config", async () => {
    const logger = Crumbtrail.init();
    expect(logger).toBeInstanceOf(Crumbtrail);
    await logger.stop();
  });

  it('Crumbtrail.init("passive") produces a valid instance', async () => {
    const logger = Crumbtrail.init("passive");
    expect(logger).toBeInstanceOf(Crumbtrail);
    await logger.stop();
  });

  it('Crumbtrail.init("full") enables widget config', async () => {
    // widget mount requires document.createElement; we just verify init succeeds
    // and the instance is valid — widget: true is set in PRESET_FULL
    const logger = Crumbtrail.init("full");
    expect(logger).toBeInstanceOf(Crumbtrail);
    await logger.stop();
  });

  it('Crumbtrail.init("light") disables sensitive collectors', async () => {
    // Verify init completes without error with the light preset
    const logger = Crumbtrail.init("light");
    expect(logger).toBeInstanceOf(Crumbtrail);
    const result = await logger.stop();
    expect(result.sessionId).toBeDefined();
  });

  it("calls transport startSession on init", async () => {
    const logger = Crumbtrail.init({
      network: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });
    await new Promise((r) => setTimeout(r, 0));

    const startCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("/api/session/start"),
    );
    expect(startCalls.length).toBe(1);

    await logger.stop();
  });

  function makeMockTransport() {
    return {
      sendEvents: vi.fn().mockResolvedValue(undefined),
      sendBlob: vi.fn().mockResolvedValue(undefined),
      startSession: vi.fn().mockResolvedValue(undefined),
      endSession: vi.fn().mockResolvedValue(undefined),
      sendBugReport: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("autoFlagOnError auto-captures a bug report after the error burst settles", async () => {
    vi.useFakeTimers();
    const mockTransport = makeMockTransport();
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      autoFlagOnError: true,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    logger.addEvent({
      type: "err",
      data: { msg: "boom", stk: "Error: boom\n  at app.js:1" },
    });
    expect(mockTransport.sendBugReport).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2001);
    expect(mockTransport.sendBugReport).toHaveBeenCalledTimes(1);
    const report = mockTransport.sendBugReport.mock.calls[0][0];
    expect(report.tags).toContain("auto:error");

    // Same error again — deduped, no second report.
    logger.addEvent({
      type: "err",
      data: { msg: "boom", stk: "Error: boom\n  at app.js:1" },
    });
    await vi.advanceTimersByTimeAsync(2001);
    expect(mockTransport.sendBugReport).toHaveBeenCalledTimes(1);

    await logger.stop();
    vi.useRealTimers();
  });

  it("does not auto-capture on error by default", async () => {
    vi.useFakeTimers();
    const mockTransport = makeMockTransport();
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    logger.addEvent({ type: "err", data: { msg: "boom" } });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mockTransport.sendBugReport).not.toHaveBeenCalled();

    await logger.stop();
    vi.useRealTimers();
  });

  it("flagBug captures a DOM snapshot into the report window", async () => {
    document.body.innerHTML = '<div id="app">hello world</div>';
    const mockTransport = makeMockTransport();
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    await logger.flagBug({ note: "dom" });
    const sentEvents = mockTransport.sendBugReport.mock.calls[0][1];
    const snap = sentEvents.find((e: any) => e.k === "dom.snap");
    expect(snap).toBeDefined();
    expect(snap.d.html).toContain('id="app"');
    expect(snap.d.truncated).toBe(false);

    await logger.stop();
  });

  it("flagBug truncates the DOM snapshot at domSnapshotMaxBytes", async () => {
    document.body.innerHTML = `<div>${"x".repeat(5000)}</div>`;
    const mockTransport = makeMockTransport();
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      domSnapshotMaxBytes: 100,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    await logger.flagBug({ note: "dom capped" });
    const sentEvents = mockTransport.sendBugReport.mock.calls[0][1];
    const snap = sentEvents.find((e: any) => e.k === "dom.snap");
    expect(snap).toBeDefined();
    expect(snap.d.truncated).toBe(true);
    expect(snap.d.html.length).toBeLessThanOrEqual(100);

    await logger.stop();
  });

  it("flagBug skips the DOM snapshot when domSnapshot is disabled", async () => {
    const mockTransport = makeMockTransport();
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    await logger.flagBug({ note: "no dom" });
    const sentEvents = mockTransport.sendBugReport.mock.calls[0][1];
    expect(sentEvents.some((e: any) => e.k === "dom.snap")).toBe(false);

    await logger.stop();
  });

  it("flagBug snapshots in-flight network requests via the pending provider", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const mockTransport = makeMockTransport();
    const logger = Crumbtrail.init({
      transportInstance: mockTransport as any,
      network: true,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });

    void fetch("/api/slow");

    await logger.flagBug({ note: "hang" });
    const sentEvents = mockTransport.sendBugReport.mock.calls[0][1];
    const pending = sentEvents.find(
      (e: any) => e.k === "state.snap" && e.d.name === "network.pending",
    );
    expect(pending).toBeDefined();
    expect(pending.d.json).toContain("/api/slow");

    await logger.stop();
  });

  it("startSession payload includes url and ua", async () => {
    const logger = Crumbtrail.init({
      network: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1000,
    });
    await new Promise((r) => setTimeout(r, 0));

    const startCalls = (fetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("/api/session/start"),
    );
    expect(startCalls.length).toBe(1);
    const body = JSON.parse(startCalls[0][1].body);
    expect(body.metadata).toHaveProperty("url");
    expect(body.metadata).toHaveProperty("ua");

    await logger.stop();
  });

  describe("severity flush and pagehide", () => {
    it("flushes an error-class event without waiting for the interval, including the trigger", async () => {
      vi.useFakeTimers();
      const mockTransport = makeMockTransport();
      const logger = Crumbtrail.init({
        transportInstance: mockTransport as any,
        flushIntervalMs: 5000,
        flushBufferSize: 1000,
      });

      logger.addEvent({ type: "err", data: { msg: "boom" } });
      // The flush is deferred a microtask (taps run before the event is
      // buffered), so nothing has shipped synchronously yet.
      expect(mockTransport.sendEvents).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(0); // drain microtasks; no interval time passes
      expect(mockTransport.sendEvents).toHaveBeenCalledTimes(1);
      // The triggering event must be IN the flushed batch, not left behind.
      const batch = mockTransport.sendEvents.mock.calls[0][0];
      expect(batch).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ k: "err", d: { msg: "boom" } }),
        ]),
      );

      vi.useRealTimers();
      await logger.stop();
    });

    it("treats failed network responses as severe", async () => {
      vi.useFakeTimers();
      const mockTransport = makeMockTransport();
      const logger = Crumbtrail.init({
        transportInstance: mockTransport as any,
        flushIntervalMs: 5000,
        flushBufferSize: 1000,
      });

      logger.addEvent({ type: "net.res", data: { st: 503 } });
      await vi.advanceTimersByTimeAsync(0);

      expect(mockTransport.sendEvents).toHaveBeenCalledTimes(1);
      expect(mockTransport.sendEvents.mock.calls[0][0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ k: "net.res", d: { st: 503 } }),
        ]),
      );

      vi.useRealTimers();
      await logger.stop();
    });

    it("treats network failures (net.err) as severe", async () => {
      vi.useFakeTimers();
      const mockTransport = makeMockTransport();
      const logger = Crumbtrail.init({
        transportInstance: mockTransport as any,
        flushIntervalMs: 5000,
        flushBufferSize: 1000,
      });

      logger.addEvent({
        type: "net.err",
        data: { id: 1, method: "GET", url: "/api/x", msg: "Failed to fetch" },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(mockTransport.sendEvents).toHaveBeenCalledTimes(1);
      expect(mockTransport.sendEvents.mock.calls[0][0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ k: "net.err" }),
        ]),
      );

      vi.useRealTimers();
      await logger.stop();
    });

    it("does not treat aborted requests (net.err AbortError) as severe", async () => {
      vi.useFakeTimers();
      const mockTransport = makeMockTransport();
      const logger = Crumbtrail.init({
        transportInstance: mockTransport as any,
        flushIntervalMs: 5000,
        flushBufferSize: 1000,
      });

      logger.addEvent({
        type: "net.err",
        data: {
          id: 1,
          method: "GET",
          url: "/api/x",
          msg: "aborted",
          name: "AbortError",
        },
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockTransport.sendEvents).not.toHaveBeenCalled();

      vi.useRealTimers();
      await logger.stop();
    });

    it("keeps batching benign events on the interval", async () => {
      vi.useFakeTimers();
      const mockTransport = makeMockTransport();
      const logger = Crumbtrail.init({
        transportInstance: mockTransport as any,
        flushIntervalMs: 5000,
        flushBufferSize: 1000,
      });

      logger.mark("benign");
      logger.addEvent({ type: "net.res", data: { st: 200 } }); // ok response: not severe
      await vi.advanceTimersByTimeAsync(0);
      expect(mockTransport.sendEvents).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5000);
      expect(mockTransport.sendEvents).toHaveBeenCalledTimes(1);
      expect(mockTransport.sendEvents.mock.calls[0][0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ k: "mark", d: { label: "benign" } }),
        ]),
      );

      vi.useRealTimers();
      await logger.stop();
    });

    it("collapses an error storm into one severity flush; stragglers ride the interval", async () => {
      vi.useFakeTimers();
      const mockTransport = makeMockTransport();
      const logger = Crumbtrail.init({
        transportInstance: mockTransport as any,
        flushIntervalMs: 5000,
        flushBufferSize: 1000,
      });

      logger.addEvent({ type: "err", data: { msg: "first" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockTransport.sendEvents).toHaveBeenCalledTimes(1);

      // Storm inside the 1s rate-limit window: no additional severity flushes.
      for (let i = 0; i < 4; i++) {
        logger.addEvent({ type: "err", data: { msg: `storm ${i}` } });
      }
      await vi.advanceTimersByTimeAsync(0);
      expect(mockTransport.sendEvents).toHaveBeenCalledTimes(1);

      // The next interval flush ships the stragglers.
      await vi.advanceTimersByTimeAsync(5000);
      expect(mockTransport.sendEvents).toHaveBeenCalledTimes(2);
      const stragglers = mockTransport.sendEvents.mock.calls[1][0];
      expect(stragglers.filter((e: any) => e.k === "err")).toHaveLength(4);

      vi.useRealTimers();
      await logger.stop();
    });

    it("flushes again for a severe event after the rate-limit window", async () => {
      vi.useFakeTimers();
      const mockTransport = makeMockTransport();
      const logger = Crumbtrail.init({
        transportInstance: mockTransport as any,
        flushIntervalMs: 5000,
        flushBufferSize: 1000,
      });

      logger.addEvent({ type: "err", data: { msg: "first" } });
      await vi.advanceTimersByTimeAsync(0);
      expect(mockTransport.sendEvents).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1001); // past the 1s window, before the 5s interval
      logger.addEvent({ type: "err", data: { msg: "second" } });
      await vi.advanceTimersByTimeAsync(0);

      expect(mockTransport.sendEvents).toHaveBeenCalledTimes(2);
      expect(mockTransport.sendEvents.mock.calls[1][0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ k: "err", d: { msg: "second" } }),
        ]),
      );

      vi.useRealTimers();
      await logger.stop();
    });

    it("flushes buffered events on pagehide", async () => {
      const mockTransport = makeMockTransport();
      const logger = Crumbtrail.init({
        transportInstance: mockTransport as any,
        flushIntervalMs: 100_000,
        flushBufferSize: 1000,
      });

      logger.mark("about to leave");
      expect(mockTransport.sendEvents).not.toHaveBeenCalled();

      window.dispatchEvent(new Event("pagehide"));

      expect(mockTransport.sendEvents).toHaveBeenCalledTimes(1);
      expect(mockTransport.sendEvents.mock.calls[0][0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            k: "mark",
            d: { label: "about to leave" },
          }),
        ]),
      );

      await logger.stop();
    });

    it("stop() removes the severity tap and the pagehide listener", async () => {
      const mockTransport = makeMockTransport();
      const logger = Crumbtrail.init({
        transportInstance: mockTransport as any,
        flushIntervalMs: 100_000,
        flushBufferSize: 1000,
      });

      await logger.stop();
      const callsAfterStop = mockTransport.sendEvents.mock.calls.length;

      // Severity tap gone: a severe emit no longer schedules a flush.
      logger.addEvent({ type: "err", data: { msg: "after stop" } });
      await Promise.resolve();
      await Promise.resolve();
      // Pagehide listener gone: dispatch does not flush the buffered event.
      window.dispatchEvent(new Event("pagehide"));

      expect(mockTransport.sendEvents.mock.calls.length).toBe(callsAfterStop);
    });
  });
});
