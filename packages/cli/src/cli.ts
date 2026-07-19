#!/usr/bin/env node
// The `crumbtrail` setup wizard. Hand-rolled arg parsing (no CLI framework to keep
// npx cold-start fast), a non-TTY guard that runs BEFORE any prompt, and the
// end-to-end flow: banner → detect → login → provision → SDK install → inject →
// verify → summary. Injection is the LAST repo-mutating step and only ever runs
// through CP3's buildPlan/executePlan.
//
// All logic is exported for tests; the bin auto-runs only when this file is the
// invoked script (guarded at the bottom), so importing it in vitest is inert.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildPlan,
  DENO_UNSUPPORTED_REASON,
  defaultInjectIO,
  detect,
  executePlan,
  type DetectResult,
  type PackageManager,
  type Plan,
  type Recipe,
} from "./index";
import {
  canUseBrowser,
  clearAuth as clearStoredAuth,
  ensureToken,
  loadAuth,
  openBrowser,
} from "./auth";
import {
  exitCodeFor,
  runPreflight,
  toJson,
  type AuthProbe,
  type PreflightResult,
  type StageResult,
} from "./preflight";
import {
  inferProjectName,
  inferServiceName,
  provisionFlow,
  provisionService,
  resolveProject,
  uniqueServiceNames,
  UpgradeRequiredError,
  type ProvisionResult,
} from "./provision";
import {
  pollForRealEvent,
  pollForServices,
  type PollRealEventResult,
  type PollServicesResult,
} from "./verify";
import { discoverServices, type ServiceCandidate } from "./discover";
import { otlpGuidePlan, renderOtlpGuide } from "./otlp-guide";
import { RECIPE_REGISTRY, sdkInstallSpec } from "./recipe-registry";
import { dashboardBase, resolveEndpoint } from "./net";
import {
  color,
  consoleUi,
  stdinPrompter,
  type MultiSelectItem,
  type Prompter,
  type Ui,
} from "./ui";

// ── Version ──────────────────────────────────────────────────────────────────

function readVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(__dirnameCompat(), "..", "package.json"), "utf8"),
    ) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** __dirname in CJS; a computed fallback for ESM builds. */
function __dirnameCompat(): string {
  if (typeof __dirname !== "undefined") return __dirname;
  return process.cwd();
}

// ── Arg parsing ──────────────────────────────────────────────────────────────

export type Command =
  | "wizard"
  | "login"
  | "logout"
  | "verify"
  | "help"
  | "version";

export interface ParsedArgs {
  command: Command;
  yes: boolean;
  project?: string;
  noBrowser: boolean;
  skipVerify: boolean;
  endpoint?: string;
  /**
   * Monorepo root only: wire exactly these services (repeatable `--only`,
   * matched against a service's package name or path). Also the non-interactive
   * escape hatch — a root run in CI must name its services somehow.
   */
  only?: string[];
  /** Monorepo root only: select every wireable service, no prompt. */
  all: boolean;
  /**
   * Target a specific package directory instead of the detected repo root. In a
   * monorepo this bypasses the batch scan and wires exactly this one package
   * (resolved relative to cwd; must exist and hold a package.json).
   */
  workspace?: string;
  /**
   * `verify` only: the ingest key to probe with (else $CRUMBTRAIL_KEY, else the
   * cached login token). The primary CI credential for a pre-deploy check.
   */
  key?: string;
  /** `verify` only: emit a machine-readable JSON result instead of the human table. */
  json: boolean;
  /** Non-flag/subcommand leftover — an unknown token triggers usage help. */
  unknown?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const parsed: ParsedArgs = {
    command: "wizard",
    yes: false,
    noBrowser: false,
    skipVerify: false,
    all: false,
    json: false,
  };
  let commandSet = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--help":
      case "-h":
        parsed.command = "help";
        return parsed;
      case "--version":
      case "-v":
        parsed.command = "version";
        return parsed;
      case "--yes":
      case "-y":
        parsed.yes = true;
        break;
      case "--no-browser":
        parsed.noBrowser = true;
        break;
      case "--skip-verify":
        parsed.skipVerify = true;
        break;
      case "--project":
        parsed.project = args[++i];
        break;
      case "--endpoint":
        parsed.endpoint = args[++i];
        break;
      case "--key":
        parsed.key = args[++i];
        break;
      case "--json":
        parsed.json = true;
        break;
      case "--all":
        parsed.all = true;
        break;
      case "--only":
        (parsed.only ??= []).push(args[++i]);
        break;
      case "--workspace":
        parsed.workspace = args[++i];
        break;
      default:
        if (a.startsWith("--project=")) {
          parsed.project = a.slice("--project=".length);
        } else if (a.startsWith("--endpoint=")) {
          parsed.endpoint = a.slice("--endpoint=".length);
        } else if (a.startsWith("--key=")) {
          parsed.key = a.slice("--key=".length);
        } else if (a.startsWith("--only=")) {
          (parsed.only ??= []).push(a.slice("--only=".length));
        } else if (a.startsWith("--workspace=")) {
          parsed.workspace = a.slice("--workspace=".length);
        } else if (
          !commandSet &&
          (a === "login" || a === "logout" || a === "verify")
        ) {
          parsed.command = a;
          commandSet = true;
        } else if (!a.startsWith("-")) {
          parsed.unknown = a;
        } else {
          parsed.unknown = a;
        }
    }
  }
  return parsed;
}

const USAGE = `crumbtrail — set up Crumbtrail in your app

Usage:
  crumbtrail [options]        Run the setup wizard (detect → login → wire → verify)
  crumbtrail login            Log in and cache a token, nothing else
  crumbtrail logout           Delete the cached token
  crumbtrail verify           Preflight an endpoint + key (DNS, TLS, auth) — PASS/FAIL

In a monorepo, run it from the repo root: it scans every workspace and service,
shows you what it found, and wires the ones you pick.

Options:
  --yes, -y                  Skip confirmations (required with --project in CI)
  --project <id>             Attach to an existing project (skip creation)
  --only <name>              Monorepo: wire only this service (repeatable)
  --all                      Monorepo: wire every service it can, no prompt
  --workspace <dir>          Target one package dir (relative to cwd) instead of
                             the repo root — wires just that package
  --no-browser               Use the device-code login flow
  --skip-verify              Don't wait for the first event
  --endpoint <url>           Cloud endpoint (else $CRUMBTRAIL_BASE_URL, else default)
  --help, -h                 Show this help
  --version, -v              Print the version

verify options (pre-deploy check — point it at any environment):
  --endpoint <url>           Endpoint to probe (else $CRUMBTRAIL_BASE_URL, else default)
  --key <ingestKey>          Ingest key to probe with (else $CRUMBTRAIL_KEY, else cached login)
  --project <id>             Project id for the auth GET fallback (no key)
  --json                     Emit a machine-readable result (exit 0 = pass, non-0 = fail)`;

