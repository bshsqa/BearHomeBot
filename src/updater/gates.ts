import { posix } from "node:path";

import {
  KSkillGitMirror,
  type GitCandidate,
  type GitTreeEntry,
} from "./git.js";
import type { KSkillPolicy } from "./policy.js";

export type CandidateGateErrorCode =
  | "file_count_limit"
  | "history_non_fast_forward"
  | "invalid_path"
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
  schemaVersion: 2;
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
  };
  changes: {
    count: number;
    paths: string[];
  };
  loaderSafety: {
    status: "passed";
    checkedAt: string;
  };
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

    if (posix.basename(entry.path) === ".gitmodules") {
      throw new CandidateGateError(
        "submodule",
        "Candidate contains .gitmodules",
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

  const changedPaths = await mirror.changedPaths(previousSha, candidate.sha);
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
    schemaVersion: 2,
    source,
    tree: {
      fileCount: entries.length,
      totalBytes,
      maximumBlobBytes,
      executableFiles,
    },
    changes: {
      count: changedPaths.length,
      paths: changedPaths,
    },
    loaderSafety: {
      status: "passed",
      checkedAt: now().toISOString(),
    },
  };
}
