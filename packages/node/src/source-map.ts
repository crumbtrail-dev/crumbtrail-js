// Source map resolution — turn a minified frame into the file a person edits.
//
// `anchor.frame` carries whatever location the runtime reported. On a
// production build that is a bundler chunk: `/_next/static/chunks/4526-abc.js
// :1:24891`. The evidence completeness panel counts that as a captured code
// location, which is technically true and practically useless — it names a file
// nobody wrote and a line that does not exist in the repository.
//
// This module resolves such a frame back to its original source through the
// build's `.map` file. It is deliberately self contained: `crumbtrail-node` is
// a published package with three dependencies, and the mappings grammar is
// small and stable enough that carrying a decoder costs less than carrying a
// dependency for every consumer that installs the server.
//
// Scope: this resolves a frame against a map the caller can already produce.
// Obtaining maps for a HOSTED session is a separate problem — a production
// build commonly strips `sourceMappingURL` and serves no `.map` at all (the
// Sentry Next.js plugin does exactly this), so maps have to be uploaded at
// build time rather than fetched after the fact. See CRUMB-134.

import fs from "node:fs";
import path from "node:path";

/** Base64 alphabet, in the order the VLQ digits are indexed. */
const BASE64 =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_INDEX = new Map<string, number>(
  [...BASE64].map((char, index) => [char, index]),
);

/** A decoded mapping segment. All columns are zero based, as in the map. */
interface Segment {
  generatedColumn: number;
  sourceIndex?: number;
  sourceLine?: number;
  sourceColumn?: number;
}

export interface RawSourceMap {
  version?: number;
  file?: string;
  sourceRoot?: string;
  sources?: Array<string | null>;
  names?: string[];
  mappings?: string;
  /** Present on an index map. Not supported; see parseSourceMap. */
  sections?: unknown[];
}

export interface ResolvedLocation {
  /** Original source path, normalized. */
  source: string;
  /** One based, matching the convention stack frames use. */
  line: number;
  /** One based. */
  column: number;
}

/**
 * Decodes one base64 VLQ run starting at `cursor.at`, advancing the cursor.
 * Returns undefined when the input is malformed, so a corrupt map degrades to
 * "unresolved" instead of throwing inside finalization.
 */
function decodeVlq(value: string, cursor: { at: number }): number | undefined {
  let result = 0;
  let shift = 0;
  let continuation = true;

  while (continuation) {
    if (cursor.at >= value.length) return undefined;
    const digit = BASE64_INDEX.get(value[cursor.at]);
    if (digit === undefined) return undefined;
    cursor.at += 1;
    continuation = (digit & 32) !== 0;
    result += (digit & 31) * 2 ** shift;
    shift += 5;
  }

  // The least significant bit of the assembled value is the sign, not part of
  // the magnitude. Negative zero is a legal encoding and means zero.
  const negative = (result & 1) === 1;
  const magnitude = Math.floor(result / 2);
  return negative ? -magnitude : magnitude;
}

/**
 * Decodes the `mappings` string into per generated line segment lists.
 *
 * Only `generatedColumn` resets each line; the source index, source line and
 * source column deltas accumulate across the whole string, which is why they
 * are tracked outside the line loop.
 */
function decodeMappings(mappings: string): Segment[][] {
  const lines: Segment[][] = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceColumn = 0;

  for (const rawLine of mappings.split(";")) {
    const segments: Segment[] = [];
    let generatedColumn = 0;

    for (const rawSegment of rawLine.split(",")) {
      if (rawSegment.length === 0) continue;
      const cursor = { at: 0 };

      const generatedColumnDelta = decodeVlq(rawSegment, cursor);
      if (generatedColumnDelta === undefined) continue;
      generatedColumn += generatedColumnDelta;

      // A one field segment marks generated code with no original source.
      if (cursor.at >= rawSegment.length) {
        segments.push({ generatedColumn });
        continue;
      }

      const sourceIndexDelta = decodeVlq(rawSegment, cursor);
      const sourceLineDelta = decodeVlq(rawSegment, cursor);
      const sourceColumnDelta = decodeVlq(rawSegment, cursor);
      if (
        sourceIndexDelta === undefined ||
        sourceLineDelta === undefined ||
        sourceColumnDelta === undefined
      ) {
        segments.push({ generatedColumn });
        continue;
      }

      sourceIndex += sourceIndexDelta;
      sourceLine += sourceLineDelta;
      sourceColumn += sourceColumnDelta;
      segments.push({
        generatedColumn,
        sourceIndex,
        sourceLine,
        sourceColumn,
      });
    }

    segments.sort((a, b) => a.generatedColumn - b.generatedColumn);
    lines.push(segments);
  }

  return lines;
}

export interface SourceMap {
  sources: string[];
  lines: Segment[][];
}

/**
 * Normalizes the bundler prefixes that make a source path unopenable.
 * `webpack://_N_E/./src/app.tsx` and `webpack:///./src/app.tsx` both name
 * `src/app.tsx`; leaving the scheme on sends a reader looking for a file that
 * does not exist at that path.
 */
