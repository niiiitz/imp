use crate::liberation::census::{classify_http_error, HttpErrorKind};
use crate::liberation::verify::verify_audio_file;
use crate::library::services_cache::{
    current_unix_sec, LiberationDownloadDbSummary, LiberationTrackRecord, ServicesCacheDatabase,
};
use crate::sinks::apple_api::{
    detect_audio_container_from_magic, resolve_fresh_direct_audio_download, resolve_tokens,
    LiberationOwnershipClass,
};
use anyhow::{anyhow, Context, Result};
use imp_protocol::SimpSettings;
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::picture::{MimeType, Picture, PictureType};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::Duration;

const TWO_GIB: u64 = 2 * 1024 * 1024 * 1024;
const LOW_SPACE_START_FLOOR: u64 = 1_500_000_000;
const LOW_SPACE_PAUSE_FLOOR: u64 = 1_073_741_824;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadPreflightReport {
    pub dest_dir: String,
    pub scope: String,
    pub remaining_tracks: usize,
    pub estimated_remaining_bytes: u64,
    pub required_with_headroom_bytes: u64,
    pub available_bytes: u64,
    pub headroom_ok: bool,
    pub critical_low_space: bool,
}

pub fn available_disk_bytes(path: &Path) -> Result<u64> {
    let mut cursor = path;
    while !cursor.exists() {
        match cursor.parent() {
            Some(p) if !p.as_os_str().is_empty() => cursor = p,
            _ => break,
        }
    }
    let check_path = if cursor.exists() {
        cursor
    } else {
        Path::new("/")
    };

    #[cfg(unix)]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let cstr = CString::new(check_path.as_os_str().as_bytes())
            .context("Invalid non-NUL path for statvfs")?;
        let mut st: libc::statvfs = unsafe { std::mem::zeroed() };
        let rc = unsafe { libc::statvfs(cstr.as_ptr(), &mut st) };
        if rc != 0 {
            return Err(anyhow!(
                "statvfs failed for {}: {}",
                check_path.display(),
                std::io::Error::last_os_error()
            ));
        }
        Ok((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        #[link(name = "kernel32")]
        extern "system" {
            fn GetDiskFreeSpaceExW(
                lpDirectoryName: *const u16,
                lpFreeBytesAvailableToCaller: *mut u64,
                lpTotalNumberOfBytes: *mut u64,
                lpTotalNumberOfFreeBytes: *mut u64,
            ) -> i32;
        }
        let wide: Vec<u16> = check_path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut free_avail: u64 = 0;
        let mut total_bytes: u64 = 0;
        let mut total_free: u64 = 0;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                wide.as_ptr(),
                &mut free_avail,
                &mut total_bytes,
                &mut total_free,
            )
        };
        if ok == 0 {
            return Err(anyhow!(
                "GetDiskFreeSpaceExW failed for {}",
                check_path.display()
            ));
        }
        Ok(free_avail)
    }
}

pub fn preflight_download(
    cache: &ServicesCacheDatabase,
    dest_dir: &Path,
    scope: &str,
) -> Result<DownloadPreflightReport> {
    let (remaining_tracks, estimated_remaining_bytes) = cache.get_download_scope_estimate(scope)?;
    let available_bytes = available_disk_bytes(dest_dir)?;
    let required_with_headroom_bytes = estimated_remaining_bytes.saturating_add(TWO_GIB);
    let headroom_ok = available_bytes >= required_with_headroom_bytes;
    let critical_low_space = available_bytes < LOW_SPACE_START_FLOOR;

    Ok(DownloadPreflightReport {
        dest_dir: dest_dir.to_string_lossy().to_string(),
        scope: scope.to_string(),
        remaining_tracks,
        estimated_remaining_bytes,
        required_with_headroom_bytes,
        available_bytes,
        headroom_ok,
        critical_low_space,
    })
}

