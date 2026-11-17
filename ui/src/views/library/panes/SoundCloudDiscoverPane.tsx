import React from "react";
import {
  defaultSimpClient,
  SimpStateSnapshot,
  TrackMetadata,
} from "@simp/client";
import {
  fetchSoundCloudDiscover,
  fetchSoundCloudFollowings,
  fetchSoundCloudLikesAndPlaylists,
  fetchSoundCloudStreamAndRadio,
  SoundCloudPlaylistSummary,
  SoundCloudUserSummary,
} from "../../../drivers/SoundCloudDriver";
import {
  tileGridStyle,
} from "../libraryHelpers";
import { FilterTriggerButton, PinnableSectionHeader } from "../PinnableSectionHeader";
import { TTL_CATALOG_FEED_SEC, TTL_FAST_FEED_SEC } from "../../../api/servicesCacheApi";

export interface SoundCloudDiscoverPaneProps {
  browseHubTarget: "imp_fyp" | "imp_library" | "apple_discover" | "soundcloud_discover" | "ia_discover" | "mount";
  browserSourceFilter: "all" | "local" | "apple_music" | "soundcloud" | "internet_archive";
  cloudLoading: boolean;
  handleStartSoundCloudTrackRadio: any;
  loadMoreScDiscover: any;
  onOpenFilters?: () => void;
  recentlyPlayed: TrackMetadata[];
  renderSingleSongRow: any;
  renderSoundCloudPlaylistCard: any;
  renderSoundCloudUserCard: any;
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
  setCloudLoading: any;
  setPlayingContextId: any;
  setScDiscoverNextHref: any;
  setScFollowings: any;
  setScLikedTracks: any;
  setScPlaylists: any;
  setScStreamPlaylists: any;
  setScStreamTracks: any;
  setScTrendingMixes: any;
  setScTrendingPlaylists: any;
  setScTrendingTracks: any;
  setView: any;
  snap: SimpStateSnapshot | null;
  soundCloudSubTab: "pinned" | "likes_sets" | "stream_radio" | "trending";
}

