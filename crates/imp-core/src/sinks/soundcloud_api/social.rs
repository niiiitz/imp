use super::*;
use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use imp_protocol::SimpSettings;
use std::time::{Duration, Instant};

/// Fetches timestamped timed comments (`GET /tracks/{id}/comments`) for the ephemeral speech bubbles on `PlayerView`!
pub fn fetch_track_comments(
    settings: &SimpSettings,
    track_uri_or_id: &str,
) -> Result<Vec<SoundCloudComment>> {
    let track_id = clean_soundcloud_id(track_uri_or_id);
    if track_id.is_empty() {
        return Ok(Vec::new());
    }

    if let Ok(guard) = comments_cache().lock() {
        if let Some((fetched_at, cached)) = guard.get(&track_id) {
            if fetched_at.elapsed() < Duration::from_secs(600) {
                return Ok(cached.clone());
            }
        }
    }

    let url = format!(
        "/tracks/{}/comments?linked_partitioning=true&limit=200",
        url_encode_component(&track_id)
    );
    let json = soundcloud_authed_get(settings, &url)?;
    let mut comments = Vec::new();

    for item in extract_collection_items(&json) {
        let body = item
            .get("body")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if body.is_empty() || body.len() > 220 {
            continue;
        }
        let Some(ts) = item.get("timestamp").and_then(|v| v.as_u64()) else {
            continue;
        };
        let id = item
            .get("id")
            .and_then(|v| {
                v.as_u64()
                    .map(|n| n.to_string())
                    .or_else(|| v.as_str().map(|s| s.to_string()))
            })
            .unwrap_or_else(|| format!("{ts}-{}", comments.len()));
        let username = item
            .pointer("/user/username")
            .and_then(|v| v.as_str())
            .or_else(|| item.pointer("/user/full_name").and_then(|v| v.as_str()))
            .or_else(|| item.pointer("/user/permalink").and_then(|v| v.as_str()))
            .unwrap_or("")
            .trim()
            .to_string();
        if username.is_empty()
            || username.eq_ignore_ascii_case("listener")
            || username.eq_ignore_ascii_case("anonymous")
            || username.eq_ignore_ascii_case("unknown")
            || username.eq_ignore_ascii_case("deleted")
        {
            continue;
        }
        let avatar_url = item
            .pointer("/user/avatar_url")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty() && !s.contains("default_avatar"));
        let created_at = item
            .get("created_at")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        comments.push(SoundCloudComment {
            id,
            body,
            timestamp_ms: ts as u32,
            username,
            avatar_url,
            created_at,
        });
    }

    comments.sort_by_key(|c| c.timestamp_ms);

    if let Ok(mut guard) = comments_cache().lock() {
        if guard.len() > 64 {
            guard.clear();
        }
        guard.insert(track_id, (Instant::now(), comments.clone()));
    }

    Ok(comments)
}

/// Fetches and normalizes a SoundCloud track's amplitude waveform (`waveform_url`) into 96 normalized `0.0..=1.0` bars
/// for rendering inside `ProgressBarRaf`.
pub fn fetch_track_waveform(
    settings: &SimpSettings,
    track_uri_or_id: &str,
) -> Result<SoundCloudWaveform> {
    let track_id = clean_soundcloud_id(track_uri_or_id);
    if track_id.is_empty() {
        return Err(anyhow!("Empty track ID"));
    }

    if let Ok(guard) = waveform_cache().lock() {
        if let Some(cached) = guard.get(&track_id) {
            return Ok(cached.clone());
        }
    }

    let (
        mut wf_url,
        mut permalink_url,
        mut bpm,
        mut favoritings_count,
        mut playback_count,
        mut user_id,
        mut chapters,
    ) = track_hints()
        .lock()
        .ok()
        .and_then(|g| {
            g.get(&track_id).map(|e| {
                (
                    e.waveform_url.clone(),
                    e.permalink_url.clone(),
                    e.bpm,
                    e.favoritings_count,
                    e.playback_count,
                    e.user_id.clone(),
                    e.chapters.clone(),
                )
            })
        })
        .unwrap_or((None, None, None, None, None, None, Vec::new()));

    if wf_url.is_none() || permalink_url.is_none() || (chapters.is_empty() && user_id.is_none()) {
        if let Ok(json) = soundcloud_authed_get(
            settings,
            &format!("/tracks/{}", url_encode_component(&track_id)),
        ) {
            let _ = map_soundcloud_item_to_track(&json);
            if let Ok(g) = track_hints().lock() {
                if let Some(e) = g.get(&track_id) {
                    wf_url = e.waveform_url.clone();
                    permalink_url = e.permalink_url.clone();
                    bpm = e.bpm;
                    favoritings_count = e.favoritings_count;
                    playback_count = e.playback_count;
                    user_id = e.user_id.clone();
                    chapters = e.chapters.clone();
                }
            }
        }
    }

    let mut bars = Vec::new();
    if let Some(ref raw_url) = wf_url {
        let json_url = if raw_url.ends_with(".png") {
            format!("{}.json", &raw_url[..raw_url.len() - 4])
        } else {
            raw_url.clone()
        };
        if let Ok(bytes) = crate::http_pool::http_get_bytes(&json_url, &[], None, 8) {
            if let Ok(val) = serde_json::from_slice::<Value>(&bytes) {
                if let Some(samples) = val.get("samples").and_then(|v| v.as_array()) {
                    bars = downsample_waveform_samples(samples, crate::viz::DEFAULT_WAVEFORM_BARS);
                }
            }
        }
    }

    // Deterministic fallback silhouette if `wis.sndcdn.com` returned a PNG-only asset
    if bars.is_empty() {
        bars = crate::viz::synthesize_seeded_waveform_bars(
            &track_id,
            crate::viz::DEFAULT_WAVEFORM_BARS,
        );
    }

    let waveform = SoundCloudWaveform {
        track_id: track_id.clone(),
        bars,
        waveform_url: wf_url,
        permalink_url,
        bpm,
        favoritings_count,
        playback_count,
        user_id,
        chapters,
    };

    if let Ok(mut guard) = waveform_cache().lock() {
        if guard.len() > 128 {
            guard.clear();
        }
        guard.insert(track_id, waveform.clone());
    }

    Ok(waveform)
}

