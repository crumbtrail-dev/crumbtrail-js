import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { McpServer } from "../mcp-server";
import {
  FilesystemMcpReadStore,
  RemoteMcpReadStore,
  selectMcpReadStore,
} from "../mcp-read-store";

interface MockRequest {
  method: string | undefined;
  path: string;
  authorization: string | undefined;
}

type SessionResponseMode =
  | "normal"
  | "malformed-json"
  | "unauthorized"
  | "rate-limited"
  | "server-error"
  | "stalled"
  | "oversized";

type ArtifactResponseMode = "normal" | "stalled";

interface MockCloud {
  baseUrl: string;
  requests: MockRequest[];
  stop(): Promise<void>;
}

interface MockCloudOptions {
  sessionResponse?: SessionResponseMode;
  artifactResponse?: ArtifactResponseMode;
}

const SESSION_ID = "sess_fixture";
const TOKEN = "cloud-token";

const events = [
  { t: 1_000, k: "nav", d: { to: "/checkout" } },
  { t: 1_200, k: "err", d: { msg: "remote payment failed" } },
];

const candidate = {
  schemaVersion: 1,
  id: "cand_remote_1",
  detector: "uncaught_error",
  title: "Remote payment failed",
  severity: "high",
  score: 88,
  confidence: "high",
  anchor: { t: 1_200, message: "remote payment failed" },
  evidenceWindow: { start: 1_000, end: 1_500, windowId: "win_remote_1" },
};

