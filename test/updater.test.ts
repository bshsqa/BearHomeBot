import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { StateStore } from "../src/state/store.js";
import { KSkillGitMirror } from "../src/updater/git.js";
import { loadKSkillPolicy, type KSkillPolicy } from "../src/updater/policy.js";
import { KSkillReleaseManager } from "../src/updater/release.js";
import {
  KSkillUpdater,
  type CandidateReviewerLike,
  type CandidateValidatorLike,
} from "../src/updater/updater.js";

const POLICY_PATH = join(process.cwd(), "config", "k-skill-policy.json");

function git(cwd: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, {
    cwd,
    encoding: "utf8",
    env: {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
    },
  }).trim();
}

function makeWritable(root: string): void {
  if (!lstatSync(root).isDirectory()) {
    chmodSync(root, 0o600);
    return;
  }
  chmodSync(root, 0o700);
  for (const child of readdirSync(root)) {
    makeWritable(join(root, child));
  }
}

function fixture(): {
  root: string;
  source: string;
  store: StateStore;
  updater: KSkillUpdater;
  policy: KSkillPolicy;
} {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-updater-"));
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  mkdirSync(source);
  git(root, "init", "--bare", "--quiet", remote);
  git(source, "init", "--quiet");
  git(source, "config", "user.name", "BearHomeBot Test");
  git(source, "config", "user.email", "test@bearhomebot.invalid");
  writeFileSync(
    join(source, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  writeFileSync(
    join(source, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: { "": { name: "fixture", version: "1.0.0" } },
    }),
  );
  writeFileSync(join(source, "README.md"), "version one\n");
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", "initial");
  git(source, "branch", "-M", "main");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "--quiet", "-u", "origin", "main");

  const base = loadKSkillPolicy(POLICY_PATH);
  const policy: KSkillPolicy = {
    ...base,
    upstream: { ...base.upstream, url: remote },
  };
  const store = new StateStore(
    join(root, "state.sqlite"),
    () => "2026-07-30T10:00:00.000Z",
  );
  const mirror = new KSkillGitMirror(join(root, "mirror.git"), policy, {
    allowFileProtocolForTests: true,
  });
  const releaseManager = new KSkillReleaseManager(
    join(root, "releases"),
    join(root, "validation"),
    {
      now: () => new Date("2026-07-30T10:00:00.000Z"),
    },
  );
  const validator: CandidateValidatorLike = {
    validate: async () => ({
      imageId: `sha256:${"a".repeat(64)}`,
      artifactDigest: "b".repeat(64),
      audit: {
        info: 0,
        low: 0,
        moderate: 0,
        high: 0,
        critical: 0,
        total: 0,
      },
    }),
  };
  const reviewer: CandidateReviewerLike = {
    review: async () => ({
      status: "approved",
      summary: "Approved by fixture.",
      findings: [],
    }),
  };
  return {
    root,
    source,
    store,
    policy,
    updater: new KSkillUpdater({
      policy,
      store,
      mirror,
      releaseManager,
      cacheRoot: join(root, "cache"),
      validator,
      reviewer,
    }),
  };
}

function commitAndPush(source: string, text: string): string {
  writeFileSync(join(source, "README.md"), text);
  git(source, "add", "README.md");
  git(source, "commit", "--quiet", "-m", text.trim());
  git(source, "push", "--quiet", "origin", "main");
  return git(source, "rev-parse", "HEAD");
}

test("runs the complete updater, preserves no-op state, and rolls back", async () => {
  const context = fixture();
  try {
    const first = await context.updater.update();
    assert.equal(first.status, "promoted");
    assert.equal(context.store.getKSkillActiveState().activeSha, first.sha);

    const unchanged = await context.updater.update();
    assert.equal(unchanged.status, "unchanged");
    assert.equal(unchanged.sha, first.sha);

    const secondSha = commitAndPush(context.source, "version two\n");
    const second = await context.updater.update();
    assert.equal(second.status, "promoted");
    assert.equal(second.sha, secondSha);
    assert.equal(context.store.getKSkillActiveState().previousSha, first.sha);

    const rollback = context.updater.rollback();
    assert.equal(rollback.sha, first.sha);
    assert.equal(context.store.getKSkillActiveState().activeSha, first.sha);
  } finally {
    context.store.close();
    makeWritable(context.root);
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("keeps the active release when Codex rejects a new candidate", async () => {
  const context = fixture();
  try {
    const first = await context.updater.update();
    const rejectedSha = commitAndPush(context.source, "unsafe candidate\n");
    const rejectingUpdater = new KSkillUpdater({
      policy: context.policy,
      store: context.store,
      mirror: new KSkillGitMirror(
        join(context.root, "mirror.git"),
        context.policy,
        { allowFileProtocolForTests: true },
      ),
      releaseManager: new KSkillReleaseManager(
        join(context.root, "releases"),
        join(context.root, "validation"),
      ),
      cacheRoot: join(context.root, "cache"),
      validator: {
        validate: async () => ({
          imageId: `sha256:${"a".repeat(64)}`,
          artifactDigest: "b".repeat(64),
          audit: {
            info: 0,
            low: 0,
            moderate: 0,
            high: 0,
            critical: 0,
            total: 0,
          },
        }),
      },
      reviewer: {
        review: async () => ({
          status: "rejected",
          summary: "Unsafe behavior.",
          findings: [
            {
              severity: "high",
              title: "Unsafe behavior",
              path: "",
              rationale: "Fixture rejection.",
            },
          ],
        }),
      },
    });

    await assert.rejects(rejectingUpdater.update(), /did not approve/u);
    assert.equal(context.store.getKSkillActiveState().activeSha, first.sha);
    assert.equal(
      context.store.getKSkillRelease(rejectedSha)?.status,
      "rejected",
    );
    assert.equal(
      (
        context.store.getKSkillRelease(rejectedSha)?.review as {
          status?: string;
        }
      ).status,
      "rejected",
    );
  } finally {
    context.store.close();
    makeWritable(context.root);
    rmSync(context.root, { recursive: true, force: true });
  }
});
