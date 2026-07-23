import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { UI_NUM_EVENT_KIND } from "../types";
import { classifyStructuredValue } from "../redaction";
import {
  buildCaptureGapEvent,
  type BuildCaptureGapEventInput,
} from "../capture-gap";
import { now } from "../utils";
import { subscribeNavCommit } from "../nav-signal";

/**
 * Display capture: labeled numeric tokens visible on screen, emitted as
 * compact `ui.num` snapshots so backend detectors can check display arithmetic
 * (subtotal + tax vs total) and UI↔API divergence. No raw DOM/HTML is ever
 * captured — only short labels and parsed numbers.
 */

/** DOM settle debounce for mutation-triggered scans. */
export const UI_NUM_SETTLE_MS = 500;
/** Hard cap on labeled tokens per region snapshot. */
export const UI_NUM_MAX_ITEMS = 50;
/** Labels longer than this are ignored (they are prose, not labels). */
const MAX_LABEL_LENGTH = 64;
/**
 * Element budget for a single scan. `scanUiNumbers` walks every element under
 * the root (a leaf check plus ancestor-walking label/hidden resolution per
 * numeric leaf) and re-runs on every 500ms MutationObserver settle. On a huge,
 * continuously mutating DOM that is an unbounded main-thread cost. The checks
 * are cheap and leaf-dominated, so a five-figure ceiling stays well clear of
 * ordinary pages (checkout/dashboard DOMs are hundreds to low thousands of
 * nodes) while still capping pathological pages before they stall the thread.
 */
export const UI_NUM_MAX_SCAN_ELEMENTS = 15_000;

export interface UiNumItem {
  label: string;
  value: number;
  unit?: string;
}

/**
 * A numeric display token: optional currency symbol, digits with optional
 * thousands separators and decimals, optional trailing currency/percent unit.
 * The element's entire trimmed text must be the token — free prose containing
 * numbers is not a labeled figure.
 */
const NUM_TOKEN_RE =
  /^([$€£¥])?\s*(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)\s*([$€£¥%])?$/;

/** Containers that delimit a snapshot region. */
const REGION_SELECTOR =
  "dl, table, ul, ol, form, fieldset, section, article, aside, nav, main";

export function parseNumericToken(
  text: string,
): { value: number; unit?: string } | null {
  const match = NUM_TOKEN_RE.exec(text.trim());
  if (!match) return null;
  const value = Number.parseFloat(match[2].replace(/,/g, ""));
  if (!Number.isFinite(value)) return null;
  const unit = match[1] ?? match[3];
  return unit ? { value, unit } : { value };
}

/**
 * Labels run through the structured-value classifier in redaction.ts, but only
 * name/PII-grade findings redact: the classifier's `free_text_value` catch-all
 * was tuned for network body *values*, where any multi-word string is suspect.
 * UI labels are visible-by-design short strings ("Tax (8.25%)"), so free text
 * is normal — only deny-listed names (password/card/email/…) and PII-shaped
 * content (emails, card numbers, JWTs, token-like or high-entropy strings)
 * indicate a label that must not leave the page. A deny/PII label drops the
 * whole item (label AND value): under a sensitive label the number itself is
 * the sensitive datum, so a `[REDACTED]`+value pair would still leak it.
 *
 * Accepted residual risk of the free_text_value carve-out: labels that are
 * themselves PII but read as ordinary free text — most notably human names in
 * payroll/CRM-style tables ("Jane Doe  $84,000") — survive capture by design,
 * because a name is indistinguishable from a benign label here. Mitigations:
 * add the label to `redaction.denyFields`, use PRESET_LIGHT, or disable this
 * collector with `collect.uiNumbers: false`.
 */
function isDeniedLabel(label: string, denyFields?: string[]): boolean {
  const classification = classifyStructuredValue(label, label, denyFields);
  return (
    classification.action === "redact" &&
    classification.reason !== "free_text_value"
  );
}

