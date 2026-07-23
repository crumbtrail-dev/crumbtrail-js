import fs from "node:fs";
import path from "node:path";
import { buildFixContext, type FixContext } from "./fix-context";
import { defaultSessionStore } from "./session-store";

export interface AiDiagnosisConfig {
  enabled: boolean;
  apiKey?: string;
  model?: string;
  allowAutoModel?: boolean;
  maxPromptBytes?: number;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
  /** Diagnose finalized sessions already on disk when the server starts. */
  backfillOnStart?: boolean;
  /** Bounded provider concurrency for startup backfill. Default 2. */
  backfillConcurrency?: number;
}

export interface AiDiagnosisResult {
  ok: boolean;
  skipped?:
    | "opt_in_disabled"
    | "missing_key"
    | "no_candidates"
    | "already_exists"
    | "in_progress";
  error?: string;
}

export interface AiDiagnosisBackfillResult {
  checked: number;
  generated: number;
  skipped: number;
  failed: number;
}

const DEFAULT_MODEL = "deepseek/deepseek-v4-flash";
const DEFAULT_MAX_PROMPT_BYTES = 180_000;
const OPINION_PROMPT_REVISION = "opinion.v1";
const inFlightDiagnosisDirs = new Set<string>();
const queuedDiagnosisDirs = new Set<string>();

interface DiagnosisQueueItem {
  sessionDir: string;
  key: string;
  resolve: (result: AiDiagnosisResult) => void;
}

interface DiagnosisQueue {
  active: number;
  pending: DiagnosisQueueItem[];
  pumpScheduled: boolean;
}

export interface AiOpinionHypothesis extends Record<string, unknown> {
  rank: number;
  confidence: string;
  evidence_refs: string[];
  /**
   * Cloud code-grounded findings may carry `path:line` pointers into the
   * project's mapped repositories (cloud GitHub integration, CP5). Optional
   * and additive: absent for local opinions and for projects without code AI.
   */
  code_refs?: string[];
}

export interface AiOpinionArtifact {
  schemaVersion: "opinion.v1";
  hypotheses: AiOpinionHypothesis[];
  unknowns: string[];
}

interface OpinionPrompt {
  prompt: string;
  /** Exact user-message bytes sent to the provider, including its evidence bundle. */
  evidenceSlice: string;
  reduction: PromptReduction;
}

interface PromptDrop {
  path: string;
  reason: "prompt_byte_cap";
  omitted?: number;
  id?: string;
  characters?: number;
}

interface PromptReduction {
  mode: "none" | "deterministic_structural" | "byte_prefix";
  dropped: PromptDrop[];
}

const diagnosisQueues = new WeakMap<AiDiagnosisConfig, DiagnosisQueue>();

