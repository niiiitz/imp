use super::*;
use anyhow::{anyhow, Result};
use serde_json::Value;
use imp_protocol::{SimpSettings, TrackMetadata};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};

static SHARED_APPLE_DB: std::sync::OnceLock<
    std::sync::Mutex<Option<crate::library::db::LibraryDatabase>>,
> = std::sync::OnceLock::new();

fn shared_db_slot() -> &'static std::sync::Mutex<Option<crate::library::db::LibraryDatabase>> {
    SHARED_APPLE_DB.get_or_init(|| std::sync::Mutex::new(None))
}

/// Registers the daemon's main `LibraryDatabase` handle so `apple_api` shares the exact same
/// `Arc<Mutex<Connection>>` without opening a second SQLite connection or risking `SQLITE_BUSY`.
pub fn set_shared_library_db(db: crate::library::db::LibraryDatabase) {
    if let Ok(mut guard) = shared_db_slot().lock() {
        *guard = Some(db.clone());
    }
    if let Ok(persisted) = db.get_all_apple_catalog_mappings() {
        if let Ok(mut cache) = catalog_id_cache().lock() {
            for (k, v) in persisted {
                cache.entry(k).or_insert(v);
            }
        }
    }
}

pub(crate) fn shared_library_db() -> Option<crate::library::db::LibraryDatabase> {
    if let Ok(mut guard) = shared_db_slot().lock() {
        if let Some(ref db) = *guard {
            return Some(db.clone());
        }
        let data_dir = dirs::data_local_dir()?;
        let db_path = data_dir.join("simp").join("library.db");
        if let Ok(opened) = crate::library::db::LibraryDatabase::open(&db_path) {
            *guard = Some(opened.clone());
            return Some(opened);
        }
    }
    None
}

static TRACK_META_HINTS: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, (String, String, Option<String>)>>,
> = std::sync::OnceLock::new();

