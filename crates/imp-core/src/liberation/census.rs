use crate::library::services_cache::{
    current_unix_sec, LiberationCensusSummary, LiberationTrackRecord, ServicesCacheDatabase,
};
use crate::sinks::apple_api::{
    apple_get_json, format_apple_art_url, probe_owned_library_asset_with_tokens, resolve_tokens,
    LiberationOwnershipClass,
};
use anyhow::{anyhow, Result};
use imp_protocol::SimpSettings;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpErrorKind {
    RateLimited429,
    AuthExpired401Or403,
    Other,
}

pub fn classify_http_error(err_text: &str) -> HttpErrorKind {
    let upper = err_text.to_ascii_uppercase();
    if upper.contains("HTTP 429") || upper.contains("TOO MANY REQUESTS") {
        HttpErrorKind::RateLimited429
    } else if upper.contains("HTTP 401") || upper.contains("HTTP 403") {
        HttpErrorKind::AuthExpired401Or403
    } else {
        HttpErrorKind::Other
    }
}

fn url_has_query_key(url: &str, key: &str) -> bool {
    let Some((_, query)) = url.split_once('?') else {
        return false;
    };
    query.split('&').any(|pair| {
        pair.split_once('=')
            .map(|(k, _)| k.eq_ignore_ascii_case(key))
            .unwrap_or_else(|| pair.eq_ignore_ascii_case(key))
    })
}

