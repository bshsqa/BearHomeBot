import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadKSkillPolicy } from "../src/updater/policy.js";
import type { CommandOptions, CommandResult } from "../src/updater/process.js";
import { PodmanCandidateValidator } from "../src/updater/validator.js";

const POLICY_PATH = join(process.cwd(), "config", "k-skill-policy.json");
const IMAGE_ID = `sha256:${"a".repeat(64)}`;

function success(stdout = ""): CommandResult {
  return {
    exitCode: 0,
    stdout: Buffer.from(stdout),
    stderr: Buffer.alloc(0),
  };
}

test("runs acquisition with scripts disabled and CI without network", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-validator-"));
  const candidate = join(root, "candidate");
  const cache = join(root, "cache");
  mkdirSync(candidate);
  const calls: CommandOptions[] = [];
  const runner = async (options: CommandOptions): Promise<CommandResult> => {
    calls.push(options);
    if (calls.length === 1) {
      return success(`${IMAGE_ID.slice("sha256:".length)}\n`);
    }
    if (calls.length === 2) {
      mkdirSync(join(cache, "npm"), { recursive: true });
      writeFileSync(join(cache, "npm", "artifact"), "downloaded");
      writeFileSync(
        join(candidate, ".bearhomebot-npm-audit.json"),
        JSON.stringify({
          metadata: {
            vulnerabilities: {
              info: 0,
              low: 0,
              moderate: 0,
              high: 0,
              critical: 0,
              total: 0,
            },
          },
        }),
      );
    }
    return success();
  };

  try {
    const validator = new PodmanCandidateValidator(
      loadKSkillPolicy(POLICY_PATH),
      {
        runner,
        podmanExecutable: "fake-podman",
        env: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          BEARHOMEBOT_TELEGRAM_TOKEN: "must-not-leak",
          KSKILL_KTX_PASSWORD: "must-not-leak",
        },
      },
    );
    const result = await validator.validate(candidate, cache);
    const acquireArguments = calls[1]?.arguments ?? [];
    const validationArguments = calls[2]?.arguments ?? [];

    assert.equal(result.imageId, IMAGE_ID);
    assert.match(result.artifactDigest, /^[0-9a-f]{64}$/u);
    assert.equal(result.audit.total, 0);
    assert.equal(acquireArguments.includes("--network=slirp4netns"), true);
    assert.equal(
      acquireArguments.includes("/opt/bearhomebot/acquire.sh"),
      true,
    );
    assert.equal(acquireArguments.includes("beautifulsoup4==4.12.3"), true);
    assert.equal(acquireArguments.includes("soupsieve==2.9.1"), true);
    assert.equal(validationArguments.includes("--network=none"), true);
    assert.equal(
      validationArguments.includes(`--volume=${cache}:/cache:ro`),
      true,
    );
    assert.equal(
      Object.hasOwn(calls[1]?.env ?? {}, "BEARHOMEBOT_TELEGRAM_TOKEN"),
      false,
    );
    assert.equal(JSON.stringify(calls).includes("must-not-leak"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when the networkless validation process fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-validator-"));
  const candidate = join(root, "candidate");
  const cache = join(root, "cache");
  mkdirSync(candidate);
  let call = 0;

  try {
    const validator = new PodmanCandidateValidator(
      loadKSkillPolicy(POLICY_PATH),
      {
        runner: async () => {
          call += 1;
          if (call === 1) {
            return success(`${IMAGE_ID}\n`);
          }
          if (call === 3) {
            throw new Error("validation failed");
          }
          writeFileSync(
            join(candidate, ".bearhomebot-npm-audit.json"),
            JSON.stringify({
              metadata: {
                vulnerabilities: {
                  info: 0,
                  low: 0,
                  moderate: 0,
                  high: 0,
                  critical: 0,
                  total: 0,
                },
              },
            }),
          );
          return success();
        },
      },
    );
    await assert.rejects(
      validator.validate(candidate, cache),
      /validation failed/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects malformed validator image IDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-validator-"));
  const candidate = join(root, "candidate");
  const cache = join(root, "cache");
  mkdirSync(candidate);

  try {
    const validator = new PodmanCandidateValidator(
      loadKSkillPolicy(POLICY_PATH),
      {
        runner: async () => success("not-an-image-id\n"),
      },
    );
    await assert.rejects(
      validator.validate(candidate, cache),
      /invalid image ID/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
