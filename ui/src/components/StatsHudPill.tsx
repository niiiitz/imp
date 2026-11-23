import React, { useEffect, useState } from 'react';
import { TrackMetadata } from '@imp/client';
import { resolveDaemonUrl } from '../api/servicesCacheApi';
import { extractAudioFormat } from '../views/library/libraryHelpers';

const STATS_HUD_STORAGE_KEY = 'imp_stats_hud_enabled_v1';

interface StatsPerfSnapshot {
  cpu_percent: number;
  rss_mb: number;
}

export function loadStatsHudEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(STATS_HUD_STORAGE_KEY);
    if (raw === '0' || raw === 'false') return false;
  } catch {
    // ignore storage errors
  }
  return true;
}

export function saveStatsHudEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(STATS_HUD_STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ignore storage errors
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('imp-stats-hud-changed', { detail: { enabled } }));
  }
}

function formatTrackBadge(track: TrackMetadata | null | undefined): string | null {
  if (!track) return null;
  const ext = extractAudioFormat(track.uri);
  if (ext) return ext;
  if (track.source === 'apple_music') return 'AM';
  if (track.source === 'soundcloud') return 'SC';
  if (track.source === 'internet_archive') return 'IA';
  if (track.source === 'ia_video' || track.source === 'local_video') return 'VID';
  if (track.source === 'cdda') return 'CD';
  if (track.source === 'dvd') return 'DVD';
  return null;
}

export interface StatsHudPillProps {
  track?: TrackMetadata | null;
  compact?: boolean;
}

export const StatsHudPill: React.FC<StatsHudPillProps> = ({ track, compact = false }) => {
  const [enabled, setEnabled] = useState<boolean>(() => loadStatsHudEnabled());
  const [minimal, setMinimal] = useState<boolean>(false);
  const [perf, setPerf] = useState<StatsPerfSnapshot | null>(null);

  useEffect(() => {
    const syncEnabled = () => setEnabled(loadStatsHudEnabled());
    window.addEventListener('imp-stats-hud-changed', syncEnabled);
    window.addEventListener('storage', syncEnabled);
    return () => {
      window.removeEventListener('imp-stats-hud-changed', syncEnabled);
      window.removeEventListener('storage', syncEnabled);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const poll = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const res = await fetch(resolveDaemonUrl('/api/v1/system/perf'));
        if (res.ok) {
          const data = (await res.json()) as StatsPerfSnapshot;
          if (!cancelled) setPerf(data);
        }
      } catch {
        // Ignore transient offline error
      }
    };
    const onVis = () => {
      if (document.visibilityState !== 'hidden') {
        poll();
      }
    };
    poll();
    const timer = window.setInterval(poll, 2500);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [enabled]);

  if (!enabled) return null;

  const cpuStr = perf ? `${perf.cpu_percent.toFixed(1)}%` : '--';
  const ramStr = perf ? `${Math.round(perf.rss_mb)}M` : '--';
  const fmtBadge = formatTrackBadge(track);

  return (
    <button
      type="button"
      data-row-aux="true"
      onClick={() => setMinimal((m) => !m)}
      title="Stats HUD (click to toggle minimal readout; toggle On/Off in Settings)"
      style={{
        height: compact ? 24 : 36,
        padding: compact ? '0 7px' : '0 9px',
        borderRadius: 6,
        background: 'var(--imp-surface-card, #1a1d24)',
        border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
        color: 'var(--imp-text-secondary, #8b92a1)',
        fontSize: compact ? 10 : 10.5,
        fontFamily: 'monospace',
        fontWeight: 700,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      <span style={{ color: '#6ee7b7' }}>CPU {cpuStr}</span>
      {!minimal && (
        <>
          <span style={{ opacity: 0.45 }}>·</span>
          <span style={{ color: 'var(--imp-text-primary, #eef0f4)' }}>{ramStr}</span>
          {fmtBadge && (
            <>
              <span style={{ opacity: 0.45 }}>·</span>
              <span style={{ color: 'var(--imp-focus-ring, #e8b86d)' }}>{fmtBadge}</span>
            </>
          )}
        </>
      )}
    </button>
  );
};