fn track_meta_hints(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, (String, String, Option<String>)>>
{
    TRACK_META_HINTS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

pub fn remember_raw_id_metadata_hint(
    raw_id_or_uri: &str,
    title: &str,
    artist: &str,
    art_url: Option<String>,
) {
    let clean_id = raw_id_or_uri
        .strip_prefix("applemusic:song:")
        .or_else(|| raw_id_or_uri.strip_prefix("applemusic:track:"))
        .or_else(|| raw_id_or_uri.strip_prefix("applemusic:"))
        .unwrap_or(raw_id_or_uri)
        .trim();
    if clean_id.is_empty() || title.trim().is_empty() || title == "Unknown Track" {
        return;
    }
    if let Ok(mut guard) = track_meta_hints().lock() {
        let valid_art = art_url.filter(|u| !u.is_empty() && !u.contains("blobstore.apple.com"));
        let prev_art = guard.get(clean_id).and_then(|(_, _, a)| a.clone());
        guard.insert(
            clean_id.to_string(),
            (
                title.trim().to_string(),
                artist.trim().to_string(),
                valid_art.or(prev_art),
            ),
        );
    }
}

pub fn remember_track_metadata_hint(track: &TrackMetadata) {
    if !track.uri.starts_with("applemusic:") {
        return;
    }
    let artist = track.artists.first().map(|s| s.as_str()).unwrap_or("");
    remember_raw_id_metadata_hint(&track.uri, &track.title, artist, track.art_url.clone());
}

static RESOLVED_CATALOG_ID_CACHE: std::sync::OnceLock<
    std::sync::Mutex<std::collections::HashMap<String, (String, Option<String>)>>,
> = std::sync::OnceLock::new();

fn catalog_id_cache(
) -> &'static std::sync::Mutex<std::collections::HashMap<String, (String, Option<String>)>> {
    RESOLVED_CATALOG_ID_CACHE.get_or_init(|| {
        let mut initial = std::collections::HashMap::new();
        if let Some(db) = shared_library_db() {
            if let Ok(persisted) = db.get_all_apple_catalog_mappings() {
                initial = persisted;
            }
        }
        std::sync::Mutex::new(initial)
    })
}

fn save_resolved_catalog_mapping(clean_id: &str, catalog_id: &str, art_url: Option<String>) {
    if let Ok(mut guard) = catalog_id_cache().lock() {
        let existing_art = guard.get(clean_id).and_then(|(_, a)| a.clone());
        guard.insert(
            clean_id.to_string(),
            (catalog_id.to_string(), art_url.clone().or(existing_art)),
        );
    }
    if let Some(db) = shared_library_db() {
        let _ = db.upsert_apple_catalog_mapping(clean_id, catalog_id, art_url.as_deref());
    }
}

/// Evicts any cached catalog mapping and artwork hint for `song_uri_or_id`.
pub fn evict_cached_track_art(song_uri_or_id: &str) {
    let clean_id = song_uri_or_id
        .strip_prefix("applemusic:song:")
        .or_else(|| song_uri_or_id.strip_prefix("applemusic:track:"))
        .or_else(|| song_uri_or_id.strip_prefix("applemusic:"))
        .unwrap_or(song_uri_or_id)
        .trim();
    if clean_id.is_empty() {
        return;
    }
    if let Ok(mut guard) = catalog_id_cache().lock() {
        guard.remove(clean_id);
    }
    if let Ok(mut guard) = track_meta_hints().lock() {
        if let Some(entry) = guard.get_mut(clean_id) {
            entry.2 = None;
        }
    }
}

/// Returns a healed permanent `mzstatic.com` catalog artwork URL for `song_uri_or_id` if known.
pub fn get_healed_track_art_url(song_uri_or_id: &str) -> Option<String> {
    let clean_id = song_uri_or_id
        .strip_prefix("applemusic:song:")
        .or_else(|| song_uri_or_id.strip_prefix("applemusic:track:"))
        .or_else(|| song_uri_or_id.strip_prefix("applemusic:"))
        .unwrap_or(song_uri_or_id)
        .trim();
    if let Ok(guard) = catalog_id_cache().lock() {
        if let Some((_, Some(art))) = guard.get(clean_id) {
            return Some(art.clone());
        }
        if clean_id.starts_with("i.") {
            return None;
        }
    }
    if clean_id.starts_with("i.") {
        return None;
    }
    if let Ok(guard) = track_meta_hints().lock() {
        if let Some((_, _, Some(art))) = guard.get(clean_id) {
            if art.contains("mzstatic.com") {
                return Some(art.clone());
            }
        }
    }
    if let Some(db) = shared_library_db() {
        for prefix in ["applemusic:song:", "applemusic:track:"] {
            let lookup_uri = format!("{prefix}{clean_id}");
            if let Ok(Some(meta)) = db.get_track_by_uri(&lookup_uri) {
                if let Some(art) = meta.art_url.filter(|u| u.contains("mzstatic.com")) {
                    return Some(art);
                }
            }
        }
    }
    None
}

fn lookup_track_title_artist_in_db(clean_id: &str) -> (Option<String>, Option<String>) {
    if let Ok(guard) = track_meta_hints().lock() {
        if let Some((t, a, _)) = guard.get(clean_id) {
            if !t.is_empty() && t != "Unknown Track" {
                let a_opt = if a.is_empty() || a == "Unknown Artist" {
                    None
                } else {
                    Some(a.clone())
                };
                return (Some(t.clone()), a_opt);
            }
        }
    }
    if let Some(db) = shared_library_db() {
        for prefix in ["applemusic:song:", "applemusic:track:"] {
            let lookup_uri = format!("{prefix}{clean_id}");
            if let Ok(Some(meta)) = db.get_track_by_uri(&lookup_uri) {
                if !meta.title.is_empty() && meta.title != "Unknown Track" {
                    return (Some(meta.title), meta.artists.first().cloned());
                }
            }
        }
    }
    (None, None)
}

/// Resolves an Apple Music Radio Station (`applemusic:station:ra.xxxx`) into a batch of playable
/// catalog songs (`TrackMetadata`) in native Rust so radio stations stream 100% natively through
/// SIMP's Zero-Browser Widevine CDM + PipeWire engine on SteamOS, Steam Frame, and Linux.
pub fn fetch_radio_station_tracks(
    settings: &SimpSettings,
    station_uri_or_id: &str,
    station_title_hint: Option<&str>,
    limit: usize,
) -> Result<Vec<TrackMetadata>> {
    let (dev_token, user_token) = resolve_tokens(settings)?;
    let station_id = station_uri_or_id
        .strip_prefix("applemusic:station:")
        .or_else(|| station_uri_or_id.strip_prefix("applemusic:"))
        .unwrap_or(station_uri_or_id)
        .trim();
    if station_id.is_empty() {
        return Err(anyhow!("Empty Apple Music radio station ID"));
    }

    let safe_limit = limit.clamp(5, 25);
    for base_host in [
        "https://amp-api.music.apple.com",
        "https://api.music.apple.com",
    ] {
        let next_tracks_url = format!(
            "{base_host}/v1/me/stations/next-tracks/{}?limit={}",
            urlencode(station_id),
            safe_limit
        );
        if let Ok(json) = apple_post_json(
            &next_tracks_url,
            &dev_token,
            &user_token,
            &serde_json::json!({}),
        ) {
            if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
                let tracks: Vec<TrackMetadata> =
                    arr.iter().filter_map(map_apple_item_to_track).collect();
                if !tracks.is_empty() {
                    return Ok(tracks);
                }
            }
        }
    }

    let storefront = get_storefront(&dev_token, &user_token);
    let raw_hint = station_title_hint
        .unwrap_or("")
        .trim_start_matches('📻')
        .trim();
    let lower_hint = raw_hint.to_lowercase();

    // Check if this is a Personal User Station (e.g. `ra.u-...`, `"[My Name]'s Station"`, `"Discovery Station"`).
    // Never search the public catalog for the user's literal name! Instead, synthesize a personalized
    // station queue from their personal mixes (`Favorites Mix`, `Get Up! Mix`, `New Music Mix`, `Chill Mix`),
    // recently played tracks, and personal Cloud Library songs.
    let is_personal_station = station_id.contains("u-")
        || lower_hint.contains("'s station")
        || lower_hint.contains("’s station")
        || lower_hint.contains("discovery station")
        || lower_hint.contains("personal station")
        || lower_hint.contains("my station");

    if is_personal_station {
        let mut personal_pool: Vec<TrackMetadata> = Vec::new();
        let mut seen_uris = HashSet::new();

        // 1. Pull tracks from the user's "Made For You" personal mix playlists (`Favorites Mix`, `Get Up! Mix`, etc.)
        if let Ok(rec_json) =
            apple_get_json("/v1/me/recommendations?limit=8", &dev_token, &user_token)
        {
            if let Some(arr) = rec_json.get("data").and_then(|v| v.as_array()) {
                let mut mix_playlist_ids = Vec::new();
                for rec in arr {
                    if let Some(contents) = rec
                        .pointer("/relationships/contents/data")
                        .and_then(|v| v.as_array())
                    {
                        for item in contents {
                            let item_type =
                                item.get("type").and_then(|v| v.as_str()).unwrap_or("");
                            if item_type == "playlists" || item_type == "library-playlists" {
                                if let Some(pid) = item.get("id").and_then(|v| v.as_str()) {
                                    mix_playlist_ids.push(pid.to_string());
                                }
                            }
                        }
                    }
                }
                for pid in mix_playlist_ids.into_iter().take(2) {
                    if let Ok(pl_tracks) = fetch_playlist_tracks(settings, &pid, Some("catalog")) {
                        for tr in pl_tracks.into_iter().take(20) {
                            if seen_uris.insert(tr.uri.clone()) {
                                personal_pool.push(tr);
                            }
                        }
                    }
                }
            }
        }

        // 2. Pull the user's Recently Played Apple Music tracks
        if let Ok(recent_json) = apple_get_json(
            "/v1/me/recent/played/tracks?limit=25",
            &dev_token,
            &user_token,
        ) {
            if let Some(arr) = recent_json.get("data").and_then(|v| v.as_array()) {
                for item in arr {
                    if let Some(tr) = map_apple_item_to_track(item) {
                        if seen_uris.insert(tr.uri.clone()) {
                            personal_pool.push(tr);
                        }
                    }
                }
            }
        }

        // 3. Pull songs from the user's personal Apple Music Cloud Library
        if let Ok(lib_json) = apple_get_json(
            "/v1/me/library/songs?include=catalog&limit=35",
            &dev_token,
            &user_token,
        ) {
            if let Some(arr) = lib_json.get("data").and_then(|v| v.as_array()) {
                for item in arr {
                    if let Some(tr) = map_apple_item_to_track(item) {
                        if seen_uris.insert(tr.uri.clone()) {
                            personal_pool.push(tr);
                        }
                    }
                }
            }
        }

        if !personal_pool.is_empty() {
            // Deterministic pseudo-random rotation seeded from wall-clock time so each tune-in feels fresh
            let seed = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as usize)
                .unwrap_or(7);
            let len = personal_pool.len();
            let mut rotated = Vec::with_capacity(len.min(safe_limit));
            let step = if len > 3 { (seed % (len - 1)).max(1) } else { 1 };
            for i in 0..len {
                let idx = (seed + i * step) % len;
                let candidate = &personal_pool[idx];
                if !rotated.iter().any(|t: &TrackMetadata| t.uri == candidate.uri) {
                    rotated.push(candidate.clone());
                    if rotated.len() >= safe_limit {
                        break;
                    }
                }
            }
            for tr in personal_pool {
                if rotated.len() >= safe_limit {
                    break;
                }
                if !rotated.iter().any(|t| t.uri == tr.uri) {
                    rotated.push(tr);
                }
            }
            if !rotated.is_empty() {
                return Ok(rotated);
            }
        }
    }

    // Fallback for global live broadcast stations (`isLive: true`, e.g. `ra.978194965` Apple Music 1,
    // Apple Music Hits, Apple Music Country, Apple Music Club, Apple Musica Uno, Apple Music Chill)
    // where `/v1/me/stations/next-tracks` returns empty `data: []`:
    // If it's "Apple Music 1" or no specific genre hint, try storefront Top Songs chart first
    if lower_hint.is_empty() || lower_hint.contains("apple music 1") || is_personal_station {
        let chart_url = format!("/v1/catalog/{storefront}/charts?types=songs&limit=25");
        if let Ok(json) = apple_get_json(&chart_url, &dev_token, &user_token) {
            if let Some(arr) = json
                .pointer("/results/songs/0/data")
                .and_then(|v| v.as_array())
            {
                let tracks: Vec<TrackMetadata> = arr
                    .iter()
                    .filter_map(map_apple_item_to_track)
                    .collect();
                if !tracks.is_empty() {
                    return Ok(tracks);
                }
            }
        }
    }

    let search_term = if lower_hint.contains("country") {
        "Country Hits"
    } else if lower_hint.contains("club") {
        "Dance Electronic Club"
    } else if lower_hint.contains("uno") || lower_hint.contains("latino") {
        "Musica Latina Hits"
    } else if lower_hint.contains("chill") {
        "Chill Ambient Lo-Fi"
    } else if lower_hint.contains("hits") {
        "Today's Hits"
    } else if !raw_hint.is_empty() && !lower_hint.starts_with("apple music") {
        raw_hint
    } else {
        "Top Hits"
    };

    let search_url = format!(
        "/v1/catalog/{}/search?term={}&types=songs&limit=25",
        storefront,
        urlencode(search_term)
    );
    if let Ok(json) = apple_get_json(&search_url, &dev_token, &user_token) {
        if let Some(arr) = json
            .pointer("/results/songs/data")
            .and_then(|v| v.as_array())
        {
            let tracks: Vec<TrackMetadata> = arr
                .iter()
                .filter_map(map_apple_item_to_track)
                .collect();
            if !tracks.is_empty() {
                return Ok(tracks);
            }
        }
    }

    Err(anyhow!(
        "Could not resolve tracks for Apple Music station {station_id}"
    ))
}

