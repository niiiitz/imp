import React from 'react';
import { defaultSimpClient, SimpStateSnapshot, TrackMetadata } from '@simp/client';
import { AppleMusicLogo } from '../../../components/AppleMusicLogo';
import { SoundCloudLogo } from '../../../components/SoundCloudLogo';
import { ImpIcon } from '../../../components/icons/ImpIcon';
import { LibraryContextTarget } from '../../LibraryBrowserView';
import { extractAudioFormat, getTrackLyricsBadge } from '../libraryHelpers';
import { ContentRatingBadge } from '../ContentRatingBadge';

export interface SingleSongRowProps {
  song: TrackMetadata;
  peerList: TrackMetadata[];
  ctxPrefix: string;
  compact?: boolean;
  track: TrackMetadata | null | undefined;
  snap: SimpStateSnapshot | null;
  favoritedUris: string[];
  scLikedTracks: TrackMetadata[];
  openLocalVideoFile: (
    videoTrack: TrackMetadata,
    peerTracks?: TrackMetadata[],
    ctxId?: string
  ) => void;
  showToast: (msg: string) => void;
  setPlayingContextId: (ctxId: string) => void;
  setView: (view: 'lock' | 'browser') => void;
  openLibraryContextMenu: (target: LibraryContextTarget) => void;
  openArtistProfile: (params: {
    source: 'apple_music' | 'soundcloud' | 'local';
    idOrName: string;
    displayName: string;
  }) => void;
  handleFavoriteTrack?: (track: TrackMetadata) => Promise<void>;
  handleAddTracksToPlaylist: (
    uris: string[],
    label: string,
    trackMetadata?: TrackMetadata[]
  ) => Promise<void>;
  handleStartSoundCloudTrackRadio: (seedTrack: TrackMetadata) => void;
  handleAddAppleToCloudLibrary?: (
    idOrUri: string,
    kind?: 'songs' | 'albums' | 'playlists',
    label?: string
  ) => Promise<void>;
  selectCloudAlbum: (params: {
    albumId?: string | null;
    songUri?: string | null;
    fallbackTitle?: string;
  }) => void;
  selectLocalAlbum?: (
    albumId: string,
    albumTitle: string,
    artistName: string,
    artUrl?: string | null
  ) => void;
}

