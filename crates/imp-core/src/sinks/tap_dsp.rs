use crate::dsp::{global_dsp_state, StreamDspProcessor};
use crate::viz::AudioTapBuffer;
use rodio::{OutputStream, Sink, Source};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

const RING_CAPACITY_FRAMES: usize = 16_384; // ~341ms @ 48 kHz
const RING_MASK: usize = RING_CAPACITY_FRAMES - 1;

/// Live cross-platform audio tap telemetry surfaced in `/api/dsp` and `EqualizerModal`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, Default, PartialEq, Eq)]
pub struct AudioTapStatusSnapshot {
    pub platform: String,
    pub mode: String,
    pub dsp_active: bool,
    pub spectrum_active: bool,
    pub worker_sink_label: Option<String>,
    pub detail: String,
}

static GLOBAL_TAP_STATUS: OnceLock<Mutex<AudioTapStatusSnapshot>> = OnceLock::new();
static WORKER_NATIVE_DSP_ACTIVE: AtomicBool = AtomicBool::new(false);
static WORKER_NATIVE_DSP_STATUS: OnceLock<Mutex<Option<AudioTapStatusSnapshot>>> = OnceLock::new();

fn global_tap_status_slot() -> &'static Mutex<AudioTapStatusSnapshot> {
    GLOBAL_TAP_STATUS.get_or_init(|| Mutex::new(AudioTapStatusSnapshot::default()))
}

fn worker_native_dsp_status_slot() -> &'static Mutex<Option<AudioTapStatusSnapshot>> {
    WORKER_NATIVE_DSP_STATUS.get_or_init(|| Mutex::new(None))
}

pub fn global_tap_status() -> AudioTapStatusSnapshot {
    global_tap_status_slot()
        .lock()
        .map(|g| g.clone())
        .unwrap_or_default()
}

pub fn set_global_tap_status(snapshot: AudioTapStatusSnapshot) {
    if let Ok(mut g) = global_tap_status_slot().lock() {
        *g = snapshot;
    }
}

pub fn set_worker_native_dsp_status(status: Option<AudioTapStatusSnapshot>) {
    let active = status.as_ref().map(|s| s.dsp_active).unwrap_or(false);
    WORKER_NATIVE_DSP_ACTIVE.store(active, Ordering::Release);
    if let Ok(mut g) = worker_native_dsp_status_slot().lock() {
        *g = status;
    }
}

pub fn is_worker_native_dsp_active() -> bool {
    WORKER_NATIVE_DSP_ACTIVE.load(Ordering::Acquire)
}

pub fn worker_native_dsp_status() -> Option<AudioTapStatusSnapshot> {
    worker_native_dsp_status_slot()
        .lock()
        .map(|g| g.clone())
        .ok()
        .flatten()
}

pub fn reset_global_tap_status() {
    set_worker_native_dsp_status(None);
    set_global_tap_status(AudioTapStatusSnapshot::default());
}

/// Lock-free single-producer / single-consumer ring buffer holding interleaved stereo `f32` frames.
pub struct StereoTapRingBuffer {
    samples: Vec<AtomicU32>,
    write_frames: AtomicU64,
    read_frames: AtomicU64,
}

impl Default for StereoTapRingBuffer {
    fn default() -> Self {
        Self::new()
    }
}

impl StereoTapRingBuffer {
    pub fn new() -> Self {
        let mut samples = Vec::with_capacity(RING_CAPACITY_FRAMES * 2);
        for _ in 0..(RING_CAPACITY_FRAMES * 2) {
            samples.push(AtomicU32::new(0.0f32.to_bits()));
        }
        Self {
            samples,
            write_frames: AtomicU64::new(0),
            read_frames: AtomicU64::new(0),
        }
    }

    pub fn clear(&self) {
        let w = self.write_frames.load(Ordering::Acquire);
        self.read_frames.store(w, Ordering::Release);
    }

    pub fn retain_recent(&self, max_frames: u64) {
        let w = self.write_frames.load(Ordering::Acquire);
        let r = self.read_frames.load(Ordering::Relaxed);
        let min_r = w.saturating_sub(max_frames);
        if r < min_r || r > w {
            self.read_frames.store(min_r, Ordering::Release);
        }
    }

    pub fn available_frames(&self) -> u64 {
        let w = self.write_frames.load(Ordering::Acquire);
        let r = self.read_frames.load(Ordering::Relaxed);
        w.saturating_sub(r)
    }

    #[inline]
    pub fn push_frame(&self, left: f32, right: f32) {
        let w = self.write_frames.load(Ordering::Relaxed);
        let idx = ((w as usize) & RING_MASK) * 2;
        self.samples[idx].store(left.to_bits(), Ordering::Relaxed);
        self.samples[idx + 1].store(right.to_bits(), Ordering::Relaxed);
        self.write_frames.store(w.wrapping_add(1), Ordering::Release);
    }

