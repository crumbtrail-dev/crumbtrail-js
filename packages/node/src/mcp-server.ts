import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import * as zlib from "node:zlib";
import { BugQueueManager } from "./bug-queue";
import {
  buildFixContext,
  buildFixContextFromArtifacts,
  FixContextError,
  type FixContext,
} from "./fix-context";
import { normalizeAiOpinion } from "./ai-diagnosis";
import { resolveLatestIssue } from "./latest-issue";
import {
  attachTokenEstimate,
  estimateTokens,
  fillToBudget,
} from "./token-estimate";
import { compareSessions } from "./compare";
import { buildRegressionContext } from "./compare/regression-context";
import {
  assembleBundle,
  inferIntent,
  type Symptom,
  type EvidenceGap,
  type EvidenceItem,
  type IntentSignal,
  type GitHostClient,
  type Located,
} from "crumbtrail-core";
import { GitHubRestClient, GitHostError } from "./git-host/github-rest";
import { ticketClientFromEnv, TicketError } from "./ticket/clients";
import type { TicketConnector } from "./ticket/clients";
import type { TicketProvider } from "./ticket/normalize";
import { parseTicketUrl } from "./ticket/url";
import type { Reproducer } from "./reproduce/types";
import {
  buildDistinctBugSignature,
  groupDistinctBugRecurrences,
  type DistinctBug,
  type DistinctBugRecurrence,
  type DistinctBugRecurrenceInput,
} from "./distinct-bugs";
import { defaultSessionStore } from "./session-store";
import { selectMcpReadStore, type McpReadStore } from "./mcp-read-store";
import type { EvidenceCandidate } from "./evidence-index";
import type { LlmBundle } from "./llm-bundle";
import {
  buildRecallStore,
  isDistinctBugRecord as isDistinctBugRecordShared,
  readSessionDistinctBugs,
  readSessionJsonRecord,
  pullBundleByTicketViaCloud,
  recallLocal,
  recallViaCloud,
  sessionIssueProfile,
  tokenizeIssueText,
  type LocalIssueProfile,
  type RecallStore,
} from "./recall";
import {
  gatherAdapterEvidence,
  locateEvidence,
  NO_LOCATED_SESSION_GAP,
} from "./locate-incident";
import {
  evidenceSourcesFromEnv,
  type EvidenceSource,
} from "./evidence-sources";

