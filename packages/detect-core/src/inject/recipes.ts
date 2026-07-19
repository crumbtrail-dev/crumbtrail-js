// Pure injection plan-builders. Each recipe reads (never writes) via InjectIO and
// returns a Plan describing exactly what should happen. The executor (executor.ts)
// is the only module that mutates the filesystem.
//
// Pre-flight order, before ANY write is planned:
//   1. idempotency  — project/target already references crumbtrail-core/-node -> skip
//   2. cleanliness  — git status on the target; dirty -> needs-confirm (unless force)
//   3. sanity       — target is a readable module (prepend) or safe-to-create
// Any failure or ambiguity -> fallback-ai plan carrying the filled snippet +
// buildAgentPrompt(...) from crumbtrail-install-shared.

import path from "node:path";
import { buildAgentPrompt, buildOtlpSnippets } from "crumbtrail-install-shared";
import type { Stack } from "crumbtrail-core";
import type { Recipe } from "../detect";
import { RECIPE_REGISTRY } from "../recipe-registry";
import type { InjectIO } from "./io";
import type { Plan } from "./types";
import {
  detectExpressModuleStyle,
  prependIntoSource,
  referencesCrumbtrail,
  wireExpressMiddleware,
  withTrailingNewline,
} from "./text";
import {
  clientInitSnippet,
  expressErrorMiddlewareSnippet,
  expressManualWiringSnippet,
  expressMiddlewareImportSnippet,
  expressRequestMiddlewareSnippet,
  nestInitSnippet,
  nodeInitSnippet,
  nuxtPluginSnippet,
  reactNativeInitSnippet,
  tauriInitSnippet,
} from "./snippets";

/**
 * Placeholder used in printed guidance (fallback-ai + OTLP) now that the
 * installer never mints a key. The user replaces it with the key they mint in
 * the dashboard. Never written to a file — only shown in copyable instructions.
 */
const KEY_PLACEHOLDER = "<your-ingest-key>";

/** The code expression an injected snippet uses to read the key, per recipe. */
function keyExprFor(recipe: Recipe): string | undefined {
  return RECIPE_REGISTRY[recipe].keyRef?.expr;
}

export interface BuildPlanOptions {
  /** Prepend into a dirty (uncommitted) target instead of asking to confirm. */
  force?: boolean;
}

export interface BuildPlanInput {
  cwd: string;
  recipe: Recipe;
  endpoint: string;
  /** Absolute entry path for vite-spa / node (from detection). */
  entryFile?: string | null;
  /** Raw `next` version range from detection (drives new-file vs legacy-prepend). */
  nextVersion?: string | null;
  /**
   * The detected non-JS backend Stack for the `otlp` recipe (from
   * `DetectResult.otlpStack`). Drives the guidance agent prompt; ignored for
   * every other recipe.
   */
  stack?: Stack;
  options?: BuildPlanOptions;
}

// --- shared plan constructors ------------------------------------------------

function skipPlan(input: BuildPlanInput, warnings: string[] = []): Plan {
  return {
    recipe: input.recipe,
    kind: "skip-already-wired",
    targetPath: null,
    content: null,
    warnings: [
      ...warnings,
      "Project already references Crumbtrail — nothing to inject.",
    ],
  };
}

function fallbackPlan(
  input: BuildPlanInput,
  snippet: string,
  warnings: string[],
): Plan {
  return {
    recipe: input.recipe,
    kind: "fallback-ai",
    targetPath: null,
    content: null,
    snippet,
    // Hands-off: the prompt reads the key from env / the dashboard, never a
    // baked-in literal (KEY_PLACEHOLDER stands in for the user's own key). Pass
    // the recipe's exact keyRef so the prompt names the same env var the injected
    // snippet reads (e.g. Astro's PUBLIC_, Expo's EXPO_PUBLIC_) — the coarse Stack
    // alone can't distinguish those.
    agentPrompt: buildAgentPrompt(
      RECIPE_REGISTRY[input.recipe].stack,
      {
        endpoint: input.endpoint,
        apiKey: KEY_PLACEHOLDER,
      },
      RECIPE_REGISTRY[input.recipe].keyRef,
    ),
    warnings,
  };
}

