import { describe, it, expect } from "vitest";
import { extractOpinionCodePointers } from "../code-pointers";

const POINTER = {
  repo: "acme/shop",
  path: "src/checkout.ts",
  line: 42,
  commitSha: "a".repeat(40),
  permalink: `https://github.com/acme/shop/blob/${"a".repeat(40)}/src/checkout.ts#L42`,
  resolution: "deploy",
};

describe("extractOpinionCodePointers", () => {
  it("returns undefined for non-record or pointer-free opinions", () => {
    expect(extractOpinionCodePointers(undefined)).toBeUndefined();
    expect(extractOpinionCodePointers("nope")).toBeUndefined();
    expect(extractOpinionCodePointers({ findings: [] })).toBeUndefined();
    expect(
      extractOpinionCodePointers({ canonicalResults: [{ issueKey: "x" }] }),
    ).toBeUndefined();
  });

  it("projects valid pointers, skips malformed ones, dedupes by permalink", () => {
    const opinion = {
      canonicalResults: [
        {
          codePointers: [
            POINTER,
            { ...POINTER }, // duplicate permalink → collapsed
            { repo: "acme/shop", path: "a.ts" }, // missing sha/permalink → skipped
            { ...POINTER, resolution: "guess" }, // dishonest resolution → skipped
          ],
        },
        {
          codePointers: [
            { ...POINTER, path: "src/cart.ts", permalink: "https://p2", line: "x" },
          ],
        },
      ],
    };
    const pointers = extractOpinionCodePointers(opinion);
    expect(pointers).toHaveLength(2);
    expect(pointers?.[0]).toEqual(POINTER);
    // Non-numeric line is dropped from the pointer, not fabricated.
    expect(pointers?.[1]).toEqual({
      repo: "acme/shop",
      path: "src/cart.ts",
      commitSha: POINTER.commitSha,
      permalink: "https://p2",
      resolution: "deploy",
    });
  });
});
