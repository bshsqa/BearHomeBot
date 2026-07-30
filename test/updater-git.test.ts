import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
} {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-git-"));
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
  return {
    root,
    remote,
    source,
    policy: {
      ...base,
      upstream: { ...base.upstream, url: remote },
    },
  };
}

test("fetches an exact candidate and reads its NUL-delimited tree", async () => {
  const context = fixture();
  try {
    const mirror = new KSkillGitMirror(
      join(context.root, "mirror.git"),
      context.policy,
      { allowFileProtocolForTests: true },
    );
    const first = await mirror.fetchCandidate();
    const tree = await mirror.readTree(first.sha);

    assert.equal(first.sha, git(context.source, "rev-parse", "HEAD"));
    assert.deepEqual(
      tree.map((entry) => entry.path),
      ["package-lock.json", "package.json"],
    );
    assert.equal(
      JSON.parse(
        (
          await mirror.readBlob(
            tree.find((entry) => entry.path === "package.json")?.objectId ?? "",
            1024,
          )
        ).toString("utf8"),
      ).name,
      "fixture",
    );

    writeFileSync(join(context.source, "README.md"), "fixture\n");
    git(context.source, "add", "README.md");
    git(context.source, "commit", "--quiet", "-m", "second");
    git(context.source, "push", "--quiet", "origin", "main");

    const second = await mirror.fetchCandidate();
    assert.equal(await mirror.isDescendant(first.sha, second.sha), true);
    assert.deepEqual(await mirror.changedPaths(first.sha, second.sha), [
      "README.md",
    ]);
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});

test("refuses to reuse a mirror with a different origin", async () => {
  const context = fixture();
  try {
    const path = join(context.root, "mirror.git");
    const mirror = new KSkillGitMirror(path, context.policy, {
      allowFileProtocolForTests: true,
    });
    await mirror.ensure();

    const changedPolicy: KSkillPolicy = {
      ...context.policy,
      upstream: {
        ...context.policy.upstream,
        url: join(context.root, "different.git"),
      },
    };
    await assert.rejects(
      new KSkillGitMirror(path, changedPolicy, {
        allowFileProtocolForTests: true,
      }).ensure(),
      /does not match trusted policy/u,
    );
  } finally {
    rmSync(context.root, { recursive: true, force: true });
  }
});
