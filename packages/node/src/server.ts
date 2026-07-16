import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { createHash, timingSafeEqual } from "node:crypto";
import type { BugEvent, Symptom } from "crumbtrail-core";
import { buildRecallStore } from "./recall";
import { locateAndAssemble } from "./locate-incident";
import type { EvidenceSource } from "./evidence-sources/registry";
import { SessionManager } from "./session";
import type { SessionManagerConfig } from "./session";
import { BugQueueManager } from "./bug-queue";
import type { BugReport } from "./bug-queue";
import {
  appendEvents,
  DEFAULT_MAX_SESSION_EVENT_BYTES,
  writeBlob,
} from "./writer";
import {
  backfillAiDiagnoses,
  scheduleAiDiagnosis,
  type AiDiagnosisConfig,
} from "./ai-diagnosis";
import { startSessionSweeper } from "./session-sweeper";
import { startFastFinalizer, type FastFinalizeHandle } from "./fast-finalize";
import { buildHealthPayload, buildPublicHealthPayload } from "./health";
import {
  convertOtlpTraceToEvents,
  convertOtlpLogsToEvents,
} from "./otel-adapter";
import {
  decodeOtlpLogsProtobuf,
  decodeOtlpTraceProtobuf,
} from "./otel-protobuf";

export interface ServerConfig {
  port: number;
  outputDir: string;
  whisperModel?: string;
  /** Override the session finalization post-processing step (e.g. to skip whisper transcription in tests). */
  postProcess?: SessionManagerConfig["postProcess"];
  staticDir?: string;
  authToken?: string;
  allowedOrigins?: string[];
  maxJsonBodyBytes?: number;
  maxEventBatchSize?: number;
  maxSessionEventBytes?: number;
  maxBlobBytes?: number;
  allowRemoteApi?: boolean;
  ai?: AiDiagnosisConfig;
  otlpAutoSessionWindowMs?: number;
  maxOtlpTraceSessionCache?: number;
  /**
   * Idle-session sweep: server-side finalization for sessions that never call
   * POST /api/session/end (autoCapture backends, OTLP auto-sessions). Enabled
   * by default — without it those sessions never produce index.json and every
   * dashboard detail read 404s. Set `enabled: false` to opt out (tests).
   */
  sessionSweep?: {
    enabled?: boolean;
    idleMs?: number;
    /** Max age before a never-idle (still-active) session is checkpoint-finalized. */
    checkpointMs?: number;
    intervalMs?: number;
    maxPerSweep?: number;
  };
  /**
   * Severity-triggered fast finalize: high-severity ingest events (uncaught
   * errors/rejections, 5xx, backend errors, OTel ERROR spans/logs) schedule a
   * debounced checkpoint-finalize for their session, cutting worst-case
   * detection latency from the idle-sweep cadence (~40 min) to roughly the
   * debounce window. Enabled by default; set `enabled: false` to opt out
   * (tests). Scheduler state is in-memory only — a fast finalize lost to a
   * restart falls back to the normal idle sweep.
   * Defaults: debounceMs 45_000, maxConcurrent 2, cooldownMs 300_000.
   */
  fastFinalize?: {
    enabled?: boolean;
    /** Delay from the first severe event to the finalize attempt. Default 45_000. */
    debounceMs?: number;
    /** Global cap on concurrently running fast finalizes. Default 2. */
    maxConcurrent?: number;
    /** Minimum spacing between finalize attempts per session. Default 300_000. */
    cooldownMs?: number;
  };
  /**
   * Fired after every successful session finalization (including
   * re-finalizations), from all three finalize paths: POST /api/session/end,
   * the idle sweeper, and the severity-triggered fast finalizer. Embedders
   * (e.g. crumbtrail-cloud) use it to learn about finalization in-process
   * instead of polling. Must be fast and non-blocking — it runs on the
   * finalize path. A throwing hook is swallowed and logged; it never fails
   * the finalize or suppresses AI-diagnosis scheduling.
   */
  onSessionFinalized?: (
    sessionId: string,
    info: { refinalized: boolean },
  ) => void;
  /**
   * Per-tenant seam for the inner /api/solve-context adapter phase. Hosted
   * cloud uses it to inject exactly one tenant's sealed credential sources.
   * Returning an array, including [], bypasses evidenceSourcesFromEnv(). Returning
   * undefined explicitly requests the legacy environment fallback. This makes
   * fallback an affirmative operator decision instead of an accidental omission.
   */
  evidenceSourcesFactory?: (ctx: {
    tenantId?: string;
    projectId?: string;
  }) => EvidenceSource[] | undefined | Promise<EvidenceSource[] | undefined>;
}

export const DEFAULT_MAX_JSON_BODY_BYTES = 1_048_576;
export const DEFAULT_MAX_EVENT_BATCH_SIZE = 1_000;
export const DEFAULT_MAX_BLOB_BYTES = 25 * 1024 * 1024;

const AUDIO_ARTIFACT_NAME = "audio.webm";
const AUDIO_METADATA_NAME = "audio.json";
const VIDEO_ARTIFACT_NAME = "recording.webm";
const ALLOWED_BLOB_ARTIFACT_NAMES = new Set([
  VIDEO_ARTIFACT_NAME,
  AUDIO_ARTIFACT_NAME,
]);
const MAX_METADATA_HEADER_BYTES = 8 * 1024;
const DEFAULT_OTLP_AUTO_SESSION_WINDOW_MS = 30 * 60 * 1000;
const DEFAULT_OTLP_TRACE_SESSION_CACHE = 2048;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".jsonl": "application/x-ndjson",
  ".ndjson": "application/x-ndjson",
  ".md": "text/markdown",
  ".zst": "application/zstd",
  ".webm": "video/webm",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

class RequestValidationError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
    readonly code = "server_rejected",
    readonly retryable = false,
  ) {
    super(publicMessage);
    this.name = "RequestValidationError";
  }
}

function serveStatic(
  res: http.ServerResponse,
  staticDir: string,
  urlPath: string,
): boolean {
  const resolved = resolveStaticPath(staticDir, urlPath);
  if (!resolved) return false;
  if (!fs.existsSync(resolved)) return false;
  const ext = path.extname(resolved);
  const mime = MIME_TYPES[ext] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": mime });
  res.end(fs.readFileSync(resolved));
  return true;
}

function resolveStaticPath(
  staticDir: string,
  urlPath: string,
): string | undefined {
  const root = path.resolve(staticDir);
  let relativePath: string;
  try {
    relativePath =
      urlPath === "/"
        ? "index.html"
        : decodeURIComponent(urlPath).replace(/^\/+/, "");
  } catch {
    return undefined;
  }
  if (relativePath.includes("\0")) return undefined;

  const resolved = path.resolve(root, relativePath);
  const relative = path.relative(root, resolved);
  if (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
    return resolved;
  return undefined;
}

function serveSpaShell(res: http.ServerResponse, staticDir: string): boolean {
  const indexPath = path.resolve(path.join(staticDir, "index.html"));
  if (!fs.existsSync(indexPath)) return false;
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(fs.readFileSync(indexPath));
  return true;
}

// A GET path that looks like a client-side route (not an API route and not a missing
// static asset). Asset-looking paths keep their file extension and should 404 when
// absent rather than be masked by the SPA shell; /api/* paths must never fall through.
function looksLikeClientRoute(urlPath: string): boolean {
  if (urlPath.startsWith("/api/")) return false;
  const lastSegment = urlPath.split("/").pop() ?? "";
  return !lastSegment.includes(".");
}

function readBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;

    req.on("data", (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) {
        reject(
          new RequestValidationError(
            413,
            "Request body is too large",
            "request_too_large",
            false,
          ),
        );
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
  });
}

