import { existsSync } from "node:fs";

import { destroyUnlockedKeys, type VaultKeyProvider } from "./key-provider.js";
import { EncryptedVaultStore } from "./store.js";

export class SecretVault {
  private constructor(
    readonly store: EncryptedVaultStore,
    readonly keyProvider: VaultKeyProvider,
  ) {}

  static async open(
    databasePath: string,
    keyProvider: VaultKeyProvider,
  ): Promise<SecretVault> {
    const keys = await keyProvider.unlock();
    try {
      return new SecretVault(
        new EncryptedVaultStore(databasePath, keys),
        keyProvider,
      );
    } finally {
      destroyUnlockedKeys(keys);
    }
  }

  static async initialize(
    databasePath: string,
    keyProvider: VaultKeyProvider,
  ): Promise<SecretVault> {
    if (databasePath !== ":memory:" && existsSync(databasePath)) {
      throw new Error(
        "Refusing to initialize a new key over an existing vault database",
      );
    }
    const keys = await keyProvider.initialize();
    try {
      return new SecretVault(
        new EncryptedVaultStore(databasePath, keys),
        keyProvider,
      );
    } finally {
      destroyUnlockedKeys(keys);
    }
  }

  async rotateMasterKey(): Promise<number> {
    const next = await this.keyProvider.createKeyVersion();
    try {
      this.store.rotateEncryptionKey(next.version, next.key);
      this.keyProvider.activateKeyVersion(next.version);
      return next.version;
    } finally {
      next.key.fill(0);
    }
  }

  close(): void {
    this.store.close();
  }
}
