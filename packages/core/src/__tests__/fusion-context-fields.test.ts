import { describe, expect, it } from "vitest";
import { assembleBundle } from "../fusion";
import type { Located, Symptom } from "../fusion";
import type { EvidenceItem } from "../evidence";

function item(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "id-1",
    lane: "flow",
    kind: "flow.step-missing",
    brief: "generic evidence",
    ref: {},
    before: undefined,
    after: undefined,
    ...overrides,
  };
}

// --- Move 3: contextCompleteness calibration (thin / medium / full) --------
//
// The three fixtures below were hand-labelled low / medium / high by eye
// FIRST; the weights in deriveContextCompleteness are tuned so they land in
// distinct bands. If a weight change flattens them, this test is the canary.

describe("contextCompleteness — calibration", () => {
  it("scores a thin bundle (symptom only, inconclusive locate, one gap) LOW", () => {
    const symptom: Symptom = { title: "checkout is broken" };
    const located: Located = { outcome: "inconclusive", confidence: 0.2 };
    const bundle = assembleBundle({
      symptom,
      evidence: [],
      intent: [],
      gaps: [{ lane: "network", reason: "no recorded session matched" }],
      located,
    });

    expect(bundle.contextCompleteness.level).toBe("low");
    expect(bundle.contextCompleteness.score).toBeLessThan(0.34);
    expect(bundle.contextCompleteness.reasons.length).toBeGreaterThan(0);
    expect(bundle.contextCompleteness.reasons).toContain(
      "incident location inconclusive",
    );
  });

  it("scores a medium bundle (2 network items, one lane, matched locate, one gap) MEDIUM", () => {
    const symptom: Symptom = { title: "checkout 500s", url: "/api/checkout" };
    const located: Located = {
      outcome: "matched",
      confidence: 0.6,
      method: "fuzzy",
      sessionId: "ses_abc",
    };
    const bundle = assembleBundle({
      symptom,
      evidence: [
        item({
          id: "n1",
          lane: "network",
          kind: "net.status",
          brief: "POST /api/checkout 500",
        }),
        item({
          id: "n2",
          lane: "network",
          kind: "net.status",
          brief: "POST /api/checkout slow",
        }),
      ],
      intent: [],
      gaps: [{ lane: "db", reason: "no db diff captured" }],
      located,
    });

    expect(bundle.contextCompleteness.level).toBe("medium");
    expect(bundle.contextCompleteness.score).toBeGreaterThanOrEqual(0.34);
    expect(bundle.contextCompleteness.score).toBeLessThan(0.67);
  });

  it("scores a full bundle (3 informative lanes, 5 items, strong matched locate, no gaps) HIGH", () => {
    const symptom: Symptom = { title: "checkout 500s", url: "/api/checkout" };
    const located: Located = {
      outcome: "matched",
      confidence: 0.85,
      method: "fuzzy",
      sessionId: "ses_abc",
    };
    const bundle = assembleBundle({
      symptom,
      evidence: [
        item({
          id: "n1",
          lane: "network",
          kind: "net.status",
          brief: "POST /api/checkout 500",
        }),
        item({
          id: "n2",
          lane: "network",
          kind: "net.status",
          brief: "retry 500",
        }),
        item({
          id: "d1",
          lane: "db",
          kind: "db.row-value",
          brief: "orders row stuck",
        }),
        item({
          id: "f1",
          lane: "flow",
          kind: "flow.step-missing",
          brief: "confirm step never reached",
        }),
        item({
          id: "f2",
          lane: "flow",
          kind: "flow.step-missing",
          brief: "redirect skipped",
        }),
      ],
      intent: [],
      located,
    });

    expect(bundle.contextCompleteness.level).toBe("high");
    expect(bundle.contextCompleteness.score).toBeGreaterThanOrEqual(0.67);
  });

  it("does not penalize completeness for a locate that never ran (explicit comparison)", () => {
    const symptom: Symptom = { title: "checkout 500s", url: "/api/checkout" };
    const withoutLocate = assembleBundle({
      symptom,
      evidence: [
        item({ id: "n1", lane: "network", kind: "net.status", brief: "500" }),
        item({
          id: "d1",
          lane: "db",
          kind: "db.row-value",
          brief: "row stuck",
        }),
      ],
      intent: [],
    });
    // No `located` field emitted when no locate ran.
    expect(withoutLocate.located).toBeUndefined();
    expect(withoutLocate.contextCompleteness.reasons).not.toContain(
      "incident location inconclusive",
    );
  });

  it("treats an ambiguous locate like an inconclusive locate and never lifts completeness", () => {
    const input = {
      symptom: { title: "checkout is broken" },
      evidence: [],
      intent: [],
      gaps: [
        { lane: "network" as const, reason: "no recorded session matched" },
      ],
    };
    const inconclusive = assembleBundle({
      ...input,
      located: { outcome: "inconclusive", confidence: 0.2 },
    });
    const ambiguous = assembleBundle({
      ...input,
      located: {
        outcome: "ambiguous",
        confidence: 0.95,
        candidates: [
          {
            sessionId: "session-a",
            bugId: "bug-a",
            confidence: 0.95,
            reasons: ["semantic"],
          },
        ],
      },
    });

    expect(ambiguous.contextCompleteness.score).toBe(
      inconclusive.contextCompleteness.score,
    );
    expect(ambiguous.contextCompleteness.reasons).toContain(
      "incident location ambiguous",
    );
  });
});

