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
    BEARHOMEBOT_TELEGRAM_OWNER_USER_ID: "1001",
    BEARHOMEBOT_TELEGRAM_POLL_TIMEOUT_SECONDS: "30",
    BEARHOMEBOT_CODEX_TIMEOUT_SECONDS: "120",
  });

  assert.equal(config.token, "123456:abcdefghijklmnopqrstuv");
  assert.deepEqual([...config.allowedUserIds], ["1001", "1002"]);
  assert.equal(config.ownerUserId, "1001");
  assert.equal(config.pollTimeoutSeconds, 30);
  assert.equal(config.codexTimeoutMilliseconds, 120_000);
});

test("uses the sole allowed Telegram user as a backward-compatible owner", () => {
  const config = loadTelegramConfig({
    BEARHOMEBOT_TELEGRAM_TOKEN: "123456:abcdefghijklmnopqrstuv",
    BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS: "1001",
  });

  assert.equal(config.ownerUserId, "1001");
});

test("requires an explicitly configured owner when multiple users exist", () => {
  const config = loadTelegramConfig({
    BEARHOMEBOT_TELEGRAM_TOKEN: "123456:abcdefghijklmnopqrstuv",
    BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS: "1001,1002",
  });

  assert.equal(config.ownerUserId, undefined);
});

test("rejects an owner outside the Telegram allowlist", () => {
  assert.throws(
    () =>
      loadTelegramConfig({
        BEARHOMEBOT_TELEGRAM_TOKEN: "123456:abcdefghijklmnopqrstuv",
        BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS: "1001",
        BEARHOMEBOT_TELEGRAM_OWNER_USER_ID: "1002",
      }),
    /must also be in the allowlist/,
  );
});

test("defaults Codex turns to a 30 minute timeout", () => {
  const config = loadTelegramConfig({
    BEARHOMEBOT_TELEGRAM_TOKEN: "123456:abcdefghijklmnopqrstuv",
  });

  assert.equal(config.codexTimeoutMilliseconds, 1_800_000);
});

test("rejects Codex turn timeouts longer than 30 minutes", () => {
  assert.throws(
    () =>
      loadTelegramConfig({
        BEARHOMEBOT_TELEGRAM_TOKEN: "123456:abcdefghijklmnopqrstuv",
        BEARHOMEBOT_CODEX_TIMEOUT_SECONDS: "1801",
      }),
    /integer from 10 to 1800/,
  );
});
