#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENTRYPOINT="$PROJECT_ROOT/dist/vault-main.js"

if [[ $# -ne 1 || ! "$1" =~ ^[1-9][0-9]{0,19}$ ]]; then
  printf 'Usage: %s <Telegram numeric user ID>\n' "$0" >&2
  exit 2
fi
if [[ ! -f "$ENTRYPOINT" ]]; then
  printf 'BearHomeBot is not built. Run npm run build first.\n' >&2
  exit 1
fi
if [[ ! -t 0 ]]; then
  printf 'Credential setup requires an interactive terminal.\n' >&2
  exit 1
fi

KTX_ID=""
KTX_PASSWORD=""
trap 'KTX_ID=""; KTX_PASSWORD=""' EXIT

printf 'KTX login ID (hidden): '
IFS= read -r -s KTX_ID
printf '\nKTX password (hidden): '
IFS= read -r -s KTX_PASSWORD
printf '\n'

if [[ -z "$KTX_ID" || -z "$KTX_PASSWORD" ]]; then
  printf 'KTX ID and password must not be empty.\n' >&2
  exit 1
fi

{
  printf '%s' "$KTX_ID" | base64 --wrap=0
  printf '\n'
  printf '%s' "$KTX_PASSWORD" | base64 --wrap=0
  printf '\n'
} | node "$ENTRYPOINT" set-ktx "$1"
