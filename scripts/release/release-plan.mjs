import { execFile as execFileCallback } from "node:child_process";
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

function packageDependencies(pkg) {
  return {
    ...(pkg.dependencies ?? {}),
    ...(pkg.optionalDependencies ?? {}),
    ...(pkg.devDependencies ?? {}),
  };
}

function bundledWorkspaceDependencies(pkg) {
  // The repository documents noExternal choices beside the real option. Strip
  // comments first so an explanatory example cannot become release metadata.
  const config = (pkg.tsupConfig ?? "").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const noExternal = new Set(
    [...config.matchAll(/noExternal\s*:\s*\[([\s\S]*?)\]/g)]
      .flatMap((match) => [...match[1].matchAll(/["']([^"']+)["']/g)].map((entry) => entry[1])),
  );

  return Object.entries(packageDependencies(pkg.manifest))
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
  // A workspace dependency version bump also changes the packed package.json
  // because pnpm rewrites workspace:^ during pack/publish. Add those consumers
  // too, but do not release an external consumer for a source-only dependency
  // change that leaves its packed output identical.
  let added = true;
  while (added) {
    added = false;
    for (const pkg of packages) {
      if (selected.has(pkg.name)) continue;
      const workspaceDependencies = Object.entries(packageDependencies(pkg.manifest))
        .filter(([, version]) => isWorkspaceSpec(version))
        .map(([name]) => name);
      if (
        bundledWorkspaceDependencies(pkg).some((dependency) => selected.has(dependency)) ||
        workspaceDependencies.some((dependency) => versionsChanged.has(dependency))
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

export async function changedFilesSince(rootDir, baseRef) {
  const safeBaseRef = validateBaseRef(baseRef);
  await execFile("git", ["rev-parse", "--verify", "--end-of-options", `${safeBaseRef}^{commit}`], { cwd: rootDir });
  const { stdout } = await execFile("git", ["diff", "--name-only", "--end-of-options", `${safeBaseRef}...HEAD`], { cwd: rootDir });
  return stdout.split("\n").filter(Boolean);
}

async function versionChangedPackageNames(rootDir, baseRef, packages) {
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

export async function createReleasePlan({ rootDir, baseRef, changedFiles } = {}) {
  const safeBaseRef = validateBaseRef(baseRef);
  const packages = await discoverPackages(rootDir);
  const files = changedFiles ?? await changedFilesSince(rootDir, safeBaseRef);
  const versionChanged = await versionChangedPackageNames(rootDir, safeBaseRef, packages);
  const selected = selectReleasePackages({ packages, changedFiles: files, versionChangedPackageNames: versionChanged });
  return {
    baseRef: safeBaseRef,
    changedFiles: files.map(normalisePath),
    versionChangedPackageNames: versionChanged,
    packages: selected.map((pkg) => ({ name: pkg.name, version: pkg.version, relativeDir: pkg.relativeDir })),
  };
}

export async function packageExistsOnNpm(name, version, { exec = execFile } = {}) {
  try {
    await exec("npm", ["view", `${name}@${version}`, "version", "--json"], { maxBuffer: 1024 * 1024 });
    return true;
  } catch (error) {
    // npm returns exit code 1 for a version that does not exist. Connection and
    // registry failures must fail closed, otherwise a release could collide.
    if (error.code === 1 && /E404|404|not found/i.test(`${error.stdout ?? ""}\n${error.stderr ?? ""}`)) return false;
    throw new Error(`Could not verify npm availability for ${name}@${version}: ${error.stderr ?? error.message}`, { cause: error });
  }
}

export async function preflightNpmVersions(packages, options = {}) {
  const collisions = [];
  for (const pkg of packages) {
    if (await packageExistsOnNpm(pkg.name, pkg.version, options)) collisions.push(`${pkg.name}@${pkg.version}`);
  }
  if (collisions.length > 0) {
    throw new Error(`Selected package versions already exist on npm: ${collisions.join(", ")}. Bump them before releasing.`);
  }
}

/**
 * Keep the collision gate adjacent to the only operation that can publish.
 * The injected publisher keeps this ordering testable without touching npm.
 */
export async function preflightAndPublish(packages, { preflight = preflightNpmVersions, publish } = {}) {
  if (typeof publish !== "function") throw new Error("A package publisher is required.");
  await preflight(packages);
  for (const pkg of packages) await publish(pkg);
}

export async function writePlan(plan, outputPath) {
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
}
