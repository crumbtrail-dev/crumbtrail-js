# Topology and benchmark artifacts

The topology matrix is generated from deterministic, in process scenarios. Each scenario uses public `crumbtrail-core` and `crumbtrail-node` helpers, records known ground truth, and fails when evidence goes missing without a capture gap.

The generated matrix lives at [topology matrix](topology-matrix.md). Its machine readable form is [matrix.generated.json](../packages/topology-harness/matrix.generated.json). Both artifacts carry the `crumbtrail-node` version and the CI run stamp.

Regenerate the matrix after building the workspace:

```sh
pnpm --filter crumbtrail-topology-harness generate
```

CI runs `check:matrix` before regeneration. It compares the generated scenarios with the committed matrix while ignoring the run specific stamp, then uploads the stamped JSON artifact.

BullMQ worker coverage models a queue handoff with two JSON streams. The enqueue scope sends a payload string containing correlation. A separate worker module accepts only that string, creates its own event sink, resolves correlation through the Node SDK, and returns an independent event stream. The harness merges the streams only after worker execution. This exercises the serialization boundary without requiring Redis.

The incremental yield benchmark is a rerunnable scaffold, not a measured lift claim. Its typed corpus includes an executable seeded reproduction for every bug. Its arms, runner, scorer, sample fixture, and fixed analysis plan live in `packages/topology-harness`. The current [benchmark report](../packages/topology-harness/benchmark/report.generated.md) honestly reports no measured lift until real arm files are supplied. The [preregistration](../packages/topology-harness/benchmark/PREREGISTRATION.md) fixes the matched arm method before collection.

An outsider supplies an adapter module with a `run(task)` callback. The runner presents every seeded reproduction, the fixed prompt template, and each arm tool configuration to that adapter:

```sh
pnpm --filter crumbtrail-topology-harness benchmark:run -- --adapter path/to/adapter.mjs --output path/to/results.json --model chosen_model --prompt-revision preregistration_v1 --runs 10
pnpm --filter crumbtrail-topology-harness benchmark:report -- path/to/results.json
```

The report is stamped with package version, CI run, revision, and generation timestamp. It publishes each bug class, including wins, losses, ties, and no data. It makes no significance claim unless every arm reaches the preregistered run count for every bug and every bug class has data. Prisma, Drizzle, and Knex matrix cells are honestly driver layer emitted SQL coverage, not live ORM integrations.
