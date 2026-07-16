import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCaptureGapEvent,
  canInjectCorrelationHeaders,
  createCrumbtrailRequestHeaders,
  type BugEvent,
  type CaptureGapEventData,
} from "crumbtrail-core";
import {
  buildBackendRequestEndEvent,
  buildBackendRequestStartEvent,
  buildLlmBundle,
  instrumentMssqlPool,
  instrumentMysqlClient,
  instrumentPgClient,
  isHighSeverityEvent,
  postProcess,
  resolveBackendRequestCorrelation,
  resolveDbRequestContext,
  startFastFinalizer,
  type LlmBundle,
  type SessionIndexLike,
} from "crumbtrail-node";
import { executeSerializedBullmqWorker } from "./bullmq-worker-executor";

export type Fidelity = "full" | "partial" | "gapped" | "unsupported";

export interface TopologyDimensions {
  driverOrm:
    | "pg_direct"
    | "pg_pool"
    | "mysql2"
    | "mssql_pool"
    | "prisma_driver_layer"
    | "drizzle_driver_layer"
    | "knex_driver_layer";
  processShape: "synchronous_service" | "bullmq_worker" | "webhook_fanout";
  edge: "direct" | "gateway_traceparent_only" | "cors_cross_origin";
  transactionPattern:
    | "autocommit"
    | "explicit_transaction"
    | "batched_statements"
    | "cte_upsert_corpus";
  captureMode: "sdk_dev_session" | "v3_production_trigger" | "otlp_sessionless";
}

export interface GroundTruth {
  actionId?: string;
  requestId?: string;
  sessionId?: string;
  expectedRowChanges: ExpectedRowChange[];
  causalOrdering: {
    actionBeforeRequestStart: boolean;
    requestStartBeforeDatabaseDiff: boolean;
  };
  requiredGaps?: Array<{
    surface: CaptureGapEventData["surface"];
    reason: CaptureGapEventData["reason"];
  }>;
  notes: string[];
}

export interface ExpectedRowChange {
  op: "insert" | "update" | "delete";
  table: string;
  pk: Record<string, unknown> | null;
  /** `null` means the image must be absent, not merely ignored. */
  before: Record<string, unknown> | null;
  /** `null` means the image must be absent, not merely ignored. */
  after: Record<string, unknown> | null;
}

export interface ScenarioExecution {
  events: BugEvent[];
  bundle: LlmBundle;
  groundTruth: GroundTruth;
}

export interface TopologyCell {
  id: string;
  dimensions: TopologyDimensions;
  expected: Fidelity;
  notes: string[];
  run: () => Promise<ScenarioExecution>;
}

export interface CellResult {
  id: string;
  dimensions: TopologyDimensions;
  expected: Fidelity;
  achieved: Fidelity;
  groundTruth: GroundTruth;
  notes: string[];
  completeness: LlmBundle["completeness"];
  linkedRequests: number;
  databaseDiffs: number;
  gaps: Array<{
    surface?: string;
    reason?: string;
  }>;
}

const SESSION_START = 1_710_000_000_000;
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const SDK_REQUEST_ID = "req_m9z4x9_abcdefghijkl";
const SDK_SESSION_ID = "ses_20260715_123456_abcdef123456";

type DriverRun = (input: {
  requestId: string;
  sessionId?: string;
  emit: (event: BugEvent) => void;
  now: () => number;
}) => Promise<void>;

interface FlowConfig {
  id: string;
  driverRun: DriverRun;
  rowChanges?: number;
  expectedRowChanges?: ExpectedRowChange[];
  includeBrowser?: boolean;
  browserRequestId?: string;
  serverRequestId?: string;
  browserUrl?: string;
  assertCorsHeaders?: boolean;
  sessionId?: string;
  correlation:
    | "headers"
    | "gateway_traceparent"
    | "sessionless_traceparent";
  requiredGaps?: GroundTruth["requiredGaps"];
  extraEvents?: BugEvent[];
  productionTrigger?: boolean;
  notes: string[];
}

const ORDER_ROW: ExpectedRowChange = {
  op: "update",
  table: "orders",
  pk: { id: 101 },
  before: null,
  after: { id: 101, status: "ready" },
};

