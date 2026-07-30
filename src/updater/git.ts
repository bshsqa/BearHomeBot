import { mkdirSync, statSync } from "node:fs";
import { TextDecoder } from "node:util";

import type { KSkillPolicy } from "./policy.js";
import { CommandError, minimalHostEnvironment, runCommand } from "./process.js";

const SHA_PATTERN = /^[0-9a-f]{40,64}$/u;
const GIT_TIMEOUT_MILLISECONDS = 5 * 60 * 1_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface GitCandidate {
  sha: string;
  treeSha: string;
}

export interface GitTreeEntry {
  mode: string;
  type: "blob" | "commit";
  objectId: string;
  size?: number;
  path: string;
  pathBytes: number;
}

function splitNull(buffer: Buffer): Buffer[] {
  const values: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] === 0) {
      values.push(buffer.subarray(start, index));
      start = index + 1;
    }
  }
  if (start !== buffer.length) {
    throw new Error("Git returned a non-terminated NUL record");
  }
  return values;
}

function decodePath(buffer: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
}

function parseTreeRecord(record: Buffer): GitTreeEntry {
  const tab = record.indexOf(0x09);
  if (tab < 0) {
    throw new Error("Git tree record is missing a path separator");
  }
  const metadata = record
    .subarray(0, tab)
    .toString("ascii")
    .trim()
    .split(/\s+/u);
  if (metadata.length !== 4) {
    throw new Error("Git tree record has invalid metadata");
  }
  const [mode, type, objectId, sizeText] = metadata;
  if (
    !mode ||
    (type !== "blob" && type !== "commit") ||
    !objectId ||
    !SHA_PATTERN.test(objectId)
  ) {
    throw new Error("Git tree record has invalid object metadata");
  }
  const entry: GitTreeEntry = {
    mode,
    type,
    objectId,
    path: decodePath(record.subarray(tab + 1)),
    pathBytes: record.length - tab - 1,
  };
  if (sizeText !== "-") {
    const size = Number.parseInt(sizeText ?? "", 10);
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new Error("Git tree record has an invalid blob size");
    }
    entry.size = size;
  }
  return entry;
}

function validateSha(sha: string, label: string): string {
  if (!SHA_PATTERN.test(sha)) {
    throw new Error(`${label} has an invalid Git object ID`);
  }
  return sha;
}

export class KSkillGitMirror {
  readonly #mirrorPath: string;
  readonly #policy: KSkillPolicy;
  readonly #gitExecutable: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #fileProtocolPolicy: "always" | "never";

