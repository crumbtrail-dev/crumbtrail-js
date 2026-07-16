import type { SessionStore } from "./session-store";

export const CRUMBTRAIL_SCHEMA_VERSION = 1 as const;

export const CRUMBTRAIL_EVENT_KINDS = {
  navigation: "navigation",
  appLifecycle: "app-lifecycle",
  nativeCrash: "native-crash",
  viewSnapshot: "view-snapshot",
} as const;

export type CrumbtrailPlatform =
  "web" | "react-native" | "ios" | "android" | "flutter" | "webview" | "node";

export interface CrumbtrailSdkDescriptor {
  name: string;
  version?: string;
}

export type CrumbtrailCapabilities = string[];

type RequireAtLeastOne<T, Keys extends keyof T = keyof T> = Pick<
  T,
  Exclude<keyof T, Keys>
> &
  {
    [K in Keys]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<Keys, K>>>;
  }[Keys];

type TargetDescriptorIdentityKey =
  | "role"
  | "label"
  | "testID"
  | "accessibilityId"
  | "componentName"
  | "routePath"
  | "ancestryHash";

interface TargetDescriptorBase {
  /** Semantic role of the target, e.g. button, link, textbox, screen, view. */
  role?: string;
  /** Human-readable label visible to or announced for the user. */
  label?: string;
  /** Stable test identifier supplied by the app. */
  testID?: string;
  /** Stable accessibility/native identifier supplied by the app. */
  accessibilityId?: string;
  /** Framework component or native view name. */
  componentName?: string;
  /** App route or screen path where the target appears. */
  routePath?: string;
  /** Privacy-safe hash of the target's ancestor path. */
  ancestryHash?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  redaction?: unknown;
  /** @deprecated Use testID. Accepted while legacy web/mobile emitters migrate. */
  testId?: string;
  /** @deprecated Use accessibilityId or label. Accepted while legacy emitters migrate. */
  accessibilityLabel?: string;
  /** @deprecated Use label. Accepted while legacy web emitters migrate. */
  text?: string;
  /** @deprecated Use componentName. Accepted while legacy emitters migrate. */
  viewName?: string;
  /** @deprecated Use routePath. Accepted while legacy emitters migrate. */
  screen?: string;
  /** @deprecated Accepted while legacy web emitters migrate. */
  selector?: string;
}

export type TargetDescriptor = RequireAtLeastOne<
  TargetDescriptorBase,
  TargetDescriptorIdentityKey
>;

export interface BugEvent {
  /** Unix timestamp in milliseconds */
  t: number;
  /** Event category short code */
  k: string;
  /** Type-specific payload */
  d: Record<string, unknown>;
  /** Version of the shared event envelope. Missing means v1 for backward compatibility. */
  schemaVersion?: typeof CRUMBTRAIL_SCHEMA_VERSION;
  /** Source runtime. Missing means `web` for backward compatibility with current browser SDKs. */
  platform?: CrumbtrailPlatform;
  /** SDK identity for non-browser and future SDKs. */
  sdk?: CrumbtrailSdkDescriptor;
  /** Optional capability names enabled by the emitting SDK/session. */
  capabilities?: CrumbtrailCapabilities;
  /** Optional normalized target reference for web/mobile events. */
  target?: TargetDescriptor;
  /** Active recording session identifier when an extension workflow session owns the event. */
  sessionId?: string;
  /** Milliseconds elapsed from the active recording session's canonical startedAt timestamp. */
  offsetMs?: number;
}

export interface BugReport {
  bugId: string;
  sessionId: string;
  flaggedAt: number;
  windowMs: number;
  note?: string;
  voiceNote?: string;
  url: string;
  userAgent: string;
  /** Pseudonymous identifiers supplied with `identify`; email shaped values are never retained. */
  accountId?: string;
  userId?: string;
  tags?: string[];
  summary: {
    errorCount: number;
    failedRequestCount: number;
    eventCount: number;
    eventKinds: Record<string, number>;
    durationMs: number;
    stateProviderCount?: number;
  };
}

/** Canonical event kind for a database row diff (`k:'db.diff'`). */
export const DB_DIFF_EVENT_KIND = "db.diff" as const;

/**
 * Canonical event kind for an aggregate capped database diff summary (`k:'db.diff.bulk'`).
 * The comparator intentionally ignores this kind: over-cap statements are treated as batch work,
 * while per-row `db.diff` events remain the UI-flow comparison signal.
 */
export const DB_DIFF_BULK_EVENT_KIND = "db.diff.bulk" as const;

