import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  FilesystemSessionStore,
  defaultSessionStore,
  setSessionStore,
  resetSessionStore,
  getSessionStore,
  type SessionStore,
} from "../session-store";
import { appendEvents as writerAppendEvents } from "../writer";

// Unit tests for the write-plane primitives implemented in checkpoint 2a.
// These lock the behaviour so the (later) R2 adapter can be held to the same contract.
describe("FilesystemSessionStore write plane", async () => {
  let tmpDir: string;
  const store = new FilesystemSessionStore();
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-store-"));
  });
  afterEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createSessionDir", async () => {
    it("creates the directory with 0700 mode (POSIX)", async () => {
      const dir = path.join(tmpDir, "staging", "ses_1");
      const returned = await store.createSessionDir(dir);
      expect(returned).toBe(dir);
      const stat = fs.statSync(dir);
      expect(stat.isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(stat.mode & 0o777).toBe(0o700);
      }
    });
  });

  describe("appendEvents / readArtifact", async () => {
    it("round-trips appended events through readArtifact", async () => {
      const events = [
        { t: 1, k: "a", d: {} },
        { t: 2, k: "b", d: { key: "value" } },
      ];
      const result = await store.appendEvents(tmpDir, events);
      expect(result).toMatchObject({
        accepted: 2,
        dropped: 0,
        truncated: false,
      });

      const buf = await store.readArtifact(tmpDir, "events.ndjson");
      expect(buf).toBeInstanceOf(Buffer);
      const lines = (buf as Buffer).toString("utf-8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[1])).toEqual(events[1]);
    });

    it("appends to an existing file rather than overwriting", async () => {
      await store.appendEvents(tmpDir, [{ t: 1, k: "a", d: {} }]);
      await store.appendEvents(tmpDir, [{ t: 2, k: "b", d: {} }]);
      const lines = (await store.readArtifact(tmpDir, "events.ndjson") as Buffer)
        .toString("utf-8")
        .trim()
        .split("\n");
      expect(lines).toHaveLength(2);
    });

    it("stops at the byte cap and writes a truncation marker", async () => {
      const first = { t: 1, k: "a", d: { msg: "fits" } };
      const second = {
        t: 2,
        k: "b",
        d: { msg: "dropped once the cap is reached" },
      };
      const firstLineBytes = Buffer.byteLength(
        `${JSON.stringify(first)}\n`,
        "utf-8",
      );

      const result = await store.appendEvents(tmpDir, [first, second], {
        maxEventBytes: firstLineBytes + 1,
      });
      expect(result).toMatchObject({
        accepted: 1,
        dropped: 1,
        truncated: true,
      });
      const marker = JSON.parse(
        (
          await store.readArtifact(tmpDir, "capture-truncated.json") as Buffer
        ).toString("utf-8"),
      );
      expect(marker).toMatchObject({
        truncated: true,
        reason: "session_event_bytes_cap",
        eventsAccepted: 1,
        eventsDropped: 1,
      });
    });

    it("returns undefined reading a missing artifact", async () => {
      expect(await store.readArtifact(tmpDir, "nope.json")).toBeUndefined();
    });
  });

  describe("writeArtifact", async () => {
    it("writes atomically (no leftover tmp files) and reads back", async () => {
      await store.writeArtifact(tmpDir, "index.json", '{"ok":true}');
      expect(
        (await store.readArtifact(tmpDir, "index.json") as Buffer).toString("utf-8"),
      ).toBe('{"ok":true}');
      const leftover = fs.readdirSync(tmpDir).filter((n) => n.endsWith(".tmp"));
      expect(leftover).toHaveLength(0);
    });

    it("rejects an unsafe artifact name", async () => {
      await expect(store.writeArtifact(tmpDir, "../escape.json", "x")).rejects.toThrow(
        /Invalid generated artifact name/,
      );
      // One subdirectory level is the maximum; deeper paths and traversal stay rejected.
      await expect(
        store.writeArtifact(tmpDir, "a/b/name.json", "x"),
      ).rejects.toThrow(/Invalid generated artifact name/);
      await expect(
        store.writeArtifact(tmpDir, "windows/../escape.json", "x"),
      ).rejects.toThrow(/Invalid generated artifact name/);
    });

    // `windows/cand_0001.md` is a real finalize artifact, so the seam has to accept
    // exactly one nested level — otherwise those files bypass the store entirely.
    it("writes into one existing subdirectory level, atomically", async () => {
      fs.mkdirSync(path.join(tmpDir, "windows"));
      await store.writeArtifact(tmpDir, "windows/cand_0001.md", "# window");
      expect(
        (
          (await store.readArtifact(tmpDir, "windows/cand_0001.md")) as Buffer
        ).toString("utf-8"),
      ).toBe("# window");
      const leftover = fs
        .readdirSync(path.join(tmpDir, "windows"))
        .filter((n) => n.endsWith(".tmp"));
      expect(leftover).toHaveLength(0);
    });

    it("refuses to write through a symlinked subdirectory", async () => {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-esc-"));
      fs.symlinkSync(outside, path.join(tmpDir, "windows"));
      await expect(
        store.writeArtifact(tmpDir, "windows/cand_0001.md", "x"),
      ).rejects.toThrow(/escaped session directory/);
      expect(fs.existsSync(path.join(outside, "cand_0001.md"))).toBe(false);
      fs.rmSync(outside, { recursive: true, force: true });
    });

    it("refuses to overwrite a symlinked artifact target", async () => {
      const outside = path.join(tmpDir, "outside.txt");
      fs.writeFileSync(outside, "original");
      fs.symlinkSync(outside, path.join(tmpDir, "index.json"));
      await expect(store.writeArtifact(tmpDir, "index.json", "x")).rejects.toThrow();
      expect(fs.readFileSync(outside, "utf-8")).toBe("original");
    });
  });

  describe("writeBlob / statArtifact", async () => {
    it("writes binary data and reports its size", async () => {
      const data = Buffer.from([0x00, 0x01, 0x02, 0xff]);
      await store.writeBlob(tmpDir, "recording.webm", data);
      expect(
        Buffer.compare(
          await store.readArtifact(tmpDir, "recording.webm") as Buffer,
          data,
        ),
      ).toBe(0);
      const stat = await store.statArtifact(tmpDir, "recording.webm");
      expect(stat).toEqual({ bytes: 4, isDir: false });
    });

    it("refuses to write through a symlinked blob path", async () => {
      const outside = path.join(tmpDir, "outside.bin");
      fs.writeFileSync(outside, "original");
      fs.symlinkSync(outside, path.join(tmpDir, "recording.webm"));
      await expect(
        store.writeBlob(tmpDir, "recording.webm", Buffer.from("x")),
      ).rejects.toThrow();
      expect(fs.readFileSync(outside, "utf-8")).toBe("original");
    });

    it("returns undefined stat for a missing artifact", async () => {
      expect(await store.statArtifact(tmpDir, "nope")).toBeUndefined();
    });
  });

  describe("listArtifacts", async () => {
    it("lists immediate file entries and skips symlinks", async () => {
      await store.writeArtifact(tmpDir, "meta.json", "{}");
      await store.writeArtifact(tmpDir, "index.json", "{}");
      fs.symlinkSync(
        path.join(tmpDir, "meta.json"),
        path.join(tmpDir, "link.json"),
      );
      const names = (await store.listArtifacts(tmpDir)).sort();
      expect(names).toContain("meta.json");
      expect(names).toContain("index.json");
      expect(names).not.toContain("link.json");
    });

    it("returns empty for a missing directory", async () => {
      expect(await store.listArtifacts(path.join(tmpDir, "nope"))).toEqual([]);
    });
  });

  describe("moveToPartition", async () => {
    it("atomically renames staging into the partition target", async () => {
      const staging = path.join(tmpDir, ".sessions", "ses_1");
      fs.mkdirSync(staging, { recursive: true });
      fs.writeFileSync(path.join(staging, "meta.json"), '{"id":"ses_1"}');
      const target = path.join(tmpDir, "acme", "shop", "2026-06-30", "ses_1");
      fs.mkdirSync(path.dirname(target), { recursive: true });

      const returned = await store.moveToPartition(staging, target);
      expect(returned).toBe(target);
      expect(fs.existsSync(staging)).toBe(false);
      expect(fs.readFileSync(path.join(target, "meta.json"), "utf-8")).toBe(
        '{"id":"ses_1"}',
      );
    });
  });

  describe("resolveSessionDir", async () => {
    it("resolves a bare id in the finalized partition layout (whole-tree)", async () => {
      const id = "ses_123";
      const partDir = path.join(tmpDir, "acme", "shop", "2026-06-30", id);
      fs.mkdirSync(partDir, { recursive: true });
      fs.writeFileSync(path.join(partDir, "meta.json"), JSON.stringify({ id }));
      expect(store.resolveSessionDir(id, tmpDir)).toBe(partDir);
    });

    it("falls back to the flat path for a missing session", async () => {
      expect(store.resolveSessionDir("nope", tmpDir)).toBe(
        path.join(tmpDir, "nope"),
      );
    });

    it("scoped lookup finds only within the tenant/app and never escapes", async () => {
      const id = "s-here";
      const dir = path.join(tmpDir, "ten_a", "proj_a", "2026-06-30", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "meta.json"), "{}");

      expect(
        store.resolveSessionDir(id, tmpDir, { tenant: "ten_a", app: "proj_a" }),
      ).toBe(dir);
      // A different tenant must not resolve into ten_a's tree.
      const otherTenant = store.resolveSessionDir(id, tmpDir, {
        tenant: "ten_other",
        app: "proj_a",
      });
      expect(otherTenant).not.toContain("ten_a");
      // Traversal id is rejected by segment validation.
      const escape = store.resolveSessionDir("../../escape", tmpDir, {
        tenant: "ten_a",
        app: "proj_a",
      });
      expect(escape).not.toContain("escape/");
    });
  });

  describe("resolveScopedSessionDir (cloud isolation contract)", async () => {
    it("returns the dir within tenant/app, else undefined (never a fallback or cross-tenant)", async () => {
      const id = "s-here";
      const dir = path.join(tmpDir, "ten_a", "proj_a", "2026-06-30", id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "meta.json"), "{}");

      expect(store.resolveScopedSessionDir(tmpDir, "ten_a", "proj_a", id)).toBe(
        dir,
      );
      // Miss => undefined, not a fallback path.
      expect(
        store.resolveScopedSessionDir(tmpDir, "ten_a", "proj_a", "missing"),
      ).toBeUndefined();
      // Different tenant never reaches ten_a's tree.
      expect(
        store.resolveScopedSessionDir(tmpDir, "ten_other", "proj_a", id),
      ).toBeUndefined();
      // Traversal args rejected.
      expect(
        store.resolveScopedSessionDir(
          tmpDir,
          "ten_a",
          "proj_a",
          "../../escape",
        ),
      ).toBeUndefined();
    });
  });

  describe("deleteSessionDir", async () => {
    it("recursively deletes a session directory", async () => {
      const dir = path.join(tmpDir, "ses_del");
      fs.mkdirSync(path.join(dir, "frames"), { recursive: true });
      fs.writeFileSync(path.join(dir, "meta.json"), "{}");
      await store.deleteSessionDir(dir);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it("is a no-op for a missing directory", async () => {
      await expect(
        store.deleteSessionDir(path.join(tmpDir, "gone")),
      ).resolves.not.toThrow();
    });

    it("refuses to delete through a symlink", async () => {
      const real = path.join(tmpDir, "real");
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, "keep.txt"), "x");
      const link = path.join(tmpDir, "link");
      fs.symlinkSync(real, link);
      await expect(store.deleteSessionDir(link)).rejects.toThrow(/symlink/);
      expect(fs.existsSync(path.join(real, "keep.txt"))).toBe(true);
    });
  });
});


