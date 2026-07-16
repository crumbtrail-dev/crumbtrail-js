// Advisory ticket comment builder. Turns a located/assembled bundle result into
// provider neutral plain text paragraphs. Per VISION this is a CONSULTANT's note, never a verdict: it says what
// evidence was found and links to the full bundle, but it NEVER claims the bug is
// fixed/verified/reproduced and NEVER emits a boolean pass/fail. The branch is
// driven purely by the locate outcome ("matched" vs "inconclusive"); the raw
// confidence float is used ONLY to render a rounded display percentage and is
// never equality-compared.

/** The subset of the locate envelope this builder reads. `outcome` is the only
 *  signal that flips the comment shape; `confidence` is display-only. */
export interface AdvisoryCommentMatch {
  outcome: "matched" | "ambiguous" | "inconclusive";
  confidence: number;
  reasons?: string[];
  candidates?: Array<{
    sessionId: string;
    confidence: number;
  }>;
}

/** One evidence gap surfaced from the bundle (mirrors core's EvidenceGap). */
export interface AdvisoryCommentGap {
  lane?: string;
  reason: string;
  suggestion?: string;
}

/**
 * Correlation keys carried INTO the ticket so the reader can line the matched
 * incident up against their own logs/traces. Every value here must come from the
 * located evidence — NEVER fabricated. Rendered only in the matched variant.
 */
export interface AdvisoryCommentCorrelation {
  /** The located session id (match.sessionId). */
  sessionId?: string;
  /** Distinct request/trace ids pulled from the bundle's evidence refs. */
  requestIds?: string[];
}

export interface BuildAdvisoryCommentInput {
  match: AdvisoryCommentMatch;
  /** Public link to the persisted bundle (`/api/bundles/:id`). Always rendered. */
  bundleUrl: string;
  /** Public session page collection URL, for example `https://app.example/sessions`. */
  sessionUrlBase?: string;
  gaps?: AdvisoryCommentGap[];
  /** Correlation keys from the located evidence (matched variant only). */
  correlation?: AdvisoryCommentCorrelation;
}

/**
 * Map an internal recall/locate reason CODE to a human-readable phrase. The
 * scorer emits terse tags ("semantic", "same-route", "time-proximity", …) that
 * are meaningful to us but opaque on a ticket; this turns them into plain
 * language. Codes are the exact strings emitted by scoreLocalIssue()
 * (packages/node/src/recall.ts) and locateIncident()
 * (packages/node/src/locate-incident.ts). Any unrecognized value passes through
 * unchanged so a free-text or future reason is never dropped or mangled.
 */
const REASON_PHRASES: Record<string, string> = {
  semantic: "wording overlap with the captured incident",
  "same-route": "same route",
  "same-error": "same error signature",
  "env-overlap": "shared environment or configuration",
  "time-proximity": "occurred near the report time",
  "release-hint": "same release",
};

function humanizeReason(reason: string): string {
  return REASON_PHRASES[reason] ?? reason;
}

import type { TicketComment } from "./clients";

/**
 * Render the confidence float as a whole-number percentage for DISPLAY ONLY.
 * Never compare this (or the underlying float) with === to gate behavior — the
 * outcome field is the decision signal. Clamped to [0, 100] so a stray value
 * can't produce a nonsensical string.
 */
function confidencePercent(confidence: number): number {
  const pct = Math.round(confidence * 100);
  if (Number.isNaN(pct)) return 0;
  return Math.min(100, Math.max(0, pct));
}

/**
 * Build the correlation-key bullet lines (`Session: <id>`, `Request: <id>` …).
 * Filters empties, dedupes request ids, and caps them at 3 (defense-in-depth —
 * the webhook caller already dedupes/caps) so a runaway evidence set can't bloat
 * the comment. Returns [] when there is nothing real to show, so the caller
 * simply omits the block rather than fabricating keys.
 */
function correlationLines(
  correlation: AdvisoryCommentCorrelation | undefined,
): string[] {
  if (!correlation) return [];
  const items: string[] = [];
  const sessionId =
    typeof correlation.sessionId === "string"
      ? correlation.sessionId.trim()
      : "";
  if (sessionId) items.push(`Session: ${sessionId}`);
  const seen = new Set<string>();
  for (const raw of correlation.requestIds ?? []) {
    if (typeof raw !== "string") continue;
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    items.push(`Request: ${id}`);
    if (seen.size >= 3) break;
  }
  return items;
}

