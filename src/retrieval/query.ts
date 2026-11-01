/**
 * Turns a natural-language or identifier-heavy question into lexical search
 * signals: whole identifiers and their common spellings, path references,
 * content words with light stemming, and a small table of code synonyms.
 * No model or embedding is involved; everything here is deterministic.
 */

/** A question concept: one content word and the forms that count as a mention of it. */
export interface Concept {
  readonly word: string;
  /** Lowercase forms that count as a mention, matched as substrings of lowercased text. */
  readonly forms: readonly string[];
  /** Exact FTS terms for the word and its synonyms. */
  readonly terms: readonly string[];
  /** FTS prefix terms (stems), matched as `"stem"*`. */
  readonly prefixes: readonly string[];
  /** Groups of FTS terms that must all occur, such as the parts of a compound. */
  readonly allOf?: readonly (readonly string[])[];
}

export interface IdentifierRef {
  /** As written in the question, or derived from adjacent words. */
  readonly raw: string;
  /** Lowercase parts: `getUserById` -> get, user, by, id. */
  readonly parts: readonly string[];
  /** camelCase, PascalCase, snake_case, SCREAMING_SNAKE and kebab-case spellings. */
  readonly spellings: readonly string[];
  /** Spelling-independent key: parts joined without separators. */
  readonly key: string;
  /** True when written as an identifier; false when derived from adjacent words. */
  readonly explicit: boolean;
}

export interface QueryAnalysis {
  readonly identifiers: readonly IdentifierRef[];
  /** Path-like references such as `src/ask/session.ts` or `session.ts`. */
  readonly paths: readonly string[];
  /** File-name fragments such as `user-service`, matched inside paths. */
  readonly pathFragments: readonly string[];
  readonly concepts: readonly Concept[];
}

const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are as at be because been before " +
    "being between both but by can could did do does doing done during each either else ever " +
    "every few for from further had has have having he her here hers how i if in into is it its " +
    "itself just let like may me might more most much must my no nor not now of off on once only " +
    "or other our out over own same shall she should so some such than that the their them then " +
    "there these they this those through to too under until up upon us very via was we were what " +
    "when where whether which while who whom whose why will with within without would yes yet you " +
    "your " +
    // Question scaffolding that says nothing about the code.
    "code codebase repo repository project explain describe tell show happen happens happening " +
    "work works working handle handled handles handling implement implemented implementation " +
    "function functions method methods file files thing things way part use used uses using " +
    "exactly actually really please mean means stuff look looks someone somewhere"
  ).split(" "),
);

/**
 * Small, conservative table of words engineers use interchangeably. A
 * question word adds its group as alternatives; ranking still prefers chunks
 * that mention more of the question's own concepts.
 */
const SYNONYM_GROUPS: readonly (readonly string[])[] = [
  ["error", "exception", "throw", "fail", "failure", "reject"],
  ["remove", "delete", "drop", "purge", "cleanup", "evict"],
  ["fetch", "load", "read", "lookup", "retrieve"],
  ["create", "insert", "add"],
  ["config", "configuration", "settings", "options", "env"],
  ["auth", "authorize", "authorization", "permission", "access"],
  ["cancel", "abort"],
  ["retry", "backoff", "attempt"],
  ["start", "boot", "launch", "spawn"],
  ["save", "persist", "store", "write"],
  ["check", "validate", "verify"],
  ["limit", "budget", "quota", "cap"],
  ["restart", "recover", "recovery", "resume"],
  ["test", "spec"],
  ["timeout", "deadline", "elapsed"],
  ["user", "account"],
];

/**
 * Phrasal verbs and nouns that code spells closed: "starts up" is `startup`,
 * "in flight" is `inFlight`. Their particles are stopwords, so without this
 * the closed spelling is never searched.
 */
