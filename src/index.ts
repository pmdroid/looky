/** Public ask_project contract for Looky clients and engine implementations. */
export * from "./contract/input";
export * from "./contract/context";
export * from "./contract/budgets";
export * from "./contract/response";
export * from "./contract/ports";
export * from "./config";
export { askProject, type AskProjectOptions, type AskProjectServices } from "./ask/ask-project";
export {
  AccessRevokedError,
  BudgetExhaustedError,
  ContractViolationError,
  SessionClosedError,
} from "./ask/session";
export * from "./ask/tool";
export { IndexRetriever, type IndexRetrieverOptions } from "./retrieval/index-retriever";
export { evidenceKind } from "./retrieval/kinds";
export {
  analyzeQuery,
  identifierKey,
  identifierSpellings,
  type QueryAnalysis,
} from "./retrieval/query";
export * from "./retrieval/research";
export { GitSourceReader, SourceRangeError } from "./source/git-source-reader";
export {
  DEFAULT_INDEX_RETENTION,
  IndexAccessDeniedError,
  IndexService,
  type IndexRetention,
  type IndexServiceOptions,
  type StartBuildResult,
} from "./indexing/index-service";
export {
  DEFAULT_INDEX_LIMITS,
  EXCLUSION_REASONS,
  INDEX_POLICY_VERSION,
  indexKey,
  type ExclusionReason,
  type IndexLimits,
} from "./indexing/policy";
export {
  coverageReport,
  getBuild,
  IndexNotReadyError,
  listBuilds,
  listChunks,
  scopeStatus,
  searchChunks,
  type BuildRecord,
  type BuildState,
  type CoverageReport,
  type GarbageReport,
  type IndexedChunk,
  type RefreshReport,
  type ScopeState,
  type ScopeStatus,
} from "./indexing/store";
export {
  DEFAULT_FOLLOW_UP_LIMITS,
  LookyAnswerEngine,
  type AnswerEngineOptions,
} from "./answer/engine";
export {
  sourceLinkFromTemplate,
  validateCitations,
  type CitedAnswer,
  type SourceLinkBuilder,
} from "./answer/citations";
export { ModelOutputError } from "./answer/model-output";
export {
  ProviderRouter,
  type ProviderEntry,
  type ProviderQuota,
  type ProviderRouterOptions,
} from "./providers/router";
export {
  createHttpProvider,
  DEFAULT_BASE_URLS,
  PROVIDER_KINDS,
  type HttpProviderOptions,
  type ProviderKind,
} from "./providers/http";
export {
  createConfiguredProvider,
  loadProviderConfig,
  providerEnvName,
  type ProviderConfig,
  type ProviderSettings,
} from "./providers/config";
