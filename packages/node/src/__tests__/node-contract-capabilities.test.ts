import { describe, expect, it } from "vitest";

import { NODE_CONTRACT_CAPABILITIES } from "../node-contract-capabilities";
import * as packageIndex from "../index";

describe("NODE_CONTRACT_CAPABILITIES", () => {
  it("declares the tenant context factory capability", () => {
    expect(NODE_CONTRACT_CAPABILITIES.tenantContextFactory).toBe(true);
  });

  it("declares the ticket comment capability", () => {
    expect(NODE_CONTRACT_CAPABILITIES.ticketComment).toBe(true);
  });

  it("is re-exported from the package index", () => {
    // The cloud probes this package through a namespace import and reads the
    // marker off the index, so the re-export is the contract, not a detail.
    expect(packageIndex.NODE_CONTRACT_CAPABILITIES).toBe(
      NODE_CONTRACT_CAPABILITIES,
    );
    expect(packageIndex.NODE_CONTRACT_CAPABILITIES).toEqual({
      tenantContextFactory: true,
      ticketComment: true,
    });
  });

  it("reads exactly true for each capability the cloud gates on", () => {
    // The cloud accepts `=== true` only; a truthy value would fail closed.
    for (const capability of ["tenantContextFactory", "ticketComment"] as const) {
      expect(packageIndex.NODE_CONTRACT_CAPABILITIES[capability]).toBe(true);
    }
  });
});
