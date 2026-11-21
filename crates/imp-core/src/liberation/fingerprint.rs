use crate::http_pool::http_post_bytes;
use crate::liberation::downloader::sanitize_path_component;
use crate::liberation::reunion::{
    compute_target_path, scan_reunion_audio_file, store_cached_reunion_plan, ReunionMoveItem,
    ReunionPlanReport, ScannedAudioFile,
};
use crate::liberation::verify::find_fallback_payload_offset;
use crate::library::services_cache::{
    current_unix_sec, LiberationFingerprintRecord, ServicesCacheDatabase,
};
use crate::sinks::apple_api::urlencode;
use anyhow::{anyhow, Result};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine as _,
};
use rusty_chromaprint::{match_fingerprints, Configuration, FingerprintCompressor, Fingerprinter};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{Cursor, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use std::time::{Duration, Instant, UNIX_EPOCH};
use symphonia::core::{
    audio::SampleBuffer,
    codecs::{DecoderOptions, CODEC_TYPE_NULL},
    errors::Error as SymphError,
    formats::FormatOptions,
    io::MediaSourceStream,
    meta::MetadataOptions,
    probe::Hint,
};
use symphonia::default::{get_codecs, get_probe};
use walkdir::WalkDir;

const ACOUSTID_API_URL: &str = "https://api.acoustid.org/v2/lookup";
const ACOUSTID_USER_AGENT: &str = "IMP-MediaPlayer/1.0.0 (https://github.com/niiiitz/imp)";
const MAX_FINGERPRINT_SECONDS: u64 = 120;
const MIN_ACOUSTID_SCORE: f64 = 0.85;
const MAX_DURATION_DRIFT_SEC: i64 = 8;
const ACOUSTID_MIN_INTERVAL_MS: u64 = 360; // <= 2.77 req/sec (strictly under AcoustID's 3 req/s cap)

#[derive(Debug, Clone)]
pub struct ComputedFingerprint {
    pub duration_sec: u32,
    pub raw_subfingerprints: Vec<u32>,
    pub compressed_b64: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcoustIdResolvedMatch {
    pub score: f64,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub album_artist: String,
    pub track_number: Option<u32>,
    pub track_total: Option<u32>,
    pub disc_number: Option<u32>,
    pub year: Option<u32>,
    pub isrc: Option<String>,
    pub mb_recording_id: String,
    pub mb_release_id: Option<String>,
    pub release_kind: String,
}

#[derive(Debug, Clone)]
pub struct LocalFingerprintEntry {
    pub file_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub file_size_bytes: u64,
    pub duration_sec: u32,
    pub container_format: String,
    pub raw_subfingerprints: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcousticDuplicateEntry {
    pub file_path: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub file_size_bytes: u64,
    pub duration_sec: u32,
    pub container_format: String,
    pub similarity_pct: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcousticDuplicateGroup {
    pub group_id: String,
    pub best_similarity_pct: f32,
    pub items: Vec<AcousticDuplicateEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcousticMendRuntimeStatus {
    pub phase: String,
    pub running: bool,
    pub pause_requested: bool,
    pub root_dir: String,
    pub target_mode: String,
    pub enable_acoustid_lookup: bool,
    pub folder_filter: String,
    pub has_api_key: bool,
    pub total_files: usize,
    pub processed_files: usize,
    #[serde(default)]
    pub clean_skipped: usize,
    pub fingerprinted_fresh: usize,
    pub fingerprinted_cached: usize,
    pub acoustid_queried: usize,
    pub acoustid_matched: usize,
    pub unmatched_unique: usize,
    pub proposed_mends: usize,
    pub duplicate_groups_found: usize,
    pub errors: usize,
    pub current_file: String,
    pub last_message: String,
    pub started_at: Option<i64>,
    pub updated_at: i64,
}

impl Default for AcousticMendRuntimeStatus {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            running: false,
            pause_requested: false,
            root_dir: String::new(),
            target_mode: "unknowns_only".to_string(),
            enable_acoustid_lookup: true,
            folder_filter: String::new(),
            has_api_key: resolve_acoustid_api_key(None).is_some(),
            total_files: 0,
            processed_files: 0,
            clean_skipped: 0,
            fingerprinted_fresh: 0,
            fingerprinted_cached: 0,
            acoustid_queried: 0,
            acoustid_matched: 0,
            unmatched_unique: 0,
            proposed_mends: 0,
            duplicate_groups_found: 0,
            errors: 0,
            current_file: String::new(),
            last_message: "Scan local audio with pure-Rust Chromaprint to identify missing/drifted tags or find offline acoustic duplicates.".to_string(),
            started_at: None,
            updated_at: current_unix_sec(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AcousticMendStatusResponse {
    pub runtime: AcousticMendRuntimeStatus,
    pub plan: Option<ReunionPlanReport>,
    pub duplicates: Vec<AcousticDuplicateGroup>,
}

fn read_key_from_dotenv_file(path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(path).ok()?;
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let cleaned = trimmed.strip_prefix("export ").unwrap_or(trimmed).trim();
        if let Some((k, v)) = cleaned.split_once('=') {
            let key = k.trim();
            if key == "ACOUSTID_API_KEY" || key == "IMP_ACOUSTID_API_KEY" {
                let val = v.trim().trim_matches('"').trim_matches('\'').trim();
                if !val.is_empty() {
                    return Some(val.to_string());
                }
            }
        }
    }
    None
}

/// Resolves the AcoustID client API key from:
/// 1) explicit request override
/// 2) `ACOUSTID_API_KEY` or `IMP_ACOUSTID_API_KEY` environment variable
/// 3) `.env` in current working directory (developer convenience)
/// 4) compile-time `IMP_EMBEDDED_ACOUSTID_API_KEY` embedded in release builds
pub fn resolve_acoustid_api_key(override_key: Option<&str>) -> Option<String> {
    if let Some(k) = override_key.map(str::trim).filter(|s| !s.is_empty()) {
        return Some(k.to_string());
    }
    for env_name in ["ACOUSTID_API_KEY", "IMP_ACOUSTID_API_KEY"] {
        if let Ok(val) = std::env::var(env_name) {
            let trimmed = val.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        if let Some(val) = read_key_from_dotenv_file(&cwd.join(".env")) {
            return Some(val);
        }
    }
    if let Some(embedded) = option_env!("IMP_EMBEDDED_ACOUSTID_API_KEY") {
        let trimmed = embedded.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    None
}

pub fn encode_raw_subfingerprints_b64(raw: &[u32]) -> String {
    let mut bytes = Vec::with_capacity(raw.len() * 4);
    for &v in raw {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    STANDARD.encode(bytes)
}

pub fn decode_raw_subfingerprints_b64(b64: &str) -> Vec<u32> {
    let Ok(bytes) = STANDARD.decode(b64.trim()) else {
        return Vec::new();
    };
    bytes
        .chunks_exact(4)
        .map(|chunk| u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect()
}

fn fingerprint_from_mss(
    mss: MediaSourceStream,
    hint_ext: Option<&str>,
) -> Result<(u32, Vec<u32>)> {
    let mut hint = Hint::new();
    if let Some(ext) = hint_ext {
        if !ext.is_empty() {
            hint.with_extension(ext);
        }
    }

    let probed = get_probe()
        .format(
            &hint,
            mss,
            &FormatOptions::default(),
            &MetadataOptions::default(),
        )
        .map_err(|e| anyhow!("Audio probe failed: {e}"))?;

    let mut format = probed.format;
    let track = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
        .ok_or_else(|| anyhow!("No decodable audio track found"))?;

    let track_id = track.id;
    let codec_params = track.codec_params.clone();
    let mut decoder = get_codecs()
        .make(&codec_params, &DecoderOptions::default())
        .map_err(|e| anyhow!("Audio decoder init failed: {e}"))?;

    let expected_duration_sec: Option<u32> =
        match (codec_params.n_frames, codec_params.sample_rate) {
            (Some(frames), Some(sr)) if frames > 0 && sr > 0 => {
                Some(((frames as f64) / (sr as f64)).round() as u32)
            }
            _ => None,
        };

    let config = Configuration::preset_test2();
    let mut fingerprinter = Fingerprinter::new(&config);
    let mut started = false;
    let mut active_sr: u32 = codec_params.sample_rate.unwrap_or(0);
    let mut decoded_frames: u64 = 0;
    let mut sample_buf: Option<SampleBuffer<i16>> = None;
    let mut consecutive_errors = 0u32;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphError::IoError(e)) if e.kind() == ErrorKind::UnexpectedEof => break,
            Err(SymphError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(_) => {
                consecutive_errors += 1;
                if consecutive_errors > 12 {
                    break;
                }
                continue;
            }
        };
        if packet.track_id() != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(audio_buf) => {
                consecutive_errors = 0;
                let spec = *audio_buf.spec();
                let frames = audio_buf.frames() as u64;
                if frames == 0 {
                    continue;
                }
                let channels = spec.channels.count().max(1) as u32;
                if !started {
                    active_sr = spec.rate.max(1);
                    fingerprinter
                        .start(active_sr, channels)
                        .map_err(|e| anyhow!("Chromaprint start failed: {e:?}"))?;
                    started = true;
                }

                let need_new = sample_buf
                    .as_ref()
                    .map(|b| b.capacity() < audio_buf.capacity())
                    .unwrap_or(true);
                if need_new {
                    sample_buf = Some(SampleBuffer::<i16>::new(audio_buf.capacity() as u64, spec));
                }
                if let Some(buf) = sample_buf.as_mut() {
                    buf.copy_interleaved_ref(audio_buf);
                    fingerprinter.consume(buf.samples());
                }
                decoded_frames = decoded_frames.saturating_add(frames);
                if active_sr > 0 && decoded_frames >= (active_sr as u64) * MAX_FINGERPRINT_SECONDS {
                    break;
                }
            }
            Err(SymphError::DecodeError(_)) => {
                consecutive_errors += 1;
                if consecutive_errors > 24 {
                    break;
                }
            }
            Err(SymphError::ResetRequired) => decoder.reset(),
            Err(_) => break,
        }
    }

    if !started || decoded_frames == 0 {
        return Err(anyhow!("No audio frames decoded for fingerprinting"));
    }

    fingerprinter.finish();
    let raw = fingerprinter.fingerprint().to_vec();
    if raw.is_empty() {
        return Err(anyhow!(
            "Audio too short to generate a Chromaprint fingerprint"
        ));
    }

    let decoded_sec = if active_sr > 0 {
        ((decoded_frames as f64) / (active_sr as f64)).round() as u32
    } else {
        0
    };
    let duration_sec = expected_duration_sec.unwrap_or(decoded_sec).max(decoded_sec).max(1);
    Ok((duration_sec, raw))
}

/// Computes a pure-Rust Chromaprint acoustic fingerprint (algorithm 2 / AcoustID default)
/// directly from an audio file via `symphonia` PCM decoding.
pub fn compute_chromaprint_fingerprint(path: &Path) -> Result<ComputedFingerprint> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase());

    let primary = File::open(path)
        .map_err(|e| anyhow!("Cannot open {}: {e}", path.display()))
        .and_then(|f| {
            let mss = MediaSourceStream::new(Box::new(f), Default::default());
            fingerprint_from_mss(mss, ext.as_deref())
        });

    let (mut duration_sec, raw) = match primary {
        Ok(res) => res,
        Err(first_err) => {
            // Retry unhinted or after skipping stacked leading ID3v2 tags (matches verify.rs)
            let fallback_unhinted = File::open(path).ok().and_then(|f| {
                let mss = MediaSourceStream::new(Box::new(f), Default::default());
                fingerprint_from_mss(mss, None).ok()
            });
            if let Some(ok) = fallback_unhinted {
                ok
            } else if let Some((offset, detected_ext)) = find_fallback_payload_offset(path) {
                let mut f = File::open(path)?;
                let mut all = Vec::new();
                f.read_to_end(&mut all)?;
                let start = (offset as usize).min(all.len());
                let sliced = all[start..].to_vec();
                let mss = MediaSourceStream::new(Box::new(Cursor::new(sliced)), Default::default());
                fingerprint_from_mss(mss, detected_ext.or(ext.as_deref()))
                    .map_err(|_| first_err)?
            } else {
                return Err(first_err);
            }
        }
    };

    // Refine total duration from container tags if we stopped decoding at 120s and codec header lacked n_frames
    if let Some(meta) = scan_reunion_audio_file(path) {
        let tag_dur_sec = (meta.duration_ms / 1000) as u32;
        if tag_dur_sec > duration_sec {
            duration_sec = tag_dur_sec;
        }
    }

    let config = Configuration::preset_test2();
    let compressed = FingerprintCompressor::from(&config).compress(&raw);
    let compressed_b64 = URL_SAFE_NO_PAD.encode(compressed);

    Ok(ComputedFingerprint {
        duration_sec,
        raw_subfingerprints: raw,
        compressed_b64,
    })
}

/// Returns true if a local audio file has missing, placeholder, or drifted metadata tags
/// that are prime candidates for Acoustic Mend re-identification.
pub fn is_drifted_or_unknown_audio_file(meta: &ScannedAudioFile) -> bool {
    let artist = meta.artist.trim().to_ascii_lowercase();
    let album = meta.album.trim().to_ascii_lowercase();
    let title = meta.title.trim().to_ascii_lowercase();

    let bad_artist = artist.is_empty()
        || matches!(
            artist.as_str(),
            "unknown" | "unknown artist" | "artist" | "various" | "track" | "n/a" | "none"
        );
    let bad_album = album.is_empty()
        || matches!(
            album.as_str(),
            "unknown" | "unknown album" | "album" | "misc" | "singles" | "downloads" | "n/a"
        );

    let looks_like_generic_track_title = title.is_empty()
        || title == "unknown"
        || title == "untitled"
        || (title.starts_with("track")
            && title
                .trim_start_matches("track")
                .trim_matches(|c: char| c.is_ascii_whitespace() || c == '-' || c == '_' || c == '#')
                .chars()
                .all(|c| c.is_ascii_digit()))
        || (title.starts_with("audiotrack")
            && title
                .trim_start_matches("audiotrack")
                .trim_matches(|c: char| c.is_ascii_whitespace() || c == '-' || c == '_')
                .chars()
                .all(|c| c.is_ascii_digit()));

    let single_or_stray = album.ends_with(" - single")
        || album.ends_with(" - ep")
        || matches!(meta.track_total, Some(1));

    bad_artist
        || bad_album
        || looks_like_generic_track_title
        || meta.track_number.is_none()
        || single_or_stray
}

pub fn lookup_acoustid_recording(
    api_key: &str,
    duration_sec: u32,
    fp_b64: &str,
) -> Result<serde_json::Value> {
    let body = format!(
        "client={}&duration={}&meta=recordings+releasegroups+releases+tracks+compress&fingerprint={}",
        urlencode(api_key.trim()),
        duration_sec.max(1),
        urlencode(fp_b64.trim()),
    );
    let headers = [
        ("Content-Type", "application/x-www-form-urlencoded"),
        ("User-Agent", ACOUSTID_USER_AGENT),
        ("Accept", "application/json"),
    ];
    let bytes = http_post_bytes(ACOUSTID_API_URL, &headers, body.as_bytes(), 20)?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| anyhow!("Invalid AcoustID JSON response: {e}"))?;
    if json.get("status").and_then(|v| v.as_str()) != Some("ok") {
        let msg = json
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("AcoustID lookup error");
        return Err(anyhow!("AcoustID error: {msg}"));
    }
    Ok(json)
}

fn join_acoustid_artists(arr: Option<&Vec<serde_json::Value>>) -> String {
    let Some(items) = arr else {
        return String::new();
    };
    let mut out = String::new();
    for (idx, a) in items.iter().enumerate() {
        let name = a
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("");
        if name.is_empty() {
            continue;
        }
        out.push_str(name);
        if let Some(jp) = a.get("joinphrase").and_then(|v| v.as_str()) {
            out.push_str(jp);
        } else if idx + 1 < items.len() {
            out.push_str(", ");
        }
    }
    out.trim().to_string()
}

fn extract_year_from_release(rel: &serde_json::Value) -> Option<u32> {
    rel.pointer("/date/year")
        .and_then(|v| v.as_u64())
        .map(|y| y as u32)
        .filter(|&y| (1900..=2100).contains(&y))
}

/// Normalizes typography/punctuation (straight vs curly quotes, dashes, extra spaces)
/// so purely cosmetic punctuation differences don't generate noisy metadata diffs.
pub fn normalize_typography_for_diff(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut prev_space = true;
    for ch in raw.trim().chars() {
        let mapped = match ch {
            '\u{2018}' | '\u{2019}' | '\u{02BC}' | '`' => '\'',
            '\u{201C}' | '\u{201D}' => '"',
            '\u{2013}' | '\u{2014}' => '-',
            '\u{00A0}' => ' ',
            other => other,
        };
        if mapped.is_whitespace() {
            if !prev_space {
                out.push(' ');
                prev_space = true;
            }
        } else {
            for lc in mapped.to_lowercase() {
                out.push(lc);
            }
            prev_space = false;
        }
    }
    out.trim().to_string()
}

fn contains_word_ci(haystack_lower: &str, needle: &str) -> bool {
    haystack_lower
        .split(|c: char| !c.is_alphanumeric())
        .any(|tok| tok == needle)
}

fn is_generic_or_mojibake_title(raw: &str) -> bool {
    let t = raw.trim();
    if t.is_empty() {
        return true;
    }
    let lower = t.to_ascii_lowercase();
    if matches!(lower.as_str(), "unknown" | "untitled") {
        return true;
    }
    if lower.starts_with("track")
        && lower
            .trim_start_matches("track")
            .trim_matches(|c: char| c.is_ascii_whitespace() || c == '-' || c == '_' || c == '#')
            .chars()
            .all(|c| c.is_ascii_digit())
    {
        return true;
    }
    if lower.starts_with("audiotrack")
        && lower
            .trim_start_matches("audiotrack")
            .trim_matches(|c: char| c.is_ascii_whitespace() || c == '-' || c == '_')
            .chars()
            .all(|c| c.is_ascii_digit())
    {
        return true;
    }
    // Detect classic Shift-JIS/Latin-1 mojibake markers (e.g. ¥, ©, ¤, Ã, â)
    let mojibake_hits = t
        .chars()
        .filter(|&c| matches!(c, '¥' | '©' | '¤' | 'Ã' | 'Â' | '¢' | '£' | '¦' | 'ª' | 'º' | '¿' | 'À'..='Å' | 'Õ' | 'Ø' | 'Þ'))
        .count();
    mojibake_hits >= 2
}

fn token_overlap_count(a: &str, b: &str) -> usize {
    let tok_a: HashSet<String> = normalize_typography_for_diff(a)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 2 && !matches!(*w, "the" | "and" | "for" | "feat" | "ft"))
        .map(|s| s.to_string())
        .collect();
    if tok_a.is_empty() {
        return 0;
    }
    normalize_typography_for_diff(b)
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.len() >= 2)
        .filter(|w| tok_a.contains(*w))
        .count()
}

/// Evaluates an AcoustID `/v2/lookup` JSON payload with strict confidence & duration guardrails,
/// strongly preferring canonical Studio Albums over Compilations / Greatest Hits / Various Artists.
pub fn select_best_acoustid_match(
    json: &serde_json::Value,
    local_duration_sec: u32,
) -> Option<AcoustIdResolvedMatch> {
    select_best_acoustid_match_with_hint(json, local_duration_sec, None)
}

/// Variant of `select_best_acoustid_match` that uses the local file's existing (non-generic)
/// tags as a tie-breaker to prevent `(instrumental)`/`(karaoke)`/`(live)` variant mislabeling
/// and wrong-track soundtrack swaps.
pub fn select_best_acoustid_match_with_hint(
    json: &serde_json::Value,
    local_duration_sec: u32,
    hint: Option<&ScannedAudioFile>,
) -> Option<AcoustIdResolvedMatch> {
    if json.get("status").and_then(|v| v.as_str()) != Some("ok") {
        return None;
    }
    let results = json.get("results").and_then(|v| v.as_array())?;

    let hint_title_raw = hint.map(|h| h.title.trim()).unwrap_or("");
    let hint_title_lower = hint_title_raw.to_ascii_lowercase();
    let hint_artist_raw = hint.map(|h| h.artist.trim()).unwrap_or("");
    let hint_has_clean_title = !is_generic_or_mojibake_title(hint_title_raw);

    let mut best: Option<(i64, AcoustIdResolvedMatch)> = None;

    for result in results {
        let score = result.get("score").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if score < MIN_ACOUSTID_SCORE {
            continue;
        }
        let Some(recordings) = result.get("recordings").and_then(|v| v.as_array()) else {
            continue;
        };

        for rec in recordings {
            let rec_id = rec
                .get("id")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            let title = rec
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if rec_id.is_empty() || title.is_empty() {
                continue;
            }

            if let Some(rec_dur) = rec.get("duration").and_then(|v| v.as_f64()) {
                let rec_dur_sec = rec_dur.round() as i64;
                if rec_dur_sec > 0
                    && local_duration_sec > 0
                    && (rec_dur_sec - local_duration_sec as i64).abs() > MAX_DURATION_DRIFT_SEC
                {
                    continue;
                }
            }

            let rec_artist = join_acoustid_artists(rec.get("artists").and_then(|v| v.as_array()));
            if rec_artist.is_empty() {
                continue;
            }

            // Penalize unwanted alternate-version suffixes unless the local title already names that variant
            let rec_title_lower = title.to_ascii_lowercase();
            let mut recording_bias: i64 = 0;
            for variant_kw in ["instrumental", "karaoke", "acapella", "a cappella", "demo"] {
                let rec_has = rec_title_lower.contains(variant_kw);
                let local_has = hint_title_lower.contains(variant_kw);
                if rec_has && !local_has {
                    recording_bias -= 115;
                } else if rec_has && local_has {
                    recording_bias += 30;
                }
            }
            if contains_word_ci(&rec_title_lower, "live")
                && !contains_word_ci(&hint_title_lower, "live")
            {
                recording_bias -= 45;
            }
            if hint_has_clean_title {
                let title_overlap = token_overlap_count(hint_title_raw, &title);
                if title_overlap > 0 {
                    recording_bias += 45 + (title_overlap.min(4) as i64) * 8;
                }
                if !hint_artist_raw.is_empty() && token_overlap_count(hint_artist_raw, &rec_artist) > 0 {
                    recording_bias += 25;
                }
            }

            let rgs = rec
                .get("releasegroups")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();

            if rgs.is_empty() {
                let rank = (score * 100.0).round() as i64 + recording_bias;
                let cand = AcoustIdResolvedMatch {
                    score,
                    title: title.clone(),
                    artist: rec_artist.clone(),
                    album: String::new(),
                    album_artist: rec_artist.clone(),
                    track_number: None,
                    track_total: None,
                    disc_number: None,
                    year: None,
                    isrc: None,
                    mb_recording_id: rec_id.clone(),
                    mb_release_id: None,
                    release_kind: "Recording".to_string(),
                };
                if best.as_ref().map(|(r, _)| rank > *r).unwrap_or(true) {
                    best = Some((rank, cand));
                }
                continue;
            }

            for rg in &rgs {
                let rg_title = rg
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let rg_type = rg
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string();
                let rg_secondary: Vec<String> = rg
                    .get("secondarytypes")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_ascii_lowercase()))
                            .collect()
                    })
                    .unwrap_or_default();
                let rg_artist = join_acoustid_artists(rg.get("artists").and_then(|v| v.as_array()));

                let mut base_rank = (score * 100.0).round() as i64 + recording_bias;
                let type_lower = rg_type.to_ascii_lowercase();
                let is_compilation = rg_secondary.iter().any(|s| {
                    matches!(
                        s.as_str(),
                        "compilation" | "dj-mix" | "mixtape/street" | "remix" | "live"
                    )
                });
                let is_soundtrack = rg_secondary.iter().any(|s| s == "soundtrack");

                if type_lower == "album" {
                    base_rank += 120;
                } else if type_lower == "ep" {
                    base_rank += 60;
                } else if type_lower == "single" {
                    base_rank += 20;
                }

                if is_compilation {
                    base_rank -= 85;
                }
                if is_soundtrack {
                    base_rank -= 25;
                }

                let title_lower = rg_title.to_ascii_lowercase();
                if title_lower.contains("greatest hits")
                    || title_lower.contains("best of")
                    || title_lower.contains("anthology")
                    || title_lower.contains("now that's what i call")
                    || title_lower.contains("ultimate collection")
                {
                    base_rank -= 70;
                }

                let album_artist_candidate = if !rg_artist.is_empty() {
                    rg_artist.clone()
                } else {
                    rec_artist.clone()
                };
                if album_artist_candidate.eq_ignore_ascii_case("various artists") {
                    base_rank -= 65;
                }

                let release_kind = if type_lower == "album" && !is_compilation {
                    "Studio Album".to_string()
                } else if is_compilation {
                    "Compilation".to_string()
                } else if !rg_type.is_empty() {
                    rg_type.clone()
                } else {
                    "Release".to_string()
                };

                let releases = rg
                    .get("releases")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();

                if releases.is_empty() {
                    if rg_title.is_empty() {
                        continue;
                    }
                    let cand = AcoustIdResolvedMatch {
                        score,
                        title: title.clone(),
                        artist: rec_artist.clone(),
                        album: rg_title.clone(),
                        album_artist: album_artist_candidate.clone(),
                        track_number: None,
                        track_total: None,
                        disc_number: None,
                        year: None,
                        isrc: None,
                        mb_recording_id: rec_id.clone(),
                        mb_release_id: None,
                        release_kind: release_kind.clone(),
                    };
                    if best.as_ref().map(|(r, _)| base_rank > *r).unwrap_or(true) {
                        best = Some((base_rank, cand));
                    }
                    continue;
                }

                for rel in &releases {
                    let rel_id = rel
                        .get("id")
                        .and_then(|v| v.as_str())
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    let rel_title = rel
                        .get("title")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .unwrap_or(&rg_title)
                        .to_string();
                    if rel_title.is_empty() {
                        continue;
                    }
                    let rel_artist =
                        join_acoustid_artists(rel.get("artists").and_then(|v| v.as_array()));
                    let final_album_artist = if !rel_artist.is_empty() {
                        rel_artist
                    } else {
                        album_artist_candidate.clone()
                    };

                    let mut track_number = None;
                    let mut track_total = None;
                    let mut disc_number = None;
                    if let Some(mediums) = rel.get("mediums").and_then(|v| v.as_array()) {
                        for med in mediums {
                            let d_pos = med
                                .get("position")
                                .and_then(|v| v.as_u64())
                                .map(|v| v as u32);
                            let t_cnt = med
                                .get("track_count")
                                .and_then(|v| v.as_u64())
                                .map(|v| v as u32);
                            if let Some(tracks) = med.get("tracks").and_then(|v| v.as_array()) {
                                if let Some(first_track) = tracks.first() {
                                    track_number = first_track
                                        .get("position")
                                        .and_then(|v| v.as_u64())
                                        .map(|v| v as u32);
                                    track_total = t_cnt;
                                    disc_number = d_pos;
                                    break;
                                }
                            }
                        }
                    }

                    let year = extract_year_from_release(rel);
                    let mut rel_rank = base_rank;
                    if final_album_artist.eq_ignore_ascii_case("various artists") {
                        rel_rank -= 65;
                    }
                    if track_number.is_some() {
                        rel_rank += 25;
                    }
                    if track_total.is_some() {
                        rel_rank += 10;
                    }
                    if let Some(y) = year {
                        rel_rank += 15;
                        // Slightly favor earlier original pressings over later reissues
                        rel_rank += ((2050i64 - y as i64).clamp(0, 120)) / 6;
                    }

                    let cand = AcoustIdResolvedMatch {
                        score,
                        title: title.clone(),
                        artist: rec_artist.clone(),
                        album: rel_title,
                        album_artist: final_album_artist,
                        track_number,
                        track_total,
                        disc_number,
                        year,
                        isrc: None,
                        mb_recording_id: rec_id.clone(),
                        mb_release_id: rel_id,
                        release_kind: release_kind.clone(),
                    };
                    if best.as_ref().map(|(r, _)| rel_rank > *r).unwrap_or(true) {
                        best = Some((rel_rank, cand));
                    }
                }
            }
        }
    }

    best.map(|(_, m)| m)
}

