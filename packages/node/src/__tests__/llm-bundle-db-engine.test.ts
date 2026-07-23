import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BugEvent } from "crumbtrail-core";
import { writeLlmBundle, type SessionIndexLike } from "../llm-bundle";

/**
 * CP5: the bundle's db-diff/db-read builders must pass through each event's `engine` tag
 * (validated against the DbEngine union) instead of hardcoding postgres, while legacy engineless
 * events keep the postgres default. Uses the established writeLlmBundle harness (temp session dir)
 * with a minimal, purpose-built fixture so it never collides with the broader llm-bundle suite.
 */
describe("llm bundle — db engine passthrough", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-llm-db-engine-"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const start = 1_700_000_000_000;

  const events: BugEvent[] = [
    // Explicit non-postgres engine on a diff.
    {
      t: start + 100,
      k: "db.diff",
      d: {
        engine: "mssql",
        op: "insert",
        table: "orders",
        pk: { id: 1 },
        after: { id: 1, total_cents: 1299 },
        requestId: "req-1",
      },
    },
    // Explicit non-postgres engine on a read.
    {
      t: start + 200,
      k: "db.read",
      d: {
        engine: "mssql",
        table: "users",
        pk: { id: 5 },
        row: { id: 5, name: "ada" },
        requestId: "req-1",
      },
    },
    // Image-less statement-level fallback: pk null + rowCount, mysql engine.
    {
      t: start + 300,
      k: "db.diff",
      d: {
        engine: "mysql",
        op: "insert",
        table: "audit_log",
        pk: null,
        rowCount: 7,
        requestId: "req-1",
      },
    },
    // Legacy engineless diff → must default to postgres.
    {
      t: start + 400,
      k: "db.diff",
      d: {
        op: "update",
        table: "carts",
        pk: { id: 2 },
        after: { id: 2, items: 3 },
        requestId: "req-2",
      },
    },
    // Legacy engineless read → must default to postgres.
    {
      t: start + 500,
      k: "db.read",
      d: {
        table: "sessions",
        pk: { id: 9 },
        row: { id: 9, token: "opaque" },
        requestId: "req-2",
      },
    },
  ];

  const index: SessionIndexLike = {
    id: "ses_db_engine",
    start,
    end: start + 500,
    dur: 500,
    evts: events.length,
    stats: { "db.diff": 3, "db.read": 2 },
  };

  it("passes through an explicit engine (mssql) on diffs and reads", async () => {
    const bundle = await writeLlmBundle({ sessionDir: tmpDir, events, index });

    const orders = bundle.databaseDiffs.find((d) => d.table === "orders");
    expect(orders).toBeDefined();
    expect(orders!.engine).toBe("mssql");

    const users = bundle.databaseReads.find((r) => r.table === "users");
    expect(users).toBeDefined();
    expect(users!.engine).toBe("mssql");
  });

  it("defaults legacy engineless diffs and reads to postgres", async () => {
    const bundle = await writeLlmBundle({ sessionDir: tmpDir, events, index });

    const carts = bundle.databaseDiffs.find((d) => d.table === "carts");
    expect(carts).toBeDefined();
    expect(carts!.engine).toBe("postgres");

    const sessions = bundle.databaseReads.find((r) => r.table === "sessions");
    expect(sessions).toBeDefined();
    expect(sessions!.engine).toBe("postgres");
  });

  it("surfaces an image-less statement-level fallback with rowCount and its engine", async () => {
    const bundle = await writeLlmBundle({ sessionDir: tmpDir, events, index });

    const auditLog = bundle.databaseDiffs.find((d) => d.table === "audit_log");
    expect(auditLog).toBeDefined();
    expect(auditLog!.engine).toBe("mysql");
    expect(auditLog!.pk).toBeNull();
    expect(auditLog!.rowCount).toBe(7);
  });
});
