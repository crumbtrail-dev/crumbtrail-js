// Single source of truth for per-recipe static metadata.
//
// Adding a recipe should mean: one entry here + one matcher in detect.ts + one
// plan-builder in inject/recipes.ts. This module holds only static data — it
// must NOT import detect (or any fs/network module) at runtime, so it stays a
// leaf that both detect.ts and the network/inject layers can depend on without
// forming an import cycle. `Recipe` is pulled in type-only for exactly that
// reason.

import type { Stack } from "crumbtrail-core";
import type { Recipe } from "./detect";

/**
 * Discriminator for how a recipe is applied. Every JS recipe injects a snippet;
 * `otlp` is the guidance-only path (CP5) — it mutates nothing and emits OTLP
 * setup instructions + an agent prompt instead of editing files.
 */
export type RecipeKind = "inject" | "otlp";

/**
 * How the injected snippet reads the ingest key. The installer no longer writes
 * the key anywhere (hands-off): the emitted code references an environment
 * variable by name, and the wizard tells the user to set it from the dashboard.
 * Client stacks need a framework-specific PUBLIC prefix so the bundler exposes
 * the var to browser code; backend stacks read a plain `process.env` var.
 */
export interface KeyRef {
  /** The env var the user must set (with the framework's public prefix). */
  envVar: string;
  /** The exact code expression the snippet uses to read it. */
  expr: string;
}

export interface RecipeMeta {
  /**
   * design-system Stack id passed to buildAgentPrompt() (attribution) and the
   * services route. SvelteKit/Nuxt have no dedicated Stack id, so they map onto
   * their underlying view layer: sveltekit → "svelte", nuxt → "vue".
   */
  stack: Stack;
  /** SDK packages the installer adds for this recipe. */
  sdkPackages: string[];
  /** Default service label when no workspace name overrides it. */
  serviceName: string;
  /** How the recipe is applied. */
  kind: RecipeKind;
  /**
   * How the injected snippet reads the key. Undefined when the recipe injects no
   * key at all: `tauri` (routes to the local Rust store), `otlp` (uses OTLP env
   * headers), and `angular` (guidance-only — no browser-safe env mechanism, so
   * it points the user at `environment.ts` instead).
   */
  keyRef?: KeyRef;
}

// Framework public-env references. Vite-based client stacks (SvelteKit, Nuxt,
// Remix/RR7, Astro, vite-spa) read `import.meta.env`; Next uses `process.env`
// with its NEXT_PUBLIC_ prefix; Expo/React Native uses EXPO_PUBLIC_. Backend-JS
// reads a plain server var.
const VITE_KEY: KeyRef = {
  envVar: "VITE_CRUMBTRAIL_KEY",
  expr: "import.meta.env.VITE_CRUMBTRAIL_KEY",
};
const NEXT_KEY: KeyRef = {
  envVar: "NEXT_PUBLIC_CRUMBTRAIL_KEY",
  expr: "process.env.NEXT_PUBLIC_CRUMBTRAIL_KEY",
};
const ASTRO_KEY: KeyRef = {
  envVar: "PUBLIC_CRUMBTRAIL_KEY",
  expr: "import.meta.env.PUBLIC_CRUMBTRAIL_KEY",
};
const EXPO_KEY: KeyRef = {
  envVar: "EXPO_PUBLIC_CRUMBTRAIL_KEY",
  expr: "process.env.EXPO_PUBLIC_CRUMBTRAIL_KEY",
};
const NODE_KEY: KeyRef = {
  envVar: "CRUMBTRAIL_KEY",
  expr: "process.env.CRUMBTRAIL_KEY",
};

/**
 * Version floors for the SDK packages the installer adds. A bare `npm install
 * crumbtrail-node` resolves whatever the registry says is latest at run time —
 * which once left freshly wired services on stale 0.2.x installs when a
 * dist-tag/publish hiccup lagged. Pinning `^<floor>` guarantees the wizard never
 * wires a service to an SDK older than the one this CLI was built against.
 * Bump these alongside SDK releases (they mirror the workspace package versions
 * at publish time).
 */