fn downsample_waveform_samples(raw_samples: &[Value], target_bars: usize) -> Vec<f32> {
    let vals: Vec<f32> = raw_samples
        .iter()
        .filter_map(|v| v.as_f64().map(|n| n as f32))
        .collect();
    crate::viz::downsample_peak_weighted_rms_f32(&vals, target_bars)
}

/// Likes (`POST /likes/tracks/{id}`) a SoundCloud track on the user's account.
pub fn like_soundcloud_track(settings: &SimpSettings, track_uri_or_id: &str) -> Result<()> {
    let track_id = clean_soundcloud_id(track_uri_or_id);
    if track_id.is_empty() {
        return Err(anyhow!("Invalid SoundCloud track ID"));
    }
    let token = ensure_valid_access_token(settings)?;
    let auth_header = format!("OAuth {}", token.trim());
    let url = format!(
        "https://api.soundcloud.com/likes/tracks/{}",
        url_encode_component(&track_id)
    );
    let _ = crate::http_pool::http_post_bytes(
        &url,
        &[
            ("Authorization", auth_header.as_str()),
            ("Accept", "application/json; charset=utf-8"),
        ],
        b"",
        10,
    )?;
    Ok(())
}

/// Unlikes (`DELETE /likes/tracks/{id}`) a SoundCloud track on the user's account.
pub fn unlike_soundcloud_track(settings: &SimpSettings, track_uri_or_id: &str) -> Result<()> {
    let track_id = clean_soundcloud_id(track_uri_or_id);
    if track_id.is_empty() {
        return Err(anyhow!("Invalid SoundCloud track ID"));
    }
    let token = ensure_valid_access_token(settings)?;
    let auth_header = format!("OAuth {}", token.trim());
    let url = format!(
        "https://api.soundcloud.com/likes/tracks/{}",
        url_encode_component(&track_id)
    );
    let _ = crate::http_pool::http_custom_bytes(
        "DELETE",
        &url,
        &[
            ("Authorization", auth_header.as_str()),
            ("Accept", "application/json; charset=utf-8"),
        ],
        None,
        10,
    )?;
    Ok(())
}

/// Likes (`POST /likes/playlists/{id}`) or unlikes (`DELETE /likes/playlists/{id}`) a SoundCloud Set/Playlist.
pub fn set_soundcloud_playlist_liked(
    settings: &SimpSettings,
    playlist_uri_or_id: &str,
    liked: bool,
) -> Result<()> {
    let playlist_id = clean_soundcloud_id(playlist_uri_or_id);
    if playlist_id.is_empty() || playlist_id.eq_ignore_ascii_case("likes") {
        return Ok(());
    }
    let token = ensure_valid_access_token(settings)?;
    let auth_header = format!("OAuth {}", token.trim());
    let url = format!(
        "https://api.soundcloud.com/likes/playlists/{}",
        url_encode_component(&playlist_id)
    );
    if liked {
        let _ = crate::http_pool::http_post_bytes(
            &url,
            &[
                ("Authorization", auth_header.as_str()),
                ("Accept", "application/json; charset=utf-8"),
            ],
            b"",
            10,
        )?;
    } else {
        let _ = crate::http_pool::http_custom_bytes(
            "DELETE",
            &url,
            &[
                ("Authorization", auth_header.as_str()),
                ("Accept", "application/json; charset=utf-8"),
            ],
            None,
            10,
        )?;
    }
    Ok(())
}

