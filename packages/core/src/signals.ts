import type { BugEvent } from "./types";
import { hashString } from "./signature";

/**
 * A leading indicator that a session is going wrong, raised by a {@link SignalDetector}.
 * The controller turns a raised signal into an auto-flagged report.
 */
export interface Signal {
  /** Tag applied to the auto-flagged report, e.g. `"auto:rage-click"`. */
  tag: string;
  /** Dedup key — a given key auto-flags at most once per session. */
  key: string;
  /** Human-readable note attached to the report. */
  note: string;
}

/**
 * Inspects the live event stream and raises a {@link Signal} the moment a leading
 * indicator trips. Detectors are stateful (they track rolling windows) and pure of
 * side effects — they never flag directly; the controller owns coalescing and caps.
 */
export interface SignalDetector {
  inspect(event: BugEvent): Signal | null;
}

/** Stack traces vary below the top frames (async chains, minified chunks); the top 3 identify the throw site. */
const SIGNATURE_STACK_LINES = 3;

/** Stable signature for an `err`/`rej` event, from its kind, message, and top stack frames. */
export function errorSignature(event: BugEvent): string {
  const msg = typeof event.d.msg === "string" ? event.d.msg : "";
  const stk = typeof event.d.stk === "string" ? event.d.stk : "";
  const frames = stk.split("\n").slice(0, SIGNATURE_STACK_LINES).join("\n");
  return hashString(`${event.k}|${msg}|${frames}`);
}

/**
 * Reactive baseline detector: an uncaught error or unhandled rejection. Each distinct error
 * signature flags once per session (dedup is enforced by the controller via {@link Signal.key}).
 */
export interface ErrorDetectorOptions {
  uncaughtError?: boolean;
  unhandledRejection?: boolean;
}

export function errorDetector(
  options: ErrorDetectorOptions = {},
): SignalDetector {
  return {
    inspect(event) {
      if (
        (event.k !== "err" && event.k !== "rej") ||
        (event.k === "err" && options.uncaughtError === false) ||
        (event.k === "rej" && options.unhandledRejection === false)
      )
        return null;
      const msg = typeof event.d.msg === "string" ? event.d.msg : undefined;
      return {
        tag: "auto:error",
        key: `err:${errorSignature(event)}`,
        note: msg
          ? `Auto-captured after error: ${msg}`
          : "Auto-captured after error",
      };
    },
  };
}

/** React immediately to an instrumented server error response. */
export function request5xxDetector(): SignalDetector {
  return {
    inspect(event) {
      if (event.k !== "net.res" || typeof event.d.st !== "number")
        return null;
      if (event.d.st < 500) return null;
      const status = event.d.st;
      const requestId = typeof event.d.id === "number" ? event.d.id : "unknown";
      return {
        tag: "auto:request-5xx",
        key: `request-5xx:${requestId}:${status}`,
        note: `Auto captured after request returned ${status}`,
      };
    },
  };
}

/** Drop timestamps that have aged out of the rolling window, append the new one. */
function slide(
  bucket: number[] | undefined,
  ts: number,
  windowMs: number,
): number[] {
  const arr = (bucket ?? []).filter((t) => ts - t < windowMs);
  arr.push(ts);
  return arr;
}

/** Derive a stable identity key for an interaction target descriptor. */
function targetKey(el: unknown): string {
  if (el && typeof el === "object") {
    const r = el as Record<string, unknown>;
    for (const field of [
      "sig",
      "ancestryHash",
      "testID",
      "testId",
      "id",
      "path",
    ]) {
      const v = r[field];
      if (typeof v === "string" && v) return `${field}:${v}`;
    }
    const tag = typeof r.tag === "string" ? r.tag : "?";
    const txt =
      typeof r.txt === "string"
        ? r.txt
        : typeof r.label === "string"
          ? r.label
          : "";
    return `el:${tag}:${txt}`;
  }
  return "el:unknown";
}

