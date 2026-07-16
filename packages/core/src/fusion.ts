import type { EvidenceItem, EvidenceLane, IntentSignal } from "./evidence";
import { tokenize } from "./tokenize";

/**
 * @stability stable
 * Version-bump policy (additive-on-v1 vs fusion.v2) is War-game 01 Fork A's
 * decision, not this file's — see wargames/wargames/01-solve-context-wargame-fields.md.
 */
export const FUSION_SCHEMA_VERSION = "fusion.v1" as const;

export type HypothesisKind =
  | "regression"
  | "latent"
  | "environment"
  | "client-side"
  | "intentional-change"
  | "inconclusive";

export interface Symptom {
  title: string;
  description?: string;
  release?: string;
  url?: string;
  user?: string;
  errorSig?: string;
  source?: string;
}

export interface Hypothesis {
  kind: HypothesisKind;
  /** 0..1 advisory confidence. Not a probability; a ranking signal. */
  confidence: number;
  rationale: string;
  /** EvidenceItem.id values backing this hypothesis. */
  evidenceIds: string[];
  /**
   * Advisory, additive: concrete observations that would confirm a fix for
   * THIS hypothesis worked. Emitted only for non-inconclusive hypotheses whose
   * cited evidence carries a concrete anchor (signature / requestId /
   * table+pk); absent otherwise. Sparse-and-concrete by design — never vacuous
   * prose like "verify the bug is gone". See {@link Verification}.
   */
  verification?: Verification[];
}

/**
 * A concrete, post-fix observation that would confirm a hypothesis's fix
 * worked. `observation` always names a concrete signal (an error signature, a
 * request id, or a table + primary key) — the derivation emits nothing when it
 * cannot anchor to one, so an emitted verification is never a vacuous
 * restatement.
 */
export interface Verification {
  /** Names a concrete signal — signature, request id, or table/pk. */
  observation: string;
  /** EvidenceItem.id values this observation is anchored to. */
  evidenceIds: string[];
  how: "session" | "request" | "db";
}

/**
 * Where the incident was located, when a locate ran. Advisory and optional
 * (absent for explicit baseline/current comparison bundles that never locate).
 * Shape shared with the node locate engine's `LocateMatch` and War-game 02's
 * deterministic token join — `method` distinguishes the two so 02 can populate
 * "token" without a schema change (War-game 02 Fork C: one definition, reused).
 */
export interface Located {
  outcome: "matched" | "ambiguous" | "inconclusive";
  /** 0..1 locate confidence. */
  confidence: number;
  /**
   * How the incident was located. "fuzzy" = the scored locate engine;
   * "token" = a deterministic token join (War-game 02). Absent when a caller
   * supplies neither.
   */
  method?: "fuzzy" | "token";
  /** The matched session, present ONLY when outcome === "matched". Never fabricated. */
  sessionId?: string;
  reasons?: string[];
  /** Compact candidate projection for an ambiguous locate. */
  candidates?: Array<{
    sessionId: string;
    bugId: string;
    confidence: number;
    reasons: string[];
  }>;
}

/**
 * Bundle-level answer to "how much context do we actually have here?" — the
 * LOW_CONTEXT signal. Derived purely from the assembled bundle (evidence
 * lanes, gaps, hypothesis strength, locate confidence). Advisory: it NEVER
 * gates or blocks bundle emission. `reasons` is the load-bearing part; `score`
 * and `level` summarize it.
 */
export interface ContextCompleteness {
  /** 0..1; higher = richer, more actionable context. */
  score: number;
  level: "high" | "medium" | "low";
  /** Human-legible drivers: missing lanes, thin evidence, inconclusive locate. */
  reasons: string[];
}

/**
 * Consumer-side advisory: what the CONSUMING agent should do when context is
 * thin. Distinct from {@link EvidenceGap} (capture-side: what evidence is
 * missing) — escalation is what to do about it. Always present; `recommended`
 * is false with an empty `when` when context is adequate. Never gates the
 * bundle (VISION: advisory, never a boolean verdict on the bug itself).
 */
export interface Escalation {
  recommended: boolean;
  /** Conditions phrased for the consuming agent, e.g. "if you cannot reproduce
   *  via the anchored request, stop and request human triage". */
  when: string[];
}

