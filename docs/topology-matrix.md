# Supported topology matrix

> Generated file. Do not hand edit.

This matrix is produced by deterministic CI scenarios that use the public Crumbtrail instrumentation helpers.

Node package version: 0.2.4.
Run: local.
Revision: local.
Generation timestamp: 2026-07-16T02:31:19.338Z.

| Cell | Driver or ORM | Process shape | Edge | Transaction pattern | Capture mode | Expected | Achieved |
| --- | --- | --- | --- | --- | --- | --- | --- |
| pg_direct_sdk_autocommit | pg_direct | synchronous_service | direct | autocommit | sdk_dev_session | full | full |
| pg_pool_connect_enterprise_core | pg_pool | synchronous_service | direct | explicit_transaction | sdk_dev_session | full | full |
| mysql2_autocommit | mysql2 | synchronous_service | direct | autocommit | sdk_dev_session | full | full |
| mssql_pool_autocommit | mssql_pool | synchronous_service | direct | autocommit | sdk_dev_session | full | full |
| batched_statement_capture_gap | pg_direct | synchronous_service | direct | batched_statements | sdk_dev_session | gapped | gapped |
| prisma_driver_layer_enterprise_core | prisma_driver_layer | synchronous_service | direct | autocommit | sdk_dev_session | full | full |
| drizzle_driver_layer | drizzle_driver_layer | synchronous_service | direct | autocommit | sdk_dev_session | full | full |
| knex_driver_layer | knex_driver_layer | synchronous_service | direct | autocommit | sdk_dev_session | full | full |
| bullmq_worker_enterprise_core | pg_pool | bullmq_worker | direct | autocommit | sdk_dev_session | full | full |
| bullmq_worker_missing_context | pg_direct | bullmq_worker | direct | autocommit | sdk_dev_session | gapped | gapped |
| webhook_fanout | pg_direct | webhook_fanout | direct | autocommit | sdk_dev_session | full | full |
| gateway_traceparent_only_enterprise_core | pg_direct | synchronous_service | gateway_traceparent_only | autocommit | sdk_dev_session | full | full |
| cors_cross_origin | pg_direct | synchronous_service | cors_cross_origin | autocommit | sdk_dev_session | full | full |
| explicit_transaction | pg_direct | synchronous_service | direct | explicit_transaction | sdk_dev_session | full | full |
| cte_upsert_corpus | pg_direct | synchronous_service | direct | cte_upsert_corpus | sdk_dev_session | full | full |
| v3_production_trigger_enterprise_core | pg_direct | synchronous_service | direct | autocommit | v3_production_trigger | full | full |
| otlp_sessionless | pg_direct | synchronous_service | direct | autocommit | otlp_sessionless | gapped | gapped |

## Ground truth notes

### pg_direct_sdk_autocommit

Direct PostgreSQL capture joins the action, request, and changed row.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### pg_pool_connect_enterprise_core

An acquired PostgreSQL pool client keeps the request correlation.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### mysql2_autocommit

The mysql2 driver adapter records the changed order row.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### mssql_pool_autocommit

The MSSQL pool adapter records output rows through its request object.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### batched_statement_capture_gap

A statement batch that cannot be classified records a database capture gap.
Observed linked requests: 1. Observed row diffs: 0. Completeness grade: fragmentary.

### prisma_driver_layer_enterprise_core

Prisma coverage uses emitted SQL through the PostgreSQL driver layer, not a live ORM integration.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### drizzle_driver_layer

Drizzle coverage uses emitted SQL through the PostgreSQL driver layer, not a live ORM integration.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### knex_driver_layer

Knex coverage uses emitted SQL through the PostgreSQL driver layer, not a live ORM integration.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### bullmq_worker_enterprise_core

A serialized worker payload is deserialized in a fresh worker scope before it writes.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### bullmq_worker_missing_context

A dropped worker context emits a queue capture gap and cannot complete the original join.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: degraded.

### webhook_fanout

The fan out handler preserves the originating request correlation.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### gateway_traceparent_only_enterprise_core

The gateway strips custom correlation headers after receipt while traceparent resolves the backend request join.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### cors_cross_origin

An allowed cross origin request keeps its correlation headers.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### explicit_transaction

Only the mutation in the transaction produces the row change evidence.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### cte_upsert_corpus

Classified CTE and upsert statements produce request keyed row diffs.
Observed linked requests: 1. Observed row diffs: 2. Completeness grade: complete.

### v3_production_trigger_enterprise_core

The real production fast finalize trigger processes a severe event; finalization is modeled as skipped because this deterministic harness has no session store.
Observed linked requests: 1. Observed row diffs: 1. Completeness grade: complete.

### otlp_sessionless

Sessionless telemetry retains its trace join and records the missing session coverage.
Observed linked requests: 0. Observed row diffs: 1. Completeness grade: degraded.

