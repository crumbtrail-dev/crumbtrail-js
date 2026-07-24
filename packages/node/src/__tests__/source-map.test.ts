import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  directorySourceMapLookup,
  normalizeSourcePath,
  parseFrame,
  parseSourceMap,
  resolveFrame,
  resolveGeneratedPosition,
} from "../source-map";
import { writeEvidenceIndex } from "../evidence-index";

// Real esbuild output, not a hand written map: a hand written `mappings` string
// tends to encode the same assumptions as the decoder under test, so it can
// pass while disagreeing with every bundler in use.
//
// Source (board.ts):
//   1 export function renderBoard(items: string[]): number {
//   2   const total = items.length;
//   3   if (total === 0) {
//   4     throw new Error("render failed");
//   5   }
//   6   return total;
//   7 }
//
// Minified to one line; `throw` sits at column 45 and `e.length` at column 27.
const BUNDLE_MAP = JSON.stringify({
  version: 3,
  sources: ["board.ts"],
  mappings:
    "MAAO,SAASA,EAAYC,EAAyB,CACnD,IAAMC,EAAQD,EAAM,OACpB,GAAIC,IAAU,EACZ,MAAM,IAAI,MAAM,eAAe,EAEjC,OAAOA,CACT",
  names: ["renderBoard", "items", "total"],
});

describe("source map resolution", () => {
  it("resolves a minified column to the original line and column", () => {
    const map = parseSourceMap(BUNDLE_MAP)!;
    expect(map).toBeDefined();
    // The throw is on original line 4, indented four spaces, so column 5.
    expect(resolveGeneratedPosition(map, 1, 45)).toEqual({
      source: "board.ts",
      line: 4,
      column: 5,
    });
  });

  it("resolves a different column on the same generated line", () => {
    // Everything is on one generated line after minification, so distinct
    // columns MUST resolve to distinct original lines or the segment lookup is
    // silently returning the first mapping every time.
    const map = parseSourceMap(BUNDLE_MAP)!;
    expect(resolveGeneratedPosition(map, 1, 27)?.line).toBe(2);
  });

  it("resolves a whole frame string against a lookup", () => {
    expect(
      resolveFrame(
        "https://app.example.test/assets/board.min.js:1:45",
        () => BUNDLE_MAP,
      ),
    ).toBe("board.ts:4:5");
  });

  it("returns undefined rather than guessing when the map is unusable", () => {
    const frame = "https://app.example.test/assets/board.min.js:1:45";
    // No map for the file.
    expect(resolveFrame(frame, () => undefined)).toBeUndefined();
    // Corrupt JSON.
    expect(resolveFrame(frame, () => "{not json")).toBeUndefined();
    // Wrong version.
    expect(
      resolveFrame(frame, () => JSON.stringify({ version: 2, mappings: "" })),
    ).toBeUndefined();
    // Index maps compose several maps; resolving one is not implemented.
    expect(
      resolveFrame(frame, () =>
        JSON.stringify({ version: 3, sections: [], mappings: "" }),
      ),
    ).toBeUndefined();
    // A generated line the map does not cover.
    expect(
      resolveFrame(
        "https://app.example.test/assets/board.min.js:99:1",
        () => BUNDLE_MAP,
      ),
    ).toBeUndefined();
  });

  it("rejects a frame that carries no position", () => {
    expect(
      parseFrame("https://app.example.test/assets/board.min.js"),
    ).toBeUndefined();
    // A file half may legitimately contain colons, so the numbers are taken
    // from the end rather than by splitting on the first colon.
    expect(parseFrame("https://app.example.test/a.js:12:3")).toEqual({
      file: "https://app.example.test/a.js",
      line: 12,
      column: 3,
    });
    expect(parseFrame("C:\\build\\app.js:9:4")).toEqual({
      file: "C:\\build\\app.js",
      line: 9,
      column: 4,
    });
  });

  it("strips bundler prefixes that make a source path unopenable", () => {
    expect(normalizeSourcePath("webpack://_N_E/./src/app.tsx")).toBe(
      "src/app.tsx",
    );
    expect(normalizeSourcePath("webpack:///./src/app.tsx")).toBe("src/app.tsx");
    expect(normalizeSourcePath("./src/app.tsx")).toBe("src/app.tsx");
    expect(normalizeSourcePath("src/app.tsx", "/base")).toBe(
      "/base/src/app.tsx",
    );
  });

  it("caches a parsed map across frames from the same file", () => {
    const cache = new Map();
    let reads = 0;
    const lookup = () => {
      reads += 1;
      return BUNDLE_MAP;
    };
    const frame = "https://app.example.test/assets/board.min.js:1:45";
    resolveFrame(frame, lookup, cache);
    resolveFrame(frame, lookup, cache);
    expect(reads).toBe(1);
  });

  it("caches a MISS so a missing map is not re-read per frame", () => {
    const cache = new Map();
    let reads = 0;
    const lookup = () => {
      reads += 1;
      return undefined;
    };
    const frame = "https://app.example.test/assets/board.min.js:1:45";
    resolveFrame(frame, lookup, cache);
    resolveFrame(frame, lookup, cache);
    expect(reads).toBe(1);
  });
});

