import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { McpServer } from "../mcp-server";
import { computeDistinctBugSignatures } from "../index";
import { postProcess } from "../post-process";
import { buildFixContext } from "../fix-context";
import { runFixContext } from "../run-fix-context";
import { BUDGET_SLACK_TOKENS, estimateTokens } from "../token-estimate";
import { FakeEvidenceSource } from "../evidence-sources/fake-source";
import type { EvidenceItem } from "crumbtrail-core";

describe("MCP Server", () => {
  let tmpDir: string;
  let server: McpServer;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-"));
    server = new McpServer({ outputDir: tmpDir });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createSession(
    sessionId: string,
    events: any[],
    indexOverrides: Record<string, any> = {},
  ) {
    const sessionDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.join(sessionDir, "frames"), { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "meta.json"),
      JSON.stringify({ id: sessionId, start: 1000, app: "test-app" }),
    );
    if (events.length) {
      fs.writeFileSync(
        path.join(sessionDir, "events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    }
    // Build index.json
    const errs = events
      .filter((e) => e.k === "err" || e.k === "rej")
      .map((e) => ({ t: e.t, msg: e.d.msg || "" }));
    const navs = events
      .filter((e) => e.k === "nav")
      .map((e) => ({ t: e.t, to: e.d.to || "" }));
    const failedReqs = events
      .filter(
        (e) => e.k === "net.res" && typeof e.d.st === "number" && e.d.st >= 400,
      )
      .map((e) => ({ t: e.t, m: "GET", url: "/fail", st: e.d.st }));
    const stats: Record<string, number> = {};
    for (const e of events) {
      stats[e.k] = (stats[e.k] || 0) + 1;
    }
    const start = events[0]?.t || 0;
    const end = events[events.length - 1]?.t || 0;
    const frames = [
      { t: 1000, file: "frame-1000.jpg" },
      { t: 2000, file: "frame-2000.jpg" },
    ];
    fs.writeFileSync(
      path.join(sessionDir, "index.json"),
      JSON.stringify({
        id: sessionId,
        start,
        end,
        dur: end - start,
        evts: events.length,
        errs,
        failedReqs,
        navs,
        stats,
        frames,
        ...indexOverrides,
      }),
    );
  }

  it("initialize returns correct protocol version and server info", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
    });
    expect(res).not.toBeNull();
    expect(res!.id).toBe(1);
    const result = res!.result as any;
    expect(result.protocolVersion).toBe("2024-11-05");
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.serverInfo.name).toBe("crumbtrail-mcp");
    expect(result.serverInfo.version).toBe("0.1.0");
  });

  it("initialized notification returns null", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      method: "initialized",
    });
    expect(res).toBeNull();
  });

  it("notifications/initialized returns null", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(res).toBeNull();
  });

  it("tools/list returns all tools", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(res).not.toBeNull();
    const result = res!.result as any;
    expect(result.tools).toHaveLength(37);
    const names = result.tools.map((t: any) => t.name);
    expect(names).toContain("listSessions");
    expect(names).toContain("getFixContext");
    expect(names).toContain("getOpinion");
    expect(names).toContain("getLatestIssue");
    expect(names).toContain("getRegressionContext");
    expect(names).toContain("listDistinctBugs");
    expect(names).toContain("getRecurrence");
    expect(names).toContain("getBug");
    expect(names).toContain("resolveSignature");
    expect(names).toContain("locateInteractiveElements");
    expect(names).toContain("getSessionManifest");
    expect(names).toContain("getWindow");
    expect(names).toContain("getEvidence");
    expect(names).toContain("getIndex");
    expect(names).toContain("getEvents");
    expect(names).toContain("getErrorContext");
    expect(names).toContain("getFailedRequests");
    expect(names).toContain("getLinkedRequestContext");
    expect(names).toContain("getStorageSnapshot");
    expect(names).toContain("getCookieChanges");
    expect(names).toContain("getStorageChanges");
    expect(names).toContain("getTranscript");
    expect(names).toContain("getFrame");
    expect(names).toContain("getFrameById");
    expect(names).toContain("listBugs");
    expect(names).toContain("getBugReport");
    expect(names).toContain("getBugEvents");
    expect(names).toContain("getBugErrorContext");
    expect(names).toContain("getBugFailedRequests");
    expect(names).toContain("getBugVoiceTranscript");
    expect(names).toContain("getBugLLMContext");
    expect(names).toContain("resolveIssue");
    expect(names).toContain("recordFeedback");
    expect(names).toContain("getPlaybook");
    expect(names).not.toContain("resolveBug");

    const linkedTool = result.tools.find(
      (t: any) => t.name === "getLinkedRequestContext",
    );
    expect(linkedTool).toBeDefined();
    expect(linkedTool.inputSchema.required).toEqual(["sessionId", "requestId"]);
    expect(linkedTool.inputSchema.properties.sessionId).toMatchObject({
      type: "string",
    });
    expect(linkedTool.inputSchema.properties.requestId).toMatchObject({
      type: "string",
    });
  });

  it("returns opinion hypotheses, evidence references, and unknowns over MCP", async () => {
    createSession("sess-opinion", []);
    fs.writeFileSync(
      path.join(tmpDir, "sess-opinion", "opinion.json"),
      JSON.stringify({
        schemaVersion: "opinion.v1",
        hypotheses: [
          {
            rank: 1,
            title: "The save request failed",
            confidence: "high",
            evidence_refs: ["cand_0001", "req_1"],
          },
        ],
        unknowns: ["Whether a retry succeeded"],
      }),
    );

    const response = await server.handleMessage({
      jsonrpc: "2.0",
      id: "opinion",
      method: "tools/call",
      params: { name: "getOpinion", arguments: { sessionId: "sess-opinion" } },
    });
    const result = response!.result as any;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      hypotheses: [
        {
          confidence: "high",
          evidence_refs: ["cand_0001", "req_1"],
        },
      ],
      unknowns: ["Whether a retry succeeded"],
    });

    const aliasResponse = await server.handleMessage({
      jsonrpc: "2.0",
      id: "opinion-alias",
      method: "tools/call",
      params: { name: "get_opinion", arguments: { sessionId: "sess-opinion" } },
    });
    expect((aliasResponse!.result as any).isError).toBeUndefined();

    createSession("sess-no-opinion", []);
    const missingResponse = await server.handleMessage({
      jsonrpc: "2.0",
      id: "opinion-missing",
      method: "tools/call",
      params: {
        name: "getOpinion",
        arguments: { sessionId: "sess-no-opinion" },
      },
    });
    const missing = missingResponse!.result as any;
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toBe(
      "No opinion generated yet for this session.",
    );
  });

  async function createFinalizedBugSession(sessionId: string) {
    const sessionDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, "meta.json"),
      JSON.stringify({ id: sessionId, start: 1000, app: "test-app" }),
    );
    const events = [
      { t: 1000, k: "clk", d: { el: { tag: "BUTTON", txt: "Pay" } } },
      {
        t: 1100,
        k: "net.req",
        d: { id: "r1", method: "POST", url: "/api/pay" },
      },
      { t: 1200, k: "net.res", d: { id: "r1", st: 500, dur: 100 } },
      {
        t: 1300,
        k: "con",
        d: { lv: "err", msg: "Cannot read properties of undefined" },
      },
    ];
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(sessionDir);
  }

  function createSessionWithDistinctBug(
    sessionId: string,
    options: {
      title?: string;
      message?: string;
      route?: string;
      release?: string;
      build?: string;
      app?: string;
      tenant?: string;
      bugId?: string;
      start?: number;
    } = {},
  ) {
    const sessionDir = path.join(tmpDir, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const meta = {
      id: sessionId,
      start: options.start ?? 1_800_000_000_000,
      app: options.app ?? "billing",
      tenant: options.tenant ?? "acme",
      release: options.release,
      build: options.build,
    };
    fs.writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify(meta));
    const bug = {
      schemaVersion: 1,
      bugId: options.bugId ?? `bug_${sessionId}`,
      title: options.title ?? "Wrong invoice rank",
      severity: "high",
      firstSeen: 100,
      lastSeen: 250,
      window: { start: 100, end: 250 },
      requestIds: [`req-${sessionId}`],
      representative: {
        title: options.title ?? "Wrong invoice rank",
        detector: "db_mutation",
        severity: "high",
        message: options.message ?? "Invoice 123 ranked 3 instead of 1",
        route: options.route ?? "/jobs/invoice-digest",
        requestId: `req-${sessionId}`,
      },
      frontendEvidence: [],
      backendEvidence: [],
      dbDiffs: [],
      candidateIds: [`cand-${sessionId}`],
    };
    fs.writeFileSync(
      path.join(sessionDir, "llm.json"),
      JSON.stringify({ distinctBugs: [bug] }),
    );
    return sessionDir;
  }

  it("listDistinctBugs returns the grouped distinct bugs from a finalized session", async () => {
    await createFinalizedBugSession("sess-bugs");

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 50,
      method: "tools/call",
      params: {
        name: "listDistinctBugs",
        arguments: { sessionId: "sess-bugs" },
      },
    });
    const bugs = JSON.parse((res!.result as any).content[0].text);
    expect(Array.isArray(bugs)).toBe(true);
    expect(bugs.length).toBeGreaterThanOrEqual(2);
    const httpBug = bugs.find((b: any) => b.severity === "high");
    expect(httpBug).toBeDefined();
    expect(httpBug.bugId).toMatch(/^bug_/);
    expect(httpBug.signature).toMatch(/^bugsig2:/);
    expect(httpBug.counts.candidates).toBeGreaterThanOrEqual(1);
    expect(httpBug).toHaveProperty("window");
    // Sorted severity desc: the high-severity bug comes before any medium ones.
    expect(bugs[0].severity).toBe("high");
  });

  it("listDistinctBugs cross-session mode rolls up recurring signatures across releases", async () => {
    createSessionWithDistinctBug("sess-r1a", {
      release: "R181",
      build: "a",
      message: "Invoice 123 ranked 3 instead of 1",
    });
    createSessionWithDistinctBug("sess-r1b", {
      release: "R182",
      build: "b",
      message: "Invoice 456 ranked 3 instead of 1",
    });
    createSessionWithDistinctBug("sess-r1c", {
      release: "R182",
      build: "c",
      message: "Invoice 789 ranked 3 instead of 1",
    });
    createSessionWithDistinctBug("sess-other", {
      release: "R182",
      build: "d",
      title: "Expired coupon crash",
      message: "Expired coupon failed",
      route: "/checkout",
      bugId: "bug_other",
    });

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 54,
      method: "tools/call",
      params: {
        name: "listDistinctBugs",
        arguments: { mode: "cross-session" },
      },
    });

    const recurrences = JSON.parse((res!.result as any).content[0].text);
    expect(recurrences).toHaveLength(2);
    expect(recurrences[0]).toMatchObject({
      session_count: 3,
      release_span: { first: "R181", last: "R182", label: "R181->R182" },
      apps: ["billing"],
      tenants: ["acme"],
    });
    expect(
      recurrences[0].occurrences
        .map((occurrence: any) => occurrence.sessionId)
        .sort(),
    ).toEqual(["sess-r1a", "sess-r1b", "sess-r1c"]);
    expect(recurrences[1].session_count).toBe(1);
  });

  it("getRecurrence returns one recurrence by signature", async () => {
    createSessionWithDistinctBug("sess-r2a", {
      release: "R181",
      message: "Invoice 123 ranked 3 instead of 1",
    });
    createSessionWithDistinctBug("sess-r2b", {
      release: "R183",
      message: "Invoice 456 ranked 3 instead of 1",
    });

    const list = await server.handleMessage({
      jsonrpc: "2.0",
      id: 55,
      method: "tools/call",
      params: {
        name: "listDistinctBugs",
        arguments: { mode: "cross-session" },
      },
    });
    const [rollup] = JSON.parse((list!.result as any).content[0].text);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 56,
      method: "tools/call",
      params: {
        name: "getRecurrence",
        arguments: { signature: rollup.signature },
      },
    });

    const recurrence = JSON.parse((res!.result as any).content[0].text);
    expect(recurrence.signature).toBe(rollup.signature);
    expect(recurrence.session_count).toBe(2);
    expect(recurrence.release_span.label).toBe("R181->R183");
  });

  it("getRecurrence resolves a legacy signature saved before the upgrade", async () => {
    const sessionDir = createSessionWithDistinctBug("sess-legacy-signature", {
      release: "R181",
      message: "Invoice 123 ranked 3 instead of 1",
    });
    const { distinctBugs } = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "llm.json"), "utf8"),
    );
    const signatures = computeDistinctBugSignatures(distinctBugs[0]);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 57,
      method: "tools/call",
      params: {
        name: "getRecurrence",
        arguments: { signature: signatures.legacy },
      },
    });

    const recurrence = JSON.parse((res!.result as any).content[0].text);
    expect(recurrence.signature).toBe(signatures.current);
    expect(recurrence.session_count).toBe(1);
  });

  it("getBug returns the full correlated evidence for one distinct bug", async () => {
    await createFinalizedBugSession("sess-getbug");

    const list = await server.handleMessage({
      jsonrpc: "2.0",
      id: 51,
      method: "tools/call",
      params: {
        name: "listDistinctBugs",
        arguments: { sessionId: "sess-getbug" },
      },
    });
    const bugs = JSON.parse((list!.result as any).content[0].text);
    const bugId = bugs[0].bugId;

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 52,
      method: "tools/call",
      params: {
        name: "getBug",
        arguments: { sessionId: "sess-getbug", bugId },
      },
    });
    const bug = JSON.parse((res!.result as any).content[0].text);
    expect(bug.bugId).toBe(bugId);
    expect(bug.schemaVersion).toBe(1);
    expect(Array.isArray(bug.candidateIds)).toBe(true);
    expect(Array.isArray(bug.frontendEvidence)).toBe(true);
    expect(bug).toHaveProperty("representative");
  });

  it("getBug returns an error result for an unknown bugId", async () => {
    await createFinalizedBugSession("sess-nobug");
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 53,
      method: "tools/call",
      params: {
        name: "getBug",
        arguments: { sessionId: "sess-nobug", bugId: "bug_does_not_exist" },
      },
    });
    const result = res!.result as any;
    expect(result.isError).toBe(true);
  });

  it("listSessions returns sessions from output dir", async () => {
    createSession("sess-1", [{ t: 1000, k: "nav", d: { to: "/home" } }]);
    createSession("sess-2", [{ t: 2000, k: "nav", d: { to: "/about" } }]);
    const partitionedDir = path.join(
      tmpDir,
      "acme",
      "checkout",
      "2026-06-30",
      "sess-3",
    );
    fs.mkdirSync(partitionedDir, { recursive: true });
    fs.writeFileSync(
      path.join(partitionedDir, "meta.json"),
      JSON.stringify({ id: "sess-3", start: 3000, app: "test-app" }),
    );
    const metadataWithoutId = path.join(tmpDir, "sess-store-id-fallback");
    fs.mkdirSync(metadataWithoutId, { recursive: true });
    fs.writeFileSync(
      path.join(metadataWithoutId, "meta.json"),
      JSON.stringify({ start: 3500, app: "test-app" }),
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "listSessions", arguments: {} },
    });
    const result = res!.result as any;
    const sessions = JSON.parse(result.content[0].text);
    expect(sessions.map((session: any) => session.id).sort()).toEqual([
      "sess-1",
      "sess-2",
      "sess-3",
      "sess-store-id-fallback",
    ]);
  });

  it("listSessions filters by app", async () => {
    createSession("sess-1", [{ t: 1000, k: "nav", d: { to: "/home" } }]);
    // Create a session with a different app
    const dir = path.join(tmpDir, "sess-other");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: "sess-other", start: 1000, app: "other-app" }),
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "listSessions", arguments: { app: "test-app" } },
    });
    const result = res!.result as any;
    const sessions = JSON.parse(result.content[0].text);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].app).toBe("test-app");
  });

  it("listSessions filters by release and build metadata aliases", async () => {
    createSession("sess-1", [{ t: 1000, k: "nav", d: { to: "/home" } }]);
    const releaseDir = path.join(tmpDir, "sess-release");
    fs.mkdirSync(releaseDir, { recursive: true });
    fs.writeFileSync(
      path.join(releaseDir, "meta.json"),
      JSON.stringify({
        id: "sess-release",
        start: 2000,
        app: "test-app",
        release: "R182",
        commit: "abc123",
      }),
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 41,
      method: "tools/call",
      params: {
        name: "listSessions",
        arguments: { release: "R182", build: "abc123" },
      },
    });
    const result = res!.result as any;
    const sessions = JSON.parse(result.content[0].text);
    expect(sessions.map((session: any) => session.id)).toEqual([
      "sess-release",
    ]);
  });

  it("listSessions surfaces normalized release/build on each row from any alias", async () => {
    const dir = path.join(tmpDir, "sess-aliased");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        id: "sess-aliased",
        start: 5000,
        app: "test-app",
        version: "R192",
        commit: "deadbeef",
      }),
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/call",
      params: { name: "listSessions", arguments: { app: "test-app" } },
    });
    const result = res!.result as any;
    const sessions = JSON.parse(result.content[0].text);
    const row = sessions.find((session: any) => session.id === "sess-aliased");
    // release/build are first-class on the compact row even though the app used
    // the `version`/`commit` aliases; raw aliases stay out of list views.
    expect(row.release).toBe("R192");
    expect(row.build).toBe("deadbeef");
    expect(row.version).toBeUndefined();
    expect(row.commit).toBeUndefined();
  });

  it("getIndex returns index.json contents for a session", async () => {
    createSession("sess-idx", [
      { t: 1000, k: "nav", d: { to: "/home" } },
      { t: 2000, k: "err", d: { msg: "boom" } },
    ]);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "getIndex", arguments: { sessionId: "sess-idx" } },
    });
    const result = res!.result as any;
    const index = JSON.parse(result.content[0].text);
    expect(index.id).toBe("sess-idx");
    expect(index.evts).toBe(2);
    expect(index.errs).toHaveLength(1);
  });

  it("getIndex resolves finalized v2 partition paths by session id", async () => {
    const sessionId = "sess-partitioned-index";
    const partitionedDir = path.join(
      tmpDir,
      "acme",
      "checkout",
      "2026-06-30",
      sessionId,
    );
    fs.mkdirSync(partitionedDir, { recursive: true });
    fs.writeFileSync(
      path.join(partitionedDir, "meta.json"),
      JSON.stringify({ id: sessionId, start: 1000, app: "checkout" }),
    );
    fs.writeFileSync(
      path.join(partitionedDir, "index.json"),
      JSON.stringify({ id: sessionId, evts: 1, errs: [] }),
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: { name: "getIndex", arguments: { sessionId } },
    });
    const result = res!.result as any;
    const index = JSON.parse(result.content[0].text);
    expect(index.id).toBe(sessionId);
    expect(index.evts).toBe(1);
  });

  it("getEvents returns all events for a session", async () => {
    const events = [
      { t: 1000, k: "nav", d: { to: "/home" } },
      { t: 1500, k: "click", d: { x: 10, y: 20 } },
      { t: 2000, k: "err", d: { msg: "fail" } },
    ];
    createSession("sess-ev", events);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: { name: "getEvents", arguments: { sessionId: "sess-ev" } },
    });
    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(3);
  });

  it("getEvents filters by kind", async () => {
    const events = [
      { t: 1000, k: "nav", d: { to: "/home" } },
      { t: 1500, k: "click", d: { x: 10 } },
      { t: 2000, k: "nav", d: { to: "/about" } },
    ];
    createSession("sess-filt", events);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "getEvents",
        arguments: { sessionId: "sess-filt", kind: "nav" },
      },
    });
    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((e: any) => e.k === "nav")).toBe(true);
  });

  it("getEvents filters by time range", async () => {
    const events = [
      { t: 1000, k: "nav", d: {} },
      { t: 2000, k: "nav", d: {} },
      { t: 3000, k: "nav", d: {} },
      { t: 4000, k: "nav", d: {} },
    ];
    createSession("sess-time", events);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "getEvents",
        arguments: { sessionId: "sess-time", after: 1500, before: 3500 },
      },
    });
    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].t).toBe(2000);
    expect(parsed[1].t).toBe(3000);
  });

  it("getEvents respects limit", async () => {
    const events = Array.from({ length: 10 }, (_, i) => ({
      t: 1000 + i * 100,
      k: "nav",
      d: {},
    }));
    createSession("sess-limit", events);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "getEvents",
        arguments: { sessionId: "sess-limit", limit: 3 },
      },
    });
    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(3);
  });

  it("getEvents clamps malformed limits to a safe integer range", async () => {
    createSession(
      "sess-safe-limit",
      Array.from({ length: 600 }, (_, i) => ({ t: i, k: "nav", d: {} })),
    );
    for (const [limit, expected] of [
      [9999, 500],
      [-4, 1],
      [3.9, 3],
    ]) {
      const res = await server.handleMessage({
        jsonrpc: "2.0",
        id: `safe-limit-${limit}`,
        method: "tools/call",
        params: {
          name: "getEvents",
          arguments: { sessionId: "sess-safe-limit", limit },
        },
      });
      expect(JSON.parse((res!.result as any).content[0].text)).toHaveLength(
        expected,
      );
    }
  });

  it("getErrorContext returns error events with surrounding context", async () => {
    const events = [
      { t: 1000, k: "nav", d: { to: "/home" } },
      { t: 1500, k: "click", d: {} },
      { t: 2000, k: "err", d: { msg: "boom" } },
      { t: 2500, k: "nav", d: { to: "/error" } },
      { t: 5000, k: "click", d: {} },
    ];
    createSession("sess-ctx", events);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "getErrorContext",
        arguments: { sessionId: "sess-ctx", windowMs: 1000 },
      },
    });
    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].error.k).toBe("err");
    // Context should include events within 1000ms of t=2000 -> [1000, 3000]
    expect(parsed[0].context).toHaveLength(4); // t=1000, 1500, 2000, 2500
    // t=5000 should be excluded
    expect(parsed[0].context.find((e: any) => e.t === 5000)).toBeUndefined();
  });

  it("bounds error contexts and reports token-budget drops", async () => {
    createSession(
      "sess-bounded-context",
      Array.from({ length: 150 }, (_, i) => ({
        t: i,
        k: i % 2 === 0 ? "err" : "nav",
        d: { msg: `event-${i}` },
      })),
    );
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: "bounded-context",
      method: "tools/call",
      params: {
        name: "getErrorContext",
        arguments: {
          sessionId: "sess-bounded-context",
          limit: 2,
          maxTokens: 1,
        },
      },
    });
    const parsed = JSON.parse((res!.result as any).content[0].text);
    expect(parsed.contexts).toEqual([]);
    expect(parsed.dropReport).toBeDefined();
  });

  it("getFailedRequests returns failed requests", async () => {
    const events = [
      { t: 1000, k: "net.res", d: { st: 200, id: "r1" } },
      { t: 2000, k: "net.res", d: { st: 404, id: "r2" } },
      { t: 3000, k: "net.res", d: { st: 500, id: "r3" } },
    ];
    createSession("sess-fail", events);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "getFailedRequests",
        arguments: { sessionId: "sess-fail" },
      },
    });
    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
  });

  it("bounds failed requests and reports token-budget drops", async () => {
    createSession(
      "sess-bounded-failed",
      Array.from({ length: 10 }, (_, i) => ({
        t: i,
        k: "net.res",
        d: { st: 500, id: `r${i}` },
      })),
    );
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: "bounded-failed",
      method: "tools/call",
      params: {
        name: "getFailedRequests",
        arguments: { sessionId: "sess-bounded-failed", limit: 2, maxTokens: 1 },
      },
    });
    const parsed = JSON.parse((res!.result as any).content[0].text);
    expect(parsed.requests).toEqual([]);
    expect(parsed.dropReport).toBeDefined();
  });

  it("getLinkedRequestContext returns linked full-stack request evidence from the index", async () => {
    const sessionId = "sess-linked";
    const requestId = "req-linked";
    createSession(
      sessionId,
      [{ t: 1000, k: "net.req", d: { requestId, sessionId } }],
      {
        fullStackRequests: {
          schemaVersion: 1,
          summary: {
            frontendRequests: 1,
            backendRequests: 1,
            linked: 1,
            gaps: 0,
            gapTypes: {},
          },
          linked: [
            {
              requestId,
              sessionId,
              frontend: {
                ref: { t: 1000, k: "net.req" },
                requestId,
                sessionId,
                method: "POST",
                url: "/api/checkout?token=%5BREDACTED%5D",
                status: 502,
                durationMs: 60,
              },
              backend: {
                requestId,
                sessionId,
                correlation: {
                  status: "linked",
                  sessionIdSource: "header",
                  requestIdSource: "header",
                },
                start: { t: 1010, k: "backend.req.start" },
                end: { t: 1050, k: "backend.req.end" },
                errorRef: { t: 1040, k: "backend.req.error" },
                method: "POST",
                url: "/api/checkout?api_key=%5BREDACTED%5D",
                pathname: "/api/checkout",
                route: "/api/checkout",
                statusCode: 502,
                durationMs: 40,
                error: {
                  name: "UpstreamError",
                  code: "UPSTREAM_FAILED",
                  message: "[REDACTED]",
                },
              },
            },
          ],
          gaps: [],
        },
      },
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 111,
      method: "tools/call",
      params: {
        name: "getLinkedRequestContext",
        arguments: { sessionId, requestId },
      },
    });

    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      sessionId,
      requestId,
      status: "linked",
      correlationStatus: "linked",
      summary: {
        frontendRequests: 1,
        backendRequests: 1,
        linked: 1,
        gaps: 0,
      },
      linked: {
        requestId,
        sessionId,
        frontend: {
          ref: { t: 1000, k: "net.req" },
          method: "POST",
          url: "/api/checkout?token=%5BREDACTED%5D",
          status: 502,
          durationMs: 60,
        },
        backend: {
          start: { t: 1010, k: "backend.req.start" },
          end: { t: 1050, k: "backend.req.end" },
          errorRef: { t: 1040, k: "backend.req.error" },
          correlation: {
            status: "linked",
            sessionIdSource: "header",
            requestIdSource: "header",
          },
          statusCode: 502,
          error: { code: "UPSTREAM_FAILED" },
        },
      },
      gaps: [],
      diagnostics: [
        "Linked full-stack request evidence found in index.fullStackRequests.",
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("supersecret");
  });

  it("getLinkedRequestContext returns partial diagnostics for request gaps", async () => {
    const sessionId = "sess-gap";
    const requestId = "req-gap";
    createSession(
      sessionId,
      [{ t: 1000, k: "net.req", d: { requestId, sessionId } }],
      {
        fullStackRequests: {
          schemaVersion: 1,
          summary: {
            frontendRequests: 1,
            backendRequests: 0,
            linked: 0,
            gaps: 1,
            gapTypes: { "frontend-only": 1 },
          },
          linked: [],
          gaps: [
            {
              type: "frontend-only",
              requestId,
              sessionId,
              frontend: {
                ref: { t: 1000, k: "net.req" },
                requestId,
                sessionId,
                method: "GET",
                url: "/api/orders?token=%5BREDACTED%5D",
              },
            },
          ],
        },
      },
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 112,
      method: "tools/call",
      params: {
        name: "getLinkedRequestContext",
        arguments: { sessionId, requestId },
      },
    });

    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("partial");
    expect(parsed.linked).toBeUndefined();
    expect(parsed.gaps).toHaveLength(1);
    expect(parsed.gaps[0]).toMatchObject({
      type: "frontend-only",
      requestId,
      sessionId,
    });
    expect(parsed.diagnostics.join(" ")).toMatch(/partial|missing|incomplete/i);
  });

  it("getLinkedRequestContext returns unavailable when full-stack evidence is missing", async () => {
    const sessionId = "sess-no-model";
    const requestId = "req-any";
    createSession(sessionId, [
      { t: 1000, k: "net.req", d: { requestId, sessionId } },
    ]);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 113,
      method: "tools/call",
      params: {
        name: "getLinkedRequestContext",
        arguments: { sessionId, requestId },
      },
    });

    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({
      sessionId,
      requestId,
      status: "unavailable",
      gaps: [],
    });
    expect(parsed.linked).toBeUndefined();
    expect(parsed.diagnostics.join(" ")).toMatch(
      /no full-stack request evidence generated|No full-stack request evidence was generated/i,
    );
  });

  it("getLinkedRequestContext returns not-found when no linked entry or gap matches", async () => {
    const sessionId = "sess-not-found";
    createSession(
      sessionId,
      [{ t: 1000, k: "net.req", d: { requestId: "req-known", sessionId } }],
      {
        fullStackRequests: {
          schemaVersion: 1,
          summary: {
            frontendRequests: 1,
            backendRequests: 0,
            linked: 0,
            gaps: 1,
            gapTypes: { "frontend-only": 1 },
          },
          linked: [],
          gaps: [{ type: "frontend-only", requestId: "req-known", sessionId }],
        },
      },
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 114,
      method: "tools/call",
      params: {
        name: "getLinkedRequestContext",
        arguments: { sessionId, requestId: "req-missing" },
      },
    });

    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("not-found");
    expect(parsed.gaps).toEqual([]);
    expect(parsed.linked).toBeUndefined();
    expect(parsed.diagnostics.join(" ")).toMatch(
      /no linked full-stack request or gap entry matched|correlation IDs/i,
    );
  });

  it("getLinkedRequestContext keeps linked and gap responses redaction-safe and bounded", async () => {
    const sessionId = "sess-redacted";
    const requestId = "req-redacted";
    createSession(
      sessionId,
      [{ t: 1000, k: "net.req", d: { requestId, sessionId } }],
      {
        fullStackRequests: {
          schemaVersion: 1,
          summary: {
            frontendRequests: 1,
            backendRequests: 1,
            linked: 1,
            gaps: 1,
            gapTypes: { "backend-only": 1 },
          },
          linked: [
            {
              requestId,
              sessionId,
              frontend: {
                ref: { t: 1000, k: "net.req" },
                requestId,
                sessionId,
                method: "POST",
                url: "/api/login?token=%5BREDACTED%5D",
                rawPayload: { password: "secret-token" },
                headers: {
                  Authorization: "Bearer secret-token",
                  Cookie: "sid=secret-token",
                },
              },
              backend: {
                requestId,
                sessionId,
                correlation: {
                  status: "linked",
                  sessionIdSource: "header",
                  requestIdSource: "header",
                },
                start: { t: 1010, k: "backend.req.start" },
                pathname: "/api/login",
                error: {
                  name: "AuthError",
                  code: "AUTH_FAILED",
                  message: "[REDACTED]",
                },
                rawBody: { token: "secret-token" },
              },
            },
          ],
          gaps: [
            {
              type: "backend-only",
              requestId,
              sessionId,
              backend: {
                requestId,
                sessionId,
                url: "/api/login?cookie=%5BREDACTED%5D",
                rawHeaders: {
                  Cookie: "sid=secret-token",
                  Authorization: "Bearer secret-token",
                },
              },
            },
          ],
        },
      },
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 115,
      method: "tools/call",
      params: {
        name: "getLinkedRequestContext",
        arguments: { sessionId, requestId },
      },
    });

    const result = res!.result as any;
    const text = result.content[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.status).toBe("linked");
    expect(parsed.gaps).toHaveLength(1);
    expect(parsed.diagnostics.join(" ")).toMatch(/session-level.*gap/i);
    expect(text).not.toContain("secret-token");
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("Cookie");
    expect(text).not.toContain("rawPayload");
    expect(text).not.toContain("rawBody");
    expect(text).not.toContain("rawHeaders");
  });

  it("getLinkedRequestContext returns the existing error result for a missing session", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 116,
      method: "tools/call",
      params: {
        name: "getLinkedRequestContext",
        arguments: { sessionId: "missing-session", requestId: "req-any" },
      },
    });

    const result = res!.result as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Session not found");
  });

  it("getLinkedRequestContext degrades malformed fullStackRequests shapes to unavailable", async () => {
    const sessionId = "sess-malformed-model";
    const requestId = "req-any";
    createSession(
      sessionId,
      [{ t: 1000, k: "net.req", d: { requestId, sessionId } }],
      {
        fullStackRequests: {
          schemaVersion: 1,
          summary: {
            frontendRequests: 1,
            backendRequests: 0,
            linked: 0,
            gaps: 0,
            gapTypes: {},
          },
          linked: { requestId },
          gaps: [],
        },
      },
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 116,
      method: "tools/call",
      params: {
        name: "getLinkedRequestContext",
        arguments: { sessionId, requestId },
      },
    });

    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("unavailable");
    expect(parsed.gaps).toEqual([]);
    expect(parsed.diagnostics.join(" ")).toMatch(
      /missing linked or gaps arrays/i,
    );
  });

  it("getCookieChanges returns cookie events", async () => {
    const events = [
      { t: 1000, k: "cookie", d: { name: "sid", value: "abc" } },
      { t: 2000, k: "nav", d: {} },
      { t: 3000, k: "cookie", d: { name: "pref", value: "dark" } },
    ];
    createSession("sess-cookie", events);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "getCookieChanges",
        arguments: { sessionId: "sess-cookie" },
      },
    });
    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((e: any) => e.k === "cookie")).toBe(true);
  });

  it("getStorageChanges returns stor events", async () => {
    const events = [
      { t: 1000, k: "stor", d: { key: "theme", value: "dark" } },
      { t: 2000, k: "nav", d: {} },
      { t: 3000, k: "stor", d: { key: "lang", value: "en" } },
    ];
    createSession("sess-stor", events);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "getStorageChanges",
        arguments: { sessionId: "sess-stor" },
      },
    });
    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((e: any) => e.k === "stor")).toBe(true);
  });

  it("getStorageSnapshot returns snap events", async () => {
    const events = [
      { t: 1000, k: "snap", d: { localStorage: { key: "val" } } },
      { t: 2000, k: "nav", d: {} },
    ];
    createSession("sess-snap", events);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "getStorageSnapshot",
        arguments: { sessionId: "sess-snap" },
      },
    });
    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].k).toBe("snap");
  });

  it("getTranscript returns tx events", async () => {
    const events = [
      { t: 1000, k: "tx", d: { text: "hello world" } },
      { t: 2000, k: "nav", d: {} },
      { t: 3000, k: "tx", d: { text: "goodbye" } },
    ];
    createSession("sess-tx", events);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: { name: "getTranscript", arguments: { sessionId: "sess-tx" } },
    });
    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((e: any) => e.k === "tx")).toBe(true);
  });

  it("getFrame returns nearest frame as base64 image", async () => {
    createSession("sess-frame", [{ t: 1000, k: "nav", d: {} }]);
    // Write a fake frame file
    const frameData = Buffer.from("fake-jpeg-data");
    fs.writeFileSync(
      path.join(tmpDir, "sess-frame", "frames", "frame-1000.jpg"),
      frameData,
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "getFrame",
        arguments: { sessionId: "sess-frame", timestamp: 1100 },
      },
    });
    const result = res!.result as any;
    expect(result.content[0].type).toBe("image");
    expect(result.content[0].mimeType).toBe("image/jpeg");
    expect(result.content[0].data).toBe(frameData.toString("base64"));
  });

  it("getFrameById returns frame by filename", async () => {
    createSession("sess-frameid", [{ t: 1000, k: "nav", d: {} }]);
    const frameData = Buffer.from("another-fake-jpeg");
    fs.writeFileSync(
      path.join(tmpDir, "sess-frameid", "frames", "my-frame.jpg"),
      frameData,
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: {
        name: "getFrameById",
        arguments: { sessionId: "sess-frameid", filename: "my-frame.jpg" },
      },
    });
    const result = res!.result as any;
    expect(result.content[0].type).toBe("image");
    expect(result.content[0].data).toBe(frameData.toString("base64"));
  });

  it("getFrameById returns error for missing frame", async () => {
    createSession("sess-noframe", [{ t: 1000, k: "nav", d: {} }]);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 18,
      method: "tools/call",
      params: {
        name: "getFrameById",
        arguments: { sessionId: "sess-noframe", filename: "nope.jpg" },
      },
    });
    const result = res!.result as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Frame file not found");
  });

  it.each([
    "../secret.jpg",
    "..%2Fsecret.jpg",
    "nested/frame.jpg",
    "/tmp/frame.jpg",
    "bad\\frame.jpg",
  ])("getFrameById rejects unsafe filename %s", async (filename) => {
    createSession("sess-frame-unsafe", [{ t: 1000, k: "nav", d: {} }]);

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: `unsafe-${filename}`,
      method: "tools/call",
      params: {
        name: "getFrameById",
        arguments: { sessionId: "sess-frame-unsafe", filename },
      },
    });

    const result = res!.result as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid frame filename");
  });

  it("getBugLLMContext returns compact context for bug report", async () => {
    const bugsDir = path.join(path.dirname(tmpDir), "bugs");
    const bugDir = path.join(bugsDir, "bug_test_1");
    fs.mkdirSync(bugDir, { recursive: true });
    fs.writeFileSync(
      path.join(bugDir, "report.json"),
      JSON.stringify({
        bugId: "bug_test_1",
        sessionId: "sess-a",
        flaggedAt: 1000,
        windowMs: 60000,
        url: "http://localhost",
        userAgent: "ua",
        summary: {
          errorCount: 1,
          failedRequestCount: 0,
          eventCount: 2,
          eventKinds: { err: 1 },
          durationMs: 100,
        },
      }),
    );
    fs.writeFileSync(
      path.join(bugDir, "llm.json"),
      JSON.stringify({ v: 1, id: "bug_test_1", sid: "sess-a", s: { e: 1 } }),
    );

    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 19,
      method: "tools/call",
      params: { name: "getBugLLMContext", arguments: { bugId: "bug_test_1" } },
    });
    const result = res!.result as any;
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.id).toBe("bug_test_1");
    expect(parsed.s.e).toBe(1);
  });

  // CP5: resolveTarget seam — "a bug is a named window into a session".
  // A session that is ALSO exposed as a bug must reach identical shared bodies
  // (errorContext, failedRequests) through resolveTarget, while the per-tool
  // getEvents divergence (bug clamps to 1000 + supports compact; session neither)
  // is preserved.
  describe("resolveTarget seam (CP5)", () => {
    async function callTool(name: string, args: Record<string, unknown>) {
      const res = await server.handleMessage({
        jsonrpc: "2.0",
        id: `rt-${name}`,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const result = res!.result as any;
      return {
        result,
        parsed: result.isError ? undefined : JSON.parse(result.content[0].text),
      };
    }

    // Expose an existing session dir as a bug (same events + index) so both
    // resolution paths point at equivalent underlying artifacts.
    function exposeSessionAsBug(sessionId: string, bugId: string) {
      const sessionDir = path.join(tmpDir, sessionId);
      const bugsDir = path.join(path.dirname(tmpDir), "bugs");
      const bugDir = path.join(bugsDir, bugId);
      fs.mkdirSync(bugDir, { recursive: true });
      for (const f of ["events.ndjson", "index.json"]) {
        const src = path.join(sessionDir, f);
        if (fs.existsSync(src)) fs.copyFileSync(src, path.join(bugDir, f));
      }
      fs.writeFileSync(
        path.join(bugDir, "report.json"),
        JSON.stringify({ bugId, sessionId }),
      );
      return bugDir;
    }

    it("session and bug reach equivalent errorContext + failedRequests bodies", async () => {
      const events = [
        { t: 1000, k: "nav", d: { to: "/checkout" } },
        { t: 2000, k: "net.res", d: { st: 502 } },
        { t: 2100, k: "err", d: { msg: "boom" } },
        { t: 2200, k: "clk", d: {} },
      ];
      createSession("sess-rt", events);
      exposeSessionAsBug("sess-rt", "bug_rt");

      const s = await callTool("getErrorContext", { sessionId: "sess-rt" });
      const b = await callTool("getBugErrorContext", { bugId: "bug_rt" });
      expect(s.result.isError).toBeFalsy();
      expect(b.result.isError).toBeFalsy();
      expect(b.parsed).toEqual(s.parsed);
      expect(s.parsed).toHaveLength(1);
      expect(s.parsed[0].error.d.msg).toBe("boom");

      const sf = await callTool("getFailedRequests", { sessionId: "sess-rt" });
      const bf = await callTool("getBugFailedRequests", { bugId: "bug_rt" });
      expect(sf.result.isError).toBeFalsy();
      expect(bf.result.isError).toBeFalsy();
      expect(bf.parsed).toEqual(sf.parsed);
      expect(sf.parsed).toHaveLength(1);
      expect(sf.parsed[0].st).toBe(502);
    });

    it("getEvents clamp/compact divergence is preserved across the pair", async () => {
      const events = Array.from({ length: 1500 }, (_, i) => ({
        t: i,
        k: "nav",
        d: { i },
      }));
      createSession("sess-div", events);
      exposeSessionAsBug("sess-div", "bug_div");

      // Session getEvents caps large requests to keep MCP responses bounded.
      const s = await callTool("getEvents", {
        sessionId: "sess-div",
        limit: 1500,
      });
      expect(s.parsed).toHaveLength(500);

      // Bug getEvents clamps the limit to 1000.
      const b = await callTool("getBugEvents", {
        bugId: "bug_div",
        limit: 1500,
      });
      expect(b.parsed).toHaveLength(1000);

      // Bug compact mode maps each event to [t, k, d].
      const bc = await callTool("getBugEvents", {
        bugId: "bug_div",
        limit: 3,
        compact: true,
      });
      expect(bc.parsed).toEqual([
        [0, "nav", { i: 0 }],
        [1, "nav", { i: 1 }],
        [2, "nav", { i: 2 }],
      ]);

      // Session getEvents has NO compact mode — returns full event objects.
      const sc = await callTool("getEvents", {
        sessionId: "sess-div",
        limit: 3,
        compact: true,
      });
      expect(Array.isArray(sc.parsed[0])).toBe(false);
      expect(sc.parsed[0]).toMatchObject({ t: 0, k: "nav" });
    });

    it("preserves the bug not-found gate and session empty-read/not-found behavior", async () => {
      const missBug = await callTool("getBugEvents", { bugId: "nope" });
      expect(missBug.result.isError).toBe(true);
      expect(missBug.result.content[0].text).toContain("Bug not found");

      const missBugFR = await callTool("getBugFailedRequests", {
        bugId: "nope",
      });
      expect(missBugFR.result.isError).toBe(true);
      expect(missBugFR.result.content[0].text).toContain("Bug not found");

      // Missing sessions are explicit so empty evidence cannot be misread as a
      // valid session with no events.
      const missSession = await callTool("getEvents", { sessionId: "ghost" });
      expect(missSession.result.isError).toBe(true);
      expect(missSession.result.content[0].text).toContain("Session not found");

      // Session failedRequests discovers the missing session via index.json.
      const missFR = await callTool("getFailedRequests", {
        sessionId: "ghost",
      });
      expect(missFR.result.isError).toBe(true);
      expect(missFR.result.content[0].text).toContain("Session not found");
    });
  });

  // CP4: token-budgeted, zero-friction agent surface — optional maxTokens on
  // getFixContext/solveContext/getWindow (byte-identical when omitted), always-
  // present tokenEstimate on getSessionManifest/getEvidence, and the one-call
  // getLatestIssue entry point sharing the CLI's resolveLatestIssue.
  describe("token budgeting + getLatestIssue (CP4)", () => {
    async function callTool(
      name: string,
      args: Record<string, unknown>,
      s = server,
    ) {
      const res = await s.handleMessage({
        jsonrpc: "2.0",
        id: `cp4-${name}`,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const result = res!.result as any;
      const text: string | undefined = result.content?.[0]?.text;
      return {
        result,
        text,
        parsed: result.isError ? undefined : JSON.parse(text!),
      };
    }

    /** Fat detector signals so budget fills drop predictably. */
    function fatCandidates(count: number) {
      return Array.from({ length: count }, (_, i) => ({
        schemaVersion: 1,
        id: `cand_${String(i + 1).padStart(4, "0")}`,
        detector: "http_error",
        title: `HTTP 500 from POST /api/step-${i} — ${"detail ".repeat(60)}`,
        severity: "high",
        score: 90 - i,
        anchor: {
          t: 2000 + i,
          offsetMs: 1000 + i,
          route: "/checkout",
          requestId: `req_${i}`,
          method: "POST",
          url: `/api/step-${i}`,
          status: 500,
        },
        evidenceWindow: { start: 1900, end: 2600, windowId: "win_0001" },
      }));
    }

    function writeCandidates(sessionId: string, candidates: unknown[]) {
      fs.writeFileSync(
        path.join(tmpDir, sessionId, "candidates.jsonl"),
        candidates.map((c) => JSON.stringify(c)).join("\n") + "\n",
      );
    }

    it("getFixContext without maxTokens is byte-identical to the raw contract", async () => {
      createSession("sess-cp4-id", [
        { t: 1000, k: "nav", d: { to: "/checkout" } },
        { t: 2000, k: "err", d: { msg: "boom" } },
      ]);
      writeCandidates("sess-cp4-id", fatCandidates(3));

      const { text, result } = await callTool("getFixContext", {
        sessionId: "sess-cp4-id",
      });
      expect(result.isError).toBeFalsy();
      const expected = await buildFixContext(path.join(tmpDir, "sess-cp4-id"), {
        outputDir: tmpDir,
      });
      expect(text).toBe(JSON.stringify(expected, null, 2));
      expect(text).not.toContain("tokenEstimate");
      expect(text).not.toContain("dropReport");
    });

    it("getFixContext maxTokens keeps a rank prefix, reports drops, and dropped refs drill through getEvidence", async () => {
      createSession("sess-cp4-fc", [
        { t: 1000, k: "nav", d: { to: "/checkout" } },
        { t: 2000, k: "err", d: { msg: "boom" } },
      ]);
      writeCandidates("sess-cp4-fc", fatCandidates(6));

      const full = await callTool("getFixContext", {
        sessionId: "sess-cp4-fc",
      });
      const fullIds = full.parsed.signals.map((c: any) => c.id);
      expect(fullIds).toHaveLength(6);

      const maxTokens = estimateTokens(full.text!) - 200;
      const { parsed, text } = await callTool("getFixContext", {
        sessionId: "sess-cp4-fc",
        maxTokens,
      });

      // Rank-prefix fill: kept ids + dropped refs reassemble the full ranking.
      expect(parsed.signals.length).toBeGreaterThanOrEqual(1);
      expect(parsed.dropReport.droppedCount).toBeGreaterThanOrEqual(1);
      expect([
        ...parsed.signals.map((c: any) => c.id),
        ...parsed.dropReport.droppedRefs,
      ]).toEqual(fullIds);
      expect(parsed.dropReport.message).toMatch(/^omitted \d+ items?, ~/);
      expect(parsed.dropReport.droppedTokenEstimate).toBeGreaterThan(0);

      // Estimate is over the exact serialized response and within budget+slack.
      expect(parsed.tokenEstimate).toBe(estimateTokens(text!));
      expect(parsed.tokenEstimate).toBeLessThanOrEqual(
        maxTokens + BUDGET_SLACK_TOKENS,
      );

      // A dropped candidate ref resolves back through getEvidence.
      const ref = parsed.dropReport.droppedRefs[0];
      const drill = await callTool("getEvidence", {
        sessionId: "sess-cp4-fc",
        ref,
      });
      expect(drill.result.isError).toBeFalsy();
      expect(drill.parsed.kind).toBe("candidate");
      expect(drill.parsed.candidate.id).toBe(ref);
    });

    it("rejects an invalid maxTokens with an actionable error", async () => {
      createSession("sess-cp4-bad", [{ t: 1000, k: "err", d: { msg: "x" } }]);
      for (const maxTokens of [0, -1, 1.5, "10"]) {
        const { result } = await callTool("getFixContext", {
          sessionId: "sess-cp4-bad",
          maxTokens,
        });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain(
          "maxTokens must be an integer >= 1",
        );
      }
    });

    it("solveContext without maxTokens carries no budgeting fields; with maxTokens it drops ranked evidence by EvidenceItem.id", async () => {
      const items: EvidenceItem[] = Array.from({ length: 6 }, (_, i) => ({
        id: `ev_${String(i).padStart(2, "0")}`,
        lane: "logs",
        kind: "sentry.error",
        brief: `checkout crash detail ${i} — ${"trace ".repeat(60)}`,
        ref: { sig: `https://sentry.io/issues/${i}/` },
        before: undefined,
        after: `frame-${i}`,
        whenObserved: 1200 + i,
      }));
      const budgetServer = new McpServer({
        outputDir: tmpDir,
        evidenceSourcesFactory: () => [
          new FakeEvidenceSource({ provider: "sentry", items }),
        ],
      });

      const full = await callTool(
        "solveContext",
        { symptom: { title: "checkout crash" } },
        budgetServer,
      );
      expect(full.parsed.schemaVersion).toBe("fusion.v1");
      expect(full.parsed.evidence).toHaveLength(6);
      expect(full.text).not.toContain("tokenEstimate");
      expect(full.text).not.toContain("dropReport");

      const rankedIds = full.parsed.evidence.map((e: any) => e.id);
      const maxTokens = estimateTokens(full.text!) - 150;
      const budgeted = await callTool(
        "solveContext",
        { symptom: { title: "checkout crash" }, maxTokens },
        budgetServer,
      );
      expect(budgeted.parsed.dropReport.droppedCount).toBeGreaterThanOrEqual(1);
      expect([
        ...budgeted.parsed.evidence.map((e: any) => e.id),
        ...budgeted.parsed.dropReport.droppedRefs,
      ]).toEqual(rankedIds);
      // Kept items are whole, unrewritten copies of their unbudgeted selves.
      expect(budgeted.parsed.evidence).toEqual(
        full.parsed.evidence.slice(0, budgeted.parsed.evidence.length),
      );
      expect(budgeted.parsed.tokenEstimate).toBe(
        estimateTokens(budgeted.text!),
      );
      expect(budgeted.parsed.tokenEstimate).toBeLessThanOrEqual(
        maxTokens + BUDGET_SLACK_TOKENS,
      );
    });

    it("getWindow without maxTokens is byte-identical; with maxTokens it drops from the tail and reports the first omitted timestamp", async () => {
      const events = Array.from({ length: 40 }, (_, i) => ({
        t: 1000 + i * 10,
        k: "nav",
        d: { i, pad: "x".repeat(150) },
      }));
      createSession("sess-cp4-win", events);

      const full = await callTool("getWindow", {
        sessionId: "sess-cp4-win",
        t0: 0,
        t1: 100000,
      });
      const expected = {
        sessionId: "sess-cp4-win",
        t0: 0,
        t1: 100000,
        units: "absolute-ms",
        count: events.length,
        returned: events.length,
        truncated: false,
        events,
      };
      expect(full.text).toBe(JSON.stringify(expected, null, 2));

      const maxTokens = estimateTokens(full.text!) - 100;
      const { parsed, text } = await callTool("getWindow", {
        sessionId: "sess-cp4-win",
        t0: 0,
        t1: 100000,
        maxTokens,
      });
      expect(parsed.count).toBe(40);
      expect(parsed.events.length).toBeLessThan(40);
      expect(parsed.events.length).toBeGreaterThan(0);
      expect(parsed.returned).toBe(parsed.events.length);
      expect(parsed.truncated).toBe(true);
      // Chronological prefix: dropped strictly from the tail.
      expect(parsed.events).toEqual(events.slice(0, parsed.events.length));
      // Drop report carries the first omitted event timestamp for re-windowing.
      const firstOmitted = events[parsed.events.length];
      expect(parsed.dropReport.droppedRefs[0]).toBe(`t=${firstOmitted.t}`);
      expect(parsed.dropReport.droppedCount).toBe(40 - parsed.events.length);
      expect(parsed.tokenEstimate).toBe(estimateTokens(text!));
      expect(parsed.tokenEstimate).toBeLessThanOrEqual(
        maxTokens + BUDGET_SLACK_TOKENS,
      );
    });

    it("getSessionManifest and getEvidence always carry an additive tokenEstimate", async () => {
      createSession("sess-cp4-est", [
        { t: 1000, k: "err", d: { msg: "boom" } },
      ]);
      writeCandidates("sess-cp4-est", fatCandidates(2));

      const manifest = await callTool("getSessionManifest", {
        sessionId: "sess-cp4-est",
      });
      expect(manifest.parsed.kind).toBe("crumbtrail.session-manifest");
      expect(manifest.parsed.tokenEstimate).toBe(
        estimateTokens(manifest.text!),
      );
      expect(manifest.parsed.tokenEstimate).toBeGreaterThan(0);

      const evidence = await callTool("getEvidence", {
        sessionId: "sess-cp4-est",
        ref: "cand_0001",
      });
      expect(evidence.parsed.kind).toBe("candidate");
      expect(evidence.parsed.tokenEstimate).toBe(
        estimateTokens(evidence.text!),
      );

      const miss = await callTool("getEvidence", {
        sessionId: "sess-cp4-est",
        ref: "nope",
      });
      expect(miss.parsed.status).toBe("not-found");
      expect(miss.parsed.tokenEstimate).toBe(estimateTokens(miss.text!));
    });

    it("getLatestIssue returns the newest qualifying session's fix context in one call", async () => {
      createSession("sess-latest-old", [
        { t: 1000, k: "err", d: { msg: "old boom" } },
        { t: 5000, k: "nav", d: { to: "/done" } },
      ]);
      createSession("sess-latest-new", [
        { t: 2000, k: "err", d: { msg: "new boom" } },
        { t: 9000, k: "nav", d: { to: "/done" } },
      ]);

      const { parsed, result } = await callTool("getLatestIssue", {});
      expect(result.isError).toBeFalsy();
      expect(parsed.schemaVersion).toBe("fix-context.v2");
      expect(parsed.session.id).toBe("sess-latest-new");
      // No maxTokens -> byte-identical to the raw contract (no budgeting fields).
      expect(JSON.stringify(parsed)).not.toContain("tokenEstimate");

      // Its only input, maxTokens, is honored through the same budgeting path.
      const budgeted = await callTool("getLatestIssue", { maxTokens: 100000 });
      expect(budgeted.parsed.session.id).toBe("sess-latest-new");
      expect(budgeted.parsed.tokenEstimate).toBe(
        estimateTokens(budgeted.text!),
      );
    });

    it("getLatestIssue returns an actionable error when nothing qualifies", async () => {
      const { result } = await callTool("getLatestIssue", {});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(
        "No finalized session with error-class evidence found under",
      );
      expect(result.content[0].text).toContain("listSessions");
    });

    it("get_latest_issue snake_case alias dispatches to the same handler", async () => {
      createSession("sess-alias", [{ t: 3000, k: "err", d: { msg: "x" } }]);
      const { parsed, result } = await callTool("get_latest_issue", {});
      expect(result.isError).toBeFalsy();
      expect(parsed.session.id).toBe("sess-alias");
    });

    it("MCP getLatestIssue and CLI fix-context --latest agree on the same store", async () => {
      createSession("sess-agree-old", [
        { t: 1000, k: "err", d: { msg: "old" } },
        { t: 4000, k: "nav", d: { to: "/a" } },
      ]);
      createSession("sess-agree-new", [
        { t: 2000, k: "err", d: { msg: "new" } },
        { t: 8000, k: "nav", d: { to: "/b" } },
      ]);

      const mcp = await callTool("getLatestIssue", {});
      expect(mcp.parsed.session.id).toBe("sess-agree-new");

      const writes: string[] = [];
      const spy = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk: any) => {
          writes.push(String(chunk));
          return true;
        });
      try {
        const code = await runFixContext([
          "--latest",
          "--output",
          tmpDir,
          "--json",
        ]);
        expect(code).toBe(0);
      } finally {
        spy.mockRestore();
      }
      const cli = JSON.parse(writes.join(""));
      expect(cli.session.id).toBe(mcp.parsed.session.id);
    });
  });

  it("unknown method returns error response", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 99,
      method: "some/unknown/method",
    });
    expect(res).not.toBeNull();
    expect(res!.error).toBeDefined();
    expect(res!.error!.code).toBe(-32601);
    expect(res!.error!.message).toBe("Method not found");
  });

  it("unknown tool returns error result", async () => {
    const res = await server.handleMessage({
      jsonrpc: "2.0",
      id: 100,
      method: "tools/call",
      params: { name: "nonExistentTool", arguments: {} },
    });
    const result = res!.result as any;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Unknown tool: nonExistentTool");
  });
});
