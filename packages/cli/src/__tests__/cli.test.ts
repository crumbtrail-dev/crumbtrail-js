import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installSdk as realInstallSdk,
  isCliEntrypoint,
  parseArgs,
  resolveWorkspaceDir,
  runCli,
  type WizardDeps,
} from "../cli";
import {
  DENO_UNSUPPORTED_REASON,
  DOCKER_COMING_SOON_NOTE,
  type DetectResult,
  type Plan,
} from "../index";
import type { ServiceCandidate } from "../discover";
import type { Prompter, Ui } from "../ui";

function captureUi(): { ui: Ui; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    ui: {
      out: (l = "") => lines.push(l),
      err: (l = "") => lines.push(l),
    },
  };
}

const noopPrompter: Prompter = {
  ask: async (_q, d) => d ?? "",
  confirm: async (_q, d) => d ?? true,
  select: async (_q, _l, d) => d ?? 0,
  // Accept the checked defaults — the same thing pressing Enter does.
  multiSelect: async (_q, items) =>
    items
      .map((it, i) => (it.checked && it.selectable ? i : -1))
      .filter((i) => i >= 0),
};

function detectResult(over: Partial<DetectResult> = {}): DetectResult {
  return {
    cwd: "/app",
    packageJsonPath: "/app/package.json",
    recipe: "vite-spa",
    packageManager: "pnpm",
    entryFile: "/app/src/main.ts",
    nextVersion: null,
    otlpStack: null,
    isMonorepo: false,
    workspaces: [],
    ambiguous: false,
    reasons: [],
    notes: [],
    ...over,
  };
}

function createPlan(): Plan {
  return {
    recipe: "vite-spa",
    kind: "create",
    targetPath: "/app/src/main.ts",
    content: "// init",
    warnings: [],
    // Hands-off: the injected code reads its key from this env var; the wizard
    // prints the var name + "mint in the dashboard" (it writes no key itself).
    keyEnvVar: "VITE_CRUMBTRAIL_KEY",
  };
}

interface HarnessOpts {
  isTTY?: boolean;
  steps: string[];
}

function makeDeps(h: HarnessOpts, over: Partial<WizardDeps> = {}): WizardDeps {
  const { ui } = captureUi();
  const base: WizardDeps = {
    detect: vi.fn(() => {
      h.steps.push("detect");
      return detectResult();
    }),
    ensureToken: vi.fn(async () => {
      h.steps.push("login");
      return "bl_cli_token";
    }) as unknown as WizardDeps["ensureToken"],
    provisionFlow: vi.fn(async () => {
      h.steps.push("provision");
      return {
        projectId: "p1",
        projectName: "checkout",
        serviceId: "s1",
        serviceName: "web",
      };
    }) as unknown as WizardDeps["provisionFlow"],
    installSdk: vi.fn(async () => {
      h.steps.push("install");
      return { installed: true, packages: ["crumbtrail-core"] };
    }),
    buildPlan: vi.fn(() => {
      h.steps.push("build");
      return createPlan();
    }) as unknown as WizardDeps["buildPlan"],
    executePlan: vi.fn(() => {
      h.steps.push("execute");
      return {
        kind: "create" as const,
        written: ["/app/src/main.ts"],
        skipped: false,
        message: "Wrote 1 file(s).",
      };
    }) as unknown as WizardDeps["executePlan"],
    pollForRealEvent: vi.fn(async () => {
      h.steps.push("poll");
      return { outcome: "found" as const, sessionId: "sess-1" };
    }) as unknown as WizardDeps["pollForRealEvent"],
    discoverServices: vi.fn(() => {
      h.steps.push("discover");
      return [];
    }) as unknown as WizardDeps["discoverServices"],
    resolveProject: vi.fn(async () => {
      h.steps.push("project");
      return { id: "p1", name: "checkout" };
    }) as unknown as WizardDeps["resolveProject"],
    provisionService: vi.fn(async (input: { serviceName: string }) => {
      h.steps.push(`provision:${input.serviceName}`);
      return {
        serviceId: `svc-${input.serviceName}`,
        serviceName: input.serviceName,
      };
    }) as unknown as WizardDeps["provisionService"],
    pollForServices: vi.fn(async (opts: { serviceIds: string[] }) => {
      h.steps.push("poll");
      return {
        outcome: "found" as const,
        found: Object.fromEntries(
          opts.serviceIds.map((id) => [id, `sess-${id}`]),
        ),
      };
    }) as unknown as WizardDeps["pollForServices"],
    openBrowserFn: vi.fn(async () => true),
    ui,
    prompter: noopPrompter,
    // DISPLAY pinned so canUseBrowser's headless-Linux guard doesn't make
    // browser-open assertions platform-dependent (CI runners have no X).
    env: { CRUMBTRAIL_BASE_URL: "http://127.0.0.1:9999", DISPLAY: ":0" },
    cwd: "/app",
    isTTY: h.isTTY ?? true,
    fetchImpl: undefined,
  };
  return { ...base, ...over };
}

