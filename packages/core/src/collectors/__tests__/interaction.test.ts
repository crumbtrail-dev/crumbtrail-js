import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../../event-bus";
import { BROWSER_REDACTION_POLICY } from "../../redaction";
import { maskText } from "../../masking";
import {
  DEFAULT_CONFIG,
  type BugEvent,
  type CrumbtrailConfig,
} from "../../types";
import { interactionCollector } from "../interaction";

describe("interactionCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    // Flush and discard the initial nav event
    bus.flush();
    events.length = 0;
  });

  afterEach(() => {
    cleanup();
  });

  // --- Initial nav ---
  it("emits initial nav event on setup", () => {
    cleanup();
    const initEvents: BugEvent[] = [];
    const initBus = new EventBus();
    initBus.subscribe((batch) => initEvents.push(...batch));
    const initCleanup = interactionCollector(initBus, DEFAULT_CONFIG);
    initBus.flush();

    expect(initEvents).toHaveLength(1);
    expect(initEvents[0].k).toBe("nav");
    expect(initEvents[0].d.tr).toBe("init");
    expect(initEvents[0].d.to).toBe(window.location.href);
    expect(initEvents[0].d.from).toBe("");

    initCleanup();
    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;
  });

  // --- Clicks ---
  it("captures click events with element descriptor", () => {
    const button = document.createElement("button");
    button.id = "submit-btn";
    button.textContent = "Submit";
    document.body.appendChild(button);

    button.click();
    bus.flush();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("clk");
    expect(events[0].d.el).toEqual(
      expect.objectContaining({ tag: "BUTTON", id: "submit-btn" }),
    );
    expect(events[0].d.pos).toBeDefined();

    document.body.removeChild(button);
  });

  it("skips clicks on elements matching ignoreSelectors", () => {
    cleanup();
    const config: CrumbtrailConfig = {
      ...DEFAULT_CONFIG,
      ignoreSelectors: [".ignored"],
    };
    cleanup = interactionCollector(bus, config);
    bus.flush();
    events.length = 0;

    const el = document.createElement("div");
    el.className = "ignored";
    document.body.appendChild(el);
    el.click();
    bus.flush();

    const clicks = events.filter((e) => e.k === "clk");
    expect(clicks).toHaveLength(0);

    document.body.removeChild(el);
  });

  it("uses configured safe descriptors and propagates descriptor redaction metadata", () => {
    cleanup();
    const descriptorRedaction = {
      policy: BROWSER_REDACTION_POLICY,
      fields: [
        {
          path: "el.txt",
          reason: "element_text_too_long",
          action: "summarized" as const,
        },
      ],
    };
    const config: CrumbtrailConfig = {
      ...DEFAULT_CONFIG,
      describeInteractionElement: () => ({
        tag: "BUTTON",
        selector: "#checkout",
        xpath: '//*[@id="checkout"]',
        redaction: descriptorRedaction,
      }),
    };
    cleanup = interactionCollector(bus, config);
    bus.flush();
    events.length = 0;

    const button = document.createElement("button");
    button.id = "checkout";
    document.body.appendChild(button);
    button.click();
    bus.flush();

    const click = events.find((event) => event.k === "clk");
    expect(click?.d.el).toMatchObject({
      selector: "#checkout",
      xpath: '//*[@id="checkout"]',
    });
    expect(click?.d.redaction).toEqual(descriptorRedaction);

    document.body.removeChild(button);
  });

  // --- Input ---
  it("captures input events with redacted value metadata", () => {
    const input = document.createElement("input");
    input.type = "text";
    input.name = "username";
    document.body.appendChild(input);

    input.value = "alice";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inpEvents = events.filter((e) => e.k === "inp");
    expect(inpEvents).toHaveLength(1);
    expect(inpEvents[0].d.val).toBe(maskText("alice"));
    expect(inpEvents[0].d.valSummary).toMatchObject({
      kind: "input",
      action: "redacted",
      reason: "input_value",
    });
    expect(inpEvents[0].d.redaction).toMatchObject({
      policy: BROWSER_REDACTION_POLICY,
      fields: [
        expect.objectContaining({
          path: "val",
          reason: "input_value",
          action: "redacted",
        }),
      ],
    });
    expect(inpEvents[0].d.ev).toBe("input");
    expect((inpEvents[0].d.el as Record<string, unknown>).name).toBe(
      "username",
    );

    document.body.removeChild(input);
  });

  it("masks password input values with sensitive redaction metadata", () => {
    const input = document.createElement("input");
    input.type = "password";
    document.body.appendChild(input);

    input.value = "secret123";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inpEvents = events.filter((e) => e.k === "inp");
    expect(inpEvents[0].d.val).toBe(maskText("secret123"));
    expect(inpEvents[0].d.valSummary).toMatchObject({
      reason: "sensitive_input_value",
    });
    expect(JSON.stringify(inpEvents[0].d)).not.toContain("secret123");

    document.body.removeChild(input);
  });

  // --- Navigation via pushState ---
  it("captures pushState navigation", () => {
    history.pushState({}, "", "/test-page");
    bus.flush();

    const navEvents = events.filter((e) => e.k === "nav");
    expect(navEvents).toHaveLength(1);
    expect(navEvents[0].d.tr).toBe("push");
    expect(navEvents[0].d.to).toContain("/test-page");
  });

  it("captures replaceState navigation", () => {
    history.replaceState({}, "", "/replaced");
    bus.flush();

    const navEvents = events.filter((e) => e.k === "nav");
    expect(navEvents).toHaveLength(1);
    expect(navEvents[0].d.tr).toBe("replace");
    expect(navEvents[0].d.to).toContain("/replaced");
  });

  // --- Cleanup ---
  it("restores history.pushState on cleanup", () => {
    cleanup();

    history.pushState({}, "", "/after-cleanup");
    bus.flush();
    const navEvents = events.filter((e) => e.k === "nav");
    expect(navEvents).toHaveLength(0);

    cleanup = interactionCollector(bus, DEFAULT_CONFIG);
    bus.flush();
    events.length = 0;
  });
});
