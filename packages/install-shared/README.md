# crumbtrail-install-shared

Internal building block for [Crumbtrail](https://crumbtrail.ai). It holds the
install recipes, OTLP facts and agent prompts that the `crumbtrail` CLI and the
Crumbtrail dashboard both read, so the setup instructions you see in your terminal
and the ones you see in the browser can't drift apart.

**You almost certainly don't need to install this directly.** To set up Crumbtrail
in your app, run:

```bash
npx crumbtrail
```

It's published because both the open-source CLI and the hosted dashboard depend on
it — not because it's a useful standalone API. It has no stability guarantees.

## What's in it

- `getInstallVariant(stack)` / `allStackInstalls()` — which install path a stack takes
  (JS SDK, OTLP, or infrastructure).
- `buildAgentPrompt(stack, keys)` — the copy-paste prompt handed to a coding agent
  to wire Crumbtrail up.
- `buildOtlpSnippets(...)` and `OTLP_CAPABILITY_FACTS` — endpoint paths, protocols
  and auth headers for OpenTelemetry exporters. These are kept in lockstep with the
  real ingest routes by a consistency test.

## Links

- **Website** — https://crumbtrail.ai
- **Docs** — https://crumbtrail.ai/docs
- **Source** — https://github.com/CrumbtrailDev/crumbtrail-cli
- **Issues** — https://github.com/CrumbtrailDev/crumbtrail-cli/issues

## License

MIT
