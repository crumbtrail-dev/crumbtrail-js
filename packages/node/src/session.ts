import fs from "node:fs";
import path from "node:path";
import {
  defaultSessionStore,
  assertWritableSessionArtifactPath,
  safeRegularFilePath,
} from "./session-store";
import { postProcess as defaultPostProcess } from "./post-process";
import type { PostProcessAudioSummary } from "./post-process";
import {
  buildSessionSummary,
  type SessionSummary,
  type SessionFileFlags,
  type Severity,
} from "./session-summary";

export interface SessionManagerConfig {
  outputDir: string;
  whisperModel?: string;
  postProcess?: (sessionDir: string, whisperModel?: string) => Promise<void>;
}

export interface SessionListItem {
  id: string;
  release?: string;
  build?: string;
  start: number;
  end?: number;
}

export interface SessionFinalizationResult {
  ok: true;
  sessionId: string;
  processed: boolean;
  degraded: boolean;
  finalizedAt: number;
  postProcess: {
    ok: boolean;
    error?: string;
    audio?: PostProcessAudioSummary;
    warnings?: Array<{
      capability: "audio" | "video";
      code: string;
      message: string;
    }>;
  };
}

const STAGING_SESSION_DIR = ".sessions";
const PRIVATE_DIR_MODE = 0o700;

async function ensurePrivateDirectory(dir: string): Promise<void> {
  // mkdir 0700 (+ chmod) lives behind the storage seam so directory creation is a
  // single primitive the R2 adapter can reinterpret. Behaviour-identical to the prior
  // inline mkdirSync/chmodSync.
  await defaultSessionStore.createSessionDir(dir);
}

// The constructor cannot await, and the output ROOT is a container directory that
// never holds session artifact bytes (so no encrypt/decrypt seam applies to it).
// It is therefore created directly with the exact 0700 semantics
// FilesystemSessionStore.createSessionDir applies.
function ensureOutputRootSync(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  if (process.platform !== "win32") {
    fs.chmodSync(dir, PRIVATE_DIR_MODE);
  }
}

export class SessionManager {
  private outputDir: string;
  private whisperModel?: string;
  private postProcess: (
    sessionDir: string,
    whisperModel?: string,
  ) => Promise<void>;

  constructor(config: string | SessionManagerConfig) {
    if (typeof config === "string") {
      this.outputDir = config;
      this.postProcess = defaultPostProcess;
    } else {
      this.outputDir = config.outputDir;
      this.whisperModel = config.whisperModel;
      this.postProcess = config.postProcess ?? defaultPostProcess;
    }
    ensureOutputRootSync(this.outputDir);
  }

  async create(
    sessionId: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    this.validateSessionId(sessionId);
    const sessionDir = this.resolveStagingSessionDir(sessionId);
    const {
      id: _id,
      start: _start,
      end: _end,
      processed: _processed,
      finalization: _finalization,
      ...safeMetadata
    } = metadata;
    let start = Date.now();
    if (fs.existsSync(sessionDir)) {
      this.assertSafeSessionDir(sessionDir);
      let existing: Record<string, unknown> | undefined;
      try {
        const raw = await defaultSessionStore.readArtifact(
          sessionDir,
          "meta.json",
        );
        if (raw) {
          existing = JSON.parse(raw.toString("utf-8"));
          if (typeof existing?.start === "number") start = existing.start;
        }
      } catch {
        // Corrupt/partial meta -> fall back to a fresh start.
      }
      if (existing && !isSameSessionMetadata(existing, safeMetadata)) {
        throw new Error("Session already exists");
      }
    } else if (await this.findExistingSessionDir(sessionId)) {
      throw new Error("Session already exists");
    }
    await ensurePrivateDirectory(sessionDir);
    this.assertSafeSessionDir(sessionDir);
    await ensurePrivateDirectory(path.join(sessionDir, "frames"));
    const meta = { ...safeMetadata, id: sessionId, start };
    await this.writeSessionArtifact(
      sessionDir,
      "meta.json",
      JSON.stringify(meta, null, 2),
    );
  }

  async getSessionDir(sessionId: string): Promise<string> {
    this.validateSessionId(sessionId);
    const existing = await this.findExistingSessionDir(sessionId);
    if (existing) return existing;
    return this.resolveStagingSessionDir(sessionId);
  }

