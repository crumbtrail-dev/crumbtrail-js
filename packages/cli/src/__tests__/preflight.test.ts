import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../net";
import {
  classifyAuthStatus,
  exitCodeFor,
  overallOk,
  parseEndpoint,
  runPreflight,
  syntheticSessionId,
  toJson,
  type AuthProbe,
  type PreflightIO,
  type StageResult,
} from "../preflight";
import { CLI_CHECK_PREFIX } from "../verify";

const okProbe: AuthProbe = { kind: "ingestKey", key: "ck_test" };

/** Base IO where every stage passes; override per test. */
function passIO(over: Partial<PreflightIO> = {}): Partial<PreflightIO> {
  let clock = 0;
  return {
    resolveDns: vi.fn(async () => undefined),
    checkTls: vi.fn(async () => undefined),
    authRoundTrip: vi.fn(async () => 200),
    // Deterministic clock: each read advances 5ms so stage ms are stable.
    now: vi.fn(() => (clock += 5)),
    ...over,
  };
}

function stage(stages: StageResult[], name: StageResult["stage"]): StageResult {
  const s = stages.find((x) => x.stage === name);
  if (!s) throw new Error(`no ${name} stage`);
  return s;
}

describe("classifyAuthStatus", () => {
  it("maps 2xx to pass and known failures to precise reasons", () => {
    expect(classifyAuthStatus(200)).toEqual({
      status: "pass",
      reason: "authenticated (HTTP 200)",
    });
    expect(classifyAuthStatus(401).status).toBe("fail");
    expect(classifyAuthStatus(401).reason).toMatch(/bad or expired/i);
    expect(classifyAuthStatus(403).reason).toMatch(/bad or expired/i);
    expect(classifyAuthStatus(404)).toEqual({
      status: "fail",
      reason: "wrong endpoint or path (HTTP 404)",
    });
    expect(classifyAuthStatus(500).reason).toMatch(/unexpected response \(HTTP 500\)/);
  });
});

describe("overallOk / exitCodeFor", () => {
  it("a skipped stage does not fail the run; a fail does", () => {
    const skipped: StageResult[] = [
      { stage: "dns", status: "pass", reason: "", ms: 1 },
      { stage: "tls", status: "skipped", reason: "", ms: 0 },
      { stage: "auth", status: "pass", reason: "", ms: 1 },
    ];
    expect(overallOk(skipped)).toBe(true);
    expect(exitCodeFor({ ok: true, endpoint: "x", stages: skipped })).toBe(0);

    const failed: StageResult[] = [
      { stage: "dns", status: "pass", reason: "", ms: 1 },
      { stage: "tls", status: "fail", reason: "", ms: 1 },
    ];
    expect(overallOk(failed)).toBe(false);
    expect(exitCodeFor({ ok: false, endpoint: "x", stages: failed })).toBe(1);
  });
});

describe("parseEndpoint", () => {
  it("extracts host/port/https and defaults the port by scheme", () => {
    expect(parseEndpoint("https://api.crumbtrail.ai")).toEqual({
      host: "api.crumbtrail.ai",
      port: 443,
      isHttps: true,
    });
    expect(parseEndpoint("http://localhost:5455")).toEqual({
      host: "localhost",
      port: 5455,
      isHttps: false,
    });
    expect(parseEndpoint("not a url")).toBeNull();
  });
});

describe("syntheticSessionId", () => {
  it("carries the non-persisting cloud prefix", () => {
    expect(syntheticSessionId().startsWith(CLI_CHECK_PREFIX)).toBe(true);
  });
});