/** Canonical event kind for a capped database read row (`k:'db.read'`). */
export const DB_READ_EVENT_KIND = "db.read" as const;

/** Canonical event kind for an aggregate capped database read summary (`k:'db.read.bulk'`). */
export const DB_READ_BULK_EVENT_KIND = "db.read.bulk" as const;

/** Canonical event kind for a bounded record of evidence the capture path could not collect. */
export const CAPTURE_GAP_EVENT_KIND = "capture_gap" as const;

/**
 * Type specific payload (`d`) of a `k:'capture_gap'` event. `detail` is deliberately a bounded,
 * redacted diagnostic descriptor such as an error name, table and operation, or leading SQL
 * keyword. It must never contain raw SQL values or other user data.
 */
export interface CaptureGapEventData {
  kind: "capture_gap";
  surface: "db_diff" | "backend_request" | "browser" | "queue";
  reason:
    | "unparsed_sql"
    | "uninstrumented_client"
    | "missing_session_id"
    | "capture_exception"
    | "window_miss"
    | "sampled_out"
    | "header_stripped";
  detail?: string;
  t: number;
}

/** Mutating operation a `db.diff` event records. */
export type DbDiffOp = "insert" | "update" | "delete";

/**
 * Database engine that produced a `db.diff` / `db.read` event. Downstream consumers (evidence
 * index, fix-context, comparator) treat every engine identically — the engine tag exists so
 * agents and humans know which dialect the captured statement ran against.
 */
export type DbEngine = "postgres" | "mysql" | "mssql" | "sqlite";

/**
 * Type-specific payload (`d`) of a `k:'db.diff'` event: the row(s) that changed for one
 * mutating statement, correlated to the request that caused them via `requestId` (which equals
 * the active request's traceId per the correlation bridge in `correlation.ts`). `after` carries
 * the post-image (insert/update); `before` is the pre-image, only present when before-capture is
 * enabled (and for deletes it carries the removed row). Sensitive columns are redacted out of
 * `after`/`before`/`pk` before the event ever rests. The shape is identical across engines; only
 * the `engine` tag differs.
 */
export interface DbDiffEventData {
  engine: DbEngine;
  op: DbDiffOp;
  table: string;
  /** Primary-key column→value map identifying the affected row, or `null` when unresolved. */
  pk: Record<string, unknown> | null;
  /** Post-image of the affected row (insert/update); omitted for deletes. */
  after?: Record<string, unknown>;
  /** Pre-image of the affected row; only captured behind the before-capture flag (and for deletes). */
  before?: Record<string, unknown>;
  /**
   * Present only on an image-less statement-level fallback event where per-row images were
   * unobtainable (e.g. a MySQL multi-row insert). Such events carry `pk: null` and no
   * `after`/`before`; this records how many rows the statement changed so the write stays visible.
   */
  rowCount?: number;
  /** Correlation id; equals the active request's traceId so it lands in the same evidence window. */
  requestId: string;
  /** Redaction metadata for any column-level values dropped/masked before rest. */
  redaction?: unknown;
}

/**
 * Type-specific payload (`d`) of a `k:'db.diff.bulk'` event emitted when a mutating statement
 * affects more rows than the configured per-statement `db.diff` cap. It summarizes truncation
 * without duplicating every changed row payload.
 */
export interface DbDiffBulkEventData {
  engine: DbEngine;
  op: DbDiffOp;
  table: string;
  requestId: string;
  rowCount: number;
  emittedRows: number;
  truncatedRows: number;
  samplePks: Array<Record<string, unknown>>;
}

/**
 * Type-specific payload (`d`) of a `k:'db.read'` event: one redacted row read by a SELECT within
 * an active request scope. Disabled by default because read capture can increase PII surface.
 */
export interface DbReadEventData {
  engine: DbEngine;
  table: string;
  pk: Record<string, unknown> | null;
  row: Record<string, unknown>;
  requestId: string;
  redaction?: unknown;
}

/**
 * Type-specific payload (`d`) of a `k:'db.read.bulk'` event emitted when a SELECT returns more rows
 * than the configured read cap. It proves read volume without resting every row.
 */
export interface DbReadBulkEventData {
  engine: DbEngine;
  table: string;
  requestId: string;
  rowCount: number;
  emittedRows: number;
  truncatedRows: number;
  samplePks: Array<Record<string, unknown>>;
}

export type InteractionElementDescriptor = Record<string, unknown>;
export type InteractionElementDescriptorFactory = (
  element: Element,
) => InteractionElementDescriptor;

/**
 * Declarative environment input the host app passes to `logger.setEnv`. Both fields are
 * vendor-agnostic free-form maps (no LaunchDarkly/PostHog adapters). Values are redacted
 * through the browser redaction policy before they rest in any `k:'env'` event.
 */
