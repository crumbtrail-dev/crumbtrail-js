import type { DbDiffOp } from "crumbtrail-core";
import {
  classifyStatement,
  leadingSqlKeyword,
  parseMutation,
  parseRead,
  type ParsedMutation,
  type ParsedRead,
} from "./sql";
import {
  emitGap,
  emitDbDiffEvents,
  emitDbReadEvents,
  emitImagelessDbDiff,
  extractPk,
  isRecord,
  pkKey,
  type InstrumentDbClientOptions,
} from "./instrument-shared";

/**
 * Minimal duck-typed view of an `mssql`-package result. We never import `mssql` at module top level —
 * the host injects its own pool, so `mssql` stays an optional peer and tests use a fake pool. Only the
 * fields the shim reads are typed; every other property (`output`, `returnValue`, …) rides through the
 * host-visible result untouched.
 */
export interface DuckTypedMssqlResult {
  recordset?: unknown[];
  recordsets?: unknown[][];
  rowsAffected?: number[];
  [key: string]: unknown;
}

/** Duck-typed view of an `mssql` Request (`pool.request()`), recording `input()` and running `query()`. */
export interface DuckTypedMssqlRequest {
  input(name: string, ...rest: unknown[]): unknown;
  query(text: unknown): Promise<DuckTypedMssqlResult>;
  [key: string]: unknown;
}

/** Duck-typed view of an `mssql` ConnectionPool. `query` (the convenience single-string form) is optional. */
export interface DuckTypedMssqlPool {
  request(): DuckTypedMssqlRequest;
  query?(text: unknown, ...rest: unknown[]): Promise<DuckTypedMssqlResult>;
}

const ENGINE = "mssql" as const;

// Identifier grammar mirrors sql.ts (kept local so the adapter stays self-contained and does not
// have to widen the shared parser's export surface). Used only to locate the DELETE injection point.
const IDENT_PART = String.raw`(?:"[^"]+"|\`[^\`]+\`|\[[^\]]+\]|[\w$]+)`;
const TABLE_IDENT = String.raw`${IDENT_PART}(?:\s*\.\s*${IDENT_PART})*`;
const TOP_CLAUSE = String.raw`(?:top\s*(?:\(\s*\d+\s*\)|\d+)\s+)?`;
// Matches the `DELETE [TOP (n)] FROM <table>` prefix; `m[0].length` is the byte after the target table.
const DELETE_TARGET_RE = new RegExp(
  String.raw`^\s*delete\s+${TOP_CLAUSE}from\s+(?:only\s+)?${TABLE_IDENT}`,
  "i",
);

/**
 * True when `keyword` (lowercase, single-space separated for multi-word keywords) starts at `index`
 * with a trailing word boundary. Callers guarantee the char BEFORE `index` is already a boundary.
 */
function matchesKeywordAt(
  sql: string,
  index: number,
  keyword: string,
): boolean {
  const words = keyword.split(" ");
  let pos = index;
  for (let w = 0; w < words.length; w += 1) {
    const word = words[w];
    if (sql.slice(pos, pos + word.length).toLowerCase() !== word) return false;
    pos += word.length;
    if (w < words.length - 1) {
      const wsStart = pos;
      while (pos < sql.length && /\s/.test(sql[pos])) pos += 1;
      if (pos === wsStart) return false; // multi-word keyword needs whitespace between words
    }
  }
  const after = sql[pos];
  return after === undefined || !/[\w$]/.test(after);
}

/**
 * If a string literal (`'…'`, `"…"`), quoted identifier (`` `…` ``, `[…]`), or SQL comment
 * (`-- …` to end of line, or a block comment) begins at `sql[i]`, returns the index of the first character
 * AFTER that region (running to EOF when the region is unterminated). Returns null when `sql[i]`
 * opens no such region. Shared by top-level keyword scanning so comments and strings are skipped
 * uniformly and a stray quote/keyword inside them can never wedge the scan or be mistaken for a
 * real clause.
 */