    /// Reads the next stereo frame `(left, right)`, keeping buffered latency bounded below ~85ms.
    #[inline]
    pub fn pop_frame(&self) -> Option<(f32, f32)> {
        let w = self.write_frames.load(Ordering::Acquire);
        let mut r = self.read_frames.load(Ordering::Relaxed);
        if w <= r {
            return None;
        }
        let avail = w.saturating_sub(r);
        if avail > 4096 {
            r = w - 1024;
        }
        let idx = ((r as usize) & RING_MASK) * 2;
        let left = f32::from_bits(self.samples[idx].load(Ordering::Relaxed));
        let right = f32::from_bits(self.samples[idx + 1].load(Ordering::Relaxed));
        self.read_frames.store(r.wrapping_add(1), Ordering::Release);
        Some((left, right))
    }
}

pub(crate) struct TapDspSource {
    ring: Arc<StereoTapRingBuffer>,
    tap_buffer: Arc<AudioTapBuffer>,
    dsp: StreamDspProcessor,
    sample_rate: u32,
    running: Arc<AtomicBool>,
    pending_right: Option<f32>,
}

impl TapDspSource {
    pub(crate) fn new(
        ring: Arc<StereoTapRingBuffer>,
        tap_buffer: Arc<AudioTapBuffer>,
        sample_rate: u32,
        running: Arc<AtomicBool>,
    ) -> Self {
        let sr = sample_rate.clamp(8_000, 192_000);
        tap_buffer.set_sample_rate(sr);
        Self {
            ring,
            tap_buffer,
            dsp: StreamDspProcessor::new(global_dsp_state(), sr),
            sample_rate: sr,
            running,
            pending_right: None,
        }
    }
}

impl Iterator for TapDspSource {
    type Item = f32;

    #[inline]
    fn next(&mut self) -> Option<f32> {
        if !self.running.load(Ordering::Relaxed) {
            return None;
        }
        if let Some(r_out) = self.pending_right.take() {
            return Some(r_out);
        }
        let (l_in, r_in) = self.ring.pop_frame().unwrap_or((0.0, 0.0));
        let (l_out, r_out) = self.dsp.process_stereo(l_in, r_in, self.sample_rate);
        self.tap_buffer.push_mono_sample(0.5 * (l_out + r_out));
        self.pending_right = Some(r_out);
        Some(l_out)
    }
}

impl Source for TapDspSource {
    fn current_frame_len(&self) -> Option<usize> {
        None
    }

    fn channels(&self) -> u16 {
        2
    }

    fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    fn total_duration(&self) -> Option<Duration> {
        None
    }
}

pub(crate) struct TapDspOutput {
    _stream: OutputStream,
    sink: Sink,
    running: Arc<AtomicBool>,
}

impl TapDspOutput {
    pub(crate) fn open(
        ring: Arc<StereoTapRingBuffer>,
        tap_buffer: Arc<AudioTapBuffer>,
        sample_rate: u32,
    ) -> Option<Self> {
        let (_stream, handle) = OutputStream::try_default().ok()?;
        let sink = Sink::try_new(&handle).ok()?;
        // Upstream audio worker already scales output amplitude by `perceptual_cubic_gain(volume)`.
        sink.set_volume(1.0);
        ring.retain_recent(1024);
        let prime_frames = ((sample_rate as u64 * 20) / 1000).clamp(256, 960);
        for _ in 0..12 {
            if ring.available_frames() >= prime_frames {
                break;
            }
            std::thread::sleep(Duration::from_millis(2));
        }
        let running = Arc::new(AtomicBool::new(true));
        let src = TapDspSource::new(ring, tap_buffer, sample_rate, running.clone());
        sink.append(src);
        sink.play();
        Some(Self {
            _stream,
            sink,
            running,
        })
    }

    pub(crate) fn stop(self) {
        self.running.store(false, Ordering::Release);
        self.sink.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_tap_dsp_ring_and_status_roundtrip() {
        reset_global_tap_status();
        assert_eq!(global_tap_status(), AudioTapStatusSnapshot::default());

        let snap = AudioTapStatusSnapshot {
            platform: "test".to_string(),
            mode: "unit_test_dsp".to_string(),
            dsp_active: true,
            spectrum_active: true,
            worker_sink_label: Some("Sample Virtual Sink".to_string()),
            detail: "OK".to_string(),
        };
        set_global_tap_status(snap.clone());
        assert_eq!(global_tap_status(), snap);

        let ring = StereoTapRingBuffer::new();
        ring.push_frame(0.25, -0.25);
        assert_eq!(ring.available_frames(), 1);
        assert_eq!(ring.pop_frame(), Some((0.25, -0.25)));
        assert_eq!(ring.pop_frame(), None);

        reset_global_tap_status();
        assert!(!is_worker_native_dsp_active());
        assert_eq!(worker_native_dsp_status(), None);

        let worker_snap = AudioTapStatusSnapshot {
            platform: "windows".to_string(),
            mode: "windows_webaudio_dsp".to_string(),
            dsp_active: true,
            spectrum_active: true,
            worker_sink_label: None,
            detail: "Web Audio active".to_string(),
        };
        set_worker_native_dsp_status(Some(worker_snap.clone()));
        assert!(is_worker_native_dsp_active());
        assert_eq!(worker_native_dsp_status(), Some(worker_snap));

        reset_global_tap_status();
        assert!(!is_worker_native_dsp_active());
        assert_eq!(worker_native_dsp_status(), None);
    }
}
