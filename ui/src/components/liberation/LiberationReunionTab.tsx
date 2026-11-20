import React, { useState } from 'react';
import { resolveDaemonUrl } from '../../api/servicesCacheApi';
import { ImpIcon } from '../icons/ImpIcon';
import { liberationChipStyle, liberationFilterPillStyle } from './liberationUiHelpers';

interface ReunionMoveItem {
  item_id: string;
  source_path: string;
  target_path: string;
  title: string;
  artist: string;
  current_album: string;
  proposed_album: string;
  proposed_album_artist: string;
  proposed_track_number: number | null;
  proposed_track_total: number | null;
  proposed_disc_number: number | null;
  proposed_year: number | null;
  confidence: string;
  match_reason: string;
  catalog_album_id: string | null;
}

interface ReunionPlanReport {
  plan_id: string;
  root_dir: string;
  scanned_files: number;
  incomplete_albums_found: number;
  catalog_lookups_performed: number;
  proposed_items: ReunionMoveItem[];
  created_at: number;
}

interface ReunionApplyResult {
  applied_count: number;
  moved_count: number;
  skipped_count: number;
  failed: string[];
  journal_path: string;
}

interface LiberationReunionTabProps {
  rootDir: string;
  setRootDir: (path: string) => void;
  onBrowseRoot: () => void;
  showToast?: (msg: string) => void;
}

function confidenceColor(conf: string): { label: string; color: string } {
  switch (conf) {
    case 'exact_isrc':
      return { label: 'Exact ISRC', color: '#34d399' };
    case 'catalog_title_duration':
      return { label: 'Catalog Verified', color: '#38bdf8' };
    default:
      return { label: 'Heuristic Album Match', color: '#fbbf24' };
  }
}