pub fn map_soundcloud_item_to_user(item: &Value) -> Option<SoundCloudUserSummary> {
    let obj = item.get("user").or_else(|| item.get("origin")).unwrap_or(item);
    let raw_id = if let Some(urn) = obj.get("urn").and_then(|v| v.as_str()) {
        clean_soundcloud_id(urn).trim_start_matches("users:").to_string()
    } else if let Some(id_num) = obj.get("id").and_then(|v| v.as_u64()) {
        id_num.to_string()
    } else if let Some(id_str) = obj.get("id").and_then(|v| v.as_str()) {
        clean_soundcloud_id(id_str).trim_start_matches("users:").to_string()
    } else {
        return None;
    };
    if raw_id.is_empty() {
        return None;
    }

    let username = obj
        .get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("SoundCloud Creator")
        .trim()
        .to_string();
    let urn = obj
        .get("urn")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("soundcloud:users:{raw_id}"));
    let avatar_url = format_soundcloud_art_url(
        obj.get("avatar_url").and_then(|v| v.as_str()),
    );
    let track_count = obj
        .get("track_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as usize;
    let followers_count = obj
        .get("followers_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let raw_desc = obj
        .get("description")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let description = if raw_desc.is_empty() {
        format!(
            "{} tracks • {} followers",
            track_count,
            format_compact_count(followers_count)
        )
    } else {
        raw_desc.lines().next().unwrap_or("").to_string()
    };

    let permalink_url = obj
        .get("permalink_url")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| s.starts_with("http://") || s.starts_with("https://"))
        .or_else(|| {
            obj.get("permalink")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .map(|slug| format!("https://soundcloud.com/{slug}"))
        });

    Some(SoundCloudUserSummary {
        id: raw_id,
        urn,
        username,
        avatar_url,
        track_count,
        followers_count,
        description,
        permalink_url,
    })
}

/// Resolves the canonical `https://soundcloud.com/...` `permalink_url` for a SoundCloud track,
/// playlist/set, or user profile, checking `TRACK_HINTS` first before querying SoundCloud API v1.
pub fn resolve_soundcloud_permalink_url(
    settings: &SimpSettings,
    kind: &str,
    raw_id: &str,
) -> String {
    let cleaned = clean_soundcloud_id(raw_id)
        .trim_start_matches("users:")
        .to_string();
    if cleaned.starts_with("https://soundcloud.com/") || cleaned.starts_with("http://soundcloud.com/") {
        return cleaned;
    }
    if cleaned.is_empty() {
        return "https://soundcloud.com".to_string();
    }

    let kind_norm = kind.trim().to_ascii_lowercase();
    if kind_norm == "track" || kind_norm.is_empty() {
        if let Ok(guard) = track_hints().lock() {
            if let Some(entry) = guard.get(&cleaned) {
                if let Some(ref url) = entry.permalink_url {
                    if !url.is_empty() {
                        return url.clone();
                    }
                }
            }
        }
        if let Ok(json) = soundcloud_authed_get(
            settings,
            &format!("/tracks/{}", url_encode_component(&cleaned)),
        ) {
            let _ = map_soundcloud_item_to_track(&json);
            if let Some(u) = json
                .get("permalink_url")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| s.starts_with("http"))
            {
                return u.to_string();
            }
        }
    } else if kind_norm == "playlist" || kind_norm == "set" {
        if cleaned.eq_ignore_ascii_case("likes") {
            return "https://soundcloud.com/you/likes".to_string();
        }
        if let Ok(json) = soundcloud_authed_get(
            settings,
            &format!("/playlists/{}", url_encode_component(&cleaned)),
        ) {
            if let Some(u) = json
                .get("permalink_url")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| s.starts_with("http"))
            {
                return u.to_string();
            }
        }
    } else if kind_norm == "user" || kind_norm == "artist" || kind_norm == "creator" {
        if !cleaned.chars().all(|c| c.is_ascii_digit()) {
            return format!("https://soundcloud.com/{}", url_encode_component(&cleaned));
        }
        if let Ok(json) = soundcloud_authed_get(
            settings,
            &format!("/users/{}", url_encode_component(&cleaned)),
        ) {
            if let Some(u) = json
                .get("permalink_url")
                .and_then(|v| v.as_str())
                .map(|s| s.trim())
                .filter(|s| s.starts_with("http"))
            {
                return u.to_string();
            }
        }
    }

    "https://soundcloud.com".to_string()
}

/// Fetches the creators/DJs followed by the authenticated SoundCloud user (`GET /me/followings`).
pub fn fetch_user_followings(settings: &SimpSettings) -> Result<Vec<SoundCloudUserSummary>> {
    let json = soundcloud_authed_get(
        settings,
        "/me/followings?limit=100&linked_partitioning=true",
    )?;
    let mut users = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for item in extract_collection_items(&json) {
        if let Some(u) = map_soundcloud_item_to_user(item) {
            if seen.insert(u.id.clone()) {
                users.push(u);
            }
        }
    }
    Ok(users)
}

