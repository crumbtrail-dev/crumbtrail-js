import {
  buildCaptureGapEvent,
  createCrumbtrailRequestHeaders,
  type BugEvent,
} from "crumbtrail-core";
import {
  buildBackendRequestEndEvent,
  buildBackendRequestErrorEvent,
  buildBackendRequestStartEvent,
  instrumentPgClient,
} from "crumbtrail-node";
import { buildTopologyBundle } from "../topology";

export type BenchmarkBugClass =
  | "request_keyed_row_diff"
  | "cross_release_behavior"
  | "race_adjacent_write_skew"
  | "http_failure_family";

type SeededFailureMode = "request" | "release" | "race" | "http";

interface BenchmarkBugDefinition {
  id: string;
  harnessApp: string;
  bugClass: BenchmarkBugClass;
  seededReproduction: string;
  fixtureCode: string;
  mode: SeededFailureMode;
  statusCode?: number;
}

export interface BenchmarkBug {
  id: string;
  harnessApp: string;
  bugClass: BenchmarkBugClass;
  seededReproduction: string;
  reproduce: () => Promise<BenchmarkReproduction>;
}

export interface GenericStackEvidence {
  arm: "generic";
  symptom: string;
  sentry: { issue: string; error: string | null };
  datadog: { requestCount: number; databaseChanges: number; statusCode: number };
  jira: { report: string };
  fixtureCode: string;
}

export interface CrumbtrailEvidence {
  arm: "crumbtrail";
  symptom: string;
  bundle: {
    completenessGrade: string;
    requestIds: string[];
    databaseDiffs: Array<{
      op: string;
      table: string;
      pk: Record<string, unknown> | null;
      before: Record<string, unknown> | null;
      after: Record<string, unknown> | null;
      requestId: string | null;
    }>;
    captureGaps: Array<{ surface: string | null; reason: string | null }>;
  };
  mcp: { requestEvents: number; errorEvents: number; rowEvents: number };
  fixtureCode: string;
}

export type BenchmarkArmEvidence = GenericStackEvidence | CrumbtrailEvidence;

export interface BenchmarkReproduction {
  bugId: string;
  harnessApp: string;
  evidence: {
    generic: GenericStackEvidence;
    crumbtrail: CrumbtrailEvidence;
  };
}

export const BENCHMARK_BUG_CLASSES: readonly BenchmarkBugClass[] = [
  "request_keyed_row_diff",
  "cross_release_behavior",
  "race_adjacent_write_skew",
  "http_failure_family",
];

