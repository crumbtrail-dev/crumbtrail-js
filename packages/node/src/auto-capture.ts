import type { BugEvent } from "crumbtrail-core";
import {
  HeadlessRequestError,
  startHeadlessSession,
  type HeadlessSession,
} from "./headless-session";

/**
 * Canonical event kind emitted for an auto-captured backend error (crash or
 * console.error). It is deliberately NOT `backend.req.error` (that kind is
 * request-scoped and joins on a requestId this hook never has) and NOT
 * `backend.error` (that literal is a causal-graph NODE kind, not an event kind —
 * reusing it would collide). This request-less kind carries only the error and
 * the hook that surfaced it.
 *
 * Downstream wiring (all requestId-free, so every site fits): causal-graph
 * `nodeKindFor` maps it onto the `backend.error` node kind, post-process
 * `FULL_STACK_BACKEND_KINDS` + `mergeBackendEvent` summarize its error, and
 * evidence-index surfaces it as a `backend_request_error` candidate + error
 * moment — mirroring `backend.req.error` at each site.
 */
export const AUTO_CAPTURE_ERROR_EVENT = "backend.uncaught";

/** Hooks a crash/console capture handler can surface an error from. */
export type AutoCaptureSource =
  | "uncaughtException"
  | "unhandledRejection"
  | "console.error";

/**
 * Stage of the ingest pipeline that failed. `session-start` is the initial
 * `/api/session/start` handshake (a TLS/DNS/non-2xx failure here means the whole
 * capture is dark); `record` is a later `/api/events` POST for a captured error.
 */
export type AutoCaptureErrorPhase = "session-start" | "record";

/** Context handed to `onError` describing which send failed and why. */
export interface AutoCaptureErrorContext {
  phase: AutoCaptureErrorPhase;
  /** The capture source, when the failure was recording a specific error. */
  source?: AutoCaptureSource;
}

export interface AutoCaptureOptions {
  /** Ingest endpoint (baked into the injected snippet by the CLI). */
  endpoint: string;
  /**
   * Ingest key. Defaults to `process.env.CRUMBTRAIL_KEY`, which is populated from
   * the project's `.env` by `autoCapture` itself (see `loadEnv`).
   */
  authToken?: string;
  /** Explicit session id; a stable auto-generated one is used when omitted. */
  sessionId?: string;
  /** Extra session metadata merged into the headless session start. */
  metadata?: Record<string, unknown>;
  /** Injectable fetch (tests); forwarded to `startHeadlessSession`. */
  fetchImpl?: typeof fetch;
  /**
   * When true (default) attempt `process.loadEnvFile()` so the key in `.env`
   * lands in `process.env` before the session starts. Guarded: a no-op when the
   * API is unavailable (<20.12) or the `.env` file is missing/unreadable.
   */
  loadEnv?: boolean;
  /** Console object to patch (tests). Defaults to the global `console`. */
  consoleImpl?: Pick<Console, "error">;
  /** Process to hook (tests). Defaults to the global `process`. */
  processImpl?: NodeJS.Process;
  /**
   * Called after a best-effort record on an unrecoverable crash
   * (`uncaughtException` / `unhandledRejection`) IN PLACE of `process.exit`.
   * Tests inject this to assert crash semantics are preserved without killing
   * the runner. Defaults to `process.exit`.
   */
  onCrashExit?: (code: number) => void;
  /**
   * Notified whenever an ingest send fails — the session handshake could not be
   * reached (TLS/DNS/non-2xx) or a captured error's POST was rejected. Without
   * this, such failures are swallowed and capture goes silently dark. Wire it to
   * the host's logger to make ingest problems observable. It is called
   * best-effort and its own throws are swallowed, so it can never break the host
   * or the capture path. Avoid calling the patched `console.error` from here
   * during the `record` phase — prefer a real logger.
   */
  onError?: (error: unknown, context: AutoCaptureErrorContext) => void;
  /**
   * When true (or when `CRUMBTRAIL_DEBUG` is set) and no `onError` is provided,
   * ingest failures are logged to the original (unpatched) `console.error`.
   * Defaults to false so a healthy install stays quiet.
   */
  debug?: boolean;
  /**
   * Injectable monotonic-ish clock (tests). Defaults to `Date.now`. Drives the
   * lazy re-establishment backoff gate so tests can advance time deterministically
   * without real timers.
   */
  nowImpl?: () => number;
}

