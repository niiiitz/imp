import React from 'react';
import { AlbumRecord, defaultSimpClient, TrackMetadata } from '@imp/client';
import {
  AppleArtistProfileResponse,
  AppleArtistSummary,
  AppleCloudAlbumSummary,
  LocalArtistProfileResponse,
} from '../../drivers/AppleMusicDriver';
import {
  SoundCloudPlaylistSummary,
  SoundCloudUserProfileResponse,
  SoundCloudUserSummary,
  toggleFollowSoundCloudUser,
} from '../../drivers/SoundCloudDriver';
import { SoundCloudAttributionLink, SoundCloudLogo } from '../../components/SoundCloudLogo';
import { AppleMusicLogo } from '../../components/AppleMusicLogo';
import { ImpIcon } from '../../components/icons/ImpIcon';
import { PinnableSectionHeader } from './PinnableSectionHeader';
import {
  FypItemKind,
  FypShelfDescriptor,
  TTL_STRUCTURAL_ARTIST_SEC,
} from '../../api/servicesCacheApi';

export interface ActiveArtistProfileState {
  source: 'apple_music' | 'soundcloud' | 'local';
  idOrName: string;
  displayName: string;
  subTab: 'tracks' | 'albums' | 'singles_or_likes' | 'related_or_following';
  loading: boolean;
  loadingMore?: boolean;
  appleData?: AppleArtistProfileResponse | null;
  scData?: SoundCloudUserProfileResponse | null;
  localData?: LocalArtistProfileResponse | null;
}

export interface LibraryArtistProfilePaneProps {
  activeArtistProfile: ActiveArtistProfileState;
  setActiveArtistProfile: React.Dispatch<React.SetStateAction<ActiveArtistProfileState | null>>;
  handleWalkBack: () => void;
  setPlayingContextId: React.Dispatch<React.SetStateAction<string>>;
  setView: React.Dispatch<React.SetStateAction<'lock' | 'browser'>>;
  scFollowings: SoundCloudUserSummary[];
  setScFollowings: React.Dispatch<React.SetStateAction<SoundCloudUserSummary[]>>;
  showToast: (msg: string) => void;
  loadMoreArtistTracks: () => void;
  tileGridStyle: React.CSSProperties;
  renderSingleSongRow: (
    s: TrackMetadata,
    peerList: TrackMetadata[],
    ctxPrefix: string,
    compact?: boolean
  ) => React.ReactNode;
  renderSoundCloudPlaylistCard: (pl: SoundCloudPlaylistSummary) => React.ReactNode;
  renderCloudAlbumCard: (alb: AppleCloudAlbumSummary) => React.ReactNode;
  renderSimpAlbumCard: (alb: AlbumRecord) => React.ReactNode;
  renderSoundCloudUserCard: (user: SoundCloudUserSummary) => React.ReactNode;
  renderAppleArtistCard: (artist: AppleArtistSummary) => React.ReactNode;
}

