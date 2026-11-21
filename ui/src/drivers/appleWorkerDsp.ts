import type { DspConfigEventPayload } from '@simp/client';

const EQ_BAND_FREQS_HZ = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000] as const;
const EME_TAINTED_SESSION_KEY = 'imp_webaudio_eme_tainted';

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return 0;
  return Math.max(min, Math.min(max, val));
}

function isDspEngaged(cfg: DspConfigEventPayload): boolean {
  return Boolean(cfg.eq_enabled || cfg.vocal_mode !== 'off');
}

/**
 * In-worker Web Audio API 10-band biquad EQ + Band-Limited Mid/Side Vocal Stage
 * for Windows Edge WebView2 MusicKit playback (`#apple-music-player`).
 *
 * Lazily attaches via `createMediaElementSource()` only when EQ or Vocal Mode is engaged,
 * and monitors a pre-DSP `AnalyserNode` so any future CDM build that zeroes EME audio
 * automatically falls back cleanly to Tier 2 WASAPI virtual-sink / loopback capture.
 */
export class AppleWorkerWebAudioDsp {
  private readonly isDedicatedWorker: boolean;
  private enabledForPlatform = false;
  private tainted = false;
  private verifiedLive = false;
  private lastReportedActive: boolean | null = null;
  private lastConfig: DspConfigEventPayload = {
    eq_enabled: false,
    eq_preset: 'flat',
    preamp_db: 0,
    bands_db: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    vocal_mode: 'off',
    vocal_strength: 0.9,
  };

  private ctx: AudioContext | null = null;
  private boundAudioEl: HTMLAudioElement | null = null;
  private sourceNode: MediaElementAudioSourceNode | null = null;
  private preDspAnalyser: AnalyserNode | null = null;
  private analyserBuf: Float32Array<ArrayBuffer> | null = null;

  // Stage 1: Mid/Side Vocal Stage (130 Hz .. 4500 Hz)
  private midVocalGain: GainNode | null = null;
  private midNonVocalGain: GainNode | null = null;
  private sideGain: GainNode | null = null;

  // Stage 2: Preamp + 10-Band Biquad Cascade
  private preampGain: GainNode | null = null;
  private eqBands: BiquadFilterNode[] = [];

  private watchdogTimer: number | null = null;
  private silentChecks = 0;
  private firstSilentMediaTimeSec: number | null = null;

  constructor(isDedicatedWorker: boolean) {
    this.isDedicatedWorker = isDedicatedWorker;
    try {
      this.tainted =
        typeof window !== 'undefined' &&
        window.sessionStorage.getItem(EME_TAINTED_SESSION_KEY) === '1';
    } catch {
      this.tainted = false;
    }
  }

  public setEnabledForPlatform(enabled: boolean): void {
    this.enabledForPlatform = enabled;
  }

  public isTainted(): boolean {
    return this.tainted;
  }

  public isActive(): boolean {
    return (
      this.enabledForPlatform &&
      !this.tainted &&
      this.sourceNode !== null &&
      isDspEngaged(this.lastConfig)
    );
  }