const ORDER_INSERT_ROW: ExpectedRowChange = {
  op: "insert",
  table: "orders",
  pk: { id: 101 },
  before: null,
  after: { id: 101, status: "ready" },
};

function expectedRows(count = 1, row = ORDER_ROW): ExpectedRowChange[] {
  return Array.from({ length: count }, () => ({
    ...row,
    pk: row.pk ? { ...row.pk } : null,
    before: row.before ? { ...row.before } : null,
    after: row.after ? { ...row.after } : null,
  }));
}

function browserActionEvents(
  id: string,
  sessionId: string,
  requestId: string,
  url = "/api/orders/101",
): BugEvent[] {
  return [
    {
      t: SESSION_START,
      k: "clk",
      d: { id: `action_${id}`, text: "Save order" },
      sessionId,
      offsetMs: 0,
    },
    {
      t: SESSION_START + 1,
      k: "net.req",
      d: {
        id: `network_${id}`,
        method: "POST",
        url,
        requestId,
        sessionId,
      },
      sessionId,
      offsetMs: 1,
    },
  ];
}

function browserResponseEvent(id: string, sessionId: string, requestId: string): BugEvent {
  return {
    t: SESSION_START + 90,
    k: "net.res",
    d: {
      id: `network_${id}`,
      st: 200,
      dur: 89,
      requestId,
      sessionId,
    },
    sessionId,
    offsetMs: 90,
  };
}

function headersFor(
  correlation: FlowConfig["correlation"],
  sessionId: string | undefined,
  requestId: string,
): Record<string, string> {
  if (correlation === "headers") {
    return createCrumbtrailRequestHeaders(sessionId ?? "", requestId);
  }

  if (correlation === "gateway_traceparent") {
    return {
      ...createCrumbtrailRequestHeaders(sessionId ?? "", requestId),
      traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01`,
    };
  }

  return {
    traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01`,
  };
}

/** Shared deterministic bundle primitive used by topology and benchmark reproductions. */
export async function buildTopologyBundle(events: BugEvent[]): Promise<LlmBundle> {
  const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-topology-"));
  try {
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
    await postProcess(sessionDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "index.json"), "utf8"),
    ) as SessionIndexLike;
    return buildLlmBundle({ sessionDir, events, index });
  } finally {
    fs.rmSync(sessionDir, { recursive: true, force: true });
  }
}