function skipRegion(sql: string, i: number): number | null {
  const ch = sql[i];
  const n = sql.length;
  if (ch === "-" && sql[i + 1] === "-") {
    let j = i + 2;
    while (j < n && sql[j] !== "\n") j += 1;
    return j; // stops at the newline (or EOF); the newline itself is scanned normally next
  }
  if (ch === "/" && sql[i + 1] === "*") {
    let j = i + 2;
    while (j < n && !(sql[j] === "*" && sql[j + 1] === "/")) j += 1;
    return j >= n ? n : j + 2;
  }
  if (ch === "'" || ch === '"') {
    let j = i + 1;
    while (j < n) {
      if (sql[j] === ch) {
        if (sql[j + 1] === ch) {
          j += 2; // doubled delimiter = escaped quote inside the literal
          continue;
        }
        return j + 1;
      }
      j += 1;
    }
    return n;
  }
  if (ch === "`" || ch === "[") {
    const close = ch === "`" ? "`" : "]";
    let j = i + 1;
    while (j < n && sql[j] !== close) j += 1;
    return j >= n ? n : j + 1;
  }
  return null;
}

/**
 * Index of the earliest occurrence of any keyword at "top level" — paren depth 0 and outside string
 * literals (`'…'`, `"…"`), quoted identifiers (`` `…` ``, `[…]`), and comments (line and block).
 * Keywords match case-insensitively on word boundaries; multi-word keywords allow arbitrary
 * intervening whitespace. Returns undefined when none match at top level. This is how a real
 * `OUTPUT`/`WHERE`/`FROM` clause (always top level) is distinguished from the same word inside a
 * parenthesized list (depth > 0), a string literal, or a comment.
 */
function findTopLevelKeywordIndex(
  sql: string,
  keywords: readonly string[],
): number | undefined {
  let depth = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const skipped = skipRegion(sql, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    const ch = sql[i];
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0) {
      const before = i === 0 ? " " : sql[i - 1];
      if (!/[\w$]/.test(before)) {
        // Not mid-word: this could be a keyword start.
        for (const keyword of keywords) {
          if (matchesKeywordAt(sql, i, keyword)) return i;
        }
      }
    }
    i += 1;
  }
  return undefined;
}

/** Result of {@link scanStatementSafety}. */
interface StatementSafety {
  /** Scan ended inside an unterminated string literal, quoted identifier, or block comment. */
  unterminated: boolean;
  /** A top-level `;` is followed by another non-whitespace statement (multi-statement batch). */
  multiStatement: boolean;
  /**
   * A quote character (`'`, `"`, `` ` ``) appears inside a comment. Comments are skipped by the
   * scanner, but a quote hidden in one is exactly what historically wedged naive quote tracking and
   * produced a mis-placed injection; treat it as unsafe to edit and fall back to the image-less path.
   */
  quoteInComment: boolean;
}

/** True for the quote delimiters that (historically) drive quote tracking. */
function isQuoteChar(ch: string): boolean {
  return ch === "'" || ch === '"' || ch === "`";
}

/**
 * Pre-injection safety scan run for EVERY mutation. Reports whether the statement is safe to edit:
 * it must be a single statement whose strings/identifiers/comments/parens all resolve cleanly. When
 * any flag is set the caller must NOT inject — it runs the ORIGINAL text untouched and records an
 * image-less diff, so a batch, an unterminated literal, or a quote-bearing comment can never produce
 * corrupt T-SQL or silently drop a caller recordset.
 */
function scanStatementSafety(sql: string): StatementSafety {
  const n = sql.length;
  let depth = 0;
  let sawTopLevelSemicolon = false;
  let multiStatement = false;
  let quoteInComment = false;
  let unterminated = false;
  let i = 0;
  while (i < n) {
    const ch = sql[i];
    // Comments first (their content is skipped, and a comment AFTER a `;` is not a second statement).
    if (ch === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") {
        if (isQuoteChar(sql[i])) quoteInComment = true;
        i += 1;
      }
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      i += 2;
      let closed = false;
      while (i < n) {
        if (sql[i] === "*" && sql[i + 1] === "/") {
          i += 2;
          closed = true;
          break;
        }
        if (isQuoteChar(sql[i])) quoteInComment = true;
        i += 1;
      }
      if (!closed) {
        unterminated = true;
        break;
      }
      continue;
    }
    // Any non-whitespace after a top-level `;` starts a second statement.
    if (sawTopLevelSemicolon && !/\s/.test(ch)) {
      multiStatement = true;
      break;
    }
    if (ch === "'" || ch === '"') {
      const quote = ch;
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2; // escaped doubled quote
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        unterminated = true;
        break;
      }
      continue;
    }
    if (ch === "`" || ch === "[") {
      const close = ch === "`" ? "`" : "]";
      i += 1;
      let closed = false;
      while (i < n) {
        if (sql[i] === close) {
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) {
        unterminated = true;
        break;
      }
      continue;
    }
    if (ch === "(") {
      depth += 1;
      i += 1;
      continue;
    }
    if (ch === ")") {
      if (depth > 0) depth -= 1;
      i += 1;
      continue;
    }
    if (depth === 0 && ch === ";") {
      sawTopLevelSemicolon = true;
      i += 1;
      continue;
    }
    i += 1;
  }
  return { unterminated, multiStatement, quoteInComment };
}

