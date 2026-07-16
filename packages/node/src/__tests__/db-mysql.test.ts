import { describe, expect, it } from "vitest";
import {
  CAPTURE_GAP_EVENT_KIND,
  DB_DIFF_BULK_EVENT_KIND,
  DB_DIFF_EVENT_KIND,
  DB_READ_BULK_EVENT_KIND,
  DB_READ_EVENT_KIND,
  type BugEvent,
  type DbDiffBulkEventData,
  type DbDiffEventData,
  type DbReadBulkEventData,
  type DbReadEventData,
} from "crumbtrail-core";
import { instrumentMysqlClient } from "../db/mysql";

type MysqlMethod = "query" | "execute";
type MysqlHandler = (
  sql: string,
  values: unknown[] | undefined,
  method: MysqlMethod,
) => unknown;

/**
 * A fake duck-typed mysql2/promise client that returns canned `[payload, fields]` tuples and records
 * every call. A handler can return a rejected promise to simulate a failing SELECT. Mirrors the
 * fakePgClient style in db-diff.test.ts.
 */
function fakeMysqlClient(handler: MysqlHandler) {
  const calls: Array<{ sql: string; values?: unknown[]; method: MysqlMethod }> =
    [];
  const make = (method: MysqlMethod) => (sql: string, values?: unknown[]) => {
    calls.push({ sql, values, method });
    return Promise.resolve(handler(sql, values, method));
  };
  return { calls, query: make("query"), execute: make("execute") };
}

const kinds = (events: BugEvent[]) => events.map((event) => event.k);
const verbs = (calls: Array<{ sql: string }>) =>
  calls.map((call) => call.sql.match(/^\w+/)?.[0]?.toLowerCase());

describe("instrumentMysqlClient inserts", () => {
  it("records a single-row INSERT after-image re-read by insertId", async () => {
    const client = fakeMysqlClient((sql) =>
      /^insert/i.test(sql)
        ? [{ affectedRows: 1, insertId: 1 }, undefined]
        : [[{ id: 1, name: "Ada" }], []],
    );
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-ins",
      sessionId: "ses",
      emit: (event) => events.push(event),
    });

    await db.query("INSERT INTO orders (name) VALUES (?)", ["Ada"]);

    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.engine).toBe("mysql");
    expect(d.op).toBe("insert");
    expect(d.table).toBe("orders");
    expect(d.pk).toEqual({ id: 1 });
    expect(d.after).toEqual({ id: 1, name: "Ada" });
    expect(d.requestId).toBe("req-ins");
    // MySQL has no RETURNING: the after-image is re-read by insertId.
    const select = client.calls.find((call) => /^select/i.test(call.sql));
    expect(select?.sql).toMatch(/^select \* from orders where id = \?/i);
    expect(select?.values).toEqual([1]);
  });

  it("emits an image-less db.diff with rowCount for a multi-row INSERT", async () => {
    const client = fakeMysqlClient(() => [
      { affectedRows: 3, insertId: 10 },
      undefined,
    ]);
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-multi",
      emit: (event) => events.push(event),
    });

    await db.query("INSERT INTO orders (name) VALUES (?), (?), (?)", [
      "a",
      "b",
      "c",
    ]);

    expect(events).toHaveLength(1);
    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.engine).toBe("mysql");
    expect(d.op).toBe("insert");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(3);
    expect(d.after).toBeUndefined();
    // No re-read SELECT is attempted for a multi-row insert.
    expect(client.calls).toHaveLength(1);
  });

  it("falls back to an image-less db.diff when the INSERT insertId re-read comes back empty", async () => {
    // Single-row insert with a positive insertId, but the after-image re-read returns no rows
    // (e.g. deleted in a race or an unusual view): degrade to the image-less rowCount fallback.
    const client = fakeMysqlClient((sql) =>
      /^insert/i.test(sql)
        ? [{ affectedRows: 1, insertId: 42 }, undefined]
        : [[], []],
    );
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-empty-reread",
      emit: (event) => events.push(event),
    });

    await db.query("INSERT INTO orders (name) VALUES (?)", ["Ada"]);

    expect(events).toHaveLength(1);
    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.engine).toBe("mysql");
    expect(d.op).toBe("insert");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(1);
    expect(d.after).toBeUndefined();
    // The re-read by insertId was attempted before falling back.
    const select = client.calls.find((call) => /^select/i.test(call.sql));
    expect(select?.sql).toMatch(/^select \* from orders where id = \?/i);
    expect(select?.values).toEqual([42]);
  });

  it("emits an image-less db.diff for a composite-pk INSERT", async () => {
    const client = fakeMysqlClient(() => [
      { affectedRows: 1, insertId: 5 },
      undefined,
    ]);
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-comp",
      pkColumns: { order_items: ["order_id", "sku"] },
      emit: (event) => events.push(event),
    });

    await db.query("INSERT INTO order_items (order_id, sku) VALUES (?, ?)", [
      7,
      "abc",
    ]);

    expect(events).toHaveLength(1);
    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.engine).toBe("mysql");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(1);
    expect(client.calls).toHaveLength(1);
  });
});