export const SDK_VERSION_FLOORS: Record<string, string> = {
  "crumbtrail-core": "0.5.0",
  "crumbtrail-node": "0.7.0",
  "crumbtrail-react-native": "0.2.3",
  "crumbtrail-tauri": "0.2.3",
};

/** The install spec for a package: `pkg@^<floor>`, or the bare name when unknown. */
export function sdkInstallSpec(pkg: string): string {
  const floor = SDK_VERSION_FLOORS[pkg];
  return floor ? `${pkg}@^${floor}` : pkg;
}

/**
 * Exhaustive registry keyed by `Recipe`. Typed `Record<Recipe, RecipeMeta>` so a
 * future recipe missing an entry fails typecheck — preserve that safety net.
 */
export const RECIPE_REGISTRY: Record<Recipe, RecipeMeta> = {
  tauri: {
    stack: "vite", // no "tauri" Stack id — Tauri frontends are typically vite
    sdkPackages: ["crumbtrail-core", "crumbtrail-tauri"],
    serviceName: "app",
    kind: "inject",
  },
  next: {
    stack: "nextjs",
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
    keyRef: NEXT_KEY,
  },
  sveltekit: {
    stack: "svelte", // no "sveltekit" Stack id — svelte is the closest js stack
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
    keyRef: VITE_KEY,
  },
  nuxt: {
    stack: "vue", // no "nuxt" Stack id — vue is the closest js stack
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
    keyRef: VITE_KEY, // Nuxt is Vite-based; a client plugin reads import.meta.env
  },
  remix: {
    stack: "react", // no "remix" Stack id — react is the closest js stack
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
    keyRef: VITE_KEY, // React Router 7 / Remix (Vite) exposes import.meta.env
  },
  astro: {
    stack: "vite", // no "astro" Stack id — vite is the closest generic frontend stack
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
    keyRef: ASTRO_KEY, // Astro exposes PUBLIC_-prefixed vars on import.meta.env
  },
  angular: {
    stack: "vite", // no "angular" Stack id — vite is the closest generic frontend stack
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
    // No keyRef: a standard Angular browser build has no import.meta.env /
    // process.env, so planAngular hands off with guidance to use environment.ts.
  },
  "vite-spa": {
    stack: "vite",
    sdkPackages: ["crumbtrail-core"],
    serviceName: "web",
    kind: "inject",
    keyRef: VITE_KEY,
  },
  nestjs: {
    stack: "node", // no "nestjs" Stack id — node is the backend-JS stack
    sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
    serviceName: "api",
    kind: "inject",
    keyRef: NODE_KEY,
  },
  express: {
    stack: "express",
    sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
    serviceName: "api",
    kind: "inject",
    keyRef: NODE_KEY,
  },
  hono: {
    stack: "hono",
    sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
    serviceName: "api",
    kind: "inject",
    keyRef: NODE_KEY,
  },
  fastify: {
    stack: "node", // no dedicated "fastify" Stack id — node is the backend-JS stack
    sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
    serviceName: "api",
    kind: "inject",
    keyRef: NODE_KEY,
  },
  "react-native": {
    stack: "react", // no "react-native" Stack id — react is the closest js stack
    sdkPackages: ["crumbtrail-core", "crumbtrail-react-native"],
    serviceName: "app",
    kind: "inject",
    keyRef: EXPO_KEY,
  },
  node: {
    stack: "node",
    sdkPackages: ["crumbtrail-core", "crumbtrail-node"],
    serviceName: "api",
    kind: "inject",
    keyRef: NODE_KEY,
  },
  otlp: {
    // PLACEHOLDER ONLY. `otlp` is the single recipe that carries a VARIABLE
    // detected Stack (django/flask/fastapi/go/rails/dotnet). This static value is
    // NOT authoritative — every call site (provision.ts createService,
    // recipes.ts buildAgentPrompt) must prefer `DetectResult.otlpStack` and only
    // fall back to this when a detected stack is somehow absent.
    stack: "django",
    // Empty: this backend already speaks OpenTelemetry, so there is no SDK to
    // install. installSdk() must guard the empty list and skip spawning entirely.
    sdkPackages: [],
    serviceName: "backend",
    kind: "otlp",
  },
};
