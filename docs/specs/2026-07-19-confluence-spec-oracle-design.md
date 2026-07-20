# Confluence as a spec oracle

Status: design, approved for implementation of Slice C
Date: 2026-07-19
Repository: `crumbtrail-cli` (Slice C). A follow-on change to `crumbtrail`
(`packages/cloud`) covers hosted-tenant authorization and is tracked separately.

## Problem

Crumbtrail assembles evidence about **what happened**. It has no source for
**what was supposed to happen**. When a reported behavior is unusual but nothing
errored, the pipeline cannot distinguish a defect from a deliberate design
choice, and neither can an agent reading the bundle. It guesses, or it reports
inconclusive.

Teams already write that missing half down. It lives in Confluence: design docs,
runbooks, acceptance criteria, decision records. Crumbtrail has an Atlassian
integration and can reach it.

This design adds Confluence as a **spec oracle**: a source consulted to answer
"is this intended?", separate from the evidence pipeline that answers "what
happened?".

## What this is not

Confluence is deliberately **not** a seventh evidence adapter, despite the
adapter framework being the obvious-looking home. Three properties of
`evidence-source.v1` do not hold for documentation:

1. **Adapters are time-windowed.** `EvidenceQuery` carries
   `window: { start, end }` and every adapter filters by it. A runbook written
   two years before the incident is maximally relevant and has no temporal
   relationship to the window at all. A Confluence adapter would have to accept
   the window and deliberately ignore it, which makes the contract a lie.
2. **Adapter join keys are correlational.** `EvidenceJoinKey` is
   `traceId | requestId | sessionId | time | release | url | user | service`.
   Documentation joins on meaning, not identity. None of those keys select the
   right page.
3. **Adapter output is ranked once, downstream, by `assembleBundle`.** That
   fusion path is tuned for causal telemetry: it derives hypotheses and
   `LOW_CONTEXT` from lane breadth and item volume. Feeding it undated prose
   would let a long design doc inflate context-completeness scores without
   contributing any causal signal.

So Confluence gets its own small surface rather than a lane. Adding a `docs`
value to `EvidenceLane` is explicitly rejected.

## Decisions

These were settled before implementation and are recorded here because each one
closes off a plausible alternative.

### D1. Advisory only. A page never suppresses a finding.

A Confluence page saying "this is intended" annotates the diagnosis. It never
downgrades, hides, or resolves it. The repo's existing guarantee for every
source is "advisory, never gating", and documentation is the source most likely
to be quietly wrong: pages outlive the behavior they describe, and nobody
updates a runbook when they change the code.

The failure mode this avoids is the one that would make the feature worse than
not shipping it: a stale 2023 page silently burying a live defect.

Consequence for the output contract: every excerpt carries `lastModified` and
`lastModifiedBy`, and staleness is surfaced to the caller rather than reasoned
about internally. The tool reports what the page says and when it was last
touched. The agent or human decides.

### D2. Separate Confluence authorization. Do not widen the Jira scope set.

`packages/cloud/src/jira-oauth.ts` currently requests `read:jira-work`,
`write:jira-work`, `read:jira-user`, `offline_access`. Appending Confluence
scopes to that array would invalidate the scope set every already-connected
tenant consented to, forcing re-authorization and leaving working Jira
connectors broken until each customer clicks through consent again.

Confluence is therefore a **second, optional authorization** against the same
Atlassian app. A tenant with Jira connected and Confluence not connected is a
normal, fully supported state. This preserves the "always optional" property and
means shipping this feature cannot break an existing customer's Jira connector.

### D3. Slice C ships before Slice B.

The two shapes under discussion were:

- **B**: fusion classifies a bundle as intent-ambiguous and automatically fires a
  Confluence lookup.
- **C**: an MCP tool the coding agent calls when it is stuck.

C ships first. B is an automatic trigger, and it has nothing to invoke until the
retrieval path in C exists. More importantly, B's threshold cannot be tuned
without evidence about which lookups actually helped, and only C produces that
evidence. Building the classifier first means shipping an untunable heuristic
wired to a consumer that does not exist.

B remains the intended destination and is sketched below.

## Slice C: `searchSpecs` MCP tool

### Shape

A new MCP tool alongside `recallSimilarIssues`, which is its closest existing
relative: both answer a question about prior knowledge rather than current
telemetry, and both are agent-invoked.

```
searchSpecs({
  query: string,        // free-text: the behavior in question
  spaceKeys?: string[], // restrict to specific Confluence spaces
  limit?: number,       // default 5, max 15
})
```

Returns `KnowledgeResult`:

```ts
interface SpecExcerpt {
  title: string;
  url: string;              // provenance deep link
  spaceKey: string;
  excerpt: string;          // matched region, capped
  lastModified: number;     // ms epoch
  lastModifiedBy?: string;
  ageDays: number;          // derived, surfaced so staleness is unmissable
}

interface KnowledgeResult {
  schemaVersion: "knowledge.v1";
  excerpts: SpecExcerpt[];
  gaps: EvidenceGap[];      // reuses the existing gap type
  stats: {
    provider: "confluence";
    fetched: number;
    returned: number;
    truncated: boolean;
    latencyMs: number;
  };
}
```

