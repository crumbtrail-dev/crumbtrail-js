import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "release-scripts",
    include: ["scripts/release/**/*.test.mjs"],
  },
});
