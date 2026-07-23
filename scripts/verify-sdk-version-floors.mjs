#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, "..");
const registryPath = path.join(rootDir, "packages/detect-core/src/recipe-registry.ts");

function propertyName(property) {
  if (!property.name) return undefined;
  if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) return property.name.text;
  return undefined;
}

function stringArray(node, context) {
  if (!ts.isArrayLiteralExpression(node) || !node.elements.every(ts.isStringLiteral)) {
    throw new Error(`${context} must be a static array of package-name strings.`);
  }
  return node.elements.map((element) => element.text);
}

function staticStringRecord(node, context) {
  if (!ts.isObjectLiteralExpression(node)) {
    throw new Error(`${context} must be a static object literal.`);
  }
  const result = new Map();
  for (const property of node.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.initializer)) {
      throw new Error(`${context} must contain only string-valued properties.`);
    }
    const name = propertyName(property);
    if (!name) throw new Error(`${context} contains an unsupported property name.`);
    result.set(name, property.initializer.text);
  }
  return result;
}

async function workspaceVersions() {
  const packagesDir = path.join(rootDir, "packages");
  const entries = await fs.readdir(packagesDir, { withFileTypes: true });
  const versions = new Map();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(packagesDir, entry.name, "package.json"), "utf8"));
      if (typeof manifest.name === "string" && typeof manifest.version === "string") {
        versions.set(manifest.name, manifest.version);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return versions;
}

async function main() {
  const source = await fs.readFile(registryPath, "utf8");
  const file = ts.createSourceFile(registryPath, source, ts.ScriptTarget.Latest, true);
  let floors;
  const installerPackages = new Set();

  function visit(node) {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "SDK_VERSION_FLOORS" &&
      node.initializer
    ) {
      floors = staticStringRecord(node.initializer, "SDK_VERSION_FLOORS");
    }
    if (ts.isPropertyAssignment(node) && propertyName(node) === "sdkPackages") {
      for (const packageName of stringArray(node.initializer, "RECIPE_REGISTRY.sdkPackages")) {
        installerPackages.add(packageName);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);

  if (!floors) throw new Error("Could not find SDK_VERSION_FLOORS in the installer registry.");
  const versions = await workspaceVersions();
  const expected = [...installerPackages].sort();
  const actual = [...floors.keys()].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`SDK_VERSION_FLOORS keys must exactly match installer-managed packages. expected=${expected.join(",")} actual=${actual.join(",")}`);
  }
  for (const packageName of expected) {
    const workspaceVersion = versions.get(packageName);
    if (!workspaceVersion) throw new Error(`${packageName} is installer-managed but has no workspace package manifest.`);
    if (floors.get(packageName) !== workspaceVersion) {
      throw new Error(`${packageName} floor ${floors.get(packageName)} drifted from workspace version ${workspaceVersion}.`);
    }
  }
  console.log(`CRUMBTRAIL_SDK_VERSION_FLOORS_PASS packages=${expected.map((name) => `${name}@${floors.get(name)}`).join(",")}`);
}

main().catch((error) => {
  console.error(`CRUMBTRAIL_SDK_VERSION_FLOORS_FAIL ${error.message}`);
  process.exitCode = 1;
});
