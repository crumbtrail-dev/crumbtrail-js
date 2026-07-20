import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { BugEvent } from "crumbtrail-core";
import {
  buildBackendRequestEndEvent,
  buildBackendRequestErrorEvent,
  buildBackendRequestStartEvent,
} from "./backend-events";
import { McpServer } from "./mcp-server";
import { createServer } from "./server";
import {
  evidenceSourcesFromEnv,
  type EvidenceSource,
  type SourceHealth,
} from "./evidence-sources";
import {
  CONFLUENCE_AUTH_FIELDS,
  CONFLUENCE_BASE_URL_ENV,
  CONFLUENCE_SPACE_KEYS_ENV,
  countDroppedSpaceKeys,
  parseSpaceKeysEnv,
  sanitizeSpaceKeys,
} from "./knowledge";

export type CheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  summary: string;
}

/** Reduce raw checks to an overall verdict. Warnings do not fail the run; failures do. */
export function evaluateDoctor(checks: DoctorCheck[]): DoctorReport {
  const passed = checks.filter((c) => c.status === "pass").length;
  const warnings = checks.filter((c) => c.status === "warn").length;
  const failed = checks.filter((c) => c.status === "fail").length;

  const summary = `${passed} passed, ${warnings} warning${warnings === 1 ? "" : "s"}, ${failed} failed`;
  return { ok: failed === 0, checks, summary };
}

const PROBE_SESSION_PREFIXES = ["ses_probe_", "ses_otlp_probe_"];
const COMPUTED_IMPORT = /import\(\s*(?!'crumbtrail-core'\s*\))/m;

/** Static check: generated browser wiring must use a literal crumbtrail-core specifier. */
export function checkClientWiring(cwd: string): DoctorCheck {
  const clientPath = path.join(cwd, "crumbtrail.client.js");
  if (!fs.existsSync(clientPath)) {
    return {
      name: "client-wiring",
      status: "warn",
      detail: "no crumbtrail.client.js in this directory",
      remediation:
        "run `crumbtrail-server init` to generate the browser wiring helper",
    };
  }

  const contents = fs.readFileSync(clientPath, "utf-8");
  if (COMPUTED_IMPORT.test(contents)) {
    return {
      name: "client-wiring",
      status: "fail",
      detail: "crumbtrail.client.js contains a computed import() specifier",
      remediation:
        "use a literal import('crumbtrail-core') — Vite's dev server cannot resolve computed specifiers, so capture silently no-ops; re-run `crumbtrail-server init --force` to regenerate",
    };
  }

  if (
    !contents.includes("import('crumbtrail-core')") &&
    !contents.includes("from 'crumbtrail-core'")
  ) {
    return {
      name: "client-wiring",
      status: "fail",
      detail: "crumbtrail.client.js does not import crumbtrail-core",
      remediation:
        "re-run `crumbtrail-server init --force` to regenerate the helper",
    };
  }

  return {
    name: "client-wiring",
    status: "pass",
    detail:
      "crumbtrail.client.js imports crumbtrail-core with a literal specifier",
  };
}

/** Count finalized sessions under the partition layout, excluding doctor probes. */
export function countBrowserSessions(outputDir: string): number {
  let count = 0;
  const stack = [outputDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, "meta.json"))) {
        if (
          !PROBE_SESSION_PREFIXES.some((prefix) =>
            entry.name.startsWith(prefix),
          )
        )
          count += 1;
      } else {
        stack.push(full);
      }
    }
  }
  return count;
}

