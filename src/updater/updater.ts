import type { CodexUsage } from "../codex/jsonl.js";
import { StateStore } from "../state/store.js";
import {
  CandidateGateError,
  inspectCandidate,
  type CandidateManifest,
} from "./gates.js";
import { KSkillGitMirror, type GitCandidate } from "./git.js";
import type { KSkillPolicy } from "./policy.js";
import { CommandError } from "./process.js";
import { KSkillReleaseManager } from "./release.js";
import type {
  BehaviorReviewExecution,
  CandidateBehaviorReview,
  SkillBehaviorReview,
} from "./reviewer.js";
import {
  buildReviewedCandidateManifest,
  discoverSkillReviewScopes,
  SKILL_SCOPE_VERSION,
  type ReviewedCandidateManifest,
  type SkillReviewScope,
} from "./skills.js";

export interface CandidateReviewerLike {
  review(
    candidateDirectory: string,
    scopes: readonly SkillReviewScope[],
    signal?: AbortSignal,
  ): Promise<BehaviorReviewExecution>;
}

export interface KSkillUpdateResult {
  status: "promoted" | "refreshed" | "unchanged";
  sha: string;
  releasePath: string;
  manifest: ReviewedCandidateManifest;
  review?: CandidateBehaviorReview;
}

export class KSkillUpdaterError extends Error {
  constructor(
    readonly code:
      "behavior_review_rejected" | "pipeline_failed" | "reviewer_unavailable",
    message: string,
    readonly review?: CandidateBehaviorReview,
  ) {
    super(message);
    this.name = "KSkillUpdaterError";
  }
}

function failureCode(error: unknown): string {
  if (error instanceof CandidateGateError) {
    return `gate.${error.code}`;
  }
  if (error instanceof CommandError) {
    return `command.${error.code}`;
  }
  if (error instanceof KSkillUpdaterError) {
    return error.code;
  }
  return "pipeline_failed";
}

function hasCurrentReviewPolicy(
  manifest: unknown,
  policy: KSkillPolicy,
): boolean {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return false;
  }
  const behaviorReview = (manifest as Record<string, unknown>).behaviorReview;
  return (
    Boolean(behaviorReview) &&
    typeof behaviorReview === "object" &&
    !Array.isArray(behaviorReview) &&
    (behaviorReview as Record<string, unknown>).scopeVersion ===
      SKILL_SCOPE_VERSION &&
    (behaviorReview as Record<string, unknown>).policyVersion ===
      policy.behaviorReview.policyVersion
  );
}

function cachedSkillReview(
  value: unknown,
  scope: SkillReviewScope,
): SkillBehaviorReview | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const review = value as Record<string, unknown>;
  if (
    review.skillId !== scope.skillId ||
    review.contentDigest !== scope.contentDigest ||
    (review.status !== "approved" &&
      review.status !== "rejected" &&
      review.status !== "uncertain") ||
    typeof review.summary !== "string" ||
    !Array.isArray(review.dataAccess) ||
    !Array.isArray(review.networkDestinations) ||
    !Array.isArray(review.findings)
  ) {
    return undefined;
  }
  return value as SkillBehaviorReview;
}

function mergeUsage(
  total: CodexUsage | undefined,
  next: CodexUsage | undefined,
): CodexUsage | undefined {
  if (!total && !next) {
    return undefined;
  }
  return {
    inputTokens: (total?.inputTokens ?? 0) + (next?.inputTokens ?? 0),
    cachedInputTokens:
      (total?.cachedInputTokens ?? 0) + (next?.cachedInputTokens ?? 0),
    outputTokens: (total?.outputTokens ?? 0) + (next?.outputTokens ?? 0),
  };
}

function summarizeReview(
  policyVersion: number,
  scopes: readonly SkillReviewScope[],
  results: Map<string, SkillBehaviorReview & { source: "reviewed" | "cache" }>,
  usage?: CodexUsage,
): CandidateBehaviorReview {
  const totalSkills = scopes.length;
  const skills = [...results.values()].sort((left, right) =>
    left.skillId.localeCompare(right.skillId, "en"),
  );
  const enabled = new Set(
    skills
      .filter((skill) => skill.status === "approved")
      .map((skill) => skill.skillId),
  );
  let dependencyExclusionFound = true;
  while (dependencyExclusionFound) {
    dependencyExclusionFound = false;
    for (const scope of scopes) {
      if (
        enabled.has(scope.skillId) &&
        scope.dependencies.some((dependency) => !enabled.has(dependency))
      ) {
        enabled.delete(scope.skillId);
        dependencyExclusionFound = true;
      }
    }
  }
  const enabledSkills = scopes
    .map((scope) => scope.skillId)
    .filter((skillId) => enabled.has(skillId))
    .sort((left, right) => left.localeCompare(right, "en"));
  const excludedSkills = scopes
    .map((scope) => scope.skillId)
    .filter((skillId) => !enabled.has(skillId))
    .sort((left, right) => left.localeCompare(right, "en"));
  const status =
    skills.length !== totalSkills || enabledSkills.length === 0
      ? "rejected"
      : excludedSkills.length > 0
        ? "approved_with_exclusions"
        : "approved";
  const reviewedSkills = skills
    .filter((skill) => skill.source === "reviewed")
    .map((skill) => skill.skillId);
  const reusedSkills = skills
    .filter((skill) => skill.source === "cache")
    .map((skill) => skill.skillId);
  const review: CandidateBehaviorReview = {
    status,
    summary:
      status === "approved"
        ? `${totalSkills} skill behavior scopes are approved; ${reviewedSkills.length} reviewed and ${reusedSkills.length} reused.`
        : status === "approved_with_exclusions"
          ? `${enabledSkills.length} skills are enabled and ${excludedSkills.length} are excluded; ${reviewedSkills.length} reviewed and ${reusedSkills.length} reused.`
          : `No releasable skill set is available; ${reviewedSkills.length} reviewed and ${reusedSkills.length} reused.`,
    policyVersion,
    totalSkills,
    reviewedSkills,
    reusedSkills,
    enabledSkills,
    excludedSkills,
    skills,
  };
  if (usage) {
    review.usage = usage;
  }
  return review;
}

