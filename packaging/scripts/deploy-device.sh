#!/usr/bin/env bash
set -euo pipefail

# One-command WSL2 -> Steam Deck / Steam Machine / Steam Frame LAN deployer
TARGET="${1:-deck@steamdeck}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

"${REPO_ROOT}/packaging/scripts/package-release.sh"

echo "Deploying IMP bundle to ${TARGET}..."
scp "${REPO_ROOT}/dist/imp-steamos-userland.tar.gz" "${TARGET}:/tmp/imp-steamos-userland.tar.gz"
ssh "${TARGET}" "tar -xzf /tmp/imp-steamos-userland.tar.gz -C /tmp && /tmp/imp-steamos-userland/install-steamos.sh && rm -rf /tmp/imp-steamos-userland /tmp/imp-steamos-userland.tar.gz"

echo "✅ IMP deployed and running on ${TARGET}!"
