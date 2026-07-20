/**
 * Public surface of the spec oracle (`knowledge.v1`).
 *
 * Importing this barrel has **no** side effects on the evidence framework. It
 * registers nothing, so `EVIDENCE_SOURCE_PROVIDERS.length` is identical before
 * and after — the counterpart to `evidence-sources/index.ts`, which exists
 * precisely so that importing it *does* populate the registry. The two barrels
 * behaving differently is the point, and CP4's boundary test pins it.
 *
 * This barrel is INTERNAL and is deliberately **not** part of the published SDK
 * surface: `packages/node/src/index.ts` re-exports nothing from `knowledge/`.
 * Its consumers are inside this package — `mcp-server.ts`, which exposes the
 * oracle as an MCP tool, and `doctor.ts`, which reports its configuration — plus
 * this directory's own tests.
 *
 * Because nothing here is published, widening this barrel costs nothing and
 * carries no npm compatibility obligation. Anything that should become a
 * consumer-facing API has to be re-exported from `packages/node/src/index.ts`
 * explicitly, and that is the point at which the compatibility obligation
 * starts.
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
  countDroppedSpaceKeys,
  describeCqlInputLoss,
  MAX_QUERY_LENGTH,
  sanitizeCqlText,
  sanitizeSpaceKeys,
  type CqlInputLoss,
  type SpecCqlInput,
  type SpecCqlResult,
} from "./cql";

export {
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
