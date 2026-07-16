import { EventBus } from "./event-bus";
import { RingBuffer } from "./ring-buffer";
import type {
  AddBugEventOptions,
  BugEvent,
  CaptureConfigPollingOptions,
  CrumbtrailConfig,
  CrumbtrailIdentity,
  CrumbtrailPreset,
  CrumbtrailTransport,
  BugReport,
  CollectorCleanup,
  CollectorContext,
  FlagBugOptions,
} from "./types";
import {
  DEFAULT_CONFIG,
  PRESET_FULL,
  PRESET_LIGHT,
  PRESET_PASSIVE,
} from "./types";
import { createCrumbtrailRequestHeaders } from "./correlation";
import { createAutoFlagController } from "./auto-flag";
import {
  errorDetector,
  request5xxDetector,
  rageClickDetector,
  retryStormDetector,
  slowResponseDetector,
  abandonedFlowDetector,
  type SignalDetector,
} from "./signals";

const PRESETS: Record<CrumbtrailPreset, Partial<CrumbtrailConfig>> = {
  full: PRESET_FULL,
  light: PRESET_LIGHT,
  passive: PRESET_PASSIVE,
};
import { generateSessionId, now } from "./utils";
import { HttpTransport } from "./transports/http";
import {
  createWebSessionStore,
  type SessionStore,
} from "./session-store";
import { consoleCollector } from "./collectors/console";
import { errorCollector } from "./collectors/error";
import { interactionCollector } from "./collectors/interaction";
import { keystrokeCollector } from "./collectors/keystroke";
import { scrollCollector } from "./collectors/scroll";
import { visibilityCollector } from "./collectors/visibility";
import { clipboardCollector } from "./collectors/clipboard";
import { cookieCollector } from "./collectors/cookie";
import { storageCollector } from "./collectors/storage";
import { networkCollector } from "./collectors/network";
import { performanceCollector } from "./collectors/performance";
import { heartbeatCollector } from "./collectors/heartbeat";
import { environmentCollector, buildEnvDelta } from "./collectors/environment";
import type { EnvDeclaration } from "./types";
import {
  attachRedactionMetadata,
  REDACTED_VALUE,
  redactNetworkTextBody,
  redactUrl,
  redactValue,
  type PayloadSummary,
} from "./redaction";
import { buildCaptureGapEvent } from "./capture-gap";
import { buildMaskedDomSnapshot, maskText } from "./masking";
import { CAPTURE_GAP_EVENT_KIND } from "./types";

type Collector = (
  bus: EventBus,
  config: CrumbtrailConfig,
  context: CollectorContext,
) => CollectorCleanup;

const COLLECTOR_MAP: Record<string, Collector> = {
  environment: environmentCollector,
  console: consoleCollector,
  errors: errorCollector,
  interactions: interactionCollector,
  keystrokes: keystrokeCollector,
  scroll: scrollCollector,
  visibility: visibilityCollector,
  clipboard: clipboardCollector,
  cookies: cookieCollector,
  storage: storageCollector,
  network: networkCollector,
  performance: performanceCollector,
  heartbeat: heartbeatCollector,
};

const DEFAULT_CONFIG_POLL_INTERVAL_MS = 60_000;
const EMAIL_SHAPED_VALUE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
type FlightRecorderState =
  | "armed"
  | "buffering"
  | "triggered"
  | "tailing"
  | "finalizing"
  | "finalized";
const REMOTE_CONFIG_KEYS = [
  "captureSampleRate",
  "baselineSampleRate",
  "flightRecorder",
  "flightRecorderTailMs",
  "autoFlagOnError",
  "autoFlagOnUncaughtError",
  "autoFlagOnUnhandledRejection",
  "autoFlagOnRequest5xx",
  "explicitBeacon",
  "serverSidePull",
  "autoFlagOnSignals",
  "autoFlagOnRageClick",
  "autoFlagOnRetryStorm",
  "autoFlagOnSlowResponse",
  "autoFlagOnAbandonedFlow",
  "autoFlagDebounceMs",
  "autoFlagMaxPerSession",
  "rageClickThreshold",
  "rageClickWindowMs",
  "retryStormThreshold",
  "retryStormWindowMs",
  "retryStormFailThreshold",
  "slowRequestMs",
  "slowRequestCount",
  "slowRequestWindowMs",
  "abandonedFlowWindowMs",
  "abandonedFlowMinInputs",
] as const satisfies ReadonlyArray<keyof CrumbtrailConfig>;

/**
 * Minimum spacing between severity-triggered flushes. An error storm must not
 * become a request storm: the first severe event flushes immediately, the
 * rest ride the next interval flush. Only tap-triggered flushes are
 * rate-limited — interval, buffer-size, flagBug, stop, and resume flushes are
 * never affected.
 */
const SEVERITY_FLUSH_MIN_INTERVAL_MS = 1000;

/**
 * Transport that drops every call. Backs the inert instance returned when
 * `init()` runs outside a browser, guaranteeing no socket is opened during SSR
 * or a build step.
 */
const INERT_TRANSPORT: CrumbtrailTransport = {
  async sendEvents() {},
  async sendBlob() {},
  async startSession() {},
  async endSession() {},
  async sendBugReport() {},
};

function bodyPlaceholder(summary: PayloadSummary | undefined): string {
  return summary ? `[${summary.action}:${summary.reason}]` : "[REDACTED]";
}

function readPersistedSessionId(
  store: SessionStore,
  idleMs: number,
): string | undefined {
  const persisted = store.read();
  if (!persisted) return undefined;
  if (now() - persisted.lastActivity > idleMs) return undefined; // stale -> mint a fresh session
  return persisted.id;
}

function writePersistedSession(store: SessionStore, id: string): void {
  store.write({ id, lastActivity: now() });
}

