import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONFLUENCE_API_TOKEN_ENV,
  CONFLUENCE_BASE_URL_ENV,
  CONFLUENCE_EMAIL_ENV,
  CONFLUENCE_SPACE_KEYS_ENV,
} from "../knowledge";
import { evidenceSourcesFromEnv } from "../evidence-sources";
import { EVIDENCE_SOURCE_PROVIDERS } from "../evidence-sources/registry";

/**
 * Executable form of the design's "What this is not" section.
 *
 * `docs/specs/2026-07-19-confluence-spec-oracle-design.md` rejects three things
 * outright: a `docs` value on `EvidenceLane`, a `confluence` entry in
 * `EVIDENCE_SOURCE_PROVIDERS`, and any coupling from `knowledge/` back into the
 * adapter framework beyond the shared egress/redaction posture. Prose and JSDoc
 * cannot stop a future contributor from pattern-matching Confluence into the
 * adapter registry — the named failure mode. These assertions can.
 *
 * Every guard below is written so that violating the invariant turns it red;
 * that was proven by temporarily introducing each violation before this file
 * was committed.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../..");
const knowledgeDir = path.join(here, "..", "knowledge");
const evidenceLaneSource = path.join(
  repoRoot,
  "packages",
  "core",
  "src",
  "evidence.ts",
);

/** A marker that only appears in a fully written `evidence.ts`. Reading a file
 *  that another process is mid-write on can hand back a truncated snapshot; a
 *  truncated snapshot must be rejected, not parsed. */
const EVIDENCE_SOURCE_SENTINEL = "export const EVIDENCE_SCHEMA_VERSION";

/** One attempt at parsing the union. Returns `null` for any input this cannot
 *  trust, so the caller can distinguish "read a bad snapshot" from "the union
 *  genuinely has no members" — the latter must never be reported as `[]`. */
