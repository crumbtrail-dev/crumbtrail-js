export interface BenchmarkArm {
  id: "generic" | "crumbtrail";
  label: string;
  modelPolicy: string;
  promptTokenBudget: number;
  runsPerBug: number;
  toolConfigurationId: string;
  tools: readonly string[];
}

export const BENCHMARK_PROMPT_TOKEN_BUDGET = 16_000;
export const BENCHMARK_RUNS_PER_BUG = 10;

export const BENCHMARK_ARMS: readonly BenchmarkArm[] = [
  {
    id: "generic",
    label: "Coding agent with the generic stack",
    modelPolicy: "Use one operator selected model for both arms in a run set.",
    promptTokenBudget: BENCHMARK_PROMPT_TOKEN_BUDGET,
    runsPerBug: BENCHMARK_RUNS_PER_BUG,
    toolConfigurationId: "generic_stack_v1",
    tools: ["repo MCP", "Sentry", "Datadog", "Jira"],
  },
  {
    id: "crumbtrail",
    label: "Coding agent with the generic stack and Crumbtrail",
    modelPolicy: "Use the same operator selected model as the generic arm.",
    promptTokenBudget: BENCHMARK_PROMPT_TOKEN_BUDGET,
    runsPerBug: BENCHMARK_RUNS_PER_BUG,
    toolConfigurationId: "crumbtrail_stack_v1",
    tools: ["repo MCP", "Sentry", "Datadog", "Jira", "Crumbtrail bundle", "Crumbtrail MCP"],
  },
];

export function benchmarkArmById(id: BenchmarkArm["id"]): BenchmarkArm {
  const arm = BENCHMARK_ARMS.find((candidate) => candidate.id === id);
  if (!arm) throw new Error(`Unknown benchmark arm: ${id}`);
  return arm;
}
