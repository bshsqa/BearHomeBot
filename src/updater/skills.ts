import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";

import type { CandidateManifest } from "./gates.js";

const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface SkillReviewScope {
  skillId: string;
  contentDigest: string;
  files: string[];
}

export interface SkillInventoryItem {
  skillId: string;
  contentDigest: string;
  fileCount: number;
}

export interface BehaviorReviewPlan {
  policyVersion: number;
  initialBaseline: boolean;
  totalSkills: number;
  added: string[];
  changed: string[];
  unchanged: string[];
  removed: string[];
  inventory: SkillInventoryItem[];
}

export type ReviewedCandidateManifest = CandidateManifest & {
  behaviorReview: BehaviorReviewPlan;
};

function listFiles(root: string): string[] {
  const files: string[] = [];

  const visit = (directory: string, relativeDirectory: string): void => {
    for (const child of readdirSync(directory).sort((left, right) =>
      left.localeCompare(right, "en"),
    )) {
      const relative = relativeDirectory
        ? `${relativeDirectory}/${child}`
        : child;
      const absolute = join(directory, child);
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) {
        visit(absolute, relative);
      } else if (stat.isFile()) {
        if (relative !== ".bearhomebot-release.json") {
          files.push(relative);
        }
      } else {
        throw new Error("Candidate contains an unsupported filesystem entry");
      }
    }
  };

  visit(root, "");
  return files;
}

function referencedBySkill(
  skillText: string,
  skillId: string,
  path: string,
): boolean {
  const relative = posix.relative(skillId, path);
  return (
    skillText.includes(path) ||
    skillText.includes(relative) ||
    skillText.includes(`./${relative}`)
  );
}

function packageNames(
  root: string,
  files: readonly string[],
): Map<string, string> {
  const names = new Map<string, string>();
  for (const path of files) {
    const match = /^packages\/([^/]+)\/package\.json$/u.exec(path);
    if (!match?.[1]) {
      continue;
    }
    try {
      const parsed = JSON.parse(
        readFileSync(join(root, path), "utf8"),
      ) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        typeof (parsed as Record<string, unknown>).name === "string"
      ) {
        names.set((parsed as { name: string }).name, `packages/${match[1]}`);
      }
    } catch {
      // Malformed package metadata remains in the scope for behavioral review.
    }
  }
  return names;
}

function localPackageDependencies(
  root: string,
  packageRoot: string,
  knownPackages: ReadonlyMap<string, string>,
): string[] {
  const manifest = join(root, packageRoot, "package.json");
  if (!existsSync(manifest)) {
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return [];
    }
    const record = parsed as Record<string, unknown>;
    const dependencies = [
      record.dependencies,
      record.optionalDependencies,
      record.peerDependencies,
    ];
    const roots = new Set<string>();
    for (const value of dependencies) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        continue;
      }
      for (const name of Object.keys(value)) {
        const dependencyRoot = knownPackages.get(name);
        if (dependencyRoot) {
          roots.add(dependencyRoot);
        }
      }
    }
    return [...roots];
  } catch {
    return [];
  }
}

function addPackageTree(
  root: string,
  packageRoot: string,
  knownPackages: ReadonlyMap<string, string>,
  roots: Set<string>,
): void {
  if (roots.has(packageRoot)) {
    return;
  }
  roots.add(packageRoot);
  for (const dependency of localPackageDependencies(
    root,
    packageRoot,
    knownPackages,
  )) {
    addPackageTree(root, dependency, knownPackages, roots);
  }
}

function digestScope(
  root: string,
  skillId: string,
  files: readonly string[],
): string {
  const hash = createHash("sha256");
  hash.update(`bearhomebot-skill-behavior-v1\0${skillId}\0`);
  for (const path of files) {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    hash.update(
      `${path}\0${stat.mode & 0o111 ? "executable" : "regular"}\0${stat.size}\0`,
    );
    hash.update(readFileSync(absolute));
  }
  return hash.digest("hex");
}

