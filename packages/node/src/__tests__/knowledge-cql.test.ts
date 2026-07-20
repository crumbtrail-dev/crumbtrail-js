import { describe, expect, it } from "vitest";
import {
  buildSpecSearchCql,
  sanitizeCqlText,
  sanitizeSpaceKeys,
} from "../knowledge/cql";
import {
  isHardKnowledgeGap,
  KNOWLEDGE_GAP_LANE,
  knowledgeGap,
  type KnowledgeGapKind,
} from "../knowledge/gaps";
import {
  deriveAgeDays,
  KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeResult,
} from "../knowledge/types";

const DAY = 86_400_000;

describe("buildSpecSearchCql clause order", () => {
  it("emits the documented clause order without an allowlist", () => {
    const built = buildSpecSearchCql({ query: "checkout retries" });
    expect(built).toEqual({
      ok: true,
      cql: 'text ~ "checkout retries" AND type = page ORDER BY lastModified DESC',
      sanitizedQuery: "checkout retries",
      spaceKeys: [],
    });
  });

  it("appends the allowlist clause between type and ORDER BY", () => {
    const built = buildSpecSearchCql({
      query: "checkout retries",
      spaceKeys: ["ENG", "OPS"],
    });
    expect(built.ok).toBe(true);
    expect(built.ok && built.cql).toBe(
      'text ~ "checkout retries" AND type = page AND space.key IN ("ENG", "OPS") ORDER BY lastModified DESC',
    );
  });

  it("omits the allowlist clause entirely when empty or fully invalid", () => {
    for (const spaceKeys of [[], ["", "  "], ['A") OR type=page']]) {
      const built = buildSpecSearchCql({ query: "retries", spaceKeys });
      expect(built.ok).toBe(true);
      expect(built.ok && built.cql).not.toContain("space.key");
      expect(built.ok && built.cql).toBe(
        'text ~ "retries" AND type = page ORDER BY lastModified DESC',
      );
    }
  });

  it("is pure — identical input yields an identical string", () => {
    const a = buildSpecSearchCql({ query: "same", spaceKeys: ["ENG"] });
    const b = buildSpecSearchCql({ query: "same", spaceKeys: ["ENG"] });
    expect(a).toEqual(b);
  });
});

