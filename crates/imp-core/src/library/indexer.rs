use crate::factoids::{import_cached_factoids, PushFactoidsItem};
use crate::library::artwork::{
    cache_folder_artwork_file, extract_and_cache_artwork_from_tagged,
    fetch_musicbrainz_cover_for_album, import_cached_artwork, pick_preferred_folder_image,
    resolve_and_cache_artwork, MusicBrainzArtOutcome, PushArtworkItem,
};
use crate::library::db::{IndexedTrackBatchItem, LibraryDatabase, TrackPropertiesPatch};
use crate::library::mounts::discover_removable_mounts;
use crate::library::vdf::{discover_steam_music_directories, normalize_platform_path};
use crate::lyrics::{import_cached_lyrics, PushLyricsItem};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag};
use imp_protocol::{MountStatus, SimpSettings, TrackMetadata};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use unicode_normalization::UnicodeNormalization;
use walkdir::WalkDir;

/// Computes a deterministic 16-hex `album_id` from Unicode-NFC-normalized
/// `(album_title, parent_folder_path, source)` so macOS NFD vs NFC paths hash identically.
pub fn compute_local_album_id(album: &str, parent_folder_path: &Path, source: &str) -> String {
    let album_nfc: String = album.nfc().collect::<String>().to_lowercase();
    let folder_nfc: String = parent_folder_path
        .to_string_lossy()
        .nfc()
        .collect::<String>()
        .to_lowercase();
    let input = format!("{album_nfc}::{folder_nfc}::{source}");
    blake3::hash(input.as_bytes()).to_hex()[..16].to_string()
}

const SUPPORTED_EXTENSIONS: &[&str] = &[
    "flac", "mp3", "wav", "m4a", "aac", "ogg", "opus", "aiff", "aif",
];

const SUPPORTED_VIDEO_EXTENSIONS: &[&str] = &["mp4", "webm", "m4v", "mov", "mkv", "ogv"];

/// Lightweight startup check that removes any SQLite mounts/tracks whose root was removed
/// from `custom_paths` or added to `ignored_paths`, without crawling the filesystem.
pub fn prune_ignored_and_stale_mounts(db: &LibraryDatabase, settings: &SimpSettings) {
    let ignored_roots: HashSet<String> = settings
        .library
        .ignored_paths
        .values()
        .map(|s| normalize_platform_path(s).to_string_lossy().to_string())
        .collect();

    let active_custom_roots: HashSet<String> = settings
        .library
        .custom_paths
        .values()
        .map(|s| normalize_platform_path(s).to_string_lossy().to_string())
        .filter(|norm_str| !ignored_roots.contains(norm_str))
        .collect();

    if let Ok(existing_mounts) = db.get_mounts() {
        for m in existing_mounts {
            let norm_mount = normalize_platform_path(&m.mount_root)
                .to_string_lossy()
                .to_string();
            let is_ignored =
                ignored_roots.contains(&m.mount_root) || ignored_roots.contains(&norm_mount);
            #[cfg(target_os = "windows")]
            let is_misclassified_fixed = m.mount_kind == "removable_media"
                && crate::library::mounts::is_windows_non_removable_drive_root(&m.mount_root);
            #[cfg(target_os = "macos")]
            let is_misclassified_fixed = m.mount_kind == "removable_media";
            #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
            let is_misclassified_fixed = false;

            let is_shadow_timemachine = m.mount_root.contains(".timemachine")
                || m.mount_root.contains("TimeMachine")
                || m.mount_root.contains("Backups.backupdb");

            if is_ignored
                || (m.mount_kind == "user_custom"
                    && !active_custom_roots.contains(&m.mount_root)
                    && !active_custom_roots.contains(&norm_mount))
                || (m.mount_kind == "removable_media" && !settings.library.auto_mount_removable)
                || (m.mount_kind == "steam_vdf" && !settings.library.scan_steam_osts)
                || is_misclassified_fixed
                || is_shadow_timemachine
            {
                let _ = db.remove_mount(&m.mount_root);
                if norm_mount != m.mount_root {
                    let _ = db.remove_mount(&norm_mount);
                }
            }
        }
    }
}

/// Crawls configured local directories, Steam OST directories (`libraryfolders.vdf`),
/// and removable USB/MicroSD mounts (`/run/media`), incrementally indexing tracks into SQLite.
pub fn scan_all_storage(db: &LibraryDatabase, settings: &SimpSettings) -> (usize, usize) {
    scan_all_storage_with_callbacks(db, settings, None, || {}, |_, _| {})
}

/// Crawls storage mounts (or a single `only_mount` when targeted) with live callbacks
/// whenever mount online states change or incremental batches commit to SQLite.
pub fn scan_all_storage_with_callbacks<FM, FP>(
    db: &LibraryDatabase,
    settings: &SimpSettings,
    only_mount: Option<&str>,
    mut on_mounts_changed: FM,
    on_progress: FP,
) -> (usize, usize)
where
    FM: FnMut() + Send + Sync,
    FP: Fn(usize, usize) + Send + Sync,
{
    crate::prefer_efficiency_core_for_current_thread();
    let ignored_roots: HashSet<String> = settings
        .library
        .ignored_paths
        .values()
        .map(|s| normalize_platform_path(s).to_string_lossy().to_string())
        .collect();

    let only_mount_norm = only_mount
        .map(|m| normalize_platform_path(m).to_string_lossy().to_string())
        .filter(|s| !s.is_empty());

    // 1. User-configured custom paths (normalized for Windows C:\ and bash-escaped spaces)
    let mut active_custom_roots = HashSet::new();
    let mut custom_mounts_to_scan: Vec<(PathBuf, String, bool)> = Vec::new();
    for (_key, raw_path_str) in &settings.library.custom_paths {
        let norm_path = normalize_platform_path(raw_path_str);
        let norm_str = norm_path.to_string_lossy().to_string();
        if ignored_roots.contains(&norm_str) || ignored_roots.contains(raw_path_str) {
            continue;
        }
        if !active_custom_roots.insert(norm_str.clone()) {
            continue;
        }
        if let Some(ref target) = only_mount_norm {
            if &norm_str != target {
                continue;
            }
        }
        let online = probe_mount_online(&norm_path);
        let label = norm_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| norm_str.clone());
        let _ = db.upsert_mount(&norm_str, &label, "user_custom", online);
        custom_mounts_to_scan.push((norm_path, norm_str, online));
    }

    if let Some(ref target) = only_mount_norm {
        if custom_mounts_to_scan.is_empty() && !ignored_roots.contains(target) {
            let norm_path = PathBuf::from(target);
            let online = probe_mount_online(&norm_path);
            let label = norm_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| target.clone());
            let _ = db.upsert_mount(target, &label, "user_custom", online);
            custom_mounts_to_scan.push((norm_path, target.clone(), online));
        }
    }

    on_mounts_changed();

    let emit_progress = || {
        let (albums, tracks) = db.get_library_counts().unwrap_or((0, 0));
        on_progress(albums, tracks);
    };

    for (norm_path, norm_str, online) in custom_mounts_to_scan {
        if online {
            scan_mount_directory_with_progress(db, &norm_path, &norm_str, "local", Some(&emit_progress));
        }
    }

    if only_mount_norm.is_none() {
        // Prune any stale `user_custom` mounts in SQLite that are no longer in `custom_paths`,
        // or any mounts explicitly added to `ignored_paths`, or any fixed/optical Windows drive roots
        // or macOS `/Volumes` Time Machine shadow mounts that were previously misclassified as `removable_media`.
        prune_ignored_and_stale_mounts(db, settings);

        // 2. Steam Soundtracks (`libraryfolders.vdf`)
        if settings.library.scan_steam_osts {
            for ost_dir in discover_steam_music_directories() {
                let root_str = ost_dir.to_string_lossy().to_string();
                if ignored_roots.contains(&root_str) {
                    continue;
                }
                let _ = db.upsert_mount(&root_str, "Steam Soundtracks", "steam_vdf", true);
                scan_mount_directory_with_progress(db, &ost_dir, &root_str, "steam_ost", Some(&emit_progress));
            }
        }

        // 3. Removable USB / MicroSD Drives (`/run/media/...` on Linux, `DRIVE_REMOVABLE` on Windows)
        if settings.library.auto_mount_removable {
            let discovered: Vec<(PathBuf, String)> = discover_removable_mounts()
                .into_iter()
                .filter(|(p, _)| !ignored_roots.contains(&p.to_string_lossy().to_string()))
                .collect();
            if let Ok(existing_mounts) = db.get_mounts() {
                for m in existing_mounts {
                    if m.mount_kind == "removable_media"
                        && !discovered
                            .iter()
                            .any(|(p, _)| p.to_string_lossy() == m.mount_root)
                    {
                        let _ = db.set_mount_online(&m.mount_root, false);
                    }
                }
            }
            for (mount_path, label) in discovered {
                let root_str = mount_path.to_string_lossy().to_string();
                let _ = db.upsert_mount(&root_str, &label, "removable_media", true);
                scan_mount_directory_with_progress(db, &mount_path, &root_str, "local", Some(&emit_progress));
            }
        }
    }

    // 4. Polite MusicBrainz + Cover Art Archive lookup runs asynchronously in the background
    // so large local/SMB mount scans complete and populate SQLite without blocking on 1 req/1.5s pauses.
    spawn_background_musicbrainz_artwork_crawl(db.clone());

    let (albums, tracks) = db.get_library_counts().unwrap_or((0, 0));
    tracing::info!(
        "Storage scan complete: {} albums, {} tracks indexed in SQLite",
        albums,
        tracks
    );
    (albums, tracks)
}

