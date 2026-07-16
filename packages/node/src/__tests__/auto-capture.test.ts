import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AUTO_CAPTURE_ERROR_EVENT, autoCapture } from "../auto-capture";
import type { AutoCaptureHandle } from "../auto-capture";

// A minimal stand-in for `process` the hooks attach to. It is a real
// EventEmitter (so on/removeListener/emit behave), plus the fields autoCapture
// reads: `env`, an optional `loadEnvFile`, and `exit`.
function makeFakeProcess(opts: {
  env?: Record<string, string | undefined>;
  loadEnvFile?: () => void;
}): NodeJS.Process {
  const emitter = new EventEmitter() as unknown as NodeJS.Process;
  (emitter as unknown as { env: Record<string, string | undefined> }).env =
    opts.env ?? {};
  if (opts.loadEnvFile) {
    (emitter as unknown as { loadEnvFile: () => void }).loadEnvFile =
      opts.loadEnvFile;
  }
  (emitter as unknown as { exit: (code: number) => void }).exit = vi.fn();
  return emitter;
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

// A fetch mock that records every call and returns a 200 session envelope.
function makeFetch(): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
  ) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function eventsFrom(
  calls: FetchCall[],
): Array<{ k: string; d: Record<string, unknown> }> {
  const out: Array<{ k: string; d: Record<string, unknown> }> = [];
  for (const call of calls) {
    if (!call.url.endsWith("/api/events")) continue;
    const body = JSON.parse(call.init.body as string) as {
      events?: Array<{ k: string; d: Record<string, unknown> }>;
    };
    for (const ev of body.events ?? []) out.push(ev);
  }
  return out;
}

const ENDPOINT = "http://127.0.0.1:9899";

// Every test MUST stop its handle so the module-level double-install guard
// resets before the next test.
let openHandles: AutoCaptureHandle[] = [];
function track(handle: AutoCaptureHandle): AutoCaptureHandle {
  openHandles.push(handle);
  return handle;
}
afterEach(() => {
  for (const handle of openHandles) handle.stop();
  openHandles = [];
});

