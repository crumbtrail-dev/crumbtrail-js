// The OTLP guide file written for non-JS services (rails/django/go/dotnet/…).
//
// The CLI cannot inject code into a Ruby or Python service, but it can still do
// the valuable half automatically: provision the service, mint its key, and
// leave a filled-in setup guide in the service directory. `buildPlan` already
// produces an `otlp-guidance` Plan carrying the snippet + agent prompt with the
// real endpoint and key threaded through (inject/recipes.ts planOtlp) — this
// module only renders that into a file body and re-wraps it as a `create` Plan,
// so the existing executor supplies refuse-to-overwrite and rollback and no
// change to executor.ts is needed.

import path from "node:path";
import type { Stack } from "crumbtrail-core";
import { OTLP_GUIDE_FILENAME } from "crumbtrail-detect-core";
import type { Plan } from "./inject";

export { OTLP_GUIDE_FILENAME } from "crumbtrail-detect-core";

export interface OtlpGuideInput {
  stack: Stack;
  serviceName: string;
  endpoint: string;
  /** plan.snippet — the OTLP env/header/attribute block, key already filled in. */
  snippet: string;
  /** plan.agentPrompt — the ready-to-paste prompt for a coding agent. */
  agentPrompt: string;
}

export function renderOtlpGuide(input: OtlpGuideInput): string {
  return [
    `# Crumbtrail — ${input.serviceName}`,
    "",
    `Detected stack: **${input.stack}**`,
    `Ingest endpoint: ${input.endpoint}`,
    "",
    `This service is already provisioned in Crumbtrail and has its own ingest key.`,
    `There is no SDK to install: ${input.stack} speaks OpenTelemetry, so Crumbtrail`,
    `accepts its traces directly. Everything below is the one manual step.`,
    "",
    "## 1. Configure the OTLP exporter",
    "",
    "```sh",
    input.snippet,
    "```",
    "",
    "## 2. Or hand this to a coding agent",
    "",
    "```",
    input.agentPrompt,
    "```",
    "",
    "## Keep the key out of git",
    "",
    "The ingest key above is a live credential. Move it into your secret store or",
    "environment config and make sure this file (or wherever the key lands) is not",
    "committed to a public repository.",
    "",
  ].join("\n");
}

/**
 * Wrap a rendered guide as a `create` Plan so it goes through the normal
 * executor: refuses to overwrite an existing guide, rolls back on write failure.
 */
export function otlpGuidePlan(dir: string, body: string): Plan {
  return {
    recipe: "otlp",
    kind: "create",
    targetPath: path.join(dir, OTLP_GUIDE_FILENAME),
    content: body,
    warnings: [],
  };
}