export async function runAiDiagnosis(
  sessionDir: string,
  config: AiDiagnosisConfig,
): Promise<AiDiagnosisResult> {
  if (!config.enabled) return { ok: true, skipped: "opt_in_disabled" };
  if (hasOpinionArtifacts(sessionDir))
    return { ok: true, skipped: "already_exists" };
  const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) return { ok: true, skipped: "missing_key" };

  try {
    const context = await buildFixContext(sessionDir);
    if (context.signals.length === 0)
      return { ok: true, skipped: "no_candidates" };

    const model = selectModel(config.model, config.allowAutoModel === true);
    const fetchImpl = config.fetchImpl ?? fetch;
    const opinionPrompt = buildPrompt(
      context,
      config.maxPromptBytes ?? DEFAULT_MAX_PROMPT_BYTES,
    );

    config.log?.(
      `Crumbtrail AI opinion enabled; sending the redacted evidence bundle to OpenRouter model ${model}.`,
    );
    const res = await fetchImpl(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You produce an advisory Crumbtrail opinion from neutral evidence. Return strict JSON only.",
            },
            { role: "user", content: opinionPrompt.prompt },
          ],
        }),
      },
    );

    if (!res.ok)
      return {
        ok: false,
        error: `OpenRouter request failed with HTTP ${res.status}`,
      };
    const payload: unknown = await res.json();
    const content = extractContent(payload);
    if (!content)
      return {
        ok: false,
        error: "OpenRouter response did not include content",
      };
    const opinion = normalizeAiOpinion(JSON.parse(content));
    await writeOpinionArtifacts(sessionDir, {
      opinionJson: `${JSON.stringify(opinion, null, 2)}\n`,
      opinionMarkdown: renderOpinionMarkdown(opinion),
      auditJson: `${JSON.stringify(
        {
          model,
          prompt: opinionPrompt.prompt,
          promptBytes: Buffer.byteLength(opinionPrompt.prompt, "utf-8"),
          // This is deliberately the exact user message captured by the
          // fetch mock and sent to the provider, rather than a reconstructed
          // object that could disagree in the byte-prefix fallback.
          evidenceSlice: opinionPrompt.evidenceSlice,
          reduction: opinionPrompt.reduction,
          promptRevision: OPINION_PROMPT_REVISION,
        },
        null,
        2,
      )}\n`,
    });
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "AI opinion failed",
    };
  }
}

export function scheduleAiDiagnosis(
  sessionDir: string,
  config: AiDiagnosisConfig,
): void {
  if (!config.enabled) return;
  void enqueueAiDiagnosis(sessionDir, config).then((result) => {
    if (!result.ok)
      config.log?.(
        `Crumbtrail AI opinion failed: ${result.error ?? "unknown error"}`,
      );
  });
}

/** Diagnose a pre-existing finalized-session backlog without an unbounded
 * provider fan-out. Existing artifacts and sessions without candidates are
 * cheap skips handled by runAiDiagnosis. */
export async function backfillAiDiagnoses(
  sessionDirs: readonly string[],
  config: AiDiagnosisConfig,
): Promise<AiDiagnosisBackfillResult> {
  const uniqueDirs = [...new Set(sessionDirs.map((dir) => path.resolve(dir)))];
  const result: AiDiagnosisBackfillResult = {
    checked: uniqueDirs.length,
    generated: 0,
    skipped: 0,
    failed: 0,
  };
  const concurrency = Math.max(
    1,
    Math.min(8, config.backfillConcurrency ?? 2, uniqueDirs.length || 1),
  );
  let next = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= uniqueDirs.length) return;
      const diagnosis = await enqueueAiDiagnosis(uniqueDirs[index]!, config);
      if (!diagnosis.ok) result.failed += 1;
      else if (diagnosis.skipped) result.skipped += 1;
      else result.generated += 1;
    }
  });
  await Promise.all(workers);
  return result;
}

function enqueueAiDiagnosis(
  sessionDir: string,
  config: AiDiagnosisConfig,
): Promise<AiDiagnosisResult> {
  const key = path.resolve(sessionDir);
  if (hasOpinionArtifacts(sessionDir))
    return Promise.resolve({ ok: true, skipped: "already_exists" });
  if (inFlightDiagnosisDirs.has(key) || queuedDiagnosisDirs.has(key)) {
    return Promise.resolve({ ok: true, skipped: "in_progress" });
  }

  let queue = diagnosisQueues.get(config);
  if (!queue) {
    queue = { active: 0, pending: [], pumpScheduled: false };
    diagnosisQueues.set(config, queue);
  }
  queuedDiagnosisDirs.add(key);
  const result = new Promise<AiDiagnosisResult>((resolve) => {
    queue!.pending.push({ sessionDir, key, resolve });
  });
  scheduleDiagnosisQueuePump(queue, config);
  return result;
}

function scheduleDiagnosisQueuePump(
  queue: DiagnosisQueue,
  config: AiDiagnosisConfig,
): void {
  if (queue.pumpScheduled) return;
  queue.pumpScheduled = true;
  setTimeout(() => {
    queue.pumpScheduled = false;
    pumpDiagnosisQueue(queue, config);
  }, 0);
}

