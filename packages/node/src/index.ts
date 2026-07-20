/** @stability stable — public SDK export surface (contract review, wargames/wargames/03-contract-decisions.md). */
export { createServer } from "./server";
export type { ServerConfig } from "./server";
export {
  DISTINCT_BUGS_SCHEMA_VERSION,
  groupDistinctBugs,
  buildDistinctBugSignature,
  computeDistinctBugSignatures,
  groupDistinctBugRecurrences,
} from "./distinct-bugs";
export type {
  DistinctBug,
  DistinctBugSeverity,
  DistinctBugEvidenceRef,
  DistinctBugRecurrence,
  DistinctBugRecurrenceInput,
  DistinctBugRecurrenceOccurrence,
} from "./distinct-bugs";
export { FilesystemSessionStore, defaultSessionStore } from "./session-store";
export type { SessionStore } from "./session-store";
export {
  FilesystemMcpReadStore,
  RemoteMcpReadStore,
  selectMcpReadStore,
} from "./mcp-read-store";
export type { McpReadStore } from "./mcp-read-store";
export { SessionManager } from "./session";
export type { SessionFinalizationResult, SessionListItem } from "./session";
export {
  sweepIdleSessions,
  startSessionSweeper,
  DEFAULT_SWEEP_IDLE_MS,
  DEFAULT_SWEEP_INTERVAL_MS,
  DEFAULT_SWEEP_CHECKPOINT_MS,
} from "./session-sweeper";
export type {
  SessionSweepOptions,
  SessionSweepResult,
  SessionSweeperHandle,
} from "./session-sweeper";
export {
  createFastFinalizeScheduler,
  isHighSeverityEvent,
  startFastFinalizer,
} from "./fast-finalize";
export type {
  FastFinalizeHandle,
  FastFinalizeOutcome,
  FastFinalizeScheduler,
  FastFinalizeSchedulerOptions,
  FastFinalizerOptions,
} from "./fast-finalize";
export { buildSessionSummary } from "./session-summary";
export type {
  SessionSummary,
  SessionFileFlags,
  Severity,
} from "./session-summary";
export { BugQueueManager } from "./bug-queue";
export type { BugReport as ServerBugReport, BugQueueConfig } from "./bug-queue";
export { McpServer } from "./mcp-server";
export type { McpServerConfig } from "./mcp-server";
export {
  buildFixContext,
  FixContextError,
  FIX_CONTEXT_SCHEMA_VERSION,
} from "./fix-context";
export type {
  FixContext,
  FixContextSession,
  FixContextReproHint,
  FixContextPrimaryWindow,
  FixContextDbDiff,
  FixContextDbRead,
  BuildFixContextOptions,
} from "./fix-context";
export { extractOpinionCodePointers } from "./code-pointers";
export type { CodePointer, CodePointerResolution } from "./code-pointers";
export {
  buildDbDiffEvent,
  buildDbReadBulkEvent,
  buildDbReadEvent,
  instrumentMssqlPool,
  instrumentMysqlClient,
  instrumentPgClient,
  instrumentSqliteDatabase,
  resolveDbRequestContext,
  classifyStatement,
  leadingSqlKeyword,
  looksLikePotentialWrite,
  parseMutation,
  parseRead,
  DEFAULT_SENSITIVE_DB_COLUMNS,
} from "./db";
export type {
  BuildDbDiffEventInput,
  BuildDbReadBulkEventInput,
  BuildDbReadEventInput,
  DbRequestContext,
  DuckTypedMssqlPool,
  DuckTypedMssqlRequest,
  DuckTypedMssqlResult,
  DuckTypedMysqlClient,
  DuckTypedMysqlResultHeader,
  DuckTypedPgClient,
  DuckTypedPgQueryResult,
  DuckTypedSqliteDatabase,
  DuckTypedSqliteRunResult,
  DuckTypedSqliteStatement,
  InstrumentDbClientOptions,
  InstrumentPgClientOptions,
  StatementClassification,
} from "./db";
export {
  buildBackendRequestStartEvent,
  buildBackendRequestEndEvent,
  buildBackendRequestErrorEvent,
  resolveBackendRequestCorrelation,
} from "./backend-events";
export type {
  BackendRequestEventInput,
  BackendRequestEndEventInput,
  BackendRequestErrorEventInput,
  BackendRequestCorrelation,
  BackendRequestHeaders,
} from "./backend-events";
export { buildLlmBundle, writeLlmBundle } from "./llm-bundle";
export type {
  LlmBundle,
  LlmBundleCompleteness,
  SessionIndexLike,
  WriteLlmBundleInput,
} from "./llm-bundle";
export { postProcess } from "./post-process";
export { inspectSession, formatInspection, InspectError } from "./inspect";
export type {
  SessionInspection,
  SessionInspectionArtifact,
  InspectSessionOptions,
} from "./inspect";
export { readPackageVersion } from "./version";
export {
  PROVIDER_IDS,
  PROVIDER_RECIPES,
  getProviderRecipe,
  isProviderId,
  renderProviderCliOutput,
  renderProviderConfig,
  renderProviderDoc,
  renderProviderReadme,
} from "./provider-recipes";
export type { ProviderId, ProviderRecipe } from "./provider-recipes";
export {
  createCrumbtrailExpressErrorMiddleware,
  createCrumbtrailExpressMiddleware,
} from "./express";
export {
  HeadlessRequestError,
  startHeadlessSession,
} from "./headless-session";
export type {
  HeadlessSession,
  HeadlessSessionOptions,
} from "./headless-session";
export type {
  CrumbtrailExpressErrorMiddleware,
  CrumbtrailExpressErrorNext,
  CrumbtrailExpressMiddleware,
  CrumbtrailExpressNext,
  CrumbtrailExpressOptions,
  CrumbtrailExpressRequest,
  CrumbtrailExpressResponse,
  CrumbtrailExpressWarning,
  CrumbtrailExpressWarningKind,
} from "./express";
export {
  compareSessions,
  CompareError,
  SESSION_COMPARE_SCHEMA_VERSION,
} from "./compare";
export {
  comparisonTitle,
  formatComparisonSummary,
  renderCompareReport,
  sessionRefLabel,
} from "./compare/report";
export {
  buildRegressionContext,
  REGRESSION_CONTEXT_SCHEMA_VERSION,
} from "./compare/regression-context";
export type {
  CompareOptions,
  ComparisonConfidence,
  ComparisonVerdict,
  Divergence,
  EnvChannelDelta,
  EnvDiff,
  EnvValueChange,
  SessionComparison,
} from "./compare";
export type { RegressionContext } from "./compare/regression-context";
export {
  CRUMBTRAIL_USER_AGENT,
  JiraTicketClient,
  TicketError,
  withBoundedRetry,
} from "./ticket/clients";
export type {
  BoundedRetryOptions,
  CommentingTicketConnector,
  JiraAuth,
  JiraBasicAuth,
  JiraBearerAuth,
  JiraTicketClientConfig,
  JiraTicketClientConfigLegacy,
  JiraTicketClientConfigWithAuth,
  TicketComment,
  TicketConnector,
} from "./ticket/clients";
export { jiraToSymptom } from "./ticket/normalize";
export type { TicketProvider } from "./ticket/normalize";
export { buildAdvisoryComment } from "./ticket/comment";
export type {
  AdvisoryCommentGap,
  AdvisoryCommentMatch,
  BuildAdvisoryCommentInput,
} from "./ticket/comment";
// Import from the barrel so the built-in adapters register into
// EVIDENCE_SOURCE_PROVIDERS when the library entry is loaded.
export {
  CRUMBTRAIL_USER_AGENT as EVIDENCE_SOURCE_USER_AGENT,
  EVIDENCE_SOURCE_PROVIDERS,
  evidenceSourcesFromEnv,
  evidenceRequestHeaders,
  registerEvidenceProvider,
} from "./evidence-sources";
export type {
  EvidenceSource,
  EvidenceSourceProvider,
  SourceHealth,
} from "./evidence-sources";
export {
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_SOURCE_TIMEOUT_MS,
  fetchAdapterEvidence,
} from "./evidence-sources";
export type {
  AdapterEvidence,
  AdapterSourceStats,
  FetchAdapterEvidenceOptions,
} from "./evidence-sources";
export {
  redactEvidenceGap,
  redactEvidenceItem,
  redactSourceResult,
} from "./evidence-sources";
export {
  SENTRY_AUTH_FIELDS,
  SENTRY_AUTH_TOKEN_ENV,
  SENTRY_DEFAULT_HOST,
  SENTRY_DESCRIPTOR,
  SENTRY_HOST_ENV,
  SENTRY_ORG_ENV,
  SentryEvidenceSource,
  buildSentryQuery,
  normalizeSentryIssue,
  sentryEvidenceProvider,
} from "./evidence-sources";
export type { SentryQueryPlan, SentrySourceConfig } from "./evidence-sources";
export {
  CLOUDWATCH_ACCESS_KEY_ID_ENV,
  CLOUDWATCH_AUTH_FIELDS,
  CLOUDWATCH_DESCRIPTOR,
  CLOUDWATCH_ENDPOINT_ENV,
  CLOUDWATCH_LOG_GROUPS_ENV,
  CLOUDWATCH_REGION_ENV,
  CLOUDWATCH_SECRET_ACCESS_KEY_ENV,
  CLOUDWATCH_SESSION_TOKEN_ENV,
  CloudWatchEvidenceSource,
  buildCloudWatchQuery,
  cloudWatchDeepLink,
  cloudWatchEvidenceProvider,
  normalizeCloudWatchRow,
} from "./evidence-sources";
export type {
  CloudWatchQueryPlan,
  CloudWatchResultRow,
  CloudWatchSourceConfig,
} from "./evidence-sources";
export { signSigV4 } from "./evidence-sources";
export type { SigV4Input, SignedHeaders } from "./evidence-sources";
export {
  SPLUNK_AUTH_FIELDS,
  SPLUNK_DESCRIPTOR,
  SPLUNK_HOST_ENV,
  SPLUNK_INDEX_ENV,
  SPLUNK_TOKEN_ENV,
  SPLUNK_WEB_URL_ENV,
  SplunkEvidenceSource,
  buildSplunkQuery,
  normalizeSplunkRow,
  splunkEvidenceProvider,
  splunkSearchDeepLink,
  splunkWebBase,
} from "./evidence-sources";
export type {
  SplunkQueryPlan,
  SplunkResultRow,
  SplunkSourceConfig,
} from "./evidence-sources";
export {
  DATADOG_API_KEY_ENV,
  DATADOG_APP_KEY_ENV,
  DATADOG_AUTH_FIELDS,
  DATADOG_DEFAULT_SITE,
  DATADOG_DESCRIPTOR,
  DATADOG_SITE_ENV,
  DatadogEvidenceSource,
  buildDatadogQuery,
  datadogAppBase,
  datadogEvidenceProvider,
  normalizeDatadogLog,
  normalizeDatadogSpan,
} from "./evidence-sources";
export type {
  DatadogLog,
  DatadogQueryPlan,
  DatadogSourceConfig,
  DatadogSpan,
} from "./evidence-sources";
export {
  POSTHOG_API_KEY_ENV,
  POSTHOG_AUTH_FIELDS,
  POSTHOG_DEFAULT_HOST,
  POSTHOG_DESCRIPTOR,
  POSTHOG_HOST_ENV,
  POSTHOG_PROJECT_ID_ENV,
  PostHogEvidenceSource,
  buildPostHogQuery,
  formatDuration,
  normalizePostHogEvent,
  normalizePostHogRecording,
  posthogEventDeepLink,
  posthogEvidenceProvider,
  posthogRecordingDeepLink,
} from "./evidence-sources";
export type {
  PostHogEvent,
  PostHogPropertyFilter,
  PostHogQueryPlan,
  PostHogRecording,
  PostHogSourceConfig,
} from "./evidence-sources";
export {
  CLOUDFLARE_AUTH_FIELDS,
  CLOUDFLARE_DESCRIPTOR,
  CLOUDFLARE_R2_ACCESS_KEY_ID_ENV,
  CLOUDFLARE_R2_ACCOUNT_ID_ENV,
  CLOUDFLARE_R2_BUCKET_ENV,
  CLOUDFLARE_R2_DATASET_ENV,
  CLOUDFLARE_R2_ENDPOINT_ENV,
  CLOUDFLARE_R2_PREFIX_ENV,
  CLOUDFLARE_R2_SECRET_ACCESS_KEY_ENV,
  CloudflareEvidenceSource,
  buildCloudflarePlan,
  cloudflareEvidenceProvider,
} from "./evidence-sources";
export type {
  CloudflareDataset,
  CloudflarePlan,
  CloudflareSourceConfig,
} from "./evidence-sources";
export type {
  EvidenceSourceDescriptor,
  EvidenceJoinKey,
} from "crumbtrail-core";
export {
  REPLAY_RESULT_SCHEMA_VERSION,
  buildReplayResult,
  parseReplayResult,
  writeReplayResult,
} from "./replay/result";
export type {
  ReplayDivergence,
  ReplayResult,
  ReplayStepResult,
  StepResolution,
} from "./replay/result";

