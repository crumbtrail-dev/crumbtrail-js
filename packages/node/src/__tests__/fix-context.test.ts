import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { postProcess } from "../post-process";
import {
  buildFixContext,
  FIX_CONTEXT_SCHEMA_VERSION,
  FixContextError,
} from "../fix-context";
import { runFixContext } from "../run-fix-context";
import { McpServer } from "../mcp-server";

const SESSION_ID = "ses_fc";

// A full-stack bug: a click triggers a POST that fails 500 on both the browser response and
// the correlated backend request, so post-processing yields a detector signal plus a linked
// frontend/backend full-stack request.
const EVENTS = [
  {
    t: 1000,
    k: "session.lifecycle",
    offsetMs: 0,
    d: { action: "start", reason: "user" },
  },
  { t: 1100, k: "clk", offsetMs: 100, d: { el: { txt: "Checkout" } } },
  {
    t: 1150,
    k: "net.req",
    offsetMs: 150,
    d: {
      id: "r1",
      requestId: "req-1",
      sessionId: SESSION_ID,
      m: "POST",
      url: "https://app.test/api/checkout",
    },
  },
  {
    t: 1160,
    k: "backend.req.start",
    offsetMs: 160,
    sessionId: SESSION_ID,
    d: {
      requestId: "req-1",
      sessionId: SESSION_ID,
      method: "POST",
      route: "/api/checkout",
    },
  },
  {
    t: 1500,
    k: "backend.req.end",
    offsetMs: 500,
    sessionId: SESSION_ID,
    d: {
      requestId: "req-1",
      sessionId: SESSION_ID,
      statusCode: 500,
      durationMs: 340,
    },
  },
  {
    t: 1520,
    k: "net.res",
    offsetMs: 520,
    d: {
      id: "r1",
      requestId: "req-1",
      sessionId: SESSION_ID,
      st: 500,
      dur: 370,
    },
  },
  {
    t: 1600,
    k: "session.lifecycle",
    offsetMs: 600,
    d: { action: "stop", reason: "user" },
  },
];

async function seedSession(outputDir: string): Promise<string> {
  const sessionDir = path.join(outputDir, SESSION_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "meta.json"),
    JSON.stringify({
      id: SESSION_ID,
      app: "shop",
      source: "crumbtrail-extension",
      start: 1000,
    }),
  );
  fs.writeFileSync(
    path.join(sessionDir, "events.ndjson"),
    EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  await postProcess(sessionDir);
  return sessionDir;
}

