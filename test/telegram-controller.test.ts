import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CodexRunnerError,
  type CodexRunRequest,
  type CodexRunResult,
} from "../src/codex/runner.js";
import { StateStore } from "../src/state/store.js";
import {
  splitTelegramText,
  TelegramController,
  type CodexRunnerLike,
  type TelegramClientLike,
} from "../src/telegram/controller.js";
import type {
  TelegramInlineKeyboardMarkup,
  TelegramUpdate,
} from "../src/telegram/types.js";

const THREAD_ONE = "0199a213-81c0-7800-8aa1-bbab2a035a53";

interface SentMessage {
  chatId: number;
  text: string;
  replyMarkup?: TelegramInlineKeyboardMarkup;
}

class FakeTelegramClient implements TelegramClientLike {
  readonly messages: SentMessage[] = [];
  readonly callbacks: Array<{ id: string; text: string }> = [];

  async sendMessage(
    chatId: number,
    text: string,
    options: {
      replyMarkup?: TelegramInlineKeyboardMarkup;
      signal?: AbortSignal;
    } = {},
  ): Promise<void> {
    const message: SentMessage = { chatId, text };
    if (options.replyMarkup) {
      message.replyMarkup = options.replyMarkup;
    }
    this.messages.push(message);
  }

  async answerCallbackQuery(
    callbackQueryId: string,
    text: string,
  ): Promise<void> {
    this.callbacks.push({ id: callbackQueryId, text });
  }
}

class FakeCodexRunner implements CodexRunnerLike {
  readonly requests: CodexRunRequest[] = [];

  async run(request: CodexRunRequest): Promise<CodexRunResult> {
    this.requests.push(request);
    const userMessage =
      request.prompt.match(
        /<user_message>\n(?<message>[\s\S]*)\n<\/user_message>$/u,
      )?.groups?.message ?? request.prompt;
    return {
      threadId: request.threadId ?? THREAD_ONE,
      finalText: `Codex 답변: ${userMessage}`,
      usage: { inputTokens: 10, outputTokens: 5 },
    };
  }
}

function message(
  updateId: number,
  text: string,
  userId = 1001,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: {
        id: userId,
        is_bot: false,
        first_name: "Tester",
      },
      chat: { id: userId, type: "private" },
      text,
    },
  };
}

function callback(
  updateId: number,
  data: string,
  userId = 1001,
): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: {
        id: userId,
        is_bot: false,
        first_name: "Tester",
      },
      message: {
        message_id: updateId,
        chat: { id: userId, type: "private" },
        text: "세션 목록",
      },
      data,
    },
  };
}

function fixture(userIds = ["1001"]): {
  store: StateStore;
  client: FakeTelegramClient;
  runner: FakeCodexRunner;
  controller: TelegramController;
  service: AbortController;
  allowed: Set<string>;
} {
  const store = new StateStore(":memory:", () => "2026-07-30T10:00:00.000Z");
  store.importBootstrapUsers(userIds);
  const client = new FakeTelegramClient();
  const runner = new FakeCodexRunner();
  return {
    store,
    client,
    runner,
    controller: new TelegramController({
      client,
      store,
      runner,
      now: () => new Date("2026-07-30T10:00:00.000Z"),
    }),
    service: new AbortController(),
    allowed: new Set(userIds),
  };
}

test("creates a Codex thread and resumes it for the next message", async () => {
  const context = fixture();
  try {
    await context.controller.handleUpdate(
      message(1, "내 이름은 곰이야"),
      context.allowed,
      context.service.signal,
    );
    await context.controller.handleUpdate(
      message(2, "내 이름이 뭐지?"),
      context.allowed,
      context.service.signal,
    );

    assert.equal(context.runner.requests.length, 2);
    assert.equal(context.runner.requests[0]?.threadId, undefined);
    assert.equal(context.runner.requests[1]?.threadId, THREAD_ONE);
    assert.match(
      context.runner.requests[0]?.prompt ?? "",
      /<user_message>\n내 이름은 곰이야\n<\/user_message>/u,
    );
    assert.equal(context.store.getActiveSession("1001")?.threadId, THREAD_ONE);
    assert.equal(context.store.getActiveSession("1001")?.turnCount, 2);
    assert.deepEqual(
      context.client.messages.map((item) => item.text),
      [
        "Codex가 답변을 준비하고 있어.",
        "Codex 답변: 내 이름은 곰이야",
        "Codex가 답변을 준비하고 있어.",
        "Codex 답변: 내 이름이 뭐지?",
      ],
    );
  } finally {
    context.store.close();
  }
});

