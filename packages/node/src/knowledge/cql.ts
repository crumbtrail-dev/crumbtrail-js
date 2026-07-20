/**
 * CQL construction and sanitization for the Confluence spec oracle (pure — no
 * I/O, no env, no network).
 *
 * This is **not** an evidence adapter's query builder. Evidence adapters build
 * queries from `descriptor.joinKeys` ∩ `EvidenceQuery.keys` inside a located
 * incident window; documentation has no correlational join key and no temporal
 * relationship to the window, so this builder takes free text and an optional
 * operator-supplied space allowlist and nothing else.
 *
 * Emitted clause order is fixed and documented:
 *
 * ```
 * text ~ "<sanitized query>" AND type = page
 *   [AND space.key IN ("A", "B")]
 * ORDER BY lastModified DESC
 * ```
 *
 * The allowlist clause is omitted entirely when no usable space key survives
 * sanitization — an empty `IN ()` is both a syntax error and, if the provider
 * tolerated it, would silently match nothing.
 *
 * `ORDER BY lastModified DESC` is a deliberate hedge given design decision D1
 * (advisory only): when several pages match, the one most recently touched is
 * the one least likely to be stale. It is a weak signal and is never presented
 * to the caller as relevance ranking.
 *
 * @see docs/specs/2026-07-19-confluence-spec-oracle-design.md
 */

/**
 * Hard cap on the sanitized free-text term. Long queries do not improve keyword
 * matching and an unbounded term lets a caller inflate the request URL.
 */
const MAX_QUERY_LENGTH = 512;

/** Hard cap on distinct space keys in the allowlist clause. */
const MAX_SPACE_KEYS = 50;

/**
 * Quote-like characters that are not ASCII `"` but that a normalizing proxy,
 * font-folding layer, or provider-side parser could fold into one.
 *
 * Matched **categorically** rather than by hand-enumeration: `\p{Quotation_Mark}`
 * covers every character Unicode itself classifies as a quotation mark, and the
 * added ranges cover the modifier letters, primes, and quotation ornaments that
 * ICU `Latin-ASCII`, `iconv //TRANSLIT`, and Lucene's `ASCIIFoldingFilter`
 * transliterate into `"` or `'` but that Unicode does not mark as quotes.
 *
 * This removes the classes of lookalike we know real folding layers produce. It
 * is not a proof of safety against an arbitrary provider parser — the actual
 * guarantee is the one below in {@link CQL_STRUCTURAL}: the emitted term
 * contains no delimiter, escape, or operator character of its own.
 */
const QUOTE_LOOKALIKES = /[\p{Quotation_Mark}ʹ-ʼˮ׳״′-‷❛-❞〃]/gu;

/**
 * Characters removed outright because they carry structural or operator meaning
 * inside a CQL `text ~ "..."` term. This is the CQL string-literal set (quote,
 * escape, grouping) plus the Lucene reserved characters, because Confluence
 * honors wildcard, fuzzy, boost, regex, and boolean syntax *inside* the quoted
 * term — an ordinary query like `checkout /api/retry endpoint` would otherwise
 * open an unterminated regex term and come back as an HTTP 400, which the
 * client maps to a hard `request-failed` gap. A user typing a slash must not
 * make the oracle report itself unavailable.
 *
 * Removal is preferred over escaping: escaping depends on the provider's
 * un-escaping being exactly what we assume, whereas a term containing no
 * delimiter, no backslash, and no operator character cannot terminate or
 * re-interpret the literal it is interpolated into regardless of how the far
 * side parses it.
 */
