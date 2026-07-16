# crumbtrail-core

The capture engine behind [Crumbtrail](https://crumbtrail.dev). It records what
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
  httpEndpoint: "https://api.crumbtrail.dev",
  httpAuthToken: process.env.CRUMBTRAIL_KEY,
});
```

That's the whole integration — capture runs in the background from there.

### Presets

| Preset           | Behaviour                                                              |
| ---------------- | ---------------------------------------------------------------------- |
| `PRESET_PASSIVE` | Capture continuously and auto-flag on errors and signals. The default. |
| `PRESET_LIGHT`   | Leaner capture, less overhead.                                         |
| `PRESET_FULL`    | Everything, for a heavy debugging session.                             |

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

Crumbtrail is meant to be pointed at real traffic, so scrubbing is not opt in.
Tokens, cookies, storage values, page text, input values, and database row values
are redacted before an event enters the browser buffer. See
`BROWSER_REDACTION_POLICY` and the `redact*` helpers if you want to inspect or
tighten the policy.

## Production capture

Page text, input values, keystrokes, clipboard content, DOM snapshots, and
database row values are masked before they enter the local ring buffer. Add
`data-crumbtrail-unmask` to one element when its text or value is safe to
capture. Add `data-crumbtrail-block` to exclude an element and its descendants
entirely.

Remote capture policy can only add masking. Clear text or values are captured
only when `data-crumbtrail-unmask` is added to that individual safe element.

For consent managed applications, begin capture only after your consent manager
grants permission:

```ts
const crumbtrail = Crumbtrail.init({
  consentMode: "required",
  configEndpoint: "https://capture.example.com/config",
  projectKey: "project_123",
});

crumbtrail.consent(true);
crumbtrail.identify({ accountId: "account_123", userId: "user_456" });
await crumbtrail.flag();
```

Global Privacy Control is respected by default. Email shaped identifiers are
discarded by `identify`.

Set `flightRecorder: true` to buffer locally until an error, signal, widget
action, or `flag()` triggers capture. The recorder adds the configured tail
before finalizing the report. A cloud config response can disable capture with
`killSwitch: true`; the SDK clears its buffer as soon as that response arrives.

## Related packages

| Package                                                                            | Use it for                                                 |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [`crumbtrail`](https://www.npmjs.com/package/crumbtrail)                           | The `npx crumbtrail` setup wizard                          |
| [`crumbtrail-node`](https://www.npmjs.com/package/crumbtrail-node)                 | Self-hosted server, Express middleware, MCP evidence tools |
| [`crumbtrail-react`](https://www.npmjs.com/package/crumbtrail-react)               | React error boundary and state-capture hook                |
| [`crumbtrail-react-native`](https://www.npmjs.com/package/crumbtrail-react-native) | React Native bindings                                      |
| [`crumbtrail-tauri`](https://www.npmjs.com/package/crumbtrail-tauri)               | Tauri desktop bindings                                     |

## Links

- **Website** — https://crumbtrail.dev
- **Docs** — https://crumbtrail.dev/docs
- **How it works** — https://crumbtrail.dev/how-it-works
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
