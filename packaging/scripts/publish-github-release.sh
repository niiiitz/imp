#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# IMP — Reliable GitHub Release Publisher (IPv4 + HTTP/1.1 Sequential Uploader)
# Avoids `gh release upload` Go HTTP/2 + IPv6 `HTTP 408` upload stalls and
# splits GitHub flags cleanly by tag:
#   - Stable tags (e.g., v0.8.2, v0.9.0)          -> prerelease=false, make_latest="true"
#   - Alpha/beta/rc tags (e.g., v0.9.0-alpha.1)   -> prerelease=true,  make_latest="false"
#
# Usage:
#   ./packaging/scripts/publish-github-release.sh v0.9.0-alpha.1 [notes_file]
# ==============================================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${REPO_ROOT}"
export PATH="/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:${PATH}"

TAG="${1:-}"
NOTES_FILE="${2:-}"

if [[ -z "${TAG}" ]]; then
  echo "Usage: $0 <vX.Y.Z[-alpha.N]> [notes_file]" >&2
  exit 1
fi

TAG="v${TAG#v}"
VERSION="${TAG#v}"

SKIP_BUILD_FLAG="${IMP_SKIP_BUILD:-${SIMP_SKIP_BUILD:-0}}"
if [[ "${SKIP_BUILD_FLAG}" != "1" ]]; then
  IMP_TARGET_ARCH=x86_64 ./packaging/scripts/package-release.sh "${VERSION}"
  IMP_TARGET_ARCH=aarch64 IMP_SKIP_UI_BUILD=1 IMP_SKIP_DECKY_BUILD=1 ./packaging/scripts/package-release.sh "${VERSION}"
  # Keep the generic `imp-steamos-userland.tar.gz` pointed at the x86_64 archive
  cp -f "dist/imp-steamos-userland-x86_64.tar.gz" "dist/imp-steamos-userland.tar.gz"
  IMP_SKIP_UI_BUILD=1 ./packaging/scripts/package-windows.sh "${VERSION}"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    ./packaging/scripts/package-macos.sh "${VERSION}"
  fi
fi

# Generate legacy `simp-*` transition bridge archives so v0.8.x installs on the alpha
# channel can self-update cleanly to v0.9.0-alpha.1+ (`simp.exe` / `bin/simp`).
if [[ -d "dist/imp-windows-portable" && -f "dist/imp-windows-portable/imp.exe" ]]; then
  rm -rf "dist/simp-windows-portable" "dist/simp-windows-portable-x86_64.zip"
  cp -a "dist/imp-windows-portable" "dist/simp-windows-portable"
  cp -f "dist/imp-windows-portable/imp.exe" "dist/simp-windows-portable/simp.exe"
  (cd "dist" && python3 -m zipfile -c "${REPO_ROOT}/dist/simp-windows-portable-x86_64.zip" simp-windows-portable)
  rm -rf "dist/simp-windows-portable"
fi

for ARCH_BRIDGE in x86_64 aarch64; do
  IMP_TAR="dist/imp-steamos-userland-${ARCH_BRIDGE}.tar.gz"
  SIMP_TAR="dist/simp-steamos-userland-${ARCH_BRIDGE}.tar.gz"
  if [[ -f "${IMP_TAR}" ]]; then
    BRIDGE_TMP="$(mktemp -d)"
    tar -xzf "${IMP_TAR}" -C "${BRIDGE_TMP}"
    if [[ -d "${BRIDGE_TMP}/imp-steamos-userland" ]]; then
      mv "${BRIDGE_TMP}/imp-steamos-userland" "${BRIDGE_TMP}/simp-steamos-userland"
      if [[ -f "${BRIDGE_TMP}/simp-steamos-userland/bin/imp" ]]; then
        cp -f "${BRIDGE_TMP}/simp-steamos-userland/bin/imp" "${BRIDGE_TMP}/simp-steamos-userland/bin/simp"
        chmod +x "${BRIDGE_TMP}/simp-steamos-userland/bin/simp"
      fi
      if [[ -d "${BRIDGE_TMP}/simp-steamos-userland/imp-decky" ]]; then
        mv "${BRIDGE_TMP}/simp-steamos-userland/imp-decky" "${BRIDGE_TMP}/simp-steamos-userland/simp-decky"
      fi
      tar --no-xattrs -C "${BRIDGE_TMP}" -czf "${SIMP_TAR}" "simp-steamos-userland"
    fi
    rm -rf "${BRIDGE_TMP}"
  fi
done

python3 - "${TAG}" "${NOTES_FILE}" <<'PY'
import json
import os
import re
import subprocess
import sys

tag = sys.argv[1]
notes_file = sys.argv[2] if len(sys.argv) > 2 else ""

notes = f"IMP {tag}"
if notes_file and os.path.isfile(notes_file):
    with open(notes_file, "r", encoding="utf-8") as f:
        notes = f.read()
else:
    try:
        commit_msg = subprocess.check_output(
            ["git", "log", "-1", "--format=## %s%n%n%b", tag], text=True
        ).strip()
        if commit_msg:
            notes = commit_msg
    except Exception:
        pass

token = os.environ.get("GH_TOKEN", "").strip()
if not token:
    try:
        token = subprocess.check_output(["gh", "auth", "token"], text=True).strip()
    except Exception:
        pass
