import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { generateMasterKey } from "./crypto.js";

const KEYRING_SCHEMA_VERSION = 1;
const PROVIDER_ID = "windows-dpapi-current-user";
const MAX_DPAPI_OUTPUT_BYTES = 64 * 1024;
const DPAPI_TIMEOUT_MILLISECONDS = 15_000;
const DPAPI_ENTROPY = "BearHomeBot vault master key v1";

interface StoredWrappedKey {
  version: number;
  wrappedKey: string;
  createdAt: string;
}

interface StoredKeyring {
  schemaVersion: 1;
  provider: typeof PROVIDER_ID;
  activeKeyVersion: number;
  keys: StoredWrappedKey[];
}

export interface VaultKey {
  version: number;
  key: Buffer;
}

export interface UnlockedVaultKeys {
  provider: string;
  activeVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

export interface VaultKeyProvider {
  readonly providerId: string;
  isConfigured(): boolean;
  initialize(): Promise<UnlockedVaultKeys>;
  unlock(): Promise<UnlockedVaultKeys>;
  createKeyVersion(): Promise<VaultKey>;
  activateKeyVersion(version: number): void;
}

export interface DpapiAdapter {
  protect(plaintext: Buffer): Promise<Buffer>;
  unprotect(ciphertext: Buffer): Promise<Buffer>;
}

export class VaultKeyProviderError extends Error {
  constructor(
    readonly code:
      | "already_configured"
      | "invalid_keyring"
      | "provider_unavailable"
      | "vault_locked",
    message: string,
  ) {
    super(message);
    this.name = "VaultKeyProviderError";
  }
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

function dpapiPowerShellScript(operation: "protect" | "unprotect"): string {
  const method = operation === "protect" ? "Protect" : "Unprotect";
  return [
    "$ErrorActionPreference = 'Stop'",
    "Add-Type -AssemblyName System.Security",
    "$inputText = [Console]::In.ReadToEnd().Trim()",
    "$inputBytes = [Convert]::FromBase64String($inputText)",
    `$entropy = [Text.Encoding]::UTF8.GetBytes('${DPAPI_ENTROPY}')`,
    "$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser",
    `$outputBytes = [System.Security.Cryptography.ProtectedData]::${method}($inputBytes, $entropy, $scope)`,
    "[Console]::Out.Write([Convert]::ToBase64String($outputBytes))",
    "[Array]::Clear($inputBytes, 0, $inputBytes.Length)",
    "[Array]::Clear($outputBytes, 0, $outputBytes.Length)",
  ].join("; ");
}

async function runDpapiPowerShell(
  operation: "protect" | "unprotect",
  input: Buffer,
  executable = "powershell.exe",
): Promise<Buffer> {
  return await new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        encodedPowerShell(dpapiPowerShellScript(operation)),
      ],
      {
        env: {
          PATH: process.env.PATH,
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    const stdout: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    const finish = (
      error: VaultKeyProviderError | undefined,
      value?: Buffer,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve(value ?? Buffer.alloc(0));
      }
    };

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new VaultKeyProviderError(
          "provider_unavailable",
          "Windows DPAPI operation timed out",
        ),
      );
    }, DPAPI_TIMEOUT_MILLISECONDS);
    timeout.unref();

    child.on("error", () => {
      finish(
        new VaultKeyProviderError(
          "provider_unavailable",
          "Windows PowerShell is unavailable for DPAPI",
        ),
      );
    });
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_DPAPI_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(
          new VaultKeyProviderError(
            "provider_unavailable",
            "Windows DPAPI returned too much output",
          ),
        );
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.resume();
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        finish(
          new VaultKeyProviderError(
            operation === "unprotect" ? "vault_locked" : "provider_unavailable",
            "Windows DPAPI operation failed",
          ),
        );
        return;
      }

      try {
        const output = Buffer.from(
          Buffer.concat(stdout).toString("ascii").trim(),
          "base64",
        );
        if (output.length === 0) {
          throw new Error("empty DPAPI output");
        }
        finish(undefined, output);
      } catch {
        finish(
          new VaultKeyProviderError(
            "provider_unavailable",
            "Windows DPAPI returned invalid output",
          ),
        );
      }
    });

    child.stdin.end(input.toString("base64"));
  });
}