pub fn sanitize_path_component(raw: &str) -> String {
    let cleaned: String = raw
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        return "Unknown".to_string();
    }
    let truncated: String = trimmed.chars().take(110).collect();
    let final_trim = truncated.trim().trim_matches('.').trim();
    if final_trim.is_empty() {
        "Unknown".to_string()
    } else {
        final_trim.to_string()
    }
}

pub fn build_reclaimed_track_path(
    dest_dir: &Path,
    track: &LiberationTrackRecord,
    ext: &str,
) -> PathBuf {
    let artist_src = if !track.album_artist.trim().is_empty() {
        track.album_artist.as_str()
    } else {
        track.artist.as_str()
    };
    let artist_dir = sanitize_path_component(artist_src);
    let album_dir = sanitize_path_component(&track.album);
    let safe_title = sanitize_path_component(&track.title);
    let safe_ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    let clean_ext = if safe_ext.is_empty() { "m4a" } else { safe_ext.as_str() };

    let disc = track.disc_number.unwrap_or(1);
    let file_stem = match track.track_number {
        Some(tn) if tn > 0 && disc > 1 => format!("{disc}-{tn:02} {safe_title}"),
        Some(tn) if tn > 0 => format!("{tn:02} {safe_title}"),
        _ => safe_title,
    };

    dest_dir
        .join(artist_dir)
        .join(album_dir)
        .join(format!("{file_stem}.{clean_ext}"))
}

fn detect_image_mime(bytes: &[u8]) -> Option<MimeType> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(MimeType::Jpeg)
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        Some(MimeType::Png)
    } else {
        None
    }
}