async function runCapturedFlow(config: FlowConfig): Promise<ScenarioExecution> {
  const events: BugEvent[] = [];
  const includeBrowser = config.includeBrowser ?? true;
  const sessionId =
    config.correlation === "sessionless_traceparent"
      ? undefined
      : (config.sessionId ?? SDK_SESSION_ID);
  const inputRequestId =
    config.correlation === "headers"
      ? (config.serverRequestId ?? SDK_REQUEST_ID)
      : TRACE_ID;
  const browserRequestId = config.browserRequestId ?? inputRequestId;
  const preEdgeHeaders = headersFor(config.correlation, sessionId, inputRequestId);
  const headers =
    config.correlation === "gateway_traceparent"
      ? Object.fromEntries(
          Object.entries(preEdgeHeaders).filter(
            ([name]) => !name.toLowerCase().startsWith("x-crumbtrail-"),
          ),
        )
      : preEdgeHeaders;

  if (config.correlation === "gateway_traceparent") {
    if (
      !preEdgeHeaders["X-Crumbtrail-Session-Id"] ||
      !preEdgeHeaders["X-Crumbtrail-Request-Id"] ||
      headers["X-Crumbtrail-Session-Id"] ||
      headers["X-Crumbtrail-Request-Id"]
    ) {
      throw new Error("Gateway edge did not remove the custom correlation headers.");
    }
  }

  if (includeBrowser && sessionId) {
    events.push(
      ...browserActionEvents(
        config.id,
        sessionId,
        browserRequestId,
        config.browserUrl,
      ),
    );
  }
  if (config.assertCorsHeaders) {
    const corsUrl = config.browserUrl ?? "https://api.example.test/api/orders/101";
    if (!canInjectCorrelationHeaders(corsUrl, ["https://api.example.test"])) {
      throw new Error("Configured CORS origin did not allow correlation headers.");
    }
  }
  if (config.extraEvents) events.push(...config.extraEvents);

  const requestInput = {
    now: SESSION_START + 2,
    sessionStartedAt: SESSION_START,
    sessionId,
    method: "POST",
    url: "/api/orders/101",
    route: "/api/orders/:id",
    headers,
  };
  const requestStart = buildBackendRequestStartEvent({
    ...requestInput,
    emit: (event) => events.push(event),
  });
  events.push(requestStart);
  if (config.correlation === "gateway_traceparent") {
    const correlation = resolveBackendRequestCorrelation(requestInput);
    if (correlation.requestId !== TRACE_ID || correlation.requestIdSource !== "traceparent") {
      throw new Error("Gateway request did not resolve correlation from traceparent.");
    }
  }
  if (config.productionTrigger) {
    const triggerEvent: BugEvent = {
      t: SESSION_START + 3,
      k: "backend.req.end",
      d: { requestId: inputRequestId, statusCode: 500 },
      ...(sessionId ? { sessionId } : {}),
    };
    if (!isHighSeverityEvent(triggerEvent)) {
      throw new Error("The production fast finalize trigger rejected a severe request event.");
    }
    const finalizer = startFastFinalizer({
      // The harness deliberately has no live server or persisted session. This
      // narrow session manager seam drives the production trigger through its
      // skipped finalization path after it classifies the severe ingest event.
      sessions: {
        getExistingSessionDir: () => undefined,
      } as never,
      debounceMs: 0,
      cooldownMs: 0,
    });
    finalizer.notifyIngest(sessionId ?? SDK_SESSION_ID, [triggerEvent]);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    finalizer.stop();
  }
  const dbContext = resolveDbRequestContext(requestInput);
  let nextDbTimestamp = SESSION_START + 10;
  await config.driverRun({
    ...dbContext,
    emit: (event) => events.push(event),
    now: () => nextDbTimestamp++,
  });
  events.push(
    buildBackendRequestEndEvent({
      ...requestInput,
      statusCode: 200,
      durationMs: 40,
      now: SESSION_START + 50,
    }),
  );
  if (includeBrowser && sessionId) {
    events.push(browserResponseEvent(config.id, sessionId, browserRequestId));
  }

  const bundle = await buildTopologyBundle(events);
  return {
    events,
    bundle,
    groundTruth: {
      ...(includeBrowser ? { actionId: `action_${config.id}` } : {}),
      requestId: includeBrowser ? browserRequestId : dbContext.requestId,
      sessionId,
      expectedRowChanges:
        config.expectedRowChanges ?? expectedRows(config.rowChanges ?? 1),
      causalOrdering: {
        actionBeforeRequestStart: true,
        requestStartBeforeDatabaseDiff: true,
      },
      ...(config.requiredGaps ? { requiredGaps: config.requiredGaps } : {}),
      notes: config.notes,
    },
  };
}

function pgDriver(queries: string[] = ["UPDATE orders SET status = $1 WHERE id = $2"]): DriverRun {
  return async ({ requestId, sessionId, emit, now }) => {
    const rawClient = {
      async query(_text: unknown, _params?: unknown) {
        return { rows: [{ id: 101, status: "ready" }], rowCount: 1 };
      },
    };
    const client = instrumentPgClient(rawClient, {
      requestId,
      sessionId,
      emit,
      now,
    });
    for (const query of queries) await client.query(query, ["ready", 101]);
  };
}

function pgPoolDriver(
  queries: string[] = ["UPDATE orders SET status = $1 WHERE id = $2"],
): DriverRun {
  return async ({ requestId, sessionId, emit, now }) => {
    const acquired = {
      async query(_text: unknown, _params?: unknown) {
        return { rows: [{ id: 101, status: "ready" }], rowCount: 1 };
      },
      release() {
        return undefined;
      },
    };
    const pool = {
      query: acquired.query,
      async connect() {
        return acquired;
      },
    };
    const instrumented = instrumentPgClient(pool, {
      requestId,
      sessionId,
      emit,
      now,
    });
    const client = await instrumented.connect();
    for (const query of queries) await client.query(query, ["ready", 101]);
    client.release();
  };
}

function prismaDriverLayer(): DriverRun {
  // The deterministic harness receives the SQL Prisma would emit at the pg
  // driver boundary. It does not claim to start a live Prisma client.
  return pgDriver(["UPDATE orders SET status = $1 WHERE id = $2"]);
}