export interface EvidenceGap {
  lane: EvidenceLane;
  reason: string;
  suggestion?: string;
  /**
   * Optional structured severity marker. Additive and defaults to an ordinary
   * informational gap when absent (e.g. a missing join key, or a partial
   * enrichment/secondary gap) — those never affect a source's health.
   *
   * `"source-unavailable"` marks a HARD failure: the adapter could not deliver
   * its primary evidence at all (dispatch/auth failure, or a timeout that
   * retrieved zero items) and self-degraded to a gap instead of throwing. The
   * evidence framework reads this typed marker — never the free-text `reason` —
   * to decide `stats.ok`, so a self-degrading source and a throwing source emit
   * the same health signal. See node `fetch-all.ts`.
   */
  kind?: "source-unavailable";
}

export interface CaptureDirective {
  /** The bug signature this raises capture for. */
  signature: string;
  /** Lanes to collect more deeply next time. */
  raise: EvidenceLane[];
  scope: "signature" | "session";
  reason: string;
}

export interface RankedBundle {
  schemaVersion: typeof FUSION_SCHEMA_VERSION;
  symptom: Symptom;
  /** Complete, neutral evidence in ranked order. Never filtered. */
  evidence: EvidenceItem[];
  /** Advisory only. Consumers may ignore and use evidence directly. */
  opinion: { stance: "advisory"; hypotheses: Hypothesis[] };
  gaps: EvidenceGap[];
  /** Advisory-only: suggested capture escalations when evidence is thin. */
  directives: CaptureDirective[];
  /** How much actionable context this bundle carries. Advisory, never gates. */
  contextCompleteness: ContextCompleteness;
  /** What the consuming agent should do when context is thin. Advisory. */
  escalation: Escalation;
  /** Where the incident was located, when a locate ran. Absent otherwise. */
  located?: Located;
}

export interface AssembleBundleInput {
  symptom: Symptom;
  evidence: EvidenceItem[];
  intent: IntentSignal[];
  gaps?: EvidenceGap[];
  /** The locate decision, when one ran (auto-locate / token join). Threaded
   *  onto the bundle as {@link RankedBundle.located} and folded into
   *  completeness. Omit for explicit baseline/current comparison bundles. */
  located?: Located;
}

/**
 * Compose the RankedBundle: rank the complete evidence set (nothing dropped),
 * classify advisory hypotheses, and pass through any evidence gaps. Pure.
 */
export function assembleBundle(input: AssembleBundleInput): RankedBundle {
  const evidence = rankEvidence(input.symptom, input.evidence);
  const classified = classifyHypotheses(
    input.symptom,
    input.evidence,
    input.intent,
  );
  const gaps = input.gaps ?? [];
  const located = input.located;

  // Move 4: attach concrete post-fix verification observations per hypothesis,
  // anchored to evidence signals. Vacuous-by-design impossible: emitted only
  // for anchored evidence kinds (see deriveVerification).
  const hypotheses = classified.map((hypothesis) => {
    const verification = deriveVerification(hypothesis, evidence);
    return verification.length > 0
      ? { ...hypothesis, verification }
      : hypothesis;
  });

  const contextCompleteness = deriveContextCompleteness(
    evidence,
    gaps,
    hypotheses,
    located,
  );
  const escalation = deriveEscalation(contextCompleteness, hypotheses);

  return {
    schemaVersion: FUSION_SCHEMA_VERSION,
    symptom: input.symptom,
    evidence,
    opinion: { stance: "advisory", hypotheses },
    gaps,
    directives: suggestCaptureDirectives(input.symptom, input.evidence, gaps),
    contextCompleteness,
    escalation,
    ...(located ? { located } : {}),
  };
}

// --- war-game-grade advisory fields (Mission 01) --------------------------

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/** Informative lanes for completeness breadth — the lanes that actually
 *  discriminate a cause. Mirrors {@link INFORMATIVE_LANES} intent but includes
 *  `env` since a present env difference is real context. */
const COMPLETENESS_LANES: EvidenceLane[] = [
  "network",
  "db",
  "flow",
  "browser",
  "env",
];

