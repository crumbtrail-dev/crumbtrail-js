// Severity-triggered fast finalize — the low-latency companion to the idle
// sweeper (session-sweeper.ts).
//
// Sessions whose producers never call POST /api/session/end (autoCapture
// backends, OTLP auto-sessions, headless jobs) normally wait for the idle
// sweep (30-min idle / 5-min tick) before index.json/candidates.jsonl exist,
// so a crashing backend's evidence can take ~40 minutes to become readable.
// This module watches ingest for HIGH-severity events and schedules a
// debounced checkpoint-finalize for the affected session, cutting worst-case
// detection latency to roughly the debounce window (~45s by default).
//
// Design constraints:
// - In-memory only, deliberately: debounce/cooldown state is NOT persisted.
//   A fast finalize lost to a process restart is fine — the mtime-based idle
//   sweeper remains the completeness backstop and finalizes the session on
//   its normal cadence. This module is purely a latency optimization.
// - Reuses the sweeper's exact (re-)finalization semantics via the shared
//   computeFinalizeNeed helper (processed flag + events-vs-meta mtime with
//   the 1s late-events epsilon). No parallel mtime logic.
// - Per-session debounce coalesces bursts. The delay is fixed from the FIRST
//   severe event (not sliding), so a continuously erroring session still
//   fires instead of being pushed out forever.
// - Global concurrency cap: postProcess is CPU-bound; sessions over the cap
//   wait in FIFO order for a slot — they are never silently dropped.
// - Per-session cooldown after every finalize ATTEMPT (success or failure):
//   a continuously erroring session re-checkpoints at a bounded cadence, and
//   a throwing finalize cannot hot-loop. Note finalize() failure rewrites
//   meta.json with processed=false, so the sweeper independently retries
//   failed sessions later.
// - All timers are unref()'d — this module must never keep a process alive.
// - Finalize moves the session dir (v2 partitioning), so the session dir is
//   re-resolved via sessions.getExistingSessionDir(id) at fire time, never
//   cached at schedule time.

import type { BugEvent } from "crumbtrail-core";
import type { SessionManager } from "./session";
import { computeFinalizeNeed } from "./session-sweeper";

export const DEFAULT_FAST_FINALIZE_DEBOUNCE_MS = 45_000;
export const DEFAULT_FAST_FINALIZE_MAX_CONCURRENT = 2;
export const DEFAULT_FAST_FINALIZE_COOLDOWN_MS = 300_000;

// Only the leading slice of a string response body is scanned for
// application-failure markers; anything past this is ignored (under-match).
const APP_FAILURE_BODY_SCAN_LIMIT = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Cheap, conservative approximation of post-process.ts's deep
 * application-failure detection (findApplicationFailure), for 2xx `net.res`
 * bodies: a shallow scan for exactly the reference markers — `ok:false` and
 * `status:"failed"`. Nothing else counts; in particular `success:false` and
 * `error:...` fields are NOT markers (the reference treats them as benign).
 * String bodies are size-bounded and pattern-matched; object bodies are
 * checked at the top level only. This intentionally UNDER-matches the
 * reference (nested failure envelopes and oversized bodies are missed) and
 * never over-matches it — the idle sweeper remains the completeness backstop.
 */
function hasApplicationFailureMarker(body: unknown): boolean {
  if (typeof body === "string") {
    const text = body.slice(0, APP_FAILURE_BODY_SCAN_LIMIT);
    return /"ok"\s*:\s*false|"status"\s*:\s*"failed"/.test(text);
  }
  // { dedup: true } bodies are placeholders for a body captured elsewhere.
  if (!isRecord(body) || body.dedup === true) return false;
  return body.ok === false || body.status === "failed";
}

/**
 * Pure predicate: does this raw ingest event indicate a HIGH-severity
 * incident? Mirrors the high-severity subset of buildEvidenceCandidates in
 * evidence-index.ts (uncaught errors/rejections, network transport errors,
 * 5xx responses, app-level 2xx failures, backend request errors/uncaughts,
 * backend 5xx, OTel ERROR spans/logs). Everything else — console output
 * (including console errors/warnings), 4xx, benign kinds — is NOT high
 * severity and never triggers a fast finalize.
 */
