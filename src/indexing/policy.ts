/**
 * Index eligibility policy. Every tracked path at a commit is classified here
 * before any of its bytes are read or stored. Paths that are not eligible are
 * recorded with a reason so coverage stays inspectable.
 *
 * Bump {@link INDEX_POLICY_VERSION} whenever eligibility, chunking or symbol
 * extraction changes. Builds made under another version are never served;
 * the catalog rebuilds them instead.
 */

export const INDEX_POLICY_VERSION = 1;

export const EXCLUSION_REASONS = [
  /** Path looks like a credential, key or environment file. */
  "secret_path",
  /** Content contains a high-confidence credential pattern. The match is never logged. */
  "secret_content",
  /** Dependency or vendored package directory. */
  "dependency",
  /** Build output, lockfile, minified bundle or file marked as generated. */
  "generated",
  /** Binary by extension, NUL bytes or invalid UTF-8. */
  "binary",
  /** Blob is larger than `maxFileBytes`; it was never read. */
  "oversized",
  /** A line is longer than `maxLineBytes`, typical of minified or data files. */
  "long_lines",
  /** Symbolic link. Looky never follows links out of the tree. */
  "symlink",
  /** Git submodule (gitlink). Its contents are a different repository. */
  "submodule",
  /** Path is unsafe: absolute, traversal, `.git` component or control characters. */
  "unsafe_path",
  /** The blob could not be read from the object database. */
  "unreadable",
  /** File is empty or whitespace only. */
  "empty",
] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];

export interface IndexLimits {
  /** Largest blob, in bytes, that is read and indexed. Larger blobs are excluded as oversized. */
  readonly maxFileBytes: number;
  /** Longest line, in bytes. Files with longer lines are excluded as long_lines. */
  readonly maxLineBytes: number;
  /** Most tracked entries a build will enumerate. More fails the build instead of truncating. */
  readonly maxFiles: number;
  /** Most bytes of source a build will store. More fails the build instead of truncating. */
  readonly maxIndexedBytes: number;
  /** Target chunk size in lines. */
  readonly chunkLines: number;
  /** Hard chunk size bound in bytes. Must be at least `maxLineBytes`. */
  readonly chunkBytes: number;
  /** Lines repeated between consecutive generic chunks. */
  readonly chunkOverlapLines: number;
  /** Blob reads in flight at once. */
  readonly readConcurrency: number;
}

export const DEFAULT_INDEX_LIMITS: IndexLimits = {
  maxFileBytes: 1_048_576,
  maxLineBytes: 4_000,
  maxFiles: 200_000,
  maxIndexedBytes: 1_073_741_824,
  chunkLines: 80,
  chunkBytes: 8_000,
  chunkOverlapLines: 8,
  readConcurrency: 4,
};

function shortHash(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 16);
}

/**
 * Identifies the chunking configuration. Stored chunks are only reused by a
 * build whose chunking limits, strategy and policy version are identical.
 */
export function chunkingKey(limits: IndexLimits): string {
  return shortHash(
    JSON.stringify([limits.chunkLines, limits.chunkBytes, limits.chunkOverlapLines]),
  );
}

/**
 * The index/chunk schema version a build is keyed by: the policy version plus
 * every limit that changes which files are indexed or how they are chunked.
 * A ready build is only served, and only used as a refresh base, under the
 * same key. Limits that only bound work (`maxFiles`, `maxIndexedBytes`,
 * `readConcurrency`) are not part of it.
 */
export function indexKey(limits: IndexLimits): string {
  return `p${INDEX_POLICY_VERSION}-${shortHash(
    JSON.stringify([
      limits.maxFileBytes,
      limits.maxLineBytes,
      limits.chunkLines,
      limits.chunkBytes,
      limits.chunkOverlapLines,
    ]),
  )}`;
}

export function validateLimits(limits: IndexLimits): void {
  for (const [name, value] of Object.entries(limits)) {
    const minimum = name === "chunkOverlapLines" ? 0 : 1;
    if (!Number.isSafeInteger(value) || value < minimum) {
      throw new Error(`Index limit ${name} must be an integer of at least ${minimum}`);
    }
  }
  if (limits.chunkBytes < limits.maxLineBytes) {
    throw new Error("Index limit chunkBytes must be at least maxLineBytes");
  }
  if (limits.chunkOverlapLines >= limits.chunkLines) {
    throw new Error("Index limit chunkOverlapLines must be below chunkLines");
  }
}

