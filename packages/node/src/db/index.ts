import {
  resolveBackendRequestCorrelation,
  type BackendRequestEventInput,
} from "../backend-events";

export {
  DEFAULT_SENSITIVE_DB_COLUMNS,
  buildSensitiveColumnSet,
  redactColumns,
} from "./columns";
export { buildDbDiffEvent, type BuildDbDiffEventInput } from "./diff-event";
export {
  buildDbReadBulkEvent,
  buildDbReadEvent,
  type BuildDbReadBulkEventInput,
  type BuildDbReadEventInput,
} from "./read-event";
export {
  instrumentPgClient,
  parseMutation,
  parseRead,
  type DuckTypedPgClient,
  type DuckTypedPgQueryResult,
  type InstrumentPgClientOptions,
} from "./pg";
export {
  classifyStatement,
  leadingSqlKeyword,
  looksLikePotentialWrite,
} from "./sql";
export type { StatementClassification } from "./sql";
export type { InstrumentDbClientOptions } from "./instrument-shared";
export {
  instrumentMysqlClient,
  type DuckTypedMysqlClient,
  type DuckTypedMysqlResultHeader,
} from "./mysql";
export {
  instrumentMssqlPool,
  type DuckTypedMssqlPool,
  type DuckTypedMssqlRequest,
  type DuckTypedMssqlResult,
} from "./mssql";
export {
  instrumentSqliteDatabase,
  type DuckTypedSqliteDatabase,
  type DuckTypedSqliteRunResult,
  type DuckTypedSqliteStatement,
} from "./sqlite";

export interface DbRequestContext {
  requestId: string;
  sessionId?: string;
}

/**
 * Resolves the `db.diff` request scope from the SAME inputs `backend.req.*` events use — the
 * `X-Crumbtrail-Request-Id` / `X-Crumbtrail-Session-Id` headers (where the request id already equals
 * the W3C trace id) or explicit options. This guarantees a `db.diff` produced inside a request
 * shares the request's requestId, instead of inventing a parallel correlation scheme.
 */
export function resolveDbRequestContext(
  input: BackendRequestEventInput,
): DbRequestContext {
  const correlation = resolveBackendRequestCorrelation(input);
  return {
    requestId: correlation.requestId,
    ...(correlation.sessionId ? { sessionId: correlation.sessionId } : {}),
  };
}
