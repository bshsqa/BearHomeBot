import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  classifyOperation,
  loadOperationsPolicy,
  parseOperationsPolicy,
} from "../src/policy/operations.js";

const POLICY_PATH = join(process.cwd(), "config", "operations-policy.json");

test("loads the approved host, action, updater, log, and backup policy", () => {
  const policy = loadOperationsPolicy(POLICY_PATH);

  assert.equal(policy.hostDiskEncryption.required, false);
  assert.equal(classifyOperation(policy, "public.search"), "automatic");
  assert.equal(
    classifyOperation(policy, "reservation.create"),
    "confirmation-required",
  );
  assert.equal(classifyOperation(policy, "payment"), "prohibited");
  assert.equal(policy.kSkillUpdate.localTime, "00:00");
  assert.equal(policy.logs.retentionDays, 30);
  assert.equal(policy.backups.retentionCopies, 8);
});

test("rejects operations that are missing, duplicated, or unknown", () => {
  const policy = loadOperationsPolicy(POLICY_PATH);
  assert.throws(
    () =>
      parseOperationsPolicy({
        ...policy,
        actions: {
          ...policy.actions,
          automatic: [...policy.actions.automatic, "payment"],
        },
      }),
    /exactly one decision/u,
  );
  assert.throws(
    () =>
      parseOperationsPolicy({
        ...policy,
        actions: {
          ...policy.actions,
          automatic: ["public.unknown"],
        },
      }),
    /unknown operation/u,
  );
});
