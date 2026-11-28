import React, { useEffect, useRef, useState } from 'react';
import {
  defaultSimpClient,
  SimpStateSnapshot,
  TrackMetadata,
} from '@imp/client';
import { ProgressBarRaf } from '../../components/ProgressBarRaf';
import { getSourceThemeForTrack } from '../../theme/sourceTheme';
import { ImpIcon } from '../../components/icons/ImpIcon';
import { StatsHudPill } from '../../components/StatsHudPill';
import {
  loadEnabledVisualizerScenes,
  PlayerBackgroundVisualizer,
  VISUALIZER_MODES,
  type VisualizerEngine,
  type VisualizerMode,
} from '../../components/PlayerBackgroundVisualizer';

function readSavedVizMode(): VisualizerMode {
  try {
    const saved = window.localStorage.getItem('simp.visualizer_mode') as VisualizerMode | null;
    if (saved && VISUALIZER_MODES.some((m) => m.id === saved)) {
      return saved;
    }
  } catch {}
  return 'cycle';
}

export interface LibraryMiniPlayerBarProps {
  track: TrackMetadata | null;
  snap: SimpStateSnapshot | null;
  hidden?: boolean;
  desktopMode?: boolean;
  onReturnToPlayer: () => void;
  onTriggerScreensaver?: () => void;
  onOpenPlayingQueue?: () => void;
  applyVolume: (nextVol: number) => void;
  currentVolume: number;
  volumePopoverOpen: boolean;
  setVolumePopoverOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isPlaying: boolean;
  volPct: number;
  brightnessPopoverOpen: boolean;
  setBrightnessPopoverOpen: React.Dispatch<React.SetStateAction<boolean>>;
  brightnessPct: number;
  setBrightnessPct: React.Dispatch<React.SetStateAction<number>>;
  sourceModalOpen: boolean;
  powerModalOpen: boolean;
  setSourceModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPowerModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  expiredAuthProviders?: Array<'apple' | 'soundcloud'>;
}

const MiniSpectrumCanvas: React.FC<{
  isPlaying: boolean;
  hidden: boolean;
  trackUri: string | null;
  accentColor: string;
  idleColor: string;
}> = ({ isPlaying, hidden, trackUri, accentColor, idleColor }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const targetBandsRef = useRef<Float32Array>(new Float32Array(16));
  const curBandsRef = useRef<Float32Array>(new Float32Array(16));
  const lastSpecPerfRef = useRef<number>(0);

  useEffect(() => {
    if (hidden || !trackUri) return;
    const unsub = defaultSimpClient.subscribeSpectrum((frame) => {
      lastSpecPerfRef.current = performance.now();
      const len = Math.min(16, frame.bands.length);
      for (let i = 0; i < len; i++) {
        targetBandsRef.current[i] = Math.max(0, Math.min(1, frame.bands[i] / 255));
      }
    });
    return unsub;
  }, [hidden, trackUri]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
    const logicalW = 84;
    const logicalH = 22;
    if (canvas.width !== logicalW * dpr || canvas.height !== logicalH * dpr) {
      canvas.width = logicalW * dpr;
      canvas.height = logicalH * dpr;
    }

    const drawBars = (playing: boolean) => {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, logicalW, logicalH);

      const barCount = 16;
      const barW = 3.5;
      const gap = 1.6;
      const startX = 2;
      const now = performance.now();
      const usingFallback = playing && now - lastSpecPerfRef.current > 450;
      const t = now * 0.001;

      for (let i = 0; i < barCount; i++) {
        let target = targetBandsRef.current[i];
        if (!playing) {
          target = 0;
        } else if (usingFallback) {
          target =
            0.18 +
            0.55 * Math.abs(Math.sin(t * 2.7 + i * 0.55)) * Math.abs(Math.cos(t * 1.6 - i * 0.3));
        }
        const prev = curBandsRef.current[i];
        const next = playing ? prev + (target - prev) * (target > prev ? 0.38 : 0.16) : 0;
        curBandsRef.current[i] = next;

        const barH = playing ? Math.max(2, next * (logicalH - 3)) : 2;
        const x = startX + i * (barW + gap);
        const y = logicalH - 1.5 - barH;
        ctx.fillStyle = playing ? accentColor : idleColor;
        ctx.beginPath();
        ctx.roundRect(x, y, barW, barH, 1.5);
        ctx.fill();
      }
      ctx.restore();
    };

    if (hidden || !isPlaying) {
      drawBars(false);
      return;
    }

    // Paced 15 FPS timer (0 FPS when tab/window is hidden) instead of uncapped 240Hz rAF
    let intervalId: number | null = null;
    const syncTimer = () => {
      const active = document.visibilityState !== 'hidden';
      if (active && intervalId === null) {
        drawBars(true);
        intervalId = window.setInterval(() => {
          if (document.visibilityState !== 'hidden') {
            drawBars(true);
          }
        }, 66);
      } else if (!active && intervalId !== null) {
        window.clearInterval(intervalId);
        intervalId = null;
      }
    };
    syncTimer();
    document.addEventListener('visibilitychange', syncTimer);
    return () => {
      document.removeEventListener('visibilitychange', syncTimer);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [isPlaying, hidden, accentColor, idleColor]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        width: 84,
        height: 22,
        display: 'block',
        pointerEvents: 'none',
      }}
    />
  );
};

