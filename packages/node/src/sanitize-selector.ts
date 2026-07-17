/**
 * Removes CSS attribute predicate values before applying a bounded, UTF-16-safe
 * truncation. Attribute predicates may be malformed in captured browser data, so
 * an unterminated quoted predicate at the end of a selector is scrubbed too.
 */
export function sanitizeSelector(
  value: unknown,
  maxLength = 240,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const withoutAttributeValues = stripAttributePredicateValues(trimmed);
  return truncateSurrogateSafe(withoutAttributeValues, maxLength);
}

function stripAttributePredicateValues(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    const predicateStart = value.indexOf("[", cursor);
    if (predicateStart < 0) return result + value.slice(cursor);

    result += value.slice(cursor, predicateStart);
    const attributeMatch = /^\[\s*([\w:-]+)\s*[~|^$*]?=\s*/.exec(
      value.slice(predicateStart),
    );
    if (!attributeMatch) {
      result += "[";
      cursor = predicateStart + 1;
      continue;
    }

    const valueStart = predicateStart + attributeMatch[0].length;
    const quote = value[valueStart];
    const predicateEnd =
      quote === '"' || quote === "'"
        ? quotedPredicateEnd(value, valueStart, quote)
        : unquotedPredicateEnd(value, valueStart);

    result += `[${attributeMatch[1]}]`;
    cursor = predicateEnd;
  }

  return result;
}

function quotedPredicateEnd(
  value: string,
  valueStart: number,
  quote: string,
): number {
  let cursor = valueStart + 1;
  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === quote) {
      const closingBracket = value.indexOf("]", cursor + 1);
      return closingBracket < 0 ? value.length : closingBracket + 1;
    }
    cursor += 1;
  }
  return value.length;
}

function unquotedPredicateEnd(value: string, valueStart: number): number {
  const closingBracket = value.indexOf("]", valueStart);
  return closingBracket < 0 ? value.length : closingBracket + 1;
}

function truncateSurrogateSafe(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  if (value.length <= maxLength) return value;

  let end = maxLength;
  const lastCodeUnit = value.charCodeAt(end - 1);
  if (lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff) end--;
  return value.slice(0, end);
}