fn fast_hamming_prefilter_similar(a: &[u32], b: &[u32]) -> bool {
    let min_len = a.len().min(b.len());
    if min_len < 12 {
        return false;
    }
    let sample_len = min_len.min(20);
    let mid_a = (a.len() / 2).saturating_sub(sample_len / 2);
    let mid_b = (b.len() / 2).saturating_sub(sample_len / 2);

    // Check small alignment shifts (-6..=6 sub-fingerprints ≈ ±0.75s encoder delay)
    for shift in -6isize..=6isize {
        let start_b = (mid_b as isize + shift).clamp(0, (b.len() - sample_len) as isize) as usize;
        let mut total_bits = 0u32;
        for k in 0..sample_len {
            total_bits += (a[mid_a + k] ^ b[start_b + k]).count_ones();
        }
        let avg_bits = (total_bits as f32) / (sample_len as f32);
        if avg_bits <= 9.5 {
            return true;
        }
    }
    false
}

fn compute_pair_similarity_pct(a: &[u32], b: &[u32], config: &Configuration) -> Option<f32> {
    let min_len = a.len().min(b.len());
    if min_len < 12 {
        return None;
    }
    if !fast_hamming_prefilter_similar(a, b) {
        return None;
    }

    if let Ok(segments) = match_fingerprints(a, b, config) {
        let mut matched_items = 0usize;
        let mut weighted_score_sum = 0.0f64;
        for seg in &segments {
            if seg.score <= 6.0 {
                matched_items += seg.items_count;
                weighted_score_sum += seg.score * (seg.items_count as f64);
            }
        }
        if matched_items >= (min_len * 55) / 100 && matched_items >= 12 {
            let avg_bits = (weighted_score_sum / (matched_items as f64)) as f32;
            let sim_pct = ((1.0 - (avg_bits / 32.0)) * 100.0).clamp(0.0, 100.0);
            if sim_pct >= 86.0 {
                return Some((sim_pct * 10.0).round() / 10.0);
            }
        }
    }

    // Fallback aligned popcount comparison for shorter clips (< 15s) where gradient matcher is sparse
    if min_len <= 120 {
        let mut best_avg_bits = 32.0f32;
        for shift in -6isize..=6isize {
            let (sa, sb) = if shift >= 0 {
                (shift as usize, 0usize)
            } else {
                (0usize, (-shift) as usize)
            };
            let overlap = a.len().saturating_sub(sa).min(b.len().saturating_sub(sb));
            if overlap < (min_len * 75) / 100 || overlap < 12 {
                continue;
            }
            let mut bits = 0u32;
            for k in 0..overlap {
                bits += (a[sa + k] ^ b[sb + k]).count_ones();
            }
            let avg = (bits as f32) / (overlap as f32);
            if avg < best_avg_bits {
                best_avg_bits = avg;
            }
        }
        let sim_pct = ((1.0 - (best_avg_bits / 32.0)) * 100.0).clamp(0.0, 100.0);
        if sim_pct >= 88.0 {
            return Some((sim_pct * 10.0).round() / 10.0);
        }
    }
    None
}

