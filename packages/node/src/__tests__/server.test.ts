import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type http from "node:http";
import { createServer } from "../server";
import { buildFixContext } from "../fix-context";

async function request(
  server: http.Server,
  method: string,
  urlPath: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const addr = server.address() as { port: number };
  const url = `http://localhost:${addr.port}${urlPath}`;
  const opts: RequestInit = { method, headers: { ...headers } };
  if (body !== undefined) {
    if (Buffer.isBuffer(body)) {
      // Node's fetch (undici) accepts a Buffer body at runtime; mixing the DOM
      // and Node global `fetch`/`BodyInit` lib declarations makes the static
      // type of `opts.body` resolve too narrowly here.
      opts.body = body as unknown as BodyInit;
    } else {
      (opts.headers as Record<string, string>)["Content-Type"] =
        "application/json";
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
}

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

function findSessionDir(outputDir: string, sessionId: string): string {
  const stack = [outputDir];
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

describe("server", () => {
  let tmpRoot: string;
  let tmpDir: string;
  let server: http.Server;
  const authHeaders = { "X-Crumbtrail-Auth": "test-token" };

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-srv-root-"));
    tmpDir = path.join(tmpRoot, "sessions");
    fs.mkdirSync(tmpDir, { recursive: true });
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      allowedOrigins: ["https://app.example.com"],
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("GET /health returns structured readiness diagnostics without secrets", async () => {
    const publicRes = await request(server, "GET", "/health");
    expect(publicRes.status).toBe(200);
    expect(publicRes.body).toMatchObject({
      ok: true,
      status: "ready",
      service: "crumbtrail-node",
    });
    expect(publicRes.body).not.toHaveProperty("config");
    expect(publicRes.body).not.toHaveProperty("checks");
    expect(JSON.stringify(publicRes.body)).not.toContain(tmpDir);

    const res = await request(server, "GET", "/health", undefined, authHeaders);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: "ready",
      service: "crumbtrail-node",
      config: {
        port: 0,
        outputDir: tmpDir,
        authEnabled: true,
        allowedOriginCount: 1,
        aiEnabled: false,
        mcpMode: false,
      },
      checks: {
        outputDir: {
          path: tmpDir,
          exists: true,
          writable: true,
        },
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("test-token");
    expect(JSON.stringify(res.body)).not.toContain("app.example.com");
  });

  it("GET /health reports degraded output directory state without stopping the server", async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.writeFileSync(tmpDir, "not a directory");

    const res = await request(server, "GET", "/health", undefined, authHeaders);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: false,
      status: "degraded",
      checks: {
        outputDir: {
          path: tmpDir,
          exists: true,
          writable: false,
        },
      },
    });
  });

  it("OPTIONS only allows configured origins and auth header", async () => {
    const addr = server.address() as { port: number };
    const res = await fetch(`http://localhost:${addr.port}/api/events`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://app.example.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-crumbtrail-auth",
      },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "https://app.example.com",
    );
    expect(res.headers.get("access-control-allow-headers")).toContain(
      "X-Crumbtrail-Auth",
    );
  });

  it("rejects protected routes without auth token", async () => {
    const res = await request(server, "GET", "/api/bugs");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: "Unauthorized",
      code: "permission_denied",
      retryable: false,
    });
  });

  it.each(["bad-token", "test-tokeo"])(
    "rejects protected routes with wrong auth token %s",
    async (token) => {
      const res = await request(server, "GET", "/api/bugs", undefined, {
        "X-Crumbtrail-Auth": token,
      });
      expect(res.status).toBe(401);
      expect(res.body).toMatchObject({
        error: "Unauthorized",
        code: "permission_denied",
        retryable: false,
      });
    },
  );

  it("accepts protected routes with the correct auth token", async () => {
    const res = await request(
      server,
      "GET",
      "/api/bugs",
      undefined,
      authHeaders,
    );
    expect(res.status).toBe(200);
  });

  it("POST /api/session/start creates session directory", async () => {
    const res = await request(
      server,
      "POST",
      "/api/session/start",
      {
        sessionId: "ses_test",
        metadata: { app: "test" },
      },
      authHeaders,
    );
    expect(res.status).toBe(200);
    const sessionDir = findSessionDir(tmpDir, "ses_test");
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "meta.json"))).toBe(true);
  });

  it("rejects remote API mode without an auth token", () => {
    expect(() =>
      createServer({ port: 0, outputDir: tmpDir, allowRemoteApi: true }),
    ).toThrow("Remote API mode requires authToken");
  });

  it("POST /api/session/start rejects existing session ids", async () => {
    const first = await request(
      server,
      "POST",
      "/api/session/start",
      {
        sessionId: "ses_unique",
        metadata: { app: "test" },
      },
      authHeaders,
    );
    const second = await request(
      server,
      "POST",
      "/api/session/start",
      {
        sessionId: "ses_unique",
        metadata: { app: "other" },
      },
      authHeaders,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: "session_exists" });
    const meta = JSON.parse(
      fs.readFileSync(
        path.join(findSessionDir(tmpDir, "ses_unique"), "meta.json"),
        "utf-8",
      ),
    );
    expect(meta.app).toBe("test");
  });

  it("rejects root-relative session ids before touching the output root", async () => {
    const res = await request(
      server,
      "POST",
      "/api/session/start",
      {
        sessionId: ".",
        metadata: { app: "test" },
      },
      authHeaders,
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "Invalid sessionId",
      code: "invalid_session_id",
    });
    expect(fs.existsSync(path.join(tmpDir, "meta.json"))).toBe(false);
  });

  it("rejects JSON mutating routes without an application/json content type before persistence", async () => {
    const addr = server.address() as { port: number };
    const res = await fetch(`http://localhost:${addr.port}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "text/plain", ...authHeaders },
      body: JSON.stringify({ sessionId: "ses_plain", metadata: {} }),
    });
    const body = await res.json();

    expect(res.status).toBe(415);
    expect(body).toMatchObject({
      error: "Expected application/json request body",
      code: "invalid_content_type",
    });
    expect(fs.existsSync(path.join(tmpDir, "ses_plain"))).toBe(false);
  });

  it("rejects oversized JSON writes before creating a session directory", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      maxJsonBodyBytes: 64,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const res = await request(
      server,
      "POST",
      "/api/session/start",
      {
        sessionId: "ses_oversized",
        metadata: { note: "x".repeat(256) },
      },
      authHeaders,
    );

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      error: "Request body is too large",
      code: "request_too_large",
    });
    expect(fs.existsSync(path.join(tmpDir, "ses_oversized"))).toBe(false);
  });

  it("rejects oversized event batches before appending events", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      maxEventBatchSize: 1,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));

    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_events", metadata: {} },
      authHeaders,
    );
    const res = await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_events",
        events: [
          { t: 1, k: "a", d: {} },
          { t: 2, k: "b", d: {} },
        ],
      },
      authHeaders,
    );

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({
      error: "Too many events in one batch",
      code: "request_too_large",
    });
    expect(
      fs.existsSync(path.join(tmpDir, "ses_events", "events.ndjson")),
    ).toBe(false);
  });

  it("rejects oversized blobs before writing the file", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      maxBlobBytes: 4,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));

    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_blob", metadata: {} },
      authHeaders,
    );
    const addr = server.address() as { port: number };
    const res = await fetch(
      `http://localhost:${addr.port}/api/blob/recording.webm`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Session-Id": "ses_blob",
          ...authHeaders,
        },
        body: Buffer.from("too large"),
      },
    );
    const body = await res.json();

    expect(res.status).toBe(413);
    expect(body).toMatchObject({
      error: "Request body is too large",
      code: "request_too_large",
    });
    expect(fs.existsSync(path.join(tmpDir, "ses_blob", "recording.webm"))).toBe(
      false,
    );
  });

  it("rejects unknown session writes before creating artifacts", async () => {
    const eventRes = await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_missing",
        events: [{ t: 1, k: "nav", d: { to: "/" } }],
      },
      authHeaders,
    );
    expect(eventRes.status).toBe(404);
    expect(eventRes.body).toMatchObject({
      error: "Session not found",
      code: "not_found",
      retryable: false,
    });
    expect(fs.existsSync(path.join(tmpDir, "ses_missing"))).toBe(false);

    const endRes = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId: "ses_missing" },
      authHeaders,
    );
    expect(endRes.status).toBe(404);
    expect(endRes.body).toMatchObject({
      error: "Session not found",
      code: "not_found",
      retryable: false,
    });

    const blobRes = await request(
      server,
      "POST",
      "/api/blob/recording.webm",
      Buffer.from("video"),
      {
        "Content-Type": "application/octet-stream",
        "X-Session-Id": "ses_missing",
        ...authHeaders,
      },
    );
    expect(blobRes.status).toBe(404);
    expect(blobRes.body).toMatchObject({
      error: "Session not found",
      code: "not_found",
      retryable: false,
    });
    expect(
      fs.existsSync(path.join(tmpDir, "ses_missing", "recording.webm")),
    ).toBe(false);
  });

  it("returns not found when meta.json is missing from an existing session directory", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_missing_meta", metadata: {} },
      authHeaders,
    );
    fs.rmSync(
      path.join(findSessionDir(tmpDir, "ses_missing_meta"), "meta.json"),
    );

    const res = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId: "ses_missing_meta" },
      authHeaders,
    );

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({
      error: "Session not found",
      code: "not_found",
      retryable: false,
    });
  });

  it("rejects symlinked session directories on direct routes", async () => {
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-direct-outside-"),
    );
    try {
      fs.writeFileSync(
        path.join(outsideDir, "meta.json"),
        JSON.stringify({ id: "ses_link", start: 1 }),
      );
      fs.symlinkSync(outsideDir, path.join(tmpDir, "ses_link"), "dir");

      const pageRes = await request(
        server,
        "GET",
        "/sessions/ses_link",
        undefined,
        authHeaders,
      );
      expect(pageRes.status).toBe(400);
      expect(pageRes.body).toMatchObject({
        error: "Invalid sessionId",
        code: "invalid_session_id",
      });

      const eventRes = await request(
        server,
        "POST",
        "/api/events",
        {
          sessionId: "ses_link",
          events: [{ t: 1, k: "nav", d: { to: "/" } }],
        },
        authHeaders,
      );
      expect(eventRes.status).toBe(400);
      expect(eventRes.body).toMatchObject({
        error: "Invalid sessionId",
        code: "invalid_session_id",
      });
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("POST /api/events appends events to NDJSON file", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_test", metadata: {} },
      authHeaders,
    );
    const events = [{ t: 1000, k: "con", d: { lv: "log", args: ['"hi"'] } }];
    const res = await request(
      server,
      "POST",
      "/api/events",
      { sessionId: "ses_test", events },
      authHeaders,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      accepted: 1,
      dropped: 0,
      truncated: false,
    });
    const content = fs.readFileSync(
      path.join(findSessionDir(tmpDir, "ses_test"), "events.ndjson"),
      "utf-8",
    );
    expect(content.trim()).toBe(JSON.stringify(events[0]));
  });

  it("POST /api/events accepts mobile envelope metadata and neutral event kinds", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_mobile", metadata: {} },
      authHeaders,
    );
    const events = [
      {
        schemaVersion: 1,
        platform: "react-native",
        sdk: { name: "@crumbtrail/react-native", version: "0.1.0" },
        capabilities: [
          "navigation",
          "app-lifecycle",
          "native-crash",
          "view-snapshot",
        ],
        t: 1000,
        k: "navigation",
        d: { from: "Login", to: "Checkout" },
      },
      {
        schemaVersion: 1,
        platform: "ios",
        sdk: { name: "crumbtrail-ios", version: "0.1.0" },
        capabilities: ["native-crash"],
        t: 1100,
        k: "native-crash",
        target: {
          role: "button",
          label: "Submit order",
          accessibilityId: "checkout.submit",
          testID: "checkout-submit",
          componentName: "SubmitButton",
          routePath: "/checkout",
          ancestryHash: "ios:checkout:footer:primary",
          bounds: { x: 0, y: 10, width: 120, height: 44 },
        },
        d: {
          exceptionType: "NSInvalidArgumentException",
          message: "Unrecognized selector",
          target: {
            role: "button",
            label: "Submit order",
            accessibilityId: "checkout.submit",
          },
        },
      },
      {
        schemaVersion: 1,
        platform: "android",
        sdk: { name: "android-sdk" },
        capabilities: ["app-lifecycle"],
        t: 1200,
        k: "app-lifecycle",
        d: { state: "background" },
      },
      {
        schemaVersion: 1,
        platform: "react-native",
        sdk: { name: "@crumbtrail/react-native" },
        capabilities: ["view-snapshot"],
        t: 1300,
        k: "view-snapshot",
        d: {
          screen: "Checkout",
          target: {
            role: "text",
            label: "Order total",
            testID: "order-total",
            routePath: "/checkout",
          },
        },
      },
    ];

    const res = await request(
      server,
      "POST",
      "/api/events",
      { sessionId: "ses_mobile", events },
      authHeaders,
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      accepted: 4,
      dropped: 0,
      truncated: false,
    });
    expect(
      readNdjson(
        path.join(findSessionDir(tmpDir, "ses_mobile"), "events.ndjson"),
      ),
    ).toEqual(events);
  });

  it("POST /api/events treats missing platform as web without rewriting current web events", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_web_default", metadata: {} },
      authHeaders,
    );
    const event = { t: 1000, k: "navigation", d: { to: "/settings" } };

    const res = await request(
      server,
      "POST",
      "/api/events",
      { sessionId: "ses_web_default", events: [event] },
      authHeaders,
    );

    expect(res.status).toBe(200);
    expect(
      readNdjson(
        path.join(findSessionDir(tmpDir, "ses_web_default"), "events.ndjson"),
      ),
    ).toEqual([event]);
  });

  it("POST /api/events accepts custom legacy web event kinds unchanged", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_legacy_custom", metadata: {} },
      authHeaders,
    );
    const event = {
      t: 1000,
      k: "custom.metric",
      d: {
        name: "cart_total",
        value: 42,
        el: { tag: "BUTTON", txt: "Submit order" },
      },
    };

    const res = await request(
      server,
      "POST",
      "/api/events",
      { sessionId: "ses_legacy_custom", events: [event] },
      authHeaders,
    );

    expect(res.status).toBe(200);
    expect(
      readNdjson(
        path.join(findSessionDir(tmpDir, "ses_legacy_custom"), "events.ndjson"),
      ),
    ).toEqual([event]);
  });

  it("POST /api/events preserves planned target descriptors through post-processed fix-context output", async () => {
    const sessionId = "ses_ingested_target_context";
    const target = {
      role: "button",
      label: "Submit order",
      testID: "submit-order",
      accessibilityId: "checkout.submit",
      componentName: "Pressable",
      routePath: "/checkout",
    };
    const events = [
      {
        t: 1000,
        k: "navigation",
        offsetMs: 0,
        platform: "react-native",
        d: { to: "/checkout" },
      },
      {
        t: 1100,
        k: "clk",
        offsetMs: 100,
        platform: "react-native",
        target,
        d: { target },
      },
      {
        t: 1600,
        k: "clk",
        offsetMs: 600,
        platform: "react-native",
        target,
        d: { target },
      },
      {
        t: 2100,
        k: "clk",
        offsetMs: 1100,
        platform: "react-native",
        target,
        d: { target },
      },
    ];
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId, metadata: { app: "shop" } },
      authHeaders,
    );

    const eventRes = await request(
      server,
      "POST",
      "/api/events",
      { sessionId, events },
      authHeaders,
    );
    const endRes = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId },
      authHeaders,
    );

    expect(eventRes.status, JSON.stringify(eventRes.body)).toBe(200);
    expect(endRes.status, JSON.stringify(endRes.body)).toBe(200);
    const fc = await buildFixContext(findSessionDir(tmpDir, sessionId));
    expect(fc.signals[0]).toMatchObject({
      detector: "repeated_clicks",
      anchor: {
        route: "/checkout",
        target: {
          testID: "submit-order",
          accessibilityId: "checkout.submit",
          routePath: "/checkout",
        },
      },
    });
  });

  it("proves Expo React Native replay-lite and crash screenshot ingest renders in fix-context artifacts", async () => {
    const sessionId = "ses_expo_rn_ingest_proof";
    const target = {
      role: "button",
      label: "Submit order",
      testID: "checkout-submit",
      accessibilityId: "checkout.submit",
      componentName: "Pressable",
      routePath: "/checkout",
      ancestryHash: "rn:checkout:footer:primary",
      bounds: { x: 24, y: 702, width: 342, height: 52 },
    };
    const mobileEnvelope = {
      schemaVersion: 1,
      platform: "react-native",
      sdk: { name: "crumbtrail-react-native", version: "0.1.0" },
      capabilities: [
        "async-storage",
        "navigation",
        "view-snapshot",
        "app-lifecycle",
        "native-crash",
      ],
    };
    const screenshotUri =
      "https://screenshots.example.test/expo-cache/crumbtrail/crash-checkout.jpg?token=sk_fake_mobile_secret";
    const events = [
      {
        ...mobileEnvelope,
        t: 1000,
        k: "env",
        offsetMs: 0,
        d: {
          kind: "snapshot",
          platform: {
            os: "ios",
            version: "17.4",
            constants: { appOwnership: "expo" },
          },
          viewport: { w: 390, h: 844, scale: 3 },
        },
      },
      {
        ...mobileEnvelope,
        t: 1010,
        k: "navigation",
        offsetMs: 10,
        d: { name: "Checkout", path: "/checkout", key: "checkout-1" },
      },
      {
        ...mobileEnvelope,
        t: 1050,
        k: "view-snapshot",
        offsetMs: 50,
        d: {
          kind: "component-tree",
          routePath: "/checkout",
          root: {
            componentName: "CheckoutScreen",
            children: [
              {
                componentName: "Pressable",
                role: "button",
                label: "Submit order",
                testID: "checkout-submit",
                bounds: target.bounds,
              },
            ],
          },
          target,
        },
      },
      {
        ...mobileEnvelope,
        t: 1100,
        k: "touch",
        offsetMs: 100,
        target,
        d: { kind: "overlay", x: 196, y: 728, phase: "press" },
      },
      {
        ...mobileEnvelope,
        t: 1200,
        k: "clk",
        offsetMs: 200,
        target,
        d: { target },
      },
      {
        ...mobileEnvelope,
        t: 1500,
        k: "clk",
        offsetMs: 500,
        target,
        d: { target },
      },
      {
        ...mobileEnvelope,
        t: 1800,
        k: "clk",
        offsetMs: 800,
        target,
        d: { target },
      },
      {
        ...mobileEnvelope,
        t: 1810,
        k: "view-snapshot",
        offsetMs: 810,
        d: {
          kind: "crash-screenshot",
          uri: screenshotUri,
          capture: "react-native-view-shot",
        },
      },
      {
        ...mobileEnvelope,
        t: 1820,
        k: "native-crash",
        offsetMs: 820,
        target,
        d: {
          message: "Unhandled JS exception while submitting order",
          exceptionType: "Error",
          screenshotUri,
        },
      },
    ];

    await request(
      server,
      "POST",
      "/api/session/start",
      {
        sessionId,
        metadata: { app: "shop-expo", source: "expo-managed" },
      },
      authHeaders,
    );
    const eventRes = await request(
      server,
      "POST",
      "/api/events",
      { sessionId, events },
      authHeaders,
    );
    const endRes = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId },
      authHeaders,
    );

    expect(eventRes.status, JSON.stringify(eventRes.body)).toBe(200);
    expect(eventRes.body).toMatchObject({ accepted: events.length });
    expect(endRes.status, JSON.stringify(endRes.body)).toBe(200);

    const sessionDir = findSessionDir(tmpDir, sessionId);
    const storedEvents = readNdjson(path.join(sessionDir, "events.ndjson"));
    expect(storedEvents).toHaveLength(events.length);
    expect(
      storedEvents.every((event) => event.platform === "react-native"),
    ).toBe(true);
    expect(storedEvents[3].target).toMatchObject(target);
    expect(storedEvents[8].d.screenshotUri).toBe(
      "https://screenshots.example.test/expo-cache/crumbtrail/crash-checkout.jpg?token=%5BREDACTED%5D",
    );
    expect(JSON.stringify(storedEvents)).not.toContain("sk_fake_mobile_secret");

    const fc = await buildFixContext(sessionDir);
    expect(fc.session.app).toBe("shop-expo");
    expect(fc.signals[0]).toMatchObject({
      detector: "repeated_clicks",
      anchor: {
        route: "/checkout",
        target: {
          testID: "checkout-submit",
          accessibilityId: "checkout.submit",
          componentName: "Pressable",
        },
      },
    });
    expect(fc.primary_window.frontend.anchor?.target).toMatchObject({
      routePath: "/checkout",
      ancestryHash: "rn:checkout:footer:primary",
    });

    const timeline = fs.readFileSync(
      path.join(sessionDir, "timeline.md"),
      "utf-8",
    );
    expect(timeline).toContain("view snapshot Submit order");
    expect(timeline).toContain("native crash Unhandled JS exception");
    expect(timeline).toContain(
      "https://screenshots.example.test/expo-cache/crumbtrail/crash-checkout.jpg?token=%5BREDACTED%5D",
    );
    expect(timeline).not.toContain("sk_fake_mobile_secret");

    const searchRows = readNdjson(path.join(sessionDir, "search.jsonl"));
    expect(
      searchRows.some(
        (row) =>
          row.type === "event" &&
          row.k === "view-snapshot" &&
          String(row.text).includes("Submit order"),
      ),
    ).toBe(true);
    expect(
      searchRows.some(
        (row) =>
          row.type === "event" &&
          row.k === "native-crash" &&
          String(row.text).includes("token=%5BREDACTED%5D"),
      ),
    ).toBe(true);
    expect(JSON.stringify(searchRows)).not.toContain("sk_fake_mobile_secret");
  });

  it("POST /api/events rejects invalid mobile metadata with useful errors", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_mobile_invalid", metadata: {} },
      authHeaders,
    );

    const res = await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_mobile_invalid",
        events: [
          {
            t: 1000,
            k: "native-crash",
            platform: "blackberry",
            d: { message: "boom" },
          },
        ],
      },
      authHeaders,
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: expect.stringContaining("events[0].platform must be one of"),
      code: "invalid_events",
      retryable: false,
    });
    expect(
      fs.existsSync(
        path.join(
          findSessionDir(tmpDir, "ses_mobile_invalid"),
          "events.ndjson",
        ),
      ),
    ).toBe(false);
  });

  it("POST /api/events rejects invalid planned target fields with useful errors", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_target_invalid", metadata: {} },
      authHeaders,
    );

    const res = await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_target_invalid",
        events: [
          {
            t: 1000,
            k: "view-snapshot",
            platform: "react-native",
            d: { target: { testID: "   " } },
          },
        ],
      },
      authHeaders,
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "events[0].d.target.testID must be a non-empty string",
      code: "invalid_events",
      retryable: false,
    });
    expect(
      fs.existsSync(
        path.join(
          findSessionDir(tmpDir, "ses_target_invalid"),
          "events.ndjson",
        ),
      ),
    ).toBe(false);
  });

  it.each([
    [
      "empty target",
      { target: {} },
      "events[0].target must include at least one planned target field",
    ],
    [
      "bounds-only target",
      { target: { bounds: { x: 0, y: 10, width: 120, height: 44 } } },
      "events[0].target must include at least one planned target field",
    ],
    [
      "malformed d.target",
      { d: { target: "submit-order" } },
      "events[0].d.target must be an object",
    ],
  ])("POST /api/events rejects %s descriptors", async (_name, patch, error) => {
    const sessionId = `ses_target_${String(_name).replace(/\W+/g, "_")}`;
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId, metadata: {} },
      authHeaders,
    );

    const event = {
      t: 1000,
      k: "view-snapshot",
      platform: "react-native",
      d: {},
      ...patch,
    };
    const res = await request(
      server,
      "POST",
      "/api/events",
      { sessionId, events: [event] },
      authHeaders,
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error,
      code: "invalid_events",
      retryable: false,
    });
    expect(
      fs.existsSync(
        path.join(findSessionDir(tmpDir, sessionId), "events.ndjson"),
      ),
    ).toBe(false);
  });

  it("POST /api/events stops capture and marks truncation when the session byte cap is reached", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      maxSessionEventBytes: 64,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_cap", metadata: {} },
      authHeaders,
    );

    const events = [
      { t: 1, k: "a", d: { msg: "fits" } },
      {
        t: 2,
        k: "b",
        d: { msg: "this event is too large for the remaining cap" },
      },
      {
        t: 3,
        k: "c",
        d: { msg: "small but still dropped after truncation starts" },
      },
    ];
    const res = await request(
      server,
      "POST",
      "/api/events",
      { sessionId: "ses_cap", events },
      authHeaders,
    );
    const followup = await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_cap",
        events: [{ t: 4, k: "d", d: { msg: "ignored after cap" } }],
      },
      authHeaders,
    );
    const capDir = findSessionDir(tmpDir, "ses_cap");
    const marker = JSON.parse(
      fs.readFileSync(path.join(capDir, "capture-truncated.json"), "utf-8"),
    );
    const persisted = readNdjson(path.join(capDir, "events.ndjson"));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      accepted: 1,
      dropped: 2,
      truncated: true,
    });
    expect(followup.body).toMatchObject({
      ok: true,
      accepted: 0,
      dropped: 1,
      truncated: true,
    });
    expect(persisted).toEqual([events[0]]);
    expect(marker).toMatchObject({
      truncated: true,
      reason: "session_event_bytes_cap",
      maxEventBytes: 64,
    });
  });

  it("POST /api/blob/:name writes binary file", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_test", metadata: {} },
      authHeaders,
    );
    const data = Buffer.from("binary content");
    const addr = server.address() as { port: number };
    const res = await fetch(
      `http://localhost:${addr.port}/api/blob/recording.webm`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Session-Id": "ses_test",
          ...authHeaders,
        },
        body: data,
      },
    );
    expect(res.status).toBe(200);
    const written = fs.readFileSync(
      path.join(findSessionDir(tmpDir, "ses_test"), "recording.webm"),
    );
    expect(Buffer.compare(written, data)).toBe(0);
  });

  it("rejects blob uploads through symlinked allowed artifact names", async () => {
    const outsideFile = path.join(
      os.tmpdir(),
      `crumbtrail-outside-${Date.now()}.webm`,
    );
    fs.writeFileSync(outsideFile, "outside");
    try {
      await request(
        server,
        "POST",
        "/api/session/start",
        { sessionId: "ses_symlink_blob", metadata: {} },
        authHeaders,
      );
      fs.symlinkSync(
        outsideFile,
        path.join(findSessionDir(tmpDir, "ses_symlink_blob"), "recording.webm"),
      );

      const res = await request(
        server,
        "POST",
        "/api/blob/recording.webm",
        Buffer.from("video"),
        {
          "Content-Type": "application/octet-stream",
          "X-Session-Id": "ses_symlink_blob",
          ...authHeaders,
        },
      );

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "invalid_artifact_path" });
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("outside");
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("rejects blob uploads to reserved session artifact names", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_reserved_blob", metadata: {} },
      authHeaders,
    );
    const res = await request(
      server,
      "POST",
      "/api/blob/meta.json",
      Buffer.from("fake meta"),
      {
        "Content-Type": "application/octet-stream",
        "X-Session-Id": "ses_reserved_blob",
        ...authHeaders,
      },
    );

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({
      error: "Invalid blob name",
      code: "invalid_blob_name",
    });
    const meta = JSON.parse(
      fs.readFileSync(
        path.join(findSessionDir(tmpDir, "ses_reserved_blob"), "meta.json"),
        "utf-8",
      ),
    );
    expect(meta.id).toBe("ses_reserved_blob");
  });

  it("POST /api/blob/audio.webm writes binary file and safe upload metadata", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_audio", metadata: {} },
      authHeaders,
    );
    const data = Buffer.from("audio content");
    const res = await request(server, "POST", "/api/blob/audio.webm", data, {
      "Content-Type": "audio/webm",
      "X-Session-Id": "ses_audio",
      "X-Metadata": JSON.stringify({
        capability: "audio",
        fileName: "audio.webm",
        mimeType: "audio/webm;codecs=opus",
        durationMs: 3200,
        chunkCount: 3,
        transcriptionRequested: true,
        rootUrl: "https://example.com/ignored-for-audio-metadata",
      }),
      ...authHeaders,
    });

    expect(res.status).toBe(200);
    const audioDir = findSessionDir(tmpDir, "ses_audio");
    const written = fs.readFileSync(path.join(audioDir, "audio.webm"));
    expect(Buffer.compare(written, data)).toBe(0);
    const metadata = JSON.parse(
      fs.readFileSync(path.join(audioDir, "audio.json"), "utf-8"),
    );
    expect(metadata).toMatchObject({
      artifact: "audio.webm",
      bytes: data.length,
      contentType: "audio/webm",
      metadataStatus: "stored",
      capability: "audio",
      mimeType: "audio/webm;codecs=opus",
      durationMs: 3200,
      chunkCount: 3,
      transcriptionRequested: true,
    });
    expect(metadata).not.toHaveProperty("rootUrl");
  });

  it("POST /api/session/end exposes transcript-ready audio finalization state", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_audio_ready", metadata: {} },
      authHeaders,
    );
    await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_audio_ready",
        events: [
          { t: 1000, k: "nav", d: { to: "/", from: "", tr: "init" } },
          {
            t: 1250,
            k: "media.voice",
            d: {
              capability: "audio",
              state: "marker-added",
              markerId: "voice-marker-1",
            },
          },
        ],
      },
      authHeaders,
    );
    await request(
      server,
      "POST",
      "/api/blob/audio.webm",
      Buffer.from("audio data"),
      {
        "Content-Type": "audio/webm",
        "X-Session-Id": "ses_audio_ready",
        "X-Metadata": JSON.stringify({
          transcriptionRequested: true,
          durationMs: 2500,
          chunkCount: 1,
        }),
        ...authHeaders,
      },
    );

    const res = await withFakeAudioTools(
      tmpDir,
      JSON.stringify({
        transcription: [{ offsets: { from: 10 }, text: " local transcript " }],
      }),
      async () =>
        request(
          server,
          "POST",
          "/api/session/end",
          { sessionId: "ses_audio_ready" },
          authHeaders,
        ),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      sessionId: "ses_audio_ready",
      processed: true,
      degraded: false,
      postProcess: {
        ok: true,
        audio: {
          artifact: "audio.webm",
          transcription: {
            state: "transcription-ready",
            transcriptFile: "transcript.json",
            eventCount: 1,
          },
        },
      },
    });
    expect(JSON.stringify(res.body)).not.toContain("local transcript");
    const sessionDir = findSessionDir(tmpDir, "ses_audio_ready");
    const events = readNdjson(path.join(sessionDir, "events.ndjson"));
    expect(
      events.some(
        (event) =>
          event.k === "media.voice" && event.d.state === "marker-added",
      ),
    ).toBe(true);
    expect(events.filter((event) => event.k === "tx")).toHaveLength(1);
  });

  it("POST /api/session/end exposes transcript-unavailable as non-fatal degradation", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_audio_unavailable", metadata: {} },
      authHeaders,
    );
    await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_audio_unavailable",
        events: [
          { t: 1000, k: "nav", d: { to: "/", from: "", tr: "init" } },
          {
            t: 1250,
            k: "media.voice",
            d: {
              capability: "audio",
              state: "marker-added",
              markerId: "voice-marker-1",
            },
          },
        ],
      },
      authHeaders,
    );
    await request(
      server,
      "POST",
      "/api/blob/audio.webm",
      Buffer.from("audio data"),
      {
        "Content-Type": "audio/webm",
        "X-Session-Id": "ses_audio_unavailable",
        "X-Metadata": JSON.stringify({ transcriptionRequested: true }),
        ...authHeaders,
      },
    );
    const emptyBin = path.join(tmpDir, "empty-bin");
    fs.mkdirSync(emptyBin);

    const res = await withPath(emptyBin, async () =>
      request(
        server,
        "POST",
        "/api/session/end",
        { sessionId: "ses_audio_unavailable" },
        authHeaders,
      ),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      sessionId: "ses_audio_unavailable",
      processed: true,
      degraded: true,
      postProcess: {
        ok: true,
        audio: {
          artifact: "audio.webm",
          transcription: {
            state: "transcription-unavailable",
            code: "transcription_unavailable",
          },
        },
        warnings: [
          {
            capability: "audio",
            code: "transcription_unavailable",
          },
        ],
      },
    });
    const sessionDir = findSessionDir(tmpDir, "ses_audio_unavailable");
    expect(fs.existsSync(path.join(sessionDir, "audio.webm"))).toBe(true);
    const events = readNdjson(path.join(sessionDir, "events.ndjson"));
    expect(
      events.some(
        (event) =>
          event.k === "media.voice" && event.d.state === "marker-added",
      ),
    ).toBe(true);
    expect(events.some((event) => event.k === "tx")).toBe(false);
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    expect(meta.processed).toBe(true);
    expect(meta.finalization.degraded).toBe(true);
    expect(meta.finalization.postProcess.audio.transcription.state).toBe(
      "transcription-unavailable",
    );
  });

  it("POST /api/session/end finalizes session with index.json", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_test", metadata: {} },
      authHeaders,
    );
    await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_test",
        events: [{ t: 1000, k: "nav", d: { to: "/", from: "", tr: "init" } }],
      },
      authHeaders,
    );
    const res = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId: "ses_test" },
      authHeaders,
    );
    const sessionDir = findSessionDir(tmpDir, "ses_test");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      sessionId: "ses_test",
      processed: true,
      degraded: false,
      sessionDir,
      sessionUrl: expect.stringMatching(
        /^http:\/\/localhost:\d+\/sessions\/ses_test$/,
      ),
      llmUrl: expect.stringMatching(
        /^http:\/\/localhost:\d+\/sessions\/ses_test\/llm\.md$/,
      ),
      postProcess: { ok: true },
    });
    expect(fs.existsSync(path.join(sessionDir, "index.json"))).toBe(true);
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    expect(meta.processed).toBe(true);
    expect(meta.finalization).toMatchObject({
      degraded: false,
      postProcess: { ok: true },
    });
  });

  it("GET /sessions/:sessionId opens a saved session page with the folder path and LLM link", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_open", metadata: {} },
      authHeaders,
    );
    await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_open",
        events: [{ t: 1000, k: "nav", d: { to: "/", from: "", tr: "init" } }],
      },
      authHeaders,
    );
    const endRes = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId: "ses_open" },
      authHeaders,
    );
    const sessionUrl = (endRes.body as { sessionUrl: string }).sessionUrl;

    const pageRes = await fetch(sessionUrl, { headers: authHeaders });
    const html = await pageRes.text();

    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get("content-type")).toContain("text/html");
    expect(html).toContain(findSessionDir(tmpDir, "ses_open"));
    expect(html).toContain("/sessions/ses_open/llm.md");
    expect(html).toContain("/sessions/ses_open/events.ndjson.zst");
    expect(html).not.toContain('/sessions/ses_open/events.ndjson"');

    const rawEventsRes = await fetch(`${sessionUrl}/events.ndjson`, {
      headers: authHeaders,
    });
    const rawEventsBody = await rawEventsRes.json();
    expect(rawEventsRes.status).toBe(404);
    expect(rawEventsBody).toMatchObject({ code: "not_found" });

    const coldEventsRes = await fetch(`${sessionUrl}/events.ndjson.zst`, {
      headers: authHeaders,
    });
    expect(coldEventsRes.status).toBe(200);
    expect(coldEventsRes.headers.get("content-type")).toBe("application/zstd");
  });

  it("does not serve symlinked allowed session artifacts", async () => {
    const outsideFile = path.join(
      os.tmpdir(),
      `crumbtrail-outside-${Date.now()}.md`,
    );
    fs.writeFileSync(outsideFile, "# outside");
    try {
      await request(
        server,
        "POST",
        "/api/session/start",
        { sessionId: "ses_symlink_artifact", metadata: {} },
        authHeaders,
      );
      fs.symlinkSync(
        outsideFile,
        path.join(findSessionDir(tmpDir, "ses_symlink_artifact"), "llm.md"),
      );
      const addr = server.address() as { port: number };

      const res = await fetch(
        `http://localhost:${addr.port}/sessions/ses_symlink_artifact/llm.md`,
        { headers: authHeaders },
      );

      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ code: "not_found" });
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("rejects session pages and artifacts without auth when an auth token is configured", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_auth_session", metadata: {} },
      authHeaders,
    );
    const addr = server.address() as { port: number };

    const pageRes = await fetch(
      `http://localhost:${addr.port}/sessions/ses_auth_session`,
    );
    const artifactRes = await fetch(
      `http://localhost:${addr.port}/sessions/ses_auth_session/meta.json`,
    );

    expect(pageRes.status).toBe(401);
    expect(await pageRes.json()).toMatchObject({ code: "permission_denied" });
    expect(artifactRes.status).toBe(401);
    expect(await artifactRes.json()).toMatchObject({
      code: "permission_denied",
    });
  });

  it("serves legacy plain event logs when no sanitized cold artifact exists", async () => {
    writeSession(tmpDir, "ses_plain_events", {
      meta: { id: "ses_plain_events", start: 1000 },
      files: {
        "events.ndjson": `${JSON.stringify({ t: 1000, k: "nav", d: { to: "/" } })}\n`,
      },
    });
    const addr = server.address() as { port: number };
    const res = await fetch(
      `http://localhost:${addr.port}/sessions/ses_plain_events/events.ndjson`,
      { headers: authHeaders },
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/x-ndjson");
    expect(await res.text()).toContain('"k":"nav"');
  });

  it("POST /api/session/end returns degraded finalization status when post-processing fails", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_degraded", metadata: {} },
      authHeaders,
    );
    fs.mkdirSync(
      path.join(findSessionDir(tmpDir, "ses_degraded"), "events.ndjson"),
    );

    const res = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId: "ses_degraded" },
      authHeaders,
    );
    const sessionDir = findSessionDir(tmpDir, "ses_degraded");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      sessionId: "ses_degraded",
      processed: false,
      degraded: true,
      sessionDir,
      sessionUrl: expect.stringMatching(
        /^http:\/\/localhost:\d+\/sessions\/ses_degraded$/,
      ),
      postProcess: {
        ok: false,
        error:
          "Post-processing failed; session artifacts were preserved without derived outputs",
      },
    });
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    expect(meta.processed).toBe(false);
    expect(meta.finalization.degraded).toBe(true);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await request(server, "GET", "/unknown");
    expect(res.status).toBe(404);
  });

  it("creates bug report and serves compact LLM context", async () => {
    const report = {
      bugId: "bug_test_1",
      sessionId: "ses_test",
      flaggedAt: 1000,
      windowMs: 60000,
      url: "http://localhost",
      userAgent: "test",
      summary: {
        errorCount: 1,
        failedRequestCount: 1,
        eventCount: 2,
        eventKinds: { err: 1, "net.res": 1 },
        durationMs: 50,
      },
    };
    const events = [
      { t: 1000, k: "err", d: { msg: "boom" } },
      { t: 1050, k: "net.res", d: { id: "r1", st: 500 } },
    ];

    const flagRes = await request(
      server,
      "POST",
      "/api/bug/flag",
      { report, events },
      authHeaders,
    );
    expect(flagRes.status).toBe(200);

    const llmRes = await request(
      server,
      "GET",
      "/api/bug/bug_test_1/llm",
      undefined,
      authHeaders,
    );
    expect(llmRes.status).toBe(200);
    expect((llmRes.body as any).id).toBe("bug_test_1");
    expect((llmRes.body as any).s.e).toBe(1);
  });

  it("redacts and bounds bug report fields before persistence", async () => {
    const report = {
      bugId: "bug_redact_1",
      sessionId: "ses_test",
      flaggedAt: 1000,
      windowMs: 60000,
      url: "https://app.example.test/page?token=sk_fake_abcdefghijklmnopqrstuvwxyz&email=user@example.test",
      userAgent: `agent Bearer ${"a".repeat(48)}`,
      note: `checkout failed with sk_fake_${"b".repeat(40)}`,
      tags: ["billing", "x".repeat(200)],
      summary: {
        errorCount: 1,
        failedRequestCount: 1,
        eventCount: 2,
        eventKinds: { err: 1 },
        durationMs: 50,
      },
    };

    const flagRes = await request(
      server,
      "POST",
      "/api/bug/flag",
      { report, events: [] },
      authHeaders,
    );
    expect(flagRes.status).toBe(200);

    const storedPath = path.join(
      path.dirname(tmpDir),
      "bugs",
      "bug_redact_1",
      "report.json",
    );
    const stored = JSON.parse(fs.readFileSync(storedPath, "utf-8"));
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain("sk_fake_");
    expect(serialized).not.toContain("Bearer ");
    expect(decodeURIComponent(stored.url)).toContain("[REDACTED]");
    expect(stored.tags[1].length).toBeLessThanOrEqual(64);
  });

  it("rejects duplicate bug IDs instead of overwriting existing reports", async () => {
    const firstReport = {
      bugId: "bug_duplicate_1",
      sessionId: "ses_first",
      flaggedAt: 1000,
      windowMs: 60000,
      url: "http://localhost/first",
      userAgent: "first",
      summary: {
        errorCount: 0,
        failedRequestCount: 0,
        eventCount: 0,
        eventKinds: {},
        durationMs: 0,
      },
    };
    const secondReport = {
      ...firstReport,
      sessionId: "ses_second",
      url: "http://localhost/second",
      userAgent: "second",
    };

    const first = await request(
      server,
      "POST",
      "/api/bug/flag",
      { report: firstReport, events: [] },
      authHeaders,
    );
    const second = await request(
      server,
      "POST",
      "/api/bug/flag",
      { report: secondReport, events: [] },
      authHeaders,
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body).toMatchObject({ code: "bug_exists" });
    const stored = JSON.parse(
      fs.readFileSync(
        path.join(
          path.dirname(tmpDir),
          "bugs",
          "bug_duplicate_1",
          "report.json",
        ),
        "utf-8",
      ),
    );
    expect(stored.sessionId).toBe("ses_first");
    expect(stored.url).toBe("http://localhost/first");
  });

  it("does not leave a partial bug report when event storage fails", async () => {
    const report = {
      bugId: "bug_partial_retry",
      sessionId: "ses_test",
      flaggedAt: 1000,
      windowMs: 60000,
      url: "http://localhost/first",
      userAgent: "test",
      summary: {
        errorCount: 0,
        failedRequestCount: 0,
        eventCount: 1,
        eventKinds: { bad: 1 },
        durationMs: 0,
      },
    };

    const failed = await request(
      server,
      "POST",
      "/api/bug/flag",
      { report, events: [null] },
      authHeaders,
    );
    expect(failed.status).toBe(500);
    expect(
      fs.existsSync(
        path.join(path.dirname(tmpDir), "bugs", "bug_partial_retry"),
      ),
    ).toBe(false);

    const retried = await request(
      server,
      "POST",
      "/api/bug/flag",
      { report, events: [] },
      authHeaders,
    );
    expect(retried.status).toBe(200);
    expect(
      fs.existsSync(
        path.join(
          path.dirname(tmpDir),
          "bugs",
          "bug_partial_retry",
          "report.json",
        ),
      ),
    ).toBe(true);
  });

  it("rejects bug reports whose existing bug directory is a symlink", async () => {
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-bug-outside-"),
    );
    const bugsDir = path.join(path.dirname(tmpDir), "bugs");
    fs.mkdirSync(bugsDir, { recursive: true });
    const linkedBugDir = path.join(bugsDir, "bug_linked_dir");
    fs.rmSync(linkedBugDir, { recursive: true, force: true });
    fs.symlinkSync(outsideDir, linkedBugDir, "dir");
    const report = {
      bugId: "bug_linked_dir",
      sessionId: "ses_test",
      flaggedAt: 1000,
      windowMs: 60000,
      url: "http://localhost",
      userAgent: "test",
      summary: {
        errorCount: 0,
        failedRequestCount: 0,
        eventCount: 0,
        eventKinds: {},
        durationMs: 0,
      },
    };

    try {
      const res = await request(
        server,
        "POST",
        "/api/bug/flag",
        { report, events: [] },
        authHeaders,
      );
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: "invalid_artifact_path" });
      expect(fs.existsSync(path.join(outsideDir, "report.json"))).toBe(false);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects bug voice uploads through symlinked evidence artifacts", async () => {
    const report = {
      bugId: "bug_voice_link",
      sessionId: "ses_test",
      flaggedAt: 1000,
      windowMs: 60000,
      url: "http://localhost",
      userAgent: "test",
      summary: {
        errorCount: 0,
        failedRequestCount: 0,
        eventCount: 0,
        eventKinds: {},
        durationMs: 0,
      },
    };
    const outsideFile = path.join(
      os.tmpdir(),
      `crumbtrail-bug-voice-${Date.now()}.webm`,
    );
    fs.writeFileSync(outsideFile, "outside");
    await request(
      server,
      "POST",
      "/api/bug/flag",
      { report, events: [] },
      authHeaders,
    );
    const bugDir = path.join(path.dirname(tmpDir), "bugs", "bug_voice_link");
    fs.rmSync(path.join(bugDir, "voice.webm"), { force: true });
    fs.symlinkSync(outsideFile, path.join(bugDir, "voice.webm"));
    const addr = server.address() as { port: number };

    try {
      const res = await fetch(
        `http://localhost:${addr.port}/api/bug/bug_voice_link/voice`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/octet-stream",
            ...authHeaders,
          },
          body: Buffer.from("voice"),
        },
      );

      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(body).toMatchObject({ code: "invalid_artifact_path" });
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("outside");
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("rejects non-loopback bug evidence reads when remote API is disabled", async () => {
    const bugsRes = await invokeHandler(server, {
      method: "GET",
      url: "/api/bugs",
      remoteAddress: "203.0.113.7",
      headers: { "x-crumbtrail-auth": "test-token" },
    });
    const llmRes = await invokeHandler(server, {
      method: "GET",
      url: "/api/bug/bug_test_1/llm",
      remoteAddress: "203.0.113.7",
      headers: { "x-crumbtrail-auth": "test-token" },
    });

    expect(bugsRes.status).toBe(403);
    expect(bugsRes.body).toMatchObject({ code: "permission_denied" });
    expect(llmRes.status).toBe(403);
    expect(llmRes.body).toMatchObject({ code: "permission_denied" });
  });

  it("returns 404 when voice is uploaded for unknown bug", async () => {
    const addr = server.address() as { port: number };
    const res = await fetch(
      `http://localhost:${addr.port}/api/bug/bug_missing/voice`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", ...authHeaders },
        body: Buffer.from("test"),
      },
    );
    expect(res.status).toBe(404);
  });

  it("rejects cross-origin simple bug voice uploads before accepting raw bytes", async () => {
    const report = {
      bugId: "bug_cross_origin_voice",
      sessionId: "ses_test",
      flaggedAt: 1000,
      windowMs: 60000,
      url: "http://localhost",
      userAgent: "test",
      summary: {
        errorCount: 0,
        failedRequestCount: 0,
        eventCount: 0,
        eventKinds: {},
        durationMs: 0,
      },
    };
    await request(
      server,
      "POST",
      "/api/bug/flag",
      { report, events: [] },
      authHeaders,
    );
    const addr = server.address() as { port: number };
    const res = await fetch(
      `http://localhost:${addr.port}/api/bug/bug_cross_origin_voice/voice`,
      {
        method: "POST",
        headers: {
          Origin: "https://evil.example",
          "Sec-Fetch-Site": "cross-site",
          "Content-Type": "text/plain",
          ...authHeaders,
        },
        body: Buffer.from("voice"),
      },
    );
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body).toMatchObject({ code: "permission_denied" });
    const bugDir = path.join(
      path.dirname(tmpDir),
      "bugs",
      "bug_cross_origin_voice",
    );
    expect(fs.existsSync(path.join(bugDir, "voice.webm"))).toBe(false);
  });
});

