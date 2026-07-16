/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Crumbtrail } from "../bug-logger";

function makeTransport() {
  return {
    sendEvents: vi.fn().mockResolvedValue(undefined),
    sendBlob: vi.fn().mockResolvedValue(undefined),
    startSession: vi.fn().mockResolvedValue(undefined),
    endSession: vi.fn().mockResolvedValue(undefined),
    sendBugReport: vi.fn().mockResolvedValue(undefined),
  };
}

describe("production privacy masking", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    document.body.innerHTML = "";
    history.replaceState({}, "", "/");
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("persists a rage click artifact with no private browser or database values", async () => {
    vi.useFakeTimers();
    history.replaceState(
      {},
      "",
      "/checkout?receipt=URL-private-value-123#private-fragment",
    );
    document.body.innerHTML = `
      <button id="rage" aria-label="Rage private aria">Rage private text</button>
      <a id="private-link" href="/receipt?value=URL-private-value-123#private-fragment">Receipt</a>
      <section data-crumbtrail-unmask id="unmask-parent">
        <span id="unmask-child">Descendant private text</span>
        <input id="unmask-child-input" placeholder="Descendant private placeholder" aria-label="Descendant private aria">
      </section>
      <input id="masked-input" placeholder="Private placeholder" aria-label="Private aria label" aria-description="Private aria description">
      <select id="masked-select" aria-label="Private select aria">
        <option value="private-option-value">Private option text</option>
      </select>
      <section data-crumbtrail-block id="blocked">Blocked private text <input id="blocked-input"></section>
    `;
    const maskedInput = document.querySelector(
      "#masked-input",
    ) as HTMLInputElement;
    const unmaskedChildInput = document.querySelector(
      "#unmask-child-input",
    ) as HTMLInputElement;
    const blockedInput = document.querySelector(
      "#blocked-input",
    ) as HTMLInputElement;
    const maskedSelect = document.querySelector(
      "#masked-select",
    ) as HTMLSelectElement;
    maskedInput.value = "masked-value-123";
    unmaskedChildInput.value = "descendant-value-456";
    blockedInput.value = "blocked-value-789";

    const transport = makeTransport();
    const logger = Crumbtrail.init({
      transportInstance: transport,
      autoFlagOnSignals: true,
      rageClickThreshold: 3,
      rageClickWindowMs: 1_000,
      autoFlagDebounceMs: 0,
      environment: false,
      network: false,
      flushIntervalMs: 100_000,
      flushBufferSize: 1_000,
      describeInteractionElement: (element) => {
        const select =
          element instanceof HTMLSelectElement ? element : undefined;
        const selected = select?.selectedOptions[0];
        return {
          tag: element.tagName,
          txt: element.textContent,
          placeholder: element.getAttribute("placeholder"),
          "aria-label": element.getAttribute("aria-label"),
          "aria-description": element.getAttribute("aria-description"),
          selectedOptionText: selected?.text,
          selectedOptionValue: selected?.value,
          href:
            element instanceof HTMLAnchorElement ? element.href : undefined,
        };
      },
    });

    maskedInput.dispatchEvent(new Event("input", { bubbles: true }));
    unmaskedChildInput.dispatchEvent(new Event("input", { bubbles: true }));
    maskedSelect.dispatchEvent(new Event("change", { bubbles: true }));
    blockedInput.dispatchEvent(new Event("input", { bubbles: true }));
    const paste = new Event("paste", { bubbles: true });
    Object.defineProperty(paste, "clipboardData", {
      value: { getData: () => "Clipboard private value" },
    });
    maskedInput.dispatchEvent(paste);
    document
      .querySelector("#unmask-child")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    document
      .querySelector("#blocked")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const privateLink = document.querySelector("#private-link");
    privateLink?.addEventListener("click", (event) => event.preventDefault());
    privateLink?.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true }),
    );
    logger.addEvent({
      type: "db.diff",
      data: {
        table: "customers",
        pk: { id: 42 },
        after: { name: "Database private value", email: "db@example.test" },
      },
    });
    logger.addEvent({
      type: "db.diff.bulk",
      data: {
        table: "customers",
        samplePks: [{ id: 42, email: "bulk@example.test" }],
        values: [{ name: "Bulk database private value" }],
      },
    });

    const rageButton = document.querySelector("#rage") as HTMLButtonElement;
    rageButton.click();
    rageButton.click();
    rageButton.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(transport.sendBugReport).toHaveBeenCalledTimes(1);
    expect(transport.sendBugReport.mock.calls[0][0].tags).toContain(
      "auto:rage-click",
    );
    const events = transport.sendBugReport.mock.calls[0][1] as Array<{
      k: string;
      d: Record<string, unknown>;
    }>;
    const persisted = [
      ...transport.startSession.mock.calls.map((call) => call[1]),
      ...transport.sendEvents.mock.calls.flatMap((call) => call[0]),
      ...transport.sendBugReport.mock.calls.map((call) => call[0]),
      ...transport.sendBugReport.mock.calls.flatMap((call) => call[1]),
    ];
    const captured = JSON.stringify(persisted);
    const leaks = [
      "Rage private text",
      "Rage private aria",
      "masked-value-123",
      "Descendant private text",
      "descendant-value-456",
      "Descendant private placeholder",
      "Descendant private aria",
      "Private placeholder",
      "Private aria label",
      "Private aria description",
      "Private select aria",
      "Private option text",
      "private-option-value",
      "Blocked private text",
      "blocked-value-789",
      "Database private value",
      "db@example.test",
      "Clipboard private value",
      '"id":42',
      "bulk@example.test",
      "Bulk database private value",
      "blocked-input",
      "URL-private-value-123",
      "private-fragment",
    ];

    for (const leak of leaks) expect(captured).not.toContain(leak);

    const dbDiff = events.find((event) => event.k === "db.diff");
    expect(dbDiff?.d.after).toEqual({
      name: "******** ******* *****",
      email: "***************",
    });
    expect(dbDiff?.d.pk).toEqual({ id: "[REDACTED]" });
    const dbDiffBulk = events.find((event) => event.k === "db.diff.bulk");
    expect(dbDiffBulk?.d.samplePks).toEqual([
      { id: "[REDACTED]", email: "*****************" },
    ]);
    expect(dbDiffBulk?.d.values).toEqual([
      { name: "**** ******** ******* *****" },
    ]);
    const domSnapshot = events.find((event) => event.k === "dom.snap");
    expect(domSnapshot?.d.html).toContain('placeholder="******* ***********"');
    expect(domSnapshot?.d.html).toContain('value="********************"');
    expect(domSnapshot?.d.html).not.toContain("Blocked private text");

    await logger.stop();
  });
});