  async getExistingSessionDir(sessionId: string): Promise<string | undefined> {
    this.validateSessionId(sessionId);
    const stagedSessionDir = this.resolveStagingSessionDir(sessionId);
    if (this.isSessionDir(stagedSessionDir)) {
      this.assertSafeSessionDir(stagedSessionDir);
      return stagedSessionDir;
    }
    const flatSessionDir = this.resolveInsideOutput(sessionId);
    if (this.isSessionDir(flatSessionDir)) {
      this.assertSafeSessionDir(flatSessionDir);
      return flatSessionDir;
    }
    return this.findExistingSessionDir(sessionId);
  }

  private validateSessionId(sessionId: string): void {
    if (
      sessionId === "." ||
      sessionId === ".." ||
      sessionId === STAGING_SESSION_DIR ||
      !/[A-Za-z0-9]/.test(sessionId) ||
      !/^[A-Za-z0-9._-]+$/.test(sessionId)
    ) {
      throw new Error("Invalid sessionId");
    }
  }

  private resolveInsideOutput(relativePath: string): string {
    const outputRoot = path.resolve(this.outputDir);
    const resolved = path.resolve(outputRoot, relativePath);
    if (
      resolved !== outputRoot &&
      !resolved.startsWith(outputRoot + path.sep)
    ) {
      throw new Error("Invalid sessionId");
    }
    return resolved;
  }

  private resolveStagingSessionDir(sessionId: string): string {
    return this.resolveInsideOutput(path.join(STAGING_SESSION_DIR, sessionId));
  }

  private assertSafeSessionDir(sessionDir: string): void {
    const stat = fs.lstatSync(sessionDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Invalid sessionId");
    }

    let outputRoot: string;
    let realPath: string;
    try {
      outputRoot = fs.realpathSync(path.resolve(this.outputDir));
      realPath = fs.realpathSync(sessionDir);
    } catch {
      throw new Error("Invalid sessionId");
    }
    if (
      realPath !== outputRoot &&
      !realPath.startsWith(outputRoot + path.sep)
    ) {
      throw new Error("Invalid sessionId");
    }
    if (process.platform !== "win32") {
      fs.chmodSync(realPath, PRIVATE_DIR_MODE);
    }
  }

  private async findExistingSessionDir(
    sessionId: string,
  ): Promise<string | undefined> {
    const stagedSessionDir = this.resolveStagingSessionDir(sessionId);
    if (this.isSessionDir(stagedSessionDir)) {
      this.assertSafeSessionDir(stagedSessionDir);
      return stagedSessionDir;
    }

    const flatSessionDir = this.resolveInsideOutput(sessionId);
    if (this.isSessionDir(flatSessionDir)) {
      this.assertSafeSessionDir(flatSessionDir);
      return flatSessionDir;
    }

    let found: string | undefined;
    await this.eachSessionDir((id, sessionDir) => {
      if (found) return;
      if (id !== sessionId) return;
      found = sessionDir;
    });
    return found;
  }

  private async moveSessionToV2Partition(
    sessionDir: string,
    sessionId: string,
    meta: Record<string, unknown>,
  ): Promise<string> {
    const partition = buildSessionPartition(meta, sessionId);
    const segments = [
      partition.tenant,
      partition.app,
      partition.date,
      partition.sessionId,
    ];
    const targetDir = this.resolveInsideOutput(path.join(...segments));
    if (path.resolve(sessionDir) === targetDir) return sessionDir;

    if (fs.existsSync(targetDir)) {
      throw new Error(`Session ${sessionId}: partition target already exists`);
    }

    this.assertSafeSessionDir(sessionDir);
    if (isPathInside(path.resolve(sessionDir), targetDir)) {
      throw new Error(
        `Session ${sessionId}: partition target is inside the source session`,
      );
    }
    await this.ensurePartitionParent(segments.slice(0, -1));
    await defaultSessionStore.moveToPartition(sessionDir, targetDir);
    this.assertSafeSessionDir(targetDir);
    return targetDir;
  }

