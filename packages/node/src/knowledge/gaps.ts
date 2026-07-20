/**
 * Gap vocabulary for the Confluence spec oracle (pure — no I/O, no env, no
 * network).
 *
 * The spec oracle is **not** an evidence adapter, but it borrows the adapter
 * framework's degradation discipline verbatim: not configured, auth failure,
 * timeout, and zero results are all reported as gaps, never thrown. That is why
 * `KnowledgeResult.gaps` reuses `EvidenceGap` from `crumbtrail-core` instead of
 * introducing a parallel type — a caller that already knows how to read gaps
 * off an evidence bundle reads these the same way.
 *
 * What it does **not** borrow is registration: nothing here is consumed by
 * `fetch-all.ts`, `assembleBundle`, or `EVIDENCE_SOURCE_PROVIDERS`.
 *
 * @see docs/specs/2026-07-19-confluence-spec-oracle-design.md
 */
import type { EvidenceGap } from "crumbtrail-core";

/**
 * The lane every knowledge gap carries.
 *
 * Design decision D4. `EvidenceGap.lane` is typed `EvidenceLane`, and the
 * design explicitly rejects adding a `docs` value to that union — a new lane
 * would leak the spec oracle into the evidence taxonomy and into every
 * exhaustive switch over lanes downstream. `code` is used instead: documentation
 * describes intended code behavior, so it is the closest existing value.
 *
 * The field is inert in this contract regardless. A `KnowledgeResult`
 * returns directly to the `searchSpecs` caller and never enters
 * `assembleBundle`, so nothing downstream ever reads this lane to compute lane
 * breadth, `contextCompleteness`, or a capture directive.
 */
export const KNOWLEDGE_GAP_LANE = "code" as const;

/**
 * Why the oracle could not answer. Severity is not encoded per kind at the call
 * site: {@link HARD_FAILURES} holds the single classification, and
 * {@link knowledgeGap} is its only reader.
 */
export type KnowledgeGapKind =
  | "not-configured"
  | "auth-failed"
  | "timeout"
  | "request-failed"
  | "empty-query"
  | "no-results"
  | "input-truncated";

/**
 * Kinds that are HARD failures: the oracle could not consult the provider at
 * all and self-degraded instead of throwing. These carry
 * `kind: "source-unavailable"`.
 *
 * Note what is absent. `"no-results"` is a successful lookup that found nothing
 * — "no documented intent exists for this behavior" is a real and useful
 * answer, and marking it unavailable would tell the caller the oracle is broken
 * when it is working correctly. `"empty-query"` is likewise a caller-side input
 * problem, not a provider outage, and `"input-truncated"` is the oracle
 * reporting that it clipped the caller's own input before searching — the
 * lookup still ran and its answer is still real, just narrower than asked for.
 */
const HARD_FAILURES: ReadonlySet<KnowledgeGapKind> = new Set([
  "not-configured",
  "auth-failed",
  "timeout",
  "request-failed",
]);

export interface KnowledgeGapInput {
  kind: KnowledgeGapKind;
  /** Human-facing explanation, e.g. "Confluence credentials are not configured". */
  reason: string;
  /** Optional next action for the reader, e.g. which env vars to set. */
  suggestion?: string;
}

/**
 * Build an {@link EvidenceGap} for the knowledge surface.
 *
 * `kind: "source-unavailable"` is attached if and only if {@link KnowledgeGapInput.kind}
 * is a hard failure; informational gaps omit the marker entirely, which is the
 * additive default the field documents.
 */
export function knowledgeGap(input: KnowledgeGapInput): EvidenceGap {
  const gap: EvidenceGap = {
    lane: KNOWLEDGE_GAP_LANE,
    reason: input.reason,
  };
  if (input.suggestion !== undefined) gap.suggestion = input.suggestion;
  if (HARD_FAILURES.has(input.kind)) gap.kind = "source-unavailable";
  return gap;
}