export interface RageClickOptions {
  /** Clicks on the same target within `windowMs` required to trip. */
  threshold: number;
  windowMs: number;
}

/**
 * Precognitive detector: the user hammering the same control (a dead button, a stuck submit)
 * is a silent failure that throws no error. Trips after `threshold` clicks on one target
 * inside `windowMs`, then resets that target's window.
 */
export function rageClickDetector(opts: RageClickOptions): SignalDetector {
  const hits = new Map<string, number[]>();
  return {
    inspect(event) {
      if (event.k !== "clk") return null;
      const key = targetKey(event.d.el ?? event.target);
      const arr = slide(hits.get(key), event.t, opts.windowMs);
      if (arr.length >= opts.threshold) {
        hits.set(key, []);
        const label = key.replace(/^[a-zA-Z]+:/, "") || "an element";
        return {
          tag: "auto:rage-click",
          key: `rage:${key}`,
          note: `Auto-captured after ${arr.length} rapid clicks on ${label}`,
        };
      }
      hits.set(key, arr);
      return null;
    },
  };
}

export interface RetryStormOptions {
  /** Requests to the same endpoint within `windowMs` required to trip. */
  threshold: number;
  windowMs: number;
  /** Failed responses (status >= 400) to the same endpoint within `windowMs` required to trip. Defaults to 2. */
  failThreshold?: number;
}

/** `METHOD path` key with the query string stripped, so `/x?t=1` and `/x?t=2` share a bucket. */
function endpointKey(method: unknown, url: unknown): string {
  const m = typeof method === "string" ? method.toUpperCase() : "GET";
  let u = typeof url === "string" ? url : "";
  const q = u.indexOf("?");
  if (q >= 0) u = u.slice(0, q);
  return `${m} ${u}`;
}

/**
 * Precognitive detector: an end user (or the app) retrying a failing action hammers one
 * endpoint. Trips on either raw request volume to an endpoint, or a cluster of failed
 * responses to it — both silent-ish signals that surface before a thrown error (if one comes).
 */
/**
 * Cap on in-flight request ids tracked for response correlation. A request whose response never
 * arrives (aborted, page torn down) would otherwise leak an entry forever; the oldest is evicted
 * past this bound. Well above any realistic in-flight count, so it never drops a live correlation.
 */
const MAX_TRACKED_REQUESTS = 1024;

export function retryStormDetector(opts: RetryStormOptions): SignalDetector {
  const failThreshold = opts.failThreshold ?? 2;
  const endpointOf = new Map<number, string>(); // in-flight request id -> endpoint key
  const reqHits = new Map<string, number[]>();
  const failHits = new Map<string, number[]>();

  const tripped = (key: string, count: number): Signal => ({
    tag: "auto:retry-storm",
    key: `retry:${key}`,
    note: `Auto-captured after ${count} rapid requests to ${key}`,
  });

  return {
    inspect(event) {
      if (event.k === "net.req") {
        const key = endpointKey(event.d.method, event.d.url);
        if (typeof event.d.id === "number") {
          endpointOf.set(event.d.id, key);
          if (endpointOf.size > MAX_TRACKED_REQUESTS) {
            const oldest = endpointOf.keys().next().value;
            if (oldest !== undefined) endpointOf.delete(oldest);
          }
        }
        const arr = slide(reqHits.get(key), event.t, opts.windowMs);
        if (arr.length >= opts.threshold) {
          reqHits.set(key, []);
          return tripped(key, arr.length);
        }
        reqHits.set(key, arr);
        return null;
      }

      if (event.k === "net.res" || event.k === "net.err") {
        // Correlate the response to its endpoint, then release the id — the request is no longer
        // in flight, so retaining it would grow the map by one entry per request over the session.
        const id = typeof event.d.id === "number" ? event.d.id : undefined;
        let key = id !== undefined ? endpointOf.get(id) : undefined;
        if (id !== undefined) endpointOf.delete(id);

        if (event.k === "net.res") {
          const st = typeof event.d.st === "number" ? event.d.st : 0;
          if (st < 400) return null;
        } else {
          // Aborts are routine (typeahead cancels, navigation) — not a failing endpoint.
          if (event.d.name === "AbortError") return null;
          // net.err carries its own method/url, so it can key an endpoint even when
          // the request event was never seen (e.g. it aged out of the id map).
          if (!key && typeof event.d.url === "string")
            key = endpointKey(event.d.method, event.d.url);
        }

        if (!key) return null;
        const arr = slide(failHits.get(key), event.t, opts.windowMs);
        if (arr.length >= failThreshold) {
          failHits.set(key, []);
          return tripped(key, arr.length);
        }
        failHits.set(key, arr);
        return null;
      }

      return null;
    },
  };
}

