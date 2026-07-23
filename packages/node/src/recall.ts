import { buildDistinctBugSignature, type DistinctBug } from "./distinct-bugs";
import { defaultSessionStore } from "./session-store";

// --- Local issue recall ("have we seen this before?") ---------------------
// A dependency-free, offline analogue of the cloud hybrid recall: text overlap
// stands in for the vector term, combined with the same structured boosts.
// score = 0.6·text-overlap + 0.2·same-route + 0.1·same-error-family + 0.1·env-overlap
//
// This module is the recall/similarity engine, extracted from the MCP server so
// it can be exercised without a JSON-RPC transport. Storage access is injected
// through a small `RecallStore` seam rather than reaching into the server class.

/**
 * Storage seam the recall engine depends on. The MCP server satisfies this by
 * delegating to its session store + JSON readers; tests can supply an in-memory
 * fake to exercise ranking/dedup/limit without any real MCP server or files.
 */
export interface RecallStore {
  listSessions(): Promise<Array<{ id: string; dir: string }>>;
  readJsonRecord(
    dir: string,
    name: string,
  ): Promise<Record<string, unknown> | undefined>;
  readDistinctBugs(dir: string): Promise<unknown[]>;
  /** Pure structural guard — no IO, so it stays synchronous. */
  isDistinctBugRecord(x: unknown): boolean;
}

export interface LocalIssueProfile {
  tokens: string[];
  route?: string;
  errorFamily?: string;
  facetTokens: string[];
}

// Minimal private copies of the shared record helpers (kept private in
// mcp-server.ts). Duplicated here to keep the engine dependency-free.
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

export function tokenizeIssueText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[redacted\]/g, " ")
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && token.length < 40);
}

export function jaccardTokens(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const value of setA) if (setB.has(value)) intersection += 1;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

export function scoreLocalIssue(
  query: LocalIssueProfile,
  candidate: LocalIssueProfile,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const textSim = jaccardTokens(query.tokens, candidate.tokens);
  if (textSim >= 0.3) reasons.push("semantic");
  let sameRoute = 0;
  if (
    query.route &&
    candidate.route &&
    query.route.trim().toLowerCase() === candidate.route.trim().toLowerCase()
  ) {
    sameRoute = 1;
    reasons.push("same-route");
  }
  let sameError = 0;
  if (
    query.errorFamily &&
    candidate.errorFamily &&
    query.errorFamily === candidate.errorFamily
  ) {
    sameError = 1;
    reasons.push("same-error");
  }
  const envOverlap = jaccardTokens(query.facetTokens, candidate.facetTokens);
  if (envOverlap > 0) reasons.push("env-overlap");
  const score =
    0.6 * textSim + 0.2 * sameRoute + 0.1 * sameError + 0.1 * envOverlap;
  return { score, reasons };
}

export function strongestBug(bugs: DistinctBug[]): DistinctBug {
  const rank: Record<string, number> = {
    critical: 4,
    high: 3,
    medium: 2,
    low: 1,
  };
  return [...bugs].sort(
    (a, b) =>
      (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0) ||
      a.firstSeen - b.firstSeen,
  )[0];
}

export function bugProfile(
  bug: DistinctBug,
  bundle: Record<string, unknown>,
): LocalIssueProfile {
  const rep = bug.representative ?? ({} as DistinctBug["representative"]);
  const tokens = tokenizeIssueText(
    [bug.title, rep.detector, rep.message, rep.route]
      .filter((v): v is string => Boolean(v))
      .join(" "),
  );
  const env = isRecord(bundle.environment) ? bundle.environment : {};
  const flagKeys = isRecord(env.flags) ? Object.keys(env.flags) : [];
  const configKeys = isRecord(env.config) ? Object.keys(env.config) : [];
  const requestIds = new Set(bug.requestIds ?? []);
  const dbTables = Array.isArray(bundle.databaseDiffs)
    ? bundle.databaseDiffs
        .filter(isRecord)
        .filter(
          (diff) =>
            typeof diff.requestId !== "string" ||
            requestIds.has(diff.requestId),
        )
        .map((diff) => stringField(diff.table))
        .filter((table): table is string => Boolean(table))
    : [];
  return {
    tokens,
    route: rep.route,
    errorFamily: rep.detector,
    facetTokens: [...flagKeys, ...configKeys, ...dbTables],
  };
}

/** Build a recall query profile from a session's strongest distinct bug. */
export async function sessionIssueProfile(
  dir: string,
  store: RecallStore,
): Promise<LocalIssueProfile | undefined> {
  const bugs = (await store.readDistinctBugs(dir)).filter((bug) =>
    store.isDistinctBugRecord(bug),
  ) as unknown as DistinctBug[];
  if (bugs.length === 0) return undefined;
  const seed = strongestBug(bugs);
  const bundle =
    (await store.readJsonRecord(dir, "llm.json")) ??
    (await store.readJsonRecord(dir, "bundle.json")) ??
    {};
  return bugProfile(seed, bundle);
}

