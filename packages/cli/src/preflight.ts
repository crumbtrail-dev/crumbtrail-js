// Synthetic preflight for `crumbtrail verify` — a fast, staged PASS/FAIL probe of
// a deployment's config, NOT a traffic poll (that's verify.ts). Each stage does
// the least work that proves one thing and reports its own reason + elapsed ms:
//
//   DNS  — the endpoint host resolves at all.
//   TLS  — the certificate is actually valid FOR THIS HOST. This is the stage
//          that instantly catches a `*.up.railway.app`-style cert/host mismatch:
//          we open a real TLS socket with `servername` set and
//          `rejectUnauthorized: true`, so a hostname/altname mismatch surfaces as
//          a cert FAIL, not a vague network error.
//   Auth — a real authenticated round-trip on the SAME path the SDK uses
//          (`POST /api/session/start`) with a synthetic `cli-check-` session id
//          the cloud recognizes and refuses to persist, so the probe never
//          creates a dashboard session. Without an ingest key we fall back to the
//          least-invasive authenticated GET (`/api/sessions`) using the cached
//          login token, which still proves auth + endpoint.
//
// Everything here is pure or injectable so the result-shaping (per-stage
// PASS/FAIL/SKIPPED, exit-code mapping, JSON shape, 401/404 reason strings) is
// unit-testable without a network, DNS, or TLS stack.

import { lookup as dnsLookup } from "node:dns";
import { promisify } from "node:util";
import tls from "node:tls";
import { randomUUID } from "node:crypto";
import { ApiError, requestJson } from "./net";
import { CLI_CHECK_PREFIX } from "./verify";

export type StageName = "dns" | "tls" | "auth";
export type StageStatus = "pass" | "fail" | "skipped";

/**
 * Per-stage network timeout guard, shared by TLS and the auth round-trip. A
 * `verify` run is a fast CI pre-deploy gate — it must never hang on a
 * black-holed socket or a hung ingest endpoint, so every stage that opens a
 * connection abandons it after this budget and reports a timeout FAIL.
 */
export const PREFLIGHT_STAGE_TIMEOUT_MS = 10_000;

/**
 * The auth round-trip exceeded PREFLIGHT_STAGE_TIMEOUT_MS. Distinct from a
 * transport error so the auth stage can report "timed out" — not a vague
 * network failure — for a hung endpoint.
 */
export class AuthTimeoutError extends Error {
  constructor(readonly ms: number = PREFLIGHT_STAGE_TIMEOUT_MS) {
    super(`auth check timed out after ${Math.round(ms / 1000)}s`);
    this.name = "AuthTimeoutError";
  }
}

/**
 * No credential was supplied for the auth stage. Distinct from a genuine 401 so
 * the reason is truthful ("no key provided") rather than misleading ("bad key").
 */
export class NoCredentialError extends Error {
  constructor() {
    super(
      "no ingest key or token provided (pass --key or set CRUMBTRAIL_KEY)",
    );
    this.name = "NoCredentialError";
  }
}

export interface StageResult {
  stage: StageName;
  status: StageStatus;
  /** Human reason for the status — the exact failing cause on a FAIL. */
  reason: string;
  /** Wall-clock ms the stage took (0 for a stage that was skipped without work). */
  ms: number;
}

export interface PreflightResult {
  /** True iff no stage FAILED (skipped stages don't fail the run). */
  ok: boolean;
  /** The resolved API base the probe targeted. */
  endpoint: string;
  stages: StageResult[];
}

/**
 * The credential the auth stage probes with. An ingest key exercises the SDK's
 * own ingest path (`x-crumbtrail-auth` → session/start); a bearer token is the
 * cached-login fallback that proves auth + endpoint via the dashboard GET.
 */
export type AuthProbe =
  | { kind: "ingestKey"; key: string }
  | { kind: "bearer"; token: string; projectId?: string }
  | { kind: "none" };

// ── Pure result shaping (unit-tested directly) ───────────────────────────────

/**
 * Map an auth round-trip's HTTP status to a stage result. 2xx = PASS; 401/403 =
 * bad/expired key; 404 = wrong endpoint/path; anything else surfaces the status.
 */
export function classifyAuthStatus(status: number): {
  status: StageStatus;
  reason: string;
} {
  if (status >= 200 && status < 300) {
    return { status: "pass", reason: `authenticated (HTTP ${status})` };
  }
  if (status === 401 || status === 403) {
    return { status: "fail", reason: `bad or expired ingest key (HTTP ${status})` };
  }
  if (status === 404) {
    return { status: "fail", reason: "wrong endpoint or path (HTTP 404)" };
  }
  return { status: "fail", reason: `unexpected response (HTTP ${status})` };
}

/** A run is OK iff nothing FAILED — a SKIPPED stage never fails the run. */
export function overallOk(stages: StageResult[]): boolean {
  return stages.every((s) => s.status !== "fail");
}

