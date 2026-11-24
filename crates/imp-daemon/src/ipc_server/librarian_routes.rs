use super::DaemonIpcState;
use axum::{
    extract::{ConnectInfo, Query, Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use imp_core::{
    factoids::PushFactoidsItem,
    library::{artwork::PushArtworkItem, db::TrackPropertiesPatch},
    lyrics::PushLyricsItem,
    sinks::apple::AppleMusicSink,
};
use imp_protocol::{AudioCommand, PlaybackEvent};
use serde::Deserialize;
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    path::Path,
};

fn is_loopback_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_loopback(),
        IpAddr::V6(v6) => {
            v6.is_loopback() || matches!(v6.segments(), [0, 0, 0, 0, 0, 0xffff, a, _] if (a >> 8) == 127)
        }
    }
}

pub(super) async fn require_loopback_middleware(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    if !is_loopback_ip(addr.ip()) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({
                "ok": false,
                "error": "Librarian companion routes are restricted to loopback (127.0.0.1 / ::1)"
            })),
        )
            .into_response();
    }
    next.run(req).await
}

pub(super) fn librarian_router() -> Router<DaemonIpcState> {
    Router::new()
        .route("/capabilities", get(librarian_capabilities_handler))
        .route("/cache-status", get(librarian_cache_status_handler))
        .route("/push-lyrics", post(librarian_push_lyrics_handler))
        .route("/push-factoids", post(librarian_push_factoids_handler))
        .route("/push-artwork", post(librarian_push_artwork_handler))
        .route("/apple-auth", get(librarian_apple_auth_handler))
        .layer(middleware::from_fn(require_loopback_middleware))
}

async fn librarian_capabilities_handler() -> impl IntoResponse {
    Json(serde_json::json!({
        "ok": true,
        "bridge_version": 2,
        "imp_version": env!("CARGO_PKG_VERSION"),
        "data_dir": imp_core::imp_data_dir().to_string_lossy().to_string(),
        "art_cache_dir": imp_core::imp_art_cache_dir().to_string_lossy().to_string(),
        "features": [
            "index_snapshot_v1",
            "refresh_paths_v1",
            "cache_status_v2",
            "push_lyrics_v2",
            "push_factoids_v2",
            "push_artwork_v2",
            "apple_auth_handoff_v2",
            "pending_enrichment_queue_v2"
        ]
    }))
}

fn dir_file_count_and_bytes(dir: &Path) -> (usize, u64) {
    let mut file_count = 0usize;
    let mut total_bytes = 0u64;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            if let Ok(meta) = entry.metadata() {
                if meta.is_file() {
                    file_count += 1;
                    total_bytes = total_bytes.saturating_add(meta.len());
                }
            }
        }
    }
    (file_count, total_bytes)
}

