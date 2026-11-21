use crate::library::services_cache::{
    current_unix_sec, LocalAuditRecord, LocalAuditSummary, ServicesCacheDatabase,
};
use crate::sinks::apple_api::detect_audio_container_from_magic;
use anyhow::{anyhow, Result};
use lofty::file::TaggedFileExt;
use lofty::probe::Probe;
use lofty::tag::Accessor;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::fs::File;
use std::io::{Cursor, ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileVerificationResult {
    pub status: String,
    pub file_size_bytes: u64,
    pub container_format: String,
    pub decoded_duration_ms: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub peak_db: Option<f32>,
    pub decode_errors: u64,
    pub blake3_hash: Option<String>,
    pub tag_artist: String,
    pub tag_album: String,
    pub tag_title: String,
    pub tag_track_number: Option<u32>,
    pub has_artwork: bool,
    pub reason: Option<String>,
}

fn read_tag_summary(path: &Path) -> (String, String, String, Option<u32>, bool) {
    let Some(probe) = Probe::open(path)
        .ok()
        .and_then(|p| p.guess_file_type().ok())
    else {
        return (String::new(), String::new(), String::new(), None, false);
    };
    let Ok(tagged) = probe.read() else {
        return (String::new(), String::new(), String::new(), None, false);
    };
    let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) else {
        return (String::new(), String::new(), String::new(), None, false);
    };
    let artist = tag
        .artist()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let album = tag
        .album()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let title = tag
        .title()
        .map(|s| s.trim().to_string())
        .unwrap_or_default();
    let track_number = tag.track();
    let has_artwork = !tag.pictures().is_empty();
    (artist, album, title, track_number, has_artwork)
}