export interface EnvDeclaration {
  /** Active feature flags, e.g. `{ newCheckout: true, plan: 'pro' }`. */
  flags?: Record<string, unknown>;
  /** Runtime config the app wants attached to the session, e.g. `{ region: 'eu' }`. */
  config?: Record<string, unknown>;
}

/**
 * Redaction-aware environment snapshot captured once at session start (the `d` payload of a
 * `k:'env'` event with `kind:'snapshot'`). Browser/device fields are best-effort and guarded
 * for non-browser/SSR runtimes; `locale`/`timezone` are available in Node via `Intl`.
 */
export interface EnvSnapshot {
  /** Discriminates the initial full snapshot from later `setEnv` deltas. */
  kind: "snapshot" | "delta";
  userAgent?: string;
  browser?: { name: string; version?: string };
  os?: string;
  viewport?: { w: number; h: number };
  locale?: string;
  timezone?: string;
  /** Redacted feature flags declared via `setEnv`. */
  flags?: Record<string, unknown>;
  /** Redacted runtime config declared via `setEnv`. */
  config?: Record<string, unknown>;
  /** Browser redaction metadata for any redacted flag/config values. */
  redaction?: unknown;
}

export interface FlagBugOptions {
  note?: string;
  windowMs?: number;
  tags?: string[];
  voiceBlob?: Blob;
}

/** Pseudonymous identifiers that let a captured artifact join to a support ticket. */
export interface CrumbtrailIdentity {
  accountId?: string;
  userId?: string;
}

/** Remote capture policy polling options. */
export interface CaptureConfigPollingOptions {
  endpoint: string;
  projectKey: string;
  intervalMs?: number;
}

export interface AddBugEventOptions {
  type: string;
  data: Record<string, unknown>;
  schemaVersion?: BugEvent["schemaVersion"];
  platform?: BugEvent["platform"];
  sdk?: BugEvent["sdk"];
  capabilities?: BugEvent["capabilities"];
  target?: BugEvent["target"];
  sessionId?: BugEvent["sessionId"];
  offsetMs?: BugEvent["offsetMs"];
}

export interface CrumbtrailConfig {
  // Module toggles
  console: boolean;
  network: boolean;
  interactions: boolean;
  keystrokes: boolean;
  scroll: boolean;
  visibility: boolean;
  clipboard: boolean;
  errors: boolean;
  performance: boolean;
  cookies: boolean;
  storage: boolean;
  video: boolean;
  audio: boolean;

  // Network
  networkMaxBodySize: number;
  networkExcludeUrls: string[];
  networkCaptureHeaders: boolean;
  networkCorrelationHeaders: boolean;
  networkCorrelationAllowedOrigins: string[];

  // Interaction
  maskInputTypes: string[];
  /**
   * Always masks DOM derived text before it enters the browser ring buffer.
   * Use data-crumbtrail-unmask only on an individual element that is safe to
   * capture.
   */
  maskAllText: true;
  /**
   * Always masks input and keystroke values before they enter the browser ring
   * buffer. Use data-crumbtrail-unmask only on an individual element that is
   * safe to capture.
   */
  maskAllInputs: true;
  ignoreSelectors: string[];
  describeInteractionElement?: InteractionElementDescriptorFactory;

  // Keystroke
  keystrokeThrottleMs: number;

  // Scroll
  scrollThrottleMs: number;
  scrollElements: string[];

  // Clipboard
  clipboardMaxLength: number;
  captureRawClipboard: boolean;

  // Cookie
  cookiePollIntervalMs: number;
  cookieMaskNames: string[];
  cookieValueMaxLength: number;

  // Storage
  storageValueMaxLength: number;
  storageExcludeKeys: string[];
  captureIdb: boolean;
  captureCacheApi: boolean;

  // Media
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  mediaChunkIntervalMs: number;

  // Ring buffer
  ringBufferMs: number;
  ringBufferMaxEvents: number;

  // Production capture
  /** Explicit consent prevents all buffering until `consent(true)` is called. */
  consentMode: "implicit" | "required";
  /** Treat Global Privacy Control as required consent until `consent(true)` is called. */
  respectGpc: boolean;
  /** Session sampling rate for capture candidates. */
  captureSampleRate: number;
  /** Trigger free baseline session sampling rate. */
  baselineSampleRate: number;
  /** Buffer locally until a trigger fires, then persist the window and tail. */
  flightRecorder: boolean;
  /** Capture duration after a flight recorder trigger before finalizing. */
  flightRecorderTailMs: number;
  /** Optional cloud capture config endpoint polled after initialization. */
  configEndpoint?: string;
  /** Project key sent with cloud capture config requests. */
  projectKey?: string;
  /** Config poll cadence when `configEndpoint` and `projectKey` are supplied. */
  configPollIntervalMs: number;