const PHRASAL_COMPOUNDS: readonly (readonly [RegExp, readonly [string, string]])[] = [
  [/\bstart(?:s|ed|ing)?\s+up\b/, ["start", "up"]],
  [/\bshut(?:s|ting)?\s+down\b/, ["shut", "down"]],
  [/\bin[\s-]+flight\b/, ["in", "flight"]],
  [/\bset(?:s|ting)?\s+up\b/, ["set", "up"]],
  [/\bclean(?:s|ed|ing)?\s+up\b/, ["clean", "up"]],
  [/\blook(?:s|ed|ing)?\s+up\b/, ["look", "up"]],
  [/\bcheck(?:s|ed|ing)?\s+out\b/, ["check", "out"]],
  [/\btime(?:s|d)?\s+out\b/, ["time", "out"]],
  [/\bback(?:s|ed|ing)?\s+off\b/, ["back", "off"]],
  [/\bfall(?:s|ing)?\s+back\b/, ["fall", "back"]],
  [/\broll(?:s|ed|ing)?\s+back\b/, ["roll", "back"]],
  [/\blog(?:s|ged|ging)?\s+in\b/, ["log", "in"]],
  [/\bsign(?:s|ed|ing)?\s+in\b/, ["sign", "in"]],
  [/\b(?:wake|wakes|woke)\s+up\b/, ["wake", "up"]],
];

/**
 * The concept for a phrasal compound: its closed spelling (`startup`) as a
 * term, its snake and kebab spellings as mentions, and its two parts as an
 * all-of group, because compound identifiers index their parts separately
 * (`listInFlightItems` is searchable as `in` and `flight`).
 */
function compoundConcept(parts: readonly [string, string]): Concept {
  const word = parts.join("");
  return {
    word,
    forms: [word, parts.join("_"), parts.join("-"), parts.join(" ")],
    terms: [word],
    prefixes: [],
    allOf: [parts],
  };
}

const SYNONYMS = new Map<string, readonly string[]>();
for (const group of SYNONYM_GROUPS) {
  for (const word of group) SYNONYMS.set(word, group);
}

/** Lowercase identifier parts: camelCase, PascalCase, snake_case, kebab-case and digits. */
export function identifierParts(identifier: string): string[] {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.toLowerCase());
}

/** Spelling-independent identifier key: `getUserById` and `get_user_by_id` both give `getuserbyid`. */
export function identifierKey(identifier: string): string {
  return identifierParts(identifier).join("");
}

function capitalize(part: string): string {
  return part.charAt(0).toUpperCase() + part.slice(1);
}

/** Common spellings of one identifier from its parts. */
export function identifierSpellings(parts: readonly string[]): string[] {
  if (parts.length === 0) return [];
  const camel = parts[0]! + parts.slice(1).map(capitalize).join("");
  return [
    ...new Set([
      camel,
      parts.map(capitalize).join(""),
      parts.join("_"),
      parts.join("_").toUpperCase(),
      parts.join("-"),
    ]),
  ];
}

/** Light suffix stripping so `retries`, `loading` and `recovered` meet their roots. */
export function stem(word: string): string {
  const rules: readonly [string, string][] = [
    ["ations", ""],
    ["ation", ""],
    ["ings", ""],
    ["ing", ""],
    ["ies", ""],
    ["ied", ""],
    ["ers", ""],
    ["er", ""],
    ["es", ""],
    ["ed", ""],
    ["s", ""],
    ["y", ""],
  ];
  for (const [suffix, replacement] of rules) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 4) {
      return word.slice(0, word.length - suffix.length) + replacement;
    }
  }
  return word;
}

/** File extensions that name a configuration format, a meaningful word in a question. */
const CONFIG_EXTENSIONS = new Set(["toml", "yaml", "yml", "json", "ini", "env", "conf"]);

const PATH_EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,5}$/;
const TOKEN = /[A-Za-z0-9_$./-]+/g;

function looksLikePath(token: string): boolean {
  if (token.includes("://")) return false;
  if (token.includes("/")) return /[A-Za-z]/.test(token) && !token.startsWith("//");
  // A bare file name with an extension, such as `session.ts` or `README.md`.
  return /^[A-Za-z0-9_$-][A-Za-z0-9_.$-]*$/.test(token) && PATH_EXTENSION.test(token);
}

