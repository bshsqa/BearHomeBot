#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
K_SKILL_DIR="$PROJECT_ROOT/k-skill"
K_SKILL_URL="${K_SKILL_URL:-https://github.com/NomaDamas/k-skill.git}"

if [[ ! -e "$K_SKILL_DIR" ]]; then
  git clone --branch main "$K_SKILL_URL" "$K_SKILL_DIR"
elif [[ ! -d "$K_SKILL_DIR/.git" ]]; then
  printf '%s exists but is not a Git checkout.\n' "$K_SKILL_DIR" >&2
  exit 1
else
  if [[ -n "$(git -C "$K_SKILL_DIR" status --short)" ]]; then
    printf 'k-skill has local changes; commit or discard them before syncing.\n' >&2
    exit 1
  fi
  git -C "$K_SKILL_DIR" switch main
  git -C "$K_SKILL_DIR" pull --ff-only origin main
fi

printf 'k-skill ready at %s (%s)\n' \
  "$K_SKILL_DIR" \
  "$(git -C "$K_SKILL_DIR" rev-parse --short HEAD)"
