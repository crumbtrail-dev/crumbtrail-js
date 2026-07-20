import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import * as zlib from "node:zlib";
import { McpServer } from "../mcp-server";

/**
 * Checkpoint 2 — hierarchical lazy MCP retrieval.
 *
 * Drilldown: getSessionManifest (hot) -> getWindow (cold, bounded + capped) -> getEvidence (hot).
 * Time units are absolute ms, consistent with manifest.session.startMs/endMs and a candidate's
 * evidenceWindow.start/end.
 */
describe("MCP hierarchical retrieval", () => {
  let tmpDir: string;
  let server: McpServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-h-"));
    server = new McpServer({ outputDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function call(name: string, args: Record<string, unknown>) {
    return server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    });
  }

  async function parseResult(name: string, args: Record<string, unknown>) {
    const res = await call(name, args);
    const result = res!.result as any;
    return {
      result,
      parsed: result.isError ? undefined : JSON.parse(result.content[0].text),
    };
  }

  /** Seed a fully finalized two-plane session with hot + cold artifacts. */
  function seedSession(
    sessionId: string,
    opts: { manifest?: boolean; coldOnly?: boolean } = {},
  ) {
    const dir = path.join(tmpDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });

    const events = [
      { t: 1000, k: "nav", d: { to: "/checkout" } },
      {
        t: 1500,
        k: "clk",
        d: { el: { sig: "sig_pay_btn", tag: "button", txt: "Pay" } },
      },
      {
        t: 2000,
        k: "net.req",
        d: { id: "req_42", m: "POST", url: "/api/pay" },
      },
      { t: 2200, k: "net.res", d: { id: "req_42", st: 502 } },
      { t: 2300, k: "err", d: { msg: "payment failed" } },
      { t: 9000, k: "nav", d: { to: "/done" } },
    ];

    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: sessionId, start: 1000, app: "test-app" }),
    );

    // Cold events: plain ndjson, or zstd-compressed only (to exercise the cold path).
    const ndjson = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    if (opts.coldOnly) {
      fs.writeFileSync(
        path.join(dir, "events.ndjson.zst"),
        zlib.zstdCompressSync(Buffer.from(ndjson, "utf-8")),
      );
    } else {
      fs.writeFileSync(path.join(dir, "events.ndjson"), ndjson);
    }

    fs.writeFileSync(
      path.join(dir, "index.json"),
      JSON.stringify({
        id: sessionId,
        start: 1000,
        end: 9000,
        dur: 8000,
        evts: events.length,
        errs: [{ t: 2300, msg: "payment failed" }],
        failedReqs: [{ t: 2200, m: "POST", url: "/api/pay", st: 502 }],
        navs: [
          { t: 1000, to: "/checkout" },
          { t: 9000, to: "/done" },
        ],
        stats: { nav: 2, clk: 1, "net.req": 1, "net.res": 1, err: 1 },
      }),
    );

    const candidates = [
      {
        schemaVersion: 1,
        id: "cand_0001",
        detector: "http_error",
        title: "HTTP 502 from POST /api/pay",
        severity: "high",
        score: 90,
        confidence: "high",
        anchor: {
          t: 2200,
          offsetMs: 1200,
          route: "/checkout",
          requestId: "req_42",
          method: "POST",
          url: "/api/pay",
          status: 502,
        },
        evidenceWindow: { start: 2185, end: 47200, windowId: "win_0001" },
      },
      {
        schemaVersion: 1,
        id: "cand_0002",
        detector: "uncaught_error",
        title: "Uncaught error: payment failed",
        severity: "high",
        score: 82,
        confidence: "high",
        anchor: {
          t: 2300,
          offsetMs: 1300,
          route: "/checkout",
          message: "payment failed",
        },
        evidenceWindow: { start: 2185, end: 47200, windowId: "win_0001" },
      },
    ];
    fs.writeFileSync(
      path.join(dir, "candidates.jsonl"),
      candidates.map((c) => JSON.stringify(c)).join("\n") + "\n",
    );

    fs.writeFileSync(
      path.join(dir, "signatures.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            id: 1,
            sig: "sig_pay_btn",
            path: "button.pay",
            tag: "button",
            firstSeen: 1500,
            firstEventKind: "clk",
          },
        ],
      }),
    );

    fs.writeFileSync(
      path.join(dir, "bundle.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "crumbtrail.agent-session-bundle",
        browserEvidence: {
          interactiveElements: [
            {
              sig: "sig_pay_btn",
              path: "button.pay",
              tag: "button",
              txt: "Pay",
              count: 3,
            },
          ],
        },
      }),
    );

    if (opts.manifest !== false) {
      fs.writeFileSync(
        path.join(dir, "manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "crumbtrail.session-manifest",
          session: {
            id: sessionId,
            app: "test-app",
            startMs: 1000,
            endMs: 9000,
            durationMs: 8000,
            eventCount: events.length,
          },
          timeline: {
            eventCounts: { nav: 2, clk: 1 },
            errorMarkers: [{ t: 2300, msg: "payment failed" }],
            failedRequests: [
              { t: 2200, method: "POST", url: "/api/pay", status: 502 },
            ],
          },
          candidates: candidates.map((c) => ({
            id: c.id,
            detector: c.detector,
            severity: c.severity,
            score: c.score,
            anchor: c.anchor,
            evidenceWindow: c.evidenceWindow,
          })),
          accessPattern: ["Read manifest.json first."],
        }),
      );
    }

    return { dir, events, candidates };
  }

  it("registers the three hierarchical tools and bumps the tools/list count", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    const result = res!.result as any;
    const names = result.tools.map((t: any) => t.name);
    expect(names).toContain("getSessionManifest");
    expect(names).toContain("getWindow");
    expect(names).toContain("getEvidence");
    // 35 includes the optional getOpinion opinion retrieval tool and the
    // searchSpecs spec oracle.
    expect(result.tools).toHaveLength(35);
  });

  it("getSessionManifest returns the manifest.json payload (small, hot-plane)", async () => {
    seedSession("s1");
    const { parsed, result } = await parseResult("getSessionManifest", {
      sessionId: "s1",
    });
    expect(result.isError).toBeFalsy();
    expect(parsed.kind).toBe("crumbtrail.session-manifest");
    expect(parsed.session.startMs).toBe(1000);
    expect(parsed.candidates).toHaveLength(2);
    expect(parsed.synthesized).toBeUndefined();
    expect(result.content[0].text.length).toBeLessThan(8000);
  });

  it("getSessionManifest synthesizes a manifest from index.json when manifest.json is absent", async () => {
    seedSession("s2", { manifest: false });
    const { parsed } = await parseResult("getSessionManifest", {
      sessionId: "s2",
    });
    expect(parsed.synthesized).toBe(true);
    expect(parsed.kind).toBe("crumbtrail.session-manifest");
    expect(parsed.session.startMs).toBe(1000);
    expect(parsed.session.endMs).toBe(9000);
    expect(parsed.timeline.errorMarkers).toHaveLength(1);
    expect(parsed.candidates.map((c: any) => c.id)).toContain("cand_0001");
    expect(parsed.candidates[0]).toMatchObject({
      basis: "heuristic",
      baseScore: 90,
      score: 90,
    });
  });

  it("getSessionManifest returns isError for an unknown session", async () => {
    const { result } = await parseResult("getSessionManifest", {
      sessionId: "nope",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Session not found");
  });

  it("getWindow bounds events by [t0,t1] (absolute ms)", async () => {
    seedSession("s3");
    const { parsed } = await parseResult("getWindow", {
      sessionId: "s3",
      t0: 1400,
      t1: 2400,
    });
    expect(parsed.units).toBe("absolute-ms");
    const ts = parsed.events.map((e: any) => e.t);
    expect(ts).toEqual([1500, 2000, 2200, 2300]);
    expect(ts).not.toContain(1000);
    expect(ts).not.toContain(9000);
    expect(parsed.count).toBe(4);
    expect(parsed.truncated).toBe(false);
  });

  it("getWindow accepts swapped bounds and reads cold zstd events when ndjson is absent", async () => {
    seedSession("s3c", { coldOnly: true });
    const { parsed } = await parseResult("getWindow", {
      sessionId: "s3c",
      t0: 2400,
      t1: 1400,
    });
    const ts = parsed.events.map((e: any) => e.t);
    expect(ts).toEqual([1500, 2000, 2200, 2300]);
    expect(parsed.t0).toBe(1400);
    expect(parsed.t1).toBe(2400);
  });

  it("getWindow prefers sanitized zstd cold events over the raw append log when both exist", async () => {
    const dir = path.join(tmpDir, "s3z");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: "s3z", start: 1000 }),
    );
    fs.writeFileSync(
      path.join(dir, "events.ndjson"),
      `${JSON.stringify({ t: 1500, k: "net.req", d: { url: "/api/pay?access_token=sk_fake_rawsecretabcdefghijklmnopqrstuvwxyz" } })}\n`,
    );
    const coldNdjson = `${JSON.stringify({ t: 1500, k: "net.req", d: { url: "/api/pay?access_token=[REDACTED]" } })}\n`;
    fs.writeFileSync(
      path.join(dir, "events.ndjson.zst"),
      zlib.zstdCompressSync(Buffer.from(coldNdjson, "utf-8")),
    );

    const { parsed } = await parseResult("getWindow", {
      sessionId: "s3z",
      t0: 1400,
      t1: 1600,
    });

    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].d.url).toBe("/api/pay?access_token=[REDACTED]");
    expect(JSON.stringify(parsed)).not.toContain("sk_fake_rawsecret");
  });

  it("getWindow caps the number of events and reports truncation", async () => {
    const dir = path.join(tmpDir, "s4");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: "s4", start: 0 }),
    );
    const many = Array.from({ length: 600 }, (_, i) => ({
      t: i,
      k: "nav",
      d: {},
    }));
    fs.writeFileSync(
      path.join(dir, "events.ndjson"),
      many.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const { parsed } = await parseResult("getWindow", {
      sessionId: "s4",
      t0: 0,
      t1: 1000,
    });
    expect(parsed.count).toBe(600);
    expect(parsed.returned).toBe(500);
    expect(parsed.events).toHaveLength(500);
    expect(parsed.truncated).toBe(true);
  });

  it("getWindow returns isError for an unknown session", async () => {
    const { result } = await parseResult("getWindow", {
      sessionId: "nope",
      t0: 0,
      t1: 1,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Session not found");
  });

  it("getEvidence resolves by candidate id", async () => {
    seedSession("s5");
    const { parsed } = await parseResult("getEvidence", {
      sessionId: "s5",
      ref: "cand_0001",
    });
    expect(parsed.kind).toBe("candidate");
    expect(parsed.candidate.id).toBe("cand_0001");
    expect(parsed.anchor.t).toBe(2200);
    expect(parsed.evidenceWindow.windowId).toBe("win_0001");
  });

  it("getEvidence resolves by signature (sig) with occurrences", async () => {
    seedSession("s6");
    const { parsed } = await parseResult("getEvidence", {
      sessionId: "s6",
      ref: "sig_pay_btn",
    });
    expect(parsed.kind).toBe("signature");
    expect(parsed.signature.sig).toBe("sig_pay_btn");
    expect(parsed.signature.firstSeen).toBe(1500);
    expect(parsed.occurrences.count).toBe(3);
  });

  it("getEvidence resolves a request/event id from hot artifacts", async () => {
    seedSession("s7");
    const { parsed } = await parseResult("getEvidence", {
      sessionId: "s7",
      ref: "req_42",
    });
    expect(parsed.kind).toBe("request");
    expect(parsed.candidate.id).toBe("cand_0001");
  });

  it("getEvidence returns a small not-found payload for an unknown ref in a known session", async () => {
    seedSession("s8");
    const { parsed, result } = await parseResult("getEvidence", {
      sessionId: "s8",
      ref: "does_not_exist",
    });
    expect(result.isError).toBeFalsy();
    expect(parsed.status).toBe("not-found");
  });

  it("getEvidence returns isError for an unknown session", async () => {
    const { result } = await parseResult("getEvidence", {
      sessionId: "nope",
      ref: "cand_0001",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Session not found");
  });

  it("snake_case aliases dispatch to the same handlers", async () => {
    seedSession("s9");
    const { parsed } = await parseResult("get_session_manifest", {
      sessionId: "s9",
    });
    expect(parsed.kind).toBe("crumbtrail.session-manifest");
    const win = await parseResult("get_window", {
      sessionId: "s9",
      t0: 1400,
      t1: 2400,
    });
    expect(win.parsed.count).toBe(4);
    const ev = await parseResult("get_evidence", {
      sessionId: "s9",
      ref: "cand_0001",
    });
    expect(ev.parsed.kind).toBe("candidate");
  });

  it("full drilldown manifest -> window -> evidence stays small per step", async () => {
    seedSession("s10");
    const m = await parseResult("getSessionManifest", { sessionId: "s10" });
    const anchorT = m.parsed.candidates[0].anchor.t;
    const win = await parseResult("getWindow", {
      sessionId: "s10",
      t0: anchorT - 1000,
      t1: anchorT + 1000,
    });
    expect(win.parsed.events.length).toBeGreaterThan(0);
    const ev = await parseResult("getEvidence", {
      sessionId: "s10",
      ref: m.parsed.candidates[0].id,
    });
    expect(ev.parsed.kind).toBe("candidate");
  });
});
