import React, { useCallback, useEffect, useState } from 'react';
import { resolveDaemonUrl } from '../../api/servicesCacheApi';
import { ImpIcon } from '../icons/ImpIcon';
import { formatBytesHuman, liberationChipStyle, liberationFilterPillStyle } from './liberationUiHelpers';

interface ReunionMoveItem {
  item_id: string;
  source_path: string;
  target_path: string;
  title: string;
  artist: string;
  proposed_title?: string | null;
  proposed_artist?: string | null;
  proposed_isrc?: string | null;
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

interface AcousticDuplicateEntry {
  file_path: string;
  title: string;
  artist: string;
  album: string;
  file_size_bytes: number;
  duration_sec: number;
  container_format: string;
  similarity_pct: number;
}

interface AcousticDuplicateGroup {
  group_id: string;
  best_similarity_pct: number;
  items: AcousticDuplicateEntry[];
}

interface AcousticMendRuntimeStatus {
  phase: string;
  running: boolean;
  pause_requested: boolean;
  root_dir: string;
  target_mode: string;
  enable_acoustid_lookup: boolean;
  folder_filter: string;
  has_api_key: boolean;
  total_files: number;
  processed_files: number;
  fingerprinted_fresh: number;
  fingerprinted_cached: number;
  acoustid_queried: number;
  acoustid_matched: number;
  unmatched_unique: number;
  proposed_mends: number;
  duplicate_groups_found: number;
  errors: number;
  current_file: string;
  last_message: string;
  started_at: number | null;
  updated_at: number;
}

interface AcousticMendStatusResponse {
  runtime: AcousticMendRuntimeStatus;
  plan: ReunionPlanReport | null;
  duplicates: AcousticDuplicateGroup[];
}

interface LiberationReunionTabProps {
  open?: boolean;
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
    case 'high':
      return { label: 'AcoustID High Confidence', color: '#34d399' };
    case 'medium':
      return { label: 'AcoustID Verified', color: '#38bdf8' };
    default:
      return { label: 'Heuristic Album Match', color: '#fbbf24' };
  }
}

