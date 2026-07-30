import { CodexRunner, prepareCodexWorkspace } from "./codex/runner.js";
import {
  ensureRuntimeDirectories,
  resolveRuntimePaths,
} from "./runtime-paths.js";
import { StateStore } from "./state/store.js";
import { runTelegramBot } from "./telegram/bot.js";
import { TelegramClient } from "./telegram/client.js";
import { loadTelegramConfig } from "./telegram/config.js";
import { TelegramController } from "./telegram/controller.js";

process.umask(0o077);

const abortController = new AbortController();
let store: StateStore | undefined;

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
  const paths = resolveRuntimePaths();
  await ensureRuntimeDirectories(paths);
  prepareCodexWorkspace(paths.codexWorkspace);

  store = new StateStore(paths.stateDatabase);
  store.importBootstrapUsers(config.allowedUserIds);

  const client = new TelegramClient(config.token);
  const runner = new CodexRunner({
    workspace: paths.codexWorkspace,
    timeoutMilliseconds: config.codexTimeoutMilliseconds,
  });
  const controller = new TelegramController({
    client,
    store,
    runner,
  });

  await runTelegramBot(client, config, controller, abortController.signal);
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`BearHomeBot Telegram gateway failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  store?.close();
}
