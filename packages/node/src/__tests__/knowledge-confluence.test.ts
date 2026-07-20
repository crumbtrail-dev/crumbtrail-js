/**
 * Contract tests for the Confluence spec-oracle client.
 *
 * Every test replays a fixture through an injected `fetchImpl`. Nothing here
 * touches the network — the suite passes with egress unavailable, which is the
 * same guarantee the adapter suite makes.
 *
 * The load-bearing assertions are the ones about what must NEVER happen:
 * `searchSpecs` never rejects, the API token never appears in any returned
 * value, and importing this surface never registers an evidence provider.
 */
import { describe, expect, it, vi } from "vitest";
import { EVIDENCE_SOURCE_PROVIDERS } from "../evidence-sources/registry";
import {
  capExcerptBytes,
  confluenceClientFromEnv,
  ConfluenceKnowledgeClient,
  CONFLUENCE_AUTH_FIELDS,
  DEFAULT_SPEC_LIMIT,
  htmlToText,
  MAX_EXCERPT_BYTES,
  MAX_QUERY_LENGTH,
  MAX_SPEC_LIMIT,
  notConfiguredKnowledgeResult,
  parseSpaceKeysEnv,
  type KnowledgeResult,
} from "../knowledge";
import errorUnauthorized from "./fixtures/confluence/error-401.json";
import searchMultiPage from "./fixtures/confluence/search-multi-page.json";
import searchRunbook from "./fixtures/confluence/search-runbook-with-credential.json";
import searchZeroResults from "./fixtures/confluence/search-zero-results.json";

/**
 * Synthetic vendor-shaped secrets, assembled at runtime.
 *
 * These are fake, but they deliberately match the *shape* of real vendor
 * credentials so that `redactText`'s `prefixed_token` rule is genuinely
 * exercised. Because secret scanners (GitHub push protection) match on shape,
 * not provenance, no committed file may contain them as a contiguous literal —
 * hence the concatenation here, and the `__SYNTHETIC_SECRET_N__` placeholders
 * in `fixtures/confluence/search-runbook-with-credential.json`.
 *
 * Do NOT inline these back into a single string literal; the push will be
 * rejected.
 */
const SYNTHETIC_SECRETS = {
  __SYNTHETIC_SECRET_1__:
    "sk" + "_live_" + "51H8xQ2LmNpQrStUvWxYz0123456789abcdefXYZ",
  __SYNTHETIC_SECRET_2__: "gh" + "p_" + "9fK3mQ7vT1zB4nR8sW2xY6cD0eA5gH1jL3pN",
  __SYNTHETIC_SECRET_3__: "sk" + "_live_" + "abc123def456ghi789",
} as const;

/**
 * Deep-substitutes `__SYNTHETIC_SECRET_N__` placeholders in a fixture with the
 * runtime-assembled tokens above, so the stubbed fetch serves a payload that is
 * byte-for-byte what a real leaky Confluence page would return.
 */
function withSyntheticSecrets<T>(fixture: T): T {
  let json = JSON.stringify(fixture);
  for (const [placeholder, secret] of Object.entries(SYNTHETIC_SECRETS)) {
    json = json.split(placeholder).join(secret);
  }
  return JSON.parse(json) as T;
}

/** The credential under test. No returned value may ever contain it. */
const API_TOKEN = "ATATT3xFfGF0-secret-token-value-do-not-leak-9f3k2";
const EMAIL = "oracle@acme.test";
const BASE_URL = "https://acme.atlassian.net/wiki";

/** Pinned clock — `types.ts` requires the clock be threaded, never defaulted. */
const NOW = Date.UTC(2026, 6, 19, 12, 0, 0);
const clock = () => NOW;

interface StubCall {
  url: string;
  init: RequestInit | undefined;
}

