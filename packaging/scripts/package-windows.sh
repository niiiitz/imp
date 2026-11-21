#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# IMP (org.imp.player) — Standalone Portable Windows Release Packager
# Produces:
#   dist/imp-windows-portable/
#   dist/imp-windows-portable-x86_64.zip
# ==============================================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"

export PATH="/usr/local/opt/node@24/bin:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:${HOME}/.cargo/bin:${PATH}"
CARGO_BIN="${CARGO_BIN:-$(command -v cargo || echo "${HOME}/.cargo/bin/cargo")}"
RUST_TARGET="x86_64-pc-windows-gnu"
OUT_DIR="${REPO_ROOT}/dist/imp-windows-portable"
ZIP_ARCHIVE="${REPO_ROOT}/dist/imp-windows-portable-x86_64.zip"

echo "============================================================"
echo " Building IMP Portable Windows Package (${RUST_TARGET})"
echo "============================================================"

echo "1/4 Building production React UI (ui/dist)..."
if [[ -d "${REPO_ROOT}/node_modules" ]]; then
  npm run build:ui
elif [[ -f "${REPO_ROOT}/ui/dist/index.html" ]]; then
  echo "   • Using prebuilt ui/dist (worktree without node_modules)"
else
  npm run build:ui
fi

echo "2/4 Generating embedded 150-day ES256 Apple Music Developer Token & SoundCloud Credentials..."
ENV_FILE="${REPO_ROOT}/.env"
if [[ ! -f "${ENV_FILE}" ]]; then
  COMMON_GIT_DIR="$(git -C "${REPO_ROOT}" rev-parse --git-common-dir 2>/dev/null || true)"
  if [[ -n "${COMMON_GIT_DIR}" && -f "$(cd "${REPO_ROOT}" && cd "${COMMON_GIT_DIR}/.." && pwd)/.env" ]]; then
    ENV_FILE="$(cd "${REPO_ROOT}" && cd "${COMMON_GIT_DIR}/.." && pwd)/.env"
  elif [[ -f "${HOME}/simp/.env" ]]; then
    ENV_FILE="${HOME}/simp/.env"
  fi
fi

if [[ -z "${SIMP_EMBEDDED_APPLE_DEV_TOKEN:-}" && -s "/tmp/.simp_embedded_jwt" ]]; then
  export SIMP_EMBEDDED_APPLE_DEV_TOKEN="$(cat /tmp/.simp_embedded_jwt)"
fi
if [[ -f "${ENV_FILE}" && -z "${SIMP_EMBEDDED_APPLE_DEV_TOKEN:-}" ]]; then
  EMBEDDED_JWT="$(ENV_FILE="${ENV_FILE}" python3 - <<'PY' || true
import base64, json, os, subprocess, time

env = {}
env_path = os.environ.get("ENV_FILE", ".env")
if os.path.exists(env_path):
    for line in open(env_path):
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'").strip('"')

team_id = env.get("APPLE_TEAM_ID", "")
key_id = env.get("APPLE_KEY_ID", "")
key_path = env.get("APPLE_PRIVATE_KEY_PATH", "")
if (not key_path or not os.path.isfile(key_path)) and key_id:
    local_candidate = f"AuthKey_{key_id}.p8"
    if os.path.isfile(local_candidate):
        key_path = local_candidate

if team_id and key_id and key_path and os.path.isfile(key_path):
    now = int(time.time())
    exp = now + 86400 * 150  # 150-day public MusicKit Developer Token
    b64u = lambda b: base64.urlsafe_b64encode(b).rstrip(b"=").decode("ascii")
    hdr = b64u(json.dumps({"alg": "ES256", "kid": key_id, "typ": "JWT"}, separators=(",", ":")).encode())
    pld = b64u(json.dumps({"iss": team_id, "iat": now, "exp": exp}, separators=(",", ":")).encode())
    signing_input = f"{hdr}.{pld}"
    p = subprocess.run(
        ["openssl", "dgst", "-sha256", "-sign", key_path],
        input=signing_input.encode("ascii"),
        capture_output=True,
        check=True,
    )
    der = p.stdout
    pos = 2 if (der[1] & 0x80) == 0 else 2 + (der[1] & 0x7F)
    def read_int(idx):
        assert der[idx] == 0x02
        length = der[idx + 1]
        val = der[idx + 2 : idx + 2 + length]
        if len(val) > 32 and val[0] == 0:
            val = val[-32:]
        return val.rjust(32, b"\x00"), idx + 2 + length
    r, pos = read_int(pos)
    s, pos = read_int(pos)
    sig = b64u(r + s)
    print(f"{signing_input}.{sig}", end="")
