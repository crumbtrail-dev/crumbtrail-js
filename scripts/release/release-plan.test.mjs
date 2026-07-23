import { describe, expect, it } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createReleasePlan,
  discoverPackages,
  packageExistsOnNpm,
  preflightAndPublish,
  preflightNpmVersions,
  selectReleasePackages,
  validateBaseRef,
} from "./release-plan.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function pkg(name, { privatePackage = false, dependencies, devDependencies, tsupConfig = "" } = {}) {
  return {
    name,
    version: "1.0.0",
    private: privatePackage,
    relativeDir: `packages/${name.replace("crumbtrail-", "")}`,
    manifest: { dependencies, devDependencies },
    tsupConfig,
  };
}

describe("release package selection", () => {
  it("selects changed public packages and bundled public dependents", () => {
    const core = pkg("crumbtrail-core");
    const node = pkg("crumbtrail-node", {
      dependencies: { "crumbtrail-core": "workspace:^" },
      tsupConfig: '// noExternal: ["not-a-real-dependency"]\nexport default { noExternal: ["crumbtrail-core"] }',
    });
    const reactNative = pkg("crumbtrail-react-native", {
      dependencies: { "crumbtrail-core": "workspace:^" },
      tsupConfig: 'export default { external: ["crumbtrail-core"] }',
    });
    expect(selectReleasePackages({ packages: [core, node, reactNative], changedFiles: ["packages/core/src/index.ts"] }).map((entry) => entry.name))
      .toEqual(["crumbtrail-core", "crumbtrail-node"]);
  });

  it("never selects private packages even when their files change", () => {
    const privateHarness = pkg("crumbtrail-topology-harness", { privatePackage: true });
    expect(selectReleasePackages({ packages: [privateHarness], changedFiles: ["packages/topology-harness/src/index.ts"] })).toEqual([]);
  });

  it("does not treat noExternal examples in comments as bundled dependencies", () => {
    const core = pkg("crumbtrail-core");
    const cli = pkg("crumbtrail", {
      devDependencies: { "crumbtrail-core": "workspace:^" },
      tsupConfig: '// noExternal: ["crumbtrail-core"]\nexport default { noExternal: ["crumbtrail-install-shared"] }',
    });
    expect(selectReleasePackages({ packages: [core, cli], changedFiles: ["packages/core/src/index.ts"] }).map((entry) => entry.name))
      .toEqual(["crumbtrail-core"]);
  });

  it("includes external workspace consumers when a dependency version changes their packed manifest", () => {
    const core = pkg("crumbtrail-core");
    const reactNative = pkg("crumbtrail-react-native", { dependencies: { "crumbtrail-core": "workspace:^" } });
    expect(selectReleasePackages({
      packages: [core, reactNative],
      changedFiles: ["packages/core/package.json"],
      versionChangedPackageNames: ["crumbtrail-core"],
    }).map((entry) => entry.name)).toEqual(["crumbtrail-core", "crumbtrail-react-native"]);
  });

  it("does not select every public package for root-only workspace metadata changes", async () => {
    const packages = await discoverPackages(repositoryRoot);
    expect(selectReleasePackages({
      packages,
      changedFiles: ["package.json", "pnpm-lock.yaml", "tsconfig.json"],
    })).toEqual([]);
  });

  it("selects exactly the four planned CP1-CP3 packages alongside root release metadata", async () => {
    const plan = await createReleasePlan({
      rootDir: repositoryRoot,
      baseRef: "HEAD",
      changedFiles: [
        "package.json",
        "pnpm-lock.yaml",
        "tsconfig.json",
        "packages/core/package.json",
        "packages/node/package.json",
        "packages/detect-core/package.json",
        "packages/cli/package.json",
      ],
    });
    expect(plan.packages.map((entry) => entry.name)).toEqual([
      "crumbtrail",
      "crumbtrail-core",
      "crumbtrail-detect-core",
      "crumbtrail-node",
    ]);
  });

  it("rejects option-like and invalid base refs before Git receives them", () => {
    expect(() => validateBaseRef("--upload-pack=evil")).toThrow("Invalid base ref");
    expect(() => validateBaseRef("main...other")).toThrow("Invalid base ref");
  });
});

describe("npm collision preflight", () => {
  it("recognizes npm's not-found response as available", async () => {
    const exists = await packageExistsOnNpm("crumbtrail-core", "99.0.0", {
      exec: async () => {
        const error = new Error("not found");
        error.code = 1;
        error.stderr = "npm error code E404\nnpm error 404 Not Found";
        throw error;
      },
    });
    expect(exists).toBe(false);
  });

  it("recognizes an existing selected version as a collision", async () => {
    const exists = await packageExistsOnNpm("crumbtrail-core", "1.0.0", { exec: async () => ({ stdout: '"1.0.0"' }) });
    expect(exists).toBe(true);
  });

  it("fails the release before publish when any selected version exists", async () => {
    await expect(preflightNpmVersions([{ name: "crumbtrail-core", version: "1.0.0" }], {
      exec: async () => ({ stdout: '"1.0.0"' }),
    })).rejects.toThrow("crumbtrail-core@1.0.0");
  });

  it("runs collision preflight before the first publish", async () => {
    const calls = [];
    await expect(preflightAndPublish([{ name: "crumbtrail-core", version: "1.0.0" }], {
      preflight: async () => {
        calls.push("preflight");
        throw new Error("collision");
      },
      publish: async () => calls.push("publish"),
    })).rejects.toThrow("collision");
    expect(calls).toEqual(["preflight"]);
  });
});
