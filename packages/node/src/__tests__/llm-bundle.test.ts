import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BugEvent } from "crumbtrail-core";
import {
  BROWSER_REDACTION_POLICY,
  writeLlmBundle,
  type SessionIndexLike,
} from "../llm-bundle";
import type { EvidenceCandidate } from "../evidence-index";

function expectMarkdownSections(markdown: string, sections: string[]): void {
  for (const section of sections) expect(markdown).toContain(section);
}

describe("llm bundle", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-llm-bundle-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("preserves only minted and W3C correlation ids while redacting token shaped values", () => {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    const requestId = "req_m9z4x9_abcdefghijkl";
    const sessionId = "ses_20260715_123456_abcdef123456";
    const secrets = [
      "sk_fake_abcdefghijklmnopqrstuvwx",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhbGljZSJ9.signature",
      "AKIAIOSFODNN7EXAMPLE",
    ];
    const events: BugEvent[] = [
      { t: 1_700_000_000_000, k: "session.lifecycle", d: { action: "start" } },
      {
        t: 1_700_000_000_001,
        k: "db.diff",
        d: { engine: "postgres", op: "update", table: "orders", pk: { id: 1 }, requestId: traceId },
      },
      {
        t: 1_700_000_000_002,
        k: "db.diff",
        d: { engine: "postgres", op: "update", table: "orders", pk: { id: 2 }, requestId },
      },
      ...secrets.map((requestId, index) => ({
        t: 1_700_000_000_003 + index,
        k: "db.diff" as const,
        d: { engine: "postgres", op: "update", table: "orders", pk: { id: index + 3 }, requestId },
      })),
    ];
    const index: SessionIndexLike = {
      id: sessionId,
      start: events[0].t,
      end: events.at(-1)!.t,
      dur: 5,
      evts: events.length,
      stats: { "db.diff": 5 },
      fullStackRequests: {
        schemaVersion: 1,
        summary: { frontendRequests: 2, backendRequests: 2, linked: 2, gaps: 0 },
        linked: [
          {
            requestId: traceId,
            sessionId,
            frontend: { requestId: traceId, sessionId, method: "POST" },
            backend: { requestId: traceId, sessionId, method: "POST" },
          },
          {
            requestId: secrets[0],
            sessionId: secrets[1],
            frontend: { requestId: secrets[0], sessionId: secrets[1], method: "POST" },
            backend: { requestId: secrets[0], sessionId: secrets[1], method: "POST" },
          },
        ],
        gaps: [
          { type: "frontend-only", requestId, sessionId },
          { type: "frontend-only", requestId: secrets[2], sessionId: secrets[0] },
        ],
      },
    };

    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });
    expect(bundle.databaseDiffs.map((diff) => diff.requestId)).toEqual([
      traceId,
      requestId,
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
    ]);
    expect(bundle.fullStackEvidence.linked[0]).toMatchObject({ requestId: traceId, sessionId });
    const serialized = JSON.stringify(bundle);
    for (const secret of secrets) expect(serialized).not.toContain(secret);
    expect(serialized).toContain("[REDACTED]");
  });

  it("surfaces a redaction-aware environment snapshot merged from env events", () => {
    const events: BugEvent[] = [
      {
        t: 1_700_000_100_000,
        k: "session.lifecycle",
        offsetMs: 0,
        d: { action: "start" },
      },
      {
        t: 1_700_000_100_010,
        k: "env",
        offsetMs: 10,
        d: {
          kind: "snapshot",
          userAgent: "Mozilla/5.0 Chrome/120.0.0.0",
          browser: { name: "Chrome", version: "120.0.0.0" },
          os: "macOS",
          viewport: { w: 1440, h: 900 },
          locale: "en-US",
          timezone: "America/New_York",
          flags: { betaUi: true, apiKey: "sk_fake_abcdefghijklmnopqrstuvwx" },
        },
      },
      {
        t: 1_700_000_100_500,
        k: "env",
        offsetMs: 500,
        d: { kind: "delta", config: { region: "eu" } },
      },
    ];
    const index: SessionIndexLike = {
      id: "ses_env",
      start: events[0].t,
      end: events[2].t,
      dur: 500,
      evts: events.length,
      stats: { env: 2, "session.lifecycle": 1 },
    };

    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });

    expect(bundle.environment).not.toBeNull();
    expect(bundle.environment!.browser).toEqual({
      name: "Chrome",
      version: "120.0.0.0",
    });
    expect(bundle.environment!.viewport).toEqual({ w: 1440, h: 900 });
    expect(bundle.environment!.flags!.betaUi).toBe(true);
    expect(bundle.environment!.config!.region).toBe("eu");

    const serialized = JSON.stringify(bundle.environment);
    expect(serialized).not.toContain("sk_fake_abcdefghijklmnopqrstuvwx");

    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    expectMarkdownSections(markdown, [
      "## Environment",
      "Chrome 120.0.0.0",
      "America/New_York",
    ]);
  });

  it("defaults environment to null when no env events are present", () => {
    const events: BugEvent[] = [
      {
        t: 1_700_000_200_000,
        k: "session.lifecycle",
        offsetMs: 0,
        d: { action: "start" },
      },
    ];
    const index: SessionIndexLike = {
      id: "ses_no_env",
      start: events[0].t,
      end: events[0].t,
      dur: 0,
      evts: 1,
      stats: { "session.lifecycle": 1 },
    };
    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });
    expect(bundle.environment).toBeNull();
  });

  it("summarizes capture gaps into deterministic completeness grades", () => {
    const start = 1_700_000_250_000;
    const degradedEvents: BugEvent[] = [
      {
        t: start,
        k: "backend.req.start",
        d: { requestId: "trace-1" },
      },
      {
        t: start + 1,
        k: "db.diff",
        d: {
          engine: "postgres",
          op: "update",
          table: "orders",
          pk: { id: 1 },
          requestId: "trace-1",
        },
      },
      {
        t: start + 2,
        k: "capture_gap",
        d: {
          kind: "capture_gap",
          surface: "db_diff",
          reason: "unparsed_sql",
          t: start + 2,
        },
      },
      {
        t: start + 3,
        k: "capture_gap",
        d: {
          kind: "capture_gap",
          surface: "backend_request",
          reason: "header_stripped",
          t: start + 3,
        },
      },
    ];
    const index: SessionIndexLike = {
      id: "ses-completeness",
      start,
      end: start + 3,
      dur: 3,
      evts: degradedEvents.length,
      stats: {},
    };

    expect(
      writeLlmBundle({ sessionDir: tmpDir, events: degradedEvents, index })
        .completeness,
    ).toEqual({
      gapCount: 2,
      gapsBySurface: { db_diff: 1, backend_request: 1 },
      gapsByReason: { unparsed_sql: 1, header_stripped: 1 },
      grade: "degraded",
    });

    const fragmentary = writeLlmBundle({
      sessionDir: tmpDir,
      events: degradedEvents.filter((event) => event.k === "capture_gap"),
      index: { ...index, evts: 2 },
    });
    expect(fragmentary.completeness.grade).toBe("fragmentary");

    const complete = writeLlmBundle({
      sessionDir: tmpDir,
      events: [{ t: start, k: "nav", d: {} }],
      index: { ...index, evts: 1 },
    });
    expect(complete.completeness).toMatchObject({
      gapCount: 0,
      grade: "complete",
    });
  });

  it("surfaces OTel DB activity as statements, not row diffs", () => {
    const events: BugEvent[] = [
      {
        t: 1_700_000_300_000,
        k: "backend.otel.span",
        offsetMs: 50,
        d: {
          traceId: "trace-db",
          spanId: "db1",
          name: "SELECT orders",
          serviceName: "api",
          attributes: {
            "db.system": "postgresql",
            "db.operation": "SELECT",
            "db.statement":
              "select * from orders where access_token = sk_fake_abcdefghijklmnopqrstuvwx",
          },
        },
      },
    ];
    const index: SessionIndexLike = {
      id: "ses_otlp_db",
      start: events[0].t,
      end: events[0].t,
      dur: 0,
      evts: 1,
      stats: { "backend.otel.span": 1 },
    };
    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });
    expect(bundle.databaseActivity).toHaveLength(1);
    expect(bundle.databaseActivity[0]).toMatchObject({
      evidenceType: "otel_db_activity_statements_not_row_diffs",
      system: "postgresql",
      operation: "SELECT",
      requestId: "trace-db",
    });
    expect(bundle.databaseActivity[0].upgradeHint).toContain(
      "row diffs unavailable",
    );
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    expect(markdown).toContain("## Database Activity Statements");
    expect(markdown).toContain(
      "OTel DB spans report statements and operations only; they are not before/after row diffs.",
    );
    expect(markdown).toContain("row diffs unavailable");
    expect(JSON.stringify(bundle.databaseActivity) + markdown).not.toContain(
      "sk_fake_abcdefghijklmnopqrstuvwx",
    );
  });

  it("writes agent-first JSON and markdown with artifacts, timeline, redaction, and degradation summaries", () => {
    const secret = "sk_abcdefghijklmnopqrstuvwxyz";
    const events: BugEvent[] = [
      {
        t: 1_700_000_000_000,
        k: "session.lifecycle",
        sessionId: "ses_llm",
        offsetMs: 0,
        d: {
          action: "start",
          reason: "user",
          rootUrl: `https://app.example.test/cart?token=${secret}#checkout`,
        },
      },
      {
        t: 1_700_000_000_050,
        k: "nav",
        sessionId: "ses_llm",
        offsetMs: 50,
        d: { to: `https://app.example.test/cart?session=${secret}#private` },
      },
      {
        t: 1_700_000_000_100,
        k: "net.req",
        sessionId: "ses_llm",
        offsetMs: 100,
        d: {
          id: "r1",
          m: "POST",
          url: `https://api.example.test/orders?access_token=${secret}`,
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              {
                path: "url.query.access_token",
                reason: "url_query_value",
                action: "redacted",
              },
              {
                path: "headers.authorization",
                reason: "sensitive_header_name",
                action: "redacted",
              },
            ],
          },
        },
      },
      {
        t: 1_700_000_000_200,
        k: "net.res",
        sessionId: "ses_llm",
        offsetMs: 200,
        d: {
          id: "r1",
          st: 500,
          bodySummary: {
            kind: "json",
            action: "summarized",
            reason: "size_limit",
            originalLength: 4096,
          },
        },
      },
      {
        t: 1_700_000_000_300,
        k: "media.video",
        sessionId: "ses_llm",
        offsetMs: 300,
        d: {
          capability: "video",
          state: "error",
          code: "upload_failed",
          phase: "upload",
          message: `upload failed for ${secret}`,
          retryable: true,
        },
      },
      {
        t: 1_700_000_000_400,
        k: "media.voice",
        sessionId: "ses_llm",
        offsetMs: 400,
        d: {
          capability: "audio",
          state: "marker-added",
          markerId: "voice-marker-1",
          label: `checkout note ${secret}`,
        },
      },
    ];
    const stats = events.reduce<Record<string, number>>((acc, event) => {
      acc[event.k] = (acc[event.k] ?? 0) + 1;
      return acc;
    }, {});
    const index: SessionIndexLike = {
      id: "ses_llm",
      start: events[0].t,
      end: events[events.length - 1].t,
      dur: 400,
      evts: events.length,
      errs: [],
      failedReqs: [
        {
          t: events[3].t,
          m: "POST",
          url: `https://api.example.test/orders?access_token=${secret}`,
          st: 500,
        },
      ],
      navs: [
        {
          t: events[1].t,
          to: `https://app.example.test/cart?session=${secret}#private`,
        },
      ],
      stats,
      audio: {
        artifact: "audio.webm",
        bytes: 9,
        upload: {
          metadataFile: "audio.json",
          contentType: "audio/webm",
          durationMs: 1200,
          chunkCount: 2,
          transcriptionRequested: true,
        },
        transcription: {
          state: "transcription-unavailable",
          code: "transcription_unavailable",
          message: `Audio preserved, transcript unavailable for ${secret}`,
        },
      },
    };

    fs.writeFileSync(
      path.join(tmpDir, "meta.json"),
      JSON.stringify({
        id: "ses_llm",
        source: "crumbtrail-extension",
        name: "Checkout regression",
        startedAt: events[0].t,
        capabilities: {
          events: true,
          video: true,
          audio: true,
          pageProbe: true,
        },
        collection: {
          video: { enabled: true, degraded: false },
          audio: { enabled: true, degraded: false },
          network: {
            enabled: true,
            degraded: false,
            redaction: BROWSER_REDACTION_POLICY,
          },
        },
        degradedCollection: ["clipboard"],
        tabBoundary: {
          enabled: true,
          redaction: "origin-only",
          rootOrigin: "https://app.example.test",
          allowedOrigins: [
            "https://app.example.test",
            "https://api.example.test",
          ],
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(index));
    fs.writeFileSync(
      path.join(tmpDir, "recording.webm"),
      Buffer.from("video bytes"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "audio.webm"),
      Buffer.from("audio webm"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "audio.json"),
      JSON.stringify({ transcriptionRequested: true }),
    );

    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });
    const persisted = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    const serializedBundle = JSON.stringify(persisted) + markdown;

    expect(bundle.kind).toBe("crumbtrail.agent-session-bundle");
    expect(persisted.session).toMatchObject({
      id: "ses_llm",
      name: "Checkout regression",
      durationMs: 400,
    });
    expect(persisted.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "recording.webm",
          exists: true,
          bytes: Buffer.byteLength("video bytes"),
        }),
        expect.objectContaining({
          path: "audio.webm",
          exists: true,
          bytes: Buffer.byteLength("audio webm"),
        }),
        expect.objectContaining({ path: "llm.md", exists: true }),
        expect.objectContaining({ path: "llm.json", exists: true }),
      ]),
    );
    expect(persisted.eventCounts).toMatchObject({
      "media.video": 1,
      "media.voice": 1,
      "net.req": 1,
      "net.res": 1,
    });
    expect(persisted.media.alignment.rules.join("\n")).toContain("offsetMs");
    expect(persisted.media.voiceMarkers[0]).toMatchObject({
      offsetMs: 400,
      markerId: "voice-marker-1",
    });
    expect(persisted.degradedCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "video",
          state: "error",
          code: "upload_failed",
          source: "event",
        }),
        expect.objectContaining({
          capability: "audio-transcription",
          state: "transcription-unavailable",
          source: "post-process",
        }),
        expect.objectContaining({
          capability: "clipboard",
          state: "degraded-at-start",
          source: "metadata",
        }),
      ]),
    );
    expect(persisted.redaction).toMatchObject({
      policy: BROWSER_REDACTION_POLICY,
      eventsWithRedactionEvidence: 2,
      redactedFields: 2,
      payloadSummaries: 1,
    });
    expect(persisted.redaction.reasons).toMatchObject({
      sensitive_header_name: 1,
      size_limit: 1,
      url_query_value: 1,
    });
    expectMarkdownSections(markdown, [
      "## Session",
      "## Artifact Map",
      "## Event Counts",
      "## Browser Evidence Summary",
      "## Key Timeline Moments",
      "## Media Alignment Rules",
      "## Degraded Capabilities and Limitations",
      "## Redaction Summary",
      "## How to Inspect Raw Files",
    ]);
    expect(markdown).toContain("recording.webm");
    expect(markdown).toContain("transcription-unavailable");
    expect(serializedBundle).toContain("[REDACTED]");
    expect(serializedBundle).not.toContain(secret);
  });

  it("reports expected missing media as limitations instead of successful capture", () => {
    const events: BugEvent[] = [
      {
        t: 1_700_000_001_000,
        k: "session.lifecycle",
        sessionId: "ses_missing_media",
        offsetMs: 0,
        d: {
          action: "start",
          reason: "user",
          rootUrl: "https://app.example.test/",
        },
      },
      {
        t: 1_700_000_001_100,
        k: "media.video",
        sessionId: "ses_missing_media",
        offsetMs: 100,
        d: { capability: "video", state: "recording" },
      },
      {
        t: 1_700_000_001_200,
        k: "media.voice",
        sessionId: "ses_missing_media",
        offsetMs: 200,
        d: { capability: "audio", state: "recording" },
      },
    ];
    const index: SessionIndexLike = {
      id: "ses_missing_media",
      start: events[0].t,
      end: events[2].t,
      dur: 200,
      evts: events.length,
      errs: [],
      failedReqs: [],
      navs: [],
      stats: { "session.lifecycle": 1, "media.video": 1, "media.voice": 1 },
    };

    fs.writeFileSync(
      path.join(tmpDir, "meta.json"),
      JSON.stringify({
        id: "ses_missing_media",
        capabilities: {
          events: true,
          video: true,
          audio: true,
          pageProbe: true,
        },
        collection: { video: { enabled: true }, audio: { enabled: true } },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(index));

    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");

    expect(bundle.media.video).toMatchObject({
      path: "recording.webm",
      exists: false,
      eventCount: 1,
      lastState: "recording",
    });
    expect(bundle.media.audio).toMatchObject({
      path: "audio.webm",
      exists: false,
      eventCount: 1,
      lastState: "recording",
    });
    expect(bundle.degradedCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "video",
          state: "artifact-missing",
          artifact: "recording.webm",
        }),
        expect.objectContaining({
          capability: "audio",
          state: "artifact-missing",
          artifact: "audio.webm",
        }),
      ]),
    );
    expect(bundle.limitations).toEqual(
      expect.arrayContaining([
        "recording.webm is missing, so active-tab video cannot be inspected for this session.",
        "audio.webm is missing, so continuous microphone audio cannot be inspected for this session.",
      ]),
    );
    expect(markdown).toContain("recording.webm is missing");
    expect(markdown).toContain("audio.webm is missing");
  });

  it("highlights performance and storage evidence without exposing raw page secrets", () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    const embeddedSecret = `auth_${secret}`;
    const events: BugEvent[] = [
      {
        t: 1_700_000_001_000,
        k: "probe.ready",
        offsetMs: 0,
        d: {
          source: "page-probe",
          features: { performance: true, storage: true },
        },
      },
      {
        t: 1_700_000_001_010,
        k: "perf",
        offsetMs: 10,
        d: {
          source: "page-probe",
          metric: "res",
          entryType: "resource",
          name: `https://cdn.example.test/${embeddedSecret}/app.js?token=[REDACTED]`,
          duration: 34,
        },
      },
      {
        t: 1_700_000_001_020,
        k: "snap",
        offsetMs: 20,
        d: {
          source: "content-script",
          localStorage: { authToken: "[REDACTED]" },
          cookies: { session: "[REDACTED]" },
        },
      },
      {
        t: 1_700_000_001_030,
        k: "inp",
        offsetMs: 30,
        d: { source: "content-script", val: "[REDACTED]" },
      },
    ];
    const index: SessionIndexLike = {
      id: "ses_perf_storage",
      start: events[0].t,
      end: events.at(-1)!.t,
      dur: 30,
      evts: events.length,
      errs: [],
      failedReqs: [],
      networkErrors: [],
      consoleErrors: [],
      navs: [],
      stats: { "probe.ready": 1, perf: 1, snap: 1, inp: 1 },
      storageSummary: {
        localStorageKeys: 1,
        sessionStorageKeys: 0,
        cookies: 1,
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(index));

    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    const serialized = JSON.stringify(bundle) + markdown;

    expect(bundle.eventCounts).toMatchObject({ perf: 1, snap: 1, inp: 1 });
    expect(bundle.keyTimelineMoments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          k: "perf",
          summary: expect.stringContaining("performance res"),
        }),
        expect.objectContaining({
          k: "snap",
          summary: expect.stringContaining("raw values are not repeated"),
        }),
        expect.objectContaining({
          k: "inp",
          summary: expect.stringContaining("raw values are not repeated"),
        }),
      ]),
    );
    expect(markdown).toContain(
      "performance res; https://cdn.example.test/auth_[REDACTED]/app.js?token=%5BREDACTED%5D; 34 ms",
    );
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(embeddedSecret);
    expect(serialized).not.toContain("authToken=" + secret);
  });

  it("summarizes page probe, console, request failure, and boundary evidence", () => {
    const events: BugEvent[] = [
      {
        t: 1_700_000_002_000,
        k: "frame.ctx",
        offsetMs: 0,
        d: {
          source: "content-script",
          pageProbe: { requested: true, started: true, limited: false },
        },
      },
      {
        t: 1_700_000_002_020,
        k: "probe.ready",
        offsetMs: 20,
        d: {
          source: "page-probe",
          features: { console: true, fetch: true, xhr: false },
        },
      },
      {
        t: 1_700_000_002_040,
        k: "con",
        offsetMs: 40,
        d: { source: "page-probe", lv: "err", args: ["checkout failed"] },
      },
      {
        t: 1_700_000_002_060,
        k: "net.req",
        offsetMs: 60,
        d: {
          id: "r1",
          m: "POST",
          url: "https://api.example.test/pay?token=[REDACTED]",
        },
      },
      {
        t: 1_700_000_002_080,
        k: "net.res",
        offsetMs: 80,
        d: { id: "r1", st: 503 },
      },
      {
        t: 1_700_000_002_100,
        k: "net.err",
        offsetMs: 100,
        d: {
          transport: "fetch",
          method: "GET",
          url: "https://api.example.test/offline",
          msg: "Failed to fetch",
        },
      },
      {
        t: 1_700_000_002_120,
        k: "tab.boundary",
        offsetMs: 120,
        d: {
          signal: "activated",
          decision: "prompt",
          reason: "outside_boundary",
          capture: false,
          nonCapture: true,
          candidate: {
            origin: "https://outside.example.test/private?token=secret",
          },
          previousCapturedOrigin: "https://app.example.test/root?token=secret",
        },
      },
    ];
    const index: SessionIndexLike = {
      id: "ses_browser_evidence",
      start: events[0].t,
      end: events.at(-1)!.t,
      dur: 120,
      evts: events.length,
      errs: [],
      failedReqs: [
        {
          t: events[4].t,
          m: "POST",
          url: "https://api.example.test/pay?token=[REDACTED]",
          st: 503,
        },
      ],
      networkErrors: [
        {
          t: events[5].t,
          offsetMs: 100,
          method: "GET",
          url: "https://api.example.test/offline",
          msg: "Failed to fetch",
          transport: "fetch",
        },
      ],
      consoleErrors: [
        {
          t: events[2].t,
          offsetMs: 40,
          lv: "err",
          msg: "checkout failed",
          source: "page-probe",
        },
      ],
      navs: [],
      stats: {},
      tabBoundaries: [
        {
          t: events[6].t,
          offsetMs: 120,
          signal: "activated",
          decision: "prompt",
          reason: "outside_boundary",
          capture: false,
          nonCapture: true,
          previousCapturedOrigin: "https://app.example.test",
          candidate: { origin: "https://outside.example.test" },
        },
      ],
    };
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(index));

    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    const serialized = JSON.stringify(bundle) + markdown;

    expect(bundle.browserEvidence.pageProbe).toMatchObject({
      requested: true,
      readyEvents: 1,
      frameContexts: 1,
    });
    expect(bundle.browserEvidence.consoleErrors).toEqual([]);
    expect(bundle.browserEvidence.failedRequests).toEqual([
      expect.objectContaining({ method: "POST", status: 503 }),
    ]);
    expect(bundle.browserEvidence.networkErrors).toEqual([
      expect.objectContaining({ method: "GET", message: "Failed to fetch" }),
    ]);
    expect(bundle.browserEvidence.tabBoundaries).toMatchObject({
      total: 1,
      nonCaptureCount: 1,
      decisionCounts: { prompt: 1 },
    });
    expect(bundle.limitations).toContain(
      "1 network request error(s) occurred before an HTTP response was captured.",
    );
    expect(bundle.limitations).toContain(
      "1 tab-boundary decision(s) intentionally marked non-capture; outside-boundary pages were not silently recorded.",
    );
    expect(bundle.limitations).toContain(
      "Page-probe events are page-world-untrusted and are included only as corroboration hints, not authoritative evidence.",
    );
    expectMarkdownSections(markdown, [
      "## Browser Evidence Summary",
      "### Failed Requests",
      "### Network Errors",
      "### Tab Boundary Decisions",
    ]);
    expect(serialized).not.toContain("token=secret");
    expect(serialized).not.toContain("/private");
  });

  it("selects identical summaries from an index-only vs an event-only lane", () => {
    const t = 1_700_000_500_100;
    const start = 1_700_000_500_000;
    const netFields = {
      method: "GET",
      url: "https://api.example.test/offline",
      msg: "Failed to fetch",
      transport: "fetch",
    };
    const tabFields = {
      signal: "activated",
      decision: "prompt",
      reason: "outside_boundary",
      capture: false,
      nonCapture: true,
      candidate: { origin: "https://outside.example.test" },
      previousCapturedOrigin: "https://app.example.test",
    };

    const baseIndex = (): SessionIndexLike => ({
      id: "ses_seam",
      start,
      end: t,
      dur: t - start,
      evts: 1,
      errs: [],
      failedReqs: [],
      navs: [],
      stats: {},
    });

    // Index-only: summaries live in the index, no matching events.
    const indexOnlyEvents: BugEvent[] = [
      { t: start, k: "session.lifecycle", offsetMs: 0, d: { action: "start" } },
    ];
    const indexOnly = {
      ...baseIndex(),
      networkErrors: [{ t, offsetMs: 100, ...netFields }],
      tabBoundaries: [{ t, offsetMs: 120, ...tabFields }],
    };

    // Event-only: index lanes empty, so selection falls through to events.
    const eventOnlyEvents: BugEvent[] = [
      { t: start, k: "session.lifecycle", offsetMs: 0, d: { action: "start" } },
      { t, k: "net.err", offsetMs: 100, d: { ...netFields } },
      { t, k: "tab.boundary", offsetMs: 120, d: { ...tabFields } },
    ];
    const eventOnly = {
      ...baseIndex(),
      networkErrors: [],
      tabBoundaries: [],
    };

    const fromIndex = writeLlmBundle({
      sessionDir: fs.mkdtempSync(path.join(tmpDir, "idx-")),
      events: indexOnlyEvents,
      index: indexOnly,
    });
    const fromEvents = writeLlmBundle({
      sessionDir: fs.mkdtempSync(path.join(tmpDir, "evt-")),
      events: eventOnlyEvents,
      index: eventOnly,
    });

    expect(fromIndex.browserEvidence.networkErrors).toEqual(
      fromEvents.browserEvidence.networkErrors,
    );
    expect(fromIndex.browserEvidence.networkErrors).toHaveLength(1);
    expect(fromIndex.browserEvidence.tabBoundaries.decisions).toEqual(
      fromEvents.browserEvidence.tabBoundaries.decisions,
    );
    expect(fromIndex.browserEvidence.tabBoundaries.decisions).toHaveLength(1);
  });

  it("renders sanitized full-stack request evidence in JSON and markdown with gap limitations", () => {
    const secret = "sk_abcdefghijklmnopqrstuvwxyz";
    const events: BugEvent[] = [
      {
        t: 1_700_000_003_000,
        k: "session.lifecycle",
        offsetMs: 0,
        d: { action: "start" },
      },
    ];
    const index: SessionIndexLike = {
      id: "ses_full_stack",
      start: events[0].t,
      end: events[0].t,
      dur: 0,
      evts: events.length,
      errs: [],
      failedReqs: [],
      navs: [],
      stats: { "session.lifecycle": 1 },
      fullStackRequests: {
        schemaVersion: 1,
        summary: {
          frontendRequests: 2,
          backendRequests: 2,
          linked: 1,
          gaps: 2,
          gapTypes: { "frontend-only": 1, "backend-generated-request-id": 1 },
        },
        linked: [
          {
            requestId: "req-linked",
            sessionId: "sess-1",
            frontend: {
              ref: { t: events[0].t + 10, offsetMs: 10, k: "net.req" },
              requestId: "req-linked",
              sessionId: "sess-1",
              method: "POST",
              url: `https://api.example.test/orders?access_token=${secret}#private`,
              status: 502,
              durationMs: 60,
            },
            backend: {
              requestId: "req-linked",
              sessionId: "sess-1",
              start: {
                t: events[0].t + 20,
                offsetMs: 20,
                k: "backend.req.start",
              },
              end: { t: events[0].t + 50, offsetMs: 50, k: "backend.req.end" },
              method: "POST",
              pathname: `/api/orders/${secret}`,
              statusCode: 502,
              durationMs: 30,
              error: { code: "UPSTREAM_FAILED", message: `Bearer ${secret}` },
            },
          },
        ],
        gaps: [
          {
            type: "frontend-only",
            requestId: "req-front-only",
            sessionId: "sess-1",
            frontend: {
              ref: { t: events[0].t + 100, offsetMs: 100, k: "net.req" },
              requestId: "req-front-only",
              sessionId: "sess-1",
              method: "GET",
              url: `https://api.example.test/client-only?token=${secret}`,
              error: { transport: "fetch", message: `failed token ${secret}` },
            },
          },
          {
            type: "backend-generated-request-id",
            requestId: "backend_req_1",
            sessionId: "sess-1",
            backend: {
              requestId: "backend_req_1",
              sessionId: "sess-1",
              method: "GET",
              pathname: `/api/generated/${secret}`,
              correlation: {
                status: "generated-request-id",
                sessionIdSource: "header",
                requestIdSource: "generated",
              },
            },
          },
          { type: "not-real", requestId: "bad", frontend: { method: "GET" } },
        ],
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(index));

    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });
    const persisted = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    const serialized = JSON.stringify(persisted) + markdown;

    expect(bundle.fullStackEvidence.summary).toMatchObject({
      frontendRequests: 2,
      backendRequests: 2,
      linked: 1,
      gaps: 2,
    });
    expect(persisted.fullStackEvidence.linked).toEqual([
      expect.objectContaining({
        requestId: "req-linked",
        sessionId: "sess-1",
        frontend: expect.objectContaining({
          method: "POST",
          status: 502,
          durationMs: 60,
        }),
        backend: expect.objectContaining({
          method: "POST",
          statusCode: 502,
          durationMs: 30,
        }),
      }),
    ]);
    expect(
      persisted.fullStackEvidence.gaps.map((gap: any) => gap.type),
    ).toEqual(["frontend-only", "backend-generated-request-id"]);
    expect(bundle.limitations).toContain(
      "Partial full-stack linkage exists; do not assume every frontend request has backend evidence or every backend request has frontend evidence.",
    );
    expectMarkdownSections(markdown, [
      "## Full-Stack Request Evidence",
      "### Linked Request Moments",
      "### Partial-Linkage Gaps",
    ]);
    expect(markdown).toContain("Linked request moments: 1");
    expect(markdown).toContain("Partial-linkage gaps: 2");
    expect(markdown).toContain("frontend-only");
    expect(markdown).toContain("backend-generated-request-id");
    expect(markdown).toContain(
      "do not assume every frontend request has backend evidence",
    );
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("access_token=sk_");
    expect(serialized).not.toContain("Bearer sk_");
  });

  it("caps full-stack JSON summaries at 40 and markdown tables at 10 while preserving totals", () => {
    const events: BugEvent[] = [
      {
        t: 1_700_000_004_000,
        k: "session.lifecycle",
        offsetMs: 0,
        d: { action: "start" },
      },
    ];
    const linked = Array.from({ length: 45 }, (_, i) => ({
      requestId: `req-${i}`,
      sessionId: "sess-cap",
      frontend: {
        ref: { t: events[0].t + i, offsetMs: i, k: "net.req" },
        requestId: `req-${i}`,
        sessionId: "sess-cap",
        method: "GET",
        url: `/api/linked-${i}`,
        status: 200,
      },
      backend: {
        requestId: `req-${i}`,
        sessionId: "sess-cap",
        method: "GET",
        pathname: `/api/linked-${i}`,
        statusCode: 200,
      },
    }));
    const gaps = Array.from({ length: 45 }, (_, i) => ({
      type: "frontend-only",
      requestId: `gap-${i}`,
      sessionId: "sess-cap",
      frontend: {
        ref: { t: events[0].t + 100 + i, offsetMs: 100 + i, k: "net.req" },
        requestId: `gap-${i}`,
        sessionId: "sess-cap",
        method: "GET",
        url: `/api/gap-${i}`,
      },
    }));
    const index: SessionIndexLike = {
      id: "ses_caps",
      start: events[0].t,
      end: events[0].t,
      dur: 0,
      evts: events.length,
      errs: [],
      failedReqs: [],
      navs: [],
      stats: {},
      fullStackRequests: {
        schemaVersion: 1,
        summary: {
          frontendRequests: 90,
          backendRequests: 45,
          linked: 45,
          gaps: 45,
          gapTypes: { "frontend-only": 45 },
        },
        linked,
        gaps,
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(index));

    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");

    expect(bundle.fullStackEvidence.summary).toMatchObject({
      linked: 45,
      gaps: 45,
    });
    expect(bundle.fullStackEvidence.linked).toHaveLength(40);
    expect(bundle.fullStackEvidence.gaps).toHaveLength(40);
    expect(bundle.limitations).toEqual(
      expect.arrayContaining([
        "Full-stack linked request summaries are capped at 40 of 45.",
        "Full-stack linkage gap summaries are capped at 40 of 45.",
      ]),
    );
    expect(markdown).toContain("req-9");
    expect(markdown).not.toContain("req-10");
    expect(markdown).toContain("gap-9");
    expect(markdown).not.toContain("gap-10");
  });

  it("handles absent or malformed full-stack request index entries without crashing", () => {
    const events: BugEvent[] = [
      {
        t: 1_700_000_005_000,
        k: "session.lifecycle",
        offsetMs: 0,
        d: { action: "start" },
      },
    ];
    const index: SessionIndexLike = {
      id: "ses_no_full_stack",
      start: events[0].t,
      end: events[0].t,
      dur: 0,
      evts: events.length,
      errs: [],
      failedReqs: [],
      navs: [],
      stats: {},
      fullStackRequests: {
        schemaVersion: 1,
        summary: {
          frontendRequests: 1,
          backendRequests: 1,
          linked: 1,
          gaps: 1,
          gapTypes: { bogus: 1 },
        },
        linked: [
          { requestId: "", sessionId: "sess", frontend: "bad", backend: null },
        ],
        gaps: [{ type: "bogus", requestId: "bad" }],
      },
    };
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(index));

    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");

    expect(bundle.fullStackEvidence.summary).toMatchObject({
      frontendRequests: 1,
      backendRequests: 1,
      linked: 1,
      gaps: 1,
    });
    expect(bundle.fullStackEvidence.linked).toEqual([]);
    expect(bundle.fullStackEvidence.gaps).toEqual([]);
    expect(markdown).toContain("## Full-Stack Request Evidence");
    expect(markdown).toContain("Linked request moments: 1");
  });

  it("summarizes tab boundary root current candidate prompt outcomes with caps and redaction", () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    const events: BugEvent[] = [
      {
        t: 1_700_000_006_000,
        k: "session.lifecycle",
        offsetMs: 0,
        d: { action: "start" },
      },
    ];
    const decisions = [
      {
        decision: "follow",
        reason: "same_origin",
        capture: true,
        nonCapture: false,
        prompt: {
          outcome: "approved",
          origin: "https://app.example.test/approve?token=secret",
        },
      },
      {
        decision: "prompt",
        reason: "outside_boundary",
        capture: false,
        nonCapture: true,
        prompt: {
          outcome: "pending",
          origin: "https://prompt.example.test/private?token=secret",
        },
      },
      {
        decision: "pause",
        reason: "user_denied_origin",
        capture: false,
        nonCapture: true,
        prompt: {
          outcome: "denied",
          origin: "https://deny.example.test/pay?card=secret",
        },
      },
      {
        decision: "ignore",
        reason: "candidate_scheme_restricted",
        capture: false,
        nonCapture: true,
      },
      {
        decision: "mystery",
        reason: "unknown_decision",
        capture: false,
        nonCapture: true,
      },
      ...Array.from({ length: 40 }, (_, i) => ({
        decision: "prompt",
        reason: "outside_boundary",
        capture: false,
        nonCapture: true,
        prompt: {
          outcome: "pending",
          origin: `https://overflow-${i}.example.test/private?token=secret`,
        },
      })),
    ];
    const tabBoundaries = decisions.map((entry, i) => ({
      t: events[0].t + 100 + i,
      offsetMs: 100 + i,
      signal: "activated",
      ...entry,
      root: { origin: "https://app.example.test/root?token=secret" },
      current: { origin: "https://app.example.test/current?token=secret" },
      candidate:
        i === 3
          ? {
              scheme: "chrome-extension",
              host: `extension.invalid/private?token=${secret}`,
            }
          : {
              origin: `https://candidate-${i}.example.test/private?token=${secret}`,
              host: `candidate-${i}.example.test/private?token=${secret}`,
            },
    }));
    const index: SessionIndexLike = {
      id: "ses_boundary_bundle",
      start: events[0].t,
      end: events[0].t + 200,
      dur: 200,
      evts: events.length,
      errs: [],
      failedReqs: [],
      navs: [],
      stats: { "tab.boundary": tabBoundaries.length },
      tabBoundaries,
    };
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((event) => JSON.stringify(event)).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(index));

    const bundle = writeLlmBundle({ sessionDir: tmpDir, events, index });
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    const serialized = JSON.stringify(bundle) + markdown;

    expect(bundle.browserEvidence.tabBoundaries.total).toBe(45);
    expect(bundle.browserEvidence.tabBoundaries.decisions).toHaveLength(40);
    expect(bundle.browserEvidence.tabBoundaries.nonCaptureCount).toBe(44);
    expect(bundle.browserEvidence.tabBoundaries.decisionCounts).toMatchObject({
      follow: 1,
      prompt: 41,
      pause: 1,
      ignore: 1,
      mystery: 1,
    });
    expect(bundle.browserEvidence.tabBoundaries.decisions[0]).toMatchObject({
      decision: "follow",
      reason: "same_origin",
      root: { origin: "https://app.example.test" },
      current: { origin: "https://app.example.test" },
      candidate: { origin: "https://candidate-0.example.test" },
      prompt: { outcome: "approved", origin: "https://app.example.test" },
    });
    expect(markdown).toContain("### Tab Boundary Decisions");
    expect(markdown).toContain("approved https://app.example.test");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("/private");
    expect(serialized).not.toContain("/pay");
    expect(serialized).not.toContain("card=");
  });
});