/**
 * Derive the LOW_CONTEXT signal from the assembled bundle. Pure. Combines four
 * structured inputs the bundle already carries:
 *  - evidence breadth: how many informative lanes are present (0..1, saturates
 *    at 3 lanes),
 *  - evidence volume: raw item count (0..1, saturates at 5 items),
 *  - hypothesis strength: the top hypothesis's confidence, treated as 0 when
 *    the only thing we could say is "inconclusive",
 *  - locate confidence: when a locate ran, a matched high-confidence locate
 *    lifts the score and an inconclusive locate depresses it; when no locate
 *    ran (explicit comparison), locate is neutral.
 * Gaps subtract, with hard `source-unavailable` gaps weighing more than soft
 * informational ones. Weights were calibrated so thin / medium / full fixtures
 * land in distinct bands (see fusion completeness tests).
 */
function deriveContextCompleteness(
  evidence: EvidenceItem[],
  gaps: EvidenceGap[],
  hypotheses: Hypothesis[],
  located?: Located,
): ContextCompleteness {
  const lanesPresent = new Set(evidence.map((item) => item.lane));
  const informativePresent = COMPLETENESS_LANES.filter((lane) =>
    lanesPresent.has(lane),
  );
  const breadth = Math.min(1, informativePresent.length / 3);
  const volume = Math.min(1, evidence.length / 5);

  const top = hypotheses[0];
  const hypothesisStrength =
    !top || top.kind === "inconclusive" ? 0 : top.confidence;

  let score = 0.4 * breadth + 0.25 * volume + 0.35 * hypothesisStrength;

  if (located) {
    if (located.outcome === "matched") {
      score = 0.85 * score + 0.15 * clamp01(located.confidence);
    } else {
      // Ambiguous and inconclusive locations cannot increase confidence: no
      // single session has been identified safely enough to strengthen context.
      score *= 0.6;
    }
  }

  const hardGaps = gaps.filter(
    (gap) => gap.kind === "source-unavailable",
  ).length;
  const softGaps = gaps.length - hardGaps;
  const gapPenalty = Math.min(0.5, softGaps * 0.1 + hardGaps * 0.3);
  score = clamp01(score - gapPenalty);

  const level: ContextCompleteness["level"] =
    score < 0.34 ? "low" : score < 0.67 ? "medium" : "high";

  const reasons: string[] = [];
  const missingLanes = COMPLETENESS_LANES.filter(
    (lane) => !lanesPresent.has(lane),
  );
  if (informativePresent.length === 0) {
    reasons.push("no network/db/flow/browser/env evidence captured");
  } else if (missingLanes.length > 0) {
    reasons.push(`missing evidence lanes: ${missingLanes.join(", ")}`);
  }
  if (evidence.length > 0 && evidence.length < 3) {
    reasons.push(`thin evidence (${evidence.length} item(s))`);
  }
  if (hardGaps > 0) reasons.push(`source unavailable for ${hardGaps} lane(s)`);
  if (softGaps > 0) reasons.push(`${softGaps} evidence gap(s)`);
  if (located?.outcome === "inconclusive" || located?.outcome === "ambiguous") {
    reasons.push(
      located.outcome === "ambiguous"
        ? "incident location ambiguous"
        : "incident location inconclusive",
    );
  }
  if (!top || top.kind === "inconclusive") {
    reasons.push("no distinguishing hypothesis");
  }

  return { score, level, reasons };
}

/** Compact, deterministic rendering of a primary key for a verification observation. */
function pkString(pk: Record<string, unknown>): string {
  return Object.keys(pk)
    .sort()
    .map((key) => `${key}=${String(pk[key])}`)
    .join(", ");
}

/**
 * Derive concrete post-fix verification observations for one hypothesis from
 * the evidence it cites. Emits an observation ONLY when the evidence item
 * carries a concrete anchor (db table+pk, request id, or error signature), so
 * an emitted observation always names a real signal — sparse and concrete
 * beats complete and vacuous. `inconclusive` hypotheses get none (correct: a
 * fix we can't hypothesize can't be verified). Deterministic; preserves the
 * hypothesis's evidence order.
 */
function deriveVerification(
  hypothesis: Hypothesis,
  evidence: EvidenceItem[],
): Verification[] {
  if (hypothesis.kind === "inconclusive") return [];
  const cited = new Set(hypothesis.evidenceIds);
  const out: Verification[] = [];
  for (const item of evidence) {
    if (!cited.has(item.id)) continue;
    const ref = item.ref;
    if (
      item.lane === "db" &&
      ref.table &&
      ref.pk &&
      Object.keys(ref.pk).length > 0
    ) {
      out.push({
        observation: `row in ${ref.table} (${pkString(ref.pk)}) matches the intended post-fix state`,
        evidenceIds: [item.id],
        how: "db",
      });
    } else if (ref.requestId) {
      const sigPart = ref.sig ? ` for signature ${ref.sig}` : "";
      out.push({
        observation: `request ${ref.requestId} succeeds${sigPart} on a fresh run (no error response)`,
        evidenceIds: [item.id],
        how: "request",
      });
    } else if (ref.sig) {
      out.push({
        observation: `error signature ${ref.sig} no longer appears in a fresh session over the same route`,
        evidenceIds: [item.id],
        how: "session",
      });
    }
    // No anchor → emit nothing for this item.
  }
  return out;
}