export function isHighSeverityEvent(event: BugEvent): boolean {
  const d = event.d;
  switch (event.k) {
    case "err":
    case "rej":
    case "net.err":
    case "backend.req.error":
    case "backend.uncaught":
      return true;
    case "net.res": {
      const status = typeof d.st === "number" ? d.st : undefined;
      if (status === undefined) return false;
      if (status >= 500) return true;
      // App-level failure hidden behind a 2xx (see hasApplicationFailureMarker).
      if (status >= 200 && status < 300)
        return hasApplicationFailureMarker(d.body);
      return false;
    }
    case "backend.req.end": {
      const error = isRecord(d.error) ? d.error : undefined;
      const status =
        finiteNumber(d.statusCode) ?? finiteNumber(error?.statusCode);
      return (status ?? 0) >= 500;
    }
    case "backend.otel.span": {
      if (d.statusCode === "ERROR") return true;
      const attributes = isRecord(d.attributes) ? d.attributes : undefined;
      const status =
        finiteNumber(attributes?.["http.response.status_code"]) ??
        finiteNumber(attributes?.["http.status_code"]);
      return (status ?? 0) >= 500;
    }
    case "backend.otel.log": {
      const severityNumber = finiteNumber(d.severityNumber);
      const severityText =
        typeof d.severityText === "string"
          ? d.severityText.toUpperCase()
          : undefined;
      return (
        (severityNumber !== undefined && severityNumber >= 17) ||
        severityText === "ERROR" ||
        severityText === "FATAL"
      );
    }
    default:
      return false;
  }
}

export type FastFinalizeOutcome = "finalized" | "refinalized" | "skipped";

/**
 * One fast-finalize attempt: re-resolve the session dir at fire time (the
 * finalize partition move makes any cached dir stale), compute the need with
 * the sweeper's exact semantics, and run sessions.finalize accordingly.
 * "skipped" means there was nothing to do (missing/corrupt/already settled).
 */
export async function runFastFinalize(
  sessions: SessionManager,
  sessionId: string,
): Promise<FastFinalizeOutcome> {
  const sessionDir = await sessions.getExistingSessionDir(sessionId);
  if (!sessionDir) return "skipped";
  const need = await computeFinalizeNeed(sessionDir);
  if (!need || (!need.needsFinalize && !need.needsRefinalize)) return "skipped";
  await sessions.finalize(sessionId, { refinalize: need.needsRefinalize });
  return need.needsRefinalize ? "refinalized" : "finalized";
}

type TimerHandle = unknown;

