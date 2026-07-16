import type { RootCauseTruth } from "./types";

const SCORER_ONLY_TRUTH: Readonly<Record<string, RootCauseTruth>> = {
  row_diff_wrong_request_key: { component: "request_context", fault: "stale_request_key", evidenceKey: "db.diff.requestId" },
  row_diff_pool_context_loss: { component: "pg_pool_connect", fault: "context_not_wrapped", evidenceKey: "db.diff.requestId" },
  row_diff_worker_origin_loss: { component: "bullmq_payload", fault: "correlation_not_serialized", evidenceKey: "capture_gap.queue" },
  row_diff_gateway_header_loss: { component: "gateway_proxy", fault: "traceparent_not_forwarded", evidenceKey: "capture_gap.backend_request" },
  row_diff_mysql_after_image: { component: "mysql_adapter", fault: "insert_id_not_reread", evidenceKey: "db.diff.after" },
  row_diff_mssql_output: { component: "mssql_adapter", fault: "output_clause_missing", evidenceKey: "db.diff.after" },
  row_diff_prisma_nested_write: { component: "prisma_driver_layer", fault: "nested_write_not_classified", evidenceKey: "db.diff.table" },
  row_diff_cte_update: { component: "sql_classifier", fault: "cte_write_not_classified", evidenceKey: "capture_gap.db_diff" },
  release_discount_rounding: { component: "pricing_rules", fault: "rounding_mode_changed", evidenceKey: "release.diff.pricing" },
  release_tax_region_default: { component: "tax_resolver", fault: "region_default_changed", evidenceKey: "release.diff.config" },
  release_inventory_reservation: { component: "reservation_worker", fault: "idempotency_key_changed", evidenceKey: "release.diff.worker" },
  release_webhook_signature: { component: "webhook_verifier", fault: "canonical_payload_changed", evidenceKey: "release.diff.request" },
  release_prisma_null_mapping: { component: "order_mapper", fault: "null_becomes_empty_string", evidenceKey: "release.diff.row" },
  release_knex_timezone_cast: { component: "delivery_query", fault: "timezone_cast_removed", evidenceKey: "release.diff.sql" },
  release_feature_flag_fallback: { component: "flag_resolver", fault: "fallback_branch_inverted", evidenceKey: "release.diff.flag" },
  write_skew_last_item: { component: "inventory_transaction", fault: "read_before_lock", evidenceKey: "db.diff.inventory" },
  write_skew_credit_limit: { component: "credit_service", fault: "nonserializable_update", evidenceKey: "db.diff.balance" },
  write_skew_webhook_retry: { component: "webhook_deduper", fault: "dedupe_insert_race", evidenceKey: "db.diff.delivery" },
  write_skew_mssql_allocation: { component: "allocation_query", fault: "missing_lock_hint", evidenceKey: "db.diff.pallet" },
  http_400_validation_mapping: { component: "address_validator", fault: "field_name_mismatch", evidenceKey: "backend.req.error" },
  http_401_gateway_scope: { component: "gateway_auth", fault: "scope_not_mapped", evidenceKey: "backend.req.end" },
  http_409_duplicate_order: { component: "order_idempotency", fault: "unique_error_unhandled", evidenceKey: "db.diff.requestId" },
  http_502_projection_timeout: { component: "projection_client", fault: "timeout_budget_too_short", evidenceKey: "backend.req.error" },
  http_503_release_cache: { component: "cache_warmer", fault: "release_key_not_invalidated", evidenceKey: "backend.req.end" },
};

/** This lookup is intentionally imported only by the scorer and its tests. */
export function scorerOnlyTruthForBug(id: string): RootCauseTruth | undefined {
  const truth = SCORER_ONLY_TRUTH[id];
  return truth ? { ...truth } : undefined;
}
