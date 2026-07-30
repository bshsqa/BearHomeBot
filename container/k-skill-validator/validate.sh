#!/usr/bin/env bash
set -euo pipefail
umask 077

mkdir -p "$HOME"
cd /candidate

export PIP_NO_INDEX=1
export PIP_FIND_LINKS=/cache/wheels
export npm_config_offline=true
export npm_config_ignore_scripts=true
export npm_config_audit=false
export npm_config_fund=false

npm run ci