export const LiberationReunionTab: React.FC<LiberationReunionTabProps> = ({
  rootDir,
  setRootDir,
  onBrowseRoot,
  showToast,
}) => {
  const [useAppleCatalog, setUseAppleCatalog] = useState(true);
  const [moveFiles, setMoveFiles] = useState(true);
  const [plan, setPlan] = useState<ReunionPlanReport | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastApply, setLastApply] = useState<ReunionApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const scanAndPreview = async () => {
    if (!rootDir.trim()) {
      setErrorMsg('Choose or enter a local folder to scan.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    setLastApply(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/reunion/plan'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root_dir: rootDir.trim(),
          use_apple_catalog: useAppleCatalog,
        }),
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        const rep = json.data as ReunionPlanReport;
        setPlan(rep);
        setSelectedIds(new Set(rep.proposed_items.map((it) => it.item_id)));
      } else {
        setErrorMsg(json?.error || 'Reunion dry-run failed');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Reunion dry-run request failed');
    } finally {
      setBusy(false);
    }
  };

  const applySelected = async () => {
    if (!plan || selectedIds.size === 0) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/reunion/apply'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_id: plan.plan_id,
          selected_item_ids: Array.from(selectedIds),
          move_files: moveFiles,
        }),
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        const res = json.data as ReunionApplyResult;
        setLastApply(res);
        if (showToast) {
          showToast(`Reunited ${res.applied_count} track(s) (${res.moved_count} moved); undo journal saved.`);
        }
      } else {
        setErrorMsg(json?.error || 'Failed to apply reunion plan');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to apply reunion plan');
    } finally {
      setBusy(false);
    }
  };

  const undoLast = async () => {
    if (!lastApply?.journal_path) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/reunion/undo'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journal_path: lastApply.journal_path }),
      });
      const json = await resp.json();
      if (json?.ok) {
        if (showToast) {
          showToast(`Reverted ${json.data?.restored ?? 0} file(s) from reunion journal.`);
        }
        setLastApply(null);
        scanAndPreview();
      } else {
        setErrorMsg(json?.error || 'Undo failed');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Undo request failed');
    } finally {
      setBusy(false);
    }
  };

  const toggleItem = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 18px', gap: 8 }}>
      <div style={{ fontSize: 11, color: '#cbd5e1' }}>
        Matches orphaned <code>- Single</code> / <code>- EP</code> tracks back to their parent albums using Apple Catalog tracklists + ISRCs. Always previews first and writes a reversible JSON undo journal before modifying tags or folders.
      </div>

      {/* Controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={rootDir}
          onChange={(e) => setRootDir(e.target.value)}
          placeholder="Folder containing reclaimed / local albums..."
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
          disabled={busy || !rootDir.trim()}
          onClick={scanAndPreview}
          style={{
            padding: '6px 12px',
            borderRadius: 8,
            border: '1px solid rgba(56, 189, 248, 0.5)',
            background: !busy && rootDir.trim() ? 'rgba(14, 165, 233, 0.2)' : 'rgba(255,255,255,0.04)',
            color: !busy && rootDir.trim() ? '#7dd3fc' : '#64748b',
            fontSize: 11.5,
            fontWeight: 800,
            cursor: !busy && rootDir.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          {busy ? 'Scanning...' : 'Scan & Preview Plan (Dry-Run)'}
        </button>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11, color: '#cbd5e1' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useAppleCatalog}
              onChange={(e) => setUseAppleCatalog(e.target.checked)}
            />
            Verify missing slots via Apple Music Catalog (ISRC + duration)
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={moveFiles}
              onChange={(e) => setMoveFiles(e.target.checked)}
            />
            Move files into album folder
          </label>
        </div>

        {plan && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 10.5 }}>
            <span style={liberationChipStyle('#e2e8f0')}>Scanned: {plan.scanned_files}</span>
            <span style={liberationChipStyle('#fbbf24')}>Incomplete Albums: {plan.incomplete_albums_found}</span>
            <span style={liberationChipStyle('#34d399')}>Matches Proposed: {plan.proposed_items.length}</span>
          </div>
        )}
      </div>

      {errorMsg && (
        <div style={{ padding: '6px 10px', borderRadius: 7, background: 'rgba(239, 68, 68, 0.14)', border: '1px solid rgba(248, 113, 113, 0.45)', color: '#fecaca', fontSize: 11 }}>
          {errorMsg}
        </div>
      )}

      {lastApply && (
        <div style={{ padding: '7px 10px', borderRadius: 8, background: 'rgba(16, 185, 129, 0.14)', border: '1px solid rgba(52, 211, 153, 0.45)', color: '#a7f3d0', fontSize: 11, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span>
            Applied {lastApply.applied_count} item(s) ({lastApply.moved_count} moved). Journal:{' '}
            <code style={{ fontSize: 10 }}>{lastApply.journal_path}</code>
          </span>
          <button type="button" data-focusable="true" disabled={busy} onClick={undoLast} style={liberationFilterPillStyle(false, '#fde68a')}>
            Undo Last Reunion
          </button>
        </div>
      )}

      {/* Proposed Plan List */}
      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          border: '1px solid rgba(255,255,255,0.08)',
          borderRadius: 10,
          background: 'rgba(7, 9, 15, 0.72)',
          padding: 8,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {!plan ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
            Pick a folder and click [Scan &amp; Preview Plan (Dry-Run)] to inspect album reunion matches.
          </div>
        ) : plan.proposed_items.length === 0 ? (
          <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
            No high-confidence stray singles needed reunion in this folder.
          </div>
        ) : (
          plan.proposed_items.map((it) => {
            const conf = confidenceColor(it.confidence);
            const checked = selectedIds.has(it.item_id);
            return (
              <label
                key={it.item_id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 10,
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: checked ? 'rgba(56, 189, 248, 0.08)' : 'rgba(255,255,255,0.02)',
                  border: checked ? '1px solid rgba(56, 189, 248, 0.35)' : '1px solid rgba(255,255,255,0.06)',
                  cursor: 'pointer',
                  fontSize: 11,
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleItem(it.item_id)}
                  style={{ marginTop: 3 }}
                />
                <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 800, color: '#f1f5f9' }}>
                      {it.artist} — {it.title}
                    </span>
                    <span style={{ fontSize: 10, fontWeight: 800, color: conf.color }}>
                      {conf.label}
                    </span>
                  </div>
                  <div style={{ color: '#cbd5e1' }}>
                    <span style={{ color: '#94a3b8' }}>{it.current_album}</span> →{' '}
                    <strong style={{ color: '#6ee7b7' }}>{it.proposed_album}</strong>
                    {it.proposed_track_number
                      ? ` (#${it.proposed_track_number}/${it.proposed_track_total ?? '?'})`
                      : ''}
                  </div>
                  <div style={{ fontSize: 10, color: '#94a3b8' }}>{it.match_reason}</div>
                </div>
              </label>
            );
          })
        )}
      </div>

      {/* Apply Footer */}
      {plan && plan.proposed_items.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              data-focusable="true"
              onClick={() => setSelectedIds(new Set(plan.proposed_items.map((it) => it.item_id)))}
              style={liberationFilterPillStyle(false, '#e2e8f0')}
            >
              Select All
            </button>
            <button
              type="button"
              data-focusable="true"
              onClick={() => setSelectedIds(new Set())}
              style={liberationFilterPillStyle(false, '#e2e8f0')}
            >
              Select None
            </button>
          </div>
          <button
            type="button"
            data-focusable="true"
            disabled={busy || selectedIds.size === 0}
            onClick={applySelected}
            style={{
              padding: '7px 14px',
              borderRadius: 8,
              border: '1px solid rgba(52, 211, 153, 0.5)',
              background: !busy && selectedIds.size > 0 ? 'rgba(16, 185, 129, 0.22)' : 'rgba(255,255,255,0.04)',
              color: !busy && selectedIds.size > 0 ? '#6ee7b7' : '#64748b',
              fontSize: 12,
              fontWeight: 800,
              cursor: !busy && selectedIds.size > 0 ? 'pointer' : 'not-allowed',
            }}
          >
            Apply Selected Reunions ({selectedIds.size})
          </button>
        </div>
      )}
    </div>
  );
};