function appendGapParagraphs(
  paragraphs: string[],
  gaps: AdvisoryCommentGap[],
): void {
  const namedGaps = gaps.filter(
    (gap) =>
      gap && typeof gap.reason === "string" && gap.reason.trim().length > 0,
  );
  if (namedGaps.length > 0) {
    paragraphs.push(
      "What is missing:",
      ...namedGaps.map((gap) =>
        gap.suggestion ? `${gap.reason}: ${gap.suggestion}` : gap.reason,
      ),
    );
  }
}

function candidateSessionLink(
  sessionUrlBase: string | undefined,
  sessionId: string,
): string {
  const base = sessionUrlBase?.trim().replace(/\/+$/, "");
  return base ? `${base}/${encodeURIComponent(sessionId)}` : sessionId;
}

/**
 * Build the advisory plain text comment. Three shapes, chosen by `match.outcome`:
 *
 * - matched: names that a candidate incident was located, shows the rounded
 *   confidence as an advisory percentage, lists the match reasons in plain
 *   language (if any), carries the correlation keys (located session + up to a
 *   few request/trace ids, when the evidence has them) onto the ticket, and
 *   links the full evidence bundle.
 * - inconclusive: states honestly that no recorded incident matched, lists the
 *   evidence gaps (if any) so the reader knows what is missing, and still links
 *   the (empty) bundle. It fabricates no match and reports no percentage.
 * - ambiguous: lists close candidate sessions without asserting that any one
 *   session is the incident, then renders the same gap guidance and bundle link.
 *
 * Pure and side-effect free — unit-testable in isolation.
 */
export function buildAdvisoryComment(
  input: BuildAdvisoryCommentInput,
): TicketComment {
  const { match, bundleUrl } = input;
  const gaps = input.gaps ?? [];
  const paragraphs: string[] = [];

  if (match.outcome === "matched") {
    paragraphs.push(
      "Crumbtrail located a candidate incident that likely matches this ticket.",
      `Match confidence: ${confidencePercent(match.confidence)}% (advisory, review the evidence before acting).`,
    );
    const reasons = (match.reasons ?? []).filter(
      (reason) => typeof reason === "string" && reason.trim().length > 0,
    );
    if (reasons.length > 0) {
      paragraphs.push("Why this was matched:", ...reasons.map(humanizeReason));
    }
    // Correlation keys: carry the located session + request/trace ids onto the
    // ticket so the reader can line the incident up against their logs/traces.
    // Only rendered from keys the evidence actually carries — never fabricated.
    const correlationItems = correlationLines(input.correlation);
    if (correlationItems.length > 0) {
      paragraphs.push(
        "Correlation keys (match these against your logs and traces):",
        ...correlationItems,
      );
    }
    paragraphs.push(`View the full evidence bundle: ${bundleUrl}`);
    return { paragraphs };
  }

  if (match.outcome === "ambiguous") {
    const candidates = (match.candidates ?? []).filter(
      (candidate) =>
        candidate &&
        typeof candidate.sessionId === "string" &&
        candidate.sessionId.trim().length > 0 &&
        typeof candidate.confidence === "number",
    );
    paragraphs.push(
      `Crumbtrail found ${candidates.length} candidate sessions for this ticket but none is conclusive.`,
      ...candidates.map(
        (candidate) =>
          `Candidate session: ${candidateSessionLink(input.sessionUrlBase, candidate.sessionId)} (confidence ${confidencePercent(candidate.confidence)}%)`,
      ),
    );
    appendGapParagraphs(paragraphs, gaps);
    paragraphs.push(
      "Review the candidates before acting.",
      `Open the evidence bundle: ${bundleUrl}`,
    );
    return { paragraphs };
  }

  // inconclusive: honest, gaps only, no fabricated match.
  paragraphs.push(
    "Crumbtrail could not locate a recorded incident matching this ticket yet.",
  );
  appendGapParagraphs(paragraphs, gaps);
  paragraphs.push(`Open the evidence bundle: ${bundleUrl}`);
  return { paragraphs };
}
