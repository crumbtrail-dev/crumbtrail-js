import { describe, expect, it } from "vitest";
import { redactedNetworkBodySnippet } from "../network-body";

describe("redactedNetworkBodySnippet", () => {
  it("does not emit arbitrary legacy body-summary enum text", () => {
    const poisonedReason = "hunter2-secret-should-not-appear";
    const snippet = redactedNetworkBodySnippet(undefined, {
      kind: "legacy-kind",
      action: "legacy-action",
      reason: poisonedReason,
    });

    expect(snippet).toBe("body unavailable; (unknown); unknown; unknown");
    expect(snippet).not.toContain(poisonedReason);
  });
});