describe("llm bundle distinct-bug flag-note titles", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-llm-flag-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const BASE = 1_700_000_100_000;

  function candidate(
    overrides: Partial<EvidenceCandidate> &
      Pick<EvidenceCandidate, "id" | "detector" | "title" | "anchor">,
  ): EvidenceCandidate {
    return {
      schemaVersion: 1,
      severity: "high",
      score: 80,
      confidence: "high",
      evidenceWindow: {
        start: overrides.anchor.t - 15,
        end: overrides.anchor.t + 45,
        windowId: "win_0001",
      },
      ...overrides,
    } as EvidenceCandidate;
  }

  function degradedCandidate(): EvidenceCandidate {
    return candidate({
      id: "cand_0001",
      detector: "uncaught_error",
      title: "Uncaught error: message unavailable",
      anchor: { t: BASE + 1000, offsetMs: 1000 },
    });
  }

  function sessionEvents(flag?: { t: number; note: string }): BugEvent[] {
    const events: BugEvent[] = [
      {
        t: BASE,
        k: "session.lifecycle",
        offsetMs: 0,
        d: { action: "start" },
      },
      {
        t: BASE + 1000,
        k: "err",
        offsetMs: 1000,
        d: { kind: "uncaught" },
      },
    ];
    if (flag) {
      events.push({
        t: flag.t,
        k: "bug.flag",
        offsetMs: flag.t - BASE,
        d: { note: flag.note },
      });
    }
    return events.sort((a, b) => a.t - b.t);
  }

  function buildBundle(events: BugEvent[], candidates: EvidenceCandidate[]) {
    const index: SessionIndexLike = {
      id: "ses_flag",
      start: BASE,
      end: BASE + 5000,
    };
    return writeLlmBundle({ sessionDir: tmpDir, events, index, candidates });
  }

  it("replaces a degraded title with the user's in-window flag note", () => {
    const note = "Checkout dies with a 500 every time I hit Pay";
    const bundle = buildBundle(sessionEvents({ t: BASE + 1005, note }), [
      degradedCandidate(),
    ]);

    expect(bundle.distinctBugs).toHaveLength(1);
    expect(bundle.distinctBugs[0].title).toBe(note);
    // The representative evidence stays verbatim — only the top-level title is humanized.
    expect(bundle.distinctBugs[0].representative.title).toBe(
      "Uncaught error: message unavailable",
    );
  });

  it("leaves a degraded title unchanged when the flag note is outside the bug window", () => {
    const bundle = buildBundle(
      sessionEvents({ t: BASE + 60_000, note: "Way later, unrelated flag" }),
      [degradedCandidate()],
    );

    expect(bundle.distinctBugs).toHaveLength(1);
    expect(bundle.distinctBugs[0].title).toBe(
      "Uncaught error: message unavailable",
    );
  });

  it("never overrides a healthy title with a flag note", () => {
    const bundle = buildBundle(
      sessionEvents({ t: BASE + 1005, note: "My own words about the bug" }),
      [
        candidate({
          id: "cand_0002",
          detector: "http_error",
          title: "HTTP 500 from POST /api/pay",
          anchor: { t: BASE + 1000, offsetMs: 1000, message: "HTTP 500" },
        }),
      ],
    );

    expect(bundle.distinctBugs).toHaveLength(1);
    expect(bundle.distinctBugs[0].title).toBe("HTTP 500 from POST /api/pay");
  });

  it("truncates long flag notes with the shared text helper", () => {
    const note =
      "The checkout page completely falls over whenever I press the pay button " +
      "and then the whole cart empties itself and I have to start over again";
    expect(note.length).toBeGreaterThan(100);

    const bundle = buildBundle(sessionEvents({ t: BASE + 1005, note }), [
      degradedCandidate(),
    ]);

    const title = bundle.distinctBugs[0].title;
    expect(title).toHaveLength(100);
    expect(title).toBe(`${note.slice(0, 99)}…`);
  });
});