static MB_ART_CRAWL_RUNNING: AtomicBool = AtomicBool::new(false);

struct MbCrawlGuard;

impl Drop for MbCrawlGuard {
    fn drop(&mut self) {
        MB_ART_CRAWL_RUNNING.store(false, Ordering::SeqCst);
    }
}

fn spawn_background_musicbrainz_artwork_crawl(db: LibraryDatabase) {
    if MB_ART_CRAWL_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    if std::thread::Builder::new()
        .name("imp-mb-art".to_string())
        .spawn(move || {
            let _guard = MbCrawlGuard;
            crate::prefer_efficiency_core_for_current_thread();
            resolve_missing_local_album_artwork_via_musicbrainz(&db);
        })
        .is_err()
    {
        MB_ART_CRAWL_RUNNING.store(false, Ordering::SeqCst);
    }
}

fn resolve_missing_local_album_artwork_via_musicbrainz(db: &LibraryDatabase) {
    let Ok(missing_albums) = db.get_local_albums_missing_artwork() else {
        return;
    };
    if missing_albums.is_empty() {
        return;
    }

    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut made_network_call = false;

    for (album_id, title, album_artist) in missing_albums {
        if let Some((status, cached_art, checked_at)) = db.get_musicbrainz_art_cache(&album_id) {
            if status == "found" {
                if let Some(url) = cached_art {
                    let _ = db.set_album_and_tracks_artwork(&album_id, &url);
                    continue;
                }
            } else if status == "not_found" && (now_secs - checked_at) < 600 {
                // Negative cache valid for 10 minutes so unmatched local folders don't spam MusicBrainz
                continue;
            }
        }

        if made_network_call {
            // Respect MusicBrainz's 1 req/sec rate limit policy with safety margin
            std::thread::sleep(Duration::from_millis(1500));
        }
        made_network_call = true;

        match fetch_musicbrainz_cover_for_album(&album_id, &title, &album_artist) {
            MusicBrainzArtOutcome::Found(art_url) => {
                tracing::info!(
                    "Resolved missing local album artwork via MusicBrainz + Cover Art Archive: '{}' ({})",
                    title,
                    album_artist
                );
                let _ = db.set_album_and_tracks_artwork(&album_id, &art_url);
                let _ = db.set_musicbrainz_art_cache(&album_id, "found", Some(&art_url));
            }
            MusicBrainzArtOutcome::NotFound => {
                let _ = db.set_musicbrainz_art_cache(&album_id, "not_found", None);
            }
            MusicBrainzArtOutcome::TransientError => {
                tracing::warn!(
                    "Transient MusicBrainz/network error while looking up '{}' ({}); will retry on next scan",
                    title,
                    album_artist
                );
            }
        }
    }
}

fn is_ignored_walk_entry(entry: &walkdir::DirEntry) -> bool {
    if entry.depth() == 0 {
        return false;
    }
    let name = entry.file_name().to_string_lossy();
    // Skip hidden dot-files/folders (`.timemachine`, `.Spotlight-V100`, `.Trashes`, `.git`, AppleDouble `._*`)
    // and Time Machine backup bundles
    if name.starts_with('.')
        || name.eq_ignore_ascii_case("Backups.backupdb")
        || name.ends_with(".backupbundle")
        || name.ends_with(".sparsebundle")
    {
        return true;
    }
    false
}

/// Computes the clean `/` or `Artist/Album`-style relative subfolder path of `file_path`
/// inside `mount_root`, normalizing Windows backslashes to forward slashes.
pub fn compute_relative_parent_folder(mount_root: &str, file_path: &Path) -> String {
    let norm_file = file_path.to_string_lossy().replace('\\', "/");
    let Some((raw_parent, _)) = norm_file.rsplit_once('/') else {
        return "/".to_string();
    };
    let norm_mount = mount_root
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_string();
    let norm_parent = if raw_parent.is_empty() {
        "/"
    } else {
        raw_parent.trim_end_matches('/')
    };
    if norm_parent == norm_mount {
        return "/".to_string();
    }
    let mount_prefix = if norm_mount.is_empty() {
        "/".to_string()
    } else {
        format!("{norm_mount}/")
    };
    if let Some(rel) = norm_parent.strip_prefix(&mount_prefix) {
        let clean = rel.trim_matches('/');
        if clean.is_empty() {
            return "/".to_string();
        }
        return clean.to_string();
    }
    norm_parent
        .rsplit('/')
        .next()
        .map(|n| n.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "/".to_string())
}

fn clean_tag_genre(raw: Option<&str>) -> Option<String> {
    raw.map(str::trim)
        .filter(|s| {
            !s.is_empty()
                && !s.eq_ignore_ascii_case("unknown")
                && !s.eq_ignore_ascii_case("none")
                && !s.eq_ignore_ascii_case("other")
        })
        .map(|s| s.to_string())
}

/// Extracts a 4-digit release year `(1000..=2100)` from `tag.year()` or fallback ISO date strings
/// such as MP4 `©day` / ID3 `TDRC` (`"2012-06-12T07:00:00Z"`).
pub fn extract_tag_year(tag: &Tag) -> Option<u32> {
    if let Some(y) = tag.year().filter(|y| (1000..=2100).contains(y)) {
        return Some(y);
    }
    for key in [
        ItemKey::RecordingDate,
        ItemKey::ReleaseDate,
        ItemKey::OriginalReleaseDate,
        ItemKey::Year,
    ] {
        if let Some(raw) = tag.get_string(&key) {
            let trimmed = raw.trim();
            if let Some(prefix) = trimmed.get(..4) {
                if prefix.bytes().all(|b| b.is_ascii_digit()) {
                    if let Ok(parsed) = prefix.parse::<u32>() {
                        if (1000..=2100).contains(&parsed) {
                            return Some(parsed);
                        }
                    }
                }
            }
        }
    }
    None
}

fn probe_audio_genre_and_year(path: &Path) -> (Option<String>, Option<i32>) {
    let parse_opts = lofty::config::ParseOptions::new()
        .read_properties(false)
        .read_cover_art(false);
    let Ok(probe) = Probe::open(path) else {
        return (None, None);
    };
    let Ok(tagged) = probe.options(parse_opts).read() else {
        return (None, None);
    };
    if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
        let genre = tag.genre().as_deref().and_then(|g| clean_tag_genre(Some(g)));
        let year = extract_tag_year(tag).map(|y| y as i32);
        return (genre, year);
    }
    (None, None)
}

fn resolve_folder_art_cached(
    parent_dir: &Path,
    folder_images: &HashMap<PathBuf, Vec<PathBuf>>,
    cache: &Mutex<HashMap<PathBuf, Option<String>>>,
) -> Option<String> {
    if let Ok(guard) = cache.lock() {
        if let Some(cached) = guard.get(parent_dir) {
            return cached.clone();
        }
    }
    let resolved = folder_images
        .get(parent_dir)
        .and_then(|imgs| pick_preferred_folder_image(imgs))
        .and_then(|chosen| cache_folder_artwork_file(&chosen))
        .map(|art| art.http_art_url);
    if let Ok(mut guard) = cache.lock() {
        guard.insert(parent_dir.to_path_buf(), resolved.clone());
    }
    resolved
}

