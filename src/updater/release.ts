import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import type { GitCandidate, KSkillGitMirror } from "./git.js";
import { minimalHostEnvironment, runCommand } from "./process.js";
import type { CandidateBehaviorReview } from "./reviewer.js";
import type { ReviewedCandidateManifest } from "./skills.js";

const RELEASE_MARKER = ".bearhomebot-release.json";
const MATERIALIZE_TIMEOUT_MILLISECONDS = 2 * 60 * 1_000;

export interface ReleaseMetadata {
  schemaVersion: 2;
  sha: string;
  treeSha: string;
  contentDigest: string;
  validatedAt: string;
  manifest: ReviewedCandidateManifest;
  review: CandidateBehaviorReview;
}

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hashDirectory(root: string): string {
  const hash = createHash("sha256");

  const visit = (directory: string, relativeDirectory: string): void => {
    for (const child of readdirSync(directory).sort((left, right) =>
      left.localeCompare(right, "en"),
    )) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${child}`
        : child;
      if (relative === RELEASE_MARKER) {
        continue;
      }
      const absolute = join(directory, child);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        visit(absolute, relative);
      } else if (stat.isFile()) {
        hash.update(
          `file\0${relative}\0${stat.mode & 0o111 ? "executable" : "regular"}\0${stat.size}\0`,
        );
        hash.update(readFileSync(absolute));
      } else if (stat.isSymbolicLink()) {
        hash.update(`symlink\0${relative}\0${readlinkSync(absolute)}\0`);
      } else {
        throw new Error("Release contains an unsupported file type");
      }
    }
  };

  visit(root, "");
  return hash.digest("hex");
}

function makeReadOnly(root: string): void {
  const visit = (directory: string): void => {
    for (const child of readdirSync(directory)) {
      const path = join(directory, child);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path);
        chmodSync(path, 0o555);
      } else if (stat.isFile()) {
        chmodSync(path, stat.mode & 0o111 ? 0o555 : 0o444);
      } else {
        throw new Error("Release contains an unsupported file type");
      }
    }
  };
  visit(root);
  chmodSync(root, 0o555);
}

function makeWritableForCleanup(root: string): void {
  if (!existsSync(root)) {
    return;
  }
  const visit = (directory: string): void => {
    chmodSync(directory, 0o700);
    for (const child of readdirSync(directory)) {
      const path = join(directory, child);
      const stat = lstatSync(path);
      if (stat.isDirectory()) {
        visit(path);
      } else if (stat.isFile()) {
        chmodSync(path, 0o600);
      }
    }
  };
  visit(root);
}

function parseMetadata(path: string): ReleaseMetadata {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Release metadata is invalid");
  }
  const metadata = value as Record<string, unknown>;
  if (
    metadata.schemaVersion !== 2 ||
    typeof metadata.sha !== "string" ||
    typeof metadata.treeSha !== "string" ||
    typeof metadata.contentDigest !== "string" ||
    typeof metadata.validatedAt !== "string" ||
    !metadata.manifest ||
    !metadata.review
  ) {
    throw new Error("Release metadata is incomplete");
  }
  return value as ReleaseMetadata;
}

export class KSkillReleaseManager {
  readonly #releaseRoot: string;
  readonly #candidateRoot: string;
  readonly #tarExecutable: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #now: () => Date;

  constructor(
    releaseRoot: string,
    candidateRoot: string,
    options: {
      tarExecutable?: string;
      env?: NodeJS.ProcessEnv;
      now?: () => Date;
    } = {},
  ) {
    this.#releaseRoot = resolve(releaseRoot);
    this.#candidateRoot = resolve(candidateRoot);
    this.#tarExecutable = options.tarExecutable ?? "tar";
    this.#env = minimalHostEnvironment(options.env);
    this.#now = options.now ?? (() => new Date());
    mkdirSync(this.#releaseRoot, { recursive: true, mode: 0o700 });
    mkdirSync(this.#candidateRoot, { recursive: true, mode: 0o700 });
  }

  async createReviewDirectory(
    mirror: KSkillGitMirror,
    candidate: GitCandidate,
    signal?: AbortSignal,
  ): Promise<string> {
    const directory = mkdtempSync(
      join(this.#candidateRoot, `${candidate.sha}-`),
    );
    try {
      await this.#materialize(mirror, candidate.sha, directory, signal);
      return directory;
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  removeReviewDirectory(path: string): void {
    const resolved = resolve(path);
    if (
      dirname(resolved) !== this.#candidateRoot ||
      !resolved.startsWith(`${this.#candidateRoot}/`)
    ) {
      throw new Error("Refusing to remove a path outside candidate root");
    }
    rmSync(resolved, { recursive: true, force: true });
  }

  async finalizeRelease(
    mirror: KSkillGitMirror,
    candidate: GitCandidate,
    manifest: ReviewedCandidateManifest,
    review: CandidateBehaviorReview,
    signal?: AbortSignal,
  ): Promise<{ path: string; metadata: ReleaseMetadata }> {
    const target = join(this.#releaseRoot, candidate.sha);
    if (existsSync(target)) {
      return {
        path: target,
        metadata: this.verifyRelease(target, candidate.sha),
      };
    }

    const staging = mkdtempSync(
      join(this.#releaseRoot, `.staging-${candidate.sha}-`),
    );
    try {
      await this.#materialize(mirror, candidate.sha, staging, signal);
      const metadata: ReleaseMetadata = {
        schemaVersion: 2,
        sha: candidate.sha,
        treeSha: candidate.treeSha,
        contentDigest: hashDirectory(staging),
        validatedAt: this.#now().toISOString(),
        manifest,
        review,
      };
      const marker = join(staging, RELEASE_MARKER);
      writeFileSync(marker, `${JSON.stringify(metadata, null, 2)}\n`, {
        mode: 0o400,
      });
      fsyncPath(marker);
      fsyncPath(staging);
      makeReadOnly(staging);
      renameSync(staging, target);
      fsyncPath(this.#releaseRoot);
      return { path: target, metadata };
    } catch (error) {
      if (existsSync(staging)) {
        makeWritableForCleanup(staging);
        rmSync(staging, { recursive: true, force: true });
      }
      throw error;
    }
  }

  verifyRelease(path: string, expectedSha?: string): ReleaseMetadata {
    const resolved = resolve(path);
    if (
      dirname(resolved) !== this.#releaseRoot ||
      !resolved.startsWith(`${this.#releaseRoot}/`)
    ) {
      throw new Error("Release path is outside the configured release root");
    }
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error("Release path is not a directory");
    }
    const metadata = parseMetadata(join(resolved, RELEASE_MARKER));
    if (expectedSha && metadata.sha !== expectedSha) {
      throw new Error("Release SHA does not match its expected identity");
    }
    if (hashDirectory(resolved) !== metadata.contentDigest) {
      throw new Error("Release content digest does not match metadata");
    }
    return metadata;
  }

  async #materialize(
    mirror: KSkillGitMirror,
    sha: string,
    directory: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const archive = join(
      dirname(directory),
      `.bearhomebot-archive-${randomUUID()}.tar`,
    );
    try {
      await mirror.writeArchive(sha, archive, signal);
      const options = {
        executable: this.#tarExecutable,
        arguments: [
          "--extract",
          `--file=${archive}`,
          `--directory=${directory}`,
          "--no-same-owner",
          "--no-same-permissions",
        ],
        env: this.#env,
        timeoutMilliseconds: MATERIALIZE_TIMEOUT_MILLISECONDS,
        maxOutputBytes: 2 * 1024 * 1024,
      };
      await runCommand(signal === undefined ? options : { ...options, signal });
    } finally {
      rmSync(archive, { force: true });
    }
  }
}
