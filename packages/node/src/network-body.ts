import { redactNetworkTextBody } from "crumbtrail-core";

export const NETWORK_BODY_SNIPPET_MAX_CHARS = 300;
const NETWORK_BODY_INPUT_MAX_CHARS = 4096;
const NETWORK_BODY_MAX_DEPTH = 4;
const NETWORK_BODY_MAX_COLLECTION_ENTRIES = 24;
const BODY_SUMMARY_KINDS = new Set([
  "json",
  "text",
  "form",
  "binary",
  "stream",
  "storage",
  "cookie",
  "input",
  "unknown",
]);
const BODY_SUMMARY_ACTIONS = new Set(["redacted", "dropped", "summarized"]);
const BODY_SUMMARY_REASONS = new Set([
  "form_value",
  "text_key_value_fields",
  "markup_sensitive_fields",
  "payload_too_large",
  "sensitive_json_field",
  "malformed_json_body",
  "token_like_value",
  "url_query_value",
  "binary_payload",
  "stream_payload",
  "body_read_failed",
  "non_text_request_body",
  "unknown",
]);

/**
 * Formats already-captured network payload evidence for derived artifacts.
 * Capture redacts first; this reapplies the same policy before rendering so a
 * malformed or legacy event cannot introduce a new raw-payload path.
 */
export function redactedNetworkBodySnippet(
  body: unknown,
  bodySummary?: unknown,
  maxChars = NETWORK_BODY_SNIPPET_MAX_CHARS,
): string | undefined {
  if (isDeduplicatedBody(body)) return summarizeBody(bodySummary);

  const serialized = serializeBody(body);
  if (serialized) {
    const redacted = redactNetworkTextBody(serialized, {
      path: "body",
    }).body;
    if (redacted)
      return truncate(normalize(hideSensitiveBodyFields(redacted)), maxChars);
  }

  return summarizeBody(bodySummary);
}

function isDeduplicatedBody(value: unknown): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    (value as Record<string, unknown>).dedup === true
  );
}

function serializeBody(value: unknown): string | undefined {
  if (typeof value === "string")
    return truncate(value, NETWORK_BODY_INPUT_MAX_CHARS);
  if (value === undefined || value === null) return undefined;
  try {
    // Never stringify an unbounded captured value. JSON.stringify can allocate a
    // full copy before the derived 300-character snippet is truncated.
    return JSON.stringify(
      boundBodyValue(value, { remaining: NETWORK_BODY_INPUT_MAX_CHARS }),
    );
  } catch {
    return undefined;
  }
}

function boundBodyValue(
  value: unknown,
  budget: { remaining: number },
  depth = 0,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "string") return takeBodyText(value, budget);
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  )
    return value;
  if (typeof value === "bigint") return takeBodyText(String(value), budget);
  if (typeof value !== "object") return undefined;
  if (depth >= NETWORK_BODY_MAX_DEPTH) return "[TRUNCATED]";
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    const entries: unknown[] = [];
    for (
      let index = 0;
      index < value.length &&
      index < NETWORK_BODY_MAX_COLLECTION_ENTRIES &&
      budget.remaining > 0;
      index += 1
    ) {
      entries.push(boundBodyValue(value[index], budget, depth + 1, seen));
    }
    return entries;
  }

  const entries: Record<string, unknown> = {};
  let count = 0;
  for (const key in value) {
    if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
    if (count >= NETWORK_BODY_MAX_COLLECTION_ENTRIES || budget.remaining <= 0)
      break;
    const boundedKey = takeBodyText(key, budget, 128);
    if (!boundedKey) break;
    try {
      entries[boundedKey] = boundBodyValue(
        (value as Record<string, unknown>)[key],
        budget,
        depth + 1,
        seen,
      );
    } catch {
      entries[boundedKey] = "[UNAVAILABLE]";
    }
    count += 1;
  }
  return entries;
}

function takeBodyText(
  value: string,
  budget: { remaining: number },
  maxLength = budget.remaining,
): string {
  const length = Math.min(budget.remaining, maxLength);
  const bounded = truncate(value, length);
  budget.remaining = Math.max(0, budget.remaining - bounded.length);
  return bounded;
}

function summarizeBody(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const summary = value as Record<string, unknown>;
  const kind = allowedSummaryValue(summary.kind, BODY_SUMMARY_KINDS, 40);
  const action = allowedSummaryValue(summary.action, BODY_SUMMARY_ACTIONS, 40);
  const reason = allowedSummaryReason(summary.reason);
  if (!kind && !action && !reason) return undefined;
  return ["body unavailable", kind ? `(${kind})` : undefined, action, reason]
    .filter((part): part is string => part !== undefined)
    .join("; ");
}

function allowedSummaryValue(
  value: unknown,
  allowed: Set<string>,
  maxLength: number,
): string | undefined {
  const normalized = text(value, maxLength);
  if (!normalized) return undefined;
  return allowed.has(normalized) ? normalized : "unknown";
}

function allowedSummaryReason(value: unknown): string | undefined {
  const normalized = text(value, 80);
  if (!normalized) return undefined;
  if (normalized.startsWith("binary_payload:")) return "binary_payload";
  return BODY_SUMMARY_REASONS.has(normalized) ? normalized : "unknown";
}

function text(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalize(value);
  return normalized ? truncate(normalized, maxLength) : undefined;
}

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

// The core policy masks sensitive values but intentionally preserves JSON keys
// for diagnostic shape. Derived LLM artifacts should not expose those key names
// either, and older sessions may contain form bodies that predate the collector.
function hideSensitiveBodyFields(value: string): string {
  const sensitiveAssignment =
    /(["']?)(?:access[-_]?token|api[-_]?key|auth(?:orization)?|bearer|card(?:[-_]?number)?|client[-_]?secret|cookie|credential(?:s)?|csrf|cvv|cvc|id[-_]?token|jwt|otp|pass(?:code|word|phrase)?|passwd|password(?:[-_]?confirmation)?|pin|private[-_]?key|pwd|refresh[-_]?token|secret|session(?:[-_]?id)?|sid|ssn|token|verification[-_]?code|xsrf)\1\s*([:=])\s*(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^,;&\s}\]]+)/gi;
  return value
    .replace(sensitiveAssignment, "[REDACTED_KEY]$2[REDACTED]")
    .replace(/\b(?:supersecret|secret)[a-z0-9_-]*/gi, "[REDACTED]");
}

function truncate(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  return value.length <= maxLength
    ? value
    : `${value.slice(0, truncateEnd(value, maxLength - 1))}…`;
}

function truncateEnd(value: string, maxLength: number): number {
  const end = Math.max(0, maxLength);
  const lastCodeUnit = value.charCodeAt(end - 1);
  return lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff ? end - 1 : end;
}
