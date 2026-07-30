import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  realpathSync,
} from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import {
  spawn,
  spawnSync,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import { CodexJsonlParser, type CodexUsage } from "./jsonl.js";

const DEFAULT_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PROMPT_LENGTH = 32_000;
const THREAD_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export interface CodexRunRequest {
  prompt: string;
  threadId?: string;
  signal?: AbortSignal;
}

export interface CodexRunResult {
  threadId: string;
  finalText: string;
  usage?: CodexUsage;
}

export interface CodexRunnerOptions {
  workspace: string;
  executable?: string;
  executablePrefixArguments?: string[];
  env?: NodeJS.ProcessEnv;
  timeoutMilliseconds?: number;
  maxOutputBytes?: number;
}

export class CodexRunnerError extends Error {
  constructor(
    readonly code:
      | "cancelled"
      | "invalid_output"
      | "invalid_prompt"
      | "invalid_thread_id"
      | "output_limit"
      | "process_failed"
      | "timeout",
    message: string,
  ) {
    super(message);
    this.name = "CodexRunnerError";
  }
}

function resolveExecutable(executable: string, env: NodeJS.ProcessEnv): string {
  if (isAbsolute(executable)) {
    accessSync(executable, constants.X_OK);
    return realpathSync(executable);
  }

  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = join(directory, executable);
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync(candidate);
    } catch {
      // Try the next PATH entry.
    }
  }

  throw new Error(`Codex executable was not found: ${executable}`);
}

function buildChildEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {
    HOME: env.HOME,
    PATH: env.PATH,
    LANG: env.LANG ?? "C.UTF-8",
    LC_ALL: env.LC_ALL,
    LC_CTYPE: env.LC_CTYPE,
    CODEX_HOME: env.CODEX_HOME,
    CODEX_SQLITE_HOME: env.CODEX_SQLITE_HOME,
    CODEX_CA_CERTIFICATE: env.CODEX_CA_CERTIFICATE,
    SSL_CERT_FILE: env.SSL_CERT_FILE,
    TZ: "Asia/Seoul",
    RUST_LOG: "error",
    NO_COLOR: "1",
  };

  for (const key of Object.keys(child)) {
    if (child[key] === undefined) {
      delete child[key];
    }
  }
  return child;
}

function filesystemProfile(executablePath: string): string {
  const entries = [
    `":root"="deny"`,
    `":minimal"="read"`,
    `":workspace_roots"={"."="read"}`,
    `${JSON.stringify(executablePath)}="read"`,
  ];
  return `{${entries.join(",")}}`;
}

