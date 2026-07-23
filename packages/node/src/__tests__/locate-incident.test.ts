import { describe, expect, it, vi } from "vitest";
import type { Symptom } from "crumbtrail-core";
import {
  DEFAULT_MATCH_MARGIN,
  DEFAULT_MATCH_THRESHOLD,
  locateAndAssemble,
  locateEvidence,
  locateIncident,
  locatedEvidence,
  symptomProfile,
} from "../locate-incident";
import { tokenizeIssueText, type RecallStore } from "../recall";
import type { DistinctBug } from "../distinct-bugs";

/**
 * Direct tests for the incident-location engine over an in-memory fake
 * `RecallStore` — no JSON-RPC, no MCP server, no filesystem. Mirrors
 * recall.test.ts's fakeStore/bug pattern, extended with per-session index.json
 * (time) and meta.json (release) so the two bounded signals are exercisable.
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
  frontendEvidence?: unknown[];
  backendEvidence?: unknown[];
  dbDiffs?: unknown[];
}

interface FakeSession {
  id: string;
  bundle?: Record<string, unknown>;
  bugs: FakeBug[];
  index?: Record<string, unknown>;
  meta?: Record<string, unknown>;
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
      const session = byDir.get(dir);
      if (!session) return undefined;
      if (name === "llm.json")
        return { ...(session.bundle ?? {}), distinctBugs: session.bugs };
      if (name === "index.json") return session.index;
      if (name === "meta.json") return session.meta;
      return undefined;
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
    title: "Checkout failed span error",
    severity: "high",
    firstSeen: 1,
    lastSeen: 2,
    requestIds: [],
    representative: {
      detector: "console_error",
      message: "checkout failed span error",
      route: "/checkout",
    },
    ...partial,
  };
}

/** A symptom whose title/route/error-family strongly rhyme with the default bug. */
const strongSymptom: Symptom = {
  title: "checkout failed span error",
  url: "/checkout",
  errorSig: "console_error",
};

describe("symptomProfile", () => {
  it("maps title+description → tokens, url → route, errorSig → errorFamily, release → facetTokens", () => {
    const profile = symptomProfile({
      title: "Checkout fails",
      description: "500 on submit",
      url: "/checkout",
      errorSig: "net_5xx",
      release: "2.1.0",
    });
    expect(profile.route).toBe("/checkout");
    expect(profile.errorFamily).toBe("net_5xx");
    expect(profile.tokens).toContain("checkout");
    expect(profile.tokens).toContain("submit");
    expect(profile.facetTokens).toEqual(tokenizeIssueText("2.1.0"));
  });

  it("tolerates a bare title (no description/url/errorSig/release)", async () => {
    const profile = symptomProfile({ title: "boom" });
    expect(profile.tokens).toEqual(["boom"]);
    expect(profile.route).toBeUndefined();
    expect(profile.errorFamily).toBeUndefined();
    expect(profile.facetTokens).toEqual([]);
  });
});

