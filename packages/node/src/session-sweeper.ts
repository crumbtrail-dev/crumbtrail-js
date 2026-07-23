// Idle-session sweeper — the server-side finalizer for sessions that will
// never call POST /api/session/end themselves.
//
// Two real producers create such sessions: the CLI-injected `autoCapture`
// snippet (a backend process starts a headless session at boot and runs until
// it crashes or is killed — there is no "end") and OTLP auto-sessions (the
// ingest path windows foreign telemetry into `auto.*` sessions with no owner).
// Without a sweep these sessions accumulate meta.json + events forever but
// never produce index.json/candidates.jsonl, so every dashboard detail read
// 404s ("Session still processing or not found").
//
// Design constraints, all load-bearing:
// - mtime-based + restart-safe: idleness is judged from meta.json /
//   events.ndjson mtimes on disk, never in-memory state, so a fresh boot
//   sweeps a pre-existing backlog on its first tick.
// - finalize writes meta.json LAST (session.ts), so `events.ndjson mtime >
//   meta.json mtime` is the reliable "events landed after finalization"
//   signal — that session is re-finalized to fold the late evidence in
//   (raw events.ndjson is never deleted by cold storage, only hidden).
// - a FAILED finalize also rewrites meta.json, which refreshes the activity
//   clock — a persistently failing session naturally retries once per idle
//   window instead of hot-looping every tick.
// - serial finalization with a per-sweep cap: postProcess is CPU-bound; a
//   16-session backlog must not stampede the box.
// - CHECKPOINTS for never-idle sessions: a long-lived backend that keeps
//   streaming errors never crosses the idle threshold, so idleness alone
//   would leave its detail page 404ing for the whole process lifetime. A
//   session is therefore also finalized once it is older than checkpointMs
//   (age from meta.start), and re-finalized while active whenever its last
//   finalization (meta.json mtime — finalize writes meta last) is older than
//   checkpointMs and new events have landed since. Ingest keeps appending to
//   finalized sessions (the dir move is transparent to appendEvents), so no
//   evidence is lost between checkpoints.

import fs from "node:fs";
import path from "node:path";
import { defaultSessionStore } from "./session-store";
import type { SessionManager } from "./session";

export const DEFAULT_SWEEP_IDLE_MS = 30 * 60 * 1000;
export const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
export const DEFAULT_SWEEP_MAX_PER_SWEEP = 25;
export const DEFAULT_SWEEP_CHECKPOINT_MS = 60 * 60 * 1000;

// Guard band for the late-events comparison: postProcess itself may rewrite
// events.ndjson (merge pass) moments before finalize's closing meta write, so
// only a clearly-later events mtime counts as post-finalization activity.
export const LATE_EVENTS_EPSILON_MS = 1000;

export interface SessionSweepOptions {
  sessions: SessionManager;
  outputDir: string;
  /** Inactivity threshold before an un-finalized session is swept. */
  idleMs?: number;
  /**
   * Checkpoint threshold for sessions that never go idle: an un-finalized
   * session older than this is finalized even while active, and an active
   * finalized session with late events is re-finalized once per window.
   */
  checkpointMs?: number;
  /** Upper bound on finalizations (incl. re-finalizations) per sweep. */
  maxPerSweep?: number;
  /** Called after each successful finalize (for example, to schedule an AI opinion). */
  onFinalized?: (sessionId: string, refinalized: boolean) => void;
  /** Clock seam for tests. */
  now?: () => number;
}

export interface SessionSweepResult {
  scanned: number;
  finalized: number;
  refinalized: number;
  failed: number;
  /** Candidates left alone because they saw activity within idleMs. */
  active: number;
}

