// Direct coverage for materializePlan — the seam the cloud consumes.
//
// executePlan is exercised heavily elsewhere, but every one of those tests
// reaches the code through the CLI writer, so none of them observe `edits` or
// `mode`. Those fields exist ONLY to serve the cloud PR path: `mode` picks
// GitHub create vs update, and an update needs a blob SHA a new path does not
// have. That makes them invisible to the CLI and therefore untested by it,
// which is exactly how a hardcoded `mode: "update"` survived a full green suite.
//
// The byte-equality tests at the bottom compare materializePlan's output against
// INDEPENDENTLY computed expectations (direct prependIntoSource/withTrailingNewline
// calls), not against another materializePlan call. That distinction is the whole
// point: an earlier version of this file compared both sides through the same
// call, so breaking materializePlan outright still left every one of them green.

import { describe, expect, it } from "vitest";
import { executePlan, materializePlan } from "../inject/executor";
import { prependIntoSource, withTrailingNewline } from "../inject/text";
import type { Plan } from "../inject/types";
import { memExecutorIO } from "./helpers";

const TARGET = "/repo/src/instrumentation-client.ts";

function plan(overrides: Partial<Plan> & Pick<Plan, "kind">): Plan {
  return {
    recipe: "next",
    targetPath: TARGET,
    content: "const wired = true;",
    warnings: [],
    ...overrides,
  } as Plan;
}

