import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { SessionManager } from "../session";
import {
  sweepIdleSessions,
  startSessionSweeper,
  computeFinalizeNeed,
} from "../session-sweeper";

const IDLE_MS = 60_000;

function backdate(filePath: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(filePath, when, when);
}

function writeEvents(
  sessionDir: string,
  events: Array<Record<string, unknown>>,
): string {
  const eventsPath = path.join(sessionDir, "events.ndjson");
  fs.writeFileSync(
    eventsPath,
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return eventsPath;
}

function readMeta(sessionDir: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(sessionDir, "meta.json"), "utf-8"),
  );
}

describe("sweepIdleSessions", () => {
  let tmpDir: string;
  let sessions: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-sweeper-"));
    sessions = new SessionManager(tmpDir);
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("finalizes an idle un-finalized session so index.json exists", async () => {
    await sessions.create("auto_idle_1", { app: "svc", capture: "auto" });
    const dir = await sessions.getSessionDir("auto_idle_1");
    const eventsPath = writeEvents(dir, [
      { t: Date.now() - 3 * IDLE_MS, k: "backend.uncaught", d: {} },
    ]);
    backdate(path.join(dir, "meta.json"), 3 * IDLE_MS);
    backdate(eventsPath, 3 * IDLE_MS);

    const result = await sweepIdleSessions({
      sessions,
      outputDir: tmpDir,
      idleMs: IDLE_MS,
    });

    expect(result.finalized).toBe(1);
    expect(result.failed).toBe(0);
    const finalDir = await sessions.getExistingSessionDir("auto_idle_1");
    expect(finalDir).toBeDefined();
    expect(fs.existsSync(path.join(finalDir as string, "index.json"))).toBe(
      true,
    );
    expect(readMeta(finalDir as string).processed).toBe(true);
  });

  it("finalizes an idle session that never received any events", async () => {
    await sessions.create("auto_empty", { app: "svc", capture: "auto" });
    const dir = await sessions.getSessionDir("auto_empty");
    backdate(path.join(dir, "meta.json"), 3 * IDLE_MS);

    const result = await sweepIdleSessions({
      sessions,
      outputDir: tmpDir,
      idleMs: IDLE_MS,
    });

    expect(result.finalized).toBe(1);
    const finalDir = await sessions.getExistingSessionDir("auto_empty") as string;
    expect(fs.existsSync(path.join(finalDir, "index.json"))).toBe(true);
  });

  it("leaves recently-active sessions alone", async () => {
    await sessions.create("auto_active", { app: "svc" });
    // meta.json mtime is "now" — well within the idle window.

    const result = await sweepIdleSessions({
      sessions,
      outputDir: tmpDir,
      idleMs: IDLE_MS,
    });

    expect(result.finalized).toBe(0);
    expect(result.active).toBe(1);
    const dir = await sessions.getSessionDir("auto_active");
    expect(fs.existsSync(path.join(dir, "index.json"))).toBe(false);
  });

  it("re-finalizes a finalized session that received late events", async () => {
    await sessions.create("auto_late", { app: "svc" });
    const stagedDir = await sessions.getSessionDir("auto_late");
    writeEvents(stagedDir, [{ t: Date.now(), k: "backend.uncaught", d: {} }]);
    await sessions.finalize("auto_late");

    const dir = await sessions.getExistingSessionDir("auto_late") as string;
    const before = JSON.parse(
      fs.readFileSync(path.join(dir, "index.json"), "utf-8"),
    );

    // A crash event lands an hour after finalization; both files then go idle.
    const eventsPath = writeEvents(dir, [
      { t: Date.now(), k: "backend.uncaught", d: {} },
      { t: Date.now(), k: "backend.uncaught", d: { late: true } },
    ]);
    backdate(path.join(dir, "meta.json"), 4 * IDLE_MS);
    backdate(eventsPath, 2 * IDLE_MS);

    const result = await sweepIdleSessions({
      sessions,
      outputDir: tmpDir,
      idleMs: IDLE_MS,
    });

    expect(result.refinalized).toBe(1);
    expect(result.finalized).toBe(0);
    const after = JSON.parse(
      fs.readFileSync(path.join(dir, "index.json"), "utf-8"),
    );
    expect(after.evts).toBeGreaterThan(before.evts);
  });

  it("does not re-finalize when events have not changed since finalization", async () => {
    await sessions.create("auto_settled", { app: "svc" });
    const stagedDir = await sessions.getSessionDir("auto_settled");
    writeEvents(stagedDir, [{ t: Date.now(), k: "backend.uncaught", d: {} }]);
    await sessions.finalize("auto_settled");

    const result = await sweepIdleSessions({
      sessions,
      outputDir: tmpDir,
      idleMs: IDLE_MS,
    });

    expect(result.finalized + result.refinalized + result.failed).toBe(0);
  });

  it("caps work per sweep at maxPerSweep", async () => {
    for (const id of ["auto_a", "auto_b", "auto_c"]) {
      await sessions.create(id, { app: "svc" });
      backdate(path.join(await sessions.getSessionDir(id), "meta.json"), 3 * IDLE_MS);
    }

    const result = await sweepIdleSessions({
      sessions,
      outputDir: tmpDir,
      idleMs: IDLE_MS,
      maxPerSweep: 2,
    });

    expect(result.finalized).toBe(2);
  });

  it("skips sessions with corrupt meta.json", async () => {
    await sessions.create("auto_ok", { app: "svc" });
    backdate(
      path.join(await sessions.getSessionDir("auto_ok"), "meta.json"),
      3 * IDLE_MS,
    );
    const corruptDir = path.join(tmpDir, ".sessions", "auto_corrupt");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "meta.json"), "{not json");
    backdate(path.join(corruptDir, "meta.json"), 3 * IDLE_MS);

    const result = await sweepIdleSessions({
      sessions,
      outputDir: tmpDir,
      idleMs: IDLE_MS,
    });

    expect(result.finalized).toBe(1);
    expect(result.failed).toBe(0);
  });

  it("checkpoint-finalizes an active session older than checkpointMs", async () => {
    await sessions.create("auto_longlived", { app: "svc", capture: "auto" });
    const dir = await sessions.getSessionDir("auto_longlived");
    writeEvents(dir, [{ t: Date.now(), k: "backend.uncaught", d: {} }]);
    // Files were touched "just now" — the session is active, never idle.
    // Two checkpoint windows from now, age crosses the line while activity
    // stays inside the idle window.
    const result = await sweepIdleSessions({
      sessions,
      outputDir: tmpDir,
      idleMs: 10 * IDLE_MS,
      checkpointMs: IDLE_MS,
      now: () => Date.now() + 2 * IDLE_MS,
    });

    expect(result.finalized).toBe(1);
    expect(result.active).toBe(0);
    const finalDir = await sessions.getExistingSessionDir("auto_longlived") as string;
    expect(fs.existsSync(path.join(finalDir, "index.json"))).toBe(true);
  });

  it("re-checkpoints an active finalized session once per window", async () => {
    await sessions.create("auto_rechk", { app: "svc" });
    writeEvents(await sessions.getSessionDir("auto_rechk"), [
      { t: Date.now(), k: "backend.uncaught", d: {} },
    ]);
    await sessions.finalize("auto_rechk");
    const dir = await sessions.getExistingSessionDir("auto_rechk") as string;
    const before = JSON.parse(
      fs.readFileSync(path.join(dir, "index.json"), "utf-8"),
    );

    // New events keep landing after the checkpoint; the process is still up.
    backdate(path.join(dir, "meta.json"), 5_000); // clear the 1s epsilon
    writeEvents(dir, [
      { t: Date.now(), k: "backend.uncaught", d: {} },
      { t: Date.now(), k: "backend.uncaught", d: { late: true } },
    ]);

    const sweep = (checkpointMs: number) =>
      sweepIdleSessions({
        sessions,
        outputDir: tmpDir,
        idleMs: 10 * IDLE_MS,
        checkpointMs,
        now: () => Date.now() + 2 * IDLE_MS,
      });

    // Inside the window: active, no thrash.
    const early = await sweep(10 * IDLE_MS);
    expect(early.refinalized).toBe(0);
    expect(early.active).toBe(1);

    // Window elapsed: re-finalized with the late events folded in.
    const due = await sweep(IDLE_MS);
    expect(due.refinalized).toBe(1);
    const after = JSON.parse(
      fs.readFileSync(path.join(dir, "index.json"), "utf-8"),
    );
    expect(after.evts).toBeGreaterThan(before.evts);
  });

  it("invokes onFinalized for each swept session", async () => {
    await sessions.create("auto_hook", { app: "svc" });
    backdate(
      path.join(await sessions.getSessionDir("auto_hook"), "meta.json"),
      3 * IDLE_MS,
    );

    const seen: Array<[string, boolean]> = [];
    await sweepIdleSessions({
      sessions,
      outputDir: tmpDir,
      idleMs: IDLE_MS,
      onFinalized: (id, refinalized) => seen.push([id, refinalized]),
    });

    expect(seen).toEqual([["auto_hook", false]]);
  });
});