function statMtimeMs(filePath: string): number | undefined {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() ? stat.mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

async function readMeta(
  sessionDir: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw = await defaultSessionStore.readArtifact(sessionDir, "meta.json");
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw.toString("utf-8"));
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finalization-need snapshot for one session directory. Shared between the
 * idle sweeper and the severity-triggered fast finalizer (fast-finalize.ts)
 * so both consumers apply the exact same processed/mtime/epsilon semantics.
 */
export interface SessionFinalizeNeed {
  meta: Record<string, unknown>;
  metaMtime?: number;
  eventsMtime?: number;
  /** meta.processed !== true — the session has never successfully finalized. */
  needsFinalize: boolean;
  /**
   * Already processed, but events.ndjson was written clearly after the last
   * finalization (meta.json mtime + LATE_EVENTS_EPSILON_MS) — late evidence
   * must be folded in via finalize(id, { refinalize: true }).
   */
  needsRefinalize: boolean;
}

/**
 * Compute whether a session directory needs (re-)finalization. Returns
 * undefined when meta.json is missing/corrupt — finalize would throw the same
 * way every time, so callers should skip such sessions entirely.
 */
export async function computeFinalizeNeed(
  sessionDir: string,
): Promise<SessionFinalizeNeed | undefined> {
  const meta = await readMeta(sessionDir);
  if (!meta) return undefined;

  const metaMtime = statMtimeMs(path.join(sessionDir, "meta.json"));
  const eventsMtime = statMtimeMs(path.join(sessionDir, "events.ndjson"));
  const processed = meta.processed === true;

  const needsFinalize = !processed;
  const needsRefinalize =
    processed &&
    metaMtime !== undefined &&
    eventsMtime !== undefined &&
    eventsMtime > metaMtime + LATE_EVENTS_EPSILON_MS;

  return { meta, metaMtime, eventsMtime, needsFinalize, needsRefinalize };
}

/**
 * One sweep pass: finalize every idle un-finalized session, and re-finalize
 * every finalized session that received events after its last finalization.
 * Serial by design. Returns counts for logging; never throws.
 */
export async function sweepIdleSessions(
  options: SessionSweepOptions,
): Promise<SessionSweepResult> {
  const idleMs = options.idleMs ?? DEFAULT_SWEEP_IDLE_MS;
  const checkpointMs = options.checkpointMs ?? DEFAULT_SWEEP_CHECKPOINT_MS;
  const maxPerSweep = options.maxPerSweep ?? DEFAULT_SWEEP_MAX_PER_SWEEP;
  const now = options.now ?? Date.now;

  const result: SessionSweepResult = {
    scanned: 0,
    finalized: 0,
    refinalized: 0,
    failed: 0,
    active: 0,
  };

  for (const { id, dir } of await defaultSessionStore.listSessions(
    options.outputDir,
  )) {
    result.scanned += 1;
    if (result.finalized + result.refinalized + result.failed >= maxPerSweep) {
      break;
    }

    // Corrupt/unreadable meta: finalize would throw the same way every tick;
    // skip rather than burn a sweep slot on it forever.
    const need = await computeFinalizeNeed(dir);
    if (!need) continue;

    const { meta, metaMtime, eventsMtime, needsFinalize, needsRefinalize } =
      need;
    if (!needsFinalize && !needsRefinalize) continue;

    const lastActivity = Math.max(metaMtime ?? 0, eventsMtime ?? 0);
    const idle = lastActivity > 0 && now() - lastActivity > idleMs;

    // Checkpoint clause: never-idle sessions still finalize on a cadence.
    // First finalize keys off the session's age (meta.start, falling back to
    // the meta.json mtime, which appendEvents never touches — it is the
    // creation write until finalize rewrites it). Re-finalize keys off the
    // time since the LAST finalization (meta.json mtime), so an active
    // erroring backend re-checkpoints once per window, not every tick.
    const startMs =
      typeof meta.start === "number" && Number.isFinite(meta.start)
        ? meta.start
        : (metaMtime ?? 0);
    const checkpointRef = needsFinalize ? startMs : (metaMtime ?? 0);
    const overdue = checkpointRef > 0 && now() - checkpointRef > checkpointMs;

    if (!idle && !overdue) {
      result.active += 1;
      continue;
    }

    try {
      await options.sessions.finalize(id, { refinalize: needsRefinalize });
      if (needsRefinalize) result.refinalized += 1;
      else result.finalized += 1;
      try {
        options.onFinalized?.(id, needsRefinalize);
      } catch {
        // A throwing hook must never abort the sweep.
      }
    } catch {
      // finalize() persists its own failure state (meta.processed=false with a
      // fresh meta mtime), so this session backs off for a full idle window.
      result.failed += 1;
    }
  }

  return result;
}

export interface SessionSweeperHandle {
  stop(): void;
  /** Run one sweep immediately (test seam; also used by the interval). */
  sweepNow(): Promise<SessionSweepResult>;
}

/**
 * Start the periodic sweeper. The timer is unref'd so it never keeps a
 * process alive, and ticks never overlap (a long postProcess simply delays
 * the next pass).
 */
export function startSessionSweeper(
  options: SessionSweepOptions & {
    intervalMs?: number;
    /** Called with each sweep's counts whenever a sweep did any work. */
    onSweep?: (result: SessionSweepResult) => void;
  },
): SessionSweeperHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  let sweeping = false;
  let stopped = false;

  const sweepNow = async (): Promise<SessionSweepResult> => {
    const result = await sweepIdleSessions(options);
    if (
      result.finalized + result.refinalized + result.failed > 0 &&
      options.onSweep
    ) {
      options.onSweep(result);
    }
    return result;
  };

  const tick = (): void => {
    if (sweeping || stopped) return;
    sweeping = true;
    void sweepNow()
      .catch(() => {
        // sweepIdleSessions never throws by contract; belt-and-braces.
      })
      .finally(() => {
        sweeping = false;
      });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    sweepNow,
  };
}
