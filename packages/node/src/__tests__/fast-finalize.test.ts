import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BugEvent } from "crumbtrail-core";
import { SessionManager } from "../session";
import {
  isHighSeverityEvent,
  createFastFinalizeScheduler,
  runFastFinalize,
  type FastFinalizeOutcome,
} from "../fast-finalize";

function event(k: string, d: Record<string, unknown> = {}): BugEvent {
  return { t: 1000, k, d };
}

describe("isHighSeverityEvent", () => {
  const highSeverity: Array<[string, BugEvent]> = [
    ["uncaught error", event("err", { msg: "boom" })],
    ["unhandled rejection", event("rej", { msg: "boom" })],
    ["network transport error", event("net.err", { url: "/x" })],
    ["net.res 500", event("net.res", { st: 500 })],
    ["net.res 503", event("net.res", { st: 503 })],
    [
      "net.res 2xx app failure (string ok:false)",
      event("net.res", { st: 200, body: '{"ok": false, "data": null}' }),
    ],
    [
      "net.res 2xx app failure (string status failed)",
      event("net.res", { st: 200, body: '{"status": "failed"}' }),
    ],
    [
      "net.res 2xx app failure (object ok:false)",
      event("net.res", { st: 201, body: { ok: false } }),
    ],
    [
      "net.res 2xx app failure (object status failed)",
      event("net.res", { st: 200, body: { status: "failed" } }),
    ],
    ["backend request error", event("backend.req.error", {})],
    ["backend uncaught", event("backend.uncaught", {})],
    ["backend.req.end 500", event("backend.req.end", { statusCode: 500 })],
    [
      "backend.req.end nested error statusCode 502",
      event("backend.req.end", { error: { statusCode: 502 } }),
    ],
    [
      "otel span statusCode ERROR",
      event("backend.otel.span", { statusCode: "ERROR" }),
    ],
    [
      "otel span http.response.status_code 500",
      event("backend.otel.span", {
        attributes: { "http.response.status_code": 500 },
      }),
    ],
    [
      "otel span legacy http.status_code 503",
      event("backend.otel.span", { attributes: { "http.status_code": 503 } }),
    ],
    [
      "otel log severityNumber 17",
      event("backend.otel.log", { severityNumber: 17 }),
    ],
    [
      "otel log severityText ERROR",
      event("backend.otel.log", { severityText: "ERROR" }),
    ],
    [
      "otel log severityText fatal (case-insensitive)",
      event("backend.otel.log", { severityText: "fatal" }),
    ],
  ];

  const benign: Array<[string, BugEvent]> = [
    ["console warning", event("con", { lv: "warn", msg: "deprecated" })],
    ["console error", event("con", { lv: "error", msg: "render issue" })],
    ["net.res 404", event("net.res", { st: 404 })],
    ["net.res 400", event("net.res", { st: 400 })],
    ["net.res 200 plain success", event("net.res", { st: 200 })],
    [
      "net.res 200 healthy body",
      event("net.res", { st: 200, body: '{"ok": true}' }),
    ],
    // Non-reference markers: post-process.ts findApplicationFailure matches
    // ONLY ok:false / status:"failed", so these must never fast-finalize.
    [
      "net.res 200 string success:false (not a reference marker)",
      event("net.res", { st: 200, body: '{"success":false}' }),
    ],
    [
      "net.res 200 string error message (not a reference marker)",
      event("net.res", { st: 200, body: '{"error": "denied"}' }),
    ],
    [
      "net.res 200 object success:false (not a reference marker)",
      event("net.res", { st: 200, body: { success: false } }),
    ],
    [
      "net.res 200 object error string (not a reference marker)",
      event("net.res", { st: 200, body: { error: "denied" } }),
    ],
    [
      "net.res 200 object error record (not a reference marker)",
      event("net.res", { st: 200, body: { error: { code: "E_FAIL" } } }),
    ],
    [
      "net.res 200 ok:true with benign error field (string)",
      event("net.res", {
        st: 200,
        body: '{"ok":true,"lastRun":{"error":"timeout"}}',
      }),
    ],
    [
      "net.res 200 ok:true with benign error field (object)",
      event("net.res", {
        st: 200,
        body: { ok: true, lastRun: { error: "timeout" } },
      }),
    ],
    [
      "net.res 200 empty-string error body",
      event("net.res", { st: 200, body: '{"error":""}' }),
    ],
    [
      "net.res 200 empty-array error body",
      event("net.res", { st: 200, body: '{"error":[]}' }),
    ],
    [
      "net.res 200 error:null body (conservative)",
      event("net.res", { st: 200, body: '{"error": null}' }),
    ],
    [
      "net.res 200 dedup body placeholder",
      event("net.res", { st: 200, body: { dedup: true } }),
    ],
    [
      "net.res without status (under-match)",
      event("net.res", { body: '{"ok":false}' }),
    ],
    [
      "net.res 200 marker past the scan bound (under-match)",
      event("net.res", {
        st: 200,
        body: `{"data":"${"x".repeat(4000)}","ok":false}`,
      }),
    ],
    ["backend.req.end 400", event("backend.req.end", { statusCode: 400 })],
    ["backend.req.end 200", event("backend.req.end", { statusCode: 200 })],
    ["backend.req.end without status", event("backend.req.end", {})],
    [
      "otel span OK with 200",
      event("backend.otel.span", {
        statusCode: "OK",
        attributes: { "http.response.status_code": 200 },
      }),
    ],
    [
      "otel log INFO",
      event("backend.otel.log", { severityNumber: 9, severityText: "INFO" }),
    ],
    ["navigation", event("nav", { to: "/" })],
    ["click", event("click", {})],
    ["backend request start", event("backend.req.start", {})],
  ];

  it.each(highSeverity)("classifies %s as high severity", (_name, evt) => {
    expect(isHighSeverityEvent(evt)).toBe(true);
  });

  it.each(benign)("classifies %s as NOT high severity", (_name, evt) => {
    expect(isHighSeverityEvent(evt)).toBe(false);
  });
});

