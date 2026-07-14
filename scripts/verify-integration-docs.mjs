#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_RECIPES,
  renderProviderDoc,
  renderProviderReadme,
} from "../packages/node/dist/index.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const integrationsDir = path.join(repoRoot, "docs", "integrations");
const write = process.argv.includes("--write");

async function checkFile(filePath, expected) {
  let actual = "";
  try {
    actual = await fs.readFile(filePath, "utf8");
  } catch {
    actual = "";
  }
  if (actual === expected) return false;
  if (!write) {
    throw new Error(
      `${path.relative(repoRoot, filePath)} drifted from provider recipes; run: pnpm --filter crumbtrail-node build && node scripts/verify-integration-docs.mjs --write`,
    );
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, expected);
  return true;
}

try {
  let changed = false;
  changed =
    (await checkFile(
      path.join(integrationsDir, "README.md"),
      renderProviderReadme(),
    )) || changed;
  for (const recipe of PROVIDER_RECIPES) {
    changed =
      (await checkFile(
        path.join(integrationsDir, recipe.docFile),
        renderProviderDoc(recipe.id),
      )) || changed;
  }
  console.log(
    `CRUMBTRAIL_INTEGRATION_DOCS_PASS phase=${changed ? "write" : "lockstep"}`,
  );
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `CRUMBTRAIL_INTEGRATION_DOCS_FAIL phase=lockstep message=${JSON.stringify(message)}`,
  );
  process.exit(1);
}
