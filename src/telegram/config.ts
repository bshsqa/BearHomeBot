export interface TelegramConfig {
  token: string;
  allowedUserIds: ReadonlySet<string>;
  pollTimeoutSeconds: number;
  codexTimeoutMilliseconds: number;
}

const TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{20,}$/;
const USER_ID_PATTERN = /^\d+$/;

export function parseAllowedUserIds(value: string | undefined): Set<string> {
  const userIds = new Set<string>();

  for (const part of value?.split(",") ?? []) {
    const userId = part.trim();
    if (!userId) {
      continue;
    }
    if (!USER_ID_PATTERN.test(userId)) {
      throw new Error(
        "BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS must contain comma-separated numeric IDs",
      );
    }
    userIds.add(userId);
  }

  return userIds;
}

export function loadTelegramConfig(
  env: NodeJS.ProcessEnv = process.env,
): TelegramConfig {
  const token = env.BEARHOMEBOT_TELEGRAM_TOKEN?.trim();
  if (!token) {
    throw new Error("BEARHOMEBOT_TELEGRAM_TOKEN is required");
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error("BEARHOMEBOT_TELEGRAM_TOKEN has an invalid format");
  }

  const timeoutText = env.BEARHOMEBOT_TELEGRAM_POLL_TIMEOUT_SECONDS ?? "25";
  const pollTimeoutSeconds = Number.parseInt(timeoutText, 10);
  if (
    !Number.isSafeInteger(pollTimeoutSeconds) ||
    pollTimeoutSeconds < 1 ||
    pollTimeoutSeconds > 50
  ) {
    throw new Error(
      "BEARHOMEBOT_TELEGRAM_POLL_TIMEOUT_SECONDS must be an integer from 1 to 50",
    );
  }

  const codexTimeoutText = env.BEARHOMEBOT_CODEX_TIMEOUT_SECONDS ?? "1800";
  const codexTimeoutSeconds = Number.parseInt(codexTimeoutText, 10);
  if (
    !Number.isSafeInteger(codexTimeoutSeconds) ||
    codexTimeoutSeconds < 10 ||
    codexTimeoutSeconds > 1800
  ) {
    throw new Error(
      "BEARHOMEBOT_CODEX_TIMEOUT_SECONDS must be an integer from 10 to 1800",
    );
  }

  return {
    token,
    allowedUserIds: parseAllowedUserIds(
      env.BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS,
    ),
    pollTimeoutSeconds,
    codexTimeoutMilliseconds: codexTimeoutSeconds * 1_000,
  };
}