export class WindowsDpapiAdapter implements DpapiAdapter {
  constructor(readonly executable = "powershell.exe") {}

  protect(plaintext: Buffer): Promise<Buffer> {
    return runDpapiPowerShell("protect", plaintext, this.executable);
  }

  unprotect(ciphertext: Buffer): Promise<Buffer> {
    return runDpapiPowerShell("unprotect", ciphertext, this.executable);
  }
}

function validateKeyring(value: unknown): StoredKeyring {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VaultKeyProviderError(
      "invalid_keyring",
      "Vault keyring is invalid",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== KEYRING_SCHEMA_VERSION ||
    record.provider !== PROVIDER_ID ||
    !Number.isSafeInteger(record.activeKeyVersion) ||
    (record.activeKeyVersion as number) < 1 ||
    !Array.isArray(record.keys) ||
    record.keys.length === 0 ||
    record.keys.length > 64
  ) {
    throw new VaultKeyProviderError(
      "invalid_keyring",
      "Vault keyring metadata is invalid",
    );
  }

  const versions = new Set<number>();
  const keys: StoredWrappedKey[] = record.keys.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new VaultKeyProviderError(
        "invalid_keyring",
        "Vault keyring entry is invalid",
      );
    }
    const item = entry as Record<string, unknown>;
    if (
      !Number.isSafeInteger(item.version) ||
      (item.version as number) < 1 ||
      typeof item.wrappedKey !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(item.wrappedKey) ||
      item.wrappedKey.length > 16 * 1024 ||
      Buffer.from(item.wrappedKey, "base64").toString("base64") !==
        item.wrappedKey ||
      typeof item.createdAt !== "string" ||
      !Number.isFinite(Date.parse(item.createdAt))
    ) {
      throw new VaultKeyProviderError(
        "invalid_keyring",
        "Vault keyring entry metadata is invalid",
      );
    }
    const version = item.version as number;
    if (versions.has(version)) {
      throw new VaultKeyProviderError(
        "invalid_keyring",
        "Vault keyring contains duplicate versions",
      );
    }
    versions.add(version);
    return {
      version,
      wrappedKey: item.wrappedKey,
      createdAt: item.createdAt,
    };
  });

  const activeKeyVersion = record.activeKeyVersion as number;
  if (!versions.has(activeKeyVersion)) {
    throw new VaultKeyProviderError(
      "invalid_keyring",
      "Vault keyring active version does not exist",
    );
  }
  return {
    schemaVersion: 1,
    provider: PROVIDER_ID,
    activeKeyVersion,
    keys: keys.sort((left, right) => left.version - right.version),
  };
}

function assertSecureRegularFile(path: string): void {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    stat.size > 256 * 1024
  ) {
    throw new VaultKeyProviderError(
      "invalid_keyring",
      "Vault keyring must be a current-user-owned regular file with mode 0600",
    );
  }
}

function createParentDirectory(path: string): void {
  const parent = dirname(path);
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  }
  const stat = lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  ) {
    throw new VaultKeyProviderError(
      "invalid_keyring",
      "Vault keyring directory must be current-user-owned with mode 0700",
    );
  }
}

export class WindowsDpapiKeyProvider implements VaultKeyProvider {
  readonly providerId = PROVIDER_ID;

  constructor(
    readonly keyringPath: string,
    readonly adapter: DpapiAdapter = new WindowsDpapiAdapter(),
    readonly now: () => string = () => new Date().toISOString(),
  ) {}

  isConfigured(): boolean {
    return existsSync(this.keyringPath);
  }

