# crumbtrail-core

The capture engine behind [Crumbtrail](https://crumbtrail.ai). It records what
actually happened around a bug — the console, the network calls, the DOM
interactions, the state — and hands it over as evidence a coding agent can act on,
instead of a screenshot and a vague repro.

Framework-agnostic, with **no dependencies**.

## Install

```bash
npm install crumbtrail-core
```

Or let the wizard install and wire it for you:

```bash
npx crumbtrail
```

## Setup

Call `Crumbtrail.init()` once, at your app's entry point:

```ts
import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";

Crumbtrail.init({
  ...PRESET_PASSIVE,
  httpEndpoint: "https://api.crumbtrail.ai",
  httpAuthToken: process.env.CRUMBTRAIL_KEY,
});
```

That's the whole integration — capture runs in the background from there.

### Presets

| Preset | Behaviour |
| --- | --- |
| `PRESET_PASSIVE` | Capture continuously and auto-flag on errors and signals. The default. |
| `PRESET_LIGHT` | Leaner capture, less overhead. |
| `PRESET_FULL` | Everything, for a heavy debugging session. |

### Flagging a bug yourself

`init()` returns the instance, so you can mark moments explicitly:

```ts
const crumbtrail = Crumbtrail.init({ ...PRESET_PASSIVE, httpEndpoint });

crumbtrail.mark("checkout: submitted");

await crumbtrail.flagBug({
  note: "Payment failed with no error toast",
  tags: ["checkout"],
});
```

Also on the instance: `addEvent`, `registerStateProvider`, `setEnv`,
`createRequestHeaders`, `pause`, `resume`, `stop`, `getSessionId`.

## Redaction is on by default

Crumbtrail is meant to be pointed at real traffic, so scrubbing isn't opt-in.
Tokens, cookies, storage values and sensitive input values are redacted before an
event ever leaves the browser. See `BROWSER_REDACTION_POLICY` and the `redact*`
helpers if you want to inspect or tighten the policy.

## Related packages

| Package | Use it for |
| --- | --- |
| [`crumbtrail`](https://www.npmjs.com/package/crumbtrail) | The `npx crumbtrail` setup wizard |
| [`crumbtrail-node`](https://www.npmjs.com/package/crumbtrail-node) | Self-hosted server, Express middleware, MCP evidence tools |
| [`crumbtrail-react`](https://www.npmjs.com/package/crumbtrail-react) | React error boundary and state-capture hook |
| [`crumbtrail-react-native`](https://www.npmjs.com/package/crumbtrail-react-native) | React Native bindings |
| [`crumbtrail-tauri`](https://www.npmjs.com/package/crumbtrail-tauri) | Tauri desktop bindings |

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **How it works** — https://crumbtrail.ai/how-it-works
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
