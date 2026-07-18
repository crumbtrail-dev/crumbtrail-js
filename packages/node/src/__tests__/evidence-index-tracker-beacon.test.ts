import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// CRUMB-94: a blocked third-party analytics/ads beacon produces a high-severity "Failed to fetch"
// rejection (plus a network error) that must NOT outrank or drown a genuine first-party failure.
describe("buildEvidenceCandidates — tracker beacon downrank", () => {
  it("ranks a google-analytics beacon rejection below a first-party 4xx", () => {
    const events: BugEvent[] = [
      { t: 1000, k: "rej", d: { msg: "Failed to fetch" } },
      {
        t: 1000,
        k: "net.err",
        d: {
          id: "beacon-1",
          url: "https://www.google-analytics.com/g/collect?v=2&tid=G-XYZ",
        },
      },
    ];
    const index = {
      start: 900,
      errs: [{ t: 1000, msg: "Failed to fetch" }],
      networkErrors: [
        {
          t: 1000,
          id: "beacon-1",
          method: "POST",
          url: "https://www.google-analytics.com/g/collect?v=2&tid=G-XYZ",
        },
      ],
      failedReqs: [
        { t: 900, m: "GET", url: "/api/jobs", st: 404, id: "req-1" },
      ],
    };

    const candidates = buildEvidenceCandidates(events, index);

    const rejection = candidates.find(
      (c) => c.detector === "unhandled_rejection",
    );
    const beaconNetErr = candidates.find((c) => c.detector === "network_error");
    const firstPartyHttp = candidates.find((c) => c.detector === "http_error");

    // Beacon rejection is downranked (never suppressed) to low severity + low score.
    expect(rejection).toBeDefined();
    expect(rejection?.severity).toBe("low");
    expect(rejection?.score).toBeLessThanOrEqual(15);

    // The beacon network error (direct host match) is downranked too.
    expect(beaconNetErr?.severity).toBe("low");
    expect(beaconNetErr?.score).toBeLessThanOrEqual(15);

    // The genuine first-party failure keeps its full severity/score.
    expect(firstPartyHttp?.severity).toBe("medium");
    expect(firstPartyHttp?.score).toBe(70);

    // Emitted order is score desc: the first-party 4xx ranks above the beacon noise.
    const rank = (detector: string) =>
      candidates.findIndex((c) => c.detector === detector);
    expect(rank("http_error")).toBeLessThan(rank("unhandled_rejection"));
    expect(rank("http_error")).toBeLessThan(rank("network_error"));
  });

  it("leaves a genuine first-party 'Failed to fetch' at full severity", () => {
    const events: BugEvent[] = [
      { t: 1000, k: "rej", d: { msg: "Failed to fetch" } },
      // First-party network failure, not a tracker beacon.
      {
        t: 1000,
        k: "net.err",
        d: { id: "r1", url: "https://alertbase.ai/api/jobs" },
      },
    ];
    const index = {
      start: 900,
      errs: [{ t: 1000, msg: "Failed to fetch" }],
    };

    const candidates = buildEvidenceCandidates(events, index);
    const rejection = candidates.find(
      (c) => c.detector === "unhandled_rejection",
    );

    expect(rejection?.severity).toBe("high");
    expect(rejection?.score).toBe(82);
  });

  it("leaves an unknown cross-origin failure unchanged", () => {
    const events: BugEvent[] = [
      { t: 1000, k: "rej", d: { msg: "Failed to fetch" } },
      {
        t: 1000,
        k: "net.err",
        d: { id: "r1", url: "https://api.some-partner-crm.example/webhook" },
      },
    ];
    const index = {
      start: 900,
      errs: [{ t: 1000, msg: "Failed to fetch" }],
      networkErrors: [
        {
          t: 1000,
          id: "r1",
          method: "POST",
          url: "https://api.some-partner-crm.example/webhook",
        },
      ],
    };

    const candidates = buildEvidenceCandidates(events, index);
    const rejection = candidates.find(
      (c) => c.detector === "unhandled_rejection",
    );
    const netErr = candidates.find((c) => c.detector === "network_error");

    // Unknown origin → not on the denylist → ranking untouched.
    expect(rejection?.severity).toBe("high");
    expect(rejection?.score).toBe(82);
    expect(netErr?.severity).toBe("high");
    expect(netErr?.score).toBe(86);
  });
});
