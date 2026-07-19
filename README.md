# Crumbtrail

Crumbtrail captures the context a coding agent needs to actually fix a bug —
the session, the signals, and the evidence around a failure — and hands it over
in a form an agent can act on.

This repository holds the open-source SDKs and CLI. The hosted Crumbtrail cloud
is a separate, closed-source service; these packages talk to it, but none of
them require it.

## Packages

| Package | Description |
| --- | --- |
| [`crumbtrail`](packages/cli) | CLI. `npx crumbtrail` walks you through installing and wiring up the SDK. |
| [`crumbtrail-core`](packages/core) | Framework-agnostic capture engine: collectors, redaction, signals, evidence fusion. No dependencies. |
| [`crumbtrail-node`](packages/node) | Node.js server: session store, evidence sources, the local dashboard. |
| [`crumbtrail-react`](packages/react) | React bindings. |
| [`crumbtrail-react-native`](packages/react-native) | React Native bindings. |
| [`crumbtrail-tauri`](packages/tauri) | Tauri (Rust desktop) bindings. |
| [`crumbtrail-install-shared`](packages/install-shared) | Install recipes and agent prompts shared by the CLI and the dashboard. |
| [`crumbtrail-detect-core`](packages/detect-core) | Framework detection and injection planning, shared by the CLI and cloud automation. Reads only and writes nothing. |

## Quick start

```bash
npx crumbtrail
```

The wizard detects your stack, installs the right packages, and injects the
setup code for you. For Express backends it wires both crash capture and the
request and error middleware, so backend request spans link up with frontend
sessions out of the box.

To wire it up by hand:

```bash
npm install crumbtrail-core
```

```ts
import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";

Crumbtrail.init({
  ...PRESET_PASSIVE,
  httpEndpoint: "https://api.crumbtrail.ai",
  httpAuthToken: process.env.CRUMBTRAIL_KEY,
});
```

## Examples

Runnable end-to-end examples live in [`examples/`](examples):

- [`basic`](examples/basic) — the smallest possible browser setup.
- [`full-stack-express`](examples/full-stack-express) — browser + Express server, correlated.
- [`full-stack-otel`](examples/full-stack-otel) — the same, exporting over OTLP.
- [`headless-job`](examples/headless-job) — capture inside a background job, no browser.

## Development

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT — see [LICENSE](LICENSE).