export const LibraryArtistProfilePane: React.FC<LibraryArtistProfilePaneProps> = ({
  activeArtistProfile,
  handleWalkBack,
  setPlayingContextId,
  setView,
  scFollowings,
  setScFollowings,
  showToast,
  loadMoreArtistTracks,
  tileGridStyle,
  renderSingleSongRow,
  renderSoundCloudPlaylistCard,
  renderCloudAlbumCard,
  renderSimpAlbumCard,
  renderSoundCloudUserCard,
  renderAppleArtistCard,
}) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const [gridCols, setGridCols] = React.useState<number>(3);
  const [tracksExpanded, setTracksExpanded] = React.useState<boolean>(false);
  const [likesExpanded, setLikesExpanded] = React.useState<boolean>(false);

  React.useEffect(() => {
    setTracksExpanded(false);
    setLikesExpanded(false);
  }, [activeArtistProfile.source, activeArtistProfile.idOrName]);

  React.useEffect(() => {
    const el = containerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const updateCols = (width: number) => {
      const next = width >= 620 ? 3 : width >= 400 ? 2 : 1;
      setGridCols((prev) => (prev === next ? prev : next));
    };
    updateCols(el.clientWidth);
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        updateCols(entry.contentRect.width);
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const resolvedArtistName =
    activeArtistProfile.scData?.user?.username ||
    activeArtistProfile.appleData?.artist?.name ||
    activeArtistProfile.localData?.name ||
    activeArtistProfile.displayName;

  const buildArtistShelfDescriptor = (
    section: 'top_tracks' | 'albums' | 'singles_or_sets' | 'related_or_following',
    sectionLabel: string,
    itemKind: FypItemKind
  ): FypShelfDescriptor => {
    const shelfUid = `artist:${activeArtistProfile.source}:${activeArtistProfile.idOrName}:${section}`;
    return {
      shelfUid,
      cacheKey: shelfUid,
      provider: activeArtistProfile.source,
      title: `${resolvedArtistName} • ${sectionLabel}`,
      itemKind,
      fetchSpec: {
        kind: 'artist_section',
        artistSource: activeArtistProfile.source,
        idOrName: activeArtistProfile.idOrName,
        displayName: resolvedArtistName,
        section,
      },
      originRoute: {
        sourceFilter: activeArtistProfile.source,
        artistProfile: {
          source: activeArtistProfile.source,
          idOrName: activeArtistProfile.idOrName,
          displayName: resolvedArtistName,
        },
        sectionAnchor: section,
      },
      ttlSec: TTL_STRUCTURAL_ARTIST_SEC,
    };
  };

  const renderCompactTrackMatrixSection = (opts: {
    anchorId: 'top_tracks' | 'singles_or_sets';
    sectionLabel: string;
    heading: string;
    tracks: TrackMetadata[];
    ctxPrefix: string;
    expanded: boolean;
    onToggleExpanded: () => void;
    loadMoreControl?: React.ReactNode;
  }) => {
    const pageCap = 3 * gridCols;
    const hasOverflow = opts.tracks.length > pageCap;
    const visibleTracks = opts.expanded ? opts.tracks : opts.tracks.slice(0, pageCap);
    const rowCount = Math.min(3, Math.max(1, Math.ceil(visibleTracks.length / gridCols)));
    return (
      <section
        key={opts.anchorId}
        data-section-anchor={opts.anchorId}
        style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
      >
        <PinnableSectionHeader
          title={opts.heading}
          accentColor="#cbd5e1"
          descriptor={buildArtistShelfDescriptor(opts.anchorId, opts.sectionLabel, 'tracks')}
          liveItems={opts.tracks}
          trailing={
            hasOverflow ? (
              <button
                type="button"
                data-focusable="true"
                onClick={opts.onToggleExpanded}
                style={{
                  minHeight: 26,
                  padding: '0 10px',
                  borderRadius: 7,
                  background: '#121824',
                  border: '1px solid #263145',
                  color: '#7dd3fc',
                  fontSize: 10.5,
                  fontWeight: 800,
                  cursor: 'pointer',
                }}
              >
                {opts.expanded
                  ? 'Show Fewer ▴'
                  : `Browse More (${opts.tracks.length}) ▾`}
              </button>
            ) : undefined
          }
        />
        <div
          style={
            !opts.expanded
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
          {visibleTracks.map((s) =>
            renderSingleSongRow(s, opts.tracks, opts.ctxPrefix, true)
          )}
        </div>
        {!opts.expanded && hasOverflow && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button
              type="button"
              data-focusable="true"
              onClick={opts.onToggleExpanded}
              style={{
                minHeight: 30,
                padding: '0 12px',
                borderRadius: 8,
                background: '#10141e',
                border: '1px solid #242a3a',
                color: '#93c5fd',
                fontSize: 11,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              Browse More ({opts.tracks.length - pageCap} more) ▾
            </button>
          </div>
        )}
        {opts.loadMoreControl}
      </section>
    );
  };

  return (
    <div
      ref={containerRef}
      style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0, width: '100%' }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingBottom: 12,
          borderBottom: '1px solid #16161c',
          flexWrap: 'wrap',
          gap: 10,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            minWidth: 260,
            flex: '1 1 260px',
            overflow: 'hidden',
          }}
        >
          <button
            data-right-back-grid="true"
            onClick={handleWalkBack}
            style={{
              minHeight: 38,
              padding: '0 10px',
              borderRadius: 8,
              background: '#14141e',
              border: '1px solid #2a2a38',
              color: 'var(--imp-accent-active-text, #f5e1be)',
              fontSize: 11,
              fontWeight: 800,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            ← Back<span className="simp-gp-badge"> (B)</span>
          </button>
          <span
            className="simp-gp-badge"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              color: '#8e8e99',
              flexShrink: 0,
            }}
          >
            <ImpIcon name="gamepad-select" size={12} color="#9ca3af" />
            <span>to see Options</span>
          </span>
          {activeArtistProfile.scData?.user?.avatar_url ||
          activeArtistProfile.appleData?.artist?.art_url ||
          activeArtistProfile.localData?.art_url ? (
            <img
              src={
                activeArtistProfile.scData?.user?.avatar_url ||
                activeArtistProfile.appleData?.artist?.art_url ||
                activeArtistProfile.localData?.art_url ||
                ''
              }
              alt=""
              style={{
                width: 52,
                height: 52,
                borderRadius: '50%',
                objectFit: 'cover',
                border: '2px solid var(--imp-focus-ring, #e8b86d)',
                flexShrink: 0,
              }}
            />
          ) : (
            <div
              style={{
                width: 52,
                height: 52,
                borderRadius: '50%',
                background: '#141622',
                border: '2px solid var(--imp-focus-ring, #e8b86d)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 22,
                flexShrink: 0,
              }}
            >
              🎤
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 18,
                fontWeight: 800,
                color: '#f8fafc',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {activeArtistProfile.scData?.user?.username ||
                activeArtistProfile.appleData?.artist?.name ||
                activeArtistProfile.localData?.name ||
                activeArtistProfile.displayName}
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', display: 'flex', alignItems: 'center', gap: 6 }}>
              {activeArtistProfile.source === 'soundcloud' ? (
                <>
                  <SoundCloudLogo width={30} color="#ffffff" />
                  <span>
                    SoundCloud Creator
                    {activeArtistProfile.scData?.user
                      ? ` • ${activeArtistProfile.scData.user.followers_count.toLocaleString()} followers`
                      : ''}
                  </span>
                </>
              ) : activeArtistProfile.source === 'apple_music' ? (
                <>
                  <AppleMusicLogo size={13} />
                  <span>
                    Apple Music Artist
                    {activeArtistProfile.appleData?.artist?.genre
                      ? ` • ${activeArtistProfile.appleData.artist.genre}`
                      : ''}
                  </span>
                </>
              ) : (
                <>
                  <ImpIcon name="local" size={13} color="#34d399" />
                  <span>Local Library Artist</span>
                </>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {(() => {
            const topTracks: TrackMetadata[] =
              activeArtistProfile.scData?.tracks ||
              activeArtistProfile.appleData?.top_tracks ||
              activeArtistProfile.localData?.tracks ||
              [];
            return topTracks.length > 0 ? (
              <>
                <button
                  data-right-play-all="true"
                  onClick={() => {
                    setPlayingContextId(
                      `artist:${activeArtistProfile.source}:${activeArtistProfile.displayName}`
                    );
                    defaultSimpClient.loadQueue(
                      topTracks.map((t: TrackMetadata) => t.uri),
                      0,
                      topTracks
                    );
                    setView('lock');
                  }}
                  style={{
                    minHeight: 38,
                    padding: '0 14px',
                    borderRadius: 10,
                    background: 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
                    color: 'var(--imp-accent-active-text, #f5e1be)',
                    border: '1px solid var(--imp-focus-ring, #e8b86d)',
                    fontWeight: 800,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  ▶ Play Tracks<span className="simp-gp-badge"> (A)</span>
                </button>
                <button
                  onClick={() => {
                    setPlayingContextId(
                      `artist:${activeArtistProfile.source}:${activeArtistProfile.displayName}`
                    );
                    defaultSimpClient.setShuffle(true);
                    defaultSimpClient.loadQueue(
                      topTracks.map((t: TrackMetadata) => t.uri),
                      0,
                      topTracks
                    );
                    setView('lock');
                  }}
                  style={{
                    minHeight: 38,
                    padding: '0 14px',
                    borderRadius: 10,
                    background: '#14141c',
                    color: '#d4d4dc',
                    border: '1px solid #2e2e3a',
                    fontWeight: 700,
                    fontSize: 12,
                    cursor: 'pointer',
                  }}
                >
                  🔀 Shuffle<span className="simp-gp-badge"> (X)</span>
                </button>
              </>
            ) : null;
          })()}
          {activeArtistProfile.source === 'soundcloud' && (
            <SoundCloudAttributionLink
              permalinkUrl={activeArtistProfile.scData?.user?.permalink_url}
              kind="user"
              id={
                activeArtistProfile.scData?.user?.id ||
                activeArtistProfile.idOrName ||
                activeArtistProfile.displayName
              }
              label="SoundCloud"
              width={30}
              style={{ minHeight: 38, padding: '0 12px', borderRadius: 10 }}
            />
          )}
          {activeArtistProfile.source === 'apple_music' && (
            <span
              title="Apple Music"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                minHeight: 38,
                padding: '0 12px',
                borderRadius: 10,
                background: '#1a0c12',
                color: '#fda4af',
                border: '1px solid #4c1d2e',
                fontSize: 11,
                fontWeight: 800,
                lineHeight: 1,
                flexShrink: 0,
                cursor: 'default',
                boxSizing: 'border-box',
              }}
            >
              <AppleMusicLogo size={14} />
              <span>Apple Music</span>
            </span>
          )}
          {activeArtistProfile.source === 'soundcloud' && activeArtistProfile.scData?.user && (
            <button
              onClick={async () => {
                const u = activeArtistProfile.scData?.user;
                if (!u) return;
                const isFollowing = scFollowings.some((f) => f.id === u.id);
                await toggleFollowSoundCloudUser(u.id, !isFollowing).catch(() => {});
                setScFollowings((prev) =>
                  isFollowing ? prev.filter((f) => f.id !== u.id) : [u, ...prev]
                );
                showToast(isFollowing ? `Unfollowed ${u.username}` : `Following ${u.username}`);
              }}
              style={{
                minHeight: 38,
                padding: '0 14px',
                borderRadius: 10,
                background: '#221108',
                border: '1px solid #f97316',
                color: '#fdba74',
                fontWeight: 800,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              {scFollowings.some((f) => f.id === activeArtistProfile.scData?.user?.id)
                ? '✓ Following'
                : '+ Follow Artist'}
            </button>
          )}
        </div>
      </div>

      {/* SoundCloud Gated (MONETIZE / Go+) Content Notice Banner */}
      {activeArtistProfile.source === 'soundcloud' &&
        ((activeArtistProfile.scData?.gated_track_count ?? 0) > 0 ||
          (activeArtistProfile.scData?.gated_playlist_count ?? 0) > 0) &&
        (() => {
          const gatedTracks = activeArtistProfile.scData?.gated_track_count ?? 0;
          const gatedSets = activeArtistProfile.scData?.gated_playlist_count ?? 0;
          const permalinkUrl =
            activeArtistProfile.scData?.user?.permalink_url ||
            `https://soundcloud.com/${encodeURIComponent(
              (
                activeArtistProfile.scData?.user?.username ||
                activeArtistProfile.displayName.replace(/^@/, '')
              ).trim()
            )}`;
          const isSteamGameMode =
            typeof window !== 'undefined' &&
            (window.parent !== window || window.navigator.userAgent.includes('Valve Steam'));
          return (
            <div
              style={{
                padding: '10px 14px',
                borderRadius: 12,
                background: 'linear-gradient(90deg, #221006 0%, #140c08 100%)',
                border: '1px solid #ea580c',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 800, color: '#fed7aa', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <SoundCloudLogo width={24} color="#fed7aa" />
                  <span>
                    More content from {activeArtistProfile.displayName} is available exclusively on
                    SoundCloud
                  </span>
                </div>
                <div style={{ fontSize: 11, color: '#fdba74' }}>
                  {gatedTracks > 0
                    ? `${gatedTracks} Go+ / Monetized track${gatedTracks === 1 ? '' : 's'}`
                    : ''}
                  {gatedTracks > 0 && gatedSets > 0 ? ' • ' : ''}
                  {gatedSets > 0
                    ? `${gatedSets} gated album/set${gatedSets === 1 ? '' : 's'}`
                    : ''}{' '}
                  require SoundCloud web/app playback ({permalinkUrl})
                </div>
              </div>
              {!isSteamGameMode && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                  <SoundCloudAttributionLink
                    permalinkUrl={permalinkUrl}
                    kind="user"
                    id={
                      activeArtistProfile.scData?.user?.id ||
                      activeArtistProfile.idOrName ||
                      activeArtistProfile.displayName
                    }
                    label="Open on SoundCloud ↗"
                    width={24}
                    style={{
                      minHeight: 32,
                      padding: '0 10px',
                      borderRadius: 8,
                      background: '#3b1909',
                      border: '1px solid #f97316',
                    }}
                  />
                  <button
                    onClick={() => {
                      navigator.clipboard?.writeText(permalinkUrl).catch(() => {});
                      showToast(`Copied ${permalinkUrl}`);
                    }}
                    style={{
                      minHeight: 32,
                      padding: '0 10px',
                      borderRadius: 8,
                      background: '#181210',
                      border: '1px solid #432818',
                      color: '#fed7aa',
                      fontSize: 11,
                      fontWeight: 700,
                      cursor: 'pointer',
                    }}
                  >
                    📋 Copy URL
                  </button>
                </div>
              )}
            </div>
          );
        })()}

      {activeArtistProfile.loading ? (
        <div style={{ padding: 24, color: '#94a3b8', fontSize: 13 }}>
          ⏳ Loading artist catalog...
        </div>
      ) : (
        (() => {
          const tracks: TrackMetadata[] =
            activeArtistProfile.scData?.tracks ||
            activeArtistProfile.appleData?.top_tracks ||
            activeArtistProfile.localData?.tracks ||
            [];
          const scSets = activeArtistProfile.scData?.playlists || [];
          const appleAlbums = activeArtistProfile.appleData?.albums || [];
          const localAlbums = activeArtistProfile.localData?.albums || [];
          const albumsCount =
            activeArtistProfile.source === 'soundcloud'
              ? scSets.length
              : activeArtistProfile.source === 'apple_music'
                ? appleAlbums.length
                : localAlbums.length;
          const scLiked = activeArtistProfile.scData?.liked_tracks || [];
          const appleSingles = activeArtistProfile.appleData?.singles || [];
          const singlesOrLikesCount =
            activeArtistProfile.source === 'soundcloud'
              ? scLiked.length
              : activeArtistProfile.source === 'apple_music'
                ? appleSingles.length
                : 0;
          const scFollowingsList = activeArtistProfile.scData?.followings || [];
          const relatedArtistsList = activeArtistProfile.appleData?.related_artists || [];
          const relatedCount =
            activeArtistProfile.source === 'soundcloud'
              ? scFollowingsList.length
              : activeArtistProfile.source === 'apple_music'
                ? relatedArtistsList.length
                : 0;

          if (
            tracks.length === 0 &&
            albumsCount === 0 &&
            singlesOrLikesCount === 0 &&
            relatedCount === 0
          ) {
            return (
              <div style={{ padding: 16, color: '#8e8e99', fontSize: 12 }}>
                No streamable catalog items found for this artist.
              </div>
            );
          }

          const pageCap = 3 * gridCols;
          const canShowSoundCloudLoadMore =
            activeArtistProfile.source === 'soundcloud' &&
            Boolean(activeArtistProfile.scData?.next_tracks_href) &&
            (tracksExpanded || tracks.length <= pageCap);

          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 22, minWidth: 0 }}>
              {/* 1. Top Tracks (3 x N Compact Multi-Column Matrix + Browse More) */}
              {tracks.length > 0 &&
                renderCompactTrackMatrixSection({
                  anchorId: 'top_tracks',
                  sectionLabel:
                    activeArtistProfile.source === 'apple_music' ? 'Top Tracks' : 'Tracks',
                  heading:
                    activeArtistProfile.source === 'apple_music'
                      ? `Top Tracks (${tracks.length})`
                      : `Tracks (${tracks.length}${
                          activeArtistProfile.scData?.next_tracks_href ? '+' : ''
                        })`,
                  tracks,
                  ctxPrefix: `artist:${activeArtistProfile.source}:${activeArtistProfile.displayName}`,
                  expanded: tracksExpanded,
                  onToggleExpanded: () => setTracksExpanded((v) => !v),
                  loadMoreControl: canShowSoundCloudLoadMore ? (
                    <div style={{ display: 'flex', justifyContent: 'center', marginTop: 4 }}>
                      <button
                        data-focusable="true"
                        data-load-more="true"
                        aria-busy={activeArtistProfile.loadingMore}
                        onClick={loadMoreArtistTracks}
                        style={{
                          minHeight: 38,
                          padding: '0 20px',
                          borderRadius: 10,
                          background: '#1c1008',
                          border: '1px solid #ea580c',
                          color: '#fdba74',
                          fontSize: 12,
                          fontWeight: 800,
                          cursor: activeArtistProfile.loadingMore ? 'wait' : 'pointer',
                        }}
                      >
                        {activeArtistProfile.loadingMore
                          ? '⏳ Loading More Tracks...'
                          : '⬇ Load More Artist Tracks'}
                      </button>
                    </div>
                  ) : undefined,
                })}

              {/* 2. Albums / Sets & Albums */}
              {albumsCount > 0 && (
                <section
                  data-section-anchor="albums"
                  style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                >
                  <PinnableSectionHeader
                    title={
                      activeArtistProfile.source === 'soundcloud'
                        ? `SETS & ALBUMS (${albumsCount})`
                        : `ALBUMS (${albumsCount})`
                    }
                    accentColor="#cbd5e1"
                    descriptor={buildArtistShelfDescriptor(
                      'albums',
                      activeArtistProfile.source === 'soundcloud' ? 'Sets & Albums' : 'Albums',
                      activeArtistProfile.source === 'soundcloud' ? 'playlists' : 'albums'
                    )}
                    liveItems={
                      activeArtistProfile.source === 'soundcloud'
                        ? scSets
                        : activeArtistProfile.source === 'apple_music'
                          ? appleAlbums
                          : localAlbums
                    }
                  />
                  <div style={tileGridStyle}>
                    {activeArtistProfile.source === 'soundcloud'
                      ? scSets.map((pl) => renderSoundCloudPlaylistCard(pl))
                      : activeArtistProfile.source === 'apple_music'
                        ? appleAlbums.map(renderCloudAlbumCard)
                        : localAlbums.map(renderSimpAlbumCard)}
                  </div>
                </section>
              )}

              {/* 3. Singles & EPs / SoundCloud Likes */}
              {singlesOrLikesCount > 0 &&
                (activeArtistProfile.source === 'soundcloud' ? (
                  renderCompactTrackMatrixSection({
                    anchorId: 'singles_or_sets',
                    sectionLabel: 'Likes',
                    heading: `Likes (${scLiked.length})`,
                    tracks: scLiked,
                    ctxPrefix: `artist:sc:likes:${activeArtistProfile.displayName}`,
                    expanded: likesExpanded,
                    onToggleExpanded: () => setLikesExpanded((v) => !v),
                  })
                ) : (
                  <section
                    data-section-anchor="singles_or_sets"
                    style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                  >
                    <PinnableSectionHeader
                      title={`SINGLES & EPS (${appleSingles.length})`}
                      accentColor="#cbd5e1"
                      descriptor={buildArtistShelfDescriptor(
                        'singles_or_sets',
                        'Singles & EPs',
                        'albums'
                      )}
                      liveItems={appleSingles}
                    />
                    <div style={tileGridStyle}>{appleSingles.map(renderCloudAlbumCard)}</div>
                  </section>
                ))}

              {/* 4. Related Artists / Following */}
              {relatedCount > 0 && (
                <section
                  data-section-anchor="related_or_following"
                  style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                >
                  <PinnableSectionHeader
                    title={
                      activeArtistProfile.source === 'soundcloud'
                        ? `FOLLOWING (${scFollowingsList.length})`
                        : `RELATED ARTISTS (${relatedArtistsList.length})`
                    }
                    accentColor="#cbd5e1"
                    descriptor={buildArtistShelfDescriptor(
                      'related_or_following',
                      activeArtistProfile.source === 'soundcloud'
                        ? 'Following'
                        : 'Related Artists',
                      'artists'
                    )}
                    liveItems={
                      activeArtistProfile.source === 'soundcloud'
                        ? scFollowingsList
                        : relatedArtistsList
                    }
                  />
                  <div style={tileGridStyle}>
                    {activeArtistProfile.source === 'soundcloud'
                      ? scFollowingsList.map((u) => renderSoundCloudUserCard(u))
                      : relatedArtistsList.map(renderAppleArtistCard)}
                  </div>
                </section>
              )}
            </div>
          );
        })()
      )}
    </div>
  );
};

