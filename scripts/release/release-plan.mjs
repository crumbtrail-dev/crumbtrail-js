import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const PACKAGE_JSON = "package.json";
const PACKAGE_DIR = "packages";
function normalisePath(file) {
  return file.split(path.sep).join("/").replace(/^\.\//, "");
}

function packageNameFromPath(file) {
  const match = normalisePath(file).match(/^packages\/([^/]+)\//);
  return match?.[1] ?? null;
}

function isWorkspaceSpec(version) {
  return typeof version === "string" && version.startsWith("workspace:");
}

function runtimeContractDependencies(pkg) {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
    ...(pkg.peerDependencies ?? {}),
  };
}

function runtimeWorkspaceDependencies(pkg) {
  return Object.entries(runtimeContractDependencies(pkg.manifest))
    .filter(([, version]) => isWorkspaceSpec(version))
    .map(([name]) => name);
}

function declaredDependencies(pkg) {
  return {
    ...runtimeContractDependencies(pkg),
    ...(pkg.devDependencies ?? {}),
  };
}

export function declaredWorkspaceDependencies(manifest) {
  return Object.entries(declaredDependencies(manifest))
    .filter(([, version]) => isWorkspaceSpec(version))
    .map(([name]) => name);
}

function bundledWorkspaceDependencies(pkg) {
  // The repository documents noExternal choices beside the real option. Strip
  // comments first so an explanatory example cannot become release metadata.
  const config = (pkg.tsupConfig ?? "").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const noExternal = new Set(
    [...config.matchAll(/noExternal\s*:\s*\[([\s\S]*?)\]/g)]
      .flatMap((match) => [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1])),
  );

  // noExternal affects the packed build even when the imported workspace
  // package is listed as a dev dependency. This is intentionally broader than
  // runtimeContractDependencies: CLI bundles install-shared and detect-core
  // from devDependencies, so their source changes must reach the CLI release.
  return Object.entries(declaredDependencies(pkg.manifest))
    .filter(([name, version]) => isWorkspaceSpec(version) && noExternal.has(name))
    .map(([name]) => name);
}

/**
 * Reads the workspace package graph without relying on pnpm's filtered command
 * syntax. Keeping this data model plain makes the selection policy testable.
 */