fn scan_mount_directory_with_progress(
    db: &LibraryDatabase,
    dir: &Path,
    mount_root: &str,
    source: &str,
    on_progress: Option<&(dyn Fn() + Sync)>,
) {
    if std::fs::read_dir(dir).is_err() {
        tracing::warn!(
            "Skipping scan of '{}' — directory is not readable (mount offline or stale SMB handle)",
            mount_root
        );
        if source == "local" {
            let _ = db.set_mount_online(mount_root, false);
        }
        return;
    }

    let fingerprints = db.get_mount_file_fingerprints(mount_root).unwrap_or_default();
    let needs_backfill = db
        .get_tracks_missing_folder_metadata(mount_root)
        .unwrap_or_default();

    let mut audio_files: Vec<(PathBuf, i64, i64)> = Vec::new();
    let mut video_files: Vec<(PathBuf, i64, i64)> = Vec::new();
    let mut lrc_stems: HashSet<(PathBuf, String)> = HashSet::new();
    let mut folder_images: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();
    let mut walk_io_errors: usize = 0;

    // Single directory walk capturing audio, video, sidecar `.lrc`, and folder artwork files
    // alongside stat metadata to avoid redundant SMB RPC round-trips per file.
    for entry_res in WalkDir::new(dir)
        .follow_links(false)
        .max_depth(10)
        .into_iter()
        .filter_entry(|e| !is_ignored_walk_entry(e))
    {
        let entry = match entry_res {
            Ok(ent) => ent,
            Err(err) => {
                walk_io_errors += 1;
                if walk_io_errors <= 5 {
                    tracing::warn!("Storage walk error under '{}': {err}", mount_root);
                }
                continue;
            }
        };
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let Some(ext_lower) = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
        else {
            continue;
        };

        if ext_lower == "lrc" {
            if let (Some(parent), Some(stem)) = (
                path.parent().map(|p| p.to_path_buf()),
                path.file_stem().map(|s| s.to_string_lossy().to_lowercase()),
            ) {
                lrc_stems.insert((parent, stem));
            }
            continue;
        }

        if matches!(ext_lower.as_str(), "png" | "jpg" | "jpeg" | "webp") {
            let parent = path.parent().unwrap_or(dir).to_path_buf();
            folder_images
                .entry(parent)
                .or_default()
                .push(path.to_path_buf());
            continue;
        }

        let is_audio = SUPPORTED_EXTENSIONS.iter().any(|s| *s == ext_lower);
        let is_video =
            !is_audio && source == "local" && SUPPORTED_VIDEO_EXTENSIONS.iter().any(|s| *s == ext_lower);
        if !is_audio && !is_video {
            continue;
        }

        let Ok(fs_meta) = entry.metadata() else {
            walk_io_errors += 1;
            continue;
        };
        let file_size = fs_meta.len() as i64;
        let file_mtime = fs_meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);

        if is_audio {
            audio_files.push((path.to_path_buf(), file_size, file_mtime));
        } else {
            video_files.push((path.to_path_buf(), file_size, file_mtime));
        }
    }

    if walk_io_errors > 0 {
        tracing::warn!(
            "Completed walk of '{}' with {} I/O error(s) (stale pruning disabled for this pass)",
            mount_root,
            walk_io_errors
        );
    }

    // Sort so preferred tagged formats (`flac`, `mp3`, `m4a`, `ogg`) come before raw `wav` when deduplicating identical stems
    audio_files.sort_by(|a, b| {
        let key = |p: &PathBuf| {
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let rank = match ext.as_str() {
                "flac" => 0,
                "mp3" => 1,
                "m4a" | "ogg" | "opus" => 2,
                "wav" => 3,
                _ => 4,
            };
            (p.parent().map(|d| d.to_path_buf()), p.file_stem().map(|s| s.to_os_string()), rank)
        };
        key(&a.0).cmp(&key(&b.0))
    });

    let mut seen_stems: HashSet<(PathBuf, String)> = HashSet::new();
    let mut seen_uris: HashSet<String> = HashSet::new();
    let mut cached_caps: Vec<(String, bool, bool, bool)> = Vec::new();
    let mut to_parse: Vec<(PathBuf, String, i64, i64, bool)> = Vec::new();

    for (path, file_size, file_mtime) in audio_files {
        let parent_dir = path.parent().unwrap_or(dir).to_path_buf();
        let has_local_dir_art = folder_images.contains_key(&parent_dir);
        let stem_key = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_lowercase())
            .unwrap_or_default();

        if !seen_stems.insert((parent_dir.clone(), stem_key.clone())) {
            // Skip duplicate format (e.g., `.wav` twin of an already-indexed `.mp3`/`.flac` in the same folder)
            continue;
        }

        let uri = format!("file://{}", path.to_string_lossy());
        seen_uris.insert(uri.clone());
        let has_local_lrc = lrc_stems.contains(&(parent_dir, stem_key));

        if let Some((cached_mtime, cached_size, cached_art)) = fingerprints.get(&uri) {
            if *cached_mtime == file_mtime && *cached_size == file_size {
                let art_str = cached_art.as_deref().unwrap_or("");
                let is_emb = art_str.contains("/simp_art_emb_");
                let is_mb = art_str.contains("/mb_");
                // Only reuse cached fingerprint if:
                // - Artwork came from embedded audio tags (`simp_art_emb_`), OR
                // - Folder still has a local cover image (`has_local_dir_art == true`) and cached art exists, OR
                // - Artwork came from MusicBrainz (`mb_`) and no local folder cover image was added, OR
                // - Track has no art yet and still has no local folder cover image.
                // This avoids re-parsing artless SMB tracks on every rescan while picking up newly added `cover.jpg`.
                let art_cache_valid = is_emb
                    || (is_mb && !has_local_dir_art)
                    || (!art_str.is_empty() && !is_mb && has_local_dir_art)
                    || (art_str.is_empty() && !has_local_dir_art);
                if art_cache_valid {
                    if has_local_lrc || !art_str.is_empty() {
                        cached_caps.push((
                            uri.clone(),
                            !art_str.is_empty(),
                            has_local_lrc,
                            has_local_lrc,
                        ));
                    }
                    if needs_backfill.contains(&uri) {
                        let parent_folder = compute_relative_parent_folder(mount_root, &path);
                        let (bf_genre, bf_year) = probe_audio_genre_and_year(&path);
                        let _ = db.backfill_track_and_album_tag_metadata(
                            &uri,
                            bf_genre.as_deref(),
                            bf_year,
                            &parent_folder,
                        );
                    }
                    continue;
                }
            }
        }

        to_parse.push((path, uri, file_size, file_mtime, has_local_lrc));
    }

    for chunk in cached_caps.chunks(500) {
        let _ = db.record_indexed_capabilities_batch(chunk);
    }

    let folder_art_cache: Mutex<HashMap<PathBuf, Option<String>>> = Mutex::new(HashMap::new());

    if !to_parse.is_empty() {
        let worker_count = to_parse.len().min(8);
        let queue = Mutex::new(VecDeque::from(to_parse));

        std::thread::scope(|s| {
            for _ in 0..worker_count {
                s.spawn(|| {
                    let mut local_batch: Vec<IndexedTrackBatchItem> = Vec::with_capacity(100);
                    loop {
                        let next_item = { queue.lock().unwrap().pop_front() };
                        let Some((path, uri, file_size, file_mtime, has_local_lrc)) = next_item else {
                            break;
                        };
                        if let Some(batch_item) = parse_audio_file_detached(
                            &path,
                            &uri,
                            mount_root,
                            source,
                            file_mtime,
                            file_size,
                            has_local_lrc,
                            &folder_images,
                            &folder_art_cache,
                        ) {
                            local_batch.push(batch_item);
                            if local_batch.len() >= 100 {
                                let _ = db.upsert_indexed_batch(&local_batch);
                                local_batch.clear();
                                if let Some(cb) = on_progress {
                                    cb();
                                }
                            }
                        }
                    }
                    if !local_batch.is_empty() {
                        let _ = db.upsert_indexed_batch(&local_batch);
                        if let Some(cb) = on_progress {
                            cb();
                        }
                    }
                });
            }
        });
    }

    if source == "local" && !video_files.is_empty() {
        let mut video_batch: Vec<IndexedTrackBatchItem> = Vec::new();
        for (path, file_size, file_mtime) in video_files {
            let uri = format!("video://local/{}", path.to_string_lossy());
            seen_uris.insert(uri.clone());
            if let Some((cached_mtime, cached_size, _)) = fingerprints.get(&uri) {
                if *cached_mtime == file_mtime && *cached_size == file_size {
                    if needs_backfill.contains(&uri) {
                        let parent_folder = compute_relative_parent_folder(mount_root, &path);
                        let _ = db.backfill_track_and_album_tag_metadata(
                            &uri,
                            None,
                            None,
                            &parent_folder,
                        );
                    }
                    continue;
                }
            }

            if let Some(video_item) = parse_local_video_file_detached(
                &path,
                &uri,
                mount_root,
                file_mtime,
                file_size,
                &folder_images,
                &folder_art_cache,
            ) {
                video_batch.push(video_item);
            }
        }
        for chunk in video_batch.chunks(250) {
            let _ = db.upsert_indexed_batch(chunk);
        }
    }

    if walk_io_errors > 0 && seen_uris.is_empty() && !probe_mount_online(dir) {
        if source == "local" {
            let _ = db.set_mount_online(mount_root, false);
        }
        return;
    }

    if walk_io_errors == 0
        && probe_mount_online(dir)
        && (!seen_uris.is_empty() || fingerprints.len() <= 50)
    {
        let stale_uris: Vec<String> = fingerprints
            .keys()
            .filter(|uri| !seen_uris.contains(*uri))
            .cloned()
            .collect();
        if !stale_uris.is_empty() {
            let _ = db.remove_tracks_by_uris_and_prune_empty_albums(&stale_uris);
        }
    }
}

