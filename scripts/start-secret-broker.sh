#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="$PROJECT_ROOT/dist/secret-broker-main.js"

if [[ ! -f "$ENTRYPOINT" ]]; then
  printf 'BearHomeBot is not built. Run npm run build first.\n' >&2
  exit 1
fi

exec node "$ENTRYPOINT"
