/**
 * Confluence spec-oracle client — the one place in `knowledge/` that touches
 * env, the network, and the clock.
 *
 * It is deliberately **not** an `EvidenceSource`. It does not implement that
 * interface, does not appear in `EVIDENCE_SOURCE_PROVIDERS`, and is never
 * constructed by `evidenceSourcesFromEnv`, for the three reasons `types.ts`
 * documents (no time window, no correlational join key, must not be ranked by
 * `assembleBundle`). What it *does* borrow, verbatim and on purpose, is the
 * adapter suite's operational posture:
 *
 * - **Env-only credentials**, present iff every required var is set — the
 *   `ticketClientFromEnv` rule, except that a missing var yields `undefined`
 *   here rather than a throw, because the caller's next move is a gap.
 * - **Injectable transport** (`fetchImpl?: typeof fetch`), exactly as
 *   `SentrySourceConfig` declares it, so contract tests replay fixtures and CI
 *   makes zero live requests.
 * - **Bounded egress**: one request, one page of results, limit clamped to
 *   {@link MAX_SPEC_LIMIT}, no pagination walk, an `AbortController` seeded from
 *   `DEFAULT_SOURCE_TIMEOUT_MS`, and `CRUMBTRAIL_USER_AGENT` on the wire.
 * - **Sanitized errors**: status plus origin+path only, via the `sanitizeUrl`
 *   shape copied from `sentry.ts`. The Basic credential lives in the
 *   `Authorization` header and reaches no message, gap, or excerpt.
 * - **Redaction at the boundary**: every excerpt through `redactText`, every
 *   deep link through `redactUrl` (the path `redactRef` uses), every gap through
 *   `redactEvidenceGap`. Confluence runbooks routinely paste real credentials,
 *   so this is load-bearing rather than precautionary.
 *
 * The contract this file must never break: {@link ConfluenceKnowledgeClient.searchSpecs}
 * **always resolves**. Missing credentials, 401/403, timeout, malformed JSON,
 * an unusable query, and zero results are all {@link KnowledgeResult} values
 * carrying gaps.
 *
 * **No retry.** Deliberate, and the one place this diverges from `sentry.ts`
 * (which wraps its primary query in `withBoundedRetry`). An adapter retries
 * because it is one lane of a bundle assembled once at incident time and a
 * dropped lane is unrecoverable. The spec oracle is agent-invoked and
 * idempotent: the agent sees the gap and can simply ask again. Paying a retry's
 * latency inside an interactive tool call buys nothing.
 *
 * @see docs/specs/2026-07-19-confluence-spec-oracle-design.md
 */
import { redactUrl } from "crumbtrail-core";
import { DEFAULT_SOURCE_TIMEOUT_MS } from "../evidence-sources/fetch-all";
import { redactEvidenceGap, redactText } from "../evidence-sources/redact";
import { CRUMBTRAIL_USER_AGENT } from "../ticket/clients";
import {
  buildSpecSearchCql,
  countDroppedSpaceKeys,
  describeCqlInputLoss,
  MAX_QUERY_LENGTH,
  sanitizeSpaceKeys,
  type CqlInputLoss,
  type SpecCqlInput,
  type SpecCqlResult,
} from "./cql";
import { knowledgeGap } from "./gaps";
import {
  deriveAgeDays,
  KNOWLEDGE_SCHEMA_VERSION,
  type KnowledgeClock,
  type KnowledgeResult,
  type SpecExcerpt,
} from "./types";
import type { EvidenceGap } from "crumbtrail-core";

/** Site wiki root, e.g. `https://acme.atlassian.net/wiki`. Required. */
export const CONFLUENCE_BASE_URL_ENV = "CONFLUENCE_BASE_URL";
/** Atlassian account email, the Basic-auth username. Required. */
export const CONFLUENCE_EMAIL_ENV = "CONFLUENCE_EMAIL";
/** Atlassian API token, the Basic-auth password. Required. */
export const CONFLUENCE_API_TOKEN_ENV = "CONFLUENCE_API_TOKEN";
/** Optional comma-separated operator allowlist of space keys. */
export const CONFLUENCE_SPACE_KEYS_ENV = "CONFLUENCE_SPACE_KEYS";

/**
 * Presence of all three ⇒ configured. Mirrors `SENTRY_AUTH_FIELDS` and the
 * `isPresent` rule in `evidence-sources/registry.ts` — mirrored, not imported,
 * because importing through the registry is exactly the coupling this directory
 * exists to avoid.
 */
export const CONFLUENCE_AUTH_FIELDS = [
  CONFLUENCE_BASE_URL_ENV,
  CONFLUENCE_EMAIL_ENV,
  CONFLUENCE_API_TOKEN_ENV,
];