fn compute_blake3_hex(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn parse_leading_id3v2_skip_offset(buf: &[u8]) -> usize {
    let mut off = 0usize;
    while buf.len().saturating_sub(off) >= 10 && &buf[off..off + 3] == b"ID3" {
        let size = (((buf[off + 6] & 0x7f) as usize) << 21)
            | (((buf[off + 7] & 0x7f) as usize) << 14)
            | (((buf[off + 8] & 0x7f) as usize) << 7)
            | ((buf[off + 9] & 0x7f) as usize);
        let footer = if (buf[off + 5] & 0x10) != 0 { 10 } else { 0 };
        let total = 10usize.saturating_add(size).saturating_add(footer);
        if total == 0 || off.saturating_add(total) > buf.len() {
            break;
        }
        off += total;
    }
    off
}

fn plausible_mp3_frame_len(buf: &[u8], pos: usize) -> Option<usize> {
    if pos + 4 > buf.len() {
        return None;
    }
    let b0 = buf[pos];
    let b1 = buf[pos + 1];
    let b2 = buf[pos + 2];
    if b0 != 0xFF || (b1 & 0xE0) != 0xE0 {
        return None;
    }
    let ver = (b1 >> 3) & 0x03;
    let layer = (b1 >> 1) & 0x03;
    let br_idx = (b2 >> 4) & 0x0F;
    let sr_idx = (b2 >> 2) & 0x03;
    if ver == 0x01 || layer != 0x01 || br_idx == 0 || br_idx == 0x0F || sr_idx >= 0x03 {
        return None;
    }
    let bitrate_kbps: usize = match ver {
        0x03 => [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0][br_idx as usize],
        _ => [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0][br_idx as usize],
    };
    let sample_rate: usize = match ver {
        0x03 => [44_100, 48_000, 32_000][sr_idx as usize],
        0x02 => [22_050, 24_000, 16_000][sr_idx as usize],
        _ => [11_025, 12_000, 8_000][sr_idx as usize],
    };
    let padding = ((b2 >> 1) & 0x01) as usize;
    let coeff = if ver == 0x03 { 144 } else { 72 };
    let frame_len = (coeff * bitrate_kbps * 1000) / sample_rate + padding;
    if frame_len < 24 {
        return None;
    }
    Some(frame_len)
}

fn find_fallback_payload_offset(file_path: &Path) -> Option<(u64, Option<&'static str>)> {
    let mut f = File::open(file_path).ok()?;
    let mut buf = vec![0u8; 512 * 1024];
    let n = f.read(&mut buf).ok()?;
    buf.truncate(n);
    if buf.len() < 16 {
        return None;
    }

    let id3_skip = parse_leading_id3v2_skip_offset(&buf);
    let scan_end = buf.len().min(id3_skip.saturating_add(256 * 1024));
    for i in id3_skip..scan_end {
        let rem = &buf[i..];
        let container = if rem.starts_with(b"fLaC") {
            Some("flac")
        } else if rem.len() >= 12 && &rem[4..8] == b"ftyp" {
            Some("m4a")
        } else if rem.starts_with(b"OggS") {
            Some("ogg")
        } else if rem.len() >= 12 && rem.starts_with(b"RIFF") && &rem[8..12] == b"WAVE" {
            Some("wav")
        } else if rem.len() >= 12
            && rem.starts_with(b"FORM")
            && (&rem[8..12] == b"AIFF" || &rem[8..12] == b"AIFC")
        {
            Some("aiff")
        } else {
            None
        };
        if container.is_some() {
            return Some((i as u64, container));
        }
        if let Some(frame_len) = plausible_mp3_frame_len(&buf, i) {
            let next_pos = i + frame_len;
            if next_pos + 2 < buf.len()
                && buf[next_pos] == 0xFF
                && (buf[next_pos + 1] & 0xE0) == 0xE0
            {
                return Some((i as u64, Some("mp3")));
            }
        }
    }

    if id3_skip > 0 && id3_skip < buf.len() {
        return Some((id3_skip as u64, None));
    }
    None
}

struct DecodedAudioStats {
    sample_rate: u32,
    channels: u16,
    decoded_frames: u64,
    decode_errors: u64,
    total_packets: u64,
    peak_abs: f32,
    fatal_error: Option<String>,
}

fn decode_audio_mss(mss: MediaSourceStream, hint_ext: Option<&str>) -> DecodedAudioStats {
    let mut hint = Hint::new();
    if let Some(ext) = hint_ext.map(str::trim).filter(|s| !s.is_empty()) {
        hint.with_extension(ext);
    }

    let probed = match get_probe().format(
        &hint,
        mss,
        &FormatOptions::default(),
        &MetadataOptions::default(),
    ) {
        Ok(p) => p,
        Err(e) => {
            return DecodedAudioStats {
                sample_rate: 0,
                channels: 0,
                decoded_frames: 0,
                decode_errors: 1,
                total_packets: 0,
                peak_abs: 0.0,
                fatal_error: Some(format!("Container probe failed: {e}")),
            };
        }
    };

    let mut format = probed.format;
    let Some(track) = format
        .tracks()
        .iter()
        .find(|t| t.codec_params.codec != CODEC_TYPE_NULL)
    else {
        return DecodedAudioStats {
            sample_rate: 0,
            channels: 0,
            decoded_frames: 0,
            decode_errors: 1,
            total_packets: 0,
            peak_abs: 0.0,
            fatal_error: Some("No decodable audio track found in container".to_string()),
        };
    };

    let track_id = track.id;
    let mut sample_rate = track.codec_params.sample_rate.unwrap_or(0);
    let mut channels = track
        .codec_params
        .channels
        .map(|c| c.count() as u16)
        .unwrap_or(0);

    let mut decoder = match get_codecs().make(&track.codec_params, &DecoderOptions::default()) {
        Ok(d) => d,
        Err(e) => {
            return DecodedAudioStats {
                sample_rate,
                channels,
                decoded_frames: 0,
                decode_errors: 1,
                total_packets: 0,
                peak_abs: 0.0,
                fatal_error: Some(format!("Audio decoder initialization failed: {e}")),
            };
        }
    };

    let mut decoded_frames: u64 = 0;
    let mut decode_errors: u64 = 0;
    let mut total_packets: u64 = 0;
    let mut peak_abs: f32 = 0.0;
    let mut fatal_error: Option<String> = None;
    let mut sample_buf: Option<SampleBuffer<f32>> = None;
    let mut last_spec = None;

    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymphError::IoError(ref err)) if err.kind() == ErrorKind::UnexpectedEof => {
                break;
            }
            Err(SymphError::ResetRequired) => {
                decoder.reset();
                continue;
            }
            Err(SymphError::IoError(err)) => {
                fatal_error = Some(format!("I/O error during stream read: {err}"));
                break;
            }
            Err(err) => {
                fatal_error = Some(format!("Demux error mid-stream: {err}"));
                break;
            }
        };

        if packet.track_id() != track_id {
            continue;
        }
        total_packets += 1;

        match decoder.decode(&packet) {
            Ok(decoded) => {
                let spec = *decoded.spec();
                if spec.rate > 0 {
                    sample_rate = spec.rate;
                }
                channels = spec.channels.count().max(1) as u16;
                decoded_frames += decoded.frames() as u64;

                let needs_realloc = sample_buf
                    .as_ref()
                    .map(|b| b.capacity() < decoded.capacity() || last_spec != Some(spec))
                    .unwrap_or(true);
                if needs_realloc {
                    sample_buf = Some(SampleBuffer::<f32>::new(decoded.capacity() as u64, spec));
                    last_spec = Some(spec);
                }
                if let Some(ref mut sb) = sample_buf {
                    sb.copy_interleaved_ref(decoded);
                    for &s in sb.samples() {
                        let a = s.abs();
                        if a > peak_abs {
                            peak_abs = a;
                        }
                    }
                }
            }
            Err(SymphError::DecodeError(_)) => {
                decode_errors += 1;
                if decode_errors > 64 && decode_errors.saturating_mul(10) > total_packets.max(1) {
                    break;
                }
            }
            Err(SymphError::ResetRequired) => {
                decoder.reset();
            }
            Err(err) => {
                fatal_error = Some(format!("Fatal decode failure: {err}"));
                break;
            }
        }
    }

    DecodedAudioStats {
        sample_rate,
        channels,
        decoded_frames,
        decode_errors,
        total_packets,
        peak_abs,
        fatal_error,
    }
}

