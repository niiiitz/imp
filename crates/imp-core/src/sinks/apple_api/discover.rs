use super::*;
use anyhow::Result;
use serde_json::Value;
use imp_protocol::{SimpSettings, TrackMetadata};
use std::collections::{HashMap, HashSet};

fn is_live_broadcast_station(st: &Value, fallback_sub: &str) -> bool {
    let id = st.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id.contains("u-") {
        return false;
    }
    let attrs = st.get("attributes").unwrap_or(st);
    if attrs.get("isLive").and_then(|v| v.as_bool()) == Some(true) {
        return true;
    }
    let name_lower = attrs
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    if name_lower.contains("'s station")
        || name_lower.contains("’s station")
        || name_lower.contains("discovery station")
    {
        return false;
    }
    if name_lower.starts_with("apple music ")
        || name_lower.starts_with("apple música ")
        || fallback_sub == "Live Global Radio"
    {
        return true;
    }
    false
}

fn build_station_summary(st: &Value, fallback_sub: &str) -> Option<AppleRadioStationSummary> {
    let id = st.get("id").and_then(|v| v.as_str())?;
    let attrs = st.get("attributes").unwrap_or(st);
    Some(AppleRadioStationSummary {
        id: id.to_string(),
        name: attrs
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Radio Station")
            .to_string(),
        subtitle: attrs
            .pointer("/editorialNotes/short")
            .or_else(|| attrs.pointer("/editorialNotes/tagline"))
            .and_then(|v| v.as_str())
            .unwrap_or(fallback_sub)
            .to_string(),
        art_url: format_apple_art_url(
            attrs.pointer("/artwork/url").and_then(|v| v.as_str()),
            300,
        ),
        genre: None,
    })
}

fn fetch_shelf_tolerant(label: &str, url: &str, dev_token: &str, user_token: &str) -> Option<Value> {
    match apple_get_json(url, dev_token, user_token) {
        Ok(v) => Some(v),
        Err(e) => {
            tracing::warn!("Apple discover shelf '{label}' unavailable: {e:#}");
            None
        }
    }
}

fn current_year_approx() -> u32 {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let year = 1970 + (secs / 31_557_600) as u32;
    year.max(2024)
}

#[allow(clippy::too_many_arguments)]
fn append_items_to_apple_shelf(
    shelf: &mut AppleRecommendationShelf,
    seen_stations: &mut HashSet<String>,
    seen_playlists: &mut HashSet<String>,
    seen_albums: &mut HashSet<String>,
    items: &[Value],
    fallback_desc: &str,
    on_station: &mut dyn FnMut(&Value, &str),
    on_playlist: &mut dyn FnMut(&AppleCloudPlaylistSummary),
    on_album: &mut dyn FnMut(&str, &AppleCloudAlbumSummary),
) {
    for item in items {
        let item_type = item.get("type").and_then(|v| v.as_str()).unwrap_or("");
        let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        match item_type {
            "stations" => {
                on_station(item, fallback_desc);
                if !is_live_broadcast_station(item, fallback_desc) {
                    if let Some(summary) = build_station_summary(item, fallback_desc) {
                        if seen_stations.insert(summary.id.clone()) {
                            shelf.item_order.push(format!("station:{}", summary.id));
                            shelf.stations.push(summary);
                        }
                    }
                }
            }
            "playlists" | "library-playlists" => {
                if let Some(pl) = super::catalog::parse_apple_playlist_summary(item, fallback_desc) {
                    on_playlist(&pl);
                    if seen_playlists.insert(pl.id.clone()) {
                        shelf.item_order.push(format!("playlist:{}", pl.id));
                        shelf.playlists.push(pl);
                    }
                }
            }
            "albums" | "library-albums" => {
                if let Some(alb) = parse_apple_album_summary(
                    item,
                    if id.starts_with("l.") { "library" } else { "catalog" },
                ) {
                    on_album(id, &alb);
                    if seen_albums.insert(alb.id.clone()) {
                        shelf.item_order.push(format!("album:{}", alb.id));
                        shelf.albums.push(alb);
                    }
                }
            }
            _ => {}
        }
    }
}

