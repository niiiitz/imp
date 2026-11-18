import React, { useLayoutEffect, useRef } from 'react';
import {
  AlphaBucket,
  BrowseHubTarget,
  LocalArtworkFilter,
  LocalLyricsFilter,
  LocalSubTab,
} from '../views/library/libraryHelpers';
import { ImpIcon, ImpIconName } from './icons/ImpIcon';

export type SmartFacetKind =
  | 'synced_lyrics'
  | 'has_lyrics'
  | 'has_art'
  | 'missing_art'
  | 'has_factoids'
  | 'has_comments'
  | null;

export interface LibraryFilterModalProps {
  open: boolean;
  onClose: () => void;
  browseHubTarget: BrowseHubTarget;
  rightPaneMode: 'browse' | 'tracks' | 'artist';
  mediaTypeFilter: 'all' | 'video' | 'audio';
  setMediaTypeFilter: React.Dispatch<React.SetStateAction<'all' | 'video' | 'audio'>>;
  // Imp Library
  simpHubFilter: 'all' | 'recent' | 'hybrid' | 'pinned' | 'albums' | 'videos';
  setSimpHubFilter: React.Dispatch<
    React.SetStateAction<'all' | 'recent' | 'hybrid' | 'pinned' | 'albums' | 'videos'>
  >;
  activeSmartFacet: SmartFacetKind;
  setActiveSmartFacet: React.Dispatch<React.SetStateAction<SmartFacetKind>>;
  recentCount: number;
  savedPlaylistsCount: number;
  pinnedCount: number;
  albumsCount: number;
  videosCount: number;
  showLocalVideos: boolean;
  showPinnedFilter: boolean;
  showLocalFacets: boolean;
  // Apple Discover
  appleSubTab: 'pinned' | 'for_you' | 'cloud_playlists' | 'new' | 'radio';
  cloudAlpha: AlphaBucket;
  setCloudAlpha: React.Dispatch<React.SetStateAction<AlphaBucket>>;
  resetCloudPlaylistsLimit: () => void;
  cloudPlaylistsCount: number;
  forYouFilter:
    | 'all'
    | 'stations'
    | 'new_releases'
    | 'recently_played'
    | 'mixes'
    | 'social'
    | 'recent_library';
  setForYouFilter: React.Dispatch<
    React.SetStateAction<
      | 'all'
      | 'stations'
      | 'new_releases'
      | 'recently_played'
      | 'mixes'
      | 'social'
      | 'recent_library'
    >
  >;
  newFilter: 'all' | 'recent_releases' | 'playlists' | 'albums' | 'songs';
  setNewFilter: React.Dispatch<
    React.SetStateAction<'all' | 'recent_releases' | 'playlists' | 'albums' | 'songs'>
  >;
  appleRadioFilter: 'all' | 'genre' | 'live' | 'shows' | 'mixes';
  setAppleRadioFilter: React.Dispatch<
    React.SetStateAction<'all' | 'genre' | 'live' | 'shows' | 'mixes'>
  >;
  appleRadioGenre: string;
  setAppleRadioGenre: React.Dispatch<React.SetStateAction<string>>;
  availableAppleRadioGenres: string[];
  // SoundCloud Discover
  soundCloudSubTab: 'pinned' | 'likes_sets' | 'stream_radio' | 'trending';
  scTrendingFilter: 'all' | 'for_you' | 'fresh' | 'artists' | 'mixes' | 'sets' | 'tracks';
  setScTrendingFilter: React.Dispatch<
    React.SetStateAction<'all' | 'for_you' | 'fresh' | 'artists' | 'mixes' | 'sets' | 'tracks'>
  >;
  scSelectedGenre: string;
  onSelectScGenre: (genre: string) => void;
  scLikesFilter: 'all' | 'sets' | 'likes' | 'following';
  setScLikesFilter: React.Dispatch<
    React.SetStateAction<'all' | 'sets' | 'likes' | 'following'>
  >;
  scStreamFilter: 'all' | 'sets' | 'history' | 'stream';
  setScStreamFilter: React.Dispatch<
    React.SetStateAction<'all' | 'sets' | 'history' | 'stream'>
  >;
  // Internet Archive Discover
  iaSubTab: 'pinned' | 'trending' | 'films' | 'tv' | 'audio';
  iaSubFilter: string;
  setIaSubFilter: React.Dispatch<React.SetStateAction<string>>;
  // Local Music & Storage Discover
  localSubTab?: LocalSubTab;
  setLocalSubTab?: React.Dispatch<React.SetStateAction<LocalSubTab>>;
  localGenreFilter?: string;
  setLocalGenreFilter?: React.Dispatch<React.SetStateAction<string>>;
  availableLocalGenres?: Array<{ genre: string; count: number }>;
  localYearFilter?: string;
  setLocalYearFilter?: React.Dispatch<React.SetStateAction<string>>;
  availableLocalEras?: Array<{ id: string; label: string; count: number }>;
  localArtworkFilter?: LocalArtworkFilter;
  setLocalArtworkFilter?: React.Dispatch<React.SetStateAction<LocalArtworkFilter>>;
  localArtworkCounts?: { hasArt: number; missingArt: number };
  localLyricsFilter?: LocalLyricsFilter;
  setLocalLyricsFilter?: React.Dispatch<React.SetStateAction<LocalLyricsFilter>>;
  localLyricsCounts?: { synced: number; anyLyrics: number; missing: number };
  localAlpha?: AlphaBucket;
  setLocalAlpha?: React.Dispatch<React.SetStateAction<AlphaBucket>>;
  localArtistsCount?: number;
  localAlbumsCount?: number;
  localVideosCount?: number;
  localMountsCount?: number;
  // Tracklist
  filterHasLyricsOnly: boolean;
  setFilterHasLyricsOnly: React.Dispatch<React.SetStateAction<boolean>>;
  tracklistLyricsCount: number;
  tracklistTotalCount: number;
}

