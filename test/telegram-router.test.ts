import assert from "node:assert/strict";
import { test } from "node:test";

import {
  routeTelegramUpdate,
  telegramUpdateSenderId,
} from "../src/telegram/router.js";
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

function sessionCallback(data: string, userId = 1001): TelegramUpdate {
  return {
    update_id: 11,
    callback_query: {
      id: "callback-1",
      from: {
        id: userId,
        is_bot: false,
        first_name: "Tester",
      },
      message: {
        message_id: 21,
        chat: {
          id: userId,
          type: "private",
        },
        text: "세션 목록",
      },
      data,
    },
  };
}

test("reveals only the sender's numeric ID before approval", () => {
  const action = routeTelegramUpdate(privateMessage("/whoami"), new Set());

  assert.equal(action?.kind, "reply");
  assert.equal(action?.chatId, 1001);
  if (action?.kind === "reply") {
    assert.match(action.text, /Telegram user ID: 1001/);
    assert.match(action.text, /승인 전/);
  }
});

test("blocks ordinary messages from users outside the allowlist", () => {
  const action = routeTelegramUpdate(privateMessage("안녕"), new Set());

  assert.equal(action?.kind, "reply");
  if (action?.kind === "reply") {
    assert.match(action.text, /승인되지 않은 사용자/);
    assert.doesNotMatch(action.text, /안녕/);
  }
});

test("routes allowed text to a Codex prompt", () => {
  const action = routeTelegramUpdate(
    privateMessage("안녕 BearHomeBot"),
    new Set(["1001"]),
  );

  assert.deepEqual(action, {
    kind: "prompt",
    updateId: 10,
    userId: "1001",
    chatId: 1001,
    text: "안녕 BearHomeBot",
  });
});

test("routes natural-language skill questions through ordinary Codex handling", () => {
  for (const text of [
    "너 가능한 kskill 뭐 있어?",
    "k-skill로 할 수 있는 기능 리스트 알려줘",
    "사용 가능한 스킬 목록 보여줘",
  ]) {
    assert.equal(
      routeTelegramUpdate(privateMessage(text), new Set(["1001"]))?.kind,
      "prompt",
    );
  }
  assert.equal(
    routeTelegramUpdate(privateMessage("/skills"), new Set(["1001"]))?.kind,
    "reply",
  );
});

test("routes the feature menu command and category callbacks", () => {
  assert.deepEqual(
    routeTelegramUpdate(privateMessage("/features"), new Set(["1001"])),
    {
      kind: "list_features",
      updateId: 10,
      userId: "1001",
      chatId: 1001,
    },
  );
  assert.deepEqual(
    routeTelegramUpdate(
      sessionCallback("features:business"),
      new Set(["1001"]),
    ),
    {
      kind: "show_feature_category",
      updateId: 11,
      userId: "1001",
      chatId: 1001,
      callbackQueryId: "callback-1",
      categoryId: "business",
    },
  );
  assert.equal(
    routeTelegramUpdate(sessionCallback("features:menu"), new Set(["1001"]))
      ?.kind,
    "list_features",
  );
});

test("does not mistake a specific skill capability question for a full list", () => {
  const action = routeTelegramUpdate(
    privateMessage(
      "k skill에 있는 ktx 예약 스킬을 참고해서 ktx 조회와 예약이 가능해?",
    ),
    new Set(["1001"]),
  );

  assert.equal(action?.kind, "prompt");
});

test("parses lowercase session commands and optional names", () => {
  assert.deepEqual(
    routeTelegramUpdate(
      privateMessage("/newsession 여행 계획"),
      new Set(["1001"]),
    ),
    {
      kind: "new_session",
      updateId: 10,
      userId: "1001",
      chatId: 1001,
      displayName: "여행 계획",
    },
  );
  assert.equal(
    routeTelegramUpdate(privateMessage("/sessions"), new Set(["1001"]))?.kind,
    "list_sessions",
  );
  assert.equal(
    routeTelegramUpdate(privateMessage("세션 종료해"), new Set(["1001"]))?.kind,
    "end_session",
  );
});

test("routes shutdown only for the configured owner", () => {
  const allowed = new Set(["1001", "1002"]);

  assert.deepEqual(
    routeTelegramUpdate(privateMessage("/shutdown"), allowed, "1001"),
    {
      kind: "request_shutdown",
      updateId: 10,
      userId: "1001",
      chatId: 1001,
    },
  );

  const denied = routeTelegramUpdate(
    privateMessage("/shutdown", 1002),
    allowed,
    "1001",
  );
  assert.equal(denied?.kind, "reply");
  if (denied?.kind === "reply") {
    assert.match(denied.text, /소유자만/);
  }
});

test("routes shutdown confirmation callbacks only for the owner", () => {
  const token = "0123456789abcdef01234567";
  const allowed = new Set(["1001", "1002"]);

  assert.deepEqual(
    routeTelegramUpdate(
      sessionCallback(`shutdown:confirm:${token}`),
      allowed,
      "1001",
    ),
    {
      kind: "confirm_shutdown",
      updateId: 11,
      userId: "1001",
      chatId: 1001,
      callbackQueryId: "callback-1",
      token,
    },
  );
  assert.equal(
    routeTelegramUpdate(
      sessionCallback(`shutdown:confirm:${token}`, 1002),
      allowed,
      "1001",
    )?.kind,
    "answer_callback",
  );
});

test("routes owned-looking callback data as an untrusted session selection", () => {
  const action = routeTelegramUpdate(
    sessionCallback("session:42"),
    new Set(["1001"]),
  );

  assert.deepEqual(action, {
    kind: "select_session",
    updateId: 11,
    userId: "1001",
    chatId: 1001,
    callbackQueryId: "callback-1",
    sessionId: 42,
  });
  assert.equal(telegramUpdateSenderId(sessionCallback("session:42")), "1001");
});

test("rejects malformed and unauthorized callbacks", () => {
  assert.equal(
    routeTelegramUpdate(
      sessionCallback("session:../../secret"),
      new Set(["1001"]),
    )?.kind,
    "answer_callback",
  );
  assert.equal(
    routeTelegramUpdate(sessionCallback("session:42"), new Set())?.kind,
    "answer_callback",
  );
});

test("ignores group messages", () => {
  const update = privateMessage("/whoami");
  if (update.message) {
    update.message.chat.type = "group";
  }

  assert.equal(routeTelegramUpdate(update, new Set(["1001"])), undefined);
});
