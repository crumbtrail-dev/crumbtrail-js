import type { EventBus } from "../event-bus";
import type { CrumbtrailConfig, CollectorCleanup } from "../types";
import { now } from "../utils";
import {
  REDACTED_VALUE,
  attachRedactionMetadata,
  redactInputValue,
  redactValue,
} from "../redaction";
import { isBlocked, isUnmasked } from "../masking";

const SENSITIVE_AUTOCOMPLETE_TOKENS = new Set([
  "cc-additional-name",
  "cc-csc",
  "cc-exp",
  "cc-exp-month",
  "cc-exp-year",
  "cc-family-name",
  "cc-given-name",
  "cc-name",
  "cc-number",
  "cc-type",
  "current-password",
  "email",
  "new-password",
  "one-time-code",
  "tel",
  "tel-area-code",
  "tel-country-code",
  "tel-extension",
  "tel-local",
  "tel-local-prefix",
  "tel-local-suffix",
  "tel-national",
  "transaction-amount",
  "transaction-currency",
  "username",
]);

export function keystrokeCollector(
  bus: EventBus,
  config: CrumbtrailConfig,
): CollectorCleanup {
  let lastKeystrokeTs = 0;
  let lastKeyupTs = 0;
  const throttleMs = config.keystrokeThrottleMs;

  function getModifiers(e: KeyboardEvent): string | undefined {
    let mod = "";
    if (e.ctrlKey) mod += "c";
    if (e.shiftKey) mod += "s";
    if (e.altKey) mod += "a";
    if (e.metaKey) mod += "m";
    return mod || undefined;
  }

  function inputName(target: EventTarget | null): string | undefined {
    if (
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    ) {
      return target.name || target.id || undefined;
    }
    return undefined;
  }

  function inputType(target: EventTarget | null): string | undefined {
    return target instanceof HTMLInputElement
      ? target.type.toLowerCase()
      : undefined;
  }

  function hasSensitiveMarker(target: EventTarget | null): boolean {
    if (!(target instanceof Element)) return false;
    if (
      target.closest(
        '[data-sensitive="true"],[data-sensitive=""],[data-crumbtrail-sensitive="true"],[data-crumbtrail-sensitive=""]',
      )
    ) {
      return true;
    }
    const autocomplete = target.getAttribute("autocomplete");
    if (!autocomplete) return false;
    return autocomplete
      .toLowerCase()
      .split(/\s+/)
      .some((token) => SENSITIVE_AUTOCOMPLETE_TOKENS.has(token));
  }

  function shouldMaskKey(target: EventTarget | null): boolean {
    const explicitlyUnmasked = target instanceof Element && isUnmasked(target);
    if (!explicitlyUnmasked && (config.maskAllText || config.maskAllInputs))
      return true;
    if (hasSensitiveMarker(target)) return true;
    const type = inputType(target);
    if (
      type &&
      config.maskInputTypes.map((entry) => entry.toLowerCase()).includes(type)
    )
      return true;
    const name = inputName(target);
    if (!name) return false;
    return Boolean(redactValue({ [name]: "x" }, "key.el").metadata);
  }

  function emitKeyEvent(e: KeyboardEvent, dir: "dn" | "up"): void {
    const t = now();

    if (dir === "up" && throttleMs > 0 && t - lastKeyupTs < throttleMs) {
      return;
    }

    const dt = lastKeystrokeTs > 0 ? t - lastKeystrokeTs : undefined;
    lastKeystrokeTs = t;
    if (dir === "up") lastKeyupTs = t;

    const target = e.target;
    if (target instanceof Element && isBlocked(target)) return;
    const el: Record<string, unknown> = {
      tag: target instanceof Element ? target.tagName : "UNKNOWN",
    };
    if (target instanceof Element && target.id) el.id = target.id;
    if (target instanceof HTMLInputElement && target.name)
      el.name = target.name;

    const masked = shouldMaskKey(target);
    const keyRedaction = masked
      ? redactInputValue(e.key, {
          name: inputName(target),
          type: inputType(target),
          path: "key",
        })
      : undefined;
    const d: Record<string, unknown> = {
      key: masked ? "*" : e.key,
      code: e.code,
      dir,
      el,
      mod: getModifiers(e),
      dt,
    };
    if (masked && e.key) {
      attachRedactionMetadata(
        d,
        keyRedaction?.metadata ?? redactValue(REDACTED_VALUE, "key").metadata,
      );
    }

    bus.emit({
      t,
      k: "key",
      d,
    });
  }

  const onKeydown = (e: KeyboardEvent) => emitKeyEvent(e, "dn");
  const onKeyup = (e: KeyboardEvent) => emitKeyEvent(e, "up");

  document.addEventListener("keydown", onKeydown, true);
  document.addEventListener("keyup", onKeyup, true);

  return () => {
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("keyup", onKeyup, true);
  };
}