describe("llm bundle run compaction and detect-to-bundle latency", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-llm-compact-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const START = 1_700_000_600_000;

  const startEvents: BugEvent[] = [
    { t: START, k: "session.lifecycle", offsetMs: 0, d: { action: "start" } },
  ];

  function baseIndex(overrides: Partial<SessionIndexLike>): SessionIndexLike {
    return {
      id: "ses_compact",
      start: START,
      end: START + 10_000,
      dur: 10_000,
      evts: 1,
      stats: { "session.lifecycle": 1 },
      ...overrides,
    };
  }

  it("collapses same-signature failed requests into one verbatim exemplar with count/firstAt/lastAt", () => {
    const url = (id: number) =>
      `https://api.example.test/orders/${id}/pay?token=[REDACTED]`;
    const run = [
      { t: START + 100, m: "POST", url: url(101), st: 500 },
      { t: START + 200, m: "POST", url: url(202), st: 500 },
      { t: START + 300, m: "POST", url: url(303), st: 500 },
    ];
    const index = baseIndex({
      failedReqs: [
        run[0],
        run[1],
        {
          t: START + 250,
          m: "GET",
          url: "https://api.example.test/profile",
          st: 404,
        },
        run[2],
      ],
    });

    const bundle = writeLlmBundle({
      sessionDir: tmpDir,
      events: startEvents,
      index,
    });
    const summaries = bundle.browserEvidence.failedRequests;

    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      t: START + 100,
      offsetMs: 100,
      method: "POST",
      status: 500,
      count: 3,
      firstAt: START + 100,
      lastAt: START + 300,
    });

    // The exemplar is a verbatim copy of the earliest entry's already-redacted summary:
    // strip the three annotations and it must equal a solo build of that same entry.
    const solo = writeLlmBundle({
      sessionDir: fs.mkdtempSync(path.join(tmpDir, "solo-")),
      events: startEvents,
      index: baseIndex({ failedReqs: [run[0]] }),
    }).browserEvidence.failedRequests[0];
    const { count, firstAt, lastAt, ...exemplarRest } = summaries[0];
    expect(exemplarRest).toEqual(solo);

    // Distinct signature stays distinct and keeps today's exact singleton shape.
    expect(summaries[1]).toMatchObject({ method: "GET", status: 404 });
    expect(summaries[1]).not.toHaveProperty("count");
    expect(summaries[1]).not.toHaveProperty("firstAt");
    expect(summaries[1]).not.toHaveProperty("lastAt");
  });

  it("compacts network-error runs and keeps distinct signatures separate and stably ordered", () => {
    const offline = {
      method: "GET",
      url: "https://api.example.test/offline",
      msg: "Failed to fetch",
      transport: "fetch",
    };
    const index = baseIndex({
      networkErrors: [
        { t: START + 100, offsetMs: 100, ...offline },
        {
          t: START + 400,
          offsetMs: 400,
          method: "POST",
          url: "https://api.example.test/sync",
          msg: "Timeout after 3000 ms",
          transport: "xhr",
        },
        { t: START + 700, offsetMs: 700, ...offline },
      ],
    });

    const bundle = writeLlmBundle({
      sessionDir: tmpDir,
      events: startEvents,
      index,
    });
    const entries = bundle.browserEvidence.networkErrors;

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      t: START + 100,
      transport: "fetch",
      message: "Failed to fetch",
      count: 2,
      firstAt: START + 100,
      lastAt: START + 700,
    });
    expect(entries[1]).toMatchObject({
      transport: "xhr",
      message: "Timeout after 3000 ms",
    });
    expect(entries[1]).not.toHaveProperty("count");
  });

  it("compacts console-error runs whose messages differ only by digits, keying on level+message+source", () => {
    const index = baseIndex({
      consoleErrors: [
        {
          t: START + 100,
          offsetMs: 100,
          lv: "err",
          msg: "Cart sync failed for order 12",
          source: "app",
        },
        {
          t: START + 300,
          offsetMs: 300,
          lv: "err",
          msg: "Cart sync failed for order 98",
          source: "app",
        },
        {
          t: START + 500,
          offsetMs: 500,
          lv: "err",
          msg: "Cart sync failed for order 98",
          source: "vendor",
        },
      ],
    });

    const bundle = writeLlmBundle({
      sessionDir: tmpDir,
      events: startEvents,
      index,
    });
    const entries = bundle.browserEvidence.consoleErrors;

    expect(entries).toHaveLength(2);
    // Exemplar keeps the earliest message verbatim; digits only collapse in the signature.
    expect(entries[0]).toMatchObject({
      t: START + 100,
      message: "Cart sync failed for order 12",
      source: "app",
      count: 2,
      firstAt: START + 100,
      lastAt: START + 300,
    });
    // Same message but different source is a different signature.
    expect(entries[1]).toMatchObject({ source: "vendor" });
    expect(entries[1]).not.toHaveProperty("count");
  });

  it("applies the cap of 40 to exemplars, not raw duplicates", () => {
    const failedReqs = Array.from({ length: 50 }, (_, i) => ({
      t: START + 100 + i,
      m: i % 2 === 0 ? "GET" : "POST",
      url:
        i % 2 === 0
          ? "https://api.example.test/a"
          : "https://api.example.test/b",
      st: i % 2 === 0 ? 500 : 502,
    }));
    const index = baseIndex({ failedReqs });

    const bundle = writeLlmBundle({
      sessionDir: tmpDir,
      events: startEvents,
      index,
    });
    const summaries = bundle.browserEvidence.failedRequests;

    // 50 raw entries compact to 2 exemplars — a measurable item-count drop, not 40 capped rows.
    expect(summaries).toHaveLength(2);
    expect(summaries[0]).toMatchObject({
      method: "GET",
      status: 500,
      count: 25,
      firstAt: START + 100,
      lastAt: START + 148,
    });
    expect(summaries[1]).toMatchObject({
      method: "POST",
      status: 502,
      count: 25,
      firstAt: START + 101,
      lastAt: START + 149,
    });
  });

  it("stamps firstErrorEventAt and detectToBundleMs beside generatedAt when error-class evidence exists", () => {
    const index = baseIndex({
      errs: [{ t: START + 50, msg: "boom" }],
      failedReqs: [
        {
          t: START + 200,
          m: "GET",
          url: "https://api.example.test/a",
          st: 500,
        },
      ],
    });

    const bundle = writeLlmBundle({
      sessionDir: tmpDir,
      events: startEvents,
      index,
    });

    // Runtime error (index.errs) is earlier than the failed request, so it wins.
    expect(bundle.firstErrorEventAt).toBe(START + 50);
    expect(bundle.detectToBundleMs).toBe(bundle.generatedAt - (START + 50));
    expect(bundle.detectToBundleMs).toBeGreaterThanOrEqual(0);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    expect(persisted.firstErrorEventAt).toBe(START + 50);
    expect(persisted.detectToBundleMs).toBe(bundle.detectToBundleMs);

    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    expect(markdown).toContain(
      `- Detect→bundle latency: ${bundle.detectToBundleMs} ms`,
    );
  });

  it("clamps detectToBundleMs to zero (never negative or NaN) when the clock reads earlier than the first error", () => {
    vi.spyOn(Date, "now").mockReturnValue(START - 10_000);
    const index = baseIndex({ errs: [{ t: START + 50, msg: "boom" }] });

    const bundle = writeLlmBundle({
      sessionDir: tmpDir,
      events: startEvents,
      index,
    });

    expect(bundle.firstErrorEventAt).toBe(START + 50);
    expect(bundle.detectToBundleMs).toBe(0);
    expect(Number.isNaN(bundle.detectToBundleMs)).toBe(false);
  });

  it("omits both latency keys entirely when the session has no error-class events", () => {
    const bundle = writeLlmBundle({
      sessionDir: tmpDir,
      events: startEvents,
      index: baseIndex({}),
    });

    expect(bundle).not.toHaveProperty("firstErrorEventAt");
    expect(bundle).not.toHaveProperty("detectToBundleMs");

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    expect("firstErrorEventAt" in persisted).toBe(false);
    expect("detectToBundleMs" in persisted).toBe(false);

    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    expect(markdown).not.toContain("Detect→bundle");
  });
});