/// Fetches a SoundCloud creator's uploaded tracks (`GET /users/{id}/tracks` with pagination),
/// sets/albums (`GET /users/{id}/playlists`), liked tracks (`GET /users/{id}/likes/tracks`),
/// and followed artists (`GET /users/{id}/followings`).
/// Also supports resolving by artist name if `user_id_or_urn` is non-numeric or prefixed with `name:`.
pub fn fetch_user_profile_tracks(
    settings: &SimpSettings,
    user_id_or_urn: &str,
) -> Result<SoundCloudUserProfileResponse> {
    let signed_in = is_soundcloud_user_signed_in(settings);
    let access_q = access_param_for_session(settings);

    let mut clean_uid = clean_soundcloud_id(user_id_or_urn)
        .trim_start_matches("users:")
        .trim()
        .to_string();
    if clean_uid.is_empty() {
        return Err(anyhow!("Empty SoundCloud user ID"));
    }

    let mut user: Option<SoundCloudUserSummary> = None;

    // If caller passed a username / artist name instead of a numeric SoundCloud user ID, resolve via `/users?q=...`
    let is_name_lookup = clean_uid.starts_with("name:")
        || !clean_uid.chars().all(|c| c.is_ascii_digit());
    if is_name_lookup {
        let name_q = clean_uid.trim_start_matches("name:").trim();
        let search_u = format!(
            "/users?q={}&limit=5&linked_partitioning=true",
            url_encode_component(name_q)
        );
        if let Ok(u_json) = soundcloud_authed_get(settings, &search_u) {
            let candidates: Vec<SoundCloudUserSummary> = extract_collection_items(&u_json)
                .into_iter()
                .filter_map(map_soundcloud_item_to_user)
                .collect();
            if let Some(matched) = candidates
                .iter()
                .find(|u| u.username.eq_ignore_ascii_case(name_q))
                .or_else(|| candidates.first())
            {
                clean_uid = matched.id.clone();
                user = Some(matched.clone());
            }
        }
    }

    let encoded_uid = url_encode_component(&clean_uid);
    if user.is_none() {
        user = soundcloud_authed_get(settings, &format!("/users/{encoded_uid}"))
            .ok()
            .and_then(|v| map_soundcloud_item_to_user(&v));
    }

    // Fetch up to 2 pages of `/users/{id}/tracks` initially (up to 200 tracks instead of 20!) and retain `next_tracks_href`
    let mut tracks = Vec::new();
    let mut seen_track_uris = std::collections::HashSet::new();
    let mut gated_track_count: usize = 0;
    let mut gated_playlist_count: usize = 0;
    let mut next_tracks_href = Some(format!(
        "/users/{encoded_uid}/tracks?limit=100&access={access_q}&linked_partitioning=true"
    ));
    for _ in 0..2 {
        let Some(ref page_url) = next_tracks_href else {
            break;
        };
        let Ok(t_json) = soundcloud_authed_get(settings, page_url) else {
            next_tracks_href = None;
            break;
        };
        for item in extract_collection_items(&t_json) {
            if let Some(t) = map_soundcloud_item_to_track(item) {
                if should_keep_track_for_session(&t, signed_in) {
                    if seen_track_uris.insert(t.uri.clone()) {
                        tracks.push(t);
                    }
                } else {
                    gated_track_count = gated_track_count.saturating_add(1);
                }
            } else {
                gated_track_count = gated_track_count.saturating_add(1);
            }
        }
        next_tracks_href = extract_next_href(&t_json);
    }

    let mut playlists = Vec::new();
    let mut seen_playlist_ids = std::collections::HashSet::new();
    if let Ok(p_json) = soundcloud_authed_get(
        settings,
        &format!(
            "/users/{encoded_uid}/playlists?limit=50&show_tracks=true&access={access_q}&linked_partitioning=true"
        ),
    ) {
        for item in extract_collection_items(&p_json) {
            let obj = item.get("playlist").or_else(|| item.get("origin")).unwrap_or(item);
            let reported_pl_tracks = obj
                .get("track_count")
                .and_then(|v| v.as_u64())
                .map(|n| n as usize)
                .unwrap_or(0);
            if let Some(mut pl) = map_soundcloud_item_to_playlist(item, "catalog_set") {
                if should_keep_playlist_for_session(&mut pl, signed_in) {
                    if seen_playlist_ids.insert(pl.id.clone()) {
                        gated_track_count = gated_track_count.saturating_add(pl.gated_track_count);
                        playlists.push(pl);
                    }
                } else {
                    gated_playlist_count = gated_playlist_count.saturating_add(1);
                    gated_track_count = gated_track_count.saturating_add(reported_pl_tracks.max(1));
                }
            } else if reported_pl_tracks > 0 {
                gated_playlist_count = gated_playlist_count.saturating_add(1);
                gated_track_count = gated_track_count.saturating_add(reported_pl_tracks);
            }
        }
    }

    // Also compare against `user.track_count` when all pages of `/users/{id}/tracks` were loaded
    if next_tracks_href.is_none() {
        if let Some(ref u) = user {
            if u.track_count > tracks.len() {
                let missing_from_profile = u.track_count.saturating_sub(tracks.len());
                if missing_from_profile > gated_track_count {
                    gated_track_count = missing_from_profile;
                }
            }
        }
    }

    // When API v2 mode is enabled, also fetch the creator's full v2 tracks, albums, and sets so
    // distributor-monetized releases (`policy: MONETIZE` / `AD_SUPPORTED`) appear with full track counts.
    if is_soundcloud_v2_enabled(settings) {
        if let Ok(v2_tracks) = soundcloud_v2_get_json(&format!(
            "/users/{encoded_uid}/tracks?representation=full&limit=100"
        )) {
            for item in extract_collection_items(&v2_tracks) {
                if let Some(t) = map_soundcloud_item_to_track(item) {
                    if should_keep_track_for_session(&t, signed_in)
                        && seen_track_uris.insert(t.uri.clone())
                    {
                        tracks.push(t);
                    }
                }
            }
        }
        for v2_pl_endpoint in [
            format!("/users/{encoded_uid}/albums?representation=full&limit=50"),
            format!("/users/{encoded_uid}/playlists_without_albums?representation=full&limit=50"),
        ] {
            if let Ok(v2_pl_json) = soundcloud_v2_get_json(&v2_pl_endpoint) {
                for item in extract_collection_items(&v2_pl_json) {
                    if let Some(mut pl) = map_soundcloud_item_to_playlist(item, "catalog_set") {
                        if should_keep_playlist_for_session(&mut pl, signed_in) {
                            if let Some(existing) = playlists.iter_mut().find(|e| e.id == pl.id) {
                                if pl.track_count > existing.track_count {
                                    *existing = pl;
                                }
                            } else if seen_playlist_ids.insert(pl.id.clone()) {
                                playlists.push(pl);
                            }
                        }
                    }
                }
            }
        }
    }

    // Fetch what this artist likes (`GET /users/{id}/likes/tracks`) for rabbit-hole discovery
    let mut liked_tracks = Vec::new();
    if let Ok(l_json) = soundcloud_authed_get(
        settings,
        &format!(
            "/users/{encoded_uid}/likes/tracks?limit=40&access={access_q}&linked_partitioning=true"
        ),
    ) {
        for item in extract_collection_items(&l_json) {
            if let Some(t) = map_soundcloud_item_to_track(item) {
                if should_keep_track_for_session(&t, signed_in) {
                    liked_tracks.push(t);
                }
            }
        }
    }

    // Fetch who this artist follows (`GET /users/{id}/followings`) to step artist-to-artist
    let mut followings = Vec::new();
    let mut seen_f = std::collections::HashSet::new();
    if let Ok(f_json) = soundcloud_authed_get(
        settings,
        &format!("/users/{encoded_uid}/followings?limit=40&linked_partitioning=true"),
    ) {
        for item in extract_collection_items(&f_json) {
            if let Some(u) = map_soundcloud_item_to_user(item) {
                if seen_f.insert(u.id.clone()) {
                    followings.push(u);
                }
            }
        }
    }

    Ok(SoundCloudUserProfileResponse {
        user,
        tracks,
        playlists,
        liked_tracks,
        followings,
        next_tracks_href,
        gated_track_count,
        gated_playlist_count,
    })
}