/**
 * Value gate for the numeric token's integer-part digit run: a 13–19 digit
 * Luhn-passing run is a card number rendered on screen, and any run longer
 * than 16 digits is an absurd-length identifier, not a displayed figure.
 * Bare 9–11 digit runs (order numbers, tax refs) intentionally pass.
 */
function isDeniedNumericValue(value: number): boolean {
  const digits = String(Math.trunc(Math.abs(value)));
  if (digits.length > 16) return true;
  if (digits.length >= 13 && luhnPasses(digits)) return true;
  return false;
}

function luhnPasses(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

function isHiddenElement(el: Element): boolean {
  if (el.closest('[hidden], [aria-hidden="true"]') !== null) return true;
  for (
    let node: Element | null = el;
    node !== null;
    node = node.parentElement
  ) {
    const style = (node as HTMLElement).style;
    if (
      style &&
      (style.display === "none" || style.visibility === "hidden")
    ) {
      return true;
    }
  }
  return false;
}

function normalizeLabelText(text: string | null | undefined): string | null {
  const trimmed = text?.replace(/\s+/g, " ").trim().replace(/[:：]$/, "");
  if (!trimmed || trimmed.length > MAX_LABEL_LENGTH) return null;
  // A label that is itself a bare numeric token labels nothing.
  if (NUM_TOKEN_RE.test(trimmed)) return null;
  return trimmed;
}

function precedingSiblingLabel(start: Node): string | null {
  for (
    let sibling = start.previousSibling;
    sibling !== null;
    sibling = sibling.previousSibling
  ) {
    if (sibling.nodeType === 8 /* comment */) continue;
    if (
      sibling.nodeType === 1 &&
      isHiddenElement(sibling as Element)
    ) {
      continue;
    }
    const label = normalizeLabelText(sibling.textContent);
    if (label) return label;
  }
  return null;
}

/**
 * Resolve the human label for a numeric leaf element, in priority order:
 * dt/dd pairing, explicit aria-label, `label[for]` association, then the
 * nearest preceding text within the same row or list item.
 */
function resolveLabel(el: Element): string | null {
  // 1. dt/dd pairs: a <dd> value is labeled by the closest preceding <dt>.
  const dd = el.closest("dd");
  if (dd) {
    for (
      let sibling = dd.previousElementSibling;
      sibling !== null;
      sibling = sibling.previousElementSibling
    ) {
      if (sibling.tagName === "DT") {
        const label = normalizeLabelText(sibling.textContent);
        if (label) return label;
        break;
      }
    }
  }

  // 2. aria-label on the element itself or a row-level wrapper (cell/row/list
  // item). Deliberately NOT any ancestor: a section-level aria-label would
  // otherwise label every number in the section identically.
  const ariaHost = el.closest("[aria-label]");
  if (
    ariaHost &&
    (ariaHost === el ||
      ariaHost.matches("tr, li, dd, td, th, [role='row'], [role='cell']"))
  ) {
    const label = normalizeLabelText(ariaHost.getAttribute("aria-label"));
    if (label) return label;
  }

  // 3. label[for] association.
  const id = el.getAttribute("id");
  if (id && typeof CSS !== "undefined" && CSS.escape) {
    const labelEl = el.ownerDocument.querySelector(
      `label[for="${CSS.escape(id)}"]`,
    );
    if (labelEl) {
      const label = normalizeLabelText(labelEl.textContent);
      if (label) return label;
    }
  }

  // 4. Preceding text in the same row / list item: nearest preceding sibling
  // of the element itself, then of its ancestors, bounded by the row.
  const row = el.closest("tr, li, dd") ?? el.parentElement;
  for (
    let node: Node | null = el;
    node !== null && node !== row?.parentNode;
    node = node.parentNode
  ) {
    const label = precedingSiblingLabel(node);
    if (label) return label;
    if (node === row) break;
  }
  return null;
}

/**
 * Id/class fragments can carry PII (e.g. an id templated from an email
 * address, or a token-like generated class). Run them through the same
 * classifier gate as labels; a redacted fragment falls back to `null` so the
 * region string degrades to the bare tag name.
 */
function sanitizeRegionFragment(fragment: string): string | null {
  const classification = classifyStructuredValue(fragment, fragment);
  if (
    classification.action === "redact" &&
    classification.reason !== "free_text_value"
  ) {
    return null;
  }
  return fragment;
}

/**
 * Short CSS-path-ish identifier for a region container — tag name plus id or
 * first class when present ("dl.totals"). Never serializes DOM content, and
 * PII-shaped id/class fragments are dropped (bare tag name instead).
 */
function regionIdentifier(container: Element): string {
  const tag = container.tagName.toLowerCase();
  const id = container.getAttribute("id");
  if (id) {
    const safe = sanitizeRegionFragment(id);
    if (safe) return `${tag}#${safe}`;
    return tag;
  }
  const firstClass = container.classList.item(0);
  if (firstClass) {
    const safe = sanitizeRegionFragment(firstClass);
    if (safe) return `${tag}.${safe}`;
  }
  return tag;
}

function regionContainer(el: Element, root: Element): Element {
  return el.closest(REGION_SELECTOR) ?? root;
}

/** True when the element has no element children (a text leaf). */
function isLeaf(el: Element): boolean {
  return el.childElementCount === 0;
}

/**
 * Scan visible text under `root` for labeled numeric tokens, grouped by
 * region. Pure DOM read — no mutation, no HTML capture.
 *
 * Returns `null` (an "over budget" sentinel) rather than a region map when the
 * root holds more than `maxElements` elements. `null` is deliberately distinct
 * from an empty map: a partial snapshot would be worse than none, because the
 * ui_arithmetic_mismatch detector assumes every component of a region is
 * present, so a truncated region would manufacture a high-confidence false
 * "subtotal + tax ≠ total". Over budget therefore means "no evidence", not
 * "some evidence". `maxElements` is injectable so callers (and tests) can pin
 * the ceiling; it defaults to `UI_NUM_MAX_SCAN_ELEMENTS`.
 */
export function scanUiNumbers(
  root: Element,
  denyFields?: string[],
  maxElements: number = UI_NUM_MAX_SCAN_ELEMENTS,
): Map<string, UiNumItem[]> | null {
  const elements = root.querySelectorAll("*");
  if (elements.length > maxElements) return null;
  const regions = new Map<string, UiNumItem[]>();
  for (const el of elements) {
    if (!isLeaf(el)) continue;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") continue;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") continue;
    const parsed = parseNumericToken(el.textContent ?? "");
    if (!parsed) continue;
    if (isHiddenElement(el)) continue;
    const label = resolveLabel(el);
    if (!label) continue;
    // Deny/PII label or PAN-shaped value: drop the item entirely — never a
    // `[REDACTED]`-labeled value.
    if (isDeniedLabel(label, denyFields)) continue;
    if (isDeniedNumericValue(parsed.value)) continue;

    const region = regionIdentifier(regionContainer(el, root));
    let items = regions.get(region);
    if (!items) {
      items = [];
      regions.set(region, items);
    }
    if (items.length >= UI_NUM_MAX_ITEMS) continue;
    const item: UiNumItem = {
      label,
      value: parsed.value,
    };
    if (parsed.unit) item.unit = parsed.unit;
    items.push(item);
  }
  return regions;
}

