import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { postProcess } from "../post-process";
import { inspectSession, formatInspection, InspectError } from "../inspect";
import { runInspect } from "../run-inspect";

const SESSION_ID = "ses_inspect";

const EVENTS = [
  {
    t: 1000,
    k: "session.lifecycle",
    offsetMs: 0,
    d: { action: "start", reason: "user" },
  },
  { t: 1100, k: "clk", offsetMs: 100, d: { el: { txt: "Checkout" } } },
  {
    t: 1150,
    k: "net.req",
    offsetMs: 150,
    d: {
      id: "r1",
      requestId: "req-1",
      sessionId: SESSION_ID,
      m: "POST",
      url: "https://app.test/api/checkout",
    },
  },
  {
    t: 1520,
    k: "net.res",
    offsetMs: 520,
    d: {
      id: "r1",
      requestId: "req-1",
      sessionId: SESSION_ID,
      st: 500,
      dur: 370,
    },
  },
  {
    t: 1600,
    k: "session.lifecycle",
    offsetMs: 600,
    d: { action: "stop", reason: "user" },
  },
];

async function seedSession(outputDir: string): Promise<string> {
  const sessionDir = path.join(outputDir, SESSION_ID);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, "meta.json"),
    JSON.stringify({ id: SESSION_ID, app: "shop", start: 1000 }),
  );
  fs.writeFileSync(
    path.join(sessionDir, "events.ndjson"),
    EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  await postProcess(sessionDir);
  return sessionDir;
}

describe("inspectSession", async () => {
  let tmpDir: string;
  let sessionDir: string;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-inspect-"));
    sessionDir = await seedSession(tmpDir);
  });

  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("summarizes the session from the manifest with core counts", async () => {
    const summary = await inspectSession(sessionDir);
    expect(summary.id).toBe(SESSION_ID);
    expect(summary.source).toBe("manifest");
    expect(summary.durationMs).toBe(600);
    expect(summary.eventCount).toBeGreaterThan(0);
    expect(summary.failedRequestCount).toBeGreaterThanOrEqual(1);
    expect(summary.truncated).toBe(false);
    expect(typeof summary.candidateCount).toBe("number");
  });

  it("lists artifacts present on disk with byte sizes and never the raw events.ndjson", async () => {
    const summary = await inspectSession(sessionDir);
    expect(summary.artifacts.length).toBeGreaterThan(0);
    const names = summary.artifacts.map((a) => a.name);
    expect(names).toContain("manifest.json");
    expect(names).not.toContain("events.ndjson");
    for (const artifact of summary.artifacts) {
      expect(artifact.bytes).toBeGreaterThanOrEqual(0);
      expect(fs.existsSync(path.join(sessionDir, artifact.name))).toBe(true);
    }
  });

  it("falls back to index.json when no manifest is present", async () => {
    fs.rmSync(path.join(sessionDir, "manifest.json"));
    const summary = await inspectSession(sessionDir);
    expect(summary.source).toBe("index");
    expect(summary.id).toBe(SESSION_ID);
    expect(summary.eventCount).toBeGreaterThan(0);
    expect(summary.artifacts.map((a) => a.name)).not.toContain("events.ndjson");
  });

  it("resolves a bare session id against outputDir", async () => {
    const summary = await inspectSession(SESSION_ID, { outputDir: tmpDir });
    expect(summary.id).toBe(SESSION_ID);
  });

  it("throws InspectError when neither manifest nor index exists", async () => {
    await expect(
      inspectSession("nope", { outputDir: tmpDir }),
    ).rejects.toThrowError(InspectError);
  });

  it("renders a human summary including artifacts", async () => {
    const out = formatInspection(await inspectSession(sessionDir));
    expect(out).toContain("crumbtrail-server inspect");
    expect(out).toContain(SESSION_ID);
    expect(out).toContain("Artifacts");
    expect(out).toContain("manifest.json");
  });

  it("surfaces the bundle's detect-to-bundle latency stamp from llm.json", async () => {
    const llm = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "llm.json"), "utf-8"),
    );
    // The seeded session has a failed request, so post-processing stamped the bundle.
    expect(typeof llm.detectToBundleMs).toBe("number");

    const summary = await inspectSession(sessionDir);
    expect(summary.firstErrorEventAt).toBe(llm.firstErrorEventAt);
    expect(summary.detectToBundleMs).toBe(llm.detectToBundleMs);
    expect(summary.detectToBundleMs).toBeGreaterThanOrEqual(0);

    const out = formatInspection(summary);
    expect(out).toContain(`Detect→bundle: ${llm.detectToBundleMs} ms`);
  });

  it("omits latency fields and the human latency line when llm.json has no stamp", async () => {
    fs.rmSync(path.join(sessionDir, "llm.json"));
    const summary = await inspectSession(sessionDir);
    expect(summary).not.toHaveProperty("firstErrorEventAt");
    expect(summary).not.toHaveProperty("detectToBundleMs");
    expect(formatInspection(summary)).not.toContain("Detect→bundle");
  });
});

