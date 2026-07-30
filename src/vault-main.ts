import { readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveRuntimePaths } from "./runtime-paths.js";
import { StateStore } from "./state/store.js";
import {
  destroyCredentialValues,
  readKSkillCredentialFile,
} from "./vault/importer.js";
import {
  WindowsDpapiKeyProvider,
  VaultKeyProviderError,
} from "./vault/key-provider.js";
import { ensureVaultDirectories, resolveVaultPaths } from "./vault/paths.js";
import { SecretVault } from "./vault/service.js";
import type { CredentialValue } from "./vault/store.js";
import { KTX_CREDENTIAL_IDS, telegramPrincipal } from "./vault/types.js";

function usage(): never {
  process.stderr.write(
    [
      "Usage:",
      "  vault setup-dpapi",
      "  vault status",
      "  vault list <telegram-user-id>",
      "  vault set-ktx <telegram-user-id>       # two base64 lines on stdin",
      "  vault import-k-skill <telegram-user-id> [source-file]",
      "  vault rotate-key",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function requireEnabledUser(telegramUserId: string): void {
  const paths = resolveRuntimePaths();
  const state = new StateStore(paths.stateDatabase);
  try {
    if (!state.findEnabledUser(telegramUserId)) {
      throw new Error("Telegram user is not enabled in BearHomeBot");
    }
  } finally {
    state.close();
  }
}

function decodeInputLine(line: string): Buffer {
  if (
    !line ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(line) ||
    line.length > 32 * 1024
  ) {
    throw new Error("Credential input is invalid");
  }
  const decoded = Buffer.from(line, "base64");
  if (decoded.length === 0 || decoded.toString("base64") !== line) {
    decoded.fill(0);
    throw new Error("Credential input is invalid");
  }
  return decoded;
}

async function setKtxCredentials(
  vault: SecretVault,
  telegramUserId: string,
): Promise<void> {
  const input = readFileSync(0);
  let values: CredentialValue[] | undefined;
  try {
    if (input.length > 64 * 1024) {
      throw new Error("Credential input is too large");
    }
    const lines = input.toString("ascii").split(/\r?\n/u);
    if (lines.length < 2) {
      throw new Error("Two credential values are required");
    }
    values = [
      {
        credential: KTX_CREDENTIAL_IDS[0]!,
        value: decodeInputLine(lines[0]!),
      },
      {
        credential: KTX_CREDENTIAL_IDS[1]!,
        value: decodeInputLine(lines[1]!),
      },
    ];
    vault.store.putCredentialBundle(telegramPrincipal(telegramUserId), values);
  } finally {
    input.fill(0);
    if (values) {
      destroyCredentialValues(values);
    }
  }
}

async function main(): Promise<void> {
  const [command, telegramUserId, optionalPath, ...extra] =
    process.argv.slice(2);
  if (!command || extra.length > 0) {
    usage();
  }
  const paths = resolveVaultPaths();
  ensureVaultDirectories(paths);
  const provider = new WindowsDpapiKeyProvider(paths.dpapiKeyring);

  if (command === "setup-dpapi") {
    if (telegramUserId !== undefined || optionalPath !== undefined) {
      usage();
    }
    if (provider.isConfigured()) {
      throw new VaultKeyProviderError(
        "already_configured",
        "Vault key provider is already configured",
      );
    }
    const vault = await SecretVault.initialize(paths.database, provider);
    vault.close();
    process.stdout.write(
      "Vault initialized with Windows DPAPI CurrentUser protection.\n",
    );
    return;
  }

  if (command === "status") {
    if (telegramUserId !== undefined || optionalPath !== undefined) {
      usage();
    }
    if (!provider.isConfigured()) {
      process.stdout.write("Vault status: locked (provider not configured)\n");
      return;
    }
    const vault = await SecretVault.open(paths.database, provider);
    vault.close();
    process.stdout.write(
      "Vault status: unlocked; provider=windows-dpapi-current-user\n",
    );
    return;
  }

  if (!provider.isConfigured()) {
    throw new VaultKeyProviderError(
      "vault_locked",
      "Vault key provider is not configured",
    );
  }
  const vault = await SecretVault.open(paths.database, provider);
  try {
    if (command === "rotate-key") {
      if (telegramUserId !== undefined || optionalPath !== undefined) {
        usage();
      }
      const version = await vault.rotateMasterKey();
      process.stdout.write(`Vault master key rotated to version ${version}.\n`);
      return;
    }
    if (!telegramUserId) {
      usage();
    }
    const principal = telegramPrincipal(telegramUserId);
    requireEnabledUser(telegramUserId);

    if (command === "list") {
      if (optionalPath !== undefined) {
        usage();
      }
      const credentials = vault.store.listCredentials(principal);
      if (credentials.length === 0) {
        process.stdout.write("No credentials are configured for this user.\n");
      } else {
        for (const credential of credentials) {
          process.stdout.write(
            `${credential.scope}/${credential.name} version=${credential.version} key=${credential.keyVersion}\n`,
          );
        }
      }
      return;
    }
    if (command === "set-ktx") {
      if (optionalPath !== undefined) {
        usage();
      }
      await setKtxCredentials(vault, telegramUserId);
      process.stdout.write(
        "KTX credentials were encrypted and stored for the selected user.\n",
      );
      return;
    }
    if (command === "import-k-skill") {
      const sourcePath =
        optionalPath ??
        join(process.env.HOME ?? "", ".config", "k-skill", "secrets.env");
      const values = readKSkillCredentialFile(sourcePath);
      try {
        vault.store.putCredentialBundle(principal, values);
      } finally {
        destroyCredentialValues(values);
      }
      process.stdout.write(
        "KTX credentials were imported; the source file was not deleted.\n",
      );
      return;
    }
    usage();
  } finally {
    vault.close();
  }
}

void main().catch((error: unknown) => {
  const code =
    error instanceof VaultKeyProviderError ? error.code : "command_failed";
  process.stderr.write(`Vault command failed (${code}).\n`);
  process.exitCode = 1;
});