fn ensure_shelf_item_order(shelf: &mut AppleRecommendationShelf) {
    if !shelf.item_order.is_empty() {
        return;
    }
    for st in &shelf.stations {
        shelf.item_order.push(format!("station:{}", st.id));
    }
    for pl in &shelf.playlists {
        shelf.item_order.push(format!("playlist:{}", pl.id));
    }
    for alb in &shelf.albums {
        shelf.item_order.push(format!("album:{}", alb.id));
    }
}

fn merge_apple_shelves(target: &mut AppleRecommendationShelf, mut incoming: AppleRecommendationShelf) {
    ensure_shelf_item_order(target);
    ensure_shelf_item_order(&mut incoming);

    let mut seen_stations: HashSet<String> = target.stations.iter().map(|s| s.id.clone()).collect();
    let mut seen_playlists: HashSet<String> = target.playlists.iter().map(|p| p.id.clone()).collect();
    let mut seen_albums: HashSet<String> = target.albums.iter().map(|a| a.id.clone()).collect();
    let mut seen_tokens: HashSet<String> = target.item_order.iter().cloned().collect();

    let mut st_map: HashMap<String, AppleRadioStationSummary> = incoming
        .stations
        .into_iter()
        .map(|s| (s.id.clone(), s))
        .collect();
    let mut pl_map: HashMap<String, AppleCloudPlaylistSummary> = incoming
        .playlists
        .into_iter()
        .map(|p| (p.id.clone(), p))
        .collect();
    let mut alb_map: HashMap<String, AppleCloudAlbumSummary> = incoming
        .albums
        .into_iter()
        .map(|a| (a.id.clone(), a))
        .collect();

    for token in incoming.item_order {
        if let Some(id) = token.strip_prefix("station:") {
            if let Some(st) = st_map.remove(id) {
                if seen_stations.insert(st.id.clone()) {
                    if seen_tokens.insert(token.clone()) {
                        target.item_order.push(token);
                    }
                    target.stations.push(st);
                }
            }
        } else if let Some(id) = token.strip_prefix("playlist:") {
            if let Some(pl) = pl_map.remove(id) {
                if seen_playlists.insert(pl.id.clone()) {
                    if seen_tokens.insert(token.clone()) {
                        target.item_order.push(token);
                    }
                    target.playlists.push(pl);
                }
            }
        } else if let Some(id) = token.strip_prefix("album:") {
            if let Some(alb) = alb_map.remove(id) {
                if seen_albums.insert(alb.id.clone()) {
                    if seen_tokens.insert(token.clone()) {
                        target.item_order.push(token);
                    }
                    target.albums.push(alb);
                }
            }
        }
    }
}

fn fetch_recent_played_raw_page(
    dev_token: &str,
    user_token: &str,
    offset: usize,
) -> Option<(Vec<Value>, Option<usize>)> {
    let primary_url = if offset > 0 {
        format!(
            "/v1/me/recent/played?types=albums,library-albums,playlists,library-playlists,stations&limit=10&offset={offset}"
        )
    } else {
        "/v1/me/recent/played?types=albums,library-albums,playlists,library-playlists,stations&limit=10".to_string()
    };
    let json = match apple_get_json(&primary_url, dev_token, user_token) {
        Ok(v) => Some(v),
        Err(_) => {
            let fallback_url = if offset > 0 {
                format!("/v1/me/recent/played?limit=10&offset={offset}")
            } else {
                "/v1/me/recent/played?limit=10".to_string()
            };
            fetch_shelf_tolerant("recent-played-fallback", &fallback_url, dev_token, user_token)
        }
    }?;

    let items = json
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let has_next = json
        .get("next")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.trim().is_empty());
    let next_offset = if has_next && !items.is_empty() {
        Some(offset + items.len())
    } else {
        None
    };
    Some((items, next_offset))
}