/** CI exit code: 0 when all runnable stages pass, non-zero on any FAIL. */
export function exitCodeFor(result: PreflightResult): number {
  return result.ok ? 0 : 1;
}

/** Machine-readable shape for `--json`. Stable field order for CI diffing. */
export function toJson(result: PreflightResult): {
  ok: boolean;
  endpoint: string;
  stages: StageResult[];
} {
  return {
    ok: result.ok,
    endpoint: result.endpoint,
    stages: result.stages.map((s) => ({
      stage: s.stage,
      status: s.status,
      reason: s.reason,
      ms: s.ms,
    })),
  };
}

/** Parse a base URL into the host/port/protocol the DNS + TLS stages need. */
export function parseEndpoint(base: string): {
  host: string;
  port: number;
  isHttps: boolean;
} | null {
  try {
    const u = new URL(base);
    const isHttps = u.protocol === "https:";
    const port = u.port ? Number(u.port) : isHttps ? 443 : 80;
    if (!u.hostname || !Number.isFinite(port)) return null;
    return { host: u.hostname, port, isHttps };
  } catch {
    return null;
  }
}

// ── Injectable IO (real impls below; tests substitute fakes) ─────────────────

export interface PreflightIO {
  /** Resolve `host` to an address; reject on failure. */
  resolveDns: (host: string) => Promise<void>;
  /**
   * Open a TLS connection to host:port with SNI + full cert verification. Reject
   * with the cert error on a hostname/altname or trust-chain mismatch.
   */
  checkTls: (host: string, port: number) => Promise<void>;
  /**
   * Perform the authenticated round-trip for `probe`. Resolve with the HTTP
   * status on a response; throw ApiError (has `.status`) for a non-2xx, or any
   * other error for a transport failure (no status reached).
   */
  authRoundTrip: (base: string, probe: AuthProbe) => Promise<number>;
  /** Monotonic-ish clock for stage timing (injectable for deterministic tests). */
  now: () => number;
}

const lookupAsync = promisify(dnsLookup);

function realResolveDns(host: string): Promise<void> {
  return lookupAsync(host).then(() => undefined);
}

function realCheckTls(host: string, port: number): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const socket = tls.connect(
      { host, port, servername: host, rejectUnauthorized: true },
      () => {
        // We only reach the secureConnect callback when the cert verified AND
        // matched `servername` (rejectUnauthorized aborts before this otherwise).
        socket.end();
        resolve();
      },
    );
    socket.setTimeout(PREFLIGHT_STAGE_TIMEOUT_MS, () => {
      socket.destroy();
      reject(
        new Error(
          `TLS connection timed out after ${Math.round(PREFLIGHT_STAGE_TIMEOUT_MS / 1000)}s`,
        ),
      );
    });
    socket.on("error", (err) => {
      socket.destroy();
      reject(err);
    });
  });
}

/** Build the synthetic, non-persisting session id used for the ingest probe. */
export function syntheticSessionId(): string {
  return `${CLI_CHECK_PREFIX}${randomUUID()}`;
}

function realAuthRoundTrip(
  fetchImpl?: typeof fetch,
): (base: string, probe: AuthProbe) => Promise<number> {
  return async (base, probe) => {
    // No credential at all — a truthful "nothing was provided" failure, NOT a
    // 401 (which would misreport a missing key as a bad key). Thrown before any
    // network work, so there's no timer to arm.
    if (probe.kind === "none") {
      throw new NoCredentialError();
    }
    // Guard the round-trip with the same 10s budget the TLS stage uses: a hung
    // ingest endpoint must not hang the fast PASS/FAIL gate. We reuse net.ts's
    // `signal` path (requestJson already forwards it to fetch) rather than a
    // parallel timeout mechanism. `timedOut` lets us translate the resulting
    // abort/NetworkError into a precise AuthTimeoutError.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, PREFLIGHT_STAGE_TIMEOUT_MS);
    try {
      if (probe.kind === "ingestKey") {
        // Same path + auth header the SDK uses (headless-session.ts). The
        // `cli-check-` prefix makes the cloud recognize and refuse to persist
        // it, so a successful probe never leaves a stray dashboard session.
        await requestJson(`${base}/api/session/start`, {
          method: "POST",
          headers: { "x-crumbtrail-auth": probe.key },
          body: {
            sessionId: syntheticSessionId(),
            metadata: { source: "cli-preflight" },
          },
          retry: false,
          fetchImpl,
          signal: controller.signal,
        });
        return 200;
      }
      // Fallback: no ingest key, so prove auth + endpoint with the least-
      // invasive authenticated GET the dashboard already exposes (verify.ts).
      const q = probe.projectId
        ? `?projectId=${encodeURIComponent(probe.projectId)}`
        : "";
      await requestJson(`${base}/api/sessions${q}`, {
        token: probe.token,
        retry: false,
        fetchImpl,
        signal: controller.signal,
      });
      return 200;
    } catch (err) {
      // The abort we triggered surfaces as an abort/NetworkError; report it as a
      // timeout, not a generic transport failure.
      if (timedOut) throw new AuthTimeoutError(PREFLIGHT_STAGE_TIMEOUT_MS);
      throw err;
    } finally {
      // Always release the timer so a fast success/failure leaves no dangling
      // handle (which would keep the process alive).
      clearTimeout(timer);
    }
  };
}