function pumpDiagnosisQueue(
  queue: DiagnosisQueue,
  config: AiDiagnosisConfig,
): void {
  const limit = Math.max(1, Math.min(8, config.backfillConcurrency ?? 2));
  while (queue.active < limit && queue.pending.length > 0) {
    const item = queue.pending.shift()!;
    queuedDiagnosisDirs.delete(item.key);
    inFlightDiagnosisDirs.add(item.key);
    queue.active += 1;
    void runAiDiagnosis(item.sessionDir, config)
      .then(item.resolve)
      .finally(() => {
        inFlightDiagnosisDirs.delete(item.key);
        queue.active -= 1;
        pumpDiagnosisQueue(queue, config);
      });
  }
}

function hasOpinionArtifacts(sessionDir: string): boolean {
  return (
    isRegularOpinionArtifact(sessionDir, "opinion.json") &&
    isRegularOpinionArtifact(sessionDir, "opinion.audit.json")
  );
}

function isRegularOpinionArtifact(sessionDir: string, name: string): boolean {
  try {
    return fs.lstatSync(path.join(sessionDir, name)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

interface OpinionArtifacts {
  opinionJson: string;
  opinionMarkdown: string;
  auditJson: string;
}

/**
 * Publish the opinion as one complete set. The audit is made visible before
 * opinion.json, so a failure can leave only an incomplete set that a later
 * run will regenerate, never an opinion that is treated as complete without
 * its audit.
 */
async function writeOpinionArtifacts(
  sessionDir: string,
  artifacts: OpinionArtifacts,
): Promise<void> {
  const names = ["opinion.audit.json", "opinion.md", "opinion.json"] as const;
  const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const temporary = new Map(
    names.map((name) => [name, `.${name}.${nonce}.tmp`] as const),
  );

  assertSafeOpinionArtifactPaths(sessionDir, names);
  if (!hasOpinionArtifacts(sessionDir)) removeIncompleteOpinionArtifacts(sessionDir, names);

  try {
    await writeSessionFileNoSymlink(
      sessionDir,
      temporary.get("opinion.audit.json")!,
      artifacts.auditJson,
    );
    await writeSessionFileNoSymlink(
      sessionDir,
      temporary.get("opinion.md")!,
      artifacts.opinionMarkdown,
    );
    await writeSessionFileNoSymlink(
      sessionDir,
      temporary.get("opinion.json")!,
      artifacts.opinionJson,
    );

    for (const name of names) {
      const temporaryName = temporary.get(name)!;
      const temporaryPath = path.join(sessionDir, temporaryName);
      const finalPath = path.join(sessionDir, name);
      assertSafeOpinionArtifactPaths(sessionDir, [name, temporaryName]);
      fs.renameSync(temporaryPath, finalPath);
    }
    if (!hasPublishedOpinionArtifacts(sessionDir))
      throw new Error("Opinion artifacts were not published completely");
  } catch (err) {
    // Do not retain an incomplete publication. The successful set is only
    // opinion.json plus opinion.audit.json, and json is published last.
    if (!hasPublishedOpinionArtifacts(sessionDir))
      removeIncompleteOpinionArtifacts(sessionDir, names);
    if (err instanceof Error && err.message.includes("Invalid opinion artifact path"))
      throw err;
    throw new Error(`Unable to write opinion artifacts: ${errorMessage(err)}`);
  } finally {
    for (const name of temporary.values()) {
      const temporaryPath = path.join(sessionDir, name);
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
  }
}

function hasPublishedOpinionArtifacts(sessionDir: string): boolean {
  return (
    hasOpinionArtifacts(sessionDir) &&
    isRegularOpinionArtifact(sessionDir, "opinion.md")
  );
}

function assertSafeOpinionArtifactPaths(
  sessionDir: string,
  names: readonly string[],
): void {
  const root = fs.realpathSync(sessionDir);
  for (const name of names) {
    const filePath = path.join(sessionDir, name);
    const parent = fs.realpathSync(path.dirname(filePath));
    if (parent !== root && !parent.startsWith(root + path.sep))
      throw new Error("Invalid opinion artifact path");
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink())
      throw new Error("Invalid opinion artifact path");
  }
}

function removeIncompleteOpinionArtifacts(
  sessionDir: string,
  names: readonly string[],
): void {
  for (const name of names) {
    const filePath = path.join(sessionDir, name);
    if (!fs.existsSync(filePath)) continue;
    if (fs.lstatSync(filePath).isSymbolicLink())
      throw new Error("Invalid opinion artifact path");
    fs.rmSync(filePath, { recursive: true, force: true });
  }
}

// Routed through the SessionStore seam so a storage decorator (the hosted
// cloud's at-rest encryption) sees the opinion artifacts. The symlink assertion
// stays here because it also guards the staged temporary names.
async function writeSessionFileNoSymlink(
  sessionDir: string,
  name: string,
  data: string,
): Promise<void> {
  assertSafeOpinionArtifactPaths(sessionDir, [name]);
  await defaultSessionStore.writeArtifact(sessionDir, name, data);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown write failure";
}

function selectModel(
  model: string | undefined,
  allowAutoModel: boolean,
): string {
  if (!model) return DEFAULT_MODEL;
  if (model === "openrouter/auto" && !allowAutoModel) return DEFAULT_MODEL;
  return model;
}

function buildPrompt(
  context: FixContext,
  maxBytes: number,
): OpinionPrompt {
  const instruction =
    "Create an advisory opinion from this redacted Crumbtrail evidence bundle. The deterministic signals are heuristics, not contextual judgments. Return strict JSON with an array named hypotheses. Every hypothesis must include confidence and evidence_refs. Include a top level unknowns array that states what this evidence cannot establish. Keep the opinion structurally separate from the evidence.";
  return boundOpinionPrompt(instruction, context, maxBytes);
}

function boundOpinionPrompt(
  instruction: string,
  evidenceSlice: FixContext,
  maxBytes: number,
): OpinionPrompt {
  const prefix = `${instruction}\n\nEvidence bundle:\n`;
  const fullPrompt = `${prefix}${JSON.stringify(evidenceSlice, null, 2)}`;
  if (Buffer.byteLength(fullPrompt, "utf-8") <= maxBytes) {
    return {
      prompt: fullPrompt,
      evidenceSlice: fullPrompt,
      reduction: { mode: "none", dropped: [] },
    };
  }

  // The normal path above always sends the complete agent-visible bundle.
  // Under an explicit hard byte cap, remove lower ranked signals first and
  // retain an auditable record of every omission.
  const reduced = cloneFixContext(evidenceSlice);
  const signalDrops: PromptDrop[] = [];
  while (
    reduced.signals.length > 0 &&
    Buffer.byteLength(`${prefix}${JSON.stringify(reduced, null, 2)}`, "utf-8") >
      maxBytes
  ) {
    const index = reduced.signals.length - 1;
    const signal = reduced.signals.pop()!;
    signalDrops.push({
      path: `signals[${index}]`,
      reason: "prompt_byte_cap",
      id: signal.id,
    });
  }
  if (
    Buffer.byteLength(
      `${prefix}${JSON.stringify(reduced, null, 2)}`,
      "utf-8",
  ) <= maxBytes
  ) {
    const prompt = `${prefix}${JSON.stringify(reduced, null, 2)}`;
    return {
      prompt,
      evidenceSlice: prompt,
      reduction: {
        mode: "deterministic_structural",
        dropped: signalDrops,
      },
    };
  }

  // A single correlated window can exceed the provider cap. Retain the full
  // top-level shape and shorten deterministic lower-detail values, recording
  // precisely which paths changed in the audit.
  for (const stringLimit of [2048, 1024, 512, 256, 128, 64, 32, 16, 0]) {
    for (const arrayLimit of [20, 10, 5, 1, 0]) {
      const drops = [...signalDrops];
      const bounded = limitPromptValue(
        reduced,
        stringLimit,
        arrayLimit,
        "",
        drops,
      ) as FixContext;
      const prompt = `${prefix}${JSON.stringify(bounded, null, 2)}`;
      if (Buffer.byteLength(prompt, "utf-8") <= maxBytes) {
        return {
          prompt,
          evidenceSlice: prompt,
          reduction: { mode: "deterministic_structural", dropped: drops },
        };
      }
    }
  }

  const minimal = minimalEvidenceSlice(reduced);
  const prompt = `${prefix}${JSON.stringify(minimal, null, 2)}`;
  if (Buffer.byteLength(prompt, "utf-8") <= maxBytes) {
    return {
      prompt,
      evidenceSlice: prompt,
      reduction: {
        mode: "deterministic_structural",
        dropped: [
          ...signalDrops,
          ...minimalEvidenceDrops(reduced),
        ],
      },
    };
  }

  const capped = utf8Prefix(prompt, Math.max(0, maxBytes));
  return {
    prompt: capped,
    evidenceSlice: capped,
    reduction: {
      mode: "byte_prefix",
      dropped: [
        ...signalDrops,
        ...minimalEvidenceDrops(reduced),
        {
          path: "$",
          reason: "prompt_byte_cap",
          characters: prompt.length - capped.length,
        },
      ],
    },
  };
}

function cloneFixContext(context: FixContext): FixContext {
  return JSON.parse(JSON.stringify(context)) as FixContext;
}

function limitPromptValue(
  value: unknown,
  stringLimit: number,
  arrayLimit: number,
  path: string,
  drops: PromptDrop[],
): unknown {
  if (typeof value === "string") {
    if (value.length <= stringLimit) return value;
    drops.push({
      path,
      reason: "prompt_byte_cap",
      characters: value.length - stringLimit,
    });
    if (stringLimit === 0) return "";
    return `${value.slice(0, stringLimit)}[TRUNCATED_TO_PROMPT_BYTE_CAP]`;
  }
  if (Array.isArray(value)) {
    if (value.length > arrayLimit)
      drops.push({
        path,
        reason: "prompt_byte_cap",
        omitted: value.length - arrayLimit,
      });
    return value
      .slice(0, arrayLimit)
      .map((entry, index) =>
        limitPromptValue(
          entry,
          stringLimit,
          arrayLimit,
          `${path}[${index}]`,
          drops,
        ),
      );
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      limitPromptValue(
        entry,
        stringLimit,
        arrayLimit,
        path ? `${path}.${key}` : key,
        drops,
      ),
    ]),
  );
}

function minimalEvidenceDrops(context: FixContext): PromptDrop[] {
  const drops: PromptDrop[] = [];
  if (context.signals.length > 0)
    drops.push({
      path: "signals",
      reason: "prompt_byte_cap",
      omitted: context.signals.length,
    });
  for (const [path, entries] of [
    ["primary_window.frontend.requests", context.primary_window.frontend.requests],
    ["primary_window.backend.requests", context.primary_window.backend.requests],
    ["primary_window.db_diffs", context.primary_window.db_diffs],
    ["primary_window.db_reads", context.primary_window.db_reads],
    ["primary_window.db_activity", context.primary_window.db_activity],
  ] as const) {
    if (entries.length > 0)
      drops.push({
        path,
        reason: "prompt_byte_cap",
        omitted: entries.length,
      });
  }
  if (context.environment !== null)
    drops.push({ path: "environment", reason: "prompt_byte_cap" });
  if (context.causal_chain !== null)
    drops.push({ path: "causal_chain", reason: "prompt_byte_cap" });
  if (context.repro_hint !== null)
    drops.push({ path: "repro_hint", reason: "prompt_byte_cap" });
  return drops;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value, "utf-8");
  for (let end = Math.min(bytes.length, maxBytes); end >= 0; end -= 1) {
    const prefix = bytes.subarray(0, end).toString("utf-8");
    if (Buffer.byteLength(prefix, "utf-8") <= maxBytes) return prefix;
  }
  return "";
}

