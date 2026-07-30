import type {
  TelegramUpdate,
  TelegramUser,
  TelegramWebhookInfo,
} from "./types.js";

type FetchImplementation = typeof fetch;

interface TelegramEnvelope {
  ok: boolean;
  result?: unknown;
  description?: string;
}

function isEnvelope(value: unknown): value is TelegramEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

export class TelegramApiError extends Error {
  constructor(method: string, description: string) {
    super(`Telegram ${method} failed: ${description}`);
    this.name = "TelegramApiError";
  }
}

export class TelegramClient {
  readonly #token: string;
  readonly #fetch: FetchImplementation;

  constructor(token: string, fetchImplementation: FetchImplementation = fetch) {
    this.#token = token;
    this.#fetch = fetchImplementation;
  }

  async #request<T>(
    method: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const init: RequestInit = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    };
    if (signal) {
      init.signal = signal;
    }

    let response: Response;
    try {
      response = await this.#fetch(
        `https://api.telegram.org/bot${this.#token}/${method}`,
        init,
      );
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      throw new TelegramApiError(method, "network request failed");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new TelegramApiError(
        method,
        `HTTP ${response.status} returned invalid JSON`,
      );
    }

    if (!isEnvelope(body)) {
      throw new TelegramApiError(method, "response shape was invalid");
    }
    if (!response.ok || !body.ok) {
      throw new TelegramApiError(
        method,
        body.description ?? `HTTP ${response.status}`,
      );
    }

    return body.result as T;
  }

  getMe(signal?: AbortSignal): Promise<TelegramUser> {
    return this.#request("getMe", {}, signal);
  }

  getWebhookInfo(signal?: AbortSignal): Promise<TelegramWebhookInfo> {
    return this.#request("getWebhookInfo", {}, signal);
  }

  getUpdates(
    offset: number | undefined,
    timeoutSeconds: number,
    signal?: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    const payload: Record<string, unknown> = {
      timeout: timeoutSeconds,
      limit: 100,
      allowed_updates: ["message"],
    };
    if (offset !== undefined) {
      payload.offset = offset;
    }

    return this.#request("getUpdates", payload, signal);
  }

  async sendMessage(
    chatId: number,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#request(
      "sendMessage",
      {
        chat_id: chatId,
        text,
      },
      signal,
    );
  }
}
