/**
 * @stability stable
 * Read-side mirror of the cloud's code pointer projection (crumbtrail cloud
 * GitHub integration, CP3). The cloud resolves occurrence evidence into
 * GitHub permalinks pinned to a deploy sha (resolution "deploy") or the
 * default-branch head (resolution "head") and rides them along inside the
 * canonical opinion artifact (`canonicalResults[].codePointers`). This module
 * only validates and projects what the cloud wrote — it never fabricates a
 * pointer.
 */

/** Whether a pointer's commit came from a deploy binding or a branch head. */
export type CodePointerResolution = "deploy" | "head";

/** A single resolved, clickable pointer into source at a pinned commit. */
export interface CodePointer {
  repo: string;
  path: string;
  line?: number;
  commitSha: string;
  permalink: string;
  resolution: CodePointerResolution;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toCodePointer(value: unknown): CodePointer | undefined {
  if (!isRecord(value)) return undefined;
  const { repo, path, line, commitSha, permalink, resolution } = value;
  if (typeof repo !== "string" || repo.length === 0) return undefined;
  if (typeof path !== "string" || path.length === 0) return undefined;
  if (typeof commitSha !== "string" || commitSha.length === 0)
    return undefined;
  if (typeof permalink !== "string" || permalink.length === 0)
    return undefined;
  if (resolution !== "deploy" && resolution !== "head") return undefined;
  const pointer: CodePointer = { repo, path, commitSha, permalink, resolution };
  if (typeof line === "number" && Number.isFinite(line)) pointer.line = line;
  return pointer;
}

/**
 * Projects the cloud-resolved code pointers out of a canonical opinion
 * artifact (`{ canonicalResults: [{ codePointers?: [...] }] }`). Entries that
 * do not validate against the pointer shape are skipped rather than passed
 * through malformed; duplicates (same permalink) are collapsed in first-seen
 * order. Returns undefined when the artifact carries no valid pointers so
 * callers can omit the field instead of emitting an empty list that a reader
 * could mistake for "resolved, no match".
 */
export function extractOpinionCodePointers(
  opinion: unknown,
): CodePointer[] | undefined {
  if (!isRecord(opinion) || !Array.isArray(opinion.canonicalResults))
    return undefined;
  const seen = new Set<string>();
  const pointers: CodePointer[] = [];
  for (const entry of opinion.canonicalResults) {
    if (!isRecord(entry) || !Array.isArray(entry.codePointers)) continue;
    for (const raw of entry.codePointers) {
      const pointer = toCodePointer(raw);
      if (!pointer || seen.has(pointer.permalink)) continue;
      seen.add(pointer.permalink);
      pointers.push(pointer);
    }
  }
  return pointers.length > 0 ? pointers : undefined;
}
