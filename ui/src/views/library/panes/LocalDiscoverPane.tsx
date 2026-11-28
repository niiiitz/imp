import React, { useEffect, useMemo, useState } from 'react';
import {
  AlbumRecord,
  defaultSimpClient,
  SimpStateSnapshot,
  TrackMetadata,
} from '@imp/client';
import {
  DEFAULT_STARTER_FYP_DESCRIPTORS,
  LocalDiscoverResponse,
  LocalSmartStation,
} from '../../../api/servicesCacheApi';
import { ImpIcon } from '../../../components/icons/ImpIcon';
import { isUiVideoTrack } from '../../PlayerView';
import {
  type AlphaBucket,
  type BrowseHubTarget,
  decadeFromYear,
  type LocalArtworkFilter,
  type LocalLyricsFilter,
  type LocalSubTab,
  matchesAlphaBucket,
  stripAlbumFormatSuffix,
  tileGridStyle,
  useLibraryLyricsStatus,
} from '../libraryHelpers';
import { buildLocalFolderDrillData } from '../localFolderTree';
import {
  CollapsibleSectionHeader,
  FilterTriggerButton,
  PinnableSectionHeader,
} from '../PinnableSectionHeader';
import { CollectionTileCard } from '../cards/CollectionTileCard';
import { HorizontalShelfRail } from '../HorizontalShelfRail';

export interface LocalArtistFacet {
  name: string;
  albumCount: number;
  trackCount: number;
  artUrl: string | null;
}

export interface LocalFacetsSummary {
  genres: Array<{ genre: string; count: number }>;
  eras: Array<{ id: string; label: string; count: number }>;
  artworkCounts: { hasArt: number; missingArt: number };
  lyricsCounts: { synced: number; anyLyrics: number; missing: number };
  artists: LocalArtistFacet[];
  albumArtists: LocalArtistFacet[];
  allTrackArtists: LocalArtistFacet[];
}

export function cleanAlbumArtistDisplay(raw: string): string {
  return stripAlbumFormatSuffix(raw);
}

const GENERIC_ALBUM_ARTISTS = new Set([
  '',
  'various artists',
  'various',
  'va',
  'v.a.',
  'soundtrack',
  'original soundtrack',
  'ost',
  'steam soundtrack',
  'local video',
  'unknown artist',
  'compilation',
]);

export function computeLocalFacetsSummary(
  localAlbums: AlbumRecord[],
  localTracks: TrackMetadata[],
  syncedUris: Set<string>,
  allLyricsUris: Set<string>
): LocalFacetsSummary {
  const audioTracks = localTracks.filter((t) => !isUiVideoTrack(t));
  const genreMap = new Map<string, { display: string; count: number }>();
  const decadeMap = new Map<string, number>();
  let unknownYearCount = 0;
  let hasArt = 0;
  let missingArt = 0;
  let synced = 0;
  let anyLyrics = 0;
  let missingLyrics = 0;

  type MutableArtistEntry = {
    display: string;
    albums: Set<string>;
    tracks: Set<string>;
    artUrl: string | null;
  };
  const albumArtistMap = new Map<string, MutableArtistEntry>();
  const allTrackArtistMap = new Map<string, MutableArtistEntry>();

  const primaryTrackArtistsByAlbum = new Map<string, Set<string>>();
  const audioTrackCountByAlbum = new Map<string, number>();
  for (const t of audioTracks) {
    if (!t.album_id) continue;
    audioTrackCountByAlbum.set(t.album_id, (audioTrackCountByAlbum.get(t.album_id) || 0) + 1);
    const primary = ((t.artists && t.artists[0]) || '').trim().toLowerCase();
    if (primary && primary !== 'unknown artist') {
      let set = primaryTrackArtistsByAlbum.get(t.album_id);
      if (!set) {
        set = new Set<string>();
        primaryTrackArtistsByAlbum.set(t.album_id, set);
      }
      set.add(primary);
    }
  }

  const albumPrimaryArtistByAlbumId = new Map<string, string>();
  const compilationAlbumIds = new Set<string>();

  for (const alb of localAlbums) {
    const cleanArtist = cleanAlbumArtistDisplay(alb.album_artist).trim();
    const lowerClean = cleanArtist.toLowerCase();
    const distinctPrimary = primaryTrackArtistsByAlbum.get(alb.id)?.size || 0;
    const albTrackCount = audioTrackCountByAlbum.get(alb.id) || 0;
    const isCompilationOrOst =
      GENERIC_ALBUM_ARTISTS.has(lowerClean) ||
      (albTrackCount >= 4 &&
        distinctPrimary >= 4 &&
        (!cleanArtist || lowerClean === alb.title.trim().toLowerCase()));

    if (cleanArtist && lowerClean !== 'steam soundtrack' && lowerClean !== 'local video') {
      const entry = allTrackArtistMap.get(lowerClean) || {
        display: cleanArtist,
        albums: new Set<string>(),
        tracks: new Set<string>(),
        artUrl: alb.art_url || null,
      };
      entry.albums.add(alb.id);
      if (!entry.artUrl && alb.art_url) entry.artUrl = alb.art_url;
      allTrackArtistMap.set(lowerClean, entry);
    }

    if (isCompilationOrOst) {
      compilationAlbumIds.add(alb.id);
    } else if (cleanArtist) {
      albumPrimaryArtistByAlbumId.set(alb.id, cleanArtist);
      const entry = albumArtistMap.get(lowerClean) || {
        display: cleanArtist,
        albums: new Set<string>(),
        tracks: new Set<string>(),
        artUrl: alb.art_url || null,
      };
      entry.albums.add(alb.id);
      if (!entry.artUrl && alb.art_url) entry.artUrl = alb.art_url;
      albumArtistMap.set(lowerClean, entry);
    }
  }

  for (const t of audioTracks) {
    const g = (t.genre || '').trim();
    if (g) {
      const k = g.toLowerCase();
      const prev = genreMap.get(k);
      genreMap.set(k, { display: prev?.display || g, count: (prev?.count || 0) + 1 });
    }
    const dec = decadeFromYear(t.release_year);
    if (dec) {
      decadeMap.set(dec, (decadeMap.get(dec) || 0) + 1);
    } else {
      unknownYearCount += 1;
    }
    if (t.art_url && t.art_url.trim().length > 0) {
      hasArt += 1;
    } else {
      missingArt += 1;
    }
    if (syncedUris.has(t.uri)) {
      synced += 1;
      anyLyrics += 1;
    } else if (allLyricsUris.has(t.uri)) {
      anyLyrics += 1;
    } else {
      missingLyrics += 1;
    }

    for (const rawArt of t.artists || []) {
      const name = rawArt.trim();
      if (!name || name.toLowerCase() === 'unknown artist') continue;
      const k = name.toLowerCase();
      const entry = allTrackArtistMap.get(k) || {
        display: name,
        albums: new Set<string>(),
        tracks: new Set<string>(),
        artUrl: t.art_url || null,
      };
      entry.tracks.add(t.uri);
      if (t.album_id) entry.albums.add(t.album_id);
      if (!entry.artUrl && t.art_url) entry.artUrl = t.art_url;
      allTrackArtistMap.set(k, entry);
    }

    const albumOwner = t.album_id ? albumPrimaryArtistByAlbumId.get(t.album_id) : undefined;
    if (albumOwner) {
      const k = albumOwner.toLowerCase();
      const entry = albumArtistMap.get(k) || {
        display: albumOwner,
        albums: new Set<string>(),
        tracks: new Set<string>(),
        artUrl: t.art_url || null,
      };
      entry.tracks.add(t.uri);
      if (t.album_id) entry.albums.add(t.album_id);
      if (!entry.artUrl && t.art_url) entry.artUrl = t.art_url;
      albumArtistMap.set(k, entry);
    } else if (!t.album_id || !compilationAlbumIds.has(t.album_id)) {
      const fallbackName = ((t.artists && t.artists[0]) || '').trim();
      if (fallbackName && !GENERIC_ALBUM_ARTISTS.has(fallbackName.toLowerCase())) {
        const k = fallbackName.toLowerCase();
        const entry = albumArtistMap.get(k) || {
          display: fallbackName,
          albums: new Set<string>(),
          tracks: new Set<string>(),
          artUrl: t.art_url || null,
        };
        entry.tracks.add(t.uri);
        if (t.album_id) entry.albums.add(t.album_id);
        if (!entry.artUrl && t.art_url) entry.artUrl = t.art_url;
        albumArtistMap.set(k, entry);
      }
    }
  }

  const genres = Array.from(genreMap.values())
    .map((x) => ({ genre: x.display, count: x.count }))
    .sort((a, b) => b.count - a.count || a.genre.localeCompare(b.genre))
    .slice(0, 24);

  const eras = Array.from(decadeMap.entries())
    .map(([dec, count]) => ({ id: dec, label: dec, count }))
    .sort((a, b) => b.id.localeCompare(a.id));
  if (unknownYearCount > 0) {
    eras.push({ id: 'unknown', label: 'No Year', count: unknownYearCount });
  }

  const mapToSortedList = (m: Map<string, MutableArtistEntry>): LocalArtistFacet[] =>
    Array.from(m.values())
      .map((a) => ({
        name: a.display,
        albumCount: a.albums.size,
        trackCount: a.tracks.size,
        artUrl: a.artUrl,
      }))
      .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const albumArtists = mapToSortedList(albumArtistMap);
  const allTrackArtists = mapToSortedList(allTrackArtistMap);

  return {
    genres,
    eras,
    artworkCounts: { hasArt, missingArt },
    lyricsCounts: { synced, anyLyrics, missing: missingLyrics },
    artists: albumArtists,
    albumArtists,
    allTrackArtists,
  };
}