/// Follows a SoundCloud `next_href` pagination cursor and maps the next page of tracks or playlists.
pub fn fetch_soundcloud_next_page(
    settings: &SimpSettings,
    next_href: &str,
) -> Result<SoundCloudPaginateResponse> {
    let trimmed = next_href.trim();
    if trimmed.is_empty() {
        return Ok(SoundCloudPaginateResponse {
            tracks: Vec::new(),
            playlists: Vec::new(),
            next_href: None,
        });
    }
    let signed_in = is_soundcloud_user_signed_in(settings);
    let json = soundcloud_authed_get(settings, trimmed)?;
    let next_cursor = extract_next_href(&json);
    let mut tracks = Vec::new();
    let mut playlists = Vec::new();
    for item in extract_collection_items(&json) {
        let origin = item.get("origin").unwrap_or(item);
        let kind = origin.get("kind").and_then(|v| v.as_str()).unwrap_or("track");
        if kind == "playlist" {
            if let Some(mut pl) = map_soundcloud_item_to_playlist(origin, "catalog_set") {
                if should_keep_playlist_for_session(&mut pl, signed_in) {
                    playlists.push(pl);
                }
            }
        } else if let Some(t) = map_soundcloud_item_to_track(item) {
            if should_keep_track_for_session(&t, signed_in) {
                tracks.push(t);
            }
        }
    }
    Ok(SoundCloudPaginateResponse {
        tracks,
        playlists,
        next_href: next_cursor,
    })
}

/// Follows (`PUT /me/followings/{user_id}`) or unfollows (`DELETE /me/followings/{user_id}`) a SoundCloud creator.
pub fn set_soundcloud_user_followed(
    settings: &SimpSettings,
    user_id_or_urn: &str,
    follow: bool,
) -> Result<()> {
    let clean_uid = clean_soundcloud_id(user_id_or_urn)
        .trim_start_matches("users:")
        .trim()
        .to_string();
    if clean_uid.is_empty() {
        return Err(anyhow!("Invalid SoundCloud user ID"));
    }
    let token = ensure_valid_access_token(settings)?;
    let auth_header = format!("OAuth {}", token.trim());
    let url = format!(
        "https://api.soundcloud.com/me/followings/{}",
        url_encode_component(&clean_uid)
    );
    let method = if follow { "PUT" } else { "DELETE" };
    let _ = crate::http_pool::http_custom_bytes(
        method,
        &url,
        &[
            ("Authorization", auth_header.as_str()),
            ("Accept", "application/json; charset=utf-8"),
        ],
        if follow { Some(b"") } else { None },
        10,
    )?;
    Ok(())
}

