import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

import type { StateStore } from "../state/store.js";

const SKILL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_SKILL_DOCUMENT_BYTES = 1024 * 1024;
const MAX_DESCRIPTION_LENGTH = 180;

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  automotive: "자동차",
  beauty: "뷰티",
  business: "사업자·기업",
  civic: "공공·정치",
  convenience: "생활 편의",
  culture: "공연·문화",
  data: "통계·데이터",
  documents: "문서",
  education: "교육",
  finance: "금융",
  food: "음식",
  health: "건강·응급",
  healthcare: "건강기관",
  history: "역사",
  housing: "주거 공고",
  information: "정보 검색",
  ip: "특허",
  legal: "법률",
  lifestyle: "생활·예약",
  "local-info": "지역 정보",
  logistics: "택배·물류",
  marketing: "광고",
  news: "뉴스",
  procurement: "조달·입찰",
  "public-health": "식품·의약 안전",
  "real-estate": "부동산",
  recruiting: "채용",
  research: "학술·리서치",
  retail: "쇼핑",
  security: "도메인·보안정보",
  sports: "스포츠",
  transit: "교통",
  transport: "차량·도로",
  travel: "여행·교통 예약",
  utility: "생활 정보",
  weather: "날씨",
  writing: "한국어·글쓰기",
};

export interface CapabilityCatalogEntry {
  skillId: string;
  category: string;
  description: string;
}

export interface CapabilityCatalogLike {
  listEnabled(): CapabilityCatalogEntry[];
}

interface ParsedReview {
  enabledSkills: string[];
  summaries: ReadonlyMap<string, string>;
}

