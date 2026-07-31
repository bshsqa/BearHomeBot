import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { StateStore, StateStoreError } from "../src/state/store.js";

const NOW = "2026-07-30T10:00:00.000Z";

function createStore(): StateStore {
  return new StateStore(":memory:", () => NOW);
}

test("imports bootstrap users without storing conversation text", () => {
  const store = createStore();
  try {
    const users = store.importBootstrapUsers(["1001", "1002"]);

    assert.equal(users[0]?.role, "admin");
    assert.equal(users[1]?.role, "member");
    assert.equal(store.findEnabledUser("1001")?.telegramUserId, "1001");
  } finally {
    store.close();
  }
});

test("maintains multiple sessions with one active session per user", () => {
  const store = createStore();
  try {
    store.importBootstrapUsers(["1001"]);
    const first = store.createSession("1001", "여행 계획");
    const second = store.createSession("1001", "BearHomeBot 개발");

    assert.equal(first.active, true);
    assert.equal(second.active, true);
    assert.equal(store.getActiveSession("1001")?.id, second.id);
    assert.deepEqual(
      store
        .listSessions("1001")
        .map((session) => [session.displayName, session.active]),
      [
        ["BearHomeBot 개발", true],
        ["여행 계획", false],
      ],
    );

    const selected = store.selectSession("1001", first.id);
    assert.equal(selected.active, true);
    assert.equal(store.getActiveSession("1001")?.id, first.id);
  } finally {
    store.close();
  }
});

test("prevents one user from selecting another user's session", () => {
  const store = createStore();
  try {
    store.importBootstrapUsers(["1001", "1002"]);
    const otherSession = store.createSession("1002", "비공개 대화");

    assert.throws(
      () => store.selectSession("1001", otherSession.id),
      (error: unknown) =>
        error instanceof StateStoreError && error.code === "session_not_found",
    );
  } finally {
    store.close();
  }
});

test("attaches one Codex thread and preserves ended sessions", () => {
  const store = createStore();
  try {
    store.importBootstrapUsers(["1001"]);
    const session = store.createSession("1001", "KTX");
    const attached = store.attachThread(
      "1001",
      session.id,
      "0199a213-81c0-7800-8aa1-bbab2a035a53",
    );

    assert.equal(attached.threadId, "0199a213-81c0-7800-8aa1-bbab2a035a53");
    assert.throws(
      () => store.attachThread("1001", session.id, "different-thread"),
      (error: unknown) =>
        error instanceof StateStoreError &&
        error.code === "thread_already_attached",
    );

    const ended = store.endActiveSession("1001");
    assert.equal(ended?.active, false);
    assert.equal(store.getActiveSession("1001"), undefined);
    assert.equal(store.listSessions("1001")[0]?.threadId, attached.threadId);
  } finally {
    store.close();
  }
});

test("normalizes names and rejects empty or oversized session names", () => {
  const store = createStore();
  try {
    store.importBootstrapUsers(["1001"]);
    assert.equal(
      store.createSession("1001", "  여행\n  계획  ").displayName,
      "여행 계획",
    );
    assert.throws(
      () => store.createSession("1001", " \n "),
      /Session name must contain/,
    );
    assert.throws(
      () => store.createSession("1001", "a".repeat(81)),
      /Session name must contain/,
    );
  } finally {
    store.close();
  }
});

test("claims each Telegram update once and restores the next offset", () => {
  const store = createStore();
  try {
    store.importBootstrapUsers(["1001"]);

    assert.equal(store.getNextTelegramUpdateOffset(), undefined);
    assert.equal(store.claimTelegramUpdate(42, "1001"), true);
    assert.equal(store.claimTelegramUpdate(42, "1001"), false);
    store.completeTelegramUpdate(42, "completed");
    assert.equal(store.getNextTelegramUpdateOffset(), 43);
  } finally {
    store.close();
  }
});

test("records turn metadata without requiring prompt or response text", () => {
  const store = createStore();
  try {
    store.importBootstrapUsers(["1001"]);
    const session = store.createSession("1001", "대화");
    const turnId = store.startTurn("1001", session.id);

    store.completeTurn("1001", session.id, turnId, {
      inputTokens: 12,
      outputTokens: 4,
    });

    assert.equal(store.getActiveSession("1001")?.turnCount, 1);
  } finally {
    store.close();
  }
});

test("removes legacy k-skill state without losing Telegram users", () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-state-v3-"));
  const path = join(root, "state.sqlite");
  const initial = new StateStore(path, () => NOW);
  initial.importBootstrapUsers(["1001"]);
  initial.close();

  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE k_skill_releases (sha TEXT PRIMARY KEY);
    CREATE TABLE k_skill_state (id INTEGER PRIMARY KEY);
    CREATE TABLE k_skill_behavior_reviews (skill_id TEXT PRIMARY KEY);
    PRAGMA user_version = 3;
  `);
  database.close();

  try {
    const store = new StateStore(path, () => NOW);
    try {
      assert.equal(store.findEnabledUser("1001")?.telegramUserId, "1001");
    } finally {
      store.close();
    }
    const migrated = new DatabaseSync(path, { readOnly: true });
    const legacyTables = migrated
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'k_skill_%'",
      )
      .all();
    migrated.close();
    assert.deepEqual(legacyTables, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