export function defaultPreflightIO(fetchImpl?: typeof fetch): PreflightIO {
  return {
    resolveDns: realResolveDns,
    checkTls: realCheckTls,
    authRoundTrip: realAuthRoundTrip(fetchImpl),
    now: () => Date.now(),
  };
}

// ── Orchestration ────────────────────────────────────────────────────────────

export interface RunPreflightOptions {
  /** Resolved, normalized API base (from resolveEndpoint). */
  endpoint: string;
  probe: AuthProbe;
  io?: Partial<PreflightIO>;
  fetchImpl?: typeof fetch;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run the staged preflight. Stages short-circuit downward — a DNS failure skips
 * TLS + auth (they can't succeed), and a TLS failure skips auth — so the report
 * names the ROOT cause once instead of a cascade of derived failures. A
 * reachable host with a bad cert always reaches (and FAILS) the TLS stage.
 */
export async function runPreflight(
  opts: RunPreflightOptions,
): Promise<PreflightResult> {
  const io: PreflightIO = { ...defaultPreflightIO(opts.fetchImpl), ...opts.io };
  const endpoint = opts.endpoint;
  const stages: StageResult[] = [];

  const timed = async (
    stage: StageName,
    run: () => Promise<{ status: StageStatus; reason: string }>,
  ): Promise<StageResult> => {
    const start = io.now();
    try {
      const out = await run();
      return { stage, ...out, ms: Math.max(0, Math.round(io.now() - start)) };
    } catch (err) {
      return {
        stage,
        status: "fail",
        reason: describeError(err),
        ms: Math.max(0, Math.round(io.now() - start)),
      };
    }
  };

  const parsed = parseEndpoint(endpoint);
  if (!parsed) {
    // Nothing downstream can run without a host — fail DNS, skip the rest.
    stages.push({
      stage: "dns",
      status: "fail",
      reason: `invalid endpoint URL: ${endpoint}`,
      ms: 0,
    });
    stages.push({ stage: "tls", status: "skipped", reason: "no host to check", ms: 0 });
    stages.push({ stage: "auth", status: "skipped", reason: "no host to check", ms: 0 });
    return { ok: false, endpoint, stages };
  }
  const { host, port, isHttps } = parsed;

  // 1) DNS
  const dns = await timed("dns", async () => {
    try {
      await io.resolveDns(host);
      return { status: "pass" as const, reason: `resolved ${host}` };
    } catch {
      return { status: "fail" as const, reason: `DNS did not resolve for ${host}` };
    }
  });
  stages.push(dns);
  if (dns.status === "fail") {
    stages.push({ stage: "tls", status: "skipped", reason: "DNS did not resolve", ms: 0 });
    stages.push({ stage: "auth", status: "skipped", reason: "DNS did not resolve", ms: 0 });
    return finalize(endpoint, stages);
  }

  // 2) TLS — https only; a plain-http self-host has no cert to check.
  let tlsFailed = false;
  if (!isHttps) {
    stages.push({
      stage: "tls",
      status: "skipped",
      reason: "endpoint is not HTTPS",
      ms: 0,
    });
  } else {
    const tlsResult = await timed("tls", async () => {
      try {
        await io.checkTls(host, port);
        return { status: "pass" as const, reason: `certificate valid for ${host}` };
      } catch (err) {
        return {
          status: "fail" as const,
          reason: `certificate invalid for ${host}: ${describeError(err)}`,
        };
      }
    });
    stages.push(tlsResult);
    tlsFailed = tlsResult.status === "fail";
  }
  if (tlsFailed) {
    stages.push({ stage: "auth", status: "skipped", reason: "TLS check failed", ms: 0 });
    return finalize(endpoint, stages);
  }

  // 3) Auth round-trip
  const auth = await timed("auth", async () => {
    try {
      const status = await io.authRoundTrip(endpoint, opts.probe);
      return classifyAuthStatus(status);
    } catch (err) {
      // Precise, self-describing failures take precedence over the generic
      // status/transport mapping: a timeout and a missing credential each carry
      // their own truthful reason.
      if (err instanceof AuthTimeoutError || err instanceof NoCredentialError) {
        return { status: "fail" as const, reason: err.message };
      }
      if (err instanceof ApiError) return classifyAuthStatus(err.status);
      // No HTTP status reached — a transport failure.
      return {
        status: "fail" as const,
        reason: `could not reach ${endpoint}: ${describeError(err)}`,
      };
    }
  });
  stages.push(auth);

  return finalize(endpoint, stages);
}

function finalize(endpoint: string, stages: StageResult[]): PreflightResult {
  return { ok: overallOk(stages), endpoint, stages };
}
