/**
 * Token estimation + shared multi-plane budget fill for the token-budgeted MCP
 * surface. Pure module: no I/O, no clocks, no randomness — every output is a
 * deterministic function of the inputs, so budgeted tool responses are
 * reproducible byte-for-byte.
 */

/**
 * Slack allowance, in estimated tokens, that covers the budgeting envelope a
 * budgeted response adds on top of its kept content: the `dropReport` object
 * (per-plane counts, capped refs, message), `budgetSatisfied`, and the
 * `tokenEstimate` field itself, plus per-item rounding in
 * {@link fillPlanesToBudget}'s cost model. Contract: whenever the fixed
 * (non-plane) part of a payload fits the budget, the final response's
 * {@link estimateTokens} over its exact serialized form is
 * `<= maxTokens + BUDGET_SLACK_TOKENS`. When the fixed part alone does NOT fit,
 * no fill can rescue the response, so the caller says so through
 * `budgetSatisfied: false` rather than silently overrunning.
 */
export const BUDGET_SLACK_TOKENS = 256;

/** Max refs surfaced in a drop report (both the arrays and the message). */
const DROP_REPORT_REF_CAP = 10;

/**
 * Cheap chars/4 token estimate over an already-serialized string:
 * `Math.ceil(serialized.length / 4)`.
 *
 * Bias, documented on purpose: this is a heuristic, not a tokenizer. It
 * UNDER-counts token-dense content (non-ASCII text, base64/hex blobs, dense
 * punctuation — real tokenizers emit more than 1 token per 4 chars there), so
 * callers budgeting for a specific model context should leave headroom. MCP
 * estimates are always taken over the exact `textResult` serialization —
 * `JSON.stringify(data, null, 2)` — so pretty-print indentation and newlines
 * are included in the count.
 */
export function estimateTokens(serialized: string): number {
  return Math.ceil(serialized.length / 4);
}

/**
 * What one plane (one array in the payload) lost to the budget. This is the
 * fill's own per-plane result and the input to {@link summarizeDrops}; the
 * response emits the leaner {@link DropReportPlane}.
 */
export interface PlaneDropReport {
  /** Dotted path of the trimmed array, e.g. `primary_window.backend.requests`. */
  plane: string;
  /** How many whole items the plane dropped. */
  droppedCount: number;
  /** Estimated tokens the dropped items would have cost in the payload. */
  droppedTokenEstimate: number;
  /** Refs of the dropped items, rank order, capped at 10. */
  droppedRefs: string[];
}

/** Per-plane entry as it appears in a response's `dropReport.planes`. */
export interface DropReportPlane {
  /** Dotted path of the trimmed array, e.g. `primary_window.backend.requests`. */
  plane: string;
  /** How many whole items this plane dropped. */
  droppedCount: number;
  /** Estimated tokens this plane's dropped items would have cost. */
  droppedTokenEstimate: number;
}

/**
 * Structured report of what a budget fill omitted, across every plane it
 * trimmed. Deterministic: planes in priority order, refs in each plane's
 * original rank order (no Set/Map iteration involved).
 *
 * Refs are carried ONCE, in the flat `droppedRefs` list, and the per-plane
 * entries carry counts only. A report that repeated every plane's refs cost
 * more than the content it was reporting on, which small budgets cannot afford
 * — the report is paid for out of the budget, not out of the slack.
 */
export interface DropReport {
  /** How many whole items were dropped, summed over every plane. */
  droppedCount: number;
  /** Estimated tokens the dropped items would have cost, summed over planes. */
  droppedTokenEstimate: number;
  /**
   * Refs of the dropped items: planes in priority order, items in rank order
   * within a plane, capped at 10 overall. Best effort drill-through, not a
   * complete list — `planes[].droppedCount` is the complete accounting.
   */
  droppedRefs: string[];
  /** Every plane that lost at least one item, in priority order. */
  planes: DropReportPlane[];
  /** Human/agent-readable summary naming the planes and the leading refs. */
  message: string;
}

/**
 * One budgetable array inside a payload. `path` is BOTH the dotted location the
 * kept prefix is written back to and the plane's name in the drop report, so a
 * plane can never be reported under a name that does not resolve.
 *
 * Build these with {@link budgetPlane}, which keeps `items`/`refOf` type-safe at
 * the call site while the fill treats every plane uniformly.
 */
export interface BudgetPlane {
  path: string;
  items: readonly unknown[];
  refOf: (item: unknown) => string;
}

/** Type-safe constructor for a {@link BudgetPlane}. */
export function budgetPlane<T>(
  path: string,
  items: readonly T[],
  refOf: (item: T) => string,
): BudgetPlane {
  return { path, items, refOf: (item) => refOf(item as T) };
}

