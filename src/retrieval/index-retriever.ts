import type { Database } from "bun:sqlite";
import { ContractViolationError } from "../ask/session";
import {
  LookyUnavailableError,
  type EvidenceKind,
  type MatchChannel,
  type RetrievalHit,
  type Retriever,
} from "../contract/ports";
import type { IndexIdentity } from "../contract/response";
import { INDEX_POLICY_VERSION } from "../indexing/policy";
import { IndexAccessDeniedError } from "../indexing/index-service";
import { getBuild } from "../indexing/store";
import { definesIdentifier, mentionsIdentifier } from "./definitions";
import { evidenceKind } from "./kinds";
import {
  analyzeQuery,
  ftsExpression,
  identifierExpression,
  identifierKey,
  identifierParts,
  identifierSpellings,
  type QueryAnalysis,
} from "./query";

/**
 * Lexical retrieval over one ready index generation. It combines path
 * matches, recorded symbols, definition heuristics and BM25-ranked full-text
 * search over code-aware chunks, then reranks by how many of the question's
 * concepts a chunk covers, removes contained duplicates and caps hits per file.
 *
 * Every search is pinned: the generation must be a ready build of exactly the
 * requested repository and SHA under the current index policy. It never falls
 * back to another build, revision or repository.
 */
export interface IndexRetrieverOptions {
  readonly db: Database;
  /**
   * The same authorization callback the IndexService uses. When given, every
   * search first checks that the repository is still authorized, so revoking
   * access stops further index reads even for a generation already pinned.
   */
  readonly repositories?: (repositoryId: string) => string | undefined;
  /** Maximum hits from one file in a single pass. Default 3. */
  readonly maxHitsPerFile?: number;
  /** Upper bound on candidates considered per channel. Default 200. */
  readonly maxCandidates?: number;
}

interface Candidate {
  readonly key: string;
  readonly chunkId: number;
  readonly path: string;
  readonly language: string;
  readonly blobOid: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentHash: string;
  readonly text: string;
  readonly symbols: readonly string[];
  readonly kind: EvidenceKind;
  textScore: number;
  bonus: number;
  symbol?: string;
  readonly channels: Set<MatchChannel>;
}

interface ChunkRow {
  chunk_id: number;
  path: string;
  language: string;
  blob_oid: string;
  start_line: number;
  end_line: number;
  content_hash: string;
  text: string;
  symbols: string;
}

const CHUNK_COLUMNS = `c.id AS chunk_id, f.path, f.language, f.blob_oid, c.start_line,
  c.end_line, c.content_hash, c.text, c.symbols`;

/** Path restriction shared by every channel: ?2 exact path, ?3 LIKE prefix pattern. */
const PATH_FILTER = `(?2 IS NULL OR f.path = ?2 OR f.path LIKE ?3 ESCAPE '\\')`;

function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

const SCORE = {
  /** Explicit identifier matches a recorded symbol. */
  symbolExplicit: 8,
  /** Adjacent question words spell a recorded symbol. */
  symbolDerived: 4,
  /** Definition heuristic matched where no symbol was recorded. */
  definition: 6,
  pathExact: 10,
  pathFragment: 3,
  pathConcept: 1,
  /** Weight of question-concept coverage, 0..1. */
  coverage: 4,
  /** Weight of BM25 relative to the best text match, 0..1. */
  text: 4,
  /**
   * Tests rank below code unless the question asks about them. Their prose
   * names and fixtures match questions closely, so the penalty is firm.
   */
  testKind: -3,
  /** Docs rank slightly below code; they still matter for stale or documented behavior. */
  docsKind: -1,
} as const;

export class IndexRetriever implements Retriever {
  private readonly db: Database;
  private readonly repositories: IndexRetrieverOptions["repositories"];
  private readonly maxHitsPerFile: number;
  private readonly maxCandidates: number;

  constructor(options: IndexRetrieverOptions) {
    this.db = options.db;
    this.repositories = options.repositories;
    this.maxHitsPerFile = options.maxHitsPerFile ?? 3;
    this.maxCandidates = options.maxCandidates ?? 200;
  }