/** Splices `clause` into `sql` immediately before `index` (index points at the next top-level keyword). */
function spliceBefore(sql: string, index: number, clause: string): string {
  return `${sql.slice(0, index)}${clause} ${sql.slice(index)}`;
}

/**
 * Injects `OUTPUT INSERTED.*` before the top-level `VALUES` / `SELECT` / `DEFAULT VALUES` keyword of an
 * INSERT. Returns undefined when no confident injection point exists (e.g. `INSERT … EXEC …`) so the
 * caller degrades to running the original + an image-less fallback rather than mis-editing the SQL.
 */
function injectInsertOutput(sql: string): string | undefined {
  const index = findTopLevelKeywordIndex(sql, [
    "default values",
    "values",
    "select",
  ]);
  if (index === undefined) return undefined;
  return spliceBefore(sql, index, "OUTPUT INSERTED.*");
}

// Cheap, quote/comment-unaware presence check for a FROM/WHERE keyword anywhere in the text. Used
// only as a veto: if the top-level scanner found no injection point but this suggests a clause DOES
// exist (e.g. inside a subquery or a string), we refuse to append rather than risk `WHERE … OUTPUT`.
const HAS_FROM_OR_WHERE_RE = /\b(?:from|where)\b/i;

/**
 * Injects `OUTPUT INSERTED.*` into an UPDATE, mirroring the INSERT/DELETE injectors' `string |
 * undefined` contract. T-SQL places OUTPUT after the SET assignments and before FROM/WHERE:
 *  - before the top-level `FROM` (update-source form) if present, else
 *  - before the top-level `WHERE`, else
 *  - appended at the end ONLY when the scan is clean AND no FROM/WHERE exists anywhere.
 *
 * Never blind-appends: if the scanner located no top-level FROM/WHERE but a cheap regex still finds
 * one in the text, the clause is present but not where we can safely splice (subquery, string, …), so
 * we return undefined and the caller degrades to running the ORIGINAL plus an image-less diff. This
 * is what prevents the historical `UPDATE … WHERE … OUTPUT INSERTED.*` (invalid T-SQL) append bug.
 */
function injectUpdateOutput(sql: string): string | undefined {
  const fromIndex = findTopLevelKeywordIndex(sql, ["from"]);
  if (fromIndex !== undefined)
    return spliceBefore(sql, fromIndex, "OUTPUT INSERTED.*");
  const whereIndex = findTopLevelKeywordIndex(sql, ["where"]);
  if (whereIndex !== undefined)
    return spliceBefore(sql, whereIndex, "OUTPUT INSERTED.*");
  if (HAS_FROM_OR_WHERE_RE.test(sql)) return undefined;
  return `${sql.replace(/;\s*$/, "")} OUTPUT INSERTED.*`;
}

/**
 * Injects `OUTPUT DELETED.*` immediately after the DELETE target table (before the optional
 * update-source FROM / WHERE). The captured DELETED rows become the delete diff's before-image,
 * matching Postgres delete semantics. Returns undefined if the target table cannot be located.
 */
function injectDeleteOutput(sql: string): string | undefined {
  const match = DELETE_TARGET_RE.exec(sql);
  if (!match) return undefined;
  const end = match[0].length;
  return `${sql.slice(0, end)} OUTPUT DELETED.*${sql.slice(end)}`;
}

/** Dispatches OUTPUT injection by op; undefined = no confident injection point (image-less fallback). */
function injectOutput(op: DbDiffOp, sql: string): string | undefined {
  if (op === "insert") return injectInsertOutput(sql);
  if (op === "update") return injectUpdateOutput(sql);
  if (op === "delete") return injectDeleteOutput(sql);
  return undefined;
}

/**
 * True when the statement already carries a top-level OUTPUT clause. We never double-inject: if the
 * host is already using OUTPUT we can't tell our rows from theirs, so we run the statement untouched
 * and skip diff capture. Top-level scanning ignores `output` inside string literals / parenthesized
 * column lists so those don't suppress capture.
 */
