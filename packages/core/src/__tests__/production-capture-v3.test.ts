import { afterEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../bug-logger";

function makeTransport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("production capture v3", () => {
  it("holds required-consent events outside the ring buffer and clears on revocation", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      consentMode: "required",
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    logger.addEvent({ type: "before", data: { safe: true } });
    expect((logger as any).ringBuffer.size).toBe(0);
    logger.consent(true);
    logger.addEvent({ type: "after", data: { safe: true } });
    await logger.flag();
    expect(transport.sendBugReport.mock.calls[0][1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ k: "after" })]),
    );

    logger.consent(false);
    expect((logger as any).ringBuffer.size).toBe(0);
    await logger.stop();
  });

  it("treats Global Privacy Control as required consent until explicitly granted", async () => {
    const previous = Object.getOwnPropertyDescriptor(
      navigator,
      "globalPrivacyControl",
    );
    Object.defineProperty(navigator, "globalPrivacyControl", {
      value: true,
      configurable: true,
    });
    try {
      const transport = makeTransport();
      const logger = Crumbtrail.init({
        transportInstance: transport,
        environment: false,
        domSnapshot: false,
        flushIntervalMs: 100_000,
        flushBufferSize: 1_000,
      });

      logger.addEvent({ type: "before-gpc-consent", data: { safe: true } });
      expect((logger as any).ringBuffer.size).toBe(0);
      logger.consent(true);
      logger.addEvent({ type: "after-gpc-consent", data: { safe: true } });
      await logger.flag();
      expect(transport.sendBugReport.mock.calls[0][1]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ k: "after-gpc-consent" }),
        ]),
      );
      await logger.stop();
    } finally {
      if (previous)
        Object.defineProperty(navigator, "globalPrivacyControl", previous);
      else
        delete (navigator as Navigator & { globalPrivacyControl?: boolean })
          .globalPrivacyControl;
    }
  });

  it("strips email shaped identities while retaining pseudonymous identifiers", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    logger.identify({ accountId: "account_42", userId: "person@example.test" });
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.startSession.mock.calls.at(-1)?.[1]).toMatchObject({
      accountId: "account_42",
    });
    await logger.flag();

    const report = transport.sendBugReport.mock.calls[0][0];
    expect(report.accountId).toBe("account_42");
    expect(report.userId).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("person@example.test");
    await logger.stop();
  });

  it("rejects identifiers that contain an email shaped substring", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    logger.identify({ accountId: "Alice <person@example.test>" });
    await logger.flag();

    const report = transport.sendBugReport.mock.calls[0][0];
    expect(report.accountId).toBeUndefined();
    expect(JSON.stringify(report)).not.toContain("person@example.test");
    await logger.stop();
  });

  it("refreshes an active baseline session when identity arrives after init", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    expect(transport.startSession).toHaveBeenCalledTimes(1);
    logger.identify({ accountId: "account_42", userId: "user_42" });
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.startSession).toHaveBeenCalledTimes(2);
    expect(transport.startSession.mock.calls.at(-1)?.[1]).toMatchObject({
      accountId: "account_42",
      userId: "user_42",
    });

    await logger.stop();
  });

  it("emits a visible capture gap for a shed session", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      captureSampleRate: 0,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    logger.addEvent({ type: "dropped", data: { value: "not buffered" } });
    const sent = transport.sendEvents.mock.calls.flatMap((call) => call[0]);
    expect(sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          k: "capture_gap",
          d: expect.objectContaining({ reason: "sampled_out" }),
        }),
      ]),
    );
    expect((logger as any).ringBuffer.snapshot()).toHaveLength(1);
    await logger.stop();
  });

  it("emits one sampled out gap after required consent permits transport", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      consentMode: "required",
      captureSampleRate: 0,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    expect(transport.sendEvents).not.toHaveBeenCalled();
    logger.consent(true);
    logger.consent(true);
    const gaps = transport.sendEvents.mock.calls
      .flatMap((call) => call[0])
      .filter((event) => event.k === "capture_gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0].d).toMatchObject({ reason: "sampled_out" });
    await logger.stop();
  });

  it("emits one sampled out gap after Global Privacy Control consent", async () => {
    const previous = Object.getOwnPropertyDescriptor(
      navigator,
      "globalPrivacyControl",
    );
    Object.defineProperty(navigator, "globalPrivacyControl", {
      value: true,
      configurable: true,
    });
    try {
      const transport = makeTransport();
      const logger = Crumbtrail.init({
        transportInstance: transport,
        captureSampleRate: 0,
        environment: false,
        domSnapshot: false,
        flushIntervalMs: 100_000,
        flushBufferSize: 1_000,
      });

      logger.consent(true);
      logger.consent(true);
      const gaps = transport.sendEvents.mock.calls
        .flatMap((call) => call[0])
        .filter((event) => event.k === "capture_gap");
      expect(gaps).toHaveLength(1);
      await logger.stop();
    } finally {
      if (previous)
        Object.defineProperty(navigator, "globalPrivacyControl", previous);
      else
        delete (navigator as Navigator & { globalPrivacyControl?: boolean })
          .globalPrivacyControl;
    }
  });

  it("fails closed until the initial remote policy resolves and maps the deployed capture config", async () => {
    let resolveResponse!: (value: {
      ok: boolean;
      status: number;
      json: () => Promise<unknown>;
    }) => void;
    const fetch = vi.fn(
      () =>
        new Promise<{
          ok: boolean;
          status: number;
          json: () => Promise<unknown>;
        }>((resolve) => {
          resolveResponse = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      configEndpoint: "https://capture.example.test/config",
      projectKey: "project_42",
      network: false,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    logger.addEvent({ type: "before-policy", data: { safe: true } });
    expect((logger as any).ringBuffer.size).toBe(0);
    expect(transport.startSession).not.toHaveBeenCalled();
    expect(transport.sendEvents).not.toHaveBeenCalled();

    resolveResponse({
      ok: true,
      status: 200,
      json: async () => ({
        captureConfig: {
          killSwitch: false,
          consentMode: "required",
          maskingMode: "mask_all",
          triggers: {
            tailSeconds: 17,
            uncaughtError: true,
            unhandledRejection: false,
            request5xx: true,
            explicitBeacon: true,
            serverSidePull: true,
            mask_all: true,
          },
          sampling: { captureSampleRate: 1, baselineSampleRate: 0.25 },
        },
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const request = fetch.mock.calls[0] as unknown as [string, RequestInit];
    const url = new URL(request[0]);
    expect(url.searchParams.get("projectKey")).toBe("project_42");
    expect(request[1]).toEqual({ method: "GET" });
    expect((logger as any).config).toMatchObject({
      consentMode: "required",
      maskAllText: true,
      maskAllInputs: true,
      autoFlagOnError: true,
      autoFlagOnUncaughtError: true,
      autoFlagOnUnhandledRejection: false,
      autoFlagOnRequest5xx: true,
      explicitBeacon: true,
      serverSidePull: true,
      flightRecorderTailMs: 17_000,
      captureSampleRate: 1,
      baselineSampleRate: 0.25,
    });
    expect(transport.startSession).not.toHaveBeenCalled();

    logger.consent(true);
    logger.addEvent({ type: "after-policy", data: { safe: true } });
    await logger.flag();
    expect(transport.sendBugReport.mock.calls[0][1]).toEqual(
      expect.arrayContaining([expect.objectContaining({ k: "after-policy" })]),
    );
    await logger.stop();
  });

  it("keeps capture locked when an initial policy is empty or unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ unknown: "policy" }),
      }),
    );
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      configEndpoint: "https://capture.example.test/config",
      projectKey: "project_42",
      network: false,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    await Promise.resolve();
    await Promise.resolve();
    logger.addEvent({ type: "unknown-policy", data: { safe: true } });

    expect((logger as any).remotePolicyReady).toBe(false);
    expect((logger as any).ringBuffer.size).toBe(0);
    expect(transport.startSession).not.toHaveBeenCalled();
    expect(transport.sendEvents).not.toHaveBeenCalled();
    await logger.stop();
  });

  it("resamples the baseline when a remote baseline rate changes", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0.9);
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      environment: false,
      domSnapshot: false,
    });

    (logger as any).applyRemoteConfig({
      sampling: { captureSampleRate: 1, baselineSampleRate: 0.5 },
    });

    expect((logger as any).config.baselineSampleRate).toBe(0.5);
    expect((logger as any).baselineSampled).toBe(false);
    expect(random).toHaveBeenCalledTimes(1);
    return logger.stop();
  });

  it("does not let an older config poll re enable capture after a newer kill switch", async () => {
    vi.useFakeTimers();
    const responses: Array<
      (value: { ok: boolean; status: number; json: () => Promise<unknown> }) => void
    > = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<{
            ok: boolean;
            status: number;
            json: () => Promise<unknown>;
          }>((resolve) => responses.push(resolve)),
      ),
    );
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      configEndpoint: "https://capture.example.test/config",
      projectKey: "project_42",
      configPollIntervalMs: 1_000,
      network: false,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(responses).toHaveLength(2);
    responses[1]({
      ok: true,
      status: 200,
      json: async () => ({ killSwitch: true }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect((logger as any).killSwitch).toBe(true);

    responses[0]({
      ok: true,
      status: 200,
      json: async () => ({ killSwitch: false }),
    });
    await Promise.resolve();
    await Promise.resolve();
    logger.addEvent({ type: "after-newer-kill", data: { safe: true } });

    expect((logger as any).killSwitch).toBe(true);
    expect((logger as any).ringBuffer.size).toBe(0);
    expect(transport.sendEvents).not.toHaveBeenCalled();
    await logger.stop();
  });

  it("allows remote policy to tighten masking without globally unmasking", async () => {
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      environment: false,
      domSnapshot: false,
    });

    (logger as any).applyRemoteConfig({
      masking: {
        mode: "unmasked",
        maskAllText: false,
        maskAllInputs: false,
      },
    });
    expect((logger as any).config).toMatchObject({
      maskAllText: true,
      maskAllInputs: true,
    });

    (logger as any).applyRemoteConfig({
      triggers: { mask_all: true },
    });
    expect((logger as any).config).toMatchObject({
      maskAllText: true,
      maskAllInputs: true,
    });
    await logger.stop();
  });

  it("honors a polled kill switch by clearing the ring buffer and stopping capture", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ killSwitch: true }),
      }),
    );
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      configEndpoint: "https://capture.example.test/config",
      projectKey: "project_42",
      configPollIntervalMs: 1_000,
      network: false,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    logger.addEvent({ type: "before-kill", data: { safe: true } });
    await vi.advanceTimersByTimeAsync(0);
    expect((logger as any).ringBuffer.size).toBe(0);
    await logger.flag();
    expect(transport.sendBugReport).not.toHaveBeenCalled();
    await logger.stop();
  });

  it("buffers a flight recorder window, then includes its tail in the finalized report", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      flightRecorder: true,
      flightRecorderTailMs: 10,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    logger.addEvent({ type: "before-trigger", data: { safe: true } });
    expect(transport.sendEvents).not.toHaveBeenCalled();
    const report = logger.flag();
    logger.addEvent({ type: "tail", data: { safe: true } });
    await vi.advanceTimersByTimeAsync(10);
    await report;

    const events = transport.sendBugReport.mock.calls[0][1];
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ k: "before-trigger" }),
        expect.objectContaining({ k: "tail" }),
      ]),
    );
    await logger.stop();
  });

  it("seals recorder admission at the tail deadline and settles stop during final upload", async () => {
    vi.useFakeTimers();
    let finishUpload!: () => void;
    const transport = {
      ...makeTransport(),
      sendBugReport: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finishUpload = resolve;
          }),
      ),
    };
    const logger = Crumbtrail.init({
      transportInstance: transport,
      flightRecorder: true,
      flightRecorderTailMs: 10,
      environment: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });
    logger.registerStateProvider("checkout", () => ({ step: 2 }));

    logger.addEvent({ type: "before-tail", data: { safe: true } });
    const report = logger.flag();
    logger.addEvent({ type: "in-tail", data: { safe: true } });
    await vi.advanceTimersByTimeAsync(10);
    expect((logger as any).flightRecorderState).toBe("finalizing");

    logger.addEvent({ type: "after-tail", data: { safe: true } });
    (logger as any).bus.flush();
    expect((logger as any).ringBuffer.snapshot()).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ k: "after-tail" }),
      ]),
    );
    expect(transport.sendEvents.mock.calls.flatMap((call) => call[0])).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ k: "after-tail" })]),
    );
    const reportEvents = (transport.sendBugReport as any).mock.calls[0][1];
    expect(reportEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ k: "before-tail" }),
        expect.objectContaining({
          k: "state.snap",
          d: expect.objectContaining({ name: "checkout" }),
        }),
        expect.objectContaining({ k: "dom.snap" }),
        expect.objectContaining({ k: "bug.flag" }),
      ]),
    );
    expect(reportEvents).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ k: "after-tail" })]),
    );
    const stopped = logger.stop();
    await expect(stopped).resolves.toMatchObject({ sessionId: expect.any(String) });

    finishUpload();
    await report;
  });

  it("settles a pending tail when stopped", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      flightRecorder: true,
      flightRecorderTailMs: 10_000,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    const pending = logger.flag();
    await logger.stop();
    await expect(pending).resolves.toMatchObject({ bugId: expect.any(String) });
    expect(transport.sendBugReport).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels the tail without finalizing when consent is revoked", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      flightRecorder: true,
      flightRecorderTailMs: 10_000,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    const pending = logger.flag();
    logger.consent(false);
    await expect(pending).resolves.toMatchObject({ bugId: expect.any(String) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.sendBugReport).not.toHaveBeenCalled();
    await logger.stop();
  });

  it("cancels the tail without finalizing when the kill switch arrives", async () => {
    vi.useFakeTimers();
    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      flightRecorder: true,
      flightRecorderTailMs: 10_000,
      environment: false,
      domSnapshot: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
    });

    const pending = logger.flag();
    (logger as any).applyRemoteConfig({ killSwitch: true });
    await expect(pending).resolves.toMatchObject({ bugId: expect.any(String) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(transport.sendBugReport).not.toHaveBeenCalled();
    await logger.stop();
  });
});