export interface AutoCaptureHandle {
  /** The started session id, when the session start succeeded. */
  sessionId?: string;
  /** Restore the original console.error and remove the process hooks. */
  stop(): void;
}

const MAX_MESSAGE = 500;
const MAX_STACK = 4000;
// Hard ceiling for the crash flush: the exit waits at most this long for the
// crash event's fetch to land, then exits(1) no matter what.
const CRASH_FLUSH_MS = 150;
// Lazy re-establishment backoff. When the ingest session is not live, the next
// captured error tries to (re-)start it — but only after this backoff has elapsed
// since the last failed attempt, so a persistently-down endpoint is not hammered.
// Exponential from ~1s, capped at ~30s: 1s, 2s, 4s, 8s, 16s, 30s, 30s, …
const REESTABLISH_BASE_MS = 1000;
const REESTABLISH_CAP_MS = 30_000;
// Upper bound on a server-requested `Retry-After` floor. A trusted server asking
// us to wait a few minutes is honored, but an absurd (or hostile/buggy) value
// like `Retry-After: 999999999` (~31 years) must not silently park capture until
// the process restarts — clamp it so self-heal always resumes within a bounded
// window.
const RETRY_AFTER_MAX_MS = 5 * 60_000;

/** Resolve after `ms`, without keeping the event loop alive for the timer. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms) as unknown as {
      unref?: () => void;
    };
    timer.unref?.();
  });
}

// Double-install guard, scoped to this module instance: prepend-injected into an
// app entry, `autoCapture` must be idempotent if the same module instance is
// invoked twice (e.g. test re-imports, or an entry that calls it more than once).
// A second call on the same instance returns an inert handle. (A distinct module
// instance — a separate CJS/ESM copy — has its own guard and is not covered.)
let installed = false;

/**
 * Install best-effort backend crash + console.error capture and start a headless
 * ingest session. Returns a handle whose `stop()` restores every hook.
 *
 * Crash semantics are preserved: on `uncaughtException` (and a suppressed
 * `unhandledRejection`) we best-effort record the error, bound-flush it (race the
 * record against a hard ~150ms ceiling so the crash event can actually reach
 * ingest before the process dies), then exit non-zero — the bounded flush can
 * never hang, and capture never converts a crash into survival.
 */
