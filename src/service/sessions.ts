/**
 * Client sessions: the trusted context an agent's MCP connection is bound to.
 *
 * A client adapter (Paws first) authenticates with its client token and
 * registers a session for one task generation: the authorized repository, the
 * exact committed SHA it resolved, the generation and an optional provider
 * policy and budget limits. Looky returns a session token that the agent's MCP
 * client presents. Tool arguments never carry any of this.
 *
 * Fencing: each client task has at most one active session. Registering a
 * higher `sequence` for the task supersedes the active one, so requests from
 * an obsolete generation are denied as `stale_session` and its results are
 * never delivered. A repeated registration with the same sequence and payload
 * returns the same session and token, so duplicate delivery is idempotent.
 */
import type { Database } from "bun:sqlite";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { BUDGET_FIELDS, type BudgetOverrides } from "../contract/budgets";
import { isFullCommitSha, type WorktreeState } from "../contract/context";
import { MODES } from "../contract/input";
import type { AuthorizationDecision, ProviderPolicy } from "../contract/ports";

/** What a client adapter sends to register a session. Validated by {@link parseRegistration}. */
export interface SessionRegistration {
  /** Client task the session belongs to, such as a Paws task id. Fencing is per task. */
  readonly taskId: string;
  /** Monotonic per task. A higher value supersedes the active session. */
  readonly sequence: number;
  /** Client session generation, such as a Paws run generation. */
  readonly clientGeneration: string;
  readonly callerId: string;
  readonly repositoryId: string;
  readonly snapshotId?: string;
  /** Exact committed SHA the adapter resolved. */
  readonly sha: string;
  /** Ref the SHA came from, for display only. */
  readonly ref?: string;
  readonly worktree: WorktreeState;
  /** Selection among providers Looky configured. Never credentials or endpoints. */
  readonly providerPolicy?: ProviderPolicy;
  /** Limits that can only tighten Looky's configured budgets. */
  readonly budgetLimits?: BudgetOverrides;
}

export type SessionState = "active" | "superseded" | "revoked" | "expired";

export interface SessionRecord {
  readonly id: string;
  readonly clientId: string;
  readonly registration: SessionRegistration;
  readonly state: SessionState;
  readonly createdAt: string;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
  readonly endedAt: string | null;
}

export class RegistrationError extends Error {
  override readonly name = "RegistrationError";
  constructor(
    readonly code:
      | "invalid_registration"
      | "unsupported_revision"
      | "repository_not_authorized"
      | "stale_session"
      | "conflict",
    message: string,
  ) {
    super(message);
  }
}

const MAX_ID_CHARS = 200;
const REGISTRATION_KEYS = new Set([
  "taskId",
  "sequence",
  "clientGeneration",
  "callerId",
  "repositoryId",
  "snapshotId",
  "sha",
  "ref",
  "worktree",
  "providerPolicy",
  "budgetLimits",
]);

function invalid(message: string): never {
  throw new RegistrationError("invalid_registration", message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    // Names only: an unexpected field may hold a credential and is never echoed.
    invalid(`${name} has unsupported fields: ${unexpected.join(", ")}`);
  }
}

function identifier(value: unknown, name: string, optional = false): string | undefined {
  if (value === undefined && optional) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) invalid(`${name} is required`);
  if (value.length > MAX_ID_CHARS) invalid(`${name} exceeds ${MAX_ID_CHARS} characters`);
  return value;
}

/**
 * Validate a registration body. Unknown fields are rejected, so a client
 * cannot pass credentials, endpoints or any scope Looky does not model.
 */