/** Fixture-replaying `fetchImpl`, recording what would have gone on the wire. */
function stubFetch(
  body: unknown,
  init: { status?: number } = {},
): { fetchImpl: typeof fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchImpl = (async (url: string, requestInit?: RequestInit) => {
    calls.push({ url: String(url), init: requestInit });
    const status = init.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    };
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function makeClient(
  fetchImpl: typeof fetch,
  overrides: Partial<{
    spaceKeys: string[];
    timeoutMs: number;
  }> = {},
) {
  return new ConfluenceKnowledgeClient({
    baseUrl: BASE_URL,
    email: EMAIL,
    apiToken: API_TOKEN,
    fetchImpl,
    ...overrides,
  });
}

/** Every string anywhere in the result, so a leak cannot hide in a nested field. */
function serialize(result: KnowledgeResult): string {
  return JSON.stringify(result);
}

describe("confluenceClientFromEnv", () => {
  const fullEnv = {
    CONFLUENCE_BASE_URL: BASE_URL,
    CONFLUENCE_EMAIL: EMAIL,
    CONFLUENCE_API_TOKEN: API_TOKEN,
  };

  it("builds a client when every required var is set", () => {
    expect(confluenceClientFromEnv(fullEnv)).toBeInstanceOf(
      ConfluenceKnowledgeClient,
    );
  });

  it("returns undefined when any required var is unset or empty", () => {
    for (const missing of CONFLUENCE_AUTH_FIELDS) {
      const env: Record<string, string | undefined> = { ...fullEnv };
      delete env[missing];
      expect(confluenceClientFromEnv(env)).toBeUndefined();

      expect(
        confluenceClientFromEnv({ ...fullEnv, [missing]: "" }),
      ).toBeUndefined();
    }
    expect(confluenceClientFromEnv({})).toBeUndefined();
  });

  it("parses the optional comma-separated space allowlist", () => {
    expect(parseSpaceKeysEnv("ENG, OPS ,,ARCH")).toEqual([
      "ENG",
      "OPS",
      "ARCH",
    ]);
    expect(parseSpaceKeysEnv(undefined)).toEqual([]);
    expect(parseSpaceKeysEnv("")).toEqual([]);
  });

  it("fails closed when a configured space allowlist is malformed or empty", async () => {
    for (const rawSpaceKeys of ["ENG,BAD!", " , , "]) {
      const { fetchImpl, calls } = stubFetch(searchMultiPage);
      const client = confluenceClientFromEnv(
        { ...fullEnv, CONFLUENCE_SPACE_KEYS: rawSpaceKeys },
        { fetchImpl },
      );
      expect(client).toBeInstanceOf(ConfluenceKnowledgeClient);

      const result = await client!.searchSpecs(
        { query: "checkout retry" },
        clock,
      );
      expect(calls).toHaveLength(0);
      expect(result.excerpts).toEqual([]);
      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0].reason).toContain(
        "CONFLUENCE_SPACE_KEYS is invalid",
      );
      expect(result.gaps[0].reason).not.toContain(rawSpaceKeys);
    }
  });

  it("does not let runtime options override the env-derived allowlist", async () => {
    const { fetchImpl, calls } = stubFetch(searchMultiPage);
    // Extra properties are legal on a variable passed to the narrow options
    // type at runtime. They must not be spread into the security config.
    const options = {
      fetchImpl,
      spaceKeys: ["ENG"],
      spaceKeysConfigured: false,
    };
    const client = confluenceClientFromEnv(
      { ...fullEnv, CONFLUENCE_SPACE_KEYS: "ENG,BAD!" },
      options,
    );

    const result = await client!.searchSpecs(
      { query: "checkout retry" },
      clock,
    );
    expect(calls).toHaveLength(0);
    expect(result.excerpts).toEqual([]);
    expect(result.gaps[0].reason).toContain("CONFLUENCE_SPACE_KEYS is invalid");
  });
});