describe("locateIncident — outcome", async () => {
  it("matches a strongly-rhyming session and returns a real sessionId + reasons", async () => {
    const store = fakeStore([
      { id: "sess-hit", bugs: [bug({ bugId: "bug-hit" })] },
    ]);
    const result = await locateIncident(strongSymptom, store, { now: 1_000 });
    expect(result.outcome).toBe("matched");
    const top = result.candidates[0];
    expect(top.confidence).toBeGreaterThanOrEqual(DEFAULT_MATCH_THRESHOLD);
    expect(top.reasons).toEqual(
      expect.arrayContaining(["semantic", "same-route", "same-error"]),
    );
    // Never fabricate a sessionId: every candidate id comes from listSessions().
    const ids = new Set(
      (await store.listSessions()).map((s) => s.id),
    );
    for (const candidate of result.candidates) {
      expect(ids.has(candidate.sessionId)).toBe(true);
    }
    expect(top.sessionId).toBe("sess-hit");
    expect(top.bugId).toBe("bug-hit");
  });

  it("is inconclusive and never promotes a below-threshold near-miss", async () => {
    // Weak text-only overlap, no route/error anchor → base < threshold.
    const store = fakeStore([
      {
        id: "sess-weak",
        bugs: [
          bug({
            bugId: "bug-weak",
            title: "Payment failed",
            representative: {
              detector: "console_error",
              message: "payment failed gateway timeout",
              route: "/checkout",
            },
          }),
        ],
      },
    ]);
    const result = await locateIncident({ title: "payment gateway" }, store, {
      now: 1_000,
    });
    expect(result.outcome).toBe("inconclusive");
    // The near-miss is still returned (visible), just never promoted to matched.
    expect(result.candidates.length).toBe(1);
    expect(result.candidates[0].confidence).toBeLessThan(
      DEFAULT_MATCH_THRESHOLD,
    );
  });

  it("returns no candidates when nothing has any base signal", async () => {
    const store = fakeStore([
      {
        id: "sess-unrelated",
        bugs: [
          bug({
            bugId: "bug-x",
            title: "Dashboard render timeout",
            representative: {
              detector: "otel_span_error",
              message: "dashboard widget render timeout",
              route: "/dashboard",
            },
          }),
        ],
      },
    ]);
    const result = await locateIncident({ title: "login redirect loop" }, store, {
      now: 1_000,
    });
    expect(result.outcome).toBe("inconclusive");
    expect(result.candidates).toEqual([]);
  });

  it("keeps similarly-scored candidates ambiguous and never adapts either session's evidence", async () => {
    const store = fakeStore([
      { id: "session-one", bugs: [bug({ bugId: "bug-one" })] },
      { id: "session-two", bugs: [bug({ bugId: "bug-two" })] },
    ]);

    const result = await locateIncident(strongSymptom, store, { now: 1_000 });
    expect(result.outcome).toBe("ambiguous");
    expect(result.candidates[0].confidence).toBeGreaterThanOrEqual(
      DEFAULT_MATCH_THRESHOLD,
    );
    expect(
      result.candidates[0].confidence - result.candidates[1].confidence,
    ).toBeLessThan(DEFAULT_MATCH_MARGIN);

    const located = await locateEvidence(strongSymptom, store, { now: 1_000 });
    expect(located.evidence).toEqual([]);
    expect(located.match.outcome).toBe("ambiguous");
    expect("sessionId" in located.match).toBe(false);
    expect(located.match.candidates).toEqual([
      expect.objectContaining({ sessionId: "session-one", bugId: "bug-one" }),
      expect.objectContaining({ sessionId: "session-two", bugId: "bug-two" }),
    ]);

    const assembled = await locateAndAssemble(strongSymptom, store, {
      now: 1_000,
      sources: [],
    });
    expect(assembled.bundle.evidence).toEqual([]);
    expect(assembled.bundle.located).toMatchObject({
      outcome: "ambiguous",
      method: "fuzzy",
      candidates: located.match.candidates,
    });
    expect(assembled.bundle.located?.sessionId).toBeUndefined();
    expect(assembled.bundle.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "no recorded session matched this symptom",
        }),
        expect.objectContaining({
          reason:
            "multiple candidate sessions scored within the decision margin; none is conclusive",
        }),
      ]),
    );
  });

  it("matches when the top candidate clears the decision margin", async () => {
    const store = fakeStore([
      { id: "session-strong", bugs: [bug({ bugId: "bug-strong" })] },
      {
        id: "session-weak",
        bugs: [
          bug({
            bugId: "bug-weak",
            title: "checkout alert",
            representative: {
              detector: "other_error",
              message: "checkout alert",
              route: "/other",
            },
          }),
        ],
      },
    ]);

    const result = await locateIncident(strongSymptom, store, { now: 1_000 });
    expect(result.outcome).toBe("matched");
    expect(result.candidates[0].sessionId).toBe("session-strong");
    expect(
      result.candidates[0].confidence - result.candidates[1].confidence,
    ).toBeGreaterThanOrEqual(DEFAULT_MATCH_MARGIN);
  });

  it("keeps matched and inconclusive match and located envelopes byte compatible", async () => {
    const matchedStore = fakeStore([
      { id: "session-matched", bugs: [bug({ bugId: "bug-matched" })] },
    ]);
    const matchedRanked = await locateIncident(strongSymptom, matchedStore, {
      now: 1_000,
    });
    const expectedMatchedMatch = {
      sessionId: "session-matched",
      confidence: matchedRanked.candidates[0].confidence,
      outcome: "matched" as const,
      reasons: matchedRanked.candidates[0].reasons,
    };
    expect(
      (await locateEvidence(strongSymptom, matchedStore, { now: 1_000 })).match,
    ).toStrictEqual(expectedMatchedMatch);
    const matchedAssembled = await locateAndAssemble(
      strongSymptom,
      matchedStore,
      { now: 1_000, sources: [] },
    );
    expect(matchedAssembled.match).toStrictEqual(expectedMatchedMatch);
    expect(matchedAssembled.bundle.located).toStrictEqual({
      ...expectedMatchedMatch,
      method: "fuzzy",
    });

    const inconclusiveSymptom = { title: "payment gateway" };
    const inconclusiveStore = fakeStore([
      {
        id: "session-near-miss",
        bugs: [
          bug({
            bugId: "bug-near-miss",
            title: "Payment failed",
            representative: {
              detector: "console_error",
              message: "payment failed gateway timeout",
              route: "/checkout",
            },
          }),
        ],
      },
    ]);
    const inconclusiveRanked = await locateIncident(
      inconclusiveSymptom,
      inconclusiveStore,
      { now: 1_000 },
    );
    const expectedInconclusiveMatch = {
      confidence: inconclusiveRanked.candidates[0].confidence,
      outcome: "inconclusive" as const,
      reasons: inconclusiveRanked.candidates[0].reasons,
    };
    expect(
      (
        await locateEvidence(inconclusiveSymptom, inconclusiveStore, {
          now: 1_000,
        })
      ).match,
    ).toStrictEqual(expectedInconclusiveMatch);
    const inconclusiveAssembled = await locateAndAssemble(
      inconclusiveSymptom,
      inconclusiveStore,
      { now: 1_000, sources: [] },
    );
    expect(inconclusiveAssembled.match).toStrictEqual(
      expectedInconclusiveMatch,
    );
    expect(inconclusiveAssembled.bundle.located).toStrictEqual({
      ...expectedInconclusiveMatch,
      method: "fuzzy",
    });
  });
});

