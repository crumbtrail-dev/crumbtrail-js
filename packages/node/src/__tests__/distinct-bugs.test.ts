import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import {
  buildDistinctBugSignature,
  groupDistinctBugs,
} from "../distinct-bugs";
import { computeDistinctBugSignatures } from "../index";
import type { EvidenceCandidate } from "../evidence-index";

function candidate(
  overrides: Partial<EvidenceCandidate> &
    Pick<EvidenceCandidate, "id" | "detector" | "anchor">,
): EvidenceCandidate {
  return {
    schemaVersion: 1,
    title: `${overrides.detector} candidate`,
    severity: "medium",
    score: 50,
    confidence: "high",
    evidenceWindow: {
      start: overrides.anchor.t - 15,
      end: overrides.anchor.t + 45,
      windowId: "win_0001",
    },
    ...overrides,
  } as EvidenceCandidate;
}

// Two distinct failures + a duplicate of one:
//  - Bug A: a front-end HTTP 500 correlated (same requestId) to a back-end OTel span error.
//  - Bug B: a console error, plus a second identical console error shortly after (the duplicate).
const FIXTURE: EvidenceCandidate[] = [
  candidate({
    id: "cand_0001",
    detector: "http_error",
    title: "HTTP 500 from POST /api/pay",
    severity: "high",
    score: 90,
    anchor: {
      t: 1000,
      offsetMs: 0,
      route: "/checkout",
      requestId: "req-A",
      method: "POST",
      url: "/api/pay",
      status: 500,
      message: "HTTP 500",
    },
    evidenceWindow: { start: 985, end: 1045, windowId: "win_0001" },
  }),
  candidate({
    id: "cand_0002",
    detector: "otel_span_error",
    title: "OTel span error (HTTP 500): POST /api/pay [api]",
    severity: "high",
    score: 88,
    anchor: {
      t: 1010,
      offsetMs: 10,
      route: "/checkout",
      requestId: "req-A",
      status: 500,
      message: "upstream failed",
      source: "api",
    },
    evidenceWindow: { start: 995, end: 1055, windowId: "win_0001" },
  }),
  candidate({
    id: "cand_0003",
    detector: "console_error",
    title: "Console error: Cannot read properties of undefined",
    severity: "medium",
    score: 58,
    anchor: {
      t: 2000,
      offsetMs: 1000,
      message: "Cannot read properties of undefined",
    },
    evidenceWindow: { start: 1985, end: 2045, windowId: "win_0002" },
  }),
  candidate({
    id: "cand_0004",
    detector: "console_error",
    title: "Console error: Cannot read properties of undefined",
    severity: "medium",
    score: 58,
    anchor: {
      t: 2200,
      offsetMs: 1200,
      message: "Cannot read properties of undefined",
    },
    evidenceWindow: { start: 2185, end: 2245, windowId: "win_0002" },
  }),
];