/** Behavioral check for the C8.1 failure mode: capture silently no-ops leave zero sessions. */
export function checkBrowserSessions(outputDir: string): DoctorCheck {
  const count = countBrowserSessions(outputDir);
  if (count === 0) {
    return {
      name: "browser-capture",
      status: "warn",
      detail:
        "zero captured sessions in the output directory (doctor probe sessions excluded)",
      remediation:
        "if you have interacted with your app and still see zero sessions, capture is silently no-oping — open the browser devtools console and look for an unresolved 'crumbtrail-core' import (Vite dev requires a literal specifier); fix the wiring, reload, interact, and re-run `crumbtrail-server doctor`",
    };
  }

  return {
    name: "browser-capture",
    status: "pass",
    detail: `${count} captured session(s) found (probe sessions excluded)`,
  };
}

export interface CheckEvidenceSourcesInput {
  sources: EvidenceSource[];
}

/**
 * List each configured evidence source, its auth validity (via the source's
 * cheap authenticated no-op `health()`), and its declared join keys. Advisory:
 * a dead source is a `fail` line, not a thrown error, and zero configured
 * sources is a `warn` (native + OTLP capture still work). `health()` errors are
 * caught so one bad adapter cannot break the doctor run.
 */
export async function checkEvidenceSources(
  input: CheckEvidenceSourcesInput,
): Promise<DoctorCheck[]> {
  const { sources } = input;
  if (sources.length === 0) {
    return [
      {
        name: "evidence-sources",
        status: "warn",
        detail:
          "no evidence sources configured (query-at-incident-time pull is off)",
        remediation:
          "set an evidence adapter's credentials (e.g. Sentry/CloudWatch env vars) to enrich ticket bundles from your existing observability tools",
      },
    ];
  }

  const checks: DoctorCheck[] = [];
  for (const source of sources) {
    const { provider, displayName, joinKeys } = source.descriptor;
    const keys = joinKeys.length > 0 ? joinKeys.join(", ") : "none";
    let health: SourceHealth;
    try {
      health = await source.health();
    } catch (err) {
      health = {
        ok: false,
        provider,
        checkedAt: Date.now(),
        error: (err as Error).message,
      };
    }
    checks.push({
      name: `evidence-source:${provider}`,
      status: health.ok ? "pass" : "fail",
      detail: health.ok
        ? `${displayName} authenticated; join keys: ${keys}`
        : `${displayName} auth check failed: ${health.error ?? "unknown error"} (join keys: ${keys})`,
      remediation: health.ok
        ? undefined
        : `verify ${displayName} credentials and network reachability, then re-run \`crumbtrail-server doctor\``,
    });
  }
  return checks;
}

/**
 * Report whether the Confluence spec oracle is configured.
 *
 * Deliberately a **separate** check from {@link checkEvidenceSources} rather
 * than another line inside it. The two lists answer different questions — "what
 * happened" versus "what was supposed to happen" — and the design rejects
 * Confluence as a seventh evidence adapter
 * (`docs/specs/2026-07-19-confluence-spec-oracle-design.md`, "What this is
 * not"). Merging them in the doctor output would re-blur exactly the boundary
 * `src/__tests__/knowledge-boundary.test.ts` pins.
 *
 * Presence-only: no request is made, so this cannot report auth validity the way
 * an adapter's `health()` does. `CONFLUENCE_API_TOKEN` is never echoed — only
 * the base URL's origin+path and valid space-allowlist keys reach the detail
 * string, and the token is reported as set/unset by inference from the check
 * passing at all.
 *
 * Because `pass` here means "configured" while `checkEvidenceSources` reports
 * `pass` only after a live authenticated `health()` call — and `cli.ts` renders
 * both with the same `✓` — the detail says "(credentials not verified)" so the
 * weaker claim is legible in a report where the two sit side by side.
 */