describe("locateIncident — deterministic ranking", async () => {
  it("breaks equal-confidence ties by recency before bugId, independent of store order", async () => {
    const now = 1_000;
    // Both sessions get the same capped time boost. The more-recent one has a
    // later index timestamp but a bugId that would lose an alphabetical tie.
    const store = fakeStore([
      {
        id: "sess-older",
        bugs: [bug({ bugId: "bug-a" })],
        index: { end: now },
      },
      {
        id: "sess-newer",
        bugs: [bug({ bugId: "bug-z" })],
        index: { end: now + 1 },
      },
    ]);
    const result = await locateIncident(strongSymptom, store, { now });
    expect(result.candidates.map((c) => c.sessionId)).toEqual([
      "sess-newer",
      "sess-older",
    ]);
    // Confidences are exactly equal (tie really is a tie).
    expect(result.candidates[0].confidence).toBe(
      result.candidates[1].confidence,
    );
  });

  it("documents the >= threshold boundary (inclusive)", async () => {
    const store = fakeStore([{ id: "s1", bugs: [bug({ bugId: "bug-1" })] }]);
    // Read the exact top confidence (no timestamp → stable across calls).
    const probe = await locateIncident(strongSymptom, store, {
      now: 1_000,
      threshold: 0,
    });
    const s = probe.candidates[0].confidence;
    // Exactly at the bar → matched (>=).
    expect(
      (await locateIncident(strongSymptom, store, { now: 1_000, threshold: s }))
        .outcome,
    ).toBe("matched");
    // Strictly above the top score → inconclusive.
    expect(
      (
        await locateIncident(strongSymptom, store, {
          now: 1_000,
          threshold: s + 1e-9,
        })
      ).outcome,
    ).toBe("inconclusive");
  });
});