describe("autoCapture", () => {
  it("loads .env and reads the ingest key from process.env.CRUMBTRAIL_KEY", async () => {
    const env: Record<string, string | undefined> = {};
    const loadEnvFile = vi.fn(() => {
      // Simulate process.loadEnvFile() populating the key from .env.
      env.CRUMBTRAIL_KEY = "bl_key_from_dotenv";
    });
    const proc = makeFakeProcess({ env, loadEnvFile });
    const { fetchImpl, calls } = makeFetch();

    const handle = track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
      }),
    );

    expect(loadEnvFile).toHaveBeenCalledTimes(1);
    const start = calls.find((c) => c.url.endsWith("/api/session/start"));
    expect(start).toBeDefined();
    expect(start!.init.headers).toMatchObject({
      "x-crumbtrail-auth": "bl_key_from_dotenv",
    });
    expect(handle.sessionId).toBeTruthy();
  });

  it("installs uncaughtException + unhandledRejection hooks and patches console.error", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const originalError = consoleImpl.error;
    const { fetchImpl } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
      }),
    );

    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(proc.listenerCount("unhandledRejection")).toBe(1);
    expect(consoleImpl.error).not.toBe(originalError);
  });

  it("does not crash when .env is missing (loadEnvFile throws)", async () => {
    const loadEnvFile = vi.fn(() => {
      throw new Error("ENOENT: no such file or directory, open '.env'");
    });
    const proc = makeFakeProcess({ env: {}, loadEnvFile });
    const { fetchImpl } = makeFetch();

    const handle = track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
      }),
    );

    expect(loadEnvFile).toHaveBeenCalledTimes(1);
    // Hooks still installed; the session simply starts without an auth token.
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(handle.sessionId).toBeTruthy();
  });

  it("preserves crash semantics: bound-flushes the record THEN exits(1) on uncaughtException (fast path)", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const { fetchImpl, calls } = makeFetch();
    // Snapshot how many event batches had reached ingest at the instant exit
    // fires: the bounded flush must have awaited the record, so this is >= 1.
    let eventsAtExit = -1;
    const onCrashExit = vi.fn(() => {
      eventsAtExit = eventsFrom(calls).length;
    });

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onCrashExit,
      }),
    );

    const boom = new Error("boom");
    proc.emit("uncaughtException", boom);
    // Let the bounded flush resolve (the mocked fetch resolves fast, so the race
    // settles on the record long before the ~150ms ceiling).
    await new Promise((r) => setTimeout(r, 0));

    expect(onCrashExit).toHaveBeenCalledWith(1);
    // Exit waited for the record: the crash event was in ingest before exit ran.
    expect(eventsAtExit).toBeGreaterThanOrEqual(1);
    const events = eventsFrom(calls);
    const crash = events.find(
      (e) =>
        e.k === AUTO_CAPTURE_ERROR_EVENT && e.d.source === "uncaughtException",
    );
    expect(crash).toBeDefined();
    expect((crash!.d.error as { message: string }).message).toBe("boom");
  });

  it("bounded crash flush: still exits(1) when the record never resolves (timeout path)", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onCrashExit = vi.fn();
    // session/start resolves so the hooks install, but the /api/events POST hangs
    // forever — the record promise never settles.
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/session/start")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Promise<Response>(() => {}); // never resolves
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onCrashExit,
      }),
    );

    const started = Date.now();
    proc.emit("uncaughtException", new Error("boom"));
    // Past the ~150ms ceiling but far under any hang.
    await new Promise((r) => setTimeout(r, 400));

    expect(onCrashExit).toHaveBeenCalledWith(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("re-entrant crash during the flush does not recurse or double-exit", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onCrashExit = vi.fn();
    // Hang the record so the first flush is still in flight when the second
    // crash fires.
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/session/start")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Promise<Response>(() => {});
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onCrashExit,
      }),
    );

    proc.emit("uncaughtException", new Error("first"));
    // Second crash raised while the first flush is still awaiting the record.
    proc.emit("uncaughtException", new Error("second"));
    await new Promise((r) => setTimeout(r, 400));

    // The re-entrancy guard collapsed both into a single bounded exit.
    expect(onCrashExit).toHaveBeenCalledTimes(1);
    expect(onCrashExit).toHaveBeenCalledWith(1);
  });

  it("suppressed unhandledRejection still exits(1) after best-effort record", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onCrashExit = vi.fn();
    const { fetchImpl, calls } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onCrashExit,
      }),
    );

    proc.emit("unhandledRejection", new Error("rejected"), Promise.resolve());
    await new Promise((r) => setTimeout(r, 0));

    expect(onCrashExit).toHaveBeenCalledWith(1);
    const events = eventsFrom(calls);
    expect(events.some((e) => e.d.source === "unhandledRejection")).toBe(true);
  });

  it("double-install guard: a second call is inert and does not re-patch", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const { fetchImpl } = makeFetch();

    const first = track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
      }),
    );
    const patchedAfterFirst = consoleImpl.error;

    const second = await autoCapture({
      endpoint: ENDPOINT,
      processImpl: proc,
      consoleImpl,
      fetchImpl,
    });

    // No second listener, no re-patch, and the inert handle exposes no session.
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(consoleImpl.error).toBe(patchedAfterFirst);
    expect(second.sessionId).toBeUndefined();

    // stop() on the inert handle is a no-op and must not restore/reset.
    second.stop();
    expect(proc.listenerCount("uncaughtException")).toBe(1);

    first.stop();
  });

  it("console.error capture records the error and passes through to the original", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const originalError = vi.fn();
    const consoleImpl = { error: originalError };
    const { fetchImpl, calls } = makeFetch();

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
      }),
    );

    const err = new Error("logged failure");
    consoleImpl.error(err, "extra context");
    await new Promise((r) => setTimeout(r, 0));

    // Pass-through: the original console.error still ran with the same args.
    expect(originalError).toHaveBeenCalledWith(err, "extra context");
    // And the error was recorded.
    const events = eventsFrom(calls);
    const logged = events.find(
      (e) => e.k === AUTO_CAPTURE_ERROR_EVENT && e.d.source === "console.error",
    );
    expect(logged).toBeDefined();
    expect((logged!.d.error as { message: string }).message).toBe(
      "logged failure",
    );
  });

  it("onError surfaces a session-start failure (endpoint unreachable / bad cert)", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onError = vi.fn();
    // session/start rejects, mirroring a TLS/DNS failure or a non-2xx ingest.
    const fetchImpl = vi.fn(async () => {
      throw new Error("SSL certificate problem");
    }) as unknown as typeof fetch;

    const handle = track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onError,
      }),
    );

    expect(onError).toHaveBeenCalledTimes(1);
    const [error, context] = onError.mock.calls[0];
    expect((error as Error).message).toContain("SSL certificate problem");
    expect(context).toEqual({ phase: "session-start" });
    // Hooks still installed, but the session is dark (no recording).
    expect(proc.listenerCount("uncaughtException")).toBe(1);
    expect(handle.sessionId).toBeUndefined();
  });

  it("onError surfaces a record failure (events POST rejected)", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onError = vi.fn();
    // session/start succeeds so hooks install, but the events POST is rejected.
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith("/api/session/start")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onError,
      }),
    );

    proc.emit("unhandledRejection", new Error("boom"), Promise.resolve());
    await new Promise((r) => setTimeout(r, 0));

    expect(onError).toHaveBeenCalled();
    const recordCall = onError.mock.calls.find(
      ([, ctx]) => (ctx as { phase: string }).phase === "record",
    );
    expect(recordCall).toBeDefined();
    expect((recordCall![1] as { source: string }).source).toBe(
      "unhandledRejection",
    );
  });

  it("debug logs a session-start failure via the original (unpatched) console.error", async () => {
    const proc = makeFakeProcess({
      env: { CRUMBTRAIL_KEY: "k", CRUMBTRAIL_DEBUG: "1" },
    });
    const originalError = vi.fn();
    const consoleImpl = { error: originalError };
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
      }),
    );

    // Logged through the reference captured before patching — not the patched
    // console.error — so a failure can never recurse through capture.
    expect(originalError).toHaveBeenCalledWith(
      "[crumbtrail] ingest session-start failed",
      expect.any(Error),
    );
  });

  it("stays quiet on failure when neither onError nor debug is set", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const originalError = vi.fn();
    const consoleImpl = { error: originalError };
    const fetchImpl = vi.fn(async () => {
      throw new Error("unreachable");
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
      }),
    );

    // No diagnostic noise for a healthy-by-default install.
    expect(originalError).not.toHaveBeenCalled();
  });

  const startCountOf = (calls: FetchCall[]): number =>
    calls.filter((c) => c.url.endsWith("/api/session/start")).length;

  it("self-heals: a dark boot session recovers on a later console.error once the endpoint returns", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const calls: FetchCall[] = [];
    let healthy = false;
    // session/start fails until `healthy` flips (endpoint recovers); /api/events
    // always succeeds so a re-established session's record lands.
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        if (String(url).endsWith("/api/session/start") && !healthy) {
          throw new Error("ECONNREFUSED");
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    ) as unknown as typeof fetch;

    const handle = track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        nowImpl: () => clock,
      }),
    );

    // Boot handshake failed: session is dark, exactly one attempt so far.
    expect(handle.sessionId).toBeUndefined();
    expect(startCountOf(calls)).toBe(1);

    // Endpoint recovers; advance the clock past the ~1s backoff gate.
    healthy = true;
    clock += 2000;

    // The next captured error lazily re-establishes the session and lands — no
    // redeploy needed.
    consoleImpl.error(new Error("late failure"));
    await new Promise((r) => setTimeout(r, 0));

    expect(startCountOf(calls)).toBe(2);
    const events = eventsFrom(calls);
    const healed = events.find(
      (e) => e.k === AUTO_CAPTURE_ERROR_EVENT && e.d.source === "console.error",
    );
    expect(healed).toBeDefined();
    expect((healed!.d.error as { message: string }).message).toBe(
      "late failure",
    );
  });

  it("backoff gate: repeated captures inside the window do not spam session-start attempts", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const calls: FetchCall[] = [];
    // Endpoint stays down: every session/start rejects.
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        throw new Error("still down");
      },
    ) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        nowImpl: () => clock,
      }),
    );

    // Boot attempt only.
    expect(startCountOf(calls)).toBe(1);

    // A burst of captures with the clock frozen inside the backoff window makes
    // NO further handshake attempts.
    for (let i = 0; i < 5; i++) {
      consoleImpl.error(new Error(`e${i}`));
      await new Promise((r) => setTimeout(r, 0));
    }
    expect(startCountOf(calls)).toBe(1);

    // Once the clock moves past the backoff, exactly one new attempt is made.
    clock += 60_000;
    consoleImpl.error(new Error("after-window"));
    await new Promise((r) => setTimeout(r, 0));
    expect(startCountOf(calls)).toBe(2);
  });

  it("respects a Retry-After header as the backoff floor before re-establishing", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const calls: FetchCall[] = [];
    // 503 + Retry-After: 120s. The exponential base backoff (~1s) is far shorter,
    // so the server floor must win.
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("busy", {
          status: 503,
          headers: { "retry-after": "120" },
        });
      },
    ) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        nowImpl: () => clock,
      }),
    );

    expect(startCountOf(calls)).toBe(1);

    // 10s later: past the ~1s exponential backoff, but under the 120s floor.
    clock += 10_000;
    consoleImpl.error(new Error("too soon"));
    await new Promise((r) => setTimeout(r, 0));
    expect(startCountOf(calls)).toBe(1);

    // Past the Retry-After floor: a new attempt is allowed.
    clock += 120_000;
    consoleImpl.error(new Error("now allowed"));
    await new Promise((r) => setTimeout(r, 0));
    expect(startCountOf(calls)).toBe(2);
  });

  it("clamps an absurd Retry-After so capture is not parked indefinitely", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const calls: FetchCall[] = [];
    // A hostile/buggy server asks us to wait ~31 years. Without a clamp this would
    // park self-heal until process restart; the clamp bounds it to a few minutes.
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response("busy", {
          status: 503,
          headers: { "retry-after": "999999999" },
        });
      },
    ) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        nowImpl: () => clock,
      }),
    );

    expect(startCountOf(calls)).toBe(1);

    // Just over the clamp ceiling (5 min): a new attempt is allowed rather than
    // being blocked for the ~31 years the header nominally requested.
    clock += 5 * 60_000 + 1000;
    consoleImpl.error(new Error("after clamp window"));
    await new Promise((r) => setTimeout(r, 0));
    expect(startCountOf(calls)).toBe(2);
  });

  it("crash path with a dark session still exits(1) within the bound and never re-establishes", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const onCrashExit = vi.fn();
    const calls: FetchCall[] = [];
    const fetchImpl = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        calls.push({ url: String(url), init: init ?? {} });
        throw new Error("down");
      },
    ) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl: { error: vi.fn() },
        fetchImpl,
        onCrashExit,
        nowImpl: () => clock,
      }),
    );

    expect(startCountOf(calls)).toBe(1); // boot attempt only

    // Advance well past the backoff so a re-establish WOULD be permitted if the
    // crash path tried one — it must not, to stay inside the bounded exit.
    clock += 60_000;
    const started = Date.now();
    proc.emit("uncaughtException", new Error("boom"));
    await new Promise((r) => setTimeout(r, 50));

    expect(onCrashExit).toHaveBeenCalledWith(1);
    expect(Date.now() - started).toBeLessThan(500);
    // No re-establish on the crash path: still just the boot attempt.
    expect(startCountOf(calls)).toBe(1);
  });

  it("onError fires again when a lazy re-establish attempt also fails", async () => {
    let clock = 1000;
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const consoleImpl = { error: vi.fn() };
    const onError = vi.fn();
    const fetchImpl = vi.fn(async () => {
      throw new Error("still unreachable");
    }) as unknown as typeof fetch;

    track(
      await autoCapture({
        endpoint: ENDPOINT,
        processImpl: proc,
        consoleImpl,
        fetchImpl,
        onError,
        nowImpl: () => clock,
      }),
    );

    // Boot failure surfaced once.
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0][1] as { phase: string }).phase).toBe(
      "session-start",
    );

    // Past the backoff, a capture triggers a re-establish that also fails —
    // surfaced again with the same phase.
    clock += 60_000;
    consoleImpl.error(new Error("trigger re-establish"));
    await new Promise((r) => setTimeout(r, 0));

    expect(onError).toHaveBeenCalledTimes(2);
    expect((onError.mock.calls[1][1] as { phase: string }).phase).toBe(
      "session-start",
    );
  });

  it("restores console.error and removes hooks on stop()", async () => {
    const proc = makeFakeProcess({ env: { CRUMBTRAIL_KEY: "k" } });
    const originalError = vi.fn();
    const consoleImpl = { error: originalError };
    const { fetchImpl } = makeFetch();

    const handle = await autoCapture({
      endpoint: ENDPOINT,
      processImpl: proc,
      consoleImpl,
      fetchImpl,
    });
    handle.stop();

    expect(consoleImpl.error).toBe(originalError);
    expect(proc.listenerCount("uncaughtException")).toBe(0);
    expect(proc.listenerCount("unhandledRejection")).toBe(0);
  });
});