export function uiNumbersCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const denyFields = config.redaction?.denyFields;
  if (
    typeof document === "undefined" ||
    typeof MutationObserver === "undefined"
  ) {
    return () => {};
  }

  // Script may run from <head> before <body> exists: retry once when the DOM
  // is ready instead of permanently no-opping.
  if (!document.body) {
    let started: CollectorCleanup | undefined;
    let cancelled = false;
    const onReady = (): void => {
      if (cancelled || !document.body) return;
      started = startUiNumbersCollector(bus, denyFields);
    };
    document.addEventListener("DOMContentLoaded", onReady, { once: true });
    return () => {
      cancelled = true;
      document.removeEventListener("DOMContentLoaded", onReady);
      started?.();
    };
  }

  return startUiNumbersCollector(bus, denyFields);
}

function startUiNumbersCollector(
  bus: EventBus,
  denyFields?: string[],
): CollectorCleanup {
  let disabled = false;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  // Previous serialized snapshot per region: emit only on change.
  const lastSnapshot = new Map<string, string>();
  let observer: MutationObserver | undefined;
  // Assigned after observer setup; `let` so `disable` (defined first, callable
  // from the observer-setup catch) can release it without a TDZ reference.
  let unsubscribeNav: (() => void) | undefined;

  // Failure policy: the collector self-disables inside its own scan path and
  // degrades to a single `capture_gap` event, rather than relying on
  // bug-logger to wrap collector callbacks — core has no manifest writer for
  // `degradedCollection` (that field is assembled server-side). One broken
  // collector never breaks the page or the session, and placing the guard
  // here covers the MutationObserver/debounce internals too.
  //
  // Both permanent-disable paths — a thrown exception mid-scan and an
  // over-budget DOM — route through `disable` so teardown is identical; they
  // differ only in the gap reason/detail they report.
  const disable = (
    reason: BuildCaptureGapEventInput["reason"],
    detail: string,
  ): void => {
    if (disabled) return;
    disabled = true;
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    try {
      observer?.disconnect();
    } catch {
      // Already broken — nothing to release.
    }
    unsubscribeNav?.();
    bus.emit(buildCaptureGapEvent({ surface: "browser", reason, detail }));
  };

  const disableOnException = (error: unknown): void => {
    const name = error instanceof Error ? error.name : "Error";
    disable("capture_exception", `ui.num collector disabled: ${name}`);
  };

  const runScan = (): void => {
    if (disabled) return;
    try {
      const regions = scanUiNumbers(document.body, denyFields);
      if (regions === null) {
        // Over budget: the page has too many elements to scan safely on the
        // 500ms cadence. Permanently disable rather than emit a partial (and
        // therefore misleading) snapshot. `scan_budget_exceeded` distinguishes
        // this from a genuine collector fault at triage time.
        disable(
          "scan_budget_exceeded",
          "ui.num scan exceeded element budget; collector disabled",
        );
        return;
      }
      for (const [region, items] of regions) {
        if (items.length === 0) continue;
        const serialized = JSON.stringify(items);
        if (lastSnapshot.get(region) === serialized) continue;
        lastSnapshot.set(region, serialized);
        bus.emit({
          t: now(),
          k: UI_NUM_EVENT_KIND,
          d: { region, items },
        });
      }
    } catch (error) {
      disableOnException(error);
    }
  };

  const scheduleScan = (): void => {
    if (disabled) return;
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    settleTimer = setTimeout(runScan, UI_NUM_SETTLE_MS);
  };

  try {
    observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  } catch (error) {
    disableOnException(error);
    return () => {};
  }

  // Navigation commit: SPA route changes (history API) and hash/pop
  // navigations schedule a scan through the same settle debounce so the new
  // view's DOM is read after it renders. Uses the shared nav-commit signal —
  // never a private history.pushState wrap — so multiple collectors can
  // observe navigation without corrupting each other's teardown.
  unsubscribeNav = subscribeNavCommit(() => scheduleScan());

  // Initial navigation commit (page load): scan after the settle window.
  scheduleScan();

  return () => {
    // Defense in depth: a disabled collector ignores any callback that
    // slips through after teardown (queued observer delivery, stray timer).
    disabled = true;
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    try {
      observer?.disconnect();
    } catch {
      // Observer already failed; cleanup must not throw.
    }
    unsubscribeNav?.();
  };
}
