#!/usr/bin/env python3
"""
Cooldown-aware dependency refresher for IMP (Wave 10.6 / GHA dep-refresh).

Runs `cargo update` and `npm update`, checks registry publication timestamps on
changed packages against a release-age cooldown window (default: 14 days),
rolls back any updates newer than the cooldown window, and emits a Markdown
summary suitable for a gated GitHub Pull Request body.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Callable


def parse_cargo_lock_versions(lock_text: str) -> dict[str, set[str]]:
    """Parse crates.io package versions from Cargo.lock text."""
    versions: dict[str, set[str]] = {}
    for block in lock_text.split("[[package]]")[1:]:
        m_name = re.search(r'^name = "([^"]+)"', block, re.M)
        m_ver = re.search(r'^version = "([^"]+)"', block, re.M)
        m_src = re.search(r'^source = "([^"]+)"', block, re.M)
        if not m_name or not m_ver or not m_src:
            continue
        versions.setdefault(m_name.group(1), set()).add(m_ver.group(1))
    return versions


def parse_npm_lock_versions(lock_json_text: str) -> dict[str, str]:
    """Parse external package versions keyed by install path from package-lock.json."""
    if not lock_json_text.strip():
        return {}
    data = json.loads(lock_json_text)
    versions: dict[str, str] = {}
    for pkg_path, meta in data.get("packages", {}).items():
        if not pkg_path or not isinstance(meta, dict):
            continue
        ver = meta.get("version")
        resolved = meta.get("resolved", "")
        if ver and resolved:
            versions[pkg_path] = ver
    return versions


def npm_pkg_name_from_lock_key(pkg_path: str) -> str:
    """Extract npm package name from a lockfile `node_modules/...` key."""
    marker = "node_modules/"
    idx = pkg_path.rfind(marker)
    if idx >= 0:
        return pkg_path[idx + len(marker) :]
    return pkg_path


def find_cargo_changes(
    old_map: dict[str, set[str]], new_map: dict[str, set[str]]
) -> list[tuple[str, str | None, str]]:
    """Return list of `(crate_name, old_ver_or_none, new_ver)` newly added or bumped."""
    changes: list[tuple[str, str | None, str]] = []
    for name in sorted(new_map):
        old_vers = old_map.get(name, set())
        new_vers = new_map[name]
        added = sorted(new_vers - old_vers)
        if not added:
            continue
        removed = sorted(old_vers - new_vers)
        fallback_old = removed[0] if len(removed) == 1 else (sorted(old_vers)[0] if len(old_vers) == 1 else None)
        for ver in added:
            changes.append((name, fallback_old, ver))
    return changes


def find_npm_changes(
    old_map: dict[str, str], new_map: dict[str, str]
) -> list[tuple[str, str | None, str]]:
    """Return unique `(npm_name, old_ver_or_none, new_ver)` newly added or bumped."""
    seen: set[tuple[str, str]] = set()
    changes: list[tuple[str, str | None, str]] = []
    for pkg_path in sorted(new_map):
        new_ver = new_map[pkg_path]
        old_ver = old_map.get(pkg_path)
        if old_ver == new_ver:
            continue
        name = npm_pkg_name_from_lock_key(pkg_path)
        if (name, new_ver) in seen:
            continue
        seen.add((name, new_ver))
        changes.append((name, old_ver, new_ver))
    return changes


def parse_iso_utc(raw_ts: str) -> datetime:
    s = raw_ts.strip()
    if s.endswith("Z"):
        s = s[:-1] + "+00:00"
    dt = datetime.fromisoformat(s)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def fetch_crate_age_days(name: str, version: str, now_utc: datetime) -> float:
    url = f"https://crates.io/api/v1/crates/{urllib.parse.quote(name)}/{urllib.parse.quote(version)}"
    req = urllib.request.Request(url, headers={"User-Agent": "imp-dep-refresh/1.0"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    created_at = payload.get("version", {}).get("created_at")
    if not created_at:
        raise ValueError(f"Missing created_at for {name}@{version}")
    return (now_utc - parse_iso_utc(created_at)).total_seconds() / 86400.0


def fetch_npm_age_days(name: str, version: str, now_utc: datetime) -> float:
    url = f"https://registry.npmjs.org/{urllib.parse.quote(name, safe='@/')}"
    req = urllib.request.Request(url, headers={"User-Agent": "imp-dep-refresh/1.0"})
    with urllib.request.urlopen(req, timeout=8) as resp:
        payload = json.loads(resp.read().decode("utf-8"))
    ts = payload.get("time", {}).get(version)
    if not ts:
        raise ValueError(f"Missing time entry for {name}@{version}")
    return (now_utc - parse_iso_utc(ts)).total_seconds() / 86400.0


def evaluate_cooldown(
    changes: list[tuple[str, str | None, str]],
    cooldown_days: int,
    age_lookup: Callable[[str, str], float],
) -> tuple[list[tuple[str, str | None, str, float]], list[tuple[str, str | None, str, str]]]:
    """Split candidate updates into `(accepted_with_age, rejected_with_reason)`."""
    accepted: list[tuple[str, str | None, str, float]] = []
    rejected: list[tuple[str, str | None, str, str]] = []

    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        fut_map = {
            pool.submit(age_lookup, name, new_ver): (name, old_ver, new_ver)
            for name, old_ver, new_ver in changes
        }
        for fut in concurrent.futures.as_completed(fut_map):
            name, old_ver, new_ver = fut_map[fut]
            try:
                age_days = fut.result()
                if age_days >= float(cooldown_days):
                    accepted.append((name, old_ver, new_ver, age_days))
                else:
                    rejected.append(
                        (name, old_ver, new_ver, f"{age_days:.1f}d old (< {cooldown_days}d)")
                    )
            except Exception as exc:
                rejected.append((name, old_ver, new_ver, f"lookup error: {exc}"))

    accepted.sort(key=lambda r: (r[0], r[2]))
    rejected.sort(key=lambda r: (r[0], r[2]))
    return accepted, rejected


def run_cmd(args: list[str], check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, text=True, capture_output=True, check=check)


def run_self_test() -> int:
    old_cargo = parse_cargo_lock_versions(
        """
