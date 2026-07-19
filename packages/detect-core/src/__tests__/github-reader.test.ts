// Direct tests for the GitHub-backed reader.
//
// The fixture parity gate does not reach these: none of the installer fixtures
// is a monorepo, so readDir and the workspace glob rounds go unexercised there.
// A mutation that made readDir always return an empty array left that suite
// entirely green, which is why these exist.

import { describe, expect, it } from "vitest";
import {
  hydrateGithubReader,
  githubInjectIO,
  UnhydratedPathError,
  type GithubRepoSource,
  type GithubTreeEntry,
} from "../readers/github";

function source(
  files: Record<string, string>,
  dirs: string[] = [],
  truncated = false,
) {
  const entries: GithubTreeEntry[] = [
    ...dirs.map((path) => ({ path, type: "tree" as const })),
    ...Object.keys(files).map((path) => ({ path, type: "blob" as const })),
  ];
  const calls = { tree: 0, blob: 0, paths: [] as string[] };
  const src: GithubRepoSource = {
    async listTree() {
      calls.tree += 1;
      return { entries, truncated };
    },
    async readFile(p) {
      calls.blob += 1;
      calls.paths.push(p);
      return files[p] ?? null;
    },
  };
  return { src, calls };
}

describe("hydrateGithubReader", () => {
  it("answers isFile, isDir and readDir from one tree call", async () => {
    const { src, calls } = source(
      {
        "package.json": "{}",
        "src/main.ts": "x",
        "src/lib/util.ts": "y",
      },
      ["src", "src/lib"],
    );
    const r = await hydrateGithubReader(src);

    expect(calls.tree).toBe(1);
    expect(r.isFile("/src/main.ts")).toBe(true);
    expect(r.isFile("/src")).toBe(false);
    expect(r.isDir("/src")).toBe(true);
    expect(r.isDir("/src/lib")).toBe(true);
    expect(r.isDir("/nope")).toBe(false);
    expect(r.readDir("/src").sort()).toEqual(["lib", "main.ts"]);
    expect(r.readDir("/").sort()).toEqual(["package.json", "src"]);
    expect(r.readDir("/nope")).toEqual([]);
  });

  it("derives ancestor directories the tree never listed", async () => {
    // The truncated fallback yields blobs without their parent tree entries.
    const { src } = source({ "a/b/c/file.ts": "x" }, []);
    const r = await hydrateGithubReader(src);
    expect(r.isDir("/a")).toBe(true);
    expect(r.isDir("/a/b")).toBe(true);
    expect(r.readDir("/a")).toEqual(["b"]);
  });

  it("excludes node_modules from the snapshot", async () => {
    const { src } = source(
      { "package.json": "{}", "node_modules/next/package.json": "{}" },
      ["node_modules", "node_modules/next"],
    );
    const r = await hydrateGithubReader(src);
    expect(r.isDir("/node_modules")).toBe(false);
    expect(r.isFile("/node_modules/next/package.json")).toBe(false);
    expect(r.readDir("/")).toEqual(["package.json"]);
  });

  it("never requests content for a path the tree says is absent", async () => {
    const { src, calls } = source({ "package.json": "{}" });
    await hydrateGithubReader(src);
    // The manifest lists a dozen paths; only the one that exists is fetched.
    expect(calls.paths).toEqual(["package.json"]);
  });

  it("hydrates workspace member manifests in a second round", async () => {
    const { src, calls } = source(
      {
        "package.json": JSON.stringify({ workspaces: ["packages/*"] }),
        "packages/app/package.json": '{"name":"app"}',
        "packages/lib/package.json": '{"name":"lib"}',
      },
      ["packages", "packages/app", "packages/lib"],
    );
    const r = await hydrateGithubReader(src);
    expect(r.readFile("/packages/app/package.json")).toBe('{"name":"app"}');
    expect(r.readFile("/packages/lib/package.json")).toBe('{"name":"lib"}');
    expect(calls.tree).toBe(1);
  });

  it("reads pnpm workspace globs too", async () => {
    const { src } = source(
      {
        "package.json": "{}",
        "pnpm-workspace.yaml": 'packages:\n  - "apps/*"\n',
        "apps/web/package.json": '{"name":"web"}',
      },
      ["apps", "apps/web"],
    );
    const r = await hydrateGithubReader(src);
    expect(r.readFile("/apps/web/package.json")).toBe('{"name":"web"}');
  });

  it("returns null for a file the repository does not have", async () => {
    const { src } = source({ "package.json": "{}" });
    const r = await hydrateGithubReader(src);
    expect(r.readFile("/nope.ts")).toBeNull();
  });

  it("throws UnhydratedPathError for a present but unfetched file", async () => {
    // This is the N+1 guard: the file exists, so a null would be a lie.
    const { src } = source({ "package.json": "{}", "src/deep.ts": "x" }, [
      "src",
    ]);
    const r = await hydrateGithubReader(src);
    expect(() => r.readFile("/src/deep.ts")).toThrow(UnhydratedPathError);
  });

  it("prefetch makes a previously unhydrated file readable", async () => {
    const { src } = source({ "package.json": "{}", "src/deep.ts": "body" }, [
      "src",
    ]);
    const r = await hydrateGithubReader(src);
    await r.prefetch(["/src/deep.ts", null, undefined]);
    expect(r.readFile("/src/deep.ts")).toBe("body");
  });
});

describe("githubInjectIO", () => {
  it("reports every target as clean, so needs-confirm-dirty is unreachable", async () => {
    // An API read has no working tree. This must never fall through to the
    // filesystem implementation, which would inspect the SERVER's disk.
    const { src } = source({ "package.json": "{}" });
    const io = githubInjectIO(await hydrateGithubReader(src));
    expect(io.gitStatus()).toEqual({
      isRepo: true,
      tracked: true,
      dirty: false,
    });
  });

  it("exists covers both files and directories", async () => {
    const { src } = source({ "package.json": "{}", "src/a.ts": "x" }, ["src"]);
    const io = githubInjectIO(await hydrateGithubReader(src));
    expect(io.exists("/package.json")).toBe(true);
    expect(io.exists("/src")).toBe(true);
    expect(io.exists("/missing")).toBe(false);
  });
});
