import assert from "node:assert/strict";
import test from "node:test";

import {
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  VaultCryptoError,
} from "../src/vault/crypto.js";
import { telegramPrincipal } from "../src/vault/types.js";

const CREDENTIAL = {
  scope: "ktx",
  name: "KSKILL_KTX_PASSWORD",
} as const;

test("authenticates encrypted credentials and their ownership context", () => {
  const key = generateMasterKey();
  const plaintext = Buffer.from("correct horse battery staple");
  const context = {
    principal: telegramPrincipal("1001"),
    credential: CREDENTIAL,
    credentialVersion: 1,
    keyVersion: 1,
  };
  try {
    const encrypted = encryptSecret(key, plaintext, context);
    assert.equal(encrypted.ciphertext.includes(plaintext), false);
    assert.equal(
      decryptSecret(key, encrypted, context).toString("utf8"),
      plaintext.toString("utf8"),
    );

    assert.throws(
      () =>
        decryptSecret(key, encrypted, {
          ...context,
          principal: telegramPrincipal("1002"),
        }),
      (error: unknown) =>
        error instanceof VaultCryptoError &&
        error.code === "authentication_failed",
    );
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
});

test("rejects ciphertext and authentication-tag tampering", () => {
  const key = generateMasterKey();
  const plaintext = Buffer.from("not logged");
  try {
    const context = {
      principal: telegramPrincipal("1001"),
      credential: CREDENTIAL,
      credentialVersion: 2,
      keyVersion: 3,
    };
    const encrypted = encryptSecret(key, plaintext, context);
    encrypted.authTag[0] = encrypted.authTag[0]! ^ 0xff;

    assert.throws(
      () => decryptSecret(key, encrypted, context),
      /authentication failed/u,
    );
  } finally {
    key.fill(0);
    plaintext.fill(0);
  }
});