export interface FastFinalizeSchedulerOptions {
  /** Executes one finalize attempt for a session. May throw; may be slow. */
  runFinalize: (sessionId: string) => Promise<FastFinalizeOutcome>;
  /** Delay from the first severe event to the finalize attempt. Default 45_000. */
  debounceMs?: number;
  /** Global cap on concurrently running finalizes. Default 2. */
  maxConcurrent?: number;
  /** Minimum spacing between finalize attempts for one session. Default 300_000. */
  cooldownMs?: number;
  /** Post-success hook (e.g. AI-diagnosis scheduling). Errors are swallowed. */
  onFinalized?: (sessionId: string, refinalized: boolean) => void;
  /** Clock seam for tests. */
  now?: () => number;
  /** Timer seams for tests. Defaults are unref()'d setTimeout/clearTimeout. */
  setTimer?: (fn: () => void, delayMs: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export interface FastFinalizeScheduler {
  /** Report that a high-severity event landed for this session. Never throws. */
  notify(sessionId: string): void;
  /** Cancel all pending timers and queued work. Running finalizes drain. */
  stop(): void;
}

interface SessionScheduleState {
  timer?: TimerHandle;
  running: boolean;
  queued: boolean;
  cooldownUntil: number;
  /** A severe event landed mid-finalize; re-attempt after cooldown. */
  renotified: boolean;
}

function defaultSetTimer(fn: () => void, delayMs: number): TimerHandle {
  const timer = setTimeout(fn, delayMs);
  timer.unref?.();
  return timer;
}

function defaultClearTimer(handle: TimerHandle): void {
  clearTimeout(handle as Parameters<typeof clearTimeout>[0]);
}

export function createFastFinalizeScheduler(
  options: FastFinalizeSchedulerOptions,
): FastFinalizeScheduler {
  const debounceMs = options.debounceMs ?? DEFAULT_FAST_FINALIZE_DEBOUNCE_MS;
  const maxConcurrent =
    options.maxConcurrent ?? DEFAULT_FAST_FINALIZE_MAX_CONCURRENT;
  const cooldownMs = options.cooldownMs ?? DEFAULT_FAST_FINALIZE_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? defaultSetTimer;
  const clearTimer = options.clearTimer ?? defaultClearTimer;

  const states = new Map<string, SessionScheduleState>();
  const waitQueue: string[] = [];
  let runningCount = 0;
  let stopped = false;

  const pruneSettled = (): void => {
    const nowMs = now();
    for (const [sessionId, state] of states) {
      if (
        state.timer === undefined &&
        !state.running &&
        !state.queued &&
        state.cooldownUntil <= nowMs
      ) {
        states.delete(sessionId);
      }
    }
  };

  const scheduleAttempt = (
    sessionId: string,
    state: SessionScheduleState,
  ): void => {
    // Fixed (non-sliding) delay: at least one debounce window from now, and
    // never inside the session's cooldown window.
    const delay = Math.max(debounceMs, state.cooldownUntil - now());
    state.timer = setTimer(() => onTimerFire(sessionId), delay);
  };

  const onTimerFire = (sessionId: string): void => {
    const state = states.get(sessionId);
    if (!state) return;
    state.timer = undefined;
    if (stopped) return;
    if (runningCount >= maxConcurrent) {
      // Over the cap: wait for a slot rather than dropping the session.
      state.queued = true;
      waitQueue.push(sessionId);
      return;
    }
    startRun(sessionId, state);
  };

  const startRun = (sessionId: string, state: SessionScheduleState): void => {
    runningCount += 1;
    state.running = true;
    void (async () => {
      try {
        const outcome = await options.runFinalize(sessionId);
        if (outcome !== "skipped") {
          try {
            options.onFinalized?.(sessionId, outcome === "refinalized");
          } catch {
            // A throwing hook must never break the scheduler.
          }
        }
      } catch (err) {
        console.error(
          `[crumbtrail-node] fast finalize failed for session ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      } finally {
        state.running = false;
        runningCount -= 1;
        // Cooldown applies to every attempt, including failures — this is the
        // backoff that prevents a persistently failing finalize from hot-looping.
        state.cooldownUntil = now() + cooldownMs;
        if (state.renotified && !stopped) {
          state.renotified = false;
          scheduleAttempt(sessionId, state);
        }
        drainQueue();
      }
    })();
  };

  const drainQueue = (): void => {
    while (!stopped && runningCount < maxConcurrent && waitQueue.length > 0) {
      const sessionId = waitQueue.shift() as string;
      const state = states.get(sessionId);
      if (!state || !state.queued) continue;
      state.queued = false;
      startRun(sessionId, state);
    }
  };

  return {
    notify(sessionId: string): void {
      if (stopped) return;
      pruneSettled();
      let state = states.get(sessionId);
      if (!state) {
        state = {
          running: false,
          queued: false,
          cooldownUntil: 0,
          renotified: false,
        };
        states.set(sessionId, state);
      }
      // Coalesce: an already-pending attempt (timer or queue slot) will pick
      // up this event's evidence when it fires.
      if (state.timer !== undefined || state.queued) return;
      if (state.running) {
        // Evidence may land after the running finalize read the event log;
        // schedule a follow-up once the attempt settles (cooldown applies).
        state.renotified = true;
        return;
      }
      scheduleAttempt(sessionId, state);
    },
    stop(): void {
      stopped = true;
      for (const state of states.values()) {
        if (state.timer !== undefined) {
          clearTimer(state.timer);
          state.timer = undefined;
        }
        state.queued = false;
        state.renotified = false;
      }
      waitQueue.length = 0;
    },
  };
}

export interface FastFinalizerOptions {
  sessions: SessionManager;
  debounceMs?: number;
  maxConcurrent?: number;
  cooldownMs?: number;
  /** Post-success hook shared with the sweeper (AI-diagnosis scheduling). */
  onFinalized?: (sessionId: string, refinalized: boolean) => void;
}

export interface FastFinalizeHandle {
  /**
   * Classify a successfully-ingested batch and schedule a fast finalize when
   * it contains a high-severity event. NEVER throws into the request path —
   * classification/scheduling failures are logged to stderr and swallowed.
   */
  notifyIngest(sessionId: string, events: BugEvent[]): void;
  stop(): void;
}

/** Production wiring: classifier + scheduler + sessions.finalize. */
export function startFastFinalizer(
  options: FastFinalizerOptions,
): FastFinalizeHandle {
  const scheduler = createFastFinalizeScheduler({
    runFinalize: (sessionId) => runFastFinalize(options.sessions, sessionId),
    debounceMs: options.debounceMs,
    maxConcurrent: options.maxConcurrent,
    cooldownMs: options.cooldownMs,
    onFinalized: options.onFinalized,
  });
  return {
    notifyIngest(sessionId: string, events: BugEvent[]): void {
      try {
        if (events.some(isHighSeverityEvent)) scheduler.notify(sessionId);
      } catch (err) {
        console.error(
          `[crumbtrail-node] fast-finalize scheduling failed for session ${sessionId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    },
    stop(): void {
      scheduler.stop();
    },
  };
}