/** Result count when the caller does not ask for one. */
export const DEFAULT_SPEC_LIMIT = 5;
/** Hard ceiling on results, regardless of what the caller asks for. */
export const MAX_SPEC_LIMIT = 15;

/**
 * Per-excerpt cap in UTF-8 **bytes**, not characters — the cap exists to bound
 * what crosses the wire into an agent's context, and a CJK or emoji page costs
 * three to four bytes per character.
 */
export const MAX_EXCERPT_BYTES = 2_000;

/**
 * Reserve enough leading context for an excerpt to be readable while keeping a
 * matched term comfortably inside the final {@link MAX_EXCERPT_BYTES} cap.
 */
const MATCH_CONTEXT_BEFORE_BYTES = Math.floor(MAX_EXCERPT_BYTES / 4);

/**
 * Work with a finite region before applying the public excerpt cap. The final
 * cap still governs what callers receive; this wider window merely preserves
 * a little trailing context around the match.
 */
const MAX_MATCH_CONTEXT_BYTES = MAX_EXCERPT_BYTES * 2;

/**
 * A Confluence response can contain rich page HTML for several results. Keep
 * the wire payload finite before parsing it, rather than trusting a provider
 * header or allocating an unbounded JSON string.
 */
const MAX_CONFLUENCE_RESPONSE_BYTES = 1_024 * 1_024;

/**
 * Bound remote markup before `htmlToText`'s regex passes. Four times the 2 KB
 * excerpt budget leaves room for ordinary tags/entities without letting one
 * hostile field turn the regex work into an unbounded CPU allocation.
 */
const MAX_HTML_BYTES = MAX_EXCERPT_BYTES * 4;

/** Page fields the search must expand for a usable excerpt + staleness signal. */
const SEARCH_EXPAND = "body.view,version,space";

/**
 * Strip lone UTF-16 surrogates so `encodeURIComponent` cannot throw on the CQL.
 *
 * A well-formed astral character is a *pair*; a single unpaired half is not
 * encodable as UTF-8, so `encodeURIComponent` throws `URIError` on it. CP1's
 * code-point-safe slice guarantees the *cap* never manufactures one, but a
 * caller can supply one directly in the query text and it survives sanitization
 * untouched — it is neither a quote, an operator, nor a control character. This
 * client is the first code that encodes, so it is the place that has to scrub
 * them.
 */
function stripLoneSurrogates(value: string): string {
  // Well-formed pairs match the pair alternative first and are preserved; only
  // an unpaired half falls through to removal.
  return value.replace(
    /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/gu,
    (m) => (m.length === 2 ? m : ""),
  );
}

/**
 * Non-2xx response marker. Copied from `SentryError`: status plus a sanitized
 * URL, never the credential.
 */
class ConfluenceError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ConfluenceError";
  }
}

/** Origin + path only. Copied verbatim from `sentry.ts`'s `sanitizeUrl`. */
function sanitizeUrl(u: string): string {
  try {
    const p = new URL(u);
    return `${p.origin}${p.pathname}`;
  } catch {
    return u.split("?")[0];
  }
}

export interface ConfluenceClientConfig {
  /** Wiki root; trailing slashes are stripped. */
  baseUrl: string;
  email: string;
  apiToken: string;
  /**
   * Operator-configured space allowlist. When non-empty it is a **ceiling**: a
   * caller-supplied list can only narrow it, never widen it.
   */
  spaceKeys?: readonly string[];
  /**
   * Internal env boundary marker: `CONFLUENCE_SPACE_KEYS` was present, even if
   * it parsed to no keys. Direct clients may use `spaceKeys: []` as the
   * established spelling for no configured ceiling; a non-empty direct list
   * is always validated as a security ceiling too.
   */
  spaceKeysConfigured?: boolean;
  /** Injectable transport. Defaults to global `fetch`. Tests pass a stub. */
  fetchImpl?: typeof fetch;
  /** Per-request budget. Defaults to `DEFAULT_SOURCE_TIMEOUT_MS`. */
  timeoutMs?: number;
}

export interface SpecSearchRequest {
  /** Free-text description of the behavior in question. */
  query: string;
  /** Caller narrowing. Intersected with the operator allowlist, never unioned. */
  spaceKeys?: readonly string[];
  /** Clamped to `[1, MAX_SPEC_LIMIT]`. Defaults to {@link DEFAULT_SPEC_LIMIT}. */
  limit?: number;
}

/** Minimal shape of the `/content/search` rows we consume. */
interface ConfluenceSearchRow {
  id?: string;
  title?: string;
  space?: { key?: string };
  body?: { view?: { value?: string } };
  version?: { when?: string; by?: { displayName?: string } };
  _links?: { webui?: string };
}

interface ConfluenceSearchResponse {
  results?: ConfluenceSearchRow[];
  _links?: { base?: string };
}

