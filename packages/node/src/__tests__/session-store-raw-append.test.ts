import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { FilesystemSessionStore } from "../session-store";

/**
 * The sealed-append seam.
 *
 * A sealing decorator (cloud EncryptedSessionStore) cannot hand ciphertext to
 * `appendEvents`: that path runs every event through `sanitizeEventForStorage`,
 * whose `redactTokenLikeString` pass treats a base64 blob as a credential and
 * rewrites it — destroying the envelope. The decorator therefore sanitizes the
 * PLAINTEXT event itself, seals the serialized line, and appends the result
 * verbatim through `appendRecordLines`, which keeps the byte cap, truncation
 * marker and symlink guards in one place instead of duplicating them.
 */
describe("FilesystemSessionStore.appendRecordLines", () => {
  let tmpDir: string;
  let store: FilesystemSessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ct-raw-append-"));
    store = new FilesystemSessionStore();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function sealedLine(): { blob: string; line: string } {
    const blob = `ctss1:${crypto.randomBytes(64).toString("base64")}`;
    return { blob, line: JSON.stringify({ t: 1, k: "ct.sealed", d: { c: blob } }) };
  }

  it("appends a sealed record verbatim", async () => {
    const { blob, line } = sealedLine();

    const result = await store.appendRecordLines(tmpDir, [line]);

    expect(result.accepted).toBe(1);
    expect(result.dropped).toBe(0);
    const onDisk = fs.readFileSync(
      path.join(tmpDir, "events.ndjson"),
      "utf-8",
    );
    expect(onDisk).toBe(`${line}\n`);
    expect(onDisk).toContain(blob);
  });

  it("is the only path that preserves ciphertext — appendEvents redacts it", async () => {
    const { blob } = sealedLine();

    await store.appendEvents(tmpDir, [
      { t: 1, k: "ct.sealed", d: { c: blob } },
    ] as never);

    const onDisk = fs.readFileSync(
      path.join(tmpDir, "events.ndjson"),
      "utf-8",
    );
    // Documents WHY the raw primitive has to exist.
    expect(onDisk).not.toContain(blob);
    expect(onDisk).toContain("REDACTED");
  });

  it("still enforces the byte cap and writes a truncation marker", async () => {
    const { line } = sealedLine();

    const result = await store.appendRecordLines(tmpDir, [line, line], {
      maxEventBytes: line.length + 1,
    });

    expect(result.accepted).toBe(1);
    expect(result.dropped).toBe(1);
    expect(result.truncated).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "capture-truncated.json"))).toBe(
      true,
    );
  });
});
