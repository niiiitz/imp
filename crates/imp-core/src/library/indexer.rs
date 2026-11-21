use crate::library::artwork::{
    cache_folder_artwork_file, extract_and_cache_artwork_from_tagged,
    fetch_musicbrainz_cover_for_album, pick_preferred_folder_image, resolve_and_cache_artwork,
    MusicBrainzArtOutcome,
};
use crate::library::db::{IndexedTrackBatchItem, LibraryDatabase};
use crate::library::mounts::discover_removable_mounts;
use crate::library::vdf::{discover_steam_music_directories, normalize_platform_path};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag};
use imp_protocol::{SimpSettings, TrackMetadata};
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

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
    crate::prefer_efficiency_core_for_current_thread();
    let ignored_roots: HashSet<String> = settings
        .library
        .ignored_paths
        .values()
        .map(|s| normalize_platform_path(s).to_string_lossy().to_string())
        .collect();

    // 1. User-configured custom paths (normalized for Windows C:\ and bash-escaped spaces)
    let mut active_custom_roots = HashSet::new();
    for (_key, raw_path_str) in &settings.library.custom_paths {
        let norm_path = normalize_platform_path(raw_path_str);
        let norm_str = norm_path.to_string_lossy().to_string();
        if ignored_roots.contains(&norm_str) || ignored_roots.contains(raw_path_str) {
            continue;
        }
        if !active_custom_roots.insert(norm_str.clone()) {
            continue;
        }
        let online = norm_path.is_dir();
        let label = norm_path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| norm_str.clone());
        let _ = db.upsert_mount(&norm_str, &label, "user_custom", online);
        if online {
            scan_mount_directory(db, &norm_path, &norm_str, "local");
        }
    }

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
            scan_mount_directory(db, &ost_dir, &root_str, "steam_ost");
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
            scan_mount_directory(db, &mount_path, &root_str, "local");
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

fn scan_mount_directory(db: &LibraryDatabase, dir: &Path, mount_root: &str, source: &str) {
    let fingerprints = db.get_mount_file_fingerprints(mount_root).unwrap_or_default();
    let needs_backfill = db
        .get_tracks_missing_folder_metadata(mount_root)
        .unwrap_or_default();

    let mut audio_files: Vec<(PathBuf, i64, i64)> = Vec::new();
    let mut video_files: Vec<(PathBuf, i64, i64)> = Vec::new();
    let mut lrc_stems: HashSet<(PathBuf, String)> = HashSet::new();
    let mut folder_images: HashMap<PathBuf, Vec<PathBuf>> = HashMap::new();

    // Single directory walk capturing audio, video, sidecar `.lrc`, and folder artwork files
    // alongside stat metadata to avoid redundant SMB RPC round-trips per file.
    for entry in WalkDir::new(dir)
        .follow_links(false)
        .max_depth(10)
        .into_iter()
        .filter_entry(|e| !is_ignored_walk_entry(e))
        .filter_map(Result::ok)
    {
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
        let has_local_lrc = lrc_stems.contains(&(parent_dir, stem_key));

        if let Some((cached_mtime, cached_size, cached_art)) = fingerprints.get(&uri) {
            if *cached_mtime == file_mtime && *cached_size == file_size {
                let art_str = cached_art.as_deref().unwrap_or("");
                let is_emb = art_str.contains("/simp_art_emb_");
                let is_mb = art_str.contains("/mb_");
                // Only reuse cached fingerprint if:
                // - Artwork came from embedded audio tags (`simp_art_emb_`), OR
                // - Folder still has a local cover image (`has_local_dir_art == true`), OR
                // - Artwork came from MusicBrainz (`mb_`) and no local folder cover image was added.
                // This ensures deleting or adding `cover.png`/`cover.jpg` in a folder is immediately detected!
                if is_emb || (is_mb && !has_local_dir_art) || (!is_mb && has_local_dir_art) {
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
        let parsed_out: Mutex<Vec<IndexedTrackBatchItem>> = Mutex::new(Vec::new());

        std::thread::scope(|s| {
            for _ in 0..worker_count {
                s.spawn(|| loop {
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
                        parsed_out.lock().unwrap().push(batch_item);
                    }
                });
            }
        });

        let parsed_items = parsed_out.into_inner().unwrap();
        for chunk in parsed_items.chunks(250) {
            let _ = db.upsert_indexed_batch(chunk);
        }
    }

    if source == "local" && !video_files.is_empty() {
        let mut video_batch: Vec<IndexedTrackBatchItem> = Vec::new();
        for (path, file_size, file_mtime) in video_files {
            let uri = format!("video://local/{}", path.to_string_lossy());
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

    let parent_folder_key = path
        .parent()
        .map(|p| p.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let parent_folder = compute_relative_parent_folder(mount_root, path);
    let album_id_input = format!(
        "{}::{}::local_video",
        folder_album.to_lowercase(),
        parent_folder_key
    );
    let album_id = blake3::hash(album_id_input.as_bytes()).to_hex()[..16].to_string();
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
    let parent_folder_key = path
        .parent()
        .map(|p| p.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let parent_folder = compute_relative_parent_folder(mount_root, path);
    let album_id_input = format!("{}::{}::{}", album.to_lowercase(), parent_folder_key, source);
    let album_id = blake3::hash(album_id_input.as_bytes()).to_hex()[..16].to_string();

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

    let mut seen_old: HashSet<String> = HashSet::new();
    let mut old_paths: Vec<PathBuf> = Vec::new();
    let mut seen_new: HashSet<String> = HashSet::new();
    let mut new_paths: Vec<PathBuf> = Vec::new();
    let mut fallback_root: Option<String> = None;

    for entry in entries {
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

    if old_paths.is_empty() && new_paths.is_empty() {
        let _ = std::fs::remove_file(&processing_path);
        return Ok(0);
    }

    let fallback_pb = PathBuf::from(fallback_root.as_deref().unwrap_or("/"));
    let res = refresh_local_paths_in_db(db, &old_paths, &new_paths, &fallback_pb);
    let _ = std::fs::remove_file(&processing_path);
    res
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
        scan_mount_directory(&db, &root, &root_str, "local");
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
}
