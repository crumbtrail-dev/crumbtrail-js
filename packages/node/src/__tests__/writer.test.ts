import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { REDACTED_VALUE } from "crumbtrail-core";
import { appendEvents, writeBlob } from "../writer";

describe("appendEvents", () => {
  let tmpDir: string;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-writer-"));
  });
  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates events.ndjson with one JSON object per line", async () => {
    const events = [
      { t: 1000, k: "con", d: { lv: "log", args: ['"hello"'] } },
      { t: 1001, k: "err", d: { msg: "oops" } },
    ];
    await appendEvents(tmpDir, events);
    const content = fs.readFileSync(
      path.join(tmpDir, "events.ndjson"),
      "utf-8",
    );
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual(events[0]);
    expect(JSON.parse(lines[1])).toEqual(events[1]);
  });

  it("appends to existing file without overwriting", async () => {
    await appendEvents(tmpDir, [{ t: 1, k: "a", d: {} }]);
    await appendEvents(tmpDir, [{ t: 2, k: "b", d: {} }]);
    const content = fs.readFileSync(
      path.join(tmpDir, "events.ndjson"),
      "utf-8",
    );
    const lines = content.trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).k).toBe("a");
    expect(JSON.parse(lines[1]).k).toBe("b");
  });

  it("produces no extra whitespace in JSON", async () => {
    await appendEvents(tmpDir, [{ t: 1, k: "a", d: { key: "value" } }]);
    const content = fs.readFileSync(
      path.join(tmpDir, "events.ndjson"),
      "utf-8",
    );
    const line = content.trim();
    expect(line).not.toContain("  ");
    expect(line).toBe('{"t":1,"k":"a","d":{"key":"value"}}');
  });

  it("redacts secrets before appending events while preserving correlation ids", async () => {
    const secret = "sk_fake_rawappendabcdefghijklmnopqrstuvwxyz";
    await appendEvents(tmpDir, [
      {
        t: 1,
        k: "net.req",
        sessionId: "ses_raw_append",
        d: {
          requestId: "req_123",
          sessionId: "ses_raw_append",
          traceId: "trace_123",
          url: `/api/pay?access_token=${secret}`,
          headers: {
            authorization: `Bearer ${secret}`,
            "x-api-key": secret,
          },
          el: {
            sig: `sig_${secret}`,
            path: `button[data-token="${secret}"]`,
          },
          bodySummary: {
            kind: "json",
            action: "summarized",
            reason: "size_limit",
            originalLength: 4096,
          },
        },
      },
    ]);

    const persisted = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "events.ndjson"), "utf-8"),
    );
    const serialized = JSON.stringify(persisted);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Bearer sk_fake_");
    expect(persisted.sessionId).toBe("ses_raw_append");
    expect(persisted.d.sessionId).toBe("ses_raw_append");
    expect(persisted.d.requestId).toBe("req_123");
    expect(persisted.d.traceId).toBe("trace_123");
    expect(persisted.d.bodySummary).toMatchObject({
      kind: "json",
      action: "summarized",
      reason: "size_limit",
      originalLength: 4096,
    });
    expect(persisted.d.headers.authorization).toBe(REDACTED_VALUE);
    expect(persisted.d.headers["x-api-key"]).toBe(REDACTED_VALUE);
    expect(persisted.d.el.sig).toBe(`sig_${REDACTED_VALUE}`);
    expect(persisted.d.el.path).toBe(`button[data-token="${REDACTED_VALUE}"]`);
  });

  it("stops appending and marks the session when the event byte cap is reached", async () => {
    const first = { t: 1, k: "a", d: { msg: "fits" } };
    const second = {
      t: 2,
      k: "b",
      d: { msg: "this event is dropped once the cap is reached" },
    };
    const third = {
      t: 3,
      k: "c",
      d: { msg: "small but still dropped after truncation starts" },
    };
    const firstLineBytes = Buffer.byteLength(
      `${JSON.stringify(first)}\n`,
      "utf-8",
    );

    const result = await appendEvents(tmpDir, [first, second, third], {
      maxEventBytes: firstLineBytes + 1,
    });
    const followup = await appendEvents(
      tmpDir,
      [{ t: 4, k: "d", d: { msg: "ignored after truncation" } }],
      { maxEventBytes: firstLineBytes + 1000 },
    );

    const content = fs.readFileSync(
      path.join(tmpDir, "events.ndjson"),
      "utf-8",
    );
    const marker = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "capture-truncated.json"), "utf-8"),
    );

    expect(result).toMatchObject({
      accepted: 1,
      dropped: 2,
      truncated: true,
      bytesWritten: firstLineBytes,
    });
    expect(followup).toMatchObject({
      accepted: 0,
      dropped: 1,
      truncated: true,
      bytesWritten: firstLineBytes,
    });
    expect(content.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(content).k).toBe("a");
    expect(marker).toMatchObject({
      truncated: true,
      reason: "session_event_bytes_cap",
      maxEventBytes: firstLineBytes + 1,
      eventsAccepted: 1,
      eventsDropped: 2,
      bytesWritten: firstLineBytes,
    });
  });
});

describe("writeBlob", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-writer-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes binary data to named file in session dir", async () => {
    const data = Buffer.from([0x00, 0x01, 0x02, 0xff]);
    await writeBlob(tmpDir, "recording.webm", data);
    const written = fs.readFileSync(path.join(tmpDir, "recording.webm"));
    expect(Buffer.compare(written, data)).toBe(0);
  });
});
