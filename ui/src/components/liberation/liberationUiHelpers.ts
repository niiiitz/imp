import React from 'react';

export function formatBytesHuman(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '--:--';
  const totalSec = Math.round(ms / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export function liberationChipStyle(color: string): React.CSSProperties {
  return {
    padding: '2px 7px',
    borderRadius: 6,
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.1)',
    color,
    fontWeight: 700,
  };
}

export function liberationTabBtnStyle(active: boolean): React.CSSProperties {
  return {
    padding: '6px 11px',
    borderRadius: 8,
    border: active ? '1px solid rgba(251, 113, 133, 0.55)' : '1px solid rgba(255,255,255,0.1)',
    background: active ? 'rgba(244, 63, 94, 0.16)' : 'rgba(255,255,255,0.03)',
    color: active ? '#fda4af' : '#94a3b8',
    fontSize: 11.5,
    fontWeight: 800,
    cursor: 'pointer',
  };
}

export function liberationFilterPillStyle(active: boolean, accent: string): React.CSSProperties {
  return {
    padding: '4px 9px',
    borderRadius: 6,
    border: active ? `1px solid ${accent}` : '1px solid rgba(255,255,255,0.12)',
    background: active ? 'rgba(255,255,255,0.1)' : 'rgba(255,255,255,0.03)',
    color: active ? accent : '#cbd5e1',
    fontSize: 10.5,
    fontWeight: 700,
    cursor: 'pointer',
  };
}
