import { describe, it, expect } from "vitest";
import {
  CAPTURE_GAP_EVENT_KIND,
  DB_DIFF_EVENT_KIND,
  buildCaptureGapEvent,
  type DbDiffEventData,
  type DbEngine,
  type BugEvent,
} from "../index";

describe("db.diff event kind", () => {
  it("exposes the canonical db.diff event kind constant", () => {
    expect(DB_DIFF_EVENT_KIND).toBe("db.diff");
  });

  it("types a db.diff payload as the d of a BugEvent", () => {
    const d: DbDiffEventData = {
      engine: "postgres",
      op: "update",
      table: "users",
      pk: { id: 7 },
      after: { id: 7, name: "Ada" },
      requestId: "trace-abc",
    };
    const event: BugEvent = {
      t: 1,
      k: DB_DIFF_EVENT_KIND,
      d: d as unknown as Record<string, unknown>,
    };
    expect(event.k).toBe("db.diff");
    expect((event.d as unknown as DbDiffEventData).op).toBe("update");
  });

  it("accepts every engine in the DbEngine union", () => {
    const engines: DbEngine[] = ["postgres", "mysql", "mssql", "sqlite"];
    const events = engines.map<DbDiffEventData>((engine) => ({
      engine,
      op: "insert",
      table: "orders",
      pk: { id: 1 },
      after: { id: 1 },
      requestId: "trace-1",
    }));
    expect(events.map((d) => d.engine)).toEqual(engines);
  });

  it("types an image-less statement-level fallback event with rowCount and pk null", () => {
    const d: DbDiffEventData = {
      engine: "mysql",
      op: "insert",
      table: "orders",
      pk: null,
      rowCount: 12,
      requestId: "trace-abc",
    };
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(12);
    expect(d.after).toBeUndefined();
    expect(d.before).toBeUndefined();
  });
});

describe("capture gap event", () => {
  it("builds a bounded, redacted completeness event", () => {
    const event = buildCaptureGapEvent({
      surface: "db_diff",
      reason: "unparsed_sql",
      detail: `UPDATE orders SET note = 'quoted@example.test', email = ada@example.test, phone = +1 (416) 555-0199, account = 123456789012345, token = ghp_abcdefghijklmnopqrstuvwx123456 ${"x".repeat(600)}`,
      t: 1_700_000_000_250,
      sessionId: "ses-gap",
      sessionStartedAt: 1_700_000_000_000,
    });

    expect(event).toMatchObject({
      k: CAPTURE_GAP_EVENT_KIND,
      t: 1_700_000_000_250,
      sessionId: "ses-gap",
      offsetMs: 250,
      d: {
        kind: "capture_gap",
        surface: "db_diff",
        reason: "unparsed_sql",
        t: 1_700_000_000_250,
      },
    });
    const detail = String(event.d.detail);
    expect(detail).toContain("[REDACTED]");
    expect(detail).toContain("UPDATE");
    expect(detail).toContain("table orders");
    expect(detail).not.toContain("quoted@example.test");
    expect(detail).not.toContain("ada@example.test");
    expect(detail).not.toContain("416");
    expect(detail).not.toContain("555");
    expect(detail).not.toContain("123456789012345");
    expect(detail).not.toContain("ghp_abcdefghijklmnopqrstuvwx123456");
    expect(detail.length).toBeLessThanOrEqual(500);
  });
});
