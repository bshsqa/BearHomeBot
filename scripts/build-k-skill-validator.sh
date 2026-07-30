#!/usr/bin/env bash
set -euo pipefail
umask 077

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTEXT="$PROJECT_ROOT/container/k-skill-validator"

if ! command -v podman >/dev/null 2>&1; then
  printf 'Podman is required to build the k-skill validator image.\n' >&2
  exit 1
fi

IMAGE="$(
  node -e '
    const fs = require("node:fs");
    const policy = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(policy.validation.image);
  ' "$PROJECT_ROOT/config/k-skill-policy.json"
)"

podman build \
  --pull=always \
  --tag "$IMAGE" \
  --file "$CONTEXT/Containerfile" \
  "$CONTEXT"

printf 'Built k-skill validator image: %s\n' "$IMAGE"
