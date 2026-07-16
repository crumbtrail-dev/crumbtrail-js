import fs from "node:fs";
import path from "node:path";
import {
  renderBenchmarkReport,
  scoreBenchmarkResults,
  validateBenchmarkRunResult,
} from "./scorer";
import type { BenchmarkResultFile, BenchmarkRunResult } from "./types";

function packageRoot(): string {
  let current = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const direct = path.join(current, "package.json");
    const nested = path.join(current, "packages", "topology-harness", "package.json");
    for (const candidate of [direct, nested]) {
      if (!fs.existsSync(candidate)) continue;
      const manifest = JSON.parse(fs.readFileSync(candidate, "utf8")) as {
        name?: string;
      };
      if (manifest.name === "crumbtrail-topology-harness") return path.dirname(candidate);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error("Could not locate the topology harness package root.");
}

function readResultFile(filePath: string): BenchmarkRunResult[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as BenchmarkResultFile;
  if (
    parsed.schemaVersion !== 2 ||
    typeof parsed.generatedAt !== "string" ||
    !Array.isArray(parsed.results)
  ) {
    throw new Error(`Invalid benchmark result file: ${filePath}`);
  }
  for (const result of parsed.results) validateBenchmarkRunResult(result);
  return parsed.results;
}

interface ArtifactStamp {
  crumbtrailNodeVersion: string;
  runId: string;
  sha: string;
  generatedAt: string;
}

function readStamp(): ArtifactStamp {
  const root = path.resolve(packageRoot(), "../..");
  const nodePackage = JSON.parse(
    fs.readFileSync(path.join(root, "packages", "node", "package.json"), "utf8"),
  ) as { version?: string };
  if (!nodePackage.version) throw new Error("crumbtrail-node version is missing.");
  return {
    crumbtrailNodeVersion: nodePackage.version,
    runId: process.env.GITHUB_RUN_ID ?? "local",
    sha: process.env.GITHUB_SHA ?? "local",
    generatedAt: new Date().toISOString(),
  };
}

function stampedReport(report: string, stamp: ArtifactStamp): string {
  const header = [
    `Crumbtrail node package version: ${stamp.crumbtrailNodeVersion}.`,
    `Run: ${stamp.runId}.`,
    `Revision: ${stamp.sha}.`,
    `Generation timestamp: ${stamp.generatedAt}.`,
    "",
  ].join("\n");
  return report.replace("# Incremental yield benchmark report\n\n", `# Incremental yield benchmark report\n\n${header}`);
}

export function comparableBenchmarkReport(report: string): string {
  return report
    .replace(/^Run: .*$/m, "Run: dynamic.")
    .replace(/^Revision: .*$/m, "Revision: dynamic.")
    .replace(/^Generation timestamp: .*$/m, "Generation timestamp: dynamic.");
}

export function generateBenchmarkReport(
  resultFiles: readonly string[],
  outputPath = path.join(packageRoot(), "benchmark", "report.generated.md"),
): string {
  const results = resultFiles.flatMap(readResultFile);
  const report = stampedReport(renderBenchmarkReport(scoreBenchmarkResults(results)), readStamp());
  fs.writeFileSync(outputPath, report);
  return report;
}

export function checkBenchmarkReport(resultFiles: readonly string[]): void {
  const outputPath = path.join(packageRoot(), "benchmark", "report.generated.md");
  if (!fs.existsSync(outputPath)) throw new Error("Generated benchmark report is missing.");
  const results = resultFiles.flatMap(readResultFile);
  const generated = stampedReport(renderBenchmarkReport(scoreBenchmarkResults(results)), readStamp());
  const existing = fs.readFileSync(outputPath, "utf8");
  if (comparableBenchmarkReport(existing) !== comparableBenchmarkReport(generated)) {
    throw new Error("Generated benchmark report is out of date. Run benchmark:report.");
  }
}