function createPlan(
  input: BuildPlanInput,
  target: string,
  block: string,
  warnings: string[] = [],
): Plan {
  return {
    recipe: input.recipe,
    kind: "create",
    targetPath: target,
    content: withTrailingNewline(block),
    warnings,
  };
}

/**
 * Pre-flight an existing-file prepend: idempotency -> cleanliness -> sanity.
 * Falls back to the AI plan when the file cannot be read; asks to confirm when
 * dirty (unless force). Returns null when the caller should skip (already wired).
 */
function prependWithPreflight(
  input: BuildPlanInput,
  io: InjectIO,
  target: string,
  block: string,
  warnings: string[] = [],
): Plan {
  const existing = io.readFile(target);
  if (existing == null) {
    // Sanity: we thought this file existed but can't read it — hand off.
    return fallbackPlan(input, block, [
      ...warnings,
      `Could not read ${target}; use the snippet or AI prompt to wire it manually.`,
    ]);
  }
  if (referencesCrumbtrail(existing)) {
    return skipPlan(input, warnings);
  }
  const status = io.gitStatus(input.cwd, target);
  if (status.dirty && !input.options?.force) {
    return {
      recipe: input.recipe,
      kind: "needs-confirm-dirty",
      targetPath: target,
      content: block,
      warnings: [
        ...warnings,
        `${target} has uncommitted changes — confirm (or re-run with force) before prepending.`,
      ],
    };
  }
  return {
    recipe: input.recipe,
    kind: "prepend",
    targetPath: target,
    content: block,
    warnings,
  };
}

// --- idempotency (project-level) --------------------------------------------

/**
 * The EXACT installed `next` version from `node_modules/next/package.json`, or
 * null when next is not installed / unreadable. Preferred over the declared
 * range because a range like `^15` can resolve to either a legacy 15.2 install
 * or a modern 15.4 one — and the instrumentation-client gate must reflect what
 * will actually run, not what was requested.
 */
