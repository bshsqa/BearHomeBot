#!/usr/bin/env bash
set -euo pipefail

if systemctl --user list-unit-files bearhomebot.service --no-legend 2>/dev/null |
  grep -q '^bearhomebot\.service'; then
  systemctl --user stop bearhomebot.service
  printf 'BearHomeBot user service stopped.\n'
else
  printf 'No BearHomeBot systemd user service is installed yet.\n'
  printf 'A foreground development process can be stopped with Ctrl+C.\n'
fi