function isExplicitIdentifier(token: string): boolean {
  if (!/^[A-Za-z_$][\w$-]*$/.test(token)) return false;
  if (/[a-z0-9][A-Z]/.test(token)) return true; // camelCase / PascalCase
  if (/[A-Za-z0-9]_[A-Za-z0-9]/.test(token)) return true; // snake_case
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(token)) return true; // kebab-case
  return false;
}

function identifierRef(raw: string, explicit: boolean): IdentifierRef | undefined {
  const parts = identifierParts(raw);
  if (parts.length === 0) return undefined;
  return { raw, parts, spellings: identifierSpellings(parts), key: parts.join(""), explicit };
}

function conceptFor(word: string): Concept {
  const group = SYNONYMS.get(word) ?? [word];
  const terms = new Set<string>([word, ...group]);
  const prefixes = new Set<string>();
  const forms = new Set<string>();
  for (const term of terms) {
    const root = stem(term);
    forms.add(root);
    if (root !== term && root.length >= 4) prefixes.add(root);
  }
  return { word, forms: [...forms], terms: [...terms], prefixes: [...prefixes] };
}

/** Upper bound on derived signals so a long question cannot produce an unbounded query. */
const MAX_CONCEPTS = 16;
const MAX_IDENTIFIERS = 12;
const MAX_PATHS = 6;

