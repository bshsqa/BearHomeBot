#!/usr/bin/env bash
set -euo pipefail

CONFIG_HOME="${XDG_CONFIG_HOME:-${HOME}/.config}"
CONFIG_DIR="$CONFIG_HOME/bearhomebot"
CONFIG_FILE="$CONFIG_DIR/telegram.env"

printf 'Telegram @BotFather token: '
IFS= read -r -s TELEGRAM_TOKEN
printf '\n'

if [[ ! "$TELEGRAM_TOKEN" =~ ^[0-9]+:[A-Za-z0-9_-]{20,}$ ]]; then
  printf 'The Telegram token format is invalid.\n' >&2
  exit 1
fi

printf 'Allowed numeric user IDs, comma-separated (leave blank for /whoami setup): '
IFS= read -r TELEGRAM_USER_IDS
TELEGRAM_USER_IDS="${TELEGRAM_USER_IDS//[[:space:]]/}"

if [[ -n "$TELEGRAM_USER_IDS" && ! "$TELEGRAM_USER_IDS" =~ ^[0-9]+(,[0-9]+)*$ ]]; then
  printf 'Allowed user IDs must be comma-separated numbers.\n' >&2
  exit 1
fi

TELEGRAM_OWNER_ID="${TELEGRAM_USER_IDS%%,*}"

umask 077
mkdir -p "$CONFIG_DIR"
{
  printf 'BEARHOMEBOT_TELEGRAM_TOKEN=%s\n' "$TELEGRAM_TOKEN"
  printf 'BEARHOMEBOT_TELEGRAM_ALLOWED_USER_IDS=%s\n' "$TELEGRAM_USER_IDS"
  printf 'BEARHOMEBOT_TELEGRAM_OWNER_USER_ID=%s\n' "$TELEGRAM_OWNER_ID"
} >"$CONFIG_FILE"
chmod 0600 "$CONFIG_FILE"

printf 'Telegram bootstrap configuration saved to %s with mode 0600.\n' \
  "$CONFIG_FILE"
if [[ -n "$TELEGRAM_OWNER_ID" ]]; then
  printf 'Telegram user %s is the BearHomeBot owner.\n' "$TELEGRAM_OWNER_ID"
fi
