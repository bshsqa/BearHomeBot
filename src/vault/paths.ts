import { existsSync, lstatSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface VaultPaths {
  configDir: string;
  dataDir: string;
  runtimeDir: string;
  database: string;
  dpapiKeyring: string;
  brokerSocket: string;
}

export interface VaultPathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }
  return resolve(value);
}

function configuredDirectory(
  env: NodeJS.ProcessEnv,
  overrideName: string,
  xdgName: string,
  fallback: string,
  suffix: string,
): string {
  const override = env[overrideName];
  if (override) {
    return absolutePath(override, overrideName);
  }
  const xdg = env[xdgName];
  if (xdg) {
    return join(absolutePath(xdg, xdgName), suffix);
  }
  return fallback;
}

export function resolveVaultPaths(options: VaultPathOptions = {}): VaultPaths {
  const env = options.env ?? process.env;
  const home = absolutePath(options.homeDir ?? homedir(), "homeDir");
  const configDir = configuredDirectory(
    env,
    "BEARHOMEBOT_VAULT_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    join(home, ".config", "bearhomebot-vault"),
    "bearhomebot-vault",
  );
  const dataDir = configuredDirectory(
    env,
    "BEARHOMEBOT_VAULT_DATA_DIR",
    "XDG_DATA_HOME",
    join(home, ".local", "share", "bearhomebot-vault"),
    "bearhomebot-vault",
  );
  const runtimeDir = configuredDirectory(
    env,
    "BEARHOMEBOT_RUNTIME_DIR",
    "XDG_RUNTIME_DIR",
    join(home, ".cache", "bearhomebot", "run"),
    "bearhomebot",
  );
  const configuredSocket = env.BEARHOMEBOT_SECRET_BROKER_SOCKET;

  return {
    configDir,
    dataDir,
    runtimeDir,
    database: join(dataDir, "vault.sqlite"),
    dpapiKeyring: join(configDir, "dpapi-keyring.json"),
    brokerSocket: configuredSocket
      ? absolutePath(configuredSocket, "BEARHOMEBOT_SECRET_BROKER_SOCKET")
      : join(runtimeDir, "secret-broker.sock"),
  };
}

export function ensureVaultDirectories(paths: VaultPaths): void {
  for (const directory of [paths.configDir, paths.dataDir, paths.runtimeDir]) {
    if (!existsSync(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    const stat = lstatSync(directory);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    ) {
      throw new Error(
        "Vault directories must be current-user-owned directories with mode 0700",
      );
    }
  }
}