export async function autoCapture(
  options: AutoCaptureOptions,
): Promise<AutoCaptureHandle> {
  if (installed) {
    return { stop() {} };
  }
  installed = true;

  const proc = options.processImpl ?? process;
  const consoleRef = options.consoleImpl ?? console;

  // The real console.error, captured before we patch it. The `debug` fallback
  // logs through this so a `record`-phase failure can never re-enter the patched
  // console.error and loop.
  const originalConsoleError = consoleRef.error;
  const debug = options.debug ?? isTruthyFlag(proc.env.CRUMBTRAIL_DEBUG);

  // Surface an ingest failure that would otherwise be swallowed. Best-effort:
  // its own throws are contained so diagnostics can never break the host.
  const emitError = (
    error: unknown,
    context: AutoCaptureErrorContext,
  ): void => {
    try {
      if (options.onError) {
        options.onError(error, context);
      } else if (debug) {
        originalConsoleError.call(
          consoleRef,
          `[crumbtrail] ingest ${context.phase} failed`,
          error,
        );
      }
    } catch {
      // Diagnostics must never throw back into the host application.
    }
  };

  if (options.loadEnv !== false) {
    try {
      const loader = (proc as unknown as { loadEnvFile?: (p?: string) => void })
        .loadEnvFile;
      if (typeof loader === "function") loader.call(proc);
    } catch {
      // .env missing/unreadable, or loadEnvFile unavailable (<20.12): proceed
      // with whatever is already in the environment.
    }
  }

  const authToken = options.authToken ?? proc.env.CRUMBTRAIL_KEY;
  const now = options.nowImpl ?? Date.now;
  // Stable id reused across every (re-)establishment attempt so events correlate
  // to one logical session even if the first handshake failed and a later one
  // succeeds.
  const stableSessionId = options.sessionId ?? generateSessionId();

  // Re-establishment state. `session` is the live handle when the handshake has
  // succeeded and is still believed good. `nextAttemptAt` is the backoff gate:
  // a re-establish is only attempted once the clock reaches it. `establishing`
  // dedups concurrent attempts so a burst of captures triggers at most one
  // in-flight handshake.
  let session: HeadlessSession | undefined;
  let consecutiveFailures = 0;
  let nextAttemptAt = 0; // 0 => attempt immediately (boot / after success)
  let establishing: Promise<HeadlessSession | undefined> | undefined;
  let stopped = false;

  const startSession = (): Promise<HeadlessSession> =>
    startHeadlessSession({
      endpoint: options.endpoint,
      sessionId: stableSessionId,
      authToken,
      metadata: { ...options.metadata, capture: "auto" },
      fetchImpl: options.fetchImpl,
    });

  // Lazily (re-)establish the ingest session, bounded by the backoff gate.
  // Returns the live session, or undefined when the gate is closed, an attempt is
  // already in flight (awaited and shared), the handshake failed, or we've been
  // stopped. A failure surfaces through `emitError({ phase: "session-start" })`
  // and arms the backoff (respecting a server `Retry-After` as a floor) so the
  // endpoint is not hammered — the NEXT capture after recovery lands.
  const ensureSession = async (): Promise<HeadlessSession | undefined> => {
    if (session) return session;
    if (stopped) return undefined;
    if (establishing) return establishing;
    if (now() < nextAttemptAt) return undefined;

    establishing = (async (): Promise<HeadlessSession | undefined> => {
      try {
        const started = await startSession();
        if (stopped) return undefined;
        session = started;
        consecutiveFailures = 0;
        nextAttemptAt = 0;
        return session;
      } catch (err) {
        session = undefined;
        consecutiveFailures += 1;
        const backoff = Math.min(
          REESTABLISH_BASE_MS * 2 ** (consecutiveFailures - 1),
          REESTABLISH_CAP_MS,
        );
        const floor = Math.min(retryAfterMsOf(err) ?? 0, RETRY_AFTER_MAX_MS);
        nextAttemptAt = now() + Math.max(backoff, floor);
        emitError(err, { phase: "session-start" });
        return undefined;
      } finally {
        establishing = undefined;
      }
    })();
    return establishing;
  };

  // Boot: attempt the initial handshake. On failure the hooks still install so
  // the host's crash semantics stay intact and a later capture can self-heal.
  await ensureSession();

  let capturing = false;
  const recordLive = (
    live: HeadlessSession,
    error: unknown,
    source: AutoCaptureSource,
  ): Promise<void> =>
    live
      .record(buildErrorEvent(error, source))
      .catch((sendErr) => emitError(sendErr, { phase: "record", source }));

  // Best-effort record. Returns the in-flight record promise (already
  // `.catch`-guarded so it never rejects) so a crash handler can bound-flush it;
  // returns undefined when there is nothing to await (no session and no
  // re-establish, or a re-entrant call).
  //
  // `allowReestablish` (default false) opts into lazy re-establishment: when the
  // session is dark it first tries to (re-)start it behind the backoff gate, then
  // records. The crash path passes false — re-establishing there risks the
  // bounded exit ceiling, so a crash only records through an already-live session.
  const record = (
    error: unknown,
    source: AutoCaptureSource,
    allowReestablish = false,
  ): Promise<void> | undefined => {
    if (capturing) return undefined;
    try {
      if (session) {
        capturing = true;
        try {
          return recordLive(session, error, source);
        } finally {
          capturing = false;
        }
      }
      if (!allowReestablish || stopped) return undefined;
      // Dark session: re-establish (backoff-gated) then record. `capturing` stays
      // held for the whole async attempt so a burst of captures does not each
      // spawn their own handshake.
      capturing = true;
      const pending = (async () => {
        const live = await ensureSession();
        if (live) await recordLive(live, error, source);
      })();
      void pending.finally(() => {
        capturing = false;
      });
      return pending;
    } catch {
      // Capture must never throw back into the host application.
      capturing = false;
      return undefined;
    }
  };

  // Keep the exact original reference so stop() can restore it identically.
  const originalError = originalConsoleError;
  const patchedError = (...args: unknown[]): void => {
    const errorArg = args.find((a) => a instanceof Error);
    // The non-crash capture path opts into lazy re-establishment: if the session
    // went dark at boot (or later), this is what heals it — the next logged error
    // after the endpoint recovers re-starts the session and lands.
    record(
      errorArg ?? args.map((a) => String(a)).join(" "),
      "console.error",
      true,
    );
    originalError.apply(consoleRef, args as []);
  };
  consoleRef.error = patchedError as typeof consoleRef.error;

  const exit = (code: number): void => {
    const exiter = options.onCrashExit ?? ((c: number) => proc.exit(c));
    exiter(code);
  };

  // Crash-path re-entrancy guard: a second crash raised WHILE we are flushing the
  // first must not recurse, restart the flush, or double-exit — the process is
  // already on its way down.
  let crashing = false;

  // Bounded crash flush: on an unrecoverable crash we give the error event's
  // in-flight fetch a chance to land, but never let it hang the exit. We race the
  // record promise against a hard ~150ms ceiling, then exit(1) regardless — a
  // stalled network, a throwing record, or a rejecting record can never keep the
  // process alive. Because an installed uncaughtException/unhandledRejection
  // listener suppresses Node's default terminate-on-crash, the process stays up
  // just long enough for this flush before we re-assert the non-zero exit.
  const flushThenExit = async (
    error: unknown,
    source: AutoCaptureSource,
  ): Promise<void> => {
    if (crashing) return;
    crashing = true;
    try {
      const recordPromise = record(error, source);
      if (recordPromise) {
        await Promise.race([recordPromise, sleep(CRASH_FLUSH_MS)]);
      }
    } catch {
      // A throwing/rejecting flush must never prevent the exit below.
    } finally {
      exit(1);
    }
  };

  const onUncaught = (error: unknown): void => {
    void flushThenExit(error, "uncaughtException");
  };
  proc.on("uncaughtException", onUncaught);

  const onUnhandled = (reason: unknown): void => {
    void flushThenExit(reason, "unhandledRejection");
  };
  proc.on("unhandledRejection", onUnhandled);

  const stop = (): void => {
    if (stopped) return;
    // Setting `stopped` also cancels any pending re-establishment: the backoff
    // gate is pull-based (no background timer to clear), so a captured error after
    // stop() short-circuits and an in-flight handshake resolves to a discarded
    // session instead of arming further retries.
    stopped = true;
    if (consoleRef.error === patchedError) {
      consoleRef.error = originalError as typeof consoleRef.error;
    }
    proc.removeListener("uncaughtException", onUncaught);
    proc.removeListener("unhandledRejection", onUnhandled);
    installed = false;
  };

  return { sessionId: session?.sessionId, stop };
}

