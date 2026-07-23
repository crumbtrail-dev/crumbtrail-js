import { describe, expect, it } from "vitest";
import {
  recallLocal,
  sessionIssueProfile,
  tokenizeIssueText,
  type LocalIssueProfile,
  type RecallStore,
} from "../recall";

/**
 * Direct tests for the extracted recall engine. These exercise `recallLocal` /
 * `sessionIssueProfile` against an in-memory fake `RecallStore` — no JSON-RPC,
 * no MCP server, no filesystem — proving the seam is testable without transport.
 */

interface FakeBug {
  bugId: string;
  title: string;
  severity: string;
  firstSeen: number;
  lastSeen: number;
  requestIds?: string[];
  representative: {
    detector?: string;
    message?: string;
    route?: string;
  };
}

interface FakeSession {
  id: string;
  bundle: Record<string, unknown>;
  bugs: FakeBug[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Build an in-memory RecallStore from a list of fake sessions. */
function fakeStore(sessions: FakeSession[]): RecallStore {
  const byDir = new Map(sessions.map((s) => [s.id, s]));
  return {
    listSessions: async () => sessions.map((s) => ({ id: s.id, dir: s.id })),
    readJsonRecord: async (dir, name) => {
      if (name !== "llm.json") return undefined;
      const session = byDir.get(dir);
      return session
        ? ({ ...session.bundle, distinctBugs: session.bugs } as Record<
            string,
            unknown
          >)
        : undefined;
    },
    readDistinctBugs: async (dir) => byDir.get(dir)?.bugs ?? [],
    isDistinctBugRecord: (x) =>
      isRecord(x) &&
      typeof x.bugId === "string" &&
      typeof x.title === "string" &&
      typeof x.severity === "string" &&
      typeof x.firstSeen === "number" &&
      typeof x.lastSeen === "number" &&
      isRecord(x.representative),
  };
}

function bug(partial: Partial<FakeBug> & { bugId: string }): FakeBug {
  return {
    title: "Console error: Payment failed",
    severity: "medium",
    firstSeen: 1,
    lastSeen: 2,
    requestIds: [],
    representative: {
      detector: "console_error",
      message: "Payment failed: gateway timeout",
      route: "/checkout",
    },
    ...partial,
  };
}

describe("recallLocal (direct, in-memory store)", async () => {
  it("ranks a rhyming session above an unrelated one", async () => {
    const store = fakeStore([
      {
        id: "sess-a",
        bundle: { environment: { flags: { betaCheckout: true } } },
        bugs: [
          bug({
            bugId: "bug-a",
            representative: {
              detector: "console_error",
              message: "Payment failed: gateway timeout",
              route: "/checkout",
            },
          }),
        ],
      },
      {
        id: "sess-c",
        bundle: {},
        bugs: [
          bug({
            bugId: "bug-c",
            title: "Dashboard render timeout",
            representative: {
              detector: "otel_span_error",
              message: "Dashboard widget render timeout",
              route: "/dashboard",
            },
          }),
        ],
      },
    ]);

    const query: LocalIssueProfile = {
      tokens: tokenizeIssueText("Payment failed gateway timeout checkout"),
      route: "/checkout",
      errorFamily: "console_error",
      facetTokens: ["betaCheckout"],
    };

    const matches = await recallLocal(query, store, undefined, 5);
    expect(matches.map((m) => m.sessionId)).toEqual(["sess-a", "sess-c"]);
    expect(matches[0].reasons).toContain("same-route");
  });

  it("excludes the querying session", async () => {
    const store = fakeStore([
      { id: "sess-a", bundle: {}, bugs: [bug({ bugId: "bug-a" })] },
      { id: "sess-b", bundle: {}, bugs: [bug({ bugId: "bug-b" })] },
    ]);
    const query = (await sessionIssueProfile("sess-b", store))!;
    const matches = await recallLocal(query, store, "sess-b", 5);
    expect(matches.map((m) => m.sessionId)).toEqual(["sess-a"]);
  });

  it("dedupes by signature, keeping the highest-scoring occurrence", async () => {
    // Two sessions carry the same distinct bug (identical signature). Only one
    // entry should survive — the higher-scoring one (same env facet overlap).
    const shared = {
      title: "Console error: Payment failed",
      severity: "medium" as const,
      representative: {
        detector: "console_error",
        message: "Payment failed: gateway timeout",
        route: "/checkout",
      },
    };
    const store = fakeStore([
      {
        id: "sess-weak",
        bundle: {},
        bugs: [bug({ bugId: "bug-dup", ...shared })],
      },
      {
        id: "sess-strong",
        bundle: { environment: { flags: { betaCheckout: true } } },
        bugs: [bug({ bugId: "bug-dup", ...shared })],
      },
    ]);

    const query: LocalIssueProfile = {
      tokens: tokenizeIssueText("Payment failed gateway timeout checkout"),
      route: "/checkout",
      errorFamily: "console_error",
      facetTokens: ["betaCheckout"],
    };

    const matches = await recallLocal(query, store, undefined, 5);
    expect(matches).toHaveLength(1);
    expect(matches[0].sessionId).toBe("sess-strong");
    expect(matches[0].reasons).toContain("env-overlap");
  });

  it("merges digit-bearing route variants as one recurrence", async () => {
    const store = fakeStore(
      Array.from({ length: 5 }, (_, i) => ({
        id: `sess-${i}`,
        bundle: {},
        // Digit-bearing route variants identify the same phenomenon and must
        // share a recurrence signature.
        bugs: [
          bug({
            bugId: `bug-${i}`,
            representative: {
              detector: "console_error",
              message: "Payment failed: gateway timeout",
              route: `/checkout-${i}`,
            },
          }),
        ],
      })),
    );
    const query: LocalIssueProfile = {
      tokens: tokenizeIssueText("Payment failed gateway timeout"),
      facetTokens: [],
    };
    const matches = await recallLocal(query, store, undefined, 2);
    expect(matches).toHaveLength(1);
  });

  it("honours the limit across distinct recurrences", async () => {
    const store = fakeStore(
      ["cart", "catalog", "dashboard", "profile", "settings"].map(
        (route, i) => ({
          id: `sess-${i}`,
          bundle: {},
          bugs: [
            bug({
              bugId: `bug-${i}`,
              representative: {
                detector: "console_error",
                message: "Payment failed: gateway timeout",
                route: `/${route}`,
              },
            }),
          ],
        }),
      ),
    );
    const query: LocalIssueProfile = {
      tokens: tokenizeIssueText("Payment failed gateway timeout"),
      facetTokens: [],
    };
    const matches = await recallLocal(query, store, undefined, 2);
    expect(matches).toHaveLength(2);
  });

  it("drops zero-score candidates", async () => {
    const store = fakeStore([
      {
        id: "sess-unrelated",
        bundle: {},
        bugs: [
          bug({
            bugId: "bug-x",
            title: "Totally different",
            representative: {
              detector: "otel_span_error",
              message: "Dashboard render timeout",
              route: "/dashboard",
            },
          }),
        ],
      },
    ]);
    const query: LocalIssueProfile = {
      tokens: tokenizeIssueText("payment gateway checkout"),
      facetTokens: [],
    };
    const matches = await recallLocal(query, store, undefined, 5);
    expect(matches).toHaveLength(0);
  });
});

describe("sessionIssueProfile (direct)", () => {
  it("returns undefined when the session has no indexed bugs", async () => {
    const store = fakeStore([{ id: "empty", bundle: {}, bugs: [] }]);
    expect(await sessionIssueProfile("empty", store)).toBeUndefined();
  });

  it("seeds the profile from the strongest (highest-severity) bug", async () => {
    const store = fakeStore([
      {
        id: "sess",
        bundle: {},
        bugs: [
          bug({
            bugId: "low",
            severity: "low",
            representative: {
              detector: "console_error",
              message: "minor",
              route: "/low",
            },
          }),
          bug({
            bugId: "crit",
            severity: "critical",
            representative: {
              detector: "otel_span_error",
              message: "critical outage",
              route: "/critical",
            },
          }),
        ],
      },
    ]);
    const profile = await sessionIssueProfile("sess", store);
    expect(profile?.route).toBe("/critical");
    expect(profile?.errorFamily).toBe("otel_span_error");
  });
});
