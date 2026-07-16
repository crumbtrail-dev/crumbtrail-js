import { describe, expect, it } from "vitest";
import {
  CAPTURE_GAP_EVENT_KIND,
  DB_DIFF_BULK_EVENT_KIND,
  DB_DIFF_EVENT_KIND,
  type BugEvent,
  type DbDiffBulkEventData,
  type DbDiffEventData,
  type DbReadBulkEventData,
  type DbReadEventData,
} from "crumbtrail-core";
import { instrumentSqliteDatabase } from "../db/sqlite";

const DB_READ_EVENT_KIND = "db.read";
const DB_READ_BULK_EVENT_KIND = "db.read.bulk";

interface FakeCall {
  method: "prepare" | "run" | "all" | "get" | "iterate";
  sql: string;
  params: unknown[];
}

type Handler = (sql: string, params: unknown[]) => unknown;

interface FakeConfig {
  run?: Handler;
  all?: Handler;
  get?: Handler;
}

/**
 * A fully synchronous fake of a better-sqlite3 / node:sqlite database. `prepare(sql)` returns a
 * statement whose `run`/`all`/`get` return canned, config-driven values and record every call — the
 * sync mirror of `fakePgClient`. No promises anywhere, so instrumentation events must be observable
 * the instant `run()`/`all()` returns.
 */
function fakeSqliteDatabase(config: FakeConfig = {}) {
  const calls: FakeCall[] = [];
  const statements: Array<Record<string, unknown>> = [];
  const db = {
    calls,
    statements,
    prepare(sql: unknown) {
      calls.push({ method: "prepare", sql: String(sql), params: [] });
      const stmt = {
        sql,
        run(...params: unknown[]) {
          calls.push({ method: "run", sql: String(sql), params });
          return config.run
            ? config.run(String(sql), params)
            : { changes: 0, lastInsertRowid: 0 };
        },
        all(...params: unknown[]) {
          calls.push({ method: "all", sql: String(sql), params });
          return config.all ? config.all(String(sql), params) : [];
        },
        get(...params: unknown[]) {
          calls.push({ method: "get", sql: String(sql), params });
          return config.get ? config.get(String(sql), params) : undefined;
        },
        iterate(...params: unknown[]) {
          calls.push({ method: "iterate", sql: String(sql), params });
          return [][Symbol.iterator]();
        },
      };
      statements.push(stmt);
      return stmt;
    },
  };
  return db;
}

const diffData = (event: BugEvent) => event.d as unknown as DbDiffEventData;