// The swappable-store seam exists so an embedder (the hosted cloud) can interpose
// an at-rest encryption decorator. These tests prove the seam is load-bearing:
// package-internal call sites really do route through the installed store, and
// a decorator can transform bytes on the way to and from disk.
// Class methods live on the prototype, so an object spread would not copy them.
// This builds an explicit plain-object delegate a test can then selectively override.
function delegateTo(inner: SessionStore): SessionStore {
  return {
    createSessionDir: (a) => inner.createSessionDir(a),
    appendEvents: (a, b, c) => inner.appendEvents(a, b, c),
    appendRecordLines: (a, b, c) => inner.appendRecordLines(a, b, c),
    writeArtifact: (a, b, c) => inner.writeArtifact(a, b, c),
    writeBlob: (a, b, c) => inner.writeBlob(a, b, c),
    writeSessionArtifact: (a, b, c) => inner.writeSessionArtifact(a, b, c),
    readArtifact: (a, b) => inner.readArtifact(a, b),
    statArtifact: (a, b) => inner.statArtifact(a, b),
    listSessions: (a) => inner.listSessions(a),
    listArtifacts: (a) => inner.listArtifacts(a),
    moveToPartition: (a, b) => inner.moveToPartition(a, b),
    resolveSessionDir: (a, b, c) => inner.resolveSessionDir(a, b, c),
    resolveScopedSessionDir: (a, b, c, d) =>
      inner.resolveScopedSessionDir(a, b, c, d),
    deleteSessionDir: (a) => inner.deleteSessionDir(a),
  };
}