function normalizeDescription(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^(['"])(.*)\1$/u, "$2");
  if (normalized.length <= MAX_DESCRIPTION_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_DESCRIPTION_LENGTH - 1).trimEnd()}…`;
}

function parseReview(value: unknown): ParsedReview {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Active k-skill review is unavailable");
  }
  const review = value as Record<string, unknown>;
  if (!Array.isArray(review.enabledSkills) || !Array.isArray(review.skills)) {
    throw new Error("Active k-skill review is incomplete");
  }
  const enabledSkills = review.enabledSkills.map((skillId) => {
    if (typeof skillId !== "string" || !SKILL_ID_PATTERN.test(skillId)) {
      throw new Error("Active k-skill review contains an invalid skill ID");
    }
    return skillId;
  });
  if (new Set(enabledSkills).size !== enabledSkills.length) {
    throw new Error("Active k-skill review contains duplicate skill IDs");
  }
  const summaries = new Map<string, string>();
  for (const value of review.skills) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      continue;
    }
    const skill = value as Record<string, unknown>;
    if (
      typeof skill.skillId === "string" &&
      SKILL_ID_PATTERN.test(skill.skillId) &&
      typeof skill.summary === "string"
    ) {
      summaries.set(skill.skillId, normalizeDescription(skill.summary));
    }
  }
  return { enabledSkills, summaries };
}

function parseFrontmatter(text: string): {
  category?: string;
  description?: string;
} {
  const normalized = text.replace(/\r\n/gu, "\n");
  if (!normalized.startsWith("---\n")) {
    return {};
  }
  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return {};
  }
  const lines = normalized.slice(4, end).split("\n");
  let category: string | undefined;
  let description: string | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const categoryMatch = /^\s+category:\s*(.+?)\s*$/u.exec(line);
    if (categoryMatch?.[1]) {
      category = normalizeDescription(categoryMatch[1]);
    }
    const descriptionMatch = /^description:\s*(.*?)\s*$/u.exec(line);
    if (!descriptionMatch) {
      continue;
    }
    const value = descriptionMatch[1] ?? "";
    if (value !== "|" && value !== ">") {
      description = normalizeDescription(value);
      continue;
    }
    const block: string[] = [];
    for (
      let blockIndex = index + 1;
      blockIndex < lines.length;
      blockIndex += 1
    ) {
      const blockLine = lines[blockIndex]!;
      if (blockLine && !/^\s/u.test(blockLine)) {
        break;
      }
      block.push(blockLine.trim());
      index = blockIndex;
    }
    description = normalizeDescription(block.join(" "));
  }
  const result: { category?: string; description?: string } = {};
  if (category) {
    result.category = category;
  }
  if (description) {
    result.description = description;
  }
  return result;
}

function readSkillMetadata(
  releaseRoot: string,
  skillId: string,
): { category?: string; description?: string } {
  const skillDirectory = join(releaseRoot, skillId);
  const skillDocument = join(skillDirectory, "SKILL.md");
  const directoryStat = lstatSync(skillDirectory);
  const documentStat = lstatSync(skillDocument);
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    documentStat.isSymbolicLink() ||
    !documentStat.isFile() ||
    documentStat.size > MAX_SKILL_DOCUMENT_BYTES
  ) {
    throw new Error("Active k-skill catalog contains an unsafe skill document");
  }
  const realDocument = realpathSync(skillDocument);
  if (!realDocument.startsWith(`${releaseRoot}${sep}`)) {
    throw new Error("Active k-skill catalog escapes its release");
  }
  return parseFrontmatter(readFileSync(realDocument, "utf8"));
}

export class ActiveKSkillCatalog implements CapabilityCatalogLike {
  readonly #store: StateStore;
  #cache:
    | {
        key: string;
        entries: CapabilityCatalogEntry[];
      }
    | undefined;

  constructor(store: StateStore) {
    this.#store = store;
  }

  listEnabled(): CapabilityCatalogEntry[] {
    const state = this.#store.getKSkillActiveState();
    if (!state.activeSha) {
      return [];
    }
    const release = this.#store.getKSkillRelease(state.activeSha);
    if (
      release?.status !== "active" ||
      !release.releasePath ||
      !release.review
    ) {
      throw new Error("Active k-skill release is unavailable");
    }
    const cacheKey = `${release.sha}:${release.updatedAt}:${release.releasePath}`;
    if (this.#cache?.key === cacheKey) {
      return this.#cache.entries.map((entry) => ({ ...entry }));
    }
    const releaseRoot = realpathSync(release.releasePath);
    const rootStat = lstatSync(releaseRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
      throw new Error("Active k-skill release path is unsafe");
    }
    const review = parseReview(release.review);
    const entries = review.enabledSkills
      .map((skillId) => {
        const metadata = readSkillMetadata(releaseRoot, skillId);
        return {
          skillId,
          category: metadata.category || "other",
          description:
            metadata.description ||
            review.summaries.get(skillId) ||
            "검토를 통과한 k-skill",
        };
      })
      .sort(
        (left, right) =>
          left.category.localeCompare(right.category, "en") ||
          left.skillId.localeCompare(right.skillId, "en"),
      );
    this.#cache = {
      key: cacheKey,
      entries,
    };
    return entries.map((entry) => ({ ...entry }));
  }
}

export function formatCapabilityCatalog(
  entries: readonly CapabilityCatalogEntry[],
): string {
  if (entries.length === 0) {
    return "현재 활성화된 k-skill 목록이 없어.";
  }
  const lines = [
    `보안 검토를 통과해 활성 목록에 등록된 k-skill은 ${entries.length}개야.`,
    "아직 Telegram 실제 실행 연결은 준비 중이지만, 사용할 수 있도록 승인된 기능 목록은 아래와 같아.",
  ];
  let previousCategory = "";
  for (const entry of entries) {
    if (entry.category !== previousCategory) {
      previousCategory = entry.category;
      lines.push(
        "",
        `[${CATEGORY_LABELS[entry.category] ?? entry.category ?? "기타"}]`,
      );
    }
    lines.push(`• ${entry.skillId} — ${entry.description}`);
  }
  return lines.join("\n");
}
