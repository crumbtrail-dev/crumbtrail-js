import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { McpServer } from "../mcp-server";
import { createServer } from "../server";
import { FakeEvidenceSource } from "../evidence-sources/fake-source";
import type { EvidenceItem } from "crumbtrail-core";

// --- CP2: pipeline wiring of the evidence-source adapter phase --------------
//
// These exercise the two new behaviors: (1) sessionless "Mode A" — a ticket
// that matches NO recorded Crumbtrail session still yields a bundle populated
// purely from a client's evidence source, and (2) the blended path — session
// evidence + adapter evidence ranked through the ONE fusion path. All use the
// FakeEvidenceSource test double injected via the DI seam; no real adapters.

const tempRoots: string[] = [];

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-cp2-"));
  tempRoots.push(root);
  return root;
}

/** A neutral evidence.v1 item as a client's adapter would normalize it. */
function adapterItem(overrides: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "sentry-1",
    lane: "logs",
    kind: "sentry.error",
    brief: "TypeError: cannot read 'total' of undefined — checkout.ts",
    ref: { sig: "https://sentry.io/organizations/acme/issues/42/" },
    before: undefined,
    after: "at computeTotal (checkout.ts:88)",
    whenObserved: 1200,
    ...overrides,
  };
}

/** Seed a finalized session whose distinctBug rhymes with the checkout symptom,
 *  so locateIncident returns "matched". Mirrors server-solve-context.test.ts. */
function seedMatchingSession(root: string, name: string): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ sessionId: name }),
  );
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    [
      { t: 1100, k: "net.req", d: { id: "r1", requestId: "req-1" } },
      { t: 1200, k: "net.res", d: { id: "r1", requestId: "req-1", st: 500 } },
    ]
      .map((e) => JSON.stringify(e))
      .join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "llm.json"),
    JSON.stringify({
      distinctBugs: [
        {
          schemaVersion: 1,
          bugId: "bug-checkout",
          title: "checkout failed span error",
          severity: "high",
          firstSeen: 1000,
          lastSeen: 1200,
          window: { start: 1000, end: 1200 },
          requestIds: ["req-1"],
          representative: {
            title: "checkout failed span error",
            detector: "otel_span_error",
            severity: "high",
            message: "checkout failed span error",
            route: "/api/checkout",
            requestId: "req-1",
          },
          frontendEvidence: [],
          backendEvidence: [
            {
              candidateId: "cand-1",
              detector: "otel_span_error",
              t: 1200,
              requestId: "req-1",
              route: "/api/checkout",
              message: "checkout POST 500",
            },
          ],
          candidateIds: ["cand-1"],
        },
      ],
    }),
  );
}

function bundleFrom(res: Awaited<ReturnType<McpServer["handleMessage"]>>): any {
  const result = res!.result as any;
  return JSON.parse(result.content[0].text);
}

afterEach(() => {
  for (const root of tempRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("solveContext MCP tool — sessionless Mode A (adapter-only bundle)", () => {
  it("populates the bundle PURELY from an evidence source when no session matches", async () => {
    const root = makeRoot(); // empty store → locate is inconclusive
    const fake = new FakeEvidenceSource({
      provider: "sentry",
      items: [adapterItem()],
    });
    const server = new McpServer({
      outputDir: root,
      evidenceSourcesFactory: () => [fake],
    });

    const bundle = bundleFrom(
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "solveContext",
          arguments: { symptom: { title: "checkout total crash" } },
        },
      }),
    );

    // Bundle is populated entirely from the adapter — no session-derived items.
    expect(bundle.evidence).toHaveLength(1);
    expect(bundle.evidence[0].id).toBe("sentry-1");
    expect(bundle.evidence.every((e: any) => !e.ref.sessionId)).toBe(true);
    // Its gaps MUST state that no Crumbtrail session matched.
    expect(
      bundle.gaps.some((g: any) =>
        g.reason.includes("no recorded session matched"),
      ),
    ).toBe(true);
    // The adapter was queried; a sessionless window was derived (no sessionId key).
    expect(fake.fetchCalls).toBe(1);
    expect(fake.lastQuery?.keys.sessionId).toBeUndefined();
    expect(fake.lastQuery?.window.end).toBeGreaterThan(
      fake.lastQuery!.window.start,
    );
  });

  it("does NOT double-report: exactly one no-session gap in an adapter-only bundle", async () => {
    const root = makeRoot();
    const server = new McpServer({
      outputDir: root,
      evidenceSourcesFactory: () => [
        new FakeEvidenceSource({ provider: "sentry", items: [adapterItem()] }),
      ],
    });

    const bundle = bundleFrom(
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "solveContext",
          arguments: { symptom: { title: "checkout total crash" } },
        },
      }),
    );

    const noSessionGaps = bundle.gaps.filter((g: any) =>
      g.reason.includes("no recorded session"),
    );
    expect(noSessionGaps).toHaveLength(1);
  });
});