fn search_storefront_catalog_song_id(
    dev_token: &str,
    user_token: &str,
    storefront: &str,
    clean_id: &str,
    title: Option<&str>,
    artist: Option<&str>,
) -> Option<(String, Option<String>)> {
    let t = title.filter(|s| !s.trim().is_empty() && *s != "Unknown Track")?;
    let a = artist.unwrap_or("").trim();
    let term = format!("{t} {a}").trim().to_string();
    let url = format!(
        "/v1/catalog/{}/search?term={}&types=songs&limit=5",
        storefront,
        urlencode(&term)
    );
    let json = apple_get_json(&url, dev_token, user_token).ok()?;
    let candidates = json.pointer("/results/songs/data")?.as_array()?;
    let t_lower = t.trim().to_lowercase();
    let a_lower = a.trim().to_lowercase();
    let chosen = candidates.iter().find(|c| {
        let n = c
            .pointer("/attributes/name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_lowercase();
        let ar = c
            .pointer("/attributes/artistName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_lowercase();
        n == t_lower && (a_lower.is_empty() || ar.contains(&a_lower) || a_lower.contains(&ar))
    })?;

    let id = chosen.get("id")?.as_str()?;
    let art_url = format_apple_art_url(
        chosen
            .pointer("/attributes/artwork/url")
            .and_then(|v| v.as_str()),
        400,
    );
    if id != clean_id {
        Some((id.to_string(), art_url))
    } else {
        None
    }
}

/// Resolves a re-linked or tombstoned playlist track ID (`i.xxxx` library song ID or stale catalog ID)
/// to its active storefront catalog song ID in native Rust, with persistent SQLite + in-memory caching.
/// Note: For uploaded Cloud Library tracks (`i.xxxx`) that have no catalog equivalent, returns `Ok(None)`
/// so `fetch_web_playback_manifest` preserves the user's `universalLibraryId` (`i.xxxx`).
pub fn resolve_replacement_catalog_song_id(
    settings: &SimpSettings,
    raw_id: &str,
    title: Option<&str>,
    artist: Option<&str>,
) -> Result<Option<String>> {
    let clean_id = raw_id
        .strip_prefix("applemusic:song:")
        .or_else(|| raw_id.strip_prefix("applemusic:track:"))
        .or_else(|| raw_id.strip_prefix("applemusic:"))
        .unwrap_or(raw_id)
        .trim();

    if let Ok(guard) = catalog_id_cache().lock() {
        if let Some((cached_id, _)) = guard.get(clean_id) {
            return Ok(Some(cached_id.clone()));
        }
    }

    let (db_title, db_artist) = lookup_track_title_artist_in_db(clean_id);
    let caller_mismatches_db = match (&db_title, title) {
        (Some(dt), Some(ct)) if !ct.trim().is_empty() => {
            dt.trim().to_lowercase() != ct.trim().to_lowercase()
        }
        _ => false,
    };
    let (effective_title, effective_artist) = if caller_mismatches_db {
        (db_title.as_deref(), db_artist.as_deref())
    } else {
        (db_title.as_deref().or(title), db_artist.as_deref().or(artist))
    };

    let (dev_token, user_token) = resolve_tokens(settings)?;
    let storefront = get_storefront(&dev_token, &user_token);

    if clean_id.starts_with("i.") {
        if let Ok(json) = apple_get_json(
            &format!("/v1/me/library/songs/{}/catalog", urlencode(clean_id)),
            &dev_token,
            &user_token,
        ) {
            if let Some(cat_id) = json.pointer("/data/0/id").and_then(|v| v.as_str()) {
                let catalog_name = json
                    .pointer("/data/0/attributes/name")
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_lowercase());
                let title_matches = match (effective_title, catalog_name.as_deref()) {
                    (Some(et), Some(cn)) if !et.trim().is_empty() && !cn.is_empty() => {
                        let et_lower = et.trim().to_lowercase();
                        et_lower == cn || cn.contains(&et_lower) || et_lower.contains(cn)
                    }
                    _ => true,
                };
                if title_matches {
                    let resolved = cat_id.to_string();
                    let art_url = format_apple_art_url(
                        json.pointer("/data/0/attributes/artwork/url")
                            .and_then(|v| v.as_str()),
                        400,
                    );
                    save_resolved_catalog_mapping(clean_id, &resolved, art_url);
                    return Ok(Some(resolved));
                }
            }
        }
    }

    // If `title` + `artist` have an exact storefront catalog match, resolve to the active licensed `salableAdamId`.
    // Because `search_storefront_catalog_song_id` requires an exact title+artist match (no fuzzy `candidates.first()`),
    // uploaded tracks that aren't in the streaming catalog safely fall through without being overwritten!
    if let Some((resolved, art_url)) = search_storefront_catalog_song_id(
        &dev_token,
        &user_token,
        &storefront,
        clean_id,
        effective_title,
        effective_artist,
    ) {
        save_resolved_catalog_mapping(clean_id, &resolved, art_url);
        return Ok(Some(resolved));
    }

    Ok(None)
}

/// Forces a storefront catalog search by `title + artist` from `library.db` when a library song's
/// linked catalog ID fails `acquireWebPlaybackLicense` (e.g. `status: -1003` delisted pressing).
pub fn force_resolve_catalog_song_by_search(
    settings: &SimpSettings,
    song_uri_or_id: &str,
) -> Result<Option<String>> {
    let clean_id = song_uri_or_id
        .strip_prefix("applemusic:song:")
        .or_else(|| song_uri_or_id.strip_prefix("applemusic:track:"))
        .or_else(|| song_uri_or_id.strip_prefix("applemusic:"))
        .unwrap_or(song_uri_or_id)
        .trim();
    let (title_opt, artist_opt) = lookup_track_title_artist_in_db(clean_id);
    if title_opt.is_none() {
        return Ok(None);
    }
    let (dev_token, user_token) = resolve_tokens(settings)?;
    let storefront = get_storefront(&dev_token, &user_token);
    if let Some((resolved, art_url)) = search_storefront_catalog_song_id(
        &dev_token,
        &user_token,
        &storefront,
        clean_id,
        title_opt.as_deref(),
        artist_opt.as_deref(),
    ) {
        save_resolved_catalog_mapping(clean_id, &resolved, art_url);
        return Ok(Some(resolved));
    }
    Ok(None)
}

/// Pre-resolves uncached `applemusic:song:i.xxxx` library tracks in the active queue in the background
/// and persists their catalog IDs + permanent `mzstatic.com` artwork into SQLite (`apple_catalog_map`).
pub fn spawn_queue_catalog_prewarmer(settings: SimpSettings, tracks: Vec<TrackMetadata>) {
    let uncached: Vec<TrackMetadata> = tracks
        .into_iter()
        .filter(|t| {
            let clean = t
                .uri
                .strip_prefix("applemusic:song:")
                .or_else(|| t.uri.strip_prefix("applemusic:track:"))
                .unwrap_or(&t.uri)
                .trim();
            if !clean.starts_with("i.") {
                return false;
            }
            if let Ok(guard) = catalog_id_cache().lock() {
                !guard.contains_key(clean)
            } else {
                true
            }
        })
        .collect();

    if uncached.is_empty() {
        return;
    }

    let _ = std::thread::Builder::new()
        .name("simp-catalog-prewarm".to_string())
        .spawn(move || {
            // Yield 150ms so any immediate foreground request starts first before background queue resolution.
            std::thread::sleep(std::time::Duration::from_millis(150));
            for t in uncached {
                let artist = t.artists.first().map(|s| s.as_str());
                let _ = resolve_replacement_catalog_song_id(
                    &settings,
                    &t.uri,
                    Some(&t.title),
                    artist,
                );
            }
        });
}

pub(crate) fn has_playable_cloud_or_widevine_asset(json: &Value) -> bool {
    json.pointer("/songList/0/assets")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter().any(|a| {
                let has_url = a
                    .get("URL")
                    .and_then(|v| v.as_str())
                    .map(|u| !u.trim().is_empty())
                    .unwrap_or(false);
                if !has_url {
                    return false;
                }
                let flavor = a.get("flavor").and_then(|v| v.as_str()).unwrap_or("");
                flavor.contains("ctrp")
                    || flavor.contains("plus")
                    || flavor.contains("itemDownload")
                    || json.pointer("/songList/0/hls-key-server-url").is_none()
            })
        })
        .unwrap_or(false)
}