  constructor(
    mirrorPath: string,
    policy: KSkillPolicy,
    options: {
      gitExecutable?: string;
      env?: NodeJS.ProcessEnv;
      allowFileProtocolForTests?: boolean;
    } = {},
  ) {
    this.#mirrorPath = mirrorPath;
    this.#policy = policy;
    this.#gitExecutable = options.gitExecutable ?? "git";
    this.#fileProtocolPolicy = options.allowFileProtocolForTests
      ? "always"
      : "never";
    this.#env = {
      ...minimalHostEnvironment(options.env),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    };
  }

  get path(): string {
    return this.#mirrorPath;
  }

  async ensure(): Promise<void> {
    mkdirSync(this.#mirrorPath, { recursive: true, mode: 0o700 });
    const entries = statSync(this.#mirrorPath);
    if (!entries.isDirectory()) {
      throw new Error("k-skill mirror path is not a directory");
    }

    const bare = await this.#git(
      ["rev-parse", "--is-bare-repository"],
      [0, 128],
    );
    if (bare.exitCode === 128) {
      await runCommand({
        executable: this.#gitExecutable,
        arguments: ["init", "--bare", "--quiet", this.#mirrorPath],
        env: this.#env,
        timeoutMilliseconds: GIT_TIMEOUT_MILLISECONDS,
      });
    } else if (bare.stdout.toString("utf8").trim() !== "true") {
      throw new Error("k-skill mirror is not a bare Git repository");
    }

    const remote = await this.#git(["remote", "get-url", "origin"], [0, 2]);
    if (remote.exitCode === 2) {
      await this.#git(["remote", "add", "origin", this.#policy.upstream.url]);
    } else if (
      remote.stdout.toString("utf8").trim() !== this.#policy.upstream.url
    ) {
      throw new Error("k-skill mirror origin does not match trusted policy");
    }
  }

  async fetchCandidate(signal?: AbortSignal): Promise<GitCandidate> {
    await this.ensure();
    const branch = this.#policy.upstream.branch;
    const remoteRef = `refs/remotes/origin/${branch}`;
    await this.#git(
      [
        "-c",
        `protocol.file.allow=${this.#fileProtocolPolicy}`,
        "-c",
        "submodule.recurse=false",
        "fetch",
        "--no-tags",
        "--prune",
        "origin",
        `+refs/heads/${branch}:${remoteRef}`,
      ],
      [0],
      signal,
    );
    const sha = (await this.#git(["rev-parse", `${remoteRef}^{commit}`])).stdout
      .toString("ascii")
      .trim();
    const treeSha = (await this.#git(["rev-parse", `${sha}^{tree}`])).stdout
      .toString("ascii")
      .trim();
    validateSha(sha, "candidate SHA");
    validateSha(treeSha, "candidate tree SHA");
    await this.#git([
      "fsck",
      "--connectivity-only",
      "--strict",
      "--no-dangling",
      sha,
    ]);
    return { sha, treeSha };
  }

  async isDescendant(ancestor: string, candidate: string): Promise<boolean> {
    validateSha(ancestor, "active SHA");
    validateSha(candidate, "candidate SHA");
    const result = await this.#git(
      ["merge-base", "--is-ancestor", ancestor, candidate],
      [0, 1],
    );
    return result.exitCode === 0;
  }

  async readTree(sha: string): Promise<GitTreeEntry[]> {
    validateSha(sha, "candidate SHA");
    const result = await this.#git(
      ["ls-tree", "-r", "-l", "-z", sha],
      [0],
      undefined,
      MAX_GIT_OUTPUT_BYTES,
    );
    return splitNull(result.stdout).map(parseTreeRecord);
  }

  async readBlob(objectId: string, maximumBytes: number): Promise<Buffer> {
    validateSha(objectId, "blob object ID");
    const result = await this.#git(
      ["cat-file", "blob", objectId],
      [0],
      undefined,
      maximumBytes,
    );
    return result.stdout;
  }

  async changedPaths(
    previousSha: string | undefined,
    candidateSha: string,
  ): Promise<string[]> {
    validateSha(candidateSha, "candidate SHA");
    if (!previousSha) {
      return (await this.readTree(candidateSha)).map((entry) => entry.path);
    }
    validateSha(previousSha, "active SHA");
    const result = await this.#git(
      ["diff", "--name-only", "-z", previousSha, candidateSha],
      [0],
      undefined,
      MAX_GIT_OUTPUT_BYTES,
    );
    return splitNull(result.stdout).map(decodePath);
  }

  async writeArchive(
    sha: string,
    archivePath: string,
    signal?: AbortSignal,
  ): Promise<void> {
    validateSha(sha, "candidate SHA");
    await this.#git(
      ["archive", "--format=tar", `--output=${archivePath}`, sha],
      [0],
      signal,
    );
  }

  async #git(
    arguments_: readonly string[],
    allowedExitCodes: readonly number[] = [0],
    signal?: AbortSignal,
    maxOutputBytes = 8 * 1024 * 1024,
  ) {
    try {
      const options = {
        executable: this.#gitExecutable,
        arguments: ["--git-dir", this.#mirrorPath, ...arguments_],
        env: this.#env,
        timeoutMilliseconds: GIT_TIMEOUT_MILLISECONDS,
        maxOutputBytes,
        allowedExitCodes,
      };
      return await runCommand(
        signal === undefined ? options : { ...options, signal },
      );
    } catch (error) {
      if (error instanceof CommandError) {
        const operation =
          arguments_.find((argument) =>
            [
              "archive",
              "cat-file",
              "diff",
              "fetch",
              "fsck",
              "init",
              "ls-tree",
              "merge-base",
              "remote",
              "rev-parse",
            ].includes(argument),
          ) ?? "command";
        throw new Error(
          `k-skill Git ${operation} operation failed (${error.code})`,
        );
      }
      throw error;
    }
  }
}