/// Offline acoustic duplicate finder across fingerprinted local audio files.
/// Detects acoustically identical tracks across different codecs/bitrates (e.g. MP3 vs M4A vs FLAC)
/// where byte-level BLAKE3 hashes differ. Strictly read-only — never deletes files.
pub fn detect_offline_acoustic_duplicates(
    entries: &[LocalFingerprintEntry],
) -> Vec<AcousticDuplicateGroup> {
    let n = entries.len();
    if n < 2 {
        return Vec::new();
    }

    let config = Configuration::preset_test2();
    let mut indices: Vec<usize> = (0..n).collect();
    indices.sort_by_key(|&i| entries[i].duration_sec);

    let mut parent: Vec<usize> = (0..n).collect();
    fn find(parent: &mut [usize], mut x: usize) -> usize {
        while parent[x] != x {
            parent[x] = parent[parent[x]];
            x = parent[x];
        }
        x
    }
    fn union(parent: &mut [usize], a: usize, b: usize) {
        let ra = find(parent, a);
        let rb = find(parent, b);
        if ra != rb {
            parent[rb] = ra;
        }
    }

    let mut best_sim_for_idx: Vec<f32> = vec![0.0; n];

    for pos_i in 0..n {
        let i = indices[pos_i];
        let dur_i = entries[i].duration_sec;
        if entries[i].raw_subfingerprints.len() < 12 {
            continue;
        }
        for pos_j in (pos_i + 1)..n {
            let j = indices[pos_j];
            let dur_j = entries[j].duration_sec;
            if dur_j.saturating_sub(dur_i) > 6 {
                break;
            }
            if entries[j].raw_subfingerprints.len() < 12 {
                continue;
            }
            if let Some(sim_pct) = compute_pair_similarity_pct(
                &entries[i].raw_subfingerprints,
                &entries[j].raw_subfingerprints,
                &config,
            ) {
                union(&mut parent, i, j);
                if sim_pct > best_sim_for_idx[i] {
                    best_sim_for_idx[i] = sim_pct;
                }
                if sim_pct > best_sim_for_idx[j] {
                    best_sim_for_idx[j] = sim_pct;
                }
            }
        }
    }

    let mut grouped: HashMap<usize, Vec<usize>> = HashMap::new();
    for idx in 0..n {
        let root = find(&mut parent, idx);
        grouped.entry(root).or_default().push(idx);
    }

    let mut groups = Vec::new();
    for (gid, (_, mut members)) in grouped.into_iter().filter(|(_, v)| v.len() >= 2).enumerate() {
        members.sort_by(|&a, &b| entries[b].file_size_bytes.cmp(&entries[a].file_size_bytes));
        let best_sim = members
            .iter()
            .map(|&i| best_sim_for_idx[i])
            .fold(0.0f32, f32::max);
        let items = members
            .into_iter()
            .map(|i| {
                let e = &entries[i];
                AcousticDuplicateEntry {
                    file_path: e.file_path.clone(),
                    title: e.title.clone(),
                    artist: e.artist.clone(),
                    album: e.album.clone(),
                    file_size_bytes: e.file_size_bytes,
                    duration_sec: e.duration_sec,
                    container_format: e.container_format.clone(),
                    similarity_pct: best_sim_for_idx[i],
                }
            })
            .collect();
        groups.push(AcousticDuplicateGroup {
            group_id: format!("dup-{}", gid + 1),
            best_similarity_pct: best_sim,
            items,
        });
    }

    groups.sort_by(|a, b| {
        b.items
            .len()
            .cmp(&a.items.len())
            .then_with(|| {
                b.best_similarity_pct
                    .partial_cmp(&a.best_similarity_pct)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
    });
    groups
}

fn is_supported_audio_ext(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref(),
        Some("mp3" | "m4a" | "flac" | "aac" | "ogg" | "opus" | "wav" | "aiff" | "aif" | "wma")
    )
}

fn build_acoustic_mend_item(
    root_dir: &Path,
    meta: &ScannedAudioFile,
    matched: &AcoustIdResolvedMatch,
    idx: usize,
) -> Option<ReunionMoveItem> {
    let cur_title = meta.title.trim();
    let cur_artist = meta.artist.trim();
    let cur_album = meta.album.trim();

    let cur_title_norm = normalize_typography_for_diff(cur_title);
    let mat_title_norm = normalize_typography_for_diff(&matched.title);
    let proposed_title = if !matched.title.trim().is_empty() && cur_title_norm != mat_title_norm {
        Some(matched.title.trim().to_string())
    } else {
        None
    };

    let cur_artist_norm = normalize_typography_for_diff(cur_artist);
    let mat_artist_norm = normalize_typography_for_diff(&matched.artist);
    let proposed_artist = if !matched.artist.trim().is_empty() && cur_artist_norm != mat_artist_norm
    {
        Some(matched.artist.trim().to_string())
    } else {
        None
    };

    let final_album = if !matched.album.trim().is_empty() {
        matched.album.trim().to_string()
    } else if !cur_album.is_empty() {
        cur_album.to_string()
    } else {
        "Unknown Album".to_string()
    };

    let final_album_artist = if !matched.album_artist.trim().is_empty() {
        matched.album_artist.trim().to_string()
    } else if !matched.artist.trim().is_empty() {
        matched.artist.trim().to_string()
    } else {
        "Unknown Artist".to_string()
    };

    let album_changed =
        normalize_typography_for_diff(cur_album) != normalize_typography_for_diff(&final_album);
    let track_changed = matched.track_number.is_some() && meta.track_number != matched.track_number;
    // Only fill a MISSING year; don't churn existing years with reissue pressings
    let year_filled = meta.year.is_none() && matched.year.is_some();

    // Only propose a mend when at least one meaningful metadata field actually improves
    if proposed_title.is_none()
        && proposed_artist.is_none()
        && !album_changed
        && !track_changed
        && !year_filled
    {
        return None;
    }

    let safe_artist = sanitize_path_component(&final_album_artist);
    let safe_album = sanitize_path_component(&final_album);
    let target_album_dir = root_dir.join(safe_artist).join(safe_album);
    let final_title = proposed_title
        .as_deref()
        .unwrap_or(if cur_title.is_empty() {
            matched.title.as_str()
        } else {
            cur_title
        });
    let target_path = compute_target_path(
        &target_album_dir,
        &meta.path,
        final_title,
        matched.disc_number.or(meta.disc_number),
        matched.track_number.or(meta.track_number),
    );

    // Flag suspicious full-rewrite swaps where a clean readable title+artist is replaced with zero overlap
    let local_had_clean_title = !is_generic_or_mojibake_title(cur_title);
    let suspicious_rewrite = local_had_clean_title
        && proposed_title.is_some()
        && proposed_artist.is_some()
        && token_overlap_count(cur_title, &matched.title) == 0
        && token_overlap_count(cur_artist, &matched.artist) == 0;

    let score_pct = (matched.score * 100.0).round() as u32;
    let confidence = if suspicious_rewrite {
        "review"
    } else if matched.score >= 0.93 {
        "high"
    } else {
        "medium"
    }
    .to_string();

    let mut diff_notes = Vec::new();
    if let Some(ref t) = proposed_title {
        diff_notes.push(format!("Title -> {t}"));
    }
    if let Some(ref a) = proposed_artist {
        diff_notes.push(format!("Artist -> {a}"));
    }
    if album_changed {
        diff_notes.push(format!("Album -> {final_album}"));
    }
    if track_changed {
        if let Some(tn) = matched.track_number {
            diff_notes.push(format!("Track #{tn}"));
        }
    }
    if year_filled {
        if let Some(y) = matched.year {
            diff_notes.push(format!("Year -> {y}"));
        }
    }
    if diff_notes.is_empty() {
        return None;
    }

    Some(ReunionMoveItem {
        item_id: format!("mend-{:04}", idx + 1),
        source_path: meta.path.to_string_lossy().to_string(),
        target_path,
        title: if cur_title.is_empty() {
            matched.title.clone()
        } else {
            cur_title.to_string()
        },
        artist: if cur_artist.is_empty() {
            matched.artist.clone()
        } else {
            cur_artist.to_string()
        },
        proposed_title,
        proposed_artist,
        proposed_isrc: matched.isrc.clone(),
        current_album: if cur_album.is_empty() {
            "(Missing Album)".to_string()
        } else {
            cur_album.to_string()
        },
        proposed_album: final_album,
        proposed_album_artist: final_album_artist,
        proposed_track_number: matched.track_number.or(meta.track_number),
        proposed_track_total: matched.track_total.or(meta.track_total),
        proposed_disc_number: matched.disc_number.or(meta.disc_number),
        proposed_year: meta.year.or(matched.year),
        confidence,
        match_reason: format!(
            "AcoustID {score_pct}% ({}) · {}",
            matched.release_kind,
            diff_notes.join(" · ")
        ),
        catalog_album_id: matched.mb_release_id.clone(),
    })
}

/// Prevents splitting a single ripped album folder across two different release names
/// (e.g. 28 tracks resolving to the main OST and 4 tracks resolving to a bonus sampler).
pub fn apply_folder_album_consensus(root_dir: &Path, items: &mut [ReunionMoveItem]) {
    let mut by_dir: HashMap<PathBuf, Vec<usize>> = HashMap::new();
    for (idx, it) in items.iter().enumerate() {
        if let Some(parent) = Path::new(&it.source_path).parent() {
            by_dir.entry(parent.to_path_buf()).or_default().push(idx);
        }
    }

    for (_dir, idxs) in by_dir {
        if idxs.len() < 4 {
            continue;
        }
        let mut counts: HashMap<String, (usize, String, String, Option<u32>, Option<u32>)> =
            HashMap::new();
        for &i in &idxs {
            let key = normalize_typography_for_diff(&items[i].proposed_album);
            let entry = counts.entry(key).or_insert_with(|| {
                (
                    0,
                    items[i].proposed_album.clone(),
                    items[i].proposed_album_artist.clone(),
                    items[i].proposed_track_total,
                    items[i].proposed_year,
                )
            });
            entry.0 += 1;
            if let Some(tt) = items[i].proposed_track_total {
                entry.3 = Some(entry.3.unwrap_or(0).max(tt));
            }
        }
        let Some((dom_key, (dom_cnt, dom_album, dom_artist, dom_total, dom_year))) =
            counts.into_iter().max_by_key(|(_, v)| v.0)
        else {
            continue;
        };
        if dom_cnt < 3 || dom_cnt * 100 < idxs.len() * 60 {
            continue;
        }
        for &i in &idxs {
            if normalize_typography_for_diff(&items[i].proposed_album) == dom_key {
                continue;
            }
            // Only unify minority items that came from untagged/generic rips or smaller bonus editions
            let is_untagged_rip = is_generic_or_mojibake_title(&items[i].title)
                || items[i].current_album == "(Missing Album)";
            let smaller_bonus_edition = match (items[i].proposed_track_total, dom_total) {
                (Some(a), Some(b)) => a < b,
                _ => false,
            };
            if is_untagged_rip || smaller_bonus_edition {
                items[i].proposed_album = dom_album.clone();
                items[i].proposed_album_artist = dom_artist.clone();
                if dom_total.is_some() {
                    items[i].proposed_track_total = dom_total;
                }
                if items[i].proposed_year.is_none() {
                    items[i].proposed_year = dom_year;
                }
                let safe_artist = sanitize_path_component(&dom_artist);
                let safe_album = sanitize_path_component(&dom_album);
                let target_album_dir = root_dir.join(safe_artist).join(safe_album);
                let final_title = items[i]
                    .proposed_title
                    .as_deref()
                    .unwrap_or(&items[i].title);
                items[i].target_path = compute_target_path(
                    &target_album_dir,
                    Path::new(&items[i].source_path),
                    final_title,
                    items[i].proposed_disc_number,
                    items[i].proposed_track_number,
                );
                items[i].match_reason = format!(
                    "{} · Unified to folder consensus album",
                    items[i].match_reason
                );
            }
        }
    }
}

pub struct AcousticMendController {
    runtime: Mutex<AcousticMendRuntimeStatus>,
    last_plan: Mutex<Option<ReunionPlanReport>>,
    last_duplicates: Mutex<Vec<AcousticDuplicateGroup>>,
    pause_flag: Arc<AtomicBool>,
}

impl Default for AcousticMendController {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(AcousticMendRuntimeStatus::default()),
            last_plan: Mutex::new(None),
            last_duplicates: Mutex::new(Vec::new()),
            pause_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

pub fn global_acoustic_mend_controller() -> &'static Arc<AcousticMendController> {
    static CTRL: OnceLock<Arc<AcousticMendController>> = OnceLock::new();
    CTRL.get_or_init(|| Arc::new(AcousticMendController::default()))
}

impl AcousticMendController {
    pub fn status(&self) -> AcousticMendStatusResponse {
        let mut runtime = self.runtime.lock().unwrap().clone();
        if !runtime.running {
            runtime.has_api_key = resolve_acoustid_api_key(None).is_some();
        }
        let plan = self.last_plan.lock().unwrap().clone();
        let duplicates = self.last_duplicates.lock().unwrap().clone();
        AcousticMendStatusResponse {
            runtime,
            plan,
            duplicates,
        }
    }

    pub fn pause(&self) -> Result<()> {
        self.pause_flag.store(true, Ordering::SeqCst);
        let mut rt = self.runtime.lock().unwrap();
        if rt.running {
            rt.pause_requested = true;
            rt.last_message = "Pause requested — finishing current audio file...".to_string();
            rt.updated_at = current_unix_sec();
        }
        Ok(())
    }

    pub fn start(
        self: &Arc<Self>,
        cache: ServicesCacheDatabase,
        root_dir: PathBuf,
        target_mode: String,
        enable_acoustid_lookup: bool,
        folder_filter: Option<String>,
        api_key_override: Option<String>,
    ) -> Result<AcousticMendStatusResponse> {
        if self.runtime.lock().unwrap().running {
            return Ok(self.status());
        }
        if !root_dir.is_dir() {
            return Err(anyhow!(
                "Library folder does not exist: {}",
                root_dir.display()
            ));
        }

        let resolved_key = resolve_acoustid_api_key(api_key_override.as_deref());
        if enable_acoustid_lookup && resolved_key.is_none() {
            return Err(anyhow!(
                "AcoustID API key not configured. Set ACOUSTID_API_KEY in environment or provide a key override, or run in Offline Acoustic Dedup mode."
            ));
        }

        let clean_mode = if target_mode.trim() == "all" {
            "all".to_string()
        } else {
            "unknowns_only".to_string()
        };
        let clean_filter = folder_filter
            .as_deref()
            .map(str::trim)
            .unwrap_or("")
            .to_string();

        self.pause_flag.store(false, Ordering::SeqCst);
        let now = current_unix_sec();
        {
            let mut rt = self.runtime.lock().unwrap();
            *rt = AcousticMendRuntimeStatus {
                phase: "scanning".to_string(),
                running: true,
                pause_requested: false,
                root_dir: root_dir.to_string_lossy().to_string(),
                target_mode: clean_mode.clone(),
                enable_acoustid_lookup,
                folder_filter: clean_filter.clone(),
                has_api_key: resolved_key.is_some(),
                total_files: 0,
                processed_files: 0,
                clean_skipped: 0,
                fingerprinted_fresh: 0,
                fingerprinted_cached: 0,
                acoustid_queried: 0,
                acoustid_matched: 0,
                unmatched_unique: 0,
                proposed_mends: 0,
                duplicate_groups_found: 0,
                errors: 0,
                current_file: String::new(),
                last_message: "Discovering local audio files...".to_string(),
                started_at: Some(now),
                updated_at: now,
            };
        }
        *self.last_plan.lock().unwrap() = None;
        *self.last_duplicates.lock().unwrap() = Vec::new();

        let ctrl = Arc::clone(self);
        std::thread::Builder::new()
            .name("imp-liberation-fingerprint".to_string())
            .spawn(move || {
                ctrl.run_worker(
                    cache,
                    root_dir,
                    clean_mode,
                    enable_acoustid_lookup,
                    clean_filter,
                    resolved_key,
                );
            })?;

        Ok(self.status())
    }

    fn run_worker(
        &self,
        cache: ServicesCacheDatabase,
        root_dir: PathBuf,
        target_mode: String,
        enable_acoustid_lookup: bool,
        folder_filter: String,
        api_key: Option<String>,
    ) {
        let root_str = root_dir.to_string_lossy().to_string();
        let filter_lower = folder_filter.to_ascii_lowercase();

        let mut audio_files: Vec<PathBuf> = Vec::new();
        for entry in WalkDir::new(&root_dir).into_iter().filter_map(Result::ok) {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if !is_supported_audio_ext(path) {
                continue;
            }
            if !filter_lower.is_empty() {
                let p_low = path.to_string_lossy().to_ascii_lowercase();
                if !p_low.contains(&filter_lower) {
                    continue;
                }
            }
            audio_files.push(path.to_path_buf());
        }
        audio_files.sort();

        {
            let mut rt = self.runtime.lock().unwrap();
            rt.total_files = audio_files.len();
            rt.last_message = format!(
                "Computing Chromaprint fingerprints for {} audio files...",
                audio_files.len()
            );
            rt.updated_at = current_unix_sec();
        }

        let mut fp_entries: Vec<LocalFingerprintEntry> = Vec::with_capacity(audio_files.len());
        let mut proposed_items: Vec<ReunionMoveItem> = Vec::new();
        let mut seen_targets: HashSet<String> = HashSet::new();
        let mut last_api_call: Option<Instant> = None;

        for path in &audio_files {
            if self.pause_flag.load(Ordering::SeqCst) {
                break;
            }
            let path_str = path.to_string_lossy().to_string();
            let file_name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(&path_str)
                .to_string();
            {
                let mut rt = self.runtime.lock().unwrap();
                rt.current_file = file_name;
                rt.updated_at = current_unix_sec();
            }

            let Ok(fs_meta) = std::fs::metadata(path) else {
                let mut rt = self.runtime.lock().unwrap();
                rt.errors += 1;
                rt.processed_files += 1;
                continue;
            };
            let file_size_bytes = fs_meta.len();
            let mtime_sec = fs_meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);

            let scanned_meta = scan_reunion_audio_file(path);
            let container_format = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|s| s.to_ascii_uppercase())
                .unwrap_or_else(|| "AUDIO".to_string());

            let mut record = match cache.get_cached_liberation_fingerprint(
                &path_str,
                file_size_bytes,
                mtime_sec,
            ) {
                Ok(Some(hit)) if !hit.fingerprint_b64.is_empty() && !hit.raw_fingerprint_b64.is_empty() => {
                    let mut rt = self.runtime.lock().unwrap();
                    rt.fingerprinted_cached += 1;
                    hit
                }
                _ => match compute_chromaprint_fingerprint(path) {
                    Ok(computed) => {
                        let rec = LiberationFingerprintRecord {
                            file_path: path_str.clone(),
                            root_dir: root_str.clone(),
                            file_size_bytes,
                            mtime_sec,
                            decoded_duration_sec: computed.duration_sec,
                            fingerprint_b64: computed.compressed_b64,
                            raw_fingerprint_b64: encode_raw_subfingerprints_b64(
                                &computed.raw_subfingerprints,
                            ),
                            acoustid_score: None,
                            mb_recording_id: None,
                            mb_release_id: None,
                            matched_title: None,
                            matched_artist: None,
                            matched_album: None,
                            matched_album_artist: None,
                            matched_track_number: None,
                            matched_track_total: None,
                            matched_disc_number: None,
                            matched_year: None,
                            matched_isrc: None,
                            lookup_status: "local_only".to_string(),
                            updated_at: current_unix_sec(),
                        };
                        let _ = cache.upsert_liberation_fingerprint(&rec);
                        let mut rt = self.runtime.lock().unwrap();
                        rt.fingerprinted_fresh += 1;
                        rec
                    }
                    Err(_) => {
                        let mut rt = self.runtime.lock().unwrap();
                        rt.errors += 1;
                        rt.processed_files += 1;
                        continue;
                    }
                },
            };

            let raw_subfingerprints = decode_raw_subfingerprints_b64(&record.raw_fingerprint_b64);
            let fallback_meta = scanned_meta.unwrap_or_else(|| ScannedAudioFile {
                path: path.clone(),
                dir_path: path.parent().unwrap_or(&root_dir).to_path_buf(),
                title: path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("Track")
                    .to_string(),
                artist: String::new(),
                album_artist: String::new(),
                album: String::new(),
                track_number: None,
                track_total: None,
                disc_number: None,
                year: None,
                isrc: None,
                duration_ms: (record.decoded_duration_sec as u64) * 1000,
            });

            fp_entries.push(LocalFingerprintEntry {
                file_path: path_str.clone(),
                title: fallback_meta.title.clone(),
                artist: fallback_meta.artist.clone(),
                album: fallback_meta.album.clone(),
                file_size_bytes,
                duration_sec: record.decoded_duration_sec,
                container_format,
                raw_subfingerprints,
            });

            let should_lookup = enable_acoustid_lookup
                && (target_mode == "all" || is_drifted_or_unknown_audio_file(&fallback_meta));

            if enable_acoustid_lookup && !should_lookup {
                let mut rt = self.runtime.lock().unwrap();
                rt.clean_skipped += 1;
            }

            if should_lookup {
                if let Some(ref key) = api_key {
                    let resolved_opt: Option<AcoustIdResolvedMatch> =
                        if record.lookup_status == "matched" {
                            Some(AcoustIdResolvedMatch {
                                score: record.acoustid_score.unwrap_or(0.9),
                                title: record.matched_title.clone().unwrap_or_default(),
                                artist: record.matched_artist.clone().unwrap_or_default(),
                                album: record.matched_album.clone().unwrap_or_default(),
                                album_artist: record
                                    .matched_album_artist
                                    .clone()
                                    .or_else(|| record.matched_artist.clone())
                                    .unwrap_or_default(),
                                track_number: record.matched_track_number,
                                track_total: record.matched_track_total,
                                disc_number: record.matched_disc_number,
                                year: record.matched_year,
                                isrc: record.matched_isrc.clone(),
                                mb_recording_id: record.mb_recording_id.clone().unwrap_or_default(),
                                mb_release_id: record.mb_release_id.clone(),
                                release_kind: "Cached Match".to_string(),
                            })
                        } else if record.lookup_status == "unmatched_unique" {
                            let mut rt = self.runtime.lock().unwrap();
                            rt.unmatched_unique += 1;
                            None
                        } else {
                            // Enforce AcoustID rate limit (<= 3 req/s)
                            if let Some(prev) = last_api_call {
                                let elapsed = prev.elapsed();
                                let min_gap = Duration::from_millis(ACOUSTID_MIN_INTERVAL_MS);
                                if elapsed < min_gap {
                                    std::thread::sleep(min_gap - elapsed);
                                }
                            }
                            last_api_call = Some(Instant::now());
                            {
                                let mut rt = self.runtime.lock().unwrap();
                                rt.acoustid_queried += 1;
                            }
                            match lookup_acoustid_recording(
                                key,
                                record.decoded_duration_sec,
                                &record.fingerprint_b64,
                            ) {
                                Ok(json) => {
                                    if let Some(m) = select_best_acoustid_match_with_hint(
                                        &json,
                                        record.decoded_duration_sec,
                                        Some(&fallback_meta),
                                    ) {
                                        record.acoustid_score = Some(m.score);
                                        record.mb_recording_id = Some(m.mb_recording_id.clone());
                                        record.mb_release_id = m.mb_release_id.clone();
                                        record.matched_title = Some(m.title.clone());
                                        record.matched_artist = Some(m.artist.clone());
                                        record.matched_album = Some(m.album.clone());
                                        record.matched_album_artist = Some(m.album_artist.clone());
                                        record.matched_track_number = m.track_number;
                                        record.matched_track_total = m.track_total;
                                        record.matched_disc_number = m.disc_number;
                                        record.matched_year = m.year;
                                        record.matched_isrc = m.isrc.clone();
                                        record.lookup_status = "matched".to_string();
                                        record.updated_at = current_unix_sec();
                                        let _ = cache.upsert_liberation_fingerprint(&record);
                                        Some(m)
                                    } else {
                                        record.lookup_status = "unmatched_unique".to_string();
                                        record.updated_at = current_unix_sec();
                                        let _ = cache.upsert_liberation_fingerprint(&record);
                                        let mut rt = self.runtime.lock().unwrap();
                                        rt.unmatched_unique += 1;
                                        None
                                    }
                                }
                                Err(_) => {
                                    let mut rt = self.runtime.lock().unwrap();
                                    rt.errors += 1;
                                    None
                                }
                            }
                        };

                    if let Some(m) = resolved_opt {
                        let mut rt = self.runtime.lock().unwrap();
                        rt.acoustid_matched += 1;
                        drop(rt);
                        if let Some(item) =
                            build_acoustic_mend_item(&root_dir, &fallback_meta, &m, proposed_items.len())
                        {
                            let target_key = item.target_path.to_ascii_lowercase();
                            if seen_targets.insert(target_key) {
                                proposed_items.push(item);
                                let mut rt = self.runtime.lock().unwrap();
                                rt.proposed_mends = proposed_items.len();
                            }
                        }
                    }
                }
            }

            let mut rt = self.runtime.lock().unwrap();
            rt.processed_files += 1;
            rt.updated_at = current_unix_sec();
        }

        // Unify minority album splits within the same ripped folder (e.g. OST + bonus sampler)
        apply_folder_album_consensus(&root_dir, &mut proposed_items);

        // Run offline acoustic deduplication over all fingerprinted files collected so far
        {
            let mut rt = self.runtime.lock().unwrap();
            rt.last_message = format!(
                "Comparing {} Chromaprint fingerprints for offline acoustic duplicates...",
                fp_entries.len()
            );
            rt.updated_at = current_unix_sec();
        }
        let duplicates = detect_offline_acoustic_duplicates(&fp_entries);

        let now = current_unix_sec();
        let queried_count = self.runtime.lock().unwrap().acoustid_queried;
        let plan = ReunionPlanReport {
            plan_id: format!("acoustic-mend-{now}"),
            root_dir: root_str,
            scanned_files: fp_entries.len(),
            incomplete_albums_found: 0,
            catalog_lookups_performed: queried_count,
            proposed_items: proposed_items.clone(),
            created_at: now,
        };
        store_cached_reunion_plan(&plan);

        *self.last_plan.lock().unwrap() = Some(plan);
        *self.last_duplicates.lock().unwrap() = duplicates.clone();

        let paused = self.pause_flag.load(Ordering::SeqCst);
        let mut rt = self.runtime.lock().unwrap();
        rt.running = false;
        rt.pause_requested = false;
        rt.phase = if paused { "paused" } else { "done" }.to_string();
        rt.proposed_mends = proposed_items.len();
        rt.duplicate_groups_found = duplicates.len();
        rt.current_file.clear();
        rt.last_message = if paused {
            format!(
                "Paused at {}/{} files ({} mend proposals, {} acoustic duplicate groups).",
                rt.processed_files,
                rt.total_files,
                rt.proposed_mends,
                rt.duplicate_groups_found
            )
        } else {
            format!(
                "Acoustic scan complete: {} fingerprinted, {} mend proposals ready for dry-run review, {} unique/uncataloged untouched, {} offline acoustic duplicate groups.",
                rt.processed_files,
                rt.proposed_mends,
                rt.unmatched_unique,
                rt.duplicate_groups_found
            )
        };
        rt.updated_at = current_unix_sec();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("imp_liberation_fp_{label}_{nanos}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Writes a multi-harmonic, time-varying stereo PCM WAV long enough for Chromaprint
    /// to produce a rich, non-degenerate acoustic fingerprint.
    fn write_rich_test_wav(path: &Path, base_freq: f32, duration_ms: u32, amp_scale: f32) {
        let sr: u32 = 44_100;
        let channels: u16 = 2;
        let num_frames = ((sr as u64) * (duration_ms as u64) / 1000) as u32;
        let data_bytes = num_frames * (channels as u32) * 2;
        let mut buf = Vec::with_capacity(44 + data_bytes as usize);
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&1u16.to_le_bytes());
        buf.extend_from_slice(&channels.to_le_bytes());
        buf.extend_from_slice(&sr.to_le_bytes());
        buf.extend_from_slice(&(sr * (channels as u32) * 2).to_le_bytes());
        buf.extend_from_slice(&(channels * 2).to_le_bytes());
        buf.extend_from_slice(&16u16.to_le_bytes());
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&data_bytes.to_le_bytes());

        let notes = [1.0f32, 1.122, 1.26, 1.335, 1.498, 1.682, 1.888, 2.0];
        for i in 0..num_frames {
            let t = (i as f32) / (sr as f32);
            let step = ((t * 2.5) as usize) % notes.len();
            let f1 = base_freq * notes[step];
            let f2 = f1 * 1.5;
            let f3 = f1 * 2.25;
            let env = 0.55 + 0.45 * (t * 3.1).sin().abs();
            let l = ((2.0 * std::f32::consts::PI * f1 * t).sin() * 0.45
                + (2.0 * std::f32::consts::PI * f2 * t).sin() * 0.30
                + (2.0 * std::f32::consts::PI * f3 * t).sin() * 0.20)
                * env
                * amp_scale;
            let r = ((2.0 * std::f32::consts::PI * f1 * t + 0.2).sin() * 0.45
                + (2.0 * std::f32::consts::PI * f2 * t).sin() * 0.30
                + (2.0 * std::f32::consts::PI * f3 * t).sin() * 0.20)
                * env
                * amp_scale;
            let sl = (l.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            let sr_s = (r.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
            buf.extend_from_slice(&sl.to_le_bytes());
            buf.extend_from_slice(&sr_s.to_le_bytes());
        }
        std::fs::write(path, buf).unwrap();
    }

    #[test]
    fn test_compute_chromaprint_and_offline_duplicate_detection() {
        let dir = temp_dir("dup_detect");
        let track_a1 = dir.join("song_a_master.wav");
        let track_a2 = dir.join("song_a_reencode.wav");
        let track_b = dir.join("song_b_different.wav");

        // Same melody at slightly different gain vs completely different melody
        write_rich_test_wav(&track_a1, 220.0, 12_000, 0.85);
        write_rich_test_wav(&track_a2, 220.0, 12_000, 0.62);
        write_rich_test_wav(&track_b, 587.3, 12_000, 0.80);

        let fp_a1 = compute_chromaprint_fingerprint(&track_a1).unwrap();
        let fp_a2 = compute_chromaprint_fingerprint(&track_a2).unwrap();
        let fp_b = compute_chromaprint_fingerprint(&track_b).unwrap();

        assert!(fp_a1.duration_sec >= 11 && fp_a1.duration_sec <= 13);
        assert!(!fp_a1.compressed_b64.is_empty());
        assert!(fp_a1.raw_subfingerprints.len() >= 20);

        // Verify compact SQLite roundtrip encoding
        let enc = encode_raw_subfingerprints_b64(&fp_a1.raw_subfingerprints);
        let dec = decode_raw_subfingerprints_b64(&enc);
        assert_eq!(dec, fp_a1.raw_subfingerprints);

        let entries = vec![
            LocalFingerprintEntry {
                file_path: track_a1.to_string_lossy().to_string(),
                title: "Signal Alpha".to_string(),
                artist: "Sample Artist".to_string(),
                album: "Sample Album".to_string(),
                file_size_bytes: 2_000_000,
                duration_sec: fp_a1.duration_sec,
                container_format: "WAV".to_string(),
                raw_subfingerprints: fp_a1.raw_subfingerprints,
            },
            LocalFingerprintEntry {
                file_path: track_a2.to_string_lossy().to_string(),
                title: "Signal Alpha (Alt)".to_string(),
                artist: "Sample Artist".to_string(),
                album: "Sample Album".to_string(),
                file_size_bytes: 1_500_000,
                duration_sec: fp_a2.duration_sec,
                container_format: "WAV".to_string(),
                raw_subfingerprints: fp_a2.raw_subfingerprints,
            },
            LocalFingerprintEntry {
                file_path: track_b.to_string_lossy().to_string(),
                title: "Signal Beta".to_string(),
                artist: "Other Artist".to_string(),
                album: "Other Album".to_string(),
                file_size_bytes: 2_000_000,
                duration_sec: fp_b.duration_sec,
                container_format: "WAV".to_string(),
                raw_subfingerprints: fp_b.raw_subfingerprints,
            },
        ];

        let groups = detect_offline_acoustic_duplicates(&entries);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].items.len(), 2);
        assert!(groups[0].best_similarity_pct >= 90.0);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_select_best_acoustid_match_prefers_studio_album_and_enforces_guardrails() {
        let payload = serde_json::json!({
            "status": "ok",
            "results": [
                {
                    "id": "aid-1",
                    "score": 0.94,
                    "recordings": [
                        {
                            "id": "rec-studio",
                            "title": "Sample Track One",
                            "duration": 215,
                            "artists": [{ "name": "Example Band" }],
                            "releasegroups": [
                                {
                                    "id": "rg-comp",
                                    "title": "Greatest Hits Vol. 1",
                                    "type": "Album",
                                    "secondarytypes": ["Compilation"],
                                    "artists": [{ "name": "Example Band" }],
                                    "releases": [
                                        {
                                            "id": "rel-comp",
                                            "title": "Greatest Hits Vol. 1",
                                            "date": { "year": 2018 },
                                            "mediums": [{ "position": 1, "track_count": 20, "tracks": [{ "position": 4 }] }]
                                        }
                                    ]
                                },
                                {
                                    "id": "rg-studio",
                                    "title": "First Studio Record",
                                    "type": "Album",
                                    "artists": [{ "name": "Example Band" }],
                                    "releases": [
                                        {
                                            "id": "rel-studio",
                                            "title": "First Studio Record",
                                            "date": { "year": 2004 },
                                            "mediums": [{ "position": 1, "track_count": 11, "tracks": [{ "position": 3 }] }]
                                        }
                                    ]
                                }
                            ]
                        }
                    ]
                }
            ]
        });

        let matched = select_best_acoustid_match(&payload, 214).expect("should match");
        assert_eq!(matched.album, "First Studio Record");
        assert_eq!(matched.track_number, Some(3));
        assert_eq!(matched.track_total, Some(11));
        assert_eq!(matched.year, Some(2004));
        assert_eq!(matched.release_kind, "Studio Album");

        // Duration mismatch (> 8s) must be rejected
        assert!(select_best_acoustid_match(&payload, 260).is_none());

        // Low confidence (< 0.85) must be rejected
        let low_conf = serde_json::json!({
            "status": "ok",
            "results": [{
                "id": "aid-low",
                "score": 0.72,
                "recordings": [{
                    "id": "rec-low",
                    "title": "Uncertain Track",
                    "duration": 200,
                    "artists": [{ "name": "Example Band" }]
                }]
            }]
        });
        assert!(select_best_acoustid_match(&low_conf, 200).is_none());
    }

    #[test]
    fn test_is_drifted_or_unknown_audio_file() {
        let clean = ScannedAudioFile {
            path: PathBuf::from("/tmp/01 Song.flac"),
            dir_path: PathBuf::from("/tmp"),
            title: "Opening Horizon".to_string(),
            artist: "Example Artist".to_string(),
            album_artist: "Example Artist".to_string(),
            album: "Example Album".to_string(),
            track_number: Some(1),
            track_total: Some(10),
            disc_number: Some(1),
            year: Some(2020),
            isrc: None,
            duration_ms: 210_000,
        };
        assert!(!is_drifted_or_unknown_audio_file(&clean));

        let mut drifted = clean.clone();
        drifted.artist = "Unknown Artist".to_string();
        assert!(is_drifted_or_unknown_audio_file(&drifted));

        let mut generic_title = clean.clone();
        generic_title.title = "Track 04".to_string();
        assert!(is_drifted_or_unknown_audio_file(&generic_title));

        let mut missing_num = clean;
        missing_num.track_number = None;
        assert!(is_drifted_or_unknown_audio_file(&missing_num));
    }

    #[test]
    fn test_typography_normalization_instrumental_penalty_and_folder_consensus() {
        // 1. Straight vs curly apostrophe + existing year must produce NO noisy mend
        let local = ScannedAudioFile {
            path: PathBuf::from("/tmp/Artist/Album/01 What's Up.mp3"),
            dir_path: PathBuf::from("/tmp/Artist/Album"),
            title: "What's Up".to_string(),
            artist: "Sample Band".to_string(),
            album_artist: "Sample Band".to_string(),
            album: "Sample Album".to_string(),
            track_number: Some(1),
            track_total: Some(10),
            disc_number: Some(1),
            year: Some(1993),
            isrc: None,
            duration_ms: 290_000,
        };
        let curly_match = AcoustIdResolvedMatch {
            score: 0.98,
            title: "What\u{2019}s Up".to_string(),
            artist: "Sample Band".to_string(),
            album: "Sample Album".to_string(),
            album_artist: "Sample Band".to_string(),
            track_number: Some(1),
            track_total: Some(10),
            disc_number: Some(1),
            year: Some(2005), // reissue year should NOT churn existing 1993 year
            isrc: None,
            mb_recording_id: "rec-1".to_string(),
            mb_release_id: Some("rel-1".to_string()),
            release_kind: "Studio Album".to_string(),
        };
        assert!(build_acoustic_mend_item(Path::new("/tmp"), &local, &curly_match, 0).is_none());

        // 2. Instrumental variant must be penalized when local title is standard
        let inst_payload = serde_json::json!({
            "status": "ok",
            "results": [{
                "id": "aid-inst",
                "score": 0.97,
                "recordings": [
                    {
                        "id": "rec-inst",
                        "title": "Anthem Track (instrumental)",
                        "duration": 193,
                        "artists": [{ "name": "Sample Artist" }],
                        "releasegroups": [{
                            "id": "rg-1",
                            "title": "Debut LP",
                            "type": "Album",
                            "releases": [{ "id": "r1", "title": "Debut LP", "date": { "year": 2003 } }]
                        }]
                    },
                    {
                        "id": "rec-main",
                        "title": "Anthem Track",
                        "duration": 193,
                        "artists": [{ "name": "Sample Artist" }],
                        "releasegroups": [{
                            "id": "rg-1",
                            "title": "Debut LP",
                            "type": "Album",
                            "releases": [{ "id": "r1", "title": "Debut LP", "date": { "year": 2003 } }]
                        }]
                    }
                ]
            }]
        });
        let local_std = ScannedAudioFile {
            title: "Anthem Track".to_string(),
            artist: "Sample Artist".to_string(),
            ..local.clone()
        };
        let picked =
            select_best_acoustid_match_with_hint(&inst_payload, 193, Some(&local_std)).unwrap();
        assert_eq!(picked.title, "Anthem Track");

        // 3. Folder consensus unifies minority bonus-sampler hits into the dominant OST album
        let mut items: Vec<ReunionMoveItem> = (1..=5u32)
            .map(|n| ReunionMoveItem {
                item_id: format!("mend-{n:04}"),
                source_path: format!("/tmp/OST/AudioTrack {n:02}.mp3"),
                target_path: format!("/tmp/Composer/Main OST/{n:02} Track {n}.mp3"),
                title: format!("AudioTrack {n:02}"),
                artist: "Composer".to_string(),
                proposed_title: Some(format!("Real Theme {n}")),
                proposed_artist: None,
                proposed_isrc: None,
                current_album: "OST".to_string(),
                proposed_album: if n == 5 {
                    "Bonus Sampler Book".to_string()
                } else {
                    "Main Game OST".to_string()
                },
                proposed_album_artist: "Composer".to_string(),
                proposed_track_number: Some(n),
                proposed_track_total: Some(if n == 5 { 8 } else { 17 }),
                proposed_disc_number: Some(1),
                proposed_year: Some(2012),
                confidence: "high".to_string(),
                match_reason: "AcoustID 97% (Studio Album)".to_string(),
                catalog_album_id: None,
            })
            .collect();
        apply_folder_album_consensus(Path::new("/tmp"), &mut items);
        assert_eq!(items[4].proposed_album, "Main Game OST");
        assert_eq!(items[4].proposed_track_total, Some(17));
        assert!(items[4].target_path.contains("Main Game OST"));
    }
}