describe("searchSpecs — request construction", () => {
  it("fails closed for malformed non-empty direct allowlist config", async () => {
    for (const spaceKeys of [["ENG", "BAD!"], ["BAD!"]]) {
      const { fetchImpl, calls } = stubFetch(searchMultiPage);
      const result = await makeClient(fetchImpl, { spaceKeys }).searchSpecs(
        { query: "checkout retry" },
        clock,
      );

      expect(calls).toHaveLength(0);
      expect(result.excerpts).toEqual([]);
      expect(result.gaps).toHaveLength(1);
      expect(result.gaps[0].reason).toContain("no search was sent");
    }
  });

  it("issues exactly one bounded GET with Basic auth and the shared User-Agent", async () => {
    const { fetchImpl, calls } = stubFetch(searchMultiPage);
    await makeClient(fetchImpl).searchSpecs({ query: "checkout retry" }, clock);

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url.startsWith(`${BASE_URL}/rest/api/content/search?`)).toBe(true);

    const params = new URL(url).searchParams;
    expect(params.get("cql")).toBe(
      'text ~ "checkout retry" AND type = page ORDER BY lastModified DESC',
    );
    expect(params.get("limit")).toBe(String(DEFAULT_SPEC_LIMIT));
    expect(params.get("expand")).toBe("body.view,version,space");

    const headers = init?.headers as Record<string, string>;
    const expected = `Basic ${Buffer.from(`${EMAIL}:${API_TOKEN}`, "utf8").toString("base64")}`;
    expect(headers.Authorization).toBe(expected);
    expect(headers["User-Agent"]).toBeTruthy();
    expect(init?.signal).toBeDefined();
  });

  it("clamps the limit to MAX_SPEC_LIMIT and to at least 1", async () => {
    for (const [requested, expected] of [
      [999, MAX_SPEC_LIMIT],
      [0, 1],
      [-5, 1],
      [3, 3],
    ] as const) {
      const { fetchImpl, calls } = stubFetch(searchZeroResults);
      await makeClient(fetchImpl).searchSpecs(
        { query: "retry", limit: requested },
        clock,
      );
      expect(new URL(calls[0].url).searchParams.get("limit")).toBe(
        String(expected),
      );
    }
  });

  it("treats the operator allowlist as a ceiling a caller can only narrow", async () => {
    const narrow = stubFetch(searchZeroResults);
    const narrowed = await makeClient(narrow.fetchImpl, {
      spaceKeys: ["ENG", "OPS"],
    }).searchSpecs({ query: "retry", spaceKeys: ["OPS"] }, clock);
    expect(new URL(narrow.calls[0].url).searchParams.get("cql")).toContain(
      'space.key IN ("OPS")',
    );
    // A key inside the ceiling is honored in full — nothing to report.
    expect(
      narrowed.gaps.some((g) => g.reason.includes("operator allowlist")),
    ).toBe(false);

    // A caller asking for a space outside the allowlist cannot widen the search:
    // the request falls back to the operator list rather than dropping the clause.
    const widen = stubFetch(searchZeroResults);
    const widened = await makeClient(widen.fetchImpl, {
      spaceKeys: ["ENG"],
    }).searchSpecs({ query: "retry", spaceKeys: ["SECRET"] }, clock);
    expect(new URL(widen.calls[0].url).searchParams.get("cql")).toContain(
      'space.key IN ("ENG")',
    );

    // ...and the substitution is REPORTED. Returning ENG results to a caller who
    // asked for SECRET while saying nothing is the highest-consequence silent
    // clipping in this client, and it used to route around the loss detector
    // entirely because that detector only ever sees the resolved list.
    const denied = widened.gaps.find((g) =>
      g.reason.includes("operator allowlist"),
    );
    expect(denied).toBeDefined();
    // Informational: the lookup ran and its answer is real, just not the one asked for.
    expect(denied?.kind).toBeUndefined();
    expect(denied?.reason).toContain("SECRET");
    // The gap must name the spaces ACTUALLY searched, not just what was denied.
    expect(denied?.reason).toContain("searched ENG");
  });
});

describe("searchSpecs — normalization", () => {
  it("normalizes a multi-page hit into redacted excerpts with staleness", async () => {
    const { fetchImpl } = stubFetch(searchMultiPage);
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "checkout retry" },
      clock,
    );

    expect(result.schemaVersion).toBe("knowledge.v1");
    expect(result.excerpts).toHaveLength(2);
    expect(result.gaps).toEqual([]);
    expect(result.stats).toEqual({
      provider: "confluence",
      fetched: 2,
      returned: 2,
      truncated: false,
      latencyMs: 0,
    });

    const [first, second] = result.excerpts;
    expect(first.title).toBe("Checkout retry policy");
    expect(first.spaceKey).toBe("ENG");
    expect(first.url).toBe(
      "https://acme.atlassian.net/wiki/spaces/ENG/pages/1179648/Checkout+retry+policy",
    );
    expect(first.lastModified).toBe(Date.parse("2026-07-12T09:30:00.000Z"));
    expect(first.ageDays).toBe(7);
    expect(first.lastModifiedBy).toBe("Dana Okafor");
    expect(first.excerpt).toContain("retries a failed payment authorization");
    // Markup is stripped and script subtrees are dropped whole.
    expect(first.excerpt).not.toContain("<");
    expect(first.excerpt).not.toContain("console.log");

    // Provider order (ORDER BY lastModified DESC) is preserved, never re-ranked.
    expect(second.spaceKey).toBe("ARCH");
    expect(second.ageDays).toBeGreaterThan(first.ageDays);
  });

  it("selects context around a matched term even when it starts after 2 KB", async () => {
    const boilerplate =
      "Opening boilerplate with no matching behavior. ".repeat(70);
    expect(Buffer.byteLength(boilerplate, "utf8")).toBeGreaterThan(
      MAX_EXCERPT_BYTES,
    );
    const matchedPassage =
      "The retry budget is three attempts before the checkout is abandoned.";
    const result = await makeClient(
      stubFetch({
        results: [
          {
            id: "1",
            title: "Checkout retry policy",
            space: { key: "ENG" },
            body: { view: { value: `<p>${boilerplate}${matchedPassage}</p>` } },
            version: { when: "2026-07-19T00:00:00.000Z" },
            _links: { webui: "/spaces/ENG/pages/1" },
          },
        ],
        _links: { base: BASE_URL },
      }).fetchImpl,
    ).searchSpecs({ query: "retry budget" }, clock);

    expect(result.excerpts[0].excerpt).toContain(matchedPassage);
    expect(result.stats.truncated).toBe(true);
    expect(
      Buffer.byteLength(result.excerpts[0].excerpt, "utf8"),
    ).toBeLessThanOrEqual(MAX_EXCERPT_BYTES);
  });

  it("skips rows carrying no usable body rather than emitting empty excerpts", async () => {
    const { fetchImpl } = stubFetch({
      results: [
        { id: "1", title: "No body", space: { key: "ENG" } },
        { id: "2", title: "Empty body", body: { view: { value: "" } } },
        { id: "3", title: "Markup only", body: { view: { value: "<p></p>" } } },
      ],
      _links: { base: BASE_URL },
    });
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "retry" },
      clock,
    );
    expect(result.excerpts).toEqual([]);
    expect(result.stats.fetched).toBe(3);
    expect(result.stats.returned).toBe(0);
    expect(result.gaps.some((g) => g.reason.includes("no pages matched"))).toBe(
      true,
    );
  });
});

