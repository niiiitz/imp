import React, { useEffect, useRef, useState } from 'react';
import { SimpStateSnapshot, TrackMetadata } from '@simp/client';
import {
  FypShelfDescriptor,
  FypShelfRecord,
  LocalDiscoverResponse,
  LocalSmartStation,
  queueFypRevalidation,
  useFypShelves,
} from '../../../api/servicesCacheApi';
import { ImpIcon } from '../../../components/icons/ImpIcon';
import { AppleMusicLogo } from '../../../components/AppleMusicLogo';
import { SoundCloudLogo } from '../../../components/SoundCloudLogo';
import { SourceVisibilityPrefs } from '../../SettingsModal';
import type { LibraryContextTarget } from '../../LibraryBrowserView';
import { CollapsibleSectionHeader, FilterTriggerButton } from '../PinnableSectionHeader';

export interface ImpFypPaneProps {
  browserSourceFilter: 'all' | 'local' | 'apple_music' | 'soundcloud' | 'internet_archive';
  selectedSources: Array<'local' | 'apple_music' | 'soundcloud' | 'internet_archive'>;
  sourceVisibility: SourceVisibilityPrefs;
  mediaTypeFilter?: 'all' | 'video' | 'audio';
  onOpenFilters?: () => void;
  snap: SimpStateSnapshot | null;
  localDiscover: LocalDiscoverResponse;
  tileGridStyle: React.CSSProperties;
  renderSingleSongRow: (
    s: TrackMetadata,
    peerList: TrackMetadata[],
    ctxPrefix: string,
    compact?: boolean
  ) => React.ReactNode;
  renderSimpAlbumCard: (alb: any) => React.ReactNode;
  renderSimpPlaylistCard: (pl: any) => React.ReactNode;
  renderCloudAlbumCard: (alb: any) => React.ReactNode;
  renderCloudPlaylistCard: (pl: any) => React.ReactNode;
  renderStationCard: (st: any) => React.ReactNode;
  renderAppleArtistCard: (artist: any) => React.ReactNode;
  renderSoundCloudPlaylistCard: (pl: any) => React.ReactNode;
  renderSoundCloudUserCard: (u: any) => React.ReactNode;
  renderArchiveItemCard: (item: any) => React.ReactNode;
  renderLocalArtistCard: (name: string) => React.ReactNode;
  onPlayLocalSmartStation: (st: LocalSmartStation, shuffle?: boolean) => void;
  openLibraryContextMenu?: (target: LibraryContextTarget) => void;
}

function parseDescriptor(rec: FypShelfRecord): FypShelfDescriptor | null {
  try {
    return JSON.parse(rec.descriptor_json) as FypShelfDescriptor;
  } catch {
    return null;
  }
}

