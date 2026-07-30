import { spawn } from "node:child_process";

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export interface CommandOptions {
  executable: string;
  arguments?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  stdin?: string | Buffer;
  timeoutMilliseconds?: number;
  maxOutputBytes?: number;
  allowedExitCodes?: readonly number[];
  signal?: AbortSignal;
}

export interface CommandResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
}

export class CommandError extends Error {
  constructor(
    readonly code:
      "aborted" | "failed" | "output_limit" | "spawn_failed" | "timeout",
    message: string,
    readonly exitCode?: number,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export function minimalHostEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: source.HOME,
    PATH: source.PATH,
    LANG: source.LANG ?? "C.UTF-8",
    LC_ALL: source.LC_ALL,
    LC_CTYPE: source.LC_CTYPE,
    SSL_CERT_FILE: source.SSL_CERT_FILE,
    SSL_CERT_DIR: source.SSL_CERT_DIR,
    HTTPS_PROXY: source.HTTPS_PROXY,
    HTTP_PROXY: source.HTTP_PROXY,
    NO_PROXY: source.NO_PROXY,
    https_proxy: source.https_proxy,
    http_proxy: source.http_proxy,
    no_proxy: source.no_proxy,
    TZ: "Asia/Seoul",
  };
  for (const key of Object.keys(env)) {
    if (env[key] === undefined) {
      delete env[key];
    }
  }
  return env;
}

export function runCommand(options: CommandOptions): Promise<CommandResult> {
  const allowedExitCodes = options.allowedExitCodes ?? [0];
  const maximumOutput = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const arguments_ = [...(options.arguments ?? [])];

  return new Promise((resolve, reject) => {
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let failure: CommandError | undefined;
    let timedOut = false;
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const child = spawn(options.executable, arguments_, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stop = (): void => {
      if (child.exitCode !== null || child.killed) {
        return;
      }
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null) {
          child.kill("SIGKILL");
        }
      }, 2_000);
      forceKillTimer.unref();
    };

    const timeout =
      options.timeoutMilliseconds === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            stop();
          }, options.timeoutMilliseconds);
    timeout?.unref();

    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) {
      onAbort();
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > maximumOutput) {
        failure = new CommandError(
          "output_limit",
          "Command output exceeded the configured limit",
        );
        stop();
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stdoutBytes + stderrBytes > maximumOutput) {
        failure = new CommandError(
          "output_limit",
          "Command output exceeded the configured limit",
        );
        stop();
        return;
      }
      stderr.push(chunk);
    });
    child.on("error", () => {
      failure = new CommandError(
        "spawn_failed",
        "Command process could not be started",
      );
    });
    child.on("close", (exitCode) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);

      if (aborted) {
        reject(new CommandError("aborted", "Command was aborted"));
        return;
      }
      if (timedOut) {
        reject(new CommandError("timeout", "Command timed out"));
        return;
      }
      if (failure) {
        reject(failure);
        return;
      }
      const code = exitCode ?? -1;
      if (!allowedExitCodes.includes(code)) {
        reject(
          new CommandError(
            "failed",
            `Command exited with status ${code}`,
            code,
          ),
        );
        return;
      }
      resolve({
        exitCode: code,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });

    if (options.stdin === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(options.stdin);
    }
  });
}
