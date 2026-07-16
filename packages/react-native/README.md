# crumbtrail-react-native

React Native / Expo SDK for Crumbtrail session capture. Same event pipeline as
the browser SDK (`crumbtrail-core`) — errors, network, console, app-state,
navigation, environment, and a replay-lite view-tree snapshot — wired for a
React Native runtime instead of the DOM.

## Install

### Fastest path: the setup wizard

From your app's root:

```bash
npx crumbtrail
```

(Pre-npm-publish, the same wizard runs via `curl -fsSL https://app.crumbtrail.ai/install.sh | sh`,
which resolves to `npx --yes <cli-tarball-url>` — the identical wizard, just
fetched from the deploy instead of the npm registry.)

The wizard detects a React Native / Expo app by the presence of a `react-native`
or `expo` dependency, installs `crumbtrail-core` + `crumbtrail-react-native`
with your project's package manager, and prepends a
`createReactNativeCrumbtrail(...)` init block to the first entry file it finds,
in this order:

1. `app/_layout.{tsx,jsx,js}` — the Expo Router root layout
2. `src/app/_layout.{tsx,jsx,js}` — the same layout under a `src/` dir (where
   `create-expo-app`'s current default template puts it)
3. `App.{tsx,jsx,ts,js}` — the classic Expo / bare-RN root component
4. `index.{js,ts}` — the bare-RN `AppRegistry` entry

If none of those exist, the wizard prints the snippet in [Setup](#setup) below
for you to wire in by hand instead of guessing at a file.

**Registry-install fallback.** If `<package manager> add crumbtrail-core
crumbtrail-react-native` fails against the npm registry (these SDK packages are
not guaranteed to be public yet, and a self-hosted deploy has no public
registry mirror at all), the wizard automatically re-installs from the deploy's
own packed tarballs — discovered via `GET <base>/install/manifest.json` and
fetched from `GET <base>/install/<package>-<version>.tgz` — with no separate
step required. `crumbtrail-react-native` is packed as an **optional** SDK
channel (alongside `crumbtrail-react` and `crumbtrail-tauri`): a broken/missing
pack for it only disables that fallback, it never blocks the core install.

### Manual install

```bash
npm i crumbtrail-core crumbtrail-react-native
```

If that fails because the packages aren't on the registry yet (or you're on a
self-hosted deploy), install the same tarballs the wizard's fallback uses,
directly:

```bash
curl -fsSL <your-deploy-base-url>/install/manifest.json   # lists the current tarball filenames
npm i <your-deploy-base-url>/install/crumbtrail-core-<version>.tgz \
      <your-deploy-base-url>/install/crumbtrail-react-native-<version>.tgz
```

Working from a local checkout of this repo instead of a deploy, pack and
install from the checkout:

```bash
pnpm pack:local --out ./packed
npm i ./packed/crumbtrail-core-0.1.0.tgz ./packed/crumbtrail-react-native-0.1.0.tgz
```

### Peer dependencies

Required: `react` >=18, `react-native` >=0.72.

Optional — each is capability-detected at runtime and its collector degrades
cleanly (reported in the `rn.capabilities` event) rather than throwing when
absent:

| Package                                     | Version | Enables                                         |
| ------------------------------------------- | ------: | ----------------------------------------------- |
| `@react-native-async-storage/async-storage` |  >=1.17 | Session persistence across app restarts         |
| `@react-navigation/native`                  |     >=6 | Route-change (navigation) events                |
| `react-native-view-shot`                    |     >=3 | Crash screenshot for replay-lite view snapshots |

## Setup

### What the wizard writes

```ts
import { createReactNativeCrumbtrail } from "crumbtrail-react-native";

createReactNativeCrumbtrail({
  config: {
    httpEndpoint: "https://app.crumbtrail.ai", // or your self-host endpoint
    httpAuthToken: "<project api key>",
  },
});
```

This is the full setup, not a subset: `createReactNativeCrumbtrail` calls
`Crumbtrail.init`, installs the global `ErrorUtils` crash handler, and starts
every capability-gated collector. It is prepended imperatively (no
`<Provider>` wrapper) because the wizard's injector only ever prepends a block
or creates a file — it cannot transform JSX.

### Manual setup (self-host)

```ts
import { createReactNativeCrumbtrail } from "crumbtrail-react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";

createReactNativeCrumbtrail({
  config: { httpEndpoint: "http://127.0.0.1:9898" }, // local crumbtrail-server
  asyncStorage: AsyncStorage, // optional — enables session persistence
});
```

If you pass `asyncStorage`, prefer `createReactNativeCrumbtrailAsync` instead
so the session store hydrates before the logger starts:

```ts
import { createReactNativeCrumbtrailAsync } from "crumbtrail-react-native";

const { logger } = await createReactNativeCrumbtrailAsync({
  config: { httpEndpoint: "http://127.0.0.1:9898" },
  asyncStorage: AsyncStorage,
});
```

### React context (optional)

To read the logger from components via a hook instead of module-level state:

```tsx
import {
  CrumbtrailReactNativeProvider,
  useCrumbtrailReactNative,
} from "crumbtrail-react-native";

function Root() {
  return (
    <CrumbtrailReactNativeProvider
      config={{ httpEndpoint: "http://127.0.0.1:9898" }}
      asyncStorage={AsyncStorage}
    >
      <App />
    </CrumbtrailReactNativeProvider>
  );
}

function SomeScreen() {
  const { logger, capabilities } = useCrumbtrailReactNative();
  // ...
}
```

### Error boundary + component state

```tsx
import {
  CrumbtrailReactNativeErrorBoundary,
  useBugState,
} from "crumbtrail-react-native";

function Screen({ logger, cart }) {
  useBugState(logger, "cart", cart); // redacted state snapshot on the next event

  return (
    <CrumbtrailReactNativeErrorBoundary logger={logger}>
      <ScreenContent />
    </CrumbtrailReactNativeErrorBoundary>
  );
}
```

`useBugState` and the error boundary both redact sensitive-looking keys/values
(tokens, passwords, cookies, etc.) before the snapshot is recorded.

## What gets captured

RN-specific collectors, each capability-gated and independently toggleable via
`createReactNativeCrumbtrail({ collectors: { ... } })`:

- `console` — console patch
- `errors` — `ErrorUtils` global handler + the error boundary above
- `network` — `fetch` / `XMLHttpRequest` patch
- `appState` — foreground/background/terminate transitions
- `environment` — platform, dimensions, device/OS/app version
- `navigation` — route changes (requires `@react-navigation/native`)
- `replayLite` — periodic serialized view-tree snapshot + touch overlay
  (crash screenshot requires `react-native-view-shot`)

`crumbtrail-core`'s own DOM-bound collectors (interactions, keystrokes, scroll,
clipboard, cookies, storage, performance, video, audio, widget) are disabled by
default in the React Native preset — there is no DOM to instrument.

## Verify

Point the same `crumbtrail-server doctor` used for the browser/node SDK at
your self-host server after reproducing an issue in the app:

```bash
crumbtrail-server doctor --port 9898
```

On the cloud path, the wizard itself polls for the first real event after
setup (skip with `--skip-verify`).

## Requirements

- React Native >=0.72 (bare or Expo, managed or bare workflow)
- React >=18

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **How it works** — https://crumbtrail.ai/how-it-works
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