// --- Scheduler tests against injected clock/timer seams (no real waits). ---

interface FakeTimer {
  fn: () => void;
  at: number;
  cleared: boolean;
  fired: boolean;
}

function createClock() {
  let nowMs = 0;
  const timers: FakeTimer[] = [];

  const now = () => nowMs;
  const setTimer = (fn: () => void, delayMs: number) => {
    const timer: FakeTimer = {
      fn,
      at: nowMs + delayMs,
      cleared: false,
      fired: false,
    };
    timers.push(timer);
    return timer;
  };
  const clearTimer = (handle: unknown) => {
    (handle as FakeTimer).cleared = true;
  };

  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  /** Advance the fake clock, firing due timers in order and settling async runs. */
  const advance = async (ms: number) => {
    const target = nowMs + ms;
    for (;;) {
      const due = timers
        .filter((t) => !t.cleared && !t.fired && t.at <= target)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      nowMs = Math.max(nowMs, due.at);
      due.fired = true;
      due.fn();
      await flush();
    }
    nowMs = target;
    await flush();
  };

  return { now, setTimer, clearTimer, advance, flush, timers };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("createFastFinalizeScheduler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("debounces: a burst of notifies coalesces into one finalize after debounceMs", async () => {
    const clock = createClock();
    const runFinalize = vi.fn(
      async (): Promise<FastFinalizeOutcome> => "finalized",
    );
    const scheduler = createFastFinalizeScheduler({
      runFinalize,
      debounceMs: 45_000,
      cooldownMs: 300_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.notify("s1");
    await clock.advance(10);
    scheduler.notify("s1");
    scheduler.notify("s1");

    await clock.advance(44_000);
    expect(runFinalize).not.toHaveBeenCalled();

    await clock.advance(1_000);
    expect(runFinalize).toHaveBeenCalledTimes(1);
    expect(runFinalize).toHaveBeenCalledWith("s1");
    scheduler.stop();
  });

  it("enforces the global concurrency cap and never drops waiting sessions", async () => {
    const clock = createClock();
    const gates = new Map<string, ReturnType<typeof deferred<void>>>();
    let running = 0;
    let maxObserved = 0;
    const runFinalize = vi.fn(
      async (sessionId: string): Promise<FastFinalizeOutcome> => {
        running += 1;
        maxObserved = Math.max(maxObserved, running);
        const gate = deferred<void>();
        gates.set(sessionId, gate);
        try {
          await gate.promise;
        } finally {
          running -= 1;
        }
        return "finalized";
      },
    );
    const scheduler = createFastFinalizeScheduler({
      runFinalize,
      debounceMs: 100,
      maxConcurrent: 2,
      cooldownMs: 1_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.notify("s1");
    scheduler.notify("s2");
    scheduler.notify("s3");
    await clock.advance(100);

    // Only two run; the third waits for a slot.
    expect(runFinalize).toHaveBeenCalledTimes(2);
    expect(maxObserved).toBe(2);

    gates.get("s1")?.resolve();
    await clock.flush();

    // s3 got the freed slot — waited, not dropped.
    expect(runFinalize).toHaveBeenCalledTimes(3);
    expect(runFinalize.mock.calls.map((c) => c[0])).toEqual(["s1", "s2", "s3"]);
    expect(maxObserved).toBe(2);

    gates.get("s2")?.resolve();
    gates.get("s3")?.resolve();
    await clock.flush();
    scheduler.stop();
  });

  it("applies a per-session cooldown so a continuously erroring session re-checkpoints at bounded cadence", async () => {
    const clock = createClock();
    const runFinalize = vi.fn(
      async (): Promise<FastFinalizeOutcome> => "finalized",
    );
    const scheduler = createFastFinalizeScheduler({
      runFinalize,
      debounceMs: 45_000,
      cooldownMs: 300_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.notify("s1");
    await clock.advance(45_000);
    expect(runFinalize).toHaveBeenCalledTimes(1);

    // Severe events keep landing right after the attempt.
    scheduler.notify("s1");
    scheduler.notify("s1");

    // A debounce window passes — still inside the cooldown, no second attempt.
    await clock.advance(45_000);
    expect(runFinalize).toHaveBeenCalledTimes(1);

    // Cooldown expires — exactly one more attempt fires.
    await clock.advance(300_000);
    expect(runFinalize).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("backs off after a throwing finalize instead of hot-looping", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const clock = createClock();
    const runFinalize = vi.fn(async (): Promise<FastFinalizeOutcome> => {
      throw new Error("postProcess exploded");
    });
    const scheduler = createFastFinalizeScheduler({
      runFinalize,
      debounceMs: 45_000,
      cooldownMs: 300_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.notify("s1");
    await clock.advance(45_000);
    expect(runFinalize).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining("fast finalize failed for session s1"),
    );

    // Immediate re-notify does not hot-loop: the cooldown gates the retry.
    scheduler.notify("s1");
    await clock.advance(45_000);
    expect(runFinalize).toHaveBeenCalledTimes(1);
    await clock.advance(300_000);
    expect(runFinalize).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("re-schedules after cooldown when severe events land mid-finalize", async () => {
    const clock = createClock();
    const gate = deferred<void>();
    let calls = 0;
    const runFinalize = vi.fn(async (): Promise<FastFinalizeOutcome> => {
      calls += 1;
      if (calls === 1) await gate.promise;
      return "finalized";
    });
    const scheduler = createFastFinalizeScheduler({
      runFinalize,
      debounceMs: 1_000,
      cooldownMs: 60_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.notify("s1");
    await clock.advance(1_000);
    expect(runFinalize).toHaveBeenCalledTimes(1);

    // Evidence lands while the finalize is still reading/postprocessing.
    scheduler.notify("s1");
    gate.resolve();
    await clock.flush();

    // Follow-up attempt is scheduled and fires once the cooldown elapses.
    expect(runFinalize).toHaveBeenCalledTimes(1);
    await clock.advance(60_000);
    expect(runFinalize).toHaveBeenCalledTimes(2);
    scheduler.stop();
  });

  it("invokes onFinalized with the refinalized flag and skips it for no-ops", async () => {
    const clock = createClock();
    const outcomes: FastFinalizeOutcome[] = [
      "finalized",
      "refinalized",
      "skipped",
    ];
    const runFinalize = vi.fn(
      async (): Promise<FastFinalizeOutcome> => outcomes.shift() ?? "skipped",
    );
    const onFinalized = vi.fn();
    const scheduler = createFastFinalizeScheduler({
      runFinalize,
      debounceMs: 1_000,
      cooldownMs: 2_000,
      onFinalized,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.notify("s1");
    await clock.advance(1_000);
    scheduler.notify("s1");
    await clock.advance(2_000);
    scheduler.notify("s1");
    await clock.advance(2_000);

    expect(runFinalize).toHaveBeenCalledTimes(3);
    expect(onFinalized.mock.calls).toEqual([
      ["s1", false],
      ["s1", true],
    ]);
    scheduler.stop();
  });

  it("stop() cancels pending debounce timers and queued work", async () => {
    const clock = createClock();
    const runFinalize = vi.fn(
      async (): Promise<FastFinalizeOutcome> => "finalized",
    );
    const scheduler = createFastFinalizeScheduler({
      runFinalize,
      debounceMs: 1_000,
      now: clock.now,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });

    scheduler.notify("s1");
    scheduler.notify("s2");
    scheduler.stop();

    await clock.advance(10_000);
    expect(runFinalize).not.toHaveBeenCalled();
    expect(clock.timers.every((t) => t.cleared || t.fired)).toBe(true);

    // Notifies after stop are ignored.
    scheduler.notify("s3");
    await clock.advance(10_000);
    expect(runFinalize).not.toHaveBeenCalled();
  });
});

describe("runFastFinalize", () => {
  let tmpDir: string;
  let sessions: SessionManager;

  const withSessions = async (fn: () => Promise<void>): Promise<void> => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-fastfin-"));
    sessions = new SessionManager(tmpDir);
    try {
      await fn();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };

  function backdate(filePath: string, ageMs: number): void {
    const when = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, when, when);
  }

  it("finalizes an un-finalized session and produces index.json", async () => {
    await withSessions(async () => {
      await sessions.create("fast_1", { app: "svc" });
      const dir = await sessions.getSessionDir("fast_1");
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        JSON.stringify({ t: Date.now(), k: "backend.uncaught", d: {} }) + "\n",
      );

      const outcome = await runFastFinalize(sessions, "fast_1");

      expect(outcome).toBe("finalized");
      const finalDir = await sessions.getExistingSessionDir("fast_1") as string;
      expect(fs.existsSync(path.join(finalDir, "index.json"))).toBe(true);
      const meta = JSON.parse(
        fs.readFileSync(path.join(finalDir, "meta.json"), "utf-8"),
      );
      expect(meta.processed).toBe(true);
    });
  });

  it("skips a settled session and refinalizes only after late events land", async () => {
    await withSessions(async () => {
      await sessions.create("fast_2", { app: "svc" });
      fs.writeFileSync(
        path.join(await sessions.getSessionDir("fast_2"), "events.ndjson"),
        JSON.stringify({ t: Date.now(), k: "backend.uncaught", d: {} }) + "\n",
      );
      await sessions.finalize("fast_2");

      // Settled: nothing to do.
      expect(await runFastFinalize(sessions, "fast_2")).toBe("skipped");

      // Late events land clearly after the finalize (beyond the 1s epsilon).
      const dir = await sessions.getExistingSessionDir("fast_2") as string;
      backdate(path.join(dir, "meta.json"), 5_000);
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        [
          JSON.stringify({ t: Date.now(), k: "backend.uncaught", d: {} }),
          JSON.stringify({
            t: Date.now(),
            k: "backend.uncaught",
            d: { late: true },
          }),
        ].join("\n") + "\n",
      );

      expect(await runFastFinalize(sessions, "fast_2")).toBe("refinalized");
    });
  });

  it("skips unknown sessions", async () => {
    await withSessions(async () => {
      expect(await runFastFinalize(sessions, "does_not_exist")).toBe("skipped");
    });
  });
});