describe("server evidence artifact routes", () => {
  let tmpDir: string;
  let server: http.Server;
  const authHeaders = { "X-Crumbtrail-Auth": "test-token" };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-evidence-srv-"));
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns session finalization without waiting for the opted-in AI provider work", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let providerCalled = false;
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      ai: {
        enabled: true,
        apiKey: "key",
        fetchImpl: (async () => {
          providerCalled = true;
          return new Promise<Response>(() => undefined);
        }) as typeof fetch,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_ai_async", metadata: {} },
      authHeaders,
    );
    await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_ai_async",
        events: [
          {
            t: 1000,
            k: "net.req",
            d: { id: "r1", method: "POST", url: "/fail" },
          },
          { t: 1100, k: "net.res", d: { id: "r1", st: 500, dur: 100 } },
        ],
      },
      authHeaders,
    );

    // The provider fetch never resolves, so a finalization that awaited it
    // would never respond at all. The deadline only needs to be finite to
    // catch that regression; it is generous so genuine finalization work
    // under full-suite load never trips it.
    let deadline: NodeJS.Timeout | undefined;
    const res = await Promise.race([
      request(
        server,
        "POST",
        "/api/session/end",
        { sessionId: "ses_ai_async" },
        authHeaders,
      ),
      new Promise<never>((_, reject) => {
        deadline = setTimeout(
          () =>
            reject(
              new Error("session finalization waited for AI provider work"),
            ),
          5_000,
        );
      }),
    ]).finally(() => clearTimeout(deadline));
    expect(res.status).toBe(200);
    expect((res.body as any).processed).toBe(true);
    const providerDeadline = Date.now() + 2_000;
    while (!providerCalled && Date.now() < providerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(providerCalled).toBe(true);
  });

  it("does not schedule duplicate AI diagnosis for repeated finalization requests", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    let providerCalls = 0;
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      ai: {
        enabled: true,
        apiKey: "key",
        fetchImpl: (async () => {
          providerCalls += 1;
          return new Promise<Response>(() => undefined);
        }) as typeof fetch,
      },
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_ai_once", metadata: {} },
      authHeaders,
    );
    await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_ai_once",
        events: [
          {
            t: 1000,
            k: "net.req",
            d: { id: "r1", method: "POST", url: "/fail" },
          },
          { t: 1100, k: "net.res", d: { id: "r1", st: 500, dur: 100 } },
        ],
      },
      authHeaders,
    );

    const first = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId: "ses_ai_once" },
      authHeaders,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId: "ses_ai_once" },
      authHeaders,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(providerCalls).toBe(1);
  });

  it("links candidate artifacts in order and serves nested windows safely", async () => {
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_candidates", metadata: {} },
      authHeaders,
    );
    await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_candidates",
        events: [
          { t: 1000, k: "clk", d: { el: { txt: "Sync now" } } },
          {
            t: 1100,
            k: "net.req",
            d: { id: "r1", method: "POST", url: "/sources/amazon" },
          },
          { t: 1200, k: "net.res", d: { id: "r1", st: 500, dur: 100 } },
        ],
      },
      authHeaders,
    );
    const endRes = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId: "ses_candidates" },
      authHeaders,
    );
    const sessionUrl = (endRes.body as { sessionUrl: string }).sessionUrl;

    const pageRes = await fetch(sessionUrl, { headers: authHeaders });
    const html = await pageRes.text();
    expect(html.indexOf("CANDIDATES.md")).toBeLessThan(
      html.indexOf("timeline.md"),
    );
    expect(html.indexOf("timeline.md")).toBeLessThan(html.indexOf("llm.md"));

    const sessionDir = findSessionDir(tmpDir, "ses_candidates");
    fs.writeFileSync(path.join(sessionDir, "opinion.md"), "# AI Opinion\n");
    fs.writeFileSync(
      path.join(sessionDir, "recording.webm"),
      Buffer.from("video"),
    );

    const pageWithOpinionRes = await fetch(sessionUrl, {
      headers: authHeaders,
    });
    const htmlWithOpinion = await pageWithOpinionRes.text();
    expect(htmlWithOpinion.indexOf("opinion.md")).toBeLessThan(
      htmlWithOpinion.indexOf("CANDIDATES.md"),
    );

    const windowRes = await fetch(`${sessionUrl}/windows/cand_0001.md`, {
      headers: authHeaders,
    });
    expect(windowRes.status).toBe(200);
    expect(await windowRes.text()).toContain("Evidence Window cand_0001");

    const mediaRes = await fetch(`${sessionUrl}/recording.webm`, {
      headers: authHeaders,
    });
    expect(mediaRes.status).toBe(200);
    expect(mediaRes.headers.get("content-type")).toBe("video/webm");

    const traversalRes = await fetch(`${sessionUrl}/windows%2f..%2fmeta.json`, {
      headers: authHeaders,
    });
    expect(traversalRes.status).toBe(404);
  });
});