export function checkSpecOracle(
  env: Record<string, string | undefined> = process.env,
): DoctorCheck {
  const missing = CONFLUENCE_AUTH_FIELDS.filter((name) => {
    const value = env[name];
    return !(typeof value === "string" && value.length > 0);
  });

  if (missing.length > 0) {
    return {
      name: "spec-oracle",
      status: "warn",
      detail: `Confluence spec oracle not configured (missing ${missing.join(", ")})`,
      remediation: `set ${CONFLUENCE_AUTH_FIELDS.join(", ")} to let \`searchSpecs\` answer "is this intended?" from your Confluence pages; leaving it unset is fully supported and disables only that lookup`,
    };
  }

  const configuredSpaceKeys = env[CONFLUENCE_SPACE_KEYS_ENV];
  const parsedSpaceKeys = parseSpaceKeysEnv(configuredSpaceKeys);
  const spaceKeys = sanitizeSpaceKeys(parsedSpaceKeys);
  const droppedSpaceKeys = countDroppedSpaceKeys(parsedSpaceKeys);

  // Mirror `ConfluenceKnowledgeClient`'s env boundary: an allowlist that is
  // present but empty, malformed, or exceeds the key cap fails closed there,
  // so doctor must not describe it as an unrestricted configuration.
  if (
    configuredSpaceKeys !== undefined &&
    (spaceKeys.length === 0 || droppedSpaceKeys > 0)
  ) {
    return {
      name: "spec-oracle",
      status: "warn",
      detail: `${CONFLUENCE_SPACE_KEYS_ENV} is invalid; Confluence searches are disabled until its allowlist is fixed`,
      remediation: `set ${CONFLUENCE_SPACE_KEYS_ENV} to a non-empty comma-separated list of alphanumeric or underscore space keys`,
    };
  }

  const scope =
    spaceKeys.length > 0
      ? `space allowlist: ${spaceKeys.join(", ")}`
      : `no ${CONFLUENCE_SPACE_KEYS_ENV} allowlist (all readable spaces are in scope)`;

  return {
    name: "spec-oracle",
    status: "pass",
    detail: `Confluence spec oracle configured for ${describeBaseUrl(env[CONFLUENCE_BASE_URL_ENV])} (credentials not verified); ${scope}`,
  };
}

/** Render a configured base URL as origin + path for the doctor report, keeping
 *  any credential a misconfigured `CONFLUENCE_BASE_URL` might carry in userinfo
 *  or a query string out of the output.
 *
 *  Deliberately NOT named `sanitizeUrl`, because it is not the same function as
 *  the six private `sanitizeUrl` copies in
 *  `evidence-sources/{sentry,splunk,datadog,posthog}.ts`,
 *  `knowledge/confluence.ts`, and `ticket/clients.ts`. Those take a required
 *  `string` and fall back to a best-effort URL when parsing fails; this one
 *  accepts `string | undefined` and returns human prose ("an unset base URL",
 *  "an unparseable base URL") because its result is interpolated into an
 *  operator-facing sentence, not used as a URL. Sharing the name would assert a
 *  drop-in equivalence that does not hold. */
function describeBaseUrl(raw: string | undefined): string {
  if (!raw) return "an unset base URL";
  try {
    const parsed = new URL(raw);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "an unparseable base URL";
  }
}

export interface ProbeResult {
  linked: boolean;
  correlationStatus: string;
  frontendStatus?: number;
  backendStatus?: number;
  sessionId: string;
  requestId: string;
}

export interface ProbeRoundTripInput {
  endpoint: string;
  outputDir: string;
  fetchImpl?: typeof fetch;
  authToken?: string;
  sessionId?: string;
  requestId?: string;
  now?: number;
}

function sessionStamp(now: number): string {
  // ses_<digits> — stable, sortable, no Date dependency at module scope.
  return `ses_probe_${now}`;
}

function authHeaders(authToken?: string): Record<string, string> {
  return authToken ? { "X-Crumbtrail-Auth": authToken } : {};
}

/**
 * Fires a synthetic but faithful front+back correlated round-trip through a running
 * Crumbtrail server, finalizes the session, then reads it back through the MCP server's
 * getLinkedRequestContext tool — the exact path an AI agent uses. This proves capture,
 * correlation, persistence, and AI-readability end to end.
 */