// ── SDK install ──────────────────────────────────────────────────────────────

export interface InstallSdkInput {
  cwd: string;
  packageManager: PackageManager | null;
  recipe: Recipe;
  base: string;
  ui: Ui;
  /** Injected runner (tests); returns the child exit code. */
  spawnFn?: (cmd: string, args: string[], cwd: string) => number;
  /** Injected fetch for the tarball-manifest fallback (tests); defaults to global. */
  fetchImpl?: typeof fetch;
}

export interface InstallSdkResult {
  installed: boolean;
  packages: string[];
  note?: string;
}

function sdkPackagesFor(recipe: Recipe): string[] {
  return RECIPE_REGISTRY[recipe].sdkPackages;
}

function pmInvocation(pm: PackageManager | null): { cmd: string; add: string } {
  switch (pm) {
    case "pnpm":
      return { cmd: "pnpm", add: "add" };
    case "yarn":
      return { cmd: "yarn", add: "add" };
    case "bun":
      return { cmd: "bun", add: "add" };
    default:
      return { cmd: "npm", add: "install" };
  }
}

function realSpawn(cmd: string, args: string[], cwd: string): number {
  const res = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (res.error) return 1;
  return res.status ?? 1;
}

/**
 * Discover the deploy's tarball URLs for the given packages via
 * `GET <base>/install/manifest.json` (served by cloud's install-routes from the
 * baked pack-manifest). Returns one URL per package in order, or an empty array
 * when the manifest is unavailable or any package is missing — the caller then
 * falls back to a manual note rather than a partial install.
 */
async function discoverTarballUrls(
  base: string,
  packages: string[],
  fetchImpl?: typeof fetch,
): Promise<string[]> {
  try {
    const doFetch = fetchImpl ?? fetch;
    const res = await doFetch(`${base}/install/manifest.json`);
    if (!res.ok) return [];
    const body = (await res.json()) as { files?: unknown };
    const files = Array.isArray(body.files)
      ? body.files.filter((f): f is string => typeof f === "string")
      : [];
    const urls: string[] = [];
    for (const pkg of packages) {
      const file = files.find(
        (f) => f.startsWith(`${pkg}-`) && f.endsWith(".tgz"),
      );
      if (!file) return [];
      urls.push(`${base}/install/${file}`);
    }
    return urls;
  } catch {
    return [];
  }
}

/**
 * Install the SDK with the detected package manager. If the registry install
 * fails (e.g. packages not yet public, or a self-hosted endpoint), fall back to
 * installing the deploy's packed tarballs — discovered via
 * `GET <base>/install/manifest.json` — so a fresh deploy wires up before the
 * packages are on npm. Every recipe's SDK (including react-native and tauri, now
 * packed as optional channels by pack-local.mjs) is resolved by name prefix from
 * that manifest, so the fallback is uniform. Non-fatal either way, since
 * injection only writes import statements.
 */
export async function installSdk(
  input: InstallSdkInput,
): Promise<InstallSdkResult> {
  const packages = sdkPackagesFor(input.recipe);
  // Empty package list (the `otlp` guidance recipe): there is no SDK to add —
  // skip the install entirely. Never spawn a bare `<pm> add`/`npm install` with
  // no args, which would install ALL deps. Early-return a skipped result.
  if (packages.length === 0) {
    return { installed: false, packages: [] };
  }
  const { cmd, add } = pmInvocation(input.packageManager);
  const run = input.spawnFn ?? realSpawn;
  // Pin the registry install to the CLI's version floors so a stale dist-tag
  // can never leave a freshly wired service on an old SDK. The tarball fallback
  // below keeps bare names (tarball URLs are resolved by name prefix).
  const specs = packages.map(sdkInstallSpec);
  input.ui.out(
    `Installing SDK: ${color.cyan(`${cmd} ${add} ${specs.join(" ")}`)}`,
  );
  const code = run(cmd, [add, ...specs], input.cwd);
  if (code === 0) {
    return { installed: true, packages };
  }

  // Registry install failed — fall back to the deploy's packed tarballs,
  // discovered by package-name prefix from the install manifest (react-native
  // and tauri included, now that pack-local packs them as optional channels).
  const tarballs = await discoverTarballUrls(
    input.base,
    packages,
    input.fetchImpl,
  );
  if (tarballs.length === packages.length) {
    input.ui.out(
      color.dim(
        `Registry unavailable — installing from ${input.base}/install tarballs…`,
      ),
    );
    const fallbackCode = run(cmd, [add, ...tarballs], input.cwd);
    if (fallbackCode === 0) {
      return {
        installed: true,
        packages,
        note: `Installed ${packages.join(", ")} from the deploy's install tarballs (registry unavailable).`,
      };
    }
    return {
      installed: false,
      packages,
      note: `SDK install via ${cmd} failed; the ${input.base}/install tarball fallback also failed — wire manually or run: curl -fsSL ${input.base}/install.sh | sh`,
    };
  }

  return {
    installed: false,
    packages,
    note: `SDK install via ${cmd} failed — install the tarballs instead: curl -fsSL ${input.base}/install.sh | sh`,
  };
}

// ── Wizard deps (injectable for tests) ───────────────────────────────────────

export interface WizardDeps {
  detect: (cwd: string) => DetectResult;
  ensureToken: typeof ensureToken;
  provisionFlow: typeof provisionFlow;
  installSdk: (input: InstallSdkInput) => Promise<InstallSdkResult>;
  buildPlan: typeof buildPlan;
  executePlan: typeof executePlan;
  pollForRealEvent: typeof pollForRealEvent;
  /** Batch path (monorepo root). */
  discoverServices: typeof discoverServices;
  resolveProject: typeof resolveProject;
  provisionService: typeof provisionService;
  pollForServices: typeof pollForServices;
  /** Synthetic preflight for `verify` (stub in tests). */
  runPreflight: typeof runPreflight;
  /** Browser opener for the end-of-wizard dashboard hand-off (stub in tests). */
  openBrowserFn?: (url: string) => Promise<boolean>;
  ui: Ui;
  prompter: Prompter;
  env: NodeJS.ProcessEnv;
  cwd: string;
  isTTY: boolean;
  fetchImpl?: typeof fetch;
}