describe("parseArgs", () => {
  it("parses flags, subcommands, and both --k v / --k=v forms", () => {
    expect(parseArgs(["node", "cli", "--help"]).command).toBe("help");
    expect(parseArgs(["node", "cli", "-v"]).command).toBe("version");
    expect(parseArgs(["node", "cli", "login"]).command).toBe("login");
    const p = parseArgs([
      "node",
      "cli",
      "--yes",
      "--project=proj_1",
      "--no-browser",
      "--skip-verify",
      "--endpoint",
      "https://x",
    ]);
    expect(p).toMatchObject({
      command: "wizard",
      yes: true,
      project: "proj_1",
      noBrowser: true,
      skipVerify: true,
      endpoint: "https://x",
    });
  });

  it("parses --workspace in both --k v and --k=v forms", () => {
    expect(
      parseArgs(["node", "cli", "--workspace", "apps/web"]).workspace,
    ).toBe("apps/web");
    expect(
      parseArgs(["node", "cli", "--workspace=packages/api"]).workspace,
    ).toBe("packages/api");
    expect(parseArgs(["node", "cli"]).workspace).toBeUndefined();
  });
});

describe("resolveWorkspaceDir (--workspace validation)", () => {
  const io = (dirs: string[], files: string[]) => ({
    isDir: (p: string) => dirs.includes(p),
    isFile: (p: string) => files.includes(p),
  });

  it("resolves a dir that exists and holds a package.json", () => {
    const res = resolveWorkspaceDir(
      "/repo",
      "apps/web",
      io(["/repo/apps/web"], ["/repo/apps/web/package.json"]),
    );
    expect(res).toEqual({ dir: "/repo/apps/web" });
  });

  it("errors when the dir does not exist", () => {
    const res = resolveWorkspaceDir("/repo", "apps/ghost", io([], []));
    expect("error" in res && res.error).toMatch(/no such directory/);
  });

  it("errors when the dir has no package.json", () => {
    const res = resolveWorkspaceDir(
      "/repo",
      "services/rails",
      io(["/repo/services/rails"], []),
    );
    expect("error" in res && res.error).toMatch(/no package\.json/);
  });
});

describe("wizard orchestration", () => {
  it("runs steps in the documented order and prints a summary", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps }, { ui });
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    // buildPlan runs BEFORE installSdk (it must analyze the pre-install repo so
    // its idempotency check doesn't see the SDK deps installSdk just added and
    // self-cancel injection); executePlan still runs last, after install.
    // Hands-off: the wizard mints no key, so there is no synthetic-session check.
    expect(steps).toEqual([
      "detect",
      "login",
      "provision",
      "build",
      "install",
      "execute",
      "poll",
    ]);
    const out = lines.join("\n");
    expect(out).toContain("checkout"); // project
    expect(out).toContain("web"); // service
    // No masked key is printed — instead the wizard names the env var to set and
    // points the user at the dashboard to mint the value.
    expect(out).toContain("VITE_CRUMBTRAIL_KEY");
    expect(out).toContain("/settings");
    expect(out).not.toMatch(/ctkey_|bgk_|bl_key_/);
    expect(out).toContain("/bugs"); // dashboard link
    expect(out).toContain("/sessions/sess-1"); // deep link to the live session
    expect(out).toContain("/app/src/main.ts"); // injection names the file
  });

  it("opens the live session in the browser on the first real event", async () => {
    const steps: string[] = [];
    const openBrowserFn = vi.fn(async () => true);
    const deps = makeDeps({ steps }, { openBrowserFn });
    await runCli(["node", "cli"], deps);
    expect(openBrowserFn).toHaveBeenCalledWith(
      "http://127.0.0.1:9999/sessions/sess-1",
    );
  });

  it("prints the deep link but never opens a browser with --no-browser", async () => {
    const steps: string[] = [];
    const openBrowserFn = vi.fn(async () => true);
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps }, { openBrowserFn, ui });
    await runCli(["node", "cli", "--no-browser"], deps);
    expect(openBrowserFn).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("/sessions/sess-1");
  });

  it("plans before install, installs before executing (build<install<execute)", async () => {
    const steps: string[] = [];
    const deps = makeDeps({ steps });
    await runCli(["node", "cli"], deps);
    expect(steps.indexOf("build")).toBeLessThan(steps.indexOf("install"));
    expect(steps.indexOf("install")).toBeLessThan(steps.indexOf("execute"));
  });
});