function tryParseEvidenceLaneValues(): string[] | null {
  const source = fs.readFileSync(evidenceLaneSource, "utf8");
  if (!source.includes(EVIDENCE_SOURCE_SENTINEL)) return null;

  const match = /export type EvidenceLane\s*=([\s\S]*?);/.exec(source);
  if (!match) return null;

  const lanes = [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  // A union that parsed to zero literals is a bad read, not a real answer:
  // TypeScript cannot express an empty string-literal union, so this shape is
  // unreachable from a complete file.
  if (lanes.length === 0) return null;

  return lanes;
}

/**
 * Parse the `EvidenceLane` string-literal union out of core's source text.
 * `EvidenceLane` is a type, so it is erased at runtime and cannot be reflected
 * over — the source is the only thing that can be asserted on.
 *
 * Read once and memoized. An architecture reviewer saw this parse return `[]`
 * exactly once during a full-suite run and the cause was never reproduced.
 * Rather than assert a root cause that was not established, the read is
 * hardened against the whole class the symptom belongs to: any incomplete or
 * unparseable snapshot is rejected outright instead of being silently reduced
 * to an empty array that then fails on a downstream `toContain`. When the read
 * is not trustworthy the error names the file and what was actually read, so
 * the next occurrence is diagnosable rather than a mystery.
 */
let cachedLanes: string[] | undefined;
function parseEvidenceLaneValues(): string[] {
  if (cachedLanes) return cachedLanes;

  const lanes = tryParseEvidenceLaneValues();
  if (lanes) {
    cachedLanes = lanes;
    return lanes;
  }

  const bytes = fs.existsSync(evidenceLaneSource)
    ? fs.statSync(evidenceLaneSource).size
    : -1;
  throw new Error(
    `could not parse a complete 'export type EvidenceLane' union from ` +
      `${evidenceLaneSource} (file size: ${bytes} bytes). ` +
      `This means the file was missing, truncated, or the union's shape ` +
      `changed — not that the union is empty.`,
  );
}

describe("knowledge/ stays outside the evidence-source framework", () => {
  it("does not add a 'docs' lane to EvidenceLane", () => {
    const lanes = parseEvidenceLaneValues();

    // Sanity: the parse actually found the union, so an empty result cannot
    // make the real assertion below pass vacuously.
    expect(lanes).toContain("code");
    expect(lanes.length).toBeGreaterThan(1);

    expect(lanes).not.toContain("docs");
  });

  it("registers no 'confluence' provider, even after the knowledge barrel is imported", async () => {
    // The static import at the top of this file already pulled in the barrel;
    // re-importing makes the ordering explicit and covers a lazy import too.
    await import("../knowledge");

    // Sanity: the adapter registry really is populated here, so "no confluence
    // entry" is a meaningful statement rather than an empty-array tautology.
    expect(EVIDENCE_SOURCE_PROVIDERS.length).toBeGreaterThan(0);

    const providerIds = EVIDENCE_SOURCE_PROVIDERS.map((p) => p.provider);
    expect(providerIds).not.toContain("confluence");
  });

  it("builds no extra source from a fully configured Confluence env", () => {
    const baseEnv: Record<string, string | undefined> = {};
    const confluenceEnv: Record<string, string | undefined> = {
      [CONFLUENCE_BASE_URL_ENV]: "https://acme.atlassian.net/wiki",
      [CONFLUENCE_EMAIL_ENV]: "ops@acme.example",
      [CONFLUENCE_API_TOKEN_ENV]: "confluence-token",
      [CONFLUENCE_SPACE_KEYS_ENV]: "ENG,OPS",
    };

    const before = evidenceSourcesFromEnv(baseEnv);
    const after = evidenceSourcesFromEnv(confluenceEnv);

    expect(after.length).toBe(before.length);
    expect(after.map((s) => s.descriptor.provider)).not.toContain("confluence");
  });
});

/**
 * `knowledge/` may borrow the adapter suite's egress and redaction posture, and
 * nothing else. Widening this list is the coupling the directory split exists to
 * prevent, so the allowlist is asserted rather than described.
 *
 * The allowlist is only as strong as the scan feeding it. See
 * {@link readKnowledgeImports} for exactly which import forms are covered and
 * which are not: every static form that can name a literal specifier is, and
 * `knowledge/` is additionally held to named imports only, so a namespace or
 * side-effect import cannot slip past a name-based allowlist by contributing no
 * names.
 */
const ALLOWED_EVIDENCE_SOURCE_IMPORTS = new Set([
  "DEFAULT_SOURCE_TIMEOUT_MS",
  "redactEvidenceGap",
  "redactText",
]);

/** Only `CRUMBTRAIL_USER_AGENT` may cross from the ticket-connector module. */
const ALLOWED_TICKET_IMPORTS = new Set(["CRUMBTRAIL_USER_AGENT"]);

/** Binding forms a module specifier can be pulled in under. Everything except
 *  `named` is rejected outright inside `knowledge/` — see the suite below. */
type ImportForm =
  "named" | "namespace" | "default" | "side-effect" | "dynamic" | "require";

interface ImportRecord {
  file: string;
  specifier: string;
  /** Imported binding names. Non-named forms contribute sentinels — `"*"` for a
   *  namespace or `export *`, `"default"` for a default import, `"(dynamic)"` /
   *  `"(require)"` for the call forms — so that a name allowlist rejects them
   *  instead of seeing an empty, vacuously-clean list. */
  names: string[];
  forms: ImportForm[];
}

/**
 * Blank out comments while leaving string literals intact, so a specifier
 * mentioned in prose or JSDoc cannot be reported as a real import.
 *
 * Known limit: a regex literal beginning `/*` would be misread as a block
 * comment. `knowledge/` contains no such literal, and the "scans a non-empty
 * set" sanity test below would go red if this ever swallowed the imports.
 */
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (
        i < source.length &&
        !(source[i] === "*" && source[i + 1] === "/")
      ) {
        // Preserve line structure so error messages stay readable.
        out += source[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          out += source[i] + (source[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += source[i];
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }

    out += c;
    i += 1;
  }
  return out;
}

/** Split an import/export clause into binding names plus the forms it uses. */
function parseClause(rawClause: string): {
  names: string[];
  forms: ImportForm[];
} {
  const clause = rawClause.replace(/^type\s+/, "").trim();
  const names: string[] = [];
  const forms: ImportForm[] = [];

  const braced = /\{([^}]*)\}/.exec(clause);
  if (braced) {
    forms.push("named");
    for (const part of braced[1].split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)[0]
        .trim();
      if (name.length > 0) names.push(name);
    }
  }

  const withoutBraces = clause.replace(/\{[^}]*\}/g, "").trim();
  if (/(^|[\s,])\*/.test(withoutBraces)) {
    forms.push("namespace");
    names.push("*");
  }

  // Anything left that is a bare identifier is a default binding.
  const rest = withoutBraces
    .replace(/\*\s*(as\s+[A-Za-z_$][\w$]*)?/g, "")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => /^[A-Za-z_$][\w$]*$/.test(p));
  if (rest.length > 0) {
    forms.push("default");
    names.push("default");
  }

  return { names, forms };
}

/** Recursively collect every `.ts` file under `dir`, relative to it.
 *  Non-recursive scanning would leave a future `knowledge/<subdir>/*.ts`
 *  unguarded while the sanity check below still passed. */
function listTsFiles(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      found.push(...listTsFiles(path.join(dir, entry.name), rel));
    } else if (entry.name.endsWith(".ts")) {
      found.push(rel);
    }
  }
  return found;
}

/**
 * Collect every module-specifier-bearing statement from every `.ts` file under
 * `knowledge/`, at any depth.
 *
 * Covered forms: `import { a }`, `import type { a }`, `import Def`,
 * `import * as ns`, bare `import "x"`, `export { a } from`, `export * from`,
 * `await import("x")`, and `require("x")` — single- or double-quoted.
 * Comments are blanked first, so a specifier named in prose is not a finding.
 *
 * Not covered: a specifier assembled at runtime (`import(base + name)`), which
 * no allowlist scan can resolve statically, and imports that reach the adapter
 * framework transitively through a third module rather than directly. Both are
 * out of what a source-text guard can claim; direct coupling is what this
 * boundary is about and what these tests actually assert.
 *
 * A source-text scan is deliberate: the point is to fail a new import line in
 * review, and a resolved module graph would not name the bindings.
 */
