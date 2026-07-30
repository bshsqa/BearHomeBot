import assert from "node:assert/strict";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectCandidate } from "../src/updater/gates.js";
import { KSkillGitMirror } from "../src/updater/git.js";
import { loadKSkillPolicy, type KSkillPolicy } from "../src/updater/policy.js";
import { KSkillReleaseManager } from "../src/updater/release.js";

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

test("materializes a fresh immutable release and detects later mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-release-"));
  const remote = join(root, "remote.git");
  const source = join(root, "source");
  const mirrorPath = join(root, "mirror.git");
  const releaseRoot = join(root, "releases");
  const validationRoot = join(root, "validation");
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
  const manager = new KSkillReleaseManager(releaseRoot, validationRoot, {
    now: () => new Date("2026-07-30T10:00:00.000Z"),
  });
  let releasePath: string | undefined;

  try {
    const candidate = await mirror.fetchCandidate();
    const manifest = await inspectCandidate(
      mirror,
      candidate,
      undefined,
      policy,
    );
    const validationPath = await manager.createValidationDirectory(
      mirror,
      candidate,
    );
    assert.equal(
      readFileSync(join(validationPath, "README.md"), "utf8"),
      "trusted source\n",
    );
    writeFileSync(join(validationPath, "README.md"), "validation mutation\n");
    manager.removeValidationDirectory(validationPath);

    const release = await manager.finalizeRelease(
      mirror,
      candidate,
      manifest,
      {
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
      },
      {
        status: "approved",
        summary: "Approved.",
        findings: [],
      },
    );
    releasePath = release.path;

    assert.equal(
      readFileSync(join(release.path, "README.md"), "utf8"),
      "trusted source\n",
    );
    assert.equal(lstatSync(join(release.path, "README.md")).mode & 0o222, 0);
    assert.equal(manager.verifyRelease(release.path).sha, candidate.sha);

    chmodSync(join(release.path, "README.md"), 0o600);
    writeFileSync(join(release.path, "README.md"), "tampered\n");
    assert.throws(() => manager.verifyRelease(release.path), /content digest/u);
  } finally {
    if (releasePath) {
      makeWritable(releasePath);
    }
    rmSync(root, { recursive: true, force: true });
  }
});
