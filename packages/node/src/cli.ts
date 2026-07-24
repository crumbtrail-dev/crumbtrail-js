#!/usr/bin/env node

import path from "node:path";
import { createServer } from "./server";
import { McpServer } from "./mcp-server";
import {
  CliConfigError,
  isLoopbackHost,
  parseCliConfig,
  resolveCliConfig,
  type CliConfig,
} from "./config";
import { parseCommand, type Command } from "./commands";
import { runInit } from "./run-init";
import { resolveDoctorConfig, runDoctor, type DoctorReport } from "./doctor";
import {
  isProviderId,
  PROVIDER_IDS,
  renderProviderCliOutput,
} from "./provider-recipes";
import { runScan } from "./run-scan";
import { runFixContext } from "./run-fix-context";
import { runInspect } from "./run-inspect";
import { runReanalyze } from "./run-reanalyze";
import { runCompare } from "./run-compare";
import { readPackageVersion } from "./version";

export function parseArgs(args: string[]): CliConfig {
  return parseCliConfig(args);
}

function readPortFlag(args: string[]): number | undefined {
  const idx = args.indexOf("--port");
  if (idx >= 0 && args[idx + 1]) {
    const port = parseInt(args[idx + 1], 10);
    if (Number.isInteger(port)) return port;
  }
  return undefined;
}