export function normalizeSourcePath(
  source: string,
  sourceRoot?: string,
): string {
  let value = source;
  if (sourceRoot && !/^(?:[a-z]+:)?\/\//i.test(value)) {
    value = `${sourceRoot.replace(/\/$/, "")}/${value.replace(/^\//, "")}`;
  }
  value = value.replace(/^webpack:\/\/\/?/, "");
  // Drop a webpack namespace segment ("_N_E", an app name) when one is present.
  value = value.replace(/^[^/]*\/(?=\.{0,2}\/)/, "");
  value = value.replace(/^\.\//, "");
  return value;
}

/**
 * Parses a raw `.map` payload. Returns undefined for anything this decoder
 * cannot honestly resolve — a wrong version, an index map (`sections`), or
 * absent mappings — rather than guessing at a location.
 */
export function parseSourceMap(raw: string): SourceMap | undefined {
  let parsed: RawSourceMap;
  try {
    parsed = JSON.parse(raw) as RawSourceMap;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  if (parsed.version !== undefined && parsed.version !== 3) return undefined;
  // Index maps compose several maps by generated offset. Resolving one means
  // implementing that composition; reporting unresolved is the honest result.
  if (Array.isArray(parsed.sections)) return undefined;
  if (typeof parsed.mappings !== "string") return undefined;

  const sources = (parsed.sources ?? []).map((source) =>
    typeof source === "string"
      ? normalizeSourcePath(source, parsed.sourceRoot)
      : "",
  );

  return { sources, lines: decodeMappings(parsed.mappings) };
}

/**
 * Resolves a generated position to its original location.
 *
 * `line` and `column` are one based, matching how a stack frame reports them;
 * the map stores both zero based, so both are converted on the way in and the
 * result is converted back on the way out.
 *
 * Picks the last segment whose generated column is at or before the requested
 * column — the standard "greatest lower bound" lookup, since a segment covers
 * everything up to the next one.
 */
export function resolveGeneratedPosition(
  map: SourceMap,
  line: number,
  column: number,
): ResolvedLocation | undefined {
  const segments = map.lines[line - 1];
  if (!segments || segments.length === 0) return undefined;

  const target = column - 1;
  let match: Segment | undefined;
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (segments[mid].generatedColumn <= target) {
      match = segments[mid];
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  // A column before the first segment still belongs to this generated line, so
  // fall back to its first mapping rather than reporting nothing.
  const segment = match ?? segments[0];
  if (
    segment.sourceIndex === undefined ||
    segment.sourceLine === undefined ||
    segment.sourceColumn === undefined
  ) {
    return undefined;
  }

  const source = map.sources[segment.sourceIndex];
  if (!source) return undefined;

  return {
    source,
    line: segment.sourceLine + 1,
    column: segment.sourceColumn + 1,
  };
}

/**
 * Splits a `file:line:col` frame. The file half may itself contain colons (a
 * URL scheme, a Windows drive), so the two trailing numbers are taken from the
 * end rather than by splitting on the first colon.
 */
export function parseFrame(
  frame: string,
): { file: string; line: number; column: number } | undefined {
  const match = /^(.*):(\d+):(\d+)$/.exec(frame.trim());
  if (!match) return undefined;
  const line = Number(match[2]);
  const column = Number(match[3]);
  if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column)) {
    return undefined;
  }
  return { file: match[1], line, column };
}

/** Supplies the raw `.map` payload for a generated file, or undefined. */
export type SourceMapLookup = (file: string) => string | undefined;

/**
 * Resolves a whole frame string, or undefined when it cannot be resolved for
 * any reason: unparseable frame, no map for the file, corrupt map, or a
 * position the map does not cover. Every one of those must leave the original
 * frame in place, because a reader trusting a wrong file:line is worse off than
 * one told the location is minified.
 */
export function resolveFrame(
  frame: string,
  lookup: SourceMapLookup,
  cache?: Map<string, SourceMap | undefined>,
): string | undefined {
  const parsed = parseFrame(frame);
  if (!parsed) return undefined;

  let map: SourceMap | undefined;
  if (cache?.has(parsed.file)) {
    map = cache.get(parsed.file);
  } else {
    const raw = lookup(parsed.file);
    map = raw === undefined ? undefined : parseSourceMap(raw);
    cache?.set(parsed.file, map);
  }
  if (!map) return undefined;

  const location = resolveGeneratedPosition(map, parsed.line, parsed.column);
  if (!location) return undefined;
  return `${location.source}:${location.line}:${location.column}`;
}

/**
 * A lookup backed by a directory of build output. The frame's file is reduced
 * to its basename and matched against `<basename>.map` inside `dir`, which is
 * how every bundler in common use emits them.
 *
 * Path traversal is not possible: only the basename is used, and the resolved
 * path is confirmed to sit inside `dir` before it is read.
 */
export function directorySourceMapLookup(dir: string): SourceMapLookup {
  const root = path.resolve(dir);
  return (file) => {
    let name: string;
    try {
      // A frame file is usually a URL; fall back to treating it as a path.
      name = path.basename(new URL(file).pathname);
    } catch {
      name = path.basename(file);
    }
    if (!name || name === "." || name === "..") return undefined;

    const candidate = path.resolve(root, `${name}.map`);
    if (candidate !== root && !candidate.startsWith(root + path.sep)) {
      return undefined;
    }
    try {
      return fs.readFileSync(candidate, "utf-8");
    } catch {
      return undefined;
    }
  };
}
