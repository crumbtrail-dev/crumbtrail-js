// Offline project detection for the Crumbtrail setup wizard.
//
// Everything here is filesystem inspection only — no user code is ever executed
// and no network is touched. `detect(cwd)` classifies a single package directory
// into one injection recipe, resolves the injection entry file where that is
// unambiguous, and reports package-manager + monorepo shape so the caller can
// decide whether to prompt for a workspace.

import path from "node:path";
import type { Stack } from "crumbtrail-core";
import { localFsReader } from "./readers/local-fs";
import type { FileReader } from "./readers/types";

export { localFsReader } from "./readers/local-fs";
export type { FileReader } from "./readers/types";

/** Injection recipes, ordered most-specific-first during detection. */
export type Recipe =
  | "tauri"
  | "next"
  | "sveltekit"
  | "nuxt"
  | "remix"
  | "astro"
  | "angular"
  | "vite-spa"
  | "nestjs"
  | "express"
  | "hono"
  | "fastify"
  | "react-native"
  | "node"
  // Single guidance-only recipe for non-JS backends that already speak OTLP
  // (Django/Flask/FastAPI/Go/Rails/.NET). Unlike every other recipe it carries a
  // VARIABLE detected `Stack` out of detection via `DetectResult.otlpStack`.
  | "otlp";

export type PackageManager = "pnpm" | "yarn" | "bun" | "npm";

export interface WorkspacePackage {
  /** package.json `name`, falling back to the directory basename. */
  name: string;
  /** Absolute path to the workspace package directory. */
  dir: string;
}

export interface DetectResult {
  cwd: string;
  packageJsonPath: string | null;
  /** Winning recipe, or null when nothing matched. */
  recipe: Recipe | null;
  packageManager: PackageManager | null;
  /**
   * Absolute path to the file the recipe would edit (vite-spa / node), when it
   * could be resolved with confidence. null for create-a-new-file recipes and
   * whenever resolution was ambiguous.
   */
  entryFile: string | null;
  /** Raw `next` version range from package.json, when the recipe is `next`. */
  nextVersion: string | null;
  /**
   * The non-JS backend Stack resolved from filesystem markers when `recipe` is
   * `"otlp"` (django/flask/fastapi/go/rails/dotnet). null for every other recipe.
   * This is the ONE recipe that carries a variable Stack; call sites must prefer
   * it over the static `RECIPE_REGISTRY["otlp"].stack` placeholder.
   */
  otlpStack: Stack | null;
  isMonorepo: boolean;
  /** Workspace packages when `isMonorepo` — the caller picks which app to wire. */
  workspaces: WorkspacePackage[];
  /**
   * True when the caller must resolve a choice before injecting: monorepo root,
   * no recipe matched, or the recipe's entry file could not be resolved.
   */
  ambiguous: boolean;
  /** Human-readable trail of why detection landed where it did. */
  reasons: string[];
  /**
   * Non-blocking, informational messages about the project that do NOT affect
   * `recipe`/`ambiguous`/`isMonorepo`/`entryFile` — e.g. a "Docker files found,
   * infra evidence sources coming soon" note. Kept separate from `reasons` (the
   * detection trail); the caller surfaces these on both success and no-recipe
   * paths without changing any outcome.
   */
  notes: string[];
}

interface PackageJson {
  name?: string;
  main?: string;
  bin?: string | Record<string, string>;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: string[] | { packages?: string[] };
}

function safeRead(file: string, reader: FileReader): string | null {
  return reader.readFile(file);
}

function readPackageJson(dir: string, reader: FileReader): PackageJson | null {
  const text = safeRead(path.join(dir, "package.json"), reader);
  if (text == null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as PackageJson)
      : null;
  } catch {
    return null;
  }
}