describe("computeFinalizeNeed", () => {
  let tmpDir: string;
  let sessions: SessionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-finneed-"));
    sessions = new SessionManager(tmpDir);
  });
  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports needsFinalize for an un-processed session", async () => {
    await sessions.create("need_new", { app: "svc" });
    const need = await computeFinalizeNeed(await sessions.getSessionDir("need_new"));
    expect(need).toMatchObject({
      needsFinalize: true,
      needsRefinalize: false,
    });
  });

  it("reports neither need for a settled finalized session", async () => {
    await sessions.create("need_settled", { app: "svc" });
    writeEvents(await sessions.getSessionDir("need_settled"), [
      { t: Date.now(), k: "backend.uncaught", d: {} },
    ]);
    await sessions.finalize("need_settled");

    const dir = await sessions.getExistingSessionDir("need_settled") as string;
    expect(await computeFinalizeNeed(dir)).toMatchObject({
      needsFinalize: false,
      needsRefinalize: false,
    });
  });

  it("reports needsRefinalize only when events land clearly past the 1s epsilon", async () => {
    await sessions.create("need_late", { app: "svc" });
    writeEvents(await sessions.getSessionDir("need_late"), [
      { t: Date.now(), k: "backend.uncaught", d: {} },
    ]);
    await sessions.finalize("need_late");
    const dir = await sessions.getExistingSessionDir("need_late") as string;

    const metaMtime = fs.statSync(path.join(dir, "meta.json")).mtime;
    const eventsPath = writeEvents(dir, [
      { t: Date.now(), k: "backend.uncaught", d: {} },
      { t: Date.now(), k: "backend.uncaught", d: { late: true } },
    ]);

    // Inside the epsilon guard band: post-process's own rewrite jitter, not
    // genuine late evidence.
    fs.utimesSync(eventsPath, metaMtime, new Date(metaMtime.getTime() + 500));
    expect(await computeFinalizeNeed(dir)).toMatchObject({
      needsFinalize: false,
      needsRefinalize: false,
    });

    // Clearly later than the last finalization: late evidence.
    fs.utimesSync(eventsPath, metaMtime, new Date(metaMtime.getTime() + 1500));
    expect(await computeFinalizeNeed(dir)).toMatchObject({
      needsFinalize: false,
      needsRefinalize: true,
    });
  });

  it("returns undefined for a corrupt meta.json", async () => {
    const corruptDir = path.join(tmpDir, ".sessions", "need_corrupt");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "meta.json"), "{not json");

    expect(await computeFinalizeNeed(corruptDir)).toBeUndefined();
  });
});

describe("startSessionSweeper", () => {
  it("sweepNow sweeps on demand and stop() clears the timer", async () => {
    const tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-sweeper-timer-"),
    );
    try {
      const sessions = new SessionManager(tmpDir);
      await sessions.create("auto_timer", { app: "svc" });
      backdate(
        path.join(await sessions.getSessionDir("auto_timer"), "meta.json"),
        3 * IDLE_MS,
      );

      const sweeps: number[] = [];
      const handle = startSessionSweeper({
        sessions,
        outputDir: tmpDir,
        idleMs: IDLE_MS,
        intervalMs: 60_000,
        onSweep: (r) => sweeps.push(r.finalized),
      });
      const result = await handle.sweepNow();
      handle.stop();

      expect(result.finalized).toBe(1);
      expect(sweeps).toEqual([1]);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