/// Appends tracks to an owned SoundCloud User Set (`PUT /playlists/{id}`) by merging the
/// existing set tracks with the new track IDs.
pub fn add_tracks_to_soundcloud_set(
    settings: &SimpSettings,
    playlist_id_or_uri: &str,
    track_uris_or_ids: &[String],
) -> Result<Vec<TrackMetadata>> {
    let playlist_id = clean_soundcloud_id(playlist_id_or_uri);
    if playlist_id.is_empty() || playlist_id.eq_ignore_ascii_case("likes") {
        return Err(anyhow!("Invalid SoundCloud Set ID"));
    }
    let token = ensure_valid_access_token(settings)?;
    let auth_header = format!("OAuth {}", token.trim());

    let existing_json = soundcloud_authed_get(
        settings,
        &format!("/playlists/{}?representation=full", url_encode_component(&playlist_id)),
    )?;
    let mut track_objs: Vec<Value> = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();

    if let Some(arr) = existing_json.get("tracks").and_then(|v| v.as_array()) {
        for item in arr {
            let cid = if let Some(n) = item.get("id").and_then(|v| v.as_u64()) {
                n.to_string()
            } else if let Some(s) = item.get("urn").and_then(|v| v.as_str()) {
                clean_soundcloud_id(s)
            } else {
                String::new()
            };
            if !cid.is_empty() && seen_ids.insert(cid.clone()) {
                if let Ok(num) = cid.parse::<u64>() {
                    track_objs.push(serde_json::json!({ "id": num }));
                } else {
                    track_objs.push(serde_json::json!({ "id": cid }));
                }
            }
        }
    }

    let mut added_any = false;
    for raw in track_uris_or_ids {
        let cid = clean_soundcloud_id(raw);
        if !cid.is_empty() && seen_ids.insert(cid.clone()) {
            added_any = true;
            if let Ok(num) = cid.parse::<u64>() {
                track_objs.push(serde_json::json!({ "id": num }));
            } else {
                track_objs.push(serde_json::json!({ "id": cid }));
            }
        }
    }

    if added_any {
        let payload = serde_json::json!({
            "playlist": {
                "tracks": track_objs
            }
        });
        let body_bytes = serde_json::to_vec(&payload)?;
        let url = format!(
            "https://api.soundcloud.com/playlists/{}",
            url_encode_component(&playlist_id)
        );
        let _ = crate::http_pool::http_custom_bytes(
            "PUT",
            &url,
            &[
                ("Authorization", auth_header.as_str()),
                ("Content-Type", "application/json"),
                ("Accept", "application/json; charset=utf-8"),
            ],
            Some(&body_bytes),
            12,
        )
        .with_context(|| format!("Failed to update SoundCloud Set {playlist_id}"))?;
    }

    super::catalog::fetch_playlist_tracks(settings, &playlist_id)
}

fn strip_bracketed_suffixes(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut paren_depth = 0usize;
    let mut bracket_depth = 0usize;
    for ch in raw.chars() {
        match ch {
            '(' => paren_depth += 1,
            ')' => paren_depth = paren_depth.saturating_sub(1),
            '[' => bracket_depth += 1,
            ']' => bracket_depth = bracket_depth.saturating_sub(1),
            _ if paren_depth == 0 && bracket_depth == 0 => out.push(ch),
            _ => {}
        }
    }
    out
}