describe("locateIncident — account narrowing", async () => {
  it("drops a higher scoring known foreign account before ranking while retaining unknown accounts", async () => {
    const store = fakeStore([
      {
        id: "session-foreign",
        bugs: [bug({ bugId: "bug-foreign" })],
        meta: { identity: { accountId: "account-foreign" } },
      },
      {
        id: "session-target",
        bugs: [
          bug({
            bugId: "bug-target",
            title: "checkout failed",
            representative: {
              detector: "console_error",
              message: "checkout failed",
              route: "/checkout",
            },
          }),
        ],
        index: { account_id: "account-target" },
      },
      {
        id: "session-unknown",
        bugs: [
          bug({
            bugId: "bug-unknown",
            title: "checkout",
            representative: {
              detector: "other_error",
              message: "checkout",
              route: "/other",
            },
          }),
        ],
      },
    ]);

    const unfiltered = await locateIncident(strongSymptom, store, { now: 1_000 });
    const targetWithoutNarrowing = unfiltered.candidates.find(
      (candidate) => candidate.sessionId === "session-target",
    );
    expect(unfiltered.candidates[0].sessionId).toBe("session-foreign");
    expect(unfiltered.candidates[0].confidence).toBeGreaterThan(
      targetWithoutNarrowing!.confidence,
    );

    const result = await locateIncident(strongSymptom, store, {
      now: 1_000,
      accountId: "account-target",
    });

    expect(result.outcome).toBe("matched");
    expect(result.candidates.map((candidate) => candidate.sessionId)).toEqual([
      "session-target",
      "session-unknown",
    ]);
    expect(result.candidates[0].sessionId).toBe("session-target");
  });
});