export async function discoverPackages(rootDir) {
  const packagesDir = path.join(rootDir, PACKAGE_DIR);
  const entries = await fs.readdir(packagesDir, { withFileTypes: true });
  const packages = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(packagesDir, entry.name);
    const manifestPath = path.join(dir, PACKAGE_JSON);
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
      let tsupConfig = "";
      try {
        tsupConfig = await fs.readFile(path.join(dir, "tsup.config.ts"), "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      packages.push({
        name: manifest.name,
        version: manifest.version,
        private: manifest.private === true,
        dir,
        relativeDir: `${PACKAGE_DIR}/${entry.name}`,
        manifest,
        tsupConfig,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return packages;
}

export function selectReleasePackages({ packages, changedFiles, versionChangedPackageNames = [] }) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const changedDirectories = new Set(changedFiles.map(packageNameFromPath).filter(Boolean));

  const selected = new Set(
    packages
      // Root workspace metadata can change how CI installs or builds packages,
      // but it is not itself part of a package tarball. Selecting every public
      // package for those changes turns an otherwise narrow release into a
      // guaranteed collision. Package source/manifest changes and packed
      // workspace-dependency propagation below are the release inputs.
      .filter((pkg) => changedDirectories.has(pkg.relativeDir.split("/")[1]))
      .map((pkg) => pkg.name),
  );
  const versionsChanged = new Set(versionChangedPackageNames);
  // Build output can contain workspace packages via tsup's noExternal option.
  // A bundled dependency changes the consumer's artifact. A public runtime,
  // optional, or peer workspace dependency whose version changed also changes
  // the consumer's packed contract because pnpm resolves workspace:^ during
  // pack/publish. Dev dependencies intentionally do not propagate releases.
  let added = true;
  while (added) {
    added = false;
    for (const pkg of packages) {
      if (selected.has(pkg.name)) continue;
      if (
        bundledWorkspaceDependencies(pkg).some((dependency) => selected.has(dependency)) ||
        runtimeWorkspaceDependencies(pkg).some((dependency) => versionsChanged.has(dependency))
      ) {
        selected.add(pkg.name);
        added = true;
      }
    }
  }

  return [...selected]
    .map((name) => byName.get(name))
    .filter((pkg) => pkg && !pkg.private)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function validateBaseRef(baseRef) {
  if (typeof baseRef !== "string" || baseRef.length === 0) {
    throw new Error("A base ref is required to create a deterministic release plan.");
  }
  if (baseRef.startsWith("-") || /[\0\s~^:?*[\\]/.test(baseRef) || baseRef.includes("..") || baseRef.includes("@{")) {
    throw new Error(`Invalid base ref: ${JSON.stringify(baseRef)}`);
  }
  return baseRef;
}

/**
 * Release artifacts are deliberately confined to one dedicated repository
 * directory. This guard must run before any recursive cleanup.
 */
export function resolveReleaseArtifactsDir(rootDir, requestedPath = ".release-artifacts") {
  if (
    typeof requestedPath !== "string" ||
    requestedPath.length === 0 ||
    requestedPath === "." ||
    requestedPath === ".." ||
    requestedPath.split(/[\\/]/).includes("..")
  ) {
    throw new Error("Release artifacts must use the dedicated .release-artifacts directory.");
  }

  const resolvedRoot = path.resolve(rootDir);
  const resolvedArtifactsDir = path.resolve(resolvedRoot, requestedPath);
  const dedicatedArtifactsDir = path.join(resolvedRoot, ".release-artifacts");
  if (resolvedArtifactsDir !== dedicatedArtifactsDir) {
    throw new Error(
      `Release artifacts must use ${dedicatedArtifactsDir}; received ${JSON.stringify(requestedPath)}.`,
    );
  }
  return resolvedArtifactsDir;
}

export async function changedFilesSince(rootDir, baseRef) {
  const safeBaseRef = validateBaseRef(baseRef);
  await execFile("git", ["rev-parse", "--verify", "--end-of-options", `${safeBaseRef}^{commit}`], { cwd: rootDir });
  const { stdout } = await execFile("git", ["diff", "--name-only", "--end-of-options", `${safeBaseRef}...HEAD`], { cwd: rootDir });
  return stdout.split("\n").filter(Boolean);
}

async function versionsChangedSince(rootDir, baseRef, packages) {
  if (!baseRef) return [];
  const changed = [];
  for (const pkg of packages) {
    try {
      const { stdout } = await execFile("git", ["show", "--end-of-options", `${baseRef}:${pkg.relativeDir}/package.json`], { cwd: rootDir });
      if (JSON.parse(stdout).version !== pkg.version) changed.push(pkg.name);
    } catch (error) {
      // A package introduced after the base ref has no old manifest. It is
      // already selected when its directory changed, and dependents need its
      // current workspace version written into their packed manifests.
      if (error.code === 128) changed.push(pkg.name);
      else throw error;
    }
  }
  return changed;
}

export function assertVersionedRuntimeConsumers(selected, versionChangedPackageNames) {
  const versionChangedSet = new Set(versionChangedPackageNames);
  const propagatedWithoutVersionBump = selected
    .filter((pkg) => !versionChangedSet.has(pkg.name))
    .filter((pkg) => runtimeWorkspaceDependencies(pkg).some((dependency) => versionChangedSet.has(dependency)));
  if (propagatedWithoutVersionBump.length > 0) {
    throw new Error(
      "A workspace runtime/peer dependency changed version, but its public consumer was not bumped: " +
      `${propagatedWithoutVersionBump.map((pkg) => pkg.name).join(", ")}. ` +
      "Bump each consumer before releasing so its packed contract receives a unique npm version.",
    );
  }
}

export async function createReleasePlan({ rootDir, baseRef, changedFiles } = {}) {
  const safeBaseRef = validateBaseRef(baseRef);
  const packages = await discoverPackages(rootDir);
  const files = changedFiles ?? await changedFilesSince(rootDir, safeBaseRef);
  const versionChanged = await versionsChangedSince(rootDir, safeBaseRef, packages);
  const selected = selectReleasePackages({ packages, changedFiles: files, versionChangedPackageNames: versionChanged });
  assertVersionedRuntimeConsumers(selected, versionChanged);
  return {
    baseRef: safeBaseRef,
    packages: selected.map((pkg) => ({ name: pkg.name, version: pkg.version, relativeDir: pkg.relativeDir })),
  };
}

function isNpmNotFound(error) {
  return error?.code === 1 && /E404|404|not found/i.test(`${error.stdout ?? ""}\n${error.stderr ?? ""}`);
}

/**
 * Returns the registry integrity for an immutable name@version, or null when
 * it has not been published. Registry and malformed-response failures fail
 * closed so a rerun cannot silently overwrite an unknown artifact.
 */
export async function npmPackageIntegrity(name, version, { exec = execFile } = {}) {
  try {
    const { stdout } = await exec("npm", ["view", `${name}@${version}`, "dist.integrity", "--json"], { maxBuffer: 1024 * 1024 });
    const integrity = JSON.parse(stdout);
    if (typeof integrity !== "string" || integrity.length === 0) {
      throw new Error(`npm returned no dist.integrity for existing ${name}@${version}.`);
    }
    return integrity;
  } catch (error) {
    // npm returns exit code 1 for a version that does not exist. Connection and
    // registry failures must fail closed, otherwise a release could collide.
    if (isNpmNotFound(error)) return null;
    if (error.message?.startsWith("npm returned no dist.integrity")) throw error;
    throw new Error(`Could not verify npm integrity for ${name}@${version}: ${error.stderr ?? error.message}`, { cause: error });
  }
}

export async function tarballIntegrity(tarballPath) {
  const archive = await fs.readFile(tarballPath);
  return `sha512-${createHash("sha512").update(archive).digest("base64")}`;
}

/**
 * Packs must complete before this function is called. It inspects every
 * immutable name@version before publishing any new tarball, allowing a failed
 * batch to resume only when the already-published artifact exactly matches the
 * local tarball that this run packed.
 */
export async function preflightAndPublishArtifacts(artifacts, { lookupIntegrity = npmPackageIntegrity, publish } = {}) {
  if (typeof publish !== "function") throw new Error("A package publisher is required.");
  const checked = [];
  for (const artifact of artifacts) {
    if (typeof artifact.integrity !== "string" || artifact.integrity.length === 0) {
      throw new Error(`A local tarball integrity is required for ${artifact.name}@${artifact.version}.`);
    }
    checked.push({ artifact, publishedIntegrity: await lookupIntegrity(artifact.name, artifact.version) });
  }

  const mismatches = checked
    .filter(({ artifact, publishedIntegrity }) => publishedIntegrity !== null && publishedIntegrity !== artifact.integrity)
    .map(({ artifact, publishedIntegrity }) => `${artifact.name}@${artifact.version} (npm ${publishedIntegrity}, local ${artifact.integrity})`);
  if (mismatches.length > 0) {
    throw new Error(`Published package integrity does not match the packed release artifact: ${mismatches.join(", ")}. No packages were published.`);
  }

  const skipped = checked
    .filter(({ publishedIntegrity }) => publishedIntegrity !== null)
    .map(({ artifact }) => artifact);
  const toPublish = checked
    .filter(({ publishedIntegrity }) => publishedIntegrity === null)
    .map(({ artifact }) => artifact);
  for (const artifact of toPublish) await publish(artifact);
  return { published: toPublish, skipped };
}

export function topologicallyOrderReleasePackages(packages, dependenciesByName) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const dependencyCount = new Map();
  const dependents = new Map([...byName.keys()].map((name) => [name, []]));
  const ordered = [];
  const dependenciesFor = (name) => {
    const dependencies = dependenciesByName instanceof Map ? dependenciesByName.get(name) : dependenciesByName?.[name];
    return [...(dependencies ?? [])].filter((dependency) => byName.has(dependency)).sort();
  };

  for (const name of byName.keys()) {
    const dependencies = dependenciesFor(name);
    dependencyCount.set(name, dependencies.length);
    for (const dependency of dependencies) dependents.get(dependency).push(name);
  }
  const ready = [...byName.keys()].filter((name) => dependencyCount.get(name) === 0).sort();
  while (ready.length > 0) {
    const name = ready.shift();
    ordered.push(byName.get(name));
    for (const dependent of dependents.get(name).sort()) {
      const nextCount = dependencyCount.get(dependent) - 1;
      dependencyCount.set(dependent, nextCount);
      if (nextCount === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }
  if (ordered.length !== packages.length) {
    const cycleMembers = [...byName.keys()].filter((name) => dependencyCount.get(name) > 0).sort();
    throw new Error(`Release package dependency cycle detected: ${cycleMembers.join(", ")}.`);
  }
  return ordered;
}

export async function writePlan(plan, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
}
