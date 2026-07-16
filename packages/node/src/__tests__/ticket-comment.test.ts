import { describe, expect, it } from "vitest";
import { buildAdvisoryComment } from "../ticket/comment";

const BUNDLE_URL =
  "https://app.crumbtrail.dev/api/bundles/bnd_deadbeef01234567";
const SESSION_URL_BASE = "https://app.crumbtrail.dev/sessions";

function text(comment: { paragraphs: readonly string[] }): string {
  return comment.paragraphs.join("\n");
}

describe("buildAdvisoryComment", () => {
  it("renders a matched comment with a display percentage, reasons, and link", () => {
    const doc = buildAdvisoryComment({
      match: {
        outcome: "matched",
        confidence: 0.724,
        reasons: ["title overlap", "route /api/checkout"],
      },
      bundleUrl: BUNDLE_URL,
    });

    const rendered = text(doc);
    // Rounded percentage is display-only (0.724 -> 72%).
    expect(rendered).toContain("72%");
    expect(rendered).toContain("advisory");
    expect(rendered).toContain("title overlap");
    expect(rendered).toContain("route /api/checkout");
    // Advisory framing: no verdict language.
    expect(rendered.toLowerCase()).not.toContain("verified");
    expect(rendered.toLowerCase()).not.toContain("fixed");
    // Link always present and pointing at the bundle.
    expect(rendered).toContain(BUNDLE_URL);
  });

  it("humanizes known reason codes and passes unknown codes through", () => {
    const doc = buildAdvisoryComment({
      match: {
        outcome: "matched",
        confidence: 0.62,
        reasons: [
          "semantic",
          "same-route",
          "same-error",
          "time-proximity",
          "release-hint",
          "env-overlap",
          "some-future-free-text",
        ],
      },
      bundleUrl: BUNDLE_URL,
    });
    const rendered = text(doc);
    // Every known internal code is rendered as a plain-language phrase…
    expect(rendered).toContain("wording overlap with the captured incident");
    expect(rendered).toContain("same route");
    expect(rendered).toContain("same error signature");
    expect(rendered).toContain("occurred near the report time");
    expect(rendered).toContain("same release");
    expect(rendered).toContain("shared environment or configuration");
    // …the raw codes never surface…
    expect(rendered).not.toContain("semantic");
    expect(rendered).not.toContain("same-route");
    expect(rendered).not.toContain("time-proximity");
    // …and an unknown/free-text reason passes through verbatim.
    expect(rendered).toContain("some-future-free-text");
  });

  it("carries correlation keys into a matched comment (deduped, capped at 3)", () => {
    const doc = buildAdvisoryComment({
      match: { outcome: "matched", confidence: 0.6 },
      bundleUrl: BUNDLE_URL,
      correlation: {
        sessionId: "sess-incident-01",
        // Duplicates and an over-cap 4th id: only 3 distinct survive.
        requestIds: ["req-a", "req-a", "req-b", "req-c", "req-d"],
      },
    });
    const rendered = text(doc);
    expect(rendered).toContain("Correlation keys");
    expect(rendered).toContain("sess-incident-01");
    expect(rendered).toContain("req-a");
    expect(rendered).toContain("req-b");
    expect(rendered).toContain("req-c");
    // Capped at 3 request ids — the 4th distinct id is dropped.
    expect(rendered).not.toContain("req-d");
  });

  it("never renders correlation keys on an inconclusive comment, even if passed", () => {
    // Correlation keys are a matched-only signal; an inconclusive result must
    // never carry them (nothing was located to correlate against).
    const doc = buildAdvisoryComment({
      match: { outcome: "inconclusive", confidence: 0 },
      bundleUrl: BUNDLE_URL,
      correlation: { sessionId: "sess-x", requestIds: ["req-x"] },
    });
    const rendered = text(doc);
    expect(rendered).not.toContain("Correlation keys");
    expect(rendered).not.toContain("sess-x");
    expect(rendered).not.toContain("req-x");
  });

  it("renders an inconclusive comment from gaps only, with no fabricated match", () => {
    const doc = buildAdvisoryComment({
      match: { outcome: "inconclusive", confidence: 0 },
      bundleUrl: BUNDLE_URL,
      gaps: [
        {
          lane: "network",
          reason: "no recorded session matched this symptom",
          suggestion: "widen capture",
        },
      ],
    });

    const rendered = text(doc);
    expect(rendered).toContain("could not locate");
    expect(rendered).toContain("no recorded session matched this symptom");
    expect(rendered).toContain("widen capture");
    // No confidence percentage is fabricated for an inconclusive result.
    expect(rendered).not.toContain("%");
    // Link still present.
    expect(rendered).toContain(BUNDLE_URL);
  });

  it("renders an inconclusive comment even with zero gaps and still links the bundle", () => {
    const doc = buildAdvisoryComment({
      match: { outcome: "inconclusive", confidence: 0.4 },
      bundleUrl: BUNDLE_URL,
      gaps: [],
    });

    const rendered = text(doc);
    expect(rendered).toContain("could not locate");
    expect(rendered).toContain(BUNDLE_URL);
  });

  it("renders an ambiguous comment with candidates and no claim about one session", () => {
    const doc = buildAdvisoryComment({
      match: {
        outcome: "ambiguous",
        confidence: 0.81,
        candidates: [
          { sessionId: "sessionAlpha", confidence: 0.81 },
          { sessionId: "sessionBeta", confidence: 0.74 },
        ],
      },
      bundleUrl: BUNDLE_URL,
      sessionUrlBase: SESSION_URL_BASE,
      gaps: [
        {
          lane: "network",
          reason: "multiple candidate sessions are close",
          suggestion: "review the recorded evidence",
        },
      ],
    });

    const rendered = text(doc);
    expect(rendered).toContain(
      "Crumbtrail found 2 candidate sessions for this ticket but none is conclusive.",
    );
    expect(rendered).toContain(
      "Candidate session: https://app.crumbtrail.dev/sessions/sessionAlpha (confidence 81%)",
    );
    expect(rendered).toContain(
      "Candidate session: https://app.crumbtrail.dev/sessions/sessionBeta (confidence 74%)",
    );
    expect(rendered).toContain("What is missing:");
    expect(rendered).toContain("Review the candidates before acting.");
    expect(rendered).toContain(BUNDLE_URL);
    expect(rendered.toLowerCase()).not.toContain("matched");
    expect(rendered.toLowerCase()).not.toContain("verdict");
    expect(rendered).not.toContain("-");
  });

  it("falls back to a candidate session id when no session URL base is available", () => {
    const doc = buildAdvisoryComment({
      match: {
        outcome: "ambiguous",
        confidence: 0.81,
        candidates: [{ sessionId: "sessionAlpha", confidence: 0.81 }],
      },
      bundleUrl: BUNDLE_URL,
    });

    expect(text(doc)).toContain(
      "Candidate session: sessionAlpha (confidence 81%)",
    );
  });

  it("never equality-compares the confidence float (only a rounded display %)", () => {
    // Two distinct floats that round to the same percentage must produce the same
    // displayed percentage — proving the float is used only for display.
    const a = buildAdvisoryComment({
      match: { outcome: "matched", confidence: 0.7249 },
      bundleUrl: BUNDLE_URL,
    });
    const b = buildAdvisoryComment({
      match: { outcome: "matched", confidence: 0.7151 },
      bundleUrl: BUNDLE_URL,
    });
    expect(text(a)).toContain("72%");
    expect(text(b)).toContain("72%");
  });

  it("clamps an out-of-range confidence to a sane percentage", () => {
    const doc = buildAdvisoryComment({
      match: { outcome: "matched", confidence: 1.4 },
      bundleUrl: BUNDLE_URL,
    });
    expect(text(doc)).toContain("100%");
  });
});