/// Ensures paginated Apple Music `next` cursor URLs preserve `include=catalog` and `limit=100`.
pub fn append_apple_query_params(url: &str, include_catalog: bool) -> String {
    let mut out = url.trim().to_string();
    if include_catalog && !url_has_query_key(&out, "include") {
        let sep = if out.contains('?') { '&' } else { '?' };
        out.push(sep);
        out.push_str("include=catalog");
    }
    if !url_has_query_key(&out, "limit") {
        let sep = if out.contains('?') { '&' } else { '?' };
        out.push(sep);
        out.push_str("limit=100");
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiberationRuntimeStatus {
    pub phase: String,
    pub running: bool,
    pub pause_requested: bool,
    pub auth_expired: bool,
    pub albums_indexed: usize,
    pub songs_indexed: usize,
    pub pages_fetched: usize,
    pub probed_this_run: usize,
    pub rate_limit_backoffs: usize,
    pub last_message: String,
    pub started_at: Option<i64>,
    pub updated_at: i64,
}

impl Default for LiberationRuntimeStatus {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            running: false,
            pause_requested: false,
            auth_expired: false,
            albums_indexed: 0,
            songs_indexed: 0,
            pages_fetched: 0,
            probed_this_run: 0,
            rate_limit_backoffs: 0,
            last_message: "Ready to run Stage 1 Read-Only Census.".to_string(),
            started_at: None,
            updated_at: current_unix_sec(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LiberationStatusResponse {
    pub runtime: LiberationRuntimeStatus,
    pub summary: LiberationCensusSummary,
}

pub struct LiberationCensusController {
    runtime: Mutex<LiberationRuntimeStatus>,
    pause_flag: Arc<AtomicBool>,
}

impl Default for LiberationCensusController {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(LiberationRuntimeStatus::default()),
            pause_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

pub fn global_liberation_controller() -> &'static Arc<LiberationCensusController> {
    static CONTROLLER: OnceLock<Arc<LiberationCensusController>> = OnceLock::new();
    CONTROLLER.get_or_init(|| Arc::new(LiberationCensusController::default()))
}

impl LiberationCensusController {
    pub fn status(&self, cache: &ServicesCacheDatabase) -> Result<LiberationStatusResponse> {
        let runtime = self.runtime.lock().unwrap().clone();
        let summary = cache.get_liberation_census_summary()?;
        Ok(LiberationStatusResponse { runtime, summary })
    }

    pub fn pause(&self) -> Result<()> {
        self.pause_flag.store(true, Ordering::SeqCst);
        let mut rt = self.runtime.lock().unwrap();
        if rt.running {
            rt.pause_requested = true;
            rt.last_message = "Pause requested — waiting for active requests to finish...".to_string();
            rt.updated_at = current_unix_sec();
        }
        Ok(())
    }

    pub fn reset(&self, cache: &ServicesCacheDatabase) -> Result<LiberationStatusResponse> {
        self.pause_flag.store(true, Ordering::SeqCst);
        for _ in 0..40 {
            if !self.runtime.lock().unwrap().running {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        if self.runtime.lock().unwrap().running {
            return Err(anyhow!(
                "Census worker is still stopping; please retry Reset in a moment"
            ));
        }

        cache.clear_liberation_tracks()?;
        self.pause_flag.store(false, Ordering::SeqCst);
        {
            let mut rt = self.runtime.lock().unwrap();
            *rt = LiberationRuntimeStatus::default();
        }
        self.status(cache)
    }

    pub fn start(
        self: &Arc<Self>,
        settings: SimpSettings,
        cache: ServicesCacheDatabase,
        force_reingest: bool,
        sample_per_bucket: Option<usize>,
    ) -> Result<LiberationStatusResponse> {
        {
            let rt = self.runtime.lock().unwrap();
            if rt.running {
                drop(rt);
                return self.status(&cache);
            }
        }

        // Verify tokens upfront so UI gets an immediate clear error when disconnected
        let (dev_token, user_token) = resolve_tokens(&settings)?;

        self.pause_flag.store(false, Ordering::SeqCst);
        let now = current_unix_sec();
        {
            let mut rt = self.runtime.lock().unwrap();
            rt.running = true;
            rt.pause_requested = false;
            rt.auth_expired = false;
            rt.phase = if force_reingest {
                "ingesting_albums".to_string()
            } else {
                "starting".to_string()
            };
            rt.albums_indexed = 0;
            rt.songs_indexed = 0;
            rt.pages_fetched = 0;
            rt.probed_this_run = 0;
            rt.rate_limit_backoffs = 0;
            rt.started_at = Some(now);
            rt.updated_at = now;
            rt.last_message = if let Some(per_bucket) = sample_per_bucket {
                format!(
                    "Starting Stage 1 Quick Sample ({} per bucket across Purchased / Uploaded / Matched)...",
                    per_bucket.max(1)
                )
            } else {
                "Starting Stage 1 Read-Only Apple Cloud Library Census...".to_string()
            };
        }

        let ctrl = Arc::clone(self);
        let cache_clone = cache.clone();
        std::thread::Builder::new()
            .name("imp-liberation-census".to_string())
            .spawn(move || {
                ctrl.run_census_worker(
                    dev_token,
                    user_token,
                    cache_clone,
                    force_reingest,
                    sample_per_bucket,
                );
            })?;

        self.status(&cache)
    }

    fn sleep_interruptible(&self, total: Duration) -> bool {
        let mut remaining_ms = total.as_millis() as i64;
        while remaining_ms > 0 {
            if self.pause_flag.load(Ordering::SeqCst) {
                return false;
            }
            let slice = remaining_ms.min(100) as u64;
            std::thread::sleep(Duration::from_millis(slice));
            remaining_ms -= slice as i64;
        }
        !self.pause_flag.load(Ordering::SeqCst)
    }

    fn apple_get_with_backoff(&self, url: &str, dev_token: &str, user_token: &str) -> Result<Value> {
        const BACKOFF_SECS: [u64; 5] = [2, 4, 8, 16, 30];
        let mut attempt = 0usize;
        loop {
            match apple_get_json(url, dev_token, user_token) {
                Ok(v) => return Ok(v),
                Err(err) => {
                    let msg = format!("{err:#}");
                    match classify_http_error(&msg) {
                        HttpErrorKind::RateLimited429 => {
                            if attempt >= BACKOFF_SECS.len() {
                                return Err(anyhow!(
                                    "Rate limited (HTTP 429) after {} retries on {url}: {msg}",
                                    BACKOFF_SECS.len()
                                ));
                            }
                            let wait_secs = BACKOFF_SECS[attempt];
                            attempt += 1;
                            {
                                let mut rt = self.runtime.lock().unwrap();
                                rt.rate_limit_backoffs += 1;
                                rt.last_message = format!(
                                    "Apple API rate limited (HTTP 429) — backing off {wait_secs}s..."
                                );
                                rt.updated_at = current_unix_sec();
                            }
                            if !self.sleep_interruptible(Duration::from_secs(wait_secs)) {
                                return Err(anyhow!("Paused during backoff"));
                            }
                        }
                        HttpErrorKind::AuthExpired401Or403 => {
                            return Err(anyhow!("HTTP 401/403 Unauthorized: {msg}"));
                        }
                        HttpErrorKind::Other => return Err(err),
                    }
                }
            }
        }
    }

    fn set_phase_msg(&self, phase: &str, msg: impl Into<String>) {
        let mut rt = self.runtime.lock().unwrap();
        rt.phase = phase.to_string();
        rt.last_message = msg.into();
        rt.updated_at = current_unix_sec();
    }

    fn handle_auth_or_fatal_error(&self, err_text: &str) {
        let mut rt = self.runtime.lock().unwrap();
        rt.running = false;
        rt.updated_at = current_unix_sec();
        match classify_http_error(err_text) {
            HttpErrorKind::AuthExpired401Or403 => {
                rt.auth_expired = true;
                rt.phase = "paused".to_string();
                rt.last_message =
                    "Apple Music session expired — reconnect in Settings and click Resume."
                        .to_string();
            }
            _ => {
                rt.phase = "error".to_string();
                rt.last_message = err_text.to_string();
            }
        }
    }

    fn run_census_worker(
        &self,
        dev_token: String,
        user_token: String,
        cache: ServicesCacheDatabase,
        force_reingest: bool,
        sample_per_bucket: Option<usize>,
    ) {
        let summary_res = cache.get_liberation_census_summary();
        let needs_ingest = force_reingest
            || summary_res.map(|s| s.total_tracks == 0).unwrap_or(true);

        if needs_ingest {
            let album_map = match self.ingest_library_albums(&dev_token, &user_token) {
                Ok(m) => m,
                Err(e) => {
                    if self.pause_flag.load(Ordering::SeqCst) {
                        self.finish_paused();
                    } else {
                        self.handle_auth_or_fatal_error(&format!("{e:#}"));
                    }
                    return;
                }
            };

            if self.pause_flag.load(Ordering::SeqCst) {
                self.finish_paused();
                return;
            }

            if let Err(e) =
                self.ingest_library_songs(&dev_token, &user_token, &cache, &album_map)
            {
                if self.pause_flag.load(Ordering::SeqCst) {
                    self.finish_paused();
                } else {
                    self.handle_auth_or_fatal_error(&format!("{e:#}"));
                }
                return;
            }
        }

        if self.pause_flag.load(Ordering::SeqCst) {
            self.finish_paused();
            return;
        }

        // Phase 2: Probing pending tracks (plus retrying prior probe errors on resume)
        let _ = cache.reset_liberation_error_probes();
        self.set_phase_msg(
            "probing",
            if let Some(per_bucket) = sample_per_bucket {
                format!(
                    "Running stratified Quick Sample (up to {} per origin bucket)...",
                    per_bucket.max(1)
                )
            } else {
                "Probing library songs for DRM-free ownership status...".to_string()
            },
        );

        let mut is_first_batch = true;
        loop {
            if self.pause_flag.load(Ordering::SeqCst) {
                self.finish_paused();
                return;
            }

            let pending = if let Some(per_bucket) = sample_per_bucket {
                if !is_first_batch {
                    break;
                }
                is_first_batch = false;
                match cache.list_stratified_sample_liberation_tracks(per_bucket) {
                    Ok(v) => v,
                    Err(e) => {
                        self.handle_auth_or_fatal_error(&format!("Database read failed: {e}"));
                        return;
                    }
                }
            } else {
                match cache.list_pending_liberation_tracks(64) {
                    Ok(v) => v,
                    Err(e) => {
                        self.handle_auth_or_fatal_error(&format!("Database read failed: {e}"));
                        return;
                    }
                }
            };
            if pending.is_empty() {
                break;
            }

            let auth_tripped = AtomicBool::new(false);
            let queue = Mutex::new(VecDeque::from(pending));

            std::thread::scope(|scope| {
                for _ in 0..4 {
                    scope.spawn(|| loop {
                        if self.pause_flag.load(Ordering::SeqCst)
                            || auth_tripped.load(Ordering::SeqCst)
                        {
                            break;
                        }
                        let next_item = { queue.lock().unwrap().pop_front() };
                        let Some((song_id, catalog_id, purchased_id, _origin_hint)) = next_item
                        else {
                            break;
                        };

                        let probe_res =
                            self.probe_single_song_with_backoff(&dev_token, &user_token, &song_id);
                        match probe_res {
                            Ok(res) => {
                                let ownership_str = res.ownership_class.as_str();
                                let probe_status = if res.ownership_class == LiberationOwnershipClass::Error {
                                    "error"
                                } else {
                                    "probed"
                                };
                                let refined_origin = if purchased_id.is_some() {
                                    Some("purchased")
                                } else {
                                    match res.ownership_class {
                                        LiberationOwnershipClass::ReclaimableDirect
                                        | LiberationOwnershipClass::ReclaimableClearHls => {
                                            if catalog_id.is_none() {
                                                Some("uploaded")
                                            } else {
                                                Some("matched")
                                            }
                                        }
                                        LiberationOwnershipClass::SubscriptionDrmExcluded => {
                                            Some("subscription")
                                        }
                                        _ => None,
                                    }
                                };
                                let flavors_json =
                                    serde_json::to_string(&res.all_observed_flavors)
                                        .unwrap_or_else(|_| "[]".to_string());
                                let _ = cache.update_liberation_probe_result(
                                    &song_id,
                                    ownership_str,
                                    refined_origin,
                                    res.asset_flavor.as_deref(),
                                    res.asset_url_kind.as_deref(),
                                    &flavors_json,
                                    res.content_length_bytes,
                                    probe_status,
                                    res.reason.as_deref(),
                                );
                            }
                            Err(err) => {
                                let msg = format!("{err:#}");
                                if classify_http_error(&msg)
                                    == HttpErrorKind::AuthExpired401Or403
                                {
                                    auth_tripped.store(true, Ordering::SeqCst);
                                    break;
                                }
                                let _ = cache.update_liberation_probe_result(
                                    &song_id,
                                    "error",
                                    None,
                                    None,
                                    None,
                                    "[]",
                                    None,
                                    "error",
                                    Some(&msg),
                                );
                            }
                        }

                        {
                            let mut rt = self.runtime.lock().unwrap();
                            rt.probed_this_run += 1;
                            rt.updated_at = current_unix_sec();
                            rt.last_message = format!(
                                "Probed {} tracks this run (read-only DRM-free audit)...",
                                rt.probed_this_run
                            );
                        }

                        if !self.sleep_interruptible(Duration::from_millis(40)) {
                            break;
                        }
                    });
                }
            });

            if auth_tripped.load(Ordering::SeqCst) {
                self.handle_auth_or_fatal_error("HTTP 401/403 Unauthorized");
                return;
            }
        }

        if self.pause_flag.load(Ordering::SeqCst) {
            self.finish_paused();
            return;
        }

        let summary = cache.get_liberation_census_summary().unwrap_or_default();
        let reclaimable_total = summary.reclaimable_direct + summary.reclaimable_clear_hls;
        let mut rt = self.runtime.lock().unwrap();
        rt.running = false;
        rt.pause_requested = false;
        rt.phase = "completed".to_string();
        rt.updated_at = current_unix_sec();
        if sample_per_bucket.is_some() {
            rt.last_message = format!(
                "Quick Sample complete: probed {} tracks this run (total {} DRM-free reclaimable, {} subscription DRM excluded).",
                rt.probed_this_run,
                reclaimable_total,
                summary.subscription_drm_excluded
            );
        } else {
            rt.last_message = format!(
                "Stage 1 Census complete: {} indexed · {} DRM-free reclaimable ({} direct, {} clear HLS) · {} subscription DRM excluded.",
                summary.total_tracks,
                reclaimable_total,
                summary.reclaimable_direct,
                summary.reclaimable_clear_hls,
                summary.subscription_drm_excluded
            );
        }
    }

    fn finish_paused(&self) {
        let mut rt = self.runtime.lock().unwrap();
        rt.running = false;
        rt.pause_requested = false;
        rt.phase = "paused".to_string();
        rt.updated_at = current_unix_sec();
        rt.last_message = "Census paused — checkpoint saved in servicesCache.db (Resume anytime).".to_string();
    }

    fn probe_single_song_with_backoff(
        &self,
        dev_token: &str,
        user_token: &str,
        song_id: &str,
    ) -> Result<crate::sinks::apple_api::OwnedAssetProbeResult> {
        const BACKOFF_SECS: [u64; 3] = [2, 5, 12];
        let mut attempt = 0usize;
        loop {
            match probe_owned_library_asset_with_tokens(dev_token, user_token, song_id) {
                Ok(res) => return Ok(res),
                Err(err) => {
                    let msg = format!("{err:#}");
                    match classify_http_error(&msg) {
                        HttpErrorKind::RateLimited429 if attempt < BACKOFF_SECS.len() => {
                            let wait_secs = BACKOFF_SECS[attempt];
                            attempt += 1;
                            {
                                let mut rt = self.runtime.lock().unwrap();
                                rt.rate_limit_backoffs += 1;
                                rt.last_message = format!(
                                    "Rate limited on webPlayback probe (HTTP 429) — backing off {wait_secs}s..."
                                );
                                rt.updated_at = current_unix_sec();
                            }
                            if !self.sleep_interruptible(Duration::from_secs(wait_secs)) {
                                return Err(anyhow!("Paused during probe backoff"));
                            }
                        }
                        _ => return Err(err),
                    }
                }
            }
        }
    }

    fn ingest_library_albums(
        &self,
        dev_token: &str,
        user_token: &str,
    ) -> Result<LibraryAlbumLookup> {
        self.set_phase_msg("ingesting_albums", "Phase 1a: Indexing Cloud Library albums...");
        let mut lookup = LibraryAlbumLookup::default();
        let mut include_catalog = true;
        let mut next_url = Some("/v1/me/library/albums?include=catalog&limit=100".to_string());
        let mut seen_urls = HashSet::new();

        for page_idx in 0..500usize {
            if self.pause_flag.load(Ordering::SeqCst) {
                return Ok(lookup);
            }
            let Some(url) = next_url.take() else {
                break;
            };
            if !seen_urls.insert(url.clone()) {
                break;
            }

            let json = match self.apple_get_with_backoff(&url, dev_token, user_token) {
                Ok(j) => j,
                Err(err) if include_catalog && classify_http_error(&format!("{err:#}")) == HttpErrorKind::Other => {
                    include_catalog = false;
                    let fallback = if page_idx == 0 {
                        "/v1/me/library/albums?limit=100".to_string()
                    } else {
                        append_apple_query_params(&url.replace("include=catalog", ""), false)
                    };
                    self.apple_get_with_backoff(&fallback, dev_token, user_token)?
                }
                Err(err) => return Err(err),
            };

            let mut page_count = 0usize;
            if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
                for item in arr {
                    lookup.insert_album_json(item);
                    page_count += 1;
                }
            }

            {
                let mut rt = self.runtime.lock().unwrap();
                rt.albums_indexed += page_count;
                rt.pages_fetched += 1;
                rt.updated_at = current_unix_sec();
                rt.last_message = format!(
                    "Phase 1a: Indexed {} Cloud Library albums (page {})...",
                    rt.albums_indexed,
                    page_idx + 1
                );
            }

            next_url = json
                .get("next")
                .and_then(|v| v.as_str())
                .map(|n| append_apple_query_params(n, include_catalog));
        }

        Ok(lookup)
    }

    fn ingest_library_songs(
        &self,
        dev_token: &str,
        user_token: &str,
        cache: &ServicesCacheDatabase,
        album_lookup: &LibraryAlbumLookup,
    ) -> Result<()> {
        self.set_phase_msg("ingesting_songs", "Phase 1b: Indexing Cloud Library songs...");
        let mut include_catalog = true;
        let mut next_url = Some("/v1/me/library/songs?include=catalog&limit=100".to_string());
        let mut seen_urls = HashSet::new();
        let mut page_idx = 0usize;

        while let Some(url) = next_url.take() {
            if self.pause_flag.load(Ordering::SeqCst) {
                return Ok(());
            }
            if !seen_urls.insert(url.clone()) {
                break;
            }

            let json = match self.apple_get_with_backoff(&url, dev_token, user_token) {
                Ok(j) => j,
                Err(err) if include_catalog && classify_http_error(&format!("{err:#}")) == HttpErrorKind::Other => {
                    include_catalog = false;
                    let fallback = if page_idx == 0 {
                        "/v1/me/library/songs?limit=100".to_string()
                    } else {
                        append_apple_query_params(&url.replace("include=catalog", ""), false)
                    };
                    self.apple_get_with_backoff(&fallback, dev_token, user_token)?
                }
                Err(err) => return Err(err),
            };

            let mut batch = Vec::new();
            let now = current_unix_sec();
            if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
                for item in arr {
                    if let Some(rec) = parse_library_song_to_liberation_record(item, album_lookup, now)
                    {
                        batch.push(rec);
                    }
                }
            }

            let batch_len = batch.len();
            if batch_len > 0 {
                cache.upsert_liberation_tracks_batch(&batch)?;
            }

            page_idx += 1;
            {
                let mut rt = self.runtime.lock().unwrap();
                rt.songs_indexed += batch_len;
                rt.pages_fetched += 1;
                rt.updated_at = current_unix_sec();
                rt.last_message = format!(
                    "Phase 1b: Indexed {} Cloud Library songs (page {})...",
                    rt.songs_indexed, page_idx
                );
            }

            next_url = json
                .get("next")
                .and_then(|v| v.as_str())
                .map(|n| append_apple_query_params(n, include_catalog));
            if page_idx >= 2_500 {
                break;
            }
        }

        Ok(())
    }
}

#[derive(Debug, Clone)]
struct AlbumLookupEntry {
    library_album_id: String,
    album_artist: String,
    expected_track_count: Option<u32>,
}

#[derive(Default)]
struct LibraryAlbumLookup {
    by_lib_id: HashMap<String, AlbumLookupEntry>,
    by_artist_album: HashMap<(String, String), AlbumLookupEntry>,
}

impl LibraryAlbumLookup {
    fn insert_album_json(&mut self, item: &Value) {
        let Some(id) = item.get("id").and_then(|v| v.as_str()).map(str::trim) else {
            return;
        };
        if id.is_empty() {
            return;
        }
        let attrs = item.get("attributes").unwrap_or(item);
        let name = attrs.get("name").and_then(|v| v.as_str()).unwrap_or("").trim();
        let artist = attrs
            .get("artistName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim();
        let lib_count = attrs
            .get("trackCount")
            .and_then(|v| v.as_u64())
            .and_then(|n| if n > 0 { Some(n as u32) } else { None });
        let cat_count = item
            .pointer("/relationships/catalog/data/0/attributes/trackCount")
            .and_then(|v| v.as_u64())
            .and_then(|n| if n > 0 { Some(n as u32) } else { None });
        let expected_track_count = match (cat_count, lib_count) {
            (Some(c), Some(l)) => Some(c.max(l)),
            (Some(c), None) => Some(c),
            (None, Some(l)) => Some(l),
            (None, None) => None,
        };

        let entry = AlbumLookupEntry {
            library_album_id: id.to_string(),
            album_artist: artist.to_string(),
            expected_track_count,
        };
        self.by_lib_id.insert(id.to_string(), entry.clone());
        if !artist.is_empty() && !name.is_empty() {
            let key = (normalize_text_key(artist), normalize_text_key(name));
            self.by_artist_album
                .entry(key)
                .and_modify(|existing| {
                    let prev_max = existing.expected_track_count.unwrap_or(0);
                    let next_max = entry.expected_track_count.unwrap_or(0);
                    if next_max > prev_max {
                        *existing = entry.clone();
                    }
                })
                .or_insert(entry);
        }
    }
}

fn json_id_as_string(v: &Value) -> Option<String> {
    v.as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| v.as_u64().map(|n| n.to_string()))
        .or_else(|| v.as_i64().map(|n| n.to_string()))
}

fn parse_library_song_to_liberation_record(
    item: &Value,
    album_lookup: &LibraryAlbumLookup,
    updated_at: i64,
) -> Option<LiberationTrackRecord> {
    let library_song_id = item
        .get("id")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let attrs = item.get("attributes").unwrap_or(item);
    let play_params = attrs.get("playParams");
    let cat_node = item.pointer("/relationships/catalog/data/0");
    let cat_attrs = cat_node.and_then(|n| n.get("attributes"));

    let catalog_id = cat_node
        .and_then(|n| n.get("id"))
        .and_then(json_id_as_string)
        .or_else(|| {
            play_params
                .and_then(|p| p.get("catalogId"))
                .and_then(json_id_as_string)
        });
    let purchased_id = play_params
        .and_then(|p| p.get("purchasedId"))
        .and_then(json_id_as_string);
    let isrc = cat_attrs
        .and_then(|a| a.get("isrc"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let title = attrs
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown Track")
        .trim()
        .to_string();
    let artist = attrs
        .get("artistName")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown Artist")
        .trim()
        .to_string();
    let album = attrs
        .get("albumName")
        .and_then(|v| v.as_str())
        .unwrap_or("Unknown Album")
        .trim()
        .to_string();

    let rel_album_id = item
        .pointer("/relationships/albums/data/0/id")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let matched_album = rel_album_id
        .as_deref()
        .and_then(|id| album_lookup.by_lib_id.get(id))
        .or_else(|| {
            album_lookup
                .by_artist_album
                .get(&(normalize_text_key(&artist), normalize_text_key(&album)))
        });

    let library_album_id = rel_album_id.or_else(|| matched_album.map(|m| m.library_album_id.clone()));
    let album_artist = matched_album
        .map(|m| m.album_artist.clone())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| artist.clone());
    let album_track_count = matched_album
        .and_then(|m| m.expected_track_count)
        .or_else(|| {
            cat_attrs
                .and_then(|a| a.get("trackCount"))
                .and_then(|v| v.as_u64())
                .and_then(|n| if n > 0 { Some(n as u32) } else { None })
        });

    let track_number = attrs
        .get("trackNumber")
        .and_then(|v| v.as_u64())
        .and_then(|n| if n > 0 { Some(n as u32) } else { None });
    let disc_number = attrs
        .get("discNumber")
        .and_then(|v| v.as_u64())
        .and_then(|n| if n > 0 { Some(n as u32) } else { None });
    let duration_ms = attrs
        .get("durationInMillis")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let year = attrs
        .get("releaseDate")
        .or_else(|| cat_attrs.and_then(|a| a.get("releaseDate")))
        .and_then(|v| v.as_str())
        .and_then(|s| s.get(..4))
        .and_then(|y| y.parse::<u32>().ok());
    let genre = attrs
        .pointer("/genreNames/0")
        .or_else(|| cat_attrs.and_then(|a| a.pointer("/genreNames/0")))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();

    let lib_art = attrs.pointer("/artwork/url").and_then(|v| v.as_str());
    let cat_art = cat_attrs
        .and_then(|a| a.pointer("/artwork/url"))
        .and_then(|v| v.as_str());
    let raw_art = match (lib_art, cat_art) {
        (Some(a), Some(c)) if a.contains("blobstore.apple.com") => Some(c),
        (Some(a), _) => Some(a),
        (None, Some(c)) => Some(c),
        (None, None) => None,
    };
    let artwork_url = format_apple_art_url(raw_art, 300);

    let cloud_origin_hint = if purchased_id.is_some() {
        "purchased".to_string()
    } else if catalog_id.is_none() {
        "uploaded".to_string()
    } else {
        "matched_or_subscription".to_string()
    };

    Some(LiberationTrackRecord {
        library_song_id,
        catalog_id,
        purchased_id,
        isrc,
        title,
        artist,
        album_artist,
        album,
        library_album_id,
        track_number,
        disc_number,
        album_track_count,
        duration_ms,
        year,
        genre,
        artwork_url,
        cloud_origin_hint,
        ownership_class: "pending".to_string(),
        asset_flavor: None,
        asset_url_kind: None,
        observed_flavors_json: "[]".to_string(),
        content_length_bytes: None,
        probe_status: "pending".to_string(),
        verification_status: "not_downloaded".to_string(),
        blake3_hash: None,
        last_error: None,
        updated_at,
        local_path: None,
        downloaded_bytes: None,
    })
}

fn normalize_text_key(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

pub fn normalize_album_family_name(raw: &str) -> String {
    let mut s = raw.trim().to_ascii_lowercase();
    for suffix in [" - single", " - ep", " [single]", " (single)"] {
        if let Some(stripped) = s.strip_suffix(suffix) {
            s = stripped.trim().to_string();
        }
    }
    for marker in [
        "(deluxe",
        "[deluxe",
        "(remaster",
        "[remaster",
        "(explicit",
        "[explicit",
        "(clean",
        "[clean",
        "(expanded",
        "(anniversary",
        "(special edition",
        "(bonus track",
    ] {
        if let Some(idx) = s.find(marker) {
            s = s[..idx].trim().to_string();
        }
    }
    s.trim_matches(|c: char| !c.is_alphanumeric() && c != ' ')
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_single_or_stray_container(album: &str, album_track_count: Option<u32>) -> bool {
    let lower = album.trim().to_ascii_lowercase();
    if lower.ends_with(" - single")
        || lower.ends_with(" - ep")
        || lower.contains("(single)")
        || lower.contains("[single]")
        || lower.contains("greatest hits")
        || lower.contains("best of")
    {
        return true;
    }
    matches!(album_track_count, Some(1))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StraySingleCandidate {
    pub library_song_id: String,
    pub title: String,
    pub artist: String,
    pub current_album: String,
    pub ownership_class: String,
    pub cloud_origin_hint: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct IncompleteAlbumDiagnostic {
    pub artist: String,
    pub album: String,
    pub normalized_album: String,
    pub owned_or_library_tracks: usize,
    pub expected_track_count: u32,
    pub missing_track_numbers: Vec<u32>,
    pub reclaimable_count: usize,
    pub subscription_count: usize,
    pub pending_count: usize,
    pub stray_candidates: Vec<StraySingleCandidate>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct LiberationDiagnosticsReport {
    pub total_albums_analyzed: usize,
    pub incomplete_album_count: usize,
    pub total_missing_slots: usize,
    pub stray_single_candidate_count: usize,
    pub incomplete_albums: Vec<IncompleteAlbumDiagnostic>,
}

/// Read-only album fragmentation detector: identifies incomplete albums in `liberation_tracks`
/// (e.g., 12 of 14 tracks or internal track gaps) and flags same-artist `- Single` / compilation
/// strays that likely belong to an album family.
pub fn compute_album_fragmentation_diagnostics(
    tracks: &[LiberationTrackRecord],
) -> LiberationDiagnosticsReport {
    let mut album_groups: HashMap<(String, String), Vec<&LiberationTrackRecord>> = HashMap::new();
    let mut stray_by_artist: HashMap<String, Vec<&LiberationTrackRecord>> = HashMap::new();

    for t in tracks {
        let artist_raw = if !t.album_artist.trim().is_empty() {
            t.album_artist.as_str()
        } else {
            t.artist.as_str()
        };
        let norm_artist = normalize_text_key(artist_raw);
        let norm_album = normalize_album_family_name(&t.album);
        if norm_artist.is_empty() || norm_album.is_empty() || norm_album == "apple music" {
            continue;
        }
        if is_single_or_stray_container(&t.album, t.album_track_count) {
            stray_by_artist.entry(norm_artist).or_default().push(t);
        } else {
            album_groups
                .entry((norm_artist, norm_album))
                .or_default()
                .push(t);
        }
    }

    let total_albums_analyzed = album_groups.len();
    let mut incomplete_albums = Vec::new();
    let mut total_missing_slots = 0usize;
    let mut unique_stray_ids = HashSet::new();

    for ((norm_artist, norm_album), group) in album_groups {
        let max_track_num = group
            .iter()
            .filter(|t| t.disc_number.unwrap_or(1) <= 1)
            .filter_map(|t| t.track_number)
            .max()
            .unwrap_or(0);
        let max_disc = group
            .iter()
            .filter_map(|t| t.disc_number)
            .max()
            .unwrap_or(1);
        let expected_from_meta = group.iter().filter_map(|t| t.album_track_count).max();
        let expected_track_count = expected_from_meta.unwrap_or(max_track_num).max(max_track_num);

        if expected_track_count < 2 {
            continue;
        }

        let present_slots: BTreeSet<(u32, u32)> = group
            .iter()
            .filter_map(|t| t.track_number.map(|n| (t.disc_number.unwrap_or(1), n)))
            .collect();
        let present_count = if present_slots.is_empty() {
            group.len()
        } else {
            present_slots.len().max(group.len())
        };

        let mut missing_track_numbers = Vec::new();
        let disc1_nums: BTreeSet<u32> = group
            .iter()
            .filter(|t| t.disc_number.unwrap_or(1) <= 1)
            .filter_map(|t| t.track_number)
            .collect();
        if !disc1_nums.is_empty() {
            let scan_upper = if max_disc <= 1 {
                expected_track_count
            } else {
                max_track_num
            };
            for slot in 1..=scan_upper {
                if !disc1_nums.contains(&slot) {
                    missing_track_numbers.push(slot);
                }
            }
        }

        let is_incomplete = present_count < (expected_track_count as usize)
            || !missing_track_numbers.is_empty();
        if !is_incomplete {
            continue;
        }

        let missing_slots = missing_track_numbers
            .len()
            .max((expected_track_count as usize).saturating_sub(present_count));

        let display_artist = group[0].album_artist.clone();
        let display_album = group[0].album.clone();
        let mut reclaimable_count = 0usize;
        let mut subscription_count = 0usize;
        let mut pending_count = 0usize;
        for t in &group {
            match t.ownership_class.as_str() {
                "reclaimable_direct" | "reclaimable_clear_hls" => reclaimable_count += 1,
                "subscription_drm_excluded" => subscription_count += 1,
                "pending" => pending_count += 1,
                _ => {}
            }
        }

        let mut stray_candidates = Vec::new();
        if let Some(artist_strays) = stray_by_artist.get(&norm_artist) {
            let mut seen_stray = HashSet::new();
            for s in artist_strays {
                if !seen_stray.insert(s.library_song_id.clone()) {
                    continue;
                }
                let stray_norm_album = normalize_album_family_name(&s.album);
                let title_lower = s.title.to_ascii_lowercase();
                let album_family_match = !stray_norm_album.is_empty()
                    && (stray_norm_album == norm_album
                        || norm_album.contains(&stray_norm_album)
                        || title_lower.contains(&norm_album));
                let reason = if album_family_match {
                    format!(
                        "Normalized release title matches incomplete album '{display_album}'"
                    )
                } else {
                    format!(
                        "Single/compilation track by {display_artist} while '{display_album}' is missing {missing_slots} slot(s)"
                    )
                };
                stray_candidates.push(StraySingleCandidate {
                    library_song_id: s.library_song_id.clone(),
                    title: s.title.clone(),
                    artist: s.artist.clone(),
                    current_album: s.album.clone(),
                    ownership_class: s.ownership_class.clone(),
                    cloud_origin_hint: s.cloud_origin_hint.clone(),
                    reason,
                });
            }
        }

        // Skip casual 1-track saves from multi-track albums/box sets unless matching stray singles exist
        if group.len() == 1 && expected_track_count >= 5 && stray_candidates.is_empty() {
            continue;
        }

        for s in &stray_candidates {
            unique_stray_ids.insert(s.library_song_id.clone());
        }
        total_missing_slots += missing_slots;

        incomplete_albums.push(IncompleteAlbumDiagnostic {
            artist: display_artist,
            album: display_album,
            normalized_album: norm_album,
            owned_or_library_tracks: group.len(),
            expected_track_count,
            missing_track_numbers,
            reclaimable_count,
            subscription_count,
            pending_count,
            stray_candidates,
        });
    }

    incomplete_albums.sort_by(|a, b| {
        let a_miss = a.missing_track_numbers.len().max(
            (a.expected_track_count as usize).saturating_sub(a.owned_or_library_tracks),
        );
        let b_miss = b.missing_track_numbers.len().max(
            (b.expected_track_count as usize).saturating_sub(b.owned_or_library_tracks),
        );
        let a_truly_missing = a.owned_or_library_tracks < (a.expected_track_count as usize);
        let b_truly_missing = b.owned_or_library_tracks < (b.expected_track_count as usize);
        let a_ratio = ((a.owned_or_library_tracks.min(a.expected_track_count as usize)) * 1000)
            / (a.expected_track_count.max(1) as usize);
        let b_ratio = ((b.owned_or_library_tracks.min(b.expected_track_count as usize)) * 1000)
            / (b.expected_track_count.max(1) as usize);

        a.stray_candidates
            .is_empty()
            .cmp(&b.stray_candidates.is_empty())
            .then_with(|| b_truly_missing.cmp(&a_truly_missing))
            .then_with(|| b_ratio.cmp(&a_ratio))
            .then_with(|| a_miss.cmp(&b_miss))
            .then_with(|| a.artist.cmp(&b.artist))
            .then_with(|| a.album.cmp(&b.album))
    });
    let incomplete_album_count = incomplete_albums.len();
    incomplete_albums.truncate(250);

    LiberationDiagnosticsReport {
        total_albums_analyzed,
        incomplete_album_count,
        total_missing_slots,
        stray_single_candidate_count: unique_stray_ids.len(),
        incomplete_albums,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_track(
        id: &str,
        title: &str,
        album: &str,
        track_num: Option<u32>,
        expected_total: Option<u32>,
        ownership: &str,
    ) -> LiberationTrackRecord {
        LiberationTrackRecord {
            library_song_id: id.to_string(),
            catalog_id: Some("900001".to_string()),
            purchased_id: None,
            isrc: None,
            title: title.to_string(),
            artist: "Sample Artist".to_string(),
            album_artist: "Sample Artist".to_string(),
            album: album.to_string(),
            library_album_id: Some("l.alb1".to_string()),
            track_number: track_num,
            disc_number: Some(1),
            album_track_count: expected_total,
            duration_ms: 180_000,
            year: Some(2020),
            genre: "Electronic".to_string(),
            artwork_url: None,
            cloud_origin_hint: "matched".to_string(),
            ownership_class: ownership.to_string(),
            asset_flavor: None,
            asset_url_kind: None,
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
    fn test_append_apple_query_params_preserves_include_and_limit() {
        assert_eq!(
            append_apple_query_params("/v1/me/library/songs?offset=100", true),
            "/v1/me/library/songs?offset=100&include=catalog&limit=100"
        );
        assert_eq!(
            append_apple_query_params("/v1/me/library/songs?offset=200&include=catalog&limit=50", true),
            "/v1/me/library/songs?offset=200&include=catalog&limit=50"
        );
        assert_eq!(
            append_apple_query_params("/v1/me/library/albums", false),
            "/v1/me/library/albums?limit=100"
        );
    }

    #[test]
    fn test_classify_http_error() {
        assert_eq!(
            classify_http_error("HTTP 429 for https://api.music.apple.com/..."),
            HttpErrorKind::RateLimited429
        );
        assert_eq!(
            classify_http_error("Apple Music API GET failed: HTTP 401"),
            HttpErrorKind::AuthExpired401Or403
        );
        assert_eq!(
            classify_http_error("HTTP 403 Forbidden"),
            HttpErrorKind::AuthExpired401Or403
        );
        assert_eq!(
            classify_http_error("HTTP 500 Internal Server Error"),
            HttpErrorKind::Other
        );
    }

    #[test]
    fn test_normalize_album_family_name() {
        assert_eq!(
            normalize_album_family_name("Sample Album (Deluxe Edition)"),
            "sample album"
        );
        assert_eq!(
            normalize_album_family_name("Track 13 - Single"),
            "track 13"
        );
        assert_eq!(
            normalize_album_family_name("Sample Album [Remastered]"),
            "sample album"
        );
    }

    #[test]
    fn test_compute_album_fragmentation_diagnostics_detects_missing_tracks_and_stray_singles() {
        let mut tracks = Vec::new();
        for n in 1..=12u32 {
            tracks.push(mk_track(
                &format!("i.t{n}"),
                &format!("Track {n:02}"),
                "Sample Album",
                Some(n),
                Some(14),
                "reclaimable_direct",
            ));
        }
        tracks.push(mk_track(
            "i.stray13",
            "Track 13",
            "Track 13 - Single",
            Some(1),
            Some(1),
            "reclaimable_direct",
        ));
        tracks.push(mk_track(
            "i.stray14",
            "Track 14",
            "Sample Album - Single",
            Some(1),
            Some(1),
            "subscription_drm_excluded",
        ));

        // Add another incomplete album with no stray candidates (diff artist) and a 1/200 casual stub
        for n in 1..=10u32 {
            let mut t = mk_track(
                &format!("i.other{n}"),
                &format!("Track {n:02}"),
                "Other Partial Album",
                Some(n),
                Some(14),
                "reclaimable_direct",
            );
            t.artist = "Second Artist".to_string();
            t.album_artist = "Second Artist".to_string();
            tracks.push(t);
        }
        let mut casual_stub = mk_track(
            "i.stub200",
            "Stub Track",
            "Massive Box Set",
            Some(42),
            Some(200),
            "subscription_drm_excluded",
        );
        casual_stub.artist = "Third Artist".to_string();
        casual_stub.album_artist = "Third Artist".to_string();
        tracks.push(casual_stub);

        let report = compute_album_fragmentation_diagnostics(&tracks);
        assert_eq!(report.total_albums_analyzed, 3);
        // Casual 1/200 stub without strays is suppressed from incomplete_albums
        assert_eq!(report.incomplete_album_count, 2);
        assert_eq!(report.total_missing_slots, 6);
        assert_eq!(report.stray_single_candidate_count, 2);

        // Stray-candidate album MUST sort first ahead of no-stray partial album
        let diag = &report.incomplete_albums[0];
        assert_eq!(diag.album, "Sample Album");
        assert_eq!(diag.owned_or_library_tracks, 12);
        assert_eq!(diag.expected_track_count, 14);
        assert_eq!(diag.missing_track_numbers, vec![13, 14]);
        assert_eq!(diag.reclaimable_count, 12);
        assert_eq!(diag.stray_candidates.len(), 2);
        assert_eq!(report.incomplete_albums[1].album, "Other Partial Album");
    }
}