function readKnowledgeImports(): ImportRecord[] {
  const records: ImportRecord[] = [];

  for (const file of listTsFiles(knowledgeDir)) {
    const source = stripComments(
      fs.readFileSync(path.join(knowledgeDir, file), "utf8"),
    );
    const push = (specifier: string, names: string[], forms: ImportForm[]) => {
      records.push({ file, specifier, names, forms });
    };

    // `import ... from "x"` / `export ... from "x"` (named, default, namespace).
    for (const m of source.matchAll(
      /\b(?:import|export)\s+([^;'"=]*?)\s*from\s*["']([^"']+)["']/g,
    )) {
      const { names, forms } = parseClause(m[1]);
      push(m[2], names, forms.length > 0 ? forms : ["named"]);
    }

    // Bare side-effect import: the exact form that WOULD populate the registry.
    for (const m of source.matchAll(/\bimport\s+["']([^"']+)["']/g)) {
      push(m[1], ["(side-effect)"], ["side-effect"]);
    }

    // Dynamic import and CommonJS require with a literal specifier.
    for (const m of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) {
      push(m[1], ["(dynamic)"], ["dynamic"]);
    }
    for (const m of source.matchAll(
      /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    )) {
      push(m[1], ["(require)"], ["require"]);
    }
  }

  return records;
}

describe("knowledge/ imports only the shared egress + redaction posture", () => {
  it("scans a non-empty set of import statements across every file, at any depth", () => {
    // Guards against a path typo silently turning every assertion below green.
    const records = readKnowledgeImports();
    expect(records.length).toBeGreaterThan(0);

    // And against a scan that only reached knowledge/'s top level: every .ts
    // file that actually contains an import must appear in the results. (A
    // file with no imports contributes no records and is not a gap.)
    const scanned = new Set(records.map((r) => r.file));
    const files = listTsFiles(knowledgeDir);
    expect(files.length).toBeGreaterThan(0);

    const unscanned = files.filter((file) => {
      if (scanned.has(file)) return false;
      const source = stripComments(
        fs.readFileSync(path.join(knowledgeDir, file), "utf8"),
      );
      return /\bimport\b|\brequire\s*\(/.test(source);
    });
    expect(unscanned).toEqual([]);
  });

  it("uses named imports only — no namespace, default, side-effect, or dynamic form", () => {
    // A name-based allowlist is blind to a form that contributes no names.
    // `import * as ev from "../evidence-sources"` would otherwise satisfy all
    // three assertions below while pulling in the entire registry, and a bare
    // `import "../evidence-sources"` is the exact form that populates it.
    const offenders = readKnowledgeImports()
      .filter((r) => r.forms.some((f) => f !== "named"))
      .map((r) => `${r.file}: ${r.forms.join("+")} from "${r.specifier}"`);

    expect(offenders).toEqual([]);
  });

  it("pulls nothing from evidence-sources/ beyond the allowed helpers", () => {
    const offenders = readKnowledgeImports()
      .filter((r) => r.specifier.includes("evidence-sources"))
      .flatMap((r) =>
        r.names
          .filter((n) => !ALLOWED_EVIDENCE_SOURCE_IMPORTS.has(n))
          .map((n) => `${r.file}: ${n} from "${r.specifier}"`),
      );

    expect(offenders).toEqual([]);
  });

  it("pulls nothing from ticket/ beyond the shared User-Agent", () => {
    const offenders = readKnowledgeImports()
      .filter((r) => r.specifier.includes("ticket/"))
      .flatMap((r) =>
        r.names
          .filter((n) => !ALLOWED_TICKET_IMPORTS.has(n))
          .map((n) => `${r.file}: ${n} from "${r.specifier}"`),
      );

    expect(offenders).toEqual([]);
  });

  it("never imports the provider registry or the fan-out entry point", () => {
    // Matches the barrel and the registry however they are spelled — bare,
    // via an explicit `/index`, or with a `.js`/`.ts` extension — so the check
    // is not defeated by the specifier's surface form.
    const registryEntryPoint =
      /(^|\/)evidence-sources(\/(index|registry))?(\.[jt]s)?$/;

    const forbidden = readKnowledgeImports().filter(
      (r) =>
        registryEntryPoint.test(r.specifier) ||
        r.names.includes("EVIDENCE_SOURCE_PROVIDERS") ||
        r.names.includes("registerEvidenceProvider") ||
        r.names.includes("fetchAllEvidence"),
    );

    expect(
      forbidden.map((r) => `${r.file}: ${r.forms.join("+")} "${r.specifier}"`),
    ).toEqual([]);
  });
});
