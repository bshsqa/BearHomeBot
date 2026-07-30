import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 3;
const MAX_SESSION_NAME_LENGTH = 80;

export type UserRole = "admin" | "member";

export interface BearHomeUser {
  id: number;
  telegramUserId: string;
  role: UserRole;
  enabled: boolean;
}

export interface CodexSession {
  id: number;
  userId: number;
  displayName: string;
  threadId?: string;
  active: boolean;
  createdAt: string;
  lastUsedAt: string;
  turnCount: number;
}

export interface TurnUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type KSkillReleaseStatus =
  "discovered" | "rejected" | "validated" | "active" | "superseded";

export interface KSkillReleaseRecord {
  sha: string;
  treeSha: string;
  sourceUrl: string;
  sourceBranch: string;
  status: KSkillReleaseStatus;
  manifest?: unknown;
  review?: unknown;
  releasePath?: string;
  failureCode?: string;
  discoveredAt: string;
  validatedAt?: string;
  activatedAt?: string;
  updatedAt: string;
}

export interface KSkillBehaviorReviewRecord {
  skillId: string;
  contentDigest: string;
  policyVersion: number;
  sourceSha: string;
  review: unknown;
  reviewedAt: string;
}

export interface KSkillActiveState {
  activeSha?: string;
  previousSha?: string;
  updatedAt?: string;
}

export class StateStoreError extends Error {
  constructor(
    readonly code:
      | "invalid_session_name"
      | "session_not_found"
      | "thread_already_attached"
      | "user_not_allowed",
    message: string,
  ) {
    super(message);
    this.name = "StateStoreError";
  }
}

type Now = () => string;

interface UserRow {
  id: number;
  telegram_user_id: string;
  role: UserRole;
  enabled: number;
}

interface SessionRow {
  id: number;
  user_id: number;
  display_name: string;
  thread_id: string | null;
  active: number;
  created_at: string;
  last_used_at: string;
  turn_count: number;
}

interface KSkillReleaseRow {
  sha: string;
  tree_sha: string;
  source_url: string;
  source_branch: string;
  status: KSkillReleaseStatus;
  manifest_json: string | null;
  review_json: string | null;
  release_path: string | null;
  failure_code: string | null;
  discovered_at: string;
  validated_at: string | null;
  activated_at: string | null;
  updated_at: string;
}

interface KSkillBehaviorReviewRow {
  skill_id: string;
  content_digest: string;
  policy_version: number;
  source_sha: string;
  review_json: string;
  reviewed_at: string;
}

function rowToUser(row: UserRow): BearHomeUser {
  return {
    id: row.id,
    telegramUserId: row.telegram_user_id,
    role: row.role,
    enabled: row.enabled === 1,
  };
}

function rowToSession(row: SessionRow): CodexSession {
  const session: CodexSession = {
    id: row.id,
    userId: row.user_id,
    displayName: row.display_name,
    active: row.active === 1,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    turnCount: row.turn_count,
  };
  if (row.thread_id !== null) {
    session.threadId = row.thread_id;
  }
  return session;
}

function parseStoredJson(value: string | null): unknown | undefined {
  return value === null ? undefined : (JSON.parse(value) as unknown);
}

function rowToKSkillRelease(row: KSkillReleaseRow): KSkillReleaseRecord {
  const release: KSkillReleaseRecord = {
    sha: row.sha,
    treeSha: row.tree_sha,
    sourceUrl: row.source_url,
    sourceBranch: row.source_branch,
    status: row.status,
    discoveredAt: row.discovered_at,
    updatedAt: row.updated_at,
  };
  const manifest = parseStoredJson(row.manifest_json);
  const review = parseStoredJson(row.review_json);
  if (manifest !== undefined) {
    release.manifest = manifest;
  }
  if (review !== undefined) {
    release.review = review;
  }
  if (row.release_path !== null) {
    release.releasePath = row.release_path;
  }
  if (row.failure_code !== null) {
    release.failureCode = row.failure_code;
  }
  if (row.validated_at !== null) {
    release.validatedAt = row.validated_at;
  }
  if (row.activated_at !== null) {
    release.activatedAt = row.activated_at;
  }
  return release;
}

