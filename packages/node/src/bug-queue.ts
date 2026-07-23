import fs from "node:fs";
import path from "node:path";
import type { BugEvent } from "crumbtrail-core";
import { redactTokenLikeString, redactUrl } from "crumbtrail-core";
import { appendEvents } from "./writer";
import { postProcess } from "./post-process";

export interface BugReport {
  bugId: string;
  sessionId: string;
  flaggedAt: number;
  windowMs: number;
  note?: string;
  voiceNote?: string;
  url: string;
  userAgent: string;
  tags?: string[];
  status?: "open" | "resolved";
  summary: {
    errorCount: number;
    failedRequestCount: number;
    eventCount: number;
    eventKinds: Record<string, number>;
    durationMs: number;
  };
}

export interface BugQueueConfig {
  bugsDir: string;
  whisperModel?: string;
  /** Read-only consumers must not create the queue directory on construction. */
  readOnly?: boolean;
}

interface LlmBugContext {
  v: 1;
  id: string;
  sid: string;
  ts: number;
  w: number;
  u: string;
  n?: string;
  g?: string[];
  s: {
    e: number;
    f: number;
    c: number;
    d: number;
    k: Record<string, number>;
  };
  err?: Array<{ t: number; m: string }>;
  req?: Array<{ t: number; m: string; u: string; s: number }>;
  nav?: Array<{ t: number; to: string }>;
}

const MAX_BUG_TEXT_LENGTH = 1_000;
const MAX_BUG_TAGS = 20;
const MAX_BUG_TAG_LENGTH = 64;
const MAX_EVENT_KIND_LENGTH = 80;
const MAX_EVENT_KIND_COUNT = 100;
const MAX_BUG_WINDOW_MS = 24 * 60 * 60 * 1_000;

export class BugQueueManager {
  private bugsDir: string;
  private whisperModel?: string;

  constructor(config: BugQueueConfig) {
    this.bugsDir = config.bugsDir;
    this.whisperModel = config.whisperModel;
    if (!config.readOnly) fs.mkdirSync(this.bugsDir, { recursive: true });
  }

