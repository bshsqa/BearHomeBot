#!/usr/bin/env bash
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

if [[ -t 1 && -z "${NO_COLOR:-}" ]]; then
  COLOR_GREEN=$'\033[32m'
  COLOR_YELLOW=$'\033[33m'
  COLOR_RED=$'\033[31m'
  COLOR_RESET=$'\033[0m'
else
  COLOR_GREEN=""
  COLOR_YELLOW=""
  COLOR_RED=""
  COLOR_RESET=""
fi

pass() {
  PASS_COUNT=$((PASS_COUNT + 1))
  printf '%s[PASS]%s %s\n' "$COLOR_GREEN" "$COLOR_RESET" "$1"
}

warn() {
  WARN_COUNT=$((WARN_COUNT + 1))
  printf '%s[WARN]%s %s\n' "$COLOR_YELLOW" "$COLOR_RESET" "$1"
}

fail() {
  FAIL_COUNT=$((FAIL_COUNT + 1))
  printf '%s[FAIL]%s %s\n' "$COLOR_RED" "$COLOR_RESET" "$1"
}

command_version() {
  local command_name="$1"
  shift

  if ! command -v "$command_name" >/dev/null 2>&1; then
    return 1
  fi

  "$command_name" "$@" 2>&1 | head -n 1
}

check_operating_system() {
  if [[ ! -r /etc/os-release ]]; then
    fail "Cannot read /etc/os-release; Ubuntu 24.04 or newer is required"
    return
  fi

  # shellcheck disable=SC1091
  source /etc/os-release

  if [[ "${ID:-}" != "ubuntu" ]]; then
    fail "Unsupported operating system: ${PRETTY_NAME:-unknown}; Ubuntu is required"
    return
  fi

  if printf '24.04\n%s\n' "${VERSION_ID:-0}" | sort -V -C; then
    pass "Operating system: ${PRETTY_NAME:-Ubuntu}"
  else
    fail "Ubuntu ${VERSION_ID:-unknown} is too old; Ubuntu 24.04 or newer is required"
  fi
}

check_architecture() {
  local architecture
  architecture="$(uname -m)"

  case "$architecture" in
    x86_64 | aarch64 | arm64)
      pass "CPU architecture: $architecture"
      ;;
    *)
      fail "Unsupported CPU architecture: $architecture"
      ;;
  esac
}

check_timezone() {
  local timezone=""

  if command -v timedatectl >/dev/null 2>&1; then
    timezone="$(timedatectl show --property=Timezone --value 2>/dev/null || true)"
  fi
  if [[ -z "$timezone" && -r /etc/timezone ]]; then
    timezone="$(tr -d '[:space:]' </etc/timezone)"
  fi

  if [[ "$timezone" == "Asia/Seoul" ]]; then
    pass "Timezone: Asia/Seoul"
  elif [[ -n "$timezone" ]]; then
    fail "Timezone is $timezone; set it with: sudo timedatectl set-timezone Asia/Seoul"
  else
    fail "Could not determine timezone; Asia/Seoul is required"
  fi
}

check_commands() {
  local version
  local node_version
  local node_major
  local python_version
  local python_major
  local python_minor

  if version="$(command_version git --version)"; then
    pass "$version"
  else
    fail "Git is not installed"
  fi

  if version="$(command_version tar --version)"; then
    pass "$version"
  else
    fail "GNU tar is not installed"
  fi

  if version="$(command_version flock --version)"; then
    pass "$version"
  else
    fail "flock is not installed"
  fi

  if version="$(command_version node --version)"; then
    node_version="${version#v}"
    node_major="${node_version%%.*}"
    if [[ "$node_major" == "24" ]]; then
      pass "Node.js $version"
    else
      fail "Node.js $version is unsupported; install Node.js 24 LTS"
    fi
  else
    fail "Node.js is not installed; install Node.js 24 LTS"
  fi

  if version="$(command_version npm --version)"; then
    pass "npm $version"
  else
    fail "npm is not installed"
  fi

  if version="$(command_version python3 --version)"; then
    python_version="${version##* }"
    python_major="${python_version%%.*}"
    python_minor="${python_version#*.}"
    python_minor="${python_minor%%.*}"
    if ((python_major > 3 || (python_major == 3 && python_minor >= 10))); then
      pass "Python $python_version"
    else
      fail "Python $python_version is too old; Python 3.10 or newer is required"
    fi
  else
    fail "Python 3 is not installed"
  fi

  if version="$(command_version codex --version)"; then
    pass "$version"
  else
    fail "Codex CLI is not installed"
  fi

}

check_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then
    fail "systemctl is not installed"
    return
  fi

  if [[ -d /run/systemd/system ]]; then
    pass "systemd is running"
  else
    fail "systemd is not running"
  fi
}

check_disk_space() {
  local available_kib
  available_kib="$(df -Pk "$PROJECT_ROOT" | awk 'NR == 2 { print $4 }')"

  if [[ ! "$available_kib" =~ ^[0-9]+$ ]]; then
    warn "Could not determine available disk space"
  elif ((available_kib >= 2 * 1024 * 1024)); then
    pass "Available disk space: $((available_kib / 1024)) MiB"
  elif ((available_kib >= 1024 * 1024)); then
    warn "Available disk space is below 2 GiB"
  else
    fail "Available disk space is below 1 GiB"
  fi
}

check_git_boundaries() {
  local tracked_sensitive

  if ! git -C "$PROJECT_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "BearHomeBot is not a Git repository"
    return
  fi

  pass "BearHomeBot Git repository detected"

  if git -C "$PROJECT_ROOT" check-ignore -q k-skill; then
    pass "k-skill checkout is excluded from BearHomeBot Git"
  else
    fail "k-skill must be ignored by the BearHomeBot repository"
  fi

  tracked_sensitive="$(
    git -C "$PROJECT_ROOT" ls-files |
      awk '
        /(^|\/)\.env($|\.)/ ||
        /(^|\/)secrets\.env$/ ||
        /^\.runtime\// ||
        /^data\// ||
        /^logs\// ||
        /^k-skill\// { print }
      '
  )"

  if [[ -z "$tracked_sensitive" ]]; then
    pass "No sensitive runtime paths are tracked by Git"
  else
    fail "Sensitive runtime paths are tracked by Git: ${tracked_sensitive//$'\n'/, }"
  fi
}

usage() {
  cat <<'EOF'
Usage: ./scripts/doctor.sh

Runs read-only checks for the Ubuntu environment required by BearHomeBot.
The script does not install packages, read credentials, or modify the system.
EOF
}

if [[ "${1:-}" == "--help" || "${1:-}" == "-h" ]]; then
  usage
  exit 0
fi

if (($# > 0)); then
  printf 'Unknown argument: %s\n' "$1" >&2
  usage >&2
  exit 2
fi

printf 'BearHomeBot doctor\n'
printf 'Project: %s\n\n' "$PROJECT_ROOT"

check_operating_system
check_architecture
check_timezone
check_commands
check_systemd
check_disk_space
check_git_boundaries

printf '\nSummary: %d passed, %d warning(s), %d failure(s)\n' \
  "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT"

if ((FAIL_COUNT > 0)); then
  printf 'BearHomeBot is not ready. Resolve the FAIL items and run doctor again.\n'
  exit 1
fi

printf 'BearHomeBot environment is ready.\n'
