import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CandidateManifest } from "../src/updater/gates.js";
import {
  buildReviewedCandidateManifest,
  discoverSkillReviewScopes,
} from "../src/updater/skills.js";

function manifest(): CandidateManifest {
  return {
    schemaVersion: 2,
    source: {
      url: "https://github.com/NomaDamas/k-skill.git",
      branch: "main",
      sha: "a".repeat(40),
      treeSha: "b".repeat(40),
    },
    tree: {
      fileCount: 1,
      totalBytes: 1,
      maximumBlobBytes: 1,
      executableFiles: 0,
    },
    changes: {
      count: 1,
      paths: ["alpha/SKILL.md"],
    },
    loaderSafety: {
      status: "passed",
      checkedAt: "2026-07-30T10:00:00.000Z",
    },
  };
}

test("digests each skill with its referenced and local package code", () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-skills-"));
  try {
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, "beta"));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "packages", "alpha"), { recursive: true });
    mkdirSync(join(root, "packages", "common"), { recursive: true });
    writeFileSync(
      join(root, "alpha", "SKILL.md"),
      "# Alpha\nRun `../scripts/alpha.py` using package `../packages/alpha`.\n",
    );
    writeFileSync(join(root, "beta", "SKILL.md"), "# Beta\nNo helpers.\n");
    writeFileSync(join(root, "scripts", "alpha.py"), "print('alpha')\n");
    writeFileSync(
      join(root, "packages", "alpha", "package.json"),
      JSON.stringify({
        name: "alpha",
        dependencies: { "@fixture/common": "1.0.0" },
      }),
    );
    writeFileSync(join(root, "packages", "alpha", "index.js"), "run();\n");
    writeFileSync(
      join(root, "packages", "common", "package.json"),
      JSON.stringify({ name: "@fixture/common" }),
    );
    writeFileSync(
      join(root, "packages", "common", "index.js"),
      "export const run = true;\n",
    );

    const first = discoverSkillReviewScopes(root);
    const alpha = first.find((scope) => scope.skillId === "alpha");
    const beta = first.find((scope) => scope.skillId === "beta");
    assert.ok(alpha?.files.includes("scripts/alpha.py"));
    assert.ok(alpha?.files.includes("packages/common/index.js"));
    assert.deepEqual(beta?.files, ["beta/SKILL.md"]);

    const baseline = buildReviewedCandidateManifest(
      manifest(),
      first,
      undefined,
      1,
    );
    assert.equal(baseline.behaviorReview.initialBaseline, true);
    assert.deepEqual(baseline.behaviorReview.added, ["alpha", "beta"]);

    writeFileSync(
      join(root, "packages", "common", "index.js"),
      "export const run = false;\n",
    );
    const second = discoverSkillReviewScopes(root);
    const incremental = buildReviewedCandidateManifest(
      manifest(),
      second,
      baseline,
      1,
    );
    assert.deepEqual(incremental.behaviorReview.changed, ["alpha"]);
    assert.deepEqual(incremental.behaviorReview.unchanged, ["beta"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
