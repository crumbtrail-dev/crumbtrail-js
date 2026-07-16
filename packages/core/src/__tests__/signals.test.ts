import { describe, it, expect } from "vitest";
import {
  errorDetector,
  rageClickDetector,
  retryStormDetector,
  slowResponseDetector,
  abandonedFlowDetector,
  type SignalDetector,
} from "../signals";
import type { BugEvent } from "../types";

function evt(k: string, d: Record<string, unknown>, t = 0): BugEvent {
  return { t, k, d };
}

/** Feed events through a detector and collect the signals it raises. */
function run(detector: SignalDetector, events: BugEvent[]) {
  const signals = [];
  for (const e of events) {
    const s = detector.inspect(e);
    if (s) signals.push(s);
  }
  return signals;
}

describe("errorDetector", () => {
  it("raises an auto:error signal for err and rej events", () => {
    const d = errorDetector();
    expect(
      d.inspect(evt("err", { msg: "boom", stk: "Error: boom\n at a.js:1" })),
    ).toMatchObject({
      tag: "auto:error",
    });
    expect(d.inspect(evt("rej", { msg: "nope" }))).toMatchObject({
      tag: "auto:error",
    });
  });

  it("carries the error message into the note and ignores non-errors", () => {
    const d = errorDetector();
    const s = d.inspect(evt("err", { msg: "kaboom" }));
    expect(s?.note).toContain("kaboom");
    expect(d.inspect(evt("clk", { el: { sig: "x" } }))).toBeNull();
    expect(d.inspect(evt("net.req", { id: 1, url: "/x" }))).toBeNull();
  });

  it("gives the same key for the same error signature (so it dedups once per session)", () => {
    const d = errorDetector();
    const a = d.inspect(evt("err", { msg: "boom", stk: "Error\n at a.js:1" }));
    const b = d.inspect(evt("err", { msg: "boom", stk: "Error\n at a.js:1" }));
    const c = d.inspect(
      evt("err", { msg: "different", stk: "Error\n at b.js:1" }),
    );
    expect(a?.key).toBe(b?.key);
    expect(a?.key).not.toBe(c?.key);
  });
});

