import {
  BENCHMARK_BUG_CLASSES,
  BENCHMARK_CORPUS,
  corpusBugById,
  type BenchmarkBugClass,
} from "./corpus";
import { benchmarkArmById, BENCHMARK_RUNS_PER_BUG } from "./arms";
import { scorerOnlyTruthForBug } from "./scoring-truth";
import type { BenchmarkRunResult, RootCauseTruth } from "./types";

export interface ArmMetrics {
  runs: number;
  identified: number;
  identificationRate: number | null;
  medianSeconds: number | null;
  medianTokens: number | null;
  incorrectConfidentDiagnoses: number;
}

export interface BugClassScore {
  bugClass: BenchmarkBugClass;
  generic: ArmMetrics;
  crumbtrail: ArmMetrics;
  result: "win" | "loss" | "tie" | "no_data";
  dataQuality: "sufficient" | "insufficient_data";
}

export interface SignificanceSummary {
  method: "exact_mcnemar";
  pairedRuns: number;
  crumbtrailOnlyCorrect: number;
  genericOnlyCorrect: number;
  pValue: number | null;
  significant: boolean;
  threshold: number;
  minimumRunsPerArmPerBug: number;
  verdict: "significant" | "not_significant" | "insufficient_data";
  missingBugClasses: BenchmarkBugClass[];
  underfilledBugIds: string[];
}

export interface BenchmarkScore {
  totalResults: number;
  generic: ArmMetrics;
  crumbtrail: ArmMetrics;
  byBugClass: BugClassScore[];
  significance: SignificanceSummary;
  measured: boolean;
}

interface ClassifiedRun {
  result: BenchmarkRunResult;
  correct: boolean;
  bugClass: BenchmarkBugClass;
}