/**
 * Parse the comma-separated env allowlist. Shape validation is CQL's job
 * (`sanitizeSpaceKeys`); this only splits and trims.
 */
export function parseSpaceKeysEnv(raw: string | undefined): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
}

/**
 * Build a client from env, or `undefined` when any required var is unset —
 * the `ticketClientFromEnv` present-iff-set rule, with `undefined` in place of a
 * throw so the caller emits a `not-configured` gap
 * ({@link notConfiguredKnowledgeResult}) instead of catching.
 */
export function confluenceClientFromEnv(
  env: Record<string, string | undefined> = process.env,
  options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): ConfluenceKnowledgeClient | undefined {
  const present = CONFLUENCE_AUTH_FIELDS.every((name) => {
    const value = env[name];
    return typeof value === "string" && value.length > 0;
  });
  if (!present) return undefined;

  const configuredSpaceKeys = env[CONFLUENCE_SPACE_KEYS_ENV];
  // This is deliberately a destructure rather than `...options` in the
  // config literal. The env-derived space ceiling is security-sensitive and a
  // runtime caller can otherwise smuggle `spaceKeys` or
  // `spaceKeysConfigured` through an object typed as these test seams.
  const { fetchImpl, timeoutMs } = options;
  return new ConfluenceKnowledgeClient({
    baseUrl: env[CONFLUENCE_BASE_URL_ENV] as string,
    email: env[CONFLUENCE_EMAIL_ENV] as string,
    apiToken: env[CONFLUENCE_API_TOKEN_ENV] as string,
    // Preserve whether the env var was set. `""`, `",,"`, and a malformed
    // value are materially different from the variable being absent: the
    // former are a broken security ceiling and must fail closed.
    spaceKeys:
      configuredSpaceKeys === undefined
        ? undefined
        : parseSpaceKeysEnv(configuredSpaceKeys),
    spaceKeysConfigured: configuredSpaceKeys !== undefined,
    fetchImpl,
    timeoutMs,
  });
}

/** Redact and assemble a `KnowledgeResult`. The single exit point of this file. */
function knowledgeResult(
  excerpts: SpecExcerpt[],
  gaps: EvidenceGap[],
  stats: Omit<KnowledgeResult["stats"], "provider">,
): KnowledgeResult {
  return {
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    excerpts,
    gaps: gaps.map((gap, index) => redactEvidenceGap(gap, index)),
    stats: { provider: "confluence", ...stats },
  };
}

/**
 * The result a caller returns when {@link confluenceClientFromEnv} yields
 * `undefined`. Lives here so the "missing credentials is a gap, not an error"
 * rule has exactly one implementation for CP3's tool dispatch to reuse.
 */
export function notConfiguredKnowledgeResult(): KnowledgeResult {
  return knowledgeResult(
    [],
    [
      knowledgeGap({
        kind: "not-configured",
        reason: "confluence: credentials are not configured",
        suggestion: `set ${CONFLUENCE_AUTH_FIELDS.join(", ")} to enable spec lookups`,
      }),
    ],
    { fetched: 0, returned: 0, truncated: false, latencyMs: 0 },
  );
}

/**
 * The request shape itself could not be processed. Module-level rather than a
 * private method because two layers need the *same* gap: the client, when a
 * value survives the coercers and still breaks the pure CQL builder, and CP3's
 * MCP dispatch, when an argument arrives with a type that cannot mean anything
 * (`query: 42`). Coercing that to `""` at the boundary reported "empty after
 * sanitization", which sends the agent off to rephrase a query whose *type* was
 * the problem — it would retry the identical malformed shape.
 */
export function unusableInputGap(): EvidenceGap {
  return knowledgeGap({
    kind: "request-failed",
    reason: "confluence: the search request could not be interpreted",
    suggestion: "query must be text and spaceKeys a list of space-key strings",
  });
}

/** {@link unusableInputGap} as a standalone result, for callers outside the client. */
export function unusableInputKnowledgeResult(): KnowledgeResult {
  return knowledgeResult([], [unusableInputGap()], {
    fetched: 0,
    returned: 0,
    truncated: false,
    latencyMs: 0,
  });
}

/**
 * Last-resort degradation for a caller that must not surface an exception.
 *
 * {@link ConfluenceKnowledgeClient.searchSpecs} is documented as never
 * rejecting, but "documented" is not "enforced": a caller that treats the
 * contract as a load-bearing assumption inherits every future hole in it. This
 * exists so the assumption can be belt-and-braced by an actual `catch`.
 *
 * The message is FIXED and carries nothing from the caught error. A thrown
 * message can echo the request URL — the exact channel `errorGap` refuses to
 * reuse for network errors — so interpolating one here would reopen it at a
 * layer with even less control over the shape.
 */
