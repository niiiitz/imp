use super::DaemonIpcState;
use axum::{
    extract::{Query, State},
    response::IntoResponse,
    Json,
};
use imp_core::liberation::{
    apply_album_reunion_plan, build_album_reunion_plan, compute_album_fragmentation_diagnostics,
    get_cached_reunion_plan, global_liberation_controller, global_liberation_downloader,
    global_local_audit_controller, preflight_download, undo_reunion_journal,
};
use serde::Deserialize;
use std::path::PathBuf;

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

#[derive(Deserialize)]
pub(super) struct DownloadPreflightBody {
    dest_dir: String,
    #[serde(default = "default_download_scope")]
    scope: String,
}

fn default_download_scope() -> String {
    "uploaded_and_reclaimable".to_string()
}

pub(super) async fn liberation_download_preflight_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<DownloadPreflightBody>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let dest_dir = PathBuf::from(body.dest_dir.trim());
    let scope = body.scope;
    let res =
        tokio::task::spawn_blocking(move || preflight_download(&cache, &dest_dir, &scope)).await;
    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
pub(super) struct DownloadStartBody {
    dest_dir: String,
    #[serde(default = "default_download_scope")]
    scope: String,
    #[serde(default)]
    allow_partial_space: bool,
    #[serde(default)]
    max_tracks: Option<usize>,
}

pub(super) async fn liberation_download_start_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<DownloadStartBody>,
) -> impl IntoResponse {
    let cfg = snapshot_apple_settings(&state);
    let cache = state.services_cache.clone();
    let dest_dir = PathBuf::from(body.dest_dir.trim());
    let scope = body.scope;
    let allow_partial_space = body.allow_partial_space;
    let max_tracks = body.max_tracks;
    let res = tokio::task::spawn_blocking(move || {
        global_liberation_downloader().start(
            cfg,
            cache,
            dest_dir,
            scope,
            allow_partial_space,
            max_tracks,
        )
    })
    .await;
    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn liberation_download_pause_handler(
    State(state): State<DaemonIpcState>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let res = tokio::task::spawn_blocking(move || {
        let dl = global_liberation_downloader();
        dl.pause()?;
        dl.status(&cache)
    })
    .await;
    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn liberation_download_status_handler(
    State(state): State<DaemonIpcState>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let res =
        tokio::task::spawn_blocking(move || global_liberation_downloader().status(&cache)).await;
    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
pub(super) struct AuditStartBody {
    root_dir: String,
}

pub(super) async fn liberation_audit_start_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<AuditStartBody>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let root_dir = PathBuf::from(body.root_dir.trim());
    let res = tokio::task::spawn_blocking(move || {
        global_local_audit_controller().start(root_dir, cache)
    })
    .await;
    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

pub(super) async fn liberation_audit_pause_handler(
    State(state): State<DaemonIpcState>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let res = tokio::task::spawn_blocking(move || {
        let ctrl = global_local_audit_controller();
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

pub(super) async fn liberation_audit_status_handler(
    State(state): State<DaemonIpcState>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let res =
        tokio::task::spawn_blocking(move || global_local_audit_controller().status(&cache)).await;
    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
pub(super) struct AuditResultsQuery {
    #[serde(default)]
    root_dir: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    q: Option<String>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    offset: Option<usize>,
}

pub(super) async fn liberation_audit_results_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<AuditResultsQuery>,
) -> impl IntoResponse {
    let cache = state.services_cache.clone();
    let limit = params.limit.unwrap_or(50).clamp(1, 500);
    let offset = params.offset.unwrap_or(0);
    let root_dir = params.root_dir;
    let status = params.status;
    let q = params.q;
    let res = tokio::task::spawn_blocking(move || {
        cache.query_local_audit_records(
            root_dir.as_deref(),
            status.as_deref(),
            q.as_deref(),
            limit,
            offset,
        )
    })
    .await;
    match res {
        Ok(Ok((records, total))) => Json(serde_json::json!({
            "ok": true,
            "data": {
                "records": records,
                "total": total,
                "limit": limit,
                "offset": offset
            }
        })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
pub(super) struct ReunionPlanBody {
    root_dir: String,
    #[serde(default = "default_true")]
    use_apple_catalog: bool,
}

fn default_true() -> bool {
    true
}

pub(super) async fn liberation_reunion_plan_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<ReunionPlanBody>,
) -> impl IntoResponse {
    let cfg = snapshot_apple_settings(&state);
    let root_dir = PathBuf::from(body.root_dir.trim());
    let use_apple_catalog = body.use_apple_catalog;
    let res = tokio::task::spawn_blocking(move || {
        build_album_reunion_plan(Some(&cfg), &root_dir, use_apple_catalog)
    })
    .await;
    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
pub(super) struct ReunionApplyBody {
    plan_id: String,
    #[serde(default)]
    selected_item_ids: Vec<String>,
    #[serde(default = "default_true")]
    move_files: bool,
}

pub(super) async fn liberation_reunion_apply_handler(
    Json(body): Json<ReunionApplyBody>,
) -> impl IntoResponse {
    let res = tokio::task::spawn_blocking(move || {
        let plan = get_cached_reunion_plan(&body.plan_id)
            .ok_or_else(|| anyhow::anyhow!("Reunion plan expired or unknown; run Scan & Preview again"))?;
        apply_album_reunion_plan(&plan, &body.selected_item_ids, body.move_files)
    })
    .await;
    match res {
        Ok(Ok(data)) => Json(serde_json::json!({ "ok": true, "data": data })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Deserialize)]
pub(super) struct ReunionUndoBody {
    journal_path: String,
}

pub(super) async fn liberation_reunion_undo_handler(
    Json(body): Json<ReunionUndoBody>,
) -> impl IntoResponse {
    let journal_path = PathBuf::from(body.journal_path.trim());
    let res = tokio::task::spawn_blocking(move || undo_reunion_journal(&journal_path)).await;
    match res {
        Ok(Ok(restored)) => Json(serde_json::json!({ "ok": true, "data": { "restored": restored } })),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}
