use super::DaemonIpcState;
use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};

pub(super) async fn lyrics_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let uri = params.get("uri").cloned();
    let title = params.get("title").cloned().unwrap_or_default();
    let artist = params.get("artist").cloned().unwrap_or_default();
    let album = params.get("album").cloned();
    let duration_ms = params
        .get("duration_ms")
        .and_then(|v| v.parse::<u32>().ok())
        .unwrap_or(0);

    let db = state.db.clone();
    let res = tokio::task::spawn_blocking(move || {
        let props = uri
            .as_deref()
            .and_then(|u| db.get_track_properties(u).ok())
            .unwrap_or_default();
        if props.suppress_lyrics {
            let suppressed = imp_core::lyrics::TrackLyricsResponse {
                found: false,
                source: "suppressed".to_string(),
                ..Default::default()
            };
            return (suppressed, props);
        }

        let mut lyrics = imp_core::lyrics::fetch_track_lyrics(
            uri.as_deref(),
            &title,
            &artist,
            album.as_deref(),
            duration_ms,
        );
        if lyrics.found {
            if let Some(u) = uri.as_deref().filter(|s| !s.trim().is_empty()) {
                let has_synced = !lyrics.synced_lines.is_empty();
                let _ = db.record_indexed_track_capabilities(u, props.has_art, true, has_synced);
            }
            if props.lyrics_offset_ms != 0 && !lyrics.synced_lines.is_empty() {
                for line in &mut lyrics.synced_lines {
                    let shifted = (line.timestamp_ms as i64 + props.lyrics_offset_ms).max(0);
                    line.timestamp_ms = shifted as u32;
                }
            }
        }
        let updated_props = uri
            .as_deref()
            .and_then(|u| db.get_track_properties(u).ok())
            .unwrap_or(props);
        (lyrics, updated_props)
    })
    .await;

    match res {
        Ok((lyrics, props)) => Json(serde_json::json!({
            "ok": true,
            "data": lyrics,
            "properties": props,
        })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(serde::Deserialize)]
pub(super) struct LyricsRefetchBody {
    uri: Option<String>,
    title: String,
    artist: String,
    album: Option<String>,
    duration_ms: Option<u32>,
}

pub(super) async fn lyrics_refetch_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<LyricsRefetchBody>,
) -> impl IntoResponse {
    let db = state.db.clone();
    let res = tokio::task::spawn_blocking(move || {
        let uri_ref = body.uri.as_deref().filter(|s| !s.trim().is_empty());
        let duration_ms = body.duration_ms.unwrap_or(0);
        // Clear any suppression flag when the user explicitly clicks [Refetch Lyrics]
        if let Some(u) = uri_ref {
            let _ = db.upsert_track_properties_patch(
                u,
                &imp_core::library::db::TrackPropertiesPatch {
                    suppress_lyrics: Some(false),
                    has_lyrics: Some(false),
                    has_synced_lyrics: Some(false),
                    ..Default::default()
                },
            );
        }
        let mut lyrics = imp_core::lyrics::refetch_track_lyrics(
            uri_ref,
            &body.title,
            &body.artist,
            body.album.as_deref(),
            duration_ms,
        );
        let props = if let Some(u) = uri_ref {
            let has_synced = !lyrics.synced_lines.is_empty();
            let patched = db
                .upsert_track_properties_patch(
                    u,
                    &imp_core::library::db::TrackPropertiesPatch {
                        has_lyrics: Some(lyrics.found),
                        has_synced_lyrics: Some(lyrics.found && has_synced),
                        suppress_lyrics: Some(false),
                        ..Default::default()
                    },
                )
                .unwrap_or_default();
            if patched.lyrics_offset_ms != 0 && !lyrics.synced_lines.is_empty() {
                for line in &mut lyrics.synced_lines {
                    let shifted = (line.timestamp_ms as i64 + patched.lyrics_offset_ms).max(0);
                    line.timestamp_ms = shifted as u32;
                }
            }
            patched
        } else {
            Default::default()
        };
        (lyrics, props)
    })
    .await;

    match res {
        Ok((lyrics, props)) => Json(serde_json::json!({
            "ok": true,
            "data": lyrics,
            "properties": props,
        })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn factoids_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let uri = params.get("uri").cloned().unwrap_or_default();
    let title = params.get("title").cloned().unwrap_or_default();
    let artist = params.get("artist").cloned().unwrap_or_default();
    let album = params.get("album").cloned().filter(|s| !s.trim().is_empty());
    let duration_ms: u32 = params
        .get("duration_ms")
        .and_then(|s| s.parse().ok())
        .unwrap_or(180_000);
    let db = state.db.clone();

    let res = tokio::task::spawn_blocking(move || {
        let uri_ref = if uri.trim().is_empty() {
            None
        } else {
            Some(uri.as_str())
        };
        if let Some(u) = uri_ref {
            if let Ok(props) = db.get_track_properties(u) {
                if props.suppress_factoids {
                    return imp_core::factoids::TrackFactoidsResponse {
                        found: false,
                        provider: "suppressed".to_string(),
                        bubbles: Vec::new(),
                    };
                }
            }
        }
        let factoids = imp_core::factoids::fetch_track_factoids(
            uri_ref,
            &title,
            &artist,
            album.as_deref(),
            duration_ms,
        );
        if let Some(u) = uri_ref {
            let _ = db.upsert_track_properties_patch(
                u,
                &imp_core::library::db::TrackPropertiesPatch {
                    has_factoids: Some(factoids.found),
                    ..Default::default()
                },
            );
        }
        factoids
    })
    .await;

    match res {
        Ok(data) => Json(serde_json::json!({ "ok": true, "data": data })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(serde::Deserialize)]
pub(super) struct FactoidsRefetchBody {
    uri: Option<String>,
    title: String,
    artist: String,
    album: Option<String>,
    duration_ms: Option<u32>,
}

pub(super) async fn factoids_refetch_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<FactoidsRefetchBody>,
) -> impl IntoResponse {
    let db = state.db.clone();
    let res = tokio::task::spawn_blocking(move || {
        let uri_ref = body.uri.as_deref().filter(|s| !s.trim().is_empty());
        imp_core::factoids::clear_cached_factoids_for_track(
            uri_ref,
            &body.title,
            &body.artist,
            body.album.as_deref(),
        );
        let factoids = imp_core::factoids::fetch_track_factoids(
            uri_ref,
            &body.title,
            &body.artist,
            body.album.as_deref(),
            body.duration_ms.unwrap_or(180_000),
        );
        if let Some(u) = uri_ref {
            let _ = db.upsert_track_properties_patch(
                u,
                &imp_core::library::db::TrackPropertiesPatch {
                    has_factoids: Some(factoids.found),
                    suppress_factoids: Some(false),
                    ..Default::default()
                },
            );
        }
        factoids
    })
    .await;

    match res {
        Ok(data) => Json(serde_json::json!({ "ok": true, "data": data })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn track_properties_get_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let uri = params.get("uri").cloned().unwrap_or_default();
    if uri.trim().is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "Missing uri parameter" }));
    }
    match state.db.get_track_properties(&uri) {
        Ok(props) => Json(serde_json::json!({ "ok": true, "data": props })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(serde::Deserialize)]
pub(super) struct TrackPropertiesPostBody {
    uri: String,
    #[serde(flatten)]
    patch: imp_core::library::db::TrackPropertiesPatch,
}

pub(super) async fn track_properties_post_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<TrackPropertiesPostBody>,
) -> impl IntoResponse {
    if body.uri.trim().is_empty() {
        return Json(serde_json::json!({ "ok": false, "error": "Missing uri" }));
    }

    let uri = body.uri.clone();
    let patch = body.patch.clone();
    let db = state.db.clone();
    let cfg = state.settings.lock().unwrap().clone();
    let cmd_tx = state.cmd_tx.clone();

    let res = tokio::task::spawn_blocking(move || {
        let mut updated = db.upsert_track_properties_patch(&uri, &patch)?;

        if patch.has_art == Some(false) {
            let album_title = db.get_track_by_uri(&uri).ok().flatten().map(|t| t.album);
            let _ = db.clear_track_and_album_grafted_art(&uri);
            imp_core::sinks::apple_api::evict_cached_track_art(&uri);
            let _ = cmd_tx.send(imp_protocol::AudioCommand::RefreshTrackArtwork {
                uri: uri.clone(),
                album_title,
                art_url: None,
            });
            updated = db.get_track_properties(&uri).unwrap_or(updated);
        } else if patch.custom_art_url.as_deref() == Some("") && patch.has_art == Some(true) {
            let fallback_album = db.get_track_by_uri(&uri).ok().flatten().map(|t| t.album);
            let _ = db.clear_track_and_album_grafted_art(&uri);
            imp_core::sinks::apple_api::evict_cached_track_art(&uri);

            if uri.starts_with("applemusic:") {
                if let Ok(alb_res) =
                    imp_core::sinks::apple_api::fetch_full_album(&cfg, None, Some(&uri))
                {
                    if let Some(ref alb_art) = alb_res.album.art_url {
                        for tr in &alb_res.tracks {
                            let tr_art = tr.art_url.as_deref().unwrap_or(alb_art.as_str());
                            let _ = db.set_track_art_url(&tr.uri, Some(tr_art));
                        }
                        let _ = db.set_track_art_url(&uri, Some(alb_art.as_str()));
                    }
                    let _ = cmd_tx.send(imp_protocol::AudioCommand::RefreshTrackArtwork {
                        uri: uri.clone(),
                        album_title: Some(alb_res.album.title),
                        art_url: alb_res.album.art_url,
                    });
                } else {
                    let _ = cmd_tx.send(imp_protocol::AudioCommand::RefreshTrackArtwork {
                        uri: uri.clone(),
                        album_title: fallback_album,
                        art_url: None,
                    });
                }
                updated = db.get_track_properties(&uri).unwrap_or(updated);
            }
        }

        Ok::<_, anyhow::Error>(updated)
    })
    .await;

    match res {
        Ok(Ok(props)) => Json(serde_json::json!({ "ok": true, "data": props })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn library_facets_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let facet = params.get("facet").cloned().unwrap_or_default();
    let db = state.db.clone();
    let facet_for_task = facet.clone();
    let (uris, tracks, synced_uris, all_lyrics_uris) = tokio::task::spawn_blocking(move || {
        let uris = db
            .get_facet_matching_uris(&facet_for_task)
            .unwrap_or_default();
        let tracks = db
            .get_facet_matching_tracks(&facet_for_task)
            .unwrap_or_default();
        let (synced_uris, all_lyrics_uris) =
            if facet_for_task == "synced_lyrics" || facet_for_task == "has_lyrics" {
                db.get_lyrics_uri_sets().unwrap_or_default()
            } else {
                (Vec::new(), Vec::new())
            };
        (uris, tracks, synced_uris, all_lyrics_uris)
    })
    .await
    .unwrap_or_default();
    Json(serde_json::json!({
        "ok": true,
        "facet": facet,
        "uris": uris,
        "tracks": tracks,
        "synced_uris": synced_uris,
        "all_lyrics_uris": all_lyrics_uris,
    }))
}

pub(super) async fn library_lyrics_status_handler(
    State(state): State<DaemonIpcState>,
) -> impl IntoResponse {
    let db = state.db.clone();
    let (synced_uris, all_lyrics_uris) = tokio::task::spawn_blocking(move || {
        db.get_lyrics_uri_sets().unwrap_or_default()
    })
    .await
    .unwrap_or_default();
    Json(serde_json::json!({
        "ok": true,
        "synced_uris": synced_uris,
        "all_lyrics_uris": all_lyrics_uris,
    }))
}

static PENDING_DSP_SETTINGS_SAVE: std::sync::OnceLock<
    std::sync::Mutex<Option<imp_protocol::SimpSettings>>,
> = std::sync::OnceLock::new();
static DSP_SETTINGS_SAVE_ACTIVE: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

fn schedule_debounced_settings_save(cfg: imp_protocol::SimpSettings) {
    let slot = PENDING_DSP_SETTINGS_SAVE.get_or_init(|| std::sync::Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(cfg);
    }
    if !DSP_SETTINGS_SAVE_ACTIVE.swap(true, std::sync::atomic::Ordering::AcqRel) {
        tokio::spawn(async move {
            loop {
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                let next_cfg = slot.lock().ok().and_then(|mut g| g.take());
                if let Some(cfg_to_write) = next_cfg {
                    let _ = tokio::task::spawn_blocking(move || {
                        let _ = crate::config::save_settings(&cfg_to_write);
                    })
                    .await;
                    continue;
                }
                DSP_SETTINGS_SAVE_ACTIVE.store(false, std::sync::atomic::Ordering::Release);
                let has_more = slot.lock().map(|g| g.is_some()).unwrap_or(false);
                if has_more
                    && !DSP_SETTINGS_SAVE_ACTIVE.swap(true, std::sync::atomic::Ordering::AcqRel)
                {
                    continue;
                }
                break;
            }
        });
    }
}

pub(super) async fn dsp_get_handler() -> impl IntoResponse {
    let snap = imp_core::dsp::global_dsp_state().snapshot();
    let os_tap_status = imp_core::sinks::tap_dsp::global_tap_status();
    let tap_status = match imp_core::sinks::tap_dsp::worker_native_dsp_status() {
        Some(mut ws) if ws.dsp_active => {
            ws.spectrum_active = ws.spectrum_active || os_tap_status.spectrum_active;
            ws
        }
        _ => os_tap_status,
    };
    Json(serde_json::json!({
        "ok": true,
        "data": snap,
        "tap_status": tap_status,
        "presets": imp_core::dsp::BUILTIN_EQ_PRESETS,
        "band_freqs_hz": imp_core::dsp::EQ_BAND_FREQS_HZ,
        "band_labels": imp_core::dsp::EQ_BAND_LABELS,
    }))
}

#[derive(serde::Deserialize, Default)]
pub(super) struct DspWorkerStatusBody {
    active: bool,
    mode: Option<String>,
    detail: Option<String>,
    spectrum_active: Option<bool>,
}

pub(super) async fn dsp_worker_status_handler(
    Json(body): Json<DspWorkerStatusBody>,
) -> impl IntoResponse {
    if body.active {
        imp_core::sinks::tap_dsp::set_worker_native_dsp_status(Some(
            imp_core::sinks::tap_dsp::AudioTapStatusSnapshot {
                platform: "windows".to_string(),
                mode: body
                    .mode
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "windows_webaudio_dsp".to_string()),
                dsp_active: true,
                spectrum_active: body.spectrum_active.unwrap_or(true),
                worker_sink_label: None,
                detail: body
                    .detail
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| {
                        "Windows Web Audio 10-Band EQ + Vocal Stage active.".to_string()
                    }),
            },
        ));
    } else {
        imp_core::sinks::tap_dsp::set_worker_native_dsp_status(None);
    }
    Json(serde_json::json!({ "ok": true }))
}

#[derive(serde::Deserialize, Default)]
pub(super) struct DspPostBody {
    eq_enabled: Option<bool>,
    eq_preset: Option<String>,
    preamp_db: Option<f32>,
    bands_db: Option<Vec<f32>>,
    vocal_mode: Option<String>,
    vocal_strength: Option<f32>,
}

pub(super) async fn dsp_post_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<DspPostBody>,
) -> impl IntoResponse {
    let dsp_state = imp_core::dsp::global_dsp_state();
    let mut next = dsp_state.snapshot();

    if let Some(en) = body.eq_enabled {
        next.eq_enabled = en;
    }
    if let Some(ref preset_id) = body.eq_preset {
        let norm = preset_id.trim().to_ascii_lowercase();
        next.eq_preset = norm.clone();
        if let Some(preset) = imp_core::dsp::lookup_eq_preset(&norm) {
            next.bands_db = preset.bands_db;
            if body.preamp_db.is_none() {
                next.preamp_db = preset.preamp_db;
            }
        }
    }
    if let Some(preamp) = body.preamp_db {
        if preamp.is_finite() {
            next.preamp_db = preamp.clamp(-12.0, 12.0);
        }
    }
    if let Some(ref bands) = body.bands_db {
        for (i, &v) in bands.iter().take(10).enumerate() {
            if v.is_finite() {
                next.bands_db[i] = v.clamp(-12.0, 12.0);
            }
        }
        if body.eq_preset.is_none() {
            next.eq_preset = "custom".to_string();
        }
    }
    if let Some(ref v_mode) = body.vocal_mode {
        next.vocal_mode = imp_core::dsp::VocalDspMode::from_str_id(v_mode)
            .as_str_id()
            .to_string();
    }
    if let Some(v_str) = body.vocal_strength {
        if v_str.is_finite() {
            next.vocal_strength = v_str.clamp(0.0, 1.0);
        }
    }

    dsp_state.apply_snapshot(&next);
    let _ = state.broadcast_tx.send(imp_protocol::PlaybackEvent::DspConfigUpdated {
        eq_enabled: next.eq_enabled,
        eq_preset: next.eq_preset.clone(),
        preamp_db: next.preamp_db,
        bands_db: next.bands_db,
        vocal_mode: next.vocal_mode.clone(),
        vocal_strength: next.vocal_strength,
    });

    // Persist DSP state to `~/.config/simp/settings.vdf` asynchronously (coalesced/debounced)
    // so rapid EQ slider adjustments never block Tokio HTTP handlers on disk I/O.
    let cfg_to_save = {
        let mut cfg = state.settings.lock().unwrap();
        cfg.audio.eq_enabled = next.eq_enabled;
        cfg.audio.eq_preset = next.eq_preset.clone();
        cfg.audio.eq_preamp_db = next.preamp_db as f64;
        cfg.audio.eq_bands_csv = imp_core::dsp::format_eq_bands_csv(&next.bands_db);
        cfg.audio.vocal_mode = next.vocal_mode.clone();
        cfg.audio.vocal_strength = next.vocal_strength as f64;
        cfg.clone()
    };
    schedule_debounced_settings_save(cfg_to_save);

    Json(serde_json::json!({
        "ok": true,
        "data": next,
    }))
}

#[derive(serde::Deserialize)]
pub(super) struct ConvertToHybridBody {
    playlist_id: String,
}

pub(super) async fn convert_playlist_to_hybrid_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<ConvertToHybridBody>,
) -> impl IntoResponse {
    match state.db.convert_playlist_to_hybrid(&body.playlist_id) {
        Ok(converted) => {
            let (total_albums, total_tracks) = state.db.get_library_counts().unwrap_or((0, 0));
            let _ = state
                .broadcast_tx
                .send(imp_protocol::PlaybackEvent::LibraryUpdated {
                    total_albums,
                    total_tracks,
                });
            Json(serde_json::json!({ "ok": true, "converted": converted }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(serde::Deserialize)]
pub(super) struct PurgeSourceBody {
    source: String,
}

pub(super) async fn purge_source_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<PurgeSourceBody>,
) -> impl IntoResponse {
    let purged_cache = state
        .services_cache
        .purge_provider_cache(&body.source)
        .unwrap_or(0);
    match state.db.purge_source_data(&body.source) {
        Ok(removed) => {
            let (total_albums, total_tracks) = state.db.get_library_counts().unwrap_or((0, 0));
            let _ = state
                .broadcast_tx
                .send(imp_protocol::PlaybackEvent::LibraryUpdated {
                    total_albums,
                    total_tracks,
                });
            Json(serde_json::json!({
                "ok": true,
                "removed": removed,
                "purged_cache": purged_cache
            }))
        }
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn cache_shelves_get_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let now_unix = imp_core::library::services_cache::current_unix_sec();
    if let Some(key) = params.get("key").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        return match state.services_cache.get_cached_shelf(key) {
            Ok(shelf) => Json(serde_json::json!({
                "ok": true,
                "now_unix": now_unix,
                "shelf": shelf,
            })),
            Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        };
    }
    let provider = params
        .get("provider")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    match state.services_cache.list_cached_shelves(provider) {
        Ok(shelves) => Json(serde_json::json!({
            "ok": true,
            "now_unix": now_unix,
            "shelves": shelves,
        })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(serde::Deserialize)]
#[serde(untagged)]
pub(super) enum CacheShelvesPostBody {
    Batch {
        shelves: Vec<imp_core::library::services_cache::CachedShelfRecord>,
    },
    Single(imp_core::library::services_cache::CachedShelfRecord),
}

pub(super) async fn cache_shelves_post_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<CacheShelvesPostBody>,
) -> impl IntoResponse {
    let items = match body {
        CacheShelvesPostBody::Batch { shelves } => shelves,
        CacheShelvesPostBody::Single(s) => vec![s],
    };
    let mut updated = 0usize;
    for item in &items {
        if let Err(e) = state.services_cache.upsert_cached_shelf(item) {
            return Json(serde_json::json!({ "ok": false, "error": e.to_string() }));
        }
        updated += 1;
    }
    Json(serde_json::json!({
        "ok": true,
        "updated": updated,
        "now_unix": imp_core::library::services_cache::current_unix_sec(),
    }))
}

pub(super) async fn fyp_shelves_get_handler(State(state): State<DaemonIpcState>) -> impl IntoResponse {
    let now_unix = imp_core::library::services_cache::current_unix_sec();
    match (
        state.services_cache.list_fyp_shelves(),
        state.services_cache.list_cached_shelves(None),
    ) {
        (Ok(shelves), Ok(snapshots)) => Json(serde_json::json!({
            "ok": true,
            "now_unix": now_unix,
            "shelves": shelves,
            "snapshots": snapshots,
        })),
        (Err(e), _) | (_, Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(serde::Deserialize)]
pub(super) struct FypShelvesPostBody {
    action: String,
    shelf: Option<imp_core::library::services_cache::FypShelfRecord>,
    snapshot: Option<imp_core::library::services_cache::CachedShelfRecord>,
    shelf_uid: Option<String>,
    shelves: Option<Vec<imp_core::library::services_cache::FypShelfRecord>>,
}

pub(super) async fn fyp_shelves_post_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<FypShelvesPostBody>,
) -> impl IntoResponse {
    let op_res: anyhow::Result<()> = (|| {
        match body.action.as_str() {
            "pin" => {
                if let Some(snap) = &body.snapshot {
                    state.services_cache.upsert_cached_shelf(snap)?;
                }
                if let Some(shelf) = &body.shelf {
                    state.services_cache.upsert_fyp_shelf(shelf)?;
                }
            }
            "unpin" => {
                if let Some(uid) = body.shelf_uid.as_deref() {
                    state.services_cache.delete_fyp_shelf(uid)?;
                }
            }
            "save_all" => {
                if let Some(list) = &body.shelves {
                    state.services_cache.save_fyp_shelves(list)?;
                }
            }
            other => {
                anyhow::bail!("Unknown FYP action: {}", other);
            }
        }
        Ok(())
    })();

    if let Err(e) = op_res {
        return Json(serde_json::json!({ "ok": false, "error": e.to_string() }));
    }

    let now_unix = imp_core::library::services_cache::current_unix_sec();
    match (
        state.services_cache.list_fyp_shelves(),
        state.services_cache.list_cached_shelves(None),
    ) {
        (Ok(shelves), Ok(snapshots)) => Json(serde_json::json!({
            "ok": true,
            "now_unix": now_unix,
            "shelves": shelves,
            "snapshots": snapshots,
        })),
        (Err(e), _) | (_, Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn local_discover_handler(State(state): State<DaemonIpcState>) -> impl IntoResponse {
    let day_seed = (imp_core::library::services_cache::current_unix_sec().max(0) as u64) / 86_400;
    let db = state.db.clone();
    let res = tokio::task::spawn_blocking(move || db.get_local_discovery_shelves(day_seed)).await;
    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn auth_probe_handler(State(state): State<DaemonIpcState>) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let res = tokio::task::spawn_blocking(move || {
        // 1. Apple Music check: only probe if user previously connected an Apple Music account
        let creds = imp_core::sinks::apple::AppleMusicSink::resolve_credentials(&cfg);
        let apple_configured = cfg.services.apple_music_enabled && creds.music_user_token.is_some();
        let mut apple_expired = false;
        let mut apple_reason: Option<String> = None;
        if apple_configured {
            let dev_tok = imp_core::sinks::apple::AppleMusicSink::get_or_sign_developer_token(&cfg)
                .unwrap_or_default();
            let mut_tok = creds.music_user_token.as_deref().unwrap_or("");
            if dev_tok.is_empty() {
                apple_expired = true;
                apple_reason = Some("Missing Apple Music developer token".to_string());
            } else {
                let auth_header = format!("Bearer {}", dev_tok);
                let headers = [
                    ("Authorization", auth_header.as_str()),
                    ("Music-User-Token", mut_tok),
                    ("Origin", "https://music.apple.com"),
                ];
                if let Err(e) = imp_core::http_pool::http_get_bytes(
                    "https://api.music.apple.com/v1/me/storefront",
                    &headers,
                    None,
                    6,
                ) {
                    let msg = e.to_string();
                    if msg.contains("401") || msg.contains("403") {
                        apple_expired = true;
                        apple_reason = Some(
                            "Apple Music user session token expired (HTTP 401/403)".to_string(),
                        );
                    }
                }
            }
        }

        // 2. SoundCloud check: if user had an OAuth session (`auth_mode == "user"` or non-empty refresh/access token),
        // `ensure_valid_access_token` attempts silent refresh first before reporting failure.
        let sc_user_mode = cfg.services.soundcloud_auth_mode == "user"
            || !cfg.services.soundcloud_username.trim().is_empty();
        let mut sc_expired = false;
        let mut sc_reason: Option<String> = None;
        if sc_user_mode {
            match imp_core::sinks::soundcloud_api::ensure_valid_access_token(&cfg) {
                Ok(_) => {}
                Err(e) => {
                    sc_expired = true;
                    sc_reason = Some(format!("SoundCloud session expired: {e}"));
                }
            }
        }

        // 3. Internet Archive check
        let ia_configured = cfg.services.internet_archive_enabled
            && !cfg.services.internet_archive_access_key.trim().is_empty()
            && !cfg.services.internet_archive_secret_key.trim().is_empty();
        let ia_expired = false;

        serde_json::json!({
            "apple": {
                "was_connected": apple_configured,
                "expired": apple_expired,
                "reason": apple_reason,
            },
            "soundcloud": {
                "was_connected": sc_user_mode,
                "expired": sc_expired,
                "reason": sc_reason,
                "username": cfg.services.soundcloud_username,
            },
            "ia": {
                "was_connected": ia_configured,
                "expired": ia_expired,
                "username": cfg.services.internet_archive_username,
            }
        })
    })
    .await;

    match res {
        Ok(data) => Json(serde_json::json!({ "ok": true, "data": data })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn execute_refresh_paths_with_volumes_root(
    db: imp_core::library::db::LibraryDatabase,
    bcast: tokio::sync::broadcast::Sender<imp_protocol::PlaybackEvent>,
    body: imp_core::library::indexer::PendingRefreshEntry,
    volumes_root: std::path::PathBuf,
) -> serde_json::Value {
    let res = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let old_paths: Vec<std::path::PathBuf> = body
            .old_paths
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .map(std::path::PathBuf::from)
            .collect();
        let new_paths: Vec<std::path::PathBuf> = body
            .new_paths
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .map(std::path::PathBuf::from)
            .collect();
        let fallback_root = body
            .fallback_root
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from("/"));

        let mut guard_paths: Vec<std::path::PathBuf> = old_paths
            .iter()
            .chain(new_paths.iter())
            .cloned()
            .collect();
        if let Some(ref fb) = body.fallback_root {
            let trimmed_fb = fb.trim();
            if !trimmed_fb.is_empty() {
                guard_paths.push(std::path::PathBuf::from(trimmed_fb));
            }
        }
        let existing_mounts = db.get_mounts().unwrap_or_default();
        if let Some(offline_mount) =
            imp_core::library::indexer::detect_offline_mount_for_paths_with_roots(
                &guard_paths,
                &existing_mounts,
                &volumes_root,
            )
        {
            return Ok(serde_json::json!({
                "ok": false,
                "error": "mount_offline",
                "mount_root": offline_mount,
            }));
        }

        let refreshed = imp_core::library::indexer::refresh_local_paths_in_db(
            &db,
            &old_paths,
            &new_paths,
            &fallback_root,
        )?;
        let (total_albums, total_tracks) = db.get_library_counts().unwrap_or((0, 0));
        let _ = bcast.send(imp_protocol::PlaybackEvent::LibraryUpdated {
            total_albums,
            total_tracks,
        });
        Ok(serde_json::json!({
            "ok": true,
            "refreshed": refreshed,
            "total_albums": total_albums,
            "total_tracks": total_tracks,
        }))
    })
    .await;

    match res {
        Ok(Ok(payload)) => payload,
        Ok(Err(e)) => serde_json::json!({ "ok": false, "error": e.to_string() }),
        Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
    }
}

pub(super) async fn library_refresh_paths_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<imp_core::library::indexer::PendingRefreshEntry>,
) -> impl IntoResponse {
    Json(
        execute_refresh_paths_with_volumes_root(
            state.db.clone(),
            state.broadcast_tx.clone(),
            body,
            std::path::PathBuf::from("/Volumes"),
        )
        .await,
    )
}

pub(super) async fn library_index_snapshot_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let mount_root = params
        .get("mount_root")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let db = state.db.clone();
    let res = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let raw_mounts = db.get_mounts()?;
        let mounts: Vec<serde_json::Value> = raw_mounts
            .into_iter()
            .map(|m| {
                let probe = imp_core::library::indexer::probe_mount_fs_info(&m.mount_root);
                serde_json::json!({
                    "mount_root": m.mount_root,
                    "label": m.label,
                    "mount_kind": m.mount_kind,
                    "is_online": m.is_online,
                    "track_count": m.track_count,
                    "last_scanned_at": m.last_scanned_at,
                    "is_network_fs": probe.is_network_fs,
                    "fs_type": probe.fs_type,
                })
            })
            .collect();
        let tracks = db.list_local_track_index_snapshot(mount_root.as_deref())?;
        Ok(serde_json::json!({
            "ok": true,
            "schema_version": 1,
            "mounts": mounts,
            "tracks": tracks,
        }))
    })
    .await;

    match res {
        Ok(Ok(payload)) => Json(payload),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