describe("runPreflight", () => {
  it("passes all three stages and records elapsed ms", async () => {
    const io = passIO();
    const result = await runPreflight({
      endpoint: "https://api.crumbtrail.ai",
      probe: okProbe,
      io,
    });
    expect(result.ok).toBe(true);
    expect(result.stages.map((s) => s.status)).toEqual(["pass", "pass", "pass"]);
    expect(stage(result.stages, "dns").ms).toBeGreaterThan(0);
    // The ingest probe exercised the SDK path against the real endpoint.
    expect(io.authRoundTrip).toHaveBeenCalledWith(
      "https://api.crumbtrail.ai",
      okProbe,
    );
  });

  it("skips TLS for a plain-http (self-host) endpoint but still runs auth", async () => {
    const io = passIO();
    const result = await runPreflight({
      endpoint: "http://localhost:5455",
      probe: okProbe,
      io,
    });
    expect(stage(result.stages, "tls").status).toBe("skipped");
    expect(stage(result.stages, "auth").status).toBe("pass");
    expect(result.ok).toBe(true);
    expect(io.checkTls).not.toHaveBeenCalled();
  });

  it("fails DNS and short-circuits TLS + auth (no wasted network)", async () => {
    const io = passIO({
      resolveDns: vi.fn(async () => {
        throw new Error("ENOTFOUND");
      }),
    });
    const result = await runPreflight({
      endpoint: "https://this-host-does-not-exist.invalid",
      probe: okProbe,
      io,
    });
    expect(result.ok).toBe(false);
    expect(stage(result.stages, "dns").status).toBe("fail");
    expect(stage(result.stages, "dns").reason).toMatch(
      /DNS did not resolve for this-host-does-not-exist\.invalid/,
    );
    expect(stage(result.stages, "tls").status).toBe("skipped");
    expect(stage(result.stages, "auth").status).toBe("skipped");
    expect(io.checkTls).not.toHaveBeenCalled();
    expect(io.authRoundTrip).not.toHaveBeenCalled();
  });

  it("fails TLS on a cert/host mismatch and skips auth", async () => {
    const io = passIO({
      checkTls: vi.fn(async () => {
        throw new Error(
          "Hostname/IP does not match certificate's altnames: Host: api.crumbtrail.ai. is not in the cert's altnames",
        );
      }),
    });
    const result = await runPreflight({
      endpoint: "https://api.crumbtrail.ai",
      probe: okProbe,
      io,
    });
    expect(result.ok).toBe(false);
    expect(stage(result.stages, "tls").status).toBe("fail");
    expect(stage(result.stages, "tls").reason).toMatch(/does not match certificate/);
    expect(stage(result.stages, "auth").status).toBe("skipped");
    expect(io.authRoundTrip).not.toHaveBeenCalled();
  });

  it("reports a bad key as an auth FAIL from the 401 status", async () => {
    const io = passIO({
      authRoundTrip: vi.fn(async () => {
        throw new ApiError("nope", { status: 401 });
      }),
    });
    const result = await runPreflight({
      endpoint: "https://api.crumbtrail.ai",
      probe: okProbe,
      io,
    });
    expect(result.ok).toBe(false);
    expect(stage(result.stages, "auth").reason).toMatch(/bad or expired ingest key/i);
  });

  it("reports a wrong path as an auth FAIL from the 404 status", async () => {
    const io = passIO({
      authRoundTrip: vi.fn(async () => {
        throw new ApiError("nope", { status: 404 });
      }),
    });
    const result = await runPreflight({
      endpoint: "https://api.crumbtrail.ai",
      probe: okProbe,
      io,
    });
    expect(stage(result.stages, "auth").reason).toMatch(/wrong endpoint or path/i);
  });

  it("reports a transport failure (no HTTP status) as an auth FAIL", async () => {
    const io = passIO({
      authRoundTrip: vi.fn(async () => {
        throw new Error("connect ECONNREFUSED");
      }),
    });
    const result = await runPreflight({
      endpoint: "https://api.crumbtrail.ai",
      probe: okProbe,
      io,
    });
    expect(stage(result.stages, "auth").status).toBe("fail");
    expect(stage(result.stages, "auth").reason).toMatch(/could not reach/i);
  });

  it("fails DNS with a clear reason for an unparseable endpoint", async () => {
    const result = await runPreflight({
      endpoint: "http://",
      probe: okProbe,
      io: passIO(),
    });
    expect(result.ok).toBe(false);
    expect(stage(result.stages, "dns").reason).toMatch(/invalid endpoint URL/);
  });

  it("fails auth with a timeout reason (not a generic network error) when the round-trip hangs", async () => {
    vi.useFakeTimers();
    // A fetch that only settles when the abort signal fires — so the real
    // AbortController+timer in realAuthRoundTrip is what ends the hang.
    const abortableFetch = vi.fn((_url: string, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("The operation was aborted");
          e.name = "AbortError";
          reject(e);
        });
      });
    }) as unknown as typeof fetch;
    try {
      const resultPromise = runPreflight({
        endpoint: "https://api.crumbtrail.ai",
        probe: okProbe,
        // Only DNS/TLS/clock are stubbed; authRoundTrip stays REAL so the timer
        // under test actually runs against the hanging fetch.
        io: {
          resolveDns: async () => undefined,
          checkTls: async () => undefined,
          now: () => Date.now(),
        },
        fetchImpl: abortableFetch,
      });
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resultPromise;
      expect(result.ok).toBe(false);
      expect(stage(result.stages, "auth").status).toBe("fail");
      expect(stage(result.stages, "auth").reason).toMatch(
        /auth check timed out after 10s/i,
      );
      expect(stage(result.stages, "auth").reason).not.toMatch(/could not reach/i);
      expect(exitCodeFor(result)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a missing credential truthfully, not as a bad-key 401", async () => {
    // Real authRoundTrip (no fetchImpl needed — the `none` path throws before
    // any network call).
    const result = await runPreflight({
      endpoint: "https://api.crumbtrail.ai",
      probe: { kind: "none" },
      io: {
        resolveDns: async () => undefined,
        checkTls: async () => undefined,
        now: () => Date.now(),
      },
    });
    expect(result.ok).toBe(false);
    const auth = stage(result.stages, "auth");
    expect(auth.status).toBe("fail");
    expect(auth.reason).toMatch(/no ingest key or token provided/i);
    expect(auth.reason).not.toMatch(/bad or expired/i);
    expect(exitCodeFor(result)).toBe(1);
  });
});

describe("toJson", () => {
  it("emits a stable, machine-readable shape for CI", () => {
    const result = {
      ok: false,
      endpoint: "https://api.crumbtrail.ai",
      stages: [
        { stage: "dns" as const, status: "pass" as const, reason: "resolved", ms: 3 },
        { stage: "tls" as const, status: "fail" as const, reason: "bad cert", ms: 9 },
      ],
    };
    expect(toJson(result)).toEqual({
      ok: false,
      endpoint: "https://api.crumbtrail.ai",
      stages: [
        { stage: "dns", status: "pass", reason: "resolved", ms: 3 },
        { stage: "tls", status: "fail", reason: "bad cert", ms: 9 },
      ],
    });
  });
});