// ── CP1: auto-capture (crash + console.error) ────────────────────────────────
// Append-only block. Do not reorder the exports above.
export { autoCapture, AUTO_CAPTURE_ERROR_EVENT } from "./auto-capture";
export type {
  AutoCaptureErrorContext,
  AutoCaptureErrorPhase,
  AutoCaptureHandle,
  AutoCaptureOptions,
  AutoCaptureSource,
} from "./auto-capture";

// ── CP4: OTLP/HTTP protobuf decoders ─────────────────────────────────────────
// Append-only block. Exported so the cloud edge (packages/cloud) can decode
// `application/x-protobuf` OTLP bodies at ingest and forward the JSON wire shape
// to the inner server, at parity with the local receiver's readOtlpBody.
export {
  decodeOtlpTraceProtobuf,
  decodeOtlpLogsProtobuf,
} from "./otel-protobuf";
export type {
  OtlpTraceRequest,
  OtlpLogsRequest,
  OtlpResourceSpans,
  OtlpResourceLogs,
} from "./otel-adapter";

// ── Node contract capability marker ──────────────────────────────────────────
// Append-only block. Do not reorder the exports above.
// The hosted cloud namespace-imports this package and reads
// NODE_CONTRACT_CAPABILITIES to decide whether the installed contract supports
// the tenant context factory and the provider neutral ticket comment. It fails
// closed when the marker is absent, so this re-export is load bearing and must
// survive bundling in both the ESM and CJS dist outputs.
export { NODE_CONTRACT_CAPABILITIES } from "./node-contract-capabilities";