fn normalize_sc_match_text(raw: &str) -> String {
    let stripped = strip_bracketed_suffixes(raw);
    let mut words = Vec::new();
    let mut cur = String::new();
    for ch in stripped.chars() {
        if ch.is_alphanumeric() {
            for lc in ch.to_lowercase() {
                cur.push(lc);
            }
        } else if !cur.is_empty() {
            words.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        words.push(cur);
    }
    words.join(" ")
}

fn contains_variant_phrase(haystack_lower: &str, phrase: &str) -> bool {
    let mut search_from = 0usize;
    while let Some(rel) = haystack_lower[search_from..].find(phrase) {
        let start = search_from + rel;
        let end = start + phrase.len();
        let left_ok = start == 0
            || !haystack_lower[..start]
                .chars()
                .next_back()
                .map(|c| c.is_alphanumeric())
                .unwrap_or(false);
        let right_ok = end == haystack_lower.len()
            || !haystack_lower[end..]
                .chars()
                .next()
                .map(|c| c.is_alphanumeric())
                .unwrap_or(false);
        if left_ok && right_ok {
            return true;
        }
        search_from = start + phrase.len();
    }
    false
}

fn has_mismatched_variant_token(target_raw: &str, candidate_raw: &str) -> bool {
    const VARIANT_TOKENS: &[&str] = &[
        "remix",
        "karaoke",
        "instrumental",
        "sped up",
        "slowed",
        "nightcore",
        "cover",
        "live",
        "8d",
        "mashup",
        "bootleg",
        "acapella",
        "tribute",
    ];
    let target_lower = target_raw.to_ascii_lowercase();
    let candidate_lower = candidate_raw.to_ascii_lowercase();
    VARIANT_TOKENS.iter().any(|tok| {
        contains_variant_phrase(&candidate_lower, tok)
            && !contains_variant_phrase(&target_lower, tok)
    })
}

/// Scores a SoundCloud API `/tracks` candidate against local/catalog metadata for opt-in community attribution lookup.
pub(crate) fn score_soundcloud_track_candidate(
    item: &Value,
    target_title: &str,
    target_artist: &str,
    target_duration_ms: Option<u32>,
    target_isrc: Option<&str>,
) -> Option<(u32, SoundCloudTrackMatch)> {
    let obj = item.get("origin").unwrap_or(item);
    if let Some(kind) = obj.get("kind").and_then(|v| v.as_str()) {
        if kind != "track" {
            return None;
        }
    }
    let access = obj
        .get("access")
        .and_then(|v| v.as_str())
        .unwrap_or("playable");
    let policy = obj
        .get("policy")
        .and_then(|v| v.as_str())
        .unwrap_or("ALLOW");
    if access.eq_ignore_ascii_case("blocked") || policy.eq_ignore_ascii_case("BLOCK") {
        return None;
    }

    let id = if let Some(n) = obj.get("id").and_then(|v| v.as_u64()) {
        n.to_string()
    } else if let Some(s) = obj.get("urn").and_then(|v| v.as_str()) {
        clean_soundcloud_id(s)
    } else if let Some(s) = obj.get("id").and_then(|v| v.as_str()) {
        clean_soundcloud_id(s)
    } else {
        String::new()
    };
    if id.is_empty() {
        return None;
    }

    let cand_title = obj
        .get("title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_string();
    let permalink_url = obj
        .get("permalink_url")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|u| {
            u.starts_with("https://soundcloud.com/") || u.starts_with("http://soundcloud.com/")
        })?
        .to_string();

    let uploader_name = obj
        .pointer("/user/username")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    let metadata_artist = obj
        .pointer("/metadata_artist")
        .or_else(|| obj.pointer("/publisher_metadata/artist"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .unwrap_or("");
    let display_artist = if !uploader_name.is_empty() {
        uploader_name
    } else if !metadata_artist.is_empty() {
        metadata_artist
    } else {
        "SoundCloud Creator"
    }
    .to_string();

    let cand_duration_ms = obj.get("duration").and_then(|v| v.as_u64()).unwrap_or(0) as u32;
    let comment_count = obj
        .get("comment_count")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let cand_isrc = obj
        .pointer("/publisher_metadata/isrc")
        .or_else(|| obj.get("isrc"))
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty());

    if let (Some(t_isrc), Some(c_isrc)) = (
        target_isrc.map(str::trim).filter(|s| !s.is_empty()),
        cand_isrc,
    ) {
        if t_isrc.eq_ignore_ascii_case(c_isrc) {
            return Some((
                100,
                SoundCloudTrackMatch {
                    id,
                    title: cand_title,
                    artist: display_artist,
                    permalink_url,
                    comment_count,
                    duration_ms: cand_duration_ms,
                    match_confidence: "high".to_string(),
                    match_reason: "isrc_exact".to_string(),
                },
            ));
        }
    }

    if has_mismatched_variant_token(target_title, &cand_title) {
        return None;
    }

    let target_norm_title = normalize_sc_match_text(target_title);
    let target_norm_artist = normalize_sc_match_text(target_artist);
    if target_norm_title.is_empty() {
        return None;
    }

    let cand_norm_title = normalize_sc_match_text(&cand_title);
    let cand_norm_uploader = normalize_sc_match_text(uploader_name);
    let cand_norm_meta_artist = normalize_sc_match_text(metadata_artist);

    let (split_left_norm, split_right_norm) = match cand_title.split_once(" - ") {
        Some((l, r)) => (
            normalize_sc_match_text(l),
            normalize_sc_match_text(r),
        ),
        None => (String::new(), String::new()),
    };

    let title_ok = cand_norm_title == target_norm_title
        || split_right_norm == target_norm_title
        || (target_norm_title.len() >= 4
            && (cand_norm_title.contains(&target_norm_title)
                || (!split_right_norm.is_empty()
                    && split_right_norm.contains(&target_norm_title))));

    let artist_matches = |cand_norm: &str| -> bool {
        !cand_norm.is_empty()
            && (cand_norm == target_norm_artist
                || (target_norm_artist.len() >= 3
                    && (cand_norm.contains(&target_norm_artist)
                        || target_norm_artist.contains(cand_norm))))
    };

    let artist_ok = if target_norm_artist.is_empty() {
        cand_norm_title == target_norm_title || split_right_norm == target_norm_title
    } else {
        artist_matches(&cand_norm_uploader)
            || artist_matches(&cand_norm_meta_artist)
            || artist_matches(&split_left_norm)
            || (target_norm_artist.len() >= 3 && cand_norm_title.contains(&target_norm_artist))
    };

    if !title_ok || !artist_ok {
        return None;
    }

    let (score, confidence, reason) = match (target_duration_ms.filter(|&d| d > 0), cand_duration_ms)
    {
        (Some(td), cd) if cd > 0 => {
            let diff = cd.abs_diff(td);
            if diff <= 6_000 {
                (90u32, "high", "title_artist_duration")
            } else if diff <= 15_000 {
                (76u32, "medium", "title_artist")
            } else {
                return None;
            }
        }
        _ => (76u32, "medium", "title_artist"),
    };

    if score < 75 {
        return None;
    }

    Some((
        score,
        SoundCloudTrackMatch {
            id,
            title: cand_title,
            artist: display_artist,
            permalink_url,
            comment_count,
            duration_ms: cand_duration_ms,
            match_confidence: confidence.to_string(),
            match_reason: reason.to_string(),
        },
    ))
}

/// Opt-in official SoundCloud API track matcher used to open canonical `soundcloud.com` timed-comment pages
/// for tracks playing on non-SoundCloud sources. Zero background calls; only runs when explicitly invoked.
pub fn match_track_on_soundcloud(
    settings: &SimpSettings,
    title: &str,
    artist: &str,
    duration_ms: Option<u32>,
    isrc: Option<&str>,
) -> Result<Option<SoundCloudTrackMatch>> {
    let clean_title = title.trim();
    if clean_title.is_empty() {
        return Ok(None);
    }
    let clean_artist = artist.trim();
    let cache_key = format!(
        "{}|{}|{}|{}",
        normalize_sc_match_text(clean_title),
        normalize_sc_match_text(clean_artist),
        duration_ms.unwrap_or(0) / 5_000,
        isrc.unwrap_or("").trim().to_ascii_uppercase()
    );

    if let Ok(guard) = match_cache().lock() {
        if let Some((fetched_at, cached)) = guard.get(&cache_key) {
            if fetched_at.elapsed() < Duration::from_secs(900) {
                return Ok(cached.clone());
            }
        }
    }

    let query = format!("{clean_artist} {clean_title}").trim().to_string();
    let url = format!(
        "/tracks?q={}&access=playable&linked_partitioning=true&limit=10",
        url_encode_component(&query)
    );
    let json = soundcloud_authed_get(settings, &url)?;
    let best = extract_collection_items(&json)
        .into_iter()
        .filter_map(|item| {
            score_soundcloud_track_candidate(item, clean_title, clean_artist, duration_ms, isrc)
        })
        .max_by(|(score_a, match_a), (score_b, match_b)| {
            score_a
                .cmp(score_b)
                .then_with(|| match_a.comment_count.cmp(&match_b.comment_count))
        })
        .map(|(_, m)| m);

    if let Ok(mut guard) = match_cache().lock() {
        if guard.len() > 128 {
            guard.clear();
        }
        guard.insert(cache_key, (Instant::now(), best.clone()));
    }

    Ok(best)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_score_soundcloud_track_candidate_isrc_title_duration_and_variant_guard() {
        let isrc_candidate = serde_json::json!({
            "id": 9001,
            "kind": "track",
            "title": "Sample Track (Album Version)",
            "duration": 182000,
            "comment_count": 42,
            "permalink_url": "https://soundcloud.com/example-creator/sample-track",
            "user": { "username": "Example Creator" },
            "publisher_metadata": { "isrc": "USXYZ2600001" }
        });
        let (score, matched) = score_soundcloud_track_candidate(
            &isrc_candidate,
            "Completely Different Tag",
            "Another Name",
            Some(182_000),
            Some("USXYZ2600001"),
        )
        .expect("exact ISRC should match");
        assert_eq!(score, 100);
        assert_eq!(matched.match_reason, "isrc_exact");
        assert_eq!(matched.match_confidence, "high");

        let split_title_candidate = serde_json::json!({
            "id": 9002,
            "kind": "track",
            "title": "Example Artist - Demo Song (Official Audio)",
            "duration": 211000,
            "comment_count": 19,
            "permalink_url": "https://soundcloud.com/label-uploader/demo-song",
            "user": { "username": "Label Archive" }
        });
        let (score2, matched2) = score_soundcloud_track_candidate(
            &split_title_candidate,
            "Demo Song",
            "Example Artist",
            Some(210_000),
            None,
        )
        .expect("Artist - Title upload within 6s should match high confidence");
        assert_eq!(score2, 90);
        assert_eq!(matched2.match_reason, "title_artist_duration");

        let variant_candidate = serde_json::json!({
            "id": 9003,
            "kind": "track",
            "title": "Demo Song (Club Remix)",
            "duration": 210000,
            "comment_count": 500,
            "permalink_url": "https://soundcloud.com/remixer/demo-song-remix",
            "user": { "username": "Example Artist" }
        });
        assert!(score_soundcloud_track_candidate(
            &variant_candidate,
            "Demo Song",
            "Example Artist",
            Some(210_000),
            None,
        )
        .is_none());

        let duration_mismatch = serde_json::json!({
            "id": 9004,
            "kind": "track",
            "title": "Demo Song",
            "duration": 245000,
            "comment_count": 5,
            "permalink_url": "https://soundcloud.com/example/demo-song-extended",
            "user": { "username": "Example Artist" }
        });
        assert!(score_soundcloud_track_candidate(
            &duration_mismatch,
            "Demo Song",
            "Example Artist",
            Some(210_000),
            None,
        )
        .is_none());
    }
}

