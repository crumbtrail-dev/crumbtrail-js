import type { CrumbtrailConfig } from "./types";
import { redactUrl } from "./redaction";

const UNMASK_ATTRIBUTE = "data-crumbtrail-unmask";
const BLOCK_ATTRIBUTE = "data-crumbtrail-block";

/**
 * Replaces visible characters while retaining whitespace and a useful approximation of length.
 * This is deliberately separate from policy redaction: it is applied at collection time, before
 * a value is admitted to the ring buffer.
 */
export function maskText(value: string): string {
  return Array.from(value, (character) =>
    /\s/.test(character) ? character : "*",
  ).join("");
}

/** Whether an element may intentionally contribute clear text to capture. */
export function isUnmasked(el: Element): boolean {
  return el.hasAttribute(UNMASK_ATTRIBUTE);
}

/** Whether an element and its entire subtree must be excluded from capture. */
export function isBlocked(el: Element): boolean {
  return el.closest(`[${BLOCK_ATTRIBUTE}]`) !== null;
}

/**
 * Applies the text default to the user visible descriptor fields used by interaction collectors.
 * Structural identifiers remain intact so masked interactions can still be correlated.
 */
export function maskElementDescriptor(
  element: Element,
  descriptor: Record<string, unknown>,
  config: CrumbtrailConfig,
): Record<string, unknown> {
  const sanitized = sanitizeDescriptorUrls(descriptor);
  if ((!config.maskAllText && !config.maskAllInputs) || isUnmasked(element))
    return sanitized;
  return maskDescriptorRecord(sanitized, config);
}

/**
 * Clones and sanitizes a DOM tree for flag time snapshots. Blocked subtrees are removed before
 * serialization; text and form values are masked in the clone, never the live page.
 */
export function buildMaskedDomSnapshot(
  root: Element,
  config: CrumbtrailConfig,
): string {
  const clone = root.cloneNode(true) as Element;
  sanitizeElement(clone, config);
  return clone.outerHTML;
}

function sanitizeElement(element: Element, config: CrumbtrailConfig): void {
  // Unmasking is deliberately local to this element. A parent may opt its own text/value in,
  // but every descendant must opt in independently.
  const unmasked = element.hasAttribute(UNMASK_ATTRIBUTE);
  sanitizeUrlAttributes(element);
  sanitizeTextAttributes(element, config, unmasked);

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const childElement = child as Element;
      if (childElement.hasAttribute(BLOCK_ATTRIBUTE)) {
        childElement.remove();
        continue;
      }
      sanitizeElement(childElement, config);
      continue;
    }

    if (child.nodeType === Node.TEXT_NODE && config.maskAllText && !unmasked) {
      child.textContent = maskText(child.textContent ?? "");
    }
  }

  if (config.maskAllInputs && !unmasked && isFormValueElement(element)) {
    const currentValue =
      element instanceof HTMLTextAreaElement
        ? element.value || element.textContent || ""
        : element instanceof HTMLSelectElement
          ? element.value
          : (element.getAttribute("value") ??
            (element instanceof HTMLInputElement ? element.value : ""));
    const masked = maskText(currentValue);
    element.setAttribute("value", masked);
    if (element instanceof HTMLTextAreaElement) element.textContent = masked;
  }

  if (
    config.maskAllInputs &&
    !unmasked &&
    element instanceof HTMLOptionElement
  ) {
    element.setAttribute("value", maskText(element.value));
  }
}

const SAFE_DESCRIPTOR_FIELDS = new Set([
  "tag",
  "id",
  "cls",
  "class",
  "type",
  "name",
  "sig",
  "path",
  "href",
  "role",
  "selector",
  "xpath",
]);
const URL_ATTRIBUTES = ["action", "formaction", "href", "poster", "src"];

function maskDescriptorRecord(
  value: Record<string, unknown>,
  config: CrumbtrailConfig,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([field, entry]) => [
      field,
      field === "redaction" ? entry : maskDescriptorValue(entry, field, config),
    ]),
  );
}

function maskDescriptorValue(
  value: unknown,
  field: string,
  config: CrumbtrailConfig,
): unknown {
  if (typeof value === "string") {
    if (field === "href") return redactUrl(value, field).value;
    if (SAFE_DESCRIPTOR_FIELDS.has(field)) return value;
    return config.maskAllText || config.maskAllInputs ? maskText(value) : value;
  }
  if (Array.isArray(value))
    return value.map((entry) => maskDescriptorValue(entry, field, config));
  if (value && typeof value === "object")
    return maskDescriptorRecord(value as Record<string, unknown>, config);
  return value;
}

function sanitizeUrlAttributes(element: Element): void {
  for (const name of URL_ATTRIBUTES) {
    const value = element.getAttribute(name);
    if (value !== null) element.setAttribute(name, redactUrl(value, name).value);
  }
}

function sanitizeDescriptorUrls(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([field, entry]) => [
      field,
      field === "href" && typeof entry === "string"
        ? redactUrl(entry, field).value
        : entry && typeof entry === "object" && !Array.isArray(entry)
          ? sanitizeDescriptorUrls(entry as Record<string, unknown>)
          : entry,
    ]),
  );
}

function sanitizeTextAttributes(
  element: Element,
  config: CrumbtrailConfig,
  unmasked: boolean,
): void {
  if (unmasked || !config.maskAllText) return;
  for (const attribute of Array.from(element.attributes)) {
    if (
      attribute.name === "placeholder" ||
      attribute.name.toLowerCase().startsWith("aria-")
    )
      element.setAttribute(attribute.name, maskText(attribute.value));
  }
}

function isFormValueElement(
  element: Element,
): element is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  );
}
