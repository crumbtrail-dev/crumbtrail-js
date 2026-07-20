# Evidence sources (query-at-incident-time adapters)

Crumbtrail can pull evidence from the observability tools you **already run** — no
re-instrumentation. When a ticket arrives (push webhook or MCP pull), Crumbtrail
locates the incident window, queries your configured sources for evidence inside
that window, normalizes each hit into the neutral `evidence.v1` contract, and
folds it into the same ranked bundle the SDK path produces. Adapter fetches are
**transient and zero-copy**: only the derived bundle is persisted
(`ticket_bundles`) — raw provider data never lands in Crumbtrail's storage.

A team that already runs Sentry + CloudWatch connects with two credentials and
their next Jira ticket gets an advisory bundle containing the Sentry errors and
CloudWatch log lines from the incident window — correlated by trace id where the
stack propagates W3C context, by time window where it doesn't, with the
difference stated plainly in the bundle's gap list.

## Two ways to get telemetry into a bundle — your choice

These coexist. Neither is a migration target for the other; pick per source.

|                  | **OTLP dual-export** (streaming)                                           | **Evidence adapter** (query-at-incident-time)                                     |
| ---------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| **How**          | You point an OTLP exporter at Crumbtrail; telemetry streams in continuously | Crumbtrail queries the provider's API/store only when a ticket arrives             |
| **Storage**      | Crumbtrail stores a copy of the streamed events (in sessions)               | Zero-copy — only the derived bundle persists; raw provider data is never retained |
| **Correlation**  | Rich: full session context, live traces                                    | Bounded to the located incident window + whatever join keys the ticket carries    |
| **Setup**        | An exporter/collector config in your stack                                 | A read credential per provider (token/key)                                        |
| **Cost profile** | Ingest + retention with Crumbtrail                                          | Provider-side query cost only; bounded fetches (byte/item caps)                   |
| **Best when**    | You want Crumbtrail to _be_ your telemetry store, or need always-on capture | You already have Sentry/CloudWatch/etc. and want zero re-instrumentation          |

Rule of thumb: if you want Crumbtrail to hold the telemetry, use **dual-export**;
if you want Crumbtrail to _consult_ the telemetry you already keep elsewhere, use
an **evidence adapter**. Many teams run both — e.g. dual-export for the front-end
SDK, adapters for their existing back-end Sentry + CloudWatch.

## The adapters

Each is a one-credential, read-only integration. Credentials are env-configured
on a self-host runtime (never passed as tool arguments); on the hosted cloud they
are sealed per-tenant. A source's absence or failure degrades to a **gap** in the
bundle, never an error — "inconclusive" is a valid outcome.

| Provider   | Lanes         | Join keys (best-first)            | Adapter doc                                                   |
| ---------- | ------------- | ---------------------------------- | -------------------------------------------------------------- |
| Sentry     | logs, code    | traceId, time, release, url, user | [sentry-evidence-adapter.md](./sentry-evidence-adapter.md)     |
| CloudWatch | logs          | requestId, traceId, time, service | [cloudwatch.md](./cloudwatch.md)                                |
| Splunk     | logs          | traceId, requestId, time, service | [splunk-evidence-adapter.md](./splunk-evidence-adapter.md)     |
| Datadog    | logs, network | traceId, time, service, url       | [datadog-evidence-adapter.md](./datadog-evidence-adapter.md)   |
| PostHog    | browser, flow | user, sessionId, url, time        | [posthog.md](./posthog.md)                                     |
| Cloudflare | network, logs | requestId, url, time              | [cloudflare.md](./cloudflare.md)                                |

Sentry, Splunk, and Datadog also have a separate **OTLP dual-export recipe**
doc — [sentry.md](./sentry.md), [splunk.md](./splunk.md),
[datadog.md](./datadog.md) — for the *other* way to get their telemetry into
Crumbtrail (the streaming option in the table above this one). Those three
recipe docs are generated from `packages/node/src/provider-recipes.ts` and kept
in lockstep by `scripts/verify-integration-docs.mjs` (`pnpm
verify:integration-docs`), so they intentionally carry **no** evidence-adapter
content — that's why each of those three providers' evidence adapter has its
own `*-evidence-adapter.md` file instead of a section appended to the recipe
doc. (An earlier version appended the adapter section directly to the recipe
doc; a later `--write` run of that generator overwrote the file and silently
deleted it. Do not re-append evidence-adapter content into sentry.md /
splunk.md / datadog.md — the generator will delete it again the next time it
runs.)

