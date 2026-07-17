import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  backfillAiDiagnoses,
  normalizeAiOpinion,
  runAiDiagnosis,
  scheduleAiDiagnosis,
} from "../ai-diagnosis";
import { buildFixContext } from "../fix-context";

describe("runAiDiagnosis", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-ai-"));
    fs.mkdirSync(path.join(tmpDir, "windows"));
    fs.writeFileSync(
      path.join(tmpDir, "candidates.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        id: "cand_0001",
        detector: "http_error",
        title: "HTTP 500 from POST /api/save",
        severity: "high",
        score: 90,
        confidence: "high",
        anchor: { t: 1000 },
        evidenceWindow: { start: 0, end: 2000, windowId: "win_0001" },
      })}\n`,
    );
    fs.writeFileSync(
      path.join(tmpDir, "windows", "cand_0001.md"),
      "# Evidence Window cand_0001\n",
    );
    fs.writeFileSync(
      path.join(tmpDir, "index.json"),
      JSON.stringify({ id: "ses_ai", start: 0, end: 2000, dur: 2000 }),
    );
    fs.writeFileSync(
      path.join(tmpDir, "llm.json"),
      JSON.stringify({
        session: {
          id: "ses_ai",
          app: "shop",
          startMs: 0,
          endMs: 2000,
          durationMs: 2000,
        },
        fullStackEvidence: {
          linked: [
            {
              requestId: "req_1",
              sessionId: "ses_ai",
              frontend: { ref: { t: 1000, kind: "net.res" }, status: 500 },
              backend: { requestId: "req_1", statusCode: 500 },
            },
          ],
        },
        databaseDiffs: [],
        databaseReads: [],
        databaseActivity: [],
        environment: { flags: { checkout: true } },
      }),
    );
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("does not call fetch without explicit opt-in even when a key exists", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("unexpected");
    });
    const result = await runAiDiagnosis(tmpDir, {
      enabled: false,
      apiKey: "key",
      fetchImpl: fetchSpy as typeof fetch,
    });
    expect(result).toMatchObject({ ok: true, skipped: "opt_in_disabled" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips when opt-in is enabled but the API key is missing", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("unexpected");
    });
    const previous = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const result = await runAiDiagnosis(tmpDir, {
        enabled: true,
        fetchImpl: fetchSpy as typeof fetch,
      });
      expect(result).toMatchObject({ ok: true, skipped: "missing_key" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = previous;
    }
  });

  it("backfills an existing finalized session with bounded opinion work", async () => {
    const result = await backfillAiDiagnoses([tmpDir], {
      enabled: true,
      apiKey: "key",
      backfillConcurrency: 1,
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ findings: [] }) } },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });

    expect(result).toEqual({
      checked: 1,
      generated: 1,
      skipped: 0,
      failed: 0,
    });
    expect(fs.existsSync(path.join(tmpDir, "opinion.json"))).toBe(true);
  });

  it("bounds live scheduled diagnoses with the same provider concurrency", async () => {
    const copies = ["session-2", "session-3"].map((name) => {
      const dir = path.join(tmpDir, name);
      fs.mkdirSync(path.join(dir, "windows"), { recursive: true });
      fs.copyFileSync(
        path.join(tmpDir, "candidates.jsonl"),
        path.join(dir, "candidates.jsonl"),
      );
      fs.copyFileSync(
        path.join(tmpDir, "index.json"),
        path.join(dir, "index.json"),
      );
      fs.copyFileSync(
        path.join(tmpDir, "llm.json"),
        path.join(dir, "llm.json"),
      );
      return dir;
    });
    let providerCalls = 0;
    const releases: Array<() => void> = [];
    const config = {
      enabled: true,
      apiKey: "key",
      backfillConcurrency: 1,
      fetchImpl: (async () => {
        providerCalls += 1;
        await new Promise<void>((resolve) => releases.push(resolve));
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ findings: [] }) } },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    };

    for (const dir of [tmpDir, ...copies]) scheduleAiDiagnosis(dir, config);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(providerCalls).toBe(1);

    releases.shift()?.();
    await waitFor(() => providerCalls === 2);
    releases.shift()?.();
    await waitFor(() => providerCalls === 3);
    releases.shift()?.();
    await waitFor(() =>
      copies.every((dir) => fs.existsSync(path.join(dir, "opinion.json"))),
    );
  });

  it("reports malformed candidate files without calling the provider", async () => {
    fs.writeFileSync(path.join(tmpDir, "candidates.jsonl"), "{not json}\n");
    let called = false;
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async () => {
        called = true;
        throw new Error("unexpected");
      }) as typeof fetch,
    });
    expect(result).toMatchObject({ ok: true, skipped: "no_candidates" });
    expect(called).toBe(false);
  });

  it("reports provider errors without writing opinion artifacts", async () => {
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async () =>
        new Response("nope", { status: 503 })) as typeof fetch,
    });
    expect(result).toMatchObject({
      ok: false,
      error: "OpenRouter request failed with HTTP 503",
    });
    expect(fs.existsSync(path.join(tmpDir, "opinion.md"))).toBe(false);
  });

  it("reports malformed model JSON without writing opinion artifacts", async () => {
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: "{not json" } }],
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(tmpDir, "opinion.md"))).toBe(false);
  });

  it("sends the complete agent visible bundle, including more than 40 signals, and audits the exact provider slice", async () => {
    const candidates = Array.from({ length: 45 }, (_, i) => ({
      schemaVersion: 1,
      id: `cand_${String(i + 1).padStart(4, "0")}`,
      detector: "console_error",
      title: `Candidate ${i + 1} ${"x".repeat(200)}`,
      severity: "low",
      score: 45 - i,
      confidence: "medium",
      anchor: { t: i },
      evidenceWindow: { start: i, end: i + 1, windowId: "win_0001" },
    }));
    fs.writeFileSync(
      path.join(tmpDir, "candidates.jsonl"),
      candidates.map((candidate) => JSON.stringify(candidate)).join("\n") +
        "\n",
    );
    for (const candidate of candidates) {
      fs.writeFileSync(
        path.join(tmpDir, "windows", `${candidate.id}.md`),
        `# ${candidate.id} ${"y".repeat(200)}\n`,
      );
    }

    let requestBody = "";
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      maxPromptBytes: 1_000_000,
      fetchImpl: (async (_url, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ findings: [] }) } },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(result.ok).toBe(true);
    const providerPrompt = userPromptFromRequest(requestBody);
    const providerBundle = evidenceBundleFromPrompt(providerPrompt);
    const audit = readAudit(tmpDir);
    expect(providerBundle).toEqual(buildFixContext(tmpDir));
    expect(providerBundle.signals).toHaveLength(45);
    expect(providerBundle.signals[44]).toMatchObject({
      id: "cand_0045",
      basis: "heuristic",
      baseScore: 1,
    });
    expect(audit.evidenceSlice).toBe(providerPrompt);
    expect(audit.prompt).toBe(providerPrompt);
    expect(audit.reduction).toEqual({ mode: "none", dropped: [] });
    fs.rmSync(path.join(tmpDir, "opinion.json"), { force: true });
    fs.rmSync(path.join(tmpDir, "opinion.md"), { force: true });
    fs.rmSync(path.join(tmpDir, "opinion.audit.json"), { force: true });

    const cappedResult = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      maxPromptBytes: 2_000,
      fetchImpl: (async (_url, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ findings: [] }) } },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(cappedResult.ok).toBe(true);
    const cappedPrompt = userPromptFromRequest(requestBody);
    const cappedAudit = readAudit(tmpDir);
    expect(Buffer.byteLength(cappedPrompt, "utf-8")).toBeLessThanOrEqual(2_000);
    expect(cappedAudit.evidenceSlice).toBe(cappedPrompt);
    expect(cappedAudit.prompt).toBe(cappedPrompt);
    expect(cappedAudit.reduction).toMatchObject({
      mode: "deterministic_structural",
    });
    expect(cappedAudit.reduction.dropped.length).toBeGreaterThan(0);
    expect(evidenceBundleFromPrompt(cappedPrompt)).not.toEqual(
      buildFixContext(tmpDir),
    );
  });

  it("does not send raw evidence window text to OpenRouter", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "windows", "cand_0001.md"),
      [
        "# Evidence Window cand_0001",
        "clip txt: copy this password hunter2",
        "key: secret-keystrokes-123",
        "tx: private transcript text",
        "console: runtime snippet with sk_fake_abcdefghijklmnopqrstuvwxyz",
        "unknown payload raw-sensitive-value",
      ].join("\n"),
    );

    let requestBody = "";
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async (_url, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              { message: { content: JSON.stringify({ findings: [] }) } },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(requestBody).toContain("cand_0001");
    expect(requestBody).not.toContain("hunter2");
    expect(requestBody).not.toContain("secret-keystrokes-123");
    expect(requestBody).not.toContain("private transcript text");
    expect(requestBody).not.toContain("sk_fake_");
    expect(requestBody).not.toContain("raw-sensitive-value");
  });

  it("records the full agent visible evidence slice and exact prompt for audit", async () => {
    let requestBody = "";
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async (_url, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    hypotheses: [
                      {
                        confidence: "high",
                        evidence_refs: ["cand_0001"],
                      },
                    ],
                    unknowns: [
                      "The captured evidence cannot prove user intent",
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(result.ok).toBe(true);
    const audit = readAudit(tmpDir);
    const providerPrompt = userPromptFromRequest(requestBody);
    expect(audit.promptRevision).toBe("opinion.v1");
    expect(audit.promptBytes).toBe(Buffer.byteLength(audit.prompt, "utf-8"));
    expect(audit.evidenceSlice).toBe(providerPrompt);
    expect(audit.prompt).toBe(providerPrompt);
    expect(evidenceBundleFromPrompt(providerPrompt)).toMatchObject({
      signals: [
        {
          id: "cand_0001",
          basis: "heuristic",
          baseScore: 90,
        },
      ],
      primary_window: {
        frontend: { requests: [{ status: 500 }] },
        backend: { requests: [{ statusCode: 500 }] },
      },
      environment: { flags: { checkout: true } },
    });
    expect(providerPrompt).toContain('"causal_chain"');
  });

  it("records the exact byte prefix sent when the smallest prompt budget cannot fit a structured bundle", async () => {
    let requestBody = "";
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      maxPromptBytes: 12,
      fetchImpl: (async (_url, init) => {
        requestBody = String(init?.body ?? "");
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    expect(result.ok).toBe(true);
    const providerPrompt = userPromptFromRequest(requestBody);
    const audit = readAudit(tmpDir);
    expect(Buffer.byteLength(providerPrompt, "utf-8")).toBeLessThanOrEqual(12);
    expect(audit.evidenceSlice).toBe(providerPrompt);
    expect(audit.prompt).toBe(providerPrompt);
    expect(audit.reduction).toMatchObject({ mode: "byte_prefix" });
    expect(audit.reduction.dropped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$", reason: "prompt_byte_cap" }),
      ]),
    );
  });

  it("does not treat a partial publication as complete after the audit rename fails", async () => {
    let providerCalls = 0;
    const originalRename = fs.renameSync;
    const renameSpy = vi
      .spyOn(fs, "renameSync")
      .mockImplementation(((oldPath, newPath) => {
        if (String(newPath).endsWith("opinion.audit.json"))
          throw new Error("audit write failed");
        return originalRename(oldPath, newPath);
      }) as typeof fs.renameSync);

    try {
      const failed = await runAiDiagnosis(tmpDir, {
        enabled: true,
        apiKey: "key",
        fetchImpl: (async () => {
          providerCalls += 1;
          return new Response(
            JSON.stringify({
              choices: [
                { message: { content: JSON.stringify({ findings: [] }) } },
              ],
            }),
            { status: 200 },
          );
        }) as typeof fetch,
      });

      expect(failed.ok).toBe(false);
      expect(failed.error).toContain("audit write failed");
      expect(fs.existsSync(path.join(tmpDir, "opinion.json"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "opinion.md"))).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, "opinion.audit.json"))).toBe(false);
    } finally {
      renameSpy.mockRestore();
    }

    // Match the old publication order's failure residue: an opinion without
    // an audit must be regenerated rather than skipped as already existing.
    fs.writeFileSync(
      path.join(tmpDir, "opinion.json"),
      JSON.stringify({ stale: true }),
    );
    const retried = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async () => {
        providerCalls += 1;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ findings: [] }) } }],
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });
    expect(retried).toEqual({ ok: true });
    expect(providerCalls).toBe(2);
    expect(fs.existsSync(path.join(tmpDir, "opinion.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, "opinion.audit.json"))).toBe(true);
  });

  it("does not write opinion artifacts through symlinks created while the provider is running", async () => {
    const outsideFile = path.join(
      os.tmpdir(),
      `crumbtrail-opinion-outside-${Date.now()}.json`,
    );
    fs.writeFileSync(outsideFile, "outside");

    try {
      const result = await runAiDiagnosis(tmpDir, {
        enabled: true,
        apiKey: "key",
        fetchImpl: (async () => {
          fs.symlinkSync(outsideFile, path.join(tmpDir, "opinion.json"));
          return new Response(
            JSON.stringify({
              choices: [
                { message: { content: JSON.stringify({ findings: [] }) } },
              ],
            }),
            { status: 200 },
          );
        }) as typeof fetch,
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Invalid opinion artifact path");
      expect(fs.readFileSync(outsideFile, "utf-8")).toBe("outside");
    } finally {
      fs.rmSync(outsideFile, { force: true });
    }
  });

  it("writes opinion artifacts with hypotheses, evidence references, and unknowns", async () => {
    const result = await runAiDiagnosis(tmpDir, {
      enabled: true,
      apiKey: "key",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    hypotheses: [
                      {
                        confidence: "medium",
                        evidence_refs: ["cand_0001"],
                        title: "Synthetic test hypothesis",
                      },
                    ],
                    unknowns: [
                      "Whether the request failed again after this session",
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    });
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, "opinion.md"), "utf-8")).toContain(
      "cand_0001",
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(tmpDir, "opinion.json"), "utf-8")),
    ).toMatchObject({
      schemaVersion: "opinion.v1",
      hypotheses: [
        {
          confidence: "medium",
          evidence_refs: ["cand_0001"],
        },
      ],
      unknowns: ["Whether the request failed again after this session"],
    });
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error("timed out waiting for diagnosis work");
}

