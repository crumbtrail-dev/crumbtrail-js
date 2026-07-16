import { redactTokenLikeString } from "./redaction";
import {
  CAPTURE_GAP_EVENT_KIND,
  type BugEvent,
  type CaptureGapEventData,
} from "./types";

export interface BuildCaptureGapEventInput {
  surface: CaptureGapEventData["surface"];
  reason: CaptureGapEventData["reason"];
  /** A safe diagnostic descriptor, never raw SQL or user data. */
  detail?: string;
  t?: number;
  sessionId?: string;
  sessionStartedAt?: number | Date;
}

const MAX_CAPTURE_GAP_DETAIL_LENGTH = 500;
const REDACTED_VALUE = "[REDACTED]";

// Capture gap details must never carry arbitrary values. These patterns cover the user data
// shapes that are not handled by redactTokenLikeString's credential focused token patterns.
const EMAIL_ADDRESS_RE =
  /\b[A-Z0-9._%+-]+@[A-Z0-9-]+(?:\.[A-Z0-9-]+)+\b/gi;
const PHONE_LIKE_RE =
  /(?<![A-Za-z0-9])\+?\d[\d().\s-]{6,}\d(?![A-Za-z0-9])/g;
const LONG_DIGIT_SEQUENCE_RE = /(?<!\d)\d{7,}(?!\d)/g;
const SQL_KEYWORD_RE =
  /\b(INSERT|UPDATE|DELETE|MERGE|REPLACE|UPSERT|WITH|PREPARE|SELECT)\b/i;
const SQL_TABLE_RE =
  /\b(?:INTO|UPDATE|FROM|TABLE)\s+((?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)(?:\s*\.\s*(?:"[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)){0,2})/i;
const ERROR_CLASS_RE =
  /\b(Error|[A-Z][A-Za-z0-9_$]*(?:Error|Exception))\b/g;

/**
 * Builds the canonical bounded completeness event. The input detail is redacted defensively and
 * all callers provide a classification only, never a query, bind values, or an error message.
 */
export function buildCaptureGapEvent(
  input: BuildCaptureGapEventInput,
): BugEvent {
  const t = normalizeTimestamp(input.t);
  const detail = sanitizeDetail(input.detail);
  const d: CaptureGapEventData = {
    kind: "capture_gap",
    surface: input.surface,
    reason: input.reason,
    ...(detail ? { detail } : {}),
    t,
  };
  const event: BugEvent = {
    t,
    k: CAPTURE_GAP_EVENT_KIND,
    d: d as unknown as Record<string, unknown>,
  };
  if (input.sessionId) event.sessionId = input.sessionId;

  const sessionStartedAt = normalizeTimestampValue(input.sessionStartedAt);
  if (sessionStartedAt !== undefined)
    event.offsetMs = Math.max(0, t - sessionStartedAt);

  return event;
}

function normalizeTimestamp(value: number | undefined): number {
  return Number.isFinite(value) ? Math.round(value as number) : Date.now();
}

function normalizeTimestampValue(
  value: number | Date | undefined,
): number | undefined {
  const timestamp = value instanceof Date ? value.getTime() : value;
  return Number.isFinite(timestamp)
    ? Math.round(timestamp as number)
    : undefined;
}

function sanitizeDetail(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const redacted = redactDetailValue(value);
  const classifications = captureGapClassifications(redacted);
  const normalized = classifications.join(" ").replace(/\s+/g, " ").trim();
  return normalized
    ? normalized.slice(0, MAX_CAPTURE_GAP_DETAIL_LENGTH)
    : undefined;
}

function redactDetailValue(value: string): string {
  const withoutSqlLiterals = value
    .replace(/'(?:''|[^'])*'/g, `'${REDACTED_VALUE}'`)
    .replace(/\"(?:\"\"|[^\"])*\"/g, `\"${REDACTED_VALUE}\"`);
  return redactTokenLikeString(
    withoutSqlLiterals
      .replace(EMAIL_ADDRESS_RE, REDACTED_VALUE)
      .replace(PHONE_LIKE_RE, REDACTED_VALUE)
      .replace(LONG_DIGIT_SEQUENCE_RE, REDACTED_VALUE),
    "capture_gap.detail",
  ).value;
}

/**
 * Detail is a diagnostic classification, not an error message. Retain only a SQL keyword, a
 * table identifier observed in SQL grammar, an error class, and a redaction marker. This keeps
 * useful operation context while preventing arbitrary text from becoming captured evidence.
 */
function captureGapClassifications(value: string): string[] {
  const classifications: string[] = [];
  const keyword = SQL_KEYWORD_RE.exec(value)?.[1];
  if (keyword) classifications.push(keyword.toUpperCase());

  const table = SQL_TABLE_RE.exec(value)?.[1];
  if (table) classifications.push(`table ${table.replace(/\s+/g, "")}`);

  ERROR_CLASS_RE.lastIndex = 0;
  for (const match of value.matchAll(ERROR_CLASS_RE)) {
    classifications.push(match[1]);
  }
  if (value.includes(REDACTED_VALUE)) classifications.push(REDACTED_VALUE);

  return [...new Set(classifications)];
}
