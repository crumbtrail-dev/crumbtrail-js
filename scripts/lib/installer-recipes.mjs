// Declarative manifest for the installer regression harness.
//
// One entry per installer recipe. CP0 populates only `express-cjs`; the shape is
// deliberately complete so CP1–CP5 can fill in each remaining fixture (Next,
// SvelteKit, Nuxt, Vite SPA, NestJS, Hono, Fastify, React Native, Tauri, OTLP…)
// without reshaping the orchestrator.
//
// Field contract:
//   fixtureDir        — path under test-fixtures/installers/<name> (real app)
//   expectedPlanKind  — the injection Plan.kind the wizard must produce
//                       (packages/cli/src/inject/types.ts PlanKind)
//   buildCmd          — argv to build the wired fixture (CP1+ drives the app)
//   runCmd            — argv to start the wired fixture (CP1+ hits it to capture)
//   wireAssertions    — ordered checks proving the wiring reached the stub.
//                       { id, description, status } where status is:
//                         "active"    — enforced this checkpoint
//                         "todo-cp1"  — encoded now, enforced from CP1 (skipped)
//   portSlot          — dedicated 496xx port so parallel recipes never clash
//
// Port block: 49610–49659, one slot per recipe (leave room for CP1–5 fixtures).

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
const fixturesRoot = path.join(repoRoot, "test-fixtures", "installers");

/** @typedef {"active"|"todo-cp1"} WireStatus */