describe("instrumentSqliteDatabase — INSERT", () => {
  it("records an INSERT as a db.diff with an after-image looked up by lastInsertRowid (synchronously)", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 1, lastInsertRowid: 7 }),
      get: (sql) =>
        /rowid = \?/i.test(sql) ? { id: 7, name: "Ada" } : undefined,
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-1",
      sessionId: "ses",
      emit: (e) => events.push(e),
    });

    const info = db.prepare("INSERT INTO orders (name) VALUES (?)").run("Ada");

    // Sync end-to-end: the driver returns a plain object (not a Promise) and events are already here.
    expect(info).not.toBeInstanceOf(Promise);
    expect(info).toEqual({ changes: 1, lastInsertRowid: 7 });
    expect(events).toHaveLength(1);
    const d = diffData(events[0]);
    expect(d.engine).toBe("sqlite");
    expect(d.op).toBe("insert");
    expect(d.table).toBe("orders");
    expect(d.pk).toEqual({ id: 7 });
    expect(d.after).toEqual({ id: 7, name: "Ada" });
    expect(d.requestId).toBe("req-1");
    // The after-image came from a rowid lookup bound with the driver's lastInsertRowid.
    const getCall = fake.calls.find((c) => c.method === "get");
    expect(getCall?.params).toEqual([7]);
  });

  it("looks up a bigint rowid after-image", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 1, lastInsertRowid: 42n }),
      get: () => ({ id: 42, name: "Grace" }),
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-big",
      emit: (e) => events.push(e),
    });

    db.prepare("INSERT INTO people (name) VALUES (?)").run("Grace");

    expect(diffData(events[0]).after).toEqual({ id: 42, name: "Grace" });
    expect(fake.calls.find((c) => c.method === "get")?.params).toEqual([42n]);
  });

  it("falls back to an image-less db.diff with rowCount when changes > 1 (multi-row insert)", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 3, lastInsertRowid: 9 }),
      get: () => ({ id: 9 }),
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-multi",
      emit: (e) => events.push(e),
    });

    db.prepare("INSERT INTO orders (name) SELECT name FROM staging").run();

    expect(events).toHaveLength(1);
    const d = diffData(events[0]);
    expect(d.engine).toBe("sqlite");
    expect(d.op).toBe("insert");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(3);
    expect(d.after).toBeUndefined();
    // A multi-row insert must NOT attempt a per-row rowid lookup.
    expect(fake.calls.some((c) => c.method === "get")).toBe(false);
  });

  it("falls back to an image-less db.diff when the rowid lookup fails (WITHOUT ROWID / select error)", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 1, lastInsertRowid: 5 }),
      get: () => {
        throw new Error("no such column: rowid");
      },
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-norowid",
      emit: (e) => events.push(e),
    });

    const info = db
      .prepare("INSERT INTO kv (k, v) VALUES (?, ?)")
      .run("a", "b");

    expect(info).toEqual({ changes: 1, lastInsertRowid: 5 });
    expect(events[0].k).toBe(CAPTURE_GAP_EVENT_KIND);
    expect(events[0].d).toMatchObject({ reason: "capture_exception" });
    const diff = events.find((event) => event.k === DB_DIFF_EVENT_KIND);
    expect(diff).toBeDefined();
    const d = diffData(diff!);
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(1);
    expect(d.engine).toBe("sqlite");
  });
});

