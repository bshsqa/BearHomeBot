import {
  ensureRuntimeDirectories,
  resolveRuntimePaths,
} from "./runtime-paths.js";

const paths = resolveRuntimePaths();
await ensureRuntimeDirectories(paths);

const health = {
  service: "bearhomebot",
  status: "ok",
  runtime: {
    configDir: paths.configDir,
    dataDir: paths.dataDir,
    cacheDir: paths.cacheDir,
  },
};

if (process.argv.includes("--health")) {
  process.stdout.write(`${JSON.stringify(health, null, 2)}\n`);
  process.exit(0);
}

process.stdout.write(
  `BearHomeBot bootstrap is running with data in ${paths.dataDir}\n`,
);

const heartbeat = setInterval(() => undefined, 60_000);

function shutdown(signal: NodeJS.Signals): void {
  clearInterval(heartbeat);
  process.stdout.write(`BearHomeBot received ${signal}; stopping.\n`);
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown(signal));
}