const SC_VIBES = [
  { id: '', label: '🌐 All Vibes' },
  { id: 'Electronic', label: '⚡ Electronic' },
  { id: 'House', label: '🪩 House' },
  { id: 'Techno', label: '🎛️ Techno' },
  { id: 'Drum & Bass', label: '🥁 Drum & Bass' },
  { id: 'Hip-hop & Rap', label: '🎤 Hip-Hop' },
  { id: 'Ambient', label: '🌌 Ambient' },
  { id: 'Synthwave', label: '🌆 Synthwave' },
  { id: 'Indie', label: '🎸 Indie' },
] as const;

interface XmbFilterItem {
  id: string;
  label: string;
  icon?: ImpIconName | null;
  active: boolean;
  onSelect: () => void;
  accent?: string;
  activeBg?: string;
  activeText?: string;
}

interface XmbFilterRowConfig {
  key: string;
  label: string;
  accentColor: string;
  activeBg: string;
  activeText: string;
  items: XmbFilterItem[];
}

function syncFocusMarkerToElement(el: HTMLElement) {
  document
    .querySelectorAll<HTMLElement>('[data-simp-active-focus="true"], .simp-gpfocus')
    .forEach((node) => {
      if (node !== el) {
        node.removeAttribute('data-simp-active-focus');
        node.classList.remove('simp-gpfocus');
      }
    });
  el.setAttribute('data-simp-active-focus', 'true');
  el.classList.add('simp-gpfocus');
}

const XmbFilterRow: React.FC<{
  rowIndex: number;
  row: XmbFilterRowConfig;
  isLast: boolean;
  onItemActivate?: (rowIndex: number) => void;
}> = ({ rowIndex, row, isLast, onItemActivate }) => (
  <div
    data-filter-xmb-row={rowIndex}
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 8,
      minHeight: 42,
      padding: '4px 0',
      position: 'relative',
    }}
  >
    {/* Left Crossbar Spine */}
    <div
      style={{
        width: 152,
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        position: 'relative',
      }}
    >
      {!isLast && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: 8,
            top: '68%',
            height: 30,
            width: 1.5,
            background: '#222838',
            pointerEvents: 'none',
          }}
        />
      )}
      <span
        data-filter-xmb-spine-node="true"
        aria-hidden="true"
        style={{
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#111420',
          border: `1.5px solid ${row.accentColor}`,
          color: row.accentColor,
          fontSize: 9,
          fontWeight: 900,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          transition: 'transform 120ms ease, box-shadow 120ms ease',
        }}
      >
        ▸
      </span>
      <span
        data-filter-xmb-spine-label="true"
        style={{
          fontSize: 10.5,
          fontFamily: 'monospace',
          fontWeight: 800,
          color: row.activeText,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          lineHeight: 1.2,
          transition: 'color 120ms ease',
        }}
      >
        {row.label}
      </span>
    </div>

    {/* Horizontal Connector into Option Strip */}
    <div
      aria-hidden="true"
      style={{
        width: 10,
        height: 1.5,
        background: '#2a3244',
        flexShrink: 0,
      }}
    />

    {/* Horizontal XMB Option Track */}
    <div
      data-filter-xmb-track="true"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 2,
        overflowX: 'auto',
        overflowY: 'hidden',
        flexWrap: 'nowrap',
        flex: 1,
        minWidth: 0,
        padding: '3px 2px',
        scrollbarWidth: 'none',
      }}
    >
      {row.items.map((item, idx) => {
        const itemAccent = item.accent ?? row.accentColor;
        const itemBg = item.activeBg ?? row.activeBg;
        const itemText = item.activeText ?? row.activeText;
        return (
          <React.Fragment key={item.id}>
            {idx > 0 && (
              <div
                aria-hidden="true"
                style={{
                  width: 8,
                  height: 1.5,
                  background: '#1f2534',
                  flexShrink: 0,
                }}
              />
            )}
            <button
              type="button"
              data-filter-xmb-item="true"
              data-filter-xmb-active={item.active ? 'true' : undefined}
              data-default-focus={rowIndex === 0 && idx === 0 ? 'true' : undefined}
              onClick={(e) => {
                syncFocusMarkerToElement(e.currentTarget);
                onItemActivate?.(rowIndex);
                item.onSelect();
              }}
              style={{
                padding: '6px 10px',
                borderRadius: 7,
                background: item.active ? itemBg : '#0d0f17',
                border: item.active ? `1.5px solid ${itemAccent}` : '1px solid #1e2230',
                color: item.active ? itemText : '#9ca3af',
                fontSize: 11.5,
                fontWeight: item.active ? 800 : 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 5,
                whiteSpace: 'nowrap',
                flexShrink: 0,
                transition:
                  'background 120ms ease, border-color 120ms ease, color 120ms ease, transform 120ms ease',
              }}
            >
              {item.icon && (
                <ImpIcon
                  name={item.icon}
                  size={12}
                  color={item.active ? itemAccent : '#64748b'}
                />
              )}
              <span>{item.label}</span>
            </button>
          </React.Fragment>
        );
      })}
    </div>
  </div>
);

