import { resolve } from "node:path";
import { defaultCliConfig } from "./config";
import {
  inspectSession,
  formatInspection,
  InspectError,
  type SessionInspection,
} from "./inspect";

/**
 * `crumbtrail-server inspect <session>` — print a concise, hot-plane-only summary of a finalized
 * session (manifest/index + artifact listing). Default output is human-readable; `--json`
 * emits the raw {@link SessionInspection}. Never reads raw events.ndjson.
 */
export async function runInspect(rest: string[]): Promise<number> {
  const json = rest.includes("--json");
  const outputIdx = rest.indexOf("--output");
  const outputDir =
    outputIdx >= 0 && rest[outputIdx + 1]
      ? rest[outputIdx + 1]
      : defaultCliConfig().output;
  const target = rest.find(
    (arg, i) => !arg.startsWith("--") && rest[i - 1] !== "--output",
  );

  if (!target) {
    process.stderr.write(
      "crumbtrail-server inspect: a session id or directory is required.\n",
    );
    return 1;
  }

  let inspection: SessionInspection;
  try {
    inspection = await inspectSession(resolveTarget(target), { outputDir });
  } catch (err) {
    if (err instanceof InspectError) {
      process.stderr.write(`crumbtrail-server inspect: ${err.message}\n`);
      return 1;
    }
    throw err;
  }

  if (json) {
    process.stdout.write(`${JSON.stringify(inspection, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatInspection(inspection)}\n`);
  }
  return 0;
}

function resolveTarget(target: string): string {
  // A path-like argument resolves against cwd; a bare id is passed through so the session
  // resolver can locate it against the sessions dir (flat OR the V2 partition layout).
  if (
    target.includes("/") ||
    target.includes("\\") ||
    target === "." ||
    target.startsWith(".")
  ) {
    return resolve(target);
  }
  return target;
}
