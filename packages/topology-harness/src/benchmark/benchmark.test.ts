import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBenchmarkArms } from "./arm-runner";
import { BENCHMARK_CORPUS, reproduceBenchmarkBug, type BenchmarkArmEvidence } from "./corpus";
import { generateBenchmarkReport } from "./generate-report";
import { scorerOnlyTruthForBug } from "./scoring-truth";
import { renderBenchmarkReport, scoreBenchmarkResults } from "./scorer";
import type { BenchmarkResultFile, BenchmarkRunResult, RootCauseTruth } from "./types";

const fixturePath = fileURLToPath(new URL("./fixtures/sample-results.json", import.meta.url));

const BUG_ID_BY_FIXTURE_CODE: Readonly<Record<string, string>> = {
  request_01: "row_diff_wrong_request_key",
  request_02: "row_diff_pool_context_loss",
  request_03: "row_diff_worker_origin_loss",
  request_04: "row_diff_gateway_header_loss",
  request_05: "row_diff_mysql_after_image",
  request_06: "row_diff_mssql_output",
  request_07: "row_diff_prisma_nested_write",
  request_08: "row_diff_cte_update",
  release_01: "release_discount_rounding",
  release_02: "release_tax_region_default",
  release_03: "release_inventory_reservation",
  release_04: "release_webhook_signature",
  release_05: "release_prisma_null_mapping",
  release_06: "release_knex_timezone_cast",
  release_07: "release_feature_flag_fallback",
  race_01: "write_skew_last_item",
  race_02: "write_skew_credit_limit",
  race_03: "write_skew_webhook_retry",
  race_04: "write_skew_mssql_allocation",
  http_01: "http_400_validation_mapping",
  http_02: "http_401_gateway_scope",
  http_03: "http_409_duplicate_order",
  http_04: "http_502_projection_timeout",
  http_05: "http_503_release_cache",
};

function truthForBug(id: string): RootCauseTruth {
  const truth = scorerOnlyTruthForBug(id);
  if (!truth) throw new Error(`Missing test truth for ${id}`);
  return truth;
}

function result(
  arm: "generic" | "crumbtrail",
  bugId: string,
  runIndex: number,
  correct = true,
): BenchmarkRunResult {
  return {
    metadata: {
      modelId: "fake-model",
      promptRevision: "v1",
      promptHash: "test",
      tokenBudget: 16000,
      toolConfigurationId: `${arm}_stack_v1`,
      arm,
      bugId,
      runIndex,
    },
    outcome: {
      rootCauseGuess: correct ? truthForBug(bugId) : null,
      identifiedAtSeconds: correct ? 10 : null,
      tokensToIdentification: correct ? 100 : null,
      confidence: correct ? 0.9 : null,
    },
  };
}

function fakeGuessFromObservableEvidence(evidence: BenchmarkArmEvidence): RootCauseTruth {
  const bugId = BUG_ID_BY_FIXTURE_CODE[evidence.fixtureCode];
  if (!bugId) throw new Error(`Unknown observable fixture code: ${evidence.fixtureCode}`);
  return truthForBug(bugId);
}

