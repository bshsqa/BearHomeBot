import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SCHEMA_VERSION = 1;
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
    if (version === SCHEMA_VERSION) {
      return;
    }

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

        PRAGMA user_version = 1;
      `);
    });
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
