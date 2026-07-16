import path from "node:path";
import { checkBenchmarkReport, generateBenchmarkReport } from "./generate-report";

const args = process.argv.slice(2);
const check = args.includes("--check");
const resultFiles = args
  .filter((entry) => entry !== "--check")
  .map((entry) => path.resolve(entry));
if (check) checkBenchmarkReport(resultFiles);
else generateBenchmarkReport(resultFiles);
