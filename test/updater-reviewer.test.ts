import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadKSkillPolicy } from "../src/updater/policy.js";
import { CodexCandidateReviewer } from "../src/updater/reviewer.js";
import type { SkillReviewScope } from "../src/updater/skills.js";

const POLICY_PATH = join(process.cwd(), "config", "k-skill-policy.json");

function scope(): SkillReviewScope {
  return {
    skillId: "example",
    contentDigest: "a".repeat(64),
    files: ["example/SKILL.md", "example/run.py"],
    dependencies: [],
  };
}

function fakeReviewer(
  root: string,
  reviews: Array<Record<string, unknown>>,
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
      const reviews = ${JSON.stringify(reviews)};
      if (leaked || !isolated || !prompt.includes("privacy risk")) {
        reviews[0].status = "rejected";
      }
      process.stdout.write(JSON.stringify({
        type: "thread.started",
        thread_id: "0199a213-81c0-7800-8aa1-bbab2a035a53"
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: JSON.stringify({ reviews })
        }
      }) + "\\n");
      process.stdout.write(JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 50, output_tokens: 10 }
      }) + "\\n");
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

function review(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    skillId: "example",
    contentDigest: "a".repeat(64),
    status: "approved",
    summary: "Behavior matches the documented purpose.",
    dataAccess: ["user-provided search term"],
    networkDestinations: ["https://example.test"],
    findings: [],
    ...overrides,
  };
}

test("returns a schema-shaped behavior review without secret access", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-reviewer-"));
  const candidate = join(root, "candidate");
  mkdirSync(join(candidate, "example"), { recursive: true });
  writeFileSync(join(candidate, "example", "SKILL.md"), "# Example\n");

  try {
    const reviewer = fakeReviewer(root, [review()]);
    const result = await reviewer.review(candidate, [scope()]);

    assert.equal(result.reviews[0]?.status, "approved");
    assert.deepEqual(result.reviews[0]?.dataAccess, [
      "user-provided search term",
    ]);
    assert.equal(result.usage?.inputTokens, 50);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects approval that contains a high-severity behavior finding", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-reviewer-"));
  const candidate = join(root, "candidate");
  mkdirSync(join(candidate, "example"), { recursive: true });

  try {
    const reviewer = fakeReviewer(root, [
      review({
        findings: [
          {
            severity: "high",
            title: "Secret exfiltration",
            path: "example/run.py",
            rationale: "Sends an environment secret to an unrelated host.",
          },
        ],
      }),
    ]);
    const result = await reviewer.review(candidate, [scope()]);

    assert.equal(result.reviews[0]?.status, "rejected");
    assert.match(result.reviews[0]?.summary ?? "", /High-severity/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
