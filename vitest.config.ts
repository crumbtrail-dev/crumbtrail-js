import { defineConfig } from "vitest/config";

// A root `vitest run` is a workspace run, not an unconfigured recursive scan.
// Keeping the projects under `packages/*` prevents nested tool worktrees (for
// example `.claude/worktrees/**`) from being treated as a second copy of the
// repository, while each package retains its own test environment and setup.
export default defineConfig({
  test: {
    projects: ["packages/*/vitest.config.ts", "scripts/release/vitest.config.ts"],
  },
});