function readAudit(sessionDir: string): any {
  return JSON.parse(
    fs.readFileSync(path.join(sessionDir, "opinion.audit.json"), "utf-8"),
  );
}

function userPromptFromRequest(requestBody: string): string {
  return JSON.parse(requestBody).messages[1].content;
}

function evidenceBundleFromPrompt(
  prompt: string,
): ReturnType<typeof buildFixContext> {
  const marker = "\n\nEvidence bundle:\n";
  const start = prompt.indexOf(marker);
  if (start < 0) throw new Error("provider prompt is missing the evidence bundle");
  return JSON.parse(prompt.slice(start + marker.length));
}

describe("normalizeAiOpinion code_refs", () => {
  it("keeps valid code_refs, normalizes to strings, omits when absent or empty", () => {
    const opinion = normalizeAiOpinion({
      findings: [
        { confidence: "high", evidence_refs: ["e1"], code_refs: ["src/a.ts:10", 7] },
        { confidence: "low", evidence_refs: [] },
        { confidence: "low", evidence_refs: [], code_refs: [7] },
      ],
    });
    expect(opinion.hypotheses[0].code_refs).toEqual(["src/a.ts:10"]);
    expect("code_refs" in opinion.hypotheses[1]).toBe(false);
    expect("code_refs" in opinion.hypotheses[2]).toBe(false);
  });
});
