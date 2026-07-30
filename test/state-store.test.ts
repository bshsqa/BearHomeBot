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

test("promotes validated k-skill releases and rolls back atomically", () => {
  const store = createStore();
  const firstSha = "a".repeat(40);
  const secondSha = "b".repeat(40);
  try {
    store.recordKSkillCandidate({
      sha: firstSha,
      treeSha: "1".repeat(40),
      sourceUrl: "https://github.com/NomaDamas/k-skill.git",
      sourceBranch: "main",
      manifest: { candidate: 1 },
    });
    store.markKSkillCandidateValidated({
      sha: firstSha,
      releasePath: `/releases/${firstSha}`,
      review: { status: "approved" },
    });
    store.promoteKSkillRelease(firstSha);

    store.recordKSkillCandidate({
      sha: secondSha,
      treeSha: "2".repeat(40),
      sourceUrl: "https://github.com/NomaDamas/k-skill.git",
      sourceBranch: "main",
      manifest: { candidate: 2 },
    });
    store.markKSkillCandidateValidated({
      sha: secondSha,
      releasePath: `/releases/${secondSha}`,
      review: { status: "approved" },
    });
    store.promoteKSkillRelease(secondSha);

    assert.deepEqual(store.getKSkillActiveState(), {
      activeSha: secondSha,
      previousSha: firstSha,
      updatedAt: NOW,
    });
    assert.equal(store.getKSkillRelease(firstSha)?.status, "superseded");

    const rolledBack = store.rollbackKSkillRelease();
    assert.equal(rolledBack.sha, firstSha);
    assert.equal(rolledBack.status, "active");
    assert.deepEqual(store.getKSkillActiveState(), {
      activeSha: firstSha,
      previousSha: secondSha,
      updatedAt: NOW,
    });
  } finally {
    store.close();
  }
});

test("refreshes review metadata for the active SHA atomically", () => {
  const store = createStore();
  const sha = "a".repeat(40);
  try {
    store.recordKSkillCandidate({
      sha,
      treeSha: "1".repeat(40),
      sourceUrl: "https://github.com/NomaDamas/k-skill.git",
      sourceBranch: "main",
      manifest: { scopeVersion: 1 },
    });
    store.markKSkillCandidateValidated({
      sha,
      releasePath: `/releases/${sha}-p1-s1`,
      review: { enabledSkills: ["old"] },
    });
    store.promoteKSkillRelease(sha);

    const refreshed = store.refreshActiveKSkillRelease({
      sha,
      releasePath: `/releases/${sha}-p1-s2`,
      manifest: { scopeVersion: 2 },
      review: { enabledSkills: ["new"] },
    });

    assert.equal(refreshed.status, "active");
    assert.equal(refreshed.releasePath, `/releases/${sha}-p1-s2`);
    assert.deepEqual(refreshed.manifest, { scopeVersion: 2 });
    assert.deepEqual(refreshed.review, { enabledSkills: ["new"] });
    assert.equal(store.getKSkillActiveState().activeSha, sha);
  } finally {
    store.close();
  }
});

test("records rejected k-skill candidates without release content", () => {
  const store = createStore();
  const sha = "c".repeat(40);
  try {
    store.recordKSkillCandidate({
      sha,
      treeSha: "3".repeat(40),
      sourceUrl: "https://github.com/NomaDamas/k-skill.git",
      sourceBranch: "main",
      manifest: { deterministic: true },
    });
    const rejected = store.rejectKSkillCandidate(
      sha,
      "deterministic_gate_failed",
    );

    assert.equal(rejected.status, "rejected");
    assert.equal(rejected.failureCode, "deterministic_gate_failed");
    assert.equal(rejected.releasePath, undefined);
  } finally {
    store.close();
  }
});

test("caches behavior reviews by skill digest and policy version", () => {
  const store = createStore();
  const sha = "d".repeat(40);
  const digest = "e".repeat(64);
  try {
    store.recordKSkillCandidate({
      sha,
      treeSha: "4".repeat(40),
      sourceUrl: "https://github.com/NomaDamas/k-skill.git",
      sourceBranch: "main",
      manifest: { behavior: true },
    });
    store.recordKSkillBehaviorReview({
      skillId: "ktx-booking",
      contentDigest: digest,
      policyVersion: 1,
      sourceSha: sha,
      review: { status: "approved" },
    });

    assert.deepEqual(
      store.getKSkillBehaviorReview("ktx-booking", digest, 1)?.review,
      { status: "approved" },
    );
    assert.equal(
      store.getKSkillBehaviorReview("ktx-booking", digest, 2),
      undefined,
    );
  } finally {
    store.close();
  }
});

test("migrates an existing schema version 1 database to updater state", () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-state-v1-"));
  const path = join(root, "state.sqlite");
  const database = new DatabaseSync(path);
  database.exec("PRAGMA user_version = 1");
  database.close();

  try {
    const store = new StateStore(path, () => NOW);
    try {
      assert.deepEqual(store.getKSkillActiveState(), {});
    } finally {
      store.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
