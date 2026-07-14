#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function phaseLog(phase, status, detail = "", writer = console.log) {
  writer(
    `CRUMBTRAIL_PACK_LOCAL_${status.toUpperCase()} phase=${phase}${detail ? ` ${detail}` : ""}`,
  );
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const finalArgs =
      command === "pnpm"
        ? ["--config.verify-deps-before-run=false", ...args]
        : args;
    const child = spawn(command, finalArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("exit", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else
        reject(
          new Error(
            `${command} ${finalArgs.join(" ")} exited ${code}\n${stderr.slice(-1500)}`,
          ),
        );
    });
  });
}

async function packOne(packageDir, outDir) {
  const before = new Set(await fs.readdir(outDir));
  await run("pnpm", ["pack", "--pack-destination", outDir], packageDir);
  const created = (await fs.readdir(outDir)).filter(
    (file) => file.endsWith(".tgz") && !before.has(file),
  );
  if (created.length !== 1) {
    throw new Error(
      `expected exactly one new tarball from ${packageDir}, found ${created.length}`,
    );
  }
  return path.join(outDir, created[0]);
}

/**
 * Pack an OPTIONAL package (react-native / tauri). Unlike the core trio, a
 * failure here must NOT sink the whole pack — these SDKs are secondary
 * distribution channels, and a fresh clone should still get a working
 * core/node/cli installer even if an RN/tauri build is briefly broken. Builds
 * then packs; on any failure logs a WARN and returns undefined so the caller
 * simply omits the key from the manifest.
 */
async function packOptional({ filter, packageDir, outDir, logFn }) {
  try {
    await run("pnpm", ["--filter", filter, "build"], repoRoot);
    return await packOne(packageDir, outDir);
  } catch (err) {
    logFn(
      "pack-optional",
      "warn",
      `filter=${filter} skipped=${JSON.stringify(err instanceof Error ? err.message : String(err)).slice(0, 300)}`,
    );
    return undefined;
  }
}

export async function packLocal({ outDir, logFn = phaseLog }) {
  await fs.mkdir(outDir, { recursive: true });
  logFn(
    "build",
    "start",
    "packages=crumbtrail-core,crumbtrail-node,crumbtrail-design-system,crumbtrail-install-shared,crumbtrail",
  );
  await run("pnpm", ["--filter", "crumbtrail-core", "build"], repoRoot);
  await run("pnpm", ["--filter", "crumbtrail-node", "build"], repoRoot);
  // The CLI (package name `crumbtrail`) depends on the design system and the
  // shared install-instruction builders — both must be built before `pnpm
  // pack` can resolve the CLI's workspace deps into its bundle.
  await run(
    "pnpm",
    ["--filter", "crumbtrail-design-system", "build"],
    repoRoot,
  );
  await run(
    "pnpm",
    ["--filter", "crumbtrail-install-shared", "build"],
    repoRoot,
  );
  await run("pnpm", ["--filter", "crumbtrail", "build"], repoRoot);
  logFn("build", "pass");

  logFn("pack", "start", `out=${outDir}`);
  // Core trio: all-or-nothing. A failure here throws and fails the whole pack —
  // the install-routes gate keys on core/node/cli only.
  const core = await packOne(path.join(repoRoot, "packages", "core"), outDir);
  const node = await packOne(path.join(repoRoot, "packages", "node"), outDir);
  const cli = await packOne(path.join(repoRoot, "packages", "cli"), outDir);
  logFn(
    "pack",
    "pass",
    `core=${path.basename(core)} node=${path.basename(node)} cli=${path.basename(cli)}`,
  );

  // Optional SDK channels: react + react-native + tauri. Best-effort — a
  // missing/broken pack warns and is simply absent from the manifest (the
  // installer stays fully functional for the core trio; the wizard's tarball
  // fallback for that SDK is just unavailable until the pack succeeds).
  const react = await packOptional({
    filter: "crumbtrail-react",
    packageDir: path.join(repoRoot, "packages", "react"),
    outDir,
    logFn,
  });
  const reactNative = await packOptional({
    filter: "crumbtrail-react-native",
    packageDir: path.join(repoRoot, "packages", "react-native"),
    outDir,
    logFn,
  });
  const tauri = await packOptional({
    filter: "crumbtrail-tauri",
    packageDir: path.join(repoRoot, "packages", "tauri"),
    outDir,
    logFn,
  });
  logFn(
    "pack-optional",
    "pass",
    `react=${react ? path.basename(react) : "(absent)"} reactNative=${reactNative ? path.basename(reactNative) : "(absent)"} tauri=${tauri ? path.basename(tauri) : "(absent)"}`,
  );

  const manifest = {
    schemaVersion: "pack-local.v1",
    ranAt: new Date().toISOString(),
    core,
    node,
    cli,
    // Optional keys — present only when the pack succeeded. Consumers must treat
    // them as absent-by-default (install-routes omits them; the CLI's tarball
    // discovery only resolves them when listed).
    ...(react ? { react } : {}),
    ...(reactNative ? { reactNative } : {}),
    ...(tauri ? { tauri } : {}),
  };
  const manifestPath = path.join(outDir, "pack-manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ...manifest, manifestPath };
}

function usage() {
  console.error("Usage: node scripts/pack-local.mjs --out <dir>");
  process.exit(2);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const outIdx = process.argv.indexOf("--out");
  const outDir = outIdx >= 0 ? process.argv[outIdx + 1] : undefined;
  if (!outDir) usage();
  packLocal({ outDir: path.resolve(outDir) })
    .then((result) => {
      console.log(
        `CRUMBTRAIL_PACK_LOCAL_PASS core=${result.core} node=${result.node} cli=${result.cli} manifest=${result.manifestPath}`,
      );
    })
    .catch((err) => {
      console.error(
        `CRUMBTRAIL_PACK_LOCAL_FAIL phase=unexpected message=${JSON.stringify(err instanceof Error ? err.message : String(err))}`,
      );
      process.exit(1);
    });
}
