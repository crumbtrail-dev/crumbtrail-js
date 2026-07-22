import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

function netReq(
  t: number,
  id: string,
  body: unknown,
  method = "POST",
): BugEvent {
  return {
    t,
    k: "net.req",
    d: {
      id,
      m: method,
      url: "https://shop.example/api/checkout",
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  };
}

function netRes(t: number, id: string, st: number, body?: unknown): BugEvent {
  return {
    t,
    k: "net.res",
    d: {
      id,
      st,
      ...(body !== undefined
        ? { body: typeof body === "string" ? body : JSON.stringify(body) }
        : {}),
    },
  };
}

function orderDiff(t: number, requestId: string, table = "orders"): BugEvent {
  return {
    t,
    k: "db.diff",
    d: {
      engine: "postgres",
      op: "insert",
      table,
      pk: { id: 1 },
      requestId,
      after: { id: 1 },
    },
  };
}

describe("buildEvidenceCandidates — ineffective_input", () => {
  it("emits a medium/55/low hint when a coupon is accepted but discount is zero and no redemption table is touched (P2 shape)", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { couponCode: "EXPIRED5", cartId: 9 }),
      netRes(1100, "r1", 200, { total: 100, discount: 0 }),
      orderDiff(1050, "r1"),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "ineffective_input");
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("medium");
    expect(cand!.score).toBe(55);
    expect(cand!.confidence).toBe("low");
    expect(cand!.title).toContain("couponCode");
    expect(cand!.title).toContain("200");
    expect(cand!.anchor.requestId).toBe("r1");
    expect(cand!.anchor.message).toContain("coupon");
  });

  it("stays silent when a stem-matching (redemption) table is touched", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { couponCode: "SAVE5" }),
      netRes(1100, "r1", 200, { total: 100, discount: 0 }),
      orderDiff(1050, "r1", "coupon_redemptions"),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(candidates.some((c) => c.detector === "ineffective_input")).toBe(
      false,
    );
  });

  it("stays silent when the matching response field is non-zero (input had an effect)", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { couponCode: "SAVE5" }),
      netRes(1100, "r1", 200, { total: 95, discount: 5 }),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(candidates.some((c) => c.detector === "ineffective_input")).toBe(
      false,
    );
  });

  it("stays silent for non-2xx responses", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { couponCode: "SAVE5" }),
      netRes(1100, "r1", 422, { discount: 0 }),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(candidates.some((c) => c.detector === "ineffective_input")).toBe(
      false,
    );
  });

  it("stays silent for a legacy whole-body [REDACTED] request body", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", "[REDACTED]"),
      netRes(1100, "r1", 200, { discount: 0 }),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(candidates.some((c) => c.detector === "ineffective_input")).toBe(
      false,
    );
  });

  it("stays silent when the response body is unparseable (no evidence)", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { couponCode: "SAVE5" }),
      netRes(1100, "r1", 200, "OK"),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(candidates.some((c) => c.detector === "ineffective_input")).toBe(
      false,
    );
  });

  it("never surfaces sensitive-named fields", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { password: "hunter22", authToken: "abc" }),
      netRes(1100, "r1", 200, {}),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(candidates.some((c) => c.detector === "ineffective_input")).toBe(
      false,
    );
  });

  it("caps emissions at 3 per session and dedupes by field name", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { couponCode: "A" }),
      netRes(1010, "r1", 200, { discount: 0 }),
      // Same field again on a later request → deduped, earliest anchor kept.
      netReq(1500, "r5", { couponCode: "B" }),
      netRes(1510, "r5", 200, { discount: 0 }),
      netReq(2000, "r2", { giftMessage: "hello" }),
      netRes(2010, "r2", 200, {}),
      netReq(3000, "r3", { referralSource: "friend" }),
      netRes(3010, "r3", 200, {}),
      netReq(4000, "r4", { deliveryNote: "leave at door" }),
      netRes(4010, "r4", 200, {}),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const hints = candidates.filter((c) => c.detector === "ineffective_input");
    expect(hints).toHaveLength(3);
    const coupon = hints.find((c) => c.title.includes("couponCode"));
    expect(coupon).toBeDefined();
    expect(coupon!.anchor.t).toBe(1000);
    // Earliest three distinct fields win the cap.
    expect(hints.some((c) => c.title.includes("deliveryNote"))).toBe(false);
  });

  it("does not fabricate signals from v2 redacted-placeholder metadata, but kept fields still work", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", {
        password: {
          $redacted: "[REDACTED]",
          len: 8,
          charset: "mixed",
          hash8: "ab12cd34",
        },
        giftMessage: "happy birthday",
      }),
      netRes(1100, "r1", 200, {}),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const hints = candidates.filter((c) => c.detector === "ineffective_input");
    expect(hints).toHaveLength(1);
    expect(hints[0].title).toContain("giftMessage");
    // No signals derived from placeholder metadata fields.
    for (const meta of ["charset", "hash8", "len", "$redacted"]) {
      expect(hints.some((c) => c.title.includes(meta))).toBe(false);
    }
  });

  it("stays silent for a placeholder-only v2 redacted payload (no hash8 variant)", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", {
        password: { $redacted: "[REDACTED]", len: 8, charset: "lower" },
      }),
      netRes(1100, "r1", 200, {}),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(candidates.some((c) => c.detector === "ineffective_input")).toBe(
      false,
    );
  });

  it("accepts an already-parsed object request body (isRecord fast path)", () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "net.req",
        d: {
          id: "r1",
          m: "POST",
          url: "https://shop.example/api/checkout",
          body: { couponCode: "SAVE5" },
        },
      },
      netRes(1100, "r1", 200, { total: 100, discount: 0 }),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(candidates.some((c) => c.detector === "ineffective_input")).toBe(
      true,
    );
  });
});
