#!/usr/bin/env node

// Installer regression harness (CP0 skeleton).
//
// For each recipe: pack the SDK+CLI locally, stand up a fresh temp app from a
// real fixture, drive the REAL setup wizard against a stub cloud, then assert the
// wiring actually landed (entry file wired + .env + ingest key) and an AUTHED
// session reached the ingest stub. The install-order and wizardStart-poll fixes
// are exercised for real because the pipeline runs the wizard's own exported
// functions (defaultDeps() from packages/cli/dist), not a re-implementation.
//
// House style mirrors scripts/verify-quickstart-timed.mjs: mkdtemp + kill-before-
// run + finally cleanup, phase logs, non-zero exit on FAIL.
//
// Modes:
//   inproc (default) — drive runWizard(dist) with injected deps. Deterministic;
//                      this is the RED→GREEN gate for the six flow fixes.
//   binary           — spawn the packed `crumbtrail` bin end-to-end (real SDK
//                      install via the /install tarball fallback, fix #5).

import fs from "node:fs/promises";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { packLocal } from "./pack-local.mjs";
import { createIngestRecorder } from "./lib/stub-ingest.mjs";
import { seedAuthCache, startStubCloud } from "./lib/stub-cloud.mjs";
import { getRecipe, recipeNames } from "./lib/installer-recipes.mjs";
import { loadAndCapture } from "./lib/browser-load.mjs";
import { startCorsProxy } from "./lib/cors-proxy.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const cliDist = path.join(repoRoot, "packages", "cli", "dist");

function phase(status, name, detail = "") {
  const writer = status === "FAIL" ? console.error : console.log;
  writer(
    `CRUMBTRAIL_INSTALLERS_${status} phase=${name}${detail ? ` ${detail}` : ""}`,
  );
}

function parseArgs(argv) {
  const args = { recipe: undefined, keep: false, mode: "inproc" };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--recipe") args.recipe = argv[++i];
    else if (a === "--keep") args.keep = true;
    else if (a === "--mode") args.mode = argv[++i];
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (args.recipe && !recipeNames().includes(args.recipe)) {
    console.error(
      `--recipe must be one of: ${recipeNames().join(", ")} (got ${args.recipe})`,
    );
    process.exit(2);
  }
  if (!["inproc", "binary"].includes(args.mode)) {
    console.error(`--mode must be inproc|binary (got ${args.mode})`);
    process.exit(2);
  }
  return args;
}

function run(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd ?? repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, NO_COLOR: "1", ...opts.env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      opts.timeoutMs ?? 300_000,
    );
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function captureUi() {
  const lines = [];
  return {
    lines,
    ui: { out: (l = "") => lines.push(l), err: (l = "") => lines.push(l) },
  };
}

const noopPrompter = {
  ask: async (_q, d) => d ?? "",
  confirm: async (_q, d) => d ?? true,
  select: async (_q, _l, d) => d ?? 0,
};