describe("installSdk — tarball fallback (registry unavailable)", () => {
  const uiSink: Ui = { out: () => {}, err: () => {} };

  it("falls back to the deploy's /install tarballs when the registry install fails", async () => {
    const calls: string[][] = [];
    // First (registry) install fails; the tarball-URL install succeeds.
    const spawnFn = (_cmd: string, args: string[]) => {
      calls.push(args);
      return calls.length === 1 ? 1 : 0;
    };
    const fetchImpl = (async (url: string) => {
      expect(url).toBe("https://deploy.example/install/manifest.json");
      return {
        ok: true,
        json: async () => ({
          schemaVersion: "install-manifest.v1",
          files: [
            "crumbtrail-core-0.1.0.tgz",
            "crumbtrail-node-0.1.0.tgz",
            "crumbtrail-0.1.0.tgz",
          ],
        }),
      };
    }) as unknown as typeof fetch;

    const result = await realInstallSdk({
      cwd: "/app",
      packageManager: "npm",
      recipe: "express",
      base: "https://deploy.example",
      ui: uiSink,
      spawnFn,
      fetchImpl,
    });

    expect(result.installed).toBe(true);
    expect(result.note).toContain("install tarballs");
    // Second spawn installs the discovered tarball URLs (core + node).
    expect(calls[1]).toEqual([
      "install",
      "https://deploy.example/install/crumbtrail-core-0.1.0.tgz",
      "https://deploy.example/install/crumbtrail-node-0.1.0.tgz",
    ]);
  });

  it("resolves react-native + tauri from the deploy's optional tarball channels", async () => {
    // CP5: react-native/tauri are packed as optional channels now, so a failed
    // registry install must fall through to the SAME manifest-driven tarball
    // discovery as the core recipes (no more 'not yet distributable' dead-end).
    for (const recipe of ["react-native", "tauri"] as const) {
      const pkg =
        recipe === "react-native"
          ? "crumbtrail-react-native"
          : "crumbtrail-tauri";
      const calls: string[][] = [];
      const spawnFn = (_cmd: string, args: string[]) => {
        calls.push(args);
        return calls.length === 1 ? 1 : 0; // registry fails, tarball install ok
      };
      let probed = false;
      const fetchImpl = (async (url: string) => {
        probed = true;
        expect(url).toBe("https://deploy.example/install/manifest.json");
        return {
          ok: true,
          json: async () => ({
            schemaVersion: "install-manifest.v1",
            files: [
              "crumbtrail-core-0.1.0.tgz",
              "crumbtrail-node-0.1.0.tgz",
              "crumbtrail-0.1.0.tgz",
              "crumbtrail-react-native-0.1.0.tgz",
              "crumbtrail-tauri-0.1.0.tgz",
            ],
          }),
        };
      }) as unknown as typeof fetch;

      const result = await realInstallSdk({
        cwd: "/app",
        packageManager: "npm",
        recipe,
        base: "https://deploy.example",
        ui: uiSink,
        spawnFn,
        fetchImpl,
      });

      expect(probed).toBe(true); // DID probe the manifest (was skipped before CP5)
      expect(result.installed).toBe(true);
      expect(result.note).toContain("install tarballs");
      // Second spawn installs the discovered tarball URLs (core + the SDK pkg).
      expect(calls[1]).toEqual([
        "install",
        "https://deploy.example/install/crumbtrail-core-0.1.0.tgz",
        `https://deploy.example/install/${pkg}-0.1.0.tgz`,
      ]);
    }
  });
});