describe("instrumentSqliteDatabase — UPDATE", () => {
  it("captures after-images via pre-SELECT pks + post-SELECT, binding the trailing positional param", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 1, lastInsertRowid: 0 }),
      all: (sql) =>
        /WHERE id IN/i.test(sql)
          ? [{ id: 3, status: "shipped" }]
          : [{ id: 3, status: "pending" }],
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-u",
      emit: (e) => events.push(e),
    });

    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run("shipped", 3);

    expect(events).toHaveLength(1);
    const d = diffData(events[0]);
    expect(d.engine).toBe("sqlite");
    expect(d.op).toBe("update");
    expect(d.table).toBe("orders");
    expect(d.after).toEqual({ id: 3, status: "shipped" });
    // captureBefore is off by default → no before-image.
    expect(d.before).toBeUndefined();

    // The pre-SELECT reused only the trailing WHERE param (`3`), not the SET value ("shipped").
    const preSelect = fake.calls.find(
      (c) => c.method === "all" && /WHERE id = \?/i.test(c.sql),
    );
    expect(preSelect?.params).toEqual([3]);
    // The pre-SELECT ran BEFORE the host mutation.
    const preIndex = fake.calls.indexOf(preSelect!);
    const runIndex = fake.calls.findIndex((c) => c.method === "run");
    expect(preIndex).toBeGreaterThanOrEqual(0);
    expect(preIndex).toBeLessThan(runIndex);
    // Regression guard: the host statement's run() executes exactly once — instrumentation must
    // never re-run (or duplicate) the caller's mutation.
    expect(fake.calls.filter((c) => c.method === "run")).toHaveLength(1);
  });

  it("captures composite-pk UPDATE after-images via buildPostSelectByPk's OR-of-ANDs post-SELECT", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 2, lastInsertRowid: 0 }),
      all: (sql) =>
        /\(a = \?/i.test(sql)
          ? [
              { a: 1, b: "x", status: "shipped" },
              { a: 2, b: "y", status: "shipped" },
            ]
          : [
              { a: 1, b: "x", status: "pending" },
              { a: 2, b: "y", status: "pending" },
            ],
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-composite",
      pkColumns: { items: ["a", "b"] },
      emit: (e) => events.push(e),
    });

    db.prepare("UPDATE items SET status = ? WHERE region = ?").run(
      "shipped",
      "east",
    );

    // One per-row db.diff per matched row, each carrying the composite pk.
    expect(events).toHaveLength(2);
    expect(diffData(events[0]).pk).toEqual({ a: 1, b: "x" });
    expect(diffData(events[0]).after).toEqual({
      a: 1,
      b: "x",
      status: "shipped",
    });
    expect(diffData(events[1]).pk).toEqual({ a: 2, b: "y" });
    expect(diffData(events[1]).after).toEqual({
      a: 2,
      b: "y",
      status: "shipped",
    });

    // buildPostSelectByPk's OR-of-ANDs branch: one `(col = ? AND col = ?)` clause per matched row,
    // with params flattened in row-major order (pk1.a, pk1.b, pk2.a, pk2.b) — never grouped by column.
    const postSelect = fake.calls.find(
      (c) => c.method === "all" && /\(a = \?/i.test(c.sql),
    );
    expect(postSelect?.sql).toBe(
      "SELECT * FROM items WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)",
    );
    expect(postSelect?.params).toEqual([1, "x", 2, "y"]);
  });

  it("binds a named-params object through to the pre-SELECT unchanged", () => {
    const namedObject = { status: "shipped", id: 3 };
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 1, lastInsertRowid: 0 }),
      all: (sql) =>
        /WHERE id IN/i.test(sql)
          ? [{ id: 3, status: "shipped" }]
          : [{ id: 3, status: "pending" }],
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-named",
      emit: (e) => events.push(e),
    });

    db.prepare("UPDATE orders SET status = @status WHERE id = @id").run(
      namedObject,
    );

    expect(diffData(events[0]).after).toEqual({ id: 3, status: "shipped" });
    const preSelect = fake.calls.find(
      (c) => c.method === "all" && /WHERE id = @id/i.test(c.sql),
    );
    // SQLite named binding is name-based: the same object is passed straight through.
    expect(preSelect?.params).toEqual([namedObject]);
  });

  it("includes the before-image only when captureBefore is enabled", () => {
    const makeFake = () =>
      fakeSqliteDatabase({
        run: () => ({ changes: 1, lastInsertRowid: 0 }),
        all: (sql) =>
          /WHERE id IN/i.test(sql)
            ? [{ id: 3, status: "shipped" }]
            : [{ id: 3, status: "pending" }],
      });

    const onEvents: BugEvent[] = [];
    const on = instrumentSqliteDatabase(makeFake(), {
      requestId: "req-before-on",
      captureBefore: true,
      emit: (e) => onEvents.push(e),
    });
    on.prepare("UPDATE orders SET status = ? WHERE id = ?").run("shipped", 3);
    expect(diffData(onEvents[0]).before).toEqual({ id: 3, status: "pending" });
    expect(diffData(onEvents[0]).after).toEqual({ id: 3, status: "shipped" });

    const offEvents: BugEvent[] = [];
    const off = instrumentSqliteDatabase(makeFake(), {
      requestId: "req-before-off",
      emit: (e) => offEvents.push(e),
    });
    off.prepare("UPDATE orders SET status = ? WHERE id = ?").run("shipped", 3);
    expect(diffData(offEvents[0]).before).toBeUndefined();
  });

  it("falls back to an image-less db.diff for a WHERE-less UPDATE (no pre-SELECT possible)", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 4, lastInsertRowid: 0 }),
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-nowhere",
      emit: (e) => events.push(e),
    });

    db.prepare("UPDATE orders SET status = ?").run("archived");

    expect(events).toHaveLength(1);
    const d = diffData(events[0]);
    expect(d.op).toBe("update");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(4);
    expect(d.engine).toBe("sqlite");
    // No SELECTs were attempted for a WHERE-less update.
    expect(fake.calls.some((c) => c.method === "all")).toBe(false);
  });

  it("still runs the mutation and emits an image-less diff when the pre-SELECT throws", () => {
    const fake = {
      calls: [] as FakeCall[],
      prepare(sql: unknown) {
        this.calls.push({ method: "prepare", sql: String(sql), params: [] });
        const calls = this.calls;
        return {
          run(...params: unknown[]) {
            calls.push({ method: "run", sql: String(sql), params });
            return { changes: 2, lastInsertRowid: 0 };
          },
          all(...params: unknown[]) {
            calls.push({ method: "all", sql: String(sql), params });
            throw new Error("no such table: orders");
          },
          get() {
            return undefined;
          },
        };
      },
    };
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-preselect-throws",
      emit: (e) => events.push(e),
    });

    const info = db
      .prepare("UPDATE orders SET status = ? WHERE id = ?")
      .run("shipped", 3);

    // The host mutation still ran and returned its real result.
    expect(info).toEqual({ changes: 2, lastInsertRowid: 0 });
    expect(fake.calls.some((c) => c.method === "run")).toBe(true);
    // Capture degraded to an image-less diff carrying the row count.
    expect(events[0].k).toBe(CAPTURE_GAP_EVENT_KIND);
    expect(events[0].d).toMatchObject({ reason: "capture_exception" });
    const diff = events.find((event) => event.k === DB_DIFF_EVENT_KIND);
    expect(diff).toBeDefined();
    const d = diffData(diff!);
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(2);
    expect(d.engine).toBe("sqlite");
  });

  it("emits capped per-row db.diff events plus a db.diff.bulk summary over the per-statement cap", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 5, lastInsertRowid: 0 }),
      all: (sql) =>
        /WHERE id IN/i.test(sql)
          ? [
              { id: 1, status: "ready" },
              { id: 2, status: "ready" },
              { id: 3, status: "ready" },
            ]
          : [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }],
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-bulk",
      maxRowsPerStatement: 3,
      emit: (e) => events.push(e),
    });

    db.prepare("UPDATE orders SET status = ? WHERE status = ?").run(
      "ready",
      "pending",
    );

    expect(events.map((e) => e.k)).toEqual([
      DB_DIFF_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
      DB_DIFF_BULK_EVENT_KIND,
    ]);
    expect(events[3].d as unknown as DbDiffBulkEventData).toEqual({
      engine: "sqlite",
      op: "update",
      table: "orders",
      requestId: "req-bulk",
      rowCount: 5,
      emittedRows: 3,
      truncatedRows: 2,
      samplePks: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
  });
});