  async create(report: BugReport, events: BugEvent[]): Promise<void> {
    const safeReport = sanitizeBugReport(report);
    const bugDir = this.resolveBugDir(safeReport.bugId);
    this.assertBugDirAvailable(bugDir);
    const stagingDir = this.resolveBugStagingDir(safeReport.bugId);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.mkdirSync(stagingDir, { recursive: true });

    try {
      // Write report.json
      const reportWithStatus = { ...safeReport, status: "open" as const };
      writeFileNoSymlink(
        stagingDir,
        "report.json",
        JSON.stringify(reportWithStatus, null, 2),
      );

      // Write events.ndjson
      await appendEvents(stagingDir, events);

      // Write meta.json for post-process compatibility
      const meta = {
        id: safeReport.bugId,
        start: safeReport.flaggedAt - safeReport.windowMs,
        end: safeReport.flaggedAt,
      };
      writeFileNoSymlink(
        stagingDir,
        "meta.json",
        JSON.stringify(meta, null, 2),
      );
      fs.mkdirSync(path.join(stagingDir, "frames"), { recursive: true });

      // Post-process to generate index.json
      await postProcess(stagingDir, this.whisperModel);
      this.writeLlmContextForDir(reportWithStatus, stagingDir);
      this.assertBugDirAvailable(bugDir);
      fs.renameSync(stagingDir, bugDir);
    } catch (err) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
      throw err;
    }
  }

  async writeVoice(bugId: string, data: Buffer): Promise<boolean> {
    const report = this.get(bugId);
    if (!report) return false;
    const bugDir = this.resolveBugDir(bugId);
    this.assertSafeBugDir(bugDir);
    writeFileNoSymlink(bugDir, "voice.webm", data);
    // Keep compatibility with post-process audio handling.
    writeFileNoSymlink(bugDir, "audio.webm", data);
    await postProcess(bugDir, this.whisperModel);
    this.writeLlmContext(report);
    return true;
  }

  list(filters?: {
    after?: number;
    before?: number;
    status?: string;
    tags?: string[];
  }): BugReport[] {
    if (!fs.existsSync(this.bugsDir)) return [];
    const entries = fs.readdirSync(this.bugsDir, { withFileTypes: true });
    const bugs: BugReport[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const bugDir = this.resolveBugDir(entry.name);
      try {
        this.assertSafeBugDir(bugDir);
      } catch {
        continue;
      }
      const reportPath = safeRegularFilePath(
        bugDir,
        path.join(bugDir, "report.json"),
      );
      if (!reportPath) continue;
      try {
        const report: BugReport = JSON.parse(
          fs.readFileSync(reportPath, "utf-8"),
        );
        if (filters?.after && report.flaggedAt < filters.after) continue;
        if (filters?.before && report.flaggedAt > filters.before) continue;
        if (filters?.status && report.status !== filters.status) continue;
        if (filters?.tags && filters.tags.length > 0) {
          const reportTags = report.tags || [];
          if (!filters.tags.some((t) => reportTags.includes(t))) continue;
        }
        bugs.push(report);
      } catch {
        continue;
      }
    }
    return bugs.sort((a, b) => b.flaggedAt - a.flaggedAt);
  }

  get(bugId: string): BugReport | null {
    const bugDir = this.resolveBugDir(bugId);
    if (!fs.existsSync(bugDir)) return null;
    this.assertSafeBugDir(bugDir);
    const reportPath = path.join(bugDir, "report.json");
    const safePath = safeRegularFilePath(bugDir, reportPath);
    if (!safePath) return null;
    return JSON.parse(fs.readFileSync(safePath, "utf-8"));
  }

  getBugDir(bugId: string): string {
    const bugDir = this.resolveBugDir(bugId);
    this.assertSafeBugDir(bugDir);
    return bugDir;
  }

  resolve(bugId: string): void {
    const bugDir = this.resolveBugDir(bugId);
    if (!fs.existsSync(bugDir)) return;
    this.assertSafeBugDir(bugDir);
    const reportPath = path.join(bugDir, "report.json");
    const safePath = safeRegularFilePath(bugDir, reportPath);
    if (!safePath) return;
    const report = JSON.parse(fs.readFileSync(safePath, "utf-8"));
    report.status = "resolved";
    writeFileNoSymlink(bugDir, "report.json", JSON.stringify(report, null, 2));
    this.writeLlmContext(report);
  }

  getLlmContext(bugId: string): LlmBugContext | null {
    const bugDir = this.resolveBugDir(bugId);
    if (!fs.existsSync(bugDir)) return null;
    this.assertSafeBugDir(bugDir);
    const llmPath = path.join(bugDir, "llm.json");
    const safePath = safeRegularFilePath(bugDir, llmPath);
    if (!safePath) return null;
    return JSON.parse(fs.readFileSync(safePath, "utf-8"));
  }

  private resolveBugDir(bugId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(bugId)) {
      throw new Error("Invalid bugId");
    }
    const resolved = path.resolve(this.bugsDir, bugId);
    if (!resolved.startsWith(path.resolve(this.bugsDir) + path.sep)) {
      throw new Error("Invalid bugId");
    }
    return resolved;
  }

  private resolveBugStagingDir(bugId: string): string {
    const stagingName = `.${bugId}.${process.pid}.${Date.now()}.tmp`;
    const resolved = path.resolve(this.bugsDir, stagingName);
    if (!resolved.startsWith(path.resolve(this.bugsDir) + path.sep)) {
      throw new Error("Invalid bugId");
    }
    return resolved;
  }

  private assertBugDirAvailable(bugDir: string): void {
    if (!fs.existsSync(bugDir)) return;
    this.assertSafeBugDir(bugDir);
    throw new Error("Bug already exists");
  }

  private assertSafeBugDir(bugDir: string): void {
    try {
      const stat = fs.lstatSync(bugDir);
      if (stat.isSymbolicLink() || !stat.isDirectory())
        throw new Error("Invalid bug artifact path");
      const root = fs.realpathSync(path.resolve(this.bugsDir));
      const realDir = fs.realpathSync(bugDir);
      if (realDir === root || !realDir.startsWith(root + path.sep)) {
        throw new Error("Invalid bug artifact path");
      }
    } catch (err) {
      if (
        err instanceof Error &&
        err.message.includes("Invalid bug artifact path")
      )
        throw err;
      throw new Error("Invalid bug artifact path");
    }
  }

  private writeLlmContext(report: BugReport): void {
    const bugDir = this.resolveBugDir(report.bugId);
    this.assertSafeBugDir(bugDir);
    this.writeLlmContextForDir(report, bugDir);
  }

  private writeLlmContextForDir(report: BugReport, bugDir: string): void {
    const indexPath = safeRegularFilePath(
      bugDir,
      path.join(bugDir, "index.json"),
    );
    if (!indexPath) return;
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    const context: LlmBugContext = {
      v: 1,
      id: report.bugId,
      sid: report.sessionId,
      ts: report.flaggedAt,
      w: report.windowMs,
      u: report.url,
      n: report.note,
      g: report.tags,
      s: {
        e: report.summary.errorCount,
        f: report.summary.failedRequestCount,
        c: report.summary.eventCount,
        d: report.summary.durationMs,
        k: report.summary.eventKinds,
      },
      err: (index.errs || [])
        .slice(0, 10)
        .map((e: { t: number; msg: string }) => ({
          t: e.t,
          m: e.msg,
        })),
      req: (index.failedReqs || [])
        .slice(0, 10)
        .map((r: { t: number; m: string; url: string; st: number }) => ({
          t: r.t,
          m: r.m,
          u: r.url,
          s: r.st,
        })),
      nav: (index.navs || [])
        .slice(0, 10)
        .map((n: { t: number; to: string }) => ({
          t: n.t,
          to: n.to,
        })),
    };
    writeFileNoSymlink(bugDir, "llm.json", JSON.stringify(context));
  }
}

