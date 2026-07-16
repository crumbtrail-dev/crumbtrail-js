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
  type DbReadEventData,
} from "crumbtrail-core";
import { instrumentMssqlPool, type DuckTypedMssqlResult } from "../db/mssql";

type QueryHandler = (
  text: string,
  inputs: unknown[][],
) => DuckTypedMssqlResult | Promise<DuckTypedMssqlResult>;

interface RecordedRequest {
  inputs: unknown[][];
  queries: string[];
}

/**
 * A fake duck-typed `mssql` pool mirroring the `fakePgClient` style: it records every request's
 * `input()` tuples and `query()` texts (both per-request and in a flat, cross-request order) and
 * returns canned `{ recordset, rowsAffected }` results from `handler`.
 */
function fakeMssqlPool(handler: QueryHandler) {
  const requests: RecordedRequest[] = [];
  const queries: Array<{ text: string; inputs: unknown[][] }> = [];
  const pool = {
    requests,
    queries,
    request() {
      const inputs: unknown[][] = [];
      const record: RecordedRequest = { inputs, queries: [] };
      requests.push(record);
      const request = {
        input(...args: unknown[]) {
          inputs.push(args);
          return request;
        },
        query(text: string) {
          record.queries.push(text);
          queries.push({ text, inputs: inputs.map((tuple) => tuple.slice()) });
          try {
            return Promise.resolve(handler(text, inputs));
          } catch (err) {
            return Promise.reject(err);
          }
        },
      };
      return request;
    },
    // The `mssql` convenience form: real pools delegate `pool.query(text)` to a fresh request.
    query(text: string): Promise<DuckTypedMssqlResult> {
      return pool.request().query(text);
    },
  };
  return pool;
}

function diffEvents(events: BugEvent[]): DbDiffEventData[] {
  return events
    .filter((event) => event.k === DB_DIFF_EVENT_KIND)
    .map((event) => event.d as unknown as DbDiffEventData);
}

