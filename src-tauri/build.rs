use std::path::PathBuf;
use std::process::Command;

fn main() {
    println!("cargo::rustc-check-cfg=cfg(has_embedded_webview2_loader)");
    println!("cargo:rerun-if-changed=../packaging/windows/simp.ico");
    println!("cargo:rerun-if-changed=../packaging/windows/simp.rc");
    println!("cargo:rerun-if-changed=../packaging/windows/simp.res");
    println!("cargo:rerun-if-changed=../packaging/macos/Info.plist");

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
        let plist_path = manifest_dir.join("../packaging/macos/Info.plist");
        if plist_path.is_file() {
            println!(
                "cargo:rustc-link-arg-bins=-Wl,-sectcreate,__TEXT,__info_plist,{}",
                plist_path.display()
            );
        }
    }

    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap_or_default());
        let win_dir = manifest_dir.join("../packaging/windows");
        let rc_path = win_dir.join("simp.rc");
        let prebuilt_res = win_dir.join("simp.res");
        let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap_or_else(|_| "/tmp".to_string()));
        let out_coff = out_dir.join("simp_res.o");
        let out_res = out_dir.join("simp.res");

        let mut linked_artifact: Option<PathBuf> = None;

        // 1. Prefer `x86_64-w64-mingw32-windres -O coff` when building with GNU binutils / MinGW-w64
        //    (e.g. on macOS `/usr/local/bin/x86_64-w64-mingw32-gcc`), since GNU `ld` requires a COFF
        //    object file (`simp_res.o`) rather than a raw `.res` binary.
        if rc_path.is_file() {
            for windres_bin in [
                "x86_64-w64-mingw32-windres",
                "/usr/local/bin/x86_64-w64-mingw32-windres",
                "/opt/homebrew/bin/x86_64-w64-mingw32-windres",
            ] {
                if Command::new(windres_bin)
                    .current_dir(&win_dir)
                    .args(["-i", "simp.rc", "-O", "coff", "-o"])
                    .arg(&out_coff)
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
                {
                    linked_artifact = Some(out_coff.clone());
                    break;
                }
            }
        }

        // 2. Fallback to `zig rc` when using `zig cc` as the MinGW linker (e.g. on Linux/WSL)
        if linked_artifact.is_none() && rc_path.is_file() {
            if let Some(home) = std::env::var_os("HOME") {
                for slug in [
                    "zig-linux-x86_64-0.13.0",
                    "zig-linux-aarch64-0.13.0",
                    "zig-macos-aarch64-0.13.0",
                    "zig-macos-x86_64-0.13.0",
                ] {
                    let zig_bin = PathBuf::from(&home)
                        .join(".cache/simp-toolchain")
                        .join(slug)
                        .join("zig");
                    if zig_bin.is_file() {
                        let _ = std::fs::create_dir_all("/tmp/simp-zig-cache");
                        if Command::new(&zig_bin)
                            .current_dir(&win_dir)
                            .env("ZIG_GLOBAL_CACHE_DIR", "/tmp/simp-zig-cache")
                            .env("ZIG_LOCAL_CACHE_DIR", "/tmp/simp-zig-cache")
                            .args(["rc", "--", "simp.rc"])
                            .arg(&out_res)
                            .status()
                            .map(|s| s.success())
                            .unwrap_or(false)
                        {
                            linked_artifact = Some(out_res.clone());
                            break;
                        }
                    }
                }
            }
        }

        if linked_artifact.is_none() && prebuilt_res.is_file() {
            let _ = std::fs::copy(&prebuilt_res, &out_res);
            if out_res.is_file() {
                linked_artifact = Some(out_res);
            }
        }

        if let Some(artifact) = linked_artifact {
            println!("cargo:rustc-link-arg-bins={}", artifact.display());
        }

        // Locate WebView2Loader.dll from webview2-com-sys build output or Cargo registry cache
        // and copy it into OUT_DIR for optional runtime embedding (without hard-linking the DLL
        // into the PE import table).
        let target_arch_dir = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
            Ok("x86_64") => Some("x64"),
            Ok("aarch64") => Some("arm64"),
            Ok("x86") => Some("x86"),
            _ => None,
        };
        if let Some(arch_dir) = target_arch_dir {
            let mut found_loader: Option<PathBuf> = None;

            // Candidate 1: sibling Cargo build dirs `<out_dir>/../../webview2-com-sys-*/out/<arch>/WebView2Loader.dll`
            if let Some(build_root) = out_dir.parent().and_then(|p| p.parent()) {
                if let Ok(entries) = std::fs::read_dir(build_root) {
                    for entry in entries.flatten() {
                        let name = entry.file_name();
                        if name.to_string_lossy().starts_with("webview2-com-sys-") {
                            let cand = entry
                                .path()
                                .join("out")
                                .join(arch_dir)
                                .join("WebView2Loader.dll");
                            if cand.is_file() {
                                found_loader = Some(cand);
                                break;
                            }
                        }
                    }
                }
            }

            // Candidate 2: `${CARGO_HOME:-$HOME/.cargo}/registry/src/*/webview2-com-sys-*/<arch>/WebView2Loader.dll`
            if found_loader.is_none() {
                let cargo_home = std::env::var_os("CARGO_HOME")
                    .map(PathBuf::from)
                    .or_else(|| {
                        std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".cargo"))
                    });
                if let Some(registry_src) = cargo_home.map(|c| c.join("registry").join("src")) {
                    if let Ok(indices) = std::fs::read_dir(&registry_src) {
                        'outer: for idx_entry in indices.flatten() {
                            if let Ok(crates) = std::fs::read_dir(idx_entry.path()) {
                                for crate_entry in crates.flatten() {
                                    let cname = crate_entry.file_name();
                                    if cname.to_string_lossy().starts_with("webview2-com-sys-") {
                                        let cand = crate_entry
                                            .path()
                                            .join(arch_dir)
                                            .join("WebView2Loader.dll");
                                        if cand.is_file() {
                                            found_loader = Some(cand);
                                            break 'outer;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }

            if let Some(src_dll) = found_loader {
                let dest_dll = out_dir.join("WebView2Loader.dll");
                if std::fs::copy(&src_dll, &dest_dll).is_ok() {
                    println!("cargo:rerun-if-changed={}", src_dll.display());
                    println!("cargo:rustc-cfg=has_embedded_webview2_loader");
                }
            }
        }
    }
}
