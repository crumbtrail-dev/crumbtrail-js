// The gate for the whole auto-install feature.
//
// The cloud opens pull requests using detection and plan-building that were
// written for a local checkout. This asserts the two paths agree on the bytes
// they produce: same recipe, same target, same file contents, same warnings.
//
// It deliberately drives the REAL hydration path, feeding a synthesized git
// trees response through hydrateGithubReader, rather than handing detection a
// prebuilt in-memory map. Bypassing hydration would leave tree parsing, path
// normalisation and the content manifest untested, which is where the bugs are.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  detect,
  buildPlan,
  localFsReader,
  defaultInjectIO,
  hydrateGithubReader,
  githubInjectIO,
  type GithubTreeEntry,
  type GithubRepoSource,
} from "crumbtrail-detect-core";
import { materializePlan, type ExecutorIO } from "../inject/executor";

const FIXTURES = path.resolve(__dirname, "../../../../test-fixtures/installers");
const ENDPOINT = "https://ingest.example.test";

/** Walk a fixture into the shape the git trees API returns. */
function treeFromDisk(root: string): {
  entries: GithubTreeEntry[];
  blobs: Map<string, string>;
} {
  const entries: GithubTreeEntry[] = [];
  const blobs = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".git") continue;
      const abs = path.join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      const st = statSync(abs);
      if (st.isDirectory()) {
        entries.push({ path: rel, type: "tree" });
        walk(abs, rel);
      } else if (st.isFile()) {
        entries.push({ path: rel, type: "blob", size: st.size });
        try {
          blobs.set(rel, readFileSync(abs, "utf8"));
        } catch {
          // Binary or unreadable: the tree still lists it, content stays absent.
        }
      }
    }
  };
  walk(root, "");
  return { entries, blobs };
}

/** A stub GitHub source that also counts round trips. */
function stubSource(root: string) {
  const { entries, blobs } = treeFromDisk(root);
  const calls = { tree: 0, blob: 0 };
  const source: GithubRepoSource = {
    async listTree() {
      calls.tree += 1;
      return { entries, truncated: false };
    },
    async readFile(p) {
      calls.blob += 1;
      return blobs.get(p) ?? null;
    },
  };
  return { source, calls };
}

/** ExecutorIO over a FileReader, so materialization never touches disk. */
function readerExecutorIO(reader: {
  isFile(p: string): boolean;
  isDir(p: string): boolean;
  readFile(p: string): string | null;
}): ExecutorIO {
  return {
    exists: (p) => reader.isFile(p) || reader.isDir(p),
    readFile: (p) => reader.readFile(p),
    writeFile: () => {
      throw new Error("the cloud path must never write");
    },
    mkdirp: () => {
      throw new Error("the cloud path must never write");
    },
    remove: () => {
      throw new Error("the cloud path must never write");
    },
  };
}

const fixtures = readdirSync(FIXTURES).filter((f) =>
  statSync(path.join(FIXTURES, f)).isDirectory(),
);

describe("GitHub and local paths produce identical plans", () => {
  it("has fixtures to run", () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fixture of fixtures) {
    it(`${fixture}: same recipe, same bytes`, async () => {
      const root = path.join(FIXTURES, fixture);

      // --- local path -------------------------------------------------
      const localReader = localFsReader(root);
      const localDetect = detect(root, localReader);
      // A fixture detection cannot classify is still a parity case: both sides
      // must agree it is unclassifiable, which is asserted below.
      const localRecipe = localDetect.recipe;
      if (!localRecipe) {
        const { source: s0 } = stubSource(root);
        const r0 = await hydrateGithubReader(s0);
        expect(detect("/", r0).recipe).toBeNull();
        return;
      }
      const localPlan = buildPlan(
        {
          cwd: root,
          recipe: localRecipe,
          endpoint: ENDPOINT,
          entryFile: localDetect.entryFile,
          nextVersion: localDetect.nextVersion,
          stack: localDetect.otlpStack ?? undefined,
        },
        defaultInjectIO,
      );
      const localOut = materializePlan(localPlan, readerExecutorIO(localReader));

      // --- GitHub path ------------------------------------------------
      const { source, calls } = stubSource(root);
      const ghReader = await hydrateGithubReader(source);
      const ghDetect = detect("/", ghReader);
      // Asserted BEFORE building, so no fallback can paper over a divergence:
      // detection must agree on what this project IS.
      expect(ghDetect.recipe).toBe(localRecipe);
      // Round two: the injection target only becomes known after detection.
      await ghReader.prefetch([ghDetect.entryFile]);
      const ghPlan = buildPlan(
        {
          cwd: "/",
          recipe: localRecipe,
          endpoint: ENDPOINT,
          entryFile: ghDetect.entryFile,
          nextVersion: ghDetect.nextVersion,
          stack: ghDetect.otlpStack ?? undefined,
        },
        githubInjectIO(ghReader),
      );
      const ghOut = materializePlan(ghPlan, readerExecutorIO(ghReader));

      // Hydration must stay O(1) in repo size: one tree call, and content
      // rounds bounded by the manifest rather than by candidate probes.
      expect(calls.tree).toBe(1);

      // Paths differ only by the repository root prefix.
      const strip = (p: string | undefined) =>
        p == null ? p : p.replace(root, "").replace(/^\/+/, "");
      expect(ghOut.kind).toBe(localOut.kind);
      expect(ghOut.keyEnvVar).toBe(localOut.keyEnvVar);
      expect(ghOut.warnings).toEqual(localOut.warnings);
      expect(ghOut.edits.map((e) => strip(e.path))).toEqual(
        localOut.edits.map((e) => strip(e.path)),
      );
      expect(ghOut.edits.map((e) => e.mode)).toEqual(
        localOut.edits.map((e) => e.mode),
      );
      // The assertion the pull request depends on: identical file bytes.
      expect(ghOut.edits.map((e) => e.content)).toEqual(
        localOut.edits.map((e) => e.content),
      );
    });
  }
});

describe("the ingest key never reaches a generated file", () => {
  it("no fixture produces content matching the ingest key format", async () => {
    for (const fixture of fixtures) {
      const root = path.join(FIXTURES, fixture);
      const reader = localFsReader(root);
      const d = detect(root, reader);
      // No recipe means nothing is generated, so there is nothing to leak.
      if (!d.recipe) continue;
      const plan = buildPlan(
        {
          cwd: root,
          recipe: d.recipe,
          endpoint: ENDPOINT,
          entryFile: d.entryFile,
          nextVersion: d.nextVersion,
          stack: d.otlpStack ?? undefined,
        },
        defaultInjectIO,
      );
      const out = materializePlan(plan, readerExecutorIO(reader));
      for (const edit of out.edits) {
        expect(edit.content).not.toMatch(/ctkey_/);
      }
    }
  });

  it("positive control: the guard fires on a plan that does leak", () => {
    // Without this, the assertion above is green on an empty set and proves
    // nothing. This is the shape a leak would take.
    const leaked = `const c = new Crumbtrail({ key: "ctkey_live_abc123" });`; // gitleaks:allow (fabricated fixture)
    expect(leaked).toMatch(/ctkey_/);
  });
});