export const LibraryMiniPlayerBar: React.FC<LibraryMiniPlayerBarProps> = ({
  track,
  snap,
  hidden = false,
  desktopMode = false,
  onReturnToPlayer,
  onTriggerScreensaver,
  onOpenPlayingQueue,
  applyVolume,
  currentVolume,
  volumePopoverOpen,
  setVolumePopoverOpen,
  isPlaying,
  volPct,
  brightnessPopoverOpen,
  setBrightnessPopoverOpen,
  brightnessPct,
  setBrightnessPct,
  sourceModalOpen,
  powerModalOpen,
  setSourceModalOpen,
  setPowerModalOpen,
  expiredAuthProviders = [],
}) => {
  const theme = getSourceThemeForTrack(track?.uri, track?.source);
  const [metaHovered, setMetaHovered] = useState(false);
  const [vizMode, setVizMode] = useState<VisualizerMode>(() => readSavedVizMode());
  const [enabledVizScenes, setEnabledVizScenes] = useState<VisualizerEngine[]>(() =>
    loadEnabledVisualizerScenes()
  );

  useEffect(() => {
    const syncVizConfig = () => {
      setVizMode(readSavedVizMode());
      setEnabledVizScenes(loadEnabledVisualizerScenes());
    };
    window.addEventListener('simp-viz-config-changed', syncVizConfig);
    window.addEventListener('storage', syncVizConfig);
    return () => {
      window.removeEventListener('simp-viz-config-changed', syncVizConfig);
      window.removeEventListener('storage', syncVizConfig);
    };
  }, []);

  const isVideoTrack = Boolean(
    track &&
      (track.source === 'ia_video' ||
        track.source === 'local_video' ||
        track.source === 'dvd' ||
        track.uri.startsWith('ia:video:') ||
        track.uri.startsWith('ia://video/') ||
        track.uri.startsWith('video://local/') ||
        track.uri.startsWith('dvd://'))
  );

  const handleArtOrVizClick = () => {
    if (desktopMode && !isVideoTrack && onTriggerScreensaver) {
      onTriggerScreensaver();
    } else {
      onReturnToPlayer();
    }
  };

  const openSelectOptions = () => {
    setVolumePopoverOpen(false);
    setBrightnessPopoverOpen(false);
    setPowerModalOpen(false);
    if (!track) {
      setSourceModalOpen((v) => !v);
      return;
    }
    setSourceModalOpen(false);
    window.dispatchEvent(new CustomEvent('simp-player-actions-toggle'));
  };

  const toggleStartSettings = () => {
    setVolumePopoverOpen(false);
    setBrightnessPopoverOpen(false);
    setPowerModalOpen(false);
    setSourceModalOpen((v) => !v);
  };

  const dockArtworkThumb = track?.art_url ? (
    <img
      src={track.art_url}
      alt=""
      style={{
        width: 22,
        height: 22,
        borderRadius: 5,
        objectFit: 'cover',
        border: `1px solid ${theme.accent}`,
        flexShrink: 0,
      }}
    />
  ) : (
    <div
      style={{
        width: 22,
        height: 22,
        borderRadius: 5,
        background: '#11141e',
        border: `1px solid ${track ? theme.accent : '#2a3142'}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      {track?.source === 'apple_music' ? (
        <ImpIcon name="apple" size={11} color="#fda4af" />
      ) : track?.source === 'soundcloud' ? (
        <ImpIcon name="soundcloud" size={9} color="#ffffff" />
      ) : track?.source === 'internet_archive' || track?.source === 'ia_video' ? (
        <ImpIcon name="archive" size={11} color="#6ee7b7" />
      ) : track ? (
        <ImpIcon name="music" size={11} color="#d4d4dc" />
      ) : (
        <ImpIcon name="disc" size={12} color="#9ca3af" />
      )}
    </div>
  );

  return (
    <div
      data-mini-player-bar="true"
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        gap: 4,
        minHeight: 82,
        padding: '6px 12px',
        background: 'var(--imp-surface-panel, #161920)',
        borderBottom: track
          ? `1px solid ${theme.accentBorder}`
          : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
        boxSizing: 'border-box',
        minWidth: 0,
        position: 'relative',
        zIndex: 40,
      }}
    >
      {/* Row 1 — SELECT (left) + Centered Transport Controls + Volume + Brightness + START (right) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          height: 24,
          minWidth: 0,
          position: 'relative',
          zIndex: volumePopoverOpen || brightnessPopoverOpen ? 65 : 46,
        }}
      >
        <button
          type="button"
          data-row-aux="true"
          onClick={openSelectOptions}
          title="Track Options, Visualizer & Interface Settings (SELECT)"
          style={{
            height: 24,
            padding: '0 8px',
            borderRadius: 6,
            background: '#10121a',
            border: '1px solid #222634',
            color: '#d4d4dc',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 5,
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          <ImpIcon name="gamepad-select" size={12} color="#9ca3af" />
          <span
            className="simp-gp-badge"
            style={{
              color: '#9ca3af',
              fontSize: 9,
              fontFamily: 'monospace',
              fontWeight: 700,
              letterSpacing: 0.3,
              lineHeight: 1,
            }}
          >
            SELECT
          </span>
        </button>

        <div
          style={{
            flex: 1,
            minWidth: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <button
              data-row-aux="true"
              onClick={() => defaultSimpClient.previous()}
              title="Previous Track"
              style={{
                height: 24,
                padding: '0 9px',
                borderRadius: 6,
                background: '#10121a',
                border: '1px solid #222634',
                color: '#d4d4dc',
                fontSize: 11,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ImpIcon name="skip-back" size={12} />
            </button>
            <button
              data-row-aux="true"
              onClick={() => defaultSimpClient.togglePlayPause()}
              title={snap?.is_playing ? 'Pause' : 'Play'}
              style={{
                height: 24,
                padding: '0 12px',
                borderRadius: 6,
                background: snap?.is_playing ? theme.accentMuted : '#141622',
                border: snap?.is_playing ? `1px solid ${theme.accent}` : '1px solid #2a2e3e',
                color: snap?.is_playing ? theme.accent : '#f1f5f9',
                fontSize: 11,
                fontWeight: 800,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ImpIcon name={snap?.is_playing ? 'pause' : 'play'} size={12} />
            </button>
            <button
              data-row-aux="true"
              onClick={() => defaultSimpClient.next()}
              title="Next Track"
              style={{
                height: 24,
                padding: '0 9px',
                borderRadius: 6,
                background: '#10121a',
                border: '1px solid #222634',
                color: '#d4d4dc',
                fontSize: 11,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ImpIcon name="skip-forward" size={12} />
            </button>
            <button
              data-row-aux="true"
              onClick={() => {
                const cur = snap?.repeat_mode || 'off';
                const next = cur === 'off' ? 'queue' : cur === 'queue' ? 'track' : 'off';
                defaultSimpClient.setRepeat(next);
              }}
              title={
                snap?.repeat_mode === 'track'
                  ? 'Repeat: 1 Track'
                  : snap?.repeat_mode === 'queue'
                  ? 'Repeat: Queue (∞)'
                  : 'Repeat: Off'
              }
              style={{
                position: 'relative',
                height: 24,
                padding: '0 9px',
                borderRadius: 6,
                background:
                  snap?.repeat_mode && snap.repeat_mode !== 'off' ? '#161822' : '#10121a',
                border:
                  snap?.repeat_mode && snap.repeat_mode !== 'off'
                    ? '1px solid #383c52'
                    : '1px solid #222634',
                color:
                  snap?.repeat_mode && snap.repeat_mode !== 'off' ? '#e2e8f0' : '#8e8e99',
                fontSize: 11,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ImpIcon name="repeat" size={12} />
              {snap?.repeat_mode && snap.repeat_mode !== 'off' && (
                <span
                  style={{
                    position: 'absolute',
                    right: 2,
                    bottom: 1,
                    minWidth: 10,
                    height: 10,
                    padding: '0 2px',
                    borderRadius: 999,
                    background: '#0e1018',
                    border: '1px solid #383c52',
                    color: '#e2e8f0',
                    fontSize: 7.5,
                    fontFamily: 'monospace',
                    fontWeight: 900,
                    lineHeight: '8px',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {snap.repeat_mode === 'track' ? '1' : '∞'}
                </span>
              )}
            </button>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexShrink: 0,
          }}
        >
            <StatsHudPill track={track} compact />
            <div
              onWheel={(e) => {
                e.preventDefault();
                const delta = e.deltaY < 0 ? 0.05 : -0.05;
                applyVolume(currentVolume + delta);
              }}
              style={{
                height: 24,
                borderRadius: 6,
                background: 'var(--imp-surface-card, #1a1d24)',
                border: volumePopoverOpen
                  ? '1px solid #383c52'
                  : isPlaying
                  ? '1px solid #2e3242'
                  : '1px solid #22222c',
                display: 'flex',
                alignItems: 'stretch',
                position: 'relative',
                fontFamily: 'monospace',
                overflow: 'visible',
              }}
            >
              <button
                type="button"
                data-row-aux="true"
                onClick={() => defaultSimpClient.togglePlayPause()}
                title={
                  isPlaying
                    ? 'Audio Active — Click to Pause (Silence)'
                    : 'Paused (Silenced) — Click to Resume'
                }
                style={{
                  padding: '0 7px',
                  border: 'none',
                  borderRight: '1px solid #1e1e28',
                  borderTopLeftRadius: 5,
                  borderBottomLeftRadius: 5,
                  background: isPlaying ? '#141622' : '#10121a',
                  color: isPlaying ? '#e2e8f0' : '#9ca3af',
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                }}
              >
                <ImpIcon name={!isPlaying ? 'volume-mute' : 'volume'} size={12} />
              </button>

              <button
                type="button"
                data-row-aux="true"
                onClick={() => {
                  setBrightnessPopoverOpen(false);
                  setVolumePopoverOpen((v) => !v);
                }}
                title="Open vertical volume slider"
                style={{
                  padding: '0 7px',
                  border: 'none',
                  borderTopRightRadius: 5,
                  borderBottomRightRadius: 5,
                  background: volumePopoverOpen ? '#161822' : 'transparent',
                  color: isPlaying ? '#c8c8d2' : '#8e8e99',
                  fontSize: 11,
                  fontFamily: 'monospace',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 3,
                }}
              >
                <span>{volPct}%</span>
                <span style={{ fontSize: 9, color: '#71717a' }}>▾</span>
              </button>

              {volumePopoverOpen && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    top: 28,
                    right: 0,
                    width: 74,
                    padding: '14px 10px',
                    borderRadius: 16,
                    background: 'var(--imp-surface-elevated, #21252f)',
                    border: '2px solid #383c52',
                    boxShadow: '0 12px 28px rgba(0,0,0,0.85)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 10,
                    zIndex: 65,
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      fontWeight: 800,
                      color: isPlaying ? '#e2e8f0' : '#9ca3af',
                    }}
                  >
                    {volPct}%
                  </span>
                  <div
                    style={{
                      height: 128,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <input
                      type="range"
                      min={5}
                      max={100}
                      step={1}
                      value={volPct}
                      onChange={(e) => applyVolume(Number(e.target.value) / 100)}
                      style={{
                        width: 120,
                        accentColor: '#94a3b8',
                        transform: 'rotate(-90deg)',
                        cursor: 'pointer',
                      }}
                    />
                  </div>
                  <button
                    onClick={() => defaultSimpClient.togglePlayPause()}
                    style={{
                      width: '100%',
                      padding: '4px 0',
                      borderRadius: 8,
                      background: '#161822',
                      border: isPlaying ? '1px solid #383c52' : '1px solid #2a2a38',
                      color: isPlaying ? '#e2e8f0' : '#d4d4dc',
                      fontSize: 10,
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    {isPlaying ? '⏸ Pause' : '▶ Play'}
                  </button>
                </div>
              )}
            </div>

            <div style={{ position: 'relative', flexShrink: 0 }}>
              <button
                type="button"
                data-row-aux="true"
                onClick={() => {
                  setVolumePopoverOpen(false);
                  setBrightnessPopoverOpen((v) => !v);
                }}
                title="Adjust OLED screen brightness"
                style={{
                  height: 24,
                  padding: '0 8px',
                  borderRadius: 6,
                  background: brightnessPopoverOpen ? '#161822' : 'var(--imp-surface-card, #1a1d24)',
                  border: brightnessPopoverOpen ? '1px solid #383c52' : '1px solid #22222c',
                  color: brightnessPopoverOpen ? '#e2e8f0' : '#c8c8d2',
                  fontSize: 11,
                  fontFamily: 'monospace',
                  fontWeight: 700,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <ImpIcon name={brightnessPct >= 50 ? 'sun' : 'moon'} size={12} />
                <span>{brightnessPct}%</span>
                <span style={{ fontSize: 9, color: '#71717a' }}>▾</span>
              </button>

              {brightnessPopoverOpen && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  style={{
                    position: 'absolute',
                    top: 28,
                    right: 0,
                    width: 68,
                    padding: '14px 10px',
                    borderRadius: 16,
                    background: 'var(--imp-surface-elevated, #21252f)',
                    border: '2px solid #383c52',
                    boxShadow: '0 12px 28px rgba(0,0,0,0.85)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    gap: 10,
                    zIndex: 65,
                  }}
                >
                  <span style={{ fontSize: 11, fontWeight: 800, color: '#e2e8f0' }}>
                    {brightnessPct}%
                  </span>
                  <div
                    style={{
                      height: 128,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <input
                      type="range"
                      min={25}
                      max={100}
                      step={1}
                      value={brightnessPct}
                      onChange={(e) => setBrightnessPct(Number(e.target.value))}
                      style={{
                        width: 120,
                        accentColor: '#94a3b8',
                        transform: 'rotate(-90deg)',
                        cursor: 'pointer',
                      }}
                    />
                  </div>
                </div>
              )}
            </div>

            <button
              type="button"
              data-row-aux="true"
              onClick={toggleStartSettings}
              title={
                expiredAuthProviders.length > 0
                  ? `Settings Menu (START) — Re-sign in required (${expiredAuthProviders
                      .map((p) => (p === 'apple' ? 'Apple Music' : 'SoundCloud'))
                      .join(', ')})`
                  : 'Settings Menu (START)'
              }
              style={{
                position: 'relative',
                height: 24,
                padding: '0 8px',
                borderRadius: 6,
                background: sourceModalOpen || powerModalOpen ? '#161822' : '#10121a',
                border:
                  sourceModalOpen || powerModalOpen
                    ? '1px solid #383c52'
                    : expiredAuthProviders.length > 0
                    ? '1px solid rgba(239, 68, 68, 0.65)'
                    : '1px solid #222634',
                color: sourceModalOpen || powerModalOpen ? '#e2e8f0' : '#d4d4dc',
                fontSize: 12,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                flexShrink: 0,
              }}
            >
              <span
                className="simp-gp-badge"
                style={{
                  color: '#9ca3af',
                  fontSize: 9,
                  fontFamily: 'monospace',
                  fontWeight: 700,
                  letterSpacing: 0.3,
                  lineHeight: 1,
                }}
              >
                START
              </span>
              <span style={{ lineHeight: 1 }}>☰</span>
              {expiredAuthProviders.length > 0 && (
                <span
                  aria-label="Account sign-in attention"
                  style={{
                    position: 'absolute',
                    top: -5,
                    right: -5,
                    width: 14,
                    height: 14,
                    borderRadius: '50%',
                    background: '#ef4444',
                    border: '1.5px solid #0b0d14',
                    color: '#ffffff',
                    fontSize: 9.5,
                    fontWeight: 900,
                    lineHeight: 1,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    boxShadow: '0 2px 6px rgba(239, 68, 68, 0.6)',
                    pointerEvents: 'none',
                  }}
                >
                  !
                </span>
              )}
            </button>
        </div>
      </div>

      {/* Rows 2 & 3 — 16:9 Mini-Visualizer (left spanning rows 2–3) + [Art/Title] & [Scrub Bar/EQ] */}
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 10,
          minWidth: 0,
        }}
      >
        <button
          type="button"
          data-row-aux="true"
          onClick={handleArtOrVizClick}
          title={
            !desktopMode
              ? 'Open Full Player View (L1)'
              : desktopMode && !isVideoTrack
              ? 'Launch Visualizer Screensaver'
              : 'Open Player / Video Stage'
          }
          style={{
            position: 'relative',
            width: 96,
            height: 52,
            alignSelf: 'center',
            padding: 0,
            borderRadius: 7,
            overflow: 'hidden',
            background: '#05060a',
            border: `1px solid ${snap?.is_playing && track ? theme.accentBorder : '#22222c'}`,
            cursor: 'pointer',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {!desktopMode && (
            <span
              className="simp-gp-badge"
              style={{
                position: 'absolute',
                top: 3,
                left: 3,
                zIndex: 2,
                padding: '1px 4px',
                borderRadius: 4,
                background: 'rgba(14, 16, 24, 0.85)',
                border: '1px solid #2a2a38',
                color: '#9ca3af',
                fontSize: 8.5,
                fontFamily: 'monospace',
                fontWeight: 800,
              }}
            >
              L1
            </span>
          )}
          {vizMode !== 'off' && !isVideoTrack ? (
            <PlayerBackgroundVisualizer
              embedded
              mode={vizMode}
              enabledScenes={enabledVizScenes}
              isPlaying={Boolean(snap?.is_playing && track)}
              track={track}
              artUrl={track?.art_url || null}
              hidden={hidden}
            />
          ) : (
            <MiniSpectrumCanvas
              isPlaying={Boolean(snap?.is_playing && track)}
              hidden={hidden}
              trackUri={track?.uri || null}
              accentColor={theme.accent}
              idleColor={track ? theme.accentBorder : '#242938'}
            />
          )}
        </button>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
            gap: 4,
            flex: 1,
            minWidth: 0,
          }}
        >
          {/* Row 2 — Art + Title/Metadata (clicks push to Playing Queue in library view) */}
          {(() => {
            const queueCount = snap?.queue?.length || (track ? 1 : 0);
            const canOpenQueue = Boolean(onOpenPlayingQueue && (track || queueCount > 0));
            if (!track) {
              return (
                <div
                  style={{
                    height: 24,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 7,
                    minWidth: 0,
                  }}
                >
                  {dockArtworkThumb}
                  <span
                    style={{
                      color: '#64748b',
                      fontSize: 11.5,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    No track playing — select any album, playlist, or song below
                  </span>
                </div>
              );
            }
            return (
              <button
                type="button"
                data-row-aux="true"
                onClick={() => {
                  if (canOpenQueue) onOpenPlayingQueue?.();
                }}
                onMouseEnter={() => setMetaHovered(true)}
                onMouseLeave={() => setMetaHovered(false)}
                title={
                  canOpenQueue
                    ? `View Playing Queue (${queueCount} track${queueCount === 1 ? '' : 's'})`
                    : `${track.title}`
                }
                style={{
                  height: 24,
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  padding: '0 6px 0 2px',
                  borderRadius: 6,
                  background:
                    metaHovered && canOpenQueue ? 'rgba(255, 255, 255, 0.06)' : 'transparent',
                  border:
                    metaHovered && canOpenQueue
                      ? '1px solid rgba(255, 255, 255, 0.14)'
                      : '1px solid transparent',
                  cursor: canOpenQueue ? 'pointer' : 'default',
                  textAlign: 'left',
                  minWidth: 0,
                  transition: 'background 120ms ease, border-color 120ms ease',
                }}
              >
                {dockArtworkThumb}
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 800,
                    color: '#f1f5f9',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    flex: '0 1 auto',
                    minWidth: 0,
                  }}
                >
                  {track.title}
                </span>
                {(track.artists?.length || track.album) && (
                  <span
                    style={{
                      fontSize: 11,
                      color: '#94a3b8',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      flex: '1 1 0',
                      minWidth: 0,
                    }}
                  >
                    — {track.artists.join(', ')}
                    {track.album ? ` • ${track.album}` : ''}
                  </span>
                )}
                {queueCount > 1 && (
                  <span
                    style={{
                      fontSize: 10,
                      fontFamily: 'monospace',
                      fontWeight: 700,
                      color: metaHovered ? '#e2e8f0' : '#94a3b8',
                      background: 'rgba(255, 255, 255, 0.05)',
                      border: '1px solid rgba(255, 255, 255, 0.08)',
                      borderRadius: 4,
                      padding: '1px 5px',
                      flexShrink: 0,
                      lineHeight: 1.2,
                    }}
                  >
                    {(snap?.queue_index ?? 0) + 1}/{queueCount}
                  </span>
                )}
              </button>
            );
          })()}

          {/* Row 3 — Full-width Scrub Bar + EQ */}
          <div
            style={{
              height: 24,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              minWidth: 0,
            }}
          >
            <div style={{ flex: '1 1 0%', minWidth: 120, display: 'flex', alignItems: 'center' }}>
              {track ? (
                <div style={{ width: '100%' }}>
                  <ProgressBarRaf
                    durationMs={track.duration_ms || 0}
                    trackUri={track.uri}
                    compact
                    hidden={hidden}
                  />
                </div>
              ) : (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    width: '100%',
                    color: '#475569',
                    fontSize: 10,
                    fontFamily: 'monospace',
                  }}
                >
                  <span>00:00</span>
                  <div style={{ height: 4, flex: 1, borderRadius: 999, background: '#141620' }} />
                  <span>00:00</span>
                </div>
              )}
            </div>

            <button
              type="button"
              data-row-aux="true"
              onClick={() => window.dispatchEvent(new CustomEvent('simp-equalizer-toggle'))}
              title="10-Band Audio Equalizer & Vocal Stage"
              style={{
                height: 24,
                padding: '0 8px',
                borderRadius: 6,
                background: 'var(--imp-surface-card, #1a1d24)',
                border: '1px solid #22222c',
                color: '#c8c8d2',
                fontSize: 10.5,
                fontWeight: 700,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              <ImpIcon name="sliders" size={11} color="#9ca3af" />
              <span>EQ</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
