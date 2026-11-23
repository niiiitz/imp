#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# IMP Supply-Chain & Dependency Hygiene Gate (Wave 10.6)
# ==============================================================================
# Usage:
#   ./scripts/audit-deps.sh --offline --strict  # Offline lockfile, secret & policy checks
#   ./scripts/audit-deps.sh                     # Full audit + 14-day release-age check
# ==============================================================================

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
echo " IMP Supply-Chain Audit (offline=${OFFLINE}, strict=${STRICT}, cooldown=${COOLDOWN_DAYS}d)"
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
FORBIDDEN_PATTERNS=(
  '.env'
  '.env.*'
  '*.p8'
  'AuthKey_*'
  '*.key'
  '*.pem'
  'AGENTS.md'
  'crates/imp-desktop/Cargo.lock'
  'dist/'
  'reference_documentation/'
)
FORBIDDEN_TRACKED="$(git ls-files -- "${FORBIDDEN_PATTERNS[@]}" 2>/dev/null || true)"
FORBIDDEN_STAGED="$(git diff --cached --name-only -- "${FORBIDDEN_PATTERNS[@]}" 2>/dev/null || true)"
if [[ -n "${FORBIDDEN_TRACKED}" || -n "${FORBIDDEN_STAGED}" ]]; then
  echo "❌ Sensitive or ignored artifact found tracked/staged in git:" >&2
  printf '%s\n%s\n' "${FORBIDDEN_TRACKED}" "${FORBIDDEN_STAGED}" >&2
  exit 1
fi
echo "✓ No sensitive secrets or build artifacts tracked/staged in git"

# 3. Lockfile source & inventory audit + 14-day release-age cooldown check
OFFLINE="${OFFLINE}" COOLDOWN_DAYS="${COOLDOWN_DAYS}" STRICT="${STRICT}" python3 - <<'PY'
import concurrent.futures
import glob
import json
import os
import re
import sys
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

offline = os.environ.get("OFFLINE") == "1"
strict = os.environ.get("STRICT") == "1"
cooldown_days = int(os.environ.get("COOLDOWN_DAYS", "14"))
now_utc = datetime.now(timezone.utc)

# --- Lockfile source verification (workspace + imp-desktop when present) ---
cargo_versions = {}
lock_candidates = ["Cargo.lock"]
if os.path.isfile(os.path.join("crates", "imp-desktop", "Cargo.toml")):
    lock_candidates.append(os.path.join("crates", "imp-desktop", "Cargo.lock"))
for lock_path in lock_candidates:
    if not os.path.isfile(lock_path):
        continue
    src = open(lock_path, "r", encoding="utf-8").read()
    blocks = src.split("[[package]]")
    non_crates_io = []
    pkg_count = 0
    for b in blocks[1:]:
        m_name = re.search(r'^name = "([^"]+)"', b, re.M)
        m_ver = re.search(r'^version = "([^"]+)"', b, re.M)
        m_source = re.search(r'^source = "([^"]+)"', b, re.M)
        if not m_name or not m_ver:
            continue
        pkg_count += 1
        name, ver = m_name.group(1), m_ver.group(1)
        if m_source:
            source = m_source.group(1)
            if source != "registry+https://github.com/rust-lang/crates.io-index":
                non_crates_io.append(f"{name}@{ver} ({source})")
            else:
                cargo_versions.setdefault(name, set()).add(ver)
    if non_crates_io:
        print(f"❌ Unexpected non-crates.io source in {lock_path}: {non_crates_io}", file=sys.stderr)
        sys.exit(1)
    print(f"✓ {lock_path} verified ({pkg_count} crates, crates.io-only + workspace members)")

# --- Collect direct Cargo dependencies ---
direct_cargo_names = set()
manifest_paths = ["Cargo.toml", os.path.join("src-tauri", "Cargo.toml")] + sorted(
    glob.glob(os.path.join("crates", "*", "Cargo.toml"))
)
for mpath in manifest_paths:
    if not os.path.isfile(mpath):
        continue
    with open(mpath, "rb") as f:
        data = tomllib.load(f)
    ws_deps = data.get("workspace", {}).get("dependencies", {})
    for dep_name, spec in ws_deps.items():
        pkg = spec.get("package", dep_name) if isinstance(spec, dict) else dep_name
        if not (isinstance(spec, dict) and "path" in spec):
            direct_cargo_names.add(pkg)
    for sec in ("dependencies", "dev-dependencies", "build-dependencies"):
        for dep_name, spec in data.get(sec, {}).items():
            pkg = spec.get("package", dep_name) if isinstance(spec, dict) else dep_name
            if not (isinstance(spec, dict) and "path" in spec):
                direct_cargo_names.add(pkg)
    for _target_expr, tdata in data.get("target", {}).items():
        if not isinstance(tdata, dict):
            continue
        for sec in ("dependencies", "dev-dependencies", "build-dependencies"):
            for dep_name, spec in tdata.get(sec, {}).items():
                pkg = spec.get("package", dep_name) if isinstance(spec, dict) else dep_name
                if not (isinstance(spec, dict) and "path" in spec):
                    direct_cargo_names.add(pkg)