function writeSession(
  outputDir: string,
  id: string,
  opts: {
    meta?: unknown;
    index?: unknown;
    files?: Record<string, string | Buffer>;
  },
): void {
  const sdir = path.join(outputDir, id);
  fs.mkdirSync(sdir, { recursive: true });
  if (opts.meta !== undefined) {
    fs.writeFileSync(
      path.join(sdir, "meta.json"),
      typeof opts.meta === "string" ? opts.meta : JSON.stringify(opts.meta),
    );
  }
  if (opts.index !== undefined) {
    fs.writeFileSync(
      path.join(sdir, "index.json"),
      typeof opts.index === "string" ? opts.index : JSON.stringify(opts.index),
    );
  }
  for (const [name, content] of Object.entries(opts.files ?? {})) {
    fs.writeFileSync(path.join(sdir, name), content);
  }
}

// Invoke the server's request handler directly with a mock socket so we can simulate a
// non-loopback remote address (real test sockets always connect over loopback).
function invokeHandler(
  server: http.Server,
  reqInit: {
    method: string;
    url: string;
    remoteAddress: string;
    headers?: Record<string, string>;
  },
): Promise<{ status: number; body: unknown }> {
  const listener = server.listeners("request")[0] as (
    req: any,
    res: any,
  ) => unknown;
  return new Promise((resolve, reject) => {
    let status = 0;
    const chunks: string[] = [];
    const req: any = {
      method: reqInit.method,
      url: reqInit.url,
      headers: reqInit.headers ?? {},
      socket: { remoteAddress: reqInit.remoteAddress },
      on() {
        return req;
      },
    };
    const res: any = {
      writeHead(s: number) {
        status = s;
        return res;
      },
      setHeader() {
        return res;
      },
      getHeader() {
        return undefined;
      },
      end(data?: unknown) {
        if (data !== undefined)
          chunks.push(
            Buffer.isBuffer(data) ? data.toString("utf-8") : String(data),
          );
        const text = chunks.join("");
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
        resolve({ status, body: parsed });
      },
    };
    Promise.resolve(listener(req, res)).catch(reject);
  });
}