function readProviderFlag(args: string[]): string | undefined {
  const idx = args.indexOf("--provider");
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

const HELP_TEXT = `crumbtrail — AI-readable app evidence sessions

Usage:
  crumbtrail <command> [options]

Commands:
  serve     Run the local capture + MCP server (default if no command given)
  init      Install the SDK into this project and generate wiring helpers
  doctor    Verify capture + correlation + MCP-readability end to end
  scan      Flag components/functions missing IDs or logging (coverage gaps)
  fix-context  Emit the ranked, correlated, LLM-ready fix-context bundle for a session
  inspect   Summarize a finalized session's manifest + artifacts (hot-plane only)
  compare   Compare two recorded sessions or releases
  reanalyze Rebuild finalized sessions' artifacts with the current analyzer
  help      Show this help

Global options:
  --version, -v   Print the crumbtrail-node version and exit
  <cmd> --help    Show focused help for a subcommand (e.g. \`crumbtrail-server scan --help\`)

Run \`crumbtrail-server serve --help\` style flags are passed straight through to the server.

Already using OpenTelemetry/Sentry/Datadog? Point your exporter at this server's OTLP
receiver (POST /v1/traces and /v1/logs) instead of installing a backend SDK. \`init\`
auto-detects existing telemetry; see docs/integrations/.`;

// Per-subcommand help is data-driven so `crumbtrail <cmd> --help` stays in lock-step with the
// command definitions below. Each entry lists the focused flags plus a copy-pasteable example.
const SUBCOMMAND_HELP: Record<Exclude<Command, "help">, string> = {
  serve: `crumbtrail-server serve — run the local capture + MCP server

Options:
  --port <n>          Port to listen on (default 9898)
  --host <addr>       Host/IP to bind (default 127.0.0.1)
  --output <dir>      Sessions directory (default ~/.crumbtrail/sessions)
  --static <dir>      Serve a static app directory alongside the API
  --auth-token <tok>  Require this token on /api/* (or set CRUMBTRAIL_AUTH_TOKEN)
  --allow-origin <o>  Add an allowed browser origin (repeatable)
  --whisper-model <m> Whisper model for audio transcription (default base)
  --mcp               Start the stdio MCP server instead of the HTTP server
  --ai                Enable opt in AI opinion (see --ai-model)

Example:
  crumbtrail-server serve --port 9898 --output ./.crumbtrail/sessions`,
  init: `crumbtrail-server init — install the SDK and generate wiring helpers

Options:
  --port <n>     Server port to wire into generated config/helpers (default 9898)
  --provider <${PROVIDER_IDS.join("|")}>
                 Print a provider-specific OTLP/HTTP exporter block
  --no-install   Skip installing the crumbtrail dependencies
  --force        Overwrite existing generated helper files

Example:
  crumbtrail-server init --provider datadog`,
  doctor: `crumbtrail-server doctor — verify capture + correlation + MCP-readability end to end

Options:
  --port <n>   Port of a running server, or the port to start one on (default from config)

Example:
  crumbtrail-server doctor --port 9898`,
  scan: `crumbtrail-server scan — flag components/functions missing IDs or logging (coverage gaps)

Options:
  [path]      Directory to scan (default: current directory)
  --json      Emit the report as JSON (each finding includes a suggested fix)
  --strict    Exit non-zero when any gap is found (for CI)

Example:
  crumbtrail-server scan ./src --strict`,
  "fix-context": `crumbtrail-server fix-context — emit the ranked, correlated, LLM-ready bundle for a session

Options:
  <session>        Session id (resolved under the sessions dir) or a path to a session directory
  --latest         Resolve the most recent finalized session with error-class evidence (replaces <session>)
  --follow         Poll until the target finalizes, then emit; progress goes to stderr
  --interval <ms>  Poll interval for --follow (default 1000)
  --timeout <ms>   Give up on --follow after this long with a non-zero exit (default 60000)
  --json           Emit the raw fix-context.json contract instead of a human summary
  --output <dir>   Sessions directory used to resolve a bare session id or --latest

Examples:
  crumbtrail-server fix-context ses_123 --json
  crumbtrail-server fix-context --latest --follow --json`,
  reanalyze: `crumbtrail-server reanalyze — rebuild finalized artifacts with the current analyzer

Session artifacts are written once at finalize time, so a session analyzed by an
older build keeps that build's output even after the analyzer improves. This
replays the stored cold event stream through the current analyzer and rewrites
the derived artifacts (index, candidates, bundle, manifest). The raw evidence
(events.ndjson.zst, signatures.json) is read, never rewritten.

Options:
  <session>   Session id (resolved under the sessions dir) or a path to a session directory
  --all       Reanalyze every finalized session under the sessions dir
  --dry-run   List what would be reanalyzed without writing
  --json      Emit the per-session report as JSON
  --output    Sessions directory used to resolve a bare session id or --all

Examples:
  crumbtrail-server reanalyze ses_123
  crumbtrail-server reanalyze --all --dry-run`,
  inspect: `crumbtrail-server inspect — summarize a finalized session's manifest + artifacts

Reads hot-plane artifacts only (manifest.json, else index.json); never the raw event log.

Options:
  <session>   Session id (resolved under the sessions dir) or a path to a session directory
  --json      Emit the raw inspection summary as JSON
  --output    Sessions directory used to resolve a bare session id

Example:
  crumbtrail-server inspect ses_123`,
  compare: `crumbtrail-server compare — compare two recorded sessions or releases

Options:
  <a> <b>       Session ids (resolved under the sessions dir) or paths to session directories
  --json        Emit the raw session-compare.v1 contract
  --report <p>  Write a thin markdown diff report
  --output <d>  Sessions directory used to resolve bare session ids

Example:
  crumbtrail-server compare ses_base ses_head --report compare.md`,
};

function printDoctorReport(
  report: DoctorReport,
  endpoint: string,
  startedServer: boolean,
): void {
  console.log(
    `\nCrumbtrail doctor — ${endpoint}${startedServer ? " (started for this check)" : ""}\n`,
  );
  for (const check of report.checks) {
    const icon =
      check.status === "pass" ? "✓" : check.status === "warn" ? "!" : "✗";
    console.log(`  ${icon} ${check.name}: ${check.detail}`);
    if (check.remediation && check.status !== "pass") {
      console.log(`      → ${check.remediation}`);
    }
  }
  console.log(`\n${report.ok ? "✓" : "✗"} ${report.summary}\n`);
}

export async function runCli(argv: string[]): Promise<number> {
  if (argv[0] === "--version" || argv[0] === "-v") {
    console.log(readPackageVersion());
    return 0;
  }

  const { command, rest } = parseCommand(argv);

  if (command === "help") {
    console.log(HELP_TEXT);
    return 0;
  }

  // Per-subcommand help: `crumbtrail <cmd> --help` prints focused help for that command.
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(SUBCOMMAND_HELP[command]);
    return 0;
  }

  if (command === "init") {
    const provider = readProviderFlag(rest);
    if (provider) {
      if (!isProviderId(provider)) {
        process.stderr.write(
          `crumbtrail-server init error: --provider must be one of ${PROVIDER_IDS.join(", ")}\n`,
        );
        return 2;
      }
      const port = readPortFlag(rest) ?? 9898;
      console.log(
        renderProviderCliOutput(provider, `http://127.0.0.1:${port}`),
      );
      return 0;
    }

    const result = runInit({
      cwd: process.cwd(),
      port: readPortFlag(rest),
      install: !rest.includes("--no-install"),
      force: rest.includes("--force"),
    });
    console.log(`\nCrumbtrail init complete.`);
    console.log(
      `  Package manager: ${result.plan.installCommand.split(" ")[0]}`,
    );
    if (result.installRan) {
      console.log(
        `  Dependencies:    ${result.installOk ? "installed" : "install FAILED — run manually: " + result.plan.installCommand}`,
      );
    } else {
      console.log(
        `  Dependencies:    skipped — install manually: ${result.plan.installCommand}`,
      );
    }
    console.log(`  Wrote:           ${result.applied.wrote.length} file(s)`);
    if (result.applied.skipped.length > 0) {
      console.log(
        `  Left untouched:  ${result.applied.skipped.length} existing file(s) (use --force to overwrite)`,
      );
    }
    console.log(`\nNext steps:`);
    for (const step of result.plan.nextSteps) console.log(`  • ${step}`);
    console.log("");
    return result.installRan && !result.installOk ? 1 : 0;
  }

  if (command === "doctor") {
    const config = resolveDoctorConfig(process.cwd(), readPortFlag(rest));
    const { report, endpoint, startedServer } = await runDoctor({
      config,
      cwd: process.cwd(),
    });
    printDoctorReport(report, endpoint, startedServer);
    return report.ok ? 0 : 1;
  }

  if (command === "scan") {
    return await runScan(rest);
  }

  if (command === "fix-context") {
    return await runFixContext(rest);
  }

  if (command === "inspect") {
    return await runInspect(rest);
  }

  if (command === "compare") {
    return await runCompare(rest);
  }

  if (command === "reanalyze") {
    return await runReanalyze(rest);
  }

  // command === 'serve'
  const {
    port,
    host,
    output,
    whisperModel,
    mcp,
    staticDir,
    authToken,
    allowedOrigins,
    ai,
    aiModel,
    aiAllowAutoModel,
  } = resolveCliConfig(rest);

  if (mcp) {
    const mcpServer = new McpServer({ outputDir: output });
    process.stderr.write(
      `crumbtrail-mcp server started. Sessions dir: ${output}\n`,
    );
    mcpServer.start();
    return 0;
  }

  const server = createServer({
    port,
    outputDir: output,
    whisperModel,
    staticDir,
    authToken,
    allowedOrigins,
    ai: {
      enabled: ai,
      model: aiModel,
      allowAutoModel: aiAllowAutoModel,
      log: (message) => console.log(message),
    },
  });

  server.listen(port, host, () => {
    for (const message of startupMessages({
      port,
      host,
      output,
      whisperModel,
      mcp,
      staticDir,
      authToken,
      allowedOrigins,
      ai,
      aiModel,
      aiAllowAutoModel,
    })) {
      console.log(message);
    }
  });
  return 0;
}

