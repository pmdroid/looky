/**
 * Language-agnostic lexical heuristics for definitions and references. They
 * complement the symbols the indexer records for TypeScript/JavaScript, so
 * other languages and nested declarations can still be followed. Results are
 * candidates for retrieval, never evidence by themselves.
 */
import type { EvidenceKind } from "../contract/ports";
import { identifierKey } from "./query";

const KEYWORDS = new Set(
  (
    "if else for while do switch case catch try finally return throw new typeof instanceof " +
    "await async yield function class interface type enum const let var import export from " +
    "default extends implements super this null undefined true false void delete in of as is " +
    "def fn func struct trait impl pub mod use self cls elif lambda pass raise with not and or " +
    "print len str int float bool dict list set map get has push pop then catch require module " +
    "describe test it expect beforeEach afterEach beforeAll afterAll string number boolean " +
    "object symbol bigint unknown never any readonly public private protected static override " +
    "abstract declare keyof infer satisfies constructor console log error warn info debug json " +
    "parse stringify promise resolve reject array assign keys values entries slice splice join " +
    "split trim replace match test includes length filter some every reduce find sort concat"
  ).split(" "),
);

const NAME = "([A-Za-z_$][\\w$]*)";

const DEFINITION_PATTERNS: readonly RegExp[] = [
  new RegExp(
    `(?:^|[^\\w$.])(?:function\\s*\\*?|class|interface|type|enum|struct|trait|def|fn|func|const|let|var|val|module|namespace|macro)\\s+${NAME}`,
    "gm",
  ),
  // Go methods: func (r *Receiver) Name(
  new RegExp(`\\bfunc\\s*\\([^)]*\\)\\s*${NAME}`, "gm"),
  // Class and object methods: `async name(args): T {`
  new RegExp(
    `^\\s*(?:export\\s+)?(?:(?:public|private|protected|static|async|readonly|override|get|set)\\s+)*${NAME}\\s*\\([^)]*\\)\\s*(?::[^={;]*)?\\{`,
    "gm",
  ),
  // Functions assigned to names: `name = async (x) =>`, `name: function`
  new RegExp(
    `(?:^|[\\s,{(])${NAME}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*(?::[^=]*)?=>|[A-Za-z_$][\\w$]*\\s*=>)`,
    "gm",
  ),
];

/** Keys and settings: `maxAttempts: 3`, `"retry": {`, `RETRY_LIMIT=3`. */
const CONFIG_KEY = /^\s*["']?([A-Za-z_][\w-]*)["']?\s*[:=]/gm;

/** Import and re-export statements name identifiers without defining them. */
const IMPORT_STATEMENT =
  /^\s*(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+(?:\s*,\s*\{[^}]*\})?)\s+from\s+["'][^"']*["'];?|^\s*from\s+[\w.]+\s+import\s+[^\n]*|^\s*(?:import|use)\s+[^\n]*$/gm;

/** Spelling-independent keys of identifiers that `text` appears to define. */
export function definedKeys(text: string, kind: EvidenceKind): Set<string> {
  const keys = new Set<string>();
  const body = text.replace(IMPORT_STATEMENT, "");
  const patterns = kind === "config" ? [...DEFINITION_PATTERNS, CONFIG_KEY] : DEFINITION_PATTERNS;
  for (const pattern of patterns) {
    for (const match of body.matchAll(pattern)) {
      const name = match[1]!;
      if (!KEYWORDS.has(name) && !KEYWORDS.has(name.toLowerCase())) keys.add(identifierKey(name));
    }
  }
  return keys;
}

/** True when `text` defines an identifier with the same key as `identifier`. */
export function definesIdentifier(text: string, kind: EvidenceKind, identifier: string): boolean {
  return definedKeys(text, kind).has(identifierKey(identifier));
}

/** True when `text` contains a whole-word mention of any spelling of the identifier. */
export function mentionsIdentifier(text: string, spellings: readonly string[]): boolean {
  return spellings.some((spelling) =>
    new RegExp(`(?:^|[^\\w$])${escapeRegExp(spelling)}(?![\\w$])`, "i").test(text),
  );
}

