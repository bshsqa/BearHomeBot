#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="$PROJECT_ROOT/dist/updater-main.js"
COMMAND="${1:-update}"

if [[ ! -f "$ENTRYPOINT" ]]; then
  printf 'BearHomeBot is not built. Run npm run build first.\n' >&2
  exit 1
fi
if ! command -v flock >/dev/null 2>&1; then
  printf 'flock is required for exclusive updater execution.\n' >&2
  exit 1
fi
case "$COMMAND" in
  check | update | status)
    if (($# > 1)); then
      printf 'Usage: %s [%s]\n' "$0" 'check|update|status|rollback [sha]' >&2
      exit 2
    fi
    ;;
  rollback)
    if (($# > 2)); then
      printf 'Usage: %s rollback [validated-sha]\n' "$0" >&2
      exit 2
    fi
    ;;
  *)
    printf 'Unknown updater command: %s\n' "$COMMAND" >&2
    exit 2
    ;;
esac

if [[ -n "${BEARHOMEBOT_DATA_DIR:-}" ]]; then
  DATA_DIR="$BEARHOMEBOT_DATA_DIR"
elif [[ -n "${XDG_DATA_HOME:-}" ]]; then
  DATA_DIR="$XDG_DATA_HOME/bearhomebot"
else
  DATA_DIR="$HOME/.local/share/bearhomebot"
fi
LOCK_FILE="$DATA_DIR/k-skill/update.lock"
mkdir -p "$(dirname "$LOCK_FILE")"
chmod 0700 "$(dirname "$LOCK_FILE")"

shift || true
exec flock \
  --exclusive \
  --nonblock \
  "$LOCK_FILE" \
  node "$ENTRYPOINT" "$COMMAND" "$@"
