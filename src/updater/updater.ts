import { join } from "node:path";

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
import type { CodexReviewResult } from "./reviewer.js";
import type { CandidateValidationResult } from "./validator.js";

export interface CandidateValidatorLike {
  validate(
    candidateDirectory: string,
    cacheDirectory: string,
    signal?: AbortSignal,
  ): Promise<CandidateValidationResult>;
}

export interface CandidateReviewerLike {
  review(
    candidateDirectory: string,
    manifest: CandidateManifest,
    signal?: AbortSignal,
  ): Promise<CodexReviewResult>;
}

export interface KSkillUpdateResult {
  status: "promoted" | "unchanged";
  sha: string;
  releasePath: string;
  manifest: CandidateManifest;
  validation?: CandidateValidationResult;
  review?: CodexReviewResult;
}

export class KSkillUpdaterError extends Error {
  constructor(
    readonly code:
      | "codex_review_rejected"
      | "pipeline_failed"
      | "reviewer_unavailable"
      | "validator_unavailable",
    message: string,
    readonly review?: CodexReviewResult,
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

export class KSkillUpdater {
  readonly #policy: KSkillPolicy;
  readonly #store: StateStore;
  readonly #mirror: KSkillGitMirror;
  readonly #releaseManager: KSkillReleaseManager;
  readonly #cacheRoot: string;
  readonly #validator: CandidateValidatorLike | undefined;
  readonly #reviewer: CandidateReviewerLike | undefined;

  constructor(options: {
    policy: KSkillPolicy;
    store: StateStore;
    mirror: KSkillGitMirror;
    releaseManager: KSkillReleaseManager;
    cacheRoot: string;
    validator?: CandidateValidatorLike;
    reviewer?: CandidateReviewerLike;
  }) {
    this.#policy = options.policy;
    this.#store = options.store;
    this.#mirror = options.mirror;
    this.#releaseManager = options.releaseManager;
    this.#cacheRoot = options.cacheRoot;
    this.#validator = options.validator;
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
    if (state.activeSha === candidate.sha) {
      const active = this.#store.getKSkillRelease(candidate.sha);
      if (!active?.releasePath || !active.manifest) {
        throw new KSkillUpdaterError(
          "pipeline_failed",
          "Active k-skill release metadata is incomplete",
        );
      }
      this.#releaseManager.verifyRelease(active.releasePath, candidate.sha);
      return {
        status: "unchanged",
        sha: candidate.sha,
        releasePath: active.releasePath,
        manifest: active.manifest as CandidateManifest,
      };
    }

    this.#store.recordKSkillCandidate({
      sha: candidate.sha,
      treeSha: candidate.treeSha,
      sourceUrl: this.#policy.upstream.url,
      sourceBranch: this.#policy.upstream.branch,
      manifest: { status: "pending" },
    });
    let validationDirectory: string | undefined;
    try {
      const manifest = await inspectCandidate(
        this.#mirror,
        candidate,
        state.activeSha,
        this.#policy,
      );
      this.#store.recordKSkillCandidate({
        sha: candidate.sha,
        treeSha: candidate.treeSha,
        sourceUrl: this.#policy.upstream.url,
        sourceBranch: this.#policy.upstream.branch,
        manifest,
      });

      if (!this.#validator) {
        throw new KSkillUpdaterError(
          "validator_unavailable",
          "Candidate validator is not configured",
        );
      }
      validationDirectory =
        await this.#releaseManager.createValidationDirectory(
          this.#mirror,
          candidate,
          signal,
        );
      const validation = await this.#validator.validate(
        validationDirectory,
        join(this.#cacheRoot, candidate.sha),
        signal,
      );

      let review: CodexReviewResult;
      if (this.#policy.codexReview.required) {
        if (!this.#reviewer) {
          throw new KSkillUpdaterError(
            "reviewer_unavailable",
            "Codex candidate reviewer is not configured",
          );
        }
        review = await this.#reviewer.review(
          validationDirectory,
          manifest,
          signal,
        );
        if (review.status !== "approved") {
          throw new KSkillUpdaterError(
            "codex_review_rejected",
            "Codex review did not approve the candidate",
            review,
          );
        }
      } else {
        review = {
          status: "approved",
          summary: "Codex review is disabled by version-controlled policy.",
          findings: [],
        };
      }

      this.#releaseManager.removeValidationDirectory(validationDirectory);
      validationDirectory = undefined;
      const release = await this.#releaseManager.finalizeRelease(
        this.#mirror,
        candidate,
        manifest,
        validation,
        review,
        signal,
      );
      this.#releaseManager.verifyRelease(release.path, candidate.sha);
      this.#store.markKSkillCandidateValidated({
        sha: candidate.sha,
        releasePath: release.path,
        validation,
        review,
      });
      this.#store.promoteKSkillRelease(candidate.sha);
      return {
        status: "promoted",
        sha: candidate.sha,
        releasePath: release.path,
        manifest,
        validation,
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
      if (validationDirectory) {
        this.#releaseManager.removeValidationDirectory(validationDirectory);
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