export function unexpectedFailureKnowledgeResult(): KnowledgeResult {
  return knowledgeResult(
    [],
    [
      knowledgeGap({
        kind: "request-failed",
        reason: "confluence: the spec lookup failed unexpectedly",
        suggestion:
          "retry the lookup; if it keeps failing, check the Confluence configuration and host logs",
      }),
    ],
    { fetched: 0, returned: 0, truncated: false, latencyMs: 0 },
  );
}

/**
 * Confluence HTML → plain text. Deliberately crude and dependency-free: script
 * and style subtrees are dropped whole, block-level tags become newlines so the
 * text does not run together, remaining tags are stripped, and the handful of
 * entities Confluence actually emits are decoded. The output is prose for a
 * human or an agent to read, never re-parsed.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|pre|blockquote)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Cap `text` at `maxBytes` UTF-8 bytes without splitting a character, and report
 * whether anything was actually dropped.
 *
 * `truncated` is true **only** when bytes were removed. A page that fits
 * exactly at the cap reports `false`, which is what makes `stats.truncated`
 * worth reading.
 */
export function capExcerptBytes(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return { text, truncated: false };
  }
  // Walk whole code points so a multi-byte character is never halved.
  let bytes = 0;
  let out = "";
  for (const ch of text) {
    const size = Buffer.byteLength(ch, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    out += ch;
  }
  return { text: out.trimEnd(), truncated: true };
}

/**
 * Find the deterministic anchor for a page excerpt. Prefer the complete
 * sanitized phrase; Confluence can also return stemming/token matches, so
 * fall back to the first matching individual term in query order.
 */
function matchedTermIndex(text: string, sanitizedQuery: string): number {
  const haystack = text.toLowerCase();
  const phrase = sanitizedQuery.toLowerCase();
  const phraseIndex = haystack.indexOf(phrase);
  if (phraseIndex >= 0) return phraseIndex;

  for (const term of phrase.split(/\s+/)) {
    if (!term) continue;
    const index = haystack.indexOf(term);
    if (index >= 0) return index;
  }
  return -1;
}

/** Move backward by at most `maxBytes`, without splitting a code point. */
function contextStartBeforeMatch(
  text: string,
  matchIndex: number,
  maxBytes: number,
): number {
  let start = matchIndex;
  let bytes = 0;
  while (start > 0) {
    const previous = text.charCodeAt(start - 1);
    // A low surrogate at `start - 1` belongs to the code point starting one
    // code unit earlier. Include the pair only when it is well-formed.
    const codePointStart =
      previous >= 0xdc00 &&
      previous <= 0xdfff &&
      start >= 2 &&
      text.charCodeAt(start - 2) >= 0xd800 &&
      text.charCodeAt(start - 2) <= 0xdbff
        ? start - 2
        : start - 1;
    if (codePointStart < 0) break;
    const char = text.slice(codePointStart, start);
    const charBytes = Buffer.byteLength(char, "utf8");
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    start = codePointStart;
  }
  return start;
}

/**
 * Select a bounded region around the first deterministic query match. This
 * runs after HTML-to-text but before redaction and the public excerpt cap, so
 * a relevant passage deep in a page is not replaced by its opening boilerplate.
 */
function matchedExcerptContext(
  text: string,
  sanitizedQuery: string,
): { text: string; truncated: boolean } {
  const matchIndex = matchedTermIndex(text, sanitizedQuery);
  if (matchIndex < 0) return { text, truncated: false };

  const start = contextStartBeforeMatch(
    text,
    matchIndex,
    MATCH_CONTEXT_BEFORE_BYTES,
  );
  const region = capExcerptBytes(text.slice(start), MAX_MATCH_CONTEXT_BYTES);
  return { text: region.text, truncated: start > 0 || region.truncated };
}

/**
 * Coerce the caller's `query` to a string at the trust boundary.
 *
 * `SpecSearchRequest.query` is typed `string`, but the type is a compile-time
 * claim about a value that arrives as agent-authored JSON through CP3's MCP
 * dispatch. A non-string reached `raw.normalize()` inside the sanitizer and
 * rejected the promise, breaking the never-throws contract. A non-string is not
 * a searchable term, so it degrades to `""` and takes the `empty-query` path —
 * the same honest answer as a whitespace-only query.
 */
function coerceQueryText(raw: unknown): string {
  return typeof raw === "string" ? raw : "";
}

/**
 * Coerce the caller's `spaceKeys` to a string array at the trust boundary.
 *
 * A non-array reached a spread and rejected with "requested is not iterable".
 * Non-string members are dropped here rather than in `sanitizeSpaceKeys`, which
 * is reached only after this. A non-array degrades to "no caller narrowing",
 * which resolves to the operator ceiling — the safe direction.
 */
function coerceSpaceKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === "string");
}