fn parse_local_video_file_detached(
    path: &Path,
    uri: &str,
    mount_root: &str,
    file_mtime: i64,
    file_size: i64,
    folder_images: &HashMap<PathBuf, Vec<PathBuf>>,
    folder_art_cache: &Mutex<HashMap<PathBuf, Option<String>>>,
) -> Option<IndexedTrackBatchItem> {
    let raw_stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Video".to_string());
    let folder_album = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Local Videos".to_string());
    let (parsed_track_no, parsed_artist, parsed_title) = parse_stem_metadata(&raw_stem);
    let folder_art = path
        .parent()
        .and_then(|parent| resolve_folder_art_cached(parent, folder_images, folder_art_cache));
    let art_http = folder_art.or_else(|| resolve_and_cache_artwork(path).map(|a| a.http_art_url));

    let parent_dir = path.parent().unwrap_or_else(|| Path::new(""));
    let parent_folder = compute_relative_parent_folder(mount_root, path);
    let album_id = compute_local_album_id(&folder_album, parent_dir, "local_video");
    let artist_label = parsed_artist.unwrap_or_else(|| "Local Video".to_string());
    let has_art = art_http
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    Some(IndexedTrackBatchItem {
        album_id: album_id.clone(),
        album_title: folder_album.clone(),
        album_artist: "Local Video".to_string(),
        steam_app_id: None,
        release_year: None,
        art_cache_path: art_http.clone(),
        genre: None,
        parent_folder: Some(parent_folder.clone()),
        track: TrackMetadata {
            uri: uri.to_string(),
            title: parsed_title,
            artists: vec![artist_label],
            album: folder_album,
            album_id: Some(album_id),
            track_number: parsed_track_no,
            disc_number: Some(1),
            art_url: art_http,
            duration_ms: 0,
            source: "local_video".to_string(),
            mount_root: Some(mount_root.to_string()),
            content_rating: None,
            genre: None,
            release_year: None,
            parent_folder: Some(parent_folder),
        },
        file_mtime: Some(file_mtime),
        file_size: Some(file_size),
        has_art,
        has_local_lrc: false,
    })
}

#[allow(clippy::too_many_arguments)]
fn parse_audio_file_detached(
    path: &Path,
    uri: &str,
    mount_root: &str,
    source: &str,
    file_mtime: i64,
    file_size: i64,
    has_local_lrc: bool,
    folder_images: &HashMap<PathBuf, Vec<PathBuf>>,
    folder_art_cache: &Mutex<HashMap<PathBuf, Option<String>>>,
) -> Option<IndexedTrackBatchItem> {
    let raw_stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown Track".to_string());
    let folder_album = path
        .parent()
        .and_then(|p| p.file_name())
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "Unknown Album".to_string());
    let grandparent_artist = path
        .parent()
        .and_then(|p| p.parent())
        .and_then(|gp| gp.file_name())
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("music") && !s.eq_ignore_ascii_case("media"));

    let (parsed_track_no, parsed_artist, parsed_title) = parse_stem_metadata(&raw_stem);

    let mut title = parsed_title;
    let mut artist = parsed_artist
        .or_else(|| grandparent_artist.clone())
        .unwrap_or_else(|| "Unknown Artist".to_string());
    let mut tag_album_artist: Option<String> = None;
    let mut album = folder_album.clone();
    let mut track_number = parsed_track_no;
    let mut disc_number = Some(1);
    let mut year = None;
    let mut genre: Option<String> = None;
    let mut duration_ms = 0u32;
    let mut content_rating: Option<String> = None;
    let mut embedded_art_url: Option<String> = None;

    if let Ok(probe) = Probe::open(path) {
        if let Ok(tagged) = probe.read() {
            duration_ms = tagged.properties().duration().as_millis() as u32;
            embedded_art_url =
                extract_and_cache_artwork_from_tagged(&tagged).map(|a| a.http_art_url);
            if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
                if let Some(t) = tag.title() {
                    if !t.trim().is_empty() {
                        title = t.into_owned();
                    }
                }
                if let Some(a) = tag.artist() {
                    if !a.trim().is_empty() {
                        artist = a.into_owned();
                    }
                }
                if let Some(aa) = tag.get_string(&lofty::tag::ItemKey::AlbumArtist) {
                    if !aa.trim().is_empty() {
                        tag_album_artist = Some(aa.trim().to_string());
                    }
                }
                if let Some(al) = tag.album() {
                    if !al.trim().is_empty() {
                        album = al.into_owned();
                    }
                }
                if tag.track().is_some() {
                    track_number = tag.track();
                }
                disc_number = tag.disk().or(Some(1));
                year = extract_tag_year(tag).map(|y| y as i32);
                genre = tag.genre().as_deref().and_then(|g| clean_tag_genre(Some(g)));
                if let Some(adv) = tag.get_string(&lofty::tag::ItemKey::ParentalAdvisory) {
                    let norm = adv.trim().to_ascii_lowercase();
                    if matches!(norm.as_str(), "1" | "4" | "explicit" | "yes" | "true") {
                        content_rating = Some("explicit".to_string());
                    } else if matches!(norm.as_str(), "2" | "clean") {
                        content_rating = Some("clean".to_string());
                    }
                }
            }
        }
    }

    let art_http = embedded_art_url.or_else(|| {
        path.parent()
            .and_then(|parent| resolve_folder_art_cached(parent, folder_images, folder_art_cache))
    });
    let has_art = art_http
        .as_deref()
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);

    // Group compilation / OST albums by `(album_title, parent_folder)` so multi-artist soundtracks
    // stay together as a single album instead of splitting per track artist.
    let parent_dir = path.parent().unwrap_or_else(|| Path::new(""));
    let parent_folder = compute_relative_parent_folder(mount_root, path);
    let album_id = compute_local_album_id(&album, parent_dir, source);

    let album_artist_owned = if source == "steam_ost" {
        "Steam Soundtrack".to_string()
    } else if let Some(aa) = tag_album_artist {
        aa
    } else if let Some(gp) = &grandparent_artist {
        gp.clone()
    } else {
        artist.clone()
    };

    Some(IndexedTrackBatchItem {
        album_id: album_id.clone(),
        album_title: album.clone(),
        album_artist: album_artist_owned,
        steam_app_id: None,
        release_year: year,
        art_cache_path: art_http.clone(),
        genre: genre.clone(),
        parent_folder: Some(parent_folder.clone()),
        track: TrackMetadata {
            uri: uri.to_string(),
            title,
            artists: vec![artist],
            album,
            album_id: Some(album_id),
            track_number,
            disc_number,
            art_url: art_http,
            duration_ms,
            source: source.to_string(),
            mount_root: Some(mount_root.to_string()),
            content_rating,
            genre,
            release_year: year,
            parent_folder: Some(parent_folder),
        },
        file_mtime: Some(file_mtime),
        file_size: Some(file_size),
        has_art,
        has_local_lrc,
    })
}

/// Parses Steam OST filename stems like `"11 - Hideki Naganuma - JACK DA FUNK"`
/// or `"02 - 2 Mello - I Wanna Kno"` into `(Some(11), Some("Hideki Naganuma"), "JACK DA FUNK")`.
pub fn parse_stem_metadata(stem: &str) -> (Option<u32>, Option<String>, String) {
    let parts: Vec<&str> = stem.splitn(3, " - ").map(str::trim).collect();
    if parts.len() == 3 {
        if let Ok(num) = parts[0].parse::<u32>() {
            return (
                Some(num),
                Some(parts[1].to_string()),
                parts[2].to_string(),
            );
        }
    } else if parts.len() == 2 {
        if let Ok(num) = parts[0].parse::<u32>() {
            return (Some(num), None, parts[1].to_string());
        }
    }

    // Also handle space-prefixed track numbers like "01 Death&Pleasure" or "02. Face the Music"
    if let Some((first_word, rest)) = stem.trim().split_once(' ') {
        let clean_num = first_word.trim_end_matches('.');
        if clean_num.len() <= 3 && clean_num.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(num) = clean_num.parse::<u32>() {
                let rest_trimmed = rest.trim_start_matches(['-', '.', ' ']);
                if !rest_trimmed.is_empty() {
                    return (Some(num), None, rest_trimmed.to_string());
                }
            }
        }
    }

    (None, None, stem.to_string())
}

