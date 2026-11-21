import React, { useCallback, useEffect, useState } from 'react';
import { resolveDaemonUrl } from '../../api/servicesCacheApi';
import { ImpIcon } from '../icons/ImpIcon';
import {
  formatBytesHuman,
  formatDurationMs,
  liberationChipStyle,
  liberationFilterPillStyle,
} from './liberationUiHelpers';

interface LocalAuditRecord {
  file_path: string;
  root_dir: string;
  file_size_bytes: number;
  container_format: string;
  status: string;
  decoded_duration_ms: number;
  sample_rate: number;
  channels: number;
  peak_db: number | null;
  decode_errors: number;
  blake3_hash: string | null;
  tag_artist: string;
  tag_album: string;
  tag_title: string;
  tag_track_number: number | null;
  has_artwork: boolean;
  reason: string | null;
  audited_at: number;
}

interface LocalAuditSummary {
  total_files: number;
  verified_ok: number;
  corrupt_decode: number;
  truncated_duration: number;
  silent_audio: number;
  drm_protected_m4p: number;
  unreadable: number;
  total_bytes: number;
}

interface LocalAuditRuntimeStatus {
  phase: string;
  running: boolean;
  pause_requested: boolean;
  root_dir: string;
  total_files: number;
  audited_files: number;
  current_file: string;
  last_message: string;
}

interface LocalAuditStatusResponse {
  runtime: LocalAuditRuntimeStatus;
  summary: LocalAuditSummary;
}

interface LiberationAuditTabProps {
  open: boolean;
  rootDir: string;
  setRootDir: (path: string) => void;
  onBrowseRoot: () => void;
}

const AUDIT_PAGE_LIMIT = 50;

function auditStatusBadge(status: string): { label: string; color: string } {
  switch (status) {
    case 'verified_ok':
      return { label: 'Verified OK', color: '#34d399' };
    case 'corrupt_decode':
      return { label: 'Corrupt Decode', color: '#f87171' };
    case 'truncated_duration':
      return { label: 'Truncated', color: '#fbbf24' };
    case 'silent_audio':
      return { label: 'Silent Audio', color: '#c084fc' };
    case 'drm_protected_m4p':
      return { label: 'M4P DRM', color: '#fb923c' };
    default:
      return { label: 'Unreadable', color: '#fda4af' };
  }
}

