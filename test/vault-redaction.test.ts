import assert from "node:assert/strict";
import test from "node:test";

import { redactText, safeErrorMessage } from "../src/vault/redaction.js";

test("redacts literal, encoded, structured, and token-shaped secrets", () => {
  const secret = "pa$$word/value";
  const text = [
    secret,
    encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"),
    "KSKILL_KTX_PASSWORD=another-secret",
    "123456789:abcdefghijklmnopqrstuvwxyzABCDE",
    "Bearer abc.def-123",
  ].join(" ");
  const redacted = redactText(text, [secret]);

  assert.doesNotMatch(redacted, /pa\$\$word/u);
  assert.doesNotMatch(redacted, /another-secret/u);
  assert.doesNotMatch(redacted, /abcdefghijklmnopqrstuvwxyz/u);
  assert.doesNotMatch(redacted, /abc\.def/u);
  assert.match(redacted, /\[REDACTED\]/u);
});

test("does not expose an Error message containing structured credentials", () => {
  assert.equal(
    safeErrorMessage(new Error("failed KSKILL_KTX_ID=private-family-id")),
    "failed KSKILL_KTX_ID=[REDACTED]",
  );
});
