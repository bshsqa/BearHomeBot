import { isAbsolute, resolve } from "node:path";

import {
  ensureRuntimeDirectories,
  resolveRuntimePaths,
} from "./runtime-paths.js";
import { StateStore } from "./state/store.js";
import { KSkillGitMirror } from "./updater/git.js";
import { defaultKSkillPolicyPath, loadKSkillPolicy } from "./updater/policy.js";
import { KSkillReleaseManager } from "./updater/release.js";
import { CodexCandidateReviewer } from "./updater/reviewer.js";
import { KSkillUpdater } from "./updater/updater.js";
import { PodmanCandidateValidator } from "./updater/validator.js";

process.umask(0o077);

function policyPath(): string {
  const configured = process.env.BEARHOMEBOT_KSKILL_POLICY_FILE;
  if (!configured) {
    return defaultKSkillPolicyPath();
  }
  if (!isAbsolute(configured)) {
    throw new Error("BEARHOMEBOT_KSKILL_POLICY_FILE must be absolute");
  }
  return resolve(configured);
}

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  node dist/updater-main.js check",
      "  node dist/updater-main.js update",
      "  node dist/updater-main.js status",
      "  node dist/updater-main.js rollback [validated-sha]",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

const [command, ...arguments_] = process.argv.slice(2);
if (!command || !["check", "update", "status", "rollback"].includes(command)) {
  usage();
}
if (
  (command !== "rollback" && arguments_.length !== 0) ||
  (command === "rollback" && arguments_.length > 1)
) {
  usage();
}

const paths = resolveRuntimePaths();
await ensureRuntimeDirectories(paths);
const policy = loadKSkillPolicy(policyPath());
const store = new StateStore(paths.stateDatabase);

try {
  if (command === "status") {
    process.stdout.write(
      `${JSON.stringify(
        {
          state: store.getKSkillActiveState(),
          releases: store.listKSkillReleases(),
        },
        null,
        2,
      )}\n`,
    );
  } else {
    const mirror = new KSkillGitMirror(paths.kSkillMirror, policy);
    const releaseManager = new KSkillReleaseManager(
      paths.releaseRoot,
      paths.kSkillValidationRoot,
    );
    const baseOptions = {
      policy,
      store,
      mirror,
      releaseManager,
      cacheRoot: paths.kSkillCache,
    };
    if (command === "check") {
      const updater = new KSkillUpdater(baseOptions);
      process.stdout.write(
        `${JSON.stringify(await updater.check(), null, 2)}\n`,
      );
    } else if (command === "rollback") {
      const updater = new KSkillUpdater(baseOptions);
      process.stdout.write(
        `${JSON.stringify(updater.rollback(arguments_[0]), null, 2)}\n`,
      );
    } else {
      const updater = new KSkillUpdater({
        ...baseOptions,
        validator: new PodmanCandidateValidator(policy),
        reviewer: new CodexCandidateReviewer(
          policy,
          paths.kSkillReviewWorkspace,
        ),
      });
      process.stdout.write(
        `${JSON.stringify(await updater.update(), null, 2)}\n`,
      );
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`BearHomeBot k-skill updater failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  store.close();
}
