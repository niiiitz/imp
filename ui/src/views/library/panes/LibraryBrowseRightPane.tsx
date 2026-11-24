import React from "react";
import {
  AlbumRecord,
  ArchiveItemSummary,
  defaultSimpClient,
  PlaylistRecord,
  SimpStateSnapshot,
  TrackMetadata,
} from "@imp/client";
import {
  AppleCatalogSearchResults,
  AppleCloudAlbumSummary,
  AppleCloudPlaylistSummary,
  AppleRadioStationSummary,
  AppleRecommendationShelf,
} from "../../../drivers/AppleMusicDriver";
import {
  SoundCloudCatalogSearchResults,
  SoundCloudPlaylistSummary,
  SoundCloudUserSummary,
} from "../../../drivers/SoundCloudDriver";
import { isUiVideoTrack } from "../../PlayerView";
import {
  AlphaBucket,
  type BrowseHubTarget,
  type LocalArtworkFilter,
  type LocalLyricsFilter,
  type LocalSubTab,
  tileGridStyle,
  useLibraryLyricsStatus,
} from "../libraryHelpers";
import { HorizontalShelfRail } from "../HorizontalShelfRail";
import { useExpandedShelf } from "../ExpandedShelfContext";
import { UniversalSearchResultsPane } from "./UniversalSearchResultsPane";
import { AppleMusicDiscoverPane } from "./AppleMusicDiscoverPane";
import { SoundCloudDiscoverPane } from "./SoundCloudDiscoverPane";
import { InternetArchiveDiscoverPane } from "./InternetArchiveDiscoverPane";
import { ImpFypPane } from "./ImpFypPane";
import { LocalDiscoverPane, type LocalFacetsSummary } from "./LocalDiscoverPane";
import { ImpIcon } from "../../../components/icons/ImpIcon";
import { SoundCloudLogo } from "../../../components/SoundCloudLogo";
import type { SourceVisibilityPrefs } from "../../../menu/menuCorpus";
import {
  CollapsibleSectionHeader,
  FilterTriggerButton,
} from "../PinnableSectionHeader";
import { type SmartFacetKind } from "../../../components/LibraryFilterModal";
import {
  LocalDiscoverResponse,
  LocalSmartStation,
} from "../../../api/servicesCacheApi";