/** Truthy for `1`/`true`/`yes`/`on` (case-insensitive); false for unset/empty. */
function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

/**
 * The server-requested backoff floor (ms) from a non-2xx `Retry-After`, when the
 * error carries one. A transport failure (TLS/DNS) has none; returns undefined.
 */
function retryAfterMsOf(err: unknown): number | undefined {
  if (
    err instanceof HeadlessRequestError &&
    typeof err.retryAfterMs === "number"
  ) {
    return err.retryAfterMs;
  }
  return undefined;
}

function generateSessionId(): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `auto_${Date.now().toString(36)}_${random}`;
}

function buildErrorEvent(error: unknown, source: AutoCaptureSource): BugEvent {
  const normalized = normalizeError(error);
  return {
    t: Date.now(),
    k: AUTO_CAPTURE_ERROR_EVENT,
    d: {
      source,
      error: normalized,
    },
  };
}

function normalizeError(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (error instanceof Error) {
    return {
      name: error.name || "Error",
      message: bounded(error.message, MAX_MESSAGE),
      ...(error.stack ? { stack: bounded(error.stack, MAX_STACK) } : {}),
    };
  }
  if (typeof error === "string") {
    return { name: "Error", message: bounded(error, MAX_MESSAGE) };
  }
  return {
    name: typeof error,
    message: bounded(safeString(error), MAX_MESSAGE),
  };
}

function safeString(value: unknown): string {
  try {
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  } catch {
    return "Non-serializable value";
  }
}

function bounded(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