export function parseRegistration(raw: unknown): SessionRegistration {
  const body = record(raw, "registration");
  const unexpected = Object.keys(body).filter((key) => !REGISTRATION_KEYS.has(key));
  if (unexpected.length > 0) {
    invalid(`registration has unsupported fields: ${unexpected.join(", ")}`);
  }
  const sequence = body.sequence;
  if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) {
    invalid("sequence must be a non-negative integer");
  }
  const sha = body.sha;
  if (typeof sha !== "string" || !isFullCommitSha(sha)) {
    throw new RegistrationError(
      "unsupported_revision",
      "sha must be an exact committed revision given as a full lowercase commit SHA",
    );
  }
  const worktree = record(body.worktree, "worktree");
  let parsedWorktree: WorktreeState;
  if (worktree.state === "clean" || worktree.state === "unknown") {
    onlyKeys(worktree, ["state"], "worktree");
    parsedWorktree = { state: worktree.state };
  } else if (worktree.state === "dirty") {
    onlyKeys(worktree, ["state", "changedPaths"], "worktree");
    const changed = worktree.changedPaths;
    if (
      changed !== undefined &&
      (typeof changed !== "number" || !Number.isSafeInteger(changed) || changed < 0)
    ) {
      invalid("worktree.changedPaths must be a non-negative integer");
    }
    parsedWorktree =
      changed === undefined ? { state: "dirty" } : { state: "dirty", changedPaths: changed };
  } else {
    invalid("worktree.state must be clean, dirty or unknown");
  }

  const snapshotId = identifier(body.snapshotId, "snapshotId", true);
  const ref = identifier(body.ref, "ref", true);
  const providerPolicy =
    body.providerPolicy === undefined ? undefined : parsePolicy(body.providerPolicy);
  const budgetLimits =
    body.budgetLimits === undefined ? undefined : parseBudgetLimits(body.budgetLimits);
  return {
    taskId: identifier(body.taskId, "taskId")!,
    sequence,
    clientGeneration: identifier(body.clientGeneration, "clientGeneration")!,
    callerId: identifier(body.callerId, "callerId")!,
    repositoryId: identifier(body.repositoryId, "repositoryId")!,
    sha,
    worktree: parsedWorktree,
    ...(snapshotId !== undefined ? { snapshotId } : {}),
    ...(ref !== undefined ? { ref } : {}),
    ...(providerPolicy !== undefined ? { providerPolicy } : {}),
    ...(budgetLimits !== undefined ? { budgetLimits } : {}),
  };
}

function parsePolicy(raw: unknown): ProviderPolicy {
  const policy = record(raw, "providerPolicy");
  onlyKeys(policy, ["selected", "fallback"], "providerPolicy");
  const selected = identifier(policy.selected, "providerPolicy.selected")!;
  if (policy.fallback === undefined) return { selected };
  if (!Array.isArray(policy.fallback)) invalid("providerPolicy.fallback must be a list");
  const fallback = policy.fallback.map((id, index) =>
    identifier(id, `providerPolicy.fallback[${index}]`)!,
  );
  return { selected, fallback };
}

function parseBudgetLimits(raw: unknown): BudgetOverrides {
  const limits = record(raw, "budgetLimits");
  onlyKeys(limits, MODES, "budgetLimits");
  const result: Record<string, Record<string, number>> = {};
  for (const mode of MODES) {
    if (limits[mode] === undefined) continue;
    const values = record(limits[mode], `budgetLimits.${mode}`);
    onlyKeys(values, BUDGET_FIELDS, `budgetLimits.${mode}`);
    const parsed: Record<string, number> = {};
    for (const [field, value] of Object.entries(values)) {
      if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
        invalid(`budgetLimits.${mode}.${field} must be a positive integer`);
      }
      parsed[field] = value;
    }
    result[mode] = parsed;
  }
  return result as BudgetOverrides;
}

interface SessionRow {
  id: string;
  client_id: string;
  task_id: string;
  sequence: number;
  registration: string;
  state: SessionState;
  created_at: string;
  expires_at: number;
  ended_at: string | null;
}

function fromRow(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    clientId: row.client_id,
    registration: JSON.parse(row.registration) as SessionRegistration,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
  };
}

