# `crumbtrail/verify` — pre-deploy CI gate

A reusable composite GitHub Action that runs the published `crumbtrail` CLI's
`verify` preflight (DNS → TLS → auth) against a target environment and **fails
the job if the Crumbtrail ingest config is broken**. Put it in front of your
deploy step so a wrong key, wrong endpoint, or TLS cert/host mismatch stops the
pipeline *before* you ship instead of silently sending nothing in production.

It is a thin wrapper around `npx crumbtrail@<version> verify … --json`. Because
the CLI exits non-zero on any FAIL, the action step (and the job) fails too.

## Inputs

| Input | Required | Default | Description |
| --- | --- | --- | --- |
| `endpoint` | no | `https://api.crumbtrail.ai` | Cloud endpoint to probe. |
| `key` | **yes** | — | Ingest key to probe with. Must come from a CI secret — never inline it. |
| `project` | no | `""` | Project id, used for the authenticated fallback probe. |
| `version` | no | `latest` | Which published `crumbtrail` version to run via `npx`. |
| `node-version` | no | `22` | Node.js version used to run the CLI (the CLI needs ≥ 22.15). |

## Outputs

None. The gate is expressed through the **step exit code**: `0` when every
runnable stage passes, non-zero on any FAIL — which fails the job.

## Security

- The action **never echoes the key**. It is passed to the CLI via an
  environment variable, not interpolated into the logged command line, and the
  CLI itself does not print it.
- Always source `key` from a CI secret (`${{ secrets.CRUMBTRAIL_INGEST_KEY }}`),
  never a literal.

## Usage

```yaml
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # Gate: fail before deploying if prod ingest config is broken.
      - name: Verify Crumbtrail config
        uses: CrumbtrailDev/crumbtrail-cli/.github/actions/verify@main
        with:
          endpoint: https://api.crumbtrail.ai
          key: ${{ secrets.CRUMBTRAIL_INGEST_KEY }}
          # project: prj_1234abcd     # optional
          # version: 0.5.0            # pin once released; default is `latest`

      - name: Deploy
        run: ./deploy.sh
```

If the preflight fails, the `Verify Crumbtrail config` step fails and the
`Deploy` step never runs.

## Version note

`npx crumbtrail@<version>` is the right consumer entry point because the CLI is
published from this repo (`packages/cli`, `bin: crumbtrail`). The version on the
current branch is bumped to **0.5.0 but is NOT yet released to npm**. Pin
`version: 0.5.0` only after that release is published; until then `latest`
resolves to the most recent published version.