/// 4-Stage Audio Integrity Verifier:
/// 1. File size & magic bytes (`drm_m4p` strictly flagged)
/// 2. Full-stream `symphonia` decode to EOF tracking errors, frames, and peak sample amplitude
/// 3. Duration sanity & non-silence check
/// 4. Streaming `blake3` hash & `lofty` tag summary extraction
pub fn verify_audio_file(path: &Path, expected_duration_ms: Option<u64>) -> FileVerificationResult {
    let ext_lower = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let Ok(meta) = std::fs::metadata(path) else {
        return FileVerificationResult {
            status: "unreadable".to_string(),
            file_size_bytes: 0,
            container_format: ext_lower,
            decoded_duration_ms: 0,
            sample_rate: 0,
            channels: 0,
            peak_db: None,
            decode_errors: 0,
            blake3_hash: None,
            tag_artist: String::new(),
            tag_album: String::new(),
            tag_title: String::new(),
            tag_track_number: None,
            has_artwork: false,
            reason: Some("File does not exist or cannot be stat'd".to_string()),
        };
    };

    let file_size_bytes = meta.len();
    if !meta.is_file() || file_size_bytes < 1024 {
        return FileVerificationResult {
            status: "unreadable".to_string(),
            file_size_bytes,
            container_format: ext_lower,
            decoded_duration_ms: 0,
            sample_rate: 0,
            channels: 0,
            peak_db: None,
            decode_errors: 0,
            blake3_hash: None,
            tag_artist: String::new(),
            tag_album: String::new(),
            tag_title: String::new(),
            tag_track_number: None,
            has_artwork: false,
            reason: Some(format!("File too small or invalid ({file_size_bytes} bytes)")),
        };
    }

    let mut head = [0u8; 512];
    let head_len = match File::open(path).and_then(|mut f| f.read(&mut head)) {
        Ok(n) => n,
        Err(e) => {
            return FileVerificationResult {
                status: "unreadable".to_string(),
                file_size_bytes,
                container_format: ext_lower,
                decoded_duration_ms: 0,
                sample_rate: 0,
                channels: 0,
                peak_db: None,
                decode_errors: 0,
                blake3_hash: None,
                tag_artist: String::new(),
                tag_album: String::new(),
                tag_title: String::new(),
                tag_track_number: None,
                has_artwork: false,
                reason: Some(format!("Unable to open/read header: {e}")),
            };
        }
    };

    let detected_container = detect_audio_container_from_magic(&head[..head_len]);
    let container_format = detected_container
        .map(|s| s.to_string())
        .unwrap_or_else(|| ext_lower.clone());

    if ext_lower == "m4p" || detected_container == Some("drm_m4p") {
        let (tag_artist, tag_album, tag_title, tag_track_number, has_artwork) =
            read_tag_summary(path);
        return FileVerificationResult {
            status: "drm_protected_m4p".to_string(),
            file_size_bytes,
            container_format: "drm_m4p".to_string(),
            decoded_duration_ms: 0,
            sample_rate: 0,
            channels: 0,
            peak_db: None,
            decode_errors: 0,
            blake3_hash: None,
            tag_artist,
            tag_album,
            tag_title,
            tag_track_number,
            has_artwork,
            reason: Some("Legacy FairPlay M4P DRM audio — cannot verify or reclaim".to_string()),
        };
    }

    // Stage 2: Symphonia full-stream decode (with unhinted & ID3v2/payload-offset fallback)
    let file_for_decode = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            return FileVerificationResult {
                status: "unreadable".to_string(),
                file_size_bytes,
                container_format: ext_lower,
                decoded_duration_ms: 0,
                sample_rate: 0,
                channels: 0,
                peak_db: None,
                decode_errors: 0,
                blake3_hash: None,
                tag_artist: String::new(),
                tag_album: String::new(),
                tag_title: String::new(),
                tag_track_number: None,
                has_artwork: false,
                reason: Some(format!("Failed to reopen for decode: {e}")),
            };
        }
    };

    let (tag_artist, tag_album, tag_title, tag_track_number, has_artwork) = read_tag_summary(path);
    let primary_hint = if !ext_lower.is_empty() && ext_lower != "part" {
        Some(ext_lower.as_str())
    } else if !container_format.is_empty() {
        Some(container_format.as_str())
    } else {
        None
    };

    let mut stats = decode_audio_mss(
        MediaSourceStream::new(Box::new(file_for_decode), Default::default()),
        primary_hint,
    );

    if (stats.fatal_error.is_some() || stats.decoded_frames == 0) && primary_hint.is_some() {
        if let Ok(unhinted_file) = File::open(path) {
            let alt = decode_audio_mss(
                MediaSourceStream::new(Box::new(unhinted_file), Default::default()),
                None,
            );
            if alt.fatal_error.is_none() && alt.decoded_frames > stats.decoded_frames {
                stats = alt;
            }
        }
    }

    if stats.fatal_error.is_some() || stats.decoded_frames == 0 {
        if let Some((offset, fallback_ext)) = find_fallback_payload_offset(path) {
            if let Ok(all_bytes) = std::fs::read(path) {
                let slice_start = offset as usize;
                if slice_start < all_bytes.len() {
                    let payload = all_bytes[slice_start..].to_vec();
                    let alt = decode_audio_mss(
                        MediaSourceStream::new(Box::new(Cursor::new(payload)), Default::default()),
                        fallback_ext,
                    );
                    if alt.fatal_error.is_none() && alt.decoded_frames > stats.decoded_frames {
                        stats = alt;
                    }
                }
            }
        }
    }

    let sample_rate = stats.sample_rate;
    let channels = stats.channels;
    let decoded_frames = stats.decoded_frames;
    let decode_errors = stats.decode_errors;
    let total_packets = stats.total_packets;
    let peak_abs = stats.peak_abs;
    let decoded_duration_ms = if sample_rate > 0 {
        (decoded_frames.saturating_mul(1000)) / (sample_rate as u64)
    } else {
        0
    };
    let peak_db = if peak_abs > 0.0 {
        Some(20.0 * peak_abs.log10())
    } else {
        None
    };

    if let Some(err_msg) = stats.fatal_error {
        return FileVerificationResult {
            status: "corrupt_decode".to_string(),
            file_size_bytes,
            container_format,
            decoded_duration_ms,
            sample_rate,
            channels,
            peak_db,
            decode_errors: decode_errors.max(1),
            blake3_hash: None,
            tag_artist,
            tag_album,
            tag_title,
            tag_track_number,
            has_artwork,
            reason: Some(err_msg),
        };
    }

    if decoded_frames == 0
        || (decode_errors > 25 && decode_errors.saturating_mul(20) > total_packets.max(1))
    {
        return FileVerificationResult {
            status: "corrupt_decode".to_string(),
            file_size_bytes,
            container_format,
            decoded_duration_ms,
            sample_rate,
            channels,
            peak_db,
            decode_errors,
            blake3_hash: None,
            tag_artist,
            tag_album,
            tag_title,
            tag_track_number,
            has_artwork,
            reason: Some(if decoded_frames == 0 {
                "Decoded 0 audio frames from stream".to_string()
            } else {
                format!("Exceeded decode error threshold ({decode_errors} frame decode errors)")
            }),
        };
    }

    // Stage 3: Duration & Non-Silence Checks
    if peak_abs < 1e-4 {
        return FileVerificationResult {
            status: "silent_audio".to_string(),
            file_size_bytes,
            container_format,
            decoded_duration_ms,
            sample_rate,
            channels,
            peak_db,
            decode_errors,
            blake3_hash: None,
            tag_artist,
            tag_album,
            tag_title,
            tag_track_number,
            has_artwork,
            reason: Some("Decoded audio stream is pure digital silence".to_string()),
        };
    }

    if let Some(exp_ms) = expected_duration_ms {
        if exp_ms >= 15_000 {
            let diff = decoded_duration_ms.abs_diff(exp_ms);
            let severely_truncated = decoded_duration_ms < exp_ms
                && diff > 5_000
                && (decoded_duration_ms < 10_000
                    || (decoded_duration_ms as f64) < (exp_ms as f64 * 0.55));
            if severely_truncated {
                return FileVerificationResult {
                    status: "truncated_duration".to_string(),
                    file_size_bytes,
                    container_format,
                    decoded_duration_ms,
                    sample_rate,
                    channels,
                    peak_db,
                    decode_errors,
                    blake3_hash: None,
                    tag_artist,
                    tag_album,
                    tag_title,
                    tag_track_number,
                    has_artwork,
                    reason: Some(format!(
                        "Decoded duration {}ms mismatches expected {}ms",
                        decoded_duration_ms, exp_ms
                    )),
                };
            }
        }
    }

    // Stage 4: Streaming BLAKE3 integrity digest
    let blake3_hash = compute_blake3_hex(path).ok();

    FileVerificationResult {
        status: "verified_ok".to_string(),
        file_size_bytes,
        container_format,
        decoded_duration_ms,
        sample_rate,
        channels,
        peak_db,
        decode_errors,
        blake3_hash,
        tag_artist,
        tag_album,
        tag_title,
        tag_track_number,
        has_artwork,
        reason: None,
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalAuditRuntimeStatus {
    pub phase: String,
    pub running: bool,
    pub pause_requested: bool,
    pub root_dir: String,
    pub total_files: usize,
    pub audited_files: usize,
    pub current_file: String,
    pub last_message: String,
    pub started_at: Option<i64>,
    pub updated_at: i64,
}

impl Default for LocalAuditRuntimeStatus {
    fn default() -> Self {
        Self {
            phase: "idle".to_string(),
            running: false,
            pause_requested: false,
            root_dir: String::new(),
            total_files: 0,
            audited_files: 0,
            current_file: String::new(),
            last_message: "Choose any local folder (e.g., reclaimed library or Music.app downloads) to audit.".to_string(),
            started_at: None,
            updated_at: current_unix_sec(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LocalAuditStatusResponse {
    pub runtime: LocalAuditRuntimeStatus,
    pub summary: LocalAuditSummary,
}

pub struct LocalAuditController {
    runtime: Mutex<LocalAuditRuntimeStatus>,
    pause_flag: Arc<AtomicBool>,
}

impl Default for LocalAuditController {
    fn default() -> Self {
        Self {
            runtime: Mutex::new(LocalAuditRuntimeStatus::default()),
            pause_flag: Arc::new(AtomicBool::new(false)),
        }
    }
}

pub fn global_local_audit_controller() -> &'static Arc<LocalAuditController> {
    static CTRL: OnceLock<Arc<LocalAuditController>> = OnceLock::new();
    CTRL.get_or_init(|| Arc::new(LocalAuditController::default()))
}

fn is_auditable_audio_ext(path: &Path) -> bool {
    let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
        return false;
    };
    matches!(
        ext.to_ascii_lowercase().as_str(),
        "m4a" | "mp3" | "flac" | "wav" | "aiff" | "aif" | "aac" | "ogg" | "opus" | "m4p"
    )
}

impl LocalAuditController {
    pub fn status(&self, cache: &ServicesCacheDatabase) -> Result<LocalAuditStatusResponse> {
        let runtime = self.runtime.lock().unwrap().clone();
        let root_filter = if runtime.root_dir.is_empty() {
            None
        } else {
            Some(runtime.root_dir.as_str())
        };
        let summary = cache.get_local_audit_summary(root_filter)?;
        Ok(LocalAuditStatusResponse { runtime, summary })
    }

    pub fn pause(&self) -> Result<()> {
        self.pause_flag.store(true, Ordering::SeqCst);
        let mut rt = self.runtime.lock().unwrap();
        if rt.running {
            rt.pause_requested = true;
            rt.last_message = "Pause requested — waiting for active file checks to finish...".to_string();
            rt.updated_at = current_unix_sec();
        }
        Ok(())
    }

    pub fn start(
        self: &Arc<Self>,
        root_dir: PathBuf,
        cache: ServicesCacheDatabase,
    ) -> Result<LocalAuditStatusResponse> {
        if self.runtime.lock().unwrap().running {
            return self.status(&cache);
        }
        if !root_dir.is_dir() {
            return Err(anyhow!(
                "Directory does not exist: {}",
                root_dir.to_string_lossy()
            ));
        }
        let root_str = root_dir.to_string_lossy().to_string();
        cache.clear_local_audit_for_root(&root_str)?;

        self.pause_flag.store(false, Ordering::SeqCst);
        let now = current_unix_sec();
        {
            let mut rt = self.runtime.lock().unwrap();
            *rt = LocalAuditRuntimeStatus {
                phase: "scanning".to_string(),
                running: true,
                pause_requested: false,
                root_dir: root_str.clone(),
                total_files: 0,
                audited_files: 0,
                current_file: String::new(),
                last_message: format!("Scanning audio files inside {root_str}..."),
                started_at: Some(now),
                updated_at: now,
            };
        }

        let ctrl = Arc::clone(self);
        let cache_clone = cache.clone();
        std::thread::Builder::new()
            .name("imp-liberation-audit".to_string())
            .spawn(move || {
                ctrl.run_worker(root_dir, root_str, cache_clone);
            })?;

        self.status(&cache)
    }

    fn run_worker(&self, root_dir: PathBuf, root_str: String, cache: ServicesCacheDatabase) {
        let mut files: Vec<PathBuf> = WalkDir::new(&root_dir)
            .follow_links(false)
            .into_iter()
            .filter_map(|e| e.ok())
            .filter(|e| {
                e.file_type().is_file()
                    && !e
                        .file_name()
                        .to_string_lossy()
                        .ends_with(".imp.part")
                    && !e.file_name().to_string_lossy().starts_with("._")
                    && is_auditable_audio_ext(e.path())
            })
            .map(|e| e.into_path())
            .collect();
        files.sort();

        let total_files = files.len();
        {
            let mut rt = self.runtime.lock().unwrap();
            rt.phase = "verifying".to_string();
            rt.total_files = total_files;
            rt.updated_at = current_unix_sec();
            rt.last_message = format!("Running 4-stage integrity verification across {total_files} files...");
        }

        let queue = Mutex::new(VecDeque::from(files));
        std::thread::scope(|scope| {
            for _ in 0..3 {
                scope.spawn(|| loop {
                    if self.pause_flag.load(Ordering::SeqCst) {
                        break;
                    }
                    let next_path = { queue.lock().unwrap().pop_front() };
                    let Some(path) = next_path else {
                        break;
                    };

                    let res = verify_audio_file(&path, None);
                    let path_str = path.to_string_lossy().to_string();
                    let rec = LocalAuditRecord {
                        file_path: path_str.clone(),
                        root_dir: root_str.clone(),
                        file_size_bytes: res.file_size_bytes,
                        container_format: res.container_format,
                        status: res.status.clone(),
                        decoded_duration_ms: res.decoded_duration_ms,
                        sample_rate: res.sample_rate,
                        channels: res.channels,
                        peak_db: res.peak_db,
                        decode_errors: res.decode_errors,
                        blake3_hash: res.blake3_hash,
                        tag_artist: res.tag_artist,
                        tag_album: res.tag_album,
                        tag_title: res.tag_title,
                        tag_track_number: res.tag_track_number,
                        has_artwork: res.has_artwork,
                        reason: res.reason,
                        audited_at: current_unix_sec(),
                    };
                    let _ = cache.upsert_local_audit_record(&rec);

                    let mut rt = self.runtime.lock().unwrap();
                    rt.audited_files += 1;
                    rt.current_file = path_str;
                    rt.updated_at = current_unix_sec();
                    rt.last_message = format!(
                        "Audited {} / {} files...",
                        rt.audited_files, total_files
                    );
                });
            }
        });

        let paused = self.pause_flag.load(Ordering::SeqCst);
        let summary = cache.get_local_audit_summary(Some(&root_str)).unwrap_or_default();
        let bad_count = summary.total_files.saturating_sub(summary.verified_ok);
        let mut rt = self.runtime.lock().unwrap();
        rt.running = false;
        rt.pause_requested = false;
        rt.phase = if paused {
            "paused".to_string()
        } else {
            "completed".to_string()
        };
        rt.updated_at = current_unix_sec();
        rt.last_message = if paused {
            format!("Audit paused ({} / {} files verified).", rt.audited_files, total_files)
        } else {
            format!(
                "4-Stage Audit complete: {} OK · {} flagged ({} corrupt, {} truncated, {} silent, {} M4P DRM).",
                summary.verified_ok,
                bad_count,
                summary.corrupt_decode,
                summary.truncated_duration,
                summary.silent_audio,
                summary.drm_protected_m4p
            )
        };
    }
}

#[cfg(test)]
pub(crate) mod test_helpers {
    use std::io::Write;
    use std::path::Path;

    pub fn write_test_wav(path: &Path, freq_hz: f32, amplitude: f32, duration_ms: u32) {
        let sample_rate: u32 = 44_100;
        let channels: u16 = 2;
        let bits_per_sample: u16 = 16;
        let total_frames = ((sample_rate as u64) * (duration_ms as u64)) / 1000;
        let data_bytes = (total_frames as u32) * (channels as u32) * 2;
        let byte_rate = sample_rate * (channels as u32) * 2;
        let block_align = channels * 2;

        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).unwrap();
        }
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"RIFF").unwrap();
        f.write_all(&(36 + data_bytes).to_le_bytes()).unwrap();
        f.write_all(b"WAVE").unwrap();
        f.write_all(b"fmt ").unwrap();
        f.write_all(&16u32.to_le_bytes()).unwrap();
        f.write_all(&1u16.to_le_bytes()).unwrap();
        f.write_all(&channels.to_le_bytes()).unwrap();
        f.write_all(&sample_rate.to_le_bytes()).unwrap();
        f.write_all(&byte_rate.to_le_bytes()).unwrap();
        f.write_all(&block_align.to_le_bytes()).unwrap();
        f.write_all(&bits_per_sample.to_le_bytes()).unwrap();
        f.write_all(b"data").unwrap();
        f.write_all(&data_bytes.to_le_bytes()).unwrap();

        for i in 0..total_frames {
            let t = (i as f32) / (sample_rate as f32);
            let val = if amplitude > 0.0 {
                (t * freq_hz * 2.0 * std::f32::consts::PI).sin() * amplitude * 32_000.0
            } else {
                0.0
            };
            let s = (val.round() as i16).to_le_bytes();
            f.write_all(&s).unwrap();
            f.write_all(&s).unwrap();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_helpers::write_test_wav;
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> PathBuf {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let p = std::env::temp_dir().join(format!("imp_liberation_verify_{label}_{nanos}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn test_verify_audio_file_valid_sine_wav() {
        let dir = temp_dir("valid");
        let wav = dir.join("01 Track 01.wav");
        write_test_wav(&wav, 440.0, 0.5, 120);

        let res = verify_audio_file(&wav, None);
        assert_eq!(res.status, "verified_ok", "reason={:?}", res.reason);
        assert!(res.blake3_hash.as_ref().map(|h| h.len() == 64).unwrap_or(false));
        assert!(res.decoded_duration_ms >= 100);
        assert!(res.peak_db.unwrap_or(-100.0) > -12.0);
        assert_eq!(res.container_format, "wav");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_verify_audio_file_silent_wav() {
        let dir = temp_dir("silent");
        let wav = dir.join("02 Silent Track.wav");
        write_test_wav(&wav, 440.0, 0.0, 120);

        let res = verify_audio_file(&wav, None);
        assert_eq!(res.status, "silent_audio");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn test_verify_audio_file_truncated_duration_and_corrupt_and_m4p() {
        let dir = temp_dir("bad");
        let short_wav = dir.join("short.wav");
        write_test_wav(&short_wav, 440.0, 0.4, 120);
        let trunc = verify_audio_file(&short_wav, Some(25_000));
        assert_eq!(trunc.status, "truncated_duration");

        let corrupt = dir.join("corrupt.m4a");
        std::fs::write(&corrupt, vec![0xAAu8; 2048]).unwrap();
        let corr_res = verify_audio_file(&corrupt, None);
        assert_eq!(corr_res.status, "corrupt_decode");

        let m4p = dir.join("legacy.m4p");
        let mut m4p_bytes = vec![0u8; 2048];
        m4p_bytes[..12].copy_from_slice(b"\x00\x00\x00\x18ftypM4P ");
        std::fs::write(&m4p, &m4p_bytes).unwrap();
        let m4p_res = verify_audio_file(&m4p, None);
        assert_eq!(m4p_res.status, "drm_protected_m4p");

        // Audio longer than stale cloud metadata OR ~80% duration MUST pass verified_ok
        let full_wav = dir.join("valid_full.wav");
        write_test_wav(&full_wav, 440.0, 0.5, 20_000);
        assert_eq!(verify_audio_file(&full_wav, Some(15_000)).status, "verified_ok");
        assert_eq!(verify_audio_file(&full_wav, Some(25_000)).status, "verified_ok");

        // Stacked ID3v2 header in front of a valid WAV payload should decode via fallback offset
        let stacked_path = dir.join("stacked_id3.mp3");
        let wav_bytes = std::fs::read(&full_wav).unwrap();
        let mut stacked = b"ID3\x04\x00\x00\x00\x00\x00\x04ABCD".to_vec();
        stacked.extend_from_slice(&wav_bytes);
        std::fs::write(&stacked_path, &stacked).unwrap();
        let stacked_res = verify_audio_file(&stacked_path, Some(20_000));
        assert_eq!(stacked_res.status, "verified_ok", "reason={:?}", stacked_res.reason);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