export class Crumbtrail {
  private bus: EventBus;
  private transport: CrumbtrailTransport;
  private ringBuffer: RingBuffer;
  private cleanups: CollectorCleanup[] = [];
  private config: CrumbtrailConfig;
  private sessionId: string;
  private widgetCleanup?: () => void;
  private stateProviders = new Map<string, () => unknown>();
  private declaredFlags: Record<string, unknown> = {};
  private declaredConfig: Record<string, unknown> = {};
  private envEmitted = false;
  private autoFlagCleanup?: () => void;
  private configPollingCleanup?: () => void;
  private configPollGeneration = 0;
  private flightRecorderTimer?: ReturnType<typeof setTimeout>;
  private flightRecorderFinalization?: Promise<{ bugId: string }>;
  private flightRecorderTailResolver?: (result: { bugId: string }) => void;
  private flightRecorderState: FlightRecorderState = "armed";
  private consentGranted: boolean;
  private explicitConsent?: boolean;
  private killSwitch = false;
  private remotePolicyReady: boolean;
  private samplingShed: boolean;
  private samplingGapEmitted = false;
  private baselineSampled: boolean;
  private sessionStarted = false;
  private sessionMetadataWrite: Promise<void> = Promise.resolve();
  private stopped = false;
  private identity: CrumbtrailIdentity = {};

  private constructor(
    config: CrumbtrailConfig,
    bus: EventBus,
    transport: CrumbtrailTransport,
    ringBuffer: RingBuffer,
    sessionId: string,
  ) {
    this.config = config;
    this.bus = bus;
    this.transport = transport;
    this.ringBuffer = ringBuffer;
    this.sessionId = sessionId;
    this.remotePolicyReady = !(config.configEndpoint && config.projectKey);
    this.consentGranted =
      config.consentMode === "implicit" &&
      !(config.respectGpc && hasGlobalPrivacyControl());
    this.samplingShed = !isSampled(config.captureSampleRate);
    this.baselineSampled =
      !this.samplingShed && isSampled(config.baselineSampleRate);
    this.updateFlightRecorderState();
  }

  static init(
    presetOrConfig?: CrumbtrailPreset | Partial<CrumbtrailConfig>,
  ): Crumbtrail {
    const overrides =
      typeof presetOrConfig === "string"
        ? PRESETS[presetOrConfig]
        : presetOrConfig;
    const config: CrumbtrailConfig = {
      ...DEFAULT_CONFIG,
      ...overrides,
      maskAllText: true,
      maskAllInputs: true,
    };

    // Non-browser guard (SSR, `next build`). init() is documented as a
    // module-scope call, so it runs during server render/build where `window`
    // is undefined. The collectors below bind `window.addEventListener` and
    // would throw `ReferenceError: window is not defined`, failing the host
    // build through no fault of the caller. Instead return an inert instance:
    // no collectors, no event loop, no network, no session POST. Every public
    // method already guards `window`/`document`, so isomorphic code can call
    // init()/flagBug() unconditionally and full capture kicks in when the same
    // bundle later runs in a real browser.
    //
    // A caller that supplies its own `transportInstance` is opting into
    // deliberate programmatic use (server-side clients, tests) and is exempt —
    // that path never touches `window` unless it also enables a window-binding
    // collector, which is then the caller's explicit choice.
    if (typeof window === "undefined" && !config.transportInstance) {
      return new Crumbtrail(
        config,
        new EventBus(),
        INERT_TRANSPORT,
        new RingBuffer(config.ringBufferMs, config.ringBufferMaxEvents),
        config.sessionId ?? generateSessionId(),
      );
    }

    const sessionStore =
      config.sessionPersistence === "session"
        ? (config.sessionStore ?? createWebSessionStore())
        : undefined;
    const useSessionStore = Boolean(sessionStore);
    // Reuse a persisted session id across a hard page reload (same tab, within the idle window)
    // so a reload appends to the same session instead of spawning a new one. Explicit sessionId
    // always wins; SSR / non-browser falls through to a fresh id.
    const sessionId =
      config.sessionId ??
      (sessionStore
        ? readPersistedSessionId(sessionStore, config.sessionIdleMs)
        : undefined) ??
      generateSessionId();
    if (sessionStore) writePersistedSession(sessionStore, sessionId);
    const bus = new EventBus();
    const ringBuffer = new RingBuffer(
      config.ringBufferMs,
      config.ringBufferMaxEvents,
    );

    const transport: CrumbtrailTransport =
      config.transportInstance ??
      new HttpTransport(config.httpEndpoint, {
        authToken: config.httpAuthToken,
      });

    const instance = new Crumbtrail(
      config,
      bus,
      transport,
      ringBuffer,
      sessionId,
    );

    // Send events to transport. Flight recorder sessions deliberately keep pre-trigger events
    // local; capture gap records remain visible so sampling never fails silently.
    bus.subscribe((events) => {
      const persistable = events.filter((event) =>
        instance.shouldPersistEvent(event),
      );
      if (persistable.length > 0)
        transport.sendEvents(persistable).catch(() => {});
    });

    // Feed events into ring buffer
    bus.subscribe((events) => {
      ringBuffer.pushBatch(events);
    });

    // Refresh the persisted session's lastActivity as events flow, so an active session keeps
    // its rolling idle window alive across reloads.
    if (useSessionStore && sessionStore) {
      bus.subscribe(() => {
        writePersistedSession(sessionStore, sessionId);
      });
    }

    bus.start(config.flushIntervalMs, config.flushBufferSize);

    bus.setAdmissionPredicate((event) => instance.shouldAdmitEvent(event));

    // Severity flush: error-class events must not wait out the batch interval —
    // an error captured in the final seconds before tab close would otherwise
    // be lost. Taps run BEFORE the event is buffered (EventBus.emit), so the
    // flush is deferred a microtask to guarantee the triggering event is part
    // of the shipped batch. Rate-limited (SEVERITY_FLUSH_MIN_INTERVAL_MS) so a
    // storm collapses into one early flush and stragglers ride the next
    // interval flush. `bug.flag` is excluded: flagBug() already flushes.
    let lastSeverityFlushAt = Number.NEGATIVE_INFINITY;
    let severityFlushPending = false;
    instance.cleanups.push(
      bus.tap((event) => {
        if (severityFlushPending) return;
        if (!isSevereEvent(event)) return;
        if (now() - lastSeverityFlushAt < SEVERITY_FLUSH_MIN_INTERVAL_MS)
          return;
        lastSeverityFlushAt = now();
        severityFlushPending = true;
        queueMicrotask(() => {
          severityFlushPending = false;
          bus.flush();
        });
      }),
    );

    // Last-chance flush on page teardown. `pagehide` is the most reliable
    // end-of-life signal across browsers (tab close, navigation, bfcache
    // entry); the transport's keepalive/sendBeacon path then gives the batch a
    // real chance to leave the page. Guarded because a caller-supplied
    // `transportInstance` lets init() run without a window (SSR/programmatic).
    if (typeof window !== "undefined") {
      const flushOnPageHide = () => bus.flush();
      window.addEventListener("pagehide", flushOnPageHide);
      instance.cleanups.push(() =>
        window.removeEventListener("pagehide", flushOnPageHide),
      );
    }

    const collectorContext: CollectorContext = {
      sessionId,
      getDeclaredEnv: () => ({
        flags: instance.declaredFlags,
        config: instance.declaredConfig,
      }),
      onEnvEmitted: () => {
        instance.envEmitted = true;
      },
      registerStateProvider: (name, provider) =>
        instance.registerStateProvider(name, provider),
    };

    instance.configureAutoFlagController();
    instance.startSessionIfAllowed();
    instance.emitSamplingGapIfNeeded();

    for (const [key, collector] of Object.entries(COLLECTOR_MAP)) {
      if (config[key as keyof CrumbtrailConfig]) {
        instance.cleanups.push(collector(bus, config, collectorContext));
      }
    }

    // Mount widget if enabled
    if (config.widget && typeof document !== "undefined") {
      import("./widget/bug-widget")
        .then(({ mountWidget }) => {
          instance.widgetCleanup = mountWidget(instance);
        })
        .catch(() => {});
    }

    if (config.configEndpoint && config.projectKey) {
      instance.startConfigPolling({
        endpoint: config.configEndpoint,
        projectKey: config.projectKey,
        intervalMs: config.configPollIntervalMs,
      });
    }

    return instance;
  }

