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
    const events: BugEvent[] = [{ t: 1000, k: "rej", d: { msg: "nope" } }];
    const index = { start: 1000, errs: [{ t: 1000, msg: "nope" }] };
    const [candidate] = buildEvidenceCandidates(events, index).filter(
      (c) => c.detector === "unhandled_rejection",
    );
    expect(candidate.anchor.frame).toBeUndefined();
  });

  // A framework that reports failures through `console.error` instead of
  // throwing — a React error boundary being the common case — used to produce a
  // permanently frameless candidate, even though the console collector
  // synthesizes a stack at call time and ships it. The stack reached the
  // session index and was then dropped before candidates were built.
  it("anchors a console error at the top frame of its synthesized stack", () => {
    const events: BugEvent[] = [
      { t: 1000, k: "con", d: { lv: "err", msg: "render failed" } },
    ];
    const index = {
      start: 1000,
      consoleErrors: [
        {
          t: 1000,
          lv: "err",
          msg: "render failed",
          stk: "Error\n    at Board (https://app.example.test/assets/board-71c.js:220:14)\n    at renderWithHooks (https://app.example.test/assets/react-8de.js:11:2)",
        },
      ],
    };
    const [candidate] = buildEvidenceCandidates(events, index).filter(
      (c) => c.detector === "console_error",
    );
    expect(candidate.anchor.frame).toBe(
      "https://app.example.test/assets/board-71c.js:220:14",
    );
  });

  it("leaves the console error frame unset when no stack was captured", () => {
    const events: BugEvent[] = [
      { t: 1000, k: "con", d: { lv: "err", msg: "render failed" } },
    ];
    const index = {
      start: 1000,
      consoleErrors: [{ t: 1000, lv: "err", msg: "render failed" }],
    };
    const [candidate] = buildEvidenceCandidates(events, index).filter(
      (c) => c.detector === "console_error",
    );
    expect(candidate.anchor.frame).toBeUndefined();
  });

  it("anchors an OTel span error at its code.* attributes", () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "backend.otel.span",
        d: {
          name: "POST /api/alerts",
          statusCode: "ERROR",
          serviceName: "job-engine",
          attributes: {
            "code.file.path": "src/alerts/dispatch.ts",
            "code.line.number": 91,
            "code.column.number": 5,
          },
        },
      },
    ];
    const [candidate] = buildEvidenceCandidates(events, { start: 1000 }).filter(
      (c) => c.detector === "otel_span_error",
    );
    expect(candidate.anchor.frame).toBe("src/alerts/dispatch.ts:91:5");
  });

  it("accepts the older code.filepath spelling and the exception stacktrace", () => {
    // Exporters in the field emit either semantic convention, and an SDK that
    // records an exception may only set exception.stacktrace.
    const legacy: BugEvent[] = [
      {
        t: 1000,
        k: "backend.otel.span",
        d: {
          name: "POST /api/alerts",
          statusCode: "ERROR",
          attributes: {
            "code.filepath": "src/alerts/dispatch.ts",
            "code.lineno": 91,
          },
        },
      },
    ];
    expect(
      buildEvidenceCandidates(legacy, { start: 1000 }).find(
        (c) => c.detector === "otel_span_error",
      )?.anchor.frame,
    ).toBe("src/alerts/dispatch.ts:91");

    const recorded: BugEvent[] = [
      {
        t: 1000,
        k: "backend.otel.log",
        d: {
          body: "dispatch failed",
          severityText: "ERROR",
          attributes: {
            "exception.stacktrace":
              "Error: dispatch failed\n    at send (/srv/app/src/alerts/send.ts:44:9)",
          },
        },
      },
    ];
    expect(
      buildEvidenceCandidates(recorded, { start: 1000 }).find(
        (c) => c.detector === "otel_log_error",
      )?.anchor.frame,
    ).toBe("/srv/app/src/alerts/send.ts:44:9");
  });

  // recordException() puts the stacktrace on a span EVENT, not on the span, so
  // reading only span attributes left the common backend case frameless.
  it("anchors an OTel span error at its recorded exception span event", () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "backend.otel.span",
        d: {
          name: "POST /api/alerts",
          statusCode: "ERROR",
          serviceName: "job-engine",
          spanEvents: [
            {
              name: "exception",
              t: 1000,
              attributes: {
                "exception.type": "TypeError",
                "exception.stacktrace":
                  "TypeError: cannot read length\n    at dispatch (/srv/app/src/alerts/dispatch.ts:91:5)",
              },
            },
          ],
        },
      },
    ];
    const [candidate] = buildEvidenceCandidates(events, { start: 1000 }).filter(
      (c) => c.detector === "otel_span_error",
    );
    expect(candidate.anchor.frame).toBe("/srv/app/src/alerts/dispatch.ts:91:5");
  });

  it("prefers the span's own code attributes over a recorded exception", () => {
    // The span's code.* attributes describe the span itself; an exception event
    // may have been re-thrown from deeper. Attributes are the tighter answer.
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "backend.otel.span",
        d: {
          name: "POST /api/alerts",
          statusCode: "ERROR",
          attributes: {
            "code.file.path": "src/alerts/handler.ts",
            "code.line.number": 12,
          },
          spanEvents: [
            {
              name: "exception",
              attributes: {
                "exception.stacktrace":
                  "TypeError: x\n    at deep (/srv/app/src/other.ts:400:1)",
              },
            },
          ],
        },
      },
    ];
    const [candidate] = buildEvidenceCandidates(events, { start: 1000 }).filter(
      (c) => c.detector === "otel_span_error",
    );
    expect(candidate.anchor.frame).toBe("src/alerts/handler.ts:12");
  });

  it("leaves the OTel frame unset when a path carries no line number", () => {
    // A file with no line sends a reader to the top of a module, which is not a
    // starting point. Half a location must not read as a captured one.
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "backend.otel.span",
        d: {
          name: "POST /api/alerts",
          statusCode: "ERROR",
          attributes: { "code.file.path": "src/alerts/dispatch.ts" },
        },
      },
    ];
    const [candidate] = buildEvidenceCandidates(events, { start: 1000 }).filter(
      (c) => c.detector === "otel_span_error",
    );
    expect(candidate.anchor.frame).toBeUndefined();
  });
});