describe("rageClickDetector", () => {
  const opts = { threshold: 3, windowMs: 1000 };

  it("trips after N rapid clicks on the same target", () => {
    const d = rageClickDetector(opts);
    const el = { sig: "btn-checkout" };
    const signals = run(d, [
      evt("clk", { el }, 0),
      evt("clk", { el }, 100),
      evt("clk", { el }, 200),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].tag).toBe("auto:rage-click");
  });

  it("does not trip for clicks spread beyond the window", () => {
    const d = rageClickDetector(opts);
    const el = { sig: "btn" };
    const signals = run(d, [
      evt("clk", { el }, 0),
      evt("clk", { el }, 2000),
      evt("clk", { el }, 4000),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("does not conflate clicks on different targets", () => {
    const d = rageClickDetector(opts);
    const signals = run(d, [
      evt("clk", { el: { sig: "a" } }, 0),
      evt("clk", { el: { sig: "b" } }, 50),
      evt("clk", { el: { sig: "a" } }, 100),
      evt("clk", { el: { sig: "b" } }, 150),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("gives one stable key per target so a session flags it once", () => {
    const d = rageClickDetector({ threshold: 2, windowMs: 1000 });
    const el = { sig: "btn" };
    const first = run(d, [evt("clk", { el }, 0), evt("clk", { el }, 100)]);
    const second = run(d, [evt("clk", { el }, 200), evt("clk", { el }, 300)]);
    expect(first[0].key).toBe(second[0].key);
  });

  it("ignores non-click events", () => {
    const d = rageClickDetector(opts);
    expect(d.inspect(evt("net.req", { id: 1, url: "/x" }))).toBeNull();
  });
});

describe("retryStormDetector", () => {
  const opts = { threshold: 3, windowMs: 2000 };

  it("trips when the same endpoint is requested repeatedly in the window", () => {
    const d = retryStormDetector(opts);
    const signals = run(d, [
      evt("net.req", { id: 1, method: "POST", url: "/api/pay" }, 0),
      evt("net.req", { id: 2, method: "POST", url: "/api/pay" }, 300),
      evt("net.req", { id: 3, method: "POST", url: "/api/pay" }, 600),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].tag).toBe("auto:retry-storm");
  });

  it("normalizes away the query string when keying the endpoint", () => {
    const d = retryStormDetector(opts);
    const signals = run(d, [
      evt("net.req", { id: 1, method: "GET", url: "/api/x?t=1" }, 0),
      evt("net.req", { id: 2, method: "GET", url: "/api/x?t=2" }, 300),
      evt("net.req", { id: 3, method: "GET", url: "/api/x?t=3" }, 600),
    ]);
    expect(signals).toHaveLength(1);
  });

  it("trips on repeated failed responses to the same endpoint", () => {
    const d = retryStormDetector({
      threshold: 5,
      windowMs: 2000,
      failThreshold: 2,
    });
    const signals = run(d, [
      evt("net.req", { id: 1, method: "POST", url: "/api/save" }, 0),
      evt("net.res", { id: 1, st: 500, dur: 10 }, 50),
      evt("net.req", { id: 2, method: "POST", url: "/api/save" }, 400),
      evt("net.res", { id: 2, st: 500, dur: 10 }, 450),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].tag).toBe("auto:retry-storm");
  });

  it("does not trip on successful responses", () => {
    const d = retryStormDetector({
      threshold: 5,
      windowMs: 2000,
      failThreshold: 2,
    });
    const signals = run(d, [
      evt("net.req", { id: 1, method: "GET", url: "/api/ok" }, 0),
      evt("net.res", { id: 1, st: 200, dur: 10 }, 50),
      evt("net.req", { id: 2, method: "GET", url: "/api/ok" }, 400),
      evt("net.res", { id: 2, st: 200, dur: 10 }, 450),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("does not conflate different endpoints", () => {
    const d = retryStormDetector(opts);
    const signals = run(d, [
      evt("net.req", { id: 1, method: "GET", url: "/a" }, 0),
      evt("net.req", { id: 2, method: "GET", url: "/b" }, 100),
      evt("net.req", { id: 3, method: "GET", url: "/a" }, 200),
      evt("net.req", { id: 4, method: "GET", url: "/b" }, 300),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("trips on repeated network failures (net.err) to the same endpoint", () => {
    const d = retryStormDetector({
      threshold: 5,
      windowMs: 2000,
      failThreshold: 2,
    });
    const signals = run(d, [
      evt("net.req", { id: 1, method: "POST", url: "/api/save" }, 0),
      evt(
        "net.err",
        { id: 1, method: "POST", url: "/api/save", msg: "Failed to fetch" },
        50,
      ),
      evt("net.req", { id: 2, method: "POST", url: "/api/save" }, 400),
      evt(
        "net.err",
        { id: 2, method: "POST", url: "/api/save", msg: "Failed to fetch" },
        450,
      ),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].tag).toBe("auto:retry-storm");
  });

  it("counts a mix of failed responses and network failures against one endpoint", () => {
    const d = retryStormDetector({
      threshold: 5,
      windowMs: 2000,
      failThreshold: 2,
    });
    const signals = run(d, [
      evt("net.req", { id: 1, method: "POST", url: "/api/save" }, 0),
      evt("net.res", { id: 1, st: 502, dur: 10 }, 50),
      evt("net.req", { id: 2, method: "POST", url: "/api/save" }, 400),
      evt(
        "net.err",
        { id: 2, method: "POST", url: "/api/save", msg: "Failed to fetch" },
        450,
      ),
    ]);
    expect(signals).toHaveLength(1);
  });

  it("keys a net.err by its own method/url when the request was never seen", () => {
    const d = retryStormDetector({
      threshold: 5,
      windowMs: 2000,
      failThreshold: 2,
    });
    const signals = run(d, [
      evt(
        "net.err",
        { id: 7, method: "GET", url: "/api/x?t=1", msg: "Failed to fetch" },
        0,
      ),
      evt(
        "net.err",
        { id: 8, method: "GET", url: "/api/x?t=2", msg: "Failed to fetch" },
        300,
      ),
    ]);
    expect(signals).toHaveLength(1);
  });

  it("does not count aborted requests toward the failure threshold", () => {
    const d = retryStormDetector({
      threshold: 5,
      windowMs: 2000,
      failThreshold: 2,
    });
    const signals = run(d, [
      evt("net.req", { id: 1, method: "GET", url: "/api/search" }, 0),
      evt(
        "net.err",
        {
          id: 1,
          method: "GET",
          url: "/api/search",
          msg: "aborted",
          name: "AbortError",
        },
        50,
      ),
      evt("net.req", { id: 2, method: "GET", url: "/api/search" }, 400),
      evt(
        "net.err",
        {
          id: 2,
          method: "GET",
          url: "/api/search",
          msg: "aborted",
          name: "AbortError",
        },
        450,
      ),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("releases a request id after its response, so a stale duplicate response no longer correlates", () => {
    const d = retryStormDetector({
      threshold: 5,
      windowMs: 2000,
      failThreshold: 2,
    });
    const signals = run(d, [
      evt("net.req", { id: 1, method: "POST", url: "/api/save" }, 0),
      evt("net.res", { id: 1, st: 500, dur: 10 }, 50), // 1st failure, id released here
      evt("net.res", { id: 1, st: 500, dur: 10 }, 100), // stale/duplicate — id no longer tracked
    ]);
    // Without the release, the duplicate would count as a 2nd failure and trip failThreshold.
    expect(signals).toHaveLength(0);
  });
});

describe("slowResponseDetector", () => {
  const opts = { thresholdMs: 3000, count: 3, windowMs: 10000 };

  it("trips after enough slow responses in the window", () => {
    const d = slowResponseDetector(opts);
    const signals = run(d, [
      evt("net.res", { id: 1, st: 200, dur: 3200 }, 0),
      evt("net.res", { id: 2, st: 200, dur: 4000 }, 1000),
      evt("net.res", { id: 3, st: 200, dur: 5000 }, 2000),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].tag).toBe("auto:slow-responses");
  });

  it("ignores fast responses", () => {
    const d = slowResponseDetector(opts);
    const signals = run(d, [
      evt("net.res", { id: 1, st: 200, dur: 100 }, 0),
      evt("net.res", { id: 2, st: 200, dur: 200 }, 1000),
      evt("net.res", { id: 3, st: 200, dur: 300 }, 2000),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("does not count slow responses that aged out of the window", () => {
    const d = slowResponseDetector(opts);
    const signals = run(d, [
      evt("net.res", { id: 1, st: 200, dur: 5000 }, 0),
      evt("net.res", { id: 2, st: 200, dur: 5000 }, 20000),
      evt("net.res", { id: 3, st: 200, dur: 5000 }, 40000),
    ]);
    expect(signals).toHaveLength(0);
  });
});

describe("abandonedFlowDetector", () => {
  const opts = { windowMs: 30000, minInputs: 2 };

  it("trips when the page is hidden with unsubmitted inputs", () => {
    const d = abandonedFlowDetector(opts);
    const signals = run(d, [
      evt("inp", { el: { sig: "email" }, val: "a" }, 0),
      evt("inp", { el: { sig: "email" }, val: "ab" }, 500),
      evt("vis", { state: "hidden" }, 2000),
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0].tag).toBe("auto:abandoned-flow");
  });

  it("does not trip when a mutating request (submit) happened first", () => {
    const d = abandonedFlowDetector(opts);
    const signals = run(d, [
      evt("inp", { el: { sig: "email" } }, 0),
      evt("inp", { el: { sig: "email" } }, 500),
      evt("net.req", { id: 1, method: "POST", url: "/api/signup" }, 1000),
      evt("vis", { state: "hidden" }, 2000),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("does not trip below the minimum input count", () => {
    const d = abandonedFlowDetector(opts);
    const signals = run(d, [
      evt("inp", { el: { sig: "email" } }, 0),
      evt("vis", { state: "hidden" }, 2000),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("does not trip when the hide is beyond the window after the last input", () => {
    const d = abandonedFlowDetector(opts);
    const signals = run(d, [
      evt("inp", { el: { sig: "email" } }, 0),
      evt("inp", { el: { sig: "email" } }, 500),
      evt("vis", { state: "hidden" }, 60000),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("ignores a visible (returning) event", () => {
    const d = abandonedFlowDetector(opts);
    const signals = run(d, [
      evt("inp", { el: { sig: "email" } }, 0),
      evt("inp", { el: { sig: "email" } }, 500),
      evt("vis", { state: "visible" }, 2000),
    ]);
    expect(signals).toHaveLength(0);
  });

  it("does not let a GET request clear the pending flow", () => {
    const d = abandonedFlowDetector(opts);
    const signals = run(d, [
      evt("inp", { el: { sig: "q" } }, 0),
      evt("inp", { el: { sig: "q" } }, 200),
      evt("net.req", { id: 1, method: "GET", url: "/api/autocomplete" }, 400),
      evt("vis", { state: "hidden" }, 1000),
    ]);
    expect(signals).toHaveLength(1);
  });
});