/// Incrementally refreshes moved, renamed, or re-tagged local audio paths in `library.db`
/// and prunes any empty local album rows without rescanning an entire network mount.
pub fn refresh_local_paths_in_db(
    db: &LibraryDatabase,
    old_paths: &[PathBuf],
    new_paths: &[PathBuf],
    fallback_root: &Path,
) -> anyhow::Result<usize> {
    let active_new_set: HashSet<String> = new_paths
        .iter()
        .filter(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
        .collect();

    let mut removed_uris: Vec<String> = Vec::new();
    let mut seen_removed: HashSet<String> = HashSet::new();
    for old_p in old_paths {
        let old_str = old_p.to_string_lossy().to_string();
        if !active_new_set.contains(&old_str) || !old_p.is_file() {
            let uri = format!("file://{old_str}");
            if seen_removed.insert(uri.clone()) {
                removed_uris.push(uri);
            }
        }
    }
    if !removed_uris.is_empty() {
        let _ = db.remove_tracks_by_uris_and_prune_empty_albums(&removed_uris)?;
    }

    let mounts = db.get_mounts().unwrap_or_default();
    let fallback_root_str = normalize_platform_path(&fallback_root.to_string_lossy())
        .to_string_lossy()
        .to_string();

    let mut unique_new_paths: Vec<PathBuf> = Vec::new();
    let mut seen_new: HashSet<PathBuf> = HashSet::new();
    let mut folder_images: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();

    for p in new_paths {
        if !p.is_file() || !seen_new.insert(p.clone()) {
            continue;
        }
        if let Some(parent) = p.parent() {
            if !folder_images.contains_key(parent) {
                let mut imgs = Vec::new();
                if let Ok(rd) = std::fs::read_dir(parent) {
                    for ent in rd.flatten() {
                        let ep = ent.path();
                        if !ep.is_file() {
                            continue;
                        }
                        if let Some(ext) = ep.extension().and_then(|e| e.to_str()) {
                            if matches!(
                                ext.to_ascii_lowercase().as_str(),
                                "png" | "jpg" | "jpeg" | "webp"
                            ) {
                                imgs.push(ep);
                            }
                        }
                    }
                }
                folder_images.insert(parent.to_path_buf(), imgs);
            }
        }
        unique_new_paths.push(p.clone());
    }

    let folder_art_cache: Mutex<HashMap<PathBuf, Option<String>>> = Mutex::new(HashMap::new());
    let mut batch: Vec<IndexedTrackBatchItem> = Vec::with_capacity(unique_new_paths.len());

    for path in unique_new_paths {
        let path_str = path.to_string_lossy().to_string();
        let uri = format!("file://{path_str}");
        let Ok(fs_meta) = std::fs::metadata(&path) else {
            continue;
        };
        let file_size = fs_meta.len() as i64;
        let file_mtime = fs_meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let has_local_lrc = path.with_extension("lrc").is_file();

        let matched_mount = mounts
            .iter()
            .filter(|m| {
                let mp = Path::new(&m.mount_root);
                path.starts_with(mp)
            })
            .max_by_key(|m| m.mount_root.len())
            .map(|m| m.mount_root.as_str())
            .unwrap_or(fallback_root_str.as_str());

        if let Some(item) = parse_audio_file_detached(
            &path,
            &uri,
            matched_mount,
            "local",
            file_mtime,
            file_size,
            has_local_lrc,
            &folder_images,
            &folder_art_cache,
        ) {
            batch.push(item);
        }
    }

    let updated = batch.len();
    for chunk in batch.chunks(250) {
        db.upsert_indexed_batch(chunk)?;
    }
    let _ = db.remove_tracks_by_uris_and_prune_empty_albums(&[])?;
    Ok(updated)
}

/// Payload queued by external tools (such as `imp-librarian`) for targeted re-indexing
/// without rescanning entire library storage mounts.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct PendingRefreshEntry {
    #[serde(default)]
    pub old_paths: Vec<String>,
    #[serde(default)]
    pub new_paths: Vec<String>,
    #[serde(default)]
    pub fallback_root: Option<String>,
}

/// Canonical path to the offline refresh queue file drained when IMP starts.
pub fn pending_refresh_queue_path() -> PathBuf {
    crate::simp_data_dir().join("pending_refresh.json")
}

/// Atomically claims and processes any pending path refreshes written while IMP was offline.
pub fn drain_pending_refresh_queue(
    db: &LibraryDatabase,
    queue_path: &Path,
) -> anyhow::Result<usize> {
    if !queue_path.is_file() {
        return Ok(0);
    }

    let processing_path = queue_path.with_extension("processing.json");
    match std::fs::rename(queue_path, &processing_path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    }

    let raw = match std::fs::read_to_string(&processing_path) {
        Ok(content) => content,
        Err(e) => {
            let _ = std::fs::remove_file(&processing_path);
            return Err(e.into());
        }
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        let _ = std::fs::remove_file(&processing_path);
        return Ok(0);
    }

    let entries: Vec<PendingRefreshEntry> = match serde_json::from_str::<Vec<PendingRefreshEntry>>(trimmed)
        .or_else(|_| serde_json::from_str::<PendingRefreshEntry>(trimmed).map(|single| vec![single]))
    {
        Ok(parsed) => parsed,
        Err(e) => {
            let _ = std::fs::remove_file(&processing_path);
            return Err(e.into());
        }
    };

    let mounts = db.get_mounts().unwrap_or_default();
    let mut seen_old: HashSet<String> = HashSet::new();
    let mut old_paths: Vec<PathBuf> = Vec::new();
    let mut seen_new: HashSet<String> = HashSet::new();
    let mut new_paths: Vec<PathBuf> = Vec::new();
    let mut fallback_root: Option<String> = None;
    let mut deferred_entries: Vec<PendingRefreshEntry> = Vec::new();

    for entry in entries {
        let mut entry_check_paths: Vec<PathBuf> = entry
            .old_paths
            .iter()
            .chain(entry.new_paths.iter())
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .collect();
        if let Some(ref fb) = entry.fallback_root {
            let trimmed_fb = fb.trim();
            if !trimmed_fb.is_empty() {
                entry_check_paths.push(PathBuf::from(trimmed_fb));
            }
        }
        if detect_offline_mount_for_paths(&entry_check_paths, &mounts).is_some() {
            deferred_entries.push(entry);
            continue;
        }

        if fallback_root.is_none() {
            fallback_root = entry
                .fallback_root
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
        }
        for p in entry.old_paths {
            let clean = p.trim();
            if !clean.is_empty() && seen_old.insert(clean.to_string()) {
                old_paths.push(PathBuf::from(clean));
            }
        }
        for p in entry.new_paths {
            let clean = p.trim();
            if !clean.is_empty() && seen_new.insert(clean.to_string()) {
                new_paths.push(PathBuf::from(clean));
            }
        }
    }

    let res = if old_paths.is_empty() && new_paths.is_empty() {
        Ok(0)
    } else {
        let fallback_pb = PathBuf::from(fallback_root.as_deref().unwrap_or("/"));
        refresh_local_paths_in_db(db, &old_paths, &new_paths, &fallback_pb)
    };

    if !deferred_entries.is_empty() {
        if let Ok(serialized) = serde_json::to_string_pretty(&deferred_entries) {
            let requeue_tmp = queue_path.with_extension("requeue.json");
            if std::fs::write(&requeue_tmp, serialized).is_ok() {
                let _ = std::fs::rename(&requeue_tmp, queue_path);
            }
        }
    }
    let _ = std::fs::remove_file(&processing_path);
    res
}

/// Offline enrichment bundle written by external companion tools (such as `imp-librarian`)
/// when Imp is closed, and drained atomically at daemon startup.
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct PendingEnrichmentBatch {
    #[serde(default)]
    pub lyrics: Vec<PushLyricsItem>,
    #[serde(default)]
    pub factoids: Vec<PushFactoidsItem>,
    #[serde(default)]
    pub artwork: Vec<PushArtworkItem>,
}

/// Canonical path to the offline enrichment handoff file drained when Imp starts.
pub fn pending_enrichment_queue_path() -> PathBuf {
    crate::simp_data_dir().join("pending_enrichment.json")
}