export function startupMessages(config: CliConfig): string[] {
  const messages = [
    `crumbtrail-server listening on http://${config.host}:${config.port}`,
    `Sessions saved to: ${config.output}`,
  ];

  if (config.staticDir)
    messages.push(`Serving static files from: ${config.staticDir}`);
  if (!isLoopbackHost(config.host)) {
    messages.push(
      "WARNING: non-loopback host binding exposes captured Crumbtrail evidence on the network; use --auth-token and trusted network controls.",
    );
  }
  if (config.allowedOrigins.length > 0) {
    messages.push(
      `Allowed browser origins: ${config.allowedOrigins.length} configured`,
    );
  }
  if (config.authToken) {
    messages.push("Auth token protection enabled for /api/* routes");
  }
  if (config.ai) {
    messages.push(
      `AI opinion opt in enabled${config.aiModel ? ` with model ${config.aiModel}` : ""}`,
    );
  }

  return messages;
}

export function isCliEntrypoint(argv1: string | undefined): boolean {
  if (!argv1) return false;
  return [
    "cli.ts",
    "cli.js",
    "cli.cjs",
    "crumbtrail",
    "crumbtrail-server",
  ].includes(path.basename(argv1));
}

const isMain =
  typeof process !== "undefined" && isCliEntrypoint(process.argv[1]);

if (isMain) {
  runCli(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exitCode = code;
    })
    .catch((err) => {
      if (err instanceof CliConfigError) {
        process.stderr.write(
          `crumbtrail config error [${err.code}]: ${err.message}\n`,
        );
        process.exit(1);
      }
      process.stderr.write(
        `crumbtrail error: ${err?.message ?? String(err)}\n`,
      );
      process.exit(1);
    });
}