export const INSTALLER_RECIPES = {
  "express-cjs": {
    recipe: "express",
    fixtureDir: path.join(fixturesRoot, "express-cjs"),
    // `rewrite`, not `prepend`: Express needs the request middleware wired in
    // before the routes and the error middleware after them, which a prepend
    // cannot express. See the rewrite cases in packages/cli recipes.test.ts.
    expectedPlanKind: "rewrite",
    // The fixture entry is a plain CJS server; there is nothing to compile.
    buildCmd: null,
    runCmd: ["node", "index.js"],
    portSlot: 49610,
    wireAssertions: [
      {
        id: "authed-session-start",
        description:
          "an authed session/start (X-Crumbtrail-Auth) reaches the ingest stub",
        status: "active",
      },
      {
        id: "boom-error-event",
        // CP1: the harness boots the wired app (autoCapture live) and hits /boom;
        // the console.error'd + thrown route must land a captured error event.
        description:
          "hitting /boom surfaces a captured error event (live app drive)",
        status: "active",
      },
    ],
  },

  // ── CP2: Next.js (browser-loaded frontend recipes) ─────────────────────────
  // These recipes are frontend: the injected client init only proves itself by
  // running in a real browser. The harness's browser runner (verify-installers
  // runRecipeBrowser, gated on `browserLoad`) injects via the REAL buildPlan +
  // executePlan, installs the packed crumbtrail-core, `next build`s, `next
  // start`s on the recipe's 496xx slot, then loads the page in headless chromium
  // and asserts an authed session + event batch reached the ingest stub.
  //
  // `browserLoad: true`   — dispatch to runRecipeBrowser (never the backend path)
  // `clientEntry`         — the browser-executed module the recipe must wire; its
  //                         compiled output must appear in the built client bundle
  // `bundleDir`           — built client-chunk dir scanned for the shipped init
  "next-app": {
    recipe: "next",
    fixtureDir: path.join(fixturesRoot, "next-app"),
    // Modern Next (create-next-app, app router, src dir): auto-loaded
    // instrumentation-client.ts is created fresh.
    expectedPlanKind: "create",
    browserLoad: true,
    clientEntry: path.join("src", "instrumentation-client.ts"),
    bundleDir: path.join(".next", "static"),
    buildCmd: ["npm", "run", "build"],
    // The port is appended by the runner (`next start -p <slot>`).
    runCmd: ["npx", "next", "start"],
    portSlot: 49611,
    wireAssertions: [
      {
        id: "client-bundle-shipped",
        description:
          "the injected Crumbtrail.init + ingest endpoint ship in the built client bundle",
        status: "active",
      },
      {
        id: "authed-session-start",
        description:
          "loading the built page in a browser pushes an authed session/start + event batch to the ingest stub",
        status: "active",
      },
    ],
  },

  "next-legacy-pages": {
    recipe: "next",
    fixtureDir: path.join(fixturesRoot, "next-legacy-pages"),
    // Legacy Next (<15.3, Pages Router): client init is prepended into
    // pages/_app so it actually executes in the browser.
    expectedPlanKind: "prepend",
    browserLoad: true,
    clientEntry: path.join("pages", "_app.tsx"),
    bundleDir: path.join(".next", "static"),
    buildCmd: ["npm", "run", "build"],
    runCmd: ["npx", "next", "start"],
    portSlot: 49612,
    wireAssertions: [
      {
        id: "client-bundle-shipped",
        description:
          "the injected Crumbtrail.init + ingest endpoint ship in the built client bundle",
        status: "active",
      },
      {
        id: "authed-session-start",
        description:
          "loading the built page in a browser pushes an authed session/start + event batch to the ingest stub",
        status: "active",
      },
    ],
  },

  // ── CP1: backend-JS fixtures ───────────────────────────────────────────────
  // Real minimal backend apps wired by the wizard, then booted for real by the
  // backend app-drive (verify-installers driveBoomCapture): the packed SDK is
  // installed, the app is started with plain `node`/`npm start` (NO --env-file,
  // so the .env key must be loaded by autoCapture itself), and `/boom` is hit.
  // Each `/boom` route console.errors + throws so autoCapture records a real
  // server-side error event.
  "express-esm": {
    recipe: "express",
    fixtureDir: path.join(fixturesRoot, "express-esm"),
    // See the express-cjs note: Express is a rewrite, not a prepend.
    expectedPlanKind: "rewrite",
    buildCmd: null,
    runCmd: ["node", "index.js"],
    portSlot: 49613,
    wireAssertions: [
      {
        id: "authed-session-start",
        description:
          "an authed session/start (X-Crumbtrail-Auth) reaches the ingest stub",
        status: "active",
      },
      {
        id: "boom-error-event",
        description:
          "hitting /boom surfaces a captured error event (live app drive)",
        status: "active",
      },
    ],
  },
  fastify: {
    recipe: "fastify",
    fixtureDir: path.join(fixturesRoot, "fastify"),
    expectedPlanKind: "prepend",
    buildCmd: null,
    runCmd: ["node", "index.js"],
    portSlot: 49614,
    wireAssertions: [
      {
        id: "authed-session-start",
        description:
          "an authed session/start (X-Crumbtrail-Auth) reaches the ingest stub",
        status: "active",
      },
      {
        id: "boom-error-event",
        description:
          "hitting /boom surfaces a captured error event (live app drive)",
        status: "active",
      },
    ],
  },
  hono: {
    recipe: "hono",
    fixtureDir: path.join(fixturesRoot, "hono"),
    expectedPlanKind: "prepend",
    buildCmd: null,
    runCmd: ["node", "index.js"],
    portSlot: 49615,
    wireAssertions: [
      {
        id: "authed-session-start",
        description:
          "an authed session/start (X-Crumbtrail-Auth) reaches the ingest stub",
        status: "active",
      },
      {
        id: "boom-error-event",
        description:
          "hitting /boom surfaces a captured error event (live app drive)",
        status: "active",
      },
    ],
  },
  "node-plain": {
    recipe: "node",
    fixtureDir: path.join(fixturesRoot, "node-plain"),
    expectedPlanKind: "prepend",
    buildCmd: null,
    runCmd: ["node", "index.js"],
    portSlot: 49616,
    // Crash-mode fixture: /boom raises a REAL uncaughtException (no framework to
    // catch it), so this row exercises autoCapture's bounded crash flush end to
    // end — the crash event must reach ingest BEFORE the process exits(1). The
    // harness hits /boom once and tolerates the app's nonzero exit afterward.
    crashMode: true,
    wireAssertions: [
      {
        id: "authed-session-start",
        description:
          "an authed session/start (X-Crumbtrail-Auth) reaches the ingest stub",
        status: "active",
      },
      {
        id: "boom-error-event",
        description:
          "hitting /boom raises a real uncaughtException whose crash event the bounded flush lands in ingest before exit(1)",
        status: "active",
      },
    ],
  },
  nest: {
    recipe: "nestjs",
    fixtureDir: path.join(fixturesRoot, "nest"),
    expectedPlanKind: "prepend",
    // Nest injects into src/main.ts, so the wired entry must be compiled first.
    buildCmd: ["npm", "run", "build"],
    runCmd: ["node", "dist/main.js"],
    portSlot: 49617,
    wireAssertions: [
      {
        id: "authed-session-start",
        description:
          "an authed session/start (X-Crumbtrail-Auth) reaches the ingest stub",
        status: "active",
      },
      {
        id: "boom-error-event",
        description:
          "hitting /boom surfaces a captured error event (live app drive)",
        status: "active",
      },
    ],
  },
};