`gaps` reuses `EvidenceGap` from `crumbtrail-core` rather than introducing a
parallel type. Gap semantics match the adapter framework: not configured, auth
failure, timeout, and zero results are all gaps, never throws. "No documented
intent found" is a valid and useful answer.

The tool description must state plainly that results are documentation and may
be stale, so an agent reading only the tool listing does not treat a page as
authoritative.

### Placement

New directory `packages/node/src/knowledge/`, holding the Confluence client and
the `knowledge.v1` types. Deliberately not `evidence-sources/`, so the
distinction in "What this is not" is visible in the file tree and a future
contributor does not register it into `EVIDENCE_SOURCE_PROVIDERS` by pattern
matching.

`packages/node/src/knowledge/` does **not** register with
`evidenceSourcesFromEnv` and does not participate in the `fetch-all.ts` fan-out.

### Credentials (self-host)

Mirrors the ticket-connector pattern in `ticket/clients.ts` exactly: env only,
never a tool argument, present if and only if every required var is set.

```
CONFLUENCE_BASE_URL      # https://<site>.atlassian.net/wiki
CONFLUENCE_EMAIL
CONFLUENCE_API_TOKEN
CONFLUENCE_SPACE_KEYS    # optional allowlist, comma-separated
```

HTTP Basic auth (`email:token`, base64), and every outbound request carries
`CRUMBTRAIL_USER_AGENT`, consistent with the other connectors.

### Query construction

Confluence CQL against `GET /wiki/rest/api/content/search`:

```
text ~ "<sanitized query>" AND type = page
  [AND space.key IN (<allowlist>)]
ORDER BY lastModified DESC
```

Ordering by recency is a deliberate hedge given D1: when several pages match,
the one most recently touched is the one least likely to be stale. This is a
weak signal and is not presented as relevance ranking.

The query string is sanitized for CQL injection before interpolation. Only the
free-text `query` and the operator-supplied space allowlist reach the CQL
string.

### Egress and redaction discipline

Reuses the existing posture rather than inventing a second one:

- Per-request timeout defaulting to `DEFAULT_SOURCE_TIMEOUT_MS` (10s).
- Excerpt bytes capped, with `truncated` reported honestly.
- Bounded fetch. No pagination walks beyond the limit.
- Every excerpt passes the redaction boundary (`evidence-sources/redact.ts`)
  before it is returned. Confluence pages routinely contain credentials in
  runbooks, so this is load-bearing rather than precautionary.
- Zero-copy. Nothing from Confluence is persisted; the excerpt is returned to
  the caller and not written to storage.

## Slice B: automatic intent-ambiguity trigger (follow-on, not this slice)

Sketched to show C does not foreclose it, and left unspecified where specifying
it now would be guessing.

The trigger is a bundle that shows **behavior differing from the reporter's
expectation with no error signal**: a symptom is present, the causal lanes
(`network`, `db`, `logs`) carry no failure, and the top hypothesis is
`inconclusive`. That combination is what "might be intended" looks like
structurally, and it is narrower than the existing `LOW_CONTEXT` score, which
measures thin evidence and would fire on tickets Confluence cannot help.

Open questions deferred to Slice B, to be answered with data from C:

- Does the ambiguity condition above actually correlate with cases where a spec
  page helped? C's call sites are the sample.
- Does the excerpt attach to the bundle as a distinct advisory section, or stay
  out of `fusion.v1` entirely and surface only in the Jira advisory comment?
- Does the webhook path (auto-posted advisory comment) consult Confluence, given
  it has no agent to judge staleness?

## Verification

Per checkpoint:

- CQL construction and sanitization: unit tests, including injection attempts.
- Client behavior: fixture-backed contract tests, zero live API calls in CI,
  matching the adapter suite's approach.
- Degradation: tests asserting that missing credentials, auth failure, timeout,
  and zero results each produce a gap and never a throw.
- Redaction: a fixture page containing a credential, asserted scrubbed.
- Tool registration: `searchSpecs` present in the MCP tool list with correct
  schema.

Live smoke against a real Confluence site is a GA-gating manual item, consistent
with how the existing adapters treat unverified provider-API details. The CQL
endpoint shape and response fields in this document are taken from Atlassian's
documented API and have **not** been verified against a live account.

## Risks

- **Stale pages misleading an agent.** Mitigated by D1 and by surfacing
  `ageDays`, not eliminated. An agent that ignores the staleness metadata can
  still be misled.
- **Retrieval quality.** CQL text search is keyword matching, not semantic
  search. Pages using different vocabulary than the ticket will not be found.
  Acceptable for C, whose purpose is partly to measure how often this matters.
- **Space sprawl.** A large Confluence instance with many irrelevant spaces will
  produce noise. `CONFLUENCE_SPACE_KEYS` is the operator's control; there is no
  automatic relevance filtering in this slice.