export function discoverSkillReviewScopes(
  candidateDirectory: string,
): SkillReviewScope[] {
  const root = resolve(candidateDirectory);
  const files = listFiles(root);
  const skillIds = files
    .map((path) => /^([^/]+)\/SKILL\.md$/u.exec(path)?.[1])
    .filter((value): value is string => value !== undefined)
    .filter((value) => SKILL_ID_PATTERN.test(value))
    .sort((left, right) => left.localeCompare(right, "en"));

  if (skillIds.length === 0) {
    throw new Error("Candidate does not contain any top-level skills");
  }

  const knownPackages = packageNames(root, files);
  return skillIds.map((skillId) => {
    const skillText = readFileSync(join(root, skillId, "SKILL.md"), "utf8");
    const roots = new Set<string>([skillId]);
    const pairedPackage = `packages/${skillId}`;
    if (files.some((path) => path.startsWith(`${pairedPackage}/`))) {
      addPackageTree(root, pairedPackage, knownPackages, roots);
    }

    for (const packageRoot of new Set(knownPackages.values())) {
      if (
        skillText.includes(packageRoot) ||
        skillText.includes(posix.relative(skillId, packageRoot))
      ) {
        addPackageTree(root, packageRoot, knownPackages, roots);
      }
    }

    const scopeFiles = files
      .filter(
        (path) =>
          [...roots].some(
            (scopeRoot) =>
              path === scopeRoot || path.startsWith(`${scopeRoot}/`),
          ) || referencedBySkill(skillText, skillId, path),
      )
      .sort((left, right) => left.localeCompare(right, "en"));

    return {
      skillId,
      contentDigest: digestScope(root, skillId, scopeFiles),
      files: scopeFiles,
    };
  });
}

function priorInventory(
  manifest: unknown,
): Map<string, SkillInventoryItem> | undefined {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return undefined;
  }
  const review = (manifest as Record<string, unknown>).behaviorReview;
  if (!review || typeof review !== "object" || Array.isArray(review)) {
    return undefined;
  }
  const inventory = (review as Record<string, unknown>).inventory;
  if (!Array.isArray(inventory)) {
    return undefined;
  }

  const result = new Map<string, SkillInventoryItem>();
  for (const item of inventory) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return undefined;
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record.skillId !== "string" ||
      !SKILL_ID_PATTERN.test(record.skillId) ||
      typeof record.contentDigest !== "string" ||
      !/^[0-9a-f]{64}$/u.test(record.contentDigest) ||
      !Number.isSafeInteger(record.fileCount) ||
      (record.fileCount as number) < 1
    ) {
      return undefined;
    }
    result.set(record.skillId, {
      skillId: record.skillId,
      contentDigest: record.contentDigest,
      fileCount: record.fileCount as number,
    });
  }
  return result;
}

export function buildReviewedCandidateManifest(
  manifest: CandidateManifest,
  scopes: readonly SkillReviewScope[],
  previousManifest: unknown,
  policyVersion: number,
): ReviewedCandidateManifest {
  const previous = priorInventory(previousManifest);
  const current = new Map(scopes.map((scope) => [scope.skillId, scope]));
  const added: string[] = [];
  const changed: string[] = [];
  const unchanged: string[] = [];

  for (const scope of scopes) {
    const old = previous?.get(scope.skillId);
    if (!old) {
      added.push(scope.skillId);
    } else if (old.contentDigest === scope.contentDigest) {
      unchanged.push(scope.skillId);
    } else {
      changed.push(scope.skillId);
    }
  }

  const removed = previous
    ? [...previous.keys()]
        .filter((skillId) => !current.has(skillId))
        .sort((left, right) => left.localeCompare(right, "en"))
    : [];

  return {
    ...manifest,
    behaviorReview: {
      policyVersion,
      initialBaseline: previous === undefined,
      totalSkills: scopes.length,
      added,
      changed,
      unchanged,
      removed,
      inventory: scopes.map((scope) => ({
        skillId: scope.skillId,
        contentDigest: scope.contentDigest,
        fileCount: scope.files.length,
      })),
    },
  };
}