PY
)"
  if [[ -n "${EMBEDDED_JWT}" ]]; then
    export SIMP_EMBEDDED_APPLE_DEV_TOKEN="${EMBEDDED_JWT}"
    echo "   • Baked 150-day ES256 Apple Developer Token into Imp.exe"
  fi
fi

if [[ -f "${ENV_FILE}" ]]; then
  SC_ID="$(ENV_FILE="${ENV_FILE}" python3 -c 'import os; env=dict(l.strip().split("=",1) for l in open(os.environ["ENV_FILE"]) if l.strip() and not l.strip().startswith("#") and "=" in l); print(env.get("SOUNDCLOUD_CLIENT_ID","").strip().strip("\x27\x22"), end="")' 2>/dev/null || true)"
  if [[ -n "${SC_ID}" ]]; then
    export SIMP_EMBEDDED_SOUNDCLOUD_CLIENT_ID="${SC_ID}"
    echo "   • Baked public SoundCloud Client ID into Imp.exe (OAuth 2.1 token exchange proxied via simp-tap-67 Cloudflare Worker; zero client_secret in binary)"
  fi
  ACOUSTID_KEY="$(ENV_FILE="${ENV_FILE}" python3 -c 'import os; env=dict(l.strip().split("=",1) for l in open(os.environ["ENV_FILE"]) if l.strip() and not l.strip().startswith("#") and "=" in l); print(env.get("ACOUSTID_API_KEY","").strip().strip("\x27\x22"), end="")' 2>/dev/null || true)"
  if [[ -n "${ACOUSTID_KEY}" ]]; then
    export IMP_EMBEDDED_ACOUSTID_API_KEY="${ACOUSTID_KEY}"
    echo "   • Baked public AcoustID Client API Key into Imp.exe for pure-Rust Chromaprint Acoustic Mend"
  fi
fi

echo "3/4 Cross-compiling release Rust binary (Imp.exe for ${RUST_TARGET})..."
chmod +x "${REPO_ROOT}/packaging/scripts/setup-windows-toolchain.sh"
TOOLCHAIN_BIN="$("${REPO_ROOT}/packaging/scripts/setup-windows-toolchain.sh")"
mkdir -p /tmp/simp-zig-cache
export ZIG_GLOBAL_CACHE_DIR=/tmp/simp-zig-cache
export ZIG_LOCAL_CACHE_DIR=/tmp/simp-zig-cache
export PATH="${TOOLCHAIN_BIN}:${PATH}"
export CC_x86_64_pc_windows_gnu="${TOOLCHAIN_BIN}/x86_64-w64-mingw32-gcc"
export CXX_x86_64_pc_windows_gnu="${TOOLCHAIN_BIN}/x86_64-w64-mingw32-g++"
export AR_x86_64_pc_windows_gnu="${TOOLCHAIN_BIN}/x86_64-w64-mingw32-ar"
export CARGO_TARGET_X86_64_PC_WINDOWS_GNU_LINKER="${TOOLCHAIN_BIN}/x86_64-w64-mingw32-gcc"

"${CARGO_BIN}" build --release -p imp --target "${RUST_TARGET}" --offline
BUILT_EXE="${REPO_ROOT}/target/${RUST_TARGET}/release/imp.exe"

