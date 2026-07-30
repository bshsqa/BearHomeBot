import { posix } from "node:path";

import {
  KSkillGitMirror,
  type GitCandidate,
  type GitTreeEntry,
} from "./git.js";
import type { KSkillPolicy } from "./policy.js";

const PACKAGE_JSON_MAX_BYTES = 2 * 1024 * 1024;
const LOCKFILE_MAX_BYTES = 16 * 1024 * 1024;
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

export type CandidateGateErrorCode =
  | "changed_path_limit"
  | "dependency_policy"
  | "file_count_limit"
  | "history_non_fast_forward"
  | "invalid_json"
  | "invalid_path"
  | "lockfile_policy"
  | "missing_manifest"
  | "oversized_blob"
  | "oversized_tree"
  | "submodule"
  | "symlink"
  | "unsupported_file_mode";

export class CandidateGateError extends Error {
  constructor(
    readonly code: CandidateGateErrorCode,
    message: string,
    readonly path?: string,
  ) {
    super(message);
    this.name = "CandidateGateError";
  }
}

export interface CandidateManifest {
  schemaVersion: 1;
  source: {
    url: string;
    branch: string;
    sha: string;
    treeSha: string;
    previousSha?: string;
  };
  tree: {
    fileCount: number;
    totalBytes: number;
    maximumBlobBytes: number;
    executableFiles: number;
    packageJsonFiles: number;
  };
  dependencies: {
    workspacePackages: number;
    lockedNodeModules: number;
    localWorkspaceLinks: number;
    registryArtifacts: number;
    entriesWithoutIntegrity: number;
    entriesWithInstallScripts: number;
    pythonRequirementFiles: number;
  };
  changes: {
    count: number;
    paths: string[];
    truncated: boolean;
  };
  deterministicGates: {
    status: "passed";
    checkedAt: string;
  };
}

interface DependencySummary {
  workspacePackages: number;
  lockedNodeModules: number;
  localWorkspaceLinks: number;
  registryArtifacts: number;
  entriesWithoutIntegrity: number;
  entriesWithInstallScripts: number;
  pythonRequirementFiles: number;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CandidateGateError(
      "invalid_json",
      `${path} must contain a JSON object`,
      path,
    );
  }
  return value as Record<string, unknown>;
}

function parseJson(buffer: Buffer, path: string): Record<string, unknown> {
  try {
    return requireRecord(JSON.parse(buffer.toString("utf8")) as unknown, path);
  } catch (error) {
    if (error instanceof CandidateGateError) {
      throw error;
    }
    throw new CandidateGateError(
      "invalid_json",
      `${path} is not valid JSON`,
      path,
    );
  }
}

function validateTreePath(entry: GitTreeEntry, policy: KSkillPolicy): void {
  const { path } = entry;
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/u.test(path) ||
    posix.normalize(path) !== path
  ) {
    throw new CandidateGateError(
      "invalid_path",
      "Candidate contains an unsafe path",
      path,
    );
  }
  const segments = path.split("/");
  if (
    segments.some(
      (segment) => segment === ".git" || segment.startsWith(".bearhomebot-"),
    ) ||
    segments.some(
      (segment) =>
        !segment ||
        segment === "." ||
        segment === ".." ||
        Buffer.byteLength(segment) > policy.limits.maxSegmentBytes,
    ) ||
    entry.pathBytes > policy.limits.maxPathBytes
  ) {
    throw new CandidateGateError(
      "invalid_path",
      "Candidate path is reserved, exceeds policy, or escapes its root",
      path,
    );
  }
}

function validateDependencySpec(
  name: string,
  value: unknown,
  path: string,
): void {
  if (typeof value !== "string" || !value.trim()) {
    throw new CandidateGateError(
      "dependency_policy",
      `Dependency ${name} has an invalid version range`,
      path,
    );
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized.startsWith("git+") ||
    normalized.startsWith("git://") ||
    normalized.startsWith("github:") ||
    normalized.startsWith("http://") ||
    normalized.startsWith("https://") ||
    normalized.startsWith("file:") ||
    normalized.startsWith("link:") ||
    normalized.startsWith("workspace:") ||
    normalized.startsWith("npm:")
  ) {
    throw new CandidateGateError(
      "dependency_policy",
      `Dependency ${name} uses a prohibited source`,
      path,
    );
  }
}

function validatePackageJson(
  packageJson: Record<string, unknown>,
  path: string,
): string | undefined {
  const name = packageJson.name;
  if (name !== undefined && (typeof name !== "string" || !name.trim())) {
    throw new CandidateGateError(
      "dependency_policy",
      "Package name must be a non-empty string",
      path,
    );
  }
  for (const field of DEPENDENCY_FIELDS) {
    const dependencies = packageJson[field];
    if (dependencies === undefined) {
      continue;
    }
    const record = requireRecord(dependencies, path);
    for (const [dependencyName, value] of Object.entries(record)) {
      validateDependencySpec(dependencyName, value, path);
    }
  }
  return typeof name === "string" ? name : undefined;
}

