import { describe, expect, it } from "vitest";
import { CAPTURE_GAP_EVENT_KIND, type BugEvent } from "crumbtrail-core";
import { instrumentPgClient } from "../db";
import { classifyStatement } from "../db/sql";

function capture(sql: string): Promise<BugEvent[]> {
  const events: BugEvent[] = [];
  const client = {
    async query(_text?: unknown, _params?: unknown) {
      return { rows: [], rowCount: 0 };
    },
  };
  const db = instrumentPgClient(client, {
    requestId: "req-corpus",
    emit: (event) => events.push(event),
  });
  return db.query(sql).then(() => events);
}

describe("SQL classification corpus", () => {
  it.each([
    [
      "WITH active AS (SELECT id FROM users) UPDATE orders SET status = 'ready' WHERE id IN (SELECT id FROM active)",
      "update",
      "orders",
    ],
    [
      "INSERT INTO orders (id, status) VALUES (1, 'ready') ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status",
      "insert",
      "orders",
    ],
    [
      "INSERT INTO orders (id, status) VALUES (1, 'ready') ON DUPLICATE KEY UPDATE status = VALUES(status)",
      "insert",
      "orders",
    ],
  ])("classifies real world mutation syntax %#", (sql, op, table) => {
    expect(classifyStatement(sql)).toEqual({
      kind: "mutation",
      mutation: expect.objectContaining({ op, table }),
    });
  });

  it.each([
    "MERGE INTO dbo.orders AS target USING dbo.source AS source ON target.id = source.id WHEN MATCHED THEN UPDATE SET status = source.status",
    "WITH source_rows AS (SELECT 1 AS id) INSERT INTO orders (id) SELECT id FROM source_rows",
    "INSERT INTO orders (id) VALUES (1); SELECT * FROM orders",
    "UPDATE orders SET = ?",
    "PREPARE update_order AS UPDATE orders SET status = 'ready' WHERE id = 1",
  ])(
    "gaps a write shaped statement that cannot be classified %#",
    async (sql) => {
      const classification = classifyStatement(sql);
      expect(classification).toMatchObject({
        kind: "unparsable",
        mayMutate: true,
      });

      const events = await capture(sql);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        k: CAPTURE_GAP_EVENT_KIND,
        d: {
          surface: "db_diff",
          reason: "unparsed_sql",
        },
      });
      expect(String(events[0].d.detail)).toMatch(/^[A-Z]+$/);
    },
  );

  it.each([
    [
      `/* ${"x".repeat(600)} */ MERGE INTO dbo.orders AS target USING dbo.source AS source ON target.id = source.id WHEN MATCHED THEN UPDATE SET status = source.status`,
      "MERGE",
    ],
    [`/* ${"x".repeat(600)} */ UPDATE orders SET = ?`, "UPDATE"],
  ])(
    "does not let a leading block comment hide an unparsed write %#",
    async (sql, keyword) => {
      expect(classifyStatement(sql)).toMatchObject({
        kind: "unparsable",
        detail: keyword,
        mayMutate: true,
      });

      const events = await capture(sql);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        k: CAPTURE_GAP_EVENT_KIND,
        d: { surface: "db_diff", reason: "unparsed_sql", detail: keyword },
      });
    },
  );
});
