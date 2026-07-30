import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export interface RuntimePaths {
  configDir: string;
  dataDir: string;
  cacheDir: string;
  stateDatabase: string;
  codexWorkspace: string;
  kSkillRoot: string;
  kSkillMirror: string;
  kSkillValidationRoot: string;
  kSkillCache: string;
  kSkillReviewWorkspace: string;
  kSkillUpdateLock: string;
  releaseRoot: string;
}

export interface RuntimePathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

function absolutePath(value: string, label: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path`);
  }

  return resolve(value);
}

function configuredDirectory(
  env: NodeJS.ProcessEnv,
  overrideName: string,
  xdgName: string,
  fallback: string,
): string {
  const override = env[overrideName];
  if (override) {
    return absolutePath(override, overrideName);
  }

  const xdgBase = env[xdgName];
  if (xdgBase) {
    return join(absolutePath(xdgBase, xdgName), "bearhomebot");
  }

  return fallback;
}

export function resolveRuntimePaths(
  options: RuntimePathOptions = {},
): RuntimePaths {
  const env = options.env ?? process.env;
  const home = absolutePath(options.homeDir ?? homedir(), "homeDir");

  const configDir = configuredDirectory(
    env,
    "BEARHOMEBOT_CONFIG_DIR",
    "XDG_CONFIG_HOME",
    join(home, ".config", "bearhomebot"),
  );
  const dataDir = configuredDirectory(
    env,
    "BEARHOMEBOT_DATA_DIR",
    "XDG_DATA_HOME",
    join(home, ".local", "share", "bearhomebot"),
  );
  const cacheDir = configuredDirectory(
    env,
    "BEARHOMEBOT_CACHE_DIR",
    "XDG_CACHE_HOME",
    join(home, ".cache", "bearhomebot"),
  );
  const kSkillRoot = join(dataDir, "k-skill");

  return {
    configDir,
    dataDir,
    cacheDir,
    stateDatabase: join(dataDir, "state.sqlite"),
    codexWorkspace: join(dataDir, "codex-workspace"),
    kSkillRoot,
    kSkillMirror: join(kSkillRoot, "mirror.git"),
    kSkillValidationRoot: join(kSkillRoot, "validation"),
    kSkillCache: join(cacheDir, "k-skill"),
    kSkillReviewWorkspace: join(kSkillRoot, "review-workspace"),
    kSkillUpdateLock: join(kSkillRoot, "update.lock"),
    releaseRoot: join(kSkillRoot, "releases"),
  };
}

export async function ensureRuntimeDirectories(
  paths: RuntimePaths,
): Promise<void> {
  await Promise.all(
    [
      paths.configDir,
      paths.dataDir,
      paths.cacheDir,
      paths.codexWorkspace,
      paths.kSkillRoot,
      paths.kSkillValidationRoot,
      paths.kSkillCache,
      paths.kSkillReviewWorkspace,
      paths.releaseRoot,
    ].map(async (directory) => {
      await mkdir(directory, { recursive: true, mode: 0o700 });
    }),
  );
}
