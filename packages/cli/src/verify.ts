// Verification (plans/cli-setup-wizard-design.md §4):
//   Real-event poll — poll GET /api/sessions for a NON-synthetic session, using
//   poll.ts's ported backoff. Cancellable via AbortSignal (Ctrl-C). The installer
//   is hands-off (it mints no key), so the earlier synthetic-ingest check is gone:
//   there is no key to push a marker session with. An event only arrives once the
//   user sets their key and starts the app, which this poll waits for.

import { requestJson } from "./net";
import {
  DEFAULT_INGEST_POLL_CONFIG,
  initialIngestPollState,
  nextPollDelayMs,
  recordPollAttempt,
  type IngestPollConfig,
} from "./poll";
import { color, type Ui } from "./ui";

/**
 * The reserved prefix the cloud recognizes and refuses to persist. Retained so
 * the poll still filters out any stray `cli-check-` sessions from earlier runs.
 */
export const CLI_CHECK_PREFIX = "cli-check-";

export interface SessionRow {
  id: string;
  serviceId?: string | null;
  /** ISO timestamp the cloud reports for when the session started. */
  startedAt?: string | null;
}

/**
 * How far a session's cloud-reported `startedAt` may fall BEFORE the locally
 * captured `wizardStart` and still count as "new". The local machine clock and
 * the cloud clock are independent wall clocks, so a strict `startedAt >=
 * wizardStart` compares two unsynchronized timebases: if the cloud runs behind
 * the CLI (or it stamps `startedAt` a moment before the CLI opened its window),
 * a genuine event's timestamp lands just short of `wizardStart` and is wrongly
 * rejected. This bound absorbs that gap. It is deliberately generous (skew that
 * survives NTP is rare) yet bounded, so it can't resurrect a session from a much
 * earlier run. It applies ONLY on the timestamp fallback path — when an identity
 * baseline is available (see `RealSessionGuard.baselineIds`) no clock comparison
 * happens at all.
 */
export const POLL_SKEW_TOLERANCE_MS = 2 * 60 * 1000;

export interface RealSessionGuard {
  /**
   * IDs of the sessions that already existed when the verify window opened. This
   * is the ROBUST anchor: a session is "new" iff its id is absent from this set,
   * a comparison made entirely in the cloud's own id namespace, so it is immune
   * to local/cloud clock skew AND to `startedAt`-vs-window divergence. An empty
   * set is a valid baseline ("nothing existed yet"); `undefined` means no
   * baseline was captured, so the timestamp fallback is used instead.
   */
  baselineIds?: ReadonlySet<string>;
  /**
   * Lower-bound tolerance (ms) for the timestamp fallback. Defaults to 0 so
   * pure callers keep the exact `startedAt >= wizardStart` cliff; the poll loop
   * passes {@link POLL_SKEW_TOLERANCE_MS} for its degraded (no-baseline) path.
   */
  skewToleranceMs?: number;
}

/**
 * Is `s` the user's genuine new session — not the synthetic marker, and not one
 * that predated this verify window? Prefers the skew-proof identity baseline;
 * only when none was captured does it fall back to comparing the cloud's
 * `startedAt` against the local `wizardStart` (widened by `skewToleranceMs`).
 */
export function isRealNewSession(
  s: SessionRow,
  wizardStart?: number,
  guard?: RealSessionGuard,
): boolean {
  if (s.id.startsWith(CLI_CHECK_PREFIX)) return false;
  // Primary anchor: identity in the cloud's own id namespace — never crosses
  // clock domains, so clock skew and startedAt divergence can't fool it.
  if (guard?.baselineIds) return !guard.baselineIds.has(s.id);
  // Fallback: no baseline, so trust `startedAt` but only within a bounded skew
  // tolerance, so a slightly-behind cloud clock doesn't drop a real event.
  if (wizardStart == null) return true;
  const started = s.startedAt ? Date.parse(s.startedAt) : NaN;
  const tolerance = Math.max(0, guard?.skewToleranceMs ?? 0);
  return Number.isFinite(started) && started >= wizardStart - tolerance;
}

/**
 * The first genuinely-new NON-synthetic session, if any — powers the deep link.
 * "New" is decided by {@link isRealNewSession}: the identity baseline when the
 * caller captured one (skew-proof), else a bounded-tolerance `startedAt` vs
 * `wizardStart` check. With neither baseline nor `wizardStart` the filter is
 * skipped (legacy callers / unit fixtures without timestamps).
 */