function mysqlDriver(count = 1): DriverRun {
  return async ({ requestId, sessionId, emit, now }) => {
    const rawClient = {
      async query(sql: unknown, _values?: unknown) {
        if (/^select/i.test(String(sql))) {
          return [[{ id: 101, status: "ready" }], []];
        }
        return [{ affectedRows: 1, insertId: 101 }, undefined];
      },
    };
    const client = instrumentMysqlClient(rawClient, {
      requestId,
      sessionId,
      emit,
      now,
    });
    for (let index = 0; index < count; index += 1) {
      await client.query("INSERT INTO orders (id, status) VALUES (?, ?)", [
        101 + index,
        "ready",
      ]);
    }
  };
}

function mssqlDriver(): DriverRun {
  return async ({ requestId, sessionId, emit, now }) => {
    const pool = {
      request() {
        const request = {
          input(_name: string, ..._value: unknown[]) {
            return request;
          },
          async query(_text: unknown) {
            return {
              recordset: [{ id: 101, status: "ready" }],
              rowsAffected: [1],
            };
          },
        };
        return request;
      },
    };
    const instrumented = instrumentMssqlPool(pool, {
      requestId,
      sessionId,
      emit,
      now,
    });
    const request = instrumented.request();
    request.input("status", "ready");
    request.input("id", 101);
    await request.query("UPDATE orders SET status = @status WHERE id = @id");
  };
}

/**
 * Crosses a serialized queue payload into a fresh worker scope. The worker only
 * receives the payload string, recreates request context with the public SDK
 * resolver, and then emits its database diff through the regular driver path.
 */
