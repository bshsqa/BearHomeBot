import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ensureVaultDirectories,
  resolveVaultPaths,
} from "../src/vault/paths.js";

test("keeps vault data and wrapped keys outside normal BearHomeBot state", () => {
  const paths = resolveVaultPaths({
    homeDir: "/home/tester",
    env: {},
  });

  assert.equal(
    paths.database,
    "/home/tester/.local/share/bearhomebot-vault/vault.sqlite",
  );
  assert.equal(
    paths.dpapiKeyring,
    "/home/tester/.config/bearhomebot-vault/dpapi-keyring.json",
  );
  assert.equal(
    paths.brokerSocket,
    "/home/tester/.cache/bearhomebot/run/secret-broker.sock",
  );
  assert.doesNotMatch(paths.database, /\/bearhomebot\/state\.sqlite$/u);
});

test("requires absolute vault path overrides", () => {
  assert.throws(
    () =>
      resolveVaultPaths({
        homeDir: "/home/tester",
        env: { BEARHOMEBOT_VAULT_DATA_DIR: "relative" },
      }),
    /absolute path/u,
  );
});

test("rejects an existing broad directory instead of changing its mode", () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-vault-paths-"));
  chmodSync(root, 0o755);
  try {
    assert.throws(
      () =>
        ensureVaultDirectories({
          configDir: root,
          dataDir: join(root, "data"),
          runtimeDir: join(root, "run"),
          database: join(root, "data", "vault.sqlite"),
          dpapiKeyring: join(root, "dpapi-keyring.json"),
          brokerSocket: join(root, "run", "broker.sock"),
        }),
      /mode 0700/u,
    );
    assert.equal(statSync(root).mode & 0o777, 0o755);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
