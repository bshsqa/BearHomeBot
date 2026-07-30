import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, posix, resolve } from "node:path";

import type { CandidateManifest } from "./gates.js";

const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
export const SKILL_SCOPE_VERSION = 3;

export interface SkillReviewScope {
  skillId: string;
  contentDigest: string;
  files: string[];
  dependencies: string[];
}

export interface SkillInventoryItem {
  skillId: string;
  contentDigest: string;
  fileCount: number;
  dependencies: string[];
}

export interface BehaviorReviewPlan {
  scopeVersion: typeof SKILL_SCOPE_VERSION;
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

function containsExactReference(
  text: string,
  reference: string,
  allowSubpath = false,
): boolean {
  let index = text.indexOf(reference);
  while (index !== -1) {
    const before = index === 0 ? "" : text[index - 1]!;
    const after =
      index + reference.length === text.length
        ? ""
        : text[index + reference.length]!;
    if (
      (!before || !/[A-Za-z0-9@/._+-]/u.test(before)) &&
      (!after ||
        !/[A-Za-z0-9@/._+-]/u.test(after) ||
        (allowSubpath && after === "/"))
    ) {
      return true;
    }
    index = text.indexOf(reference, index + reference.length);
  }
  return false;
}

function containsExactIdentifier(text: string, identifier: string): boolean {
  let index = text.indexOf(identifier);
  while (index !== -1) {
    const before = index === 0 ? "" : text[index - 1]!;
    const after =
      index + identifier.length === text.length
        ? ""
        : text[index + identifier.length]!;
    if (
      (!before || !/[A-Za-z0-9._-]/u.test(before)) &&
      (!after || !/[A-Za-z0-9._-]/u.test(after))
    ) {
      return true;
    }
    index = text.indexOf(identifier, index + identifier.length);
  }
  return false;
}

function referencedPaths(
  sourcePath: string,
  skillId: string,
  text: string,
): Set<string> {
  const references = new Set<string>();
  const pattern =
    /(?:\.{1,2}|[A-Za-z0-9@._+-]+)(?:\/(?:\.{1,2}|[A-Za-z0-9@._+-]+))+/gu;
  for (const match of text.matchAll(pattern)) {
    const reference = match[0];
    const candidates = reference.startsWith(".")
      ? [
          posix.join(posix.dirname(sourcePath), reference),
          posix.join(skillId, reference),
        ]
      : [
          reference,
          posix.join(posix.dirname(sourcePath), reference),
          posix.join(skillId, reference),
        ];
    for (const candidate of candidates) {
      const normalized = posix.normalize(candidate);
      if (
        normalized !== "." &&
        !posix.isAbsolute(normalized) &&
        normalized !== ".." &&
        !normalized.startsWith("../")
      ) {
        references.add(normalized);
      }
    }
  }
  return references;
}

function searchableText(
  root: string,
  path: string,
  cache: Map<string, string | undefined>,
): string | undefined {
  if (cache.has(path)) {
    return cache.get(path);
  }
  const content = readFileSync(join(root, path));
  const text = content.includes(0) ? undefined : content.toString("utf8");
  cache.set(path, text);
  return text;
}

function isSkillRuntimeImplementation(path: string, skillId: string): boolean {
  if (!path.startsWith(`${skillId}/`)) {
    return false;
  }
  const relative = path.slice(skillId.length + 1);
  return (
    relative !== "SKILL.md" &&
    !relative.startsWith("tests/") &&
    !relative.startsWith("test/") &&
    !/(?:^|\/)test_[^/]+$/u.test(relative) &&
    !/(?:^|\/)[^/]+\.test\.[^/]+$/u.test(relative) &&
    !/\.(?:md|txt|hwp|hwpx|pdf|html|csv)$/iu.test(relative)
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
  roots: Map<string, boolean>,
  hardReachable: boolean,
): void {
  const existingStrength = roots.get(packageRoot);
  if (existingStrength === true || existingStrength === hardReachable) {
    return;
  }
  roots.set(packageRoot, hardReachable);
  for (const dependency of localPackageDependencies(
    root,
    packageRoot,
    knownPackages,
  )) {
    addPackageTree(root, dependency, knownPackages, roots, hardReachable);
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

  const skillIdSet = new Set(skillIds);
  const knownPackages = packageNames(root, files);
  const knownPackageRoots = new Set(knownPackages.values());
  const fileSet = new Set(files);
  const textCache = new Map<string, string | undefined>();
  return skillIds.map((skillId) => {
    const roots = new Map<string, boolean>([[skillId, true]]);
    const dependencies = new Set<string>();
    const explicitlyReferencedFiles = new Map<string, boolean>();
    const addSkillScope = (
      relatedSkillId: string,
      hardDependency: boolean,
    ): void => {
      if (relatedSkillId === skillId) {
        return;
      }
      if (hardDependency) {
        dependencies.add(relatedSkillId);
      }
      const existingStrength = roots.get(relatedSkillId);
      if (existingStrength !== true) {
        roots.set(relatedSkillId, hardDependency);
      }
      const relatedPackage = `packages/${relatedSkillId}`;
      if (files.some((path) => path.startsWith(`${relatedPackage}/`))) {
        addPackageTree(
          root,
          relatedPackage,
          knownPackages,
          roots,
          hardDependency,
        );
      }
    };
    const addExplicitFile = (path: string, hardReachable: boolean): void => {
      const existingStrength = explicitlyReferencedFiles.get(path);
      if (existingStrength !== true) {
        explicitlyReferencedFiles.set(path, hardReachable);
      }
    };
    const pairedPackage = `packages/${skillId}`;
    if (files.some((path) => path.startsWith(`${pairedPackage}/`))) {
      addPackageTree(root, pairedPackage, knownPackages, roots, true);
    }

    const scannedFiles = new Map<string, boolean>();
    let scopeFiles: string[] = [];
    while (true) {
      const strengthByFile = new Map<string, boolean>();
      scopeFiles = files.filter((path) => {
        let included = false;
        let hardReachable = false;
        if (explicitlyReferencedFiles.has(path)) {
          included = true;
          hardReachable = explicitlyReferencedFiles.get(path) === true;
        }
        for (const [scopeRoot, rootIsHardReachable] of roots) {
          if (path === scopeRoot || path.startsWith(`${scopeRoot}/`)) {
            included = true;
            hardReachable ||= rootIsHardReachable;
          }
        }
        if (included) {
          strengthByFile.set(path, hardReachable);
        }
        return included;
      });
      const pendingFiles = scopeFiles.filter((path) => {
        const currentStrength = strengthByFile.get(path) === true;
        const scannedStrength = scannedFiles.get(path);
        return (
          scannedStrength === undefined || (!scannedStrength && currentStrength)
        );
      });
      if (pendingFiles.length === 0) {
        break;
      }
      for (const path of pendingFiles) {
        const hardReachable = strengthByFile.get(path) === true;
        scannedFiles.set(path, hardReachable);
        const text = searchableText(root, path, textCache);
        if (text === undefined) {
          continue;
        }
        const sourceSkillId = path.split("/", 1)[0]!;
        const canDeclareHardDependency =
          hardReachable &&
          skillIdSet.has(sourceSkillId) &&
          (sourceSkillId === skillId || dependencies.has(sourceSkillId)) &&
          isSkillRuntimeImplementation(path, sourceSkillId);
        const pathReferences = referencedPaths(path, skillId, text);
        for (const reference of pathReferences) {
          if (fileSet.has(reference)) {
            addExplicitFile(reference, hardReachable);
          }
          const referencedSkillId = reference.split("/", 1)[0]!;
          if (
            referencedSkillId !== sourceSkillId &&
            skillIdSet.has(referencedSkillId)
          ) {
            addSkillScope(referencedSkillId, canDeclareHardDependency);
          }
          for (const packageRoot of knownPackageRoots) {
            if (
              reference === packageRoot ||
              reference.startsWith(`${packageRoot}/`)
            ) {
              addPackageTree(
                root,
                packageRoot,
                knownPackages,
                roots,
                hardReachable,
              );
            }
          }
        }
        for (const [packageName, packageRoot] of knownPackages) {
          if (
            containsExactReference(text, packageName, true) ||
            containsExactReference(text, packageRoot, true)
          ) {
            addPackageTree(
              root,
              packageRoot,
              knownPackages,
              roots,
              hardReachable,
            );
          }
        }
        if (sourceSkillId === skillId || dependencies.has(sourceSkillId)) {
          for (const relatedSkillId of skillIds) {
            if (
              relatedSkillId !== sourceSkillId &&
              containsExactIdentifier(text, relatedSkillId)
            ) {
              addSkillScope(relatedSkillId, canDeclareHardDependency);
            }
          }
        }
      }
    }
    scopeFiles.sort((left, right) => left.localeCompare(right, "en"));

    return {
      skillId,
      contentDigest: digestScope(root, skillId, scopeFiles),
      files: scopeFiles,
      dependencies: [...dependencies].sort((left, right) =>
        left.localeCompare(right, "en"),
      ),
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
      (record.fileCount as number) < 1 ||
      (record.dependencies !== undefined &&
        (!Array.isArray(record.dependencies) ||
          record.dependencies.some(
            (dependency) =>
              typeof dependency !== "string" ||
              !SKILL_ID_PATTERN.test(dependency),
          )))
    ) {
      return undefined;
    }
    result.set(record.skillId, {
      skillId: record.skillId,
      contentDigest: record.contentDigest,
      fileCount: record.fileCount as number,
      dependencies: (record.dependencies as string[] | undefined) ?? [],
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
      scopeVersion: SKILL_SCOPE_VERSION,
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
        dependencies: scope.dependencies,
      })),
    },
  };
}
