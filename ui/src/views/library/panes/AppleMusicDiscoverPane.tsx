import React from "react";
import {
  SimpStateSnapshot,
  TrackMetadata,
} from "@simp/client";
import {
  AppleCloudAlbumSummary,
  AppleCloudPlaylistSummary,
  AppleRadioStationSummary,
  AppleRecommendationShelf,
  fetchAppleCloudPlaylists,
  fetchAppleLibraryRecentlyAdded,
  fetchAppleNewFeed,
  fetchAppleRadioAndForYou,
  fetchAppleRecentPlayedPage,
  fetchAppleRecentPlayedTracksPage,
} from "../../../drivers/AppleMusicDriver";
import {
  AlphaBucket,
  type BrowseHubTarget,
  tileGridStyle,
} from "../libraryHelpers";
import { HorizontalShelfRail } from "../HorizontalShelfRail";
import { AppleMusicLogo } from "../../../components/AppleMusicLogo";
import { FilterTriggerButton, PinnableSectionHeader } from "../PinnableSectionHeader";
import {
  cacheAppleRecentLibraryShelf,
  inferAppleShelfItemKind,
  mapAppleShelfToFypItems,
  TTL_CATALOG_FEED_SEC,
  TTL_FAST_FEED_SEC,
} from "../../../api/servicesCacheApi";

function ensureShelfOrderTokens(shelf: AppleRecommendationShelf): string[] {
  if (shelf.item_order && shelf.item_order.length > 0) {
    return shelf.item_order;
  }
  return [
    ...shelf.stations.map((s) => `station:${s.id}`),
    ...shelf.playlists.map((p) => `playlist:${p.id}`),
    ...shelf.albums.map((a) => `album:${a.id}`),
  ];
}

function mergeAppleShelfRecords(
  primary: AppleRecommendationShelf,
  incoming: AppleRecommendationShelf
): AppleRecommendationShelf {
  const seenSt = new Set(primary.stations.map((s) => s.id));
  const seenPl = new Set(primary.playlists.map((p) => p.id));
  const seenAlb = new Set(primary.albums.map((a) => a.id));
  const nextOrder = [...ensureShelfOrderTokens(primary)];
  const seenTokens = new Set(nextOrder);

  const stMap = new Map(incoming.stations.map((s) => [s.id, s]));
  const plMap = new Map(incoming.playlists.map((p) => [p.id, p]));
  const albMap = new Map(incoming.albums.map((a) => [a.id, a]));

  const nextStations = [...primary.stations];
  const nextPlaylists = [...primary.playlists];
  const nextAlbums = [...primary.albums];

  for (const token of ensureShelfOrderTokens(incoming)) {
    if (token.startsWith("station:")) {
      const id = token.slice("station:".length);
      const st = stMap.get(id);
      if (st && !seenSt.has(id)) {
        seenSt.add(id);
        nextStations.push(st);
        if (!seenTokens.has(token)) {
          seenTokens.add(token);
          nextOrder.push(token);
        }
      }
    } else if (token.startsWith("playlist:")) {
      const id = token.slice("playlist:".length);
      const pl = plMap.get(id);
      if (pl && !seenPl.has(id)) {
        seenPl.add(id);
        nextPlaylists.push(pl);
        if (!seenTokens.has(token)) {
          seenTokens.add(token);
          nextOrder.push(token);
        }
      }
    } else if (token.startsWith("album:")) {
      const id = token.slice("album:".length);
      const alb = albMap.get(id);
      if (alb && !seenAlb.has(id)) {
        seenAlb.add(id);
        nextAlbums.push(alb);
        if (!seenTokens.has(token)) {
          seenTokens.add(token);
          nextOrder.push(token);
        }
      }
    }
  }

  return {
    ...primary,
    stations: nextStations,
    playlists: nextPlaylists,
    albums: nextAlbums,
    item_order: nextOrder,
  };
}

function mergeRecentAppleShelves(
  shelves: AppleRecommendationShelf[]
): AppleRecommendationShelf[] {
  if (shelves.length <= 1) return shelves;
  const sorted = [...shelves].sort((a, b) => {
    if (a.id === "recently-played-items") return -1;
    if (b.id === "recently-played-items") return 1;
    return 0;
  });
  let merged = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    merged = mergeAppleShelfRecords(merged, sorted[i]);
  }
  return [merged];
}

function renderOrderedAppleShelfItems(
  shelf: AppleRecommendationShelf,
  renderStationCard: (st: AppleRadioStationSummary) => React.ReactNode,
  renderCloudPlaylistCard: (pl: AppleCloudPlaylistSummary) => React.ReactNode,
  renderCloudAlbumCard: (alb: AppleCloudAlbumSummary) => React.ReactNode
): React.ReactNode[] {
  if (!shelf.item_order || shelf.item_order.length === 0) {
    return [
      ...shelf.stations.map(renderStationCard),
      ...shelf.playlists.map(renderCloudPlaylistCard),
      ...shelf.albums.map(renderCloudAlbumCard),
    ];
  }
  const stMap = new Map(shelf.stations.map((s) => [s.id, s]));
  const plMap = new Map(shelf.playlists.map((p) => [p.id, p]));
  const albMap = new Map(shelf.albums.map((a) => [a.id, a]));
  const usedSt = new Set<string>();
  const usedPl = new Set<string>();
  const usedAlb = new Set<string>();
  const out: React.ReactNode[] = [];

  for (const token of shelf.item_order) {
    if (token.startsWith("station:")) {
      const id = token.slice("station:".length);
      const st = stMap.get(id);
      if (st && !usedSt.has(id)) {
        usedSt.add(id);
        out.push(renderStationCard(st));
      }
    } else if (token.startsWith("playlist:")) {
      const id = token.slice("playlist:".length);
      const pl = plMap.get(id);
      if (pl && !usedPl.has(id)) {
        usedPl.add(id);
        out.push(renderCloudPlaylistCard(pl));
      }
    } else if (token.startsWith("album:")) {
      const id = token.slice("album:".length);
      const alb = albMap.get(id);
      if (alb && !usedAlb.has(id)) {
        usedAlb.add(id);
        out.push(renderCloudAlbumCard(alb));
      }
    }
  }
  for (const st of shelf.stations) {
    if (!usedSt.has(st.id)) out.push(renderStationCard(st));
  }
  for (const pl of shelf.playlists) {
    if (!usedPl.has(pl.id)) out.push(renderCloudPlaylistCard(pl));
  }
  for (const alb of shelf.albums) {
    if (!usedAlb.has(alb.id)) out.push(renderCloudAlbumCard(alb));
  }
  return out;
}

