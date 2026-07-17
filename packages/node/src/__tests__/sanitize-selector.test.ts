import { describe, expect, it } from "vitest";
import { sanitizeSelector } from "../sanitize-selector";

describe("sanitizeSelector", () => {
  it("removes malformed unquoted attribute values through the closing bracket", () => {
    expect(sanitizeSelector("button[data-testid=order hunter2-secret]")).toBe(
      "button[data-testid]",
    );
  });

  it("removes quoted attribute values without retaining their contents", () => {
    expect(sanitizeSelector('button[data-testid="order hunter2-secret"]')).toBe(
      "button[data-testid]",
    );
  });

  it("consumes a closing bracket inside a double-quoted attribute value", () => {
    expect(
      sanitizeSelector('button[data-testid="order] hunter2-secret"]'),
    ).toBe("button[data-testid]");
  });

  it("consumes a closing bracket inside a single-quoted attribute value", () => {
    expect(
      sanitizeSelector("button[data-testid='order] hunter2-secret']"),
    ).toBe("button[data-testid]");
  });
});