describe("instrumentMssqlPool OUTPUT injection", () => {
  it("injects OUTPUT INSERTED.* before VALUES and records the insert diff", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 1, name: "Ada" }],
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "req-i",
      emit: (event) => events.push(event),
    });

    const request = db.request();
    request.input("name", "Ada");
    await request.query("INSERT INTO orders (name) VALUES (@name)");

    expect(pool.queries[0].text).toBe(
      "INSERT INTO orders (name) OUTPUT INSERTED.* VALUES (@name)",
    );
    const [d] = diffEvents(events);
    expect(d.engine).toBe("mssql");
    expect(d.op).toBe("insert");
    expect(d.table).toBe("orders");
    expect(d.pk).toEqual({ id: 1 });
    expect(d.after).toEqual({ id: 1, name: "Ada" });
    expect(d.requestId).toBe("req-i");
  });

  it("injects OUTPUT INSERTED.* on a schema-qualified [dbo].[table] name", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 7, name: "q" }],
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    await db
      .request()
      .query("INSERT INTO [dbo].[orders] (name) VALUES (@name)");

    expect(pool.queries[0].text).toBe(
      "INSERT INTO [dbo].[orders] (name) OUTPUT INSERTED.* VALUES (@name)",
    );
    expect(diffEvents(events)[0].table).toBe("dbo.orders");
  });

  it("injects OUTPUT INSERTED.* before DEFAULT VALUES", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 3 }],
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    await db.request().query("INSERT INTO orders DEFAULT VALUES");

    expect(pool.queries[0].text).toBe(
      "INSERT INTO orders OUTPUT INSERTED.* DEFAULT VALUES",
    );
    expect(diffEvents(events)[0].pk).toEqual({ id: 3 });
  });

  it("injects OUTPUT INSERTED.* before SELECT for INSERT ... SELECT", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 1 }, { id: 2 }],
      rowsAffected: [2],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    await db
      .request()
      .query("INSERT INTO orders (name) SELECT name FROM staging");

    expect(pool.queries[0].text).toBe(
      "INSERT INTO orders (name) OUTPUT INSERTED.* SELECT name FROM staging",
    );
    expect(diffEvents(events)).toHaveLength(2);
  });

  it("injects OUTPUT INSERTED.* before WHERE for a plain UPDATE", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 5, status: "shipped" }],
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    const request = db.request();
    request.input("status", "shipped").input("id", 5);
    await request.query("UPDATE orders SET status = @status WHERE id = @id");

    expect(pool.queries[0].text).toBe(
      "UPDATE orders SET status = @status OUTPUT INSERTED.* WHERE id = @id",
    );
    const [d] = diffEvents(events);
    expect(d.op).toBe("update");
    expect(d.after).toEqual({ id: 5, status: "shipped" });
  });

  it("injects OUTPUT INSERTED.* before the top-level FROM for UPDATE ... FROM", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 5, total: 9 }],
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    await db
      .request()
      .query(
        "UPDATE o SET o.total = s.total FROM orders o JOIN staging s ON o.id = s.id WHERE o.id = 5",
      );

    expect(pool.queries[0].text).toBe(
      "UPDATE o SET o.total = s.total OUTPUT INSERTED.* FROM orders o JOIN staging s ON o.id = s.id WHERE o.id = 5",
    );
  });

  it("appends OUTPUT INSERTED.* for an UPDATE with no FROM or WHERE", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 1, flag: true }],
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    await db.request().query("UPDATE flags SET flag = 1");

    expect(pool.queries[0].text).toBe(
      "UPDATE flags SET flag = 1 OUTPUT INSERTED.*",
    );
  });

  it("injects OUTPUT DELETED.* after the target table and records the row as before-image", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 9, name: "gone" }],
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    const request = db.request();
    request.input("id", 9);
    await request.query("DELETE FROM widgets WHERE id = @id");

    expect(pool.queries[0].text).toBe(
      "DELETE FROM widgets OUTPUT DELETED.* WHERE id = @id",
    );
    const [d] = diffEvents(events);
    expect(d.op).toBe("delete");
    expect(d.table).toBe("widgets");
    expect(d.before).toEqual({ id: 9, name: "gone" });
    expect(d.after).toBeUndefined();
  });

  it("injects OUTPUT DELETED.* on a [dbo].[table] delete with TOP (n)", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 1 }],
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    await db
      .request()
      .query("DELETE TOP (10) FROM [dbo].[orders] WHERE status = 'x'");

    expect(pool.queries[0].text).toBe(
      "DELETE TOP (10) FROM [dbo].[orders] OUTPUT DELETED.* WHERE status = 'x'",
    );
    expect(diffEvents(events)[0].table).toBe("dbo.orders");
  });
});

