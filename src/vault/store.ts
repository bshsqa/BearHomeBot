import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  decryptSecret,
  encryptSecret,
  type EncryptedSecret,
} from "./crypto.js";
import type { UnlockedVaultKeys } from "./key-provider.js";
import {
  credentialKey,
  parseCredentialId,
  type CredentialId,
  type CredentialMetadata,
  type CredentialName,
  type TrustedPrincipal,
} from "./types.js";

const SCHEMA_VERSION = 1;
const MAX_SECRET_BYTES = 16 * 1024;

interface CredentialRow {
  telegram_user_id: string;
  scope: string;
  name: string;
  credential_version: number;
  key_version: number;
  algorithm: "aes-256-gcm";
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  auth_tag: Uint8Array;
  created_at: string;
  updated_at: string;
}

export interface CredentialValue {
  credential: CredentialId;
  value: Buffer;
}

export class VaultStoreError extends Error {
  constructor(
    readonly code:
      | "credential_not_found"
      | "invalid_secret"
      | "key_unavailable"
      | "vault_file_insecure",
    message: string,
  ) {
    super(message);
    this.name = "VaultStoreError";
  }
}

type Now = () => string;

function validateSecret(secret: Buffer): void {
  if (secret.length === 0 || secret.length > MAX_SECRET_BYTES) {
    throw new VaultStoreError(
      "invalid_secret",
      `Credential must contain 1-${MAX_SECRET_BYTES} bytes`,
    );
  }
  if (secret.includes(0)) {
    throw new VaultStoreError(
      "invalid_secret",
      "Credential must not contain NUL bytes",
    );
  }
}

function createSecureDatabaseFile(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  const parentStat = lstatSync(parent);
  if (
    !parentStat.isDirectory() ||
    parentStat.isSymbolicLink() ||
    parentStat.uid !== process.getuid?.() ||
    (parentStat.mode & 0o777) !== 0o700
  ) {
    throw new VaultStoreError(
      "vault_file_insecure",
      "Vault directory must be a current-user-owned directory with mode 0700",
    );
  }
  if (!existsSync(path)) {
    const descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(descriptor);
  }

  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600
  ) {
    throw new VaultStoreError(
      "vault_file_insecure",
      "Vault database must be a current-user-owned regular file with mode 0600",
    );
  }
}

function rowCredential(row: CredentialRow): CredentialId {
  return parseCredentialId({ scope: row.scope, name: row.name });
}