const BENCHMARK_BUG_DEFINITIONS: readonly BenchmarkBugDefinition[] = [
  { id: "row_diff_wrong_request_key", harnessApp: "checkout_service", bugClass: "request_keyed_row_diff", seededReproduction: "Submit two order updates and inspect the second saved status.", fixtureCode: "request_01", mode: "request" },
  { id: "row_diff_pool_context_loss", harnessApp: "checkout_service", bugClass: "request_keyed_row_diff", seededReproduction: "Update an order through an acquired PostgreSQL pool client.", fixtureCode: "request_02", mode: "request" },
  { id: "row_diff_worker_origin_loss", harnessApp: "worker_projection", bugClass: "request_keyed_row_diff", seededReproduction: "Create an order and wait for the queued projection update.", fixtureCode: "request_03", mode: "request" },
  { id: "row_diff_gateway_header_loss", harnessApp: "gateway_checkout", bugClass: "request_keyed_row_diff", seededReproduction: "Save an order through the header stripping gateway route.", fixtureCode: "request_04", mode: "request" },
  { id: "row_diff_mysql_after_image", harnessApp: "catalog_mysql", bugClass: "request_keyed_row_diff", seededReproduction: "Insert one catalog row and inspect the emitted image.", fixtureCode: "request_05", mode: "request" },
  { id: "row_diff_mssql_output", harnessApp: "fulfillment_mssql", bugClass: "request_keyed_row_diff", seededReproduction: "Confirm a fulfillment row through the pool request API.", fixtureCode: "request_06", mode: "request" },
  { id: "row_diff_prisma_nested_write", harnessApp: "prisma_storefront", bugClass: "request_keyed_row_diff", seededReproduction: "Place an order that performs a nested item update.", fixtureCode: "request_07", mode: "request" },
  { id: "row_diff_cte_update", harnessApp: "reporting_postgres", bugClass: "request_keyed_row_diff", seededReproduction: "Run the seeded active order CTE update from the report action.", fixtureCode: "request_08", mode: "request" },
  { id: "release_discount_rounding", harnessApp: "checkout_service", bugClass: "cross_release_behavior", seededReproduction: "Compare the same discount checkout in release one and release two.", fixtureCode: "release_01", mode: "release" },
  { id: "release_tax_region_default", harnessApp: "checkout_service", bugClass: "cross_release_behavior", seededReproduction: "Compare a regionless checkout across the seeded releases.", fixtureCode: "release_02", mode: "release" },
  { id: "release_inventory_reservation", harnessApp: "worker_projection", bugClass: "cross_release_behavior", seededReproduction: "Reserve the final item in both seeded releases.", fixtureCode: "release_03", mode: "release" },
  { id: "release_webhook_signature", harnessApp: "gateway_checkout", bugClass: "cross_release_behavior", seededReproduction: "Deliver the fixture webhook to both seeded gateway releases.", fixtureCode: "release_04", mode: "release" },
  { id: "release_prisma_null_mapping", harnessApp: "prisma_storefront", bugClass: "cross_release_behavior", seededReproduction: "Update an optional shipping field in both seeded releases.", fixtureCode: "release_05", mode: "release" },
  { id: "release_knex_timezone_cast", harnessApp: "knex_backoffice", bugClass: "cross_release_behavior", seededReproduction: "Save the fixture delivery date in both seeded releases.", fixtureCode: "release_06", mode: "release" },
  { id: "release_feature_flag_fallback", harnessApp: "drizzle_inventory", bugClass: "cross_release_behavior", seededReproduction: "Disable the experiment flag and create a stock adjustment.", fixtureCode: "release_07", mode: "release" },
  { id: "write_skew_last_item", harnessApp: "worker_projection", bugClass: "race_adjacent_write_skew", seededReproduction: "Run the two buyer reservation fixture at the same time.", fixtureCode: "race_01", mode: "race" },
  { id: "write_skew_credit_limit", harnessApp: "checkout_service", bugClass: "race_adjacent_write_skew", seededReproduction: "Submit two credit purchases for the same account together.", fixtureCode: "race_02", mode: "race" },
  { id: "write_skew_webhook_retry", harnessApp: "gateway_checkout", bugClass: "race_adjacent_write_skew", seededReproduction: "Replay the delivery webhook while its retry is pending.", fixtureCode: "race_03", mode: "race" },
  { id: "write_skew_mssql_allocation", harnessApp: "fulfillment_mssql", bugClass: "race_adjacent_write_skew", seededReproduction: "Allocate one pallet from two concurrent dispatch requests.", fixtureCode: "race_04", mode: "race" },
  { id: "http_400_validation_mapping", harnessApp: "checkout_service", bugClass: "http_failure_family", seededReproduction: "Submit the fixture address with a missing postal code.", fixtureCode: "http_01", mode: "http", statusCode: 400 },
  { id: "http_401_gateway_scope", harnessApp: "gateway_checkout", bugClass: "http_failure_family", seededReproduction: "Call the gateway route with the fixture limited token.", fixtureCode: "http_02", mode: "http", statusCode: 401 },
  { id: "http_409_duplicate_order", harnessApp: "prisma_storefront", bugClass: "http_failure_family", seededReproduction: "Post the fixture order key twice.", fixtureCode: "http_03", mode: "http", statusCode: 409 },
  { id: "http_502_projection_timeout", harnessApp: "worker_projection", bugClass: "http_failure_family", seededReproduction: "Request a projection while the seeded worker delay is active.", fixtureCode: "http_04", mode: "http", statusCode: 502 },
  { id: "http_503_release_cache", harnessApp: "drizzle_inventory", bugClass: "http_failure_family", seededReproduction: "Load the stock page immediately after the seeded release switch.", fixtureCode: "http_05", mode: "http", statusCode: 503 },
];

const SESSION_START = 1_710_000_100_000;
const SESSION_ID = "ses_20260715_654321_abcdef123456";

