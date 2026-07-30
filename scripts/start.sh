#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="$PROJECT_ROOT/dist/main.js"

if [[ ! -f "$ENTRYPOINT" ]]; then
  printf 'BearHomeBot is not built. Run %s/scripts/install.sh first.\n' \
    "$PROJECT_ROOT" >&2
  exit 1
fi

exec node "$ENTRYPOINT" "$@"
