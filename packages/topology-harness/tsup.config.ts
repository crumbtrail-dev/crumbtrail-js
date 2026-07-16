import { defineConfig } from "tsup";

export default defineConfig({
  entry: [
    "src/index.ts",
    "src/generate-matrix.ts",
    "src/generate-matrix-cli.ts",
    "src/benchmark/generate-report.ts",
    "src/benchmark/generate-report-cli.ts",
    "src/benchmark/arm-runner.ts",
    "src/benchmark/arm-runner-cli.ts",
  ],
  format: ["esm"],
  dts: true,
  clean: true,
  external: ["crumbtrail-core", "crumbtrail-node"],
});
