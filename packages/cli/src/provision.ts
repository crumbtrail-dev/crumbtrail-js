// Provisioning: pick/create a project and add a service via the existing cloud
// routes, carrying the CLI bearer token. Hands-off — it does NOT mint an ingest
// key; the user mints one in the dashboard and sets it in their env. See
// plans/cli-setup-wizard-design.md §4. Network calls inherit net.ts's
// single-retry + method/URL-in-message policy.

import type { Stack } from "crumbtrail-core";
import type { Recipe } from "./detect";
import { RECIPE_REGISTRY } from "./recipe-registry";
import { ApiError, requestJson } from "./net";
import { color, type Prompter, type Ui } from "./ui";

export interface Project {
  id: string;
  name: string;
}

export interface Service {
  id: string;
  name: string;
}

/** Thrown on a 402 from POST /api/projects — carries the upgrade copy + URL. */
export class UpgradeRequiredError extends Error {
  readonly upgradeUrl?: string;
  constructor(message: string, upgradeUrl?: string) {
    super(message);
    this.name = "UpgradeRequiredError";
    this.upgradeUrl = upgradeUrl;
  }
}

// ── Pure inference helpers (unit-tested) ─────────────────────────────────────

/**
 * Project name: package.json `name` → git dir basename → "my-app". A scoped
 * package name (`@scope/app`) collapses to its last segment.
 */
export function inferProjectName(
  pkgName?: string | null,
  gitDirBasename?: string | null,
): string {
  const fromPkg = pkgName?.trim();
  if (fromPkg) {
    const last = fromPkg.split("/").pop();
    if (last) return last;
  }
  const fromDir = gitDirBasename?.trim();
  if (fromDir) return fromDir;
  return "my-app";
}

/**
 * Service name from stack/workspace: an explicit workspace package name wins;
 * otherwise Node backends default to "api" and client stacks to "web".
 */
export function inferServiceName(
  recipe: Recipe,
  workspaceName?: string | null,
): string {
  const ws = workspaceName?.trim();
  if (ws) {
    const last = ws.split("/").pop();
    if (last) return last;
  }
  return RECIPE_REGISTRY[recipe].serviceName;
}

// ── Cloud calls ──────────────────────────────────────────────────────────────

export async function listProjects(
  base: string,
  token: string,
  fetchImpl?: typeof fetch,
): Promise<Project[]> {
  const res = await requestJson<{ projects?: Project[] }>(
    `${base}/api/projects`,
    { token, fetchImpl },
  );
  return Array.isArray(res.projects) ? res.projects : [];
}

export async function createProject(
  base: string,
  token: string,
  name: string,
  fetchImpl?: typeof fetch,
): Promise<Project> {
  try {
    return await requestJson<Project>(`${base}/api/projects`, {
      method: "POST",
      token,
      body: { name },
      fetchImpl,
    });
  } catch (err) {
    if (err instanceof ApiError && err.status === 402) {
      const body =
        err.body && typeof err.body === "object"
          ? (err.body as Record<string, unknown>)
          : {};
      const copy =
        typeof body.error === "string"
          ? body.error
          : "The free tier includes one project. Upgrade to add more.";
      const url =
        typeof body.upgradeUrl === "string"
          ? body.upgradeUrl
          : typeof body.billingUrl === "string"
            ? body.billingUrl
            : undefined;
      throw new UpgradeRequiredError(copy, url);
    }
    throw err;
  }
}

export async function createService(
  base: string,
  token: string,
  projectId: string,
  args: { name: string; stack?: string },
  fetchImpl?: typeof fetch,
): Promise<Service> {
  return requestJson<Service>(`${base}/api/projects/${projectId}/services`, {
    method: "POST",
    token,
    body: { name: args.name, stack: args.stack },
    fetchImpl,
  });
}

// ── Orchestrated flow ────────────────────────────────────────────────────────

export interface ProvisionInput {
  base: string;
  token: string;
  recipe: Recipe;
  /**
   * The detected non-JS backend Stack for the `otlp` recipe
   * (`DetectResult.otlpStack`). When set it OVERRIDES the static
   * `RECIPE_REGISTRY[recipe].stack` placeholder on the createService call — this
   * is how the single otlp recipe reports its variable Stack to the service.
   */
  stack?: Stack | null;
  ui: Ui;
  prompter: Prompter;
  /** Skip prompts (non-interactive / --yes). */
  assumeYes: boolean;
  /** --project <id>: skip creation, attach a service to this project. */
  projectId?: string;
  /** Inferred defaults (from detection / package.json / git). */
  defaultProjectName: string;
  defaultServiceName: string;
  fetchImpl?: typeof fetch;
}

export interface ProvisionResult {
  projectId: string;
  projectName: string;
  serviceId: string;
  serviceName: string;
}

