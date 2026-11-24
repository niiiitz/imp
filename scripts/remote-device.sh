#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Imp (org.imp.player) — Remote Device Helper ("Remote Hands")
# Ad-hoc log inspection, tailing, health checks, and fast branch deploys over SSH
# without requiring a full GitHub release cycle on SteamOS / Bazzite / Steam Deck.
# ==============================================================================

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

read_dotenv_var() {
  local key="$1"
  local env_file="${REPO_ROOT}/.env"
  [[ -f "${env_file}" ]] || return 0
  python3 - "${key}" "${env_file}" <<'PY' 2>/dev/null || true
import sys

key, path = sys.argv[1], sys.argv[2]
with open(path, "r", encoding="utf-8") as f:
    for line in f:
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        k, v = s.split("=", 1)
        if k.strip() == key:
            v = v.strip()
            if len(v) >= 2 and ((v[0] == v[-1] == '"') or (v[0] == v[-1] == "'")):
                v = v[1:-1]
            print(v, end="")
            break
PY
}

usage() {
  cat <<'EOF'
Usage: ./scripts/remote-device.sh [OPTIONS] <subcommand> [args...]

Options (must appear before subcommand):
  -t, --target <target>   SSH target (user@host) or alias: machine | deck | frame
                          Defaults to IMP_REMOTE_HOST from .env
  -p, --port <port>       SSH port (default: IMP_REMOTE_PORT or 22)
  -i, --key <path>        SSH private key (default: IMP_REMOTE_KEY or ~/.ssh/id_ed25519_imp)
  -h, --help              Show this help text

Subcommands:
  check-ssh               Verify passwordless SSH, user systemd bus, journal & dir perms
  status                  Show imp version, service status, :18888 health & Decky state
  logs [N] [--since SPEC] [--grep PAT]
                          Pull last N lines of imp.service user journal (default: 200)
  tail                    Live-tail imp.service user journal (interactive TTY)
  decky-logs [N]          Pull ~/homebrew/logs/imp-decky/* + plugin_loader journal (default: 100)
  deploy-ui               Build ui/dist locally and rsync to ~/.local/share/imp/ui (no restart)
  deploy-decky            Build decky-plugin and stage to decky-staged (and imp-decky if writable)
  deploy-bin [--allow-no-apple-token]
                          Build release imp binary, upload atomically, restart imp.service
  deploy [version]        Run package-release.sh, upload tarball, run install-steamos.sh
  restart                 daemon-reload + restart imp.service and check :18888 health
  exec <cmd...>           Run arbitrary command remotely with user systemd env exported

.env configuration example (gitignored; no sudo password needed):
  IMP_REMOTE_HOST=user@192.168.1.50
  IMP_REMOTE_MACHINE=user@192.168.1.50
  IMP_REMOTE_DECK=deck@steamdeck.local
  IMP_REMOTE_KEY=~/.ssh/id_ed25519_imp
  IMP_REMOTE_PORT=22
EOF
}

TARGET_ARG=""
PORT_ARG=""
KEY_ARG=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    -t|--target)
      [[ $# -ge 2 ]] || { echo "Error: $1 requires an argument" >&2; exit 1; }
      TARGET_ARG="$2"
      shift 2
      ;;
    -p|--port)
      [[ $# -ge 2 ]] || { echo "Error: $1 requires an argument" >&2; exit 1; }
      PORT_ARG="$2"
      shift 2
      ;;
    -i|--key)
      [[ $# -ge 2 ]] || { echo "Error: $1 requires an argument" >&2; exit 1; }
      KEY_ARG="$2"
      shift 2
      ;;
    -h|--help|help)
      usage
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

SUBCMD="${1:-help}"
if [[ "${SUBCMD}" == "help" || "${SUBCMD}" == "-h" || "${SUBCMD}" == "--help" ]]; then
  usage
  exit 0
fi
shift || true

resolve_target() {
  local raw="${TARGET_ARG:-$(read_dotenv_var IMP_REMOTE_HOST)}"
  case "${raw}" in
    machine)
      raw="$(read_dotenv_var IMP_REMOTE_MACHINE)"
      [[ -n "${raw}" ]] || { echo "Error: -t machine requested, but IMP_REMOTE_MACHINE is not set in .env" >&2; exit 1; }
      ;;
    deck)
      raw="$(read_dotenv_var IMP_REMOTE_DECK)"
      [[ -n "${raw}" ]] || { echo "Error: -t deck requested, but IMP_REMOTE_DECK is not set in .env" >&2; exit 1; }
      ;;
    frame)
      raw="$(read_dotenv_var IMP_REMOTE_FRAME)"
      [[ -n "${raw}" ]] || { echo "Error: -t frame requested, but IMP_REMOTE_FRAME is not set in .env" >&2; exit 1; }
      ;;
  esac
  if [[ -z "${raw}" ]]; then
    echo "Error: No remote target specified. Pass -t user@host or set IMP_REMOTE_HOST in .env." >&2
    usage >&2
    exit 1
  fi
  printf '%s' "${raw}"
}

TARGET="$(resolve_target)"
PORT="${PORT_ARG:-$(read_dotenv_var IMP_REMOTE_PORT)}"
PORT="${PORT:-22}"
KEY_PATH="${KEY_ARG:-$(read_dotenv_var IMP_REMOTE_KEY)}"
if [[ -z "${KEY_PATH}" && -f "${HOME}/.ssh/id_ed25519_imp" ]]; then
  KEY_PATH="${HOME}/.ssh/id_ed25519_imp"
fi
if [[ "${KEY_PATH}" == "~/"* ]]; then
  KEY_PATH="${HOME}/${KEY_PATH:2}"
fi

SSH_COMMON_OPTS=(
  -o BatchMode=yes
  -o ConnectTimeout=8
  -o StrictHostKeyChecking=accept-new
)
if [[ -n "${KEY_PATH}" ]]; then
  [[ -f "${KEY_PATH}" ]] || { echo "Error: SSH key not found at ${KEY_PATH}" >&2; exit 1; }
  SSH_COMMON_OPTS+=(-i "${KEY_PATH}")
fi

SSH_ARGS=("${SSH_COMMON_OPTS[@]}" -p "${PORT}")
SCP_ARGS=("${SSH_COMMON_OPTS[@]}" -P "${PORT}")
printf -v RSYNC_RSH '%q ' ssh "${SSH_ARGS[@]}"

REMOTE_USER_ENV='uid=$(id -u); export XDG_RUNTIME_DIR="/run/user/${uid}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/${uid}/bus"; '
REMOTE_STOP_ORPHANS_SH='
systemctl --user stop imp.service 2>/dev/null || true
for pid in $(ps -eo pid=,args= | awk "(\$2 ~ /(^|\/)(imp|simp)\$/ && \$3 == \"--daemon\") {print \$1}"); do
  kill -TERM "${pid}" 2>/dev/null || true
done
sleep 0.3
for pid in $(ps -eo pid=,args= | awk "(\$2 ~ /(^|\/)(imp|simp)\$/ && \$3 == \"--daemon\") {print \$1}"); do
  kill -9 "${pid}" 2>/dev/null || true
done
'

remote_sh() {
  local script="$1"
  local quoted_cmd
  printf -v quoted_cmd '%q' "${REMOTE_USER_ENV}${script}"
  ssh "${SSH_ARGS[@]}" "${TARGET}" "bash -lc ${quoted_cmd}"
}

remote_sh_tty() {
  local script="$1"
  local quoted_cmd
  printf -v quoted_cmd '%q' "${REMOTE_USER_ENV}${script}"
  ssh -tt "${SSH_ARGS[@]}" "${TARGET}" "bash -lc ${quoted_cmd}"
}

bake_build_secrets_into_env() {
  local allow_no_apple="${1:-0}"
  local env_file="${REPO_ROOT}/.env"

  if [[ -z "${SIMP_EMBEDDED_APPLE_DEV_TOKEN:-}" && -s "/tmp/.simp_embedded_jwt" ]]; then
    export SIMP_EMBEDDED_APPLE_DEV_TOKEN="$(cat /tmp/.simp_embedded_jwt)"
  fi
  if [[ -f "${env_file}" && -z "${SIMP_EMBEDDED_APPLE_DEV_TOKEN:-}" ]]; then
    local embedded_jwt
    embedded_jwt="$(ENV_FILE="${env_file}" REPO_ROOT="${REPO_ROOT}" python3 - <<'PY' || true
import base64, json, os, subprocess, time

env = {}
env_path = os.environ["ENV_FILE"]
repo_root = os.environ["REPO_ROOT"]
if os.path.exists(env_path):
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip("'").strip('"')

team_id = env.get("APPLE_TEAM_ID", "")
key_id = env.get("APPLE_KEY_ID", "")
key_path = env.get("APPLE_PRIVATE_KEY_PATH", "")
if (not key_path or not os.path.isfile(key_path)) and key_id:
    local_candidate = os.path.join(repo_root, f"AuthKey_{key_id}.p8")
    if os.path.isfile(local_candidate):
        key_path = local_candidate

if team_id and key_id and key_path and os.path.isfile(key_path):
    now = int(time.time())
    exp = now + 86400 * 150
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
    if [[ -n "${embedded_jwt}" ]]; then
      export SIMP_EMBEDDED_APPLE_DEV_TOKEN="${embedded_jwt}"
      echo "• Baked 150-day ES256 Apple Developer Token into binary"
    fi
  fi

  local sc_id
  sc_id="$(read_dotenv_var SOUNDCLOUD_CLIENT_ID)"
  if [[ -n "${sc_id}" ]]; then
    export SIMP_EMBEDDED_SOUNDCLOUD_CLIENT_ID="${sc_id}"
  fi

  if [[ -z "${SIMP_EMBEDDED_APPLE_DEV_TOKEN:-}" && "${allow_no_apple}" != "1" ]]; then
    echo "Error: SIMP_EMBEDDED_APPLE_DEV_TOKEN not generated (check AuthKey_*.p8 / .env or pass --allow-no-apple-token)." >&2
    exit 1
  fi
}

cmd_check_ssh() {
  echo "Checking SSH connectivity to ${TARGET} (port ${PORT})..."
  if ! ssh "${SSH_ARGS[@]}" "${TARGET}" true >/dev/null 2>&1; then
    echo "✗ Passwordless SSH failed for ${TARGET}." >&2
    echo "  Ensure sshd is enabled remotely (sudo systemctl enable --now sshd) and your public key is in ~/.ssh/authorized_keys." >&2
    exit 1
  fi
  echo "✓ SSH connection succeeded"

  remote_sh '
    echo "• Identity:       $(whoami)@$(uname -n) ($(uname -m))"
    if systemctl --user status >/dev/null 2>&1; then
      echo "✓ systemd --user: reachable"
    else
      echo "✗ systemd --user: unreachable (run once on device: sudo loginctl enable-linger $(whoami))"
    fi
    if id -Gn | tr " " "\n" | grep -qx "systemd-journal"; then
      echo "✓ journal group:  member of systemd-journal (plugin_loader logs readable)"
    else
      echo "ℹ journal group:  not in systemd-journal (run on device for passwordless Decky system logs: sudo usermod -aG systemd-journal $(whoami))"
    fi
    if [[ -d "${HOME}/.local/share/imp" ]]; then
      if [[ -w "${HOME}/.local/share/imp" ]]; then
        echo "✓ imp dir:        ~/.local/share/imp writable"
      else
        echo "✗ imp dir:        ~/.local/share/imp NOT writable by $(whoami)!"
      fi
    elif [[ -w "${HOME}/.local/share" || -w "${HOME}" ]]; then
      echo "ℹ imp dir:        ~/.local/share/imp not created yet (parent is writable)"
    fi
    if [[ -d "${HOME}/homebrew/plugins/imp-decky" ]]; then
      if [[ -w "${HOME}/homebrew/plugins/imp-decky" ]]; then
        echo "✓ decky dir:      ~/homebrew/plugins/imp-decky writable directly"
      else
        echo "ℹ decky dir:      ~/homebrew/plugins/imp-decky root-owned (deploy-decky stages to decky-staged for 5s auto-sync)"
      fi
    else
      echo "ℹ decky dir:      ~/homebrew/plugins/imp-decky not present"
    fi
    if sudo -n systemctl status plugin_loader >/dev/null 2>&1; then
      echo "✓ sudoers hook:   passwordless systemctl status/restart plugin_loader available"
    else
      echo "ℹ sudoers hook:   not configured (optional; Decky auto-syncs from ~/.local/share/imp/decky-staged)"
    fi
  '
}

cmd_status() {
  remote_sh '
    echo "=== Host ==="
    echo "$(whoami)@$(uname -n) | arch=$(uname -m) | $(uname -r)"
    if [[ -x "${HOME}/.local/share/imp/bin/imp" ]]; then
      echo "Binary: $("${HOME}/.local/share/imp/bin/imp" --version 2>/dev/null || echo unknown)"
    else
      echo "Binary: not installed at ~/.local/share/imp/bin/imp"
    fi
    echo "=== systemd --user imp.service ==="
    systemctl --user status imp.service --no-pager -n 10 || true
    echo "=== Daemon :18888 health ==="
    if command -v curl >/dev/null 2>&1; then
      curl -fsS http://127.0.0.1:18888/api/v1/system/perf || echo "not reachable"
      echo ""
    fi
    echo "=== Directories & Decky ==="
    ls -ld "${HOME}/.local/share/imp/ui" "${HOME}/.local/share/imp/decky-staged" "${HOME}/homebrew/plugins/imp-decky" 2>/dev/null || true
    echo "=== Recent Errors (imp.service) ==="
    journalctl --user -u imp -n 15 -p err --no-pager 2>/dev/null || true
  '
}

cmd_logs() {
  local lines="200"
  local since_spec=""
  local grep_pat=""
  if [[ $# -gt 0 && "$1" =~ ^[0-9]+$ ]]; then
    lines="$1"
    shift
  fi
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --since)
        [[ $# -ge 2 ]] || { echo "Error: --since requires an argument" >&2; exit 1; }
        since_spec="$2"
        shift 2
        ;;
      --grep)
        [[ $# -ge 2 ]] || { echo "Error: --grep requires an argument" >&2; exit 1; }
        grep_pat="$2"
        shift 2
        ;;
      *)
        echo "Error: Unknown logs option: $1" >&2
        exit 1
        ;;
    esac
  done

  local jcmd="journalctl --user -u imp -n $(printf '%q' "${lines}") --no-pager"
  if [[ -n "${since_spec}" ]]; then
    jcmd+=" --since $(printf '%q' "${since_spec}")"
  fi
  if [[ -n "${grep_pat}" ]]; then
    jcmd+=" --grep $(printf '%q' "${grep_pat}")"
  fi
  remote_sh "${jcmd}"
}

cmd_tail() {
  echo "Live-tailing imp.service logs on ${TARGET} (Ctrl+C to stop)..."
  remote_sh_tty 'exec journalctl --user -u imp -f'
}

cmd_decky_logs() {
  local lines="${1:-100}"
  [[ "${lines}" =~ ^[0-9]+$ ]] || { echo "Error: decky-logs line count must be an integer" >&2; exit 1; }
  local q_lines
  printf -v q_lines '%q' "${lines}"
  remote_sh "
    echo '=== ~/homebrew/logs/imp-decky/ ==='
    if [[ -d \"\${HOME}/homebrew/logs/imp-decky\" ]]; then
      ls -lt \"\${HOME}/homebrew/logs/imp-decky\" | head -n 10
      latest=\$(ls -t \"\${HOME}/homebrew/logs/imp-decky\"/* 2>/dev/null | head -n 1 || true)
      if [[ -n \"\${latest}\" && -f \"\${latest}\" ]]; then
        echo \"--- tail -n ${lines} \${latest} ---\"
        tail -n ${q_lines} \"\${latest}\"
      fi
    else
      echo 'No ~/homebrew/logs/imp-decky directory present.'
    fi
    echo '=== journalctl -u plugin_loader ==='
    if ! journalctl -u plugin_loader -n ${q_lines} --no-pager 2>/dev/null; then
      echo 'Could not read plugin_loader system journal. On device run: sudo usermod -aG systemd-journal \$(whoami) (then re-login).' >&2
    fi
  "
}

cmd_deploy_ui() {
  cd "${REPO_ROOT}"
  echo "1/2 Building production UI (ui/dist)..."
  npm run build:ui
  echo "2/2 Syncing ui/dist -> ${TARGET}:~/.local/share/imp/ui/..."
  local remote_home
  remote_home="$(remote_sh 'mkdir -p "${HOME}/.local/share/imp/ui" && printf %s "${HOME}"')"
  rsync -az --delete -e "${RSYNC_RSH}" "${REPO_ROOT}/ui/dist/" "${TARGET}:${remote_home}/.local/share/imp/ui/"
  echo "✓ UI synced cleanly (daemon serves from disk; refresh Imp UI view — no daemon restart needed)."
}

cmd_deploy_decky() {
  cd "${REPO_ROOT}"
  echo "1/3 Building Decky plugin bundle..."
  npm run build:decky
  local stage_tmp remote_home
  stage_tmp="$(mktemp -d /tmp/imp-decky-stage.XXXXXX)"
  trap 'rm -rf "${stage_tmp}"' RETURN
  mkdir -p "${stage_tmp}/dist"
  cp "${REPO_ROOT}/decky-plugin/plugin.json" "${stage_tmp}/"
  cp "${REPO_ROOT}/decky-plugin/package.json" "${stage_tmp}/"
  cp "${REPO_ROOT}/decky-plugin/main.py" "${stage_tmp}/"
  cp "${REPO_ROOT}/decky-plugin/dist/"* "${stage_tmp}/dist/"
  chmod 0755 "${stage_tmp}" "${stage_tmp}/dist" "${stage_tmp}/main.py"
  chmod 0644 "${stage_tmp}/plugin.json" "${stage_tmp}/package.json" "${stage_tmp}/dist/"*

  echo "2/3 Syncing Decky bundle -> ${TARGET}:~/.local/share/imp/decky-staged/..."
  remote_home="$(remote_sh 'mkdir -p "${HOME}/.local/share/imp/decky-staged/dist" && printf %s "${HOME}"')"
  rsync -az --delete -e "${RSYNC_RSH}" "${stage_tmp}/" "${TARGET}:${remote_home}/.local/share/imp/decky-staged/"

  echo "3/3 Updating ~/homebrew/plugins/imp-decky (direct if writable, else auto-sync)..."
  remote_sh '
    staged="${HOME}/.local/share/imp/decky-staged"
    target="${HOME}/homebrew/plugins/imp-decky"
    chmod 0755 "${staged}" "${staged}/dist" "${staged}/main.py" 2>/dev/null || true
    chmod 0644 "${staged}/plugin.json" "${staged}/package.json" "${staged}/dist/"* 2>/dev/null || true
    if [[ -w "${target}" || ( -d "${HOME}/homebrew/plugins" && -w "${HOME}/homebrew/plugins" ) ]]; then
      mkdir -p "${target}/dist"
      cp -f "${staged}/plugin.json" "${staged}/package.json" "${staged}/main.py" "${target}/"
      cp -f "${staged}/dist/"* "${target}/dist/"
      chmod 0755 "${target}" "${target}/dist" "${target}/main.py" 2>/dev/null || true
      chmod 0644 "${target}/plugin.json" "${target}/package.json" "${target}/dist/"* 2>/dev/null || true
      echo "✓ Updated ~/homebrew/plugins/imp-decky directly"
    else
      echo "ℹ ~/homebrew/plugins/imp-decky is root-owned; Decky Loader main.py auto-syncs from decky-staged within ~5s"
    fi
    if sudo -n systemctl restart plugin_loader >/dev/null 2>&1; then
      echo "✓ Restarted plugin_loader via passwordless sudoers hook"
    fi
  '
}

cmd_deploy_bin() {
  local allow_no_apple="0"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --allow-no-apple-token)
        allow_no_apple="1"
        shift
        ;;
      *)
        echo "Error: Unknown deploy-bin option: $1" >&2
        exit 1
        ;;
    esac
  done

  cd "${REPO_ROOT}"
  bake_build_secrets_into_env "${allow_no_apple}"

  local host_arch remote_arch target_arch built_bin
  host_arch="$(uname -m)"
  remote_arch="$(remote_sh 'uname -m')"
  target_arch="${IMP_TARGET_ARCH:-${SIMP_TARGET_ARCH:-${remote_arch:-${host_arch}}}}"

  export PATH="/usr/local/opt/node@24/bin:/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:${HOME}/.cargo/bin:${PATH}"
  local cargo_bin="${CARGO_BIN:-$(command -v cargo || echo "${HOME}/.cargo/bin/cargo")}"

  echo "1/3 Building release imp binary (target arch: ${target_arch})..."
  if [[ "${target_arch}" != "${host_arch}" ]]; then
    local rust_target="${target_arch}-unknown-linux-gnu"
    chmod +x "${REPO_ROOT}/packaging/scripts/setup-aarch64-toolchain.sh"
    local toolchain_bin toolchain_lib
    toolchain_bin="$("${REPO_ROOT}/packaging/scripts/setup-aarch64-toolchain.sh" "${target_arch}")"
    toolchain_lib="${HOME}/.cache/simp-toolchain/lib-${target_arch}"
    mkdir -p /tmp/simp-zig-cache
    export ZIG_GLOBAL_CACHE_DIR=/tmp/simp-zig-cache
    export ZIG_LOCAL_CACHE_DIR=/tmp/simp-zig-cache
    export PATH="${toolchain_bin}:${PATH}"
    if [[ "${target_arch}" == "aarch64" ]]; then
      export CC_aarch64_unknown_linux_gnu="${toolchain_bin}/aarch64-linux-gnu-gcc"
      export CXX_aarch64_unknown_linux_gnu="${toolchain_bin}/aarch64-linux-gnu-gcc"
      export AR_aarch64_unknown_linux_gnu="${toolchain_bin}/aarch64-linux-gnu-ar"
      export CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER="${toolchain_bin}/aarch64-linux-gnu-gcc"
      export PKG_CONFIG_ALLOW_CROSS=1
      export PKG_CONFIG_PATH_aarch64_unknown_linux_gnu="${toolchain_lib}/pkgconfig"
      export PKG_CONFIG_LIBDIR_aarch64_unknown_linux_gnu="${toolchain_lib}/pkgconfig"
    else
      export CC_x86_64_unknown_linux_gnu="${toolchain_bin}/x86_64-linux-gnu-gcc"
      export CXX_x86_64_unknown_linux_gnu="${toolchain_bin}/x86_64-linux-gnu-gcc"
      export AR_x86_64_unknown_linux_gnu="${toolchain_bin}/x86_64-linux-gnu-ar"
      export CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER="${toolchain_bin}/x86_64-linux-gnu-gcc"
      export PKG_CONFIG_ALLOW_CROSS=1
      export PKG_CONFIG_PATH_x86_64_unknown_linux_gnu="${toolchain_lib}/pkgconfig"
      export PKG_CONFIG_LIBDIR_x86_64_unknown_linux_gnu="${toolchain_lib}/pkgconfig"
    fi
    "${cargo_bin}" build --release -p imp --target "${rust_target}" --offline
    built_bin="${REPO_ROOT}/target/${rust_target}/release/imp"
  else
    "${cargo_bin}" build --release -p imp --offline
    built_bin="${REPO_ROOT}/target/release/imp"
  fi

  echo "2/3 Uploading binary & unit to ${TARGET}..."
  local remote_home
  remote_home="$(remote_sh 'mkdir -p "${HOME}/.local/share/imp/bin" "${HOME}/.config/systemd/user" && printf %s "${HOME}"')"
  scp "${SCP_ARGS[@]}" "${built_bin}" "${TARGET}:${remote_home}/.local/share/imp/bin/imp.new"
  if [[ -f "${REPO_ROOT}/packaging/systemd/imp.service" ]]; then
    scp "${SCP_ARGS[@]}" "${REPO_ROOT}/packaging/systemd/imp.service" "${TARGET}:${remote_home}/.config/systemd/user/imp.service"
  fi

  echo "3/3 Swapping binary atomically and restarting imp.service..."
  remote_sh "
    chmod 0755 \"\${HOME}/.local/share/imp/bin/imp.new\"
    mv -f \"\${HOME}/.local/share/imp/bin/imp.new\" \"\${HOME}/.local/share/imp/bin/imp\"
    chmod 0644 \"\${HOME}/.config/systemd/user/imp.service\" 2>/dev/null || true
    systemctl --user daemon-reload
    ${REMOTE_STOP_ORPHANS_SH}
    systemctl --user restart imp.service
    sleep 1
    echo \"Version: \$(\"\${HOME}/.local/share/imp/bin/imp\" --version 2>/dev/null || echo unknown)\"
    if command -v curl >/dev/null 2>&1; then
      curl -fsS http://127.0.0.1:18888/api/v1/system/perf
      echo \"\"
    fi
  "
  echo "✓ Binary deployed and imp.service restarted on ${TARGET}."
}

cmd_deploy() {
  local version_arg="${1:-}"
  cd "${REPO_ROOT}"
  local host_arch remote_arch target_arch
  host_arch="$(uname -m)"
  remote_arch="$(remote_sh 'uname -m')"
  target_arch="${IMP_TARGET_ARCH:-${SIMP_TARGET_ARCH:-${remote_arch:-${host_arch}}}}"

  echo "1/3 Building full release tarball (arch: ${target_arch})..."
  IMP_TARGET_ARCH="${target_arch}" "${REPO_ROOT}/packaging/scripts/package-release.sh" ${version_arg:+"${version_arg}"}

  local tarball="${REPO_ROOT}/dist/imp-steamos-userland-${target_arch}.tar.gz"
  [[ -f "${tarball}" ]] || tarball="${REPO_ROOT}/dist/imp-steamos-userland.tar.gz"

  echo "2/3 Uploading tarball to ${TARGET} and running install-steamos.sh..."
  scp "${SCP_ARGS[@]}" "${tarball}" "${TARGET}:/tmp/imp-steamos-userland.tar.gz"
  remote_sh '
    rm -rf /tmp/imp-steamos-userland
    tar -xzf /tmp/imp-steamos-userland.tar.gz -C /tmp
    /tmp/imp-steamos-userland/install-steamos.sh
    rm -rf /tmp/imp-steamos-userland /tmp/imp-steamos-userland.tar.gz
  '
  echo "3/3 Verifying remote status..."
  cmd_status
}

cmd_restart() {
  remote_sh "
    systemctl --user daemon-reload
    ${REMOTE_STOP_ORPHANS_SH}
    systemctl --user restart imp.service
    sleep 1
    systemctl --user is-active imp.service
    if command -v curl >/dev/null 2>&1; then
      curl -fsS http://127.0.0.1:18888/api/v1/system/perf
      echo \"\"
    fi
  "
}

cmd_exec() {
  [[ $# -gt 0 ]] || { echo "Error: exec requires a command" >&2; exit 1; }
  remote_sh "$*"
}

case "${SUBCMD}" in
  check-ssh)    cmd_check_ssh "$@" ;;
  status)       cmd_status "$@" ;;
  logs)         cmd_logs "$@" ;;
  tail)         cmd_tail "$@" ;;
  decky-logs)   cmd_decky_logs "$@" ;;
  deploy-ui)    cmd_deploy_ui "$@" ;;
  deploy-decky) cmd_deploy_decky "$@" ;;
  deploy-bin)   cmd_deploy_bin "$@" ;;
  deploy)       cmd_deploy "$@" ;;
  restart)      cmd_restart "$@" ;;
  exec)         cmd_exec "$@" ;;
  *)
    echo "Error: Unknown subcommand '${SUBCMD}'" >&2
    usage >&2
    exit 1
    ;;
esac
