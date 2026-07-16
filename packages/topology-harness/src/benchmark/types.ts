export interface RootCauseTruth {
  component: string;
  fault: string;
  evidenceKey: string;
}

export interface BenchmarkRunMetadata {
  modelId: string;
  promptRevision: string;
  promptHash: string;
  tokenBudget: number;
  toolConfigurationId: string;
  arm: "generic" | "crumbtrail";
  bugId: string;
  runIndex: number;
}

export interface BenchmarkRunOutcome {
  rootCauseGuess: RootCauseTruth | null;
  identifiedAtSeconds: number | null;
  tokensToIdentification: number | null;
  confidence: number | null;
}

export interface BenchmarkRunResult {
  metadata: BenchmarkRunMetadata;
  outcome: BenchmarkRunOutcome;
}

export interface BenchmarkResultFile {
  schemaVersion: 2;
  generatedAt: string;
  results: BenchmarkRunResult[];
}