export interface ResolveProjectInput {
  base: string;
  token: string;
  ui: Ui;
  prompter: Prompter;
  assumeYes: boolean;
  projectId?: string;
  defaultProjectName: string;
  fetchImpl?: typeof fetch;
}

/**
 * Resolve the project a service will report to: explicit --project, an
 * interactive pick among existing projects, or a freshly created one.
 *
 * Split out of provisionFlow so the batch installer can resolve ONE project and
 * then mint many services under it.
 */
export async function resolveProject(
  input: ResolveProjectInput,
): Promise<Project> {
  const { base, token, ui, prompter, fetchImpl } = input;
  let project: Project;

  if (input.projectId) {
    project = { id: input.projectId, name: input.projectId };
  } else {
    const existing = await listProjects(base, token, fetchImpl);
    if (existing.length > 0 && !input.assumeYes) {
      const labels = [
        `Create a new project (${input.defaultProjectName})`,
        ...existing.map((p) => p.name),
      ];
      const choice = await prompter.select(
        "Which project should this app report to?",
        labels,
        0,
      );
      if (choice === 0) {
        const name = await prompter.ask(
          "New project name",
          input.defaultProjectName,
        );
        project = await createProject(base, token, name, fetchImpl);
      } else {
        project = existing[choice - 1];
      }
    } else {
      // No existing projects, or --yes: create one with the inferred name.
      project = await createProject(
        base,
        token,
        input.defaultProjectName,
        fetchImpl,
      );
    }
  }
  ui.out(`${color.green("✓")} Project: ${color.bold(project.name)}`);
  return project;
}

export interface ProvisionServiceInput {
  base: string;
  token: string;
  projectId: string;
  recipe: Recipe;
  /** Detected otlp stack; overrides the registry placeholder. */
  stack?: Stack | null;
  serviceName: string;
  ui: Ui;
  fetchImpl?: typeof fetch;
}

/**
 * Add one service to an already-resolved project. Hands-off: it does NOT mint an
 * ingest key — the user mints one in the dashboard and sets it in their env. The
 * created service is what gives them somewhere to mint that key against.
 * Prompt-free by design: the batch installer names services from detection
 * rather than asking N times.
 */
export async function provisionService(
  input: ProvisionServiceInput,
): Promise<{ serviceId: string; serviceName: string }> {
  const { base, token, ui, fetchImpl } = input;
  // Prefer the DETECTED otlp stack when present; otherwise the registry stack.
  // For otlp the registry value is only a placeholder, so input.stack is what
  // actually files the service under django/flask/fastapi/go/rails/dotnet.
  const serviceStack = input.stack ?? RECIPE_REGISTRY[input.recipe].stack;
  const service = await createService(
    base,
    token,
    input.projectId,
    { name: input.serviceName, stack: serviceStack },
    fetchImpl,
  );
  ui.out(`${color.green("✓")} Service: ${color.bold(service.name)}`);

  return { serviceId: service.id, serviceName: service.name };
}

/**
 * De-collide inferred service names. Two frontends in `apps/web` and
 * `apps/marketing` both infer to "web" (RECIPE_REGISTRY[next].serviceName), and
 * two identically-named services in one project are indistinguishable in the
 * dashboard. On a collision, fall back to the directory basename, then to a
 * numeric suffix. Order-stable: the first claimant keeps the plain name.
 */
export function uniqueServiceNames(
  candidates: { name: string; relDir: string }[],
): string[] {
  const taken = new Set<string>();
  return candidates.map((c) => {
    const options = [
      c.name,
      c.relDir.split("/").filter(Boolean).pop() ?? c.name,
      // Distinguish apps/web from packages/web: use the parent too.
      c.relDir.split("/").filter(Boolean).join("-"),
    ];
    for (const option of options) {
      if (option && !taken.has(option)) {
        taken.add(option);
        return option;
      }
    }
    let n = 2;
    while (taken.has(`${c.name}-${n}`)) n += 1;
    const fallback = `${c.name}-${n}`;
    taken.add(fallback);
    return fallback;
  });
}

/**
 * Resolve a project and add a service to it, returned to the wizard for the
 * summary. Hands-off — no key is minted. Composed from resolveProject +
 * provisionService so the single-package path keeps its exact behavior
 * (including the interactive "Service name" prompt).
 */
export async function provisionFlow(
  input: ProvisionInput,
): Promise<ProvisionResult> {
  const project = await resolveProject(input);

  let serviceName = input.defaultServiceName;
  if (!input.assumeYes) {
    serviceName = await input.prompter.ask(
      "Service name",
      input.defaultServiceName,
    );
  }

  const service = await provisionService({
    base: input.base,
    token: input.token,
    projectId: project.id,
    recipe: input.recipe,
    stack: input.stack,
    serviceName,
    ui: input.ui,
    fetchImpl: input.fetchImpl,
  });

  return {
    projectId: project.id,
    projectName: project.name,
    serviceId: service.serviceId,
    serviceName: service.serviceName,
  };
}
