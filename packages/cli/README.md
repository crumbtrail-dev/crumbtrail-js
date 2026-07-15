# crumbtrail

The setup wizard for [Crumbtrail](https://crumbtrail.dev). It finds your app, wires
in the SDK, and confirms the first event actually arrives — so you don't have to
read an integration guide to get started.

```bash
npx crumbtrail
```

That's the whole install. There's nothing to add to `package.json` first.

## What it does

Running `npx crumbtrail` walks the full path in one pass:

1. **Detects** your stack — Next.js, Vite, React, Vue, Svelte, Express, Hono, Node,
   and non-JS services like Django, Rails, Go and .NET.
2. **Logs you in** (opens a browser, or use `--no-browser` for a device code).
3. **Provisions** a project and service, and mints an ingest key.
4. **Installs** the right SDK package and **injects** the setup code into your entry
   file. This is the only step that writes to your repo, and it always runs last.
5. **Verifies** the wiring end to end, then waits for your first real event.

In a monorepo, run it from the repo root: it scans every workspace and service,
shows you what it found, and wires the ones you pick.

## Usage

```
crumbtrail [options]        Run the setup wizard (detect → login → wire → verify)
crumbtrail login           Log in and cache a token, nothing else
crumbtrail logout          Delete the cached token
```

| Option | Description |
| --- | --- |
| `--yes`, `-y` | Skip confirmations (required with `--project` in CI) |
| `--project <id>` | Attach to an existing project instead of creating one |
| `--only <name>` | Monorepo: wire only this service (repeatable) |
| `--all` | Monorepo: wire every service it can, no prompts |
| `--workspace <dir>` | Wire just one package dir instead of the whole repo |
| `--no-browser` | Use the device-code login flow |
| `--skip-verify` | Don't wait for the first event |
| `--endpoint <url>` | Cloud endpoint (else `$CRUMBTRAIL_BASE_URL`, else the default) |
| `--version`, `-v` | Print the version |

### Non-interactive / CI

Outside a TTY the wizard refuses to guess. Pass `--yes` and an existing
`--project <id>`:

```bash
npx crumbtrail --yes --project prj_1234abcd --only web --skip-verify
```

## What it writes

Only one kind of change, in the package it's wiring:

- the SDK import and `Crumbtrail.init(...)` call in your entry file

The wizard is **hands-off with your ingest key**: it never writes the key to a
file. The injected code reads it from a framework-appropriate environment
variable, and the wizard tells you which one to set — for example
`NEXT_PUBLIC_CRUMBTRAIL_KEY` (Next), `VITE_CRUMBTRAIL_KEY` (Vite / SvelteKit /
Nuxt / Remix), `PUBLIC_CRUMBTRAIL_KEY` (Astro), `EXPO_PUBLIC_CRUMBTRAIL_KEY`
(Expo / React Native), or `CRUMBTRAIL_KEY` (Node backends). Mint the key in the
dashboard and set that variable in your own `.env`, so a live credential never
lands in committed source.

It won't touch a package that is already wired, and it never edits libraries or
config-only packages.

## Prefer to wire it by hand?

Nothing here is magic — see [`crumbtrail-core`](https://www.npmjs.com/package/crumbtrail-core)
for the three-line manual setup.

## Links

- **Website** — https://crumbtrail.dev
- **Docs** — https://crumbtrail.dev/docs
- **How it works** — https://crumbtrail.dev/how-it-works
- **Pricing** — https://crumbtrail.dev/pricing
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-js
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-js/issues

## License

MIT