export interface LocalDiscoverPaneProps {
  browseHubTarget: BrowseHubTarget;
  localSubTab: LocalSubTab;
  setLocalSubTab: React.Dispatch<React.SetStateAction<LocalSubTab>>;
  activeMountRoot: string | null;
  setActiveMountRoot: React.Dispatch<React.SetStateAction<string | null>>;
  localFolderPath: string;
  setLocalFolderPath: React.Dispatch<React.SetStateAction<string>>;
  snap: SimpStateSnapshot | null;
  allLocalAlbums: AlbumRecord[];
  allLocalTracks: TrackMetadata[];
  mountAlbums: AlbumRecord[];
  mountTracks: TrackMetadata[];
  localVideos: TrackMetadata[];
  localDiscover: LocalDiscoverResponse;
  facetsSummary: LocalFacetsSummary;
  localGenreFilter: string;
  setLocalGenreFilter: React.Dispatch<React.SetStateAction<string>>;
  localYearFilter: string;
  setLocalYearFilter: React.Dispatch<React.SetStateAction<string>>;
  localArtworkFilter: LocalArtworkFilter;
  setLocalArtworkFilter: React.Dispatch<React.SetStateAction<LocalArtworkFilter>>;
  localLyricsFilter: LocalLyricsFilter;
  setLocalLyricsFilter: React.Dispatch<React.SetStateAction<LocalLyricsFilter>>;
  localAlpha: AlphaBucket;
  setLocalAlpha: React.Dispatch<React.SetStateAction<AlphaBucket>>;
  mediaTypeFilter: 'all' | 'video' | 'audio';
  onOpenFilters?: () => void;
  onPlayLocalSmartStation: (st: LocalSmartStation, shuffle?: boolean) => void;
  pushCurrentNavState: () => void;
  setPlayingContextId: (ctxId: string) => void;
  setView: (view: 'lock' | 'browser') => void;
  handleAddTracksToPlaylist: (
    uris: string[],
    label: string,
    tracks?: TrackMetadata[]
  ) => Promise<void>;
  renderSimpAlbumCard: (alb: AlbumRecord) => React.ReactNode;
  renderLocalArtistCard: (
    artistName: string,
    artUrl?: string | null,
    subtitle?: string
  ) => React.ReactNode;
  renderSingleSongRow: (
    s: TrackMetadata,
    peerList: TrackMetadata[],
    ctxPrefix: string,
    compact?: boolean
  ) => React.ReactNode;
  openLibraryContextMenu: (target: any) => void;
}

