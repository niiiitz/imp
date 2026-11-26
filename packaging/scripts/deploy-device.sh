#!/usr/bin/env bash
set -euo pipefail

# One-command WSL2 -> Steam Deck / Steam Machine / Steam Frame LAN deployer
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TARGET_ARG="${1:-}"

if [[ -n "${TARGET_ARG}" ]]; then
  exec "${REPO_ROOT}/scripts/remote-device.sh" -t "${TARGET_ARG}" deploy
else
  exec "${REPO_ROOT}/scripts/remote-device.sh" deploy
fi
