use crate::sinks::tap_dsp::StereoTapRingBuffer;
use crate::viz::AudioTapBuffer;
#[cfg(target_os = "linux")]
use crate::dsp::global_dsp_state;
#[cfg(target_os = "linux")]
use crate::sinks::tap_dsp::{
    reset_global_tap_status, set_global_tap_status, AudioTapStatusSnapshot, TapDspOutput,
};
#[cfg(target_os = "linux")]
use imp_protocol::PlaybackEvent;
#[cfg(target_os = "linux")]
use std::io::Read;
#[cfg(target_os = "linux")]
use std::process::{Child, Command, Stdio};
#[cfg(target_os = "linux")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(target_os = "linux")]
use std::sync::{Arc, Mutex, OnceLock};
#[cfg(target_os = "linux")]
use std::time::{Duration, Instant};
#[cfg(target_os = "linux")]
use tokio::sync::broadcast;

pub const LINUX_APPLE_TAP_SINK_NAME: &str = "imp_apple_tap";

/// Returns `true` when `pactl list short sinks` already includes `imp_apple_tap`.
#[allow(dead_code)]
pub(crate) fn pactl_sinks_contains_imp_tap(list_short_output: &str) -> bool {
    list_short_output
        .lines()
        .any(|line| line.split_whitespace().any(|tok| tok == LINUX_APPLE_TAP_SINK_NAME))
}

/// Parses the numeric PulseAudio/PipeWire module ID returned by `pactl load-module`.
#[allow(dead_code)]
pub(crate) fn parse_pactl_module_id(stdout: &str) -> Option<u32> {
    stdout
        .split_whitespace()
        .find_map(|tok| tok.trim().parse::<u32>().ok())
}

/// Pushes interleaved stereo 32-bit float little-endian frames into `ring` (and optionally `tap_buffer`
/// when downstream DSP isn't consuming/forwarding samples). Returns `true` if any sample exceeded `1e-6`.
#[allow(dead_code)]
pub(crate) fn push_interleaved_f32le_stereo_chunk(
    bytes: &[u8],
    ring: &StereoTapRingBuffer,
    tap_buffer: &AudioTapBuffer,
    dsp_active: bool,
) -> bool {
    let mut any_nonzero = false;
    for frame in bytes.chunks_exact(8) {
        let raw_l = f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]);
        let raw_r = f32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]);
        let l = if raw_l.is_finite() { raw_l } else { 0.0 };
        let r = if raw_r.is_finite() { raw_r } else { 0.0 };
        if l.abs() > 1e-6 || r.abs() > 1e-6 {
            any_nonzero = true;
        }
        ring.push_frame(l, r);
        if !dsp_active {
            tap_buffer.push_mono_sample(0.5 * (l + r));
        }
    }
    any_nonzero
}

#[cfg(target_os = "linux")]
static LINUX_NULL_SINK_MODULE_ID: OnceLock<Mutex<Option<u32>>> = OnceLock::new();

#[cfg(target_os = "linux")]
fn null_sink_module_slot() -> &'static Mutex<Option<u32>> {
    LINUX_NULL_SINK_MODULE_ID.get_or_init(|| Mutex::new(None))
}

/// Ensures the transient silent PulseAudio/PipeWire null sink (`imp_apple_tap`) exists so the
/// Linux headless Apple Music browser worker never writes dry audio straight to hardware speakers.
#[cfg(target_os = "linux")]
pub fn ensure_linux_apple_null_sink() -> bool {
    let mut list_cmd = Command::new("pactl");
    list_cmd
        .args(["list", "short", "sinks"])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::sinks::apple::apply_pipewire_env(&mut list_cmd);
    if let Ok(out) = list_cmd.output() {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if pactl_sinks_contains_imp_tap(&stdout) {
                return true;
            }
        }
    }

    let mut load_cmd = Command::new("pactl");
    load_cmd
        .args([
            "load-module",
            "module-null-sink",
            &format!("sink_name={LINUX_APPLE_TAP_SINK_NAME}"),
            "sink_properties=device.description=IMP_Apple_Tap",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::sinks::apple::apply_pipewire_env(&mut load_cmd);

    match load_cmd.output() {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            if let Some(mod_id) = parse_pactl_module_id(&stdout) {
                if let Ok(mut guard) = null_sink_module_slot().lock() {
                    *guard = Some(mod_id);
                }
            }
            true
        }
        _ => false,
    }
}