// ── Batch installer (monorepo root) ─────────────────────────────────────────

function candidate(over: Partial<ServiceCandidate> = {}): ServiceCandidate {
  const relDir = over.relDir ?? "apps/web";
  return {
    dir: `/app/${relDir}`,
    name: relDir.split("/").pop() as string,
    relDir,
    source: "workspace",
    detected: detectResult({ cwd: `/app/${relDir}` }),
    recipe: "vite-spa",
    flags: [],
    defaultChecked: true,
    selectable: true,
    ...over,
  };
}

/** Root detect() result — the only thing that routes us into the batch path. */
function monorepoRoot(): DetectResult {
  return detectResult({
    cwd: "/app",
    isMonorepo: true,
    ambiguous: true,
    recipe: null,
    entryFile: null,
    workspaces: [{ name: "web", dir: "/app/apps/web" }],
  });
}

/**
 * Batch deps whose per-service steps carry the service's directory, so ordering
 * assertions can prove `build:X` precedes `install:X` for every X.
 */
function batchDeps(
  steps: string[],
  candidates: ServiceCandidate[],
  over: Partial<WizardDeps> = {},
): WizardDeps {
  return makeDeps(
    { steps },
    {
      detect: vi.fn(() => {
        steps.push("detect");
        return monorepoRoot();
      }),
      discoverServices: vi.fn(() => {
        steps.push("discover");
        return candidates;
      }) as unknown as WizardDeps["discoverServices"],
      buildPlan: vi.fn((input: { cwd: string }) => {
        steps.push(`build:${input.cwd}`);
        return { ...createPlan(), targetPath: `${input.cwd}/src/main.ts` };
      }) as unknown as WizardDeps["buildPlan"],
      installSdk: vi.fn(async (input: { cwd: string }) => {
        steps.push(`install:${input.cwd}`);
        return { installed: true, packages: ["crumbtrail-core"] };
      }) as unknown as WizardDeps["installSdk"],
      executePlan: vi.fn((plan: Plan) => {
        steps.push(`execute:${plan.targetPath}`);
        return {
          kind: plan.kind,
          written: [plan.targetPath as string],
          skipped: false,
          message: "Wrote 1 file(s).",
        };
      }) as unknown as WizardDeps["executePlan"],
      ...over,
    },
  );
}

