#!/usr/bin/env node
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
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

const rootDir = path.resolve(import.meta.dirname, "../..");

// execFile always pipes; it has no stdio option, so passing `stdio: "inherit"`
// to it silently does nothing. A piped child has no TTY, and npm two-factor
// publishes need one to prompt for the one-time password, which fails as
// ERR_PNPM_OTP_NON_INTERACTIVE. Use spawn so pnpm inherits this terminal.
function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) return resolve();
      const detail = signal ? `signal ${signal}` : `exit code ${code}`;
      reject(new Error(`${command} ${args.join(" ")} failed with ${detail}`));
    });
  });
}

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
    await run("pnpm", ["--dir", path.join(rootDir, pkg.relativeDir), "pack", "--pack-destination", artifactsDir]);
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
      await run("pnpm", ["publish", artifact.tarballPath, "--access", "public", "--no-git-checks"], {
        cwd: rootDir,
      });
    },
  });
  for (const artifact of result.skipped) console.log(`Skipping ${artifact.name}@${artifact.version}: published tarball integrity matches.`);
  console.log(`Published ${result.published.length} package(s); safely skipped ${result.skipped.length} matching package(s).`);
}
