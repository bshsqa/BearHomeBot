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
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

import type { GitCandidate, KSkillGitMirror } from "./git.js";
import { minimalHostEnvironment, runCommand } from "./process.js";
import type {
  BehaviorReviewFinding,
  CandidateBehaviorReview,
  SkillBehaviorReview,
} from "./reviewer.js";
import {
  SKILL_SCOPE_VERSION,
  type ReviewedCandidateManifest,
} from "./skills.js";

const RELEASE_MARKER = ".bearhomebot-release.json";
const MATERIALIZE_TIMEOUT_MILLISECONDS = 2 * 60 * 1_000;
const GIT_SHA_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CONTENT_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function releaseDirectoryName(
  sha: string,
  policyVersion: number,
  scopeVersion: number,
): string {
  return `${sha}-p${policyVersion}-s${scopeVersion}`;
}

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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw new Error(`${label} fields are invalid`);
  }
}

function requireBoundedString(
  value: unknown,
  label: string,
  maximumLength: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && !value.trim()) ||
    value.length > maximumLength
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requireStringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumItemLength: number,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    throw new Error(`${label} is invalid`);
  }
  return value.map((item) =>
    requireBoundedString(item, `${label} item`, maximumItemLength),
  );
}

function requireSkillIdArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100_000) {
    throw new Error(`${label} is invalid`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || !SKILL_ID_PATTERN.test(item)) {
      throw new Error(`${label} contains an invalid skill ID`);
    }
    return item;
  });
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} contains duplicate skill IDs`);
  }
  return result;
}

function parseFinding(value: unknown): BehaviorReviewFinding {
  const finding = requireRecord(value, "Release behavior review finding");
  requireExactKeys(
    finding,
    ["severity", "title", "path", "rationale"],
    [],
    "Release behavior review finding",
  );
  if (
    finding.severity !== "low" &&
    finding.severity !== "medium" &&
    finding.severity !== "high" &&
    finding.severity !== "critical"
  ) {
    throw new Error("Release behavior review finding severity is invalid");
  }
  return {
    severity: finding.severity,
    title: requireBoundedString(
      finding.title,
      "Release behavior review finding title",
      200,
    ),
    path: requireBoundedString(
      finding.path,
      "Release behavior review finding path",
      4096,
      true,
    ),
    rationale: requireBoundedString(
      finding.rationale,
      "Release behavior review finding rationale",
      2000,
    ),
  };
}

function parseSkillReview(value: unknown): SkillBehaviorReview & {
  source: "reviewed" | "cache";
} {
  const skill = requireRecord(value, "Release skill behavior review");
  requireExactKeys(
    skill,
    [
      "skillId",
      "contentDigest",
      "status",
      "summary",
      "dataAccess",
      "networkDestinations",
      "findings",
      "source",
    ],
    [],
    "Release skill behavior review",
  );
  if (
    typeof skill.skillId !== "string" ||
    !SKILL_ID_PATTERN.test(skill.skillId) ||
    typeof skill.contentDigest !== "string" ||
    !CONTENT_DIGEST_PATTERN.test(skill.contentDigest) ||
    (skill.status !== "approved" &&
      skill.status !== "rejected" &&
      skill.status !== "uncertain") ||
    (skill.source !== "reviewed" && skill.source !== "cache") ||
    !Array.isArray(skill.findings) ||
    skill.findings.length > 100
  ) {
    throw new Error("Release skill behavior review is invalid");
  }
  const findings = skill.findings.map(parseFinding);
  if (
    skill.status === "approved" &&
    findings.some(
      (finding) =>
        finding.severity === "high" || finding.severity === "critical",
    )
  ) {
    throw new Error(
      "Release skill behavior review approves a high-severity finding",
    );
  }
  return {
    skillId: skill.skillId,
    contentDigest: skill.contentDigest,
    status: skill.status,
    summary: requireBoundedString(
      skill.summary,
      "Release skill behavior review summary",
      2000,
    ),
    dataAccess: requireStringArray(
      skill.dataAccess,
      "Release skill behavior review data access",
      50,
      500,
    ),
    networkDestinations: requireStringArray(
      skill.networkDestinations,
      "Release skill behavior review network destinations",
      50,
      500,
    ),
    findings,
    source: skill.source,
  };
}

function requirePartition(
  left: readonly string[],
  right: readonly string[],
  expected: ReadonlySet<string>,
  label: string,
): void {
  const combined = [...left, ...right];
  if (
    combined.length !== expected.size ||
    new Set(combined).size !== combined.length ||
    combined.some((skillId) => !expected.has(skillId))
  ) {
    throw new Error(`${label} does not uniquely partition reviewed skills`);
  }
}

function validateUsage(value: unknown): void {
  const usage = requireRecord(value, "Release behavior review usage");
  requireExactKeys(
    usage,
    [],
    ["inputTokens", "cachedInputTokens", "outputTokens"],
    "Release behavior review usage",
  );
  for (const [key, amount] of Object.entries(usage)) {
    if (!Number.isSafeInteger(amount) || (amount as number) < 0) {
      throw new Error(`Release behavior review usage ${key} is invalid`);
    }
  }
}

function parseCandidateBehaviorReview(value: unknown): CandidateBehaviorReview {
  const review = requireRecord(value, "Release behavior review");
  requireExactKeys(
    review,
    [
      "status",
      "summary",
      "policyVersion",
      "totalSkills",
      "reviewedSkills",
      "reusedSkills",
      "enabledSkills",
      "excludedSkills",
      "skills",
    ],
    ["usage"],
    "Release behavior review",
  );
  if (
    review.status !== "approved" &&
    review.status !== "approved_with_exclusions" &&
    review.status !== "rejected"
  ) {
    throw new Error("Release behavior review status is invalid");
  }
  if (
    !Number.isSafeInteger(review.policyVersion) ||
    (review.policyVersion as number) < 1 ||
    (review.policyVersion as number) > 1_000_000 ||
    !Number.isSafeInteger(review.totalSkills) ||
    (review.totalSkills as number) < 1 ||
    (review.totalSkills as number) > 100_000 ||
    !Array.isArray(review.skills) ||
    review.skills.length !== review.totalSkills
  ) {
    throw new Error("Release behavior review counts are invalid");
  }

  const skills = review.skills.map(parseSkillReview);
  const skillById = new Map(skills.map((skill) => [skill.skillId, skill]));
  if (skillById.size !== skills.length) {
    throw new Error("Release behavior review contains duplicate skill IDs");
  }
  const allSkillIds = new Set(skillById.keys());
  const reviewedSkills = requireSkillIdArray(
    review.reviewedSkills,
    "Release reviewedSkills",
  );
  const reusedSkills = requireSkillIdArray(
    review.reusedSkills,
    "Release reusedSkills",
  );
  const enabledSkills = requireSkillIdArray(
    review.enabledSkills,
    "Release enabledSkills",
  );
  const excludedSkills = requireSkillIdArray(
    review.excludedSkills,
    "Release excludedSkills",
  );
  requirePartition(
    reviewedSkills,
    reusedSkills,
    allSkillIds,
    "Release review provenance",
  );
  requirePartition(
    enabledSkills,
    excludedSkills,
    allSkillIds,
    "Release skill authorization",
  );

  const reviewedSet = new Set(reviewedSkills);
  for (const skill of skills) {
    if ((skill.source === "reviewed") !== reviewedSet.has(skill.skillId)) {
      throw new Error("Release skill review provenance is inconsistent");
    }
  }
  for (const skillId of enabledSkills) {
    if (skillById.get(skillId)?.status !== "approved") {
      throw new Error("Release enables a skill that is not approved");
    }
  }

  const expectedStatus =
    enabledSkills.length === 0
      ? "rejected"
      : excludedSkills.length === 0
        ? "approved"
        : "approved_with_exclusions";
  if (review.status !== expectedStatus) {
    throw new Error("Release behavior review status is inconsistent");
  }
  if (expectedStatus === "rejected") {
    throw new Error("Release behavior review does not enable any skills");
  }
  if (review.usage !== undefined) {
    validateUsage(review.usage);
  }

  const result: CandidateBehaviorReview = {
    status: review.status,
    summary: requireBoundedString(
      review.summary,
      "Release behavior review summary",
      4000,
    ),
    policyVersion: review.policyVersion as number,
    totalSkills: review.totalSkills as number,
    reviewedSkills,
    reusedSkills,
    enabledSkills,
    excludedSkills,
    skills,
  };
  if (review.usage !== undefined) {
    result.usage = review.usage as NonNullable<
      CandidateBehaviorReview["usage"]
    >;
  }
  return result;
}

function validateManifestReviewLink(
  manifestValue: unknown,
  review: CandidateBehaviorReview,
  sha: string,
  treeSha: string,
): ReviewedCandidateManifest {
  const manifest = requireRecord(manifestValue, "Release manifest");
  const source = requireRecord(manifest.source, "Release manifest source");
  const behaviorReview = requireRecord(
    manifest.behaviorReview,
    "Release manifest behavior review",
  );
  if (
    source.sha !== sha ||
    source.treeSha !== treeSha ||
    behaviorReview.scopeVersion !== SKILL_SCOPE_VERSION ||
    behaviorReview.policyVersion !== review.policyVersion ||
    behaviorReview.totalSkills !== review.totalSkills ||
    !Array.isArray(behaviorReview.inventory) ||
    behaviorReview.inventory.length !== review.totalSkills
  ) {
    throw new Error("Release manifest and behavior review are inconsistent");
  }
  const inventory = new Map<
    string,
    { contentDigest: string; dependencies: string[] }
  >();
  for (const value of behaviorReview.inventory) {
    const item = requireRecord(value, "Release manifest skill inventory");
    requireExactKeys(
      item,
      ["skillId", "contentDigest", "fileCount", "dependencies"],
      [],
      "Release manifest skill inventory",
    );
    if (
      typeof item.skillId !== "string" ||
      !SKILL_ID_PATTERN.test(item.skillId) ||
      typeof item.contentDigest !== "string" ||
      !CONTENT_DIGEST_PATTERN.test(item.contentDigest) ||
      !Number.isSafeInteger(item.fileCount) ||
      (item.fileCount as number) < 1 ||
      inventory.has(item.skillId)
    ) {
      throw new Error("Release manifest skill inventory is invalid");
    }
    const dependencies = requireSkillIdArray(
      item.dependencies,
      "Release manifest skill dependencies",
    );
    if (dependencies.includes(item.skillId)) {
      throw new Error("Release manifest skill depends on itself");
    }
    inventory.set(item.skillId, {
      contentDigest: item.contentDigest,
      dependencies,
    });
  }
  for (const [skillId, item] of inventory) {
    if (item.dependencies.some((dependency) => !inventory.has(dependency))) {
      throw new Error(
        `Release manifest skill ${skillId} has an unknown dependency`,
      );
    }
  }
  for (const skill of review.skills) {
    if (inventory.get(skill.skillId)?.contentDigest !== skill.contentDigest) {
      throw new Error("Release manifest skill digest is inconsistent");
    }
  }
  const enabledSkills = new Set(review.enabledSkills);
  for (const skillId of enabledSkills) {
    const blockedDependencies =
      inventory
        .get(skillId)
        ?.dependencies.filter((dependency) => !enabledSkills.has(dependency)) ??
      [];
    if (blockedDependencies.length > 0) {
      throw new Error(
        `Release enables skill ${skillId} with an excluded dependency`,
      );
    }
  }
  return manifestValue as ReviewedCandidateManifest;
}

function securityRelevantManifest(
  manifest: ReviewedCandidateManifest,
): unknown {
  return {
    schemaVersion: manifest.schemaVersion,
    source: {
      url: manifest.source.url,
      branch: manifest.source.branch,
      sha: manifest.source.sha,
      treeSha: manifest.source.treeSha,
    },
    tree: {
      fileCount: manifest.tree.fileCount,
      totalBytes: manifest.tree.totalBytes,
      maximumBlobBytes: manifest.tree.maximumBlobBytes,
      executableFiles: manifest.tree.executableFiles,
    },
    loaderSafety: {
      status: manifest.loaderSafety.status,
    },
    behaviorReview: {
      scopeVersion: manifest.behaviorReview.scopeVersion,
      policyVersion: manifest.behaviorReview.policyVersion,
      totalSkills: manifest.behaviorReview.totalSkills,
      inventory: manifest.behaviorReview.inventory,
    },
  };
}

function securityRelevantReview(review: CandidateBehaviorReview): unknown {
  return {
    status: review.status,
    policyVersion: review.policyVersion,
    totalSkills: review.totalSkills,
    enabledSkills: review.enabledSkills,
    excludedSkills: review.excludedSkills,
    skills: review.skills.map((skill) => ({
      skillId: skill.skillId,
      contentDigest: skill.contentDigest,
      status: skill.status,
      summary: skill.summary,
      dataAccess: skill.dataAccess,
      networkDestinations: skill.networkDestinations,
      findings: skill.findings,
    })),
  };
}

function canonicalJson(value: unknown): string {
  const canonicalize = (item: unknown): unknown => {
    if (
      item === null ||
      typeof item === "string" ||
      typeof item === "boolean"
    ) {
      return item;
    }
    if (typeof item === "number" && Number.isFinite(item)) {
      return item;
    }
    if (Array.isArray(item)) {
      return item.map(canonicalize);
    }
    if (item && typeof item === "object") {
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(item).sort((left, right) =>
        left.localeCompare(right, "en"),
      )) {
        const child = (item as Record<string, unknown>)[key];
        if (child === undefined) {
          throw new Error("Release metadata contains an undefined value");
        }
        result[key] = canonicalize(child);
      }
      return result;
    }
    throw new Error("Release metadata contains an unsupported value");
  };
  return JSON.stringify(canonicalize(value));
}

function parseMetadata(path: string): ReleaseMetadata {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const metadata = requireRecord(value, "Release metadata");
  requireExactKeys(
    metadata,
    [
      "schemaVersion",
      "sha",
      "treeSha",
      "contentDigest",
      "validatedAt",
      "manifest",
      "review",
    ],
    [],
    "Release metadata",
  );
  if (
    metadata.schemaVersion !== 2 ||
    typeof metadata.sha !== "string" ||
    !GIT_SHA_PATTERN.test(metadata.sha) ||
    typeof metadata.treeSha !== "string" ||
    !GIT_SHA_PATTERN.test(metadata.treeSha) ||
    typeof metadata.contentDigest !== "string" ||
    !CONTENT_DIGEST_PATTERN.test(metadata.contentDigest) ||
    typeof metadata.validatedAt !== "string" ||
    Number.isNaN(Date.parse(metadata.validatedAt)) ||
    new Date(metadata.validatedAt).toISOString() !== metadata.validatedAt
  ) {
    throw new Error("Release metadata is incomplete");
  }
  const review = parseCandidateBehaviorReview(metadata.review);
  const manifest = validateManifestReviewLink(
    metadata.manifest,
    review,
    metadata.sha,
    metadata.treeSha,
  );
  return {
    schemaVersion: 2,
    sha: metadata.sha,
    treeSha: metadata.treeSha,
    contentDigest: metadata.contentDigest,
    validatedAt: metadata.validatedAt,
    manifest,
    review,
  };
}

export class KSkillReleaseManager {
  readonly #releaseRoot: string;
  readonly #releaseRootReal: string;
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
    const releaseRootStat = lstatSync(this.#releaseRoot);
    if (releaseRootStat.isSymbolicLink() || !releaseRootStat.isDirectory()) {
      throw new Error("Release root must be a real directory");
    }
    this.#releaseRootReal = realpathSync(this.#releaseRoot);
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
    const parsedReview = parseCandidateBehaviorReview(review);
    const parsedManifest = validateManifestReviewLink(
      manifest,
      parsedReview,
      candidate.sha,
      candidate.treeSha,
    );
    const target = join(
      this.#releaseRoot,
      releaseDirectoryName(
        candidate.sha,
        parsedReview.policyVersion,
        parsedManifest.behaviorReview.scopeVersion,
      ),
    );
    const targetStat = lstatSync(target, { throwIfNoEntry: false });
    if (targetStat) {
      if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
        throw new Error("Existing release target must be a real directory");
      }
      const metadata = this.verifyRelease(target, candidate.sha);
      if (
        metadata.treeSha !== candidate.treeSha ||
        canonicalJson(securityRelevantManifest(metadata.manifest)) !==
          canonicalJson(securityRelevantManifest(parsedManifest)) ||
        canonicalJson(securityRelevantReview(metadata.review)) !==
          canonicalJson(securityRelevantReview(parsedReview))
      ) {
        throw new Error(
          "Existing release metadata does not match the requested release",
        );
      }
      return {
        path: target,
        metadata,
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
        manifest: parsedManifest,
        review: parsedReview,
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
    const linkStat = lstatSync(resolved);
    if (linkStat.isSymbolicLink()) {
      throw new Error("Release path must not be a symbolic link");
    }
    const stat = statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error("Release path is not a directory");
    }
    const realPath = realpathSync(resolved);
    if (dirname(realPath) !== this.#releaseRootReal) {
      throw new Error("Release path escapes the configured release root");
    }
    const metadata = parseMetadata(join(resolved, RELEASE_MARKER));
    if (
      resolved !==
      join(
        this.#releaseRoot,
        releaseDirectoryName(
          metadata.sha,
          metadata.review.policyVersion,
          metadata.manifest.behaviorReview.scopeVersion,
        ),
      )
    ) {
      throw new Error("Release directory does not match its SHA identity");
    }
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