interface BugEvent {
  t: number;
  k: string;
  d: Record<string, unknown>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface McpServerConfig {
  outputDir: string;
  /** Test seam for the session-artifact read backend used by MCP read tools. */
  readStore?: McpReadStore;
  /**
   * Test-only seam: overrides how the git-host client is constructed for
   * `solveContext`'s intent-inference path. Production code leaves this
   * unset and builds a `GitHubRestClient` from `CRUMBTRAIL_GITHUB_TOKEN`.
   */
  gitHostClientFactory?: (gitHost: {
    owner: string;
    repo: string;
  }) => GitHostClient;
  /**
   * Test-only seam: overrides how the ticket connector is constructed for
   * `solveContext`'s `ticket` input. Production code leaves this unset and
   * builds a connector from the documented provider env vars.
   */
  ticketConnectorFactory?: (provider: TicketProvider) => TicketConnector;
  /**
   * Test-only seam: overrides how the on-demand `Reproducer` is constructed
   * for `solveContext`'s thin-evidence reproduction path. Production code
   * leaves this unset, which disables reproduction entirely — the gate
   * short-circuits and no reproducer (not even `NoopReproducer`) is built.
   */
  reproducerFactory?: () => Reproducer;
  /**
   * Test-only seam: overrides how the client's evidence sources are constructed
   * for `solveContext`'s adapter phase (sessionless Mode A + blended). Production
   * code leaves this unset and builds them from env via evidenceSourcesFromEnv().
   */
  evidenceSourcesFactory?: () => EvidenceSource[];
}

/**
 * Shared input-schema fragment for the optional `maxTokens` response budget
 * (getFixContext / getLatestIssue / solveContext / getWindow). One constant so
 * the documented chars/4 bias cannot drift between tools.
 */
const MAX_TOKENS_SCHEMA = {
  type: "integer" as const,
  minimum: 1,
  description:
    "Optional response token budget. Estimated as ceil(chars/4) of the serialized JSON. This low cost heuristic can undercount dense content such as non ASCII text, base64, or punctuation, so budget conservatively. When set, lower ranked items are dropped whole from the bottom of the ranking and never rewritten. The response gains tokenEstimate and a dropReport listing what was omitted. Omit it for the full payload.",
};

const TOOLS = [
  /** @stability stable */
  {
    name: "listSessions",
    description:
      "List recorded Crumbtrail sessions. These are complete app evidence sessions with clicks when present, console, network, backend spans, database row changes, environment, and feature flags. Use this first to find the sessionId for getFixContext, which covers one session, or getRegressionContext, which provides a cross release regression witness. Supports app, time, release, and build filters.",
    inputSchema: {
      type: "object" as const,
      properties: {
        app: { type: "string", description: "Filter by app name" },
        after: {
          type: "number",
          description: "Filter sessions after this timestamp",
        },
        before: {
          type: "number",
          description: "Filter sessions before this timestamp",
        },
        release: {
          type: "string",
          description: "Filter sessions by release/version metadata",
        },
        build: {
          type: "string",
          description: "Filter sessions by build/commit metadata",
        },
      },
    },
  },
  /** @stability stable */
  {
    name: "getIndex",
    description: "Get the index.json summary for a session",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  /** @stability stable */
  {
    name: "getEvents",
    description:
      "Get events from a session, optionally filtered by type or time range",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        kind: { type: "string", description: "Filter by event kind" },
        after: { type: "number" },
        before: { type: "number" },
        limit: {
          type: "number",
          description: "Max events to return (default 100)",
        },
      },
      required: ["sessionId"],
    },
  },
  /** @stability stable */
  {
    name: "getErrorContext",
    description: "Get error events with surrounding context events",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        windowMs: {
          type: "number",
          description: "Time window around each error in ms (default 2000)",
        },
      },
      required: ["sessionId"],
    },
  },
  /** @stability stable */
  {
    name: "getFailedRequests",
    description: "Get failed HTTP requests (status >= 400)",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  /** @stability stable */
  {
    name: "getLinkedRequestContext",
    description:
      "Get linked frontend/backend request evidence from index.fullStackRequests for a session/request ID",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        requestId: { type: "string" },
      },
      required: ["sessionId", "requestId"],
    },
  },
  /** @stability stable */
  {
    name: "getFixContext",
    description:
      "Give a coding agent complete bug context for one recorded session. Returns the fix-context.v2 bundle: deterministic signals with heuristic bases, the primary evidence window with correlated frontend requests, backend spans, and the exact database rows that changed, plus a redaction aware environment snapshot, causal chain, and repro hint. Start here when the user asks you to fix a bug captured with Crumbtrail.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        maxTokens: { ...MAX_TOKENS_SCHEMA },
      },
      required: ["sessionId"],
    },
  },
  /** @stability stable */
  {
    name: "getOpinion",
    description:
      "Get the optional LLM produced opinion for one session. Returns ranked hypotheses with confidence, evidence references, and explicit unknowns. It does not alter the neutral evidence bundle.",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  /** @stability stable */
  {
    name: "getLatestIssue",
    description:
      "The one call entry point: finds the most recent finalized session with error class evidence and returns its complete fix-context.v2 bundle with deterministic signals, the correlated primary window, environment snapshot, causal chain, and repro hint. Call it with no arguments when the user asks to fix the latest bug. Optional maxTokens bounds the response using a conservative character estimate.",
    inputSchema: {
      type: "object" as const,
      properties: { maxTokens: { ...MAX_TOKENS_SCHEMA } },
    },
  },
  /** @stability stable */
  {
    name: "getRegressionContext",
    description:
      "Compare two recorded sessions of the same flow across releases and return the regression-context.v1 witness verdict. Catches escaped regressions — behavior changes that fired no error — and hands back the diverging interaction, the causal window of correlated requests, the exact database rows whose values changed, and a repro hint. Input: { sessionA, sessionB } (ids or paths). Use listSessions to find sessions.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionA: { type: "string" },
        sessionB: { type: "string" },
      },
      required: ["sessionA", "sessionB"],
    },
  },
  /** @stability stable */
  {
    name: "solveContext",
    description:
      "Fuse a described symptom with locally recorded evidence into a fusion.v1 RankedBundle — the complete, neutral evidence (ranked by relevance) plus a structurally-separate advisory opinion of ranked hypotheses and any evidence gaps. Never a boolean verdict. Pass baselineSession + currentSession to gather evidence via compareSessions; omit both to get an evidence-free bundle describing gaps.",
    inputSchema: {
      type: "object" as const,
      properties: {
        symptom: {
          type: "object",
          properties: {
            title: { type: "string" },
            description: { type: "string" },
            release: { type: "string" },
            url: { type: "string" },
            user: { type: "string" },
            errorSig: { type: "string" },
          },
          required: ["title"],
        },
        ticket: {
          description:
            "Optional ticket reference. Either a pasted ticket URL (Jira *.atlassian.net /browse/KEY or /rest/api/N/issue/idOrKey; Zendesk *.zendesk.com; Trello card) OR an explicit { provider, ticketKey } (`id` is a deprecated alias for ticketKey). When a cloud deployment is configured (CRUMBTRAIL_CLOUD_URL + CRUMBTRAIL_API_KEY) a pre-assembled bundle stored for that ticket is returned directly; otherwise the ticket is fetched + normalized into a symptom via env credentials only (JIRA_*/ZENDESK_*/TRELLO_*, never a tool arg). The pasted URL's origin is never fetched. Passed symptom values win when both are present; an unrecognized URL is an honest miss, never an error.",
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                provider: {
                  type: "string",
                  enum: ["jira", "zendesk", "trello"],
                },
                ticketKey: {
                  type: "string",
                  description: "Ticket key/id in the provider's format",
                },
                id: {
                  type: "string",
                  description: "Deprecated alias for ticketKey",
                },
              },
              required: ["provider"],
            },
          ],
        },
        baselineSession: { type: "string" },
        currentSession: { type: "string" },
        gitHost: {
          type: "object",
          description:
            "Optional git-host range for intent-inference. Requires CRUMBTRAIL_GITHUB_TOKEN env var (never accepted as a tool arg); when absent, intent-inference is skipped.",
          properties: {
            owner: { type: "string" },
            repo: { type: "string" },
            baseRef: { type: "string" },
            headRef: { type: "string" },
          },
          required: ["owner", "repo", "baseRef", "headRef"],
        },
        allowReproduction: {
          type: "boolean",
          description:
            "Opt in to on-demand reproduction when historical evidence is thin (no sessions compared, or the comparison yielded no evidence). No-op unless a reproducer is configured. Defaults to false.",
        },
        maxTokens: { ...MAX_TOKENS_SCHEMA },
      },
    },
  },
  /** @stability stable */
  {
    name: "listDistinctBugs",
    description:
      'List the DISTINCT bugs a session hit, grouped deterministically from detector signals within a session. With mode:"cross-session", scans finalized sessions and returns recurrence rollups by stable bug signature. Use getBug for one session bug, or getRecurrence(signature) for one recurrence.',
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string",
          description: "Required unless mode is cross-session",
        },
        mode: { type: "string", enum: ["session", "cross-session"] },
        app: {
          type: "string",
          description: "Cross-session filter by app metadata",
        },
        tenant: {
          type: "string",
          description: "Cross-session filter by tenant metadata",
        },
      },
    },
  },
  /** @stability stable */
  {
    name: "getRecurrence",
    description:
      'Get a cross-session recurrence rollup by signature from listDistinctBugs({mode:"cross-session"}). Returns first_seen/last_seen, session_count, release_span, app/tenant labels, and per-session occurrences.',
    inputSchema: {
      type: "object" as const,
      properties: {
        signature: { type: "string" },
        app: { type: "string", description: "Optional app metadata filter" },
        tenant: {
          type: "string",
          description: "Optional tenant metadata filter",
        },
      },
      required: ["signature"],
    },
  },
  /** @stability stable */
  {
    name: "getBug",
    description:
      "Get one distinct bug (by bugId from listDistinctBugs) with its full correlated evidence: front-end and back-end evidence refs, optional db diffs, the representative signal, window, and contributing candidate ids.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        bugId: { type: "string" },
      },
      required: ["sessionId", "bugId"],
    },
  },
  /** @stability stable */
  {
    name: "recallSimilarIssues",
    description:
      "Before diagnosing a bug, ask: have we seen this before? Recalls past issues that RHYME with a session or a free-text description — not just exact duplicates, but same route/different error, same error/different route, or similar environment/feature-flag state — ranked by a hybrid of text similarity and structured overlap. Each match carries how it was resolved when known (disposition, root cause, fix reference), so an agent or support engineer can reuse a prior answer instead of re-solving from scratch. Pass sessionId to recall relative to a captured session, or query for a free-text description.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: {
          type: "string",
          description: "Recall issues similar to this captured session.",
        },
        query: {
          type: "string",
          description:
            "Free-text description of the problem to recall similar issues for (used when no sessionId).",
        },
        limit: {
          type: "number",
          description: "Max matches to return (default 5, max 20).",
        },
      },
    },
  },
  // Signature resolve / locate surface (act-by-identity, phase 1: resolve-only).
  /** @stability stable */
  {
    name: "resolveSignature",
    description:
      "Resolve a stable component signature to its full interactive-element descriptor for one session: path/selector, tag/role, accessible label/text, occurrence count, first-seen, and interaction affordances (clickable/input). Reads the finalized hot-plane bundle only (redaction-safe; raw masked values are never surfaced). Unknown signature returns an error. Use locateInteractiveElements first to find a signature. Resolve-only: does NOT drive a live browser.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        signature: {
          type: "string",
          description:
            "A stable component signature (sig) from the session interactive-element map",
        },
      },
      required: ["sessionId", "signature"],
    },
  },
  /** @stability stable */
  {
    name: "locateInteractiveElements",
    description:
      "Find interactive components in a session BY IDENTITY. Returns a deterministic ranked list of {signature, role, label, path, occurrences} from the finalized hot-plane interactive-element map, optionally filtered by a label/text substring or an exact role/tag. Ranked by occurrences desc, then label, then signature. Reads hot-plane artifacts only (redaction-safe). Resolve-only (no live actuation); use resolveSignature for one element full descriptor.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        text: {
          type: "string",
          description:
            "Case-insensitive substring matched against the element label/text and path",
        },
        role: {
          type: "string",
          description:
            "Exact (case-insensitive) tag/role filter, e.g. button or input",
        },
        tag: { type: "string", description: "Alias for role" },
        limit: {
          type: "number",
          description: "Max elements to return (default and hard cap 100)",
        },
      },
      required: ["sessionId"],
    },
  },
  // Hierarchical lazy retrieval (manifest -> window -> evidence). Times are absolute ms.
  /** @stability stable */
  {
    name: "getSessionManifest",
    description:
      "Get the session manifest (manifest.json): metadata, error and failed request markers, timeline, detector signals, and an accessPattern hint. The token bounded entry point for exploring a recorded session. Start drilldown here, then getWindow for raw events in a time window and getEvidence to resolve one signal, signature, or request id. Hot plane only. Every response carries a character based token estimate.",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  /** @stability stable */
  {
    name: "getWindow",
    description:
      "Get cold events within the absolute millisecond time window [t0,t1], using the same units as manifest.session.startMs/endMs and candidate.evidenceWindow.start/end. This is the only tool that reads the cold event stream. It is limited to the window, capped at 500 events by default and at most, and reports truncation. Use it after locating a candidate window with getSessionManifest or getEvidence.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        t0: { type: "number", description: "Window start (absolute ms)" },
        t1: { type: "number", description: "Window end (absolute ms)" },
        limit: {
          type: "number",
          description: "Max events to return (default and hard cap 500)",
        },
        maxTokens: {
          ...MAX_TOKENS_SCHEMA,
          description:
            "Optional response token budget, estimated as ceil(chars/4) of the serialized JSON. This low cost heuristic can undercount dense content, so budget conservatively. When set, chronological events are dropped from the end of the window after the limit cap to fit. The response gains tokenEstimate and a dropReport whose first ref carries the first omitted event timestamp (t=<ms>) so you can start a new window there. Omit it for the full payload.",
        },
      },
      required: ["sessionId", "t0", "t1"],
    },
  },
  /** @stability stable */
  {
    name: "getEvidence",
    description:
      "Resolve one piece of evidence by ref from hot plane artifacts only. ref is a candidate id, such as cand_0001, an interactive element signature, or a request or event id. Candidate and request ids resolve to the candidate whose anchor references them. Returns a small payload. Use getWindow for raw chronological events. Every response carries tokenEstimate using a ceil(chars/4) heuristic.",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        ref: {
          type: "string",
          description:
            "A candidate id, an interactive element signature, or a request or event id",
        },
      },
      required: ["sessionId", "ref"],
    },
  },
  /** @stability stable */
  {
    name: "getStorageSnapshot",
    description: "Get the initial storage snapshot from a session",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  /** @stability stable */
  {
    name: "getCookieChanges",
    description: "Get all cookie change events from a session",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  /** @stability stable */
  {
    name: "getStorageChanges",
    description: "Get all storage change events from a session",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  /** @stability stable */
  {
    name: "getTranscript",
    description: "Get audio transcript events from a session",
    inputSchema: {
      type: "object" as const,
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"],
    },
  },
  /** @stability stable */
  {
    name: "getFrame",
    description: "Get a frame image by timestamp (nearest match)",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        timestamp: { type: "number" },
      },
      required: ["sessionId", "timestamp"],
    },
  },
  /** @stability stable */
  {
    name: "getFrameById",
    description: "Get a frame image by filename",
    inputSchema: {
      type: "object" as const,
      properties: {
        sessionId: { type: "string" },
        filename: { type: "string" },
      },
      required: ["sessionId", "filename"],
    },
  },
  // Bug queue tools
  /** @stability stable */
  {
    name: "listBugs",
    description:
      "List all bug reports in the queue. Returns report summaries sorted newest-first. Use this as the entry point to triage bugs.",
    inputSchema: {
      type: "object" as const,
      properties: {
        status: {
          type: "string",
          description: "Filter by status: open or resolved",
        },
        after: {
          type: "number",
          description: "Filter bugs flagged after this timestamp",
        },
        before: {
          type: "number",
          description: "Filter bugs flagged before this timestamp",
        },
      },
    },
  },
  /** @stability stable */
  {
    name: "getBugReport",
    description:
      "Get the full bug report including developer note, URL, summary stats (error count, failed requests, event breakdown). Read this first before diving into events.",
    inputSchema: {
      type: "object" as const,
      properties: {
        bugId: { type: "string" },
      },
      required: ["bugId"],
    },
  },
  /** @stability stable */
  {
    name: "getBugEvents",
    description:
      "Get events from a bug report, optionally filtered by kind (clk, con, err, net.req, net.res, key, etc.) or time range. Use limit to control token usage.",
    inputSchema: {
      type: "object" as const,
      properties: {
        bugId: { type: "string" },
        kind: {
          type: "string",
          description: "Filter by event kind (e.g. err, net.res, con, clk)",
        },
        after: { type: "number" },
        before: { type: "number" },
        limit: {
          type: "number",
          description: "Max events to return (default 100)",
        },
        compact: {
          type: "boolean",
          description: "Return events as [t,k,d] tuples to reduce tokens",
        },
      },
      required: ["bugId"],
    },
  },
  /** @stability stable */
  {
    name: "getBugErrorContext",
    description:
      "Get all errors/rejections from a bug with surrounding events for context. Best for understanding what happened around each error.",
    inputSchema: {
      type: "object" as const,
      properties: {
        bugId: { type: "string" },
        windowMs: {
          type: "number",
          description: "Time window around each error in ms (default 2000)",
        },
      },
      required: ["bugId"],
    },
  },
  /** @stability stable */
  {
    name: "getBugFailedRequests",
    description: "Get failed HTTP requests (status >= 400) from a bug report.",
    inputSchema: {
      type: "object" as const,
      properties: { bugId: { type: "string" } },
      required: ["bugId"],
    },
  },
  /** @stability stable */
  {
    name: "getBugVoiceTranscript",
    description:
      "Get the transcribed voice note from a bug report, if the developer recorded one.",
    inputSchema: {
      type: "object" as const,
      properties: { bugId: { type: "string" } },
      required: ["bugId"],
    },
  },
  /** @stability stable */
  {
    name: "getBugLLMContext",
    description:
      "Get a compact bug context optimized for LLM consumption (small key schema + top errors/requests/navs).",
    inputSchema: {
      type: "object" as const,
      properties: { bugId: { type: "string" } },
      required: ["bugId"],
    },
  },
  /** @stability stable */
  {
    name: "resolveBug",
    description: "Mark a bug as resolved.",
    inputSchema: {
      type: "object" as const,
      properties: { bugId: { type: "string" } },
      required: ["bugId"],
    },
  },
];

