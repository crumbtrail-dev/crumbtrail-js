# Checkpoint plan

Five checkpoints. Repos are separate: CP1 lands in `crumbtrail-playground`; CP2 through CP5
land in `crumbtrail-cli`. CP3 and CP4 each carry a small playground side commit for their
manifest assertions.

## CP1: re-vendor the playground onto SDK 0.9.0 and re-establish the gate

**Repo:** `crumbtrail-playground` only.

Make `playground:verify` actually exercise this worktree's SDK, with a repeatable refresh path.
The only checkpoint whose failure invalidates every later one silently.

- Pack from the cli worktree, vendor `crumbtrail-core-0.6.0.tgz` and `crumbtrail-node-0.9.0.tgz`.
- Update `pnpm.overrides`, regenerate the lockfile for the new integrity hashes.
- Delete the superseded `0.5.0` and `0.8.0` tarballs. No dual pinning.
- Add `scripts/refresh-vendor.mjs` and a `playground:refresh-vendor` script so later checkpoints
  re-vendor with one command.
- Update the stale README vendor paragraph.

**Done when:** no `0.8.0` or `0.5.0` reference remains; the refresh script reproduces the
vendored state from scratch; `playground:verify --all --json` is 17/17 and 39/39; a driven
session's metadata proves 0.9.0 actually ran rather than a cached install; the cli worktree has
no diff from this checkpoint.

**Prerequisites:** none.

**Head start:** a baseline run against the `0.9.0`/`0.6.0` pack already returned 17/17 and 39/39,
so the version jump is known behavior neutral. CP1 still owns the durable path and the cleanup.

## CP2: stop error proximity from flattening every write in a request

**Repo:** `crumbtrail-cli`.

Replace the binary `adjacent` boost so a write's rank reflects its own relationship to the
error rather than mere membership in the same request id. Widest blast radius in the plan:
every db plane candidate flows through it, the causal re-rank consumes the resulting
severities, and `distinct-bugs.ts` groups on the result.

- Redesign the promotion in `addDbDiffCandidates` and `addOtelDbActivityCandidates` together.
  Discriminators to evaluate: temporal distance to the error, ordinal position in the write
  sequence, table participation in the error path, and a cap on how many writes per request may
  take the top tier.
- Delete the superseded binary branching and its dead constants. One canonical implementation.
- Re-check `DB_DIFF_ADJACENCY_MS` and `collectErrorMoments` for the same over broad match.

**Done when:** the eight same request mutations in `ses_20260723_160942` no longer share one
severity and score; `ses_20260723_160706` still emits `db_delta_mismatch` high/72 as `cand_0001`
with `causalRole: root`; no existing detector loses a candidate, proven by a before and after
candidate set diff across all five sessions; the full gate stays 17/17 and 39/39.

**Prerequisites:** CP1.

## CP3: per request db.diff invariant detectors

**Repo:** `crumbtrail-cli`, plus a playground commit for the manifest assertions.

Two detectors that read one request's `db.diff` set as a whole. They share input, scaffolding,
and file region, so they are one reviewable unit.

- **Detector A, intra request field divergence.** Same semantic value field in two or more
  after images linked by id, values disagree. `db_delta_mismatch` grade: high severity, score at
  or above 72, precise repro hint naming both tables, the field, and both values. Deny biased on
  ambiguity.
- **Detector B, duplicate write.** Two or more inserts into one table in one request with
  identical after images modulo the pk. **Must require a non trivial after image** per F2, or it
  fires on the clean control.
- Decide and document the `nodeKindsForDetector` mapping and whether either belongs in
  `DB_DETECTORS`.
- Resolve gap 1's causal misattribution detector side if possible: the new high score candidate
  should anchor on the divergent row and become `causal_chain.root` naturally. Only touch
  `causal-graph.ts` if that is provably insufficient.
- Playground: `candidate` plane assertions on `cache-stale-price-checkout` and
  `retry-storm-duplicate-redemption`.

**Done when:** Detector A fires on `ses_20260723_160512` naming both prices and is silent on the
other four; Detector B fires on `ses_20260723_160942` and is silent on the clean control despite
its two shipments rows; the divergence candidate is `cand_0001` in the gap 1 session; both new
playground assertions were demonstrated failing before and passing after; the gate is 17/17 and
43/43.

**Prerequisites:** CP1 and CP2. CP2 is both an ordering and a file dependency.