export interface LibraryBrowseRightPaneProps {
  activeHubLabel: string;
  activeMountRoot: string | null;
  setActiveMountRoot: React.Dispatch<React.SetStateAction<string | null>>;
  localSubTab: LocalSubTab;
  setLocalSubTab: React.Dispatch<React.SetStateAction<LocalSubTab>>;
  localFolderPath: string;
  setLocalFolderPath: React.Dispatch<React.SetStateAction<string>>;
  allLocalAlbums: AlbumRecord[];
  allLocalTracks: TrackMetadata[];
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
  pushCurrentNavState: () => void;
  activeSmartFacet: SmartFacetKind;
  setActiveSmartFacet: React.Dispatch<React.SetStateAction<SmartFacetKind>>;
  appleAuthState: "connected" | "reauth_required" | "never_used";
  expiredAuthProviders?: Array<'apple' | 'soundcloud'>;
  onOpenConnectedAccounts?: () => void;
  browseHubTarget: BrowseHubTarget;
  impFypActive: boolean;
  onOpenFilters?: () => void;
  selectedSources: Array<"local" | "apple_music" | "soundcloud" | "internet_archive">;
  sourceVisibility: SourceVisibilityPrefs;
  localDiscover: LocalDiscoverResponse;
  onPlayLocalSmartStation: (st: LocalSmartStation, shuffle?: boolean) => void;
  openLibraryContextMenu: any;
  appleRadioFilter: "all" | "genre" | "live" | "shows" | "mixes";
  appleRadioGenre: string;
  appleRecentlyPlayedTracks: TrackMetadata[];
  appleSubTab: "pinned" | "for_you" | "cloud_playlists" | "new" | "radio";
  artistRadioShows: AppleCloudPlaylistSummary[];
  browserSearch: string;
  browserSourceFilter: "all" | "local" | "apple_music" | "soundcloud" | "internet_archive";
  catalogSearchResults: AppleCatalogSearchResults;
  cloudAlpha: AlphaBucket;
  cloudLoading: boolean;
  cloudPlaylists: AppleCloudPlaylistSummary[];
  clubMixes: AppleCloudPlaylistSummary[];
  creatingPlaylist: boolean;
  filteredAlbums: AlbumRecord[];
  filteredCloudPlaylists: AppleCloudPlaylistSummary[];
  filteredIaItems: ArchiveItemSummary[];
  filteredIaSearchResults: ArchiveItemSummary[];
  filteredLocalSearchTracks: TrackMetadata[];
  filteredPlaylists: PlaylistRecord[];
  filteredRecentlyPlayed: TrackMetadata[];
  forYouAlbums: AppleCloudAlbumSummary[];
  forYouFilter: "all" | "stations" | "new_releases" | "recently_played" | "mixes" | "social" | "recent_library";
  forYouNewReleases: AppleCloudAlbumSummary[];
  forYouPlaylists: AppleCloudPlaylistSummary[];
  forYouShelves: AppleRecommendationShelf[];
  genreRadioStations: AppleRadioStationSummary[];
  handleAddTracksToPlaylist: any;
  handleCreatePlaylist: any;
  handleDeletePlaylist: any;
  handlePinArchiveCollection: any;
  handleStartSoundCloudTrackRadio: any;
  hybridPlaylistsList: PlaylistRecord[];
  iaHasMore: boolean;
  iaLoading: boolean;
  iaLoadingMore: boolean;
  iaSearchHasMore: boolean;
  iaSearchLoadingMore: boolean;
  iaSubFilter: string;
  iaSubTab: "pinned" | "trending" | "films" | "tv" | "audio";
  isSourceIncluded: any;
  liveRadioStations: AppleRadioStationSummary[];
  loadIaDiscover: any;
  loadMoreIaDiscover: any;
  loadMoreIaSearch: any;
  loadMoreScDiscover: any;
  loadMoreScSearch: any;
  localVideos: TrackMetadata[];
  mediaTypeFilter: "all" | "video" | "audio";
  mountTracks: TrackMetadata[];
  newFeedAlbums: AppleCloudAlbumSummary[];
  newFeedPlaylists: AppleCloudPlaylistSummary[];
  newFeedRecentReleases: AppleCloudAlbumSummary[];
  newFeedSongs: TrackMetadata[];
  newFilter: "all" | "recent_releases" | "playlists" | "albums" | "songs";
  newPlaylistName: string;
  pagedCloudPlaylists: AppleCloudPlaylistSummary[];
  personalRadioStations: AppleRadioStationSummary[];
  pinnedPlaylistsList: PlaylistRecord[];
  playlists: PlaylistRecord[];
  radioStations: AppleRadioStationSummary[];
  recentlyAddedCloudAlbums: AppleCloudAlbumSummary[];
  recentlyPlayed: TrackMetadata[];
  renderAppleArtistCard: any;
  renderArchiveItemCard: any;
  renderCloudAlbumCard: any;
  renderCloudPlaylistCard: any;
  renderLocalArtistCard: any;
  renderSimpAlbumCard: any;
  renderSimpPlaylistCard: any;
  renderSingleSongRow: any;
  renderSoundCloudPlaylistCard: any;
  renderSoundCloudUserCard: any;
  renderStationCard: any;
  resetCloudPlaylistsLimit: () => void;
  hasMoreCloudPlaylists: boolean;
  loadMoreCloudPlaylists: () => void;
  scCatalogSearchResults: SoundCloudCatalogSearchResults;
  scDiscoverNextHref: string | null | undefined;
  scFollowings: SoundCloudUserSummary[];
  scFreshUploads: TrackMetadata[];
  scLikedTracks: TrackMetadata[];
  scLikesFilter: "all" | "sets" | "likes" | "following";
  scLoadingMore: boolean;
  scMoreOfWhatYouLike: TrackMetadata[];
  scPlaylists: SoundCloudPlaylistSummary[];
  scRecommendedArtists: SoundCloudUserSummary[];
  scSelectedGenre: string;
  scStreamFilter: "all" | "sets" | "history" | "stream";
  scStreamPlaylists: SoundCloudPlaylistSummary[];
  scStreamTracks: TrackMetadata[];
  scTrendingFilter: "all" | "for_you" | "fresh" | "artists" | "mixes" | "sets" | "tracks";
  scTrendingMixes: TrackMetadata[];
  scTrendingPlaylists: SoundCloudPlaylistSummary[];
  scTrendingTracks: TrackMetadata[];
  searchLower: string;
  searchMatchedPlaylists: PlaylistRecord[];
  searchPreferredSource: "local" | "apple_music" | "soundcloud" | "internet_archive" | null | undefined;
  setAppleRecentlyPlayedTracks: any;
  setArtistRadioShows: any;
  setCloudLoading: any;
  setCloudPlaylists: React.Dispatch<React.SetStateAction<AppleCloudPlaylistSummary[]>>;
  setClubMixes: any;
  setForYouAlbums: any;
  setForYouNewReleases: any;
  setForYouPlaylists: any;
  setForYouShelves: any;
  setGenreRadioStations: any;
  setLiveRadioStations: any;
  setNewFeedAlbums: any;
  setNewFeedPlaylists: any;
  setNewFeedRecentReleases: any;
  setNewFeedSongs: any;
  setNewPlaylistName: any;
  setOskTarget: any;
  setPersonalRadioStations: any;
  setPlayingContextId: any;
  setRadioStations: any;
  setRecentlyAddedCloudAlbums: any;
  setScDiscoverNextHref: any;
  setScFollowings: any;
  setScLikedTracks: any;
  setScPlaylists: any;
  setScStreamPlaylists: any;
  setScStreamTracks: any;
  setScTrendingMixes: any;
  setScTrendingPlaylists: any;
  setScTrendingTracks: any;
  setSourceModalOpen: any;
  setView: any;
  simpHubFilter: "all" | "recent" | "hybrid" | "pinned" | "albums" | "videos";
  snap: SimpStateSnapshot | null;
  soundCloudSubTab: "pinned" | "likes_sets" | "stream_radio" | "trending";
}