export async function probeRoundTrip(
  input: ProbeRoundTripInput,
): Promise<ProbeResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const now = input.now ?? Date.now();
  const sessionId = input.sessionId ?? sessionStamp(now);
  const requestId = input.requestId ?? `req_probe_${now}`;
  const base = input.endpoint.replace(/\/+$/, "");
  const headers = {
    "Content-Type": "application/json",
    ...authHeaders(input.authToken),
  };

  const postJson = async (
    pathname: string,
    body: unknown,
  ): Promise<Response> => {
    const res = await fetchImpl(`${base}${pathname}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(
        `crumbtrail intake ${pathname} returned HTTP ${res.status}`,
      );
    return res;
  };

  await postJson("/api/session/start", {
    sessionId,
    metadata: { app: "crumbtrail-doctor", probe: true },
  });

  const correlation = { sessionId, requestId };
  const frontendNetReq: BugEvent = {
    t: now,
    k: "net.req",
    d: {
      id: requestId,
      method: "GET",
      url: "/__crumbtrail/probe",
      ...correlation,
    },
  };
  const frontendNetRes: BugEvent = {
    t: now + 5,
    k: "net.res",
    d: { id: requestId, st: 500, dur: 5, ...correlation },
  };
  const backendStart = buildBackendRequestStartEvent({
    ...correlation,
    method: "GET",
    url: "/__crumbtrail/probe",
    route: "/__crumbtrail/probe",
    now: now + 1,
  });
  const backendError = buildBackendRequestErrorEvent({
    ...correlation,
    statusCode: 500,
    error: new Error("crumbtrail-server doctor synthetic failure"),
    now: now + 2,
  });
  const backendEnd = buildBackendRequestEndEvent({
    ...correlation,
    statusCode: 500,
    durationMs: 4,
    now: now + 3,
  });

  await postJson("/api/events", {
    sessionId,
    events: [
      frontendNetReq,
      frontendNetRes,
      backendStart,
      backendError,
      backendEnd,
    ],
  });
  await postJson("/api/session/end", { sessionId });

  const mcp = new McpServer({ outputDir: input.outputDir });
  const response = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "getLinkedRequestContext",
      arguments: { sessionId, requestId },
    },
  });

  const result = (
    response as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    }
  )?.result;
  if (!result || result.isError) {
    throw new Error("MCP getLinkedRequestContext returned an error result");
  }
  const text = result.content?.[0]?.text ?? "{}";
  const parsed = JSON.parse(text) as {
    status?: string;
    correlationStatus?: string;
    linked?: {
      frontend?: { status?: number };
      backend?: { statusCode?: number };
    };
  };

  return {
    linked: parsed.status === "linked",
    correlationStatus: parsed.correlationStatus ?? "unknown",
    frontendStatus: parsed.linked?.frontend?.status,
    backendStatus: parsed.linked?.backend?.statusCode,
    sessionId,
    requestId,
  };
}

export interface OtlpProbeResult {
  ingested: boolean;
  spanStatus?: string;
  serviceName?: string;
  sessionId: string;
  traceId: string;
  spanCount: number;
}

/**
 * Fires a faithful OTLP error span through /v1/traces, finalizes the session, then reads it
 * back via the MCP getEvents tool — proving the OTLP ingest path is live and AI-readable.
 */
export async function probeOtlpRoundTrip(input: {
  endpoint: string;
  outputDir: string;
  fetchImpl?: typeof fetch;
  authToken?: string;
  sessionId?: string;
  now?: number;
}): Promise<OtlpProbeResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const now = input.now ?? Date.now();
  const sessionId = input.sessionId ?? `ses_otlp_probe_${now}`;
  const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
  const base = input.endpoint.replace(/\/+$/, "");
  const headers = {
    "Content-Type": "application/json",
    ...authHeaders(input.authToken),
  };

  const postJson = async (
    pathname: string,
    body: unknown,
  ): Promise<Response> => {
    const res = await fetchImpl(`${base}${pathname}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    if (!res.ok)
      throw new Error(
        `crumbtrail OTLP probe ${pathname} returned HTTP ${res.status}`,
      );
    return res;
  };

  await postJson("/api/session/start", {
    sessionId,
    metadata: { app: "crumbtrail-doctor", probe: "otlp" },
  });
  await postJson("/v1/traces", {
    resourceSpans: [
      {
        resource: {
          attributes: [
            {
              key: "service.name",
              value: { stringValue: "crumbtrail-doctor" },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId,
                spanId: "00f067aa0ba902b7",
                name: "GET /__crumbtrail/otlp-probe",
                kind: 2,
                startTimeUnixNano: String(now * 1_000_000),
                endTimeUnixNano: String((now + 5) * 1_000_000),
                status: {
                  code: 2,
                  message: "crumbtrail-server doctor synthetic OTLP failure",
                },
                attributes: [
                  {
                    key: "crumbtrail.session.id",
                    value: { stringValue: sessionId },
                  },
                  {
                    key: "http.response.status_code",
                    value: { intValue: 500 },
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
  await postJson("/api/session/end", { sessionId });

  const mcp = new McpServer({ outputDir: input.outputDir });
  const response = await mcp.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "getEvents",
      arguments: { sessionId, kind: "backend.otel.span" },
    },
  });
  const result = (
    response as {
      result?: { isError?: boolean; content?: Array<{ text?: string }> };
    }
  )?.result;
  if (!result || result.isError)
    throw new Error("MCP getEvents returned an error result");
  const parsed = JSON.parse(result.content?.[0]?.text ?? "[]") as unknown;
  const list: Array<{
    k?: string;
    d?: { statusCode?: string; serviceName?: string };
  }> = Array.isArray(parsed)
    ? (parsed as Array<{
        k?: string;
        d?: { statusCode?: string; serviceName?: string };
      }>)
    : ((
        parsed as {
          events?: Array<{
            k?: string;
            d?: { statusCode?: string; serviceName?: string };
          }>;
        }
      )?.events ?? []);
  const span = list.find((e) => e.k === "backend.otel.span");
  return {
    ingested: Boolean(span),
    spanStatus: span?.d?.statusCode,
    serviceName: span?.d?.serviceName,
    sessionId,
    traceId,
    spanCount: list.filter((e) => e.k === "backend.otel.span").length,
  };
}

export interface DoctorConfig {
  host: string;
  port: number;
  output: string;
}

/** Read crumbtrail.config.json from a project, falling back to local self-host defaults. */
export function resolveDoctorConfig(
  cwd: string,
  overridePort?: number,
): DoctorConfig {
  const defaults: DoctorConfig = {
    host: "127.0.0.1",
    port: 9898,
    output: path.join(cwd, ".crumbtrail", "sessions"),
  };
  let fromFile: Partial<DoctorConfig> = {};
  const configPath = path.join(cwd, "crumbtrail.config.json");
  if (fs.existsSync(configPath)) {
    try {
      fromFile = JSON.parse(
        fs.readFileSync(configPath, "utf-8"),
      ) as Partial<DoctorConfig>;
    } catch {
      fromFile = {};
    }
  }
  return {
    host: fromFile.host ?? defaults.host,
    port: overridePort ?? fromFile.port ?? defaults.port,
    output: fromFile.output ?? defaults.output,
  };
}

async function isServerReady(
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(`${endpoint}/health`);
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; status?: string };
    return body?.ok === true && body?.status === "ready";
  } catch {
    return false;
  }
}

export interface RunDoctorInput {
  config: DoctorConfig;
  fetchImpl?: typeof fetch;
  cwd?: string;
}

export interface RunDoctorResult {
  report: DoctorReport;
  endpoint: string;
  startedServer: boolean;
}

/**
 * One-command verifier. Uses a running Crumbtrail server if one is reachable, otherwise
 * starts an ephemeral local one, then proves capture + correlation + MCP-readability.
 */
export async function runDoctor(
  input: RunDoctorInput,
): Promise<RunDoctorResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const { host, port, output } = input.config;
  const checks: DoctorCheck[] = [];
  checks.push(checkClientWiring(input.cwd ?? process.cwd()));

  fs.mkdirSync(output, { recursive: true });

  let endpoint = `http://${host}:${port}`;
  let server: http.Server | undefined;
  let startedServer = false;

  if (await isServerReady(endpoint, fetchImpl)) {
    checks.push({
      name: "server",
      status: "pass",
      detail: `using the Crumbtrail server already running at ${endpoint}`,
    });
  } else {
    try {
      server = createServer({ port, outputDir: output });
      await new Promise<void>((resolve, reject) => {
        server!.once("error", reject);
        server!.listen(port, host, () => resolve());
      });
      const addr = server.address();
      const actualPort = addr && typeof addr !== "string" ? addr.port : port;
      endpoint = `http://${host}:${actualPort}`;
      startedServer = true;
      checks.push({
        name: "server",
        status: "pass",
        detail: `started a local Crumbtrail server at ${endpoint}`,
      });
    } catch (err) {
      checks.push({
        name: "server",
        status: "fail",
        detail: `could not start a local server on ${host}:${port}: ${(err as Error).message}`,
        remediation: `free port ${port} or pass --port, then re-run \`crumbtrail-server doctor\``,
      });
      return { report: evaluateDoctor(checks), endpoint, startedServer };
    }
  }

  try {
    const probe = await probeRoundTrip({
      endpoint,
      outputDir: output,
      fetchImpl,
    });
    if (
      probe.linked &&
      probe.frontendStatus === 500 &&
      probe.backendStatus === 500
    ) {
      checks.push({
        name: "capture+correlation",
        status: "pass",
        detail: `front-end and back-end captured, time-correlated, and read back via MCP getLinkedRequestContext (session ${probe.sessionId})`,
      });
    } else {
      checks.push({
        name: "capture+correlation",
        status: "fail",
        detail: `round-trip not linked (status=${probe.correlationStatus}, frontend=${probe.frontendStatus}, backend=${probe.backendStatus})`,
        remediation:
          "check the server output directory is writable and not being cleaned mid-run",
      });
    }
  } catch (err) {
    checks.push({
      name: "capture+correlation",
      status: "fail",
      detail: (err as Error).message,
      remediation:
        "ensure the server is reachable and the output directory is writable",
    });
  }

  try {
    const otlp = await probeOtlpRoundTrip({
      endpoint,
      outputDir: output,
      fetchImpl,
    });
    if (otlp.ingested && otlp.spanStatus === "ERROR") {
      checks.push({
        name: "otlp-ingest",
        status: "pass",
        detail: `received ${otlp.spanCount} OTLP span(s) from service ${otlp.serviceName ?? "unknown"}, created session ${otlp.sessionId}, and read it back via MCP getEvents`,
      });
    } else {
      checks.push({
        name: "otlp-ingest",
        status: "fail",
        detail: `OTLP round-trip not confirmed (ingested=${otlp.ingested}, status=${otlp.spanStatus})`,
        remediation:
          "ensure POST /v1/traces is reachable and not blocked by remote/auth guards",
      });
    }
  } catch (err) {
    checks.push({
      name: "otlp-ingest",
      status: "warn",
      detail: (err as Error).message,
      remediation:
        "OTLP ingest could not be verified; native capture still works",
    });
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
  }

  checks.push(checkBrowserSessions(output));
  checks.push(
    ...(await checkEvidenceSources({ sources: evidenceSourcesFromEnv() })),
  );
  // Separate line, separate list: the spec oracle is not an evidence adapter.
  checks.push(checkSpecOracle());

  return { report: evaluateDoctor(checks), endpoint, startedServer };
}