// ── CP4: OTLP guidance recipe (non-JS backend) ───────────────────────────────
// Append-only block (kept outside the literal so it never collides with the
// other checkpoints filling in the object above). Unlike the JS recipes, an
// `otlp` target is GUIDANCE-ONLY: the wizard writes NOTHING (no SDK install, no
// entry-file wiring, no .env). So this row is marked `guidanceOnly` and carries
// `snippetMustContain` assertions instead of wireAssertions — the orchestrator
// routes it to a guidance runner that exercises the REAL detect() + buildPlan()
// and inspects the emitted OTLP snippet (verify-installers runRecipeGuidance).
INSTALLER_RECIPES["otlp-fastapi"] = {
  recipe: "otlp",
  fixtureDir: path.join(fixturesRoot, "otlp-fastapi"),
  guidanceOnly: true,
  expectedOtlpStack: "fastapi",
  expectedPlanKind: "otlp-guidance",
  buildCmd: null,
  runCmd: null,
  portSlot: 49618,
  // The emitted guidance snippet must carry the FIXED facts: the %20-escaped
  // Bearer header, the compression posture, and both wire protocols — all
  // sourced from OTLP_CAPABILITY_FACTS in crumbtrail-install-shared.
  snippetMustContain: [
    "Authorization=Bearer%20",
    "OTEL_EXPORTER_OTLP_COMPRESSION=none",
    "http/protobuf",
    "http/json",
    "crumbtrail.session.id",
  ],
  wireAssertions: [
    {
      id: "otlp-guidance-snippet",
      description:
        "detect() resolves otlp+fastapi and buildPlan() emits a non-mutating otlp-guidance plan whose snippet carries the fixed OTLP facts",
      status: "active",
    },
  ],
};

// ── CP3: Nuxt 4 / Vite / React Router 7 DX fixtures ──────────────────────────
// Append-only rows (kept outside the literal so they never collide with earlier
// checkpoints). Three browser-loaded frontend recipes + one plan-only recipe.

// nuxt4 — real `npx nuxi init --template minimal` (Nuxt 4, app/ srcDir). Nuxt 4
// scans app/plugins/, NOT the repo-root plugins/. The RED bug: planNuxt used to
// hardcode root plugins/, so the injected client plugin was never loaded and
// zero authed events reached ingest. GREEN: plan creates app/plugins/
// crumbtrail.client.ts, `nuxt build` ships the init into the client bundle, and a
// headless page load pushes an authed session + event batch. Nitro's node server
// reads the PORT env (portFlag: null → no port arg appended).
INSTALLER_RECIPES["nuxt4"] = {
  recipe: "nuxt",
  fixtureDir: path.join(fixturesRoot, "nuxt4"),
  expectedPlanKind: "create",
  browserLoad: true,
  clientEntry: path.join("app", "plugins", "crumbtrail.client.ts"),
  bundleDir: path.join(".output", "public"),
  buildCmd: ["npm", "run", "build"],
  runCmd: ["node", ".output/server/index.mjs"],
  portFlag: null,
  portSlot: 49619,
  wireAssertions: [
    {
      id: "client-bundle-shipped",
      description:
        "the injected Crumbtrail.init + ingest endpoint ship in the built Nuxt client bundle (only true when the plugin lands in app/plugins/)",
      status: "active",
    },
    {
      id: "authed-session-start",
      description:
        "loading the built page in a browser pushes an authed session/start + event batch to the ingest stub",
      status: "active",
    },
  ],
};