describe("searchSpecs — degradation (never rejects)", () => {
  it("missing credentials yield a not-configured gap, not a throw", async () => {
    expect(confluenceClientFromEnv({})).toBeUndefined();

    const result = notConfiguredKnowledgeResult();
    expect(result.excerpts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].kind).toBe("source-unavailable");
    expect(result.gaps[0].reason).toContain("not configured");
    expect(result.stats.returned).toBe(0);
  });

  it("401 resolves to an auth-failed gap and leaks no token", async () => {
    const { fetchImpl } = stubFetch(errorUnauthorized, { status: 401 });
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "checkout retry" },
      clock,
    );

    expect(result.excerpts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].kind).toBe("source-unavailable");
    expect(result.gaps[0].reason).toContain("authentication rejected");
    expect(result.gaps[0].reason).toContain("401");
    expect(serialize(result)).not.toContain(API_TOKEN);
  });

  it("403 is an auth failure; other non-2xx is a request failure", async () => {
    const forbidden = await makeClient(
      stubFetch(errorUnauthorized, { status: 403 }).fetchImpl,
    ).searchSpecs({ query: "retry" }, clock);
    expect(forbidden.gaps[0].reason).toContain("authentication rejected");

    const serverError = await makeClient(
      stubFetch({}, { status: 500 }).fetchImpl,
    ).searchSpecs({ query: "retry" }, clock);
    expect(serverError.gaps[0].kind).toBe("source-unavailable");
    expect(serverError.gaps[0].reason).toContain("search failed (HTTP 500)");
  });

  it("a timeout resolves to a timeout gap rather than an unhandled rejection", async () => {
    // Never settles on its own: only the client's AbortController can end it.
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as unknown as typeof fetch;

    const result = await makeClient(fetchImpl, { timeoutMs: 5 }).searchSpecs(
      { query: "checkout retry" },
      clock,
    );
    expect(result.excerpts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].kind).toBe("source-unavailable");
    expect(result.gaps[0].reason).toContain("did not complete within 5ms");
  });

  it("a transport failure resolves to a request-failed gap without echoing the URL", async () => {
    const fetchImpl = (async () => {
      throw new Error(
        `connect ECONNREFUSED ${BASE_URL}?cql=x&secret=${API_TOKEN}`,
      );
    }) as unknown as typeof fetch;

    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "retry" },
      clock,
    );
    expect(result.gaps[0].kind).toBe("source-unavailable");
    expect(result.gaps[0].reason).toBe(
      "confluence: search could not be completed",
    );
    expect(serialize(result)).not.toContain(API_TOKEN);
  });

  it("malformed JSON resolves to a request-failed gap", async () => {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON at position 0");
      },
    })) as unknown as typeof fetch;

    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "retry" },
      clock,
    );
    expect(result.excerpts).toEqual([]);
    expect(result.gaps[0].kind).toBe("source-unavailable");
  });

  it("rejects an oversized declared response before attempting JSON parsing", async () => {
    const json = vi.fn(async () => searchMultiPage);
    const cancel = vi.fn(async () => undefined);
    const fetchImpl = (async () =>
      ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(1_024 * 1_024 + 1) }),
        body: { cancel },
        json,
      }) as unknown as Response) as typeof fetch;

    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "retry" },
      clock,
    );

    expect(json).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
    expect(result.excerpts).toEqual([]);
    expect(result.gaps[0].reason).toContain("response exceeded");
    expect(serialize(result)).not.toContain(API_TOKEN);
  });

  it("cancels a chunked response that grows past the byte limit before parsing", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700 * 1_024));
        controller.enqueue(new Uint8Array(400 * 1_024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl = (async () => new Response(stream)) as typeof fetch;

    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "retry" },
      clock,
    );

    expect(cancelled).toBe(true);
    expect(result.excerpts).toEqual([]);
    expect(result.gaps[0].reason).toContain("response exceeded");
  });

  it("zero results is an informational gap, not an unavailable source", async () => {
    const { fetchImpl } = stubFetch(searchZeroResults);
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "checkout retry" },
      clock,
    );

    expect(result.excerpts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    // "no documented intent exists" is a real answer — marking the source
    // unavailable would claim the oracle is broken when it worked.
    expect(result.gaps[0].kind).toBeUndefined();
    expect(result.gaps[0].reason).toContain("no pages matched");
    expect(result.stats.fetched).toBe(0);
  });

  it("an empty-after-sanitization query never reaches the network", async () => {
    const { fetchImpl, calls } = stubFetch(searchMultiPage);
    for (const query of ["", "   ", "***", "()[]"]) {
      const result = await makeClient(fetchImpl).searchSpecs({ query }, clock);
      expect(result.gaps[0].kind).toBeUndefined();
      expect(result.gaps[0].reason).toContain("empty after sanitization");
      expect(result.excerpts).toEqual([]);
    }
    expect(calls).toHaveLength(0);
  });

  // `SpecSearchRequest` is a compile-time claim about a value that arrives as
  // agent-authored JSON through the MCP dispatch. These two shapes used to
  // REJECT out of the pre-flight block, which sits outside every try/catch.
  it("a non-string query resolves to a gap rather than rejecting", async () => {
    const { fetchImpl, calls } = stubFetch(searchMultiPage);
    for (const query of [42, null, { text: "retry" }, ["retry"]]) {
      const result = await makeClient(fetchImpl).searchSpecs(
        { query } as unknown as { query: string },
        clock,
      );
      expect(result.schemaVersion).toBe("knowledge.v1");
      expect(result.excerpts).toEqual([]);
      expect(result.gaps[0].reason).toContain("empty after sanitization");
    }
    // A non-string is not a searchable term, so nothing reaches the network.
    expect(calls).toHaveLength(0);
  });

  it("a non-array spaceKeys resolves to a gap rather than rejecting", async () => {
    for (const spaceKeys of [5, "ENG", null, { key: "ENG" }]) {
      const { fetchImpl, calls } = stubFetch(searchMultiPage);
      const result = await makeClient(fetchImpl, {
        spaceKeys: ["ENG"],
      }).searchSpecs(
        { query: "retry", spaceKeys } as unknown as {
          query: string;
          spaceKeys: string[];
        },
        clock,
      );
      expect(result.schemaVersion).toBe("knowledge.v1");
      // Unusable narrowing degrades to "no caller narrowing", which resolves to
      // the operator ceiling — the safe direction, never a widened search.
      expect(new URL(calls[0].url).searchParams.get("cql")).toContain(
        'space.key IN ("ENG")',
      );
    }
  });

  it("a non-finite limit falls back to the default instead of emptying the results", async () => {
    for (const limit of [NaN, "abc", Infinity, -Infinity, null]) {
      const { fetchImpl, calls } = stubFetch(searchMultiPage);
      const result = await makeClient(fetchImpl).searchSpecs(
        { query: "checkout retry", limit } as unknown as {
          query: string;
          limit: number;
        },
        clock,
      );

      // `limit=NaN` went on the wire...
      expect(new URL(calls[0].url).searchParams.get("limit")).toBe(
        String(DEFAULT_SPEC_LIMIT),
      );
      // ...and `rows.slice(0, NaN)` returned [], so the client reported
      // "no documented intent was found" while holding the rows it had just
      // fetched. A spec oracle asserting a spec does not exist is the worst
      // possible false negative.
      expect(result.stats.fetched).toBe(2);
      expect(result.stats.returned).toBe(2);
      expect(result.excerpts).toHaveLength(2);
      expect(
        result.gaps.some((g) => g.reason.includes("no pages matched")),
      ).toBe(false);
    }
  });

  it("an already-aborted caller signal prevents egress entirely", async () => {
    const { fetchImpl, calls } = stubFetch(searchMultiPage);
    const controller = new AbortController();
    controller.abort();

    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "checkout retry" },
      clock,
      controller.signal,
    );

    // `addEventListener("abort")` never fires for an already-aborted signal, so
    // without a `signal.aborted` pre-check the request went out AFTER the
    // caller had cancelled.
    expect(calls).toHaveLength(0);
    expect(result.excerpts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].reason).toContain("cancelled by the caller");
  });

  it("a caller-initiated abort is reported as a cancellation, not a timeout", async () => {
    const fetchImpl = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("The operation was aborted");
          error.name = "AbortError";
          reject(error);
        });
      })) as unknown as typeof fetch;

    const controller = new AbortController();
    const pending = makeClient(fetchImpl, { timeoutMs: 30_000 }).searchSpecs(
      { query: "checkout retry" },
      clock,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 5);
    const result = await pending;

    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].reason).toContain("cancelled by the caller");
    // The budget was never exceeded; claiming otherwise blames the provider for
    // the caller's own abort.
    expect(result.gaps[0].reason).not.toContain("did not complete within");
  });
});