  async flagBug(options?: FlagBugOptions): Promise<{ bugId: string }> {
    return this.flagBugFromSource(options, true);
  }

  private async flagBugFromSource(
    options: FlagBugOptions | undefined,
    isExplicitBeacon: boolean,
  ): Promise<{ bugId: string }> {
    if (isExplicitBeacon && !this.config.explicitBeacon)
      return { bugId: this.createBugId() };
    if (!this.canCapture()) return { bugId: this.createBugId() };

    if (this.config.flightRecorder) {
      if (this.flightRecorderFinalization)
        return this.flightRecorderFinalization;
      this.updateFlightRecorderState();
      if (this.flightRecorderState === "buffering")
        return this.triggerFlightRecorder(options);
      if (
        this.flightRecorderState === "finalizing" ||
        this.flightRecorderState === "finalized"
      )
        return { bugId: this.createBugId() };
    }

    return this.finalizeFlagBug(options);
  }

  /** Alias for production beacons and support integrations. */
  async flag(options?: FlagBugOptions): Promise<{ bugId: string }> {
    return this.flagBug(options);
  }

  private async finalizeFlagBug(
    options?: FlagBugOptions,
    finalizerOriginated = false,
  ): Promise<{ bugId: string }> {
    const bugId = this.createBugId();
    const windowMs = options?.windowMs ?? this.config.ringBufferMs;
    const flaggedAt = now();
    const note =
      options?.note === undefined ? undefined : maskText(options.note);

    // Capture provider state snapshots at flag time so they land in the same window.
    const stateProviderNames = Array.from(this.stateProviders.keys());
    for (const [name, provider] of this.stateProviders) {
      try {
        const rawValue = provider();
        const state = this.config.captureRawState
          ? { value: rawValue, metadata: undefined }
          : redactValue(rawValue, `state.${name}`);
        const value = state.value;
        const json = JSON.stringify(value);
        const truncated =
          json.length > this.config.stateMaxBytes
            ? `${json.slice(0, this.config.stateMaxBytes)}...`
            : json;
        const d: Record<string, unknown> = {
          name,
          json: truncated,
          truncated: truncated !== json,
        };
        if (!this.config.captureRawState)
          attachRedactionMetadata(d, state.metadata);
        this.bus.emit(
          {
            t: flaggedAt,
            k: "state.snap",
            d,
          },
          { bypassAdmission: finalizerOriginated },
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const redactedMsg = this.config.captureRawState
          ? { body: msg, metadata: undefined }
          : redactNetworkTextBody(msg, {
              contentType: "text/plain",
              path: "msg",
            });
        const d: Record<string, unknown> = {
          name,
          msg: redactedMsg.body ?? bodyPlaceholder(redactedMsg.bodySummary),
          ...(redactedMsg.bodySummary
            ? { msgSummary: redactedMsg.bodySummary }
            : {}),
        };
        if (!this.config.captureRawState)
          attachRedactionMetadata(d, redactedMsg.metadata);
        this.bus.emit(
          {
            t: flaggedAt,
            k: "state.err",
            d,
          },
          { bypassAdmission: finalizerOriginated },
        );
      }
    }

    // One-shot DOM snapshot: the exact UI at flag time, which the event stream can't reconstruct.
    if (this.config.domSnapshot && typeof document !== "undefined") {
      try {
        const fullHtml = buildMaskedDomSnapshot(
          document.documentElement,
          this.config,
        );
        // Truncate before redacting: redactNetworkTextBody's maxLength summarizes the whole
        // body away, but a clipped DOM is still useful evidence.
        const clipped = fullHtml.slice(0, this.config.domSnapshotMaxBytes);
        const redacted = this.config.captureRawState
          ? { body: clipped, metadata: undefined }
          : redactNetworkTextBody(clipped, {
              contentType: "text/html",
              path: "dom",
            });
        const d: Record<string, unknown> = {
          html: redacted.body ?? clipped,
          truncated: clipped.length !== fullHtml.length,
          bytes: fullHtml.length,
        };
        if (!this.config.captureRawState)
          attachRedactionMetadata(d, redacted.metadata);
        this.bus.emit(
          { t: flaggedAt, k: "dom.snap", d },
          { bypassAdmission: finalizerOriginated },
        );
      } catch {
        // DOM serialization must never block the report.
      }
    }

    // Emit marker into the live stream and include it in snapshot.
    this.bus.emit(
      {
        t: flaggedAt,
        k: "bug.flag",
        d: { bugId, note },
      },
      { bypassAdmission: finalizerOriginated },
    );

    // Flush pending events into ring buffer before snapshot
    this.bus.flush();

    const events = this.ringBuffer.snapshot(windowMs);

    // Compute summary stats from snapshot
    const errorCount = events.filter(
      (e) => e.k === "err" || e.k === "rej",
    ).length;
    const failedRequestCount = events.filter((e) =>
      isFailedNetworkResponse(e),
    ).length;
    const eventKinds: Record<string, number> = {};
    for (const e of events) {
      eventKinds[e.k] = (eventKinds[e.k] || 0) + 1;
    }
    const durationMs =
      events.length >= 2 ? events[events.length - 1].t - events[0].t : 0;

    const report: BugReport = {
      bugId,
      sessionId: this.sessionId,
      flaggedAt,
      windowMs,
      note,
      voiceNote: options?.voiceBlob ? "voice.webm" : undefined,
      url: currentPageUrl(),
      userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
      ...this.identity,
      tags: options?.tags,
      summary: {
        errorCount,
        failedRequestCount,
        eventCount: events.length,
        eventKinds,
        durationMs,
        stateProviderCount: stateProviderNames.length,
      },
    };

    // Send to server
    await this.transport.sendBugReport(report, events, options?.voiceBlob);

    return { bugId };
  }

  consent(granted: boolean): void {
    this.explicitConsent = granted;
    this.consentGranted = granted;
    if (!granted) {
      this.bus.clear();
      this.ringBuffer.clear();
      this.abortFlightRecorder();
      this.updateFlightRecorderState();
      return;
    }
    this.updateFlightRecorderState();
    this.startSessionIfAllowed();
    this.emitSamplingGapIfNeeded();
  }

  identify(identity: CrumbtrailIdentity): void {
    const accountId = pseudonymousId(identity.accountId);
    const userId = pseudonymousId(identity.userId);
    let changed = false;
    if (accountId && this.identity.accountId !== accountId) {
      this.identity.accountId = accountId;
      changed = true;
    }
    if (userId && this.identity.userId !== userId) {
      this.identity.userId = userId;
      changed = true;
    }
    if (changed && this.sessionStarted) this.refreshSessionIdentity();
  }

  startConfigPolling(options: CaptureConfigPollingOptions): () => void {
    this.stopConfigPolling();
    this.remotePolicyReady = false;
    this.updateFlightRecorderState();
    const intervalMs = normalizeInterval(options.intervalMs);
    let stopped = false;

    const poll = async () => {
      if (stopped || typeof fetch !== "function") return;
      const generation = ++this.configPollGeneration;
      try {
        const response = await fetch(configPollingUrl(options), {
          method: "GET",
        });
        if (!response.ok && response.status >= 400) return;
        const payload: unknown = await response.json();
        if (stopped || generation !== this.configPollGeneration) return;
        if (this.applyRemoteConfig(payload)) this.remotePolicyReady = true;
        this.updateFlightRecorderState();
        this.startSessionIfAllowed();
        this.emitSamplingGapIfNeeded();
      } catch {
        // Retain the last known policy when the config service is unavailable.
      }
    };

    void poll();
    const timer = setInterval(() => void poll(), intervalMs);
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      if (this.configPollingCleanup === stop)
        this.configPollingCleanup = undefined;
    };
    this.configPollingCleanup = stop;
    return stop;
  }