describe("incremental yield benchmark scorer", () => {
  it("scores supplied arm results and reports every bug class", () => {
    const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as BenchmarkResultFile;
    const score = scoreBenchmarkResults(fixture.results);
    const report = renderBenchmarkReport(score);

    expect(score.measured).toBe(true);
    expect(score.generic.identified).toBe(2);
    expect(score.crumbtrail.identified).toBe(3);
    expect(score.generic.incorrectConfidentDiagnoses).toBe(1);
    expect(score.crumbtrail.incorrectConfidentDiagnoses).toBe(1);
    expect(score.byBugClass).toHaveLength(4);
    expect(score.significance.pairedRuns).toBe(4);
    expect(score.significance.verdict).toBe("insufficient_data");
    expect(report).toContain("Results by bug class");
    expect(report).toContain("Insufficient data, no significance claim");
  });

  it("does not make a significance claim for thirty pairs in only one bug class", () => {
    const bugId = BENCHMARK_CORPUS[0].id;
    const results = Array.from({ length: 30 }, (_, runIndex) => [
      result("generic", bugId, runIndex),
      result("crumbtrail", bugId, runIndex),
    ]).flat();
    const score = scoreBenchmarkResults(results);
    expect(score.significance.pairedRuns).toBe(30);
    expect(score.significance.significant).toBe(false);
    expect(score.significance.verdict).toBe("insufficient_data");
    expect(score.significance.missingBugClasses).toHaveLength(3);
  });

  it("rejects results without preregistered metadata", () => {
    expect(() => scoreBenchmarkResults([{ outcome: result("generic", BENCHMARK_CORPUS[0].id, 0).outcome } as BenchmarkRunResult]))
      .toThrow("metadata and outcome");
  });

  it("runs every seeded reproduction with actual arm evidence and keeps truth out of the prompt", async () => {
    const reproductions = await Promise.all(BENCHMARK_CORPUS.map((bug) => bug.reproduce()));
    expect(reproductions).toHaveLength(BENCHMARK_CORPUS.length);
    for (const reproduction of reproductions) {
      expect(reproduction.evidence.generic.sentry.issue).toContain("Seeded");
      expect(reproduction.evidence.generic.datadog.requestCount).toBe(1);
      expect(
        reproduction.evidence.crumbtrail.mcp.errorEvents +
          reproduction.evidence.crumbtrail.mcp.rowEvents,
      ).toBeGreaterThan(0);
    }

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-benchmark-"));
    const output = path.join(directory, "results.json");
    const prompts: Array<{ bugId: string; prompt: string }> = [];
    try {
      const run = await runBenchmarkArms({
        adapter: {
          async run(task) {
            prompts.push({ bugId: task.metadata.bugId, prompt: task.prompt });
            expect(task.prompt).toContain(task.evidence.symptom);
            expect(task.prompt).toContain(task.arm.toolConfigurationId);
            expect(task).not.toHaveProperty("bug");
            expect(task).not.toHaveProperty("reproduction");
            return {
              rootCauseGuess: fakeGuessFromObservableEvidence(task.evidence),
              identifiedAtSeconds: 1,
              tokensToIdentification: 2,
              confidence: 0.9,
            };
          },
        },
        modelId: "fake-model",
        promptRevision: "test_v1",
        runCount: 1,
        outputPath: output,
        now: () => new Date("2026-07-15T12:00:00.000Z"),
      });
      expect(run.results).toHaveLength(BENCHMARK_CORPUS.length * 2);
      expect((await reproduceBenchmarkBug(BENCHMARK_CORPUS[0].id)).bugId).toBe(BENCHMARK_CORPUS[0].id);
      for (const { bugId, prompt } of prompts) {
        const truth = truthForBug(bugId);
        expect(prompt).not.toContain(truth.component);
        expect(prompt).not.toContain(truth.fault);
        expect(prompt).not.toContain(truth.evidenceKey);
      }
      expect(JSON.parse(fs.readFileSync(output, "utf8"))).toMatchObject({ schemaVersion: 2 });
      const report = generateBenchmarkReport([output], path.join(directory, "report.md"));
      expect(report).toContain("Insufficient data, no significance claim");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats ten duplicate run index zero copies as one matched run", () => {
    const bugId = BENCHMARK_CORPUS[0].id;
    const duplicates = Array.from({ length: 10 }, () => [
      result("generic", bugId, 0, false),
      result("crumbtrail", bugId, 0),
    ]).flat();
    const score = scoreBenchmarkResults(duplicates);
    expect(score.totalResults).toBe(2);
    expect(score.significance.pairedRuns).toBe(1);
    expect(score.significance.significant).toBe(false);
  });

  it("rejects a pair with mismatched model or prompt controls", () => {
    const bugId = BENCHMARK_CORPUS[0].id;
    const generic = result("generic", bugId, 0);
    const crumbtrail = result("crumbtrail", bugId, 0);
    crumbtrail.metadata.modelId = "other-model";
    expect(() => scoreBenchmarkResults([generic, crumbtrail])).toThrow("Matched controls differ");

    crumbtrail.metadata.modelId = generic.metadata.modelId;
    crumbtrail.metadata.promptHash = "other-prompt";
    expect(() => scoreBenchmarkResults([generic, crumbtrail])).toThrow("Matched controls differ");
  });

  it("rejects an unregistered tool configuration", () => {
    const invalid = result("generic", BENCHMARK_CORPUS[0].id, 0);
    invalid.metadata.toolConfigurationId = "generic_stack_unregistered";
    expect(() => scoreBenchmarkResults([invalid])).toThrow("unregistered tool configuration");
  });

  it("can reach significance with matched distinct replication across every bug class", () => {
    const results: BenchmarkRunResult[] = [];
    for (const bug of BENCHMARK_CORPUS) {
      for (let runIndex = 0; runIndex < 10; runIndex += 1) {
        results.push(result("generic", bug.id, runIndex, false));
        results.push(result("crumbtrail", bug.id, runIndex));
      }
    }
    const score = scoreBenchmarkResults(results);
    expect(score.significance.pairedRuns).toBe(BENCHMARK_CORPUS.length * 10);
    expect(score.significance.missingBugClasses).toEqual([]);
    expect(score.significance.underfilledBugIds).toEqual([]);
    expect(score.significance.significant).toBe(true);
  });

  it("reports missing results without inventing a measured lift", () => {
    const report = renderBenchmarkReport(scoreBenchmarkResults([]));
    expect(report).toContain("No arm results were supplied");
    expect(report).not.toContain("Overall results");
  });
});
