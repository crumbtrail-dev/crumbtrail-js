import { describe, expect, it } from "vitest";
import {
  fitToWidth,
  initialMultiSelectState,
  parseSelection,
  reduceMultiSelectKey,
  renderInteractiveItem,
  type Keypress,
  type MultiSelectItem,
  type MultiSelectState,
} from "../ui";

const items: MultiSelectItem[] = [
  { label: "apps/web", checked: true, selectable: true },
  { label: "services/api", checked: true, selectable: true },
  { label: "services/payments", checked: false, selectable: true },
  { label: "packages/tsconfig", checked: false, selectable: false },
];

function indices(input: string): number[] {
  const r = parseSelection(input, items);
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`);
  return r.indices;
}

function error(input: string): string {
  const r = parseSelection(input, items);
  if (r.ok) throw new Error(`expected an error, got: ${r.indices}`);
  return r.error;
}

describe("parseSelection", () => {
  it("takes the checked defaults on empty input", () => {
    expect(indices("")).toEqual([0, 1]);
    expect(indices("   ")).toEqual([0, 1]);
  });

  it("handles all / none", () => {
    // "all" means every SELECTABLE row — never the unwireable one.
    expect(indices("all")).toEqual([0, 1, 2]);
    expect(indices("none")).toEqual([]);
  });

  it("parses lists, ranges, and mixed separators", () => {
    expect(indices("1,3")).toEqual([0, 2]);
    expect(indices("1-3")).toEqual([0, 1, 2]);
    expect(indices("1-2, 3")).toEqual([0, 1, 2]);
    expect(indices("3 1")).toEqual([0, 2]);
  });

  it("dedupes overlapping picks", () => {
    expect(indices("1,1,1-2")).toEqual([0, 1]);
  });

  it("rejects garbage rather than silently dropping it", () => {
    expect(error("web")).toContain("isn't a number");
    expect(error("1,web")).toContain("isn't a number");
  });

  it("rejects out-of-range and inverted ranges", () => {
    expect(error("0")).toContain("out of range");
    expect(error("9")).toContain("out of range");
    expect(error("3-1")).toContain("out of range");
  });

  it("rejects an unselectable row by name, so the user learns why", () => {
    const message = error("4");
    expect(message).toContain("packages/tsconfig");
    expect(message).toContain("no supported framework");
  });
});

// Items with an unselectable row in the MIDDLE, so cursor-skip is exercised.
const interactiveItems: MultiSelectItem[] = [
  { label: "packages/tsconfig", checked: false, selectable: false },
  { label: "apps/web", checked: true, selectable: true },
  { label: "scripts/auto-test", checked: true, selectable: false },
  { label: "services/api", checked: false, selectable: true },
  { label: "services/payments", checked: true, selectable: true },
];

function press(state: MultiSelectState, key: Keypress): MultiSelectState {
  const r = reduceMultiSelectKey(state, key, interactiveItems);
  if (r.kind !== "continue") throw new Error(`expected continue, got ${r.kind}`);
  return r.state;
}

describe("interactive multi-select key grammar", () => {
  it("starts on the first selectable row, defaults checked", () => {
    const s = initialMultiSelectState(interactiveItems);
    expect(s.cursor).toBe(1);
    // An unselectable row can never be checked, even if marked as a default.
    expect(s.checked).toEqual([false, true, false, false, true]);
  });

  it("moves down past unselectable rows and wraps", () => {
    let s = initialMultiSelectState(interactiveItems); // cursor 1
    s = press(s, { name: "down" });
    expect(s.cursor).toBe(3); // skipped scripts/auto-test
    s = press(s, { name: "down" });
    expect(s.cursor).toBe(4);
    s = press(s, { name: "down" });
    expect(s.cursor).toBe(1); // wrapped past packages/tsconfig
  });

  it("moves up with wrap, and accepts vim keys", () => {
    let s = initialMultiSelectState(interactiveItems); // cursor 1
    s = press(s, { name: "k" });
    expect(s.cursor).toBe(4); // wrapped backwards
    s = press(s, { name: "j" });
    expect(s.cursor).toBe(1);
  });

  it("space toggles the highlighted row only", () => {
    let s = initialMultiSelectState(interactiveItems);
    s = press(s, { name: "space" });
    expect(s.checked).toEqual([false, false, false, false, true]);
    s = press(s, { name: "space" });
    expect(s.checked).toEqual([false, true, false, false, true]);
  });

  it("'a' checks every selectable row, then clears them all", () => {
    let s = initialMultiSelectState(interactiveItems);
    s = press(s, { name: "a" });
    expect(s.checked).toEqual([false, true, false, true, true]);
    s = press(s, { name: "a" });
    expect(s.checked).toEqual([false, false, false, false, false]);
  });

  it("enter submits the checked indices in order", () => {
    const s = initialMultiSelectState(interactiveItems);
    const r = reduceMultiSelectKey(s, { name: "return" }, interactiveItems);
    expect(r).toEqual({ kind: "submit", indices: [1, 4] });
  });

  it("ctrl+c aborts", () => {
    const s = initialMultiSelectState(interactiveItems);
    const r = reduceMultiSelectKey(
      s,
      { name: "c", ctrl: true },
      interactiveItems,
    );
    expect(r).toEqual({ kind: "abort" });
  });

  it("ignores keys it doesn't know", () => {
    const s = initialMultiSelectState(interactiveItems);
    expect(press(s, { name: "x" })).toEqual(s);
    expect(press(s, {})).toEqual(s);
  });
});

describe("interactive multi-select rendering", () => {
  const state: MultiSelectState = {
    cursor: 1,
    checked: [false, true, false, false, false],
  };

  it("marks the cursor row with a pointer and its checkbox", () => {
    const line = renderInteractiveItem(interactiveItems[1], 1, state);
    expect(line).toContain("❯");
    expect(line).toContain("[x]");
    expect(line).toContain("apps/web");
  });

  it("renders other selectable rows without a pointer", () => {
    const line = renderInteractiveItem(interactiveItems[3], 3, state);
    expect(line).not.toContain("❯");
    expect(line).toContain("[ ]");
  });

  it("renders unselectable rows without a checkbox at all", () => {
    const line = renderInteractiveItem(interactiveItems[0], 0, state);
    expect(line).not.toContain("[");
    expect(line).toContain("packages/tsconfig");
  });
});

describe("fitToWidth", () => {
  it("leaves short lines alone", () => {
    expect(fitToWidth("hello", 80)).toBe("hello");
  });

  it("clips by visible width, not raw length", () => {
    const styled = `[36mabcdef[0m`;
    const clipped = fitToWidth(styled, 4);
    // Three visible chars + ellipsis, escapes preserved and style closed.
    expect(clipped).toBe(`[36mabc…[0m`);
  });

  it("does not count escape sequences toward the width", () => {
    const styled = `[1m[32mab[0m`;
    expect(fitToWidth(styled, 3)).toBe(styled);
  });
});