export interface AppleMusicDiscoverPaneProps {
  appleRadioFilter: "all" | "genre" | "live" | "shows" | "mixes";
  appleRadioGenre: string;
  appleRecentlyPlayedTracks: TrackMetadata[];
  appleSubTab: "pinned" | "for_you" | "cloud_playlists" | "new" | "radio";
  artistRadioShows: AppleCloudPlaylistSummary[];
  browseHubTarget: BrowseHubTarget;
  browserSourceFilter: "all" | "local" | "apple_music" | "soundcloud" | "internet_archive";
  cloudAlpha: AlphaBucket;
  cloudLoading: boolean;
  cloudPlaylists: AppleCloudPlaylistSummary[];
  clubMixes: AppleCloudPlaylistSummary[];
  filteredCloudPlaylists: AppleCloudPlaylistSummary[];
  forYouAlbums: AppleCloudAlbumSummary[];
  forYouFilter: "all" | "stations" | "new_releases" | "recently_played" | "mixes" | "social" | "recent_library";
  forYouNewReleases: AppleCloudAlbumSummary[];
  forYouPlaylists: AppleCloudPlaylistSummary[];
  forYouShelves: AppleRecommendationShelf[];
  genreRadioStations: AppleRadioStationSummary[];
  hasMoreCloudPlaylists: boolean;
  liveRadioStations: AppleRadioStationSummary[];
  loadMoreCloudPlaylists: () => void;
  newFeedAlbums: AppleCloudAlbumSummary[];
  newFeedPlaylists: AppleCloudPlaylistSummary[];
  newFeedRecentReleases: AppleCloudAlbumSummary[];
  newFeedSongs: TrackMetadata[];
  newFilter: "all" | "recent_releases" | "playlists" | "albums" | "songs";
  onOpenFilters?: () => void;
  pagedCloudPlaylists: AppleCloudPlaylistSummary[];
  personalRadioStations: AppleRadioStationSummary[];
  radioStations: AppleRadioStationSummary[];
  recentlyAddedCloudAlbums: AppleCloudAlbumSummary[];
  renderCloudAlbumCard: any;
  renderCloudPlaylistCard: any;
  renderSingleSongRow: any;
  renderStationCard: any;
  resetCloudPlaylistsLimit: () => void;
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
  setPersonalRadioStations: any;
  setRadioStations: any;
  setRecentlyAddedCloudAlbums: any;
  snap: SimpStateSnapshot | null;
}

