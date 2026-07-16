import {
  classifyStatement,
  ensureReturning,
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
  extractPk,
  isRecord,
  pkKey,
  type InstrumentDbClientOptions,
} from "./instrument-shared";

export { parseMutation, parseRead } from "./sql";

/**
 * Minimal duck-typed view of a `pg` Client/Pool. We never import `pg` at module top-level — the
 * host injects its own client/pool, so `pg` stays an optional peer and tests use a fake client.
 */
export interface DuckTypedPgQueryResult {
  rows?: unknown[];
  rowCount?: number | null;
  command?: string;
}

export interface DuckTypedPgClient {
  query(text: unknown, params?: unknown): Promise<DuckTypedPgQueryResult>;
}

/** Back-compat alias: the Postgres shim shares the engine-agnostic option shape. */
export type InstrumentPgClientOptions = InstrumentDbClientOptions;

const ENGINE = "postgres" as const;

/**
 * Wraps a duck-typed `pg` client/pool so INSERT/UPDATE/DELETE statements executed within a request
 * scope record a `db.diff` event (op, table, primary key, after-image; before-image behind
 * `captureBefore`). The shim appends `RETURNING *` when absent to read the after-image, and reads
 * the result rows otherwise. Only the promise-returning `query(text, params)` form is instrumented;
 * config-object and callback forms pass straight through. Engine is Postgres only; the builder is
 * driver-agnostic so other engines can slot in later. A pool's `connect()` result is proxied too,
 * so mutations issued through acquired clients retain the same instrumentation and pool lifecycle.
 *
 * Limitations: trigger/cascade side effects and rows changed by other tables are not captured; the
 * pre-image SELECT for `captureBefore` reuses the statement's WHERE clause + params, so it supports
 * single-table UPDATEs (not CTEs, joins, or sub-selects).
 */
export function instrumentPgClient<T extends DuckTypedPgClient>(
  client: T,
  options: InstrumentPgClientOptions,
): T {
  const emittedReadRowsByRequest = new Map<string, number>();

  const wrappedQuery = async (
    text: unknown,
    params?: unknown,
  ): Promise<DuckTypedPgQueryResult> => {
    if (typeof text !== "string") return client.query(text, params);

    // Parse/correlation resolution is diff-capture work: if it throws, fall through to the host
    // query untouched. Instrumentation must never decide whether the host's query runs.
    let parsed: ParsedMutation | undefined;
    let parsedRead: ParsedRead | undefined;
    let requestId: string | undefined;
    try {
      const classification = classifyStatement(text);
      if (classification.kind === "unparsable" && classification.mayMutate) {
        emitGap(options, {
          reason: "unparsed_sql",
          detail: leadingSqlKeyword(text),
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
      return client.query(text, params);
    }
    if (!requestId) return client.query(text, params);

    if (!parsed) {
      const result = await client.query(text, params);
      if (options.captureReads && parsedRead) {
        try {
          const rows = (result.rows ?? []).filter(isRecord);
          const rowCount =
            typeof result.rowCount === "number" &&
            Number.isFinite(result.rowCount)
              ? result.rowCount
              : rows.length;
          emitDbReadEvents({
            engine: ENGINE,
            table: parsedRead.table,
            requestId,
            rows,
            rowCount,
            options,
            emittedReadRowsByRequest,
          });
        } catch (error) {
          emitGap(options, { reason: "capture_exception", error });
        }
      }
      return result;
    }

    const paramArray = Array.isArray(params) ? params : undefined;

    // Pre-image capture is strictly best-effort: a failing SELECT (bad WHERE, permissions, etc.)
    // must NOT abort a mutation that would otherwise succeed. On failure we skip the before-image.
    let beforeByPk: Map<string, Record<string, unknown>> | undefined;
    if (options.captureBefore && parsed.op === "update" && parsed.whereClause) {
      try {
        const pre = await client.query(
          `SELECT * FROM ${parsed.table} ${parsed.whereClause}`,
          paramArray,
        );
        beforeByPk = new Map();
        for (const row of pre.rows ?? []) {
          if (!isRecord(row)) continue;
          beforeByPk.set(
            pkKey(extractPk(row, parsed.table, options.pkColumns)),
            row,
          );
        }
      } catch (error) {
        emitGap(options, { reason: "capture_exception", error });
        beforeByPk = undefined;
      }
    }

    // RETURNING handling is diff-capture work too; if it throws, run the original statement so the
    // host's query is never broken by instrumentation.
    let instrumentedText: string;
    try {
      instrumentedText = ensureReturning(text);
    } catch (error) {
      emitGap(options, { reason: "capture_exception", error });
      return client.query(text, paramArray);
    }

    // The host mutation. Its own errors propagate normally — we never swallow the caller's query.
    const result = await client.query(instrumentedText, paramArray);

    // Diff capture/emit is best-effort: a parse/build/emit failure here degrades to "no diff
    // emitted" rather than breaking the host query, whose result is returned unchanged.
    try {
      const rows = (result.rows ?? []).filter(isRecord);
      const rowCount =
        typeof result.rowCount === "number" && Number.isFinite(result.rowCount)
          ? result.rowCount
          : rows.length;
      emitDbDiffEvents({
        engine: ENGINE,
        op: parsed.op,
        table: parsed.table,
        requestId,
        rows,
        beforeByPk,
        rowCount,
        options,
      });
    } catch (error) {
      emitGap(options, { reason: "capture_exception", error });
    }

    return result;
  };

  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "query") return wrappedQuery;
      if (prop === "connect") {
        const connect = Reflect.get(target, prop, receiver);
        if (typeof connect !== "function") return connect;
        return (...args: unknown[]) => {
          const callback = args[0];
          if (typeof callback === "function") {
            const wrappedCallback = (
              error: unknown,
              acquired: unknown,
              release: unknown,
            ) => {
              if (error || acquired == null) {
                return callback(error, acquired, release);
              }
              return callback(
                error,
                instrumentAcquiredClient(acquired, options),
                release,
              );
            };
            return (connect as (...values: unknown[]) => unknown).apply(target, [
              wrappedCallback,
            ]);
          }

          return Promise.resolve(
            (connect as (...values: unknown[]) => unknown).apply(target, args),
          ).then((acquired) => instrumentAcquiredClient(acquired, options));
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function instrumentAcquiredClient(
  acquired: unknown,
  options: InstrumentPgClientOptions,
): unknown {
  try {
    if (
      !acquired ||
      typeof (acquired as { query?: unknown }).query !== "function"
    ) {
      throw new TypeError("Pool client cannot be instrumented");
    }
    return instrumentPgClient(acquired as DuckTypedPgClient, options);
  } catch (error) {
    emitGap(options, { reason: "uninstrumented_client", error });
    return acquired;
  }
}
