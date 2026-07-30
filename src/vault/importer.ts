import { lstatSync, readFileSync } from "node:fs";

import type { CredentialValue } from "./store.js";
import { KTX_CREDENTIAL_IDS, type CredentialName } from "./types.js";

const MAX_SOURCE_BYTES = 64 * 1024;
const SUPPORTED_NAMES = new Set<CredentialName>(
  KTX_CREDENTIAL_IDS.map((credential) => credential.name),
);

export class CredentialImportError extends Error {
  constructor(
    readonly code:
      | "duplicate_credential"
      | "insecure_source"
      | "invalid_source"
      | "missing_credential",
    message: string,
  ) {
    super(message);
    this.name = "CredentialImportError";
  }
}

function decodeQuotedValue(value: string): string {
  if (value.startsWith("'")) {
    if (!value.endsWith("'") || value.length < 2) {
      throw new CredentialImportError(
        "invalid_source",
        "Credential source contains an unterminated quote",
      );
    }
    return value.slice(1, -1);
  }
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) {
      throw new CredentialImportError(
        "invalid_source",
        "Credential source contains an unterminated quote",
      );
    }
    return value
      .slice(1, -1)
      .replace(/\\(["\\nrt])/gu, (_, escaped: string) => {
        const replacements: Record<string, string> = {
          '"': '"',
          "\\": "\\",
          n: "\n",
          r: "\r",
          t: "\t",
        };
        return replacements[escaped] ?? escaped;
      });
  }
  return value.trim();
}

export function parseKSkillCredentialSource(source: string): CredentialValue[] {
  const found = new Map<CredentialName, Buffer>();
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=(.*)$/u.exec(line);
    if (!match) {
      throw new CredentialImportError(
        "invalid_source",
        "Credential source contains an invalid assignment",
      );
    }
    const name = match[1]!;
    if (!SUPPORTED_NAMES.has(name as CredentialName)) {
      continue;
    }
    const typedName = name as CredentialName;
    if (found.has(typedName)) {
      throw new CredentialImportError(
        "duplicate_credential",
        "Credential source contains a duplicate supported name",
      );
    }
    const value = decodeQuotedValue(match[2]!.trim());
    if (!value) {
      throw new CredentialImportError(
        "missing_credential",
        "Credential source contains an empty required value",
      );
    }
    found.set(typedName, Buffer.from(value, "utf8"));
  }

  const result = KTX_CREDENTIAL_IDS.map((credential) => {
    const value = found.get(credential.name);
    if (!value) {
      throw new CredentialImportError(
        "missing_credential",
        "Credential source is missing a required KTX value",
      );
    }
    return { credential, value };
  });
  return result;
}

export function readKSkillCredentialFile(path: string): CredentialValue[] {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > MAX_SOURCE_BYTES
  ) {
    throw new CredentialImportError(
      "insecure_source",
      "Credential source must be a current-user-owned regular file with mode 0600 and a safe size",
    );
  }

  const source = readFileSync(path);
  try {
    return parseKSkillCredentialSource(source.toString("utf8"));
  } finally {
    source.fill(0);
  }
}

export function destroyCredentialValues(
  values: readonly CredentialValue[],
): void {
  for (const entry of values) {
    entry.value.fill(0);
  }
}
