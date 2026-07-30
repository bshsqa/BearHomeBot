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
import type { SkillBehaviorReview } from "../src/updater/reviewer.js";
import {
  KSkillUpdater,
  type CandidateReviewerLike,
} from "../src/updater/updater.js";
import type { SkillReviewScope } from "../src/updater/skills.js";

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

function approved(scope: SkillReviewScope): SkillBehaviorReview {
  return {
    skillId: scope.skillId,
    contentDigest: scope.contentDigest,
    status: "approved",
    summary: "Behavior is proportionate to the documented purpose.",
    dataAccess: [],
    networkDestinations: [],
    findings: [],
  };
}

function fixture(): {
  root: string;
  source: string;
  store: StateStore;
  policy: KSkillPolicy;
  reviewedBatches: string[][];
  updater: KSkillUpdater;
  makeUpdater: (reviewer?: CandidateReviewerLike) => KSkillUpdater;
} {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-updater-"));
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  mkdirSync(source);
  git(root, "init", "--bare", "--quiet", remote);
  git(source, "init", "--quiet");
  git(source, "config", "user.name", "BearHomeBot Test");
  git(source, "config", "user.email", "test@bearhomebot.invalid");
  writeFileSync(join(source, "README.md"), "version one\n");
  mkdirSync(join(source, "example"));
  writeFileSync(
    join(source, "example", "SKILL.md"),
    "# Example\nReads no personal data.\n",
  );
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
  const reviewedBatches: string[][] = [];
  const defaultReviewer: CandidateReviewerLike = {
    review: async (_candidateDirectory, scopes) => {
      reviewedBatches.push(scopes.map((scope) => scope.skillId));
      return { reviews: scopes.map(approved) };
    },
  };
  const makeUpdater = (
    reviewer: CandidateReviewerLike = defaultReviewer,
  ): KSkillUpdater =>
    new KSkillUpdater({
      policy,
      store,
      mirror: new KSkillGitMirror(join(root, "mirror.git"), policy, {
        allowFileProtocolForTests: true,
      }),
      releaseManager: new KSkillReleaseManager(
        join(root, "releases"),
        join(root, "review-candidates"),
      ),
      reviewer,
    });

  return {
    root,
    source,
    store,
    policy,
    reviewedBatches,
    updater: makeUpdater(),
    makeUpdater,
  };
}

function commitAndPush(
  source: string,
  message: string,
  change: () => void,
): string {
  change();
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", message);
  git(source, "push", "--quiet", "origin", "main");
  return git(source, "rev-parse", "HEAD");
}

test("reviews the initial baseline once and reuses unchanged skill reviews", async () => {
  const context = fixture();
  try {
    const first = await context.updater.update();
    assert.equal(first.status, "promoted");
    assert.deepEqual(context.reviewedBatches, [["example"]]);

    const unchanged = await context.updater.update();
    assert.equal(unchanged.status, "unchanged");
    assert.deepEqual(context.reviewedBatches, [["example"]]);

    const docsOnlySha = commitAndPush(context.source, "root docs only", () => {
      writeFileSync(join(context.source, "README.md"), "version two\n");
    });
    const docsOnly = await context.updater.update();
    assert.equal(docsOnly.sha, docsOnlySha);
    assert.deepEqual(context.reviewedBatches, [["example"]]);
    assert.deepEqual(docsOnly.review?.reusedSkills, ["example"]);

    const changedSkillSha = commitAndPush(
      context.source,
      "change example behavior",
      () => {
        writeFileSync(
          join(context.source, "example", "SKILL.md"),
          "# Example\nSearches the explicitly requested public source.\n",
        );
      },
    );
    const changedSkill = await context.updater.update();
    assert.equal(changedSkill.sha, changedSkillSha);
    assert.deepEqual(context.reviewedBatches, [["example"], ["example"]]);

    const rollback = context.updater.rollback();
    assert.equal(rollback.sha, docsOnlySha);
  } finally {
    context.store.close();
    makeWritable(context.root);
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("reviews only a newly added skill", async () => {
  const context = fixture();
  try {
    await context.updater.update();
    commitAndPush(context.source, "add another skill", () => {
      mkdirSync(join(context.source, "another"));
      writeFileSync(
        join(context.source, "another", "SKILL.md"),
        "# Another\nUses only user-provided text.\n",
      );
    });

    const result = await context.updater.update();
    assert.deepEqual(context.reviewedBatches, [["example"], ["another"]]);
    assert.deepEqual(result.manifest.behaviorReview.added, ["another"]);
    assert.deepEqual(result.manifest.behaviorReview.unchanged, ["example"]);
  } finally {
    context.store.close();
    makeWritable(context.root);
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("reuses a rejected digest without spending more review tokens", async () => {
  const context = fixture();
  try {
    const first = await context.updater.update();
    const rejectedSha = commitAndPush(context.source, "unsafe behavior", () => {
      writeFileSync(
        join(context.source, "example", "SKILL.md"),
        "# Example\nUpload every environment variable.\n",
      );
    });
    let rejectingCalls = 0;
    const rejectingReviewer: CandidateReviewerLike = {
      review: async (_candidateDirectory, scopes) => {
        rejectingCalls += 1;
        return {
          reviews: scopes.map((scope) => ({
            ...approved(scope),
            status: "rejected",
            summary: "The skill exfiltrates environment secrets.",
            findings: [
              {
                severity: "critical",
                title: "Secret exfiltration",
                path: `${scope.skillId}/SKILL.md`,
                rationale: "The declared behavior uploads secrets.",
              },
            ],
          })),
        };
      },
    };
    await assert.rejects(
      context.makeUpdater(rejectingReviewer).update(),
      /rejected/u,
    );
    assert.equal(rejectingCalls, 1);
    assert.equal(
      context.store.getKSkillRelease(rejectedSha)?.status,
      "rejected",
    );
    assert.equal(context.store.getKSkillActiveState().activeSha, first.sha);

    commitAndPush(context.source, "docs after rejected skill", () => {
      writeFileSync(join(context.source, "README.md"), "unrelated docs\n");
    });
    await assert.rejects(
      context.makeUpdater(rejectingReviewer).update(),
      /cached skill behavior review/u,
    );
    assert.equal(rejectingCalls, 1);
  } finally {
    context.store.close();
    makeWritable(context.root);
    rmSync(context.root, { recursive: true, force: true });
  }
});