describe("runInspect (CLI)", () => {
  let tmpDir: string;
  let sessionDir: string;
  let writes: string[];
  let writeSpy: MockInstance<typeof process.stdout.write>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-inspect-cli-"));
    sessionDir = await seedSession(tmpDir);
    writes = [];
    writeSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk: any) => {
        writes.push(String(chunk));
        return true;
      });
  });

  afterEach(() => {
    writeSpy.mockRestore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits the raw inspection as JSON with --json", async () => {
    const code = await runInspect([sessionDir, "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(writes.join(""));
    expect(parsed.id).toBe(SESSION_ID);
    expect(Array.isArray(parsed.artifacts)).toBe(true);
  });

  it("emits a human summary by default", async () => {
    const code = await runInspect([sessionDir]);
    expect(code).toBe(0);
    expect(writes.join("")).toContain("crumbtrail-server inspect");
  });

  it("resolves a bare session id against --output", async () => {
    const code = await runInspect([SESSION_ID, "--output", tmpDir, "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(writes.join("")).id).toBe(SESSION_ID);
  });

  it("resolves a bare session id living in the finalized partition layout", async () => {
    const partTmp = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-inspect-part-"),
    );
    try {
      const id = "ses_part_inspect";
      const dir = path.join(partTmp, "local", "shop", "2026-06-30", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, "meta.json"),
        JSON.stringify({ id, app: "shop", start: 1000 }),
      );
      fs.writeFileSync(
        path.join(dir, "events.ndjson"),
        EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      await postProcess(dir);

      const code = await runInspect([id, "--output", partTmp, "--json"]);
      expect(code).toBe(0);
      expect(JSON.parse(writes.join("")).id).toBe(id);
    } finally {
      fs.rmSync(partTmp, { recursive: true, force: true });
    }
  });

  it("returns 1 when no session argument is given", async () => {
    const errSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const code = await runInspect([]);
    errSpy.mockRestore();
    expect(code).toBe(1);
  });

  it("passes latency fields through --json and omits them when llm.json lacks a stamp", async () => {
    const llm = JSON.parse(
      fs.readFileSync(path.join(sessionDir, "llm.json"), "utf-8"),
    );
    expect(typeof llm.detectToBundleMs).toBe("number");

    let code = await runInspect([sessionDir, "--json"]);
    expect(code).toBe(0);
    const withLatency = JSON.parse(writes.join(""));
    expect(withLatency.firstErrorEventAt).toBe(llm.firstErrorEventAt);
    expect(withLatency.detectToBundleMs).toBe(llm.detectToBundleMs);

    writes.length = 0;
    fs.rmSync(path.join(sessionDir, "llm.json"));
    code = await runInspect([sessionDir, "--json"]);
    expect(code).toBe(0);
    const withoutLatency = JSON.parse(writes.join(""));
    expect("firstErrorEventAt" in withoutLatency).toBe(false);
    expect("detectToBundleMs" in withoutLatency).toBe(false);
  });
});
