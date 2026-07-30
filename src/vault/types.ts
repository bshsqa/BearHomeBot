const TELEGRAM_USER_ID_PATTERN = /^[1-9][0-9]{0,19}$/u;

export const CREDENTIAL_SCOPES = ["ktx"] as const;
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];

export const CREDENTIAL_NAMES = [
  "KSKILL_KTX_ID",
  "KSKILL_KTX_PASSWORD",
] as const;
export type CredentialName = (typeof CREDENTIAL_NAMES)[number];

export interface TrustedPrincipal {
  kind: "telegram";
  userId: string;
}

export interface CredentialId {
  scope: CredentialScope;
  name: CredentialName;
}

export interface CredentialMetadata extends CredentialId {
  version: number;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
}

export const KTX_CREDENTIAL_IDS: readonly CredentialId[] = [
  { scope: "ktx", name: "KSKILL_KTX_ID" },
  { scope: "ktx", name: "KSKILL_KTX_PASSWORD" },
];

export function telegramPrincipal(userId: string): TrustedPrincipal {
  if (!TELEGRAM_USER_ID_PATTERN.test(userId)) {
    throw new Error("Telegram principal has an invalid numeric user ID");
  }
  return { kind: "telegram", userId };
}

export function parseCredentialId(
  value: unknown,
  label = "credential",
): CredentialId {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== 2 ||
    keys[0] !== "name" ||
    keys[1] !== "scope" ||
    !CREDENTIAL_SCOPES.includes(record.scope as CredentialScope) ||
    !CREDENTIAL_NAMES.includes(record.name as CredentialName)
  ) {
    throw new Error(`${label} has an unsupported scope or name`);
  }

  const credential = {
    scope: record.scope as CredentialScope,
    name: record.name as CredentialName,
  };
  if (
    credential.scope === "ktx" &&
    !credential.name.startsWith("KSKILL_KTX_")
  ) {
    throw new Error(`${label} scope and name do not match`);
  }
  return credential;
}

export function credentialKey(credential: CredentialId): string {
  return `${credential.scope}:${credential.name}`;
}
