import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../../event-bus";
import { DEFAULT_CONFIG, type BugEvent } from "../../types";
import { maskText } from "../../masking";
import { clipboardCollector } from "../clipboard";

function makeClipboardEvent(
  type: "copy" | "cut" | "paste",
  text?: string,
): Event {
  const event = new Event(type, { bubbles: true });
  if (type === "paste") {
    Object.defineProperty(event, "clipboardData", {
      value: { getData: () => text || "" },
    });
  }
  return event;
}

describe("clipboardCollector", () => {
  let bus: EventBus;
  let events: BugEvent[];
  let cleanup: () => void;

  beforeEach(() => {
    bus = new EventBus();
    events = [];
    bus.subscribe((batch) => events.push(...batch));
    cleanup = clipboardCollector(bus, DEFAULT_CONFIG);
  });

  afterEach(() => {
    cleanup();
  });

  it("captures paste events with text", () => {
    document.dispatchEvent(makeClipboardEvent("paste", "pasted text"));
    bus.flush();

    expect(events).toHaveLength(1);
    expect(events[0].k).toBe("clip");
    expect(events[0].d.op).toBe("paste");
    expect(events[0].d.txt).toBe(maskText("pasted text"));
  });

  it("redacts sensitive clipboard text by default", () => {
    document.dispatchEvent(makeClipboardEvent("paste", "password=hunter2"));
    bus.flush();

    expect(events[0].d.txt).toBe(maskText("password=hunter2"));
  });

  it("does not let raw clipboard capture bypass default masking", () => {
    cleanup();
    cleanup = clipboardCollector(bus, {
      ...DEFAULT_CONFIG,
      captureRawClipboard: true,
    });

    document.dispatchEvent(makeClipboardEvent("paste", "password=hunter2"));
    bus.flush();

    expect(events[0].d.txt).toBe(maskText("password=hunter2"));
    expect(events[0].d.redaction).toBeUndefined();
  });

  it("truncates clipboard text to clipboardMaxLength", () => {
    const longText = "safe clipboard text ".repeat(100);
    document.dispatchEvent(makeClipboardEvent("paste", longText));
    bus.flush();

    expect((events[0].d.txt as string).length).toBe(500);
  });

  it("captures copy events", () => {
    const origGetSelection = window.getSelection;
    window.getSelection = vi.fn().mockReturnValue({
      toString: () => "selected text",
    }) as unknown as typeof window.getSelection;

    document.dispatchEvent(makeClipboardEvent("copy"));
    bus.flush();

    expect(events[0].d.op).toBe("copy");
    expect(events[0].d.txt).toBe(maskText("selected text"));

    window.getSelection = origGetSelection;
  });

  it("captures cut events", () => {
    const origGetSelection = window.getSelection;
    window.getSelection = vi.fn().mockReturnValue({
      toString: () => "cut text",
    }) as unknown as typeof window.getSelection;

    document.dispatchEvent(makeClipboardEvent("cut"));
    bus.flush();

    expect(events[0].d.op).toBe("cut");
    expect(events[0].d.txt).toBe(maskText("cut text"));

    window.getSelection = origGetSelection;
  });

  it("stops capturing after cleanup", () => {
    cleanup();
    document.dispatchEvent(makeClipboardEvent("paste", "ignored"));
    bus.flush();
    expect(events).toHaveLength(0);
    cleanup = clipboardCollector(bus, DEFAULT_CONFIG);
  });
});