/** Analyze a question into bounded lexical search signals. */
export function analyzeQuery(question: string): QueryAnalysis {
  const identifiers = new Map<string, IdentifierRef>();
  const paths = new Set<string>();
  const fragments = new Set<string>();
  const concepts = new Map<string, Concept>();
  const sequence: string[] = [];

  // Phrasal compounds first, so a long question cannot crowd them out.
  const lower = question.toLowerCase();
  for (const [pattern, parts] of PHRASAL_COMPOUNDS) {
    if (concepts.size >= MAX_CONCEPTS || !pattern.test(lower)) continue;
    const concept = compoundConcept(parts);
    concepts.set(concept.word, concept);
  }

  for (const found of question.matchAll(TOKEN)) {
    const match = found[0];
    // A capitalized word opening a sentence is prose, not a type name ("Walk through …").
    const sentenceStart = /(?:^|[.?!:]\s*)$/.test(question.slice(0, found.index).trimEnd());
    // Trim sentence punctuation and call parentheses around tokens.
    const token = match.replace(/^[./-]+/, "").replace(/[.\-/]+$/, "");
    if (token.length === 0) continue;

    if (looksLikePath(token)) {
      if (paths.size < MAX_PATHS) paths.add(token.replace(/^\.\//, ""));
      const base = token.split("/").at(-1)!.replace(PATH_EXTENSION, "");
      const ref = identifierRef(base, true);
      if (ref && ref.parts.length > 1 && identifiers.size < MAX_IDENTIFIERS) {
        identifiers.set(ref.key, identifiers.get(ref.key) ?? ref);
      }
      // The file may not be tracked under that name (`~/.app/config.toml`), so its
      // name's words still count as concepts: `config`, and `toml` for config formats.
      const extension = /\.([A-Za-z]+)$/.exec(token)?.[1]?.toLowerCase();
      const words = [...(ref?.parts ?? [])];
      if (extension && CONFIG_EXTENSIONS.has(extension)) words.push(extension);
      for (const word of words) {
        if (word.length < 2 || STOPWORDS.has(word) || concepts.size >= MAX_CONCEPTS) continue;
        if (!concepts.has(word)) concepts.set(word, conceptFor(word));
      }
      sequence.length = 0;
      continue;
    }

    if (isExplicitIdentifier(token)) {
      const ref = identifierRef(token, true);
      if (ref && identifiers.size < MAX_IDENTIFIERS && !identifiers.get(ref.key)?.explicit) {
        identifiers.set(ref.key, ref);
      }
      if (token.includes("-")) fragments.add(token.toLowerCase());
      for (const part of ref?.parts ?? []) {
        if (part.length > 1 && !STOPWORDS.has(part) && concepts.size < MAX_CONCEPTS) {
          if (!concepts.has(part)) concepts.set(part, conceptFor(part));
        }
      }
      sequence.length = 0;
      continue;
    }

    for (const piece of token.split(/[./-]+/)) {
      const word = piece.toLowerCase().replace(/^\$+/, "");
      if (!/^[a-z][a-z0-9_]*$/.test(word) || word.length < 2 || STOPWORDS.has(word)) {
        sequence.length = 0;
        continue;
      }
      // A single PascalCase or ALLCAPS word is still a likely identifier (`Retriever`).
      const capitalized = /^[A-Z][a-z0-9]+$/.test(piece) && !sentenceStart;
      // A capitalized prose word is often a product or proper name ("Paws"), so it
      // counts as a derived identifier; ALLCAPS stays explicit (`HTTP_TIMEOUT`).
      const allCaps = /^[A-Z][A-Z0-9_]{2,}$/.test(piece);
      if ((capitalized || allCaps) && identifiers.size < MAX_IDENTIFIERS) {
        const ref = identifierRef(piece, allCaps);
        if (ref && !identifiers.has(ref.key)) identifiers.set(ref.key, ref);
      }
      if (concepts.size < MAX_CONCEPTS && !concepts.has(word)) concepts.set(word, conceptFor(word));
      // Adjacent content words may name a compound identifier: "user service" -> userService.
      sequence.push(word);
      for (const size of [2, 3]) {
        if (sequence.length < size || identifiers.size >= MAX_IDENTIFIERS) continue;
        const ref = identifierRef(sequence.slice(-size).join("-"), false);
        if (ref && !identifiers.has(ref.key)) {
          identifiers.set(ref.key, ref);
          fragments.add(ref.parts.join("-"));
        }
      }
    }
  }

  return {
    identifiers: [...identifiers.values()],
    paths: [...paths],
    pathFragments: [...fragments].slice(0, MAX_IDENTIFIERS),
    concepts: [...concepts.values()],
  };
}

function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** FTS-safe term: letters, digits and underscore only, as the index tokenizer sees them. */
function ftsTerm(term: string): string | undefined {
  const cleaned = term.replace(/[^\p{L}\p{N}_]+/gu, "");
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Build a literal FTS5 expression over all indexed columns: every concept
 * word, its synonyms and stem prefixes, plus every identifier spelling. All
 * user text is quoted, so it is never parsed as FTS5 syntax.
 */
export function ftsExpression(analysis: QueryAnalysis): string | undefined {
  const parts = new Set<string>();
  for (const concept of analysis.concepts) {
    for (const term of concept.terms) {
      const safe = ftsTerm(term);
      if (safe) parts.add(quote(safe));
    }
    for (const prefix of concept.prefixes) {
      const safe = ftsTerm(prefix);
      if (safe && safe.length >= 4) parts.add(`${quote(safe)}*`);
    }
    for (const group of concept.allOf ?? []) {
      const terms = group.map(ftsTerm).filter((term) => term !== undefined);
      if (terms.length > 1) parts.add(`(${terms.map(quote).join(" AND ")})`);
    }
  }
  for (const identifier of analysis.identifiers) {
    for (const spelling of identifier.spellings) {
      const safe = ftsTerm(spelling);
      if (safe) parts.add(quote(safe));
    }
  }
  return parts.size > 0 ? [...parts].join(" OR ") : undefined;
}

/** FTS5 expression for any spelling of one identifier, restricted to one column. */
export function identifierExpression(
  column: "symbols" | "text",
  spellings: readonly string[],
): string | undefined {
  const terms = [...new Set(spellings.map(ftsTerm).filter((term) => term !== undefined))];
  return terms.length > 0 ? `${column} : (${terms.map(quote).join(" OR ")})` : undefined;
}