/**
 * Derive the consumer-side escalation advisory. Recommended when context is
 * thin (low completeness) or every hypothesis is inconclusive. `when`
 * conditions are phrased for the consuming agent. Never gates the bundle.
 */
function deriveEscalation(
  completeness: ContextCompleteness,
  hypotheses: Hypothesis[],
): Escalation {
  const allInconclusive =
    hypotheses.length > 0 &&
    hypotheses.every((hypothesis) => hypothesis.kind === "inconclusive");
  const recommended = completeness.level === "low" || allInconclusive;
  if (!recommended) return { recommended: false, when: [] };

  const when: string[] = [
    "if you cannot reproduce the symptom via the anchored request or session, stop and request human triage — do not widen the search",
  ];
  if (completeness.level === "low") {
    when.push(
      "context is thin: confirm the missing evidence lanes before acting on the top hypothesis",
    );
  }
  if (allInconclusive) {
    when.push(
      "no hypothesis is distinguished; treat the listed causes as equally unproven",
    );
  }
  return { recommended, when };
}

// --- evidence ranking (formerly fusion-rank.ts) ---------------------------

const LANE_PRIOR: Record<EvidenceLane, number> = {
  db: 0.2,
  network: 0.2,
  flow: 0.15,
  env: 0.1,
  browser: 0.1,
  logs: 0.05,
  memory: 0.05,
  code: 0.05,
};

