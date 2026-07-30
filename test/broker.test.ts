import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SecretBrokerServer } from "../src/broker/server.js";
import {
  parseBrokerRequest,
  type BrokerResponse,
} from "../src/broker/protocol.js";
import { generateMasterKey } from "../src/vault/crypto.js";
import type { UnlockedVaultKeys } from "../src/vault/key-provider.js";
import { EncryptedVaultStore } from "../src/vault/store.js";
import { KTX_CREDENTIAL_IDS, telegramPrincipal } from "../src/vault/types.js";

function request(socketPath: string, payload: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let output = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.end(`${JSON.stringify(payload)}\n`);
    });
    socket.on("data", (chunk: string) => {
      output += chunk;
    });
    socket.on("end", () => resolve(output));
    socket.on("error", reject);
  });
}

test("accepts only strict allowlisted broker operations", () => {
  const parsed = parseBrokerRequest({
    version: 1,
    requestId: "request-1",
    caller: "bearhomebot-control",
    principal: { kind: "telegram", userId: "1001" },
    operation: {
      type: "credentials.exists",
      credential: {
        scope: "ktx",
        name: "KSKILL_KTX_PASSWORD",
      },
    },
  });
  assert.equal(parsed.principal.userId, "1001");

  assert.throws(
    () =>
      parseBrokerRequest({
        version: 1,
        requestId: "request-2",
        caller: "bearhomebot-control",
        principal: { kind: "telegram", userId: "1001" },
        operation: { type: "credentials.read" },
      }),
    /not allowlisted/u,
  );
});

test("returns owner-scoped metadata over a mode 0600 Unix socket without values", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-broker-"));
  const socketPath = join(root, "run", "broker.sock");
  const masterKey = generateMasterKey();
  const keys: UnlockedVaultKeys = {
    provider: "test",
    activeVersion: 1,
    keys: new Map([[1, masterKey]]),
  };
  const vault = new EncryptedVaultStore(":memory:", keys);
  const owner = telegramPrincipal("1001");
  const secret = Buffer.from("broker-must-never-return-this");
  vault.putCredential(owner, KTX_CREDENTIAL_IDS[1]!, secret);
  const server = new SecretBrokerServer({
    socketPath,
    vault,
    principalAllowed: (userId) => userId === "1001" || userId === "1002",
  });
  try {
    await server.start();
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    const ownerOutput = await request(socketPath, {
      version: 1,
      requestId: "owner-list",
      caller: "bearhomebot-control",
      principal: { kind: "telegram", userId: "1001" },
      operation: { type: "credentials.list" },
    });
    assert.doesNotMatch(ownerOutput, /broker-must-never/u);
    const ownerResponse = JSON.parse(ownerOutput) as BrokerResponse;
    assert.equal(ownerResponse.ok, true);
    if (ownerResponse.ok) {
      assert.deepEqual(ownerResponse.result, {
        credentials: [
          {
            scope: "ktx",
            name: "KSKILL_KTX_PASSWORD",
            version: 1,
            keyVersion: 1,
            createdAt: (
              ownerResponse.result as {
                credentials: [{ createdAt: string }];
              }
            ).credentials[0].createdAt,
            updatedAt: (
              ownerResponse.result as {
                credentials: [{ updatedAt: string }];
              }
            ).credentials[0].updatedAt,
          },
        ],
      });
    }

    const otherOutput = await request(socketPath, {
      version: 1,
      requestId: "other-list",
      caller: "bearhomebot-control",
      principal: { kind: "telegram", userId: "1002" },
      operation: { type: "credentials.list" },
    });
    const otherResponse = JSON.parse(otherOutput) as BrokerResponse;
    assert.equal(otherResponse.ok, true);
    if (otherResponse.ok) {
      assert.deepEqual(otherResponse.result, { credentials: [] });
    }
  } finally {
    await server.stop();
    vault.close();
    masterKey.fill(0);
    secret.fill(0);
    rmSync(root, { recursive: true, force: true });
  }
});
