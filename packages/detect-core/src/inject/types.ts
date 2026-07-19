import type { Recipe } from "../detect";

/** The shape of a plan the executor knows how to (or refuses to) apply. */
export type PlanKind =
  | "create" // write a brand-new file
  | "prepend" // strictly prepend into an existing file
  | "rewrite" // replace an existing file with fully transformed content (Express middleware wiring)
  | "skip-already-wired" // project already references Crumbtrail; no-op
  | "needs-confirm-dirty" // target has uncommitted changes; needs --force / confirm
  | "fallback-ai" // detection/safety ambiguous; hand off to the AI-prompt path
  | "otlp-guidance"; // non-JS backend: emit OTLP setup guidance, write nothing

/**
 * A fully-resolved, side-effect-free description of what injection would do.
 * The executor turns this into filesystem writes; nothing here performs I/O.
 */
export interface Plan {
  recipe: Recipe;
  kind: PlanKind;
  /** Absolute path of the file to create/edit. null for skip/fallback plans. */
  targetPath: string | null;
  /**
   * For `create`/`rewrite`: the full file body. For `prepend` (and
   * `needs-confirm-dirty` in prepend mode): the block to prepend. null for
   * skip/fallback plans.
   */
  content: string | null;
  /**
   * How a confirmed `needs-confirm-dirty` plan is applied: "rewrite" writes
   * `content` as the whole file (Express middleware wiring); default/absent
   * prepends `content` as a block.
   */
  applyMode?: "prepend" | "rewrite";
  /** Non-fatal notes to surface to the user. */
  warnings: string[];
  /** fallback-ai: the ready-to-paste code snippet (reads the key from env). */
  snippet?: string;
  /** fallback-ai: the `buildAgentPrompt` output for a coding agent. */
  agentPrompt?: string;
  /**
   * The env var the injected code reads the ingest key from (e.g.
   * `VITE_CRUMBTRAIL_KEY`). The installer is hands-off — it never writes the key —
   * so the wizard prints this name and points the user at the dashboard to set
   * it. Undefined for recipes that inject no key (tauri / otlp / angular).
   */
  keyEnvVar?: string;
}