describe("server GET /api/sessions", () => {
  let tmpDir: string;
  let server: http.Server;
  const authHeaders = { "X-Crumbtrail-Auth": "test-token" };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-sessions-"));
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns typed summaries newest-first and tolerates partial/malformed dirs", async () => {
    writeSession(tmpDir, "ses_old", {
      meta: { id: "ses_old", start: 1000 },
      index: {
        id: "ses_old",
        start: 1000,
        end: 1500,
        dur: 500,
        evts: 3,
        errs: [],
        failedReqs: [{ t: 1100, st: 500 }],
        navs: [{ t: 1000, to: "/home" }],
      },
    });
    writeSession(tmpDir, "ses_new", {
      meta: { id: "ses_new", start: 3000 },
      index: {
        id: "ses_new",
        start: 3000,
        end: 4000,
        dur: 1000,
        evts: 9,
        errs: [{ t: 3100, msg: "TypeError: kaboom" }],
        failedReqs: [],
        navs: [],
      },
      files: {
        "recording.webm": Buffer.from("video-bytes"),
        "opinion.json": JSON.stringify({ ok: true }),
      },
    });
    writeSession(tmpDir, "ses_partial", {
      meta: { id: "ses_partial", start: 2000 },
    });
    writeSession(tmpDir, "ses_bad", { meta: "{ this is not json" });

    const res = await request(
      server,
      "GET",
      "/api/sessions",
      undefined,
      authHeaders,
    );
    expect(res.status).toBe(200);
    const list = res.body as Array<Record<string, any>>;

    // Malformed dir skipped; three valid sessions returned newest-first.
    expect(list.map((s) => s.id)).toEqual([
      "ses_new",
      "ses_partial",
      "ses_old",
    ]);

    const newest = list[0];
    expect(newest).toMatchObject({
      id: "ses_new",
      start: 3000,
      end: 4000,
      dur: 1000,
      evts: 9,
      errors: 1,
      failedReqs: 0,
      topSeverity: "high",
      title: "TypeError: kaboom",
      hasVideo: true,
      hasDiagnosis: true,
    });

    const partial = list[1];
    expect(partial).toMatchObject({
      id: "ses_partial",
      start: 2000,
      errors: 0,
      failedReqs: 0,
      hasVideo: false,
      hasDiagnosis: false,
    });
    expect(partial.topSeverity).toBeUndefined();

    const old = list[2];
    expect(old).toMatchObject({
      id: "ses_old",
      errors: 0,
      failedReqs: 1,
      topSeverity: "medium",
      hasVideo: false,
    });
  });

  it("returns an empty array for an empty store", async () => {
    const res = await request(
      server,
      "GET",
      "/api/sessions",
      undefined,
      authHeaders,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it("rejects /api/sessions without an auth token", async () => {
    const res = await request(server, "GET", "/api/sessions");
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({
      error: "Unauthorized",
      code: "permission_denied",
    });
  });

  it("rejects non-loopback reads when remote API is disabled", async () => {
    const res = await invokeHandler(server, {
      method: "GET",
      url: "/api/sessions",
      remoteAddress: "203.0.113.7",
      headers: { "x-crumbtrail-auth": "test-token" },
    });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: "permission_denied" });
  });

  it("allows non-loopback reads when allowRemoteApi is enabled", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      allowRemoteApi: true,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));

    const res = await invokeHandler(server, {
      method: "GET",
      url: "/api/sessions",
      remoteAddress: "203.0.113.7",
      headers: { "x-crumbtrail-auth": "test-token" },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("server SPA serving", () => {
  let tmpDir: string;
  let staticDir: string;
  let server: http.Server;
  const SPA_HTML = '<!doctype html><div id="root">SPA SHELL</div>';

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-spa-"));
    staticDir = path.join(tmpDir, "dist");
    fs.mkdirSync(staticDir, { recursive: true });
    fs.writeFileSync(path.join(staticDir, "index.html"), SPA_HTML);
    fs.writeFileSync(path.join(staticDir, "app.js"), 'console.log("asset")');
    server = createServer({ port: 0, outputDir: tmpDir, staticDir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  async function get(
    urlPath: string,
  ): Promise<{ status: number; contentType: string | null; text: string }> {
    const addr = server.address() as { port: number };
    const res = await fetch(`http://localhost:${addr.port}${urlPath}`);
    return {
      status: res.status,
      contentType: res.headers.get("content-type"),
      text: await res.text(),
    };
  }

  it("serves the SPA shell for / and /bugs", async () => {
    const root = await get("/");
    expect(root.status).toBe(200);
    expect(root.contentType).toContain("text/html");
    expect(root.text).toContain("SPA SHELL");

    const bugs = await get("/bugs");
    expect(bugs.status).toBe(200);
    expect(bugs.text).toContain("SPA SHELL");
  });

  it("serves real static assets, not the SPA shell", async () => {
    const asset = await get("/app.js");
    expect(asset.status).toBe(200);
    expect(asset.text).toContain("asset");
    expect(asset.text).not.toContain("SPA SHELL");
  });

  it("does not serve files from same-prefix static sibling directories", async () => {
    const siblingDir = path.join(tmpDir, "dist-secret");
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, "config.json"), '{"secret":true}');

    const res = await invokeHandler(server, {
      method: "GET",
      url: "/../dist-secret/config.json",
      remoteAddress: "127.0.0.1",
    });

    expect(res.status).toBe(404);
    expect(String(res.body)).not.toContain("secret");
  });

  it("serves the SPA shell for a bare session route but artifacts for subroutes", async () => {
    writeSession(tmpDir, "ses_spa", {
      meta: { id: "ses_spa", start: 1000 },
      index: { id: "ses_spa", start: 1000, errs: [], failedReqs: [], navs: [] },
    });

    const bare = await get("/sessions/ses_spa");
    expect(bare.status).toBe(200);
    expect(bare.contentType).toContain("text/html");
    expect(bare.text).toContain("SPA SHELL");

    const artifact = await get("/sessions/ses_spa/meta.json");
    expect(artifact.status).toBe(200);
    expect(artifact.contentType).toContain("application/json");
    expect(artifact.text).not.toContain("SPA SHELL");
    expect(JSON.parse(artifact.text)).toMatchObject({ id: "ses_spa" });
  });

  it("404s missing assets and unknown /api routes instead of masking with the SPA shell", async () => {
    const missingAsset = await get("/missing-bundle.js");
    expect(missingAsset.status).toBe(404);
    expect(missingAsset.text).not.toContain("SPA SHELL");

    const unknownApi = await get("/api/does-not-exist");
    expect(unknownApi.status).toBe(404);
    expect(unknownApi.text).not.toContain("SPA SHELL");
  });

  it("keeps the legacy session page when no staticDir/index.html is configured", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    server = createServer({ port: 0, outputDir: tmpDir });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    writeSession(tmpDir, "ses_legacy", {
      meta: { id: "ses_legacy", start: 1000 },
    });

    const bare = await get("/sessions/ses_legacy");
    expect(bare.status).toBe(200);
    expect(bare.text).toContain("Crumbtrail session ses_legacy");
    expect(bare.text).not.toContain("SPA SHELL");
  });
});

describe("server fast finalize", () => {
  let tmpRoot: string;
  let tmpDir: string;
  let server: http.Server;
  const authHeaders = { "X-Crumbtrail-Auth": "test-token" };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-fastfin-srv-"));
    tmpDir = path.join(tmpRoot, "sessions");
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  async function startServer(
    overrides: Partial<Parameters<typeof createServer>[0]>,
  ): Promise<void> {
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      // The idle sweeper is disabled so ONLY the fast-finalize path can
      // finalize sessions in these tests.
      sessionSweep: { enabled: false },
      ...overrides,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
  }

  async function waitFor(
    check: () => boolean,
    timeoutMs = 3_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(check()).toBe(true);
  }

  it("fast-finalizes a session within the debounce window after a severe /api/events ingest", async () => {
    const processedDirs: string[] = [];
    await startServer({
      postProcess: async (sessionDir: string) => {
        processedDirs.push(sessionDir);
        fs.writeFileSync(
          path.join(sessionDir, "index.json"),
          JSON.stringify({ fastFinalized: true }),
        );
      },
      fastFinalize: { debounceMs: 25, cooldownMs: 1_000 },
    });

    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_fastfin", metadata: {} },
      authHeaders,
    );
    const res = await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_fastfin",
        events: [{ t: 1000, k: "err", d: { msg: "boom" } }],
      },
      authHeaders,
    );
    expect(res.status).toBe(200);

    // No /api/session/end and no sweeper: only the fast path can finalize.
    await waitFor(() => {
      try {
        const dir = findSessionDir(tmpDir, "ses_fastfin");
        return (
          JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"))
            .processed === true
        );
      } catch {
        return false;
      }
    });
    expect(processedDirs).toHaveLength(1);
    const sessionDir = findSessionDir(tmpDir, "ses_fastfin");
    expect(fs.existsSync(path.join(sessionDir, "index.json"))).toBe(true);
  });

  it("does not schedule a fast finalize for benign events", async () => {
    let processedCalls = 0;
    await startServer({
      postProcess: async () => {
        processedCalls += 1;
      },
      fastFinalize: { debounceMs: 10, cooldownMs: 100 },
    });

    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_benign", metadata: {} },
      authHeaders,
    );
    const res = await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_benign",
        events: [
          { t: 1000, k: "con", d: { lv: "warn", msg: "deprecated API" } },
          { t: 1100, k: "net.res", d: { id: "r1", st: 404, dur: 5 } },
          { t: 1200, k: "backend.req.end", d: { statusCode: 400 } },
        ],
      },
      authHeaders,
    );
    expect(res.status).toBe(200);

    // Several debounce windows pass without any finalize activity.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(processedCalls).toBe(0);
    const meta = JSON.parse(
      fs.readFileSync(
        path.join(findSessionDir(tmpDir, "ses_benign"), "meta.json"),
        "utf-8",
      ),
    );
    expect(meta.processed).not.toBe(true);
  });

  it("fastFinalize.enabled:false fully disables the fast path", async () => {
    let processedCalls = 0;
    await startServer({
      postProcess: async () => {
        processedCalls += 1;
      },
      fastFinalize: { enabled: false, debounceMs: 10, cooldownMs: 100 },
    });

    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_fastfin_off", metadata: {} },
      authHeaders,
    );
    const res = await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_fastfin_off",
        events: [{ t: 1000, k: "err", d: { msg: "boom" } }],
      },
      authHeaders,
    );
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(processedCalls).toBe(0);
    const meta = JSON.parse(
      fs.readFileSync(
        path.join(findSessionDir(tmpDir, "ses_fastfin_off"), "meta.json"),
        "utf-8",
      ),
    );
    expect(meta.processed).not.toBe(true);
  });

  it("schedules AI diagnosis after a fast finalize when ai.enabled", async () => {
    let providerCalled = false;
    await startServer({
      // Real postProcess: the AI scheduler only calls the provider when
      // candidates exist, so the 5xx below must flow through evidence indexing.
      ai: {
        enabled: true,
        apiKey: "key",
        fetchImpl: (async () => {
          providerCalled = true;
          return new Promise<Response>(() => undefined);
        }) as typeof fetch,
      },
      fastFinalize: { debounceMs: 25, cooldownMs: 1_000 },
    });

    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_fastfin_ai", metadata: {} },
      authHeaders,
    );
    await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_fastfin_ai",
        events: [
          {
            t: 1000,
            k: "net.req",
            d: { id: "r1", method: "POST", url: "/fail" },
          },
          { t: 1100, k: "net.res", d: { id: "r1", st: 500, dur: 100 } },
        ],
      },
      authHeaders,
    );

    // No /api/session/end: the fast finalize must trigger the AI scheduling.
    await waitFor(() => providerCalled, 5_000);
  });

  // --- OTLP ingest path: server.ts threads onIngested into ingestOtelEvents
  // only when the fast-finalizer exists, so severe OTLP spans must fast-
  // finalize their (auto-)session exactly like severe /api/events batches. ---

  function otlpTracePayload(statusCode: number) {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "api" } },
              {
                key: "deployment.environment",
                value: { stringValue: "staging" },
              },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
                  spanId: "00f067aa0ba902b7",
                  name: "POST /checkout",
                  kind: 2,
                  startTimeUnixNano: "1700000000000000000",
                  endTimeUnixNano: "1700000000050000000",
                  // OTLP status code 2 = ERROR, 0 = UNSET.
                  status: { code: statusCode },
                  // No crumbtrail.session.id: the server auto-creates an
                  // `auto.<service>.<env>.<ts>` session for this trace.
                  attributes: [],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  function findAutoSessionDirs(): string[] {
    const found: string[] = [];
    const stack = [tmpDir];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = path.join(dir, entry.name);
        if (
          entry.name.startsWith("auto.") &&
          fs.existsSync(path.join(candidate, "meta.json"))
        ) {
          found.push(candidate);
        }
        stack.push(candidate);
      }
    }
    return found;
  }

  it("fast-finalizes an OTLP auto-session after an ERROR-status span lands on /v1/traces", async () => {
    const processedDirs: string[] = [];
    await startServer({
      postProcess: async (sessionDir: string) => {
        processedDirs.push(sessionDir);
        fs.writeFileSync(
          path.join(sessionDir, "index.json"),
          JSON.stringify({ fastFinalized: true }),
        );
      },
      fastFinalize: { debounceMs: 25, cooldownMs: 1_000 },
    });

    const res = await request(
      server,
      "POST",
      "/v1/traces",
      otlpTracePayload(2),
      authHeaders,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ingested: 1, skipped: 0 });

    // No /api/session/end and no sweeper: only the fast path can finalize.
    await waitFor(() => {
      const [dir] = findAutoSessionDirs();
      if (!dir) return false;
      try {
        return (
          JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"))
            .processed === true
        );
      } catch {
        return false;
      }
    });
    expect(processedDirs).toHaveLength(1);
    const [sessionDir] = findAutoSessionDirs();
    expect(path.basename(sessionDir)).toMatch(/^auto\.api\.staging\.\d+$/);
    expect(fs.existsSync(path.join(sessionDir, "index.json"))).toBe(true);
  });

  it("does not schedule a fast finalize for a benign OTLP trace ingest", async () => {
    let processedCalls = 0;
    await startServer({
      postProcess: async () => {
        processedCalls += 1;
      },
      fastFinalize: { debounceMs: 10, cooldownMs: 100 },
    });

    const res = await request(
      server,
      "POST",
      "/v1/traces",
      otlpTracePayload(0),
      authHeaders,
    );
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, ingested: 1, skipped: 0 });

    // Several debounce windows pass without any finalize activity.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(processedCalls).toBe(0);
    const [sessionDir] = findAutoSessionDirs();
    expect(sessionDir).toBeDefined();
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    expect(meta.processed).not.toBe(true);
  });
});