async function readJsonBody(
  req: http.IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  if (requestContentType(req) !== "json") {
    throw new RequestValidationError(
      415,
      "Expected application/json request body",
      "invalid_content_type",
      false,
    );
  }

  const body = await readBody(req, maxBytes);
  try {
    return JSON.parse(body.toString("utf-8"));
  } catch {
    throw new RequestValidationError(
      400,
      "Invalid JSON request body",
      "invalid_json",
      false,
    );
  }
}

function requestContentType(
  req: http.IncomingMessage,
): "json" | "protobuf" | undefined {
  const raw = req.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const type = value.split(";", 1)[0].trim().toLowerCase();
  const [, subtype = ""] = type.split("/", 2);
  if (
    type === "application/json" ||
    subtype === "json" ||
    subtype.endsWith("+json")
  )
    return "json";
  if (
    type === "application/x-protobuf" ||
    subtype === "protobuf" ||
    subtype.endsWith("+protobuf")
  )
    return "protobuf";
  return undefined;
}

function isGrpcContentType(req: http.IncomingMessage): boolean {
  const raw = req.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return false;
  return value.split(";", 1)[0].trim().toLowerCase() === "application/grpc";
}

function isGzipEncoding(req: http.IncomingMessage): boolean {
  const value = headerValue(req.headers["content-encoding"]);
  if (!value) return false;
  return value
    .split(",")
    .map((part: string) => part.trim().toLowerCase())
    .includes("gzip");
}

// Inflate a gzip body when Content-Encoding: gzip is present, capping the
// inflated size at maxBytes so a small compressed payload can't amplify into a
// memory-exhausting one (zip-bomb guard). Past the cap → 413; corrupt gzip → 400.
function decodeContentEncoding(
  body: Buffer,
  req: http.IncomingMessage,
  maxBytes: number,
): Buffer {
  if (!isGzipEncoding(req)) return body;
  try {
    return zlib.gunzipSync(body, { maxOutputLength: maxBytes });
  } catch (err) {
    if (
      err instanceof RangeError ||
      (err as NodeJS.ErrnoException | undefined)?.code ===
        "ERR_BUFFER_TOO_LARGE"
    ) {
      throw new RequestValidationError(
        413,
        "Request body is too large",
        "request_too_large",
        false,
      );
    }
    throw new RequestValidationError(
      400,
      "Invalid gzip request body",
      "invalid_gzip",
      false,
    );
  }
}

async function readOtlpBody(
  req: http.IncomingMessage,
  maxBytes: number,
  signal: "traces" | "logs",
): Promise<
  | Parameters<typeof convertOtlpTraceToEvents>[0]
  | Parameters<typeof convertOtlpLogsToEvents>[0]
> {
  const contentType = requestContentType(req);
  if (contentType === "json") {
    const raw = decodeContentEncoding(
      await readBody(req, maxBytes),
      req,
      maxBytes,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf-8"));
    } catch {
      throw new RequestValidationError(
        400,
        "Invalid JSON request body",
        "invalid_json",
        false,
      );
    }
    return requireObjectBody(parsed);
  }
  if (contentType === "protobuf") {
    const body = decodeContentEncoding(
      await readBody(req, maxBytes),
      req,
      maxBytes,
    );
    try {
      return signal === "traces"
        ? decodeOtlpTraceProtobuf(body)
        : decodeOtlpLogsProtobuf(body);
    } catch {
      throw new RequestValidationError(
        400,
        "Invalid protobuf request body",
        "invalid_protobuf",
        false,
      );
    }
  }
  if (isGrpcContentType(req)) {
    throw new RequestValidationError(
      415,
      "OTLP gRPC framing was sent to the OTLP/HTTP listener; change `otlp` to `otlphttp` in your collector exporter.",
      "otlp_grpc_to_http",
      false,
    );
  }
  throw new RequestValidationError(
    415,
    "Expected OTLP JSON or protobuf request body",
    "invalid_content_type",
    false,
  );
}

function hasAllowedRawUploadContentType(req: http.IncomingMessage): boolean {
  const raw = req.headers["content-type"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return false;
  const type = value.split(";", 1)[0].trim().toLowerCase();
  return (
    type === "application/octet-stream" ||
    type === "audio/webm" ||
    type === "video/webm"
  );
}

function isLocalhostOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      (parsed.hostname === "localhost" ||
        parsed.hostname === "127.0.0.1" ||
        parsed.hostname === "[::1]" ||
        parsed.hostname === "::1")
    );
  } catch {
    return false;
  }
}

function isAllowedOrigin(
  origin: string,
  allowedOrigins: string[] = [],
): boolean {
  return isLocalhostOrigin(origin) || allowedOrigins.includes(origin);
}

function isTrustedBrowserWrite(
  req: http.IncomingMessage,
  allowedOrigins?: string[],
): boolean {
  const secFetchSite = headerValue(
    req.headers["sec-fetch-site"],
  )?.toLowerCase();
  if (secFetchSite === "cross-site") return false;

  const origin = headerValue(req.headers.origin);
  if (origin && !isAllowedOrigin(origin, allowedOrigins)) return false;

  return true;
}

function appendVaryHeader(res: http.ServerResponse, value: string): void {
  const existing = res.getHeader("Vary");
  if (typeof existing === "string" && existing.length > 0) {
    if (
      existing
        .split(",")
        .map((part) => part.trim())
        .includes(value)
    )
      return;
    res.setHeader("Vary", `${existing}, ${value}`);
    return;
  }
  res.setHeader("Vary", value);
}

function setCors(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  allowedOrigins?: string[],
): void {
  const origin = req.headers.origin;
  if (!origin || !isAllowedOrigin(origin, allowedOrigins)) return;

  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, X-Session-Id, X-Metadata, X-Crumbtrail-Auth, Authorization",
  );
  appendVaryHeader(res, "Origin");
}

// Accept the shared secret via either `X-Crumbtrail-Auth: <token>` or the
// standard `Authorization: Bearer <token>` header (cloud already treats the two
// equivalently; this brings the local receiver to parity). Returns the raw token
// string presented, or undefined when neither header carries one.
function presentedAuthToken(req: http.IncomingMessage): string | undefined {
  const direct = req.headers["x-crumbtrail-auth"];
  if (typeof direct === "string") return direct;
  const authorization = headerValue(req.headers.authorization);
  if (authorization) {
    const bearer = /^Bearer\s+(.+)$/i.exec(authorization);
    if (bearer) return bearer[1];
  }
  return undefined;
}

function isAuthorized(req: http.IncomingMessage, authToken?: string): boolean {
  if (!authToken) return true;
  const presented = presentedAuthToken(req);
  if (presented === undefined) return false;
  // Constant-time compare over fixed-width digests (both the x-crumbtrail-auth
  // and Bearer paths funnel through the same posture).
  return timingSafeEqual(authDigest(presented), authDigest(authToken));
}

function authDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function isLoopbackRequest(req: http.IncomingMessage): boolean {
  const address = req.socket.remoteAddress;
  if (!address) return false;
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function json(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function jsonError(
  res: http.ServerResponse,
  status: number,
  message: string,
  code = "server_rejected",
  retryable = false,
): void {
  json(res, status, { error: message, code, retryable });
}

function text(
  res: http.ServerResponse,
  status: number,
  data: string,
  contentType: string,
): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(data);
}

function requireObjectBody(body: unknown): Record<string, unknown> {
  if (!isRecord(body)) {
    throw new RequestValidationError(
      400,
      "Expected JSON object request body",
      "invalid_json",
      false,
    );
  }
  return body;
}

function getExistingSessionDirOrThrow(
  sessions: SessionManager,
  sessionId: unknown,
): string {
  try {
    const sessionDir = sessions.getExistingSessionDir(
      typeof sessionId === "string" ? sessionId : "",
    );
    if (!sessionDir) {
      throw new RequestValidationError(
        404,
        "Session not found",
        "not_found",
        false,
      );
    }
    return sessionDir;
  } catch (err) {
    if (err instanceof RequestValidationError) throw err;
    if (isInvalidSessionIdError(err)) {
      throw new RequestValidationError(
        400,
        "Invalid sessionId",
        "invalid_session_id",
        false,
      );
    }
    throw err;
  }
}

function requireAuthorized(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authToken?: string,
): boolean {
  if (isAuthorized(req, authToken)) return true;
  jsonError(res, 401, "Unauthorized", "permission_denied", false);
  return false;
}

function buildPublicBaseUrl(
  req: http.IncomingMessage,
  fallbackPort: number,
): string {
  const host = headerValue(req.headers.host)?.trim();
  if (host) return `http://${host}`;
  return `http://localhost:${fallbackPort}`;
}

function sessionLocation(
  req: http.IncomingMessage,
  port: number,
  sessionId: string,
  sessionDir: string,
): {
  sessionDir: string;
  sessionUrl: string;
  candidatesUrl?: string;
  llmUrl?: string;
} {
  const baseUrl = buildPublicBaseUrl(req, port);
  const encodedSessionId = encodeURIComponent(sessionId);
  const sessionUrl = `${baseUrl}/sessions/${encodedSessionId}`;
  const llmPath = path.join(sessionDir, "llm.md");
  const candidatesPath = path.join(sessionDir, "CANDIDATES.md");
  return removeUndefined({
    sessionDir,
    sessionUrl,
    candidatesUrl: fs.existsSync(candidatesPath)
      ? `${sessionUrl}/CANDIDATES.md`
      : undefined,
    llmUrl: fs.existsSync(llmPath) ? `${sessionUrl}/llm.md` : undefined,
  });
}

function renderSessionPage(
  sessionId: string,
  sessionDir: string,
  baseUrl: string,
): string {
  const encodedSessionId = encodeURIComponent(sessionId);
  const sessionUrl = `${baseUrl}/sessions/${encodedSessionId}`;
  const artifactRows = sessionArtifactNames(sessionDir)
    .filter((name) => fs.existsSync(path.join(sessionDir, name)))
    .map(
      (name) =>
        `<li><a href="${sessionUrl}/${encodeURIComponent(name)}">${escapeHtml(name)}</a></li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Crumbtrail session ${escapeHtml(sessionId)}</title>
  <style>
    body{font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:32px;line-height:1.45;color:#171717}
    code{background:#f4f4f5;padding:2px 4px;border-radius:4px}
    li{margin:6px 0}
  </style>
</head>
<body>
  <h1>Crumbtrail session ${escapeHtml(sessionId)}</h1>
  <p>Saved data: <code>${escapeHtml(sessionDir)}</code></p>
  <h2>Artifacts</h2>
  <ul>${artifactRows || "<li>No generated artifacts found yet.</li>"}</ul>
</body>
</html>`;
}

function sessionArtifactNames(sessionDir: string): string[] {
  const hasColdEvents = fs.existsSync(
    path.join(sessionDir, "events.ndjson.zst"),
  );
  return [
    "opinion.md",
    "CANDIDATES.md",
    "timeline.md",
    "manifest.json",
    "bundle.json",
    "llm.md",
    "llm.json",
    "candidates.jsonl",
    "search.jsonl",
    "index.json",
    "signatures.json",
    "capture-truncated.json",
    "meta.json",
    "events.ndjson",
    "events.ndjson.zst",
    "recording.webm",
    "audio.webm",
  ].filter((name) => name !== "events.ndjson" || !hasColdEvents);
}

function serveSessionArtifact(
  res: http.ServerResponse,
  sessionDir: string,
  artifactName: string,
): void {
  const allowed = new Set([
    "opinion.md",
    "opinion.json",
    "opinion.audit.json",
    // Legacy artifacts remain directly readable for existing sessions.
    "diagnosis.md",
    "diagnosis.json",
    "CANDIDATES.md",
    "candidates.jsonl",
    "timeline.md",
    "search.jsonl",
    "manifest.json",
    "bundle.json",
    "llm.md",
    "llm.json",
    "index.json",
    "signatures.json",
    "capture-truncated.json",
    "meta.json",
    "events.ndjson",
    "events.ndjson.zst",
    "recording.webm",
    "audio.webm",
  ]);
  const windowsMatch = artifactName.match(/^windows\/(cand_\d{4}\.md)$/);
  if (!allowed.has(artifactName) && !windowsMatch) {
    jsonError(res, 404, "Not found", "not_found", false);
    return;
  }

  if (
    artifactName === "events.ndjson" &&
    fs.existsSync(path.join(sessionDir, "events.ndjson.zst"))
  ) {
    jsonError(
      res,
      404,
      "Raw append log is hidden after cold storage finalization; use events.ndjson.zst",
      "not_found",
      false,
    );
    return;
  }

  const artifactPath = windowsMatch
    ? path.join(sessionDir, "windows", windowsMatch[1])
    : path.join(sessionDir, artifactName);
  const safePath = safeRegularFilePath(sessionDir, artifactPath);
  if (!safePath) {
    jsonError(res, 404, "Not found", "not_found", false);
    return;
  }

  const mime = MIME_TYPES[path.extname(safePath)] ?? "text/plain";
  const data = fs.readFileSync(safePath);
  const contentType =
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/x-ndjson"
      ? `${mime}; charset=utf-8`
      : mime;
  res.writeHead(200, { "Content-Type": contentType });
  res.end(data);
}

function safeRegularFilePath(
  rootDir: string,
  filePath: string,
): string | undefined {
  try {
    const root = fs.realpathSync(rootDir);
    const parent = fs.realpathSync(path.dirname(filePath));
    if (parent !== root && !parent.startsWith(root + path.sep))
      return undefined;
    const entry = fs.lstatSync(filePath);
    if (entry.isSymbolicLink() || !entry.isFile()) return undefined;
    const realPath = fs.realpathSync(filePath);
    if (realPath !== root && !realPath.startsWith(root + path.sep))
      return undefined;
    return realPath;
  } catch {
    return undefined;
  }
}

function assertWritableArtifactPath(rootDir: string, filePath: string): void {
  const root = fs.realpathSync(rootDir);
  const parent = fs.realpathSync(path.dirname(filePath));
  if (parent !== root && !parent.startsWith(root + path.sep)) {
    throw new RequestValidationError(
      400,
      "Invalid artifact path",
      "invalid_artifact_path",
      false,
    );
  }
  try {
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new RequestValidationError(
        400,
        "Invalid artifact path",
        "invalid_artifact_path",
        false,
      );
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isInvalidSessionIdError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Invalid sessionId");
}

function isMissingOrCorruptMetaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("meta.json is missing or corrupt");
}

function isSessionAlreadyExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Session already exists");
}

function isInvalidBugIdError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Invalid bugId");
}

