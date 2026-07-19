import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm", "cjs"],
  // Inline install-shared so the packed tarball is self-contained and never
  // `require`s a sibling workspace package at runtime — mirrors packages/node's
  // noExternal:['crumbtrail-core'] pattern.
  noExternal: ["crumbtrail-install-shared", "crumbtrail-detect-core"],
  dts: true,
  clean: true,
});
