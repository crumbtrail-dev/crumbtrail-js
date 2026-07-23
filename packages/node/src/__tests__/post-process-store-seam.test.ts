import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BugEvent } from "crumbtrail-core";
import { postProcess } from "../post-process";
import { SessionManager } from "../session";
import {
  FilesystemSessionStore,
  setSessionStore,
  resetSessionStore,
  type SessionStore,
} from "../session-store";

// Stand-in for the cloud EncryptedSessionStore: `events.ndjson` is unreadable
// at rest and only the store can recover it. Post-process must therefore go
// through the store seam (SessionStore's documented contract) rather than
// reading the file with `fs` directly. The transform is deliberately not
// encryption — it only has to make the on-disk bytes non-NDJSON so a direct
// `fs` read cannot parse them.
const SEAL_PREFIX = "SEALED:";

function seal(plaintext: Buffer | string): Buffer {
  const body = Buffer.from(plaintext).toString("base64");
  return Buffer.from(`${SEAL_PREFIX}${body}`, "utf-8");
}

function unseal(data: Buffer): Buffer {
  const text = data.toString("utf-8");
  if (!text.startsWith(SEAL_PREFIX)) return data;
  return Buffer.from(text.slice(SEAL_PREFIX.length), "base64");
}

class SealingSessionStore implements SessionStore {
  private readonly inner = new FilesystemSessionStore();

  private sealed(name: string): boolean {
    return name === "events.ndjson";
  }

  async writeArtifact(
    sessionDir: string,
    name: string,
    data: string | Buffer,
  ): Promise<void> {
    await this.inner.writeArtifact(
      sessionDir,
      name,
      this.sealed(name) ? seal(data) : data,
    );
  }

  async readArtifact(
    sessionDir: string,
    name: string,
  ): Promise<Buffer | undefined> {
    const raw = await this.inner.readArtifact(sessionDir, name);
    if (raw === undefined) return undefined;
    return this.sealed(name) ? unseal(raw) : raw;
  }

  createSessionDir = (id: string) => this.inner.createSessionDir(id);
  appendEvents = (
    dir: string,
    events: BugEvent[],
    opts?: Parameters<SessionStore["appendEvents"]>[2],
  ) => this.inner.appendEvents(dir, events, opts);
  writeBlob = (dir: string, name: string, data: Buffer) =>
    this.inner.writeBlob(dir, name, data);
  writeSessionArtifact = (dir: string, name: string, data: string | Buffer) =>
    this.inner.writeSessionArtifact(dir, name, data);
  statArtifact = (dir: string, name: string) =>
    this.inner.statArtifact(dir, name);
  listSessions = (outputDir: string) => this.inner.listSessions(outputDir);
  listArtifacts = (dir: string) => this.inner.listArtifacts(dir);
  moveToPartition = (dir: string, target: string) =>
    this.inner.moveToPartition(dir, target);
  resolveSessionDir = (
    idOrDir: string,
    outputDir?: string,
    scope?: Parameters<SessionStore["resolveSessionDir"]>[2],
  ) => this.inner.resolveSessionDir(idOrDir, outputDir, scope);
  resolveScopedSessionDir = (
    sessionsDir: string,
    tenant: string,
    app: string,
    sessionId: string,
  ) =>
    this.inner.resolveScopedSessionDir(sessionsDir, tenant, app, sessionId);
  deleteSessionDir = (dir: string) => this.inner.deleteSessionDir(dir);
}

