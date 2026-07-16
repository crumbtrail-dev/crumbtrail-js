import { buildDbDiffEvent } from "./diff-event";
import {
  emitGap,
  emitDbEvent,
  emitDbDiffEvents,
  emitDbReadEvents,
  emitImagelessDbDiff,
  extractPk,
  isRecord,
  normalizeMaxRowsPerStatement,
  pkKey,
  type InstrumentDbClientOptions,
} from "./instrument-shared";
import {
  classifyStatement,
  countPlaceholders,
  leadingSqlKeyword,
  parseMutation,
  parseRead,
  type ParsedMutation,
  type ParsedRead,
} from "./sql";

/**
 * Minimal duck-typed view of a `mysql2/promise` connection/pool. We never import `mysql2` at module
 * top-level — the host injects its own client, so `mysql2` stays an optional peer and tests use a
 * fake client. Both `query` and `execute` resolve `[rowsOrResultHeader, fields]`.
 */
export interface DuckTypedMysqlClient {
  query(sql: unknown, values?: unknown): Promise<unknown>;
  execute?(sql: unknown, values?: unknown): Promise<unknown>;
}

/** The mysql2 result-set header duck shape for a mutation (INSERT/UPDATE/DELETE). */
export interface DuckTypedMysqlResultHeader {
  affectedRows: number;
  insertId?: number;
}

type MysqlMethod = (sql: unknown, values?: unknown) => Promise<unknown>;

const ENGINE = "mysql" as const;

/** mysql2 resolves `[payload, fields]`; the payload is either the rows array or the result header. */
function resultPayload(result: unknown): unknown {
  return Array.isArray(result) ? result[0] : undefined;
}