  async finalize(
    sessionId: string,
    options?: { refinalize?: boolean },
  ): Promise<SessionFinalizationResult> {
    let sessionDir = await this.getExistingSessionDir(sessionId);
    if (!sessionDir) throw new Error(`Session ${sessionId}: not found`);
    let meta: Record<string, unknown>;
    try {
      const raw = await defaultSessionStore.readArtifact(
        sessionDir,
        "meta.json",
      );
      if (!raw) throw new Error("missing");
      meta = JSON.parse(raw.toString("utf-8"));
    } catch {
      throw new Error(`Session ${sessionId}: meta.json is missing or corrupt`);
    }
    // Idempotency guard: a finalize that already SUCCEEDED (meta.processed === true)
    // is a no-op that reports the prior result reconstructed from meta.finalization.
    // A previously FAILED finalize (processed !== true) intentionally falls through so
    // it can be retried — postProcess and the partition move re-run below.
    // `refinalize: true` (idle sweeper, after late events landed post-finalize)
    // bypasses the guard and re-runs postProcess over the full raw event log —
    // safe because events.ndjson is never deleted by cold storage, only hidden.
    if (
      options?.refinalize !== true &&
      meta.processed === true &&
      isRecord(meta.finalization)
    ) {
      const prior = reconstructFinalizationResult(sessionId, meta.finalization);
      if (prior) return prior;
    }

    const finalizedAt = Date.now();
    sessionDir = await this.moveSessionToV2Partition(
      sessionDir,
      sessionId,
      meta,
    );
    this.assertNoSymlinkedGeneratedArtifacts(sessionDir);
    meta.end = finalizedAt;

    let processed = false;
    let postProcessError: string | undefined;
    try {
      await this.postProcess(sessionDir, this.whisperModel);
      processed = true;
    } catch (err) {
      postProcessError = sanitizePostProcessError(err);
      // Durability guard: postProcess may have written a partial/incomplete
      // events.ndjson.zst before throwing. Its mere existence hides the still-present
      // raw events.ndjson behind the cold-storage gate, stranding evidence on a failed
      // finalize. Remove it (defensively, tolerating ENOENT) so a retry sees raw
      // evidence and the hiding gate stays closed.
      removePartialColdArtifact(sessionDir);
    }

    const audio = await readAudioSummary(sessionDir);
    const warnings = [
      audioDegradationWarning(audio),
      videoDegradationWarning(sessionDir),
    ].filter(
      (
        warning,
      ): warning is {
        capability: "audio" | "video";
        code: string;
        message: string;
      } => warning !== undefined,
    );

    const result: SessionFinalizationResult = {
      ok: true,
      sessionId,
      processed,
      degraded: !processed || warnings.length > 0,
      finalizedAt,
      postProcess: {
        ok: processed,
        ...(postProcessError ? { error: postProcessError } : {}),
        ...(audio ? { audio } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    };

    meta.processed = result.processed;
    meta.finalization = {
      processed: result.processed,
      degraded: result.degraded,
      finalizedAt: result.finalizedAt,
      postProcess: result.postProcess,
    };
    await this.writeSessionArtifact(
      sessionDir,
      "meta.json",
      JSON.stringify(meta, null, 2),
    );
    return result;
  }

  // Enumerate the session directories under outputDir, applying the symlink / path
  // traversal guards once so every consumer (list, listSummaries) shares them.
  private async eachSessionDir(
    visit: (id: string, sessionDir: string) => void | Promise<void>,
  ): Promise<void> {
    for (const { id, dir } of await defaultSessionStore.listSessions(
      this.outputDir,
    )) {
      await visit(id, dir);
    }
  }

  async list(filters?: {
    app?: string;
    after?: number;
    before?: number;
    release?: string;
    build?: string;
  }): Promise<SessionListItem[]> {
    const sessions: SessionListItem[] = [];
    await this.eachSessionDir((_id, sessionDir) => {
      const metaPath = path.join(sessionDir, "meta.json");
      if (!fs.existsSync(metaPath)) return;
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        if (filters?.after && meta.start < filters.after) return;
        if (filters?.before && meta.start > filters.before) return;
        if (filters?.app && meta.app !== filters.app) return;
        if (
          filters?.release &&
          !metadataMatches(meta, filters.release, [
            "release",
            "releaseId",
            "version",
          ])
        )
          return;
        if (
          filters?.build &&
          !metadataMatches(meta, filters.build, [
            "build",
            "buildId",
            "commit",
            "sha",
          ])
        )
          return;
        sessions.push({
          id: meta.id,
          start: meta.start,
          end: meta.end,
          ...(stringField(meta.release ?? meta.releaseId ?? meta.version)
            ? {
                release: stringField(
                  meta.release ?? meta.releaseId ?? meta.version,
                ),
              }
            : {}),
          ...(stringField(meta.build ?? meta.buildId ?? meta.commit ?? meta.sha)
            ? {
                build: stringField(
                  meta.build ?? meta.buildId ?? meta.commit ?? meta.sha,
                ),
              }
            : {}),
        });
      } catch {
        return;
      }
    });
    return sessions;
  }

  // Rich per-session summaries for the dashboard. Each directory is read independently
  // inside a try/catch so a single bad/partial/malformed session never breaks the list.
  // Returned newest-first (by start, descending).
  async listSummaries(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    await this.eachSessionDir(async (id, sessionDir) => {
      try {
        const summary = await readSessionSummary(id, sessionDir);
        if (summary) summaries.push(summary);
      } catch {
        // Skip any directory that fails to read; never throw the whole list.
      }
    });
    summaries.sort((a, b) => b.start - a.start);
    return summaries;
  }

  private isSessionDir(sessionDir: string): boolean {
    if (!fs.existsSync(sessionDir)) return false;
    this.assertSafeSessionDir(sessionDir);
    return (
      safeRegularFilePath(sessionDir, path.join(sessionDir, "meta.json")) !==
      undefined
    );
  }

  private async ensurePartitionParent(segments: string[]): Promise<void> {
    let current = path.resolve(this.outputDir);
    const outputRoot = fs.realpathSync(path.resolve(this.outputDir));
    for (const segment of segments) {
      current = path.join(current, segment);
      if (fs.existsSync(current)) {
        this.assertSafeDirectoryInsideOutput(current, outputRoot);
      } else {
        await ensurePrivateDirectory(current);
        this.assertSafeDirectoryInsideOutput(current, outputRoot);
      }
    }
  }

  private assertSafeDirectoryInsideOutput(
    dir: string,
    outputRoot: string,
  ): void {
    const stat = fs.lstatSync(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new Error("Invalid sessionId");
    if (safeRegularFilePath(dir, path.join(dir, "meta.json"))) {
      throw new Error("Invalid session partition path");
    }
    const realDir = fs.realpathSync(dir);
    if (realDir !== outputRoot && !realDir.startsWith(outputRoot + path.sep)) {
      throw new Error("Invalid sessionId");
    }
    if (process.platform !== "win32") {
      fs.chmodSync(realDir, PRIVATE_DIR_MODE);
    }
  }

  private async writeSessionArtifact(
    sessionDir: string,
    name: string,
    data: string | Buffer,
  ): Promise<void> {
    await defaultSessionStore.writeSessionArtifact(sessionDir, name, data);
  }

  private assertNoSymlinkedGeneratedArtifacts(sessionDir: string): void {
    for (const name of GENERATED_SESSION_ARTIFACTS) {
      const filePath = path.join(sessionDir, name);
      try {
        const stat = fs.lstatSync(filePath);
        if (stat.isSymbolicLink()) throw new Error("Invalid sessionId");
      } catch (err) {
        if (isNodeError(err) && err.code === "ENOENT") continue;
        throw err;
      }
      assertWritableSessionArtifactPath(sessionDir, filePath);
    }
    for (const name of GENERATED_SESSION_DIRECTORIES) {
      assertNoSymlinkedExistingTree(sessionDir, path.join(sessionDir, name));
    }
  }
}

function isSameSessionMetadata(
  existing: Record<string, unknown>,
  next: Record<string, unknown>,
): boolean {
  for (const [key, value] of Object.entries(next)) {
    if (JSON.stringify(existing[key]) !== JSON.stringify(value)) return false;
  }
  return true;
}

function metadataMatches(
  meta: Record<string, unknown>,
  expected: string,
  keys: string[],
): boolean {
  return keys.some((key) => meta[key] === expected);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

const GENERATED_SESSION_ARTIFACTS = [
  "meta.json",
  "index.json",
  "CANDIDATES.md",
  "llm.json",
  "llm.md",
  "timeline.md",
  "manifest.json",
  "bundle.json",
  "candidates.jsonl",
  "search.jsonl",
  "signatures.json",
  "opinion.json",
  "opinion.md",
  "opinion.audit.json",
  "diagnosis.json",
  "diagnosis.md",
  "capture-truncated.json",
  "audio.json",
  "audio.wav",
  "transcript.json",
  "events.ndjson",
  "events.ndjson.zst",
];

const GENERATED_SESSION_DIRECTORIES = ["windows"];

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
};

function assertNoSymlinkedExistingTree(
  rootDir: string,
  entryPath: string,
): void {
  try {
    const stat = fs.lstatSync(entryPath);
    if (stat.isSymbolicLink()) throw new Error("Invalid sessionId");
    assertWritableSessionArtifactPath(rootDir, entryPath);
    if (!stat.isDirectory()) return;
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") return;
    throw err;
  }

  const stack = [entryPath];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      throw new Error("Invalid sessionId");
    }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) throw new Error("Invalid sessionId");
      assertWritableSessionArtifactPath(rootDir, child);
      if (stat.isDirectory()) stack.push(child);
    }
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function buildSessionPartition(
  meta: Record<string, unknown>,
  sessionId: string,
): {
  tenant: string;
  app: string;
  date: string;
  sessionId: string;
} {
  return {
    tenant: partitionSegment(meta.tenant, "local"),
    app: partitionSegment(meta.app, "unknown-app"),
    date: isoDate(typeof meta.start === "number" ? meta.start : Date.now()),
    sessionId,
  };
}