export const SoundCloudDiscoverPane: React.FC<SoundCloudDiscoverPaneProps> = ({
  browseHubTarget,
  cloudLoading,
  handleStartSoundCloudTrackRadio,
  loadMoreScDiscover,
  onOpenFilters,
  recentlyPlayed,
  renderSingleSongRow,
  renderSoundCloudPlaylistCard,
  renderSoundCloudUserCard,
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
  setCloudLoading,
  setPlayingContextId,
  setScDiscoverNextHref,
  setScFollowings,
  setScLikedTracks,
  setScPlaylists,
  setScStreamPlaylists,
  setScStreamTracks,
  setScTrendingMixes,
  setScTrendingPlaylists,
  setScTrendingTracks,
  setView,
  snap,
  soundCloudSubTab,
}) => {
  return (
    <>
                {/* ---------------------------------------------------------
                    6. ☁️ SOUNDCLOUD LIKES & SETS HUB (Personal Account OAuth)
                   --------------------------------------------------------- */}
                {browseHubTarget === 'soundcloud_discover' && soundCloudSubTab === 'likes_sets' && (
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
                            color: '#fed7aa',
                            marginRight: 6,
                          }}
                        >
                          ❤️ Likes & Sets
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <FilterTriggerButton
                          summary={scLikesFilter === 'all' ? 'All' : scLikesFilter}
                          active={scLikesFilter !== 'all'}
                          accentColor="#ff5500"
                          activeBg="#2c140a"
                          activeText="#fed7aa"
                          onClick={onOpenFilters}
                        />
                        {scLikedTracks.length > 0 && (
                          <button
                            data-right-filter-pill="true"
                            onClick={() => {
                              setPlayingContextId('sc:likes');
                              defaultSimpClient.loadQueue(
                                scLikedTracks.map((t) => t.uri),
                                0,
                                scLikedTracks
                              );
                              setView('lock');
                            }}
                            style={{
                              padding: '4px 10px',
                              borderRadius: 6,
                              background: '#2c140a',
                              border: '1px solid #ff5500',
                              color: '#fed7aa',
                              fontSize: 11,
                              fontWeight: 800,
                              cursor: 'pointer',
                            }}
                          >
                            ▶ Play All Likes
                          </button>
                        )}
                        <button
                          data-right-filter-pill="true"
                          onClick={() => {
                            setCloudLoading(true);
                            Promise.all([
                              fetchSoundCloudLikesAndPlaylists().then((res) => {
                                setScLikedTracks(res.likedTracks);
                                setScPlaylists(res.playlists);
                              }),
                              fetchSoundCloudFollowings().then((users) => {
                                if (Array.isArray(users)) setScFollowings(users);
                              }),
                            ])
                              .catch(() => {})
                              .finally(() => setCloudLoading(false));
                          }}
                          style={{
                            padding: '4px 9px',
                            borderRadius: 6,
                            background: '#161620',
                            border: '1px solid #2a2a38',
                            color: '#fdba74',
                            fontSize: 11,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          ↻ Refresh
                        </button>
                      </div>
                    </div>

                    {(scLikesFilter === 'all' || scLikesFilter === 'sets') &&
                      scPlaylists.length > 0 && (
                        <section
                          data-section-anchor="sc_sets"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <PinnableSectionHeader
                            title={`🎶 YOUR SOUNDCLOUD SETS & PLAYLISTS (${scPlaylists.length})`}
                            accentColor="#fdba74"
                            descriptor={{
                              shelfUid: 'soundcloud:likes:sets',
                              cacheKey: 'soundcloud:likes:sets',
                              provider: 'soundcloud',
                              title: 'SoundCloud • Your Sets & Playlists',
                              itemKind: 'playlists',
                              fetchSpec: { kind: 'sc_likes', section: 'sets' },
                              originRoute: {
                                sourceFilter: 'soundcloud',
                                soundCloudSubTab: 'likes_sets',
                                sectionAnchor: 'sc_sets',
                              },
                              ttlSec: TTL_CATALOG_FEED_SEC,
                            }}
                            liveItems={scPlaylists}
                          />
                          <div style={tileGridStyle}>
                            {scPlaylists.map(renderSoundCloudPlaylistCard)}
                          </div>
                        </section>
                      )}

                    {(scLikesFilter === 'all' || scLikesFilter === 'following') &&
                      scFollowings.length > 0 && (
                        <section
                          data-section-anchor="sc_followings"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <PinnableSectionHeader
                            title={`👥 FOLLOWED CREATORS & DJS (${scFollowings.length})`}
                            accentColor="#fdba74"
                            descriptor={{
                              shelfUid: 'soundcloud:likes:followings',
                              cacheKey: 'soundcloud:likes:followings',
                              provider: 'soundcloud',
                              title: 'SoundCloud • Followed Creators & DJs',
                              itemKind: 'artists',
                              fetchSpec: { kind: 'sc_likes', section: 'followings' },
                              originRoute: {
                                sourceFilter: 'soundcloud',
                                soundCloudSubTab: 'likes_sets',
                                sectionAnchor: 'sc_followings',
                              },
                              ttlSec: TTL_CATALOG_FEED_SEC,
                            }}
                            liveItems={scFollowings}
                          />
                          <div style={tileGridStyle}>
                            {scFollowings.map(renderSoundCloudUserCard)}
                          </div>
                        </section>
                      )}

                    {(scLikesFilter === 'all' || scLikesFilter === 'likes') &&
                      scLikedTracks.length > 0 && (
                        <section
                          data-section-anchor="sc_liked_tracks"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <PinnableSectionHeader
                            title={`❤️ LIKED TRACKS (${scLikedTracks.length})`}
                            accentColor="#fdba74"
                            descriptor={{
                              shelfUid: 'soundcloud:likes:tracks',
                              cacheKey: 'soundcloud:likes:tracks',
                              provider: 'soundcloud',
                              title: 'SoundCloud • Liked Tracks',
                              itemKind: 'tracks',
                              fetchSpec: { kind: 'sc_likes', section: 'liked_tracks' },
                              originRoute: {
                                sourceFilter: 'soundcloud',
                                soundCloudSubTab: 'likes_sets',
                                sectionAnchor: 'sc_liked_tracks',
                              },
                              ttlSec: TTL_CATALOG_FEED_SEC,
                            }}
                            liveItems={scLikedTracks}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {scLikedTracks.map((s) =>
                              renderSingleSongRow(s, scLikedTracks, 'sc_likes')
                            )}
                          </div>
                        </section>
                      )}

                    {scPlaylists.length === 0 &&
                      scLikedTracks.length === 0 &&
                      scFollowings.length === 0 &&
                      !cloudLoading && (
                      <div style={{ fontSize: 12, color: '#8e8e99', padding: '12px 4px' }}>
                        {snap?.soundcloud_authenticated
                          ? 'No SoundCloud likes or sets found yet.'
                          : 'Sign in with your personal SoundCloud account (OAuth 2.1 + PKCE) to browse your Likes & Sets, or switch to 🔥 Trending & Mixes.'}
                      </div>
                    )}
                  </>
                )}

                {/* ---------------------------------------------------------
                    7. ⚡ SOUNDCLOUD STREAM & RADIO HUB (Following Stream + Listening History + Track Radio)
                   --------------------------------------------------------- */}
                {browseHubTarget === 'soundcloud_discover' && soundCloudSubTab === 'stream_radio' && (
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
                            color: '#fed7aa',
                            marginRight: 6,
                          }}
                        >
                          ⚡ Stream & Radio
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <FilterTriggerButton
                          summary={scStreamFilter === 'all' ? 'All' : scStreamFilter}
                          active={scStreamFilter !== 'all'}
                          accentColor="#ff5500"
                          activeBg="#2c140a"
                          activeText="#fed7aa"
                          onClick={onOpenFilters}
                        />
                        {(scStreamTracks.length > 0 || scLikedTracks.length > 0) && (
                          <button
                            data-right-filter-pill="true"
                            onClick={() => {
                              const seed = scStreamTracks[0] || scLikedTracks[0];
                              if (seed) handleStartSoundCloudTrackRadio(seed);
                            }}
                            style={{
                              padding: '4px 10px',
                              borderRadius: 6,
                              background: '#2c140a',
                              border: '1px solid #ff5500',
                              color: '#fed7aa',
                              fontSize: 11,
                              fontWeight: 800,
                              cursor: 'pointer',
                            }}
                          >
                            📻 Start Station
                          </button>
                        )}
                        <button
                          data-right-filter-pill="true"
                          onClick={() => {
                            setCloudLoading(true);
                            fetchSoundCloudStreamAndRadio()
                              .then((res) => {
                                setScStreamTracks(res.streamTracks);
                                setScStreamPlaylists(res.streamPlaylists);
                              })
                              .catch(() => {})
                              .finally(() => setCloudLoading(false));
                          }}
                          style={{
                            padding: '4px 9px',
                            borderRadius: 6,
                            background: '#161620',
                            border: '1px solid #2a2a38',
                            color: '#fdba74',
                            fontSize: 11,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          ↻ Refresh
                        </button>
                      </div>
                    </div>

                    {(scStreamFilter === 'all' || scStreamFilter === 'history') &&
                      recentlyPlayed.some((t) => t.source === 'soundcloud') && (
                        <>
                          <div style={{ fontSize: 11, fontFamily: 'monospace', color: '#fdba74' }}>
                            🕒 LISTENING HISTORY IN SIMP (
                            {recentlyPlayed.filter((t) => t.source === 'soundcloud').length})
                          </div>
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {recentlyPlayed
                              .filter((t) => t.source === 'soundcloud')
                              .map((s) =>
                                renderSingleSongRow(
                                  s,
                                  recentlyPlayed.filter((t) => t.source === 'soundcloud'),
                                  'sc_history'
                                )
                              )}
                          </div>
                        </>
                      )}

                    {(scStreamFilter === 'all' || scStreamFilter === 'sets') &&
                      scStreamPlaylists.length > 0 && (
                        <section
                          data-section-anchor="sc_stream_sets"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <PinnableSectionHeader
                            title={`🎶 SETS FROM ARTISTS YOU FOLLOW (${scStreamPlaylists.length})`}
                            accentColor="#fdba74"
                            descriptor={{
                              shelfUid: 'soundcloud:stream:sets',
                              cacheKey: 'soundcloud:stream:sets',
                              provider: 'soundcloud',
                              title: 'SoundCloud • Reposted Sets from Following',
                              itemKind: 'playlists',
                              fetchSpec: { kind: 'sc_stream', section: 'stream_sets' },
                              originRoute: {
                                sourceFilter: 'soundcloud',
                                soundCloudSubTab: 'stream_radio',
                                sectionAnchor: 'sc_stream_sets',
                              },
                              ttlSec: TTL_FAST_FEED_SEC,
                            }}
                            liveItems={scStreamPlaylists}
                          />
                          <div style={tileGridStyle}>
                            {scStreamPlaylists.map(renderSoundCloudPlaylistCard)}
                          </div>
                        </section>
                      )}

                    {(scStreamFilter === 'all' || scStreamFilter === 'stream') &&
                      scStreamTracks.length > 0 && (
                        <section
                          data-section-anchor="sc_stream_tracks"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <PinnableSectionHeader
                            title={`⚡ FOLLOWING STREAM — UPLOADS & REPOSTS FROM ARTISTS YOU FOLLOW (${scStreamTracks.length})`}
                            accentColor="#fdba74"
                            descriptor={{
                              shelfUid: 'soundcloud:stream:tracks',
                              cacheKey: 'soundcloud:stream:tracks',
                              provider: 'soundcloud',
                              title: 'SoundCloud • Following Stream',
                              itemKind: 'tracks',
                              fetchSpec: { kind: 'sc_stream', section: 'stream_tracks' },
                              originRoute: {
                                sourceFilter: 'soundcloud',
                                soundCloudSubTab: 'stream_radio',
                                sectionAnchor: 'sc_stream_tracks',
                              },
                              ttlSec: TTL_FAST_FEED_SEC,
                            }}
                            liveItems={scStreamTracks}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {scStreamTracks.map((s) =>
                              renderSingleSongRow(s, scStreamTracks, 'sc_stream')
                            )}
                          </div>
                        </section>
                      )}

                    {scStreamPlaylists.length === 0 && scStreamTracks.length === 0 && !cloudLoading && (
                      <div style={{ fontSize: 12, color: '#8e8e99', padding: '12px 4px' }}>
                        {snap?.soundcloud_authenticated
                          ? 'Your chronological SoundCloud activity stream is empty.'
                          : 'Sign in with your personal SoundCloud account to view your chronological /me/activities/all/own feed.'}
                      </div>
                    )}
                  </>
                )}

                {/* ---------------------------------------------------------
                    8. 🔥 SOUNDCLOUD TRENDING & MIXES HUB (Genres + 20m+ DJ Mixes + Featured Sets)
                   --------------------------------------------------------- */}
                {browseHubTarget === 'soundcloud_discover' && soundCloudSubTab === 'trending' && (
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
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span
                            style={{
                              fontSize: 14,
                              fontWeight: 800,
                              color: '#fed7aa',
                              marginRight: 6,
                            }}
                          >
                            🔥 Trending & Mixes
                          </span>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <FilterTriggerButton
                            summary={`${scTrendingFilter === 'all' ? 'All' : scTrendingFilter}${scSelectedGenre ? ` • ${scSelectedGenre}` : ' • All Vibes'}`}
                            active={scTrendingFilter !== 'all' || Boolean(scSelectedGenre)}
                            accentColor="#ff5500"
                            activeBg="#2c140a"
                            activeText="#fed7aa"
                            onClick={onOpenFilters}
                          />
                          <button
                            data-right-filter-pill="true"
                            onClick={() => {
                              setCloudLoading(true);
                              fetchSoundCloudDiscover(scSelectedGenre || undefined)
                                .then((res) => {
                                  setScTrendingTracks(res.tracks);
                                  setScTrendingMixes(res.mixes);
                                  setScTrendingPlaylists(res.playlists);
                                  setScDiscoverNextHref?.(res.next_tracks_href || null);
                                })
                                .catch(() => {})
                                .finally(() => setCloudLoading(false));
                            }}
                            style={{
                              padding: '4px 9px',
                              borderRadius: 6,
                              background: '#161620',
                              border: '1px solid #2a2a38',
                              color: '#fdba74',
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

                    {(scTrendingFilter === 'all' || scTrendingFilter === 'for_you') &&
                      scMoreOfWhatYouLike.length > 0 && (
                        <section
                          data-section-anchor="sc_more_of_what_you_like"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <PinnableSectionHeader
                            title={`💡 MORE OF WHAT YOU LIKE — BASED ON YOUR HISTORY & LIKES (${scMoreOfWhatYouLike.length})`}
                            accentColor="#fdba74"
                            descriptor={{
                              shelfUid: 'soundcloud:discover:for_you',
                              cacheKey: `soundcloud:discover:for_you:${scSelectedGenre || 'all'}`,
                              provider: 'soundcloud',
                              title: 'SoundCloud • More of What You Like',
                              itemKind: 'tracks',
                              fetchSpec: {
                                kind: 'sc_discover',
                                section: 'more_of_what_you_like',
                                genre: scSelectedGenre || undefined,
                              },
                              originRoute: {
                                sourceFilter: 'soundcloud',
                                soundCloudSubTab: 'trending',
                                scSelectedGenre: scSelectedGenre || '',
                                sectionAnchor: 'sc_more_of_what_you_like',
                              },
                              ttlSec: TTL_FAST_FEED_SEC,
                            }}
                            liveItems={scMoreOfWhatYouLike}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {scMoreOfWhatYouLike.map((s) =>
                              renderSingleSongRow(s, scMoreOfWhatYouLike, 'sc_for_you')
                            )}
                          </div>
                        </section>
                      )}

                    {(scTrendingFilter === 'all' || scTrendingFilter === 'artists') &&
                      scRecommendedArtists.length > 0 && (
                        <section
                          data-section-anchor="sc_recommended_artists"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <PinnableSectionHeader
                            title={`👥 ARTISTS & CREATORS TO CHECK OUT (${scRecommendedArtists.length})`}
                            accentColor="#fdba74"
                            descriptor={{
                              shelfUid: 'soundcloud:discover:artists',
                              cacheKey: `soundcloud:discover:artists:${scSelectedGenre || 'all'}`,
                              provider: 'soundcloud',
                              title: 'SoundCloud • Recommended Creators',
                              itemKind: 'artists',
                              fetchSpec: {
                                kind: 'sc_discover',
                                section: 'recommended_artists',
                                genre: scSelectedGenre || undefined,
                              },
                              originRoute: {
                                sourceFilter: 'soundcloud',
                                soundCloudSubTab: 'trending',
                                scSelectedGenre: scSelectedGenre || '',
                                sectionAnchor: 'sc_recommended_artists',
                              },
                              ttlSec: TTL_FAST_FEED_SEC,
                            }}
                            liveItems={scRecommendedArtists}
                          />
                          <div style={tileGridStyle}>
                            {scRecommendedArtists.map(renderSoundCloudUserCard)}
                          </div>
                        </section>
                      )}

                    {(scTrendingFilter === 'all' || scTrendingFilter === 'fresh') &&
                      scFreshUploads.length > 0 && (
                        <section
                          data-section-anchor="sc_fresh_uploads"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <PinnableSectionHeader
                            title={`🆕 FRESH UPLOADS FROM CREATORS (${scFreshUploads.length})`}
                            accentColor="#fdba74"
                            descriptor={{
                              shelfUid: 'soundcloud:discover:fresh',
                              cacheKey: `soundcloud:discover:fresh:${scSelectedGenre || 'all'}`,
                              provider: 'soundcloud',
                              title: 'SoundCloud • Fresh Uploads',
                              itemKind: 'tracks',
                              fetchSpec: {
                                kind: 'sc_discover',
                                section: 'fresh_uploads',
                                genre: scSelectedGenre || undefined,
                              },
                              originRoute: {
                                sourceFilter: 'soundcloud',
                                soundCloudSubTab: 'trending',
                                scSelectedGenre: scSelectedGenre || '',
                                sectionAnchor: 'sc_fresh_uploads',
                              },
                              ttlSec: TTL_FAST_FEED_SEC,
                            }}
                            liveItems={scFreshUploads}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {scFreshUploads.map((s) =>
                              renderSingleSongRow(s, scFreshUploads, 'sc_fresh')
                            )}
                          </div>
                        </section>
                      )}

                    {(scTrendingFilter === 'all' || scTrendingFilter === 'sets') &&
                      scTrendingPlaylists.length > 0 && (
                        <section
                          data-section-anchor="sc_featured_sets"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <PinnableSectionHeader
                            title={`🎶 FEATURED SOUNDCLOUD SETS (${scTrendingPlaylists.length})`}
                            accentColor="#fdba74"
                            descriptor={{
                              shelfUid: scSelectedGenre
                                ? `soundcloud:discover:sets:${scSelectedGenre}`
                                : 'soundcloud:discover:sets',
                              cacheKey: `soundcloud:discover:sets:${scSelectedGenre || 'all'}`,
                              provider: 'soundcloud',
                              title: scSelectedGenre
                                ? `SoundCloud • Featured Sets (${scSelectedGenre})`
                                : 'SoundCloud • Featured Sets',
                              itemKind: 'playlists',
                              fetchSpec: {
                                kind: 'sc_discover',
                                section: 'featured_sets',
                                genre: scSelectedGenre || undefined,
                              },
                              originRoute: {
                                sourceFilter: 'soundcloud',
                                soundCloudSubTab: 'trending',
                                scSelectedGenre: scSelectedGenre || '',
                                sectionAnchor: 'sc_featured_sets',
                              },
                              ttlSec: TTL_FAST_FEED_SEC,
                            }}
                            liveItems={scTrendingPlaylists}
                          />
                          <div style={tileGridStyle}>
                            {scTrendingPlaylists.map(renderSoundCloudPlaylistCard)}
                          </div>
                        </section>
                      )}

                    {(scTrendingFilter === 'all' || scTrendingFilter === 'mixes') &&
                      scTrendingMixes.length > 0 && (
                        <section
                          data-section-anchor="sc_dj_mixes"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <PinnableSectionHeader
                            title={`🎧 LONG-FORM DJ MIXES & SETS (20m+) (${scTrendingMixes.length})`}
                            accentColor="#fdba74"
                            descriptor={{
                              shelfUid: scSelectedGenre
                                ? `soundcloud:discover:mixes:${scSelectedGenre}`
                                : 'soundcloud:discover:mixes',
                              cacheKey: `soundcloud:discover:mixes:${scSelectedGenre || 'all'}`,
                              provider: 'soundcloud',
                              title: scSelectedGenre
                                ? `SoundCloud • DJ Mixes (${scSelectedGenre})`
                                : 'SoundCloud • Long-Form DJ Mixes',
                              itemKind: 'tracks',
                              fetchSpec: {
                                kind: 'sc_discover',
                                section: 'dj_mixes',
                                genre: scSelectedGenre || undefined,
                              },
                              originRoute: {
                                sourceFilter: 'soundcloud',
                                soundCloudSubTab: 'trending',
                                scSelectedGenre: scSelectedGenre || '',
                                sectionAnchor: 'sc_dj_mixes',
                              },
                              ttlSec: TTL_FAST_FEED_SEC,
                            }}
                            liveItems={scTrendingMixes}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {scTrendingMixes.map((s) =>
                              renderSingleSongRow(s, scTrendingMixes, 'sc_mixes')
                            )}
                          </div>
                        </section>
                      )}

                    {(scTrendingFilter === 'all' || scTrendingFilter === 'tracks') &&
                      scTrendingTracks.length > 0 && (
                        <section
                          data-section-anchor="sc_trending_tracks"
                          style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                        >
                          <PinnableSectionHeader
                            title={`🔥 TRENDING TRACKS (${scTrendingTracks.length})`}
                            accentColor="#fdba74"
                            descriptor={{
                              shelfUid: scSelectedGenre
                                ? `soundcloud:discover:trending_tracks:${scSelectedGenre}`
                                : 'soundcloud:discover:trending_tracks',
                              cacheKey: `soundcloud:discover:trending_tracks:${scSelectedGenre || 'all'}`,
                              provider: 'soundcloud',
                              title: scSelectedGenre
                                ? `SoundCloud • Trending (${scSelectedGenre})`
                                : 'SoundCloud • Trending & Hot Tracks',
                              itemKind: 'tracks',
                              fetchSpec: {
                                kind: 'sc_discover',
                                section: 'trending_tracks',
                                genre: scSelectedGenre || undefined,
                              },
                              originRoute: {
                                sourceFilter: 'soundcloud',
                                soundCloudSubTab: 'trending',
                                scSelectedGenre: scSelectedGenre || '',
                                sectionAnchor: 'sc_trending_tracks',
                              },
                              ttlSec: TTL_FAST_FEED_SEC,
                            }}
                            liveItems={scTrendingTracks}
                          />
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {scTrendingTracks.map((s) =>
                              renderSingleSongRow(s, scTrendingTracks, 'sc_trending')
                            )}
                            {scDiscoverNextHref && (
                              <button
                                data-right-tile="true"
                                data-focusable="true"
                                data-load-more="true"
                                aria-busy={scLoadingMore}
                                onClick={loadMoreScDiscover}
                                style={{
                                  minHeight: 40,
                                  padding: '8px 16px',
                                  borderRadius: 10,
                                  background: '#2c140a',
                                  border: '1px solid #ea580c',
                                  color: '#fed7aa',
                                  fontSize: 12,
                                  fontWeight: 800,
                                  cursor: scLoadingMore ? 'default' : 'pointer',
                                  alignSelf: 'center',
                                  marginTop: 4,
                                }}
                              >
                                {scLoadingMore
                                  ? '⏳ Loading more SoundCloud tracks...'
                                  : '⬇ Load More SoundCloud Tracks'}
                              </button>
                            )}
                          </div>
                        </section>
                      )}
                  </>
                )}
    </>
  );
};
