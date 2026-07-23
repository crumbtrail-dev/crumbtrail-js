import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { AiDiagnosisBackfillResult } from "../ai-diagnosis";

const backfillAiDiagnoses = vi.fn(
  async (): Promise<AiDiagnosisBackfillResult> => ({
    checked: 0,
    generated: 0,
    skipped: 0,
    failed: 0,
  }),
);

vi.mock("../ai-diagnosis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ai-diagnosis")>();
  return { ...actual, backfillAiDiagnoses };
});

const { createServer } = await import("../server");

/** Guards against a regression where the startup-backfill block was duplicated
 * inside createServer, so enabling ai.backfillOnStart ran two identical full
 * passes over every session and logged completion twice. */
describe("startup AI opinion backfill", () => {
  let tmpDir: string;
  let server: http.Server | undefined;

  beforeEach(() => {
    backfillAiDiagnoses.mockClear();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-backfill-"));
  });

  afterEach(async () => {
    if (server) {
      const current = server;
      await new Promise<void>((resolve) => current.close(() => resolve()));
      server = undefined;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("runs exactly once when ai.backfillOnStart is enabled", async () => {
    const logs: string[] = [];
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      ai: {
        enabled: true,
        apiKey: "key",
        backfillOnStart: true,
        log: (message) => logs.push(message),
      },
    });
    const listening = server;
    await new Promise<void>((resolve) => listening.listen(0, resolve));

    await vi.waitFor(() => {
      expect(backfillAiDiagnoses).toHaveBeenCalled();
    });
    // Let any second scheduled pass reach the mock before asserting the count.
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(backfillAiDiagnoses).toHaveBeenCalledTimes(1);
    expect(
      logs.filter((message) =>
        message.startsWith("Crumbtrail AI opinion backfill complete"),
      ),
    ).toHaveLength(1);
  });

  it("does not run when ai.backfillOnStart is not set", async () => {
    server = createServer({
      port: 0,
      outputDir: tmpDir,
      ai: { enabled: true, apiKey: "key" },
    });
    const listening = server;
    await new Promise<void>((resolve) => listening.listen(0, resolve));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(backfillAiDiagnoses).not.toHaveBeenCalled();
  });
});
