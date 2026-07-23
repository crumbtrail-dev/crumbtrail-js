#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { createReleasePlan, preflightAndPublish, preflightNpmVersions, writePlan } from "./release-plan.mjs";

const execFile = promisify(execFileCallback);
const rootDir = path.resolve(import.meta.dirname, "../..");

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const baseRef = readOption("--base-ref");
const mode = readOption("--mode") ?? "dry-run";
const artifactsDir = path.resolve(rootDir, readOption("--artifacts-dir") ?? ".release-artifacts");
if (!baseRef) throw new Error("Usage: run-release-plan.mjs --base-ref <ref> [--mode dry-run|publish] [--artifacts-dir <dir>]");
if (!["dry-run", "publish"].includes(mode)) throw new Error(`Unsupported release mode: ${mode}`);

const plan = await createReleasePlan({ rootDir, baseRef });
await writePlan(plan, path.join(artifactsDir, "release-plan.json"));
console.log(JSON.stringify(plan, null, 2));

if (plan.packages.length === 0) {
  console.log("No changed public packages selected; skipping npm preflight and release.");
  process.exit(0);
}

await preflightNpmVersions(plan.packages);

if (mode === "dry-run") {
  await fs.rm(artifactsDir, { recursive: true, force: true });
  await fs.mkdir(artifactsDir, { recursive: true });
  await writePlan(plan, path.join(artifactsDir, "release-plan.json"));
  for (const pkg of plan.packages) {
    await execFile("pnpm", ["--dir", path.join(rootDir, pkg.relativeDir), "pack", "--pack-destination", artifactsDir], { stdio: "inherit" });
  }
  console.log(`Inspectable package tarballs written to ${artifactsDir}`);
} else {
  await preflightAndPublish(plan.packages, {
    preflight: preflightNpmVersions,
    publish: async (pkg) => {
    await execFile("pnpm", ["--dir", path.join(rootDir, pkg.relativeDir), "publish", "--access", "public", "--no-git-checks"], {
      stdio: "inherit",
    });
    },
  });
}