describe("session store injection seam", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-seam-"));
  });

  afterEach(() => {
    resetSessionStore();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("defaults to the filesystem store and restores it on reset", () => {
    expect(getSessionStore()).toBeInstanceOf(FilesystemSessionStore);
    const fake = new FilesystemSessionStore();
    setSessionStore(fake);
    expect(getSessionStore()).toBe(fake);
    resetSessionStore();
    expect(getSessionStore()).toBeInstanceOf(FilesystemSessionStore);
  });

  it("routes package-internal writes through the installed store", async () => {
    const calls: string[] = [];
    const inner = new FilesystemSessionStore();
    const recording: SessionStore = {
      ...delegateTo(inner),
      appendEvents: (dir, events, opts) => {
        calls.push("appendEvents");
        return inner.appendEvents(dir, events, opts);
      },
      readArtifact: (dir, name) => {
        calls.push(`readArtifact:${name}`);
        return inner.readArtifact(dir, name);
      },
    };
    setSessionStore(recording);

    // writer.appendEvents is the live capture path; it must hit the decorator.
    await writerAppendEvents(tmpDir, [{ t: 1, k: "a", d: {} }]);
    await defaultSessionStore.readArtifact(tmpDir, "events.ndjson");

    expect(calls).toEqual(["appendEvents", "readArtifact:events.ndjson"]);
  });

  it("lets a decorator transform bytes at rest and back on read", async () => {
    const inner = new FilesystemSessionStore();
    const mark = "ENC:";
    const decorated: SessionStore = {
      ...delegateTo(inner),
      writeArtifact: (dir, name, data) =>
        inner.writeArtifact(dir, name, `${mark}${data.toString()}`),
      readArtifact: async (dir, name) => {
        const raw = await inner.readArtifact(dir, name);
        if (!raw) return undefined;
        const text = raw.toString("utf-8");
        return Buffer.from(
          text.startsWith(mark) ? text.slice(mark.length) : text,
          "utf-8",
        );
      },
    };
    setSessionStore(decorated);

    await defaultSessionStore.writeArtifact(tmpDir, "index.json", '{"a":1}');

    // On disk the bytes are transformed...
    expect(fs.readFileSync(path.join(tmpDir, "index.json"), "utf-8")).toBe(
      'ENC:{"a":1}',
    );
    // ...and the read path returns the original plaintext.
    const readBack = await defaultSessionStore.readArtifact(
      tmpDir,
      "index.json",
    );
    expect(readBack?.toString("utf-8")).toBe('{"a":1}');
  });

  // Regression guard: installing the forwarding facade as the active store makes
  // it its own delegate, so every session IO call recurses until the stack blows.
  // An embedder that wants "no decorator" must simply not call setSessionStore.
  it("refuses to install defaultSessionStore as the active store", () => {
    expect(() => setSessionStore(defaultSessionStore)).toThrow(
      /forwarding facade/,
    );
    expect(getSessionStore()).toBeInstanceOf(FilesystemSessionStore);
  });

  // The same trap one level down: a decorator that delegates to the facade and is
  // then installed forms the identical cycle.
  it("a decorator that wraps a concrete store never recurses", async () => {
    const inner = new FilesystemSessionStore();
    let depth = 0;
    const decorated: SessionStore = {
      ...inner,
      writeArtifact: async (dir, name, data) => {
        depth += 1;
        await inner.writeArtifact(dir, name, data);
      },
    } as SessionStore;
    setSessionStore(decorated);
    await defaultSessionStore.writeArtifact(tmpDir, "index.json", "{}");
    expect(depth).toBe(1);
  });
});
