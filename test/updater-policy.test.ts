import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadKSkillPolicy } from "../src/updater/policy.js";

const POLICY_PATH = join(process.cwd(), "config", "k-skill-policy.json");

test("loads the version-controlled k-skill trust policy", () => {
  const policy = loadKSkillPolicy(POLICY_PATH);

  assert.equal(policy.upstream.url, "https://github.com/NomaDamas/k-skill.git");
  assert.equal(policy.upstream.branch, "main");
  assert.equal(policy.limits.maxBlobBytes, 5 * 1024 * 1024);
  assert.equal(policy.validation.image.includes("@latest"), false);
});

test("rejects unknown fields and credentialed upstream URLs", () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-policy-"));
  try {
    const policy = JSON.parse(readFileSync(POLICY_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    const upstream = policy.upstream as Record<string, unknown>;
    upstream.url = "https://user:password@example.com/repository.git";
    policy.unexpected = true;
    const path = join(root, "policy.json");
    writeFileSync(path, JSON.stringify(policy));

    assert.throws(() => loadKSkillPolicy(path), /not supported/u);

    delete policy.unexpected;
    writeFileSync(path, JSON.stringify(policy));
    assert.throws(() => loadKSkillPolicy(path), /credential-free HTTPS/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