export const LibraryFilterModal: React.FC<LibraryFilterModalProps> = ({
  open,
  onClose,
  browseHubTarget,
  rightPaneMode,
  mediaTypeFilter,
  setMediaTypeFilter,
  simpHubFilter,
  setSimpHubFilter,
  activeSmartFacet,
  setActiveSmartFacet,
  recentCount,
  savedPlaylistsCount,
  pinnedCount,
  albumsCount,
  videosCount,
  showLocalVideos,
  showPinnedFilter,
  showLocalFacets,
  appleSubTab,
  cloudAlpha,
  setCloudAlpha,
  resetCloudPlaylistsLimit,
  cloudPlaylistsCount,
  forYouFilter,
  setForYouFilter,
  newFilter,
  setNewFilter,
  appleRadioFilter,
  setAppleRadioFilter,
  appleRadioGenre,
  setAppleRadioGenre,
  availableAppleRadioGenres,
  soundCloudSubTab,
  scTrendingFilter,
  setScTrendingFilter,
  scSelectedGenre,
  onSelectScGenre,
  scLikesFilter,
  setScLikesFilter,
  scStreamFilter,
  setScStreamFilter,
  iaSubTab,
  iaSubFilter,
  setIaSubFilter,
  localSubTab = 'overview',
  setLocalSubTab,
  localGenreFilter = 'all',
  setLocalGenreFilter,
  availableLocalGenres = [],
  localYearFilter = 'all',
  setLocalYearFilter,
  availableLocalEras = [],
  localArtworkFilter = 'all',
  setLocalArtworkFilter,
  localArtworkCounts = { hasArt: 0, missingArt: 0 },
  localLyricsFilter = 'all',
  setLocalLyricsFilter,
  localLyricsCounts = { synced: 0, anyLyrics: 0, missing: 0 },
  localAlpha = 'all',
  setLocalAlpha,
  localArtistsCount = 0,
  localAlbumsCount = 0,
  localVideosCount = 0,
  localMountsCount = 0,
  filterHasLyricsOnly,
  setFilterHasLyricsOnly,
  tracklistLyricsCount,
  tracklistTotalCount,
}) => {
  const lastFocusedRowRef = useRef<number>(0);

  useLayoutEffect(() => {
    if (!open) return;
    if (document.activeElement instanceof HTMLElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
    lastFocusedRowRef.current = 0;
    const modal = document.querySelector<HTMLElement>('[data-filter-modal="true"]');
    if (!modal) return;
    modal.querySelectorAll<HTMLElement>('button[data-filter-xmb-active="true"]').forEach((btn) => {
      btn.scrollIntoView({ block: 'nearest', inline: 'center' });
    });
    const target =
      modal.querySelector<HTMLElement>('button[data-default-focus="true"]:not([disabled])') ||
      modal.querySelector<HTMLElement>('button[data-filter-xmb-item="true"]:not([disabled])');
    if (target) {
      syncFocusMarkerToElement(target);
      target.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const modal = document.querySelector<HTMLElement>('[data-filter-modal="true"]');
    if (!modal) return;
    const curFocused = modal.querySelector<HTMLElement>('[data-simp-active-focus="true"]');
    if (curFocused) {
      const rowEl = curFocused.closest<HTMLElement>('[data-filter-xmb-row]');
      if (rowEl) {
        const parsed = Number(rowEl.dataset.filterXmbRow ?? 0);
        if (Number.isFinite(parsed)) {
          lastFocusedRowRef.current = parsed;
        }
      }
      return;
    }
    const targetRow =
      modal.querySelector<HTMLElement>(
        `[data-filter-xmb-row="${lastFocusedRowRef.current}"]`
      ) || modal.querySelector<HTMLElement>('[data-filter-xmb-row="0"]');
    const fallbackTarget =
      targetRow?.querySelector<HTMLElement>('button[data-filter-xmb-active="true"]:not([disabled])') ||
      targetRow?.querySelector<HTMLElement>('button[data-filter-xmb-item="true"]:not([disabled])') ||
      modal.querySelector<HTMLElement>('button[data-filter-xmb-item="true"]:not([disabled])');
    if (fallbackTarget) {
      syncFocusMarkerToElement(fallbackTarget);
      fallbackTarget.scrollIntoView({ block: 'nearest', inline: 'center' });
    }
  });

  if (!open) return null;

  const handleResetAll = () => {
    setMediaTypeFilter('all');
    if (rightPaneMode === 'tracks') {
      setFilterHasLyricsOnly(false);
    } else if (browseHubTarget === 'imp_library') {
      setSimpHubFilter('all');
      setActiveSmartFacet(null);
    } else if (browseHubTarget === 'local_discover' || browseHubTarget === 'mount') {
      setLocalGenreFilter?.('all');
      setLocalYearFilter?.('all');
      setLocalArtworkFilter?.('all');
      setLocalLyricsFilter?.('all');
      setLocalAlpha?.('all');
    } else if (browseHubTarget === 'apple_discover') {
      if (appleSubTab === 'cloud_playlists') {
        setCloudAlpha('all');
        resetCloudPlaylistsLimit();
      } else if (appleSubTab === 'for_you') {
        setForYouFilter('all');
      } else if (appleSubTab === 'new') {
        setNewFilter('all');
      } else if (appleSubTab === 'radio') {
        setAppleRadioFilter('all');
        setAppleRadioGenre('');
      }
    } else if (browseHubTarget === 'soundcloud_discover') {
      if (soundCloudSubTab === 'trending') {
        setScTrendingFilter('all');
        if (scSelectedGenre !== '') onSelectScGenre('');
      } else if (soundCloudSubTab === 'likes_sets') {
        setScLikesFilter('all');
      } else if (soundCloudSubTab === 'stream_radio') {
        setScStreamFilter('all');
      }
    } else if (browseHubTarget === 'ia_discover') {
      setIaSubFilter('all');
    }
  };

  // Assemble sequential XMB Crossbar rows based on active view
  const rows: XmbFilterRowConfig[] = [
    {
      key: 'media_type',
      label: 'Type',
      accentColor: '#2aa3c4',
      activeBg: '#0f222a',
      activeText: '#bfeaf5',
      items: [
        {
          id: 'all',
          label: 'All Media',
          icon: null,
          active: mediaTypeFilter === 'all',
          onSelect: () => setMediaTypeFilter('all'),
        },
        {
          id: 'video',
          label: 'Video',
          icon: 'video',
          active: mediaTypeFilter === 'video',
          onSelect: () => setMediaTypeFilter('video'),
        },
        {
          id: 'audio',
          label: 'Audio',
          icon: 'music',
          active: mediaTypeFilter === 'audio',
          onSelect: () => setMediaTypeFilter('audio'),
        },
      ],
    },
  ];

  if (rightPaneMode === 'tracks') {
    rows.push({
      key: 'tracklist_lyrics',
      label: 'Lyrics',
      accentColor: '#34d399',
      activeBg: '#0b241c',
      activeText: '#6ee7b7',
      items: [
        {
          id: 'all',
          label: `All Tracks (${tracklistTotalCount})`,
          active: !filterHasLyricsOnly,
          accent: '#38bdf8',
          activeBg: '#0d2230',
          activeText: '#7dd3fc',
          onSelect: () => setFilterHasLyricsOnly(false),
        },
        {
          id: 'lyrics',
          label: `Has Lyrics (${tracklistLyricsCount})`,
          icon: 'lyrics',
          active: filterHasLyricsOnly,
          accent: '#34d399',
          activeBg: '#0b241c',
          activeText: '#6ee7b7',
          onSelect: () => setFilterHasLyricsOnly((v) => !v),
        },
      ],
    });
  } else if (
    rightPaneMode === 'browse' &&
    (browseHubTarget === 'local_discover' || browseHubTarget === 'mount')
  ) {
    if (setLocalSubTab) {
      rows.push({
        key: 'local_view',
        label: 'Local View',
        accentColor: '#34d399',
        activeBg: '#0b241c',
        activeText: '#6ee7b7',
        items: (
          [
            { id: 'overview', label: '⚡ Overview' },
            { id: 'artists', label: `🎤 Artists (${localArtistsCount})` },
            { id: 'albums', label: `💿 Albums (${localAlbumsCount})` },
            { id: 'folders', label: `📂 Folders (${localMountsCount})` },
            ...(localVideosCount > 0 && mediaTypeFilter !== 'audio'
              ? [{ id: 'videos' as const, label: `🎬 Videos (${localVideosCount})` }]
              : []),
          ] as const
        ).map((t) => ({
          id: t.id,
          label: t.label,
          active: (browseHubTarget === 'mount' ? 'folders' : localSubTab) === t.id,
          onSelect: () => setLocalSubTab(t.id),
        })),
      });
    }

    if (setLocalArtworkFilter) {
      rows.push({
        key: 'local_artwork',
        label: 'Artwork',
        accentColor: '#34d399',
        activeBg: '#0b241c',
        activeText: '#6ee7b7',
        items: [
          {
            id: 'all',
            label: 'All',
            active: localArtworkFilter === 'all',
            onSelect: () => setLocalArtworkFilter('all'),
          },
          {
            id: 'has_art',
            label: `Artwork Found (${localArtworkCounts.hasArt})`,
            icon: 'artwork',
            accent: '#38bdf8',
            activeBg: '#0c202e',
            activeText: '#7dd3fc',
            active: localArtworkFilter === 'has_art',
            onSelect: () =>
              setLocalArtworkFilter((prev) => (prev === 'has_art' ? 'all' : 'has_art')),
          },
          {
            id: 'missing_art',
            label: `Missing Artwork (${localArtworkCounts.missingArt})`,
            icon: 'artwork-missing',
            accent: '#facc15',
            activeBg: '#27200a',
            activeText: '#fde047',
            active: localArtworkFilter === 'missing_art',
            onSelect: () =>
              setLocalArtworkFilter((prev) => (prev === 'missing_art' ? 'all' : 'missing_art')),
          },
        ],
      });
    }

    if (setLocalLyricsFilter) {
      rows.push({
        key: 'local_lyrics',
        label: 'Lyrics',
        accentColor: '#34d399',
        activeBg: '#0b241c',
        activeText: '#6ee7b7',
        items: [
          {
            id: 'all',
            label: 'All',
            active: localLyricsFilter === 'all',
            onSelect: () => setLocalLyricsFilter('all'),
          },
          {
            id: 'synced',
            label: `Synced LRC (${localLyricsCounts.synced})`,
            icon: 'lyrics',
            active: localLyricsFilter === 'synced',
            onSelect: () => setLocalLyricsFilter((prev) => (prev === 'synced' ? 'all' : 'synced')),
          },
          {
            id: 'has_lyrics',
            label: `Any Lyrics (${localLyricsCounts.anyLyrics})`,
            icon: 'lyrics',
            active: localLyricsFilter === 'has_lyrics',
            onSelect: () =>
              setLocalLyricsFilter((prev) => (prev === 'has_lyrics' ? 'all' : 'has_lyrics')),
          },
          {
            id: 'missing_lyrics',
            label: `Missing Lyrics (${localLyricsCounts.missing})`,
            active: localLyricsFilter === 'missing_lyrics',
            onSelect: () =>
              setLocalLyricsFilter((prev) =>
                prev === 'missing_lyrics' ? 'all' : 'missing_lyrics'
              ),
          },
        ],
      });
    }

    if (setLocalGenreFilter && availableLocalGenres.length > 0) {
      rows.push({
        key: 'local_genre',
        label: 'Genre',
        accentColor: '#34d399',
        activeBg: '#0b241c',
        activeText: '#6ee7b7',
        items: [
          {
            id: 'all',
            label: 'All Genres',
            active: localGenreFilter === 'all',
            onSelect: () => setLocalGenreFilter('all'),
          },
          ...availableLocalGenres.map((g) => ({
            id: g.genre,
            label: `${g.genre} (${g.count})`,
            active: localGenreFilter.toLowerCase() === g.genre.toLowerCase(),
            onSelect: () =>
              setLocalGenreFilter((prev) =>
                prev.toLowerCase() === g.genre.toLowerCase() ? 'all' : g.genre
              ),
          })),
        ],
      });
    }

    if (setLocalYearFilter && availableLocalEras.length > 0) {
      rows.push({
        key: 'local_era',
        label: 'Era / Year',
        accentColor: '#34d399',
        activeBg: '#0b241c',
        activeText: '#6ee7b7',
        items: [
          {
            id: 'all',
            label: 'All Years',
            active: localYearFilter === 'all',
            onSelect: () => setLocalYearFilter('all'),
          },
          ...availableLocalEras.map((era) => ({
            id: era.id,
            label: `${era.label} (${era.count})`,
            active: localYearFilter === era.id,
            onSelect: () => setLocalYearFilter((prev) => (prev === era.id ? 'all' : era.id)),
          })),
        ],
      });
    }

    if (setLocalAlpha && (localSubTab === 'artists' || localSubTab === 'albums')) {
      rows.push({
        key: 'local_alpha',
        label: 'A–Z Bucket',
        accentColor: '#34d399',
        activeBg: '#0b241c',
        activeText: '#6ee7b7',
        items: (
          [
            { id: 'all', label: 'All' },
            { id: 'a_f', label: 'A–F' },
            { id: 'g_l', label: 'G–L' },
            { id: 'm_r', label: 'M–R' },
            { id: 's_z', label: 'S–Z' },
            { id: 'num', label: '#' },
          ] as const
        ).map((b) => ({
          id: b.id,
          label: b.label,
          active: localAlpha === b.id,
          onSelect: () => setLocalAlpha(b.id),
        })),
      });
    }
  } else if (rightPaneMode === 'browse' && browseHubTarget === 'imp_library') {
    rows.push({
      key: 'imp_library_view',
      label: 'Library View',
      accentColor: '#2aa3c4',
      activeBg: '#0f222a',
      activeText: '#bfeaf5',
      items: [
        { id: 'all' as const, label: 'All' },
        ...(recentCount > 0
          ? [{ id: 'recent' as const, label: `🕒 Recent (${recentCount})` }]
          : []),
        { id: 'hybrid' as const, label: `★ Saved / Playlists (${savedPlaylistsCount})` },
        ...(showPinnedFilter
          ? [{ id: 'pinned' as const, label: `📌 Pinned (${pinnedCount})` }]
          : []),
        ...(mediaTypeFilter !== 'video'
          ? [{ id: 'albums' as const, label: `💿 Albums (${albumsCount})` }]
          : []),
        ...(showLocalVideos
          ? [{ id: 'videos' as const, label: `🎬 Videos (${videosCount})` }]
          : []),
      ].map((f) => ({
        id: f.id,
        label: f.label,
        active: simpHubFilter === f.id && !activeSmartFacet,
        onSelect: () => {
          setActiveSmartFacet(null);
          setSimpHubFilter(f.id);
        },
      })),
    });

    if (showLocalFacets) {
      rows.push({
        key: 'smart_facets',
        label: 'Smart Facets',
        accentColor: '#34d399',
        activeBg: '#10221c',
        activeText: '#6ee7b7',
        items: [
          {
            id: 'all_facets',
            label: 'All Items',
            active: !activeSmartFacet,
            accent: '#34d399',
            activeBg: '#0b241c',
            activeText: '#6ee7b7',
            onSelect: () => setActiveSmartFacet(null),
          },
          ...(
            [
              {
                id: 'synced_lyrics' as const,
                icon: 'lyrics' as const,
                label: 'Karaoke / Has Lyrics',
                accent: '#34d399',
              },
              {
                id: 'has_factoids' as const,
                icon: 'factoid' as const,
                label: 'Pop-Up Factoids',
                accent: '#c084fc',
              },
              {
                id: 'has_comments' as const,
                icon: 'comments' as const,
                label: 'Timed Comments',
                accent: '#fb923c',
              },
              {
                id: 'has_art' as const,
                icon: 'artwork' as const,
                label: 'Has Artwork',
                accent: '#38bdf8',
              },
              {
                id: 'missing_art' as const,
                icon: 'artwork-missing' as const,
                label: 'Missing Artwork',
                accent: '#facc15',
              },
            ] as const
          ).map((facet) => ({
            id: facet.id,
            icon: facet.icon,
            label: facet.label,
            accent: facet.accent,
            activeBg: '#10221c',
            activeText: facet.accent,
            active:
              activeSmartFacet === facet.id ||
              (facet.id === 'synced_lyrics' && activeSmartFacet === 'has_lyrics'),
            onSelect: () =>
              setActiveSmartFacet((prev) =>
                prev === facet.id || (facet.id === 'synced_lyrics' && prev === 'has_lyrics')
                  ? null
                  : facet.id
              ),
          })),
        ],
      });
    }
  } else if (rightPaneMode === 'browse' && browseHubTarget === 'apple_discover') {
    if (appleSubTab === 'cloud_playlists') {
      rows.push({
        key: 'apple_alpha',
        label: 'A–Z Bucket',
        accentColor: '#fa243c',
        activeBg: '#28111b',
        activeText: '#fecdd3',
        items: (
          [
            { id: 'all', label: `All (${cloudPlaylistsCount})` },
            { id: 'a_f', label: 'A–F' },
            { id: 'g_l', label: 'G–L' },
            { id: 'm_r', label: 'M–R' },
            { id: 's_z', label: 'S–Z' },
            { id: 'num', label: '#' },
          ] as const
        ).map((b) => ({
          id: b.id,
          label: b.label,
          active: cloudAlpha === b.id,
          onSelect: () => {
            setCloudAlpha(b.id);
            resetCloudPlaylistsLimit();
          },
        })),
      });
    } else if (appleSubTab === 'for_you') {
      rows.push({
        key: 'apple_for_you',
        label: 'For You',
        accentColor: '#fa243c',
        activeBg: '#28111b',
        activeText: '#fecdd3',
        items: (
          [
            { id: 'all', label: 'All' },
            { id: 'stations', label: '📻 Personal Radio' },
            { id: 'new_releases', label: '🆕 New Releases' },
            { id: 'recently_played', label: '🕒 Recently Played' },
            { id: 'mixes', label: '✨ Mixes & Recommendations' },
            { id: 'social', label: '👥 Friends Listening' },
            { id: 'recent_library', label: '☁️ Recently Added' },
          ] as const
        ).map((f) => ({
          id: f.id,
          label: f.label,
          active: forYouFilter === f.id,
          onSelect: () => setForYouFilter(f.id),
        })),
      });
    } else if (appleSubTab === 'new') {
      rows.push({
        key: 'apple_new',
        label: 'New & Charts',
        accentColor: '#fa243c',
        activeBg: '#28111b',
        activeText: '#fecdd3',
        items: (
          [
            { id: 'all', label: 'All' },
            { id: 'recent_releases', label: '🆕 Recent Releases' },
            { id: 'albums', label: '💿 New Albums' },
            { id: 'playlists', label: '🎶 Featured Playlists' },
            { id: 'songs', label: '🎵 Top Singles' },
          ] as const
        ).map((f) => ({
          id: f.id,
          label: f.label,
          active: newFilter === f.id,
          onSelect: () => setNewFilter(f.id),
        })),
      });
    } else if (appleSubTab === 'radio') {
      rows.push({
        key: 'apple_radio_cat',
        label: 'Radio Category',
        accentColor: '#fa243c',
        activeBg: '#28111b',
        activeText: '#fecdd3',
        items: (
          [
            { id: 'all', label: 'All Radio' },
            { id: 'live', label: '📻 Live & Personal' },
            { id: 'shows', label: '🎙️ Shows & Interviews' },
            { id: 'mixes', label: '🎧 Club Mixes & DJ Sets' },
            { id: 'genre', label: '📡 By Genre' },
          ] as const
        ).map((f) => ({
          id: f.id,
          label: f.label,
          active: appleRadioFilter === f.id,
          onSelect: () => setAppleRadioFilter(f.id),
        })),
      });
      if (availableAppleRadioGenres.length > 0) {
        rows.push({
          key: 'apple_radio_genre',
          label: 'Radio Genre',
          accentColor: '#fa243c',
          activeBg: '#28111b',
          activeText: '#fecdd3',
          items: [
            { id: '', label: '🌐 All Genres' },
            ...availableAppleRadioGenres.map((g) => ({ id: g, label: g })),
          ].map((g) => ({
            id: g.id || 'all-genres',
            label: g.label,
            active: appleRadioGenre === g.id,
            onSelect: () => setAppleRadioGenre(g.id),
          })),
        });
      }
    }
  } else if (rightPaneMode === 'browse' && browseHubTarget === 'soundcloud_discover') {
    if (soundCloudSubTab === 'trending') {
      rows.push({
        key: 'sc_trending',
        label: 'Trending Sections',
        accentColor: '#ff5500',
        activeBg: '#2c140a',
        activeText: '#fed7aa',
        items: (
          [
            { id: 'all', label: 'All' },
            { id: 'for_you', label: '💡 For You' },
            { id: 'fresh', label: '🆕 Fresh' },
            { id: 'artists', label: '👥 Artists' },
            { id: 'mixes', label: '🎧 20m+ DJ Mixes' },
            { id: 'sets', label: '🎶 Featured Sets' },
            { id: 'tracks', label: '🔥 Trending Tracks' },
          ] as const
        ).map((f) => ({
          id: f.id,
          label: f.label,
          active: scTrendingFilter === f.id,
          onSelect: () => setScTrendingFilter(f.id),
        })),
      });
      rows.push({
        key: 'sc_vibe',
        label: 'Vibe / Genre',
        accentColor: '#ff5500',
        activeBg: '#3c1c0f',
        activeText: '#fed7aa',
        items: SC_VIBES.map((g) => ({
          id: g.id || 'all',
          label: g.label,
          active: scSelectedGenre === g.id,
          onSelect: () => onSelectScGenre(g.id),
        })),
      });
    } else if (soundCloudSubTab === 'likes_sets') {
      rows.push({
        key: 'sc_likes_sets',
        label: 'Likes & Sets',
        accentColor: '#ff5500',
        activeBg: '#2c140a',
        activeText: '#fed7aa',
        items: (
          [
            { id: 'all', label: 'All' },
            { id: 'likes', label: '❤️ Liked Tracks' },
            { id: 'sets', label: '🎶 Sets & Playlists' },
            { id: 'following', label: '👥 Following' },
          ] as const
        ).map((f) => ({
          id: f.id,
          label: f.label,
          active: scLikesFilter === f.id,
          onSelect: () => setScLikesFilter(f.id),
        })),
      });
    } else if (soundCloudSubTab === 'stream_radio') {
      rows.push({
        key: 'sc_stream_radio',
        label: 'Stream & Radio',
        accentColor: '#ff5500',
        activeBg: '#2c140a',
        activeText: '#fed7aa',
        items: (
          [
            { id: 'all', label: 'All' },
            { id: 'history', label: '🕒 Listening History' },
            { id: 'stream', label: '⚡ Following Stream' },
            { id: 'sets', label: '🎶 Reposted Sets' },
          ] as const
        ).map((f) => ({
          id: f.id,
          label: f.label,
          active: scStreamFilter === f.id,
          onSelect: () => setScStreamFilter(f.id),
        })),
      });
    }
  } else if (rightPaneMode === 'browse' && browseHubTarget === 'ia_discover') {
    const iaItems =
      iaSubTab === 'trending'
        ? [
            { id: 'all', label: 'This Week' },
            { id: 'movies', label: 'Video' },
            { id: 'audio', label: 'Audio' },
            { id: 'all_time', label: 'All-Time' },
            { id: 'favorites', label: 'Favorites' },
          ]
        : iaSubTab === 'films'
        ? [
            { id: 'all', label: 'Feature Films' },
            { id: 'noir', label: 'Film Noir' },
            { id: 'scifi_horror', label: 'Sci-Fi & Horror' },
            { id: 'comedy', label: 'Comedy' },
            { id: 'silent', label: 'Silent Films' },
          ]
        : iaSubTab === 'tv'
        ? [
            { id: 'all', label: 'All TV' },
            { id: 'cartoons', label: 'Animation' },
            { id: 'classic_tv', label: 'Classic TV' },
            { id: 'scifi_tv', label: 'Sci-Fi & Mystery' },
          ]
        : [
            { id: 'all', label: 'All Audio' },
            { id: 'etree', label: 'Live Concerts' },
            { id: 'netlabels', label: 'Netlabels' },
            { id: 'radio', label: 'Old Time Radio' },
            { id: 'librivox', label: 'Audiobooks' },
          ];
    rows.push({
      key: 'ia_collection',
      label: 'Collection',
      accentColor: '#f59e0b',
      activeBg: '#261a0b',
      activeText: '#fde68a',
      items: iaItems.map((f) => ({
        id: f.id,
        label: f.label,
        active: iaSubFilter === f.id,
        onSelect: () => setIaSubFilter(f.id),
      })),
    });
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.82)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        boxSizing: 'border-box',
        zIndex: 82,
      }}
    >
      <style>{`
        [data-filter-modal="true"] [data-filter-xmb-track="true"]::-webkit-scrollbar {
          display: none;
        }
        html[data-simp-input="pointer"] [data-filter-modal="true"] [data-filter-xmb-item="true"].simp-gpfocus,
        html[data-simp-input="gamepad"] [data-filter-modal="true"] [data-filter-xmb-item="true"].simp-gpfocus,
        html [data-filter-modal="true"] [data-filter-xmb-item="true"][data-simp-active-focus="true"] {
          outline: 2px solid #ffffff !important;
          outline-offset: 1px !important;
          box-shadow: 0 0 0 3px rgba(103, 232, 249, 0.35), 0 4px 12px rgba(0, 0, 0, 0.65) !important;
          transform: scale(1.04);
        }
        html[data-simp-input="pointer"] [data-filter-modal="true"] [data-filter-reset="true"].simp-gpfocus,
        html[data-simp-input="gamepad"] [data-filter-modal="true"] [data-filter-reset="true"].simp-gpfocus,
        html [data-filter-modal="true"] [data-filter-reset="true"][data-simp-active-focus="true"] {
          outline: 2px solid #ffffff !important;
          outline-offset: 1px !important;
          box-shadow: 0 0 0 3px rgba(103, 232, 249, 0.35) !important;
        }
        [data-filter-modal="true"] [data-filter-xmb-row]:has([data-simp-active-focus="true"]) [data-filter-xmb-spine-label="true"] {
          color: #ffffff !important;
        }
        [data-filter-modal="true"] [data-filter-xmb-row]:has([data-simp-active-focus="true"]) [data-filter-xmb-spine-node="true"] {
          transform: scale(1.18);
          box-shadow: 0 0 10px rgba(103, 232, 249, 0.55);
        }
      `}</style>
      <div
        data-modal-root="true"
        data-filter-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 680,
          maxHeight: '85vh',
          overflowY: 'auto',
          background: '#08080e',
          border: '1.5px solid #2aa3c4',
          borderRadius: 16,
          padding: '16px 18px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          boxShadow: '0 16px 42px rgba(0, 0, 0, 0.9)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
            borderBottom: '1px solid #161824',
            paddingBottom: 10,
          }}
        >
          <div>
            <div style={{ fontSize: 14.5, fontWeight: 900, color: '#bfeaf5' }}>
              ⚲ Library &amp; View Filters
            </div>
            <div style={{ fontSize: 11, color: '#7b8090', marginTop: 2 }}>
              ▲▼ switch row • ◄► select &amp; apply • Esc / B / Y close
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              data-filter-reset="true"
              onClick={handleResetAll}
              style={{
                minHeight: 32,
                padding: '0 10px',
                borderRadius: 7,
                background: '#14141d',
                border: '1px solid #2a2a38',
                color: '#94a3b8',
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              Reset
            </button>
            <button
              type="button"
              data-filter-modal-close="true"
              data-no-dpad-focus="true"
              aria-label="Close Filters"
              title="Close (Esc / B / Y)"
              onClick={onClose}
              style={{
                width: 32,
                height: 32,
                borderRadius: 7,
                background: '#14141d',
                border: '1px solid #2a2a38',
                color: '#cbd5e1',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              <ImpIcon name="close" size={13} />
            </button>
          </div>
        </div>

        {/* XMB Crossbar Matrix Rows */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map((row, idx) => (
            <XmbFilterRow
              key={row.key}
              rowIndex={idx}
              row={row}
              isLast={idx === rows.length - 1}
              onItemActivate={(activatedRowIdx) => {
                lastFocusedRowRef.current = activatedRowIdx;
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
};
