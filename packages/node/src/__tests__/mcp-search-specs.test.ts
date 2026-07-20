/**
 * `searchSpecs` MCP surface: registration, schema, and dispatch.
 *
 * These tests are about the BOUNDARY, not about Confluence. The client's own
 * degradation behavior is covered in `knowledge-confluence.test.ts`; what is
 * pinned here is that the MCP layer does not undo any of it — no credential in
 * the advertised schema, no `isError` for an unconfigured host, no path that
 * lets a caller widen the operator space allowlist, and staleness metadata
 * present on every excerpt an agent can see.
 *
 * Nothing here touches the network: the client is injected through
 * `knowledgeClientFactory` with a stubbed `fetchImpl`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "../mcp-server";
import {
  ConfluenceKnowledgeClient,
  DEFAULT_SPEC_LIMIT,
  MAX_SPEC_LIMIT,
  type KnowledgeResult,
} from "../knowledge";
import searchMultiPage from "./fixtures/confluence/search-multi-page.json";
import searchZeroResults from "./fixtures/confluence/search-zero-results.json";

/**
 * Records every URL the client would have fetched, and replays a fixture.
 *
 * `clone: false` hands the payload through by reference. Fixtures are cloned so
 * repeated calls cannot mutate each other, but a payload carrying a throwing
 * getter must NOT be round-tripped: `JSON.stringify` would fire the getter
 * inside `json()`, and the client's own transport catch would absorb the throw
 * before `normalizeRow` ever saw the row.
 */
