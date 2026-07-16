# crumbtrail-node

Local Crumbtrail HTTP server, MCP server, Express middleware, and package CLI.

This package is the local self-host runtime boundary for [Crumbtrail](https://crumbtrail.ai). It owns the server process that receives session events, writes local artifacts, post-processes sessions, and exposes MCP-readable evidence.

## Install

```bash
npm install crumbtrail-node
```

Or let the setup wizard install and wire everything for you:

```bash
npx crumbtrail
```

Pair it with [`crumbtrail-core`](https://www.npmjs.com/package/crumbtrail-core) in the browser. If you'd rather not run a server at all, the hosted cloud at [crumbtrail.ai](https://crumbtrail.ai) is a drop-in replacement for this endpoint.

## Runtime boundary

The package runtime entrypoint is the built CLI binary:

```bash
crumbtrail-server --host 127.0.0.1 --port 9898 --output ~/.crumbtrail/sessions
```

In this repository, the same boundary is exercised from built output with:

```bash
pnpm --filter crumbtrail-node verify:package-runtime
```

The verifier builds `crumbtrail-node`, starts `dist/cli.cjs` from a temporary runtime directory, probes `GET /health`, verifies static file serving, checks safe startup diagnostics, checks degraded health when the output directory becomes unavailable, and shuts the process down. A passing run prints:

```text
CRUMBTRAIL_PACKAGE_RUNTIME_PASS cli=dist/cli.cjs ...
```

## Local configuration contract

| Flag                    |                            Default | Validation                                                                                       | Purpose                                                                                                                                   |
| ----------------------- | ---------------------------------: | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `--host`                |                        `127.0.0.1` | Must be non-empty.                                                                               | Interface for the local server to bind.                                                                                                   |
| `--port`                |                             `9898` | Must be an integer from 1 to 65535.                                                              | HTTP port.                                                                                                                                |
| `--output`              |           `~/.crumbtrail/sessions` | Must be a non-empty local path.                                                                  | Directory where session artifacts are written.                                                                                            |
| `--static`              |                              unset | If set, path must exist and be a directory.                                                      | Optional static directory to serve alongside API/session routes.                                                                          |
| `--allow-origin`        |             localhost origins only | Must be an `http` or `https` origin containing only scheme, host, and optional port. Repeatable. | Additional browser origins allowed by CORS.                                                                                               |
| `--auth-token`          | unset (or `CRUMBTRAIL_AUTH_TOKEN`) | Presence is reported, but token content is never logged.                                         | Optional token required for `/api/*` routes. The `--auth-token` flag wins; otherwise a non-blank `CRUMBTRAIL_AUTH_TOKEN` env var is used. |
| `--mcp`                 |                            `false` | Boolean flag.                                                                                    | Run MCP server mode against the output directory instead of HTTP mode.                                                                    |
| `--ai`                  |                            `false` | Boolean flag.                                                                                    | Opt into AI diagnosis after finalization.                                                                                                 |
| `--ai-model`            |                              unset | Parsed as an opaque model string.                                                                | Model override for AI diagnosis.                                                                                                          |
| `--ai-allow-auto-model` |                            `false` | Boolean flag.                                                                                    | Allow provider auto-model selection.                                                                                                      |

Invalid config fails before the server binds and prints a bounded message like:

```text
crumbtrail-server config error [invalid_port]: Invalid --port: expected an integer from 1 to 65535.
```

Startup diagnostics report the resolved listening URL, session output directory, static directory when configured, allowed-origin count, auth protection enabled state, and AI opt-in state. They do not print auth token contents.

## Health diagnostics

HTTP mode exposes:

```bash
curl http://127.0.0.1:9898/health
```

A healthy response has this shape:

```json
{
  "ok": true,
  "status": "ready",
  "service": "crumbtrail-node",
  "version": "0.1.0",
  "timestamp": "2026-06-29T00:00:00.000Z",
  "uptimeMs": 1234,
  "config": {
    "host": "127.0.0.1",
    "port": 9898,
    "outputDir": "/Users/example/.crumbtrail/sessions",
    "staticDir": "./examples/basic",
    "authEnabled": true,
    "allowedOriginCount": 1,
    "aiEnabled": false,
    "mcpMode": false
  },
  "checks": {
    "outputDir": {
      "path": "/Users/example/.crumbtrail/sessions",
      "exists": true,
      "writable": true
    },
    "staticDir": {
      "configured": true,
      "path": "./examples/basic",
      "exists": true
    }
  }
}
```

If the output directory becomes unavailable while the server is running, `/health` returns HTTP 200 with `ok: false`, `status: "degraded"`, and a bounded filesystem error under `checks.outputDir.error`. This is intentional: health is an inspection surface, not a mutating API.

Health output reports auth and allowed-origin configuration as booleans/counts. It must not include auth token contents or raw allowed-origin values.

## Self-host quickstart proof

Run the packaged local server plus full-stack Express example proof from the repository root:

```bash
pnpm verify:self-host
```

The command builds `crumbtrail-core` and `crumbtrail-node`, starts built `dist/cli.cjs`, checks `/health`, triggers the deliberate Express demo failure, finalizes artifacts, and verifies linked `events.ndjson`, `index.json`, `llm.json`, `llm.md`, and MCP context. See [`examples/full-stack-express/README.md`](../../examples/full-stack-express/README.md) for expected output and troubleshooting.

## Fresh-install validation

Run the same local self-host behavior through a temporary standalone install:

```bash
pnpm verify:fresh-install
```

The verifier builds and packs `crumbtrail-core` and `crumbtrail-node`, installs the packed tarballs into a temporary npm project, resolves the installed `crumbtrail-server` binary, waits for ready `/health`, captures a deliberate failed request session, verifies `events.ndjson`, `index.json`, `llm.json`, `llm.md`, and shuts down cleanly. Passing output includes phase-specific status for package metadata/build, temp install, binary startup, health readiness, self-host artifact proof, and shutdown.

For final package validation, run all three packaged-runtime surfaces together:

```bash
pnpm --filter crumbtrail-node verify:package-runtime && pnpm verify:self-host && pnpm verify:fresh-install
```

## CLI subcommands

The same `crumbtrail-server` binary exposes subcommands beyond `serve`. Every subcommand accepts
`--help` / `-h` for focused help, and `crumbtrail-server --version` / `-v` prints the package version.

```bash
crumbtrail-server --version                     # print crumbtrail-node version
crumbtrail-server serve --help           # focused help for any subcommand
crumbtrail-server fix-context <sessionId> --json   # ranked, correlated, LLM-ready fix-context.v1 bundle
crumbtrail-server fix-context <sessionId>          # human-readable summary
crumbtrail-server inspect <sessionId>           # hot-plane-only session summary
crumbtrail-server inspect <sessionId> --json    # machine-readable summary
crumbtrail-server scan ./src --strict           # coverage scanner (CI gate); findings carry a suggested fix
crumbtrail-server doctor --port 9898            # verify capture + correlation + MCP-readability locally
```

`fix-context` and `inspect` accept either a bare session id (resolved under the sessions dir,
override with `--output`) or a path to a session directory. Both read hot-plane artifacts
only and never open the raw event log. `inspect` reports duration, event/error/failed-request
counts, candidate count, truncation state, and on-disk artifact sizes.

## MCP evidence tools

`crumbtrail-server serve --mcp` runs the stdio MCP server against the sessions directory. The
evidence-first tools are:

- `getFixContext(sessionId)` — the `fix-context.v1` bundle (`ranked_candidates`,
  `primary_window` with `frontend` / `backend` / `db_diffs`, `environment`, `repro_hint`).
- `getSessionManifest(sessionId)` (alias `get_session_manifest`) — manifest metadata,
  markers, timeline, candidates, `accessPattern`. Synthesizes a manifest from `index.json`
  for older sessions.
- `getWindow(sessionId, t0, t1)` (alias `get_window`) — cold events inside an absolute-ms
  window; bounded and capped (default/max 500) with truncation reporting. The only tool that
  reads the cold stream.
- `getEvidence(sessionId, ref)` (alias `get_evidence`) — resolve a candidate id,
  interactive-element signature, or request/event id from hot-plane artifacts.

## Database diffing

Four engine shims wrap a duck-typed driver object the host injects (no driver dependency is
ever imported) so INSERT/UPDATE/DELETE statements executed inside a request scope record a
`k:'db.diff'` event (`{ engine, op, table, pk, after, before?, requestId }`):

| Engine   | Wrap                                     | After-image strategy                                                           |
| -------- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| postgres | `instrumentPgClient(client, options)`    | appends `RETURNING *`                                                          |
| mysql    | `instrumentMysqlClient(client, options)` | post-`SELECT` by `insertId` / pk (no SQL rewriting)                            |
| mssql    | `instrumentMssqlPool(pool, options)`     | injects `OUTPUT INSERTED.*` / `DELETED.*` (rows stripped from the host result) |
| sqlite   | `instrumentSqliteDatabase(db, options)`  | post-`SELECT` by `lastInsertRowid` / pk (fully synchronous)                    |

All four take the same `InstrumentDbClientOptions` and share the same guarantees: the host
query never fails and never runs twice because of instrumentation — parse/correlation/capture/
emit failures degrade to "no diff emitted", and statements the shim cannot confidently handle
(multi-statement batches, comment-wedged SQL on mssql, multi-row MySQL inserts) fall back to an
image-less `db.diff` (`pk: null`, `rowCount`) so the write stays visible to differencing.
Sensitive columns are dropped before any event rests (`DEFAULT_SENSITIVE_DB_COLUMNS` =
`password`, `token`, `secret`, `api_key`, `ssn`; extend with `redactColumns`).
`captureBefore: true` also records UPDATE pre-images (and is how MySQL/SQLite before-images are
sourced); `captureReads: true` opts into capped `db.read` row capture. The events correlate by
`requestId` (= the request's trace id), so they land in the same evidence window, fill
`primary_window.db_diffs` in the fix-context bundle, and feed session db differencing across
all engines. Per-engine wiring examples: `docs/integrations/databases.md`.

## Headless job-run sessions

Queue workers, cron jobs, and batch runs can create a session without a browser:

```ts
import { startHeadlessSession } from "crumbtrail-node";

const session = await startHeadlessSession({
  endpoint: "http://127.0.0.1:9898",
  sessionId: `job-${Date.now()}`,
  metadata: {
    app: "billing-worker",
    release: process.env.RELEASE,
    build: process.env.GIT_SHA,
  },
});

await session.record({
  t: Date.now(),
  k: "con",
  d: { lv: "info", msg: "job started" },
});
await session.end();
```

If the job already exports OpenTelemetry, stamp spans/logs with the same
`crumbtrail.session.id`; Crumbtrail files those signals into the same agent-readable
session as logs and row diffs.

## Two-plane storage (operator note)

Finalized sessions are written across two planes under
`<output>/<sessionId>/`. The **hot plane** holds the small, redacted, AI-readable summaries an
LLM reads first — `manifest.json` (the entry point), `bundle.json`/`llm.json`, `index.json`,
`candidates.jsonl`, plus `llm.md`/`timeline.md` and `search.jsonl`. The **cold plane** holds
the full chronological event stream, zstd-compressed as `events.ndjson.zst`, alongside
`signatures.json` (the interactive-element signature dictionary) and any media
(`recording.webm`, `audio.webm`, `frames/`). Redaction runs **before** the cold write
(`cold.transcode.redaction: "sanitized-before-cold-write"`), and the cold event stream is
opened only when raw chronological evidence is required (zstd needs Node ≥ 22.15.0). The
manifest's `accessPattern` field documents this read order for tools and operators.

## Public API boundary

The package exports the server and integration primitives used by local self-host integrations:

- `createServer`
- `SessionManager`
- `McpServer`
- `createCrumbtrailExpressMiddleware`
- `createCrumbtrailExpressErrorMiddleware`

The `src/__tests__/package-boundary.test.ts` suite locks the package metadata, built CLI path, public exports, and default CLI configuration. The `src/__tests__/config.test.ts` and `src/__tests__/cli.test.ts` suites lock config validation and safe startup diagnostics. The `src/__tests__/health.test.ts` and server health tests lock health payload safety and degraded output-directory behavior.

## What this does not claim yet

This package is not yet a production/cloud hosting story. M003 proves local self-host packaging and fresh-install validation; later work can still expand deployment guides and hosted operations.

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **How it works** — https://crumbtrail.ai/how-it-works
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
