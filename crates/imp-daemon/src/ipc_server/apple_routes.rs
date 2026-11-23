use super::DaemonIpcState;
use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};

pub(super) async fn apple_playlists_handler(State(state): State<DaemonIpcState>) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let db = state.db.clone();
    let res = tokio::task::spawn_blocking(move || {
        let mut playlists = imp_core::sinks::apple_api::fetch_cloud_playlists(&cfg)?;
        let cached_art = db.get_all_cached_apple_playlist_art();
        let sync_map = db.get_playlist_remote_sync_map("apple_remote");
        let existing_pinned: std::collections::HashMap<String, imp_protocol::PlaylistRecord> = db
            .get_playlists()
            .unwrap_or_default()
            .into_iter()
            .filter(|p| p.origin == "apple_remote")
            .map(|p| (p.id.clone(), p))
            .collect();

        let mut updated_pinned = 0usize;
        for pl in &mut playlists {
            let needs_heal = pl
                .art_url
                .as_deref()
                .map(|u| u.is_empty() || u.contains("blobstore.apple.com"))
                .unwrap_or(true);
            if needs_heal {
                if let Some(cached) = cached_art.get(&pl.id) {
                    pl.art_url = Some(cached.clone());
                }
            } else if let Some(ref valid_url) = pl.art_url {
                let _ = db.set_cached_apple_playlist_art(&pl.id, valid_url);
            }

            let db_pl_id = format!("applemusic:playlist:{}", pl.id);
            if let Some((stored_remote_ts, _)) = sync_map.get(&db_pl_id) {
                let remote_ts = pl.last_modified_date.as_deref();
                let changed = match (remote_ts, stored_remote_ts.as_deref()) {
                    (Some(cur), Some(prev)) => cur != prev,
                    (Some(_), None) => true,
                    _ => false,
                };
                if changed && updated_pinned < 8 {
                    if let Ok(tracks) = imp_core::sinks::apple_api::fetch_playlist_tracks(
                        &cfg,
                        &pl.id,
                        Some(&pl.kind),
                    ) {
                        if let Some(mut rec) = existing_pinned.get(&db_pl_id).cloned() {
                            rec.name = format!("📌 {}", pl.name);
                            rec.description = pl.description.clone();
                            if pl.art_url.is_some() {
                                rec.cover_art_url = pl.art_url.clone();
                            }
                            rec.track_count = tracks.len();
                            if db.import_catalog_bundle("apple_music", None, Some(&rec), &tracks).is_ok() {
                                let _ = db.set_playlist_remote_updated_at(&db_pl_id, remote_ts);
                                updated_pinned += 1;
                            }
                        }
                    }
                }
            }
        }
        Ok::<_, anyhow::Error>((playlists, updated_pinned))
    })
    .await;
    match res {
        Ok(Ok((playlists, updated_pinned))) => Json(serde_json::json!({
            "ok": true,
            "data": playlists,
            "synced_pinned": updated_pinned,
        })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_playlist_tracks_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let db = state.db.clone();
    let id = params.get("id").cloned().unwrap_or_default();
    let kind = params.get("kind").cloned();
    let res = tokio::task::spawn_blocking(move || {
        let tracks =
            imp_core::sinks::apple_api::fetch_playlist_tracks(&cfg, &id, kind.as_deref())?;
        if let Some(first_art) = tracks
            .iter()
            .find_map(|t| t.art_url.as_deref())
            .filter(|u| !u.is_empty() && !u.contains("blobstore.apple.com"))
        {
            let _ = db.set_cached_apple_playlist_art(&id, first_art);
        }
        Ok::<_, anyhow::Error>(tracks)
    })
    .await;
    match res {
        Ok(Ok(tracks)) => Json(serde_json::json!({ "ok": true, "data": tracks })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_playlist_cover_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let db = state.db.clone();
    let id = params.get("id").cloned().unwrap_or_default();
    let kind = params.get("kind").cloned();
    let force = params.get("force").map(|v| v == "1").unwrap_or(false);
    let res = tokio::task::spawn_blocking(move || {
        if !force {
            if let Some(cached) = db
                .get_cached_apple_playlist_art(&id)
                .filter(|u| !u.is_empty() && !u.contains("blobstore.apple.com"))
            {
                return Some(cached);
            }
        }
        let fetched =
            imp_core::sinks::apple_api::fetch_playlist_cover_art(&cfg, &id, kind.as_deref());
        if let Some(ref url) = fetched {
            let _ = db.set_cached_apple_playlist_art(&id, url);
        }
        fetched
    })
    .await;
    match res {
        Ok(Some(art_url)) => Json(serde_json::json!({ "ok": true, "art_url": art_url })),
        _ => Json(serde_json::json!({ "ok": false, "art_url": serde_json::Value::Null })),
    }
}

pub(super) async fn apple_full_album_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let album_id = params.get("album_id").cloned();
    let song_uri = params.get("song_uri").cloned();
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::fetch_full_album(
            &cfg,
            album_id.as_deref(),
            song_uri.as_deref(),
        )
    })
    .await;
    match res {
        Ok(Ok(bundle)) => Json(serde_json::json!({ "ok": true, "data": bundle })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_radio_handler(State(state): State<DaemonIpcState>) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::fetch_radio_and_for_you(&cfg)
    })
    .await;
    match res {
        Ok(Ok(feed)) => Json(serde_json::json!({ "ok": true, "data": feed })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_library_recent_handler(State(state): State<DaemonIpcState>) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::fetch_library_recently_added(&cfg)
    })
    .await;
    match res {
        Ok(Ok(albums)) => Json(serde_json::json!({ "ok": true, "data": albums })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_new_handler(State(state): State<DaemonIpcState>) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::fetch_new_feed(&cfg)
    })
    .await;
    match res {
        Ok(Ok(feed)) => Json(serde_json::json!({ "ok": true, "data": feed })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_search_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let term = params.get("term").or_else(|| params.get("q")).cloned().unwrap_or_default();
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::search_catalog(&cfg, &term)
    })
    .await;
    match res {
        Ok(Ok(results)) => Json(serde_json::json!({ "ok": true, "data": results })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_artist_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let id_or_name = params
        .get("id")
        .or_else(|| params.get("name"))
        .cloned()
        .unwrap_or_default();
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::fetch_apple_artist_profile(&cfg, &id_or_name)
    })
    .await;
    match res {
        Ok(Ok(profile)) => Json(serde_json::json!({ "ok": true, "data": profile })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_rate_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let id = params.get("id").cloned().unwrap_or_default();
    let kind = params
        .get("kind")
        .cloned()
        .unwrap_or_else(|| "songs".to_string());
    let favorited = params
        .get("favorited")
        .map(|v| v != "0" && v != "false")
        .unwrap_or(true);
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::set_apple_item_rating(&cfg, &id, &kind, favorited)
    })
    .await;
    match res {
        Ok(Ok(())) => Json(serde_json::json!({ "ok": true })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_library_add_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let id = params.get("id").cloned().unwrap_or_default();
    let kind = params
        .get("kind")
        .cloned()
        .unwrap_or_else(|| "songs".to_string());
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::add_to_apple_cloud_library(&cfg, &id, &kind)
    })
    .await;
    match res {
        Ok(Ok(())) => Json(serde_json::json!({ "ok": true })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_resolve_track_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let id = params.get("id").cloned().unwrap_or_default();
    let title = params.get("title").cloned();
    let artist = params.get("artist").cloned();
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::resolve_replacement_catalog_song_id(
            &cfg,
            &id,
            title.as_deref(),
            artist.as_deref(),
        )
    })
    .await;
    match res {
        Ok(Ok(catalog_id)) => Json(serde_json::json!({ "ok": true, "catalog_id": catalog_id })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_web_playback_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let id = params.get("id").cloned().unwrap_or_default();
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::fetch_web_playback_manifest(&cfg, &id)
    })
    .await;
    match res {
        Ok(Ok(asset)) => Json(serde_json::json!({ "ok": true, "data": asset })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_native_probe_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let id = params.get("id").cloned().unwrap_or_default();
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_native::source::probe_apple_native_pipeline(&cfg, &id)
    })
    .await;
    match res {
        Ok(Ok(report)) => Json(serde_json::json!({ "ok": true, "data": report })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(serde::Deserialize)]
pub(super) struct ApplePlaylistAddTracksBody {
    playlist_id: String,
    track_ids: Vec<String>,
}

pub(super) async fn apple_playlist_add_tracks_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<ApplePlaylistAddTracksBody>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let db = state.db.clone();
    let pl_id = body.playlist_id.clone();
    let track_ids = body.track_ids.clone();
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::add_tracks_to_apple_cloud_playlist(&cfg, &pl_id, &track_ids)?;
        let raw_id = pl_id
            .trim()
            .strip_prefix("applemusic:playlist:")
            .unwrap_or(pl_id.trim())
            .to_string();
        let db_pl_id = format!("applemusic:playlist:{raw_id}");
        if let Some(mut rec) = db
            .get_playlists()
            .unwrap_or_default()
            .into_iter()
            .find(|p| p.id == db_pl_id && p.origin == "apple_remote")
        {
            if let Ok(tracks) =
                imp_core::sinks::apple_api::fetch_playlist_tracks(&cfg, &raw_id, Some("library"))
            {
                rec.track_count = tracks.len();
                let _ = db.import_catalog_bundle("apple_music", None, Some(&rec), &tracks);
            }
        }
        Ok::<_, anyhow::Error>(())
    })
    .await;
    match res {
        Ok(Ok(())) => Json(serde_json::json!({ "ok": true })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(serde::Deserialize)]
pub(super) struct ApplePlaylistCreateBody {
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    track_ids: Vec<String>,
}

pub(super) async fn apple_playlist_create_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<ApplePlaylistCreateBody>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let res = tokio::task::spawn_blocking(move || {
        imp_core::sinks::apple_api::create_apple_cloud_playlist(
            &cfg,
            &body.name,
            body.description.as_deref(),
            &body.track_ids,
        )
    })
    .await;
    match res {
        Ok(Ok(pl)) => Json(serde_json::json!({ "ok": true, "data": pl })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn apple_recent_played_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let offset = params
        .get("offset")
        .and_then(|s| s.trim().parse::<usize>().ok())
        .unwrap_or(0);
    let kind = params.get("kind").map(|s| s.as_str()).unwrap_or("items");
    if kind == "tracks" {
        let res = tokio::task::spawn_blocking(move || {
            imp_core::sinks::apple_api::fetch_recent_played_tracks_page(&cfg, offset)
        })
        .await;
        match res {
            Ok(Ok((tracks, next_offset))) => Json(serde_json::json!({
                "ok": true,
                "tracks": tracks,
                "next_offset": next_offset,
            })),
            Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        }
    } else {
        let res = tokio::task::spawn_blocking(move || {
            imp_core::sinks::apple_api::fetch_recent_played_items_page(&cfg, offset)
        })
        .await;
        match res {
            Ok(Ok((shelf, next_offset))) => Json(serde_json::json!({
                "ok": true,
                "shelf": shelf,
                "next_offset": next_offset,
            })),
            Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
            Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        }
    }
}

