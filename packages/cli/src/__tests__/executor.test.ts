import { afterEach, describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { executePlan } from "../inject/executor";
import { buildPlan } from "../inject/recipes";
import { defaultInjectIO } from "../inject/io";
import type { Plan } from "../inject/types";
import { cleanup, gitInit, makeTmpRepo, memExecutorIO } from "./helpers";

const ENDPOINT = "https://ingest.example.com";

describe("executePlan — golden create/prepend on a real repo", () => {
  const roots: string[] = [];
  afterEach(() => {
    while (roots.length) cleanup(roots.pop()!);
  });
  const tmp = (files: Record<string, string>, git = true) => {
    const r = makeTmpRepo(files);
    if (git) gitInit(r);
    roots.push(r);
    return r;
  };

  it("creates a SvelteKit hooks.client.ts and is then idempotent on re-run", () => {
    const root = tmp({ "package.json": "{}", "src/app.d.ts": "" });
    const plan = buildPlan(
      { cwd: root, recipe: "sveltekit", endpoint: ENDPOINT },
      defaultInjectIO,
    );
    expect(plan.kind).toBe("create");
    const res = executePlan(plan);
    expect(res.written).toEqual([path.join(root, "src", "hooks.client.ts")]);
    const written = readFileSync(
      path.join(root, "src", "hooks.client.ts"),
      "utf8",
    );
    // Hands-off: the written file reads the key from the Vite env var, never a
    // baked-in literal.
    expect(written).toContain(
      "httpAuthToken: import.meta.env.VITE_CRUMBTRAIL_KEY",
    );
    expect(written).not.toMatch(/ctkey_|bgk_|bl_ingest_/);
    expect(written.endsWith("\n")).toBe(true);

    // Re-detect after writing the file -> target now references crumbtrail -> skip.
    const second = buildPlan(
      { cwd: root, recipe: "sveltekit", endpoint: ENDPOINT },
      defaultInjectIO,
    );
    expect(second.kind).toBe("skip-already-wired");
    expect(executePlan(second).skipped).toBe(true);
  });

  it("prepends into a committed Node entry after its shebang", () => {
    const root = tmp({
      "package.json": JSON.stringify({ main: "server.js" }),
      "server.js": "#!/usr/bin/env node\nconst app = start();\n",
    });
    const plan = buildPlan(
      {
        cwd: root,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: path.join(root, "server.js"),
      },
      defaultInjectIO,
    );
    expect(plan.kind).toBe("prepend");
    executePlan(plan);
    const out = readFileSync(path.join(root, "server.js"), "utf8");
    expect(out.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(out).toContain('import("crumbtrail-node")');
    expect(out).toContain("process.env.CRUMBTRAIL_KEY");
    expect(out.indexOf("crumbtrail-node")).toBeLessThan(
      out.indexOf("const app"),
    );
    // Hands-off: the installer writes NOTHING to .env — the user sets the key.
    expect(existsSync(path.join(root, ".env"))).toBe(false);
  });

  it("refuses to touch a dirty target until confirmed", () => {
    const root = tmp({
      "package.json": JSON.stringify({ main: "server.js" }),
      "server.js": "const app = start();\n",
    });
    // Make the entry dirty (uncommitted change).
    makeTmpRepoDirty(root, "server.js", "const app = start(); // edited\n");
    const plan = buildPlan(
      {
        cwd: root,
        recipe: "node",
        endpoint: ENDPOINT,
        entryFile: path.join(root, "server.js"),
      },
      defaultInjectIO,
    );
    expect(plan.kind).toBe("needs-confirm-dirty");

    const before = readFileSync(path.join(root, "server.js"), "utf8");
    const res = executePlan(plan);
    expect(res.skipped).toBe(true);
    expect(readFileSync(path.join(root, "server.js"), "utf8")).toBe(before);

    // Confirming applies the prepend.
    const applied = executePlan(plan, undefined, { confirmDirty: true });
    expect(applied.written).toContain(path.join(root, "server.js"));
    expect(readFileSync(path.join(root, "server.js"), "utf8")).toContain(
      "crumbtrail-node",
    );
  });
});

describe("executePlan — non-writing plans", () => {
  it("skip-already-wired writes nothing", () => {
    const plan: Plan = {
      recipe: "next",
      kind: "skip-already-wired",
      targetPath: null,
      content: null,
      warnings: [],
    };
    const { io, files } = memExecutorIO();
    const res = executePlan(plan, io);
    expect(res.skipped).toBe(true);
    expect(Object.keys(files)).toHaveLength(0);
  });

  it("fallback-ai writes nothing", () => {
    const plan: Plan = {
      recipe: "vite-spa",
      kind: "fallback-ai",
      targetPath: null,
      content: null,
      warnings: [],
      snippet: "snippet",
      agentPrompt: "prompt",
    };
    const { io, files } = memExecutorIO();
    expect(executePlan(plan, io).skipped).toBe(true);
    expect(Object.keys(files)).toHaveLength(0);
  });

  it("otlp-guidance writes nothing", () => {
    const plan: Plan = {
      recipe: "otlp",
      kind: "otlp-guidance",
      targetPath: null,
      content: null,
      warnings: [],
      snippet: "OTEL_EXPORTER_OTLP_ENDPOINT=https://x",
      agentPrompt: "prompt",
    };
    const { io, files } = memExecutorIO();
    const res = executePlan(plan, io);
    expect(res.skipped).toBe(true);
    expect(res.written).toEqual([]);
    expect(Object.keys(files)).toHaveLength(0);
  });
});

describe("executePlan — all-or-nothing rollback", () => {
  // The installer is hands-off: a plan now produces exactly ONE file op (no more
  // paired .env write), so rollback is exercised on that single create op. When
  // the write throws, a brand-new file must not be left behind.
  it("leaves no partial file when the create write fails", () => {
    const target = "/proj/instrumentation-client.ts";
    const plan: Plan = {
      recipe: "next",
      kind: "create",
      targetPath: target,
      content: 'import "crumbtrail-core";\n',
      warnings: [],
    };
    // Fail on the create write — the (never-existed) file must be rolled back.
    const { io, files } = memExecutorIO({}, target);
    expect(() => executePlan(plan, io)).toThrow(/boom/);
    expect(files[target]).toBeUndefined(); // rolled back (never existed)
  });
});

// Helper: write a new file body without committing, so git sees it dirty.
import { writeFileSync } from "node:fs";
function makeTmpRepoDirty(root: string, rel: string, content: string): void {
  writeFileSync(path.join(root, rel), content);
  // sanity: the file exists and differs from HEAD
  expect(existsSync(path.join(root, rel))).toBe(true);
}