/// Atomically claims and applies pre-fetched lyrics, factoids, and artwork from `pending_enrichment.json`.
pub fn drain_pending_enrichment_queue(
    db: &LibraryDatabase,
    queue_path: &Path,
) -> anyhow::Result<usize> {
    if !queue_path.is_file() {
        return Ok(0);
    }

    let processing_path = queue_path.with_extension("processing.json");
    match std::fs::rename(queue_path, &processing_path) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(e.into()),
    }

    let raw = match std::fs::read_to_string(&processing_path) {
        Ok(content) => content,
        Err(e) => {
            let _ = std::fs::remove_file(&processing_path);
            return Err(e.into());
        }
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        let _ = std::fs::remove_file(&processing_path);
        return Ok(0);
    }

    let batches: Vec<PendingEnrichmentBatch> =
        match serde_json::from_str::<Vec<PendingEnrichmentBatch>>(trimmed)
            .or_else(|_| {
                serde_json::from_str::<PendingEnrichmentBatch>(trimmed).map(|single| vec![single])
            }) {
            Ok(parsed) => parsed,
            Err(e) => {
                let _ = std::fs::remove_file(&processing_path);
                return Err(e.into());
            }
        };

    let mut imported = 0usize;
    for batch in batches {
        for item in batch.lyrics {
            let uri = item.track_uri.trim().to_string();
            if let Ok(resp) = import_cached_lyrics(&item) {
                if !uri.is_empty() {
                    let _ = db.upsert_track_properties_patch(
                        &uri,
                        &TrackPropertiesPatch {
                            has_lyrics: Some(resp.found),
                            has_synced_lyrics: Some(!resp.synced_lines.is_empty()),
                            suppress_lyrics: Some(false),
                            ..Default::default()
                        },
                    );
                }
                imported += 1;
            }
        }
        for item in batch.factoids {
            let uri = item.track_uri.trim().to_string();
            if let Ok(resp) = import_cached_factoids(&item) {
                if !uri.is_empty() {
                    let _ = db.upsert_track_properties_patch(
                        &uri,
                        &TrackPropertiesPatch {
                            has_factoids: Some(resp.found),
                            suppress_factoids: Some(false),
                            ..Default::default()
                        },
                    );
                }
                imported += 1;
            }
        }
        for item in batch.artwork {
            if import_cached_artwork(db, &item).is_ok() {
                imported += 1;
            }
        }
    }

    let _ = std::fs::remove_file(&processing_path);
    Ok(imported)
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct MountFsProbe {
    pub is_network_fs: bool,
    pub fs_type: Option<String>,
}

fn is_network_fs_type(fs_type: &str) -> bool {
    matches!(
        fs_type.trim().to_ascii_lowercase().as_str(),
        "smbfs" | "smb" | "smb2" | "smb3" | "cifs" | "nfs" | "nfs4" | "afpfs" | "webdav" | "davfs" | "fuse.sshfs" | "afs"
    )
}

#[cfg(target_os = "linux")]
fn parse_proc_mounts_for_path(mounts_txt: &str, target: &Path) -> Option<(PathBuf, String)> {
    let target_str = target.to_string_lossy();
    let mut best: Option<(PathBuf, String)> = None;
    for line in mounts_txt.lines() {
        let mut parts = line.split_whitespace();
        let _dev = parts.next();
        let Some(raw_mp) = parts.next() else {
            continue;
        };
        let Some(fs_type) = parts.next() else {
            continue;
        };
        let decoded_mp = raw_mp.replace("\\040", " ").replace("\\011", "\t");
        let mp = PathBuf::from(&decoded_mp);
        let mp_match = if decoded_mp == "/" {
            target_str.starts_with('/')
        } else {
            target == mp || target.starts_with(&mp)
        };
        if mp_match {
            let replace = best
                .as_ref()
                .map(|(prev_mp, _)| decoded_mp.len() > prev_mp.as_os_str().len())
                .unwrap_or(true);
            if replace {
                best = Some((mp, fs_type.to_string()));
            }
        }
    }
    best
}

