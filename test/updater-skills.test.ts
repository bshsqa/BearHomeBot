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

test("broadens review scope for prose mentions without a hard dependency", () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-related-skills-"));
  try {
    mkdirSync(join(root, "coordinator"));
    mkdirSync(join(root, "provider"));
    mkdirSync(join(root, "never-use"));
    writeFileSync(
      join(root, "coordinator", "SKILL.md"),
      "# Coordinator\nUse [provider](../provider/SKILL.md) for other requests.\nExample: --never-use never-use\n",
    );
    writeFileSync(
      join(root, "provider", "SKILL.md"),
      "# Provider\nReads public provider data.\n",
    );
    writeFileSync(join(root, "provider", "helper.py"), "print('provider')\n");
    writeFileSync(join(root, "never-use", "SKILL.md"), "# Never Use\n");

    const scopes = discoverSkillReviewScopes(root);
    const coordinator = scopes.find((scope) => scope.skillId === "coordinator");

    assert.ok(coordinator?.files.includes("provider/SKILL.md"));
    assert.ok(coordinator?.files.includes("provider/helper.py"));
    assert.ok(coordinator?.files.includes("never-use/SKILL.md"));
    assert.deepEqual(coordinator?.dependencies, []);
    const reviewedManifest = buildReviewedCandidateManifest(
      manifest(),
      scopes,
      undefined,
      1,
    );
    assert.deepEqual(
      reviewedManifest.behaviorReview.inventory.find(
        (item) => item.skillId === "coordinator",
      )?.dependencies,
      [],
    );

    const previousWithStaleDependency = structuredClone(reviewedManifest);
    const previousCoordinator =
      previousWithStaleDependency.behaviorReview.inventory.find(
        (item) => item.skillId === "coordinator",
      );
    assert.ok(previousCoordinator);
    previousCoordinator.dependencies = ["provider"];
    const refreshedManifest = buildReviewedCandidateManifest(
      manifest(),
      scopes,
      previousWithStaleDependency,
      1,
    );
    assert.ok(
      refreshedManifest.behaviorReview.unchanged.includes("coordinator"),
    );
    assert.deepEqual(
      refreshedManifest.behaviorReview.inventory.find(
        (item) => item.skillId === "coordinator",
      )?.dependencies,
      [],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finds exact sibling references inside skill implementation files", () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-script-reference-"));
  try {
    mkdirSync(join(root, "coordinator"));
    mkdirSync(join(root, "provider"));
    mkdirSync(join(root, "provider-extra"));
    writeFileSync(
      join(root, "coordinator", "SKILL.md"),
      "# Coordinator\nRuns its local implementation.\n",
    );
    writeFileSync(
      join(root, "coordinator", "run.py"),
      'SIBLING_SKILL = "provider-extra"\n',
    );
    writeFileSync(join(root, "provider", "SKILL.md"), "# Provider\n");
    writeFileSync(
      join(root, "provider-extra", "SKILL.md"),
      "# Provider Extra\n",
    );
    writeFileSync(
      join(root, "provider-extra", "helper.py"),
      "print('extra')\n",
    );

    const coordinator = discoverSkillReviewScopes(root).find(
      (scope) => scope.skillId === "coordinator",
    );

    assert.deepEqual(coordinator?.dependencies, ["provider-extra"]);
    assert.ok(coordinator?.files.includes("provider-extra/helper.py"));
    assert.equal(coordinator?.files.includes("provider/SKILL.md"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviews sibling paths reached through shared scripts and packages", () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-script-package-"));
  try {
    mkdirSync(join(root, "coordinator"));
    mkdirSync(join(root, "provider"));
    mkdirSync(join(root, "package-provider"));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "packages", "shared"), { recursive: true });
    writeFileSync(
      join(root, "coordinator", "SKILL.md"),
      "# Coordinator\nRuns its local implementation.\n",
    );
    writeFileSync(
      join(root, "coordinator", "run.js"),
      [
        'import { run } from "@fixture/shared";',
        'const helper = "../scripts/shared.py";',
        "run(helper);",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "scripts", "shared.py"),
      'helper = "../provider/helper.py"\n',
    );
    writeFileSync(join(root, "provider", "SKILL.md"), "# Provider\n");
    writeFileSync(join(root, "provider", "helper.py"), "print('provider')\n");
    writeFileSync(
      join(root, "package-provider", "SKILL.md"),
      "# Package Provider\n",
    );
    writeFileSync(
      join(root, "package-provider", "helper.py"),
      "print('package provider')\n",
    );
    writeFileSync(
      join(root, "packages", "shared", "package.json"),
      JSON.stringify({ name: "@fixture/shared" }),
    );
    writeFileSync(
      join(root, "packages", "shared", "index.js"),
      'const helper = "../../package-provider/helper.py";\nexport const run = () => helper;\n',
    );

    const coordinator = discoverSkillReviewScopes(root).find(
      (scope) => scope.skillId === "coordinator",
    );

    assert.ok(coordinator?.files.includes("scripts/shared.py"));
    assert.ok(coordinator?.files.includes("packages/shared/index.js"));
    assert.ok(coordinator?.files.includes("provider/helper.py"));
    assert.ok(coordinator?.files.includes("package-provider/helper.py"));
    assert.deepEqual(coordinator?.dependencies, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("follows transitive skill references and invalidates the parent digest", () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-transitive-skills-"));
  try {
    mkdirSync(join(root, "coordinator"));
    mkdirSync(join(root, "provider"));
    mkdirSync(join(root, "source"));
    writeFileSync(
      join(root, "coordinator", "SKILL.md"),
      "# Coordinator\nRuns its local implementation.\n",
    );
    writeFileSync(
      join(root, "coordinator", "run.py"),
      'helper = "../provider/helper.py"\n',
    );
    writeFileSync(join(root, "provider", "SKILL.md"), "# Provider\n");
    writeFileSync(
      join(root, "provider", "helper.py"),
      'source = "../source/helper.py"\n',
    );
    writeFileSync(join(root, "source", "SKILL.md"), "# Source\n");
    writeFileSync(join(root, "source", "helper.py"), "VALUE = 1\n");

    const first = discoverSkillReviewScopes(root).find(
      (scope) => scope.skillId === "coordinator",
    );
    assert.deepEqual(first?.dependencies, ["provider", "source"]);
    assert.ok(first?.files.includes("source/helper.py"));

    writeFileSync(join(root, "source", "helper.py"), "VALUE = 2\n");
    const second = discoverSkillReviewScopes(root).find(
      (scope) => scope.skillId === "coordinator",
    );
    assert.notEqual(second?.contentDigest, first?.contentDigest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
