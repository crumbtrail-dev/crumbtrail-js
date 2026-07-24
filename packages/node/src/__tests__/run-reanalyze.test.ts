import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseCommand } from "../commands";
import { postProcess } from "../post-process";
import { runReanalyze } from "../run-reanalyze";

let tmpDir: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-run-reanalyze-"));
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Builds a finalized session at the V2 partition depth the walker must reach. */
async function finalizedSession(id: string): Promise<string> {
  const dir = path.join(tmpDir, "ten_a", "prj_b", "2026-07-24", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ id, start: 1_000 }),
  );
  fs.writeFileSync(
    path.join(dir, "events.ndjson"),
    `${JSON.stringify({ t: 1_000, k: "rej", d: { msg: "Failed to fetch", stk: "TypeError: Failed to fetch\n    at f (https://app.test/a.js:1:2)" } })}\n`,
  );
  await postProcess(dir);
  fs.rmSync(path.join(dir, "events.ndjson"));
  return dir;
}

describe("reanalyze command routing", () => {
  it("routes the subcommand and strips the command word", () => {
    expect(parseCommand(["reanalyze", "ses_1", "--json"])).toEqual({
      command: "reanalyze",
      rest: ["ses_1", "--json"],
    });
  });
});

describe("runReanalyze", () => {
  it("rebuilds every finalized session under the sessions dir", async () => {
    await finalizedSession("ses_one");
    await finalizedSession("ses_two");

    const code = await runReanalyze(["--all", "--output", tmpDir, "--json"]);

    expect(code).toBe(0);
    const report = JSON.parse(stdout);
    expect(report).toHaveLength(2);
    expect(report.map((r: { sessionId: string }) => r.sessionId).sort()).toEqual(
      ["ses_one", "ses_two"],
    );
    expect(
      report.every((r: { status: string }) => r.status === "reanalyzed"),
    ).toBe(true);
  });

  it("writes nothing on a dry run", async () => {
    const dir = await finalizedSession("ses_dry");
    const before = fs.readFileSync(path.join(dir, "index.json"), "utf-8");

    const code = await runReanalyze([
      "--all",
      "--output",
      tmpDir,
      "--dry-run",
    ]);

    expect(code).toBe(0);
    expect(stdout).toContain("Dry run");
    expect(fs.readFileSync(path.join(dir, "index.json"), "utf-8")).toBe(before);
  });

  it("skips a live session that has no cold stream", async () => {
    const dir = path.join(tmpDir, "ses_live");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: "x" }));

    const code = await runReanalyze([dir, "--json"]);

    expect(code).toBe(0);
    expect(JSON.parse(stdout)[0]).toMatchObject({
      status: "skipped",
      reason: "no cold event stream",
    });
  });

  it("requires a target", async () => {
    expect(await runReanalyze([])).toBe(1);
    expect(stderr).toContain("a session id or directory is required");
  });

  it("rejects a session and --all together", async () => {
    expect(await runReanalyze(["ses_1", "--all"])).toBe(1);
    expect(stderr).toContain("not both");
  });
});