describe("searchSpecs — redaction", () => {
  it("scrubs credentials pasted into a runbook page", async () => {
    const { fetchImpl } = stubFetch(withSyntheticSecrets(searchRunbook));
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "gateway key rotation" },
      clock,
    );

    expect(result.excerpts).toHaveLength(1);
    const { excerpt } = result.excerpts[0];
    // The page's prose survives — the assertions below cannot pass vacuously
    // by everything having been scrubbed.
    expect(excerpt).toContain("Rotating the gateway key");
    expect(excerpt).toContain("Export the service token");
    expect(excerpt).toContain("before closing the change ticket");
    expect(excerpt).toContain("export GATEWAY_API_TOKEN=");
    // Sanity: the placeholders really were substituted, so the redactor was
    // handed genuine vendor-shaped tokens and not inert placeholder text.
    expect(JSON.stringify(withSyntheticSecrets(searchRunbook))).not.toContain(
      "__SYNTHETIC_SECRET_",
    );
    // ...but every secret in it is gone.
    for (const secret of [
      // `prefixed_token` rule (sk_ prefix) + `long_token_like_string`
      SYNTHETIC_SECRETS.__SYNTHETIC_SECRET_1__,
      // keyword-assignment rule (DB_PASSWORD=...)
      "hunter2-correct-horse-battery",
      // `prefixed_token` rule (ghp_ prefix) + `long_token_like_string`
      SYNTHETIC_SECRETS.__SYNTHETIC_SECRET_2__,
    ]) {
      expect(excerpt).not.toContain(secret);
      expect(serialize(result)).not.toContain(secret);
    }
  });

  it("strips credentials embedded in a page deep link", async () => {
    const { fetchImpl } = stubFetch({
      results: [
        {
          id: "9",
          title: "Linked page",
          space: { key: "ENG" },
          body: { view: { value: "<p>intent</p>" } },
          version: { when: "2026-07-19T00:00:00.000Z" },
          _links: {
            webui: `/spaces/ENG/pages/9?access_token=${SYNTHETIC_SECRETS.__SYNTHETIC_SECRET_3__}`,
          },
        },
      ],
      _links: { base: BASE_URL },
    });
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "retry" },
      clock,
    );
    expect(result.excerpts[0].url).toContain("/spaces/ENG/pages/9");
    expect(result.excerpts[0].url).not.toContain(
      SYNTHETIC_SECRETS.__SYNTHETIC_SECRET_3__,
    );
  });

  it("never returns the API token on ANY path", async () => {
    const cases: Array<() => Promise<KnowledgeResult>> = [
      () =>
        makeClient(stubFetch(searchMultiPage).fetchImpl).searchSpecs(
          { query: "retry" },
          clock,
        ),
      () =>
        makeClient(
          stubFetch(errorUnauthorized, { status: 401 }).fetchImpl,
        ).searchSpecs({ query: "retry" }, clock),
      () =>
        makeClient(stubFetch({}, { status: 500 }).fetchImpl).searchSpecs(
          { query: "retry" },
          clock,
        ),
      () =>
        makeClient(stubFetch(searchZeroResults).fetchImpl).searchSpecs(
          { query: "retry" },
          clock,
        ),
      () =>
        makeClient(stubFetch(searchRunbook).fetchImpl).searchSpecs(
          { query: "retry" },
          clock,
        ),
    ];

    for (const run of cases) {
      const serialized = serialize(await run());
      expect(serialized).not.toContain(API_TOKEN);
      expect(serialized).not.toContain("Basic ");
      expect(serialized).not.toContain(EMAIL);
    }
  });
});

