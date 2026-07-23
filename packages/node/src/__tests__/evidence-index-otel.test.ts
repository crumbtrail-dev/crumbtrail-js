import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BugEvent } from "crumbtrail-core";
import { buildEvidenceCandidates, writeEvidenceIndex } from "../evidence-index";

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("buildEvidenceCandidates — OTel sources", () => {
  it("ranks an OTLP error span (status=ERROR) as a high-severity candidate", async () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "backend.otel.span",
        d: {
          traceId: "abc",
          spanId: "span1",
          name: "POST /checkout",
          serviceName: "api",
          statusCode: "ERROR",
          statusMessage: "boom",
          requestId: "abc",
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].detector).toBe("otel_span_error");
    expect(candidates[0].severity).toBe("high");
    expect(candidates[0].anchor.requestId).toBe("abc");
    expect(candidates[0].anchor.t).toBe(1000);
  });

  it("ranks an OTLP server span with http status >= 500 even when status code is UNSET", async () => {
    const events: BugEvent[] = [
      {
        t: 2000,
        k: "backend.otel.span",
        d: {
          name: "GET /x",
          serviceName: "api",
          statusCode: "UNSET",
          attributes: { "http.response.status_code": 503 },
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, {});
    expect(candidates).toHaveLength(1);
    expect(candidates[0].detector).toBe("otel_span_error");
    expect(candidates[0].anchor.status).toBe(503);
  });

  it("ranks an OTLP ERROR/FATAL log and ignores INFO logs", async () => {
    const events: BugEvent[] = [
      {
        t: 3000,
        k: "backend.otel.log",
        d: {
          severityText: "ERROR",
          severityNumber: 17,
          body: "db connection refused",
          serviceName: "api",
          traceId: "def",
        },
      },
      {
        t: 3100,
        k: "backend.otel.log",
        d: {
          severityText: "INFO",
          severityNumber: 9,
          body: "ok",
          serviceName: "api",
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, {});
    expect(candidates).toHaveLength(1);
    expect(candidates[0].detector).toBe("otel_log_error");
    expect(candidates[0].anchor.message).toContain("db connection refused");
  });

  it("does not invent candidates for OK spans (no false positives)", async () => {
    const events: BugEvent[] = [
      {
        t: 4000,
        k: "backend.otel.span",
        d: {
          name: "GET /ok",
          statusCode: "OK",
          attributes: { "http.response.status_code": 200 },
        },
      },
    ];
    expect(buildEvidenceCandidates(events, {})).toHaveLength(0);
  });

  it("surfaces OTel db span statements as activity evidence near an error", async () => {
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "backend.otel.span",
        d: {
          traceId: "trace-db",
          spanId: "db1",
          name: "SELECT orders",
          serviceName: "api",
          statusCode: "OK",
          attributes: {
            "db.system": "postgresql",
            "db.operation": "SELECT",
            "db.statement": "select * from orders where id = $1",
          },
        },
      },
      {
        t: 1100,
        k: "backend.otel.span",
        d: {
          traceId: "trace-db",
          spanId: "err1",
          name: "GET /orders",
          serviceName: "api",
          statusCode: "ERROR",
        },
      },
    ];
    const candidates = buildEvidenceCandidates(events, { start: 1000 });
    const db = candidates.find(
      (candidate) => candidate.detector === "otel_db_activity",
    );
    expect(db).toBeDefined();
    expect(db?.severity).toBe("high");
    expect(db?.anchor.requestId).toBe("trace-db");
    expect(db?.anchor.source).toContain("statements, not row diffs");
  });

  it("writes a non-empty candidate index for an OTLP-only session", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bl-otel-idx-"));
    tmpDirs.push(dir);
    await writeEvidenceIndex({
      sessionDir: dir,
      events: [
        {
          t: 1000,
          k: "backend.otel.span",
          d: {
            traceId: "abc",
            spanId: "s1",
            name: "POST /checkout",
            serviceName: "api",
            statusCode: "ERROR",
          },
        },
      ],
      index: { start: 1000 },
    });
    const jsonl = fs
      .readFileSync(path.join(dir, "candidates.jsonl"), "utf-8")
      .trim();
    expect(jsonl).toContain('"detector":"otel_span_error"');
    const md = fs.readFileSync(path.join(dir, "CANDIDATES.md"), "utf-8");
    expect(md).not.toContain("No deterministic issue candidates were detected");
  });
});