const artifacts: Record<string, string> = {
  "meta.json": JSON.stringify({
    id: SESSION_ID,
    app: "remote-shop",
    start: 1_000,
  }),
  "index.json": JSON.stringify({
    id: SESSION_ID,
    start: 1_000,
    end: 1_200,
    dur: 200,
    evts: events.length,
    errs: [{ t: 1_200, msg: "remote payment failed" }],
    stats: { nav: 1, err: 1 },
  }),
  "events.ndjson": `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  "manifest.json": JSON.stringify({
    schemaVersion: 1,
    kind: "crumbtrail.session-manifest",
    session: { id: SESSION_ID, app: "remote-shop", startMs: 1_000 },
    candidates: [{ id: candidate.id }],
  }),
  "candidates.jsonl": `${JSON.stringify(candidate)}\n`,
  "signatures.json": JSON.stringify({
    schemaVersion: 1,
    entries: [{ id: 1, sig: "sig_remote_pay", tag: "button" }],
  }),
  "opinion.json": JSON.stringify({
    schemaVersion: "opinion.v1",
    hypotheses: [
      {
        rank: 1,
        title: "The remote payment request failed",
        confidence: "high",
        evidence_refs: [candidate.id],
      },
    ],
    unknowns: [],
  }),
};

function startMockCloud({
  sessionResponse = "normal",
  artifactResponse = "normal",
}: MockCloudOptions = {}): Promise<MockCloud> {
  const requests: MockRequest[] = [];
  const sockets = new Set<Socket>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "", "http://mock.local");
    requests.push({
      method: req.method,
      path: `${url.pathname}${url.search}`,
      authorization: req.headers.authorization,
    });

    if (url.pathname === "/api/agent/sessions") {
      if (sessionResponse === "unauthorized") {
        res.writeHead(401);
        res.end();
        return;
      }
      if (sessionResponse === "rate-limited") {
        res.writeHead(429);
        res.end();
        return;
      }
      if (sessionResponse === "server-error") {
        res.writeHead(500);
        res.end();
        return;
      }
      if (sessionResponse === "malformed-json") {
        const body = "{not valid JSON";
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        });
        res.end(body);
        return;
      }
      if (sessionResponse === "stalled") {
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"sessions":');
        return;
      }
      if (sessionResponse === "oversized") {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": 16 * 1024 * 1024 + 1,
        });
        res.flushHeaders();
        return;
      }
      const body = JSON.stringify({
        sessions: [
          {
            id: SESSION_ID,
            startedAt: "2026-07-15T12:00:00.000Z",
            finalizedAt: "2026-07-15T12:01:00.000Z",
            completeness: "full",
          },
        ],
        pagination: { limit: 100, offset: 0, total: 1 },
      });
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      });
      res.end(body);
      return;
    }

    const prefix = `/api/agent/sessions/${SESSION_ID}/artifacts/`;
    if (url.pathname.startsWith(prefix)) {
      const name = decodeURIComponent(url.pathname.slice(prefix.length));
      const artifact = artifacts[name];
      if (artifact === undefined) {
        res.writeHead(404);
        res.end();
        return;
      }
      if (artifactResponse === "stalled" && name === "index.json") {
        // The real agent router answers GET only, so the mock has no HEAD
        // branch: the stat and the read both take this stalled GET path.
        res.writeHead(200, { "content-type": "application/json" });
        res.write('{"id":');
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(artifact),
      });
      res.end(artifact);
      return;
    }

    res.writeHead(404);
    res.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("mock cloud did not bind a port"));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        requests,
        stop: () =>
          new Promise<void>((resolveStop, rejectStop) =>
            {
              for (const socket of sockets) socket.destroy();
              server.close((error) =>
                error ? rejectStop(error) : resolveStop(),
              );
            },
          ),
      });
    });
  });
}

async function callTool(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
) {
  const response = await server.handleMessage({
    jsonrpc: "2.0",
    id: name,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const result = response!.result as {
    content: Array<{ text: string }>;
    isError?: boolean;
  };
  expect(result.isError).toBeUndefined();
  return JSON.parse(result.content[0].text);
}

describe("MCP remote read store", () => {
  let mock: MockCloud | undefined;
  let tmpDir: string | undefined;

  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it("reads the acceptance chain from remote session artifacts", async () => {
    mock = await startMockCloud();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-remote-"));
    const server = new McpServer({
      outputDir: path.join(tmpDir, "sessions"),
      readStore: new RemoteMcpReadStore({
        baseUrl: mock.baseUrl,
        token: TOKEN,
      }),
    });

    const sessions = await callTool(server, "listSessions", {});
    expect(sessions).toEqual([
      expect.objectContaining({ id: SESSION_ID, app: "remote-shop" }),
    ]);

    const index = await callTool(server, "getIndex", { sessionId: SESSION_ID });
    expect(index).toMatchObject({ id: SESSION_ID, evts: events.length });

    const manifest = await callTool(server, "getSessionManifest", {
      sessionId: SESSION_ID,
    });
    expect(manifest.session).toMatchObject({ id: SESSION_ID });

    const fixContext = await callTool(server, "getFixContext", {
      sessionId: SESSION_ID,
    });
    expect(fixContext.session.id).toBe(SESSION_ID);
    expect(fixContext.signals[0]).toMatchObject({
      id: candidate.id,
      detector: candidate.detector,
      severity: candidate.severity,
      baseScore: candidate.score,
    });
    expect(fixContext.repro_hint).toMatchObject({
      title: candidate.title,
      message: candidate.anchor.message,
    });

    const window = await callTool(server, "getWindow", {
      sessionId: SESSION_ID,
      t0: 1_000,
      t1: 1_200,
    });
    expect(window.events).toEqual(events);

    const fetchedEvents = await callTool(server, "getEvents", {
      sessionId: SESSION_ID,
    });
    expect(fetchedEvents).toEqual(events);

    const evidenceStart = mock.requests.length;
    const evidence = await callTool(server, "getEvidence", {
      sessionId: SESSION_ID,
      ref: candidate.id,
    });
    expect(evidence).toMatchObject({
      kind: "candidate",
      ref: candidate.id,
      candidate: expect.objectContaining({
        id: candidate.id,
        title: candidate.title,
      }),
      anchor: expect.objectContaining({ message: candidate.anchor.message }),
    });
    expect(mock.requests.slice(evidenceStart)).toEqual([
      expect.objectContaining({
        method: "GET",
        path: `/api/agent/sessions/${SESSION_ID}/artifacts/candidates.jsonl`,
      }),
    ]);

    const opinionStart = mock.requests.length;
    const opinion = await callTool(server, "getOpinion", {
      sessionId: SESSION_ID,
    });
    expect(opinion.hypotheses[0]).toMatchObject({
      title: "The remote payment request failed",
    });
    expect(mock.requests.slice(opinionStart)).toEqual([
      expect.objectContaining({
        method: "GET",
        path: `/api/agent/sessions/${SESSION_ID}/artifacts/opinion.json`,
      }),
    ]);

    expect(mock.requests.length).toBeGreaterThan(0);
    expect(
      mock.requests.every(
        (request) => request.authorization === `Bearer ${TOKEN}`,
      ),
    ).toBe(true);
    expect(
      mock.requests.some((request) =>
        request.path.endsWith("/artifacts/candidates.jsonl"),
      ),
    ).toBe(true);
    expect(
      mock.requests.some((request) =>
        request.path.endsWith("/artifacts/candidates.json"),
      ),
    ).toBe(false);
    // The agent router rejects every non-GET method at entry, so the artifact
    // stat must go out as a GET and no HEAD may ever be attempted.
    expect(
      mock.requests.some(
        (request) =>
          request.method === "GET" &&
          request.path.endsWith("/artifacts/index.json"),
      ),
    ).toBe(true);
    expect(
      mock.requests.some((request) => request.method === "HEAD"),
    ).toBe(false);
  });

  it("returns an empty list when the session response body stalls", async () => {
    mock = await startMockCloud({ sessionResponse: "stalled" });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-remote-"));
    const server = new McpServer({
      outputDir: path.join(tmpDir, "sessions"),
      readStore: new RemoteMcpReadStore({
        baseUrl: mock.baseUrl,
        token: TOKEN,
        timeoutMs: 25,
      }),
    });

    await expect(callTool(server, "listSessions", {})).resolves.toEqual([]);
  });

  it("returns an empty list when the session response is malformed JSON", async () => {
    mock = await startMockCloud({ sessionResponse: "malformed-json" });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-remote-"));
    const server = new McpServer({
      outputDir: path.join(tmpDir, "sessions"),
      readStore: new RemoteMcpReadStore({
        baseUrl: mock.baseUrl,
        token: TOKEN,
      }),
    });

    await expect(callTool(server, "listSessions", {})).resolves.toEqual([]);
  });

  it.each([
    ["401 unauthorized", "unauthorized"],
    ["429 rate limited", "rate-limited"],
    ["500 server error", "server-error"],
  ] as const)("returns an empty list on %s", async (_label, sessionResponse) => {
    mock = await startMockCloud({ sessionResponse });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-mcp-remote-"));
    const server = new McpServer({
      outputDir: path.join(tmpDir, "sessions"),
      readStore: new RemoteMcpReadStore({
        baseUrl: mock.baseUrl,
        token: TOKEN,
      }),
    });

    await expect(callTool(server, "listSessions", {})).resolves.toEqual([]);
  });

  it("times out stalled artifact reads and the stat fallback", async () => {
    mock = await startMockCloud({ artifactResponse: "stalled" });
    const timeoutMs = 25;
    const store = new RemoteMcpReadStore({
      baseUrl: mock.baseUrl,
      token: TOKEN,
      timeoutMs,
    });

    await expect(store.readArtifact(SESSION_ID, "index.json")).resolves.toBeUndefined();

    // The stalled response carries no content-length, so the stat probe falls
    // through to the bounded byteLength read, which can only end at the
    // deadline. Asserting the elapsed time keeps this from passing vacuously:
    // a stat that gave up early (or never issued the fallback) would return
    // undefined too, but would not have waited out the timeout.
    mock.requests.length = 0;
    const startedAt = Date.now();
    await expect(store.statArtifact(SESSION_ID, "index.json")).resolves.toBeUndefined();
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(timeoutMs);

    const statRequests = mock.requests.filter((request) =>
      request.path.endsWith("/artifacts/index.json"),
    );
    expect(statRequests.length).toBe(2);
    expect(statRequests.every((request) => request.method === "GET")).toBe(true);
  });

  it("rejects an advertised oversized body without waiting for it", async () => {
    mock = await startMockCloud({ sessionResponse: "oversized" });
    const store = new RemoteMcpReadStore({
      baseUrl: mock.baseUrl,
      token: TOKEN,
      timeoutMs: 25,
    });

    await expect(store.listSessions()).resolves.toEqual([]);
  });

  it("selects the remote store only when both cloud environment variables are set", () => {
    const previousUrl = process.env.CRUMBTRAIL_CLOUD_URL;
    const previousToken = process.env.CRUMBTRAIL_CLOUD_TOKEN;
    const outputDir = path.join(
      os.tmpdir(),
      "crumbtrail-mcp-read-store-select",
    );
    try {
      delete process.env.CRUMBTRAIL_CLOUD_URL;
      delete process.env.CRUMBTRAIL_CLOUD_TOKEN;
      expect(selectMcpReadStore(outputDir)).toBeInstanceOf(
        FilesystemMcpReadStore,
      );

      process.env.CRUMBTRAIL_CLOUD_URL = "https://cloud.crumbtrail.test/";
      process.env.CRUMBTRAIL_CLOUD_TOKEN = TOKEN;
      expect(selectMcpReadStore(outputDir)).toBeInstanceOf(RemoteMcpReadStore);
    } finally {
      if (previousUrl === undefined) delete process.env.CRUMBTRAIL_CLOUD_URL;
      else process.env.CRUMBTRAIL_CLOUD_URL = previousUrl;
      if (previousToken === undefined)
        delete process.env.CRUMBTRAIL_CLOUD_TOKEN;
      else process.env.CRUMBTRAIL_CLOUD_TOKEN = previousToken;
    }
  });
});