describe("instrumentSqliteDatabase — DELETE", () => {
  it("records a DELETE with the removed row as the before-image and no after", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 1, lastInsertRowid: 0 }),
      all: () => [{ id: 9, name: "gone" }],
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-d",
      emit: (e) => events.push(e),
    });

    db.prepare("DELETE FROM widgets WHERE id = ?").run(9);

    expect(events).toHaveLength(1);
    const d = diffData(events[0]);
    expect(d.engine).toBe("sqlite");
    expect(d.op).toBe("delete");
    expect(d.table).toBe("widgets");
    expect(d.before).toEqual({ id: 9, name: "gone" });
    expect(d.after).toBeUndefined();
    // The before-image SELECT ran before the delete removed the row.
    const preIndex = fake.calls.findIndex((c) => c.method === "all");
    const runIndex = fake.calls.findIndex((c) => c.method === "run");
    expect(preIndex).toBeLessThan(runIndex);
  });

  it("falls back to an image-less diff for a WHERE-less DELETE", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 8, lastInsertRowid: 0 }),
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-del-all",
      emit: (e) => events.push(e),
    });

    db.prepare("DELETE FROM widgets").run();

    const d = diffData(events[0]);
    expect(d.op).toBe("delete");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(8);
    expect(d.engine).toBe("sqlite");
  });
});

