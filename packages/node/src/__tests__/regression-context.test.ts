import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "../mcp-server";
import {
  buildRegressionContext,
  REGRESSION_CONTEXT_SCHEMA_VERSION,
} from "../compare/regression-context";
import type { SessionComparison } from "../compare";
import type { BugEvent } from "crumbtrail-core";

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "crumbtrail-regression-context-"),
  );
  tempRoots.push(root);
  return root;
}

const comparison: SessionComparison = {
  schemaVersion: "session-compare.v1",
  verdict: "regression",
  confidence: "high",
  a: { sessionId: "sess-a" },
  b: { sessionId: "sess-b" },
  alignment: { matchedSteps: 1, unmatchedA: 0, unmatchedB: 0 },
  divergences: [
    {
      plane: "db",
      kind: "db.row-value",
      sig: "checkout-submit",
      requestId: "req-1",
      table: "orders",
      pk: { id: 1 },
      before: { total_cents: 1299 },
      after: { total_cents: 1399 },
      brief: 'database row value changed for orders {"id":1}',
    },
  ],
  noise: { suppressedCount: 0, rules: [] },
  evidence: [],
  intent: [],
};

function writeSession(root: string, id: string, totalCents: number): string {
  const dir = path.join(root, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ sessionId: id }),
  );
  fs.writeFileSync(
    path.join(dir, "signatures.json"),
    JSON.stringify({
      schemaVersion: 1,
      entries: [
        {
          id: 1,
          sig: "checkout-submit",
          path: "button[data-testid=place-order]",
          tag: "BUTTON",
        },
      ],
    }),
  );
  fs.writeFileSync(
    path.join(dir, "index.json"),
    JSON.stringify({
      id,
      fullStackRequests: {
        linked: [
          {
            requestId: "req-1",
            frontend: { ref: { t: 1100, k: "net.req" } },
            backend: {
              start: { t: 1120, k: "backend.req.start" },
              end: { t: 1300, k: "backend.req.end" },
            },
          },
        ],
      },
    }),
  );
  const events: BugEvent[] = [
    {
      t: 1000,
      k: "clk",
      d: { el: { sig: "checkout-submit", txt: "Place order" } },
    },
    {
      t: 1100,
      k: "net.req",
      d: { id: "r1", requestId: "req-1", method: "POST", url: "/api/checkout" },
    },
    { t: 1200, k: "net.res", d: { id: "r1", requestId: "req-1", st: 200 } },
    {
      t: 1300,
      k: "db.diff",
      d: {
        table: "orders",
        op: "insert",
        pk: { id: 1 },
        after: { id: 1, total_cents: totalCents },
        requestId: "req-1",
      },
    },
  ];
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  return dir;
}

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("buildRegressionContext", () => {
  it("wraps a comparison in regression-context.v1 with grounded interaction, window, and db rows", async () => {
    const root = makeRoot();
    const bDir = writeSession(root, "sess-b", 1399);

    const context = await buildRegressionContext(comparison, bDir);

    expect(context.schemaVersion).toBe(REGRESSION_CONTEXT_SCHEMA_VERSION);
    expect(context.comparison).toBe(comparison);
    // No release metadata on this comparison -> title falls back to session ids,
    // and there is no env divergence -> env_delta is null.
    expect(context.title).toBe("sess-a vs sess-b");
    expect(context.env_delta).toBeNull();
    expect(context.divergent_interaction).toEqual({
      sig: "checkout-submit",
      label: "BUTTON",
      path: "button[data-testid=place-order]",
    });
    expect(context.causal_window).toEqual(
      expect.objectContaining({ requestIds: ["req-1"], t0: 100, t1: 2300 }),
    );
    expect(context.db_rows).toEqual([
      {
        table: "orders",
        pk: { id: 1 },
        before: { total_cents: 1299 },
        after: { total_cents: 1399 },
      },
    ]);
  });

  it("surfaces the env delta channel and a release-named title", async () => {
    const root = makeRoot();
    const bDir = writeSession(root, "sess-b", 1399);

    const withEnv: SessionComparison = {
      ...comparison,
      a: { sessionId: "sess-a", release: "R181" },
      b: { sessionId: "sess-b", release: "R182" },
      envDelta: {
        flags: {
          added: [],
          removed: [],
          changed: [{ key: "newCheckout", before: false, after: true }],
        },
        config: { added: [], removed: [], changed: [] },
        release: { before: "R181", after: "R182" },
      },
    };

    const context = await buildRegressionContext(withEnv, bDir);

    expect(context.title).toBe("R181 vs R182");
    expect(context.env_delta).toEqual(withEnv.envDelta);
  });
});

describe("McpServer getRegressionContext", () => {
  it("compares two session ids and returns regression-context.v1 over JSON-RPC", async () => {
    const root = makeRoot();
    writeSession(root, "sess-a", 1299);
    writeSession(root, "sess-b", 1399);
    const server = new McpServer({ outputDir: root });

    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "getRegressionContext",
        arguments: { sessionA: "sess-a", sessionB: "sess-b" },
      },
    });

    const result = response!.result as any;
    const text = result.content[0].text;
    const context = JSON.parse(text);
    expect(context.schemaVersion).toBe("regression-context.v1");
    expect(context.comparison.verdict).toBe("regression");
    expect(context.db_rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "orders",
          after: expect.objectContaining({ total_cents: 1399 }),
        }),
      ]),
    );
  });
});