/// Fetches Radio & For You recommendations in native Rust.
pub fn fetch_radio_and_for_you(settings: &SimpSettings) -> Result<AppleRadioAndForYouResponse> {
    let (dev_token, user_token) = resolve_tokens(settings)?;
    let storefront = get_storefront(&dev_token, &user_token);

    let mut stations = Vec::new();
    let mut personal_stations = Vec::new();
    let mut live_stations = Vec::new();
    let mut playlists = Vec::new();
    let mut albums = Vec::new();
    let mut new_releases = Vec::new();
    let mut seen_stations = HashSet::new();
    let mut seen_personal_stations = HashSet::new();
    let mut seen_live_stations = HashSet::new();
    let mut seen_playlists = HashSet::new();
    let mut seen_albums = HashSet::new();
    let mut seen_new_releases = HashSet::new();

    let mut push_classified_station = |st: &Value, fallback_sub: &str| {
        if let Some(summary) = build_station_summary(st, fallback_sub) {
            if seen_stations.insert(summary.id.clone()) {
                stations.push(summary.clone());
            }
            if is_live_broadcast_station(st, fallback_sub) {
                if seen_live_stations.insert(summary.id.clone()) {
                    live_stations.push(summary);
                }
            } else if seen_personal_stations.insert(summary.id.clone()) {
                personal_stations.push(summary);
            }
        }
    };

    let mut shelves: Vec<AppleRecommendationShelf> = Vec::new();
    let mut recently_played: Vec<TrackMetadata> = Vec::new();

    let live_radio_url =
        format!("/v1/catalog/{storefront}/stations?filter[featured]=apple-music-live-radio");

    let (
        recent_radio_json,
        recent_played_items,
        heavy_rotation_json,
        recommendations_json,
        recent_tracks_json,
        live_radio_json,
    ) = std::thread::scope(|s| {
        let d = &dev_token;
        let u = &user_token;
        let live_url_ref = &live_radio_url;
        let h1 = s.spawn(move || {
            fetch_shelf_tolerant(
                "recent-radio-stations",
                "/v1/me/recent/radio-stations?limit=10",
                d,
                u,
            )
        });
        let h2 = s.spawn(move || {
            let mut collected: Vec<Value> = Vec::new();
            let mut offset = 0usize;
            for _ in 0..3 {
                let Some((mut page_items, next_opt)) =
                    fetch_recent_played_raw_page(d, u, offset)
                else {
                    break;
                };
                if page_items.is_empty() {
                    break;
                }
                collected.append(&mut page_items);
                let Some(next_off) = next_opt else { break };
                if next_off <= offset {
                    break;
                }
                offset = next_off;
            }
            if collected.is_empty() { None } else { Some(collected) }
        });
        let h3 = s.spawn(move || {
            fetch_shelf_tolerant(
                "heavy-rotation",
                "/v1/me/history/heavy-rotation?limit=10",
                d,
                u,
            )
        });
        let h4 = s.spawn(move || {
            fetch_shelf_tolerant("recommendations", "/v1/me/recommendations?limit=10", d, u)
        });
        let h5 = s.spawn(move || {
            fetch_shelf_tolerant(
                "recent-played-tracks",
                "/v1/me/recent/played/tracks?limit=24",
                d,
                u,
            )
        });
        let h6 = s.spawn(move || {
            fetch_shelf_tolerant("featured-live-radio", live_url_ref, d, u)
        });
        (
            h1.join().ok().flatten(),
            h2.join().ok().flatten(),
            h3.join().ok().flatten(),
            h4.join().ok().flatten(),
            h5.join().ok().flatten(),
            h6.join().ok().flatten(),
        )
    });

    if let Some(json) = recent_radio_json {
        if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
            for st in arr {
                push_classified_station(st, "Recent Radio Station");
            }
        }
    }

    // Recently Played Albums / Playlists (including personal library-playlists) / Stations
    if let Some(arr) = recent_played_items {
        let mut recent_shelf = AppleRecommendationShelf {
            id: "recently-played-items".to_string(),
            title: "Recently Played".to_string(),
            is_social: false,
            playlists: Vec::new(),
            albums: Vec::new(),
            stations: Vec::new(),
            item_order: Vec::new(),
        };
        let mut shelf_seen_st = HashSet::new();
        let mut shelf_seen_pl = HashSet::new();
        let mut shelf_seen_alb = HashSet::new();
        append_items_to_apple_shelf(
            &mut recent_shelf,
            &mut shelf_seen_st,
            &mut shelf_seen_pl,
            &mut shelf_seen_alb,
            &arr,
            "Recently Played",
            &mut push_classified_station,
            &mut |_| {},
            &mut |_, _| {},
        );
        if !recent_shelf.playlists.is_empty()
            || !recent_shelf.albums.is_empty()
            || !recent_shelf.stations.is_empty()
        {
            shelves.push(recent_shelf);
        }
    }

    if let Some(json) = heavy_rotation_json {
        if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
            let mut heavy_shelf = AppleRecommendationShelf {
                id: "heavy-rotation".to_string(),
                title: "Heavy Rotation".to_string(),
                is_social: false,
                playlists: Vec::new(),
                albums: Vec::new(),
                stations: Vec::new(),
                item_order: Vec::new(),
            };
            let mut shelf_seen_stations = HashSet::new();
            let mut shelf_seen_playlists = HashSet::new();
            let mut shelf_seen_albums = HashSet::new();
            append_items_to_apple_shelf(
                &mut heavy_shelf,
                &mut shelf_seen_stations,
                &mut shelf_seen_playlists,
                &mut shelf_seen_albums,
                arr,
                "Heavy Rotation",
                &mut push_classified_station,
                &mut |pl| {
                    if seen_playlists.insert(pl.id.clone()) {
                        playlists.push(pl.clone());
                    }
                },
                &mut |id, alb| {
                    if seen_albums.insert(id.to_string()) {
                        albums.push(alb.clone());
                    }
                },
            );
            if !heavy_shelf.playlists.is_empty()
                || !heavy_shelf.albums.is_empty()
                || !heavy_shelf.stations.is_empty()
            {
                shelves.push(heavy_shelf);
            }
        }
    }

    if let Some(json) = recommendations_json {
        if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
            for (idx, rec) in arr.iter().enumerate() {
                let rec_id = rec
                    .get("id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string())
                    .unwrap_or_else(|| format!("rec-{idx}"));
                let title = rec
                    .pointer("/attributes/title/stringForDisplay")
                    .and_then(|v| v.as_str())
                    .unwrap_or("Made For You");
                let title_lower = title.to_lowercase();
                let is_new_release_shelf = title_lower.contains("new release")
                    || title_lower.contains("recent release")
                    || title_lower == "new music";
                let is_recently_played_rec = title_lower == "recently played"
                    || title_lower.starts_with("recently played");
                let is_social = title_lower.contains("friend")
                    || title_lower.contains("listening to")
                    || rec
                        .pointer("/attributes/isGroupRecommendation")
                        .and_then(|v| v.as_bool())
                        == Some(true);

                let mut shelf = AppleRecommendationShelf {
                    id: rec_id,
                    title: title.to_string(),
                    is_social,
                    playlists: Vec::new(),
                    albums: Vec::new(),
                    stations: Vec::new(),
                    item_order: Vec::new(),
                };
                let mut shelf_seen_stations = HashSet::new();
                let mut shelf_seen_playlists = HashSet::new();
                let mut shelf_seen_albums = HashSet::new();
                if let Some(contents) = rec
                    .pointer("/relationships/contents/data")
                    .and_then(|v| v.as_array())
                {
                    append_items_to_apple_shelf(
                        &mut shelf,
                        &mut shelf_seen_stations,
                        &mut shelf_seen_playlists,
                        &mut shelf_seen_albums,
                        contents,
                        title,
                        &mut push_classified_station,
                        &mut |pl| {
                            if seen_playlists.insert(pl.id.clone()) {
                                playlists.push(pl.clone());
                            }
                        },
                        &mut |id, alb| {
                            if is_new_release_shelf && seen_new_releases.insert(alb.id.clone()) {
                                new_releases.push(alb.clone());
                            }
                            if seen_albums.insert(id.to_string()) {
                                albums.push(alb.clone());
                            }
                        },
                    );
                }
                if !shelf.playlists.is_empty()
                    || !shelf.albums.is_empty()
                    || !shelf.stations.is_empty()
                {
                    if is_recently_played_rec {
                        if let Some(existing_recent) = shelves
                            .iter_mut()
                            .find(|s| s.id == "recently-played-items")
                        {
                            merge_apple_shelves(existing_recent, shelf);
                            continue;
                        }
                    }
                    shelves.push(shelf);
                }
            }
        }
    }

    if let Some(json) = recent_tracks_json {
        if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
            let mut seen_recent = HashSet::new();
            for item in arr {
                if let Some(tr) = map_apple_item_to_track(item) {
                    if seen_recent.insert(tr.uri.clone()) {
                        recently_played.push(tr);
                    }
                }
            }
        }
    }

    // If `/v1/me/recommendations` didn't include a dedicated "New Releases For You" shelf (or had very few items),
    // also surface the newest releases from the user's top/recently played artists!
    if new_releases.len() < 4 {
        let min_recent_year = current_year_approx().saturating_sub(1);
        let mut fallback_new_releases = Vec::new();
        let mut seed_artists = Vec::new();
        let mut seen_seed_artists = HashSet::new();
        for alb in albums.iter().take(6) {
            let a = alb.artist.trim();
            if !a.is_empty() && a != "Various Artists" && seen_seed_artists.insert(a.to_lowercase()) {
                seed_artists.push(a.to_string());
            }
        }
        for tr in recently_played.iter().take(8) {
            if let Some(a) = tr.artists.first().map(|s| s.trim()) {
                if !a.is_empty() && seen_seed_artists.insert(a.to_lowercase()) {
                    seed_artists.push(a.to_string());
                }
            }
        }
        for artist_name in seed_artists.into_iter().take(3) {
            if let Ok(search_json) = apple_get_json(
                &format!(
                    "/v1/catalog/{storefront}/search?term={}&types=albums&limit=3",
                    urlencode(&artist_name)
                ),
                &dev_token,
                &user_token,
            ) {
                if let Some(arr) = search_json
                    .pointer("/results/albums/data")
                    .and_then(|v| v.as_array())
                {
                    for alb_val in arr {
                        if let Some(alb) = parse_apple_album_summary(alb_val, "catalog") {
                            if alb.release_year.unwrap_or(0) >= min_recent_year
                                && seen_new_releases.insert(alb.id.clone())
                            {
                                fallback_new_releases.push(alb);
                            }
                        }
                    }
                }
            }
        }
        fallback_new_releases.sort_by(|a, b| b.release_year.cmp(&a.release_year));
        new_releases.extend(fallback_new_releases);
    }

    if let Some(json) = live_radio_json {
        if let Some(arr) = json.get("data").and_then(|v| v.as_array()) {
            for st in arr {
                push_classified_station(st, "Live Global Radio");
            }
        }
    }

    // Fetch Richer Radio Shelves in parallel:
    // 1. Artist-Hosted Shows, Radio Hosts, Latest Episodes & Interviews
    // 2. Club Mixes & DJ Sets (Apple Music Club / One Mix / Boiler Room)
    // 3. Top Stations & Stations by Genre
    let mut artist_shows: Vec<AppleCloudPlaylistSummary> = Vec::new();
    let mut club_mixes: Vec<AppleCloudPlaylistSummary> = Vec::new();
    let mut genre_stations: Vec<AppleRadioStationSummary> = Vec::new();

    let (shows_res, mixes_res, genres_res) = std::thread::scope(|s| {
        let d1 = &dev_token;
        let u1 = &user_token;
        let sf1 = &storefront;
        let h_shows = s.spawn(move || {
            apple_get_json(
                &format!(
                    "/v1/catalog/{sf1}/search?term=Apple+Music+1+Radio+Show+Interview&types=playlists,stations&limit=18"
                ),
                d1,
                u1,
            )
        });

        let d2 = &dev_token;
        let u2 = &user_token;
        let sf2 = &storefront;
        let h_mixes = s.spawn(move || {
            apple_get_json(
                &format!(
                    "/v1/catalog/{sf2}/search?term=Apple+Music+Club+DJ+Mix+One+Mix&types=playlists,stations&limit=18"
                ),
                d2,
                u2,
            )
        });

        let d3 = &dev_token;
        let u3 = &user_token;
        let sf3 = &storefront;
        let h_genres = s.spawn(move || {
            let mut out: Vec<(String, Value)> = Vec::new();
            for genre_label in [
                "Electronic",
                "Hip-Hop",
                "Alternative",
                "Dance",
                "Pop",
                "R&B",
                "Rock",
                "Chill",
                "Jazz",
                "Classical",
                "Hits",
            ] {
                if let Ok(gj) = apple_get_json(
                    &format!(
                        "/v1/catalog/{sf3}/search?term={}+Station&types=stations&limit=4",
                        urlencode(genre_label)
                    ),
                    d3,
                    u3,
                ) {
                    out.push((genre_label.to_string(), gj));
                }
            }
            out
        });

        (
            h_shows.join().ok().and_then(|r| r.ok()),
            h_mixes.join().ok().and_then(|r| r.ok()),
            h_genres.join().ok().unwrap_or_default(),
        )
    });

    let mut seen_show_ids = HashSet::new();
    if let Some(sj) = shows_res {
        if let Some(arr) = sj
            .pointer("/results/playlists/data")
            .and_then(|v| v.as_array())
        {
            for pl in arr {
                if let Some(parsed) = super::catalog::parse_apple_playlist_summary(pl, "Apple Music Radio Show") {
                    if seen_show_ids.insert(parsed.id.clone()) {
                        artist_shows.push(parsed);
                    }
                }
            }
        }
        if let Some(st_arr) = sj
            .pointer("/results/stations/data")
            .and_then(|v| v.as_array())
        {
            for st in st_arr {
                push_classified_station(st, "Radio Hosts & Shows");
            }
        }
    }

    let mut seen_mix_ids = HashSet::new();
    if let Some(mj) = mixes_res {
        if let Some(arr) = mj
            .pointer("/results/playlists/data")
            .and_then(|v| v.as_array())
        {
            for pl in arr {
                if let Some(parsed) = super::catalog::parse_apple_playlist_summary(pl, "Club & DJ Mix") {
                    if seen_mix_ids.insert(parsed.id.clone()) {
                        club_mixes.push(parsed);
                    }
                }
            }
        }
    }

    let mut seen_genre_st_ids = HashSet::new();
    for (genre_label, gj) in genres_res {
        if let Some(st_arr) = gj
            .pointer("/results/stations/data")
            .and_then(|v| v.as_array())
        {
            for st in st_arr {
                if let Some(mut summary) =
                    build_station_summary(st, &format!("{genre_label} Radio"))
                {
                    if is_live_broadcast_station(st, &genre_label) {
                        if seen_live_stations.insert(summary.id.clone()) {
                            live_stations.push(summary);
                        }
                    } else if seen_genre_st_ids.insert(summary.id.clone()) {
                        summary.genre = Some(genre_label.clone());
                        genre_stations.push(summary);
                    }
                }
            }
        }
    }

    Ok(AppleRadioAndForYouResponse {
        stations,
        personal_stations,
        live_stations,
        genre_stations,
        artist_shows,
        club_mixes,
        playlists,
        albums,
        new_releases,
        shelves,
        recently_played,
    })
}