function rowMetadata(row: CredentialRow): CredentialMetadata {
  return {
    ...rowCredential(row),
    version: row.credential_version,
    keyVersion: row.key_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function encryptedFromRow(row: CredentialRow): EncryptedSecret {
  return {
    algorithm: row.algorithm,
    nonce: Buffer.from(row.nonce),
    ciphertext: Buffer.from(row.ciphertext),
    authTag: Buffer.from(row.auth_tag),
  };
}

export class EncryptedVaultStore {
  readonly #database: DatabaseSync;
  readonly #keys = new Map<number, Buffer>();
  readonly #now: Now;
  #activeKeyVersion: number;
  #closed = false;

  constructor(
    databasePath: string,
    unlocked: UnlockedVaultKeys,
    now: Now = () => new Date().toISOString(),
  ) {
    if (databasePath !== ":memory:") {
      createSecureDatabaseFile(databasePath);
    }
    for (const [version, key] of unlocked.keys) {
      if (!Number.isSafeInteger(version) || version < 1 || key.length !== 32) {
        throw new VaultStoreError(
          "key_unavailable",
          "Unlocked vault keyring is invalid",
        );
      }
      this.#keys.set(version, Buffer.from(key));
    }
    if (!this.#keys.has(unlocked.activeVersion)) {
      throw new VaultStoreError(
        "key_unavailable",
        "Active vault key is unavailable",
      );
    }
    this.#activeKeyVersion = unlocked.activeVersion;
    this.#now = now;
    this.#database = new DatabaseSync(databasePath);
    this.#database.exec("PRAGMA foreign_keys = ON");
    this.#database.exec("PRAGMA busy_timeout = 5000");
    this.#database.exec("PRAGMA secure_delete = ON");
    this.#database.exec("PRAGMA journal_mode = DELETE");
    this.#migrate();
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#database.close();
    for (const key of this.#keys.values()) {
      key.fill(0);
    }
    this.#keys.clear();
  }

  putCredential(
    principal: TrustedPrincipal,
    credential: CredentialId,
    value: Buffer,
  ): CredentialMetadata {
    return this.putCredentialBundle(principal, [{ credential, value }])[0]!;
  }

  putCredentialBundle(
    principal: TrustedPrincipal,
    values: readonly CredentialValue[],
  ): CredentialMetadata[] {
    if (values.length === 0) {
      throw new VaultStoreError(
        "invalid_secret",
        "Credential bundle must not be empty",
      );
    }
    const seen = new Set<string>();
    for (const entry of values) {
      parseCredentialId(entry.credential);
      validateSecret(entry.value);
      const key = credentialKey(entry.credential);
      if (seen.has(key)) {
        throw new VaultStoreError(
          "invalid_secret",
          "Credential bundle contains a duplicate identifier",
        );
      }
      seen.add(key);
    }

    const encryptionKey = this.#requireKey(this.#activeKeyVersion);
    const now = this.#now();
    return this.#transaction(() =>
      values.map((entry) => {
        const existing = this.#findRow(principal, entry.credential);
        const credentialVersion = (existing?.credential_version ?? 0) + 1;
        const createdAt = existing?.created_at ?? now;
        const encrypted = encryptSecret(encryptionKey, entry.value, {
          principal,
          credential: entry.credential,
          credentialVersion,
          keyVersion: this.#activeKeyVersion,
        });
        this.#database
          .prepare(
            `INSERT INTO credentials (
               telegram_user_id, scope, name, credential_version,
               key_version, algorithm, nonce, ciphertext, auth_tag,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(telegram_user_id, scope, name) DO UPDATE SET
               credential_version = excluded.credential_version,
               key_version = excluded.key_version,
               algorithm = excluded.algorithm,
               nonce = excluded.nonce,
               ciphertext = excluded.ciphertext,
               auth_tag = excluded.auth_tag,
               updated_at = excluded.updated_at`,
          )
          .run(
            principal.userId,
            entry.credential.scope,
            entry.credential.name,
            credentialVersion,
            this.#activeKeyVersion,
            encrypted.algorithm,
            encrypted.nonce,
            encrypted.ciphertext,
            encrypted.authTag,
            createdAt,
            now,
          );
        this.#recordAudit(
          principal,
          "credential.stored",
          entry.credential,
          credentialVersion,
        );
        return {
          ...entry.credential,
          version: credentialVersion,
          keyVersion: this.#activeKeyVersion,
          createdAt,
          updatedAt: now,
        };
      }),
    );
  }

  hasCredential(
    principal: TrustedPrincipal,
    credential: CredentialId,
  ): boolean {
    return this.#findRow(principal, credential) !== undefined;
  }

  listCredentials(principal: TrustedPrincipal): CredentialMetadata[] {
    const rows = this.#database
      .prepare(
        `SELECT telegram_user_id, scope, name, credential_version,
                key_version, algorithm, nonce, ciphertext, auth_tag,
                created_at, updated_at
         FROM credentials
         WHERE telegram_user_id = ?
         ORDER BY scope, name`,
      )
      .all(principal.userId) as unknown as CredentialRow[];
    return rows.map(rowMetadata);
  }

  async withCredentials<T>(
    principal: TrustedPrincipal,
    credentials: readonly CredentialId[],
    operation: (values: ReadonlyMap<CredentialName, Buffer>) => Promise<T> | T,
  ): Promise<T> {
    if (credentials.length === 0) {
      throw new VaultStoreError(
        "credential_not_found",
        "Credential request must not be empty",
      );
    }
    const plaintext = new Map<CredentialName, Buffer>();
    try {
      for (const credential of credentials) {
        const row = this.#findRow(principal, credential);
        if (!row) {
          throw new VaultStoreError(
            "credential_not_found",
            "Credential is not configured for this principal",
          );
        }
        const key = this.#requireKey(row.key_version);
        plaintext.set(
          credential.name,
          decryptSecret(key, encryptedFromRow(row), {
            principal,
            credential,
            credentialVersion: row.credential_version,
            keyVersion: row.key_version,
          }),
        );
      }
      this.#recordAudit(
        principal,
        "credential.used",
        credentials[0]!,
        undefined,
      );
      return await operation(plaintext);
    } finally {
      for (const value of plaintext.values()) {
        value.fill(0);
      }
      plaintext.clear();
    }
  }

  rotateEncryptionKey(version: number, key: Buffer): void {
    if (!Number.isSafeInteger(version) || version < 1 || key.length !== 32) {
      throw new VaultStoreError("key_unavailable", "New vault key is invalid");
    }
    if (this.#keys.has(version)) {
      throw new VaultStoreError(
        "key_unavailable",
        "New vault key version is already loaded",
      );
    }
    const newKey = Buffer.from(key);
    try {
      this.#transaction(() => {
        const rows = this.#database
          .prepare(
            `SELECT telegram_user_id, scope, name, credential_version,
                    key_version, algorithm, nonce, ciphertext, auth_tag,
                    created_at, updated_at
             FROM credentials`,
          )
          .all() as unknown as CredentialRow[];
        for (const row of rows) {
          const principal: TrustedPrincipal = {
            kind: "telegram",
            userId: row.telegram_user_id,
          };
          const credential = rowCredential(row);
          const oldKey = this.#requireKey(row.key_version);
          const plaintext = decryptSecret(oldKey, encryptedFromRow(row), {
            principal,
            credential,
            credentialVersion: row.credential_version,
            keyVersion: row.key_version,
          });
          try {
            const encrypted = encryptSecret(newKey, plaintext, {
              principal,
              credential,
              credentialVersion: row.credential_version,
              keyVersion: version,
            });
            this.#database
              .prepare(
                `UPDATE credentials
                 SET key_version = ?, algorithm = ?, nonce = ?,
                     ciphertext = ?, auth_tag = ?, updated_at = ?
                 WHERE telegram_user_id = ? AND scope = ? AND name = ?`,
              )
              .run(
                version,
                encrypted.algorithm,
                encrypted.nonce,
                encrypted.ciphertext,
                encrypted.authTag,
                this.#now(),
                row.telegram_user_id,
                row.scope,
                row.name,
              );
          } finally {
            plaintext.fill(0);
          }
        }
      });
      this.#keys.set(version, Buffer.from(newKey));
      this.#activeKeyVersion = version;
    } finally {
      newKey.fill(0);
    }
  }

  #findRow(
    principal: TrustedPrincipal,
    credential: CredentialId,
  ): CredentialRow | undefined {
    parseCredentialId(credential);
    return this.#database
      .prepare(
        `SELECT telegram_user_id, scope, name, credential_version,
                key_version, algorithm, nonce, ciphertext, auth_tag,
                created_at, updated_at
         FROM credentials
         WHERE telegram_user_id = ? AND scope = ? AND name = ?`,
      )
      .get(principal.userId, credential.scope, credential.name) as
      CredentialRow | undefined;
  }

  #requireKey(version: number): Buffer {
    const key = this.#keys.get(version);
    if (!key) {
      throw new VaultStoreError(
        "key_unavailable",
        "Credential key version is unavailable",
      );
    }
    return key;
  }

  #recordAudit(
    principal: TrustedPrincipal,
    eventType: string,
    credential: CredentialId,
    credentialVersion: number | undefined,
  ): void {
    this.#database
      .prepare(
        `INSERT INTO vault_audit_events (
           telegram_user_id, event_type, scope, name,
           credential_version, occurred_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        principal.userId,
        eventType,
        credential.scope,
        credential.name,
        credentialVersion ?? null,
        this.#now(),
      );
  }

  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  #migrate(): void {
    const version = (
      this.#database.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version;
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `Vault schema ${version} is newer than supported ${SCHEMA_VERSION}`,
      );
    }
    if (version < 1) {
      this.#transaction(() => {
        this.#database.exec(`
          CREATE TABLE credentials (
            telegram_user_id TEXT NOT NULL,
            scope TEXT NOT NULL,
            name TEXT NOT NULL,
            credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
            key_version INTEGER NOT NULL CHECK (key_version >= 1),
            algorithm TEXT NOT NULL CHECK (algorithm = 'aes-256-gcm'),
            nonce BLOB NOT NULL,
            ciphertext BLOB NOT NULL,
            auth_tag BLOB NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (telegram_user_id, scope, name)
          );

          CREATE TABLE vault_audit_events (
            id INTEGER PRIMARY KEY,
            telegram_user_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            scope TEXT NOT NULL,
            name TEXT NOT NULL,
            credential_version INTEGER,
            occurred_at TEXT NOT NULL
          );

          PRAGMA user_version = 1;
        `);
      });
    }
  }
}