/** Scan the local session store and rank every distinct bug against the query. */
export async function recallLocal(
  query: LocalIssueProfile,
  store: RecallStore,
  excludeSessionId: string | undefined,
  limit: number,
): Promise<Record<string, unknown>[]> {
  const scored: Array<{
    score: number;
    reasons: string[];
    signature: string | undefined;
    match: Record<string, unknown>;
  }> = [];
  for (const { id, dir } of await store.listSessions()) {
    if (excludeSessionId && id === excludeSessionId) continue;
    const bundle =
      (await store.readJsonRecord(dir, "llm.json")) ??
      (await store.readJsonRecord(dir, "bundle.json")) ??
      {};
    for (const raw of await store.readDistinctBugs(dir)) {
      if (!store.isDistinctBugRecord(raw)) continue;
      const bug = raw as unknown as DistinctBug;
      const candidate = bugProfile(bug, bundle);
      const { score, reasons } = scoreLocalIssue(query, candidate);
      if (score <= 0) continue;
      scored.push({
        score,
        reasons,
        signature: buildDistinctBugSignature(bug),
        match: removeUndefined({
          sessionId: id,
          bugId: bug.bugId,
          signature: buildDistinctBugSignature(bug),
          title: bug.title,
          route: bug.representative?.route,
          errorFamily: bug.representative?.detector,
          severity: bug.severity,
          score: Math.round(score * 1000) / 1000,
          reasons,
        }),
      });
    }
  }
  // Dedupe by signature, keeping the highest-scoring occurrence.
  const bySignature = new Map<string, (typeof scored)[number]>();
  const unkeyed: (typeof scored)[number][] = [];
  for (const entry of scored) {
    if (!entry.signature) {
      unkeyed.push(entry);
      continue;
    }
    const existing = bySignature.get(entry.signature);
    if (!existing || entry.score > existing.score)
      bySignature.set(entry.signature, entry);
  }
  return [...bySignature.values(), ...unkeyed]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.match);
}

// --- Storage-plane readers (extracted verbatim from McpServer) -------------
//
// These three helpers were private-but-stateless methods on McpServer. They are
// extracted here — the home of the RecallStore seam — so both the MCP tool
// (via McpServer, which now delegates to them) and the inner HTTP endpoint (via
// buildRecallStore) share ONE implementation. Behavior is byte-identical to the
// original private methods.

/** Read + JSON-parse a single named artifact from a session dir, or undefined
 *  when it is absent or not a JSON object. Never throws. */
export async function readSessionJsonRecord(
  dir: string,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const buf = await defaultSessionStore.readArtifact(dir, name);
    if (!buf) return undefined;
    const parsed: unknown = JSON.parse(buf.toString("utf-8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Read the grouped distinct bugs from a session's finalized hot-plane bundle
 *  (llm.json, else bundle.json). Returns [] when absent. */
export async function readSessionDistinctBugs(
  dir: string,
): Promise<Record<string, unknown>[]> {
  const bundle =
    (await readSessionJsonRecord(dir, "llm.json")) ??
    (await readSessionJsonRecord(dir, "bundle.json"));
  return Array.isArray(bundle?.distinctBugs)
    ? bundle!.distinctBugs.filter(isRecord)
    : [];
}

/** Structural guard: is `bug` a fully-formed distinct-bug record? */
export function isDistinctBugRecord(bug: unknown): bug is DistinctBug {
  if (!isRecord(bug)) return false;
  return (
    typeof bug.bugId === "string" &&
    typeof bug.title === "string" &&
    typeof bug.severity === "string" &&
    typeof bug.firstSeen === "number" &&
    typeof bug.lastSeen === "number" &&
    isRecord(bug.representative)
  );
}

/** Build a RecallStore rooted at `outputDir` from the shared storage readers.
 *  Identical to the store McpServer.recallStore() constructs, so the MCP tool
 *  and the inner /api/solve-context endpoint locate against the same data. */
export function buildRecallStore(outputDir: string): RecallStore {
  return {
    listSessions: () => defaultSessionStore.listSessions(outputDir),
    readJsonRecord: (dir, name) => readSessionJsonRecord(dir, name),
    readDistinctBugs: (dir) => readSessionDistinctBugs(dir),
    isDistinctBugRecord: (x) => isDistinctBugRecord(x),
  };
}

/** Delegate recall to the cloud org-memory index when configured. Returns
 *  undefined (falling back to local) on any misconfiguration or transport error. */
export async function recallViaCloud(
  sessionId: string | undefined,
  query: string | undefined,
  limit: number,
): Promise<Record<string, unknown> | undefined> {
  const base = process.env.CRUMBTRAIL_CLOUD_URL?.replace(/\/+$/, "");
  const apiKey = process.env.CRUMBTRAIL_API_KEY;
  if (!base || !apiKey) return undefined;
  const params = new URLSearchParams({ limit: String(limit) });
  if (sessionId) params.set("sessionId", sessionId);
  else if (query) params.set("q", query);
  else return undefined;
  try {
    const res = await fetch(`${base}/api/memory/recall?${params.toString()}`, {
      headers: { "X-Crumbtrail-Auth": apiKey },
    });
    if (!res.ok) return undefined;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Pull a pre-assembled ticket bundle from the cloud by-ticket endpoint. Reads the
 * SAME env pair recallViaCloud uses (CRUMBTRAIL_CLOUD_URL/CRUMBTRAIL_API_KEY) and
 * authenticates with the same X-Crumbtrail-Auth project key. Returns the parsed
 * `{ id, status, confidence, sessionId?, bundle }` envelope on a hit, or undefined
 * on ANY miss/failure/unconfigured env — the caller then falls back to the local
 * fetch + auto-locate path. This deliberate always-fall-back shape (identical to
 * recallViaCloud) makes the pull a fast path, never a hard dependency: a cloud
 * outage degrades to local behavior, it never fails the MCP call.
 */
export async function pullBundleByTicketViaCloud(
  provider: string,
  ticketKey: string,
): Promise<Record<string, unknown> | undefined> {
  const base = process.env.CRUMBTRAIL_CLOUD_URL?.replace(/\/+$/, "");
  const apiKey = process.env.CRUMBTRAIL_API_KEY;
  if (!base || !apiKey) return undefined;
  const params = new URLSearchParams({ provider, ticketKey });
  try {
    const res = await fetch(
      `${base}/api/bundles/by-ticket?${params.toString()}`,
      { headers: { "X-Crumbtrail-Auth": apiKey } },
    );
    if (!res.ok) return undefined;
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