describe("locateIncident — calibration logging", async () => {
  it("logs the numeric top score and achieved margin for matched and ambiguous results", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    try {
      const matched = await locateIncident(
        strongSymptom,
        fakeStore([{ id: "session-only", bugs: [bug({ bugId: "bug-only" })] }]),
        { now: 1_000 },
      );
      const ambiguous = await locateIncident(
        strongSymptom,
        fakeStore([
          { id: "session-one", bugs: [bug({ bugId: "bug-one" })] },
          { id: "session-two", bugs: [bug({ bugId: "bug-two" })] },
        ]),
        { now: 1_000 },
      );
      const lines = stderr.mock.calls.map(([chunk]) =>
        JSON.parse(String(chunk)) as Record<string, unknown>,
      );

      expect(lines[0]).toMatchObject({
        outcome: "matched",
        score: matched.candidates[0].confidence,
        margin: matched.candidates[0].confidence,
      });
      expect(lines[1]).toMatchObject({
        outcome: "ambiguous",
        score: ambiguous.candidates[0].confidence,
        margin:
          ambiguous.candidates[0].confidence -
          ambiguous.candidates[1].confidence,
      });
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("locateIncident — bounded refinement signals", () => {
  it("prefers the more recent session and labels it time-proximity", async () => {
    const now = 1_000_000_000_000;
    const day = 24 * 60 * 60 * 1000;
    const store = fakeStore([
      {
        id: "sess-old",
        bugs: [bug({ bugId: "bug-old" })],
        index: { end: now - 30 * day },
      },
      {
        id: "sess-recent",
        bugs: [bug({ bugId: "bug-recent" })],
        index: { end: now },
      },
    ]);
    const result = await locateIncident(strongSymptom, store, { now });
    expect(result.candidates[0].sessionId).toBe("sess-recent");
    expect(result.candidates[0].reasons).toContain("time-proximity");
    expect(result.candidates[1].reasons).not.toContain("time-proximity");
    expect(result.candidates[0].confidence).toBeGreaterThan(
      result.candidates[1].confidence,
    );
  });

  it("prefers the session on the ticket's release and labels it release-hint", async () => {
    const store = fakeStore([
      {
        id: "sess-other-release",
        bugs: [bug({ bugId: "bug-other" })],
        meta: { release: "9.9.9" },
      },
      {
        id: "sess-match-release",
        bugs: [bug({ bugId: "bug-match" })],
        meta: { release: "1.2.3" },
      },
    ]);
    const result = await locateIncident(
      { ...strongSymptom, release: "1.2.3" },
      store,
      { now: 1_000 },
    );
    expect(result.candidates[0].sessionId).toBe("sess-match-release");
    expect(result.candidates[0].reasons).toContain("release-hint");
    expect(result.candidates[1].reasons).not.toContain("release-hint");
  });

  it("reads release from releaseId / version too", async () => {
    const store = fakeStore([
      {
        id: "sess-versioned",
        bugs: [bug({ bugId: "bug-v" })],
        meta: { version: "4.5.6" },
      },
    ]);
    const result = await locateIncident(
      { ...strongSymptom, release: "4.5.6" },
      store,
      { now: 1_000 },
    );
    expect(result.candidates[0].reasons).toContain("release-hint");
  });
});

describe("locateIncident — logging", () => {
  it("writes one structured JSON line to stderr (not stdout)", async () => {
    const store = fakeStore([{ id: "s1", bugs: [bug({ bugId: "b1" })] }]);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const result = await locateIncident(strongSymptom, store, { now: 1_000 });
      expect(stderrSpy).toHaveBeenCalledTimes(1);
      expect(stdoutSpy).not.toHaveBeenCalled();
      const line = String(stderrSpy.mock.calls[0][0]);
      const parsed = JSON.parse(line);
      expect(parsed.event).toBe("locate-incident");
      expect(parsed.outcome).toBe("matched");
      expect(parsed.score).toBe(result.candidates[0].confidence);
      expect(parsed.margin).toBe(result.candidates[0].confidence);
      expect(Array.isArray(parsed.candidates)).toBe(true);
    } finally {
      stderrSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });
});

describe("locatedEvidence — no-baseline adapter", () => {
  it("maps frontend→browser, backend→network, dbDiffs→db with single-sided values", () => {
    const located = {
      bugId: "bug-1",
      frontendEvidence: [
        {
          candidateId: "f1",
          detector: "console_error",
          t: 10,
          message: "boom",
          route: "/x",
        },
      ],
      backendEvidence: [
        {
          candidateId: "b1",
          detector: "otel_span_error",
          t: 20,
          requestId: "req-9",
          message: "span failed",
        },
      ],
      dbDiffs: [
        {
          candidateId: "d1",
          detector: "db_mutation",
          t: 30,
          requestId: "req-9",
          message: "row changed",
        },
      ],
    } as unknown as DistinctBug;

    const items = locatedEvidence(located, "sess-z");
    expect(items).toHaveLength(3);
    const [fe, be, de] = items;

    expect(fe.lane).toBe("browser");
    expect(fe.id).toBe("f1");
    expect(fe.kind).toBe("console_error");
    expect(fe.ref).toEqual({ sessionId: "sess-z" });
    expect(fe.before).toBeUndefined();
    expect(fe.after).toBe("boom");
    expect(fe.brief).toContain("boom");
    expect(fe.whenObserved).toBe(10);

    expect(be.lane).toBe("network");
    expect(be.ref).toEqual({ sessionId: "sess-z", requestId: "req-9" });
    expect(be.after).toBe("span failed");
    expect(be.whenObserved).toBe(20);

    expect(de.lane).toBe("db");
    expect(de.ref).toEqual({ sessionId: "sess-z", requestId: "req-9" });
    expect(de.whenObserved).toBe(30);
  });

  it("tolerates a bug with missing/empty evidence arrays", () => {
    const located = { bugId: "bug-empty" } as unknown as DistinctBug;
    expect(locatedEvidence(located, "sess-z")).toEqual([]);
  });
});