/** Absolute page URL from the search row, scrubbed through `redactUrl`. */
function pageUrl(row: ConfluenceSearchRow, base: string): string {
  const webui = row._links?.webui;
  const raw =
    typeof webui === "string" && webui.length > 0
      ? `${base}${webui.startsWith("/") ? "" : "/"}${webui}`
      : base;
  return redactUrl(raw, "excerpts[].url").value;
}

/** A response crossed the body limit before it could be parsed as JSON. */
class ConfluenceResponseTooLargeError extends Error {
  constructor() {
    super("Confluence response body exceeded the configured limit");
    this.name = "ConfluenceResponseTooLargeError";
  }
}

export class ConfluenceKnowledgeClient {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly operatorSpaceKeys: readonly string[];
  private readonly operatorAllowlistInvalid: boolean;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: ConfluenceClientConfig) {
    this.baseUrl = config.baseUrl.replace(/\/+$/, "");
    // The credential is materialized once, here, and only ever leaves this
    // object as an Authorization header value.
    this.authorization = `Basic ${Buffer.from(
      `${config.email}:${config.apiToken}`,
      "utf8",
    ).toString("base64")}`;
    const configuredSpaceKeys = config.spaceKeys;
    this.operatorSpaceKeys = sanitizeSpaceKeys(configuredSpaceKeys ?? []);
    // A configured ceiling which loses any key during sanitization cannot be
    // relaxed to an unrestricted search. This is intentionally stricter than
    // caller-supplied narrowing: an operator typo must fail closed before any
    // network egress, including when the whole list becomes empty.
    this.operatorAllowlistInvalid =
      // An explicit empty direct array is the established no-ceiling spelling.
      // Every non-empty direct list is a ceiling and must fail closed if CQL
      // sanitization changes it. The marker extends the same treatment to an
      // env value which parsed to `[]`.
      (config.spaceKeysConfigured === true ||
        (configuredSpaceKeys?.length ?? 0) > 0) &&
      (this.operatorSpaceKeys.length === 0 ||
        countDroppedSpaceKeys(configuredSpaceKeys ?? []) > 0);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  }

  /**
   * Resolve the space allowlist for one request. The operator's env list is a
   * ceiling: when it is set, a caller list can only intersect with it. An
   * intersection that comes back empty falls back to the operator list rather
   * than to "no clause at all" — dropping the clause would silently *widen* the
   * search to every space, which is precisely the direction that must never
   * happen.
   *
   * The narrowing direction is the safety property and is not negotiable. What
   * *is* reportable is the loss: `denied` carries the caller keys the operator
   * ceiling excluded, so `searchSpecs` can gap on them. Without this the
   * highest-consequence clipping — "you asked for SECRET, I searched ENG" —
   * would be the one case that routed around {@link describeCqlInputLoss},
   * which only ever sees the already-resolved list.
   */
  private resolveSpaceKeys(requested: readonly string[]): {
    spaceKeys: string[];
    denied: string[];
  } {
    const operator = [...this.operatorSpaceKeys];
    if (requested.length === 0) return { spaceKeys: operator, denied: [] };
    if (operator.length === 0) return { spaceKeys: [...requested], denied: [] };

    const allowed = new Set(operator);
    const narrowed = requested.filter((k) => allowed.has(k));
    const denied = requested.filter((k) => !allowed.has(k));
    // Empty intersection ⇒ fall back to the operator list. Every caller key was
    // denied in that case, which `denied` already reflects.
    return { spaceKeys: narrowed.length > 0 ? narrowed : operator, denied };
  }

  /**
   * One bounded CQL search. **Never rejects.** Every failure mode resolves to a
   * `KnowledgeResult` carrying gaps.
   *
   * `clock` is required rather than defaulted, per `types.ts`: a default would
   * let a call site forget to thread it, compile clean, and still pass
   * clock-pinned tests.
   */
  async searchSpecs(
    request: SpecSearchRequest,
    clock: KnowledgeClock,
    signal?: AbortSignal,
  ): Promise<KnowledgeResult> {
    const startedAt = clock();
    const elapsed = () => Math.max(0, clock() - startedAt);
    const gaps: EvidenceGap[] = [];

    if (this.operatorAllowlistInvalid) {
      return knowledgeResult([], [this.invalidAllowlistGap()], {
        fetched: 0,
        returned: 0,
        truncated: false,
        latencyMs: elapsed(),
      });
    }

    // The pre-flight block is inside a try/catch and reads through the coercers
    // above for the same reason the rest of this method is defensive: the
    // never-rejects contract is a RUNTIME guarantee, and CP3's MCP dispatch
    // feeds agent-supplied JSON into `SpecSearchRequest` where TypeScript
    // cannot vouch for a single field. `{ query: 42 }` and
    // `{ spaceKeys: 5 }` both used to reject out of here.
    let built: SpecCqlResult;
    let loss: CqlInputLoss;
    let deniedSpaceKeys: string[];
    let requestedSpaceKeys: string[];
    try {
      requestedSpaceKeys = coerceSpaceKeys(request.spaceKeys);
      const resolved = this.resolveSpaceKeys(requestedSpaceKeys);
      deniedSpaceKeys = resolved.denied;
      const cqlInput: SpecCqlInput = {
        query: coerceQueryText(request.query),
        spaceKeys: resolved.spaceKeys,
      };
      built = buildSpecSearchCql(cqlInput);
      // Honest reporting of what the CQL caps discarded, mirroring
      // `buildSentryQuery`, which gaps whenever a requested join key is dropped.
      loss = describeCqlInputLoss(cqlInput);
    } catch {
      return knowledgeResult([], [unusableInputGap()], {
        fetched: 0,
        returned: 0,
        truncated: false,
        latencyMs: elapsed(),
      });
    }

    if (!built.ok) {
      return knowledgeResult(
        [],
        [
          knowledgeGap({
            kind: "empty-query",
            reason:
              "confluence: the search text was empty after sanitization; nothing to look up",
            suggestion:
              "describe the behavior in words — punctuation and operators are stripped before searching",
          }),
        ],
        { fetched: 0, returned: 0, truncated: false, latencyMs: elapsed() },
      );
    }

    if (loss.queryTruncated) {
      gaps.push(
        knowledgeGap({
          kind: "input-truncated",
          // MAX_QUERY_LENGTH is the cap, in CODE POINTS. Reporting
          // `sanitizedQuery.length` named UTF-16 code units instead, so an
          // astral-heavy query claimed "truncated to 767 characters" against a
          // 512 cap.
          reason: `confluence: the search text was truncated to the first ${MAX_QUERY_LENGTH} characters before searching`,
          suggestion:
            "shorten the query to the distinctive terms; the tail was not searched",
        }),
      );
    }
    if (loss.droppedSpaceKeys > 0) {
      gaps.push(
        knowledgeGap({
          kind: "input-truncated",
          reason: `confluence: ${loss.droppedSpaceKeys} requested space key(s) were dropped as malformed or over the limit; searched ${
            built.spaceKeys.length > 0
              ? built.spaceKeys.join(", ")
              : "all spaces"
          }`,
          suggestion:
            "space keys must be alphanumeric or underscore; check the allowlist",
        }),
      );
    }
    if (deniedSpaceKeys.length > 0) {
      // The operator ceiling denied caller keys. This used to be the ONE
      // clipping path that reported nothing, because `describeCqlInputLoss`
      // only ever sees the resolved list — the caller got results from a space
      // it never asked for and was told nothing about the substitution.
      gaps.push(
        knowledgeGap({
          kind: "input-truncated",
          reason: `confluence: ${deniedSpaceKeys.length} requested space key(s) are outside the operator allowlist and were not searched (${deniedSpaceKeys.join(
            ", ",
          )}); searched ${
            built.spaceKeys.length > 0
              ? built.spaceKeys.join(", ")
              : "all spaces"
          }`,
          suggestion: `the ${CONFLUENCE_SPACE_KEYS_ENV} allowlist is a ceiling a caller can only narrow; ask the operator to widen it`,
        }),
      );
    }

    // `Math.trunc(NaN)` is `NaN`, and the clamp propagates it: `limit=NaN` went
    // on the wire and `rows.slice(0, NaN)` returned `[]`, so the oracle
    // reported "no documented intent was found" while holding the rows it had
    // just fetched. A false negative is the worst possible failure for a spec
    // oracle, so a non-finite limit falls back to the default.
    const requestedLimit = request.limit;
    const limit = Number.isFinite(requestedLimit)
      ? Math.min(
          MAX_SPEC_LIMIT,
          Math.max(1, Math.trunc(requestedLimit as number)),
        )
      : DEFAULT_SPEC_LIMIT;

    let url: string;
    try {
      url =
        `${this.baseUrl}/rest/api/content/search` +
        `?cql=${encodeURIComponent(stripLoneSurrogates(built.cql))}` +
        `&limit=${limit}&expand=${encodeURIComponent(SEARCH_EXPAND)}`;
    } catch {
      // Unencodable input. Cannot happen for surrogates (scrubbed above); this
      // exists so no future input shape can turn the encode into a throw.
      return knowledgeResult([], [...gaps, this.encodeFailedGap()], {
        fetched: 0,
        returned: 0,
        truncated: false,
        latencyMs: elapsed(),
      });
    }

    // An ALREADY-aborted signal never fires `abort` again, so the listener
    // below would never run and egress would happen after the caller had
    // already cancelled. Check the flag, not just the event.
    if (signal?.aborted) {
      return knowledgeResult([], [...gaps, this.cancelledGap()], {
        fetched: 0,
        returned: 0,
        truncated: false,
        latencyMs: elapsed(),
      });
    }

    const controller = new AbortController();
    let callerAborted = false;
    const onAbort = () => {
      callerAborted = true;
      controller.abort();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    let payload: ConfluenceSearchResponse;
    try {
      const res = await this.fetchImpl(url, {
        headers: {
          // The credential lives ONLY here — never in a gap, message, or excerpt.
          Authorization: this.authorization,
          Accept: "application/json",
          "User-Agent": CRUMBTRAIL_USER_AGENT,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        throw new ConfluenceError(
          res.status,
          `Confluence search failed with HTTP ${res.status}: ${sanitizeUrl(url)}`,
        );
      }
      payload = await this.readBoundedJson(res);
    } catch (error) {
      return knowledgeResult(
        [],
        [...gaps, this.errorGap(error, timedOut, callerAborted)],
        {
          fetched: 0,
          returned: 0,
          truncated: false,
          latencyMs: elapsed(),
        },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    const rows = Array.isArray(payload?.results) ? payload.results : [];
    // `?? this.baseUrl` only defends against null/undefined. A non-string `base`
    // (Confluence is not the only thing that can answer on that URL) flowed
    // straight into `redactUrl`, which called `url.trim()` and threw.
    const rawBase = payload?._links?.base;
    const base =
      typeof rawBase === "string" && rawBase.length > 0
        ? rawBase
        : this.baseUrl;
    const now = clock();

    let truncated = false;
    const excerpts: SpecExcerpt[] = [];
    for (const row of rows.slice(0, limit)) {
      // Per-row try/catch: one hostile or broken row must not lose the rows
      // around it, and must never escape as a rejection. A row can throw on
      // plain property access — a getter in a deserialized payload, a Proxy —
      // so field-level type guards alone are not sufficient.
      let normalized: { excerpt: SpecExcerpt; truncated: boolean } | null;
      try {
        normalized = this.normalizeRow(row, base, now, built.sanitizedQuery);
      } catch {
        continue;
      }
      if (!normalized) continue;
      if (normalized.truncated) truncated = true;
      excerpts.push(normalized.excerpt);
    }

    if (excerpts.length === 0) {
      gaps.push(
        knowledgeGap({
          kind: "no-results",
          reason: `confluence: no pages matched "${built.sanitizedQuery}"`,
          suggestion:
            "no documented intent was found — this is an answer, not a failure",
        }),
      );
    }

    return knowledgeResult(excerpts, gaps, {
      fetched: rows.length,
      returned: excerpts.length,
      truncated,
      latencyMs: elapsed(),
    });
  }

  /**
   * One search row → one redacted {@link SpecExcerpt}, or `null` when the row
   * carries no usable body. Redaction happens here, before the excerpt exists as
   * a returned value, so there is no window in which unredacted page text is
   * reachable.
   */
  private normalizeRow(
    row: ConfluenceSearchRow,
    base: string,
    now: number,
    sanitizedQuery: string,
  ): { excerpt: SpecExcerpt; truncated: boolean } | null {
    // `ConfluenceSearchRow` is a claim about JSON off the wire, not a checked
    // fact. `{"results":[null]}` is malformed JSON that the file header already
    // promises to cover, and `row.body` on it threw rather than gapping —
    // optional chaining guards `body` being absent, not `row` being null.
    if (row === null || typeof row !== "object") return null;

    const bodyHtml = row.body?.view?.value;
    if (typeof bodyHtml !== "string" || bodyHtml.length === 0) return null;

    const boundedHtml = capExcerptBytes(bodyHtml, MAX_HTML_BYTES);
    const text = htmlToText(boundedHtml.text);
    if (text.length === 0) return null;

    const matchedContext = matchedExcerptContext(text, sanitizedQuery);
    const capped = capExcerptBytes(matchedContext.text, MAX_EXCERPT_BYTES);
    // Redaction runs AFTER the byte cap so the cap governs page bytes, not
    // redaction-marker bytes, and BEFORE anything is returned.
    const excerptText = redactText(capped.text, "excerpts[].excerpt");

    const when = row.version?.when;
    const parsed = typeof when === "string" ? Date.parse(when) : NaN;
    const lastModified = Number.isNaN(parsed) ? 0 : parsed;

    const excerpt: SpecExcerpt = {
      // `?? "Untitled page"` only covers null/undefined; a numeric title reached
      // `redactText` and threw on `body.trim()`. Anything non-string is not a
      // title, so it takes the same path as a missing one.
      title: redactText(
        typeof row.title === "string" && row.title.length > 0
          ? row.title
          : "Untitled page",
        "excerpts[].title",
      ),
      url: pageUrl(row, base),
      spaceKey: typeof row.space?.key === "string" ? row.space.key : "",
      excerpt: excerptText,
      lastModified,
      ageDays: deriveAgeDays(lastModified, now),
    };
    const author = row.version?.by?.displayName;
    if (typeof author === "string" && author.length > 0) {
      excerpt.lastModifiedBy = author;
    }
    return {
      excerpt,
      truncated:
        boundedHtml.truncated || matchedContext.truncated || capped.truncated,
    };
  }

  /** Parse a successful response only after enforcing its byte ceiling. */
  private async readBoundedJson(
    response: Response,
  ): Promise<ConfluenceSearchResponse> {
    const declaredLength = this.contentLength(response);
    if (
      declaredLength !== undefined &&
      declaredLength > MAX_CONFLUENCE_RESPONSE_BYTES
    ) {
      void response.body?.cancel().catch(() => undefined);
      throw new ConfluenceResponseTooLargeError();
    }

    // The injected legacy fixture seam supplies only `json()`. Production
    // fetch always returns a readable body; retaining this fallback keeps that
    // narrow test seam usable without weakening real network handling.
    if (!response.body) {
      return (await response.json()) as ConfluenceSearchResponse;
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_CONFLUENCE_RESPONSE_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // The size violation still wins if a broken stream rejects its
            // cancellation; never surface that provider-controlled error.
          }
          throw new ConfluenceResponseTooLargeError();
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    return JSON.parse(
      Buffer.concat(chunks, bytes).toString("utf8"),
    ) as ConfluenceSearchResponse;
  }

  private contentLength(response: Response): number | undefined {
    const value = response.headers?.get("content-length");
    if (value === null || value === undefined) return undefined;
    const bytes = Number(value);
    return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : undefined;
  }

  /**
   * The caller cancelled. Distinct from {@link errorGap}'s timeout branch: the
   * budget was never exceeded, so reporting "did not complete within 30000ms"
   * would blame the provider for the caller's own abort.
   */
  private cancelledGap(): EvidenceGap {
    return knowledgeGap({
      kind: "request-failed",
      reason: "confluence: the search was cancelled by the caller",
      suggestion: "issue the lookup again with a signal that is not aborted",
    });
  }

  /** The CQL could not be URL-encoded at all. Unreachable in practice. */
  private encodeFailedGap(): EvidenceGap {
    return knowledgeGap({
      kind: "request-failed",
      reason:
        "confluence: the search text could not be encoded for the request",
      suggestion: "describe the behavior in plain words and try again",
    });
  }

  /** A configured operator allowlist was malformed or sanitized away. */
  private invalidAllowlistGap(): EvidenceGap {
    return knowledgeGap({
      kind: "request-failed",
      reason: `confluence: ${CONFLUENCE_SPACE_KEYS_ENV} is invalid; no search was sent`,
      suggestion:
        "set a non-empty comma-separated list of alphanumeric or underscore space keys",
    });
  }

  /**
   * Map a caught failure to its gap. The thrown message is already sanitized to
   * status + origin + path by {@link ConfluenceError}; a network error's message
   * is not reused at all, because a transport-layer message can echo back the
   * request URL in shapes we do not control.
   */
  private errorGap(
    error: unknown,
    timedOut: boolean,
    callerAborted: boolean,
  ): EvidenceGap {
    if (error instanceof ConfluenceResponseTooLargeError) {
      return knowledgeGap({
        kind: "request-failed",
        reason: "confluence: search response exceeded the 1 MiB safety limit",
        suggestion:
          "narrow the query or space allowlist, then retry the lookup",
      });
    }
    if (error instanceof ConfluenceError) {
      if (error.status === 401 || error.status === 403) {
        return knowledgeGap({
          kind: "auth-failed",
          reason: `confluence: authentication rejected (HTTP ${error.status})`,
          suggestion: `check ${CONFLUENCE_EMAIL_ENV} and ${CONFLUENCE_API_TOKEN_ENV}, and that the account can read the configured spaces`,
        });
      }
      return knowledgeGap({
        kind: "request-failed",
        reason: `confluence: search failed (HTTP ${error.status})`,
        suggestion: `check ${CONFLUENCE_BASE_URL_ENV} points at the wiki root`,
      });
    }
    if (timedOut) {
      return knowledgeGap({
        kind: "timeout",
        reason: `confluence: search did not complete within ${this.timeoutMs}ms`,
        suggestion: "retry, or narrow the query with a space allowlist",
      });
    }
    // An `AbortError` with the timer never having fired is the CALLER's abort.
    // Routing it to the timeout gap reported a budget overrun that never
    // happened.
    if (
      callerAborted ||
      (error instanceof Error && error.name === "AbortError")
    ) {
      return this.cancelledGap();
    }
    return knowledgeGap({
      kind: "request-failed",
      reason: "confluence: search could not be completed",
      suggestion: `check ${CONFLUENCE_BASE_URL_ENV} and network egress to the wiki host`,
    });
  }
}