  private stopConfigPolling(): void {
    this.configPollGeneration += 1;
    this.configPollingCleanup?.();
    this.configPollingCleanup = undefined;
  }

  private applyRemoteConfig(payload: unknown): boolean {
    const settings = readRemotePolicySettings(payload);
    if (!settings) return false;
    const oldSampleRate = this.config.captureSampleRate;
    const oldBaselineSampleRate = this.config.baselineSampleRate;
    let shouldReconfigureAutoFlag = false;

    for (const key of REMOTE_CONFIG_KEYS) {
      const value = settings[key];
      if (!isRemoteConfigValue(key, value)) continue;
      if (this.config[key] !== value) {
        Object.assign(this.config, { [key]: value });
        shouldReconfigureAutoFlag ||= isTriggerConfigKey(key);
      }
    }

    applyRemoteMaskingMode(this.config, settings);
    shouldReconfigureAutoFlag ||= applyRemoteTriggerSwitches(
      this.config,
      settings,
    );
    applyRemoteSampling(this.config, settings);
    applyRemoteTailDuration(this.config, settings);
    applyRemoteConsentMode(this.config, settings);

    if (typeof settings.killSwitch === "boolean") {
      const changed = this.killSwitch !== settings.killSwitch;
      this.killSwitch = settings.killSwitch;
      if (changed && this.killSwitch) {
        this.bus.clear();
        this.ringBuffer.clear();
        this.abortFlightRecorder();
      }
    }

    if (
      oldSampleRate !== this.config.captureSampleRate ||
      oldBaselineSampleRate !== this.config.baselineSampleRate
    )
      this.resampleSession();
    this.applyConsentPolicy();
    this.updateFlightRecorderState();
    if (shouldReconfigureAutoFlag) this.configureAutoFlagController();
    this.startSessionIfAllowed();
    this.emitSamplingGapIfNeeded();
    if (
      hasRemoteCaptureTrigger(settings) &&
      this.config.flightRecorder &&
      this.canCapture()
    )
      void this.flag({ tags: ["config:trigger"] });
    return true;
  }

  private resampleSession(): void {
    const wasShed = this.samplingShed;
    this.samplingShed = !isSampled(this.config.captureSampleRate);
    this.baselineSampled =
      !this.samplingShed && isSampled(this.config.baselineSampleRate);
    if (!wasShed && this.samplingShed) {
      this.bus.clear();
      this.ringBuffer.clear();
      this.emitSamplingGapIfNeeded();
    }
  }