function partitionSegment(value: unknown, fallback: string): string {
  if (typeof value !== "string" && typeof value !== "number") return fallback;
  const text = String(value).trim().toLowerCase();
  if (!text) return fallback;
  const normalized = text
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!normalized || normalized === "." || normalized === "..") return fallback;
  return normalized;
}

function isoDate(value: number): string {
  if (!Number.isFinite(value)) return "1970-01-01";
  try {
    return new Date(value).toISOString().slice(0, 10);
  } catch {
    return "1970-01-01";
  }
}

// Reads the artifacts for one session directory and maps them into a SessionSummary.
// A directory without meta.json, or with corrupt meta.json, is treated as not a session
// (returns undefined). A valid meta with missing/corrupt index.json degrades gracefully.
// Reads index.json / candidates.jsonl through the SessionStore seam so a storage
// decorator (the hosted cloud's at-rest encryption) can open them; reading them
// with fs would silently JSON.parse ciphertext and drop every derived field.
async function readSessionSummary(
  id: string,
  sessionDir: string,
): Promise<SessionSummary | undefined> {
  const metaPath = path.join(sessionDir, "meta.json");
  if (!fs.existsSync(metaPath)) return undefined;

  let meta: unknown;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
  } catch {
    return undefined;
  }
  const metaRecord = isRecord(meta) ? meta : {};
  if (typeof metaRecord.id !== "string") metaRecord.id = id;

  let index: unknown;
  try {
    const raw = await defaultSessionStore.readArtifact(sessionDir, "index.json");
    index = raw ? JSON.parse(raw.toString("utf-8")) : undefined;
  } catch {
    index = undefined;
  }

  const flags: SessionFileFlags = {
    hasVideo: existsNonEmptyFile(path.join(sessionDir, "recording.webm")),
    hasDiagnosis:
      fs.existsSync(path.join(sessionDir, "opinion.json")) ||
      fs.existsSync(path.join(sessionDir, "diagnosis.json")),
    topSeverity: await readTopSeverity(sessionDir),
  };
  return buildSessionSummary(metaRecord, index, flags);
}

