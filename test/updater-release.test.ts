import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectCandidate } from "../src/updater/gates.js";
import { KSkillGitMirror } from "../src/updater/git.js";
import { loadKSkillPolicy, type KSkillPolicy } from "../src/updater/policy.js";
import {
  KSkillReleaseManager,
  type ReleaseMetadata,
} from "../src/updater/release.js";
import type { CandidateBehaviorReview } from "../src/updater/reviewer.js";
import {
  buildReviewedCandidateManifest,
  discoverSkillReviewScopes,
} from "../src/updater/skills.js";

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
  chmodSync(root, 0o700);
  for (const child of readdirSync(root)) {
    const path = join(root, child);
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      makeWritable(path);
    } else {
      chmodSync(path, 0o600);
    }
  }
}

test("retries equivalent security metadata and rejects stale release state", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-release-"));
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const mirrorPath = join(root, "mirror.git");
  const releaseRoot = join(root, "releases");
  const candidateRoot = join(root, "review-candidates");
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
  writeFileSync(join(source, "README.md"), "trusted source\n");
  mkdirSync(join(source, "example"));
  mkdirSync(join(source, "provider"));
  writeFileSync(
    join(source, "example", "SKILL.md"),
    "# Example\nRuns its local implementation.\n",
  );
  writeFileSync(
    join(source, "example", "run.py"),
    'provider = "../provider/SKILL.md"\n',
  );
  writeFileSync(join(source, "provider", "SKILL.md"), "# Provider\n");
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
  const mirror = new KSkillGitMirror(mirrorPath, policy, {
    allowFileProtocolForTests: true,
  });
  const manager = new KSkillReleaseManager(releaseRoot, candidateRoot, {
    now: () => new Date("2026-07-30T10:00:00.000Z"),
  });
  let releasePath: string | undefined;
  let symlinkReleasePath: string | undefined;

  try {
    const candidate = await mirror.fetchCandidate();
    const manifest = await inspectCandidate(
      mirror,
      candidate,
      undefined,
      policy,
    );
    const reviewPath = await manager.createReviewDirectory(mirror, candidate);
    assert.equal(
      readFileSync(join(reviewPath, "README.md"), "utf8"),
      "trusted source\n",
    );
    const scopes = discoverSkillReviewScopes(reviewPath);
    const reviewedManifest = buildReviewedCandidateManifest(
      manifest,
      scopes,
      undefined,
      1,
    );
    writeFileSync(join(reviewPath, "README.md"), "review mutation\n");
    manager.removeReviewDirectory(reviewPath);

    const digestBySkillId = new Map(
      scopes.map((scope) => [scope.skillId, scope.contentDigest]),
    );
    const behaviorReview: CandidateBehaviorReview = {
      status: "approved",
      summary: "Approved.",
      policyVersion: 1,
      totalSkills: 2,
      reviewedSkills: ["example", "provider"],
      reusedSkills: [],
      enabledSkills: ["example", "provider"],
      excludedSkills: [],
      skills: [
        {
          skillId: "example",
          contentDigest: digestBySkillId.get("example")!,
          status: "approved",
          summary: "Approved.",
          dataAccess: [],
          networkDestinations: [],
          findings: [],
          source: "reviewed",
        },
        {
          skillId: "provider",
          contentDigest: digestBySkillId.get("provider")!,
          status: "approved",
          summary: "Approved.",
          dataAccess: [],
          networkDestinations: [],
          findings: [],
          source: "reviewed",
        },
      ],
    };
    const release = await manager.finalizeRelease(
      mirror,
      candidate,
      reviewedManifest,
      behaviorReview,
    );
    releasePath = release.path;

    assert.equal(
      readFileSync(join(release.path, "README.md"), "utf8"),
      "trusted source\n",
    );
    assert.equal(lstatSync(join(release.path, "README.md")).mode & 0o222, 0);
    assert.equal(manager.verifyRelease(release.path).sha, candidate.sha);

    const retry = await manager.finalizeRelease(
      mirror,
      candidate,
      {
        ...reviewedManifest,
        source: {
          ...reviewedManifest.source,
          previousSha: "c".repeat(40),
        },
        changes: {
          count: 0,
          paths: [],
        },
        loaderSafety: {
          ...reviewedManifest.loaderSafety,
          checkedAt: "2026-07-30T11:00:00.000Z",
        },
        behaviorReview: {
          ...reviewedManifest.behaviorReview,
          initialBaseline: false,
          added: [],
          changed: [],
          unchanged: ["example", "provider"],
          removed: [],
        },
      },
      {
        ...behaviorReview,
        summary: "Cache retry.",
        reviewedSkills: [],
        reusedSkills: ["example", "provider"],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
        },
        skills: behaviorReview.skills.map((skill) => ({
          ...skill,
          source: "cache",
        })),
      },
    );
    assert.equal(retry.path, release.path);
    assert.equal(retry.metadata.validatedAt, release.metadata.validatedAt);

    await assert.rejects(
      manager.finalizeRelease(mirror, candidate, reviewedManifest, {
        ...behaviorReview,
        skills: behaviorReview.skills.map((skill) => ({
          ...skill,
          summary: "Stale per-skill review metadata.",
        })),
      }),
      /does not match the requested release/u,
    );
    await assert.rejects(
      manager.finalizeRelease(mirror, candidate, reviewedManifest, {
        ...behaviorReview,
        enabledSkills: [],
        excludedSkills: ["example", "provider"],
        status: "rejected",
      }),
      /does not enable any skills/u,
    );
    await assert.rejects(
      manager.finalizeRelease(mirror, candidate, reviewedManifest, {
        ...behaviorReview,
        skills: behaviorReview.skills.map((skill) => ({
          ...skill,
          status: "uncertain",
        })),
      }),
      /enables a skill that is not approved/u,
    );
    await assert.rejects(
      manager.finalizeRelease(mirror, candidate, reviewedManifest, {
        ...behaviorReview,
        skills: behaviorReview.skills.map((skill) => ({
          ...skill,
          contentDigest: "f".repeat(64),
        })),
      }),
      /skill digest is inconsistent/u,
    );

    const marker = join(release.path, ".bearhomebot-release.json");
    const originalMetadata = JSON.parse(
      readFileSync(marker, "utf8"),
    ) as ReleaseMetadata;
    chmodSync(marker, 0o600);
    writeFileSync(
      marker,
      `${JSON.stringify({
        ...originalMetadata,
        review: {
          ...originalMetadata.review,
          excludedSkills: ["example"],
        },
      })}\n`,
    );
    assert.throws(
      () => manager.verifyRelease(release.path),
      /does not uniquely partition/u,
    );
    writeFileSync(
      marker,
      `${JSON.stringify({
        ...originalMetadata,
        review: {
          ...originalMetadata.review,
          status: "approved_with_exclusions",
          enabledSkills: ["example"],
          excludedSkills: ["provider"],
        },
      })}\n`,
    );
    assert.throws(
      () => manager.verifyRelease(release.path),
      /excluded dependency/u,
    );
    writeFileSync(
      marker,
      `${JSON.stringify({
        ...originalMetadata,
        review: {
          ...originalMetadata.review,
          skills: originalMetadata.review.skills.map((skill) => ({
            ...skill,
            status: "uncertain",
          })),
        },
      })}\n`,
    );
    assert.throws(
      () => manager.verifyRelease(release.path),
      /enables a skill that is not approved/u,
    );
    writeFileSync(
      marker,
      `${JSON.stringify({
        ...originalMetadata,
        review: {
          ...originalMetadata.review,
          unexpected: true,
        },
      })}\n`,
    );
    assert.throws(
      () => manager.verifyRelease(release.path),
      /fields are invalid/u,
    );
    writeFileSync(marker, `${JSON.stringify(originalMetadata, null, 2)}\n`);
    chmodSync(marker, 0o400);

    const linkedRelease = join(releaseRoot, "f".repeat(40));
    symlinkReleasePath = linkedRelease;
    symlinkSync(release.path, linkedRelease, "dir");
    assert.throws(() => manager.verifyRelease(linkedRelease), /symbolic link/u);

    chmodSync(join(release.path, "README.md"), 0o600);
    writeFileSync(join(release.path, "README.md"), "tampered\n");
    assert.throws(() => manager.verifyRelease(release.path), /content digest/u);
  } finally {
    if (symlinkReleasePath) {
      unlinkSync(symlinkReleasePath);
    }
    if (releasePath) {
      makeWritable(releasePath);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