Full env-var reference: [`.env.example`](../../.env.example) (the
`Provider-agnostic adapters` block). Implementation brief:
[`docs/briefs/evidence-adapters-brief.md`](../briefs/evidence-adapters-brief.md).

### Not on this list: the Confluence spec oracle

Confluence is **deliberately not** one of the adapters above. Every source in
that table answers *what happened* — it carries a time window and at least one
correlational join key, and its results are ranked into the bundle. A Confluence
page answers *what was supposed to happen*: it has neither a time window nor a
join key, and it must not be ranked alongside telemetry.

So it lives in `packages/node/src/knowledge/`, registers nothing with
`evidenceSourcesFromEnv`, and never appears in the bundle fan-out. It is reached
only through the `searchSpecs` tool, and `crumbtrail-server doctor` reports it on
its own `spec-oracle` line rather than an `evidence-source:*` one.

Adding a seventh row to the table above for it would be a mistake — one the
adapter framework makes easy and
`packages/node/src/__tests__/knowledge-boundary.test.ts` exists to fail. See
[confluence-spec-oracle.md](./confluence-spec-oracle.md).

### Join-key poverty is the norm

Most stacks do not propagate a W3C `traceparent` end-to-end, so many fetches fall
back to a **time-window-only** scan and are noisier. Crumbtrail does not widen the
window to compensate; instead each adapter emits an honest gap
("filtered by time only — stamp correlation keys to tighten this"). That gap
doubles as the signal to stamp correlation keys (or install the SDK) so future
tickets correlate precisely.

## Live smoke checklist (GA-pending)

The adapter contract tests run against **recorded fixtures** (zero live API calls
in CI), so the following provider-API details are pinned to the documented shapes
but have **not yet been verified against a live account**. Run one manual smoke
per provider against a real tenant before GA:

- **Datadog** — confirm the Spans Search v2 `attributes` field names and the
  `start_timestamp` unit, and that Logs/Spans `filter.from`/`filter.to` accept
  epoch-milliseconds as sent.
- **Splunk** — confirm `results_preview` completion semantics (when the job is
  done vs. still previewing) and the token auth header (`Authorization: Bearer`).
- **PostHog** — confirm the events endpoint
  (`GET /api/projects/{id}/events/` with a `properties` JSON filter plus
  `after`/`before`/`distinct_id`) and the `session_recordings/` list filters
  (`distinct_id` / `session_ids`).
- **CloudWatch** — confirm the Logs Insights status strings
  (`Running`/`Complete`/`Failed`/`Cancelled`/`Timeout`) and the console
  deep-link format for a log group.
- **Sentry** — confirm `start`/`end` behavior vs. `statsPeriod` (they are
  mutually exclusive as sent) and the issue permalink format.
- **Cloudflare** — confirm R2's SigV4-for-`s3` signing, the Logpush object-key
  layout (`<prefix>/YYYYMMDD/…_<hash>.log.gz`), and gzip decoding of the NDJSON
  objects, against a real Logpush-to-R2 sink.

These are manual GA-gating smoke items, not blockers for the fixture-backed
contract suite.

## Guarantees

- **Advisory, never gating.** A dead/misconfigured/slow source degrades to a gap
  within its timeout; the bundle still assembles.
- **Neutral evidence.** Adapters contribute to `evidence` only — ranking/opinion
  happens once, downstream, in the single fusion path.
- **Redaction at the boundary.** Every adapter result passes the redaction
  boundary before anything is retained or bundled.
- **Egress discipline.** Bounded fetches, byte/item caps, no pagination walks
  beyond the limit. (Cloudflare R2 reads are the one "bulk is fine" case — R2
  egress is free — but are still bounded by the same caps.)
- **Zero-copy storage.** No provider payload bytes persist anywhere; only the
  derived `ticket_bundles` row grows.