/// Fills missing metadata tags (preserving any existing rich embedded tags) and attaches
/// front cover artwork if absent, saving cleanly via `lofty`.
pub fn embed_liberation_metadata_tags(
    file_path: &Path,
    track: &LiberationTrackRecord,
    art_bytes: Option<&[u8]>,
) -> Result<()> {
    let mut tagged_file = Probe::open(file_path)?
        .guess_file_type()?
        .read()
        .context("Failed to read audio tags via lofty")?;

    let tag_type = tagged_file.file_type().primary_tag_type();
    if tagged_file.primary_tag().is_none() {
        tagged_file.insert_tag(Tag::new(tag_type));
    }

    if let Some(tag) = tagged_file.primary_tag_mut() {
        let mut changed = false;

        if tag
            .title()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
            && !track.title.trim().is_empty()
        {
            tag.set_title(track.title.trim().to_string());
            changed = true;
        }
        if tag
            .artist()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
            && !track.artist.trim().is_empty()
        {
            tag.set_artist(track.artist.trim().to_string());
            changed = true;
        }
        if tag
            .album()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
            && !track.album.trim().is_empty()
        {
            tag.set_album(track.album.trim().to_string());
            changed = true;
        }
        if tag
            .get_string(&ItemKey::AlbumArtist)
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
            && !track.album_artist.trim().is_empty()
        {
            tag.insert_text(ItemKey::AlbumArtist, track.album_artist.trim().to_string());
            changed = true;
        }
        if tag
            .genre()
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
            && !track.genre.trim().is_empty()
        {
            tag.set_genre(track.genre.trim().to_string());
            changed = true;
        }
        if tag.track().is_none() {
            if let Some(tn) = track.track_number {
                tag.set_track(tn);
                changed = true;
            }
        }
        if tag.track_total().is_none() {
            if let Some(tt) = track.album_track_count {
                tag.set_track_total(tt);
                changed = true;
            }
        }
        if tag.disk().is_none() {
            if let Some(dn) = track.disc_number {
                tag.set_disk(dn);
                changed = true;
            }
        }
        if tag.year().is_none() {
            if let Some(yr) = track.year {
                tag.set_year(yr);
                changed = true;
            }
        }
        if tag
            .get_string(&ItemKey::Isrc)
            .map(|s| s.trim().is_empty())
            .unwrap_or(true)
        {
            if let Some(ref isrc) = track.isrc {
                if !isrc.trim().is_empty() {
                    tag.insert_text(ItemKey::Isrc, isrc.trim().to_string());
                    changed = true;
                }
            }
        }
        if tag.pictures().is_empty() {
            if let Some(bytes) = art_bytes {
                if let Some(mime) = detect_image_mime(bytes) {
                    tag.push_picture(Picture::new_unchecked(
                        PictureType::CoverFront,
                        Some(mime),
                        None,
                        bytes.to_vec(),
                    ));
                    changed = true;
                }
            }
        }

        if changed {
            tagged_file.save_to_path(file_path, WriteOptions::default())?;
        }
    }

    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiberationDownloadRuntimeStatus {
    pub phase: String,
    pub running: bool,
    pub pause_requested: bool,
    pub auth_expired: bool,
    pub low_space_paused: bool,
    pub dest_dir: String,
    pub scope: String,
    pub processed_this_run: usize,
    pub verified_this_run: usize,
    pub corrupt_this_run: usize,
    pub skipped_drm_this_run: usize,
    pub bytes_this_run: u64,
    pub current_track: String,
    pub last_message: String,
    pub started_at: Option<i64>,
    pub updated_at: i64,
}

impl Default for LiberationDownloadRuntimeStatus {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            running: false,
            pause_requested: false,
            auth_expired: false,
            low_space_paused: false,
            dest_dir: String::new(),
            scope: "uploaded_and_reclaimable".to_string(),
            processed_this_run: 0,
            verified_this_run: 0,
            corrupt_this_run: 0,
            skipped_drm_this_run: 0,
            bytes_this_run: 0,
            current_track: String::new(),
            last_message: "Choose a destination folder and run Preflight to reclaim DRM-free Uploaded tracks.".to_string(),
            started_at: None,
            updated_at: current_unix_sec(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiberationDownloadStatusResponse {
    pub runtime: LiberationDownloadRuntimeStatus,
    pub db_summary: LiberationDownloadDbSummary,
}

pub struct LiberationDownloadController {
    runtime: Mutex<LiberationDownloadRuntimeStatus>,
    pause_flag: Arc<AtomicBool>,
}

impl Default for LiberationDownloadController {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(LiberationDownloadRuntimeStatus::default()),
            pause_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

pub fn global_liberation_downloader() -> &'static Arc<LiberationDownloadController> {
    static DL: OnceLock<Arc<LiberationDownloadController>> = OnceLock::new();
    DL.get_or_init(|| Arc::new(LiberationDownloadController::default()))
}

impl LiberationDownloadController {
    pub fn status(&self, cache: &ServicesCacheDatabase) -> Result<LiberationDownloadStatusResponse> {
        let runtime = self.runtime.lock().unwrap().clone();
        let db_summary = cache.get_liberation_download_summary()?;
        Ok(LiberationDownloadStatusResponse { runtime, db_summary })
    }

    pub fn pause(&self) -> Result<()> {
        self.pause_flag.store(true, Ordering::SeqCst);
        let mut rt = self.runtime.lock().unwrap();
        if rt.running {
            rt.pause_requested = true;
            rt.last_message = "Pause requested — completing in-flight downloads cleanly...".to_string();
            rt.updated_at = current_unix_sec();
        }
        Ok(())
    }

    pub fn start(
        self: &Arc<Self>,
        settings: SimpSettings,
        cache: ServicesCacheDatabase,
        dest_dir: PathBuf,
        scope: String,
        allow_partial_space: bool,
        max_tracks: Option<usize>,
    ) -> Result<LiberationDownloadStatusResponse> {
        if self.runtime.lock().unwrap().running {
            return self.status(&cache);
        }
        if dest_dir.as_os_str().is_empty() {
            return Err(anyhow!("Destination folder is required"));
        }
        let preflight = preflight_download(&cache, &dest_dir, &scope)?;
        if preflight.critical_low_space {
            return Err(anyhow!(
                "Insufficient disk space at {} ({:.2} GB free; minimum 1.50 GB required).",
                dest_dir.display(),
                (preflight.available_bytes as f64) / (1024.0 * 1024.0 * 1024.0)
            ));
        }
        if !preflight.headroom_ok && !allow_partial_space && max_tracks.is_none() {
            return Err(anyhow!(
                "Estimated {:.2} GB remaining (+2 GB buffer = {:.2} GB needed), only {:.2} GB available. Free space or enable Partial Download.",
                (preflight.estimated_remaining_bytes as f64) / (1024.0 * 1024.0 * 1024.0),
                (preflight.required_with_headroom_bytes as f64) / (1024.0 * 1024.0 * 1024.0),
                (preflight.available_bytes as f64) / (1024.0 * 1024.0 * 1024.0),
            ));
        }

        let (dev_token, user_token) = resolve_tokens(&settings)?;
        std::fs::create_dir_all(&dest_dir)
            .with_context(|| format!("Failed to create destination folder {}", dest_dir.display()))?;
        let _ = cache.reset_failed_liberation_downloads();

        self.pause_flag.store(false, Ordering::SeqCst);
        let now = current_unix_sec();
        {
            let mut rt = self.runtime.lock().unwrap();
            *rt = LiberationDownloadRuntimeStatus {
                phase: "downloading".to_string(),
                running: true,
                pause_requested: false,
                auth_expired: false,
                low_space_paused: false,
                dest_dir: dest_dir.to_string_lossy().to_string(),
                scope: scope.clone(),
                processed_this_run: 0,
                verified_this_run: 0,
                corrupt_this_run: 0,
                skipped_drm_this_run: 0,
                bytes_this_run: 0,
                current_track: String::new(),
                last_message: if let Some(max) = max_tracks {
                    format!("Starting verified Test Batch (up to {max} tracks)...")
                } else {
                    "Starting resumable DRM-free Cloud Locker reclamation...".to_string()
                },
                started_at: Some(now),
                updated_at: now,
            };
        }

        let ctrl = Arc::clone(self);
        let cache_clone = cache.clone();
        std::thread::Builder::new()
            .name("imp-liberation-download".to_string())
            .spawn(move || {
                ctrl.run_worker(
                    dev_token,
                    user_token,
                    cache_clone,
                    dest_dir,
                    scope,
                    max_tracks,
                );
            })?;

        self.status(&cache)
    }

    fn sleep_interruptible(&self, total: Duration) -> bool {
        let mut rem_ms = total.as_millis() as i64;
        while rem_ms > 0 {
            if self.pause_flag.load(Ordering::SeqCst) {
                return false;
            }
            let slice = rem_ms.min(100) as u64;
            std::thread::sleep(Duration::from_millis(slice));
            rem_ms -= slice as i64;
        }
        !self.pause_flag.load(Ordering::SeqCst)
    }

    fn fetch_artwork_cached(
        art_cache: &Mutex<HashMap<String, Option<Vec<u8>>>>,
        url_opt: Option<&str>,
    ) -> Option<Vec<u8>> {
        let url = url_opt.map(str::trim).filter(|s| !s.is_empty())?;
        if let Ok(g) = art_cache.lock() {
            if let Some(hit) = g.get(url) {
                return hit.clone();
            }
        }
        let fetched = crate::http_pool::http_get_bytes(url, &[], None, 15).ok();
        if let Ok(mut g) = art_cache.lock() {
            if g.len() >= 128 {
                g.clear();
            }
            g.insert(url.to_string(), fetched.clone());
        }
        fetched
    }

    fn resolve_direct_with_backoff(
        &self,
        dev_token: &str,
        user_token: &str,
        song_id: &str,
    ) -> Result<
        std::result::Result<
            crate::sinks::apple_api::FreshDirectDownloadAsset,
            (LiberationOwnershipClass, String),
        >,
    > {
        const BACKOFF_SECS: [u64; 3] = [2, 5, 12];
        let mut attempt = 0usize;
        loop {
            match resolve_fresh_direct_audio_download(dev_token, user_token, song_id) {
                Ok(res) => return Ok(res),
                Err(err) => {
                    let msg = format!("{err:#}");
                    if classify_http_error(&msg) == HttpErrorKind::RateLimited429
                        && attempt < BACKOFF_SECS.len()
                    {
                        let wait_secs = BACKOFF_SECS[attempt];
                        attempt += 1;
                        if !self.sleep_interruptible(Duration::from_secs(wait_secs)) {
                            return Err(anyhow!("Paused during backoff"));
                        }
                        continue;
                    }
                    return Err(err);
                }
            }
        }
    }

    fn download_tag_and_verify_once(
        art_cache: &Mutex<HashMap<String, Option<Vec<u8>>>>,
        url: &str,
        part_path: &Path,
        track: &LiberationTrackRecord,
    ) -> Result<crate::liberation::verify::FileVerificationResult> {
        let bytes = crate::http_pool::http_get_bytes(url, &[], None, 180)
            .with_context(|| format!("Download failed for {}", track.library_song_id))?;
        if detect_audio_container_from_magic(&bytes) == Some("drm_m4p") {
            return Err(anyhow!("Legacy FairPlay M4P DRM container excluded"));
        }
        if let Some(parent) = part_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::write(part_path, &bytes)?;
        let art = Self::fetch_artwork_cached(art_cache, track.artwork_url.as_deref());
        let _ = embed_liberation_metadata_tags(part_path, track, art.as_deref());
        Ok(verify_audio_file(part_path, Some(track.duration_ms)))
    }

    fn run_worker(
        &self,
        dev_token: String,
        user_token: String,
        cache: ServicesCacheDatabase,
        dest_dir: PathBuf,
        scope: String,
        max_tracks: Option<usize>,
    ) {
        let art_cache: Mutex<HashMap<String, Option<Vec<u8>>>> = Mutex::new(HashMap::new());
        let mut remaining_budget = max_tracks.unwrap_or(usize::MAX);
        let auth_tripped = AtomicBool::new(false);
        let low_space_tripped = AtomicBool::new(false);

        while remaining_budget > 0 && !self.pause_flag.load(Ordering::SeqCst) {
            let batch_limit = remaining_budget.min(30);
            let candidates = match cache.list_download_candidates(&scope, batch_limit) {
                Ok(v) => v,
                Err(e) => {
                    let mut rt = self.runtime.lock().unwrap();
                    rt.running = false;
                    rt.phase = "error".to_string();
                    rt.last_message = format!("Database query error: {e}");
                    rt.updated_at = current_unix_sec();
                    return;
                }
            };
            if candidates.is_empty() {
                break;
            }
            remaining_budget = remaining_budget.saturating_sub(candidates.len());
            let queue = Mutex::new(VecDeque::from(candidates));

            std::thread::scope(|scope_threads| {
                for _ in 0..3 {
                    scope_threads.spawn(|| loop {
                        if self.pause_flag.load(Ordering::SeqCst)
                            || auth_tripped.load(Ordering::SeqCst)
                            || low_space_tripped.load(Ordering::SeqCst)
                        {
                            break;
                        }
                        if available_disk_bytes(&dest_dir)
                            .map(|b| b < LOW_SPACE_PAUSE_FLOOR)
                            .unwrap_or(false)
                        {
                            low_space_tripped.store(true, Ordering::SeqCst);
                            break;
                        }

                        let next_track = { queue.lock().unwrap().pop_front() };
                        let Some(track) = next_track else {
                            break;
                        };

                        {
                            let mut rt = self.runtime.lock().unwrap();
                            rt.current_track = format!("{} — {}", track.artist, track.title);
                            rt.updated_at = current_unix_sec();
                        }

                        let resolved = match self.resolve_direct_with_backoff(
                            &dev_token,
                            &user_token,
                            &track.library_song_id,
                        ) {
                            Ok(r) => r,
                            Err(err) => {
                                let msg = format!("{err:#}");
                                if classify_http_error(&msg) == HttpErrorKind::AuthExpired401Or403 {
                                    auth_tripped.store(true, Ordering::SeqCst);
                                    break;
                                }
                                let _ = cache.update_liberation_download_result(
                                    &track.library_song_id,
                                    "corrupt_failed",
                                    None,
                                    None,
                                    None,
                                    None,
                                    None,
                                    None,
                                    Some(&msg),
                                );
                                let mut rt = self.runtime.lock().unwrap();
                                rt.processed_this_run += 1;
                                rt.corrupt_this_run += 1;
                                continue;
                            }
                        };

                        let asset = match resolved {
                            Ok(a) => a,
                            Err((LiberationOwnershipClass::SubscriptionDrmExcluded, reason)) => {
                                let _ = cache.update_liberation_download_result(
                                    &track.library_song_id,
                                    "skipped_drm",
                                    Some("subscription_drm_excluded"),
                                    None,
                                    None,
                                    None,
                                    None,
                                    Some("drm_hls"),
                                    Some(&reason),
                                );
                                let mut rt = self.runtime.lock().unwrap();
                                rt.processed_this_run += 1;
                                rt.skipped_drm_this_run += 1;
                                continue;
                            }
                            Err((LiberationOwnershipClass::Unavailable, reason)) => {
                                let _ = cache.update_liberation_download_result(
                                    &track.library_song_id,
                                    "unavailable",
                                    Some("unavailable"),
                                    None,
                                    None,
                                    None,
                                    None,
                                    None,
                                    Some(&reason),
                                );
                                let mut rt = self.runtime.lock().unwrap();
                                rt.processed_this_run += 1;
                                continue;
                            }
                            Err((_, reason)) => {
                                let _ = cache.update_liberation_download_result(
                                    &track.library_song_id,
                                    "corrupt_failed",
                                    None,
                                    None,
                                    None,
                                    None,
                                    None,
                                    None,
                                    Some(&reason),
                                );
                                let mut rt = self.runtime.lock().unwrap();
                                rt.processed_this_run += 1;
                                rt.corrupt_this_run += 1;
                                continue;
                            }
                        };

                        let final_path =
                            build_reclaimed_track_path(&dest_dir, &track, &asset.container);

                        // Fast idempotent resume if final verified file is already present on disk
                        if final_path.is_file() {
                            let existing_ver =
                                verify_audio_file(&final_path, Some(track.duration_ms));
                            if existing_ver.status == "verified_ok" {
                                let path_str = final_path.to_string_lossy().to_string();
                                let kind_str = format!("direct_{}", asset.container);
                                let _ = cache.update_liberation_download_result(
                                    &track.library_song_id,
                                    "verified_ok",
                                    Some("reclaimable_direct"),
                                    Some(&path_str),
                                    Some(existing_ver.file_size_bytes),
                                    existing_ver.blake3_hash.as_deref(),
                                    Some(&asset.flavor),
                                    Some(&kind_str),
                                    None,
                                );
                                let mut rt = self.runtime.lock().unwrap();
                                rt.processed_this_run += 1;
                                rt.verified_this_run += 1;
                                rt.bytes_this_run += existing_ver.file_size_bytes;
                                continue;
                            }
                        }

                        let part_path =
                            final_path.with_extension(format!("{}.imp.part", asset.container));
                        let mut final_res = Self::download_tag_and_verify_once(
                            &art_cache,
                            &asset.url,
                            &part_path,
                            &track,
                        );
                        let retry_needed = match &final_res {
                            Ok(v) if v.status == "verified_ok" => false,
                            Err(e) if e.to_string().contains("DRM") => false,
                            _ => true,
                        };
                        if retry_needed {
                            let _ = std::fs::remove_file(&part_path);
                            final_res = Self::download_tag_and_verify_once(
                                &art_cache,
                                &asset.url,
                                &part_path,
                                &track,
                            );
                        }

                        match final_res {
                            Ok(ver) if ver.status == "verified_ok" => {
                                if let Some(parent) = final_path.parent() {
                                    let _ = std::fs::create_dir_all(parent);
                                }
                                if let Err(e) = std::fs::rename(&part_path, &final_path) {
                                    let _ = std::fs::remove_file(&part_path);
                                    let _ = cache.update_liberation_download_result(
                                        &track.library_song_id,
                                        "corrupt_failed",
                                        None,
                                        None,
                                        None,
                                        None,
                                        None,
                                        None,
                                        Some(&format!("Atomic rename failed: {e}")),
                                    );
                                    let mut rt = self.runtime.lock().unwrap();
                                    rt.processed_this_run += 1;
                                    rt.corrupt_this_run += 1;
                                    continue;
                                }
                                let path_str = final_path.to_string_lossy().to_string();
                                let kind_str = format!("direct_{}", asset.container);
                                let _ = cache.update_liberation_download_result(
                                    &track.library_song_id,
                                    "verified_ok",
                                    Some("reclaimable_direct"),
                                    Some(&path_str),
                                    Some(ver.file_size_bytes),
                                    ver.blake3_hash.as_deref(),
                                    Some(&asset.flavor),
                                    Some(&kind_str),
                                    None,
                                );
                                let mut rt = self.runtime.lock().unwrap();
                                rt.processed_this_run += 1;
                                rt.verified_this_run += 1;
                                rt.bytes_this_run += ver.file_size_bytes;
                                rt.last_message = format!(
                                    "Reclaimed & verified {} tracks ({} corrupt retries failed)...",
                                    rt.verified_this_run, rt.corrupt_this_run
                                );
                            }
                            Ok(ver) => {
                                let _ = std::fs::remove_file(&part_path);
                                let err_detail = ver
                                    .reason
                                    .unwrap_or_else(|| format!("Failed verification: {}", ver.status));
                                let _ = cache.update_liberation_download_result(
                                    &track.library_song_id,
                                    "corrupt_failed",
                                    None,
                                    None,
                                    None,
                                    None,
                                    Some(&asset.flavor),
                                    None,
                                    Some(&err_detail),
                                );
                                let mut rt = self.runtime.lock().unwrap();
                                rt.processed_this_run += 1;
                                rt.corrupt_this_run += 1;
                            }
                            Err(err) => {
                                let _ = std::fs::remove_file(&part_path);
                                let msg = format!("{err:#}");
                                if msg.contains("DRM") {
                                    let _ = cache.update_liberation_download_result(
                                        &track.library_song_id,
                                        "skipped_drm",
                                        Some("subscription_drm_excluded"),
                                        None,
                                        None,
                                        None,
                                        None,
                                        Some("drm_m4p"),
                                        Some(&msg),
                                    );
                                    let mut rt = self.runtime.lock().unwrap();
                                    rt.processed_this_run += 1;
                                    rt.skipped_drm_this_run += 1;
                                } else {
                                    let _ = cache.update_liberation_download_result(
                                        &track.library_song_id,
                                        "corrupt_failed",
                                        None,
                                        None,
                                        None,
                                        None,
                                        Some(&asset.flavor),
                                        None,
                                        Some(&msg),
                                    );
                                    let mut rt = self.runtime.lock().unwrap();
                                    rt.processed_this_run += 1;
                                    rt.corrupt_this_run += 1;
                                }
                            }
                        }

                        if !self.sleep_interruptible(Duration::from_millis(40)) {
                            break;
                        }
                    });
                }
            });

            if auth_tripped.load(Ordering::SeqCst) || low_space_tripped.load(Ordering::SeqCst) {
                break;
            }
        }

        let auth_exp = auth_tripped.load(Ordering::SeqCst);
        let low_sp = low_space_tripped.load(Ordering::SeqCst);
        let paused = self.pause_flag.load(Ordering::SeqCst);
        let mut rt = self.runtime.lock().unwrap();
        rt.running = false;
        rt.pause_requested = false;
        rt.auth_expired = auth_exp;
        rt.low_space_paused = low_sp;
        rt.updated_at = current_unix_sec();
        if auth_exp {
            rt.phase = "paused".to_string();
            rt.last_message =
                "Apple Music session expired — reconnect in Settings and click Resume."
                    .to_string();
        } else if low_sp {
            rt.phase = "paused".to_string();
            rt.last_message =
                "Auto-paused: free disk space dropped below 1.0 GB safety floor.".to_string();
        } else if paused {
            rt.phase = "paused".to_string();
            rt.last_message = format!(
                "Reclamation paused ({} verified this run; resume anytime).",
                rt.verified_this_run
            );
        } else {
            rt.phase = "completed".to_string();
            rt.last_message = format!(
                "Download batch complete: {} verified OK · {} failed · {} DRM skipped.",
                rt.verified_this_run, rt.corrupt_this_run, rt.skipped_drm_this_run
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::liberation::verify::test_helpers::write_test_wav;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("imp_liberation_dl_{label}_{nanos}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn sample_record() -> LiberationTrackRecord {
        LiberationTrackRecord {
            library_song_id: "i.dl01".to_string(),
            catalog_id: None,
            purchased_id: None,
            isrc: Some("USXXX0000099".to_string()),
            title: "Track: 01 / Demo?".to_string(),
            artist: "Sample Artist".to_string(),
            album_artist: "Sample Album Artist".to_string(),
            album: "Sample*Album".to_string(),
            library_album_id: None,
            track_number: Some(3),
            disc_number: Some(2),
            album_track_count: Some(14),
            duration_ms: 180_000,
            year: Some(2021),
            genre: "Electronic".to_string(),
            artwork_url: None,
            cloud_origin_hint: "uploaded".to_string(),
            ownership_class: "reclaimable_direct".to_string(),
            asset_flavor: Some("cloud_locker_mp3".to_string()),
            asset_url_kind: Some("direct_mp3".to_string()),
            observed_flavors_json: "[]".to_string(),
            content_length_bytes: None,
            probe_status: "probed".to_string(),
            verification_status: "not_downloaded".to_string(),
            blake3_hash: None,
            last_error: None,
            updated_at: 1_000,
            local_path: None,
            downloaded_bytes: None,
        }
    }

    #[test]
    fn test_sanitize_and_build_reclaimed_track_path() {
        assert_eq!(sanitize_path_component("A/B:C*D?"), "A_B_C_D_");
        let dest = Path::new("/tmp/reclaimed");
        let rec = sample_record();
        let built = build_reclaimed_track_path(dest, &rec, "mp3");
        assert_eq!(
            built,
            dest.join("Sample Album Artist")
                .join("Sample_Album")
                .join("2-03 Track_ 01 _ Demo_.mp3")
        );

        let mut single_disc = rec;
        single_disc.disc_number = Some(1);
        let built2 = build_reclaimed_track_path(dest, &single_disc, "m4a");
        assert_eq!(
            built2,
            dest.join("Sample Album Artist")
                .join("Sample_Album")
                .join("03 Track_ 01 _ Demo_.m4a")
        );
    }

    #[test]
    fn test_available_disk_bytes_positive_on_temp_dir() {
        let bytes = available_disk_bytes(&std::env::temp_dir()).expect("disk query should succeed");
        assert!(bytes > 0);
    }

    #[test]
    fn test_embed_liberation_metadata_tags_roundtrip_on_wav() {
        let dir = temp_dir("tags");
        let wav_path = dir.join("03 Test Track.wav");
        write_test_wav(&wav_path, 440.0, 0.5, 100);

        let rec = sample_record();
        embed_liberation_metadata_tags(&wav_path, &rec, None).expect("embed tags should succeed");

        let tagged = Probe::open(&wav_path).unwrap().read().unwrap();
        let tag = tagged.primary_tag().expect("primary tag should exist");
        assert_eq!(tag.title().as_deref(), Some("Track: 01 / Demo?"));
        assert_eq!(tag.artist().as_deref(), Some("Sample Artist"));
        assert_eq!(tag.album().as_deref(), Some("Sample*Album"));
        assert_eq!(tag.track(), Some(3));
        assert_eq!(tag.track_total(), Some(14));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