export const LiberationReunionTab: React.FC<LiberationReunionTabProps> = ({
  open = true,
  rootDir,
  setRootDir,
  onBrowseRoot,
  showToast,
}) => {
  const [stageMode, setStageMode] = useState<'catalog_reunion' | 'acoustic_mend'>('catalog_reunion');
  const [useAppleCatalog, setUseAppleCatalog] = useState(true);
  const [moveFiles, setMoveFiles] = useState(true);
  const [plan, setPlan] = useState<ReunionPlanReport | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastApply, setLastApply] = useState<ReunionApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Sub-Wave 9.8: Pure-Rust Chromaprint + AcoustID Acoustic Mend state
  const [mendTargetMode, setMendTargetMode] = useState<'unknowns_only' | 'all'>('unknowns_only');
  const [enableAcoustIdLookup, setEnableAcoustIdLookup] = useState(true);
  const [folderFilter, setFolderFilter] = useState('');
  const [apiKeyOverride, setApiKeyOverride] = useState('');
  const [acousticStatus, setAcousticStatus] = useState<AcousticMendStatusResponse | null>(null);
  const [acousticSubView, setAcousticSubView] = useState<'mends' | 'duplicates'>('mends');

  const fetchAcousticStatus = useCallback(async () => {
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/fingerprint/status'));
      const json = await resp.json();
      if (json?.ok && json?.data) {
        const next = json.data as AcousticMendStatusResponse;
        setAcousticStatus(next);
        if (stageMode === 'acoustic_mend' && next.plan && !next.runtime.running) {
          setPlan((prev) => {
            if (prev?.plan_id === next.plan?.plan_id) return prev;
            if (next.plan) {
              setSelectedIds(new Set(next.plan.proposed_items.map((it) => it.item_id)));
            }
            return next.plan;
          });
        }
      }
    } catch {
      // ignore transient poll errors
    }
  }, [stageMode]);

  useEffect(() => {
    if (!open || stageMode !== 'acoustic_mend') return;
    fetchAcousticStatus();
  }, [open, stageMode, fetchAcousticStatus]);

  const acousticRunning = Boolean(acousticStatus?.runtime?.running);
  useEffect(() => {
    if (!open || stageMode !== 'acoustic_mend' || !acousticRunning) return;
    const t = window.setInterval(fetchAcousticStatus, 1200);
    return () => window.clearInterval(t);
  }, [open, stageMode, acousticRunning, fetchAcousticStatus]);

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

  const startAcousticScan = async () => {
    if (!rootDir.trim()) {
      setErrorMsg('Choose or enter a local folder to scan.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    setLastApply(null);
    setPlan(null);
    setSelectedIds(new Set());
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/fingerprint/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root_dir: rootDir.trim(),
          target_mode: mendTargetMode,
          enable_acoustid_lookup: enableAcoustIdLookup,
          folder_filter: folderFilter.trim() || null,
          api_key_override: apiKeyOverride.trim() || null,
        }),
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setAcousticStatus(json.data as AcousticMendStatusResponse);
        if (showToast) {
          showToast(
            enableAcoustIdLookup
              ? 'Started Chromaprint + AcoustID Acoustic Mend scan...'
              : 'Started Offline Chromaprint Acoustic Duplicate scan...'
          );
        }
      } else {
        setErrorMsg(json?.error || 'Failed to start Acoustic Mend scan');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Acoustic Mend request failed');
    } finally {
      setBusy(false);
    }
  };

  const pauseAcousticScan = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/fingerprint/pause'), {
        method: 'POST',
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setAcousticStatus(json.data as AcousticMendStatusResponse);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to pause Acoustic Mend scan');
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
          showToast(
            `Applied ${res.applied_count} track fix(es) (${res.moved_count} moved); undo journal saved.`
          );
        }
      } else {
        setErrorMsg(json?.error || 'Failed to apply plan');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to apply plan');
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
          showToast(`Reverted ${json.data?.restored ?? 0} file(s) from undo journal.`);
        }
        setLastApply(null);
        if (stageMode === 'catalog_reunion') {
          scanAndPreview();
        }
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

  const art = acousticStatus?.runtime;
  const duplicates = acousticStatus?.duplicates ?? [];
  const acousticPct =
    art && art.total_files > 0
      ? Math.min(100, Math.round((art.processed_files / art.total_files) * 100))
      : 0;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 18px', gap: 8 }}>
      {/* Sub-mode switcher: Catalog Reunion vs Chromaprint Acoustic Mend */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button
            type="button"
            data-focusable="true"
            onClick={() => {
              setStageMode('catalog_reunion');
              setErrorMsg(null);
            }}
            style={liberationFilterPillStyle(stageMode === 'catalog_reunion', '#38bdf8')}
          >
            Catalog Album Reunion
          </button>
          <button
            type="button"
            data-focusable="true"
            onClick={() => {
              setStageMode('acoustic_mend');
              setErrorMsg(null);
              if (acousticStatus?.plan) {
                setPlan(acousticStatus.plan);
                setSelectedIds(new Set(acousticStatus.plan.proposed_items.map((it) => it.item_id)));
              }
            }}
            style={liberationFilterPillStyle(stageMode === 'acoustic_mend', '#c084fc')}
          >
            Acoustic Fingerprint &amp; Mend (Chromaprint)
          </button>
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#cbd5e1', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={moveFiles}
            onChange={(e) => setMoveFiles(e.target.checked)}
          />
          Move files into canonical Artist/Album folder
        </label>
      </div>

      <div style={{ fontSize: 11, color: '#cbd5e1' }}>
        {stageMode === 'catalog_reunion' ? (
          <>
            Matches orphaned <code>- Single</code> / <code>- EP</code> tracks back to their parent albums using Apple Catalog tracklists + ISRCs. Always previews first and writes a reversible JSON undo journal before modifying tags or folders.
          </>
        ) : (
          <>
            Pure-Rust <strong>Chromaprint</strong> audio fingerprinting (no <code>fpcalc</code> required). Resolves missing or drifted tags via AcoustID/MusicBrainz (preferring canonical Studio Albums, high-confidence gated) and detects <strong>offline cross-codec acoustic duplicates</strong>. Uncataloged / homebrew tracks are left strictly untouched.
          </>
        )}
      </div>

      {/* Folder Input + Primary Action */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <input
          type="text"
          value={rootDir}
          onChange={(e) => setRootDir(e.target.value)}
          placeholder="Folder containing reclaimed / local albums..."
          style={{
            flex: 1,
            minWidth: 220,
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

        {stageMode === 'catalog_reunion' ? (
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
        ) : (
          <>
            <button
              type="button"
              data-focusable="true"
              disabled={busy || acousticRunning || !rootDir.trim()}
              onClick={startAcousticScan}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid rgba(192, 132, 252, 0.55)',
                background:
                  !busy && !acousticRunning && rootDir.trim()
                    ? 'rgba(168, 85, 247, 0.22)'
                    : 'rgba(255,255,255,0.04)',
                color: !busy && !acousticRunning && rootDir.trim() ? '#e9d5ff' : '#64748b',
                fontSize: 11.5,
                fontWeight: 800,
                cursor: !busy && !acousticRunning && rootDir.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              {acousticRunning ? 'Fingerprinting...' : 'Run Acoustic Scan (Dry-Run)'}
            </button>
            {acousticRunning && (
              <button
                type="button"
                data-focusable="true"
                disabled={busy}
                onClick={pauseAcousticScan}
                style={liberationFilterPillStyle(false, '#fcd34d')}
              >
                <ImpIcon name="pause" size={11} style={{ marginRight: 4 }} />
                Pause
              </button>
            )}
          </>
        )}
      </div>

      {/* Mode-specific Controls */}
      {stageMode === 'catalog_reunion' ? (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#cbd5e1', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useAppleCatalog}
              onChange={(e) => setUseAppleCatalog(e.target.checked)}
            />
            Verify missing slots via Apple Music Catalog (ISRC + duration)
          </label>
          {plan && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', fontSize: 10.5 }}>
              <span style={liberationChipStyle('#e2e8f0')}>Scanned: {plan.scanned_files}</span>
              <span style={liberationChipStyle('#fbbf24')}>Incomplete Albums: {plan.incomplete_albums_found}</span>
              <span style={liberationChipStyle('#34d399')}>Matches Proposed: {plan.proposed_items.length}</span>
            </div>
          )}
        </div>
      ) : (
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 9,
            background: 'rgba(12, 16, 26, 0.84)',
            border: '1px solid rgba(192, 132, 252, 0.2)',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 10.5, color: '#94a3b8', fontWeight: 700 }}>Target Files:</span>
              <button
                type="button"
                data-focusable="true"
                onClick={() => setMendTargetMode('unknowns_only')}
                style={liberationFilterPillStyle(mendTargetMode === 'unknowns_only', '#c084fc')}
              >
                Unknowns &amp; Drifted Only
              </button>
              <button
                type="button"
                data-focusable="true"
                onClick={() => setMendTargetMode('all')}
                style={liberationFilterPillStyle(mendTargetMode === 'all', '#38bdf8')}
              >
                All Audio Files
              </button>
            </div>

            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#cbd5e1', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={enableAcoustIdLookup}
                onChange={(e) => setEnableAcoustIdLookup(e.target.checked)}
              />
              AcoustID + MusicBrainz lookup (uncheck for 100% offline dedup)
            </label>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={folderFilter}
              onChange={(e) => setFolderFilter(e.target.value)}
              placeholder="Optional subfolder / artist filter (e.g. Example Artist)..."
              style={{
                flex: '1 1 200px',
                minWidth: 160,
                padding: '5px 8px',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(0,0,0,0.4)',
                color: '#f1f5f9',
                fontSize: 11,
              }}
            />
            {enableAcoustIdLookup && (
              <input
                type="password"
                value={apiKeyOverride}
                onChange={(e) => setApiKeyOverride(e.target.value)}
                placeholder={
                  art?.has_api_key
                    ? 'AcoustID key ready (optional override)...'
                    : 'AcoustID API key (or set ACOUSTID_API_KEY)...'
                }
                style={{
                  flex: '0 1 240px',
                  minWidth: 180,
                  padding: '5px 8px',
                  borderRadius: 6,
                  border: art?.has_api_key
                    ? '1px solid rgba(52, 211, 153, 0.35)'
                    : '1px solid rgba(251, 191, 36, 0.45)',
                  background: 'rgba(0,0,0,0.4)',
                  color: '#f1f5f9',
                  fontSize: 11,
                }}
              />
            )}
          </div>

          {art && (art.running || art.processed_files > 0) && (
            <>
              <div style={{ height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${acousticPct}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, #a855f7, #38bdf8, #34d399)',
                    transition: 'width 200ms ease',
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10.5, color: '#cbd5e1' }}>
                <span>
                  {art.last_message}
                  {art.running && art.current_file ? (
                    <span style={{ color: '#94a3b8', marginLeft: 8 }}>({art.current_file})</span>
                  ) : null}
                </span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span style={liberationChipStyle('#e2e8f0')}>
                    {art.processed_files}/{art.total_files} files ({art.fingerprinted_cached} cached)
                  </span>
                  <span style={liberationChipStyle('#34d399')}>Mends: {art.proposed_mends}</span>
                  <span style={liberationChipStyle('#a1a1aa')}>Unique/Untouched: {art.unmatched_unique}</span>
                  <span style={liberationChipStyle('#fbbf24')}>
                    Acoustic Dup Groups: {art.duplicate_groups_found}
                  </span>
                </div>
              </div>
            </>
          )}

          {art && !art.running && (art.proposed_mends > 0 || duplicates.length > 0) && (
            <div style={{ display: 'flex', gap: 6, paddingTop: 2 }}>
              <button
                type="button"
                data-focusable="true"
                onClick={() => setAcousticSubView('mends')}
                style={liberationFilterPillStyle(acousticSubView === 'mends', '#34d399')}
              >
                Proposed Tag/Folder Mends ({plan?.proposed_items.length ?? 0})
              </button>
              <button
                type="button"
                data-focusable="true"
                onClick={() => setAcousticSubView('duplicates')}
                style={liberationFilterPillStyle(acousticSubView === 'duplicates', '#fbbf24')}
              >
                Offline Acoustic Duplicates ({duplicates.length} groups)
              </button>
            </div>
          )}
        </div>
      )}

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
            Undo Last Apply
          </button>
        </div>
      )}

      {/* Results Area: Either Offline Acoustic Duplicates OR Dry-Run Diff Checklist */}
      {stageMode === 'acoustic_mend' && acousticSubView === 'duplicates' ? (
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowY: 'auto',
            border: '1px solid rgba(251, 191, 36, 0.25)',
            borderRadius: 10,
            background: 'rgba(7, 9, 15, 0.72)',
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 10.5, color: '#fde68a', padding: '2px 4px' }}>
            Read-only acoustic duplicate report (matches across different codecs/bitrates where byte hashes differ). IMP never auto-deletes files.
          </div>
          {duplicates.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
              No cross-codec acoustic duplicates detected in this scan.
            </div>
          ) : (
            duplicates.map((grp) => (
              <div
                key={grp.group_id}
                style={{
                  padding: '8px 10px',
                  borderRadius: 8,
                  background: 'rgba(251, 191, 36, 0.06)',
                  border: '1px solid rgba(251, 191, 36, 0.26)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 5,
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, fontWeight: 800, color: '#fde68a' }}>
                  <span>
                    Group {grp.group_id} ({grp.items.length} acoustically matching files)
                  </span>
                  <span>{grp.best_similarity_pct.toFixed(1)}% match</span>
                </div>
                {grp.items.map((item) => (
                  <div
                    key={item.file_path}
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 10,
                      padding: '4px 6px',
                      borderRadius: 6,
                      background: 'rgba(0,0,0,0.3)',
                      fontSize: 10.5,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div style={{ color: '#f1f5f9', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.artist || 'Unknown Artist'} — {item.title || 'Untitled'} ({item.album || 'No Album'})
                      </div>
                      <div style={{ fontSize: 9.5, color: '#94a3b8', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={item.file_path}>
                        {item.file_path}
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 6, whiteSpace: 'nowrap', fontSize: 10, fontFamily: 'monospace', color: '#cbd5e1' }}>
                      <span style={liberationChipStyle('#7dd3fc')}>{item.container_format}</span>
                      <span>{formatBytesHuman(item.file_size_bytes)}</span>
                      <span>{item.duration_sec}s</span>
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      ) : (
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
              {stageMode === 'catalog_reunion'
                ? 'Pick a folder and click [Scan & Preview Plan (Dry-Run)] to inspect album reunion matches.'
                : 'Pick a folder and click [Run Acoustic Scan (Dry-Run)] to compute Chromaprint fingerprints, mend drifted tags, or spot offline duplicates.'}
            </div>
          ) : plan.proposed_items.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
              {stageMode === 'catalog_reunion'
                ? 'No high-confidence stray singles needed reunion in this folder.'
                : 'No high-confidence metadata mends needed (check Offline Acoustic Duplicates tab if any duplicates were found).'}
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
                        {(it.proposed_artist || it.proposed_title) && (
                          <span style={{ color: '#c4b5fd', marginLeft: 6 }}>
                            → {it.proposed_artist || it.artist} — {it.proposed_title || it.title}
                          </span>
                        )}
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
                      {it.proposed_year ? ` · ${it.proposed_year}` : ''}
                    </div>
                    <div style={{ fontSize: 10, color: '#94a3b8' }}>{it.match_reason}</div>
                  </div>
                </label>
              );
            })
          )}
        </div>
      )}

      {/* Apply Footer (shown when viewing proposed dry-run diffs) */}
      {plan && plan.proposed_items.length > 0 && !(stageMode === 'acoustic_mend' && acousticSubView === 'duplicates') && (
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
            Apply Selected ({selectedIds.size})
          </button>
        </div>
      )}
    </div>
  );
};