describe("instrumentMysqlClient updates", () => {
  it("captures UPDATE before/after images and binds only WHERE params to the SELECTs", async () => {
    const client = fakeMysqlClient((sql) => {
      if (/^update/i.test(sql)) return [{ affectedRows: 1 }, undefined];
      if (/ in \(/i.test(sql)) return [[{ id: 3, status: "shipped" }], []]; // post-select
      return [[{ id: 3, status: "pending" }], []]; // pre-select
    });
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-upd",
      captureBefore: true,
      emit: (event) => events.push(event),
    });

    await db.query("UPDATE orders SET status = ? WHERE id = ?", ["shipped", 3]);

    expect(events).toHaveLength(1);
    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.engine).toBe("mysql");
    expect(d.op).toBe("update");
    expect(d.before).toEqual({ id: 3, status: "pending" });
    expect(d.after).toEqual({ id: 3, status: "shipped" });

    const selects = client.calls.filter((call) => /^select/i.test(call.sql));
    // Pre-SELECT bound only the WHERE param (3), not the SET value ("shipped").
    expect(selects[0].sql).toMatch(/^select \* from orders where id = \?/i);
    expect(selects[0].values).toEqual([3]);
    // Post-SELECT re-reads by pk with an IN list.
    expect(selects[1].sql).toMatch(/where id in \(\?\)/i);
    expect(selects[1].values).toEqual([3]);
    // Ordering: pre-select, then the host UPDATE, then post-select.
    expect(verbs(client.calls)).toEqual(["select", "update", "select"]);
  });

  it("omits the UPDATE before-image when captureBefore is off but still captures the after-image", async () => {
    const client = fakeMysqlClient((sql) => {
      if (/^update/i.test(sql)) return [{ affectedRows: 1 }, undefined];
      if (/ in \(/i.test(sql)) return [[{ id: 3, status: "shipped" }], []];
      return [[{ id: 3, status: "pending" }], []];
    });
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-upd-off",
      emit: (event) => events.push(event),
    });

    await db.query("UPDATE orders SET status = ? WHERE id = ?", ["shipped", 3]);

    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.after).toEqual({ id: 3, status: "shipped" });
    expect(d.before).toBeUndefined();
    // A pre-SELECT still runs — it supplies the pks the post-SELECT after-image needs.
    expect(
      client.calls.some((call) =>
        /^select \* from orders where id = \?/i.test(call.sql),
      ),
    ).toBe(true);
  });

  it("emits a before-only db.diff for a row that vanished from the post-SELECT (redacted, no after, no double-count)", async () => {
    // Pre-image has ids 1 and 2; the post-SELECT (an IN(...) re-read) returns only id 1, so id 2's
    // pk changed or was concurrently deleted — its after-image is unobtainable.
    const client = fakeMysqlClient((sql) => {
      if (/^update/i.test(sql)) return [{ affectedRows: 2 }, undefined];
      if (/ in \(/i.test(sql)) return [[{ id: 1, status: "shipped" }], []]; // post-select
      return [
        [
          { id: 1, status: "pending" },
          { id: 2, status: "pending", token: "tok_secret_should_vanish" },
        ],
        [],
      ]; // pre-select
    });
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-vanish",
      captureBefore: true,
      emit: (event) => events.push(event),
    });

    await db.query("UPDATE orders SET status = ? WHERE status = ?", [
      "shipped",
      "pending",
    ]);

    // One full before/after diff for the surviving row, one before-only diff for the vanished row.
    expect(kinds(events)).toEqual([DB_DIFF_EVENT_KIND, DB_DIFF_EVENT_KIND]);
    const survivor = events[0].d as unknown as DbDiffEventData;
    expect(survivor.pk).toEqual({ id: 1 });
    expect(survivor.before).toEqual({ id: 1, status: "pending" });
    expect(survivor.after).toEqual({ id: 1, status: "shipped" });

    const vanished = events[1].d as unknown as DbDiffEventData;
    expect(vanished.engine).toBe("mysql");
    expect(vanished.op).toBe("update");
    expect(vanished.table).toBe("orders");
    expect(vanished.pk).toEqual({ id: 2 });
    // Redaction is applied to the before image of the vanished row.
    expect(vanished.before).toEqual({
      id: 2,
      status: "pending",
      token: "[REDACTED]",
    });
    // No after-image (it was unobtainable) and no image-less rowCount fallback.
    expect(vanished.after).toBeUndefined();
    expect(vanished.rowCount).toBeUndefined();
    // No per-pk double-count: exactly one event per pk, and the secret never leaks.
    const pks = events.map(
      (event) => (event.d as unknown as DbDiffEventData).pk,
    );
    expect(pks).toEqual([{ id: 1 }, { id: 2 }]);
    expect(JSON.stringify(events)).not.toContain("tok_secret_should_vanish");
  });

  it("routes a before-only UPDATE emit failure through onGap without changing the host result", async () => {
    const hostResult = [{ affectedRows: 1 }, undefined] as const;
    const client = fakeMysqlClient((sql) => {
      if (/^update/i.test(sql)) return hostResult;
      if (/ in \(/i.test(sql)) return [[], []]; // post-select, so the row becomes before-only
      return [[{ id: 2, status: "pending" }], []]; // pre-select
    });
    const primaryEvents: BugEvent[] = [];
    const gapEvents: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-before-only-emit-failure",
      captureBefore: true,
      emit: (event) => {
        primaryEvents.push(event);
        if (event.k === DB_DIFF_EVENT_KIND) throw new Error("sink failure");
      },
      onGap: (event) => gapEvents.push(event),
    });

    const result = await db.query("UPDATE orders SET status = ? WHERE id = ?", [
      "shipped",
      2,
    ]);

    expect(result).toBe(hostResult);
    expect(primaryEvents).toHaveLength(1);
    expect(primaryEvents[0].k).toBe(DB_DIFF_EVENT_KIND);
    expect(gapEvents).toHaveLength(1);
    expect(gapEvents[0].k).toBe(CAPTURE_GAP_EVENT_KIND);
    expect(gapEvents[0].d).toMatchObject({ reason: "capture_exception" });
  });

  it("keeps before-only vanished diffs additive and the bulk accounting sane when an UPDATE exceeds the cap", async () => {
    // Compound edge: rowCount (5) > maxRows (2) + captureBefore on + a vanished capped pk.
    const client = fakeMysqlClient((sql) => {
      if (/^update/i.test(sql)) return [{ affectedRows: 5 }, undefined];
      if (/ in \(/i.test(sql)) return [[{ id: 1, status: "shipped" }], []]; // post: id 2 vanished
      return [
        [
          { id: 1, status: "pending" },
          { id: 2, status: "pending" },
          { id: 3, status: "pending" },
        ],
        [],
      ]; // pre-select
    });
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-vanish-bulk",
      captureBefore: true,
      maxRowsPerStatement: 2,
      emit: (event) => events.push(event),
    });

    await db.query("UPDATE orders SET status = ? WHERE status = ?", [
      "shipped",
      "pending",
    ]);

    // After-image per-row diff + bulk summary + before-only diff for the vanished capped pk.
    expect(kinds(events)).toEqual([
      DB_DIFF_EVENT_KIND,
      DB_DIFF_BULK_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
    ]);

    const survivor = events[0].d as unknown as DbDiffEventData;
    expect(survivor.pk).toEqual({ id: 1 });
    expect(survivor.after).toEqual({ id: 1, status: "shipped" });

    const bulk = events[1].d as unknown as DbDiffBulkEventData;
    expect(bulk.engine).toBe("mysql");
    expect(bulk.op).toBe("update");
    expect(bulk.table).toBe("orders");
    expect(bulk.rowCount).toBe(5);
    // Sane bulk accounting: emitted + truncated reconcile to rowCount, nothing negative.
    expect(bulk.emittedRows + bulk.truncatedRows).toBe(bulk.rowCount);
    expect(bulk.truncatedRows).toBeGreaterThanOrEqual(0);

    const vanished = events[2].d as unknown as DbDiffEventData;
    expect(vanished.op).toBe("update");
    expect(vanished.pk).toEqual({ id: 2 });
    expect(vanished.before).toEqual({ id: 2, status: "pending" });
    expect(vanished.after).toBeUndefined();

    // No per-pk double-count: each per-row db.diff pk is distinct (id 3 was beyond the cap and
    // gets no per-row event at all).
    const perRowPks = events
      .filter((event) => event.k === DB_DIFF_EVENT_KIND)
      .map((event) => (event.d as unknown as DbDiffEventData).pk);
    expect(perRowPks).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("falls back to an image-less db.diff for an UPDATE with no WHERE clause", async () => {
    const client = fakeMysqlClient((sql) =>
      /^update/i.test(sql) ? [{ affectedRows: 5 }, undefined] : [[], []],
    );
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-nowhere",
      captureBefore: true,
      emit: (event) => events.push(event),
    });

    await db.query("UPDATE orders SET status = ?", ["archived"]);

    expect(events).toHaveLength(1);
    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.op).toBe("update");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(5);
    // No pre/post SELECT is attempted without a WHERE clause.
    expect(client.calls).toHaveLength(1);
  });
});