export function defaultDeps(): WizardDeps {
  return {
    detect,
    ensureToken,
    provisionFlow,
    installSdk,
    buildPlan,
    executePlan,
    pollForRealEvent,
    discoverServices,
    resolveProject,
    provisionService,
    pollForServices,
    runPreflight,
    openBrowserFn: openBrowser,
    ui: consoleUi,
    prompter: stdinPrompter,
    env: process.env,
    cwd: process.cwd(),
    isTTY: !!(process.stdout.isTTY && process.stdin.isTTY),
    fetchImpl: undefined,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function readPkgName(dir: string): string | null {
  try {
    const pkg = JSON.parse(
      readFileSync(path.join(dir, "package.json"), "utf8"),
    ) as { name?: string };
    return typeof pkg.name === "string" ? pkg.name : null;
  } catch {
    return null;
  }
}

/** Filesystem probes for --workspace validation; injectable so the resolver is
 *  unit-testable without touching real directories. */
export interface WorkspaceIO {
  isDir: (p: string) => boolean;
  isFile: (p: string) => boolean;
}

const defaultWorkspaceIO: WorkspaceIO = {
  isDir: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  isFile: (p) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  },
};

/**
 * Resolve `--workspace <dir>` to an absolute package directory. The dir is taken
 * relative to the wizard's cwd, must exist, and must hold a package.json (the
 * workspace-package manifest) — otherwise detect() would run against nothing
 * useful, so we refuse with a concrete message rather than proceed. Pure aside
 * from the injected probes.
 */
export function resolveWorkspaceDir(
  baseCwd: string,
  workspace: string,
  io: WorkspaceIO = defaultWorkspaceIO,
): { dir: string } | { error: string } {
  const dir = path.resolve(baseCwd, workspace);
  if (!io.isDir(dir)) {
    return { error: `--workspace ${workspace}: no such directory (${dir}).` };
  }
  if (!io.isFile(path.join(dir, "package.json"))) {
    return {
      error: `--workspace ${workspace}: ${dir} has no package.json — point it at a package directory.`,
    };
  }
  return { dir };
}

// ── Wizard ───────────────────────────────────────────────────────────────────

export async function runWizard(
  parsed: ParsedArgs,
  deps: WizardDeps,
): Promise<number> {
  const { ui } = deps;
  const base = resolveEndpoint(parsed.endpoint, deps.env);
  // Captured at wizard entry: the real-event poll only accepts sessions started
  // at/after this instant, so a stale session from a prior run can't be
  // mistaken for "your first event" (verify.ts wizardStart filter).
  const wizardStart = Date.now();

  ui.out(color.bold("\nCrumbtrail setup"));
  ui.out(color.dim(`Endpoint: ${base}\n`));

  // 1. Detect. A monorepo root forks to the batch installer, which scans every
  // service and wires the ones the user picks. Everything below this fork is the
  // single-package path and is unchanged.
  //
  // --workspace narrows the target to one package dir first: pointing detect at
  // that dir means a package inside a monorepo classifies as itself (not as the
  // monorepo root), so the wizard wires exactly it instead of forking to the
  // batch scan.
  let cwd = deps.cwd;
  if (parsed.workspace) {
    const resolved = resolveWorkspaceDir(deps.cwd, parsed.workspace);
    if ("error" in resolved) {
      ui.err(color.red(resolved.error));
      return 1;
    }
    cwd = resolved.dir;
    ui.out(
      color.dim(`Targeting workspace: ${path.relative(deps.cwd, cwd) || cwd}`),
    );
  }
  const result = deps.detect(cwd);
  if (result.isMonorepo) {
    return runBatchWizard(parsed, deps, { base, wizardStart, root: result });
  }

  if (!result.recipe) {
    const isDeno = result.reasons.includes(DENO_UNSUPPORTED_REASON);
    if (isDeno) {
      ui.err(
        color.red(
          "Deno projects aren't supported yet — Crumbtrail can't wire this one.",
        ),
      );
    } else {
      ui.err(color.red("Couldn't detect a supported framework here."));
    }
    for (const r of result.reasons) ui.err(color.dim(`  · ${r}`));
    for (const n of result.notes) ui.err(color.dim(`  · ${n}`));
    if (!isDeno) {
      ui.err(
        "Supported: Next.js, SvelteKit, Nuxt, Remix, Astro, Angular, Vite SPA, NestJS, Express, Hono, Fastify, a Node server, or a non-JS backend that speaks OpenTelemetry (Django, Flask, FastAPI, Go, Rails, .NET).",
      );
    }
    return 1;
  }
  ui.out(`${color.green("✓")} Detected ${color.bold(result.recipe)} project.`);
  for (const n of result.notes) ui.out(color.dim(`  · ${n}`));

  // 2. Login (reuse a cached token when possible).
  let token: string;
  try {
    token = await deps.ensureToken({
      base,
      ui,
      noBrowser: parsed.noBrowser,
      fetchImpl: deps.fetchImpl,
      env: deps.env,
      allowInteractiveLogin: deps.isTTY,
    });
  } catch (err) {
    ui.err(color.red(`Login failed: ${errMessage(err)}`));
    return 1;
  }

  // 3. Provision project + service + key.
  const pkgName = readPkgName(cwd);
  const defaultProjectName = inferProjectName(pkgName, path.basename(cwd));
  const defaultServiceName = inferServiceName(result.recipe);
  let provisioned: ProvisionResult;
  try {
    provisioned = await deps.provisionFlow({
      base,
      token,
      recipe: result.recipe,
      stack: result.otlpStack,
      ui,
      prompter: deps.prompter,
      assumeYes: parsed.yes,
      projectId: parsed.project,
      defaultProjectName,
      defaultServiceName,
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    if (err instanceof UpgradeRequiredError) {
      ui.err("");
      ui.err(color.yellow(err.message));
      if (err.upgradeUrl) ui.err(`Upgrade: ${color.cyan(err.upgradeUrl)}`);
      return 1;
    }
    ui.err(color.red(`Provisioning failed: ${errMessage(err)}`));
    return 1;
  }

  // 4. Build the injection plan BEFORE installing the SDK. buildPlan is
  // read-only, but its project-level idempotency check keys off whether
  // package.json already references crumbtrail-core/-node. If we let installSdk
  // add those deps first, buildPlan would see them and wrongly return
  // "skip-already-wired" — self-cancelling injection on a fresh setup. So the
  // plan is computed against the pre-install repo; only executePlan (below,
  // after install) mutates files, keeping injection the LAST repo-mutating step.
  const plan = deps.buildPlan({
    cwd,
    recipe: result.recipe,
    endpoint: base,
    entryFile: result.entryFile,
    nextVersion: result.nextVersion,
    stack: result.otlpStack ?? undefined,
    options: { force: parsed.yes },
  }, defaultInjectIO);

  // 5. Install the SDK (repo-mutating: adds deps to package.json).
  const install = await deps.installSdk({
    cwd,
    packageManager: result.packageManager,
    recipe: result.recipe,
    base,
    ui,
    fetchImpl: deps.fetchImpl,
  });
  if (install.installed) {
    ui.out(`${color.green("✓")} Installed ${install.packages.join(", ")}.`);
  } else if (install.note) {
    ui.out(color.yellow(`! ${install.note}`));
  }

  // 6. Inject — the LAST repo-mutating step, applying the pre-computed plan via
  // CP3's executor. The install result rides along so a dirty-file decline can
  // tell the user their package.json already changed (partial state).
  const inject = await applyInjection(plan, parsed, deps, {
    installed: install.installed,
    packages: install.packages,
  });

  // 6. Next steps — the installer is hands-off: it mints no key, so there is no
  // synthetic check to run. We still (optionally) wait for the first real event,
  // which arrives if the user sets their key + starts the app during the wait.
  const notes: string[] = [];
  if (!install.installed && install.note) notes.push(install.note);
  notes.push(...inject.notes);

  const setKeyHint = plan.keyEnvVar
    ? `Set ${plan.keyEnvVar} in your .env to your ingest key`
    : "Set your ingest key";

  // User-facing links point at the app host (the SPA), not the API host.
  const appBase = dashboardBase(base);

  let sessionUrl: string | undefined;
  if (parsed.skipVerify) {
    notes.push("Verification skipped (--skip-verify).");
  } else {
    ui.out(
      color.dim(
        `${setKeyHint} — mint one at ${appBase}/settings, then start your app.`,
      ),
    );
    const poll = await pollWithSigint(
      base,
      token,
      provisioned.projectId,
      deps,
      wizardStart,
    );
    if (poll.outcome === "found") {
      // The emotional payoff: deep-link straight to the captured session
      // (spec §4), and open it in the browser when one is available.
      sessionUrl = poll.sessionId
        ? `${appBase}/sessions/${encodeURIComponent(poll.sessionId)}`
        : `${appBase}/bugs`;
      ui.out(`${color.green("✓")} First real event received!`);
      ui.out(`  Watch it live: ${color.cyan(sessionUrl)}`);
      if (canUseBrowser(parsed.noBrowser, deps.env)) {
        const open = deps.openBrowserFn ?? openBrowser;
        if (await open(sessionUrl)) {
          ui.out(color.dim("  Opened your dashboard in the browser."));
        }
      }
    } else if (poll.outcome === "cancelled") {
      notes.push(
        "Stopped waiting for the first event — load your app any time.",
      );
    } else {
      notes.push(`No event yet — ${setKeyHint.toLowerCase()} and start your app.`);
    }
    // Point the user at the next lever — pulling in the evidence sources they
    // already run. Pointer only, no prompt.
    printEvidenceSourcesPointer(ui, base);
  }

  // 7. Summary.
  printSummary(
    ui,
    base,
    provisioned,
    inject.filesTouched,
    notes,
    plan.keyEnvVar,
    sessionUrl,
  );
  return 0;
}

/**
 * A short, non-interactive pointer to the pluggable evidence sources (VISION.md
 * pillar 1). Crumbtrail's own SDK stands alone, but each ticket's bundle gets
 * more complete when it also folds in the tools a team already runs — the six
 * built-in adapters (crumbtrail-node descriptors, surfaced on the dashboard's
 * Settings › Evidence sources card). Copy is deliberately limited to adapters
 * that actually exist so it can't over-promise.
 */
function printEvidenceSourcesPointer(ui: Ui, base: string): void {
  ui.out("");
  ui.out(color.bold("Next: make each ticket's evidence more complete."));
  ui.out(
    color.dim(
      "Crumbtrail's SDK stands alone, but it can also fold in evidence from tools",
    ),
  );
  ui.out(
    color.dim(
      "you already run — Sentry, CloudWatch, Splunk, Datadog, PostHog, Cloudflare —",
    ),
  );
  ui.out(color.dim("queried at incident time and added to each bug's bundle."));
  ui.out(`  Evidence sources: ${color.cyan(`${dashboardBase(base)}/settings`)}`);
}

// ── Batch wizard (monorepo root) ─────────────────────────────────────────────

export type ServiceStatus =
  | "wired" // files written
  | "guidance" // OTLP guide written, or the AI-fallback snippet printed
  | "skipped-already-wired" // pre-existing wiring; no service minted
  | "failed"; // provision / plan / execute threw

export interface ServiceOutcome {
  name: string;
  relDir: string;
  recipe: Recipe;
  status: ServiceStatus;
  serviceId?: string;
  /** Env var the injected code reads its key from (hands-off — user sets it). */
  keyEnvVar?: string;
  filesTouched: string[];
  notes: string[];
  error?: string;
  sessionUrl?: string;
}

/** Human label for the stack column: the detected OTLP stack beats the recipe. */
function stackLabel(c: ServiceCandidate): string {
  if (c.recipe == null) return "—";
  if (c.recipe === "otlp") return c.detected.otlpStack ?? "otlp";
  return c.recipe;
}

/** The trailing hint that explains why a row is unchecked (or unselectable). */
function candidateHint(c: ServiceCandidate): string {
  const stack = stackLabel(c);
  if (c.flags.includes("no-recipe")) return "no supported framework";
  if (c.flags.includes("already-wired")) return `${stack} · already wired`;
  if (c.flags.includes("otlp"))
    return `${stack} · OTLP guidance, no code changes`;
  if (c.flags.includes("likely-library"))
    return `${stack} · library? probably not an app`;
  if (c.flags.includes("ambiguous")) return `${stack} · entry file unclear`;
  return stack;
}

function toMultiSelectItems(candidates: ServiceCandidate[]): MultiSelectItem[] {
  return candidates.map((c) => ({
    label: c.relDir,
    hint: candidateHint(c),
    checked: c.defaultChecked,
    selectable: c.selectable,
  }));
}

/**
 * Resolve --only/--all into indices, or null when we should prompt.
 * Returns a string on a user error (unknown --only value).
 */
export function resolveSelection(
  parsed: ParsedArgs,
  candidates: ServiceCandidate[],
): { indices: number[] } | { error: string } | null {
  if (parsed.only && parsed.only.length > 0) {
    const indices: number[] = [];
    for (const want of parsed.only) {
      const needle = want.toLowerCase();
      const i = candidates.findIndex(
        (c) =>
          c.name.toLowerCase() === needle || c.relDir.toLowerCase() === needle,
      );
      if (i < 0) {
        return {
          error: `--only ${want}: no such service. Found: ${candidates.map((c) => c.relDir).join(", ")}`,
        };
      }
      if (!candidates[i].selectable) {
        return {
          error: `--only ${want}: no supported framework detected there — it can't be wired.`,
        };
      }
      if (!indices.includes(i)) indices.push(i);
    }
    return { indices };
  }
  if (parsed.all) {
    return {
      indices: candidates
        .map((c, i) => (c.selectable ? i : -1))
        .filter((i) => i >= 0),
    };
  }
  return null;
}

interface BatchContext {
  base: string;
  wizardStart: number;
  root: DetectResult;
}

/**
 * The monorepo path: scan → pick → one login → one project → wire each selected
 * service → one shared wait → summary.
 *
 * A failure on one service never sinks the batch (each is try/caught and
 * recorded), because a half-wired repo with a clear report is strictly better
 * than an abort that leaves the user guessing which services made it.
 */
export async function runBatchWizard(
  parsed: ParsedArgs,
  deps: WizardDeps,
  ctx: BatchContext,
): Promise<number> {
  const { ui } = deps;
  const { base, wizardStart } = ctx;
  const root = deps.cwd;

  // 1. Scan.
  const candidates = deps.discoverServices(root, ctx.root);
  const selectableCount = candidates.filter((c) => c.selectable).length;
  ui.out(
    `${color.green("✓")} Monorepo — found ${color.bold(String(candidates.length))} package(s), ${color.bold(String(selectableCount))} wireable.`,
  );
  if (selectableCount === 0) {
    ui.err("");
    ui.err(color.red("Nothing here can be wired."));
    for (const c of candidates) {
      ui.err(color.dim(`  · ${c.relDir} — ${candidateHint(c)}`));
    }
    ui.err(
      "Supported: Next.js, SvelteKit, Nuxt, Remix, Astro, Angular, Vite SPA, NestJS, Express, Hono, Fastify, a Node server, or a non-JS backend that speaks OpenTelemetry (Django, Flask, FastAPI, Go, Rails, .NET).",
    );
    return 1;
  }

  // 2. Select.
  const preset = resolveSelection(parsed, candidates);
  if (preset && "error" in preset) {
    ui.err(color.red(preset.error));
    return 1;
  }
  let indices: number[];
  if (preset) {
    indices = preset.indices;
  } else if (!deps.isTTY) {
    // No prompt available and no explicit selection: refuse rather than guess
    // which of someone's services should start reporting.
    ui.err("");
    ui.err(
      color.red(
        "Monorepo root, but there's no TTY to pick services. Pass --only <service> (repeatable) or --all.",
      ),
    );
    for (const c of candidates) {
      if (c.selectable) ui.err(color.dim(`  · ${c.relDir}`));
    }
    return 1;
  } else {
    ui.out("");
    indices = await deps.prompter.multiSelect(
      "Which services should Crumbtrail wire?",
      toMultiSelectItems(candidates),
    );
  }
  const selected = indices.map((i) => candidates[i]);
  if (selected.length === 0) {
    ui.out(color.yellow("Nothing selected — no changes made."));
    return 0;
  }

  // 3. Login (once for the whole batch).
  let token: string;
  try {
    token = await deps.ensureToken({
      base,
      ui,
      noBrowser: parsed.noBrowser,
      fetchImpl: deps.fetchImpl,
      env: deps.env,
      allowInteractiveLogin: deps.isTTY,
    });
  } catch (err) {
    ui.err(color.red(`Login failed: ${errMessage(err)}`));
    return 1;
  }

  // 4. Project (once — every service reports into the same project).
  const defaultProjectName = inferProjectName(
    readPkgName(root),
    path.basename(root),
  );
  let project;
  try {
    project = await deps.resolveProject({
      base,
      token,
      ui,
      prompter: deps.prompter,
      assumeYes: parsed.yes,
      projectId: parsed.project,
      defaultProjectName,
      fetchImpl: deps.fetchImpl,
    });
  } catch (err) {
    if (err instanceof UpgradeRequiredError) {
      ui.err("");
      ui.err(color.yellow(err.message));
      if (err.upgradeUrl) ui.err(`Upgrade: ${color.cyan(err.upgradeUrl)}`);
      return 1;
    }
    ui.err(color.red(`Provisioning failed: ${errMessage(err)}`));
    return 1;
  }

  // Names are inferred, not prompted — asking N times is hostile — but two
  // frontends both inferring to "web" would be indistinguishable in the
  // dashboard, so de-collide before minting anything.
  const serviceNames = uniqueServiceNames(
    selected.map((c) => ({
      name: inferServiceName(c.recipe as Recipe, c.name),
      relDir: c.relDir,
    })),
  );

  // 5. Wire each service.
  const outcomes: ServiceOutcome[] = [];
  for (const [i, c] of selected.entries()) {
    const recipe = c.recipe as Recipe;
    const name = serviceNames[i];
    ui.out("");
    ui.out(
      color.bold(`[${i + 1}/${selected.length}] ${c.relDir}`) +
        color.dim(` — ${stackLabel(c)}`),
    );

    if (c.flags.includes("already-wired")) {
      // Don't mint a key for a service whose plan would self-cancel anyway.
      ui.out(`${color.green("✓")} Already wired — leaving it untouched.`);
      outcomes.push({
        name,
        relDir: c.relDir,
        recipe,
        status: "skipped-already-wired",
        filesTouched: [],
        notes: [],
      });
      continue;
    }

    try {
      const svc = await deps.provisionService({
        base,
        token,
        projectId: project.id,
        recipe,
        stack: c.detected.otlpStack,
        serviceName: name,
        ui,
        fetchImpl: deps.fetchImpl,
      });

      // buildPlan BEFORE installSdk — see the single-package path: the plan's
      // idempotency check keys off package.json referencing crumbtrail-core, so
      // installing first would self-cancel injection.
      const plan = deps.buildPlan({
        cwd: c.dir,
        recipe,
        endpoint: base,
        entryFile: c.detected.entryFile,
        nextVersion: c.detected.nextVersion,
        stack: c.detected.otlpStack ?? undefined,
        options: { force: parsed.yes },
      }, defaultInjectIO);

      const install = await deps.installSdk({
        cwd: c.dir,
        packageManager: c.detected.packageManager ?? ctx.root.packageManager,
        recipe,
        base,
        ui,
        fetchImpl: deps.fetchImpl,
      });
      if (install.installed) {
        ui.out(`${color.green("✓")} Installed ${install.packages.join(", ")}.`);
      } else if (install.note) {
        ui.out(color.yellow(`! ${install.note}`));
      }

      const applied = await applyBatchInjection(plan, c, svc.serviceName, {
        parsed,
        deps,
        base,
        sdkInstall: {
          installed: install.installed,
          packages: install.packages,
        },
      });
      outcomes.push({
        name: svc.serviceName,
        relDir: c.relDir,
        recipe,
        status: applied.status,
        serviceId: svc.serviceId,
        keyEnvVar: plan.keyEnvVar,
        filesTouched: applied.filesTouched,
        notes: [
          ...(!install.installed && install.note ? [install.note] : []),
          ...applied.notes,
        ],
      });
    } catch (err) {
      // executePlan throws (and rolls back), so this dir is byte-identical to
      // how we found it. Record and keep going.
      const message = errMessage(err);
      ui.err(color.red(`✗ ${c.relDir}: ${message}`));
      outcomes.push({
        name,
        relDir: c.relDir,
        recipe,
        status: "failed",
        filesTouched: [],
        notes: [],
        error: message,
      });
    }
  }

  // 6. Next steps — hands-off: no keys were minted, so there's no synthetic
  // check. We still open ONE shared wait for real events (arriving if the user
  // sets each key + starts the service during the wait).
  const reporting = outcomes.filter(
    (o) => o.status === "wired" || o.status === "guidance",
  );
  const batchNotes: string[] = [];
  if (parsed.skipVerify) {
    // One note for the run, not one per service — the same line repeated N
    // times is noise, not information.
    batchNotes.push("Verification skipped (--skip-verify).");
  } else if (reporting.length > 0) {
    // User-facing links point at the app host (the SPA), not the API host.
    const appBase = dashboardBase(base);
    for (const o of reporting) {
      if (o.keyEnvVar) {
        o.notes.push(
          `Set ${o.keyEnvVar} in this service's .env (mint at ${appBase}/settings).`,
        );
      }
    }

    const byServiceId = new Map(
      reporting
        .filter((o) => o.serviceId)
        .map((o) => [o.serviceId as string, o]),
    );
    const poll = await pollServicesWithSigint(
      {
        base,
        token,
        projectId: project.id,
        ui,
        wizardStart,
        serviceIds: [...byServiceId.keys()],
        onFound: (serviceId, sessionId) => {
          const o = byServiceId.get(serviceId);
          if (!o) return;
          o.sessionUrl = `${appBase}/sessions/${encodeURIComponent(sessionId)}`;
          ui.out(`${color.green("✓")} ${o.name}: first event received.`);
        },
        fetchImpl: deps.fetchImpl,
      },
      deps,
    );
    if (poll.outcome !== "found") {
      // Stragglers are expected — the user hasn't started every service. This is
      // information, not a failure.
      for (const o of byServiceId.values()) {
        if (!o.sessionUrl) o.notes.push("No event yet — start this service.");
      }
    }
  }

  // Same onboarding pointer as the single-package path — once for the batch,
  // only when a verify actually ran (something is wired and reporting).
  if (!parsed.skipVerify && reporting.length > 0) {
    printEvidenceSourcesPointer(ui, base);
  }

  printBatchSummary(ui, base, root, project.name, outcomes, batchNotes);

  const attempted = outcomes.filter(
    (o) => o.status !== "skipped-already-wired",
  );
  const anyGood = outcomes.some(
    (o) => o.status === "wired" || o.status === "guidance",
  );
  // Only a total wipeout is a failure: a partial batch still wired something.
  return attempted.length > 0 && !anyGood ? 1 : 0;
}

/** Apply one service's plan; OTLP writes a guide file instead of injecting. */
async function applyBatchInjection(
  plan: Plan,
  candidate: ServiceCandidate,
  serviceName: string,
  ctx: {
    parsed: ParsedArgs;
    deps: WizardDeps;
    base: string;
    sdkInstall?: SdkInstallState;
  },
): Promise<{
  status: ServiceStatus;
  filesTouched: string[];
  notes: string[];
}> {
  const { parsed, deps, base } = ctx;

  if (plan.kind === "otlp-guidance") {
    // The one place the batch diverges from the single-package path: rather than
    // printing guidance that scrolls away behind nine other services, drop it in
    // the service's own directory where it'll still be there tomorrow.
    const body = renderOtlpGuide({
      stack: candidate.detected.otlpStack ?? RECIPE_REGISTRY.otlp.stack,
      serviceName,
      endpoint: base,
      snippet: plan.snippet ?? "",
      agentPrompt: plan.agentPrompt ?? "",
    });
    const res = deps.executePlan(otlpGuidePlan(candidate.dir, body));
    deps.ui.out(
      `${color.green("✓")} Speaks OpenTelemetry — no SDK needed. Wrote ${color.cyan(res.written.join(", "))}.`,
    );
    return {
      status: "guidance",
      filesTouched: res.written,
      // The summary already prefixes each note with the service name.
      notes: ["add the OTLP exporter from the guide file to start reporting."],
    };
  }

  const applied = await applyInjection(plan, parsed, deps, ctx.sdkInstall);
  const status: ServiceStatus =
    plan.kind === "fallback-ai"
      ? "guidance"
      : applied.filesTouched.length > 0
        ? "wired"
        : "skipped-already-wired";
  return { status, filesTouched: applied.filesTouched, notes: applied.notes };
}

function printBatchSummary(
  ui: Ui,
  base: string,
  root: string,
  projectName: string,
  outcomes: ServiceOutcome[],
  batchNotes: string[] = [],
): void {
  const mark: Record<ServiceStatus, string> = {
    wired: color.green("✓"),
    guidance: color.green("✓"),
    "skipped-already-wired": color.dim("·"),
    failed: color.red("✗"),
  };
  const width = Math.max(...outcomes.map((o) => o.name.length), 4);
  // Absolute temp/monorepo paths make the summary unreadable; the user already
  // knows where their repo is.
  const rel = (p: string) => path.relative(root, p) || p;

  ui.out("");
  ui.out(color.bold(`Setup complete — project "${projectName}"`));
  ui.out("");
  for (const o of outcomes) {
    const detail =
      o.status === "failed"
        ? color.red(`failed: ${o.error}`)
        : o.status === "skipped-already-wired"
          ? color.dim("already wired — skipped")
          : o.sessionUrl
            ? color.cyan(o.sessionUrl)
            : o.filesTouched.length > 0
              ? color.dim(o.filesTouched.map(rel).join(", "))
              : "";
    ui.out(
      `  ${mark[o.status]} ${o.name.padEnd(width)}  ${color.dim(o.relDir.padEnd(24))} ${detail}`,
    );
  }

  const count = (s: ServiceStatus) =>
    outcomes.filter((o) => o.status === s).length;
  const parts = [
    `${count("wired")} wired`,
    ...(count("guidance") > 0 ? [`${count("guidance")} guidance`] : []),
    ...(count("failed") > 0 ? [`${count("failed")} failed`] : []),
    ...(count("skipped-already-wired") > 0
      ? [`${count("skipped-already-wired")} skipped`]
      : []),
  ];
  ui.out("");
  ui.out(`  ${parts.join(" · ")}`);
  ui.out(`  Dashboard: ${color.cyan(`${dashboardBase(base)}/bugs`)}`);

  const notes = [
    ...outcomes.flatMap((o) => o.notes.map((n) => `${o.name}: ${n}`)),
    ...batchNotes,
  ];
  if (count("failed") > 0) {
    notes.push("Re-run `crumbtrail` to retry — wired services are skipped.");
  }
  if (notes.length > 0) {
    ui.out("");
    for (const n of notes) ui.out(color.dim(`  note: ${n}`));
  }
}

interface InjectionResult {
  filesTouched: string[];
  notes: string[];
}

/** What installSdk did just before injection — so a dirty-file decline can state
 *  the partial state (deps already added to package.json) accurately. */
interface SdkInstallState {
  installed: boolean;
  packages: string[];
}

/** Announce + apply the injection plan, handling dirty-confirm and AI fallback. */
async function applyInjection(
  plan: Plan,
  parsed: ParsedArgs,
  deps: WizardDeps,
  sdkInstall?: SdkInstallState,
): Promise<InjectionResult> {
  const { ui } = deps;
  const filesTouched: string[] = [];
  const notes: string[] = [];
  for (const w of plan.warnings) ui.out(color.dim(`  · ${w}`));

  if (plan.kind === "skip-already-wired") {
    ui.out(`${color.green("✓")} Already wired — leaving your code untouched.`);
    return { filesTouched, notes };
  }

  if (plan.kind === "fallback-ai") {
    ui.out(color.yellow("Couldn't safely edit your code automatically."));
    if (plan.snippet) {
      ui.out(color.dim("Paste this into your entry file:"));
      ui.out(plan.snippet);
    }
    if (plan.agentPrompt) {
      ui.out(color.dim("\nOr hand this to your coding agent:"));
      ui.out(plan.agentPrompt);
    }
    notes.push("Injection fell back to a manual snippet / AI prompt.");
    return { filesTouched, notes };
  }

  if (plan.kind === "otlp-guidance") {
    // Intentional path (not an apology): a non-JS backend that already speaks
    // OpenTelemetry. Print the OTLP setup guidance + agent prompt; touch nothing.
    ui.out(
      `${color.green("✓")} Detected a non-JS backend that already speaks OpenTelemetry — no SDK needed.`,
    );
    ui.out(color.dim("Point your existing OTLP exporter at Crumbtrail:"));
    if (plan.snippet) ui.out(plan.snippet);
    if (plan.agentPrompt) {
      ui.out(color.dim("\nOr hand this to your coding agent:"));
      ui.out(plan.agentPrompt);
    }
    notes.push(
      "OTLP backend — printed OpenTelemetry setup guidance; no files were changed.",
    );
    return { filesTouched, notes };
  }

  if (plan.kind === "needs-confirm-dirty") {
    const ok = parsed.yes
      ? true
      : await deps.prompter.confirm(
          `${plan.targetPath} has uncommitted changes — prepend into it anyway?`,
          false,
        );
    if (!ok) {
      ui.out(
        color.yellow("Left your file untouched. Add this to the top yourself:"),
      );
      if (plan.content) ui.out(plan.content);
      notes.push(
        `Skipped editing ${plan.targetPath} (uncommitted changes) — paste the snippet above into it manually.`,
      );
      // The SDK install already ran (it precedes injection), so on a decline the
      // repo is in a partial state: package.json changed even though no code was
      // injected. Say so explicitly rather than let the user think nothing moved.
      if (sdkInstall?.installed && sdkInstall.packages.length > 0) {
        const pkgs = sdkInstall.packages.join(", ");
        const were = sdkInstall.packages.length > 1 ? "were" : "was";
        notes.push(
          `${pkgs} ${were} already installed, so your package.json is already updated — only the code import above is still manual.`,
        );
      }
      return { filesTouched, notes };
    }
    const res = deps.executePlan(plan, undefined, { confirmDirty: true });
    filesTouched.push(...res.written);
    ui.out(`${color.green("✓")} ${describeWrites(res)}`);
    return { filesTouched, notes };
  }

  // create / prepend
  if (plan.targetPath) {
    ui.out(
      `${plan.kind === "create" ? "Creating" : "Editing"} ${color.cyan(plan.targetPath)}…`,
    );
  }
  const res = deps.executePlan(plan);
  filesTouched.push(...res.written);
  ui.out(`${color.green("✓")} ${describeWrites(res)}`);
  return { filesTouched, notes };
}

/** Name the files a write touched — "Wrote 2 file(s)." is nobody's payoff. */
function describeWrites(res: { written: string[]; message: string }): string {
  if (res.written.length === 0) return res.message;
  return `Crumbtrail wired in — wrote ${res.written.join(", ")}.`;
}

/** Poll for the first real event, aborting cleanly on Ctrl-C. */
async function pollWithSigint(
  base: string,
  token: string,
  projectId: string,
  deps: WizardDeps,
  wizardStart: number,
): Promise<PollRealEventResult> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    return await deps.pollForRealEvent({
      base,
      token,
      projectId,
      ui: deps.ui,
      wizardStart,
      signal: controller.signal,
      fetchImpl: deps.fetchImpl,
    });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

/** Same Ctrl-C contract as pollWithSigint, for the batch's one shared wait. */
async function pollServicesWithSigint(
  opts: Omit<Parameters<typeof pollForServices>[0], "signal">,
  deps: WizardDeps,
): Promise<PollServicesResult> {
  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    return await deps.pollForServices({ ...opts, signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

function printSummary(
  ui: Ui,
  base: string,
  p: ProvisionResult,
  filesTouched: string[],
  notes: string[],
  keyEnvVar?: string,
  sessionUrl?: string,
): void {
  // User-facing links point at the app host (the SPA), not the API host.
  const appBase = dashboardBase(base);
  ui.out("");
  ui.out(color.bold("Setup complete"));
  ui.out(`  Project:   ${p.projectName}`);
  ui.out(`  Service:   ${p.serviceName}`);
  if (keyEnvVar) {
    // Hands-off: the installer wrote no key. Tell the user the var to set and
    // where to mint the value.
    ui.out(
      `  Ingest key: set ${color.bold(keyEnvVar)} in .env ${color.dim(`(mint at ${appBase}/settings)`)}`,
    );
  }
  if (filesTouched.length > 0) {
    ui.out(`  Files:     ${filesTouched.join("\n             ")}`);
  }
  if (sessionUrl) {
    ui.out(`  Session:   ${color.cyan(sessionUrl)}`);
  }
  ui.out(`  Dashboard: ${color.cyan(`${appBase}/bugs`)}`);
  if (notes.length > 0) {
    ui.out("");
    for (const n of notes) ui.out(color.dim(`  note: ${n}`));
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── login / logout subcommands ───────────────────────────────────────────────

async function runLogin(parsed: ParsedArgs, deps: WizardDeps): Promise<number> {
  const base = resolveEndpoint(parsed.endpoint, deps.env);
  try {
    await deps.ensureToken({
      base,
      ui: deps.ui,
      noBrowser: parsed.noBrowser,
      fetchImpl: deps.fetchImpl,
      env: deps.env,
      allowInteractiveLogin: deps.isTTY,
    });
    return 0;
  } catch (err) {
    deps.ui.err(color.red(`Login failed: ${errMessage(err)}`));
    return 1;
  }
}

function runLogout(deps: WizardDeps): number {
  const cleared = clearStoredAuth(deps.env);
  deps.ui.out(cleared ? "Logged out." : "No saved login to clear.");
  return 0;
}

// ── verify subcommand (synthetic preflight) ──────────────────────────────────

/**
 * Pick the credential the preflight auth stage probes with. An explicit --key
 * (or $CRUMBTRAIL_KEY) is the primary CI path — it exercises the SDK's ingest
 * path. Absent a key we fall back to the cached login token, but only if it was
 * minted for THIS endpoint (a token is only reused for its base). Nothing → the
 * auth stage reports a clear "no credential" failure.
 */
export function resolveAuthProbe(
  base: string,
  key: string | undefined,
  projectId: string | undefined,
  env: NodeJS.ProcessEnv,
): AuthProbe {
  const explicit = (key && key.trim()) || (env.CRUMBTRAIL_KEY && env.CRUMBTRAIL_KEY.trim());
  if (explicit) return { kind: "ingestKey", key: explicit };
  const stored = loadAuth(env);
  if (stored && stored.token && stored.endpoint === base) {
    return { kind: "bearer", token: stored.token, projectId };
  }
  return { kind: "none" };
}

const STAGE_GLYPH: Record<StageResult["status"], string> = {
  pass: color.green("✓"),
  fail: color.red("✗"),
  skipped: color.yellow("○"),
};

const STAGE_LABEL: Record<StageResult["stage"], string> = {
  dns: "DNS ",
  tls: "TLS ",
  auth: "Auth",
};

function renderPreflight(result: PreflightResult, ui: Ui): void {
  ui.out("");
  ui.out(`${color.bold("Crumbtrail preflight")} → ${result.endpoint}`);
  ui.out("");
  for (const s of result.stages) {
    const ms = s.status === "skipped" ? "" : color.dim(`(${s.ms}ms)`);
    ui.out(`  ${STAGE_GLYPH[s.status]} ${STAGE_LABEL[s.stage]}  ${s.reason} ${ms}`.trimEnd());
  }
  ui.out("");
  ui.out(
    result.ok
      ? `${color.green("PASS")} — endpoint and key are reachable and authenticated`
      : `${color.red("FAIL")} — fix the failing stage above before deploying`,
  );
}

async function runVerify(parsed: ParsedArgs, deps: WizardDeps): Promise<number> {
  const base = resolveEndpoint(parsed.endpoint, deps.env);
  const probe = resolveAuthProbe(base, parsed.key, parsed.project, deps.env);
  const result = await deps.runPreflight({
    endpoint: base,
    probe,
    fetchImpl: deps.fetchImpl,
  });
  if (parsed.json) {
    deps.ui.out(JSON.stringify(toJson(result)));
  } else {
    renderPreflight(result, deps.ui);
  }
  return exitCodeFor(result);
}

// ── Entry ────────────────────────────────────────────────────────────────────

export async function runCli(
  argv: string[],
  deps: WizardDeps = defaultDeps(),
): Promise<number> {
  const parsed = parseArgs(argv);

  if (parsed.command === "version") {
    deps.ui.out(readVersion());
    return 0;
  }
  if (parsed.command === "help") {
    deps.ui.out(USAGE);
    return 0;
  }
  if (parsed.unknown) {
    deps.ui.err(`Unknown argument: ${parsed.unknown}\n`);
    deps.ui.err(USAGE);
    return 1;
  }
  if (parsed.command === "login") return runLogin(parsed, deps);
  if (parsed.command === "logout") return runLogout(deps);
  // `verify` is non-interactive by design (no prompts, no browser) so it runs
  // before the TTY guard — pointing it at prod from CI is the whole point.
  if (parsed.command === "verify") return runVerify(parsed, deps);

  // Non-TTY guard — BEFORE any prompt. CI must pass --yes AND --project.
  if (!deps.isTTY && !(parsed.yes && parsed.project)) {
    deps.ui.err(
      color.red(
        "Non-interactive shell detected. Pass --yes and --project <id> to run without prompts.",
      ),
    );
    deps.ui.err("");
    deps.ui.err(USAGE);
    return 1;
  }

  return runWizard(parsed, deps);
}

// Auto-run only when invoked directly as the bin (not when imported in tests).
// npm installs POSIX bins as a symlink NAMED AFTER THE BIN KEY (`crumbtrail`, not
// `cli.cjs`) and Node does not realpath process.argv[1], so the check must match
// the bin name too — mirrors packages/node/src/cli.ts's isCliEntrypoint.
export function isCliEntrypoint(argv1: string | undefined): boolean {
  if (!argv1) return false;
  return ["cli.ts", "cli.js", "cli.cjs", "cli.mjs", "crumbtrail"].includes(
    path.basename(argv1),
  );
}

if (isCliEntrypoint(process.argv[1])) {
  runCli(process.argv)
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`crumbtrail: ${errMessage(err)}\n`);
      process.exit(1);
    });
}