/// Paginates the user's Apple Music Recently Played albums, playlists, and stations beyond the first shelf.
pub fn fetch_recent_played_items_page(
    settings: &SimpSettings,
    offset: usize,
) -> Result<(AppleRecommendationShelf, Option<usize>)> {
    let (dev_token, user_token) = resolve_tokens(settings)?;
    let mut shelf = AppleRecommendationShelf {
        id: "recently-played-items".to_string(),
        title: "Recently Played".to_string(),
        is_social: false,
        playlists: Vec::new(),
        albums: Vec::new(),
        stations: Vec::new(),
        item_order: Vec::new(),
    };
    let mut seen_st = HashSet::new();
    let mut seen_pl = HashSet::new();
    let mut seen_alb = HashSet::new();
    let mut cur_offset = offset;
    let mut final_next = None;

    for _ in 0..2 {
        let Some((items, next_opt)) =
            fetch_recent_played_raw_page(&dev_token, &user_token, cur_offset)
        else {
            break;
        };
        if items.is_empty() {
            final_next = None;
            break;
        }
        append_items_to_apple_shelf(
            &mut shelf,
            &mut seen_st,
            &mut seen_pl,
            &mut seen_alb,
            &items,
            "Recently Played",
            &mut |_, _| {},
            &mut |_| {},
            &mut |_, _| {},
        );
        final_next = next_opt;
        let Some(next_off) = next_opt else { break };
        if next_off <= cur_offset {
            final_next = None;
            break;
        }
        cur_offset = next_off;
    }

    Ok((shelf, final_next))
}

