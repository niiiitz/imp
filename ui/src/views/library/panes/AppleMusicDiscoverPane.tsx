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
} from "../../../drivers/AppleMusicDriver";
import {
  AlphaBucket,
  tileGridStyle,
} from "../libraryHelpers";
import { AppleMusicLogo } from "../../../components/AppleMusicLogo";
import { PinnableSectionHeader } from "../PinnableSectionHeader";
import {
  inferAppleShelfItemKind,
  mapAppleShelfToFypItems,
  TTL_CATALOG_FEED_SEC,
  TTL_FAST_FEED_SEC,
} from "../../../api/servicesCacheApi";

export interface AppleMusicDiscoverPaneProps {
  appleRadioFilter: "all" | "genre" | "live" | "shows" | "mixes";
  appleRadioGenre: string;
  appleRecentlyPlayedTracks: TrackMetadata[];
  appleSubTab: "pinned" | "for_you" | "cloud_playlists" | "new" | "radio";
  artistRadioShows: AppleCloudPlaylistSummary[];
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
  pagedCloudPlaylists: AppleCloudPlaylistSummary[];
  personalRadioStations: AppleRadioStationSummary[];
  radioStations: AppleRadioStationSummary[];
  recentlyAddedCloudAlbums: AppleCloudAlbumSummary[];
  renderCloudAlbumCard: any;
  renderCloudPlaylistCard: any;
  renderSingleSongRow: any;
  renderStationCard: any;
  resetCloudPlaylistsLimit: () => void;
  setAppleRadioFilter: any;
  setAppleRadioGenre: any;
  setAppleRecentlyPlayedTracks: any;
  setArtistRadioShows: any;
  setCloudAlpha: any;
  setCloudLoading: any;
  setCloudPlaylists: React.Dispatch<React.SetStateAction<AppleCloudPlaylistSummary[]>>;
  setClubMixes: any;
  setForYouAlbums: any;
  setForYouFilter: any;
  setForYouNewReleases: any;
  setForYouPlaylists: any;
  setForYouShelves: any;
  setGenreRadioStations: any;
  setLiveRadioStations: any;
  setNewFeedAlbums: any;
  setNewFeedPlaylists: any;
  setNewFeedRecentReleases: any;
  setNewFeedSongs: any;
  setNewFilter: any;
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
  browserSourceFilter,
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
  pagedCloudPlaylists,
  personalRadioStations,
  radioStations,
  recentlyAddedCloudAlbums,
  renderCloudAlbumCard,
  renderCloudPlaylistCard,
  renderSingleSongRow,
  renderStationCard,
  resetCloudPlaylistsLimit,
  setAppleRadioFilter,
  setAppleRadioGenre,
  setAppleRecentlyPlayedTracks,
  setArtistRadioShows,
  setCloudAlpha,
  setCloudLoading,
  setCloudPlaylists,
  setClubMixes,
  setForYouAlbums,
  setForYouFilter,
  setForYouNewReleases,
  setForYouPlaylists,
  setForYouShelves,
  setGenreRadioStations,
  setLiveRadioStations,
  setNewFeedAlbums,
  setNewFeedPlaylists,
  setNewFeedRecentReleases,
  setNewFeedSongs,
  setNewFilter,
  setPersonalRadioStations,
  setRadioStations,
  setRecentlyAddedCloudAlbums,
  snap,
}) => {
  return (
    <>
                {/* ---------------------------------------------------------
                    3. ☁️ APPLE LIBRARY PLAYLISTS HUB (Paginated 50/page + A-Z Jump Pills)
                   --------------------------------------------------------- */}
                {browserSourceFilter !== 'soundcloud' &&
                  browserSourceFilter !== 'internet_archive' &&
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
                      {/* A-Z Alphabetical Quick Filter Pills */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
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
                          <span>Apple Playlists</span>
                        </span>
                        {(
                          [
                            { id: 'all', label: `All (${cloudPlaylists.length})` },
                            { id: 'a_f', label: 'A–F' },
                            { id: 'g_l', label: 'G–L' },
                            { id: 'm_r', label: 'M–R' },
                            { id: 's_z', label: 'S–Z' },
                            { id: 'num', label: '#' },
                          ] as const
                        ).map((b) => {
                          const active = cloudAlpha === b.id;
                          return (
                            <button
                              key={b.id}
                              data-right-filter-pill="true"
                              onClick={() => {
                                setCloudAlpha(b.id);
                                resetCloudPlaylistsLimit();
                              }}
                              style={{
                                padding: '4px 9px',
                                borderRadius: 6,
                                background: active ? '#28111b' : '#101018',
                                border: active ? '1px solid #fa243c' : '1px solid #222230',
                                color: active ? '#fecdd3' : '#9ca3af',
                                fontSize: 11,
                                fontWeight: 800,
                                cursor: 'pointer',
                              }}
                            >
                              {b.label}
                            </button>
                          );
                        })}
                      </div>

                      {/* Visible Count + Reload */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
                {browserSourceFilter !== 'soundcloud' &&
                  browserSourceFilter !== 'internet_archive' &&
                  appleSubTab === 'for_you' &&
                  snap?.apple_authenticated && (
                  <>
                    {(() => {
                      const recentShelves = forYouShelves.filter(
                        (s) =>
                          s.id === 'recently-played' ||
                          s.title.toLowerCase().includes('recent')
                      );
                      const otherShelves = forYouShelves.filter(
                        (s) =>
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
                              {(
                                [
                                  { id: 'all' as const, label: 'All' },
                                  ...(personalRadioStations.length > 0
                                    ? [
                                        {
                                          id: 'stations' as const,
                                          label: `📻 Personal Radio (${personalRadioStations.length})`,
                                        },
                                      ]
                                    : []),
                                  ...(effectiveNewReleases.length > 0
                                    ? [
                                        {
                                          id: 'new_releases' as const,
                                          label: `🆕 New Releases (${effectiveNewReleases.length})`,
                                        },
                                      ]
                                    : []),
                                  ...(totalRecentCount > 0
                                    ? [
                                        {
                                          id: 'recently_played' as const,
                                          label: `🕒 Recently Played (${totalRecentCount})`,
                                        },
                                      ]
                                    : []),
                                  {
                                    id: 'mixes' as const,
                                    label: `✨ Mixes & Recommendations (${
                                      forYouPlaylists.length + forYouAlbums.length
                                    })`,
                                  },
                                  ...(otherShelves.some((s) => s.is_social)
                                    ? [
                                        {
                                          id: 'social' as const,
                                          label: `👥 Friends Listening (${
                                            otherShelves.filter((s) => s.is_social).length
                                          })`,
                                        },
                                      ]
                                    : []),
                                  ...(recentlyAddedCloudAlbums.length > 0
                                    ? [
                                        {
                                          id: 'recent_library' as const,
                                          label: `☁️ Recently Added (${recentlyAddedCloudAlbums.length})`,
                                        },
                                      ]
                                    : []),
                                ] as const
                              ).map((f) => {
                                const active = forYouFilter === f.id;
                                return (
                                  <button
                                    key={f.id}
                                    data-right-filter-pill="true"
                                    onClick={() => setForYouFilter(f.id)}
                                    style={{
                                      padding: '4px 10px',
                                      borderRadius: 6,
                                      background: active ? '#28111b' : '#101018',
                                      border: active
                                        ? '1px solid #fa243c'
                                        : '1px solid #222230',
                                      color: active ? '#fecdd3' : '#9ca3af',
                                      fontSize: 11,
                                      fontWeight: 800,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    {f.label}
                                  </button>
                                );
                              })}
                            </div>
                            <button
                              data-right-filter-pill="true"
                              onClick={() => {
                                setCloudLoading(true);
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
                                      if (Array.isArray(albs))
                                        setRecentlyAddedCloudAlbums(albs);
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
                                <div style={tileGridStyle}>
                                  {personalRadioStations.map(renderStationCard)}
                                </div>
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
                                <div style={tileGridStyle}>
                                  {effectiveNewReleases.map(renderCloudAlbumCard)}
                                </div>
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
                                      <div style={tileGridStyle}>
                                        {shelf.stations.map(renderStationCard)}
                                        {shelf.playlists.map(renderCloudPlaylistCard)}
                                        {shelf.albums.map(renderCloudAlbumCard)}
                                      </div>
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
                                    <div
                                      style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 6,
                                      }}
                                    >
                                      {appleRecentlyPlayedTracks
                                        .slice(
                                          0,
                                          forYouFilter === 'recently_played' ? 40 : 12
                                        )
                                        .map((s) =>
                                          renderSingleSongRow(
                                            s,
                                            appleRecentlyPlayedTracks,
                                            'for_you_recent'
                                          )
                                        )}
                                    </div>
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
                                <div style={tileGridStyle}>
                                  {recentlyAddedCloudAlbums.map(renderCloudAlbumCard)}
                                </div>
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
                                        <div style={tileGridStyle}>
                                          {shelf.stations.map(renderStationCard)}
                                          {shelf.playlists.map(renderCloudPlaylistCard)}
                                          {shelf.albums.map(renderCloudAlbumCard)}
                                        </div>
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
                                    <div style={tileGridStyle}>
                                      {forYouPlaylists.map(renderCloudPlaylistCard)}
                                    </div>
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
                                    <div style={tileGridStyle}>
                                      {forYouAlbums.map(renderCloudAlbumCard)}
                                    </div>
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
                {browserSourceFilter !== 'soundcloud' &&
                  browserSourceFilter !== 'internet_archive' &&
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
                              {(
                                [
                                  { id: 'all' as const, label: 'All' },
                                  ...(recentReleasesForYou.length > 0
                                    ? [
                                        {
                                          id: 'recent_releases' as const,
                                          label: `🆕 Recent Releases (${recentReleasesForYou.length})`,
                                        },
                                      ]
                                    : []),
                                  {
                                    id: 'albums' as const,
                                    label: `💿 New Albums (${newFeedAlbums.length})`,
                                  },
                                  {
                                    id: 'playlists' as const,
                                    label: `🎶 Featured Playlists (${newFeedPlaylists.length})`,
                                  },
                                  {
                                    id: 'songs' as const,
                                    label: `🎵 Top Singles (${newFeedSongs.length})`,
                                  },
                                ] as const
                              ).map((f) => {
                                const active = newFilter === f.id;
                                return (
                                  <button
                                    key={f.id}
                                    data-right-filter-pill="true"
                                    onClick={() => setNewFilter(f.id)}
                                    style={{
                                      padding: '4px 10px',
                                      borderRadius: 6,
                                      background: active ? '#28111b' : '#101018',
                                      border: active
                                        ? '1px solid #fa243c'
                                        : '1px solid #222230',
                                      color: active ? '#fecdd3' : '#9ca3af',
                                      fontSize: 11,
                                      fontWeight: 800,
                                      cursor: 'pointer',
                                    }}
                                  >
                                    {f.label}
                                  </button>
                                );
                              })}
                            </div>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
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
                                <div style={tileGridStyle}>
                                  {recentReleasesForYou.map(renderCloudAlbumCard)}
                                </div>
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
                                <div style={tileGridStyle}>
                                  {newFeedAlbums.map(renderCloudAlbumCard)}
                                </div>
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
                                <div style={tileGridStyle}>
                                  {newFeedPlaylists.map(renderCloudPlaylistCard)}
                                </div>
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
                                <div
                                  style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                                >
                                  {newFeedSongs.map((s) =>
                                    renderSingleSongRow(s, newFeedSongs, 'new')
                                  )}
                                </div>
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
                {browserSourceFilter !== 'soundcloud' &&
                  browserSourceFilter !== 'internet_archive' &&
                  appleSubTab === 'radio' &&
                  snap?.apple_authenticated && (
                  <>
                    {(() => {
                      const stationsToDisplay =
                        liveRadioStations.length > 0 ? liveRadioStations : radioStations;
                      const allGenreStations =
                        genreRadioStations.length > 0 ? genreRadioStations : radioStations;
                      const genreSet = new Set<string>();
                      for (const st of allGenreStations) {
                        if (st.genre) genreSet.add(st.genre);
                      }
                      const availableGenres = Array.from(genreSet).slice(0, 10);
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
                                {(
                                  [
                                    { id: 'all' as const, label: 'All Radio' },
                                    {
                                      id: 'live' as const,
                                      label: `📻 Live & Personal (${
                                        stationsToDisplay.length + personalRadioStations.length
                                      })`,
                                    },
                                    ...(artistRadioShows.length > 0
                                      ? [
                                          {
                                            id: 'shows' as const,
                                            label: `🎙️ Shows & Interviews (${artistRadioShows.length})`,
                                          },
                                        ]
                                      : []),
                                    ...(clubMixes.length > 0
                                      ? [
                                          {
                                            id: 'mixes' as const,
                                            label: `🎧 Club Mixes & DJ Sets (${clubMixes.length})`,
                                          },
                                        ]
                                      : []),
                                    {
                                      id: 'genre' as const,
                                      label: `📡 By Genre (${allGenreStations.length})`,
                                    },
                                  ] as const
                                ).map((tab) => {
                                  const active = appleRadioFilter === tab.id;
                                  return (
                                    <button
                                      key={tab.id}
                                      data-right-filter-pill="true"
                                      onClick={() => setAppleRadioFilter(tab.id)}
                                      style={{
                                        padding: '4px 10px',
                                        borderRadius: 6,
                                        background: active ? '#28111b' : '#101018',
                                        border: active
                                          ? '1px solid #fa243c'
                                          : '1px solid #222230',
                                        color: active ? '#fecdd3' : '#9ca3af',
                                        fontSize: 11,
                                        fontWeight: 800,
                                        cursor: 'pointer',
                                      }}
                                    >
                                      {tab.label}
                                    </button>
                                  );
                                })}
                              </div>
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

                            {availableGenres.length > 0 && (
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 5,
                                  flexWrap: 'wrap',
                                }}
                              >
                                <span
                                  style={{
                                    fontSize: 10,
                                    fontFamily: 'monospace',
                                    color: '#9ca3af',
                                  }}
                                >
                                  GENRE:
                                </span>
                                {[
                                  { id: '', label: '🌐 All Genres' },
                                  ...availableGenres.map((g) => ({ id: g, label: g })),
                                ].map((g) => {
                                  const active = appleRadioGenre === g.id;
                                  return (
                                    <button
                                      key={g.id || 'all-genres'}
                                      data-right-filter-pill="true"
                                      onClick={() => setAppleRadioGenre(g.id)}
                                      style={{
                                        padding: '3px 8px',
                                        borderRadius: 999,
                                        background: active ? '#28111b' : '#12121a',
                                        border: active
                                          ? '1px solid #fa243c'
                                          : '1px solid #232332',
                                        color: active ? '#fecdd3' : '#a1a1aa',
                                        fontSize: 10,
                                        fontWeight: 700,
                                        cursor: 'pointer',
                                      }}
                                    >
                                      {g.label}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
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
                                <div style={tileGridStyle}>
                                  {personalRadioStations.map(renderStationCard)}
                                </div>
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
                                <div style={tileGridStyle}>
                                  {stationsToDisplay.map(renderStationCard)}
                                </div>
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
                                <div style={tileGridStyle}>
                                  {artistRadioShows.map(renderCloudPlaylistCard)}
                                </div>
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
                                <div style={tileGridStyle}>
                                  {clubMixes.map(renderCloudPlaylistCard)}
                                </div>
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
                                <div style={tileGridStyle}>
                                  {filteredGenreStations.map(renderStationCard)}
                                </div>
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
