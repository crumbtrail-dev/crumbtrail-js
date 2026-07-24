import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { postProcess, reanalyzeSession } from "../post-process";
import { readColdEvents } from "../storage-plane";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-reanalyze-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sessionDir(id = "ses_reanalyze"): string {
  const dir = path.join(tmpDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id, start: 1_000 }),
  );
  return dir;
}

function writeEvents(dir: string, events: unknown[]): void {
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

function readIndex(dir: string): {
  errs: Array<{ t: number; msg?: string; stk?: string; url?: string }>;
  evts: number;
  audio?: unknown;
} {
  return JSON.parse(fs.readFileSync(path.join(dir, "index.json"), "utf-8"));
}

function readCandidates(dir: string): Array<{
  detector: string;
  score: number;
  severity: string;
  anchor: { frame?: string };
}> {
  return fs
    .readFileSync(path.join(dir, "candidates.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/**
 * Reproduces the shape of a session finalized by an analyzer that dropped
 * `stk`/`url` from `index.errs`, then re-analyzes it. The cold plane is written
 * by the real finalize, so the replay reads exactly what production stores.
 */
const REJECTION_STACK =
  "TypeError: Failed to fetch\n" +
  "    at VihJ (chrome-extension://bkkbcggnhapdmkeljlodobbkopceiche/injectScriptAdjust.js:1:3159)\n" +
  "    at globalThis.fetch (https://alertbase.ai/_next/static/chunks/vendor-4ec6be8d.js:25:109080)";

describe("reanalyzeSession", () => {
  it("recovers stacks the stored index dropped, without touching the cold plane", async () => {
    const dir = sessionDir();
    writeEvents(dir, [
      { t: 1_000, k: "nav", d: { to: "https://alertbase.ai/dashboard/jobs" } },
      { t: 1_100, k: "rej", d: { msg: "Failed to fetch", stk: REJECTION_STACK } },
    ]);
    await postProcess(dir);

    // Simulate the older analyzer's output: the index on disk kept only t/msg.
    const stored = readIndex(dir);
    stored.errs = stored.errs.map((entry) => ({
      t: entry.t,
      msg: entry.msg,
    }));
    fs.writeFileSync(path.join(dir, "index.json"), JSON.stringify(stored));
    expect(readIndex(dir).errs[0].stk).toBeUndefined();

    // Cold storage is the only surviving copy once a session finalizes.
    fs.rmSync(path.join(dir, "events.ndjson"));
    const coldBefore = fs.readFileSync(path.join(dir, "events.ndjson.zst"));
    const signaturesBefore = fs.readFileSync(path.join(dir, "signatures.json"));

    const result = await reanalyzeSession(dir);

    expect(result).toEqual({ reanalyzed: true, events: 2 });
    expect(readIndex(dir).errs[0].stk).toBe(REJECTION_STACK);
    // The repair must never rewrite the raw evidence it is reading from.
    expect(fs.readFileSync(path.join(dir, "events.ndjson.zst"))).toEqual(
      coldBefore,
    );
    expect(fs.readFileSync(path.join(dir, "signatures.json"))).toEqual(
      signaturesBefore,
    );
    expect(fs.existsSync(path.join(dir, "events.ndjson"))).toBe(false);
  });

  it("restores tracker-beacon downranking that the dropped url disabled", async () => {
    const dir = sessionDir("ses_beacon");
    writeEvents(dir, [
      { t: 1_000, k: "nav", d: { to: "https://alertbase.ai/dashboard/jobs" } },
      {
        t: 1_050,
        k: "net.err",
        d: {
          id: "req-1",
          m: "POST",
          url: "https://www.google-analytics.com/g/collect?v=2",
          msg: "Failed to fetch",
        },
      },
      {
        t: 1_060,
        k: "rej",
        d: {
          msg: "Failed to fetch",
          stk: REJECTION_STACK,
          requestId: "req-1",
          method: "POST",
          url: "https://www.google-analytics.com/g/collect?v=2",
        },
      },
    ]);
    await postProcess(dir);

    const rejection = readCandidates(dir).find(
      (candidate) => candidate.detector === "unhandled_rejection",
    );
    expect(rejection).toBeDefined();
    // A blocked analytics beacon is not an application defect.
    expect(rejection?.severity).toBe("low");

    fs.rmSync(path.join(dir, "events.ndjson"));
    await reanalyzeSession(dir);

    const replayed = readCandidates(dir).find(
      (candidate) => candidate.detector === "unhandled_rejection",
    );
    expect(replayed?.severity).toBe("low");
    expect(replayed?.score).toBe(rejection?.score);
  });

  it("produces the same artifacts the original finalize did", async () => {
    const dir = sessionDir("ses_stable");
    writeEvents(dir, [
      { t: 2_000, k: "nav", d: { to: "https://example.test/app" } },
      { t: 2_100, k: "rej", d: { msg: "Failed to fetch", stk: REJECTION_STACK } },
      {
        t: 2_200,
        k: "clk",
        d: { el: { sig: "btn-save", path: "body>button", tag: "button" } },
      },
    ]);
    await postProcess(dir);
    const before = {
      index: readIndex(dir),
      candidates: readCandidates(dir),
    };

    fs.rmSync(path.join(dir, "events.ndjson"));
    await reanalyzeSession(dir);

    expect(readIndex(dir).evts).toBe(before.index.evts);
    expect(readIndex(dir).errs).toEqual(before.index.errs);
    expect(readCandidates(dir)).toEqual(before.candidates);
  });

  it("reports no work when the session has no cold artifact", async () => {
    const dir = sessionDir("ses_live");
    writeEvents(dir, [{ t: 3_000, k: "nav", d: { to: "https://example.test" } }]);

    expect(await reanalyzeSession(dir)).toEqual({
      reanalyzed: false,
      events: 0,
    });
  });
});

describe("readColdEvents", () => {
  it("expands element signature refs back into the shape detectors match on", async () => {
    const dir = sessionDir("ses_sig");
    writeEvents(dir, [
      {
        t: 4_000,
        k: "clk",
        d: { el: { sig: "btn-pay", path: "body>main>button", tag: "button" } },
      },
    ]);
    await postProcess(dir);

    // The cold copy stores only a numeric ref; signatures.json holds the rest.
    const raw = readColdEvents(dir);
    expect(raw?.[0].d).toMatchObject({
      el: { sig: "btn-pay", path: "body>main>button", tag: "button" },
    });
  });

  it("drops the element rather than leaving a bare ref when signatures are lost", async () => {
    const dir = sessionDir("ses_orphan");
    writeEvents(dir, [
      { t: 5_000, k: "clk", d: { el: { sig: "btn-x", tag: "button" } } },
    ]);
    await postProcess(dir);
    fs.writeFileSync(
      path.join(dir, "signatures.json"),
      JSON.stringify({ schemaVersion: 1, entries: [] }),
    );

    const events = readColdEvents(dir);
    expect(events?.[0].d).not.toHaveProperty("el");
  });
});
