# crumbtrail-react

React bindings for [Crumbtrail](https://crumbtrail.ai): catch render errors with
the session attached, and record component state so a bug report carries the state
the component was actually in when it broke.

## Install

```bash
npm install crumbtrail-react crumbtrail-core
```

Or let the wizard do it:

```bash
npx crumbtrail
```

This package needs `crumbtrail-core` initialised first — see
[`crumbtrail-core`](https://www.npmjs.com/package/crumbtrail-core) for that
three-line setup. React 18 or newer.

## Error boundary

Wrap a subtree so a render error is flagged as a bug with the surrounding session
already captured:

```tsx
import { Crumbtrail, PRESET_PASSIVE } from "crumbtrail-core";
import { CrumbtrailErrorBoundary } from "crumbtrail-react";

const crumbtrail = Crumbtrail.init({
  ...PRESET_PASSIVE,
  httpEndpoint: "https://api.crumbtrail.ai",
  httpAuthToken: process.env.CRUMBTRAIL_KEY,
});

export function App() {
  return (
    <CrumbtrailErrorBoundary logger={crumbtrail} fallback={<p>Something broke.</p>}>
      <Checkout />
    </CrumbtrailErrorBoundary>
  );
}
```

| Prop | Type | Description |
| --- | --- | --- |
| `logger` | `Crumbtrail` | The instance returned by `Crumbtrail.init()`. |
| `children` | `ReactNode` | The subtree to guard. |
| `fallback` | `ReactNode` | Optional UI to render after an error. |

## Capturing state

`useBugState` registers a value so it's attached to any bug flagged while the
component is mounted:

```tsx
import { useBugState } from "crumbtrail-react";

function Checkout({ crumbtrail }) {
  const [cart, setCart] = useState([]);
  const [step, setStep] = useState("address");

  useBugState(crumbtrail, "cart", cart);
  useBugState(crumbtrail, "step", step);

  // ...
}
```

Values are **redacted by default** using the same policy as the rest of the SDK, so
a state field called `token` or `password` never leaves the browser in the clear.
Pass `{ captureRawState: true }` as the fourth argument only when you're certain the
value is safe.

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **How it works** — https://crumbtrail.ai/how-it-works
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