for env_candidate in [".env", os.path.expanduser("~/simp/.env")]:
    if not token and os.path.isfile(env_candidate):
        for line in open(env_candidate, "r", encoding="utf-8"):
            line = line.strip()
            if line.startswith("GH_TOKEN="):
                token = line.split("=", 1)[1].strip().strip("'").strip('"')

if not token:
    print("❌ ERROR: Could not resolve GitHub token from gh auth token or .env", file=sys.stderr)
    sys.exit(1)

repo = "niiiitz/imp"

def api_call(method, url, payload=None):
    cmd = [
        "curl", "-4", "--http1.1", "--retry", "3", "-sS",
        "-X", method,
        "-H", f"Authorization: Bearer {token}",
        "-H", "Accept: application/vnd.github+json",
    ]
    if payload is not None:
        cmd.extend(["-H", "Content-Type: application/json", "-d", json.dumps(payload)])
    cmd.append(url)
    out = subprocess.check_output(cmd, text=True)
    return json.loads(out) if out.strip() else {}

# 1. Check if release already exists for tag
check_cmd = [
    "curl", "-4", "--http1.1", "-sS",
    "-H", f"Authorization: Bearer {token}",
    "-H", "Accept: application/vnd.github+json",
    f"https://api.github.com/repos/{repo}/releases/tags/{tag}",
]
rel_raw = subprocess.check_output(check_cmd, text=True)
rel = json.loads(rel_raw)

rel_body = notes
if not notes_file and "body" in rel and rel["body"]:
    rel_body = rel["body"]

try:
    cur_branch = subprocess.check_output(
        ["git", "rev-parse", "--abbrev-ref", "HEAD"], text=True
    ).strip()
except Exception:
    cur_branch = ""
target_commitish = os.environ.get("IMP_TARGET_COMMITISH", os.environ.get("SIMP_TARGET_COMMITISH", "")).strip() or (
    cur_branch if cur_branch and cur_branch != "HEAD" else "main"
)

is_prerelease = bool(re.search(r"-(?:alpha|beta|rc)\b", tag, re.IGNORECASE))
force_latest = os.environ.get("IMP_FORCE_LATEST", os.environ.get("SIMP_FORCE_LATEST", "0")) == "1"
make_latest_val = "true" if (force_latest or not is_prerelease) else "false"
channel_desc = "Pre-release (Alpha channel)" if is_prerelease else "Latest Stable"

rel_payload = {
    "tag_name": tag,
    "target_commitish": target_commitish,
    "name": f"IMP {tag}",
    "body": rel_body,
    "draft": False,
    "prerelease": is_prerelease,
    "make_latest": make_latest_val,
}

if "id" in rel:
    rel_id = rel["id"]
    print(f"Updating existing release {tag} (ID {rel_id}, {channel_desc})...")
    rel = api_call(
        "PATCH",
        f"https://api.github.com/repos/{repo}/releases/{rel_id}",
        rel_payload,
    )
else:
    print(f"Creating release {tag} ({channel_desc})...")
    rel = api_call(
        "POST",
        f"https://api.github.com/repos/{repo}/releases",
        rel_payload,
    )
    rel_id = rel["id"]

existing_assets = {a["name"]: a["id"] for a in rel.get("assets", [])}

assets = [
    ("dist/imp-steamos-userland-aarch64.tar.gz", "application/gzip"),
    ("dist/imp-steamos-userland-x86_64.tar.gz", "application/gzip"),
    ("dist/imp-steamos-userland.tar.gz", "application/gzip"),
    ("dist/imp-decky.zip", "application/zip"),
    ("dist/imp-windows-portable-x86_64.zip", "application/zip"),
    ("dist/simp-steamos-userland-aarch64.tar.gz", "application/gzip"),
    ("dist/simp-steamos-userland-x86_64.tar.gz", "application/gzip"),
    ("dist/simp-windows-portable-x86_64.zip", "application/zip"),
    ("dist/IMP-macos-arm64.zip", "application/zip"),
    ("dist/IMP-macos-x86_64.zip", "application/zip"),
]

for path, ctype in assets:
    if not os.path.isfile(path):
        print(f"⚠️ Skipping missing asset {path}")
        continue
    name = os.path.basename(path)
    if name in existing_assets:
        print(f"Removing previous asset {name} ({existing_assets[name]})...")
        api_call("DELETE", f"https://api.github.com/repos/{repo}/releases/assets/{existing_assets[name]}")

    upload_url = f"https://uploads.github.com/repos/{repo}/releases/{rel_id}/assets?name={name}"
    print(f"Uploading {name} ({os.path.getsize(path)} bytes) over IPv4 HTTP/1.1...")
    res = subprocess.run(
        [
            "curl", "-4", "--http1.1", "--retry", "3", "--retry-all-errors",
            "-sS", "-X", "POST",
            "-H", f"Authorization: Bearer {token}",
            "-H", f"Content-Type: {ctype}",
            "--data-binary", f"@{path}",
            upload_url,
        ],
        capture_output=True,
        text=True,
    )
    if res.returncode != 0:
        print(f"❌ Failed uploading {name}: {res.stderr}", file=sys.stderr)
        sys.exit(1)
    uploaded = json.loads(res.stdout)
    print(f"  ✓ {uploaded.get('name')} ({uploaded.get('size')} bytes, state={uploaded.get('state')})")

print(f"✅ Release published: {rel.get('html_url', f'https://github.com/{repo}/releases/tag/{tag}')}")
PY

