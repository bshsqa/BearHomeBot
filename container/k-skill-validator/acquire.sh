#!/usr/bin/env bash
set -euo pipefail
umask 077

mkdir -p "$HOME" /cache/npm /cache/wheels
cd /candidate

npm ci \
  --ignore-scripts \
  --cache /cache/npm \
  --no-audit \
  --no-fund

npm audit \
  --audit-level="${BEARHOMEBOT_NPM_AUDIT_LEVEL:?}" \
  --json \
  > /candidate/.bearhomebot-npm-audit.json

for requirement in "$@"; do
  python3 -m pip download \
    --disable-pip-version-check \
    --dest /cache/wheels \
    --no-deps \
    --only-binary=:all: \
    "$requirement"
done