// Canonical tool names are camelCase. Every tool also accepts a snake_case
// alias, generated mechanically here so no tool can drift out of the scheme
// (contract decision #1, wargames/wargames/03-contract-decisions.md).
function snakeCaseToolName(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

const TOOL_NAME_ALIASES = new Map<string, string>(
  TOOLS.flatMap((tool) => {
    const snake = snakeCaseToolName(tool.name);
    return snake === tool.name ? [] : [[snake, tool.name] as [string, string]];
  }),
);

function textResult(data: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function imageResult(base64Data: string, mimeType = "image/jpeg") {
  return { content: [{ type: "image", data: base64Data, mimeType }] };
}

function errorResult(message: string) {
  return { content: [{ type: "text", text: message }], isError: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
  }
  return value;
}

export class McpServer {
  private outputDir: string;
  private store: McpReadStore;
  private bugQueue: BugQueueManager;
  private gitHostClientFactory?: McpServerConfig["gitHostClientFactory"];
  private ticketConnectorFactory?: McpServerConfig["ticketConnectorFactory"];
  private reproducerFactory?: McpServerConfig["reproducerFactory"];
  private evidenceSourcesFactory?: McpServerConfig["evidenceSourcesFactory"];

  constructor(config: McpServerConfig) {
    this.outputDir = config.outputDir;
    this.store = config.readStore ?? selectMcpReadStore(this.outputDir);
    fs.mkdirSync(this.outputDir, { recursive: true });
    const bugsDir = path.join(path.dirname(this.outputDir), "bugs");
    this.bugQueue = new BugQueueManager({ bugsDir });
    this.gitHostClientFactory = config.gitHostClientFactory;
    this.ticketConnectorFactory = config.ticketConnectorFactory;
    this.reproducerFactory = config.reproducerFactory;
    this.evidenceSourcesFactory = config.evidenceSourcesFactory;
  }

  /** Evidence sources for solveContext's adapter phase — injected in tests,
   *  built from env in production. */
  private evidenceSources(): EvidenceSource[] {
    return this.evidenceSourcesFactory
      ? this.evidenceSourcesFactory()
      : evidenceSourcesFromEnv();
  }

  start(): void {
    const rl = readline.createInterface({ input: process.stdin });
    rl.on("line", async (line) => {
      try {
        const msg = JSON.parse(line) as JsonRpcRequest;
        const response = await this.handleMessage(msg);
        if (response) {
          process.stdout.write(JSON.stringify(response) + "\n");
        }
      } catch {
        // Ignore malformed messages
      }
    });
  }

  async handleMessage(msg: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    switch (msg.method) {
      case "initialize":
        return {
          jsonrpc: "2.0",
          id: msg.id!,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: "crumbtrail-mcp", version: "0.1.0" },
          },
        };

      case "initialized":
      case "notifications/initialized":
        return null;

      case "tools/list":
        return {
          jsonrpc: "2.0",
          id: msg.id!,
          result: { tools: TOOLS },
        };

      case "tools/call": {
        const params = msg.params as {
          name: string;
          arguments?: Record<string, unknown>;
        };
        // Surface handler throws (e.g. a malformed cold stream or an unsupported
        // Node version on the zstd path) as an MCP isError result, rather than
        // letting them propagate and leave the client waiting with no response.
        try {
          const result = await this.callTool(
            params.name,
            params.arguments || {},
          );
          return { jsonrpc: "2.0", id: msg.id!, result };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            jsonrpc: "2.0",
            id: msg.id!,
            result: errorResult(`Tool ${params.name} failed: ${message}`),
          };
        }
      }

      default:
        return {
          jsonrpc: "2.0",
          id: msg.id!,
          error: { code: -32601, message: "Method not found" },
        };
    }
  }

  private async callTool(
    rawName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const name = TOOL_NAME_ALIASES.get(rawName) ?? rawName;
    switch (name) {
      case "listSessions":
        return this.toolListSessions(args);
      case "getIndex":
        return this.toolGetIndex(args);
      case "getEvents":
        return this.toolGetEvents(args);
      case "getErrorContext":
        return this.toolGetErrorContext(args);
      case "getFailedRequests":
        return this.toolGetFailedRequests(args);
      case "getLinkedRequestContext":
        return this.toolGetLinkedRequestContext(args);
      case "getFixContext":
        return this.toolGetFixContext(args);
      case "getOpinion":
        return this.toolGetOpinion(args);
      case "getLatestIssue":
        return this.toolGetLatestIssue(args);
      case "getRegressionContext":
        return this.toolGetRegressionContext(args);
      case "solveContext":
        return this.toolSolveContext(args);
      case "listDistinctBugs":
        return this.toolListDistinctBugs(args);
      case "getRecurrence":
        return this.toolGetRecurrence(args);
      case "getBug":
        return this.toolGetBug(args);
      case "recallSimilarIssues":
        return this.toolRecallSimilarIssues(args);
      case "resolveSignature":
        return this.toolResolveSignature(args);
      case "locateInteractiveElements":
        return this.toolLocateInteractiveElements(args);
      case "getSessionManifest":
        return this.toolGetSessionManifest(args);
      case "getWindow":
        return this.toolGetWindow(args);
      case "getEvidence":
        return this.toolGetEvidence(args);
      case "getStorageSnapshot":
        return this.toolGetStorageSnapshot(args);
      case "getCookieChanges":
        return this.toolGetCookieChanges(args);
      case "getStorageChanges":
        return this.toolGetStorageChanges(args);
      case "getTranscript":
        return this.toolGetTranscript(args);
      case "getFrame":
        return this.toolGetFrame(args);
      case "getFrameById":
        return this.toolGetFrameById(args);
      case "listBugs":
        return this.toolListBugs(args);
      case "getBugReport":
        return this.toolGetBugReport(args);
      case "getBugEvents":
        return this.toolGetBugEvents(args);
      case "getBugErrorContext":
        return this.toolGetBugErrorContext(args);
      case "getBugFailedRequests":
        return this.toolGetBugFailedRequests(args);
      case "getBugVoiceTranscript":
        return this.toolGetBugVoiceTranscript(args);
      case "getBugLLMContext":
        return this.toolGetBugLlmContext(args);
      case "resolveBug":
        return this.toolResolveBug(args);
      default:
        return errorResult(`Unknown tool: ${name}`);
    }
  }

  // Session resolution now flows through the storage seam. We keep the
  // isSafeSessionId gate (and the sentinel path for invalid ids) so a caller
  // can never smuggle traversal/escaping ids past the store; the store then
  // applies the same flat->partition-tree fallback with realpath/symlink
  // containment that the previously-inlined eachSessionDir/findSessionDir did.
  private sessionDir(sessionId: string): string {
    if (!this.isSafeSessionId(sessionId))
      return path.join(this.outputDir, "__invalid_session_id__");
    return defaultSessionStore.resolveSessionDir(sessionId, this.outputDir);
  }

  private async sessionDirAsync(sessionId: string): Promise<string> {
    if (!this.isSafeSessionId(sessionId))
      return path.join(this.outputDir, "__invalid_session_id__");
    return this.store.resolveSessionDir(sessionId);
  }

  private isSafeSessionId(sessionId: unknown): sessionId is string {
    return typeof sessionId === "string" && /^[A-Za-z0-9._-]+$/.test(sessionId);
  }

  private readEvents(sessionDir: string): BugEvent[] {
    const buf = defaultSessionStore.readArtifact(sessionDir, "events.ndjson");
    if (!buf) return [];
    const content = buf.toString("utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  private async readEventsAsync(sessionDir: string): Promise<BugEvent[]> {
    const buf = await this.store.readArtifact(sessionDir, "events.ndjson");
    if (!buf) return [];
    const content = buf.toString("utf-8").trim();
    if (!content) return [];
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  /**
   * Resolve a tool's args to a target directory. A bug is a named window into
   * a session: if `bugId` is present, gate on its existence and resolve to the
   * bug's dir; otherwise resolve to the session's dir. Session targets are not
   * pre-checked here (existence is discovered downstream by the specific tool,
   * matching pre-seam behavior), so this only errors for a missing bug.
   */
  private resolveTarget(
    args: Record<string, unknown>,
  ): { dir: string } | { error: string } {
    if (args.bugId !== undefined) {
      const bugId = args.bugId as string;
      const report = this.safeGetBug(bugId);
      if (!report) return { error: "Bug not found" };
      return { dir: this.bugQueue.getBugDir(bugId) };
    }
    return { dir: this.sessionDir(args.sessionId as string) };
  }

  /** Shared kind/after/before filtering; per-tool limit/compact stay caller-side. */
  private filterEvents(
    events: BugEvent[],
    args: Record<string, unknown>,
  ): BugEvent[] {
    if (args.kind) events = events.filter((e) => e.k === args.kind);
    if (typeof args.after === "number")
      events = events.filter((e) => e.t >= (args.after as number));
    if (typeof args.before === "number")
      events = events.filter((e) => e.t <= (args.before as number));
    return events;
  }

  /** Shared error-context body for both session and bug tools. */
  private errorContextFor(dir: string, windowMs: number) {
    const events = this.readEvents(dir);
    const errors = events.filter((e) => e.k === "err" || e.k === "rej");
    const results = errors.map((err) => {
      const context = events.filter(
        (e) => e.t >= err.t - windowMs && e.t <= err.t + windowMs,
      );
      return { error: err, context };
    });
    return textResult(results);
  }

  /** Shared failed-requests body; notFoundMsg differs per caller. */
  private failedRequestsFor(dir: string, notFoundMsg: string) {
    const buf = defaultSessionStore.readArtifact(dir, "index.json");
    if (!buf) return errorResult(notFoundMsg);
    const data = JSON.parse(buf.toString("utf-8"));
    return textResult(data.failedReqs || []);
  }

  private async toolListSessions(args: Record<string, unknown>) {
    const sessions: Record<string, unknown>[] = [];
    for (const { dir } of await this.store.listSessions()) {
      const meta = await this.readJsonRecordAsync(dir, "meta.json");
      if (!meta) continue;
      try {
        if (args.app && meta.app !== args.app) continue;
        const start = numberField(meta.start);
        if (
          typeof args.after === "number" &&
          start !== undefined &&
          start < args.after
        )
          continue;
        if (
          typeof args.before === "number" &&
          start !== undefined &&
          start > args.before
        )
          continue;
        if (
          typeof args.release === "string" &&
          !this.sessionMetadataMatches(meta, args.release, [
            "release",
            "releaseId",
            "version",
          ])
        )
          continue;
        if (
          typeof args.build === "string" &&
          !this.sessionMetadataMatches(meta, args.build, [
            "build",
            "buildId",
            "commit",
            "sha",
          ])
        )
          continue;
        sessions.push(this.withReleaseBuild(meta));
      } catch {
        // skip malformed sessions
      }
    }
    return textResult(sessions);
  }

  /**
   * Surfaces release/build as first-class list-row fields regardless of which
   * alias the app used (release/releaseId/version, build/buildId/commit/sha), so
   * an agent can label and group sessions by release without re-reading each
   * meta. Additive: the raw meta keys are preserved.
   */
  private withReleaseBuild(
    meta: Record<string, unknown>,
  ): Record<string, unknown> {
    const release = stringField(meta.release ?? meta.releaseId ?? meta.version);
    const build = stringField(
      meta.build ?? meta.buildId ?? meta.commit ?? meta.sha,
    );
    return {
      ...meta,
      ...(release !== undefined ? { release } : {}),
      ...(build !== undefined ? { build } : {}),
    };
  }

  private sessionMetadataMatches(
    meta: Record<string, unknown>,
    expected: string,
    keys: string[],
  ): boolean {
    return keys.some((key) => meta[key] === expected);
  }

  private async toolGetIndex(args: Record<string, unknown>) {
    const dir = await this.sessionDirAsync(args.sessionId as string);
    const index = await this.readJsonRecordAsync(dir, "index.json");
    if (!index) return errorResult("Session not found");
    return textResult(index);
  }

  private async toolGetEvents(args: Record<string, unknown>) {
    let events: BugEvent[];
    if (args.bugId !== undefined) {
      const target = this.resolveTarget(args);
      if ("error" in target) return errorResult(target.error);
      events = this.readEvents(target.dir);
    } else {
      events = await this.readEventsAsync(
        await this.sessionDirAsync(args.sessionId as string),
      );
    }
    events = this.filterEvents(events, args);
    const limit = typeof args.limit === "number" ? args.limit : 100;
    events = events.slice(0, limit);
    return textResult(events);
  }

  private toolGetErrorContext(args: Record<string, unknown>) {
    const target = this.resolveTarget(args);
    if ("error" in target) return errorResult(target.error);
    const windowMs = typeof args.windowMs === "number" ? args.windowMs : 2000;
    return this.errorContextFor(target.dir, windowMs);
  }

  private toolGetFailedRequests(args: Record<string, unknown>) {
    const target = this.resolveTarget(args);
    if ("error" in target) return errorResult(target.error);
    return this.failedRequestsFor(target.dir, "Session not found");
  }

  private toolGetLinkedRequestContext(args: Record<string, unknown>) {
    const sessionId = args.sessionId as string;
    const requestId = args.requestId as string;
    const dir = this.sessionDir(sessionId);
    const indexBuf = defaultSessionStore.readArtifact(dir, "index.json");
    if (!indexBuf) return errorResult("Session not found");

    const index = JSON.parse(indexBuf.toString("utf-8")) as Record<
      string,
      unknown
    >;
    const fullStackRequests = isRecord(index.fullStackRequests)
      ? index.fullStackRequests
      : undefined;

    if (!fullStackRequests) {
      return textResult({
        sessionId,
        requestId,
        status: "unavailable",
        gaps: [],
        diagnostics: [
          "No full-stack request evidence was generated for this session. Run post-processing with request correlation enabled before using this MCP lookup.",
        ],
      });
    }

    const summary = isRecord(fullStackRequests.summary)
      ? fullStackRequests.summary
      : undefined;
    const linkedRequests = Array.isArray(fullStackRequests.linked)
      ? fullStackRequests.linked.filter(isRecord)
      : [];
    const gapEntries = Array.isArray(fullStackRequests.gaps)
      ? fullStackRequests.gaps.filter(isRecord)
      : [];

    if (
      !Array.isArray(fullStackRequests.linked) ||
      !Array.isArray(fullStackRequests.gaps)
    ) {
      return textResult({
        sessionId,
        requestId,
        status: "unavailable",
        summary,
        gaps: [],
        diagnostics: [
          "Full-stack request evidence is unavailable because index.fullStackRequests is missing linked or gaps arrays.",
        ],
      });
    }

    const linked = linkedRequests.find(
      (entry) => entry.sessionId === sessionId && entry.requestId === requestId,
    );
    const matchingGaps = gapEntries
      .filter((gap) => this.matchesFullStackGap(gap, sessionId, requestId))
      .map((gap) => this.compactFullStackGap(gap));

    if (!linked && matchingGaps.length === 0) {
      return textResult({
        sessionId,
        requestId,
        status: "not-found",
        summary,
        gaps: [],
        diagnostics: [
          `No linked full-stack request or gap entry matched requestId ${requestId} in session ${sessionId}. Check that the frontend and backend emitted matching correlation IDs.`,
        ],
      });
    }

    const compactLinked = linked
      ? this.compactLinkedFullStackRequest(linked)
      : undefined;
    const correlationStatus = this.fullStackCorrelationStatus(compactLinked);
    const diagnostics = linked
      ? this.linkedRequestDiagnostics(summary, matchingGaps.length)
      : [
          `Partial full-stack request evidence found for requestId ${requestId}; frontend/backend linkage is missing or incomplete.`,
        ];

    return textResult(
      removeUndefined({
        sessionId,
        requestId,
        status: linked ? "linked" : "partial",
        summary,
        correlationStatus,
        linked: compactLinked,
        gaps: matchingGaps,
        diagnostics,
      }),
    );
  }

  private matchesFullStackGap(
    gap: Record<string, unknown>,
    sessionId: string,
    requestId: string,
  ): boolean {
    const gapRequestId =
      typeof gap.requestId === "string" ? gap.requestId : undefined;
    const gapSessionId =
      typeof gap.sessionId === "string" ? gap.sessionId : undefined;
    const requestMatches = gapRequestId === requestId;
    const sessionMatches = !gapSessionId || gapSessionId === sessionId;
    if (requestMatches && sessionMatches) return true;
    return !gapRequestId && gapSessionId === sessionId;
  }

  private linkedRequestDiagnostics(
    summary: Record<string, unknown> | undefined,
    matchingGapCount: number,
  ): string[] {
    const diagnostics = [
      "Linked full-stack request evidence found in index.fullStackRequests.",
    ];
    const sessionGapCount =
      typeof summary?.gaps === "number" ? summary.gaps : 0;
    if (matchingGapCount > 0) {
      diagnostics.push(
        `This request also has ${matchingGapCount} matching gap diagnostic(s).`,
      );
    }
    if (sessionGapCount > 0) {
      diagnostics.push(
        `Session-level full-stack request summary reports ${sessionGapCount} gap(s); other requests in this session may have partial evidence.`,
      );
    }
    return diagnostics;
  }

  private fullStackCorrelationStatus(
    linked: Record<string, unknown> | undefined,
  ): string | undefined {
    const backend = isRecord(linked?.backend) ? linked.backend : undefined;
    const correlation = isRecord(backend?.correlation)
      ? backend.correlation
      : undefined;
    return typeof correlation?.status === "string"
      ? correlation.status
      : undefined;
  }

  private compactLinkedFullStackRequest(
    entry: Record<string, unknown>,
  ): Record<string, unknown> {
    return removeUndefined({
      requestId: stringField(entry.requestId),
      sessionId: stringField(entry.sessionId),
      frontend: this.compactFrontendEvidence(entry.frontend),
      backend: this.compactBackendEvidence(entry.backend),
    });
  }

  private compactFullStackGap(
    gap: Record<string, unknown>,
  ): Record<string, unknown> {
    return removeUndefined({
      type: stringField(gap.type),
      requestId: stringField(gap.requestId),
      sessionId: stringField(gap.sessionId),
      frontend: this.compactFrontendEvidence(gap.frontend),
      backend: this.compactBackendEvidence(gap.backend),
    });
  }

  private compactFrontendEvidence(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    return removeUndefined({
      ref: this.compactEventRef(value.ref),
      requestId: stringField(value.requestId),
      sessionId: stringField(value.sessionId),
      method: stringField(value.method),
      url: stringField(value.url),
      status: numberField(value.status),
      durationMs: numberField(value.durationMs),
      error: this.compactFrontendError(value.error),
    });
  }

  private compactBackendEvidence(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    return removeUndefined({
      requestId: stringField(value.requestId),
      sessionId: stringField(value.sessionId),
      correlation: this.compactCorrelation(value.correlation),
      start: this.compactEventRef(value.start),
      end: this.compactEventRef(value.end),
      errorRef: this.compactEventRef(value.errorRef),
      method: stringField(value.method),
      url: stringField(value.url),
      pathname: stringField(value.pathname),
      route: stringField(value.route),
      statusCode: numberField(value.statusCode),
      durationMs: numberField(value.durationMs),
      error: this.compactBackendError(value.error),
    });
  }

  private compactEventRef(value: unknown): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    return removeUndefined({
      t: numberField(value.t),
      offsetMs: numberField(value.offsetMs),
      k: stringField(value.k),
      kind: stringField(value.kind),
      iso: stringField(value.iso),
    });
  }

  private compactCorrelation(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    return removeUndefined({
      status: stringField(value.status),
      sessionIdSource: stringField(value.sessionIdSource),
      requestIdSource: stringField(value.requestIdSource),
    });
  }

  private compactFrontendError(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    return removeUndefined({
      message: stringField(value.message),
      transport: stringField(value.transport),
    });
  }

  private compactBackendError(
    value: unknown,
  ): Record<string, unknown> | undefined {
    if (!isRecord(value)) return undefined;
    return removeUndefined({
      name: stringField(value.name),
      code: stringField(value.code),
      message: stringField(value.message),
      statusCode: numberField(value.statusCode),
    });
  }

  // --- Token budgeting (CP4) -------------------------------------------------
  //
  // The unbudgeted paths below are gated on `args.maxTokens === undefined` and
  // are byte-identical to the pre-budgeting responses — budgeting is strictly
  // additive and opt-in for getFixContext / getLatestIssue / solveContext /
  // getWindow. Estimates are always over the exact textResult serialization
  // (JSON.stringify(data, null, 2)).

  /** Parses the optional `maxTokens` arg. `{}` when absent; error when invalid. */
  private maxTokensOf(
    args: Record<string, unknown>,
  ): { maxTokens?: number } | { error: string } {
    if (args.maxTokens === undefined) return {};
    const value = args.maxTokens;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return { error: "maxTokens must be an integer >= 1" };
    }
    return { maxTokens: value };
  }

  /**
   * Shared budgeted-response path: fills `payload[itemsKey]` from `items` in
   * their given rank order via the one shared fillToBudget helper, then
   * attaches `tokenEstimate` (of the final serialized payload) and, when
   * anything was dropped, a structured `dropReport`. `onKept` lets a caller
   * patch dependent fields (e.g. getWindow's returned/truncated) after the
   * fill. Deterministic; logs drops to stderr only (stdout carries only
   * JSON-RPC frames).
   */
  private budgetedTextResult<T>(
    payload: Record<string, unknown>,
    itemsKey: string,
    items: T[],
    maxTokens: number,
    refOf: (item: T) => string,
    onKept?: (kept: T[], out: Record<string, unknown>) => void,
  ) {
    const baseTokens = estimateTokens(
      JSON.stringify({ ...payload, [itemsKey]: [] }, null, 2),
    );
    const { kept, report } = fillToBudget(items, {
      maxTokens,
      baseTokens,
      refOf,
      serialize: (item) => JSON.stringify(item, null, 2),
    });
    const out: Record<string, unknown> = { ...payload, [itemsKey]: kept };
    onKept?.(kept, out);
    if (report) {
      out.dropReport = report;
      process.stderr.write(
        `mcp: ${itemsKey} budgeted to maxTokens=${maxTokens}: ${report.message}\n`,
      );
    }
    return textResult(attachTokenEstimate(out));
  }

  /**
   * Shared response path for getFixContext and getLatestIssue. Unbudgeted
   * stays byte-identical to the raw contract; budgeted fills `signals` in
   * detector rank order (refs are signal ids resolvable via getEvidence).
   */
  private fixContextResult(context: FixContext, maxTokens: number | undefined) {
    if (maxTokens === undefined) return textResult(context);
    return this.budgetedTextResult(
      context as unknown as Record<string, unknown>,
      "signals",
      context.signals,
      maxTokens,
      (candidate) => candidate.id,
    );
  }

  private async toolGetFixContext(args: Record<string, unknown>) {
    const budget = this.maxTokensOf(args);
    if ("error" in budget) return errorResult(budget.error);
    const sessionId = args.sessionId as string;
    const dir = await this.sessionDirAsync(sessionId);
    try {
      if (!(await this.store.statArtifact(dir, "index.json"))) {
        throw new FixContextError(
          "session-not-found",
          `No finalized session found at ${dir} (missing index.json). Run post-processing first.`,
        );
      }
      const index = (await this.readJsonRecordAsync(dir, "index.json")) ?? {};
      const bundle =
        (await this.readJsonRecordAsync(dir, "llm.json")) ??
        (await this.readJsonRecordAsync(dir, "bundle.json"));
      const context = buildFixContextFromArtifacts(
        dir,
        index,
        bundle as LlmBundle | undefined,
        (await this.readCandidatesJsonlAsync(
          dir,
        )) as unknown as EvidenceCandidate[],
      );
      return this.fixContextResult(context, budget.maxTokens);
    } catch (err) {
      if (err instanceof FixContextError) return errorResult(err.message);
      throw err;
    }
  }

  private async toolGetOpinion(args: Record<string, unknown>) {
    const sessionId = stringField(args.sessionId);
    if (!sessionId) return errorResult("getOpinion requires sessionId");
    const dir = await this.sessionDirAsync(sessionId);
    const opinion = await this.readJsonRecordAsync(dir, "opinion.json");
    if (opinion) return textResult(opinion);

    const legacy = await this.readJsonRecordAsync(dir, "diagnosis.json");
    if (legacy) return textResult(normalizeAiOpinion(legacy));
    if (!(await this.sessionExistsAsync(dir)))
      return errorResult("Session not found");
    return errorResult("No opinion generated yet for this session.");
  }

  /**
   * One-call entry point: resolve the latest finalized session with
   * error-class evidence via the SAME resolveLatestIssue shared with the
   * `fix-context --latest` CLI flag, then reuse the getFixContext response
   * path (including optional maxTokens budgeting — its only input).
   */
  private toolGetLatestIssue(args: Record<string, unknown>) {
    const budget = this.maxTokensOf(args);
    if ("error" in budget) return errorResult(budget.error);
    const latest = resolveLatestIssue({ outputDir: this.outputDir });
    if (!latest) {
      return errorResult(
        `No finalized session with error-class evidence found under ${this.outputDir}; run a session and wait for finalize, or use listSessions.`,
      );
    }
    try {
      const context = buildFixContext(latest.dir, {
        outputDir: this.outputDir,
      });
      return this.fixContextResult(context, budget.maxTokens);
    } catch (err) {
      if (err instanceof FixContextError) return errorResult(err.message);
      throw err;
    }
  }

  private async toolGetRegressionContext(args: Record<string, unknown>) {
    const sessionA = stringField(args.sessionA);
    const sessionB = stringField(args.sessionB);
    if (!sessionA || !sessionB)
      return errorResult("getRegressionContext requires sessionA and sessionB");
    const aDir = this.sessionDir(sessionA);
    const bDir = this.sessionDir(sessionB);
    if (!this.sessionExists(aDir) || !this.sessionExists(bDir))
      return errorResult("Session not found");
    const comparison = await compareSessions(aDir, bDir);
    return textResult(buildRegressionContext(comparison, bDir));
  }

  private async toolSolveContext(args: Record<string, unknown>) {
    const budget = this.maxTokensOf(args);
    if ("error" in budget) return errorResult(budget.error);
    const passedSymptom: Partial<Symptom> | undefined = isRecord(args.symptom)
      ? (args.symptom as unknown as Partial<Symptom>)
      : undefined;

    // The ticket arg is either a pasted URL string (recognized locally, zero
    // network) or the explicit { provider, ticketKey } object (`id` accepted as
    // a deprecated alias — contract decision #2). An unrecognized URL is an
    // honest miss (surfaced as a gap below), never a throw.
    let ticketArg: { provider?: string; id?: string } | undefined;
    let ticketUrlUnrecognized = false;
    if (typeof args.ticket === "string") {
      const resolved = parseTicketUrl(args.ticket);
      if (resolved) ticketArg = resolved;
      else ticketUrlUnrecognized = true;
    } else if (isRecord(args.ticket)) {
      ticketArg = {
        provider: stringField(args.ticket.provider),
        id: stringField(args.ticket.ticketKey) ?? stringField(args.ticket.id),
      };
    }

    let symptom: Symptom | undefined = passedSymptom?.title
      ? (passedSymptom as Symptom)
      : undefined;
    const ticketGaps: {
      lane: "network";
      reason: string;
      suggestion?: string;
    }[] = [];

    // Cloud pull-path — BEFORE any local ticket-fetch/evidence/reproduction/
    // git-host logic. When the ticket resolves to a provider+id AND the cloud env
    // pair is configured, ask the cloud by-ticket endpoint for a pre-assembled
    // bundle. On a hit, return that stored bundle verbatim and short-circuit the
    // entire local pipeline. On any miss/failure/unconfigured env the helper
    // returns undefined and we fall through UNCHANGED to the local fetch +
    // auto-locate path — a deliberate always-fall-back design (mirrors
    // recallViaCloud): the pull is a fast path, never a hard dependency.
    if (ticketArg?.provider && ticketArg.id) {
      const pulled = await pullBundleByTicketViaCloud(
        ticketArg.provider,
        ticketArg.id,
      );
      if (pulled && isRecord(pulled.bundle)) {
        // Unbudgeted: return the stored bundle verbatim, byte-identical to
        // before. With maxTokens set, the pulled bundle honors the same
        // budgeting contract as a locally assembled one (evidence is the
        // relevance-ranked array in a stored fusion.v1 RankedBundle).
        if (budget.maxTokens === undefined) return textResult(pulled.bundle);
        if (!Array.isArray(pulled.bundle.evidence)) {
          return textResult(attachTokenEstimate(pulled.bundle));
        }
        return this.budgetedTextResult(
          pulled.bundle,
          "evidence",
          pulled.bundle.evidence,
          budget.maxTokens,
          (item) =>
            isRecord(item) && typeof item.id === "string" ? item.id : "unknown",
        );
      }
    }

    if (ticketArg?.provider && ticketArg.id) {
      try {
        const provider = ticketArg.provider as "jira" | "zendesk" | "trello";
        const connector: TicketConnector = this.ticketConnectorFactory
          ? this.ticketConnectorFactory(provider)
          : ticketClientFromEnv(provider);
        const fetched = await connector.fetchSymptom(ticketArg.id);
        // Passed symptom values win; fetched ticket fields fill gaps.
        symptom = { ...fetched, ...(passedSymptom ?? {}) } as Symptom;
      } catch (err) {
        const message =
          err instanceof TicketError
            ? `TicketError (status ${err.status}): ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        process.stderr.write(
          `solveContext: ticket fetch failed, falling back: ${message}\n`,
        );
        if (passedSymptom?.title) {
          symptom = passedSymptom as Symptom;
        } else {
          symptom = { title: ticketArg.id };
          ticketGaps.push({
            lane: "network",
            reason: `ticket fetch failed: ${message}`,
            suggestion: "check connector credentials",
          });
        }
      }
    } else if (ticketUrlUnrecognized && !symptom) {
      // A pasted ticket URL we could not recognize, with no symptom to fall back
      // on. Same honest-miss shape as a fetch failure: a minimal symptom (so the
      // pipeline proceeds) plus one gap explaining the miss — never a throw.
      symptom = { title: args.ticket as string };
      ticketGaps.push({
        lane: "network",
        reason: "ticket url not recognized",
        suggestion:
          "pass symptom.title or a supported jira/zendesk/trello ticket url",
      });
    }

    let noInputGiven = false;
    if (!symptom) {
      symptom = { title: "" };
      noInputGiven = true;
      ticketGaps.push({
        lane: "network",
        reason: "a symptom or ticket is required",
        suggestion: "pass symptom.title or ticket:{provider,id}",
      });
    }

    const baselineSession = stringField(args.baselineSession);
    const currentSession = stringField(args.currentSession);

    let evidence: EvidenceItem[] = [];
    let intent: IntentSignal[] = [];
    // The locate decision, when the auto-locate path runs — threaded onto the
    // bundle (RankedBundle.located) and folded into contextCompleteness. Stays
    // undefined for explicit baseline/current comparison bundles.
    let locatedDecision: Located | undefined;
    // Gaps declared by the adapter phase (unsupported keys, timeouts, byte caps).
    const adapterGaps: EvidenceGap[] = [];
    // True when a no-session locate produced a bundle populated PURELY from
    // adapter evidence (sessionless Mode A) — that bundle must still state that
    // no Crumbtrail session matched.
    let sessionlessAdapterBundle = false;

    if (baselineSession && currentSession) {
      const aDir = this.sessionDir(baselineSession);
      const bDir = this.sessionDir(currentSession);
      if (this.sessionExists(aDir) && this.sessionExists(bDir)) {
        const comparison = await compareSessions(aDir, bDir);
        evidence = comparison.evidence;
        intent = comparison.intent;
      }
    }

    // Auto-locate: when the caller gave a ticket/symptom but NO explicit
    // baseline/current sessions, rank the recorded sessions against the symptom
    // and, on a confident match, populate evidence from the located session.
    // Placed BEFORE reproduction so "skip reproduction once evidence.length > 0"
    // naturally covers located evidence too. Never throws out of the tool; on an
    // inconclusive locate (or any failure) evidence stays [] and the existing
    // gaps-only path fires unchanged.
    if (!baselineSession && !currentSession && !noInputGiven) {
      try {
        // Shared locate → evidence slice (also used by the inner
        // /api/solve-context endpoint). On an inconclusive locate this returns
        // evidence: [] and the existing gaps-only path fires unchanged.
        const located = locateEvidence(symptom, this.recallStore());
        evidence = located.evidence;
        // Expose the locate decision on the bundle (previously dropped here).
        // method "fuzzy": this is the scored locate engine; War-game 02's
        // deterministic token join sets "token" through the same field.
        locatedDecision = {
          outcome: located.match.outcome,
          confidence: located.match.confidence,
          method: "fuzzy",
          ...(located.match.sessionId
            ? { sessionId: located.match.sessionId }
            : {}),
          reasons: located.match.reasons,
        };
        // Adapter phase: query the client's configured evidence sources for the
        // located window (matched) or a sessionless fallback window (Mode A) and
        // merge the neutral items ALONGSIDE session evidence — the single fusion
        // path ranks the mixed set. Never throws; ZERO sources → no-op, so this
        // block is byte-identical to before for a session-matched (or no-source)
        // request.
        const adapter = await gatherAdapterEvidence(symptom, located, {
          sources: this.evidenceSources(),
        });
        evidence = [...evidence, ...adapter.items];
        adapterGaps.push(...adapter.gaps);
        // A no-session locate whose bundle is populated purely from adapters must
        // still state that no Crumbtrail session matched (Mode A invariant).
        if (located.match.outcome !== "matched" && adapter.items.length > 0) {
          sessionlessAdapterBundle = true;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `solveContext: incident location failed, falling back: ${message}\n`,
        );
      }
    }

    // On-demand reproduction: opt-in (allowReproduction), only when a
    // reproducer is configured, and only when historical evidence is thin
    // (nothing to needlessly re-drive an app for). Never throws out of the
    // tool; a reproducer failure just falls back to the existing gap.
    let reproductionNote: string | undefined;
    if (
      args.allowReproduction === true &&
      this.reproducerFactory &&
      evidence.length === 0
    ) {
      try {
        const reproducer: Reproducer = this.reproducerFactory();
        const result = await reproducer.reproduce(symptom);
        if (result.attempted && result.evidence.length > 0) {
          evidence = [...evidence, ...result.evidence];
          intent = [...intent, ...result.intent];
        } else {
          reproductionNote = result.note;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `solveContext: reproduction failed, falling back to existing evidence: ${message}\n`,
        );
      }
    }

    const gitHost = isRecord(args.gitHost)
      ? {
          owner: stringField(args.gitHost.owner),
          repo: stringField(args.gitHost.repo),
          baseRef: stringField(args.gitHost.baseRef),
          headRef: stringField(args.gitHost.headRef),
        }
      : undefined;
    const token = process.env.CRUMBTRAIL_GITHUB_TOKEN;

    if (
      gitHost &&
      gitHost.owner &&
      gitHost.repo &&
      gitHost.baseRef &&
      gitHost.headRef &&
      token &&
      evidence.length > 0
    ) {
      try {
        const client: GitHostClient = this.gitHostClientFactory
          ? this.gitHostClientFactory({
              owner: gitHost.owner,
              repo: gitHost.repo,
            })
          : new GitHubRestClient({
              owner: gitHost.owner,
              repo: gitHost.repo,
              token,
            });
        const commits = await client.listCommits({
          baseRef: gitHost.baseRef,
          headRef: gitHost.headRef,
        });
        intent = inferIntent(evidence, commits);
      } catch (err) {
        const message =
          err instanceof GitHostError
            ? `GitHostError (status ${err.status}): ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err);
        process.stderr.write(
          `solveContext: git-host intent-inference failed, falling back to existing intent: ${message}\n`,
        );
      }
    }

    const gaps = [
      ...ticketGaps,
      // Adapter-only (sessionless Mode A) bundle: state that no Crumbtrail session
      // matched even though the bundle is populated from evidence sources.
      ...(sessionlessAdapterBundle ? [NO_LOCATED_SESSION_GAP] : []),
      ...adapterGaps,
      ...(evidence.length === 0 && !noInputGiven
        ? [
            {
              // Unified with NO_LOCATED_SESSION_GAP so every no-match outcome
              // (auto-locate miss, comparison miss, sessionless) reads the same
              // "no recorded session matched this symptom" wording — the old
              // "compared" vs "matched" split confused readers about whether a
              // comparison had even run. The reproduction note, when present, is
              // appended to that single canonical reason.
              lane: NO_LOCATED_SESSION_GAP.lane,
              reason: reproductionNote
                ? `${NO_LOCATED_SESSION_GAP.reason}; reproduction attempt: ${reproductionNote}`
                : NO_LOCATED_SESSION_GAP.reason,
              suggestion: NO_LOCATED_SESSION_GAP.suggestion,
            },
          ]
        : []),
    ];

    const bundle = assembleBundle({
      symptom,
      evidence,
      intent,
      gaps,
      located: locatedDecision,
    });
    if (budget.maxTokens === undefined) return textResult(bundle);
    // Budgeted: fill the relevance-ranked evidence in rank order; refs are
    // EvidenceItem.id values (the same ids opinion.hypotheses reference).
    return this.budgetedTextResult(
      bundle as unknown as Record<string, unknown>,
      "evidence",
      bundle.evidence,
      budget.maxTokens,
      (item) => item.id,
    );
  }

  // --- Distinct within-session bug grouping ---

  private toolListDistinctBugs(args: Record<string, unknown>) {
    if (args.mode === "cross-session") {
      return textResult(
        this.recurrenceRollups(args).map((rollup) =>
          this.compactRecurrence(rollup),
        ),
      );
    }

    if (!this.isSafeSessionId(args.sessionId))
      return errorResult("sessionId is required");
    const dir = this.sessionDir(args.sessionId as string);
    if (!this.sessionExists(dir)) return errorResult("Session not found");
    const bugs = this.readDistinctBugs(dir);
    return textResult(
      bugs.map((bug) =>
        removeUndefined({
          bugId: stringField(bug.bugId),
          signature: this.signatureForBug(bug),
          title: stringField(bug.title),
          severity: stringField(bug.severity),
          firstSeen: numberField(bug.firstSeen),
          lastSeen: numberField(bug.lastSeen),
          window: isRecord(bug.window) ? bug.window : undefined,
          requestIds: Array.isArray(bug.requestIds)
            ? bug.requestIds
            : undefined,
          counts: {
            frontend: Array.isArray(bug.frontendEvidence)
              ? bug.frontendEvidence.length
              : 0,
            backend: Array.isArray(bug.backendEvidence)
              ? bug.backendEvidence.length
              : 0,
            dbDiffs: Array.isArray(bug.dbDiffs) ? bug.dbDiffs.length : 0,
            candidates: Array.isArray(bug.candidateIds)
              ? bug.candidateIds.length
              : 0,
          },
        }),
      ),
    );
  }

  private toolGetRecurrence(args: Record<string, unknown>) {
    const signature = stringField(args.signature);
    if (!signature) return errorResult("signature is required");
    const recurrence = this.recurrenceRollups(args).find(
      (entry) => entry.signature === signature,
    );
    if (!recurrence) return errorResult(`Recurrence ${signature} not found`);
    return textResult(recurrence);
  }

  private toolGetBug(args: Record<string, unknown>) {
    const dir = this.sessionDir(args.sessionId as string);
    if (!this.sessionExists(dir)) return errorResult("Session not found");
    const bugId = args.bugId as string;
    const bug = this.readDistinctBugs(dir).find(
      (entry) => stringField(entry.bugId) === bugId,
    );
    if (!bug) return errorResult(`Bug ${bugId} not found in session`);
    return textResult(bug);
  }

  /** Reads the grouped distinct bugs from the finalized hot-plane bundle (llm.json, else bundle.json). */
  private readDistinctBugs(dir: string): Record<string, unknown>[] {
    return readSessionDistinctBugs(dir);
  }

  private recurrenceRollups(
    args: Record<string, unknown>,
  ): DistinctBugRecurrence[] {
    const inputs: DistinctBugRecurrenceInput[] = [];
    for (const { dir } of defaultSessionStore.listSessions(this.outputDir)) {
      const meta = this.readJsonRecord(dir, "meta.json") ?? {};
      if (typeof args.app === "string" && meta.app !== args.app) continue;
      if (typeof args.tenant === "string" && meta.tenant !== args.tenant)
        continue;
      const sessionId =
        stringField(meta.id) ??
        stringField(meta.sessionId) ??
        path.basename(dir);
      const session = {
        sessionId,
        dir,
        app: stringField(meta.app),
        tenant: stringField(meta.tenant),
        release: this.firstString(meta, ["release", "releaseId", "version"]),
        build: this.firstString(meta, ["build", "buildId", "commit", "sha"]),
        start: numberField(meta.start) ?? numberField(meta.startedAt),
      };
      for (const bug of this.readDistinctBugs(dir)) {
        if (this.isDistinctBugRecord(bug)) inputs.push({ bug, session });
      }
    }
    return groupDistinctBugRecurrences(inputs);
  }

  private compactRecurrence(
    recurrence: DistinctBugRecurrence,
  ): Record<string, unknown> {
    return removeUndefined({
      signature: recurrence.signature,
      title: recurrence.title,
      severity: recurrence.severity,
      first_seen: recurrence.first_seen,
      last_seen: recurrence.last_seen,
      session_count: recurrence.session_count,
      release_span: recurrence.release_span,
      apps: recurrence.apps,
      tenants: recurrence.tenants,
      occurrences: recurrence.occurrences.map((occurrence) =>
        removeUndefined({
          sessionId: occurrence.sessionId,
          bugId: occurrence.bugId,
          title: occurrence.title,
          severity: occurrence.severity,
          firstSeen: occurrence.firstSeen,
          lastSeen: occurrence.lastSeen,
          app: occurrence.app,
          tenant: occurrence.tenant,
          release: occurrence.release,
          build: occurrence.build,
        }),
      ),
    });
  }

  private signatureForBug(bug: Record<string, unknown>): string | undefined {
    return this.isDistinctBugRecord(bug)
      ? buildDistinctBugSignature(bug)
      : undefined;
  }

  /**
   * Recall past issues that rhyme with a session or a free-text description. In
   * cloud deployments (CRUMBTRAIL_CLOUD_URL + CRUMBTRAIL_API_KEY set) this delegates
   * to the org-wide semantic index; otherwise it scans the local session store
   * with a text-overlap + facet analogue so self-hosted users still get recall
   * without a vector DB.
   */
  private async toolRecallSimilarIssues(args: Record<string, unknown>) {
    const limit = Math.min(
      Math.max(Number.isInteger(args.limit) ? Number(args.limit) : 5, 1),
      20,
    );
    const sessionId = stringField(args.sessionId);
    const query = stringField(args.query);

    const cloud = await recallViaCloud(sessionId, query, limit);
    if (cloud) return textResult({ ...cloud, source: "cloud" });

    const store = this.recallStore();
    let profile: LocalIssueProfile | undefined;
    let excludeSessionId: string | undefined;
    if (sessionId) {
      if (!this.isSafeSessionId(sessionId))
        return errorResult("Invalid sessionId");
      const found = store
        .listSessions()
        .find((session) => session.id === sessionId);
      if (!found) return errorResult(`Session not found: ${sessionId}`);
      const dir = found.dir;
      profile = sessionIssueProfile(dir, store);
      excludeSessionId = sessionId;
      if (!profile)
        return textResult({ matches: [], indexed: false, source: "local" });
    } else if (query) {
      profile = { tokens: tokenizeIssueText(query), facetTokens: [] };
    } else {
      return errorResult("Provide sessionId or query");
    }

    const matches = recallLocal(profile, store, excludeSessionId, limit);
    return textResult({ matches, indexed: true, source: "local" });
  }

  /** Adapt this server's storage readers to the recall engine's injected seam.
   *  Delegates to the shared buildRecallStore so the MCP tool and the inner
   *  /api/solve-context endpoint locate against an identical store. */
  private recallStore(): RecallStore {
    return buildRecallStore(this.outputDir);
  }

  private isDistinctBugRecord(bug: unknown): bug is DistinctBug {
    return isDistinctBugRecordShared(bug);
  }

  private firstString(
    record: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = stringField(record[key]);
      if (value) return value;
    }
    return undefined;
  }

  // --- Hierarchical lazy retrieval (manifest -> window -> evidence) ---

  private async toolGetSessionManifest(args: Record<string, unknown>) {
    const dir = await this.sessionDirAsync(args.sessionId as string);
    const manifest = await this.readJsonRecordAsync(dir, "manifest.json");
    // Always-present additive tokenEstimate (CP4): the manifest is the drilldown
    // entry point, so agents can plan follow-up budgets from it.
    if (manifest) return textResult(attachTokenEstimate(manifest));

    const index = await this.readJsonRecordAsync(dir, "index.json");
    if (!index) return errorResult("Session not found");
    return textResult(
      attachTokenEstimate(await this.synthesizeManifestAsync(dir, index)),
    );
  }

  private async synthesizeManifestAsync(
    dir: string,
    index: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const start = numberField(index.start);
    const end = numberField(index.end);
    const errs = Array.isArray(index.errs) ? index.errs : [];
    const failedReqs = Array.isArray(index.failedReqs) ? index.failedReqs : [];
    const candidates = await this.readCandidatesJsonlAsync(dir);
    return removeUndefined({
      schemaVersion: 1,
      kind: "crumbtrail.session-manifest",
      synthesized: true,
      session: removeUndefined({
        id: stringField(index.id) ?? path.basename(dir),
        startMs: start,
        endMs: end,
        durationMs:
          numberField(index.dur) ??
          (start !== undefined && end !== undefined
            ? Math.max(0, end - start)
            : undefined),
        eventCount: numberField(index.evts),
      }),
      timeline: {
        eventCounts: isRecord(index.stats) ? index.stats : {},
        errorMarkers: errs.slice(0, 20),
        failedRequests: failedReqs.slice(0, 20),
      },
      candidates: candidates.slice(0, 20).map((candidate) =>
        removeUndefined({
          id: stringField(candidate.id),
          detector: stringField(candidate.detector),
          severity: stringField(candidate.severity),
          basis: "heuristic",
          baseScore: numberField(candidate.score),
          score: numberField(candidate.score),
          anchor: isRecord(candidate.anchor) ? candidate.anchor : undefined,
          evidenceWindow: isRecord(candidate.evidenceWindow)
            ? candidate.evidenceWindow
            : undefined,
        }),
      ),
      accessPattern: [
        "manifest.json was synthesized from index.json (older session without a manifest).",
        "Use getWindow(sessionId, t0, t1) for bounded raw evidence and getEvidence(sessionId, ref) to resolve a candidate, signature, or request id.",
      ],
    });
  }

  private async toolGetWindow(args: Record<string, unknown>) {
    const budget = this.maxTokensOf(args);
    if ("error" in budget) return errorResult(budget.error);
    const dir = await this.sessionDirAsync(args.sessionId as string);
    const t0 = numberField(args.t0);
    const t1 = numberField(args.t1);
    if (t0 === undefined || t1 === undefined)
      return errorResult("getWindow requires numeric t0 and t1 (absolute ms)");

    const events = await this.readColdEventsAsync(dir);
    if (events === undefined) {
      if (!(await this.sessionExistsAsync(dir)))
        return errorResult("Session not found");
      const empty = {
        sessionId: args.sessionId,
        t0: Math.min(t0, t1),
        t1: Math.max(t0, t1),
        units: "absolute-ms",
        count: 0,
        returned: 0,
        truncated: false,
        events: [],
      };
      if (budget.maxTokens === undefined) return textResult(empty);
      return textResult(attachTokenEstimate(empty));
    }

    const lo = Math.min(t0, t1);
    const hi = Math.max(t0, t1);
    const matched = events.filter(
      (event) => typeof event.t === "number" && event.t >= lo && event.t <= hi,
    );
    const cap = this.windowCap(args.limit);
    const returned = matched.slice(0, cap);
    const payload = {
      sessionId: args.sessionId,
      t0: lo,
      t1: hi,
      units: "absolute-ms",
      count: matched.length,
      returned: returned.length,
      truncated: matched.length > returned.length,
      events: returned,
    };
    if (budget.maxTokens === undefined) return textResult(payload);
    // Budgeted: drop chronological events from the TAIL (after the existing
    // limit cap). Events carry no ids, so drop-report refs are "t=<ms>" — the
    // first ref is the first omitted event's timestamp for re-windowing.
    return this.budgetedTextResult(
      payload as unknown as Record<string, unknown>,
      "events",
      returned,
      budget.maxTokens,
      (event) => `t=${event.t}`,
      (kept, out) => {
        out.returned = kept.length;
        out.truncated = matched.length > kept.length;
      },
    );
  }

  private async toolGetEvidence(args: Record<string, unknown>) {
    const sessionId = args.sessionId as string;
    const ref = args.ref as string;
    const dir = await this.sessionDirAsync(sessionId);
    const candidates = await this.readCandidatesJsonlAsync(dir);

    // Every getEvidence payload carries an always-present additive
    // tokenEstimate (CP4) so agents can account for drilldown costs.
    const candidate = candidates.find((entry) => stringField(entry.id) === ref);
    if (candidate) {
      return textResult(
        attachTokenEstimate(
          removeUndefined({
            sessionId,
            ref,
            kind: "candidate",
            candidate,
            anchor: isRecord(candidate.anchor) ? candidate.anchor : undefined,
            evidenceWindow: isRecord(candidate.evidenceWindow)
              ? candidate.evidenceWindow
              : undefined,
          }),
        ),
      );
    }

    const signatures = await this.readSignatureEntriesAsync(dir);
    const signature = signatures.find(
      (entry) => stringField(entry.sig) === ref || String(entry.id) === ref,
    );
    if (signature) {
      const occurrence = await this.readInteractiveElementAsync(
        dir,
        stringField(signature.sig),
      );
      return textResult(
        attachTokenEstimate(
          removeUndefined({
            sessionId,
            ref,
            kind: "signature",
            signature,
            occurrences: occurrence,
          }),
        ),
      );
    }

    const byRequest = candidates.find(
      (entry) =>
        isRecord(entry.anchor) && stringField(entry.anchor.requestId) === ref,
    );
    if (byRequest) {
      return textResult(
        attachTokenEstimate(
          removeUndefined({
            sessionId,
            ref,
            kind: "request",
            candidate: byRequest,
            anchor: isRecord(byRequest.anchor) ? byRequest.anchor : undefined,
            evidenceWindow: isRecord(byRequest.evidenceWindow)
              ? byRequest.evidenceWindow
              : undefined,
          }),
        ),
      );
    }

    if (!(await this.sessionExistsAsync(dir)))
      return errorResult("Session not found");

    return textResult(
      attachTokenEstimate({
        sessionId,
        ref,
        kind: "unknown",
        status: "not-found",
        hint: "ref did not match a candidate id, interactive-element signature, or request id in hot-plane artifacts. Use getWindow for raw chronological events.",
      }),
    );
  }

  private windowCap(limit: unknown): number {
    const requested = numberField(limit);
    if (requested === undefined) return 500;
    return Math.max(1, Math.min(500, Math.floor(requested)));
  }

  private sessionExists(dir: string): boolean {
    return [
      "manifest.json",
      "index.json",
      "meta.json",
      "candidates.jsonl",
      "events.ndjson",
      "events.ndjson.zst",
    ].some((name) => defaultSessionStore.statArtifact(dir, name) !== undefined);
  }

  private async sessionExistsAsync(dir: string): Promise<boolean> {
    const artifacts = await Promise.all(
      [
        "manifest.json",
        "index.json",
        "meta.json",
        "candidates.jsonl",
        "events.ndjson",
        "events.ndjson.zst",
      ].map((name) => this.store.statArtifact(dir, name)),
    );
    return artifacts.some((artifact) => artifact !== undefined);
  }

  /** Reads the sanitized cold event stream first; falls back to legacy/plain events when zstd is absent. */
  private async readColdEventsAsync(
    dir: string,
  ): Promise<BugEvent[] | undefined> {
    const cold = await this.store.readArtifact(dir, "events.ndjson.zst");
    if (cold) {
      if (typeof zlib.zstdDecompressSync !== "function") {
        throw new Error(
          "Crumbtrail cold storage requires Node.js >=22.15.0 for zstd decompression.",
        );
      }
      return this.parseEvents(zlib.zstdDecompressSync(cold).toString("utf-8"));
    }
    const plain = await this.store.readArtifact(dir, "events.ndjson");
    if (plain) return this.parseEvents(plain.toString("utf-8"));
    return undefined;
  }

  private parseEvents(content: string): BugEvent[] {
    const trimmed = content.trim();
    if (!trimmed) return [];
    return trimmed
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  private async readCandidatesJsonlAsync(
    dir: string,
  ): Promise<Record<string, unknown>[]> {
    const candidatesBuf = await this.store.readArtifact(
      dir,
      "candidates.jsonl",
    );
    if (candidatesBuf) {
      const out: Record<string, unknown>[] = [];
      for (const line of candidatesBuf.toString("utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const parsed: unknown = JSON.parse(line);
          if (isRecord(parsed)) out.push(parsed);
        } catch {
          // skip malformed lines
        }
      }
      return out;
    }

    return [];
  }

  private async readSignatureEntriesAsync(
    dir: string,
  ): Promise<Record<string, unknown>[]> {
    const signatures = await this.readJsonRecordAsync(dir, "signatures.json");
    return Array.isArray(signatures?.entries)
      ? signatures.entries.filter(isRecord)
      : [];
  }

  private async readInteractiveElementAsync(
    dir: string,
    sig: string | undefined,
  ): Promise<Record<string, unknown> | undefined> {
    if (!sig) return undefined;
    const match = (await this.readInteractiveElementsAsync(dir)).find(
      (element) => stringField(element.sig) === sig,
    );
    if (!match) return undefined;
    return removeUndefined({
      count: numberField(match.count),
      path: stringField(match.path),
      tag: stringField(match.tag),
      txt: stringField(match.txt),
    });
  }

  private async readInteractiveElementsAsync(
    dir: string,
  ): Promise<Record<string, unknown>[]> {
    const bundle =
      (await this.readJsonRecordAsync(dir, "llm.json")) ??
      (await this.readJsonRecordAsync(dir, "bundle.json"));
    const browserEvidence = isRecord(bundle?.browserEvidence)
      ? bundle.browserEvidence
      : undefined;
    return Array.isArray(browserEvidence?.interactiveElements)
      ? browserEvidence.interactiveElements.filter(isRecord)
      : [];
  }

  private readSignatureEntries(dir: string): Record<string, unknown>[] {
    const signatures = this.readJsonRecord(dir, "signatures.json");
    return Array.isArray(signatures?.entries)
      ? signatures!.entries.filter(isRecord)
      : [];
  }

  private readInteractiveElement(
    dir: string,
    sig: string | undefined,
  ): Record<string, unknown> | undefined {
    if (!sig) return undefined;
    const match = this.readInteractiveElements(dir).find(
      (element) => stringField(element.sig) === sig,
    );
    if (!match) return undefined;
    return removeUndefined({
      count: numberField(match.count),
      path: stringField(match.path),
      tag: stringField(match.tag),
      txt: stringField(match.txt),
    });
  }

  /**
   * Reads the finalized hot-plane interactive-element identity map (bundle.browserEvidence
   * .interactiveElements). Prefers llm.json then bundle.json — the same finalized artifacts
   * listDistinctBugs/getBug read. Values are already redaction-sanitized at bundle build time;
   * this only ever surfaces those redacted descriptors, never raw masked values.
   */
  private readInteractiveElements(dir: string): Record<string, unknown>[] {
    const bundle =
      this.readJsonRecord(dir, "llm.json") ??
      this.readJsonRecord(dir, "bundle.json");
    const browserEvidence = isRecord(bundle?.browserEvidence)
      ? bundle!.browserEvidence
      : undefined;
    return Array.isArray(browserEvidence?.interactiveElements)
      ? browserEvidence!.interactiveElements.filter(isRecord)
      : [];
  }

  // --- Signature resolve / locate (act-by-identity, phase 1: deterministic, resolve-only) ---

  private toolResolveSignature(args: Record<string, unknown>) {
    const sessionId = args.sessionId as string;
    const signature = stringField(args.signature) ?? stringField(args.sig);
    const dir = this.sessionDir(sessionId);
    if (!this.sessionExists(dir)) return errorResult("Session not found");
    if (!signature)
      return errorResult(
        "resolveSignature requires a non-empty signature string",
      );

    const descriptor = this.buildElementDescriptor(dir, signature);
    if (!descriptor) {
      return errorResult(
        `Signature ${signature} not found in the interactive-element map for session ${sessionId}`,
      );
    }
    return textResult(
      removeUndefined({
        sessionId,
        kind: "interactive-element",
        ...descriptor,
      }),
    );
  }

  private toolLocateInteractiveElements(args: Record<string, unknown>) {
    const sessionId = args.sessionId as string;
    const dir = this.sessionDir(sessionId);
    if (!this.sessionExists(dir)) return errorResult("Session not found");

    const text = stringField(args.text)?.trim().toLowerCase();
    const role = (stringField(args.role) ?? stringField(args.tag))
      ?.trim()
      .toLowerCase();
    const limit = this.locateLimit(args.limit);

    const elements = this.readInteractiveElements(dir);
    const sigEntries = this.readSignatureEntries(dir);
    const descriptors = elements
      .map((element) =>
        this.buildElementDescriptorFrom(
          elements,
          sigEntries,
          stringField(element.sig),
        ),
      )
      .filter((entry): entry is Record<string, unknown> => entry !== undefined);

    const filtered = descriptors.filter((entry) => {
      if (role) {
        const tag = stringField(entry.tag)?.toLowerCase();
        if (tag !== role) return false;
      }
      if (text) {
        const label = stringField(entry.label)?.toLowerCase() ?? "";
        const p = stringField(entry.path)?.toLowerCase() ?? "";
        if (!label.includes(text) && !p.includes(text)) return false;
      }
      return true;
    });

    const ranked = filtered
      .map((entry) =>
        removeUndefined({
          signature: stringField(entry.signature),
          role: stringField(entry.role),
          label: stringField(entry.label),
          path: stringField(entry.path),
          occurrences: numberField(entry.occurrences),
        }),
      )
      .sort((a, b) => {
        const occ = (b.occurrences ?? 0) - (a.occurrences ?? 0);
        if (occ !== 0) return occ;
        const label = (a.label ?? "").localeCompare(b.label ?? "");
        if (label !== 0) return label;
        return (a.signature ?? "").localeCompare(b.signature ?? "");
      });

    const returned = ranked.slice(0, limit);
    return textResult(
      removeUndefined({
        sessionId,
        filter: removeUndefined({
          text: text || undefined,
          role: role || undefined,
        }),
        count: ranked.length,
        returned: returned.length,
        truncated: ranked.length > returned.length,
        elements: returned,
      }),
    );
  }

  private locateLimit(limit: unknown): number {
    const requested = numberField(limit);
    if (requested === undefined) return 100;
    return Math.max(1, Math.min(100, Math.floor(requested)));
  }

  /**
   * Builds a deterministic, redaction-safe descriptor for one signature by combining the
   * finalized interactive-element map (label/text, tag, occurrence count, path) with the
   * cold-plane signature dictionary (first-seen, first event kind). Returns undefined when the
   * signature is absent from the interactive-element map.
   */
  private buildElementDescriptor(
    dir: string,
    signature: string | undefined,
  ): Record<string, unknown> | undefined {
    if (!signature) return undefined;
    return this.buildElementDescriptorFrom(
      this.readInteractiveElements(dir),
      this.readSignatureEntries(dir),
      signature,
    );
  }

  /**
   * Pure descriptor builder over already-read interactive-element and signature-dictionary
   * arrays. Hoisting the reads out of callers keeps locateInteractiveElements O(n) instead of
   * re-parsing the bundle/signature files once per element.
   */
  private buildElementDescriptorFrom(
    elements: Record<string, unknown>[],
    sigEntries: Record<string, unknown>[],
    signature: string | undefined,
  ): Record<string, unknown> | undefined {
    if (!signature) return undefined;
    const element = elements.find(
      (entry) => stringField(entry.sig) === signature,
    );
    if (!element) return undefined;

    const sigEntry = sigEntries.find(
      (entry) => stringField(entry.sig) === signature,
    );
    const tag = stringField(element.tag) ?? stringField(sigEntry?.tag);
    const elementPath =
      stringField(element.path) ?? stringField(sigEntry?.path);
    const label = stringField(element.txt);
    const firstEventKind = stringField(sigEntry?.firstEventKind);

    return removeUndefined({
      signature,
      path: elementPath,
      selector: elementPath,
      tag,
      role: tag,
      label,
      text: label,
      occurrences: numberField(element.count),
      firstSeen: numberField(sigEntry?.firstSeen),
      firstEventKind,
      affordance: this.affordanceFor(tag, firstEventKind),
    });
  }

  private affordanceFor(
    tag: string | undefined,
    firstEventKind: string | undefined,
  ): { clickable: boolean; input: boolean } {
    const t = tag?.toLowerCase();
    const clickable = firstEventKind === "clk" || t === "button" || t === "a";
    const input =
      firstEventKind === "inp" ||
      t === "input" ||
      t === "textarea" ||
      t === "select";
    return { clickable, input };
  }

  private readJsonRecord(
    dir: string,
    name: string,
  ): Record<string, unknown> | undefined {
    return readSessionJsonRecord(dir, name);
  }

  private async readJsonRecordAsync(
    dir: string,
    name: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const buf = await this.store.readArtifact(dir, name);
      if (!buf) return undefined;
      const parsed: unknown = JSON.parse(buf.toString("utf-8"));
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private toolGetStorageSnapshot(args: Record<string, unknown>) {
    const dir = this.sessionDir(args.sessionId as string);
    const events = this.readEvents(dir);
    const snaps = events.filter((e) => e.k === "snap");
    return textResult(snaps);
  }

  private toolGetCookieChanges(args: Record<string, unknown>) {
    const dir = this.sessionDir(args.sessionId as string);
    const events = this.readEvents(dir);
    const cookies = events.filter((e) => e.k === "cookie");
    return textResult(cookies);
  }

  private toolGetStorageChanges(args: Record<string, unknown>) {
    const dir = this.sessionDir(args.sessionId as string);
    const events = this.readEvents(dir);
    const storage = events.filter((e) => e.k === "stor");
    return textResult(storage);
  }

  private toolGetTranscript(args: Record<string, unknown>) {
    const dir = this.sessionDir(args.sessionId as string);
    const events = this.readEvents(dir);
    const transcripts = events.filter((e) => e.k === "tx");
    return textResult(transcripts);
  }

  private toolGetFrame(args: Record<string, unknown>) {
    const dir = this.sessionDir(args.sessionId as string);
    const frameBuf = defaultSessionStore.readArtifact(dir, "index.json");
    if (!frameBuf) return errorResult("Session not found");
    const data = JSON.parse(frameBuf.toString("utf-8"));
    const frames: Array<{ t: number; file: string }> = data.frames || [];
    if (frames.length === 0) return errorResult("No frames found");

    const timestamp = args.timestamp as number;
    let nearest = frames[0];
    let minDiff = Math.abs(nearest.t - timestamp);
    for (const frame of frames) {
      const diff = Math.abs(frame.t - timestamp);
      if (diff < minDiff) {
        minDiff = diff;
        nearest = frame;
      }
    }

    const framePath = path.join(dir, "frames", nearest.file);
    if (!fs.existsSync(framePath))
      return errorResult(`Frame file not found: ${nearest.file}`);
    const base64Data = fs.readFileSync(framePath).toString("base64");
    return imageResult(base64Data);
  }

  private toolGetFrameById(args: Record<string, unknown>) {
    const dir = this.sessionDir(args.sessionId as string);
    const filename = args.filename as string;
    if (!isSafeFrameFilename(filename))
      return errorResult("Invalid frame filename");
    const framePath = path.join(dir, "frames", filename);
    if (!fs.existsSync(framePath))
      return errorResult(`Frame file not found: ${filename}`);
    const base64Data = fs.readFileSync(framePath).toString("base64");
    return imageResult(base64Data);
  }

  // --- Bug queue tools ---

  private toolListBugs(args: Record<string, unknown>) {
    const bugs = this.bugQueue.list({
      status: args.status as string | undefined,
      after: args.after as number | undefined,
      before: args.before as number | undefined,
    });
    return textResult(bugs);
  }

  private toolGetBugReport(args: Record<string, unknown>) {
    const report = this.safeGetBug(args.bugId as string);
    if (!report) return errorResult("Bug not found");
    return textResult(report);
  }

  private toolGetBugEvents(args: Record<string, unknown>) {
    const target = this.resolveTarget(args);
    if ("error" in target) return errorResult(target.error);
    let events = this.filterEvents(this.readEvents(target.dir), args);
    const limit =
      typeof args.limit === "number"
        ? Math.max(1, Math.min(1000, args.limit))
        : 100;
    events = events.slice(0, limit);
    if (args.compact === true) {
      return textResult(events.map((e) => [e.t, e.k, e.d]));
    }
    return textResult(events);
  }

  private toolGetBugErrorContext(args: Record<string, unknown>) {
    const target = this.resolveTarget(args);
    if ("error" in target) return errorResult(target.error);
    const windowMs = typeof args.windowMs === "number" ? args.windowMs : 2000;
    return this.errorContextFor(target.dir, windowMs);
  }

  private toolGetBugFailedRequests(args: Record<string, unknown>) {
    const target = this.resolveTarget(args);
    if ("error" in target) return errorResult(target.error);
    return this.failedRequestsFor(target.dir, "Bug not found");
  }

  private toolGetBugVoiceTranscript(args: Record<string, unknown>) {
    const report = this.safeGetBug(args.bugId as string);
    if (!report) return errorResult("Bug not found");
    const bugDir = this.bugQueue.getBugDir(args.bugId as string);
    const events = this.readEvents(bugDir);
    const transcripts = events.filter((e) => e.k === "tx");
    if (transcripts.length > 0) return textResult(transcripts);
    // Check for raw voice file
    const voicePath = path.join(bugDir, "voice.webm");
    if (fs.existsSync(voicePath)) {
      return textResult({
        status: "voice_recorded_but_not_transcribed",
        file: "voice.webm",
      });
    }
    return textResult({ status: "no_voice_note" });
  }

  private toolResolveBug(args: Record<string, unknown>) {
    const bugId = args.bugId as string;
    const report = this.safeGetBug(bugId);
    if (!report) return errorResult("Bug not found");
    this.bugQueue.resolve(bugId);
    return textResult({ ok: true, bugId, status: "resolved" });
  }

  private toolGetBugLlmContext(args: Record<string, unknown>) {
    const context = this.safeGetBugLlmContext(args.bugId as string);
    if (!context) return errorResult("Bug not found");
    return textResult(context);
  }

  private safeGetBug(bugId: string) {
    try {
      return this.bugQueue.get(bugId);
    } catch {
      return null;
    }
  }

  private safeGetBugLlmContext(bugId: string) {
    try {
      return this.bugQueue.getLlmContext(bugId);
    } catch {
      return null;
    }
  }
}

function isSafeFrameFilename(filename: unknown): filename is string {
  if (typeof filename !== "string") return false;
  if (filename.length === 0 || filename === "." || filename === "..")
    return false;
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("\0")
  )
    return false;
  if (path.isAbsolute(filename)) return false;
  return /^[A-Za-z0-9._-]+$/.test(filename);
}
