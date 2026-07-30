import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { CandidateGateError, inspectCandidate } from "../src/updater/gates.js";
import { KSkillGitMirror } from "../src/updater/git.js";
import { loadKSkillPolicy, type KSkillPolicy } from "../src/updater/policy.js";

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

function fixture(): {
  root: string;
  remote: string;
  source: string;
  policy: KSkillPolicy;
  mirror: KSkillGitMirror;
} {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-gates-"));
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
  git(source, "add", "package.json", "package-lock.json");
  git(source, "commit", "--quiet", "-m", "initial");
  git(source, "branch", "-M", "main");
  git(source, "remote", "add", "origin", remote);
  git(source, "push", "--quiet", "-u", "origin", "main");

  const base = loadKSkillPolicy(POLICY_PATH);
  const policy: KSkillPolicy = {
    ...base,
    upstream: { ...base.upstream, url: remote },
  };
  return {
    root,
    remote,
    source,
    policy,
    mirror: new KSkillGitMirror(join(root, "mirror.git"), policy, {
      allowFileProtocolForTests: true,
    }),
  };
}

function commitAndPush(source: string, message: string): void {
  git(source, "add", "-A");
  git(source, "commit", "--quiet", "-m", message);
  git(source, "push", "--quiet", "origin", "main");
}

async function rejectionCode(
  context: ReturnType<typeof fixture>,
  policy = context.policy,
): Promise<string | undefined> {
  const candidate = await context.mirror.fetchCandidate();
  try {
    await inspectCandidate(
      context.mirror,
      candidate,
      undefined,
      policy,
      () => new Date("2026-07-30T10:00:00.000Z"),
    );
    return undefined;
  } catch (error) {
    assert.ok(error instanceof CandidateGateError);
    return error.code;
  }
}

test("builds a deterministic manifest for a valid candidate", async () => {
  const context = fixture();
  try {
    const candidate = await context.mirror.fetchCandidate();
    const manifest = await inspectCandidate(
      context.mirror,
      candidate,
      undefined,
      context.policy,
      () => new Date("2026-07-30T10:00:00.000Z"),
    );

    assert.equal(manifest.source.sha, candidate.sha);
    assert.equal(manifest.tree.fileCount, 2);
    assert.equal(manifest.dependencies.lockedNodeModules, 0);
    assert.equal(manifest.deterministicGates.status, "passed");
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("rejects symlinks and submodule gitlinks before checkout", async (t) => {
  await t.test("symlink", async () => {
    const context = fixture();
    try {
      symlinkSync("package.json", join(context.source, "package-link"));
      commitAndPush(context.source, "add symlink");
      assert.equal(await rejectionCode(context), "symlink");
    } finally {
      rmSync(context.root, { recursive: true, force: true });
    }
  });

  await t.test("submodule", async () => {
    const context = fixture();
    try {
      const commit = git(context.source, "rev-parse", "HEAD");
      git(
        context.source,
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${commit},vendor/module`,
      );
      git(context.source, "commit", "--quiet", "-m", "add gitlink");
      git(context.source, "push", "--quiet", "origin", "main");
      assert.equal(await rejectionCode(context), "submodule");
    } finally {
      rmSync(context.root, { recursive: true, force: true });
    }
  });
});

test("rejects unsafe dependency sources and candidate npm config", async (t) => {
  await t.test("Git dependency", async () => {
    const context = fixture();
    try {
      writeFileSync(
        join(context.source, "package.json"),
        JSON.stringify({
          name: "fixture",
          version: "1.0.0",
          dependencies: {
            unsafe: "git+https://example.com/unsafe.git",
          },
        }),
      );
      commitAndPush(context.source, "unsafe dependency");
      assert.equal(await rejectionCode(context), "dependency_policy");
    } finally {
      rmSync(context.root, { recursive: true, force: true });
    }
  });

  await t.test(".npmrc", async () => {
    const context = fixture();
    try {
      writeFileSync(
        join(context.source, ".npmrc"),
        "registry=https://example.com/\n",
      );
      commitAndPush(context.source, "custom npm config");
      assert.equal(await rejectionCode(context), "dependency_policy");
    } finally {
      rmSync(context.root, { recursive: true, force: true });
    }
  });
});

test("rejects oversized blobs and control characters in paths", async (t) => {
  await t.test("oversized blob", async () => {
    const context = fixture();
    try {
      writeFileSync(join(context.source, "large.bin"), "x".repeat(1_001));
      commitAndPush(context.source, "large file");
      const policy: KSkillPolicy = {
        ...context.policy,
        limits: {
          ...context.policy.limits,
          maxBlobBytes: 1_000,
        },
      };
      assert.equal(await rejectionCode(context, policy), "oversized_blob");
    } finally {
      rmSync(context.root, { recursive: true, force: true });
    }
  });

  await t.test("control character", async () => {
    const context = fixture();
    try {
      writeFileSync(join(context.source, "bad\nname.txt"), "bad");
      commitAndPush(context.source, "unsafe path");
      assert.equal(await rejectionCode(context), "invalid_path");
    } finally {
      rmSync(context.root, { recursive: true, force: true });
    }
  });
});

test("rejects paths reserved for host metadata", async () => {
  const context = fixture();
  try {
    writeFileSync(
      join(context.source, ".bearhomebot-release.json"),
      '{"forged":true}\n',
    );
    commitAndPush(context.source, "reserved release metadata");
    assert.equal(await rejectionCode(context), "invalid_path");
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("rejects candidates whose changed paths exceed the review limit", async () => {
  const context = fixture();
  try {
    writeFileSync(join(context.source, "one.txt"), "one\n");
    writeFileSync(join(context.source, "two.txt"), "two\n");
    commitAndPush(context.source, "too many changed paths");
    const policy: KSkillPolicy = {
      ...context.policy,
      codexReview: {
        ...context.policy.codexReview,
        maxChangedPaths: 3,
      },
    };
    assert.equal(await rejectionCode(context, policy), "changed_path_limit");
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});
