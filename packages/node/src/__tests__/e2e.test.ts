import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type http from "node:http";
import { createServer } from "../server";
import { BROWSER_REDACTION_POLICY } from "../llm-bundle";

describe("end-to-end session", () => {
  let tmpDir: string;
  let server: http.Server;
  let baseUrl: string;
  const authHeaders = { "X-Crumbtrail-Auth": "test-token" };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-e2e-"));
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const addr = server.address() as { port: number };
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function post(urlPath: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${urlPath}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders },
      body: JSON.stringify(body),
    });
  }

  async function postBlob(
    sessionId: string,
    name: string,
    data: Buffer,
    headers: Record<string, string> = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/blob/${name}`, {
      method: "POST",
      headers: { ...authHeaders, "X-Session-Id": sessionId, ...headers },
      // Node's fetch (undici) accepts a Buffer body at runtime; mixing the DOM
      // and Node global `fetch`/`BodyInit` lib declarations makes the static
      // type of `body` resolve too narrowly here.
      body: data as unknown as BodyInit,
    });
  }

  function findSessionDir(sessionId: string): string {
    const stack = [tmpDir];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = path.join(dir, entry.name);
        if (
          entry.name === sessionId &&
          fs.existsSync(path.join(candidate, "meta.json"))
        )
          return candidate;
        stack.push(candidate);
      }
    }
    throw new Error(`session not found: ${sessionId}`);
  }

  it("complete session lifecycle produces correct output files", async () => {
    const sessionId = "ses_20260327_120000";

    // 1. Start session
    const startRes = await post("/api/session/start", {
      sessionId,
      metadata: { app: "test-app" },
    });
    expect(startRes.status).toBe(200);

    // 2. Send multiple batches of events
    const batch1 = [
      { t: 1000, k: "nav", d: { from: "", to: "/dashboard", tr: "init" } },
      { t: 1050, k: "con", d: { lv: "log", args: ['"page loaded"'] } },
      {
        t: 1100,
        k: "clk",
        d: { el: { tag: "BUTTON", id: "new-item" }, pos: [120, 450] },
      },
    ];
    await post("/api/events", { sessionId, events: batch1 });

    const batch2 = [
      {
        t: 1200,
        k: "inp",
        d: { el: { tag: "INPUT", name: "title" }, val: "My Task", ev: "input" },
      },
      {
        t: 1300,
        k: "key",
        d: { key: "Enter", code: "Enter", dir: "dn", el: { tag: "INPUT" } },
      },
      {
        t: 1400,
        k: "err",
        d: {
          msg: 'TypeError: Cannot read property "id" of null',
          file: "app.js",
          line: 42,
        },
      },
      {
        t: 1500,
        k: "nav",
        d: { from: "/dashboard", to: "/items/new", tr: "push" },
      },
    ];
    await post("/api/events", { sessionId, events: batch2 });

    // 3. End session
    const endRes = await post("/api/session/end", { sessionId });
    expect(endRes.status).toBe(200);

    // 4. Verify output files
    const sessionDir = findSessionDir(sessionId);

    // meta.json
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    expect(meta.id).toBe(sessionId);
    expect(meta.app).toBe("test-app");
    expect(meta.start).toBeTypeOf("number");
    expect(meta.end).toBeTypeOf("number");

    // events.ndjson — 7 events across 2 batches
    const ndjson = fs.readFileSync(
      path.join(sessionDir, "events.ndjson"),
      "utf-8",
    );
    const eventLines = ndjson.trim().split("\n");
    expect(eventLines).toHaveLength(7);

    // Each line is valid JSON
    const parsedEvents = eventLines.map((line) => JSON.parse(line));
    expect(parsedEvents[0].k).toBe("nav");
    expect(parsedEvents[5].k).toBe("err");

    // index.json
    const index = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "index.json"), "utf-8"),
    );
    expect(index.evts).toBe(7);
    expect(index.start).toBe(1000);
    expect(index.end).toBe(1500);
    expect(index.dur).toBe(500);
    expect(index.errs).toHaveLength(1);
    expect(index.errs[0].msg).toContain("TypeError");
    expect(index.navs).toHaveLength(2);
    expect(index.navs[0].to).toBe("/dashboard");
    expect(index.navs[1].to).toBe("/items/new");
    expect(index.stats.nav).toBe(2);
    expect(index.stats.con).toBe(1);
    expect(index.stats.clk).toBe(1);
    expect(index.stats.inp).toBe(1);
    expect(index.stats.key).toBe(1);
    expect(index.stats.err).toBe(1);

    // frames/ directory exists
    expect(fs.existsSync(path.join(sessionDir, "frames"))).toBe(true);
  });

  it("baseline explicit session with lifecycle events produces meta, events, and index files", async () => {
    const sessionId = "ses_lifecycle_baseline";

    const startRes = await post("/api/session/start", {
      sessionId,
      metadata: {
        source: "crumbtrail-extension",
        name: "Lifecycle baseline",
        collection: {
          events: { enabled: true, degraded: false },
          video: { enabled: false, degraded: true, reason: "planned_for_s02" },
        },
        degradedCollection: ["video", "audio", "pageProbe"],
      },
    });
    expect(startRes.status).toBe(200);

    const events = [
      {
        t: 2_000,
        k: "session.lifecycle",
        sessionId,
        offsetMs: 0,
        d: {
          action: "start",
          reason: "user",
          rootTabId: 42,
          rootUrl: "https://app.example.test/cart",
        },
      },
      {
        t: 2_075,
        k: "clk",
        sessionId,
        offsetMs: 75,
        d: { el: { tag: "BUTTON", id: "checkout" }, pos: [10, 20] },
      },
      {
        t: 2_150,
        k: "session.lifecycle",
        sessionId,
        offsetMs: 150,
        d: {
          action: "stop",
          reason: "user",
          rootTabId: 42,
          rootUrl: "https://app.example.test/cart",
        },
      },
    ];
    const eventsRes = await post("/api/events", { sessionId, events });
    expect(eventsRes.status).toBe(200);

    const endRes = await post("/api/session/end", { sessionId });
    expect(endRes.status).toBe(200);
    await expect(endRes.json()).resolves.toMatchObject({
      ok: true,
      sessionId,
      processed: true,
      degraded: false,
      postProcess: { ok: true },
    });

    const sessionDir = findSessionDir(sessionId);
    expect(fs.existsSync(path.join(sessionDir, "meta.json"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "events.ndjson"))).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "index.json"))).toBe(true);

    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    expect(meta).toMatchObject({
      id: sessionId,
      source: "crumbtrail-extension",
      name: "Lifecycle baseline",
      processed: true,
      finalization: { degraded: false, postProcess: { ok: true } },
    });
    expect(meta.degradedCollection).toEqual(["video", "audio", "pageProbe"]);

    const ndjson = fs
      .readFileSync(path.join(sessionDir, "events.ndjson"), "utf-8")
      .trim()
      .split("\n");
    expect(ndjson).toHaveLength(3);
    expect(ndjson.map((line) => JSON.parse(line).k)).toEqual([
      "session.lifecycle",
      "clk",
      "session.lifecycle",
    ]);

    const index = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "index.json"), "utf-8"),
    );
    expect(index).toMatchObject({
      id: sessionId,
      start: 2_000,
      end: 2_150,
      dur: 150,
      evts: 3,
      stats: {
        "session.lifecycle": 2,
        clk: 1,
      },
    });
  });

  it("indexes tab-boundary artifacts through the local server lifecycle", async () => {
    const sessionId = "ses_tab_boundary_index";

    const startRes = await post("/api/session/start", {
      sessionId,
      metadata: {
        source: "crumbtrail-extension",
        name: "Boundary index",
        tabBoundary: {
          enabled: true,
          eventKind: "tab.boundary",
          redaction: "origin-only",
          rootOrigin: "https://app.example.test",
          allowedOrigins: [
            "https://app.example.test",
            "https://checkout.example.test",
          ],
        },
      },
    });
    expect(startRes.status).toBe(200);

    const events = [
      {
        t: 3_000,
        k: "session.lifecycle",
        sessionId,
        offsetMs: 0,
        d: {
          action: "start",
          reason: "user",
          rootTabId: 42,
          rootOrigin: "https://app.example.test",
        },
      },
      {
        t: 3_100,
        k: "tab.boundary",
        sessionId,
        offsetMs: 100,
        d: {
          signal: "activated",
          decision: "follow",
          reason: "allowed_origin",
          capture: true,
          nonCapture: false,
          tabId: 77,
          previousTabId: 42,
          previousCapturedOrigin: "https://app.example.test",
          candidate: {
            valid: true,
            restricted: false,
            opaque: false,
            scheme: "https",
            origin: "https://checkout.example.test",
          },
        },
      },
      {
        t: 3_200,
        k: "tab.boundary",
        sessionId,
        offsetMs: 200,
        d: {
          signal: "content-navigation",
          decision: "prompt",
          reason: "outside_boundary",
          capture: false,
          nonCapture: true,
          previousCapturedOrigin: "https://checkout.example.test",
          candidate: {
            valid: true,
            restricted: false,
            opaque: false,
            scheme: "https",
            origin: "https://external.example.test",
          },
          prompt: {
            origin: "https://external.example.test",
            requestedAt: 3_200,
            outcome: "pending",
          },
        },
      },
      {
        t: 3_300,
        k: "session.lifecycle",
        sessionId,
        offsetMs: 300,
        d: {
          action: "stop",
          reason: "user",
          rootTabId: 77,
          rootOrigin: "https://checkout.example.test",
        },
      },
    ];
    const eventsRes = await post("/api/events", { sessionId, events });
    expect(eventsRes.status).toBe(200);

    const endRes = await post("/api/session/end", { sessionId });
    expect(endRes.status).toBe(200);
    await expect(endRes.json()).resolves.toMatchObject({
      ok: true,
      sessionId,
      processed: true,
    });

    const sessionDir = findSessionDir(sessionId);
    const ndjson = fs
      .readFileSync(path.join(sessionDir, "events.ndjson"), "utf-8")
      .trim()
      .split("\n");
    expect(ndjson.map((line) => JSON.parse(line).k)).toEqual([
      "session.lifecycle",
      "tab.boundary",
      "tab.boundary",
      "session.lifecycle",
    ]);

    const index = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "index.json"), "utf-8"),
    );
    expect(index.stats["tab.boundary"]).toBe(2);
    expect(index.tabBoundaries).toEqual([
      {
        t: 3_100,
        offsetMs: 100,
        signal: "activated",
        decision: "follow",
        reason: "allowed_origin",
        capture: true,
        nonCapture: false,
        tabId: 77,
        previousCapturedOrigin: "https://app.example.test",
        candidate: {
          valid: true,
          restricted: false,
          opaque: false,
          scheme: "https",
          origin: "https://checkout.example.test",
        },
      },
      {
        t: 3_200,
        offsetMs: 200,
        signal: "content-navigation",
        decision: "prompt",
        reason: "outside_boundary",
        capture: false,
        nonCapture: true,
        previousCapturedOrigin: "https://checkout.example.test",
        candidate: {
          valid: true,
          restricted: false,
          opaque: false,
          scheme: "https",
          origin: "https://external.example.test",
        },
        prompt: {
          origin: "https://external.example.test",
          outcome: "pending",
          requestedAt: 3_200,
        },
      },
    ]);
  });

  it("proves the final session folder contract with artifact fixtures", async () => {
    const sessionId = "ses_final_contract_fixture";
    const secret = "sk_contract_fixture_secret_1234567890";
    const videoBytes = Buffer.from(
      "not-a-real-webm-but-good-enough-for-artifact-contract",
    );
    const audioBytes = Buffer.from("placeholder-audio-webm");

    const startRes = await post("/api/session/start", {
      sessionId,
      metadata: {
        source: "crumbtrail-extension",
        name: "Final contract fixture",
        app: "checkout-app",
        capabilities: {
          events: true,
          video: true,
          audio: true,
          pageProbe: true,
          network: true,
        },
        collection: {
          events: { enabled: true, degraded: false },
          video: { enabled: true, degraded: false },
          audio: { enabled: true, degraded: false },
          network: {
            enabled: true,
            degraded: false,
            redaction: BROWSER_REDACTION_POLICY,
          },
          pageProbe: { enabled: true, degraded: false },
        },
        tabBoundary: {
          enabled: true,
          eventKind: "tab.boundary",
          redaction: "origin-only",
          rootOrigin: "https://app.example.test",
          allowedOrigins: ["https://app.example.test"],
        },
      },
    });
    expect(startRes.status).toBe(200);

    const events = [
      {
        t: 4_000,
        k: "session.lifecycle",
        sessionId,
        offsetMs: 0,
        d: {
          action: "start",
          reason: "user",
          rootTabId: 42,
          rootUrl: `https://app.example.test/cart?token=${secret}#checkout`,
        },
      },
      {
        t: 4_025,
        k: "frame.ctx",
        sessionId,
        offsetMs: 25,
        d: {
          source: "content-script",
          pageProbe: {
            requested: true,
            started: true,
            limited: true,
            reason: "isolated_world",
          },
        },
      },
      {
        t: 4_050,
        k: "probe.ready",
        sessionId,
        offsetMs: 50,
        d: {
          source: "page-probe",
          features: { console: true, fetch: true, xhr: true },
        },
      },
      {
        t: 4_075,
        k: "nav",
        sessionId,
        offsetMs: 75,
        d: {
          from: "",
          to: `https://app.example.test/cart?session=${secret}`,
          tr: "init",
        },
      },
      {
        t: 4_100,
        k: "clk",
        sessionId,
        offsetMs: 100,
        d: { el: { tag: "BUTTON", id: "pay-now" }, pos: [120, 450] },
      },
      {
        t: 4_125,
        k: "inp",
        sessionId,
        offsetMs: 125,
        d: {
          el: { tag: "INPUT", name: "email" },
          val: "buyer@example.test",
          ev: "input",
        },
      },
      {
        t: 4_150,
        k: "con",
        sessionId,
        offsetMs: 150,
        d: { source: "page-probe", lv: "err", args: ["checkout failed"] },
      },
      {
        t: 4_175,
        k: "net.req",
        sessionId,
        offsetMs: 175,
        d: {
          id: "pay-1",
          m: "POST",
          url: `https://api.example.test/pay?access_token=${secret}`,
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              {
                path: "url.query.access_token",
                reason: "url_query_value",
                action: "redacted",
              },
            ],
          },
        },
      },
      {
        t: 4_225,
        k: "net.res",
        sessionId,
        offsetMs: 225,
        d: {
          id: "pay-1",
          st: 502,
          bodySummary: {
            kind: "json",
            action: "summarized",
            reason: "size_limit",
            originalLength: 4096,
          },
        },
      },
      {
        t: 4_250,
        k: "net.err",
        sessionId,
        offsetMs: 250,
        d: {
          transport: "fetch",
          method: "GET",
          url: "https://api.example.test/retry",
          msg: "Failed to fetch",
        },
      },
      {
        t: 4_275,
        k: "tab.boundary",
        sessionId,
        offsetMs: 275,
        d: {
          signal: "content-navigation",
          decision: "prompt",
          reason: "outside_boundary",
          capture: false,
          nonCapture: true,
          previousCapturedOrigin: "https://app.example.test",
          candidate: {
            valid: true,
            restricted: false,
            opaque: false,
            scheme: "https",
            url: `https://outside.example.test/private?token=${secret}`,
          },
          prompt: {
            origin: "https://outside.example.test",
            requestedAt: 4_275,
            outcome: "pending",
          },
        },
      },
      {
        t: 4_300,
        k: "media.video",
        sessionId,
        offsetMs: 300,
        d: {
          capability: "video",
          state: "uploaded",
          artifact: "recording.webm",
        },
      },
      {
        t: 4_325,
        k: "media.voice",
        sessionId,
        offsetMs: 325,
        d: {
          capability: "audio",
          state: "marker-added",
          markerId: "voice-marker-contract",
          label: "repro narration starts",
        },
      },
      {
        t: 4_350,
        k: "session.lifecycle",
        sessionId,
        offsetMs: 350,
        d: {
          action: "stop",
          reason: "user",
          rootTabId: 42,
          rootUrl: "https://app.example.test/cart",
        },
      },
    ];
    const eventsRes = await post("/api/events", { sessionId, events });
    expect(eventsRes.status).toBe(200);

    const videoRes = await postBlob(sessionId, "recording.webm", videoBytes, {
      "Content-Type": "video/webm",
    });
    expect(videoRes.status).toBe(200);
    const audioRes = await postBlob(sessionId, "audio.webm", audioBytes, {
      "Content-Type": "audio/webm",
      "X-Metadata": JSON.stringify({
        capability: "audio",
        mimeType: "audio/webm",
        durationMs: 350,
        chunkCount: 1,
        transcriptionRequested: true,
      }),
    });
    expect(audioRes.status).toBe(200);

    const endRes = await post("/api/session/end", { sessionId });
    expect(endRes.status).toBe(200);
    const finalization = await endRes.json();
    expect(finalization).toMatchObject({
      ok: true,
      sessionId,
      processed: true,
      degraded: true,
      postProcess: {
        ok: true,
        audio: { artifact: "audio.webm", bytes: audioBytes.length },
      },
    });
    expect(["transcription-unavailable", "transcription-error"]).toContain(
      finalization.postProcess.audio.transcription.state,
    );

    const sessionDir = findSessionDir(sessionId);
    for (const fileName of [
      "meta.json",
      "events.ndjson",
      "index.json",
      "llm.md",
      "llm.json",
      "recording.webm",
      "audio.webm",
      "audio.json",
    ]) {
      expect(fs.existsSync(path.join(sessionDir, fileName))).toBe(true);
    }

    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    expect(meta).toMatchObject({
      id: sessionId,
      source: "crumbtrail-extension",
      name: "Final contract fixture",
      processed: true,
      finalization: { degraded: true, postProcess: { ok: true } },
    });

    const ndjson = fs
      .readFileSync(path.join(sessionDir, "events.ndjson"), "utf-8")
      .trim()
      .split("\n");
    expect(ndjson).toHaveLength(events.length);
    expect(ndjson.map((line) => JSON.parse(line).k)).toEqual(
      events.map((event) => event.k),
    );

    const index = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "index.json"), "utf-8"),
    );
    expect(index).toMatchObject({
      id: sessionId,
      start: 4_000,
      end: 4_350,
      dur: 350,
      evts: events.length,
      stats: {
        "session.lifecycle": 2,
        "frame.ctx": 1,
        "probe.ready": 1,
        nav: 1,
        clk: 1,
        inp: 1,
        con: 1,
        "net.req": 1,
        "net.res": 1,
        "net.err": 1,
        "tab.boundary": 1,
        "media.video": 1,
        "media.voice": 1,
      },
      pageProbe: {
        requested: true,
        readyEvents: 1,
        frameContexts: 1,
        startedContexts: 1,
        limitedContexts: 1,
      },
      failedReqs: [
        expect.objectContaining({ m: "POST", st: 502 }),
        expect.objectContaining({ m: "GET", st: 0, reason: "network_error" }),
      ],
      networkErrors: [
        expect.objectContaining({
          method: "GET",
          msg: "Failed to fetch",
          transport: "fetch",
        }),
      ],
      consoleErrors: [
        expect.objectContaining({
          lv: "err",
          msg: "checkout failed",
          source: "page-probe",
        }),
      ],
      tabBoundaries: [
        expect.objectContaining({
          decision: "prompt",
          reason: "outside_boundary",
          capture: false,
          nonCapture: true,
        }),
      ],
      redaction: expect.objectContaining({
        policy: BROWSER_REDACTION_POLICY,
        eventsWithRedactionEvidence: 2,
        redactedFields: 1,
        payloadSummaries: 1,
      }),
      audio: expect.objectContaining({
        artifact: "audio.webm",
        bytes: audioBytes.length,
      }),
    });
    expect(["transcription-unavailable", "transcription-error"]).toContain(
      index.audio.transcription.state,
    );

    const llm = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "llm.json"), "utf-8"),
    );
    expect(llm).toMatchObject({
      schemaVersion: 1,
      kind: "crumbtrail.agent-session-bundle",
      session: {
        id: sessionId,
        name: "Final contract fixture",
        source: "crumbtrail-extension",
        app: "checkout-app",
        durationMs: 350,
      },
      eventCounts: expect.objectContaining({
        "session.lifecycle": 2,
        "net.req": 1,
        "net.res": 1,
        "net.err": 1,
        "tab.boundary": 1,
        "media.video": 1,
        "media.voice": 1,
      }),
      browserEvidence: {
        pageProbe: expect.objectContaining({
          requested: true,
          readyEvents: 1,
          limitedContexts: 1,
        }),
        failedRequests: [
          expect.objectContaining({ method: "POST", status: 502 }),
          expect.objectContaining({
            method: "GET",
            status: 0,
            reason: "network_error",
          }),
        ],
        networkErrors: [
          expect.objectContaining({
            method: "GET",
            message: "Failed to fetch",
            transport: "fetch",
          }),
        ],
        consoleErrors: [],
        tabBoundaries: expect.objectContaining({
          total: 1,
          nonCaptureCount: 1,
          decisionCounts: { prompt: 1 },
        }),
      },
      media: {
        video: expect.objectContaining({
          path: "recording.webm",
          exists: true,
          bytes: videoBytes.length,
          eventCount: 1,
          lastState: "uploaded",
        }),
        audio: expect.objectContaining({
          path: "audio.webm",
          exists: true,
          bytes: audioBytes.length,
          eventCount: 1,
          lastState: "marker-added",
        }),
        voiceMarkers: [
          expect.objectContaining({
            offsetMs: 325,
            markerId: "voice-marker-contract",
          }),
        ],
      },
      redaction: expect.objectContaining({
        policy: BROWSER_REDACTION_POLICY,
        eventsWithRedactionEvidence: 2,
        redactedFields: 1,
        payloadSummaries: 1,
      }),
    });
    expect(llm.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "meta.json", exists: true }),
        expect.objectContaining({ path: "events.ndjson", exists: true }),
        expect.objectContaining({ path: "index.json", exists: true }),
        expect.objectContaining({ path: "llm.md", exists: true }),
        expect.objectContaining({ path: "llm.json", exists: true }),
        expect.objectContaining({
          path: "recording.webm",
          exists: true,
          bytes: videoBytes.length,
        }),
        expect.objectContaining({
          path: "audio.webm",
          exists: true,
          bytes: audioBytes.length,
        }),
        expect.objectContaining({ path: "audio.json", exists: true }),
        expect.objectContaining({ path: "frames", exists: true }),
      ]),
    );
    expect(
      llm.inspectionGuide.map((step: { path: string }) => step.path),
    ).toEqual(
      expect.arrayContaining([
        "llm.md",
        "llm.json",
        "index.json",
        "events.ndjson",
        "recording.webm",
        "audio.webm",
      ]),
    );
    expect(llm.limitations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /Audio transcription state is transcription-(unavailable|error)/,
        ),
        expect.stringContaining("Page probe was limited"),
        expect.stringContaining("network request error"),
        expect.stringContaining("tab-boundary decision"),
      ]),
    );

    const markdown = fs.readFileSync(path.join(sessionDir, "llm.md"), "utf-8");
    for (const heading of [
      "## Session",
      "## Artifact Map",
      "## Event Counts",
      "## Browser Evidence Summary",
      "### Failed Requests",
      "### Network Errors",
      "### Tab Boundary Decisions",
      "## Key Timeline Moments",
      "## Media Alignment Rules",
      "## Degraded Capabilities and Limitations",
      "## Redaction Summary",
      "## How to Inspect Raw Files",
    ]) {
      expect(markdown).toContain(heading);
    }
    expect(`${JSON.stringify(llm)}${markdown}`).not.toContain(secret);
  });
});