/** Copy a fixture into `appDir` and install its real deps from the lockfile. */
async function materializeFixture(fixtureDir, appDir) {
  await fs.cp(fixtureDir, appDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`),
  });
  const install = await run("npm", ["install", "--no-audit", "--no-fund"], {
    cwd: appDir,
  });
  if (install.code !== 0) {
    throw new Error(
      `npm install failed in fixture app (${install.code}): ${install.stderr.slice(-800)}`,
    );
  }
}

/**
 * The "seeded tarball install" stub: simulate a SUCCESSFUL SDK install by adding
 * the SDK packages to package.json (and node_modules stubs). This is exactly the
 * state that makes the current (pre-fix) wizard self-cancel injection, because
 * buildPlan's project-level idempotency then sees crumbtrail-* already present.
 */
function makeSeedingInstallSdk() {
  return function installSdk(input) {
    const pkgPath = path.join(input.cwd, "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.dependencies = pkg.dependencies ?? {};
    const packages =
      input.recipe === "otlp" ? [] : ["crumbtrail-core", "crumbtrail-node"];
    for (const name of packages) {
      pkg.dependencies[name] = "0.1.0";
      const modDir = path.join(input.cwd, "node_modules", name);
      mkdirSync(modDir, { recursive: true });
      writeFileSync(
        path.join(modDir, "package.json"),
        JSON.stringify({ name, version: "0.1.0" }),
      );
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
    return { installed: packages.length > 0, packages };
  };
}

async function readFileSafe(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    return null;
  }
}

/** Drive the wizard in-process against dist, with injected stub deps. */
async function runRecipeInproc({ name, packed, tmpRoot }) {
  const recipe = getRecipe(name);
  const appDir = path.join(tmpRoot, name, "app");
  const xdgDir = path.join(tmpRoot, name, "xdg");
  await fs.mkdir(appDir, { recursive: true });
  await fs.mkdir(xdgDir, { recursive: true });

  phase("START", `${name}:materialize`, `app=${appDir}`);
  await materializeFixture(recipe.fixtureDir, appDir);
  phase("PASS", `${name}:materialize`);

  const tarballsDir = path.dirname(packed.manifestPath);
  const ingest = createIngestRecorder();
  const stub = await startStubCloud({
    ingest,
    tarballsDir,
    autoRealSession: true,
  });
  phase("PASS", `${name}:stub-cloud`, `base=${stub.baseUrl}`);

  // Seed the login cache so the non-TTY run skips the browser/device flow.
  seedAuthCache(xdgDir, { base: stub.baseUrl, token: "bl_cli_seeded_token" });
  // A STALE pre-wizardStart real session: the wizardStart poll filter must
  // ignore it (current code wrongly accepts it — that is fix #4's target).
  const staleId = "ses_stub_stale_pre_wizard";
  stub.seedSession({ id: staleId, startedAt: Date.now() - 3_600_000 });

  const distCli = await import(
    pathToFileURL(path.join(cliDist, "cli.js")).href
  );
  const { runWizard, defaultDeps } = distCli;
  const realDeps = defaultDeps();

  // expectedPlanKind precheck: the REAL buildPlan on the clean fixture.
  const detected = realDeps.detect(appDir);
  if (detected.recipe !== recipe.recipe) {
    throw new Error(
      `detect() returned '${detected.recipe}', expected '${recipe.recipe}'`,
    );
  }
  const preflightPlan = realDeps.buildPlan({
    cwd: appDir,
    recipe: detected.recipe,
    endpoint: stub.baseUrl,
    apiKey: stub.apiKey,
    entryFile: detected.entryFile,
    nextVersion: detected.nextVersion,
    stack: detected.otlpStack ?? undefined,
    options: { force: true },
  });
  if (preflightPlan.kind !== recipe.expectedPlanKind) {
    throw new Error(
      `expected plan kind '${recipe.expectedPlanKind}', buildPlan produced '${preflightPlan.kind}'`,
    );
  }
  phase("PASS", `${name}:plan`, `kind=${preflightPlan.kind}`);

  const { ui, lines } = captureUi();
  let wizardStartForwarded = false;
  const deps = {
    ...realDeps,
    cwd: appDir,
    isTTY: false,
    ui,
    prompter: noopPrompter,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgDir,
      HOME: xdgDir,
      CRUMBTRAIL_BASE_URL: stub.baseUrl,
      NO_COLOR: "1",
    },
    installSdk: makeSeedingInstallSdk(),
    openBrowserFn: async () => false,
    // Forward whatever runWizard passes (post-fix: wizardStart) to the REAL
    // poller, but on a fast budget so the harness is not glacial.
    pollForRealEvent: (o) => {
      if (typeof o.wizardStart === "number") wizardStartForwarded = true;
      return realDeps.pollForRealEvent({
        ...o,
        config: { initialDelayMs: 50, maxDelayMs: 100, timeoutMs: 8_000 },
      });
    },
  };

  const parsed = {
    command: "wizard",
    yes: true,
    project: stub.projectId,
    noBrowser: true,
    skipVerify: false,
    endpoint: stub.baseUrl,
  };

  phase("START", `${name}:wizard`, `mode=inproc`);
  const code = await runWizard(parsed, deps);
  if (code !== 0) {
    throw new Error(
      `runWizard exited ${code}\n${lines.join("\n").slice(-1200)}`,
    );
  }
  phase("PASS", `${name}:wizard`);

  // ── assertions ─────────────────────────────────────────────────────────
  // 1. Injection actually happened (install-order fix #1): entry file wired.
  const entryText = (await readFileSafe(detected.entryFile)) ?? "";
  if (!/crumbtrail-node/.test(entryText)) {
    throw new Error(
      `entry file ${detected.entryFile} was NOT wired (no crumbtrail-node reference) — injection self-cancelled after SDK install`,
    );
  }
  // 2. .env carries the ingest key.
  const envText = (await readFileSafe(path.join(appDir, ".env"))) ?? "";
  if (!new RegExp(`^CRUMBTRAIL_KEY=${stub.apiKey}$`, "m").test(envText)) {
    throw new Error(
      `.env missing 'CRUMBTRAIL_KEY=${stub.apiKey}' — env action did not run`,
    );
  }
  phase("PASS", `${name}:injected`, `env+entry wired`);

  // 2b. Live app drive (CP1): when a recipe carries an active boom-error-event
  // assertion, boot the wired app for real (real SDK installed, plain node start
  // — no --env-file, so autoCapture must load the .env key itself) and hit /boom
  // so autoCapture records a real server-side error event into the ingest stub.
  const boomActive = recipe.wireAssertions.some(
    (w) => w.id === "boom-error-event" && w.status === "active",
  );
  if (boomActive) {
    await driveBoomCapture({ name, recipe, appDir, packed, stub, ingest });
  }

  // 3. Wire assertions (manifest-driven; todo-cp1 ones are skipped).
  for (const wa of recipe.wireAssertions) {
    if (wa.status !== "active") {
      phase("SKIP", `${name}:wire:${wa.id}`, `todo-cp1`);
      continue;
    }
    if (wa.id === "authed-session-start") {
      ingest.assertSessionStartSeen();
      ingest.assertEventBatchSeen();
      ingest.assertAuthPresent();
      if (ingest.firstAuthKey() !== stub.apiKey) {
        throw new Error(
          `ingest auth key mismatch: saw ${ingest.firstAuthKey()}, expected ${stub.apiKey}`,
        );
      }
    }
    if (wa.id === "boom-error-event") {
      if (!hasBoomErrorEvent(ingest)) {
        throw new Error(
          "hitting /boom did NOT surface a captured backend error event " +
            "(k='backend.uncaught') in the ingest stub",
        );
      }
    }
    phase("PASS", `${name}:wire:${wa.id}`);
  }

  // 4. wizardStart poll filter (fix #4): only a post-start session is accepted.
  const out = lines.join("\n");
  if (out.includes(staleId)) {
    throw new Error(
      `poll surfaced the STALE pre-wizardStart session ${staleId} — wizardStart filter not applied`,
    );
  }
  if (!/\/sessions\/ses_stub_real_/.test(out)) {
    throw new Error(
      `poll did not surface a post-wizardStart real session (expected ses_stub_real_*)`,
    );
  }
  if (!wizardStartForwarded) {
    throw new Error(
      "runWizard did not thread a numeric wizardStart into pollForRealEvent",
    );
  }
  phase("PASS", `${name}:poll-filter`, `post-start session only`);

  await stub.stop();
  return { name, ok: true };
}

/** Drive the packed `crumbtrail` bin end-to-end (real SDK tarball fallback). */
async function runRecipeBinary({ name, packed, tmpRoot }) {
  const recipe = getRecipe(name);
  const appDir = path.join(tmpRoot, name, "app-bin");
  const xdgDir = path.join(tmpRoot, name, "xdg-bin");
  await fs.mkdir(appDir, { recursive: true });
  await fs.mkdir(xdgDir, { recursive: true });

  await materializeFixture(recipe.fixtureDir, appDir);
  const tarballsDir = path.dirname(packed.manifestPath);
  const ingest = createIngestRecorder();
  const stub = await startStubCloud({
    ingest,
    tarballsDir,
    autoRealSession: true,
  });
  seedAuthCache(xdgDir, { base: stub.baseUrl, token: "bl_cli_seeded_token" });
  stub.seedSession({
    id: "ses_stub_stale_pre_wizard",
    startedAt: Date.now() - 3_600_000,
  });

  phase("START", `${name}:wizard`, `mode=binary`);
  const result = await run(
    "node",
    [
      path.join(cliDist, "cli.cjs"),
      "--yes",
      "--project",
      stub.projectId,
      "--endpoint",
      stub.baseUrl,
      "--no-browser",
    ],
    {
      cwd: appDir,
      env: {
        XDG_CONFIG_HOME: xdgDir,
        HOME: xdgDir,
        CRUMBTRAIL_BASE_URL: stub.baseUrl,
        NO_COLOR: "1",
      },
      timeoutMs: 300_000,
    },
  );
  const out = `${result.stdout}\n${result.stderr}`;
  await stub.stop();
  if (result.code !== 0) {
    throw new Error(`packed binary exited ${result.code}\n${out.slice(-1500)}`);
  }
  const entryText =
    (await readFileSafe(recipe.runCmd ? path.join(appDir, "index.js") : "")) ??
    "";
  if (!/crumbtrail-node/.test(entryText)) {
    throw new Error(
      `packed binary did not wire the entry file\n${out.slice(-1500)}`,
    );
  }
  const envText = (await readFileSafe(path.join(appDir, ".env"))) ?? "";
  if (!new RegExp(`^CRUMBTRAIL_KEY=${stub.apiKey}$`, "m").test(envText)) {
    throw new Error(
      `packed binary did not write CRUMBTRAIL_KEY to .env\n${out.slice(-1500)}`,
    );
  }
  ingest.assertSessionStartSeen();
  ingest.assertAuthPresent();
  phase("PASS", `${name}:wizard`, `mode=binary wired`);
  return { name, ok: true };
}

/** Best-effort: kill whatever process currently holds a TCP port. */
function killPort(port) {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${port}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const pid of out
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean)) {
      try {
        process.kill(Number(pid), "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* nothing on the port */
  }
}

/**
 * Spawn a long-lived server; resolve once it answers HTTP (or reject on exit).
 * Clears the port first and runs the child in its OWN process group so stop()
 * kills the whole tree — `next start` forks a server child that a bare
 * child.kill() would orphan (a zombie that keeps holding the port across runs
 * and serves a STALE build with the previous run's baked-in endpoint).
 */
function startServer(cmd, cmdArgs, opts = {}) {
  if (opts.port) killPort(opts.port);
  const child = spawn(cmd, cmdArgs, {
    cwd: opts.cwd ?? repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1", ...opts.env },
    detached: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (c) => (stdout += c));
  child.stderr.on("data", (c) => (stderr += c));
  return {
    child,
    get log() {
      return `${stdout}\n${stderr}`;
    },
    stop() {
      return new Promise((resolve) => {
        const done = () => {
          if (opts.port) killPort(opts.port);
          resolve(undefined);
        };
        if (child.exitCode !== null || child.pid === undefined) return done();
        child.once("exit", done);
        try {
          // Negative pid => signal the whole process group.
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {
            /* already gone */
          }
          done();
        }
      });
    },
  };
}

/** Poll a URL until it answers (any HTTP status) or the deadline passes. */
async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(2_000) });
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return false;
}

/**
 * Frontend recipe runner (Next et al.). Unlike the backend inproc runner, a
 * client recipe can only be proven by running the BUILT app in a real browser:
 *   1. materialize the fixture (real `npm install` from its committed lockfile)
 *   2. inject via the REAL buildPlan + executePlan on the CLEAN fixture (before
 *      the SDK is a dependency — otherwise buildPlan's idempotency short-circuits)
 *   3. install the packed crumbtrail-core so the injected import resolves
 *   4. `next build`, then assert the injected init + ingest endpoint SHIPPED into
 *      the built client bundle (the crux: a Server-Component prepend would not)
 *   5. `next start` on the recipe's 496xx slot; load the page in headless
 *      chromium and assert an AUTHED session/start + ≥1 event batch hit ingest.
 */
async function runRecipeBrowser({ name, packed, tmpRoot }) {
  const recipe = getRecipe(name);
  const appDir = path.join(tmpRoot, name, "app");
  await fs.mkdir(appDir, { recursive: true });

  phase("START", `${name}:materialize`, `app=${appDir}`);
  await materializeFixture(recipe.fixtureDir, appDir);
  phase("PASS", `${name}:materialize`);

  const ingest = createIngestRecorder();
  const stub = await startStubCloud({ ingest });
  // Browser-originated ingest needs CORS; the stub speaks none. Sit a CORS shim
  // in front of it and inject THAT as the client endpoint (the stub still
  // records every forwarded request). See scripts/lib/cors-proxy.mjs.
  const proxy = await startCorsProxy(stub.baseUrl);
  const endpoint = proxy.baseUrl;
  phase("PASS", `${name}:stub-cloud`, `base=${stub.baseUrl} cors=${endpoint}`);

  const distCli = await import(
    pathToFileURL(path.join(cliDist, "cli.js")).href
  );
  const realDeps = distCli.defaultDeps();

  // (2) Inject on the CLEAN fixture: detect → buildPlan → executePlan.
  const detected = realDeps.detect(appDir);
  if (detected.recipe !== recipe.recipe) {
    throw new Error(
      `detect() returned '${detected.recipe}', expected '${recipe.recipe}'`,
    );
  }
  const plan = realDeps.buildPlan({
    cwd: appDir,
    recipe: detected.recipe,
    endpoint,
    apiKey: stub.apiKey,
    entryFile: detected.entryFile,
    nextVersion: detected.nextVersion,
    options: { force: true },
  });
  if (plan.kind !== recipe.expectedPlanKind) {
    throw new Error(
      `expected plan kind '${recipe.expectedPlanKind}', buildPlan produced '${plan.kind}' (target=${plan.targetPath})`,
    );
  }
  const applied = realDeps.executePlan(plan, undefined, { confirmDirty: true });
  if (applied.skipped || applied.written.length === 0) {
    throw new Error(`executePlan wrote nothing (${applied.message})`);
  }
  const clientEntryPath = path.join(appDir, recipe.clientEntry);
  const clientEntryText = (await readFileSafe(clientEntryPath)) ?? "";
  if (!/crumbtrail-core/.test(clientEntryText)) {
    throw new Error(
      `client entry ${recipe.clientEntry} was NOT wired (no crumbtrail-core reference)`,
    );
  }
  phase(
    "PASS",
    `${name}:inject`,
    `kind=${plan.kind} entry=${recipe.clientEntry}`,
  );

  // (3) Install the packed crumbtrail-core so the injected import resolves.
  const coreInstall = await run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--save", packed.core],
    { cwd: appDir },
  );
  if (coreInstall.code !== 0) {
    throw new Error(
      `npm install crumbtrail-core tarball failed (${coreInstall.code}): ${coreInstall.stderr.slice(-800)}`,
    );
  }
  phase("PASS", `${name}:sdk-install`, `core=${path.basename(packed.core)}`);

  // (4) Build, then prove the injected init shipped into the client bundle.
  phase("START", `${name}:build`);
  const build = await run(recipe.buildCmd[0], recipe.buildCmd.slice(1), {
    cwd: appDir,
    env: { NEXT_TELEMETRY_DISABLED: "1" },
    timeoutMs: 420_000,
  });
  if (build.code !== 0) {
    throw new Error(
      `next build failed (${build.code}):\n${build.stdout.slice(-1200)}\n${build.stderr.slice(-1200)}`,
    );
  }
  phase("PASS", `${name}:build`);

  const bundleShipped = await clientBundleContains(
    path.join(appDir, recipe.bundleDir),
    endpoint,
  );
  if (!bundleShipped) {
    throw new Error(
      `built client bundle under ${recipe.bundleDir} does NOT contain the ingest endpoint ${endpoint} — the client init did not ship to the browser`,
    );
  }
  phase(
    "PASS",
    `${name}:wire:client-bundle-shipped`,
    `endpoint in ${recipe.bundleDir}`,
  );

  // (5) Start the built app and load it in a real browser.
  const port = recipe.portSlot;
  // How the port is passed to the server varies per stack. `next start` takes
  // `-p <port>` (the default). Vite preview wants `--port <port>`; nitro (Nuxt)
  // and @react-router/serve read the PORT env (set below), so they take NO port
  // arg — set `portFlag: null` for those. This keeps the runner additive.
  const portArgs =
    recipe.portFlag === null ? [] : [recipe.portFlag ?? "-p", String(port)];
  const server = startServer(
    recipe.runCmd[0],
    [...recipe.runCmd.slice(1), ...portArgs],
    {
      cwd: appDir,
      port,
      env: { NEXT_TELEMETRY_DISABLED: "1", PORT: String(port) },
    },
  );
  const appUrl = `http://127.0.0.1:${port}/`;
  try {
    const up = await waitForHttp(appUrl, 60_000);
    if (!up) {
      throw new Error(
        `app did not come up on ${appUrl}\n${server.log.slice(-1200)}`,
      );
    }
    phase("PASS", `${name}:serve`, `url=${appUrl}`);

    const { html } = await loadAndCapture({ url: appUrl });
    if (!/Installer fixture/.test(html)) {
      throw new Error(`served HTML did not include the fixture marker`);
    }
    phase("PASS", `${name}:browser-load`, `html+trigger`);
  } finally {
    await server.stop();
  }

  // Ingest assertions (manifest-driven).
  for (const wa of recipe.wireAssertions) {
    if (wa.status !== "active") {
      phase("SKIP", `${name}:wire:${wa.id}`, `todo`);
      continue;
    }
    if (wa.id === "authed-session-start") {
      ingest.assertSessionStartSeen();
      ingest.assertEventBatchSeen();
      ingest.assertAuthPresent();
      if (ingest.firstAuthKey() !== stub.apiKey) {
        throw new Error(
          `ingest auth key mismatch: saw ${ingest.firstAuthKey()}, expected ${stub.apiKey}`,
        );
      }
      phase("PASS", `${name}:wire:${wa.id}`, `authed session + event batch`);
    }
    // client-bundle-shipped is asserted inline above (pre-serve).
  }

  await proxy.stop();
  await stub.stop();
  return { name, ok: true };
}

/** True when any built client chunk under `dir` contains `needle`. */
async function clientBundleContains(dir, needle) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (await clientBundleContains(full, needle)) return true;
    } else if (/\.js$/.test(entry.name)) {
      const text = await readFileSafe(full);
      if (text && text.includes(needle)) return true;
    }
  }
  return false;
}

