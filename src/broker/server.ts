import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname } from "node:path";

import {
  brokerFailure,
  parseBrokerRequest,
  type BrokerRequest,
  type BrokerResponse,
} from "./protocol.js";
import type { EncryptedVaultStore } from "../vault/store.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MILLISECONDS = 5_000;

export interface SecretBrokerOptions {
  socketPath: string;
  vault: EncryptedVaultStore;
  principalAllowed: (telegramUserId: string) => boolean;
}

function safeUnlinkSocket(path: string): void {
  if (!existsSync(path)) {
    return;
  }
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid?.()) {
    throw new Error(
      "Secret Broker socket path exists and is not a current-user-owned socket",
    );
  }
  unlinkSync(path);
}

function responseLine(response: BrokerResponse): string {
  return `${JSON.stringify(response)}\n`;
}

export class SecretBrokerServer {
  readonly #options: SecretBrokerOptions;
  #server: Server | undefined;

  constructor(options: SecretBrokerOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    if (this.#server) {
      throw new Error("Secret Broker is already running");
    }
    const parent = dirname(this.#options.socketPath);
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
      throw new Error(
        "Secret Broker socket directory must be current-user-owned with mode 0700",
      );
    }
    safeUnlinkSocket(this.#options.socketPath);

    const server = createServer((socket) => this.#handleSocket(socket));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        server.off("listening", onListening);
        this.#server = undefined;
        reject(error);
      };
      const onListening = (): void => {
        server.off("error", onError);
        chmodSync(this.#options.socketPath, 0o600);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.#options.socketPath);
    });
  }

  async stop(): Promise<void> {
    const server = this.#server;
    if (!server) {
      return;
    }
    this.#server = undefined;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    safeUnlinkSocket(this.#options.socketPath);
  }

  #handleSocket(socket: Socket): void {
    let input = Buffer.alloc(0);
    let finished = false;
    const timer = setTimeout(() => {
      socket.destroy();
    }, REQUEST_TIMEOUT_MILLISECONDS);
    timer.unref();

    const finish = (response: BrokerResponse): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      socket.end(responseLine(response));
    };

    socket.on("data", (chunk: Buffer) => {
      if (finished) {
        return;
      }
      input = Buffer.concat([input, chunk]);
      if (input.length > MAX_REQUEST_BYTES) {
        finish(
          brokerFailure(
            "unknown",
            "invalid_request",
            "Broker request is too large",
          ),
        );
        return;
      }
      const newline = input.indexOf(0x0a);
      if (newline < 0) {
        return;
      }
      const line = input.subarray(0, newline).toString("utf8");
      input.fill(0);
      void this.#dispatch(line).then(finish);
    });
    socket.on("error", () => {
      clearTimeout(timer);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      input.fill(0);
    });
  }

  async #dispatch(line: string): Promise<BrokerResponse> {
    let request: BrokerRequest;
    try {
      request = parseBrokerRequest(JSON.parse(line) as unknown);
    } catch {
      return brokerFailure(
        "unknown",
        "invalid_request",
        "Broker request was rejected",
      );
    }
    if (!this.#options.principalAllowed(request.principal.userId)) {
      return brokerFailure(
        request.requestId,
        "principal_denied",
        "Principal is not allowed",
      );
    }

    try {
      switch (request.operation.type) {
        case "credentials.list":
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            result: {
              credentials: this.#options.vault.listCredentials(
                request.principal,
              ),
            },
          };
        case "credentials.exists":
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            result: {
              exists: this.#options.vault.hasCredential(
                request.principal,
                request.operation.credential,
              ),
            },
          };
      }
    } catch {
      return brokerFailure(
        request.requestId,
        "vault_unavailable",
        "Credential metadata is unavailable",
      );
    }
  }
}
