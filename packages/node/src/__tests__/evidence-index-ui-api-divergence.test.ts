import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function uiNum(
  t: number,
  items: Array<{ label: string; value: number; unit?: string }>,
  region = "dl.totals",
): BugEvent {
  return { t, k: "ui.num", d: { region, items } };
}

function netRes(t: number, id: string, body: unknown, st = 200): BugEvent {
  return {
    t,
    k: "net.res",
    d: {
      id,
      st,
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  };
}

describe("buildEvidenceCandidates — ui_api_divergence", () => {
  it("fires when the UI shows Total 199.00 but the response total is 215.42", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 215.42, subtotal: 199.0 }),
      uiNum(1500, [{ label: "Total", value: 199.0, unit: "$" }]),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "ui_api_divergence");
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("medium");
    expect(cand!.score).toBe(55);
    expect(cand!.confidence).toBe("medium");
    expect(cand!.anchor.requestId).toBe("r1");
    expect(cand!.anchor.message).toContain("Total");
    expect(cand!.anchor.message).toContain("215.42");
  });

  it("stays silent when the UI matches the response", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 215.42 }),
      uiNum(1500, [{ label: "Total", value: 215.42 }]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
  });

  it("stays silent when the difference is within the 1 cent epsilon", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 215.42 }),
      uiNum(1500, [{ label: "Total", value: 215.43 }]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
  });

  it("only considers responses received since the last navigation", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 215.42 }),
      uiNum(3000, [{ label: "Total", value: 199.0 }]),
    ];
    const index = {
      start: 1000,
      navs: [{ t: 2000, to: "https://shop.example/checkout" }],
    };
    // The only divergent response predates the nav → silent.
    expect(
      buildEvidenceCandidates(events, index).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
    // Same response after the nav → fires.
    const eventsAfterNav: BugEvent[] = [
      netRes(2500, "r1", { total: 215.42 }),
      uiNum(3000, [{ label: "Total", value: 199.0 }]),
    ];
    expect(
      buildEvidenceCandidates(eventsAfterNav, index).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(true);
  });

  it("treats a response at the navigation instant as belonging to the old page", () => {
    const index = {
      start: 1000,
      navs: [{ t: 2000, to: "https://shop.example/checkout" }],
    };
    const events: BugEvent[] = [
      netRes(2000, "r1", { total: 215.42 }),
      uiNum(3000, [{ label: "Total", value: 199.0 }]),
    ];
    expect(
      buildEvidenceCandidates(events, index).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
  });

  it("stays silent for an unreadable ([REDACTED]) response body", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", "[REDACTED]"),
      uiNum(1500, [{ label: "Total", value: 199.0 }]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
  });

  it("stays silent for a redacted label", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 215.42 }),
      uiNum(1500, [{ label: "[REDACTED]", value: 199.0 }]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
  });

  it("stays silent when exact-name response fields conflict across responses", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 215.42 }),
      netRes(1100, "r2", { total: 220.0 }),
      uiNum(1500, [{ label: "Total", value: 199.0 }]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
  });

  it("prefers the exact full-name match over count-like stem siblings (probe regression)", () => {
    // {totalItems: 3} must not pollute the exact `total` match.
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 215.42, totalItems: 3 }),
      uiNum(1500, [{ label: "Total", value: 199.0 }]),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "ui_api_divergence");
    expect(cand).toBeDefined();
    expect(cand!.anchor.message).toContain("215.42");
  });

  it("stays silent when the only same-stem field is count-like (probe regression)", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { totalItems: 3 }),
      uiNum(1500, [{ label: "Total", value: 215.42 }]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
  });

  it("stays silent when multiple distinct same-stem fields exist and none matches exactly", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { totalAmount: 215.42, totalDue: 220.0 }),
      uiNum(1500, [{ label: "Total", value: 199.0 }]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
  });

  it("treats agreeing same-stem fields across responses as unambiguous", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 215.42 }),
      netRes(1100, "r2", { totalAmount: 215.42 }),
      uiNum(1500, [{ label: "Total", value: 199.0 }]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(true);
  });

  it("caps emissions at 3 per session and dedupes by label stem", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", {
        total: 215.42,
        subtotal: 200.0,
        tax: 16.42,
        shipping: 9.99,
      }),
      uiNum(1500, [
        { label: "Total", value: 1.0 },
        { label: "Subtotal", value: 2.0 },
        { label: "Tax", value: 3.0 },
        { label: "Shipping", value: 4.0 },
      ]),
      // Re-emit of the same stems must not add more candidates.
      uiNum(2500, [{ label: "Total", value: 1.0 }]),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.filter((c) => c.detector === "ui_api_divergence"),
    ).toHaveLength(3);
  });

  it("stays silent when the UI dollars equal an integer cents API field (108.00 vs 10800)", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 10800 }),
      uiNum(1500, [{ label: "Total", value: 108.0, unit: "$" }]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
  });

  it("stays silent for a round-dollar UI value against integer cents (25 vs 2500)", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 2500 }),
      uiNum(1500, [{ label: "Total", value: 25 }]),
    ];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
  });

  it("still fires on a real divergence that is not a ×100 unit match (108.00 vs 108.75)", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 108.75 }),
      uiNum(1500, [{ label: "Total", value: 108.0, unit: "$" }]),
    ];
    const cand = buildEvidenceCandidates(events, { start: 1000 }).find(
      (c) => c.detector === "ui_api_divergence",
    );
    expect(cand).toBeDefined();
    expect(cand!.anchor.message).toContain("108.75");
  });

  it("does not silence when the larger value is non-integer (1.08 vs 108.5)", () => {
    const events: BugEvent[] = [
      netRes(1000, "r1", { total: 108.5 }),
      uiNum(1500, [{ label: "Total", value: 1.08, unit: "$" }]),
    ];
    const cand = buildEvidenceCandidates(events, { start: 1000 }).find(
      (c) => c.detector === "ui_api_divergence",
    );
    expect(cand).toBeDefined();
    expect(cand!.anchor.message).toContain("108.5");
  });

  it("is inert when there are no ui.num events (existing sessions unaffected)", () => {
    const events: BugEvent[] = [netRes(1000, "r1", { total: 215.42 })];
    expect(
      buildEvidenceCandidates(events, { start: 1000 }).some(
        (c) => c.detector === "ui_api_divergence",
      ),
    ).toBe(false);
  });
});