function sameRootCause(
  guess: RootCauseTruth | null,
  truth: RootCauseTruth,
): boolean {
  return (
    guess !== null &&
    guess.component === truth.component &&
    guess.fault === truth.fault &&
    guess.evidenceKey === truth.evidenceKey
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Reject incomplete arm files before they reach scoring or reporting. */
export function validateBenchmarkRunResult(result: unknown): asserts result is BenchmarkRunResult {
  if (!result || typeof result !== "object") {
    throw new Error("Benchmark result must be an object.");
  }
  const candidate = result as Partial<BenchmarkRunResult>;
  const metadata = candidate.metadata;
  const outcome = candidate.outcome;
  if (!metadata || typeof metadata !== "object" || !outcome || typeof outcome !== "object") {
    throw new Error("Benchmark result requires metadata and outcome.");
  }
  if (
    !isNonEmptyString(metadata.modelId) ||
    !isNonEmptyString(metadata.promptRevision) ||
    !isNonEmptyString(metadata.promptHash) ||
    !Number.isInteger(metadata.tokenBudget) ||
    metadata.tokenBudget <= 0 ||
    !isNonEmptyString(metadata.toolConfigurationId) ||
    (metadata.arm !== "generic" && metadata.arm !== "crumbtrail") ||
    !isNonEmptyString(metadata.bugId) ||
    !Number.isInteger(metadata.runIndex) ||
    metadata.runIndex < 0
  ) {
    throw new Error("Benchmark result is missing required preregistered run metadata.");
  }
  if (benchmarkArmById(metadata.arm).toolConfigurationId !== metadata.toolConfigurationId) {
    throw new Error("Benchmark result uses an unregistered tool configuration.");
  }
  if (
    outcome.rootCauseGuess !== null &&
    (typeof outcome.rootCauseGuess !== "object" ||
      !isNonEmptyString(outcome.rootCauseGuess.component) ||
      !isNonEmptyString(outcome.rootCauseGuess.fault) ||
      !isNonEmptyString(outcome.rootCauseGuess.evidenceKey))
  ) {
    throw new Error("Benchmark result outcome has an invalid root cause guess.");
  }
  for (const value of [outcome.identifiedAtSeconds, outcome.tokensToIdentification, outcome.confidence]) {
    if (value !== null && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("Benchmark result outcome contains a nonfinite metric.");
    }
  }
}

function classifyRuns(results: readonly BenchmarkRunResult[]): ClassifiedRun[] {
  return results.map((result) => {
    validateBenchmarkRunResult(result);
    const bug = corpusBugById(result.metadata.bugId);
    if (!bug) throw new Error(`Unknown benchmark bug id: ${result.metadata.bugId}`);
    const truth = scorerOnlyTruthForBug(result.metadata.bugId);
    if (!truth) throw new Error(`Missing scorer only truth for benchmark bug id: ${result.metadata.bugId}`);
    return {
      result,
      correct: sameRootCause(result.outcome.rootCauseGuess, truth),
      bugClass: bug.bugClass,
    };
  });
}

function runIdentity(run: ClassifiedRun): string {
  const { arm, bugId, runIndex } = run.result.metadata;
  return `${arm}:${bugId}:${runIndex}`;
}

/**
 * A repeated arm, bug, and run index is a repeated observation, not another
 * independent run. Keep the first deterministic occurrence for scoring.
 */
function distinctRuns(runs: readonly ClassifiedRun[]): ClassifiedRun[] {
  const unique = new Map<string, ClassifiedRun>();
  for (const run of runs) {
    const identity = runIdentity(run);
    if (!unique.has(identity)) unique.set(identity, run);
  }
  return [...unique.values()];
}

function assertMatchedControls(generic: ClassifiedRun, crumbtrail: ClassifiedRun): void {
  const genericMetadata = generic.result.metadata;
  const crumbtrailMetadata = crumbtrail.result.metadata;
  const equal =
    genericMetadata.modelId === crumbtrailMetadata.modelId &&
    genericMetadata.promptRevision === crumbtrailMetadata.promptRevision &&
    genericMetadata.promptHash === crumbtrailMetadata.promptHash &&
    genericMetadata.tokenBudget === crumbtrailMetadata.tokenBudget;
  if (!equal) {
    throw new Error(
      `Matched controls differ for ${genericMetadata.bugId} run ${genericMetadata.runIndex}.`,
    );
  }
}

/** Returns only distinct identities that have a valid control in both arms. */
function distinctMatchedRuns(runs: readonly ClassifiedRun[]): ClassifiedRun[] {
  const pairs = new Map<string, Partial<Record<"generic" | "crumbtrail", ClassifiedRun>>>();
  for (const run of distinctRuns(runs)) {
    const { bugId, runIndex, arm } = run.result.metadata;
    const key = `${bugId}:${runIndex}`;
    const pair = pairs.get(key) ?? {};
    pair[arm] = run;
    pairs.set(key, pair);
  }
  const matched: ClassifiedRun[] = [];
  for (const pair of pairs.values()) {
    if (!pair.generic || !pair.crumbtrail) continue;
    assertMatchedControls(pair.generic, pair.crumbtrail);
    matched.push(pair.generic, pair.crumbtrail);
  }
  return matched;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function metricsFor(runs: readonly ClassifiedRun[]): ArmMetrics {
  const identified = runs.filter((run) => run.correct);
  return {
    runs: runs.length,
    identified: identified.length,
    identificationRate: runs.length > 0 ? identified.length / runs.length : null,
    medianSeconds: median(
      identified
        .map((run) => run.result.outcome.identifiedAtSeconds)
        .filter((value): value is number => value !== null),
    ),
    medianTokens: median(
      identified
        .map((run) => run.result.outcome.tokensToIdentification)
        .filter((value): value is number => value !== null),
    ),
    incorrectConfidentDiagnoses: runs.filter(
      (run) => !run.correct && (run.result.outcome.confidence ?? 0) >= 0.8,
    ).length,
  };
}

function compareRates(generic: ArmMetrics, crumbtrail: ArmMetrics): BugClassScore["result"] {
  if (generic.identificationRate === null || crumbtrail.identificationRate === null)
    return "no_data";
  if (crumbtrail.identificationRate > generic.identificationRate) return "win";
  if (crumbtrail.identificationRate < generic.identificationRate) return "loss";
  return "tie";
}

function binomialCoefficient(n: number, k: number): number {
  const useK = Math.min(k, n - k);
  let result = 1;
  for (let index = 1; index <= useK; index += 1) {
    result = (result * (n - useK + index)) / index;
  }
  return result;
}

function exactTwoSidedBinomial(successes: number, trials: number): number | null {
  if (trials === 0) return null;
  const lower = Math.min(successes, trials - successes);
  let tail = 0;
  for (let index = 0; index <= lower; index += 1) {
    tail += binomialCoefficient(trials, index) * 0.5 ** trials;
  }
  return Math.min(1, 2 * tail);
}

function countRuns(
  runs: readonly ClassifiedRun[],
  bugId: string,
  arm: "generic" | "crumbtrail",
): number {
  return runs.filter(
    (run) => run.result.metadata.bugId === bugId && run.result.metadata.arm === arm,
  ).length;
}

function dataQuality(runs: readonly ClassifiedRun[]): {
  missingBugClasses: BenchmarkBugClass[];
  underfilledBugIds: string[];
} {
  const missingBugClasses = BENCHMARK_BUG_CLASSES.filter((bugClass) =>
    !runs.some((run) => run.bugClass === bugClass),
  );
  const underfilledBugIds = BENCHMARK_CORPUS.filter(
    (bug) =>
      countRuns(runs, bug.id, "generic") < BENCHMARK_RUNS_PER_BUG ||
      countRuns(runs, bug.id, "crumbtrail") < BENCHMARK_RUNS_PER_BUG,
  ).map((bug) => bug.id);
  return { missingBugClasses, underfilledBugIds };
}

function pairedSignificance(runs: readonly ClassifiedRun[]): SignificanceSummary {
  const byPair = new Map<string, Partial<Record<"generic" | "crumbtrail", boolean>>>();
  for (const run of runs) {
    const { arm, bugId, runIndex } = run.result.metadata;
    const key = `${bugId}:${runIndex}`;
    const pair = byPair.get(key) ?? {};
    pair[arm] = run.correct;
    byPair.set(key, pair);
  }
  let crumbtrailOnlyCorrect = 0;
  let genericOnlyCorrect = 0;
  let pairedRuns = 0;
  for (const pair of byPair.values()) {
    if (pair.generic === undefined || pair.crumbtrail === undefined) continue;
    pairedRuns += 1;
    if (pair.crumbtrail && !pair.generic) crumbtrailOnlyCorrect += 1;
    if (pair.generic && !pair.crumbtrail) genericOnlyCorrect += 1;
  }
  const quality = dataQuality(runs);
  const pValue = exactTwoSidedBinomial(
    crumbtrailOnlyCorrect,
    crumbtrailOnlyCorrect + genericOnlyCorrect,
  );
  const sufficient =
    quality.missingBugClasses.length === 0 && quality.underfilledBugIds.length === 0;
  const significant = sufficient && pairedRuns >= 30 && pValue !== null && pValue < 0.05;
  return {
    method: "exact_mcnemar",
    pairedRuns,
    crumbtrailOnlyCorrect,
    genericOnlyCorrect,
    pValue,
    significant,
    threshold: 0.05,
    minimumRunsPerArmPerBug: BENCHMARK_RUNS_PER_BUG,
    verdict: !sufficient ? "insufficient_data" : significant ? "significant" : "not_significant",
    missingBugClasses: quality.missingBugClasses,
    underfilledBugIds: quality.underfilledBugIds,
  };
}

export function scoreBenchmarkResults(results: readonly BenchmarkRunResult[]): BenchmarkScore {
  const classified = distinctMatchedRuns(classifyRuns(results));
  const armRuns = (arm: "generic" | "crumbtrail") =>
    classified.filter((run) => run.result.metadata.arm === arm);
  const byBugClass = BENCHMARK_BUG_CLASSES.map((bugClass) => {
    const generic = metricsFor(armRuns("generic").filter((run) => run.bugClass === bugClass));
    const crumbtrail = metricsFor(armRuns("crumbtrail").filter((run) => run.bugClass === bugClass));
    const classBugs = BENCHMARK_CORPUS.filter((bug) => bug.bugClass === bugClass);
    const classSufficient = classBugs.every(
      (bug) =>
        countRuns(classified, bug.id, "generic") >= BENCHMARK_RUNS_PER_BUG &&
        countRuns(classified, bug.id, "crumbtrail") >= BENCHMARK_RUNS_PER_BUG,
    );
    return {
      bugClass,
      generic,
      crumbtrail,
      result: compareRates(generic, crumbtrail),
      dataQuality: classSufficient ? "sufficient" : "insufficient_data",
    } satisfies BugClassScore;
  });
  return {
    totalResults: classified.length,
    generic: metricsFor(armRuns("generic")),
    crumbtrail: metricsFor(armRuns("crumbtrail")),
    byBugClass,
    significance: pairedSignificance(classified),
    measured: classified.length > 0,
  };
}

function percent(value: number | null): string {
  return value === null ? "Not available" : `${(value * 100).toFixed(1)}%`;
}

function metricValue(value: number | null, suffix = ""): string {
  return value === null ? "Not available" : `${value}${suffix}`;
}

function renderMetrics(metrics: ArmMetrics): string {
  return [
    `${metrics.identified}/${metrics.runs} identified`,
    percent(metrics.identificationRate),
    `median ${metricValue(metrics.medianSeconds, " seconds")}`,
    `median ${metricValue(metrics.medianTokens, " tokens")}`,
    `${metrics.incorrectConfidentDiagnoses} incorrect confident diagnoses`,
  ].join("; ");
}

export function renderBenchmarkReport(score: BenchmarkScore): string {
  const lines = [
    "# Incremental yield benchmark report",
    "",
    "This report is generated from supplied arm result files. Do not hand edit it.",
    "",
    "## Scope",
    "",
    `Corpus bugs: ${BENCHMARK_CORPUS.length}. Supplied run results: ${score.totalResults}.`,
    "",
  ];
  if (!score.measured) {
    lines.push(
      "No arm results were supplied. This is an empty result report, not a measured claim.",
      "An outsider can run the preregistered arms with an independently chosen coding agent and pass the result files to the scorer.",
      "",
      "## Fixed analysis",
      "",
      "The scorer compares exact machine checked root causes, records time and tokens to identification, and counts confident incorrect diagnoses.",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push(
    "## Overall results",
    "",
    `Generic arm: ${renderMetrics(score.generic)}.`,
    `Crumbtrail arm: ${renderMetrics(score.crumbtrail)}.`,
    "",
    "## Results by bug class",
    "",
    "| Bug class | Generic arm | Crumbtrail arm | Result | Data quality |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const entry of score.byBugClass) {
    lines.push(
      `| ${entry.bugClass} | ${renderMetrics(entry.generic)} | ${renderMetrics(entry.crumbtrail)} | ${entry.result} | ${entry.dataQuality === "insufficient_data" ? "Insufficient data, no significance claim" : "Sufficient"} |`,
    );
  }
  const significance = score.significance;
  lines.push("", "## Statistical summary", "");
  if (significance.verdict === "insufficient_data") {
    lines.push(
      `Insufficient data, no significance claim. Each arm needs ${significance.minimumRunsPerArmPerBug} runs for every corpus bug and every bug class must have data.`,
      `Missing bug classes: ${significance.missingBugClasses.join(", ") || "none"}. Underfilled bugs: ${significance.underfilledBugIds.length}.`,
    );
  } else if (significance.pValue === null) {
    lines.push(
      `Matched runs: ${significance.pairedRuns}. No discordant matched results are available for the exact McNemar test.`,
    );
  } else {
    lines.push(
      `Matched runs: ${significance.pairedRuns}. Crumbtrail only correct: ${significance.crumbtrailOnlyCorrect}. Generic only correct: ${significance.genericOnlyCorrect}. Exact McNemar two sided p value: ${significance.pValue.toFixed(4)}.`,
      significance.significant
        ? "The preregistered threshold is met."
        : "The preregistered threshold is not met. This result is not statistically significant.",
    );
  }
  lines.push(
    "",
    "Interpret any concentration in request keyed row diff or cross release behavior classes from the table above. The report publishes losses and ties as well as wins.",
  );
  return `${lines.join("\n")}\n`;
}
