# Ticket connector setup (Jira / Zendesk / Trello)

`solveContext` can accept `ticket: { provider, id }` instead of a hand-typed
`symptom`, fetching the ticket and normalizing it into a `Symptom` (title,
description, url, release, source) that feeds the same fusion pipeline.

## What to provision

Pick the provider(s) you use. Each needs a read-only credential — no write
scope is required, since Crumbtrail only fetches a single ticket/issue/card by
id.

### Jira

- A Jira API token (Atlassian account → Security → API tokens) for the email
  address used to authenticate, scoped to read access on the target project.
- Env vars:

  ```bash
  export JIRA_BASE_URL="https://<your-site>.atlassian.net"
  export JIRA_EMAIL="you@example.com"
  export JIRA_API_TOKEN="<api token>"
  ```

- Crumbtrail calls `GET {JIRA_BASE_URL}/rest/api/3/issue/{id}` with HTTP Basic
  auth (`email:token`, base64-encoded).

### Zendesk

- A Zendesk API token (Admin Center → Apps and integrations → APIs → Zendesk
  API → Token access) for an agent with read access to tickets.
- Env vars:

  ```bash
  export ZENDESK_SUBDOMAIN="<your-subdomain>"
  export ZENDESK_EMAIL="you@example.com"
  export ZENDESK_API_TOKEN="<api token>"
  ```

- Crumbtrail calls `GET https://{ZENDESK_SUBDOMAIN}.zendesk.com/api/v2/tickets/{id}.json`
  with HTTP Basic auth (`email/token:api_token`, base64-encoded).

### Trello

- A Trello API key + token pair (trello.com/app-key) with read access to the
  target board.
- Env vars:

  ```bash
  export TRELLO_KEY="<api key>"
  export TRELLO_TOKEN="<api token>"
  ```

- Crumbtrail calls `GET https://api.trello.com/1/cards/{id}?key={key}&token={token}`.

## How credentials reach the engine

Set the env vars above in the environment running `crumbtrail-node` / the MCP
server.

- Never commit these tokens to source control.
- Never pass them as a `solveContext` tool argument — the tool only accepts
  `ticket: { provider, id }`; every credential is read exclusively from the
  environment, at the boundary.

## Without credentials (graceful degradation)

If the env vars for the requested provider are missing, or the ticket fetch
otherwise fails (network error, 404, etc.), `solveContext` never throws.
Instead:

- If a `symptom` was also passed alongside `ticket`, the tool falls back to
  that passed symptom and proceeds normally.
- Otherwise, it emits a `{ lane: 'network', reason: 'ticket fetch failed: ...',
suggestion: 'check connector credentials' }` gap and proceeds with a
  minimal symptom (title from the ticket id), so the bundle is still
  returned — just with a visible gap instead of a crash.
- If neither `symptom` nor `ticket` is passed at all, the tool returns a
  bundle with a single gap explaining that a symptom or ticket is required,
  and an `inconclusive` hypothesis — never a throw.

## Pull a stored bundle by URL (cloud)

Everything above is the **self-host** path, where credentials come from the
environment. On a hosted **cloud** deployment there is a second, faster path: a
coding agent can hand `solveContext` a **pasted ticket URL** and get back the
bundle that was already assembled for that ticket (see the Jira webhook below),
with no local fetch at all.

- `ticket` accepts a URL string as well as `{ provider, id }`. Recognized forms:
  - Jira: `https://<site>.atlassian.net/browse/<KEY>` or
    `…/rest/api/<n>/issue/<idOrKey>`
  - Zendesk: `https://<subdomain>.zendesk.com/agent/tickets/<id>` or
    `…/api/v2/tickets/<id>.json`
  - Trello: `https://trello.com/c/<shortLink>/…` or
    `https://api.trello.com/1/cards/<id>`
- The URL is parsed **locally, with zero network calls** — it only tells
  Crumbtrail _which_ ticket, never _how_ to reach it. The pasted origin is never
  contacted.
- When `CRUMBTRAIL_CLOUD_URL` + `CRUMBTRAIL_API_KEY` are set, `solveContext` first
  asks the cloud (`GET /api/bundles/by-ticket?provider=&key=`, authenticated with
  your project API key). On a hit it returns the stored bundle directly. On a
  miss, an unconfigured cloud, or any transport error it falls back to the local
  fetch + auto-locate path unchanged — the pull is a fast path, never a hard
  dependency. An unrecognized URL is an honest miss (a gap), never an error.

## Jira webhook (cloud, hands-free)

The cloud can also assemble a bundle **automatically** the moment a Jira issue is
created, and (optionally) post an advisory comment back to the ticket. This is
what populates the by-ticket store the pull-path reads.