export function firstRealSession(
  sessions: SessionRow[],
  wizardStart?: number,
  guard?: RealSessionGuard,
): SessionRow | undefined {
  return sessions.find((s) => isRealNewSession(s, wizardStart, guard));
}

/** True once a genuinely-new non-synthetic session exists in the page. */
export function hasRealSession(
  sessions: SessionRow[],
  wizardStart?: number,
  guard?: RealSessionGuard,
): boolean {
  return firstRealSession(sessions, wizardStart, guard) !== undefined;
}

export type RealEventOutcome = "found" | "timedout" | "cancelled";

export interface PollRealEventResult {
  outcome: RealEventOutcome;
  /** Set when outcome is "found" — the session behind the first real event. */
  sessionId?: string;
}

export interface PollRealEventOptions {
  base: string;
  token: string;
  projectId: string;
  ui: Ui;
  /**
   * Ms epoch captured at wizard entry. Only sessions started at/after this count
   * as "the first real event" — a session from a prior run is ignored.
   */
  wizardStart?: number;
  signal?: AbortSignal;
  config?: IngestPollConfig;
  fetchImpl?: typeof fetch;
  /** Injected delay (tests); defaults to a real, abortable setTimeout. */
  sleepFn?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function realSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function fetchSessions(
  base: string,
  token: string,
  projectId: string,
  fetchImpl?: typeof fetch,
): Promise<SessionRow[]> {
  const res = await requestJson<{ sessions?: SessionRow[] }>(
    `${base}/api/sessions?projectId=${encodeURIComponent(projectId)}`,
    { token, fetchImpl },
  );
  return Array.isArray(res.sessions) ? res.sessions : [];
}

/**
 * Poll the sessions feed until a real (non-synthetic) session lands, the backoff
 * budget is exhausted, or the caller aborts (Ctrl-C). The timing policy is the
 * ported poll.ts state machine. On a TTY, a live elapsed-time status line keeps
 * a long wait from reading as a hang.
 */
export async function pollForRealEvent(
  opts: PollRealEventOptions,
): Promise<PollRealEventResult> {
  const config = opts.config ?? DEFAULT_INGEST_POLL_CONFIG;
  const sleep = opts.sleepFn ?? realSleep;
  opts.ui.out("");
  opts.ui.out(
    color.bold("Now start your dev server and load a page in your browser."),
  );
  if (!opts.ui.status) {
    opts.ui.out(
      color.dim("Waiting for the first real event… (Ctrl-C to skip)"),
    );
  }

  // Anchor "what's new" in the cloud's own id namespace BEFORE the user acts:
  // snapshot the sessions that already exist. Any session absent from this
  // baseline is genuinely new — a skew-proof signal that beats comparing the
  // cloud's `startedAt` against our local wall clock (the two clocks drift
  // independently). If the snapshot read fails we degrade to the bounded-skew
  // timestamp check. Skip the snapshot entirely if we were already cancelled,
  // so an aborted poll does zero network work.
  if (opts.signal?.aborted) {
    opts.ui.status?.();
    return { outcome: "cancelled" };
  }
  let baselineIds: Set<string> | undefined;
  try {
    const existing = await fetchSessions(
      opts.base,
      opts.token,
      opts.projectId,
      opts.fetchImpl,
    );
    baselineIds = new Set(existing.map((s) => s.id));
  } catch {
    baselineIds = undefined;
  }
  const guard: RealSessionGuard = {
    baselineIds,
    skewToleranceMs: POLL_SKEW_TOLERANCE_MS,
  };

  let state = initialIngestPollState();
  let sessionId: string | undefined;
  while (state.status === "waiting") {
    const delay = nextPollDelayMs(state, config);
    // Elapsed comes from the (pure) state machine, so the ticker is exact for
    // the budget it's counting against, not wall-clock guesswork.
    opts.ui.status?.(
      color.dim(
        `Waiting for the first real event… ${Math.round((state.elapsedMs + delay) / 1000)}s (Ctrl-C to skip)`,
      ),
    );
    await sleep(delay, opts.signal);
    if (opts.signal?.aborted) {
      opts.ui.status?.();
      return { outcome: "cancelled" };
    }
    let found: boolean;
    try {
      const sessions = await fetchSessions(
        opts.base,
        opts.token,
        opts.projectId,
        opts.fetchImpl,
      );
      const real = firstRealSession(sessions, opts.wizardStart, guard);
      found = real !== undefined;
      if (real) sessionId = real.id;
    } catch {
      // A transient read failure just means "not yet" — keep polling.
      found = false;
    }
    state = recordPollAttempt(state, found, delay, config);
  }
  opts.ui.status?.();
  return state.status === "found"
    ? { outcome: "found", sessionId }
    : { outcome: "timedout" };
}

// ── Batch verification (multi-service installer) ─────────────────────────────
//
// The sessions feed is already PROJECT-scoped and already returns serviceId per
// row, so N services need exactly ONE poll — not N. Looping pollForRealEvent
// would serialize N five-minute budgets (50 minutes for 10 services); this
// shares a single budget across the whole batch and attributes arrivals as they
// land.

/**
 * Map each service to the first real session it produced. Pure — shares the
 * exact "genuinely new session" test with {@link firstRealSession} (synthetic
 * prefix, identity baseline / bounded-skew `startedAt`), plus a skip for rows
 * the cloud didn't attribute to a service. Pass a {@link RealSessionGuard} to
 * opt into the skew-proof identity baseline; without one the behavior is the
 * legacy timestamp check.
 */
export function realSessionsByService(
  sessions: SessionRow[],
  wizardStart?: number,
  guard?: RealSessionGuard,
): Map<string, string> {
  const found = new Map<string, string>();
  // The feed is newest-first, so walk it in reverse and keep the FIRST
  // qualifying session per service — the earliest one after the window opened,
  // i.e. the event the user just caused, not whatever happened most recently.
  for (const s of [...sessions].reverse()) {
    if (!s.serviceId || found.has(s.serviceId)) continue;
    if (!isRealNewSession(s, wizardStart, guard)) continue;
    found.set(s.serviceId, s.id);
  }
  return found;
}

export interface PollServicesOptions extends Omit<
  PollRealEventOptions,
  "wizardStart"
> {
  wizardStart?: number;
  /** The services we just wired and expect events from. */
  serviceIds: string[];
  /** Fired once per service, the first time its event lands. */
  onFound?: (serviceId: string, sessionId: string) => void;
}

export interface PollServicesResult {
  /** "found" only when EVERY serviceId reported. */
  outcome: RealEventOutcome;
  /** serviceId → sessionId, for however many reported before we stopped. */
  found: Record<string, string>;
}

/**
 * Poll once for the whole batch until every wired service has reported, the
 * shared budget is exhausted, or the user aborts. Timeout and cancel both return
 * whatever arrived — stragglers never block the wizard from finishing, because
 * the wiring is already done by the time we get here.
 */
export async function pollForServices(
  opts: PollServicesOptions,
): Promise<PollServicesResult> {
  const config = opts.config ?? DEFAULT_INGEST_POLL_CONFIG;
  const sleep = opts.sleepFn ?? realSleep;
  const total = opts.serviceIds.length;
  const wanted = new Set(opts.serviceIds);
  const found = new Map<string, string>();

  opts.ui.out("");
  opts.ui.out(color.bold("Now start your services so they can report in."));
  if (!opts.ui.status) {
    opts.ui.out(color.dim("Waiting for first events… (Ctrl-C to skip)"));
  }

  let state = initialIngestPollState();
  while (state.status === "waiting") {
    const delay = nextPollDelayMs(state, config);
    opts.ui.status?.(
      color.dim(
        `Waiting for first events… ${found.size}/${total} services · ${Math.round((state.elapsedMs + delay) / 1000)}s (Ctrl-C to skip)`,
      ),
    );
    await sleep(delay, opts.signal);
    if (opts.signal?.aborted) {
      opts.ui.status?.();
      return { outcome: "cancelled", found: Object.fromEntries(found) };
    }
    try {
      const sessions = await fetchSessions(
        opts.base,
        opts.token,
        opts.projectId,
        opts.fetchImpl,
      );
      for (const [serviceId, sessionId] of realSessionsByService(
        sessions,
        opts.wizardStart,
      )) {
        if (!wanted.has(serviceId) || found.has(serviceId)) continue;
        found.set(serviceId, sessionId);
        // Clear the ticker before printing, or the lines collide.
        opts.ui.status?.();
        opts.onFound?.(serviceId, sessionId);
      }
    } catch {
      // A transient read failure just means "not yet" — keep polling.
    }
    // Terminal only when every service reported; otherwise ride the budget out.
    state = recordPollAttempt(state, found.size === total, delay, config);
  }
  opts.ui.status?.();
  return {
    outcome: state.status === "found" ? "found" : "timedout",
    found: Object.fromEntries(found),
  };
}