// ── CP1: backend live app-drive ──────────────────────────────────────────────

/** Poll a predicate until it is true or the deadline passes. */
async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return predicate();
}

/** True once the ingest stub recorded an auto-captured backend error event. */
function hasBoomErrorEvent(ingest) {
  for (const rec of ingest.seen("/api/events")) {
    const events = rec.body?.events;
    if (!Array.isArray(events)) continue;
    // 'backend.uncaught' is crumbtrail-node's AUTO_CAPTURE_ERROR_EVENT wire kind.
    if (events.some((ev) => ev && ev.k === "backend.uncaught")) return true;
  }
  return false;
}

/**
 * Boot the wizard-wired backend app for real and hit /boom so autoCapture
 * records a server-side error event. The app is run with plain `node`/`npm start`
 * (NO --env-file and NO CRUMBTRAIL_KEY in the environment) — proving autoCapture
 * loads the ingest key from the injected `.env` itself. The packed SDK tarballs
 * (core + node) are installed over the wizard's seeded stub so the injected
 * `import("crumbtrail-node")` resolves to the real `autoCapture`.
 */
async function driveBoomCapture({
  name,
  recipe,
  appDir,
  packed,
  stub,
  ingest,
}) {
  phase("START", `${name}:sdk-install`);
  const sdkInstall = await run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--save", packed.core, packed.node],
    { cwd: appDir },
  );
  if (sdkInstall.code !== 0) {
    throw new Error(
      `npm install SDK tarballs failed (${sdkInstall.code}): ${sdkInstall.stderr.slice(-800)}`,
    );
  }
  phase("PASS", `${name}:sdk-install`, `core+node`);

  if (recipe.buildCmd) {
    phase("START", `${name}:build`);
    const build = await run(recipe.buildCmd[0], recipe.buildCmd.slice(1), {
      cwd: appDir,
      timeoutMs: 300_000,
    });
    if (build.code !== 0) {
      throw new Error(
        `build failed (${build.code}):\n${build.stdout.slice(-1000)}\n${build.stderr.slice(-1000)}`,
      );
    }
    phase("PASS", `${name}:build`);
  }

  const port = recipe.portSlot;
  const server = startServer(recipe.runCmd[0], recipe.runCmd.slice(1), {
    cwd: appDir,
    // Deliberately NO CRUMBTRAIL_KEY here: autoCapture must load it from .env.
    env: { PORT: String(port) },
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    const up = await waitForHttp(`${baseUrl}/`, 60_000);
    if (!up) {
      throw new Error(
        `wired app did not come up on ${baseUrl}/\n${server.log.slice(-1500)}`,
      );
    }
    phase("PASS", `${name}:serve`, `url=${baseUrl}/`);

    // autoCapture starts its session asynchronously after the dynamic import
    // resolves; wait until session/start lands so console.error is patched
    // before we trigger /boom.
    const sessionUp = await waitFor(
      () => ingest.seen("/api/session/start").length > 0,
      20_000,
    );
    if (!sessionUp) {
      throw new Error(
        `autoCapture session/start never reached ingest\n${server.log.slice(-1500)}`,
      );
    }

    // Crash-mode recipes (node-plain): /boom raises a REAL uncaughtException.
    // autoCapture's bounded flush ships the crash event before process.exit(1),
    // so the app process dies right after this one request — we hit it ONCE, wait
    // for the event, and tolerate both the dropped in-flight socket and the
    // subsequent nonzero exit (the app is expected to be gone afterward).
    if (recipe.crashMode) {
      try {
        await fetch(`${baseUrl}/boom`, { signal: AbortSignal.timeout(3_000) });
      } catch {
        // Expected: the uncaught throw destroys the in-flight response socket.
      }
      if (await waitFor(() => hasBoomErrorEvent(ingest), 8_000)) {
        phase("PASS", `${name}:boom-drive`, `crash event captured pre-exit`);
        return;
      }
      throw new Error(
        `no captured crash event after hitting /boom (crashMode; the bounded ` +
          `flush must land the event before process.exit)\n${server.log.slice(-1500)}`,
      );
    }

    // Trigger the throwing route; the record is fire-and-forget, so retry a few
    // times until the error event lands (or give up).
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await fetch(`${baseUrl}/boom`, { signal: AbortSignal.timeout(3_000) });
      } catch {
        // Framework 500 / aborted body read — the capture is what matters.
      }
      if (await waitFor(() => hasBoomErrorEvent(ingest), 4_000)) {
        phase("PASS", `${name}:boom-drive`, `error event captured`);
        return;
      }
    }
    throw new Error(
      `no captured error event after hitting /boom\n${server.log.slice(-1500)}`,
    );
  } finally {
    await server.stop();
  }
}

