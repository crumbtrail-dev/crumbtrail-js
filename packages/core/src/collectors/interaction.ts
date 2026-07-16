import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import {
  BROWSER_REDACTION_POLICY,
  attachRedactionMetadata,
  redactInputValue,
  redactUrl,
  type RedactionMetadata,
} from "../redaction";
import {
  isBlocked,
  isUnmasked,
  maskElementDescriptor,
  maskText,
} from "../masking";
import { describeElement, now } from "../utils";

function describeInteractionTarget(
  target: Element,
  config: CrumbtrailConfig,
): Record<string, unknown> {
  try {
    const descriptor =
      config.describeInteractionElement?.(target) ?? describeElement(target);
    if (isRecord(descriptor))
      return maskElementDescriptor(target, removeUndefined(descriptor), config);
  } catch {
    // Keep interaction capture alive even if a page-specific descriptor probe fails.
  }

  return {
    tag: target.tagName,
    descriptorError: "interaction_descriptor_failed",
  };
}

function readDescriptorMetadata(
  descriptor: Record<string, unknown>,
): RedactionMetadata | undefined {
  const redaction = descriptor.redaction;
  if (!isRecord(redaction)) return undefined;
  if (redaction.policy !== BROWSER_REDACTION_POLICY) return undefined;
  if (!Array.isArray(redaction.fields)) return undefined;
  return redaction as unknown as RedactionMetadata;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

function readSafeOrigin(url: string): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, window.location.href);
    return parsed.origin === "null" ? undefined : parsed.origin;
  } catch {
    return undefined;
  }
}

function isTopFrame(): boolean {
  try {
    return window.self === window.top;
  } catch {
    return false;
  }
}

function describeFrameContext(url: string): Record<string, unknown> {
  return removeUndefined({
    top: isTopFrame(),
    origin: readSafeOrigin(url),
  });
}

export function interactionCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  const cleanups: Array<() => void> = [];

  // --- Clicks ---
  const onClick = (e: MouseEvent) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (isBlocked(target)) return;

    for (const sel of config.ignoreSelectors) {
      if (target.matches(sel)) return;
    }

    const el = describeInteractionTarget(target, config);
    const d: Record<string, unknown> = {
      el,
      pos: [e.clientX, e.clientY],
    };
    attachRedactionMetadata(d, readDescriptorMetadata(el));

    bus.emit({
      t: now(),
      k: "clk",
      d,
    });
  };
  document.addEventListener("click", onClick, true);
  cleanups.push(() => document.removeEventListener("click", onClick, true));

  // --- Input / Change ---
  const onInput = (e: Event) => {
    const target = e.target;
    if (!(
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ))
      return;
    if (isBlocked(target)) return;

    const el = describeInteractionTarget(target, config);
    const type = target instanceof HTMLInputElement ? target.type : undefined;
    const redacted = redactInputValue(target.value, {
      name: target.name || undefined,
      type,
      path: "val",
    });
    const val = isUnmasked(target)
      ? { value: target.value, summary: undefined, metadata: undefined }
      : config.maskAllInputs
        ? { ...redacted, value: maskText(target.value) }
        : redacted;
    const d: Record<string, unknown> = {
      el,
      val: val.value,
      ev: e.type as "input" | "change",
    };
    if (val.summary) d.valSummary = val.summary;
    attachRedactionMetadata(d, readDescriptorMetadata(el), val.metadata);

    bus.emit({
      t: now(),
      k: "inp",
      d,
    });
  };
  document.addEventListener("input", onInput, true);
  document.addEventListener("change", onInput, true);
  cleanups.push(() => {
    document.removeEventListener("input", onInput, true);
    document.removeEventListener("change", onInput, true);
  });

  // --- Submit ---
  const onSubmit = (e: Event) => {
    const target = e.target;
    if (!(target instanceof HTMLFormElement)) return;
    if (isBlocked(target)) return;

    const el = describeInteractionTarget(target, config);
    const d: Record<string, unknown> = {
      el,
      val: "",
      ev: "submit",
    };
    attachRedactionMetadata(d, readDescriptorMetadata(el));

    bus.emit({
      t: now(),
      k: "inp",
      d,
    });
  };
  document.addEventListener("submit", onSubmit, true);
  cleanups.push(() => document.removeEventListener("submit", onSubmit, true));

  // --- Navigation ---
  let currentUrl = window.location.href;

  const emitNav = (to: string, from: string, tr: string) => {
    const toResult = redactUrl(to, "to");
    const fromResult = from ? redactUrl(from, "from") : undefined;
    const d: Record<string, unknown> = removeUndefined({
      from: fromResult?.value ?? "",
      to: toResult.value,
      tr,
      fromOrigin: from ? readSafeOrigin(from) : undefined,
      toOrigin: readSafeOrigin(to),
      frame: describeFrameContext(to),
    });
    attachRedactionMetadata(d, fromResult?.metadata, toResult.metadata);
    bus.emit({ t: now(), k: "nav", d });
  };

  // Initial nav event
  emitNav(currentUrl, "", "init");

  const origPushState = history.pushState.bind(history);
  const origReplaceState = history.replaceState.bind(history);

  history.pushState = function (
    ...args: Parameters<typeof History.prototype.pushState>
  ) {
    const from = currentUrl;
    origPushState(...args);
    currentUrl = window.location.href;
    emitNav(currentUrl, from, "push");
  };

  history.replaceState = function (
    ...args: Parameters<typeof History.prototype.replaceState>
  ) {
    const from = currentUrl;
    origReplaceState(...args);
    currentUrl = window.location.href;
    emitNav(currentUrl, from, "replace");
  };

  const onPopState = () => {
    const from = currentUrl;
    currentUrl = window.location.href;
    emitNav(currentUrl, from, "pop");
  };
  window.addEventListener("popstate", onPopState);

  const onHashChange = () => {
    const from = currentUrl;
    currentUrl = window.location.href;
    emitNav(currentUrl, from, "hash");
  };
  window.addEventListener("hashchange", onHashChange);

  cleanups.push(() => {
    history.pushState = origPushState;
    history.replaceState = origReplaceState;
    window.removeEventListener("popstate", onPopState);
    window.removeEventListener("hashchange", onHashChange);
  });

  return () => {
    for (const fn of cleanups) fn();
  };
}