describe("directorySourceMapLookup", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-sourcemap-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("finds a map by the frame's basename", () => {
    fs.writeFileSync(path.join(dir, "board.min.js.map"), BUNDLE_MAP);
    const lookup = directorySourceMapLookup(dir);
    expect(
      resolveFrame("https://app.example.test/assets/board.min.js:1:45", lookup),
    ).toBe("board.ts:4:5");
  });

  it("refuses to read outside the directory", () => {
    // Only the basename is used, so a traversal attempt resolves to a name
    // inside the directory and simply misses.
    const outside = path.join(dir, "..", "escaped.js.map");
    fs.writeFileSync(outside, BUNDLE_MAP);
    try {
      const lookup = directorySourceMapLookup(dir);
      expect(lookup("../escaped.js")).toBeUndefined();
      expect(
        lookup("https://app.example.test/a/../../escaped.js"),
      ).toBeUndefined();
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });

  it("returns undefined when no map sits beside the bundle", () => {
    const lookup = directorySourceMapLookup(dir);
    expect(
      lookup("https://app.example.test/assets/board.min.js"),
    ).toBeUndefined();
  });
});

describe("writeEvidenceIndex — source map resolution", () => {
  let sessionDir: string;
  let mapDir: string;
  let previous: string | undefined;

  beforeEach(() => {
    sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-sm-ses-"));
    mapDir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbtrail-sm-dist-"));
    fs.writeFileSync(path.join(mapDir, "board.min.js.map"), BUNDLE_MAP);
    previous = process.env.CRUMBTRAIL_SOURCEMAP_DIR;
  });

  afterEach(() => {
    if (previous === undefined) delete process.env.CRUMBTRAIL_SOURCEMAP_DIR;
    else process.env.CRUMBTRAIL_SOURCEMAP_DIR = previous;
    fs.rmSync(sessionDir, { recursive: true, force: true });
    fs.rmSync(mapDir, { recursive: true, force: true });
  });

  const errorEvents = [
    {
      t: 1000,
      k: "err",
      d: {
        msg: "render failed",
        file: "https://app.example.test/assets/board.min.js",
        line: 1,
        col: 45,
      },
    },
  ];
  const errorIndex = {
    start: 1000,
    errs: [
      {
        t: 1000,
        msg: "render failed",
        file: "https://app.example.test/assets/board.min.js",
        line: 1,
        col: 45,
      },
    ],
  };

  it("rewrites a minified frame and keeps the generated one", async () => {
    process.env.CRUMBTRAIL_SOURCEMAP_DIR = mapDir;
    const candidates = await writeEvidenceIndex({
      sessionDir,
      events: errorEvents as never,
      index: errorIndex as never,
      causalGraph: undefined,
    });
    const candidate = candidates.find((c) => c.detector === "uncaught_error");
    expect(candidate?.anchor.frame).toBe("board.ts:4:5");
    expect(candidate?.anchor.minifiedFrame).toBe(
      "https://app.example.test/assets/board.min.js:1:45",
    );
  });

  it("leaves the frame untouched when resolution is not configured", async () => {
    delete process.env.CRUMBTRAIL_SOURCEMAP_DIR;
    const candidates = await writeEvidenceIndex({
      sessionDir,
      events: errorEvents as never,
      index: errorIndex as never,
      causalGraph: undefined,
    });
    const candidate = candidates.find((c) => c.detector === "uncaught_error");
    expect(candidate?.anchor.frame).toBe(
      "https://app.example.test/assets/board.min.js:1:45",
    );
    expect(candidate?.anchor.minifiedFrame).toBeUndefined();
  });

  it("leaves the frame untouched when no map covers the bundle", async () => {
    // A wrong location is worse than an admittedly minified one, so a missing
    // map must never produce a partially resolved frame.
    process.env.CRUMBTRAIL_SOURCEMAP_DIR = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-sm-empty-"),
    );
    const candidates = await writeEvidenceIndex({
      sessionDir,
      events: errorEvents as never,
      index: errorIndex as never,
      causalGraph: undefined,
    });
    const candidate = candidates.find((c) => c.detector === "uncaught_error");
    expect(candidate?.anchor.frame).toBe(
      "https://app.example.test/assets/board.min.js:1:45",
    );
    expect(candidate?.anchor.minifiedFrame).toBeUndefined();
  });

  it("writes the resolved frame into the candidate artifact", async () => {
    // The in-memory return value is not what a reader or the MCP consumes.
    process.env.CRUMBTRAIL_SOURCEMAP_DIR = mapDir;
    await writeEvidenceIndex({
      sessionDir,
      events: errorEvents as never,
      index: errorIndex as never,
      causalGraph: undefined,
    });
    const written = fs.readFileSync(
      path.join(sessionDir, "candidates.jsonl"),
      "utf-8",
    );
    expect(written).toContain("board.ts:4:5");
  });
});