pub fn probe_mount_fs_info(mount_root: &str) -> MountFsProbe {
    let trimmed = mount_root.trim();
    if trimmed.is_empty() {
        return MountFsProbe::default();
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(mounts_txt) = std::fs::read_to_string("/proc/mounts") {
            if let Some((_mp, fs_type)) = parse_proc_mounts_for_path(&mounts_txt, Path::new(trimmed)) {
                let is_net = is_network_fs_type(&fs_type);
                return MountFsProbe {
                    is_network_fs: is_net,
                    fs_type: Some(fs_type),
                };
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        use std::ffi::{CStr, CString};
        if let Ok(c_path) = CString::new(trimmed) {
            let mut buf: libc::statfs = unsafe { std::mem::zeroed() };
            let rc = unsafe { libc::statfs(c_path.as_ptr(), &mut buf) };
            if rc == 0 {
                let fs_type = unsafe { CStr::from_ptr(buf.f_fstypename.as_ptr()) }
                    .to_string_lossy()
                    .trim()
                    .to_string();
                if !fs_type.is_empty() {
                    let is_net = is_network_fs_type(&fs_type);
                    return MountFsProbe {
                        is_network_fs: is_net,
                        fs_type: Some(fs_type),
                    };
                }
            }
        }
    }

    #[cfg(target_os = "windows")]
    {
        if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
            return MountFsProbe {
                is_network_fs: true,
                fs_type: Some("smb".to_string()),
            };
        }
    }

    MountFsProbe::default()
}

pub fn detect_offline_mount_for_paths(
    paths: &[PathBuf],
    mounts: &[MountStatus],
) -> Option<String> {
    detect_offline_mount_for_paths_with_roots(paths, mounts, Path::new("/Volumes"))
}

/// Checks whether a candidate path resides on a missing/unmounted network or removable share stub.
fn detect_unmounted_share_stub_for_path(
    path: &Path,
    volumes_root: &Path,
    #[allow(unused_variables)] proc_mounts_txt: Option<&str>,
) -> Option<String> {
    #[cfg(unix)]
    use std::os::unix::fs::MetadataExt;

    // 1. macOS /Volumes/<Share> (or injected test volumes_root/<Share>) unmounted/stub guard
    if let Ok(rel) = path.strip_prefix(volumes_root) {
        if let Some(std::path::Component::Normal(share)) = rel.components().next() {
            let share_dir = volumes_root.join(share);
            if !share_dir.exists() {
                return Some(share_dir.to_string_lossy().to_string());
            }
            #[cfg(unix)]
            {
                let is_symlink = std::fs::symlink_metadata(&share_dir)
                    .map(|m| m.file_type().is_symlink())
                    .unwrap_or(false);
                if !is_symlink {
                    if let (Ok(v_meta), Ok(s_meta)) =
                        (std::fs::metadata(volumes_root), std::fs::metadata(&share_dir))
                    {
                        if s_meta.dev() == v_meta.dev() {
                            return Some(share_dir.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }

    // 2. Linux /mnt/<share> empty unmounted stub or missing mount root guard
    #[cfg(target_os = "linux")]
    {
        for base_prefix in ["/mnt", "/media", "/run/media"] {
            let base = Path::new(base_prefix);
            if let Ok(rel) = path.strip_prefix(base) {
                let depth = if base_prefix == "/mnt" { 1 } else { 2 };
                let mut comps = rel.components();
                let mut candidate = base.to_path_buf();
                let mut taken = 0usize;
                while taken < depth {
                    if let Some(std::path::Component::Normal(part)) = comps.next() {
                        candidate.push(part);
                        taken += 1;
                    } else {
                        break;
                    }
                }
                if taken == depth {
                    if !candidate.exists() {
                        return Some(candidate.to_string_lossy().to_string());
                    }
                    if let (Ok(p_meta), Ok(c_meta)) = (
                        std::fs::metadata(candidate.parent().unwrap_or(base)),
                        std::fs::metadata(&candidate),
                    ) {
                        let is_active_mount = proc_mounts_txt
                            .and_then(|txt| parse_proc_mounts_for_path(txt, &candidate))
                            .map(|(mp, _)| mp == candidate)
                            .unwrap_or(false);
                        let dir_empty = std::fs::read_dir(&candidate)
                            .map(|mut it| it.next().is_none())
                            .unwrap_or(false);
                        if !is_active_mount && c_meta.dev() == p_meta.dev() && dir_empty {
                            return Some(candidate.to_string_lossy().to_string());
                        }
                    }
                }
            }
        }
    }

    // 3. Windows UNC share (\\server\share) check
    #[cfg(target_os = "windows")]
    {
        let raw = path.to_string_lossy();
        if let Some(rest) = raw.strip_prefix("\\\\") {
            let mut segs = rest.split('\\').filter(|s| !s.is_empty());
            if let (Some(srv), Some(share)) = (segs.next(), segs.next()) {
                let unc_root = format!("\\\\{srv}\\{share}");
                if !Path::new(&unc_root).exists() {
                    return Some(unc_root);
                }
            }
        }
    }

    None
}

/// Returns `true` only when `path` is backed by a live, readable directory (not an unmounted SMB/NAS stub).
pub fn probe_mount_online(path: &Path) -> bool {
    probe_mount_online_with_volumes_root(path, Path::new("/Volumes"))
}

pub fn probe_mount_online_with_volumes_root(path: &Path, volumes_root: &Path) -> bool {
    #[cfg(target_os = "linux")]
    let proc_mounts_txt = std::fs::read_to_string("/proc/mounts").ok();
    #[cfg(not(target_os = "linux"))]
    let proc_mounts_txt: Option<String> = None;

    if detect_unmounted_share_stub_for_path(path, volumes_root, proc_mounts_txt.as_deref()).is_some()
    {
        return false;
    }

    if !std::fs::metadata(path).map(|m| m.is_dir()).unwrap_or(false) {
        return false;
    }
    std::fs::read_dir(path).is_ok()
}

/// Probes every configured/indexed `user_custom` mount and updates `storage_mounts.is_online`
/// without walking mount contents. Returns `true` if any mount state changed or was newly registered.
pub fn refresh_mount_online_states(db: &LibraryDatabase, settings: &SimpSettings) -> bool {
    let ignored_roots: HashSet<String> = settings
        .library
        .ignored_paths
        .values()
        .map(|s| normalize_platform_path(s).to_string_lossy().to_string())
        .collect();

    let mut changed = false;
    let mut known_roots: HashSet<String> = HashSet::new();

    if let Ok(existing_mounts) = db.get_mounts() {
        for m in existing_mounts {
            let norm_mount = normalize_platform_path(&m.mount_root)
                .to_string_lossy()
                .to_string();
            known_roots.insert(m.mount_root.clone());
            known_roots.insert(norm_mount.clone());
            if m.mount_kind != "user_custom"
                || ignored_roots.contains(&m.mount_root)
                || ignored_roots.contains(&norm_mount)
            {
                continue;
            }
            let online = probe_mount_online(Path::new(&m.mount_root));
            if online != m.is_online {
                if db.set_mount_online(&m.mount_root, online).is_ok() {
                    tracing::info!(
                        "Storage mount '{}' state transitioned: {}",
                        m.mount_root,
                        if online { "online" } else { "offline" }
                    );
                    changed = true;
                }
            }
        }
    }

    for raw_path_str in settings.library.custom_paths.values() {
        let norm_path = normalize_platform_path(raw_path_str);
        let norm_str = norm_path.to_string_lossy().to_string();
        if norm_str.is_empty()
            || ignored_roots.contains(&norm_str)
            || ignored_roots.contains(raw_path_str)
            || known_roots.contains(&norm_str)
        {
            continue;
        }
        known_roots.insert(norm_str.clone());
        if probe_mount_online(&norm_path) {
            let label = norm_path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| norm_str.clone());
            if db.upsert_mount(&norm_str, &label, "user_custom", true).is_ok() {
                tracing::info!("Registered newly online storage mount '{}'", norm_str);
                changed = true;
            }
        }
    }

    changed
}

pub fn detect_offline_mount_for_paths_with_roots(
    paths: &[PathBuf],
    mounts: &[MountStatus],
    volumes_root: &Path,
) -> Option<String> {
    #[cfg(target_os = "linux")]
    let proc_mounts_txt = std::fs::read_to_string("/proc/mounts").ok();
    #[cfg(not(target_os = "linux"))]
    let proc_mounts_txt: Option<String> = None;

    for path in paths {
        if let Some(stub) =
            detect_unmounted_share_stub_for_path(path, volumes_root, proc_mounts_txt.as_deref())
        {
            return Some(stub);
        }

        // 4. Known DB mount state check (`storage_mounts`)
        let matched = mounts
            .iter()
            .filter(|m| {
                let mp = Path::new(&m.mount_root);
                path == mp || path.starts_with(mp)
            })
            .max_by_key(|m| m.mount_root.len());
        if let Some(m) = matched {
            if !m.is_online || !Path::new(&m.mount_root).is_dir() {
                return Some(m.mount_root.clone());
            }
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_tag_year_handles_iso_dates_and_rejects_invalid() {
        let mut tag = Tag::new(lofty::tag::TagType::Id3v2);
        tag.insert_text(ItemKey::RecordingDate, "2012-06-12T07:00:00Z".to_string());
        assert_eq!(extract_tag_year(&tag), Some(2012));

        let mut tag_mp4 = Tag::new(lofty::tag::TagType::Mp4Ilst);
        tag_mp4.insert_text(ItemKey::RecordingDate, "1996-03-04T08:00:00Z".to_string());
        assert_eq!(extract_tag_year(&tag_mp4), Some(1996));

        let mut tag_set = Tag::new(lofty::tag::TagType::Mp4Ilst);
        tag_set.set_year(1998);
        assert_eq!(extract_tag_year(&tag_set), Some(1998));

        let mut tag_invalid = Tag::new(lofty::tag::TagType::Id3v2);
        tag_invalid.insert_text(ItemKey::RecordingDate, "abcd-ef".to_string());
        assert_eq!(extract_tag_year(&tag_invalid), None);

        let mut tag_oob = Tag::new(lofty::tag::TagType::Id3v2);
        tag_oob.insert_text(ItemKey::RecordingDate, "0000-01-01".to_string());
        assert_eq!(extract_tag_year(&tag_oob), None);
    }

    #[test]
    fn test_parse_steam_ost_filename_stem() {
        let (no, artist, title) = parse_stem_metadata("11 - Hideki Naganuma - JACK DA FUNK");
        assert_eq!(no, Some(11));
        assert_eq!(artist.as_deref(), Some("Hideki Naganuma"));
        assert_eq!(title, "JACK DA FUNK");
    }

    #[test]
    fn test_compute_relative_parent_folder() {
        assert_eq!(
            compute_relative_parent_folder("/mnt/music", Path::new("/mnt/music/01.flac")),
            "/"
        );
        assert_eq!(
            compute_relative_parent_folder(
                "/mnt/music/",
                Path::new("/mnt/music/Example Artist/Sample Album/01.flac")
            ),
            "Example Artist/Sample Album"
        );
        assert_eq!(
            compute_relative_parent_folder(
                "D:\\Music",
                Path::new("D:\\Music\\Synth\\Album\\02.mp3")
            ),
            "Synth/Album"
        );
    }

    #[test]
    fn test_drain_pending_refresh_queue_updates_db_and_removes_file() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("simp_pending_refresh_{nanos}"));
        let old_dir = root.join("Sample Artist").join("Scattered Album");
        let new_dir = root.join("Sample Artist").join("Sample Album");
        std::fs::create_dir_all(&old_dir).unwrap();
        std::fs::create_dir_all(&new_dir).unwrap();

        let old_file = old_dir.join("01 - Track 01.wav");
        let new_file = new_dir.join("01 - Track 01.wav");

        // Minimal 44-byte PCM WAV header
        let mut wav = Vec::with_capacity(44);
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&36u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&44100u32.to_le_bytes());
        wav.extend_from_slice(&88200u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&0u32.to_le_bytes());
        std::fs::write(&old_file, &wav).unwrap();

        let db = LibraryDatabase::open(&root.join("library.db")).unwrap();
        let root_str = root.to_string_lossy().to_string();
        db.upsert_mount(&root_str, "Music", "user_custom", true)
            .unwrap();
        scan_mount_directory_with_progress(&db, &root, &root_str, "local", None);
        assert_eq!(db.list_local_track_index_snapshot(None).unwrap().len(), 1);

        // Simulate external move performed while IMP was offline
        std::fs::rename(&old_file, &new_file).unwrap();

        let queue_path = root.join("pending_refresh.json");
        let payload = vec![PendingRefreshEntry {
            old_paths: vec![old_file.to_string_lossy().to_string()],
            new_paths: vec![new_file.to_string_lossy().to_string()],
            fallback_root: Some(root_str.clone()),
        }];
        std::fs::write(&queue_path, serde_json::to_string(&payload).unwrap()).unwrap();

        let refreshed = drain_pending_refresh_queue(&db, &queue_path).unwrap();
        assert_eq!(refreshed, 1);
        assert!(!queue_path.exists());
        assert!(!queue_path.with_extension("processing.json").exists());

        let snapshot = db.list_local_track_index_snapshot(None).unwrap();
        assert_eq!(snapshot.len(), 1);
        assert_eq!(snapshot[0].path, new_file.to_string_lossy().to_string());
        assert_eq!(snapshot[0].album_title, "Sample Album");
        assert_eq!(db.get_albums(Some("local"), None, 20, 0).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    fn seed_test_track(
        db: &LibraryDatabase,
        album_id: &str,
        track_uri: &str,
        title: &str,
        mount_root: Option<&str>,
    ) {
        db.upsert_indexed_batch(&[IndexedTrackBatchItem {
            album_id: album_id.to_string(),
            album_title: "Sample Album".to_string(),
            album_artist: "Sample Artist".to_string(),
            steam_app_id: None,
            release_year: Some(2025),
            art_cache_path: None,
            genre: None,
            parent_folder: None,
            track: TrackMetadata {
                uri: track_uri.to_string(),
                title: title.to_string(),
                artists: vec!["Sample Artist".to_string()],
                album: "Sample Album".to_string(),
                album_id: Some(album_id.to_string()),
                track_number: Some(1),
                disc_number: Some(1),
                art_url: None,
                duration_ms: 200_000,
                source: "local".to_string(),
                mount_root: mount_root.map(|s| s.to_string()),
                content_rating: None,
                ..Default::default()
            },
            file_mtime: Some(1),
            file_size: Some(100),
            has_art: false,
            has_local_lrc: false,
        }])
        .unwrap();
    }

    #[test]
    fn test_drain_pending_enrichment_queue_imports_and_cleans_up() {
        use base64::Engine as _;

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("imp_pending_enrichment_{nanos}"));
        std::fs::create_dir_all(&root).unwrap();
        let db = LibraryDatabase::open(&root.join("library.db")).unwrap();

        let album_id = format!("local_alb_enr_{nanos}");
        let track_uri = format!("file:///Volumes/Music/SampleArtist/{nanos}_enr.flac");
        let title = format!("Sample Enrich {nanos}");
        seed_test_track(&db, &album_id, &track_uri, &title, None);

        let mut fake_png = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n'];
        fake_png.extend_from_slice(&nanos.to_le_bytes());
        fake_png.resize(300, 0x33);

        let batch = vec![PendingEnrichmentBatch {
            lyrics: vec![PushLyricsItem {
                track_uri: track_uri.clone(),
                title: title.clone(),
                artist: "Sample Artist".to_string(),
                album: Some("Sample Album".to_string()),
                duration_ms: 200_000,
                synced_lines: vec![crate::lyrics::SyncedLyricLine {
                    timestamp_ms: 5000,
                    text: "Offline lyric line".to_string(),
                }],
                plain_lyrics: Some("Offline lyric line".to_string()),
                instrumental: false,
                provider: Some("lrclib_v2".to_string()),
                lrclib_id: Some(777),
            }],
            factoids: vec![PushFactoidsItem {
                track_uri: track_uri.clone(),
                title: title.clone(),
                artist: "Sample Artist".to_string(),
                album: Some("Sample Album".to_string()),
                provider: Some("wikipedia_v2+librarian".to_string()),
                bubbles: vec![crate::factoids::FactoidBubble {
                    category: "studio".to_string(),
                    headline: "Analog Session".to_string(),
                    body: format!("Offline enrichment test {nanos} factoid bubble payload."),
                    source: "Wikipedia".to_string(),
                    start_sec: 15,
                    duration_sec: 10,
                    part_index: Some(1),
                    part_total: Some(1),
                }],
            }],
            artwork: vec![PushArtworkItem {
                album_id: Some(album_id.clone()),
                track_uris: vec![track_uri.clone()],
                image_base64: base64::engine::general_purpose::STANDARD.encode(&fake_png),
                mime_type: Some("image/png".to_string()),
                source: Some("coverartarchive".to_string()),
            }],
        }];

        let queue_path = root.join("pending_enrichment.json");
        std::fs::write(&queue_path, serde_json::to_string(&batch).unwrap()).unwrap();

        let imported = drain_pending_enrichment_queue(&db, &queue_path).unwrap();
        assert_eq!(imported, 3);
        assert!(!queue_path.exists());
        assert!(!queue_path.with_extension("processing.json").exists());

        let props = db.get_track_properties(&track_uri).unwrap();
        assert!(props.has_lyrics);
        assert!(props.has_synced_lyrics);
        assert!(props.has_factoids);
        assert!(props.has_art);

        // Clean up art file written for test
        let audit = db.get_librarian_cache_audit(true, 100).unwrap();
        assert_eq!(audit.has_lyrics_count, 1);
        assert_eq!(audit.has_factoids_count, 1);
        assert_eq!(audit.has_art_count, 1);
        assert!(audit.missing_uris.as_ref().unwrap().art.is_empty());

        if let Some((_, Some(art_url), _)) = db.get_musicbrainz_art_cache(&album_id) {
            if let Some(fname) = art_url.rsplit('/').next() {
                let _ = std::fs::remove_file(crate::imp_art_cache_dir().join(fname));
                let _ = std::fs::remove_file(std::env::temp_dir().join(fname));
            }
        }
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_smb_offline_mount_stub_blocks_pruning_and_defers_queue() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("imp_smb_guard_{nanos}"));
        let volumes_stub_root = root.join("Volumes");
        let offline_share_stub = volumes_stub_root.join("NasShare");
        std::fs::create_dir_all(&offline_share_stub).unwrap();

        let offline_track_path = offline_share_stub
            .join("SampleArtist")
            .join("SampleAlbum")
            .join("01.flac");

        // Same st_dev stub under fake /Volumes catches offline mount even if empty stub dir exists
        let detected = detect_offline_mount_for_paths_with_roots(
            std::slice::from_ref(&offline_track_path),
            &[],
            &volumes_stub_root,
        );
        assert_eq!(
            detected.as_deref(),
            Some(offline_share_stub.to_string_lossy().as_ref())
        );

        // Drain pending refresh queue should retain offline-mount entries instead of dropping them
        let db = LibraryDatabase::open(&root.join("library.db")).unwrap();
        let share_str = offline_share_stub.to_string_lossy().to_string();
        db.upsert_mount(&share_str, "NasShare", "user_custom", false)
            .unwrap();
        let track_uri = format!("file://{}", offline_track_path.to_string_lossy());
        seed_test_track(&db, "alb_nas", &track_uri, "Track 01", Some(&share_str));

        let queue_path = root.join("pending_refresh.json");
        let payload = vec![PendingRefreshEntry {
            old_paths: vec![offline_track_path.to_string_lossy().to_string()],
            new_paths: vec![],
            fallback_root: Some(share_str.clone()),
        }];
        std::fs::write(&queue_path, serde_json::to_string(&payload).unwrap()).unwrap();

        let refreshed = drain_pending_refresh_queue(&db, &queue_path).unwrap();
        assert_eq!(refreshed, 0);
        // Entry was retained in queue_path for retry when mount comes back online, and track wasn't pruned
        assert!(queue_path.is_file());
        assert_eq!(db.list_local_track_index_snapshot(None).unwrap().len(), 1);

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_compute_local_album_id_normalizes_nfc_and_nfd_identically() {
        let composed_album = "Caf\u{00E9} OST";
        let decomposed_album = "Cafe\u{0301} OST";
        let composed_dir = Path::new("/Volumes/Music/Caf\u{00E9}");
        let decomposed_dir = Path::new("/Volumes/Music/Cafe\u{0301}");

        assert_eq!(
            compute_local_album_id(composed_album, composed_dir, "local"),
            compute_local_album_id(decomposed_album, decomposed_dir, "local"),
        );
    }

    #[test]
    fn test_probe_mount_online_rejects_missing_and_volumes_stub_accepts_real_dir() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("imp_probe_mount_{nanos}"));
        let volumes_stub_root = root.join("Volumes");
        let stub_dir = volumes_stub_root.join("OfflineShare");
        let real_dir = root.join("LocalMusic");
        std::fs::create_dir_all(&stub_dir).unwrap();
        std::fs::create_dir_all(&real_dir).unwrap();

        assert!(probe_mount_online_with_volumes_root(&real_dir, &volumes_stub_root));
        assert!(!probe_mount_online_with_volumes_root(
            &stub_dir,
            &volumes_stub_root
        ));
        assert!(!probe_mount_online_with_volumes_root(
            &root.join("MissingDir"),
            &volumes_stub_root
        ));

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn test_refresh_mount_online_states_recovers_offline_mount_and_detects_disconnect() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("imp_mount_recover_{nanos}"));
        let share_dir = root.join("NasMusic");
        std::fs::create_dir_all(&share_dir).unwrap();

        let db = LibraryDatabase::open(&root.join("library.db")).unwrap();
        let share_str = share_dir.to_string_lossy().to_string();
        db.upsert_mount(&share_str, "NasMusic", "user_custom", false)
            .unwrap();

        let mut cfg = SimpSettings::default();
        cfg.library
            .custom_paths
            .insert("0".to_string(), share_str.clone());

        assert!(refresh_mount_online_states(&db, &cfg));
        let mounts_after_recovery = db.get_mounts().unwrap();
        assert_eq!(mounts_after_recovery.len(), 1);
        assert!(mounts_after_recovery[0].is_online);

        // No-op when state did not change
        assert!(!refresh_mount_online_states(&db, &cfg));

        // Simulate NAS unplug
        std::fs::remove_dir_all(&share_dir).unwrap();
        assert!(refresh_mount_online_states(&db, &cfg));
        let mounts_after_unplug = db.get_mounts().unwrap();
        assert!(!mounts_after_unplug[0].is_online);

        let _ = std::fs::remove_dir_all(&root);
    }
}