async fn librarian_cache_status_handler(
    State(state): State<DaemonIpcState>,
    Query(params): Query<HashMap<String, String>>,
) -> impl IntoResponse {
    let include_missing_uris = params
        .get("include_missing_uris")
        .map(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false);
    let limit = params
        .get("limit")
        .and_then(|v| v.trim().parse::<usize>().ok())
        .unwrap_or(2000)
        .clamp(1, 20_000);

    let db = state.db.clone();
    let services_cache = state.services_cache.clone();
    let res = tokio::task::spawn_blocking(move || -> anyhow::Result<serde_json::Value> {
        let audit = db.get_librarian_cache_audit(include_missing_uris, limit)?;
        let (lyrics_entries_count, factoid_entries_count) =
            imp_core::lyrics::count_lyrics_and_factoid_entries();

        let now_unix = imp_core::library::services_cache::current_unix_sec();
        let cached_shelves = services_cache.list_cached_shelves(None).unwrap_or_default();
        let cached_shelves_count = cached_shelves.len();
        let stale_shelves_count = cached_shelves
            .iter()
            .filter(|s| s.is_stale(now_unix))
            .count();
        let fyp_shelves_count = services_cache
            .list_fyp_shelves()
            .map(|v| v.len())
            .unwrap_or(0);

        let art_dir = imp_core::imp_art_cache_dir();
        let (art_file_count, art_total_bytes) = dir_file_count_and_bytes(&art_dir);

        let mut payload = serde_json::json!({
            "ok": true,
            "library": {
                "total_albums": audit.total_albums,
                "total_tracks": audit.total_tracks,
                "local_tracks": audit.local_tracks,
                "has_art_count": audit.has_art_count,
                "missing_art_count": audit.missing_art_count,
                "has_lyrics_count": audit.has_lyrics_count,
                "has_synced_lyrics_count": audit.has_synced_lyrics_count,
                "has_factoids_count": audit.has_factoids_count,
                "mb_art_negative_cache_count": audit.mb_art_negative_cache_count,
            },
            "lyrics_db": {
                "lyrics_entries_count": lyrics_entries_count,
                "factoid_entries_count": factoid_entries_count,
            },
            "services_cache": {
                "cached_shelves_count": cached_shelves_count,
                "stale_shelves_count": stale_shelves_count,
                "fyp_shelves_count": fyp_shelves_count,
            },
            "art_cache": {
                "file_count": art_file_count,
                "total_bytes": art_total_bytes,
            },
        });
        if let Some(missing) = audit.missing_uris {
            payload["missing_uris"] = serde_json::json!(missing);
        }
        Ok(payload)
    })
    .await;

    match res {
        Ok(Ok(payload)) => Json(payload),
        Ok(Err(e)) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
struct PushLyricsRequest {
    #[serde(default)]
    items: Vec<PushLyricsItem>,
}

async fn librarian_push_lyrics_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<PushLyricsRequest>,
) -> impl IntoResponse {
    let db = state.db.clone();
    let res = tokio::task::spawn_blocking(move || {
        let mut imported = 0usize;
        let mut failed = 0usize;
        for item in body.items {
            let uri = item.track_uri.trim().to_string();
            match imp_core::lyrics::import_cached_lyrics(&item) {
                Ok(resp) => {
                    if !uri.is_empty() {
                        let patch = TrackPropertiesPatch {
                            has_lyrics: Some(resp.found),
                            has_synced_lyrics: Some(!resp.synced_lines.is_empty()),
                            suppress_lyrics: Some(false),
                            ..Default::default()
                        };
                        if db.upsert_track_properties_patch(&uri, &patch).is_err() {
                            failed += 1;
                            continue;
                        }
                    }
                    imported += 1;
                }
                Err(_) => {
                    failed += 1;
                }
            }
        }
        serde_json::json!({
            "ok": true,
            "imported": imported,
            "failed": failed,
        })
    })
    .await;

    match res {
        Ok(payload) => Json(payload),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
struct PushFactoidsRequest {
    #[serde(default)]
    items: Vec<PushFactoidsItem>,
}

async fn librarian_push_factoids_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<PushFactoidsRequest>,
) -> impl IntoResponse {
    let db = state.db.clone();
    let res = tokio::task::spawn_blocking(move || {
        let mut imported = 0usize;
        let mut failed = 0usize;
        for item in body.items {
            let uri = item.track_uri.trim().to_string();
            match imp_core::factoids::import_cached_factoids(&item) {
                Ok(resp) => {
                    if !uri.is_empty() {
                        let patch = TrackPropertiesPatch {
                            has_factoids: Some(resp.found),
                            suppress_factoids: Some(false),
                            ..Default::default()
                        };
                        if db.upsert_track_properties_patch(&uri, &patch).is_err() {
                            failed += 1;
                            continue;
                        }
                    }
                    imported += 1;
                }
                Err(_) => {
                    failed += 1;
                }
            }
        }
        serde_json::json!({
            "ok": true,
            "imported": imported,
            "failed": failed,
        })
    })
    .await;

    match res {
        Ok(payload) => Json(payload),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

#[derive(Debug, Deserialize)]
struct PushArtworkRequest {
    #[serde(default)]
    items: Vec<PushArtworkItem>,
}

async fn librarian_push_artwork_handler(
    State(state): State<DaemonIpcState>,
    Json(body): Json<PushArtworkRequest>,
) -> impl IntoResponse {
    let db = state.db.clone();
    let cmd_tx = state.cmd_tx.clone();
    let bcast = state.broadcast_tx.clone();
    let res = tokio::task::spawn_blocking(move || {
        let mut imported = 0usize;
        let mut art_urls = Vec::new();
        for item in body.items {
            if let Ok(result) = imp_core::library::artwork::import_cached_artwork(&db, &item) {
                for (uri, album_title) in &result.updated_tracks {
                    let _ = cmd_tx.send(AudioCommand::RefreshTrackArtwork {
                        uri: uri.clone(),
                        album_title: album_title.clone(),
                        art_url: Some(result.http_art_url.clone()),
                    });
                }
                art_urls.push(result.http_art_url);
                imported += 1;
            }
        }
        if imported > 0 {
            if let Ok((total_albums, total_tracks)) = db.get_library_counts() {
                let _ = bcast.send(PlaybackEvent::LibraryUpdated {
                    total_albums,
                    total_tracks,
                });
            }
        }
        serde_json::json!({
            "ok": true,
            "imported": imported,
            "art_urls": art_urls,
        })
    })
    .await;

    match res {
        Ok(payload) => Json(payload),
        Err(e) => Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
    }
}

async fn librarian_apple_auth_handler(State(state): State<DaemonIpcState>) -> impl IntoResponse {
    let cfg = state.settings.lock().unwrap().clone();
    let creds = AppleMusicSink::resolve_credentials(&cfg);
    let developer_token = AppleMusicSink::get_or_sign_developer_token(&cfg).ok();
    let music_user_token = creds.music_user_token;
    let has_custom_p8 = creds.private_key_pem.is_some();
    let enabled = cfg.services.apple_music_enabled
        || developer_token.is_some()
        || music_user_token.is_some();

    Json(serde_json::json!({
        "ok": true,
        "enabled": enabled,
        "developer_token": developer_token,
        "music_user_token": music_user_token,
        "has_custom_p8": has_custom_p8,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use imp_core::{
        library::{db::LibraryDatabase, services_cache::ServicesCacheDatabase},
        orchestrator::OrchestratorSnapshot,
    };
    use imp_protocol::SimpSettings;
    use std::io::{Read, Write};
    use std::sync::{atomic::AtomicUsize, Arc, Mutex};
    use tokio::sync::{broadcast, mpsc};

    fn test_b64_encode(bytes: &[u8]) -> String {
        const TABLE: &[u8; 64] =
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::with_capacity((bytes.len() + 2) / 3 * 4);
        for chunk in bytes.chunks(3) {
            let b0 = chunk[0] as usize;
            let b1 = *chunk.get(1).unwrap_or(&0) as usize;
            let b2 = *chunk.get(2).unwrap_or(&0) as usize;
            let n = (b0 << 16) | (b1 << 8) | b2;
            out.push(TABLE[(n >> 18) & 63] as char);
            out.push(TABLE[(n >> 12) & 63] as char);
            out.push(if chunk.len() > 1 { TABLE[(n >> 6) & 63] as char } else { '=' });
            out.push(if chunk.len() > 2 { TABLE[n & 63] as char } else { '=' });
        }
        out
    }

    fn test_ipc_state(root: &Path) -> DaemonIpcState {
        std::fs::create_dir_all(root).unwrap();
        let db = LibraryDatabase::open(&root.join("library.db")).unwrap();
        let services_cache = ServicesCacheDatabase::open(&root.join("servicesCache.db")).unwrap();
        let settings = Arc::new(Mutex::new(SimpSettings::default()));
        let orchestrator_state = Arc::new(Mutex::new(OrchestratorSnapshot {
            active_engine: imp_protocol::ActiveEngine::None,
            is_playing: false,
            position_ms: 0,
            volume: 0.8,
            shuffle: false,
            repeat_mode: imp_protocol::RepeatMode::Off,
            current_track: None,
            queue: Vec::new(),
            queue_index: 0,
            apple_authenticated: false,
            soundcloud_authenticated: false,
            internet_archive_authenticated: true,
            brightness_pct: 100,
        }));
        let (cmd_tx, _cmd_rx) = mpsc::unbounded_channel();
        let (broadcast_tx, _bcast_rx) = broadcast::channel(16);
        DaemonIpcState {
            db,
            services_cache,
            settings,
            orchestrator_state,
            cmd_tx,
            broadcast_tx,
            connected_clients: Arc::new(AtomicUsize::new(0)),
        }
    }

    fn send_http_get(addr: SocketAddr, path: &str, extra_headers: &str) -> String {
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:18888\r\n{extra_headers}Connection: close\r\n\r\n"
        );
        stream.write_all(req.as_bytes()).unwrap();
        let mut buf = String::new();
        stream.read_to_string(&mut buf).unwrap();
        buf
    }

    #[tokio::test]
    async fn test_librarian_routes_enforce_loopback_only_connect_info() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("imp_librarian_loopback_{nanos}"));
        let state = test_ipc_state(&root);

        // 1. Loopback peer (real 127.0.0.1 TCP socket) succeeds with 200 OK
        let loopback_app = Router::new()
            .nest("/api/librarian", librarian_router())
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let loopback_addr = listener.local_addr().unwrap();
        let srv1 = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                loopback_app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        let caps_resp = tokio::task::spawn_blocking(move || {
            send_http_get(loopback_addr, "/api/librarian/capabilities", "")
        })
        .await
        .unwrap();
        assert!(caps_resp.starts_with("HTTP/1.1 200 OK"), "{caps_resp}");
        assert!(caps_resp.contains("\"bridge_version\":2"), "{caps_resp}");

        let auth_ok = tokio::task::spawn_blocking(move || {
            send_http_get(loopback_addr, "/api/librarian/apple-auth", "")
        })
        .await
        .unwrap();
        assert!(auth_ok.starts_with("HTTP/1.1 200 OK"), "{auth_ok}");
        srv1.abort();

        // 2. Non-loopback peer (192.168.1.50:55555) is rejected with 403 even with spoofed Host / X-Forwarded-For
        async fn inject_lan_connect_info(mut req: Request, next: Next) -> Response {
            req.extensions_mut()
                .insert(ConnectInfo(SocketAddr::from(([192, 168, 1, 50], 55555))));
            next.run(req).await
        }

        let lan_sim_app = Router::new()
            .nest(
                "/api/librarian",
                librarian_router().layer(middleware::from_fn(inject_lan_connect_info)),
            )
            .with_state(state);
        let listener2 = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let lan_addr = listener2.local_addr().unwrap();
        let srv2 = tokio::spawn(async move {
            let _ = axum::serve(
                listener2,
                lan_sim_app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        let denied = tokio::task::spawn_blocking(move || {
            send_http_get(
                lan_addr,
                "/api/librarian/apple-auth",
                "X-Forwarded-For: 127.0.0.1\r\n",
            )
        })
        .await
        .unwrap();
        assert!(denied.starts_with("HTTP/1.1 403 Forbidden"), "{denied}");
        assert!(denied.contains("restricted to loopback"), "{denied}");

        srv2.abort();
        let _ = std::fs::remove_dir_all(&root);
    }

    fn send_http_post(addr: SocketAddr, path: &str, json_body: &str) -> String {
        let mut stream = std::net::TcpStream::connect(addr).unwrap();
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(3)))
            .unwrap();
        let req = format!(
            "POST {path} HTTP/1.1\r\nHost: 127.0.0.1:18888\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            json_body.len(),
            json_body
        );
        stream.write_all(req.as_bytes()).unwrap();
        let mut buf = String::new();
        stream.read_to_string(&mut buf).unwrap();
        buf
    }

    fn seed_test_track(
        db: &LibraryDatabase,
        album_id: &str,
        track_uri: &str,
        title: &str,
        mount_root: Option<&str>,
    ) {
        db.upsert_indexed_batch(&[imp_core::library::db::IndexedTrackBatchItem {
            album_id: album_id.to_string(),
            album_title: "Sample Album".to_string(),
            album_artist: "Sample Artist".to_string(),
            steam_app_id: None,
            release_year: Some(2025),
            art_cache_path: None,
            genre: None,
            parent_folder: None,
            track: imp_protocol::TrackMetadata {
                uri: track_uri.to_string(),
                title: title.to_string(),
                artists: vec!["Sample Artist".to_string()],
                album: "Sample Album".to_string(),
                album_id: Some(album_id.to_string()),
                track_number: Some(1),
                disc_number: Some(1),
                art_url: None,
                duration_ms: 214_000,
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

    #[tokio::test]
    async fn test_librarian_push_endpoints_and_cache_status_roundtrip() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("imp_librarian_push_{nanos}"));
        let state = test_ipc_state(&root);

        let album_id = format!("alb_push_{nanos}");
        let track_uri = format!("file:///Volumes/Music/SampleArtist/{nanos}_song.flac");
        let title = format!("Sample Push Song {nanos}");
        seed_test_track(&state.db, &album_id, &track_uri, &title, None);

        let app = Router::new()
            .nest("/api/librarian", librarian_router())
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let srv = tokio::spawn(async move {
            let _ = axum::serve(
                listener,
                app.into_make_service_with_connect_info::<SocketAddr>(),
            )
            .await;
        });

        let lyrics_body = serde_json::json!({
            "items": [{
                "track_uri": track_uri,
                "title": title,
                "artist": "Sample Artist",
                "album": "Sample Album",
                "duration_ms": 214000,
                "synced_lines": [{ "timestamp_ms": 12450, "text": "Line one" }],
                "plain_lyrics": "Line one",
                "instrumental": false,
                "provider": "lrclib_v2",
                "lrclib_id": 999
            }]
        })
        .to_string();
        let lyr_res = tokio::task::spawn_blocking(move || {
            send_http_post(addr, "/api/librarian/push-lyrics", &lyrics_body)
        })
        .await
        .unwrap();
        assert!(lyr_res.starts_with("HTTP/1.1 200 OK"), "{lyr_res}");
        assert!(lyr_res.contains("\"imported\":1"), "{lyr_res}");

        let factoids_body = serde_json::json!({
            "items": [{
                "track_uri": track_uri,
                "title": title,
                "artist": "Sample Artist",
                "album": "Sample Album",
                "provider": "wikipedia_v2+librarian",
                "bubbles": [{
                    "category": "recording",
                    "headline": "Live Take",
                    "body": format!("Factoid {nanos} captured during live session."),
                    "source": "Wikipedia",
                    "start_sec": 24,
                    "duration_sec": 12,
                    "part_index": 1,
                    "part_total": 1
                }]
            }]
        })
        .to_string();
        let fac_res = tokio::task::spawn_blocking(move || {
            send_http_post(addr, "/api/librarian/push-factoids", &factoids_body)
        })
        .await
        .unwrap();
        assert!(fac_res.starts_with("HTTP/1.1 200 OK"), "{fac_res}");
        assert!(fac_res.contains("\"imported\":1"), "{fac_res}");

        let mut fake_png = vec![0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n'];
        fake_png.extend_from_slice(&nanos.to_le_bytes());
        fake_png.resize(300, 0x55);
        let art_body = serde_json::json!({
            "items": [{
                "album_id": album_id,
                "track_uris": [track_uri],
                "image_base64": test_b64_encode(&fake_png),
                "mime_type": "image/png",
                "source": "coverartarchive"
            }]
        })
        .to_string();
        let art_res = tokio::task::spawn_blocking(move || {
            send_http_post(addr, "/api/librarian/push-artwork", &art_body)
        })
        .await
        .unwrap();
        assert!(art_res.starts_with("HTTP/1.1 200 OK"), "{art_res}");
        assert!(art_res.contains("\"imported\":1"), "{art_res}");
        assert!(art_res.contains("simp_art_lib_"), "{art_res}");

        let status_res = tokio::task::spawn_blocking(move || {
            send_http_get(
                addr,
                "/api/librarian/cache-status?include_missing_uris=true&limit=100",
                "",
            )
        })
        .await
        .unwrap();
        assert!(status_res.starts_with("HTTP/1.1 200 OK"), "{status_res}");
        assert!(status_res.contains("\"has_lyrics_count\":1"), "{status_res}");
        assert!(
            status_res.contains("\"has_synced_lyrics_count\":1"),
            "{status_res}"
        );
        assert!(
            status_res.contains("\"has_factoids_count\":1"),
            "{status_res}"
        );
        assert!(status_res.contains("\"has_art_count\":1"), "{status_res}");
        assert!(status_res.contains("\"missing_uris\":"), "{status_res}");

        if let Some((_, Some(art_url), _)) = state.db.get_musicbrainz_art_cache(&album_id) {
            if let Some(fname) = art_url.rsplit('/').next() {
                let _ = std::fs::remove_file(imp_core::imp_art_cache_dir().join(fname));
                let _ = std::fs::remove_file(std::env::temp_dir().join(fname));
            }
        }
        srv.abort();
        let _ = std::fs::remove_dir_all(&root);
    }

    #[tokio::test]
    async fn test_refresh_paths_rejects_unmounted_volumes_stub_without_pruning() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("imp_smb_handler_{nanos}"));
        let volumes_root = root.join("Volumes");
        let stub_share = volumes_root.join("SmbMusic");
        std::fs::create_dir_all(&stub_share).unwrap();

        let state = test_ipc_state(&root);
        let offline_file = stub_share.join("SampleArtist").join("SampleAlbum").join("01.flac");
        let track_uri = format!("file://{}", offline_file.to_string_lossy());
        let share_str = stub_share.to_string_lossy().to_string();
        state
            .db
            .upsert_mount(&share_str, "SmbMusic", "user_custom", false)
            .unwrap();
        seed_test_track(&state.db, "alb_smb", &track_uri, "Track 01", Some(&share_str));

        let payload = super::super::library_routes::execute_refresh_paths_with_volumes_root(
            state.db.clone(),
            state.broadcast_tx.clone(),
            imp_core::library::indexer::PendingRefreshEntry {
                old_paths: vec![offline_file.to_string_lossy().to_string()],
                new_paths: vec![],
                fallback_root: Some(stub_share.to_string_lossy().to_string()),
            },
            volumes_root,
        )
        .await;

        assert_eq!(payload["ok"], false);
        assert_eq!(payload["error"], "mount_offline");
        assert_eq!(
            state.db.list_local_track_index_snapshot(None).unwrap().len(),
            1
        );

        let _ = std::fs::remove_dir_all(&root);
    }
}