describe("sanitizeCqlText injection resistance", () => {
  const cases: Array<{ name: string; raw: string; expected: string }> = [
    { name: "embedded double-quote", raw: 'why "retry" fires', expected: "why retry fires" },
    { name: "backslash escape attempt", raw: 'retry\\" AND type = page', expected: "retry AND type = page" },
    // `--` is also stripped now: `-` is a Lucene reserved character.
    { name: "paren break-out", raw: 'x") OR type=page ORDER BY id ASC --', expected: "x OR type=page ORDER BY id ASC" },
    { name: "regex slash", raw: "checkout /api/retry endpoint", expected: "checkout apiretry endpoint" },
    { name: "wildcards", raw: "retry* flo?w", expected: "retry flow" },
    { name: "malformed fuzzy", raw: "retry~~ fire", expected: "retry fire" },
    { name: "boost operator", raw: "retry^10 flow", expected: "retry10 flow" },
    { name: "field colon", raw: "type:page retry", expected: "typepage retry" },
    { name: "lucene booleans", raw: "retry && flow || fail !bad +must", expected: "retry flow fail bad must" },
    { name: "newline injection", raw: "retry\nAND type = blogpost", expected: "retry AND type = blogpost" },
    { name: "carriage return + tab", raw: "retry\r\n\tflow", expected: "retry flow" },
    { name: "space.key smuggling", raw: 'x" AND space.key IN ("SECRET"', expected: "x AND space.key IN SECRET" },
    { name: "curly double-quote lookalikes", raw: "why “retry” fires", expected: "why retry fires" },
    { name: "curly single-quote lookalikes", raw: "it’s ‘retry’ logic", expected: "its retry logic" },
    { name: "fullwidth quote lookalike", raw: "retry＂ AND type = page", expected: "retry AND type = page" },
    { name: "prime lookalike", raw: "retry″ AND type = page", expected: "retry AND type = page" },
    { name: "bracket and brace stripping", raw: "retry [a] {b}", expected: "retry a b" },
    { name: "null byte", raw: "retry\u0000flow", expected: "retry flow" },
  ];

  for (const { name, raw, expected } of cases) {
    it(`neutralizes ${name}`, () => {
      const sanitized = sanitizeCqlText(raw);
      expect(sanitized).toBe(expected);
      expect(sanitized).not.toMatch(/["'\\()[\]{}+\-!^~*?:/]|&&|\|\|/);
      // eslint-disable-next-line no-control-regex -- asserting control chars are gone
      expect(sanitized).not.toMatch(/[\u0000-\u001F\u007F]/);
    });
  }

  it("keeps every sanitized term inside the quoted literal", () => {
    for (const { raw } of cases) {
      const built = buildSpecSearchCql({ query: raw });
      expect(built.ok).toBe(true);
      if (!built.ok) continue;
      // Exactly two double-quotes: the ones this builder opened and closed.
      expect(built.cql.match(/"/g)).toHaveLength(2);
      expect(built.cql.endsWith(" ORDER BY lastModified DESC")).toBe(true);
      // Nothing escaped out of the literal into a second clause.
      expect(built.cql.split('"')[2]).toBe(
        " AND type = page ORDER BY lastModified DESC",
      );
    }
  });

  it("collapses whitespace runs and trims", () => {
    expect(sanitizeCqlText("  retry   flow  ")).toBe("retry flow");
  });

  it("caps the term length", () => {
    expect(sanitizeCqlText("a".repeat(4000))).toHaveLength(512);
  });

  it("strips quote lookalikes a folding layer would produce", () => {
    // Modifier letters, primes, Hebrew geresh/gershayim, ornaments, ditto.
    const raw = "aʺbʼcʻdˮe׳f״g‴h‷i❛j❞k〃l⹂m";
    expect(sanitizeCqlText(raw)).toBe("abcdefghijklm");
  });
});

describe("code-point-safe truncation", () => {
  it("never cuts an astral character in half at the boundary", () => {
    // "a" x511 + emoji: a UTF-16 slice(0, 512) would leave a lone high surrogate.
    const sanitized = sanitizeCqlText("a".repeat(511) + "\u{1F600}");
    expect(Array.from(sanitized)).toHaveLength(512);
    expect(sanitized.endsWith("\u{1F600}")).toBe(true);
    expect(sanitized).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("emits CQL that encodeURIComponent accepts (documented as URL-ready)", () => {
    for (const raw of [
      "a".repeat(511) + "\u{1F600}",
      "a".repeat(512) + "\u{1F600}",
      "\u{1F600}".repeat(600),
      "b".repeat(510) + "\u{1F4A9}\u{1F4A9}",
    ]) {
      const built = buildSpecSearchCql({ query: raw });
      expect(built.ok).toBe(true);
      if (!built.ok) continue;
      expect(() => encodeURIComponent(built.cql)).not.toThrow();
      expect(Array.from(built.sanitizedQuery).length).toBeLessThanOrEqual(512);
    }
  });
});

describe("empty and whitespace-only queries", () => {
  for (const raw of ["", "   ", "\n\t ", '""', "()", "“”"]) {
    it(`rejects ${JSON.stringify(raw)} as empty-query`, () => {
      expect(sanitizeCqlText(raw)).toBe("");
      expect(buildSpecSearchCql({ query: raw })).toEqual({
        ok: false,
        reason: "empty-query",
      });
    });
  }
});

describe("sanitizeSpaceKeys", () => {
  it("keeps valid keys, preserves order, dedupes case-sensitively", () => {
    expect(sanitizeSpaceKeys(["ENG", "ops_2", "ENG", "eng"])).toEqual([
      "ENG",
      "ops_2",
      "eng",
    ]);
  });

  it("drops keys carrying CQL structure rather than escaping them", () => {
    expect(
      sanitizeSpaceKeys([
        'ENG") OR type=page --',
        "ENG OPS",
        "ENG-1",
        "ENG.KEY",
        "",
        "  ",
      ]),
    ).toEqual([]);
  });

  it("trims surrounding whitespace on otherwise valid keys", () => {
    expect(sanitizeSpaceKeys(["  ENG  "])).toEqual(["ENG"]);
  });

  it("caps the allowlist length", () => {
    const many = Array.from({ length: 120 }, (_, i) => `S${i}`);
    expect(sanitizeSpaceKeys(many)).toHaveLength(50);
  });
});

describe("knowledge gap vocabulary", () => {
  const hard: KnowledgeGapKind[] = [
    "not-configured",
    "auth-failed",
    "timeout",
    "request-failed",
  ];
  const informational: KnowledgeGapKind[] = ["no-results", "empty-query"];

  for (const kind of hard) {
    it(`marks ${kind} as source-unavailable`, () => {
      const gap = knowledgeGap({ kind, reason: `confluence ${kind}` });
      expect(gap.kind).toBe("source-unavailable");
      expect(isHardKnowledgeGap(kind)).toBe(true);
    });
  }

  for (const kind of informational) {
    it(`leaves ${kind} as an informational gap`, () => {
      const gap = knowledgeGap({ kind, reason: `confluence ${kind}` });
      expect(gap.kind).toBeUndefined();
      expect("kind" in gap).toBe(false);
      expect(isHardKnowledgeGap(kind)).toBe(false);
    });
  }

  it("uses the code lane and adds no new EvidenceLane value (D4)", () => {
    expect(KNOWLEDGE_GAP_LANE).toBe("code");
    expect(knowledgeGap({ kind: "no-results", reason: "none" }).lane).toBe(
      "code",
    );
  });

  it("omits suggestion when not supplied and carries it when supplied", () => {
    expect(
      knowledgeGap({ kind: "no-results", reason: "none" }),
    ).toEqual({ lane: "code", reason: "none" });
    expect(
      knowledgeGap({
        kind: "not-configured",
        reason: "none",
        suggestion: "set CONFLUENCE_BASE_URL",
      }),
    ).toEqual({
      lane: "code",
      reason: "none",
      kind: "source-unavailable",
      suggestion: "set CONFLUENCE_BASE_URL",
    });
  });
});

describe("deriveAgeDays", () => {
  const now = Date.UTC(2026, 6, 19, 12, 0, 0);

  it("floors to whole days against the injected clock", () => {
    expect(deriveAgeDays(now, now)).toBe(0);
    expect(deriveAgeDays(now - 4 * 3_600_000, now)).toBe(0);
    expect(deriveAgeDays(now - DAY, now)).toBe(1);
    expect(deriveAgeDays(now - DAY - 1, now)).toBe(1);
    expect(deriveAgeDays(now - 730 * DAY, now)).toBe(730);
  });

  it("clamps a provider clock ahead of ours to zero", () => {
    expect(deriveAgeDays(now + 10 * DAY, now)).toBe(0);
  });

  it("returns 0 rather than NaN for non-finite input", () => {
    expect(deriveAgeDays(Number.NaN, now)).toBe(0);
    expect(deriveAgeDays(now, Number.NaN)).toBe(0);
    expect(deriveAgeDays(Number.POSITIVE_INFINITY, now)).toBe(0);
  });

  it("is driven entirely by the injected clock", () => {
    let ticks = now;
    const clock = () => ticks;
    expect(deriveAgeDays(now - 3 * DAY, clock())).toBe(3);
    ticks = now + 5 * DAY;
    expect(deriveAgeDays(now - 3 * DAY, clock())).toBe(8);
  });
});

describe("knowledge.v1 contract shape", () => {
  it("pins the schema version const", () => {
    expect(KNOWLEDGE_SCHEMA_VERSION).toBe("knowledge.v1");
  });

  it("type-checks a fully populated result", () => {
    const result: KnowledgeResult = {
      schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
      excerpts: [
        {
          title: "Checkout retry policy",
          url: "https://acme.atlassian.net/wiki/spaces/ENG/pages/1",
          spaceKey: "ENG",
          excerpt: "Retries are capped at three attempts.",
          lastModified: 1_700_000_000_000,
          lastModifiedBy: "Dana",
          ageDays: 42,
        },
      ],
      gaps: [knowledgeGap({ kind: "no-results", reason: "none" })],
      stats: {
        provider: "confluence",
        fetched: 1,
        returned: 1,
        truncated: false,
        latencyMs: 12,
      },
    };
    expect(result.excerpts[0]?.spaceKey).toBe("ENG");
    expect(result.stats.provider).toBe("confluence");
  });

  it("allows lastModifiedBy to be absent", () => {
    const excerpt: KnowledgeResult["excerpts"][number] = {
      title: "t",
      url: "u",
      spaceKey: "ENG",
      excerpt: "e",
      lastModified: 0,
      ageDays: 0,
    };
    expect(excerpt.lastModifiedBy).toBeUndefined();
  });
});