  // Heartbeat
  heartbeat: boolean;

  // Environment snapshot
  environment: boolean;

  // Widget
  widget: boolean;

  // State capture
  stateMaxBytes: number;
  captureRawState: boolean;

  // Auto-flag on error: snapshot the ring buffer automatically when an err/rej event fires.
  autoFlagOnError: boolean;
  /** Enable automatic capture for uncaught browser errors. */
  autoFlagOnUncaughtError: boolean;
  /** Enable automatic capture for unhandled promise rejections. */
  autoFlagOnUnhandledRejection: boolean;
  /** Enable automatic capture for instrumented HTTP 5xx responses. */
  autoFlagOnRequest5xx: boolean;
  /** Allow app code and the widget to call `flag()` as an explicit beacon. */
  explicitBeacon: boolean;
  /** Keep the server side pull policy available to heartbeat integrations. */
  serverSidePull: boolean;
  // Quiet period after the last new error before the auto-flag fires. Doubles as post-roll:
  // the snapshot window then includes the cascade's aftermath, and a burst costs one report.
  autoFlagDebounceMs: number;
  // Hard cap on auto-captured reports per session (shared across every auto-flag detector).
  autoFlagMaxPerSession: number;

  // Precognitive auto-flag: snapshot the ring buffer on behavioral leading indicators of a silent
  // failure (rage-clicks, retry storms) — before an error throws, or when none ever does. Opt-in.
  autoFlagOnSignals: boolean;
  /** Per-signal switches let a remote policy enable only the selected behavioral triggers. */
  autoFlagOnRageClick: boolean;
  autoFlagOnRetryStorm: boolean;
  autoFlagOnSlowResponse: boolean;
  autoFlagOnAbandonedFlow: boolean;
  // Clicks on the same target within rageClickWindowMs that trip a rage-click auto-flag.
  rageClickThreshold: number;
  rageClickWindowMs: number;
  // Requests to the same endpoint within retryStormWindowMs that trip a retry-storm auto-flag.
  retryStormThreshold: number;
  retryStormWindowMs: number;
  // Failed responses (status >= 400) to the same endpoint within retryStormWindowMs that trip it.
  retryStormFailThreshold: number;
  // Responses at/above slowRequestMs, this many within slowRequestWindowMs, trip a slow-responses auto-flag.
  slowRequestMs: number;
  slowRequestCount: number;
  slowRequestWindowMs: number;
  // Page hidden within abandonedFlowWindowMs of the last of >= abandonedFlowMinInputs unsubmitted
  // inputs trips an abandoned-flow auto-flag.
  abandonedFlowWindowMs: number;
  abandonedFlowMinInputs: number;

  // DOM snapshot captured at flag time (one-shot outerHTML, redacted; cheap once, costly to stream).
  domSnapshot: boolean;
  domSnapshotMaxBytes: number;

  // Privacy opt-ins
  captureRawConsole: boolean;
  captureRawErrors: boolean;

  // Transport
  transport: "auto" | "tauri" | "http";
  transportInstance?: CrumbtrailTransport;
  httpEndpoint: string;
  httpAuthToken?: string;
  flushIntervalMs: number;
  flushBufferSize: number;

  // Blob sender (wired from transport by default; override for custom handling)
  sendBlob?: (name: string, blob: Blob) => void;

  // Session continuity
  // 'session' (default in browser): persist the session id in sessionStorage so a hard page
  //   reload within the idle window reuses the same session instead of minting a new one.
  // 'memory' / 'none': never persist — every init() mints a fresh session id.
  sessionPersistence: "session" | "memory" | "none";
  // Rolling idle window (ms). A persisted session older than this is treated as stale.
  sessionIdleMs: number;
  // Explicit session id override. When set, it always wins and is persisted (if persistence is on).
  sessionId?: string;
  // Optional platform storage adapter. Defaults to browser sessionStorage when available.
  sessionStore?: SessionStore;
}

