import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { generateMasterKey } from "../src/vault/crypto.js";
import type { UnlockedVaultKeys } from "../src/vault/key-provider.js";
import { EncryptedVaultStore, VaultStoreError } from "../src/vault/store.js";
import { KTX_CREDENTIAL_IDS, telegramPrincipal } from "../src/vault/types.js";

const NOW = "2026-07-31T00:00:00.000Z";

function keyring(
  activeVersion = 1,
  supplied?: ReadonlyMap<number, Buffer>,
): UnlockedVaultKeys {
  return {
    provider: "test",
    activeVersion,
    keys: supplied ?? new Map([[1, generateMasterKey()]]),
  };
}

test("separates encrypted credentials by Telegram principal", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-vault-"));
  const path = join(root, "vault.sqlite");
  const keys = keyring();
  const store = new EncryptedVaultStore(path, keys, () => NOW);
  const secret = Buffer.from("vault-only-password");
  const captured: Buffer[] = [];
  try {
    const owner = telegramPrincipal("1001");
    const other = telegramPrincipal("1002");
    const stored = store.putCredential(owner, KTX_CREDENTIAL_IDS[1]!, secret);
    assert.equal(stored.version, 1);
    assert.equal(store.hasCredential(owner, KTX_CREDENTIAL_IDS[1]!), true);
    assert.equal(store.hasCredential(other, KTX_CREDENTIAL_IDS[1]!), false);
    assert.deepEqual(store.listCredentials(other), []);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(
      readFileSync(path).includes(Buffer.from("vault-only-password")),
      false,
    );

    await store.withCredentials(owner, [KTX_CREDENTIAL_IDS[1]!], (values) => {
      const plaintext = values.get("KSKILL_KTX_PASSWORD")!;
      assert.equal(plaintext.toString("utf8"), secret.toString("utf8"));
      captured.push(plaintext);
    });
    assert.equal(
      captured[0]?.every((byte) => byte === 0),
      true,
    );
    await assert.rejects(
      store.withCredentials(other, [KTX_CREDENTIAL_IDS[1]!], () => undefined),
      (error: unknown) =>
        error instanceof VaultStoreError &&
        error.code === "credential_not_found",
    );
  } finally {
    store.close();
    for (const key of keys.keys.values()) {
      key.fill(0);
    }
    secret.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("rotates credential versions and encryption key versions", async () => {
  const firstKey = generateMasterKey();
  const keys = keyring(1, new Map([[1, firstKey]]));
  const store = new EncryptedVaultStore(":memory:", keys, () => NOW);
  const principal = telegramPrincipal("1001");
  const firstSecret = Buffer.from("first-password");
  const secondSecret = Buffer.from("second-password");
  const secondKey = generateMasterKey();
  try {
    store.putCredential(principal, KTX_CREDENTIAL_IDS[1]!, firstSecret);
    const rotatedCredential = store.putCredential(
      principal,
      KTX_CREDENTIAL_IDS[1]!,
      secondSecret,
    );
    assert.equal(rotatedCredential.version, 2);

    store.rotateEncryptionKey(2, secondKey);
    assert.equal(store.listCredentials(principal)[0]?.keyVersion, 2);
    await store.withCredentials(
      principal,
      [KTX_CREDENTIAL_IDS[1]!],
      (values) => {
        assert.equal(
          values.get("KSKILL_KTX_PASSWORD")?.toString("utf8"),
          "second-password",
        );
      },
    );
  } finally {
    store.close();
    firstKey.fill(0);
    secondKey.fill(0);
    firstSecret.fill(0);
    secondSecret.fill(0);
  }
});

test("detects database ciphertext authentication-tag tampering", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-vault-"));
  const path = join(root, "vault.sqlite");
  const masterKey = generateMasterKey();
  const keys = keyring(1, new Map([[1, masterKey]]));
  const principal = telegramPrincipal("1001");
  const secret = Buffer.from("tamper target");
  let store = new EncryptedVaultStore(path, keys, () => NOW);
  try {
    store.putCredential(principal, KTX_CREDENTIAL_IDS[1]!, secret);
    store.close();
    const database = new DatabaseSync(path);
    database
      .prepare(
        "UPDATE credentials SET auth_tag = zeroblob(16) WHERE telegram_user_id = ?",
      )
      .run("1001");
    database.close();

    store = new EncryptedVaultStore(path, keys, () => NOW);
    await assert.rejects(
      store.withCredentials(
        principal,
        [KTX_CREDENTIAL_IDS[1]!],
        () => undefined,
      ),
      /authentication failed/u,
    );
  } finally {
    store.close();
    masterKey.fill(0);
    secret.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});