pub fn extract_clean_apple_song_id(raw: &str) -> &str {
    raw.strip_prefix("applemusic:song:")
        .or_else(|| raw.strip_prefix("applemusic:track:"))
        .or_else(|| raw.strip_prefix("applemusic:"))
        .unwrap_or(raw)
        .trim()
}

/// Detects unencrypted audio container formats (or legacy FairPlay `drm_m4p`) from the leading
/// bytes (`Range: bytes=0-511`) of an asset response. Returns `None` for HLS playlists (`#EXTM3U`)
/// or unrecognized binary payloads.
pub fn detect_audio_container_from_magic(head: &[u8]) -> Option<&'static str> {
    let trimmed_bom = head.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(head);
    if let Ok(text) = std::str::from_utf8(trimmed_bom) {
        if text
            .trim_start()
            .get(..7)
            .map(|p| p.eq_ignore_ascii_case("#EXTM3U"))
            .unwrap_or(false)
        {
            return None;
        }
    }
    if head.len() >= 12 && &head[4..8] == b"ftyp" {
        if &head[8..12] == b"M4P " {
            return Some("drm_m4p");
        }
        return Some("m4a");
    }
    if head.starts_with(b"ID3") {
        return Some("mp3");
    }
    if head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0 {
        if (head[1] & 0x06) == 0x00 {
            return Some("aac");
        }
        return Some("mp3");
    }
    if head.starts_with(b"fLaC") {
        return Some("flac");
    }
    if head.len() >= 12 && head.starts_with(b"RIFF") && &head[8..12] == b"WAVE" {
        return Some("wav");
    }
    if head.len() >= 12
        && head.starts_with(b"FORM")
        && (&head[8..12] == b"AIFF" || &head[8..12] == b"AIFC")
    {
        return Some("aiff");
    }
    if head.starts_with(b"OggS") {
        return Some("ogg");
    }
    None
}

pub(crate) fn is_direct_unencrypted_audio_asset(asset: &Value) -> bool {
    let Some(url) = asset
        .get("URL")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    else {
        return false;
    };
    let flavor_lower = asset
        .get("flavor")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if flavor_lower.contains("ctrp") || flavor_lower.contains("cbcp") {
        return false;
    }
    let (url_path, url_query) = match url.split_once('?') {
        Some((p, q)) => (p.to_ascii_lowercase(), q.to_ascii_lowercase()),
        None => (url.to_ascii_lowercase(), String::new()),
    };
    if url_path.ends_with(".m3u8") || url_path.ends_with(".m4p") {
        return false;
    }
    let ext_lower = asset
        .get("fileExtension")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    url_path.ends_with(".m4a")
        || url_path.ends_with(".mp3")
        || url_path.ends_with(".aac")
        || url_path.ends_with(".flac")
        || url_path.ends_with(".wav")
        || url_path.ends_with(".aiff")
        || url_path.ends_with(".aif")
        || url_path.ends_with(".ogg")
        || url_path.ends_with("/audio")
        || matches!(
            ext_lower.as_str(),
            "m4a" | "mp3" | "aac" | "flac" | "wav" | "aiff" | "aif" | "ogg"
        )
        || url_query.contains("response-content-disposition=")
        || url_query.contains("response-content-type=audio")
        || flavor_lower.contains("itemdownload")
}

/// Selects the optimal playback asset from a single Apple `webPlayback` `songList[0]` object,
/// prioritizing unencrypted DRM-free assets (`itemDownload`, direct `.m4a`/`.mp3`, and unkeyed `plus256`)
/// ahead of Widevine CTR (`28:ctrp256` / `ctrp`) streams.
pub fn select_web_playback_asset(
    song_obj: &Value,
    fallback_song_id: &str,
) -> Result<AppleWebPlaybackAsset> {
    let canonical_song_id = song_obj
        .get("songId")
        .and_then(|v| {
            v.as_str()
                .map(|s| s.to_string())
                .or_else(|| v.as_u64().map(|n| n.to_string()))
                .or_else(|| v.as_i64().map(|n| n.to_string()))
        })
        .unwrap_or_else(|| fallback_song_id.to_string());

    let key_server_url = song_obj
        .get("hls-key-server-url")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let key_cert_url = song_obj
        .get("hls-key-cert-url")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    let assets = song_obj
        .get("assets")
        .and_then(|v| v.as_array())
        .ok_or_else(|| anyhow!("No HLS assets in webPlayback response"))?;

    let asset_has_url = |a: &&Value| -> bool {
        a.get("URL")
            .and_then(|v| v.as_str())
            .map(|u| !u.trim().is_empty())
            .unwrap_or(false)
    };
    let flavor_lower = |a: &&Value| -> String {
        a.get("flavor")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_ascii_lowercase()
    };

    // Priority:
    // 1. Direct unencrypted audio downloads (`itemDownload` / direct `.m4a`/`.mp3`)
    // 2. Unkeyed DRM-free HLS (`plus256` / non-DRM `256` when `hls-key-server-url` is absent)
    // 3. Widevine CTR (`28:ctrp256` -> other `ctrp` -> `plus`/`itemDownload` -> `256` -> first)
    let chosen = assets
        .iter()
        .find(|a| is_direct_unencrypted_audio_asset(a))
        .or_else(|| {
            if key_server_url.is_none() {
                assets
                    .iter()
                    .find(|a| {
                        asset_has_url(a) && {
                            let f = flavor_lower(a);
                            f.contains("plus") && !f.contains("ctrp") && !f.contains("cbcp")
                        }
                    })
                    .or_else(|| {
                        assets.iter().find(|a| {
                            asset_has_url(a) && {
                                let f = flavor_lower(a);
                                f.contains("256") && !f.contains("ctrp") && !f.contains("cbcp")
                            }
                        })
                    })
            } else {
                None
            }
        })
        .or_else(|| {
            assets.iter().find(|a| {
                asset_has_url(a) && {
                    let f = flavor_lower(a);
                    f == "28:ctrp256" || f.contains("ctrp256")
                }
            })
        })
        .or_else(|| {
            assets
                .iter()
                .find(|a| asset_has_url(a) && flavor_lower(a).contains("ctrp"))
        })
        .or_else(|| {
            assets.iter().find(|a| {
                asset_has_url(a) && {
                    let f = flavor_lower(a);
                    f.contains("plus") || f.contains("itemdownload")
                }
            })
        })
        .or_else(|| {
            assets
                .iter()
                .find(|a| asset_has_url(a) && flavor_lower(a).contains("256"))
        })
        .or_else(|| assets.first())
        .ok_or_else(|| anyhow!("Empty assets list in webPlayback response"))?;

    let hls_playlist_url = chosen
        .get("URL")
        .and_then(|v| v.as_str())
        .ok_or_else(|| anyhow!("Missing URL in webPlayback asset"))?
        .to_string();
    let flavor = chosen
        .get("flavor")
        .and_then(|v| v.as_str())
        .unwrap_or("default")
        .to_string();
    let chosen_flavor_lower = flavor.to_ascii_lowercase();

    let encryption_kind = if is_direct_unencrypted_audio_asset(chosen) {
        AppleAssetEncryptionKind::ClearDirectAudio
    } else if key_server_url.is_none()
        && (chosen_flavor_lower.contains("plus")
            || (!chosen_flavor_lower.contains("ctrp") && !chosen_flavor_lower.contains("cbcp")))
    {
        AppleAssetEncryptionKind::ClearHlsFmp4
    } else {
        AppleAssetEncryptionKind::WidevineCenc
    };

    Ok(AppleWebPlaybackAsset {
        song_id: canonical_song_id,
        flavor,
        hls_playlist_url,
        key_server_url,
        key_cert_url,
        encryption_kind,
    })
}

