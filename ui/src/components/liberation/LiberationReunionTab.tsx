import React, { useCallback, useEffect, useMemo, useState } from 'react';
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

interface CatalogReunionRuntimeStatus {
  phase: string;
  running: boolean;
  pause_requested: boolean;
  root_dir: string;
  folder_filter: string;
  use_apple_catalog: boolean;
  total_files: number;
  scanned_files: number;
  incomplete_albums_found: number;
  catalog_lookups_performed: number;
  proposed_matches: number;
  current_item: string;
  last_message: string;
  started_at: number | null;
  updated_at: number;
}

interface CatalogReunionStatusResponse {
  runtime: CatalogReunionRuntimeStatus;
  plan: ReunionPlanReport | null;
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
  clean_skipped?: number;
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

type TriageBucket = 'all' | 'missing_tags' | 'track_year_only' | 'album_rewrite' | 'needs_review';

function normCmp(s?: string | null): string {
  return (s || '')
    .trim()
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC`]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\s+/g, ' ');
}

function isGenericOrBrokenTitle(raw: string): boolean {
  const t = raw.trim().toLowerCase();
  if (!t || t === 'unknown' || t === 'untitled') return true;
  if (/^(audio)?track[\s\-_#]*\d+$/i.test(t)) return true;
  const mojibake = (raw.match(/[¥©¤ÃÂ¢£¦ªº¿À-ÅÕØÞ]/g) || []).length;
  return mojibake >= 2;
}

function classifyMendBucket(it: ReunionMoveItem): Exclude<TriageBucket, 'all'> {
  if (it.confidence === 'review') return 'needs_review';
  const brokenArtist =
    !it.artist.trim() ||
    ['unknown', 'unknown artist', 'artist', 'various'].includes(normCmp(it.artist));
  const brokenAlbum =
    !it.current_album.trim() ||
    it.current_album === '(Missing Album)' ||
    ['unknown', 'unknown album', 'misc', 'singles'].includes(normCmp(it.current_album));
  if (brokenArtist || brokenAlbum || isGenericOrBrokenTitle(it.title)) {
    return 'missing_tags';
  }
  const albumChanged = normCmp(it.current_album) !== normCmp(it.proposed_album);
  const titleChanged = Boolean(it.proposed_title && normCmp(it.proposed_title) !== normCmp(it.title));
  const artistChanged = Boolean(
    it.proposed_artist && normCmp(it.proposed_artist) !== normCmp(it.artist)
  );
  if (!albumChanged && !titleChanged && !artistChanged) {
    return 'track_year_only';
  }
  return 'album_rewrite';
}

function isSafeAutoSelectItem(it: ReunionMoveItem): boolean {
  const bucket = classifyMendBucket(it);
  return bucket === 'missing_tags' || bucket === 'track_year_only';
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
    case 'review':
      return { label: 'Needs Review (Verify)', color: '#fb7185' };
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
  const [folderFilter, setFolderFilter] = useState('');

  // Completely isolated plan + selection state per mode (prevents cross-tab bleed!)
  const [catalogStatus, setCatalogStatus] = useState<CatalogReunionStatusResponse | null>(null);
  const [catalogPlan, setCatalogPlan] = useState<ReunionPlanReport | null>(null);
  const [catalogSelectedIds, setCatalogSelectedIds] = useState<Set<string>>(new Set());

  const [acousticStatus, setAcousticStatus] = useState<AcousticMendStatusResponse | null>(null);
  const [acousticPlan, setAcousticPlan] = useState<ReunionPlanReport | null>(null);
  const [acousticSelectedIds, setAcousticSelectedIds] = useState<Set<string>>(new Set());

  // Triage controls for large Stage 3 result sets
  const [triageBucket, setTriageBucket] = useState<TriageBucket>('all');
  const [highConfOnly, setHighConfOnly] = useState(false);
  const [resultSearch, setResultSearch] = useState('');
  const [groupByAlbum, setGroupByAlbum] = useState(true);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const [lastApply, setLastApply] = useState<ReunionApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Sub-Wave 9.8: Pure-Rust Chromaprint + AcoustID controls
  const [mendTargetMode, setMendTargetMode] = useState<'unknowns_only' | 'all'>('unknowns_only');
  const [enableAcoustIdLookup, setEnableAcoustIdLookup] = useState(true);
  const [apiKeyOverride, setApiKeyOverride] = useState('');
  const [acousticSubView, setAcousticSubView] = useState<'mends' | 'duplicates'>('mends');

  const activePlan = stageMode === 'catalog_reunion' ? catalogPlan : acousticPlan;
  const activeSelectedIds =
    stageMode === 'catalog_reunion' ? catalogSelectedIds : acousticSelectedIds;
  const setActiveSelectedIds =
    stageMode === 'catalog_reunion' ? setCatalogSelectedIds : setAcousticSelectedIds;

  const fetchCatalogStatus = useCallback(async () => {
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/reunion/status'));
      const json = await resp.json();
      if (json?.ok && json?.data) {
        const next = json.data as CatalogReunionStatusResponse;
        setCatalogStatus(next);
        if (!rootDir && next.runtime.root_dir) {
          setRootDir(next.runtime.root_dir);
        }
        if (next.plan && !next.runtime.running) {
          setCatalogPlan((prev) => {
            if (prev?.plan_id === next.plan?.plan_id) return prev;
            if (next.plan) {
              setCatalogSelectedIds(new Set(next.plan.proposed_items.map((it) => it.item_id)));
            }
            return next.plan;
          });
        }
      }
    } catch {
      // ignore transient poll errors
    }
  }, [rootDir, setRootDir]);

  const fetchAcousticStatus = useCallback(async () => {
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/fingerprint/status'));
      const json = await resp.json();
      if (json?.ok && json?.data) {
        const next = json.data as AcousticMendStatusResponse;
        setAcousticStatus(next);
        if (!rootDir && next.runtime.root_dir) {
          setRootDir(next.runtime.root_dir);
        }
        if (next.plan && !next.runtime.running) {
          setAcousticPlan((prev) => {
            if (prev?.plan_id === next.plan?.plan_id) return prev;
            if (next.plan) {
              // Auto-select ONLY safe wins (missing/broken tags & track/year fills) by default
              const safeIds = next.plan.proposed_items
                .filter((it) => isSafeAutoSelectItem(it))
                .map((it) => it.item_id);
              setAcousticSelectedIds(new Set(safeIds));
            }
            return next.plan;
          });
        }
      }
    } catch {
      // ignore transient poll errors
    }
  }, [rootDir, setRootDir]);

  useEffect(() => {
    if (!open) return;
    fetchCatalogStatus();
    fetchAcousticStatus();
  }, [open, fetchCatalogStatus, fetchAcousticStatus]);

  const catalogRunning = Boolean(catalogStatus?.runtime?.running);
  useEffect(() => {
    if (!open || !catalogRunning) return;
    const t = window.setInterval(fetchCatalogStatus, 1000);
    return () => window.clearInterval(t);
  }, [open, catalogRunning, fetchCatalogStatus]);

  const acousticRunning = Boolean(acousticStatus?.runtime?.running);
  useEffect(() => {
    if (!open || !acousticRunning) return;
    const t = window.setInterval(fetchAcousticStatus, 1200);
    return () => window.clearInterval(t);
  }, [open, acousticRunning, fetchAcousticStatus]);

  const startCatalogScan = async () => {
    if (!rootDir.trim()) {
      setErrorMsg('Choose or enter a local folder to scan.');
      return;
    }
    setBusy(true);
    setErrorMsg(null);
    setLastApply(null);
    setCatalogPlan(null);
    setCatalogSelectedIds(new Set());
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/reunion/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          root_dir: rootDir.trim(),
          use_apple_catalog: useAppleCatalog,
          folder_filter: folderFilter.trim() || null,
        }),
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setCatalogStatus(json.data as CatalogReunionStatusResponse);
        if (showToast) {
          showToast('Started parallel Catalog Album Reunion dry-run scan...');
        }
      } else {
        setErrorMsg(json?.error || 'Reunion dry-run failed to start');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Reunion dry-run request failed');
    } finally {
      setBusy(false);
    }
  };

  const pauseCatalogScan = async () => {
    setBusy(true);
    setErrorMsg(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/reunion/pause'), {
        method: 'POST',
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setCatalogStatus(json.data as CatalogReunionStatusResponse);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to pause Catalog Reunion scan');
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
    setAcousticPlan(null);
    setAcousticSelectedIds(new Set());
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
    if (!activePlan || activeSelectedIds.size === 0) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/reunion/apply'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan_id: activePlan.plan_id,
          selected_item_ids: Array.from(activeSelectedIds),
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
    setActiveSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bucketCounts = useMemo(() => {
    const counts = {
      all: 0,
      missing_tags: 0,
      track_year_only: 0,
      album_rewrite: 0,
      needs_review: 0,
    };
    const items = activePlan?.proposed_items ?? [];
    counts.all = items.length;
    for (const it of items) {
      counts[classifyMendBucket(it)] += 1;
    }
    return counts;
  }, [activePlan]);

  const visibleItems = useMemo(() => {
    const items = activePlan?.proposed_items ?? [];
    const q = resultSearch.trim().toLowerCase();
    return items.filter((it) => {
      if (triageBucket !== 'all' && classifyMendBucket(it) !== triageBucket) return false;
      if (highConfOnly && it.confidence !== 'high' && it.confidence !== 'exact_isrc') return false;
      if (q) {
        const hay = `${it.artist} ${it.proposed_artist || ''} ${it.title} ${it.proposed_title || ''} ${it.current_album} ${it.proposed_album} ${it.match_reason}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [activePlan, triageBucket, highConfOnly, resultSearch]);

