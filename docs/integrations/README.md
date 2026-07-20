# Plug your telemetry into Crumbtrail

Crumbtrail ingests standard OTLP/HTTP (`/v1/traces`, `/v1/logs`) and maps it into its AI-readable, ranked bug bundle.
Anything that exports OpenTelemetry can feed Crumbtrail: add it as a second exporter and keep your existing provider.

Sessionless spans and logs are accepted. Crumbtrail auto-creates time-window sessions from service metadata, then upgrades cleanly when you add `crumbtrail.session.id`.

| Source | Recipe |
|---|---|
| OpenTelemetry SDK | [opentelemetry.md](./opentelemetry.md) |
| Datadog | [datadog.md](./datadog.md) |
| Sentry via OpenTelemetry | [sentry.md](./sentry.md) |
| Grafana Alloy | [grafana-alloy.md](./grafana-alloy.md) |
| Splunk Observability Cloud | [splunk.md](./splunk.md) |
| Database row diffing (Postgres, MySQL, MSSQL, SQLite) | [databases.md](./databases.md) |