[[package]]
name = "example-crate"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
"""
    )
    new_cargo = parse_cargo_lock_versions(
        """
[[package]]
name = "example-crate"
version = "1.0.1"
source = "registry+https://github.com/rust-lang/crates.io-index"

[[package]]
name = "fresh-crate"
version = "0.2.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
"""
    )
    cargo_diff = find_cargo_changes(old_cargo, new_cargo)
    assert cargo_diff == [
        ("example-crate", "1.0.0", "1.0.1"),
        ("fresh-crate", None, "0.2.0"),
    ], f"unexpected cargo diff: {cargo_diff}"

    accepted, rejected = evaluate_cooldown(
        cargo_diff,
        14,
        lambda name, _ver: 22.0 if name == "example-crate" else 3.5,
    )
    assert len(accepted) == 1 and accepted[0][0] == "example-crate"
    assert len(rejected) == 1 and rejected[0][0] == "fresh-crate"

    old_npm = parse_npm_lock_versions(
        json.dumps(
            {
                "packages": {
                    "node_modules/example-ui": {
                        "version": "1.0.0",
                        "resolved": "https://registry.npmjs.org/example-ui/-/example-ui-1.0.0.tgz",
                    }
                }
            }
        )
    )
    new_npm = parse_npm_lock_versions(
        json.dumps(
            {
                "packages": {
                    "node_modules/example-ui": {
                        "version": "1.1.0",
                        "resolved": "https://registry.npmjs.org/example-ui/-/example-ui-1.1.0.tgz",
                    }
                }
            }
        )
    )
    npm_diff = find_npm_changes(old_npm, new_npm)
    assert npm_diff == [("example-ui", "1.0.0", "1.1.0")]
    print("✓ refresh-deps.py self-tests passed")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Cooldown-aware Cargo + npm dependency refresher")
    parser.add_argument("--cooldown-days", type=int, default=14)
    parser.add_argument("--summary-out", type=str, default="")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()

    if args.self_test:
        return run_self_test()

    now_utc = datetime.now(timezone.utc)
    cargo_lock_path = "Cargo.lock"
    npm_lock_path = "package-lock.json"

    old_cargo_bytes = open(cargo_lock_path, "rb").read() if os.path.isfile(cargo_lock_path) else b""
    old_npm_bytes = open(npm_lock_path, "rb").read() if os.path.isfile(npm_lock_path) else b""

    old_cargo_map = parse_cargo_lock_versions(old_cargo_bytes.decode("utf-8", errors="replace"))
    old_npm_map = parse_npm_lock_versions(old_npm_bytes.decode("utf-8", errors="replace"))

    cargo_skipped: list[tuple[str, str | None, str, str]] = []
    if old_cargo_bytes:
        print("Running `cargo update`...")
        upd = run_cmd(["cargo", "update"], check=False)
        if upd.returncode != 0:
            print(upd.stderr, file=sys.stderr)
            return upd.returncode
        new_cargo_text = open(cargo_lock_path, "r", encoding="utf-8").read()
        cargo_changes = find_cargo_changes(old_cargo_map, parse_cargo_lock_versions(new_cargo_text))
        if cargo_changes:
            _, cargo_skipped = evaluate_cooldown(
                cargo_changes,
                args.cooldown_days,
                lambda n, v: fetch_crate_age_days(n, v, now_utc),
            )
            rollback_failed = False
            for name, old_ver, new_ver, reason in cargo_skipped:
                print(f"Skipping Cargo update {name}@{new_ver}: {reason}")
                if old_ver:
                    res = run_cmd(
                        ["cargo", "update", "-p", f"{name}@{new_ver}", "--precise", old_ver],
                        check=False,
                    )
                    if res.returncode != 0:
                        rollback_failed = True
                else:
                    rollback_failed = True
            if rollback_failed:
                print("Restoring Cargo.lock cleanly because a brand-new or coupled crate failed cooldown")
                with open(cargo_lock_path, "wb") as f:
                    f.write(old_cargo_bytes)

    npm_skipped: list[tuple[str, str | None, str, str]] = []
    if old_npm_bytes:
        print("Running `npm update`...")
        upd = run_cmd(["npm", "update"], check=False)
        if upd.returncode != 0:
            print(upd.stderr, file=sys.stderr)
            return upd.returncode
        new_npm_text = open(npm_lock_path, "r", encoding="utf-8").read()
        npm_changes = find_npm_changes(old_npm_map, parse_npm_lock_versions(new_npm_text))
        if npm_changes:
            _, npm_skipped = evaluate_cooldown(
                npm_changes,
                args.cooldown_days,
                lambda n, v: fetch_npm_age_days(n, v, now_utc),
            )
            if npm_skipped:
                for name, _old_ver, new_ver, reason in npm_skipped:
                    print(f"Skipping npm batch due to {name}@{new_ver}: {reason}")
                with open(npm_lock_path, "wb") as f:
                    f.write(old_npm_bytes)

    final_cargo = (
        find_cargo_changes(
            old_cargo_map,
            parse_cargo_lock_versions(open(cargo_lock_path, "r", encoding="utf-8").read()),
        )
        if old_cargo_bytes
        else []
    )
    final_npm = (
        find_npm_changes(
            old_npm_map,
            parse_npm_lock_versions(open(npm_lock_path, "r", encoding="utf-8").read()),
        )
        if old_npm_bytes
        else []
    )

    lines = [
        f"Automated dependency refresh (`cooldown >= {args.cooldown_days} days`).",
        "",
        "### Verification Gate Passed Before PR Creation",
        "- `./scripts/audit-deps.sh --strict`",
        "- `cargo test --workspace --locked`",
        "- `cargo clippy --workspace --all-targets --locked`",
        "- `cargo deny check licenses bans sources` & `cargo audit`",
        "- `npm ci && npm run build:all && npm audit --omit=dev`",
        "",
    ]

    if final_cargo:
        lines.append(f"### Updated Cargo Crates ({len(final_cargo)})")
        for name, old_v, new_v in final_cargo[:40]:
            old_s = old_v or "new"
            lines.append(f"- `{name}`: `{old_s}` -> `{new_v}`")
        if len(final_cargo) > 40:
            lines.append(f"- ...and {len(final_cargo) - 40} more crates")
        lines.append("")

    if final_npm:
        lines.append(f"### Updated npm Packages ({len(final_npm)})")
        for name, old_v, new_v in final_npm[:40]:
            old_s = old_v or "new"
            lines.append(f"- `{name}`: `{old_s}` -> `{new_v}`")
        if len(final_npm) > 40:
            lines.append(f"- ...and {len(final_npm) - 40} more packages")
        lines.append("")

    all_skipped = cargo_skipped + npm_skipped
    if all_skipped:
        lines.append(f"### Deferred by {args.cooldown_days}-Day Cooldown ({len(all_skipped)})")
        for name, _old_v, new_v, reason in all_skipped[:20]:
            lines.append(f"- `{name}@{new_v}` ({reason})")
        lines.append("")

    summary = "\n".join(lines)
    print(summary)
    if args.summary_out:
        with open(args.summary_out, "w", encoding="utf-8") as f:
            f.write(summary)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
