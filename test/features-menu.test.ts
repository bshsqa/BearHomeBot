import assert from "node:assert/strict";
import test from "node:test";

import {
  FEATURE_CATEGORIES,
  findFeatureCategory,
  formatFeatureCategory,
} from "../src/features/menu.js";

test("defines six feature categories with 61 unique skills", () => {
  const features = FEATURE_CATEGORIES.flatMap((category) => category.features);
  const skillIds = features.map((feature) => feature.skillId);

  assert.equal(FEATURE_CATEGORIES.length, 6);
  assert.equal(features.length, 61);
  assert.equal(new Set(skillIds).size, skillIds.length);
  assert.equal(
    findFeatureCategory("recommended")?.features[0]?.skillId,
    "ktx-booking",
  );
});

test("formats every category within one Telegram message", () => {
  for (const category of FEATURE_CATEGORIES) {
    const text = formatFeatureCategory(category);
    assert.match(text, new RegExp(`^${category.label}`, "u"));
    assert.ok(text.length <= 3_900);
  }
});
