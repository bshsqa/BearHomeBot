import assert from "node:assert/strict";
import { test } from "node:test";

import {
  loadTelegramConfig,
  parseAllowedUserIds,
} from "../src/telegram/config.js";

test("parses and deduplicates numeric Telegram user IDs", () => {
  assert.deepEqual([...parseAllowedUserIds("123, 456,123")], ["123", "456"]);
});

test("rejects non-numeric Telegram user IDs", () => {
  assert.throws(
    () => parseAllowedUserIds("123,username"),
    /comma-separated numeric IDs/,
  );
});

test("loads Telegram configuration without exposing the token", () => {
  const config = loadTelegramConfig({
    BEARHOMEBOT_TELEGRAM_TOKEN: "123456:abcdefghijklmnopqrstuv",
    BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS: "1001,1002",
    BEARHOMEBOT_TELEGRAM_POLL_TIMEOUT_SECONDS: "30",
  });

  assert.equal(config.token, "123456:abcdefghijklmnopqrstuv");
  assert.deepEqual([...config.allowedUserIds], ["1001", "1002"]);
  assert.equal(config.pollTimeoutSeconds, 30);
});