export interface FillPlanesOptions {
  /** Total token budget for the final serialized payload. */
  maxTokens: number;
  /**
   * Estimated tokens of the payload with EVERY plane emptied — the fixed cost
   * the fill cannot influence. Build it with {@link withPlaneValues}.
   */
  baseTokens: number;
}

export interface FillPlanesResult {
  /** Kept prefix per plane path. Every requested plane has an entry. */
  kept: Map<string, unknown[]>;
  /** Estimated tokens the kept items add on top of `baseTokens`. */
  usedTokens: number;
  /** One entry per plane that lost items, in the given priority order. */
  dropped: PlaneDropReport[];
}

/**
 * Estimated in-payload cost of one item. The item is assumed to be embedded in
 * a pretty-printed (indent 2) array, so relative to its standalone
 * serialization every line gains `indentColumns` columns and the item costs a
 * `",\n"` separator. Ceiling per item slightly over-counts — the safe direction
 * for a budget bound.
 */
function itemCost(serialized: string, indentColumns: number): number {
  let lines = 1;
  for (let i = 0; i < serialized.length; i += 1) {
    if (serialized.charCodeAt(i) === 10) lines += 1;
  }
  return Math.ceil((serialized.length + indentColumns * lines + 2) / 4);
}

/**
 * Columns of indentation each line of an item gains once embedded at `path`.
 * A top-level array (`"signals"`) puts its items at column 4; every extra path
 * segment adds another 2 (`"primary_window.frontend.requests"` → 8).
 */
function planeIndent(path: string): number {
  return 2 * (path.split(".").length + 1);
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = tokens / 1000;
  const rounded =
    thousands >= 10 ? Math.round(thousands) : Math.round(thousands * 10) / 10;
  return `${rounded}k`;
}

function setAtPath(
  target: Record<string, unknown>,
  segments: string[],
  value: unknown,
): Record<string, unknown> {
  const [head, ...rest] = segments;
  if (rest.length === 0) return { ...target, [head]: value };
  const child = target[head];
  const nested =
    child !== null && typeof child === "object" && !Array.isArray(child)
      ? (child as Record<string, unknown>)
      : {};
  return { ...target, [head]: setAtPath(nested, rest, value) };
}

/**
 * Immutably writes each `[path, value]` into `payload`, cloning only the
 * objects along each path so key order (and therefore the serialized bytes) is
 * preserved for every untouched field.
 */
export function withPlaneValues(
  payload: Record<string, unknown>,
  values: Iterable<readonly [string, unknown]>,
): Record<string, unknown> {
  let out = payload;
  for (const [path, value] of values)
    out = setAtPath(out, path.split("."), value);
  return out;
}

/**
 * Shared multi-plane budget fill: walks `planes` in the caller's PRIORITY order
 * and, for each, keeps the longest PREFIX of its items (already in rank order —
 * the fill never re-sorts) that still fits the remaining budget.
 *
 * Semantics pinned by tests:
 * - Priority order is total and encoded by the caller once: a lower-priority
 *   plane can only spend what every higher-priority plane left behind.
 * - Drop strictly from the bottom of each plane's rank order: a plane's kept
 *   set is always a prefix, so a mid-rank item is NEVER dropped while a
 *   lower-ranked one in the same plane is kept, even when the lower-ranked item
 *   is smaller and would fit.
 * - Monotonic in the budget, lexicographically by priority: raising `maxTokens`
 *   never yields a lexicographically smaller kept-count vector. A
 *   higher-priority plane may absorb budget a lower-priority one previously
 *   used, which is the intended trade, not a regression.
 * - A budget too small for even one item (or smaller than `baseTokens`) keeps
 *   nothing and reports everything dropped: never throws, never loops.
 * - Deterministic: refs come from `refOf` in item order; no clocks.
 */
export function fillPlanesToBudget(
  planes: readonly BudgetPlane[],
  opts: FillPlanesOptions,
): FillPlanesResult {
  let available = opts.maxTokens - opts.baseTokens;
  let usedTokens = 0;
  const kept = new Map<string, unknown[]>();
  const dropped: PlaneDropReport[] = [];

  for (const plane of planes) {
    const indent = planeIndent(plane.path);
    let keptCount = 0;
    for (const item of plane.items) {
      const cost = itemCost(JSON.stringify(item, null, 2), indent);
      if (cost > available) break;
      available -= cost;
      usedTokens += cost;
      keptCount += 1;
    }
    kept.set(plane.path, plane.items.slice(0, keptCount));

    const lost = plane.items.slice(keptCount);
    if (lost.length === 0) continue;
    let droppedTokenEstimate = 0;
    for (const item of lost)
      droppedTokenEstimate += itemCost(JSON.stringify(item, null, 2), indent);
    dropped.push({
      plane: plane.path,
      droppedCount: lost.length,
      droppedTokenEstimate,
      droppedRefs: lost.slice(0, DROP_REPORT_REF_CAP).map(plane.refOf),
    });
  }

  return { kept, usedTokens, dropped };
}