/** Walk up from `startDir` to the filesystem root looking for a known lockfile. */
export function detectPackageManager(
  startDir: string,
  reader: FileReader = localFsReader(startDir),
): PackageManager | null {
  let dir = path.resolve(startDir);

  while (true) {
    if (reader.isFile(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
    if (
      reader.isFile(path.join(dir, "bun.lockb")) ||
      reader.isFile(path.join(dir, "bun.lock"))
    )
      return "bun";
    if (reader.isFile(path.join(dir, "yarn.lock"))) return "yarn";
    if (reader.isFile(path.join(dir, "package-lock.json"))) return "npm";
    const parent = path.dirname(dir);
    if (dir === reader.root || parent === dir) return null;
    dir = parent;
  }
}

/** Extract the `packages:` list from a pnpm-workspace.yaml without a YAML dep. */
export function parsePnpmWorkspace(text: string): string[] {
  const out: string[] = [];
  let inPackages = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "");
    if (/^packages\s*:/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) continue;
    const item = line.match(/^\s*-\s*["']?([^"'#]+?)["']?\s*$/);
    if (item) {
      out.push(item[1].trim());
      continue;
    }
    // A new, non-indented top-level key ends the packages block.
    if (/^\S/.test(line)) inPackages = false;
  }
  return out;
}

function expandWorkspaceGlobs(
  cwd: string,
  patterns: string[],
  reader: FileReader,
): string[] {
  const dirs = new Set<string>();
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) continue; // ignore exclusions
    const wildcard = pattern.endsWith("/*") || pattern.endsWith("/**");
    if (wildcard) {
      const base = path.join(cwd, pattern.replace(/\/\*\*?$/, ""));
      if (!reader.isDir(base)) continue;
      for (const entry of reader.readDir(base)) {
        const full = path.join(base, entry);
        if (
          reader.isDir(full) &&
          reader.isFile(path.join(full, "package.json"))
        ) {
          dirs.add(full);
        }
      }
    } else if (!pattern.includes("*")) {
      const full = path.join(cwd, pattern);
      if (reader.isFile(path.join(full, "package.json"))) dirs.add(full);
    }
  }
  return [...dirs].sort();
}

function detectWorkspaces(
  cwd: string,
  pkg: PackageJson | null,
  reader: FileReader,
): WorkspacePackage[] | null {
  let patterns: string[] | null = null;
  const wsYaml = path.join(cwd, "pnpm-workspace.yaml");
  const wsYamlText = safeRead(wsYaml, reader);
  if (wsYamlText != null) {
    patterns = parsePnpmWorkspace(wsYamlText);
  } else if (pkg?.workspaces) {
    patterns = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : (pkg.workspaces.packages ?? []);
  }
  // Nx is a strict FALLBACK source: it runs only when neither pnpm-workspace.yaml
  // nor a package.json `workspaces` field resolved. Order preserved so an Nx repo
  // that also happens to carry pnpm/pkg workspaces never double-sources.
  if (!patterns) return detectNxWorkspaces(cwd, reader);
  return expandWorkspaceGlobs(cwd, patterns, reader).map((dir) => {
    const p = readPackageJson(dir, reader);
    return { name: p?.name ?? path.basename(dir), dir };
  });
}

interface NxJson {
  workspaceLayout?: { appsDir?: string; libsDir?: string };
}

