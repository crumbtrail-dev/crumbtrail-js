import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { resolveLatestIssue } from "../latest-issue";

/**
 * Pins the shared latest-issue definition (backing BOTH the getLatestIssue MCP
 * tool and the `fix-context --latest` CLI flag):
 * - qualifies iff index.json exists (finalize signal) AND errs non-empty OR
 *   failedReqs non-empty OR any candidates.jsonl row with severity critical/high
 * - recency = index.end, fallback index.start, then meta.start; ties -> session
 *   id descending
 * - hot-plane reads only (never events.ndjson)
 */
describe("resolveLatestIssue", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-latest-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function seed(
    sessionId: string,
    opts: {
      meta?: Record<string, unknown>;
      index?: Record<string, unknown> | null;
      candidates?: Array<Record<string, unknown>>;
      eventsNdjson?: string;
    } = {},
  ): string {
    const dir = path.join(tmpDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: sessionId, ...(opts.meta ?? {}) }),
    );
    if (opts.index !== null) {
      fs.writeFileSync(
        path.join(dir, "index.json"),
        JSON.stringify({
          id: sessionId,
          errs: [],
          failedReqs: [],
          ...(opts.index ?? {}),
        }),
      );
    }
    if (opts.candidates) {
      fs.writeFileSync(
        path.join(dir, "candidates.jsonl"),
        opts.candidates.map((c) => JSON.stringify(c)).join("\n") + "\n",
      );
    }
    if (opts.eventsNdjson !== undefined) {
      fs.writeFileSync(path.join(dir, "events.ndjson"), opts.eventsNdjson);
    }
    return dir;
  }

  it("returns undefined for an empty store", async () => {
    expect(await resolveLatestIssue({ outputDir: tmpDir })).toBeUndefined();
    expect(
      await resolveLatestIssue({ outputDir: path.join(tmpDir, "does-not-exist") }),
    ).toBeUndefined();
  });

  it("ignores non-finalized sessions (no index.json), whatever else they contain", async () => {
    seed("ses_live", {
      index: null,
      candidates: [{ id: "cand_0001", severity: "critical" }],
    });
    expect(await resolveLatestIssue({ outputDir: tmpDir })).toBeUndefined();
  });

  it("does not qualify a clean finalized session (no errs, no failedReqs, no high candidates)", async () => {
    seed("ses_clean", {
      index: { end: 9000 },
      candidates: [
        { id: "cand_0001", severity: "medium" },
        { id: "cand_0002", severity: "low" },
      ],
    });
    expect(await resolveLatestIssue({ outputDir: tmpDir })).toBeUndefined();
  });

  it("qualifies via index.errs non-empty", async () => {
    const dir = seed("ses_errs", {
      index: { end: 5000, errs: [{ t: 4000, msg: "boom" }] },
    });
    expect(await resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_errs",
      dir,
    });
  });

  it("qualifies via index.failedReqs non-empty", async () => {
    const dir = seed("ses_failed", {
      index: {
        end: 5000,
        failedReqs: [{ t: 4000, m: "GET", url: "/x", st: 500 }],
      },
    });
    expect(await resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_failed",
      dir,
    });
  });

  it.each(["critical", "high"] as const)(
    "qualifies via a %s-severity candidates.jsonl row",
    async (severity) => {
      const dir = seed("ses_cand", {
        index: { end: 5000 },
        candidates: [
          { id: "cand_0001", severity: "medium" },
          { id: "cand_0002", severity },
        ],
      });
      expect(await resolveLatestIssue({ outputDir: tmpDir })).toEqual({
        sessionId: "ses_cand",
        dir,
      });
    },
  );

  it("orders by index.end recency across qualifying sessions", async () => {
    seed("ses_old", { index: { end: 1000, errs: [{ t: 900, msg: "old" }] } });
    const newest = seed("ses_new", {
      index: { end: 9000, errs: [{ t: 8000, msg: "new" }] },
    });
    seed("ses_mid", { index: { end: 5000, errs: [{ t: 4000, msg: "mid" }] } });
    expect(await resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_new",
      dir: newest,
    });
  });

  it("falls back to index.start, then meta.start, for recency", async () => {
    // No index.end anywhere: a beats b via index.start; c has neither index.end
    // nor index.start and falls back to meta.start (largest of all -> wins).
    seed("ses_a", { index: { start: 5000, errs: [{ t: 1, msg: "a" }] } });
    seed("ses_b", { index: { start: 4000, errs: [{ t: 1, msg: "b" }] } });
    const c = seed("ses_c", {
      meta: { start: 6000 },
      index: { errs: [{ t: 1, msg: "c" }] },
    });
    expect(await resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_c",
      dir: c,
    });
  });

  it("breaks recency ties by session id descending", async () => {
    seed("ses_aaa", { index: { end: 5000, errs: [{ t: 1, msg: "x" }] } });
    const winner = seed("ses_zzz", {
      index: { end: 5000, errs: [{ t: 1, msg: "x" }] },
    });
    seed("ses_mmm", { index: { end: 5000, errs: [{ t: 1, msg: "x" }] } });
    expect(await resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_zzz",
      dir: winner,
    });
  });

  it("reads the hot plane only — a malformed cold event stream is never touched", async () => {
    const dir = seed("ses_hot", {
      index: { end: 5000, errs: [{ t: 1, msg: "x" }] },
      eventsNdjson: "{this is not json\nnor this",
    });
    expect(await resolveLatestIssue({ outputDir: tmpDir })).toEqual({
      sessionId: "ses_hot",
      dir,
    });
  });

  it("skips a session whose index.json is malformed (not finalized cleanly)", async () => {
    const dir = path.join(tmpDir, "ses_bad");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ id: "ses_bad" }),
    );
    fs.writeFileSync(path.join(dir, "index.json"), "{not json");
    expect(await resolveLatestIssue({ outputDir: tmpDir })).toBeUndefined();
  });
});
