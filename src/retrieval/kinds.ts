import type { EvidenceKind } from "../contract/ports";

const TEST_PATH =
  /(?:^|\/)(?:tests?|__tests__|specs?|e2e|testdata|fixtures)\/|\.(?:test|spec)\.[A-Za-z0-9]+$|_test\.[A-Za-z0-9]+$|(?:^|\/)test_[^/]+\.py$/i;
const DOCS_PATH = /(?:^|\/)(?:docs?|documentation|adr|adrs)\//i;
const DOCS_NAME = /^(?:readme|changelog|contributing|architecture|design|license|notice)(?:\.|$)/i;
const DOCS_EXTENSION = /\.(?:md|mdx|markdown|rst|adoc|txt)$/i;
const CONFIG_LANGUAGES = new Set(["json", "yaml", "toml", "dockerfile", "make"]);
const CONFIG_NAME =
  /(?:^|\.)(?:config|conf|rc)\.[A-Za-z0-9]+$|^\.[A-Za-z0-9_.-]*rc$|^(?:package\.json|tsconfig[^/]*\.json|mise\.toml|\.gitignore|\.gitattributes|\.editorconfig)$|\.(?:ini|cfg|conf|properties|env\.example)$/i;

/** Classify an indexed file as code, test, config or docs from its path and language. */
export function evidenceKind(path: string, language: string): EvidenceKind {
  const name = path.split("/").at(-1) ?? path;
  if (TEST_PATH.test(path)) return "test";
  if (language === "markdown" || DOCS_EXTENSION.test(name) || DOCS_NAME.test(name)) return "docs";
  if (DOCS_PATH.test(path) && language === "text") return "docs";
  if (path.startsWith(".github/") || CONFIG_LANGUAGES.has(language) || CONFIG_NAME.test(name)) {
    return "config";
  }
  return "code";
}