describe("excerpt byte cap", () => {
  it("reports truncated only when bytes were actually dropped", () => {
    expect(capExcerptBytes("hello", 100)).toEqual({
      text: "hello",
      truncated: false,
    });
    // Exactly at the cap is NOT truncation.
    expect(capExcerptBytes("abcde", 5)).toEqual({
      text: "abcde",
      truncated: false,
    });
    const over = capExcerptBytes("abcdef", 5);
    expect(over.truncated).toBe(true);
    expect(Buffer.byteLength(over.text, "utf8")).toBeLessThanOrEqual(5);
  });

  it("never splits a multi-byte character", () => {
    // Each emoji is 4 UTF-8 bytes; a cap of 6 must keep exactly one.
    const capped = capExcerptBytes("😀😀", 6);
    expect(capped.truncated).toBe(true);
    expect(capped.text).toBe("😀");
    expect(Buffer.from(capped.text, "utf8").toString("utf8")).toBe(capped.text);
  });

  it("sets stats.truncated when a page body exceeds the cap, and not otherwise", async () => {
    const small = await makeClient(
      stubFetch(searchMultiPage).fetchImpl,
    ).searchSpecs({ query: "retry" }, clock);
    expect(small.stats.truncated).toBe(false);

    const huge = "<p>" + "spec detail ".repeat(500) + "</p>";
    expect(Buffer.byteLength(huge, "utf8")).toBeGreaterThan(MAX_EXCERPT_BYTES);
    const big = await makeClient(
      stubFetch({
        results: [
          {
            id: "1",
            title: "Long spec",
            space: { key: "ENG" },
            body: { view: { value: huge } },
            version: { when: "2026-07-19T00:00:00.000Z" },
            _links: { webui: "/spaces/ENG/pages/1" },
          },
        ],
        _links: { base: BASE_URL },
      }).fetchImpl,
    ).searchSpecs({ query: "retry" }, clock);

    expect(big.stats.truncated).toBe(true);
    expect(
      Buffer.byteLength(big.excerpts[0].excerpt, "utf8"),
    ).toBeLessThanOrEqual(MAX_EXCERPT_BYTES);
  });

  it("bounds remote HTML before conversion and reports the discarded markup", async () => {
    // The 20-byte prefix plus 1,596 five-byte tags exactly fills the 8 KB raw
    // HTML budget. The remaining tags must not reach `htmlToText`, while the
    // converted prose stays far below the 2 KB excerpt cap.
    const hostileHtml = "<p>spec survives</p>" + "<br/>".repeat(2_000);
    const result = await makeClient(
      stubFetch({
        results: [
          {
            id: "1",
            title: "Markup-heavy spec",
            space: { key: "ENG" },
            body: { view: { value: hostileHtml } },
            version: { when: "2026-07-19T00:00:00.000Z" },
            _links: { webui: "/spaces/ENG/pages/1" },
          },
        ],
        _links: { base: BASE_URL },
      }).fetchImpl,
    ).searchSpecs({ query: "retry" }, clock);

    expect(result.excerpts[0].excerpt).toBe("spec survives");
    expect(Buffer.byteLength(result.excerpts[0].excerpt, "utf8")).toBeLessThan(
      MAX_EXCERPT_BYTES,
    );
    expect(result.stats.truncated).toBe(true);
  });
});