export const LibraryBrowseRightPane: React.FC<LibraryBrowseRightPaneProps> = ({
  activeHubLabel,
  activeMountRoot,
  setActiveMountRoot,
  localSubTab,
  setLocalSubTab,
  localFolderPath,
  setLocalFolderPath,
  allLocalAlbums,
  allLocalTracks,
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
  pushCurrentNavState,
  activeSmartFacet,
  setActiveSmartFacet,
  appleAuthState,
  expiredAuthProviders = [],
  onOpenConnectedAccounts,
  browseHubTarget,
  impFypActive,
  onOpenFilters,
  selectedSources,
  sourceVisibility,
  localDiscover,
  onPlayLocalSmartStation,
  openLibraryContextMenu,
  appleRadioFilter,
  appleRadioGenre,
  appleRecentlyPlayedTracks,
  appleSubTab,
  artistRadioShows,
  browserSearch,
  browserSourceFilter,
  catalogSearchResults,
  cloudAlpha,
  cloudLoading,
  cloudPlaylists,
  clubMixes,
  creatingPlaylist,
  filteredAlbums,
  filteredCloudPlaylists,
  filteredIaItems,
  filteredIaSearchResults,
  filteredLocalSearchTracks,
  filteredPlaylists,
  filteredRecentlyPlayed,
  forYouAlbums,
  forYouFilter,
  forYouNewReleases,
  forYouPlaylists,
  forYouShelves,
  genreRadioStations,
  handleAddTracksToPlaylist,
  handleCreatePlaylist,
  handleDeletePlaylist,
  handlePinArchiveCollection,
  handleStartSoundCloudTrackRadio,
  hybridPlaylistsList,
  iaHasMore,
  iaLoading,
  iaLoadingMore,
  iaSearchHasMore,
  iaSearchLoadingMore,
  iaSubFilter,
  iaSubTab,
  isSourceIncluded,
  liveRadioStations,
  loadIaDiscover,
  loadMoreIaDiscover,
  loadMoreIaSearch,
  loadMoreScDiscover,
  loadMoreScSearch,
  localVideos,
  mediaTypeFilter,
  mountTracks,
  newFeedAlbums,
  newFeedPlaylists,
  newFeedRecentReleases,
  newFeedSongs,
  newFilter,
  newPlaylistName,
  pagedCloudPlaylists,
  personalRadioStations,
  pinnedPlaylistsList,
  playlists,
  radioStations,
  recentlyAddedCloudAlbums,
  recentlyPlayed,
  renderAppleArtistCard,
  renderArchiveItemCard,
  renderCloudAlbumCard,
  renderCloudPlaylistCard,
  renderLocalArtistCard,
  renderSimpAlbumCard,
  renderSimpPlaylistCard,
  renderSingleSongRow,
  renderSoundCloudPlaylistCard,
  renderSoundCloudUserCard,
  renderStationCard,
  resetCloudPlaylistsLimit,
  hasMoreCloudPlaylists,
  loadMoreCloudPlaylists,
  scCatalogSearchResults,
  scDiscoverNextHref,
  scFollowings,
  scFreshUploads,
  scLikedTracks,
  scLikesFilter,
  scLoadingMore,
  scMoreOfWhatYouLike,
  scPlaylists,
  scRecommendedArtists,
  scSelectedGenre,
  scStreamFilter,
  scStreamPlaylists,
  scStreamTracks,
  scTrendingFilter,
  scTrendingMixes,
  scTrendingPlaylists,
  scTrendingTracks,
  searchLower,
  searchMatchedPlaylists,
  searchPreferredSource,
  setAppleRecentlyPlayedTracks,
  setArtistRadioShows,
  setCloudLoading,
  setCloudPlaylists,
  setClubMixes,
  setForYouAlbums,
  setForYouNewReleases,
  setForYouPlaylists,
  setForYouShelves,
  setGenreRadioStations,
  setLiveRadioStations,
  setNewFeedAlbums,
  setNewFeedPlaylists,
  setNewFeedRecentReleases,
  setNewFeedSongs,
  setNewPlaylistName,
  setOskTarget,
  setPersonalRadioStations,
  setPlayingContextId,
  setRadioStations,
  setRecentlyAddedCloudAlbums,
  setScDiscoverNextHref,
  setScFollowings,
  setScLikedTracks,
  setScPlaylists,
  setScStreamPlaylists,
  setScStreamTracks,
  setScTrendingMixes,
  setScTrendingPlaylists,
  setScTrendingTracks,
  setSourceModalOpen,
  setView,
  simpHubFilter,
  snap,
  soundCloudSubTab,
}) => {
  useLibraryLyricsStatus();
  const { expandedShelfId, registerPortalHost } = useExpandedShelf();
  const [facetTracks, setFacetTracks] = React.useState<TrackMetadata[]>([]);
  const [facetLoading, setFacetLoading] = React.useState(false);

  React.useEffect(() => {
    if (!activeSmartFacet) {
      setFacetTracks([]);
      return;
    }
    let cancelled = false;
    setFacetLoading(true);
    fetch(`http://127.0.0.1:18888/api/library/facets?facet=${encodeURIComponent(activeSmartFacet)}`)
      .then((r) => r.json())
      .then((facetJson) => {
        if (cancelled) return;
        const matched: TrackMetadata[] = Array.isArray(facetJson?.tracks) ? facetJson.tracks : [];
        setFacetTracks(matched);
      })
      .catch(() => {
        if (!cancelled) setFacetTracks([]);
      })
      .finally(() => {
        if (!cancelled) setFacetLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSmartFacet]);

  const unifiedSavedPlaylists = React.useMemo(() => {
    const seen = new Set<string>();
    const combined: PlaylistRecord[] = [];
    for (const pl of [...hybridPlaylistsList, ...pinnedPlaylistsList]) {
      if (!seen.has(pl.id)) {
        seen.add(pl.id);
        combined.push(pl);
      }
    }
    return combined;
  }, [hybridPlaylistsList, pinnedPlaylistsList]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0, width: '100%' }}>
      <div
        ref={registerPortalHost}
        data-expanded-shelf-portal="true"
        style={{
          display: expandedShelfId ? 'flex' : 'none',
          flexDirection: 'column',
          gap: 14,
          minWidth: 0,
          width: '100%',
        }}
      />
      <div
        style={{
          display: expandedShelfId ? 'none' : 'flex',
          flexDirection: 'column',
          gap: 12,
          minWidth: 0,
          width: '100%',
        }}
      >
            {/* Not Signed In Setup Card (only shown when opening Apple Discover while not authenticated) */}
            {!snap?.apple_authenticated &&
              browseHubTarget === 'apple_discover' &&
              appleSubTab !== 'pinned' && (
                <div
                  style={{
                    padding: 14,
                    borderRadius: 12,
                    background: '#160d12',
                    border: '1px solid #4c1d2e',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#fda4af', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      {appleAuthState === 'reauth_required' ? (
                        '⚠️ Apple Music Session Expired / Signed Out'
                      ) : (
                        <>
                          <ImpIcon name="apple" size={14} color="#fda4af" />
                          <span>Connect Apple Music</span>
                        </>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: '#a1a1aa', marginTop: 2 }}>
                      {appleAuthState === 'reauth_required'
                        ? 'Sign back in under Settings → Folders & Accounts.'
                        : 'Sign in under Settings → Folders & Accounts.'}
                    </div>
                  </div>
                  <button
                    onClick={() => setSourceModalOpen(true)}
                    style={{
                      minHeight: 36,
                      padding: '0 14px',
                      borderRadius: 8,
                      background: '#2a131c',
                      border: '1px solid #fa243c',
                      color: '#fecdd3',
                      fontSize: 11,
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    Open Apple Music Setup
                  </button>
                </div>
              )}

            {/* SoundCloud Setup Card (shown when opening SoundCloud hubs before connecting) */}
            {browseHubTarget === 'soundcloud_discover' &&
              !snap?.soundcloud_authenticated &&
              soundCloudSubTab !== 'pinned' && (
                <div
                  style={{
                    padding: 14,
                    borderRadius: 12,
                    background: '#1a110b',
                    border: '1px solid #7c2d12',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#fdba74', display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                      <SoundCloudLogo width={30} color="#ffffff" />
                      <span>Connect SoundCloud</span>
                    </div>
                    <div style={{ fontSize: 11, color: '#a1a1aa', marginTop: 2 }}>
                      Sign in for Likes &amp; Sets, or enable Public Mode for discovery.
                    </div>
                  </div>
                  <button
                    onClick={() => setSourceModalOpen(true)}
                    style={{
                      minHeight: 36,
                      padding: '0 14px',
                      borderRadius: 8,
                      background: '#2c140a',
                      border: '1px solid #ea580c',
                      color: '#fdba74',
                      fontSize: 11,
                      fontWeight: 800,
                      cursor: 'pointer',
                    }}
                  >
                    Open SoundCloud Setup
                  </button>
                </div>
              )}

            {(cloudLoading || iaLoading) && (
              <div
                style={{
                  fontSize: 12,
                  fontFamily: 'monospace',
                  color:
                    browseHubTarget === 'ia_discover'
                      ? '#fde68a'
                      : browseHubTarget === 'soundcloud_discover'
                      ? '#fdba74'
                      : '#fda4af',
                  padding: '4px 2px',
                }}
              >
                {browseHubTarget === 'ia_discover' || iaLoading
                  ? '⏳ Loading from Internet Archive...'
                  : browseHubTarget === 'soundcloud_discover'
                  ? '⏳ Loading from SoundCloud...'
                  : '⏳ Loading from Apple Music Cloud...'}
              </div>
            )}

            {/* -------------------------------------------------------------
                1. UNIFIED SEARCH VIEW (Pinned + Apple Playlists + Albums + Catalog)
               ------------------------------------------------------------- */}
            {browserSearch.trim() ? (
              <UniversalSearchResultsPane
                browserSearch={browserSearch}
                catalogSearchResults={catalogSearchResults}
                cloudLoading={cloudLoading}
                filteredAlbums={filteredAlbums}
                filteredCloudPlaylists={filteredCloudPlaylists}
                filteredIaSearchResults={filteredIaSearchResults}
                filteredLocalSearchTracks={filteredLocalSearchTracks}
                filteredPlaylists={filteredPlaylists}
                iaLoading={iaLoading}
                iaSearchHasMore={iaSearchHasMore}
                iaSearchLoadingMore={iaSearchLoadingMore}
                isSourceIncluded={isSourceIncluded}
                loadMoreIaSearch={loadMoreIaSearch}
                loadMoreScSearch={loadMoreScSearch}
                mediaTypeFilter={mediaTypeFilter}
                recentlyAddedCloudAlbums={recentlyAddedCloudAlbums}
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
                scCatalogSearchResults={scCatalogSearchResults}
                scLoadingMore={scLoadingMore}
                searchLower={searchLower}
                searchMatchedPlaylists={searchMatchedPlaylists}
                searchPreferredSource={searchPreferredSource}
                snap={snap}
              />
            ) : browseHubTarget === 'local_discover' || browseHubTarget === 'mount' ? (
              <LocalDiscoverPane
                browseHubTarget={browseHubTarget}
                localSubTab={localSubTab}
                setLocalSubTab={setLocalSubTab}
                activeMountRoot={activeMountRoot}
                setActiveMountRoot={setActiveMountRoot}
                localFolderPath={localFolderPath}
                setLocalFolderPath={setLocalFolderPath}
                snap={snap}
                allLocalAlbums={allLocalAlbums}
                allLocalTracks={allLocalTracks}
                mountTracks={mountTracks}
                localVideos={localVideos}
                localDiscover={localDiscover}
                facetsSummary={facetsSummary}
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
                mediaTypeFilter={mediaTypeFilter}
                onOpenFilters={onOpenFilters}
                onPlayLocalSmartStation={onPlayLocalSmartStation}
                pushCurrentNavState={pushCurrentNavState}
                setPlayingContextId={setPlayingContextId}
                setView={setView}
                handleAddTracksToPlaylist={handleAddTracksToPlaylist}
                renderSimpAlbumCard={renderSimpAlbumCard}
                renderLocalArtistCard={renderLocalArtistCard}
                renderSingleSongRow={renderSingleSongRow}
                openLibraryContextMenu={openLibraryContextMenu}
              />
            ) : impFypActive ? (
              <ImpFypPane
                browserSourceFilter={browserSourceFilter}
                selectedSources={selectedSources}
                sourceVisibility={sourceVisibility}
                mediaTypeFilter={mediaTypeFilter}
                onOpenFilters={onOpenFilters}
                snap={snap}
                expiredAuthProviders={expiredAuthProviders}
                onOpenConnectedAccounts={onOpenConnectedAccounts}
                localDiscover={localDiscover}
                tileGridStyle={tileGridStyle}
                renderSingleSongRow={renderSingleSongRow}
                renderSimpAlbumCard={renderSimpAlbumCard}
                renderSimpPlaylistCard={renderSimpPlaylistCard}
                renderCloudAlbumCard={renderCloudAlbumCard}
                renderCloudPlaylistCard={renderCloudPlaylistCard}
                renderStationCard={renderStationCard}
                renderAppleArtistCard={renderAppleArtistCard}
                renderSoundCloudPlaylistCard={renderSoundCloudPlaylistCard}
                renderSoundCloudUserCard={renderSoundCloudUserCard}
                renderArchiveItemCard={renderArchiveItemCard}
                renderLocalArtistCard={renderLocalArtistCard}
                onPlayLocalSmartStation={onPlayLocalSmartStation}
                openLibraryContextMenu={openLibraryContextMenu}
              />
            ) : (
              <>
                {/* ---------------------------------------------------------
                    2B. 📌 MY SIMP LIBRARY HUB (4-Column Visual Card Grid & Playlist Manager)
                   --------------------------------------------------------- */}
                {browseHubTarget === 'imp_library' && (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        paddingBottom: 10,
                        borderBottom: '1px solid #16161c',
                        flexWrap: 'wrap',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <span
                          style={{
                            fontSize: 15,
                            fontWeight: 800,
                            color: 'var(--imp-accent-active-text, #f5e1be)',
                            marginRight: 6,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <ImpIcon name="imp" size={15} color="var(--imp-accent-active-text, #f5e1be)" />
                          <span>{activeHubLabel}</span>
                        </span>
                      </div>
                      <FilterTriggerButton
                        summary={
                          activeSmartFacet
                            ? `Facet: ${activeSmartFacet.replace('_', ' ')}`
                            : `${simpHubFilter === 'all' ? 'All' : simpHubFilter}${
                                mediaTypeFilter !== 'all' ? ` • ${mediaTypeFilter}` : ''
                              }`
                        }
                        active={simpHubFilter !== 'all' || Boolean(activeSmartFacet) || mediaTypeFilter !== 'all'}
                        onClick={onOpenFilters}
                      />
                    </div>

                    {activeSmartFacet && (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 8,
                          padding: 12,
                          borderRadius: 12,
                          background: 'rgba(12, 18, 28, 0.85)',
                          border: '1px solid rgba(56, 189, 248, 0.28)',
                        }}
                      >
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 800, color: '#e2e8f0' }}>
                            <ImpIcon
                              name={
                                activeSmartFacet === 'synced_lyrics' || activeSmartFacet === 'has_lyrics'
                                  ? 'lyrics'
                                  : activeSmartFacet === 'has_factoids'
                                  ? 'factoid'
                                  : activeSmartFacet === 'has_comments'
                                  ? 'comments'
                                  : activeSmartFacet === 'has_art'
                                  ? 'artwork'
                                  : 'artwork-missing'
                              }
                              size={14}
                              color="#34d399"
                            />
                            <span>
                              Smart Facet:{' '}
                              {activeSmartFacet === 'synced_lyrics'
                                ? 'Karaoke Ready — Synced Timed Lyrics'
                                : activeSmartFacet === 'has_lyrics'
                                ? 'All Tracks with Retrieved Lyrics'
                                : activeSmartFacet === 'has_factoids'
                                ? 'Tracks with Pop-Up Video Factoids'
                                : activeSmartFacet === 'has_comments'
                                ? 'Tracks with Attributed Timed Comments'
                                : activeSmartFacet === 'has_art'
                                ? 'Tracks with Cover Artwork'
                                : 'Tracks Missing Cover Artwork'}{' '}
                              ({facetTracks.length})
                            </span>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            {(activeSmartFacet === 'synced_lyrics' || activeSmartFacet === 'has_lyrics') && (
                              <>
                                <button
                                  data-right-filter-pill="true"
                                  onClick={() => setActiveSmartFacet('synced_lyrics')}
                                  style={{
                                    padding: '3px 9px',
                                    borderRadius: 6,
                                    background:
                                      activeSmartFacet === 'synced_lyrics'
                                        ? 'rgba(52, 211, 153, 0.2)'
                                        : 'rgba(255,255,255,0.05)',
                                    border:
                                      activeSmartFacet === 'synced_lyrics'
                                        ? '1px solid #34d399'
                                        : '1px solid rgba(255,255,255,0.12)',
                                    color: activeSmartFacet === 'synced_lyrics' ? '#6ee7b7' : '#94a3b8',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                  }}
                                >
                                  Synced LRC Only
                                </button>
                                <button
                                  data-right-filter-pill="true"
                                  onClick={() => setActiveSmartFacet('has_lyrics')}
                                  style={{
                                    padding: '3px 9px',
                                    borderRadius: 6,
                                    background:
                                      activeSmartFacet === 'has_lyrics'
                                        ? 'rgba(56, 189, 248, 0.2)'
                                        : 'rgba(255,255,255,0.05)',
                                    border:
                                      activeSmartFacet === 'has_lyrics'
                                        ? '1px solid #38bdf8'
                                        : '1px solid rgba(255,255,255,0.12)',
                                    color: activeSmartFacet === 'has_lyrics' ? '#7dd3fc' : '#94a3b8',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                  }}
                                >
                                  All Lyrics
                                </button>
                                {facetTracks.length > 0 && (
                                  <button
                                    data-right-filter-pill="true"
                                    onClick={() => {
                                      const uris = facetTracks.map((t) => t.uri);
                                      defaultSimpClient.loadQueue(uris, 0, facetTracks);
                                      window.dispatchEvent(new CustomEvent('simp-engage-karaoke-mode'));
                                      setView('lock');
                                    }}
                                    style={{
                                      padding: '3px 10px',
                                      borderRadius: 6,
                                      background: 'rgba(16, 185, 129, 0.22)',
                                      border: '1px solid #34d399',
                                      color: '#6ee7b7',
                                      fontSize: 11,
                                      fontWeight: 800,
                                      cursor: 'pointer',
                                      display: 'inline-flex',
                                      alignItems: 'center',
                                      gap: 5,
                                    }}
                                  >
                                    <ImpIcon name="play" size={11} color="#34d399" />
                                    <span>Play All in Karaoke Mode</span>
                                  </button>
                                )}
                              </>
                            )}
                            <button
                              data-right-filter-pill="true"
                              onClick={() => setActiveSmartFacet(null)}
                              style={{
                                padding: '3px 9px',
                                borderRadius: 6,
                                background: 'rgba(255,255,255,0.06)',
                                border: '1px solid rgba(255,255,255,0.14)',
                                color: '#cbd5e1',
                                fontSize: 11,
                                fontWeight: 700,
                                cursor: 'pointer',
                              }}
                            >
                              Clear Facet
                            </button>
                          </div>
                        </div>
                        {facetLoading ? (
                          <div style={{ fontSize: 12, color: '#94a3b8', padding: '10px 4px' }}>
                            Filtering library by facet…
                          </div>
                        ) : facetTracks.length === 0 ? (
                          <div style={{ fontSize: 12, color: '#94a3b8', padding: '10px 4px' }}>
                            No indexed tracks match this facet yet.
                          </div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {facetTracks.slice(0, 120).map((ft) =>
                              renderSingleSongRow(ft, facetTracks, `facet_${activeSmartFacet}`),
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {creatingPlaylist && (
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          padding: 10,
                          borderRadius: 10,
                          background: 'var(--imp-surface-card, #1a1d24)',
                          border: '1px solid var(--imp-focus-ring, #e8b86d)',
                        }}
                      >
                        <input
                          type="text"
                          data-osk-input="playlist"
                          placeholder="Name your new Imp Hybrid Playlist (Local + Apple + SoundCloud)..."
                          value={newPlaylistName}
                          onChange={(e) => setNewPlaylistName(e.target.value)}
                          onClick={(e) => {
                            if (
                              e.detail === 0 ||
                              document.documentElement.dataset.simpInput === 'gamepad'
                            ) {
                              setOskTarget('playlist');
                              if (window.parent && window.parent !== window) {
                                window.parent.postMessage({ type: 'SIMP_OPEN_OSK' }, '*');
                              }
                            }
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleCreatePlaylist();
                          }}
                          style={{
                            flex: 1,
                            minHeight: 38,
                            padding: '0 12px',
                            borderRadius: 8,
                            background: 'var(--imp-bg-canvas, #121418)',
                            border: '1px solid #2e2e3c',
                            color: '#d4d4dc',
                            fontSize: 12,
                          }}
                        />
                        <button
                          onClick={handleCreatePlaylist}
                          style={{
                            minHeight: 38,
                            padding: '0 16px',
                            borderRadius: 8,
                            background: 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
                            color: 'var(--imp-accent-active-text, #f5e1be)',
                            border: '1px solid var(--imp-focus-ring, #e8b86d)',
                            fontWeight: 800,
                            fontSize: 12,
                            cursor: 'pointer',
                          }}
                        >
                          Create Playlist
                        </button>
                      </div>
                    )}

                    {/* Recently Played Section */}
                    {(simpHubFilter === 'all' || simpHubFilter === 'recent') &&
                      filteredRecentlyPlayed.length > 0 && (
                        <section
                          data-section-anchor="imp_lib_recent"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <CollapsibleSectionHeader
                            sectionKey="imp_lib:recent"
                            accentColor="var(--imp-focus-ring, #e8b86d)"
                            title={`🕒 RECENTLY PLAYED (${filteredRecentlyPlayed.length})`}
                          />
                          {simpHubFilter === 'recent' ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {filteredRecentlyPlayed.map((rTrack) =>
                                renderSingleSongRow(
                                  rTrack,
                                  isUiVideoTrack(rTrack)
                                    ? filteredRecentlyPlayed.filter((tr) => isUiVideoTrack(tr))
                                    : filteredRecentlyPlayed.filter((tr) => !isUiVideoTrack(tr)),
                                  'recent_played'
                                )
                              )}
                            </div>
                          ) : (
                            <HorizontalShelfRail variant="tracks" itemCount={filteredRecentlyPlayed.length}>
                              {filteredRecentlyPlayed.map((rTrack) =>
                                renderSingleSongRow(
                                  rTrack,
                                  isUiVideoTrack(rTrack)
                                    ? filteredRecentlyPlayed.filter((tr) => isUiVideoTrack(tr))
                                    : filteredRecentlyPlayed.filter((tr) => !isUiVideoTrack(tr)),
                                  'recent_played',
                                  true
                                )
                              )}
                            </HorizontalShelfRail>
                          )}
                        </section>
                      )}

                    {/* Saved / Hybrid Playlists Section (Unifies Hybrid + Pinned when on `hybrid` tab) */}
                    {simpHubFilter === 'hybrid' && unifiedSavedPlaylists.length > 0 && (
                      <section
                        data-section-anchor="imp_lib_saved_hybrid"
                        style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                      >
                        <CollapsibleSectionHeader
                          sectionKey="imp_lib:saved_hybrid"
                          accentColor="var(--imp-focus-ring, #e8b86d)"
                          title={`★ SAVED & HYBRID PLAYLISTS (${unifiedSavedPlaylists.length})`}
                        />
                        <div style={tileGridStyle}>
                          {unifiedSavedPlaylists.map(renderSimpPlaylistCard)}
                        </div>
                      </section>
                    )}

                    {simpHubFilter === 'all' && hybridPlaylistsList.length > 0 && (
                      <section
                        data-section-anchor="imp_lib_hybrid"
                        style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                      >
                        <CollapsibleSectionHeader
                          sectionKey="imp_lib:hybrid"
                          accentColor="var(--imp-focus-ring, #e8b86d)"
                          title={`★ Imp Hybrid Playlists (${hybridPlaylistsList.length})`}
                        />
                        <HorizontalShelfRail variant="tiles" itemCount={hybridPlaylistsList.length}>
                          {hybridPlaylistsList.map(renderSimpPlaylistCard)}
                        </HorizontalShelfRail>
                      </section>
                    )}

                    {/* Pinned Cloud Playlists Section */}
                    {(simpHubFilter === 'all' || simpHubFilter === 'pinned') &&
                      pinnedPlaylistsList.length > 0 && (
                        <section
                          data-section-anchor="imp_lib_pinned"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <CollapsibleSectionHeader
                            sectionKey="imp_lib:pinned"
                            accentColor="#fda4af"
                            title={
                              <>
                                <ImpIcon name="imp" size={12} color="#fda4af" />
                                <span>PINNED CLOUD PLAYLISTS ({pinnedPlaylistsList.length})</span>
                              </>
                            }
                          />
                          {simpHubFilter === 'pinned' ? (
                            <div style={tileGridStyle}>
                              {pinnedPlaylistsList.map(renderSimpPlaylistCard)}
                            </div>
                          ) : (
                            <HorizontalShelfRail variant="tiles" itemCount={pinnedPlaylistsList.length}>
                              {pinnedPlaylistsList.map(renderSimpPlaylistCard)}
                            </HorizontalShelfRail>
                          )}
                        </section>
                      )}

                    {/* Local & Pinned Full Albums Section */}
                    {(simpHubFilter === 'all' || simpHubFilter === 'albums') &&
                      filteredAlbums.length > 0 && (
                        <section
                          data-section-anchor="imp_lib_albums"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <CollapsibleSectionHeader
                            sectionKey="imp_lib:albums"
                            accentColor="var(--imp-focus-ring, #e8b86d)"
                            title={`💿 ALBUMS & SOUNDTRACKS (${filteredAlbums.length})`}
                          />
                          {simpHubFilter === 'albums' ? (
                            <div style={tileGridStyle}>
                              {filteredAlbums.map(renderSimpAlbumCard)}
                            </div>
                          ) : (
                            <HorizontalShelfRail variant="tiles" itemCount={filteredAlbums.length}>
                              {filteredAlbums.map(renderSimpAlbumCard)}
                            </HorizontalShelfRail>
                          )}
                        </section>
                      )}

                    {/* Indexed Local Unencrypted Video Files Section */}
                    {(simpHubFilter === 'all' || simpHubFilter === 'videos') &&
                      isSourceIncluded('local') &&
                      mediaTypeFilter !== 'audio' &&
                      localVideos.length > 0 && (
                        <section
                          data-section-anchor="imp_lib_videos"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <CollapsibleSectionHeader
                            sectionKey="imp_lib:videos"
                            accentColor="var(--imp-focus-ring, #e8b86d)"
                            title={`LOCAL VIDEOS (${localVideos.length})`}
                          />
                          {simpHubFilter === 'videos' ? (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              {localVideos.map((v) =>
                                renderSingleSongRow(v, localVideos, 'local_video_hub')
                              )}
                            </div>
                          ) : (
                            <HorizontalShelfRail variant="tracks" itemCount={localVideos.length}>
                              {localVideos.map((v) =>
                                renderSingleSongRow(v, localVideos, 'local_video_hub', true)
                              )}
                            </HorizontalShelfRail>
                          )}
                        </section>
                      )}
                  </>
                )}

              <AppleMusicDiscoverPane
                appleRadioFilter={appleRadioFilter}
                appleRadioGenre={appleRadioGenre}
                appleRecentlyPlayedTracks={appleRecentlyPlayedTracks}
                appleSubTab={appleSubTab}
                artistRadioShows={artistRadioShows}
                browseHubTarget={browseHubTarget}
                browserSourceFilter={browserSourceFilter}
                cloudAlpha={cloudAlpha}
                cloudLoading={cloudLoading}
                cloudPlaylists={cloudPlaylists}
                clubMixes={clubMixes}
                filteredCloudPlaylists={filteredCloudPlaylists}
                forYouAlbums={forYouAlbums}
                forYouFilter={forYouFilter}
                forYouNewReleases={forYouNewReleases}
                forYouPlaylists={forYouPlaylists}
                forYouShelves={forYouShelves}
                genreRadioStations={genreRadioStations}
                liveRadioStations={liveRadioStations}
                newFeedAlbums={newFeedAlbums}
                newFeedPlaylists={newFeedPlaylists}
                newFeedRecentReleases={newFeedRecentReleases}
                newFeedSongs={newFeedSongs}
                newFilter={newFilter}
                onOpenFilters={onOpenFilters}
                pagedCloudPlaylists={pagedCloudPlaylists}
                personalRadioStations={personalRadioStations}
                radioStations={radioStations}
                recentlyAddedCloudAlbums={recentlyAddedCloudAlbums}
                renderCloudAlbumCard={renderCloudAlbumCard}
                renderCloudPlaylistCard={renderCloudPlaylistCard}
                renderSingleSongRow={renderSingleSongRow}
                renderStationCard={renderStationCard}
                resetCloudPlaylistsLimit={resetCloudPlaylistsLimit}
                hasMoreCloudPlaylists={hasMoreCloudPlaylists}
                loadMoreCloudPlaylists={loadMoreCloudPlaylists}
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
                setPersonalRadioStations={setPersonalRadioStations}
                setRadioStations={setRadioStations}
                setRecentlyAddedCloudAlbums={setRecentlyAddedCloudAlbums}
                snap={snap}
              />
              <SoundCloudDiscoverPane
                browseHubTarget={browseHubTarget}
                browserSourceFilter={browserSourceFilter}
                cloudLoading={cloudLoading}
                handleStartSoundCloudTrackRadio={handleStartSoundCloudTrackRadio}
                loadMoreScDiscover={loadMoreScDiscover}
                onOpenFilters={onOpenFilters}
                recentlyPlayed={recentlyPlayed}
                renderSingleSongRow={renderSingleSongRow}
                renderSoundCloudPlaylistCard={renderSoundCloudPlaylistCard}
                renderSoundCloudUserCard={renderSoundCloudUserCard}
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
                setCloudLoading={setCloudLoading}
                setPlayingContextId={setPlayingContextId}
                setScDiscoverNextHref={setScDiscoverNextHref}
                setScFollowings={setScFollowings}
                setScLikedTracks={setScLikedTracks}
                setScPlaylists={setScPlaylists}
                setScStreamPlaylists={setScStreamPlaylists}
                setScStreamTracks={setScStreamTracks}
                setScTrendingMixes={setScTrendingMixes}
                setScTrendingPlaylists={setScTrendingPlaylists}
                setScTrendingTracks={setScTrendingTracks}
                setView={setView}
                snap={snap}
                soundCloudSubTab={soundCloudSubTab}
              />
              <InternetArchiveDiscoverPane
                activeHubLabel={activeHubLabel}
                browseHubTarget={browseHubTarget}
                browserSearch={browserSearch}
                browserSourceFilter={browserSourceFilter}
                filteredIaItems={filteredIaItems}
                handleDeletePlaylist={handleDeletePlaylist}
                handlePinArchiveCollection={handlePinArchiveCollection}
                iaHasMore={iaHasMore}
                iaLoading={iaLoading}
                iaLoadingMore={iaLoadingMore}
                iaSubFilter={iaSubFilter}
                iaSubTab={iaSubTab}
                loadIaDiscover={loadIaDiscover}
                loadMoreIaDiscover={loadMoreIaDiscover}
                onOpenFilters={onOpenFilters}
                playlists={playlists}
                renderArchiveItemCard={renderArchiveItemCard}
              />
              </>
            )}
      </div>
    </div>
  );
};