/// Paginates the user's Apple Music Recently Played individual tracks beyond the initial 24 entries.
pub fn fetch_recent_played_tracks_page(
    settings: &SimpSettings,
    offset: usize,
) -> Result<(Vec<TrackMetadata>, Option<usize>)> {
    let (dev_token, user_token) = resolve_tokens(settings)?;
    let url = if offset > 0 {
        format!("/v1/me/recent/played/tracks?limit=25&offset={offset}")
    } else {
        "/v1/me/recent/played/tracks?limit=25".to_string()
    };
    let json = apple_get_json(&url, &dev_token, &user_token)?;
    let raw = json
        .get("data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let has_next = json
        .get("next")
        .and_then(|v| v.as_str())
        .is_some_and(|s| !s.trim().is_empty());
    let next_offset = if has_next && !raw.is_empty() {
        Some(offset + raw.len())
    } else {
        None
    };

    let mut tracks = Vec::new();
    let mut seen = HashSet::new();
    for item in &raw {
        if let Some(tr) = map_apple_item_to_track(item) {
            if seen.insert(tr.uri.clone()) {
                tracks.push(tr);
            }
        }
    }

    Ok((tracks, next_offset))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_apple_shelf_preserves_mixed_chronological_item_order() {
        let items = vec![
            json!({
                "id": "p.sample1",
                "type": "library-playlists",
                "attributes": { "name": "Sample Playlist", "canEdit": true }
            }),
            json!({
                "id": "1001",
                "type": "albums",
                "attributes": { "name": "Sample Album", "artistName": "Example Artist", "trackCount": 10 }
            }),
            json!({
                "id": "ra.sample1",
                "type": "stations",
                "attributes": { "name": "Artist Radio" }
            }),
        ];
        let mut shelf = AppleRecommendationShelf {
            id: "recently-played-items".to_string(),
            title: "Recently Played".to_string(),
            is_social: false,
            playlists: Vec::new(),
            albums: Vec::new(),
            stations: Vec::new(),
            item_order: Vec::new(),
        };
        let mut seen_st = HashSet::new();
        let mut seen_pl = HashSet::new();
        let mut seen_alb = HashSet::new();
        append_items_to_apple_shelf(
            &mut shelf,
            &mut seen_st,
            &mut seen_pl,
            &mut seen_alb,
            &items,
            "Recently Played",
            &mut |_, _| {},
            &mut |_| {},
            &mut |_, _| {},
        );
        assert_eq!(
            shelf.item_order,
            vec![
                "playlist:p.sample1".to_string(),
                "album:1001".to_string(),
                "station:ra.sample1".to_string(),
            ]
        );
        assert_eq!(shelf.playlists.len(), 1);
        assert_eq!(shelf.albums.len(), 1);
        assert_eq!(shelf.stations.len(), 1);
    }

    #[test]
    fn test_merge_recently_played_shelves_deduplicates_items() {
        let mut primary = AppleRecommendationShelf {
            id: "recently-played-items".to_string(),
            title: "Recently Played".to_string(),
            is_social: false,
            playlists: vec![AppleCloudPlaylistSummary {
                id: "p.sample1".to_string(),
                name: "Sample Playlist".to_string(),
                description: "Recently Played".to_string(),
                art_url: None,
                kind: "library".to_string(),
                last_modified_date: None,
                can_edit: true,
            }],
            albums: vec![],
            stations: vec![],
            item_order: vec!["playlist:p.sample1".to_string()],
        };
        let duplicate_rec = AppleRecommendationShelf {
            id: "rec-0".to_string(),
            title: "Recently Played".to_string(),
            is_social: false,
            playlists: vec![AppleCloudPlaylistSummary {
                id: "p.sample1".to_string(),
                name: "Sample Playlist".to_string(),
                description: "Recently Played".to_string(),
                art_url: None,
                kind: "library".to_string(),
                last_modified_date: None,
                can_edit: true,
            }],
            albums: vec![AppleCloudAlbumSummary {
                id: "1002".to_string(),
                title: "Sample Album 2".to_string(),
                artist: "Example Artist".to_string(),
                art_url: None,
                track_count: 8,
                release_year: Some(2024),
                kind: "catalog".to_string(),
                date_added: None,
                content_rating: None,
            }],
            stations: vec![],
            item_order: vec!["playlist:p.sample1".to_string(), "album:1002".to_string()],
        };

        merge_apple_shelves(&mut primary, duplicate_rec);

        assert_eq!(primary.playlists.len(), 1);
        assert_eq!(primary.albums.len(), 1);
        assert_eq!(
            primary.item_order,
            vec!["playlist:p.sample1".to_string(), "album:1002".to_string()]
        );
    }
}

