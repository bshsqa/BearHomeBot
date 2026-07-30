import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import type { CredentialId, TrustedPrincipal } from "./types.js";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export interface EncryptionContext {
  principal: TrustedPrincipal;
  credential: CredentialId;
  credentialVersion: number;
  keyVersion: number;
}

export interface EncryptedSecret {
  algorithm: typeof ALGORITHM;
  nonce: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export class VaultCryptoError extends Error {
  constructor(
    readonly code: "authentication_failed" | "invalid_encryption_input",
    message: string,
  ) {
    super(message);
    this.name = "VaultCryptoError";
  }
}

function validateKey(key: Buffer): void {
  if (key.length !== KEY_BYTES) {
    throw new VaultCryptoError(
      "invalid_encryption_input",
      "Vault key must contain exactly 32 bytes",
    );
  }
}

function validatePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VaultCryptoError(
      "invalid_encryption_input",
      `${label} must be a positive integer`,
    );
  }
}

function additionalAuthenticatedData(context: EncryptionContext): Buffer {
  validatePositiveInteger(context.credentialVersion, "Credential version");
  validatePositiveInteger(context.keyVersion, "Key version");

  return Buffer.from(
    JSON.stringify({
      schema: "bearhomebot-vault-secret-v1",
      principalKind: context.principal.kind,
      principalId: context.principal.userId,
      scope: context.credential.scope,
      name: context.credential.name,
      credentialVersion: context.credentialVersion,
      keyVersion: context.keyVersion,
    }),
    "utf8",
  );
}

export function generateMasterKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

export function encryptSecret(
  key: Buffer,
  plaintext: Buffer,
  context: EncryptionContext,
): EncryptedSecret {
  validateKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(additionalAuthenticatedData(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  return {
    algorithm: ALGORITHM,
    nonce,
    ciphertext,
    authTag: cipher.getAuthTag(),
  };
}

export function decryptSecret(
  key: Buffer,
  encrypted: EncryptedSecret,
  context: EncryptionContext,
): Buffer {
  validateKey(key);
  if (
    encrypted.algorithm !== ALGORITHM ||
    encrypted.nonce.length !== NONCE_BYTES ||
    encrypted.authTag.length !== TAG_BYTES
  ) {
    throw new VaultCryptoError(
      "invalid_encryption_input",
      "Encrypted credential has invalid parameters",
    );
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key, encrypted.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(additionalAuthenticatedData(context));
    decipher.setAuthTag(encrypted.authTag);
    return Buffer.concat([
      decipher.update(encrypted.ciphertext),
      decipher.final(),
    ]);
  } catch {
    throw new VaultCryptoError(
      "authentication_failed",
      "Encrypted credential authentication failed",
    );
  }
}

export function buffersEqual(left: Buffer, right: Buffer): boolean {
  return left.length === right.length && timingSafeEqual(left, right);
}