describe("honest reporting of clipped input", () => {
  it("emits an informational gap when the query was truncated", async () => {
    const { fetchImpl, calls } = stubFetch(searchZeroResults);
    const longQuery = "retry ".repeat(200); // > MAX_QUERY_LENGTH code points
    expect(longQuery.length).toBeGreaterThan(MAX_QUERY_LENGTH);

    const result = await makeClient(fetchImpl).searchSpecs(
      { query: longQuery },
      clock,
    );

    const truncationGap = result.gaps.find((g) =>
      g.reason.includes("truncated"),
    );
    expect(truncationGap).toBeDefined();
    // Informational: the lookup still ran and its answer is real.
    expect(truncationGap?.kind).toBeUndefined();
    // The search actually happened with the clipped term.
    expect(calls).toHaveLength(1);
  });

  it("reports the truncation cap in code points, not UTF-16 code units", async () => {
    const { fetchImpl } = stubFetch(searchZeroResults);
    // Astral characters cost two UTF-16 code units each but one code point, and
    // the cap is applied in CODE POINTS. Reporting `sanitizedQuery.length` made
    // this claim "truncated to 767 characters" against a 512 cap.
    const astral = "😀 ".repeat(400);
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: astral },
      clock,
    );

    const gap = result.gaps.find((g) => g.reason.includes("truncated"));
    expect(gap).toBeDefined();
    expect(gap?.reason).toContain(String(MAX_QUERY_LENGTH));
    // No number larger than the cap may appear in the message.
    for (const n of gap?.reason.match(/\d+/g) ?? []) {
      expect(Number(n)).toBeLessThanOrEqual(MAX_QUERY_LENGTH);
    }
  });

  it("emits no truncation gap for a query that fits", async () => {
    const { fetchImpl } = stubFetch(searchMultiPage);
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "checkout retry" },
      clock,
    );
    expect(result.gaps).toEqual([]);
  });

  it("emits an informational gap when requested space keys were dropped", async () => {
    const { fetchImpl } = stubFetch(searchMultiPage);
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "checkout retry", spaceKeys: ["ENG", 'BAD") OR type=page'] },
      clock,
    );

    const dropped = result.gaps.find((g) => g.reason.includes("space key"));
    expect(dropped).toBeDefined();
    expect(dropped?.kind).toBeUndefined();
    expect(dropped?.reason).toContain("1 requested space key");
  });

  it("emits no dropped-key gap when every requested key survives", async () => {
    const { fetchImpl } = stubFetch(searchMultiPage);
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "checkout retry", spaceKeys: ["ENG", "OPS"] },
      clock,
    );
    expect(result.gaps).toEqual([]);
  });
});

