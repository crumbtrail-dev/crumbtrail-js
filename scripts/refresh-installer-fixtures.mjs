#!/usr/bin/env node

// Installer-fixture drift detector (CP5 wrap-up).
//
// For each committed fixture that records a real generator (its `provenance` on
// the installer-recipes manifest), re-run that generator in a throwaway temp
// dir, apply the same post-gen + prune steps, and DIFF the result against the
// committed fixture. Any added / removed / changed file is drift — the upstream
// scaffolder has moved and the fixture (and possibly the wizard's assumptions
// about it) may be stale.
//
// Usage:
//   node scripts/refresh-installer-fixtures.mjs                 # all fixtures
//   node scripts/refresh-installer-fixtures.mjs --fixture expo  # just one
//   node scripts/refresh-installer-fixtures.mjs --keep          # keep temp dirs
//
// Exit code: 0 = every checked fixture matched (or was skipped); 1 = drift (or a
// generator error). On drift it prints a `CRUMBTRAIL_FIXTURES_DRIFT` line per
// fixture so CI can grep for it. Fixtures whose `provenance.generator` is null
// (hand-authored: express-cjs, express-esm, fastify, hono, node-plain,
// otlp-fastapi) are SKIPPED — there is nothing to regenerate.
//
// Note: node_modules is never compared (never committed, always pruned). Diff is
// content-based; a bumped upstream dependency version WILL show as drift — that
// is the point of the weekly cron (it opens an issue so a human refreshes).

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { INSTALLER_RECIPES, recipeNames } from "./lib/installer-recipes.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

function log(status, name, detail = "") {
  const writer =
    status === "FAIL" || status === "DRIFT" ? console.error : console.log;
  writer(
    `CRUMBTRAIL_FIXTURES_${status}${name ? ` fixture=${name}` : ""}${detail ? ` ${detail}` : ""}`,
  );
}

function parseArgs(argv) {
  const args = { fixture: undefined, keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--fixture") args.fixture = argv[++i];
    else if (a === "--keep") args.keep = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (args.fixture && !recipeNames().includes(args.fixture)) {
    console.error(
      `--fixture must be one of: ${recipeNames().join(", ")} (got ${args.fixture})`,
    );
    process.exit(2);
  }
  return args;
}

/** Run a shell-ish command (argv split on whitespace; our commands need no quoting). */
function run(commandLine, cwd) {
  const parts = commandLine.split(/\s+/).filter(Boolean);
  const [cmd, ...cmdArgs] = parts;
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", CI: "1" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => child.kill("SIGKILL"), 600_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.once("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: String(err) });
    });
  });
}

/** Recursively list files under `dir` relative to it, skipping node_modules/.git. */
async function listFiles(dir, base = dir, out = []) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, base, out);
    else out.push(path.relative(base, full));
  }
  return out;
}

async function readMaybe(p) {
  try {
    return await fs.readFile(p);
  } catch {
    return null;
  }
}

/** Remove pruned paths (files or dirs) from the freshly generated app dir. */
async function prune(appDir, prunePaths) {
  for (const rel of prunePaths ?? []) {
    await fs
      .rm(path.join(appDir, rel), { recursive: true, force: true })
      .catch(() => {});
  }
}

/** Diff two trees; returns { added, removed, changed } relative-path arrays. */
async function diffTrees(fixtureDir, freshDir) {
  const committed = new Set(await listFiles(fixtureDir));
  const fresh = new Set(await listFiles(freshDir));
  const added = [...fresh].filter((f) => !committed.has(f)).sort();
  const removed = [...committed].filter((f) => !fresh.has(f)).sort();
  const changed = [];
  for (const rel of [...committed].filter((f) => fresh.has(f)).sort()) {
    const a = await readMaybe(path.join(fixtureDir, rel));
    const b = await readMaybe(path.join(freshDir, rel));
    if (!a || !b || !a.equals(b)) changed.push(rel);
  }
  return { added, removed, changed };
}

async function refreshOne(name, tmpRoot) {
  const recipe = INSTALLER_RECIPES[name];
  const prov = recipe?.provenance;
  if (!prov || !prov.generator) {
    log("SKIP", name, "generator=null (hand-authored)");
    return { name, drift: false, skipped: true };
  }

  const work = path.join(tmpRoot, name);
  await fs.mkdir(work, { recursive: true });
  log("START", name, `generator=${JSON.stringify(prov.generator)}`);

  const gen = await run(prov.generator, work);
  if (gen.code !== 0) {
    log(
      "FAIL",
      name,
      `generator exited ${gen.code}: ${JSON.stringify(gen.stderr.slice(-400))}`,
    );
    return { name, drift: true, error: `generator exited ${gen.code}` };
  }

  const appDir = path.join(work, prov.outDir ?? "app");
  for (const cmd of prov.postGen ?? []) {
    const res = await run(cmd, appDir);
    if (res.code !== 0) {
      log("FAIL", name, `postGen '${cmd}' exited ${res.code}`);
      return { name, drift: true, error: `postGen failed` };
    }
  }
  await prune(appDir, prov.prune);

  const { added, removed, changed } = await diffTrees(
    recipe.fixtureDir,
    appDir,
  );
  const drift = added.length + removed.length + changed.length > 0;
  if (drift) {
    log(
      "DRIFT",
      name,
      `added=${added.length} removed=${removed.length} changed=${changed.length}`,
    );
    if (added.length) console.error(`  + ${added.join("\n  + ")}`);
    if (removed.length) console.error(`  - ${removed.join("\n  - ")}`);
    if (changed.length) console.error(`  ~ ${changed.join("\n  ~ ")}`);
  } else {
    log("CLEAN", name, "matches committed fixture");
  }
  return { name, drift };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const names = args.fixture ? [args.fixture] : recipeNames();
  let tmpRoot;
  const results = [];
  try {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bgl-fixtures-"));
    for (const name of names) {
      try {
        results.push(await refreshOne(name, tmpRoot));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log("FAIL", name, `message=${JSON.stringify(message)}`);
        results.push({ name, drift: true, error: message });
      }
    }
  } finally {
    if (tmpRoot && !args.keep) {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  console.log("\nFixture drift report:");
  for (const r of results) {
    const state = r.skipped ? "SKIP " : r.drift ? "DRIFT" : "CLEAN";
    console.log(`  ${state}  ${r.name}${r.error ? `  — ${r.error}` : ""}`);
  }
  const drifted = results.filter((r) => r.drift);
  if (drifted.length > 0) {
    log("DRIFT", "", `fixtures=${drifted.map((r) => r.name).join(",")}`);
    process.exitCode = 1;
  } else {
    log("CLEAN", "", `checked=${results.length}`);
  }
}

main();
