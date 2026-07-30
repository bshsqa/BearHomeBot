import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";

import { resolveRuntimePaths } from "../src/runtime-paths.js";

test("uses XDG directories outside the project checkout", () => {
  const paths = resolveRuntimePaths({
    env: {
      XDG_CONFIG_HOME: "/tmp/bearhomebot-test/config",
      XDG_DATA_HOME: "/tmp/bearhomebot-test/data",
      XDG_CACHE_HOME: "/tmp/bearhomebot-test/cache",
    },
    homeDir: "/home/example",
  });

  assert.equal(paths.configDir, "/tmp/bearhomebot-test/config/bearhomebot");
  assert.equal(paths.dataDir, "/tmp/bearhomebot-test/data/bearhomebot");
  assert.equal(paths.cacheDir, "/tmp/bearhomebot-test/cache/bearhomebot");
  assert.equal(paths.stateDatabase, join(paths.dataDir, "state.sqlite"));
  assert.equal(paths.releaseRoot, join(paths.dataDir, "k-skill", "releases"));
});

test("prefers explicit BearHomeBot directory overrides", () => {
  const paths = resolveRuntimePaths({
    env: {
      BEARHOMEBOT_CONFIG_DIR: "/srv/bearhomebot/config",
      BEARHOMEBOT_DATA_DIR: "/srv/bearhomebot/data",
      BEARHOMEBOT_CACHE_DIR: "/srv/bearhomebot/cache",
      XDG_DATA_HOME: "/tmp/ignored",
    },
    homeDir: "/home/example",
  });

  assert.equal(paths.configDir, "/srv/bearhomebot/config");
  assert.equal(paths.dataDir, "/srv/bearhomebot/data");
  assert.equal(paths.cacheDir, "/srv/bearhomebot/cache");
});

test("rejects relative runtime overrides", () => {
  assert.throws(
    () =>
      resolveRuntimePaths({
        env: { BEARHOMEBOT_DATA_DIR: "relative/data" },
        homeDir: "/home/example",
      }),
    /BEARHOMEBOT_DATA_DIR must be an absolute path/,
  );
});