async function withPath<T>(nextPath: string, fn: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH;
  process.env.PATH = nextPath;
  try {
    return await fn();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

function writeExecutable(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content);
  fs.chmodSync(filePath, 0o755);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function withFakeAudioTools<T>(
  tmpDir: string,
  transcriptJson: string,
  fn: () => Promise<T>,
): Promise<T> {
  const binDir = path.join(tmpDir, "fake-bin");
  fs.mkdirSync(binDir, { recursive: true });
  writeExecutable(
    path.join(binDir, "ffmpeg"),
    `#!/bin/sh
last=""
for arg in "$@"; do last="$arg"; done
printf 'fake wav' > "$last"
`,
  );
  writeExecutable(
    path.join(binDir, "whisper-cpp"),
    `#!/bin/sh
out=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "-of" ]; then out="$arg"; fi
  prev="$arg"
done
if [ -z "$out" ]; then exit 2; fi
printf %s ${shellSingleQuote(transcriptJson)} > "$out.json"
`,
  );
  return withPath(binDir, fn);
}

describe("post-process reads events through the store seam", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-seam-"));
    setSessionStore(new SealingSessionStore());
  });

  afterEach(() => {
    resetSessionStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("indexes a sealed events.ndjson that is unreadable on disk", async () => {
    const events = [
      { t: 1000, k: "nav", d: { from: "", to: "/home", tr: "init" } },
      { t: 1200, k: "err", d: { msg: "TypeError: x is undefined" } },
      { t: 1400, k: "nav", d: { from: "/home", to: "/about", tr: "push" } },
    ];
    const plaintext = events.map((e) => JSON.stringify(e)).join("\n") + "\n";

    // Write through the store, exactly as a sealed capture would land.
    fs.writeFileSync(path.join(tmpDir, "events.ndjson"), seal(plaintext));

    // Precondition: the planted marker is NOT recoverable from the raw file.
    const onDisk = fs.readFileSync(path.join(tmpDir, "events.ndjson"), "utf-8");
    expect(onDisk).not.toContain("TypeError");

    await postProcess(tmpDir);

    const index = JSON.parse(
      fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8"),
    );
    expect(index.evts).toBe(3);
    expect(index.errs).toHaveLength(1);
    expect(index.errs[0].msg).toBe("TypeError: x is undefined");
    expect(index.navs).toHaveLength(2);
  });

  it("keeps events.ndjson sealed after the transcript merge rewrites it", async () => {
    const events = [
      { t: 1000, k: "nav", d: { from: "", to: "/home", tr: "init" } },
      { t: 1200, k: "err", d: { msg: "TypeError: x is undefined" } },
    ];
    const plaintext = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(path.join(tmpDir, "events.ndjson"), seal(plaintext));
    fs.writeFileSync(path.join(tmpDir, "audio.webm"), "fake audio");

    await withFakeAudioTools(
      tmpDir,
      JSON.stringify({
        transcription: [{ offsets: { from: 0 }, text: " hello world " }],
      }),
      async () => postProcess(tmpDir, "tiny"),
    );

    // The merge path rewrites events.ndjson. It must go back through the store,
    // so the raw file stays sealed and the planted marker stays unrecoverable.
    const onDisk = fs.readFileSync(path.join(tmpDir, "events.ndjson"), "utf-8");
    expect(onDisk.startsWith(SEAL_PREFIX)).toBe(true);
    expect(onDisk).not.toContain("TypeError");
    expect(onDisk).not.toContain("hello world");
  });
});

describe("finalize reads events through the store seam", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-seam-fin-"));
    setSessionStore(new SealingSessionStore());
  });

  afterEach(() => {
    resetSessionStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reports video degradation from a sealed events.ndjson", async () => {
    const sessions = new SessionManager(tmpDir);
    await sessions.create("ses_sealed_video", { app: "myapp" });
    const sessionDir = await sessions.getSessionDir("ses_sealed_video");

    const events = [
      {
        t: 1000,
        k: "media.video",
        d: { state: "error", code: "tab_capture_failed" },
      },
    ];
    const plaintext = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.writeFileSync(path.join(sessionDir, "events.ndjson"), seal(plaintext));

    const result = await sessions.finalize("ses_sealed_video");

    const video = result.postProcess.warnings?.find(
      (w) => w.capability === "video",
    );
    expect(video).toBeDefined();
    expect(video?.code).toBe("tab_capture_failed");
  });
});
