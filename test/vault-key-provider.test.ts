import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  openSync,
  closeSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  destroyUnlockedKeys,
  type DpapiAdapter,
  VaultKeyProviderError,
  WindowsDpapiKeyProvider,
} from "../src/vault/key-provider.js";
import { SecretVault } from "../src/vault/service.js";

class FakeDpapiAdapter implements DpapiAdapter {
  readonly mask = 0xa5;

  async protect(plaintext: Buffer): Promise<Buffer> {
    return Buffer.concat([
      Buffer.from("DPAPI"),
      Buffer.from(plaintext.map((byte) => byte ^ this.mask)),
    ]);
  }

  async unprotect(ciphertext: Buffer): Promise<Buffer> {
    if (ciphertext.subarray(0, 5).toString("ascii") !== "DPAPI") {
      throw new Error("wrong DPAPI context");
    }
    return Buffer.from(ciphertext.subarray(5).map((byte) => byte ^ this.mask));
  }
}

test("stores only DPAPI-wrapped versioned keys in a mode 0600 keyring", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-keyring-"));
  const path = join(root, "config", "dpapi-keyring.json");
  const provider = new WindowsDpapiKeyProvider(
    path,
    new FakeDpapiAdapter(),
    () => "2026-07-31T00:00:00.000Z",
  );
  try {
    const initialized = await provider.initialize();
    const plaintextBase64 = initialized.keys.get(1)!.toString("base64");
    const stored = readFileSync(path, "utf8");

    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.doesNotMatch(stored, new RegExp(plaintextBase64, "u"));
    assert.match(stored, /windows-dpapi-current-user/u);
    destroyUnlockedKeys(initialized);

    const unlocked = await provider.unlock();
    assert.equal(unlocked.activeVersion, 1);
    assert.equal(unlocked.keys.get(1)?.length, 32);
    destroyUnlockedKeys(unlocked);

    const next = await provider.createKeyVersion();
    assert.equal(next.version, 2);
    next.key.fill(0);
    provider.activateKeyVersion(2);
    const rotated = await provider.unlock();
    assert.equal(rotated.activeVersion, 2);
    assert.deepEqual([...rotated.keys.keys()], [1, 2]);
    destroyUnlockedKeys(rotated);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed for an unconfigured or insecure keyring", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-keyring-"));
  const path = join(root, "dpapi-keyring.json");
  const provider = new WindowsDpapiKeyProvider(path, new FakeDpapiAdapter());
  try {
    await assert.rejects(
      provider.unlock(),
      (error: unknown) =>
        error instanceof VaultKeyProviderError && error.code === "vault_locked",
    );
    const keys = await provider.initialize();
    destroyUnlockedKeys(keys);
    chmodSync(path, 0o644);
    await assert.rejects(
      provider.unlock(),
      (error: unknown) =>
        error instanceof VaultKeyProviderError &&
        error.code === "invalid_keyring",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not create a replacement key over an existing vault database", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-keyring-"));
  const keyringPath = join(root, "dpapi-keyring.json");
  const databasePath = join(root, "vault.sqlite");
  const descriptor = openSync(databasePath, "wx", 0o600);
  closeSync(descriptor);
  const provider = new WindowsDpapiKeyProvider(
    keyringPath,
    new FakeDpapiAdapter(),
  );
  try {
    await assert.rejects(
      SecretVault.initialize(databasePath, provider),
      /existing vault database/u,
    );
    assert.equal(provider.isConfigured(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