export class KSkillUpdater {
  readonly #policy: KSkillPolicy;
  readonly #store: StateStore;
  readonly #mirror: KSkillGitMirror;
  readonly #releaseManager: KSkillReleaseManager;
  readonly #reviewer: CandidateReviewerLike | undefined;

  constructor(options: {
    policy: KSkillPolicy;
    store: StateStore;
    mirror: KSkillGitMirror;
    releaseManager: KSkillReleaseManager;
    reviewer?: CandidateReviewerLike;
  }) {
    this.#policy = options.policy;
    this.#store = options.store;
    this.#mirror = options.mirror;
    this.#releaseManager = options.releaseManager;
    this.#reviewer = options.reviewer;
  }

  async check(signal?: AbortSignal): Promise<{
    candidate: GitCandidate;
    manifest: CandidateManifest;
  }> {
    const candidate = await this.#mirror.fetchCandidate(signal);
    const active = this.#store.getKSkillActiveState();
    const manifest = await inspectCandidate(
      this.#mirror,
      candidate,
      active.activeSha,
      this.#policy,
    );
    return { candidate, manifest };
  }

  async update(signal?: AbortSignal): Promise<KSkillUpdateResult> {
    const candidate = await this.#mirror.fetchCandidate(signal);
    const state = this.#store.getKSkillActiveState();
    const refreshingActive = state.activeSha === candidate.sha;
    if (refreshingActive) {
      const active = this.#store.getKSkillRelease(candidate.sha);
      if (!active?.releasePath || !active.manifest) {
        throw new KSkillUpdaterError(
          "pipeline_failed",
          "Active k-skill release metadata is incomplete",
        );
      }
      if (hasCurrentReviewPolicy(active.manifest, this.#policy)) {
        this.#releaseManager.verifyRelease(active.releasePath, candidate.sha);
        return {
          status: "unchanged",
          sha: candidate.sha,
          releasePath: active.releasePath,
          manifest: active.manifest as ReviewedCandidateManifest,
        };
      }
    }

    if (!refreshingActive) {
      this.#store.recordKSkillCandidate({
        sha: candidate.sha,
        treeSha: candidate.treeSha,
        sourceUrl: this.#policy.upstream.url,
        sourceBranch: this.#policy.upstream.branch,
        manifest: { status: "pending" },
      });
    }

