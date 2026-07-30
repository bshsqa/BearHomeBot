#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="$PROJECT_ROOT/dist/vault-main.js"

if [[ $# -lt 1 || $# -gt 2 || ! "$1" =~ ^[1-9][0-9]{0,19}$ ]]; then
  printf 'Usage: %s <Telegram numeric user ID> [secrets.env]\n' "$0" >&2
  exit 2
fi
if [[ ! -f "$ENTRYPOINT" ]]; then
  printf 'BearHomeBot is not built. Run npm run build first.\n' >&2
  exit 1
fi

if [[ $# -eq 2 ]]; then
  exec node "$ENTRYPOINT" import-k-skill "$1" "$2"
fi
exec node "$ENTRYPOINT" import-k-skill "$1"