1. **Connect Jira in the dashboard.** A tenant authorizes its Jira connector one
   way: **Connect with Atlassian (OAuth 3LO)**. One click runs the Atlassian
   consent flow; the cloud stores rotating access/refresh tokens sealed at rest.
   Nothing to paste, and the access token auto-refreshes.

   > **Why no "paste an API token" option on the cloud?** Atlassian's
   > [third-party integration guidance](https://www.atlassian.com/blog/developer/building-secure-and-scalable-integrations-our-guidance-for-third-party-apps)
   > forbids a distributed third-party service from instructing customers to
   > generate an Atlassian API token that the service then stores. The hosted
   > cloud therefore authorizes **only** via OAuth 3LO. (Self-host is different —
   > see below — because there the operator supplies and holds their own token;
   > it is not third-party credential storage.)

   In the dashboard you also set a **webhook secret** (Crumbtrail's own shared
   secret for verifying Jira webhook deliveries — not an Atlassian credential).
   Project filter and hold-in-reserve are non-secret; the OAuth tokens and the
   webhook secret are **sealed at rest per tenant** (AES-256-GCM) and are
   **write-only** — once saved they are never read back, and the form clears the
   secret field.

2. **Generate the webhook secret.** Use a high-entropy random value:

   ```bash
   openssl rand -hex 32
   ```

   Paste the same value into (a) the dashboard's "Webhook secret" field and
   (b) Jira's webhook configuration UI.

3. **Register the webhook in Jira.** Point a `jira:issue_created` webhook at your
   tenant's receiver URL:

   ```text
   POST https://<your-cloud-host>/api/webhooks/jira/<tenantId>
   ```

   You don't have to assemble this by hand — once the connector is saved, the
   **Connect Jira** panel shows your exact **Webhook URL** as a read-only,
   copyable value (it embeds your tenant id). Copy it straight into Jira's
   webhook configuration.

   Enable HMAC signing. Jira signs the raw request body and sends
   `X-Hub-Signature: sha256=<hmac>`; the cloud verifies it against your sealed
   webhook secret **before** parsing the body. Every verification failure
   (unknown tenant, wrong signature, missing signature) returns the **same**
   generic 404, so the endpoint is not an existence oracle. The `<tenantId>`
   segment is only a routing hint — it carries no authority on its own.

4. **What happens on a valid delivery.** The cloud normalizes the issue, locates
   the matching recorded session, assembles a bundle, stores it keyed by
   `(tenant, provider, ticket key)`, and posts an advisory comment linking the
   bundle. Redeliveries are idempotent (one bundle row, no duplicate comment).

### Authorizing the cloud connector (OAuth 3LO)

A hosted tenant authorizes its Jira connector via **OAuth 3LO** — the only method
the cloud supports (see the compliance note above). The cloud runs the standard
Atlassian consent flow (`auth.atlassian.com/authorize` → code → token exchange),
discovers the site's `cloudId` from `accessible-resources`, and stores the
**rotating** access + refresh tokens sealed at rest. API calls go through the
gateway (`https://api.atlassian.com/ex/jira/{cloudId}/rest/api/3/...`) with a
Bearer token. The access token lives ~1 hour and is refreshed automatically ~2
minutes before it expires; each refresh returns a **new** refresh token and
invalidates the old one (rotation), so there is nothing to renew by hand.

Every outbound Atlassian/Jira request also carries a descriptive
`User-Agent: Crumbtrail/… (integrations@crumbtrail.ai)` so the integration
identifies its source transparently, as Atlassian's guidance requires.

| Authorization state                                      | Lifetime while used                                                                             | How it dies                                                                                                      | Renewal                                                                                                                                |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **OAuth 3LO — actively used**                            | Indefinite in practice — hourly auto-refresh, and the 90-day idle clock **resets on every use** | — (stays alive as long as it's used)                                                                             | None — fully automatic. No documented absolute cap on an actively-used chain.                                                          |
| **OAuth 3LO — idle > 90 days**                           | Dies after 90 days with no refresh                                                              | Refresh chain expires                                                                                            | Re-run **Connect with Atlassian**.                                                                                                     |
| **OAuth 3LO — revoked / password change / user departs** | Ends immediately                                                                                | User revokes the app, changes their password, or is deactivated (expected) → `invalid_grant` on the next refresh | Re-connect. **Use a service account** as the authorizing identity so an individual's departure doesn't kill the tenant's connector.    |
| **Connect / Forge app**                                  | —                                                                                               | —                                                                                                                | **Roadmap**: an installed marketplace app gives installation-scoped, non-expiring auth (no per-user token to lose). Not available yet. |

> **Legacy API-token connectors.** Before this change, some tenants connected the
> cloud with a stored Atlassian API token. Those rows no longer authenticate — the
> connector reports **Not connected** and the dashboard prompts **Connect with
> Atlassian**. Nothing is deleted; the tenant just re-authorizes via OAuth once.

We do **not** promise "connect once, forever": even OAuth dies on idle > 90 days
or on a revoke/password-change/departure. That is exactly why the connector
records **health**.

**Connector health semantics.** Every Jira call the cloud makes (the webhook's
fallback fetch and its advisory-comment write, plus OAuth refreshes) stamps the
connector row:

- **Success** sets `last_success_at` and clears `last_error` → the dashboard
  shows **Connected — last activity <when>**.
- **Failure** sets `last_failure_at` and a **sanitized, length-capped**
  `last_error` (a status code / short message only — never a token, header, or
  raw error object) → the dashboard shows **FAILING since <when>: <reason>** with
  a **Reconnect** affordance for OAuth connectors.
- A **transient** failure (5xx / network blip) during an OAuth refresh **never
  blanks the stored refresh token** — the chain is preserved and the next attempt
  retries. Only an `invalid_grant` (a genuinely dead authorization) flips the
  connector to FAILING, and even then the row is **kept** so the dashboard can
  prompt a reconnect rather than silently dropping the connection.

### Hold in reserve

The Connect Jira form has a **Hold in reserve** toggle. When enabled, the
connector still receives webhooks and the bundle is **still assembled and
stored** (so the pull-by-URL path and the dashboard can surface it), but **no
comment is written back** to the ticket. Use it to stage the integration —
capturing context silently — before letting Crumbtrail comment on live tickets.
