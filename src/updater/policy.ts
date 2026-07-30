import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface KSkillPolicy {
  schemaVersion: 1;
  upstream: {
    url: string;
    branch: string;
  };
  limits: {
    maxFiles: number;
    maxBlobBytes: number;
    maxTotalBytes: number;
    maxPathBytes: number;
    maxSegmentBytes: number;
  };
  behaviorReview: {
    policyVersion: number;
    timeoutSeconds: number;
    batchSize: number;
    maxConcurrency: number;
  };
  release: {
    minimumRetained: number;
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function requireInteger(
  record: Record<string, unknown>,
  key: string,
  label: string,
  minimum: number,
  maximum: number,
): number {
  const value = record[key];
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(
      `${label}.${key} must be an integer from ${minimum} to ${maximum}`,
    );
  }
  return value as number;
}

function requireExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) {
      throw new Error(`${label}.${key} is not supported`);
    }
  }
  for (const key of keys) {
    if (!(key in record)) {
      throw new Error(`${label}.${key} is required`);
    }
  }
}

function validateHttpsUrl(value: string, label: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be a credential-free HTTPS URL`);
  }
  return url.toString();
}

function parsePolicy(value: unknown): KSkillPolicy {
  const root = requireRecord(value, "policy");
  requireExactKeys(
    root,
    ["schemaVersion", "upstream", "limits", "behaviorReview", "release"],
    "policy",
  );
  if (root.schemaVersion !== 1) {
    throw new Error("policy.schemaVersion must be 1");
  }

  const upstream = requireRecord(root.upstream, "policy.upstream");
  requireExactKeys(upstream, ["url", "branch"], "policy.upstream");
  const upstreamUrl = validateHttpsUrl(
    requireString(upstream, "url", "policy.upstream"),
    "policy.upstream.url",
  );
  const branch = requireString(upstream, "branch", "policy.upstream");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u.test(branch)) {
    throw new Error("policy.upstream.branch has an invalid format");
  }

  const limits = requireRecord(root.limits, "policy.limits");
  requireExactKeys(
    limits,
    [
      "maxFiles",
      "maxBlobBytes",
      "maxTotalBytes",
      "maxPathBytes",
      "maxSegmentBytes",
    ],
    "policy.limits",
  );

  const behaviorReview = requireRecord(
    root.behaviorReview,
    "policy.behaviorReview",
  );
  requireExactKeys(
    behaviorReview,
    ["policyVersion", "timeoutSeconds", "batchSize", "maxConcurrency"],
    "policy.behaviorReview",
  );

  const release = requireRecord(root.release, "policy.release");
  requireExactKeys(release, ["minimumRetained"], "policy.release");

  return {
    schemaVersion: 1,
    upstream: {
      url: upstreamUrl,
      branch,
    },
    limits: {
      maxFiles: requireInteger(limits, "maxFiles", "policy.limits", 1, 100_000),
      maxBlobBytes: requireInteger(
        limits,
        "maxBlobBytes",
        "policy.limits",
        1,
        1024 * 1024 * 1024,
      ),
      maxTotalBytes: requireInteger(
        limits,
        "maxTotalBytes",
        "policy.limits",
        1,
        10 * 1024 * 1024 * 1024,
      ),
      maxPathBytes: requireInteger(
        limits,
        "maxPathBytes",
        "policy.limits",
        1,
        16_384,
      ),
      maxSegmentBytes: requireInteger(
        limits,
        "maxSegmentBytes",
        "policy.limits",
        1,
        1024,
      ),
    },
    behaviorReview: {
      policyVersion: requireInteger(
        behaviorReview,
        "policyVersion",
        "policy.behaviorReview",
        1,
        1_000_000,
      ),
      timeoutSeconds: requireInteger(
        behaviorReview,
        "timeoutSeconds",
        "policy.behaviorReview",
        10,
        3600,
      ),
      batchSize: requireInteger(
        behaviorReview,
        "batchSize",
        "policy.behaviorReview",
        1,
        25,
      ),
      maxConcurrency: requireInteger(
        behaviorReview,
        "maxConcurrency",
        "policy.behaviorReview",
        1,
        16,
      ),
    },
    release: {
      minimumRetained: requireInteger(
        release,
        "minimumRetained",
        "policy.release",
        1,
        100,
      ),
    },
  };
}

export function defaultKSkillPolicyPath(): string {
  return fileURLToPath(
    new URL("../../config/k-skill-policy.json", import.meta.url),
  );
}

export function loadKSkillPolicy(
  path = defaultKSkillPolicyPath(),
): KSkillPolicy {
  const text = readFileSync(path, "utf8");
  return parsePolicy(JSON.parse(text) as unknown);
}