export const DEFAULT_CONFIG: CrumbtrailConfig = {
  console: true,
  network: true,
  interactions: true,
  keystrokes: true,
  scroll: true,
  visibility: true,
  clipboard: true,
  errors: true,
  performance: true,
  cookies: true,
  storage: true,
  video: false,
  audio: false,

  networkMaxBodySize: 51200,
  networkExcludeUrls: [],
  networkCaptureHeaders: true,
  networkCorrelationHeaders: true,
  networkCorrelationAllowedOrigins: [],

  maskInputTypes: ["password", "email", "tel", "number", "search", "url"],
  maskAllText: true,
  maskAllInputs: true,
  ignoreSelectors: [],

  keystrokeThrottleMs: 0,

  scrollThrottleMs: 500,
  scrollElements: [],

  clipboardMaxLength: 500,
  captureRawClipboard: false,

  cookiePollIntervalMs: 2000,
  cookieMaskNames: [],
  cookieValueMaxLength: 500,

  storageValueMaxLength: 500,
  storageExcludeKeys: [],
  captureIdb: true,
  captureCacheApi: true,

  videoBitsPerSecond: 1_000_000,
  audioBitsPerSecond: 64_000,
  mediaChunkIntervalMs: 10_000,

  ringBufferMs: 300_000,
  ringBufferMaxEvents: 50_000,

  consentMode: "implicit",
  respectGpc: true,
  captureSampleRate: 1,
  baselineSampleRate: 0,
  flightRecorder: false,
  flightRecorderTailMs: 60_000,
  configPollIntervalMs: 60_000,

  heartbeat: true,

  environment: true,

  widget: false,

  stateMaxBytes: 32_768,
  captureRawState: false,

  autoFlagOnError: false,
  autoFlagOnUncaughtError: true,
  autoFlagOnUnhandledRejection: true,
  autoFlagOnRequest5xx: false,
  explicitBeacon: true,
  serverSidePull: false,
  autoFlagDebounceMs: 2000,
  autoFlagMaxPerSession: 10,

  autoFlagOnSignals: false,
  autoFlagOnRageClick: true,
  autoFlagOnRetryStorm: true,
  autoFlagOnSlowResponse: true,
  autoFlagOnAbandonedFlow: true,
  rageClickThreshold: 4,
  rageClickWindowMs: 1500,
  retryStormThreshold: 4,
  retryStormWindowMs: 5000,
  retryStormFailThreshold: 2,
  slowRequestMs: 3000,
  slowRequestCount: 3,
  slowRequestWindowMs: 10000,
  abandonedFlowWindowMs: 30000,
  abandonedFlowMinInputs: 2,

  domSnapshot: true,
  domSnapshotMaxBytes: 262_144,

  captureRawConsole: false,
  captureRawErrors: false,

  transport: "auto",
  httpEndpoint: "http://localhost:9898",
  httpAuthToken: "",
  flushIntervalMs: 5000,
  flushBufferSize: 100,

  sessionPersistence: "session",
  sessionIdleMs: 1_800_000, // 30 minutes
};

export type CrumbtrailPreset = "full" | "light" | "passive";

export const PRESET_FULL: Partial<CrumbtrailConfig> = {
  widget: true,
  autoFlagOnError: true,
  autoFlagOnSignals: true,
};

export const PRESET_LIGHT: Partial<CrumbtrailConfig> = {
  keystrokes: false,
  video: false,
  audio: false,
  clipboard: false,
  cookies: false,
  storage: false,
  performance: false,
};

// Embedded end-user monitoring: no widget, but silently auto-capture the reproduction window
// on both errors and behavioral leading indicators (rage-clicks, retry storms).
export const PRESET_PASSIVE: Partial<CrumbtrailConfig> = {
  autoFlagOnError: true,
  autoFlagOnSignals: true,
};

export type CollectorCleanup = () => void;

export interface CollectorContext {
  sessionId: string;
  /**
   * Returns env declared via `setEnv` before the snapshot is emitted so the environment
   * collector can fold it into the initial `k:'env'` snapshot. Absent for other collectors.
   */
  getDeclaredEnv?: () => EnvDeclaration;
  /** Called by the environment collector once the initial snapshot has been emitted. */
  onEnvEmitted?: () => void;
  /**
   * Lets a collector expose live diagnostic state (e.g. in-flight requests) that is snapshotted
   * at flag time through the same redaction/truncation path as app state providers.
   */
  registerStateProvider?: (name: string, provider: () => unknown) => () => void;
}

export interface CrumbtrailTransport {
  sendEvents(events: BugEvent[]): Promise<void>;
  sendBlob(
    name: string,
    blob: Blob,
    metadata?: Record<string, unknown>,
  ): Promise<void>;
  startSession(
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void>;
  endSession(sessionId: string): Promise<void>;
  sendBugReport(
    report: BugReport,
    events: BugEvent[],
    voiceBlob?: Blob,
  ): Promise<void>;
}