// vite-react — real `npm create vite@latest -- --template react`. A textbook
// Vite SPA with a root index.html: detect resolves vite-spa and the client init
// is prepended into src/main.jsx. Vite preview takes `--port <port>`.
INSTALLER_RECIPES["vite-react"] = {
  recipe: "vite-spa",
  fixtureDir: path.join(fixturesRoot, "vite-react"),
  expectedPlanKind: "prepend",
  browserLoad: true,
  clientEntry: path.join("src", "main.jsx"),
  bundleDir: "dist",
  buildCmd: ["npm", "run", "build"],
  runCmd: ["npx", "vite", "preview", "--strictPort", "--host", "127.0.0.1"],
  portFlag: "--port",
  portSlot: 49620,
  wireAssertions: [
    {
      id: "client-bundle-shipped",
      description:
        "the injected Crumbtrail.init + ingest endpoint ship in the built Vite client bundle",
      status: "active",
    },
    {
      id: "authed-session-start",
      description:
        "loading the built page in a browser pushes an authed session/start + event batch to the ingest stub",
      status: "active",
    },
  ],
};

// rr7-default — real `npx create-react-router@latest` DEFAULT template, whose
// app/entry.client.tsx is hidden until `npx react-router reveal`. NON-RUNNABLE
// (planOnly): detect resolves remix (react-router + @react-router/dev) with a
// null entry, and buildPlan hands off to fallback-ai. RED: the warning didn't
// name the escape hatch. GREEN: the warning names `npx react-router reveal`.
INSTALLER_RECIPES["rr7-default"] = {
  recipe: "remix",
  fixtureDir: path.join(fixturesRoot, "rr7-default"),
  planOnly: true,
  expectedPlanKind: "fallback-ai",
  buildCmd: null,
  runCmd: null,
  portSlot: null,
  warningMustContain: ["npx react-router reveal"],
  assertNoFile: [path.join("app", "entry.client.tsx")],
  wireAssertions: [
    {
      id: "rr7-reveal-guidance",
      description:
        "buildPlan yields a non-mutating fallback-ai plan whose warning names `npx react-router reveal` as the concrete unhide step",
      status: "active",
    },
  ],
};

// rr7-revealed — the same template AFTER `npx react-router reveal`, so
// app/entry.client.tsx exists and the client init is prepended into it. Full
// browser wire check: `react-router build` then `@react-router/serve` (reads the
// PORT env → portFlag: null).
INSTALLER_RECIPES["rr7-revealed"] = {
  recipe: "remix",
  fixtureDir: path.join(fixturesRoot, "rr7-revealed"),
  expectedPlanKind: "prepend",
  browserLoad: true,
  clientEntry: path.join("app", "entry.client.tsx"),
  bundleDir: path.join("build", "client"),
  buildCmd: ["npm", "run", "build"],
  runCmd: ["npx", "react-router-serve", "./build/server/index.js"],
  portFlag: null,
  portSlot: 49621,
  wireAssertions: [
    {
      id: "client-bundle-shipped",
      description:
        "the injected Crumbtrail.init + ingest endpoint ship in the built React Router client bundle",
      status: "active",
    },
    {
      id: "authed-session-start",
      description:
        "loading the built page in a browser pushes an authed session/start + event batch to the ingest stub",
      status: "active",
    },
  ],
};

