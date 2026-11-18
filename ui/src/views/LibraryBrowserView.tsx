import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlbumRecord,
  ArchiveItemDetail,
  ArchiveItemSummary,
  defaultSimpClient,
  DvdTitleInfo,
  OpticalDiscStatus,
  PlaylistRecord,
  SimpStateSnapshot,
  TrackMetadata,
  VideoEpisodeItem,
} from '@simp/client';
import { DvdPlayerModal } from '../components/DvdPlayerModal';
import {
  AppleArtistProfileResponse,
  AppleArtistSummary,
  AppleCatalogSearchResults,
  AppleCloudAlbumSummary,
  AppleCloudPlaylistSummary,
  AppleRadioStationSummary,
  AppleRecommendationShelf,
  fetchAppleArtistProfile,
  fetchAppleLibraryRecentlyAdded,
  fetchApplePlaylistTracks,
  fetchFullAppleAlbum,
  fetchLocalArtistProfile,
  LocalArtistProfileResponse,
} from '../drivers/AppleMusicDriver';
import {
  fetchSoundCloudDiscover,
  fetchSoundCloudFollowings,
  fetchSoundCloudNextPage,
  fetchSoundCloudPlaylistTracks,
  fetchSoundCloudUserTracks,
  SoundCloudCatalogSearchResults,
  SoundCloudPlaylistSummary,
  SoundCloudUserProfileResponse,
  SoundCloudUserSummary,
} from '../drivers/SoundCloudDriver';
import { ImpIcon } from '../components/icons/ImpIcon';
import {
  LibraryFilterModal,
  type SmartFacetKind,
} from '../components/LibraryFilterModal';
import { getSourceThemeForLibraryFilter, getSourceThemeCssVars } from '../theme/sourceTheme';
import { LibraryMiniPlayerBar } from './library/LibraryMiniPlayerBar';
import { LibraryContextMenuModal } from './library/LibraryContextMenuModal';
import { LibraryArtistProfilePane } from './library/LibraryArtistProfilePane';
import { LibraryContextLegendBar } from './library/LibraryContextLegendBar';
import {
  LibrarySourceFilterPills,
  LibraryXmbLeftColumn,
} from './library/panes/LibraryXmbLeftColumn';
import { LibraryBrowseRightPane } from './library/panes/LibraryBrowseRightPane';
import { LibraryTracklistRightPane } from './library/panes/LibraryTracklistRightPane';
import {
  cacheAppleRecentLibraryShelf,
  fetchLocalDiscover,
  FypOriginRoute,
  LocalDiscoverResponse,
  LocalSmartStation,
  readProviderCachedShelves,
  TTL_ARCHIVE_SEC,
  writeCachedShelves,
} from '../api/servicesCacheApi';
import {
  AlphaBucket,
  BrowseHubTarget,
  cleanCollectionTitle,
  CLOUD_PAGE_SIZE,
  iaItemCountCache,
  iaItemCountPending,
  iaItemRatingCache,
  type LocalArtworkFilter,
  type LocalLyricsFilter,
  type LocalSubTab,
  matchesAlphaBucket,
  normalizeParentFolderPath,
  tileGridStyle,
  toggleSectionCollapsed,
  useLibraryLyricsStatus,
} from './library/libraryHelpers';
import { computeLocalFacetsSummary } from './library/panes/LocalDiscoverPane';
import {
  failedPlaylistCoverLookupIds,
  resolvedPlaylistCoverMemoryCache,
} from './library/ResilientTileArtwork';
import {
  LocalArtistCard,
  SimpAlbumCard,
  SimpPlaylistCard,
} from './library/cards/LocalCollectionCards';
import {
  AppleArtistCard,
  CloudAlbumCard,
  CloudPlaylistCard,
  StationCard,
} from './library/cards/AppleMusicCards';
import {
  ArchiveItemCard,
  SoundCloudPlaylistCard,
  SoundCloudUserCard,
} from './library/cards/SoundCloudAndArchiveCards';
import { SingleSongRow } from './library/cards/SingleSongRow';
import { OskTargetKind } from '../hooks/useGamepadNavigation';
import { BrowserTarget, isUiVideoTrack } from './PlayerView';
import { SourceVisibilityPrefs } from './SettingsModal';

export interface LibraryShelfAction {
  shelfUid: string;
  title: string;
  isPinned: boolean;
  triggerClick: () => void;
  openSourceClick?: () => void;
}

export type LibraryContextTarget =
  | {
      type: 'track';
      track: TrackMetadata;
      peerList: TrackMetadata[];
      isViewingLocalPlaylist?: boolean;
      shelfActions?: LibraryShelfAction[];
    }
  | {
      type: 'collection';
      kind:
        | 'simp_playlist'
        | 'simp_album'
        | 'cloud_playlist'
        | 'cloud_album'
        | 'sc_playlist'
        | 'ia_item'
        | 'local_station'
        | 'apple_station'
        | 'mount'
        | 'artist';
      id: string;
      title: string;
      subtitle?: string;
      art_url?: string | null;
      artistName?: string;
      source: 'local' | 'apple_music' | 'soundcloud' | 'internet_archive';
      rawItem: any;
      shelfActions?: LibraryShelfAction[];
    }
  | {
      type: 'shelf';
      title: string;
      subtitle?: string;
      shelfActions: LibraryShelfAction[];
      pinArchiveCollectionClick?: () => void;
      pinArchiveCollectionLabel?: string;
    };

export interface LibraryBrowserViewProps {
  hidden?: boolean;
  desktopMode?: boolean;
  onTriggerScreensaver?: () => void;
  snap: SimpStateSnapshot | null;
  track: TrackMetadata | null | undefined;
  albums: AlbumRecord[];
  playlists: PlaylistRecord[];
  browserSourceFilter: 'all' | 'local' | 'apple_music' | 'soundcloud' | 'internet_archive';
  setBrowserSourceFilter: React.Dispatch<
    React.SetStateAction<'all' | 'local' | 'apple_music' | 'soundcloud' | 'internet_archive'>
  >;
  selectedSources: Array<'local' | 'apple_music' | 'soundcloud' | 'internet_archive'>;
  setSelectedSources: React.Dispatch<
    React.SetStateAction<Array<'local' | 'apple_music' | 'soundcloud' | 'internet_archive'>>
  >;
  setBrowserSourceFilterRaw: React.Dispatch<
    React.SetStateAction<'all' | 'local' | 'apple_music' | 'soundcloud' | 'internet_archive'>
  >;
  browseHubTarget: BrowseHubTarget;
  setBrowseHubTarget: React.Dispatch<React.SetStateAction<BrowseHubTarget>>;
  browserSearch: string;
  setBrowserSearch: React.Dispatch<React.SetStateAction<string>>;
  searchPreferredSource?: 'local' | 'apple_music' | 'soundcloud' | 'internet_archive' | null;
  browserTarget: BrowserTarget | null;
  setBrowserTarget: React.Dispatch<React.SetStateAction<BrowserTarget | null>>;
  browserTracks: TrackMetadata[];
  setBrowserTracks: React.Dispatch<React.SetStateAction<TrackMetadata[]>>;
  opticalDisc: OpticalDiscStatus | null;
  cdScanning: boolean;
  handleScanOpticalDisc: (forceRefresh?: boolean, silent?: boolean) => Promise<void>;
  handleEjectOpticalDisc: () => void;
  appleSubTab: 'pinned' | 'for_you' | 'cloud_playlists' | 'new' | 'radio';
  setAppleSubTab: React.Dispatch<
    React.SetStateAction<'pinned' | 'for_you' | 'cloud_playlists' | 'new' | 'radio'>
  >;
  soundCloudSubTab: 'pinned' | 'likes_sets' | 'stream_radio' | 'trending';
  setSoundCloudSubTab: React.Dispatch<
    React.SetStateAction<'pinned' | 'likes_sets' | 'stream_radio' | 'trending'>
  >;
  scLikedTracks: TrackMetadata[];
  setScLikedTracks: React.Dispatch<React.SetStateAction<TrackMetadata[]>>;
  scPlaylists: SoundCloudPlaylistSummary[];
  setScPlaylists: React.Dispatch<React.SetStateAction<SoundCloudPlaylistSummary[]>>;
  scStreamTracks: TrackMetadata[];
  setScStreamTracks: React.Dispatch<React.SetStateAction<TrackMetadata[]>>;
  scStreamPlaylists: SoundCloudPlaylistSummary[];
  setScStreamPlaylists: React.Dispatch<React.SetStateAction<SoundCloudPlaylistSummary[]>>;
  scTrendingTracks: TrackMetadata[];
  setScTrendingTracks: React.Dispatch<React.SetStateAction<TrackMetadata[]>>;
  scTrendingMixes: TrackMetadata[];
  setScTrendingMixes: React.Dispatch<React.SetStateAction<TrackMetadata[]>>;
  scTrendingPlaylists: SoundCloudPlaylistSummary[];
  setScTrendingPlaylists: React.Dispatch<React.SetStateAction<SoundCloudPlaylistSummary[]>>;
  scSelectedGenre: string;
  setScSelectedGenre: React.Dispatch<React.SetStateAction<string>>;
  scCatalogSearchResults: SoundCloudCatalogSearchResults;
  activeScPlaylist: SoundCloudPlaylistSummary | null;
  cloudPlaylists: AppleCloudPlaylistSummary[];
  setCloudPlaylists: React.Dispatch<React.SetStateAction<AppleCloudPlaylistSummary[]>>;
  radioStations: AppleRadioStationSummary[];
  setRadioStations: React.Dispatch<React.SetStateAction<AppleRadioStationSummary[]>>;
  personalRadioStations?: AppleRadioStationSummary[];
  setPersonalRadioStations?: React.Dispatch<React.SetStateAction<AppleRadioStationSummary[]>>;
  liveRadioStations?: AppleRadioStationSummary[];
  setLiveRadioStations?: React.Dispatch<React.SetStateAction<AppleRadioStationSummary[]>>;
  artistRadioShows?: AppleCloudPlaylistSummary[];
  setArtistRadioShows?: React.Dispatch<React.SetStateAction<AppleCloudPlaylistSummary[]>>;
  clubMixes?: AppleCloudPlaylistSummary[];
  setClubMixes?: React.Dispatch<React.SetStateAction<AppleCloudPlaylistSummary[]>>;
  genreRadioStations?: AppleRadioStationSummary[];
  setGenreRadioStations?: React.Dispatch<React.SetStateAction<AppleRadioStationSummary[]>>;
  forYouPlaylists: AppleCloudPlaylistSummary[];
  setForYouPlaylists: React.Dispatch<React.SetStateAction<AppleCloudPlaylistSummary[]>>;
  forYouAlbums: AppleCloudAlbumSummary[];
  setForYouAlbums: React.Dispatch<React.SetStateAction<AppleCloudAlbumSummary[]>>;
  forYouNewReleases?: AppleCloudAlbumSummary[];
  setForYouNewReleases?: React.Dispatch<React.SetStateAction<AppleCloudAlbumSummary[]>>;
  setForYouShelves?: React.Dispatch<React.SetStateAction<AppleRecommendationShelf[]>>;
  appleRecentlyPlayedTracks?: TrackMetadata[];
  setAppleRecentlyPlayedTracks?: React.Dispatch<React.SetStateAction<TrackMetadata[]>>;
  newFeedRecentReleases?: AppleCloudAlbumSummary[];
  setNewFeedRecentReleases?: React.Dispatch<React.SetStateAction<AppleCloudAlbumSummary[]>>;
  newFeedAlbums: AppleCloudAlbumSummary[];
  setNewFeedAlbums: React.Dispatch<React.SetStateAction<AppleCloudAlbumSummary[]>>;
  newFeedPlaylists: AppleCloudPlaylistSummary[];
  setNewFeedPlaylists: React.Dispatch<React.SetStateAction<AppleCloudPlaylistSummary[]>>;
  newFeedSongs: TrackMetadata[];
  setNewFeedSongs: React.Dispatch<React.SetStateAction<TrackMetadata[]>>;
  catalogSearchResults: AppleCatalogSearchResults;
  cloudLoading: boolean;
  setCloudLoading: React.Dispatch<React.SetStateAction<boolean>>;
  activeCloudAlbum: AppleCloudAlbumSummary | null;
  activeCloudPlaylist: AppleCloudPlaylistSummary | null;
  creatingPlaylist: boolean;
  setCreatingPlaylist: React.Dispatch<React.SetStateAction<boolean>>;
  newPlaylistName: string;
  setNewPlaylistName: React.Dispatch<React.SetStateAction<string>>;
  activePlaylistId: string;
  setActivePlaylistId: React.Dispatch<React.SetStateAction<string>>;
  playingContextId: string;
  setPlayingContextId: React.Dispatch<React.SetStateAction<string>>;
  setOskTarget: React.Dispatch<React.SetStateAction<OskTargetKind>>;
  setSourceModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setView: React.Dispatch<React.SetStateAction<'lock' | 'browser'>>;
  applyFocusMarker: (el: HTMLElement | null) => void;
  handleCreatePlaylist: () => Promise<void>;
  handleAddTracksToPlaylist: (
    uris: string[],
    label: string,
    trackMetadata?: TrackMetadata[]
  ) => Promise<void>;
  handleRemoveTrackFromPlaylist: (
    playlistId: string,
    trackUri: string,
    title: string
  ) => Promise<void>;
  handleDeletePlaylist: (playlistId: string, playlistName: string) => Promise<void>;
  handleDeleteAlbum: (albumId: string, albumTitle: string) => Promise<void>;
  handlePinCloudPlaylist: (
    pl: AppleCloudPlaylistSummary,
    preloadedTracks?: TrackMetadata[]
  ) => Promise<void>;
  handlePinCloudAlbum: (
    album: AppleCloudAlbumSummary,
    tracks: TrackMetadata[]
  ) => Promise<void>;
  handleOpenCloudPlaylist: (pl: AppleCloudPlaylistSummary) => Promise<void>;
  handleOpenFullAppleAlbum: (params: {
    albumId?: string | null;
    songUri?: string | null;
    fallbackTitle?: string;
  }) => Promise<void>;
  handleStartAppleStation: (st: AppleRadioStationSummary) => void;
  handleOpenSoundCloudPlaylist: (pl: SoundCloudPlaylistSummary) => Promise<void>;
  handlePinSoundCloudPlaylist: (
    pl: SoundCloudPlaylistSummary,
    preloadedTracks?: TrackMetadata[]
  ) => Promise<void>;
  handleStartSoundCloudTrackRadio: (seedTrack: TrackMetadata) => void;
  sourceVisibility: SourceVisibilityPrefs;
  recentlyPlayed: TrackMetadata[];
  showToast: (msg: string) => void;
  forYouShelves?: AppleRecommendationShelf[];
  scMoreOfWhatYouLike?: TrackMetadata[];
  scFreshUploads?: TrackMetadata[];
  scRecommendedArtists?: SoundCloudUserSummary[];
  scDiscoverNextHref?: string | null;
  setScDiscoverNextHref?: React.Dispatch<React.SetStateAction<string | null>>;
  setScCatalogSearchResults?: React.Dispatch<
    React.SetStateAction<SoundCloudCatalogSearchResults>
  >;
  handleFavoriteTrack?: (track: TrackMetadata) => Promise<void>;
  handleAddAppleToCloudLibrary?: (
    idOrUri: string,
    kind?: 'songs' | 'albums' | 'playlists',
    label?: string
  ) => Promise<void>;
  favoritedUris?: string[];
  applyVolume: (nextVol: number) => void;
  currentVolume: number;
  volumePopoverOpen: boolean;
  setVolumePopoverOpen: React.Dispatch<React.SetStateAction<boolean>>;
  isPlaying: boolean;
  volPct: number;
  brightnessPopoverOpen: boolean;
  setBrightnessPopoverOpen: React.Dispatch<React.SetStateAction<boolean>>;
  brightnessPct: number;
  setBrightnessPct: React.Dispatch<React.SetStateAction<number>>;
  sourceModalOpen: boolean;
  powerModalOpen: boolean;
  setPowerModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
}

function computeLibraryViewportScale(): number {
  if (typeof window === 'undefined') return 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Steam Deck / 800p baseline (1280x800) stays at 1.0x
  if (vw <= 1340 && vh <= 840) return 1;
  const minRatio = Math.min(vw / 1280, vh / 800);
  const scaled = 1 + (minRatio - 1) * 0.38;
  return Math.round(Math.min(1.35, Math.max(1, scaled)) * 100) / 100;
}