  async initialize(): Promise<UnlockedVaultKeys> {
    if (this.isConfigured()) {
      throw new VaultKeyProviderError(
        "already_configured",
        "Vault key provider is already configured",
      );
    }

    createParentDirectory(this.keyringPath);
    const key = generateMasterKey();
    try {
      const wrapped = await this.adapter.protect(key);
      this.#writeKeyring(
        {
          schemaVersion: 1,
          provider: PROVIDER_ID,
          activeKeyVersion: 1,
          keys: [
            {
              version: 1,
              wrappedKey: wrapped.toString("base64"),
              createdAt: this.now(),
            },
          ],
        },
        true,
      );
      return {
        provider: PROVIDER_ID,
        activeVersion: 1,
        keys: new Map([[1, Buffer.from(key)]]),
      };
    } finally {
      key.fill(0);
    }
  }

  async unlock(): Promise<UnlockedVaultKeys> {
    const keyring = this.#readKeyring();
    const keys = new Map<number, Buffer>();
    try {
      for (const stored of keyring.keys) {
        const wrapped = Buffer.from(stored.wrappedKey, "base64");
        const key = await this.adapter.unprotect(wrapped);
        if (key.length !== 32) {
          key.fill(0);
          throw new VaultKeyProviderError(
            "vault_locked",
            "DPAPI returned an invalid vault key",
          );
        }
        keys.set(stored.version, key);
      }
      return {
        provider: PROVIDER_ID,
        activeVersion: keyring.activeKeyVersion,
        keys,
      };
    } catch (error) {
      for (const key of keys.values()) {
        key.fill(0);
      }
      if (error instanceof VaultKeyProviderError) {
        throw error;
      }
      throw new VaultKeyProviderError(
        "vault_locked",
        "Vault key could not be unlocked",
      );
    }
  }

  async createKeyVersion(): Promise<VaultKey> {
    const keyring = this.#readKeyring();
    const version = Math.max(...keyring.keys.map((entry) => entry.version)) + 1;
    const key = generateMasterKey();
    try {
      const wrapped = await this.adapter.protect(key);
      keyring.keys.push({
        version,
        wrappedKey: wrapped.toString("base64"),
        createdAt: this.now(),
      });
      this.#writeKeyring(keyring);
      return { version, key: Buffer.from(key) };
    } finally {
      key.fill(0);
    }
  }

  activateKeyVersion(version: number): void {
    const keyring = this.#readKeyring();
    if (!keyring.keys.some((entry) => entry.version === version)) {
      throw new VaultKeyProviderError(
        "invalid_keyring",
        "Vault key version does not exist",
      );
    }
    keyring.activeKeyVersion = version;
    this.#writeKeyring(keyring);
  }

  #readKeyring(): StoredKeyring {
    if (!this.isConfigured()) {
      throw new VaultKeyProviderError(
        "vault_locked",
        "Vault key provider is not configured",
      );
    }
    assertSecureRegularFile(this.keyringPath);
    try {
      return validateKeyring(
        JSON.parse(readFileSync(this.keyringPath, "utf8")) as unknown,
      );
    } catch (error) {
      if (error instanceof VaultKeyProviderError) {
        throw error;
      }
      throw new VaultKeyProviderError(
        "invalid_keyring",
        "Vault keyring could not be read",
      );
    }
  }

  #writeKeyring(keyring: StoredKeyring, exclusive = false): void {
    createParentDirectory(this.keyringPath);
    const temporaryPath = `${this.keyringPath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    let descriptor: number | undefined;
    try {
      descriptor = openSync(
        temporaryPath,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(
        descriptor,
        `${JSON.stringify(validateKeyring(keyring), null, 2)}\n`,
        "utf8",
      );
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      chmodSync(temporaryPath, 0o600);
      if (exclusive && existsSync(this.keyringPath)) {
        throw new VaultKeyProviderError(
          "already_configured",
          "Vault key provider is already configured",
        );
      }
      renameSync(temporaryPath, this.keyringPath);
      assertSecureRegularFile(this.keyringPath);
    } finally {
      if (descriptor !== undefined) {
        closeSync(descriptor);
      }
      if (existsSync(temporaryPath)) {
        unlinkSync(temporaryPath);
      }
    }
  }
}

export function destroyUnlockedKeys(keys: UnlockedVaultKeys): void {
  for (const key of keys.keys.values()) {
    key.fill(0);
  }
}