function existsNonEmptyFile(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

// Best-effort highest candidate severity from candidates.jsonl. Tolerant of a missing or
// partially malformed file: unreadable lines are skipped.
async function readTopSeverity(
  sessionDir: string,
): Promise<Severity | undefined> {
  let raw: string;
  try {
    const buf = await defaultSessionStore.readArtifact(
      sessionDir,
      "candidates.jsonl",
    );
    if (!buf) return undefined;
    raw = buf.toString("utf-8");
  } catch {
    return undefined;
  }

  let top: Severity | undefined;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      const severity = parsed.severity;
      if (
        severity !== "critical" &&
        severity !== "high" &&
        severity !== "medium" &&
        severity !== "low"
      )
        continue;
      if (!top || SEVERITY_RANK[severity] > SEVERITY_RANK[top]) top = severity;
    } catch {
      // Skip malformed candidate lines.
    }
  }
  return top;
}

// Reconstructs a prior SessionFinalizationResult from the persisted meta.finalization
// so a repeat finalize can report the original outcome without re-running postProcess.
// Returns undefined if the persisted record is malformed, so finalize falls back to a
// full (re)finalization rather than returning a bogus result.
function reconstructFinalizationResult(
  sessionId: string,
  finalization: Record<string, unknown>,
): SessionFinalizationResult | undefined {
  if (
    typeof finalization.processed !== "boolean" ||
    typeof finalization.degraded !== "boolean" ||
    typeof finalization.finalizedAt !== "number" ||
    !isRecord(finalization.postProcess)
  ) {
    return undefined;
  }
  return {
    ok: true,
    sessionId,
    processed: finalization.processed,
    degraded: finalization.degraded,
    finalizedAt: finalization.finalizedAt,
    postProcess:
      finalization.postProcess as SessionFinalizationResult["postProcess"],
  };
}

