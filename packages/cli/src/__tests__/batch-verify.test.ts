import { describe, expect, it } from "vitest";
import { executePlan } from "../inject/executor";
import { otlpGuidePlan, renderOtlpGuide } from "../otlp-guide";
import { uniqueServiceNames } from "../provision";
import {
  pollForServices,
  realSessionsByService,
  type SessionRow,
} from "../verify";
import { memExecutorIO } from "./helpers";

const silentUi = { out: () => {}, err: () => {} };

describe("realSessionsByService", () => {
  const rows: SessionRow[] = [
    // Newest first, as the cloud returns them.
    {
      id: "sess-api-2",
      serviceId: "svc-api",
      startedAt: "2026-07-11T10:05:00Z",
    },
    {
      id: "sess-api-1",
      serviceId: "svc-api",
      startedAt: "2026-07-11T10:01:00Z",
    },
    {
      id: "sess-web-1",
      serviceId: "svc-web",
      startedAt: "2026-07-11T10:02:00Z",
    },
  ];

  it("attributes the first real session to each service", () => {
    const found = realSessionsByService(rows);
    // Earliest qualifying session per service wins — the one the user just caused.
    expect(found.get("svc-api")).toBe("sess-api-1");
    expect(found.get("svc-web")).toBe("sess-web-1");
  });

  it("ignores synthetic cli-check sessions", () => {
    const found = realSessionsByService([
      {
        id: "cli-check-abc",
        serviceId: "svc-api",
        startedAt: "2026-07-11T10:00:00Z",
      },
    ]);
    expect(found.size).toBe(0);
  });

  it("ignores rows the cloud didn't attribute to a service", () => {
    const found = realSessionsByService([
      { id: "sess-x", serviceId: null, startedAt: "2026-07-11T10:00:00Z" },
    ]);
    expect(found.size).toBe(0);
  });

  it("ignores sessions from before this run — a stale one is not 'your first event'", () => {
    const wizardStart = Date.parse("2026-07-11T10:03:00Z");
    const found = realSessionsByService(rows, wizardStart);
    expect(found.get("svc-api")).toBe("sess-api-2"); // 10:05, after start
    expect(found.has("svc-web")).toBe(false); // 10:02, before start
  });
});