/** Parse a JSON object file (nx.json / project.json), null on missing/malformed. */
function readJsonObject(
  file: string,
  reader: FileReader,
): Record<string, unknown> | null {
  const text = safeRead(file, reader);
  if (text == null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Derive an Nx project's name: project.json → package.json → dir basename. */
function nxProjectName(dir: string, reader: FileReader): string {
  const proj = readJsonObject(path.join(dir, "project.json"), reader);
  if (proj && typeof proj.name === "string" && proj.name) return proj.name;
  const p = readPackageJson(dir, reader);
  if (p?.name) return p.name;
  return path.basename(dir);
}

/**
 * Filesystem-only Nx workspace discovery — NEVER executes `nx`/`npx`. Reads
 * `nx.json` as JSON (falling back to default layout when absent/malformed), then
 * scans the app/lib dirs (`workspaceLayout.appsDir`/`libsDir`, defaulting to
 * `apps`/`libs`) for subdirectories that carry a `project.json` or `package.json`.
 * A root-level standalone `project.json` is treated as a single project. Returns
 * null when no projects are found so `detect()` treats the repo as non-monorepo.
 */
function detectNxWorkspaces(
  cwd: string,
  reader: FileReader,
): WorkspacePackage[] | null {
  if (!reader.isFile(path.join(cwd, "nx.json"))) return null;
  const nx = readJsonObject(path.join(cwd, "nx.json"), reader) as NxJson | null;
  const layout = nx?.workspaceLayout ?? {};
  const appsDir = typeof layout.appsDir === "string" ? layout.appsDir : "apps";
  const libsDir = typeof layout.libsDir === "string" ? layout.libsDir : "libs";

  const found = new Map<string, WorkspacePackage>();

  // Standalone single-project repo: a root project.json with no apps/libs.
  if (reader.isFile(path.join(cwd, "project.json"))) {
    found.set(cwd, { name: nxProjectName(cwd, reader), dir: cwd });
  }

  for (const base of new Set([appsDir, libsDir])) {
    const baseDir = path.join(cwd, base);
    if (!reader.isDir(baseDir)) continue;
    for (const entry of reader.readDir(baseDir)) {
      const full = path.join(baseDir, entry);
      if (!reader.isDir(full)) continue;
      if (
        reader.isFile(path.join(full, "project.json")) ||
        reader.isFile(path.join(full, "package.json"))
      ) {
        found.set(full, { name: nxProjectName(full, reader), dir: full });
      }
    }
  }

  if (found.size === 0) return null;
  return [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

/** Resolve the Vite entry from index.html's `<script type="module" src>` tag. */
export function resolveViteEntry(
  cwd: string,
  reader: FileReader = localFsReader(cwd),
): string | null {
  const html = safeRead(path.join(cwd, "index.html"), reader);
  if (html == null) return null;
  // Match every <script ...> open tag, then require type=module + a local src.
  const tagRe = /<script\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html)) !== null) {
    const tag = m[0];
    if (!/\btype=["']module["']/i.test(tag)) continue;
    const src = tag.match(/\bsrc=["']([^"']+)["']/i);
    if (!src) continue;
    let rel = src[1];
    if (/^https?:/i.test(rel)) continue; // external entry, can't edit
    rel = rel.replace(/^\.?\//, "");
    const full = path.join(cwd, rel);
    if (reader.isFile(full)) return full;
  }
  return null;
}

/**
 * Resolve the React Native / Expo injection entry. Prefers, in order:
 *   1. `app/_layout.{tsx,jsx,js}` — the expo-router root layout,
 *   2. `src/app/_layout.{tsx,jsx,js}` — the same root layout under a `src/` dir,
 *      which is where create-expo-app's current DEFAULT template puts it,
 *   3. `App.{tsx,jsx,ts,js}` — the classic Expo / bare-RN root component,
 *   4. `index.{js,ts}` — the bare-RN `AppRegistry` entry.
 * First existing file wins. The root `app/` layout keeps precedence over the
 * `src/app/` one so existing projects resolve exactly as before; `src/app/` is a
 * new fallback checked ahead of `App.*`. Returns null when none exist
 * (→ ambiguous), so the resolver never points at an `expo/AppEntry` path inside
 * node_modules.
 */
export function resolveReactNativeEntry(
  cwd: string,
  reader: FileReader = localFsReader(cwd),
): string | null {
  const candidates = [
    path.join("app", "_layout.tsx"),
    path.join("app", "_layout.jsx"),
    path.join("app", "_layout.js"),
    path.join("src", "app", "_layout.tsx"),
    path.join("src", "app", "_layout.jsx"),
    path.join("src", "app", "_layout.js"),
    "App.tsx",
    "App.jsx",
    "App.ts",
    "App.js",
    "index.js",
    "index.ts",
  ];
  for (const c of candidates) {
    const full = path.join(cwd, c);
    if (reader.isFile(full)) return full;
  }
  return null;
}

/** Pull a node script/module path out of a `start`-style command. */
export function parseNodeInvocation(script: string): string | null {
  const m = script.match(
    /\b(?:node|nodemon|ts-node|tsx)\b(?:\s+(?:--?[^\s]+))*\s+([^\s&|]+\.[cm]?[jt]s)\b/,
  );
  return m ? m[1] : null;
}

function resolveNodeEntry(
  cwd: string,
  pkg: PackageJson,
  reader: FileReader,
): string | null {
  const candidates: string[] = [];
  if (typeof pkg.main === "string") candidates.push(pkg.main);
  if (typeof pkg.bin === "string") candidates.push(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === "object") {
    const first = Object.values(pkg.bin)[0];
    if (first) candidates.push(first);
  }
  if (pkg.scripts?.start) {
    const fromStart = parseNodeInvocation(pkg.scripts.start);
    if (fromStart) candidates.push(fromStart);
  }
  for (const c of candidates) {
    const full = path.join(cwd, c);
    if (reader.isFile(full)) return full;
  }
  return null;
}

/**
 * Resolve the NestJS injection entry. Nest's bootstrap lives at `src/main.ts`
 * (or `src/main.js`); `resolveNodeEntry` cannot find it because the `start`
 * script is `nest start` (not a bare node invocation) and `main` points at
 * `dist/`. First existing file wins; null when neither exists (→ ambiguous).
 */
export function resolveNestEntry(
  cwd: string,
  reader: FileReader = localFsReader(cwd),
): string | null {
  const candidates = [path.join("src", "main.ts"), path.join("src", "main.js")];
  for (const c of candidates) {
    const full = path.join(cwd, c);
    if (reader.isFile(full)) return full;
  }
  return null;
}

/**
 * Resolve the Remix / React Router v7 hydration entry. Prefers
 * `app/entry.client.{tsx,jsx,js}` in that order. Returns null when none exist —
 * the recipe then FALLS BACK rather than creating one, because a bare init-only
 * entry.client would omit hydrateRoot/<RemixBrowser> and break the app.
 */
export function resolveRemixEntry(
  cwd: string,
  reader: FileReader = localFsReader(cwd),
): string | null {
  const candidates = [
    path.join("app", "entry.client.tsx"),
    path.join("app", "entry.client.jsx"),
    path.join("app", "entry.client.js"),
  ];
  for (const c of candidates) {
    const full = path.join(cwd, c);
    if (reader.isFile(full)) return full;
  }
  return null;
}

/**
 * Resolve the Angular bootstrap entry — deterministically `src/main.ts`. Null
 * when absent (→ ambiguous). Prepending an import + `Crumbtrail.init` above
 * Angular's `bootstrapApplication`/`platformBrowserDynamic` call is safe.
 */
export function resolveAngularEntry(
  cwd: string,
  reader: FileReader = localFsReader(cwd),
): string | null {
  const full = path.join(cwd, "src", "main.ts");
  return reader.isFile(full) ? full : null;
}

function mergedDeps(pkg: PackageJson | null): Record<string, string> {
  if (!pkg) return {};
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

/** Does the manifest text reference a dependency token (word-boundary match)? */
function textMentions(text: string, token: string): boolean {
  return new RegExp(`\\b${token}\\b`, "i").test(text);
}

/**
 * Resolve a non-JS backend from filesystem markers — the `otlp` recipe's Stack.
 * Filesystem-only: no code is executed; Python/Ruby manifests are parsed purely
 * as text. Precedence is deliberate and documented:
 *   1. `manage.py`                         → django
 *   2. pyproject.toml/requirements.txt dep → fastapi (wins over flask if BOTH
 *      tokens appear) else flask
 *   3. `go.mod`                            → go
 *   4. `Gemfile` referencing rails         → rails
 *   5. any `*.csproj` in the root          → dotnet
 * Returns null when no marker matches. Works with NO package.json present.
 */
export function resolveOtlpStack(
  root: string,
  reader: FileReader = localFsReader(root),
): { stack: Stack; reason: string } | null {
  if (reader.isFile(path.join(root, "manage.py"))) {
    return {
      stack: "django",
      reason: "found manage.py (Django) — OTLP guidance",
    };
  }
  const pyText = [
    safeRead(path.join(root, "pyproject.toml"), reader),
    safeRead(path.join(root, "requirements.txt"), reader),
  ]
    .filter((t): t is string => t != null)
    .join("\n");
  if (pyText) {
    // FastAPI wins over Flask when both tokens are present.
    if (textMentions(pyText, "fastapi")) {
      return {
        stack: "fastapi",
        reason:
          "found a `fastapi` dependency in pyproject.toml/requirements.txt — OTLP guidance",
      };
    }
    if (textMentions(pyText, "flask")) {
      return {
        stack: "flask",
        reason:
          "found a `flask` dependency in pyproject.toml/requirements.txt — OTLP guidance",
      };
    }
  }
  if (reader.isFile(path.join(root, "go.mod"))) {
    return { stack: "go", reason: "found go.mod (Go) — OTLP guidance" };
  }
  const gemfile = safeRead(path.join(root, "Gemfile"), reader);
  if (gemfile != null && textMentions(gemfile, "rails")) {
    return {
      stack: "rails",
      reason: "found a Gemfile referencing rails — OTLP guidance",
    };
  }
  if (reader.readDir(root).some((entry) => entry.endsWith(".csproj"))) {
    return {
      stack: "dotnet",
      reason: "found a *.csproj file (.NET) — OTLP guidance",
    };
  }
  return null;
}

/**
 * Distinct `reasons` string pushed when a Deno project is detected (deno.json /
 * deno.jsonc with no package.json). Exported so the wizard can recognize the
 * signal and print a Deno-specific line instead of the generic unsupported hint.
 */
export const DENO_UNSUPPORTED_REASON = "Deno projects aren't supported yet";

/** Root-level markers that flag a Docker/Compose setup (presence only). */
const DOCKER_MARKER_FILES = [
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "Dockerfile",
];

/**
 * Informational, non-blocking note emitted when Docker/Compose files are present.
 * References that infra evidence sources (e.g. the `docker` stack in
 * install-shared's INFRA_STACKS) are coming soon. NEVER affects recipe/ambiguity.
 */
export const DOCKER_COMING_SOON_NOTE =
  "Docker/Compose files found — infra evidence sources (e.g. docker) are coming soon.";

/** True when a Deno project marker is present at root (presence only, not parsed). */
function hasDenoMarker(root: string, reader: FileReader): boolean {
  return (
    reader.isFile(path.join(root, "deno.json")) ||
    reader.isFile(path.join(root, "deno.jsonc"))
  );
}

/** True when any Docker/Compose marker file is present at root. */
function hasDockerMarker(root: string, reader: FileReader): boolean {
  return DOCKER_MARKER_FILES.some((f) => reader.isFile(path.join(root, f)));
}

/** Inputs shared by every recipe matcher — filesystem-derived facts only. */
interface MatchContext {
  root: string;
  reader: FileReader;
  deps: Record<string, string>;
  pkg: PackageJson | null;
  /** Matchers push their user-facing detection reasons here (side effect). */
  reasons: string[];
}

/** What a winning matcher resolves: recipe + optional entry/version/otlp stack. */
interface RecipeMatch {
  recipe: Recipe;
  entryFile: string | null;
  nextVersion: string | null;
  /** Only the `otlp` matcher sets this — the detected non-JS backend Stack. */
  otlpStack?: Stack | null;
}

/**
 * Ordered, most-specific-first recipe matchers. Each entry is
 * `[recipe, matcher]`; the matcher returns a partial match when it applies (and
 * records its `reasons` side effects) or null to fall through to the next. The
 * order — next → sveltekit → nuxt → vite-spa → node — is behavioral and must be
 * preserved. Each predicate mirrors the original if/else ladder byte-for-byte.
 */
const RECIPE_MATCHERS: ReadonlyArray<
  readonly [Recipe, (ctx: MatchContext) => Omit<RecipeMatch, "recipe"> | null]
> = [
  [
    // Ordered FIRST, ahead of every frontend-framework matcher. A Tauri app's
    // frontend framework is incidental — a Tauri+Vite or Tauri+SvelteKit app
    // carries `vite`/`@sveltejs/kit` deps and would otherwise match those
    // matchers first, but we want the TauriTransport (local Rust store) wiring.
    // The `@tauri-apps/*` dep + `src-tauri/` directory pair is the most specific
    // signal, so it must win. The frontend entry is resolved like vite-spa.
    "tauri",
    ({ root, deps, reasons, reader }) => {
      const hasTauriDep =
        "@tauri-apps/api" in deps || "@tauri-apps/cli" in deps;
      if (!hasTauriDep || !reader.isDir(path.join(root, "src-tauri")))
        return null;
      reasons.push("found `@tauri-apps/*` dependency + src-tauri/ directory");
      const entryFile = resolveViteEntry(root, reader);
      if (!entryFile)
        reasons.push(
          "could not resolve a local frontend entry from index.html",
        );
      return { entryFile, nextVersion: null };
    },
  ],
  [
    "next",
    ({ deps, reasons }) => {
      if (!("next" in deps)) return null;
      reasons.push("found `next` dependency");
      return { entryFile: null, nextVersion: deps.next ?? null };
    },
  ],
  [
    "sveltekit",
    ({ deps, reasons }) => {
      if (!("@sveltejs/kit" in deps)) return null;
      reasons.push("found `@sveltejs/kit` dependency");
      return { entryFile: null, nextVersion: null };
    },
  ],
  [
    "nuxt",
    ({ deps, reasons }) => {
      if (!("nuxt" in deps)) return null;
      reasons.push("found `nuxt` dependency");
      return { entryFile: null, nextVersion: null };
    },
  ],
  [
    // Ordered before vite-spa (Remix runs on Vite) and before express (Remix
    // custom-server apps carry express). Matches classic Remix v1/v2 via any
    // `@remix-run/*` runtime dep, or RR7 framework mode via the
    // `react-router` + `@react-router/dev` pair. A plain `react-router-dom` SPA
    // (no `@react-router/dev`) deliberately falls through to vite-spa.
    "remix",
    ({ root, deps, reasons, reader }) => {
      const classicRemix =
        "@remix-run/react" in deps ||
        "@remix-run/node" in deps ||
        "@remix-run/serve" in deps;
      const rr7 = "react-router" in deps && "@react-router/dev" in deps;
      if (!classicRemix && !rr7) return null;
      reasons.push(
        classicRemix
          ? "found `@remix-run/*` dependency"
          : "found `react-router` + `@react-router/dev` (React Router v7 framework mode)",
      );
      const entryFile = resolveRemixEntry(root, reader);
      if (!entryFile) reasons.push("could not resolve app/entry.client.*");
      return { entryFile, nextVersion: null };
    },
  ],
  [
    // Ordered before vite-spa (Astro is built on Vite). There is no single
    // deterministic client entry, so the recipe always hands off a guided
    // snippet — entry stays null by design (not ambiguity).
    "astro",
    ({ deps, reasons }) => {
      if (!("astro" in deps)) return null;
      reasons.push("found `astro` dependency");
      return { entryFile: null, nextVersion: null };
    },
  ],
  [
    // Ordered before vite-spa (safety; Angular has no root index.html so it
    // wouldn't match vite-spa anyway, but keep precedence explicit). The
    // `@angular/core` dep alone is a sufficiently specific signal; angular.json
    // is recorded only as a confirming reason.
    "angular",
    ({ root, deps, reasons, reader }) => {
      if (!("@angular/core" in deps)) return null;
      reasons.push("found `@angular/core` dependency");
      if (reader.isFile(path.join(root, "angular.json")))
        reasons.push("found angular.json");
      const entryFile = resolveAngularEntry(root, reader);
      if (!entryFile) reasons.push("could not resolve src/main.ts");
      return { entryFile, nextVersion: null };
    },
  ],
  [
    "vite-spa",
    ({ root, deps, reasons, reader }) => {
      if (!("vite" in deps && reader.isFile(path.join(root, "index.html"))))
        return null;
      reasons.push("found `vite` dependency + index.html");
      const entryFile = resolveViteEntry(root, reader);
      if (!entryFile)
        reasons.push("could not resolve a local module entry from index.html");
      return { entryFile, nextVersion: null };
    },
  ],
  [
    // Ordered before every backend-JS matcher: Nest apps carry
    // `@nestjs/platform-express` / `@nestjs/platform-fastify`, which pull in
    // express/fastify — so this must win over those matchers. The bootstrap
    // entry lives at src/main.ts (resolveNodeEntry can't find it).
    "nestjs",
    ({ root, deps, reasons, reader }) => {
      if (!("@nestjs/core" in deps)) return null;
      reasons.push("found `@nestjs/core` dependency");
      const entryFile = resolveNestEntry(root, reader);
      if (!entryFile) reasons.push("could not resolve src/main.ts");
      return { entryFile, nextVersion: null };
    },
  ],
  [
    "express",
    ({ root, deps, pkg, reasons, reader }) => {
      if (!("express" in deps) || !pkg) return null;
      reasons.push("found `express` dependency");
      return {
        entryFile: resolveNodeEntry(root, pkg, reader),
        nextVersion: null,
      };
    },
  ],
  [
    "hono",
    ({ root, deps, pkg, reasons, reader }) => {
      if (!("hono" in deps) || !pkg) return null;
      reasons.push("found `hono` dependency");
      return {
        entryFile: resolveNodeEntry(root, pkg, reader),
        nextVersion: null,
      };
    },
  ],
  [
    "fastify",
    ({ root, deps, pkg, reasons, reader }) => {
      if (!("fastify" in deps) || !pkg) return null;
      reasons.push("found `fastify` dependency");
      return {
        entryFile: resolveNodeEntry(root, pkg, reader),
        nextVersion: null,
      };
    },
  ],
  [
    // Placed before the generic `node` fallback. RN doesn't carry
    // next/sveltekit/nuxt/vite+index.html deps, so it only collides with the
    // node matcher (an RN `package.json` `main` can resolve a node entry). The
    // `expo` / `react-native` dep is the specific signal that must win.
    "react-native",
    ({ root, deps, reasons, reader }) => {
      if (!("expo" in deps || "react-native" in deps)) return null;
      reasons.push("found `expo` or `react-native` dependency");
      const entryFile = resolveReactNativeEntry(root, reader);
      if (!entryFile)
        reasons.push("could not resolve an App/_layout/index entry");
      return { entryFile, nextVersion: null };
    },
  ],
  [
    "node",
    ({ root, pkg, reasons, reader }) => {
      if (!pkg) return null;
      const nodeEntry = resolveNodeEntry(root, pkg, reader);
      if (!nodeEntry) return null;
      reasons.push("resolved a Node server entry from package.json");
      return { entryFile: nodeEntry, nextVersion: null };
    },
  ],
  [
    // Relaxed vite-spa fallback. The strict vite-spa matcher above requires a
    // root index.html; a Vite project whose index.html lives elsewhere (or is
    // absent) would otherwise fall through to "no recipe matched". This relaxed
    // matcher keys on the `vite` dep alone, but is ordered AFTER every backend
    // matcher (node included) so a project that carries express/hono/etc. plus a
    // vite devDep still detects its backend framework. Entry resolution still
    // needs a root index.html (resolveViteEntry), so a rootless project yields a
    // null entry → the guided fallback-ai plan, which is strictly better DX than
    // no match at all.
    "vite-spa",
    ({ root, deps, reasons, reader }) => {
      if (!("vite" in deps)) return null;
      reasons.push(
        "found `vite` dependency (no root index.html — guided fallback)",
      );
      const entryFile = resolveViteEntry(root, reader);
      if (!entryFile)
        reasons.push("could not resolve a local module entry from index.html");
      return { entryFile, nextVersion: null };
    },
  ],
  [
    // Ordered LAST — the least-specific fallback. These non-JS backend markers
    // are filesystem-only (no package.json needed) and must never pre-empt a JS
    // project, so they sit strictly after the generic `node` matcher. A single
    // `otlp` recipe carries the detected Stack out via `otlpStack`.
    "otlp",
    ({ root, reasons, reader }) => {
      const hit = resolveOtlpStack(root, reader);
      if (!hit) return null;
      reasons.push(hit.reason);
      return { entryFile: null, nextVersion: null, otlpStack: hit.stack };
    },
  ],
];

/**
 * Evaluate the ordered matcher ladder, returning the first match. When nothing
 * matches, recipe is null with no entry/version. Reasons are recorded as a side
 * effect on `ctx.reasons`, exactly as the original if/else chain did.
 */
export function matchRecipe(ctx: MatchContext): {
  recipe: Recipe | null;
  entryFile: string | null;
  nextVersion: string | null;
  otlpStack: Stack | null;
} {
  for (const [recipe, matcher] of RECIPE_MATCHERS) {
    const hit = matcher(ctx);
    if (hit)
      return {
        recipe,
        entryFile: hit.entryFile,
        nextVersion: hit.nextVersion,
        otlpStack: hit.otlpStack ?? null,
      };
  }
  return { recipe: null, entryFile: null, nextVersion: null, otlpStack: null };
}

/**
 * Classify a single package directory. For a monorepo root this reports the
 * workspace list and marks the result ambiguous — the caller picks a workspace
 * and re-runs `detect` inside it.
 */
export function detect(
  cwd: string,
  reader: FileReader = localFsReader(cwd),
): DetectResult {
  const reasons: string[] = [];
  const root = path.resolve(cwd);
  const packageJsonPath = reader.isFile(path.join(root, "package.json"))
    ? path.join(root, "package.json")
    : null;
  const pkg = packageJsonPath ? readPackageJson(root, reader) : null;
  const packageManager = detectPackageManager(root, reader);

  const workspaces = detectWorkspaces(root, pkg, reader);
  const isMonorepo = !!workspaces && workspaces.length > 0;

  const deps = mergedDeps(pkg);

  // Non-blocking informational notes — kept strictly separate from `reasons`
  // and never allowed to affect recipe/ambiguity/monorepo/entry.
  const notes: string[] = [];
  if (hasDockerMarker(root, reader)) notes.push(DOCKER_COMING_SOON_NOTE);

  // Ordered, most-specific-first matcher ladder. Each matcher inspects the
  // filesystem/manifest and, when it wins, records the recipe plus its exact
  // `reasons`/entry/version side effects. Order is load-bearing: sveltekit/nuxt
  // must win over a bare vite+index.html project, and vite-spa over the generic
  // node fallback. Preserve this list verbatim when adding recipes.
  const match = matchRecipe({ root, reader, deps, pkg, reasons });
  const recipe: Recipe | null = match.recipe;
  let entryFile: string | null = match.entryFile;
  const nextVersion: string | null = match.nextVersion;
  const otlpStack: Stack | null = match.otlpStack;

  let ambiguous = false;
  if (isMonorepo) {
    // A workspace root can carry framework deps too, but there is no single app
    // to wire — force the caller to pick a workspace. Don't guess an entry.
    ambiguous = true;
    entryFile = null;
    reasons.push(
      `monorepo root with ${workspaces!.length} workspace package(s); pick a workspace to wire`,
    );
  } else if (!recipe) {
    ambiguous = true;
    // A Deno project (deno.json/deno.jsonc, no package.json) gets a distinct,
    // recognizable reason so the wizard can explain it isn't supported yet
    // rather than falling back to the generic "no recipe matched" hint.
    if (!pkg && hasDenoMarker(root, reader))
      reasons.push(DENO_UNSUPPORTED_REASON);
    else reasons.push("no recipe matched");
  } else if (
    (recipe === "tauri" ||
      recipe === "remix" ||
      recipe === "angular" ||
      recipe === "vite-spa" ||
      recipe === "nestjs" ||
      recipe === "express" ||
      recipe === "hono" ||
      recipe === "fastify" ||
      recipe === "react-native" ||
      recipe === "node") &&
    !entryFile
  ) {
    ambiguous = true;
  }

  return {
    cwd: root,
    packageJsonPath,
    recipe,
    packageManager,
    entryFile,
    nextVersion,
    otlpStack,
    isMonorepo,
    workspaces: workspaces ?? [],
    ambiguous,
    reasons,
    notes,
  };
}
