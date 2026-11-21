use crate::liberation::census::normalize_album_family_name;
use crate::liberation::downloader::sanitize_path_component;
use crate::library::services_cache::current_unix_sec;
use crate::sinks::apple_api::{apple_get_json, get_storefront, resolve_tokens, urlencode};
use anyhow::{anyhow, Context, Result};
use imp_protocol::SimpSettings;
use lofty::config::WriteOptions;
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::probe::Probe;
use lofty::tag::{Accessor, ItemKey, Tag};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReunionMoveItem {
    pub item_id: String,
    pub source_path: String,
    pub target_path: String,
    pub title: String,
    pub artist: String,
    #[serde(default)]
    pub proposed_title: Option<String>,
    #[serde(default)]
    pub proposed_artist: Option<String>,
    #[serde(default)]
    pub proposed_isrc: Option<String>,
    pub current_album: String,
    pub proposed_album: String,
    pub proposed_album_artist: String,
    pub proposed_track_number: Option<u32>,
    pub proposed_track_total: Option<u32>,
    pub proposed_disc_number: Option<u32>,
    pub proposed_year: Option<u32>,
    pub confidence: String,
    pub match_reason: String,
    pub catalog_album_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReunionPlanReport {
    pub plan_id: String,
    pub root_dir: String,
    pub scanned_files: usize,
    pub incomplete_albums_found: usize,
    pub catalog_lookups_performed: usize,
    pub proposed_items: Vec<ReunionMoveItem>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReunionJournalEntry {
    pub original_path: String,
    pub new_path: String,
    #[serde(default)]
    pub original_title: Option<String>,
    #[serde(default)]
    pub original_artist: Option<String>,
    #[serde(default)]
    pub original_isrc: Option<String>,
    pub original_album: Option<String>,
    pub original_album_artist: Option<String>,
    pub original_track_number: Option<u32>,
    pub original_track_total: Option<u32>,
    pub original_disc_number: Option<u32>,
    pub original_year: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReunionJournal {
    pub plan_id: String,
    pub root_dir: String,
    pub created_at: i64,
    pub entries: Vec<ReunionJournalEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReunionApplyResult {
    pub applied_count: usize,
    pub moved_count: usize,
    pub skipped_count: usize,
    pub failed: Vec<String>,
    pub journal_path: String,
}

#[derive(Debug, Clone)]
pub struct ScannedAudioFile {
    pub path: PathBuf,
    pub dir_path: PathBuf,
    pub title: String,
    pub artist: String,
    pub album_artist: String,
    pub album: String,
    pub track_number: Option<u32>,
    pub track_total: Option<u32>,
    pub disc_number: Option<u32>,
    pub year: Option<u32>,
    pub isrc: Option<String>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct CanonicalCatalogTrack {
    pub title: String,
    pub artist: String,
    pub track_number: u32,
    pub disc_number: u32,
    pub track_total: u32,
    pub isrc: Option<String>,
    pub duration_ms: u64,
    pub album_name: String,
    pub album_artist: String,
    pub year: Option<u32>,
    pub catalog_album_id: String,
}

#[derive(Debug, Clone)]
pub struct IncompleteAlbumFamily {
    pub artist: String,
    pub album: String,
    pub norm_artist: String,
    pub norm_album: String,
    pub dir_path: PathBuf,
    pub expected_track_count: u32,
    pub year: Option<u32>,
    pub present_slots: BTreeSet<(u32, u32)>,
    pub missing_disc1_slots: Vec<u32>,
}

fn cached_reunion_plans() -> &'static Mutex<Vec<ReunionPlanReport>> {
    static PLANS: OnceLock<Mutex<Vec<ReunionPlanReport>>> = OnceLock::new();
    PLANS.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn store_cached_reunion_plan(plan: &ReunionPlanReport) {
    if let Ok(mut guard) = cached_reunion_plans().lock() {
        guard.retain(|p| p.plan_id != plan.plan_id);
        while guard.len() >= 8 {
            guard.remove(0);
        }
        guard.push(plan.clone());
    }
}

pub fn get_cached_reunion_plan(plan_id: &str) -> Option<ReunionPlanReport> {
    cached_reunion_plans()
        .lock()
        .ok()
        .and_then(|g| g.iter().find(|p| p.plan_id == plan_id).cloned())
}

fn normalize_text(raw: &str) -> String {
    raw.split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase()
}

pub fn normalize_track_title_for_match(raw: &str) -> String {
    let mut s = raw.trim().to_ascii_lowercase();
    for marker in [
        "(single version",
        "[single version",
        "(album version",
        "(radio edit",
        "(remaster",
        "[remaster",
        "(explicit",
        "[explicit",
        "(clean",
        "[clean",
        "(feat.",
        "[feat.",
        "(ft.",
        "[ft.",
        " feat. ",
        " ft. ",
    ] {
        if let Some(idx) = s.find(marker) {
            s = s[..idx].trim().to_string();
        }
    }
    s.chars()
        .map(|c| if c.is_alphanumeric() || c == ' ' { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn is_supported_audio_file(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "m4a" | "mp3" | "flac" | "wav" | "aiff" | "aif" | "aac" | "ogg" | "opus"
    )
}

pub(crate) fn scan_reunion_audio_file(path: &Path) -> Option<ScannedAudioFile> {
    let tagged_file = Probe::open(path).ok()?.guess_file_type().ok()?.read().ok()?;
    let duration_ms = tagged_file.properties().duration().as_millis() as u64;
    let tag = tagged_file.primary_tag().or_else(|| tagged_file.first_tag());

    let fallback_stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Track")
        .trim()
        .to_string();

    let (title, artist, album_artist, album, track_number, track_total, disc_number, year, isrc) =
        if let Some(t) = tag {
            let ti = t
                .title()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or(fallback_stem);
            let ar = t
                .artist()
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            let aa = t
                .get_string(&ItemKey::AlbumArtist)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| ar.clone());
            let al = t
                .album()
                .map(|s| s.trim().to_string())
                .unwrap_or_default();
            let tn = t.track();
            let tt = t.track_total();
            let dn = t.disk();
            let yr = t.year();
            let is = t
                .get_string(&ItemKey::Isrc)
                .map(|s| s.trim().to_ascii_uppercase())
                .filter(|s| !s.is_empty());
            (ti, ar, aa, al, tn, tt, dn, yr, is)
        } else {
            (
                fallback_stem,
                String::new(),
                String::new(),
                String::new(),
                None,
                None,
                None,
                None,
                None,
            )
        };

    let dir_path = path.parent()?.to_path_buf();
    Some(ScannedAudioFile {
        path: path.to_path_buf(),
        dir_path,
        title,
        artist,
        album_artist,
        album,
        track_number,
        track_total,
        disc_number,
        year,
        isrc,
        duration_ms,
    })
}

fn is_reunion_stray_file(file: &ScannedAudioFile) -> bool {
    let lower = file.album.trim().to_ascii_lowercase();
    if lower.ends_with(" - single")
        || lower.ends_with(" - ep")
        || lower.contains("(single)")
        || lower.contains("[single]")
        || lower.contains("greatest hits")
        || lower.contains("best of")
    {
        return true;
    }
    matches!(file.track_total, Some(1))
}

pub(crate) fn compute_target_path(
    album_dir: &Path,
    source_path: &Path,
    title: &str,
    disc_num: Option<u32>,
    track_num: Option<u32>,
) -> String {
    let ext = source_path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "m4a".to_string());
    let safe_title = sanitize_path_component(title);
    let disc = disc_num.unwrap_or(1);
    let stem = match track_num {
        Some(tn) if tn > 0 && disc > 1 => format!("{disc}-{tn:02} {safe_title}"),
        Some(tn) if tn > 0 => format!("{tn:02} {safe_title}"),
        _ => safe_title,
    };
    album_dir
        .join(format!("{stem}.{ext}"))
        .to_string_lossy()
        .to_string()
}

fn fetch_canonical_album_tracks(
    dev_token: &str,
    user_token: &str,
    storefront: &str,
    artist: &str,
    album: &str,
) -> Option<Vec<CanonicalCatalogTrack>> {
    let query = format!("{artist} {album}");
    let search_url = format!(
        "/v1/catalog/{storefront}/search?term={}&types=albums&limit=5",
        urlencode(&query)
    );
    let search_json = apple_get_json(&search_url, dev_token, user_token).ok()?;
    let albums = search_json.pointer("/results/albums/data")?.as_array()?;
    let target_norm_album = normalize_album_family_name(album);
    let target_norm_artist = normalize_text(artist);

    let chosen_album = albums.iter().find(|item| {
        let a_name = item
            .pointer("/attributes/name")
            .and_then(|v| v.as_str())
            .map(normalize_album_family_name)
            .unwrap_or_default();
        let a_artist = item
            .pointer("/attributes/artistName")
            .and_then(|v| v.as_str())
            .map(normalize_text)
            .unwrap_or_default();
        (a_name == target_norm_album || a_name.contains(&target_norm_album))
            && (a_artist.contains(&target_norm_artist) || target_norm_artist.contains(&a_artist))
    })?;

    let album_id = chosen_album.get("id")?.as_str()?.trim();
    if album_id.is_empty() {
        return None;
    }

    let detail_url = format!(
        "/v1/catalog/{storefront}/albums/{}?include=tracks",
        urlencode(album_id)
    );
    let detail_json = apple_get_json(&detail_url, dev_token, user_token).ok()?;
    let alb_data = detail_json.pointer("/data/0")?;
    let alb_attrs = alb_data.get("attributes").unwrap_or(alb_data);
    let canonical_album_name = alb_attrs
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or(album)
        .to_string();
    let canonical_artist_name = alb_attrs
        .get("artistName")
        .and_then(|v| v.as_str())
        .unwrap_or(artist)
        .to_string();
    let track_total = alb_attrs
        .get("trackCount")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let release_year = alb_attrs
        .get("releaseDate")
        .and_then(|v| v.as_str())
        .and_then(|s| s.get(..4))
        .and_then(|y| y.parse::<u32>().ok());

    let tracks_arr = alb_data.pointer("/relationships/tracks/data")?.as_array()?;
    let mut out = Vec::with_capacity(tracks_arr.len());
    let total_resolved = track_total.max(tracks_arr.len() as u32);
    for t in tracks_arr {
        let ta = t.get("attributes").unwrap_or(t);
        let title = ta
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .trim()
            .to_string();
        if title.is_empty() {
            continue;
        }
        let artist_name = ta
            .get("artistName")
            .and_then(|v| v.as_str())
            .unwrap_or(&canonical_artist_name)
            .to_string();
        let tn = ta
            .get("trackNumber")
            .and_then(|v| v.as_u64())
            .unwrap_or(0) as u32;
        let dn = ta
            .get("discNumber")
            .and_then(|v| v.as_u64())
            .unwrap_or(1)
            .max(1) as u32;
        let dur = ta
            .get("durationInMillis")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let isrc = ta
            .get("isrc")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_ascii_uppercase())
            .filter(|s| !s.is_empty());

        out.push(CanonicalCatalogTrack {
            title,
            artist: artist_name,
            track_number: tn,
            disc_number: dn,
            track_total: total_resolved,
            isrc,
            duration_ms: dur,
            album_name: canonical_album_name.clone(),
            album_artist: canonical_artist_name.clone(),
            year: release_year,
            catalog_album_id: album_id.to_string(),
        });
    }

    if out.is_empty() {
        None
    } else {
        Some(out)
    }
}

/// Pure helper matching stray files against missing canonical catalog slots (ISRC first,
/// then normalized track title + duration tolerance), falling back cleanly to exact normalized
/// album-family matches only when offline or no catalog data exists.
pub fn match_strays_against_canonical_tracks(
    album: &IncompleteAlbumFamily,
    strays: &[&ScannedAudioFile],
    canonical_tracks: Option<&[CanonicalCatalogTrack]>,
    consumed_paths: &mut HashSet<PathBuf>,
    next_id: &mut usize,
) -> Vec<ReunionMoveItem> {
    let mut items = Vec::new();
    let mut claimed_slots = album.present_slots.clone();

    if let Some(cat_list) = canonical_tracks {
        let missing_cat: Vec<&CanonicalCatalogTrack> = cat_list
            .iter()
            .filter(|ct| ct.track_number > 0 && !claimed_slots.contains(&(ct.disc_number, ct.track_number)))
            .collect();

        for stray in strays {
            if consumed_paths.contains(&stray.path) {
                continue;
            }
            let stray_norm_title = normalize_track_title_for_match(&stray.title);

            // 1. Exact ISRC match
            let isrc_match = stray.isrc.as_ref().and_then(|s_isrc| {
                missing_cat.iter().find(|ct| {
                    !claimed_slots.contains(&(ct.disc_number, ct.track_number))
                        && ct.isrc.as_deref() == Some(s_isrc.as_str())
                })
            });

            // 2. Normalized Title + Duration match (±5 seconds when both durations known)
            let title_match = if isrc_match.is_none() {
                missing_cat.iter().find(|ct| {
                    if claimed_slots.contains(&(ct.disc_number, ct.track_number)) {
                        return false;
                    }
                    let cat_norm = normalize_track_title_for_match(&ct.title);
                    if cat_norm.is_empty() || cat_norm != stray_norm_title {
                        return false;
                    }
                    if stray.duration_ms > 0 && ct.duration_ms > 0 {
                        stray.duration_ms.abs_diff(ct.duration_ms) <= 5_000
                    } else {
                        true
                    }
                })
            } else {
                None
            };

            if let Some(matched) = isrc_match.or(title_match) {
                let (confidence, match_reason) = if isrc_match.is_some() {
                    (
                        "exact_isrc".to_string(),
                        format!(
                            "ISRC match with catalog slot #{}/{}",
                            matched.track_number, matched.track_total
                        ),
                    )
                } else {
                    (
                        "catalog_title_duration".to_string(),
                        format!(
                            "Matched canonical album track #{}/{} '{}'",
                            matched.track_number, matched.track_total, matched.title
                        ),
                    )
                };

                claimed_slots.insert((matched.disc_number, matched.track_number));
                consumed_paths.insert(stray.path.clone());
                *next_id += 1;

                let target_path = compute_target_path(
                    &album.dir_path,
                    &stray.path,
                    &stray.title,
                    Some(matched.disc_number),
                    Some(matched.track_number),
                );
                items.push(ReunionMoveItem {
                    item_id: format!("reunion_{}", *next_id),
                    source_path: stray.path.to_string_lossy().to_string(),
                    target_path,
                    title: stray.title.clone(),
                    artist: stray.artist.clone(),
                    proposed_title: None,
                    proposed_artist: None,
                    proposed_isrc: None,
                    current_album: stray.album.clone(),
                    proposed_album: album.album.clone(),
                    proposed_album_artist: album.artist.clone(),
                    proposed_track_number: Some(matched.track_number),
                    proposed_track_total: Some(matched.track_total.max(album.expected_track_count)),
                    proposed_disc_number: Some(matched.disc_number),
                    proposed_year: matched.year.or(album.year),
                    confidence,
                    match_reason,
                    catalog_album_id: Some(matched.catalog_album_id.clone()),
                });
            }
        }
        return items;
    }

    // Offline / non-catalog fallback: ONLY match when normalized album name matches incomplete album family name
    for stray in strays {
        if consumed_paths.contains(&stray.path) {
            continue;
        }
        let stray_norm_album = normalize_album_family_name(&stray.album);
        if stray_norm_album.is_empty() || stray_norm_album != album.norm_album {
            continue;
        }
        consumed_paths.insert(stray.path.clone());
        *next_id += 1;

        let inferred_track_num = if album.missing_disc1_slots.len() == 1 {
            Some(album.missing_disc1_slots[0])
        } else {
            stray.track_number.filter(|tn| album.missing_disc1_slots.contains(tn))
        };
        let target_path = compute_target_path(
            &album.dir_path,
            &stray.path,
            &stray.title,
            Some(1),
            inferred_track_num,
        );
        items.push(ReunionMoveItem {
            item_id: format!("reunion_{}", *next_id),
            source_path: stray.path.to_string_lossy().to_string(),
            target_path,
            title: stray.title.clone(),
            artist: stray.artist.clone(),
            proposed_title: None,
            proposed_artist: None,
            proposed_isrc: None,
            current_album: stray.album.clone(),
            proposed_album: album.album.clone(),
            proposed_album_artist: album.artist.clone(),
            proposed_track_number: inferred_track_num,
            proposed_track_total: Some(album.expected_track_count),
            proposed_disc_number: Some(1),
            proposed_year: album.year,
            confidence: "heuristic_album_match".to_string(),
            match_reason: format!(
                "Normalized album name matches incomplete album '{}' (offline match)",
                album.album
            ),
            catalog_album_id: None,
        });
    }

    items
}

/// Scans a local folder, identifies incomplete multi-track albums and stray single/EP files,
/// verifies candidates against Apple Music Catalog (when enabled), and caches a dry-run reunion plan.
pub fn build_album_reunion_plan(
    settings: Option<&SimpSettings>,
    root_dir: &Path,
    use_apple_catalog: bool,
) -> Result<ReunionPlanReport> {
    if !root_dir.is_dir() {
        return Err(anyhow!("Folder does not exist: {}", root_dir.display()));
    }

    let mut scanned = Vec::new();
    for entry in WalkDir::new(root_dir)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy();
        if name.starts_with("._") || name.ends_with(".imp.part") {
            continue;
        }
        if is_supported_audio_file(entry.path()) {
            if let Some(meta) = scan_reunion_audio_file(entry.path()) {
                scanned.push(meta);
            }
        }
    }

    let scanned_files = scanned.len();
    let mut album_groups: HashMap<(String, String), Vec<&ScannedAudioFile>> = HashMap::new();
    let mut stray_by_artist: HashMap<String, Vec<&ScannedAudioFile>> = HashMap::new();

    for f in &scanned {
        let artist_src = if !f.album_artist.trim().is_empty() {
            f.album_artist.as_str()
        } else {
            f.artist.as_str()
        };
        let norm_artist = normalize_text(artist_src);
        let norm_album = normalize_album_family_name(&f.album);
        if norm_artist.is_empty()
            || norm_album.is_empty()
            || matches!(norm_album.as_str(), "unknown" | "unknown album")
        {
            continue;
        }
        if is_reunion_stray_file(f) {
            stray_by_artist.entry(norm_artist).or_default().push(f);
        } else {
            album_groups
                .entry((norm_artist, norm_album))
                .or_default()
                .push(f);
        }
    }

    let mut incomplete_families: Vec<IncompleteAlbumFamily> = Vec::new();
    for ((norm_artist, norm_album), group) in album_groups {
        if group.len() < 2 {
            continue;
        }
        let max_track_num = group
            .iter()
            .filter(|f| f.disc_number.unwrap_or(1) <= 1)
            .filter_map(|f| f.track_number)
            .max()
            .unwrap_or(0);
        let max_disc = group
            .iter()
            .filter_map(|f| f.disc_number)
            .max()
            .unwrap_or(1);
        let expected_meta = group.iter().filter_map(|f| f.track_total).max();
        let expected_track_count = expected_meta.unwrap_or(max_track_num).max(max_track_num);
        if expected_track_count < 2 {
            continue;
        }

        let present_slots: BTreeSet<(u32, u32)> = group
            .iter()
            .filter_map(|f| f.track_number.map(|n| (f.disc_number.unwrap_or(1), n)))
            .collect();
        let present_count = present_slots.len().max(group.len());

        let mut missing_disc1_slots = Vec::new();
        let disc1_nums: BTreeSet<u32> = group
            .iter()
            .filter(|f| f.disc_number.unwrap_or(1) <= 1)
            .filter_map(|f| f.track_number)
            .collect();
        if !disc1_nums.is_empty() {
            let scan_upper = if max_disc <= 1 {
                expected_track_count
            } else {
                max_track_num
            };
            for slot in 1..=scan_upper {
                if !disc1_nums.contains(&slot) {
                    missing_disc1_slots.push(slot);
                }
            }
        }

        if present_count < expected_track_count as usize || !missing_disc1_slots.is_empty() {
            let first = group[0];
            let display_artist = if !first.album_artist.is_empty() {
                first.album_artist.clone()
            } else {
                first.artist.clone()
            };
            incomplete_families.push(IncompleteAlbumFamily {
                artist: display_artist,
                album: first.album.clone(),
                norm_artist,
                norm_album,
                dir_path: first.dir_path.clone(),
                expected_track_count,
                year: group.iter().filter_map(|f| f.year).max(),
                present_slots,
                missing_disc1_slots,
            });
        }
    }

    incomplete_families.sort_by(|a, b| a.artist.cmp(&b.artist).then_with(|| a.album.cmp(&b.album)));
    let incomplete_albums_found = incomplete_families.len();

    let apple_tokens = if use_apple_catalog {
        settings.and_then(|s| resolve_tokens(s).ok()).map(|(d, u)| {
            let sf = get_storefront(&d, &u);
            (d, u, sf)
        })
    } else {
        None
    };

    let mut catalog_lookups_performed = 0usize;
    let mut consumed_paths = HashSet::new();
    let mut proposed_items = Vec::new();
    let mut next_id = 0usize;

    for family in &incomplete_families {
        let Some(strays) = stray_by_artist.get(&family.norm_artist) else {
            continue;
        };
        let remaining_strays: Vec<&ScannedAudioFile> = strays
            .iter()
            .copied()
            .filter(|s| !consumed_paths.contains(&s.path))
            .collect();
        if remaining_strays.is_empty() {
            continue;
        }

        let cat_tracks = if let Some((ref dev_t, ref usr_t, ref sf)) = apple_tokens {
            if catalog_lookups_performed < 40 {
                catalog_lookups_performed += 1;
                fetch_canonical_album_tracks(dev_t, usr_t, sf, &family.artist, &family.album)
            } else {
                None
            }
        } else {
            None
        };

        let mut matched = match_strays_against_canonical_tracks(
            family,
            &remaining_strays,
            cat_tracks.as_deref(),
            &mut consumed_paths,
            &mut next_id,
        );
        // If catalog lookup failed to match any item, still check exact offline normalized album match
        if matched.is_empty() && cat_tracks.is_some() {
            matched = match_strays_against_canonical_tracks(
                family,
                &remaining_strays,
                None,
                &mut consumed_paths,
                &mut next_id,
            );
        }
        proposed_items.extend(matched);
    }

    let now = current_unix_sec();
    let report = ReunionPlanReport {
        plan_id: format!("plan_{now}_{}", proposed_items.len()),
        root_dir: root_dir.to_string_lossy().to_string(),
        scanned_files,
        incomplete_albums_found,
        catalog_lookups_performed,
        proposed_items,
        created_at: now,
    };
    store_cached_reunion_plan(&report);
    Ok(report)
}

#[allow(clippy::too_many_arguments)]
fn write_reunion_tags(
    path: &Path,
    title: Option<&str>,
    artist: Option<&str>,
    isrc: Option<&str>,
    album: Option<&str>,
    album_artist: Option<&str>,
    track_number: Option<u32>,
    track_total: Option<u32>,
    disc_number: Option<u32>,
    year: Option<u32>,
    clear_missing_on_restore: bool,
    restore_core_fields: bool,
) -> Result<()> {
    let mut tagged_file = Probe::open(path)?
        .guess_file_type()?
        .read()
        .with_context(|| format!("Failed to read tags from {}", path.display()))?;
    let tag_type = tagged_file.file_type().primary_tag_type();
    if tagged_file.primary_tag().is_none() {
        tagged_file.insert_tag(Tag::new(tag_type));
    }
    if let Some(tag) = tagged_file.primary_tag_mut() {
        match title {
            Some(t) if !t.trim().is_empty() => tag.set_title(t.trim().to_string()),
            Some(_) if restore_core_fields => tag.remove_title(),
            _ => {}
        }
        match artist {
            Some(ar) if !ar.trim().is_empty() => tag.set_artist(ar.trim().to_string()),
            Some(_) if restore_core_fields => tag.remove_artist(),
            _ => {}
        }
        match isrc {
            Some(code) if !code.trim().is_empty() => {
                tag.insert_text(ItemKey::Isrc, code.trim().to_ascii_uppercase());
            }
            Some(_) if restore_core_fields => tag.remove_key(&ItemKey::Isrc),
            None if restore_core_fields => tag.remove_key(&ItemKey::Isrc),
            _ => {}
        }
        match album {
            Some(a) if !a.trim().is_empty() => tag.set_album(a.trim().to_string()),
            _ if clear_missing_on_restore => tag.remove_album(),
            _ => {}
        }
        match album_artist {
            Some(aa) if !aa.trim().is_empty() => {
                tag.insert_text(ItemKey::AlbumArtist, aa.trim().to_string());
            }
            _ if clear_missing_on_restore => tag.remove_key(&ItemKey::AlbumArtist),
            _ => {}
        }
        match track_number {
            Some(tn) => tag.set_track(tn),
            None if clear_missing_on_restore => tag.remove_track(),
            None => {}
        }
        match track_total {
            Some(tt) => tag.set_track_total(tt),
            None if clear_missing_on_restore => tag.remove_track_total(),
            None => {}
        }
        match disc_number {
            Some(dn) => tag.set_disk(dn),
            None if clear_missing_on_restore => tag.remove_disk(),
            None => {}
        }
        match year {
            Some(yr) => tag.set_year(yr),
            None if clear_missing_on_restore => tag.remove_year(),
            None => {}
        }
        tagged_file.save_to_path(path, WriteOptions::default())?;
    }
    Ok(())
}

/// Applies selected items from a `ReunionPlanReport`, writing a complete JSON undo journal
/// BEFORE mutating any tags or moving files into album folders.
pub fn apply_album_reunion_plan(
    plan: &ReunionPlanReport,
    selected_item_ids: &[String],
    move_files: bool,
) -> Result<ReunionApplyResult> {
    let selected_set: HashSet<&str> = selected_item_ids.iter().map(|s| s.as_str()).collect();
    let targets: Vec<&ReunionMoveItem> = plan
        .proposed_items
        .iter()
        .filter(|it| selected_set.is_empty() || selected_set.contains(it.item_id.as_str()))
        .collect();

    if targets.is_empty() {
        return Err(anyhow!("No reunion items selected to apply"));
    }

    let now = current_unix_sec();
    let mut journal_entries = Vec::with_capacity(targets.len());
    for item in &targets {
        let src = Path::new(&item.source_path);
        let meta = scan_reunion_audio_file(src);
        let new_path = if move_files && item.target_path != item.source_path {
            item.target_path.clone()
        } else {
            item.source_path.clone()
        };
        journal_entries.push(ReunionJournalEntry {
            original_path: item.source_path.clone(),
            new_path,
            original_title: meta.as_ref().map(|m| m.title.clone()),
            original_artist: meta.as_ref().map(|m| m.artist.clone()),
            original_isrc: meta.as_ref().and_then(|m| m.isrc.clone()),
            original_album: meta.as_ref().map(|m| m.album.clone()),
            original_album_artist: meta.as_ref().map(|m| m.album_artist.clone()),
            original_track_number: meta.as_ref().and_then(|m| m.track_number),
            original_track_total: meta.as_ref().and_then(|m| m.track_total),
            original_disc_number: meta.as_ref().and_then(|m| m.disc_number),
            original_year: meta.as_ref().and_then(|m| m.year),
        });
    }

    let root_path = Path::new(&plan.root_dir);
    let journal_path = root_path.join(format!(".imp_liberation_reunion_journal_{now}.json"));
    let journal = ReunionJournal {
        plan_id: plan.plan_id.clone(),
        root_dir: plan.root_dir.clone(),
        created_at: now,
        entries: journal_entries,
    };
    std::fs::write(&journal_path, serde_json::to_vec_pretty(&journal)?)
        .with_context(|| format!("Failed to write undo journal {}", journal_path.display()))?;

    let mut applied_count = 0usize;
    let mut moved_count = 0usize;
    let mut skipped_count = 0usize;
    let mut failed = Vec::new();

    for (idx, item) in targets.iter().enumerate() {
        let src = Path::new(&item.source_path);
        if !src.is_file() {
            skipped_count += 1;
            failed.push(format!("Missing source file: {}", item.source_path));
            continue;
        }
        if let Err(e) = write_reunion_tags(
            src,
            item.proposed_title.as_deref(),
            item.proposed_artist.as_deref(),
            item.proposed_isrc.as_deref(),
            Some(&item.proposed_album),
            Some(&item.proposed_album_artist),
            item.proposed_track_number,
            item.proposed_track_total,
            item.proposed_disc_number,
            item.proposed_year,
            false,
            false,
        ) {
            failed.push(format!("Retag failed for {}: {e}", item.source_path));
            continue;
        }

        if move_files && item.target_path != item.source_path {
            let dst = Path::new(&item.target_path);
            if dst.exists() {
                failed.push(format!(
                    "Target already exists (tagged in place only): {}",
                    item.target_path
                ));
                if let Some(entry) = journal_entries_mut_note(&journal_path, idx, &item.source_path) {
                    let _ = entry;
                }
                applied_count += 1;
                continue;
            }
            if let Some(parent) = dst.parent() {
                if let Err(e) = std::fs::create_dir_all(parent) {
                    failed.push(format!("Failed to create target dir {}: {e}", parent.display()));
                    applied_count += 1;
                    continue;
                }
            }
            if let Err(e) = std::fs::rename(src, dst) {
                failed.push(format!(
                    "Move failed {} -> {}: {e}",
                    src.display(),
                    dst.display()
                ));
                applied_count += 1;
                continue;
            }
            if let Some(old_parent) = src.parent() {
                let _ = std::fs::remove_dir(old_parent);
            }
            moved_count += 1;
        }
        applied_count += 1;
    }

    Ok(ReunionApplyResult {
        applied_count,
        moved_count,
        skipped_count,
        failed,
        journal_path: journal_path.to_string_lossy().to_string(),
    })
}

fn journal_entries_mut_note(
    journal_path: &Path,
    entry_idx: usize,
    actual_path: &str,
) -> Option<()> {
    let raw = std::fs::read(journal_path).ok()?;
    let mut journal: ReunionJournal = serde_json::from_slice(&raw).ok()?;
    if let Some(entry) = journal.entries.get_mut(entry_idx) {
        entry.new_path = actual_path.to_string();
        let bytes = serde_json::to_vec_pretty(&journal).ok()?;
        std::fs::write(journal_path, bytes).ok()?;
    }
    Some(())
}

/// Reverts a Stage 3 reunion/acoustic-mend apply operation from its saved JSON journal
/// (moving files back and restoring original `title`, `artist`, `isrc`, `album`, `album_artist`,
/// `track`, `track_total`, `disc`, `year` tags).
pub fn undo_reunion_journal(journal_path: &Path) -> Result<usize> {
    let raw = std::fs::read(journal_path)
        .with_context(|| format!("Failed to read journal {}", journal_path.display()))?;
    let journal: ReunionJournal =
        serde_json::from_slice(&raw).context("Invalid reunion journal JSON")?;

    let mut restored = 0usize;
    for entry in &journal.entries {
        let cur = Path::new(&entry.new_path);
        let orig = Path::new(&entry.original_path);
        let active_path = if cur != orig && cur.is_file() && !orig.exists() {
            if let Some(orig_parent) = orig.parent() {
                std::fs::create_dir_all(orig_parent)?;
            }
            std::fs::rename(cur, orig)?;
            orig
        } else if cur.is_file() {
            cur
        } else if orig.is_file() {
            orig
        } else {
            continue;
        };

        let restore_core = entry.original_title.is_some() || entry.original_artist.is_some();
        write_reunion_tags(
            active_path,
            entry.original_title.as_deref(),
            entry.original_artist.as_deref(),
            entry.original_isrc.as_deref(),
            entry.original_album.as_deref(),
            entry.original_album_artist.as_deref(),
            entry.original_track_number,
            entry.original_track_total,
            entry.original_disc_number,
            entry.original_year,
            true,
            restore_core,
        )?;
        restored += 1;
    }
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::liberation::verify::test_helpers::write_test_wav;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("imp_liberation_reunion_{label}_{nanos}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    fn tag_wav(
        path: &Path,
        title: &str,
        artist: &str,
        album: &str,
        tn: u32,
        tt: u32,
        isrc: Option<&str>,
    ) {
        write_test_wav(path, 440.0, 0.4, 100);
        let mut tf = Probe::open(path).unwrap().read().unwrap();
        let tt_type = tf.file_type().primary_tag_type();
        if tf.primary_tag().is_none() {
            tf.insert_tag(Tag::new(tt_type));
        }
        let tag = tf.primary_tag_mut().unwrap();
        tag.set_title(title.to_string());
        tag.set_artist(artist.to_string());
        tag.insert_text(ItemKey::AlbumArtist, artist.to_string());
        tag.set_album(album.to_string());
        tag.set_track(tn);
        tag.set_track_total(tt);
        tag.set_disk(1);
        tag.set_year(2020);
        if let Some(code) = isrc {
            tag.insert_text(ItemKey::Isrc, code.to_string());
        }
        tf.save_to_path(path, WriteOptions::default()).unwrap();
    }

    #[test]
    fn test_match_strays_against_canonical_tracks_isrc_and_title_duration() {
        let dir = PathBuf::from("/tmp/sample_album");
        let album = IncompleteAlbumFamily {
            artist: "Sample Artist".to_string(),
            album: "Sample Album".to_string(),
            norm_artist: "sample artist".to_string(),
            norm_album: "sample album".to_string(),
            dir_path: dir.clone(),
            expected_track_count: 4,
            year: Some(2020),
            present_slots: BTreeSet::from([(1, 1), (1, 2)]),
            missing_disc1_slots: vec![3, 4],
        };

        let s3 = ScannedAudioFile {
            path: PathBuf::from("/tmp/stray/track3.wav"),
            dir_path: PathBuf::from("/tmp/stray"),
            title: "Track 03 (Single Version)".to_string(),
            artist: "Sample Artist".to_string(),
            album_artist: "Sample Artist".to_string(),
            album: "Track 03 - Single".to_string(),
            track_number: Some(1),
            track_total: Some(1),
            disc_number: Some(1),
            year: Some(2020),
            isrc: Some("USXXX0000003".to_string()),
            duration_ms: 180_000,
        };
        let s4 = ScannedAudioFile {
            path: PathBuf::from("/tmp/stray/track4.wav"),
            dir_path: PathBuf::from("/tmp/stray"),
            title: "Track 04 (Radio Edit)".to_string(),
            artist: "Sample Artist".to_string(),
            album_artist: "Sample Artist".to_string(),
            album: "Track 04 - Single".to_string(),
            track_number: Some(1),
            track_total: Some(1),
            disc_number: Some(1),
            year: Some(2020),
            isrc: None,
            duration_ms: 211_000,
        };

        let canonical = vec![
            CanonicalCatalogTrack {
                title: "Track 03".to_string(),
                artist: "Sample Artist".to_string(),
                track_number: 3,
                disc_number: 1,
                track_total: 4,
                isrc: Some("USXXX0000003".to_string()),
                duration_ms: 180_000,
                album_name: "Sample Album".to_string(),
                album_artist: "Sample Artist".to_string(),
                year: Some(2020),
                catalog_album_id: "1700000001".to_string(),
            },
            CanonicalCatalogTrack {
                title: "Track 04".to_string(),
                artist: "Sample Artist".to_string(),
                track_number: 4,
                disc_number: 1,
                track_total: 4,
                isrc: None,
                duration_ms: 210_000,
                album_name: "Sample Album".to_string(),
                album_artist: "Sample Artist".to_string(),
                year: Some(2020),
                catalog_album_id: "1700000001".to_string(),
            },
        ];

        let mut consumed = HashSet::new();
        let mut next_id = 0usize;
        let items = match_strays_against_canonical_tracks(
            &album,
            &[&s3, &s4],
            Some(&canonical),
            &mut consumed,
            &mut next_id,
        );
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].confidence, "exact_isrc");
        assert_eq!(items[0].proposed_track_number, Some(3));
        assert_eq!(items[1].confidence, "catalog_title_duration");
        assert_eq!(items[1].proposed_track_number, Some(4));
    }

    #[test]
    fn test_build_apply_and_undo_reunion_roundtrip() {
        let dir = temp_dir("roundtrip");
        let album_dir = dir.join("Sample Artist").join("Sample Album");
        let single_dir = dir.join("Sample Artist").join("Sample Album - Single");

        for n in 1..=3u32 {
            tag_wav(
                &album_dir.join(format!("{n:02} Track {n:02}.wav")),
                &format!("Track {n:02}"),
                "Sample Artist",
                "Sample Album",
                n,
                4,
                None,
            );
        }
        let stray_orig = single_dir.join("01 Track 04.wav");
        tag_wav(
            &stray_orig,
            "Track 04",
            "Sample Artist",
            "Sample Album - Single",
            1,
            1,
            None,
        );

        let plan = build_album_reunion_plan(None, &dir, false).expect("plan should build");
        assert_eq!(plan.incomplete_albums_found, 1);
        assert_eq!(plan.proposed_items.len(), 1);
        let item = &plan.proposed_items[0];
        assert_eq!(item.confidence, "heuristic_album_match");
        assert_eq!(item.proposed_track_number, Some(4));
        assert_eq!(item.proposed_album, "Sample Album");

        let selected = vec![item.item_id.clone()];
        let apply_res = apply_album_reunion_plan(&plan, &selected, true).expect("apply succeeds");
        assert_eq!(apply_res.applied_count, 1);
        assert_eq!(apply_res.moved_count, 1);
        assert!(apply_res.failed.is_empty());

        let expected_moved = album_dir.join("04 Track 04.wav");
        assert!(expected_moved.is_file());
        assert!(!stray_orig.exists());
        let moved_tags = Probe::open(&expected_moved).unwrap().read().unwrap();
        let tag = moved_tags.primary_tag().unwrap();
        assert_eq!(tag.album().as_deref(), Some("Sample Album"));
        assert_eq!(tag.track(), Some(4));
        assert_eq!(tag.track_total(), Some(4));

        // Undo must restore file path AND original single tags
        let restored = undo_reunion_journal(Path::new(&apply_res.journal_path)).unwrap();
        assert_eq!(restored, 1);
        assert!(stray_orig.is_file());
        assert!(!expected_moved.exists());
        let orig_tags = Probe::open(&stray_orig).unwrap().read().unwrap();
        let orig_tag = orig_tags.primary_tag().unwrap();
        assert_eq!(orig_tag.album().as_deref(), Some("Sample Album - Single"));
        assert_eq!(orig_tag.track(), Some(1));
        assert_eq!(orig_tag.track_total(), Some(1));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_acoustic_mend_apply_and_undo_restores_title_artist_and_isrc() {
        let dir = temp_dir("acoustic_mend_roundtrip");
        let unknown_dir = dir.join("Unknown Artist").join("Unknown Album");
        std::fs::create_dir_all(&unknown_dir).unwrap();
        let src = unknown_dir.join("Track 01.wav");
        tag_wav(&src, "Track 01", "Unknown Artist", "Unknown Album", 1, 1, None);

        let target = dir
            .join("Example Artist")
            .join("Example Studio Album")
            .join("05 Restored Song.wav");

        let plan = ReunionPlanReport {
            plan_id: "acoustic-mend-test".to_string(),
            root_dir: dir.to_string_lossy().to_string(),
            scanned_files: 1,
            incomplete_albums_found: 0,
            catalog_lookups_performed: 1,
            proposed_items: vec![ReunionMoveItem {
                item_id: "mend-0001".to_string(),
                source_path: src.to_string_lossy().to_string(),
                target_path: target.to_string_lossy().to_string(),
                title: "Track 01".to_string(),
                artist: "Unknown Artist".to_string(),
                proposed_title: Some("Restored Song".to_string()),
                proposed_artist: Some("Example Artist".to_string()),
                proposed_isrc: Some("USXXX0000001".to_string()),
                current_album: "Unknown Album".to_string(),
                proposed_album: "Example Studio Album".to_string(),
                proposed_album_artist: "Example Artist".to_string(),
                proposed_track_number: Some(5),
                proposed_track_total: Some(10),
                proposed_disc_number: Some(1),
                proposed_year: Some(2012),
                confidence: "high".to_string(),
                match_reason: "AcoustID 97% (Studio Album)".to_string(),
                catalog_album_id: Some("mb-rel-1".to_string()),
            }],
            created_at: 1,
        };

        let apply_res =
            apply_album_reunion_plan(&plan, &["mend-0001".to_string()], true).expect("apply ok");
        assert_eq!(apply_res.applied_count, 1);
        assert_eq!(apply_res.moved_count, 1);
        assert!(target.is_file());
        assert!(!src.exists());

        let mended = scan_reunion_audio_file(&target).expect("scan mended");
        assert_eq!(mended.title, "Restored Song");
        assert_eq!(mended.artist, "Example Artist");
        assert_eq!(mended.album, "Example Studio Album");
        assert_eq!(mended.track_number, Some(5));
        assert_eq!(mended.year, Some(2012));

        let restored = undo_reunion_journal(Path::new(&apply_res.journal_path)).expect("undo ok");
        assert_eq!(restored, 1);
        assert!(src.is_file());
        assert!(!target.exists());

        let reverted = scan_reunion_audio_file(&src).expect("scan reverted");
        assert_eq!(reverted.title, "Track 01");
        assert_eq!(reverted.artist, "Unknown Artist");
        assert_eq!(reverted.album, "Unknown Album");
        assert_eq!(reverted.track_number, Some(1));

        let _ = std::fs::remove_dir_all(&dir);
    }
}
