import path from "node:path";
import { pathToFileURL } from "node:url";
import { runBenchmarkArms, type BenchmarkAgentAdapter } from "./arm-runner";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const adapterPath = option("--adapter");
const output = option("--output");
const modelId = option("--model");
const promptRevision = option("--prompt-revision") ?? "preregistration_v1";
const runsValue = option("--runs");

if (!adapterPath || !output || !modelId) {
  throw new Error(
    "Usage: benchmark:run --adapter path/to/adapter.mjs --output path/to/results.json --model model_id [--prompt-revision revision] [--runs count]",
  );
}

const module = await import(pathToFileURL(path.resolve(adapterPath)).href);
const adapter = (module.default ?? module.adapter) as BenchmarkAgentAdapter | undefined;
if (!adapter || typeof adapter.run !== "function") {
  throw new Error("The adapter module must export a default or named adapter with a run function.");
}

await runBenchmarkArms({
  adapter,
  outputPath: path.resolve(output),
  modelId,
  promptRevision,
  ...(runsValue ? { runCount: Number(runsValue) } : {}),
});