/**
 * Aggregates per-plane drops into the response's `dropReport`. Returns
 * `undefined` when nothing was dropped, so a response that fully fits carries
 * no budgeting noise.
 */
export function summarizeDrops(
  planes: readonly PlaneDropReport[],
): DropReport | undefined {
  const trimmed = planes.filter((plane) => plane.droppedCount > 0);
  if (trimmed.length === 0) return undefined;

  let droppedCount = 0;
  let droppedTokenEstimate = 0;
  const refs: string[] = [];
  for (const plane of trimmed) {
    droppedCount += plane.droppedCount;
    droppedTokenEstimate += plane.droppedTokenEstimate;
    for (const ref of plane.droppedRefs) {
      if (refs.length < DROP_REPORT_REF_CAP) refs.push(ref);
    }
  }

  const noun = droppedCount === 1 ? "item" : "items";
  const ellipsis = droppedCount > refs.length ? "…" : "";
  const planeList = trimmed.map((plane) => plane.plane).join(", ");
  return {
    droppedCount,
    droppedTokenEstimate,
    droppedRefs: refs,
    planes: trimmed.map((plane) => ({
      plane: plane.plane,
      droppedCount: plane.droppedCount,
      droppedTokenEstimate: plane.droppedTokenEstimate,
    })),
    message: `omitted ${droppedCount} ${noun}, ~${formatTokenCount(droppedTokenEstimate)} tokens from ${planeList}; refs: ${refs.join(", ")}${ellipsis}`,
  };
}

export interface PlanesWithDropReport {
  /** Kept prefix per plane path. Every requested plane has an entry. */
  kept: Map<string, unknown[]>;
  /** Present iff at least one plane (or extra projection) lost content. */
  report?: DropReport;
  /** Tokens held back from the fill to pay for `report`. */
  reservedTokens: number;
}

/** Estimated cost of embedding `report` as the payload's `dropReport` field. */
function dropReportCost(report: DropReport | undefined): number {
  return report
    ? estimateTokens(JSON.stringify({ dropReport: report }, null, 2))
    : 0;
}

/**
 * {@link fillPlanesToBudget} plus the `dropReport` the fill implies, with the
 * report's own cost RESERVED OUT OF THE BUDGET rather than out of
 * {@link BUDGET_SLACK_TOKENS}. A report that names several planes and their
 * refs is far too large to hide in a fixed fudge factor, and a response that
 * pays for its own bookkeeping is the whole point of an honest budget.
 *
 * Each pass reserves what the previous pass's report cost and refills. The
 * reserve only ever grows and the refs are capped, so it converges within a
 * pass or two; the loop is bounded regardless, and callers verify the final
 * serialization against the budget rather than trusting this accounting.
 *
 * `extraDrops` reports a non-array projection the caller had to remove because
 * the fill invalidated it (getFixContext's `causal_chain`). It is evaluated
 * inside the loop so its cost is reserved too.
 */
export function fillPlanesWithDropReport(
  planes: readonly BudgetPlane[],
  opts: FillPlanesOptions,
  extraDrops?: (
    kept: ReadonlyMap<string, unknown[]>,
  ) => PlaneDropReport | undefined,
): PlanesWithDropReport {
  let reserve = 0;
  let kept = new Map<string, unknown[]>();
  let report: DropReport | undefined;

  for (let pass = 0; pass < 3; pass += 1) {
    const fill = fillPlanesToBudget(planes, {
      maxTokens: opts.maxTokens,
      baseTokens: opts.baseTokens + reserve,
    });
    kept = fill.kept;
    const extra = extraDrops?.(fill.kept);
    report = summarizeDrops(extra ? [...fill.dropped, extra] : fill.dropped);
    const cost = dropReportCost(report);
    if (cost <= reserve) break;
    reserve = cost;
  }

  return { kept, report, reservedTokens: reserve };
}

/**
 * Appends a self-consistent `tokenEstimate` field to a payload: the estimate is
 * taken over the FINAL serialized form (`JSON.stringify(data, null, 2)`, the
 * exact `textResult` serialization) INCLUDING the `tokenEstimate` field itself,
 * via a small fixed-point iteration (the field's digit count feeds back into
 * the length; it converges in one or two passes for realistic payloads).
 */
export function attachTokenEstimate<T extends Record<string, unknown>>(
  payload: T,
): T & { tokenEstimate: number } {
  let estimate = 0;
  for (let i = 0; i < 5; i += 1) {
    const next = estimateTokens(
      JSON.stringify({ ...payload, tokenEstimate: estimate }, null, 2),
    );
    if (next === estimate) break;
    estimate = next;
  }
  return { ...payload, tokenEstimate: estimate };
}