// ── CP5: React Native (Expo) + Tauri — typecheck-cap fixtures ─────────────────
// Append-only rows. Neither ships a runtime harness (no simulator, no cargo
// build); the cap is: real npm install + the wizard's REAL buildPlan/executePlan
// prepend into the resolved entry + install the packed SDK tarball(s) so the
// injected import resolves + `tsc --noEmit` passes. The orchestrator routes
// `typecheckCap` rows to runRecipeTypecheck.
//
//   typecheckCap   — dispatch to the typecheck runner (no build/serve/ingest)
//   clientEntry    — the entry the plan must prepend into (relative to app)
//   typecheckPacks — packed pack-manifest keys installed before typecheck
//                    (react-native/tauri need crumbtrail-core + their SDK)
//   typecheckCmd   — argv run in the app dir; exit 0 = pass
//   warningMustContain — substrings the plan warnings must carry (Tauri Rust steps)

// expo — real `npx create-expo-app@latest --template blank-typescript`. Detect
// resolves react-native (expo dep) with entry App.tsx; the plan prepends the
// imperative createReactNativeCrumbtrail init. RED on current main: react-native
// had no tarball channel, so the SDK could not be installed from the deploy at
// all (installSdk returned an honest "not yet distributable" note) — GREEN once
// pack-local packs crumbtrail-react-native and install-routes serves it.
INSTALLER_RECIPES["expo"] = {
  recipe: "react-native",
  fixtureDir: path.join(fixturesRoot, "expo"),
  typecheckCap: true,
  expectedPlanKind: "prepend",
  clientEntry: "App.tsx",
  typecheckPacks: ["core", "reactNative"],
  typecheckCmd: ["npx", "tsc", "--noEmit"],
  buildCmd: null,
  runCmd: null,
  portSlot: null,
  wireAssertions: [
    {
      id: "rn-typecheck",
      description:
        "the wizard prepends the RN init into App.tsx, the packed crumbtrail-react-native tarball installs, and `tsc --noEmit` typechecks clean",
      status: "active",
    },
  ],
};

// tauri — real `npm create tauri-app@latest --template vanilla-ts`. Detect wins
// over vite (src-tauri/ + @tauri-apps dep) and resolves the frontend entry from
// index.html; the plan prepends the TauriTransport init. Cap adds two Rust-side
// warnings the JS injection can't perform (plugin registration + capability
// permission). RED on current main: no tauri tarball channel AND planTauri
// emitted no Rust warnings — GREEN after both.
INSTALLER_RECIPES["tauri"] = {
  recipe: "tauri",
  fixtureDir: path.join(fixturesRoot, "tauri"),
  typecheckCap: true,
  expectedPlanKind: "prepend",
  clientEntry: path.join("src", "main.ts"),
  typecheckPacks: ["core", "tauri"],
  typecheckCmd: ["npx", "tsc", "--noEmit"],
  warningMustContain: ["tauri-plugin-crumbtrail", "crumbtrail:default"],
  buildCmd: null,
  runCmd: null,
  portSlot: null,
  wireAssertions: [
    {
      id: "tauri-typecheck",
      description:
        "the wizard prepends the TauriTransport init into the frontend entry, the packed crumbtrail-tauri tarball installs, and the frontend `tsc --noEmit` typechecks clean",
      status: "active",
    },
    {
      id: "tauri-rust-warnings",
      description:
        "the plan warns about the two Rust-side steps the CLI can't do (plugin registration + capability permission)",
      status: "active",
    },
  ],
};