function installedNextVersion(cwd: string, io: InjectIO): string | null {
  const text = io.readFile(
    path.join(cwd, "node_modules", "next", "package.json"),
  );
  if (text == null) return null;
  try {
    const pkg = JSON.parse(text) as { version?: string };
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * True when this package already depends on a Crumbtrail SDK. Load-bearing for
 * the batch installer, which must decide whether to provision a service BEFORE
 * it builds a plan — `buildPlan` uses this to self-cancel into
 * `skip-already-wired`, so a re-run must not mint a second key for a service
 * that is going to be skipped anyway.
 */
export function projectAlreadyWired(cwd: string, io: InjectIO): boolean {
  const text = io.readFile(path.join(cwd, "package.json"));
  if (text == null) return false;
  try {
    const pkg = JSON.parse(text) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return "crumbtrail-core" in deps || "crumbtrail-node" in deps;
  } catch {
    return false;
  }
}

// --- next version handling ---------------------------------------------------

/**
 * `instrumentation-client.ts` is auto-loaded from Next 15.3+. Parse the leading
 * numeric range; treat non-numeric ranges ("latest", "canary", workspace:) as
 * new-enough.
 */
export function supportsInstrumentationClient(
  version: string | null | undefined,
): boolean {
  if (!version) return true;
  const m = version.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return true; // "latest" / "canary" / "workspace:*" -> assume current
  const major = Number(m[1]);
  const minor = m[2] ? Number(m[2]) : 0;
  if (major > 15) return true;
  if (major < 15) return false;
  return minor >= 3;
}

// --- per-recipe builders -----------------------------------------------------

function firstExistingDir(io: InjectIO, ...dirs: string[]): string | null {
  return dirs.find((d) => io.exists(d)) ?? null;
}

function planNext(input: BuildPlanInput, io: InjectIO): Plan {
  const { cwd } = input;
  const block = clientInitSnippet(input.endpoint, keyExprFor(input.recipe)!);
  // Prefer `src/` when the app uses a src directory.
  const usesSrc =
    io.exists(path.join(cwd, "src", "app")) ||
    io.exists(path.join(cwd, "src", "pages"));
  const baseDir = usesSrc ? path.join(cwd, "src") : cwd;

  // Gate on the INSTALLED next version when available (a declared range like
  // `^15` can resolve to a legacy or a modern install); fall back to the
  // declared range from detection.
  const effectiveVersion = installedNextVersion(cwd, io) ?? input.nextVersion;

  if (supportsInstrumentationClient(effectiveVersion)) {
    const target = path.join(baseDir, "instrumentation-client.ts");
    if (io.exists(target)) {
      const existing = io.readFile(target);
      if (existing && referencesCrumbtrail(existing)) return skipPlan(input);
      // A user-owned instrumentation-client already exists — prepend into it.
      return prependWithPreflight(input, io, target, block);
    }
    return createPlan(input, target, block);
  }

  // Older Next (<15.3): instrumentation-client.ts is NOT auto-loaded, so the
  // client init must land in a module that actually executes in the browser.
  const pagesApp =
    firstExistingDir(
      io,
      path.join(baseDir, "pages", "_app.tsx"),
      path.join(baseDir, "pages", "_app.jsx"),
    ) ?? null;
  if (pagesApp) {
    // (a) Pages Router: _app is a client-executed root — safe to prepend.
    return prependWithPreflight(input, io, pagesApp, block, [
      "Older Next.js — prepending into pages/_app; move to instrumentation-client.ts after upgrading to 15.3+.",
    ]);
  }

  const appLayout =
    firstExistingDir(
      io,
      path.join(baseDir, "app", "layout.tsx"),
      path.join(baseDir, "app", "layout.jsx"),
    ) ?? null;
  if (appLayout) {
    // (b) App Router only, legacy Next: the root layout is a Server Component
    // that never ships to the browser, so prepending client init there captures
    // nothing. Hand off with a concrete path forward instead.
    return fallbackPlan(input, block, [
      'Next <15.3 with only an app-router root layout: client init can\'t be prepended into app/layout (a Server Component that never ships to the browser). Add the snippet to a "use client" module imported by the root layout, or upgrade to Next 15.3+ for the auto-loaded instrumentation-client.ts.',
    ]);
  }

  // (c) Neither a pages/_app nor an app/layout was found.
  return fallbackPlan(input, block, [
    "Older Next.js detected but no app/layout or pages/_app file was found.",
  ]);
}

function planSvelteKit(input: BuildPlanInput, io: InjectIO): Plan {
  const target = path.join(input.cwd, "src", "hooks.client.ts");
  const block = clientInitSnippet(input.endpoint, keyExprFor(input.recipe)!);
  if (io.exists(target)) {
    return prependWithPreflight(input, io, target, block);
  }
  return createPlan(input, target, block);
}

function planNuxt(input: BuildPlanInput, io: InjectIO): Plan {
  const { cwd } = input;
  // Nuxt 4's default srcDir is app/, so plugins are scanned from app/plugins/.
  // Target app/plugins/ when an app/ directory exists (mirrors planNext's
  // usesSrc probe); fall back to the repo-root plugins/ for Nuxt 3. Getting this
  // wrong is a silent zero-capture: Nuxt 4 never loads a root plugins/ file.
  const baseDir = io.exists(path.join(cwd, "app"))
    ? path.join(cwd, "app")
    : cwd;
  const target = path.join(baseDir, "plugins", "crumbtrail.client.ts");
  const block = nuxtPluginSnippet(input.endpoint, keyExprFor(input.recipe)!);
  if (io.exists(target)) {
    const existing = io.readFile(target);
    if (existing && referencesCrumbtrail(existing)) return skipPlan(input);
    // Don't clobber an existing user plugin of the same name — hand off.
    return fallbackPlan(input, block, [
      `${target} already exists and isn't Crumbtrail's — wire it manually.`,
    ]);
  }
  return createPlan(input, target, block);
}

function planVite(input: BuildPlanInput, io: InjectIO): Plan {
  const block = clientInitSnippet(input.endpoint, keyExprFor(input.recipe)!);
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Vite entry from index.html — wire it manually.",
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block);
}

/**
 * Shared backend-JS plan builder. Hono, Fastify, Nest, and the generic Node
 * recipe inject (Express has its own builder, planExpress, which also wires the
 * request/error middleware pair) the same self-contained `autoCapture` block (the only
 * prepend-safe server snippet — no `app` handle is available at the top of a
 * file). The block reads the key from process.env.CRUMBTRAIL_KEY, which the user
 * sets themselves (hands-off — the installer writes no key). Framework-specific
 * middleware wiring is left to `buildAgentPrompt`, which reads the registry stack.
 *
 * The one snippet divergence is Nest: its scaffold ships a `.prettierrc` with
 * `singleQuote: true`, so it gets the single-quoted `nestInitSnippet` to avoid
 * cosmetic diff/lint noise. Every other backend-JS recipe keeps the
 * double-quoted `nodeInitSnippet` (Prettier's own default).
 */
function planNode(input: BuildPlanInput, io: InjectIO): Plan {
  const block =
    input.recipe === "nestjs"
      ? nestInitSnippet(input.endpoint)
      : nodeInitSnippet(input.endpoint);

  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Node server entry — wire it manually.",
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block);
}

