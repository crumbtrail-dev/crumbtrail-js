import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../server";
import type { BugEvent } from "crumbtrail-core";

let server: http.Server;
let tmpRoot: string;
let outputDir: string;
const AUTH_TOKEN = "inner-solve-token";

function checkoutEvents(status = 500): BugEvent[] {
  return [
    {
      t: 1000,
      k: "clk",
      d: { el: { sig: "checkout-submit", txt: "Place order" } },
    },
    {
      t: 1100,
      k: "net.req",
      d: { id: "r1", requestId: "req-1", method: "POST", url: "/api/checkout" },
    },
    {
      t: 1200,
      k: "net.res",
      d: { id: "r1", requestId: "req-1", st: status, body: { ok: false } },
    },
  ] as unknown as BugEvent[];
}

/** Seed a finalized session dir with an llm.json carrying distinctBugs — the
 *  field the locate/recall store reads. */
function seedLocatedSession(
  name: string,
  distinctBugs: unknown[],
  metadata: Record<string, unknown> = {},
): void {
  const dir = path.join(outputDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ sessionId: name, ...metadata }),
  );
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    checkoutEvents(500)
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );
  fs.writeFileSync(
    path.join(dir, "llm.json"),
    JSON.stringify({ distinctBugs }),
  );
}

const matchingBug = {
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
};

async function post(
  urlPath: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: any }> {
  const addr = server.address() as { port: number };
  const res = await fetch(`http://127.0.0.1:${addr.port}${urlPath}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* leave as text */
  }
  return { status: res.status, json: parsed };
}

beforeEach(async () => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-inner-solve-"));
  outputDir = path.join(tmpRoot, "sessions");
  fs.mkdirSync(outputDir, { recursive: true });
  server = createServer({ port: 0, outputDir, authToken: AUTH_TOKEN });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("POST /api/solve-context — auth", () => {
  const symptom = { title: "checkout failed span error" };

  it("rejects a request with no auth token (401)", async () => {
    const res = await post("/api/solve-context", { symptom });
    expect(res.status).toBe(401);
  });

  it("rejects a request with the wrong auth token (401)", async () => {
    const res = await post(
      "/api/solve-context",
      { symptom },
      { "X-Crumbtrail-Auth": "not-the-token" },
    );
    expect(res.status).toBe(401);
  });

  it("accepts a request with the correct auth token", async () => {
    const res = await post(
      "/api/solve-context",
      { symptom },
      { "X-Crumbtrail-Auth": AUTH_TOKEN },
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/solve-context — envelope", () => {
  const auth = { "X-Crumbtrail-Auth": AUTH_TOKEN };

  it("returns a matched envelope with populated evidence and a sessionId", async () => {
    seedLocatedSession("sess-incident", [matchingBug]);

    const res = await post(
      "/api/solve-context",
      {
        symptom: {
          title: "checkout failed span error",
          url: "/api/checkout",
          errorSig: "otel_span_error",
        },
      },
      auth,
    );

    expect(res.status).toBe(200);
    expect(res.json.match.outcome).toBe("matched");
    expect(res.json.match.sessionId).toBe("sess-incident");
    expect(res.json.match.confidence).toBeGreaterThan(0);
    expect(res.json.bundle.schemaVersion).toBe("fusion.v1");
    expect(res.json.bundle.evidence.length).toBeGreaterThan(0);
    expect(res.json.bundle.evidence[0].ref.sessionId).toBe("sess-incident");
  });

  it("returns an inconclusive envelope with no sessionId and empty evidence", async () => {
    // Store has no session that rhymes with this symptom.
    seedLocatedSession("sess-unrelated", [
      {
        ...matchingBug,
        bugId: "bug-dash",
        title: "Dashboard render timeout",
        representative: {
          ...matchingBug.representative,
          title: "Dashboard render timeout",
          message: "dashboard widget render timeout",
          route: "/dashboard",
        },
      },
    ]);

    const res = await post(
      "/api/solve-context",
      { symptom: { title: "checkout failed span error" } },
      auth,
    );

    expect(res.status).toBe(200);
    expect(res.json.match.outcome).toBe("inconclusive");
    expect("sessionId" in res.json.match).toBe(false);
    expect(res.json.bundle.evidence).toEqual([]);
    expect(res.json.bundle.gaps.length).toBeGreaterThan(0);
  });

  it("returns an ambiguous envelope with candidates and no cited session", async () => {
    seedLocatedSession("session-one", [matchingBug]);
    seedLocatedSession("session-two", [matchingBug]);

    const res = await post(
      "/api/solve-context",
      {
        symptom: {
          title: "checkout failed span error",
          url: "/api/checkout",
          errorSig: "otel_span_error",
        },
      },
      auth,
    );

    expect(res.status).toBe(200);
    expect(res.json.match.outcome).toBe("ambiguous");
    expect("sessionId" in res.json.match).toBe(false);
    expect(res.json.match.candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: "session-one" }),
        expect.objectContaining({ sessionId: "session-two" }),
      ]),
    );
    expect(res.json.bundle.evidence).toEqual([]);
    expect(res.json.bundle.located.outcome).toBe("ambiguous");
    expect(res.json.bundle.located.sessionId).toBeUndefined();
  });

  it("passes a configured decision margin through to location", async () => {
    seedLocatedSession("session-one", [matchingBug]);
    seedLocatedSession("session-two", [matchingBug]);

    const res = await post(
      "/api/solve-context",
      {
        symptom: {
          title: "checkout failed span error",
          url: "/api/checkout",
          errorSig: "otel_span_error",
        },
        options: { margin: 0 },
      },
      auth,
    );

    expect(res.status).toBe(200);
    expect(res.json.match.outcome).toBe("matched");
    expect(res.json.match.sessionId).toBeDefined();
  });

  it("passes accountId through to the locate engine", async () => {
    seedLocatedSession("session-foreign", [matchingBug], {
      accountId: "account-foreign",
    });
    seedLocatedSession("session-target", [matchingBug], {
      accountId: "account-target",
    });

    const res = await post(
      "/api/solve-context",
      {
        symptom: {
          title: "checkout failed span error",
          url: "/api/checkout",
          errorSig: "otel_span_error",
        },
        options: { accountId: "account-target" },
      },
      auth,
    );

    expect(res.status).toBe(200);
    expect(res.json.match).toMatchObject({
      outcome: "matched",
      sessionId: "session-target",
    });
  });

  it("rejects a body without a symptom title (400)", async () => {
    const res = await post("/api/solve-context", { symptom: {} }, auth);
    expect(res.status).toBe(400);
    expect(res.json.code).toBe("invalid_symptom");
  });
});
