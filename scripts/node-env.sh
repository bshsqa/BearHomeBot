#!/usr/bin/env bash

if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
  return 0 2>/dev/null || exit 0
fi

for node_bin in "$PROJECT_ROOT"/.runtime/toolchains/node-v24*-linux-*/bin; do
  if [[ -x "$node_bin/node" && -x "$node_bin/npm" ]]; then
    export PATH="$node_bin:$PATH"
    break
  fi
done