function validateGitSha(sha: string): string {
  if (!/^[0-9a-f]{40,64}$/u.test(sha)) {
    throw new Error("k-skill SHA has an invalid format");
  }
  return sha;
}

function validateFailureCode(code: string): string {
  if (!/^[a-z0-9_.-]{1,100}$/u.test(code)) {
    throw new Error("k-skill failure code has an invalid format");
  }
  return code;
}

function validateSkillId(skillId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(skillId)) {
    throw new Error("k-skill behavior review skill ID is invalid");
  }
  return skillId;
}

function validateContentDigest(contentDigest: string): string {
  if (!/^[0-9a-f]{64}$/u.test(contentDigest)) {
    throw new Error("k-skill behavior review digest is invalid");
  }
  return contentDigest;
}

function validatePolicyVersion(policyVersion: number): number {
  if (
    !Number.isSafeInteger(policyVersion) ||
    policyVersion < 1 ||
    policyVersion > 1_000_000
  ) {
    throw new Error("k-skill behavior review policy version is invalid");
  }
  return policyVersion;
}

function rowToKSkillBehaviorReview(
  row: KSkillBehaviorReviewRow,
): KSkillBehaviorReviewRecord {
  return {
    skillId: row.skill_id,
    contentDigest: row.content_digest,
    policyVersion: row.policy_version,
    sourceSha: row.source_sha,
    review: JSON.parse(row.review_json) as unknown,
    reviewedAt: row.reviewed_at,
  };
}

function normalizeSessionName(name: string): string {
  const normalized = name
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  if (!normalized || normalized.length > MAX_SESSION_NAME_LENGTH) {
    throw new StateStoreError(
      "invalid_session_name",
      `Session name must contain 1-${MAX_SESSION_NAME_LENGTH} characters`,
    );
  }

  return normalized;
}

export class StateStore {
  readonly #database: DatabaseSync;
  readonly #now: Now;

  constructor(databasePath: string, now: Now = () => new Date().toISOString()) {
    if (databasePath !== ":memory:") {
      mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    }

    this.#database = new DatabaseSync(databasePath);
    this.#now = now;

    if (databasePath !== ":memory:") {
      chmodSync(databasePath, 0o600);
    }

    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    if (databasePath !== ":memory:") {
      this.#database.exec("PRAGMA journal_mode = WAL");
    }
    this.#migrate();
  }

  close(): void {
    this.#database.close();
  }

