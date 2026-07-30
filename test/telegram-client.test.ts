import assert from "node:assert/strict";
import test from "node:test";

import { TelegramApiError, TelegramClient } from "../src/telegram/client.js";

const token = "123456:abcdefghijklmnopqrstuv";

test("sends long-polling requests with a bounded Telegram payload", async () => {
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  const fetchImplementation: typeof fetch = async (input, init) => {
    capturedUrl = String(input);
    capturedInit = init;
    return Response.json({ ok: true, result: [] });
  };

  const client = new TelegramClient(token, fetchImplementation);
  const updates = await client.getUpdates(42, 25);

  assert.deepEqual(updates, []);
  assert.equal(capturedUrl, `https://api.telegram.org/bot${token}/getUpdates`);
  assert.equal(capturedInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(capturedInit?.body)), {
    timeout: 25,
    limit: 100,
    allowed_updates: ["message"],
    offset: 42,
  });
});

test("does not expose the token when the network request fails", async () => {
  const fetchImplementation: typeof fetch = async () => {
    throw new Error(`request failed for bot${token}`);
  };

  const client = new TelegramClient(token, fetchImplementation);

  await assert.rejects(client.getMe(), (error: unknown) => {
    assert.ok(error instanceof TelegramApiError);
    assert.doesNotMatch(error.message, new RegExp(token, "u"));
    assert.match(error.message, /network request failed/u);
    return true;
  });
});

test("preserves abort errors so shutdown stays immediate", async () => {
  const fetchImplementation: typeof fetch = async () => {
    throw new DOMException("stopped", "AbortError");
  };

  const client = new TelegramClient(token, fetchImplementation);

  await assert.rejects(client.getMe(), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.name, "AbortError");
    return true;
  });
});
