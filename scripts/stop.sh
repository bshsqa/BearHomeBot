#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="$PROJECT_ROOT/dist/telegram-main.js"
stopped=0

if systemctl --user is-active --quiet bearhomebot-telegram.service 2>/dev/null; then
  systemctl --user stop bearhomebot-telegram.service
  stopped=1
fi

if pgrep -u "$(id -u)" -f "$ENTRYPOINT" >/dev/null 2>&1; then
  pkill -TERM -u "$(id -u)" -f "$ENTRYPOINT"
  stopped=1
fi

if ((stopped == 1)); then
  printf 'BearHomeBot Telegram gateway stopped.\n'
else
  printf 'BearHomeBot Telegram gateway is not running.\n'
fi