export const LiberationAuditTab: React.FC<LiberationAuditTabProps> = ({
  open,
  rootDir,
  setRootDir,
  onBrowseRoot,
}) => {
  const [statusData, setStatusData] = useState<LocalAuditStatusResponse | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [searchInput, setSearchInput] = useState<string>('');
  const [appliedSearch, setAppliedSearch] = useState<string>('');
  const [pageOffset, setPageOffset] = useState<number>(0);
  const [records, setRecords] = useState<LocalAuditRecord[]>([]);
  const [recordsTotal, setRecordsTotal] = useState<number>(0);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/audit/status'));
      const json = await resp.json();
      if (json?.ok && json?.data) {
        const next = json.data as LocalAuditStatusResponse;
        setStatusData(next);
        if (!rootDir && next.runtime.root_dir) {
          setRootDir(next.runtime.root_dir);
        }
        return next;
      }
    } catch {
      // ignore transient error
    }
    return null;
  }, [rootDir, setRootDir]);

  const fetchResults = useCallback(async () => {
    try {
      const params = new URLSearchParams();
      if (rootDir.trim()) params.set('root_dir', rootDir.trim());
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (appliedSearch.trim()) params.set('q', appliedSearch.trim());
      params.set('limit', String(AUDIT_PAGE_LIMIT));
      params.set('offset', String(pageOffset));

      const resp = await fetch(
        resolveDaemonUrl(`/api/liberation/audit/results?${params.toString()}`)
      );
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setRecords(Array.isArray(json.data.records) ? json.data.records : []);
        setRecordsTotal(Number(json.data.total) || 0);
      }
    } catch {
      // ignore
    }
  }, [rootDir, statusFilter, appliedSearch, pageOffset]);

  useEffect(() => {
    if (!open) return;
    fetchStatus();
    fetchResults();
  }, [open, fetchStatus, fetchResults]);

  const isRunning = Boolean(statusData?.runtime?.running);
  const auditedCount = statusData?.runtime?.audited_files ?? 0;

  useEffect(() => {
    if (!open || !isRunning) return;
    const t = window.setInterval(() => {
      fetchStatus().then((next) => {
        if (next && (!next.runtime.running || next.runtime.audited_files !== auditedCount)) {
          fetchResults();
        }
      });
    }, 1500);
    return () => window.clearInterval(t);
  }, [open, isRunning, auditedCount, fetchStatus, fetchResults]);

  const startAudit = async () => {
    if (!rootDir.trim()) {
      setErrorMsg('Choose or enter a folder to audit.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    setPageOffset(0);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/audit/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root_dir: rootDir.trim() }),
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setStatusData(json.data as LocalAuditStatusResponse);
        fetchResults();
      } else {
        setErrorMsg(json?.error || 'Failed to start folder audit');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Audit request failed');
    } finally {
      setBusy(false);
    }
  };

  const pauseAudit = async () => {
    setBusy(true);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/audit/pause'), { method: 'POST' });
      const json = await resp.json();
      if (json?.ok && json?.data) setStatusData(json.data as LocalAuditStatusResponse);
    } finally {
      setBusy(false);
    }
  };

  const rt = statusData?.runtime;
  const summary = statusData?.summary;
  const totalFiles = rt?.total_files ?? 0;
  const pct = totalFiles > 0 ? Math.min(100, Math.round(((rt?.audited_files ?? 0) / totalFiles) * 100)) : 0;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 18px', gap: 8 }}>
      <div style={{ fontSize: 11, color: '#cbd5e1' }}>
        Decodes every file to EOF via <code style={{ color: '#93c5fd' }}>symphonia</code>, flags truncated/silent/corrupted Music.app exports or reclaimed downloads, detects legacy <code style={{ color: '#fdba74' }}>.m4p</code> DRM, and records <code style={{ color: '#93c5fd' }}>blake3</code> digests.
      </div>

      {/* Folder Input + Actions */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={rootDir}
          onChange={(e) => setRootDir(e.target.value)}
          placeholder="Folder to audit (IMP reclaimed or Music.app Media folder)..."
          style={{
            flex: 1,
            minWidth: 230,
            padding: '6px 10px',
            borderRadius: 7,
            border: '1px solid rgba(255,255,255,0.16)',
            background: 'rgba(0,0,0,0.45)',
            color: '#f1f5f9',
            fontSize: 11.5,
            fontFamily: 'monospace',
          }}
        />
        <button type="button" data-focusable="true" onClick={onBrowseRoot} style={liberationFilterPillStyle(false, '#7dd3fc')}>
          <ImpIcon name="folder" size={12} style={{ marginRight: 5 }} />
          Browse...
        </button>
        <button
          type="button"
          data-focusable="true"
          disabled={isRunning || busy || !rootDir.trim()}
          onClick={startAudit}
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            border: '1px solid rgba(52, 211, 153, 0.5)',
            background: !isRunning && rootDir.trim() ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255,255,255,0.04)',
            color: !isRunning && rootDir.trim() ? '#6ee7b7' : '#64748b',
            fontSize: 11.5,
            fontWeight: 800,
            cursor: !isRunning && rootDir.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          {isRunning ? `Verifying ${pct}%...` : 'Run 4-Stage Integrity Audit'}
        </button>
        <button
          type="button"
          data-focusable="true"
          disabled={!isRunning || busy}
          onClick={pauseAudit}
          style={liberationFilterPillStyle(false, '#fcd34d')}
        >
          Pause
        </button>
      </div>

      {errorMsg && (
        <div style={{ padding: '6px 10px', borderRadius: 7, background: 'rgba(239, 68, 68, 0.14)', border: '1px solid rgba(248, 113, 113, 0.45)', color: '#fecaca', fontSize: 11 }}>
          {errorMsg}
        </div>
      )}

      {/* Summary Chips */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10.5 }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={liberationChipStyle('#e2e8f0')}>
            Audited: {(summary?.total_files ?? 0).toLocaleString()} ({formatBytesHuman(summary?.total_bytes ?? 0)})
          </span>
          <span style={liberationChipStyle('#34d399')}>OK: {summary?.verified_ok ?? 0}</span>
          <span style={liberationChipStyle('#f87171')}>Corrupt: {summary?.corrupt_decode ?? 0}</span>
          <span style={liberationChipStyle('#fbbf24')}>Truncated: {summary?.truncated_duration ?? 0}</span>
          <span style={liberationChipStyle('#c084fc')}>Silent: {summary?.silent_audio ?? 0}</span>
          <span style={liberationChipStyle('#fb923c')}>M4P DRM: {summary?.drm_protected_m4p ?? 0}</span>
        </div>
        <span style={{ color: '#94a3b8' }}>{rt?.last_message}</span>
      </div>

      {/* Filters */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {[
            ['all', 'All'],
            ['corrupt_decode', 'Corrupt'],
            ['truncated_duration', 'Truncated'],
            ['silent_audio', 'Silent'],
            ['drm_protected_m4p', 'M4P DRM'],
            ['unreadable', 'Unreadable'],
            ['verified_ok', 'Verified OK'],
          ].map(([val, label]) => (
            <button
              key={val}
              type="button"
              data-focusable="true"
              onClick={() => {
                setStatusFilter(val);
                setPageOffset(0);
              }}
              style={liberationFilterPillStyle(statusFilter === val, '#34d399')}
            >
              {label}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setAppliedSearch(searchInput);
            setPageOffset(0);
          }}
          style={{ display: 'flex', gap: 5 }}
        >
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Filter file or tag..."
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(0,0,0,0.45)',
              color: '#e2e8f0',
              fontSize: 11,
              width: 170,
            }}
          />
          <button type="submit" data-focusable="true" style={liberationFilterPillStyle(false, '#e2e8f0')}>
            Filter
          </button>
        </form>
      </div>

      {/* Audit Table */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10,
          background: 'rgba(7, 9, 15, 0.72)',
        }}
      >
        {records.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
            {summary?.total_files
              ? 'No audited files match the selected filter.'
              : 'Pick a local folder and click [Run 4-Stage Integrity Audit].'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#94a3b8', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                <th style={{ padding: '7px 10px' }}>File / Tags</th>
                <th style={{ padding: '7px 8px' }}>Format / Dur</th>
                <th style={{ padding: '7px 8px' }}>Peak</th>
                <th style={{ padding: '7px 8px' }}>Status</th>
                <th style={{ padding: '7px 10px' }}>BLAKE3 / Detail</th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => {
                const badge = auditStatusBadge(r.status);
                const shortName = r.file_path.split('/').pop() || r.file_path;
                return (
                  <tr key={r.file_path} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '6px 10px', maxWidth: 270 }} title={r.file_path}>
                      <div style={{ fontWeight: 700, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.tag_title || shortName}
                      </div>
                      <div style={{ fontSize: 9.5, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.tag_artist ? `${r.tag_artist} — ${r.tag_album}` : r.file_path}
                      </div>
                    </td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', color: '#cbd5e1', fontFamily: 'monospace' }}>
                      {r.container_format.toUpperCase()} · {formatDurationMs(r.decoded_duration_ms)}
                    </td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', color: '#94a3b8', fontFamily: 'monospace' }}>
                      {r.peak_db != null ? `${r.peak_db.toFixed(1)} dB` : '-inf'}
                    </td>
                    <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                      <span style={{ color: badge.color, fontWeight: 800, fontSize: 10.5 }}>{badge.label}</span>
                    </td>
                    <td style={{ padding: '6px 10px', maxWidth: 240, fontSize: 10, color: '#94a3b8' }}>
                      {r.reason ? (
                        <span style={{ color: '#fda4af' }}>{r.reason}</span>
                      ) : (
                        <span style={{ fontFamily: 'monospace' }}>
                          {r.blake3_hash ? `${r.blake3_hash.slice(0, 14)}...` : ''}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Pagination */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8' }}>
        <span>
          Showing {recordsTotal === 0 ? 0 : pageOffset + 1}–{Math.min(pageOffset + records.length, recordsTotal)} of {recordsTotal.toLocaleString()}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            data-focusable="true"
            disabled={pageOffset === 0}
            onClick={() => setPageOffset((p) => Math.max(0, p - AUDIT_PAGE_LIMIT))}
            style={liberationFilterPillStyle(false, '#e2e8f0')}
          >
            Prev
          </button>
          <button
            type="button"
            data-focusable="true"
            disabled={pageOffset + AUDIT_PAGE_LIMIT >= recordsTotal}
            onClick={() => setPageOffset((p) => p + AUDIT_PAGE_LIMIT)}
            style={liberationFilterPillStyle(false, '#e2e8f0')}
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
};