/**
 * Express. Injects the same autoCapture block as the other backend-JS recipes,
 * AND wires the request + error middleware so backends emit backend.req.* spans
 * (autoCapture alone captures crashes and console.error only — with no request
 * middleware, frontend to backend linkage stays empty forever).
 *
 * When the entry matches the common shape (an `express` import, a
 * `const app = express()` line, an `app.listen(...)` line), the file is
 * rewritten with the middleware registered in the right positions: request
 * middleware right after app creation (before routes), error middleware just
 * above listen (after routes). When any anchor is missing we fall back to the
 * prepend path with a TODO block carrying exact copy and paste lines, and the
 * wizard prints the same instructions.
 */
function planExpress(input: BuildPlanInput, io: InjectIO): Plan {
  const { endpoint } = input;
  const block = nodeInitSnippet(endpoint);
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Node server entry — wire it manually.",
    ]);
  }
  const target = input.entryFile;
  const existing = io.readFile(target);
  if (existing == null) {
    return fallbackPlan(input, block, [
      `Could not read ${target}; use the snippet or AI prompt to wire it manually.`,
    ]);
  }
  if (referencesCrumbtrail(existing)) {
    return skipPlan(input);
  }

  const style = detectExpressModuleStyle(existing);
  const wired = style
    ? wireExpressMiddleware(
        existing,
        (appVar) => expressRequestMiddlewareSnippet(appVar, endpoint),
        (appVar) => expressErrorMiddlewareSnippet(appVar, endpoint),
      )
    : null;

  if (wired == null) {
    // Anchors not found: prepend autoCapture plus a TODO block with exact copy
    // and paste instructions, and surface the same guidance in wizard output.
    const combined = `${block}\n\n${expressManualWiringSnippet(endpoint)}`;
    return prependWithPreflight(input, io, target, combined, [
      "Express request middleware was NOT wired automatically (no `const app = express()` / `app.listen(...)` anchors found). Follow the TODO block added at the top of the entry: register createCrumbtrailExpressMiddleware before your routes and createCrumbtrailExpressErrorMiddleware after them, or backend request spans stay empty.",
    ]);
  }

  // Full rewrite: middleware wired around the routes, plus the autoCapture block
  // and the middleware import prepended after any shebang/directive prologue.
  const content = prependIntoSource(
    wired,
    `${block}\n\n${expressMiddlewareImportSnippet(style!)}`,
  );
  const warnings = [
    "Wired Express request middleware (before routes) and error middleware (after routes) for backend request capture.",
  ];
  const status = io.gitStatus(input.cwd, target);
  if (status.dirty && !input.options?.force) {
    return {
      recipe: input.recipe,
      kind: "needs-confirm-dirty",
      targetPath: target,
      content,
      applyMode: "rewrite",
      warnings: [
        ...warnings,
        `${target} has uncommitted changes — confirm (or re-run with force) before editing.`,
      ],
    };
  }
  return {
    recipe: input.recipe,
    kind: "rewrite",
    targetPath: target,
    content,
    warnings,
  };
}