/** Jaccard overlap of two token sets; 0 when both are empty. */
function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const value of setA) if (setB.has(value)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function symptomText(symptom: Symptom): string {
  return [symptom.title, symptom.description, symptom.errorSig]
    .filter((part): part is string => Boolean(part))
    .join(" ");
}

/**
 * Deterministic relevance score in [0,1] for one evidence item against a
 * symptom. No embeddings — explainable weighted sum:
 *  - 0.5 if symptom.url appears (case-insensitive substring) in the item's
 *    ref.sig or brief.
 *  - 0.3 token overlap (Jaccard) between symptom text and brief+kind.
 *  - 0.2 lane prior (db/network highest, then flow, then env/browser, else low).
 */
function scoreEvidenceRelevance(symptom: Symptom, item: EvidenceItem): number {
  let score = 0;

  if (symptom.url) {
    const needle = symptom.url.toLowerCase();
    const haystack = `${item.ref.sig ?? ""} ${item.brief}`.toLowerCase();
    if (haystack.includes(needle)) score += 0.5;
  }

  const symptomTokens = tokenize(symptomText(symptom));
  const itemTokens = tokenize(`${item.brief} ${item.kind}`);
  score += 0.3 * jaccard(symptomTokens, itemTokens);

  score += LANE_PRIOR[item.lane] ?? 0.05;

  return Math.min(1, score);
}

/**
 * Rank evidence by relevance to the symptom, highest first. Stable sort;
 * ties preserve original order. ALL items are returned — nothing dropped.
 */
function rankEvidence(symptom: Symptom, items: EvidenceItem[]): EvidenceItem[] {
  return items
    .map((item, index) => ({
      item,
      index,
      score: scoreEvidenceRelevance(symptom, item),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.index - b.index;
    })
    .map((entry) => entry.item);
}

// --- hypothesis classification (formerly fusion-hypotheses.ts) ------------

/**
 * Classify evidence + intent into advisory hypotheses. Anti-overfit core:
 * evidence explained by a deliberate commit is split into
 * `intentional-change` and never counted toward `regression`.
 * Pure, deterministic, never throws. Ordered by confidence desc.
 */
function classifyHypotheses(
  symptom: Symptom,
  evidence: EvidenceItem[],
  intent: IntentSignal[],
): Hypothesis[] {
  const hypotheses: Hypothesis[] = [];

  const evidenceIds = new Set(evidence.map((item) => item.id));
  const explainedById = new Map<string, IntentSignal>();
  for (const signal of intent) {
    if (signal.explainedByCommit && evidenceIds.has(signal.evidenceId)) {
      explainedById.set(signal.evidenceId, signal);
    }
  }

  // 1. intentional-change — one hypothesis per explained evidence id.
  for (const [evidenceId, signal] of explainedById) {
    const commit = signal.explainedByCommit!;
    hypotheses.push({
      kind: "intentional-change",
      confidence: 0.7,
      rationale: `explained by commit ${commit.sha}: ${commit.message}`,
      evidenceIds: [evidenceId],
    });
  }

  const unexplained = evidence.filter((item) => !explainedById.has(item.id));

  // 2. regression — unexplained network/db/flow evidence.
  const regressionEvidence = unexplained.filter(
    (item) =>
      item.lane === "network" || item.lane === "db" || item.lane === "flow",
  );
  if (regressionEvidence.length > 0) {
    const confidence = Math.min(0.9, 0.4 + 0.1 * regressionEvidence.length);
    hypotheses.push({
      kind: "regression",
      confidence,
      rationale: `${regressionEvidence.length} behavior change(s) vs baseline with no matching intentional commit`,
      evidenceIds: regressionEvidence.map((item) => item.id),
    });
  }

  // 3. environment — unexplained env-lane evidence.
  const envEvidence = unexplained.filter((item) => item.lane === "env");
  if (envEvidence.length > 0) {
    hypotheses.push({
      kind: "environment",
      confidence: 0.5,
      rationale: "environment/config differs",
      evidenceIds: envEvidence.map((item) => item.id),
    });
  }

  // 4. client-side — browser-lane evidence.
  const browserEvidence = unexplained.filter((item) => item.lane === "browser");
  if (browserEvidence.length > 0) {
    hypotheses.push({
      kind: "client-side",
      confidence: 0.5,
      rationale: "client-side factor (browser/network/device)",
      evidenceIds: browserEvidence.map((item) => item.id),
    });
  }

  // 5. latent — no evidence at all, but a non-empty symptom.
  if (evidence.length === 0 && symptom.title.trim().length > 0) {
    hypotheses.push({
      kind: "latent",
      confidence: 0.3,
      rationale:
        "no behavior change captured; likely a long-standing/latent issue or missing instrumentation",
      evidenceIds: [],
    });
  }

  // 6. inconclusive — nothing else emitted.
  if (hypotheses.length === 0) {
    hypotheses.push({
      kind: "inconclusive",
      confidence: 0.2,
      rationale: "insufficient evidence to distinguish causes",
      evidenceIds: [],
    });
  }

  return hypotheses
    .map((hypothesis, index) => ({ hypothesis, index }))
    .sort((a, b) => {
      if (b.hypothesis.confidence !== a.hypothesis.confidence) {
        return b.hypothesis.confidence - a.hypothesis.confidence;
      }
      return a.index - b.index;
    })
    .map((entry) => entry.hypothesis);
}

// --- capture directives (formerly capture-directive.ts) -------------------

/** Lanes worth escalating capture on when evidence is thin. */
const INFORMATIVE_LANES: EvidenceLane[] = ["network", "db", "browser", "flow"];

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function signatureFor(symptom: Symptom): string {
  if (symptom.errorSig && symptom.errorSig.length > 0) return symptom.errorSig;
  const slug = slugify(symptom.title ?? "");
  return slug.length > 0 ? slug : "unknown";
}

/**
 * Pure, deterministic: given a symptom, the (complete) evidence gathered,
 * and any evidence gaps, suggest at most one CaptureDirective raising the
 * informative lanes that are still missing when evidence is thin.
 *
 * Advisory only — never mutates anything.
 */
function suggestCaptureDirectives(
  symptom: Symptom,
  evidence: EvidenceItem[],
  gaps: EvidenceGap[],
): CaptureDirective[] {
  const thin = evidence.length === 0 || gaps.length > 0;
  if (!thin) return [];

  const present = new Set(evidence.map((e) => e.lane));
  const missing = INFORMATIVE_LANES.filter((lane) => !present.has(lane));
  if (missing.length === 0) return [];

  return [
    {
      signature: signatureFor(symptom),
      raise: missing,
      scope: "signature",
      reason: `thin evidence for this signature; raise capture on: ${missing.join(", ")}`,
    },
  ];
}
