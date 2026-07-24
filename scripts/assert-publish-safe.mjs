#!/usr/bin/env node
/**
 * Refuse to publish a package whose manifest still carries `workspace:` ranges.
 *
 * pnpm rewrites those to real version ranges while packing, so they are correct
 * in source and correct through `pnpm publish` / `pnpm release:plan`. A direct
 * `npm publish` skips the rewrite, and the specifier reaches the registry
 * verbatim as a manifest npm cannot resolve, so every consumer install dies with
 * EUNSUPPORTEDPROTOCOL. npm versions are immutable, so each occurrence burns a
 * version number: crumbtrail-node 0.10.0 and 0.11.0 were both lost this way on
 * 2026-07-23.
 *
 * Wired up as `prepublishOnly` in each publishable package. It runs before
 * packing, which is why it cannot simply reject every `workspace:` range: at
 * that point the good pnpm path still shows them. The package manager running
 * the publish is the thing that decides.
 */
import fs from "node:fs";
import path from "node:path";

const RANGE_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

const manifestPath = path.join(process.cwd(), "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

const offenders = [];
for (const field of RANGE_FIELDS) {
  for (const [name, range] of Object.entries(manifest[field] ?? {})) {
    if (typeof range === "string" && range.startsWith("workspace:")) {
      offenders.push(`${field}.${name} = ${range}`);
    }
  }
}

if (offenders.length === 0) {
  process.exit(0);
}

// pnpm rewrites the ranges above during pack, so they are only a defect when
// something else is doing the publishing.
const agent = process.env.npm_config_user_agent ?? "";
if (agent.startsWith("pnpm/")) {
  process.exit(0);
}

console.error(
  [
    "",
    `Refusing to publish ${manifest.name}@${manifest.version}.`,
    "",
    "These ranges would reach the registry unrewritten:",
    ...offenders.map((entry) => `  ${entry}`),
    "",
    `The publish is running under "${agent || "an unknown package manager"}",`,
    "which does not rewrite the workspace protocol. npm cannot resolve it, so",
    "every consumer install would fail with EUNSUPPORTEDPROTOCOL, and the",
    "version number would be spent: npm versions are immutable.",
    "",
    "Publish through the release workflow instead:",
    "",
    "  pnpm release:plan --base-ref <sha> --mode publish",
    "",
  ].join("\n"),
);
process.exit(1);