describe("buildFixContext", async () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-fc-"));
    sessionDir = await seedSession(tmpDir);
  });

  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("locks the fix-context.v2 schema shape with honest signal bases", async () => {
    const fc = await buildFixContext(sessionDir);

    expect(fc.schemaVersion).toBe("fix-context.v2");
    expect(FIX_CONTEXT_SCHEMA_VERSION).toBe("fix-context.v2");
    expect(Object.keys(fc).sort()).toEqual([
      "causal_chain",
      "environment",
      "primary_window",
      "repro_hint",
      "schemaVersion",
      "session",
      "signals",
    ]);
    expect(Object.keys(fc.primary_window).sort()).toEqual([
      "backend",
      "db_activity",
      "db_diffs",
      "db_reads",
      "frontend",
    ]);
    expect(fc.session.id).toBe(SESSION_ID);
    expect(fc.session.app).toBe("shop");
    expect(fc.signals[0]).toMatchObject({
      basis: "heuristic",
      detector: "backend_http_error",
      baseScore: 89,
      score: 89,
    });
  });

  it("omits code_pointers when no opinion artifact exists", async () => {
    const fc = await buildFixContext(sessionDir);
    expect("code_pointers" in fc).toBe(false);
  });

  it("surfaces cloud-resolved code pointers from the opinion artifact", async () => {
    const pointer = {
      repo: "acme/shop",
      path: "src/checkout.ts",
      line: 42,
      commitSha: "a".repeat(40),
      permalink: `https://github.com/acme/shop/blob/${"a".repeat(40)}/src/checkout.ts#L42`,
      resolution: "deploy",
    };
    fs.writeFileSync(
      path.join(sessionDir, "opinion.json"),
      JSON.stringify({
        schemaVersion: 1,
        findings: [],
        canonicalResults: [
          {
            issueKey: "issue-1",
            findings: [],
            analysis: {},
            codePointers: [pointer, { repo: "acme/shop" }],
          },
        ],
      }),
    );
    const fc = await buildFixContext(sessionDir);
    expect(fc.code_pointers).toEqual([pointer]);
  });

  it("defaults db_diffs/db_reads to [] and environment to null", async () => {
    const fc = await buildFixContext(sessionDir);
    expect(fc.primary_window.db_diffs).toEqual([]);
    expect(fc.primary_window.db_reads).toEqual([]);
    expect(fc.environment).toBeNull();
  });

  it("populates environment from the session env snapshot with secrets redacted", async () => {
    const envTmp = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-fc-env-"));
    try {
      const envSessionId = "ses_fc_env";
      const dir = path.join(envTmp, envSessionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ id: envSessionId, app: "shop", start: 1000 }),
      );
      const envEvents = [
        {
          t: 1000,
          k: "session.lifecycle",
          offsetMs: 0,
          d: { action: "start" },
        },
        {
          t: 1010,
          k: "env",
          offsetMs: 10,
          d: {
            kind: "snapshot",
            userAgent: "Mozilla/5.0 (Macintosh) Chrome/120.0.0.0",
            browser: { name: "Chrome", version: "120.0.0.0" },
            os: "macOS",
            locale: "en-US",
            timezone: "America/New_York",
            flags: {
              newCheckout: true,
              apiKey: "sk_fake_abcdefghijklmnopqrstuvwx",
            },
            config: { region: "eu", password: "hunter2-very-secret" },
          },
        },
        {
          t: 1600,
          k: "session.lifecycle",
          offsetMs: 600,
          d: { action: "stop" },
        },
      ];
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        envEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(dir);

      const fc = await buildFixContext(dir);
      expect(fc.environment).not.toBeNull();
      const env = fc.environment as Record<string, any>;
      expect(env.browser.name).toBe("Chrome");
      expect(env.timezone).toBe("America/New_York");
      expect(env.flags.newCheckout).toBe(true);
      expect(env.config.region).toBe("eu");

      const serialized = JSON.stringify(fc.environment);
      expect(serialized).not.toContain("sk_fake_abcdefghijklmnopqrstuvwx");
      expect(serialized).not.toContain("hunter2-very-secret");
    } finally {
      fs.rmSync(envTmp, { recursive: true, force: true });
    }
  });

  it("populates primary_window.db_diffs from db.diff events in the window, redacted", async () => {
    const dbTmp = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-fc-db-"));
    try {
      const dbSessionId = "ses_fc_db";
      const dir = path.join(dbTmp, dbSessionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ id: dbSessionId, app: "shop", start: 1000 }),
      );
      const dbEvents = [
        ...EVENTS.slice(0, 5),
        {
          t: 1490,
          k: "db.diff",
          offsetMs: 490,
          sessionId: SESSION_ID,
          d: {
            engine: "postgres",
            op: "update",
            table: "orders",
            pk: { id: 1 },
            after: { id: 1, status: "paid", password: "hunter2-very-secret" },
            requestId: "req-1",
          },
        },
        ...EVENTS.slice(5),
      ];
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        dbEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(dir);

      const fc = await buildFixContext(dir);
      expect(fc.primary_window.db_diffs.length).toBeGreaterThan(0);
      const diff = fc.primary_window.db_diffs[0];
      expect(diff.op).toBe("update");
      expect(diff.table).toBe("orders");
      expect(diff.requestId).toBe("req-1");
      expect(diff.after!.status).toBe("paid");
      expect(diff.after!.password).toBe("[REDACTED]");
      expect(JSON.stringify(fc.primary_window.db_diffs)).not.toContain(
        "hunter2-very-secret",
      );
    } finally {
      fs.rmSync(dbTmp, { recursive: true, force: true });
    }
  });

  it("surfaces db_diffs for a 200-only session (standalone db.diff, no error present)", async () => {
    const dbTmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-fc-db200-"),
    );
    try {
      const dbSessionId = "ses_fc_db200";
      const dir = path.join(dbTmp, dbSessionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ id: dbSessionId, app: "shop", start: 1000 }),
      );
      // A successful checkout (HTTP 200) that nonetheless writes a wrong total_cents — the exact
      // data-correctness bug that is captured but was never surfaced before this checkpoint.
      const dbEvents = [
        {
          t: 1000,
          k: "session.lifecycle",
          offsetMs: 0,
          d: { action: "start", reason: "user" },
        },
        {
          t: 1150,
          k: "net.req",
          offsetMs: 150,
          d: {
            id: "r1",
            requestId: "req-1",
            sessionId: dbSessionId,
            m: "POST",
            url: "https://app.test/api/checkout",
          },
        },
        {
          t: 1160,
          k: "backend.req.start",
          offsetMs: 160,
          sessionId: dbSessionId,
          d: {
            requestId: "req-1",
            sessionId: dbSessionId,
            method: "POST",
            route: "/api/checkout",
          },
        },
        {
          t: 1490,
          k: "db.diff",
          offsetMs: 490,
          sessionId: dbSessionId,
          d: {
            engine: "postgres",
            op: "insert",
            table: "orders",
            pk: { id: 1 },
            after: { id: 1, total_cents: 1 },
            requestId: "req-1",
          },
        },
        {
          t: 1500,
          k: "backend.req.end",
          offsetMs: 500,
          sessionId: dbSessionId,
          d: {
            requestId: "req-1",
            sessionId: dbSessionId,
            statusCode: 200,
            durationMs: 340,
          },
        },
        {
          t: 1520,
          k: "net.res",
          offsetMs: 520,
          d: {
            id: "r1",
            requestId: "req-1",
            sessionId: dbSessionId,
            st: 200,
            dur: 370,
          },
        },
        {
          t: 1600,
          k: "session.lifecycle",
          offsetMs: 600,
          d: { action: "stop", reason: "user" },
        },
      ];
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        dbEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(dir);

      const fc = await buildFixContext(dir);
      // The standalone db_mutation is the only signal, and its window covers the diff.
      expect(fc.signals[0].detector).toBe("db_mutation");
      expect(fc.primary_window.db_diffs.length).toBeGreaterThan(0);
      const diff = fc.primary_window.db_diffs[0];
      expect(diff.op).toBe("insert");
      expect(diff.table).toBe("orders");
      expect(diff.after!.total_cents).toBe(1);
    } finally {
      fs.rmSync(dbTmp, { recursive: true, force: true });
    }
  });

  it("surfaces OTel db_activity statements in the primary window with the row-diff upgrade seam", async () => {
    const dbTmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-fc-otlp-db-"),
    );
    try {
      const dbSessionId = "ses_fc_otlp_db";
      const dir = path.join(dbTmp, dbSessionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ id: dbSessionId, app: "shop", start: 1000 }),
      );
      const dbEvents = [
        {
          t: 1000,
          k: "session.lifecycle",
          offsetMs: 0,
          d: { action: "start", reason: "user" },
        },
        {
          t: 1490,
          k: "backend.otel.span",
          offsetMs: 490,
          sessionId: dbSessionId,
          d: {
            traceId: "trace-db",
            requestId: "trace-db",
            spanId: "db1",
            name: "SELECT orders",
            serviceName: "api",
            statusCode: "OK",
            attributes: {
              "db.system": "postgresql",
              "db.operation": "SELECT",
              "db.statement": "select * from orders where id = $1",
            },
          },
        },
        {
          t: 1500,
          k: "backend.otel.span",
          offsetMs: 500,
          sessionId: dbSessionId,
          d: {
            traceId: "trace-db",
            requestId: "trace-db",
            spanId: "err1",
            name: "GET /orders",
            serviceName: "api",
            statusCode: "ERROR",
            statusMessage: "boom",
            attributes: { "http.response.status_code": 500 },
          },
        },
        {
          t: 1600,
          k: "session.lifecycle",
          offsetMs: 600,
          d: { action: "stop", reason: "user" },
        },
      ];
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        dbEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(dir);

      const fc = await buildFixContext(dir);
      expect(
        fc.signals.some(
          (candidate) => candidate.detector === "otel_db_activity",
        ),
      ).toBe(true);
      expect(fc.primary_window.db_activity).toHaveLength(1);
      expect(fc.primary_window.db_activity[0].statement).toContain(
        "select * from orders",
      );
      expect(fc.primary_window.db_activity[0].upgradeHint).toContain(
        "row diffs unavailable",
      );
      expect(fc.primary_window.db_diffs).toEqual([]);
    } finally {
      fs.rmSync(dbTmp, { recursive: true, force: true });
    }
  });

  it("surfaces pre-state db_reads for a state-dependent two-rows-ranked-3 bug", async () => {
    const dbTmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-fc-dbreads-"),
    );
    try {
      const dbSessionId = "ses_fc_dbreads";
      const dir = path.join(dbTmp, dbSessionId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ id: dbSessionId, app: "billing-worker", start: 1000 }),
      );
      const dbEvents = [
        {
          t: 1000,
          k: "session.lifecycle",
          offsetMs: 0,
          d: { action: "start", reason: "headless" },
        },
        {
          t: 1100,
          k: "backend.req.start",
          offsetMs: 100,
          sessionId: dbSessionId,
          d: {
            requestId: "req-rank",
            sessionId: dbSessionId,
            method: "POST",
            route: "/jobs/rank-invoices",
          },
        },
        {
          t: 1210,
          k: "db.read",
          offsetMs: 210,
          sessionId: dbSessionId,
          d: {
            engine: "postgres",
            table: "invoice_rankings",
            pk: { id: 101 },
            row: {
              id: 101,
              invoice_id: 123,
              rank: 3,
              tenant_id: "acme",
              token: "tok_secret_value_should_vanish",
            },
            requestId: "req-rank",
          },
        },
        {
          t: 1220,
          k: "db.read",
          offsetMs: 220,
          sessionId: dbSessionId,
          d: {
            engine: "postgres",
            table: "invoice_rankings",
            pk: { id: 102 },
            row: { id: 102, invoice_id: 456, rank: 3, tenant_id: "acme" },
            requestId: "req-rank",
          },
        },
        {
          t: 1300,
          k: "db.diff",
          offsetMs: 300,
          sessionId: dbSessionId,
          d: {
            engine: "postgres",
            op: "update",
            table: "invoice_rankings",
            pk: { id: 456 },
            before: { id: 456, invoice_id: 456, selected: false },
            after: { id: 456, invoice_id: 456, selected: true },
            requestId: "req-rank",
          },
        },
        {
          t: 1500,
          k: "backend.req.end",
          offsetMs: 500,
          sessionId: dbSessionId,
          d: {
            requestId: "req-rank",
            sessionId: dbSessionId,
            statusCode: 200,
            durationMs: 400,
          },
        },
        {
          t: 1600,
          k: "session.lifecycle",
          offsetMs: 600,
          d: { action: "stop", reason: "headless" },
        },
      ];
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        dbEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(dir);

      const fc = await buildFixContext(dir);
      expect(fc.signals[0].detector).toBe("db_mutation");
      expect(fc.primary_window.db_diffs).toHaveLength(1);
      expect(fc.primary_window.db_reads).toHaveLength(2);
      expect(fc.primary_window.db_reads.map((read) => read.row.rank)).toEqual([
        3, 3,
      ]);
      expect(
        fc.primary_window.db_reads.map((read) => read.row.invoice_id),
      ).toEqual([123, 456]);
      expect(JSON.stringify(fc.primary_window.db_reads)).not.toContain(
        "tok_secret_value_should_vanish",
      );
      expect(fc.primary_window.db_reads[0].row.token).toBe("[REDACTED]");
    } finally {
      fs.rmSync(dbTmp, { recursive: true, force: true });
    }
  });

  it("ranks the backend root above its net.res symptom (causal re-rank)", async () => {
    const fc = await buildFixContext(sessionDir);
    expect(fc.signals.length).toBeGreaterThan(0);
    // The backend error is the root cause of the correlated 500 response; the causal re-rank makes
    // it ranked[0] and demotes the frontend-observed http_error to a symptom below it. (Before CP3
    // the higher-scored http_error sat at ranked[0], burying the actual backend root.)
    const top = fc.signals[0];
    expect(top.detector).toBe("backend_http_error");
    expect(top.anchor.status).toBe(500);
    expect(top.causalRole).toBe("root");
    const httpError = fc.signals.find((c: any) => c.detector === "http_error");
    expect(httpError).toBeDefined();
    expect(httpError!.causalRole).toBe("symptom");
    expect(httpError!.rootCauseId).toBe(top.id);
    // Emitted scores are never mutated by the ranking boost, so the raw scores are NOT monotonic
    // once a lower-scored root is lifted above a higher-scored symptom.
    expect(top.score).toBe(89);
  });

  it("surfaces a causal_chain projecting root → symptom from signal fields", async () => {
    const fc = await buildFixContext(sessionDir);

    // signals[0] is the backend root; the chain projects that same order without re-sort.
    expect(fc.signals[0].causalRole).toBe("root");
    expect(fc.causal_chain).not.toBeNull();
    const chain = fc.causal_chain!;
    expect(chain.root.detector).toBe("backend_http_error");
    expect(chain.root.id).toBe(fc.signals[0].id);

    const httpSymptom = chain.symptoms.find((s) => s.detector === "http_error");
    expect(httpSymptom).toBeDefined();
    expect(httpSymptom!.attributionConfidence).toBeDefined();

    // The chain's root/symptom ids are consistent with the candidate causal fields (no recompute).
    const httpError = fc.signals.find((c: any) => c.detector === "http_error");
    expect(httpError!.rootCauseId).toBe(chain.root.id);
    expect(chain.symptoms.map((s) => s.id)).toEqual(fc.signals[0].causes);
  });

  it("leaves causal_chain null when the primary candidate is isolated / has no causes", async () => {
    const isoTmp = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-fc-iso-"));
    try {
      const id = "ses_fc_iso";
      const dir = path.join(isoTmp, id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ id, app: "shop", start: 1000 }),
      );
      // A single standalone console error: no correlated request spine, so it stays isolated with
      // no attributed symptoms.
      const isoEvents = [
        {
          t: 1000,
          k: "session.lifecycle",
          offsetMs: 0,
          d: { action: "start", reason: "user" },
        },
        {
          t: 1200,
          k: "con",
          offsetMs: 200,
          d: { lv: "error", msg: "Something went wrong in the widget" },
        },
        {
          t: 1600,
          k: "session.lifecycle",
          offsetMs: 600,
          d: { action: "stop", reason: "user" },
        },
      ];
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        isoEvents.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(dir);

      const fc = await buildFixContext(dir);
      expect(fc.signals.length).toBeGreaterThan(0);
      // The single console error attributes no downstream symptoms (no `causes`), so even if it is
      // labeled a root it yields NO chain — causal_chain must be null.
      expect(fc.signals[0].causes ?? []).toEqual([]);
      expect(fc.causal_chain).toBeNull();
    } finally {
      fs.rmSync(isoTmp, { recursive: true, force: true });
    }
  });

  it("keeps signals root-first and context defaults intact", async () => {
    const fc = await buildFixContext(sessionDir);
    // Root-first order: the backend root precedes its http_error symptom in file order.
    const rootIdx = fc.signals.findIndex(
      (c) => c.detector === "backend_http_error",
    );
    const symptomIdx = fc.signals.findIndex((c) => c.detector === "http_error");
    expect(rootIdx).toBeGreaterThanOrEqual(0);
    expect(symptomIdx).toBeGreaterThan(rootIdx);
    expect(fc.schemaVersion).toBe("fix-context.v2");
    expect(fc.primary_window.db_diffs).toEqual([]);
    expect(fc.primary_window.db_reads).toEqual([]);
    expect(fc.environment).toBeNull();
    expect(fc.repro_hint).not.toBeNull();
  });

  it("derives the primary window from the top candidate plus linked full-stack evidence", async () => {
    const fc = await buildFixContext(sessionDir);
    const window = fc.primary_window.frontend.window;
    expect(window).not.toBeNull();
    expect(window!.start).toBeLessThanOrEqual(1520);
    expect(window!.end).toBeGreaterThanOrEqual(1520);
    expect(fc.primary_window.frontend.requests.length).toBeGreaterThan(0);
    expect(fc.primary_window.backend.requests.length).toBeGreaterThan(0);
    expect(fc.primary_window.backend.requests[0].statusCode).toBe(500);
  });

  it("derives a repro_hint from the top candidate", async () => {
    const fc = await buildFixContext(sessionDir);
    expect(fc.repro_hint).not.toBeNull();
    expect(fc.repro_hint!.detector).toBe("backend_http_error");
    expect(fc.repro_hint!.title).toContain("500");
  });

  it("carries target descriptors from signals into fix-context hints", async () => {
    const dir = path.join(tmpDir, "ses_fc_target");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify({
        id: "ses_fc_target",
        start: 1000,
        end: 2000,
        dur: 1000,
      }),
    );
    fs.writeFileSync(
      path.join(dir, "candidates.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "cand_0001",
        detector: "repeated_clicks",
        title: "Repeated clicks on Submit order",
        severity: "medium",
        score: 60,
        confidence: "high",
        anchor: {
          t: 1200,
          offsetMs: 200,
          elementLabel: "Submit order",
          target: {
            role: "button",
            label: "Submit order",
            testID: "submit-order",
            accessibilityId: "checkout.submit",
            componentName: "Pressable",
            routePath: "/checkout",
            ancestryHash: "rn:checkout:footer:primary",
          },
        },
        evidenceWindow: { start: 1000, end: 1600, windowId: "win_0001" },
      })}\n`,
    );

    const fc = await buildFixContext(dir);

    expect(fc.primary_window.frontend.anchor?.target).toMatchObject({
      role: "button",
      testID: "submit-order",
      accessibilityId: "checkout.submit",
    });
    expect(fc.repro_hint?.target).toMatchObject({
      routePath: "/checkout",
      componentName: "Pressable",
    });
  });

  it("carries planned target descriptors from raw events into fix-context output", async () => {
    const dir = path.join(tmpDir, "ses_fc_planned_target");
    const target = {
      role: "button",
      label: "Submit order",
      testID: "submit-order",
      accessibilityId: "checkout.submit",
      componentName: "Pressable",
      routePath: "/checkout",
      ancestryHash: "rn:checkout:footer:primary",
    };
    const events = [
      {
        t: 1000,
        k: "session.lifecycle",
        offsetMs: 0,
        d: { action: "start", reason: "user" },
      },
      {
        t: 1010,
        k: "navigation",
        offsetMs: 10,
        platform: "react-native",
        d: { to: "/checkout" },
      },
      {
        t: 1100,
        k: "clk",
        offsetMs: 100,
        platform: "react-native",
        target,
        d: { target },
      },
      {
        t: 1600,
        k: "clk",
        offsetMs: 600,
        platform: "react-native",
        target,
        d: { target },
      },
      {
        t: 2100,
        k: "clk",
        offsetMs: 1100,
        platform: "react-native",
        target,
        d: { target },
      },
      {
        t: 2600,
        k: "session.lifecycle",
        offsetMs: 1600,
        d: { action: "stop", reason: "user" },
      },
    ];
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: "ses_fc_planned_target", app: "shop", start: 1000 }),
    );
    fs.writeFileSync(
      path.join(dir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    await postProcess(dir);

    const fc = await buildFixContext(dir);

    expect(fc.signals[0].anchor.target).toMatchObject({
      testID: "submit-order",
      routePath: "/checkout",
    });
    expect(fc.primary_window.frontend.anchor?.target).toMatchObject({
      accessibilityId: "checkout.submit",
      componentName: "Pressable",
    });
    expect(fc.repro_hint?.target).toMatchObject({
      label: "Submit order",
      ancestryHash: "rn:checkout:footer:primary",
    });
  });

  it("resolves a bare session id against outputDir", async () => {
    const fc = await buildFixContext(SESSION_ID, { outputDir: tmpDir });
    expect(fc.session.id).toBe(SESSION_ID);
  });

  it("resolves a bare session id living in the finalized partition layout", async () => {
    const partTmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-fc-part-"),
    );
    try {
      const id = "ses_partitioned";
      // Finalized sessions live under {tenant}/{app}/{YYYY-MM-DD}/{id}, not flat.
      const dir = path.join(partTmp, "acme", "shop", "2026-06-30", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ id, app: "shop", start: 1000 }),
      );
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(dir);

      const fc = await buildFixContext(id, { outputDir: partTmp });
      expect(fc.session.id).toBe(id);
    } finally {
      fs.rmSync(partTmp, { recursive: true, force: true });
    }
  });

  it("throws FixContextError for a missing session", async () => {
    await expect(
      buildFixContext("does-not-exist", { outputDir: tmpDir }),
    ).rejects.toThrowError(FixContextError);
  });
});

describe("runFixContext (CLI)", () => {
  let tmpDir: string;
  let sessionDir: string;
  let writes: string[];
  let writeSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-fc-cli-"));
    sessionDir = await seedSession(tmpDir);
    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: any) => {
        writes.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits the raw contract with --json", async () => {
    const code = await runFixContext([sessionDir, "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.schemaVersion).toBe("fix-context.v2");
    expect(parsed.signals.length).toBeGreaterThan(0);
  });

  it("emits a human-readable summary by default", async () => {
    const code = await runFixContext([sessionDir]);
    expect(code).toBe(0);
    const out = writes.join("");
    expect(out).toContain("crumbtrail-server fix-context");
    expect(out).toContain(SESSION_ID);
    expect(out).toContain("fix-context.v2");
  });

  it("resolves a bare session id against --output", async () => {
    const code = await runFixContext([
      SESSION_ID,
      "--output",
      tmpDir,
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.session.id).toBe(SESSION_ID);
  });

  it("resolves a bare session id living in the finalized partition layout", async () => {
    const partTmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-fc-cli-part-"),
    );
    try {
      const id = "ses_part_fc_cli";
      const dir = path.join(partTmp, "local", "shop", "2026-06-30", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ id, app: "shop", start: 1000 }),
      );
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(dir);

      const code = await runFixContext([id, "--output", partTmp, "--json"]);
      expect(code).toBe(0);
      expect(JSON.parse(writes.join("")).session.id).toBe(id);
    } finally {
      fs.rmSync(partTmp, { recursive: true, force: true });
    }
  });
});

// CP4: --latest resolves through the SAME shared resolveLatestIssue the MCP
// getLatestIssue tool uses; --follow polls the public buildFixContext (whose
// index.json requirement is the finalize signal) with injectable interval/
// timeout so these tests never sleep for real-world durations.
describe("runFixContext --latest / --follow (CLI)", () => {
  let tmpDir: string;
  let outWrites: string[];
  let errWrites: string[];
  let outSpy: MockInstance<typeof process.stdout.write>;
  let errSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-fc-latest-"));
    outWrites = [];
    errWrites = [];
    outSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: any) => {
        outWrites.push(String(chunk));
        return true;
      });
    errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: any) => {
        errWrites.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    outSpy.mockRestore();
    errSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("--latest resolves the newest qualifying session and emits its contract", async () => {
    await seedSession(tmpDir);
    const code = await runFixContext([
      "--latest",
      "--output",
      tmpDir,
      "--json",
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(outWrites.join(""));
    expect(parsed.schemaVersion).toBe("fix-context.v2");
    expect(parsed.session.id).toBe(SESSION_ID);
  });

  it("--latest exits 1 with guidance when nothing qualifies", async () => {
    const code = await runFixContext(["--latest", "--output", tmpDir]);
    expect(code).toBe(1);
    expect(outWrites.join("")).toBe("");
    expect(errWrites.join("")).toContain(
      "No finalized session with error-class evidence found under",
    );
  });

  it("--follow emits the contract once the session finalizes mid-poll (progress on stderr, context on stdout)", async () => {
    const sessionDir = path.join(tmpDir, "ses_follow");
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "meta.json"),
      JSON.stringify({ id: "ses_follow", app: "shop", start: 1000 }),
    );
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const run = runFixContext([
      "ses_follow",
      "--output",
      tmpDir,
      "--follow",
      "--json",
      "--interval",
      "25",
      "--timeout",
      "5000",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await postProcess(sessionDir); // finalize mid-poll (writes index.json)
    const code = await run;

    expect(code).toBe(0);
    const parsed = JSON.parse(outWrites.join(""));
    expect(parsed.schemaVersion).toBe("fix-context.v2");
    expect(parsed.session.id).toBe("ses_follow");
    const stderr = errWrites.join("");
    expect(stderr).toContain("waiting for ses_follow");
    expect(outWrites.join("")).not.toContain("waiting for");
  });

  it("--follow times out with a non-zero exit naming the target and timeout", async () => {
    const code = await runFixContext(
      ["ghost", "--output", tmpDir, "--follow"],
      { intervalMs: 10, timeoutMs: 80 },
    );
    expect(code).toBe(1);
    expect(outWrites.join("")).toBe("");
    const stderr = errWrites.join("");
    expect(stderr).toContain("timed out after 80ms");
    expect(stderr).toContain("ghost");
  });

  it("--latest --follow polls the resolver until a hit whose fix context builds", async () => {
    const run = runFixContext([
      "--latest",
      "--output",
      tmpDir,
      "--follow",
      "--json",
      "--interval",
      "25",
      "--timeout",
      "5000",
    ]);
    await new Promise((resolve) => setTimeout(resolve, 80));
    await seedSession(tmpDir);
    const code = await run;

    expect(code).toBe(0);
    const parsed = JSON.parse(outWrites.join(""));
    expect(parsed.session.id).toBe(SESSION_ID);
    expect(errWrites.join("")).toContain("waiting for the latest issue");
  });
});

describe("getFixContext (MCP tool)", () => {
  let tmpDir: string;
  let server: McpServer;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-fc-mcp-"));
    await seedSession(tmpDir);
    server = new McpServer({ outputDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("is advertised in tools/list", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    const names = (res!.result as any).tools.map((t: any) => t.name);
    expect(names).toContain("getFixContext");
  });

  it("returns the fix-context contract over JSON-RPC", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "getFixContext", arguments: { sessionId: SESSION_ID } },
    });
    const result = res!.result as any;
    expect(result.isError).toBeUndefined();
    const contract = JSON.parse(result.content[0].text);
    expect(contract.schemaVersion).toBe("fix-context.v2");
    expect(contract.session.id).toBe(SESSION_ID);
    expect(contract.primary_window.db_diffs).toEqual([]);
    expect(contract.primary_window.db_reads).toEqual([]);
    expect(contract.environment).toBeNull();
    expect(contract.signals[0].detector).toBe("backend_http_error");
  });

  it("returns an MCP error for an unknown session", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "getFixContext", arguments: { sessionId: "nope" } },
    });
    const result = res!.result as any;
    expect(result.isError).toBe(true);
  });
});
