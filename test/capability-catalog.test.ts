import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ActiveKSkillCatalog,
  findRelevantCapabilities,
  formatCapabilityCatalog,
} from "../src/capability/catalog.js";
import { StateStore } from "../src/state/store.js";

test("lists only enabled skills from the active immutable release", () => {
  const root = mkdtempSync(join(tmpdir(), "bearhomebot-catalog-"));
  const store = new StateStore(":memory:", () => "2026-07-31T10:00:00.000Z");
  const sha = "a".repeat(40);
  try {
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, "excluded"));
    writeFileSync(
      join(root, "alpha", "SKILL.md"),
      [
        "---",
        "name: alpha",
        "description: |",
        "  공개 데이터를",
        "  조회한다.",
        "metadata:",
        "  category: utility",
        "---",
        "# Alpha",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(root, "excluded", "SKILL.md"),
      "---\nname: excluded\ndescription: 제외됨\n---\n",
    );
    store.recordKSkillCandidate({
      sha,
      treeSha: "b".repeat(40),
      sourceUrl: "https://github.com/NomaDamas/k-skill.git",
      sourceBranch: "main",
      manifest: {},
    });
    store.markKSkillCandidateValidated({
      sha,
      releasePath: root,
      review: {
        enabledSkills: ["alpha"],
        excludedSkills: ["excluded"],
        skills: [
          { skillId: "alpha", summary: "fallback" },
          { skillId: "excluded", summary: "must not be listed" },
        ],
      },
    });
    store.promoteKSkillRelease(sha);

    const entries = new ActiveKSkillCatalog(store).listEnabled();

    assert.deepEqual(entries, [
      {
        skillId: "alpha",
        category: "utility",
        description: "공개 데이터를 조회한다.",
      },
    ]);
    const formatted = formatCapabilityCatalog(entries);
    assert.match(formatted, /활성 목록에 등록된 k-skill은 1개/u);
    assert.match(formatted, /\[생활 정보\]/u);
    assert.doesNotMatch(formatted, /excluded/u);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("returns a stable empty catalog message", () => {
  assert.equal(
    formatCapabilityCatalog([]),
    "현재 활성화된 k-skill 목록이 없어.",
  );
});

test("selects only relevant catalog entries for a capability question", () => {
  const entries = [
    {
      skillId: "delivery-tracking",
      category: "logistics",
      description: "택배 배송 상태를 조회한다.",
    },
    {
      skillId: "ktx-booking",
      category: "travel",
      description: "KTX 열차와 예약 정보를 조회한다.",
    },
    {
      skillId: "korea-weather",
      category: "weather",
      description: "한국 날씨를 조회한다.",
    },
    {
      skillId: "myrealtrip-search",
      category: "travel",
      description: "항공권과 숙소를 검색하고 예약 링크를 확인한다.",
    },
  ];

  assert.deepEqual(
    findRelevantCapabilities(
      entries,
      "k skill에 있는 ktx 예약 스킬로 조회와 예약이 가능해?",
    ),
    [entries[1]],
  );
});