function minimalEvidenceSlice(context: FixContext): FixContext {
  return {
    schemaVersion: context.schemaVersion,
    session: {
      id: context.session.id,
      startMs: context.session.startMs,
      endMs: context.session.endMs,
      durationMs: context.session.durationMs,
    },
    signals: [],
    primary_window: {
      frontend: { window: null, anchor: null, requests: [] },
      backend: { requests: [] },
      db_diffs: [],
      db_reads: [],
      db_activity: [],
    },
    environment: null,
    causal_chain: null,
    repro_hint: null,
  };
}

function extractContent(payload: unknown): string | undefined {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const first = payload.choices[0];
  if (!isRecord(first) || !isRecord(first.message)) return undefined;
  return typeof first.message.content === "string"
    ? first.message.content
    : undefined;
}

export function normalizeAiOpinion(value: unknown): AiOpinionArtifact {
  const source = isRecord(value) ? value : {};
  const rawHypotheses = Array.isArray(source.hypotheses)
    ? source.hypotheses
    : Array.isArray(source.findings)
      ? source.findings
      : [];
  const hypotheses = rawHypotheses.map((entry, index) => {
    const record = isRecord(entry) ? entry : {};
    const codeRefs = stringValues(record.code_refs);
    const { code_refs: _rawCodeRefs, ...rest } = record;
    return {
      ...rest,
      rank: typeof record.rank === "number" ? record.rank : index + 1,
      confidence:
        typeof record.confidence === "string" ? record.confidence : "unknown",
      evidence_refs: stringValues(record.evidence_refs),
      // Normalized like evidence_refs, but omitted (not []) when the source
      // finding carried none, so readers never mistake "no code AI" for
      // "code AI ran and matched nothing".
      ...(codeRefs.length > 0 ? { code_refs: codeRefs } : {}),
    } as AiOpinionHypothesis;
  });
  const unknowns = stringValues(source.unknowns);
  if (unknowns.length === 0) {
    for (const hypothesis of hypotheses) {
      unknowns.push(...stringValues(hypothesis.unknowns));
    }
  }
  return { schemaVersion: "opinion.v1", hypotheses, unknowns };
}

function renderOpinionMarkdown(opinion: AiOpinionArtifact): string {
  const lines = [
    "# AI Opinion",
    "",
    "Optional LLM produced opinion over redacted Crumbtrail evidence.",
    "",
  ];
  if (opinion.hypotheses.length === 0) {
    lines.push("No hypotheses returned.", "");
    return lines.join("\n");
  }

  for (const hypothesis of opinion.hypotheses) {
    lines.push(`## Hypothesis ${hypothesis.rank}`);
    lines.push("");
    for (const key of [
      "title",
      "confidence",
      "evidence_refs",
      "summary",
      "recommended_debug_steps",
    ]) {
      if (hypothesis[key] === undefined) continue;
      lines.push(
        `* ${key}: ${Array.isArray(hypothesis[key]) ? (hypothesis[key] as unknown[]).join(", ") : String(hypothesis[key])}`,
      );
    }
    lines.push("");
  }

  lines.push("## Unknowns", "");
  if (opinion.unknowns.length === 0) lines.push("* None reported.", "");
  else for (const unknown of opinion.unknowns) lines.push(`* ${unknown}`);
  return lines.join("\n");
}

function stringValues(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