export type Classification =
  | { readonly eligible: true; readonly language: string }
  | { readonly eligible: false; readonly reason: ExclusionReason };

// ---------------------------------------------------------------------------
// Path rules

const DEPENDENCY_DIRS = new Set([
  "node_modules",
  "bower_components",
  "jspm_packages",
  "vendor",
  ".yarn",
  ".pnp",
  ".pnpm-store",
  "Pods",
  "Carthage",
  ".venv",
  "venv",
  "site-packages",
  ".bundle",
]);

const GENERATED_DIRS = new Set([
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".parcel-cache",
  ".output",
  "target",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".terraform",
  ".looky",
]);

const LOCKFILES = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "composer.lock",
  "Gemfile.lock",
  "Cargo.lock",
  "poetry.lock",
  "Pipfile.lock",
  "uv.lock",
  "go.sum",
  "mix.lock",
  "Podfile.lock",
  "packages.lock.json",
  "flake.lock",
]);

const SECRET_NAMES = new Set([
  ".npmrc",
  ".pypirc",
  ".netrc",
  "_netrc",
  ".git-credentials",
  ".htpasswd",
  ".pgpass",
  "credentials",
  "credentials.json",
  "credentials.yml",
  "credentials.yaml",
  "secrets.json",
  "secrets.yml",
  "secrets.yaml",
  "secrets.toml",
  "service-account.json",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "known_hosts",
  "authorized_keys",
  "terraform.tfstate",
  "terraform.tfvars",
  ".terraformrc",
  "master.key",
]);

const SECRET_EXTENSIONS = new Set([
  "pem",
  "key",
  "p12",
  "pfx",
  "jks",
  "keystore",
  "kdbx",
  "asc",
  "gpg",
  "pgp",
  "ovpn",
  "crt",
  "cer",
  "der",
  "tfstate",
  "tfvars",
]);

const BINARY_EXTENSIONS = new Set(
  (
    "png jpg jpeg gif bmp ico icns webp avif tif tiff psd heic svgz " +
    "pdf doc docx xls xlsx ppt pptx odt ods odp key numbers pages " +
    "zip gz tgz bz2 xz zst 7z rar tar jar war ear apk ipa aab dmg iso deb rpm msi " +
    "woff woff2 ttf otf eot " +
    "mp3 mp4 m4a m4v mov avi mkv webm wav flac ogg oga opus aac " +
    "exe dll so dylib a o obj lib class pyc pyo wasm node bin dat " +
    "sqlite sqlite3 db mdb parquet avro orc arrow feather npy npz pkl pickle h5 onnx pt pth"
  ).split(" "),
);

const LANGUAGES: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  json: "json",
  jsonc: "json",
  json5: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  py: "python",
  go: "go",
  rs: "rust",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  css: "css",
  scss: "css",
  html: "html",
  vue: "vue",
  svelte: "svelte",
};