// ── CP3: knowledge.v1 spec oracle (Confluence) ───────────────────────────────
// Append-only block. Do not reorder the exports above.
//
// A deliberate SUBSET of ./knowledge, NOT a mirror of it. This file is the
// published npm entry point (package.json exports["."] -> dist/index), so every
// name below is a compatibility obligation to external consumers. The internal
// barrel is wider on purpose and the two are not kept in sync: `htmlToText`,
// `capExcerptBytes`, `parseSpaceKeysEnv`, `MAX_EXCERPT_BYTES`, the CQL builders
// (`buildSpecSearchCql`, `sanitizeCqlText`, `describeCqlInputLoss`, …) and the
// gap constructors are implementation details the client already applies for
// you — an SDK consumer never assembles CQL or caps an excerpt by hand.
//
// What remains is exactly the "construct a client, call it, read the result"
// path: the client and its env factory, the env var names an operator sets, the
// limit bounds the schema advertises, the clock `searchSpecs` requires (it is
// not defaulted, by design), the not-configured result, and the result types.
//
// The ./knowledge barrel has NO side effects on the evidence framework:
// importing it registers nothing and leaves EVIDENCE_SOURCE_PROVIDERS
// unchanged. The `searchSpecs` MCP tool is the first consumer; results are
// advisory documentation and never enter assembleBundle.
export {
  confluenceClientFromEnv,
  ConfluenceKnowledgeClient,
  CONFLUENCE_API_TOKEN_ENV,
  CONFLUENCE_AUTH_FIELDS,
  CONFLUENCE_BASE_URL_ENV,
  CONFLUENCE_EMAIL_ENV,
  CONFLUENCE_SPACE_KEYS_ENV,
  DEFAULT_SPEC_LIMIT,
  MAX_SPEC_LIMIT,
  notConfiguredKnowledgeResult,
  KNOWLEDGE_SCHEMA_VERSION,
  systemClock,
} from "./knowledge";
export type {
  ConfluenceClientConfig,
  SpecSearchRequest,
  KnowledgeClock,
  KnowledgeResult,
  SpecExcerpt,
} from "./knowledge";
