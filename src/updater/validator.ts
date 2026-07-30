import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";

import type { KSkillPolicy } from "./policy.js";
import {
  minimalHostEnvironment,
  runCommand,
  type CommandOptions,
  type CommandResult,
} from "./process.js";

const MAX_CACHE_ENTRIES = 100_000;

export interface CandidateValidationResult {
  imageId: string;
  artifactDigest: string;
  audit: {
    info: number;
    low: number;
    moderate: number;
    high: number;
    critical: number;
    total: number;
  };
}

export type CommandRunner = (options: CommandOptions) => Promise<CommandResult>;

function secureContainerArguments(
  policy: KSkillPolicy,
  candidatePath: string,
  cachePath: string,
): string[] {
  return [
    "run",
    "--rm",
    "--pull=never",
    "--read-only",
    "--cap-drop=all",
    "--security-opt=no-new-privileges",
    `--pids-limit=${policy.validation.pidsLimit}`,
    `--memory=${policy.validation.memory}`,
    `--cpus=${policy.validation.cpus}`,
    "--userns=keep-id",
    "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=256m",
    `--volume=${candidatePath}:/candidate:rw`,
    `--volume=${cachePath}:/cache:rw`,
    "--env=HOME=/tmp/home",
    `--env=npm_config_registry=${policy.dependencies.npmRegistry}`,
    "--env=npm_config_userconfig=/dev/null",
    `--env=PIP_INDEX_URL=${policy.dependencies.pythonIndex}`,
    "--env=PIP_DISABLE_PIP_VERSION_CHECK=1",
    `--env=BEARHOMEBOT_NPM_AUDIT_LEVEL=${policy.dependencies.auditLevel}`,
  ];
}

function digestDirectory(root: string): string {
  const hash = createHash("sha256");
  let entries = 0;

  const visit = (directory: string, relativeDirectory: string): void => {
    const children = readdirSync(directory).sort((left, right) =>
      left.localeCompare(right, "en"),
    );
    for (const child of children) {
      entries += 1;
      if (entries > MAX_CACHE_ENTRIES) {
        throw new Error("Validation cache contains too many entries");
      }
      const absolute = join(directory, child);
      const relative = relativeDirectory
        ? `${relativeDirectory}/${child}`
        : child;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        visit(absolute, relative);
      } else if (stat.isFile()) {
        hash.update(`file\0${relative}\0${stat.size}\0`);
        hash.update(readFileSync(absolute));
      } else if (stat.isSymbolicLink()) {
        hash.update(`symlink\0${relative}\0${readlinkSync(absolute)}\0`);
      } else {
        throw new Error("Validation cache contains an unsupported file type");
      }
    }
  };

  visit(root, "");
  return hash.digest("hex");
}

function parseAudit(path: string): CandidateValidationResult["audit"] {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("npm audit result is not an object");
  }
  const metadata = (value as Record<string, unknown>).metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("npm audit result is missing metadata");
  }
  const vulnerabilities = (metadata as Record<string, unknown>).vulnerabilities;
  if (
    !vulnerabilities ||
    typeof vulnerabilities !== "object" ||
    Array.isArray(vulnerabilities)
  ) {
    throw new Error("npm audit result is missing vulnerability counts");
  }
  const record = vulnerabilities as Record<string, unknown>;
  const count = (name: string): number => {
    const result = record[name];
    if (!Number.isSafeInteger(result) || (result as number) < 0) {
      throw new Error(`npm audit ${name} count is invalid`);
    }
    return result as number;
  };
  return {
    info: count("info"),
    low: count("low"),
    moderate: count("moderate"),
    high: count("high"),
    critical: count("critical"),
    total: count("total"),
  };
}

export class PodmanCandidateValidator {
  readonly #policy: KSkillPolicy;
  readonly #runner: CommandRunner;
  readonly #podmanExecutable: string;
  readonly #env: NodeJS.ProcessEnv;

  constructor(
    policy: KSkillPolicy,
    options: {
      runner?: CommandRunner;
      podmanExecutable?: string;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    this.#policy = policy;
    this.#runner = options.runner ?? runCommand;
    this.#podmanExecutable = options.podmanExecutable ?? "podman";
    this.#env = minimalHostEnvironment(options.env);
  }

  async validate(
    candidateDirectory: string,
    cacheDirectory: string,
    signal?: AbortSignal,
  ): Promise<CandidateValidationResult> {
    const candidatePath = resolve(candidateDirectory);
    const cachePath = resolve(cacheDirectory);
    mkdirSync(cachePath, { recursive: true, mode: 0o700 });

    const inspect = await this.#run([
      "image",
      "inspect",
      "--format={{.Id}}",
      this.#policy.validation.image,
    ]);
    const inspectedImageId = inspect.stdout.toString("utf8").trim();
    const imageId = /^[0-9a-f]{64}$/u.test(inspectedImageId)
      ? `sha256:${inspectedImageId}`
      : inspectedImageId;
    if (!/^sha256:[0-9a-f]{64}$/u.test(imageId)) {
      throw new Error("Validator image returned an invalid image ID");
    }

    const common = secureContainerArguments(
      this.#policy,
      candidatePath,
      cachePath,
    );
    const wheelArguments = this.#policy.dependencies.pythonWheels.map(
      (wheel) => `${wheel.name}==${wheel.version}`,
    );
    await this.#run(
      [
        ...common,
        "--network=slirp4netns",
        this.#policy.validation.image,
        "/opt/bearhomebot/acquire.sh",
        ...wheelArguments,
      ],
      this.#policy.validation.acquireTimeoutSeconds * 1_000,
      signal,
    );

    const validationArguments = common.map((argument) =>
      argument === `--volume=${cachePath}:/cache:rw`
        ? `--volume=${cachePath}:/cache:ro`
        : argument,
    );
    await this.#run(
      [
        ...validationArguments,
        "--network=none",
        this.#policy.validation.image,
        "/opt/bearhomebot/validate.sh",
      ],
      this.#policy.validation.testTimeoutSeconds * 1_000,
      signal,
    );

    return {
      imageId,
      artifactDigest: digestDirectory(cachePath),
      audit: parseAudit(join(candidatePath, ".bearhomebot-npm-audit.json")),
    };
  }

  async #run(
    arguments_: readonly string[],
    timeoutMilliseconds = 30_000,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const options: CommandOptions = {
      executable: this.#podmanExecutable,
      arguments: arguments_,
      env: this.#env,
      timeoutMilliseconds,
      maxOutputBytes: 8 * 1024 * 1024,
    };
    return this.#runner(
      signal === undefined ? options : { ...options, signal },
    );
  }
}