function hasControlCharacter(segment: string): boolean {
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** True for a relative, normalized repository path without traversal or `.git` components. */
export function isSafeRepoPath(path: string): boolean {
  if (path.length === 0 || path.length > 4096) return false;
  if (path.startsWith("/") || path.includes("\\")) return false;
  return path.split("/").every((segment) => {
    if (segment === "" || segment === "." || segment === "..") return false;
    if (segment.toLowerCase() === ".git") return false;
    return !hasControlCharacter(segment);
  });
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** Classify a tracked path by name alone, before reading any bytes. */
export function classifyPath(path: string): Classification {
  if (!isSafeRepoPath(path)) return { eligible: false, reason: "unsafe_path" };
  const segments = path.split("/");
  const name = segments.at(-1)!;
  const lowerName = name.toLowerCase();
  const directories = segments.slice(0, -1);

  if (directories.some((segment) => DEPENDENCY_DIRS.has(segment))) {
    return { eligible: false, reason: "dependency" };
  }
  if (isSecretName(lowerName)) return { eligible: false, reason: "secret_path" };
  if (directories.some((segment) => GENERATED_DIRS.has(segment))) {
    return { eligible: false, reason: "generated" };
  }
  if (LOCKFILES.has(name) || /\.min\.(js|css|mjs)$/i.test(name) || /\.map$/i.test(name)) {
    return { eligible: false, reason: "generated" };
  }
  const extension = extensionOf(lowerName);
  if (BINARY_EXTENSIONS.has(extension)) return { eligible: false, reason: "binary" };
  return { eligible: true, language: LANGUAGES[extension] ?? languageByName(lowerName) };
}

function isSecretName(lowerName: string): boolean {
  if (SECRET_NAMES.has(lowerName)) return true;
  if (lowerName === ".env" || lowerName.startsWith(".env.") || lowerName.endsWith(".env")) {
    return true;
  }
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(lowerName)) return true;
  return SECRET_EXTENSIONS.has(extensionOf(lowerName));
}

function languageByName(lowerName: string): string {
  if (lowerName === "dockerfile" || lowerName.startsWith("dockerfile.")) return "dockerfile";
  if (lowerName === "makefile") return "make";
  return "text";
}

// ---------------------------------------------------------------------------
// Content rules

/**
 * High-confidence credential patterns. A file matching any of them is
 * excluded entirely, so no part of it is stored or sent to a provider.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{32,}\b/,
  /\b(?:rk|sk|pk)_live_[A-Za-z0-9]{20,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\blin_(?:api|oauth)_[A-Za-z0-9]{32,}\b/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /\bhooks\.slack\.com\/services\/T[A-Za-z0-9_/]{20,}/,
  /"private_key"\s*:\s*"-----BEGIN/,
];

/** `scheme://user:password@host` with a password that is not an obvious placeholder. */
const URL_CREDENTIAL = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"'`]+:([^\s@/"'`]{6,})@[^\s"'`]+/g;
const PLACEHOLDER_PASSWORD =
  /^(?:password|passwd|pass|secret|changeme|example|placeholder|redacted|x+|\*+|\.+)$|^[$<{%]/i;

export function containsSecret(text: string): boolean {
  if (SECRET_PATTERNS.some((pattern) => pattern.test(text))) return true;
  for (const match of text.matchAll(URL_CREDENTIAL)) {
    if (!PLACEHOLDER_PASSWORD.test(match[1]!)) return true;
  }
  return false;
}

const GENERATED_MARKER = /@generated\b|\bDO NOT EDIT\b|\bauto-?generated (?:file|code|by)\b/i;

/** A marker in the first lines, as written by common code generators. */
export function hasGeneratedMarker(text: string): boolean {
  let end = 0;
  for (let line = 0; line < 5 && end !== -1; line += 1) end = text.indexOf("\n", end + 1);
  return GENERATED_MARKER.test(end === -1 ? text.slice(0, 2_000) : text.slice(0, end));
}

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type ContentCheck =
  | { readonly eligible: true; readonly text: string }
  | { readonly eligible: false; readonly reason: ExclusionReason };

/** Decide whether read bytes may be indexed. Returns the exact decoded text if so. */
export function checkContent(bytes: Uint8Array, limits: IndexLimits): ContentCheck {
  if (bytes.includes(0)) return { eligible: false, reason: "binary" };
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return { eligible: false, reason: "binary" };
  }
  if (text.trim().length === 0) return { eligible: false, reason: "empty" };
  if (longestLineBytes(bytes) > limits.maxLineBytes) {
    return { eligible: false, reason: "long_lines" };
  }
  if (containsSecret(text)) return { eligible: false, reason: "secret_content" };
  if (hasGeneratedMarker(text)) return { eligible: false, reason: "generated" };
  return { eligible: true, text };
}

function longestLineBytes(bytes: Uint8Array): number {
  let longest = 0;
  let start = 0;
  for (let index = bytes.indexOf(10); index !== -1; index = bytes.indexOf(10, start)) {
    longest = Math.max(longest, index + 1 - start);
    start = index + 1;
  }
  return Math.max(longest, bytes.length - start);
}
