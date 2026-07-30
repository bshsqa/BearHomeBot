import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { CandidateManifest } from "../src/updater/gates.js";
import { loadKSkillPolicy } from "../src/updater/policy.js";
import { CodexCandidateReviewer } from "../src/updater/reviewer.js";

const POLICY_PATH = join(process.cwd(), "config", "k-skill-policy.json");

function manifest(): CandidateManifest {
  return {
    schemaVersion: 1,
    source: {
      url: "https://github.com/NomaDamas/k-skill.git",
      branch: "main",
      sha: "a".repeat(40),
      treeSha: "b".repeat(40),
    },
    tree: {
      fileCount: 2,
      totalBytes: 100,
      maximumBlobBytes: 60,
      executableFiles: 0,
      packageJsonFiles: 1,
    },
    dependencies: {
      workspacePackages: 0,
      lockedNodeModules: 0,
      localWorkspaceLinks: 0,
      registryArtifacts: 0,
      entriesWithoutIntegrity: 0,
      entriesWithInstallScripts: 0,
      pythonRequirementFiles: 0,
    },
    changes: {
      count: 1,
      paths: ["package.json"],
      truncated: false,
    },
    deterministicGates: {
      status: "passed",
      checkedAt: "2026-07-30T10:00:00.000Z",
    },
  };
}

function fakeReviewer(
  root: string,
  review: Record<string, unknown>,
): CodexCandidateReviewer {
  const script = join(root, "fake-codex.mjs");
  writeFileSync(
    script,
    `
      let prompt = "";
      for await (const chunk of process.stdin) prompt += chunk;
      const leaked = Boolean(
        process.env.BEARHOMEBOT_TELEGRAM_TOKEN ||
        process.env.KSKILL_KTX_PASSWORD
      );
      const review = ${JSON.stringify(review)};
      const disabled = new Set();
      for (let index = 0; index < process.argv.length - 1; index += 1) {
        if (process.argv[index] === "--disable") {
          disabled.add(process.argv[index + 1]);
        }
      }
      const isolated =
        process.argv.includes("--ephemeral") &&
        process.argv.includes("--ignore-user-config") &&
        process.argv.includes("--ignore-rules") &&
        ["apps", "browser_use", "computer_use", "hooks", "memories",
         "multi_agent", "plugins", "workspace_dependencies"]
          .every((feature) => disabled.has(feature));
      if (leaked || !isolated) review.status = "rejected";
      process.stdout.write(JSON.stringify({
        type: "thread.started",
        thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53"
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: JSON.stringify(review) }
      }) + "\\n");
      process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\\n");
    `,
    { mode: 0o700 },
  );
  return new CodexCandidateReviewer(
    loadKSkillPolicy(POLICY_PATH),
    join(root, "review-workspace"),
    {
      executable: process.execPath,
      executablePrefixArguments: [script],
      env: {
        HOME: process.env.HOME,
        PATH: process.env.PATH,
        LANG: "C.UTF-8",
        BEARHOMEBOT_TELEGRAM_TOKEN: "must-not-leak",
        KSKILL_KTX_PASSWORD: "must-not-leak",
      },
    },
  );
}

test("parses a schema-shaped one-shot Codex approval without secret access", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-reviewer-"));
  const candidate = join(root, "candidate");
  mkdirSync(candidate);
  writeFileSync(join(candidate, "package.json"), "{}");

  try {
    const reviewer = fakeReviewer(root, {
      status: "approved",
      summary: "No material risk found.",
      findings: [],
    });
    const result = await reviewer.review(candidate, manifest());

    assert.equal(result.status, "approved");
    assert.equal(result.findings.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when Codex approves a high-severity finding", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-reviewer-"));
  const candidate = join(root, "candidate");
  mkdirSync(candidate);

  try {
    const reviewer = fakeReviewer(root, {
      status: "approved",
      summary: "Conflicting result.",
      findings: [
        {
          severity: "high",
          title: "Unsafe command",
          path: "script.js",
          rationale: "Runs an unsafe command.",
        },
      ],
    });
    const result = await reviewer.review(candidate, manifest());

    assert.equal(result.status, "rejected");
    assert.match(result.summary, /fail-closed/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
