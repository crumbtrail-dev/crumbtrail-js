import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { BugEvent, TargetDescriptor } from "crumbtrail-core";
import { writeEvidenceIndex } from "../evidence-index";

describe("evidence-index mixed page evidence artifacts", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "crumbtrail-evidence-index-"),
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("renders redaction-safe timeline and search rows for mixed page evidence including performance and storage", () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    const embeddedSecret = `auth_${secret}`;
    const events = [
      {
        t: 1000,
        k: "nav",
        offsetMs: 0,
        d: { to: "https://app.example.test/cart?token=[REDACTED]" },
      },
      {
        t: 1010,
        k: "clk",
        offsetMs: 10,
        d: { el: { tag: "BUTTON", txt: "Pay now" } },
      },
      { t: 1020, k: "inp", offsetMs: 20, d: { val: "[REDACTED]" } },
      {
        t: 1030,
        k: "perf",
        offsetMs: 30,
        d: {
          metric: "res",
          entryType: "resource",
          name: `https://cdn.example.test/${embeddedSecret}/app.js?token=[REDACTED]`,
          duration: 34,
        },
      },
      {
        t: 1040,
        k: "snap",
        offsetMs: 40,
        d: {
          localStorage: { authToken: "[REDACTED]" },
          cookies: { session: "[REDACTED]" },
        },
      },
      {
        t: 1050,
        k: "net.req",
        offsetMs: 50,
        d: {
          id: "r1",
          m: "POST",
          url: "https://api.example.test/pay?token=[REDACTED]",
        },
      },
      {
        t: 1060,
        k: "net.res",
        offsetMs: 60,
        d: { id: "r1", st: 502, dur: 10 },
      },
      {
        t: 1070,
        k: "probe.error",
        offsetMs: 70,
        d: { phase: "storage-snapshot", message: "Cache API unavailable" },
      },
      {
        t: 1080,
        k: "backend.req.error",
        offsetMs: 80,
        d: { method: "GET", route: "/reset/abcd", message: "reset failed" },
      },
    ];

    const candidates = writeEvidenceIndex({
      sessionDir: tmpDir,
      events,
      index: {
        id: "ses_evidence_index",
        start: 1000,
        end: 1070,
        dur: 70,
        failedReqs: [
          {
            t: 1060,
            m: "POST",
            url: "https://api.example.test/pay?token=[REDACTED]",
            st: 502,
          },
        ],
        navs: [
          { t: 1000, to: "https://app.example.test/cart?token=[REDACTED]" },
        ],
        pageProbe: {
          errors: [
            {
              t: 1070,
              offsetMs: 70,
              phase: "storage-snapshot",
              message: "Cache API unavailable",
            },
          ],
        },
      },
    });

    const timeline = fs.readFileSync(path.join(tmpDir, "timeline.md"), "utf-8");
    const search = fs.readFileSync(path.join(tmpDir, "search.jsonl"), "utf-8");
    const candidatesMarkdown = fs.readFileSync(
      path.join(tmpDir, "CANDIDATES.md"),
      "utf-8",
    );
    const serialized = [timeline, search, candidatesMarkdown].join("\n");

    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          detector: "http_error",
          anchor: expect.objectContaining({ status: 502 }),
        }),
        expect.objectContaining({
          detector: "page_probe_failure",
          anchor: expect.objectContaining({ source: "storage-snapshot" }),
        }),
        expect.objectContaining({
          detector: "backend_request_error",
          anchor: expect.objectContaining({
            route: `/reset/${encodeURIComponent("[REDACTED]")}`,
          }),
        }),
      ]),
    );
    expect(timeline).toContain(
      "perf: performance res https://cdn.example.test/%5BREDACTED%5D/app.js?token=%5BREDACTED%5D",
    );
    expect(timeline).toContain("snap: storage/cookie snapshot; values omitted");
    expect(search).toContain("input changed; raw value omitted");
    expect(search).toContain("storage/cookie snapshot; values omitted");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(embeddedSecret);
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("card=");
    expect(serialized).not.toContain("/reset/abcd");
  });

  it("uses planned target descriptor fields in repeated-click candidates and artifacts", () => {
    const target: TargetDescriptor = {
      role: "button",
      label: "Submit order",
      testID: "submit-order",
      accessibilityId: "checkout.submit",
      componentName: "Pressable",
      routePath: "/checkout",
      ancestryHash: "rn:checkout:footer:primary",
    };
    const events: BugEvent[] = [
      {
        t: 1000,
        k: "navigation",
        offsetMs: 0,
        platform: "react-native",
        d: { to: "/checkout" },
      },
      {
        t: 1100,
        k: "clk",
        offsetMs: 100,
        platform: "react-native",
        target,
        d: { target },
      },
      {
        t: 1600,
        k: "clk",
        offsetMs: 600,
        platform: "react-native",
        target,
        d: { target },
      },
      {
        t: 2100,
        k: "clk",
        offsetMs: 1100,
        platform: "react-native",
        target,
        d: { target },
      },
    ];

    const candidates = writeEvidenceIndex({
      sessionDir: tmpDir,
      events,
      index: {
        id: "ses_planned_target_index",
        start: 1000,
        end: 2100,
        dur: 1100,
        navs: [{ t: 1000, to: "/checkout" }],
      },
    });

    const repeatedClick = candidates.find(
      (candidate) => candidate.detector === "repeated_clicks",
    );
    expect(repeatedClick).toMatchObject({
      detector: "repeated_clicks",
      title: "Repeated clicks on Submit order",
      anchor: {
        route: "/checkout",
        elementLabel: "Submit order",
        target: {
          testID: "submit-order",
          accessibilityId: "checkout.submit",
          routePath: "/checkout",
        },
      },
    });
    expect(
      fs.readFileSync(path.join(tmpDir, "candidates.jsonl"), "utf-8"),
    ).toContain('"testID":"submit-order"');
    expect(
      fs.readFileSync(
        path.join(tmpDir, "windows", `${repeatedClick!.id}.md`),
        "utf-8",
      ),
    ).toContain("click Submit order");
  });

  it("renders capped redaction-safe tab boundary timeline and gap candidates", () => {
    const secret = "sk_fake_abcdefghijklmnopqrstuvwxyz";
    const events = [
      {
        t: 2000,
        k: "tab.boundary",
        offsetMs: 0,
        d: {
          decision: "follow",
          reason: "same_origin",
          capture: true,
          nonCapture: false,
          root: { origin: "https://app.example.test/root?token=secret" },
          current: { origin: "https://app.example.test/current?token=secret" },
          candidate: { origin: "https://app.example.test/next?token=secret" },
          prompt: {
            outcome: "approved",
            origin: "https://app.example.test/next?token=secret",
          },
        },
      },
      {
        t: 2010,
        k: "tab.boundary",
        offsetMs: 10,
        d: {
          decision: "prompt",
          reason: "outside_boundary",
          capture: false,
          nonCapture: true,
          candidate: {
            origin: "https://evil.example.test/private?token=secret",
            host: "evil.example.test/private?token=secret",
          },
          prompt: {
            outcome: "pending",
            origin: "https://evil.example.test/private?token=secret",
          },
          rawDeniedUrl: `https://evil.example.test/private?token=${secret}#frag`,
        },
      },
      {
        t: 2020,
        k: "tab.boundary",
        offsetMs: 20,
        d: {
          decision: "pause",
          reason: "user_denied_origin",
          capture: false,
          nonCapture: true,
          candidate: { origin: "https://deny.example.test/pay?card=secret" },
          prompt: {
            outcome: "denied",
            origin: "https://deny.example.test/pay?card=secret",
          },
        },
      },
      {
        t: 2030,
        k: "tab.boundary",
        offsetMs: 30,
        d: {
          decision: "ignore",
          reason: "candidate_scheme_restricted",
          capture: false,
          nonCapture: true,
          candidate: {
            scheme: "chrome-extension",
            url: `chrome-extension://abc/private?token=${secret}`,
          },
        },
      },
    ];

    const candidates = writeEvidenceIndex({
      sessionDir: tmpDir,
      events,
      index: {
        id: "ses_boundary_index",
        start: 2000,
        end: 2030,
        dur: 30,
        navs: [],
        tabBoundaries: events.map((event) => ({
          t: event.t,
          offsetMs: event.offsetMs,
          decision: String(event.d.decision),
          reason: String(event.d.reason),
          capture: event.d.capture as boolean,
          nonCapture: event.d.nonCapture as boolean,
        })),
      },
    });

    const timeline = fs.readFileSync(path.join(tmpDir, "timeline.md"), "utf-8");
    const search = fs.readFileSync(path.join(tmpDir, "search.jsonl"), "utf-8");
    const candidatesMarkdown = fs.readFileSync(
      path.join(tmpDir, "CANDIDATES.md"),
      "utf-8",
    );
    const serialized = [
      timeline,
      search,
      candidatesMarkdown,
      fs.readFileSync(path.join(tmpDir, "candidates.jsonl"), "utf-8"),
    ].join("\n");

    expect(
      candidates.filter(
        (candidate) => candidate.detector === "tab_boundary_gap",
      ),
    ).toHaveLength(3);
    expect(timeline).toContain("tab.boundary");
    expect(serialized).toContain("outside_boundary");
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("/private");
    expect(serialized).not.toContain("/pay");
    expect(serialized).not.toContain("card=");
  });

  it("keeps an HTTP error anchor and its request-response pair above boot noise", () => {
    const bootNoise: BugEvent[] = Array.from({ length: 125 }, (_, index) => ({
      t: index * 56,
      k: ["stor", "cookie", "perf", "hb"][index % 4],
      offsetMs: index * 56,
      d: { name: `boot-${index}` },
    }));
    const events: BugEvent[] = [
      ...bootNoise,
      {
        t: 7177,
        k: "net.req",
        offsetMs: 7177,
        d: {
          id: "send-file",
          m: "POST",
          url: "https://api.example.test/jobs/sendFile",
        },
      },
      {
        t: 7598,
        k: "net.res",
        offsetMs: 7598,
        d: { id: "send-file", st: 500, dur: 421 },
      },
      {
        t: 7700,
        k: "con",
        offsetMs: 7700,
        d: { lv: "error", msg: "Upload failed" },
      },
    ];

    const candidates = writeEvidenceIndex({
      sessionDir: tmpDir,
      events,
      index: {
        id: "ses_anchor_centered_window",
        start: 0,
        end: 7700,
        dur: 7700,
        failedReqs: [
          {
            t: 7598,
            m: "POST",
            url: "https://api.example.test/jobs/sendFile",
            st: 500,
          },
        ],
      },
    });
    const candidate = candidates.find(
      (entry) => entry.detector === "http_error",
    );
    const window = fs.readFileSync(
      path.join(tmpDir, "windows", `${candidate!.id}.md`),
      "utf-8",
    );
    const compactTimeline = window.split("## Network summaries", 1)[0];
    const compactEventLines = compactTimeline.match(/^- \d+ ms /gm) ?? [];
    const lowSignalLines =
      compactTimeline.match(/^- .* (?:stor|cookie|perf|hb):/gm) ?? [];

    expect(candidate).toBeDefined();
    expect(window).toContain(
      "- Candidate: HTTP 500 from POST https://api.example.test/jobs/sendFile",
    );
    expect(compactTimeline).toContain(
      "7177 ms net.req: request POST https://api.example.test/jobs/sendFile",
    );
    expect(compactTimeline).toContain(
      "7598 ms net.res: response send-file status 500 dur 421 ms",
    );
    expect(compactEventLines).toHaveLength(120);
    expect(lowSignalLines.length).toBeGreaterThan(18);
  });

  it("keeps a rejection anchor when another event shares its timestamp", () => {
    const anchorTime = 10_000;
    const events: BugEvent[] = [
      ...Array.from({ length: 36 }, (_, index) => ({
        t: anchorTime,
        k: "con",
        offsetMs: anchorTime,
        d: { lv: "error", msg: `competing console error ${index}` },
      })),
      {
        t: anchorTime,
        k: "rej",
        offsetMs: anchorTime,
        d: { msg: "the rejection anchor" },
      },
      ...Array.from({ length: 90 }, (_, index) => ({
        t: anchorTime + index + 1,
        k: "stor",
        offsetMs: anchorTime + index + 1,
        d: { key: `noise-${index}` },
      })),
    ];

    const candidates = writeEvidenceIndex({
      sessionDir: tmpDir,
      events,
      index: {
        id: "ses_rejection_anchor",
        start: anchorTime,
        end: anchorTime + 90,
        dur: 90,
        errs: [{ t: anchorTime, msg: "the rejection anchor" }],
      },
    });
    const candidate = candidates.find(
      (entry) => entry.detector === "unhandled_rejection",
    );
    const window = fs.readFileSync(
      path.join(tmpDir, "windows", `${candidate!.id}.md`),
      "utf-8",
    );
    const compactTimeline = window.split("## Network summaries", 1)[0];

    expect(candidate).toBeDefined();
    expect(compactTimeline).toContain(
      "10000 ms rej: rej: the rejection anchor",
    );
  });

  it("renders every event in a non-overflowing window despite per-kind quotas", () => {
    const anchorTime = 10_000;
    const events: BugEvent[] = [
      ...Array.from({ length: 40 }, (_, index) => ({
        t: anchorTime - 60 + index,
        k: "stor",
        offsetMs: anchorTime - 60 + index,
        d: { key: `low-signal-${index}` },
      })),
      ...Array.from({ length: 20 }, (_, index) => ({
        t: anchorTime - 20 + index,
        k: "nav",
        offsetMs: anchorTime - 20 + index,
        d: { to: `/context-${index}` },
      })),
      {
        t: anchorTime,
        k: "con",
        offsetMs: anchorTime,
        d: { lv: "error", msg: "anchor console error" },
      },
    ];

    const candidates = writeEvidenceIndex({
      sessionDir: tmpDir,
      events,
      index: {
        id: "ses_non_overflowing_window",
        start: anchorTime - 60,
        end: anchorTime,
        dur: 60,
        consoleErrors: [{ t: anchorTime, msg: "anchor console error" }],
      },
    });
    const candidate = candidates.find(
      (entry) => entry.detector === "console_error",
    );
    const window = fs.readFileSync(
      path.join(tmpDir, "windows", `${candidate!.id}.md`),
      "utf-8",
    );
    const compactTimeline = window.split("## Network summaries", 1)[0];
    const compactEventLines = compactTimeline.match(/^- \d+ ms /gm) ?? [];

    expect(candidate).toBeDefined();
    expect(events.length).toBeLessThan(120);
    expect(compactEventLines).toHaveLength(events.length);
    expect(compactTimeline).toContain('"key":"low-signal-39"');
    expect(compactTimeline).toContain("navigation to /context-19");
  });

  it("caps repeated-click evidence candidates to prevent quadratic finalization growth", () => {
    const events = Array.from({ length: 900 }, (_, index) => ({
      t: 10_000 + index * 10,
      k: "clk",
      offsetMs: index * 10,
      d: { el: { tag: "BUTTON", txt: `Button ${Math.floor(index / 3)}` } },
    }));

    const candidates = writeEvidenceIndex({
      sessionDir: tmpDir,
      events,
      index: {
        id: "ses_repeated_click_cap",
        start: 10_000,
        end: 19_000,
        dur: 9_000,
      },
    });

    expect(candidates).toHaveLength(200);
    expect(
      candidates.every((candidate) => candidate.detector === "repeated_clicks"),
    ).toBe(true);
  });

  it("drops malformed event shells instead of crashing artifact generation", () => {
    const candidates = writeEvidenceIndex({
      sessionDir: tmpDir,
      events: [
        { t: "bad", k: "net.res", d: null },
        { t: 12_000, k: "net.res", d: null },
        { t: 12_010, k: "", d: { msg: "ignored" } },
      ] as any,
      index: {
        id: "ses_malformed_event_index",
        start: 12_000,
        end: 12_000,
        dur: 0,
        failedReqs: [
          {
            t: 12_000,
            m: "GET",
            url: "https://api.example.test/fail",
            st: 500,
          },
        ],
      },
    });

    const timeline = fs.readFileSync(path.join(tmpDir, "timeline.md"), "utf-8");
    const search = fs.readFileSync(path.join(tmpDir, "search.jsonl"), "utf-8");

    expect(candidates).toHaveLength(1);
    expect(timeline).toContain("net.res");
    expect(search).toContain("response status unknown");
  });

  it("omits failed-request body snippets when id-less same-ms responses are ambiguous", () => {
    const responseTime = 14_000;
    const events: BugEvent[] = [
      {
        t: responseTime,
        k: "net.res",
        d: { st: 500, body: "unrelated-response-one" },
      },
      {
        t: responseTime,
        k: "net.res",
        d: { st: 500, body: "unrelated-response-two" },
      },
    ];
    const candidates = writeEvidenceIndex({
      sessionDir: tmpDir,
      events,
      index: {
        id: "ses_ambiguous_idless_bodies",
        start: responseTime,
        end: responseTime,
        dur: 0,
        failedReqs: [
          {
            t: responseTime,
            m: "POST",
            url: "https://api.example.test/fail",
            st: 500,
          },
        ],
      },
    });
    const window = fs.readFileSync(
      path.join(tmpDir, "windows", `${candidates[0].id}.md`),
      "utf-8",
    );

    expect(window).not.toContain("## Failed request bodies");
    expect(window).not.toContain("unrelated-response-one");
    expect(window).not.toContain("unrelated-response-two");
  });
});
