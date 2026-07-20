# Confluence spec oracle

Crumbtrail's evidence adapters answer **what happened**. The spec oracle answers
**what was supposed to happen**, by searching your Confluence pages — design
docs, runbooks, acceptance criteria, decision records.

It is not an evidence adapter, and it is not meant to become one. It does not
appear in `evidence-sources.md`, does not register with `evidenceSourcesFromEnv`,
and does not participate in the bundle fan-out. See
[`docs/specs/2026-07-19-confluence-spec-oracle-design.md`](../specs/2026-07-19-confluence-spec-oracle-design.md)
for why (no time window, no correlational join key, must not be ranked by
`assembleBundle`). The separation is enforced by
`packages/node/src/__tests__/knowledge-boundary.test.ts`, not by convention.

## Advisory only

A Confluence page **never** suppresses, downgrades, hides, or resolves a
finding. It annotates one. This is the same "advisory, never gating" guarantee
every Crumbtrail source carries, and documentation is the source most likely to
be quietly wrong — pages outlive the behavior they describe, and nobody updates
a runbook when they change the code.

Consequently every excerpt carries `lastModified`, `lastModifiedBy` (when the
page records it), and a derived `ageDays`. Staleness is surfaced to the caller
rather than reasoned about internally: the oracle reports what the page says and
when it was last touched, and the agent or human decides what that is worth.

## Configuration

Self-host credentials come from the environment only, never from a tool
argument. This matches the ticket-connector family (`JIRA_*`, `ZENDESK_*`,
`TRELLO_*`), which is why the variables are bare rather than namespaced.

| Variable | Required | Meaning |
|---|---|---|
| `CONFLUENCE_BASE_URL` | yes | Site wiki root, e.g. `https://acme.atlassian.net/wiki` |
| `CONFLUENCE_EMAIL` | yes | Atlassian account email — the HTTP Basic username |
| `CONFLUENCE_API_TOKEN` | yes | Atlassian API token — the HTTP Basic password |
| `CONFLUENCE_SPACE_KEYS` | no | Comma-separated space-key allowlist, e.g. `ENG,OPS` |

Set them in the environment running `crumbtrail-node` / the MCP server:

```bash
export CONFLUENCE_BASE_URL="https://<your-site>.atlassian.net/wiki"
export CONFLUENCE_EMAIL="you@example.com"
export CONFLUENCE_API_TOKEN="<api token>"

# Optional: bound every search to these spaces (comma-separated).
export CONFLUENCE_SPACE_KEYS="ENG,OPS"
```

The token is an Atlassian API token
(id.atlassian.com → Security → Create and manage API tokens) for an account with
read access to the spaces you want searched. Never commit it, and never pass it
as a tool argument — it is read exclusively from the environment, at the
boundary.

The oracle is configured **iff all three required variables are set to nonempty
strings**. A partial configuration is treated as not configured — it produces a
gap, never an error. Authentication is HTTP Basic (`email:token`, base64), and
every outbound request carries the shared `CRUMBTRAIL_USER_AGENT`.

When `CONFLUENCE_SPACE_KEYS` is set, every key must be alphanumeric or use an
underscore. A malformed, empty, or overlong configured allowlist disables
lookups until it is corrected. This fails closed, so a typo cannot broaden a
search to every readable space.

Confluence being unconfigured is a fully supported state. It disables the
`searchSpecs` lookup and nothing else.

### Checking it

`crumbtrail-server doctor` emits a `spec-oracle` line, kept separate from the
`evidence-source:*` lines so the two lists stay distinct:

```
spec-oracle  pass  Confluence spec oracle configured for https://acme.atlassian.net/wiki (credentials not verified); space allowlist: ENG, OPS
spec-oracle  warn  Confluence spec oracle not configured (missing CONFLUENCE_EMAIL, CONFLUENCE_API_TOKEN)
```