function isBugAlreadyExistsError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes("Bug already exists");
}

function isInvalidArtifactPathError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return (
    message.includes("Invalid bug artifact path") ||
    message.includes("Refusing to write through symlinked artifact path")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

const ALLOWED_EVENT_PLATFORMS = new Set([
  "web",
  "react-native",
  "ios",
  "android",
  "flutter",
  "webview",
  "node",
]);
const EVENT_SCHEMA_VERSION = 1;

function validateAndNormalizeEvents(events: unknown[]): BugEvent[] {
  return events.map((event, index) => validateAndNormalizeEvent(event, index));
}

function validateAndNormalizeEvent(event: unknown, index: number): BugEvent {
  if (!isRecord(event)) {
    throw new RequestValidationError(
      400,
      `events[${index}] must be an object`,
      "invalid_events",
      false,
    );
  }
  if (typeof event.t !== "number" || !Number.isFinite(event.t)) {
    throw new RequestValidationError(
      400,
      `events[${index}].t must be a finite number`,
      "invalid_events",
      false,
    );
  }
  if (typeof event.k !== "string" || event.k.trim().length === 0) {
    throw new RequestValidationError(
      400,
      `events[${index}].k must be a non-empty string`,
      "invalid_events",
      false,
    );
  }
  if (!isRecord(event.d)) {
    throw new RequestValidationError(
      400,
      `events[${index}].d must be an object`,
      "invalid_events",
      false,
    );
  }
  if (
    event.schemaVersion !== undefined &&
    event.schemaVersion !== EVENT_SCHEMA_VERSION
  ) {
    throw new RequestValidationError(
      400,
      `events[${index}].schemaVersion must be ${EVENT_SCHEMA_VERSION}`,
      "invalid_events",
      false,
    );
  }

  const platform = event.platform ?? "web";
  if (typeof platform !== "string" || !ALLOWED_EVENT_PLATFORMS.has(platform)) {
    throw new RequestValidationError(
      400,
      `events[${index}].platform must be one of ${Array.from(ALLOWED_EVENT_PLATFORMS).join(", ")}`,
      "invalid_events",
      false,
    );
  }
  if (event.sdk !== undefined) validateSdkDescriptor(event.sdk, index);
  if (event.capabilities !== undefined)
    validateCapabilities(event.capabilities, index);
  if (event.target !== undefined)
    validateTargetDescriptor(event.target, index, "target");
  if (event.d.target !== undefined)
    validateTargetDescriptor(event.d.target, index, "d.target");

  return event as unknown as BugEvent;
}

function validateSdkDescriptor(value: unknown, index: number): void {
  if (!isRecord(value)) {
    throw new RequestValidationError(
      400,
      `events[${index}].sdk must be an object`,
      "invalid_events",
      false,
    );
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new RequestValidationError(
      400,
      `events[${index}].sdk.name must be a non-empty string`,
      "invalid_events",
      false,
    );
  }
  if (
    value.version !== undefined &&
    (typeof value.version !== "string" || value.version.trim().length === 0)
  ) {
    throw new RequestValidationError(
      400,
      `events[${index}].sdk.version must be a non-empty string`,
      "invalid_events",
      false,
    );
  }
}

function validateCapabilities(value: unknown, index: number): void {
  if (
    !Array.isArray(value) ||
    value.some(
      (entry) => typeof entry !== "string" || entry.trim().length === 0,
    )
  ) {
    throw new RequestValidationError(
      400,
      `events[${index}].capabilities must be an array of non-empty strings`,
      "invalid_events",
      false,
    );
  }
}

function validateTargetDescriptor(
  value: unknown,
  index: number,
  field: string,
): void {
  if (!isRecord(value)) {
    throw new RequestValidationError(
      400,
      `events[${index}].${field} must be an object`,
      "invalid_events",
      false,
    );
  }
  const plannedStringFields = [
    "role",
    "label",
    "testID",
    "accessibilityId",
    "componentName",
    "routePath",
    "ancestryHash",
  ] as const;
  let hasPlannedField = false;
  for (const key of plannedStringFields) {
    if (value[key] === undefined) continue;
    hasPlannedField = true;
    if (typeof value[key] !== "string" || value[key].trim().length === 0) {
      throw new RequestValidationError(
        400,
        `events[${index}].${field}.${key} must be a non-empty string`,
        "invalid_events",
        false,
      );
    }
  }
  if (!hasPlannedField) {
    throw new RequestValidationError(
      400,
      `events[${index}].${field} must include at least one planned target field`,
      "invalid_events",
      false,
    );
  }
  if (value.bounds !== undefined) {
    if (!isRecord(value.bounds)) {
      throw new RequestValidationError(
        400,
        `events[${index}].${field}.bounds must be an object`,
        "invalid_events",
        false,
      );
    }
    for (const key of ["x", "y", "width", "height"]) {
      if (
        typeof value.bounds[key] !== "number" ||
        !Number.isFinite(value.bounds[key])
      ) {
        throw new RequestValidationError(
          400,
          `events[${index}].${field}.bounds.${key} must be a finite number`,
          "invalid_events",
          false,
        );
      }
    }
  }
}

function writeAudioUploadMetadata(
  req: http.IncomingMessage,
  sessionDir: string,
  name: string,
  data: Buffer,
): void {
  if (name !== AUDIO_ARTIFACT_NAME) return;

  const metadata = parseUploadMetadata(req);
  const clientMetadata = metadata.value;
  const audioMetadata = removeUndefined({
    artifact: AUDIO_ARTIFACT_NAME,
    bytes: data.byteLength,
    uploadedAt: Date.now(),
    contentType: safeString(headerValue(req.headers["content-type"])),
    metadataStatus: metadata.status,
    metadataError: metadata.error,
    capability: safeString(clientMetadata?.capability),
    mimeType: safeString(clientMetadata?.mimeType),
    startedAt: nonNegativeNumber(clientMetadata?.startedAt),
    stoppedAt: nonNegativeNumber(clientMetadata?.stoppedAt),
    durationMs: nonNegativeNumber(clientMetadata?.durationMs),
    chunkCount: nonNegativeInteger(clientMetadata?.chunkCount),
    transcriptionRequested:
      typeof clientMetadata?.transcriptionRequested === "boolean"
        ? clientMetadata.transcriptionRequested
        : undefined,
  });

  const metadataPath = path.join(sessionDir, AUDIO_METADATA_NAME);
  assertWritableArtifactPath(sessionDir, metadataPath);
  fs.writeFileSync(metadataPath, JSON.stringify(audioMetadata, null, 2));
}

function parseUploadMetadata(req: http.IncomingMessage): {
  status: "absent" | "stored" | "invalid";
  value?: Record<string, unknown>;
  error?: "metadata_too_large" | "invalid_metadata";
} {
  const raw = headerValue(req.headers["x-metadata"]);
  if (!raw) return { status: "absent" };
  if (Buffer.byteLength(raw, "utf-8") > MAX_METADATA_HEADER_BYTES) {
    return { status: "invalid", error: "metadata_too_large" };
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed))
      return { status: "invalid", error: "invalid_metadata" };
    return { status: "stored", value: parsed };
  } catch {
    return { status: "invalid", error: "invalid_metadata" };
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.slice(0, 200) : undefined;
}

function nonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function nonNegativeInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && typeof value === "number" && value >= 0
    ? value
    : undefined;
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as T;
}

interface OtlpTraceSessionCache {
  get(traceId: string): string | undefined;
  set(traceId: string, sessionId: string): void;
}

class BoundedTraceSessionCache implements OtlpTraceSessionCache {
  private readonly entries = new Map<string, string>();

  constructor(private readonly maxEntries: number) {}

  get(traceId: string): string | undefined {
    const existing = this.entries.get(traceId);
    if (!existing) return undefined;
    this.entries.delete(traceId);
    this.entries.set(traceId, existing);
    return existing;
  }

  set(traceId: string, sessionId: string): void {
    if (this.maxEntries <= 0) return;
    if (this.entries.has(traceId)) this.entries.delete(traceId);
    this.entries.set(traceId, sessionId);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (typeof oldest !== "string") break;
      this.entries.delete(oldest);
    }
  }
}

function recordValue(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function stringAttr(
  record: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = recordValue(record, key);
    if (typeof value === "string" && value.trim().length > 0)
      return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return undefined;
}

function otlpResourceAttrs(event: BugEvent): Record<string, unknown> {
  return isRecord(event.d.resourceAttributes) ? event.d.resourceAttributes : {};
}

function safeAutoSessionSegment(
  value: string | undefined,
  fallback: string,
): string {
  const source = value && value.trim().length > 0 ? value : fallback;
  const safe = source
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return safe.length > 0 && /[a-z0-9]/.test(safe) ? safe : fallback;
}

function autoSessionIdForEvent(
  event: BugEvent,
  windowMs: number,
  traceSessions: OtlpTraceSessionCache,
): string {
  const traceId =
    typeof event.d.traceId === "string" && event.d.traceId.length > 0
      ? event.d.traceId
      : undefined;
  if (traceId) {
    const existing = traceSessions.get(traceId);
    if (existing) return existing;
  }

  const resourceAttrs = otlpResourceAttrs(event);
  const serviceName =
    typeof event.d.serviceName === "string" && event.d.serviceName.length > 0
      ? event.d.serviceName
      : stringAttr(resourceAttrs, ["service.name"]);
  const environment = stringAttr(resourceAttrs, [
    "deployment.environment",
    "deployment.environment.name",
  ]);
  const bucket = Math.floor(event.t / Math.max(1, windowMs));
  const sessionId = [
    "auto",
    safeAutoSessionSegment(serviceName, "unknown-service"),
    safeAutoSessionSegment(environment, "unknown-env"),
    String(bucket),
  ].join(".");

  if (traceId) traceSessions.set(traceId, sessionId);
  return sessionId;
}

function buildOtlpAutoSessionMetadata(
  sessionId: string,
  events: BugEvent[],
): Record<string, unknown> {
  const first = events[0];
  const resourceAttrs = first ? otlpResourceAttrs(first) : {};
  const app =
    first &&
    typeof first.d.serviceName === "string" &&
    first.d.serviceName.length > 0
      ? first.d.serviceName
      : stringAttr(resourceAttrs, ["service.name"]);
  return removeUndefined({
    source: "otlp",
    otlpAutoSession: true,
    tenant: stringAttr(resourceAttrs, ["crumbtrail.tenant.id"]),
    projectId: stringAttr(resourceAttrs, ["crumbtrail.project.id"]),
    app,
    release: stringAttr(resourceAttrs, ["service.version"]),
    environment: stringAttr(resourceAttrs, [
      "deployment.environment",
      "deployment.environment.name",
    ]),
    build: stringAttr(resourceAttrs, [
      "service.build.id",
      "service.build.version",
      "git.commit.sha",
      "vcs.ref.head.revision",
      "commit.sha",
      "git.sha",
    ]),
    otlpAutoSessionId: sessionId,
  });
}

function ingestOtelEvents(
  sessions: SessionManager,
  events: BugEvent[],
  maxSessionEventBytes: number,
  options?: {
    autoSessionWindowMs?: number;
    traceSessions?: OtlpTraceSessionCache;
    /**
     * Called once per session after its events were successfully appended
     * (fast-finalize hook). Must not throw into the ingest path.
     */
    onIngested?: (sessionId: string, events: BugEvent[]) => void;
  },
): { ingested: number; skipped: number; truncatedSessions?: number } {
  let ingested = 0;
  let skipped = 0;
  let truncatedSessions = 0;
  const bySession = new Map<string, BugEvent[]>();
  const autoSessions = new Set<string>();
  const windowMs =
    options?.autoSessionWindowMs ?? DEFAULT_OTLP_AUTO_SESSION_WINDOW_MS;
  const traceSessions =
    options?.traceSessions ??
    new BoundedTraceSessionCache(DEFAULT_OTLP_TRACE_SESSION_CACHE);
  for (const event of events) {
    const hasExplicitSession =
      typeof event.sessionId === "string" && event.sessionId.length > 0;
    const sessionId = hasExplicitSession
      ? (event.sessionId as string)
      : autoSessionIdForEvent(event, windowMs, traceSessions);
    if (!hasExplicitSession) autoSessions.add(sessionId);
    const assignedEvent = event.sessionId ? event : { ...event, sessionId };
    const list = bySession.get(sessionId) ?? [];
    list.push(assignedEvent);
    bySession.set(sessionId, list);
  }
  for (const [sessionId, list] of bySession) {
    try {
      let dir = sessions.getExistingSessionDir(sessionId);
      if (!dir) {
        sessions.create(
          sessionId,
          autoSessions.has(sessionId)
            ? buildOtlpAutoSessionMetadata(sessionId, list)
            : { source: "otlp" },
        );
        dir = sessions.getSessionDir(sessionId);
      }
      const result = appendEvents(dir, list, {
        maxEventBytes: maxSessionEventBytes,
      });
      ingested += result.accepted;
      skipped += result.dropped;
      if (result.truncated) truncatedSessions += 1;
      options?.onIngested?.(sessionId, list);
    } catch (err) {
      // An OTLP-supplied crumbtrail.session.id can be any string; an invalid one is
      // unresolvable and is skipped (same as an absent session id), never a 500.
      if (isInvalidSessionIdError(err)) {
        skipped += list.length;
        continue;
      }
      throw err;
    }
  }
  return {
    ingested,
    skipped,
    ...(truncatedSessions > 0 ? { truncatedSessions } : {}),
  };
}

export function createServer(config: ServerConfig): http.Server {
  const startedAt = Date.now();
  if (config.allowRemoteApi === true && !config.authToken) {
    throw new Error("Remote API mode requires authToken");
  }

  const sessions = new SessionManager({
    outputDir: config.outputDir,
    whisperModel: config.whisperModel,
    postProcess: config.postProcess,
  });

  const bugsDir = path.join(path.dirname(config.outputDir), "bugs");
  const bugQueue = new BugQueueManager({
    bugsDir,
    whisperModel: config.whisperModel,
  });

  const maxJsonBodyBytes =
    config.maxJsonBodyBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  const maxEventBatchSize =
    config.maxEventBatchSize ?? DEFAULT_MAX_EVENT_BATCH_SIZE;
  const maxSessionEventBytes =
    config.maxSessionEventBytes ?? DEFAULT_MAX_SESSION_EVENT_BYTES;
  const maxBlobBytes = config.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  const allowRemoteApi = config.allowRemoteApi === true;
  const otlpAutoSessionWindowMs =
    config.otlpAutoSessionWindowMs ?? DEFAULT_OTLP_AUTO_SESSION_WINDOW_MS;
  const otlpTraceSessions = new BoundedTraceSessionCache(
    config.maxOtlpTraceSessionCache ?? DEFAULT_OTLP_TRACE_SESSION_CACHE,
  );

  // Post-finalize side effect shared by the idle sweeper and the fast
  // finalizer: schedule the AI opinion pass when opted in. The session dir is
  // resolved at call time because finalize moves the directory.
  const scheduleSessionAiDiagnosis = (sessionId: string): void => {
    if (!config.ai?.enabled) return;
    const sessionDir = sessions.getExistingSessionDir(sessionId);
    if (sessionDir)
      scheduleAiDiagnosis(sessionDir, config.ai as AiDiagnosisConfig);
  };

  // Throw-safe wrapper for config.onSessionFinalized: an embedder hook
  // failure must never break a finalize path.
  const emitSessionFinalized = (
    sessionId: string,
    refinalized: boolean,
  ): void => {
    try {
      config.onSessionFinalized?.(sessionId, { refinalized });
    } catch (err) {
      console.error(
        `[crumbtrail-node] onSessionFinalized hook failed for ${sessionId}`,
        err,
      );
    }
  };

  // Shared post-finalize callback for the background finalizers (sweeper +
  // fast finalizer). The AI opinion pass is scheduled first so a throwing embedder
  // hook can never suppress it; the emit itself is try/caught above.
  const onBackgroundFinalized = (
    sessionId: string,
    refinalized: boolean,
  ): void => {
    scheduleSessionAiDiagnosis(sessionId);
    emitSessionFinalized(sessionId, refinalized);
  };

  // Severity-triggered fast finalize: high-severity ingest events schedule a
  // debounced checkpoint-finalize (see fast-finalize.ts). Default ON, like
  // the sweeper; `enabled: false` is the opt-out/test seam — when disabled no
  // scheduler exists, so no timers run and no ingest hooks fire. All its
  // timers are unref'd; stopped on server close below.
  const fastFinalizer: FastFinalizeHandle | undefined =
    config.fastFinalize?.enabled !== false
      ? startFastFinalizer({
          sessions,
          debounceMs: config.fastFinalize?.debounceMs,
          maxConcurrent: config.fastFinalize?.maxConcurrent,
          cooldownMs: config.fastFinalize?.cooldownMs,
          onFinalized: onBackgroundFinalized,
        })
      : undefined;

  const server = http.createServer(async (req, res) => {
    setCors(req, res, config.allowedOrigins);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url || "";
    const urlPath = url.split("?", 1)[0];

    try {
      if (req.method === "GET" && urlPath === "/health") {
        const healthOptions = {
          startedAt,
          host: req.headers.host?.split(":", 1)[0],
        };
        const loopback = isLoopbackRequest(req);
        const authorized = config.authToken
          ? isAuthorized(req, config.authToken)
          : loopback;
        if ((allowRemoteApi || loopback) && authorized) {
          json(res, 200, buildHealthPayload(config, healthOptions));
          return;
        }
        json(res, 200, buildPublicHealthPayload(config, healthOptions));
        return;
      }

      // @stability internal — @internal contract marker (decision #8): every /api/* route on this
      // inner self-host server is an INTERNAL surface — loopback-gated,
      // consumed by the local SDK/CLI and (in cloud deployments) the cloud
      // gateway via forwardToInner. Route paths here may collide with cloud
      // gateway paths (e.g. /api/bugs) with different semantics; that is
      // intentional and NOT a public-contract conflict. Do not document these
      // as public API.
      if (
        urlPath.startsWith("/api/") &&
        req.method === "POST" &&
        !allowRemoteApi &&
        !isLoopbackRequest(req)
      ) {
        jsonError(
          res,
          403,
          "Remote API writes are disabled by default",
          "permission_denied",
          false,
        );
        return;
      }

      if (urlPath.startsWith("/api/") && !isAuthorized(req, config.authToken)) {
        jsonError(res, 401, "Unauthorized", "permission_denied", false);
        return;
      }

      if (req.method === "GET" && urlPath === "/api/sessions") {
        if (!allowRemoteApi && !isLoopbackRequest(req)) {
          jsonError(
            res,
            403,
            "Remote session reads are disabled by default",
            "permission_denied",
            false,
          );
          return;
        }
        json(res, 200, sessions.listSummaries());
        return;
      }

      const sessionPageMatch = urlPath.match(
        /^\/sessions\/([^/]+)(?:\/(.+))?$/,
      );
      if (req.method === "GET" && sessionPageMatch) {
        if (!allowRemoteApi && !isLoopbackRequest(req)) {
          jsonError(
            res,
            403,
            "Remote session reads are disabled by default",
            "permission_denied",
            false,
          );
          return;
        }
        if (!requireAuthorized(req, res, config.authToken)) return;

        const sessionId = decodeURIComponent(sessionPageMatch[1]);
        const sessionDir = getExistingSessionDirOrThrow(sessions, sessionId);

        const artifactName = sessionPageMatch[2]
          ? decodeURIComponent(sessionPageMatch[2])
          : undefined;
        if (artifactName) {
          serveSessionArtifact(res, sessionDir, artifactName);
          return;
        }

        if (config.staticDir && serveSpaShell(res, config.staticDir)) {
          return;
        }

        text(
          res,
          200,
          renderSessionPage(
            sessionId,
            sessionDir,
            buildPublicBaseUrl(req, config.port),
          ),
          "text/html; charset=utf-8",
        );
        return;
      }

      if (req.method === "POST" && urlPath === "/api/session/start") {
        const body = requireObjectBody(
          await readJsonBody(req, maxJsonBodyBytes),
        );
        try {
          sessions.create(
            String(body.sessionId ?? ""),
            isRecord(body.metadata) ? body.metadata : {},
          );
        } catch (err) {
          if (isInvalidSessionIdError(err)) {
            jsonError(
              res,
              400,
              "Invalid sessionId",
              "invalid_session_id",
              false,
            );
            return;
          }
          if (isSessionAlreadyExistsError(err)) {
            jsonError(
              res,
              409,
              "Session already exists",
              "session_exists",
              false,
            );
            return;
          }
          throw err;
        }
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && urlPath === "/api/session/end") {
        const body = requireObjectBody(
          await readJsonBody(req, maxJsonBodyBytes),
        );
        try {
          const sessionId = String(body.sessionId ?? "");
          getExistingSessionDirOrThrow(sessions, sessionId);
          const finalization = await sessions.finalize(sessionId);
          // Explicit /api/session/end is always a first finalization from the
          // hook's perspective; emitted before the response is written.
          emitSessionFinalized(finalization.sessionId, false);
          const sessionDir = sessions.getSessionDir(finalization.sessionId);
          const response = {
            ...finalization,
            ...sessionLocation(
              req,
              config.port,
              finalization.sessionId,
              sessionDir,
            ),
          };
          if (config.ai?.enabled) {
            res.once("finish", () =>
              scheduleAiDiagnosis(sessionDir, config.ai as AiDiagnosisConfig),
            );
          }
          json(res, 200, response);
          return;
        } catch (err) {
          if (err instanceof RequestValidationError) throw err;
          if (isInvalidSessionIdError(err)) {
            jsonError(
              res,
              400,
              "Invalid sessionId",
              "invalid_session_id",
              false,
            );
            return;
          }
          if (isMissingOrCorruptMetaError(err)) {
            jsonError(
              res,
              409,
              "Session metadata is missing or corrupt",
              "finalize_failed",
              false,
            );
            return;
          }
          throw err;
        }
      }

      if (req.method === "POST" && urlPath === "/api/events") {
        const body = requireObjectBody(
          await readJsonBody(req, maxJsonBodyBytes),
        );
        const events = body.events;
        if (!Array.isArray(events)) {
          jsonError(
            res,
            400,
            "events must be an array",
            "invalid_events",
            false,
          );
          return;
        }
        if (events.length > maxEventBatchSize) {
          jsonError(
            res,
            413,
            "Too many events in one batch",
            "request_too_large",
            false,
          );
          return;
        }
        const sessionDir = getExistingSessionDirOrThrow(
          sessions,
          body.sessionId,
        );
        let validatedEvents: BugEvent[];
        try {
          validatedEvents = validateAndNormalizeEvents(events);
        } catch (err) {
          if (err instanceof RequestValidationError) {
            jsonError(
              res,
              err.status,
              err.publicMessage,
              err.code,
              err.retryable,
            );
            return;
          }
          throw err;
        }
        const append = appendEvents(sessionDir, validatedEvents, {
          maxEventBytes: maxSessionEventBytes,
        });
        // Fast-finalize hook, after the successful append only. notifyIngest
        // never throws into the request path (classification/scheduling
        // errors are logged to stderr inside the handle). body.sessionId is a
        // string here — getExistingSessionDirOrThrow rejected anything else.
        fastFinalizer?.notifyIngest(body.sessionId as string, validatedEvents);
        json(res, 200, { ok: true, ...append });
        return;
      }

      // Inner incident-assembly endpoint. Falls under the /api/ auth +
      // remote-write gates above (no new auth scheme). Given a ticket symptom,
      // it runs the shared locate/assemble engine against this server's session
      // store and returns the pinned { bundle, match } envelope the cloud
      // webhook writer (CP4) persists verbatim. Read-only: no session is written.
      if (req.method === "POST" && urlPath === "/api/solve-context") {
        const body = requireObjectBody(
          await readJsonBody(req, maxJsonBodyBytes),
        );
        if (!isRecord(body.symptom) || typeof body.symptom.title !== "string") {
          jsonError(
            res,
            400,
            "symptom.title is required",
            "invalid_symptom",
            false,
          );
          return;
        }
        const symptom = body.symptom as unknown as Symptom;
        const rawOptions = isRecord(body.options) ? body.options : {};
        const opts: {
          threshold?: number;
          margin?: number;
          accountId?: string;
          now?: number;
          ticketCreatedAt?: number;
          tenantId?: string;
          projectId?: string;
        } = {};
        if (typeof rawOptions.threshold === "number") {
          opts.threshold = rawOptions.threshold;
        }
        if (typeof rawOptions.margin === "number") {
          opts.margin = rawOptions.margin;
        }
        if (typeof rawOptions.accountId === "string") {
          opts.accountId = rawOptions.accountId;
        }
        if (typeof rawOptions.now === "number") opts.now = rawOptions.now;
        // Ticket created-time anchors the sessionless (Mode A) fallback window to
        // when the incident was reported rather than "now", so a ticket solved
        // days later still scans the right span. Threaded from the cloud webhook,
        // which has it on the Jira issue; absent ⇒ gatherAdapterEvidence uses now.
        if (typeof rawOptions.ticketCreatedAt === "number") {
          opts.ticketCreatedAt = rawOptions.ticketCreatedAt;
        }
        if (typeof rawOptions.tenantId === "string") {
          opts.tenantId = rawOptions.tenantId;
        }
        if (typeof rawOptions.projectId === "string") {
          opts.projectId = rawOptions.projectId;
        }
        const factorySources = config.evidenceSourcesFactory
          ? await config.evidenceSourcesFactory({
              tenantId: opts.tenantId,
              projectId: opts.projectId,
            })
          : undefined;
        const { bundle, match, sources } = await locateAndAssemble(
          symptom,
          buildRecallStore(config.outputDir),
          {
            ...opts,
            // An array, including [], owns source construction and blocks the
            // environment fallback. Undefined is the explicit legacy opt in.
            ...(factorySources === undefined
              ? {}
              : { sources: factorySources }),
          },
        );
        // `sources` is the per-source health summary (provider + ok + sanitized
        // error) the cloud webhook records as connector success/failure. Advisory.
        json(res, 200, { bundle, match, sources });
        return;
      }

      if (
        req.method === "POST" &&
        (urlPath === "/v1/traces" || urlPath === "/v1/logs")
      ) {
        if (!allowRemoteApi && !isLoopbackRequest(req)) {
          jsonError(
            res,
            403,
            "Remote OTLP ingest is disabled",
            "remote_disabled",
            false,
          );
          return;
        }
        if (!isAuthorized(req, config.authToken)) {
          jsonError(res, 401, "Unauthorized", "unauthorized", false);
          return;
        }
        const body = await readOtlpBody(
          req,
          maxJsonBodyBytes,
          urlPath === "/v1/traces" ? "traces" : "logs",
        );
        const events =
          urlPath === "/v1/traces"
            ? convertOtlpTraceToEvents(
                body as Parameters<typeof convertOtlpTraceToEvents>[0],
              )
            : convertOtlpLogsToEvents(
                body as Parameters<typeof convertOtlpLogsToEvents>[0],
              );
        if (events.length > maxEventBatchSize) {
          jsonError(
            res,
            413,
            "Too many events in one batch",
            "request_too_large",
            false,
          );
          return;
        }
        const result = ingestOtelEvents(
          sessions,
          events,
          maxSessionEventBytes,
          {
            autoSessionWindowMs: otlpAutoSessionWindowMs,
            traceSessions: otlpTraceSessions,
            ...(fastFinalizer
              ? {
                  onIngested: (sessionId: string, ingested: BugEvent[]) =>
                    fastFinalizer.notifyIngest(sessionId, ingested),
                }
              : {}),
          },
        );
        json(res, 200, { ok: true, ...result });
        return;
      }

      const blobMatch = urlPath.match(/^\/api\/blob\/(.+)$/);
      if (req.method === "POST" && blobMatch) {
        const name = decodeUrlPathSegment(blobMatch[1]);
        if (!name || !ALLOWED_BLOB_ARTIFACT_NAMES.has(name)) {
          jsonError(res, 400, "Invalid blob name", "invalid_blob_name", false);
          return;
        }
        const sessionId = req.headers["x-session-id"];
        const sessionDir = getExistingSessionDirOrThrow(
          sessions,
          Array.isArray(sessionId) ? sessionId[0] : sessionId,
        );
        const data = await readBody(req, maxBlobBytes);
        assertWritableArtifactPath(sessionDir, path.join(sessionDir, name));
        writeBlob(sessionDir, name, data);
        writeAudioUploadMetadata(req, sessionDir, name, data);
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && urlPath === "/api/bug/flag") {
        const body = requireObjectBody(
          await readJsonBody(req, maxJsonBodyBytes),
        );
        const report = isRecord(body.report)
          ? (body.report as unknown as BugReport)
          : undefined;
        if (!report) {
          jsonError(
            res,
            400,
            "Invalid bug report",
            "invalid_bug_report",
            false,
          );
          return;
        }
        try {
          await bugQueue.create(
            report,
            Array.isArray(body.events) ? (body.events as BugEvent[]) : [],
          );
        } catch (err) {
          if (isInvalidBugIdError(err)) {
            jsonError(res, 400, "Invalid bugId", "invalid_bug_id", false);
            return;
          }
          if (isBugAlreadyExistsError(err)) {
            jsonError(res, 409, "Bug already exists", "bug_exists", false);
            return;
          }
          if (isInvalidArtifactPathError(err)) {
            jsonError(
              res,
              400,
              "Invalid artifact path",
              "invalid_artifact_path",
              false,
            );
            return;
          }
          throw err;
        }
        json(res, 200, { ok: true, bugId: report.bugId });
        return;
      }

      const bugVoiceMatch = urlPath.match(/^\/api\/bug\/([^/]+)\/voice$/);
      if (req.method === "POST" && bugVoiceMatch) {
        const bugId = bugVoiceMatch[1];
        let ok = false;
        try {
          if (!isTrustedBrowserWrite(req, config.allowedOrigins)) {
            jsonError(
              res,
              403,
              "Cross-origin raw uploads are not allowed",
              "permission_denied",
              false,
            );
            return;
          }
          if (!hasAllowedRawUploadContentType(req)) {
            jsonError(
              res,
              415,
              "Expected binary audio upload",
              "invalid_content_type",
              false,
            );
            return;
          }
          const existingBug = bugQueue.get(bugId);
          if (!existingBug) {
            jsonError(res, 404, "Bug not found", "not_found", false);
            return;
          }
          const bugDir = bugQueue.getBugDir(bugId);
          assertWritableArtifactPath(bugDir, path.join(bugDir, "voice.webm"));
          assertWritableArtifactPath(bugDir, path.join(bugDir, "audio.webm"));
          const data = await readBody(req, maxBlobBytes);
          ok = await bugQueue.writeVoice(bugId, data);
        } catch (err) {
          if (isInvalidBugIdError(err)) {
            jsonError(res, 400, "Invalid bugId", "invalid_bug_id", false);
            return;
          }
          if (isInvalidArtifactPathError(err)) {
            jsonError(
              res,
              400,
              "Invalid artifact path",
              "invalid_artifact_path",
              false,
            );
            return;
          }
          throw err;
        }
        if (!ok) {
          jsonError(res, 404, "Bug not found", "not_found", false);
          return;
        }
        json(res, 200, { ok: true });
        return;
      }

      if (req.method === "GET" && urlPath === "/api/bugs") {
        if (!allowRemoteApi && !isLoopbackRequest(req)) {
          jsonError(
            res,
            403,
            "Remote bug reads are disabled by default",
            "permission_denied",
            false,
          );
          return;
        }
        const bugs = bugQueue.list();
        json(res, 200, bugs);
        return;
      }

      const bugLlmMatch = urlPath.match(/^\/api\/bug\/([^/]+)\/llm$/);
      if (req.method === "GET" && bugLlmMatch) {
        if (!allowRemoteApi && !isLoopbackRequest(req)) {
          jsonError(
            res,
            403,
            "Remote bug reads are disabled by default",
            "permission_denied",
            false,
          );
          return;
        }
        let context = null;
        try {
          context = bugQueue.getLlmContext(bugLlmMatch[1]);
        } catch {
          jsonError(res, 400, "Invalid bugId", "invalid_bug_id", false);
          return;
        }
        if (!context) {
          jsonError(res, 404, "Bug not found", "not_found", false);
          return;
        }
        json(res, 200, context);
        return;
      }

      if (
        req.method === "GET" &&
        config.staticDir &&
        serveStatic(res, config.staticDir, urlPath)
      ) {
        return;
      }

      // SPA fallback: serve index.html for unmatched client routes (no file extension,
      // not /api/*) so the dashboard can own routes like /bugs. Missing assets with an
      // extension still 404 below.
      if (
        req.method === "GET" &&
        config.staticDir &&
        looksLikeClientRoute(urlPath) &&
        serveSpaShell(res, config.staticDir)
      ) {
        return;
      }

      jsonError(res, 404, "Not found", "not_found", false);
    } catch (err) {
      if (err instanceof RequestValidationError) {
        jsonError(res, err.status, err.publicMessage, err.code, err.retryable);
        return;
      }
      jsonError(res, 500, "Internal server error", "unknown", true);
    }
  });

  // Idle-session sweeper: finalizes sessions whose producers never call
  // /api/session/end (autoCapture backends, OTLP auto-sessions). mtime-based,
  // so a pre-existing backlog is swept after boot without any in-memory state.
  // The unref'd timer never keeps the process alive; stopped on server close.
  if (config.sessionSweep?.enabled !== false) {
    const sweeper = startSessionSweeper({
      sessions,
      outputDir: config.outputDir,
      idleMs: config.sessionSweep?.idleMs,
      checkpointMs: config.sessionSweep?.checkpointMs,
      intervalMs: config.sessionSweep?.intervalMs,
      maxPerSweep: config.sessionSweep?.maxPerSweep,
      onFinalized: onBackgroundFinalized,
      onSweep: (result) => {
        console.log(
          `[crumbtrail-node] session sweep: ${JSON.stringify(result)}`,
        );
      },
    });
    server.on("close", () => sweeper.stop());
  }

  if (config.ai?.enabled && config.ai.backfillOnStart) {
    const sessionDirs = sessions
      .listSummaries()
      .map((summary) => sessions.getExistingSessionDir(summary.id))
      .filter((dir): dir is string => dir !== undefined);
    const timer = setTimeout(() => {
      void backfillAiDiagnoses(
        sessionDirs,
        config.ai as AiDiagnosisConfig,
      ).then((result) =>
        config.ai?.log?.(
          `Crumbtrail AI opinion backfill complete: ${JSON.stringify(result)}`,
        ),
      );
    }, 0);
    server.on("close", () => clearTimeout(timer));
  }

  if (fastFinalizer) {
    server.on("close", () => fastFinalizer.stop());
  }

  if (config.ai?.enabled && config.ai.backfillOnStart) {
    const sessionDirs = sessions
      .listSummaries()
      .map((summary) => sessions.getExistingSessionDir(summary.id))
      .filter((dir): dir is string => dir !== undefined);
    const timer = setTimeout(() => {
      void backfillAiDiagnoses(
        sessionDirs,
        config.ai as AiDiagnosisConfig,
      ).then((result) =>
        config.ai?.log?.(
          `Crumbtrail AI opinion backfill complete: ${JSON.stringify(result)}`,
        ),
      );
    }, 0);
    server.on("close", () => clearTimeout(timer));
  }

  return server;
}

function decodeUrlPathSegment(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