describe("solveContext MCP tool — blended (session + adapter) evidence", () => {
  it("ranks session + adapter evidence through the one fusion path", async () => {
    const root = makeRoot();
    seedMatchingSession(root, "sess-incident");
    const fake = new FakeEvidenceSource({
      provider: "sentry",
      items: [adapterItem()],
    });
    const server = new McpServer({
      outputDir: root,
      evidenceSourcesFactory: () => [fake],
    });

    const bundle = bundleFrom(
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "solveContext",
          arguments: {
            symptom: {
              title: "checkout failed span error",
              url: "/api/checkout",
              errorSig: "otel_span_error",
            },
          },
        },
      }),
    );

    const ids = bundle.evidence.map((e: any) => e.id);
    // Both a session-derived item and the adapter item are present, exactly once.
    expect(ids).toContain("sentry-1");
    expect(
      bundle.evidence.some((e: any) => e.ref.sessionId === "sess-incident"),
    ).toBe(true);
    expect(ids.filter((id: string) => id === "sentry-1")).toHaveLength(1);
    // A matched locate does NOT emit the no-session gap.
    expect(
      bundle.gaps.some((g: any) =>
        g.reason.includes("no recorded session matched"),
      ),
    ).toBe(false);
    // The adapter received the located window's correlation keys.
    expect(fake.lastQuery?.keys.sessionId).toBe("sess-incident");
    expect(fake.lastQuery?.keys.requestId).toBe("req-1");
    expect(fake.lastQuery?.keys.traceId).toBe("req-1");
  });
});

describe("solveContext MCP tool — ambiguous locate", () => {
  it("carries candidates without selecting or citing either session", async () => {
    const root = makeRoot();
    seedMatchingSession(root, "session-one");
    seedMatchingSession(root, "session-two");
    const server = new McpServer({
      outputDir: root,
      evidenceSourcesFactory: () => [],
    });

    const bundle = bundleFrom(
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "solveContext",
          arguments: {
            symptom: {
              title: "checkout failed span error",
              url: "/api/checkout",
              errorSig: "otel_span_error",
            },
          },
        },
      }),
    );

    expect(bundle.located.outcome).toBe("ambiguous");
    expect(bundle.located.sessionId).toBeUndefined();
    expect(bundle.located.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "session-one" }),
        expect.objectContaining({ sessionId: "session-two" }),
      ]),
    );
    expect(bundle.evidence).toEqual([]);
    expect(
      bundle.gaps.some((gap: any) =>
        gap.reason.includes(
          "multiple candidate sessions scored within the decision margin",
        ),
      ),
    ).toBe(true);
  });
});

describe("solveContext MCP tool — no regression / advisory", () => {
  it("with ZERO sources configured, a no-session request is identical to today", async () => {
    const root = makeRoot();
    const server = new McpServer({
      outputDir: root,
      evidenceSourcesFactory: () => [],
    });

    const bundle = bundleFrom(
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "solveContext",
          arguments: { symptom: { title: "checkout total crash" } },
        },
      }),
    );

    expect(bundle.evidence).toEqual([]);
    expect(bundle.gaps).toHaveLength(1);
  });

  it("a failing source degrades to a gap; the bundle still assembles", async () => {
    const root = makeRoot();
    const server = new McpServer({
      outputDir: root,
      evidenceSourcesFactory: () => [
        new FakeEvidenceSource({
          provider: "sentry",
          error: new Error("401 unauthorized"),
        }),
      ],
    });

    const bundle = bundleFrom(
      await server.handleMessage({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "solveContext",
          arguments: { symptom: { title: "checkout total crash" } },
        },
      }),
    );

    expect(bundle.schemaVersion).toBe("fusion.v1");
    expect(bundle.gaps.some((g: any) => g.reason.includes("sentry"))).toBe(
      true,
    );
  });
});

describe("inner /api/solve-context — adapter phase (cloud webhook picks up for free)", () => {
  let server: http.Server;
  let tmpRoot: string;
  const AUTH = "cp2-inner-token";

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-cp2-inner-"));
    const outputDir = path.join(tmpRoot, "sessions");
    fs.mkdirSync(outputDir, { recursive: true });
    server = createServer({
      port: 0,
      outputDir,
      authToken: AUTH,
      // Same DI seam the McpServer uses; the cloud forwardSolveContext path
      // reaches this endpoint over HTTP and thus inherits the adapter phase.
      evidenceSourcesFactory: () => [
        new FakeEvidenceSource({ provider: "sentry", items: [adapterItem()] }),
      ],
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("returns an adapter-only bundle with a no-session gap for a no-match ticket", async () => {
    const addr = server.address() as { port: number };
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/solve-context`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Crumbtrail-Auth": AUTH,
      },
      body: JSON.stringify({ symptom: { title: "checkout total crash" } }),
    });
    const body = (await res.json()) as any;

    expect(res.status).toBe(200);
    expect(body.match.outcome).toBe("inconclusive");
    expect(body.bundle.evidence).toHaveLength(1);
    expect(body.bundle.evidence[0].id).toBe("sentry-1");
    expect(
      body.bundle.gaps.some((g: any) =>
        g.reason.includes("no recorded session matched"),
      ),
    ).toBe(true);
  });
});