export const ImpFypPane: React.FC<ImpFypPaneProps> = ({
  browserSourceFilter,
  selectedSources,
  sourceVisibility,
  mediaTypeFilter = 'all',
  onOpenFilters,
  snap,
  localDiscover,
  tileGridStyle,
  renderSingleSongRow,
  renderSimpAlbumCard,
  renderSimpPlaylistCard,
  renderCloudAlbumCard,
  renderCloudPlaylistCard,
  renderStationCard,
  renderAppleArtistCard,
  renderSoundCloudPlaylistCard,
  renderSoundCloudUserCard,
  renderArchiveItemCard,
  renderLocalArtistCard,
  onPlayLocalSmartStation,
  openLibraryContextMenu,
}) => {
  const {
    shelves,
    snapshots,
    loaded,
    revalidatingKeys,
    saveAllShelves,
    unpinShelf,
    restoreDefaultShelves,
  } = useFypShelves();
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [expandedTrackShelves, setExpandedTrackShelves] = useState<Record<string, boolean>>({});
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [gridCols, setGridCols] = useState<number>(3);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateCols = (w: number) => {
      const next = w >= 620 ? 3 : w >= 400 ? 2 : 1;
      setGridCols((prev) => (prev === next ? prev : next));
    };
    updateCols(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) updateCols(e.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Viewport-Lazy Stale-While-Revalidate via IntersectionObserver
  const descriptorsByElRef = useRef<Map<Element, FypShelfDescriptor>>(new Map());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const snapAuthRef = useRef(snap?.apple_authenticated);
  snapAuthRef.current = snap?.apple_authenticated;
  const snapshotsRef = useRef(snapshots);
  snapshotsRef.current = snapshots;

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const desc = descriptorsByElRef.current.get(entry.target);
          if (!desc) continue;
          if (desc.provider === 'apple_music' && !snapAuthRef.current) continue;
          const existing = snapshotsRef.current[desc.cacheKey];
          const nowSec = Math.floor(Date.now() / 1000);
          if (!existing || nowSec - existing.fetchedAt > Math.max(1, desc.ttlSec)) {
            queueFypRevalidation(desc);
          }
        }
      },
      { rootMargin: '240px' }
    );
    observerRef.current = obs;
    for (const el of descriptorsByElRef.current.keys()) {
      obs.observe(el);
    }
    return () => {
      obs.disconnect();
      observerRef.current = null;
    };
  }, []);

  const registerShelfElement = (
    el: HTMLElement | null,
    descriptor: FypShelfDescriptor | null
  ) => {
    const prevKeys = descriptorsByElRef.current;
    if (el && descriptor) {
      const existed = prevKeys.has(el);
      prevKeys.set(el, descriptor);
      if (!existed && observerRef.current) {
        observerRef.current.observe(el);
      }
      // Also eagerly enqueue initial missing snapshot if visible above fold
      if (!snapshots[descriptor.cacheKey]) {
        if (descriptor.provider !== 'apple_music' || snap?.apple_authenticated) {
          queueFypRevalidation(descriptor);
        }
      }
    }
  };

  const isProviderVisible = (provider: string): boolean => {
    if (provider === 'apple_music' && !sourceVisibility.apple_music) return false;
    if (provider === 'soundcloud' && !sourceVisibility.soundcloud) return false;
    if (provider === 'internet_archive' && !sourceVisibility.internet_archive) return false;
    if (selectedSources.length > 0) {
      return selectedSources.includes(provider as any);
    }
    return browserSourceFilter === 'all' || browserSourceFilter === provider;
  };

  const visibleShelves = shelves.filter(
    (s) => s.enabled && isProviderVisible(s.provider)
  );

  const resolveShelfItems = (descriptor: FypShelfDescriptor): unknown[] => {
    const cached = snapshots[descriptor.cacheKey];
    if (cached && Array.isArray(cached.items) && cached.items.length > 0) {
      return cached.items;
    }
    if (descriptor.fetchSpec.kind === 'local_discover') {
      if (descriptor.fetchSpec.section === 'smart_stations') {
        return localDiscover.smart_stations;
      }
      if (descriptor.fetchSpec.section === 'rediscover_albums') {
        return localDiscover.rediscover_albums;
      }
      return localDiscover.recent_albums;
    }
    return cached?.items || [];
  };

  const renderProviderMark = (provider: string) => {
    if (provider === 'apple_music') return <AppleMusicLogo size={13} />;
    if (provider === 'soundcloud') return <SoundCloudLogo width={20} color="#fdba74" />;
    if (provider === 'internet_archive') {
      return <ImpIcon name="archive" size={13} color="#fde047" />;
    }
    return <ImpIcon name="local" size={13} color="#34d399" />;
  };

  const renderLocalSmartStationCard = (st: LocalSmartStation, shelfUid: string) => {
    const firstTrack = st.tracks[0];
    return (
      <div
        key={st.id}
        data-right-tile="true"
        data-tile-key={`fyp:${shelfUid}:station:${st.id}`}
        role="button"
        tabIndex={0}
        onContextMenu={(e) => {
          if (!openLibraryContextMenu) return;
          e.preventDefault();
          openLibraryContextMenu({
            type: 'collection',
            kind: 'local_station',
            id: st.id,
            title: st.title,
            subtitle: `${st.track_count} tracks • ${st.subtitle}`,
            art_url: st.art_url,
            source: 'local',
            rawItem: st,
          });
        }}
        onClick={() => onPlayLocalSmartStation(st, false)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onPlayLocalSmartStation(st, false);
          }
        }}
        style={{
          position: 'relative',
          borderRadius: 14,
          background: 'linear-gradient(155deg, #0d1d1c 0%, #090d14 100%)',
          border: '1px solid #1e3a38',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          cursor: 'pointer',
          minWidth: 0,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {st.art_url ? (
            <img
              src={st.art_url}
              alt=""
              loading="lazy"
              style={{
                width: 52,
                height: 52,
                borderRadius: 10,
                objectFit: 'cover',
                border: '1px solid #2dd4bf',
                flexShrink: 0,
              }}
            />
          ) : (
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: 10,
                background: '#112927',
                border: '1px solid #2dd4bf',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <ImpIcon
                name={
                  st.station_kind === 'karaoke'
                    ? 'mic'
                    : st.station_kind === 'lossless'
                      ? 'disc'
                      : 'radio'
                }
                size={22}
                color="#5eead4"
              />
            </div>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: '#ecfeff',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {st.title}
            </div>
            <div
              style={{
                fontSize: 11,
                color: '#94a3b8',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                marginTop: 2,
              }}
            >
              {st.subtitle}
            </div>
            <div
              style={{
                fontSize: 10,
                fontFamily: 'monospace',
                color: '#5eead4',
                marginTop: 3,
              }}
            >
              {st.track_count} tracks
              {firstTrack ? ` • ${firstTrack.title}` : ''}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            type="button"
            data-row-aux="true"
            onClick={(e) => {
              e.stopPropagation();
              onPlayLocalSmartStation(st, false);
            }}
            style={{
              flex: 1,
              minHeight: 30,
              borderRadius: 8,
              background: '#0f2926',
              border: '1px solid #14b8a6',
              color: '#ccfbf1',
              fontSize: 11,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            ▶ Play Station
          </button>
          <button
            type="button"
            data-row-aux="true"
            onClick={(e) => {
              e.stopPropagation();
              onPlayLocalSmartStation(st, true);
            }}
            title="Shuffle Smart Station"
            style={{
              minHeight: 30,
              padding: '0 10px',
              borderRadius: 8,
              background: '#111622',
              border: '1px solid #263145',
              color: '#cbd5e1',
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            🔀
          </button>
        </div>
      </div>
    );
  };

  const renderShelfBody = (descriptor: FypShelfDescriptor, items: unknown[]) => {
    if (items.length === 0) {
      const unauthApple = descriptor.provider === 'apple_music' && !snap?.apple_authenticated;
      const isLoading = revalidatingKeys.includes(descriptor.cacheKey);
      return (
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 10,
            background: '#0a0b10',
            border: '1px solid #181a24',
            color: '#8e8e99',
            fontSize: 11.5,
          }}
        >
          {unauthApple
            ? 'Sign in to Apple Music in Settings → Folders & Accounts to hydrate this shelf.'
            : isLoading
              ? '⏳ Refreshing shelf items...'
              : descriptor.provider === 'local'
                ? 'Index local music folders in Settings to populate this Local discovery shelf.'
                : 'No items cached yet — click Refresh Stale to load.'}
        </div>
      );
    }

    switch (descriptor.itemKind) {
      case 'tracks': {
        const tracks = items as TrackMetadata[];
        const pageCap = 3 * gridCols;
        const expanded = Boolean(expandedTrackShelves[descriptor.shelfUid]);
        const hasOverflow = tracks.length > pageCap;
        const visibleTracks = expanded ? tracks : tracks.slice(0, pageCap);
        const rowCount = Math.min(3, Math.max(1, Math.ceil(visibleTracks.length / gridCols)));
        return (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div
              style={
                !expanded
                  ? {
                      display: 'grid',
                      gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                      gridTemplateRows: `repeat(${rowCount}, auto)`,
                      gridAutoFlow: 'column',
                      gap: 8,
                    }
                  : {
                      display: 'grid',
                      gridTemplateColumns: `repeat(${gridCols}, minmax(0, 1fr))`,
                      gap: 8,
                    }
              }
            >
              {visibleTracks.map((t) =>
                renderSingleSongRow(t, tracks, `fyp:${descriptor.shelfUid}`, true)
              )}
            </div>
            {hasOverflow && (
              <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                <button
                  type="button"
                  data-focusable="true"
                  onClick={() =>
                    setExpandedTrackShelves((prev) => ({
                      ...prev,
                      [descriptor.shelfUid]: !prev[descriptor.shelfUid],
                    }))
                  }
                  style={{
                    minHeight: 28,
                    padding: '0 10px',
                    borderRadius: 8,
                    background: '#10141e',
                    border: '1px solid #263145',
                    color: '#93c5fd',
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  {expanded
                    ? 'Show Fewer ▴'
                    : `Browse More (${tracks.length - pageCap} more) ▾`}
                </button>
              </div>
            )}
          </div>
        );
      }
      case 'stations': {
        if (descriptor.provider === 'local') {
          return (
            <div style={tileGridStyle}>
              {(items as LocalSmartStation[]).map((st) =>
                renderLocalSmartStationCard(st, descriptor.shelfUid)
              )}
            </div>
          );
        }
        return <div style={tileGridStyle}>{items.map(renderStationCard)}</div>;
      }
      case 'albums': {
        return (
          <div style={tileGridStyle}>
            {descriptor.provider === 'apple_music'
              ? items.map(renderCloudAlbumCard)
              : descriptor.provider === 'soundcloud'
                ? items.map(renderSoundCloudPlaylistCard)
                : items.map(renderSimpAlbumCard)}
          </div>
        );
      }
      case 'playlists': {
        return (
          <div style={tileGridStyle}>
            {descriptor.provider === 'apple_music'
              ? items.map(renderCloudPlaylistCard)
              : descriptor.provider === 'soundcloud'
                ? items.map(renderSoundCloudPlaylistCard)
                : items.map(renderSimpPlaylistCard)}
          </div>
        );
      }
      case 'artists': {
        return (
          <div style={tileGridStyle}>
            {descriptor.provider === 'apple_music'
              ? items.map(renderAppleArtistCard)
              : descriptor.provider === 'soundcloud'
                ? items.map(renderSoundCloudUserCard)
                : items.map((item: any) =>
                    renderLocalArtistCard(typeof item === 'string' ? item : item?.name || '')
                  )}
          </div>
        );
      }
      case 'ia_items':
        return <div style={tileGridStyle}>{items.map(renderArchiveItemCard)}</div>;
      case 'mixed':
      default:
        return (
          <div style={tileGridStyle}>
            {items.map((item: any) => {
              const kind = item?._fypKind;
              if (kind === 'station') return renderStationCard(item);
              if (kind === 'album' || item?.artist_name) return renderCloudAlbumCard(item);
              return renderCloudPlaylistCard(item);
            })}
          </div>
        );
    }
  };

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0, width: '100%' }}
    >
      {/* Top Imp FYP Header Bar */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingBottom: 10,
          borderBottom: '1px solid #16161c',
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <ImpIcon name="bolt" size={16} color="#fde047" />
          <span style={{ fontSize: 15, fontWeight: 900, color: '#fef9c3' }}>Imp FYP</span>
          <span
            style={{
              fontSize: 10.5,
              fontFamily: 'monospace',
              padding: '2px 7px',
              borderRadius: 999,
              background: '#161622',
              border: '1px solid #282a3a',
              color: '#94a3b8',
            }}
          >
            {visibleShelves.length} {visibleShelves.length === 1 ? 'shelf' : 'shelves'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <FilterTriggerButton
            summary={mediaTypeFilter === 'all' ? 'All Media' : mediaTypeFilter === 'video' ? 'Video' : 'Audio'}
            active={mediaTypeFilter !== 'all'}
            accentColor="#eab308"
            activeBg="#1c1908"
            activeText="#fde047"
            onClick={onOpenFilters}
          />
          <button
            type="button"
            data-right-filter-pill="true"
            onClick={() => {
              for (const rec of visibleShelves) {
                const desc = parseDescriptor(rec);
                if (!desc) continue;
                if (desc.provider === 'apple_music' && !snap?.apple_authenticated) continue;
                queueFypRevalidation(desc, true);
              }
            }}
            style={{
              minHeight: 30,
              padding: '0 10px',
              borderRadius: 8,
              background: '#121420',
              border: '1px solid #262a3c',
              color: '#bae6fd',
              fontSize: 11,
              fontWeight: 700,
              cursor: 'pointer',
            }}
          >
            {revalidatingKeys.length > 0
              ? `⏳ Refreshing (${revalidatingKeys.length})...`
              : '↻ Refresh Stale'}
          </button>
          <button
            type="button"
            data-right-filter-pill="true"
            onClick={() => setCustomizeOpen((v) => !v)}
            style={{
              minHeight: 30,
              padding: '0 11px',
              borderRadius: 8,
              background: customizeOpen ? '#1c1908' : '#121420',
              border: customizeOpen ? '1px solid #eab308' : '1px solid #2a2d40',
              color: customizeOpen ? '#fde047' : '#e2e8f0',
              fontSize: 11,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            ⚙ Customize FYP
          </button>
        </div>
      </div>

      {/* Inline Customize FYP Reorder / Visibility / Unpin Drawer */}
      {customizeOpen && (
        <div
          style={{
            padding: 12,
            borderRadius: 12,
            background: '#0b0d14',
            border: '1px solid #2e3244',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 8,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 800, color: '#fde047' }}>
              Pinned Shelves ({shelves.length})
            </span>
            <button
              type="button"
              data-focusable="true"
              onClick={restoreDefaultShelves}
              style={{
                minHeight: 28,
                padding: '0 10px',
                borderRadius: 7,
                background: 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
                border: '1px solid var(--imp-focus-ring, #e8b86d)',
                color: 'var(--imp-accent-active-text, #f5e1be)',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              + Restore Starter Shelves
            </button>
          </div>
          {shelves.map((rec, idx) => (
            <div
              key={rec.shelf_uid}
              data-fyp-manage-row={rec.shelf_uid}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
                padding: '6px 10px',
                borderRadius: 8,
                background: '#11131d',
                border: '1px solid #222638',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
                {renderProviderMark(rec.provider)}
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: rec.enabled ? '#f1f5f9' : '#64748b',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {rec.title}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <button
                  type="button"
                  data-focusable="true"
                  data-fyp-action="move-up"
                  disabled={idx === 0}
                  onClick={(e) => {
                    if (idx === 0) return;
                    const uid = rec.shelf_uid;
                    const becomingFirst = idx === 1;
                    const next = [...shelves];
                    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
                    saveAllShelves(next);
                    const btn = e.currentTarget;
                    window.requestAnimationFrame(() => {
                      const target = becomingFirst
                        ? document.querySelector<HTMLElement>(
                            `[data-fyp-manage-row="${CSS.escape(uid)}"] [data-fyp-action="move-down"]:not([disabled])`
                          ) ||
                          document.querySelector<HTMLElement>(
                            `[data-fyp-manage-row="${CSS.escape(uid)}"] [data-fyp-action="toggle"]:not([disabled])`
                          )
                        : btn;
                      if (target) {
                        window.dispatchEvent(
                          new CustomEvent('simp-handoff-focus', { detail: { element: target } })
                        );
                      }
                    });
                  }}
                  title="Move shelf up"
                  style={{
                    minHeight: 26,
                    padding: '0 8px',
                    borderRadius: 6,
                    background: '#161926',
                    border: '1px solid #2a2e42',
                    color: idx === 0 ? '#475569' : '#e2e8f0',
                    fontSize: 11,
                    cursor: idx === 0 ? 'default' : 'pointer',
                  }}
                >
                  ▲
                </button>
                <button
                  type="button"
                  data-focusable="true"
                  data-fyp-action="move-down"
                  disabled={idx === shelves.length - 1}
                  onClick={(e) => {
                    if (idx >= shelves.length - 1) return;
                    const uid = rec.shelf_uid;
                    const becomingLast = idx === shelves.length - 2;
                    const next = [...shelves];
                    [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
                    saveAllShelves(next);
                    const btn = e.currentTarget;
                    window.requestAnimationFrame(() => {
                      const target = becomingLast
                        ? document.querySelector<HTMLElement>(
                            `[data-fyp-manage-row="${CSS.escape(uid)}"] [data-fyp-action="move-up"]:not([disabled])`
                          ) ||
                          document.querySelector<HTMLElement>(
                            `[data-fyp-manage-row="${CSS.escape(uid)}"] [data-fyp-action="toggle"]:not([disabled])`
                          )
                        : btn;
                      if (target) {
                        window.dispatchEvent(
                          new CustomEvent('simp-handoff-focus', { detail: { element: target } })
                        );
                      }
                    });
                  }}
                  title="Move shelf down"
                  style={{
                    minHeight: 26,
                    padding: '0 8px',
                    borderRadius: 6,
                    background: '#161926',
                    border: '1px solid #2a2e42',
                    color: idx === shelves.length - 1 ? '#475569' : '#e2e8f0',
                    fontSize: 11,
                    cursor: idx === shelves.length - 1 ? 'default' : 'pointer',
                  }}
                >
                  ▼
                </button>
                <button
                  type="button"
                  data-focusable="true"
                  data-fyp-action="toggle"
                  onClick={(e) => {
                    const btn = e.currentTarget;
                    const next = shelves.map((s) =>
                      s.shelf_uid === rec.shelf_uid ? { ...s, enabled: !s.enabled } : s
                    );
                    saveAllShelves(next);
                    window.requestAnimationFrame(() => {
                      if (btn.isConnected) {
                        window.dispatchEvent(
                          new CustomEvent('simp-handoff-focus', { detail: { element: btn } })
                        );
                      }
                    });
                  }}
                  style={{
                    minHeight: 26,
                    padding: '0 9px',
                    borderRadius: 6,
                    background: rec.enabled ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))' : '#181822',
                    border: rec.enabled ? '1px solid var(--imp-focus-ring, #e8b86d)' : '1px solid #2c2c38',
                    color: rec.enabled ? 'var(--imp-accent-active-text, #f5e1be)' : '#94a3b8',
                    fontSize: 10.5,
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  {rec.enabled ? 'Shown' : 'Hidden'}
                </button>
                <button
                  type="button"
                  data-focusable="true"
                  data-fyp-action="remove"
                  onClick={() => {
                    const nextUid = shelves[idx + 1]?.shelf_uid ?? shelves[idx - 1]?.shelf_uid ?? null;
                    unpinShelf(rec.shelf_uid);
                    window.requestAnimationFrame(() => {
                      const fallback =
                        (nextUid
                          ? document.querySelector<HTMLElement>(
                              `[data-fyp-manage-row="${CSS.escape(nextUid)}"] [data-fyp-action="remove"]:not([disabled])`
                            ) ||
                            document.querySelector<HTMLElement>(
                              `[data-fyp-manage-row="${CSS.escape(nextUid)}"] [data-fyp-action="toggle"]:not([disabled])`
                            )
                          : null) ||
                        document.querySelector<HTMLElement>(
                          '[data-nav-col="right"] button:not([disabled])'
                        );
                      if (fallback) {
                        window.dispatchEvent(
                          new CustomEvent('simp-handoff-focus', { detail: { element: fallback } })
                        );
                      }
                    });
                  }}
                  title="Remove shelf from Imp FYP"
                  style={{
                    minHeight: 26,
                    padding: '0 8px',
                    borderRadius: 6,
                    background: '#221116',
                    border: '1px solid #5c222d',
                    color: '#fca5a5',
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: 'pointer',
                  }}
                >
                  ✕
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Pinned & Starter FYP Shelves */}
      {!loaded ? (
        <div style={{ padding: 24, color: '#94a3b8', fontSize: 13 }}>
          ⏳ Hydrating Imp FYP from cache...
        </div>
      ) : visibleShelves.length === 0 ? (
        <div
          style={{
            padding: 28,
            borderRadius: 12,
            background: '#0b0c12',
            border: '1px solid #1e2030',
            textAlign: 'center',
            color: '#94a3b8',
            fontSize: 12.5,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span>No Imp FYP shelves enabled for the active source filter.</span>
          <button
            type="button"
            data-focusable="true"
            onClick={restoreDefaultShelves}
            style={{
              minHeight: 34,
              padding: '0 14px',
              borderRadius: 9,
              background: 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
              border: '1px solid var(--imp-focus-ring, #e8b86d)',
              color: 'var(--imp-accent-active-text, #f5e1be)',
              fontSize: 12,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            + Restore Starter FYP Shelves
          </button>
        </div>
      ) : (
        visibleShelves.map((rec) => {
          const descriptor = parseDescriptor(rec);
          if (!descriptor) return null;
          const items = resolveShelfItems(descriptor);
          const isUpdating = revalidatingKeys.includes(descriptor.cacheKey);
          return (
            <section
              key={rec.shelf_uid}
              ref={(el) => registerShelfElement(el, descriptor)}
              data-section-anchor={rec.shelf_uid}
              data-fyp-shelf-uid={rec.shelf_uid}
              data-fyp-shelf-title={rec.title}
              style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
            >
              <CollapsibleSectionHeader
                sectionKey={rec.shelf_uid}
                accentColor="#cbd5e1"
                title={
                  <>
                    {renderProviderMark(descriptor.provider)}
                    <span>{rec.title}</span>
                    {items.length > 0 && (
                      <span style={{ fontFamily: 'monospace', color: '#64748b', fontSize: 11 }}>
                        ({items.length})
                      </span>
                    )}
                    {isUpdating && (
                      <span style={{ fontSize: 10, color: '#38bdf8', fontFamily: 'monospace' }}>
                        ↻
                      </span>
                    )}
                  </>
                }
                trailing={
                  <>
                    <button
                      type="button"
                      tabIndex={-1}
                      data-no-dpad-focus="true"
                      data-right-filter-pill="true"
                      data-fyp-pin-btn="true"
                      data-fyp-shelf-uid={rec.shelf_uid}
                      data-fyp-shelf-title={rec.title}
                      data-fyp-shelf-pinned="true"
                      onClick={() => unpinShelf(rec.shelf_uid)}
                      title={`Remove "${rec.title}" from Imp FYP`}
                      style={{
                        minHeight: 26,
                        padding: '0 8px',
                        borderRadius: 7,
                        background: '#161822',
                        border: '1px solid #383c52',
                        color: '#e2e8f0',
                        fontSize: 10.5,
                        fontWeight: 800,
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 4,
                        cursor: 'pointer',
                      }}
                    >
                      <ImpIcon name="check" size={11} color="#e2e8f0" />
                      <span>In FYP</span>
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      data-no-dpad-focus="true"
                      data-right-filter-pill="true"
                      data-fyp-open-source-btn="true"
                      data-fyp-shelf-title={rec.title}
                      onClick={() =>
                        window.dispatchEvent(
                          new CustomEvent('simp-restore-origin-route', {
                            detail: descriptor.originRoute,
                          })
                        )
                      }
                      title="Open this shelf inside its source hub"
                      style={{
                        minHeight: 26,
                        padding: '0 9px',
                        borderRadius: 7,
                        background: '#12131c',
                        border: '1px solid #26293a',
                        color: '#93c5fd',
                        fontSize: 10.5,
                        fontWeight: 800,
                        cursor: 'pointer',
                      }}
                    >
                      Open Source ▸
                    </button>
                  </>
                }
              />
              {renderShelfBody(descriptor, items)}
            </section>
          );
        })
      )}
    </div>
  );
};