  private configureAutoFlagController(): void {
    this.autoFlagCleanup?.();
    this.autoFlagCleanup = undefined;

    const autoFlagDetectors: SignalDetector[] = [];
    if (this.config.autoFlagOnError || this.config.flightRecorder)
      autoFlagDetectors.push(
        errorDetector({
          uncaughtError: this.config.autoFlagOnUncaughtError,
          unhandledRejection: this.config.autoFlagOnUnhandledRejection,
        }),
      );
    if (this.config.autoFlagOnRequest5xx)
      autoFlagDetectors.push(request5xxDetector());
    if (this.config.autoFlagOnSignals || this.config.flightRecorder) {
      if (this.config.autoFlagOnRageClick)
        autoFlagDetectors.push(
          rageClickDetector({
            threshold: this.config.rageClickThreshold,
            windowMs: this.config.rageClickWindowMs,
          }),
        );
      if (this.config.autoFlagOnRetryStorm)
        autoFlagDetectors.push(
          retryStormDetector({
            threshold: this.config.retryStormThreshold,
            windowMs: this.config.retryStormWindowMs,
            failThreshold: this.config.flightRecorder
              ? 1
              : this.config.retryStormFailThreshold,
          }),
        );
      if (this.config.autoFlagOnSlowResponse)
        autoFlagDetectors.push(
          slowResponseDetector({
            thresholdMs: this.config.slowRequestMs,
            count: this.config.slowRequestCount,
            windowMs: this.config.slowRequestWindowMs,
          }),
        );
      if (this.config.autoFlagOnAbandonedFlow)
        autoFlagDetectors.push(
          abandonedFlowDetector({
            windowMs: this.config.abandonedFlowWindowMs,
            minInputs: this.config.abandonedFlowMinInputs,
          }),
        );
    }
    if (autoFlagDetectors.length === 0) return;

    const autoFlag = createAutoFlagController({
      debounceMs: this.config.autoFlagDebounceMs,
      maxPerSession: this.config.autoFlagMaxPerSession,
      flag: (options) => this.flagBugFromSource(options, false),
      detectors: autoFlagDetectors,
    });
    const detach = this.bus.tap((event) => autoFlag.handleEvent(event));
    this.autoFlagCleanup = () => {
      detach();
      autoFlag.dispose();
    };
  }

  private triggerFlightRecorder(
    options?: FlagBugOptions,
  ): Promise<{ bugId: string }> {
    this.flightRecorderState = "triggered";
    this.startSessionIfAllowed();
    // Move every pre-trigger event from the bus batch into the flight recorder before tailing.
    this.bus.flush();
    const tailMs = Math.max(0, this.config.flightRecorderTailMs);
    if (tailMs === 0) {
      return this.trackFlightRecorderFinalization(
        this.finalizeFlightRecorder(options),
      );
    }

    this.flightRecorderState = "tailing";
    return this.trackFlightRecorderFinalization(
      new Promise((resolve, reject) => {
        this.flightRecorderTailResolver = resolve;
        this.flightRecorderTimer = setTimeout(() => {
          this.flightRecorderTimer = undefined;
          this.flightRecorderTailResolver = undefined;
          if (!this.canCapture()) {
            resolve({ bugId: this.createBugId() });
            return;
          }
          this.finalizeFlightRecorder(options).then(resolve, reject);
        }, tailMs);
      }),
    );
  }

  private async finalizeFlightRecorder(
    options?: FlagBugOptions,
  ): Promise<{ bugId: string }> {
    this.flightRecorderState = "finalizing";
    return this.finalizeFlagBug(options, true);
  }

  private trackFlightRecorderFinalization(
    finalization: Promise<{ bugId: string }>,
  ): Promise<{ bugId: string }> {
    this.flightRecorderFinalization = finalization;
    const complete = () => {
      this.flightRecorderTimer = undefined;
      this.flightRecorderTailResolver = undefined;
      this.flightRecorderFinalization = undefined;
      this.flightRecorderState = "finalized";
      this.ringBuffer.clear();
    };
    void finalization.then(complete, complete);
    return finalization;
  }

  private abortFlightRecorder(): void {
    if (this.flightRecorderTimer) clearTimeout(this.flightRecorderTimer);
    this.flightRecorderTimer = undefined;
    const settle = this.flightRecorderTailResolver;
    this.flightRecorderTailResolver = undefined;
    if (settle) settle({ bugId: this.createBugId() });
    if (!this.flightRecorderFinalization) this.updateFlightRecorderState();
  }

  private updateFlightRecorderState(): void {
    if (!this.config.flightRecorder) {
      this.flightRecorderState = "armed";
      return;
    }
    if (
      this.flightRecorderState === "triggered" ||
      this.flightRecorderState === "tailing" ||
      this.flightRecorderState === "finalizing" ||
      this.flightRecorderState === "finalized"
    )
      return;
    this.flightRecorderState = this.canCapture() ? "buffering" : "armed";
  }

  private applyConsentPolicy(): void {
    const nextConsent =
      this.explicitConsent ??
      (this.config.consentMode === "implicit" &&
        !(this.config.respectGpc && hasGlobalPrivacyControl()));
    if (nextConsent === this.consentGranted) return;
    this.consentGranted = nextConsent;
    if (!nextConsent) {
      this.bus.clear();
      this.ringBuffer.clear();
      this.abortFlightRecorder();
    }
  }

  private startSessionWithCurrentIdentity(): void {
    this.sessionMetadataWrite = this.sendSessionMetadata();
  }

  private refreshSessionIdentity(): void {
    this.sessionMetadataWrite = this.sessionMetadataWrite.then(() =>
      this.sendSessionMetadata(),
    );
  }

