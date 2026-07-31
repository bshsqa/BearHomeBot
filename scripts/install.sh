#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/node-env.sh
source "$PROJECT_ROOT/scripts/node-env.sh"

"$PROJECT_ROOT/scripts/doctor.sh"
"$PROJECT_ROOT/scripts/sync-k-skill.sh"

cd "$PROJECT_ROOT"
npm ci
npm run ci

printf 'BearHomeBot bootstrap installed successfully.\n'
printf 'Run %s/scripts/start-telegram.sh to start the Telegram gateway.\n' "$PROJECT_ROOT"
