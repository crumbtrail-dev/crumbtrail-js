# Atlassian app registration & Marketplace runbook (Jira 3LO)

This is the operator runbook for the **one** distributable Atlassian OAuth 2.0
(3LO) app that the whole Crumbtrail cloud shares. It exists to satisfy Atlassian's
[third-party integration guidance](https://www.atlassian.com/blog/developer/building-secure-and-scalable-integrations-our-guidance-for-third-party-apps):

- **One centralized app**, not one app per customer tenant.
- **No customer-generated API tokens** stored by the service — authorization is
  OAuth 3LO only (the stored-API-token connector was retired; see
  [`ticket-connectors.md`](./ticket-connectors.md)).
- The app **identifies its source transparently** (descriptive `User-Agent` on
  every outbound call; see `CRUMBTRAIL_USER_AGENT` in
  `packages/node/src/ticket/clients.ts`).

Steps 1–4 are things **you** do in the Atlassian developer console and your
deployment — they can't be done from code. Steps 5–6 are optional (Marketplace
listing) and only needed for public, un-gated distribution.

---

## 1. Create the single OAuth 2.0 (3LO) app

1. Go to <https://developer.atlassian.com/console/myapps/> and **Create → OAuth 2.0
   integration**. Name it (e.g. `Crumbtrail`). Create exactly **one** app for the
   whole fleet — never one per customer.
2. Under **Permissions**, add the **Jira API** and grant these scopes (they match
   `JIRA_OAUTH_SCOPES` in `packages/cloud/src/jira-oauth.ts`):
   - `read:jira-work` — read the issue that triggered the webhook.
   - `write:jira-work` — post the advisory comment back to the issue.
   - `offline_access` — required for a **rotating refresh token** (long-lived,
     hands-free connectors).
     Request the **narrowest** scopes that work — do not add `manage:` or admin
     scopes. Crumbtrail only reads one issue and posts one comment.
3. Under **Authorization → OAuth 2.0 (3LO)**, set the **Callback URL** to exactly:

   ```text
   {PUBLIC_BASE_URL}/api/connectors/jira/oauth/callback
   ```

   e.g. `https://app.crumbtrail.ai/api/connectors/jira/oauth/callback`. It must
   byte-match `callbackUrl()` in `packages/cloud/src/routes/oauth-routes.ts`, or
   the token exchange fails.

4. Under **Settings**, copy the **Client ID** and **Secret**.

## 2. Wire the credentials into the deployment

Set these on the cloud server (see `packages/cloud/.env.example`). The secret is
used only at the token boundary and is never logged or returned:

```bash
CRUMBTRAIL_ATLASSIAN_CLIENT_ID=<client id>
CRUMBTRAIL_ATLASSIAN_CLIENT_SECRET=<client secret>
# Also required for the OAuth flow + sealing tenant tokens at rest:
CONNECTOR_SECRETS_KEY=<32-byte hex>   # openssl rand -hex 32
PUBLIC_BASE_URL=https://app.crumbtrail.ai
```

Without `CRUMBTRAIL_ATLASSIAN_CLIENT_ID/SECRET` the OAuth start/callback routes
fail closed with a `503 oauth_unavailable` (the dashboard shows "Atlassian
sign-in is not enabled on this deployment") — it never falls back to a stored
API token.

## 3. Turn on distribution (multi-customer)

In the console, open **Distribution** and switch from **Sharing: off** to
**Sharing: on**. This is what makes the _single_ app installable by _any_
customer's Atlassian tenant via the consent screen — the compliant alternative to
asking each customer to register their own app. Fill in the required vendor
fields (name, privacy policy URL, terms URL, security contact).

## 4. Verify end-to-end (before any customer touches it)

1. In the Crumbtrail dashboard → **Settings → Connect Jira**, click **Connect with
   Atlassian**. You should be redirected to `auth.atlassian.com`, consent, and
   land back on `…/settings?connected=jira`.
2. Confirm the connector shows **Connected via Atlassian** and a **Webhook URL**.
3. Register that webhook URL in your test Jira site for `jira:issue_created` with
   the webhook secret, create a test issue, and confirm the advisory comment
   posts. (This is the flow in [`ticket-connectors.md`](./ticket-connectors.md).)
4. In Atlassian, revoke the app for that account and confirm the connector flips
   to **FAILING → Reconnect** rather than erroring silently.

---

## 5. (Optional) Marketplace listing

A 3LO app can be distributed **without** a Marketplace listing (share it and hand
customers the consent link). List it on the Marketplace when you want public
discovery / an install button. For a 3LO (non-Forge) app you can publish an
**informational listing** without a full app review.

- Partner portal: <https://developer.atlassian.com/platform/marketplace/>
- Create a vendor account, then **Create app listing → Jira Cloud → OAuth 2.0
  integration**, link the app from step 1, and fill in the listing copy, logo,
  privacy policy, and support contact.

## 6. Marketplace security self-assessment (filing-ready)

Map each [Cloud App Security Requirement](https://developer.atlassian.com/platform/marketplace/security-requirements/)
to how Crumbtrail already satisfies it. Keep this table current — it's what you
paste into the self-assessment.

| Requirement                                   | How Crumbtrail meets it                                                                   | Evidence                                                                          |
| --------------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Single distributable app (no per-tenant apps) | One shared 3LO app; credentials loaded once per deployment                               | `loadAtlassianOAuthCredentials`, `packages/cloud/src/jira-oauth.ts`               |
| No storage of customer-generated API tokens   | Stored-API-token connector retired; OAuth 3LO only                                       | `getJiraClientForTenant` (oauth-only), `connectors.ts` (no `apiToken` write path) |
| Secrets encrypted at rest                     | AES-256-GCM sealing per tenant; write-only, never read back                              | `sealSecret`/`openSecret`, `packages/cloud/src/secrets.ts`                        |
| Token rotation / least-lifetime               | Rotating refresh tokens; access refreshed ~2m pre-expiry; single-flight + CAS            | `refreshTokens`, `persistRotatedTokens`, `jira-oauth.ts`                          |
| Least-privilege scopes                        | `read:jira-work`, `write:jira-work`, `offline_access` only                               | `JIRA_OAUTH_SCOPES`, `jira-oauth.ts`                                              |
| CSRF protection on the OAuth flow             | One-time state bound to (tenant, user) + signed HttpOnly SameSite cookie double-submit   | `handleStart`/`handleCallback`, `oauth-routes.ts`                                 |
| Webhook authenticity                          | HMAC-SHA256 `X-Hub-Signature` verified on raw body before parse; uniform 404 (no oracle) | `verifyHubSignature`, `packages/cloud/src/routes/webhook-routes.ts`               |
| Tenant isolation                              | Every connector query scoped by `tenant_id`; cross-tenant read/write returns 404         | `connectors.ts`, `connector-secrets.test.ts`                                      |
| No secret leakage in logs/responses           | Sanitized, length-capped errors; tokens never logged or echoed                           | `sanitizeConnectorError`, `connectors.ts`                                         |
| Transparent source identification             | Descriptive `User-Agent` on all outbound Atlassian/Jira calls                            | `CRUMBTRAIL_USER_AGENT`, `packages/node/src/ticket/clients.ts`                     |
| Data handling / privacy                       | Only reads the triggering issue + posts one advisory comment; no bulk export             | webhook flow in `ticket-connectors.md`                                            |

**Still requires a human decision before listing:**

- Vendor legal pages (privacy policy, terms, security contact email).
- Whether to gate distribution (private share link) or list publicly.
- A dedicated **service account** as the recommended authorizing identity (so a
  departing employee doesn't kill a tenant's connector).
