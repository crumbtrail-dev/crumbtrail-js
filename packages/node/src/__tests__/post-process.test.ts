import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { BROWSER_REDACTION_POLICY } from "../llm-bundle";
import { postProcess } from "../post-process";
import { writeColdEvidenceArtifacts } from "../storage-plane";
import {
  convertOtlpTraceToEvents,
  CRUMBTRAIL_SESSION_ATTRIBUTE,
} from "../otel-adapter";

async function withPath<T>(nextPath: string, fn: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH;
  process.env.PATH = nextPath;
  try {
    return await fn();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

async function withFakeAudioTools<T>(
  tmpDir: string,
  transcriptJson: string,
  fn: () => Promise<T>,
): Promise<T> {
  const binDir = path.join(tmpDir, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(
    path.join(binDir, "ffmpeg"),
    `#!/bin/sh
last=""
for arg in "$@"; do last="$arg"; done
printf 'fake wav' > "$last"
`,
  );
  writeExecutable(
    path.join(binDir, "whisper-cpp"),
    `#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-of" ]; then out="$arg"; fi
  prev="$arg"
done
if [ -z "$out" ]; then exit 2; fi
printf %s ${shellSingleQuote(transcriptJson)} > "$out.json"
`,
  );
  return withPath(binDir, fn);
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function readNdjson(filePath: string): Array<Record<string, any>> {
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function readNdjsonFromText(text: string): Array<Record<string, any>> {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

describe("postProcess", async () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-pp-"));
  });
  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("generates index.json from events", async () => {
    const events = [
      { t: 1000, k: "nav", d: { from: "", to: "/home", tr: "init" } },
      { t: 1100, k: "con", d: { lv: "log", args: ['"hello"'] } },
      { t: 1200, k: "err", d: { msg: "TypeError: x is undefined" } },
      { t: 1300, k: "con", d: { lv: "log", args: ['"world"'] } },
      { t: 1400, k: "nav", d: { from: "/home", to: "/about", tr: "push" } },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    expect(index.start).toBe(1000);
    expect(index.end).toBe(1400);
    expect(index.dur).toBe(400);
    expect(index.evts).toBe(5);
    expect(index.errs).toHaveLength(1);
    expect(index.errs[0].msg).toBe("TypeError: x is undefined");
    expect(index.errs[0].t).toBe(1200);
    expect(index.navs).toHaveLength(2);
    expect(index.navs[0].to).toBe("/home");
    expect(index.navs[1].to).toBe("/about");
    expect(index.stats.con).toBe(2);
    expect(index.stats.nav).toBe(2);
    expect(index.stats.err).toBe(1);
  });

  it("generates agent llm bundle artifacts during post-processing", async () => {
    const events = [
      {
        t: 1000,
        k: "session.lifecycle",
        offsetMs: 0,
        d: {
          action: "start",
          reason: "user",
          rootUrl: "https://app.example.test/cart?token=secret",
        },
      },
      {
        t: 1100,
        k: "media.video",
        offsetMs: 100,
        d: { capability: "video", state: "recording", bytesRecorded: 128 },
      },
      {
        t: 1200,
        k: "media.voice",
        offsetMs: 200,
        d: {
          capability: "audio",
          state: "marker-added",
          markerId: "voice-marker-1",
          label: "checkout hesitation",
        },
      },
      {
        t: 1300,
        k: "session.lifecycle",
        offsetMs: 300,
        d: { action: "stop", reason: "user" },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "meta.json"),
      JSON.stringify({
        id: "ses_bundle",
        source: "crumbtrail-extension",
        name: "Bundle UAT",
        capabilities: { events: true, video: true, audio: true },
        collection: {
          video: { enabled: true, degraded: false },
          audio: { enabled: true, degraded: false },
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    fs.writeFileSync(path.join(tmpDir, "recording.webm"), Buffer.from("video"));
    fs.writeFileSync(path.join(tmpDir, "audio.webm"), Buffer.from("audio"));
    fs.writeFileSync(
      path.join(tmpDir, "audio.json"),
      JSON.stringify({ transcriptionRequested: false, durationMs: 300 }),
    );

    await postProcess(tmpDir);

    const bundle = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");

    expect(bundle.kind).toBe("crumbtrail.agent-session-bundle");
    expect(bundle.session).toMatchObject({
      id: "ses_bundle",
      name: "Bundle UAT",
      durationMs: 300,
    });
    expect(bundle.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "events.ndjson", exists: true }),
        expect.objectContaining({
          path: "recording.webm",
          exists: true,
          bytes: 5,
        }),
        expect.objectContaining({ path: "audio.webm", exists: true, bytes: 5 }),
      ]),
    );
    expect(bundle.eventCounts).toMatchObject({
      "session.lifecycle": 2,
      "media.video": 1,
      "media.voice": 1,
    });
    expect(bundle.media.audio.transcription).toMatchObject({
      state: "not-requested",
    });
    expect(bundle.media.voiceMarkers).toEqual([
      expect.objectContaining({ markerId: "voice-marker-1", offsetMs: 200 }),
    ]);
    expect(markdown).toContain("## Media Alignment Rules");
    expect(markdown).toContain("## How to Inspect Raw Files");
    expect(JSON.stringify(bundle) + markdown).not.toContain("token=secret");
  });

  it("writes the V2 hot/cold plane artifacts with signature dedup, zstd fallback metadata, and cold redaction", async () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    const secretSig = "sig_sk_fake_abcdefghijklmnopqrstuvwxyz0123456789";
    const plainSecret = "plain-prod-secret-value";
    const events: Array<{
      t: number;
      k: string;
      offsetMs?: number;
      d: Record<string, unknown>;
    }> = Array.from({ length: 220 }, (_, index) => ({
      t: 10_000 + index,
      k: index % 2 === 0 ? "clk" : "inp",
      offsetMs: index,
      d: {
        el: {
          sig: "sig-pay-button",
          path: 'button[data-testid="pay-now"]',
          tag: "BUTTON",
          txt: "Pay now",
          href: `https://app.example.test/pay?token=${secret}`,
        },
        url: `/api/pay?access_token=${secret}`,
        value: `Bearer ${secret}`,
      },
    }));
    events.push({
      t: 10_500,
      k: "clk",
      offsetMs: 500,
      d: {
        el: {
          sig: secretSig,
          path: `button[data-secret="${secret}"]`,
          tag: "BUTTON",
        },
      },
    });
    events.push({
      t: 10_750,
      k: "snap",
      offsetMs: 750,
      d: {
        headers: {
          "x-api-key": plainSecret,
          "x-auth-token": plainSecret,
          accessToken: plainSecret,
          "client-secret": plainSecret,
          "refresh-token": plainSecret,
        },
        localStorage: {
          [`auth_${secret}`]: "safe-looking-value",
          theme: "dark",
        },
        attributes: {
          [secretSig]: "present only as a key",
        },
      },
    });
    events.push({
      t: 11_000,
      k: "err",
      d: { msg: `checkout failed with Bearer ${secret}` },
    });
    events.push({
      t: 11_500,
      k: "net.req",
      d: {
        requestId: `glpat-${"a".repeat(20)}`,
        traceId: `glpat-${"b".repeat(20)}`,
        spanId: `xoxb-${"c".repeat(20)}`,
        sessionId: `sk-${"d".repeat(20)}`,
        attributes: { sessionId: "customer-session-abc123" },
      },
    });
    fs.writeFileSync(
      path.join(tmpDir, "meta.json"),
      JSON.stringify({
        id: "ses_v2_planes",
        tenant: "acme",
        app: "checkout",
        start: 10_000,
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await postProcess(tmpDir);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "manifest.json"), "utf-8"),
    );
    const bundle = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "bundle.json"), "utf-8"),
    );
    const legacyBundle = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    const signatures = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "signatures.json"), "utf-8"),
    );
    const coldBuffer = fs.readFileSync(path.join(tmpDir, "events.ndjson.zst"));
    const coldText = zstdDecompressSync(coldBuffer).toString("utf-8");
    const coldEvents = readNdjsonFromText(coldText);
    const coldSurfaces = {
      coldText,
      signatures: JSON.stringify(signatures),
      manifest: JSON.stringify(manifest),
      bundle: JSON.stringify(bundle),
    };
    const serializedColdSurfaces = Object.values(coldSurfaces).join("\n");

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      kind: "crumbtrail.session-manifest",
      session: {
        id: "ses_v2_planes",
        tenant: "acme",
        app: "checkout",
        eventCount: events.length,
      },
      partition: {
        convention: "{tenant}/{app}/{YYYY-MM-DD}/{sessionId}",
        tenant: "acme",
        app: "checkout",
        date: "1970-01-01",
        sessionId: "ses_v2_planes",
        appliedToPath: false,
      },
      cold: {
        transcode: {
          format: "ndjson+zstd",
          status: "parquet-deferred",
          redaction: "sanitized-before-cold-write",
        },
        signatures: { path: "signatures.json", count: 2 },
      },
    });
    expect(manifest.cold.compression.ratio).toBeGreaterThanOrEqual(10);
    expect(manifest.hot.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "manifest.json", exists: true }),
        expect.objectContaining({ path: "bundle.json", exists: true }),
      ]),
    );
    expect(
      manifest.hot.artifacts.find(
        (artifact: any) => artifact.path === "manifest.json",
      ),
    ).not.toHaveProperty("bytes");
    expect(manifest.cold.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "events.ndjson.zst",
          exists: true,
          bytes: coldBuffer.byteLength,
        }),
        expect.objectContaining({ path: "signatures.json", exists: true }),
      ]),
    );
    expect(bundle).toMatchObject({ kind: "crumbtrail.agent-session-bundle" });
    expect(bundle).toEqual(legacyBundle);
    expect(bundle.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "events.ndjson.zst",
          exists: true,
          bytes: coldBuffer.byteLength,
        }),
        expect.objectContaining({ path: "signatures.json", exists: true }),
      ]),
    );
    expect(signatures.entries).toEqual([
      expect.objectContaining({
        id: 1,
        sig: "sig-pay-button",
        path: 'button[data-testid="pay-now"]',
        tag: "BUTTON",
        firstSeen: 10_000,
        firstEventKind: "clk",
      }),
      expect.objectContaining({
        id: 2,
        sig: "[REDACTED]",
        path: 'button[data-secret="[REDACTED]"]',
        tag: "BUTTON",
        firstSeen: 10_500,
        firstEventKind: "clk",
      }),
    ]);
    expect(coldEvents[0].d.el).toEqual({ sigRef: 1 });
    expect(coldEvents.find((event) => event.t === 10_500)?.d.el).toEqual({
      sigRef: 2,
    });
    expect(serializedColdSurfaces).toContain("[REDACTED]");
    for (const [surface, content] of Object.entries(coldSurfaces)) {
      expect(content, surface).not.toContain(secret);
      expect(content, surface).not.toContain(secretSig);
      expect(content, surface).not.toContain(plainSecret);
      expect(content, surface).not.toContain("glpat-");
      expect(content, surface).not.toContain("xoxb-");
      expect(content, surface).not.toContain("customer-session-abc123");
      expect(content, surface).not.toContain("Bearer sk_");
      expect(content, surface).not.toContain("access_token=sk_");
    }
  });

  it("surfaces capture truncation in index and manifest during finalize", async () => {
    const marker = {
      truncated: true,
      reason: "session_event_bytes_cap",
      maxEventBytes: 64,
      eventsAccepted: 1,
      eventsDropped: 2,
      bytesWritten: 42,
      truncatedAt: 12_345,
    };
    fs.writeFileSync(
      path.join(tmpDir, "capture-truncated.json"),
      `${JSON.stringify(marker)}\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      '{"t":1000,"k":"con","d":{"lv":"log"}}\n',
    );

    await postProcess(tmpDir);

    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "manifest.json"), "utf-8"),
    );

    expect(index.truncated).toEqual(marker);
    expect(manifest.session.truncated).toBe(true);
    expect(manifest.truncation).toEqual(marker);
  });

  it("locks the complete agent bundle contract across index, llm, media degradation, tab boundaries, and redaction", async () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJidWdsb2dnZXIifQ.signaturesecret123456";
    const events = [
      {
        t: 1_700_000_010_000,
        k: "session.lifecycle",
        offsetMs: 0,
        d: {
          action: "start",
          reason: "user",
          rootUrl: `https://app.example.test/start?token=${secret}#frag`,
        },
      },
      {
        t: 1_700_000_010_050,
        k: "probe.ready",
        offsetMs: 50,
        d: {
          source: "page-probe",
          features: { console: true, fetch: true, storage: true },
        },
      },
      {
        t: 1_700_000_010_075,
        k: "snap",
        offsetMs: 75,
        d: {
          source: "content-script",
          localStorage: { authToken: secret },
          sessionStorage: { checkout: jwt },
          cookies: { session: secret },
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              {
                path: "localStorage.authToken",
                reason: "sensitive_storage_value",
                action: "redacted",
              },
              {
                path: "cookies.session",
                reason: "cookie_value",
                action: "redacted",
              },
            ],
          },
        },
      },
      {
        t: 1_700_000_010_100,
        k: "nav",
        offsetMs: 100,
        d: {
          to: `https://app.example.test/checkout?access_token=${secret}#frag`,
        },
      },
      {
        t: 1_700_000_010_150,
        k: "con",
        offsetMs: 150,
        d: {
          source: "page-probe",
          lv: "err",
          args: ["checkout failed", `Bearer ${secret}`],
        },
      },
      {
        t: 1_700_000_010_175,
        k: "err",
        offsetMs: 175,
        d: { msg: `Unhandled checkout token ${jwt}` },
      },
      {
        t: 1_700_000_010_200,
        k: "net.req",
        offsetMs: 200,
        d: {
          id: "req-1",
          method: "POST",
          url: `https://api.example.test/pay?x-api-key=${secret}`,
          headers: { authorization: `Bearer ${secret}`, "x-api-key": secret },
          body: { password: secret },
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              {
                path: "url.query.x-api-key",
                reason: "url_query_value",
                action: "redacted",
              },
              {
                path: "headers.authorization",
                reason: "sensitive_header",
                action: "dropped",
              },
              {
                path: "body.password",
                reason: "input_value",
                action: "redacted",
              },
            ],
          },
        },
      },
      {
        t: 1_700_000_010_300,
        k: "net.res",
        offsetMs: 300,
        d: {
          id: "req-1",
          st: 200,
          dur: 100,
          body: {
            ok: false,
            status: "failed",
            code: "PAYMENT_FAILED",
            message: `payment failed for ${secret}`,
            phase: "checkout",
          },
          bodySummary: {
            kind: "json",
            action: "summarized",
            reason: "network_body",
          },
        },
      },
      {
        t: 1_700_000_010_350,
        k: "net.err",
        offsetMs: 350,
        d: {
          method: "GET",
          url: `https://api.example.test/offline?token=${secret}`,
          msg: `Failed to fetch ${secret}`,
          transport: "fetch",
        },
      },
      {
        t: 1_700_000_010_400,
        k: "media.video",
        offsetMs: 400,
        d: {
          capability: "video",
          state: "error",
          code: "tab_capture_failed",
          message: `capture failed ${secret}`,
          phase: "start",
          retryable: false,
        },
      },
      {
        t: 1_700_000_010_450,
        k: "media.voice",
        offsetMs: 450,
        d: {
          capability: "audio",
          state: "marker-added",
          markerId: "voice-marker-1",
          label: `voice marker ${secret}`,
        },
      },
      {
        t: 1_700_000_010_500,
        k: "tab.boundary",
        offsetMs: 500,
        d: {
          signal: "activated",
          decision: "prompt",
          reason: "outside_boundary",
          capture: false,
          nonCapture: true,
          tabId: 88,
          previousTabId: 77,
          previousCapturedOrigin: `https://app.example.test/root?token=${secret}`,
          root: { origin: `https://app.example.test/root?token=${secret}` },
          current: {
            origin: `https://app.example.test/current?token=${secret}`,
          },
          candidate: {
            origin: `https://outside.example.test/private?token=${secret}`,
            host: `outside.example.test/private?token=${secret}`,
          },
          prompt: {
            origin: `https://outside.example.test/private?token=${secret}`,
            outcome: "pending",
            requestedAt: 1_700_000_010_490,
          },
          rawPayload: { authorization: `Bearer ${secret}` },
        },
      },
      {
        t: 1_700_000_010_550,
        k: "inp",
        offsetMs: 550,
        d: {
          el: { tag: "INPUT", label: "Password" },
          value: secret,
          valSummary: {
            kind: "input",
            action: "redacted",
            reason: "input_value",
          },
        },
      },
      {
        t: 1_700_000_010_600,
        k: "session.lifecycle",
        offsetMs: 600,
        d: { action: "stop", reason: "user" },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "meta.json"),
      JSON.stringify({
        id: "ses_contract",
        source: "crumbtrail-extension",
        name: "Contract UAT",
        capabilities: {
          events: true,
          video: true,
          audio: true,
          pageProbe: true,
        },
        collection: {
          video: { enabled: true },
          audio: { enabled: true },
          network: { enabled: true, redaction: BROWSER_REDACTION_POLICY },
        },
        tabBoundary: {
          enabled: true,
          redaction: "origin-only",
          rootOrigin: "https://app.example.test",
        },
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "audio.webm"),
      Buffer.from("audio evidence"),
    );
    fs.writeFileSync(
      path.join(tmpDir, "audio.json"),
      JSON.stringify({
        transcriptionRequested: false,
        durationMs: 600,
        chunkCount: 1,
      }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n",
    );

    await postProcess(tmpDir);

    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    const bundle = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    const candidates = fs.readFileSync(
      path.join(tmpDir, "candidates.jsonl"),
      "utf-8",
    );
    const candidatesMd = fs.readFileSync(
      path.join(tmpDir, "CANDIDATES.md"),
      "utf-8",
    );
    const search = fs.readFileSync(path.join(tmpDir, "search.jsonl"), "utf-8");
    const timeline = fs.readFileSync(path.join(tmpDir, "timeline.md"), "utf-8");

    expect(index.evts).toBe(events.length);
    expect(index.stats).toMatchObject({
      "session.lifecycle": 2,
      "probe.ready": 1,
      snap: 1,
      nav: 1,
      con: 1,
      err: 1,
      "net.req": 1,
      "net.res": 1,
      "net.err": 1,
      "media.video": 1,
      "media.voice": 1,
      "tab.boundary": 1,
      inp: 1,
    });
    expect(bundle.eventCounts).toEqual(index.stats);
    expect(bundle.session).toMatchObject({
      id: "ses_contract",
      name: "Contract UAT",
      durationMs: 600,
    });
    expect(bundle.keyTimelineMoments.at(0)).toMatchObject({
      k: "session.lifecycle",
      offsetMs: 0,
    });
    expect(bundle.keyTimelineMoments.at(-1)).toMatchObject({
      k: "session.lifecycle",
      offsetMs: 600,
    });
    expect(bundle.browserEvidence.failedRequests).toEqual([
      expect.objectContaining({
        status: 200,
        reason: "application_failure",
        code: "PAYMENT_FAILED",
        offsetMs: 300,
      }),
      expect.objectContaining({
        status: 0,
        reason: "network_error",
        method: "GET",
        offsetMs: 350,
      }),
    ]);
    expect(bundle.browserEvidence.networkErrors).toEqual([
      expect.objectContaining({
        method: "GET",
        transport: "fetch",
        offsetMs: 350,
      }),
    ]);
    expect(bundle.browserEvidence.consoleErrors).toEqual([]);
    expect(bundle.limitations).toContain(
      "Page-probe events are page-world-untrusted and are included only as corroboration hints, not authoritative evidence.",
    );
    expect(index.tabBoundarySummary).toMatchObject({
      total: 1,
      nonCaptureCount: 1,
      decisionCounts: { prompt: 1 },
    });
    expect(bundle.browserEvidence.tabBoundaries).toMatchObject({
      total: 1,
      nonCaptureCount: 1,
      decisionCounts: { prompt: 1 },
    });
    expect(bundle.browserEvidence.tabBoundaries.decisions[0]).toMatchObject({
      decision: "prompt",
      reason: "outside_boundary",
      root: { origin: "https://app.example.test" },
      current: { origin: "https://app.example.test" },
      candidate: { origin: "https://outside.example.test" },
      prompt: { origin: "https://outside.example.test", outcome: "pending" },
      capture: false,
      nonCapture: true,
    });
    expect(bundle.media.video).toMatchObject({
      path: "recording.webm",
      exists: false,
      eventCount: 1,
      lastState: "error",
    });
    expect(bundle.media.audio).toMatchObject({
      path: "audio.webm",
      exists: true,
      eventCount: 1,
      lastState: "marker-added",
      transcription: { state: "not-requested" },
    });
    expect(bundle.media.voiceMarkers).toEqual([
      expect.objectContaining({ markerId: "voice-marker-1", offsetMs: 450 }),
    ]);
    expect(bundle.degradedCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: "video",
          state: "error",
          code: "tab_capture_failed",
        }),
        expect.objectContaining({
          capability: "video",
          state: "artifact-missing",
          artifact: "recording.webm",
        }),
      ]),
    );
    expect(bundle.limitations).toEqual(
      expect.arrayContaining([
        "recording.webm is missing, so active-tab video cannot be inspected for this session.",
        "1 tab-boundary decision(s) intentionally marked non-capture; outside-boundary pages were not silently recorded.",
        "video is artifact-missing.",
      ]),
    );
    expect(bundle.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "llm.md", exists: true }),
        expect.objectContaining({ path: "llm.json", exists: true }),
        expect.objectContaining({ path: "index.json", exists: true }),
        expect.objectContaining({ path: "events.ndjson", exists: true }),
        expect.objectContaining({ path: "recording.webm", exists: false }),
        expect.objectContaining({ path: "audio.webm", exists: true }),
      ]),
    );
    expect(markdown).toContain("Agent-first inspection bundle");
    expect(markdown).toContain("## Browser Evidence Summary");
    expect(markdown).toContain("## Media Alignment Rules");
    expect(markdown).toContain("### Tab Boundary Decisions");
    expect(markdown).toContain("PAYMENT_FAILED");
    expect(candidates).toContain("media_degradation");
    expect(candidates).toContain("tab_boundary_gap");

    const derivedSurfaces = [
      JSON.stringify(index),
      JSON.stringify(bundle),
      markdown,
      candidates,
      candidatesMd,
      search,
      timeline,
    ].join("\n");
    expect(derivedSurfaces).toContain("[REDACTED]");
    for (const needle of [
      secret,
      jwt,
      "authorization",
      "password",
      "Bearer sk_",
      "/private",
      "access_token=sk_",
    ]) {
      expect(derivedSurfaces).not.toContain(needle);
    }
  });

  it("builds a redaction-safe full-stack request index with linked requests and gaps", async () => {
    const secret = "supersecret-token-1234567890abcdef";
    const events = [
      {
        t: 1000,
        k: "net.req",
        d: {
          id: "c1",
          method: "POST",
          url: `/api/checkout?token=${secret}`,
          requestId: "req-linked",
          sessionId: "sess-1",
          hdrs: {
            authorization: `Bearer ${secret}`,
            cookie: `session=${secret}`,
          },
          body: `card=${secret}`,
        },
      },
      {
        t: 1010,
        k: "backend.req.start",
        d: {
          requestId: "req-linked",
          sessionId: "sess-1",
          method: "POST",
          url: `/api/checkout?api_key=${secret}`,
          pathname: "/api/checkout",
          route: "/api/checkout",
          correlation: {
            status: "linked",
            sessionIdSource: "header",
            requestIdSource: "header",
          },
        },
      },
      {
        t: 1050,
        k: "backend.req.error",
        d: {
          requestId: "req-linked",
          sessionId: "sess-1",
          method: "POST",
          statusCode: 502,
          durationMs: 40,
          error: {
            name: "UpstreamError",
            message: `Bearer ${secret}`,
            code: "UPSTREAM_FAILED",
            raw: secret,
          },
          correlation: {
            status: "linked",
            sessionIdSource: "header",
            requestIdSource: "header",
          },
        },
      },
      {
        t: 1060,
        k: "net.res",
        d: {
          id: "c1",
          requestId: "req-linked",
          sessionId: "sess-1",
          st: 502,
          dur: 60,
          body: "failed",
        },
      },
      {
        t: 1100,
        k: "net.req",
        d: {
          id: "c2",
          method: "GET",
          url: `/api/frontend-only?token=${secret}`,
          requestId: "req-front",
          sessionId: "sess-1",
        },
      },
      {
        t: 1110,
        k: "net.res",
        d: {
          id: "c2",
          requestId: "req-front",
          sessionId: "sess-1",
          st: 200,
          dur: 10,
        },
      },
      {
        t: 1200,
        k: "net.req",
        d: {
          id: "c3",
          method: "GET",
          url: `/api/client-missing?token=${secret}`,
          sessionId: "sess-1",
        },
      },
      {
        t: 1210,
        k: "net.res",
        d: { id: "c3", sessionId: "sess-1", st: 200, dur: 10 },
      },
      {
        t: 1300,
        k: "backend.req.start",
        d: {
          requestId: "backend_req_1",
          sessionId: "sess-1",
          method: "POST",
          pathname: "/api/generated",
          correlation: {
            status: "generated-request-id",
            sessionIdSource: "header",
            requestIdSource: "generated",
          },
        },
      },
      {
        t: 1400,
        k: "backend.req.end",
        d: {
          requestId: "req-missing-session",
          method: "GET",
          pathname: "/api/no-session",
          statusCode: 204,
          durationMs: 5,
          correlation: {
            status: "missing-session",
            sessionIdSource: "missing",
            requestIdSource: "header",
          },
        },
      },
      {
        t: 1500,
        k: "backend.req.start",
        d: {
          requestId: "backend_req_2",
          method: "GET",
          pathname: "/api/no-correlation",
          correlation: {
            status: "missing-session-and-request-id",
            sessionIdSource: "missing",
            requestIdSource: "generated",
          },
        },
      },
      {
        t: 1600,
        k: "backend.req.start",
        d: {
          method: "GET",
          pathname: `/api/missing-request/${secret}`,
          correlation: {
            status: "missing-request-id",
            sessionIdSource: "header",
            requestIdSource: "missing",
          },
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await postProcess(tmpDir);

    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    const bundle = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");

    expect(index.fullStackRequests).toMatchObject({
      schemaVersion: 1,
      summary: {
        frontendRequests: 3,
        backendRequests: 5,
        linked: 1,
        gaps: 6,
      },
    });
    expect(bundle.fullStackEvidence.summary).toMatchObject(
      index.fullStackRequests.summary,
    );

    const indexLinked = index.fullStackRequests.linked[0];
    const bundleLinked = bundle.fullStackEvidence.linked[0];
    expect(index.fullStackRequests.linked).toEqual([
      expect.objectContaining({
        requestId: "req-linked",
        sessionId: "sess-1",
        frontend: expect.objectContaining({
          ref: { t: 1000, k: "net.req" },
          requestId: "req-linked",
          sessionId: "sess-1",
          method: "POST",
          url: "/api/checkout?token=%5BREDACTED%5D",
          status: 502,
          durationMs: 60,
        }),
        backend: expect.objectContaining({
          requestId: "req-linked",
          sessionId: "sess-1",
          start: { t: 1010, k: "backend.req.start" },
          errorRef: { t: 1050, k: "backend.req.error" },
          method: "POST",
          url: "/api/checkout?api_key=%5BREDACTED%5D",
          pathname: "/api/checkout",
          route: "/api/checkout",
          statusCode: 502,
          durationMs: 40,
          correlation: {
            status: "linked",
            sessionIdSource: "header",
            requestIdSource: "header",
          },
        }),
      }),
    ]);
    expect(bundleLinked).toMatchObject({
      requestId: indexLinked.requestId,
      sessionId: indexLinked.sessionId,
      frontend: expect.objectContaining({
        requestId: indexLinked.frontend.requestId,
        sessionId: indexLinked.frontend.sessionId,
        method: indexLinked.frontend.method,
        url: indexLinked.frontend.url,
        status: indexLinked.frontend.status,
        durationMs: indexLinked.frontend.durationMs,
        ref: expect.objectContaining({
          t: indexLinked.frontend.ref.t,
          kind: indexLinked.frontend.ref.k,
        }),
      }),
      backend: expect.objectContaining({
        requestId: indexLinked.backend.requestId,
        sessionId: indexLinked.backend.sessionId,
        method: indexLinked.backend.method,
        pathname: indexLinked.backend.pathname,
        route: indexLinked.backend.route,
        statusCode: indexLinked.backend.statusCode,
        durationMs: indexLinked.backend.durationMs,
        correlation: indexLinked.backend.correlation,
        start: expect.objectContaining({
          t: indexLinked.backend.start.t,
          kind: indexLinked.backend.start.k,
        }),
        errorRef: expect.objectContaining({
          t: indexLinked.backend.errorRef.t,
          kind: indexLinked.backend.errorRef.k,
        }),
      }),
    });
    expect(markdown).toContain("## Full-Stack Request Evidence");
    expect(markdown).toContain("### Linked Request Moments");
    expect(markdown).toContain(
      "| Request ID | Session ID | Frontend | Backend | Status |",
    );
    expect(markdown).toContain("req-linked");
    expect(markdown).toContain("sess-1");
    expect(markdown).toContain(
      "POST; /api/checkout?token=%5BREDACTED%5D; 60 ms",
    );
    expect(markdown).toContain(
      "POST; /api/checkout?api_key=%5BREDACTED%5D; 40 ms; linked; UPSTREAM_FAILED",
    );
    expect(markdown).toContain("502 / 502");

    expect(index.fullStackRequests.gaps.map((gap: any) => gap.type)).toEqual([
      "frontend-only",
      "client-missing-request-id",
      "backend-generated-request-id",
      "backend-missing-session",
      "backend-missing-session-and-request-id",
      "backend-missing-request-id",
    ]);
    expect(bundle.fullStackEvidence.gaps.map((gap: any) => gap.type)).toEqual(
      index.fullStackRequests.gaps.map((gap: any) => gap.type),
    );
    expect(index.fullStackRequests.summary.gapTypes).toMatchObject({
      "frontend-only": 1,
      "client-missing-request-id": 1,
      "backend-generated-request-id": 1,
      "backend-missing-session": 1,
      "backend-missing-session-and-request-id": 1,
      "backend-missing-request-id": 1,
    });
    const frontendOnlyGap = index.fullStackRequests.gaps.find(
      (gap: any) => gap.type === "frontend-only",
    );
    const backendGeneratedGap = index.fullStackRequests.gaps.find(
      (gap: any) => gap.type === "backend-generated-request-id",
    );
    expect(frontendOnlyGap).toMatchObject({
      requestId: "req-front",
      sessionId: "sess-1",
      frontend: expect.objectContaining({
        method: "GET",
        url: "/api/frontend-only?token=%5BREDACTED%5D",
        status: 200,
      }),
    });
    expect(backendGeneratedGap).toMatchObject({
      requestId: "backend_req_1",
      sessionId: "sess-1",
      backend: expect.objectContaining({
        method: "POST",
        pathname: "/api/generated",
        correlation: expect.objectContaining({
          status: "generated-request-id",
        }),
      }),
    });
    expect(bundle.fullStackEvidence.gaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "frontend-only",
          requestId: "req-front",
          sessionId: "sess-1",
        }),
        expect.objectContaining({
          type: "backend-generated-request-id",
          requestId: "backend_req_1",
          sessionId: "sess-1",
        }),
      ]),
    );
    expect(markdown).toContain("### Partial-Linkage Gaps");
    expect(markdown).toContain("frontend-only");
    expect(markdown).toContain("req-front");
    expect(markdown).toContain(
      "GET; /api/frontend-only?token=%5BREDACTED%5D; 10 ms",
    );
    expect(markdown).toContain("backend-generated-request-id");
    expect(markdown).toContain("backend_req_1");
    expect(markdown).toContain("POST; /api/generated; generated-request-id");
    expect(markdown).toContain(
      "do not assume every frontend request has backend evidence",
    );

    const serialized =
      JSON.stringify(index) + JSON.stringify(bundle) + markdown;
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("authorization");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("cookie");
    expect(serialized).not.toContain("card=");
    expect(serialized).not.toContain("failed supersecret");
    expect(serialized).not.toContain('"raw":');
  });

  it("links a front-end request to an OTLP backend error span sharing the W3C trace id", async () => {
    // The browser SDK injects `traceparent: 00-<traceId>-<spanId>-01` and uses the trace id
    // as the unified request id. The user's backend OTel SDK adopts that trace id, exports a
    // span, and the OTLP adapter bridges span.traceId → requestId. No manual stamping.
    const traceId = "2edece33792fffb03bcfb6828a08127a";
    const spanId = "00f067aa0ba902b7";
    const sessionId = "ses_20260629_otlp";

    // Backend span as the user's OTel exporter would POST it to :9898/v1/traces.
    const otlpEvents = convertOtlpTraceToEvents({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "api" } },
              {
                key: CRUMBTRAIL_SESSION_ATTRIBUTE,
                value: { stringValue: sessionId },
              },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId,
                  spanId: "aaaaaaaaaaaaaaaa",
                  parentSpanId: spanId, // child of the browser-minted client span
                  name: "POST /api/checkout",
                  kind: 2,
                  startTimeUnixNano: "1000000000",
                  endTimeUnixNano: "1040000000",
                  status: { code: 2, message: "upstream failed" },
                  attributes: [
                    {
                      key: "http.response.status_code",
                      value: { intValue: 500 },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(otlpEvents[0].d.requestId).toBe(traceId); // adapter bridge in place

    const events = [
      {
        t: 1000,
        k: "net.req",
        d: {
          id: "c1",
          method: "POST",
          url: "/api/checkout",
          requestId: traceId,
          traceId,
          spanId,
          sessionId,
        },
      },
      {
        t: 1050,
        k: "net.res",
        d: {
          id: "c1",
          requestId: traceId,
          traceId,
          sessionId,
          st: 500,
          dur: 50,
        },
      },
      ...otlpEvents.map((e) => ({ ...e, t: 1010 })),
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await postProcess(tmpDir);

    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    const bundle = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );

    // The OTLP-only backend produces a linked full-stack moment without hand-wiring.
    expect(index.fullStackRequests.summary.linked).toBe(1);
    expect(index.fullStackRequests.linked[0]).toMatchObject({
      requestId: traceId,
      sessionId,
      frontend: { status: 500, requestId: traceId },
      backend: {
        requestId: traceId,
        statusCode: 500,
        correlation: { requestIdSource: "otlp-trace-id" },
      },
    });

    // The trace id survives into the LLM bundle (it must not be scrubbed as a hex token).
    const bundleLinked = bundle.fullStackEvidence.linked[0];
    expect(bundleLinked.requestId).toBe(traceId);
    expect(bundleLinked.frontend.requestId).toBe(traceId);
    expect(bundleLinked.backend.requestId).toBe(traceId);
    expect(JSON.stringify(bundle)).toContain(traceId);
  });

  it("correlates failed network responses with requests", async () => {
    const events = [
      {
        t: 1000,
        k: "net.req",
        d: { id: "r1", m: "POST", url: "/api/data", src: "f" },
      },
      { t: 1100, k: "net.res", d: { id: "r1", st: 500, dur: 100 } },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    expect(index.failedReqs).toHaveLength(1);
    expect(index.failedReqs[0].m).toBe("POST");
    expect(index.failedReqs[0].url).toBe("/api/data");
    expect(index.failedReqs[0].st).toBe(500);
  });

  it("counts SDK network failures (net.err) as failed requests", async () => {
    const events = [
      {
        t: 1000,
        k: "net.req",
        d: { id: 1, method: "POST", url: "/api/save" },
      },
      {
        t: 1100,
        k: "net.err",
        d: {
          id: 1,
          method: "POST",
          url: "/api/save",
          dur: 100,
          msg: "Failed to fetch",
          name: "TypeError",
          transport: "fetch",
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    const bundle = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );

    expect(index.failedReqs).toEqual([
      expect.objectContaining({
        t: 1100,
        m: "POST",
        url: "/api/save",
        st: 0,
        reason: "network_error",
        message: "Failed to fetch",
      }),
    ]);
    expect(index.networkErrors).toEqual([
      expect.objectContaining({
        t: 1100,
        method: "POST",
        url: "/api/save",
        msg: "Failed to fetch",
        transport: "fetch",
      }),
    ]);
    expect(bundle.browserEvidence.failedRequests).toEqual([
      expect.objectContaining({
        method: "POST",
        url: "/api/save",
        status: 0,
        reason: "network_error",
      }),
    ]);
  });

  it("does not count aborted requests (net.err AbortError) as failed requests", async () => {
    const events = [
      {
        t: 1000,
        k: "net.req",
        d: { id: 1, method: "GET", url: "/api/search" },
      },
      {
        t: 1050,
        k: "net.err",
        d: {
          id: 1,
          method: "GET",
          url: "/api/search",
          dur: 50,
          msg: "request aborted",
          name: "AbortError",
          transport: "fetch",
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );

    expect(index.failedReqs).toEqual([]);
    // Aborts stay observable as network errors, they just don't count as failures.
    expect(index.networkErrors).toEqual([
      expect.objectContaining({ t: 1050, msg: "request aborted" }),
    ]);
  });

  it("attaches the failing request to a fetch-failure rejection that follows it", async () => {
    const events = [
      {
        t: 1000,
        k: "net.req",
        d: { id: 1, method: "POST", url: "/api/save" },
      },
      {
        t: 1100,
        k: "net.err",
        d: {
          id: 1,
          method: "POST",
          url: "/api/save",
          dur: 100,
          msg: "Failed to fetch",
          name: "TypeError",
          transport: "fetch",
        },
      },
      {
        t: 1105,
        k: "rej",
        d: { msg: "TypeError: Failed to fetch", stk: "at doSave" },
      },
      { t: 1200, k: "rej", d: { msg: "Error: unrelated failure" } },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );

    expect(index.errs).toEqual([
      expect.objectContaining({
        t: 1105,
        msg: "TypeError: Failed to fetch",
        method: "POST",
        url: "/api/save",
      }),
      expect.objectContaining({ t: 1200, msg: "Error: unrelated failure" }),
    ]);
    expect(index.errs[1].url).toBeUndefined();
  });

  it("uses the network id stamped on a rejection to restore its request identity", async () => {
    // Production shape: a browser fetch failure surfaces as a page-probe net.err
    // (page-world-untrusted) plus the coincident rejection. The untrusted net.err
    // is corroboration, not a counted failed request, so it lands in
    // networkErrors and never in failedReqs. The page probe stamps the shared
    // network id/method/url onto the rejection, so the rejection restores its
    // request identity directly rather than through a failedReqs join.
    const events = [
      {
        t: 1000,
        k: "net.req",
        d: { source: "page-probe", id: 5, method: "POST", url: "/api/pay" },
      },
      {
        t: 1100,
        k: "net.err",
        d: {
          source: "page-probe",
          evidenceTrust: "page-world-untrusted",
          id: 5,
          method: "POST",
          url: "/api/pay",
          dur: 100,
          msg: "Failed to fetch",
          name: "TypeError",
          transport: "fetch",
        },
      },
      {
        t: 1105,
        k: "rej",
        d: {
          source: "page-probe",
          msg: "TypeError: Failed to fetch",
          stk: "at pay",
          requestId: 5,
          method: "POST",
          url: "/api/pay",
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );

    expect(index.errs[0]).toEqual(
      expect.objectContaining({
        t: 1105,
        msg: "TypeError: Failed to fetch",
        requestId: "5",
        method: "POST",
        url: "/api/pay",
      }),
    );
    // The page-world-untrusted net.err is not counted as a failed request, so
    // nothing carries the id into failedReqs — the join target is networkErrors.
    expect(
      index.failedReqs.some((r: { id?: number | string }) => r.id === 5),
    ).toBe(false);
    expect(index.networkErrors).toEqual([
      expect.objectContaining({
        id: 5,
        method: "POST",
        url: "/api/pay",
        msg: "Failed to fetch",
      }),
    ]);
  });

  it("stamps the request identity onto a rejection even without a timestamp-adjacent net.err", async () => {
    const events = [
      {
        t: 1000,
        k: "net.req",
        d: { source: "page-probe", id: 9, method: "GET", url: "/api/feed" },
      },
      {
        t: 1100,
        k: "net.err",
        d: {
          source: "page-probe",
          evidenceTrust: "page-world-untrusted",
          id: 9,
          method: "GET",
          url: "/api/feed",
          dur: 100,
          msg: "Failed to fetch",
          name: "TypeError",
          transport: "fetch",
        },
      },
      // Rejection surfaces far later than the failure, so the old timestamp
      // fallback could not have joined it; the stamped id/method/url still do.
      {
        t: 9000,
        k: "rej",
        d: {
          source: "page-probe",
          msg: "TypeError: Failed to fetch",
          requestId: 9,
          method: "GET",
          url: "/api/feed",
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );

    expect(index.errs[0]).toEqual(
      expect.objectContaining({
        t: 9000,
        requestId: "9",
        method: "GET",
        url: "/api/feed",
      }),
    );
    expect(
      index.failedReqs.some((r: { id?: number | string }) => r.id === 9),
    ).toBe(false);
    expect(index.networkErrors).toEqual([
      expect.objectContaining({ id: 9, method: "GET", url: "/api/feed" }),
    ]);
  });

  it("indexes 200 responses with application failure payloads as failed requests", async () => {
    const events = [
      { t: 1000, k: "clk", d: { el: { tag: "BUTTON", txt: "Sync now" } } },
      {
        t: 1100,
        k: "net.req",
        d: {
          id: "r1",
          method: "POST",
          url: "/sources/amazon",
          src: "page-probe",
        },
      },
      {
        t: 1200,
        k: "net.res",
        d: {
          id: "r1",
          st: 200,
          dur: 100,
          body: '0:{"a":"$@1"}\n1:{"ok":false,"status":"failed","message":"Billing subscription state was not found before metering usage.","retryable":true,"code":"BILLING_USAGE_SUBSCRIPTION_NOT_FOUND","phase":"sync_source"}\n',
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await postProcess(tmpDir);

    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    const bundle = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");

    expect(index.failedReqs).toEqual([
      expect.objectContaining({
        m: "POST",
        url: "/sources/amazon",
        st: 200,
        reason: "application_failure",
        code: "BILLING_USAGE_SUBSCRIPTION_NOT_FOUND",
        message:
          "Billing subscription state was not found before metering usage.",
        phase: "sync_source",
      }),
    ]);
    expect(bundle.browserEvidence.failedRequests).toEqual([
      expect.objectContaining({
        method: "POST",
        status: 200,
        reason: "application_failure",
        code: "BILLING_USAGE_SUBSCRIPTION_NOT_FOUND",
      }),
    ]);
    expect(markdown).toContain("Failed requests: 1");
    expect(markdown).toContain("BILLING_USAGE_SUBSCRIPTION_NOT_FOUND");
  });

  it("preserves mixed page evidence counts, highlights, storage summaries, and redaction safety", async () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    const events = [
      {
        t: 2000,
        k: "probe.ready",
        offsetMs: 0,
        d: {
          source: "page-probe",
          features: {
            console: true,
            fetch: true,
            xhr: true,
            history: true,
            performance: true,
            storage: true,
          },
        },
      },
      {
        t: 2010,
        k: "frame.ctx",
        offsetMs: 10,
        d: {
          source: "content-script",
          pageProbe: { requested: true, started: true, limited: false },
        },
      },
      {
        t: 2020,
        k: "con",
        offsetMs: 20,
        d: {
          source: "page-probe",
          lv: "err",
          args: ["checkout failed", "[REDACTED]"],
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              { path: "args.1", reason: "token_like", action: "redacted" },
            ],
          },
        },
      },
      {
        t: 2030,
        k: "err",
        offsetMs: 30,
        d: { source: "page-probe", msg: "TypeError: checkout crashed" },
      },
      {
        t: 2040,
        k: "rej",
        offsetMs: 40,
        d: { source: "page-probe", msg: "Unhandled rejection: payment failed" },
      },
      {
        t: 2050,
        k: "net.req",
        offsetMs: 50,
        d: {
          source: "page-probe",
          id: "fetch-1",
          m: "POST",
          url: "https://api.example.test/pay?token=[REDACTED]",
          transport: "fetch",
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              {
                path: "url.query.token",
                reason: "url_query_value",
                action: "redacted",
              },
              {
                path: "headers.authorization",
                reason: "sensitive_header",
                action: "dropped",
              },
            ],
          },
        },
      },
      {
        t: 2060,
        k: "net.res",
        offsetMs: 60,
        d: {
          source: "page-probe",
          id: "fetch-1",
          st: 502,
          dur: 10,
          bodySummary: {
            kind: "text",
            action: "summarized",
            reason: "network_body",
          },
        },
      },
      {
        t: 2070,
        k: "net.req",
        offsetMs: 70,
        d: {
          source: "page-probe",
          id: "xhr-1",
          m: "GET",
          url: "https://api.example.test/xhr?api_key=[REDACTED]",
          transport: "xhr",
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              {
                path: "url.query.api_key",
                reason: "url_query_value",
                action: "redacted",
              },
            ],
          },
        },
      },
      {
        t: 2080,
        k: "net.err",
        offsetMs: 80,
        d: {
          source: "page-probe",
          id: "xhr-1",
          method: "GET",
          url: "https://api.example.test/xhr?api_key=[REDACTED]",
          msg: "Failed to fetch",
          transport: "xhr",
        },
      },
      {
        t: 2090,
        k: "nav",
        offsetMs: 90,
        d: {
          source: "page-probe",
          from: "/cart",
          to: "https://app.example.test/checkout?session=[REDACTED]",
          tr: "push",
        },
      },
      {
        t: 2100,
        k: "clk",
        offsetMs: 100,
        d: {
          source: "content-script",
          el: {
            tag: "BUTTON",
            txt: "Pay now",
            selector: 'button[data-testid="pay"]',
          },
        },
      },
      {
        t: 2110,
        k: "inp",
        offsetMs: 110,
        d: {
          source: "content-script",
          el: { tag: "INPUT", label: "Card" },
          val: "[REDACTED]",
          valSummary: {
            kind: "input",
            action: "redacted",
            reason: "input_value",
          },
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              { path: "val", reason: "input_value", action: "redacted" },
            ],
          },
        },
      },
      {
        t: 2120,
        k: "perf",
        offsetMs: 120,
        d: {
          source: "page-probe",
          metric: "res",
          entryType: "resource",
          name: "https://cdn.example.test/app.js?token=[REDACTED]",
          duration: 34,
          transferSize: 1234,
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              {
                path: "name.query.token",
                reason: "url_query_value",
                action: "redacted",
              },
            ],
          },
        },
      },
      {
        t: 2130,
        k: "stor",
        offsetMs: 130,
        d: {
          source: "content-script",
          type: "local",
          key: "authToken",
          oldVal: "",
          newVal: "[REDACTED]",
          newValSummary: {
            kind: "storage",
            action: "redacted",
            reason: "sensitive_storage_value",
          },
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              {
                path: "newVal",
                reason: "sensitive_storage_value",
                action: "redacted",
              },
            ],
          },
        },
      },
      {
        t: 2140,
        k: "snap",
        offsetMs: 140,
        d: {
          source: "content-script",
          localStorage: { authToken: "[REDACTED]" },
          sessionStorage: { cart: "[REDACTED]" },
          cookies: { session: "[REDACTED]" },
          idb: [{ name: "checkout-db", version: 1 }],
          cacheApi: ["app-cache"],
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              {
                path: "cookies.session",
                reason: "cookie_value",
                action: "redacted",
              },
            ],
          },
        },
      },
      {
        t: 2150,
        k: "probe.error",
        offsetMs: 150,
        d: {
          source: "page-probe",
          phase: "storage-snapshot",
          message: "Cache API unavailable",
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "meta.json"),
      JSON.stringify({ id: "ses_mixed_page", source: "crumbtrail-extension" }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await postProcess(tmpDir);

    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    const bundle = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    const timeline = fs.readFileSync(path.join(tmpDir, "timeline.md"), "utf-8");
    const search = fs.readFileSync(path.join(tmpDir, "search.jsonl"), "utf-8");
    const serializedArtifacts = [
      JSON.stringify(index),
      JSON.stringify(bundle),
      markdown,
      timeline,
      search,
    ].join("\n");

    expect(index.stats).toMatchObject({
      "probe.ready": 1,
      "frame.ctx": 1,
      con: 1,
      err: 1,
      rej: 1,
      "net.req": 2,
      "net.res": 1,
      "net.err": 1,
      nav: 1,
      clk: 1,
      inp: 1,
      perf: 1,
      stor: 1,
      snap: 1,
      "probe.error": 1,
    });
    expect(index.errs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          t: 2030,
          msg: expect.stringContaining("checkout crashed"),
        }),
        expect.objectContaining({
          t: 2040,
          msg: expect.stringContaining("payment failed"),
        }),
      ]),
    );
    expect(index.failedReqs).toEqual([
      expect.objectContaining({
        t: 2060,
        m: "POST",
        st: 502,
        url: "https://api.example.test/pay?token=%5BREDACTED%5D",
      }),
    ]);
    expect(index.networkErrors).toEqual([
      expect.objectContaining({ t: 2080, method: "GET", transport: "xhr" }),
    ]);
    expect(index.consoleErrors).toEqual([
      expect.objectContaining({ t: 2020, source: "page-probe" }),
    ]);
    expect(index.pageProbe).toMatchObject({
      requested: true,
      readyEvents: 1,
      errorEvents: 1,
      frameContexts: 1,
      startedContexts: 1,
      features: {
        console: true,
        fetch: true,
        xhr: true,
        performance: true,
        storage: true,
      },
    });
    expect(index.storageSummary).toMatchObject({
      localStorageKeys: 1,
      sessionStorageKeys: 1,
      cookies: 1,
      idbDatabases: 1,
      cacheNames: 1,
    });
    expect(index.redaction).toMatchObject({
      policy: BROWSER_REDACTION_POLICY,
      eventsWithRedactionEvidence: 8,
      redactedFields: 8,
      payloadSummaries: 3,
    });
    expect(bundle.eventCounts).toMatchObject(index.stats);
    expect(bundle.browserEvidence).toMatchObject({
      pageProbe: expect.objectContaining({ errorEvents: 1 }),
      failedRequests: [expect.objectContaining({ status: 502 })],
      networkErrors: [expect.objectContaining({ transport: "xhr" })],
      consoleErrors: [],
    });
    expect(bundle.limitations).toContain(
      "Page-probe events are page-world-untrusted and are included only as corroboration hints, not authoritative evidence.",
    );
    expect(bundle.keyTimelineMoments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          k: "perf",
          summary: expect.stringContaining("performance res"),
        }),
        expect.objectContaining({
          k: "snap",
          summary: expect.stringContaining("storage/cookie snapshot"),
        }),
      ]),
    );
    expect(markdown).toContain("perf");
    expect(timeline).toContain("perf: performance res");
    expect(search).toContain("storage/cookie snapshot; values omitted");
    expect(serializedArtifacts).not.toContain(secret);
    expect(serializedArtifacts).not.toContain("Bearer");
    expect(serializedArtifacts).not.toContain("card=");
  });

  it("indexes page-probe, redaction, console error, and network failure diagnostics", async () => {
    const events = [
      {
        t: 1000,
        k: "frame.ctx",
        offsetMs: 0,
        d: {
          source: "content-script",
          pageProbe: {
            requested: true,
            started: false,
            limited: true,
            reason: "page_probe_capability_disabled",
          },
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              {
                path: "url.query.token",
                reason: "url_query_value",
                action: "redacted",
              },
            ],
          },
        },
      },
      {
        t: 1010,
        k: "probe.ready",
        offsetMs: 10,
        d: {
          source: "page-probe",
          features: { console: true, fetch: true, xhr: false, history: true },
        },
      },
      {
        t: 1020,
        k: "con",
        offsetMs: 20,
        d: {
          source: "page-probe",
          lv: "err",
          args: ["checkout failed", "[REDACTED]"],
        },
      },
      {
        t: 1030,
        k: "probe.error",
        offsetMs: 30,
        d: {
          source: "page-probe",
          phase: "fetch-response",
          message: "Body read failed",
          retryable: false,
        },
      },
      {
        t: 1040,
        k: "net.req",
        offsetMs: 40,
        d: {
          id: "r1",
          m: "GET",
          url: "/api/pay?token=[REDACTED]",
          redaction: {
            policy: BROWSER_REDACTION_POLICY,
            fields: [
              {
                path: "url.query.token",
                reason: "url_query_value",
                action: "redacted",
              },
            ],
          },
        },
      },
      {
        t: 1050,
        k: "net.res",
        offsetMs: 50,
        d: {
          id: "r1",
          st: 502,
          bodySummary: {
            kind: "text",
            action: "summarized",
            reason: "payload_too_large",
          },
        },
      },
      {
        t: 1060,
        k: "net.err",
        offsetMs: 60,
        d: {
          transport: "fetch",
          id: "r2",
          method: "POST",
          url: "/api/offline",
          msg: "Failed to fetch",
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await postProcess(tmpDir);

    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    const bundle = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");

    expect(index.consoleErrors).toEqual([
      expect.objectContaining({
        t: 1020,
        offsetMs: 20,
        lv: "err",
        msg: expect.stringContaining("checkout failed"),
      }),
    ]);
    expect(index.networkErrors).toEqual([
      expect.objectContaining({
        t: 1060,
        offsetMs: 60,
        method: "POST",
        url: "/api/offline",
        msg: "Failed to fetch",
      }),
    ]);
    expect(index.pageProbe).toMatchObject({
      requested: true,
      readyEvents: 1,
      errorEvents: 1,
      frameContexts: 1,
      limitedContexts: 1,
      features: { console: true, fetch: true, history: true, xhr: false },
    });
    expect(index.pageProbe.errors[0]).toMatchObject({
      phase: "fetch-response",
      message: "Body read failed",
    });
    expect(index.redaction).toMatchObject({
      policy: BROWSER_REDACTION_POLICY,
      eventsWithRedactionEvidence: 3,
      redactedFields: 2,
      payloadSummaries: 1,
    });
    expect(index.redaction.reasons).toMatchObject({
      payload_too_large: 1,
      url_query_value: 2,
    });
    expect(bundle.browserEvidence.pageProbe.errorEvents).toBe(1);
    expect(bundle.browserEvidence.consoleErrors).toHaveLength(0);
    expect(bundle.browserEvidence.failedRequests).toEqual([
      expect.objectContaining({ status: 502, method: "GET" }),
      expect.objectContaining({
        status: 0,
        reason: "network_error",
        method: "POST",
        url: "/api/offline",
      }),
    ]);
    expect(bundle.browserEvidence.networkErrors).toEqual([
      expect.objectContaining({ method: "POST", message: "Failed to fetch" }),
    ]);
    expect(bundle.degradedCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ capability: "page-probe", state: "error" }),
        expect.objectContaining({ capability: "page-probe", state: "limited" }),
      ]),
    );
    expect(markdown).toContain("## Browser Evidence Summary");
    expect(markdown).toContain("Network Errors");
  });

  it("handles unhandled rejection events", async () => {
    const events = [{ t: 1000, k: "rej", d: { msg: "Promise rejected" } }];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    expect(index.errs).toHaveLength(1);
    expect(index.errs[0].msg).toBe("Promise rejected");
  });

  it("carries the source location of an uncaught error into the index", async () => {
    const events = [
      {
        t: 1000,
        k: "err",
        d: {
          msg: "TypeError: x is undefined",
          file: "https://app.example.test/assets/app-4f2a.js",
          line: 812,
          col: 17,
          stk: "TypeError: x is undefined\n    at r (https://app.example.test/assets/app-4f2a.js:812:17)",
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    expect(index.errs[0]).toMatchObject({
      file: "https://app.example.test/assets/app-4f2a.js",
      line: 812,
      col: 17,
    });
    expect(index.errs[0].stk).toContain("app-4f2a.js:812:17");
  });

  it("carries the stack of an Error shaped rejection into the index", async () => {
    const events = [
      {
        t: 1000,
        k: "rej",
        d: {
          msg: "Failed to fetch",
          stk: "TypeError: Failed to fetch\n    at load (https://app.example.test/assets/api-9c1.js:44:9)",
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    expect(index.errs[0].stk).toContain("api-9c1.js:44:9");
  });

  it("handles empty events file", async () => {
    fs.writeFileSync(path.join(tmpDir, "events.ndjson"), "");
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    expect(index.evts).toBe(0);
    expect(index.errs).toEqual([]);
    expect(index.start).toBe(0);
  });

  it("handles missing events file", async () => {
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    expect(index.evts).toBe(0);
  });

  it("skips malformed JSON lines", async () => {
    const content =
      '{"t":1000,"k":"con","d":{}}\nnot json\n{"t":1001,"k":"err","d":{"msg":"x"}}\n';
    fs.writeFileSync(path.join(tmpDir, "events.ndjson"), content);
    await postProcess(tmpDir);
    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    expect(index.evts).toBe(2);
  });

  it("indexes tab boundary decisions in a compact redacted shape", async () => {
    const events = [
      {
        t: 1000,
        k: "tab.boundary",
        sessionId: "ses_boundary",
        offsetMs: 100,
        d: {
          signal: "activated",
          decision: "follow",
          reason: "allowed_origin",
          capture: true,
          nonCapture: false,
          tabId: 77,
          previousTabId: 42,
          previousCapturedOrigin:
            "https://app.example.test/cart?token=secret#frag",
          candidate: {
            valid: true,
            restricted: false,
            opaque: false,
            scheme: "https",
            origin: "https://checkout.example.test/pay?card=secret#frag",
            host: "checkout.example.test/private?token=secret",
          },
          prompt: {
            origin: "https://checkout.example.test/pay?card=secret",
            outcome: "approved",
            requestedAt: 950,
          },
        },
      },
      {
        t: 1200,
        k: "tab.boundary",
        sessionId: "ses_boundary",
        offsetMs: 300,
        d: {
          signal: "content-navigation",
          decision: "prompt",
          reason: "outside_boundary",
          capture: false,
          nonCapture: true,
          tabId: 88,
          previousTabId: 77,
          previousCapturedOrigin:
            "https://checkout.example.test/pay?card=secret#frag",
          candidate: {
            valid: true,
            restricted: false,
            opaque: false,
            url: "https://evil.example.test/private?token=secret#frag",
            host: "evil.example.test/private?token=secret",
          },
          prompt: {
            origin: "https://evil.example.test/private?token=secret",
            outcome: "pending",
            requestedAt: 1200,
          },
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await postProcess(tmpDir);

    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    expect(index.stats["tab.boundary"]).toBe(2);
    expect(index.tabBoundaries).toEqual([
      {
        t: 1000,
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
        prompt: {
          origin: "https://checkout.example.test",
          outcome: "approved",
          requestedAt: 950,
        },
      },
      {
        t: 1200,
        offsetMs: 300,
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
          origin: "https://evil.example.test",
        },
        prompt: {
          origin: "https://evil.example.test",
          outcome: "pending",
          requestedAt: 1200,
        },
      },
    ]);
    const serializedBoundaryIndex = JSON.stringify(index.tabBoundaries);
    expect(serializedBoundaryIndex).not.toContain("token=secret");
    expect(serializedBoundaryIndex).not.toContain("card=secret");
    expect(serializedBoundaryIndex).not.toContain("/pay");
    expect(serializedBoundaryIndex).not.toContain("/private");
  });

  describe("audio / whisper processing", async () => {
    it("skips whisper processing when no audio.webm exists (no error)", async () => {
      const events = [
        { t: 1000, k: "nav", d: { to: "/", from: "", tr: "init" } },
      ];
      fs.writeFileSync(
        path.join(tmpDir, "events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(tmpDir);
      const index = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
      );
      expect(index.evts).toBe(1);
      // No transcript.json should be created
      expect(fs.existsSync(path.join(tmpDir, "transcript.json"))).toBe(false);
    });

    it("postProcess accepts optional whisperModel parameter", async () => {
      const events = [
        { t: 1000, k: "con", d: { lv: "log", args: ['"test"'] } },
      ];
      fs.writeFileSync(
        path.join(tmpDir, "events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      // Should not throw with whisperModel parameter
      await expect(postProcess(tmpDir, "tiny")).resolves.not.toThrow();
      const index = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
      );
      expect(index.evts).toBe(1);
    });

    it("records transcript-ready audio metadata and tx events without dropping voice markers", async () => {
      const events = [
        { t: 1000, k: "nav", d: { to: "/", from: "", tr: "init" } },
        {
          t: 1200,
          k: "media.voice",
          d: {
            capability: "audio",
            state: "marker-added",
            markerId: "voice-marker-1",
            label: "checkout hesitation",
          },
          sessionId: "ses_voice",
          offsetMs: 200,
        },
      ];
      const audio = Buffer.from("fake webm audio");
      fs.writeFileSync(
        path.join(tmpDir, "events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      fs.writeFileSync(path.join(tmpDir, "audio.webm"), audio);
      fs.writeFileSync(
        path.join(tmpDir, "audio.json"),
        JSON.stringify({
          uploadedAt: 1700000000000,
          contentType: "audio/webm",
          mimeType: "audio/webm;codecs=opus",
          durationMs: 3500,
          chunkCount: 2,
          transcriptionRequested: true,
        }),
      );

      await withFakeAudioTools(
        tmpDir,
        JSON.stringify({
          transcription: [
            { offsets: { from: 0 }, text: " hello world " },
            { offsets: { from: 25 }, text: " second note " },
          ],
        }),
        async () => postProcess(tmpDir, "tiny"),
      );

      const index = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
      );
      const persistedEvents = readNdjson(path.join(tmpDir, "events.ndjson"));
      const marker = persistedEvents.find(
        (event) =>
          event.k === "media.voice" && event.d.state === "marker-added",
      );
      const txEvents = persistedEvents.filter((event) => event.k === "tx");

      expect(fs.existsSync(path.join(tmpDir, "audio.webm"))).toBe(true);
      expect(marker).toMatchObject({ sessionId: "ses_voice", offsetMs: 200 });
      expect(txEvents).toHaveLength(2);
      expect(txEvents[0]).toMatchObject({
        t: 1000,
        d: { text: "hello world" },
      });
      expect(txEvents[1]).toMatchObject({
        t: 1250,
        d: { text: "second note" },
      });
      expect(index.audio).toMatchObject({
        artifact: "audio.webm",
        bytes: audio.length,
        upload: {
          metadataFile: "audio.json",
          contentType: "audio/webm",
          mimeType: "audio/webm;codecs=opus",
          durationMs: 3500,
          chunkCount: 2,
          transcriptionRequested: true,
        },
        transcription: {
          state: "transcription-ready",
          transcriptFile: "transcript.json",
          eventCount: 2,
        },
      });
      expect(JSON.stringify(index.audio)).not.toContain("hello world");
      expect(index.stats.tx).toBe(2);
      expect(index.stats["media.voice"]).toBe(1);
    });

    it("records transcript-unavailable state without erasing audio or marker events", async () => {
      const events = [
        { t: 1000, k: "nav", d: { to: "/", from: "", tr: "init" } },
        {
          t: 1200,
          k: "media.voice",
          d: {
            capability: "audio",
            state: "marker-added",
            markerId: "voice-marker-1",
          },
          sessionId: "ses_voice",
          offsetMs: 200,
        },
      ];
      const emptyBin = path.join(tmpDir, "empty-bin");
      fs.mkdirSync(emptyBin);
      fs.writeFileSync(
        path.join(tmpDir, "events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      fs.writeFileSync(
        path.join(tmpDir, "audio.webm"),
        Buffer.from("audio stays on disk"),
      );
      fs.writeFileSync(
        path.join(tmpDir, "audio.json"),
        JSON.stringify({ transcriptionRequested: true }),
      );

      await withPath(emptyBin, async () => postProcess(tmpDir, "base"));

      const index = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
      );
      const persistedEvents = readNdjson(path.join(tmpDir, "events.ndjson"));

      expect(fs.existsSync(path.join(tmpDir, "audio.webm"))).toBe(true);
      expect(fs.existsSync(path.join(tmpDir, "transcript.json"))).toBe(false);
      expect(
        persistedEvents.some(
          (event) =>
            event.k === "media.voice" && event.d.state === "marker-added",
        ),
      ).toBe(true);
      expect(persistedEvents.some((event) => event.k === "tx")).toBe(false);
      expect(index.evts).toBe(2);
      expect(index.audio.transcription).toMatchObject({
        state: "transcription-unavailable",
        code: "transcription_unavailable",
      });
      expect(index.audio.transcription.message).toContain(
        "Audio was preserved",
      );

      const bundle = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
      );
      expect(bundle.degradedCapabilities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            capability: "audio-transcription",
            state: "transcription-unavailable",
          }),
        ]),
      );
      expect(bundle.limitations).toEqual(
        expect.arrayContaining([
          "Audio transcription state is transcription-unavailable; use audio.webm and media.voice markers for alignment.",
        ]),
      );
    });

    it("gracefully handles audio.webm when ffmpeg is not available", async () => {
      const events = [
        { t: 1000, k: "nav", d: { to: "/", from: "", tr: "init" } },
        { t: 1100, k: "con", d: { lv: "log", args: ['"hi"'] } },
      ];
      fs.writeFileSync(
        path.join(tmpDir, "events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      // Write a dummy audio.webm file
      fs.writeFileSync(
        path.join(tmpDir, "audio.webm"),
        Buffer.from("dummy audio data"),
      );
      // Should not throw even though ffmpeg is not available
      await expect(postProcess(tmpDir, "base")).resolves.not.toThrow();
      // index.json should still be valid
      const index = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
      );
      expect(index.evts).toBe(2);
      expect(index.start).toBe(1000);
      expect(index.end).toBe(1100);
    });
  });

  describe("storage snapshot summary", async () => {
    it("includes storageSummary in index when snap event is present", async () => {
      const events = [
        {
          t: 1000,
          k: "snap",
          d: {
            localStorage: { key1: "val1", key2: "val2" },
            sessionStorage: { sk: "sv" },
            cookies: { session: "abc", theme: "dark" },
          },
        },
        { t: 1100, k: "nav", d: { to: "/home", from: "", tr: "init" } },
      ];
      fs.writeFileSync(
        path.join(tmpDir, "events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(tmpDir);
      const index = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
      );
      expect(index.storageSummary).toBeDefined();
      expect(index.storageSummary.localStorageKeys).toBe(2);
      expect(index.storageSummary.sessionStorageKeys).toBe(1);
      expect(index.storageSummary.cookies).toBe(2);
    });

    it("omits storageSummary when no snap event exists", async () => {
      const events = [
        { t: 1000, k: "nav", d: { to: "/home", from: "", tr: "init" } },
        { t: 1100, k: "err", d: { msg: "some error" } },
      ];
      fs.writeFileSync(
        path.join(tmpDir, "events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(tmpDir);
      const index = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
      );
      expect(index.storageSummary).toBeUndefined();
    });

    it("uses only the first snap event when multiple snap events exist", async () => {
      const events = [
        {
          t: 1000,
          k: "snap",
          d: { localStorage: { a: "1" }, sessionStorage: {}, cookies: {} },
        },
        {
          t: 1100,
          k: "snap",
          d: {
            localStorage: { a: "1", b: "2", c: "3" },
            sessionStorage: {},
            cookies: {},
          },
        },
        { t: 1200, k: "nav", d: { to: "/", from: "", tr: "init" } },
      ];
      fs.writeFileSync(
        path.join(tmpDir, "events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(tmpDir);
      const index = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
      );
      expect(index.storageSummary.localStorageKeys).toBe(1);
    });

    it("includes idbDatabases and cacheNames counts when present in snap", async () => {
      const events = [
        {
          t: 1000,
          k: "snap",
          d: {
            localStorage: {},
            sessionStorage: {},
            cookies: {},
            idb: [
              { name: "mydb", version: 1 },
              { name: "otherdb", version: 2 },
            ],
            cacheApi: ["v1-cache", "v2-cache", "static"],
          },
        },
        { t: 1100, k: "nav", d: { to: "/", from: "", tr: "init" } },
      ];
      fs.writeFileSync(
        path.join(tmpDir, "events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(tmpDir);
      const index = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
      );
      expect(index.storageSummary.idbDatabases).toBe(2);
      expect(index.storageSummary.cacheNames).toBe(3);
    });

    it("omits idbDatabases and cacheNames when absent from snap", async () => {
      const events = [
        {
          t: 1000,
          k: "snap",
          d: { localStorage: { x: "1" }, sessionStorage: {}, cookies: {} },
        },
        { t: 1100, k: "nav", d: { to: "/", from: "", tr: "init" } },
      ];
      fs.writeFileSync(
        path.join(tmpDir, "events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(tmpDir);
      const index = JSON.parse(
        fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
      );
      expect(index.storageSummary.idbDatabases).toBeUndefined();
      expect(index.storageSummary.cacheNames).toBeUndefined();
    });
  });
});

describe("storage-plane generated artifacts", async () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-storage-plane-"),
    );
  });
  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("refuses to overwrite symlinked cold-storage artifacts", async () => {
    const outside = path.join(tmpDir, "outside.json");
    fs.writeFileSync(outside, "outside");
    fs.symlinkSync(outside, path.join(tmpDir, "signatures.json"));

    await expect(
      writeColdEvidenceArtifacts({
        sessionDir: tmpDir,
        events: [
          { t: 1000, k: "nav", d: { to: "https://example.test" } },
        ] as any,
      }),
    ).rejects.toThrow(/symlinked generated artifact/);
    expect(fs.readFileSync(outside, "utf-8")).toBe("outside");
  });

  it("redacts compact and dotted sensitive event fields before cold storage writes", async () => {
    await writeColdEvidenceArtifacts({
      sessionDir: tmpDir,
      events: [
        {
          t: 1000,
          k: "net.req",
          d: {
            "api.key": "abc123",
            "private.key": "hunter2",
            jsessionid: "sid123",
            nested: { apiKeys: "short-key" },
            ok: "visible",
          },
        },
      ] as any,
    });

    const cold = zstdDecompressSync(
      fs.readFileSync(path.join(tmpDir, "events.ndjson.zst")),
    ).toString("utf-8");
    expect(cold).toContain("visible");
    expect(cold).not.toContain("abc123");
    expect(cold).not.toContain("hunter2");
    expect(cold).not.toContain("sid123");
    expect(cold).not.toContain("short-key");
  });
});

describe("searchable evidence index artifacts", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-evidence-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes deterministic candidate artifacts for application failures, redacted transcript, and windows", async () => {
    const events = [
      { t: 1000, k: "nav", d: { to: "/dashboard?token=secret" } },
      { t: 1100, k: "clk", d: { el: { tag: "BUTTON", txt: "Sync now" } } },
      {
        t: 1200,
        k: "net.req",
        d: {
          id: "r1",
          method: "POST",
          url: "/sources/amazon?access_token=secret",
        },
      },
      {
        t: 1300,
        k: "net.res",
        d: {
          id: "r1",
          st: 200,
          dur: 100,
          body: '{"ok":false,"status":"failed","code":"BILLING_USAGE_SUBSCRIPTION_NOT_FOUND","message":"Billing usage token abcdefabcdefabcdefabcdefabcdefab failed"}',
        },
      },
      {
        t: 1400,
        k: "tx",
        d: { text: "sync failed with token abcdefabcdefabcdefabcdefabcdefab" },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await postProcess(tmpDir);

    const candidatesMd = fs.readFileSync(
      path.join(tmpDir, "CANDIDATES.md"),
      "utf-8",
    );
    const candidates = readNdjson(path.join(tmpDir, "candidates.jsonl"));
    const manifest = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "manifest.json"), "utf-8"),
    );
    const search = fs.readFileSync(path.join(tmpDir, "search.jsonl"), "utf-8");
    const windowMd = fs.readFileSync(
      path.join(tmpDir, "windows", "cand_0001.md"),
      "utf-8",
    );
    const timeline = fs.readFileSync(path.join(tmpDir, "timeline.md"), "utf-8");

    expect(candidates[0]).toMatchObject({
      schemaVersion: 1,
      id: "cand_0001",
      detector: "app_2xx_failure",
      score: 95,
    });
    expect(candidatesMd).toContain("BILLING_USAGE_SUBSCRIPTION_NOT_FOUND");
    expect(candidatesMd).toContain("windows/cand_0001.md");
    expect(candidatesMd).toContain('basis: "heuristic"');
    expect(candidatesMd).toContain("baseScore: 95");
    expect(manifest.candidates[0]).toMatchObject({
      basis: "heuristic",
      baseScore: 95,
      score: 95,
    });
    expect(windowMd).toContain("Compact event timeline");
    expect(timeline).toContain("Five-minute deterministic buckets");
    expect(search).toContain("candidateId");
    expect(candidatesMd + search + windowMd).not.toContain("token=secret");
    expect(candidatesMd + search + windowMd).not.toContain(
      "abcdefabcdefabcdefabcdefabcdefab",
    );
  });
});

describe("evidence detector coverage and determinism", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-detectors-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("covers deterministic detectors and stable output across repeated post-processing", async () => {
    const events = [
      { t: 0, k: "nav", d: { to: "/start" } },
      { t: 100, k: "clk", d: { el: { txt: "Retry" } } },
      { t: 200, k: "clk", d: { el: { txt: "Retry" } } },
      { t: 300, k: "clk", d: { el: { txt: "Retry" } } },
      { t: 500, k: "net.req", d: { id: "slow", m: "GET", url: "/slow" } },
      { t: 6_000, k: "net.res", d: { id: "slow", st: 200, dur: 5_500 } },
      {
        t: 6_100,
        k: "net.req",
        d: { id: "pending", m: "POST", url: "/pending" },
      },
      {
        t: 6_200,
        k: "net.err",
        d: {
          id: "offline",
          method: "POST",
          url: "/offline",
          msg: "Failed to fetch",
        },
      },
      { t: 6_300, k: "con", d: { lv: "err", args: ["console blew up"] } },
      { t: 6_400, k: "err", d: { msg: "runtime exploded" } },
      { t: 6_500, k: "rej", d: { msg: "promise exploded" } },
      {
        t: 6_600,
        k: "probe.error",
        d: { phase: "init", message: "probe unavailable" },
      },
      {
        t: 6_700,
        k: "media.video",
        d: { capability: "video", state: "error", code: "tab_capture_failed" },
      },
      {
        t: 6_800,
        k: "tab.boundary",
        d: { decision: "prompt", reason: "outside_boundary", nonCapture: true },
      },
      {
        t: 6_900,
        k: "media.voice",
        d: { state: "marker-added", markerId: "m1", label: "look here" },
      },
      { t: 7_000, k: "tx", d: { text: "this is broken and not working" } },
      // Symptom-under-root cluster: a backend error (root) → 500 response → FE uncaught error
      // (symptom), sharing requestId req-cluster so the causal re-rank demotes the FE symptom below
      // the backend root while keeping output byte-deterministic.
      {
        t: 8_000,
        k: "net.req",
        d: {
          id: "clstr",
          requestId: "req-cluster",
          m: "POST",
          url: "/api/checkout",
        },
      },
      {
        t: 8_100,
        k: "backend.req.error",
        d: {
          requestId: "req-cluster",
          method: "POST",
          route: "/api/checkout",
          statusCode: 500,
          error: { name: "TypeError", message: "boom" },
        },
      },
      {
        t: 8_200,
        k: "net.res",
        d: { id: "clstr", requestId: "req-cluster", st: 500 },
      },
      { t: 8_300, k: "err", d: { msg: "Request failed with status 500" } },
      { t: 11_000, k: "clk", d: { el: { txt: "Save" } } },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await postProcess(tmpDir);
    const first = {
      candidates: fs.readFileSync(
        path.join(tmpDir, "candidates.jsonl"),
        "utf-8",
      ),
      markdown: fs.readFileSync(path.join(tmpDir, "CANDIDATES.md"), "utf-8"),
      search: fs.readFileSync(path.join(tmpDir, "search.jsonl"), "utf-8"),
      window: fs.readFileSync(
        path.join(tmpDir, "windows", "cand_0001.md"),
        "utf-8",
      ),
      index: fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    };
    await postProcess(tmpDir);
    const second = {
      candidates: fs.readFileSync(
        path.join(tmpDir, "candidates.jsonl"),
        "utf-8",
      ),
      markdown: fs.readFileSync(path.join(tmpDir, "CANDIDATES.md"), "utf-8"),
      search: fs.readFileSync(path.join(tmpDir, "search.jsonl"), "utf-8"),
      window: fs.readFileSync(
        path.join(tmpDir, "windows", "cand_0001.md"),
        "utf-8",
      ),
      index: fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    };

    const detectors = readNdjson(path.join(tmpDir, "candidates.jsonl")).map(
      (candidate) => candidate.detector,
    );
    expect(detectors).toEqual(
      expect.arrayContaining([
        "repeated_clicks",
        "ineffective_submit",
        "slow_request",
        "pending_request",
        "network_error",
        "console_error",
        "uncaught_error",
        "unhandled_rejection",
        "page_probe_failure",
        "media_degradation",
        "tab_boundary_gap",
        "user_marker",
        "transcript_complaint",
      ]),
    );
    const parsedIndex = JSON.parse(first.index);
    expect(parsedIndex.causalGraph.nodes.length).toBeGreaterThan(0);
    expect(second).toEqual(first);

    // Symptom-under-root cluster: the backend root outranks its FE symptom, and the symptom carries
    // a rootCauseId pointing back at the backend candidate.
    const parsedCandidates = readNdjson(path.join(tmpDir, "candidates.jsonl"));
    const backendRoot = parsedCandidates.find(
      (c) => c.detector === "backend_request_error",
    );
    expect(backendRoot).toBeDefined();
    expect(backendRoot!.causalRole).toBe("root");
    const feSymptom = parsedCandidates.find(
      (c) =>
        c.detector === "uncaught_error" && c.rootCauseId === backendRoot!.id,
    );
    expect(feSymptom).toBeDefined();
    expect(feSymptom!.causalRole).toBe("symptom");
    const rootIdx = parsedCandidates.findIndex((c) => c.id === backendRoot!.id);
    const symIdx = parsedCandidates.findIndex((c) => c.id === feSymptom!.id);
    expect(rootIdx).toBeLessThan(symIdx);
  });
});

describe("long-session bounding", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-long-session-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("keeps a 2h session timeline bucketed and searchable artifacts redacted", async () => {
    const events = [
      { t: 0, k: "nav", d: { to: "/start?token=secret" } },
      {
        t: 60 * 60 * 1000,
        k: "inp",
        d: { value: "raw-password-value", name: "password" },
      },
      {
        t: 2 * 60 * 60 * 1000,
        k: "media.voice",
        d: {
          state: "marker-added",
          markerId: "late-marker",
          label: "two hour point",
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await postProcess(tmpDir);

    const timeline = fs.readFileSync(path.join(tmpDir, "timeline.md"), "utf-8");
    const searchable = fs.readFileSync(
      path.join(tmpDir, "search.jsonl"),
      "utf-8",
    );
    const bucketCount = timeline
      .split("\n")
      .filter((line) => line.startsWith("## ")).length;

    expect(bucketCount).toBeGreaterThanOrEqual(24);
    expect(searchable + timeline).not.toContain("token=secret");
    expect(searchable + timeline).not.toContain("raw-password-value");
  });

  it("post-processes malformed, approved, paused, ignored, and hostile tab boundary events safely", async () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    const events = [
      { t: 2000, k: "tab.boundary", offsetMs: 0, d: null },
      {
        t: 2010,
        k: "tab.boundary",
        offsetMs: 10,
        d: {
          decision: "follow",
          reason: "same_origin",
          capture: true,
          nonCapture: false,
          root: { origin: "https://app.example.test/root?token=secret" },
          current: { origin: "https://app.example.test/current?token=secret" },
          candidate: { origin: "https://app.example.test/next?token=secret" },
          prompt: {
            outcome: "approved",
            origin: "https://app.example.test/next?token=secret",
          },
        },
      },
      {
        t: 2020,
        k: "tab.boundary",
        offsetMs: 20,
        d: {
          decision: "pause",
          reason: "user_denied_origin",
          capture: false,
          nonCapture: true,
          previousCapturedOrigin: "https://app.example.test/root?token=secret",
          root: { origin: "https://app.example.test/root?token=secret" },
          current: { origin: "https://app.example.test/current?token=secret" },
          candidate: {
            origin: "https://deny.example.test/pay?card=secret",
            host: "deny.example.test/pay?card=secret",
          },
          prompt: {
            outcome: "denied",
            origin: "https://deny.example.test/pay?card=secret",
            requestedAt: 2020,
          },
          rawDeniedUrl: `https://deny.example.test/pay?token=${secret}#frag`,
        },
      },
      {
        t: 2030,
        k: "tab.boundary",
        offsetMs: 30,
        d: {
          decision: "ignore",
          reason: "candidate_scheme_restricted",
          capture: false,
          nonCapture: true,
          candidate: {
            scheme: "chrome-extension",
            url: `chrome-extension://abc/private?token=${secret}`,
          },
          prompt: {
            outcome: "ignored",
            origin: `https://ignored.example.test/private?token=${secret}`,
          },
        },
      },
      {
        t: 2040,
        k: "tab.boundary",
        offsetMs: 40,
        d: {
          decision: "prompt<script>",
          reason: "bad reason with spaces",
          candidate: "not-an-object",
          prompt: {
            origin: `https://prompt.example.test/private?token=${secret}`,
            outcome: "pending",
          },
        },
      },
    ];
    fs.writeFileSync(
      path.join(tmpDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    await postProcess(tmpDir);

    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    const bundle = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "llm.json"), "utf-8"),
    );
    const markdown = fs.readFileSync(path.join(tmpDir, "llm.md"), "utf-8");
    const serialized =
      JSON.stringify(index.tabBoundaries) +
      JSON.stringify(bundle.browserEvidence.tabBoundaries) +
      markdown;

    expect(index.stats["tab.boundary"]).toBe(5);
    expect(index.tabBoundaries).toHaveLength(4);
    expect(index.tabBoundarySummary).toMatchObject({
      total: 4,
      nonCaptureCount: 2,
      decisionCounts: { follow: 1, ignore: 1, pause: 1, unknown: 1 },
    });
    expect(index.tabBoundaries.map((entry: any) => entry.decision)).toEqual([
      "follow",
      "pause",
      "ignore",
      undefined,
    ]);
    expect(index.tabBoundaries[0]).toMatchObject({
      decision: "follow",
      reason: "same_origin",
      capture: true,
      nonCapture: false,
      root: { origin: "https://app.example.test" },
      current: { origin: "https://app.example.test" },
      candidate: { origin: "https://app.example.test" },
      prompt: { outcome: "approved", origin: "https://app.example.test" },
    });
    expect(index.tabBoundaries[1]).toMatchObject({
      decision: "pause",
      reason: "user_denied_origin",
      prompt: { outcome: "denied", origin: "https://deny.example.test" },
    });
    expect(index.tabBoundaries[2]).toMatchObject({
      decision: "ignore",
      reason: "candidate_scheme_restricted",
      candidate: { scheme: "chrome-extension" },
    });
    expect(bundle.browserEvidence.tabBoundaries).toMatchObject({
      total: 4,
      nonCaptureCount: 2,
    });
    expect(markdown).toContain("### Tab Boundary Decisions");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("/private");
    expect(serialized).not.toContain("/pay");
    expect(serialized).not.toContain("card=");
  });
});
