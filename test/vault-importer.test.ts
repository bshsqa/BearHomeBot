import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CredentialImportError,
  destroyCredentialValues,
  parseKSkillCredentialSource,
  readKSkillCredentialFile,
} from "../src/vault/importer.js";

test("parses only the allowlisted KTX credential names without evaluation", () => {
  const values = parseKSkillCredentialSource(
    [
      "# existing k-skill file",
      "export KSKILL_KTX_ID='family-user'",
      'KSKILL_KTX_PASSWORD="pass\\tword"',
      "UNRELATED_SECRET=ignored",
      "",
    ].join("\n"),
  );
  try {
    assert.deepEqual(
      values.map((entry) => [
        entry.credential.name,
        entry.value.toString("utf8"),
      ]),
      [
        ["KSKILL_KTX_ID", "family-user"],
        ["KSKILL_KTX_PASSWORD", "pass\tword"],
      ],
    );
  } finally {
    destroyCredentialValues(values);
  }
});

test("requires a mode 0600 regular source and does not delete it", () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-import-"));
  const path = join(root, "secrets.env");
  writeFileSync(path, "KSKILL_KTX_ID=user\nKSKILL_KTX_PASSWORD=password\n", {
    mode: 0o600,
  });
  try {
    const values = readKSkillCredentialFile(path);
    destroyCredentialValues(values);
    assert.doesNotThrow(() => readKSkillCredentialFile(path));

    chmodSync(path, 0o644);
    assert.throws(
      () => readKSkillCredentialFile(path),
      (error: unknown) =>
        error instanceof CredentialImportError &&
        error.code === "insecure_source",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects duplicate or missing supported credentials", () => {
  assert.throws(
    () =>
      parseKSkillCredentialSource(
        "KSKILL_KTX_ID=a\nKSKILL_KTX_ID=b\nKSKILL_KTX_PASSWORD=c\n",
      ),
    /duplicate/u,
  );
  assert.throws(
    () => parseKSkillCredentialSource("KSKILL_KTX_ID=a\n"),
    /missing/u,
  );
});
