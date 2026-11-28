<div align="center">
  <img src="docs/open-graph-banner.png" width="100%" alt="Imp — Interactive Media Player" />

  # Imp — Interactive Media Player

  **A lightweight, controller-first & desktop-native audio and video player for SteamOS, Linux, macOS, Windows, and SteamVR.**

  [![Status: v1.3.0-alpha.3](https://img.shields.io/badge/status-v1.3.0--alpha.3-ff6a00?style=flat-square)](https://github.com/niiiitz/imp/releases)
  [![Platforms: SteamOS | Linux | macOS | Windows | SteamVR](https://img.shields.io/badge/platforms-SteamOS%20%7C%20Linux%20%7C%20macOS%20%7C%20Windows%20%7C%20SteamVR-000000?style=flat-square)](#installation)
  [![Backend: 100% Native Rust](https://img.shields.io/badge/backend-Native%20Rust-dea584?style=flat-square)](#development--building-from-source)
</div>

---

## ⬇️ Download Imp (`v1.3.0-alpha.3`)

Grab the ready-to-run installer or portable bundle for your platform directly below (or browse **[All Releases](https://github.com/niiiitz/imp/releases)**):

| Platform | Direct Download (`Latest Stable`) | Quick Install / Launch |
| :--- | :--- | :--- |
| **Steam Deck / SteamOS / Linux (`x86_64`)** | **[`imp-steamos-userland-x86_64.tar.gz`](https://github.com/niiiitz/imp/releases/latest/download/imp-steamos-userland-x86_64.tar.gz)** | Extract & run `./install-steamos.sh` *(userland `systemd` service + Desktop shortcut)* |
| **Steam Frame / Linux (`aarch64` ARM64)** | **[`imp-steamos-userland-aarch64.tar.gz`](https://github.com/niiiitz/imp/releases/latest/download/imp-steamos-userland-aarch64.tar.gz)** | Extract & run `./install-steamos.sh` *(native ARM64 + SteamVR overlay)* |
| **Decky Loader Add-On (`SteamOS QAM`)** | **[`imp-decky.zip`](https://github.com/niiiitz/imp/releases/latest/download/imp-decky.zip)** | In Decky Loader: **Settings → Developer → Install Plugin from ZIP** |
| **macOS (`Apple Silicon arm64`)** | **[`IMP-macos-arm64.zip`](https://github.com/niiiitz/imp/releases/latest/download/IMP-macos-arm64.zip)** | Unzip and drag **`IMP.app`** to `/Applications` *(Developer ID signed & Apple notarized)* |
| **Windows (`x86_64` Portable)** | **[`imp-windows-portable-x86_64.zip`](https://github.com/niiiitz/imp/releases/latest/download/imp-windows-portable-x86_64.zip)** | Unzip anywhere and launch **`Imp.exe`** *(zero-install portable folder)* |

---

## Overview

Playing your own music, soundtracks, and video across a Steam Deck, desktop, living-room console, or VR headset shouldn't require a heavy web browser or five separate apps.

**Imp** pairs a tiny native Rust media daemon with a high-contrast, OLED-friendly interface built for gamepads, VR pointers, and mouse & keyboard alike.

| <a href="docs/screenshots/library_queue.png"><img src="docs/screenshots/library_queue.png" alt="Imp Unified Library and Horizontal Shelves" width="100%" /></a> | <a href="docs/screenshots/lyrics_viz.png"><img src="docs/screenshots/lyrics_viz.png" alt="Imp Audio Visualizers and Live Synced Lyrics" width="100%" /></a> |
| :---: | :---: |
| **Studio Graphite Library & `See All ›` Grids**<br><sub>Local media, Steam OSTs, Apple Music, SoundCloud, Internet Archive & Optical Discs</sub> | **Audio Visualizers & Synced Lyrics (`LRCLIB`)**<br><sub>12 High-DPI scenes (20/30/40/Uncapped FPS pacing) with Stats HUD and OLED black floors</sub> |
| <a href="docs/screenshots/player_with_select_overlay.png"><img src="docs/screenshots/player_with_select_overlay.png" alt="Imp 3-Column XMB START Menu" width="100%" /></a> | <a href="docs/screenshots/settings_sources.png"><img src="docs/screenshots/settings_sources.png" alt="Imp Networked Retrieval Privacy Controls" width="100%" /></a> |
| **3-Column XMB `START` Menu & `UI Scale`**<br><sub>Unified Display, Audio & Sources, and System & Network navigation with `100%–175%` scaling</sub> | **Granular Privacy & Account Controls**<br><sub>5 independent `Networked Retrieval` toggles (Lyrics, Artwork, Factoids, Track Data, Comments)</sub> |

---

## High-Level Features

<img src="docs/imp-mascot-slouched.png" align="right" width="220" alt="Imp Mascot" />

* **One Queue for Audio & Video (`★ Hybrid Playlists`):** Mix local music & video files, **Steam Soundtracks**, **Apple Music**, **SoundCloud** tracks & DJ mixes, **Internet Archive** films & live concerts, and physical **Audio CDs / DVDs** inside a single playlist, browsed via 1-row square-tile shelves with **`See All ›`** grid pop-outs.
* **12 Reactive Visualizers & Live Synced Lyrics (`LRCLIB`):** Gaming-friendly **30 FPS** default (`20 / 30 / 40 / Uncapped`) with optional unfocused pause, time-synced lyrics, timed `@username` SoundCloud comments, retro VHS track chyrons, interactive waveform scrubbing, and Stats HUD.
* **Card & Theatre Video Player:** Watch video inside the Now Playing card or expand into full-viewport **Theatre Mode** (`F`) with stream quality and subtitle selection. Flip back to your library (`L1`/`R1`) and audio continues seamlessly.
* **Granular Privacy & 3-Column XMB (`START`):** Independently gate outbound network lookups (**Lyrics**, **Artwork**, **Factoids**, **Album/DVD Track Data**, **SoundCloud Comments**), tune **UI Scale** (`Auto / 100%–175%`), and pin only the collections you want.
* **Controller-First, Focus-Isolated & Desktop Ready:** Neutral Studio Graphite UI with focus-isolated gamepad polling on SteamOS, Gamescope, and SteamVR, switching seamlessly to mouse & keyboard (`Space` Play/Pause, `/` search, media keys).
* **Tiny Native Rust Daemon:** Runs in the background (`~5 MB` binary) with native OS integration — **Linux `MPRIS2` & System Tray**, **macOS Menu Bar & Control Center (`MPNowPlayingInfoCenter`)**, **Windows System Tray**, and **SteamVR Dashboard Overlay**. Close the window and your media keeps playing.

<br clear="right" />

---

## Supported Platforms & Media Sources

| Category | Supported Targets |
| :--- | :--- |
| **Platforms** | **SteamOS / Linux** (`x86_64` & `aarch64` Steam Frame), **macOS** (`Apple Silicon arm64`), **Windows** (`x86_64`), **SteamVR** (`OpenVR` overlay) |
| **Audio & Video Sources** | **Local Audio & Video** (`FLAC`, `MP3`, `AAC/M4A`, `OGG`, `WAV`, `MP4`, `MKV`, `WebM`), **Steam Soundtracks** (auto-discovered), **Apple Music**, **SoundCloud**, **Internet Archive** (`archive.org`), **Optical Discs** (`Audio CD` + `DVD-Video`) |

---

## Installation

Grab the package for your platform from the **[latest GitHub Release (`v1.3.0-alpha.3`)](https://github.com/niiiitz/imp/releases/latest)**:

### SteamOS / Bazzite / Linux (`x86_64` & `aarch64`)

Download **[`imp-steamos-userland-x86_64.tar.gz`](https://github.com/niiiitz/imp/releases/latest/download/imp-steamos-userland-x86_64.tar.gz)** (or **[`imp-steamos-userland-aarch64.tar.gz`](https://github.com/niiiitz/imp/releases/latest/download/imp-steamos-userland-aarch64.tar.gz)** for ARM64 / Steam Frame). Installs into `~/.local/share/imp` as a `systemd --user` service without modifying read-only system partitions:

```bash
rm -rf /tmp/imp-steamos-userland && tar -xzf imp-steamos-userland-x86_64.tar.gz -C /tmp
/tmp/imp-steamos-userland/install-steamos.sh
```

* **Launch:** Open **Imp** from your application menu, run `imp`, or right-click **Imp** → **Add to Steam** for Game Mode & SteamVR.
* **Optional Decky Plugin:** Download **[`imp-decky.zip`](https://github.com/niiiitz/imp/releases/latest/download/imp-decky.zip)** and install via Decky Loader's *Install from ZIP* menu for a Quick Access Menu drawer.

### macOS (`Apple Silicon arm64`)

Download **[`IMP-macos-arm64.zip`](https://github.com/niiiitz/imp/releases/latest/download/IMP-macos-arm64.zip)**, extract `IMP.app` into `/Applications`, and launch **Imp**.
* Closing the window (`Cmd+W`) keeps playback active in the **macOS Menu Bar** (`NSStatusItem`) with full **Control Center / Media Key** integration.

### Windows (`x86_64` Portable)

Download **[`imp-windows-portable-x86_64.zip`](https://github.com/niiiitz/imp/releases/latest/download/imp-windows-portable-x86_64.zip)**, extract anywhere, and run `Imp.exe`.

### In-App Updates (`Alpha` & `Stable` Channels)

Open the top-right **Settings (`☰`)** drawer to switch between the **Alpha** and **Stable** release channels and check for updates in place.

---

## Controls Quick Reference

| Action | Gamepad | Desktop Keyboard |
| :--- | :--- | :--- |
| **Play / Pause** | `A` *(in Player)* | `Space` or `K` |
| **Previous / Next Track** | `D-Pad Left / Right` *(in Player)* | `← / →` *(in Player)*, `B / N`, `< / >`, or `Cmd/Ctrl + ← / →` |
| **Seek `-10s` / `+10s`** | `L2` / `R2` Triggers | `J / L` or `- / +` |
| **Volume & Mute** | `D-Pad Up / Down` *(in Player)* or `Right Stick Y` | `↑ / ↓` *(in Player)*, `Cmd/Ctrl + ↑ / ↓`, or `M` (Mute) |
| **Switch Tabs (`Player` / `Library`)** | `L1` / `R1` Bumpers | `1` / `2` or `[` / `]` |
| **Shuffle / Repeat** | `X` (Shuffle) / `Y` (Repeat in Player) | `S` or `X` (Shuffle) / `R` (Repeat) |
| **Pin Item / Track Actions** | `Y` or `Select` *(in Library)* | Click `📌` / `⋯` or press `Y` |
| **`SELECT` Menu (Visualizer / Lyrics / Track Options)** | `Select` / `View` *(in Player)* | Click top-left `⚙️` pill or press `Tab` |
| **Fullscreen / Video Theatre** | `Select` → Full Screen / `A` on `⛶` | `F` or `F11` (`Esc` to exit) |
| **Search Library & Sources** | Focus Search + `A` (On-Screen Keyboard) | `/` or `Cmd/Ctrl + F` |
| **Settings Drawer (`☰`)** | `Start` / `Options` | `P` or `F1` |

---

## Development & Building from Source

Imp splits playback and UI into two lightweight layers:
1. **Rust Daemon (`imp --daemon`):** Indexes media into SQLite, decodes audio (`Symphonia` + `Rodio`), streams cloud & archival media, reads optical discs, and drives native OS media controls + `OpenVR`.
2. **Console UI (`http://127.0.0.1:18888`):** React + TypeScript frontend synchronized over WebSockets.

```bash
# Run in development mode
cargo run -p imp -- --daemon
npm run dev:ui

# Build release bundles into dist/
./packaging/scripts/package-release.sh                         # Linux / SteamOS (x86_64)
IMP_TARGET_ARCH=aarch64 ./packaging/scripts/package-release.sh # Steam Frame / Linux (aarch64)
./packaging/scripts/package-macos.sh                           # macOS IMP.app bundle (arm64)
./packaging/scripts/package-windows.sh                         # Windows portable ZIP (x86_64)
```

---

## Attributions & Provenance

Imp builds on the work of open-source maintainers and public archives — including **[Jake Johnson (`@jjjake/internetarchive`)](https://github.com/jjjake/internetarchive)** and the **[Internet Archive (`archive.org`)](https://archive.org/developers/)**, **[Tran Xuan Thang (`LRCLIB`)](https://github.com/tranxuanthang/lrclib)**, **Symphonia**, **Rodio**, **Lofty**, **VideoLAN (`libdvdcss` / `libdvdread`)**, **MusicBrainz & Cover Art Archive**, **Souvlaki**, **OpenVR**, and **Decky Loader**.

See **[`ATTRIBUTIONS.md`](ATTRIBUTIONS.md)** for the complete provenance ledger and technical acknowledgments.

---

## Disclaimer

> **Imp (Interactive Media Player)** is an independent open-source project and is **not** affiliated with, endorsed by, or sponsored by **Valve Corporation**, **Apple Inc.**, **SoundCloud**, **Internet Archive**, or the **MetaBrainz Foundation**. All product and company names are trademarks of their respective owners and are used strictly for identification and interoperability (nominative fair use).