/**
 * Guidance-only recipe runner (CP4). A non-JS backend (`otlp`) is never mutated
 * by the wizard: no SDK install, no entry wiring, no .env. So this runner does
 * NOT boot an app or hit the ingest stub. It exercises the REAL detect() +
 * buildPlan() from the packed CLI dist against the fixture and asserts:
 *   1. detect() resolves the expected recipe + otlpStack,
 *   2. buildPlan() emits a non-mutating `otlp-guidance` plan (no targetPath/
 *      content), and
 *   3. the emitted snippet carries the fixed OTLP facts (snippetMustContain).
 */
async function runRecipeGuidance({ name, tmpRoot }) {
  const recipe = getRecipe(name);
  const appDir = path.join(tmpRoot, name, "app");
  await fs.mkdir(appDir, { recursive: true });

  phase("START", `${name}:materialize`, `app=${appDir}`);
  // Guidance fixtures are non-JS (no package.json); copy files only, never npm.
  await fs.cp(recipe.fixtureDir, appDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`),
  });
  phase("PASS", `${name}:materialize`);

  const distCli = await import(
    pathToFileURL(path.join(cliDist, "cli.js")).href
  );
  const { defaultDeps } = distCli;
  const realDeps = defaultDeps();

  const detected = realDeps.detect(appDir);
  if (detected.recipe !== recipe.recipe) {
    throw new Error(
      `detect() returned '${detected.recipe}', expected '${recipe.recipe}'`,
    );
  }
  if (
    recipe.expectedOtlpStack &&
    detected.otlpStack !== recipe.expectedOtlpStack
  ) {
    throw new Error(
      `detect() otlpStack '${detected.otlpStack}', expected '${recipe.expectedOtlpStack}'`,
    );
  }
  phase(
    "PASS",
    `${name}:detect`,
    `recipe=${detected.recipe} stack=${detected.otlpStack}`,
  );

  const endpoint = "https://app.crumbtrail.example";
  const apiKey = "bl_guidance_key";
  const plan = realDeps.buildPlan({
    cwd: appDir,
    recipe: detected.recipe,
    endpoint,
    apiKey,
    entryFile: detected.entryFile,
    nextVersion: detected.nextVersion,
    stack: detected.otlpStack ?? undefined,
    options: { force: true },
  });
  if (plan.kind !== recipe.expectedPlanKind) {
    throw new Error(
      `expected plan kind '${recipe.expectedPlanKind}', buildPlan produced '${plan.kind}'`,
    );
  }
  // Guidance plans MUST NOT mutate the filesystem.
  if (plan.targetPath !== null || plan.content !== null) {
    throw new Error(
      `otlp-guidance plan must not target a file (targetPath=${plan.targetPath}, content!=null=${plan.content !== null})`,
    );
  }
  phase("PASS", `${name}:plan`, `kind=${plan.kind} (non-mutating)`);

  const snippet = plan.snippet ?? "";
  for (const needle of recipe.snippetMustContain ?? []) {
    if (!snippet.includes(needle)) {
      throw new Error(
        `guidance snippet missing '${needle}'\n--- snippet ---\n${snippet}`,
      );
    }
  }
  // The fixed Bearer form must NOT regress to the unescaped-space encoding.
  if (snippet.includes(`Authorization=Bearer ${apiKey}`)) {
    throw new Error(
      "guidance snippet still emits the unescaped 'Authorization=Bearer <key>' form (must be Bearer%20)",
    );
  }
  phase("PASS", `${name}:wire:otlp-guidance-snippet`, `facts present`);

  // Assert the entry sources were NOT wired (guidance never mutates): the
  // fixture's main.py must stay byte-identical to the source fixture.
  const appMainPy = await readFileSafe(path.join(appDir, "main.py"));
  const fixtureMainPy = await readFileSafe(
    path.join(recipe.fixtureDir, "main.py"),
  );
  if (appMainPy !== fixtureMainPy) {
    throw new Error("guidance run unexpectedly mutated main.py");
  }
  if (await readFileSafe(path.join(appDir, ".env"))) {
    throw new Error("guidance run unexpectedly wrote a .env");
  }
  phase("PASS", `${name}:non-mutating`, `no source/.env writes`);

  return { name, ok: true };
}

/**
 * Plan-only recipe runner (CP3). Some recipes are NON-RUNNABLE by design: they
 * assert on the shape of the wizard's Plan without any npm ci / build / server
 * (e.g. the React Router 7 default template, whose entry files are hidden until
 * `npx react-router reveal` — the wizard hands off to fallback-ai and its
 * warning must name the reveal escape hatch). This runner exercises the REAL
 * detect() + buildPlan() from the packed CLI dist against the fixture and
 * asserts: (1) detect() resolves the expected recipe, (2) buildPlan() emits the
 * expected NON-MUTATING plan kind, and (3) the plan warnings carry the required
 * guidance strings (warningMustContain). It never installs, builds, or serves.
 */
async function runRecipePlanOnly({ name, tmpRoot }) {
  const recipe = getRecipe(name);
  const appDir = path.join(tmpRoot, name, "app");
  await fs.mkdir(appDir, { recursive: true });

  phase("START", `${name}:materialize`, `app=${appDir}`);
  // Plan-only fixtures are inspected, never installed; copy files only.
  await fs.cp(recipe.fixtureDir, appDir, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}node_modules${path.sep}`),
  });
  phase("PASS", `${name}:materialize`);

  const distCli = await import(
    pathToFileURL(path.join(cliDist, "cli.js")).href
  );
  const { defaultDeps } = distCli;
  const realDeps = defaultDeps();

  const detected = realDeps.detect(appDir);
  if (detected.recipe !== recipe.recipe) {
    throw new Error(
      `detect() returned '${detected.recipe}', expected '${recipe.recipe}'`,
    );
  }
  phase("PASS", `${name}:detect`, `recipe=${detected.recipe}`);

  const endpoint = "https://app.crumbtrail.example";
  const apiKey = "bl_planonly_key";
  const plan = realDeps.buildPlan({
    cwd: appDir,
    recipe: detected.recipe,
    endpoint,
    apiKey,
    entryFile: detected.entryFile,
    nextVersion: detected.nextVersion,
    stack: detected.otlpStack ?? undefined,
    options: { force: true },
  });
  if (plan.kind !== recipe.expectedPlanKind) {
    throw new Error(
      `expected plan kind '${recipe.expectedPlanKind}', buildPlan produced '${plan.kind}'`,
    );
  }
  // Plan-only recipes assert on a NON-mutating plan (fallback-ai / guidance).
  if (plan.targetPath !== null || plan.content !== null) {
    throw new Error(
      `plan-only plan must not target a file (targetPath=${plan.targetPath}, content!=null=${plan.content !== null})`,
    );
  }
  phase("PASS", `${name}:plan`, `kind=${plan.kind} (non-mutating)`);

  const warnings = (plan.warnings ?? []).join("\n");
  for (const needle of recipe.warningMustContain ?? []) {
    if (!warnings.includes(needle)) {
      throw new Error(
        `plan warning missing '${needle}'\n--- warnings ---\n${warnings}`,
      );
    }
  }

  for (const wa of recipe.wireAssertions) {
    if (wa.status !== "active") {
      phase("SKIP", `${name}:wire:${wa.id}`, `todo`);
      continue;
    }
    phase("PASS", `${name}:wire:${wa.id}`);
  }

  // Guard: the fixture must NOT reveal an entry.client — the whole point is the
  // hidden-entry fallback path. (Only enforced when the recipe declares it.)
  if (recipe.assertNoFile) {
    for (const rel of recipe.assertNoFile) {
      if (await readFileSafe(path.join(appDir, rel))) {
        throw new Error(
          `plan-only fixture unexpectedly contains ${rel} — it must exercise the hidden-entry path`,
        );
      }
    }
  }

  return { name, ok: true };
}