describe("instrumentMssqlPool result stripping", () => {
  it("consumes injected OUTPUT rows and returns a host result with them stripped", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 1, name: "Ada" }],
      recordsets: [[{ id: 1, name: "Ada" }]],
      rowsAffected: [1],
      returnValue: 0,
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    const result = await db
      .request()
      .query("INSERT INTO orders (name) VALUES (@name)");

    // The host sees the shape a plain INSERT (no OUTPUT) would have produced...
    expect(result.recordset).toBeUndefined();
    expect(result.recordsets).toEqual([]);
    // ...with rowsAffected and other driver properties preserved.
    expect(result.rowsAffected).toEqual([1]);
    expect(result.returnValue).toBe(0);
    // ...but the diff still captured the injected after-image.
    expect(diffEvents(events)[0].after).toEqual({ id: 1, name: "Ada" });
  });

  it("does not strip and records a capture gap when the statement already has an OUTPUT clause", async () => {
    const hostRows = [{ id: 1, name: "Ada" }];
    const pool = fakeMssqlPool(() => ({
      recordset: hostRows,
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    const result = await db
      .request()
      .query("INSERT INTO orders (name) OUTPUT INSERTED.* VALUES (@name)");

    // Ran verbatim (no second OUTPUT injected)...
    expect(pool.queries).toHaveLength(1);
    expect(pool.queries[0].text).toBe(
      "INSERT INTO orders (name) OUTPUT INSERTED.* VALUES (@name)",
    );
    // ...host keeps its own OUTPUT rows (never stripped)...
    expect(result.recordset).toBe(hostRows);
    // ...and no diff is captured because the caller owns the OUTPUT rows.
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe(CAPTURE_GAP_EVENT_KIND);
    expect(events[0].d).toMatchObject({ reason: "capture_exception" });
  });
});

describe("instrumentMssqlPool trigger 334 fallback", () => {
  it("re-runs the ORIGINAL text on a fresh request with replayed inputs and emits an image-less diff", async () => {
    let call = 0;
    const pool = fakeMssqlPool((text) => {
      call += 1;
      if (call === 1) {
        // First call is the OUTPUT-injected statement; it fails to COMPILE on a triggered table.
        return Promise.reject({
          number: 334,
          message:
            "The target table 'orders' of the DML statement cannot have any enabled triggers if the statement contains an OUTPUT clause without INTO clause.",
        });
      }
      // Second call is the original re-run — the real mutation applies here.
      return Promise.resolve({
        recordset: undefined,
        rowsAffected: [1],
        returnValue: 0,
      });
    });
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "req-334",
      emit: (event) => events.push(event),
    });

    const request = db.request();
    request.input("name", "Ada");
    const result = await request.query(
      "INSERT INTO orders (name) VALUES (@name)",
    );

    // The host gets the real (fallback) result.
    expect(result.rowsAffected).toEqual([1]);
    expect(result.returnValue).toBe(0);

    // Exactly two executions: injected-with-OUTPUT, then the ORIGINAL text — no more.
    expect(pool.queries).toHaveLength(2);
    expect(pool.queries[0].text).toBe(
      "INSERT INTO orders (name) OUTPUT INSERTED.* VALUES (@name)",
    );
    expect(pool.queries[1].text).toBe(
      "INSERT INTO orders (name) VALUES (@name)",
    );

    // The re-run happened on a FRESH request (2 requests total) with the inputs replayed verbatim.
    expect(pool.requests).toHaveLength(2);
    expect(pool.requests[1].inputs).toEqual([["name", "Ada"]]);
    expect(pool.queries[1].inputs).toEqual([["name", "Ada"]]);

    // An image-less diff records the write (rowCount from rowsAffected).
    const [d] = diffEvents(events);
    expect(d.op).toBe("insert");
    expect(d.table).toBe("orders");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(1);
    expect(d.after).toBeUndefined();
  });

  it("propagates any non-334 error with NO re-run (single execution guaranteed)", async () => {
    let call = 0;
    const pool = fakeMssqlPool(() => {
      call += 1;
      return Promise.reject(
        Object.assign(new Error("Violation of PRIMARY KEY constraint"), {
          number: 2627,
        }),
      );
    });
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    await expect(
      db.request().query("INSERT INTO orders (name) VALUES (@name)"),
    ).rejects.toThrow(/PRIMARY KEY/);

    // The injected statement ran once and the error propagated — no fallback re-run.
    expect(call).toBe(1);
    expect(pool.queries).toHaveLength(1);
    expect(events).toHaveLength(0);
  });
});

