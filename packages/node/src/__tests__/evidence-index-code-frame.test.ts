import { describe, it, expect } from "vitest";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates } from "../evidence-index";

// The code-location slot of the evidence quality panel reads `anchor.frame`.
// It is deliberately NOT `anchor.source`: that field is a free-form provenance
// label on the network, backend and OTel detectors ("backend", a transport
// name), so pointing the slot at it reported "a source location was captured"
// for signals that never had one.
describe("buildEvidenceCandidates — code frame anchoring", () => {
  it("anchors an uncaught error at its file, line and column", () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "err",
        d: {
          msg: "TypeError: x is undefined",
          file: "https://app.example.test/assets/app-4f2a.js",
          line: 812,
          col: 17,
        },
      },
    ];
    const index = {
      start: 1000,
      errs: [
        {
          t: 1000,
          msg: "TypeError: x is undefined",
          file: "https://app.example.test/assets/app-4f2a.js",
          line: 812,
          col: 17,
        },
      ],
    };
    const [candidate] = buildEvidenceCandidates(events, index).filter(
      (c) => c.detector === "uncaught_error",
    );
    expect(candidate.anchor.frame).toBe(
      "https://app.example.test/assets/app-4f2a.js:812:17",
    );
  });

  it("anchors an Error shaped rejection at the top frame of its stack", () => {
    const events: BugEvent[] = [
      { t: 1000, k: "rej", d: { msg: "Failed to fetch" } },
    ];
    const index = {
      start: 1000,
      errs: [
        {
          t: 1000,
          msg: "Failed to fetch",
          stk: "TypeError: Failed to fetch\n    at load (https://app.example.test/assets/api-9c1.js:44:9)\n    at onClick (https://app.example.test/assets/ui-2b8.js:12:3)",
        },
      ],
    };
    const [candidate] = buildEvidenceCandidates(events, index).filter(
      (c) => c.detector === "unhandled_rejection",
    );
    expect(candidate.anchor.frame).toBe(
      "https://app.example.test/assets/api-9c1.js:44:9",
    );
  });

  it("leaves the frame unset when a rejection carries no stack", () => {
    // Rejecting with a bare string gives the browser nothing to build a stack
    // from. The slot must stay honest rather than invent a location.
    const events: BugEvent[] = [
      { t: 1000, k: "rej", d: { msg: "nope" } },
    ];
    const index = { start: 1000, errs: [{ t: 1000, msg: "nope" }] };
    const [candidate] = buildEvidenceCandidates(events, index).filter(
      (c) => c.detector === "unhandled_rejection",
    );
    expect(candidate.anchor.frame).toBeUndefined();
  });
});
