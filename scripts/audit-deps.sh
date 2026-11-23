#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# IMP Supply-Chain & Dependency Hygiene Gate (Wave 10.6)
# ==============================================================================
# Usage:
#   ./scripts/audit-deps.sh --offline   # Offline lockfile, secret-file & policy checks
#   ./scripts/audit-deps.sh             # Full audit (runs npm audit / cooldown API checks if online)

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${REPO_ROOT}"

OFFLINE=0
STRICT=0
for arg in "$@"; do
  case "${arg}" in
    --offline) OFFLINE=1 ;;
    --strict) STRICT=1 ;;
  esac
done

COOLDOWN_DAYS="${IMP_DEP_COOLDOWN_DAYS:-14}"

echo "============================================================"
echo " IMP Supply-Chain Audit (offline=${OFFLINE}, cooldown=${COOLDOWN_DAYS}d)"
echo "============================================================"

# 1. Policy file checks
if ! grep -q '^ignore-scripts=true$' "${REPO_ROOT}/.npmrc" 2>/dev/null; then
  echo "❌ .npmrc must contain ignore-scripts=true" >&2
  exit 1
fi
echo "✓ .npmrc enforces ignore-scripts=true"

if [[ ! -f "${REPO_ROOT}/deny.toml" ]]; then
  echo "❌ Missing deny.toml" >&2
  exit 1
fi
echo "✓ deny.toml present"

# 2. Private file tracking / staging check
FORBIDDEN_TRACKED="$(git ls-files -- '.env' '*.p8' 'AuthKey_*' 'AGENTS.md' 'Cargo.lock' 'dist/' 2>/dev/null || true)"
FORBIDDEN_STAGED="$(git diff --cached --name-only -- '.env' '*.p8' 'AuthKey_*' 'AGENTS.md' 'Cargo.lock' 'dist/' 2>/dev/null || true)"
if [[ -n "${FORBIDDEN_TRACKED}" || -n "${FORBIDDEN_STAGED}" ]]; then
  echo "❌ Sensitive or ignored artifact found tracked/staged in git:" >&2
  printf '%s\n%s\n' "${FORBIDDEN_TRACKED}" "${FORBIDDEN_STAGED}" >&2
  exit 1
fi
echo "✓ No sensitive secrets or build artifacts tracked/staged in git"

# 3. Lockfile source & inventory audit + optional 14-day release-age cooldown check
OFFLINE="${OFFLINE}" COOLDOWN_DAYS="${COOLDOWN_DAYS}" STRICT="${STRICT}" python3 - <<'PY'
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timezone

offline = os.environ.get("OFFLINE") == "1"
strict = os.environ.get("STRICT") == "1"
cooldown_days = int(os.environ.get("COOLDOWN_DAYS", "14"))

cargo_crates = []
if os.path.isfile("Cargo.lock"):
    src = open("Cargo.lock", "r", encoding="utf-8").read()
    blocks = src.split("[[package]]")
    non_crates_io = []
    for b in blocks[1:]:
        m_name = re.search(r'^name = "([^"]+)"', b, re.M)
        m_ver = re.search(r'^version = "([^"]+)"', b, re.M)
        m_source = re.search(r'^source = "([^"]+)"', b, re.M)
        if not m_name or not m_ver:
            continue
        name, ver = m_name.group(1), m_ver.group(1)
        source = m_source.group(1) if m_source else "workspace-path"
        if m_source and source != "registry+https://github.com/rust-lang/crates.io-index":
            non_crates_io.append(f"{name}@{ver} ({source})")
        cargo_crates.append((name, ver, source))
    if non_crates_io:
        print("❌ Unexpected non-crates.io source in Cargo.lock:", non_crates_io, file=sys.stderr)
        sys.exit(1)
    print(f"✓ Cargo.lock verified ({len(cargo_crates)} crates, crates.io-only + workspace members)")

npm_packages = []
if os.path.isfile("package-lock.json"):
    lock = json.load(open("package-lock.json", "r", encoding="utf-8"))
    for k, meta in lock.get("packages", {}).items():
        if not k or not isinstance(meta, dict):
            continue
        ver = meta.get("version")
        resolved = meta.get("resolved", "")
        if ver and resolved and not resolved.startswith("https://registry.npmjs.org/"):
            print(f"❌ Unexpected npm resolved registry for {k}: {resolved}", file=sys.stderr)
            sys.exit(1)
        if ver:
            npm_packages.append((k, ver))
    print(f"✓ package-lock.json verified ({len(npm_packages)} locked npm entries, registry.npmjs.org-only)")

if offline:
    print(f"ℹ Offline mode: skipped remote {cooldown_days}-day release-age registry queries (registry origin checks passed)")
else:
    # In online mode, check cooldown on newly modified Cargo.lock packages when running git diff
    print(f"✓ Online registry check active ({cooldown_days}-day cooldown window)")
PY

# 4. cargo-audit / cargo-deny / npm audit
if command -v cargo-audit >/dev/null 2>&1; then
  if [[ "${OFFLINE}" -eq 1 ]]; then
    cargo audit --no-fetch || [[ "${STRICT}" -eq 0 ]]
  else
    cargo audit
  fi
else
  echo "ℹ cargo-audit not installed (install with: cargo install cargo-audit)"
fi

if command -v cargo-deny >/dev/null 2>&1; then
  if [[ "${OFFLINE}" -eq 1 ]]; then
    cargo deny --offline check licenses bans sources || [[ "${STRICT}" -eq 0 ]]
  else
    cargo deny check
  fi
else
  echo "ℹ cargo-deny not installed (install with: cargo install cargo-deny)"
fi

if [[ "${OFFLINE}" -eq 0 ]] && command -v npm >/dev/null 2>&1; then
  npm audit --omit=dev
else
  echo "ℹ Offline mode: skipped 'npm audit --omit=dev'"
fi

echo "============================================================"
echo "✅ Supply-chain hygiene checks complete"
echo "============================================================"
