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
  dependencies: {
    npmRegistry: string;
    pythonIndex: string;
    pythonWheels: Array<{
      name: string;
      version: string;
    }>;
    auditLevel: "high";
  };
  validation: {
    image: string;
    acquireTimeoutSeconds: number;
    testTimeoutSeconds: number;
    cpus: number;
    memory: string;
    pidsLimit: number;
  };
  codexReview: {
    required: boolean;
    timeoutSeconds: number;
    maxChangedPaths: number;
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
    [
      "schemaVersion",
      "upstream",
      "limits",
      "dependencies",
      "validation",
      "codexReview",
      "release",
    ],
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

  const dependencies = requireRecord(root.dependencies, "policy.dependencies");
  requireExactKeys(
    dependencies,
    ["npmRegistry", "pythonIndex", "pythonWheels", "auditLevel"],
    "policy.dependencies",
  );
  const npmRegistry = validateHttpsUrl(
    requireString(dependencies, "npmRegistry", "policy.dependencies"),
    "policy.dependencies.npmRegistry",
  );
  const pythonIndex = validateHttpsUrl(
    requireString(dependencies, "pythonIndex", "policy.dependencies"),
    "policy.dependencies.pythonIndex",
  );
  if (dependencies.auditLevel !== "high") {
    throw new Error("policy.dependencies.auditLevel must be high");
  }
  if (!Array.isArray(dependencies.pythonWheels)) {
    throw new Error("policy.dependencies.pythonWheels must be an array");
  }
  const pythonWheels = dependencies.pythonWheels.map((item, index) => {
    const wheel = requireRecord(
      item,
      `policy.dependencies.pythonWheels[${index}]`,
    );
    requireExactKeys(
      wheel,
      ["name", "version"],
      `policy.dependencies.pythonWheels[${index}]`,
    );
    const name = requireString(
      wheel,
      "name",
      `policy.dependencies.pythonWheels[${index}]`,
    );
    const version = requireString(
      wheel,
      "version",
      `policy.dependencies.pythonWheels[${index}]`,
    );
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(name) ||
      !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(version)
    ) {
      throw new Error(`policy.dependencies.pythonWheels[${index}] is invalid`);
    }
    return { name, version };
  });

  const validation = requireRecord(root.validation, "policy.validation");
  requireExactKeys(
    validation,
    [
      "image",
      "acquireTimeoutSeconds",
      "testTimeoutSeconds",
      "cpus",
      "memory",
      "pidsLimit",
    ],
    "policy.validation",
  );
  const image = requireString(validation, "image", "policy.validation");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/u.test(image)) {
    throw new Error("policy.validation.image has an invalid format");
  }
  const memory = requireString(validation, "memory", "policy.validation");
  if (!/^[1-9]\d*(?:[kmg])$/iu.test(memory)) {
    throw new Error("policy.validation.memory must use a k, m, or g suffix");
  }

  const codexReview = requireRecord(root.codexReview, "policy.codexReview");
  requireExactKeys(
    codexReview,
    ["required", "timeoutSeconds", "maxChangedPaths"],
    "policy.codexReview",
  );
  if (typeof codexReview.required !== "boolean") {
    throw new Error("policy.codexReview.required must be boolean");
  }

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
    dependencies: {
      npmRegistry,
      pythonIndex,
      pythonWheels,
      auditLevel: "high",
    },
    validation: {
      image,
      acquireTimeoutSeconds: requireInteger(
        validation,
        "acquireTimeoutSeconds",
        "policy.validation",
        10,
        7200,
      ),
      testTimeoutSeconds: requireInteger(
        validation,
        "testTimeoutSeconds",
        "policy.validation",
        10,
        7200,
      ),
      cpus: requireInteger(validation, "cpus", "policy.validation", 1, 64),
      memory,
      pidsLimit: requireInteger(
        validation,
        "pidsLimit",
        "policy.validation",
        16,
        32_768,
      ),
    },
    codexReview: {
      required: codexReview.required,
      timeoutSeconds: requireInteger(
        codexReview,
        "timeoutSeconds",
        "policy.codexReview",
        10,
        3600,
      ),
      maxChangedPaths: requireInteger(
        codexReview,
        "maxChangedPaths",
        "policy.codexReview",
        1,
        100_000,
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