function hasOutputClause(sql: string): boolean {
  return findTopLevelKeywordIndex(sql, ["output"]) !== undefined;
}

/**
 * SQL Server errors that fail at COMPILE time — before any row is modified — and are therefore safe
 * to recover from by re-running the ORIGINAL statement on a fresh request with replayed inputs:
 *  - 334: an OUTPUT clause (without INTO) targets a table that has triggers.
 *  - 156: incorrect syntax near a keyword (e.g. an OUTPUT clause our injection placed where this
 *    server/compat level rejects it).
 *  - 102: incorrect syntax near a token (same family; a malformed injection is caught here).
 * None of these can have applied the mutation, so the re-run still applies the write exactly once.
 */
const COMPILE_RERUN_ERROR_NUMBERS: ReadonlySet<number> = new Set([
  334, 156, 102,
]);

/**
 * True when `err` is a compile-time SQL Server failure safe to recover from by re-running the
 * ORIGINAL statement (see {@link COMPILE_RERUN_ERROR_NUMBERS}). A numbered error is trusted ONLY
 * when its number is in the allowlist — any other numbered (runtime) error returns false so it
 * propagates with NO re-run. The legacy OUTPUT-clause-on-trigger message signature is honored ONLY
 * when the error carries no number at all (older drivers), never to override a numbered runtime error.
 */
function isSafeCompileRerunError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const candidate = err as { number?: unknown; message?: unknown };
  if (candidate.number !== undefined && candidate.number !== null) {
    return (
      typeof candidate.number === "number" &&
      COMPILE_RERUN_ERROR_NUMBERS.has(candidate.number)
    );
  }
  const message =
    typeof candidate.message === "string" ? candidate.message : "";
  return /output clause/i.test(message) && /trigger/i.test(message);
}

/** After-image / before-image rows from a result's recordset (plain objects only), or []. */
function recordsetRows(
  result: DuckTypedMssqlResult,
): Array<Record<string, unknown>> {
  return (Array.isArray(result?.recordset) ? result.recordset : []).filter(
    isRecord,
  );
}

/** Authoritative row count: `rowsAffected[0]` when finite, else the captured-row fallback. */
function rowCountFromResult(
  result: DuckTypedMssqlResult,
  fallback: number,
): number {
  const affected = result?.rowsAffected;
  if (Array.isArray(affected) && Number.isFinite(affected[0]))
    return affected[0];
  return fallback;
}

/**
 * Returns a host-visible copy of the result with OUR injected OUTPUT rows removed — the recordset is
 * reset to the empty/undefined shape a plain INSERT/UPDATE/DELETE (no OUTPUT) would have produced,
 * while `rowsAffected` and every other driver property are preserved. Only ever called when we
 * injected OUTPUT; a result the host asked for is never stripped.
 */
function stripInjectedRows(result: DuckTypedMssqlResult): DuckTypedMssqlResult {
  return { ...result, recordset: undefined, recordsets: [] };
}

/** Replays recorded `input()` arg tuples onto a fresh request so a re-run/pre-SELECT binds identically. */
function replayInputs(
  request: DuckTypedMssqlRequest,
  recordedInputs: ReadonlyArray<readonly unknown[]>,
): void {
  for (const args of recordedInputs) {
    (request.input as (...a: unknown[]) => unknown)(...args);
  }
}

/**
 * Wraps a duck-typed `mssql` pool so INSERT/UPDATE/DELETE statements executed within a request scope
 * record a `db.diff` event (op, table, primary key, after-image; before-image behind `captureBefore`).
 * After-images are read by injecting an `OUTPUT INSERTED.*` / `OUTPUT DELETED.*` clause into the
 * statement (no extra round trip); the injected rows are consumed for diffs and then stripped from the
 * host-visible result, so the caller sees exactly what the un-instrumented statement would have
 * returned. SELECTs are optionally captured as read evidence (`captureReads`).
 *
 * Never-fail guarantees:
 *  - Parse/correlation failures, missing request scope, unparseable SQL → the original statement runs
 *    untouched.
 *  - A pre-injection safety gate (`scanStatementSafety`) refuses to edit any statement we cannot
 *    confidently tokenize as a single statement — multi-statement batches, unterminated
 *    strings/comments, and quote-bearing comments run the ORIGINAL untouched (image-less diff), so the
 *    host never receives corrupt T-SQL or loses a caller recordset.
 *  - The host mutation executes exactly once. The only re-run is the compile-class fallback (errors
 *    334 / 156 / 102), which fail at COMPILE time before any rows change, so re-running the ORIGINAL
 *    text on a fresh request with replayed inputs is safe. Every other error propagates as-is.
 *  - All capture/emit work is wrapped; a failure degrades to fewer/no diffs, never to a failed host
 *    query. When a mutation clearly ran but no images are obtainable, one image-less `db.diff`
 *    (`pk: null`, `rowCount`) still records the write.
 */