  private postWorkerStatus(
    active: boolean,
    mode?: string,
    detail?: string
  ): void {
    const body = active
      ? {
          active: true,
          mode: mode || 'windows_webaudio_dsp',
          spectrum_active: true,
          detail:
            detail ||
            'Windows Web Audio 10-Band EQ + Vocal Stage active (zero virtual cable).',
        }
      : {
          active: false,
          ...(mode ? { mode } : {}),
          ...(detail ? { detail } : {}),
        };

    this.lastReportedActive = active;
    void fetch('/api/dsp/worker-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      keepalive: true,
    }).catch(() => {});
  }

  private ensureGraph(audioEl: HTMLAudioElement): boolean {
    if (this.sourceNode && this.boundAudioEl === audioEl) {
      return true;
    }
    if (typeof window === 'undefined') return false;

    const AudioCtxCtor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!AudioCtxCtor) {
      return false;
    }

    if (this.sourceNode && this.boundAudioEl !== audioEl) {
      this.teardownGraph();
    }

    try {
      const ctx = new AudioCtxCtor();
      const source = ctx.createMediaElementSource(audioEl);

      // Pre-DSP tap for EME taint self-verification (unaffected by EQ cuts)
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);

      // Stage 1: Mid/Side decomposition matching crates/imp-core/src/dsp.rs
      const splitter = ctx.createChannelSplitter(2);
      source.connect(splitter);

      const leftToMid = ctx.createGain();
      leftToMid.gain.value = 0.5;
      const rightToMid = ctx.createGain();
      rightToMid.gain.value = 0.5;
      const midSum = ctx.createGain();
      midSum.gain.value = 1.0;
      splitter.connect(leftToMid, 0);
      splitter.connect(rightToMid, 1);
      leftToMid.connect(midSum);
      rightToMid.connect(midSum);

      const leftToSide = ctx.createGain();
      leftToSide.gain.value = 0.5;
      const rightToSideNeg = ctx.createGain();
      rightToSideNeg.gain.value = -0.5;
      const sideSum = ctx.createGain();
      sideSum.gain.value = 1.0;
      splitter.connect(leftToSide, 0);
      splitter.connect(rightToSideNeg, 1);
      leftToSide.connect(sideSum);
      rightToSideNeg.connect(sideSum);

      // Isolate center vocal band (130 Hz .. 4500 Hz, Butterworth Q = 1/sqrt(2))
      const hpf130 = ctx.createBiquadFilter();
      hpf130.type = 'highpass';
      hpf130.frequency.value = 130;
      hpf130.Q.value = Math.SQRT1_2;

      const lpf4500 = ctx.createBiquadFilter();
      lpf4500.type = 'lowpass';
      lpf4500.frequency.value = 4500;
      lpf4500.Q.value = Math.SQRT1_2;

      midSum.connect(hpf130);
      hpf130.connect(lpf4500);

      // Residual Mid = midSum - midVocal (< 130 Hz sub-bass/kick + > 4.5 kHz air)
      const vocalInvert = ctx.createGain();
      vocalInvert.gain.value = -1.0;
      const midNonVocalSum = ctx.createGain();
      midNonVocalSum.gain.value = 1.0;
      midSum.connect(midNonVocalSum);
      lpf4500.connect(vocalInvert);
      vocalInvert.connect(midNonVocalSum);

      const midVocalGain = ctx.createGain();
      midVocalGain.gain.value = 1.0;
      const midNonVocalGain = ctx.createGain();
      midNonVocalGain.gain.value = 1.0;
      const newMid = ctx.createGain();
      newMid.gain.value = 1.0;
      lpf4500.connect(midVocalGain);
      midNonVocalSum.connect(midNonVocalGain);
      midVocalGain.connect(newMid);
      midNonVocalGain.connect(newMid);

      const sideGain = ctx.createGain();
      sideGain.gain.value = 1.0;
      const newSide = ctx.createGain();
      newSide.gain.value = 1.0;
      sideSum.connect(sideGain);
      sideGain.connect(newSide);

      const sideInvert = ctx.createGain();
      sideInvert.gain.value = -1.0;
      newSide.connect(sideInvert);

      // Recombine L = newMid + newSide, R = newMid - newSide
      const merger = ctx.createChannelMerger(2);
      newMid.connect(merger, 0, 0);
      newMid.connect(merger, 0, 1);
      newSide.connect(merger, 0, 0);
      sideInvert.connect(merger, 0, 1);

      // Stage 2: Preamp + 10-Band Biquad Equalizer
      const preampGain = ctx.createGain();
      preampGain.gain.value = 1.0;
      merger.connect(preampGain);

      let prevNode: AudioNode = preampGain;
      const eqBands: BiquadFilterNode[] = EQ_BAND_FREQS_HZ.map((freq, idx) => {
        const filter = ctx.createBiquadFilter();
        filter.frequency.value = freq;
        if (idx === 0) {
          filter.type = 'lowshelf';
        } else if (idx === 9) {
          filter.type = 'highshelf';
        } else {
          filter.type = 'peaking';
          filter.Q.value = Math.SQRT2;
        }
        filter.gain.value = 0;
        prevNode.connect(filter);
        prevNode = filter;
        return filter;
      });

      // Stage 3: Transparent headroom limiter
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1.5;
      limiter.knee.value = 6.0;
      limiter.ratio.value = 12.0;
      limiter.attack.value = 0.002;
      limiter.release.value = 0.06;

      prevNode.connect(limiter);
      limiter.connect(ctx.destination);

      this.ctx = ctx;
      this.boundAudioEl = audioEl;
      this.sourceNode = source;
      this.preDspAnalyser = analyser;
      this.analyserBuf = new Float32Array(new ArrayBuffer(analyser.fftSize * 4));
      this.midVocalGain = midVocalGain;
      this.midNonVocalGain = midNonVocalGain;
      this.sideGain = sideGain;
      this.preampGain = preampGain;
      this.eqBands = eqBands;
      this.verifiedLive = false;
      this.silentChecks = 0;
      this.firstSilentMediaTimeSec = null;

      this.startWatchdog();
      return true;
    } catch {
      this.tainted = true;
      return false;
    }
  }

  private applyParameters(cfg: DspConfigEventPayload): void {
    const ctx = this.ctx;
    if (
      !ctx ||
      !this.preampGain ||
      !this.midVocalGain ||
      !this.midNonVocalGain ||
      !this.sideGain
    ) {
      return;
    }

    const now = ctx.currentTime;
    const tc = 0.015;

    const eqOn = Boolean(cfg.eq_enabled);
    const preampDb = eqOn ? clamp(cfg.preamp_db, -12, 12) : 0;
    const preampLinear = Math.pow(10, preampDb / 20);
    this.preampGain.gain.setTargetAtTime(preampLinear, now, tc);

    for (let i = 0; i < this.eqBands.length; i++) {
      const targetDb = eqOn ? clamp(cfg.bands_db?.[i] ?? 0, -12, 12) : 0;
      this.eqBands[i].gain.setTargetAtTime(targetDb, now, tc);
    }

    const s = clamp(cfg.vocal_strength ?? 0.9, 0, 1);
    let midVocalTarget = 1.0;
    let midNonVocalTarget = 1.0;
    let sideTarget = 1.0;
    if (cfg.vocal_mode === 'vocal_remover') {
      midVocalTarget = 1.0 - s;
      midNonVocalTarget = 1.0;
      sideTarget = 1.0 + 0.14 * s;
    } else if (cfg.vocal_mode === 'vocal_isolate') {
      midVocalTarget = 1.0 + 0.28 * s;
      midNonVocalTarget = 1.0 - 0.82 * s;
      sideTarget = 1.0 - 0.85 * s;
    }

    this.midVocalGain.gain.setTargetAtTime(midVocalTarget, now, tc);
    this.midNonVocalGain.gain.setTargetAtTime(midNonVocalTarget, now, tc);
    this.sideGain.gain.setTargetAtTime(sideTarget, now, tc);
  }

  private startWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
    }
    this.watchdogTimer = window.setInterval(() => {
      this.checkSignalHealth();
    }, 250);
  }

  private checkSignalHealth(): void {
    const audioEl = this.boundAudioEl;
    const ctx = this.ctx;
    const analyser = this.preDspAnalyser;
    const buf = this.analyserBuf;
    if (!audioEl || !ctx || !analyser || !buf || this.tainted) {
      return;
    }

    if (
      ctx.state !== 'running' ||
      audioEl.paused ||
      audioEl.muted ||
      audioEl.volume <= 0.01 ||
      audioEl.readyState < 2
    ) {
      this.silentChecks = 0;
      this.firstSilentMediaTimeSec = null;
      return;
    }

    analyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const absVal = Math.abs(buf[i]);
      if (absVal > peak) peak = absVal;
    }

    if (peak > 1e-6) {
      this.verifiedLive = true;
      this.silentChecks = 0;
      this.firstSilentMediaTimeSec = null;
      const engaged = isDspEngaged(this.lastConfig);
      if (engaged && this.lastReportedActive !== true) {
        this.postWorkerStatus(true);
      } else if (!engaged && this.lastReportedActive === true) {
        this.postWorkerStatus(false);
      }
      return;
    }

    if (this.verifiedLive) {
      return;
    }

    if (peak <= 1e-7) {
      if (this.firstSilentMediaTimeSec === null) {
        this.firstSilentMediaTimeSec = audioEl.currentTime;
      }
      this.silentChecks += 1;
      const mediaAdvancedSec =
        audioEl.currentTime - this.firstSilentMediaTimeSec;
      if (this.silentChecks >= 12 && mediaAdvancedSec >= 3.0) {
        this.tainted = true;
        try {
          window.sessionStorage.setItem(EME_TAINTED_SESSION_KEY, '1');
        } catch {
          // ignore
        }
        this.postWorkerStatus(
          false,
          'windows_webaudio_tainted',
          'WebView2 EME blocked Web Audio tap; handed back to Windows WASAPI fallback.'
        );
        if (this.isDedicatedWorker) {
          window.setTimeout(() => {
            window.location.reload();
          }, 80);
        }
      }
    } else {
      this.silentChecks = 0;
      this.firstSilentMediaTimeSec = null;
    }
  }

  public sync(
    audioEl: HTMLAudioElement | null,
    cfg: DspConfigEventPayload
  ): void {
    this.lastConfig = {
      ...cfg,
      bands_db: Array.isArray(cfg.bands_db)
        ? cfg.bands_db.slice(0, 10)
        : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    };

    if (!this.enabledForPlatform || this.tainted) {
      return;
    }

    const engaged = isDspEngaged(this.lastConfig);

    if (!this.sourceNode) {
      if (!engaged || !audioEl) {
        return;
      }
      if (!this.ensureGraph(audioEl)) {
        return;
      }
    }

    if (this.ctx && this.ctx.state === 'suspended') {
      void this.ctx.resume().catch(() => {});
    }

    this.applyParameters(this.lastConfig);

    if (engaged) {
      if (
        this.verifiedLive &&
        this.boundAudioEl &&
        !this.boundAudioEl.paused &&
        this.lastReportedActive !== true
      ) {
        this.postWorkerStatus(true);
      }
    } else if (this.lastReportedActive === true) {
      this.postWorkerStatus(false);
    }
  }

  public reportPausedOrInactive(): void {
    this.silentChecks = 0;
    this.firstSilentMediaTimeSec = null;
    if (this.lastReportedActive === true) {
      this.postWorkerStatus(false);
    }
  }

  private teardownGraph(): void {
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    try {
      this.sourceNode?.disconnect();
    } catch {
      // ignore
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
    }
    this.ctx = null;
    this.boundAudioEl = null;
    this.sourceNode = null;
    this.preDspAnalyser = null;
    this.analyserBuf = null;
    this.midVocalGain = null;
    this.midNonVocalGain = null;
    this.sideGain = null;
    this.preampGain = null;
    this.eqBands = [];
    this.verifiedLive = false;
    this.silentChecks = 0;
    this.firstSilentMediaTimeSec = null;
  }

  public dispose(): void {
    this.reportPausedOrInactive();
    this.teardownGraph();
  }
}
