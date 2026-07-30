import type { TelegramUpdate } from "./types.js";

interface TelegramActionBase {
  updateId: number;
  userId: string;
  chatId: number;
}

export type TelegramAction =
  | (TelegramActionBase & {
      kind: "answer_callback";
      callbackQueryId: string;
      text: string;
    })
  | (TelegramActionBase & {
      kind: "cancel";
    })
  | (TelegramActionBase & {
      kind: "end_session";
    })
  | (TelegramActionBase & {
      kind: "list_sessions";
      page: number;
      callbackQueryId?: string;
    })
  | (TelegramActionBase & {
      kind: "list_capabilities";
    })
  | (TelegramActionBase & {
      kind: "new_session";
      displayName?: string;
    })
  | (TelegramActionBase & {
      kind: "prompt";
      text: string;
    })
  | (TelegramActionBase & {
      kind: "rename_session";
      displayName?: string;
    })
  | (TelegramActionBase & {
      kind: "reply";
      text: string;
    })
  | (TelegramActionBase & {
      kind: "select_session";
      callbackQueryId: string;
      sessionId: number;
    });

interface ParsedCommand {
  name: string;
  argument?: string;
}

function parseCommand(text: string): ParsedCommand | undefined {
  const trimmed = text.trim();
  const [firstWord, ...remaining] = trimmed.split(/\s+/u);
  if (!firstWord?.startsWith("/")) {
    return undefined;
  }

  const command: ParsedCommand = {
    name: firstWord.slice(1).split("@", 1)[0]?.toLowerCase() ?? "",
  };
  const argument = remaining.join(" ").trim();
  if (argument) {
    command.argument = argument;
  }
  return command;
}

export function telegramUpdateSenderId(
  update: TelegramUpdate,
): string | undefined {
  const sender = update.message?.from ?? update.callback_query?.from;
  return sender && !sender.is_bot ? String(sender.id) : undefined;
}

export function routeTelegramUpdate(
  update: TelegramUpdate,
  allowedUserIds: ReadonlySet<string>,
): TelegramAction | undefined {
  const callback = update.callback_query;
  if (callback) {
    const message = callback.message;
    if (callback.from.is_bot || !message || message.chat.type !== "private") {
      return undefined;
    }

    const userId = String(callback.from.id);
    const base = {
      updateId: update.update_id,
      userId,
      chatId: message.chat.id,
    };
    if (!allowedUserIds.has(userId)) {
      return {
        ...base,
        kind: "answer_callback",
        callbackQueryId: callback.id,
        text: "승인되지 않은 사용자야.",
      };
    }

    const sessionMatch = /^session:([1-9]\d*)$/u.exec(callback.data ?? "");
    const pageMatch = /^sessions:([0-9]\d*)$/u.exec(callback.data ?? "");
    if (pageMatch?.[1]) {
      const page = Number.parseInt(pageMatch[1], 10);
      if (Number.isSafeInteger(page) && page <= 10_000) {
        return {
          ...base,
          kind: "list_sessions",
          page,
          callbackQueryId: callback.id,
        };
      }
    }
    if (!sessionMatch?.[1]) {
      return {
        ...base,
        kind: "answer_callback",
        callbackQueryId: callback.id,
        text: "유효하지 않은 선택이야.",
      };
    }

    const sessionId = Number.parseInt(sessionMatch[1], 10);
    if (!Number.isSafeInteger(sessionId)) {
      return {
        ...base,
        kind: "answer_callback",
        callbackQueryId: callback.id,
        text: "유효하지 않은 선택이야.",
      };
    }

    return {
      ...base,
      kind: "select_session",
      callbackQueryId: callback.id,
      sessionId,
    };
  }

  const message = update.message;
  const sender = message?.from;
  if (
    !message ||
    message.chat.type !== "private" ||
    !sender ||
    sender.is_bot ||
    typeof message.text !== "string"
  ) {
    return undefined;
  }

  const userId = String(sender.id);
  const base = {
    updateId: update.update_id,
    userId,
    chatId: message.chat.id,
  };
  const command = parseCommand(message.text);
  const isAllowed = allowedUserIds.has(userId);

  if (command?.name === "whoami") {
    return {
      ...base,
      kind: "reply",
      text: [
        `Telegram user ID: ${userId}`,
        isAllowed
          ? "이 계정은 BearHomeBot allowlist에 등록되어 있어."
          : "아직 승인 전이야. PC에서 이 숫자 ID를 allowlist에 추가해줘.",
      ].join("\n"),
    };
  }

  if (command?.name === "start") {
    return {
      ...base,
      kind: "reply",
      text: isAllowed
        ? "BearHomeBot 연결이 완료됐어. 일반 메시지를 보내면 Codex와 대화할 수 있어."
        : "BearHomeBot이야. 먼저 /whoami를 보내 사용자 ID를 확인해줘.",
    };
  }

  if (!isAllowed) {
    return {
      ...base,
      kind: "reply",
      text: "승인되지 않은 사용자야. /whoami로 숫자 사용자 ID를 확인해줘.",
    };
  }

  if (command?.name === "health") {
    return {
      ...base,
      kind: "reply",
      text: "BearHomeBot Telegram 연결 정상. 이 응답은 Ubuntu PC에서 보냈어.",
    };
  }
  if (command?.name === "skills") {
    return { ...base, kind: "list_capabilities" };
  }
  if (command?.name === "newsession") {
    const action: TelegramAction = { ...base, kind: "new_session" };
    if (command.argument) {
      action.displayName = command.argument;
    }
    return action;
  }
  if (command?.name === "sessions" || command?.name === "sessionlist") {
    return { ...base, kind: "list_sessions", page: 0 };
  }
  if (command?.name === "renamesession") {
    const action: TelegramAction = { ...base, kind: "rename_session" };
    if (command.argument) {
      action.displayName = command.argument;
    }
    return action;
  }
  if (
    command?.name === "endsession" ||
    (!command && message.text.trim() === "세션 종료해")
  ) {
    return { ...base, kind: "end_session" };
  }
  if (command?.name === "cancel") {
    return { ...base, kind: "cancel" };
  }
  if (command) {
    return {
      ...base,
      kind: "reply",
      text: "지원하지 않는 명령이야. /sessions에서 사용 가능한 대화를 확인해줘.",
    };
  }
  return {
    ...base,
    kind: "prompt",
    text: message.text,
  };
}