test("answers capability catalog questions without invoking Codex", async () => {
  const context = fixture();
  context.controller = new TelegramController({
    client: context.client,
    store: context.store,
    runner: context.runner,
    catalog: {
      listEnabled: () => [
        {
          skillId: "delivery-tracking",
          category: "logistics",
          description: "공식 택배 배송 상태를 조회한다.",
        },
        {
          skillId: "ktx-booking",
          category: "travel",
          description: "KTX 열차와 예약 정보를 조회한다.",
        },
      ],
    },
  });
  try {
    await context.controller.handleUpdate(
      message(1, "너 가능한 kskill 뭐 있어?"),
      context.allowed,
      context.service.signal,
    );

    assert.equal(context.runner.requests.length, 0);
    assert.equal(context.store.getActiveSession("1001"), undefined);
    assert.equal(context.client.messages.length, 1);
    assert.match(context.client.messages[0]?.text ?? "", /2개/u);
    assert.match(context.client.messages[0]?.text ?? "", /delivery-tracking/u);
    assert.match(context.client.messages[0]?.text ?? "", /ktx-booking/u);
  } finally {
    context.store.close();
  }
});

test("gives Codex only the relevant skill context for a capability question", async () => {
  const context = fixture();
  context.controller = new TelegramController({
    client: context.client,
    store: context.store,
    runner: context.runner,
    catalog: {
      listEnabled: () => [
        {
          skillId: "delivery-tracking",
          category: "logistics",
          description: "공식 택배 배송 상태를 조회한다.",
        },
        {
          skillId: "ktx-booking",
          category: "travel",
          description: "KTX 열차와 예약 정보를 조회한다.",
        },
      ],
    },
  });
  try {
    await context.controller.handleUpdate(
      message(
        1,
        "k skill에 있는 ktx 예약 스킬을 참고해서 ktx 조회와 예약이 가능해?",
      ),
      context.allowed,
      context.service.signal,
    );

    assert.equal(context.runner.requests.length, 1);
    const prompt = context.runner.requests[0]?.prompt ?? "";
    assert.match(prompt, /<reviewed_kskill_context>/u);
    assert.match(prompt, /ktx-booking/u);
    assert.doesNotMatch(prompt, /delivery-tracking/u);
    assert.match(
      context.client.messages.at(-1)?.text ?? "",
      /ktx 조회와 예약이 가능해/u,
    );
  } finally {
    context.store.close();
  }
});

test("lists multiple sessions and switches through an owned callback", async () => {
  const context = fixture();
  try {
    await context.controller.handleUpdate(
      message(1, "/newsession 여행 계획"),
      context.allowed,
      context.service.signal,
    );
    const first = context.store.getActiveSession("1001");
    await context.controller.handleUpdate(
      message(2, "/newsession 개발"),
      context.allowed,
      context.service.signal,
    );
    await context.controller.handleUpdate(
      message(3, "/sessions"),
      context.allowed,
      context.service.signal,
    );

    const keyboard = context.client.messages.at(-1)?.replyMarkup;
    assert.ok(keyboard);
    assert.equal(keyboard.inline_keyboard.length, 2);
    assert.equal(
      context.client.messages.at(-1)?.text,
      "내 세션: 2개\n페이지: 1/1\n● 표시가 현재 세션이야.",
    );

    await context.controller.handleUpdate(
      callback(4, `session:${first?.id}`),
      context.allowed,
      context.service.signal,
    );
    assert.equal(
      context.store.getActiveSession("1001")?.displayName,
      "여행 계획",
    );
    assert.deepEqual(context.client.callbacks, [
      { id: "callback-4", text: "세션을 전환했어." },
    ]);
  } finally {
    context.store.close();
  }
});

test("renames and ends the active session without deleting it", async () => {
  const context = fixture();
  try {
    await context.controller.handleUpdate(
      message(1, "/newsession 임시 이름"),
      context.allowed,
      context.service.signal,
    );
    await context.controller.handleUpdate(
      message(2, "/renamesession 가족 일정"),
      context.allowed,
      context.service.signal,
    );
    await context.controller.handleUpdate(
      message(3, "/endsession"),
      context.allowed,
      context.service.signal,
    );

    assert.equal(context.store.getActiveSession("1001"), undefined);
    assert.equal(
      context.store.listSessions("1001")[0]?.displayName,
      "가족 일정",
    );
    assert.match(context.client.messages.at(-1)?.text ?? "", /다시 선택/);
  } finally {
    context.store.close();
  }
});

