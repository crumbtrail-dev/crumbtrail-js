import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

/**
 * Fixtures mirror the shapes the live harness captured, not synthetic minima:
 * the checkout flow writes `products`, `orders`, and `order_items` under one
 * request id, and the clean control writes two `shipments` rows whose after
 * images carry nothing but a primary key.
 */
function diff(
  t: number,
  requestId: string,
  op: string,
  table: string,
  pk: Record<string, unknown>,
  after: Record<string, unknown>,
  before?: Record<string, unknown>,
): BugEvent {
  return {
    t,
    k: "db.diff",
    d: { engine: "postgres", op, table, pk, after, before, requestId },
  };
}

const find = (events: BugEvent[], detector: string, start = 1000) =>
  buildEvidenceCandidates(events, { start }).filter(
    (c) => c.detector === detector,
  );

describe("db_field_divergence", () => {
  it("names two linked rows that disagree on one value in one request", () => {
    // The gap 1 session: one request set the product price to 8900 and wrote
    // the order_items line at 7900. The order_items row references the product.
    const events = [
      diff(1100, "req-checkout", "update", "products", { id: 42 }, {
        id: 42,
        price_cents: 8900,
      }),
      diff(1200, "req-checkout", "insert", "order_items", { id: 7 }, {
        id: 7,
        product_id: 42,
        price_cents: 7900,
      }),
    ];
    const found = find(events, "db_field_divergence");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("high");
    expect(found[0].score).toBe(90);
    expect(found[0].title).toContain("price_cents");
    expect(found[0].title).toContain("8900");
    expect(found[0].title).toContain("7900");
    expect(found[0].anchor.requestId).toBe("req-checkout");
    // Outranks the generic db_mutation surfacing of the very same writes, so a
    // reader working the list downward reaches the named bug first.
    expect(buildEvidenceCandidates(events, { start: 1000 })[0].detector).toBe(
      "db_field_divergence",
    );
  });

  it("is silent when the linked rows agree", () => {
    const events = [
      diff(1100, "req-checkout", "update", "products", { id: 42 }, {
        id: 42,
        price_cents: 8900,
      }),
      diff(1200, "req-checkout", "insert", "order_items", { id: 7 }, {
        id: 7,
        product_id: 42,
        price_cents: 8900,
      }),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });

  it("is silent on unlinked rows that merely share a column name", () => {
    // Two customers' order rows in one batch request. Same column, different
    // values, no foreign key between them — supposed to differ.
    const events = [
      diff(1100, "req-batch", "insert", "orders", { id: 1 }, {
        id: 1,
        total_cents: 8900,
      }),
      diff(1200, "req-batch", "insert", "invoices", { id: 2 }, {
        id: 2,
        total_cents: 9258,
      }),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });

  it("is silent across two rows of one table", () => {
    // Siblings, not a contradiction, even when one references the other's pk.
    const events = [
      diff(1100, "req-checkout", "insert", "order_items", { id: 1 }, {
        id: 1,
        price_cents: 8900,
      }),
      diff(1200, "req-checkout", "insert", "order_items", { id: 2 }, {
        id: 2,
        parent_id: 1,
        price_cents: 7900,
      }),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });

  it("is silent across two requests", () => {
    const events = [
      diff(1100, "req-one", "update", "products", { id: 42 }, {
        id: 42,
        price_cents: 8900,
      }),
      diff(1200, "req-two", "insert", "order_items", { id: 7 }, {
        id: 7,
        product_id: 42,
        price_cents: 7900,
      }),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });

  it("ignores identity and clock fields, which are supposed to differ", () => {
    const events = [
      diff(1100, "req-checkout", "update", "products", { id: 42 }, {
        id: 42,
        product_id: 42,
        updated_at: 1,
        version: 3,
      }),
      diff(1200, "req-checkout", "insert", "order_items", { id: 7 }, {
        id: 7,
        product_id: 42,
        updated_at: 2,
        version: 3,
      }),
    ];
    expect(find(events, "db_field_divergence")).toHaveLength(0);
  });
});

describe("duplicate_write", () => {
  it("names two identical inserts into one table in one request", () => {
    // The gap 3 session: a retry storm with no idempotency key redeemed one
    // coupon twice under a single request id.
    const row = {
      order_id: 31,
      coupon_code: "SAVE10",
      amount_cents: 1000,
    };
    const events = [
      diff(1100, "req-checkout", "insert", "coupon_redemptions", { id: 1 }, {
        id: 1,
        ...row,
      }),
      diff(1150, "req-checkout", "insert", "coupon_redemptions", { id: 2 }, {
        id: 2,
        ...row,
      }),
    ];
    const found = find(events, "duplicate_write");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("high");
    expect(found[0].score).toBe(90);
    expect(found[0].title).toContain("coupon_redemptions");
    expect(found[0].title).toContain("2 identical rows");
    // Anchored on the FIRST of the duplicates.
    expect(found[0].anchor.t).toBe(1100);
  });

  it("is silent on the clean control's two empty-after shipments rows", () => {
    // Planner finding F2. Both rows reduce to `{}` once the primary key is
    // dropped, so a naive identical-inserts rule fires on the control.
    const events = [
      diff(1100, "req-checkout", "insert", "shipments", { id: 1 }, { id: 1 }),
      diff(1150, "req-checkout", "insert", "shipments", { id: 2 }, { id: 2 }),
    ];
    expect(find(events, "duplicate_write")).toHaveLength(0);
  });

  it("is silent when every surviving field is empty or zero", () => {
    // The same hole one level in: the capture recorded fields but no content.
    // `created_at` arrives as `{}` because db.diff after images drop Dates.
    const events = [
      diff(1100, "req-checkout", "insert", "shipments", { id: 1 }, {
        id: 1,
        created_at: {},
        retries: 0,
        label: "",
      }),
      diff(1150, "req-checkout", "insert", "shipments", { id: 2 }, {
        id: 2,
        created_at: {},
        retries: 0,
        label: "",
      }),
    ];
    expect(find(events, "duplicate_write")).toHaveLength(0);
  });

  it("is silent when the two inserts genuinely differ", () => {
    const events = [
      diff(1100, "req-checkout", "insert", "order_items", { id: 1 }, {
        id: 1,
        product_id: 42,
        qty: 1,
      }),
      diff(1150, "req-checkout", "insert", "order_items", { id: 2 }, {
        id: 2,
        product_id: 43,
        qty: 1,
      }),
    ];
    expect(find(events, "duplicate_write")).toHaveLength(0);
  });

  it("is silent across two requests, and on updates", () => {
    const row = { order_id: 31, coupon_code: "SAVE10", amount_cents: 1000 };
    const twoRequests = [
      diff(1100, "req-one", "insert", "coupon_redemptions", { id: 1 }, {
        id: 1,
        ...row,
      }),
      diff(1150, "req-two", "insert", "coupon_redemptions", { id: 2 }, {
        id: 2,
        ...row,
      }),
    ];
    expect(find(twoRequests, "duplicate_write")).toHaveLength(0);

    const updates = [
      diff(1100, "req-checkout", "update", "coupon_redemptions", { id: 1 }, {
        id: 1,
        ...row,
      }),
      diff(1150, "req-checkout", "update", "coupon_redemptions", { id: 2 }, {
        id: 2,
        ...row,
      }),
    ];
    expect(find(updates, "duplicate_write")).toHaveLength(0);
  });

  it("reports the count when a retry storm writes the row three times", () => {
    const row = { order_id: 31, coupon_code: "SAVE10", amount_cents: 1000 };
    const events = [1100, 1150, 1200].map((t, i) =>
      diff(t, "req-checkout", "insert", "coupon_redemptions", { id: i + 1 }, {
        id: i + 1,
        ...row,
      }),
    );
    const found = find(events, "duplicate_write");
    expect(found).toHaveLength(1);
    expect(found[0].title).toContain("3 identical rows");
  });
});
