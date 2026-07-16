import { describe, expect, it } from "vitest";
import {
  deriveAchievedFidelity,
  runTopologyCell,
  topologyCells,
  type ScenarioExecution,
} from "./topology";
import { executeSerializedBullmqWorker } from "./bullmq-worker-executor";

describe("topology matrix cells", () => {
  it.each(topologyCells)("asserts $id against its ground truth", async (cell) => {
    const result = await runTopologyCell(cell);
    expect(result.achieved).toBe(cell.expected);
  });

  it("rejects an unreported missing join", () => {
    const execution: ScenarioExecution = {
      events: [],
      bundle: {
        completeness: { gapCount: 0, gapsBySurface: {}, gapsByReason: {}, grade: "complete" },
        fullStackEvidence: { summary: { linked: 0 }, linked: [] },
        databaseDiffs: [],
      } as unknown as ScenarioExecution["bundle"],
      groundTruth: {
        actionId: "action_missing",
        requestId: "request_missing",
        sessionId: "session_missing",
        expectedRowChanges: [
          {
            op: "update",
            table: "orders",
            pk: { id: 101 },
            before: null,
            after: { id: 101, status: "ready" },
          },
        ],
        causalOrdering: {
          actionBeforeRequestStart: true,
          requestStartBeforeDatabaseDiff: true,
        },
        notes: [],
      },
    };
    expect(() => deriveAchievedFidelity(execution)).toThrow("Silent topology loss");
  });

  it("rejects an action that happens after the database write", () => {
    const execution = causalExecution();
    execution.events[0].t = 40;
    expect(() => deriveAchievedFidelity(execution)).toThrow("Silent topology loss");
  });

  it.each([
    ["table", { table: "payments" }],
    ["primary key", { pk: { id: 102 } }],
    ["after image", { after: { id: 101, status: "cancelled" } }],
  ])("rejects an incorrect row %s", (_name, override) => {
    const execution = causalExecution();
    Object.assign(execution.bundle.databaseDiffs[0], override);
    expect(() => deriveAchievedFidelity(execution)).toThrow("Silent topology loss");
  });

  it("rejects an unexpected before image", () => {
    const execution = causalExecution();
    execution.bundle.databaseDiffs[0].before = { id: 101, status: "draft" };
    expect(() => deriveAchievedFidelity(execution)).toThrow("Silent topology loss");
  });

  it("rejects an unexpected after image", () => {
    const execution = causalExecution();
    execution.groundTruth.expectedRowChanges[0].after = null;
    expect(() => deriveAchievedFidelity(execution)).toThrow("Silent topology loss");
  });

  it("rejects a missing expected image", () => {
    const execution = causalExecution();
    delete execution.bundle.databaseDiffs[0].after;
    expect(() => deriveAchievedFidelity(execution)).toThrow("Silent topology loss");
  });

  it("accepts the exact causal action request and row path", () => {
    expect(deriveAchievedFidelity(causalExecution())).toBe("full");
  });

  it("gives the serialized worker no access to request events outside the payload", async () => {
    const requestOnlyEvent = {
      t: 1,
      k: "request.only",
      d: { marker: "request event not serialized" },
    };
    const payload = JSON.stringify({
      traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      correlation: {
        requestId: "req_bullmq_abcdefghijkl",
        sessionId: "ses_20260715_123456_abcdef123456",
      },
    });

    const workerEvents = JSON.parse(await executeSerializedBullmqWorker(payload)) as Array<{
      k: string;
      d: Record<string, unknown>;
    }>;

    expect(workerEvents).not.toContainEqual(requestOnlyEvent);
    expect(JSON.stringify(workerEvents)).not.toContain("request event not serialized");
    expect(workerEvents.find((event) => event.k === "db.diff")?.d.requestId).toBe(
      "req_bullmq_abcdefghijkl",
    );
  });
});

function causalExecution(): ScenarioExecution {
  return {
    events: [
      { t: 10, k: "clk", d: { id: "action_exact" } },
      { t: 20, k: "backend.req.start", d: { requestId: "request_exact" } },
    ],
    bundle: {
      completeness: { gapCount: 0, gapsBySurface: {}, gapsByReason: {}, grade: "complete" },
      fullStackEvidence: { summary: { linked: 1 }, linked: [] },
      databaseDiffs: [
        {
          t: 30,
          op: "update",
          table: "orders",
          pk: { id: 101 },
          after: { id: 101, status: "ready" },
          requestId: "request_exact",
        },
      ],
    } as unknown as ScenarioExecution["bundle"],
    groundTruth: {
      actionId: "action_exact",
      requestId: "request_exact",
      expectedRowChanges: [
        {
          op: "update",
          table: "orders",
          pk: { id: 101 },
          before: null,
          after: { id: 101, status: "ready" },
        },
      ],
      causalOrdering: {
        actionBeforeRequestStart: true,
        requestStartBeforeDatabaseDiff: true,
      },
      notes: [],
    },
  };
}