describe("groupDistinctBugs", () => {
  it("groups two distinct failures and dedups a repeat into exactly two stable bugs", () => {
    const bugs = groupDistinctBugs(FIXTURE);

    expect(bugs).toHaveLength(2);

    // Deterministic ordering: severity desc (high before medium), then firstSeen, then bugId.
    const [bugA, bugB] = bugs;

    // Stable, deterministic ids locked to detect any drift in the dedup-key derivation.
    expect(bugA.bugId).toBe("bug_1xcohsf");
    expect(bugB.bugId).toBe("bug_1pg6ltd");

    // Bug A: correlated front-end + back-end share one requestId, so front/back land together.
    expect(bugA.severity).toBe("high");
    expect(bugA.requestIds).toEqual(["req-A"]);
    expect(bugA.firstSeen).toBe(1000);
    expect(bugA.lastSeen).toBe(1010);
    expect(bugA.window).toEqual({ start: 985, end: 1055 });
    expect(bugA.candidateIds).toEqual(["cand_0001", "cand_0002"]);
    expect(bugA.frontendEvidence.map((ref) => ref.candidateId)).toEqual([
      "cand_0001",
    ]);
    expect(bugA.backendEvidence.map((ref) => ref.candidateId)).toEqual([
      "cand_0002",
    ]);
    expect(bugA.representative).toMatchObject({
      detector: "http_error",
      requestId: "req-A",
      method: "POST",
      status: 500,
    });
    expect(bugA.frontendEvidence[0]).toMatchObject({
      method: "POST",
      status: 500,
    });

    // Bug B: the duplicate console error collapsed into the same bug.
    expect(bugB.severity).toBe("medium");
    expect(bugB.requestIds).toEqual([]);
    expect(bugB.candidateIds).toEqual(["cand_0003", "cand_0004"]);
    expect(bugB.frontendEvidence).toHaveLength(2);
    expect(bugB.backendEvidence).toHaveLength(0);
    expect(bugB).not.toHaveProperty("dbDiffs");
  });

  it("is deterministic regardless of input order", () => {
    const forward = groupDistinctBugs(FIXTURE);
    const reversed = groupDistinctBugs([...FIXTURE].reverse());
    expect(reversed).toEqual(forward);
  });

  it("returns an empty list for no candidates", () => {
    expect(groupDistinctBugs([])).toEqual([]);
  });

  it("carries bounded, redacted bodies for the representative's correlated failed request", () => {
    const representative = candidate({
      id: "cand_body",
      detector: "http_error",
      title: "HTTP 500 from POST /api/pay",
      severity: "high",
      score: 90,
      anchor: {
        t: 1_100,
        requestId: "body-request",
        method: "POST",
        status: 500,
      },
    });
    const events: BugEvent[] = [
      {
        t: 1_000,
        k: "net.req",
        d: { id: "body-request", body: "apiKey=supersecret-key&amount=42" },
      },
      {
        t: 1_100,
        k: "net.res",
        d: {
          id: "body-request",
          st: 500,
          body: { error: "payment failed", token: "supersecret-token" },
        },
      },
    ];

    const [bug] = groupDistinctBugs([representative], events);

    expect(bug.representative.bodySnippet).toMatchObject({
      request: expect.stringContaining("[REDACTED_KEY]="),
      response: expect.stringContaining("[REDACTED_KEY]"),
    });
    expect(bug.representative.bodySnippet?.request).toContain("amount=42");
    expect(bug.representative.bodySnippet?.response).toContain("payment failed");
    expect(JSON.stringify(bug.representative.bodySnippet)).not.toContain(
      "supersecret",
    );
    expect(bug.representative.bodySnippet?.request?.length).toBeLessThanOrEqual(
      300,
    );
    expect(bug.representative.bodySnippet?.response?.length).toBeLessThanOrEqual(
      300,
    );
  });

  it("omits the representative body snippet when the failed request has no bodies", () => {
    const representative = candidate({
      id: "cand_body_absent",
      detector: "network_error",
      title: "Network error from POST /api/pay",
      severity: "high",
      score: 86,
      anchor: { t: 1_100, requestId: "bodyless-request", method: "POST" },
    });
    const events: BugEvent[] = [
      { t: 1_000, k: "net.req", d: { id: "bodyless-request" } },
      { t: 1_100, k: "net.err", d: { id: "bodyless-request" } },
    ];

    const [bug] = groupDistinctBugs([representative], events);

    expect(bug.representative).not.toHaveProperty("bodySnippet");
  });

  it("carries target descriptors into distinct bug evidence and signatures", () => {
    const bugs = groupDistinctBugs([
      candidate({
        id: "cand_target_a",
        detector: "repeated_clicks",
        title: "Repeated clicks on Submit order",
        anchor: {
          t: 1000,
          message: "3 clicks within 3s",
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
      }),
      candidate({
        id: "cand_target_b",
        detector: "repeated_clicks",
        title: "Repeated clicks on Submit order",
        anchor: {
          t: 1200,
          message: "3 clicks within 3s",
          target: {
            role: "button",
            label: "Cancel order",
            testID: "cancel-order",
            accessibilityId: "checkout.cancel",
            componentName: "Pressable",
            routePath: "/checkout",
            ancestryHash: "rn:checkout:footer:secondary",
          },
        },
      }),
    ]);

    expect(bugs).toHaveLength(2);
    expect(bugs.map((bug) => bug.representative.target?.testID).sort()).toEqual(
      ["cancel-order", "submit-order"],
    );
    expect(
      bugs.flatMap((bug) =>
        bug.frontendEvidence.map((ref) => ref.target?.routePath),
      ),
    ).toEqual(["/checkout", "/checkout"]);
    expect(
      bugs.flatMap((bug) =>
        bug.frontendEvidence.map((ref) => ref.target?.componentName),
      ),
    ).toEqual(["Pressable", "Pressable"]);
  });
});

describe("groupDistinctBugs — route-agnostic beacon collapse (CRUMB-94)", () => {
  const rejection = (id: string, t: number, route: string) =>
    candidate({
      id,
      detector: "unhandled_rejection",
      title: "Unhandled rejection: Failed to fetch",
      severity: "low",
      score: 15,
      anchor: { t, route, message: "Failed to fetch" },
      evidenceWindow: { start: t - 15, end: t + 45, windowId: `win_${id}` },
    });

  const spread: EvidenceCandidate[] = [
    rejection("cand_r1", 1_000, "https://alertbase.ai/dashboard/jobs"),
    rejection("cand_r2", 90_000, "https://alertbase.ai/dashboard/billing"),
    rejection("cand_r3", 180_000, "https://alertbase.ai/dashboard/settings"),
    rejection("cand_r4", 270_000, "https://alertbase.ai/dashboard/jobs?tab=2"),
    rejection("cand_r5", 360_000, "https://alertbase.ai/dashboard/reports"),
  ];

  it("collapses N same-signature rejections across URLs into one bug with occurrence info", () => {
    const bugs = groupDistinctBugs(spread);

    expect(bugs).toHaveLength(1);
    const [bug] = bugs;
    expect(bug.occurrenceCount).toBe(5);
    expect(bug.affectedUrls).toHaveLength(5);
    // Per-occurrence evidence windows are preserved on the single merged bug.
    expect(bug.frontendEvidence).toHaveLength(5);
    expect(bug.candidateIds).toEqual([
      "cand_r1",
      "cand_r2",
      "cand_r3",
      "cand_r4",
      "cand_r5",
    ]);
  });

  it("is deterministic regardless of input order", () => {
    expect(groupDistinctBugs([...spread].reverse())).toEqual(
      groupDistinctBugs(spread),
    );
  });

  it("keeps a real first-party failure ranked above the collapsed beacon noise", () => {
    const firstParty = candidate({
      id: "cand_http",
      detector: "http_error",
      title: "HTTP 404 from GET /api/jobs",
      severity: "medium",
      score: 70,
      anchor: {
        t: 5_000,
        route: "/dashboard/jobs",
        method: "GET",
        status: 404,
        message: "HTTP 404",
      },
    });

    const bugs = groupDistinctBugs([...spread, firstParty]);

    // One collapsed beacon bug + one first-party bug, first-party ranked first (severity desc).
    expect(bugs).toHaveLength(2);
    expect(bugs[0].representative.detector).toBe("http_error");
    expect(bugs[0].severity).toBe("medium");
    expect(bugs[1].representative.detector).toBe("unhandled_rejection");
    expect(bugs[1].severity).toBe("low");
    expect(bugs[1].occurrenceCount).toBe(5);
  });
});

describe("buildDistinctBugSignature", () => {
  it("normalizes numeric message values across sessions", () => {
    const invoiceA = groupDistinctBugs([
      candidate({
        id: "cand_invoice_a",
        detector: "db_mutation",
        title: "Wrong invoice rank",
        anchor: {
          t: 1000,
          message: "Invoice 123 ranked 3 instead of 1",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];
    const invoiceB = groupDistinctBugs([
      candidate({
        id: "cand_invoice_b",
        detector: "db_mutation",
        title: "Wrong invoice rank",
        anchor: {
          t: 1000,
          message: "Invoice 456 ranked 3 instead of 1",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];
    const thresholdA = groupDistinctBugs([
      candidate({
        id: "cand_threshold_a",
        detector: "db_mutation",
        title: "Wrong approval threshold",
        anchor: {
          t: 1000,
          message: "Expected 2 approvals but got 3",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];
    const thresholdB = groupDistinctBugs([
      candidate({
        id: "cand_threshold_b",
        detector: "db_mutation",
        title: "Wrong approval threshold",
        anchor: {
          t: 1000,
          message: "Expected 7 approvals but got 8",
          route: "/jobs/invoice-digest",
        },
      }),
    ])[0];

    expect(buildDistinctBugSignature(invoiceA)).toBe(
      buildDistinctBugSignature(invoiceB),
    );
    expect(buildDistinctBugSignature(thresholdA)).toBe(
      buildDistinctBugSignature(thresholdB),
    );
  });

  it("collapses the production route variants into one version-2 signature", () => {
    const bug = (route: string) => ({
      title: "Unhandled rejection: Failed to fetch",
      representative: {
        title: "Unhandled rejection: Failed to fetch",
        detector: "unhandled_rejection",
        severity: "high" as const,
        message: "Unhandled rejection: Failed to fetch",
        route,
      },
    });

    const signatures = [
      "https://alertbase.ai/dashboard/jobs",
      "https://alertbase.ai/dashboard/jobs?tab=2",
      "/dashboard/jobs#x",
    ].map((route) => buildDistinctBugSignature(bug(route)));

    expect(signatures).toEqual([signatures[0], signatures[0], signatures[0]]);
    expect(signatures[0]).toMatch(/^bugsig2:/);
  });

  it("collapses UUID and hexadecimal route segments", () => {
    const bug = (route: string) => ({
      title: "Job request failed",
      representative: {
        title: "Job request failed",
        detector: "http_error",
        severity: "high" as const,
        message: "Job request failed",
        route,
      },
    });

    const idSignature = buildDistinctBugSignature(bug("/jobs/:id"));

    expect(
      buildDistinctBugSignature(
        bug("/jobs/550e8400-e29b-41d4-a716-446655440000"),
      ),
    ).toBe(idSignature);
    expect(buildDistinctBugSignature(bug("/jobs/deadbeef"))).toBe(
      idSignature,
    );
    expect(buildDistinctBugSignature(bug("/jobs/feedback"))).not.toBe(
      idSignature,
    );
    expect(buildDistinctBugSignature(bug("/jobs/dashboard"))).not.toBe(
      idSignature,
    );
  });

  it("keeps genuinely different routes distinct", () => {
    const bug = (route: string) => ({
      title: "Request failed",
      representative: {
        title: "Request failed",
        detector: "http_error",
        severity: "high" as const,
        message: "Request failed",
        route,
      },
    });

    expect(buildDistinctBugSignature(bug("/jobs"))).not.toBe(
      buildDistinctBugSignature(bug("/billing")),
    );
  });

  it("returns the exact legacy signature for cutover matching", () => {
    const signatures = computeDistinctBugSignatures({
      title: "Unhandled rejection: Failed to fetch",
      representative: {
        title: "Unhandled rejection: Failed to fetch",
        detector: "unhandled_rejection",
        severity: "high",
        message: "Unhandled rejection: Failed to fetch",
        route: "https://alertbase.ai/dashboard/jobs?tab=2#x",
      },
    });

    expect(signatures.legacy).toBe("bugsig:1du09jm");
    expect(buildDistinctBugSignature({
      title: "Unhandled rejection: Failed to fetch",
      representative: {
        title: "Unhandled rejection: Failed to fetch",
        detector: "unhandled_rejection",
        severity: "high",
        message: "Unhandled rejection: Failed to fetch",
        route: "https://alertbase.ai/dashboard/jobs?tab=2#x",
      },
    })).toBe(signatures.current);
  });
});
