import { describe, expect, it } from "vitest";

import { NODE_CONTRACT_CAPABILITIES } from "../node-contract-capabilities";
import * as packageIndex from "../index";
import { createServer } from "../server";
import type { EvidenceSource } from "../evidence-sources/registry";
import type { CommentingTicketConnector, TicketComment } from "../ticket/clients";

/**
 * The marker tells the hosted cloud that this package implements a contract.
 * Asserting the marker's own literals only restates the marker, so it cannot
 * catch the failure that matters: the marker still reading true after the
 * implementation behind it changed shape. The cloud gates real code paths on
 * these keys and fails OPEN if the marker lies.
 *
 * So the assertions below are STATIC. Each capability is pinned to the actual
 * exported signature, mirrored byte for byte from the cloud's own contract in
 * packages/cloud/src/node-contract.ts. If either side drifts, `tsc --noEmit`
 * fails here rather than the cloud discovering it at runtime.
 */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

// --- Mirrors of the cloud's contract (packages/cloud/src/node-contract.ts) ---

type CloudTenantEvidenceSourcesFactory = (ctx: {
  tenantId?: string;
  projectId?: string;
}) => EvidenceSource[] | undefined | Promise<EvidenceSource[] | undefined>;

interface CloudTicketComment {
  paragraphs: readonly string[];
}

// --- What this package actually exports ---

type NodeEvidenceSourcesFactory = NonNullable<
  Parameters<typeof createServer>[0]["evidenceSourcesFactory"]
>;

type NodePostCommentComment = Parameters<
  CommentingTicketConnector["postComment"]
>[1];

// --- Static enforcement of each declared capability ---

// tenantContextFactory: createServer must accept the cloud's factory, ctx shape
// and all. Reverting the ctx parameter or the awaited return type breaks this.
const tenantContextFactoryIsImplemented: Exact<
  NodeEvidenceSourcesFactory,
  CloudTenantEvidenceSourcesFactory
> = true;

// The cloud hands its factory straight to createServer; prove that assignment
// compiles rather than only that the two types look alike.
const cloudFactory: CloudTenantEvidenceSourcesFactory = async ({
  tenantId,
  projectId,
}) => {
  void tenantId;
  void projectId;
  return undefined;
};
const cloudFactoryIsAcceptedByCreateServer: NodeEvidenceSourcesFactory =
  cloudFactory;

// ticketComment: postComment must take the provider neutral TicketComment, and
// TicketComment must still be exactly { paragraphs: readonly string[] }.
const ticketCommentIsImplemented: Exact<TicketComment, CloudTicketComment> =
  true;
const postCommentAcceptsTicketComment: Exact<
  NodePostCommentComment,
  TicketComment
> = true;

describe("NODE_CONTRACT_CAPABILITIES", () => {
  it("backs tenantContextFactory with a createServer that takes the cloud's ctx", () => {
    // Enforced by tsc above; asserted here so the intent is visible in the run.
    expect(tenantContextFactoryIsImplemented).toBe(true);
    expect(cloudFactoryIsAcceptedByCreateServer).toBe(cloudFactory);
    expect(NODE_CONTRACT_CAPABILITIES.tenantContextFactory).toBe(true);
  });

  it("backs ticketComment with a postComment that takes a TicketComment", () => {
    expect(ticketCommentIsImplemented).toBe(true);
    expect(postCommentAcceptsTicketComment).toBe(true);
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
