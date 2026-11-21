import React, { useCallback, useEffect, useState } from 'react';
import { resolveDaemonUrl } from '../api/servicesCacheApi';
import { FolderChooserModal } from './FolderChooserModal';
import { ImpIcon } from './icons/ImpIcon';
import { LiberationAuditTab } from './liberation/LiberationAuditTab';
import { LiberationDownloadTab } from './liberation/LiberationDownloadTab';
import { LiberationReunionTab } from './liberation/LiberationReunionTab';
import {
  formatBytesHuman,
  formatDurationMs,
  liberationChipStyle as chipStyle,
  liberationFilterPillStyle as filterPillStyle,
  liberationTabBtnStyle as tabBtnStyle,
} from './liberation/liberationUiHelpers';

interface LiberationRuntimeStatus {
  phase: string;
  running: boolean;
  pause_requested: boolean;
  auth_expired: boolean;
  albums_indexed: number;
  songs_indexed: number;
  pages_fetched: number;
  probed_this_run: number;
  rate_limit_backoffs: number;
  last_message: string;
  started_at: number | null;
  updated_at: number;
}

interface LiberationFlavorStat {
  flavor: string;
  count: number;
}

interface LiberationCensusSummary {
  total_tracks: number;
  probed_tracks: number;
  pending_tracks: number;
  reclaimable_direct: number;
  reclaimable_clear_hls: number;
  subscription_drm_excluded: number;
  unavailable_tracks: number;
  error_tracks: number;
  origin_purchased: number;
  origin_matched: number;
  origin_uploaded: number;
  origin_subscription: number;
  origin_unknown: number;
  estimated_reclaimable_bytes: number;
  observed_flavors: LiberationFlavorStat[];
}

interface LiberationStatusResponse {
  runtime: LiberationRuntimeStatus;
  summary: LiberationCensusSummary;
}

interface LiberationTrackRecord {
  library_song_id: string;
  catalog_id: string | null;
  purchased_id: string | null;
  isrc: string | null;
  title: string;
  artist: string;
  album_artist: string;
  album: string;
  library_album_id: string | null;
  track_number: number | null;
  disc_number: number | null;
  album_track_count: number | null;
  duration_ms: number;
  year: number | null;
  genre: string;
  artwork_url: string | null;
  cloud_origin_hint: string;
  ownership_class: string;
  asset_flavor: string | null;
  asset_url_kind: string | null;
  observed_flavors_json: string;
  content_length_bytes: number | null;
  probe_status: string;
  verification_status: string;
  blake3_hash: string | null;
  last_error: string | null;
  updated_at: number;
}

interface StraySingleCandidate {
  library_song_id: string;
  title: string;
  artist: string;
  current_album: string;
  ownership_class: string;
  cloud_origin_hint: string;
  reason: string;
}

interface IncompleteAlbumDiagnostic {
  artist: string;
  album: string;
  normalized_album: string;
  owned_or_library_tracks: number;
  expected_track_count: number;
  missing_track_numbers: number[];
  reclaimable_count: number;
  subscription_count: number;
  pending_count: number;
  stray_candidates: StraySingleCandidate[];
}

interface LiberationDiagnosticsReport {
  total_albums_analyzed: number;
  incomplete_album_count: number;
  total_missing_slots: number;
  stray_single_candidate_count: number;
  incomplete_albums: IncompleteAlbumDiagnostic[];
}

interface LiberationModalProps {
  open: boolean;
  onClose: () => void;
  showToast?: (msg: string) => void;
}

type OwnershipFilter =
  | 'all'
  | 'reclaimable_direct'
  | 'reclaimable_clear_hls'
  | 'subscription_drm_excluded'
  | 'pending'
  | 'unavailable'
  | 'error';

type OriginFilter = 'all' | 'purchased' | 'matched' | 'uploaded' | 'subscription';
type VerificationFilter = 'all' | 'corrupt_failed' | 'verified_ok';

const PAGE_LIMIT = 50;

function ownershipMeta(cls: string): { label: string; color: string; bg: string; border: string } {
  switch (cls) {
    case 'reclaimable_direct':
      return {
        label: 'Reclaimable Direct',
        color: '#34d399',
        bg: 'rgba(16, 185, 129, 0.14)',
        border: 'rgba(52, 211, 153, 0.45)',
      };
    case 'reclaimable_clear_hls':
      return {
        label: 'Reclaimable Clear HLS',
        color: '#38bdf8',
        bg: 'rgba(56, 189, 248, 0.14)',
        border: 'rgba(56, 189, 248, 0.45)',
      };
    case 'subscription_drm_excluded':
      return {
        label: 'Subscription DRM',
        color: '#fb923c',
        bg: 'rgba(251, 146, 60, 0.12)',
        border: 'rgba(251, 146, 60, 0.35)',
      };
    case 'unavailable':
      return {
        label: 'Unavailable',
        color: '#a1a1aa',
        bg: 'rgba(161, 161, 170, 0.12)',
        border: 'rgba(161, 161, 170, 0.3)',
      };
    case 'error':
      return {
        label: 'Error',
        color: '#f87171',
        bg: 'rgba(248, 113, 113, 0.14)',
        border: 'rgba(248, 113, 113, 0.4)',
      };
    default:
      return {
        label: 'Pending',
        color: '#94a3b8',
        bg: 'rgba(148, 163, 184, 0.1)',
        border: 'rgba(148, 163, 184, 0.25)',
      };
  }
}