## CP4: cross service value divergence on the backend.http plane

**Repo:** `crumbtrail-cli`, plus a playground commit for the manifest assertion.

The only gap whose detection rule is not yet determined, and per F3 the obvious rule is
provably inverted. The design decision, not the code, is the reviewable artifact.

- **First activity, before any implementation:** drive a real `flag-tax-engine-divergence` N/N1
  pair and diff the captured planes to establish what actually differs. The on disk ad hoc
  sessions are secondary and partly misleading.
- Implement against the rule that diff establishes. Reuse the existing `ui_api_divergence` and
  `ui_arithmetic_mismatch` primitives rather than building parallel machinery.
- `backend.http` has no `CausalNodeKind` today. Decide whether to add one; adding one widens
  scope, so justify it.

**Done when:** the N versus N1 plane diff is recorded with the chosen rule justified against it;
the detector fires on N1 and is silent on N; the chosen rule does not reduce to "components must
sum to total", or the review explains why F3's inversion does not apply; the assertion was
demonstrated failing before and passing after; the gate is 17/17 and 45/45.

**Prerequisites:** CP1 and CP2. Not semantically dependent on CP3, but shares the
`evidence-index.ts` region, so serialized behind it.

**Escape hatch:** if the pair diff proves the plane cannot discriminate without a capture
change, this checkpoint merges as investigation plus a recorded finding and no detector. Do not
force a detector that fires on both sides.

## CP5: make the getFixContext token budget honest

**Repo:** `crumbtrail-cli`.

Entirely different files from the detector work, no shared state, no playground gate. The one
checkpoint that runs fully concurrently with everything else.

- Make `primary_window` request arrays and the db planes participate in the budget. Today
  `baseTokens` treats them as fixed and unbudgetable.
- Establish an explicit cross plane priority order, encoded once: top ranked signals and
  `causal_chain` before bulk request arrays.
- Make the over budget case honest. Either the response fits, or it reports that the budget
  could not be met. The silent `signals: []` plus 2.7x overrun must go.
- `causal_chain` must never reference a dropped signal.
- `dropReport` must name every plane it trimmed.

**Done when:** `getFixContext(ses_20260723_160706, maxTokens: 1800)` returns a non empty
`signals` array containing `db_delta_mismatch` within budget, or an explicit machine readable
"budget not satisfiable" result; unbudgeted responses are byte identical, asserted not assumed;
a budget sweep shows monotonic degradation; the full node suite and typecheck are green.

**Prerequisites:** none. **Re-run obligation:** its suite must be re-run after CP3 and CP4 land,
because new detectors change the signals array its tests project over.

## Dependency graph

```
CP1  re-vendor + gate baseline ────┐
  (playground repo only)           │
                                   ├──► CP2 ──► CP3 ──► CP4
                                   │   (all three edit evidence-index.ts)
CP5  fix-context budget ───────────┘
  (mcp-server.ts / token-estimate.ts)      re-run CP5 suite after CP3+CP4
```

**Concurrent:** CP1 with CP5. Zero overlap, and CP5 has no playground gate, so it does not wait
on the re-vendor. This is the highest value parallelism available.

**Serialized, with the constraint named:**

| Edge | Kind | Constraint |
| --- | --- | --- |
| CP1 to CP2 | ordering | CP2's only integration evidence is "gate unchanged", which is meaningless against a stale baseline |
| CP1 to CP3, CP4 | ordering | Both prove themselves through playground assertions; a stale vendored tarball makes those results unattributable |
| CP2 to CP3, CP4 | ordering and file | CP2 moves the severity floor every db plane candidate receives; all three edit `evidence-index.ts` |
| CP3 to CP4 | file only | Both add a detector and a registration line in the same block. No semantic dependency |
| CP3, CP4 to CP5 | post merge re-run | Not blocking; a re-run obligation |

## Review moments

1. After CP1, before any code change. Verify the driven session really ran 0.9.0.
2. After CP2's five session before and after candidate diff, before merge. A silent detector
   regression would hide here. Read the diff, not just the green suite.
3. After CP3's and CP4's negative controls, before implementation review. The assertions must be
   seen failing first. An assertion that never failed proves nothing.
4. At CP4's rule selection step, before code is written.
5. At final closeout: full gate, CP5 suite re-run on the merged tree, docs and consumer check.