direct_cargo = sorted(
    (name, ver)
    for name in sorted(direct_cargo_names)
    for ver in sorted(cargo_versions.get(name, set()))
)

# --- Lockfile verification & direct npm dependency collection ---
npm_locked = {}
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
        if k.startswith("node_modules/") and ver:
            pkg_name = k[len("node_modules/"):]
            if "/node_modules/" not in pkg_name:
                npm_locked[pkg_name] = ver
    print(f"✓ package-lock.json verified ({len(lock.get('packages', {}))} entries, registry.npmjs.org-only)")

direct_npm_names = set()
for pj in ["package.json", os.path.join("ui", "package.json"), os.path.join("packages", "imp-client", "package.json"), os.path.join("decky-plugin", "package.json")]:
    if not os.path.isfile(pj):
        continue
    pdata = json.load(open(pj, "r", encoding="utf-8"))
    for sec in ("dependencies", "devDependencies"):
        for pkg_name in pdata.get(sec, {}):
            if not pkg_name.startswith("@imp/"):
                direct_npm_names.add(pkg_name)

direct_npm = sorted(
    (name, npm_locked[name])
    for name in sorted(direct_npm_names)
    if name in npm_locked
)

print(f"ℹ Direct dependencies tracked: {len(direct_cargo)} crates.io + {len(direct_npm)} npm")

if offline:
    print(f"ℹ Offline mode: skipped remote {cooldown_days}-day release-age queries")
    sys.exit(0)

def parse_iso_utc(raw_ts: str) -> datetime:
    s = raw_ts.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)

def check_crate_age(item):
    name, ver = item
    url = f"https://crates.io/api/v1/crates/{urllib.parse.quote(name)}/{urllib.parse.quote(ver)}"
    req = urllib.request.Request(url, headers={"User-Agent": "imp-supply-chain-audit/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        created_at = payload.get("version", {}).get("created_at")
        if not created_at:
            return ("err", name, ver, "missing created_at")
        age_days = (now_utc - parse_iso_utc(created_at)).total_seconds() / 86400.0
        return ("ok", f"cargo:{name}", ver, age_days)
    except Exception as exc:
        return ("err", f"cargo:{name}", ver, str(exc))

def check_npm_age(item):
    name, ver = item
    url = f"https://registry.npmjs.org/{urllib.parse.quote(name, safe='@/')}"
    req = urllib.request.Request(url, headers={"User-Agent": "imp-supply-chain-audit/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=6) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
        ts = payload.get("time", {}).get(ver)
        if not ts:
            return ("err", f"npm:{name}", ver, "missing time entry")
        age_days = (now_utc - parse_iso_utc(ts)).total_seconds() / 86400.0
        return ("ok", f"npm:{name}", ver, age_days)
    except Exception as exc:
        return ("err", f"npm:{name}", ver, str(exc))

too_young = []
errors = []
checked = 0
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    futs = [pool.submit(check_crate_age, it) for it in direct_cargo] + [
        pool.submit(check_npm_age, it) for it in direct_npm
    ]
    for fut in concurrent.futures.as_completed(futs):
        kind, pkg, ver, val = fut.result()
        if kind == "ok":
            checked += 1
            if val < cooldown_days:
                too_young.append((pkg, ver, val))
        else:
            errors.append((pkg, ver, val))

print(f"✓ Queried release ages for {checked} direct packages (cooldown >= {cooldown_days}d)")
if errors:
    print(f"⚠ {len(errors)} registry lookups failed (first 3: {errors[:3]})")
if too_young:
    for pkg, ver, age in sorted(too_young):
        print(f"⚠ COOLDOWN VIOLATION: {pkg}@{ver} is only {age:.1f} days old (< {cooldown_days}d)", file=sys.stderr)
    if strict:
        sys.exit(1)
else:
    print(f"✓ All {checked} queried direct dependencies satisfy the {cooldown_days}-day cooldown window")
PY

# 4. cargo-audit / cargo-deny / npm audit
if command -v cargo-audit >/dev/null 2>&1; then
  if [[ "${OFFLINE}" -eq 1 ]]; then
    if [[ -d "${CARGO_HOME:-${HOME}/.cargo}/advisory-db/crates" ]]; then
      cargo audit --no-fetch || [[ "${STRICT}" -eq 0 ]]
    else
      echo "ℹ Offline mode: local advisory-db not cached; skipping cargo audit --no-fetch"
    fi
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