async function reproduceSeededFailure(
  definition: BenchmarkBugDefinition,
): Promise<BenchmarkReproduction> {
  const requestId = traceId(definition.fixtureCode);
  const databaseRequestId =
    definition.mode === "request" ? traceId(`${definition.fixtureCode}_orphan`) : requestId;
  const events: BugEvent[] = [];
  const requestInput = {
    now: SESSION_START + 1,
    sessionStartedAt: SESSION_START,
    sessionId: SESSION_ID,
    method: "POST",
    url: "/seeded/failure",
    route: "/seeded/failure",
    headers: createCrumbtrailRequestHeaders(SESSION_ID, requestId),
  };
  events.push(buildBackendRequestStartEvent(requestInput));

  if (definition.mode !== "http") {
    let rowNumber = 0;
    const rawClient = {
      async query(_text: unknown, _params?: unknown) {
        rowNumber += 1;
        return {
          rows: [{ id: 101, status: definition.mode === "release" ? "changed" : `state_${rowNumber}` }],
          rowCount: 1,
        };
      },
    };
    const client = instrumentPgClient(rawClient, {
      requestId: databaseRequestId,
      sessionId: SESSION_ID,
      sessionStartedAt: SESSION_START,
      now: () => SESSION_START + 10 + rowNumber,
      emit: (event) => events.push(event),
    });
    if (definition.mode === "race") {
      await Promise.all([
        client.query("UPDATE inventory SET remaining = remaining - 1 WHERE id = $1", [101]),
        client.query("UPDATE inventory SET remaining = remaining - 1 WHERE id = $1", [101]),
      ]);
    } else {
      await client.query("UPDATE orders SET status = $1 WHERE id = $2", ["changed", 101]);
    }
  }

  if (definition.mode === "request") {
    events.push(
      buildCaptureGapEvent({
        surface: "queue",
        reason: "missing_session_id",
        detail: "seeded correlation handoff",
        sessionId: SESSION_ID,
        t: SESSION_START + 20,
        sessionStartedAt: SESSION_START,
      }),
    );
  }

  const statusCode = definition.statusCode ?? (definition.mode === "race" ? 409 : definition.mode === "release" ? 500 : 200);
  if (statusCode >= 400) {
    events.push(
      buildBackendRequestErrorEvent({
        ...requestInput,
        now: SESSION_START + 30,
        statusCode,
        error: new Error("Seeded failure"),
      }),
    );
  } else {
    events.push(
      buildBackendRequestEndEvent({
        ...requestInput,
        now: SESSION_START + 30,
        statusCode,
        durationMs: 29,
      }),
    );
  }

  const bundle = await buildTopologyBundle(events);
  const captureGaps = events
    .filter((event) => event.k === "capture_gap")
    .map((event) => ({
      surface: typeof event.d.surface === "string" ? event.d.surface : null,
      reason: typeof event.d.reason === "string" ? event.d.reason : null,
    }));
  const errorEvents = events.filter((event) => event.k === "backend.req.error").length;
  const databaseDiffs = bundle.databaseDiffs.map((diff) => ({
    op: diff.op,
    table: diff.table,
    pk: diff.pk,
    before: diff.before ?? null,
    after: diff.after ?? null,
    requestId: diff.requestId ?? null,
  }));

  return {
    bugId: definition.id,
    harnessApp: definition.harnessApp,
    evidence: {
      generic: {
        arm: "generic",
        symptom: definition.seededReproduction,
        sentry: {
          issue: `Seeded ${definition.bugClass} symptom`,
          error: errorEvents > 0 ? `HTTP ${statusCode}` : null,
        },
        datadog: {
          requestCount: 1,
          databaseChanges: databaseDiffs.length,
          statusCode,
        },
        jira: { report: definition.seededReproduction },
        fixtureCode: definition.fixtureCode,
      },
      crumbtrail: {
        arm: "crumbtrail",
        symptom: definition.seededReproduction,
        bundle: {
          completenessGrade: bundle.completeness.grade,
          requestIds: bundle.databaseDiffs
            .map((diff) => diff.requestId)
            .filter((id): id is string => typeof id === "string"),
          databaseDiffs,
          captureGaps,
        },
        mcp: {
          requestEvents: events.filter((event) => event.k.startsWith("backend.req")).length,
          errorEvents,
          rowEvents: databaseDiffs.length,
        },
        fixtureCode: definition.fixtureCode,
      },
    },
  };
}

function traceId(seed: string): string {
  const chars = [...seed].map((char) => char.charCodeAt(0).toString(16)).join("");
  return `${chars}00000000000000000000000000000000`.slice(0, 32);
}

export const BENCHMARK_CORPUS: readonly BenchmarkBug[] = BENCHMARK_BUG_DEFINITIONS.map((definition) => ({
  id: definition.id,
  harnessApp: definition.harnessApp,
  bugClass: definition.bugClass,
  seededReproduction: definition.seededReproduction,
  reproduce: () => reproduceSeededFailure(definition),
}));

export function corpusBugById(id: string): BenchmarkBug | undefined {
  return BENCHMARK_CORPUS.find((bug) => bug.id === id);
}

export async function reproduceBenchmarkBug(id: string): Promise<BenchmarkReproduction> {
  const bug = corpusBugById(id);
  if (!bug) throw new Error(`Unknown benchmark bug id: ${id}`);
  return bug.reproduce();
}