function stubFetch(payload: unknown, clone = true) {
  const urls: string[] = [];
  const impl = (async (url: string | URL) => {
    urls.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => (clone ? JSON.parse(JSON.stringify(payload)) : payload),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { urls, impl };
}

function clientWith(
  payload: unknown,
  spaceKeys: readonly string[] = [],
  clone = true,
): { client: ConfluenceKnowledgeClient; urls: string[] } {
  const { urls, impl } = stubFetch(payload, clone);
  return {
    urls,
    client: new ConfluenceKnowledgeClient({
      baseUrl: "https://acme.atlassian.net/wiki",
      email: "oracle@acme.test",
      apiToken: "confluence-api-token-value",
      spaceKeys,
      fetchImpl: impl,
    }),
  };
}

describe("searchSpecs MCP tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-specs-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function serverWith(client?: ConfluenceKnowledgeClient): McpServer {
    return new McpServer({
      outputDir: tmpDir,
      knowledgeClientFactory: () => client,
    });
  }

  async function listTools(server: McpServer) {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    return (res!.result as { tools: any[] }).tools;
  }

  async function call(
    server: McpServer,
    args: Record<string, unknown>,
  ): Promise<{ raw: any; result: KnowledgeResult }> {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "searchSpecs", arguments: args },
    });
    const raw = res!.result as any;
    return { raw, result: JSON.parse(raw.content[0].text) as KnowledgeResult };
  }

  // ── Registration and schema ────────────────────────────────────────────────

  it("tools/list advertises searchSpecs with the documented schema", async () => {
    const tools = await listTools(serverWith());
    const tool = tools.find((t) => t.name === "searchSpecs");
    expect(tool).toBeDefined();

    expect(tool.inputSchema.type).toBe("object");
    expect(tool.inputSchema.required).toEqual(["query"]);
    expect(tool.inputSchema.properties.query.type).toBe("string");
    expect(tool.inputSchema.properties.spaceKeys.type).toBe("array");
    expect(tool.inputSchema.properties.spaceKeys.items.type).toBe("string");
    expect(tool.inputSchema.properties.limit.type).toBe("number");
    expect(tool.inputSchema.properties.limit.description).toContain(
      String(DEFAULT_SPEC_LIMIT),
    );
    expect(tool.inputSchema.properties.limit.description).toContain(
      String(MAX_SPEC_LIMIT),
    );
  });

  it("registers searchSpecs in the advertised tool list", async () => {
    // Membership only. Tool ORDER is not a contract — no MCP client depends on
    // it — and pinning it would fail on any future insertion above this one.
    const names = (await listTools(serverWith())).map((t) => t.name);
    expect(names).toContain("searchSpecs");
  });

  /**
   * The credential-shaped-field ban. An MCP schema is a public invitation: any
   * field it advertises, an agent may try to fill, and a caller-supplied
   * credential is exactly the shape this design refuses. Credentials come from
   * operator env and nowhere else.
   */
  it("advertises no credential-shaped input field", async () => {
    const tools = await listTools(serverWith());
    const tool = tools.find((t) => t.name === "searchSpecs");

    // Matched against FIELD NAMES, at any depth, not against the serialized
    // schema text. A raw substring scan over the whole JSON also fires on
    // ordinary prose — "auth" inside "author"/"authoritative", "email" inside a
    // description — and would report a misleading "credential-shaped field" for
    // a tool whose result legitimately talks about `lastModifiedBy`.
    const fieldNames: string[] = [];
    const collect = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const item of node) collect(item);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (
        record.properties !== null &&
        typeof record.properties === "object" &&
        !Array.isArray(record.properties)
      ) {
        fieldNames.push(...Object.keys(record.properties));
      }
      for (const value of Object.values(record)) collect(value);
    };
    collect(tool.inputSchema);

    // Sanity: the walk really found the fields, so "none are credential-shaped"
    // is not a vacuous statement over an empty list.
    expect(fieldNames.length).toBeGreaterThan(0);

    // Banned as whole WORDS of the name after splitting camelCase, snake_case,
    // and kebab-case, so `apiKey` / `api_key` / `apikey`, `authToken`, and
    // `baseUrl` are all caught while `author`, `authoritative`, and
    // `lastModifiedBy` are not.
    const BANNED_WORDS = [
      "token",
      "password",
      "secret",
      "credential",
      "credentials",
      "apikey",
      "auth",
      // `auth` alone is an exact-word match, so the longer spellings that the
      // earlier substring scan caught have to be listed explicitly.
      "authorization",
      "email",
      "baseurl",
      // `key` is too generic to ban on its own (`spaceKeys` is legitimate), so
      // ban the credential-bearing compounds instead.
      "privatekey",
      "signingkey",
      "secretkey",
      "sessionkey",
      "accesskey",
    ];
    const offenders = fieldNames.filter((name) => {
      const words = name
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((w) => w.length > 0);
      // Adjacent pairs catch the two-word spellings of the single-token bans
      // (`api key` → `apikey`, `base url` → `baseurl`).
      const pairs = words
        .slice(0, -1)
        .map((word, i) => `${word}${words[i + 1]}`);
      const tokens = new Set([...words, ...pairs]);
      return BANNED_WORDS.some((banned) => tokens.has(banned));
    });
    expect(offenders).toEqual([]);
    expect(Object.keys(tool.inputSchema.properties).sort()).toEqual([
      "limit",
      "query",
      "spaceKeys",
    ]);
  });

  /**
   * The description is the only thing an agent is guaranteed to read. Decision
   * D1 says a page annotates a finding and never settles it, so the listing
   * itself must carry: these are documents, they may be stale, and they are
   * advisory.
   */
  it("describes results as possibly-stale advisory documentation", async () => {
    const tools = await listTools(serverWith());
    const description = tools.find((t) => t.name === "searchSpecs")
      .description as string;
    const lower = description.toLowerCase();

    // These four are SEMANTIC and stay exact. The description is a safety
    // control; an untested control gets silently weakened by the next edit.
    expect(lower).toContain("documentation");
    expect(lower).toContain("stale");
    expect(lower).toContain("advisory only");
    expect(lower).toContain("agedays");
    // Absence of a page is not evidence of a bug.
    expect(lower).toContain("not proof");

    // Advisory means it annotates rather than settles. Matched at the CONCEPT
    // level: pinning the exact clause forbids rewording the description, and it
    // has to stay rewordable — length and ordering are what an agent actually
    // reads, and both are tuned.
    expect(lower).toMatch(/annotate/);
    expect(lower).toMatch(/never to (settle|close|dismiss|suppress|resolve)/);

    // The qualifier must be the FIRST thing read, not buried behind capability
    // framing: an agent deciding whether to call sees the opening, and "look up
    // what the system was supposed to do" reads as authority.
    expect(lower.startsWith("advisory only")).toBe(true);
  });

  it("names lastModifiedBy in the description, per the D1 output contract", async () => {
    const tools = await listTools(serverWith());
    const description = tools.find((t) => t.name === "searchSpecs")
      .description as string;
    expect(description).toContain("lastModifiedBy");
  });

  // ── Unconfigured host ──────────────────────────────────────────────────────

  it("returns a gap-bearing result, not an MCP error, with no CONFLUENCE_* env", async () => {
    // The factory returning undefined is exactly what confluenceClientFromEnv
    // does on a host with no credentials configured.
    const { raw, result } = await call(serverWith(undefined), {
      query: "checkout retry policy",
    });

    expect(raw.isError).toBeUndefined();
    expect(result.schemaVersion).toBe("knowledge.v1");
    expect(result.excerpts).toEqual([]);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0].reason).toContain("not configured");
    expect(JSON.stringify(result)).not.toContain("CONFLUENCE_API_TOKEN=");
  });

  it("returns a gap rather than an error when query is missing entirely", async () => {
    const { client } = clientWith(searchMultiPage);
    const { raw, result } = await call(serverWith(client), {});

    expect(raw.isError).toBeUndefined();
    expect(result.excerpts).toEqual([]);
    expect(result.gaps.some((g) => /empty/i.test(g.reason))).toBe(true);
  });

  it("returns a gap rather than an error when nothing matches", async () => {
    const { client } = clientWith(searchZeroResults);
    const { raw, result } = await call(serverWith(client), {
      query: "a behavior nobody documented",
    });

    expect(raw.isError).toBeUndefined();
    expect(result.excerpts).toEqual([]);
    expect(result.gaps.length).toBeGreaterThan(0);
  });

  // ── The never-isError contract, against hostile provider payloads ──────────

  /**
   * The dispatch used to `await client.searchSpecs(...)` with no `catch`,
   * relying entirely on the client's documented never-rejects claim. The claim
   * had holes, and each of these shapes produced `isError: true` carrying a raw
   * unsanitized JS message ("Cannot read properties of null (reading 'body')",
   * "body.trim is not a function", "url.trim is not a function", and the thrown
   * message echoed verbatim). Raw messages are exactly the channel `errorGap`
   * refuses to reuse, because a transport message can echo the request URL.
   *
   * Fixed at the root in `confluence.ts` AND guarded at this layer, so these
   * assert the observable contract rather than either implementation.
   */
  const hostilePayloads: Array<[string, () => unknown, boolean]> = [
    ["a null row", () => ({ results: [null] }), true],
    [
      "a non-string title",
      () => ({
        results: [{ title: 42, body: { view: { value: "<p>text</p>" } } }],
      }),
      true,
    ],
    [
      "a non-string _links.base",
      () => ({
        _links: { base: 7 },
        results: [
          { title: "Retry policy", body: { view: { value: "<p>t</p>" } } },
        ],
      }),
      true,
    ],
    [
      "a row that throws on property access",
      () => ({
        results: [
          {
            title: "Retry policy",
            get body(): unknown {
              throw new Error("secret-bearing-message");
            },
          },
        ],
      }),
      // Handed through by reference so the getter survives to normalizeRow.
      false,
    ],
  ];

  for (const [label, makePayload, clone] of hostilePayloads) {
    it(`returns a gap, not isError, for ${label}`, async () => {
      const { client } = clientWith(makePayload(), [], clone);
      const { raw, result } = await call(serverWith(client), {
        query: "checkout retry policy",
      });

      expect(raw.isError).toBeUndefined();
      expect(result.schemaVersion).toBe("knowledge.v1");
      // Every one of these must produce an ANSWER. Two of the four are
      // salvageable — a non-string title degrades to "Untitled page" and a
      // non-string `_links.base` falls back to the configured wiki root — so
      // they return the excerpt rather than a gap, which is the better outcome.
      // The unsalvageable two (null row, throwing getter) drop the row and gap
      // with no-results. What is uniform is that the caller is never left with
      // neither: no silent empty result, and never an MCP error.
      expect(result.excerpts.length + result.gaps.length).toBeGreaterThan(0);
      if (result.excerpts.length === 0) {
        expect(result.gaps.length).toBeGreaterThan(0);
      }
      // No raw JS error text reached the agent.
      const text = JSON.stringify(result);
      expect(text).not.toContain("is not a function");
      expect(text).not.toContain("Cannot read properties");
      expect(text).not.toContain("secret-bearing-message");
    });
  }

  it("degrades to the not-configured gap when the client factory throws", async () => {
    const server = new McpServer({
      outputDir: tmpDir,
      knowledgeClientFactory: () => {
        throw new Error("factory-internal-detail");
      },
    });
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "searchSpecs", arguments: { query: "retry" } },
    });
    const raw = res!.result as any;
    const result = JSON.parse(raw.content[0].text) as KnowledgeResult;

    expect(raw.isError).toBeUndefined();
    expect(result.gaps.some((g) => /not configured/i.test(g.reason))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("factory-internal-detail");
  });

  /**
   * `query: 42` used to collapse to `""` and report "empty after sanitization",
   * which tells an agent to rephrase — so it retries the identical malformed
   * shape. The type is the problem, and CP2 has a gap that says so.
   */
  it.each([[42], [null], [{}], [[]], [true]])(
    "reports a wrong-typed query (%p) as unusable input, not as empty",
    async (badQuery) => {
      const { client } = clientWith(searchMultiPage);
      const { raw, result } = await call(serverWith(client), {
        query: badQuery,
      });

      expect(raw.isError).toBeUndefined();
      expect(result.excerpts).toEqual([]);
      expect(
        result.gaps.some((g) => /could not be interpreted/i.test(g.reason)),
      ).toBe(true);
      expect(result.gaps.some((g) => g.suggestion?.includes("must be text"))).toBe(
        true,
      );
      // The misleading answer is gone.
      expect(result.gaps.some((g) => /empty after sanitization/i.test(g.reason))).toBe(
        false,
      );
    },
  );

  // ── Excerpt shape ──────────────────────────────────────────────────────────

  it("carries lastModified and ageDays on every excerpt", async () => {
    const { client } = clientWith(searchMultiPage);
    const { result } = await call(serverWith(client), {
      query: "checkout retry policy",
    });

    expect(result.excerpts.length).toBeGreaterThan(0);
    for (const excerpt of result.excerpts) {
      expect(typeof excerpt.lastModified).toBe("number");
      expect(Number.isFinite(excerpt.lastModified)).toBe(true);
      expect(typeof excerpt.ageDays).toBe("number");
      expect(Number.isInteger(excerpt.ageDays)).toBe(true);
      expect(excerpt.ageDays).toBeGreaterThanOrEqual(0);
      expect(excerpt.url).toMatch(/^https?:\/\//);
    }
  });

  it("never leaks the API token into the tool response", async () => {
    const { client } = clientWith(searchMultiPage);
    const { raw } = await call(serverWith(client), {
      query: "checkout retry policy",
    });
    expect(JSON.stringify(raw)).not.toContain("confluence-api-token-value");
  });

  // ── spaceKeys may only narrow ──────────────────────────────────────────────

  /**
   * The safety property. `CONFLUENCE_SPACE_KEYS` is an operator ceiling; a
   * caller asking for a space outside it must not reach that space, and must be
   * told it did not.
   */
  it("denies a spaceKeys argument outside the operator allowlist", async () => {
    const { client, urls } = clientWith(searchMultiPage, ["ENG", "ARCH"]);
    const { raw, result } = await call(serverWith(client), {
      query: "checkout retry policy",
      spaceKeys: ["SECRET"],
    });

    expect(raw.isError).toBeUndefined();
    const denial = result.gaps.find((g) => g.reason.includes("SECRET"));
    expect(denial).toBeDefined();
    expect(denial!.reason).toContain("outside the operator allowlist");

    // The denied space never reached the wire; the operator ceiling did.
    const requested = decodeURIComponent(urls[0]);
    expect(requested).not.toContain("SECRET");
    expect(requested).toContain("ENG");
  });

  it("narrows to the intersection when the caller asks for a subset", async () => {
    const { client, urls } = clientWith(searchMultiPage, ["ENG", "ARCH"]);
    await call(serverWith(client), {
      query: "checkout retry policy",
      spaceKeys: ["ENG"],
    });

    const requested = decodeURIComponent(urls[0]);
    expect(requested).toContain("ENG");
    expect(requested).not.toContain("ARCH");
  });

  it("drops non-string spaceKeys entries instead of failing", async () => {
    const { client } = clientWith(searchMultiPage, ["ENG"]);
    const { raw, result } = await call(serverWith(client), {
      query: "checkout retry policy",
      spaceKeys: ["ENG", 42, null, { key: "ARCH" }],
    });

    expect(raw.isError).toBeUndefined();
    expect(result.excerpts.length).toBeGreaterThan(0);
  });

  // ── limit clamping ─────────────────────────────────────────────────────────

  it("clamps an over-max limit server-side", async () => {
    const { client, urls } = clientWith(searchMultiPage);
    await call(serverWith(client), { query: "retry", limit: 500 });
    expect(urls[0]).toContain(`limit=${MAX_SPEC_LIMIT}`);
  });

  it("clamps a zero or negative limit up to 1", async () => {
    const { client, urls } = clientWith(searchMultiPage);
    await call(serverWith(client), { query: "retry", limit: -3 });
    expect(urls[0]).toContain("limit=1");
  });

  it("falls back to the default for a non-numeric or absent limit", async () => {
    const { client, urls } = clientWith(searchMultiPage);
    await call(serverWith(client), { query: "retry" });
    await call(serverWith(client), { query: "retry", limit: "twelve" });

    expect(urls[0]).toContain(`limit=${DEFAULT_SPEC_LIMIT}`);
    expect(urls[1]).toContain(`limit=${DEFAULT_SPEC_LIMIT}`);
  });

  it("truncates a fractional limit rather than sending it on the wire", async () => {
    const { client, urls } = clientWith(searchMultiPage);
    await call(serverWith(client), { query: "retry", limit: 3.9 });
    expect(urls[0]).toContain("limit=3");
  });
});