describe("batch installer (monorepo root)", () => {
  it("wires every checked service: one login, one project, one poll", async () => {
    const steps: string[] = [];
    const deps = batchDeps(steps, [
      candidate({ relDir: "apps/web", recipe: "next" }),
      candidate({ relDir: "services/api", recipe: "express" }),
    ]);

    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);

    // Login, project, and the shared poll happen exactly once for the batch.
    expect(steps.filter((s) => s === "login")).toHaveLength(1);
    expect(steps.filter((s) => s === "project")).toHaveLength(1);
    expect(steps.filter((s) => s === "poll")).toHaveLength(1);

    // Both services provisioned, each named from its workspace package name.
    expect(steps).toContain("provision:web");
    expect(steps).toContain("provision:api");

    // The load-bearing invariant: for EACH dir, the plan is built before the
    // SDK is installed — otherwise buildPlan sees crumbtrail-core in package.json
    // and self-cancels to skip-already-wired.
    for (const dir of ["/app/apps/web", "/app/services/api"]) {
      expect(steps.indexOf(`build:${dir}`)).toBeGreaterThanOrEqual(0);
      expect(steps.indexOf(`build:${dir}`)).toBeLessThan(
        steps.indexOf(`install:${dir}`),
      );
      expect(steps.indexOf(`install:${dir}`)).toBeLessThan(
        steps.indexOf(`execute:${dir}/src/main.ts`),
      );
    }
  });

  it("keeps going when one service fails, and reports it", async () => {
    const steps: string[] = [];
    const deps = batchDeps(
      steps,
      [
        candidate({ relDir: "apps/web", recipe: "next" }),
        candidate({ relDir: "services/api", recipe: "express" }),
        candidate({ relDir: "apps/admin", recipe: "next" }),
      ],
      {
        executePlan: vi.fn((plan: Plan) => {
          steps.push(`execute:${plan.targetPath}`);
          if (plan.targetPath?.includes("services/api")) {
            throw new Error("refusing to overwrite existing file");
          }
          return {
            kind: plan.kind,
            written: [plan.targetPath as string],
            skipped: false,
            message: "Wrote 1 file(s).",
          };
        }) as unknown as WizardDeps["executePlan"],
      },
    );
    const { ui, lines } = captureUi();
    deps.ui = ui;

    const code = await runCli(["node", "cli"], deps);

    // A partial batch is still a success — two of three services got wired.
    expect(code).toBe(0);
    // The service AFTER the failure still ran: the batch did not abort.
    expect(steps).toContain("provision:admin");
    expect(steps).toContain("execute:/app/apps/admin/src/main.ts");

    const out = lines.join("\n");
    expect(out).toContain("refusing to overwrite existing file");
    expect(out).toContain("2 wired");
    expect(out).toContain("1 failed");
    expect(out).toContain("Re-run `crumbtrail` to retry");
  });

  it("does not mint a key for an already-wired service", async () => {
    const steps: string[] = [];
    const deps = batchDeps(steps, [
      candidate({ relDir: "apps/web", recipe: "next" }),
      candidate({
        relDir: "apps/admin",
        recipe: "next",
        flags: ["already-wired"],
        defaultChecked: false,
      }),
    ]);
    // Explicitly select BOTH, so we prove the skip is behavior, not just an
    // unchecked default.
    deps.prompter = {
      ...deps.prompter,
      multiSelect: async (_q, items) => items.map((_, i) => i),
    };
    const { ui, lines } = captureUi();
    deps.ui = ui;

    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    expect(steps).toContain("provision:web");
    expect(steps).not.toContain("provision:admin");
    expect(steps).not.toContain("install:/app/apps/admin");
    expect(lines.join("\n")).toContain("already wired");
  });

  it("writes a guide file for an OTLP service and never spawns a package manager", async () => {
    const steps: string[] = [];
    const spawnFn = vi.fn(() => 0);
    const deps = batchDeps(
      steps,
      [
        candidate({
          relDir: "services/payments",
          recipe: "otlp",
          detected: detectResult({
            cwd: "/app/services/payments",
            recipe: "otlp",
            otlpStack: "rails",
            entryFile: null,
          }),
        }),
      ],
      {
        buildPlan: vi.fn((input: { cwd: string }) => {
          steps.push(`build:${input.cwd}`);
          return {
            recipe: "otlp" as const,
            kind: "otlp-guidance" as const,
            targetPath: null,
            content: null,
            snippet: "OTEL_EXPORTER_OTLP_ENDPOINT=…",
            agentPrompt: "wire up otlp",
            warnings: [],
          };
        }) as unknown as WizardDeps["buildPlan"],
        // The REAL installSdk, so an accidental spawn would be caught.
        installSdk: (input) =>
          realInstallSdk({
            ...input,
            spawnFn,
            fetchImpl: (async () => {
              throw new Error("no network");
            }) as unknown as typeof fetch,
          }),
      },
    );
    const written: (string | null)[] = [];
    deps.executePlan = vi.fn((plan: Plan) => {
      written.push(plan.targetPath);
      return {
        kind: plan.kind,
        written: [plan.targetPath as string],
        skipped: false,
        message: "Wrote 1 file(s).",
      };
    }) as unknown as WizardDeps["executePlan"];

    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    // otlp has no SDK packages — installSdk must early-return, not shell out.
    expect(spawnFn).not.toHaveBeenCalled();
    expect(written).toEqual(["/app/services/payments/CRUMBTRAIL-OTLP.md"]);
  });

  it("refuses to guess in CI without --only/--all, and honors them when given", async () => {
    const candidates = [
      candidate({ relDir: "apps/web", recipe: "next" }),
      candidate({ relDir: "services/api", recipe: "express" }),
    ];

    const ciSteps: string[] = [];
    const ci = batchDeps(ciSteps, candidates);
    ci.isTTY = false;
    const { ui, lines } = captureUi();
    ci.ui = ui;
    // The pre-existing non-TTY guard already forces --yes --project in CI; the
    // new failure mode is having no way to say WHICH services.
    expect(await runCli(["node", "cli", "--yes", "--project", "p1"], ci)).toBe(
      1,
    );
    expect(lines.join("\n")).toContain("--only");
    expect(ciSteps).not.toContain("login");

    // --only picks exactly one, with no prompt.
    const onlySteps: string[] = [];
    const only = batchDeps(onlySteps, candidates);
    only.isTTY = false;
    only.prompter = {
      ...only.prompter,
      multiSelect: vi.fn(async () => {
        throw new Error("must not prompt");
      }),
    };
    expect(
      await runCli(
        ["node", "cli", "--yes", "--project", "p1", "--only", "services/api"],
        only,
      ),
    ).toBe(0);
    expect(onlySteps).toContain("provision:api");
    expect(onlySteps).not.toContain("provision:web");

    // An unknown --only value is a user error, not a silent no-op.
    const badSteps: string[] = [];
    const bad = batchDeps(badSteps, candidates);
    const badUi = captureUi();
    bad.ui = badUi.ui;
    expect(await runCli(["node", "cli", "--only", "nope"], bad)).toBe(1);
    expect(badUi.lines.join("\n")).toContain("no such service");
  });

  it("bails when nothing in the repo can be wired", async () => {
    const steps: string[] = [];
    const deps = batchDeps(steps, [
      candidate({
        relDir: "packages/tsconfig",
        recipe: null,
        selectable: false,
        defaultChecked: false,
        flags: ["no-recipe"],
      }),
    ]);
    const { ui, lines } = captureUi();
    deps.ui = ui;

    expect(await runCli(["node", "cli"], deps)).toBe(1);
    expect(steps).not.toContain("login");
    expect(lines.join("\n")).toContain("Nothing here can be wired");
  });
});