// ── Fixture provenance ───────────────────────────────────────────────────────
// The exact generator each committed fixture was scaffolded from, kept in ONE
// place and attached as `.provenance` to each row below. Consumed by
// scripts/refresh-installer-fixtures.mjs to re-scaffold + diff for upstream
// drift. Shape:
//   generator: shell command run in a temp root (null → hand-authored, skipped)
//   outDir:    dir the generator writes the app into, relative to the temp root
//   postGen:   extra commands run inside the app dir after generation
//   prune:     paths removed post-generation (template cruft / heavy artifacts)
//   note:      free-text caveat (manual trims the refresh diff will surface)
const FIXTURE_PROVENANCE = {
  // Hand-authored minimal backends — no generator to re-run.
  "express-cjs": { generator: null },
  "express-esm": { generator: null },
  fastify: { generator: null },
  hono: { generator: null },
  "node-plain": { generator: null },
  // Hand-authored non-JS OTLP backend fixture.
  "otlp-fastapi": { generator: null },
  // Real scaffolders.
  nest: {
    generator:
      "npx --yes @nestjs/cli@latest new app --skip-install --package-manager npm",
    outDir: "app",
    prune: [".git", "node_modules"],
  },
  "next-app": {
    generator:
      "npx --yes create-next-app@16 app --ts --app --src-dir --use-npm --skip-install --no-eslint --no-tailwind --no-turbopack --import-alias @/*",
    outDir: "app",
    prune: [".git", "node_modules", ".next"],
  },
  "next-legacy-pages": {
    generator:
      "npx --yes create-next-app@14 app --ts --no-src-dir --use-npm --skip-install --no-eslint --import-alias @/*",
    outDir: "app",
    prune: [".git", "node_modules", ".next"],
    note: "pages-router template; pinned <15.3 so the legacy prepend path applies.",
  },
  nuxt4: {
    generator: "npx --yes nuxi@latest init app --template minimal",
    outDir: "app",
    postGen: ["npm install --package-lock-only --no-audit --no-fund"],
    prune: [".git", "node_modules", ".nuxt", ".output"],
  },
  "vite-react": {
    generator: "npm create vite@latest app -- --template react",
    outDir: "app",
    postGen: ["npm install --package-lock-only --no-audit --no-fund"],
    prune: [".git", "node_modules", "dist"],
  },
  "rr7-default": {
    generator:
      "npx --yes create-react-router@latest app --no-git-init --no-install --yes",
    outDir: "app",
    prune: [".git", "node_modules", "build"],
    note: "DEFAULT template — entry.client.tsx stays hidden (fallback-ai path).",
  },
  "rr7-revealed": {
    generator:
      "npx --yes create-react-router@latest app --no-git-init --no-install --yes",
    outDir: "app",
    postGen: ["npx --yes react-router reveal"],
    prune: [".git", "node_modules", "build"],
    note: "reveal exposes app/entry.client.tsx so the prepend path applies.",
  },
  expo: {
    generator:
      "npx --yes create-expo-app@latest app --no-install --template blank-typescript",
    outDir: "app",
    postGen: ["npm install --package-lock-only --no-audit --no-fund"],
    prune: [
      ".git",
      ".claude",
      "AGENTS.md",
      "CLAUDE.md",
      "LICENSE",
      "README.md",
      "scripts",
      "node_modules",
      "assets/icon.png",
      "assets/android-icon-foreground.png",
    ],
    note: "heavy assets (icon.png, android-icon-foreground.png) trimmed by size.",
  },
  tauri: {
    generator:
      "npx --yes create-tauri-app@latest app --manager npm --template vanilla-ts --yes",
    outDir: "app",
    postGen: ["npm install --package-lock-only --no-audit --no-fund"],
    prune: [".git", ".vscode", "README.md", "node_modules", "src-tauri/target"],
    note: "src-tauri/icons trimmed to the two smallest PNGs (32x32, 128x128); no cargo build.",
  },
};
for (const [name, prov] of Object.entries(FIXTURE_PROVENANCE)) {
  if (INSTALLER_RECIPES[name]) INSTALLER_RECIPES[name].provenance = prov;
}

/** Recipes selectable via --recipe / iterated by the orchestrator. */
export function recipeNames() {
  return Object.keys(INSTALLER_RECIPES);
}

export function getRecipe(name) {
  const entry = INSTALLER_RECIPES[name];
  if (!entry) {
    throw new Error(
      `unknown installer recipe '${name}' (known: ${recipeNames().join(", ")})`,
    );
  }
  return entry;
}
