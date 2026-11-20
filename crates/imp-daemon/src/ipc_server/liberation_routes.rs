use super::DaemonIpcState;
use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};
use imp_core::liberation::{compute_album_fragmentation_diagnostics, global_liberation_controller};
use serde::Deserialize;

fn snapshot_apple_settings(state: &DaemonIpcState) -> imp_protocol::SimpSettings {
    let mut cfg = state.settings.lock().unwrap().clone();
    if cfg.services.apple_music_user_token.trim().is_empty() {
        let disk = imp_core::library::vdf::load_or_create_settings();
        if !disk.services.apple_music_user_token.trim().is_empty() {
            cfg.services.apple_music_user_token = disk.services.apple_music_user_token;
        }
        if cfg.services.apple_developer_token.trim().is_empty()
            && !disk.services.apple_developer_token.trim().is_empty()
        {
            cfg.services.apple_developer_token = disk.services.apple_developer_token;
        }
    }
    cfg
}

#[derive(Deserialize, Default)]
pub(super) struct StartCensusBody {
    #[serde(default)]
    force_reingest: bool,
    #[serde(default)]
    sample_per_bucket: Option<usize>,
}

pub(super) async fn liberation_census_start_handler(
    State(state): State<DaemonIpcState>,
    body: Option<Json<StartCensusBody>>,
) -> impl IntoResponse {
    let cfg = snapshot_apple_settings(&state);
    let cache = state.services_cache.clone();
    let (force_reingest, sample_per_bucket) = match body {
        Some(Json(b)) => (b.force_reingest, b.sample_per_bucket),
        None => (false, None),
    };
    let res = tokio::task::spawn_blocking(move || {
        global_liberation_controller().start(cfg, cache, force_reingest, sample_per_bucket)
    })
    .await;

    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn liberation_census_pause_handler(
    State(state): State<DaemonIpcState>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let res = tokio::task::spawn_blocking(move || {
        let ctrl = global_liberation_controller();
        ctrl.pause()?;
        ctrl.status(&cache)
    })
    .await;

    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn liberation_census_reset_handler(
    State(state): State<DaemonIpcState>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let res =
        tokio::task::spawn_blocking(move || global_liberation_controller().reset(&cache)).await;

    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn liberation_census_status_handler(
    State(state): State<DaemonIpcState>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let res =
        tokio::task::spawn_blocking(move || global_liberation_controller().status(&cache)).await;

    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
pub(super) struct LiberationTracksQuery {
    #[serde(default)]
    ownership: Option<String>,
    #[serde(default)]
    origin: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    offset: Option<usize>,
}

pub(super) async fn liberation_tracks_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<LiberationTracksQuery>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let limit = params.limit.unwrap_or(50).clamp(1, 500);
    let offset = params.offset.unwrap_or(0);
    let ownership = params.ownership;
    let origin = params.origin;
    let q = params.q;

    let res = tokio::task::spawn_blocking(move || {
        cache.query_liberation_tracks(
            ownership.as_deref(),
            origin.as_deref(),
            q.as_deref(),
            limit,
            offset,
        )
    })
    .await;

    match res {
        Ok(Ok((tracks, total))) => Json(serde_json::json!({
            "ok": true,
            "data": {
                "tracks": tracks,
                "total": total,
                "limit": limit,
                "offset": offset
            }
        })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn liberation_diagnostics_handler(
    State(state): State<DaemonIpcState>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let res = tokio::task::spawn_blocking(move || {
        let tracks = cache.list_all_liberation_tracks()?;
        Ok::<_, anyhow::Error>(compute_album_fragmentation_diagnostics(&tracks))
    })
    .await;

    match res {
        Ok(Ok(report)) => Json(serde_json::json!({ "ok": true, "data": report })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}