describe("instrumentMssqlPool comment-bearing SQL safety gate", () => {
  it("runs the ORIGINAL untouched (image-less) for an UPDATE with a quote-bearing /* block comment */ before WHERE", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: undefined,
      rowsAffected: [1],
      returnValue: 0,
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "req-cmt-block",
      emit: (event) => events.push(event),
    });

    const request = db.request();
    request.input("status", "shipped").input("id", 5);
    const original =
      "UPDATE orders SET status = @status /* don't ship yet */ WHERE id = @id";
    const result = await request.query(original);

    // Only the ORIGINAL text ever reached the driver — the historical bug appended OUTPUT AFTER the
    // real WHERE (invalid T-SQL); assert nothing sent ever has OUTPUT following a WHERE.
    expect(pool.queries).toHaveLength(1);
    expect(pool.queries[0].text).toBe(original);
    for (const q of pool.queries) {
      expect(q.text).not.toMatch(/WHERE[\s\S]*OUTPUT/i);
    }
    // Host result intact.
    expect(result.rowsAffected).toEqual([1]);
    expect(result.returnValue).toBe(0);
    // Image-less diff still records the write.
    const [d] = diffEvents(events);
    expect(d.op).toBe("update");
    expect(d.table).toBe("orders");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(1);
    expect(d.after).toBeUndefined();
  });

  it("runs the ORIGINAL untouched (image-less) for an UPDATE with a quote-bearing -- line comment before WHERE", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: undefined,
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "req-cmt-line",
      emit: (event) => events.push(event),
    });

    const request = db.request();
    request.input("status", "shipped").input("id", 5);
    const original =
      "UPDATE orders SET status = @status -- Ada's note\nWHERE id = @id";
    const result = await request.query(original);

    expect(pool.queries).toHaveLength(1);
    expect(pool.queries[0].text).toBe(original);
    for (const q of pool.queries) {
      expect(q.text).not.toMatch(/WHERE[\s\S]*OUTPUT/i);
    }
    expect(result.rowsAffected).toEqual([1]);
    const [d] = diffEvents(events);
    expect(d.op).toBe("update");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(1);
    expect(d.after).toBeUndefined();
  });

  it("runs a multi-statement batch untouched so the trailing SELECT recordset survives", async () => {
    const selectRows = [{ id: 1, a: "x" }];
    const pool = fakeMssqlPool(() => ({
      recordset: selectRows,
      recordsets: [selectRows],
      // A batch reports one rowsAffected entry per statement; the INSERT changed one row.
      rowsAffected: [1, 1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "req-batch",
      emit: (event) => events.push(event),
    });

    const request = db.request();
    request.input("a", "x");
    const original = "INSERT INTO t (a) VALUES (@a); SELECT * FROM t";
    const result = await request.query(original);

    // Sent verbatim — never injected (which would have stripped ALL recordsets, losing the SELECT).
    expect(pool.queries).toHaveLength(1);
    expect(pool.queries[0].text).toBe(original);
    // The host keeps the batch's SELECT recordset.
    expect(result.recordset).toBe(selectRows);
    expect(result.recordsets).toEqual([selectRows]);
    // The batch is explicitly gapped instead of pretending one statement represented the batch.
    expect(diffEvents(events)).toHaveLength(0);
    expect(events).toHaveLength(1);
    expect(events[0].k).toBe(CAPTURE_GAP_EVENT_KIND);
    expect(events[0].d).toMatchObject({
      reason: "unparsed_sql",
      detail: "INSERT",
    });
  });
});

describe("instrumentMssqlPool compile-class re-run allowlist", () => {
  it("re-runs the ORIGINAL on a fresh request when the injected query fails to compile (error 156)", async () => {
    const pool = fakeMssqlPool((text) => {
      // The fake rejects ANY OUTPUT-bearing query and resolves the original.
      if (/OUTPUT/i.test(text)) {
        return Promise.reject({
          number: 156,
          message: "Incorrect syntax near the keyword 'OUTPUT'.",
        });
      }
      return Promise.resolve({
        recordset: undefined,
        rowsAffected: [1],
        returnValue: 0,
      });
    });
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "req-156",
      emit: (event) => events.push(event),
    });

    const request = db.request();
    request.input("name", "Ada");
    const result = await request.query(
      "INSERT INTO orders (name) VALUES (@name)",
    );

    // Host gets the successful ORIGINAL result.
    expect(result.rowsAffected).toEqual([1]);
    expect(result.returnValue).toBe(0);

    // Call sequence: injected once, then the ORIGINAL once on a FRESH request with inputs replayed.
    expect(pool.queries).toHaveLength(2);
    expect(pool.queries[0].text).toBe(
      "INSERT INTO orders (name) OUTPUT INSERTED.* VALUES (@name)",
    );
    expect(pool.queries[1].text).toBe(
      "INSERT INTO orders (name) VALUES (@name)",
    );
    expect(pool.requests).toHaveLength(2);
    expect(pool.requests[1].inputs).toEqual([["name", "Ada"]]);
    expect(pool.queries[1].inputs).toEqual([["name", "Ada"]]);

    // Image-less diff records the write.
    const [d] = diffEvents(events);
    expect(d.op).toBe("insert");
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(1);
    expect(d.after).toBeUndefined();
  });

  it("propagates a runtime error (number 547) from the injected query with NO re-run", async () => {
    let call = 0;
    const pool = fakeMssqlPool(() => {
      call += 1;
      return Promise.reject(
        Object.assign(
          new Error(
            "The INSERT statement conflicted with the FOREIGN KEY constraint",
          ),
          { number: 547 },
        ),
      );
    });
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    await expect(
      db.request().query("INSERT INTO orders (name) VALUES (@name)"),
    ).rejects.toThrow(/FOREIGN KEY/);

    // Exactly one execution — a numbered runtime error is never re-run.
    expect(call).toBe(1);
    expect(pool.queries).toHaveLength(1);
    expect(events).toHaveLength(0);
  });
});