describe("instrumentMysqlClient deletes", () => {
  it("captures a DELETE before-image via a pre-SELECT", async () => {
    const client = fakeMysqlClient((sql) =>
      /^delete/i.test(sql)
        ? [{ affectedRows: 1 }, undefined]
        : [[{ id: 9, name: "gone" }], []],
    );
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-del",
      emit: (event) => events.push(event),
    });

    await db.query("DELETE FROM widgets WHERE id = ?", [9]);

    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.engine).toBe("mysql");
    expect(d.op).toBe("delete");
    expect(d.table).toBe("widgets");
    expect(d.before).toEqual({ id: 9, name: "gone" });
    expect(d.after).toBeUndefined();
    const select = client.calls.find((call) => /^select/i.test(call.sql));
    expect(select?.sql).toMatch(/^select \* from widgets where id = \?/i);
    expect(select?.values).toEqual([9]);
  });

  it("still deletes and emits an image-less diff when the pre-SELECT fails", async () => {
    const client = fakeMysqlClient((sql) =>
      /^delete/i.test(sql)
        ? [{ affectedRows: 2 }, undefined]
        : Promise.reject(new Error("permission denied for table widgets")),
    );
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-del-fail",
      emit: (event) => events.push(event),
    });

    const result = await db.query("DELETE FROM widgets WHERE id = ?", [9]);

    // The host DELETE ran and returned its real result unchanged.
    expect(result).toEqual([{ affectedRows: 2 }, undefined]);
    expect(events[0].k).toBe(CAPTURE_GAP_EVENT_KIND);
    expect(events[0].d).toMatchObject({ reason: "capture_exception" });
    const diff = events.find((event) => event.k === DB_DIFF_EVENT_KIND);
    expect(diff).toBeDefined();
    const d = diff!.d as unknown as DbDiffEventData;
    expect(d.op).toBe("delete");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(2);
  });

  it("emits a db.diff.bulk summary with engine mysql when a DELETE exceeds the per-statement cap", async () => {
    const before = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      status: "stale",
    }));
    const client = fakeMysqlClient((sql) =>
      /^delete/i.test(sql) ? [{ affectedRows: 5 }, undefined] : [before, []],
    );
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-bulk",
      maxRowsPerStatement: 3,
      emit: (event) => events.push(event),
    });

    await db.query("DELETE FROM orders WHERE status = ?", ["stale"]);

    expect(kinds(events.slice(0, 3))).toEqual([
      DB_DIFF_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
    ]);
    expect(events[3].k).toBe(DB_DIFF_BULK_EVENT_KIND);
    const bulk = events[3].d as unknown as DbDiffBulkEventData;
    expect(bulk.engine).toBe("mysql");
    expect(bulk).toMatchObject({
      op: "delete",
      table: "orders",
      rowCount: 5,
      emittedRows: 3,
      truncatedRows: 2,
    });
  });
});

