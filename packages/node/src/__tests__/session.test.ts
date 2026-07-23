import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "../session";

function readFileExists(sessionDir: string, name: string): boolean {
  return fs.existsSync(path.join(sessionDir, name));
}

describe("SessionManager", async () => {
  let tmpDir: string;
  let sessions: SessionManager;
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "buglogger-session-"));
    sessions = new SessionManager(tmpDir);
  });
  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates session directory with meta.json and frames/", async () => {
    await sessions.create("ses_test", { app: "myapp" });
    const sessionDir = await sessions.getSessionDir("ses_test");
    expect(fs.existsSync(sessionDir)).toBe(true);
    expect(fs.existsSync(path.join(sessionDir, "frames"))).toBe(true);
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    expect(meta.id).toBe("ses_test");
    expect(meta.app).toBe("myapp");
    expect(meta.start).toBeTypeOf("number");
  });

  it("creates session directories with owner-only permissions on Unix", async () => {
    if (process.platform === "win32") return;

    await sessions.create("ses_private", { app: "myapp" });
    const sessionDir = await sessions.getSessionDir("ses_private");
    const framesDir = path.join(sessionDir, "frames");

    expect(fs.statSync(sessionDir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(framesDir).mode & 0o777).toBe(0o700);
  });

  it("repairs existing session directory permissions on Unix when accessed", async () => {
    if (process.platform === "win32") return;

    await sessions.create("ses_repair_mode", { app: "myapp" });
    const sessionDir = await sessions.getSessionDir("ses_repair_mode");
    fs.chmodSync(sessionDir, 0o755);

    expect(await sessions.getExistingSessionDir("ses_repair_mode")).toBe(sessionDir);
    expect(fs.statSync(sessionDir).mode & 0o777).toBe(0o700);
  });

  it("preserves the original start on a repeat create (reload re-start)", async () => {
    await sessions.create("ses_reload", { app: "myapp" });
    const sessionDir = await sessions.getSessionDir("ses_reload");
    const firstMeta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    const originalStart = firstMeta.start;

    // Simulate an appended event, then a hard-reload re-start with the same session id.
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      JSON.stringify({ t: originalStart + 1, k: "clk", d: {} }) + "\n",
    );
    await new Promise((r) => setTimeout(r, 5));
    await sessions.create("ses_reload", { app: "myapp" });

    const secondMeta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );
    expect(secondMeta.start).toBe(originalStart);
    // The session directory (and any appended events) is preserved across the re-start.
    expect(fs.existsSync(path.join(sessionDir, "events.ndjson"))).toBe(true);
  });

  it("keeps canonical session metadata authoritative over caller metadata", async () => {
    await sessions.create("ses_canonical", {
      id: "spoofed",
      start: 1,
      end: 2,
      app: "myapp",
    });
    const sessionDir = await sessions.getSessionDir("ses_canonical");
    const meta = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
    );

    expect(meta.id).toBe("ses_canonical");
    expect(meta.start).not.toBe(1);
    expect(meta.end).toBeUndefined();
    expect(meta.processed).toBeUndefined();
    expect(meta.finalization).toBeUndefined();
    expect(meta.app).toBe("myapp");
  });

  it("rejects creating over an existing session id", async () => {
    await sessions.create("ses_unique", { app: "first" });

    await expect(sessions.create("ses_unique", { app: "second" })).rejects.toThrow(
      "Session already exists",
    );
    const meta = JSON.parse(
      fs.readFileSync(
        path.join(await sessions.getSessionDir("ses_unique"), "meta.json"),
        "utf-8",
      ),
    );
    expect(meta.app).toBe("first");
  });

  it("getSessionDir returns correct path", async () => {
    expect(await sessions.getSessionDir("ses_abc")).toBe(
      path.join(tmpDir, ".sessions", "ses_abc"),
    );
  });

  it("rejects session ids that resolve to the output root", async () => {
    await expect(sessions.create(".", {})).rejects.toThrow("Invalid sessionId");
    await expect(sessions.getSessionDir("..")).rejects.toThrow("Invalid sessionId");
    expect(fs.existsSync(path.join(tmpDir, "meta.json"))).toBe(false);
  });

  it("finalize preserves mixed page evidence artifacts without leaking raw sensitive values", async () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    await sessions.create("ses_mixed_page", {
      source: "buglogger-extension",
      pageProbe: true,
    });
    const sessionDir = await sessions.getSessionDir("ses_mixed_page");
    const events = [
      {
        t: 1000,
        k: "probe.ready",
        offsetMs: 0,
        sessionId: "ses_mixed_page",
        d: {
          source: "page-probe",
          features: {
            console: true,
            fetch: true,
            xhr: true,
            performance: true,
            storage: true,
          },
        },
      },
      {
        t: 1010,
        k: "frame.ctx",
        offsetMs: 10,
        sessionId: "ses_mixed_page",
        d: {
          source: "content-script",
          pageProbe: { requested: true, started: true, limited: false },
        },
      },
      {
        t: 1020,
        k: "con",
        offsetMs: 20,
        sessionId: "ses_mixed_page",
        d: {
          source: "page-probe",
          lv: "err",
          args: ["checkout failed [REDACTED]"],
        },
      },
      {
        t: 1030,
        k: "err",
        offsetMs: 30,
        sessionId: "ses_mixed_page",
        d: { source: "page-probe", msg: "TypeError: checkout crashed" },
      },
      {
        t: 1040,
        k: "rej",
        offsetMs: 40,
        sessionId: "ses_mixed_page",
        d: { source: "page-probe", msg: "Unhandled rejection: payment failed" },
      },
      {
        t: 1050,
        k: "net.req",
        offsetMs: 50,
        sessionId: "ses_mixed_page",
        d: {
          source: "page-probe",
          id: "fetch-1",
          m: "POST",
          url: "https://api.example.test/pay?token=[REDACTED]",
        },
      },
      {
        t: 1060,
        k: "net.res",
        offsetMs: 60,
        sessionId: "ses_mixed_page",
        d: {
          source: "page-probe",
          id: "fetch-1",
          st: 502,
          bodySummary: {
            kind: "text",
            action: "summarized",
            reason: "network_body",
          },
        },
      },
      {
        t: 1070,
        k: "net.err",
        offsetMs: 70,
        sessionId: "ses_mixed_page",
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
        t: 1080,
        k: "nav",
        offsetMs: 80,
        sessionId: "ses_mixed_page",
        d: {
          source: "page-probe",
          to: "https://app.example.test/checkout?session=[REDACTED]",
          tr: "push",
        },
      },
      {
        t: 1090,
        k: "clk",
        offsetMs: 90,
        sessionId: "ses_mixed_page",
        d: { source: "content-script", el: { tag: "BUTTON", txt: "Pay now" } },
      },
      {
        t: 1100,
        k: "inp",
        offsetMs: 100,
        sessionId: "ses_mixed_page",
        d: { source: "content-script", val: "[REDACTED]" },
      },
      {
        t: 1110,
        k: "perf",
        offsetMs: 110,
        sessionId: "ses_mixed_page",
        d: {
          source: "page-probe",
          metric: "res",
          entryType: "resource",
          name: "https://cdn.example.test/app.js?token=[REDACTED]",
          duration: 34,
        },
      },
      {
        t: 1120,
        k: "snap",
        offsetMs: 120,
        sessionId: "ses_mixed_page",
        d: {
          source: "content-script",
          localStorage: { authToken: "[REDACTED]" },
          sessionStorage: { cart: "[REDACTED]" },
          cookies: { session: "[REDACTED]" },
        },
      },
    ];
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const finalization = await sessions.finalize("ses_mixed_page");
    const finalizedDir = await sessions.getSessionDir("ses_mixed_page");

    expect(finalization).toMatchObject({
      ok: true,
      sessionId: "ses_mixed_page",
      processed: true,
    });
    const eventsText = fs.readFileSync(
      path.join(finalizedDir, "events.ndjson"),
      "utf-8",
    );
    const index = JSON.parse(
      fs.readFileSync(path.join(finalizedDir, "index.json"), "utf-8"),
    );
    const bundle = JSON.parse(
      fs.readFileSync(path.join(finalizedDir, "llm.json"), "utf-8"),
    );
    const markdown = fs.readFileSync(
      path.join(finalizedDir, "llm.md"),
      "utf-8",
    );
    expect(readFileExists(finalizedDir, "timeline.md")).toBe(true);
    expect(readFileExists(finalizedDir, "search.jsonl")).toBe(true);
    expect(eventsText.split("\n").filter(Boolean)).toHaveLength(events.length);
    expect(index.stats).toMatchObject({
      "probe.ready": 1,
      "net.req": 1,
      "net.res": 1,
      "net.err": 1,
      perf: 1,
      snap: 1,
    });
    expect(index.storageSummary).toMatchObject({
      localStorageKeys: 1,
      sessionStorageKeys: 1,
      cookies: 1,
    });
    expect(bundle.eventCounts.perf).toBe(1);
    expect(bundle.keyTimelineMoments).toEqual(
      expect.arrayContaining([expect.objectContaining({ k: "perf" })]),
    );
    expect(
      JSON.stringify(index) + JSON.stringify(bundle) + markdown,
    ).not.toContain(secret);
  });

  it("finalize generates index.json and updates meta.json", async () => {
    await sessions.create("ses_test", {});
    const sessionDir = await sessions.getSessionDir("ses_test");
    const events = [
      { t: 1000, k: "nav", d: { to: "/", from: "", tr: "init" } },
      { t: 1100, k: "err", d: { msg: "oops" } },
    ];
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const finalization = await sessions.finalize("ses_test");
    const finalizedDir = await sessions.getSessionDir("ses_test");
    expect(finalization).toMatchObject({
      ok: true,
      sessionId: "ses_test",
      processed: true,
      degraded: false,
      postProcess: { ok: true },
    });
    expect(fs.existsSync(path.join(finalizedDir, "index.json"))).toBe(true);
    const index = JSON.parse(
      fs.readFileSync(path.join(finalizedDir, "index.json"), "utf-8"),
    );
    expect(index.evts).toBe(2);
    expect(index.errs).toHaveLength(1);
    const meta = JSON.parse(
      fs.readFileSync(path.join(finalizedDir, "meta.json"), "utf-8"),
    );
    expect(meta.end).toBeTypeOf("number");
  });

  it("moves finalized sessions into the v2 tenant/app/date partition path while preserving id lookup", async () => {
    await sessions.create("ses_partitioned", {
      tenant: "Acme Corp",
      app: "Checkout App",
    });
    const liveDir = await sessions.getSessionDir("ses_partitioned");
    const sessionStart = Date.parse("2026-06-30T12:00:00.000Z");
    const meta = JSON.parse(
      fs.readFileSync(path.join(liveDir, "meta.json"), "utf-8"),
    );
    meta.start = sessionStart;
    fs.writeFileSync(
      path.join(liveDir, "meta.json"),
      JSON.stringify(meta, null, 2),
    );
    fs.writeFileSync(
      path.join(liveDir, "events.ndjson"),
      `${JSON.stringify({ t: sessionStart, k: "con", d: { msg: "hello" } })}\n`,
    );

    await sessions.finalize("ses_partitioned");

    const finalizedDir = await sessions.getSessionDir("ses_partitioned");
    expect(finalizedDir).toBe(
      path.join(
        tmpDir,
        "acme-corp",
        "checkout-app",
        "2026-06-30",
        "ses_partitioned",
      ),
    );
    expect(fs.existsSync(liveDir)).toBe(false);
    expect(await sessions.getExistingSessionDir("ses_partitioned")).toBe(
      finalizedDir,
    );
    expect((await sessions.list()).map((s) => s.id)).toContain("ses_partitioned");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(finalizedDir, "manifest.json"), "utf-8"),
    );
    expect(manifest.partition).toMatchObject({
      tenant: "acme-corp",
      app: "checkout-app",
      date: "2026-06-30",
      sessionId: "ses_partitioned",
      path: path.join(
        "acme-corp",
        "checkout-app",
        "2026-06-30",
        "ses_partitioned",
      ),
      appliedToPath: true,
    });
  });

  it("rejects creating over an existing partitioned session id", async () => {
    await sessions.create("ses_partition_conflict", {
      tenant: "Acme",
      app: "Checkout",
    });
    const liveDir = await sessions.getSessionDir("ses_partition_conflict");
    fs.writeFileSync(
      path.join(liveDir, "events.ndjson"),
      `${JSON.stringify({ t: 1, k: "con", d: { msg: "hello" } })}\n`,
    );
    await sessions.finalize("ses_partition_conflict");

    await expect(sessions.create("ses_partition_conflict", { app: "new" })).rejects.toThrow("Session already exists");
    expect(await sessions.getExistingSessionDir("ses_partition_conflict")).toContain(
      path.join("acme", "checkout"),
    );
  });

  it("finalizes under the default partition even when another live session is named local", async () => {
    await sessions.create("local", { app: "flat" });
    await sessions.create("ses_under_local", {});
    const sessionDir = await sessions.getSessionDir("ses_under_local");
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      `${JSON.stringify({ t: 1, k: "con", d: { msg: "hello" } })}\n`,
    );

    await sessions.finalize("ses_under_local");

    expect(await sessions.getExistingSessionDir("ses_under_local")).toContain(
      path.join("local", "unknown-app"),
    );
    expect(await sessions.getExistingSessionDir("ses_under_local")).toContain(
      "ses_under_local",
    );
    expect(await sessions.getExistingSessionDir("local")).toBe(
      path.join(tmpDir, ".sessions", "local"),
    );
  });

  it("finalizes a session named local without moving it into its own descendant", async () => {
    await sessions.create("local", {});
    const sessionDir = await sessions.getSessionDir("local");
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      `${JSON.stringify({ t: 1, k: "con", d: { msg: "hello" } })}\n`,
    );

    await sessions.finalize("local");

    expect(await sessions.getExistingSessionDir("local")).not.toBe(sessionDir);
    expect(await sessions.getExistingSessionDir("local")).toContain(
      path.join("local", "unknown-app"),
    );
  });

  it("falls back for dot-like partition segments", async () => {
    await sessions.create("ses_dot_partition", { tenant: ".", app: ".." });
    const sessionDir = await sessions.getSessionDir("ses_dot_partition");
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      `${JSON.stringify({ t: 1, k: "con", d: { msg: "hello" } })}\n`,
    );

    await sessions.finalize("ses_dot_partition");

    const finalizedDir = await sessions.getSessionDir("ses_dot_partition");
    expect(finalizedDir).toContain(path.join("local", "unknown-app"));
    expect(finalizedDir).not.toContain(`${path.sep}.${path.sep}`);
  });

  it("rejects finalization when generated artifacts are symlinked", async () => {
    await sessions.create("ses_symlink_artifact", {});
    const sessionDir = await sessions.getSessionDir("ses_symlink_artifact");
    const outsideFile = path.join(
      os.tmpdir(),
      `buglogger-session-outside-${Date.now()}.json`,
    );
    fs.writeFileSync(outsideFile, "{}");
    fs.symlinkSync(outsideFile, path.join(sessionDir, "index.json"));

    try {
      await expect(sessions.finalize("ses_symlink_artifact")).rejects.toThrow(
        "Invalid sessionId",
      );
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("{}");
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("rejects finalization when candidate or window artifacts are symlinked", async () => {
    await sessions.create("ses_symlink_candidate_artifact", {});
    const sessionDir = await sessions.getSessionDir("ses_symlink_candidate_artifact");
    const outsideFile = path.join(
      os.tmpdir(),
      `buglogger-session-candidate-${Date.now()}.md`,
    );
    fs.writeFileSync(outsideFile, "outside");
    fs.symlinkSync(outsideFile, path.join(sessionDir, "CANDIDATES.md"));

    try {
      await expect(
        sessions.finalize("ses_symlink_candidate_artifact"),
      ).rejects.toThrow("Invalid sessionId");
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("outside");
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("rejects finalization when existing window artifacts are symlinked", async () => {
    await sessions.create("ses_symlink_window_artifact", {});
    const sessionDir = await sessions.getSessionDir("ses_symlink_window_artifact");
    const windowsDir = path.join(sessionDir, "windows");
    const outsideFile = path.join(
      os.tmpdir(),
      `buglogger-session-window-${Date.now()}.md`,
    );
    fs.mkdirSync(windowsDir);
    fs.writeFileSync(outsideFile, "outside");
    fs.symlinkSync(outsideFile, path.join(windowsDir, "cand_0001.md"));

    try {
      await expect(
        sessions.finalize("ses_symlink_window_artifact"),
      ).rejects.toThrow("Invalid sessionId");
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("outside");
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("finalize writes processed: true after successful post-processing", async () => {
    await sessions.create("ses_processed", {});
    const sessionDir = await sessions.getSessionDir("ses_processed");
    const events = [
      { t: 1000, k: "nav", d: { to: "/", from: "", tr: "init" } },
    ];
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const finalization = await sessions.finalize("ses_processed");
    const finalizedDir = await sessions.getSessionDir("ses_processed");
    const meta = JSON.parse(
      fs.readFileSync(path.join(finalizedDir, "meta.json"), "utf-8"),
    );
    expect(finalization).toMatchObject({
      processed: true,
      degraded: false,
      postProcess: { ok: true },
    });
    expect(meta.processed).toBe(true);
    expect(meta.finalization.processed).toBe(true);
    expect(meta.finalization.degraded).toBe(false);
    expect(meta.end).toBeTypeOf("number");
  });

  it("finalize marks video degraded when media.video errors exist without recording.webm", async () => {
    await sessions.create("ses_video_degraded", {});
    const sessionDir = await sessions.getSessionDir("ses_video_degraded");
    const events = [
      { t: 1000, k: "session.lifecycle", d: { action: "start" } },
      {
        t: 1010,
        k: "media.video",
        d: {
          state: "error",
          code: "invalid_stream_id",
          message: "Chrome tabCapture stream id is invalid or expired",
        },
      },
    ];
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const finalization = await sessions.finalize("ses_video_degraded");
    const finalizedDir = await sessions.getSessionDir("ses_video_degraded");
    const meta = JSON.parse(
      fs.readFileSync(path.join(finalizedDir, "meta.json"), "utf-8"),
    );

    expect(finalization).toMatchObject({
      processed: true,
      degraded: true,
      postProcess: {
        ok: true,
        warnings: [
          {
            capability: "video",
            code: "invalid_stream_id",
            message: "Chrome tabCapture stream id is invalid or expired",
          },
        ],
      },
    });
    expect(meta.finalization).toMatchObject({
      processed: true,
      degraded: true,
      postProcess: {
        warnings: [
          expect.objectContaining({
            capability: "video",
            code: "invalid_stream_id",
          }),
        ],
      },
    });
  });

  it("finalize marks degraded status when post-processing fails", async () => {
    const degradedSessions = new SessionManager({
      outputDir: tmpDir,
      postProcess: async () => {
        throw new Error("index write failed");
      },
    });
    await degradedSessions.create("ses_degraded", {});

    const finalization = await degradedSessions.finalize("ses_degraded");
    const degradedDir = await degradedSessions.getSessionDir("ses_degraded");
    const meta = JSON.parse(
      fs.readFileSync(path.join(degradedDir, "meta.json"), "utf-8"),
    );

    expect(finalization).toMatchObject({
      ok: true,
      sessionId: "ses_degraded",
      processed: false,
      degraded: true,
      postProcess: {
        ok: false,
        error:
          "Post-processing failed; session artifacts were preserved without derived outputs",
      },
    });
    expect(meta.processed).toBe(false);
    expect(meta.finalization).toMatchObject({
      processed: false,
      degraded: true,
      postProcess: {
        ok: false,
        error:
          "Post-processing failed; session artifacts were preserved without derived outputs",
      },
    });
  });

  it("does not persist meta.end until post-processing completes", async () => {
    const observedEndDuringPostProcess: Array<unknown> = [];
    const interceptedSessions = new SessionManager({
      outputDir: tmpDir,
      postProcess: async (sessionDir: string) => {
        const meta = JSON.parse(
          fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
        );
        observedEndDuringPostProcess.push(meta.end);
      },
    });
    await interceptedSessions.create("ses_end_order", {});
    await interceptedSessions.finalize("ses_end_order");

    expect(observedEndDuringPostProcess).toEqual([undefined]);
    const finalizedDir = await interceptedSessions.getSessionDir("ses_end_order");
    const meta = JSON.parse(
      fs.readFileSync(path.join(finalizedDir, "meta.json"), "utf-8"),
    );
    expect(meta.end).toBeTypeOf("number");
    expect(meta.finalization).toMatchObject({ degraded: false });
  });

  it("treats a session directory without meta.json as not found", async () => {
    await sessions.create("ses_missing_meta", {});
    const sessionDir = await sessions.getSessionDir("ses_missing_meta");
    fs.rmSync(path.join(sessionDir, "meta.json"));

    await expect(sessions.finalize("ses_missing_meta")).rejects.toThrow(
      "Session ses_missing_meta: not found",
    );
  });

  it("finalize throws a structured error when meta.json is corrupt JSON", async () => {
    await sessions.create("ses_corrupt_meta", {});
    const sessionDir = await sessions.getSessionDir("ses_corrupt_meta");
    fs.writeFileSync(path.join(sessionDir, "meta.json"), "{ not valid json");

    await expect(sessions.finalize("ses_corrupt_meta")).rejects.toThrow(
      "Session ses_corrupt_meta: meta.json is missing or corrupt",
    );
  });

  it("list returns all sessions", async () => {
    await sessions.create("ses_1", { app: "a" });
    await sessions.create("ses_2", { app: "b" });
    const list = await sessions.list();
    expect(list).toHaveLength(2);
    expect(list.map((s) => s.id).sort()).toEqual(["ses_1", "ses_2"]);
  });

  it("list filters by time range", async () => {
    await sessions.create("ses_1", {});
    await sessions.create("ses_2", {});
    const meta1Path = path.join(await sessions.getSessionDir("ses_1"), "meta.json");
    const meta1 = JSON.parse(fs.readFileSync(meta1Path, "utf-8"));
    meta1.start = 1000;
    fs.writeFileSync(meta1Path, JSON.stringify(meta1));
    const meta2Path = path.join(await sessions.getSessionDir("ses_2"), "meta.json");
    const meta2 = JSON.parse(fs.readFileSync(meta2Path, "utf-8"));
    meta2.start = 2000;
    fs.writeFileSync(meta2Path, JSON.stringify(meta2));
    const result = await sessions.list({ after: 1500 });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("ses_2");
  });

  it("list returns empty array when no sessions exist", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "buglogger-empty-"));
    const emptySessions = new SessionManager(emptyDir);
    expect(await emptySessions.list()).toEqual([]);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it("list ignores symlinked directories pointing outside outputDir", async () => {
    // Create a sibling directory outside outputDir containing a meta.json. If list()
    // followed symlinks naively, this directory would appear in the result and let a
    // caller smuggle arbitrary filesystem content through the sessions API.
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "buglogger-outside-"),
    );
    try {
      fs.writeFileSync(
        path.join(outsideDir, "meta.json"),
        JSON.stringify({ id: "ses_outside", start: 1000, app: "attacker" }),
      );
      // Symlink outsideDir into outputDir under a session-like name.
      fs.symlinkSync(outsideDir, path.join(tmpDir, "ses_symlinked"), "dir");
      // Also create a genuine session so we know list() still works.
      await sessions.create("ses_real", { app: "real" });

      const result = await sessions.list();
      const ids = result.map((s) => s.id).sort();
      expect(ids).toEqual(["ses_real"]);
      expect(ids).not.toContain("ses_outside");
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("rejects direct access to symlinked session directories", async () => {
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "buglogger-outside-direct-"),
    );
    try {
      fs.symlinkSync(outsideDir, path.join(tmpDir, "ses_direct_link"), "dir");
      await expect(sessions.getExistingSessionDir("ses_direct_link")).rejects.toThrow(
        "Invalid sessionId",
      );
      await expect(sessions.create("ses_direct_link", {})).rejects.toThrow(
        "Invalid sessionId",
      );
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("finalize is idempotent: a second call does not re-run postProcess and reports the prior result", async () => {
    let calls = 0;
    const idempotentSessions = new SessionManager({
      outputDir: tmpDir,
      postProcess: async (sessionDir: string) => {
        calls += 1;
        // Emulate the real cold-storage artifact a successful postProcess writes.
        fs.writeFileSync(
          path.join(sessionDir, "events.ndjson.zst"),
          Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
        );
      },
    });
    await idempotentSessions.create("ses_idem", { app: "myapp" });
    const sessionDir = await idempotentSessions.getSessionDir("ses_idem");
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      `${JSON.stringify({ t: 1, k: "con", d: { msg: "hi" } })}\n`,
    );

    const first = await idempotentSessions.finalize("ses_idem");
    const firstDir = await idempotentSessions.getSessionDir("ses_idem");
    const second = await idempotentSessions.finalize("ses_idem");
    const secondDir = await idempotentSessions.getSessionDir("ses_idem");

    // postProcess runs exactly once across both finalize calls.
    expect(calls).toBe(1);
    // moveSessionToV2Partition side effects do not repeat: the partition dir is stable.
    expect(secondDir).toBe(firstDir);
    // The no-op second finalize reports the prior result reconstructed from meta.finalization.
    expect(second).toEqual(first);
  });

  it("finalize preserves raw evidence and drops partial cold artifacts when post-processing throws", async () => {
    const throwingSessions = new SessionManager({
      outputDir: tmpDir,
      postProcess: async (sessionDir: string) => {
        // Write a partial/incomplete cold artifact, THEN fail.
        fs.writeFileSync(
          path.join(sessionDir, "events.ndjson.zst"),
          Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
        );
        throw new Error("compression interrupted");
      },
    });
    await throwingSessions.create("ses_durability", {});
    const sessionDir = await throwingSessions.getSessionDir("ses_durability");
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      `${JSON.stringify({ t: 1, k: "con", d: { msg: "hi" } })}\n`,
    );

    const finalization = await throwingSessions.finalize("ses_durability");
    const finalizedDir = await throwingSessions.getSessionDir("ses_durability");

    expect(finalization).toMatchObject({ processed: false, degraded: true });
    // Raw evidence survives so the cold-storage hiding gate does not strand it.
    expect(fs.existsSync(path.join(finalizedDir, "events.ndjson"))).toBe(true);
    // The partial cold artifact is removed so the hiding gate stays closed.
    expect(fs.existsSync(path.join(finalizedDir, "events.ndjson.zst"))).toBe(
      false,
    );
    // A failed finalize is not marked processed, so it can be retried.
    const meta = JSON.parse(
      fs.readFileSync(path.join(finalizedDir, "meta.json"), "utf-8"),
    );
    expect(meta.processed).not.toBe(true);
  });

  it("finalize retries post-processing after a prior failed finalize and persists success", async () => {
    let attempt = 0;
    const retrySessions = new SessionManager({
      outputDir: tmpDir,
      postProcess: async (sessionDir: string) => {
        attempt += 1;
        if (attempt === 1) {
          fs.writeFileSync(
            path.join(sessionDir, "events.ndjson.zst"),
            Buffer.from([0x28, 0xb5, 0x2f, 0xfd]),
          );
          throw new Error("transient failure");
        }
        // Succeeds on retry.
      },
    });
    await retrySessions.create("ses_retry", {});
    const sessionDir = await retrySessions.getSessionDir("ses_retry");
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      `${JSON.stringify({ t: 1, k: "con", d: { msg: "hi" } })}\n`,
    );

    const first = await retrySessions.finalize("ses_retry");
    expect(first.processed).toBe(false);

    const second = await retrySessions.finalize("ses_retry");
    // The previously-failed finalize must NOT short-circuit; postProcess re-runs.
    expect(attempt).toBe(2);
    expect(second.processed).toBe(true);

    const finalizedDir = await retrySessions.getSessionDir("ses_retry");
    const meta = JSON.parse(
      fs.readFileSync(path.join(finalizedDir, "meta.json"), "utf-8"),
    );
    expect(meta.processed).toBe(true);
  });

  it("truncates and strips non-printable chars from page-influenced video warning messages", async () => {
    await sessions.create("ses_video_malicious", {});
    const sessionDir = await sessions.getSessionDir("ses_video_malicious");
    // Construct a page-controlled message that mixes ANSI escapes, null bytes,
    // non-ASCII, and is well over the 200-char ceiling.
    const malicious =
      "\x1b[31mALERT\x1b[0m ‮ reversed" + " ".repeat(50) + "A".repeat(400);
    const events = [
      { t: 1, k: "session.lifecycle", d: { action: "start" } },
      {
        t: 2,
        k: "media.video",
        d: { state: "error", code: "spoofed_code", message: malicious },
      },
    ];
    fs.writeFileSync(
      path.join(sessionDir, "events.ndjson"),
      events.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );

    const finalization = await sessions.finalize("ses_video_malicious");
    const finalizedDir = await sessions.getSessionDir("ses_video_malicious");
    const warning = finalization.postProcess.warnings?.[0];
    expect(warning?.capability).toBe("video");
    expect(warning?.message).toBeDefined();
    // Truncated.
    expect(warning!.message.length).toBeLessThanOrEqual(200);
    // Non-printable / non-ASCII bytes stripped.
    expect(warning!.message).not.toMatch(/[^\x20-\x7E]/);
    // ANSI control bytes gone.
    expect(warning!.message).not.toContain("\x1b");
    expect(warning!.message).not.toContain(" ");
    // The persisted meta.json carries the sanitized message too.
    const meta = JSON.parse(
      fs.readFileSync(path.join(finalizedDir, "meta.json"), "utf-8"),
    );
    expect(meta.finalization.postProcess.warnings[0].message).toBe(
      warning!.message,
    );
  });
});