export const AppleMusicDiscoverPane: React.FC<AppleMusicDiscoverPaneProps> = ({
  appleRadioFilter,
  appleRadioGenre,
  appleRecentlyPlayedTracks,
  appleSubTab,
  artistRadioShows,
  browseHubTarget,
  cloudAlpha,
  cloudLoading,
  cloudPlaylists,
  clubMixes,
  filteredCloudPlaylists,
  forYouAlbums,
  forYouFilter,
  forYouNewReleases,
  forYouPlaylists,
  forYouShelves,
  genreRadioStations,
  hasMoreCloudPlaylists,
  liveRadioStations,
  loadMoreCloudPlaylists,
  newFeedAlbums,
  newFeedPlaylists,
  newFeedRecentReleases,
  newFeedSongs,
  newFilter,
  onOpenFilters,
  pagedCloudPlaylists,
  personalRadioStations,
  radioStations,
  recentlyAddedCloudAlbums,
  renderCloudAlbumCard,
  renderCloudPlaylistCard,
  renderSingleSongRow,
  renderStationCard,
  resetCloudPlaylistsLimit,
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
  setPersonalRadioStations,
  setRadioStations,
  setRecentlyAddedCloudAlbums,
  snap,
}) => {
  const [recentItemsNextOffset, setRecentItemsNextOffset] = React.useState<
    number | null | undefined
  >(undefined);
  const [recentItemsLoadingMore, setRecentItemsLoadingMore] = React.useState(false);
  const [recentTracksNextOffset, setRecentTracksNextOffset] = React.useState<
    number | null | undefined
  >(undefined);
  const [recentTracksLoadingMore, setRecentTracksLoadingMore] = React.useState(false);

  return (
    <>
                {/* ---------------------------------------------------------
                    3. ☁️ APPLE LIBRARY PLAYLISTS HUB (Paginated 50/page + A-Z Jump Pills)
                   --------------------------------------------------------- */}
                {browseHubTarget === 'apple_discover' &&
                  appleSubTab === 'cloud_playlists' &&
                  snap?.apple_authenticated && (
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
                            fontSize: 14,
                            fontWeight: 800,
                            color: '#fecdd3',
                            marginRight: 6,
                            display: 'inline-flex',
                            alignItems: 'center',
                            gap: 6,
                          }}
                        >
                          <AppleMusicLogo size={14} />
                          <span>Apple Playlists ({cloudPlaylists.length})</span>
                        </span>
                      </div>

                      {/* Filters + Visible Count + Reload */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <FilterTriggerButton
                          summary={cloudAlpha === 'all' ? 'A–Z: All' : cloudAlpha.replace('_', '–').toUpperCase()}
                          active={cloudAlpha !== 'all'}
                          accentColor="#fa243c"
                          activeBg="#28111b"
                          activeText="#fecdd3"
                          onClick={onOpenFilters}
                        />
                        {filteredCloudPlaylists.length > 0 && (
                          <span
                            style={{
                              fontSize: 11,
                              fontFamily: 'monospace',
                              color: '#fda4af',
                            }}
                          >
                            {pagedCloudPlaylists.length} / {filteredCloudPlaylists.length}
                          </span>
                        )}
                        <button
                          data-right-filter-pill="true"
                          onClick={() => {
                            setCloudLoading(true);
                            fetchAppleCloudPlaylists()
                              .then((pls) => {
                                setCloudPlaylists(pls);
                                resetCloudPlaylistsLimit();
                              })
                              .catch(() => {})
                              .finally(() => setCloudLoading(false));
                          }}
                          style={{
                            padding: '4px 9px',
                            borderRadius: 6,
                            background: '#161620',
                            border: '1px solid #2a2a38',
                            color: '#fda4af',
                            fontSize: 11,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          ↻ Reload
                        </button>
                      </div>
                    </div>

                    <div style={tileGridStyle}>
                      {pagedCloudPlaylists.map(renderCloudPlaylistCard)}
                    </div>
                    {hasMoreCloudPlaylists && (
                      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
                        <button
                          data-focusable="true"
                          data-load-more="true"
                          onClick={loadMoreCloudPlaylists}
                          style={{
                            minHeight: 38,
                            padding: '0 20px',
                            borderRadius: 10,
                            background: '#241119',
                            border: '1px solid #fa243c',
                            color: '#fecdd3',
                            fontSize: 12,
                            fontWeight: 800,
                            cursor: 'pointer',
                          }}
                        >
                          ⬇ Load More Apple Playlists ({filteredCloudPlaylists.length - pagedCloudPlaylists.length} remaining)
                        </button>
                      </div>
                    )}
                  </>
                )}

                {/* ---------------------------------------------------------
                    4. ✨ FOR YOU HUB (Personal Radio, New Releases, Recently Played, Mixes & Shelves)
                   --------------------------------------------------------- */}
                {browseHubTarget === 'apple_discover' &&
                  appleSubTab === 'for_you' &&
                  snap?.apple_authenticated && (
                  <>
                    {(() => {
                      const rawRecentShelves = forYouShelves.filter(
                        (s) =>
                          s.id === 'recently-played-items' ||
                          s.id === 'recently-played' ||
                          s.title.toLowerCase().includes('recent')
                      );
                      const recentShelves = mergeRecentAppleShelves(rawRecentShelves);
                      const otherShelves = forYouShelves.filter(
                        (s) =>
                          s.id !== 'recently-played-items' &&
                          s.id !== 'recently-played' &&
                          !s.title.toLowerCase().includes('recent') &&
                          !s.title.toLowerCase().includes('new release')
                      );
                      const recentShelfCount = recentShelves.reduce(
                        (acc, s) =>
                          acc + s.playlists.length + s.albums.length + s.stations.length,
                        0
                      );
                      const totalRecentCount =
                        recentShelfCount + appleRecentlyPlayedTracks.length;
                      const effectiveNewReleases =
                        forYouNewReleases.length > 0
                          ? forYouNewReleases
                          : newFeedRecentReleases;
                      const effectiveRecentItemsOffset =
                        recentItemsNextOffset !== undefined
                          ? recentItemsNextOffset
                          : recentShelfCount >= 10
                            ? recentShelfCount
                            : null;
                      const effectiveRecentTracksOffset =
                        recentTracksNextOffset !== undefined
                          ? recentTracksNextOffset
                          : appleRecentlyPlayedTracks.length >= 20
                            ? appleRecentlyPlayedTracks.length
                            : null;

                      const handleLoadMoreRecentItems = async () => {
                        if (
                          recentItemsLoadingMore ||
                          effectiveRecentItemsOffset === null
                        ) {
                          return;
                        }
                        setRecentItemsLoadingMore(true);
                        try {
                          const res = await fetchAppleRecentPlayedPage(
                            effectiveRecentItemsOffset
                          );
                          let addedNew = false;
                          setForYouShelves?.((prev: AppleRecommendationShelf[]) => {
                            const targetIdx = prev.findIndex(
                              (s) =>
                                s.id === 'recently-played-items' ||
                                s.id === 'recently-played' ||
                                s.title.toLowerCase().includes('recent')
                            );
                            if (targetIdx === -1) return prev;
                            const before = prev[targetIdx];
                            const merged = mergeAppleShelfRecords(before, res.shelf);
                            addedNew =
                              merged.stations.length > before.stations.length ||
                              merged.playlists.length > before.playlists.length ||
                              merged.albums.length > before.albums.length;
                            const next = [...prev];
                            next[targetIdx] = merged;
                            return next;
                          });
                          setRecentItemsNextOffset(
                            res.next_offset !== null &&
                              res.next_offset > effectiveRecentItemsOffset &&
                              addedNew
                              ? res.next_offset
                              : res.next_offset !== null && addedNew
                                ? res.next_offset
                                : null
                          );
                        } catch {
                          setRecentItemsNextOffset(null);
                        } finally {
                          setRecentItemsLoadingMore(false);
                        }
                      };

                      const handleLoadMoreRecentTracks = async () => {
                        if (
                          recentTracksLoadingMore ||
                          effectiveRecentTracksOffset === null
                        ) {
                          return;
                        }
                        setRecentTracksLoadingMore(true);
                        try {
                          const res = await fetchAppleRecentPlayedTracksPage(
                            effectiveRecentTracksOffset
                          );
                          let addedCount = 0;
                          setAppleRecentlyPlayedTracks?.((prev: TrackMetadata[]) => {
                            const seen = new Set(prev.map((t) => t.uri));
                            const fresh = res.tracks.filter(
                              (t) => !seen.has(t.uri)
                            );
                            addedCount = fresh.length;
                            return fresh.length > 0 ? [...prev, ...fresh] : prev;
                          });
                          setRecentTracksNextOffset(
                            res.next_offset !== null && addedCount > 0
                              ? res.next_offset
                              : null
                          );
                        } catch {
                          setRecentTracksNextOffset(null);
                        } finally {
                          setRecentTracksLoadingMore(false);
                        }
                      };

                      return (
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
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                flexWrap: 'wrap',
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 14,
                                  fontWeight: 800,
                                  color: '#fecdd3',
                                  marginRight: 6,
                                }}
                              >
                                ✨ For You
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <FilterTriggerButton
                                summary={forYouFilter === 'all' ? 'All Sections' : forYouFilter.replace('_', ' ')}
                                active={forYouFilter !== 'all'}
                                accentColor="#fa243c"
                                activeBg="#28111b"
                                activeText="#fecdd3"
                                onClick={onOpenFilters}
                              />
                                <button
                                  data-right-filter-pill="true"
                                  onClick={() => {
                                    setCloudLoading(true);
                                    setRecentItemsNextOffset(undefined);
                                    setRecentTracksNextOffset(undefined);
                                    Promise.all([
                                      fetchAppleRadioAndForYou()
                                        .then((res) => {
                                          setRadioStations(res.stations);
                                          setPersonalRadioStations?.(res.personal_stations ?? []);
                                          setLiveRadioStations?.(res.live_stations ?? []);
                                          setArtistRadioShows?.(res.artist_shows ?? []);
                                          setClubMixes?.(res.club_mixes ?? []);
                                          setGenreRadioStations?.(res.genre_stations ?? []);
                                          setForYouNewReleases?.(res.new_releases ?? []);
                                          setForYouPlaylists(res.playlists);
                                          setForYouAlbums(res.albums);
                                          setForYouShelves?.(res.shelves ?? []);
                                          setAppleRecentlyPlayedTracks?.(res.recently_played ?? []);
                                        })
                                        .catch(() => {}),
                                      fetchAppleLibraryRecentlyAdded()
                                        .then((albs) => {
                                          if (Array.isArray(albs)) {
                                            setRecentlyAddedCloudAlbums(albs);
                                            cacheAppleRecentLibraryShelf(albs);
                                          }
                                        })
                                        .catch(() => {}),
                                    ]).finally(() => setCloudLoading(false));
                                  }}
                                  style={{
                                    padding: '4px 9px',
                                    borderRadius: 6,
                                    background: '#161620',
                                    border: '1px solid #2a2a38',
                                    color: '#fda4af',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                  }}
                                >
                                  ↻ Refresh
                                </button>
                              </div>
                            </div>

                          {(forYouFilter === 'all' || forYouFilter === 'stations') &&
                            personalRadioStations.length > 0 && (
                              <section
                                data-section-anchor="apple_personal_stations"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`📻 PERSONAL RADIO STATIONS (${personalRadioStations.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:for_you:personal_stations',
                                    cacheKey: 'apple:for_you:personal_stations',
                                    provider: 'apple_music',
                                    title: 'Apple Music • Personal Radio Stations',
                                    itemKind: 'stations',
                                    fetchSpec: { kind: 'apple_for_you', section: 'personal_stations' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'for_you',
                                      sectionAnchor: 'apple_personal_stations',
                                    },
                                    ttlSec: TTL_FAST_FEED_SEC,
                                  }}
                                  liveItems={personalRadioStations}
                                />
                                <HorizontalShelfRail variant="tiles" itemCount={personalRadioStations.length}>
                                  {personalRadioStations.map(renderStationCard)}
                                </HorizontalShelfRail>
                              </section>
                            )}

                          {(forYouFilter === 'all' || forYouFilter === 'new_releases') &&
                            effectiveNewReleases.length > 0 && (
                              <section
                                data-section-anchor="apple_for_you_new_releases"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`🆕 NEW & RECENT RELEASES FOR YOU (${effectiveNewReleases.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:for_you:new_releases',
                                    cacheKey: 'apple:for_you:new_releases',
                                    provider: 'apple_music',
                                    title: 'Apple Music • New & Recent Releases For You',
                                    itemKind: 'albums',
                                    fetchSpec: { kind: 'apple_for_you', section: 'new_releases' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'for_you',
                                      sectionAnchor: 'apple_for_you_new_releases',
                                    },
                                    ttlSec: TTL_FAST_FEED_SEC,
                                  }}
                                  liveItems={effectiveNewReleases}
                                />
                                <HorizontalShelfRail variant="tiles" itemCount={effectiveNewReleases.length}>
                                  {effectiveNewReleases.map(renderCloudAlbumCard)}
                                </HorizontalShelfRail>
                              </section>
                            )}

                          {(forYouFilter === 'all' || forYouFilter === 'recently_played') &&
                            totalRecentCount > 0 && (
                              <>
                                {recentShelves.map((shelf) => {
                                  const totalItems =
                                    shelf.playlists.length +
                                    shelf.albums.length +
                                    shelf.stations.length;
                                  if (totalItems === 0) return null;
                                  const anchor = `apple_shelf_${shelf.id}`;
                                  return (
                                    <section
                                      key={shelf.id}
                                      data-section-anchor={anchor}
                                      style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                                    >
                                      <PinnableSectionHeader
                                        title={`🕒 ${shelf.title.toUpperCase()} (${totalItems})`}
                                        accentColor="#fda4af"
                                        descriptor={{
                                          shelfUid: `apple:for_you:shelf:${shelf.id}`,
                                          cacheKey: `apple:for_you:shelf:${shelf.id}`,
                                          provider: 'apple_music',
                                          title: `Apple Music • ${shelf.title}`,
                                          itemKind: inferAppleShelfItemKind(shelf),
                                          fetchSpec: {
                                            kind: 'apple_for_you',
                                            section: 'shelf',
                                            shelfId: shelf.id,
                                          },
                                          originRoute: {
                                            sourceFilter: 'apple_music',
                                            appleSubTab: 'for_you',
                                            sectionAnchor: anchor,
                                          },
                                          ttlSec: TTL_FAST_FEED_SEC,
                                        }}
                                        liveItems={mapAppleShelfToFypItems(shelf)}
                                      />
                                      <HorizontalShelfRail
                                        variant="tiles"
                                        itemCount={totalItems}
                                        shelfId={`apple:for_you:shelf:${shelf.id}`}
                                        shelfTitle={`🕒 ${shelf.title.toUpperCase()}`}
                                        accentColor="#fda4af"
                                        hasMore={effectiveRecentItemsOffset !== null}
                                        loadingMore={recentItemsLoadingMore}
                                        onLoadMore={handleLoadMoreRecentItems}
                                      >
                                        {renderOrderedAppleShelfItems(
                                          shelf,
                                          renderStationCard,
                                          renderCloudPlaylistCard,
                                          renderCloudAlbumCard
                                        )}
                                      </HorizontalShelfRail>
                                    </section>
                                  );
                                })}

                                {appleRecentlyPlayedTracks.length > 0 && (
                                  <section
                                    data-section-anchor="apple_recently_played_tracks"
                                    style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                                  >
                                    <PinnableSectionHeader
                                      title={`🎵 RECENTLY PLAYED TRACKS (${appleRecentlyPlayedTracks.length})`}
                                      accentColor="#fda4af"
                                      descriptor={{
                                        shelfUid: 'apple:for_you:recently_played',
                                        cacheKey: 'apple:for_you:recently_played',
                                        provider: 'apple_music',
                                        title: 'Apple Music • Recently Played Tracks',
                                        itemKind: 'tracks',
                                        fetchSpec: { kind: 'apple_for_you', section: 'recently_played' },
                                        originRoute: {
                                          sourceFilter: 'apple_music',
                                          appleSubTab: 'for_you',
                                          sectionAnchor: 'apple_recently_played_tracks',
                                        },
                                        ttlSec: TTL_FAST_FEED_SEC,
                                      }}
                                      liveItems={appleRecentlyPlayedTracks}
                                    />
                                    {forYouFilter === 'recently_played' ? (
                                      <div
                                        style={{
                                          display: 'flex',
                                          flexDirection: 'column',
                                          gap: 6,
                                        }}
                                      >
                                        {appleRecentlyPlayedTracks.map((s) =>
                                          renderSingleSongRow(
                                            s,
                                            appleRecentlyPlayedTracks,
                                            'for_you_recent'
                                          )
                                        )}
                                      </div>
                                    ) : (
                                      <HorizontalShelfRail
                                        variant="tracks"
                                        itemCount={appleRecentlyPlayedTracks.length}
                                        shelfId="apple:for_you:recently_played"
                                        shelfTitle="🎵 RECENTLY PLAYED TRACKS"
                                        accentColor="#fda4af"
                                        hasMore={effectiveRecentTracksOffset !== null}
                                        loadingMore={recentTracksLoadingMore}
                                        onLoadMore={handleLoadMoreRecentTracks}
                                      >
                                        {appleRecentlyPlayedTracks.map((s) =>
                                          renderSingleSongRow(
                                            s,
                                            appleRecentlyPlayedTracks,
                                            'for_you_recent',
                                            true
                                          )
                                        )}
                                      </HorizontalShelfRail>
                                    )}
                                  </section>
                                )}
                              </>
                            )}

                          {(forYouFilter === 'all' || forYouFilter === 'recent_library') &&
                            recentlyAddedCloudAlbums.length > 0 && (
                              <section
                                data-section-anchor="apple_recent_library"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`☁️ RECENTLY ADDED TO YOUR APPLE CLOUD LIBRARY (${recentlyAddedCloudAlbums.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:for_you:recent_library',
                                    cacheKey: 'apple:for_you:recent_library',
                                    provider: 'apple_music',
                                    title: 'Apple Music • Recently Added Library',
                                    itemKind: 'albums',
                                    fetchSpec: { kind: 'apple_for_you', section: 'recent_library' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'for_you',
                                      sectionAnchor: 'apple_recent_library',
                                    },
                                    ttlSec: TTL_CATALOG_FEED_SEC,
                                  }}
                                  liveItems={recentlyAddedCloudAlbums}
                                />
                                <HorizontalShelfRail variant="tiles" itemCount={recentlyAddedCloudAlbums.length}>
                                  {recentlyAddedCloudAlbums.map(renderCloudAlbumCard)}
                                </HorizontalShelfRail>
                              </section>
                            )}

                          {(forYouFilter === 'all' ||
                            forYouFilter === 'mixes' ||
                            forYouFilter === 'social') &&
                            (otherShelves.length > 0 ? (
                              <>
                                {otherShelves
                                  .filter((s) => (forYouFilter === 'social' ? s.is_social : true))
                                  .map((shelf) => {
                                    const totalItems =
                                      shelf.playlists.length +
                                      shelf.albums.length +
                                      shelf.stations.length;
                                    if (totalItems === 0) return null;
                                    const anchor = `apple_shelf_${shelf.id}`;
                                    return (
                                      <section
                                        key={shelf.id}
                                        data-section-anchor={anchor}
                                        style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                                      >
                                        <PinnableSectionHeader
                                          title={
                                            <>
                                              <span>
                                                {shelf.is_social ? '👥' : '✨'}{' '}
                                                {shelf.title.toUpperCase()} ({totalItems})
                                              </span>
                                              {shelf.is_social && (
                                                <span
                                                  style={{
                                                    padding: '2px 7px',
                                                    borderRadius: 999,
                                                    background: '#2a131c',
                                                    border: '1px solid #fa243c',
                                                    color: '#fecdd3',
                                                    fontSize: 9.5,
                                                    fontWeight: 800,
                                                  }}
                                                >
                                                  👥 Friends Listening
                                                </span>
                                              )}
                                            </>
                                          }
                                          accentColor="#fda4af"
                                          descriptor={{
                                            shelfUid: `apple:for_you:shelf:${shelf.id}`,
                                            cacheKey: `apple:for_you:shelf:${shelf.id}`,
                                            provider: 'apple_music',
                                            title: `Apple Music • ${shelf.title}`,
                                            itemKind: inferAppleShelfItemKind(shelf),
                                            fetchSpec: {
                                              kind: 'apple_for_you',
                                              section: 'shelf',
                                              shelfId: shelf.id,
                                            },
                                            originRoute: {
                                              sourceFilter: 'apple_music',
                                              appleSubTab: 'for_you',
                                              sectionAnchor: anchor,
                                            },
                                            ttlSec: TTL_FAST_FEED_SEC,
                                          }}
                                          liveItems={mapAppleShelfToFypItems(shelf)}
                                        />
                                        <HorizontalShelfRail variant="tiles" itemCount={totalItems}>
                                          {renderOrderedAppleShelfItems(
                                            shelf,
                                            renderStationCard,
                                            renderCloudPlaylistCard,
                                            renderCloudAlbumCard
                                          )}
                                        </HorizontalShelfRail>
                                      </section>
                                    );
                                  })}
                              </>
                            ) : (
                              <>
                                {forYouPlaylists.length > 0 && (
                                  <section
                                    data-section-anchor="apple_for_you_mixes"
                                    style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                                  >
                                    <PinnableSectionHeader
                                      title={`✨ MADE FOR YOU & HEAVY ROTATION (${forYouPlaylists.length})`}
                                      accentColor="#fda4af"
                                      descriptor={{
                                        shelfUid: 'apple:for_you:mixes',
                                        cacheKey: 'apple:for_you:mixes',
                                        provider: 'apple_music',
                                        title: 'Apple Music • Made For You & Heavy Rotation',
                                        itemKind: 'playlists',
                                        fetchSpec: { kind: 'apple_for_you', section: 'for_you_playlists' },
                                        originRoute: {
                                          sourceFilter: 'apple_music',
                                          appleSubTab: 'for_you',
                                          sectionAnchor: 'apple_for_you_mixes',
                                        },
                                        ttlSec: TTL_FAST_FEED_SEC,
                                      }}
                                      liveItems={forYouPlaylists}
                                    />
                                    <HorizontalShelfRail variant="tiles" itemCount={forYouPlaylists.length}>
                                      {forYouPlaylists.map(renderCloudPlaylistCard)}
                                    </HorizontalShelfRail>
                                  </section>
                                )}

                                {forYouAlbums.length > 0 && (
                                  <section
                                    data-section-anchor="apple_for_you_albums"
                                    style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                                  >
                                    <PinnableSectionHeader
                                      title={`💿 RECOMMENDED FULL ALBUMS (${forYouAlbums.length})`}
                                      accentColor="#fda4af"
                                      descriptor={{
                                        shelfUid: 'apple:for_you:albums',
                                        cacheKey: 'apple:for_you:albums',
                                        provider: 'apple_music',
                                        title: 'Apple Music • Recommended Full Albums',
                                        itemKind: 'albums',
                                        fetchSpec: { kind: 'apple_for_you', section: 'for_you_albums' },
                                        originRoute: {
                                          sourceFilter: 'apple_music',
                                          appleSubTab: 'for_you',
                                          sectionAnchor: 'apple_for_you_albums',
                                        },
                                        ttlSec: TTL_FAST_FEED_SEC,
                                      }}
                                      liveItems={forYouAlbums}
                                    />
                                    <HorizontalShelfRail variant="tiles" itemCount={forYouAlbums.length}>
                                      {forYouAlbums.map(renderCloudAlbumCard)}
                                    </HorizontalShelfRail>
                                  </section>
                                )}
                              </>
                            ))}
                        </>
                      );
                    })()}
                  </>
                )}

                {/* ---------------------------------------------------------
                    5. 🔥 NEW RELEASES & TOP CHARTS HUB (Recent Releases For You + Charts)
                   --------------------------------------------------------- */}
                {browseHubTarget === 'apple_discover' &&
                  appleSubTab === 'new' &&
                  snap?.apple_authenticated && (
                  <>
                    {(() => {
                      const recentReleasesForYou =
                        newFeedRecentReleases.length > 0
                          ? newFeedRecentReleases
                          : forYouNewReleases;
                      return (
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
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                flexWrap: 'wrap',
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 14,
                                  fontWeight: 800,
                                  color: '#fecdd3',
                                  marginRight: 6,
                                }}
                              >
                                🔥 New & Charts
                              </span>
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                              <FilterTriggerButton
                                summary={newFilter === 'all' ? 'All' : newFilter.replace('_', ' ')}
                                active={newFilter !== 'all'}
                                accentColor="#fa243c"
                                activeBg="#28111b"
                                activeText="#fecdd3"
                                onClick={onOpenFilters}
                              />
                              <button
                                data-right-filter-pill="true"
                                onClick={() => {
                                  setCloudLoading(true);
                                  fetchAppleNewFeed()
                                    .then((res) => {
                                      setNewFeedRecentReleases?.(res.recent_releases ?? []);
                                      setNewFeedAlbums(res.albums);
                                      setNewFeedPlaylists(res.playlists);
                                      setNewFeedSongs(res.songs);
                                    })
                                    .catch(() => {})
                                    .finally(() => setCloudLoading(false));
                                }}
                                style={{
                                  padding: '4px 9px',
                                  borderRadius: 6,
                                  background: '#161620',
                                  border: '1px solid #2a2a38',
                                  color: '#fda4af',
                                  fontSize: 11,
                                  fontWeight: 700,
                                  cursor: 'pointer',
                                }}
                              >
                                ↻ Refresh
                              </button>
                            </div>
                          </div>

                          {(newFilter === 'all' || newFilter === 'recent_releases') &&
                            recentReleasesForYou.length > 0 && (
                              <section
                                data-section-anchor="apple_new_recent_releases"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`🆕 RECENT RELEASES FOR YOU (${recentReleasesForYou.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:new:recent_releases',
                                    cacheKey: 'apple:new:recent_releases',
                                    provider: 'apple_music',
                                    title: 'Apple Music • Recent Releases For You',
                                    itemKind: 'albums',
                                    fetchSpec: { kind: 'apple_new', section: 'recent_releases' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'new',
                                      sectionAnchor: 'apple_new_recent_releases',
                                    },
                                    ttlSec: TTL_CATALOG_FEED_SEC,
                                  }}
                                  liveItems={recentReleasesForYou}
                                />
                                <HorizontalShelfRail variant="tiles" itemCount={recentReleasesForYou.length}>
                                  {recentReleasesForYou.map(renderCloudAlbumCard)}
                                </HorizontalShelfRail>
                              </section>
                            )}

                          {(newFilter === 'all' || newFilter === 'albums') &&
                            newFeedAlbums.length > 0 && (
                              <section
                                data-section-anchor="apple_new_albums"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`💿 NEW & TOP ALBUMS (${newFeedAlbums.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:new:albums',
                                    cacheKey: 'apple:new:albums',
                                    provider: 'apple_music',
                                    title: 'Apple Music • New & Top Albums',
                                    itemKind: 'albums',
                                    fetchSpec: { kind: 'apple_new', section: 'albums' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'new',
                                      sectionAnchor: 'apple_new_albums',
                                    },
                                    ttlSec: TTL_CATALOG_FEED_SEC,
                                  }}
                                  liveItems={newFeedAlbums}
                                />
                                <HorizontalShelfRail variant="tiles" itemCount={newFeedAlbums.length}>
                                  {newFeedAlbums.map(renderCloudAlbumCard)}
                                </HorizontalShelfRail>
                              </section>
                            )}

                          {(newFilter === 'all' || newFilter === 'playlists') &&
                            newFeedPlaylists.length > 0 && (
                              <section
                                data-section-anchor="apple_new_playlists"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`🎶 NEW & FEATURED PLAYLISTS (${newFeedPlaylists.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:new:playlists',
                                    cacheKey: 'apple:new:playlists',
                                    provider: 'apple_music',
                                    title: 'Apple Music • New & Featured Playlists',
                                    itemKind: 'playlists',
                                    fetchSpec: { kind: 'apple_new', section: 'playlists' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'new',
                                      sectionAnchor: 'apple_new_playlists',
                                    },
                                    ttlSec: TTL_CATALOG_FEED_SEC,
                                  }}
                                  liveItems={newFeedPlaylists}
                                />
                                <HorizontalShelfRail variant="tiles" itemCount={newFeedPlaylists.length}>
                                  {newFeedPlaylists.map(renderCloudPlaylistCard)}
                                </HorizontalShelfRail>
                              </section>
                            )}

                          {(newFilter === 'all' || newFilter === 'songs') &&
                            newFeedSongs.length > 0 && (
                              <section
                                data-section-anchor="apple_new_songs"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`🎵 TOP NEW SONGS / SINGLES (${newFeedSongs.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:new:songs',
                                    cacheKey: 'apple:new:songs',
                                    provider: 'apple_music',
                                    title: 'Apple Music • Top New Songs & Singles',
                                    itemKind: 'tracks',
                                    fetchSpec: { kind: 'apple_new', section: 'songs' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'new',
                                      sectionAnchor: 'apple_new_songs',
                                    },
                                    ttlSec: TTL_CATALOG_FEED_SEC,
                                  }}
                                  liveItems={newFeedSongs}
                                />
                                {newFilter === 'songs' ? (
                                  <div
                                    style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                                  >
                                    {newFeedSongs.map((s) =>
                                      renderSingleSongRow(s, newFeedSongs, 'new')
                                    )}
                                  </div>
                                ) : (
                                  <HorizontalShelfRail variant="tracks" itemCount={newFeedSongs.length}>
                                    {newFeedSongs.map((s) =>
                                      renderSingleSongRow(s, newFeedSongs, 'new', true)
                                    )}
                                  </HorizontalShelfRail>
                                )}
                              </section>
                            )}
                        </>
                      );
                    })()}
                  </>
                )}

                {/* ---------------------------------------------------------
                    5B. 📻 RADIO HUB (Live Broadcast, Artist-Hosted Shows, Club Mixes & Stations by Genre)
                   --------------------------------------------------------- */}
                {browseHubTarget === 'apple_discover' &&
                  appleSubTab === 'radio' &&
                  snap?.apple_authenticated && (
                  <>
                    {(() => {
                      const stationsToDisplay =
                        liveRadioStations.length > 0 ? liveRadioStations : radioStations;
                      const allGenreStations =
                        genreRadioStations.length > 0 ? genreRadioStations : radioStations;
                      const filteredGenreStations = appleRadioGenre
                        ? allGenreStations.filter(
                            (st) =>
                              (st.genre || '').toLowerCase() === appleRadioGenre.toLowerCase() ||
                              st.name.toLowerCase().includes(appleRadioGenre.toLowerCase()) ||
                              st.subtitle.toLowerCase().includes(appleRadioGenre.toLowerCase())
                          )
                        : allGenreStations;

                      return (
                        <>
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 8,
                              paddingBottom: 10,
                              borderBottom: '1px solid #16161c',
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
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 6,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 14,
                                    fontWeight: 800,
                                    color: '#fecdd3',
                                    marginRight: 4,
                                  }}
                                >
                                  📻 Apple Music Radio
                                </span>
                              </div>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                                <FilterTriggerButton
                                  summary={`${appleRadioFilter === 'all' ? 'All Radio' : appleRadioFilter}${appleRadioGenre ? ` • ${appleRadioGenre}` : ''}`}
                                  active={appleRadioFilter !== 'all' || Boolean(appleRadioGenre)}
                                  accentColor="#fa243c"
                                  activeBg="#28111b"
                                  activeText="#fecdd3"
                                  onClick={onOpenFilters}
                                />
                                <button
                                  data-right-filter-pill="true"
                                  onClick={() => {
                                    setCloudLoading(true);
                                    fetchAppleRadioAndForYou()
                                      .then((res) => {
                                        setRadioStations(res.stations);
                                        setPersonalRadioStations?.(res.personal_stations ?? []);
                                        setLiveRadioStations?.(res.live_stations ?? []);
                                        setArtistRadioShows?.(res.artist_shows ?? []);
                                        setClubMixes?.(res.club_mixes ?? []);
                                        setGenreRadioStations?.(res.genre_stations ?? []);
                                        setForYouNewReleases?.(res.new_releases ?? []);
                                        setForYouPlaylists(res.playlists);
                                        setForYouAlbums(res.albums);
                                        setForYouShelves?.(res.shelves ?? []);
                                        setAppleRecentlyPlayedTracks?.(res.recently_played ?? []);
                                      })
                                      .catch(() => {})
                                      .finally(() => setCloudLoading(false));
                                  }}
                                  style={{
                                    padding: '4px 9px',
                                    borderRadius: 6,
                                    background: '#161620',
                                    border: '1px solid #2a2a38',
                                    color: '#fda4af',
                                    fontSize: 11,
                                    fontWeight: 700,
                                    cursor: 'pointer',
                                  }}
                                >
                                  ↻ Refresh
                                </button>
                              </div>
                            </div>
                          </div>

                          {(appleRadioFilter === 'all' || appleRadioFilter === 'live') &&
                            personalRadioStations.length > 0 && (
                              <section
                                data-section-anchor="apple_personal_stations"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`📻 PERSONAL & DISCOVERY STATIONS (${personalRadioStations.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:for_you:personal_stations',
                                    cacheKey: 'apple:for_you:personal_stations',
                                    provider: 'apple_music',
                                    title: 'Apple Music • Personal Radio Stations',
                                    itemKind: 'stations',
                                    fetchSpec: { kind: 'apple_for_you', section: 'personal_stations' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'radio',
                                      sectionAnchor: 'apple_personal_stations',
                                    },
                                    ttlSec: TTL_FAST_FEED_SEC,
                                  }}
                                  liveItems={personalRadioStations}
                                />
                                <HorizontalShelfRail variant="tiles" itemCount={personalRadioStations.length}>
                                  {personalRadioStations.map(renderStationCard)}
                                </HorizontalShelfRail>
                              </section>
                            )}

                          {(appleRadioFilter === 'all' || appleRadioFilter === 'live') &&
                            stationsToDisplay.length > 0 && (
                              <section
                                data-section-anchor="apple_radio_live"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`📡 LIVE GLOBAL BROADCAST STATIONS — APPLE MUSIC 1, HITS, COUNTRY & CLUB (${stationsToDisplay.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:radio:live',
                                    cacheKey: 'apple:radio:live',
                                    provider: 'apple_music',
                                    title: 'Apple Music • Live Broadcast Stations',
                                    itemKind: 'stations',
                                    fetchSpec: { kind: 'apple_radio', section: 'live' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'radio',
                                      sectionAnchor: 'apple_radio_live',
                                    },
                                    ttlSec: TTL_CATALOG_FEED_SEC,
                                  }}
                                  liveItems={stationsToDisplay}
                                />
                                <HorizontalShelfRail variant="tiles" itemCount={stationsToDisplay.length}>
                                  {stationsToDisplay.map(renderStationCard)}
                                </HorizontalShelfRail>
                              </section>
                            )}

                          {(appleRadioFilter === 'all' || appleRadioFilter === 'shows') &&
                            artistRadioShows.length > 0 && (
                              <section
                                data-section-anchor="apple_radio_shows"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`🎙️ ARTIST-HOSTED SHOWS, RADIO HOSTS & INTERVIEWS (${artistRadioShows.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:radio:shows',
                                    cacheKey: 'apple:radio:shows',
                                    provider: 'apple_music',
                                    title: 'Apple Music • Artist-Hosted Radio Shows',
                                    itemKind: 'playlists',
                                    fetchSpec: { kind: 'apple_radio', section: 'shows' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'radio',
                                      sectionAnchor: 'apple_radio_shows',
                                    },
                                    ttlSec: TTL_CATALOG_FEED_SEC,
                                  }}
                                  liveItems={artistRadioShows}
                                />
                                <HorizontalShelfRail variant="tiles" itemCount={artistRadioShows.length}>
                                  {artistRadioShows.map(renderCloudPlaylistCard)}
                                </HorizontalShelfRail>
                              </section>
                            )}

                          {(appleRadioFilter === 'all' || appleRadioFilter === 'mixes') &&
                            clubMixes.length > 0 && (
                              <section
                                data-section-anchor="apple_radio_mixes"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`🎧 CLUB MIXES & DJ SETS (${clubMixes.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:radio:mixes',
                                    cacheKey: 'apple:radio:mixes',
                                    provider: 'apple_music',
                                    title: 'Apple Music • Club Mixes & DJ Sets',
                                    itemKind: 'playlists',
                                    fetchSpec: { kind: 'apple_radio', section: 'mixes' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'radio',
                                      sectionAnchor: 'apple_radio_mixes',
                                    },
                                    ttlSec: TTL_CATALOG_FEED_SEC,
                                  }}
                                  liveItems={clubMixes}
                                />
                                <HorizontalShelfRail variant="tiles" itemCount={clubMixes.length}>
                                  {clubMixes.map(renderCloudPlaylistCard)}
                                </HorizontalShelfRail>
                              </section>
                            )}

                          {(appleRadioFilter === 'all' || appleRadioFilter === 'genre') &&
                            filteredGenreStations.length > 0 && (
                              <section
                                data-section-anchor="apple_radio_genre"
                                style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                              >
                                <PinnableSectionHeader
                                  title={`🎶 STATIONS BY GENRE & TOP STATIONS${
                                    appleRadioGenre ? ` — ${appleRadioGenre.toUpperCase()}` : ''
                                  } (${filteredGenreStations.length})`}
                                  accentColor="#fda4af"
                                  descriptor={{
                                    shelfUid: 'apple:radio:genre',
                                    cacheKey: 'apple:radio:genre',
                                    provider: 'apple_music',
                                    title: 'Apple Music • Genre & Top Stations',
                                    itemKind: 'stations',
                                    fetchSpec: { kind: 'apple_radio', section: 'genre' },
                                    originRoute: {
                                      sourceFilter: 'apple_music',
                                      appleSubTab: 'radio',
                                      sectionAnchor: 'apple_radio_genre',
                                    },
                                    ttlSec: TTL_CATALOG_FEED_SEC,
                                  }}
                                  liveItems={filteredGenreStations}
                                />
                                <HorizontalShelfRail variant="tiles" itemCount={filteredGenreStations.length}>
                                  {filteredGenreStations.map(renderStationCard)}
                                </HorizontalShelfRail>
                              </section>
                            )}

                          {stationsToDisplay.length === 0 &&
                            artistRadioShows.length === 0 &&
                            clubMixes.length === 0 &&
                            filteredGenreStations.length === 0 && (
                              <div
                                style={{
                                  padding: 28,
                                  textAlign: 'center',
                                  color: '#9ca3af',
                                  fontSize: 12,
                                }}
                              >
                                {cloudLoading
                                  ? 'Loading Apple Music radio stations, shows & mixes…'
                                  : 'No radio stations returned right now. Click Refresh to retry.'}
                              </div>
                            )}
                        </>
                      );
                    })()}
                  </>
                )}
    </>
  );
};
