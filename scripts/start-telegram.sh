#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/node-env.sh
source "$PROJECT_ROOT/scripts/node-env.sh"
ENTRYPOINT="$PROJECT_ROOT/dist/telegram-main.js"
CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
CONFIG_FILE="$CONFIG_HOME/bearhomebot/telegram.env"

if [[ ! -f "$ENTRYPOINT" ]]; then
  printf 'BearHomeBot is not built. Run npm run build first.\n' >&2
  exit 1
fi

if [[ ! -f "$PROJECT_ROOT/k-skill/README.md" ]]; then
  printf 'Missing k-skill checkout. Run ./scripts/sync-k-skill.sh first.\n' >&2
  exit 1
fi

if [[ ! -f "$CONFIG_FILE" ]]; then
  printf 'Missing %s. Run ./scripts/configure-telegram.sh first.\n' \
    "$CONFIG_FILE" >&2
  exit 1
fi

CONFIG_OWNER="$(stat -c '%u' "$CONFIG_FILE")"
CONFIG_MODE="$(stat -c '%a' "$CONFIG_FILE")"
if [[ "$CONFIG_OWNER" != "$(id -u)" ]]; then
  printf 'Telegram configuration must be owned by the current user.\n' >&2
  exit 1
fi
if [[ "$CONFIG_MODE" != "600" ]]; then
  printf 'Telegram configuration mode is %s; expected 600.\n' \
    "$CONFIG_MODE" >&2
  exit 1
fi

BEARHOMEBOT_TELEGRAM_TOKEN=""
BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS=""
BEARHOMEBOT_TELEGRAM_OWNER_USER_ID=""
while IFS='=' read -r key value; do
  case "$key" in
    BEARHOMEBOT_TELEGRAM_TOKEN)
      BEARHOMEBOT_TELEGRAM_TOKEN="$value"
      ;;
    BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS)
      BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS="$value"
      ;;
    BEARHOMEBOT_TELEGRAM_OWNER_USER_ID)
      BEARHOMEBOT_TELEGRAM_OWNER_USER_ID="$value"
      ;;
  esac
done <"$CONFIG_FILE"

if [[ ! "$BEARHOMEBOT_TELEGRAM_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{20,}$ ]]; then
  printf 'Telegram configuration contains an invalid token.\n' >&2
  exit 1
fi
if [[
  -n "$BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS" &&
  ! "$BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS" =~ ^[0-9]+(,[0-9]+)*$
]]; then
  printf 'Telegram configuration contains invalid allowed user IDs.\n' >&2
  exit 1
fi
if [[
  -n "$BEARHOMEBOT_TELEGRAM_OWNER_USER_ID" &&
  ! "$BEARHOMEBOT_TELEGRAM_OWNER_USER_ID" =~ ^[0-9]+$
]]; then
  printf 'Telegram configuration contains an invalid owner user ID.\n' >&2
  exit 1
fi
if [[ -n "$BEARHOMEBOT_TELEGRAM_OWNER_USER_ID" ]]; then
  case ",$BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS," in
    *",$BEARHOMEBOT_TELEGRAM_OWNER_USER_ID,"*) ;;
    *)
      printf 'Telegram owner must also be in the allowlist.\n' >&2
      exit 1
      ;;
  esac
fi

export BEARHOMEBOT_TELEGRAM_TOKEN
export BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS
export BEARHOMEBOT_TELEGRAM_OWNER_USER_ID
exec node \
  --no-network-family-autoselection \
  --dns-result-order=ipv4first \
  "$ENTRYPOINT"