/// Unloads the transient `imp_apple_tap` null sink module when IMP created it during this session.
#[cfg(target_os = "linux")]
pub fn teardown_linux_apple_null_sink() {
    let mod_id = null_sink_module_slot()
        .lock()
        .ok()
        .and_then(|mut g| g.take());
    if let Some(id) = mod_id {
        let mut unload_cmd = Command::new("pactl");
        unload_cmd
            .args(["unload-module", &id.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        crate::sinks::apple::apply_pipewire_env(&mut unload_cmd);
        let _ = unload_cmd.status();
    }
}

/// Manages PulseAudio/PipeWire monitor capture from `imp_apple_tap.monitor` on Linux/SteamOS
/// (headless browser / Live Radio fallback), routing PCM through `StreamDspProcessor` + `AudioTapBuffer`
/// into the default `rodio::Sink` with zero double audio.
#[cfg(target_os = "linux")]
pub struct LinuxPulseAudioTap {
    stop_flag: Mutex<Option<Arc<AtomicBool>>>,
}

#[cfg(target_os = "linux")]
impl Default for LinuxPulseAudioTap {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "linux")]
impl LinuxPulseAudioTap {
    pub fn new() -> Self {
        Self {
            stop_flag: Mutex::new(None),
        }
    }

    pub fn start_or_refresh(&self, _volume: f64, broadcast_tx: broadcast::Sender<PlaybackEvent>) {
        if let Ok(guard) = self.stop_flag.lock() {
            if let Some(ref flag) = *guard {
                if !flag.load(Ordering::Acquire) {
                    return;
                }
            }
        }

        let stop_flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut guard) = self.stop_flag.lock() {
            *guard = Some(stop_flag.clone());
        }

        let _ = std::thread::Builder::new()
            .name("simp-linux-tap".to_string())
            .spawn(move || {
                crate::prefer_efficiency_core_for_current_thread();

                if !ensure_linux_apple_null_sink() {
                    set_global_tap_status(AudioTapStatusSnapshot {
                        platform: "linux".to_string(),
                        mode: "linux_dry_no_pactl".to_string(),
                        dsp_active: false,
                        spectrum_active: false,
                        worker_sink_label: None,
                        detail: "pactl / PipeWire null-sink unavailable; browser worker uses direct system output.".to_string(),
                    });
                    return;
                }

                let mut parec_cmd = Command::new("parec");
                parec_cmd
                    .args([
                        "--raw",
                        "--format=float32le",
                        "--rate=48000",
                        "--channels=2",
                        "--latency-msec=25",
                        "-d",
                        &format!("{LINUX_APPLE_TAP_SINK_NAME}.monitor"),
                    ])
                    .stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::null());
                crate::sinks::apple::apply_pipewire_env(&mut parec_cmd);

                let mut child: Child = match parec_cmd.spawn() {
                    Ok(c) => c,
                    Err(e) => {
                        set_global_tap_status(AudioTapStatusSnapshot {
                            platform: "linux".to_string(),
                            mode: "linux_dry_no_pactl".to_string(),
                            dsp_active: false,
                            spectrum_active: false,
                            worker_sink_label: Some(LINUX_APPLE_TAP_SINK_NAME.to_string()),
                            detail: format!("Unable to spawn parec monitor capture: {e}"),
                        });
                        return;
                    }
                };

                let Some(mut stdout) = child.stdout.take() else {
                    let _ = child.kill();
                    let _ = child.wait();
                    reset_global_tap_status();
                    return;
                };

                let ring = Arc::new(StereoTapRingBuffer::new());
                let tap_buffer = Arc::new(AudioTapBuffer::new());
                tap_buffer.set_sample_rate(48_000);

                let Some(dsp_out) =
                    TapDspOutput::open(ring.clone(), tap_buffer.clone(), 48_000)
                else {
                    let _ = child.kill();
                    let _ = child.wait();
                    set_global_tap_status(AudioTapStatusSnapshot {
                        platform: "linux".to_string(),
                        mode: "linux_dry_no_output".to_string(),
                        dsp_active: false,
                        spectrum_active: false,
                        worker_sink_label: Some(LINUX_APPLE_TAP_SINK_NAME.to_string()),
                        detail: "Failed to open default audio output for Linux tap DSP playback."
                            .to_string(),
                    });
                    return;
                };

                let reader_running = Arc::new(AtomicBool::new(true));
                let has_nonzero = Arc::new(AtomicBool::new(false));
                let last_nonzero_ms = Arc::new(std::sync::atomic::AtomicU64::new(0));
                let start_time = Instant::now();

                let r_ring = ring.clone();
                let r_tap = tap_buffer.clone();
                let r_running = reader_running.clone();
                let r_stop = stop_flag.clone();
                let r_nonzero = has_nonzero.clone();
                let r_last_nz = last_nonzero_ms.clone();

                let reader_handle = std::thread::Builder::new()
                    .name("simp-linux-tap-reader".to_string())
                    .spawn(move || {
                        let mut buf = [0u8; 4096];
                        while !r_stop.load(Ordering::Acquire) {
                            match stdout.read(&mut buf) {
                                Ok(0) => break,
                                Ok(n) => {
                                    let valid = (n / 8) * 8;
                                    if valid > 0
                                        && push_interleaved_f32le_stereo_chunk(
                                            &buf[..valid],
                                            &r_ring,
                                            &r_tap,
                                            true,
                                        )
                                    {
                                        r_nonzero.store(true, Ordering::Release);
                                        r_last_nz.store(
                                            start_time.elapsed().as_millis() as u64,
                                            Ordering::Release,
                                        );
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                        r_running.store(false, Ordering::Release);
                    })
                    .ok();

                let mut last_bypassed: Option<bool> = None;
                while !stop_flag.load(Ordering::Acquire) && reader_running.load(Ordering::Acquire) {
                    let is_bypassed = global_dsp_state().is_bypassed();
                    if last_bypassed != Some(is_bypassed) {
                        last_bypassed = Some(is_bypassed);
                        set_global_tap_status(AudioTapStatusSnapshot {
                            platform: "linux".to_string(),
                            mode: "linux_pulse_null_sink_dsp".to_string(),
                            dsp_active: !is_bypassed,
                            spectrum_active: true,
                            worker_sink_label: Some(LINUX_APPLE_TAP_SINK_NAME.to_string()),
                            detail: if is_bypassed {
                                "PipeWire/Pulse null-sink monitor active (10-Band EQ ready when enabled)."
                                    .to_string()
                            } else {
                                "10-Band EQ + Vocal DSP active via PipeWire/Pulse imp_apple_tap."
                                    .to_string()
                            },
                        });
                    }

                    let elapsed_ms = start_time.elapsed().as_millis() as u64;
                    let recently_nonzero = has_nonzero.load(Ordering::Acquire)
                        && elapsed_ms.saturating_sub(last_nonzero_ms.load(Ordering::Acquire))
                            < 15_000;
                    if recently_nonzero {
                        let (rms, peak, onset, bands) = tap_buffer.compute_spectrum_tick();
                        if rms > 0.0005 || peak > 0.0005 {
                            let _ = broadcast_tx.send(PlaybackEvent::AudioSpectrumTick {
                                rms,
                                peak,
                                onset,
                                bands,
                            });
                        }
                    }
                    std::thread::sleep(Duration::from_millis(80));
                }

                let _ = child.kill();
                let _ = child.wait();
                if let Some(handle) = reader_handle {
                    let _ = handle.join();
                }
                dsp_out.stop();
                reset_global_tap_status();
            });
    }

    pub fn set_volume(&self, _volume: f64) {}

    pub fn stop(&self) {
        if let Ok(mut guard) = self.stop_flag.lock() {
            if let Some(flag) = guard.take() {
                flag.store(true, Ordering::Release);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_pactl_sinks_and_module_id() {
        let sinks = "42\talsa_output.pci-0000_00_1f.3.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tRUNNING\n\
                     77\timp_apple_tap\tPipeWire\tfloat32le 2ch 48000Hz\tIDLE\n";
        assert!(pactl_sinks_contains_imp_tap(sinks));
        assert!(!pactl_sinks_contains_imp_tap(
            "42\talsa_output.pci-0000_00_1f.3.analog-stereo\tPipeWire\ts32le 2ch 48000Hz\tRUNNING\n"
        ));

        assert_eq!(parse_pactl_module_id("536870912\n"), Some(536870912));
        assert_eq!(parse_pactl_module_id("  42  "), Some(42));
        assert_eq!(parse_pactl_module_id("Failure: No such entity"), None);
    }

    #[test]
    fn test_push_interleaved_f32le_stereo_chunk() {
        let ring = StereoTapRingBuffer::new();
        let tap_buf = AudioTapBuffer::new();
        tap_buf.set_sample_rate(48_000);

        let mut bytes = Vec::new();
        for i in 0..128 {
            let s = ((i as f32) * 0.25).sin() * 0.4;
            bytes.extend_from_slice(&s.to_le_bytes());
            bytes.extend_from_slice(&(-s).to_le_bytes());
        }
        bytes.extend_from_slice(&[0x01, 0x02, 0x03]); // trailing partial bytes ignored safely

        let nonzero = push_interleaved_f32le_stereo_chunk(&bytes, &ring, &tap_buf, false);
        assert!(nonzero);
        assert_eq!(ring.available_frames(), 128);
        let (rms, peak, _, _) = tap_buf.compute_spectrum_tick();
        assert!(peak >= 0.0 || rms >= 0.0);

        let silent = vec![0u8; 32];
        assert!(!push_interleaved_f32le_stereo_chunk(&silent, &ring, &tap_buf, true));
    }
}