describe("materializePlan", () => {
  describe("emitted bytes", () => {
    it("create wraps content in a trailing newline", () => {
      const { io } = memExecutorIO();
      const out = materializePlan(plan({ kind: "create" }), io);
      expect(out.edits).toEqual([
        { path: TARGET, mode: "create", content: "const wired = true;\n" },
      ]);
    });

    it("rewrite wraps content in a trailing newline", () => {
      const { io } = memExecutorIO({ [TARGET]: "old body\n" });
      const out = materializePlan(plan({ kind: "rewrite" }), io);
      expect(out.edits[0].content).toBe("const wired = true;\n");
    });

    it("prepend produces a block merged into the prior body, not a replacement", () => {
      const { io } = memExecutorIO({ [TARGET]: "export const existing = 1;\n" });
      const out = materializePlan(plan({ kind: "prepend" }), io);
      // The prior body must survive; a naive implementation would drop it.
      expect(out.edits[0].content).toContain("export const existing = 1;");
      expect(out.edits[0].content).toContain("const wired = true;");
    });
  });

  describe("mode is derived from target existence, never assumed", () => {
    it("prepend onto an existing file is an update", () => {
      const { io } = memExecutorIO({ [TARGET]: "prior\n" });
      expect(materializePlan(plan({ kind: "prepend" }), io).edits[0].mode).toBe(
        "update",
      );
    });

    it("prepend onto a missing file is a create", () => {
      // prependIntoSource("", block) legitimately produces a NEW file, so the
      // cloud must issue a create. Asserting "update" here would mean opening a
      // pull request that references a blob SHA that does not exist.
      const { io } = memExecutorIO();
      expect(materializePlan(plan({ kind: "prepend" }), io).edits[0].mode).toBe(
        "create",
      );
    });

    it("rewrite over an existing file is an update", () => {
      const { io } = memExecutorIO({ [TARGET]: "prior\n" });
      expect(materializePlan(plan({ kind: "rewrite" }), io).edits[0].mode).toBe(
        "update",
      );
    });

    it("rewrite over a missing file is a create", () => {
      const { io } = memExecutorIO();
      expect(materializePlan(plan({ kind: "rewrite" }), io).edits[0].mode).toBe(
        "create",
      );
    });
  });

  describe("no write kinds produce zero edits", () => {
    it.each([
      "skip-already-wired",
      "fallback-ai",
      "otlp-guidance",
    ] as const)("%s", (kind) => {
      const { io } = memExecutorIO({ [TARGET]: "prior\n" });
      expect(materializePlan(plan({ kind }), io).edits).toEqual([]);
    });

    it("returns zero edits when targetPath or content is absent", () => {
      const { io } = memExecutorIO();
      expect(
        materializePlan(plan({ kind: "create", targetPath: null }), io).edits,
      ).toEqual([]);
      expect(
        materializePlan(plan({ kind: "create", content: null }), io).edits,
      ).toEqual([]);
    });
  });

  it("copies warnings so a cloud caller cannot mutate the source Plan", () => {
    const source = plan({ kind: "create", warnings: ["careful"] });
    const out = materializePlan(source, memExecutorIO().io);
    out.warnings.push("added by caller");
    expect(source.warnings).toEqual(["careful"]);
  });

  it("refuses to overwrite an existing file with a create plan", () => {
    const { io } = memExecutorIO({ [TARGET]: "already here\n" });
    expect(() => materializePlan(plan({ kind: "create" }), io)).toThrow(
      /refusing to overwrite/,
    );
  });

  // The core guarantee of this seam. Every expectation below is computed
  // independently of materializePlan, so a bug inside it fails these tests.
  describe("byte equality against independently computed output", () => {
    const prior = "export const existing = 1;\n";
    const body = "const wired = true;";

    it("prepend matches a direct prependIntoSource call", () => {
      const { io } = memExecutorIO({ [TARGET]: prior });
      const out = materializePlan(plan({ kind: "prepend" }), io);
      expect(out.edits[0].content).toBe(prependIntoSource(prior, body));
      expect(out.edits[0].mode).toBe("update");
    });

    it("rewrite matches a direct withTrailingNewline call", () => {
      const { io } = memExecutorIO({ [TARGET]: prior });
      const out = materializePlan(plan({ kind: "rewrite" }), io);
      expect(out.edits[0].content).toBe(withTrailingNewline(body));
      expect(out.edits[0].mode).toBe("update");
    });

    it("create matches a direct withTrailingNewline call", () => {
      const { io } = memExecutorIO();
      const out = materializePlan(plan({ kind: "create" }), io);
      expect(out.edits[0].content).toBe(withTrailingNewline(body));
      expect(out.edits[0].mode).toBe("create");
    });

    // The dirty plan is passed through UNMODIFIED. If the test had to rewrite
    // its kind first, it would be reimplementing the mapping it verifies, and
    // the cloud would only be correct if a future author rederived it the same
    // way. Resolution lives in materializePlan precisely so it cannot drift.
    it("resolves a dirty plan in prepend mode without the caller rewriting it", () => {
      const { io } = memExecutorIO({ [TARGET]: prior });
      const out = materializePlan(
        plan({ kind: "needs-confirm-dirty", applyMode: "prepend" }),
        io,
      );
      expect(out.edits[0].content).toBe(prependIntoSource(prior, body));
      expect(out.edits[0].mode).toBe("update");
      // The original kind survives so a caller still knows it needed confirming.
      expect(out.kind).toBe("needs-confirm-dirty");
    });

    it("resolves a dirty plan in rewrite mode without the caller rewriting it", () => {
      const { io } = memExecutorIO({ [TARGET]: prior });
      const out = materializePlan(
        plan({ kind: "needs-confirm-dirty", applyMode: "rewrite" }),
        io,
      );
      expect(out.edits[0].content).toBe(withTrailingNewline(body));
      expect(out.kind).toBe("needs-confirm-dirty");
    });

    it("defaults a dirty plan with no applyMode to prepend", () => {
      const { io } = memExecutorIO({ [TARGET]: prior });
      const out = materializePlan(plan({ kind: "needs-confirm-dirty" }), io);
      expect(out.edits[0].content).toBe(prependIntoSource(prior, body));
    });

    // executePlan must write exactly what materializePlan produced. Paired with
    // the independent expectations above, this closes the CLI/cloud loop.
    it("executePlan writes exactly the materialized bytes for a confirmed dirty plan", () => {
      const dirty = plan({ kind: "needs-confirm-dirty", applyMode: "prepend" });
      const writeIo = memExecutorIO({ [TARGET]: prior });
      executePlan(dirty, writeIo.io, { confirmDirty: true });
      expect(writeIo.files[TARGET]).toBe(prependIntoSource(prior, body));
    });
  });

  describe("mode edge cases that only matter to the cloud", () => {
    it("prepend onto an existing but empty file is an update, not a create", () => {
      // Distinct from an absent file: the path exists, so GitHub needs update.
      const { io } = memExecutorIO({ [TARGET]: "" });
      const out = materializePlan(plan({ kind: "prepend" }), io);
      expect(out.edits[0].mode).toBe("update");
    });

    it("preserves CRLF line endings from the prior file", () => {
      const crlf = "export const existing = 1;\r\n";
      const { io } = memExecutorIO({ [TARGET]: crlf });
      const out = materializePlan(plan({ kind: "prepend" }), io);
      expect(out.edits[0].content).toBe(
        prependIntoSource(crlf, "const wired = true;"),
      );
      expect(out.edits[0].content).toContain("\r\n");
    });

    it("emits no edit for empty content rather than writing a bare newline", () => {
      const { io } = memExecutorIO();
      expect(
        materializePlan(plan({ kind: "create", content: "" }), io).edits,
      ).toEqual([]);
    });
  });
});
