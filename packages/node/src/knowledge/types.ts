/**
 * `knowledge.v1` — the spec-oracle contract and its pure derivations (no I/O,
 * no env, no network). The one exception to "pure" is {@link systemClock},
 * which reads wall time and exists so callers have something to inject.
 *
 * This is the "what was supposed to happen?" surface. It is deliberately **not**
 * an evidence adapter and this directory is deliberately not
 * `evidence-sources/`, because three properties of `evidence-source.v1` do not
 * hold for documentation:
 *
 * 1. **Adapters are time-windowed.** `EvidenceQuery` carries
 *    `window: { start, end }` and every adapter filters by it. A runbook written
 *    two years before the incident is maximally relevant and has no temporal
 *    relationship to the window at all — a Confluence adapter would have to
 *    accept the window and deliberately ignore it, making the contract a lie.
 * 2. **Adapter join keys are correlational.** `EvidenceJoinKey` selects by
 *    identity (`traceId`, `sessionId`, `release`, …). Documentation joins on
 *    meaning, so none of those keys select the right page.
 * 3. **Adapter output is ranked once, downstream, by `assembleBundle`.** That
 *    fusion path is tuned for causal telemetry and derives `LOW_CONTEXT` from
 *    lane breadth and item volume. Feeding it undated prose would let a long
 *    design doc inflate context-completeness without contributing causal signal.
 *
 * A {@link KnowledgeResult} therefore returns straight to its caller (the
 * `searchSpecs` MCP tool). It never enters `assembleBundle`, never registers
 * with `evidenceSourcesFromEnv`, and never appears in `EVIDENCE_SOURCE_PROVIDERS`.
 *
 * Results are **advisory only** (design decision D1): a page saying "this is
 * intended" annotates a diagnosis, it never suppresses one. Pages outlive the
 * behavior they describe, so staleness is surfaced to the caller via
 * {@link SpecExcerpt.lastModified} / {@link SpecExcerpt.ageDays} rather than
 * reasoned about internally.
 *
 * @see docs/specs/2026-07-19-confluence-spec-oracle-design.md
 */
import type { EvidenceGap } from "crumbtrail-core";

/**
 * Schema version string const, matching the repo convention
 * (`evidence.v1` / `fusion.v1` / `evidence-source.v1` / `fix-context.v1`).
 */
export const KNOWLEDGE_SCHEMA_VERSION = "knowledge.v1" as const;

/** Milliseconds in a day, used for the {@link SpecExcerpt.ageDays} derivation. */
const MS_PER_DAY = 86_400_000;

/**
 * One matched region of one documentation page, carrying enough provenance for
 * a human to verify it and enough staleness metadata for an agent to discount
 * it.
 */
export interface SpecExcerpt {
  /** Page title as the provider reports it. */
  title: string;
  /** Absolute deep link back to the page — provenance, always present. */
  url: string;
  /** Provider space key the page lives in, e.g. `"ENG"`. */
  spaceKey: string;
  /** The matched region of the page body, capped and redacted upstream. */
  excerpt: string;
  /** ms epoch of the page's last edit. */
  lastModified: number;
  /** Display name of the last editor, when the provider reports one. */
  lastModifiedBy?: string;
  /**
   * Whole days between {@link lastModified} and "now". Derived rather than
   * reported by the provider, and surfaced as its own field so staleness is
   * unmissable to an agent that reads only the excerpt list.
   */
  ageDays: number;
}

/**
 * The `searchSpecs` return shape. Structurally parallel to
 * `EvidenceSourceResult` — same `gaps` type, same `stats` block — because the
 * degradation discipline is identical (never throw, always report), but
 * intentionally a separate contract so it cannot be mistaken for evidence.
 */
export interface KnowledgeResult {
  schemaVersion: typeof KNOWLEDGE_SCHEMA_VERSION;
  /** Matched documentation, ordered by provider recency. Never ranked. */
  excerpts: SpecExcerpt[];
  /**
   * Reuses `EvidenceGap` from `crumbtrail-core` rather than introducing a
   * parallel type. Not configured, auth failure, timeout, and zero results are
   * all gaps, never throws — "no documented intent found" is a useful answer.
   */
  gaps: EvidenceGap[];
  stats: {
    provider: "confluence";
    fetched: number;
    returned: number;
    truncated: boolean;
    latencyMs: number;
  };
}

/**
 * Injectable clock returning ms epoch. Every derivation that needs "now" takes
 * one as a **required** argument, so no code path in this directory reaches for
 * a bare `Date.now()` and tests can pin time without faking timers.
 */
export type KnowledgeClock = () => number;

/**
 * The system clock. The only place in this directory that reads wall time, and
 * deliberately *not* a default parameter anywhere — a default would let a call
 * site silently forget to thread the clock, compile clean, and still pass
 * clock-pinned tests. Composition roots pass `systemClock()` explicitly.
 */
export const systemClock: KnowledgeClock = () => Date.now();

/**
 * Derive {@link SpecExcerpt.ageDays} from a page's last-edit timestamp against
 * an injected `now`. `now` is required, not defaulted — see {@link systemClock}.
 *
 * Floors to whole days, so a page edited four hours ago is `0` days old. Clamps
 * at `0`: a provider clock ahead of ours would otherwise produce a negative age
 * that reads as "edited in the future" and undermines the staleness signal.
 * Non-finite input yields `0` rather than `NaN`, keeping the field safe to
 * serialize.
 */
export function deriveAgeDays(lastModified: number, now: number): number {
  if (!Number.isFinite(lastModified) || !Number.isFinite(now)) return 0;
  return Math.max(0, Math.floor((now - lastModified) / MS_PER_DAY));
}