async function runBullmqWorkerFlow(missingContext = false): Promise<ScenarioExecution> {
  const id = missingContext
    ? "bullmq_worker_missing_context"
    : "bullmq_worker_enterprise_core";
  const sessionId = SDK_SESSION_ID;
  const requestId = "req_bullmq_abcdefghijkl";
  const requestEvents = browserActionEvents(id, sessionId, requestId);
  const requestInput = {
    now: SESSION_START + 2,
    sessionStartedAt: SESSION_START,
    sessionId,
    method: "POST",
    url: "/api/orders/101",
    route: "/api/orders/:id",
    headers: createCrumbtrailRequestHeaders(sessionId, requestId),
  };
  requestEvents.push(buildBackendRequestStartEvent(requestInput));

  const payload = JSON.stringify({
    traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01`,
    ...(missingContext ? {} : { correlation: { requestId, sessionId } }),
  });
  requestEvents.push({
    t: SESSION_START + 3,
    k: "queue.job",
    d: { queue: "order_projection", payload },
    sessionId,
    offsetMs: 3,
  });
  const serializedWorkerEventStream = await executeSerializedBullmqWorker(payload);
  const workerEvents = JSON.parse(serializedWorkerEventStream) as BugEvent[];
  requestEvents.push(
    buildBackendRequestEndEvent({
      ...requestInput,
      statusCode: 200,
      durationMs: 50,
      now: SESSION_START + 50,
    }),
    browserResponseEvent(id, sessionId, requestId),
  );
  // The event streams are independently created and serialized on the worker
  // side. Merging happens only after the worker has completed its handoff.
  const events = [...requestEvents, ...workerEvents].sort((left, right) => left.t - right.t);
  const bundle = await buildTopologyBundle(events);
  return {
    events,
    bundle,
    groundTruth: {
      actionId: `action_${id}`,
      requestId,
      sessionId,
      expectedRowChanges: expectedRows(),
      causalOrdering: {
        actionBeforeRequestStart: true,
        requestStartBeforeDatabaseDiff: true,
      },
      ...(missingContext
        ? { requiredGaps: [{ surface: "queue", reason: "missing_session_id" }] }
        : {}),
      notes: missingContext
        ? ["A dropped worker context emits a queue capture gap and cannot complete the original join."]
        : ["A serialized worker payload is deserialized in a fresh worker scope before it writes."],
    },
  };
}

function fullCell(
  id: string,
  dimensions: TopologyDimensions,
  notes: string[],
  flow: Omit<FlowConfig, "id" | "notes">,
): TopologyCell {
  return {
    id,
    dimensions,
    expected: "full",
    notes,
    run: () => runCapturedFlow({ ...flow, id, notes }),
  };
}

function gappedCell(
  id: string,
  dimensions: TopologyDimensions,
  notes: string[],
  flow: Omit<FlowConfig, "id" | "notes" | "requiredGaps">,
  requiredGaps: NonNullable<GroundTruth["requiredGaps"]>,
): TopologyCell {
  return {
    id,
    dimensions,
    expected: "gapped",
    notes,
    run: () => runCapturedFlow({ ...flow, id, notes, requiredGaps }),
  };
}

const common = {
  processShape: "synchronous_service",
  edge: "direct",
  transactionPattern: "autocommit",
  captureMode: "sdk_dev_session",
} as const;

export const topologyCells: TopologyCell[] = [
  fullCell(
    "pg_direct_sdk_autocommit",
    { ...common, driverOrm: "pg_direct" },
    ["Direct PostgreSQL capture joins the action, request, and changed row."],
    { correlation: "headers", driverRun: pgDriver() },
  ),
  fullCell(
    "pg_pool_connect_enterprise_core",
    {
      ...common,
      driverOrm: "pg_pool",
      transactionPattern: "explicit_transaction",
    },
    ["An acquired PostgreSQL pool client keeps the request correlation."],
    {
      correlation: "headers",
      driverRun: pgPoolDriver([
        "BEGIN",
        "UPDATE orders SET status = $1 WHERE id = $2",
        "COMMIT",
      ]),
    },
  ),
  fullCell(
    "mysql2_autocommit",
    {
      ...common,
      driverOrm: "mysql2",
    },
    ["The mysql2 driver adapter records the changed order row."],
    {
      correlation: "headers",
      driverRun: mysqlDriver(),
      expectedRowChanges: expectedRows(1, ORDER_INSERT_ROW),
    },
  ),
  fullCell(
    "mssql_pool_autocommit",
    { ...common, driverOrm: "mssql_pool" },
    ["The MSSQL pool adapter records output rows through its request object."],
    { correlation: "headers", driverRun: mssqlDriver() },
  ),
  gappedCell(
    "batched_statement_capture_gap",
    {
      ...common,
      driverOrm: "pg_direct",
      transactionPattern: "batched_statements",
    },
    ["A statement batch that cannot be classified records a database capture gap."],
    {
      correlation: "headers",
      driverRun: pgDriver([
        "INSERT INTO orders (id, status) VALUES ($1, $2); SELECT * FROM orders",
      ]),
    },
    [{ surface: "db_diff", reason: "unparsed_sql" }],
  ),
  fullCell(
    "prisma_driver_layer_enterprise_core",
    { ...common, driverOrm: "prisma_driver_layer" },
    ["Prisma coverage uses emitted SQL through the PostgreSQL driver layer, not a live ORM integration."],
    {
      correlation: "headers",
      driverRun: prismaDriverLayer(),
    },
  ),
  fullCell(
    "drizzle_driver_layer",
    { ...common, driverOrm: "drizzle_driver_layer" },
    ["Drizzle coverage uses emitted SQL through the PostgreSQL driver layer, not a live ORM integration."],
    {
      correlation: "headers",
      driverRun: pgDriver(["UPDATE orders SET status = $1 WHERE orders.id = $2"]),
    },
  ),
  fullCell(
    "knex_driver_layer",
    { ...common, driverOrm: "knex_driver_layer" },
    ["Knex coverage uses emitted SQL through the PostgreSQL driver layer, not a live ORM integration."],
    {
      correlation: "headers",
      driverRun: pgDriver(["UPDATE orders SET status = $1 WHERE id = $2"]),
    },
  ),
  {
    id: "bullmq_worker_enterprise_core",
    dimensions: { ...common, driverOrm: "pg_pool", processShape: "bullmq_worker" },
    expected: "full",
    notes: ["A worker module accepts only the serialized queue payload, creates an independent event stream, and returns it for the harness to merge after execution."],
    run: () => runBullmqWorkerFlow(false),
  },
  {
    id: "bullmq_worker_missing_context",
    dimensions: { ...common, driverOrm: "pg_direct", processShape: "bullmq_worker" },
    expected: "gapped",
    notes: ["A missing worker context emits the required queue capture gap instead of joining the original request."],
    run: () => runBullmqWorkerFlow(true),
  },
  fullCell(
    "webhook_fanout",
    { ...common, driverOrm: "pg_direct", processShape: "webhook_fanout" },
    ["The fan out handler preserves the originating request correlation."],
    {
      correlation: "headers",
      driverRun: pgDriver(),
      extraEvents: [
        {
          t: SESSION_START + 2,
          k: "webhook.fanout",
          d: { target: "order_projection" },
        },
      ],
    },
  ),
  fullCell(
    "gateway_traceparent_only_enterprise_core",
    {
      ...common,
      driverOrm: "pg_direct",
      edge: "gateway_traceparent_only",
    },
    ["The gateway strips custom correlation headers after receipt while traceparent resolves the backend request join."],
    { correlation: "gateway_traceparent", driverRun: pgDriver() },
  ),
  fullCell(
    "cors_cross_origin",
    { ...common, driverOrm: "pg_direct", edge: "cors_cross_origin" },
    ["An allowed cross origin request keeps its correlation headers."],
    {
      correlation: "headers",
      browserUrl: "https://api.example.test/api/orders/101",
      assertCorsHeaders: true,
      driverRun: pgDriver(),
    },
  ),
  fullCell(
    "explicit_transaction",
    {
      ...common,
      driverOrm: "pg_direct",
      transactionPattern: "explicit_transaction",
    },
    ["Only the mutation in the transaction produces the row change evidence."],
    {
      correlation: "headers",
      driverRun: pgDriver([
        "BEGIN",
        "UPDATE orders SET status = $1 WHERE id = $2",
        "COMMIT",
      ]),
    },
  ),
  fullCell(
    "cte_upsert_corpus",
    {
      ...common,
      driverOrm: "pg_direct",
      transactionPattern: "cte_upsert_corpus",
    },
    ["Classified CTE and upsert statements produce request keyed row diffs."],
    {
      correlation: "headers",
      rowChanges: 2,
      expectedRowChanges: [ORDER_ROW, ORDER_INSERT_ROW],
      driverRun: pgDriver([
        "WITH active AS (SELECT id FROM orders) UPDATE orders SET status = $1 WHERE id IN (SELECT id FROM active)",
        "INSERT INTO orders (id, status) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status",
      ]),
    },
  ),
  fullCell(
    "v3_production_trigger_enterprise_core",
    {
      ...common,
      driverOrm: "pg_direct",
      captureMode: "v3_production_trigger",
    },
    ["The real production fast finalize trigger processes a severe event; finalization is modeled as skipped because this deterministic harness has no session store."],
    {
      correlation: "headers",
      driverRun: pgDriver(),
      productionTrigger: true,
    },
  ),
  gappedCell(
    "otlp_sessionless",
    {
      ...common,
      driverOrm: "pg_direct",
      captureMode: "otlp_sessionless",
    },
    ["Sessionless telemetry retains its trace join and records the missing session coverage."],
    {
      correlation: "sessionless_traceparent",
      includeBrowser: false,
      driverRun: pgDriver(),
    },
    [{ surface: "backend_request", reason: "header_stripped" }],
  ),
];

function captureGaps(events: BugEvent[]): Array<{ surface?: string; reason?: string }> {
  return events
    .filter((event) => event.k === "capture_gap")
    .map((event) => ({
      surface: typeof event.d.surface === "string" ? event.d.surface : undefined,
      reason: typeof event.d.reason === "string" ? event.d.reason : undefined,
    }));
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    !left ||
    !right ||
    typeof left !== "object" ||
    typeof right !== "object" ||
    Array.isArray(left) ||
    Array.isArray(right)
  ) {
    return false;
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameJsonValue(leftRecord[key], rightRecord[key]),
    )
  );
}

function matchesExpectedRow(
  diff: LlmBundle["databaseDiffs"][number],
  expected: ExpectedRowChange,
): boolean {
  return (
    diff.op === expected.op &&
    diff.table === expected.table &&
    sameJsonValue(diff.pk, expected.pk) &&
    matchesExpectedImage(diff, "before", expected.before) &&
    matchesExpectedImage(diff, "after", expected.after)
  );
}

function matchesExpectedImage(
  diff: LlmBundle["databaseDiffs"][number],
  key: "before" | "after",
  expected: Record<string, unknown> | null,
): boolean {
  const observedHasImage = Object.prototype.hasOwnProperty.call(diff, key);
  if (expected === null) return !observedHasImage;
  return observedHasImage && sameJsonValue(diff[key], expected);
}

function exactExpectedRows(
  diffs: readonly LlmBundle["databaseDiffs"][number][],
  expectedRows: readonly ExpectedRowChange[],
): boolean {
  if (diffs.length !== expectedRows.length) return false;
  const remaining = [...diffs];
  for (const expected of expectedRows) {
    const index = remaining.findIndex((diff) => matchesExpectedRow(diff, expected));
    if (index < 0) return false;
    remaining.splice(index, 1);
  }
  return remaining.length === 0;
}

export function deriveAchievedFidelity(execution: ScenarioExecution): Fidelity {
  const { bundle, events, groundTruth } = execution;
  const gaps = captureGaps(events);
  const action = groundTruth.actionId
    ? events.find((event) => event.k === "clk" && event.d.id === groundTruth.actionId)
    : undefined;
  const requestStart = groundTruth.requestId
    ? events.find(
        (event) =>
          event.k === "backend.req.start" &&
          event.d.requestId === groundTruth.requestId,
      )
    : undefined;
  const hasAction = action !== undefined;
  const hasLinkedRequest = requestStart !== undefined;
  const matchingRows = groundTruth.requestId
    ? bundle.databaseDiffs.filter((diff) => diff.requestId === groundTruth.requestId)
    : bundle.databaseDiffs;
  const hasExactRows = exactExpectedRows(
    matchingRows,
    groundTruth.expectedRowChanges,
  );
  const hasCausalOrdering =
    action !== undefined &&
    requestStart !== undefined &&
    action.t < requestStart.t &&
    matchingRows.every((diff) => requestStart.t < diff.t);
  const completeJoin =
    hasAction && hasLinkedRequest && hasCausalOrdering && hasExactRows;

  if (groundTruth.requiredGaps && groundTruth.requiredGaps.length > 0) {
    for (const expected of groundTruth.requiredGaps) {
      if (!gaps.some((gap) => gap.surface === expected.surface && gap.reason === expected.reason)) {
        throw new Error(
          `Cell required capture gap ${expected.surface}:${expected.reason}, but it was not emitted.`,
        );
      }
    }
    if (completeJoin) {
      throw new Error(
        "A required capture gap was emitted even though the causal action to request to row join completed.",
      );
    }
    return "gapped";
  }

  if (
    completeJoin &&
    bundle.completeness.grade === "complete"
  ) {
    return "full";
  }

  if (!hasAction || !hasLinkedRequest || !hasExactRows || !hasCausalOrdering) {
    if (gaps.length === 0) {
      throw new Error(
        `Silent topology loss: causal=${hasCausalOrdering} action=${hasAction} request=${hasLinkedRequest} exactRows=${hasExactRows} expected=${JSON.stringify(groundTruth.expectedRowChanges)} observed=${JSON.stringify(matchingRows)}.`,
      );
    }
    return "gapped";
  }

  return gaps.length > 0 ? "gapped" : "partial";
}

export async function runTopologyCell(cell: TopologyCell): Promise<CellResult> {
  const execution = await cell.run();
  const achieved = deriveAchievedFidelity(execution);
  if (achieved !== cell.expected) {
    throw new Error(
      `Cell ${cell.id} expected ${cell.expected} fidelity but achieved ${achieved}.`,
    );
  }
  return {
    id: cell.id,
    dimensions: cell.dimensions,
    expected: cell.expected,
    achieved,
    groundTruth: execution.groundTruth,
    notes: cell.notes,
    completeness: execution.bundle.completeness,
    linkedRequests: execution.bundle.fullStackEvidence.summary.linked,
    databaseDiffs: execution.bundle.databaseDiffs.length,
    gaps: captureGaps(execution.events),
  };
}

export async function runAllTopologyCells(): Promise<CellResult[]> {
  const results: CellResult[] = [];
  for (const cell of topologyCells) results.push(await runTopologyCell(cell));
  return results;
}