export const SingleSongRow: React.FC<SingleSongRowProps> = ({
  song: s,
  peerList,
  ctxPrefix,
  compact = false,
  track,
  snap,
  favoritedUris,
  scLikedTracks,
  openLocalVideoFile,
  showToast,
  setPlayingContextId,
  setView,
  openLibraryContextMenu,
  openArtistProfile,
  handleFavoriteTrack,
  handleAddTracksToPlaylist,
  handleStartSoundCloudTrackRadio,
  selectCloudAlbum,
  selectLocalAlbum,
}) => {
  const isLongMix = s.source === 'soundcloud' && s.duration_ms >= 20 * 60 * 1000;
  const isScPreview =
    s.source === 'soundcloud' &&
    Boolean(s.album?.includes('• Preview') || s.title.toLowerCase().includes('[preview]'));
  const isFavorited =
    favoritedUris.includes(s.uri) ||
    ctxPrefix === 'sc_likes' ||
    scLikedTracks.some((lt) => lt.uri === s.uri);
  const durMin = Math.floor(s.duration_ms / 60000);
  const durSec = Math.floor((s.duration_ms / 1000) % 60);
  const primaryArtist = s.artists?.[0]?.trim();
  return (
    <div
      data-single-song-row="true"
      onContextMenu={(e) => {
        e.preventDefault();
        openLibraryContextMenu({
          type: 'track',
          track: s,
          peerList,
          isViewingLocalPlaylist: false,
        });
      }}
      style={{
        minHeight: compact ? 46 : 54,
        padding: compact ? '5px 8px' : '6px 10px',
        borderRadius: compact ? 10 : 12,
        background: track?.uri === s.uri ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))' : 'var(--imp-surface-card, #1a1d24)',
        border: track?.uri === s.uri ? '1px solid var(--imp-focus-ring, #e8b86d)' : '1px solid #181822',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: compact ? 6 : 8,
        minWidth: 0,
        boxSizing: 'border-box',
      }}
    >
      <button
        data-single-song-play="true"
        data-tile-key={`song:${ctxPrefix}:${s.uri}`}
        onClick={() => {
          if (s.source === 'local_video' || s.uri.startsWith('video://local/')) {
            openLocalVideoFile(s, peerList, `${ctxPrefix}:${s.uri}`);
            return;
          }
          if (isScPreview) {
            showToast('30s Preview — Sign in to SoundCloud in Accounts for full track playback');
          }
          const rowCtxKey = `${ctxPrefix}:${s.uri}`;
          const idx = Math.max(0, peerList.findIndex((tr) => tr.uri === s.uri));
          const queueAlreadyMatches =
            snap?.queue &&
            snap.queue.length === peerList.length &&
            snap.queue_index === idx &&
            snap.queue[idx]?.uri === s.uri;
          setPlayingContextId(rowCtxKey);
          if (track?.uri === s.uri && queueAlreadyMatches) {
            if (!snap?.is_playing) {
              defaultSimpClient.play();
            }
            setView('lock');
          } else {
            defaultSimpClient.loadQueue(
              peerList.map((tr) => tr.uri),
              idx,
              peerList
            );
            setView('lock');
          }
        }}
        style={{
          flex: 1,
          minWidth: 0,
          background: 'transparent',
          border: 'none',
          color: '#d4d4dc',
          textAlign: 'left',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: 0,
        }}
      >
        {s.art_url ? (
          <img
            src={s.art_url}
            alt=""
            loading="lazy"
            style={{
              width: compact ? 34 : 40,
              height: compact ? 34 : 40,
              borderRadius: compact ? 6 : 8,
              objectFit: 'cover',
              border: '1px solid #262632',
              flexShrink: 0,
            }}
          />
        ) : (
          <div
            style={{
              width: compact ? 34 : 40,
              height: compact ? 34 : 40,
              borderRadius: compact ? 6 : 8,
              background: '#161622',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: compact ? 13 : 15,
              flexShrink: 0,
            }}
          >
            {s.source === 'soundcloud' ? (
              <SoundCloudLogo width={compact ? 24 : 30} color="#fdba74" />
            ) : s.source === 'apple_music' ? (
              <AppleMusicLogo size={compact ? 14 : 16} />
            ) : (
              <ImpIcon name="music" size={compact ? 14 : 16} color="#94a3b8" />
            )}
          </div>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: compact ? 12 : 13,
              fontWeight: 700,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>▶ {s.title}</span>
            <ContentRatingBadge rating={s.content_rating} />
            {(() => {
              const lyrBadge = getTrackLyricsBadge(s.uri);
              if (!lyrBadge) return null;
              const isSynced = lyrBadge === 'LRC';
              return (
                <span
                  title={
                    isSynced
                      ? 'Synced timed lyrics available (Karaoke Ready)'
                      : 'Retrieved plain lyrics available'
                  }
                  style={{
                    fontSize: 9,
                    fontFamily: 'monospace',
                    fontWeight: 800,
                    padding: '1px 5px',
                    borderRadius: 4,
                    background: isSynced
                      ? 'rgba(16, 185, 129, 0.16)'
                      : 'rgba(56, 189, 248, 0.14)',
                    border: isSynced
                      ? '1px solid rgba(52, 211, 153, 0.5)'
                      : '1px solid rgba(56, 189, 248, 0.45)',
                    color: isSynced ? '#6ee7b7' : '#7dd3fc',
                    flexShrink: 0,
                  }}
                >
                  {lyrBadge}
                </span>
              );
            })()}
            {isScPreview && (
              <span
                style={{
                  fontSize: 9,
                  fontFamily: 'monospace',
                  fontWeight: 800,
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: '#3c2208',
                  border: '1px solid #d97706',
                  color: '#fcd34d',
                  flexShrink: 0,
                }}
              >
                30s PREVIEW
              </span>
            )}
            {(s.source === 'local' || s.source === 'steam_ost' || s.source === 'removable') &&
              !s.art_url && (
                <span
                  title="Missing cover artwork"
                  style={{
                    fontSize: 9,
                    fontFamily: 'monospace',
                    fontWeight: 800,
                    padding: '1px 5px',
                    borderRadius: 4,
                    background: 'rgba(250, 204, 21, 0.1)',
                    border: '1px solid rgba(250, 204, 21, 0.4)',
                    color: '#facc15',
                    flexShrink: 0,
                  }}
                >
                  NO ART
                </span>
              )}
          </div>
          <div
            style={{
              fontSize: compact ? 10.5 : 11,
              color: '#8e8e99',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {(!compact || !s.album) &&
              (primaryArtist &&
              s.source !== 'local_video' &&
              s.source !== 'ia_video' &&
              s.source !== 'dvd' ? (
                <span
                  role="link"
                  tabIndex={-1}
                  title={`Open Artist Profile for ${primaryArtist}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openArtistProfile({
                      source:
                        s.source === 'apple_music'
                          ? 'apple_music'
                          : s.source === 'soundcloud'
                          ? 'soundcloud'
                          : 'local',
                      idOrName: `name:${primaryArtist}`,
                      displayName: primaryArtist,
                    });
                  }}
                  style={{
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    textDecorationColor: 'rgba(148, 163, 184, 0.35)',
                  }}
                >
                  {s.artists.join(', ')}
                </span>
              ) : (
                <span>{s.artists.join(', ')}</span>
              ))}
            {s.album ? (
              s.source === 'apple_music' ? (
                <>
                  {!compact && ' • '}
                  <span
                    role="link"
                    tabIndex={-1}
                    title={`Open Album "${s.album}"`}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectCloudAlbum({
                        songUri: s.uri,
                        fallbackTitle: s.album || s.title,
                      });
                    }}
                    style={{
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      textDecorationColor: 'rgba(148, 163, 184, 0.35)',
                    }}
                  >
                    {s.album}
                  </span>
                </>
              ) : s.album_id &&
                selectLocalAlbum &&
                s.source !== 'soundcloud' &&
                s.source !== 'internet_archive' &&
                s.source !== 'ia_video' ? (
                <>
                  {!compact && ' • '}
                  <span
                    role="link"
                    tabIndex={-1}
                    title={`Open Local Album "${s.album}"`}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectLocalAlbum(
                        s.album_id!,
                        s.album,
                        primaryArtist || 'Unknown Artist',
                        s.art_url
                      );
                    }}
                    style={{
                      cursor: 'pointer',
                      textDecoration: 'underline',
                      textDecorationColor: 'rgba(110, 231, 183, 0.4)',
                    }}
                  >
                    {s.album}
                  </span>
                </>
              ) : (
                `${!compact ? ' • ' : ''}${s.album}`
              )
            ) : (
              ''
            )}
            {(() => {
              const fmt = extractAudioFormat(s.uri);
              return fmt ? ` • ${fmt}` : '';
            })()}
            {!compact && s.release_year ? ` • ${s.release_year}` : ''}
            {!compact && s.genre ? ` • ${s.genre}` : ''}
            {!compact && s.parent_folder && s.parent_folder !== '/'
              ? ` • 📂 ${s.parent_folder}`
              : ''}
          </div>
        </div>
      </button>
      <div style={{ display: 'flex', alignItems: 'center', gap: compact ? 4 : 5, flexShrink: 0 }}>
        {s.duration_ms > 0 && (
          <span
            style={{
              fontSize: 10,
              fontFamily: 'monospace',
              padding: '2px 6px',
              borderRadius: 6,
              background: isLongMix ? '#2c140a' : '#12121a',
              border: isLongMix ? '1px solid #ea580c' : '1px solid #222230',
              color: isLongMix ? '#fdba74' : '#8e8e99',
            }}
          >
            {isLongMix ? `${durMin}m` : `${durMin}:${String(durSec).padStart(2, '0')}`}
          </span>
        )}
        {!compact &&
          handleFavoriteTrack &&
          s.source !== 'local_video' &&
          s.source !== 'ia_video' &&
          s.source !== 'dvd' && (
            <button
              data-row-aux="true"
              onClick={() => handleFavoriteTrack(s)}
              title={isFavorited ? 'Remove from Favorites' : 'Favorite this track'}
              style={{
                padding: '5px 8px',
                borderRadius: 8,
                background: isFavorited ? '#28111b' : '#14141e',
                border: isFavorited ? '1px solid #fa243c' : '1px solid #282838',
                color: isFavorited ? '#fda4af' : '#9ca3af',
                fontSize: 11,
                cursor: 'pointer',
              }}
            >
              {isFavorited ? '♥' : '♡'}
            </button>
          )}
        <button
          data-row-aux="true"
          data-track-select="true"
          onClick={() => handleAddTracksToPlaylist([s.uri], `"${s.title}"`, [s])}
          title="Add track to active Imp Hybrid Playlist"
          style={{
            padding: compact ? '4px 8px' : '5px 9px',
            borderRadius: 8,
            background: 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
            border: '1px solid var(--imp-focus-ring, #e8b86d)',
            color: 'var(--imp-accent-active-text, #f5e1be)',
            fontSize: compact ? 11 : 12,
            fontWeight: 800,
            cursor: 'pointer',
          }}
        >
          +
        </button>
        {!compact && s.source === 'soundcloud' && (
          <button
            data-row-aux="true"
            onClick={() => handleStartSoundCloudTrackRadio(s)}
            title="Start SoundCloud Track Radio from this track"
            style={{
              padding: '5px 8px',
              borderRadius: 8,
              background: '#2c140a',
              border: '1px solid #ea580c',
              color: '#fdba74',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
            }}
          >
            <ImpIcon name="radio" size={12} color="#fdba74" />
          </button>
        )}
      </div>
    </div>
  );
};