describe("instrumentSqliteDatabase — read capture", () => {
  function readRows(count: number, extra: Record<string, unknown> = {}) {
    return Array.from({ length: count }, (_, index) => ({
      id: index + 1,
      rank: index + 1,
      ...extra,
    }));
  }

  it("does not capture SELECT rows unless captureReads is enabled", () => {
    const fake = fakeSqliteDatabase({ all: () => readRows(2) });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-read-off",
      emit: (e) => events.push(e),
    });

    const result = db
      .prepare("SELECT * FROM invoice_rankings WHERE tenant_id = ?")
      .all("acme");

    expect(result).toEqual(readRows(2));
    expect(events).toEqual([]);
  });

  it("emits capped, redacted db.read events when captureReads is enabled", () => {
    const fake = fakeSqliteDatabase({
      all: () => readRows(2, { token: "tok_secret_value_should_vanish" }),
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-read",
      sessionId: "ses-read",
      captureReads: true,
      emit: (e) => events.push(e),
    });

    db.prepare("SELECT * FROM invoice_rankings WHERE tenant_id = ?").all(
      "acme",
    );

    expect(events.map((e) => e.k)).toEqual([
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
    ]);
    const d = events[0].d as unknown as DbReadEventData;
    expect(d).toMatchObject({
      engine: "sqlite",
      table: "invoice_rankings",
      pk: { id: 1 },
      requestId: "req-read",
      row: { id: 1, rank: 1, token: "[REDACTED]" },
    });
    expect(JSON.stringify(events)).not.toContain(
      "tok_secret_value_should_vanish",
    );
  });

  it("emits db.read.bulk over the per-statement read cap with engine sqlite", () => {
    const fake = fakeSqliteDatabase({ all: () => readRows(5) });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-read-bulk",
      captureReads: true,
      maxReadRowsPerStatement: 2,
      emit: (e) => events.push(e),
    });

    db.prepare("SELECT * FROM invoice_rankings").all();

    expect(events.map((e) => e.k)).toEqual([
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
      DB_READ_BULK_EVENT_KIND,
    ]);
    expect(events[2].d as unknown as DbReadBulkEventData).toEqual({
      engine: "sqlite",
      table: "invoice_rankings",
      requestId: "req-read-bulk",
      rowCount: 5,
      emittedRows: 2,
      truncatedRows: 3,
      samplePks: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
  });

  it("does not instrument .get() on a SELECT statement", () => {
    const fake = fakeSqliteDatabase({ get: () => ({ id: 1, rank: 1 }) });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-get",
      captureReads: true,
      emit: (e) => events.push(e),
    });

    const row = db
      .prepare("SELECT * FROM invoice_rankings WHERE id = ?")
      .get(1);

    expect(row).toEqual({ id: 1, rank: 1 });
    expect(events).toEqual([]);
  });
});

describe("instrumentSqliteDatabase — never-fail guarantees", () => {
  it("skips emission when no request scope is active but still runs the host mutation", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 1, lastInsertRowid: 1 }),
      get: () => ({ id: 1 }),
    });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      getRequestId: () => undefined,
      emit: (e) => events.push(e),
    });

    const info = db.prepare("INSERT INTO t (a) VALUES (?)").run(1);

    expect(info).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(events).toEqual([]);
    // No correlation → no capture SELECTs either.
    expect(fake.calls.some((c) => c.method === "get")).toBe(false);
  });

  it("does not break the host query when emission throws", () => {
    const fake = fakeSqliteDatabase({
      run: () => ({ changes: 1, lastInsertRowid: 7 }),
      get: () => ({ id: 7, name: "Ada" }),
    });
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-emit-throws",
      emit: () => {
        throw new Error("sink exploded");
      },
    });

    const info = db.prepare("INSERT INTO orders (name) VALUES (?)").run("Ada");

    expect(info).toEqual({ changes: 1, lastInsertRowid: 7 });
  });

  it("leaves unparseable SQL statements untouched (passthrough, no proxy)", () => {
    const fake = fakeSqliteDatabase({ run: () => ({ ok: true }) });
    const events: BugEvent[] = [];
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-unparseable",
      emit: (e) => events.push(e),
    });

    const stmt = db.prepare("PRAGMA foreign_keys = ON");
    // The returned statement is the real one, not a wrapping proxy.
    expect(stmt).toBe(fake.statements[fake.statements.length - 1]);

    const info = stmt.run();
    expect(info).toEqual({ ok: true });
    expect(events).toEqual([]);
  });

  it("passes non-string prepared SQL straight through", () => {
    const fake = fakeSqliteDatabase();
    const db = instrumentSqliteDatabase(fake, {
      requestId: "req-nonstring",
      emit: () => {},
    });

    const stmt = db.prepare({ toString: () => "weird" } as unknown as string);
    expect(stmt).toBe(fake.statements[fake.statements.length - 1]);
  });
});