  private sendSessionMetadata(): Promise<void> {
    try {
      return this.transport
        .startSession(this.sessionId, {
          url: currentPageUrl(),
          ua: typeof navigator !== "undefined" ? navigator.userAgent : "",
          ...this.identity,
        })
        .catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  private shouldAdmitEvent(event: BugEvent): boolean {
    if (!this.canTransport()) return false;
    if (this.isFlightRecorderTerminal()) return false;
    if (!this.samplingShed) return true;
    return event.k === CAPTURE_GAP_EVENT_KIND;
  }

  private shouldPersistEvent(event: BugEvent): boolean {
    if (!this.canTransport()) return false;
    if (this.isFlightRecorderTerminal()) return false;
    if (event.k === CAPTURE_GAP_EVENT_KIND) return true;
    return (
      !this.samplingShed &&
      (!this.config.flightRecorder ||
        this.flightRecorderState === "triggered" ||
        this.flightRecorderState === "tailing" ||
        this.baselineSampled)
    );
  }

  private canCapture(): boolean {
    return this.canTransport() && !this.samplingShed;
  }

  private isFlightRecorderTerminal(): boolean {
    return (
      this.config.flightRecorder &&
      (this.flightRecorderState === "finalizing" ||
        this.flightRecorderState === "finalized")
    );
  }

  private canTransport(): boolean {
    return (
      !this.stopped &&
      this.remotePolicyReady &&
      this.consentGranted &&
      !this.killSwitch
    );
  }

  private startSessionIfAllowed(): void {
    if (this.sessionStarted || !this.canTransport()) return;
    if (
      this.config.flightRecorder &&
      this.flightRecorderState !== "triggered" &&
      this.flightRecorderState !== "tailing" &&
      !this.baselineSampled &&
      !this.samplingShed
    )
      return;
    this.sessionStarted = true;
    this.startSessionWithCurrentIdentity();
  }

  private emitSamplingGapIfNeeded(): void {
    if (!this.samplingShed || this.samplingGapEmitted || !this.canTransport())
      return;
    this.samplingGapEmitted = true;
    this.bus.emit(
      buildCaptureGapEvent({
        surface: "browser",
        reason: "sampled_out",
        sessionId: this.sessionId,
      }),
    );
    this.bus.flush();
  }

  private createBugId(): string {
    return `bug_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  mark(label: string): void {
    this.bus.emit({ t: now(), k: "mark", d: { label } });
  }

  addEvent(partial: AddBugEventOptions): void {
    const { type, data, ...envelope } = partial;
    this.bus.emit({
      t: now(),
      k: type,
      d: redactDatabaseEventValues(type, data),
      ...envelope,
    });
  }

  getSessionId(): string {
    return this.sessionId;
  }

  createRequestHeaders(requestId?: string): Record<string, string> {
    return createCrumbtrailRequestHeaders(this.sessionId, requestId);
  }

  pause(): void {
    this.bus.pause();
  }

  resume(): void {
    this.bus.resume();
  }

  registerStateProvider(name: string, provider: () => unknown): () => void {
    this.stateProviders.set(name, provider);
    return () => {
      this.stateProviders.delete(name);
    };
  }

  /**
   * Declaratively attach vendor-agnostic feature flags / config to the session environment.
   * Values are redacted before they rest. Merges into the declared env; if the initial
   * `k:'env'` snapshot has already been emitted (the normal case, since `setEnv` is called
   * after `init`), it emits a `k:'env'` delta event ({ kind:'delta' }). If called before the
   * snapshot is emitted (e.g. environment collector disabled or not yet run), the values are
   * folded into the snapshot instead.
   */
  setEnv(declaration: EnvDeclaration): void {
    if (declaration.flags) Object.assign(this.declaredFlags, declaration.flags);
    if (declaration.config)
      Object.assign(this.declaredConfig, declaration.config);

    if (!this.envEmitted) return;

    const delta = buildEnvDelta(declaration.flags, declaration.config);
    this.bus.emit({
      t: now(),
      k: "env",
      d: delta as unknown as Record<string, unknown>,
    });
  }

  async stop(): Promise<{ sessionId: string }> {
    this.stopped = true;
    if (this.widgetCleanup) this.widgetCleanup();
    this.autoFlagCleanup?.();
    this.stopConfigPolling();
    this.abortFlightRecorder();
    for (const cleanup of this.cleanups) {
      cleanup();
    }
    this.stateProviders.clear();
    this.bus.stop();
    this.ringBuffer.clear();
    if (this.sessionStarted) await this.transport.endSession(this.sessionId);
    return { sessionId: this.sessionId };
  }
}

/**
 * Error-class events that justify flushing ahead of the batch interval:
 * uncaught errors, unhandled promise rejections, and failed network
 * responses (HTTP >= 400 or an application-failure body).
 */
function isSevereEvent(event: BugEvent): boolean {
  return (
    event.k === "err" || event.k === "rej" || isFailedNetworkResponse(event)
  );
}

function isFailedNetworkResponse(event: BugEvent): boolean {
  return (
    event.k === "net.res" &&
    ((typeof event.d.st === "number" && event.d.st >= 400) ||
      hasApplicationFailure(event.d.body))
  );
}

function hasApplicationFailure(value: unknown): boolean {
  if (typeof value === "string") return hasApplicationFailureInText(value);

  if (Array.isArray(value))
    return value.some((item) => hasApplicationFailure(item));

  if (!isRecord(value) || value.dedup === true) return false;
  if (value.ok === false || value.status === "failed") return true;

  return Object.values(value).some((nested) => hasApplicationFailure(nested));
}

function hasApplicationFailureInText(text: string): boolean {
  for (const candidate of extractJsonCandidates(text)) {
    try {
      if (hasApplicationFailure(JSON.parse(candidate))) return true;
    } catch {
      // Framework response streams can include non-JSON chunks around JSON records.
    }
  }
  return false;
}

function extractJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates = new Set<string>();
  if (trimmed.startsWith("{") || trimmed.startsWith("["))
    candidates.add(trimmed);

  for (const line of trimmed.split(/\r?\n/)) {
    const chunk = line.trim();
    if (!chunk) continue;
    const framed = chunk.match(/^\d+:(.*)$/);
    const unframed = (framed?.[1] ?? chunk).trim();
    if (unframed.startsWith("{") || unframed.startsWith("["))
      candidates.add(unframed);
    const objectStart = unframed.indexOf("{");
    if (objectStart >= 0) candidates.add(unframed.slice(objectStart));
  }

  return [...candidates];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function hasGlobalPrivacyControl(): boolean {
  return Boolean(
    typeof navigator !== "undefined" &&
    (navigator as Navigator & { globalPrivacyControl?: boolean })
      .globalPrivacyControl,
  );
}

function isSampled(rate: number): boolean {
  if (!Number.isFinite(rate) || rate <= 0) return false;
  if (rate >= 1) return true;
  return Math.random() < rate;
}

function normalizeInterval(intervalMs: number | undefined): number {
  if (!Number.isFinite(intervalMs) || (intervalMs ?? 0) <= 0)
    return DEFAULT_CONFIG_POLL_INTERVAL_MS;
  return Math.max(1_000, Math.round(intervalMs as number));
}

function configPollingUrl(options: CaptureConfigPollingOptions): string {
  const base =
    typeof location !== "undefined" ? location.href : "http://localhost/";
  try {
    const url = new URL(options.endpoint, base);
    url.searchParams.set("projectKey", options.projectKey);
    return url.toString();
  } catch {
    return options.endpoint;
  }
}

function currentPageUrl(): string {
  return typeof location !== "undefined" ? redactUrl(location.href).value : "";
}

function pseudonymousId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized || EMAIL_SHAPED_VALUE.test(normalized)) return undefined;
  return normalized;
}

/**
 * Accept the deployed response envelope as well as the direct policy shape used by self-hosted
 * config endpoints. Only recognized policy fields are applied below.
 */
function readRemotePolicySettings(
  payload: unknown,
): Record<string, unknown> | undefined {
  const root = asRecord(payload);
  if (!root) return undefined;
  const project = asRecord(root.project);
  const captureConfig =
    asRecord(root.captureConfig) ??
    asRecord(root.capture_config) ??
    asRecord(project?.captureConfig) ??
    asRecord(project?.capture_config);
  const policy =
    asRecord(root.policy) ??
    asRecord(project?.policy) ??
    asRecord(project?.capturePolicy) ??
    asRecord(captureConfig?.policy);
  const settings =
    asRecord(root.settings) ??
    asRecord(project?.settings) ??
    asRecord(project?.captureSettings) ??
    asRecord(root.captureSettings) ??
    asRecord(captureConfig?.settings) ??
    captureConfig;
  const merged = {
    ...root,
    ...project,
    ...captureConfig,
    ...policy,
    ...settings,
  };
  return hasRecognizedRemotePolicy(merged) ? merged : undefined;
}

function applyRemoteConsentMode(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
): void {
  const consent = asRecord(settings.consent);
  const consentMode = consent?.mode ?? settings.consentMode;
  if (consentMode === "implicit" || consentMode === "required")
    config.consentMode = consentMode;
  if (typeof settings.respectGpc === "boolean")
    config.respectGpc = settings.respectGpc;
}

function applyRemoteMaskingMode(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
): void {
  const masking = asRecord(settings.masking) ?? asRecord(settings.privacy);
  const mode =
    readString(masking?.mode) ??
    readString(settings.maskingMode) ??
    (typeof settings.masking === "string" ? settings.masking : undefined);
  if (mode) {
    switch (mode.toLowerCase()) {
      case "all":
      case "full":
      case "mask_all":
      case "strict":
      case "masked":
        config.maskAllText = true;
        config.maskAllInputs = true;
        break;
      case "text":
      case "text_only":
        config.maskAllText = true;
        break;
      case "inputs":
      case "inputs_only":
        config.maskAllInputs = true;
        break;
      case "none":
      case "off":
      case "unmasked":
        // Remote policy may tighten masking only.
        break;
    }
  }
  if (masking?.maskAllText === true) config.maskAllText = true;
  if (masking?.maskAllInputs === true) config.maskAllInputs = true;
}

function applyRemoteSampling(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
): void {
  const sampling = asRecord(settings.sampling);
  const captureRate =
    readRate(sampling?.captureSampleRate) ??
    readRate(sampling?.captureRate) ??
    readRate(sampling?.rate) ??
    readRate(settings.captureSampleRate) ??
    readRate(settings.captureRate) ??
    readRate(settings.sampleRate);
  const baselineRate =
    readRate(sampling?.baselineSampleRate) ??
    readRate(sampling?.baselineRate) ??
    readRate(settings.baselineSampleRate) ??
    readRate(settings.baselineRate);
  if (captureRate !== undefined) config.captureSampleRate = captureRate;
  if (baselineRate !== undefined) config.baselineSampleRate = baselineRate;
}

function applyRemoteTailDuration(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
): void {
  const recorder = asRecord(settings.flightRecorder);
  const tail = asRecord(settings.tail);
  const triggers = asRecord(settings.triggers);
  const tailDuration =
    readSeconds(triggers?.tailSeconds) ??
    readDuration(settings.tailDurationMs) ??
    readDuration(settings.tailMs) ??
    readDuration(recorder?.tailDurationMs) ??
    readDuration(recorder?.tailMs) ??
    readDuration(tail?.durationMs) ??
    readDuration(tail?.ms);
  if (tailDuration !== undefined) config.flightRecorderTailMs = tailDuration;
}

function applyRemoteTriggerSwitches(
  config: CrumbtrailConfig,
  settings: Record<string, unknown>,
): boolean {
  const triggers = asRecord(settings.triggers);
  if (!triggers) return false;
  let changed = false;
  const assign = (key: keyof CrumbtrailConfig, value: unknown) => {
    if (typeof value !== "boolean" || config[key] === value) return;
    Object.assign(config, { [key]: value });
    changed = true;
  };

  const error = triggerSwitch(
    triggers.error ?? triggers.errors ?? triggers.onError,
  );
  const uncaughtError = triggerSwitch(triggers.uncaughtError);
  const unhandledRejection = triggerSwitch(triggers.unhandledRejection);
  const request5xx = triggerSwitch(triggers.request5xx);
  const explicitBeacon = triggerSwitch(triggers.explicitBeacon);
  const serverSidePull = triggerSwitch(triggers.serverSidePull);
  const maskAll = triggerSwitch(triggers.mask_all);
  if (uncaughtError !== undefined || unhandledRejection !== undefined) {
    assign("autoFlagOnUncaughtError", uncaughtError ?? false);
    assign("autoFlagOnUnhandledRejection", unhandledRejection ?? false);
    assign(
      "autoFlagOnError",
      uncaughtError === true || unhandledRejection === true,
    );
  }
  assign("autoFlagOnRequest5xx", request5xx);
  assign("explicitBeacon", explicitBeacon);
  assign("serverSidePull", serverSidePull);
  if (maskAll === true) {
    config.maskAllText = true;
    config.maskAllInputs = true;
  }
  const signals = triggerSwitch(triggers.signals ?? triggers.onSignals);
  const rageClick = triggerSwitch(
    triggers.rageClick ?? triggers.rageClicks ?? triggers.onRageClick,
  );
  const retryStorm = triggerSwitch(
    triggers.retryStorm ?? triggers.retryStorms ?? triggers.onRetryStorm,
  );
  const slowResponse = triggerSwitch(
    triggers.slowResponse ?? triggers.slowResponses ?? triggers.onSlowResponse,
  );
  const abandonedFlow = triggerSwitch(
    triggers.abandonedFlow ??
      triggers.abandonedFlows ??
      triggers.onAbandonedFlow,
  );
  assign("autoFlagOnError", error);
  assign("autoFlagOnSignals", signals);
  assign("autoFlagOnRageClick", rageClick);
  assign("autoFlagOnRetryStorm", retryStorm);
  assign("autoFlagOnSlowResponse", slowResponse);
  assign("autoFlagOnAbandonedFlow", abandonedFlow);

  const behavioralSwitches = [
    rageClick,
    retryStorm,
    slowResponse,
    abandonedFlow,
  ];
  if (
    signals === undefined &&
    behavioralSwitches.some((value) => value !== undefined)
  )
    assign(
      "autoFlagOnSignals",
      behavioralSwitches.some((value) => value === true),
    );
  return changed;
}

function hasRemoteCaptureTrigger(settings: Record<string, unknown>): boolean {
  const triggers = asRecord(settings.triggers);
  return (
    settings.trigger === true ||
    settings.triggerCapture === true ||
    triggers?.trigger === true ||
    triggers?.capture === true
  );
}

function readRate(value: unknown): number | undefined {
  return typeof value === "number" && value >= 0 && value <= 1
    ? value
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function readDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function readSeconds(value: unknown): number | undefined {
  const seconds = readDuration(value);
  return seconds === undefined ? undefined : seconds * 1_000;
}

function triggerSwitch(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  const nested = asRecord(value);
  return typeof nested?.enabled === "boolean" ? nested.enabled : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRemoteConfigValue(
  key: (typeof REMOTE_CONFIG_KEYS)[number],
  value: unknown,
): value is boolean | number {
  if (
    key === "flightRecorder" ||
    key === "autoFlagOnError" ||
    key === "autoFlagOnUncaughtError" ||
    key === "autoFlagOnUnhandledRejection" ||
    key === "autoFlagOnRequest5xx" ||
    key === "explicitBeacon" ||
    key === "serverSidePull" ||
    key === "autoFlagOnSignals" ||
    key === "autoFlagOnRageClick" ||
    key === "autoFlagOnRetryStorm" ||
    key === "autoFlagOnSlowResponse" ||
    key === "autoFlagOnAbandonedFlow"
  )
    return typeof value === "boolean";
  if (key === "captureSampleRate" || key === "baselineSampleRate")
    return typeof value === "number" && value >= 0 && value <= 1;
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isTriggerConfigKey(key: (typeof REMOTE_CONFIG_KEYS)[number]): boolean {
  return (
    key === "flightRecorder" ||
    key === "autoFlagOnError" ||
    key === "autoFlagOnSignals" ||
    key === "autoFlagOnRageClick" ||
    key === "autoFlagOnRetryStorm" ||
    key === "autoFlagOnSlowResponse" ||
    key === "autoFlagOnAbandonedFlow" ||
    key === "autoFlagDebounceMs" ||
    key === "autoFlagMaxPerSession" ||
    key === "rageClickThreshold" ||
    key === "rageClickWindowMs" ||
    key === "retryStormThreshold" ||
    key === "retryStormWindowMs" ||
    key === "retryStormFailThreshold" ||
    key === "slowRequestMs" ||
    key === "slowRequestCount" ||
    key === "slowRequestWindowMs" ||
    key === "abandonedFlowWindowMs" ||
    key === "abandonedFlowMinInputs"
  );
}

function hasRecognizedRemotePolicy(settings: Record<string, unknown>): boolean {
  if (typeof settings.killSwitch === "boolean") return true;
  if (settings.consentMode === "implicit" || settings.consentMode === "required")
    return true;
  if (typeof settings.respectGpc === "boolean") return true;
  if (hasRecognizedRemoteMasking(settings)) return true;
  if (hasRecognizedRemoteSampling(settings)) return true;
  return hasRecognizedRemoteTriggers(settings);
}

function hasRecognizedRemoteMasking(settings: Record<string, unknown>): boolean {
  const masking = asRecord(settings.masking) ?? asRecord(settings.privacy);
  const mode =
    readString(masking?.mode) ??
    readString(settings.maskingMode) ??
    (typeof settings.masking === "string" ? settings.masking : undefined);
  return (
    (mode !== undefined &&
      [
        "all",
        "full",
        "mask_all",
        "strict",
        "masked",
        "text",
        "text_only",
        "inputs",
        "inputs_only",
      ].includes(mode.toLowerCase())) ||
    masking?.maskAllText === true ||
    masking?.maskAllInputs === true
  );
}

function hasRecognizedRemoteSampling(settings: Record<string, unknown>): boolean {
  const sampling = asRecord(settings.sampling);
  return [
    sampling?.captureSampleRate,
    sampling?.captureRate,
    sampling?.rate,
    sampling?.baselineSampleRate,
    sampling?.baselineRate,
    settings.captureSampleRate,
    settings.captureRate,
    settings.sampleRate,
    settings.baselineSampleRate,
    settings.baselineRate,
  ].some((value) => readRate(value) !== undefined);
}

function hasRecognizedRemoteTriggers(settings: Record<string, unknown>): boolean {
  const triggers = asRecord(settings.triggers);
  if (!triggers) return false;
  return [
    triggers.tailSeconds,
    triggers.uncaughtError,
    triggers.unhandledRejection,
    triggers.request5xx,
    triggers.explicitBeacon,
    triggers.serverSidePull,
    triggers.mask_all,
    triggers.error,
    triggers.errors,
    triggers.onError,
    triggers.signals,
    triggers.onSignals,
    triggers.rageClick,
    triggers.rageClicks,
    triggers.onRageClick,
    triggers.retryStorm,
    triggers.retryStorms,
    triggers.onRetryStorm,
    triggers.slowResponse,
    triggers.slowResponses,
    triggers.onSlowResponse,
    triggers.abandonedFlow,
    triggers.abandonedFlows,
    triggers.onAbandonedFlow,
  ].some(
    (value) => triggerSwitch(value) !== undefined || readDuration(value) !== undefined,
  );
}

function redactDatabaseEventValues(
  type: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (
    type !== "db.diff" &&
    type !== "db.read" &&
    type !== "db.diff.bulk" &&
    type !== "db.read.bulk"
  )
    return data;
  const output = { ...data };
  for (const key of [
    "pk",
    "after",
    "before",
    "row",
    "samplePks",
    "sampleValues",
    "values",
  ]) {
    if (key in output) output[key] = maskDatabaseValue(output[key]);
  }
  return output;
}

function maskDatabaseValue(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value === "string") return maskText(value);
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  )
    return REDACTED_VALUE;
  if (Array.isArray(value)) return value.map(maskDatabaseValue);
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        maskDatabaseValue(entry),
      ]),
    );
  return REDACTED_VALUE;
}
