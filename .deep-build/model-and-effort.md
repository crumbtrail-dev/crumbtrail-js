# Model resolution and effort table

## Resolution

The Deep Build skill asks for a current GPT family model. This run executes inside Claude Code,
whose agent spawning tool exposes only `opus`, `sonnet`, `haiku`, and `fable`. No GPT family
model is reachable from this runtime, so there is no exact match, no provider prefixed form, no
codename sibling, and no dated variant to fall back to.

| Field | Value |
| --- | --- |
| Requested | GPT family, per the skill default |
| Available | `opus`, `sonnet`, `haiku`, `fable` |
| Resolved | `opus` (claude-opus-4-8) for reasoning and implementation roles; `haiku` for copy roles |
| Match type | Family fallback. The requested family is not exposed by this runtime |
| Probe | The Checkpoint Planner spawn served as the live probe. It ran to completion, returning a full decomposition with five source grounded findings |

This fallback is reported here and in the final synthesis rather than applied silently.

The resolved choice also matches the operator's standing preference recorded in project memory:
Opus at high effort for reviews, Opus at medium for standard development, and a small model for
cheap mechanical work.

## Effort

Claude Code's agent spawning tool has no per agent reasoning effort parameter. Effort targets
are stated in each subagent prompt instead, per the skill's fallback guidance.

| Role | Model | Effort target |
| --- | --- | --- |
| Checkpoint Planner | opus | high |
| Checkpoint Builder, CP1 | opus | medium. Mechanical vendoring, but the lockfile and cleanup carry real risk |
| Checkpoint Builder, CP2 | opus | high. Widest blast radius; shared ranking logic |
| Checkpoint Builder, CP3 | opus | high. Two new detectors with proven false positive traps |
| Checkpoint Builder, CP4 | opus | high. Design first; the obvious rule is inverted |
| Checkpoint Builder, CP5 | opus | high. Contract change on a stable surface |
| Checkpoint Reviewers | opus | high. Never below the builder audited |
| Revision Builders | opus | matches the builder for that checkpoint |
| Scope Drift, Code Quality auditors | opus | medium |
| Security auditor | opus | high |
| Copy auditor and implementer | haiku | low to medium, with prescriptive enumerated rules |
