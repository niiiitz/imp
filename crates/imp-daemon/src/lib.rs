pub mod config;
pub mod ipc_server;

use crate::config::{library_db_path, load_or_create_settings};
use crate::ipc_server::{run_ipc_server, DaemonIpcState};
use imp_core::{library::db::LibraryDatabase, orchestrator::AudioOrchestrator};
use imp_protocol::{AudioCommand, PlaybackEvent};
use std::sync::{atomic::AtomicUsize, Arc, Mutex};
use tokio::sync::{broadcast, mpsc};

/// Headless entrypoint for `simp --daemon`.
/// Initializes `.vdf` settings, SQLite `library.db`, detached OST/USB indexer,
/// `souvlaki` MPRIS2 D-Bus hook, `AudioOrchestrator`, and the `127.0.0.1:18888` IPC server.
pub async fn run_daemon() -> anyhow::Result<()> {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "imp_daemon=info,imp_core=info".into()),
        )
        .try_init();

    tracing::info!(
        "Starting Imp v{} (Interactive Media Player) headless daemon...",
        env!("CARGO_PKG_VERSION")
    );

    let settings = Arc::new(Mutex::new(load_or_create_settings()));
    {
        let cfg = settings.lock().unwrap();
        imp_core::set_online_retrieval_policy(imp_core::OnlineRetrievalPolicy {
            lyrics: cfg.provisioning.fetch_lyrics_online,
            artwork: cfg.provisioning.fetch_artwork_online,
            factoids: cfg.provisioning.fetch_factoids_online,
            disc_metadata: cfg.provisioning.fetch_disc_metadata_online,
            sc_comments: cfg.provisioning.fetch_sc_comments_online,
        });
    }
    let db_path = library_db_path();
    let db = LibraryDatabase::open(&db_path)?;
    let services_cache = imp_core::library::ServicesCacheDatabase::open(
        &crate::config::services_cache_db_path(),
    )?;

    let (cmd_tx, cmd_rx) = mpsc::unbounded_channel::<AudioCommand>();
    let (internal_event_tx, internal_event_rx) = mpsc::unbounded_channel::<PlaybackEvent>();
    let (broadcast_tx, _) = broadcast::channel::<PlaybackEvent>(256);

    let state_db = db.clone();
    let state_settings = settings.clone();
    let state_cmd_tx = cmd_tx.clone();
    let state_bcast_tx = broadcast_tx.clone();

    let (state_ready_tx, state_ready_rx) = tokio::sync::oneshot::channel();

    // 1. Spawn the dedicated Audio Orchestrator & MPRIS2 thread
    // (`rodio::OutputStream` and `souvlaki::MediaControls` own native OS handles and live on this thread)
    std::thread::Builder::new()
        .name("imp-audio-orchestrator".to_string())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .expect("Failed to build audio orchestrator runtime");

            rt.block_on(async move {
                let orchestrator = AudioOrchestrator::new(
                    state_db,
                    state_settings,
                    state_cmd_tx,
                    internal_event_tx,
                    state_bcast_tx,
                );
                let _ = state_ready_tx.send(orchestrator.state.clone());
                orchestrator.run_loop(cmd_rx, internal_event_rx).await;
            });
        })?;

    let orchestrator_state = state_ready_rx.await?;

    // 2. Spawn native KDE Plasma / FreeDesktop StatusNotifierItem system tray hook
    imp_core::tray::spawn_system_tray(orchestrator_state.clone(), cmd_tx.clone());

    // 2b. Spawn native Linux `/dev/input/js*` gamepad reader for standalone KDE windows
    imp_core::gamepad::spawn_linux_gamepad_reader(broadcast_tx.clone());

    // 2c. Spawn native OpenVR (`libopenvr_api.so`) dashboard & `.vrmanifest` overlay bridge for Steam Frame / SteamVR
    imp_core::vr_overlay::spawn_openvr_overlay_bridge(orchestrator_state.clone(), cmd_tx.clone());

    // 3. Only trigger automatic storage & Steam OST discovery on first run / onboarding.
    // On subsequent launches, prune any ignored/removed mounts from SQLite in-place without
    // re-discovering or re-crawling folders unless the user explicitly clicks Rescan or adds a path.
    let should_run_initial_scan = {
        let mut cfg = settings.lock().unwrap();
        imp_core::library::indexer::prune_ignored_and_stale_mounts(&db, &cfg);
        if cfg.library.initial_scan_completed {
            false
        } else {
            let has_existing_db_data = db
                .get_mounts()
                .map(|m| !m.is_empty())
                .unwrap_or(false)
                || db
                    .get_library_counts()
                    .map(|(albums, tracks)| albums > 0 || tracks > 0)
                    .unwrap_or(false);
            let has_user_customized_paths = !cfg.library.ignored_paths.is_empty();
            if has_existing_db_data || has_user_customized_paths {
                cfg.library.initial_scan_completed = true;
                let _ = crate::config::save_settings(&cfg);
                false
            } else {
                true
            }
        }
    };
    if should_run_initial_scan {
        let _ = cmd_tx.send(AudioCommand::RescanStorage);
    } else {
        // Lightweight non-blocking mount liveness check so mounts that went offline during a
        // previous outage automatically flip back to online on restart without walking files.
        let probe_db = db.clone();
        let probe_cfg = settings.lock().unwrap().clone();
        let probe_bcast = broadcast_tx.clone();
        tokio::task::spawn_blocking(move || {
            if imp_core::library::indexer::refresh_mount_online_states(&probe_db, &probe_cfg) {
                if let Ok(mounts) = probe_db.get_mounts() {
                    let _ = probe_bcast.send(PlaybackEvent::StorageMountsChanged { mounts });
                }
                let (total_albums, total_tracks) =
                    probe_db.get_library_counts().unwrap_or((0, 0));
                let _ = probe_bcast.send(PlaybackEvent::LibraryUpdated {
                    total_albums,
                    total_tracks,
                });
            }
        });
    }

    // Drain any offline path refreshes or pre-fetched enrichment bundles queued by `imp-librarian`
    {
        let drain_db = db.clone();
        let drain_bcast = broadcast_tx.clone();
        tokio::task::spawn_blocking(move || {
            let mut changed = false;
            let queue_path = imp_core::library::indexer::pending_refresh_queue_path();
            match imp_core::library::indexer::drain_pending_refresh_queue(&drain_db, &queue_path) {
                Ok(refreshed) if refreshed > 0 => {
                    tracing::info!(
                        "Drained {} pending local path update(s) from {}",
                        refreshed,
                        queue_path.display()
                    );
                    changed = true;
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!("Failed to drain {}: {e}", queue_path.display());
                }
            }

            let enrich_path = imp_core::library::indexer::pending_enrichment_queue_path();
            match imp_core::library::indexer::drain_pending_enrichment_queue(&drain_db, &enrich_path) {
                Ok(imported) if imported > 0 => {
                    tracing::info!(
                        "Drained {} pending enrichment item(s) from {}",
                        imported,
                        enrich_path.display()
                    );
                    changed = true;
                }
                Ok(_) => {}
                Err(e) => {
                    tracing::warn!("Failed to drain {}: {e}", enrich_path.display());
                }
            }

            if changed {
                if let Ok((total_albums, total_tracks)) = drain_db.get_library_counts() {
                    let _ = drain_bcast.send(PlaybackEvent::LibraryUpdated {
                        total_albums,
                        total_tracks,
                    });
                }
            }
        });
    }

    // 3. Run the local loopback WebSocket + Artwork HTTP server on 127.0.0.1:18888
    let ipc_state = DaemonIpcState {
        db,
        services_cache,
        settings,
        orchestrator_state,
        cmd_tx,
        broadcast_tx,
        connected_clients: Arc::new(AtomicUsize::new(0)),
    };

    run_ipc_server(ipc_state).await
}

