import { describe, expect, it } from "vitest";
import { buildAdvisoryComment } from "../ticket/comment";
import type { AdfNode } from "../ticket/comment";

const BUNDLE_URL =
  "https://app.crumbtrail.ai/api/bundles/bnd_deadbeef01234567";

/** Recursively collect every `text` string in an ADF tree. */
function allText(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const here = typeof record.text === "string" ? [record.text] : [];
  const children = Array.isArray(record.content)
    ? record.content.flatMap((child) => allText(child))
    : [];
  return [...here, ...children];
}

/** Collect every link href in an ADF tree. */
function allHrefs(node: unknown): string[] {
  if (!node || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  const marks = Array.isArray(record.marks) ? record.marks : [];
  const here = marks
    .filter(
      (mark): mark is AdfNode =>
        !!mark && typeof mark === "object" && (mark as AdfNode).type === "link",
    )
    .map((mark) => (mark.attrs as { href?: string })?.href ?? "");
  const children = Array.isArray(record.content)
    ? record.content.flatMap((child) => allHrefs(child))
    : [];
  return [...here, ...children];
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

    expect(doc).toMatchObject({ version: 1, type: "doc" });
    const text = allText(doc).join("\n");
    // Rounded percentage is display-only (0.724 -> 72%).
    expect(text).toContain("72%");
    expect(text).toContain("advisory");
    expect(text).toContain("title overlap");
    expect(text).toContain("route /api/checkout");
    // Advisory framing: no verdict language.
    expect(text.toLowerCase()).not.toContain("verified");
    expect(text.toLowerCase()).not.toContain("fixed");
    // Link always present and pointing at the bundle.
    expect(allHrefs(doc)).toContain(BUNDLE_URL);
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
    const text = allText(doc).join("\n");
    // Every known internal code is rendered as a plain-language phrase…
    expect(text).toContain("wording overlap with the captured incident");
    expect(text).toContain("same route");
    expect(text).toContain("same error signature");
    expect(text).toContain("occurred near the report time");
    expect(text).toContain("same release");
    expect(text).toContain("shared environment or configuration");
    // …the raw codes never surface…
    expect(text).not.toContain("semantic");
    expect(text).not.toContain("same-route");
    expect(text).not.toContain("time-proximity");
    // …and an unknown/free-text reason passes through verbatim.
    expect(text).toContain("some-future-free-text");
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
    const text = allText(doc).join("\n");
    expect(text).toContain("Correlation keys");
    expect(text).toContain("sess-incident-01");
    expect(text).toContain("req-a");
    expect(text).toContain("req-b");
    expect(text).toContain("req-c");
    // Capped at 3 request ids — the 4th distinct id is dropped.
    expect(text).not.toContain("req-d");
  });

  it("never renders correlation keys on an inconclusive comment, even if passed", () => {
    // Correlation keys are a matched-only signal; an inconclusive result must
    // never carry them (nothing was located to correlate against).
    const doc = buildAdvisoryComment({
      match: { outcome: "inconclusive", confidence: 0 },
      bundleUrl: BUNDLE_URL,
      correlation: { sessionId: "sess-x", requestIds: ["req-x"] },
    });
    const text = allText(doc).join("\n");
    expect(text).not.toContain("Correlation keys");
    expect(text).not.toContain("sess-x");
    expect(text).not.toContain("req-x");
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

    const text = allText(doc).join("\n");
    expect(text).toContain("could not locate");
    expect(text).toContain("no recorded session matched this symptom");
    expect(text).toContain("widen capture");
    // No confidence percentage is fabricated for an inconclusive result.
    expect(text).not.toContain("%");
    // Link still present.
    expect(allHrefs(doc)).toContain(BUNDLE_URL);
  });

  it("renders an inconclusive comment even with zero gaps and still links the bundle", () => {
    const doc = buildAdvisoryComment({
      match: { outcome: "inconclusive", confidence: 0.4 },
      bundleUrl: BUNDLE_URL,
      gaps: [],
    });

    const text = allText(doc).join("\n");
    expect(text).toContain("could not locate");
    expect(allHrefs(doc)).toContain(BUNDLE_URL);
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
    expect(allText(a).join("\n")).toContain("72%");
    expect(allText(b).join("\n")).toContain("72%");
  });

  it("clamps an out-of-range confidence to a sane percentage", () => {
    const doc = buildAdvisoryComment({
      match: { outcome: "matched", confidence: 1.4 },
      bundleUrl: BUNDLE_URL,
    });
    expect(allText(doc).join("\n")).toContain("100%");
  });
});
