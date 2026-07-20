/**
 * Public surface of the spec oracle (`knowledge.v1`).
 *
 * Importing this barrel has **no** side effects on the evidence framework. It
 * registers nothing, so `EVIDENCE_SOURCE_PROVIDERS.length` is identical before
 * and after — the counterpart to `evidence-sources/index.ts`, which exists
 * precisely so that importing it *does* populate the registry. The two barrels
 * behaving differently is the point, and CP4's boundary test pins it.
 *
 * This barrel is the INTERNAL surface and is intentionally wider than the
 * published one. `packages/node/src/index.ts` re-exports a deliberate SUBSET:
 * what an SDK consumer needs to construct a client, call it, and read the
 * result. Helpers that exist for this directory and its tests — `htmlToText`,
 * `capExcerptBytes`, `parseSpaceKeysEnv`, the CQL builders, the gap
 * constructors — stay here. Widening the published surface is a compatibility
 * obligation to npm consumers; widening this one costs nothing, so the two are
 * not kept in sync and should not be.
 *
 * @see docs/specs/2026-07-19-confluence-spec-oracle-design.md
 */
export {
  capExcerptBytes,
  confluenceClientFromEnv,
  ConfluenceKnowledgeClient,
  CONFLUENCE_API_TOKEN_ENV,
  CONFLUENCE_AUTH_FIELDS,
  CONFLUENCE_BASE_URL_ENV,
  CONFLUENCE_EMAIL_ENV,
  CONFLUENCE_SPACE_KEYS_ENV,
  DEFAULT_SPEC_LIMIT,
  htmlToText,
  MAX_EXCERPT_BYTES,
  MAX_SPEC_LIMIT,
  notConfiguredKnowledgeResult,
  parseSpaceKeysEnv,
  unexpectedFailureKnowledgeResult,
  unusableInputGap,
  unusableInputKnowledgeResult,
  type ConfluenceClientConfig,
  type SpecSearchRequest,
} from "./confluence";

export {
  buildSpecSearchCql,
  describeCqlInputLoss,
  MAX_QUERY_LENGTH,
  sanitizeCqlText,
  sanitizeSpaceKeys,
  type CqlInputLoss,
  type SpecCqlInput,
  type SpecCqlResult,
} from "./cql";

export {
  isHardKnowledgeGap,
  knowledgeGap,
  KNOWLEDGE_GAP_LANE,
  type KnowledgeGapInput,
  type KnowledgeGapKind,
} from "./gaps";

export {
  deriveAgeDays,
  KNOWLEDGE_SCHEMA_VERSION,
  systemClock,
  type KnowledgeClock,
  type KnowledgeResult,
  type SpecExcerpt,
} from "./types";
