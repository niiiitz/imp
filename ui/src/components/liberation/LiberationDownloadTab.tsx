import React, { useCallback, useEffect, useState } from 'react';
import { resolveDaemonUrl } from '../../api/servicesCacheApi';
import { ImpIcon } from '../icons/ImpIcon';
import { formatBytesHuman, liberationChipStyle, liberationFilterPillStyle } from './liberationUiHelpers';

interface DownloadPreflightReport {
  dest_dir: string;
  scope: string;
  remaining_tracks: number;
  estimated_remaining_bytes: number;
  required_with_headroom_bytes: number;
  available_bytes: number;
  headroom_ok: boolean;
  critical_low_space: boolean;
}

interface LiberationDownloadRuntimeStatus {
  phase: string;
  running: boolean;
  pause_requested: boolean;
  auth_expired: boolean;
  low_space_paused: boolean;
  dest_dir: string;
  scope: string;
  processed_this_run: number;
  verified_this_run: number;
  corrupt_this_run: number;
  skipped_drm_this_run: number;
  bytes_this_run: number;
  current_track: string;
  last_message: string;
  started_at: number | null;
  updated_at: number;
}

interface LiberationDownloadDbSummary {
  verified_ok: number;
  corrupt_failed: number;
  skipped_drm: number;
  unavailable: number;
  remaining_uploaded: number;
  total_downloaded_bytes: number;
  estimated_remaining_bytes: number;
}

interface LiberationDownloadStatusResponse {
  runtime: LiberationDownloadRuntimeStatus;
  db_summary: LiberationDownloadDbSummary;
}

interface LiberationDownloadTabProps {
  open: boolean;
  destDir: string;
  setDestDir: (path: string) => void;
  onBrowseDest: () => void;
  onInspectFailed?: () => void;
  showToast?: (msg: string) => void;
}

