#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$PROJECT_ROOT/scripts/doctor.sh"

cd "$PROJECT_ROOT"
npm ci
npm run ci
"$PROJECT_ROOT/scripts/build-k-skill-validator.sh"

printf 'BearHomeBot bootstrap installed successfully.\n'
printf 'Run %s/scripts/start.sh --health to verify the app.\n' "$PROJECT_ROOT"
printf 'Run %s/scripts/k-skill-updater.sh check to inspect the current candidate.\n' "$PROJECT_ROOT"