export const LibraryBrowserView: React.FC<LibraryBrowserViewProps> = ({
  hidden = false,
  desktopMode = false,
  onTriggerScreensaver,
  snap,
  track,
  albums,
  playlists,
  browserSourceFilter,
  setBrowserSourceFilter,
  selectedSources,
  setSelectedSources,
  setBrowserSourceFilterRaw,
  browseHubTarget,
  setBrowseHubTarget,
  browserSearch,
  setBrowserSearch,
  searchPreferredSource = null,
  browserTarget,
  setBrowserTarget,
  browserTracks,
  setBrowserTracks,
  opticalDisc,
  cdScanning,
  handleScanOpticalDisc,
  handleEjectOpticalDisc,
  appleSubTab,
  setAppleSubTab,
  soundCloudSubTab,
  setSoundCloudSubTab,
  scLikedTracks,
  setScLikedTracks,
  scPlaylists,
  setScPlaylists,
  scStreamTracks,
  setScStreamTracks,
  scStreamPlaylists,
  setScStreamPlaylists,
  scTrendingTracks,
  setScTrendingTracks,
  scTrendingMixes,
  setScTrendingMixes,
  scTrendingPlaylists,
  setScTrendingPlaylists,
  scSelectedGenre,
  setScSelectedGenre,
  scCatalogSearchResults,
  activeScPlaylist,
  cloudPlaylists,
  setCloudPlaylists,
  radioStations,
  setRadioStations,
  personalRadioStations = [],
  setPersonalRadioStations,
  liveRadioStations = [],
  setLiveRadioStations,
  artistRadioShows = [],
  setArtistRadioShows,
  clubMixes = [],
  setClubMixes,
  genreRadioStations = [],
  setGenreRadioStations,
  forYouPlaylists,
  setForYouPlaylists,
  forYouAlbums,
  setForYouAlbums,
  forYouNewReleases = [],
  setForYouNewReleases,
  setForYouShelves,
  appleRecentlyPlayedTracks = [],
  setAppleRecentlyPlayedTracks,
  newFeedRecentReleases = [],
  setNewFeedRecentReleases,
  newFeedAlbums,
  setNewFeedAlbums,
  newFeedPlaylists,
  setNewFeedPlaylists,
  newFeedSongs,
  setNewFeedSongs,
  catalogSearchResults,
  cloudLoading,
  setCloudLoading,
  activeCloudAlbum,
  activeCloudPlaylist,
  creatingPlaylist,
  setCreatingPlaylist,
  newPlaylistName,
  setNewPlaylistName,
  activePlaylistId,
  setActivePlaylistId,
  playingContextId,
  setPlayingContextId,
  setOskTarget,
  setSourceModalOpen,
  setView,
  applyFocusMarker,
  handleCreatePlaylist,
  handleAddTracksToPlaylist,
  handleRemoveTrackFromPlaylist,
  handleDeletePlaylist,
  handleDeleteAlbum,
  handlePinCloudPlaylist,
  handlePinCloudAlbum,
  handleOpenCloudPlaylist,
  handleOpenFullAppleAlbum,
  handleStartAppleStation,
  handleOpenSoundCloudPlaylist,
  handlePinSoundCloudPlaylist,
  handleStartSoundCloudTrackRadio,
  sourceVisibility,
  recentlyPlayed,
  showToast,
  forYouShelves = [],
  scMoreOfWhatYouLike = [],
  scFreshUploads = [],
  scRecommendedArtists = [],
  scDiscoverNextHref = null,
  setScDiscoverNextHref,
  setScCatalogSearchResults,
  handleFavoriteTrack,
  handleAddAppleToCloudLibrary,
  favoritedUris = [],
  applyVolume,
  currentVolume,
  volumePopoverOpen,
  setVolumePopoverOpen,
  isPlaying,
  volPct,
  brightnessPopoverOpen,
  setBrightnessPopoverOpen,
  brightnessPct,
  setBrightnessPct,
  sourceModalOpen,
  powerModalOpen,
  setPowerModalOpen,
}) => {
  // Left Sidebar Collapsible Section States (persisted in localStorage)
  const [placesOpen, setPlacesOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('simp_sec_places') !== '0';
    } catch {
      return true;
    }
  });
  const [playlistsOpen, setPlaylistsOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('simp_sec_playlists') !== '0';
    } catch {
      return true;
    }
  });

  const [activeDvdPlayback, setActiveDvdPlayback] = useState<{
    titleInfo: DvdTitleInfo;
    chapter: number;
    audioIdx: number;
    subIdx: string;
  } | null>(null);
  const [dvdAudioChoice, setDvdAudioChoice] = useState<number>(0);
  const [dvdSubChoice, setDvdSubChoice] = useState<string>('off');

  // Internet Archive & Universal Theatre Video Player state
  const [iaSubTab, setIaSubTab] = useState<'pinned' | 'trending' | 'films' | 'tv' | 'audio'>('trending');
  const [iaSubFilter, setIaSubFilter] = useState<string>('all');
  const [iaItems, setIaItems] = useState<ArchiveItemSummary[]>([]);
  const [iaPage, setIaPage] = useState<number>(1);
  const [iaHasMore, setIaHasMore] = useState<boolean>(false);
  const [iaLoadingMore, setIaLoadingMore] = useState<boolean>(false);
  const [iaSearchResults, setIaSearchResults] = useState<ArchiveItemSummary[]>([]);
  const [iaSearchPage, setIaSearchPage] = useState<number>(1);
  const [iaSearchHasMore, setIaSearchHasMore] = useState<boolean>(false);
  const [iaSearchLoadingMore, setIaSearchLoadingMore] = useState<boolean>(false);
  const [activeIaDetail, setActiveIaDetail] = useState<ArchiveItemDetail | null>(null);
  const [iaLoading, setIaLoading] = useState<boolean>(false);
  const [scLoadingMore, setScLoadingMore] = useState<boolean>(false);
  const [activeVideoModal, setActiveVideoModal] = useState<{
    mode: 'ia_video' | 'local_video';
    title: string;
    episodes: VideoEpisodeItem[];
    initialEpisodeIndex?: number;
  } | null>(null);

  const togglePlacesOpen = () => {
    setPlacesOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('simp_sec_places', next ? '1' : '0');
      } catch {}
      return next;
    });
  };
  const togglePlaylistsOpen = () => {
    setPlaylistsOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('simp_sec_playlists', next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  // Right Pane State: 'browse' (4-Column-Max Visual Card Grid for the active Place), 'tracks' (Selected Collection Tracklist), or 'artist' (Dedicated Artist Profile View)
  const [rightPaneMode, setRightPaneMode] = useState<'browse' | 'tracks' | 'artist'>('browse');
  const [activeArtistProfile, setActiveArtistProfile] = useState<{
    source: 'apple_music' | 'soundcloud' | 'local';
    idOrName: string;
    displayName: string;
    subTab: 'tracks' | 'albums' | 'singles_or_likes' | 'related_or_following';
    loading: boolean;
    loadingMore?: boolean;
    appleData?: AppleArtistProfileResponse | null;
    scData?: SoundCloudUserProfileResponse | null;
    localData?: LocalArtistProfileResponse | null;
  } | null>(null);
  const [mediaTypeFilter, setMediaTypeFilter] = useState<'all' | 'video' | 'audio'>('all');
  const [iaResolvedCounts, setIaResolvedCounts] = useState<Record<string, number>>({});
  const [iaResolvedRatings, setIaResolvedRatings] = useState<Record<string, string>>({});
  const [activeMountRoot, setActiveMountRoot] = useState<string | null>(null);
  const [localSubTab, setLocalSubTab] = useState<LocalSubTab>('overview');
  const [localFolderPath, setLocalFolderPath] = useState<string>('');
  const [localGenreFilter, setLocalGenreFilter] = useState<string>('all');
  const [localYearFilter, setLocalYearFilter] = useState<string>('all');
  const [localArtworkFilter, setLocalArtworkFilter] = useState<LocalArtworkFilter>('all');
  const [localLyricsFilter, setLocalLyricsFilter] = useState<LocalLyricsFilter>('all');
  const [localAlpha, setLocalAlpha] = useState<AlphaBucket>('all');
  const [allLocalTracks, setAllLocalTracks] = useState<TrackMetadata[]>([]);
  const [mountAlbums, setMountAlbums] = useState<AlbumRecord[]>([]);
  const [mountTracks, setMountTracks] = useState<TrackMetadata[]>([]);
  const [localVideos, setLocalVideos] = useState<TrackMetadata[]>([]);
  const [localSearchTracks, setLocalSearchTracks] = useState<TrackMetadata[]>([]);
  const [simpHubFilter, setSimpHubFilter] = useState<
    'all' | 'recent' | 'hybrid' | 'pinned' | 'albums' | 'videos'
  >('all');
  const impFypActive = browseHubTarget === 'imp_fyp';
  const setImpFypActive: React.Dispatch<React.SetStateAction<boolean>> = useCallback(
    (action) => {
      setBrowseHubTarget((prev) => {
        const cur = prev === 'imp_fyp';
        const next = typeof action === 'function' ? action(cur) : action;
        if (next) return 'imp_fyp';
        return prev === 'imp_fyp' ? 'imp_library' : prev;
      });
    },
    [setBrowseHubTarget]
  );
  const [localDiscover, setLocalDiscover] = useState<LocalDiscoverResponse>({
    recent_albums: [],
    rediscover_albums: [],
    smart_stations: [],
  });
  useEffect(() => {
    let cancelled = false;
    fetchLocalDiscover().then((res) => {
      if (!cancelled) setLocalDiscover(res);
    });
    return () => {
      cancelled = true;
    };
  }, [albums.length, snap?.mounts?.length]);

  const handlePlayLocalSmartStation = useCallback(
    (st: LocalSmartStation, shuffle = false) => {
      if (!st.tracks || st.tracks.length === 0) {
        showToast(`"${st.title}" has no local tracks yet`);
        return;
      }
      setPlayingContextId(`local_station:${st.id}`);
      if (shuffle) {
        defaultSimpClient.setShuffle(true);
      }
      defaultSimpClient.loadQueue(
        st.tracks.map((t) => t.uri),
        0,
        st.tracks
      );
      showToast(`Playing ${st.title} (${st.track_count} tracks)`);
      setView('lock');
    },
    [setPlayingContextId, setView, showToast]
  );
  const [cloudPlaylistsVisibleCount, setCloudPlaylistsVisibleCount] =
    useState<number>(CLOUD_PAGE_SIZE);
  const [cloudAlpha, setCloudAlpha] = useState<AlphaBucket>('all');
  const [forYouFilter, setForYouFilter] = useState<
    'all' | 'stations' | 'new_releases' | 'recently_played' | 'mixes' | 'social' | 'recent_library'
  >('all');
  const [appleRadioFilter, setAppleRadioFilter] = useState<
    'all' | 'live' | 'shows' | 'mixes' | 'genre'
  >('all');
  const [appleRadioGenre, setAppleRadioGenre] = useState<string>('');
  const [libraryContextTarget, setLibraryContextTarget] = useState<LibraryContextTarget | null>(
    null
  );
  const { syncedUris, allLyricsUris } = useLibraryLyricsStatus();
  const [allLocalTracksVersion, setAllLocalTracksVersion] = useState(0);
  useEffect(() => {
    const bump = (ev: Event) => {
      const detail = (ev as CustomEvent<{ properties?: unknown; lyrics?: unknown; factoids?: unknown }>)
        .detail;
      if (
        detail &&
        detail.properties === undefined &&
        detail.lyrics === undefined &&
        detail.factoids === undefined
      ) {
        return;
      }
      setAllLocalTracksVersion((v) => v + 1);
    };
    window.addEventListener('simp-track-properties-updated', bump);
    return () => window.removeEventListener('simp-track-properties-updated', bump);
  }, []);
  useEffect(() => {
    defaultSimpClient
      .query<TrackMetadata[]>('get_tracks', {
        source: 'local',
        mount_root: null,
        search: null,
        limit: 10000,
        offset: 0,
      })
      .then((res) => {
        if (Array.isArray(res)) setAllLocalTracks(res);
      })
      .catch(() => {});
  }, [albums.length, snap?.mounts?.length, allLocalTracksVersion]);
  const allLocalAlbums = useMemo(
    () => albums.filter((alb) => !alb.id.startsWith('applemusic:album:')),
    [albums]
  );
  const localFacetsSummary = useMemo(
    () => computeLocalFacetsSummary(allLocalAlbums, allLocalTracks, syncedUris, allLyricsUris),
    [allLocalAlbums, allLocalTracks, syncedUris, allLyricsUris]
  );
  const [filterModalOpen, setFilterModalOpen] = useState<boolean>(false);
  const [activeSmartFacet, setActiveSmartFacet] = useState<SmartFacetKind>(null);
  const [filterHasLyricsOnly, setFilterHasLyricsOnly] = useState<boolean>(false);
  const handleSelectLocalSubTab = useCallback(
    (next: React.SetStateAction<LocalSubTab>) => {
      setLocalSubTab((prev) => {
        const resolved = typeof next === 'function' ? next(prev) : next;
        if (resolved !== 'folders') {
          setActiveMountRoot(null);
          setLocalFolderPath('');
          setBrowseHubTarget('local_discover');
        }
        return resolved;
      });
    },
    [setBrowseHubTarget]
  );
  useEffect(() => {
    setFilterHasLyricsOnly(false);
  }, [browserTarget?.kind, browserTarget?.id]);

  const availableAppleRadioGenres = useMemo(() => {
    const src = genreRadioStations.length > 0 ? genreRadioStations : radioStations;
    const seen = new Set<string>();
    for (const st of src) {
      if (st.genre) seen.add(st.genre);
    }
    return Array.from(seen).slice(0, 12);
  }, [genreRadioStations, radioStations]);

  const focusDefaultFilterOption = useCallback(() => {
    window.setTimeout(() => {
      const firstBtn =
        document.querySelector<HTMLElement>(
          '[data-filter-modal="true"] button[data-default-focus="true"]:not([disabled])'
        ) ||
        document.querySelector<HTMLElement>(
          '[data-filter-modal="true"] button[data-filter-xmb-item="true"]:not([disabled])'
        );
      if (firstBtn) applyFocusMarker(firstBtn);
    }, 30);
  }, [applyFocusMarker]);

  const openFilterModal = useCallback(() => {
    setFilterModalOpen(true);
    focusDefaultFilterOption();
  }, [focusDefaultFilterOption]);

  const handleSelectScGenreFromModal = useCallback(
    (gId: string) => {
      setScSelectedGenre(gId);
      setCloudLoading(true);
      fetchSoundCloudDiscover(gId || undefined)
        .then((res) => {
          setScTrendingTracks(res.tracks);
          setScTrendingMixes(res.mixes);
          setScTrendingPlaylists(res.playlists);
          setScDiscoverNextHref?.(res.next_tracks_href || null);
        })
        .catch(() => {})
        .finally(() => setCloudLoading(false));
    },
    [
      setScSelectedGenre,
      setCloudLoading,
      setScTrendingTracks,
      setScTrendingMixes,
      setScTrendingPlaylists,
      setScDiscoverNextHref,
    ]
  );

  const [newFilter, setNewFilter] = useState<
    'all' | 'recent_releases' | 'albums' | 'playlists' | 'songs'
  >('all');
  const [scLikesFilter, setScLikesFilter] = useState<'all' | 'likes' | 'sets' | 'following'>('all');
  const [scFollowings, setScFollowings] = useState<SoundCloudUserSummary[]>([]);
  const [scFollowingsLoaded, setScFollowingsLoaded] = useState<boolean>(false);
  const [scStreamFilter, setScStreamFilter] = useState<'all' | 'history' | 'stream' | 'sets'>('all');
  const [scTrendingFilter, setScTrendingFilter] = useState<
    'all' | 'for_you' | 'fresh' | 'artists' | 'mixes' | 'sets' | 'tracks'
  >('all');
  const [recentlyAddedCloudAlbums, setRecentlyAddedCloudAlbums] = useState<AppleCloudAlbumSummary[]>(
    []
  );
  const recentLoadedRef = useRef(false);

  const isSourceIncluded = useCallback(
    (src: 'local' | 'apple_music' | 'soundcloud' | 'internet_archive'): boolean => {
      if (src === 'apple_music' && !sourceVisibility.apple_music) return false;
      if (src === 'soundcloud' && !sourceVisibility.soundcloud) return false;
      if (src === 'internet_archive' && !sourceVisibility.internet_archive) return false;
      if (selectedSources.length > 0) {
        return selectedSources.includes(src);
      }
      return browserSourceFilter === 'all' || browserSourceFilter === src;
    },
    [sourceVisibility, selectedSources, browserSourceFilter]
  );

  useEffect(() => {
    if (
      browseHubTarget !== 'soundcloud_discover' ||
      soundCloudSubTab !== 'likes_sets' ||
      !snap?.soundcloud_authenticated
    ) {
      return;
    }
    if (scFollowingsLoaded) return;
    setScFollowingsLoaded(true);
    fetchSoundCloudFollowings()
      .then((users) => {
        if (Array.isArray(users)) setScFollowings(users);
      })
      .catch(() => {
        setScFollowingsLoaded(false);
      });
  }, [browseHubTarget, soundCloudSubTab, snap?.soundcloud_authenticated, scFollowingsLoaded]);

  useEffect(() => {
    if (
      !snap?.apple_authenticated ||
      !isSourceIncluded('apple_music')
    )
      return;
    if (appleSubTab !== 'for_you' && appleSubTab !== 'pinned') return;
    if (recentLoadedRef.current && recentlyAddedCloudAlbums.length > 0) return;
    recentLoadedRef.current = true;
    fetchAppleLibraryRecentlyAdded()
      .then((albs) => {
        if (Array.isArray(albs)) {
          setRecentlyAddedCloudAlbums(albs);
          cacheAppleRecentLibraryShelf(albs);
        }
      })
      .catch(() => {
        recentLoadedRef.current = false;
      });
  }, [snap?.apple_authenticated, isSourceIncluded, appleSubTab, recentlyAddedCloudAlbums.length]);

  useEffect(() => {
    let followUpTimer: number | null = null;
    const syncRecentLibrary = () => {
      fetchAppleLibraryRecentlyAdded()
        .then((albs) => {
          if (Array.isArray(albs)) {
            recentLoadedRef.current = true;
            setRecentlyAddedCloudAlbums(albs);
            cacheAppleRecentLibraryShelf(albs);
          }
        })
        .catch(() => {});
    };
    const onAppleLibraryUpdated = () => {
      syncRecentLibrary();
      if (followUpTimer !== null) {
        window.clearTimeout(followUpTimer);
      }
      followUpTimer = window.setTimeout(syncRecentLibrary, 2000);
    };
    const onFypShelfUpdated = (ev: Event) => {
      const detail = (ev as CustomEvent<{ cacheKey?: string; items?: unknown[] }>).detail;
      if (
        detail?.cacheKey === 'apple:for_you:recent_library' &&
        Array.isArray(detail.items)
      ) {
        recentLoadedRef.current = true;
        setRecentlyAddedCloudAlbums(detail.items as AppleCloudAlbumSummary[]);
      }
    };
    window.addEventListener('simp-apple-library-updated', onAppleLibraryUpdated);
    window.addEventListener('simp-fyp-shelf-updated', onFypShelfUpdated);
    return () => {
      if (followUpTimer !== null) {
        window.clearTimeout(followUpTimer);
      }
      window.removeEventListener('simp-apple-library-updated', onAppleLibraryUpdated);
      window.removeEventListener('simp-fyp-shelf-updated', onFypShelfUpdated);
    };
  }, []);

  // Clear activeMountRoot if user switches source filter away from Local
  useEffect(() => {
    if (!isSourceIncluded('local') && activeMountRoot) {
      setActiveMountRoot(null);
    }
  }, [isSourceIncluded, activeMountRoot]);

  const resolveDaemonUrl = useCallback((path: string): string => {
    if (typeof window !== 'undefined' && window.location?.hostname) {
      const host = window.location.hostname;
      if (
        window.location.protocol === 'http:' &&
        host !== 'steamloopback.host' &&
        host !== '127.0.0.1' &&
        host !== 'localhost'
      ) {
        const port = window.location.port === '1420' ? '18888' : window.location.port || '18888';
        return `http://${host}:${port}${path}`;
      }
      if (window.location.port === '18888') {
        return path;
      }
    }
    return `http://127.0.0.1:18888${path}`;
  }, []);

  // Fetch Internet Archive discovery hub items (page 1, Stale-While-Revalidate via servicesCache.db)
  const iaSwrLastFetchedRef = useRef<Record<string, number>>({});
  useEffect(() => {
    const onPurged = (ev: Event) => {
      const src = ((ev as CustomEvent<{ source?: string }>).detail?.source || '').toLowerCase();
      if (src.includes('archive') || src === 'ia') {
        iaSwrLastFetchedRef.current = {};
        setIaItems([]);
      }
    };
    window.addEventListener('simp-source-purged', onPurged);
    return () => window.removeEventListener('simp-source-purged', onPurged);
  }, []);

  const loadIaDiscover = useCallback(
    async (hub: string, sub: string) => {
      const cacheKey = `ia:bundle:${hub}:${sub}`;
      const shelfId = `bundle:${hub}:${sub}`;
      let hydratedFromCache = false;
      try {
        const cached = await readProviderCachedShelves('internet_archive');
        const entry = cached.byShelfId[shelfId];
        if (entry && Array.isArray(entry.data) && entry.data.length > 0) {
          setIaItems(entry.data);
          hydratedFromCache = true;
          if (!entry.stale) {
            iaSwrLastFetchedRef.current[cacheKey] = entry.fetchedAt;
            return;
          }
        }
      } catch {
        // Ignore cache lookup failure
      }
      if (!hydratedFromCache) {
        setIaLoading(true);
      }
      setIaPage(1);
      setIaHasMore(false);
      fetch(
        resolveDaemonUrl(
          `/api/ia/discover?hub=${encodeURIComponent(hub)}&sub=${encodeURIComponent(sub)}&page=1`
        )
      )
        .then((r) => r.json())
        .then((d) => {
          const list = Array.isArray(d?.items)
            ? d.items
            : Array.isArray(d?.data)
              ? d.data
              : [];
          if (d?.ok) {
            setIaItems(list);
            setIaHasMore(Boolean(d?.has_more));
            iaSwrLastFetchedRef.current[cacheKey] = Math.floor(Date.now() / 1000);
            writeCachedShelves([
              {
                cacheKey,
                provider: 'internet_archive',
                shelfId,
                title: `Internet Archive ${hub}`,
                data: list,
                ttlSec: TTL_ARCHIVE_SEC,
              },
            ]);
          }
        })
        .catch(() => {})
        .finally(() => setIaLoading(false));
    },
    [resolveDaemonUrl]
  );

  const pendingLoadMoreFocusRef = useRef<{
    firstTileKey: string | null;
    savedScrollTop: number;
  } | null>(null);

  const flushLoadMoreFocusTransfer = useCallback(() => {
    const pending = pendingLoadMoreFocusRef.current;
    if (!pending) return;
    pendingLoadMoreFocusRef.current = null;
    const col = document.querySelector<HTMLElement>('[data-nav-col="right"]');
    if (!col) return;
    const curFocused = document.querySelector<HTMLElement>('[data-simp-active-focus="true"]');
    if (curFocused && curFocused.isConnected && curFocused.dataset.loadMore !== 'true') {
      return;
    }
    col.scrollTop = pending.savedScrollTop;
    if (pending.firstTileKey) {
      const candidates = col.querySelectorAll<HTMLElement>('[data-tile-key]');
      for (const el of candidates) {
        if (el.dataset.tileKey === pending.firstTileKey && !el.hasAttribute('disabled')) {
          applyFocusMarker(el);
          el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          return;
        }
      }
    }
    const fallbackNodes = Array.from(
      col.querySelectorAll<HTMLElement>(
        '[data-right-tile="true"]:not([disabled]), [data-single-song-play="true"]:not([disabled])'
      )
    ).filter((el) => el.dataset.loadMore !== 'true');
    const lastTile = fallbackNodes[fallbackNodes.length - 1];
    if (lastTile) {
      applyFocusMarker(lastTile);
      lastTile.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, [applyFocusMarker]);

  const transferFocusAfterLoadMore = useCallback(
    (startedOnLoadMore = false) => {
      const rightCol = document.querySelector<HTMLElement>('[data-nav-col="right"]');
      if (!rightCol) return null;
      const focused = document.querySelector<HTMLElement>('[data-simp-active-focus="true"]');
      const isLoadMoreFocused = Boolean(focused && focused.dataset.loadMore === 'true');
      const isLostFocus = !focused || !focused.isConnected;
      const shouldTransfer =
        isLoadMoreFocused ||
        (isLostFocus &&
          (startedOnLoadMore || document.documentElement.dataset.simpInput === 'gamepad'));
      if (!shouldTransfer) return null;

      const slot = {
        firstTileKey: null as string | null,
        savedScrollTop: rightCol.scrollTop,
      };
      pendingLoadMoreFocusRef.current = slot;
      window.setTimeout(() => {
        if (pendingLoadMoreFocusRef.current === slot) {
          flushLoadMoreFocusTransfer();
        }
      }, 30);
      return slot;
    },
    [flushLoadMoreFocusTransfer]
  );

  useEffect(() => {
    if (pendingLoadMoreFocusRef.current) {
      flushLoadMoreFocusTransfer();
    }
  }, [
    iaItems,
    iaHasMore,
    iaSearchResults,
    iaSearchHasMore,
    scTrendingTracks,
    scDiscoverNextHref,
    scCatalogSearchResults.songs,
    scCatalogSearchResults.next_tracks_href,
    activeArtistProfile?.scData?.tracks,
    activeArtistProfile?.scData?.next_tracks_href,
    cloudPlaylistsVisibleCount,
    flushLoadMoreFocusTransfer,
  ]);

  const loadMoreIaDiscover = useCallback(() => {
    if (iaLoadingMore || !iaHasMore) return;
    const startedOnLoadMore =
      document.querySelector<HTMLElement>('[data-simp-active-focus="true"]')?.dataset.loadMore ===
      'true';
    const nextPage = iaPage + 1;
    setIaLoadingMore(true);
    fetch(
      resolveDaemonUrl(
        `/api/ia/discover?hub=${encodeURIComponent(iaSubTab)}&sub=${encodeURIComponent(
          iaSubFilter
        )}&page=${nextPage}`
      )
    )
      .then((r) => r.json())
      .then((d) => {
        const list: ArchiveItemSummary[] = Array.isArray(d?.items)
          ? d.items
          : Array.isArray(d?.data)
            ? d.data
            : [];
        if (d?.ok) {
          const transferSlot = transferFocusAfterLoadMore(startedOnLoadMore);
          setIaItems((prev) => {
            const seen = new Set(prev.map((it) => it.identifier));
            const added = list.filter((it) => !seen.has(it.identifier));
            const firstVisibleAdded =
              added.find((it) => {
                if (mediaTypeFilter === 'video') return it.mediatype === 'movies';
                if (mediaTypeFilter === 'audio') return it.mediatype !== 'movies';
                return true;
              }) || added[0];
            if (transferSlot && firstVisibleAdded) {
              transferSlot.firstTileKey = `ia_item:${firstVisibleAdded.identifier}`;
            }
            return [...prev, ...added];
          });
          setIaPage(nextPage);
          setIaHasMore(Boolean(d?.has_more) && list.length > 0);
        }
      })
      .catch(() => {})
      .finally(() => setIaLoadingMore(false));
  }, [
    iaLoadingMore,
    iaHasMore,
    iaPage,
    iaSubTab,
    iaSubFilter,
    mediaTypeFilter,
    resolveDaemonUrl,
    transferFocusAfterLoadMore,
  ]);

  useEffect(() => {
    if (browseHubTarget !== 'ia_discover' || iaSubTab === 'pinned') return;
    if (!snap?.internet_archive_authenticated || !sourceVisibility.internet_archive) return;
    loadIaDiscover(iaSubTab, iaSubFilter);
  }, [
    browseHubTarget,
    iaSubTab,
    iaSubFilter,
    snap?.internet_archive_authenticated,
    sourceVisibility.internet_archive,
    loadIaDiscover,
  ]);

  // Debounced Internet Archive Search
  useEffect(() => {
    const q = browserSearch.trim();
    if (!q || !snap?.internet_archive_authenticated || !isSourceIncluded('internet_archive')) {
      setIaSearchResults([]);
      setIaSearchPage(1);
      setIaSearchHasMore(false);
      return;
    }
    const timer = window.setTimeout(() => {
      setIaSearchPage(1);
      fetch(resolveDaemonUrl(`/api/ia/search?q=${encodeURIComponent(q)}&page=1`))
        .then((r) => r.json())
        .then((d) => {
          const list = Array.isArray(d?.items)
            ? d.items
            : Array.isArray(d?.data)
              ? d.data
              : [];
          if (d?.ok) {
            setIaSearchResults(list);
            setIaSearchHasMore(Boolean(d?.has_more));
          }
        })
        .catch(() => {});
    }, 280);
    return () => window.clearTimeout(timer);
  }, [browserSearch, isSourceIncluded, snap?.internet_archive_authenticated, resolveDaemonUrl]);

  const loadMoreIaSearch = useCallback(() => {
    const q = browserSearch.trim();
    if (!q || iaSearchLoadingMore || !iaSearchHasMore) return;
    const startedOnLoadMore =
      document.querySelector<HTMLElement>('[data-simp-active-focus="true"]')?.dataset.loadMore ===
      'true';
    const nextPage = iaSearchPage + 1;
    setIaSearchLoadingMore(true);
    fetch(resolveDaemonUrl(`/api/ia/search?q=${encodeURIComponent(q)}&page=${nextPage}`))
      .then((r) => r.json())
      .then((d) => {
        const list: ArchiveItemSummary[] = Array.isArray(d?.items)
          ? d.items
          : Array.isArray(d?.data)
            ? d.data
            : [];
        if (d?.ok) {
          const transferSlot = transferFocusAfterLoadMore(startedOnLoadMore);
          setIaSearchResults((prev) => {
            const seen = new Set(prev.map((it) => it.identifier));
            const added = list.filter((it) => !seen.has(it.identifier));
            const firstVisibleAdded =
              added.find((it) => {
                if (mediaTypeFilter === 'video') return it.mediatype === 'movies';
                if (mediaTypeFilter === 'audio') return it.mediatype !== 'movies';
                return true;
              }) || added[0];
            if (transferSlot && firstVisibleAdded) {
              transferSlot.firstTileKey = `ia_item:${firstVisibleAdded.identifier}`;
            }
            return [...prev, ...added];
          });
          setIaSearchPage(nextPage);
          setIaSearchHasMore(Boolean(d?.has_more) && list.length > 0);
        }
      })
      .catch(() => {})
      .finally(() => setIaSearchLoadingMore(false));
  }, [
    browserSearch,
    iaSearchLoadingMore,
    iaSearchHasMore,
    iaSearchPage,
    mediaTypeFilter,
    resolveDaemonUrl,
    transferFocusAfterLoadMore,
  ]);

  const loadMoreScDiscover = useCallback(() => {
    if (!scDiscoverNextHref || scLoadingMore) return;
    const startedOnLoadMore =
      document.querySelector<HTMLElement>('[data-simp-active-focus="true"]')?.dataset.loadMore ===
      'true';
    setScLoadingMore(true);
    fetchSoundCloudNextPage(scDiscoverNextHref)
      .then((res) => {
        const transferSlot = transferFocusAfterLoadMore(startedOnLoadMore);
        if (res.tracks && res.tracks.length > 0) {
          setScTrendingTracks((prev) => {
            const seen = new Set(prev.map((t) => t.uri));
            const added = res.tracks.filter((t) => !seen.has(t.uri));
            if (transferSlot && added[0]) {
              transferSlot.firstTileKey = `song:sc_trending:${added[0].uri}`;
            }
            return [...prev, ...added];
          });
        }
        setScDiscoverNextHref?.(res.next_href || null);
      })
      .catch(() => {})
      .finally(() => setScLoadingMore(false));
  }, [
    scDiscoverNextHref,
    scLoadingMore,
    setScTrendingTracks,
    setScDiscoverNextHref,
    transferFocusAfterLoadMore,
  ]);

  const loadMoreScSearch = useCallback(() => {
    const nextHref = scCatalogSearchResults.next_tracks_href;
    if (!nextHref || scLoadingMore || !setScCatalogSearchResults) return;
    const startedOnLoadMore =
      document.querySelector<HTMLElement>('[data-simp-active-focus="true"]')?.dataset.loadMore ===
      'true';
    setScLoadingMore(true);
    fetchSoundCloudNextPage(nextHref)
      .then((res) => {
        const transferSlot = transferFocusAfterLoadMore(startedOnLoadMore);
        setScCatalogSearchResults((prev) => {
          const seen = new Set(prev.songs.map((t) => t.uri));
          const added = (res.tracks || []).filter((t) => !seen.has(t.uri));
          if (transferSlot && added[0]) {
            transferSlot.firstTileKey = `song:sc_search:${added[0].uri}`;
          }
          return {
            ...prev,
            songs: [...prev.songs, ...added],
            next_tracks_href: res.next_href || null,
          };
        });
      })
      .catch(() => {})
      .finally(() => setScLoadingMore(false));
  }, [
    scCatalogSearchResults.next_tracks_href,
    scLoadingMore,
    setScCatalogSearchResults,
    transferFocusAfterLoadMore,
  ]);

  // Lazy background item/episode count & content rating resolver for visible Internet Archive tiles
  useEffect(() => {
    const visibleList = browserSearch.trim() ? iaSearchResults : iaItems;
    if (visibleList.length === 0) return;
    const candidates = visibleList.filter(
      (it) =>
        (it.item_count == null || !it.content_rating) &&
        !iaItemCountCache.has(it.identifier) &&
        !iaItemRatingCache.has(it.identifier) &&
        !iaItemCountPending.has(it.identifier)
    );
    if (candidates.length === 0) return;

    let cancelled = false;
    const runResolve = async () => {
      for (const it of candidates.slice(0, 16)) {
        if (cancelled) break;
        iaItemCountPending.add(it.identifier);
        try {
          const resp = await fetch(
            resolveDaemonUrl(`/api/ia/item?id=${encodeURIComponent(it.identifier)}`)
          );
          const d = await resp.json();
          const detail: ArchiveItemDetail | undefined = d?.detail || d?.data;
          if (!cancelled && d?.ok && detail) {
            const count =
              detail.episodes && detail.episodes.length > 0
                ? detail.episodes.length
                : detail.tracks
                ? detail.tracks.length
                : 1;
            iaItemCountCache.set(it.identifier, count);
            setIaResolvedCounts((prev) => ({ ...prev, [it.identifier]: count }));
            if (detail.summary?.content_rating) {
              iaItemRatingCache.set(it.identifier, detail.summary.content_rating);
              const rating = detail.summary.content_rating;
              setIaResolvedRatings((prev) => ({ ...prev, [it.identifier]: rating }));
            }
          }
        } catch {
          // Ignore individual metadata failures
        }
        await new Promise((r) => window.setTimeout(r, 180));
      }
    };
    runResolve();
    return () => {
      cancelled = true;
    };
  }, [iaItems, iaSearchResults, browserSearch, resolveDaemonUrl]);

  // Auto-load Internet Archive item detail when jumping directly from Player ('Open Collection')
  useEffect(() => {
    if (rightPaneMode !== 'tracks' || browserTarget?.kind !== 'ia_item') return;
    if (activeIaDetail?.summary.identifier === browserTarget.id) return;
    setIaLoading(true);
    fetch(resolveDaemonUrl(`/api/ia/item?id=${encodeURIComponent(browserTarget.id)}`))
      .then((r) => r.json())
      .then((d) => {
        const detail: ArchiveItemDetail | undefined = d?.detail || d?.data;
        if (d?.ok && detail) {
          setActiveIaDetail(detail);
          setBrowserTracks(detail.tracks || []);
        }
      })
      .catch(() => {})
      .finally(() => setIaLoading(false));
  }, [
    rightPaneMode,
    browserTarget,
    activeIaDetail?.summary.identifier,
    setBrowserTracks,
    resolveDaemonUrl,
  ]);

  // Listen for 'Open Collection in Library' ('simp-open-collection-in-library') from Player / SELECT menu:
  // Switch the Right Pane to 'tracks' mode, clear any active search query, and scroll/focus the playing track!
  useEffect(() => {
    const onOpenCollectionInLibrary = () => {
      setBrowserSearch('');
      setActiveMountRoot(null);
      setRightPaneMode('tracks');
      pendingRightFocusRef.current = 'track';
      window.setTimeout(() => {
        const playingRow =
          document.querySelector<HTMLElement>(
            '[data-nav-col="right"] [data-right-track="true"][data-track-playing="true"]'
          ) ||
          document.querySelector<HTMLElement>(
            '[data-nav-col="right"] [data-right-track="true"]'
          ) ||
          document.querySelector<HTMLElement>(
            '[data-nav-col="right"] [data-right-play-all="true"]:not([disabled])'
          );
        if (playingRow) {
          playingRow.scrollIntoView({ block: 'center', inline: 'nearest' });
          applyFocusMarker(playingRow);
          if (playingRow.dataset.rightTrack === 'true') {
            pendingRightFocusRef.current = null;
          }
        }
      }, 65);
    };
    window.addEventListener('simp-open-collection-in-library', onOpenCollectionInLibrary);
    return () => {
      window.removeEventListener('simp-open-collection-in-library', onOpenCollectionInLibrary);
    };
  }, [applyFocusMarker, setBrowserSearch]);

  // Load albums and tracks belonging to the selected Storage Mount Place (`activeMountRoot`)
  useEffect(() => {
    if (!activeMountRoot) {
      setMountAlbums([]);
      setMountTracks([]);
      return;
    }
    const searchParam = browserSearch.trim() ? browserSearch.trim() : null;
    defaultSimpClient
      .query<AlbumRecord[]>('get_albums', {
        source: null,
        mount_root: activeMountRoot,
        search: searchParam,
        limit: 1000,
        offset: 0,
      })
      .then((res) => {
        if (Array.isArray(res)) setMountAlbums(res);
      })
      .catch(() => {});
    defaultSimpClient
      .query<TrackMetadata[]>('get_tracks', {
        source: null,
        mount_root: activeMountRoot,
        search: searchParam,
        limit: 2000,
        offset: 0,
      })
      .then((res) => {
        if (Array.isArray(res)) setMountTracks(res);
      })
      .catch(() => {});
  }, [activeMountRoot, browserSearch, albums]);

  // Load indexed Local Video files (`source: 'local_video'`) for the SIMP Library hub
  useEffect(() => {
    defaultSimpClient
      .query<TrackMetadata[]>('get_tracks', {
        source: 'local_video',
        mount_root: null,
        search: null,
        limit: 500,
        offset: 0,
      })
      .then((res) => {
        if (Array.isArray(res)) setLocalVideos(res);
      })
      .catch(() => {});
  }, [albums, snap?.mounts]);

  // Query matching Local & cached library tracks/videos whenever searching
  useEffect(() => {
    const q = browserSearch.trim();
    if (!q) {
      setLocalSearchTracks([]);
      return;
    }
    defaultSimpClient
      .query<TrackMetadata[]>('get_tracks', {
        source: null,
        mount_root: null,
        search: q,
        limit: 60,
        offset: 0,
      })
      .then((res) => {
        if (Array.isArray(res)) setLocalSearchTracks(res);
      })
      .catch(() => {});
  }, [browserSearch]);

  // Auto-focus Right Pane when selecting a Place ('tile') or Collection ('track')
  const pendingRightFocusRef = useRef<'track' | 'tile' | null>(null);
  const pendingRightTileRestoreRef = useRef<{
    tileKey?: string | null;
    scrollTop?: number;
  } | null>(null);
  const xmbPreviewTriggerRef = useRef<boolean>(false);

  // PS3 XMB Auto-Fill: When cursor lands on a non-drill-down row in the Left Column (`data-xmb-preview="true"`),
  // automatically fill the Right Pane after a 180ms debounce while keeping focus in the Left Column!
  useEffect(() => {
    let debounceTimer = 0;
    const onXmbLeftFocus = (e: Event) => {
      const el = (e as CustomEvent<{ element?: HTMLElement }>)?.detail?.element;
      if (!el) return;
      window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        if (!el.isConnected || el.getAttribute('data-simp-active-focus') !== 'true') return;
        xmbPreviewTriggerRef.current = true;
        try {
          el.click();
        } finally {
          xmbPreviewTriggerRef.current = false;
        }
      }, 180);
    };
    window.addEventListener('simp-xmb-left-focus', onXmbLeftFocus);
    return () => {
      window.clearTimeout(debounceTimer);
      window.removeEventListener('simp-xmb-left-focus', onXmbLeftFocus);
    };
  }, []);

  const focusRightPaneFirstTrack = useCallback(() => {
    if (xmbPreviewTriggerRef.current) return;
    pendingRightFocusRef.current = 'track';
    pendingRightTileRestoreRef.current = null;
    const rightCol = document.querySelector<HTMLElement>('[data-nav-col="right"]');
    if (rightCol) {
      rightCol.scrollTop = 0;
    }
    window.setTimeout(() => {
      const firstTrack =
        document.querySelector<HTMLElement>(
          '[data-nav-col="right"] [data-right-track="true"]'
        ) ||
        document.querySelector<HTMLElement>(
          '[data-nav-col="right"] [data-right-play-all="true"]:not([disabled])'
        );
      if (firstTrack) {
        applyFocusMarker(firstTrack);
        if (firstTrack.dataset.rightTrack === 'true') {
          pendingRightFocusRef.current = null;
        }
      }
    }, 55);
  }, [applyFocusMarker]);

  const applyRightPaneTileFocus = useCallback(
    (allowButtonFallback: boolean) => {
      const rightCol = document.querySelector<HTMLElement>('[data-nav-col="right"]');
      const restore = pendingRightTileRestoreRef.current;
      if (rightCol && restore?.scrollTop !== undefined) {
        rightCol.scrollTop = restore.scrollTop;
      }
      if (restore?.tileKey) {
        let matchedTile: HTMLElement | null = null;
        const candidates = rightCol?.querySelectorAll<HTMLElement>('[data-tile-key]') || [];
        for (const el of candidates) {
          if (el.dataset.tileKey === restore.tileKey && !el.hasAttribute('disabled')) {
            matchedTile = el;
            break;
          }
        }
        if (matchedTile) {
          if (rightCol && restore.scrollTop !== undefined) {
            rightCol.scrollTop = restore.scrollTop;
          }
          applyFocusMarker(matchedTile);
          matchedTile.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          pendingRightFocusRef.current = null;
          pendingRightTileRestoreRef.current = null;
          return;
        }
        if (!allowButtonFallback) {
          return;
        }
      }
      const firstTile =
        document.querySelector<HTMLElement>(
          '[data-nav-col="right"] [data-right-tile="true"]:not([disabled]), [data-nav-col="right"] [data-single-song-play="true"]:not([disabled]), [data-nav-col="right"] [data-right-track="true"]:not([disabled])'
        ) ||
        (allowButtonFallback
          ? document.querySelector<HTMLElement>(
              '[data-nav-col="right"] button:not([disabled]):not([data-right-filter-pill="true"])'
            ) ||
            document.querySelector<HTMLElement>(
              '[data-nav-col="right"] button:not([disabled])'
            )
          : null);
      if (firstTile) {
        applyFocusMarker(firstTile);
        if (
          firstTile.dataset.rightTile === 'true' ||
          firstTile.dataset.singleSongPlay === 'true' ||
          firstTile.dataset.rightTrack === 'true'
        ) {
          pendingRightFocusRef.current = null;
          pendingRightTileRestoreRef.current = null;
        }
      }
    },
    [applyFocusMarker]
  );

  const focusRightPaneFirstTile = useCallback(
    (restoreOptions?: { tileKey?: string | null; scrollTop?: number }) => {
      if (xmbPreviewTriggerRef.current) return;
      pendingRightFocusRef.current = 'tile';
      pendingRightTileRestoreRef.current = restoreOptions ? { ...restoreOptions } : null;
      window.setTimeout(() => {
        if (pendingRightFocusRef.current !== 'tile') return;
        applyRightPaneTileFocus(true);
      }, 45);
    },
    [applyRightPaneTileFocus]
  );

  const pendingDroppedMountPathRef = useRef<string | null>(null);
  const normalizeMountCompare = useCallback((rawPath: string) => {
    let p = rawPath.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    const winDrive = p.match(/^([a-zA-Z]):\/(.*)$/);
    if (winDrive) {
      p = `/mnt/${winDrive[1].toLowerCase()}/${winDrive[2]}`;
    }
    if (p.startsWith('/mnt/') || /^[a-zA-Z]:/.test(rawPath.trim())) {
      return p.toLowerCase();
    }
    return p;
  }, []);

  const tryOpenPendingDroppedMount = useCallback(
    (mountsList: SimpStateSnapshot['mounts'] | undefined) => {
      const wanted = pendingDroppedMountPathRef.current;
      if (!wanted || !mountsList || mountsList.length === 0) return false;
      const wantedNorm = normalizeMountCompare(wanted);
      const matched = mountsList.find(
        (m) => normalizeMountCompare(m.mount_root) === wantedNorm
      );
      if (!matched) return false;
      pendingDroppedMountPathRef.current = null;
      setBrowserSearch('');
      setActiveMountRoot(matched.mount_root);
      setLocalFolderPath('');
      setLocalSubTab('folders');
      setBrowseHubTarget('mount');
      setRightPaneMode('browse');
      focusRightPaneFirstTile();
      return true;
    },
    [
      focusRightPaneFirstTile,
      normalizeMountCompare,
      setBrowseHubTarget,
      setBrowserSearch,
    ]
  );

  useEffect(() => {
    const onOpenLocalMount = (ev: Event) => {
      const path = (ev as CustomEvent<{ path?: string }>).detail?.path;
      if (!path) return;
      pendingDroppedMountPathRef.current = path;
      tryOpenPendingDroppedMount(snap?.mounts);
    };
    window.addEventListener('simp-open-local-mount', onOpenLocalMount);
    return () => window.removeEventListener('simp-open-local-mount', onOpenLocalMount);
  }, [snap?.mounts, tryOpenPendingDroppedMount]);

  useEffect(() => {
    if (pendingDroppedMountPathRef.current && snap?.mounts) {
      tryOpenPendingDroppedMount(snap.mounts);
    }
  }, [snap?.mounts, tryOpenPendingDroppedMount]);

  // Complete deferred Right-Pane focus when async tracks or cloud tiles finish loading
  useEffect(() => {
    if (pendingRightFocusRef.current === 'track' && rightPaneMode === 'tracks' && browserTracks.length > 0) {
      const t = window.setTimeout(() => {
        const firstTrack = document.querySelector<HTMLElement>(
          '[data-nav-col="right"] [data-right-track="true"]'
        );
        if (firstTrack) {
          applyFocusMarker(firstTrack);
          pendingRightFocusRef.current = null;
        }
      }, 25);
      return () => window.clearTimeout(t);
    }
    if (pendingRightFocusRef.current === 'tile' && rightPaneMode === 'browse') {
      const curFocused = document.querySelector<HTMLElement>('[data-simp-active-focus="true"]');
      const alreadyFocusedInRightBrowse =
        Boolean(curFocused?.closest('[data-nav-col="right"]')) &&
        (curFocused?.dataset.rightTile === 'true' ||
          curFocused?.dataset.singleSongPlay === 'true' ||
          curFocused?.dataset.loadMore === 'true');
      if (alreadyFocusedInRightBrowse && !pendingRightTileRestoreRef.current?.tileKey) {
        pendingRightFocusRef.current = null;
        pendingRightTileRestoreRef.current = null;
        return;
      }
      const t = window.setTimeout(() => {
        if (pendingRightFocusRef.current !== 'tile') return;
        applyRightPaneTileFocus(false);
      }, 25);
      return () => window.clearTimeout(t);
    }
  }, [
    browserTracks,
    rightPaneMode,
    appleSubTab,
    soundCloudSubTab,
    iaSubTab,
    iaItems,
    iaSearchResults,
    cloudPlaylists,
    radioStations,
    forYouPlaylists,
    newFeedAlbums,
    scLikedTracks,
    scPlaylists,
    scStreamTracks,
    scStreamPlaylists,
    scTrendingTracks,
    scTrendingMixes,
    scTrendingPlaylists,
    applyFocusMarker,
    applyRightPaneTileFocus,
  ]);

  // Switch Right Pane to 'browse' when user types a search query
  useEffect(() => {
    if (browserSearch.trim()) {
      setRightPaneMode('browse');
      setCloudPlaylistsVisibleCount(CLOUD_PAGE_SIZE);
    }
  }, [browserSearch]);

  // Multi-Service Auth State Classification ('connected' | 'reauth_required' | 'never_used')
  const pinnedApplePlaylistCount = playlists.filter((p) => p.origin === 'apple_remote').length;
  const pinnedAppleAlbumCount = albums.filter((a) => a.id.startsWith('applemusic:album:')).length;
  const hasPinnedAppleContent = pinnedApplePlaylistCount + pinnedAppleAlbumCount > 0;
  const appleAuthState: 'connected' | 'reauth_required' | 'never_used' = snap?.apple_authenticated
    ? 'connected'
    : hasPinnedAppleContent
    ? 'reauth_required'
    : 'never_used';

  const selectedAlbumObj =
    browserTarget?.kind === 'album'
      ? albums.find((a) => a.id === browserTarget.id) ||
        mountAlbums.find((a) => a.id === browserTarget.id)
      : null;
  const selectedPlaylistObj =
    browserTarget?.kind === 'playlist' ? playlists.find((p) => p.id === browserTarget.id) : null;
  const selectedMountObj =
    browserTarget?.kind === 'mount'
      ? snap?.mounts.find((m) => m.mount_root === browserTarget.id)
      : null;
  const activeMountPlaceObj = activeMountRoot
    ? snap?.mounts.find((m) => m.mount_root === activeMountRoot) || null
    : null;
  const writablePlaylists = playlists.filter((p) => p.origin === 'simp_local');

  const searchLower = browserSearch.trim().toLowerCase();

  // Source-aware & media-type-aware SIMP Album filtering
  // Keep `Imp` strictly curated: Apple pinned albums + explicitly pinned Local albums
  // (all unpinned Local albums live under the dedicated `💾 Local` destination).
  const filteredAlbums = useMemo(
    () =>
      albums.filter((alb) => {
        if (mediaTypeFilter === 'video') return false;
        const isApple = alb.id.startsWith('applemusic:album:');
        if (isApple && !isSourceIncluded('apple_music')) return false;
        if (!isApple && !isSourceIncluded('local')) return false;
        if (searchLower) {
          const matchTitle = alb.title.toLowerCase().includes(searchLower);
          const matchArtist = alb.album_artist.toLowerCase().includes(searchLower);
          if (!matchTitle && !matchArtist) return false;
          return true;
        }
        if (!isApple) {
          return playlists.some((p) => p.id === `local:album:${alb.id}`);
        }
        return true;
      }),
    [albums, mediaTypeFilter, isSourceIncluded, searchLower, playlists]
  );

  // Source-aware & media-type-aware Recently Played filtering
  const filteredRecentlyPlayed = useMemo(
    () =>
      recentlyPlayed.filter((tr) => {
        const isVid = isUiVideoTrack(tr);
        if (mediaTypeFilter === 'video' && !isVid) return false;
        if (mediaTypeFilter === 'audio' && isVid) return false;
        if (tr.source === 'apple_music' && !isSourceIncluded('apple_music')) return false;
        if (tr.source === 'soundcloud' && !isSourceIncluded('soundcloud')) return false;
        if (
          (tr.source === 'internet_archive' || tr.source === 'ia_video') &&
          !isSourceIncluded('internet_archive')
        )
          return false;
        if (
          (tr.source === 'local' ||
            tr.source === 'local_video' ||
            tr.source === 'steam_ost' ||
            tr.source === 'removable' ||
            tr.source === 'cdda' ||
            tr.source === 'dvd') &&
          !isSourceIncluded('local')
        )
          return false;
        if (searchLower) {
          const matchTitle = tr.title.toLowerCase().includes(searchLower);
          const matchArtist = tr.artists.some((a) => a.toLowerCase().includes(searchLower));
          const matchAlbum = tr.album ? tr.album.toLowerCase().includes(searchLower) : false;
          if (!matchTitle && !matchArtist && !matchAlbum) return false;
        }
        return true;
      }),
    [recentlyPlayed, mediaTypeFilter, isSourceIncluded, searchLower]
  );

  const filteredLocalSearchTracks = useMemo(
    () =>
      localSearchTracks.filter((tr) => {
        const isVid = isUiVideoTrack(tr);
        if (mediaTypeFilter === 'video' && !isVid) return false;
        if (mediaTypeFilter === 'audio' && isVid) return false;
        if (tr.source === 'apple_music') return isSourceIncluded('apple_music');
        if (tr.source === 'soundcloud') return isSourceIncluded('soundcloud');
        if (tr.source === 'internet_archive' || tr.source === 'ia_video') {
          return isSourceIncluded('internet_archive');
        }
        return isSourceIncluded('local');
      }),
    [localSearchTracks, mediaTypeFilter, isSourceIncluded]
  );

  const filteredIaItems = useMemo(
    () =>
      iaItems.filter((it) => {
        if (mediaTypeFilter === 'video' && it.mediatype !== 'movies') return false;
        if (mediaTypeFilter === 'audio' && it.mediatype === 'movies') return false;
        return true;
      }),
    [iaItems, mediaTypeFilter]
  );

  const filteredIaSearchResults = useMemo(
    () =>
      iaSearchResults.filter((it) => {
        if (mediaTypeFilter === 'video' && it.mediatype !== 'movies') return false;
        if (mediaTypeFilter === 'audio' && it.mediatype === 'movies') return false;
        return true;
      }),
    [iaSearchResults, mediaTypeFilter]
  );

  // Source-aware SIMP Playlist membership (`has_local`, `has_apple`, `has_soundcloud`, & `has_archive`)
  // Left-column and My SIMP Library hub playlists remain visible regardless of `browserSearch`
  // so users can always select or drop search results into a playlist without it disappearing.
  const filteredPlaylists = useMemo(
    () =>
      playlists.filter((pl) => {
        if (mediaTypeFilter === 'video') {
          const isVideoPl =
            pl.name.startsWith('🎬') ||
            pl.origin === 'archive_remote' ||
            (pl.origin === 'simp_local' && (pl.has_archive || pl.has_local));
          if (!isVideoPl) return false;
        } else if (mediaTypeFilter === 'audio') {
          if (pl.name.startsWith('🎬')) return false;
        }
        if (pl.origin === 'local_pinned') return isSourceIncluded('local');
        if (pl.origin === 'apple_remote') return isSourceIncluded('apple_music');
        if (pl.origin === 'soundcloud_remote') return isSourceIncluded('soundcloud');
        if (pl.origin === 'archive_remote') return isSourceIncluded('internet_archive');
        if (pl.origin === 'simp_local' && pl.track_count > 0) {
          const matchesLocal = pl.has_local && isSourceIncluded('local');
          const matchesApple = pl.has_apple && isSourceIncluded('apple_music');
          const matchesSc = pl.has_soundcloud && isSourceIncluded('soundcloud');
          const matchesIa = pl.has_archive && isSourceIncluded('internet_archive');
          if (!matchesLocal && !matchesApple && !matchesSc && !matchesIa) {
            return false;
          }
        }
        return true;
      }),
    [playlists, mediaTypeFilter, isSourceIncluded]
  );

  // Playlists matching the active search query (`searchLower`) for the right-pane Unified Search section.
  const searchMatchedPlaylists = useMemo(
    () =>
      !searchLower
        ? []
        : playlists.filter((pl) => {
            if (mediaTypeFilter === 'video') {
              const isVideoPl =
                pl.name.startsWith('🎬') ||
                pl.origin === 'archive_remote' ||
                (pl.origin === 'simp_local' && (pl.has_archive || pl.has_local));
              if (!isVideoPl) return false;
            } else if (mediaTypeFilter === 'audio') {
              if (pl.name.startsWith('🎬')) return false;
            }
            const matchesQuery =
              pl.name.toLowerCase().includes(searchLower) ||
              Boolean(pl.description && pl.description.toLowerCase().includes(searchLower));
            if (!matchesQuery) return false;
            if (pl.origin === 'simp_local') return true;
            if (pl.origin === 'local_pinned') return isSourceIncluded('local');
            if (pl.origin === 'apple_remote') return isSourceIncluded('apple_music');
            if (pl.origin === 'soundcloud_remote') return isSourceIncluded('soundcloud');
            if (pl.origin === 'archive_remote') return isSourceIncluded('internet_archive');
            return true;
          }),
    [playlists, mediaTypeFilter, isSourceIncluded, searchLower]
  );

  const hybridPlaylistsList = useMemo(
    () => filteredPlaylists.filter((p) => p.origin === 'simp_local'),
    [filteredPlaylists]
  );
  const pinnedPlaylistsList = useMemo(
    () =>
      filteredPlaylists.filter(
        (p) =>
          p.origin === 'local_pinned' ||
          p.origin === 'apple_remote' ||
          p.origin === 'soundcloud_remote' ||
          p.origin === 'archive_remote'
      ),
    [filteredPlaylists]
  );

  // Filtered Cloud Playlists (supports both Search query and A-Z bucket filter + 50/page pagination)
  const filteredCloudPlaylists = useMemo(() => {
    return cloudPlaylists.filter((pl) => {
      if (searchLower) {
        const matchName = pl.name.toLowerCase().includes(searchLower);
        const matchDesc = pl.description ? pl.description.toLowerCase().includes(searchLower) : false;
        if (!matchName && !matchDesc) return false;
      }
      if (!searchLower && !matchesAlphaBucket(pl.name, cloudAlpha)) {
        return false;
      }
      return true;
    });
  }, [cloudPlaylists, searchLower, cloudAlpha]);

  useEffect(() => {
    setCloudPlaylistsVisibleCount(CLOUD_PAGE_SIZE);
  }, [cloudAlpha, searchLower]);

  const resetCloudPlaylistsLimit = useCallback(() => {
    setCloudPlaylistsVisibleCount(CLOUD_PAGE_SIZE);
  }, []);

  const pagedCloudPlaylists = useMemo(
    () => filteredCloudPlaylists.slice(0, cloudPlaylistsVisibleCount),
    [filteredCloudPlaylists, cloudPlaylistsVisibleCount]
  );
  const hasMoreCloudPlaylists = cloudPlaylistsVisibleCount < filteredCloudPlaylists.length;

  const loadMoreCloudPlaylists = useCallback(() => {
    if (!hasMoreCloudPlaylists) return;
    const startedOnLoadMore =
      document.querySelector<HTMLElement>('[data-simp-active-focus="true"]')?.dataset.loadMore ===
      'true';
    const nextFirstPl = filteredCloudPlaylists[pagedCloudPlaylists.length];
    const slot = transferFocusAfterLoadMore(startedOnLoadMore);
    if (slot && nextFirstPl) {
      slot.firstTileKey = `cloud_playlist:${nextFirstPl.id}`;
    }
    setCloudPlaylistsVisibleCount((c) => c + CLOUD_PAGE_SIZE);
  }, [
    filteredCloudPlaylists,
    hasMoreCloudPlaylists,
    pagedCloudPlaylists.length,
    transferFocusAfterLoadMore,
  ]);

  // Throttled background backfill for visible Apple Playlists that have no playlist-level cover art
  // (fetches the playlist's first song cover on `mzstatic.com` and caches it in SQLite + memory)
  useEffect(() => {
    if (!snap?.apple_authenticated || browserSourceFilter === 'local') return;
    const candidates = pagedCloudPlaylists.filter(
      (pl) =>
        (!pl.art_url || pl.art_url.includes('blobstore.apple.com')) &&
        !resolvedPlaylistCoverMemoryCache.has(pl.id) &&
        !failedPlaylistCoverLookupIds.has(pl.id)
    );
    if (candidates.length === 0) return;

    let cancelled = false;
    const runBackfill = async () => {
      for (const pl of candidates.slice(0, 16)) {
        if (cancelled) break;
        failedPlaylistCoverLookupIds.add(pl.id);
        try {
          const resp = await fetch(
            `/api/apple/playlist-cover?id=${encodeURIComponent(pl.id)}&kind=${encodeURIComponent(
              pl.kind || 'library'
            )}`
          );
          const data = await resp.json();
          if (!cancelled && data?.ok && data?.art_url) {
            resolvedPlaylistCoverMemoryCache.set(pl.id, data.art_url);
            setCloudPlaylists((prev) =>
              prev.map((item) => (item.id === pl.id ? { ...item, art_url: data.art_url } : item))
            );
          }
        } catch {
          // Ignore individual failures
        }
        await new Promise((r) => window.setTimeout(r, 260));
      }
    };
    runBackfill();
    return () => {
      cancelled = true;
    };
  }, [pagedCloudPlaylists, snap?.apple_authenticated, browserSourceFilter, setCloudPlaylists]);

  // Right-pane navigation history stack so mouse users (and controller 'B' in Tracklist/Service view) can walk back step-by-step
  interface RightNavEntry {
    browserSourceFilter: 'all' | 'local' | 'apple_music' | 'soundcloud' | 'internet_archive';
    browseHubTarget: BrowseHubTarget;
    rightPaneMode: 'browse' | 'tracks' | 'artist';
    browserTarget: BrowserTarget | null;
    browserTracks: TrackMetadata[];
    appleSubTab: 'pinned' | 'for_you' | 'cloud_playlists' | 'new' | 'radio';
    soundCloudSubTab: 'pinned' | 'likes_sets' | 'stream_radio' | 'trending';
    iaSubTab: 'pinned' | 'trending' | 'films' | 'tv' | 'audio';
    activeMountRoot: string | null;
    localSubTab: LocalSubTab;
    localFolderPath: string;
    browserSearch: string;
    impFypActive?: boolean;
    activeArtistProfile?: typeof activeArtistProfile;
    returnTileKey?: string | null;
    scrollTop?: number;
  }
  const [navHistory, setNavHistory] = useState<RightNavEntry[]>([]);

  const pushCurrentNavState = useCallback(
    (opts?: { returnTileKey?: string | null; scrollTop?: number; forceEvenOnPreview?: boolean }) => {
      if (xmbPreviewTriggerRef.current && !opts?.forceEvenOnPreview) return;
      const capturedScrollTop =
        opts?.scrollTop ??
        document.querySelector<HTMLElement>('[data-nav-col="right"]')?.scrollTop ??
        0;
      const focusedTileKey =
        opts?.returnTileKey ??
        document
          .querySelector<HTMLElement>(
            '[data-nav-col="right"] [data-simp-active-focus="true"][data-tile-key]'
          )
          ?.dataset.tileKey ??
        null;
      setNavHistory((prev) => {
        const next: RightNavEntry = {
          browserSourceFilter,
          browseHubTarget,
          rightPaneMode,
          browserTarget,
          browserTracks,
          appleSubTab,
          soundCloudSubTab,
          iaSubTab,
          activeMountRoot,
          localSubTab,
          localFolderPath,
          browserSearch,
          impFypActive,
          activeArtistProfile,
          returnTileKey: focusedTileKey,
          scrollTop: capturedScrollTop,
        };
        const last = prev[prev.length - 1];
        if (
          last &&
          last.browserSourceFilter === next.browserSourceFilter &&
          last.browseHubTarget === next.browseHubTarget &&
          last.rightPaneMode === next.rightPaneMode &&
          last.appleSubTab === next.appleSubTab &&
          last.soundCloudSubTab === next.soundCloudSubTab &&
          last.iaSubTab === next.iaSubTab &&
          last.activeMountRoot === next.activeMountRoot &&
          last.localSubTab === next.localSubTab &&
          last.localFolderPath === next.localFolderPath &&
          last.browserSearch === next.browserSearch &&
          last.impFypActive === next.impFypActive &&
          last.activeArtistProfile?.idOrName === next.activeArtistProfile?.idOrName &&
          JSON.stringify(last.browserTarget) === JSON.stringify(next.browserTarget)
        ) {
          return [
            ...prev.slice(0, -1),
            {
              ...last,
              returnTileKey: next.returnTileKey ?? last.returnTileKey,
              scrollTop: next.scrollTop,
            },
          ];
        }
        return [...prev.slice(-15), next];
      });
    },
    [
      browserSourceFilter,
      browseHubTarget,
      rightPaneMode,
      browserTarget,
      browserTracks,
      appleSubTab,
      soundCloudSubTab,
      iaSubTab,
      activeMountRoot,
      localSubTab,
      localFolderPath,
      browserSearch,
      impFypActive,
      activeArtistProfile,
    ]
  );

  const handleWalkBack = useCallback(() => {
    const exitedTileKey =
      rightPaneMode === 'artist' && activeArtistProfile
        ? `artist:${activeArtistProfile.source}:${activeArtistProfile.idOrName}`
        : rightPaneMode === 'tracks' && browserTarget
        ? `${browserTarget.kind}:${browserTarget.id}`
        : null;
    if (navHistory.length > 0) {
      let targetIdx = -1;
      for (let i = navHistory.length - 1; i >= 0; i--) {
        const entry = navHistory[i];
        const differs =
          entry.rightPaneMode !== rightPaneMode ||
          entry.browserTarget?.kind !== browserTarget?.kind ||
          entry.browserTarget?.id !== browserTarget?.id ||
          cleanCollectionTitle(entry.browserTarget?.title || '') !==
            cleanCollectionTitle(browserTarget?.title || '') ||
          entry.activeArtistProfile?.idOrName !== activeArtistProfile?.idOrName ||
          entry.browseHubTarget !== browseHubTarget ||
          entry.activeMountRoot !== activeMountRoot ||
          entry.localSubTab !== localSubTab ||
          entry.localFolderPath !== localFolderPath;
        if (differs) {
          targetIdx = i;
          break;
        }
      }
      if (targetIdx >= 0) {
        const prev = navHistory[targetIdx];
        setNavHistory((h) => h.slice(0, targetIdx));
        setBrowserSourceFilter(prev.browserSourceFilter);
        setAppleSubTab(prev.appleSubTab);
        setSoundCloudSubTab(prev.soundCloudSubTab);
        setIaSubTab(prev.iaSubTab);
        setActiveMountRoot(prev.activeMountRoot);
        setLocalSubTab(prev.localSubTab);
        setLocalFolderPath(prev.localFolderPath);
        setBrowserSearch(prev.browserSearch);
        setBrowseHubTarget(prev.browseHubTarget);
        setBrowserTarget(prev.browserTarget);
        setBrowserTracks(prev.browserTracks);
        setActiveArtistProfile(prev.activeArtistProfile || null);
        setRightPaneMode(prev.rightPaneMode);
        if (prev.rightPaneMode === 'browse') {
          focusRightPaneFirstTile({
            tileKey: prev.returnTileKey || exitedTileKey,
            scrollTop: prev.scrollTop,
          });
        } else {
          focusRightPaneFirstTrack();
        }
        return;
      }
      setNavHistory([]);
    }
    if (rightPaneMode === 'tracks' || rightPaneMode === 'artist') {
      setRightPaneMode('browse');
      focusRightPaneFirstTile({ tileKey: exitedTileKey });
      return;
    }
    if (browserSearch.trim()) {
      setBrowserSearch('');
      return;
    }
    const normFolder = normalizeParentFolderPath(localFolderPath);
    if ((browseHubTarget === 'local_discover' || browseHubTarget === 'mount') && normFolder) {
      const parts = normFolder.split('/').filter(Boolean);
      parts.pop();
      setLocalFolderPath(parts.join('/'));
      return;
    }
    if (activeMountRoot) {
      setActiveMountRoot(null);
      setLocalFolderPath('');
      setBrowseHubTarget('local_discover');
      setLocalSubTab('folders');
      return;
    }
    if (browseHubTarget !== 'imp_fyp' && browseHubTarget !== 'imp_library') {
      setBrowseHubTarget('imp_library');
      return;
    }
  }, [
    navHistory,
    rightPaneMode,
    activeArtistProfile,
    browserTarget,
    browserSearch,
    activeMountRoot,
    localSubTab,
    localFolderPath,
    browseHubTarget,
    setBrowseHubTarget,
    setBrowserSourceFilter,
    setAppleSubTab,
    setSoundCloudSubTab,
    setIaSubTab,
    setActiveMountRoot,
    setBrowserSearch,
    setBrowserTarget,
    setBrowserTracks,
    setRightPaneMode,
    focusRightPaneFirstTile,
    focusRightPaneFirstTrack,
  ]);

  const canWalkBackInBrowse =
    navHistory.length > 0 ||
    Boolean(browserSearch.trim()) ||
    Boolean(normalizeParentFolderPath(localFolderPath)) ||
    Boolean(activeMountRoot) ||
    (browseHubTarget !== 'imp_fyp' && browseHubTarget !== 'imp_library');

  // Open a dedicated Artist Profile view in the right pane (`Tracks`, `Albums/Sets`, `Singles/Likes`, `Related/Following`)
  const openArtistProfile = useCallback(
    async (params: {
      source: 'apple_music' | 'soundcloud' | 'local';
      idOrName: string;
      displayName: string;
    }) => {
      pushCurrentNavState({
        returnTileKey: `artist:${params.source}:${params.idOrName}`,
      });
      setActiveArtistProfile({
        source: params.source,
        idOrName: params.idOrName,
        displayName: params.displayName,
        subTab: 'tracks',
        loading: true,
        appleData: null,
        scData: null,
        localData: null,
      });
      setRightPaneMode('artist');
      pendingRightFocusRef.current = null;
      pendingRightTileRestoreRef.current = null;
      const rightCol = document.querySelector<HTMLElement>('[data-nav-col="right"]');
      if (rightCol) {
        rightCol.scrollTop = 0;
      }
      window.setTimeout(() => {
        const artistTarget =
          document.querySelector<HTMLElement>(
            '[data-nav-col="right"] [data-single-song-play="true"]:not([disabled]), [data-nav-col="right"] [data-right-tile="true"]:not([disabled])'
          ) ||
          document.querySelector<HTMLElement>('[data-nav-col="right"] button:not([disabled])');
        if (artistTarget) {
          applyFocusMarker(artistTarget);
        }
      }, 45);

      try {
        if (params.source === 'soundcloud') {
          const scProfile = await fetchSoundCloudUserTracks(params.idOrName);
          setActiveArtistProfile((prev) =>
            prev && prev.idOrName === params.idOrName
              ? {
                  ...prev,
                  displayName: scProfile.user?.username
                    ? `@${scProfile.user.username}`
                    : prev.displayName,
                  loading: false,
                  scData: scProfile,
                }
              : prev
          );
          if (scProfile.tracks && scProfile.tracks.length > 0) {
            setBrowserTracks(scProfile.tracks);
          }
        } else if (params.source === 'apple_music') {
          const appleProfile = await fetchAppleArtistProfile(params.idOrName);
          setActiveArtistProfile((prev) =>
            prev && prev.idOrName === params.idOrName
              ? {
                  ...prev,
                  displayName: appleProfile.artist?.name || prev.displayName,
                  loading: false,
                  appleData: appleProfile,
                }
              : prev
          );
          if (appleProfile.top_tracks && appleProfile.top_tracks.length > 0) {
            setBrowserTracks(appleProfile.top_tracks);
          }
        } else {
          const cleanName = params.idOrName.replace(/^name:/i, '').trim() || params.displayName;
          const localProfile = await fetchLocalArtistProfile(cleanName);
          setActiveArtistProfile((prev) =>
            prev && prev.idOrName === params.idOrName
              ? {
                  ...prev,
                  displayName: localProfile.name || prev.displayName,
                  loading: false,
                  localData: localProfile,
                }
              : prev
          );
          if (localProfile.tracks && localProfile.tracks.length > 0) {
            setBrowserTracks(localProfile.tracks);
          }
        }
      } catch (err: any) {
        showToast(err?.message || `Could not load artist profile for ${params.displayName}`);
        setActiveArtistProfile((prev) =>
          prev && prev.idOrName === params.idOrName ? { ...prev, loading: false } : prev
        );
      }
    },
    [pushCurrentNavState, applyFocusMarker, setBrowserTracks, showToast]
  );

  // Restore origin route + scroll straight to [data-section-anchor="..."] when clicking [Open Source ▸] in Imp FYP
  useEffect(() => {
    let pollTimer: number | undefined;
    const onRestoreOrigin = (ev: Event) => {
      const route = (ev as CustomEvent<FypOriginRoute>).detail;
      if (!route) return;
      if (pollTimer) window.clearInterval(pollTimer);
      setActiveMountRoot(null);
      setBrowserSearch('');
      const mappedHub: BrowseHubTarget =
        route.sourceFilter === 'apple_music'
          ? 'apple_discover'
          : route.sourceFilter === 'soundcloud'
          ? 'soundcloud_discover'
          : route.sourceFilter === 'internet_archive'
          ? 'ia_discover'
          : route.sourceFilter === 'local' || route.localSubTab
          ? 'local_discover'
          : 'imp_library';
      setBrowseHubTarget(mappedHub);
      if (route.artistProfile) {
        openArtistProfile(route.artistProfile);
      } else {
        pushCurrentNavState();
        setActiveArtistProfile(null);
        setRightPaneMode('browse');
        if (route.localSubTab) setLocalSubTab(route.localSubTab);
        if (route.appleSubTab) setAppleSubTab(route.appleSubTab);
        if (route.soundCloudSubTab) setSoundCloudSubTab(route.soundCloudSubTab);
        if (route.iaSubTab) setIaSubTab(route.iaSubTab);
        if (route.iaSubFilter !== undefined) setIaSubFilter(route.iaSubFilter);
        if (route.scSelectedGenre !== undefined) setScSelectedGenre(route.scSelectedGenre);
      }
      if (route.sectionAnchor) {
        let attempts = 0;
        pollTimer = window.setInterval(() => {
          attempts += 1;
          const anchorEl = document.querySelector<HTMLElement>(
            `[data-nav-col="right"] [data-section-anchor="${route.sectionAnchor}"]`
          );
          if (anchorEl) {
            if (pollTimer) window.clearInterval(pollTimer);
            pollTimer = undefined;
            anchorEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
            const firstItem = anchorEl.querySelector<HTMLElement>(
              '[data-right-tile="true"]:not([disabled]), [data-single-song-play="true"]:not([disabled]), [data-right-track="true"]:not([disabled])'
            );
            if (firstItem) {
              applyFocusMarker(firstItem);
            }
          } else if (attempts >= 15 && pollTimer) {
            window.clearInterval(pollTimer);
            pollTimer = undefined;
          }
        }, 80);
      }
    };
    window.addEventListener('simp-restore-origin-route', onRestoreOrigin);
    return () => {
      if (pollTimer) window.clearInterval(pollTimer);
      window.removeEventListener('simp-restore-origin-route', onRestoreOrigin);
    };
  }, [
    applyFocusMarker,
    openArtistProfile,
    pushCurrentNavState,
    setAppleSubTab,
    setBrowserSearch,
    setBrowserSourceFilter,
    setIaSubTab,
    setImpFypActive,
    setScSelectedGenre,
    setSoundCloudSubTab,
  ]);

  const loadMoreArtistTracks = useCallback(() => {
    const nextHref = activeArtistProfile?.scData?.next_tracks_href;
    if (
      !activeArtistProfile ||
      activeArtistProfile.source !== 'soundcloud' ||
      !nextHref ||
      activeArtistProfile.loadingMore
    ) {
      return;
    }
    const artistSource = activeArtistProfile.source;
    const artistDisplayName = activeArtistProfile.displayName;
    const startedOnLoadMore =
      document.querySelector<HTMLElement>('[data-simp-active-focus="true"]')?.dataset.loadMore ===
      'true';
    setActiveArtistProfile((prev) => (prev ? { ...prev, loadingMore: true } : prev));
    fetchSoundCloudNextPage(nextHref)
      .then((res) => {
        const transferSlot = transferFocusAfterLoadMore(startedOnLoadMore);
        setActiveArtistProfile((prev) => {
          if (!prev || !prev.scData) return prev;
          const seen = new Set(prev.scData.tracks.map((t) => t.uri));
          const added = (res.tracks || []).filter((t) => !seen.has(t.uri));
          if (transferSlot && added[0]) {
            transferSlot.firstTileKey = `song:artist:${artistSource}:${artistDisplayName}:${added[0].uri}`;
          }
          const updatedTracks = [...prev.scData.tracks, ...added];
          return {
            ...prev,
            loadingMore: false,
            scData: {
              ...prev.scData,
              tracks: updatedTracks,
              next_tracks_href: res.next_href || null,
            },
          };
        });
      })
      .catch(() => {
        setActiveArtistProfile((prev) => (prev ? { ...prev, loadingMore: false } : prev));
      });
  }, [activeArtistProfile, transferFocusAfterLoadMore]);

  useEffect(() => {
    const onOpenArtistEvent = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{
          artistName?: string;
          source?: 'apple_music' | 'soundcloud' | 'local';
          artistId?: string;
        }>
      ).detail;
      if (!detail || (!detail.artistName && !detail.artistId)) return;
      const source = detail.source || 'local';
      const idOrName = detail.artistId || `name:${detail.artistName}`;
      const displayName = detail.artistName || detail.artistId || 'Artist';
      openArtistProfile({ source, idOrName, displayName });
    };
    window.addEventListener('simp-open-artist-profile', onOpenArtistEvent);
    return () => window.removeEventListener('simp-open-artist-profile', onOpenArtistEvent);
  }, [openArtistProfile]);

  // Open a collection, switch the Right Pane to Tracklist view, and focus the first track
  const selectLocalCollection = (target: BrowserTarget) => {
    if (
      rightPaneMode === 'tracks' &&
      browserTarget?.kind === target.kind &&
      browserTarget?.id === target.id
    ) {
      focusRightPaneFirstTrack();
      return;
    }
    pushCurrentNavState({
      returnTileKey: `${target.kind}:${target.id}`,
      forceEvenOnPreview: xmbPreviewTriggerRef.current && rightPaneMode === 'browse',
    });
    setBrowserTarget(target);
    setRightPaneMode('tracks');
    focusRightPaneFirstTrack();
  };

  const selectCloudPlaylist = async (pl: AppleCloudPlaylistSummary) => {
    pushCurrentNavState({
      returnTileKey: `cloud_playlist:${pl.id}`,
    });
    setRightPaneMode('tracks');
    focusRightPaneFirstTrack();
    await handleOpenCloudPlaylist(pl);
  };

  const selectSoundCloudPlaylist = async (pl: SoundCloudPlaylistSummary) => {
    pushCurrentNavState({
      returnTileKey: `soundcloud_playlist:${pl.id}`,
    });
    setRightPaneMode('tracks');
    focusRightPaneFirstTrack();
    await handleOpenSoundCloudPlaylist(pl);
  };

  const selectSoundCloudUser = async (user: SoundCloudUserSummary) => {
    await openArtistProfile({
      source: 'soundcloud',
      idOrName: user.id,
      displayName: `@${user.username}`,
    });
  };

  const selectCloudAlbum = async (params: {
    albumId?: string | null;
    songUri?: string | null;
    fallbackTitle?: string;
  }) => {
    pushCurrentNavState({
      returnTileKey: params.albumId ? `cloud_album:${params.albumId}` : undefined,
    });
    setRightPaneMode('tracks');
    focusRightPaneFirstTrack();
    await handleOpenFullAppleAlbum(params);
  };

  const openLocalVideoFile = useCallback(
    (t: TrackMetadata, peerTracks?: TrackMetadata[], ctxId?: string) => {
      const normalizeVideoTrack = (tr: TrackMetadata): TrackMetadata => {
        if (tr.source === 'local_video' || tr.uri.startsWith('video://local/')) {
          const vUri = tr.uri.startsWith('video://local/')
            ? tr.uri
            : `video://local/${encodeURIComponent(tr.uri)}`;
          return {
            ...tr,
            uri: vUri,
            source: 'local_video',
          };
        }
        return tr;
      };
      const meta = normalizeVideoTrack({ ...t, source: 'local_video' });
      const rawPeers = peerTracks && peerTracks.length > 0 ? peerTracks : [meta];
      const normalizedPeers = rawPeers.map(normalizeVideoTrack);
      const startIndex = Math.max(
        0,
        normalizedPeers.findIndex((p) => p.uri === meta.uri || p.uri === t.uri)
      );
      setPlayingContextId(ctxId || `local_video:${meta.uri}`);
      defaultSimpClient.loadQueue(
        normalizedPeers.map((p) => p.uri),
        startIndex,
        normalizedPeers
      );
      setView('lock');
    },
    [setPlayingContextId, setView]
  );

  const openIaItem = useCallback(
    async (item: ArchiveItemSummary, watchImmediately = false) => {
      const preScrollTop =
        document.querySelector<HTMLElement>('[data-nav-col="right"]')?.scrollTop ?? 0;
      setIaLoading(true);
      try {
        const resp = await fetch(
          resolveDaemonUrl(`/api/ia/item?id=${encodeURIComponent(item.identifier)}`)
        );
        const d = await resp.json();
        const detail: ArchiveItemDetail | undefined = d?.detail || d?.data;
        if (!d?.ok || !detail) {
          showToast('Could not load Internet Archive item metadata');
          return;
        }
        setActiveIaDetail(detail);
        const itemTracks = detail.tracks || [];
        pushCurrentNavState({
          returnTileKey: `ia_item:${item.identifier}`,
          scrollTop: preScrollTop,
        });
        setBrowserTarget({
          kind: 'ia_item',
          id: detail.summary.identifier,
          title: detail.summary.title,
          subtitle: `${detail.summary.creator}${
            detail.summary.year ? ` • ${detail.summary.year}` : ''
          }`,
          art_url: detail.summary.art_url,
          content_rating: detail.summary.content_rating ?? null,
        });
        setBrowserTracks(itemTracks);
        setRightPaneMode('tracks');
        focusRightPaneFirstTrack();

        if (watchImmediately && itemTracks.length > 0) {
          setPlayingContextId(`ia_item:${detail.summary.identifier}`);
          defaultSimpClient.loadQueue(
            itemTracks.map((t) => t.uri),
            0,
            itemTracks
          );
          setView('lock');
        }
      } catch {
        showToast('Failed to fetch Internet Archive item');
      } finally {
        setIaLoading(false);
      }
    },
    [
      resolveDaemonUrl,
      pushCurrentNavState,
      setBrowserTarget,
      setBrowserTracks,
      focusRightPaneFirstTrack,
      setPlayingContextId,
      setView,
      showToast,
    ]
  );

  const handlePinArchiveItem = useCallback(
    async (item: ArchiveItemSummary, preloadedTracks?: TrackMetadata[]) => {
      setIaLoading(true);
      try {
        let tracksToPin = preloadedTracks;
        if (!tracksToPin || tracksToPin.length === 0) {
          const resp = await fetch(
            resolveDaemonUrl(`/api/ia/item?id=${encodeURIComponent(item.identifier)}`)
          );
          const d = await resp.json();
          const detail: ArchiveItemDetail | undefined = d?.detail || d?.data;
          tracksToPin = detail?.tracks || [];
        }
        if (!tracksToPin || tracksToPin.length === 0) {
          showToast('No playable video or audio streams found in this item');
          return;
        }
        const pinId = `archive:item:${item.identifier}`;
        const isVideo = item.mediatype === 'movies' || tracksToPin.some((t) => t.source === 'ia_video');
        const record: PlaylistRecord = {
          id: pinId,
          name: `${isVideo ? '🎬' : '🏛️'} ${item.title}`,
          description: `${item.creator}${item.year ? ` • ${item.year}` : ''}`,
          origin: 'archive_remote',
          cover_art_url: item.art_url || tracksToPin[0]?.art_url || null,
          track_count: tracksToPin.length,
          updated_at: Math.floor(Date.now() / 1000),
          has_local: false,
          has_apple: false,
          has_soundcloud: false,
          has_archive: true,
        };
        defaultSimpClient.importCatalogTracks({
          source: 'internet_archive',
          playlist: record,
          tracks: tracksToPin,
        });
        showToast(
          `Pinned "${item.title}" (${tracksToPin.length} ${
            tracksToPin.length === 1 ? 'item' : 'items'
          }) to SIMP`
        );
      } catch {
        showToast('Could not pin Internet Archive item');
      } finally {
        setIaLoading(false);
      }
    },
    [resolveDaemonUrl, showToast]
  );

  const handlePinArchiveCollection = useCallback(
    async (collectionKey: string, collectionLabel: string, items: ArchiveItemSummary[]) => {
      if (items.length === 0) return;
      setIaLoading(true);
      try {
        const tracksToPin: TrackMetadata[] = [];
        for (let idx = 0; idx < items.length; idx++) {
          const it = items[idx];
          if (it.mediatype === 'movies') {
            tracksToPin.push({
              uri: `ia:video:${encodeURIComponent(it.identifier)}/0`,
              title: it.title,
              artists: [it.creator || 'Internet Archive'],
              album: collectionLabel,
              album_id: `ia:${it.identifier}`,
              track_number: idx + 1,
              disc_number: 1,
              art_url: it.art_url,
              duration_ms: 0,
              source: 'ia_video',
            });
          } else {
            // For audio items in a collection, fetch the first playable track (or full item tracks if few)
            try {
              const resp = await fetch(
                resolveDaemonUrl(`/api/ia/item?id=${encodeURIComponent(it.identifier)}`)
              );
              const d = await resp.json();
              const detail: ArchiveItemDetail | undefined = d?.detail || d?.data;
              if (detail?.tracks && detail.tracks.length > 0) {
                tracksToPin.push(...detail.tracks.slice(0, 3));
              }
            } catch {}
          }
        }
        if (tracksToPin.length === 0) {
          showToast('Could not resolve playable items for this Archive collection');
          return;
        }
        const pinId = `archive:collection:${collectionKey}`;
        const record: PlaylistRecord = {
          id: pinId,
          name: `🏛️ ${collectionLabel}`,
          description: `Pinned Internet Archive Collection (${tracksToPin.length} items)`,
          origin: 'archive_remote',
          cover_art_url: items[0]?.art_url || tracksToPin[0]?.art_url || null,
          track_count: tracksToPin.length,
          updated_at: Math.floor(Date.now() / 1000),
          has_local: false,
          has_apple: false,
          has_soundcloud: false,
          has_archive: true,
        };
        defaultSimpClient.importCatalogTracks({
          source: 'internet_archive',
          playlist: record,
          tracks: tracksToPin,
        });
        showToast(`Pinned collection "${collectionLabel}" (${tracksToPin.length} items) to SIMP`);
      } catch {
        showToast('Could not pin Internet Archive collection');
      } finally {
        setIaLoading(false);
      }
    },
    [resolveDaemonUrl, showToast]
  );

  const handleAddArchiveItemToHybrid = useCallback(
    async (item: ArchiveItemSummary) => {
      setIaLoading(true);
      try {
        const resp = await fetch(
          resolveDaemonUrl(`/api/ia/item?id=${encodeURIComponent(item.identifier)}`)
        );
        const d = await resp.json();
        const detail: ArchiveItemDetail | undefined = d?.detail || d?.data;
        const tracks: TrackMetadata[] = detail?.tracks || [];
        if (tracks.length > 0) {
          await handleAddTracksToPlaylist(
            tracks.map((t) => t.uri),
            `${tracks.length === 1 ? `"${tracks[0].title}"` : `all ${tracks.length} items from "${item.title}"`}`,
            tracks
          );
        } else {
          showToast('No playable video or audio streams found in this item');
        }
      } catch {
        showToast('Could not add Internet Archive item');
      } finally {
        setIaLoading(false);
      }
    },
    [resolveDaemonUrl, handleAddTracksToPlaylist, showToast]
  );

  const activeHubLabel = browserSearch.trim()
    ? 'Search Results'
    : activeMountPlaceObj
    ? `💾 ${activeMountPlaceObj.label}`
    : browseHubTarget === 'imp_fyp'
    ? 'Imp FYP'
    : browseHubTarget === 'local_discover'
    ? localSubTab === 'artists'
      ? 'Local Artists'
      : localSubTab === 'albums'
      ? 'Local Albums'
      : localSubTab === 'folders'
      ? 'Mounts & Folders'
      : localSubTab === 'videos'
      ? 'Local Videos'
      : 'Local Overview'
    : browseHubTarget === 'imp_library'
    ? 'Imp Library'
    : browseHubTarget === 'ia_discover'
    ? iaSubTab === 'trending'
      ? 'Internet Archive Trending'
      : iaSubTab === 'films'
      ? 'Films & Cinema'
      : iaSubTab === 'tv'
      ? 'TV & Animation'
      : iaSubTab === 'audio'
      ? 'Live Concerts & Audio'
      : 'Imp Library (Archive)'
    : browseHubTarget === 'soundcloud_discover'
    ? soundCloudSubTab === 'likes_sets'
      ? 'SoundCloud Likes & Sets'
      : soundCloudSubTab === 'stream_radio'
      ? 'SoundCloud Stream & Radio'
      : soundCloudSubTab === 'trending'
      ? 'SoundCloud Trending & Mixes'
      : 'Imp Library (SoundCloud)'
    : appleSubTab === 'for_you'
    ? 'For You'
    : appleSubTab === 'cloud_playlists'
    ? 'Apple Playlists'
    : appleSubTab === 'new'
    ? 'New & Charts'
    : appleSubTab === 'radio'
    ? 'Radio'
    : 'Imp Library';

  const cycleTargetHybridPlaylist = useCallback(() => {
    if (writablePlaylists.length >= 2) {
      const activeIdx = Math.max(
        0,
        writablePlaylists.findIndex((wp) => wp.id === activePlaylistId)
      );
      const nextWp = writablePlaylists[(activeIdx + 1) % writablePlaylists.length];
      setActivePlaylistId(nextWp.id);
    } else {
      setPlaylistsOpen(true);
      setCreatingPlaylist(true);
    }
  }, [writablePlaylists, activePlaylistId, setActivePlaylistId, setCreatingPlaylist]);

  const handleAddSimpPlaylistToHybrid = useCallback(
    async (pl: PlaylistRecord) => {
      try {
        const items = await defaultSimpClient.query<TrackMetadata[]>('get_playlist_items', {
          playlist_id: pl.id,
          limit: 2000,
          offset: 0,
        });
        if (items.length > 0) {
          await handleAddTracksToPlaylist(
            items.map((t) => t.uri),
            `all ${items.length} tracks from "${cleanCollectionTitle(pl.name)}"`,
            items
          );
        }
      } catch {
        // Handled by parent toast
      }
    },
    [handleAddTracksToPlaylist]
  );

  const handleAddSimpAlbumToHybrid = useCallback(
    async (alb: AlbumRecord) => {
      try {
        const items = await defaultSimpClient.query<TrackMetadata[]>('get_album_tracks', {
          album_id: alb.id,
        });
        if (items.length > 0) {
          await handleAddTracksToPlaylist(
            items.map((t) => t.uri),
            `all ${items.length} tracks from "${cleanCollectionTitle(alb.title)}"`,
            items
          );
        }
      } catch {
        // Handled by parent toast
      }
    },
    [handleAddTracksToPlaylist]
  );

  const handleTogglePinLocalAlbum = useCallback(
    async (alb: AlbumRecord, preloadedTracks?: TrackMetadata[]) => {
      const pinId = `local:album:${alb.id}`;
      const cleanTitle = cleanCollectionTitle(alb.title);
      const isAlreadyPinned = playlists.some((p) => p.id === pinId);
      if (isAlreadyPinned) {
        handleDeletePlaylist(pinId, cleanTitle);
        return;
      }
      try {
        let items = preloadedTracks;
        if (!items || items.length === 0) {
          items = await defaultSimpClient.query<TrackMetadata[]>('get_album_tracks', {
            album_id: alb.id,
          });
        }
        if (!items || items.length === 0) {
          showToast('No tracks found for this local album');
          return;
        }
        const record: PlaylistRecord = {
          id: pinId,
          name: `💾 ${cleanTitle}`,
          description: alb.album_artist,
          origin: 'local_pinned',
          cover_art_url: alb.art_url || items[0]?.art_url || null,
          track_count: items.length,
          updated_at: Math.floor(Date.now() / 1000),
          has_local: true,
          has_apple: false,
          has_soundcloud: false,
          has_archive: false,
        };
        defaultSimpClient.importCatalogTracks({
          source: 'local',
          playlist: record,
          tracks: items,
        });
        showToast(
          `Pinned "${cleanTitle}" (${items.length} ${
            items.length === 1 ? 'track' : 'tracks'
          }) to SIMP Library`
        );
      } catch {
        showToast('Could not pin local album to SIMP Library');
      }
    },
    [playlists, handleDeletePlaylist, showToast]
  );

  const handleAddCloudPlaylistToHybrid = useCallback(
    async (pl: AppleCloudPlaylistSummary) => {
      setCloudLoading(true);
      try {
        const items = await fetchApplePlaylistTracks(pl.id, pl.kind);
        if (items.length > 0) {
          await handleAddTracksToPlaylist(
            items.map((t) => t.uri),
            `all ${items.length} tracks from "${pl.name}"`,
            items
          );
        }
      } catch {
        // Handled by parent toast
      } finally {
        setCloudLoading(false);
      }
    },
    [handleAddTracksToPlaylist, setCloudLoading]
  );

  const handleAddCloudAlbumToHybrid = useCallback(
    async (alb: AppleCloudAlbumSummary) => {
      setCloudLoading(true);
      try {
        const { tracks } = await fetchFullAppleAlbum({ albumId: alb.id });
        if (tracks.length > 0) {
          await handleAddTracksToPlaylist(
            tracks.map((t) => t.uri),
            `all ${tracks.length} tracks from "${alb.title}"`,
            tracks
          );
        }
      } catch {
        // Handled by parent toast
      } finally {
        setCloudLoading(false);
      }
    },
    [handleAddTracksToPlaylist, setCloudLoading]
  );

  const handleAddSoundCloudPlaylistToHybrid = useCallback(
    async (pl: SoundCloudPlaylistSummary) => {
      setCloudLoading(true);
      try {
        let items = await fetchSoundCloudPlaylistTracks(pl.id).catch(() => []);
        if (items.length === 0 && pl.tracks && pl.tracks.length > 0) {
          items = pl.tracks;
        }
        if (items.length > 0) {
          await handleAddTracksToPlaylist(
            items.map((t) => t.uri),
            `all ${items.length} tracks from "${pl.name}"`,
            items
          );
        }
      } catch {
        // Handled by parent toast
      } finally {
        setCloudLoading(false);
      }
    },
    [handleAddTracksToPlaylist, setCloudLoading]
  );

  const collectShelfActionsFromDom = useCallback(
    (focusedEl: HTMLElement | null, includeAllRightPaneShelves: boolean): LibraryShelfAction[] => {
      const toAction = (btn: HTMLElement): LibraryShelfAction | null => {
        const shelfUid = btn.dataset.fypShelfUid;
        if (!shelfUid) return null;
        const rect = btn.getBoundingClientRect();
        if (rect.width <= 0 && rect.height <= 0) return null;
        const sectionEl = btn.closest<HTMLElement>('section');
        const openBtn = sectionEl?.querySelector<HTMLElement>('[data-fyp-open-source-btn="true"]');
        return {
          shelfUid,
          title: btn.dataset.fypShelfTitle || sectionEl?.dataset.fypShelfTitle || 'Section',
          isPinned: btn.dataset.fypShelfPinned === 'true',
          triggerClick: () => btn.click(),
          openSourceClick: openBtn ? () => openBtn.click() : undefined,
        };
      };

      const sectionEl = focusedEl?.closest<HTMLElement>('[data-nav-col="right"] section');
      const sectionBtn = sectionEl?.querySelector<HTMLElement>('[data-fyp-pin-btn="true"]');
      if (sectionBtn) {
        const one = toAction(sectionBtn);
        if (one) return [one];
      }
      if (!includeAllRightPaneShelves) return [];

      const seen = new Set<string>();
      const actions: LibraryShelfAction[] = [];
      document
        .querySelectorAll<HTMLElement>('[data-nav-col="right"] [data-fyp-pin-btn="true"]')
        .forEach((btn) => {
          const action = toAction(btn);
          if (action && !seen.has(action.shelfUid)) {
            seen.add(action.shelfUid);
            actions.push(action);
          }
        });
      return actions;
    },
    []
  );

  const contextMenuReturnElRef = useRef<HTMLElement | null>(null);

  const openLibraryContextMenu = useCallback(
    (target: LibraryContextTarget) => {
      contextMenuReturnElRef.current =
        (document.querySelector<HTMLElement>('[data-simp-active-focus="true"]') as HTMLElement | null) ||
        (document.activeElement as HTMLElement | null);
      let enriched = target;
      if (target.type !== 'shelf' && !target.shelfActions?.length) {
        const focusedEl = document.querySelector<HTMLElement>('[data-simp-active-focus="true"]');
        const shelfActions = collectShelfActionsFromDom(focusedEl, false);
        if (shelfActions.length > 0) {
          enriched = { ...target, shelfActions };
        }
      }
      setLibraryContextTarget(enriched);
      window.setTimeout(() => {
        const firstBtn = document.querySelector<HTMLElement>(
          '[data-library-context-modal="true"] button[data-default-focus="true"], [data-library-context-modal="true"] button:not([disabled])'
        );
        if (firstBtn) applyFocusMarker(firstBtn);
      }, 30);
    },
    [applyFocusMarker, collectShelfActionsFromDom]
  );

  const closeLibraryContextMenu = useCallback(() => {
    const returnEl = contextMenuReturnElRef.current;
    contextMenuReturnElRef.current = null;
    setLibraryContextTarget(null);
    window.setTimeout(() => {
      const target =
        (returnEl && document.body.contains(returnEl) ? returnEl : null) ||
        (rightPaneMode === 'tracks'
          ? document.querySelector<HTMLElement>(
              '[data-nav-col="right"] [data-right-track="true"][data-track-playing="true"]'
            ) ||
            document.querySelector<HTMLElement>(
              '[data-nav-col="right"] [data-right-track="true"]'
            )
          : null);
      if (target) applyFocusMarker(target);
    }, 25);
  }, [applyFocusMarker, rightPaneMode]);

  // Inserts one or more tracks into the active playback queue immediately after the current track
  // (`snap.queue_index + 1`) without wiping or restarting the rest of the playing album/playlist.
  const handlePlayTracksNext = useCallback(
    (tracksToInsert: TrackMetadata[], label: string) => {
      if (tracksToInsert.length === 0) return;
      const currentQueue = snap?.queue || [];
      if (currentQueue.length === 0 || !track) {
        defaultSimpClient.loadQueue(
          tracksToInsert.map((t) => t.uri),
          0,
          tracksToInsert
        );
        showToast(`Playing ${label}`);
        return;
      }
      const curIdx = Math.max(
        0,
        Math.min(currentQueue.length - 1, snap?.queue_index ?? 0)
      );
      const nextQueue = [
        ...currentQueue.slice(0, curIdx + 1),
        ...tracksToInsert,
        ...currentQueue.slice(curIdx + 1),
      ];
      defaultSimpClient.loadQueue(
        nextQueue.map((t) => t.uri),
        curIdx,
        nextQueue
      );
      showToast(`⏭ Queued ${label} to play next`);
    },
    [snap?.queue, snap?.queue_index, track, showToast]
  );

  const resolveCollectionTracks = useCallback(
    async (
      target: Extract<LibraryContextTarget, { type: 'collection' }>
    ): Promise<TrackMetadata[]> => {
      if (target.kind === 'simp_playlist') {
        return defaultSimpClient.query<TrackMetadata[]>('get_playlist_items', {
          playlist_id: target.id,
          limit: 2000,
          offset: 0,
        });
      }
      if (target.kind === 'simp_album') {
        return defaultSimpClient.query<TrackMetadata[]>('get_album_tracks', {
          album_id: target.id,
        });
      }
      if (target.kind === 'cloud_playlist') {
        const pl = target.rawItem as AppleCloudPlaylistSummary;
        return fetchApplePlaylistTracks(pl.id, pl.kind);
      }
      if (target.kind === 'cloud_album') {
        const alb = target.rawItem as AppleCloudAlbumSummary;
        const { tracks } = await fetchFullAppleAlbum({ albumId: alb.id });
        return tracks;
      }
      if (target.kind === 'sc_playlist') {
        const pl = target.rawItem as SoundCloudPlaylistSummary;
        const items = await fetchSoundCloudPlaylistTracks(pl.id).catch(() => []);
        return items.length > 0 ? items : pl.tracks || [];
      }
      if (target.kind === 'ia_item') {
        const item = target.rawItem as ArchiveItemSummary;
        const resp = await fetch(
          resolveDaemonUrl(`/api/ia/item?id=${encodeURIComponent(item.identifier)}`)
        );
        const d = await resp.json();
        const detail: ArchiveItemDetail | undefined = d?.detail || d?.data;
        return detail?.tracks || [];
      }
      if (target.kind === 'local_station') {
        const st = target.rawItem as LocalSmartStation;
        return st.tracks || [];
      }
      if (target.kind === 'mount') {
        return defaultSimpClient.query<TrackMetadata[]>('get_tracks', {
          source: null,
          mount_root: target.id,
          search: null,
          limit: 2000,
          offset: 0,
        });
      }
      return [];
    },
    [resolveDaemonUrl]
  );

  // Listen for `SELECT` (Contextual Action Menu), `Y` (`filter`), and `X` (`toggle_collapse`) gamepad/keyboard actions
  useEffect(() => {
    if (hidden) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ op: 'filter' | 'toggle_collapse' | 'select' }>).detail;
      if (!detail) return;
      const focused = document.querySelector<HTMLElement>('[data-simp-active-focus="true"]');

      if (detail.op === 'filter') {
        if (libraryContextTarget) {
          setLibraryContextTarget(null);
        }
        setFilterModalOpen((prev) => {
          const next = !prev;
          if (next) {
            focusDefaultFilterOption();
          }
          return next;
        });
        return;
      }

      if (detail.op === 'toggle_collapse') {
        if (filterModalOpen || libraryContextTarget) return;
        const leftColEl = focused?.closest<HTMLElement>('[data-nav-col="left"]');
        if (leftColEl && focused) {
          const collapseKey =
            focused.closest<HTMLElement>('[data-rail-collapse-key]')?.dataset.railCollapseKey;
          if (collapseKey) {
            window.dispatchEvent(
              new CustomEvent('simp-left-rail-toggle-collapse', { detail: { key: collapseKey } })
            );
            window.requestAnimationFrame(() => {
              const headerBtn = document.querySelector<HTMLElement>(
                `[data-nav-col="left"] button[data-rail-collapse-key="${collapseKey}"]:not([disabled])`
              );
              if (headerBtn) applyFocusMarker(headerBtn);
            });
          }
          return;
        }
        const rightColEl = focused?.closest<HTMLElement>('[data-nav-col="right"]');
        if (rightColEl && focused) {
          const sectionEl = focused.closest<HTMLElement>('section[data-section-anchor]');
          const shelfUid = sectionEl
            ?.querySelector<HTMLElement>('[data-section-shelf-uid]')
            ?.dataset.sectionShelfUid;
          if (sectionEl && shelfUid) {
            const nowCollapsed = toggleSectionCollapsed(shelfUid);
            window.requestAnimationFrame(() => {
              if (nowCollapsed) {
                const collapsedBar = sectionEl.querySelector<HTMLElement>(
                  `[data-section-collapsed-bar="${shelfUid}"]`
                );
                if (collapsedBar) applyFocusMarker(collapsedBar);
              } else {
                const firstInner = sectionEl.querySelector<HTMLElement>(
                  '[data-right-tile="true"]:not([data-no-dpad-focus="true"]):not([disabled]), [data-single-song-play="true"]:not([disabled]), [data-right-track="true"]:not([disabled])'
                );
                if (firstInner) applyFocusMarker(firstInner);
              }
            });
          }
        }
        return;
      }

      if (detail.op === 'select') {
        if (filterModalOpen) {
          setFilterModalOpen(false);
          return;
        }
        if (libraryContextTarget) {
          closeLibraryContextMenu();
          return;
        }
        // 1. Focused on (or inside) a single track row -> trigger contextmenu (or fallback to `[data-track-select="true"]`)
        let trackRow = focused?.closest<HTMLElement>(
          '[data-right-track="true"], [data-single-song-row="true"]'
        );
        if (!trackRow && rightPaneMode === 'tracks' && !focused?.dataset.leftContextKind) {
          const fallbackRow =
            document.querySelector<HTMLElement>(
              '[data-nav-col="right"] [data-right-track="true"][data-track-playing="true"]'
            ) ||
            document.querySelector<HTMLElement>(
              '[data-nav-col="right"] [data-right-track="true"]'
            );
          if (fallbackRow) {
            applyFocusMarker(fallbackRow);
            trackRow = fallbackRow;
          }
        }
        if (trackRow) {
          const sameFocusedRow =
            focused?.closest<HTMLElement>('[data-right-track="true"], [data-single-song-row="true"]') ===
            trackRow;
          const trackCtxBtn =
            (sameFocusedRow ? focused?.querySelector<HTMLElement>('[data-context-select="true"]') : null) ||
            trackRow.querySelector<HTMLElement>('[data-context-select="true"]');
          if (trackCtxBtn) {
            trackCtxBtn.click();
            return;
          }
          const handledByContextMenu = !trackRow.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
          );
          if (handledByContextMenu) {
            return;
          }
          const trackFallback =
            (sameFocusedRow ? focused?.querySelector<HTMLElement>('[data-track-select="true"]') : null) ||
            trackRow.querySelector<HTMLElement>('[data-track-select="true"]');
          if (trackFallback) {
            trackFallback.click();
            return;
          }
        }

        // 2. Focused on a Right-Pane Collection Tile -> trigger contextmenu (or fallback to `[data-tile-select="true"]`)
        const tileEl =
          focused?.dataset.rightTile === 'true'
            ? focused
            : focused?.closest<HTMLElement>('[data-right-tile="true"]');
        if (tileEl) {
          const tileCtxBtn = tileEl.querySelector<HTMLElement>('[data-context-select="true"]');
          if (tileCtxBtn) {
            tileCtxBtn.click();
            return;
          }
          const handledByContextMenu = !tileEl.dispatchEvent(
            new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
          );
          if (handledByContextMenu) {
            return;
          }
          const tileFallback = tileEl.querySelector<HTMLElement>('[data-tile-select="true"]');
          if (tileFallback) {
            tileFallback.click();
            return;
          }
        }

        // 3. Focused on a Left-Column album, playlist, or storage mount -> open contextual menu
        const leftCtxKind = focused?.dataset.leftContextKind;
        const leftCtxId = focused?.dataset.leftContextId;
        if (leftCtxKind === 'simp_album' && leftCtxId) {
          const alb = albums.find((a) => a.id === leftCtxId);
          if (alb) {
            openLibraryContextMenu({
              type: 'collection',
              kind: 'simp_album',
              id: alb.id,
              title: cleanCollectionTitle(alb.title),
              subtitle: `${alb.album_artist} • ${alb.track_count} tracks`,
              art_url: alb.art_url,
              source: alb.id.startsWith('applemusic:album:') ? 'apple_music' : 'local',
              rawItem: alb,
            });
            return;
          }
        } else if (leftCtxKind === 'simp_playlist' && leftCtxId) {
          const pl = playlists.find((p) => p.id === leftCtxId);
          if (pl) {
            openLibraryContextMenu({
              type: 'collection',
              kind: 'simp_playlist',
              id: pl.id,
              title: cleanCollectionTitle(pl.name),
              subtitle: `${pl.track_count} tracks`,
              art_url: pl.cover_art_url,
              source:
                pl.origin === 'apple_remote'
                  ? 'apple_music'
                  : pl.origin === 'soundcloud_remote'
                    ? 'soundcloud'
                    : pl.origin === 'archive_remote'
                      ? 'internet_archive'
                      : 'local',
              rawItem: pl,
            });
            return;
          }
        } else if (leftCtxKind === 'mount' && leftCtxId) {
          const m = snap?.mounts.find((mnt) => mnt.mount_root === leftCtxId);
          if (m) {
            openLibraryContextMenu({
              type: 'collection',
              kind: 'mount',
              id: m.mount_root,
              title: m.label,
              subtitle: `${m.track_count} tracks`,
              source: 'local',
              rawItem: m,
            });
            return;
          }
        }

        // 3b. Focused in the Right Pane (Section header/FYP button or top-level filter/hub controls) -> open Imp FYP / Collection Actions modal
        if (focused?.closest('[data-nav-col="right"]')) {
          if (focused.dataset.fypPinBtn === 'true' || focused.dataset.fypOpenSourceBtn === 'true') {
            const shelfActions = collectShelfActionsFromDom(focused, false);
            if (shelfActions.length > 0) {
              openLibraryContextMenu({
                type: 'shelf',
                title: focused.dataset.fypShelfTitle || shelfActions[0].title,
                subtitle: 'Section & Imp FYP Options',
                shelfActions,
              });
              return;
            }
          }

          if (rightPaneMode === 'browse' || rightPaneMode === 'artist') {
            const shelfActions = collectShelfActionsFromDom(focused, true);
            const pinCollBtn = document.querySelector<HTMLElement>(
              '[data-nav-col="right"] [data-right-pin-collection="true"]'
            );
            const pinCollRect = pinCollBtn?.getBoundingClientRect();
            const hasPinCollBtn =
              Boolean(pinCollBtn && pinCollRect && pinCollRect.width > 0 && pinCollRect.height > 0);
            if (shelfActions.length > 0 || hasPinCollBtn) {
              openLibraryContextMenu({
                type: 'shelf',
                title:
                  rightPaneMode === 'artist'
                    ? activeArtistProfile?.displayName || 'Artist Profile'
                    : activeHubLabel || 'Imp Library',
                subtitle: 'Imp FYP & Collection Actions',
                shelfActions,
                pinArchiveCollectionClick: hasPinCollBtn && pinCollBtn ? () => pinCollBtn.click() : undefined,
                pinArchiveCollectionLabel: hasPinCollBtn && pinCollBtn
                  ? pinCollBtn.textContent?.trim() || 'Pin Collection'
                  : undefined,
              });
              return;
            }
          }
        }

        // 5. Fallback: cycle active ★ SIMP Hybrid Playlist target
        cycleTargetHybridPlaylist();
      }
    };
    window.addEventListener('simp-browser-gamepad-op', handler);
    return () => window.removeEventListener('simp-browser-gamepad-op', handler);
  }, [
    hidden,
    filterModalOpen,
    albums,
    playlists,
    snap?.mounts,
    applyFocusMarker,
    focusDefaultFilterOption,
    cycleTargetHybridPlaylist,
    rightPaneMode,
    libraryContextTarget,
    collectShelfActionsFromDom,
    openLibraryContextMenu,
    closeLibraryContextMenu,
    activeHubLabel,
    activeArtistProfile,
  ]);

  // Context Legend & Collection Action Bar (Target pill retired; SELECT/Y badges hidden in mouse mode)
  const renderContextLegendBar = () => (
    <LibraryContextLegendBar
      rightPaneMode={rightPaneMode}
      browserTarget={browserTarget}
      selectedPlaylistObj={selectedPlaylistObj}
      selectedAlbumObj={selectedAlbumObj}
      activeCloudPlaylist={activeCloudPlaylist}
      activeScPlaylist={activeScPlaylist}
      activeCloudAlbum={activeCloudAlbum}
      activeIaDetail={activeIaDetail}
      playlists={playlists}
      albums={albums}
      browserTracks={browserTracks}
      canWalkBackInBrowse={canWalkBackInBrowse}
      handleWalkBack={handleWalkBack}
      handleAddTracksToPlaylist={handleAddTracksToPlaylist}
      handleDeletePlaylist={handleDeletePlaylist}
      handlePinCloudPlaylist={handlePinCloudPlaylist}
      handlePinSoundCloudPlaylist={handlePinSoundCloudPlaylist}
      handleDeleteAlbum={handleDeleteAlbum}
      handlePinCloudAlbum={handlePinCloudAlbum}
      handlePinArchiveItem={handlePinArchiveItem}
      handleTogglePinLocalAlbum={handleTogglePinLocalAlbum}
      setRightPaneMode={setRightPaneMode}
    />
  );

  const editableAppleIdSet = useMemo(
    () =>
      new Set(
        cloudPlaylists
          .filter((cp) => Boolean(cp.can_edit) || cp.id.startsWith('p.'))
          .map((cp) => cp.id)
      ),
    [cloudPlaylists]
  );
  const editableScIdSet = useMemo(
    () =>
      new Set(
        scPlaylists
          .filter((sp) => sp.kind === 'user_set')
          .map((sp) => sp.id.replace(/^soundcloud:playlist:/, ''))
      ),
    [scPlaylists]
  );

  const renderSimpPlaylistCard = (pl: PlaylistRecord) => {
    const isEditableRemote =
      pl.origin === 'apple_remote'
        ? editableAppleIdSet.has(pl.id.replace(/^applemusic:playlist:/, ''))
        : pl.origin === 'soundcloud_remote'
          ? editableScIdSet.has(pl.id.replace(/^soundcloud:playlist:/, ''))
          : undefined;
    return (
      <SimpPlaylistCard
        key={pl.id}
        pl={pl}
        activePlaylistId={activePlaylistId}
        rightPaneMode={rightPaneMode}
        browserTarget={browserTarget}
        isEditableRemote={isEditableRemote}
        setActivePlaylistId={setActivePlaylistId}
        selectLocalCollection={selectLocalCollection}
        openLibraryContextMenu={openLibraryContextMenu}
        handleAddSimpPlaylistToHybrid={handleAddSimpPlaylistToHybrid}
        handleDeletePlaylist={handleDeletePlaylist}
      />
    );
  };

  const renderSimpAlbumCard = (alb: AlbumRecord) => (
    <SimpAlbumCard
      key={alb.id}
      alb={alb}
      playlists={playlists}
      rightPaneMode={rightPaneMode}
      browserTarget={browserTarget}
      selectLocalCollection={selectLocalCollection}
      openLibraryContextMenu={openLibraryContextMenu}
      handleAddSimpAlbumToHybrid={handleAddSimpAlbumToHybrid}
      handleDeleteAlbum={handleDeleteAlbum}
      handleTogglePinLocalAlbum={handleTogglePinLocalAlbum}
    />
  );

  const renderCloudPlaylistCard = (pl: AppleCloudPlaylistSummary) => (
    <CloudPlaylistCard
      key={pl.id}
      pl={pl}
      playlists={playlists}
      browserTarget={browserTarget}
      selectCloudPlaylist={selectCloudPlaylist}
      setCloudPlaylists={setCloudPlaylists}
      openLibraryContextMenu={openLibraryContextMenu}
      handleAddAppleToCloudLibrary={handleAddAppleToCloudLibrary}
      handleAddCloudPlaylistToHybrid={handleAddCloudPlaylistToHybrid}
      handleDeletePlaylist={handleDeletePlaylist}
      handlePinCloudPlaylist={handlePinCloudPlaylist}
    />
  );

  const renderCloudAlbumCard = (alb: AppleCloudAlbumSummary) => (
    <CloudAlbumCard
      key={alb.id}
      alb={alb}
      albums={albums}
      browserTarget={browserTarget}
      selectCloudAlbum={selectCloudAlbum}
      openLibraryContextMenu={openLibraryContextMenu}
      handleAddAppleToCloudLibrary={handleAddAppleToCloudLibrary}
      handleAddCloudAlbumToHybrid={handleAddCloudAlbumToHybrid}
      handleDeleteAlbum={handleDeleteAlbum}
      setCloudLoading={setCloudLoading}
      handlePinCloudAlbum={handlePinCloudAlbum}
    />
  );

  const renderStationCard = (st: AppleRadioStationSummary) => (
    <StationCard
      key={st.id}
      st={st}
      playingContextId={playingContextId}
      handleStartAppleStation={handleStartAppleStation}
      openLibraryContextMenu={openLibraryContextMenu}
    />
  );

  const renderSoundCloudPlaylistCard = (pl: SoundCloudPlaylistSummary) => (
    <SoundCloudPlaylistCard
      key={pl.id}
      pl={pl}
      playlists={playlists}
      browserTarget={browserTarget}
      selectSoundCloudPlaylist={selectSoundCloudPlaylist}
      openLibraryContextMenu={openLibraryContextMenu}
      handleAddSoundCloudPlaylistToHybrid={handleAddSoundCloudPlaylistToHybrid}
      handleDeletePlaylist={handleDeletePlaylist}
      handlePinSoundCloudPlaylist={handlePinSoundCloudPlaylist}
    />
  );

  const renderSoundCloudUserCard = (user: SoundCloudUserSummary) => (
    <SoundCloudUserCard
      key={user.id}
      user={user}
      browserTarget={browserTarget}
      selectSoundCloudUser={selectSoundCloudUser}
      openLibraryContextMenu={openLibraryContextMenu}
    />
  );

  const renderAppleArtistCard = (artist: AppleArtistSummary) => (
    <AppleArtistCard
      key={artist.id}
      artist={artist}
      isSelected={
        rightPaneMode === "artist" &&
        activeArtistProfile?.source === "apple_music" &&
        activeArtistProfile?.idOrName === artist.id
      }
      openLibraryContextMenu={openLibraryContextMenu}
      onSelect={() =>
        openArtistProfile({
          source: "apple_music",
          idOrName: artist.id,
          displayName: artist.name,
        })
      }
    />
  );

  const renderLocalArtistCard = (
    artistName: string,
    artUrl?: string | null,
    subtitle?: string
  ) => (
    <LocalArtistCard
      key={`local-artist-${artistName}`}
      artistName={artistName}
      artUrl={artUrl}
      subtitle={subtitle}
      isSelected={
        rightPaneMode === "artist" &&
        activeArtistProfile?.source === "local" &&
        activeArtistProfile?.displayName.toLowerCase() === artistName.toLowerCase()
      }
      openLibraryContextMenu={openLibraryContextMenu}
      onSelect={() =>
        openArtistProfile({
          source: "local",
          idOrName: `name:${artistName}`,
          displayName: artistName,
        })
      }
    />
  );

  const renderArchiveItemCard = (item: ArchiveItemSummary) => (
    <ArchiveItemCard
      key={item.identifier}
      item={item}
      playlists={playlists}
      browserTarget={browserTarget}
      iaResolvedCounts={iaResolvedCounts}
      iaResolvedRatings={iaResolvedRatings}
      openIaItem={openIaItem}
      openLibraryContextMenu={openLibraryContextMenu}
      handleAddArchiveItemToHybrid={handleAddArchiveItemToHybrid}
      handleDeletePlaylist={handleDeletePlaylist}
      handlePinArchiveItem={handlePinArchiveItem}
    />
  );

  const renderSingleSongRow = (
    s: TrackMetadata,
    peerList: TrackMetadata[],
    ctxPrefix: string,
    compact = false
  ) => (
    <SingleSongRow
      key={`${ctxPrefix}-${s.uri}`}
      song={s}
      peerList={peerList}
      ctxPrefix={ctxPrefix}
      compact={compact}
      track={track}
      snap={snap}
      favoritedUris={favoritedUris}
      scLikedTracks={scLikedTracks}
      openLocalVideoFile={openLocalVideoFile}
      showToast={showToast}
      setPlayingContextId={setPlayingContextId}
      setView={setView}
      openLibraryContextMenu={openLibraryContextMenu}
      openArtistProfile={openArtistProfile}
      handleFavoriteTrack={handleFavoriteTrack}
      handleAddTracksToPlaylist={handleAddTracksToPlaylist}
      handleStartSoundCloudTrackRadio={handleStartSoundCloudTrackRadio}
      handleAddAppleToCloudLibrary={handleAddAppleToCloudLibrary}
      selectCloudAlbum={selectCloudAlbum}
      selectLocalAlbum={(albumId, albumTitle, artistName, artUrl) =>
        selectLocalCollection({
          kind: 'album',
          id: albumId,
          title: albumTitle,
          subtitle: artistName,
          art_url: artUrl,
        })
      }
    />
  );

  const libTheme = getSourceThemeForLibraryFilter(
    browserSourceFilter,
    undefined,
    track?.uri,
  );
  const libCssVars = getSourceThemeCssVars(libTheme);

  const [libraryScale, setLibraryScale] = useState<number>(() =>
    computeLibraryViewportScale()
  );

  useEffect(() => {
    const onResize = () => {
      setLibraryScale(computeLibraryViewportScale());
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <main
      style={{
        flex: 1,
        display: hidden ? 'none' : 'grid',
        gridTemplateColumns: 'clamp(276px, 24.5%, 360px) minmax(0, 1fr)',
        gridTemplateRows: 'auto minmax(0, 1fr)',
        overflow: 'hidden',
        boxSizing: 'border-box',
        width: '100%',
        minWidth: 0,
        zoom: libraryScale > 1.02 ? libraryScale : undefined,
        ...libCssVars,
      }}
    >
      <style id="simp-section-collapse-css">
        {'[data-section-collapsed-header="true"] ~ * { display: none !important; }'}
      </style>
      {/* =====================================================================
          PERMANENT 2-ROW TOP HEADER SPLIT:
          - Top-Left: Unified Search Bar (Row 1) + Source Filter Pills (Row 2)
          - Top-Right: Unified 2-Row Miniplayer, Transport, Volume/Brightness, SELECT/EQ & START
         ===================================================================== */}
      <div
        data-nav-col="left"
        style={{
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 4,
          minHeight: 84,
          padding: '6px 14px',
          background: '#06070b',
          borderRight: '1px solid #16161c',
          borderBottom: `1px solid ${browserSearch ? libTheme.accentBorder : '#181a24'}`,
          boxSizing: 'border-box',
          minWidth: 0,
        }}
      >
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', width: '100%' }}>
          <span
            style={{
              position: 'absolute',
              left: 10,
              display: 'inline-flex',
              alignItems: 'center',
              color: browserSearch ? libTheme.accent : '#64748b',
              pointerEvents: 'none',
            }}
          >
            <ImpIcon name="search" size={14} />
          </span>
          <input
            type="text"
            data-osk-input="search"
            placeholder={
              browserSourceFilter === 'local'
                ? 'Filter local playlists, albums, or tracks...'
                : browserSourceFilter === 'soundcloud'
                ? 'Search SoundCloud Tracks, Sets & DJ Mixes...'
                : browserSourceFilter === 'internet_archive'
                ? 'Search Internet Archive Films, TV & Audio...'
                : 'Search SIMP Library, Apple Music, SoundCloud & Archive...'
            }
            value={browserSearch}
            onChange={(e) => {
              const nextVal = e.target.value;
              setBrowserSearch(nextVal);
              if (nextVal.trim() && rightPaneMode !== 'browse') {
                setRightPaneMode('browse');
              }
            }}
            onClick={(e) => {
              if (e.detail === 0 || document.documentElement.dataset.simpInput === 'gamepad') {
                setOskTarget('search');
                if (window.parent && window.parent !== window) {
                  window.parent.postMessage({ type: 'SIMP_OPEN_OSK' }, '*');
                }
              }
            }}
            style={{
              width: '100%',
              minHeight: 26,
              padding: browserSearch ? '0 58px 0 32px' : '0 34px 0 32px',
              borderRadius: 8,
              background: '#08080c',
              border: browserSearch ? `1px solid ${libTheme.accent}` : '1px solid #242430',
              color: '#d4d4dc',
              fontSize: 12,
              boxSizing: 'border-box',
            }}
          />
          <button
            data-row-aux="true"
            onClick={() => {
              setOskTarget((prev) => (prev === 'search' ? null : 'search'));
              if (window.parent && window.parent !== window) {
                window.parent.postMessage({ type: 'SIMP_OPEN_OSK' }, '*');
              }
            }}
            title="Toggle On-Screen Keyboard"
            style={{
              position: 'absolute',
              right: browserSearch ? 32 : 6,
              width: 22,
              height: 22,
              borderRadius: 6,
              background: '#12121a',
              border: '1px solid #242432',
              color: '#9ca3af',
              fontSize: 11,
              cursor: 'pointer',
              padding: 0,
            }}
          >
            ⌨
          </button>
          {browserSearch && (
            <button
              data-row-aux="true"
              data-clear-search="true"
              onClick={() => setBrowserSearch('')}
              title="Clear search"
              style={{
                position: 'absolute',
                right: 6,
                width: 22,
                height: 22,
                borderRadius: 6,
                background: '#161622',
                border: '1px solid #2e2e3c',
                color: '#9ca3af',
                fontSize: 11,
                cursor: 'pointer',
                padding: 0,
              }}
            >
              ✕
            </button>
          )}
        </div>
        <LibrarySourceFilterPills
          browserSourceFilter={browserSourceFilter}
          selectedSources={selectedSources}
          setSelectedSources={setSelectedSources}
          setBrowserSourceFilterRaw={setBrowserSourceFilterRaw}
          sourceVisibility={sourceVisibility}
          snap={snap}
          appleAuthState={appleAuthState}
          pushCurrentNavState={pushCurrentNavState}
        />
      </div>

      <LibraryMiniPlayerBar
        track={track || null}
        snap={snap}
        hidden={hidden}
        desktopMode={desktopMode}
        onReturnToPlayer={() => setView('lock')}
        onTriggerScreensaver={onTriggerScreensaver}
        applyVolume={applyVolume}
        currentVolume={currentVolume}
        volumePopoverOpen={volumePopoverOpen}
        setVolumePopoverOpen={setVolumePopoverOpen}
        isPlaying={isPlaying}
        volPct={volPct}
        brightnessPopoverOpen={brightnessPopoverOpen}
        setBrightnessPopoverOpen={setBrightnessPopoverOpen}
        brightnessPct={brightnessPct}
        setBrightnessPct={setBrightnessPct}
        sourceModalOpen={sourceModalOpen}
        powerModalOpen={powerModalOpen}
        setSourceModalOpen={setSourceModalOpen}
        setPowerModalOpen={setPowerModalOpen}
      />
      <LibraryXmbLeftColumn
        browserSourceFilter={browserSourceFilter}
        browseHubTarget={browseHubTarget}
        setBrowseHubTarget={setBrowseHubTarget}
        setOskTarget={setOskTarget}
        sourceVisibility={sourceVisibility}
        snap={snap}
        appleAuthState={appleAuthState}
        pushCurrentNavState={pushCurrentNavState}
        localSubTab={localSubTab}
        setLocalSubTab={setLocalSubTab}
        setLocalFolderPath={setLocalFolderPath}
        localAlbumsCount={allLocalAlbums.length}
        localArtistsCount={localFacetsSummary.artists.length}
        localVideosCount={isSourceIncluded('local') && mediaTypeFilter !== 'audio' ? localVideos.length : 0}
        appleSubTab={appleSubTab}
        setAppleSubTab={setAppleSubTab}
        soundCloudSubTab={soundCloudSubTab}
        setSoundCloudSubTab={setSoundCloudSubTab}
        iaSubTab={iaSubTab}
        setIaSubTab={setIaSubTab}
        setIaSubFilter={setIaSubFilter}
        rightPaneMode={rightPaneMode}
        setRightPaneMode={setRightPaneMode}
        activeMountRoot={activeMountRoot}
        setActiveMountRoot={setActiveMountRoot}
        placesOpen={placesOpen}
        togglePlacesOpen={togglePlacesOpen}
        filteredPlaylists={filteredPlaylists}
        filteredAlbums={filteredAlbums}
        pinnedAppleAlbumCount={pinnedAppleAlbumCount}
        scLikedTracks={scLikedTracks}
        scPlaylists={scPlaylists}
        cloudPlaylists={cloudPlaylists}
        xmbPreviewTriggerRef={xmbPreviewTriggerRef}
        focusRightPaneFirstTile={focusRightPaneFirstTile}
        isSourceIncluded={isSourceIncluded}
        opticalDisc={opticalDisc}
        cdScanning={cdScanning}
        browserTarget={browserTarget}
        selectLocalCollection={selectLocalCollection}
        setBrowserTracks={setBrowserTracks}
        handleScanOpticalDisc={handleScanOpticalDisc}
        handleEjectOpticalDisc={handleEjectOpticalDisc}
        setSourceModalOpen={setSourceModalOpen}
        playlistsOpen={playlistsOpen}
        togglePlaylistsOpen={togglePlaylistsOpen}
        creatingPlaylist={creatingPlaylist}
        setCreatingPlaylist={setCreatingPlaylist}
        newPlaylistName={newPlaylistName}
        setNewPlaylistName={setNewPlaylistName}
        handleCreatePlaylist={handleCreatePlaylist}
        activePlaylistId={activePlaylistId}
        setActivePlaylistId={setActivePlaylistId}
        setImpFypActive={setImpFypActive}
        localSmartStations={localDiscover.smart_stations}
        onPlayLocalSmartStation={handlePlayLocalSmartStation}
      />

      {/* =====================================================================
          RIGHT COLUMN (68%): Context-Driven Main Canvas (4-Col Max Tile Grid, Collection Tracklist, or Artist Profile)
         ===================================================================== */}
      <div
        data-nav-col="right"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight > 220) return;
          if (rightPaneMode === 'artist') {
            if (
              activeArtistProfile?.source === 'soundcloud' &&
              activeArtistProfile.subTab === 'tracks' &&
              activeArtistProfile.scData?.next_tracks_href &&
              !activeArtistProfile.loadingMore
            ) {
              loadMoreArtistTracks();
            }
            return;
          }
          if (rightPaneMode !== 'browse') return;
          if (browserSearch.trim()) {
            if (isSourceIncluded('internet_archive') && iaSearchHasMore && !iaSearchLoadingMore) {
              loadMoreIaSearch();
            }
            if (
              isSourceIncluded('soundcloud') &&
              scCatalogSearchResults.next_tracks_href &&
              !scLoadingMore
            ) {
              loadMoreScSearch();
            }
            return;
          }
          if (
            browserSourceFilter === 'internet_archive' &&
            iaSubTab !== 'pinned' &&
            iaHasMore &&
            !iaLoadingMore
          ) {
            loadMoreIaDiscover();
          } else if (
            browserSourceFilter === 'soundcloud' &&
            soundCloudSubTab === 'trending' &&
            scDiscoverNextHref &&
            !scLoadingMore
          ) {
            loadMoreScDiscover();
          }
        }}
        style={{
          padding: 16,
          overflowY: 'auto',
          overflowX: 'hidden',
          minWidth: 0,
          maxWidth: '100%',
          boxSizing: 'border-box',
          WebkitOverflowScrolling: 'touch',
          touchAction: 'pan-y',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {renderContextLegendBar()}
        {browserSearch.trim() && rightPaneMode !== 'tracks' && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 10,
              padding: '8px 12px',
              borderRadius: 10,
              background: '#0f222a',
              border: '1px solid #2aa3c4',
              flexShrink: 0,
            }}
          >
            <span style={{ fontSize: 13, fontWeight: 800, color: '#bfeaf5' }}>
              🔍 Filtering by “{browserSearch.trim()}”
            </span>
            <button
              type="button"
              data-right-filter-pill="true"
              onClick={() => setBrowserSearch('')}
              style={{
                padding: '4px 10px',
                borderRadius: 7,
                background: '#16313c',
                border: '1px solid #2aa3c4',
                color: '#7dd3fc',
                fontSize: 11.5,
                fontFamily: 'monospace',
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              ✕ Clear
            </button>
          </div>
        )}
        {/* =================================================================
            STATE A: ⊞ 4-COLUMN-MAX VISUAL TILE GRID (My SIMP Library, Apple Playlists, Radio, New, Search)
           ================================================================= */}
        {rightPaneMode === 'browse' ? (
          <LibraryBrowseRightPane
            activeHubLabel={activeHubLabel}
            activeMountRoot={activeMountRoot}
            setActiveMountRoot={setActiveMountRoot}
            localSubTab={localSubTab}
            setLocalSubTab={setLocalSubTab}
            localFolderPath={localFolderPath}
            setLocalFolderPath={setLocalFolderPath}
            allLocalAlbums={allLocalAlbums}
            allLocalTracks={allLocalTracks}
            facetsSummary={localFacetsSummary}
            localGenreFilter={localGenreFilter}
            setLocalGenreFilter={setLocalGenreFilter}
            localYearFilter={localYearFilter}
            setLocalYearFilter={setLocalYearFilter}
            localArtworkFilter={localArtworkFilter}
            setLocalArtworkFilter={setLocalArtworkFilter}
            localLyricsFilter={localLyricsFilter}
            setLocalLyricsFilter={setLocalLyricsFilter}
            localAlpha={localAlpha}
            setLocalAlpha={setLocalAlpha}
            pushCurrentNavState={pushCurrentNavState}
            activeSmartFacet={activeSmartFacet}
            setActiveSmartFacet={setActiveSmartFacet}
            appleAuthState={appleAuthState}
            browseHubTarget={browseHubTarget}
            impFypActive={impFypActive}
            onOpenFilters={openFilterModal}
            selectedSources={selectedSources}
            sourceVisibility={sourceVisibility}
            localDiscover={localDiscover}
            onPlayLocalSmartStation={handlePlayLocalSmartStation}
            appleRadioFilter={appleRadioFilter}
            appleRadioGenre={appleRadioGenre}
            appleRecentlyPlayedTracks={appleRecentlyPlayedTracks}
            appleSubTab={appleSubTab}
            artistRadioShows={artistRadioShows}
            browserSearch={browserSearch}
            browserSourceFilter={browserSourceFilter}
            catalogSearchResults={catalogSearchResults}
            cloudAlpha={cloudAlpha}
            cloudLoading={cloudLoading}
            cloudPlaylists={cloudPlaylists}
            clubMixes={clubMixes}
            creatingPlaylist={creatingPlaylist}
            filteredAlbums={filteredAlbums}
            filteredCloudPlaylists={filteredCloudPlaylists}
            filteredIaItems={filteredIaItems}
            filteredIaSearchResults={filteredIaSearchResults}
            filteredLocalSearchTracks={filteredLocalSearchTracks}
            filteredPlaylists={filteredPlaylists}
            filteredRecentlyPlayed={filteredRecentlyPlayed}
            forYouAlbums={forYouAlbums}
            forYouFilter={forYouFilter}
            forYouNewReleases={forYouNewReleases}
            forYouPlaylists={forYouPlaylists}
            forYouShelves={forYouShelves}
            genreRadioStations={genreRadioStations}
            handleAddTracksToPlaylist={handleAddTracksToPlaylist}
            handleCreatePlaylist={handleCreatePlaylist}
            handleDeletePlaylist={handleDeletePlaylist}
            handlePinArchiveCollection={handlePinArchiveCollection}
            handleStartSoundCloudTrackRadio={handleStartSoundCloudTrackRadio}
            hybridPlaylistsList={hybridPlaylistsList}
            iaHasMore={iaHasMore}
            iaLoading={iaLoading}
            iaLoadingMore={iaLoadingMore}
            iaSearchHasMore={iaSearchHasMore}
            iaSearchLoadingMore={iaSearchLoadingMore}
            iaSubFilter={iaSubFilter}
            iaSubTab={iaSubTab}
            isSourceIncluded={isSourceIncluded}
            liveRadioStations={liveRadioStations}
            loadIaDiscover={loadIaDiscover}
            loadMoreIaDiscover={loadMoreIaDiscover}
            loadMoreIaSearch={loadMoreIaSearch}
            loadMoreScDiscover={loadMoreScDiscover}
            loadMoreScSearch={loadMoreScSearch}
            localVideos={localVideos}
            mediaTypeFilter={mediaTypeFilter}
            mountTracks={mountTracks}
            newFeedAlbums={newFeedAlbums}
            newFeedPlaylists={newFeedPlaylists}
            newFeedRecentReleases={newFeedRecentReleases}
            newFeedSongs={newFeedSongs}
            newFilter={newFilter}
            newPlaylistName={newPlaylistName}
            pagedCloudPlaylists={pagedCloudPlaylists}
            personalRadioStations={personalRadioStations}
            pinnedPlaylistsList={pinnedPlaylistsList}
            playlists={playlists}
            radioStations={radioStations}
            recentlyAddedCloudAlbums={recentlyAddedCloudAlbums}
            recentlyPlayed={recentlyPlayed}
            openLibraryContextMenu={openLibraryContextMenu}
            renderAppleArtistCard={renderAppleArtistCard}
            renderArchiveItemCard={renderArchiveItemCard}
            renderCloudAlbumCard={renderCloudAlbumCard}
            renderCloudPlaylistCard={renderCloudPlaylistCard}
            renderLocalArtistCard={renderLocalArtistCard}
            renderSimpAlbumCard={renderSimpAlbumCard}
            renderSimpPlaylistCard={renderSimpPlaylistCard}
            renderSingleSongRow={renderSingleSongRow}
            renderSoundCloudPlaylistCard={renderSoundCloudPlaylistCard}
            renderSoundCloudUserCard={renderSoundCloudUserCard}
            renderStationCard={renderStationCard}
            resetCloudPlaylistsLimit={resetCloudPlaylistsLimit}
            hasMoreCloudPlaylists={hasMoreCloudPlaylists}
            loadMoreCloudPlaylists={loadMoreCloudPlaylists}
            scCatalogSearchResults={scCatalogSearchResults}
            scDiscoverNextHref={scDiscoverNextHref}
            scFollowings={scFollowings}
            scFreshUploads={scFreshUploads}
            scLikedTracks={scLikedTracks}
            scLikesFilter={scLikesFilter}
            scLoadingMore={scLoadingMore}
            scMoreOfWhatYouLike={scMoreOfWhatYouLike}
            scPlaylists={scPlaylists}
            scRecommendedArtists={scRecommendedArtists}
            scSelectedGenre={scSelectedGenre}
            scStreamFilter={scStreamFilter}
            scStreamPlaylists={scStreamPlaylists}
            scStreamTracks={scStreamTracks}
            scTrendingFilter={scTrendingFilter}
            scTrendingMixes={scTrendingMixes}
            scTrendingPlaylists={scTrendingPlaylists}
            scTrendingTracks={scTrendingTracks}
            searchLower={searchLower}
            searchMatchedPlaylists={searchMatchedPlaylists}
            searchPreferredSource={searchPreferredSource}
            setAppleRecentlyPlayedTracks={setAppleRecentlyPlayedTracks}
            setArtistRadioShows={setArtistRadioShows}
            setCloudLoading={setCloudLoading}
            setCloudPlaylists={setCloudPlaylists}
            setClubMixes={setClubMixes}
            setForYouAlbums={setForYouAlbums}
            setForYouNewReleases={setForYouNewReleases}
            setForYouPlaylists={setForYouPlaylists}
            setForYouShelves={setForYouShelves}
            setGenreRadioStations={setGenreRadioStations}
            setLiveRadioStations={setLiveRadioStations}
            setNewFeedAlbums={setNewFeedAlbums}
            setNewFeedPlaylists={setNewFeedPlaylists}
            setNewFeedRecentReleases={setNewFeedRecentReleases}
            setNewFeedSongs={setNewFeedSongs}
            setNewPlaylistName={setNewPlaylistName}
            setOskTarget={setOskTarget}
            setPersonalRadioStations={setPersonalRadioStations}
            setPlayingContextId={setPlayingContextId}
            setRadioStations={setRadioStations}
            setRecentlyAddedCloudAlbums={setRecentlyAddedCloudAlbums}
            setScDiscoverNextHref={setScDiscoverNextHref}
            setScFollowings={setScFollowings}
            setScLikedTracks={setScLikedTracks}
            setScPlaylists={setScPlaylists}
            setScStreamPlaylists={setScStreamPlaylists}
            setScStreamTracks={setScStreamTracks}
            setScTrendingMixes={setScTrendingMixes}
            setScTrendingPlaylists={setScTrendingPlaylists}
            setScTrendingTracks={setScTrendingTracks}
            setSourceModalOpen={setSourceModalOpen}
            setView={setView}
            simpHubFilter={simpHubFilter}
            snap={snap}
            soundCloudSubTab={soundCloudSubTab}
          />
        ) : rightPaneMode === 'artist' && activeArtistProfile ? (
          /* =================================================================
             STATE A.5: 🎤 DEDICATED ARTIST PROFILE & RABBIT HOLE VIEW
             ================================================================= */
          <LibraryArtistProfilePane
            activeArtistProfile={activeArtistProfile}
            setActiveArtistProfile={setActiveArtistProfile}
            handleWalkBack={handleWalkBack}
            setPlayingContextId={setPlayingContextId}
            setView={setView}
            scFollowings={scFollowings}
            setScFollowings={setScFollowings}
            showToast={showToast}
            loadMoreArtistTracks={loadMoreArtistTracks}
            tileGridStyle={tileGridStyle}
            renderSingleSongRow={renderSingleSongRow}
            renderSoundCloudPlaylistCard={renderSoundCloudPlaylistCard}
            renderCloudAlbumCard={renderCloudAlbumCard}
            renderSimpAlbumCard={renderSimpAlbumCard}
            renderSoundCloudUserCard={renderSoundCloudUserCard}
            renderAppleArtistCard={renderAppleArtistCard}
          />
        ) : (
          <LibraryTracklistRightPane
            activeHubLabel={activeHubLabel}
            activeIaDetail={activeIaDetail}
            activeScPlaylist={activeScPlaylist}
            browserTarget={browserTarget}
            browserTracks={browserTracks}
            cdScanning={cdScanning}
            cloudLoading={cloudLoading}
            dvdAudioChoice={dvdAudioChoice}
            dvdSubChoice={dvdSubChoice}
            favoritedUris={favoritedUris}
            filterHasLyricsOnly={filterHasLyricsOnly}
            focusRightPaneFirstTile={focusRightPaneFirstTile}
            handleAddAppleToCloudLibrary={handleAddAppleToCloudLibrary}
            handleAddTracksToPlaylist={handleAddTracksToPlaylist}
            handleEjectOpticalDisc={handleEjectOpticalDisc}
            handleFavoriteTrack={handleFavoriteTrack}
            handleRemoveTrackFromPlaylist={handleRemoveTrackFromPlaylist}
            handleScanOpticalDisc={handleScanOpticalDisc}
            handleStartSoundCloudTrackRadio={handleStartSoundCloudTrackRadio}
            handleWalkBack={handleWalkBack}
            iaLoading={iaLoading}
            navHistory={navHistory}
            onOpenFilters={openFilterModal}
            openArtistProfile={openArtistProfile}
            openLibraryContextMenu={openLibraryContextMenu}
            openLocalVideoFile={openLocalVideoFile}
            opticalDisc={opticalDisc}
            playingContextId={playingContextId}
            selectCloudAlbum={selectCloudAlbum}
            selectedAlbumObj={selectedAlbumObj}
            selectedMountObj={selectedMountObj}
            selectedPlaylistObj={selectedPlaylistObj}
            setActiveDvdPlayback={setActiveDvdPlayback}
            setDvdAudioChoice={setDvdAudioChoice}
            setDvdSubChoice={setDvdSubChoice}
            setPlayingContextId={setPlayingContextId}
            setRightPaneMode={setRightPaneMode}
            setView={setView}
            showToast={showToast}
            snap={snap}
            track={track}
          />
        )}
      </div>

      {activeDvdPlayback && opticalDisc && (
        <DvdPlayerModal
          mode="dvd"
          devicePath={opticalDisc.device_path || '/dev/sr0'}
          discTitle={opticalDisc.album_title || 'DVD Video'}
          titleInfo={activeDvdPlayback.titleInfo}
          initialChapter={activeDvdPlayback.chapter}
          initialAudioIndex={activeDvdPlayback.audioIdx}
          initialSubtitleIndex={activeDvdPlayback.subIdx}
          onClose={() => setActiveDvdPlayback(null)}
        />
      )}

      {activeVideoModal && (
        <DvdPlayerModal
          mode={activeVideoModal.mode}
          discTitle={activeVideoModal.title}
          episodes={activeVideoModal.episodes}
          initialEpisodeIndex={activeVideoModal.initialEpisodeIndex ?? 0}
          onClose={() => setActiveVideoModal(null)}
        />
      )}

      {/* Contextual SELECT Action Menu Modal */}
      {libraryContextTarget && (
        <LibraryContextMenuModal
          target={libraryContextTarget}
          onClose={closeLibraryContextMenu}
          favoritedUris={favoritedUris}
          writablePlaylists={writablePlaylists}
          activePlaylistId={activePlaylistId}
          cleanCollectionTitle={cleanCollectionTitle}
          cycleTargetHybridPlaylist={cycleTargetHybridPlaylist}
          handlePlayTracksNext={handlePlayTracksNext}
          handleAddTracksToPlaylist={handleAddTracksToPlaylist}
          handleFavoriteTrack={handleFavoriteTrack}
          handleAddAppleToCloudLibrary={handleAddAppleToCloudLibrary}
          albums={albums}
          selectCloudAlbum={selectCloudAlbum}
          selectLocalCollection={selectLocalCollection}
          openArtistProfile={openArtistProfile}
          handleStartSoundCloudTrackRadio={handleStartSoundCloudTrackRadio}
          browserTarget={browserTarget}
          handleRemoveTrackFromPlaylist={handleRemoveTrackFromPlaylist}
          setPlayingContextId={setPlayingContextId}
          setView={setView}
          resolveCollectionTracks={resolveCollectionTracks}
          showToast={showToast}
          handleAddSimpPlaylistToHybrid={handleAddSimpPlaylistToHybrid}
          handleAddSimpAlbumToHybrid={handleAddSimpAlbumToHybrid}
          handleAddArchiveItemToHybrid={handleAddArchiveItemToHybrid}
          handlePinCloudPlaylist={handlePinCloudPlaylist}
          handlePinCloudAlbum={handlePinCloudAlbum}
          handlePinSoundCloudPlaylist={handlePinSoundCloudPlaylist}
          handlePinArchiveItem={handlePinArchiveItem}
          handleDeletePlaylist={handleDeletePlaylist}
          handleDeleteAlbum={handleDeleteAlbum}
          onPlayLocalSmartStation={handlePlayLocalSmartStation}
          handleStartAppleStation={handleStartAppleStation}
        />
      )}

      {/* Unified Y Library Filter Modal */}
      <LibraryFilterModal
        open={filterModalOpen}
        onClose={() => setFilterModalOpen(false)}
        browseHubTarget={browseHubTarget}
        rightPaneMode={rightPaneMode}
        mediaTypeFilter={mediaTypeFilter}
        setMediaTypeFilter={setMediaTypeFilter}
        simpHubFilter={simpHubFilter}
        setSimpHubFilter={setSimpHubFilter}
        activeSmartFacet={activeSmartFacet}
        setActiveSmartFacet={setActiveSmartFacet}
        recentCount={filteredRecentlyPlayed.length}
        savedPlaylistsCount={
          new Set([...hybridPlaylistsList.map((p) => p.id), ...pinnedPlaylistsList.map((p) => p.id)])
            .size
        }
        pinnedCount={pinnedPlaylistsList.length}
        albumsCount={filteredAlbums.length}
        videosCount={localVideos.length}
        showLocalVideos={isSourceIncluded('local') && mediaTypeFilter !== 'audio' && localVideos.length > 0}
        showPinnedFilter={browserSourceFilter !== 'local' || pinnedPlaylistsList.length > 0}
        showLocalFacets={isSourceIncluded('local')}
        appleSubTab={appleSubTab}
        cloudAlpha={cloudAlpha}
        setCloudAlpha={setCloudAlpha}
        resetCloudPlaylistsLimit={resetCloudPlaylistsLimit}
        cloudPlaylistsCount={cloudPlaylists.length}
        forYouFilter={forYouFilter}
        setForYouFilter={setForYouFilter}
        newFilter={newFilter}
        setNewFilter={setNewFilter}
        appleRadioFilter={appleRadioFilter}
        setAppleRadioFilter={setAppleRadioFilter}
        appleRadioGenre={appleRadioGenre}
        setAppleRadioGenre={setAppleRadioGenre}
        availableAppleRadioGenres={availableAppleRadioGenres}
        soundCloudSubTab={soundCloudSubTab}
        scTrendingFilter={scTrendingFilter}
        setScTrendingFilter={setScTrendingFilter}
        scSelectedGenre={scSelectedGenre}
        onSelectScGenre={handleSelectScGenreFromModal}
        scLikesFilter={scLikesFilter}
        setScLikesFilter={setScLikesFilter}
        scStreamFilter={scStreamFilter}
        setScStreamFilter={setScStreamFilter}
        iaSubTab={iaSubTab}
        iaSubFilter={iaSubFilter}
        setIaSubFilter={setIaSubFilter}
        localSubTab={localSubTab}
        setLocalSubTab={handleSelectLocalSubTab}
        localGenreFilter={localGenreFilter}
        setLocalGenreFilter={setLocalGenreFilter}
        availableLocalGenres={localFacetsSummary.genres}
        localYearFilter={localYearFilter}
        setLocalYearFilter={setLocalYearFilter}
        availableLocalEras={localFacetsSummary.eras}
        localArtworkFilter={localArtworkFilter}
        setLocalArtworkFilter={setLocalArtworkFilter}
        localArtworkCounts={localFacetsSummary.artworkCounts}
        localLyricsFilter={localLyricsFilter}
        setLocalLyricsFilter={setLocalLyricsFilter}
        localLyricsCounts={localFacetsSummary.lyricsCounts}
        localAlpha={localAlpha}
        setLocalAlpha={setLocalAlpha}
        localArtistsCount={localFacetsSummary.artists.length}
        localAlbumsCount={allLocalAlbums.length}
        localVideosCount={isSourceIncluded('local') && mediaTypeFilter !== 'audio' ? localVideos.length : 0}
        localMountsCount={snap?.mounts?.length || 0}
        filterHasLyricsOnly={filterHasLyricsOnly}
        setFilterHasLyricsOnly={setFilterHasLyricsOnly}
        tracklistLyricsCount={browserTracks.filter((tr) => allLyricsUris.has(tr.uri)).length}
        tracklistTotalCount={browserTracks.length}
      />
    </main>
  );
};