describe("instrumentMssqlPool captureBefore", () => {
  it("runs a pre-SELECT on a fresh request with replayed inputs before the mutation", async () => {
    const pool = fakeMssqlPool((text) =>
      /^select/i.test(text)
        ? { recordset: [{ id: 3, status: "pending" }], rowsAffected: [1] }
        : { recordset: [{ id: 3, status: "shipped" }], rowsAffected: [1] },
    );
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "req-u",
      captureBefore: true,
      emit: (event) => events.push(event),
    });

    const request = db.request();
    request.input("status", "shipped").input("id", 3);
    await request.query("UPDATE orders SET status = @status WHERE id = @id");

    // Pre-SELECT ran first, on a distinct fresh request, with the inputs replayed so @id is bound.
    expect(pool.queries[0].text).toBe("SELECT * FROM orders WHERE id = @id");
    expect(pool.requests).toHaveLength(2);
    expect(pool.requests[1].queries[0]).toBe(
      "SELECT * FROM orders WHERE id = @id",
    );
    expect(pool.requests[1].inputs).toEqual([
      ["status", "shipped"],
      ["id", 3],
    ]);
    // Then the injected UPDATE ran on the original request.
    expect(pool.queries[1].text).toBe(
      "UPDATE orders SET status = @status OUTPUT INSERTED.* WHERE id = @id",
    );

    const [d] = diffEvents(events);
    expect(d.before).toEqual({ id: 3, status: "pending" });
    expect(d.after).toEqual({ id: 3, status: "shipped" });
  });

  it("still runs the mutation when the pre-SELECT throws (no before-image)", async () => {
    const pool = fakeMssqlPool((text) => {
      if (/^select/i.test(text)) {
        return Promise.reject(new Error("permission denied for table orders"));
      }
      return Promise.resolve({
        recordset: [{ id: 3, status: "shipped" }],
        rowsAffected: [1],
      });
    });
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "req-u",
      captureBefore: true,
      emit: (event) => events.push(event),
    });

    const result = await db
      .request()
      .query("UPDATE orders SET status = @status WHERE id = @id");

    expect(result.rowsAffected).toEqual([1]);
    const [d] = diffEvents(events);
    expect(d.op).toBe("update");
    expect(d.after).toEqual({ id: 3, status: "shipped" });
    expect(d.before).toBeUndefined();
  });
});

describe("instrumentMssqlPool read capture", () => {
  it("does not capture SELECT rows unless captureReads is enabled", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 1 }],
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    await db
      .request()
      .query("SELECT * FROM invoice_rankings WHERE tenant_id = @t");

    expect(events).toEqual([]);
    // The SELECT ran verbatim (no injection).
    expect(pool.queries[0].text).toBe(
      "SELECT * FROM invoice_rankings WHERE tenant_id = @t",
    );
  });

  it("emits capped, redacted db.read events when captureReads is enabled", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [
        { id: 1, rank: 1, token: "tok_secret_value_should_vanish" },
        { id: 2, rank: 2, token: "tok_secret_value_should_vanish" },
        { id: 3, rank: 3 },
      ],
      rowsAffected: [3],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "req-read",
      captureReads: true,
      maxReadRowsPerStatement: 2,
      emit: (event) => events.push(event),
    });

    await db.request().query("SELECT * FROM invoice_rankings");

    expect(events.map((event) => event.k)).toEqual([
      DB_READ_EVENT_KIND,
      DB_READ_EVENT_KIND,
      DB_READ_BULK_EVENT_KIND,
    ]);
    const first = events[0].d as unknown as DbReadEventData;
    expect(first.engine).toBe("mssql");
    expect(first.table).toBe("invoice_rankings");
    expect(first.pk).toEqual({ id: 1 });
    expect(first.row).toEqual({ id: 1, rank: 1, token: "[REDACTED]" });
    expect(JSON.stringify(events)).not.toContain(
      "tok_secret_value_should_vanish",
    );
  });
});