describe("wizard — OTLP backend (non-JS)", () => {
  it("skips the SDK install (no spawn) and prints OTLP guidance, touching no files", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const spawnFn = vi.fn(() => 0);
    const executePlan = vi.fn(() => {
      steps.push("execute");
      return {
        kind: "otlp-guidance" as const,
        written: [],
        skipped: true,
        message: "OTLP",
      };
    }) as unknown as WizardDeps["executePlan"];
    const deps = makeDeps(
      { steps },
      {
        ui,
        detect: vi.fn(() => {
          steps.push("detect");
          return detectResult({
            recipe: "otlp",
            otlpStack: "fastapi",
            entryFile: null,
            ambiguous: false,
            packageJsonPath: null,
          });
        }),
        // Exercise the REAL installSdk so the empty-package guard is under test.
        installSdk: (input) => {
          steps.push("install");
          return realInstallSdk({ ...input, spawnFn });
        },
        buildPlan: vi.fn(() => {
          steps.push("build");
          return {
            recipe: "otlp",
            kind: "otlp-guidance",
            targetPath: null,
            content: null,
            warnings: [],
            snippet:
              "OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:9999\nOTEL_EXPORTER_OTLP_HEADERS=X-Crumbtrail-Auth=bl_key",
            agentPrompt:
              "Agent: point OTEL_EXPORTER_OTLP_ENDPOINT at Crumbtrail",
          } as Plan;
        }) as unknown as WizardDeps["buildPlan"],
        executePlan,
      },
    );
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    // The empty SDK package list must NOT spawn a package manager.
    expect(spawnFn).not.toHaveBeenCalled();
    // The guidance path never calls the executor (it prints, touches nothing).
    expect(executePlan).not.toHaveBeenCalled();
    const out = lines.join("\n");
    expect(out).toContain("OpenTelemetry");
    expect(out).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
  });
});