The check is presence-only — it makes no request, so it does not tell you
whether the token is *valid*, only whether it is set. That is a weaker claim
than an `evidence-source:*` line's `pass`, which follows a live authenticated
`health()` call; both render with the same `✓`, so the `spec-oracle` detail says
"(credentials not verified)" to keep the two apart. `CONFLUENCE_API_TOKEN` is
never printed, and the base URL is reduced to origin + path before it reaches
the report.

## Retrieval

The query is Confluence CQL against `GET /wiki/rest/api/content/search`:

```
text ~ "<sanitized query>" AND type = page
  [AND space.key IN (<allowlist>)]
ORDER BY lastModified DESC
```

`ORDER BY lastModified DESC` is a hedge, not relevance ranking: when several
pages match, the most recently touched one is the least likely to be stale.

**This is keyword search, not semantic search.** CQL `text ~` matches terms. A
page that describes the same behavior in different vocabulary than the ticket
will not be found. That is a known limit of this slice, not a bug.

### Limits

| Limit | Value |
|---|---|
| Query length | 512 **code points** (sliced by code point, not UTF-16 code unit) |
| Space keys accepted | 50 maximum; malformed caller keys are dropped |
| Results per call | `limit` clamped to 1..15; defaults to 5 |
| Per-request timeout | `DEFAULT_SOURCE_TIMEOUT_MS` (10s) |
| Excerpt size | 2000 UTF-8 **bytes** per excerpt |

One request, one page of results. There is no pagination walk. When a limit
actually discarded input — a truncated query, dropped space keys — the caller
gets an informational gap saying so, so a narrowed search is never silently
presented as a complete one.

### The space allowlist is a ceiling

`CONFLUENCE_SPACE_KEYS` is set by the operator and bounds every call. A caller
may pass `spaceKeys` to **narrow** the search within that ceiling; it can never
widen it. Caller keys are intersected with the operator list, never unioned.

Keys the operator's ceiling excluded are reported back as an informational gap
rather than being dropped silently, so a caller can tell "that space returned
nothing" apart from "you were not allowed to search that space".

With `CONFLUENCE_SPACE_KEYS` unset there is no ceiling, and every space the
account can read is in scope. On a large instance that produces noise; the
allowlist is the only control here, as this slice does no automatic relevance
filtering.

## Egress and redaction

- Every excerpt passes the shared redaction boundary
  (`evidence-sources/redact.ts`) before it is returned. Confluence runbooks
  routinely paste real credentials, so this is load-bearing.
- Every deep link is redacted on the same path.
- Errors are sanitized to status plus origin + path. The Basic credential lives
  in the `Authorization` header and reaches no message, gap, or excerpt.
- Zero-copy: nothing fetched from Confluence is persisted. Excerpts are returned
  to the caller and not written to storage.

## Degradation

`searchSpecs` always resolves. Missing credentials, `401`/`403`, timeout,
malformed JSON, an unusable query, and zero results are all normal results
carrying gaps — never a throw.

"No documented intent found" is a valid and useful answer, and is reported as an
informational gap rather than a source failure. Only the cases where the oracle
could not consult Confluence at all (not configured, auth failed, timed out,
request failed) are marked `source-unavailable`.

There is no retry. The oracle is agent-invoked and idempotent: the caller sees
the gap and can ask again, so paying retry latency inside an interactive tool
call buys nothing.

## Status of the API details

The CQL endpoint shape and response fields above are taken from Atlassian's
documented API and have **not been verified against a live Confluence account**.
Live smoke testing is a GA-gating manual item, consistent with how the existing
evidence adapters treat unverified provider-API details. Contract tests are
fixture-backed and CI makes zero live requests.

Hosted-tenant OAuth is a separate change in `packages/cloud` and is not part of
this integration. Connecting Confluence there is a second, optional
authorization against the same Atlassian app — it does not widen the Jira scope
set, so an existing Jira connector cannot be broken by enabling it.
