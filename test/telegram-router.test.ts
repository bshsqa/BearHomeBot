import assert from "node:assert/strict";
import { test } from "node:test";

import { routeTelegramUpdate } from "../src/telegram/router.js";
import type { TelegramUpdate } from "../src/telegram/types.js";

function privateMessage(text: string, userId = 1001): TelegramUpdate {
  return {
    update_id: 10,
    message: {
      message_id: 20,
      from: {
        id: userId,
        is_bot: false,
        first_name: "Tester",
      },
      chat: {
        id: userId,
        type: "private",
      },
      text,
    },
  };
}

test("reveals only the sender's numeric ID before approval", () => {
  const reply = routeTelegramUpdate(privateMessage("/whoami"), new Set());

  assert.equal(reply?.chatId, 1001);
  assert.match(reply?.text ?? "", /Telegram user ID: 1001/);
  assert.match(reply?.text ?? "", /승인 전/);
});

test("blocks ordinary messages from users outside the allowlist", () => {
  const reply = routeTelegramUpdate(privateMessage("안녕"), new Set());

  assert.match(reply?.text ?? "", /승인되지 않은 사용자/);
  assert.doesNotMatch(reply?.text ?? "", /안녕/);
});

test("acknowledges messages from an allowed user", () => {
  const reply = routeTelegramUpdate(
    privateMessage("안녕 BearHomeBot"),
    new Set(["1001"]),
  );

  assert.match(reply?.text ?? "", /Ubuntu BearHomeBot이 메시지를 받았어/);
  assert.match(reply?.text ?? "", /안녕 BearHomeBot/);
});

test("ignores group messages", () => {
  const update = privateMessage("/whoami");
  if (update.message) {
    update.message.chat.type = "group";
  }

  assert.equal(routeTelegramUpdate(update, new Set(["1001"])), undefined);
});