describe("instrumentMysqlClient reads", () => {
  it("captures capped, redacted SELECT rows and a db.read.bulk summary", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: index + 1,
      token: "tok_secret_value_should_vanish",
    }));
    const client = fakeMysqlClient(() => [rows, []]);
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-read",
      captureReads: true,
      maxReadRowsPerStatement: 2,
      emit: (event) => events.push(event),
    });

    await db.query("SELECT * FROM invoice_rankings WHERE tenant_id = ?", [
      "acme",
    ]);

    expect(kinds(events)).toEqual([
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
      DB_READ_BULK_EVENT_KIND,
    ]);
    const first = events[0].d as unknown as DbReadEventData;
    expect(first.engine).toBe("mysql");
    expect(first.table).toBe("invoice_rankings");
    expect(first.row).toEqual({ id: 1, token: "[REDACTED]" });
    const bulk = events[2].d as unknown as DbReadBulkEventData;
    expect(bulk.engine).toBe("mysql");
    expect(bulk).toMatchObject({
      rowCount: 3,
      emittedRows: 2,
      truncatedRows: 1,
    });
    expect(JSON.stringify(events)).not.toContain(
      "tok_secret_value_should_vanish",
    );
  });
});

describe("instrumentMysqlClient safety", () => {
  it("skips all emission when no request scope is active", async () => {
    const client = fakeMysqlClient(() => [
      { affectedRows: 1, insertId: 1 },
      undefined,
    ]);
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      getRequestId: () => undefined,
      emit: (event) => events.push(event),
    });

    await db.query("INSERT INTO orders (name) VALUES (?)", ["Ada"]);

    expect(events).toHaveLength(0);
    // Only the host INSERT runs — no capture SELECT.
    expect(client.calls).toHaveLength(1);
  });

  it("returns the real result when the emit sink throws", async () => {
    const client = fakeMysqlClient((sql) =>
      /^insert/i.test(sql)
        ? [{ affectedRows: 1, insertId: 1 }, undefined]
        : [[{ id: 1, name: "Ada" }], []],
    );
    const db = instrumentMysqlClient(client, {
      requestId: "req-boom",
      emit: () => {
        throw new Error("sink exploded");
      },
    });

    const result = await db.query("INSERT INTO orders (name) VALUES (?)", [
      "Ada",
    ]);
    expect(result).toEqual([{ affectedRows: 1, insertId: 1 }, undefined]);
  });

  it("passes through statements it cannot parse without emitting", async () => {
    const client = fakeMysqlClient(() => [{ affectedRows: 0 }, undefined]);
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-passthru",
      captureReads: true,
      emit: (event) => events.push(event),
    });

    await db.query("TRUNCATE TABLE orders", []);

    expect(events).toHaveLength(0);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0].sql).toBe("TRUNCATE TABLE orders");
  });

  it("degrades to no event when the driver returns a bare (non-tuple) result, returning it unchanged", async () => {
    // A driver/result that isn't the mysql2 `[payload, fields]` tuple yields no result header, so
    // there is nothing to diff — the host result must still be returned verbatim.
    const bare = { affectedRows: 1, insertId: 1 };
    const client = fakeMysqlClient(() => bare);
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-bare",
      emit: (event) => events.push(event),
    });

    const result = await db.query("INSERT INTO orders (name) VALUES (?)", [
      "Ada",
    ]);

    expect(result).toBe(bare);
    expect(events).toHaveLength(0);
    // Only the host INSERT ran — no after-image re-read was attempted.
    expect(client.calls).toHaveLength(1);
  });

  it("instruments execute() the same as query()", async () => {
    const client = fakeMysqlClient((sql) =>
      /^insert/i.test(sql)
        ? [{ affectedRows: 1, insertId: 2 }, undefined]
        : [[{ id: 2, name: "Bo" }], []],
    );
    const events: BugEvent[] = [];
    const db = instrumentMysqlClient(client, {
      requestId: "req-exec",
      emit: (event) => events.push(event),
    });

    await db.execute("INSERT INTO orders (name) VALUES (?)", ["Bo"]);

    expect(events).toHaveLength(1);
    const d = events[0].d as unknown as DbDiffEventData;
    expect(d.op).toBe("insert");
    expect(d.after).toEqual({ id: 2, name: "Bo" });
    // The host INSERT went through execute(); the capture re-read went through query().
    const insert = client.calls.find((call) => /^insert/i.test(call.sql));
    const select = client.calls.find((call) => /^select/i.test(call.sql));
    expect(insert?.method).toBe("execute");
    expect(select?.method).toBe("query");
  });
});
