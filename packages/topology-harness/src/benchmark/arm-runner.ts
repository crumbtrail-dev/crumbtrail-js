import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { BENCHMARK_ARMS, BENCHMARK_RUNS_PER_BUG, type BenchmarkArm } from "./arms";
import { BENCHMARK_CORPUS, type BenchmarkArmEvidence } from "./corpus";
import type {
  BenchmarkResultFile,
  BenchmarkRunMetadata,
  BenchmarkRunOutcome,
  BenchmarkRunResult,
} from "./types";

export const BENCHMARK_PROMPT_TEMPLATE = [
  "You are investigating one deterministic seeded software failure.",
  "Use only the configured tools and the reproduction evidence below.",
  "Return the exact root cause as component, fault, and evidenceKey, or return null if it cannot be established.",
  "Do not infer a result that the evidence does not support.",
].join("\n");

export interface BenchmarkAgentTask {
  prompt: string;
  promptTemplate: string;
  arm: BenchmarkArm;
  evidence: BenchmarkArmEvidence;
  metadata: BenchmarkRunMetadata;
}

export interface BenchmarkAgentAdapter {
  run(task: BenchmarkAgentTask): Promise<BenchmarkRunOutcome>;
}

export interface RunBenchmarkArmsInput {
  adapter: BenchmarkAgentAdapter;
  modelId: string;
  promptRevision: string;
  runCount?: number;
  outputPath: string;
  now?: () => Date;
}

function promptHash(): string {
  return createHash("sha256").update(BENCHMARK_PROMPT_TEMPLATE).digest("hex");
}

function buildPrompt(
  arm: BenchmarkArm,
  evidence: BenchmarkArmEvidence,
): string {
  return [
    BENCHMARK_PROMPT_TEMPLATE,
    "",
    `Arm: ${arm.id}`,
    `Tool configuration: ${arm.toolConfigurationId}`,
    `Tools: ${arm.tools.join(", ")}`,
    "Observable evidence:",
    JSON.stringify(evidence, null, 2),
  ].join("\n");
}

export async function runBenchmarkArms(
  input: RunBenchmarkArmsInput,
): Promise<BenchmarkResultFile> {
  if (!input.modelId.trim()) throw new Error("A model id is required.");
  if (!input.promptRevision.trim()) throw new Error("A prompt revision is required.");
  const runCount = input.runCount ?? BENCHMARK_RUNS_PER_BUG;
  if (!Number.isInteger(runCount) || runCount <= 0) {
    throw new Error("Run count must be a positive integer.");
  }
  const results: BenchmarkRunResult[] = [];
  const hash = promptHash();
  for (const bug of BENCHMARK_CORPUS) {
    const reproduction = await bug.reproduce();
    for (const arm of BENCHMARK_ARMS) {
      for (let runIndex = 0; runIndex < runCount; runIndex += 1) {
        const metadata: BenchmarkRunMetadata = {
          modelId: input.modelId,
          promptRevision: input.promptRevision,
          promptHash: hash,
          tokenBudget: arm.promptTokenBudget,
          toolConfigurationId: arm.toolConfigurationId,
          arm: arm.id,
          bugId: bug.id,
          runIndex,
        };
        const evidence = reproduction.evidence[arm.id];
        const outcome = await input.adapter.run({
          prompt: buildPrompt(arm, evidence),
          promptTemplate: BENCHMARK_PROMPT_TEMPLATE,
          arm,
          evidence,
          metadata,
        });
        results.push({ metadata, outcome });
      }
    }
  }
  const resultFile: BenchmarkResultFile = {
    schemaVersion: 2,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    results,
  };
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true });
  fs.writeFileSync(input.outputPath, `${JSON.stringify(resultFile, null, 2)}\n`);
  return resultFile;
}