describe("server onSessionFinalized hook", () => {
  let tmpRoot: string;
  let tmpDir: string;
  let server: http.Server;
  const authHeaders = { "X-Crumbtrail-Auth": "test-token" };

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-hook-srv-"));
    tmpDir = path.join(tmpRoot, "sessions");
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // Both background finalizers are disabled by default so each test enables
  // exactly the finalize path under scrutiny.
  async function startServer(
    overrides: Partial<Parameters<typeof createServer>[0]>,
  ): Promise<void> {
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      authToken: "test-token",
      sessionSweep: { enabled: false },
      fastFinalize: { enabled: false },
      ...overrides,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
  }

  async function waitFor(
    check: () => boolean,
    timeoutMs = 3_000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(check()).toBe(true);
  }

  const writeIndexPostProcess = async (sessionDir: string): Promise<void> => {
    fs.writeFileSync(
      path.join(sessionDir, "index.json"),
      JSON.stringify({ finalized: true }),
    );
  };

  it("fires with refinalized:false when POST /api/session/end finalizes", async () => {
    const calls: Array<{ sessionId: string; refinalized: boolean }> = [];
    await startServer({
      postProcess: writeIndexPostProcess,
      onSessionFinalized: (sessionId, info) =>
        calls.push({ sessionId, refinalized: info.refinalized }),
    });

    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_hook_end", metadata: {} },
      authHeaders,
    );
    expect(calls).toEqual([]);
    const res = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId: "ses_hook_end" },
      authHeaders,
    );
    expect(res.status).toBe(200);
    // The emit happens before the response is written, so it is already
    // observable once the 200 arrives.
    expect(calls).toEqual([{ sessionId: "ses_hook_end", refinalized: false }]);
  });

  it("fires when the idle sweeper finalizes a session", async () => {
    const calls: Array<{ sessionId: string; refinalized: boolean }> = [];
    await startServer({
      postProcess: writeIndexPostProcess,
      sessionSweep: { idleMs: 25, intervalMs: 25 },
      fastFinalize: { enabled: false },
      onSessionFinalized: (sessionId, info) =>
        calls.push({ sessionId, refinalized: info.refinalized }),
    });

    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_hook_sweep", metadata: {} },
      authHeaders,
    );

    // No /api/session/end and no fast finalizer: only the sweep can emit.
    await waitFor(() => calls.some((c) => c.sessionId === "ses_hook_sweep"));
    expect(calls.find((c) => c.sessionId === "ses_hook_sweep")).toEqual({
      sessionId: "ses_hook_sweep",
      refinalized: false,
    });
  });

  it("fires when the fast finalizer finalizes a session after a severe event", async () => {
    const calls: Array<{ sessionId: string; refinalized: boolean }> = [];
    await startServer({
      postProcess: writeIndexPostProcess,
      fastFinalize: { debounceMs: 25, cooldownMs: 1_000 },
      onSessionFinalized: (sessionId, info) =>
        calls.push({ sessionId, refinalized: info.refinalized }),
    });

    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_hook_fast", metadata: {} },
      authHeaders,
    );
    const res = await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_hook_fast",
        events: [{ t: 1000, k: "err", d: { msg: "boom" } }],
      },
      authHeaders,
    );
    expect(res.status).toBe(200);

    // No /api/session/end and no sweeper: only the fast path can emit.
    await waitFor(() => calls.some((c) => c.sessionId === "ses_hook_fast"));
    expect(calls.find((c) => c.sessionId === "ses_hook_fast")).toEqual({
      sessionId: "ses_hook_fast",
      refinalized: false,
    });
  });

  it("a throwing hook never breaks finalization on any path", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await startServer({
      postProcess: writeIndexPostProcess,
      fastFinalize: { debounceMs: 25, cooldownMs: 1_000 },
      onSessionFinalized: () => {
        throw new Error("hook boom");
      },
    });

    // Explicit end path: still 200 and still finalized on disk.
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_hook_throw_end", metadata: {} },
      authHeaders,
    );
    const res = await request(
      server,
      "POST",
      "/api/session/end",
      { sessionId: "ses_hook_throw_end" },
      authHeaders,
    );
    expect(res.status).toBe(200);
    const endDir = findSessionDir(tmpDir, "ses_hook_throw_end");
    expect(fs.existsSync(path.join(endDir, "index.json"))).toBe(true);

    // Background path (fast finalize): still finalizes despite the throw.
    await request(
      server,
      "POST",
      "/api/session/start",
      { sessionId: "ses_hook_throw_fast", metadata: {} },
      authHeaders,
    );
    await request(
      server,
      "POST",
      "/api/events",
      {
        sessionId: "ses_hook_throw_fast",
        events: [{ t: 1000, k: "err", d: { msg: "boom" } }],
      },
      authHeaders,
    );
    await waitFor(() => {
      try {
        const dir = findSessionDir(tmpDir, "ses_hook_throw_fast");
        return (
          JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf-8"))
            .processed === true
        );
      } catch {
        return false;
      }
    });

    // The swallowed throw is logged with the crumbtrail-node prefix.
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "[crumbtrail-node] onSessionFinalized hook failed",
      ),
      expect.any(Error),
    );
  });
});