export function instrumentMssqlPool<T extends DuckTypedMssqlPool>(
  pool: T,
  options: InstrumentDbClientOptions,
): T {
  const emittedReadRowsByRequest = new Map<string, number>();

  // `request` is the RAW mssql request that already has the host's inputs bound; `recordedInputs` are
  // the same inputs captured for replay onto fresh requests. Fresh requests always come from the RAW
  // `pool` (never the proxy) so pre-SELECT / fallback statements are not themselves instrumented.
  const runInstrumentedQuery = async (
    request: DuckTypedMssqlRequest,
    recordedInputs: ReadonlyArray<readonly unknown[]>,
    text: unknown,
  ): Promise<DuckTypedMssqlResult> => {
    if (typeof text !== "string") return request.query(text);
    const sql = text;

    let parsed: ParsedMutation | undefined;
    let parsedRead: ParsedRead | undefined;
    let requestId: string | undefined;
    try {
      const classification = classifyStatement(sql);
      if (classification.kind === "unparsable" && classification.mayMutate) {
        emitGap(options, {
          reason: "unparsed_sql",
          detail: leadingSqlKeyword(sql),
        });
      }
      parsed =
        classification.kind === "mutation"
          ? classification.mutation
          : undefined;
      parsedRead =
        classification.kind === "read" ? classification.read : undefined;
      requestId = options.requestId ?? options.getRequestId?.();
    } catch (error) {
      emitGap(options, { reason: "capture_exception", error });
      return request.query(sql);
    }
    if (!requestId) return request.query(sql);

    // Non-mutation (read) path.
    if (!parsed) {
      const result = await request.query(sql);
      if (options.captureReads && parsedRead) {
        try {
          const rows = recordsetRows(result);
          emitDbReadEvents({
            engine: ENGINE,
            table: parsedRead.table,
            requestId,
            rows,
            rowCount: rowCountFromResult(result, rows.length),
            options,
            emittedReadRowsByRequest,
          });
        } catch (error) {
          emitGap(options, { reason: "capture_exception", error });
        }
      }
      return result;
    }

    // Stable const bindings for the mutation path (narrowing survives into the nested helper below).
    const mutation = parsed;
    const reqId = requestId;

    // Runs the ORIGINAL text untouched and records an image-less `db.diff` when it changed rows. Used
    // whenever we deliberately decline to edit the SQL (safety gate, no injection point).
    const runOriginalWithImagelessDiff =
      async (): Promise<DuckTypedMssqlResult> => {
        const result = await request.query(sql);
        try {
          const rowCount = rowCountFromResult(result, 0);
          if (rowCount > 0) {
            emitImagelessDbDiff({
              engine: ENGINE,
              op: mutation.op,
              table: mutation.table,
              requestId: reqId,
              rowCount,
              options,
            });
          }
        } catch (error) {
          emitGap(options, { reason: "capture_exception", error });
        }
        return result;
      };

    // The statement already carries an OUTPUT clause: run untouched and record why Crumbtrail
    // cannot distinguish its own rows from the caller's result. Never inject a second OUTPUT.
    if (hasOutputClause(sql)) {
      emitGap(options, {
        reason: "capture_exception",
        detail: "existing output clause",
      });
      return request.query(sql);
    }

    // Pre-injection safety gate (all ops): never edit a statement we cannot confidently tokenize as a
    // single statement. A multi-statement batch, an unterminated string/comment, or a quote hidden in
    // a comment → run the ORIGINAL untouched with an image-less diff, so the host never gets corrupt
    // T-SQL and a batch's caller recordset (e.g. a trailing SELECT) survives.
    const safety = scanStatementSafety(sql);
    if (safety.unterminated || safety.multiStatement || safety.quoteInComment) {
      return runOriginalWithImagelessDiff();
    }

    // Pre-image capture for UPDATE — best-effort, on a FRESH request with replayed named inputs, BEFORE
    // the mutation. A failing pre-SELECT must not abort a mutation that would otherwise succeed.
    let beforeByPk: Map<string, Record<string, unknown>> | undefined;
    if (
      options.captureBefore &&
      mutation.op === "update" &&
      mutation.whereClause
    ) {
      try {
        const pre = pool.request();
        replayInputs(pre, recordedInputs);
        const preResult = await pre.query(
          `SELECT * FROM ${mutation.table} ${mutation.whereClause}`,
        );
        beforeByPk = new Map();
        for (const row of recordsetRows(preResult)) {
          beforeByPk.set(
            pkKey(extractPk(row, mutation.table, options.pkColumns)),
            row,
          );
        }
      } catch (error) {
        emitGap(options, { reason: "capture_exception", error });
        beforeByPk = undefined;
      }
    }

    // Build the OUTPUT-injected statement. A build failure degrades to the image-less path.
    let injectedText: string | undefined;
    try {
      injectedText = injectOutput(mutation.op, sql);
    } catch (error) {
      emitGap(options, { reason: "capture_exception", error });
      injectedText = undefined;
    }

    // No confident injection point: run the ORIGINAL and record an image-less diff if it changed rows.
    if (injectedText === undefined) {
      return runOriginalWithImagelessDiff();
    }

    // Execute the injected mutation. The compile-class fallback (errors 334 / 156 / 102) is the ONLY
    // re-run — those fail at compile time before any rows change, so re-running the ORIGINAL on a fresh
    // request is safe and guarantees single application. Any other error propagates as-is.
    let result: DuckTypedMssqlResult;
    try {
      result = await request.query(injectedText);
    } catch (err) {
      if (!isSafeCompileRerunError(err)) throw err;
      const fresh = pool.request();
      replayInputs(fresh, recordedInputs);
      const fallbackResult = await fresh.query(sql);
      try {
        const rowCount = rowCountFromResult(fallbackResult, 0);
        if (rowCount > 0) {
          emitImagelessDbDiff({
            engine: ENGINE,
            op: mutation.op,
            table: mutation.table,
            requestId: reqId,
            rowCount,
            options,
          });
        }
      } catch (error) {
        emitGap(options, { reason: "capture_exception", error });
      }
      return fallbackResult;
    }

    // We injected OUTPUT: consume the injected rows for diffs, then hand the host a stripped result.
    try {
      const rows = recordsetRows(result);
      const rowCount = rowCountFromResult(result, rows.length);
      if (rows.length > 0) {
        emitDbDiffEvents({
          engine: ENGINE,
          op: mutation.op,
          table: mutation.table,
          requestId: reqId,
          rows,
          beforeByPk,
          rowCount,
          options,
        });
      } else if (rowCount > 0) {
        // Mutation ran but produced no imageable OUTPUT rows: still record the write.
        emitImagelessDbDiff({
          engine: ENGINE,
          op: mutation.op,
          table: mutation.table,
          requestId: reqId,
          rowCount,
          options,
        });
      }
    } catch (error) {
      emitGap(options, { reason: "capture_exception", error });
    }

    return stripInjectedRows(result);
  };

  const wrapRequest = (raw: DuckTypedMssqlRequest): DuckTypedMssqlRequest => {
    const recordedInputs: unknown[][] = [];
    const proxy: DuckTypedMssqlRequest = new Proxy(raw, {
      get(target, prop, receiver) {
        if (prop === "input") {
          return (...args: unknown[]) => {
            // Bind on the raw request first so a driver error (e.g. duplicate param) propagates and we
            // don't record a rejected input; return the proxy so chained `.input().query()` stays wrapped.
            (target.input as (...a: unknown[]) => unknown).apply(target, args);
            recordedInputs.push(args);
            return proxy;
          };
        }
        if (prop === "query") {
          return (text: unknown) =>
            runInstrumentedQuery(target, recordedInputs, text);
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    return proxy;
  };

  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "request") {
        return (...args: unknown[]) =>
          wrapRequest(
            (
              target.request as (...a: unknown[]) => DuckTypedMssqlRequest
            ).apply(target, args),
          );
      }
      if (prop === "query" && typeof target.query === "function") {
        // Instrument only the plain single-string form; template-tag / callback / param forms pass
        // through untouched. The plain form runs on our own wrapped request (no inputs) so it is
        // captured just like `request.query(text)`.
        return (text: unknown, ...rest: unknown[]) => {
          if (typeof text === "string" && rest.length === 0) {
            return wrapRequest(target.request()).query(text);
          }
          return (target.query as (...a: unknown[]) => unknown).call(
            target,
            text,
            ...rest,
          );
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