describe("pollForServices", () => {
  const noSleep = async () => {};

  /** A fetch that returns a different sessions page on each successive call. */
  function stagedFetch(pages: SessionRow[][]): typeof fetch {
    let call = 0;
    return (async () => {
      const sessions = pages[Math.min(call++, pages.length - 1)];
      return new Response(JSON.stringify({ sessions }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
  }

  it("ticks each service off as its event lands, and finishes when all report", async () => {
    const seen: string[] = [];
    const res = await pollForServices({
      base: "http://x",
      token: "t",
      projectId: "p1",
      ui: silentUi,
      serviceIds: ["svc-web", "svc-api"],
      onFound: (serviceId) => seen.push(serviceId),
      sleepFn: noSleep,
      fetchImpl: stagedFetch([
        [], // nothing yet
        [{ id: "s-web", serviceId: "svc-web" }], // web reports
        [
          { id: "s-web", serviceId: "svc-web" },
          { id: "s-api", serviceId: "svc-api" }, // api follows
        ],
      ]),
    });

    expect(res.outcome).toBe("found");
    expect(res.found).toEqual({ "svc-web": "s-web", "svc-api": "s-api" });
    // Each service is announced exactly once, even though web appears in two pages.
    expect(seen).toEqual(["svc-web", "svc-api"]);
  });

  it("times out with a PARTIAL map rather than blocking on a straggler", async () => {
    const res = await pollForServices({
      base: "http://x",
      token: "t",
      projectId: "p1",
      ui: silentUi,
      serviceIds: ["svc-web", "svc-api"],
      sleepFn: noSleep,
      // Tight budget so the state machine gives up quickly.
      config: { initialDelayMs: 1000, maxDelayMs: 1000, timeoutMs: 3000 },
      fetchImpl: stagedFetch([[{ id: "s-web", serviceId: "svc-web" }]]),
    });

    expect(res.outcome).toBe("timedout");
    // The service that DID report is still reported — a straggler doesn't erase it.
    expect(res.found).toEqual({ "svc-web": "s-web" });
  });

  it("returns what it has when the user hits Ctrl-C", async () => {
    const controller = new AbortController();
    const res = await pollForServices({
      base: "http://x",
      token: "t",
      projectId: "p1",
      ui: silentUi,
      serviceIds: ["svc-web"],
      signal: controller.signal,
      sleepFn: async () => {
        controller.abort();
      },
      fetchImpl: stagedFetch([[]]),
    });
    expect(res.outcome).toBe("cancelled");
    expect(res.found).toEqual({});
  });

  it("keeps polling through a transient read failure", async () => {
    let call = 0;
    const flaky = (async () => {
      call += 1;
      if (call === 1) throw new Error("ECONNRESET");
      return new Response(
        JSON.stringify({ sessions: [{ id: "s1", serviceId: "svc-web" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await pollForServices({
      base: "http://x",
      token: "t",
      projectId: "p1",
      ui: silentUi,
      serviceIds: ["svc-web"],
      sleepFn: noSleep,
      fetchImpl: flaky,
    });
    expect(res.outcome).toBe("found");
  });
});

describe("uniqueServiceNames", () => {
  it("de-collides two services that infer to the same name", () => {
    expect(
      uniqueServiceNames([
        { name: "web", relDir: "apps/web" },
        { name: "web", relDir: "apps/marketing" },
      ]),
      // First claimant keeps the plain name; the second falls back to its dir.
    ).toEqual(["web", "marketing"]);
  });

  it("leaves already-distinct names alone", () => {
    expect(
      uniqueServiceNames([
        { name: "web", relDir: "apps/web" },
        { name: "api", relDir: "services/api" },
      ]),
    ).toEqual(["web", "api"]);
  });

  it("falls back to the full path when the basename also collides", () => {
    const names = uniqueServiceNames([
      { name: "api", relDir: "apps/api" },
      { name: "api", relDir: "services/api" },
    ]);
    expect(names[0]).toBe("api");
    expect(names[1]).toBe("services-api");
    expect(new Set(names).size).toBe(2);
  });
});

describe("otlp guide", () => {
  const guide = () =>
    renderOtlpGuide({
      stack: "rails",
      serviceName: "payments",
      endpoint: "https://cloud.crumbtrail.ai",
      snippet:
        "OTEL_EXPORTER_OTLP_ENDPOINT=https://cloud.crumbtrail.ai/v1/traces",
      agentPrompt: "Wire this Rails app's OTLP exporter to Crumbtrail.",
    });

  it("carries the stack, endpoint, snippet, prompt, and a key warning", () => {
    const body = guide();
    expect(body).toContain("rails");
    expect(body).toContain("payments");
    expect(body).toContain("OTEL_EXPORTER_OTLP_ENDPOINT");
    expect(body).toContain("Wire this Rails app's OTLP exporter");
    // The key lands in a repo file — saying so is not optional.
    expect(body).toContain("not");
    expect(body.toLowerCase()).toContain("secret store");
  });

  it("writes the guide into the service dir via the normal executor", () => {
    const { io, files } = memExecutorIO();
    const res = executePlan(
      otlpGuidePlan("/repo/services/payments", guide()),
      io,
    );
    expect(res.written).toEqual(["/repo/services/payments/CRUMBTRAIL-OTLP.md"]);
    expect(files["/repo/services/payments/CRUMBTRAIL-OTLP.md"]).toContain(
      "rails",
    );
  });

  it("refuses to clobber an existing guide", () => {
    const existing = "# my hand-edited notes";
    const { io, files } = memExecutorIO({
      "/repo/svc/CRUMBTRAIL-OTLP.md": existing,
    });
    expect(() =>
      executePlan(otlpGuidePlan("/repo/svc", guide()), io),
    ).toThrowError(/refusing to overwrite/i);
    // Rollback leaves the user's file byte-identical.
    expect(files["/repo/svc/CRUMBTRAIL-OTLP.md"]).toBe(existing);
  });
});