/// Stage C Browserless Foundation: Queries Apple's `webPlayback` endpoint directly from Rust
/// to retrieve the encrypted HLS `.m3u8` asset stream URL and Widevine license server URLs
/// (or DRM-free `plus256` / `itemDownload` / clear HLS assets for uploaded & iTunes Match Cloud Locker tracks).
pub fn fetch_web_playback_manifest(
    settings: &SimpSettings,
    song_id: &str,
) -> Result<AppleWebPlaybackAsset> {
    let (dev_token, user_token) = resolve_tokens(settings)?;
    let clean_id = extract_clean_apple_song_id(song_id);

    let mut active_id = if let Ok(guard) = catalog_id_cache().lock() {
        guard
            .get(clean_id)
            .map(|(id, _)| id.clone())
            .unwrap_or_else(|| clean_id.to_string())
    } else {
        clean_id.to_string()
    };

    // Always pass `title` and `artist` from `library.db` when resolving `i.xxxx` library tracks
    // so re-linked pinned playlists resolve to their active catalog `salableAdamId`, while uploaded
    // tracks without a catalog match preserve their `universalLibraryId` (`i.xxxx`).
    let mut db_meta_cache: Option<(Option<String>, Option<String>)> = None;
    if active_id.starts_with("i.") {
        let (t_opt, a_opt) = lookup_track_title_artist_in_db(clean_id);
        db_meta_cache = Some((t_opt.clone(), a_opt.clone()));
        if let Ok(Some(cat_id)) = resolve_replacement_catalog_song_id(
            settings,
            &active_id,
            t_opt.as_deref(),
            a_opt.as_deref(),
        ) {
            active_id = cat_id;
        }
    }

    let make_payload = |id: &str| {
        if id.starts_with("i.") {
            serde_json::json!({ "universalLibraryId": id })
        } else {
            serde_json::json!({ "salableAdamId": id })
        }
    };

    let mut json = apple_post_json(
        "https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback",
        &dev_token,
        &user_token,
        &make_payload(&active_id),
    )?;

    if (json.pointer("/songList/0").is_none() || !has_playable_cloud_or_widevine_asset(&json))
        && clean_id.starts_with("i.")
        && active_id != clean_id
    {
        // Some user library songs require both `universalLibraryId` and `subscriptionAdamId`
        // (or just `universalLibraryId` directly) in the `webPlayback` request body.
        for fallback_payload in [
            serde_json::json!({
                "universalLibraryId": clean_id,
                "subscriptionAdamId": active_id,
            }),
            serde_json::json!({
                "universalLibraryId": clean_id,
            }),
        ] {
            if let Ok(candidate) = apple_post_json(
                "https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback",
                &dev_token,
                &user_token,
                &fallback_payload,
            ) {
                if candidate.pointer("/songList/0").is_some()
                    && has_playable_cloud_or_widevine_asset(&candidate)
                {
                    json = candidate;
                    break;
                }
            }
        }
    }

    if json.pointer("/songList/0").is_none() || !has_playable_cloud_or_widevine_asset(&json) {
        let (title_opt, artist_opt) =
            db_meta_cache.unwrap_or_else(|| lookup_track_title_artist_in_db(clean_id));
        let storefront = get_storefront(&dev_token, &user_token);
        if let Some((replacement_id, art_url)) = search_storefront_catalog_song_id(
            &dev_token,
            &user_token,
            &storefront,
            &active_id,
            title_opt.as_deref(),
            artist_opt.as_deref(),
        ) {
            if replacement_id != active_id {
                save_resolved_catalog_mapping(clean_id, &replacement_id, art_url);
                active_id = replacement_id;
                json = apple_post_json(
                    "https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback",
                    &dev_token,
                    &user_token,
                    &make_payload(&active_id),
                )?;
            }
        }
    }

    let song_obj = json
        .pointer("/songList/0")
        .ok_or_else(|| anyhow!("No songList entry returned by Apple webPlayback endpoint (raw response: {json})"))?;

    select_web_playback_asset(song_obj, &active_id)
}

static CLEAR_LIBRARY_MANIFEST_CACHE: std::sync::OnceLock<
    std::sync::Mutex<HashMap<String, (Instant, Option<AppleWebPlaybackAsset>)>>,
> = std::sync::OnceLock::new();

fn clear_library_manifest_cache(
) -> &'static std::sync::Mutex<HashMap<String, (Instant, Option<AppleWebPlaybackAsset>)>> {
    CLEAR_LIBRARY_MANIFEST_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

const CLEAR_LIBRARY_MANIFEST_TTL: Duration = Duration::from_secs(15 * 60);
const CLEAR_LIBRARY_MANIFEST_MAX_ENTRIES: usize = 256;