export const LocalDiscoverPane: React.FC<LocalDiscoverPaneProps> = ({
  browseHubTarget,
  localSubTab,
  setLocalSubTab,
  activeMountRoot,
  setActiveMountRoot,
  localFolderPath,
  setLocalFolderPath,
  snap,
  allLocalAlbums,
  allLocalTracks,
  mountAlbums,
  mountTracks,
  localVideos,
  localDiscover,
  facetsSummary,
  localGenreFilter,
  setLocalGenreFilter,
  localYearFilter,
  setLocalYearFilter,
  localArtworkFilter,
  setLocalArtworkFilter,
  localLyricsFilter,
  setLocalLyricsFilter,
  localAlpha,
  setLocalAlpha,
  mediaTypeFilter,
  onOpenFilters,
  onPlayLocalSmartStation,
  pushCurrentNavState,
  setPlayingContextId,
  setView,
  handleAddTracksToPlaylist,
  renderSimpAlbumCard,
  renderLocalArtistCard,
  renderSingleSongRow,
  openLibraryContextMenu,
}) => {
  const { syncedUris, allLyricsUris } = useLibraryLyricsStatus();
  const effectiveSubTab: LocalSubTab = localSubTab;

  const [visibleAlbumsCount, setVisibleAlbumsCount] = useState<number>(180);
  const [visibleArtistsCount, setVisibleArtistsCount] = useState<number>(180);
  const [artistGroupingMode, setArtistGroupingMode] = useState<
    'album_artists' | 'all_track_artists'
  >('album_artists');

  useEffect(() => {
    setVisibleAlbumsCount(180);
    setVisibleArtistsCount(180);
  }, [
    localAlpha,
    localGenreFilter,
    localYearFilter,
    localArtworkFilter,
    localLyricsFilter,
    effectiveSubTab,
    mediaTypeFilter,
    artistGroupingMode,
  ]);

  const hasRichFilter =
    localGenreFilter !== 'all' ||
    localYearFilter !== 'all' ||
    localArtworkFilter !== 'all' ||
    localLyricsFilter !== 'all';

  const hasAnyFilter = hasRichFilter || localAlpha !== 'all' || mediaTypeFilter !== 'all';

  const clearRichFilters = () => {
    setLocalGenreFilter('all');
    setLocalYearFilter('all');
    setLocalArtworkFilter('all');
    setLocalLyricsFilter('all');
    setLocalAlpha('all');
  };

  const trackMatchesFilters = useMemo(() => {
    return (t: TrackMetadata): boolean => {
      const isVid = isUiVideoTrack(t);
      if (mediaTypeFilter === 'video' && !isVid) return false;
      if (mediaTypeFilter === 'audio' && isVid) return false;
      if (localGenreFilter !== 'all') {
        if ((t.genre || '').trim().toLowerCase() !== localGenreFilter.toLowerCase()) {
          return false;
        }
      }
      if (localYearFilter !== 'all') {
        if (localYearFilter === 'unknown') {
          if (t.release_year != null) return false;
        } else if (/^\d{4}s$/.test(localYearFilter)) {
          if (decadeFromYear(t.release_year) !== localYearFilter) return false;
        } else if (String(t.release_year || '') !== localYearFilter) {
          return false;
        }
      }
      if (localArtworkFilter === 'has_art') {
        if (!t.art_url || !t.art_url.trim()) return false;
      } else if (localArtworkFilter === 'missing_art') {
        if (t.art_url && t.art_url.trim()) return false;
      }
      if (localLyricsFilter === 'synced') {
        if (!syncedUris.has(t.uri)) return false;
      } else if (localLyricsFilter === 'has_lyrics') {
        if (!allLyricsUris.has(t.uri)) return false;
      } else if (localLyricsFilter === 'missing_lyrics') {
        if (allLyricsUris.has(t.uri)) return false;
      }
      return true;
    };
  }, [
    mediaTypeFilter,
    localGenreFilter,
    localYearFilter,
    localArtworkFilter,
    localLyricsFilter,
    syncedUris,
    allLyricsUris,
  ]);

  const scopedLocalTracks = useMemo(() => {
    if (!activeMountRoot) return allLocalTracks;
    if (mountTracks.length > 0) return mountTracks;
    return allLocalTracks.filter((t) => t.mount_root === activeMountRoot);
  }, [activeMountRoot, mountTracks, allLocalTracks]);

  const scopedLocalAlbums = useMemo(() => {
    if (!activeMountRoot) return allLocalAlbums;
    if (mountAlbums.length > 0) return mountAlbums;
    const albumIdSet = new Set<string>();
    for (const t of scopedLocalTracks) {
      if (t.album_id) albumIdSet.add(t.album_id);
    }
    return allLocalAlbums.filter((a) => albumIdSet.has(a.id));
  }, [activeMountRoot, mountAlbums, allLocalAlbums, scopedLocalTracks]);

  const scopedLocalVideos = useMemo(() => {
    if (!activeMountRoot) return localVideos;
    return localVideos.filter((v) => v.mount_root === activeMountRoot);
  }, [activeMountRoot, localVideos]);

  const activeFacetsSummary = useMemo(() => {
    if (!activeMountRoot) return facetsSummary;
    return computeLocalFacetsSummary(
      scopedLocalAlbums,
      scopedLocalTracks,
      syncedUris,
      allLyricsUris
    );
  }, [activeMountRoot, facetsSummary, scopedLocalAlbums, scopedLocalTracks, syncedUris, allLyricsUris]);

  const scopedAlbumIdSet = useMemo(
    () => new Set(scopedLocalAlbums.map((a) => a.id)),
    [scopedLocalAlbums]
  );

  const overviewRecentAlbums = useMemo(() => {
    if (!activeMountRoot) return localDiscover.recent_albums;
    const filtered = localDiscover.recent_albums.filter((a) => scopedAlbumIdSet.has(a.id));
    return filtered.length > 0 ? filtered : scopedLocalAlbums.slice(0, 16);
  }, [activeMountRoot, localDiscover.recent_albums, scopedAlbumIdSet, scopedLocalAlbums]);

  const overviewRediscoverAlbums = useMemo(() => {
    if (!activeMountRoot) return localDiscover.rediscover_albums;
    return localDiscover.rediscover_albums.filter((a) => scopedAlbumIdSet.has(a.id));
  }, [activeMountRoot, localDiscover.rediscover_albums, scopedAlbumIdSet]);

  const tracksByAlbumId = useMemo(() => {
    const map = new Map<string, TrackMetadata[]>();
    for (const t of scopedLocalTracks) {
      if (!t.album_id) continue;
      const list = map.get(t.album_id);
      if (list) list.push(t);
      else map.set(t.album_id, [t]);
    }
    return map;
  }, [scopedLocalTracks]);

  const filteredAlbumsList = useMemo(() => {
    return scopedLocalAlbums.filter((alb) => {
      if (mediaTypeFilter === 'video') return false;
      if (localAlpha !== 'all' && !matchesAlphaBucket(alb.title, localAlpha)) return false;
      const albTracks = tracksByAlbumId.get(alb.id) || [];
      if (hasRichFilter && albTracks.length > 0) {
        return albTracks.some(trackMatchesFilters);
      }
      if (localGenreFilter !== 'all') {
        if ((alb.genre || '').trim().toLowerCase() !== localGenreFilter.toLowerCase()) {
          return false;
        }
      }
      if (localYearFilter !== 'all') {
        if (localYearFilter === 'unknown') {
          if (alb.release_year != null) return false;
        } else if (/^\d{4}s$/.test(localYearFilter)) {
          if (decadeFromYear(alb.release_year) !== localYearFilter) return false;
        } else if (String(alb.release_year || '') !== localYearFilter) {
          return false;
        }
      }
      if (localArtworkFilter === 'has_art' && (!alb.art_url || !alb.art_url.trim())) {
        return false;
      }
      if (localArtworkFilter === 'missing_art' && alb.art_url && alb.art_url.trim()) {
        return false;
      }
      if (localLyricsFilter !== 'all') return false;
      return true;
    });
  }, [
    scopedLocalAlbums,
    mediaTypeFilter,
    localAlpha,
    tracksByAlbumId,
    hasRichFilter,
    trackMatchesFilters,
    localGenreFilter,
    localYearFilter,
    localArtworkFilter,
    localLyricsFilter,
  ]);

  const filteredTracksList = useMemo(
    () => scopedLocalTracks.filter(trackMatchesFilters),
    [scopedLocalTracks, trackMatchesFilters]
  );

  const albumArtistById = useMemo(() => {
    const map = new Map<string, string>();
    for (const alb of scopedLocalAlbums) {
      const clean = cleanAlbumArtistDisplay(alb.album_artist).trim();
      if (clean && !GENERIC_ALBUM_ARTISTS.has(clean.toLowerCase())) {
        map.set(alb.id, clean);
      }
    }
    return map;
  }, [scopedLocalAlbums]);

  const filteredArtistsList = useMemo(() => {
    const baseList =
      artistGroupingMode === 'album_artists'
        ? activeFacetsSummary.albumArtists
        : activeFacetsSummary.allTrackArtists;
    if (!hasRichFilter && localAlpha === 'all') {
      return baseList;
    }
    const matchingArtistKeys = new Set<string>();
    for (const t of filteredTracksList) {
      if (artistGroupingMode === 'album_artists' && t.album_id) {
        const albArtist = albumArtistById.get(t.album_id);
        if (albArtist) matchingArtistKeys.add(albArtist.toLowerCase());
      }
      for (const a of t.artists || []) {
        const k = a.trim().toLowerCase();
        if (k) matchingArtistKeys.add(k);
      }
    }
    for (const alb of filteredAlbumsList) {
      const k = cleanAlbumArtistDisplay(alb.album_artist).trim().toLowerCase();
      if (k) matchingArtistKeys.add(k);
    }
    return baseList.filter((art) => {
      if (localAlpha !== 'all' && !matchesAlphaBucket(art.name, localAlpha)) return false;
      if (hasRichFilter && !matchingArtistKeys.has(art.name.toLowerCase())) return false;
      return true;
    });
  }, [
    artistGroupingMode,
    hasRichFilter,
    localAlpha,
    activeFacetsSummary.albumArtists,
    activeFacetsSummary.allTrackArtists,
    filteredTracksList,
    filteredAlbumsList,
    albumArtistById,
  ]);

  // Folder / Mount Drill-Down computation
  const mountsList = snap?.mounts || [];
  const effectiveMount =
    (activeMountRoot
      ? mountsList.find((m) => m.mount_root === activeMountRoot) || {
          mount_root: activeMountRoot,
          label:
            activeMountRoot.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || activeMountRoot,
          mount_kind: 'user_custom',
          is_online: true,
          track_count: 0,
          last_scanned_at: 0,
        }
      : null) || (mountsList.length === 1 ? mountsList[0] : null);

  const folderDrillData = useMemo(
    () =>
      buildLocalFolderDrillData({
        mountRoot: effectiveMount?.mount_root,
        allLocalTracks,
        mountTracks,
        localFolderPath,
        filteredAlbumsList,
        trackFilter: trackMatchesFilters,
      }),
    [
      effectiveMount?.mount_root,
      allLocalTracks,
      mountTracks,
      trackMatchesFilters,
      localFolderPath,
      filteredAlbumsList,
    ]
  );

  const filterSummaryParts: string[] = [];
  if (localGenreFilter !== 'all') filterSummaryParts.push(localGenreFilter);
  if (localYearFilter !== 'all') filterSummaryParts.push(localYearFilter);
  if (localArtworkFilter === 'has_art') filterSummaryParts.push('Has Art');
  if (localArtworkFilter === 'missing_art') filterSummaryParts.push('Missing Art');
  if (localLyricsFilter === 'synced') filterSummaryParts.push('Synced LRC');
  if (localLyricsFilter === 'has_lyrics') filterSummaryParts.push('Any Lyrics');
  if (localLyricsFilter === 'missing_lyrics') filterSummaryParts.push('Missing Lyrics');
  if (localAlpha !== 'all') filterSummaryParts.push(localAlpha.toUpperCase());
  if (mediaTypeFilter !== 'all') filterSummaryParts.push(mediaTypeFilter);

  const scopedMountTitle = activeMountRoot && effectiveMount ? effectiveMount.label : null;
  const hubTitle =
    effectiveSubTab === 'artists'
      ? scopedMountTitle
        ? `${scopedMountTitle} — Artists (${filteredArtistsList.length})`
        : `Local Artists (${filteredArtistsList.length})`
      : effectiveSubTab === 'albums'
      ? scopedMountTitle
        ? `${scopedMountTitle} — Albums (${filteredAlbumsList.length})`
        : `Local Albums (${filteredAlbumsList.length})`
      : effectiveSubTab === 'folders'
      ? effectiveMount
        ? `${effectiveMount.label}${folderDrillData.curPrefix ? ` / ${folderDrillData.curPrefix}` : ''}`
        : 'Local Folders'
      : effectiveSubTab === 'videos'
      ? scopedMountTitle
        ? `${scopedMountTitle} — Videos (${scopedLocalVideos.length})`
        : `Local Videos (${scopedLocalVideos.length})`
      : scopedMountTitle
      ? scopedMountTitle
      : 'Local Music & Storage';

  const switchLocalTab = (tab: LocalSubTab) => {
    pushCurrentNavState();
    setLocalSubTab(tab);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
      {/* Top Emerald Header + Quick Sub-Tabs + Filter Trigger */}
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          paddingBottom: 10,
          borderBottom: '1px solid #143328',
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
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <ImpIcon name="local" size={16} color="#6ee7b7" />
            <span
              style={{
                fontSize: 15,
                fontWeight: 800,
                color: '#6ee7b7',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              💾 {hubTitle}
            </span>
          </div>
          <FilterTriggerButton
            summary={filterSummaryParts.length > 0 ? filterSummaryParts.join(' • ') : 'All'}
            active={hasAnyFilter}
            accentColor="#34d399"
            activeBg="#0b241c"
            activeText="#6ee7b7"
            onClick={onOpenFilters}
          />
        </div>

        {/* Sub-tab Strip & Active Filter Clear Pills */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {(
            [
              { id: 'overview', label: '⚡ Overview' },
              { id: 'artists', label: `🎤 Artists (${activeFacetsSummary.artists.length})` },
              { id: 'albums', label: `💿 Albums (${scopedLocalAlbums.length})` },
              { id: 'folders', label: `📂 Folders (${mountsList.length})` },
              ...(scopedLocalVideos.length > 0 && mediaTypeFilter !== 'audio'
                ? [{ id: 'videos' as const, label: `🎬 Videos (${scopedLocalVideos.length})` }]
                : []),
            ] as const
          ).map((t) => {
            const active = effectiveSubTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                data-right-filter-pill="true"
                onClick={() => switchLocalTab(t.id)}
                style={{
                  padding: '5px 11px',
                  borderRadius: 8,
                  background: active ? '#0b241c' : '#0b0e12',
                  border: active ? '1px solid #34d399' : '1px solid #1b2a24',
                  color: active ? '#6ee7b7' : '#9ca3af',
                  fontSize: 11,
                  fontWeight: active ? 800 : 700,
                  cursor: 'pointer',
                }}
              >
                {t.label}
              </button>
            );
          })}

          {hasAnyFilter && (
            <button
              type="button"
              data-right-filter-pill="true"
              onClick={clearRichFilters}
              style={{
                padding: '5px 10px',
                borderRadius: 8,
                background: '#221216',
                border: '1px solid #7f1d1d',
                color: '#fca5a5',
                fontSize: 11,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              ✕ Clear Filters
            </button>
          )}
        </div>

        {/* Mount Scope Selector Strip (persists across tabs when scoped to a folder container or browsing Folders) */}
        {mountsList.length > 1 && (effectiveSubTab === 'folders' || Boolean(activeMountRoot)) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              data-right-filter-pill="true"
              onClick={() => {
                pushCurrentNavState();
                setActiveMountRoot(null);
                setLocalFolderPath('');
              }}
              style={{
                padding: '5px 10px',
                borderRadius: 7,
                background: !activeMountRoot ? '#0b241c' : '#0b0e12',
                border: !activeMountRoot ? '1px solid #34d399' : '1px solid #1b2a24',
                color: !activeMountRoot ? '#6ee7b7' : '#9ca3af',
                fontSize: 11,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              All Folders ({mountsList.length})
            </button>
            {mountsList.map((m) => {
              const isActive = effectiveMount?.mount_root === m.mount_root;
              return (
                <button
                  key={m.mount_root}
                  type="button"
                  data-right-filter-pill="true"
                  onClick={() => {
                    pushCurrentNavState();
                    setActiveMountRoot(m.mount_root);
                    setLocalFolderPath('');
                  }}
                  style={{
                    padding: '5px 10px',
                    borderRadius: 7,
                    background: isActive ? '#0b241c' : '#0b0e12',
                    border: isActive ? '1px solid #34d399' : '1px solid #1b2a24',
                    color: isActive ? '#6ee7b7' : '#9ca3af',
                    fontSize: 11,
                    fontWeight: 800,
                    cursor: 'pointer',
                    opacity: m.is_online ? 1 : 0.65,
                  }}
                >
                  💾 {m.label}
                  {!m.is_online ? ' (Offline)' : ''} ({m.track_count})
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* ===================================================================
          TAB 1: ⚡ LOCAL OVERVIEW (Genres, Eras, Health, Smart Stations, Shelves)
         =================================================================== */}
      {effectiveSubTab === 'overview' && (
        <>
          {hasRichFilter && (
            <section
              data-section-anchor="local_filtered_preview"
              style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
            >
              <CollapsibleSectionHeader
                sectionKey="local:filtered_preview"
                accentColor="#34d399"
                title={`⚲ FILTERED LOCAL MATCHES (${filteredAlbumsList.length} albums • ${filteredTracksList.length} tracks)`}
              />
              {filteredAlbumsList.length > 0 && (
                <div style={tileGridStyle}>
                  {filteredAlbumsList.slice(0, 24).map(renderSimpAlbumCard)}
                </div>
              )}
              {filteredTracksList.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {filteredTracksList.slice(0, 50).map((t) =>
                    renderSingleSongRow(t, filteredTracksList, 'local_overview_filtered')
                  )}
                </div>
              )}
            </section>
          )}

          {/* Local Smart Stations */}
          {localDiscover.smart_stations.length > 0 && mediaTypeFilter !== 'video' && (
            <section
              data-section-anchor="local_smart_stations"
              style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
            >
              <PinnableSectionHeader
                title={`📻 LOCAL SMART STATIONS (${localDiscover.smart_stations.length})`}
                accentColor="#34d399"
                descriptor={DEFAULT_STARTER_FYP_DESCRIPTORS[0]}
                liveItems={localDiscover.smart_stations}
              />
              <HorizontalShelfRail variant="tiles" itemCount={localDiscover.smart_stations.length}>
                {localDiscover.smart_stations.map((st) => (
                  <CollectionTileCard
                    key={st.id}
                    tileKey={`local_station:${st.id}`}
                    selectedBg="#0f2d23"
                    selectedBorder="1px solid #34d399"
                    title={st.title}
                    subtitle={`${st.track_count} tracks • ${st.subtitle}`}
                    artwork={
                      st.art_url ? (
                        <img
                          src={st.art_url}
                          alt=""
                          loading="lazy"
                          style={{
                            width: '100%',
                            height: '100%',
                            aspectRatio: '1 / 1',
                            borderRadius: 7,
                            objectFit: 'cover',
                            display: 'block',
                          }}
                        />
                      ) : (
                        <div
                          style={{
                            width: '100%',
                            height: '100%',
                            aspectRatio: '1 / 1',
                            borderRadius: 7,
                            background: '#0f2d23',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          <ImpIcon name="music" size={28} color="#6ee7b7" />
                        </div>
                      )
                    }
                    badge="Mix"
                    badgeStyle={{ color: '#6ee7b7' }}
                    onSelect={() => onPlayLocalSmartStation(st, false)}
                    onOpenContextMenu={() =>
                      openLibraryContextMenu({
                        type: 'collection',
                        kind: 'local_station',
                        id: st.id,
                        title: st.title,
                        subtitle: `${st.track_count} tracks • ${st.subtitle}`,
                        art_url: st.art_url,
                        source: 'local',
                        rawItem: st,
                      })
                    }
                  />
                ))}
              </HorizontalShelfRail>
            </section>
          )}

          {/* Browse by Genre */}
          {activeFacetsSummary.genres.length > 0 && (
            <section
              data-section-anchor="local_genres"
              style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
            >
              <CollapsibleSectionHeader
                sectionKey="local:genres"
                accentColor="#34d399"
                title={`🎸 BROWSE BY GENRE (${activeFacetsSummary.genres.length})`}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {activeFacetsSummary.genres.map((g) => (
                  <button
                    key={g.genre}
                    type="button"
                    data-right-tile="true"
                    data-tile-key={`local_genre:${g.genre}`}
                    onClick={() => {
                      pushCurrentNavState();
                      setLocalGenreFilter(g.genre);
                      setLocalSubTab('albums');
                    }}
                    style={{
                      padding: '8px 13px',
                      borderRadius: 10,
                      background:
                        localGenreFilter.toLowerCase() === g.genre.toLowerCase()
                          ? '#0b241c'
                          : '#0b1015',
                      border:
                        localGenreFilter.toLowerCase() === g.genre.toLowerCase()
                          ? '1px solid #34d399'
                          : '1px solid #1b2a24',
                      color: '#d1fae5',
                      fontSize: 11.5,
                      fontWeight: 800,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                    }}
                  >
                    <span>{g.genre}</span>
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: 'monospace',
                        color: '#6ee7b7',
                        background: 'rgba(16, 185, 129, 0.14)',
                        padding: '1px 6px',
                        borderRadius: 99,
                      }}
                    >
                      {g.count}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Browse by Era / Decade */}
          {activeFacetsSummary.eras.length > 0 && (
            <section
              data-section-anchor="local_eras"
              style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
            >
              <CollapsibleSectionHeader
                sectionKey="local:eras"
                accentColor="#34d399"
                title={`📅 BROWSE BY DECADE & YEAR`}
              />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {activeFacetsSummary.eras.map((era) => (
                  <button
                    key={era.id}
                    type="button"
                    data-right-tile="true"
                    data-tile-key={`local_era:${era.id}`}
                    onClick={() => {
                      pushCurrentNavState();
                      setLocalYearFilter(era.id);
                      setLocalSubTab('albums');
                    }}
                    style={{
                      padding: '8px 13px',
                      borderRadius: 10,
                      background: localYearFilter === era.id ? '#0b241c' : '#0b1015',
                      border:
                        localYearFilter === era.id ? '1px solid #34d399' : '1px solid #1b2a24',
                      color: '#a7f3d0',
                      fontSize: 11.5,
                      fontWeight: 800,
                      cursor: 'pointer',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 7,
                    }}
                  >
                    <span>{era.label}</span>
                    <span
                      style={{
                        fontSize: 10,
                        fontFamily: 'monospace',
                        color: '#6ee7b7',
                        background: 'rgba(16, 185, 129, 0.14)',
                        padding: '1px 6px',
                        borderRadius: 99,
                      }}
                    >
                      {era.count}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Metadata & Curation Health */}
          <section
            data-section-anchor="local_health"
            style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
          >
            <CollapsibleSectionHeader
              sectionKey="local:health"
              accentColor="#34d399"
              title="🩺 METADATA & CURATION HEALTH (CLICK TO INSPECT)"
            />
            <div style={tileGridStyle}>
              {[
                {
                  key: 'has_art',
                  title: '🖼️ Artwork Found',
                  count: activeFacetsSummary.artworkCounts.hasArt,
                  sub: 'Tracks with embedded or folder art',
                  accent: '#38bdf8',
                  onClick: () => {
                    pushCurrentNavState();
                    clearRichFilters();
                    setLocalArtworkFilter('has_art');
                    setLocalSubTab('albums');
                  },
                },
                {
                  key: 'missing_art',
                  title: '⚠️ Missing Artwork',
                  count: activeFacetsSummary.artworkCounts.missingArt,
                  sub: 'Tracks lacking cover art',
                  accent: '#facc15',
                  onClick: () => {
                    pushCurrentNavState();
                    clearRichFilters();
                    setLocalArtworkFilter('missing_art');
                    setLocalSubTab('albums');
                  },
                },
                {
                  key: 'synced_lrc',
                  title: '🎤 Synced Lyrics (LRC)',
                  count: activeFacetsSummary.lyricsCounts.synced,
                  sub: 'Karaoke-ready timed lyrics',
                  accent: '#34d399',
                  onClick: () => {
                    pushCurrentNavState();
                    clearRichFilters();
                    setLocalLyricsFilter('synced');
                    setLocalSubTab('albums');
                  },
                },
                {
                  key: 'missing_lyrics',
                  title: '📝 Missing Lyrics',
                  count: activeFacetsSummary.lyricsCounts.missing,
                  sub: 'Tracks without indexed lyrics yet',
                  accent: '#94a3b8',
                  onClick: () => {
                    pushCurrentNavState();
                    clearRichFilters();
                    setLocalLyricsFilter('missing_lyrics');
                    setLocalSubTab('albums');
                  },
                },
              ].map((card) => (
                <button
                  key={card.key}
                  type="button"
                  data-right-tile="true"
                  data-tile-key={`local_health:${card.key}`}
                  onClick={card.onClick}
                  style={{
                    borderRadius: 12,
                    background: '#0b1016',
                    border: '1px solid #1e293b',
                    padding: 12,
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'flex-start',
                    gap: 4,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 800, color: card.accent }}>
                    {card.title}
                  </div>
                  <div style={{ fontSize: 20, fontWeight: 900, fontFamily: 'monospace', color: '#f8fafc' }}>
                    {card.count}
                  </div>
                  <div style={{ fontSize: 10.5, color: '#94a3b8' }}>{card.sub}</div>
                </button>
              ))}
            </div>
          </section>

          {/* Recently Added Local Releases */}
          {overviewRecentAlbums.length > 0 && mediaTypeFilter !== 'video' && (
            <section
              data-section-anchor="local_recent_releases"
              style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
            >
              <PinnableSectionHeader
                title={`🆕 RECENTLY ADDED LOCAL RELEASES (${overviewRecentAlbums.length})`}
                accentColor="#34d399"
                descriptor={DEFAULT_STARTER_FYP_DESCRIPTORS[2]}
                liveItems={overviewRecentAlbums}
              />
              <HorizontalShelfRail variant="tiles" itemCount={overviewRecentAlbums.length}>
                {overviewRecentAlbums.map(renderSimpAlbumCard)}
              </HorizontalShelfRail>
            </section>
          )}

          {/* Rediscover Local Gems */}
          {overviewRediscoverAlbums.length > 0 && mediaTypeFilter !== 'video' && (
            <section
              data-section-anchor="local_rediscover"
              style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
            >
              <PinnableSectionHeader
                title={`✨ REDISCOVER LOCAL GEMS (${overviewRediscoverAlbums.length})`}
                accentColor="#34d399"
                descriptor={DEFAULT_STARTER_FYP_DESCRIPTORS[1]}
                liveItems={overviewRediscoverAlbums}
              />
              <HorizontalShelfRail variant="tiles" itemCount={overviewRediscoverAlbums.length}>
                {overviewRediscoverAlbums.map(renderSimpAlbumCard)}
              </HorizontalShelfRail>
            </section>
          )}
        </>
      )}

      {/* ===================================================================
          TAB 2: 🎤 ARTISTS
         =================================================================== */}
      {effectiveSubTab === 'artists' && (
        <section
          data-section-anchor="local_artists_grid"
          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            {(
              [
                {
                  id: 'album_artists' as const,
                  label: `Album Artists (${activeFacetsSummary.albumArtists.length})`,
                },
                {
                  id: 'all_track_artists' as const,
                  label: `All Track Artists (${activeFacetsSummary.allTrackArtists.length})`,
                },
              ] as const
            ).map((mode) => {
              const active = artistGroupingMode === mode.id;
              return (
                <button
                  key={mode.id}
                  type="button"
                  data-right-filter-pill="true"
                  onClick={() => setArtistGroupingMode(mode.id)}
                  style={{
                    padding: '4px 10px',
                    borderRadius: 999,
                    background: active ? '#0b241c' : '#0b0e12',
                    border: active ? '1px solid #34d399' : '1px solid #1b2a24',
                    color: active ? '#6ee7b7' : '#9ca3af',
                    fontSize: 11,
                    fontWeight: active ? 800 : 700,
                    cursor: 'pointer',
                  }}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>

          {filteredArtistsList.length > 0 ? (
            <>
              <div style={tileGridStyle}>
                {filteredArtistsList
                  .slice(0, visibleArtistsCount)
                  .map((a) =>
                    renderLocalArtistCard(
                      a.name,
                      a.artUrl,
                      `${a.albumCount} albums • ${a.trackCount} tracks`
                    )
                  )}
              </div>
              {filteredArtistsList.length > visibleArtistsCount && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 10,
                    paddingTop: 6,
                    flexWrap: 'wrap',
                  }}
                >
                  <button
                    type="button"
                    data-right-tile="true"
                    data-tile-key="local_artists_load_more"
                    onClick={() => setVisibleArtistsCount((prev) => prev + 240)}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 10,
                      border: '1px solid #10b981',
                      background: 'rgba(16, 185, 129, 0.14)',
                      color: '#6ee7b7',
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Load 240 More (showing {visibleArtistsCount} of {filteredArtistsList.length})
                  </button>
                  <button
                    type="button"
                    data-right-tile="true"
                    data-tile-key="local_artists_show_all"
                    onClick={() => setVisibleArtistsCount(filteredArtistsList.length)}
                    style={{
                      padding: '8px 14px',
                      borderRadius: 10,
                      border: '1px solid #262936',
                      background: '#11151d',
                      color: '#cbd5e1',
                      fontSize: 12,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    Show All ({filteredArtistsList.length})
                  </button>
                </div>
              )}
            </>
          ) : (
            <div style={{ padding: 24, textAlign: 'center', color: '#8e8e99', fontSize: 13 }}>
              No local artists match the active filters.
            </div>
          )}
        </section>
      )}

      {/* ===================================================================
          TAB 3: 💿 ALBUMS (Full Local Collection + Matching Tracks Drawer)
         =================================================================== */}
      {effectiveSubTab === 'albums' && (
        <>
          <section
            data-section-anchor="local_albums_grid"
            style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
          >
            {filteredAlbumsList.length > 0 ? (
              <>
                <div style={tileGridStyle}>
                  {filteredAlbumsList.slice(0, visibleAlbumsCount).map(renderSimpAlbumCard)}
                </div>
                {filteredAlbumsList.length > visibleAlbumsCount && (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 10,
                      paddingTop: 6,
                      flexWrap: 'wrap',
                    }}
                  >
                    <button
                      type="button"
                      data-right-tile="true"
                      data-tile-key="local_albums_load_more"
                      onClick={() => setVisibleAlbumsCount((prev) => prev + 240)}
                      style={{
                        padding: '8px 16px',
                        borderRadius: 10,
                        border: '1px solid #10b981',
                        background: 'rgba(16, 185, 129, 0.14)',
                        color: '#6ee7b7',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Load 240 More (showing {visibleAlbumsCount} of {filteredAlbumsList.length})
                    </button>
                    <button
                      type="button"
                      data-right-tile="true"
                      data-tile-key="local_albums_show_all"
                      onClick={() => setVisibleAlbumsCount(filteredAlbumsList.length)}
                      style={{
                        padding: '8px 14px',
                        borderRadius: 10,
                        border: '1px solid #262936',
                        background: '#11151d',
                        color: '#cbd5e1',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                      }}
                    >
                      Show All ({filteredAlbumsList.length})
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div style={{ padding: 20, textAlign: 'center', color: '#8e8e99', fontSize: 13 }}>
                No local albums match the current filters.
              </div>
            )}
          </section>

          {hasRichFilter && filteredTracksList.length > 0 && (
            <section
              data-section-anchor="local_matching_tracks"
              style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
            >
              <CollapsibleSectionHeader
                sectionKey="local:matching_tracks"
                accentColor="#34d399"
                title={`🎵 MATCHING LOCAL TRACKS (${filteredTracksList.length})`}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {filteredTracksList.slice(0, 150).map((t) =>
                  renderSingleSongRow(t, filteredTracksList, 'local_albums_matching')
                )}
              </div>
            </section>
          )}
        </>
      )}

      {/* ===================================================================
          TAB 4: 📂 MOUNTS & INTERACTIVE SUBFOLDER DRILL-DOWN
         =================================================================== */}
      {effectiveSubTab === 'folders' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
          {!effectiveMount ? (
            mountsList.length > 0 ? (
              <div style={tileGridStyle}>
                {mountsList.map((m) => (
                  <button
                    key={m.mount_root}
                    type="button"
                    data-right-tile="true"
                    data-tile-key={`local_mount:${m.mount_root}`}
                    onClick={() => {
                      pushCurrentNavState();
                      setActiveMountRoot(m.mount_root);
                      setLocalFolderPath('');
                    }}
                    style={{
                      borderRadius: 12,
                      background: '#081712',
                      border: '1px solid #143328',
                      padding: 14,
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-start',
                      gap: 5,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <div style={{ fontSize: 13.5, fontWeight: 800, color: '#6ee7b7' }}>
                      💾 {m.label}
                    </div>
                    <div
                      style={{
                        fontSize: 10,
                        fontFamily: 'monospace',
                        color: '#94a3b8',
                        wordBreak: 'break-all',
                      }}
                    >
                      {m.mount_root}
                    </div>
                    <div style={{ fontSize: 11, color: '#a7f3d0', marginTop: 2 }}>
                      {m.track_count} tracks{!m.is_online ? ' • Offline' : ''}
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div style={{ padding: 24, textAlign: 'center', color: '#8e8e99', fontSize: 13 }}>
                No local storage folders configured. Add a music folder in Settings!
              </div>
            )
          ) : (
            <>
              {/* Interactive Breadcrumb + Folder Actions */}
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  gap: 8,
                  padding: '8px 12px',
                  borderRadius: 10,
                  background: '#081510',
                  border: '1px solid #143328',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {folderDrillData.breadcrumbs.length > 0 && (
                    <button
                      type="button"
                      data-right-filter-pill="true"
                      onClick={() => {
                        pushCurrentNavState();
                        const nextSegs = folderDrillData.breadcrumbs.slice(0, -1);
                        setLocalFolderPath(nextSegs.join('/'));
                      }}
                      style={{
                        padding: '3px 8px',
                        borderRadius: 6,
                        background: '#112a20',
                        border: '1px solid #235743',
                        color: '#6ee7b7',
                        fontSize: 11,
                        fontWeight: 800,
                        cursor: 'pointer',
                      }}
                    >
                      ↑ Up
                    </button>
                  )}
                  <button
                    type="button"
                    data-right-filter-pill="true"
                    onClick={() => {
                      pushCurrentNavState();
                      setLocalFolderPath('');
                    }}
                    style={{
                      padding: '3px 8px',
                      borderRadius: 6,
                      background: folderDrillData.breadcrumbs.length === 0 ? '#0b241c' : '#0d1117',
                      border:
                        folderDrillData.breadcrumbs.length === 0
                          ? '1px solid #34d399'
                          : '1px solid #1e293b',
                      color: '#6ee7b7',
                      fontSize: 11,
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    💾 {effectiveMount.label}
                  </button>
                  {folderDrillData.breadcrumbs.map((seg, idx) => {
                    const targetPath = folderDrillData.breadcrumbs.slice(0, idx + 1).join('/');
                    const isLast = idx === folderDrillData.breadcrumbs.length - 1;
                    return (
                      <React.Fragment key={targetPath}>
                        <span style={{ color: '#475569', fontFamily: 'monospace' }}>/</span>
                        <button
                          type="button"
                          data-right-filter-pill="true"
                          onClick={() => {
                            pushCurrentNavState();
                            setLocalFolderPath(targetPath);
                          }}
                          style={{
                            padding: '3px 8px',
                            borderRadius: 6,
                            background: isLast ? '#0b241c' : '#0d1117',
                            border: isLast ? '1px solid #34d399' : '1px solid #1e293b',
                            color: isLast ? '#a7f3d0' : '#cbd5e1',
                            fontSize: 11,
                            fontWeight: isLast ? 800 : 600,
                            cursor: 'pointer',
                          }}
                        >
                          📂 {seg}
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>

                {folderDrillData.subtreeTracks.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button
                      type="button"
                      data-right-tile="true"
                      onClick={() => {
                        const audioOnly = folderDrillData.subtreeTracks.filter(
                          (t) => !isUiVideoTrack(t)
                        );
                        const playable =
                          audioOnly.length > 0 ? audioOnly : folderDrillData.subtreeTracks;
                        setPlayingContextId(
                          `mount:${effectiveMount.mount_root}:${folderDrillData.curPrefix || '/'}`
                        );
                        defaultSimpClient.loadQueue(
                          playable.map((t) => t.uri),
                          0,
                          playable
                        );
                        setView('lock');
                      }}
                      style={{
                        minHeight: 32,
                        padding: '0 10px',
                        borderRadius: 8,
                        background: '#0b241c',
                        border: '1px solid #34d399',
                        color: '#6ee7b7',
                        fontSize: 11,
                        fontWeight: 800,
                        cursor: 'pointer',
                      }}
                    >
                      ▶ Play Folder ({folderDrillData.subtreeTracks.length})
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const audioOnly = folderDrillData.subtreeTracks.filter(
                          (t) => !isUiVideoTrack(t)
                        );
                        const targets =
                          audioOnly.length > 0 ? audioOnly : folderDrillData.subtreeTracks;
                        handleAddTracksToPlaylist(
                          targets.map((t) => t.uri),
                          `${targets.length} tracks from ${
                            folderDrillData.curPrefix || effectiveMount.label
                          }`,
                          targets
                        );
                      }}
                      style={{
                        minHeight: 32,
                        padding: '0 10px',
                        borderRadius: 8,
                        background: '#12141e',
                        border: '1px solid #2a2a38',
                        color: 'var(--imp-accent-active-text, #f5e1be)',
                        fontSize: 11,
                        fontWeight: 800,
                        cursor: 'pointer',
                      }}
                    >
                      + All to ★
                    </button>
                  </div>
                )}
              </div>

              {/* Subfolder Cards */}
              {folderDrillData.subfolders.length > 0 && (
                <section
                  data-section-anchor="local_subfolders"
                  style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                >
                  <CollapsibleSectionHeader
                    sectionKey="local:subfolders"
                    accentColor="#34d399"
                    title={`📂 SUBFOLDERS (${folderDrillData.subfolders.length})`}
                  />
                  <div style={tileGridStyle}>
                    {folderDrillData.subfolders.map((sub) => (
                      <button
                        key={sub.fullRelPath}
                        type="button"
                        data-right-tile="true"
                        data-tile-key={`local_folder:${effectiveMount.mount_root}:${sub.fullRelPath}`}
                        onClick={() => {
                          pushCurrentNavState();
                          setLocalFolderPath(sub.fullRelPath);
                        }}
                        style={{
                          borderRadius: 12,
                          background: 'linear-gradient(155deg, #0b1c17 0%, #090c12 100%)',
                          border: '1px solid #16382c',
                          padding: 12,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 8,
                          cursor: 'pointer',
                          textAlign: 'left',
                          minWidth: 0,
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%' }}>
                          {sub.artUrls[0] ? (
                            <img
                              src={sub.artUrls[0]}
                              alt=""
                              loading="lazy"
                              style={{
                                width: 40,
                                height: 40,
                                borderRadius: 8,
                                objectFit: 'cover',
                                border: '1px solid #265947',
                                flexShrink: 0,
                              }}
                            />
                          ) : (
                            <div
                              style={{
                                width: 40,
                                height: 40,
                                borderRadius: 8,
                                background: '#0e2820',
                                border: '1px solid #265947',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                              }}
                            >
                              <ImpIcon name="folder" size={18} color="#6ee7b7" />
                            </div>
                          )}
                          <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                              style={{
                                fontSize: 12.5,
                                fontWeight: 800,
                                color: '#d1fae5',
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              📂 {sub.name}
                            </div>
                            <div style={{ fontSize: 10.5, color: '#6ee7b7', marginTop: 2 }}>
                              {sub.albumCount > 0 ? `${sub.albumCount} albums • ` : ''}
                              {sub.trackCount} tracks
                            </div>
                          </div>
                        </div>
                      </button>
                    ))}
                  </div>
                </section>
              )}

              {/* Albums directly inside this folder */}
              {folderDrillData.albumsHere.length > 0 && (
                <section
                  data-section-anchor="local_folder_albums"
                  style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                >
                  <CollapsibleSectionHeader
                    sectionKey="local:folder_albums"
                    accentColor="#34d399"
                    title={`💿 ALBUMS IN THIS FOLDER (${folderDrillData.albumsHere.length})`}
                  />
                  <div style={tileGridStyle}>
                    {folderDrillData.albumsHere.map(renderSimpAlbumCard)}
                  </div>
                </section>
              )}

              {/* Tracks directly inside this folder */}
              {folderDrillData.directTracks.length > 0 && (
                <section
                  data-section-anchor="local_folder_tracks"
                  style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                >
                  <CollapsibleSectionHeader
                    sectionKey="local:folder_tracks"
                    accentColor="#34d399"
                    title={`🎵 TRACKS IN THIS FOLDER (${folderDrillData.directTracks.length})`}
                  />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {folderDrillData.directTracks.map((t) =>
                      renderSingleSongRow(
                        t,
                        folderDrillData.directTracks,
                        `folder:${folderDrillData.curPrefix || 'root'}`
                      )
                    )}
                  </div>
                </section>
              )}

              {folderDrillData.subfolders.length === 0 &&
                folderDrillData.albumsHere.length === 0 &&
                folderDrillData.directTracks.length === 0 && (
                  <div
                    style={{
                      padding: 24,
                      textAlign: 'center',
                      color: effectiveMount && !effectiveMount.is_online ? '#fbbf24' : '#8e8e99',
                      fontSize: 13,
                    }}
                  >
                    {effectiveMount && !effectiveMount.is_online
                      ? `⚠️ Folder offline or unreachable (${effectiveMount.mount_root}) — verify the drive or network share is connected, then rescan.`
                      : 'No matching files indexed in this folder.'}
                  </div>
                )}
            </>
          )}
        </div>
      )}

      {/* ===================================================================
          TAB 5: 🎬 LOCAL VIDEOS
         =================================================================== */}
      {effectiveSubTab === 'videos' && (
        <section
          data-section-anchor="local_videos_list"
          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
        >
          {scopedLocalVideos.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {scopedLocalVideos.map((v) => renderSingleSongRow(v, scopedLocalVideos, 'local_video_hub'))}
            </div>
          ) : (
            <div style={{ padding: 24, textAlign: 'center', color: '#8e8e99', fontSize: 13 }}>
              No local video files indexed yet.
            </div>
          )}
        </section>
      )}
    </div>
  );
};
