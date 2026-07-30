import {
  parseCredentialId,
  telegramPrincipal,
  type CredentialId,
  type TrustedPrincipal,
} from "../vault/types.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export type BrokerOperation =
  | { type: "credentials.list" }
  | { type: "credentials.exists"; credential: CredentialId };

export interface BrokerRequest {
  version: 1;
  requestId: string;
  caller: "bearhomebot-control";
  principal: TrustedPrincipal;
  operation: BrokerOperation;
}

export interface BrokerSuccessResponse {
  version: 1;
  requestId: string;
  ok: true;
  result: unknown;
}

export interface BrokerFailureResponse {
  version: 1;
  requestId: string;
  ok: false;
  error: {
    code: "invalid_request" | "principal_denied" | "vault_unavailable";
    message: string;
  };
}

export type BrokerResponse = BrokerSuccessResponse | BrokerFailureResponse;

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function parseOperation(value: unknown): BrokerOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Broker operation must be an object");
  }
  const operation = value as Record<string, unknown>;
  if (operation.type === "credentials.list" && exactKeys(operation, ["type"])) {
    return { type: "credentials.list" };
  }
  if (
    operation.type === "credentials.exists" &&
    exactKeys(operation, ["type", "credential"])
  ) {
    return {
      type: "credentials.exists",
      credential: parseCredentialId(operation.credential, "Broker credential"),
    };
  }
  throw new Error("Broker operation is not allowlisted");
}

export function parseBrokerRequest(value: unknown): BrokerRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Broker request must be an object");
  }
  const request = value as Record<string, unknown>;
  if (
    !exactKeys(request, [
      "version",
      "requestId",
      "caller",
      "principal",
      "operation",
    ]) ||
    request.version !== 1 ||
    typeof request.requestId !== "string" ||
    !REQUEST_ID_PATTERN.test(request.requestId) ||
    request.caller !== "bearhomebot-control" ||
    typeof request.principal !== "object" ||
    request.principal === null ||
    Array.isArray(request.principal)
  ) {
    throw new Error("Broker request envelope is invalid");
  }
  const principal = request.principal as Record<string, unknown>;
  if (
    !exactKeys(principal, ["kind", "userId"]) ||
    principal.kind !== "telegram" ||
    typeof principal.userId !== "string"
  ) {
    throw new Error("Broker principal is invalid");
  }

  return {
    version: 1,
    requestId: request.requestId,
    caller: "bearhomebot-control",
    principal: telegramPrincipal(principal.userId),
    operation: parseOperation(request.operation),
  };
}

export function brokerFailure(
  requestId: string,
  code: BrokerFailureResponse["error"]["code"],
  message: string,
): BrokerFailureResponse {
  return {
    version: 1,
    requestId,
    ok: false,
    error: { code, message },
  };
}
