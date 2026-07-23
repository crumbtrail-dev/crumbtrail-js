#!/usr/bin/env node
import { execFile as execFileCallback } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import {
  createReleasePlan,
  declaredWorkspaceDependencies,
  discoverPackages,
  npmPackageIntegrity,
  preflightAndPublishArtifacts,
  resolveReleaseArtifactsDir,
  tarballIntegrity,
  topologicallyOrderReleasePackages,
  writePlan,
} from "./release-plan.mjs";

const execFile = promisify(execFileCallback);
const rootDir = path.resolve(import.meta.dirname, "../..");

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const baseRef = readOption("--base-ref");
const mode = readOption("--mode") ?? "dry-run";
const artifactsDir = resolveReleaseArtifactsDir(rootDir, readOption("--artifacts-dir") ?? ".release-artifacts");
if (!baseRef) throw new Error("Usage: run-release-plan.mjs --base-ref <ref> [--mode dry-run|publish] [--artifacts-dir <dir>]");
if (!["dry-run", "publish"].includes(mode)) throw new Error(`Unsupported release mode: ${mode}`);

const plan = await createReleasePlan({ rootDir, baseRef });
console.log(JSON.stringify(plan, null, 2));

if (plan.packages.length === 0) {
  console.log("No changed public packages selected; skipping package and release work.");
  process.exit(0);
}

// This directory was validated before it became an fs.rm target. Do not move
// the cleanup above resolveReleaseArtifactsDir.
await fs.rm(artifactsDir, { recursive: true, force: true });
await fs.mkdir(artifactsDir, { recursive: true });
await writePlan(plan, path.join(artifactsDir, "release-plan.json"));

async function packReleaseArtifacts(packages) {
  const artifacts = [];
  for (const pkg of packages) {
    const before = new Set(await fs.readdir(artifactsDir));
    await execFile("pnpm", ["--dir", path.join(rootDir, pkg.relativeDir), "pack", "--pack-destination", artifactsDir], { stdio: "inherit" });
    const createdTarballs = (await fs.readdir(artifactsDir))
      .filter((entry) => entry.endsWith(".tgz") && !before.has(entry));
    if (createdTarballs.length !== 1) {
      throw new Error(`Expected pnpm pack to create exactly one tarball for ${pkg.name}; found ${createdTarballs.join(", ") || "none"}.`);
    }
    const tarballPath = path.join(artifactsDir, createdTarballs[0]);
    artifacts.push({ ...pkg, tarballPath, integrity: await tarballIntegrity(tarballPath) });
  }
  return artifacts;
}

// Pack the complete release before looking at npm or publishing anything. The
// local SRIs below are the immutable artifacts used for a safe partial rerun.
const artifacts = await packReleaseArtifacts(plan.packages);

if (mode === "dry-run") {
  console.log(`Inspectable package tarballs written to ${artifactsDir}`);
} else {
  const workspacePackages = await discoverPackages(rootDir);
  const dependenciesByName = new Map(workspacePackages.map((pkg) => [
    pkg.name,
    declaredWorkspaceDependencies(pkg.manifest),
  ]));
  const artifactsByName = new Map(artifacts.map((artifact) => [artifact.name, artifact]));
  const orderedArtifacts = topologicallyOrderReleasePackages(plan.packages, dependenciesByName)
    .map((pkg) => artifactsByName.get(pkg.name));
  const result = await preflightAndPublishArtifacts(orderedArtifacts, {
    lookupIntegrity: npmPackageIntegrity,
    publish: async (artifact) => {
      await execFile("pnpm", ["publish", artifact.tarballPath, "--access", "public", "--no-git-checks"], {
        cwd: rootDir,
        stdio: "inherit",
      });
    },
  });
  for (const artifact of result.skipped) console.log(`Skipping ${artifact.name}@${artifact.version}: published tarball integrity matches.`);
  console.log(`Published ${result.published.length} package(s); safely skipped ${result.skipped.length} matching package(s).`);
}
