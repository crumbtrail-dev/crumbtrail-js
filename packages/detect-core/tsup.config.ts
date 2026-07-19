import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/testing.ts"],
  format: ["esm", "cjs"],
  // crumbtrail-core is deliberately NOT bundled. Our own source uses it only as
  // `import type { Stack }`, and the one real runtime value we need (STACK_IDS,
  // reached through the inlined install-shared) is a single array. Bundling it
  // pulled the entire browser SDK in, including an orphaned shadow DOM
  // bug-widget chunk that nothing referenced and that we then published. It is
  // a declared dependency instead, so both the runtime import and the emitted
  // declarations resolve for consumers.
  noExternal: ["crumbtrail-install-shared"],
  dts: true,
  clean: true,
});