/**
 * Remix / React Router v7. Prepends the client init into the resolved
 * `app/entry.client.*`. When that entry is absent we FALL BACK rather than
 * create one — a bare init-only entry.client would omit hydrateRoot /
 * <RemixBrowser> and break hydration (a deliberate divergence from planNext).
 */
function planRemix(input: BuildPlanInput, io: InjectIO): Plan {
  const block = clientInitSnippet(input.endpoint, keyExprFor(input.recipe)!);
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve app/entry.client.* — on a React Router 7 default template the client entry is hidden, so run `npx react-router reveal` to unhide app/entry.client.tsx (and entry.server.tsx), then re-run the wizard. Otherwise add the snippet to your Remix client entry manually (do not let the CLI create it; it would omit hydrateRoot).",
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block);
}

/**
 * Astro. There is no single deterministic client entry, so this recipe always
 * hands off the filled snippet + agent prompt as a guided path — the user drops
 * it into a client-side `<script>` in a shared layout (`.astro`). Honest
 * guidance, not an apology.
 */
function planAstro(input: BuildPlanInput, _io: InjectIO): Plan {
  const block = clientInitSnippet(input.endpoint, keyExprFor(input.recipe)!);
  return fallbackPlan(input, block, [
    "Astro has no single client entry — add this snippet inside a client-side <script> in a shared layout (e.g. src/layouts/*.astro) so it runs on every page.",
  ]);
}

/**
 * Angular. Mirrors planVite: prepend the client init above Angular's
 * `bootstrapApplication`/`platformBrowserDynamic` call in the resolved
 * `src/main.ts`; fall back when the entry is unresolved.
 */
function planAngular(input: BuildPlanInput, _io: InjectIO): Plan {
  // A standard Angular browser build exposes neither import.meta.env nor
  // process.env, so there is no hands-off env var to read (hence no keyRef in the
  // registry). Emit guidance to add the key to environment.ts and wire it by hand
  // rather than injecting code that would reference an undefined variable.
  const block = clientInitSnippet(input.endpoint, "environment.crumbtrailKey");
  return fallbackPlan(input, block, [
    "Angular has no browser-safe env-var mechanism — add `crumbtrailKey: '<your-ingest-key>'` to src/environments/environment.ts (get your key from the dashboard), import `environment`, and prepend the snippet above bootstrapApplication in src/main.ts.",
  ]);
}

function planReactNative(input: BuildPlanInput, io: InjectIO): Plan {
  const block = reactNativeInitSnippet(input.endpoint, keyExprFor(input.recipe)!);
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the React Native entry (App/_layout/index) — wire it manually.",
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block);
}

/**
 * Two Rust-side steps the CLI can't perform (JS injection only): without them
 * the wired JS transport invokes a plugin that isn't registered, so capture
 * silently does nothing. Sourced from packages/tauri/README.md steps 1–2 —
 * kept short, pointing at the README for the exact snippets.
 */
const TAURI_RUST_WARNINGS = [
  "Tauri also needs a Rust step the CLI can't do: register the plugin in src-tauri — add `tauri-plugin-crumbtrail` to Cargo.toml and `.plugin(tauri_plugin_crumbtrail::init())` in lib.rs (crumbtrail-tauri README, step 1).",
  "Grant the plugin permission: add `crumbtrail:default` to src-tauri/capabilities/default.json, or every Crumbtrail invoke fails (crumbtrail-tauri README, step 2).",
];

