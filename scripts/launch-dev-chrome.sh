#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# IMP Local Chromium / Google Chrome Dev QA Harness (Wave 10.5)
# ==============================================================================
# Launches Chrome with an isolated temp profile and CDP remote debugging port
# so live UI / screenshot / gamepad QA never touches personal Chrome profiles.

CHROME_BIN="${IMP_CHROME_BIN:-$(command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser || true)}"
if [[ -z "${CHROME_BIN}" ]]; then
  echo "❌ No Chrome/Chromium binary found on PATH." >&2
  exit 1
fi

CDP_PORT="${IMP_CHROME_PORT:-9222}"
PROFILE_DIR="${IMP_CHROME_PROFILE:-/tmp/imp-dev-chrome-profile}"
TARGET_URL="${1:-http://127.0.0.1:18888}"

mkdir -p "${PROFILE_DIR}"

ARGS=(
  "--user-data-dir=${PROFILE_DIR}"
  "--remote-debugging-port=${CDP_PORT}"
  "--no-first-run"
  "--no-default-browser-check"
  "--disable-background-networking"
  "--disable-sync"
  "--window-size=1280,720"
)

if [[ "${IMP_CHROME_HEADLESS:-0}" == "1" ]]; then
  ARGS+=(
    "--headless=new"
    "--no-sandbox"
    "--disable-gpu"
  )
fi

echo "Launching ${CHROME_BIN} on CDP port ${CDP_PORT} -> ${TARGET_URL}"
exec "${CHROME_BIN}" "${ARGS[@]}" "${TARGET_URL}"
