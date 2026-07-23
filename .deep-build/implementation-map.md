# Implementation map: silent invariant detectors

## Origin

A live e2e harness run drove four "silent invariant" bugs through the full Crumbtrail
pipeline: browser SDK capture, capture server persistence, and MCP evidence read back. In
every case the raw evidence was captured correctly and completely. The gap is detection and
ranking. The detectors never name the bug, so a reader working the ranked candidate list is
led away from the smoking gun rather than toward it.

Five real sessions from that run are the primary fixtures. Synthetic data is a fallback, not
a default.

| Session | Role |
| --- | --- |
| `ses_20260723_160249_f1cae64d23b6` | Clean control for the stale cache flow |
| `ses_20260723_160512_5774c2141d94` | Gap 1: stale cache |
| `ses_20260723_160706_290077583a13` | Working baseline: `db_delta_mismatch` fires correctly |
| `ses_20260723_160837_d507608f6f02` | Gap 2: cross service flag divergence |
| `ses_20260723_160942_5cb9d594a635` | Gap 3: duplicate write and severity flattening |

Stored under `~/.crumbtrail/sessions/local/unknown-app/2026-07-23/`.

## The four gaps

### Gap 1: no intra request DB field divergence detector

One request wrote `products.price_cents=8900`, `orders.total_cents=9258`, and
`order_items.price_cents=7900`. Two different prices for one product inside one request. The
candidate list is equivalent to the clean control run. The causal attribution also misleads:
it labels the products update `root` and the order_items insert, which carries the bug, a
`symptom`.

### Gap 2: no cross service value divergence detector

The `backend.http` plane carries the whole story and no detector reads that plane at all. A
feature flag defaulted on, so the charge path applied tax the display path never showed.

### Gap 3: no duplicate write detector, and error proximity flattens severity

A retry storm with no idempotency key wrote two identical `coupon_redemptions` rows for one
order under a single request id. Two problems: no duplicate write detector exists, and the
existing error proximity boost lifted all eight mutations in that request to an identical
`high`/88, destroying discrimination exactly where it mattered.

### Gap 4: `getFixContext` maxTokens budget is dishonest

A 1800 token budget returned `tokenEstimate: 4828` with `signals: []`. The trimmer only drops
from `signals`, so it discards the ranked detector list, the highest value part of the bundle,
while retaining the bulky request arrays.

## Planner findings that changed the plan

Recorded because each one invalidates an assumption in the original framing.

**F1. The verification seam was already broken before any code change.** The playground pins
`crumbtrail-node-0.8.0.tgz` and `crumbtrail-core-0.5.0.tgz` with lockfile integrity hashes.
`pack:local` emits `0.9.0` and `0.6.0`, different filenames. Re vendoring requires editing
overrides, replacing tarballs, and regenerating the lockfile.

*Status: partially answered before planning finished.* A baseline harness run against the
unfixed `0.9.0`/`0.6.0` pack returned 17/17 regressions and 39/39 checks, so the version jump
is behavior neutral for the gate. Checkpoint 1 still has to land the durable path.

**F2. The obvious duplicate write rule fires on the clean control.** A naive "identical insert
rows in one request" rule matches the clean control's two `shipments` rows, whose after images
reduce to `{}` once the primary key is dropped. The rule must require a non trivial after
image, at least one non id field surviving the pk drop. This is a must not fire fixture, not a
hypothetical.

**F3. Gap 2's obvious detector design is inverted.** In the buggy session
`subtotal 19900 + tax 1642 = total 21542`, arithmetically consistent. In the clean baseline
`total 19900` with `tax 1642`, which is arithmetically inconsistent under a naive "components
must sum to total" reading. That rule would fire on the clean build and stay silent on the
buggy one. Gap 2's rule must be resolved against a real driven N/N1 pair before any detector
is written. The two ad hoc sessions are insufficient and partly misleading.

**F4. Gap 3b's blast radius is wider than `db_mutation`.** The `adjacent` boost lives in both
`addDbDiffCandidates` and `addOtelDbActivityCandidates`. Both key on
`moment.requestId === requestId`, so both promote every write in a request containing any
error. They must change together.

**F5. Gap 4's trimmer is not in `fix-context.ts`.** It is `CrumbtrailMcpServer.fixContextResult`
delegating to `budgetedTextResult` and `fillToBudget` in `token-estimate.ts`. `baseTokens` is
computed over a payload that includes the whole `primary_window`, so when it exceeds the
budget, `available` goes negative and the prefix loop keeps zero items.

**F6. The full harness gate is expensive.** 17 regressions, each a full source tree copy plus
install, client build, and headless Playwright drive. Per checkpoint verification must be
`--bug <id>` targeted; `--all` is the gate, run once at the end of a checkpoint.

## Constraints

- Pre release project. Prefer the clean final design. No compatibility shims, dual paths, or
  deprecated aliases to preserve unfinished behavior. Superseded code is deleted in the same
  change, not unplugged.
- A new detector must not fire on the clean control. A detector that fires on both N and N1 is
  worthless, and the N/N1 pair discipline is the entire point of the harness.
- Do not weaken or delete existing passing detectors.
- Cross repo: the detector work is `crumbtrail-cli`; the manifest assertions are
  `crumbtrail-playground`. Separate repos, separate branches, separate commits.

## Out of scope

- Broadening `backend.http` capture in `crumbtrail-core`. If the pair diff proves the plane
  cannot discriminate without a capture change, stop and report it as routed follow up work.
- `PRODUCT.md`, which lives in the main product repo, not this one. The new detector capability
  note there is a cross repo follow up.
