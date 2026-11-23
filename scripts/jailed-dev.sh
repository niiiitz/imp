#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# IMP Bubblewrap (bwrap) Dev & Build Jail
# Isolates `cargo`, `npm`, and build scripts from host secrets (~/.ssh, ~/.aws,
# ~/.gnupg, /mnt/c Windows drive, .env, *.p8 signing keys).
#
# Usage:
#   ./scripts/jailed-dev.sh cargo test --workspace --offline
#   ./scripts/jailed-dev.sh npm run build:ui
#   ./scripts/jailed-dev.sh --net cargo fetch
#   ./scripts/jailed-dev.sh --net npm ci
# ==============================================================================

ALLOW_NET=0
if [[ "${1:-}" == "--net" ]]; then
  ALLOW_NET=1
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 [--net] <command> [args...]" >&2
  exit 2
fi

if ! command -v bwrap >/dev/null 2>&1; then
  echo "ERROR: bubblewrap (bwrap) is not installed. Install via: sudo apt install bubblewrap" >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
JAIL_HOME="${HOME}/.cache/imp-dev-jail-home"
mkdir -p "${JAIL_HOME}" "${HOME}/.cargo" "${HOME}/.rustup" "${HOME}/.npm"

BWRAP_ARGS=(
  --die-with-parent
  --unshare-pid
  --unshare-ipc
  --unshare-uts
  --hostname imp-dev-jail
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --tmpfs /run
  --ro-bind /usr /usr
  --ro-bind /bin /bin
  --ro-bind /lib /lib
  --ro-bind /etc /etc
  --bind "${JAIL_HOME}" /home/dev
  --ro-bind "${HOME}/.rustup" /home/dev/.rustup
  --bind "${HOME}/.cargo" /home/dev/.cargo
  --bind "${HOME}/.npm" /home/dev/.npm
  --bind "${REPO_ROOT}" /workspace
  --chdir /workspace
  --clearenv
  --setenv HOME /home/dev
  --setenv USER dev
  --setenv PATH "/home/dev/.cargo/bin:/usr/local/bin:/usr/bin:/bin"
  --setenv CARGO_HOME /home/dev/.cargo
  --setenv RUSTUP_HOME /home/dev/.rustup
  --setenv npm_config_cache /home/dev/.npm
  --setenv TERM "${TERM:-xterm-256color}"
)

if [[ -d /lib64 ]]; then
  BWRAP_ARGS+=(--ro-bind /lib64 /lib64)
fi

if [[ -d /usr/local ]]; then
  BWRAP_ARGS+=(--ro-bind /usr/local /usr/local)
fi

# Pass through NVM/Node bin directory read-only if node is outside /usr/bin
NODE_BIN_DIR="$(dirname "$(command -v node 2>/dev/null || echo /usr/bin/node)")"
if [[ -d "${NODE_BIN_DIR}" && "${NODE_BIN_DIR}" != /usr/* && "${NODE_BIN_DIR}" != /bin ]]; then
  NODE_ROOT="$(dirname "${NODE_BIN_DIR}")"
  BWRAP_ARGS+=(--ro-bind "${NODE_ROOT}" "${NODE_ROOT}")
  BWRAP_ARGS+=(--setenv PATH "${NODE_BIN_DIR}:/home/dev/.cargo/bin:/usr/local/bin:/usr/bin:/bin")
fi

# Mask private keys and .env inside /workspace so untrusted build.rs / postinstall cannot read them
if [[ -f "${REPO_ROOT}/.env" ]]; then
  BWRAP_ARGS+=(--ro-bind /dev/null /workspace/.env)
fi
shopt -s nullglob
for keyfile in "${REPO_ROOT}"/*.p8 "${REPO_ROOT}"/AuthKey_*; do
  if [[ -f "${keyfile}" ]]; then
    BWRAP_ARGS+=(--ro-bind /dev/null "/workspace/$(basename "${keyfile}")")
  fi
done
shopt -u nullglob

if [[ "${ALLOW_NET}" -eq 0 ]]; then
  BWRAP_ARGS+=(--unshare-net)
fi

exec bwrap "${BWRAP_ARGS[@]}" -- "$@"