function originLabel(origin: string): string {
  switch (origin) {
    case 'purchased':
      return 'Purchased';
    case 'matched':
      return 'Matched';
    case 'uploaded':
      return 'Uploaded';
    case 'subscription':
      return 'Subscription';
    case 'matched_or_subscription':
      return 'Matched / Sub';
    default:
      return 'Unknown';
  }
}

export const LiberationModal: React.FC<LiberationModalProps> = ({ open, onClose, showToast }) => {
  const [statusData, setStatusData] = useState<LiberationStatusResponse | null>(null);
  const [activeTab, setActiveTab] = useState<
    'tracks' | 'diagnostics' | 'download' | 'audit' | 'reunion'
  >('tracks');
  const [rescueFolder, setRescueFolder] = useState<string>(() => {
    try {
      return window.localStorage.getItem('imp-liberation-folder') || '';
    } catch {
      return '';
    }
  });
  const [chooserTarget, setChooserTarget] = useState<'download' | 'audit' | 'reunion' | null>(null);
  const [downloadFilter, setDownloadFilter] = useState<{
    artist: string;
    album: string;
    search: string;
  }>({ artist: '', album: '', search: '' });

  const jumpToTargetedReclaim = useCallback(
    (next: { artist?: string; album?: string; search?: string }) => {
      const cleaned = {
        artist: (next.artist || '').trim(),
        album: (next.album || '').trim(),
        search: (next.search || '').trim(),
      };
      setDownloadFilter(cleaned);
      setActiveTab('download');
      if (showToast) {
        const label = [
          cleaned.artist ? `Artist: ${cleaned.artist}` : '',
          cleaned.album ? `Album: ${cleaned.album}` : '',
          cleaned.search ? `Search: ${cleaned.search}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        showToast(label ? `Targeted Stage 2A filter set (${label})` : 'Opened Stage 2A Reclamation');
      }
    },
    [showToast]
  );

  const updateRescueFolder = useCallback((next: string) => {
    setRescueFolder(next);
    try {
      window.localStorage.setItem('imp-liberation-folder', next);
    } catch {
      // ignore storage errors
    }
  }, []);
  const [ownershipFilter, setOwnershipFilter] = useState<OwnershipFilter>('all');
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');
  const [verificationFilter, setVerificationFilter] = useState<VerificationFilter>('all');
  const [searchInput, setSearchInput] = useState<string>('');
  const [appliedSearch, setAppliedSearch] = useState<string>('');
  const [pageOffset, setPageOffset] = useState<number>(0);

  const [tracks, setTracks] = useState<LiberationTrackRecord[]>([]);
  const [tracksTotal, setTracksTotal] = useState<number>(0);
  const [tracksLoading, setTracksLoading] = useState<boolean>(false);

  const [diagnostics, setDiagnostics] = useState<LiberationDiagnosticsReport | null>(null);
  const [diagLoading, setDiagLoading] = useState<boolean>(false);

  const [actionBusy, setActionBusy] = useState<boolean>(false);
  const [confirmReset, setConfirmReset] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const fetchStatus = useCallback(async (): Promise<LiberationStatusResponse | null> => {
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/census/status'));
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setStatusData(json.data as LiberationStatusResponse);
        return json.data as LiberationStatusResponse;
      }
      if (json?.error) setErrorMsg(json.error);
    } catch (err: any) {
      setErrorMsg(err?.message || 'Unable to query Liberation census status');
    }
    return null;
  }, []);

  const fetchTracks = useCallback(async () => {
    setTracksLoading(true);
    try {
      const params = new URLSearchParams();
      if (ownershipFilter !== 'all') params.set('ownership', ownershipFilter);
      if (originFilter !== 'all') params.set('origin', originFilter);
      if (verificationFilter !== 'all') params.set('verification', verificationFilter);
      if (appliedSearch.trim()) params.set('q', appliedSearch.trim());
      params.set('limit', String(PAGE_LIMIT));
      params.set('offset', String(pageOffset));

      const resp = await fetch(
        resolveDaemonUrl(`/api/liberation/tracks?${params.toString()}`)
      );
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setTracks(Array.isArray(json.data.tracks) ? json.data.tracks : []);
        setTracksTotal(Number(json.data.total) || 0);
      }
    } catch {
      // keep previous list on transient error
    } finally {
      setTracksLoading(false);
    }
  }, [ownershipFilter, originFilter, verificationFilter, appliedSearch, pageOffset]);

  const fetchDiagnostics = useCallback(async () => {
    setDiagLoading(true);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/diagnostics'));
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setDiagnostics(json.data as LiberationDiagnosticsReport);
      }
    } catch {
      // ignore transient error
    } finally {
      setDiagLoading(false);
    }
  }, []);

  // Load initial status + auto-hydrate rescueFolder from daemon runtime if blank
  useEffect(() => {
    if (!open) return;
    setConfirmReset(false);
    setErrorMsg(null);
    fetchStatus();
    if (!rescueFolder.trim()) {
      (async () => {
        for (const ep of [
          '/api/liberation/download/status',
          '/api/liberation/fingerprint/status',
          '/api/liberation/reunion/status',
        ]) {
          try {
            const resp = await fetch(resolveDaemonUrl(ep));
            const json = await resp.json();
            const candidate = (
              json?.data?.runtime?.dest_dir ||
              json?.data?.runtime?.root_dir ||
              ''
            ).trim();
            if (candidate) {
              updateRescueFolder(candidate);
              break;
            }
          } catch {
            // ignore transient endpoint error
          }
        }
      })();
    }
  }, [open, fetchStatus, rescueFolder, updateRescueFolder]);

  useEffect(() => {
    if (!open) return;
    if (activeTab === 'tracks') {
      fetchTracks();
    } else {
      fetchDiagnostics();
    }
  }, [open, activeTab, fetchTracks, fetchDiagnostics]);

  // Poll every 1500ms while census job is running
  const isRunning = Boolean(statusData?.runtime?.running);
  const probedCount = statusData?.summary?.probed_tracks ?? 0;
  const totalCount = statusData?.summary?.total_tracks ?? 0;

  useEffect(() => {
    if (!open || !isRunning) return;
    const timer = window.setInterval(() => {
      fetchStatus().then((next) => {
        if (!next) return;
        if (!next.runtime.running || next.summary.probed_tracks !== probedCount || next.summary.total_tracks !== totalCount) {
          if (activeTab === 'tracks') {
            fetchTracks();
          } else {
            fetchDiagnostics();
          }
        }
      });
    }, 1500);
    return () => window.clearInterval(timer);
  }, [open, isRunning, probedCount, totalCount, activeTab, fetchStatus, fetchTracks, fetchDiagnostics]);

  // Capture Escape key so it unwinds nested FolderChooserModal first, then closes LiberationModal
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (chooserTarget !== null) {
          setChooserTarget(null);
        } else {
          onClose();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, chooserTarget, onClose]);

  if (!open) return null;

  const startCensus = async (forceReingest: boolean, samplePerBucket?: number) => {
    setActionBusy(true);
    setConfirmReset(false);
    setErrorMsg(null);
    try {
      const payload: { force_reingest: boolean; sample_per_bucket?: number } = {
        force_reingest: forceReingest,
      };
      if (samplePerBucket && samplePerBucket > 0) {
        payload.sample_per_bucket = samplePerBucket;
      }
      const resp = await fetch(resolveDaemonUrl('/api/liberation/census/start'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setStatusData(json.data as LiberationStatusResponse);
        if (showToast) {
          showToast(
            samplePerBucket
              ? 'Started Project LIBERATION Quick Sample (Purchased / Uploaded / Matched)'
              : forceReingest
              ? 'Started Project LIBERATION full re-index & census'
              : 'Started Project LIBERATION read-only census'
          );
        }
      } else {
        setErrorMsg(json?.error || 'Failed to start census');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to start census');
    } finally {
      setActionBusy(false);
    }
  };

  const pauseCensus = async () => {
    setActionBusy(true);
    setErrorMsg(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/census/pause'), {
        method: 'POST',
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setStatusData(json.data as LiberationStatusResponse);
      } else if (json?.error) {
        setErrorMsg(json.error);
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to pause census');
    } finally {
      setActionBusy(false);
    }
  };

  const resetCensus = async () => {
    if (!confirmReset) {
      setConfirmReset(true);
      if (showToast) {
        showToast('Click [Confirm Reset] again to clear cached census rows');
      }
      return;
    }
    setConfirmReset(false);
    setActionBusy(true);
    setErrorMsg(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/liberation/census/reset'), {
        method: 'POST',
      });
      const json = await resp.json();
      if (json?.ok && json?.data) {
        setStatusData(json.data as LiberationStatusResponse);
        setTracks([]);
        setTracksTotal(0);
        setDiagnostics(null);
        setPageOffset(0);
      } else {
        setErrorMsg(json?.error || 'Failed to reset census');
      }
    } catch (err: any) {
      setErrorMsg(err?.message || 'Failed to reset census');
    } finally {
      setActionBusy(false);
    }
  };

  const runtime = statusData?.runtime;
  const summary = statusData?.summary;
  const totalIndexed = summary?.total_tracks ?? 0;
  const probed = summary?.probed_tracks ?? 0;
  const progressPct = totalIndexed > 0 ? Math.min(100, Math.round((probed / totalIndexed) * 100)) : 0;
  const hasResumePending =
    totalIndexed > 0 && ((summary?.pending_tracks ?? 0) > 0 || (summary?.error_tracks ?? 0) > 0);
  const canStart = !isRunning && !actionBusy;

  const totalPages = Math.max(1, Math.ceil(tracksTotal / PAGE_LIMIT));
  const currentPage = Math.floor(pageOffset / PAGE_LIMIT) + 1;

  return (
    <div
      data-modal-root="true"
      data-liberation-modal="true"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 70,
        background: 'rgba(4, 6, 12, 0.84)',
        backdropFilter: 'blur(12px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 18,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(1040px, 96vw)',
          height: 'min(760px, 90vh)',
          borderRadius: 16,
          background: 'linear-gradient(180deg, rgba(16, 19, 30, 0.99), rgba(9, 11, 18, 0.99))',
          border: '1px solid rgba(251, 113, 133, 0.4)',
          boxShadow: '0 24px 70px rgba(0, 0, 0, 0.8), 0 0 32px rgba(244, 63, 94, 0.14)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          color: '#f1f5f9',
        }}
      >
        {/* Modal Header */}
        <div
          style={{
            padding: '13px 18px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 9,
                background: 'rgba(244, 63, 94, 0.16)',
                border: '1px solid rgba(251, 113, 133, 0.45)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: '#fda4af',
              }}
            >
              <ImpIcon name="apple" size={17} color="#fda4af" />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 15, fontWeight: 800 }}>
                  Project LIBERATION — Apple Cloud Library Rescue Suite
                </span>
                <span
                  style={{
                    fontSize: 10,
                    fontWeight: 800,
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'rgba(16, 185, 129, 0.14)',
                    border: '1px solid rgba(52, 211, 153, 0.4)',
                    color: '#34d399',
                  }}
                >
                  Strict DRM-Free Rescue Suite
                </span>
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                Audits &amp; reclaims unencrypted Cloud Locker assets, 4-stage verifies local folders, and reunites fragmented albums.
              </div>
            </div>
          </div>

          <button
            type="button"
            data-focusable="true"
            onClick={onClose}
            style={{
              padding: '6px 12px',
              borderRadius: 8,
              border: '1px solid rgba(255,255,255,0.14)',
              background: 'rgba(255,255,255,0.06)',
              color: '#e2e8f0',
              fontSize: 12,
              fontWeight: 700,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <ImpIcon name="close" size={13} />
            Close
          </button>
        </div>

        {/* Navigation Tabs */}
        <div
          style={{
            padding: '8px 18px',
            borderBottom: '1px solid rgba(255,255,255,0.08)',
            background: 'rgba(10, 12, 20, 0.8)',
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
          }}
        >
          <button
            type="button"
            data-focusable="true"
            onClick={() => setActiveTab('tracks')}
            style={tabBtnStyle(activeTab === 'tracks')}
          >
            Stage 1: Census ({tracksTotal.toLocaleString()})
          </button>
          <button
            type="button"
            data-focusable="true"
            onClick={() => setActiveTab('diagnostics')}
            style={tabBtnStyle(activeTab === 'diagnostics')}
          >
            Fragmentation Preview
            {diagnostics ? ` (${diagnostics.incomplete_album_count})` : ''}
          </button>
          <button
            type="button"
            data-focusable="true"
            onClick={() => setActiveTab('download')}
            style={tabBtnStyle(activeTab === 'download')}
          >
            Stage 2A: Reclaim Uploaded
          </button>
          <button
            type="button"
            data-focusable="true"
            onClick={() => setActiveTab('audit')}
            style={tabBtnStyle(activeTab === 'audit')}
          >
            Stage 2B: Verify Folder
          </button>
          <button
            type="button"
            data-focusable="true"
            onClick={() => setActiveTab('reunion')}
            style={tabBtnStyle(activeTab === 'reunion')}
          >
            Stage 3: Reunion &amp; Acoustic Mend
          </button>
        </div>

        {/* Stage 1 Census Action Controls + KPI Telemetry */}
        {(activeTab === 'tracks' || activeTab === 'diagnostics') && (
          <>
            <div
              style={{
                padding: '10px 18px',
                borderBottom: '1px solid rgba(255,255,255,0.07)',
                background: 'rgba(10, 12, 20, 0.72)',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="button"
                data-focusable="true"
                disabled={!canStart}
                onClick={() => startCensus(false)}
                style={{
                  padding: '7px 13px',
                  borderRadius: 8,
                  border: '1px solid rgba(52, 211, 153, 0.5)',
                  background: canStart ? 'rgba(16, 185, 129, 0.2)' : 'rgba(255,255,255,0.04)',
                  color: canStart ? '#6ee7b7' : '#64748b',
                  fontSize: 12,
                  fontWeight: 800,
                  cursor: canStart ? 'pointer' : 'not-allowed',
                }}
              >
                {isRunning
                  ? 'Census Running...'
                  : hasResumePending
                  ? 'Resume Census'
                  : 'Start Census'}
              </button>

              <button
                type="button"
                data-focusable="true"
                disabled={!canStart}
                onClick={() => startCensus(false, 20)}
                style={{
                  padding: '7px 11px',
                  borderRadius: 8,
                  border: '1px solid rgba(192, 132, 252, 0.45)',
                  background: canStart ? 'rgba(168, 85, 247, 0.16)' : 'rgba(255,255,255,0.04)',
                  color: canStart ? '#e9d5ff' : '#64748b',
                  fontSize: 11.5,
                  fontWeight: 800,
                  cursor: canStart ? 'pointer' : 'not-allowed',
                }}
              >
                Quick Sample (60 tracks)
              </button>

              <button
                type="button"
                data-focusable="true"
                disabled={!canStart}
                onClick={() => startCensus(true)}
                style={{
                  padding: '7px 11px',
                  borderRadius: 8,
                  border: '1px solid rgba(56, 189, 248, 0.42)',
                  background: canStart ? 'rgba(14, 165, 233, 0.14)' : 'rgba(255,255,255,0.04)',
                  color: canStart ? '#7dd3fc' : '#64748b',
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: canStart ? 'pointer' : 'not-allowed',
                }}
              >
                <ImpIcon name="refresh" size={12} style={{ marginRight: 5 }} />
                Re-Index Library
              </button>

              <button
                type="button"
                data-focusable="true"
                disabled={!isRunning || actionBusy}
                onClick={pauseCensus}
                style={{
                  padding: '7px 11px',
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

              <button
                type="button"
                data-focusable="true"
                disabled={actionBusy || (totalIndexed === 0 && !isRunning)}
                onClick={resetCensus}
                style={{
                  padding: '7px 11px',
                  borderRadius: 8,
                  border: '1px solid rgba(248, 113, 113, 0.4)',
                  background: confirmReset ? 'rgba(220, 38, 38, 0.28)' : 'rgba(239, 68, 68, 0.1)',
                  color: totalIndexed === 0 && !isRunning ? '#64748b' : '#fca5a5',
                  fontSize: 11.5,
                  fontWeight: 700,
                  cursor: totalIndexed === 0 && !isRunning ? 'not-allowed' : 'pointer',
                }}
              >
                {confirmReset ? 'Confirm Reset' : 'Reset'}
              </button>
            </div>

            <div style={{ fontSize: 11, color: '#cbd5e1', fontWeight: 700 }}>
              Phase: <span style={{ color: '#fda4af' }}>{runtime?.phase ?? 'idle'}</span> ·{' '}
              {probed.toLocaleString()} / {totalIndexed.toLocaleString()} probed ({progressPct}%)
            </div>
          </div>

          {/* Progress Bar */}
          <div
            style={{
              height: 6,
              borderRadius: 999,
              background: 'rgba(255,255,255,0.08)',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: `${progressPct}%`,
                height: '100%',
                borderRadius: 999,
                background: 'linear-gradient(90deg, #fb7185, #34d399)',
                transition: 'width 250ms ease',
              }}
            />
          </div>

          <div style={{ fontSize: 11, color: '#94a3b8' }}>
            {runtime?.last_message || 'Ready to run Stage 1 Read-Only Census.'}
          </div>

          {runtime?.auth_expired && (
            <div
              style={{
                padding: '7px 10px',
                borderRadius: 8,
                background: 'rgba(245, 158, 11, 0.14)',
                border: '1px solid rgba(251, 191, 36, 0.45)',
                color: '#fde68a',
                fontSize: 11.5,
                fontWeight: 700,
              }}
            >
              Apple Music session expired — reconnect in Settings → Apple Music and click Resume Census (progress saved).
            </div>
          )}

          {errorMsg && (
            <div
              style={{
                padding: '7px 10px',
                borderRadius: 8,
                background: 'rgba(239, 68, 68, 0.14)',
                border: '1px solid rgba(248, 113, 113, 0.45)',
                color: '#fecaca',
                fontSize: 11.5,
              }}
            >
              {errorMsg}
            </div>
          )}
        </div>

        {/* KPI Cards + Empirical Flavors Telemetry */}
        <div
          style={{
            padding: '10px 18px',
            borderBottom: '1px solid rgba(255,255,255,0.07)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
              gap: 8,
            }}
          >
            {[
              {
                label: 'Indexed Tracks',
                val: (summary?.total_tracks ?? 0).toLocaleString(),
                color: '#e2e8f0',
              },
              {
                label: 'Reclaimable Direct',
                val: (summary?.reclaimable_direct ?? 0).toLocaleString(),
                color: '#34d399',
              },
              {
                label: 'Clear HLS fMP4',
                val: (summary?.reclaimable_clear_hls ?? 0).toLocaleString(),
                color: '#38bdf8',
              },
              {
                label: 'Subscription DRM (Excl)',
                val: (summary?.subscription_drm_excluded ?? 0).toLocaleString(),
                color: '#fb923c',
              },
              {
                label: 'Est. Reclaimable Size',
                val: formatBytesHuman(summary?.estimated_reclaimable_bytes ?? 0),
                color: '#f472b6',
              },
            ].map((kpi) => (
              <div
                key={kpi.label}
                style={{
                  padding: '7px 10px',
                  borderRadius: 9,
                  background: 'rgba(255,255,255,0.03)',
                  border: '1px solid rgba(255,255,255,0.08)',
                }}
              >
                <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 700 }}>{kpi.label}</div>
                <div style={{ fontSize: 15, fontWeight: 800, color: kpi.color, marginTop: 2 }}>
                  {kpi.val}
                </div>
              </div>
            ))}
          </div>

          {/* Origins + Observed Flavors */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 10.5 }}>
              <span style={{ color: '#94a3b8', fontWeight: 700 }}>Origins:</span>
              <span style={chipStyle('#a7f3d0')}>Purchased {summary?.origin_purchased ?? 0}</span>
              <span style={chipStyle('#7dd3fc')}>Matched {summary?.origin_matched ?? 0}</span>
              <span style={chipStyle('#c4b5fd')}>Uploaded {summary?.origin_uploaded ?? 0}</span>
              <span style={chipStyle('#fdba74')}>Subscription {summary?.origin_subscription ?? 0}</span>
              {(summary?.origin_unknown ?? 0) > 0 && (
                <span style={chipStyle('#cbd5e1')}>Unprobed/Other {summary?.origin_unknown}</span>
              )}
            </div>

            {summary && summary.observed_flavors.length > 0 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', fontSize: 10.5 }}>
                <span style={{ color: '#94a3b8', fontWeight: 700 }}>Observed Apple Flavors:</span>
                {summary.observed_flavors.slice(0, 8).map((f) => (
                  <span key={f.flavor} style={chipStyle('#fda4af')}>
                    {f.flavor} × {f.count.toLocaleString()}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
          </>
        )}

        {/* Main Scrollable Content */}
        {activeTab === 'tracks' ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 18px', gap: 8 }}>
            {/* Filter Controls */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {(
                  [
                    ['all', 'All'],
                    ['reclaimable_direct', 'Direct'],
                    ['reclaimable_clear_hls', 'Clear HLS'],
                    ['subscription_drm_excluded', 'Sub DRM'],
                    ['pending', 'Pending'],
                    ['unavailable', 'Unavail'],
                    ['error', 'Error'],
                  ] as [OwnershipFilter, string][]
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    data-focusable="true"
                    onClick={() => {
                      setOwnershipFilter(val);
                      setPageOffset(0);
                    }}
                    style={filterPillStyle(ownershipFilter === val, '#34d399')}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {(
                  [
                    ['all', 'All Origins'],
                    ['purchased', 'Purchased'],
                    ['matched', 'Matched'],
                    ['uploaded', 'Uploaded'],
                    ['subscription', 'Sub'],
                  ] as [OriginFilter, string][]
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    data-focusable="true"
                    onClick={() => {
                      setOriginFilter(val);
                      setPageOffset(0);
                    }}
                    style={filterPillStyle(originFilter === val, '#38bdf8')}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {(
                  [
                    ['corrupt_failed', 'Failed / Corrupt'],
                    ['verified_ok', 'Verified OK'],
                  ] as [Exclude<VerificationFilter, 'all'>, string][]
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    data-focusable="true"
                    onClick={() => {
                      setVerificationFilter((cur) => (cur === val ? 'all' : val));
                      setPageOffset(0);
                    }}
                    style={filterPillStyle(
                      verificationFilter === val,
                      val === 'corrupt_failed' ? '#f87171' : '#34d399'
                    )}
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
                  placeholder="Filter title, artist, album..."
                  style={{
                    padding: '4px 8px',
                    borderRadius: 6,
                    border: '1px solid rgba(255,255,255,0.14)',
                    background: 'rgba(0,0,0,0.45)',
                    color: '#e2e8f0',
                    fontSize: 11,
                    width: 190,
                  }}
                />
                <button
                  type="submit"
                  data-focusable="true"
                  style={filterPillStyle(false, '#e2e8f0')}
                >
                  Filter
                </button>
              </form>
            </div>

            {/* Track Table */}
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
              {tracksLoading && tracks.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
                  Loading census records...
                </div>
              ) : tracks.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
                  {totalIndexed === 0
                    ? 'Click [Start Census] to scan your Apple Cloud Library (read-only).'
                    : 'No tracks match the active filters.'}
                </div>
              ) : (
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#94a3b8', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(255,255,255,0.02)' }}>
                      <th style={{ padding: '7px 10px' }}>Track</th>
                      <th style={{ padding: '7px 10px' }}>Artist / Album</th>
                      <th style={{ padding: '7px 8px' }}># / Dur</th>
                      <th style={{ padding: '7px 8px' }}>Origin</th>
                      <th style={{ padding: '7px 8px' }}>Ownership</th>
                      <th style={{ padding: '7px 10px' }}>Flavor / Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tracks.map((t) => {
                      const badge = ownershipMeta(t.ownership_class);
                      return (
                        <tr
                          key={t.library_song_id}
                          style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}
                        >
                          <td style={{ padding: '6px 10px', maxWidth: 230 }}>
                            <div style={{ fontWeight: 700, color: '#f1f5f9', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {t.title}
                            </div>
                            <div style={{ fontSize: 9.5, color: '#64748b', fontFamily: 'monospace' }}>
                              {t.library_song_id}
                            </div>
                          </td>
                          <td style={{ padding: '6px 10px', maxWidth: 240 }}>
                            <div style={{ color: '#cbd5e1', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {t.artist}
                            </div>
                            <div style={{ fontSize: 10, color: '#94a3b8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {t.album}
                            </div>
                            {(t.artist || t.album) &&
                              t.ownership_class !== 'subscription_drm_excluded' &&
                              t.ownership_class !== 'unavailable' && (
                              <div style={{ display: 'flex', gap: 5, marginTop: 3, flexWrap: 'wrap' }}>
                                {t.album && (
                                  <button
                                    type="button"
                                    data-focusable="true"
                                    onClick={() =>
                                      jumpToTargetedReclaim({ artist: t.artist, album: t.album })
                                    }
                                    style={{
                                      padding: '1px 6px',
                                      borderRadius: 5,
                                      border: '1px solid rgba(52, 211, 153, 0.35)',
                                      background: 'rgba(16, 185, 129, 0.1)',
                                      color: '#6ee7b7',
                                      fontSize: 9.5,
                                      fontWeight: 700,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Reclaim Album
                                  </button>
                                )}
                                {t.artist && (
                                  <button
                                    type="button"
                                    data-focusable="true"
                                    onClick={() => jumpToTargetedReclaim({ artist: t.artist })}
                                    style={{
                                      padding: '1px 6px',
                                      borderRadius: 5,
                                      border: '1px solid rgba(56, 189, 248, 0.32)',
                                      background: 'rgba(14, 165, 233, 0.1)',
                                      color: '#7dd3fc',
                                      fontSize: 9.5,
                                      fontWeight: 700,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    Reclaim Artist
                                  </button>
                                )}
                              </div>
                            )}
                          </td>
                          <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', color: '#94a3b8', fontFamily: 'monospace' }}>
                            {t.track_number ?? '-'}/{t.album_track_count ?? '-'} · {formatDurationMs(t.duration_ms)}
                          </td>
                          <td style={{ padding: '6px 8px', whiteSpace: 'nowrap', color: '#cbd5e1' }}>
                            {originLabel(t.cloud_origin_hint)}
                          </td>
                          <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                            <span
                              style={{
                                fontSize: 10,
                                fontWeight: 800,
                                padding: '2px 7px',
                                borderRadius: 6,
                                color: badge.color,
                                background: badge.bg,
                                border: `1px solid ${badge.border}`,
                              }}
                            >
                              {badge.label}
                            </span>
                          </td>
                          <td style={{ padding: '6px 10px', maxWidth: 210, fontSize: 10, color: '#94a3b8' }}>
                            <div style={{ color: '#e2e8f0', fontFamily: 'monospace' }}>
                              {t.asset_flavor || '-'}
                              {t.content_length_bytes
                                ? ` (${formatBytesHuman(t.content_length_bytes)})`
                                : ''}
                            </div>
                            {t.last_error && (
                              <div style={{ color: '#fda4af', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.last_error}>
                                {t.last_error}
                              </div>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pagination Footer */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 11, color: '#94a3b8' }}>
              <span>
                Showing {tracksTotal === 0 ? 0 : pageOffset + 1}–{Math.min(pageOffset + tracks.length, tracksTotal)} of{' '}
                {tracksTotal.toLocaleString()} tracks
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  type="button"
                  data-focusable="true"
                  disabled={pageOffset === 0}
                  onClick={() => setPageOffset((p) => Math.max(0, p - PAGE_LIMIT))}
                  style={filterPillStyle(false, '#e2e8f0')}
                >
                  Prev
                </button>
                <span>
                  Page {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  data-focusable="true"
                  disabled={pageOffset + PAGE_LIMIT >= tracksTotal}
                  onClick={() => setPageOffset((p) => p + PAGE_LIMIT)}
                  style={filterPillStyle(false, '#e2e8f0')}
                >
                  Next
                </button>
              </div>
            </div>
          </div>
        ) : activeTab === 'diagnostics' ? (
          /* Album Fragmentation Preview Tab */
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: '10px 18px', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11 }}>
                <span style={chipStyle('#e2e8f0')}>
                  Albums Analyzed: {diagnostics?.total_albums_analyzed ?? 0}
                </span>
                <span style={chipStyle('#fbbf24')}>
                  Incomplete Albums: {diagnostics?.incomplete_album_count ?? 0}
                </span>
                <span style={chipStyle('#fb7185')}>
                  Missing Track Slots: {diagnostics?.total_missing_slots ?? 0}
                </span>
                <span style={chipStyle('#34d399')}>
                  Stray Single Candidates: {diagnostics?.stray_single_candidate_count ?? 0}
                </span>
              </div>
              <button
                type="button"
                data-focusable="true"
                onClick={fetchDiagnostics}
                style={filterPillStyle(false, '#7dd3fc')}
              >
                <ImpIcon name="refresh" size={11} style={{ marginRight: 4 }} />
                Refresh Diagnostics
              </button>
            </div>

            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              {diagLoading && !diagnostics ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
                  Analyzing album fragmentation...
                </div>
              ) : !diagnostics || diagnostics.incomplete_albums.length === 0 ? (
                <div style={{ padding: 24, textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>
                  {totalIndexed === 0
                    ? 'Run Stage 1 Census first to detect incomplete albums and stray singles.'
                    : 'No incomplete albums or stray singles detected.'}
                </div>
              ) : (
                diagnostics.incomplete_albums.map((alb) => (
                  <div
                    key={`${alb.artist}::${alb.normalized_album}`}
                    style={{
                      padding: '10px 12px',
                      borderRadius: 10,
                      background: 'rgba(13, 16, 26, 0.85)',
                      border: '1px solid rgba(255,255,255,0.09)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <div>
                        <span style={{ fontSize: 12.5, fontWeight: 800, color: '#f1f5f9' }}>
                          {alb.artist} — {alb.album}
                        </span>
                        <span style={{ fontSize: 11, color: '#fbbf24', marginLeft: 8, fontWeight: 700 }}>
                          {alb.owned_or_library_tracks} / {alb.expected_track_count} tracks
                        </span>
                      </div>
                      <div style={{ display: 'flex', gap: 6, fontSize: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                        <span style={chipStyle(alb.reclaimable_count > 0 ? '#34d399' : '#64748b')}>
                          Reclaimable {alb.reclaimable_count}
                        </span>
                        <span style={chipStyle('#fb923c')}>Sub DRM {alb.subscription_count}</span>
                        {alb.missing_track_numbers.length > 0 && (
                          <span style={chipStyle('#fda4af')}>
                            Missing #{alb.missing_track_numbers.join(', #')}
                          </span>
                        )}
                        {alb.reclaimable_count > 0 && (
                          <button
                            type="button"
                            data-focusable="true"
                            onClick={() =>
                              jumpToTargetedReclaim({ artist: alb.artist, album: alb.album })
                            }
                            style={{
                              padding: '2px 7px',
                              borderRadius: 6,
                              border: '1px solid rgba(52, 211, 153, 0.45)',
                              background: 'rgba(16, 185, 129, 0.15)',
                              color: '#6ee7b7',
                              fontSize: 10,
                              fontWeight: 800,
                              cursor: 'pointer',
                            }}
                          >
                            Reclaim Album
                          </button>
                        )}
                        {(alb.reclaimable_count > 0 ||
                          alb.stray_candidates.some(
                            (s) =>
                              s.ownership_class === 'reclaimable_direct' ||
                              s.ownership_class === 'reclaimable_clear_hls'
                          )) && (
                          <button
                            type="button"
                            data-focusable="true"
                            onClick={() => jumpToTargetedReclaim({ artist: alb.artist })}
                            style={{
                              padding: '2px 7px',
                              borderRadius: 6,
                              border: '1px solid rgba(56, 189, 248, 0.42)',
                              background: 'rgba(14, 165, 233, 0.14)',
                              color: '#7dd3fc',
                              fontSize: 10,
                              fontWeight: 800,
                              cursor: 'pointer',
                            }}
                          >
                            Reclaim Artist
                          </button>
                        )}
                      </div>
                    </div>

                    {alb.stray_candidates.length > 0 && (
                      <div style={{ paddingLeft: 10, borderLeft: '2px solid rgba(52, 211, 153, 0.45)', display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ fontSize: 10, fontWeight: 800, color: '#6ee7b7' }}>
                          Stray Single / EP Candidates ({alb.stray_candidates.length}):
                        </div>
                        {alb.stray_candidates.map((s) => (
                          <div key={s.library_song_id} style={{ fontSize: 10.5, color: '#cbd5e1', display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                            <span>
                              <strong>{s.title}</strong> · <span style={{ color: '#94a3b8' }}>{s.current_album}</span>
                            </span>
                            <span style={{ color: '#94a3b8', fontSize: 10 }}>
                              {ownershipMeta(s.ownership_class).label} · {s.reason}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          </div>
        ) : activeTab === 'download' ? (
          <LiberationDownloadTab
            open={open && activeTab === 'download'}
            destDir={rescueFolder}
            setDestDir={updateRescueFolder}
            onBrowseDest={() => setChooserTarget('download')}
            filter={downloadFilter}
            setFilter={setDownloadFilter}
            onInspectFailed={() => {
              setOwnershipFilter('all');
              setOriginFilter('all');
              setVerificationFilter('corrupt_failed');
              setPageOffset(0);
              setActiveTab('tracks');
            }}
            showToast={showToast}
          />
        ) : activeTab === 'audit' ? (
          <LiberationAuditTab
            open={open && activeTab === 'audit'}
            rootDir={rescueFolder}
            setRootDir={updateRescueFolder}
            onBrowseRoot={() => setChooserTarget('audit')}
          />
        ) : (
          <LiberationReunionTab
            open={open && activeTab === 'reunion'}
            rootDir={rescueFolder}
            setRootDir={updateRescueFolder}
            onBrowseRoot={() => setChooserTarget('reunion')}
            showToast={showToast}
          />
        )}
      </div>

      <FolderChooserModal
        open={chooserTarget !== null}
        initialPath={rescueFolder}
        onSelectFolder={(folderPath) => {
          updateRescueFolder(folderPath);
          setChooserTarget(null);
        }}
        onClose={() => setChooserTarget(null)}
      />
    </div>
  );
};