export interface SlowResponseOptions {
  /** A response is "slow" at or above this duration in ms. */
  thresholdMs: number;
  /** Slow responses within `windowMs` required to trip. */
  count: number;
  windowMs: number;
}

/**
 * Precognitive detector: a session where responses are piling up slow is degrading before any
 * timeout throws. Trips after `count` responses at or above `thresholdMs` inside `windowMs`.
 * Session-scoped (not per-endpoint) so it stays allocation-light — the captured events carry the
 * per-request detail. Flags once per session (dedup key is stable); the per-session cap bounds it.
 */
export function slowResponseDetector(
  opts: SlowResponseOptions,
): SignalDetector {
  let hits: number[] = [];
  return {
    inspect(event) {
      if (event.k !== "net.res") return null;
      const dur = typeof event.d.dur === "number" ? event.d.dur : 0;
      if (dur < opts.thresholdMs) return null;
      hits = slide(hits, event.t, opts.windowMs);
      if (hits.length >= opts.count) {
        hits = [];
        return {
          tag: "auto:slow-responses",
          key: "slow:session",
          note: `Auto-captured after ${opts.count}+ responses slower than ${opts.thresholdMs}ms`,
        };
      }
      return null;
    },
  };
}

export interface AbandonedFlowOptions {
  /** Max ms from the last input to a page-hide that still counts as abandonment. */
  windowMs: number;
  /** Minimum input events before an interaction is treated as a "flow" worth flagging. */
  minInputs: number;
}

/** Mutating HTTP methods — a `net.req` with one of these is treated as a form submit. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Precognitive detector: the user filled a form, then left (hid/closed the tab) without submitting
 * — a silent abandonment that throws nothing and never reaches support. Trips when the page is
 * hidden within `windowMs` of the last of at least `minInputs` inputs, with no mutating request
 * (submit) in between. A mutating `net.req` clears the pending flow. Flags once per session.
 */
export function abandonedFlowDetector(
  opts: AbandonedFlowOptions,
): SignalDetector {
  let inputCount = 0;
  let lastInputAt = -Infinity;

  const reset = () => {
    inputCount = 0;
    lastInputAt = -Infinity;
  };

  return {
    inspect(event) {
      if (event.k === "inp") {
        inputCount += 1;
        lastInputAt = event.t;
        return null;
      }
      if (event.k === "net.req") {
        const method =
          typeof event.d.method === "string"
            ? event.d.method.toUpperCase()
            : "GET";
        if (MUTATING_METHODS.has(method)) reset();
        return null;
      }
      if (event.k === "vis" && event.d.state === "hidden") {
        if (
          inputCount >= opts.minInputs &&
          event.t - lastInputAt <= opts.windowMs
        ) {
          const count = inputCount;
          reset();
          return {
            tag: "auto:abandoned-flow",
            key: "abandoned:flow",
            note: `Auto-captured after the page was hidden with ${count} unsubmitted input(s)`,
          };
        }
        return null;
      }
      return null;
    },
  };
}