  const groupedVisible = useMemo(() => {
    const map = new Map<string, { key: string; albumLabel: string; items: ReunionMoveItem[] }>();
    for (const it of visibleItems) {
      const key = `${normCmp(it.proposed_album_artist)}::${normCmp(it.proposed_album)}`;
      const existing = map.get(key);
      if (existing) {
        existing.items.push(it);
      } else {
        map.set(key, {
          key,
          albumLabel: `${it.proposed_album_artist} — ${it.proposed_album}`,
          items: [it],
        });
      }
    }
    return Array.from(map.values()).sort((a, b) => b.items.length - a.items.length);
  }, [visibleItems]);

  const crt = catalogStatus?.runtime;
  const catalogPct =
    crt && crt.total_files > 0
      ? Math.min(100, Math.round((crt.scanned_files / crt.total_files) * 100))
      : 0;

  const art = acousticStatus?.runtime;
  const duplicates = acousticStatus?.duplicates ?? [];
  const acousticPct =
    art && art.total_files > 0
      ? Math.min(100, Math.round((art.processed_files / art.total_files) * 100))
      : 0;

  const renderMoveItemRow = (it: ReunionMoveItem) => {
    const conf = confidenceColor(it.confidence);
    const checked = activeSelectedIds.has(it.item_id);
    return (
      <label
        key={it.item_id}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 10,
          padding: '7px 10px',
          borderRadius: 8,
          background: checked ? 'rgba(56, 189, 248, 0.08)' : 'rgba(255,255,255,0.02)',
          border:
            it.confidence === 'review'
              ? '1px solid rgba(251, 113, 133, 0.35)'
              : checked
                ? '1px solid rgba(56, 189, 248, 0.35)'
                : '1px solid rgba(255,255,255,0.06)',
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
  };

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
              setTriageBucket('all');
              setErrorMsg(null);
            }}
            style={liberationFilterPillStyle(stageMode === 'catalog_reunion', '#38bdf8')}
          >
            Catalog Album Reunion
            {catalogPlan ? ` (${catalogPlan.proposed_items.length})` : ''}
          </button>
          <button
            type="button"
            data-focusable="true"
            onClick={() => {
              setStageMode('acoustic_mend');
              setTriageBucket('all');
              setErrorMsg(null);
            }}
            style={liberationFilterPillStyle(stageMode === 'acoustic_mend', '#c084fc')}
          >
            Acoustic Fingerprint &amp; Mend (Chromaprint)
            {acousticPlan ? ` (${acousticPlan.proposed_items.length})` : ''}
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
            Parallel-scans local audio tags, matches orphaned <code>- Single</code> / <code>- EP</code> and lone 1-track strays back to your incomplete owned albums via Apple Catalog ISRCs (keeping multi-track albums intact), and writes a reversible JSON undo journal before any edit.
          </>
        ) : (
          <>
            Pure-Rust <strong>Chromaprint</strong> audio fingerprinting (no <code>fpcalc</code> required). Resolves missing or drifted tags via AcoustID/MusicBrainz (with folder-consensus album stitching &amp; safe-only default selection) and detects <strong>offline cross-codec acoustic duplicates</strong>.
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
          <>
            <button
              type="button"
              data-focusable="true"
              disabled={busy || catalogRunning || !rootDir.trim()}
              onClick={startCatalogScan}
              style={{
                padding: '6px 12px',
                borderRadius: 8,
                border: '1px solid rgba(56, 189, 248, 0.5)',
                background:
                  !busy && !catalogRunning && rootDir.trim()
                    ? 'rgba(14, 165, 233, 0.2)'
                    : 'rgba(255,255,255,0.04)',
                color: !busy && !catalogRunning && rootDir.trim() ? '#7dd3fc' : '#64748b',
                fontSize: 11.5,
                fontWeight: 800,
                cursor: !busy && !catalogRunning && rootDir.trim() ? 'pointer' : 'not-allowed',
              }}
            >
              {catalogRunning ? 'Scanning...' : 'Scan & Preview Plan (Dry-Run)'}
            </button>
            {catalogRunning && (
              <button
                type="button"
                data-focusable="true"
                disabled={busy}
                onClick={pauseCatalogScan}
                style={liberationFilterPillStyle(false, '#fcd34d')}
              >
                <ImpIcon name="pause" size={11} style={{ marginRight: 4 }} />
                Pause
              </button>
            )}
          </>
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

      {/* Mode-specific Controls & Progress */}
      {stageMode === 'catalog_reunion' ? (
        <div
          style={{
            padding: '8px 10px',
            borderRadius: 9,
            background: 'rgba(12, 16, 26, 0.84)',
            border: '1px solid rgba(56, 189, 248, 0.2)',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#cbd5e1', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={useAppleCatalog}
                onChange={(e) => setUseAppleCatalog(e.target.checked)}
              />
              Verify missing slots via Apple Music Catalog (ISRC + duration)
            </label>
            <input
              type="text"
              value={folderFilter}
              onChange={(e) => setFolderFilter(e.target.value)}
              placeholder="Optional subfolder / artist filter..."
              style={{
                flex: '0 1 240px',
                minWidth: 160,
                padding: '4px 8px',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(0,0,0,0.4)',
                color: '#f1f5f9',
                fontSize: 11,
              }}
            />
          </div>

          {crt && (crt.running || crt.scanned_files > 0) && (
            <>
              <div style={{ height: 5, borderRadius: 999, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <div
                  style={{
                    width: `${catalogPct}%`,
                    height: '100%',
                    background: 'linear-gradient(90deg, #38bdf8, #34d399)',
                    transition: 'width 200ms ease',
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: 10.5, color: '#cbd5e1' }}>
                <span>
                  {crt.last_message}
                  {crt.running && crt.current_item ? (
                    <span style={{ color: '#94a3b8', marginLeft: 8 }}>({crt.current_item})</span>
                  ) : null}
                </span>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <span style={liberationChipStyle('#e2e8f0')}>
                    Scanned: {crt.scanned_files}/{crt.total_files}
                  </span>
                  <span style={liberationChipStyle('#fbbf24')}>
                    Incomplete Albums: {crt.incomplete_albums_found}
                  </span>
                  <span style={liberationChipStyle('#34d399')}>
                    Matches Proposed: {crt.proposed_matches}
                  </span>
                </div>
              </div>
            </>
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
                  {(art.clean_skipped ?? 0) > 0 && (
                    <span style={liberationChipStyle('#94a3b8')}>
                      Clean Skipped: {art.clean_skipped}
                    </span>
                  )}
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
                Proposed Tag/Folder Mends ({acousticPlan?.proposed_items.length ?? 0})
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

      {/* Smart Triage Bar (when viewing proposed mends/reunions) */}
      {activePlan &&
        activePlan.proposed_items.length > 0 &&
        !(stageMode === 'acoustic_mend' && acousticSubView === 'duplicates') && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', alignItems: 'center' }}>
              <button
                type="button"
                data-focusable="true"
                onClick={() => setTriageBucket('all')}
                style={liberationFilterPillStyle(triageBucket === 'all', '#e2e8f0')}
              >
                All ({bucketCounts.all})
              </button>
              {bucketCounts.missing_tags > 0 && (
                <button
                  type="button"
                  data-focusable="true"
                  onClick={() => setTriageBucket('missing_tags')}
                  style={liberationFilterPillStyle(triageBucket === 'missing_tags', '#34d399')}
                >
                  Missing / Broken Tags ({bucketCounts.missing_tags})
                </button>
              )}
              {bucketCounts.track_year_only > 0 && (
                <button
                  type="button"
                  data-focusable="true"
                  onClick={() => setTriageBucket('track_year_only')}
                  style={liberationFilterPillStyle(triageBucket === 'track_year_only', '#38bdf8')}
                >
                  Track # / Year Fill ({bucketCounts.track_year_only})
                </button>
              )}
              {bucketCounts.album_rewrite > 0 && (
                <button
                  type="button"
                  data-focusable="true"
                  onClick={() => setTriageBucket('album_rewrite')}
                  style={liberationFilterPillStyle(triageBucket === 'album_rewrite', '#fbbf24')}
                >
                  Album / Title Changes ({bucketCounts.album_rewrite})
                </button>
              )}
              {bucketCounts.needs_review > 0 && (
                <button
                  type="button"
                  data-focusable="true"
                  onClick={() => setTriageBucket('needs_review')}
                  style={liberationFilterPillStyle(triageBucket === 'needs_review', '#fb7185')}
                >
                  Needs Review ({bucketCounts.needs_review})
                </button>
              )}
              <button
                type="button"
                data-focusable="true"
                onClick={() => setHighConfOnly((v) => !v)}
                style={liberationFilterPillStyle(highConfOnly, '#6ee7b7')}
              >
                High Conf Only
              </button>
              <button
                type="button"
                data-focusable="true"
                onClick={() => setGroupByAlbum((v) => !v)}
                style={liberationFilterPillStyle(groupByAlbum, '#c084fc')}
              >
                Group by Album
              </button>
            </div>
            <input
              type="text"
              value={resultSearch}
              onChange={(e) => setResultSearch(e.target.value)}
              placeholder="Filter results..."
              style={{
                width: 170,
                padding: '4px 8px',
                borderRadius: 6,
                border: '1px solid rgba(255,255,255,0.14)',
                background: 'rgba(0,0,0,0.4)',
                color: '#f1f5f9',
                fontSize: 11,
              }}
            />
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
          {!activePlan ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
              {stageMode === 'catalog_reunion'
                ? 'Pick a folder and click [Scan & Preview Plan (Dry-Run)] to inspect album reunion matches.'
                : 'Pick a folder and click [Run Acoustic Scan (Dry-Run)] to compute Chromaprint fingerprints, mend drifted tags, or spot offline duplicates.'}
            </div>
          ) : activePlan.proposed_items.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
              {stageMode === 'catalog_reunion'
                ? 'No high-confidence stray singles needed reunion in this folder.'
                : 'No high-confidence metadata mends needed (check Offline Acoustic Duplicates tab if any duplicates were found).'}
            </div>
          ) : visibleItems.length === 0 ? (
            <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
              No items match the active triage filter.
            </div>
          ) : groupByAlbum ? (
            groupedVisible.map((grp) => {
              const allChecked = grp.items.every((it) => activeSelectedIds.has(it.item_id));
              const someChecked = grp.items.some((it) => activeSelectedIds.has(it.item_id));
              const isCollapsed = collapsedGroups.has(grp.key);
              return (
                <div
                  key={grp.key}
                  style={{
                    border: '1px solid rgba(255,255,255,0.09)',
                    borderRadius: 9,
                    background: 'rgba(13, 17, 28, 0.7)',
                    overflow: 'hidden',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 8,
                      padding: '6px 10px',
                      background: 'rgba(255,255,255,0.03)',
                      borderBottom: isCollapsed ? 'none' : '1px solid rgba(255,255,255,0.06)',
                      fontSize: 11,
                    }}
                  >
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 800, color: '#e2e8f0' }}>
                      <input
                        type="checkbox"
                        checked={allChecked}
                        ref={(el) => {
                          if (el) el.indeterminate = someChecked && !allChecked;
                        }}
                        onChange={() => {
                          setActiveSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (allChecked) {
                              grp.items.forEach((it) => next.delete(it.item_id));
                            } else {
                              grp.items.forEach((it) => next.add(it.item_id));
                            }
                            return next;
                          });
                        }}
                      />
                      <span>{grp.albumLabel}</span>
                      <span style={{ color: '#94a3b8', fontWeight: 600 }}>
                        ({grp.items.length} track{grp.items.length === 1 ? '' : 's'})
                      </span>
                    </label>
                    <button
                      type="button"
                      data-focusable="true"
                      onClick={() => {
                        setCollapsedGroups((prev) => {
                          const next = new Set(prev);
                          if (next.has(grp.key)) next.delete(grp.key);
                          else next.add(grp.key);
                          return next;
                        });
                      }}
                      style={liberationFilterPillStyle(false, '#94a3b8')}
                    >
                      {isCollapsed ? 'Expand' : 'Collapse'}
                    </button>
                  </div>
                  {!isCollapsed && (
                    <div style={{ padding: 6, display: 'flex', flexDirection: 'column', gap: 5 }}>
                      {grp.items.map(renderMoveItemRow)}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            visibleItems.map(renderMoveItemRow)
          )}
        </div>
      )}

      {/* Apply Footer (shown when viewing proposed dry-run diffs) */}
      {activePlan &&
        activePlan.proposed_items.length > 0 &&
        !(stageMode === 'acoustic_mend' && acousticSubView === 'duplicates') && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button
                type="button"
                data-focusable="true"
                onClick={() =>
                  setActiveSelectedIds(
                    new Set(
                      activePlan.proposed_items
                        .filter((it) => isSafeAutoSelectItem(it))
                        .map((it) => it.item_id)
                    )
                  )
                }
                style={liberationFilterPillStyle(false, '#34d399')}
              >
                Select Safe Only
              </button>
              <button
                type="button"
                data-focusable="true"
                onClick={() =>
                  setActiveSelectedIds((prev) => {
                    const next = new Set(prev);
                    visibleItems.forEach((it) => next.add(it.item_id));
                    return next;
                  })
                }
                style={liberationFilterPillStyle(false, '#7dd3fc')}
              >
                Select Visible ({visibleItems.length})
              </button>
              <button
                type="button"
                data-focusable="true"
                onClick={() =>
                  setActiveSelectedIds(new Set(activePlan.proposed_items.map((it) => it.item_id)))
                }
                style={liberationFilterPillStyle(false, '#e2e8f0')}
              >
                Select All
              </button>
              <button
                type="button"
                data-focusable="true"
                onClick={() => setActiveSelectedIds(new Set())}
                style={liberationFilterPillStyle(false, '#e2e8f0')}
              >
                Select None
              </button>
            </div>
            <button
              type="button"
              data-focusable="true"
              disabled={busy || activeSelectedIds.size === 0}
              onClick={applySelected}
              style={{
                padding: '7px 14px',
                borderRadius: 8,
                border: '1px solid rgba(52, 211, 153, 0.5)',
                background:
                  !busy && activeSelectedIds.size > 0
                    ? 'rgba(16, 185, 129, 0.22)'
                    : 'rgba(255,255,255,0.04)',
                color: !busy && activeSelectedIds.size > 0 ? '#6ee7b7' : '#64748b',
                fontSize: 12,
                fontWeight: 800,
                cursor: !busy && activeSelectedIds.size > 0 ? 'pointer' : 'not-allowed',
              }}
            >
              Apply Selected ({activeSelectedIds.size})
            </button>
          </div>
        )}
    </div>
  );
};