describe("instrumentMssqlPool never-fail rules", () => {
  it("skips emission and injection when no request scope is active", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 1 }],
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      getRequestId: () => undefined,
      emit: (event) => events.push(event),
    });

    await db.request().query("INSERT INTO t (a) VALUES (@a)");

    expect(events).toHaveLength(0);
    // Ran verbatim — no OUTPUT injected without a correlation scope.
    expect(pool.queries[0].text).toBe("INSERT INTO t (a) VALUES (@a)");
  });

  it("does not break the host query when emission throws (result still stripped)", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 1, name: "Ada" }],
      rowsAffected: [1],
    }));
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: () => {
        throw new Error("sink exploded");
      },
    });

    const result = await db
      .request()
      .query("INSERT INTO orders (name) VALUES (@name)");

    expect(result.rowsAffected).toEqual([1]);
    expect(result.recordset).toBeUndefined();
  });

  it("passes unparseable SQL straight through with no events", async () => {
    const pool = fakeMssqlPool(() => ({ rowsAffected: [0] }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    await db.request().query("EXEC sp_do_something @arg = @a");

    expect(events).toHaveLength(0);
    expect(pool.queries[0].text).toBe("EXEC sp_do_something @arg = @a");
  });

  it("emits an image-less fallback when no confident INSERT injection point exists", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: undefined,
      rowsAffected: [4],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    // INSERT ... EXEC has no VALUES/SELECT/DEFAULT VALUES keyword → no injection point.
    const result = await db
      .request()
      .query("INSERT INTO orders (name) EXEC dbo.load_orders");

    // Ran the ORIGINAL untouched (never stripped, since we did not inject).
    expect(pool.queries[0].text).toBe(
      "INSERT INTO orders (name) EXEC dbo.load_orders",
    );
    expect(result.rowsAffected).toEqual([4]);
    const [d] = diffEvents(events);
    expect(d.pk).toBeNull();
    expect(d.rowCount).toBe(4);
  });
});

describe("instrumentMssqlPool bulk cap", () => {
  it("emits capped per-row db.diff events plus one db.diff.bulk summary tagged mssql", async () => {
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: index + 1,
      status: "ready",
    }));
    const pool = fakeMssqlPool(() => ({ recordset: rows, rowsAffected: [5] }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "req-over",
      sessionId: "ses-over",
      maxRowsPerStatement: 3,
      emit: (event) => events.push(event),
      now: () => 1_700_000_000_250,
      sessionStartedAt: 1_700_000_000_000,
    });

    await db
      .request()
      .query("UPDATE orders SET status = @status WHERE status = @old");

    expect(events).toHaveLength(4);
    expect(events.slice(0, 3).map((event) => event.k)).toEqual([
      DB_DIFF_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
      DB_DIFF_EVENT_KIND,
    ]);
    expect(events[3].k).toBe(DB_DIFF_BULK_EVENT_KIND);
    expect(events[3].d as unknown as DbDiffBulkEventData).toEqual({
      engine: "mssql",
      op: "update",
      table: "orders",
      requestId: "req-over",
      rowCount: 5,
      emittedRows: 3,
      truncatedRows: 2,
      samplePks: [{ id: 1 }, { id: 2 }, { id: 3 }],
    });
  });
});

describe("instrumentMssqlPool pool.query direct form", () => {
  it("instruments the plain single-string pool.query form", async () => {
    const pool = fakeMssqlPool(() => ({
      recordset: [{ id: 1, name: "Ada" }],
      rowsAffected: [1],
    }));
    const events: BugEvent[] = [];
    const db = instrumentMssqlPool(pool, {
      requestId: "r",
      emit: (event) => events.push(event),
    });

    const result = await db.query("INSERT INTO orders (name) VALUES ('Ada')");

    expect(pool.queries[0].text).toBe(
      "INSERT INTO orders (name) OUTPUT INSERTED.* VALUES ('Ada')",
    );
    expect(result.recordset).toBeUndefined();
    expect(diffEvents(events)[0].after).toEqual({ id: 1, name: "Ada" });
  });
});
