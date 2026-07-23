import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  // Intentional dual topology: core is INLINED here so the built server files never `require`
  // crumbtrail-core at runtime (node stays self-contained even if a consumer's core copy drifts).
  // package.json ALSO declares crumbtrail-core as a real dependency (workspace:^ -> the current Core caret range on pack)
  // so `npm i crumbtrail-node` pulls core into node_modules for the browser SDK half of the
  // quickstart. Net: node's runtime uses the inlined copy; the installed copy is for the consumer's
  // own browser code. Don't "clean up" the dependency to match the bundling — verify-fresh-install
  // enforces both halves on purpose.
  noExternal: ["crumbtrail-core"],
  dts: true,
  clean: true,
});