echo "4/4 Assembling dist/imp-windows-portable/ and ZIP archive..."
rm -rf "${OUT_DIR}" "${ZIP_ARCHIVE}"
mkdir -p "${OUT_DIR}/ui" "${OUT_DIR}/data/lib" "${OUT_DIR}/data/bin"

cp "${BUILT_EXE}" "${OUT_DIR}/Imp.exe"
# Also stage WebView2Loader.dll in data\lib\ (fallback copy is embedded inside Imp.exe, keeping root clean).
WEBVIEW2_DLL_PATH="$(find "${REPO_ROOT}/target/${RUST_TARGET}/release/build" -path "*/webview2-com-sys-*/out/x64/WebView2Loader.dll" 2>/dev/null | head -n 1 || true)"
if [[ -n "${WEBVIEW2_DLL_PATH}" && -f "${WEBVIEW2_DLL_PATH}" ]]; then
  cp "${WEBVIEW2_DLL_PATH}" "${OUT_DIR}/data/lib/WebView2Loader.dll"
  echo "   • Staged data/lib/WebView2Loader.dll for Embedded Edge WebView2"
fi
# Note: multi-resolution icon is already compiled into `Imp.exe` PE resources via `build.rs`.
# Do not copy a loose `.ico` next to `Imp.exe` in the root portable folder so users never
# confuse the icon file with the `Imp.exe` application launcher when file extensions are hidden.
cp -r "${REPO_ROOT}/ui/dist/"* "${OUT_DIR}/ui/"

# Optional Authenticode Code Signing (via osslsigncode on Linux/macOS or signtool.exe)
WINDOWS_TIMESTAMP_URL="${WINDOWS_TIMESTAMP_URL:-http://timestamp.digicert.com}"
WIN_SIGN_CMD="${IMP_WINDOWS_SIGN_CMD:-${SIMP_WINDOWS_SIGN_CMD:-}}"
if [[ -n "${WIN_SIGN_CMD}" ]]; then
  echo "   • Signing Imp.exe via custom sign command..."
  ${WIN_SIGN_CMD} "${OUT_DIR}/Imp.exe"
elif [[ -n "${WINDOWS_PFX_PATH:-}" && -f "${WINDOWS_PFX_PATH}" ]]; then
  if command -v osslsigncode >/dev/null 2>&1; then
    echo "   • Signing Imp.exe with Authenticode certificate (${WINDOWS_PFX_PATH})..."
    mv "${OUT_DIR}/Imp.exe" "${OUT_DIR}/imp-unsigned.exe"
    osslsigncode sign \
      -pkcs12 "${WINDOWS_PFX_PATH}" \
      -pass "${WINDOWS_PFX_PASSWORD:-}" \
      -n "IMP (Integrated Media Player)" \
      -i "https://github.com/niiiitz/imp" \
      -h sha256 \
      -t "${WINDOWS_TIMESTAMP_URL}" \
      -in "${OUT_DIR}/imp-unsigned.exe" \
      -out "${OUT_DIR}/Imp.exe"
    rm -f "${OUT_DIR}/imp-unsigned.exe"
    echo "   ✓ Authenticode signature embedded into Imp.exe"
  elif command -v signtool.exe >/dev/null 2>&1; then
    echo "   • Signing Imp.exe with signtool.exe (${WINDOWS_PFX_PATH})..."
    signtool.exe sign /f "${WINDOWS_PFX_PATH}" /p "${WINDOWS_PFX_PASSWORD:-}" /fd SHA256 /tr "${WINDOWS_TIMESTAMP_URL}" /td SHA256 "${OUT_DIR}/Imp.exe"
    echo "   ✓ Authenticode signature embedded into Imp.exe"
  else
    echo "   ⚠ WINDOWS_PFX_PATH is set, but neither osslsigncode nor signtool.exe was found in PATH"
  fi
fi

cat > "${OUT_DIR}/portable.txt" <<'EOF'
IMP Portable Mode Marker
========================
Keeping this file (portable.txt) next to Imp.exe tells IMP to store all
library databases (data\library.db), settings (data\settings.vdf), cached
cover art (data\art\), and chromeless window state (data\window-profile\)
self-contained inside this folder.

