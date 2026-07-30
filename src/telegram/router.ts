import type { TelegramUpdate } from "./types.js";

export interface TelegramReply {
  chatId: number;
  text: string;
}

const MAX_ECHO_LENGTH = 3_500;

function commandName(text: string): string | undefined {
  const firstWord = text.trim().split(/\s+/, 1)[0];
  if (!firstWord?.startsWith("/")) {
    return undefined;
  }

  return firstWord.slice(1).split("@", 1)[0]?.toLowerCase();
}

function truncateEcho(text: string): string {
  if (text.length <= MAX_ECHO_LENGTH) {
    return text;
  }

  return `${text.slice(0, MAX_ECHO_LENGTH)}\n\n[메시지가 너무 길어 일부만 표시했어]`;
}

export function routeTelegramUpdate(
  update: TelegramUpdate,
  allowedUserIds: ReadonlySet<string>,
): TelegramReply | undefined {
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

  const senderId = String(sender.id);
  const command = commandName(message.text);
  const isAllowed = allowedUserIds.has(senderId);

  if (command === "whoami") {
    return {
      chatId: message.chat.id,
      text: [
        `Telegram user ID: ${senderId}`,
        isAllowed
          ? "이 계정은 BearHomeBot allowlist에 등록되어 있어."
          : "아직 승인 전이야. PC에서 이 숫자 ID를 allowlist에 추가해줘.",
      ].join("\n"),
    };
  }

  if (command === "start") {
    return {
      chatId: message.chat.id,
      text: isAllowed
        ? "BearHomeBot Telegram 연결이 완료됐어. /health 또는 일반 메시지를 보내봐."
        : "BearHomeBot 연결 테스트 봇이야. 먼저 /whoami를 보내 사용자 ID를 확인해줘.",
    };
  }

  if (!isAllowed) {
    return {
      chatId: message.chat.id,
      text: "승인되지 않은 사용자야. /whoami로 숫자 사용자 ID를 확인해줘.",
    };
  }

  if (command === "health") {
    return {
      chatId: message.chat.id,
      text: "BearHomeBot Telegram 연결 정상. 이 응답은 Ubuntu PC에서 보냈어.",
    };
  }

  if (command) {
    return {
      chatId: message.chat.id,
      text: "아직 지원하지 않는 명령이야. 현재는 /whoami, /health와 일반 메시지만 가능해.",
    };
  }

  return {
    chatId: message.chat.id,
    text: `Ubuntu BearHomeBot이 메시지를 받았어:\n\n${truncateEcho(message.text)}`,
  };
}