export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Runtime globals and standard library names that are never defined in the repository. */
const GLOBALS = new Set(
  (
    "Number Object Array Math JSON Promise Date RegExp String Boolean Symbol BigInt Error " +
    "TypeError RangeError AbortController AbortSignal Buffer Map Set WeakMap WeakSet URL " +
    "URLSearchParams TextDecoder TextEncoder Headers Request Response Bun Deno process crypto " +
    "console globalThis window document setTimeout setInterval clearTimeout clearInterval " +
    "setImmediate queueMicrotask structuredClone parseInt parseFloat isNaN isFinite fetch " +
    "require Worker MessageEvent EventTarget Intl Reflect Proxy"
  ).split(" "),
);

export type ReferenceSource = "repo_import" | "import" | "call" | "member_call";

export interface ReferencedIdentifier {
  readonly name: string;
  readonly source: ReferenceSource;
}

const CALL = new RegExp(`(?:^|[^\\w$.])${NAME}\\s*\\(`, "gm");
const MEMBER_CALL = new RegExp(`\\.${NAME}\\s*\\(`, "gm");
const NAMED_IMPORT =
  /\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*["']([^"']*)["']/g;
const DEFAULT_IMPORT = /\bimport\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s+from\s*["']([^"']*)["']/g;
const PY_IMPORT = /^\s*from\s+([\w.]+)\s+import\s+([\w, ]+)/gm;

const SOURCE_RANK: Readonly<Record<ReferenceSource, number>> = {
  repo_import: 0,
  call: 1,
  import: 2,
  member_call: 3,
};

/**
 * Identifiers a code range uses but may not define: names imported from the
 * repository, other imports, called functions and called methods, without
 * runtime globals. Ordered by source (repository imports first), then by first use.
 */
export function referencedIdentifiers(text: string): ReferencedIdentifier[] {
  const seen = new Map<string, { name: string; source: ReferenceSource; order: number }>();
  const add = (raw: string, source: ReferenceSource, order: number) => {
    const name = raw
      .trim()
      .replace(/^type\s+/, "")
      .split(/\s+as\s+/)[0]!
      .trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(name) || name.length < 4 || GLOBALS.has(name)) return;
    if (KEYWORDS.has(name) || KEYWORDS.has(name.toLowerCase())) return;
    const key = identifierKey(name);
    const existing = seen.get(key);
    if (!existing || SOURCE_RANK[source] < SOURCE_RANK[existing.source]) {
      seen.set(key, { name, source, order: existing?.order ?? order });
    }
  };
  const isRepoModule = (module: string) => module.startsWith(".") || module.startsWith("/");
  for (const match of text.matchAll(NAMED_IMPORT)) {
    const source = isRepoModule(match[2]!) ? "repo_import" : "import";
    for (const name of match[1]!.split(",")) add(name, source, match.index);
  }
  for (const match of text.matchAll(DEFAULT_IMPORT)) {
    add(match[1]!, isRepoModule(match[2]!) ? "repo_import" : "import", match.index);
  }
  for (const match of text.matchAll(PY_IMPORT)) {
    const source = match[1]!.startsWith(".") ? "repo_import" : "import";
    for (const name of match[2]!.split(",")) add(name, source, match.index);
  }
  // Calls are taken from code only: words before "(" in comments and strings are prose.
  const code = text
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1")
    .replace(/^\s*#[^\n]*/gm, "")
    .replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
  for (const match of code.matchAll(CALL)) add(match[1]!, "call", match.index);
  for (const match of code.matchAll(MEMBER_CALL)) add(match[1]!, "member_call", match.index);
  return [...seen.values()]
    .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source] || a.order - b.order)
    .map(({ name, source }) => ({ name, source }));
}

/** Identifiers that prose mentions as code: backticked names and compound identifiers. */
export function documentedIdentifiers(text: string): string[] {
  const names = new Map<string, string>();
  for (const match of text.matchAll(/`([A-Za-z_$][\w$]*)(?:\(\))?`/g)) {
    const name = match[1]!;
    if (name.length >= 4 && !KEYWORDS.has(name)) names.set(identifierKey(name), name);
  }
  for (const match of text.matchAll(/\b([a-z]+(?:[A-Z][a-z0-9]+)+|[a-z]+(?:_[a-z0-9]+)+)\b/g)) {
    const name = match[1]!;
    if (!names.has(identifierKey(name))) names.set(identifierKey(name), name);
  }
  return [...names.values()];
}
