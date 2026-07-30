import { runTelegramBot } from "./telegram/bot.js";
import { TelegramClient } from "./telegram/client.js";
import { loadTelegramConfig } from "./telegram/config.js";

const abortController = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    process.stdout.write(
      `BearHomeBot Telegram gateway received ${signal}; stopping.\n`,
    );
    abortController.abort();
  });
}

try {
  const config = loadTelegramConfig();
  const client = new TelegramClient(config.token);
  await runTelegramBot(client, config, abortController.signal);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`BearHomeBot Telegram gateway failed: ${message}\n`);
  process.exitCode = 1;
}