    let reviewDirectory: string | undefined;
    try {
      const baseManifest = await inspectCandidate(
        this.#mirror,
        candidate,
        state.activeSha,
        this.#policy,
      );
      reviewDirectory = await this.#releaseManager.createReviewDirectory(
        this.#mirror,
        candidate,
        signal,
      );
      const candidateReviewDirectory = reviewDirectory;
      const scopes = discoverSkillReviewScopes(candidateReviewDirectory);
      const activeManifest = state.activeSha
        ? this.#store.getKSkillRelease(state.activeSha)?.manifest
        : undefined;
      const manifest = buildReviewedCandidateManifest(
        baseManifest,
        scopes,
        activeManifest,
        this.#policy.behaviorReview.policyVersion,
      );
      if (!refreshingActive) {
        this.#store.recordKSkillCandidate({
          sha: candidate.sha,
          treeSha: candidate.treeSha,
          sourceUrl: this.#policy.upstream.url,
          sourceBranch: this.#policy.upstream.branch,
          manifest,
        });
      }

      const results = new Map<
        string,
        SkillBehaviorReview & { source: "reviewed" | "cache" }
      >();
      const pending: SkillReviewScope[] = [];
      for (const scope of scopes) {
        const stored = this.#store.getKSkillBehaviorReview(
          scope.skillId,
          scope.contentDigest,
          this.#policy.behaviorReview.policyVersion,
        );
        const cached = cachedSkillReview(stored?.review, scope);
        if (cached) {
          results.set(scope.skillId, { ...cached, source: "cache" });
        } else {
          pending.push(scope);
        }
      }

      let usage: CodexUsage | undefined;
      let review = summarizeReview(
        this.#policy.behaviorReview.policyVersion,
        scopes,
        results,
      );
      if (pending.length > 0 && !this.#reviewer) {
        throw new KSkillUpdaterError(
          "reviewer_unavailable",
          "Skill behavior reviewer is not configured",
        );
      }

      const batches: SkillReviewScope[][] = [];
      for (
        let index = 0;
        index < pending.length;
        index += this.#policy.behaviorReview.batchSize
      ) {
        batches.push(
          pending.slice(index, index + this.#policy.behaviorReview.batchSize),
        );
      }
      const executions: Array<BehaviorReviewExecution | undefined> = Array.from(
        { length: batches.length },
      );
      const failures: Array<{ batchIndex: number; error: unknown }> = [];
      let nextBatchIndex = 0;
      let stopScheduling = false;
      const reviewNextBatch = async (): Promise<void> => {
        while (!stopScheduling) {
          const batchIndex = nextBatchIndex;
          nextBatchIndex += 1;
          const batch = batches[batchIndex];
          if (!batch) {
            return;
          }
          try {
            const execution = await this.#reviewer!.review(
              candidateReviewDirectory,
              batch,
              signal,
            );
            for (const reviewed of execution.reviews) {
              this.#store.recordKSkillBehaviorReview({
                skillId: reviewed.skillId,
                contentDigest: reviewed.contentDigest,
                policyVersion: this.#policy.behaviorReview.policyVersion,
                sourceSha: candidate.sha,
                review: reviewed,
              });
            }
            executions[batchIndex] = execution;
          } catch (error) {
            failures.push({ batchIndex, error });
            stopScheduling = true;
          }
        }
      };
      await Promise.all(
        Array.from(
          {
            length: Math.min(
              batches.length,
              this.#policy.behaviorReview.maxConcurrency,
            ),
          },
          reviewNextBatch,
        ),
      );
      if (failures.length > 0) {
        failures.sort((left, right) => left.batchIndex - right.batchIndex);
        throw failures[0]!.error;
      }
      for (const execution of executions) {
        if (!execution) {
          throw new Error("Skill behavior review batch result is missing");
        }
        usage = mergeUsage(usage, execution.usage);
        for (const reviewed of execution.reviews) {
          results.set(reviewed.skillId, {
            ...reviewed,
            source: "reviewed",
          });
        }
      }

      review = summarizeReview(
        this.#policy.behaviorReview.policyVersion,
        scopes,
        results,
        usage,
      );
      if (review.status === "rejected") {
        throw new KSkillUpdaterError(
          "behavior_review_rejected",
          "Skill behavior review did not produce an approved skill set",
          review,
        );
      }

      this.#releaseManager.removeReviewDirectory(reviewDirectory);
      reviewDirectory = undefined;
      const release = await this.#releaseManager.finalizeRelease(
        this.#mirror,
        candidate,
        manifest,
        review,
        signal,
      );
      this.#releaseManager.verifyRelease(release.path, candidate.sha);
      if (refreshingActive) {
        this.#store.refreshActiveKSkillRelease({
          sha: candidate.sha,
          releasePath: release.path,
          manifest,
          review,
        });
      } else {
        this.#store.markKSkillCandidateValidated({
          sha: candidate.sha,
          releasePath: release.path,
          review,
        });
        this.#store.promoteKSkillRelease(candidate.sha);
      }
      return {
        status: refreshingActive ? "refreshed" : "promoted",
        sha: candidate.sha,
        releasePath: release.path,
        manifest,
        review,
      };
    } catch (error) {
      const current = this.#store.getKSkillRelease(candidate.sha);
      if (current && current.status !== "active") {
        this.#store.rejectKSkillCandidate(
          candidate.sha,
          failureCode(error),
          error instanceof KSkillUpdaterError ? error.review : undefined,
        );
      }
      throw error;
    } finally {
      if (reviewDirectory) {
        this.#releaseManager.removeReviewDirectory(reviewDirectory);
      }
    }
  }

  rollback(sha?: string): {
    sha: string;
    releasePath: string;
  } {
    const state = this.#store.getKSkillActiveState();
    const targetSha = sha ?? state.previousSha;
    if (!targetSha) {
      throw new Error("No previous k-skill release is available");
    }
    const target = this.#store.getKSkillRelease(targetSha);
    if (!target?.releasePath) {
      throw new Error("Rollback target has no release path");
    }
    this.#releaseManager.verifyRelease(target.releasePath, targetSha);
    const active = this.#store.rollbackKSkillRelease(targetSha);
    return {
      sha: active.sha,
      releasePath: active.releasePath ?? target.releasePath,
    };
  }
}