  importBootstrapUsers(telegramUserIds: Iterable<string>): BearHomeUser[] {
    const imported: BearHomeUser[] = [];
    let index = 0;

    for (const telegramUserId of telegramUserIds) {
      const role: UserRole = index === 0 ? "admin" : "member";
      imported.push(this.#upsertUser(telegramUserId, role));
      index += 1;
    }

    return imported;
  }

  findEnabledUser(telegramUserId: string): BearHomeUser | undefined {
    const row = this.#database
      .prepare(
        `SELECT id, telegram_user_id, role, enabled
         FROM users
         WHERE telegram_user_id = ? AND enabled = 1`,
      )
      .get(telegramUserId) as UserRow | undefined;

    return row ? rowToUser(row) : undefined;
  }

  createSession(telegramUserId: string, displayName: string): CodexSession {
    const user = this.#requireEnabledUser(telegramUserId);
    const name = normalizeSessionName(displayName);
    const now = this.#now();

    return this.#transaction(() => {
      this.#database
        .prepare("UPDATE codex_sessions SET active = 0 WHERE user_id = ?")
        .run(user.id);
      const result = this.#database
        .prepare(
          `INSERT INTO codex_sessions (
             user_id, display_name, active, created_at, last_used_at
           ) VALUES (?, ?, 1, ?, ?)`,
        )
        .run(user.id, name, now, now);
      this.#insertAuditEvent(
        user.id,
        "session.created",
        result.lastInsertRowid,
      );
      return this.#requireOwnedSession(user.id, Number(result.lastInsertRowid));
    });
  }

  getActiveSession(telegramUserId: string): CodexSession | undefined {
    const user = this.#requireEnabledUser(telegramUserId);
    const row = this.#database
      .prepare(
        `SELECT id, user_id, display_name, thread_id, active, created_at,
                last_used_at, turn_count
         FROM codex_sessions
         WHERE user_id = ? AND active = 1`,
      )
      .get(user.id) as SessionRow | undefined;

    return row ? rowToSession(row) : undefined;
  }

  getSession(telegramUserId: string, sessionId: number): CodexSession {
    const user = this.#requireEnabledUser(telegramUserId);
    return this.#requireOwnedSession(user.id, sessionId);
  }

  listSessions(telegramUserId: string, limit = 10, offset = 0): CodexSession[] {
    const user = this.#requireEnabledUser(telegramUserId);
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 25));
    const boundedOffset = Math.max(0, Math.trunc(offset));
    const rows = this.#database
      .prepare(
        `SELECT id, user_id, display_name, thread_id, active, created_at,
                last_used_at, turn_count
         FROM codex_sessions
         WHERE user_id = ?
         ORDER BY active DESC, last_used_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(user.id, boundedLimit, boundedOffset) as unknown as SessionRow[];

    return rows.map(rowToSession);
  }

  countSessions(telegramUserId: string): number {
    const user = this.#requireEnabledUser(telegramUserId);
    const row = this.#database
      .prepare(
        "SELECT COUNT(*) AS session_count FROM codex_sessions WHERE user_id = ?",
      )
      .get(user.id) as { session_count: number };
    return row.session_count;
  }

  selectSession(telegramUserId: string, sessionId: number): CodexSession {
    const user = this.#requireEnabledUser(telegramUserId);

    return this.#transaction(() => {
      const session = this.#requireOwnedSession(user.id, sessionId);
      this.#database
        .prepare("UPDATE codex_sessions SET active = 0 WHERE user_id = ?")
        .run(user.id);
      this.#database
        .prepare(
          "UPDATE codex_sessions SET active = 1, last_used_at = ? WHERE id = ?",
        )
        .run(this.#now(), session.id);
      this.#insertAuditEvent(user.id, "session.selected", session.id);
      return this.#requireOwnedSession(user.id, session.id);
    });
  }

  renameActiveSession(
    telegramUserId: string,
    displayName: string,
  ): CodexSession {
    const session = this.#requireActiveSession(telegramUserId);
    const name = normalizeSessionName(displayName);
    this.#database
      .prepare(
        "UPDATE codex_sessions SET display_name = ?, last_used_at = ? WHERE id = ?",
      )
      .run(name, this.#now(), session.id);
    this.#insertAuditEvent(session.userId, "session.renamed", session.id);
    return this.#requireOwnedSession(session.userId, session.id);
  }

  endActiveSession(telegramUserId: string): CodexSession | undefined {
    const user = this.#requireEnabledUser(telegramUserId);
    const session = this.getActiveSession(telegramUserId);
    if (!session) {
      return undefined;
    }

    this.#database
      .prepare("UPDATE codex_sessions SET active = 0 WHERE id = ?")
      .run(session.id);
    this.#insertAuditEvent(user.id, "session.ended", session.id);
    return { ...session, active: false };
  }

  attachThread(
    telegramUserId: string,
    sessionId: number,
    threadId: string,
  ): CodexSession {
    const user = this.#requireEnabledUser(telegramUserId);
    const session = this.#requireOwnedSession(user.id, sessionId);
    if (session.threadId && session.threadId !== threadId) {
      throw new StateStoreError(
        "thread_already_attached",
        "Session already has a different Codex thread",
      );
    }

    this.#database
      .prepare(
        `UPDATE codex_sessions
         SET thread_id = ?, last_used_at = ?
         WHERE id = ?`,
      )
      .run(threadId, this.#now(), session.id);
    this.#insertAuditEvent(user.id, "session.thread_attached", session.id);
    return this.#requireOwnedSession(user.id, session.id);
  }

  startTurn(telegramUserId: string, sessionId: number): number {
    const user = this.#requireEnabledUser(telegramUserId);
    this.#requireOwnedSession(user.id, sessionId);
    const result = this.#database
      .prepare(
        `INSERT INTO turns (session_id, status, started_at)
         VALUES (?, 'running', ?)`,
      )
      .run(sessionId, this.#now());
    return Number(result.lastInsertRowid);
  }

  completeTurn(
    telegramUserId: string,
    sessionId: number,
    turnId: number,
    usage: TurnUsage = {},
  ): void {
    const user = this.#requireEnabledUser(telegramUserId);
    this.#requireOwnedSession(user.id, sessionId);
    const now = this.#now();

    this.#transaction(() => {
      const result = this.#database
        .prepare(
          `UPDATE turns
           SET status = 'completed', completed_at = ?,
               input_tokens = ?, output_tokens = ?
           WHERE id = ? AND session_id = ? AND status = 'running'`,
        )
        .run(
          now,
          usage.inputTokens ?? null,
          usage.outputTokens ?? null,
          turnId,
          sessionId,
        );
      if (result.changes !== 1) {
        throw new Error("Running turn was not found");
      }
      this.#database
        .prepare(
          `UPDATE codex_sessions
           SET turn_count = turn_count + 1, last_used_at = ?
           WHERE id = ?`,
        )
        .run(now, sessionId);
    });
  }

  finishTurnWithFailure(
    telegramUserId: string,
    sessionId: number,
    turnId: number,
    status: "cancelled" | "failed",
    failureCode: string,
  ): void {
    const user = this.#requireEnabledUser(telegramUserId);
    this.#requireOwnedSession(user.id, sessionId);
    this.#database
      .prepare(
        `UPDATE turns
         SET status = ?, completed_at = ?, failure_code = ?
         WHERE id = ? AND session_id = ? AND status = 'running'`,
      )
      .run(status, this.#now(), failureCode, turnId, sessionId);
  }

  getNextTelegramUpdateOffset(): number | undefined {
    const row = this.#database
      .prepare(
        "SELECT MAX(update_id) AS maximum_update_id FROM telegram_updates",
      )
      .get() as { maximum_update_id: number | null };

    return row.maximum_update_id === null
      ? undefined
      : row.maximum_update_id + 1;
  }

  claimTelegramUpdate(
    updateId: number,
    telegramUserId: string | undefined,
  ): boolean {
    const user = telegramUserId
      ? this.findEnabledUser(telegramUserId)
      : undefined;
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO telegram_updates (
           update_id, user_id, status, received_at
         ) VALUES (?, ?, 'received', ?)`,
      )
      .run(updateId, user?.id ?? null, this.#now());

    return result.changes === 1;
  }

  completeTelegramUpdate(
    updateId: number,
    status: "completed" | "failed" | "ignored",
  ): void {
    this.#database
      .prepare(
        `UPDATE telegram_updates
         SET status = ?, completed_at = ?
         WHERE update_id = ?`,
      )
      .run(status, this.#now(), updateId);
  }

  recordKSkillCandidate(candidate: {
    sha: string;
    treeSha: string;
    sourceUrl: string;
    sourceBranch: string;
    manifest: unknown;
  }): KSkillReleaseRecord {
    const sha = validateGitSha(candidate.sha);
    const treeSha = validateGitSha(candidate.treeSha);
    const now = this.#now();
    this.#database
      .prepare(
        `INSERT INTO k_skill_releases (
           sha, tree_sha, source_url, source_branch, status, manifest_json,
           discovered_at, updated_at
         ) VALUES (?, ?, ?, ?, 'discovered', ?, ?, ?)
         ON CONFLICT(sha) DO UPDATE SET
           tree_sha = excluded.tree_sha,
           source_url = excluded.source_url,
           source_branch = excluded.source_branch,
           manifest_json = excluded.manifest_json,
           status = CASE
             WHEN k_skill_releases.status = 'active' THEN 'active'
             ELSE 'discovered'
           END,
           failure_code = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(
        sha,
        treeSha,
        candidate.sourceUrl,
        candidate.sourceBranch,
        JSON.stringify(candidate.manifest),
        now,
        now,
      );
    return this.#requireKSkillRelease(sha);
  }

  rejectKSkillCandidate(
    sha: string,
    failureCode: string,
    review?: unknown,
  ): KSkillReleaseRecord {
    validateGitSha(sha);
    validateFailureCode(failureCode);
    const result = this.#database
      .prepare(
        `UPDATE k_skill_releases
         SET status = 'rejected', failure_code = ?,
             review_json = COALESCE(?, review_json), updated_at = ?
         WHERE sha = ? AND status != 'active'`,
      )
      .run(
        failureCode,
        review === undefined ? null : JSON.stringify(review),
        this.#now(),
        sha,
      );
    if (result.changes !== 1) {
      throw new Error("k-skill candidate could not be rejected");
    }
    return this.#requireKSkillRelease(sha);
  }

  markKSkillCandidateValidated(candidate: {
    sha: string;
    releasePath: string;
    review: unknown;
  }): KSkillReleaseRecord {
    validateGitSha(candidate.sha);
    const now = this.#now();
    const result = this.#database
      .prepare(
        `UPDATE k_skill_releases
         SET status = 'validated', release_path = ?, review_json = ?,
             failure_code = NULL, validated_at = ?,
             updated_at = ?
         WHERE sha = ? AND status != 'active'`,
      )
      .run(
        candidate.releasePath,
        JSON.stringify(candidate.review),
        now,
        now,
        candidate.sha,
      );
    if (result.changes !== 1) {
      throw new Error("k-skill candidate could not be marked validated");
    }
    return this.#requireKSkillRelease(candidate.sha);
  }

  getKSkillBehaviorReview(
    skillId: string,
    contentDigest: string,
    policyVersion: number,
  ): KSkillBehaviorReviewRecord | undefined {
    validateSkillId(skillId);
    validateContentDigest(contentDigest);
    validatePolicyVersion(policyVersion);
    const row = this.#database
      .prepare(
        `SELECT skill_id, content_digest, policy_version, source_sha,
                review_json, reviewed_at
         FROM k_skill_behavior_reviews
         WHERE skill_id = ? AND content_digest = ? AND policy_version = ?`,
      )
      .get(skillId, contentDigest, policyVersion) as
      KSkillBehaviorReviewRow | undefined;
    return row ? rowToKSkillBehaviorReview(row) : undefined;
  }

  recordKSkillBehaviorReview(review: {
    skillId: string;
    contentDigest: string;
    policyVersion: number;
    sourceSha: string;
    review: unknown;
  }): KSkillBehaviorReviewRecord {
    validateSkillId(review.skillId);
    validateContentDigest(review.contentDigest);
    validatePolicyVersion(review.policyVersion);
    validateGitSha(review.sourceSha);
    const now = this.#now();
    this.#database
      .prepare(
        `INSERT INTO k_skill_behavior_reviews (
           skill_id, content_digest, policy_version, source_sha,
           review_json, reviewed_at
         ) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(skill_id, content_digest, policy_version) DO UPDATE SET
           source_sha = excluded.source_sha,
           review_json = excluded.review_json,
           reviewed_at = excluded.reviewed_at`,
      )
      .run(
        review.skillId,
        review.contentDigest,
        review.policyVersion,
        review.sourceSha,
        JSON.stringify(review.review),
        now,
      );
    const stored = this.getKSkillBehaviorReview(
      review.skillId,
      review.contentDigest,
      review.policyVersion,
    );
    if (!stored) {
      throw new Error("k-skill behavior review could not be stored");
    }
    return stored;
  }

  promoteKSkillRelease(sha: string): KSkillReleaseRecord {
    validateGitSha(sha);
    return this.#transaction(() => {
      const candidate = this.#requireKSkillRelease(sha);
      if (candidate.status !== "validated" && candidate.status !== "active") {
        throw new Error("Only a validated k-skill release can be promoted");
      }
      if (!candidate.releasePath) {
        throw new Error("Validated k-skill release has no release path");
      }
      const state = this.getKSkillActiveState();
      if (state.activeSha === sha) {
        return candidate;
      }
      const now = this.#now();
      this.#database
        .prepare(
          `UPDATE k_skill_releases
           SET status = 'superseded', updated_at = ?
           WHERE status = 'active'`,
        )
        .run(now);
      this.#database
        .prepare(
          `UPDATE k_skill_releases
           SET status = 'active', activated_at = ?, updated_at = ?
           WHERE sha = ?`,
        )
        .run(now, now, sha);
      this.#database
        .prepare(
          `UPDATE k_skill_state
           SET active_sha = ?, previous_sha = ?, updated_at = ?
           WHERE id = 1`,
        )
        .run(sha, state.activeSha ?? null, now);
      return this.#requireKSkillRelease(sha);
    });
  }

  rollbackKSkillRelease(sha?: string): KSkillReleaseRecord {
    return this.#transaction(() => {
      const state = this.getKSkillActiveState();
      const targetSha = validateGitSha(sha ?? state.previousSha ?? "");
      if (targetSha === state.activeSha) {
        return this.#requireKSkillRelease(targetSha);
      }
      const target = this.#requireKSkillRelease(targetSha);
      if (
        !target.releasePath ||
        (target.status !== "validated" && target.status !== "superseded")
      ) {
        throw new Error("Rollback target is not a validated release");
      }
      const now = this.#now();
      this.#database
        .prepare(
          `UPDATE k_skill_releases
           SET status = 'superseded', updated_at = ?
           WHERE status = 'active'`,
        )
        .run(now);
      this.#database
        .prepare(
          `UPDATE k_skill_releases
           SET status = 'active', activated_at = ?, updated_at = ?
           WHERE sha = ?`,
        )
        .run(now, now, targetSha);
      this.#database
        .prepare(
          `UPDATE k_skill_state
           SET active_sha = ?, previous_sha = ?, updated_at = ?
           WHERE id = 1`,
        )
        .run(targetSha, state.activeSha ?? null, now);
      return this.#requireKSkillRelease(targetSha);
    });
  }

  getKSkillRelease(sha: string): KSkillReleaseRecord | undefined {
    validateGitSha(sha);
    const row = this.#database
      .prepare(
        `SELECT sha, tree_sha, source_url, source_branch, status,
                manifest_json, review_json, release_path,
                failure_code, discovered_at, validated_at, activated_at,
                updated_at
         FROM k_skill_releases
         WHERE sha = ?`,
      )
      .get(sha) as KSkillReleaseRow | undefined;
    return row ? rowToKSkillRelease(row) : undefined;
  }

  getKSkillActiveState(): KSkillActiveState {
    const row = this.#database
      .prepare(
        `SELECT active_sha, previous_sha, updated_at
         FROM k_skill_state WHERE id = 1`,
      )
      .get() as {
      active_sha: string | null;
      previous_sha: string | null;
      updated_at: string | null;
    };
    const state: KSkillActiveState = {};
    if (row.active_sha !== null) {
      state.activeSha = row.active_sha;
    }
    if (row.previous_sha !== null) {
      state.previousSha = row.previous_sha;
    }
    if (row.updated_at !== null) {
      state.updatedAt = row.updated_at;
    }
    return state;
  }

  listKSkillReleases(): KSkillReleaseRecord[] {
    const rows = this.#database
      .prepare(
        `SELECT sha, tree_sha, source_url, source_branch, status,
                manifest_json, review_json, release_path,
                failure_code, discovered_at, validated_at, activated_at,
                updated_at
         FROM k_skill_releases
         ORDER BY COALESCE(activated_at, validated_at, discovered_at) DESC`,
      )
      .all() as unknown as KSkillReleaseRow[];
    return rows.map(rowToKSkillRelease);
  }

  #migrate(): void {
    const version = (
      this.#database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version;

    if (version > SCHEMA_VERSION) {
      throw new Error(
        `State database schema ${version} is newer than supported ${SCHEMA_VERSION}`,
      );
    }
    if (version < 1) {
      this.#transaction(() => {
        this.#database.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          telegram_user_id TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE codex_sessions (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          display_name TEXT NOT NULL,
          thread_id TEXT UNIQUE,
          active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0, 1)),
          created_at TEXT NOT NULL,
          last_used_at TEXT NOT NULL,
          turn_count INTEGER NOT NULL DEFAULT 0 CHECK (turn_count >= 0)
        );

        CREATE UNIQUE INDEX one_active_session_per_user
          ON codex_sessions(user_id)
          WHERE active = 1;

        CREATE TABLE turns (
          id INTEGER PRIMARY KEY,
          session_id INTEGER NOT NULL
            REFERENCES codex_sessions(id) ON DELETE CASCADE,
          status TEXT NOT NULL
            CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
          started_at TEXT NOT NULL,
          completed_at TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          failure_code TEXT
        );

        CREATE TABLE telegram_updates (
          update_id INTEGER PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          status TEXT NOT NULL
            CHECK (status IN ('received', 'completed', 'ignored', 'failed')),
          received_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE audit_events (
          id INTEGER PRIMARY KEY,
          user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
          event_type TEXT NOT NULL,
          entity_id INTEGER,
          created_at TEXT NOT NULL
        );

      `);
        this.#database.exec("PRAGMA user_version = 1");
      });
    }
    if (version < 2) {
      this.#transaction(() => {
        this.#database.exec(`
          CREATE TABLE k_skill_releases (
            sha TEXT PRIMARY KEY,
            tree_sha TEXT NOT NULL,
            source_url TEXT NOT NULL,
            source_branch TEXT NOT NULL,
            status TEXT NOT NULL
              CHECK (status IN (
                'discovered', 'rejected', 'validated', 'active', 'superseded'
              )),
            manifest_json TEXT,
            validation_json TEXT,
            review_json TEXT,
            release_path TEXT,
            failure_code TEXT,
            discovered_at TEXT NOT NULL,
            validated_at TEXT,
            activated_at TEXT,
            updated_at TEXT NOT NULL
          );

          CREATE UNIQUE INDEX one_active_k_skill_release
            ON k_skill_releases(status)
            WHERE status = 'active';

          CREATE TABLE k_skill_state (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            active_sha TEXT REFERENCES k_skill_releases(sha),
            previous_sha TEXT REFERENCES k_skill_releases(sha),
            updated_at TEXT
          );

          INSERT INTO k_skill_state (id) VALUES (1);
        `);
        this.#database.exec("PRAGMA user_version = 2");
      });
    }
    if (version < 3) {
      this.#transaction(() => {
        this.#database.exec(`
          ALTER TABLE k_skill_releases DROP COLUMN validation_json;

          CREATE TABLE k_skill_behavior_reviews (
            skill_id TEXT NOT NULL,
            content_digest TEXT NOT NULL,
            policy_version INTEGER NOT NULL CHECK (policy_version >= 1),
            source_sha TEXT NOT NULL REFERENCES k_skill_releases(sha),
            review_json TEXT NOT NULL,
            reviewed_at TEXT NOT NULL,
            PRIMARY KEY (skill_id, content_digest, policy_version)
          );

          CREATE INDEX k_skill_behavior_reviews_by_source
            ON k_skill_behavior_reviews(source_sha);
        `);
        this.#database.exec("PRAGMA user_version = 3");
      });
    }
  }

  #upsertUser(telegramUserId: string, role: UserRole): BearHomeUser {
    if (!/^\d+$/u.test(telegramUserId)) {
      throw new Error("Telegram user ID must be numeric");
    }
    const now = this.#now();
    this.#database
      .prepare(
        `INSERT INTO users (
           telegram_user_id, role, enabled, created_at, updated_at
         ) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(telegram_user_id) DO UPDATE SET
           enabled = 1,
           updated_at = excluded.updated_at`,
      )
      .run(telegramUserId, role, now, now);

    const user = this.findEnabledUser(telegramUserId);
    if (!user) {
      throw new Error("Failed to import Telegram user");
    }
    return user;
  }

  #requireEnabledUser(telegramUserId: string): BearHomeUser {
    const user = this.findEnabledUser(telegramUserId);
    if (!user) {
      throw new StateStoreError(
        "user_not_allowed",
        "Telegram user is not enabled",
      );
    }
    return user;
  }

  #requireActiveSession(telegramUserId: string): CodexSession {
    const session = this.getActiveSession(telegramUserId);
    if (!session) {
      throw new StateStoreError("session_not_found", "No active Codex session");
    }
    return session;
  }

  #requireOwnedSession(userId: number, sessionId: number): CodexSession {
    const row = this.#database
      .prepare(
        `SELECT id, user_id, display_name, thread_id, active, created_at,
                last_used_at, turn_count
         FROM codex_sessions
         WHERE id = ? AND user_id = ?`,
      )
      .get(sessionId, userId) as SessionRow | undefined;

    if (!row) {
      throw new StateStoreError(
        "session_not_found",
        "Codex session was not found for this user",
      );
    }
    return rowToSession(row);
  }

  #insertAuditEvent(
    userId: number,
    eventType: string,
    entityId: bigint | number,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO audit_events (user_id, event_type, entity_id, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(userId, eventType, entityId, this.#now());
  }

  #requireKSkillRelease(sha: string): KSkillReleaseRecord {
    const release = this.getKSkillRelease(sha);
    if (!release) {
      throw new Error("k-skill release was not found");
    }
    return release;
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}