export function prepareCodexWorkspace(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  mkdirSync(workspace, { recursive: true, mode: 0o700 });
  if (existsSync(join(workspace, ".git"))) {
    return;
  }

  const result = spawnSync("git", ["init", "--quiet", workspace], {
    env: buildChildEnvironment(env),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error("Failed to initialize the dedicated Codex workspace");
  }
}

export class CodexRunner {
  readonly #workspace: string;
  readonly #executable: string;
  readonly #prefixArguments: readonly string[];
  readonly #env: NodeJS.ProcessEnv;
  readonly #timeoutMilliseconds: number;
  readonly #maxOutputBytes: number;

  constructor(options: CodexRunnerOptions) {
    const sourceEnv = options.env ?? process.env;
    this.#workspace = realpathSync(options.workspace);
    this.#executable = resolveExecutable(
      options.executable ?? "codex",
      sourceEnv,
    );
    this.#prefixArguments = options.executablePrefixArguments ?? [];
    this.#env = buildChildEnvironment(sourceEnv);
    this.#timeoutMilliseconds =
      options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS;
    this.#maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  }

  run(request: CodexRunRequest): Promise<CodexRunResult> {
    const prompt = request.prompt.trim();
    if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
      throw new CodexRunnerError(
        "invalid_prompt",
        `Prompt must contain 1-${MAX_PROMPT_LENGTH} characters`,
      );
    }
    if (request.threadId && !THREAD_ID_PATTERN.test(request.threadId)) {
      throw new CodexRunnerError(
        "invalid_thread_id",
        "Codex thread ID has an invalid format",
      );
    }

    const arguments_ = [
      ...this.#prefixArguments,
      ...this.#codexArguments(request.threadId),
    ];
    return this.#runChild(arguments_, prompt, request);
  }

  #codexArguments(threadId: string | undefined): string[] {
    const commonConfiguration = [
      "--ignore-user-config",
      "--strict-config",
      "-c",
      'approval_policy="never"',
      "-c",
      'default_permissions="bearhomebot"',
      "-c",
      `permissions.bearhomebot.filesystem=${filesystemProfile(this.#executable)}`,
    ];

    if (threadId) {
      return [
        "exec",
        "resume",
        "--json",
        ...commonConfiguration,
        threadId,
        "-",
      ];
    }

    return [
      "exec",
      "--json",
      "--color",
      "never",
      ...commonConfiguration,
      "-C",
      this.#workspace,
      "-",
    ];
  }

  #runChild(
    arguments_: string[],
    prompt: string,
    request: CodexRunRequest,
  ): Promise<CodexRunResult> {
    return new Promise((resolve, reject) => {
      const parser = new CodexJsonlParser();
      const stdoutDecoder = new StringDecoder("utf8");
      let outputBytes = 0;
      let failure: CodexRunnerError | undefined;
      let timedOut = false;
      let cancelled = false;
      let forceKillTimer: NodeJS.Timeout | undefined;

      const child = spawn(this.#executable, arguments_, {
        cwd: this.#workspace,
        env: this.#env,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      }) as ChildProcessWithoutNullStreams;

      const stopChild = (): void => {
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

      const timeout = setTimeout(() => {
        timedOut = true;
        stopChild();
      }, this.#timeoutMilliseconds);
      timeout.unref();

      const onAbort = (): void => {
        cancelled = true;
        stopChild();
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      if (request.signal?.aborted) {
        onAbort();
      }

      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > this.#maxOutputBytes) {
          failure = new CodexRunnerError(
            "output_limit",
            "Codex output exceeded the configured limit",
          );
          stopChild();
          return;
        }
        parser.push(stdoutDecoder.write(chunk));
      });
      child.stderr.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > this.#maxOutputBytes) {
          failure = new CodexRunnerError(
            "output_limit",
            "Codex output exceeded the configured limit",
          );
          stopChild();
        }
      });

      child.on("error", () => {
        failure = new CodexRunnerError(
          "process_failed",
          "Codex process could not be started",
        );
      });

      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        if (forceKillTimer) {
          clearTimeout(forceKillTimer);
        }
        request.signal?.removeEventListener("abort", onAbort);
        parser.push(stdoutDecoder.end());

        if (cancelled) {
          reject(new CodexRunnerError("cancelled", "Codex run was cancelled"));
          return;
        }
        if (timedOut) {
          reject(new CodexRunnerError("timeout", "Codex run timed out"));
          return;
        }
        if (failure) {
          reject(failure);
          return;
        }

        const parsed = parser.finish();
        if (exitCode !== 0 || parsed.turnFailed) {
          reject(
            new CodexRunnerError(
              "process_failed",
              "Codex did not complete the turn",
            ),
          );
          return;
        }

        const threadId = parsed.threadId ?? request.threadId;
        if (
          !threadId ||
          !THREAD_ID_PATTERN.test(threadId) ||
          !parsed.finalText?.trim()
        ) {
          reject(
            new CodexRunnerError(
              "invalid_output",
              "Codex returned incomplete structured output",
            ),
          );
          return;
        }

        const result: CodexRunResult = {
          threadId,
          finalText: parsed.finalText.trim(),
        };
        if (parsed.usage) {
          result.usage = parsed.usage;
        }
        resolve(result);
      });

      child.stdin.on("error", () => undefined);
      child.stdin.end(prompt, "utf8");
    });
  }
}
