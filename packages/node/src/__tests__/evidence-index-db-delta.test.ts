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
      url: "https://shop.example/api/orders",
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
  };
}

function netRes(t: number, id: string, st = 200, body?: unknown): BugEvent {
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

function invDiff(
  t: number,
  requestId: string,
  before: number,
  after: number,
  extra: Record<string, unknown> = {},
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: {
      engine: "postgres",
      op: "update",
      table: "inventory",
      pk: { id: 7 },
      requestId,
      before: { id: 7, stock: before },
      after: { id: 7, stock: after },
      ...extra,
    },
  };
}

describe("buildEvidenceCandidates — db_delta_mismatch", () => {
  it("emits a high-severity 72-score signal when qty 1 produces a delta of 2 (P1 shape)", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { productId: 7, qty: 1 }),
      netRes(1100, "r1", 200),
      invDiff(1050, "r1", 25, 23),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "db_delta_mismatch");
    expect(cand).toBeDefined();
    expect(cand!.severity).toBe("high");
    expect(cand!.score).toBe(72);
    expect(cand!.confidence).toBe("high");
    expect(cand!.anchor.requestId).toBe("r1");
    expect(cand!.anchor.message).toContain("inventory.stock");
    expect(cand!.anchor.message).toContain("qty=1");
    // It leads generic db_mutation (40) in the ranking.
    const mutation = candidates.find((c) => c.detector === "db_mutation");
    expect(mutation).toBeDefined();
    expect(cand!.score).toBeGreaterThan(mutation!.score);
  });

  it("scrubs token-like pk values out of the anchor message", () => {
    const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEFghiJKLmno";
    const events: BugEvent[] = [
      netReq(1000, "r1", { productId: token, qty: 1 }),
      netRes(1100, "r1", 200),
      invDiff(1050, "r1", 25, 23, {
        pk: { id: token },
        before: { id: token, stock: 25 },
        after: { id: token, stock: 23 },
      }),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "db_delta_mismatch");
    expect(cand).toBeDefined();
    expect(cand!.anchor.message).not.toContain(token);
    expect(cand!.anchor.message).toContain("[REDACTED]");
  });

  it("stays silent when the delta matches the payload qty", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { productId: 7, qty: 2 }),
      invDiff(1050, "r1", 25, 23),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });

  it("aggregates multiple payload lines targeting one id against the summed delta", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", {
        lines: [
          { productId: 7, qty: 1 },
          { productId: 7, qty: 2 },
        ],
      }),
      invDiff(1050, "r1", 25, 24),
      invDiff(1060, "r1", 24, 20),
    ];
    // summed qty 3 vs summed delta 1 + 4 = 5 → mismatch
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "db_delta_mismatch");
    expect(cand).toBeDefined();
    expect(cand!.anchor.message).toContain("qty=3");
    expect(cand!.anchor.message).toContain("=5");
  });

  it("stays silent for a matching multi-line aggregation", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", {
        lines: [
          { productId: 7, qty: 1 },
          { productId: 7, qty: 2 },
        ],
      }),
      invDiff(1050, "r1", 25, 24),
      invDiff(1060, "r1", 24, 22),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });

  it("stays silent when more than one numeric column changed (ambiguity)", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { productId: 7, qty: 1 }),
      {
        t: 1050,
        k: "db.diff",
        d: {
          engine: "postgres",
          op: "update",
          table: "inventory",
          pk: { id: 7 },
          requestId: "r1",
          before: { id: 7, stock: 25, reserved: 1 },
          after: { id: 7, stock: 23, reserved: 3 },
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });

  it("stays silent when no db.diff pk matches the payload id", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { productId: 99, qty: 1 }),
      invDiff(1050, "r1", 25, 23),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });

  it("stays silent for an unparseable request body", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", "not-json qty=1 productId=7"),
      invDiff(1050, "r1", 25, 23),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });

  it("stays silent for a legacy whole-body [REDACTED] request body", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", "[REDACTED]"),
      invDiff(1050, "r1", 25, 23),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });

  it("stays silent for non-mutating (GET) requests", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { productId: 7, qty: 1 }, "GET"),
      invDiff(1050, "r1", 25, 23),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });

  it("stays silent when a scope has two id-like fields (ambiguous pairing)", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { productId: 7, cartId: 3, qty: 1 }),
      invDiff(1050, "r1", 25, 23),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });

  it("stays silent when a matching diff has a composite pk", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { productId: 7, qty: 1 }),
      {
        t: 1050,
        k: "db.diff",
        d: {
          engine: "postgres",
          op: "update",
          table: "inventory",
          pk: { id: 7, warehouseId: 2 },
          requestId: "r1",
          before: { stock: 25 },
          after: { stock: 23 },
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });

  it("does not treat fields merely ending in 'id' (paid) as id-like", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { paid: 1, qty: 2 }),
      {
        t: 1050,
        k: "db.diff",
        d: {
          engine: "postgres",
          op: "update",
          table: "inventory",
          pk: { id: 1 },
          requestId: "r1",
          before: { id: 1, stock: 25 },
          after: { id: 1, stock: 22 },
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });

  it("still matches snake_case and bare-uppercase id fields (product_id, ID)", () => {
    for (const idField of ["product_id", "ID"]) {
      const events: BugEvent[] = [
        netReq(1000, "r1", { [idField]: 7, qty: 1 }),
        invDiff(1050, "r1", 25, 23),
      ];
      const candidates = buildEvidenceCandidates(events, { start: 1000 });
      expect(
        candidates.some((c) => c.detector === "db_delta_mismatch"),
      ).toBe(true);
    }
  });

  it("still detects a mismatch when a v2 redacted placeholder sits alongside the kept fields", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", {
        productId: 7,
        qty: 1,
        note: { $redacted: "[REDACTED]", len: 12, charset: "mixed" },
      }),
      invDiff(1050, "r1", 25, 23),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "db_delta_mismatch");
    expect(cand).toBeDefined();
    expect(cand!.anchor.message).toContain("productId=7");
  });

  it("stays silent for a placeholder-only v2 redacted payload", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", {
        payment: {
          $redacted: "[REDACTED]",
          len: 4,
          charset: "digits",
          hash8: "ab12cd34",
        },
      }),
      invDiff(1050, "r1", 25, 23),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });

  it("accepts an already-parsed object request body (isRecord fast path)", () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "net.req",
        d: {
          id: "r1",
          m: "POST",
          url: "https://shop.example/api/orders",
          body: { productId: 7, qty: 1 },
        },
      },
      invDiff(1050, "r1", 25, 23),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(true);
  });

  it("correlates on d.requestId when the browser event also carries a numeric transport id", () => {
    // Real browser net.req events carry BOTH a transport-local counter (d.id)
    // and the propagated correlation id (d.requestId); db.diff only knows the
    // latter. Regression guard: correlation must run on d.requestId.
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "net.req",
        d: {
          id: 7,
          method: "POST",
          url: "/api/checkout",
          requestId: "64fa03fc359eaafc6ba95043615399f4",
          body: JSON.stringify({
            userId: 1,
            couponCode: null,
            total: 23319,
            items: [{ productId: 7, qty: 1 }],
          }),
        },
      },
      invDiff(1050, "64fa03fc359eaafc6ba95043615399f4", 25, 23),
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const cand = candidates.find((c) => c.detector === "db_delta_mismatch");
    expect(cand).toBeDefined();
    expect(cand!.anchor.requestId).toBe("64fa03fc359eaafc6ba95043615399f4");
  });

  it("nets out compensated writes via the signed delta sum", () => {
    const events: BugEvent[] = [
      netReq(1000, "r1", { productId: 7, qty: 0 }),
      invDiff(1050, "r1", 25, 23), // −2
      invDiff(1060, "r1", 23, 25), // +2 → signed sum 0 matches qty 0
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(
      candidates.some((c) => c.detector === "db_delta_mismatch"),
    ).toBe(false);
  });
});