/** Duck-types a mutation result header: a record with a numeric `affectedRows` (+ optional `insertId`). */
function mutationHeader(
  payload: unknown,
): DuckTypedMysqlResultHeader | undefined {
  if (
    isRecord(payload) &&
    typeof payload.affectedRows === "number" &&
    Number.isFinite(payload.affectedRows)
  ) {
    return payload as unknown as DuckTypedMysqlResultHeader;
  }
  return undefined;
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Trailing-`?`-params heuristic: count placeholders in the WHERE clause and take that many params
 * from the END of the statement's param array (the SET/VALUES params come first). Best-effort; a
 * mismatch degrades to no image, never to a failed host query.
 */
function extractWhereParams(
  whereClause: string | undefined,
  paramArray: unknown[] | undefined,
): unknown[] {
  if (!whereClause || !paramArray) return [];
  const n = countPlaceholders(whereClause);
  if (n <= 0) return [];
  return paramArray.slice(Math.max(0, paramArray.length - n));
}

/**
 * Builds a post-mutation SELECT that re-fetches rows by the pks captured in the pre-SELECT. A
 * single-column pk uses `WHERE <col> IN (?, ...)`; a composite pk uses
 * `(c1 = ? AND c2 = ?) OR (...)`. Params are the pk values in column order.
 */
function buildPkSelect(
  table: string,
  pks: Array<Record<string, unknown>>,
): { text: string; params: unknown[] } {
  const cols = Object.keys(pks[0]);
  if (cols.length === 1) {
    const col = cols[0];
    const placeholders = pks.map(() => "?").join(", ");
    return {
      text: `SELECT * FROM ${table} WHERE ${col} IN (${placeholders})`,
      params: pks.map((pk) => pk[col]),
    };
  }
  const groups = pks
    .map(() => `(${cols.map((col) => `${col} = ?`).join(" AND ")})`)
    .join(" OR ");
  const params: unknown[] = [];
  for (const pk of pks) for (const col of cols) params.push(pk[col]);
  return { text: `SELECT * FROM ${table} WHERE ${groups}`, params };
}

/**
 * Wraps a duck-typed `mysql2/promise` client/pool so INSERT/UPDATE/DELETE statements executed within
 * a request scope record a `db.diff` event (op, table, primary key, after-image; before-image behind
 * `captureBefore`). MySQL has no `RETURNING`, so images come from best-effort extra SELECTs:
 *
 * - INSERT: a single-row auto-increment insert (`affectedRows === 1`, positive `insertId`, single-column
 *   pk) is re-read by `insertId`; anything else (multi-row, missing insertId, composite pk) degrades to
 *   an image-less `db.diff` carrying `rowCount`.
 * - UPDATE: a pre-SELECT (WHERE + trailing params) captures pks (and before-images when `captureBefore`),
 *   then a post-SELECT by those pks captures after-images.
 * - DELETE: a pre-SELECT (WHERE + trailing params) captures the before-images.
 *
 * Both the promise-returning `query(sql, values)` and `execute(sql, values)` forms are instrumented
 * (identically); non-string sql / config-object forms pass straight through. The host statement is
 * never altered and runs exactly once — every capture SELECT and emit is wrapped so instrumentation
 * can never fail, double-execute, or alter the host query; the host result is returned unchanged.
 *
 * Limitations: trigger/cascade side effects and rows changed by other tables are not captured; the
 * WHERE-based pre-image SELECT supports single-table UPDATE/DELETE (not CTEs, joins, or sub-selects).
 */
export function instrumentMysqlClient<T extends DuckTypedMysqlClient>(
  client: T,
  options: InstrumentDbClientOptions,
): T {
  const emittedReadRowsByRequest = new Map<string, number>();
  const rawQuery = client.query.bind(client) as MysqlMethod;
  const rawExecute =
    typeof (client as { execute?: unknown }).execute === "function"
      ? ((client as unknown as { execute: MysqlMethod }).execute.bind(
          client,
        ) as MysqlMethod)
      : undefined;

  // Best-effort capture SELECT — always issued via query(). Callers wrap it; on throw they degrade
  // to fewer/no images, never breaking the host query.
  const selectRows = async (
    text: string,
    params: unknown[],
  ): Promise<Array<Record<string, unknown>>> => {
    const result = await rawQuery(text, params);
    const payload = resultPayload(result);
    return Array.isArray(payload) ? payload.filter(isRecord) : [];
  };

  const captureInsert = async (
    parsed: ParsedMutation,
    result: unknown,
    requestId: string,
  ): Promise<void> => {
    const header = mutationHeader(resultPayload(result));
    if (!header || header.affectedRows <= 0) return;
    const pkCols = options.pkColumns?.[parsed.table] ?? ["id"];
    if (
      header.affectedRows === 1 &&
      isPositiveInt(header.insertId) &&
      pkCols.length === 1
    ) {
      let rows: Array<Record<string, unknown>> = [];
      try {
        rows = await selectRows(
          `SELECT * FROM ${parsed.table} WHERE ${pkCols[0]} = ?`,
          [header.insertId],
        );
      } catch (error) {
        emitGap(options, { reason: "capture_exception", error });
        rows = [];
      }
      if (rows.length > 0) {
        emitDbDiffEvents({
          engine: ENGINE,
          op: "insert",
          table: parsed.table,
          requestId,
          rows,
          rowCount: header.affectedRows,
          options,
        });
        return;
      }
    }
    // Multi-row insert, absent/zero insertId, composite pk, or an empty re-read: no image obtainable.
    emitImagelessDbDiff({
      engine: ENGINE,
      op: "insert",
      table: parsed.table,
      requestId,
      rowCount: header.affectedRows,
      options,
    });
  };

  const captureUpdate = async (
    parsed: ParsedMutation,
    result: unknown,
    requestId: string,
    preRows: Array<Record<string, unknown>> | undefined,
  ): Promise<void> => {
    const header = mutationHeader(resultPayload(result));
    const affected = header ? header.affectedRows : 0;
    if (affected <= 0) return;

    if (parsed.whereClause && preRows && preRows.length > 0) {
      const beforeByPk = new Map<string, Record<string, unknown>>();
      const pkList: Array<Record<string, unknown>> = [];
      for (const row of preRows) {
        const pk = extractPk(row, parsed.table, options.pkColumns);
        beforeByPk.set(pkKey(pk), row);
        if (pk) pkList.push(pk);
      }
      const maxRows = normalizeMaxRowsPerStatement(options.maxRowsPerStatement);
      const cappedPks = pkList.slice(0, maxRows);

      let postRows: Array<Record<string, unknown>> = [];
      if (cappedPks.length > 0) {
        const pkSelect = buildPkSelect(parsed.table, cappedPks);
        try {
          postRows = await selectRows(pkSelect.text, pkSelect.params);
        } catch (error) {
          emitGap(options, { reason: "capture_exception", error });
          postRows = [];
        }
      }

      emitDbDiffEvents({
        engine: ENGINE,
        op: "update",
        table: parsed.table,
        requestId,
        rows: postRows,
        beforeByPk: options.captureBefore ? beforeByPk : undefined,
        rowCount: affected,
        options,
      });

      // Rows that matched a pre-image but vanished from the post-SELECT (e.g. the pk itself changed
      // or a concurrent delete): the after-image is unobtainable, so emit a before-only diff — only
      // when captureBefore is on, matching the "skip after, keep before" degradation. Built directly
      // rather than routed through emitDbDiffEvents, which always attaches an after-image for update
      // rows and so can't express a before-only update. These are additive to the after-image
      // db.diff.bulk summary above (whose emittedRows counts only after-image rows); together they
      // stay within the per-statement cap because they iterate the already-capped `cappedPks`.
      if (options.captureBefore) {
        const postKeys = new Set(
          postRows.map((row) =>
            pkKey(extractPk(row, parsed.table, options.pkColumns)),
          ),
        );
        for (const pk of cappedPks) {
          const key = pkKey(pk);
          if (postKeys.has(key)) continue;
          const before = beforeByPk.get(key);
          if (!before) continue;
          emitDbEvent(
            options,
            buildDbDiffEvent({
              engine: ENGINE,
              op: "update",
              table: parsed.table,
              pk,
              before,
              requestId,
              sessionId: options.sessionId,
              redactColumns: options.redactColumns,
              now: options.now?.(),
              sessionStartedAt: options.sessionStartedAt,
            }),
          );
        }
      }
      return;
    }

    // No WHERE clause, or the pre-SELECT failed/came back empty: fall back to an image-less diff.
    emitImagelessDbDiff({
      engine: ENGINE,
      op: "update",
      table: parsed.table,
      requestId,
      rowCount: affected,
      options,
    });
  };

  const captureDelete = async (
    parsed: ParsedMutation,
    result: unknown,
    requestId: string,
    preRows: Array<Record<string, unknown>> | undefined,
  ): Promise<void> => {
    const header = mutationHeader(resultPayload(result));
    const affected = header ? header.affectedRows : 0;
    if (affected <= 0) return;

    if (parsed.whereClause && preRows && preRows.length > 0) {
      // Delete diffs always carry the before-image (matching the Postgres semantics).
      emitDbDiffEvents({
        engine: ENGINE,
        op: "delete",
        table: parsed.table,
        requestId,
        rows: preRows,
        rowCount: affected,
        options,
      });
      return;
    }

    emitImagelessDbDiff({
      engine: ENGINE,
      op: "delete",
      table: parsed.table,
      requestId,
      rowCount: affected,
      options,
    });
  };

  const makeInstrumented =
    (run: MysqlMethod): MysqlMethod =>
    async (sql: unknown, values?: unknown): Promise<unknown> => {
      if (typeof sql !== "string") return run(sql, values);

      // Parse/correlation resolution is diff-capture work: if it throws, fall through to the host
      // statement untouched. Instrumentation must never decide whether the host's query runs.
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
        return run(sql, values);
      }
      if (!requestId) return run(sql, values);

      const paramArray = Array.isArray(values) ? values : undefined;

      // Reads: SELECTs never mutate, so run first and capture the returned rows best-effort.
      if (!parsed) {
        const result = await run(sql, values);
        if (options.captureReads && parsedRead) {
          try {
            const payload = resultPayload(result);
            const rows = Array.isArray(payload) ? payload.filter(isRecord) : [];
            emitDbReadEvents({
              engine: ENGINE,
              table: parsedRead.table,
              requestId,
              rows,
              rowCount: rows.length,
              options,
              emittedReadRowsByRequest,
            });
          } catch (error) {
            emitGap(options, { reason: "capture_exception", error });
          }
        }
        return result;
      }

      // INSERT: run first (no pre-image needed), then re-read the after-image by insertId.
      if (parsed.op === "insert") {
        const result = await run(sql, values);
        try {
          await captureInsert(parsed, result, requestId);
        } catch (error) {
          emitGap(options, { reason: "capture_exception", error });
        }
        return result;
      }

      // UPDATE / DELETE: capture pre-image rows by WHERE BEFORE the mutation. The pre-SELECT is a
      // read (never double-executes the host statement) and is fully wrapped.
      const parsedMutation = parsed;
      let preRows: Array<Record<string, unknown>> | undefined;
      if (parsedMutation.whereClause) {
        const whereParams = extractWhereParams(
          parsedMutation.whereClause,
          paramArray,
        );
        try {
          preRows = await selectRows(
            `SELECT * FROM ${parsedMutation.table} ${parsedMutation.whereClause}`,
            whereParams,
          );
        } catch (error) {
          emitGap(options, { reason: "capture_exception", error });
          preRows = undefined;
        }
      }

      const result = await run(sql, values);
      try {
        if (parsedMutation.op === "update") {
          await captureUpdate(parsedMutation, result, requestId, preRows);
        } else {
          await captureDelete(parsedMutation, result, requestId, preRows);
        }
      } catch (error) {
        emitGap(options, { reason: "capture_exception", error });
      }
      return result;
    };

  const wrappedQuery = makeInstrumented(rawQuery);
  const wrappedExecute = rawExecute ? makeInstrumented(rawExecute) : undefined;

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "query") return wrappedQuery;
      if (prop === "execute" && wrappedExecute) return wrappedExecute;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