test("resumes the persisted thread after a service restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-controller-"));
  const databasePath = join(root, "state.sqlite");
  const allowed = new Set(["1001"]);
  const service = new AbortController();

  try {
    const firstStore = new StateStore(
      databasePath,
      () => "2026-07-30T10:00:00.000Z",
    );
    firstStore.importBootstrapUsers(allowed);
    const firstRunner = new FakeCodexRunner();
    const firstController = new TelegramController({
      client: new FakeTelegramClient(),
      store: firstStore,
      runner: firstRunner,
    });
    await firstController.handleUpdate(
      message(1, "기억할 내용"),
      allowed,
      service.signal,
    );
    firstStore.close();

    const reopenedStore = new StateStore(
      databasePath,
      () => "2026-07-30T10:01:00.000Z",
    );
    const resumedRunner = new FakeCodexRunner();
    const resumedController = new TelegramController({
      client: new FakeTelegramClient(),
      store: reopenedStore,
      runner: resumedRunner,
    });
    await resumedController.handleUpdate(
      message(2, "기억한 내용"),
      allowed,
      service.signal,
    );

    assert.equal(resumedRunner.requests[0]?.threadId, THREAD_ONE);
    reopenedStore.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps queued prompts bound to the session active when received", async () => {
  const store = new StateStore(":memory:", () => "2026-07-30T10:00:00.000Z");
  store.importBootstrapUsers(["1001"]);
  const client = new FakeTelegramClient();
  const requests: CodexRunRequest[] = [];
  let reportFirstStarted = (): void => undefined;
  let releaseFirst = (): void => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    reportFirstStarted = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const controller = new TelegramController({
    client,
    store,
    runner: {
      run: async (request) => {
        requests.push(request);
        if (requests.length === 1) {
          reportFirstStarted();
          await firstRelease;
        }
        return {
          threadId: request.threadId ?? THREAD_ONE,
          finalText: "완료",
        };
      },
    },
  });
  const allowed = new Set(["1001"]);
  const service = new AbortController();

  try {
    await controller.handleUpdate(
      message(1, "/newsession 이전 대화"),
      allowed,
      service.signal,
    );
    const oldSessionId = store.getActiveSession("1001")?.id;
    const first = controller.handleUpdate(
      message(2, "첫 요청"),
      allowed,
      service.signal,
    );
    await firstStarted;
    const second = controller.handleUpdate(
      message(3, "두 번째 요청"),
      allowed,
      service.signal,
    );
    await controller.handleUpdate(
      message(4, "/newsession 새 대화"),
      allowed,
      service.signal,
    );

    releaseFirst();
    await Promise.all([first, second]);

    assert.equal(requests[1]?.threadId, THREAD_ONE);
    assert.equal(store.getSession("1001", oldSessionId ?? 0).turnCount, 2);
    assert.equal(store.getActiveSession("1001")?.displayName, "새 대화");
  } finally {
    store.close();
  }
});

test("does not allow a callback to select another user's session", async () => {
  const context = fixture(["1001", "1002"]);
  try {
    const privateSession = context.store.createSession("1002", "가족 2 비공개");

    await context.controller.handleUpdate(
      callback(1, `session:${privateSession.id}`, 1001),
      context.allowed,
      context.service.signal,
    );

    assert.equal(context.store.getActiveSession("1001"), undefined);
    assert.deepEqual(context.client.callbacks, [
      { id: "callback-1", text: "선택할 수 없는 세션이야." },
    ]);
  } finally {
    context.store.close();
  }
});

test("deduplicates replayed Telegram updates", async () => {
  const context = fixture();
  try {
    await context.controller.handleUpdate(
      message(1, "한 번"),
      context.allowed,
      context.service.signal,
    );
    await context.controller.handleUpdate(
      message(1, "두 번"),
      context.allowed,
      context.service.signal,
    );

    assert.equal(context.runner.requests.length, 1);
    assert.match(
      context.runner.requests[0]?.prompt ?? "",
      /<user_message>\n한 번\n<\/user_message>/u,
    );
  } finally {
    context.store.close();
  }
});

test("cancels an active Codex turn without sending a failure reply", async () => {
  const context = fixture();
  let started = (): void => undefined;
  const runnerStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  context.controller = new TelegramController({
    client: context.client,
    store: context.store,
    runner: {
      run: (request) =>
        new Promise((_resolve, reject) => {
          started();
          request.signal?.addEventListener(
            "abort",
            () =>
              reject(
                new CodexRunnerError("cancelled", "Codex run was cancelled"),
              ),
            { once: true },
          );
        }),
    },
  });

  try {
    const running = context.controller.handleUpdate(
      message(1, "긴 작업"),
      context.allowed,
      context.service.signal,
    );
    await runnerStarted;
    await context.controller.handleUpdate(
      message(2, "/cancel"),
      context.allowed,
      context.service.signal,
    );
    await running;

    assert.match(context.client.messages.at(-1)?.text ?? "", /취소했어/);
    assert.equal(
      context.client.messages.some((item) =>
        item.text.includes("완료하지 못했어"),
      ),
      false,
    );
  } finally {
    context.store.close();
  }
});

test("splits long Telegram responses at stable boundaries", () => {
  const chunks = splitTelegramText(
    `${"a".repeat(2_000)}\n${"b".repeat(2_000)}\n${"c".repeat(2_000)}`,
    3_000,
  );

  assert.equal(chunks.length, 3);
  assert.equal(
    chunks.every((chunk) => chunk.length <= 3_000),
    true,
  );
  assert.equal(
    chunks.join(""),
    `${"a".repeat(2_000)}${"b".repeat(2_000)}${"c".repeat(2_000)}`,
  );
});