describe("wizard — detection-quality notes (CP6)", () => {
  it("prints a docker coming-soon note after '✓ Detected' without changing the flow", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      {
        ui,
        detect: vi.fn(() => {
          steps.push("detect");
          return detectResult({ notes: [DOCKER_COMING_SOON_NOTE] });
        }),
      },
    );
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("✓ Detected");
    expect(out).toContain(DOCKER_COMING_SOON_NOTE);
  });

  it("surfaces a Deno-specific message (not the generic hint) on the no-recipe path", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      {
        ui,
        detect: vi.fn(() => {
          steps.push("detect");
          return detectResult({
            recipe: null,
            ambiguous: true,
            entryFile: null,
            packageJsonPath: null,
            reasons: [DENO_UNSUPPORTED_REASON],
          });
        }),
      },
    );
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(1);
    const out = lines.join("\n");
    expect(out).toContain("Deno projects aren't supported yet");
    // The generic "Supported: ..." framework list is suppressed for Deno.
    expect(out).not.toContain("Supported: Next.js");
  });

  it("prints a docker note on the no-recipe path too", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      {
        ui,
        detect: vi.fn(() => {
          steps.push("detect");
          return detectResult({
            recipe: null,
            ambiguous: true,
            entryFile: null,
            reasons: ["no recipe matched"],
            notes: [DOCKER_COMING_SOON_NOTE],
          });
        }),
      },
    );
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain(DOCKER_COMING_SOON_NOTE);
  });
});

describe("non-TTY guard", () => {
  it("refuses without --yes AND --project", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps, isTTY: false }, { ui });
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(1);
    expect(steps).toEqual([]); // guarded before any step
    expect(lines.join("\n")).toContain("Non-interactive");
  });

  it("proceeds when given --yes and --project", async () => {
    const steps: string[] = [];
    const deps = makeDeps({ steps, isTTY: false });
    const code = await runCli(
      ["node", "cli", "--yes", "--project", "proj_1"],
      deps,
    );
    expect(code).toBe(0);
    expect(steps).toContain("provision");
  });
});

describe("non-TTY login fail-fast wiring (BUG-4)", () => {
  it("passes allowInteractiveLogin=false to ensureToken in a non-TTY shell", async () => {
    const steps: string[] = [];
    let seen: boolean | undefined;
    const deps = makeDeps(
      { steps, isTTY: false },
      {
        ensureToken: vi.fn(
          async (opts: { allowInteractiveLogin?: boolean }) => {
            seen = opts.allowInteractiveLogin;
            return "bl_cli_token";
          },
        ) as unknown as WizardDeps["ensureToken"],
      },
    );
    // Non-TTY needs --yes --project to clear the prompt guard and reach login.
    const code = await runCli(
      ["node", "cli", "--yes", "--project", "p1"],
      deps,
    );
    expect(code).toBe(0);
    expect(seen).toBe(false);
  });

  it("passes allowInteractiveLogin=true in an interactive shell", async () => {
    const steps: string[] = [];
    let seen: boolean | undefined;
    const deps = makeDeps(
      { steps, isTTY: true },
      {
        ensureToken: vi.fn(
          async (opts: { allowInteractiveLogin?: boolean }) => {
            seen = opts.allowInteractiveLogin;
            return "bl_cli_token";
          },
        ) as unknown as WizardDeps["ensureToken"],
      },
    );
    await runCli(["node", "cli"], deps);
    expect(seen).toBe(true);
  });
});

describe("wizard — --workspace targeting (BUG-6)", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), "bl-ws-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("points detection at the resolved package dir instead of the repo root", async () => {
    const wsDir = path.join(tmp, "apps", "web");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      path.join(wsDir, "package.json"),
      JSON.stringify({ name: "web" }),
    );
    const steps: string[] = [];
    let detectedCwd: string | undefined;
    const deps = makeDeps(
      { steps },
      {
        cwd: tmp,
        detect: vi.fn((cwd: string) => {
          detectedCwd = cwd;
          steps.push("detect");
          return detectResult({ cwd });
        }),
      },
    );
    const code = await runCli(["node", "cli", "--workspace", "apps/web"], deps);
    expect(code).toBe(0);
    expect(detectedCwd).toBe(wsDir);
  });

  it("fails with a clear error when the --workspace dir is missing", async () => {
    const { ui, lines } = captureUi();
    const steps: string[] = [];
    const deps = makeDeps({ steps }, { cwd: tmp, ui });
    const code = await runCli(
      ["node", "cli", "--workspace", "apps/ghost"],
      deps,
    );
    expect(code).toBe(1);
    // Bailed before detection ever ran.
    expect(steps).not.toContain("detect");
    expect(lines.join("\n")).toMatch(/no such directory/);
  });

  it("fails when the --workspace dir has no package.json", async () => {
    mkdirSync(path.join(tmp, "services", "rails"), { recursive: true });
    const { ui, lines } = captureUi();
    const steps: string[] = [];
    const deps = makeDeps({ steps }, { cwd: tmp, ui });
    const code = await runCli(
      ["node", "cli", "--workspace", "services/rails"],
      deps,
    );
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/no package\.json/);
  });
});

