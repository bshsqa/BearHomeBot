#!/usr/bin/env bash
set -euo pipefail

if (($# != 1)); then
  printf 'Usage: ./scripts/allow-telegram-user.sh <numeric-user-id>\n' >&2
  exit 2
fi

NEW_USER_ID="$1"
if [[ ! "$NEW_USER_ID" =~ ^[0-9]+$ ]]; then
  printf 'Telegram user ID must be numeric.\n' >&2
  exit 1
fi

CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
CONFIG_DIR="$CONFIG_HOME/bearhomebot"
CONFIG_FILE="$CONFIG_DIR/telegram.env"

if [[ ! -f "$CONFIG_FILE" ]]; then
  printf 'Missing %s. Run ./scripts/configure-telegram.sh first.\n' \
    "$CONFIG_FILE" >&2
  exit 1
fi

TELEGRAM_TOKEN=""
TELEGRAM_USER_IDS=""
while IFS='=' read -r key value; do
  case "$key" in
    BEARHOMEBOT_TELEGRAM_TOKEN)
      TELEGRAM_TOKEN="$value"
      ;;
    BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS)
      TELEGRAM_USER_IDS="$value"
      ;;
  esac
done <"$CONFIG_FILE"

if [[ ! "$TELEGRAM_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{20,}$ ]]; then
  printf 'Telegram configuration contains an invalid token.\n' >&2
  exit 1
fi

case ",$TELEGRAM_USER_IDS," in
  *",$NEW_USER_ID,"*)
    printf 'Telegram user %s is already allowed.\n' "$NEW_USER_ID"
    exit 0
    ;;
esac

if [[ -n "$TELEGRAM_USER_IDS" ]]; then
  TELEGRAM_USER_IDS="$TELEGRAM_USER_IDS,$NEW_USER_ID"
else
  TELEGRAM_USER_IDS="$NEW_USER_ID"
fi

umask 077
TEMP_FILE="$CONFIG_DIR/telegram.env.tmp"
{
  printf 'BEARHOMEBOT_TELEGRAM_TOKEN=%s\n' "$TELEGRAM_TOKEN"
  printf 'BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS=%s\n' "$TELEGRAM_USER_IDS"
} >"$TEMP_FILE"
chmod 0600 "$TEMP_FILE"
mv "$TEMP_FILE" "$CONFIG_FILE"

printf 'Telegram user %s added to the allowlist.\n' "$NEW_USER_ID"