export const LiberationDownloadTab: React.FC<LiberationDownloadTabProps> = ({
  open,
  destDir,
  setDestDir,
  onBrowseDest,
  onInspectFailed,
  showToast,
}) => {
  const [scope, setScope] = useState<'uploaded_and_reclaimable' | 'reclaimable_only'>(
    'uploaded_and_reclaimable'
  );
  const [allowPartialSpace, setAllowPartialSpace] = useState(false);
  const [preflight, setPreflight] = useState<DownloadPreflightReport | null>(null);
  const [statusData, setStatusData] = useState<LiberationDownloadStatusResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/download/status'));
      const json = await resp.json();
      if (json?.ok && json?.data) {
        const next = json.data as LiberationDownloadStatusResponse;
        setStatusData(next);
        if (!destDir && next.runtime.dest_dir) {
          setDestDir(next.runtime.dest_dir);
        }
      }
    } catch {
      // ignore transient error
    }
  }, [destDir, setDestDir]);

  useEffect(() => {
    if (!open) return;
    fetchStatus();
  }, [open, fetchStatus]);

  const isRunning = Boolean(statusData?.runtime?.running);
  useEffect(() => {
    if (!open || !isRunning) return;
    const t = window.setInterval(fetchStatus, 1500);
    return () => window.clearInterval(t);
  }, [open, isRunning, fetchStatus]);

  const runPreflight = async () => {
    if (!destDir.trim()) {
      setErrorMsg('Choose or enter a destination folder first.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/download/preflight'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dest_dir: destDir.trim(), scope }),
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setPreflight(json.data as DownloadPreflightReport);
      } else {
        setErrorMsg(json?.error || 'Preflight disk check failed');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Preflight request failed');
    } finally {
      setBusy(false);
    }
  };

  const startDownload = async (maxTracks?: number, retryFailed = false) => {
    if (!destDir.trim()) {
      setErrorMsg('Choose or enter a destination folder first.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/download/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dest_dir: destDir.trim(),
          scope,
          allow_partial_space: allowPartialSpace,
          retry_failed: retryFailed,
          max_tracks: maxTracks ?? null,
        }),
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setStatusData(json.data as LiberationDownloadStatusResponse);
        if (showToast) {
          showToast(
            retryFailed
              ? 'Retrying failed Project LIBERATION tracks...'
              : maxTracks
                ? `Started Project LIBERATION Test Batch (${maxTracks} tracks)`
                : 'Started Project LIBERATION DRM-free download reclamation'
          );
        }
      } else {
        setErrorMsg(json?.error || 'Failed to start reclamation');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to start reclamation');
    } finally {
      setBusy(false);
    }
  };

  const pauseDownload = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/download/pause'), {
        method: 'POST',
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setStatusData(json.data as LiberationDownloadStatusResponse);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to pause download');
    } finally {
      setBusy(false);
    }
  };

  const rt = statusData?.runtime;
  const db = statusData?.db_summary;
  const canStart = !isRunning && !busy && destDir.trim().length > 0;
  const totalScopeCount = (db?.verified_ok ?? 0) + (db?.remaining_uploaded ?? 0);
  const progressPct =
    totalScopeCount > 0
      ? Math.min(100, Math.round(((db?.verified_ok ?? 0) / totalScopeCount) * 100))
      : 0;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11.5, color: '#cbd5e1', lineHeight: 1.45 }}>
        Reclaims DRM-free uploaded Cloud Locker originals into <code style={{ color: '#93c5fd' }}>Artist/Album/Track</code>, resolves fresh S3 URLs on demand, embeds tags &amp; artwork, and runs <strong>4-stage full decode + BLAKE3 verification</strong> before saving.
      </div>

      {/* Destination Folder + Preflight */}
      <div
        style={{
          padding: 12,
          borderRadius: 10,
          background: 'rgba(12, 16, 26, 0.86)',
          border: '1px solid rgba(255,255,255,0.09)',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={destDir}
            onChange={(e) => setDestDir(e.target.value)}
            placeholder="Destination folder (e.g. /Users/you/Music/IMP Reclaimed)..."
            style={{
              flex: 1,
              minWidth: 240,
              padding: '7px 10px',
              borderRadius: 7,
              border: '1px solid rgba(255,255,255,0.16)',
              background: 'rgba(0,0,0,0.45)',
              color: '#f1f5f9',
              fontSize: 11.5,
              fontFamily: 'monospace',
            }}
          />
          <button
            type="button"
            data-focusable="true"
            onClick={onBrowseDest}
            style={liberationFilterPillStyle(false, '#7dd3fc')}
          >
            <ImpIcon name="folder" size={12} style={{ marginRight: 5 }} />
            Browse...
          </button>
          <button
            type="button"
            data-focusable="true"
            disabled={busy || !destDir.trim()}
            onClick={runPreflight}
            style={liberationFilterPillStyle(false, '#34d399')}
          >
            Check Disk Space
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 10.5, color: '#94a3b8', fontWeight: 700 }}>Target Scope:</span>
            <button
              type="button"
              data-focusable="true"
              onClick={() => setScope('uploaded_and_reclaimable')}
              style={liberationFilterPillStyle(scope === 'uploaded_and_reclaimable', '#34d399')}
            >
              All Uploaded + Clear (~{(db?.remaining_uploaded ?? 0).toLocaleString()} left)
            </button>
            <button
              type="button"
              data-focusable="true"
              onClick={() => setScope('reclaimable_only')}
              style={liberationFilterPillStyle(scope === 'reclaimable_only', '#38bdf8')}
            >
              Probed Reclaimable Only
            </button>
          </div>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#cbd5e1', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={allowPartialSpace}
              onChange={(e) => setAllowPartialSpace(e.target.checked)}
            />
            Allow partial download (auto-pause at 1 GB free)
          </label>
        </div>

        {preflight && (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 8,
              background: preflight.headroom_ok
                ? 'rgba(16, 185, 129, 0.12)'
                : 'rgba(245, 158, 11, 0.14)',
              border: preflight.headroom_ok
                ? '1px solid rgba(52, 211, 153, 0.4)'
                : '1px solid rgba(251, 191, 36, 0.45)',
              fontSize: 11,
              color: preflight.headroom_ok ? '#a7f3d0' : '#fde68a',
              display: 'flex',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <span>
              Remaining: <strong>{preflight.remaining_tracks.toLocaleString()}</strong> tracks · Est.{' '}
              <strong>{formatBytesHuman(preflight.estimated_remaining_bytes)}</strong> (+2 GB buffer ={' '}
              {formatBytesHuman(preflight.required_with_headroom_bytes)})
            </span>
            <span>
              Free Space: <strong>{formatBytesHuman(preflight.available_bytes)}</strong>{' '}
              {preflight.headroom_ok ? '· Sufficient headroom' : '· Low space (enable Partial or free disk)'}
            </span>
          </div>
        )}
      </div>

      {/* Action Bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            data-focusable="true"
            disabled={!canStart}
            onClick={() => startDownload(10)}
            style={{
              padding: '7px 12px',
              borderRadius: 8,
              border: '1px solid rgba(192, 132, 252, 0.45)',
              background: canStart ? 'rgba(168, 85, 247, 0.18)' : 'rgba(255,255,255,0.04)',
              color: canStart ? '#e9d5ff' : '#64748b',
              fontSize: 12,
              fontWeight: 800,
              cursor: canStart ? 'pointer' : 'not-allowed',
            }}
          >
            Test Batch (10 tracks)
          </button>

          <button
            type="button"
            data-focusable="true"
            disabled={!canStart}
            onClick={() => startDownload()}
            style={{
              padding: '7px 14px',
              borderRadius: 8,
              border: '1px solid rgba(52, 211, 153, 0.5)',
              background: canStart ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255,255,255,0.04)',
              color: canStart ? '#6ee7b7' : '#64748b',
              fontSize: 12,
              fontWeight: 800,
              cursor: canStart ? 'pointer' : 'not-allowed',
            }}
          >
            {isRunning ? 'Reclaiming...' : 'Reclaim All Uploaded'}
          </button>

          <button
            type="button"
            data-focusable="true"
            disabled={!isRunning || busy}
            onClick={pauseDownload}
            style={{
              padding: '7px 12px',
              borderRadius: 8,
              border: '1px solid rgba(251, 191, 36, 0.42)',
              background: isRunning ? 'rgba(245, 158, 11, 0.16)' : 'rgba(255,255,255,0.04)',
              color: isRunning ? '#fcd34d' : '#64748b',
              fontSize: 11.5,
              fontWeight: 700,
              cursor: isRunning ? 'pointer' : 'not-allowed',
            }}
          >
            <ImpIcon name="pause" size={12} style={{ marginRight: 5 }} />
            Pause
          </button>

          {(db?.corrupt_failed ?? 0) > 0 && (
            <button
              type="button"
              data-focusable="true"
              disabled={!canStart}
              onClick={() => startDownload(undefined, true)}
              style={{
                padding: '7px 12px',
                borderRadius: 8,
                border: '1px solid rgba(248, 113, 113, 0.48)',
                background: canStart ? 'rgba(239, 68, 68, 0.16)' : 'rgba(255,255,255,0.04)',
                color: canStart ? '#fecaca' : '#64748b',
                fontSize: 11.5,
                fontWeight: 800,
                cursor: canStart ? 'pointer' : 'not-allowed',
              }}
            >
              <ImpIcon name="refresh" size={12} style={{ marginRight: 5 }} />
              Retry Failed ({(db?.corrupt_failed ?? 0).toLocaleString()})
            </button>
          )}
        </div>

        <span style={{ fontSize: 11, color: '#94a3b8' }}>
          Phase: <strong style={{ color: '#fda4af' }}>{rt?.phase ?? 'idle'}</strong>
        </span>
      </div>

      {/* Progress & Status */}
      <div style={{ height: 6, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
        <div
          style={{
            width: `${progressPct}%`,
            height: '100%',
            background: 'linear-gradient(90deg, #38bdf8, #34d399)',
            transition: 'width 250ms ease',
          }}
        />
      </div>

      <div style={{ fontSize: 11, color: '#cbd5e1' }}>
        {rt?.last_message || 'Ready.'}
        {rt?.running && rt.current_track ? (
          <span style={{ color: '#94a3b8', marginLeft: 8 }}>Current: {rt.current_track}</span>
        ) : null}
      </div>

      {rt?.auth_expired && (
        <div style={{ padding: '7px 10px', borderRadius: 8, background: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(251, 191, 36, 0.45)', color: '#fde68a', fontSize: 11.5 }}>
          Apple Music session expired — reconnect in Settings and resume (already-verified files skip instantly).
        </div>
      )}
      {rt?.low_space_paused && (
        <div style={{ padding: '7px 10px', borderRadius: 8, background: 'rgba(245, 158, 11, 0.15)', border: '1px solid rgba(251, 191, 36, 0.45)', color: '#fde68a', fontSize: 11.5 }}>
          Auto-paused because free disk space dropped below 1.0 GB. Free space or point to an external drive to resume.
        </div>
      )}
      {errorMsg && (
        <div style={{ padding: '7px 10px', borderRadius: 8, background: 'rgba(239, 68, 68, 0.14)', border: '1px solid rgba(248, 113, 113, 0.45)', color: '#fecaca', fontSize: 11.5 }}>
          {errorMsg}
        </div>
      )}

      {/* Summary Metrics */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
        <span style={liberationChipStyle('#34d399')}>
          Total Verified OK: {(db?.verified_ok ?? 0).toLocaleString()} ({formatBytesHuman(db?.total_downloaded_bytes ?? 0)})
        </span>
        <span style={liberationChipStyle('#38bdf8')}>
          Remaining Queue: {(db?.remaining_uploaded ?? 0).toLocaleString()} (~{formatBytesHuman(db?.estimated_remaining_bytes ?? 0)})
        </span>
        {(db?.corrupt_failed ?? 0) > 0 && onInspectFailed ? (
          <button
            type="button"
            data-focusable="true"
            onClick={onInspectFailed}
            title="Inspect failed/corrupt tracks and exact error reasons"
            style={{
              ...liberationChipStyle('#f87171'),
              cursor: 'pointer',
              textDecoration: 'underline',
            }}
          >
            Corrupt / Failed: {db?.corrupt_failed ?? 0} (Inspect)
          </button>
        ) : (
          <span style={liberationChipStyle('#f87171')}>
            Corrupt / Failed: {db?.corrupt_failed ?? 0}
          </span>
        )}
        <span style={liberationChipStyle('#fb923c')}>
          Skipped DRM: {db?.skipped_drm ?? 0}
        </span>
        <span style={liberationChipStyle('#a1a1aa')}>
          Unavailable: {db?.unavailable ?? 0}
        </span>
      </div>
    </div>
  );
};
