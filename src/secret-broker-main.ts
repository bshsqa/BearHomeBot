import { resolveRuntimePaths } from "./runtime-paths.js";
import { SecretBrokerServer } from "./broker/server.js";
import { StateStore } from "./state/store.js";
import {
  WindowsDpapiKeyProvider,
  VaultKeyProviderError,
} from "./vault/key-provider.js";
import { ensureVaultDirectories, resolveVaultPaths } from "./vault/paths.js";
import { SecretVault } from "./vault/service.js";

async function main(): Promise<void> {
  const paths = resolveVaultPaths();
  const runtimePaths = resolveRuntimePaths();
  ensureVaultDirectories(paths);
  const provider = new WindowsDpapiKeyProvider(paths.dpapiKeyring);
  if (!provider.isConfigured()) {
    throw new VaultKeyProviderError(
      "vault_locked",
      "Vault is not configured; run the vault setup command first",
    );
  }

  const vault = await SecretVault.open(paths.database, provider);
  const state = new StateStore(runtimePaths.stateDatabase);
  const server = new SecretBrokerServer({
    socketPath: paths.brokerSocket,
    vault: vault.store,
    principalAllowed: (telegramUserId) =>
      state.findEnabledUser(telegramUserId) !== undefined,
  });
  await server.start();
  process.stdout.write(
    `BearHomeBot Secret Broker is listening on ${paths.brokerSocket}\n`,
  );

  const shutdown = async (): Promise<void> => {
    await server.stop();
    state.close();
    vault.close();
  };
  process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
  process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
}

void main().catch((error: unknown) => {
  const code =
    error instanceof VaultKeyProviderError ? error.code : "startup_failed";
  process.stderr.write(`Secret Broker failed to start (${code}).\n`);
  process.exitCode = 1;
});