/**
 * Typecheck-cap recipe runner (CP5). React Native (Expo) and Tauri have no
 * runtime harness in the suite — no simulator, no cargo build — so the cap is a
 * static one: materialize the fixture (real npm install), run the wizard's REAL
 * detect → buildPlan → executePlan to prepend the SDK init into the resolved
 * entry, install the packed SDK tarball(s) from the OPTIONAL pack-manifest
 * channels so the injected import resolves with types, then `tsc --noEmit`. It
 * also asserts any required plan warnings (Tauri's two Rust-side steps). It never
 * builds, serves, or hits the ingest stub.
 */
async function runRecipeTypecheck({ name, packed, tmpRoot }) {
  const recipe = getRecipe(name);
  const appDir = path.join(tmpRoot, name, "app");
  await fs.mkdir(appDir, { recursive: true });

  phase("START", `${name}:materialize`, `app=${appDir}`);
  await materializeFixture(recipe.fixtureDir, appDir);
  phase("PASS", `${name}:materialize`);

  const distCli = await import(
    pathToFileURL(path.join(cliDist, "cli.js")).href
  );
  const realDeps = distCli.defaultDeps();

  const detected = realDeps.detect(appDir);
  if (detected.recipe !== recipe.recipe) {
    throw new Error(
      `detect() returned '${detected.recipe}', expected '${recipe.recipe}'`,
    );
  }
  const endpoint = "https://app.crumbtrail.example";
  const apiKey = "bl_typecheck_key";
  const plan = realDeps.buildPlan({
    cwd: appDir,
    recipe: detected.recipe,
    endpoint,
    apiKey,
    entryFile: detected.entryFile,
    nextVersion: detected.nextVersion,
    stack: detected.otlpStack ?? undefined,
    options: { force: true },
  });
  if (plan.kind !== recipe.expectedPlanKind) {
    throw new Error(
      `expected plan kind '${recipe.expectedPlanKind}', buildPlan produced '${plan.kind}'`,
    );
  }
  phase("PASS", `${name}:plan`, `kind=${plan.kind}`);

  // Required plan warnings (e.g. Tauri's two Rust-side steps the CLI can't do).
  const warnings = (plan.warnings ?? []).join("\n");
  for (const needle of recipe.warningMustContain ?? []) {
    if (!warnings.includes(needle)) {
      throw new Error(
        `plan warning missing '${needle}'\n--- warnings ---\n${warnings}`,
      );
    }
  }
  if ((recipe.warningMustContain ?? []).length > 0) {
    phase("PASS", `${name}:wire:tauri-rust-warnings`, `rust steps named`);
  }

  const applied = realDeps.executePlan(plan, undefined, { confirmDirty: true });
  if (applied.skipped || applied.written.length === 0) {
    throw new Error(`executePlan wrote nothing (${applied.message})`);
  }
  const clientEntryPath = path.join(appDir, recipe.clientEntry);
  const clientEntryText = (await readFileSafe(clientEntryPath)) ?? "";
  if (!/crumbtrail-(core|react-native|tauri)/.test(clientEntryText)) {
    throw new Error(
      `client entry ${recipe.clientEntry} was NOT wired (no crumbtrail SDK reference)`,
    );
  }
  phase(
    "PASS",
    `${name}:inject`,
    `kind=${plan.kind} entry=${recipe.clientEntry}`,
  );

  // Install the packed SDK tarballs from the OPTIONAL pack-manifest channels so
  // the injected import resolves with its types. A missing channel is the CP5
  // RED on current main — the recipe fails here rather than silently skipping.
  const packKeys = recipe.typecheckPacks ?? [];
  const packs = packKeys.map((k) => packed[k]).filter(Boolean);
  if (packs.length !== packKeys.length) {
    throw new Error(
      `packed manifest is missing tarball(s) for ${JSON.stringify(packKeys)} — ` +
        `pack-local did not produce the optional SDK channel (present keys: ` +
        `${Object.keys(packed).join(",")})`,
    );
  }
  phase("START", `${name}:sdk-install`, `packs=${packKeys.join("+")}`);
  const sdkInstall = await run(
    "npm",
    ["install", "--no-audit", "--no-fund", "--save", ...packs],
    { cwd: appDir, timeoutMs: 300_000 },
  );
  if (sdkInstall.code !== 0) {
    throw new Error(
      `npm install SDK tarballs failed (${sdkInstall.code}): ${sdkInstall.stderr.slice(-800)}`,
    );
  }
  phase(
    "PASS",
    `${name}:sdk-install`,
    `${packs.map((p) => path.basename(p)).join(" ")}`,
  );

  phase("START", `${name}:typecheck`, `cmd=${recipe.typecheckCmd.join(" ")}`);
  const tc = await run(recipe.typecheckCmd[0], recipe.typecheckCmd.slice(1), {
    cwd: appDir,
    timeoutMs: 300_000,
  });
  if (tc.code !== 0) {
    throw new Error(
      `typecheck failed (${tc.code}):\n${tc.stdout.slice(-2000)}\n${tc.stderr.slice(-1200)}`,
    );
  }
  const typecheckWireId =
    recipe.recipe === "tauri" ? "tauri-typecheck" : "rn-typecheck";
  phase("PASS", `${name}:wire:${typecheckWireId}`, `tsc --noEmit clean`);

  return { name, ok: true };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const names = args.recipe ? [args.recipe] : recipeNames();
  let tmpRoot;
  const results = [];

  try {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bgl-installers-"));
    phase("START", "pack-local", `out=${path.join(tmpRoot, "packed")}`);
    const packed = await packLocal({
      outDir: path.join(tmpRoot, "packed"),
      logFn: (p, s, d) => phase(s.toUpperCase(), `pack:${p}`, d),
    });
    phase("PASS", "pack-local");

    for (const name of names) {
      try {
        const selected = getRecipe(name);
        const runner = selected.guidanceOnly
          ? runRecipeGuidance
          : selected.planOnly
            ? runRecipePlanOnly
            : selected.typecheckCap
              ? runRecipeTypecheck
              : selected.browserLoad
                ? runRecipeBrowser
                : args.mode === "binary"
                  ? runRecipeBinary
                  : runRecipeInproc;
        results.push(await runner({ name, packed, tmpRoot }));
        phase("PASS", `recipe:${name}`);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        phase("FAIL", `recipe:${name}`, `message=${JSON.stringify(message)}`);
        results.push({ name, ok: false, error: message });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    phase("FAIL", "harness", `message=${JSON.stringify(message)}`);
    process.exitCode = 1;
  } finally {
    if (tmpRoot && !args.keep) {
      await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }

  // PASS/FAIL matrix.
  console.log("\nInstaller matrix (mode=" + args.mode + "):");
  for (const r of results) {
    console.log(
      `  ${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.ok ? "" : `  — ${r.error}`}`,
    );
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    phase("FAIL", "summary", `failed=${failed.map((r) => r.name).join(",")}`);
    process.exitCode = 1;
  } else if (results.length > 0) {
    phase("PASS", "summary", `recipes=${results.map((r) => r.name).join(",")}`);
  }
}

main();