/// Queries Apple `webPlayback` strictly with `{ "universalLibraryId": "i.xxxx" }` (never substituting
/// a catalog `salableAdamId`) and returns `Some(asset)` ONLY if the returned stream is verified DRM-free
/// (`ClearDirectAudio` or an `.m3u8` `ClearHlsFmp4` verified to contain zero `EXT-X-KEY` directives).
pub fn try_fetch_clear_library_playback_manifest(
    settings: &SimpSettings,
    song_uri_or_id: &str,
) -> Result<Option<AppleWebPlaybackAsset>> {
    let clean_id = extract_clean_apple_song_id(song_uri_or_id);
    if !clean_id.starts_with("i.") {
        return Ok(None);
    }

    if let Ok(mut guard) = clear_library_manifest_cache().lock() {
        if let Some((cached_at, cached_val)) = guard.get(clean_id) {
            if cached_at.elapsed() < CLEAR_LIBRARY_MANIFEST_TTL {
                return Ok(cached_val.clone());
            }
            guard.remove(clean_id);
        }
    }

    let (dev_token, user_token) = resolve_tokens(settings)?;
    let json = apple_post_json(
        "https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback",
        &dev_token,
        &user_token,
        &serde_json::json!({ "universalLibraryId": clean_id }),
    )?;

    let resolved: Option<AppleWebPlaybackAsset> = match json.pointer("/songList/0") {
        Some(song_obj) => {
            match select_web_playback_asset(song_obj, clean_id) {
                Ok(asset) => match asset.encryption_kind {
                    AppleAssetEncryptionKind::ClearDirectAudio => Some(asset),
                    AppleAssetEncryptionKind::ClearHlsFmp4 => {
                        match crate::sinks::apple_native::hls::fetch_and_verify_clear_apple_hls(
                            &asset.hls_playlist_url,
                        )? {
                            Ok(_) => Some(asset),
                            Err(_) => None,
                        }
                    }
                    AppleAssetEncryptionKind::WidevineCenc => None,
                },
                Err(_) => None,
            }
        }
        None => None,
    };

    if let Ok(mut guard) = clear_library_manifest_cache().lock() {
        if guard.len() >= CLEAR_LIBRARY_MANIFEST_MAX_ENTRIES {
            guard.retain(|_, (ts, _)| ts.elapsed() < CLEAR_LIBRARY_MANIFEST_TTL);
            if guard.len() >= CLEAR_LIBRARY_MANIFEST_MAX_ENTRIES {
                if let Some(oldest_key) = guard
                    .iter()
                    .min_by_key(|(_, (ts, _))| *ts)
                    .map(|(k, _)| k.clone())
                {
                    guard.remove(&oldest_key);
                }
            }
        }
        guard.insert(clean_id.to_string(), (Instant::now(), resolved.clone()));
    }

    Ok(resolved)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LiberationOwnershipClass {
    Pending,
    ReclaimableDirect,
    ReclaimableClearHls,
    SubscriptionDrmExcluded,
    Unavailable,
    Error,
}

impl LiberationOwnershipClass {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::ReclaimableDirect => "reclaimable_direct",
            Self::ReclaimableClearHls => "reclaimable_clear_hls",
            Self::SubscriptionDrmExcluded => "subscription_drm_excluded",
            Self::Unavailable => "unavailable",
            Self::Error => "error",
        }
    }

    pub fn from_str(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().as_str() {
            "reclaimable_direct" => Self::ReclaimableDirect,
            "reclaimable_clear_hls" => Self::ReclaimableClearHls,
            "subscription_drm_excluded" => Self::SubscriptionDrmExcluded,
            "unavailable" => Self::Unavailable,
            "error" => Self::Error,
            _ => Self::Pending,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OwnedAssetProbeResult {
    pub library_song_id: String,
    pub ownership_class: LiberationOwnershipClass,
    pub asset_flavor: Option<String>,
    pub asset_url_kind: Option<String>,
    pub all_observed_flavors: Vec<String>,
    pub content_length_bytes: Option<u64>,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnedWebPlaybackInspection {
    DirectClear {
        flavor: String,
        url: String,
        size_hint: Option<u64>,
        observed_flavors: Vec<String>,
    },
    ClearHlsCandidate {
        flavor: String,
        playlist_url: String,
        observed_flavors: Vec<String>,
    },
    DrmExcluded {
        flavor: Option<String>,
        reason: String,
        observed_flavors: Vec<String>,
    },
    Unavailable {
        reason: String,
        observed_flavors: Vec<String>,
    },
}

fn extract_asset_size_hint(asset: &Value) -> Option<u64> {
    for key in ["file-size", "fileSize", "downloadSize", "size"] {
        if let Some(n) = asset.get(key).and_then(|v| v.as_u64()) {
            if n > 0 {
                return Some(n);
            }
        }
    }
    asset
        .pointer("/metadata/fileSize")
        .and_then(|v| v.as_u64())
        .filter(|n| *n > 0)
}

/// Strictly inspects a raw Apple `webPlayback` JSON payload (queried with `universalLibraryId`)
/// to classify whether any returned asset is potentially DRM-free or is DRM-protected.
pub fn inspect_owned_web_playback_response(
    library_song_id: &str,
    json: &Value,
) -> OwnedWebPlaybackInspection {
    let Some(song_obj) = json.pointer("/songList/0") else {
        let status_msg = json
            .get("failureType")
            .or_else(|| json.get("customerMessage"))
            .or_else(|| json.get("status"))
            .map(|v| v.to_string())
            .unwrap_or_else(|| "No songList entry returned".to_string());
        return OwnedWebPlaybackInspection::Unavailable {
            reason: format!("Library ID {library_song_id}: {status_msg}"),
            observed_flavors: Vec::new(),
        };
    };

    let mut observed_flavors: Vec<String> = Vec::new();
    let Some(assets) = song_obj.get("assets").and_then(|v| v.as_array()) else {
        return OwnedWebPlaybackInspection::Unavailable {
            reason: "No assets array in webPlayback songList[0]".to_string(),
            observed_flavors,
        };
    };

    for a in assets {
        let f = a
            .get("flavor")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "unknown".to_string());
        if !observed_flavors.contains(&f) {
            observed_flavors.push(f);
        }
    }

    if assets.is_empty() {
        return OwnedWebPlaybackInspection::Unavailable {
            reason: "Empty assets list in webPlayback songList[0]".to_string(),
            observed_flavors,
        };
    }

    // 1. Direct unencrypted audio file (`itemDownload` or non-HLS `.m4a`/`.mp3`/etc.)
    if let Some(direct) = assets.iter().find(|a| is_direct_unencrypted_audio_asset(a)) {
        let flavor = direct
            .get("flavor")
            .and_then(|v| v.as_str())
            .unwrap_or("direct_audio")
            .to_string();
        let url = direct
            .get("URL")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        return OwnedWebPlaybackInspection::DirectClear {
            flavor,
            url,
            size_hint: extract_asset_size_hint(direct),
            observed_flavors,
        };
    }

    let key_server_url = song_obj
        .get("hls-key-server-url")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());

    // 2. If there is no `hls-key-server-url`, look for an unkeyed HLS candidate (`plus` or non-ctrp/cbcp)
    if key_server_url.is_none() {
        let is_clear_hls_candidate = |a: &&Value, require_plus: bool| -> bool {
            let has_url = a
                .get("URL")
                .and_then(|v| v.as_str())
                .map(|u| !u.trim().is_empty())
                .unwrap_or(false);
            if !has_url {
                return false;
            }
            let f = a
                .get("flavor")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if f.contains("ctrp") || f.contains("cbcp") {
                return false;
            }
            !require_plus || f.contains("plus")
        };

        if let Some(hls_asset) = assets
            .iter()
            .find(|a| is_clear_hls_candidate(a, true))
            .or_else(|| assets.iter().find(|a| is_clear_hls_candidate(a, false)))
        {
            let flavor = hls_asset
                .get("flavor")
                .and_then(|v| v.as_str())
                .unwrap_or("clear_hls")
                .to_string();
            let playlist_url = hls_asset
                .get("URL")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            return OwnedWebPlaybackInspection::ClearHlsCandidate {
                flavor,
                playlist_url,
                observed_flavors,
            };
        }
    }

    let primary_flavor = assets
        .iter()
        .find_map(|a| {
            a.get("flavor")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
        })
        .or_else(|| observed_flavors.first().cloned());

    let reason = if key_server_url.is_some() {
        "Stream requires DRM license server (hls-key-server-url present)".to_string()
    } else {
        "Only encrypted DRM flavors returned by webPlayback".to_string()
    };

    OwnedWebPlaybackInspection::DrmExcluded {
        flavor: primary_flavor,
        reason,
        observed_flavors,
    }
}

fn peek_url_magic(url: &str) -> Result<Vec<u8>> {
    crate::http_pool::http_get_bytes(url, &[], Some((0, 511)), 12)
}

fn is_m3u8_magic_header(head: &[u8]) -> bool {
    let trimmed_bom = head.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(head);
    std::str::from_utf8(trimmed_bom)
        .map(|s| {
            s.trim_start()
                .get(..7)
                .map(|p| p.eq_ignore_ascii_case("#EXTM3U"))
                .unwrap_or(false)
        })
        .unwrap_or(false)
}

fn classify_detected_container(
    clean_id: &str,
    container: &str,
    raw_flavor: &str,
    size_hint: Option<u64>,
    observed_flavors: &mut Vec<String>,
) -> OwnedAssetProbeResult {
    if container == "drm_m4p" {
        return OwnedAssetProbeResult {
            library_song_id: clean_id.to_string(),
            ownership_class: LiberationOwnershipClass::SubscriptionDrmExcluded,
            asset_flavor: Some(raw_flavor.to_string()),
            asset_url_kind: Some("drm_m4p".to_string()),
            all_observed_flavors: observed_flavors.clone(),
            content_length_bytes: None,
            reason: Some("Legacy FairPlay M4P container detected".to_string()),
        };
    }

    let resolved_flavor = if raw_flavor == "unknown" || raw_flavor == "direct_audio" {
        let labeled = format!("cloud_locker_{container}");
        for slot in observed_flavors.iter_mut() {
            if slot == "unknown" {
                *slot = labeled.clone();
            }
        }
        labeled
    } else {
        raw_flavor.to_string()
    };

    OwnedAssetProbeResult {
        library_song_id: clean_id.to_string(),
        ownership_class: LiberationOwnershipClass::ReclaimableDirect,
        asset_flavor: Some(resolved_flavor),
        asset_url_kind: Some(format!("direct_{container}")),
        all_observed_flavors: observed_flavors.clone(),
        content_length_bytes: size_hint,
        reason: None,
    }
}

fn verify_clear_hls_probe_result(
    clean_id: &str,
    flavor: String,
    playlist_url: &str,
    observed_flavors: Vec<String>,
) -> OwnedAssetProbeResult {
    match crate::sinks::apple_native::hls::fetch_and_verify_clear_apple_hls(playlist_url) {
        Ok(Ok(playlist)) => {
            let init_len = playlist.init_byte_range.map(|b| b.length).unwrap_or(0);
            let seg_len_sum: u64 = playlist
                .segments
                .iter()
                .filter_map(|s| s.byte_range.map(|b| b.length))
                .sum();
            let estimated_bytes = if seg_len_sum > 0 {
                Some(init_len + seg_len_sum)
            } else {
                None
            };
            OwnedAssetProbeResult {
                library_song_id: clean_id.to_string(),
                ownership_class: LiberationOwnershipClass::ReclaimableClearHls,
                asset_flavor: Some(flavor),
                asset_url_kind: Some("clear_hls_fmp4".to_string()),
                all_observed_flavors: observed_flavors,
                content_length_bytes: estimated_bytes,
                reason: None,
            }
        }
        Ok(Err(drm_reason)) => OwnedAssetProbeResult {
            library_song_id: clean_id.to_string(),
            ownership_class: LiberationOwnershipClass::SubscriptionDrmExcluded,
            asset_flavor: Some(flavor),
            asset_url_kind: Some("drm_hls".to_string()),
            all_observed_flavors: observed_flavors,
            content_length_bytes: None,
            reason: Some(drm_reason),
        },
        Err(err) => OwnedAssetProbeResult {
            library_song_id: clean_id.to_string(),
            ownership_class: LiberationOwnershipClass::Error,
            asset_flavor: Some(flavor),
            asset_url_kind: None,
            all_observed_flavors: observed_flavors,
            content_length_bytes: None,
            reason: Some(format!("HLS verification failed: {err}")),
        },
    }
}

/// Strictly read-only Stage 1 Project LIBERATION probe using pre-resolved tokens:
/// Queries Apple `webPlayback` with `{ "universalLibraryId": library_song_id }` ONLY (never substituting
/// a catalog `salableAdamId`), and verifies direct containers via a 512-byte Range magic-byte peek
/// or HLS playlists for zero `EXT-X-KEY` / PSSH tags.
pub fn probe_owned_library_asset_with_tokens(
    dev_token: &str,
    user_token: &str,
    library_song_id: &str,
) -> Result<OwnedAssetProbeResult> {
    let clean_id = extract_clean_apple_song_id(library_song_id).to_string();

    let json = apple_post_json(
        "https://play.music.apple.com/WebObjects/MZPlay.woa/wa/webPlayback",
        dev_token,
        user_token,
        &serde_json::json!({ "universalLibraryId": clean_id }),
    )?;

    match inspect_owned_web_playback_response(&clean_id, &json) {
        OwnedWebPlaybackInspection::DirectClear {
            flavor,
            url,
            size_hint,
            mut observed_flavors,
        } => match peek_url_magic(&url) {
            Ok(head) => {
                if let Some(container) = detect_audio_container_from_magic(&head) {
                    Ok(classify_detected_container(
                        &clean_id,
                        container,
                        &flavor,
                        size_hint,
                        &mut observed_flavors,
                    ))
                } else if is_m3u8_magic_header(&head) {
                    Ok(verify_clear_hls_probe_result(
                        &clean_id,
                        flavor,
                        &url,
                        observed_flavors,
                    ))
                } else {
                    let hex_preview: String = head
                        .iter()
                        .take(12)
                        .map(|b| format!("{b:02x}"))
                        .collect();
                    Ok(OwnedAssetProbeResult {
                        library_song_id: clean_id,
                        ownership_class: LiberationOwnershipClass::Error,
                        asset_flavor: Some(flavor),
                        asset_url_kind: None,
                        all_observed_flavors: observed_flavors,
                        content_length_bytes: None,
                        reason: Some(format!(
                            "Unrecognized binary header at direct audio URL (hex={hex_preview})"
                        )),
                    })
                }
            }
            Err(err) => Ok(OwnedAssetProbeResult {
                library_song_id: clean_id,
                ownership_class: LiberationOwnershipClass::Error,
                asset_flavor: Some(flavor),
                asset_url_kind: None,
                all_observed_flavors: observed_flavors,
                content_length_bytes: None,
                reason: Some(format!("Direct audio peek failed: {err}")),
            }),
        },
        OwnedWebPlaybackInspection::ClearHlsCandidate {
            flavor,
            playlist_url,
            mut observed_flavors,
        } => {
            if let Ok(head) = peek_url_magic(&playlist_url) {
                if let Some(container) = detect_audio_container_from_magic(&head) {
                    return Ok(classify_detected_container(
                        &clean_id,
                        container,
                        &flavor,
                        None,
                        &mut observed_flavors,
                    ));
                }
            }
            Ok(verify_clear_hls_probe_result(
                &clean_id,
                flavor,
                &playlist_url,
                observed_flavors,
            ))
        }
        OwnedWebPlaybackInspection::DrmExcluded {
            flavor,
            reason,
            observed_flavors,
        } => Ok(OwnedAssetProbeResult {
            library_song_id: clean_id,
            ownership_class: LiberationOwnershipClass::SubscriptionDrmExcluded,
            asset_flavor: flavor,
            asset_url_kind: Some("drm_hls".to_string()),
            all_observed_flavors: observed_flavors,
            content_length_bytes: None,
            reason: Some(reason),
        }),
        OwnedWebPlaybackInspection::Unavailable {
            reason,
            observed_flavors,
        } => Ok(OwnedAssetProbeResult {
            library_song_id: clean_id,
            ownership_class: LiberationOwnershipClass::Unavailable,
            asset_flavor: None,
            asset_url_kind: None,
            all_observed_flavors: observed_flavors,
            content_length_bytes: None,
            reason: Some(reason),
        }),
    }
}

/// Strictly read-only Stage 1 Project LIBERATION probe resolving tokens from `settings`.
pub fn probe_owned_library_asset(
    settings: &SimpSettings,
    library_song_id: &str,
) -> Result<OwnedAssetProbeResult> {
    let (dev_token, user_token) = resolve_tokens(settings)?;
    probe_owned_library_asset_with_tokens(&dev_token, &user_token, library_song_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_select_web_playback_asset_prefers_item_download_over_ctrp256() {
        let song_obj = serde_json::json!({
            "songId": "i.sample001",
            "hls-key-server-url": "https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa/acquireWebPlaybackLicense",
            "assets": [
                {
                    "flavor": "28:ctrp256",
                    "URL": "https://aod-ssl.itunes.apple.com/sample/prog.m3u8"
                },
                {
                    "flavor": "itemDownload",
                    "URL": "https://aod-ssl.itunes.apple.com/sample/track.m4a"
                }
            ]
        });

        let selected = select_web_playback_asset(&song_obj, "i.sample001").unwrap();
        assert_eq!(selected.flavor, "itemDownload");
        assert_eq!(selected.encryption_kind, AppleAssetEncryptionKind::ClearDirectAudio);
        assert!(selected.hls_playlist_url.ends_with(".m4a"));
    }

    #[test]
    fn test_select_web_playback_asset_prefers_plus256_when_no_key_server() {
        let song_obj = serde_json::json!({
            "songId": "i.sample002",
            "assets": [
                {
                    "flavor": "28:ctrp256",
                    "URL": "https://aod-ssl.itunes.apple.com/sample/ctrp.m3u8"
                },
                {
                    "flavor": "plus256",
                    "URL": "https://aod-ssl.itunes.apple.com/sample/plus.m3u8"
                }
            ]
        });

        let selected = select_web_playback_asset(&song_obj, "i.sample002").unwrap();
        assert_eq!(selected.flavor, "plus256");
        assert_eq!(selected.encryption_kind, AppleAssetEncryptionKind::ClearHlsFmp4);
    }

    #[test]
    fn test_select_web_playback_asset_marks_ctrp256_and_keyed_plus_as_widevine() {
        let ctrp_song = serde_json::json!({
            "songId": "100001",
            "hls-key-server-url": "https://play.itunes.apple.com/license",
            "assets": [
                {
                    "flavor": "28:ctrp256",
                    "URL": "https://aod-ssl.itunes.apple.com/sample/ctrp.m3u8"
                }
            ]
        });
        let s1 = select_web_playback_asset(&ctrp_song, "100001").unwrap();
        assert_eq!(s1.encryption_kind, AppleAssetEncryptionKind::WidevineCenc);

        let keyed_plus_song = serde_json::json!({
            "songId": "100002",
            "hls-key-server-url": "https://play.itunes.apple.com/license",
            "assets": [
                {
                    "flavor": "plus256",
                    "URL": "https://aod-ssl.itunes.apple.com/sample/plus.m3u8"
                }
            ]
        });
        let s2 = select_web_playback_asset(&keyed_plus_song, "100002").unwrap();
        assert_eq!(s2.encryption_kind, AppleAssetEncryptionKind::WidevineCenc);
    }

    #[test]
    fn test_inspect_owned_web_playback_response_classifications() {
        let direct_json = serde_json::json!({
            "songList": [{
                "assets": [
                    { "flavor": "itemDownload", "URL": "https://example.com/track.m4a", "fileSize": 8123456 }
                ]
            }]
        });
        assert_eq!(
            inspect_owned_web_playback_response("i.direct1", &direct_json),
            OwnedWebPlaybackInspection::DirectClear {
                flavor: "itemDownload".to_string(),
                url: "https://example.com/track.m4a".to_string(),
                size_hint: Some(8123456),
                observed_flavors: vec!["itemDownload".to_string()],
            }
        );

        let clear_hls_json = serde_json::json!({
            "songList": [{
                "assets": [
                    { "flavor": "plus256", "URL": "https://example.com/prog.m3u8" },
                    { "flavor": "28:ctrp256", "URL": "https://example.com/drm.m3u8" }
                ]
            }]
        });
        assert_eq!(
            inspect_owned_web_playback_response("i.clearhls1", &clear_hls_json),
            OwnedWebPlaybackInspection::ClearHlsCandidate {
                flavor: "plus256".to_string(),
                playlist_url: "https://example.com/prog.m3u8".to_string(),
                observed_flavors: vec!["plus256".to_string(), "28:ctrp256".to_string()],
            }
        );

        let drm_json = serde_json::json!({
            "songList": [{
                "hls-key-server-url": "https://play.itunes.apple.com/license",
                "assets": [
                    { "flavor": "28:ctrp256", "URL": "https://example.com/drm.m3u8" },
                    { "flavor": "30:cbcp256", "URL": "https://example.com/cbcp.m3u8" }
                ]
            }]
        });
        assert!(matches!(
            inspect_owned_web_playback_response("i.sub1", &drm_json),
            OwnedWebPlaybackInspection::DrmExcluded { .. }
        ));

        let empty_json = serde_json::json!({ "songList": [], "failureType": "1004" });
        assert!(matches!(
            inspect_owned_web_playback_response("i.missing1", &empty_json),
            OwnedWebPlaybackInspection::Unavailable { .. }
        ));
    }

    #[test]
    fn test_detect_audio_container_from_magic() {
        assert_eq!(
            detect_audio_container_from_magic(b"\x00\x00\x00 ftypM4A \x00\x00\x00\x00"),
            Some("m4a")
        );
        assert_eq!(
            detect_audio_container_from_magic(b"\x00\x00\x00 ftypM4P \x00\x00\x00\x00"),
            Some("drm_m4p")
        );
        assert_eq!(
            detect_audio_container_from_magic(b"ID3\x04\x00\x00\x00\x00\x00\x00"),
            Some("mp3")
        );
        assert_eq!(detect_audio_container_from_magic(b"fLaC\x00\x00\x00\""), Some("flac"));
        assert_eq!(
            detect_audio_container_from_magic(b"RIFF\x24\x00\x00\x00WAVEfmt "),
            Some("wav")
        );
        assert_eq!(
            detect_audio_container_from_magic(b"#EXTM3U\n#EXT-X-VERSION:7\n"),
            None
        );
    }

    #[test]
    fn test_is_direct_unencrypted_audio_asset_recognizes_s3_cloud_locker_audio_url() {
        let s3_song = serde_json::json!({
            "songList": [{
                "assets": [
                    {
                        "URL": "https://example-bucket.s3.amazonaws.com/sample-uuid/audio?response-content-disposition=attachment%3B%20filename%3D%22track.m4a%22&X-Amz-Signature=deadbeef"
                    }
                ]
            }]
        });
        assert!(is_direct_unencrypted_audio_asset(
            &s3_song["songList"][0]["assets"][0]
        ));
        assert!(matches!(
            inspect_owned_web_playback_response("i.uploaded1", &s3_song),
            OwnedWebPlaybackInspection::DirectClear { .. }
        ));
    }
}

