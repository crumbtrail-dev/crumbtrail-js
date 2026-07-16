# Incremental yield benchmark preregistration

## Purpose

This plan is fixed before arm results are collected. It measures whether adding Crumbtrail evidence changes diagnosis quality relative to the same coding agent with the generic investigation stack.

## Corpus

The typed corpus in `src/benchmark/corpus.ts` contains 24 seeded bugs. It weights request keyed row diff and cross release behavior bugs because those are the claimed differentiated evidence classes. It also includes race adjacent write skew and HTTP failure family bugs.

## Arms and controls

The generic arm receives repo MCP, Sentry, Datadog, and Jira. The Crumbtrail arm receives the same stack plus the Crumbtrail bundle and MCP. One operator selected model is used for both arms in each run set. Both arms receive the same prompt template, token budget of 16000 tokens, bug fixture, and run count of 10 runs per bug.

Run identifiers pair the same bug and run position across arms. Every result requires the model identifier, prompt revision and hash, token budget, tool configuration identifier, arm, bug identifier, run index, and outcome. Only the registered generic stack and Crumbtrail stack configurations are accepted. Each matched pair must use the same model, prompt revision and hash, and token budget. Duplicate arm, bug, and run identifiers count once. The scorer rejects incomplete files and mismatched controls.

## Primary outcome

The primary outcome is exact root cause identification against the machine checked `{ component, fault, evidenceKey }` ground truth. A partial match is not correct.

## Secondary outcomes

Secondary outcomes are seconds and tokens to an exact identification, plus the count of incorrect diagnoses made with confidence of 0.80 or greater.

## Analysis

The report always shows each bug class for both arms, including wins, losses, ties, and no data. Its primary significance test is an exact two sided McNemar test over matched bug and run identifiers. The threshold is 0.05 and a result also needs at least 30 matched runs before it is called significant.

The report states whether any observed difference concentrates in request keyed row diff or cross release behavior classes. It does not claim a lift when result files are absent, when any arm has fewer than 10 runs for any bug, when any bug class has no data, when the threshold is not met, or when data quality checks fail.

## Reproduction

CI does not run external coding agents. An outsider supplies an adapter module with a `run(task)` callback and runs both arms against every reproduction with this command after building the workspace:

```sh
pnpm --filter crumbtrail-topology-harness benchmark:run -- --adapter path/to/adapter.mjs --output path/to/results.json --model chosen_model --prompt-revision preregistration_v1 --runs 10
```

The runner presents the fixed prompt template, the seeded reproduction, and the arm tool configuration to the adapter for every bug and arm. It writes schema version 2 result files. Generate a report with `pnpm --filter crumbtrail-topology-harness benchmark:report -- path/to/results.json`. The included fake adapter test exists only to exercise the run, score, and report loop and is not evidence of a measured lift.