// --- Move 2: located threaded onto the bundle ------------------------------

describe("located passthrough", () => {
  it("threads a provided located decision onto the bundle verbatim", () => {
    const located: Located = {
      outcome: "matched",
      confidence: 0.7,
      method: "fuzzy",
      sessionId: "ses_xyz",
      reasons: ["semantic match", "same route"],
    };
    const bundle = assembleBundle({
      symptom: { title: "x" },
      evidence: [],
      intent: [],
      located,
    });
    expect(bundle.located).toEqual(located);
  });
});

// --- Move 4: verification is anchored and never vacuous --------------------

describe("verification — anchored, never vacuous", () => {
  it("emits a request observation naming the request id and signature", () => {
    const bundle = assembleBundle({
      symptom: { title: "checkout 500s", url: "/api/checkout" },
      evidence: [
        item({
          id: "n1",
          lane: "network",
          kind: "net.status",
          brief: "POST /api/checkout 500",
          ref: { requestId: "req-123", sig: "net.500" },
        }),
      ],
      intent: [],
    });
    const regression = bundle.opinion.hypotheses.find(
      (h) => h.kind === "regression",
    );
    expect(regression?.verification).toBeDefined();
    expect(regression?.verification).toHaveLength(1);
    const v = regression!.verification![0];
    expect(v.how).toBe("request");
    expect(v.observation).toContain("req-123");
    expect(v.observation).toContain("net.500");
    expect(v.evidenceIds).toEqual(["n1"]);
  });

  it("emits a db observation naming the table and primary key", () => {
    const bundle = assembleBundle({
      symptom: { title: "order stuck" },
      evidence: [
        item({
          id: "d1",
          lane: "db",
          kind: "db.row-value",
          brief: "orders row wrong",
          ref: { table: "orders", pk: { id: 42 } },
        }),
      ],
      intent: [],
    });
    const regression = bundle.opinion.hypotheses.find(
      (h) => h.kind === "regression",
    );
    const v = regression?.verification?.[0];
    expect(v?.how).toBe("db");
    expect(v?.observation).toContain("orders");
    expect(v?.observation).toContain("id=42");
  });

  it("emits NOTHING for un-anchored evidence (sparse beats vacuous)", () => {
    const bundle = assembleBundle({
      symptom: { title: "something off" },
      evidence: [
        // Anchored: gets an observation.
        item({ id: "n1", lane: "network", ref: { requestId: "req-9" } }),
        // Un-anchored (ref:{}): must produce no observation.
        item({ id: "f1", lane: "flow", ref: {} }),
      ],
      intent: [],
    });
    const regression = bundle.opinion.hypotheses.find(
      (h) => h.kind === "regression",
    );
    expect(regression?.verification).toHaveLength(1);
    expect(regression?.verification?.[0].evidenceIds).toEqual(["n1"]);
  });

  it("never attaches verification to an inconclusive hypothesis", () => {
    const bundle = assembleBundle({
      symptom: { title: "" },
      evidence: [],
      intent: [],
    });
    const inconclusive = bundle.opinion.hypotheses.find(
      (h) => h.kind === "inconclusive",
    );
    expect(inconclusive).toBeDefined();
    expect(inconclusive?.verification).toBeUndefined();
  });
});

// --- Move 5: escalation is consumer-side and distinct from gaps ------------

describe("escalation — consumer-side advisory, distinct from gaps", () => {
  it("recommends escalation with concrete conditions when context is low", () => {
    const bundle = assembleBundle({
      symptom: { title: "checkout broken" },
      evidence: [],
      intent: [],
      gaps: [{ lane: "network", reason: "no recorded session matched" }],
      located: { outcome: "inconclusive", confidence: 0.1 },
    });
    expect(bundle.escalation.recommended).toBe(true);
    expect(bundle.escalation.when.length).toBeGreaterThan(0);
  });

  it("does not recommend escalation for a rich bundle even when a gap is present", () => {
    const bundle = assembleBundle({
      symptom: { title: "checkout 500s", url: "/api/checkout" },
      evidence: [
        item({ id: "n1", lane: "network", kind: "net.status", brief: "500" }),
        item({
          id: "n2",
          lane: "network",
          kind: "net.status",
          brief: "500 retry",
        }),
        item({
          id: "d1",
          lane: "db",
          kind: "db.row-value",
          brief: "row stuck",
        }),
        item({
          id: "f1",
          lane: "flow",
          kind: "flow.step-missing",
          brief: "step skipped",
        }),
        item({
          id: "f2",
          lane: "flow",
          kind: "flow.step-missing",
          brief: "redirect skipped",
        }),
      ],
      intent: [],
      // A soft gap exists (capture-side) but context is still rich...
      gaps: [{ lane: "env", reason: "env snapshot partial" }],
      located: {
        outcome: "matched",
        confidence: 0.85,
        method: "fuzzy",
        sessionId: "ses_a",
      },
    });
    // ...so escalation (consumer-side) is NOT recommended: gaps ≠ escalation.
    expect(bundle.gaps.length).toBeGreaterThan(0);
    expect(bundle.escalation.recommended).toBe(false);
    expect(bundle.escalation.when).toEqual([]);
  });
});