const CQL_STRUCTURAL = /["'\\()[\]{}+\-!^~*?:/]|&&|\|\|/g;

/** Control characters (including newlines and tabs) folded to a single space. */
// eslint-disable-next-line no-control-regex -- matching control chars is the point
const CONTROL_CHARS = /[\u0000-\u001F\u007F]+/g;

/** Valid Confluence space-key shape. Anything else is dropped, never escaped. */
const SPACE_KEY_PATTERN = /^[A-Za-z0-9_]+$/;

/**
 * Sanitize free text for interpolation into a CQL double-quoted string literal.
 *
 * Injection is prevented by **removal**, not escaping: quote characters, quote
 * lookalikes, backslashes, grouping characters, and Lucene operator characters
 * are deleted, and control characters plus runs of whitespace collapse to
 * single spaces. What survives is a bare keyword phrase. Text like
 * `") OR type=page` therefore degrades to the harmless literal `OR type=page`
 * — still inside the quotes, still just words.
 *
 * Input is `NFKC`-normalized **first**, so compatibility forms collapse into
 * their canonical equivalents before the quote class is applied rather than
 * after it.
 *
 * The length cap slices by **code point**, not UTF-16 code unit. A naive
 * `.slice()` can cut an astral character in half and leave a lone surrogate,
 * which makes `encodeURIComponent` on the emitted CQL throw `URIError` — an
 * uncaught throw in a surface whose whole discipline is never to throw.
 *
 * Returns `""` for input that is empty, whitespace-only, or consists entirely
 * of removed characters. Callers must treat `""` as "no searchable term"
 * rather than as a match-everything query.
 */
export function sanitizeCqlText(raw: string): string {
  const collapsed = raw
    .normalize("NFKC")
    .replace(QUOTE_LOOKALIKES, "")
    .replace(CQL_STRUCTURAL, "")
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(collapsed).slice(0, MAX_QUERY_LENGTH).join("").trim();
}

/**
 * Normalize an operator-supplied space allowlist.
 *
 * Space keys are validated against {@link SPACE_KEY_PATTERN} and **dropped** if
 * they do not match — a key carrying a quote or a parenthesis is an injection
 * attempt or a typo, and in both cases silently ignoring it is safer than
 * escaping it into the query. Order is preserved, duplicates are removed
 * case-sensitively, and the list is capped at {@link MAX_SPACE_KEYS}.
 */
export function sanitizeSpaceKeys(keys: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const key of keys) {
    const trimmed = typeof key === "string" ? key.trim() : "";
    if (!SPACE_KEY_PATTERN.test(trimmed)) continue;
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
    if (out.length >= MAX_SPACE_KEYS) break;
  }
  return out;
}

export interface SpecCqlInput {
  /** Free-text description of the behavior in question. */
  query: string;
  /** Optional space allowlist. Omitted from the CQL when empty after sanitizing. */
  spaceKeys?: readonly string[];
}

/**
 * Discriminated result rather than a thrown error, so the calling client can
 * turn an unusable query into an `EvidenceGap` without a try/catch and without
 * this module knowing anything about gaps.
 */
export type SpecCqlResult =
  | {
      ok: true;
      /** The complete CQL string, ready to URL-encode. */
      cql: string;
      /** The sanitized term actually searched, for gap/diagnostic text. */
      sanitizedQuery: string;
      /** The space keys that survived sanitization, in emitted order. */
      spaceKeys: string[];
    }
  | {
      ok: false;
      /** The free-text term was empty, whitespace-only, or fully stripped. */
      reason: "empty-query";
    };

/**
 * Build the spec-search CQL. Pure: same input, same string, no clock, no env.
 */
export function buildSpecSearchCql(input: SpecCqlInput): SpecCqlResult {
  const sanitizedQuery = sanitizeCqlText(input.query ?? "");
  if (sanitizedQuery.length === 0) return { ok: false, reason: "empty-query" };

  const spaceKeys = sanitizeSpaceKeys(input.spaceKeys ?? []);
  const clauses = [`text ~ "${sanitizedQuery}"`, "type = page"];
  if (spaceKeys.length > 0) {
    clauses.push(`space.key IN (${spaceKeys.map((k) => `"${k}"`).join(", ")})`);
  }

  return {
    ok: true,
    cql: `${clauses.join(" AND ")} ORDER BY lastModified DESC`,
    sanitizedQuery,
    spaceKeys,
  };
}
