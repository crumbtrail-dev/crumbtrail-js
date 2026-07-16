import {
  buildCaptureGapEvent,
  createCrumbtrailRequestHeaders,
  type BugEvent,
} from "crumbtrail-core";
import { instrumentPgClient, resolveDbRequestContext } from "crumbtrail-node";

interface SerializedBullmqJob {
  traceparent?: string;
  correlation?: {
    requestId?: string;
    sessionId?: string;
  };
}

const WORKER_SESSION_START = 1_710_000_000_000;

/**
 * Models a BullMQ worker process boundary without requiring Redis in the
 * deterministic harness. The enqueue side can pass only one JSON string in,
 * and receives only one JSON event stream out. This module has no reference to
 * the request event stream, request sink, or any enqueue side object.
 */
export async function executeSerializedBullmqWorker(
  serializedPayload: string,
): Promise<string> {
  const job = parseSerializedJob(serializedPayload);
  const workerEvents: BugEvent[] = [];
  const headers = headersFromSerializedJob(job);
  const context = resolveDbRequestContext({ headers });

  if (!job.correlation?.sessionId) {
    workerEvents.push(
      buildCaptureGapEvent({
        surface: "queue",
        reason: "missing_session_id",
        detail: "worker correlation",
        t: WORKER_SESSION_START + 4,
        sessionStartedAt: WORKER_SESSION_START,
      }),
    );
  }

  let nextTimestamp = WORKER_SESSION_START + 10;
  const rawClient = {
    async query(_text: unknown, _params?: unknown) {
      return { rows: [{ id: 101, status: "ready" }], rowCount: 1 };
    },
  };
  const client = instrumentPgClient(rawClient, {
    ...context,
    emit: (event) => workerEvents.push(event),
    now: () => nextTimestamp++,
    sessionStartedAt: WORKER_SESSION_START,
  });
  await client.query("UPDATE orders SET status = $1 WHERE id = $2", ["ready", 101]);

  return JSON.stringify(workerEvents);
}

function parseSerializedJob(serializedPayload: string): SerializedBullmqJob {
  const parsed: unknown = JSON.parse(serializedPayload);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("BullMQ worker payload must decode to an object.");
  }
  const job = parsed as Record<string, unknown>;
  const correlation =
    job.correlation && typeof job.correlation === "object" && !Array.isArray(job.correlation)
      ? (job.correlation as Record<string, unknown>)
      : undefined;
  return {
    ...(typeof job.traceparent === "string" ? { traceparent: job.traceparent } : {}),
    ...(correlation
      ? {
          correlation: {
            ...(typeof correlation.requestId === "string"
              ? { requestId: correlation.requestId }
              : {}),
            ...(typeof correlation.sessionId === "string"
              ? { sessionId: correlation.sessionId }
              : {}),
          },
        }
      : {}),
  };
}

function headersFromSerializedJob(job: SerializedBullmqJob): Record<string, string> {
  const correlation = job.correlation;
  const headers =
    correlation?.requestId && correlation.sessionId
      ? createCrumbtrailRequestHeaders(correlation.sessionId, correlation.requestId)
      : {};
  return {
    ...headers,
    ...(job.traceparent ? { traceparent: job.traceparent } : {}),
  };
}