function validateLocalResolvedPath(
  resolved: string,
  packageDirectories: ReadonlySet<string>,
): void {
  if (
    resolved.startsWith("/") ||
    resolved.includes("\\") ||
    posix.normalize(resolved) !== resolved ||
    resolved.split("/").some((segment) => segment === "..")
  ) {
    throw new CandidateGateError(
      "lockfile_policy",
      "Lockfile contains an unsafe local workspace path",
      "package-lock.json",
    );
  }
  if (!packageDirectories.has(resolved)) {
    throw new CandidateGateError(
      "lockfile_policy",
      "Lockfile local workspace link does not exist in the candidate tree",
      "package-lock.json",
    );
  }
}

function validateResolvedUrl(
  resolved: string,
  registry: URL,
): "local" | "registry" {
  if (resolved.startsWith("packages/")) {
    return "local";
  }
  let url: URL;
  try {
    url = new URL(resolved);
  } catch {
    throw new CandidateGateError(
      "lockfile_policy",
      "Lockfile contains an unsupported resolved source",
      "package-lock.json",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.host !== registry.host
  ) {
    throw new CandidateGateError(
      "lockfile_policy",
      "Lockfile resolved source is outside the trusted npm registry",
      "package-lock.json",
    );
  }
  return "registry";
}

async function inspectDependencies(
  mirror: KSkillGitMirror,
  entries: readonly GitTreeEntry[],
  policy: KSkillPolicy,
): Promise<DependencySummary> {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  const packageEntries = entries.filter(
    (entry) => posix.basename(entry.path) === "package.json",
  );
  const packageDirectories = new Set<string>();
  for (const entry of packageEntries) {
    const directory = posix.dirname(entry.path);
    if (directory !== ".") {
      packageDirectories.add(directory);
    }
    const packageJson = parseJson(
      await mirror.readBlob(entry.objectId, PACKAGE_JSON_MAX_BYTES),
      entry.path,
    );
    validatePackageJson(packageJson, entry.path);
  }

  const rootPackage = byPath.get("package.json");
  const lockEntry = byPath.get("package-lock.json");
  if (!rootPackage || !lockEntry) {
    throw new CandidateGateError(
      "missing_manifest",
      "Candidate must contain package.json and package-lock.json",
    );
  }

  const lock = parseJson(
    await mirror.readBlob(lockEntry.objectId, LOCKFILE_MAX_BYTES),
    "package-lock.json",
  );
  if (lock.lockfileVersion !== 3) {
    throw new CandidateGateError(
      "lockfile_policy",
      "package-lock.json must use lockfileVersion 3",
      "package-lock.json",
    );
  }
  const packages = requireRecord(lock.packages, "package-lock.json");
  const registry = new URL(policy.dependencies.npmRegistry);
  let lockedNodeModules = 0;
  let localWorkspaceLinks = 0;
  let registryArtifacts = 0;
  let entriesWithoutIntegrity = 0;
  let entriesWithInstallScripts = 0;

  for (const [lockPath, rawPackage] of Object.entries(packages)) {
    const lockedPackage = requireRecord(rawPackage, "package-lock.json");
    if (lockedPackage.hasInstallScript === true) {
      entriesWithInstallScripts += 1;
    }
    const resolved = lockedPackage.resolved;
    if (resolved !== undefined) {
      if (typeof resolved !== "string" || !resolved) {
        throw new CandidateGateError(
          "lockfile_policy",
          "Lockfile resolved value must be a string",
          "package-lock.json",
        );
      }
      const kind = validateResolvedUrl(resolved, registry);
      if (kind === "local") {
        validateLocalResolvedPath(resolved, packageDirectories);
        localWorkspaceLinks += 1;
      } else {
        registryArtifacts += 1;
      }
    }
    if (lockPath.startsWith("node_modules/")) {
      lockedNodeModules += 1;
      if (
        lockedPackage.link !== true &&
        typeof lockedPackage.integrity !== "string"
      ) {
        entriesWithoutIntegrity += 1;
      }
    }
  }

  let pythonRequirementFiles = 0;
  for (const entry of entries) {
    const basename = posix.basename(entry.path);
    if (/^requirements(?:-[A-Za-z0-9._-]+)?\.txt$/u.test(basename)) {
      pythonRequirementFiles += 1;
      const text = (
        await mirror.readBlob(entry.objectId, PACKAGE_JSON_MAX_BYTES)
      ).toString("utf8");
      if (
        /(?:^|\s)(?:--index-url|--extra-index-url|-e)(?:\s|=)/mu.test(text) ||
        /(?:git\+|https?:\/\/|file:)/iu.test(text)
      ) {
        throw new CandidateGateError(
          "dependency_policy",
          "Python requirements contain an external or custom source",
          entry.path,
        );
      }
    }
    if (basename === "pyproject.toml" || basename === "uv.lock") {
      throw new CandidateGateError(
        "dependency_policy",
        `${basename} requires an explicit BearHomeBot parser before activation`,
        entry.path,
      );
    }
  }

  return {
    workspacePackages: packageDirectories.size,
    lockedNodeModules,
    localWorkspaceLinks,
    registryArtifacts,
    entriesWithoutIntegrity,
    entriesWithInstallScripts,
    pythonRequirementFiles,
  };
}

export async function inspectCandidate(
  mirror: KSkillGitMirror,
  candidate: GitCandidate,
  previousSha: string | undefined,
  policy: KSkillPolicy,
  now: () => Date = () => new Date(),
): Promise<CandidateManifest> {
  if (previousSha && !(await mirror.isDescendant(previousSha, candidate.sha))) {
    throw new CandidateGateError(
      "history_non_fast_forward",
      "Candidate is not a descendant of the active release",
    );
  }

  const entries = await mirror.readTree(candidate.sha);
  if (entries.length > policy.limits.maxFiles) {
    throw new CandidateGateError(
      "file_count_limit",
      "Candidate exceeds the configured file count",
    );
  }

  let totalBytes = 0;
  let maximumBlobBytes = 0;
  let executableFiles = 0;
  const seenPaths = new Set<string>();
  for (const entry of entries) {
    validateTreePath(entry, policy);
    if (seenPaths.has(entry.path)) {
      throw new CandidateGateError(
        "invalid_path",
        "Candidate contains duplicate paths",
        entry.path,
      );
    }
    seenPaths.add(entry.path);
    const basename = posix.basename(entry.path);
    if (basename === ".gitmodules") {
      throw new CandidateGateError(
        "submodule",
        "Candidate contains .gitmodules",
        entry.path,
      );
    }
    if (basename === ".npmrc") {
      throw new CandidateGateError(
        "dependency_policy",
        "Candidate-controlled npm configuration is prohibited",
        entry.path,
      );
    }
    if (entry.type === "commit" || entry.mode === "160000") {
      throw new CandidateGateError(
        "submodule",
        "Candidate contains a Git submodule",
        entry.path,
      );
    }
    if (entry.mode === "120000") {
      throw new CandidateGateError(
        "symlink",
        "Candidate contains a symbolic link",
        entry.path,
      );
    }
    if (entry.mode !== "100644" && entry.mode !== "100755") {
      throw new CandidateGateError(
        "unsupported_file_mode",
        "Candidate contains an unsupported file mode",
        entry.path,
      );
    }
    if (entry.size === undefined) {
      throw new CandidateGateError(
        "unsupported_file_mode",
        "Candidate blob is missing a size",
        entry.path,
      );
    }
    if (entry.size > policy.limits.maxBlobBytes) {
      throw new CandidateGateError(
        "oversized_blob",
        "Candidate contains an oversized file",
        entry.path,
      );
    }
    totalBytes += entry.size;
    maximumBlobBytes = Math.max(maximumBlobBytes, entry.size);
    if (totalBytes > policy.limits.maxTotalBytes) {
      throw new CandidateGateError(
        "oversized_tree",
        "Candidate exceeds the configured total size",
      );
    }
    if (entry.mode === "100755") {
      executableFiles += 1;
    }
  }

  const dependencies = await inspectDependencies(mirror, entries, policy);
  const changedPaths = await mirror.changedPaths(previousSha, candidate.sha);
  const maximumChangedPaths = policy.codexReview.maxChangedPaths;
  if (changedPaths.length > maximumChangedPaths) {
    throw new CandidateGateError(
      "changed_path_limit",
      "Candidate changes exceed the maximum reviewable path count",
    );
  }

  const source: CandidateManifest["source"] = {
    url: policy.upstream.url,
    branch: policy.upstream.branch,
    sha: candidate.sha,
    treeSha: candidate.treeSha,
  };
  if (previousSha) {
    source.previousSha = previousSha;
  }
  return {
    schemaVersion: 1,
    source,
    tree: {
      fileCount: entries.length,
      totalBytes,
      maximumBlobBytes,
      executableFiles,
      packageJsonFiles: entries.filter(
        (entry) => posix.basename(entry.path) === "package.json",
      ).length,
    },
    dependencies,
    changes: {
      count: changedPaths.length,
      paths: changedPaths,
      truncated: false,
    },
    deterministicGates: {
      status: "passed",
      checkedAt: now().toISOString(),
    },
  };
}
