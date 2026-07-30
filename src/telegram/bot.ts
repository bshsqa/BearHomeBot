import { setTimeout as delay } from "node:timers/promises";

import { TelegramClient } from "./client.js";
import type { TelegramConfig } from "./config.js";
import { BEARHOMEBOT_COMMANDS, TelegramController } from "./controller.js";

const RETRY_DELAY_MILLISECONDS = 1_000;

export async function runTelegramBot(
  client: TelegramClient,
  config: TelegramConfig,
  controller: TelegramController,
  signal: AbortSignal,
): Promise<void> {
  const bot = await client.getMe(signal);
  const webhook = await client.getWebhookInfo(signal);

  if (webhook.url) {
    throw new Error(
      "Telegram webhook is configured. Remove it before using BearHomeBot long polling.",
    );
  }

  await client.setMyCommands(BEARHOMEBOT_COMMANDS, signal);

  const botName = bot.username ? `@${bot.username}` : bot.first_name;
  process.stdout.write(
    `BearHomeBot Telegram gateway started as ${botName}; ${config.allowedUserIds.size} user(s) allowed.\n`,
  );

  let offset = controller.getInitialOffset();
  const pending = new Set<Promise<void>>();

  while (!signal.aborted) {
    try {
      const updates = await client.getUpdates(
        offset,
        config.pollTimeoutSeconds,
        signal,
      );

      for (const update of updates) {
        const task = controller.handleUpdate(
          update,
          config.allowedUserIds,
          signal,
        );
        pending.add(task);
        const remove = (): void => {
          pending.delete(task);
        };
        void task.then(remove, remove);
        offset = update.update_id + 1;
      }
    } catch (error) {
      if (signal.aborted) {
        break;
      }

      const message =
        error instanceof Error ? error.message : "unknown Telegram error";
      process.stderr.write(`${message}; retrying.\n`);
      await delay(RETRY_DELAY_MILLISECONDS, undefined, { signal }).catch(
        () => undefined,
      );
    }
  }

  await Promise.allSettled([...pending]);
  await controller.drain();
}