/** Deterministic JSON with sorted keys, for comparing duplicate registrations. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const SECRET_KEY = "session_token_secret";
const TOKEN_PREFIX = "lks_";
const SESSION_ID = /^ses_[0-9a-f-]{36}$/;

export interface RegisterResult {
  readonly session: SessionRecord;
  /** False when this was a duplicate delivery of an existing registration. */
  readonly created: boolean;
  /** Sessions of the same task this registration fenced off. */
  readonly superseded: readonly SessionRecord[];
}

export class SessionStore {
  readonly #secret: Buffer;

  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {
    this.#secret = this.#loadSecret();
  }

  /**
   * Session tokens are `lks_<session id>.<HMAC of the id>`. The key lives in
   * the database, so tokens survive a restart and a duplicate registration
   * can return the same token without storing it.
   */
  #loadSecret(): Buffer {
    return this.db
      .transaction(() => {
        const row = this.db
          .query<{ value: string }, [string]>("SELECT value FROM app_metadata WHERE key = ?")
          .get(SECRET_KEY);
        if (row) return Buffer.from(row.value, "base64");
        const secret = randomBytes(32);
        this.db
          .query("INSERT INTO app_metadata (key, value) VALUES (?, ?)")
          .run(SECRET_KEY, secret.toString("base64"));
        return secret;
      })
      .immediate();
  }

  #mac(sessionId: string): string {
    return createHmac("sha256", this.#secret).update(sessionId).digest("base64url");
  }

  tokenFor(session: SessionRecord): string {
    return `${TOKEN_PREFIX}${session.id}.${this.#mac(session.id)}`;
  }

  /**
   * Register, re-deliver or fence a session. Throws {@link RegistrationError}
   * for a stale sequence or a conflicting duplicate.
   */
  register(clientId: string, registration: SessionRegistration, ttlMs: number): RegisterResult {
    const payload = canonical(registration);
    return this.db
      .transaction((): RegisterResult => {
        const same = this.db
          .query<SessionRow, [string, string, number]>(
            "SELECT * FROM client_sessions WHERE client_id = ? AND task_id = ? AND sequence = ?",
          )
          .get(clientId, registration.taskId, registration.sequence);
        if (same) {
          const existing = fromRow(same);
          if (canonical(existing.registration) !== payload) {
            throw new RegistrationError(
              "conflict",
              `Sequence ${registration.sequence} of task ${registration.taskId} was already ` +
                "registered with a different context; use a higher sequence",
            );
          }
          if (existing.state !== "active" || existing.expiresAt <= this.now()) {
            throw new RegistrationError(
              "stale_session",
              `Session ${existing.id} for sequence ${registration.sequence} has ended (${existing.state})`,
            );
          }
          return { session: existing, created: false, superseded: [] };
        }
        const newest = this.db
          .query<{ sequence: number | null }, [string, string]>(
            "SELECT MAX(sequence) AS sequence FROM client_sessions WHERE client_id = ? AND task_id = ?",
          )
          .get(clientId, registration.taskId)?.sequence;
        if (newest !== null && newest !== undefined && newest > registration.sequence) {
          throw new RegistrationError(
            "stale_session",
            `Task ${registration.taskId} already has sequence ${newest}; ` +
              `sequence ${registration.sequence} is obsolete`,
          );
        }
        const ended = new Date(this.now()).toISOString();
        const superseded = this.db
          .query<SessionRow, [string, string, string]>(
            `UPDATE client_sessions SET state = 'superseded', ended_at = ?
             WHERE client_id = ? AND task_id = ? AND state = 'active' RETURNING *`,
          )
          .all(ended, clientId, registration.taskId)
          .map(fromRow);
        const row = this.db
          .query<
            SessionRow,
            [string, string, string, number, string, string, string, string, number]
          >(
            `INSERT INTO client_sessions
               (id, client_id, task_id, sequence, repository_id, sha, registration, state, created_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?) RETURNING *`,
          )
          .get(
            `ses_${crypto.randomUUID()}`,
            clientId,
            registration.taskId,
            registration.sequence,
            registration.repositoryId,
            registration.sha,
            JSON.stringify(registration),
            ended,
            this.now() + ttlMs,
          )!;
        return { session: fromRow(row), created: true, superseded };
      })
      .immediate();
  }

  get(sessionId: string): SessionRecord | undefined {
    const row = this.db
      .query<SessionRow, [string]>("SELECT * FROM client_sessions WHERE id = ?")
      .get(sessionId);
    return row ? fromRow(row) : undefined;
  }

  /** The session a token names, after checking its MAC. Undefined for any invalid token. */
  fromToken(token: string): SessionRecord | undefined {
    if (!token.startsWith(TOKEN_PREFIX)) return undefined;
    const [id, mac] = token.slice(TOKEN_PREFIX.length).split(".");
    if (!id || !mac || !SESSION_ID.test(id)) return undefined;
    const expected = Buffer.from(this.#mac(id));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return undefined;
    return this.get(id);
  }

  /** Whether the session may still make requests and receive results. */
  check(session: SessionRecord | undefined): AuthorizationDecision {
    if (!session) return { allowed: false, reason: "unauthorized", message: "Unknown session" };
    switch (session.state) {
      case "superseded":
        return {
          allowed: false,
          reason: "stale_session",
          message: `Session ${session.id} was superseded by a newer generation of its task`,
        };
      case "revoked":
        return { allowed: false, reason: "revoked", message: `Session ${session.id} was revoked` };
      case "expired":
        return { allowed: false, reason: "revoked", message: `Session ${session.id} expired` };
      case "active":
        if (session.expiresAt <= this.now()) {
          return { allowed: false, reason: "revoked", message: `Session ${session.id} expired` };
        }
        return { allowed: true };
    }
  }

  /** End an active session of this client. Returns it, or undefined if it was not active. */
  revoke(clientId: string, sessionId: string): SessionRecord | undefined {
    const row = this.db
      .query<SessionRow, [string, string, string]>(
        `UPDATE client_sessions SET state = 'revoked', ended_at = ?
         WHERE id = ? AND client_id = ? AND state = 'active' RETURNING *`,
      )
      .get(new Date(this.now()).toISOString(), sessionId, clientId);
    return row ? fromRow(row) : undefined;
  }

  /** Mark sessions past their deadline expired and return them. */
  expire(): SessionRecord[] {
    const now = this.now();
    return this.db
      .query<SessionRow, [string, number]>(
        `UPDATE client_sessions SET state = 'expired', ended_at = ?
         WHERE state = 'active' AND expires_at <= ? RETURNING *`,
      )
      .all(new Date(now).toISOString(), now)
      .map(fromRow);
  }

  /** Whether any live session still needs this repository and SHA indexed. */
  hasInterest(repositoryId: string, sha: string): boolean {
    return (
      this.db
        .query<{ found: number }, [string, string, number]>(
          `SELECT 1 AS found FROM client_sessions
           WHERE repository_id = ? AND sha = ? AND state = 'active' AND expires_at > ? LIMIT 1`,
        )
        .get(repositoryId, sha, this.now()) !== null
    );
  }

  /** Delete ended sessions older than the cutoff, keeping the newest sequence of each task. */
  prune(olderThanMs: number): number {
    const cutoff = new Date(this.now() - olderThanMs).toISOString();
    return this.db
      .query(
        `DELETE FROM client_sessions AS s
         WHERE s.state != 'active' AND s.ended_at IS NOT NULL AND s.ended_at < ?
           AND s.sequence < (SELECT MAX(sequence) FROM client_sessions AS t
                             WHERE t.client_id = s.client_id AND t.task_id = s.task_id)`,
      )
      .run(cutoff).changes;
  }
}