Delete portable.txt if you prefer IMP to store data in %LOCALAPPDATA%\imp.
EOF

cat > "${OUT_DIR}/Stop-IMP-Background-Audio.bat" <<'EOF'
@echo off
echo Stopping IMP headless background audio service (Imp.exe)...
taskkill /F /IM Imp.exe >nul 2>&1
taskkill /F /IM simp.exe >nul 2>&1
echo Done.
EOF

cat > "${OUT_DIR}/README-WINDOWS.txt" <<'EOF'
======================================================================
 IMP (Integrated Media Player) — Windows Portable Edition
======================================================================

1. HOW TO LAUNCH
   Double-click `Imp.exe`.
   - Starts the ultra-lightweight headless Rust audio daemon (`Imp.exe --daemon`)
     in the background (~0.1% CPU, native Windows WASAPI audio).
   - Places the IMP Portal Icon in the Windows System Tray (Notification Area).
   - Opens the chromeless IMP Console window via built-in Embedded Edge WebView2
     (with automatic fallback to Microsoft Edge / Brave / Chrome `--app` if
     WebView2 Runtime is unavailable or `IMP_USE_EXTERNAL_BROWSER=1` is set).

2. HEADLESS BACKGROUND PLAYBACK & SYSTEM TRAY
   - Closing the IMP window keeps your music playing in the background with
     zero taskbar clutter.
   - Left-click the IMP System Tray icon in the bottom-right Notification Area
     to re-open the IMP Console window at any time.
   - Middle-click the System Tray icon to toggle Play / Pause.
   - Right-click the System Tray icon for Now Playing status, Play/Pause,
     Next, Previous, Open IMP Console, or Quit IMP.
   - Hardware keyboard Media Keys (Play/Pause, Next, Previous) and the
     Windows 10/11 Volume Flyout work automatically while in-game.

3. PORTABLE MODE (`data\` FOLDER)
   - Because `portable.txt` is present next to `Imp.exe`, all settings,
     playlists, SQLite library metadata, and Apple Music tokens are stored
     inside the local `data\` folder. You can move this folder anywhere
     (including an external SSD or USB drive).

4. IN-PLACE SELF-UPDATE & AUTHENTICODE SIGNING
   - Open Settings -> Updates inside IMP (or run `Imp.exe update` from
     PowerShell / Command Prompt) to check GitHub and self-update in-place.
   - IMP downloads `imp-windows-portable-x86_64.zip`, renames the running
     `Imp.exe` -> `Imp.exe.old` (cleaned up automatically on next startup),
     updates `Imp.exe` and `ui\` in place while preserving your `data\`
     folder, and restarts the background audio daemon automatically.
   - To produce an Authenticode-signed binary that avoids Windows SmartScreen
     prompts, provide an OV or EV Code Signing `.pfx` (or Azure Artifact
     Signing / Certum Open Source Code Signing certificate) when running
     `package-windows.sh` via `WINDOWS_PFX_PATH=/path/to/cert.pfx` and
     `WINDOWS_PFX_PASSWORD=...` (uses `osslsigncode` or `signtool.exe` with
     SHA-256 + RFC3161 timestamping).

5. OPTICAL DISC DRIVES (AUDIO CD & DVD-VIDEO)
   - Audio CDs (`CD-DA`) are read directly from any Windows optical drive
     (`D:\`, `E:\`, etc.) with automatic MusicBrainz & Cover Art Archive lookup.
   - For encrypted DVD-Video discs, install VLC (64-bit) or place
     `libdvdcss-2.dll` in `data\lib\` and `ffmpeg.exe` in `data\bin\`.
EOF

(cd "${REPO_ROOT}/dist" && python3 -m zipfile -c "${ZIP_ARCHIVE}" imp-windows-portable)

echo "============================================================"
echo "✅ Windows Portable Release Ready:"
echo "   • Directory:   ${OUT_DIR}"
echo "   • ZIP Archive: ${ZIP_ARCHIVE}"
echo "============================================================"