describe("lone surrogates in the query", () => {
  it("does not throw and does not send an unencodable CQL", async () => {
    const { fetchImpl, calls } = stubFetch(searchZeroResults);
    // A lone high surrogate is not a quote, an operator, or a control char, so
    // CP1's sanitizer passes it through untouched — this client is the first
    // code that encodes, so it is the code that must survive it.
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "checkout \uD800 retry policy" },
      clock,
    );

    expect(result.schemaVersion).toBe("knowledge.v1");
    expect(calls).toHaveLength(1);
    const cql = new URL(calls[0].url).searchParams.get("cql") as string;
    expect(cql).toContain("checkout");
    expect(cql).toContain("retry policy");
    expect(/[\uD800-\uDFFF]/u.test(cql)).toBe(false);
  });

  it("preserves well-formed astral characters", async () => {
    const { fetchImpl, calls } = stubFetch(searchZeroResults);
    await makeClient(fetchImpl).searchSpecs(
      { query: "checkout 😀 retry" },
      clock,
    );
    expect(new URL(calls[0].url).searchParams.get("cql")).toContain("😀");
  });

  it("a lone surrogate alone in the query degrades to empty-query, not a throw", async () => {
    const { fetchImpl, calls } = stubFetch(searchZeroResults);
    const result = await makeClient(fetchImpl).searchSpecs(
      { query: "\uD800" },
      clock,
    );
    // Either path is acceptable so long as it resolves; assert it resolved with
    // a gap and issued no unencodable request.
    expect(result.gaps.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(() => new URL(call.url)).not.toThrow();
    }
  });
});

describe("boundary: this is not an evidence adapter", () => {
  it("importing the knowledge barrel registers no evidence provider", () => {
    // A non-zero count here means something in `knowledge/` pulled an adapter
    // module in transitively and registered it as a side effect of import.
    expect(EVIDENCE_SOURCE_PROVIDERS.length).toBe(0);
  });

  it("the client does not implement the EvidenceSource surface", () => {
    const client = makeClient(
      stubFetch(searchZeroResults).fetchImpl,
    ) as unknown as Record<string, unknown>;
    expect(client.descriptor).toBeUndefined();
    expect(client.fetchEvidence).toBeUndefined();
  });
});

describe("htmlToText", () => {
  it("drops script and style subtrees whole", () => {
    expect(
      htmlToText("<p>keep</p><script>secret()</script><style>.a{}</style>"),
    ).toBe("keep");
  });

  it("decodes the entities Confluence emits and collapses whitespace", () => {
    expect(htmlToText("<p>a &amp;&nbsp;b &lt;c&gt;   d</p>")).toBe(
      "a & b <c> d",
    );
  });

  it("keeps block boundaries as newlines so text does not run together", () => {
    expect(htmlToText("<li>one</li><li>two</li>")).toBe("one\ntwo");
  });
});

describe("no live network", () => {
  it("never falls back to global fetch when fetchImpl is injected", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const { fetchImpl } = stubFetch(searchMultiPage);
    await makeClient(fetchImpl).searchSpecs({ query: "retry" }, clock);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