  async search(
    request: Parameters<Retriever["search"]>[0],
    signal: AbortSignal,
  ): Promise<readonly RetrievalHit[]> {
    signal.throwIfAborted();
    this.requireGeneration(request.generation, request.repositoryId);
    const options = request.options ?? {};
    const limit = Math.max(1, Math.floor(request.limit));
    const buildId = request.generation.generationId;
    const prefix = options.pathPrefix?.replace(/\/+$/, "");
    const pathArgs: [string | null, string | null] = prefix
      ? [prefix, `${likeEscape(prefix)}/%`]
      : [null, null];
    // Kind filters apply after ranking, so widen the candidate pool for them.
    const pool = Math.min(this.maxCandidates * (options.kinds ? 3 : 1), 1_000);
    const candidates = new Map<string, Candidate>();

    let analysis: QueryAnalysis;
    if (options.definitionOf !== undefined) {
      analysis = analyzeQuery(options.definitionOf);
      this.definitionChannel(buildId, pathArgs, options.definitionOf, pool, candidates);
    } else if (options.referencesOf !== undefined) {
      analysis = analyzeQuery(request.query);
      this.referenceChannel(buildId, pathArgs, options.referencesOf, pool, candidates);
    } else {
      analysis = analyzeQuery(request.query);
      this.pathChannel(buildId, pathArgs, analysis, candidates);
      this.symbolChannel(buildId, pathArgs, analysis, pool, candidates);
      this.textChannel(buildId, pathArgs, analysis, pool, candidates);
    }
    signal.throwIfAborted();

    const excluded = new Set(options.excludePaths ?? []);
    const kinds = options.kinds ? new Set(options.kinds) : undefined;
    const ranked = [...candidates.values()]
      .filter((candidate) => !excluded.has(candidate.path))
      .filter((candidate) => !kinds || kinds.has(candidate.kind))
      .map((candidate) => ({ candidate, score: this.score(candidate, analysis) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          a.candidate.path.localeCompare(b.candidate.path) ||
          a.candidate.startLine - b.candidate.startLine,
      );

    const selected: { candidate: Candidate; score: number }[] = [];
    const perFile = new Map<string, number>();
    for (const entry of ranked) {
      if (selected.length >= limit) break;
      const { candidate } = entry;
      if ((perFile.get(candidate.path) ?? 0) >= this.maxHitsPerFile) continue;
      // A hit inside a better-ranked hit of the same file adds nothing new.
      const contained = selected.some(
        ({ candidate: other }) =>
          other.path === candidate.path &&
          other.startLine <= candidate.startLine &&
          candidate.endLine <= other.endLine,
      );
      if (contained) continue;
      perFile.set(candidate.path, (perFile.get(candidate.path) ?? 0) + 1);
      selected.push(entry);
    }

    return selected.map(({ candidate, score }) => ({
      generationId: buildId,
      repositoryId: request.repositoryId,
      sha: request.generation.sha,
      path: candidate.path,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      ...((candidate.symbol ?? candidate.symbols[0])
        ? { symbol: candidate.symbol ?? candidate.symbols[0]! }
        : {}),
      score: Math.round(score * 1000) / 1000,
      preview: candidate.text,
      contentHash: candidate.contentHash,
      blobOid: candidate.blobOid,
      kind: candidate.kind,
      language: candidate.language,
      symbols: candidate.symbols,
      matchedBy: [...candidate.channels],
    }));
  }

  /** The generation must be a ready build of exactly this repository and SHA. */
  private requireGeneration(generation: IndexIdentity, repositoryId: string): void {
    if (this.repositories && this.repositories(repositoryId) === undefined) {
      throw new IndexAccessDeniedError(`Repository ${repositoryId} is not authorized`);
    }
    const build = getBuild(this.db, generation.generationId);
    if (!build) {
      throw new LookyUnavailableError(`Index generation ${generation.generationId} is unavailable`);
    }
    if (build.repositoryId !== repositoryId || build.sha !== generation.sha) {
      throw new ContractViolationError(
        `Index generation ${generation.generationId} belongs to ${build.repositoryId}@${build.sha}, ` +
          `not ${repositoryId}@${generation.sha}`,
      );
    }
    if (build.state !== "ready" || build.policyVersion !== INDEX_POLICY_VERSION) {
      throw new LookyUnavailableError(
        `Index generation ${generation.generationId} is not a ready build under the current policy`,
      );
    }
  }

  private score(candidate: Candidate, analysis: QueryAnalysis): number {
    const haystack = `${candidate.path}\n${candidate.text}`.toLowerCase();
    const concepts = analysis.concepts;
    let covered = 0;
    let inPath = 0;
    const path = candidate.path.toLowerCase();
    for (const concept of concepts) {
      if (concept.forms.some((form) => haystack.includes(form))) covered += 1;
      if (concept.forms.some((form) => path.includes(form))) inPath += 1;
    }
    const coverage = concepts.length > 0 ? covered / concepts.length : 0;
    const asked = new Set(concepts.map((concept) => concept.word));
    const kindPenalty =
      candidate.kind === "test" &&
      !["test", "tests", "spec", "specs", "tested"].some((w) => asked.has(w))
        ? SCORE.testKind
        : candidate.kind === "docs" &&
            !["doc", "docs", "documentation", "documented", "readme"].some((w) => asked.has(w))
          ? SCORE.docsKind
          : 0;
    return (
      kindPenalty +
      candidate.textScore * SCORE.text +
      coverage * SCORE.coverage +
      Math.min(inPath, 2) * SCORE.pathConcept +
      candidate.bonus
    );
  }

  private add(row: ChunkRow, channel: MatchChannel, into: Map<string, Candidate>): Candidate {
    const key = `${row.path}\0${row.chunk_id}`;
    let candidate = into.get(key);
    if (!candidate) {
      candidate = {
        key,
        chunkId: row.chunk_id,
        path: row.path,
        language: row.language,
        blobOid: row.blob_oid,
        startLine: row.start_line,
        endLine: row.end_line,
        contentHash: row.content_hash,
        text: row.text,
        symbols: row.symbols === "" ? [] : row.symbols.split(" "),
        kind: evidenceKind(row.path, row.language),
        textScore: 0,
        bonus: 0,
        channels: new Set(),
      };
      into.set(key, candidate);
    }
    candidate.channels.add(channel);
    return candidate;
  }

  private ftsRows(
    buildId: string,
    pathArgs: [string | null, string | null],
    match: string,
    limit: number,
  ): (ChunkRow & { rank: number })[] {
    return this.db
      .query<ChunkRow & { rank: number }, [string, string | null, string | null, string, number]>(
        `SELECT ${CHUNK_COLUMNS}, -bm25(index_chunks_fts, 4.0, 1.0, 2.0) AS rank
         FROM index_chunks_fts
         JOIN index_chunks c ON c.id = index_chunks_fts.rowid
         JOIN index_files f ON f.content_id = c.content_id AND f.build_id = ?1
         WHERE index_chunks_fts MATCH ?4 AND f.status = 'indexed' AND ${PATH_FILTER}
         ORDER BY rank DESC, f.path, c.ordinal
         LIMIT ?5`,
      )
      .all(buildId, pathArgs[0], pathArgs[1], match, limit);
  }

  /** Ranked full-text search over symbols, identifier parts and chunk text. */
  private textChannel(
    buildId: string,
    pathArgs: [string | null, string | null],
    analysis: QueryAnalysis,
    pool: number,
    into: Map<string, Candidate>,
  ): void {
    const match = ftsExpression(analysis);
    if (!match) return;
    const rows = this.ftsRows(buildId, pathArgs, match, pool);
    const best = rows[0]?.rank ?? 0;
    for (const row of rows) {
      const candidate = this.add(row, "text", into);
      candidate.textScore = Math.max(candidate.textScore, best > 0 ? row.rank / best : 0);
    }
  }

  /** Recorded declarations whose names match an identifier in any common spelling. */
  private symbolChannel(
    buildId: string,
    pathArgs: [string | null, string | null],
    analysis: QueryAnalysis,
    pool: number,
    into: Map<string, Candidate>,
  ): void {
    for (const identifier of analysis.identifiers) {
      const match = identifierExpression("symbols", identifier.spellings);
      if (!match) continue;
      for (const row of this.ftsRows(buildId, pathArgs, match, pool)) {
        const symbols = row.symbols === "" ? [] : row.symbols.split(" ");
        const symbol = symbols.find((name) => identifierKey(name) === identifier.key);
        if (!symbol) continue;
        const candidate = this.add(row, "symbol", into);
        const bonus = identifier.explicit ? SCORE.symbolExplicit : SCORE.symbolDerived;
        if (bonus > candidate.bonus) candidate.bonus = bonus;
        candidate.symbol ??= symbol;
      }
    }
  }

  /** Chunks that define `name`: recorded symbols first, then the definition heuristic. */
  private definitionChannel(
    buildId: string,
    pathArgs: [string | null, string | null],
    name: string,
    pool: number,
    into: Map<string, Candidate>,
  ): void {
    const key = identifierKey(name);
    const spellings = identifierSpellings(identifierParts(name));
    for (const column of ["symbols", "text"] as const) {
      const match = identifierExpression(column, [name, ...spellings]);
      if (!match) continue;
      for (const row of this.ftsRows(buildId, pathArgs, match, pool)) {
        const symbols = row.symbols === "" ? [] : row.symbols.split(" ");
        const symbol = symbols.find((entry) => identifierKey(entry) === key);
        const kind = evidenceKind(row.path, row.language);
        if (!symbol && !definesIdentifier(row.text, kind, name)) continue;
        const candidate = this.add(row, "definition", into);
        candidate.bonus = Math.max(
          candidate.bonus,
          symbol ? SCORE.symbolExplicit : SCORE.definition,
        );
        candidate.textScore = Math.max(candidate.textScore, kind === "code" ? 1 : 0.5);
        candidate.symbol ??= symbol ?? name;
      }
    }
  }

  /** Chunks that mention `name` without defining it: call sites, imports, tests, docs. */
  private referenceChannel(
    buildId: string,
    pathArgs: [string | null, string | null],
    name: string,
    pool: number,
    into: Map<string, Candidate>,
  ): void {
    const spellings = [name, ...identifierSpellings(identifierParts(name))];
    const match = identifierExpression("text", spellings);
    if (!match) return;
    const rows = this.ftsRows(buildId, pathArgs, match, pool);
    const best = rows[0]?.rank ?? 0;
    for (const row of rows) {
      const kind = evidenceKind(row.path, row.language);
      const symbols = row.symbols === "" ? [] : row.symbols.split(" ");
      const key = identifierKey(name);
      if (symbols.some((symbol) => identifierKey(symbol) === key)) continue;
      if (definesIdentifier(row.text, kind, name) || !mentionsIdentifier(row.text, spellings)) {
        continue;
      }
      const candidate = this.add(row, "reference", into);
      candidate.textScore = Math.max(candidate.textScore, best > 0 ? row.rank / best : 0);
    }
  }

  /** Files named in the question, by exact path, path suffix or file-name fragment. */
  private pathChannel(
    buildId: string,
    pathArgs: [string | null, string | null],
    analysis: QueryAnalysis,
    into: Map<string, Candidate>,
  ): void {
    const files = new Map<string, number>();
    const findFiles = this.db.query<
      { path: string },
      [string, string | null, string | null, string, string]
    >(
      `SELECT f.path FROM index_files f
       WHERE f.build_id = ?1 AND f.status = 'indexed' AND ${PATH_FILTER}
         AND (f.path = ?4 OR f.path LIKE ?5 ESCAPE '\\')
       ORDER BY length(f.path), f.path LIMIT 20`,
    );
    for (const path of analysis.paths) {
      for (const row of findFiles.all(
        buildId,
        pathArgs[0],
        pathArgs[1],
        path,
        `%/${likeEscape(path)}`,
      )) {
        files.set(row.path, Math.max(files.get(row.path) ?? 0, SCORE.pathExact));
      }
    }
    for (const fragment of analysis.pathFragments) {
      // `_` matches the separator, so `linear-webhook` also finds `linear/webhook.ts`.
      const pattern = `%${likeEscape(fragment).replaceAll("-", "_")}%`;
      for (const row of findFiles.all(buildId, pathArgs[0], pathArgs[1], fragment, pattern)) {
        // Only the file name, or its directory and name (`linear/webhook.ts` for
        // `linear-webhook`), counts, so `user-service` does not match every file under a directory.
        const segments = row.path.toLowerCase().split("/");
        const name = segments.at(-1)!;
        const tail = segments.slice(-2).join("-");
        if (!name.includes(fragment) && !tail.includes(fragment)) continue;
        files.set(row.path, Math.max(files.get(row.path) ?? 0, SCORE.pathFragment));
      }
    }
    if (files.size === 0) return;
    const chunksOf = this.db.query<ChunkRow, [string, string]>(
      `SELECT ${CHUNK_COLUMNS}
       FROM index_files f JOIN index_chunks c ON c.content_id = f.content_id
       WHERE f.build_id = ?1 AND f.path = ?2 AND f.status = 'indexed'
       ORDER BY c.ordinal LIMIT 500`,
    );
    for (const [path, bonus] of [...files.entries()].slice(0, 10)) {
      for (const row of chunksOf.all(buildId, path)) {
        const candidate = this.add(row, "path", into);
        // The file's first chunk carries its header and imports; later chunks rank by content.
        candidate.bonus = Math.max(candidate.bonus, row.start_line === 1 ? bonus : bonus - 1);
      }
    }
  }
}