function sanitizeBugReport(report: BugReport): BugReport {
  return {
    bugId: boundedPlainString(report.bugId, MAX_BUG_TEXT_LENGTH),
    sessionId: boundedPlainString(report.sessionId, MAX_BUG_TEXT_LENGTH),
    flaggedAt: finiteNumber(report.flaggedAt, Date.now()),
    windowMs: clampNumber(report.windowMs, 0, MAX_BUG_WINDOW_MS),
    ...(report.note !== undefined
      ? { note: sanitizeText(report.note, "bug.note") }
      : {}),
    ...(report.voiceNote !== undefined
      ? { voiceNote: sanitizeText(report.voiceNote, "bug.voiceNote") }
      : {}),
    url: sanitizeUrl(report.url),
    userAgent: sanitizeText(report.userAgent, "bug.userAgent"),
    ...(report.tags ? { tags: sanitizeTags(report.tags) } : {}),
    summary: sanitizeSummary(report.summary),
  };
}

function sanitizeSummary(summary: BugReport["summary"]): BugReport["summary"] {
  const eventKinds: Record<string, number> = {};
  for (const [rawKind, rawCount] of Object.entries(
    summary?.eventKinds ?? {},
  ).slice(0, MAX_EVENT_KIND_COUNT)) {
    const kind = boundedPlainString(rawKind, MAX_EVENT_KIND_LENGTH);
    if (!kind) continue;
    eventKinds[kind] = nonNegativeInteger(rawCount);
  }

  return {
    errorCount: nonNegativeInteger(summary?.errorCount),
    failedRequestCount: nonNegativeInteger(summary?.failedRequestCount),
    eventCount: nonNegativeInteger(summary?.eventCount),
    eventKinds,
    durationMs: nonNegativeNumber(summary?.durationMs),
  };
}

function sanitizeTags(tags: string[]): string[] {
  return tags
    .filter((tag): tag is string => typeof tag === "string")
    .map((tag) => sanitizeText(tag, "bug.tag").slice(0, MAX_BUG_TAG_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_BUG_TAGS);
}

function sanitizeUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  return boundedPlainString(
    redactUrl(value, "bug.url").value,
    MAX_BUG_TEXT_LENGTH,
  );
}

function sanitizeText(value: unknown, field: string): string {
  if (typeof value !== "string") return "";
  return boundedPlainString(
    redactTokenLikeString(value, field).value,
    MAX_BUG_TEXT_LENGTH,
  );
}

function boundedPlainString(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    .slice(0, maxLength);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegativeNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : 0;
}

function nonNegativeInteger(value: unknown): number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0
    ? value
    : 0;
}

function clampNumber(value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function writeFileNoSymlink(
  rootDir: string,
  name: string,
  data: string | Buffer,
): void {
  try {
    const filePath = path.join(rootDir, name);
    const root = fs.realpathSync(rootDir);
    const parent = fs.realpathSync(path.dirname(filePath));
    if (parent !== root && !parent.startsWith(root + path.sep))
      throw new Error("Invalid bug artifact path");
    if (fs.lstatSync(filePath).isSymbolicLink())
      throw new Error("Invalid bug artifact path");
    fs.writeFileSync(filePath, data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      fs.writeFileSync(path.join(rootDir, name), data);
      return;
    }
    if (
      err instanceof Error &&
      err.message.includes("Invalid bug artifact path")
    )
      throw err;
    throw new Error("Invalid bug artifact path");
  }
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
