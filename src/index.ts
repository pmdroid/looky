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
  IndexService,
  type IndexServiceOptions,
  type StartBuildResult,
} from "./indexing/index-service";
export {
  DEFAULT_INDEX_LIMITS,
  EXCLUSION_REASONS,
  INDEX_POLICY_VERSION,
  type ExclusionReason,
  type IndexLimits,
} from "./indexing/policy";
export {
  coverageReport,
  getBuild,
  IndexNotReadyError,
  listBuilds,
  listChunks,
  searchChunks,
  type BuildRecord,
  type BuildState,
  type CoverageReport,
  type IndexedChunk,
} from "./indexing/store";