// Best-effort removal of a partial cold artifact left behind by a failed postProcess.
// `force: true` tolerates ENOENT; any other error is swallowed so a failed finalize
// still returns its degraded result instead of throwing.
function removePartialColdArtifact(sessionDir: string): void {
  try {
    fs.rmSync(path.join(sessionDir, "events.ndjson.zst"), { force: true });
  } catch {
    // Ignore: the raw events.ndjson remains for a retry regardless.
  }
}

function sanitizePostProcessError(_err: unknown): string {
  return "Post-processing failed; session artifacts were preserved without derived outputs";
}

async function readAudioSummary(
  sessionDir: string,
): Promise<PostProcessAudioSummary | undefined> {
  try {
    const raw = await defaultSessionStore.readArtifact(sessionDir, "index.json");
    if (!raw) return undefined;
    const index: unknown = JSON.parse(raw.toString("utf-8"));
    if (
      !isRecord(index) ||
      !isRecord(index.audio) ||
      !isRecord(index.audio.transcription)
    )
      return undefined;
    if (
      index.audio.artifact !== "audio.webm" ||
      typeof index.audio.bytes !== "number"
    )
      return undefined;
    return index.audio as unknown as PostProcessAudioSummary;
  } catch {
    return undefined;
  }
}

function audioDegradationWarning(
  audio: PostProcessAudioSummary | undefined,
): { capability: "audio"; code: string; message: string } | undefined {
  if (!audio) return undefined;
  const state = audio.transcription.state;
  if (state !== "transcription-unavailable" && state !== "transcription-error")
    return undefined;

  return {
    capability: "audio",
    code: audio.transcription.code ?? state,
    message:
      audio.transcription.message ??
      "Audio transcription degraded; audio.webm was preserved",
  };
}

function videoDegradationWarning(
  sessionDir: string,
): { capability: "video"; code: string; message: string } | undefined {
  const recordingPath = path.join(sessionDir, "recording.webm");
  try {
    if (fs.existsSync(recordingPath) && fs.statSync(recordingPath).size > 0)
      return undefined;
  } catch {
    return undefined;
  }

  const eventsPath = path.join(sessionDir, "events.ndjson");
  try {
    if (!fs.existsSync(eventsPath) || !fs.statSync(eventsPath).isFile())
      return undefined;

    for (const line of fs.readFileSync(eventsPath, "utf-8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const event: unknown = JSON.parse(line);
        if (!isRecord(event) || event.k !== "media.video" || !isRecord(event.d))
          continue;
        const state =
          typeof event.d.state === "string" ? event.d.state : undefined;
        const code =
          typeof event.d.code === "string" ? event.d.code : undefined;
        if (state !== "error" && code === undefined) continue;
        return {
          capability: "video",
          code: code ?? state ?? "video_degraded",
          // `event.d.message` is page-influenced (it originates from tabCapture error
          // strings that the page can influence indirectly). It is later persisted to
          // meta.json and returned from the API, so we truncate and strip control /
          // non-ASCII characters here. Non-ASCII bytes are stripped on purpose so the
          // warning can be safely embedded in plain-text bug reports and CLI output.
          message:
            typeof event.d.message === "string"
              ? sanitizeWarningMessage(event.d.message)
              : "Active-tab video degraded; recording.webm was not produced",
        };
      } catch {
        // Ignore malformed event lines; post-processing already preserves raw evidence for inspection.
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

const WARNING_MESSAGE_MAX_LENGTH = 200;

function sanitizeWarningMessage(raw: string): string {
  return raw.slice(0, WARNING_MESSAGE_MAX_LENGTH).replace(/[^\x20-\x7E]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function isNodeError(value: unknown): value is NodeJS.ErrnoException {
  return value instanceof Error && "code" in value;
}