function planTauri(input: BuildPlanInput, io: InjectIO): Plan {
  // The Tauri transport routes to the local Rust store, so the block needs no
  // endpoint/apiKey — but they still thread through fallbackPlan's agent prompt.
  const block = tauriInitSnippet();
  if (!input.entryFile) {
    return fallbackPlan(input, block, [
      "Could not resolve the Tauri frontend entry from index.html — wire it manually.",
      ...TAURI_RUST_WARNINGS,
    ]);
  }
  return prependWithPreflight(input, io, input.entryFile, block, [
    ...TAURI_RUST_WARNINGS,
  ]);
}

/**
 * OTLP guidance path (non-JS backends). This recipe NEVER mutates the
 * filesystem: it returns a guidance-only plan (`targetPath`/`content` null)
 * carrying the OTLP setup snippet + the no-SDK agent prompt, keyed to the
 * DETECTED backend Stack (input.stack), not the registry placeholder. An
 * intentional, honest path — not the fallback-ai apology.
 */
function planOtlp(input: BuildPlanInput): Plan {
  const stack: Stack = input.stack ?? RECIPE_REGISTRY[input.recipe].stack;
  // Hands-off: the guidance carries a placeholder the user replaces with the key
  // they mint in the dashboard, never a live minted key.
  const otlp = buildOtlpSnippets({
    endpoint: input.endpoint,
    apiKey: KEY_PLACEHOLDER,
  });
  const snippet = [
    otlp.env,
    "",
    otlp.authHeader,
    "",
    otlp.sessionAttr,
    "",
    `# ${otlp.note}`,
  ].join("\n");
  return {
    recipe: input.recipe,
    kind: "otlp-guidance",
    targetPath: null,
    content: null,
    snippet,
    agentPrompt: buildAgentPrompt(stack, {
      endpoint: input.endpoint,
      apiKey: KEY_PLACEHOLDER,
    }),
    warnings: [],
  };
}

// --- dispatcher --------------------------------------------------------------

/**
 * Build the injection Plan for a detected recipe. Reads only (via `io`); the
 * returned Plan is plain data the executor applies all-or-nothing.
 */
export function buildPlan(
  input: BuildPlanInput,
  io: InjectIO,
): Plan {
  const plan = dispatchPlan(input, io);
  // Stamp the env var the injected code reads its key from, so the wizard can
  // print "set <VAR> in .env — get your key from the dashboard". Undefined for
  // recipes that inject no key (tauri / otlp / angular) or when already wired.
  const envVar = RECIPE_REGISTRY[input.recipe].keyRef?.envVar;
  if (envVar && plan.kind !== "skip-already-wired") {
    plan.keyEnvVar = envVar;
  }
  return plan;
}

function dispatchPlan(input: BuildPlanInput, io: InjectIO): Plan {
  // Project-level idempotency runs first for every recipe.
  if (projectAlreadyWired(input.cwd, io)) {
    return skipPlan(input);
  }
  switch (input.recipe) {
    case "tauri":
      return planTauri(input, io);
    case "react-native":
      return planReactNative(input, io);
    case "next":
      return planNext(input, io);
    case "sveltekit":
      return planSvelteKit(input, io);
    case "nuxt":
      return planNuxt(input, io);
    case "remix":
      return planRemix(input, io);
    case "astro":
      return planAstro(input, io);
    case "angular":
      return planAngular(input, io);
    case "vite-spa":
      return planVite(input, io);
    case "express":
      // Express additionally wires the request/error middleware pair so the
      // backend emits backend.req.* spans, not just crash capture.
      return planExpress(input, io);
    case "nestjs":
    case "hono":
    case "fastify":
    case "node":
      // All backend-JS recipes share the headless-session injection; the agent
      // prompt differentiates framework middleware via the registry stack.
      return planNode(input, io);
    case "otlp":
      // Guidance-only, non-mutating path for non-JS OTLP backends.
      return planOtlp(input);
    default: {
      const exhaustive: never = input.recipe;
      throw new Error(`Unknown recipe: ${String(exhaustive)}`);
    }
  }
}
