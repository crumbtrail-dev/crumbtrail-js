import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventBus } from "../event-bus";
import type { BugEvent, CrumbtrailConfig } from "../types";
import { DEFAULT_CONFIG } from "../types";
import { REDACTED_VALUE } from "../redaction";
import { maskText } from "../masking";
import { interactionCollector } from "../collectors/interaction";

function makeConfig(
  overrides: Partial<CrumbtrailConfig> = {},
): CrumbtrailConfig {
  return { ...DEFAULT_CONFIG, ...overrides };
}

function collect(config?: Partial<CrumbtrailConfig>) {
  const events: BugEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((batch) => events.push(...batch));
  const cleanup = interactionCollector(bus, makeConfig(config));
  return { events, bus, cleanup };
}

describe("interactionCollector redaction", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/start");
  });

  afterEach(() => {
    document.body.innerHTML = "";
    window.history.replaceState(null, "", "/");
    vi.restoreAllMocks();
  });

  it("redacts sensitive input values while preserving safe field context", () => {
    const { events, bus, cleanup } = collect();
    bus.flush();
    events.length = 0;

    const input = document.createElement("input");
    input.type = "password";
    input.name = "sessionPassword";
    input.value = "super-secret-password";
    document.body.appendChild(input);

    input.dispatchEvent(new Event("input", { bubbles: true }));
    bus.flush();

    const inputEvent = events.find((event) => event.k === "inp");
    expect(inputEvent?.d).toMatchObject({
      val: maskText("super-secret-password"),
      ev: "input",
      valSummary: expect.objectContaining({
        kind: "input",
        reason: "sensitive_input_value",
      }),
      redaction: expect.objectContaining({
        policy: "crumbtrail.browser-redaction.v1",
      }),
    });
    expect(JSON.stringify(inputEvent)).not.toContain("super-secret-password");

    cleanup();
  });

  it("emits click, change, and submit events with safe element descriptors and no raw input values", () => {
    const { events, bus, cleanup } = collect({
      describeInteractionElement: (element) => ({
        tag: element.tagName,
        selector: 'form#checkout > input[name="cardNumber"]',
        value: "descriptor-secret",
        redaction: {
          policy: "crumbtrail.browser-redaction.v1",
          fields: [
            {
              path: "el.value",
              reason: "test_descriptor_redaction",
              action: "redacted",
            },
          ],
        },
      }),
    });
    bus.flush();
    events.length = 0;

    const form = document.createElement("form");
    form.id = "checkout";
    const input = document.createElement("input");
    input.name = "cardNumber";
    input.value = "4111111111111111";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Pay";
    form.append(input, button);
    document.body.appendChild(form);

    button.dispatchEvent(
      new MouseEvent("click", { bubbles: true, clientX: 12, clientY: 34 }),
    );
    input.dispatchEvent(new Event("change", { bubbles: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true }));
    bus.flush();

    const clickEvent = events.find((event) => event.k === "clk");
    expect(clickEvent?.d).toMatchObject({
      pos: [12, 34],
      el: expect.objectContaining({
        tag: "BUTTON",
        selector: 'form#checkout > input[name="cardNumber"]',
      }),
      redaction: expect.objectContaining({
        policy: "crumbtrail.browser-redaction.v1",
      }),
    });

    const inputEvents = events.filter((event) => event.k === "inp");
    expect(inputEvents).toHaveLength(2);
    expect(
      inputEvents.find((event) => event.d.ev === "change")?.d,
    ).toMatchObject({
      val: maskText("4111111111111111"),
      valSummary: expect.objectContaining({
        kind: "input",
        reason: "sensitive_input_value",
      }),
      redaction: expect.objectContaining({
        policy: "crumbtrail.browser-redaction.v1",
      }),
    });
    expect(
      inputEvents.find((event) => event.d.ev === "submit")?.d,
    ).toMatchObject({
      val: "",
      el: expect.objectContaining({ tag: "FORM" }),
    });
    expect(JSON.stringify(events)).not.toContain("4111111111111111");

    cleanup();
  });

  it("emits navigation events with redacted URLs and safe frame context", () => {
    window.history.replaceState(null, "", "/start?token=secret#frag");
    const { events, bus, cleanup } = collect();
    bus.flush();

    const initNav = events.find(
      (event) => event.k === "nav" && event.d.tr === "init",
    );
    expect(initNav?.d).toMatchObject({
      from: "",
      to: `http://localhost:3000/start?token=${encodeURIComponent(REDACTED_VALUE)}`,
      toOrigin: "http://localhost:3000",
      frame: expect.objectContaining({
        top: true,
        origin: "http://localhost:3000",
      }),
      redaction: expect.objectContaining({
        policy: "crumbtrail.browser-redaction.v1",
      }),
    });
    expect(JSON.stringify(initNav)).not.toContain("secret");
    expect(JSON.stringify(initNav)).not.toContain("#frag");

    events.length = 0;
    window.history.pushState(null, "", "/checkout?session=secret#pay");
    bus.flush();

    const pushNav = events.find(
      (event) => event.k === "nav" && event.d.tr === "push",
    );
    expect(pushNav?.d).toMatchObject({
      from: `http://localhost:3000/start?token=${encodeURIComponent(REDACTED_VALUE)}`,
      to: `http://localhost:3000/checkout?session=${encodeURIComponent(REDACTED_VALUE)}`,
      fromOrigin: "http://localhost:3000",
      toOrigin: "http://localhost:3000",
    });
    expect(JSON.stringify(pushNav)).not.toContain("secret");
    expect(JSON.stringify(pushNav)).not.toContain("#pay");

    cleanup();
  });
});
