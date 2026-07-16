export { Crumbtrail } from "./bug-logger";
export { EventBus } from "./event-bus";
export { RingBuffer } from "./ring-buffer";
export { HttpTransport } from "./transports/http";
export {
  DEFAULT_SESSION_STORAGE_KEY,
  createWebSessionStore,
} from "./session-store";
export {
  WebTargetDescriptorResolver,
  webTargetDescriptorResolver,
} from "./target-resolver";
export * from "./redaction";
export {
  CRUMBTRAIL_REQUEST_HEADER,
  CRUMBTRAIL_REQUEST_HEADER_LOWER,
  CRUMBTRAIL_REQUEST_ID_MAX_LENGTH,
  CRUMBTRAIL_SESSION_HEADER,
  CRUMBTRAIL_SESSION_HEADER_LOWER,
  createCrumbtrailRequestHeaders,
  generateRequestId,
  W3C_TRACEPARENT_HEADER,
  parseTraceparent,
  formatTraceparent,
  generateTraceId,
  generateSpanId,
  generateTraceContext,
  canInjectCorrelationHeaders,
  resolveOutboundCorrelation,
} from "./correlation";
export type { W3CTraceContext, OutboundCorrelation } from "./correlation";
export { buildCaptureGapEvent } from "./capture-gap";
export type { BuildCaptureGapEventInput } from "./capture-gap";
export type {
  AddBugEventOptions,
  BugEvent,
  CrumbtrailCapabilities,
  CrumbtrailConfig,
  CrumbtrailPreset,
  CrumbtrailPlatform,
  CrumbtrailSdkDescriptor,
  CrumbtrailTransport,
  BugReport,
  CollectorCleanup,
  CollectorContext,
  DbDiffEventData,
  DbDiffBulkEventData,
  DbDiffOp,
  DbEngine,
  DbReadBulkEventData,
  DbReadEventData,
  CaptureGapEventData,
  EnvDeclaration,
  EnvSnapshot,
  FlagBugOptions,
  InteractionElementDescriptor,
  InteractionElementDescriptorFactory,
  TargetDescriptor,
} from "./types";
export type { PersistedSession, SessionStore } from "./session-store";
export type { TargetDescriptorResolver } from "./target-resolver";
export {
  environmentCollector,
  buildEnvSnapshot,
  buildEnvDelta,
} from "./collectors/environment";
export {
  CRUMBTRAIL_EVENT_KINDS,
  CRUMBTRAIL_SCHEMA_VERSION,
  DB_DIFF_BULK_EVENT_KIND,
  DB_DIFF_EVENT_KIND,
  DB_READ_BULK_EVENT_KIND,
  DB_READ_EVENT_KIND,
  CAPTURE_GAP_EVENT_KIND,
  DEFAULT_CONFIG,
  PRESET_FULL,
  PRESET_LIGHT,
  PRESET_PASSIVE,
} from "./types";
export {
  computeElementSignature,
  computeElementPath,
  hashString,
} from "./signature";
export type { ElementSignature } from "./signature";
export { EVIDENCE_SCHEMA_VERSION } from "./evidence";
export type {
  EvidenceItem,
  EvidenceLane,
  EvidenceRef,
  IntentSignal,
} from "./evidence";
export { inferIntent } from "./intent";
export type { GitHostRef, CommitInfo, GitHostClient } from "./intent";
export { createAutoFlagController } from "./auto-flag";
export type { AutoFlagOptions, AutoFlagController } from "./auto-flag";
export {
  errorDetector,
  errorSignature,
  rageClickDetector,
  retryStormDetector,
  slowResponseDetector,
  abandonedFlowDetector,
} from "./signals";
export type {
  Signal,
  SignalDetector,
  RageClickOptions,
  RetryStormOptions,
  SlowResponseOptions,
  AbandonedFlowOptions,
} from "./signals";
export { FUSION_SCHEMA_VERSION, assembleBundle } from "./fusion";
export type {
  HypothesisKind,
  Symptom,
  Hypothesis,
  Verification,
  Located,
  ContextCompleteness,
  Escalation,
  EvidenceGap,
  CaptureDirective,
  RankedBundle,
  AssembleBundleInput,
} from "./fusion";
export { EVIDENCE_SOURCE_SCHEMA_VERSION } from "./evidence-source";
export type {
  EvidenceJoinKey,
  EvidenceSourceDescriptor,
  EvidenceQuery,
  EvidenceSourceResult,
} from "./evidence-source";
export { STACK_IDS } from "./stacks";
export type { Stack } from "./stacks";