describe("wizard — dirty-file decline notes SDK install (BUG-8)", () => {
  it("states the SDK was already installed and package.json changed on a decline", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps(
      { steps },
      {
        ui,
        buildPlan: vi.fn(() => {
          steps.push("build");
          return {
            recipe: "vite-spa",
            kind: "needs-confirm-dirty",
            targetPath: "/app/src/main.ts",
            content: "// crumbtrail init snippet",
            warnings: [],
          } as Plan;
        }) as unknown as WizardDeps["buildPlan"],
        installSdk: vi.fn(async () => {
          steps.push("install");
          return { installed: true, packages: ["crumbtrail-core"] };
        }),
        // Decline the "prepend into a dirty file?" confirmation.
        prompter: { ...noopPrompter, confirm: async () => false },
      },
    );
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    // The decline path never writes the file.
    expect(steps).not.toContain("execute");
    const out = lines.join("\n");
    expect(out).toContain("crumbtrail-core");
    expect(out).toContain("package.json");
    expect(out).toMatch(/already installed/i);
    expect(out).toMatch(/manual/i);
  });
});

describe("wizard — evidence-source onboarding pointer (BUG-14)", () => {
  it("prints the evidence-source pointer with the dashboard URL after verify", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps }, { ui });
    const code = await runCli(["node", "cli"], deps);
    expect(code).toBe(0);
    const out = lines.join("\n");
    expect(out).toContain("Evidence sources:");
    expect(out).toContain("http://127.0.0.1:9999/settings");
    // Only adapters that actually exist may be named.
    for (const provider of [
      "Sentry",
      "CloudWatch",
      "Splunk",
      "Datadog",
      "PostHog",
      "Cloudflare",
    ]) {
      expect(out).toContain(provider);
    }
  });

  it("does not print the pointer when verification is skipped", async () => {
    const steps: string[] = [];
    const { ui, lines } = captureUi();
    const deps = makeDeps({ steps }, { ui });
    const code = await runCli(["node", "cli", "--skip-verify"], deps);
    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("Evidence sources:");
  });
});

describe("isCliEntrypoint", () => {
  it("matches direct dist invocations and the npm bin symlink name", () => {
    expect(isCliEntrypoint("/x/dist/cli.cjs")).toBe(true);
    expect(isCliEntrypoint("/x/dist/cli.js")).toBe(true);
    expect(isCliEntrypoint("/x/dist/cli.mjs")).toBe(true);
    expect(isCliEntrypoint("/x/src/cli.ts")).toBe(true);
    // npm installs the bin as a symlink named after the bin key; Node does not
    // realpath argv[1], so the bare bin name must match.
    expect(isCliEntrypoint("/y/node_modules/.bin/crumbtrail")).toBe(true);
    expect(isCliEntrypoint("/usr/local/bin/crumbtrail")).toBe(true);
  });

  it("stays inert for test runners and unrelated scripts", () => {
    expect(isCliEntrypoint(undefined)).toBe(false);
    expect(isCliEntrypoint("")).toBe(false);
    expect(isCliEntrypoint("/x/node_modules/vitest/vitest.mjs")).toBe(false);
    expect(isCliEntrypoint("/x/some-other-cli.cjs")).toBe(false);
    expect(isCliEntrypoint("/x/crumbtrail-server")).toBe(false);
  });
});
