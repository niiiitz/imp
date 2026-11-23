import React, { useEffect, useState } from 'react';
import { TrackMetadata } from '@simp/client';
import {
  matchTrackOnSoundCloud,
  openSoundCloudPermalink,
  type SoundCloudTrackMatch,
  toggleFollowSoundCloudUser,
} from '../../drivers/SoundCloudDriver';
import { ImpIcon } from '../../components/icons/ImpIcon';
import { type ImpSourceTheme } from '../../theme/sourceTheme';

export interface PlayerSelectQueueItem {
  key: string;
  index: number;
  title: string;
  subtitle: string;
  durationMs: number;
  badgeLabel: string;
  isCurrent: boolean;
  onSelect: () => void;
}

export interface PlayerTrackContextModalProps {
  playerActionsOpen: boolean;
  setPlayerActionsOpen: React.Dispatch<React.SetStateAction<boolean>>;
  track: TrackMetadata | null | undefined;
  handleOpenCurrentCollection: () => void;
  activeRightColItems: PlayerSelectQueueItem[];
  isSoundCloudTrack: boolean;
  isVideoTrack: boolean;
  handleFavoriteTrack?: (track: TrackMetadata) => Promise<void>;
  showToast?: (msg: string) => void;
  isCurrentTrackFavorited: boolean;
  handleAddAppleToCloudLibrary?: (
    idOrUri: string,
    kind?: 'songs' | 'albums' | 'playlists',
    label?: string
  ) => Promise<void>;
  handleAddTracksToPlaylist?: (
    uris: string[],
    label: string,
    trackMetadata?: TrackMetadata[]
  ) => Promise<void>;
  primaryArtist: string;
  handleStartSoundCloudTrackRadio?: (seedTrack: TrackMetadata) => void;
  handleMoreByArtist?: (
    artistName: string,
    preferredSource?: string,
    artistId?: string
  ) => void;
  scTrackUserId: string | null;
  setVideoTheatreExpanded: React.Dispatch<React.SetStateAction<boolean>>;
  scCreatorFollowed: boolean;
  setScCreatorFollowed: React.Dispatch<React.SetStateAction<boolean>>;
  playerTheme: ImpSourceTheme;
  rightColMode: 'queue' | 'chapters';
  chapterModalItems: PlayerSelectQueueItem[];
  currentQueueIdx: number;
  queueModalItems: PlayerSelectQueueItem[];
  setRightColMode: React.Dispatch<React.SetStateAction<'queue' | 'chapters'>>;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00';
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

const rowBtnStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 38,
  padding: '6px 11px',
  borderRadius: 6,
  background: 'var(--imp-surface-card, #1a1d24)',
  border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
  color: 'var(--imp-text-primary, #eef0f4)',
  textAlign: 'left',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 10,
  cursor: 'pointer',
  fontSize: 12.5,
  fontWeight: 700,
};

export const PlayerTrackContextModal: React.FC<PlayerTrackContextModalProps> = ({
  playerActionsOpen,
  setPlayerActionsOpen,
  track,
  handleOpenCurrentCollection,
  activeRightColItems,
  isSoundCloudTrack,
  isVideoTrack,
  handleFavoriteTrack,
  showToast,
  isCurrentTrackFavorited,
  handleAddAppleToCloudLibrary,
  handleAddTracksToPlaylist,
  primaryArtist,
  handleStartSoundCloudTrackRadio,
  handleMoreByArtist,
  scTrackUserId,
  setVideoTheatreExpanded,
  scCreatorFollowed,
  setScCreatorFollowed,
  playerTheme,
  rightColMode,
  chapterModalItems,
  currentQueueIdx,
  queueModalItems,
  setRightColMode,
}) => {
  const [activeTab, setActiveTab] = useState<'track' | 'queue'>('track');
  const [scCrossMatch, setScCrossMatch] = useState<SoundCloudTrackMatch | null>(null);
  const [scCrossMatchLoading, setScCrossMatchLoading] = useState(false);
  const [scCrossMatchCheckedUri, setScCrossMatchCheckedUri] = useState<string | null>(null);

  useEffect(() => {
    setScCrossMatch(null);
    setScCrossMatchLoading(false);
    setScCrossMatchCheckedUri(null);
  }, [track?.uri]);

  useEffect(() => {
    if (!playerActionsOpen || activeTab !== 'queue') return;
    const t = window.setTimeout(() => {
      const cur = document.querySelector<HTMLElement>(
        '[data-player-actions-modal="true"] [data-queue-current="true"]'
      );
      cur?.scrollIntoView({ block: 'center', inline: 'nearest' });
    }, 25);
    return () => window.clearTimeout(t);
  }, [playerActionsOpen, activeTab, rightColMode]);

  if (!playerActionsOpen) return null;

  const queueTabLabel =
    rightColMode === 'chapters' && chapterModalItems.length > 0
      ? `Chapters (${activeRightColItems.length})`
      : isVideoTrack
        ? `Episodes (${activeRightColItems.length})`
        : `Queue (${activeRightColItems.length})`;

  return (
    <div
      onClick={() => setPlayerActionsOpen(false)}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.70)',
        zIndex: 55,
      }}
    >
      <div
        data-modal-root="true"
        data-player-actions-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: 58,
          left: 16,
          width: 'min(480px, calc(100vw / var(--imp-ui-scale, 1) - 32px))',
          maxHeight: 'calc(100vh / var(--imp-ui-scale, 1) - 72px)',
          overflow: 'hidden',
          background: 'var(--imp-surface-panel, #161920)',
          border: '1px solid var(--imp-border-strong, rgba(255, 255, 255, 0.16))',
          borderRadius: 10,
          padding: 14,
          boxSizing: 'border-box',
          boxShadow: '0 20px 52px rgba(0, 0, 0, 0.78)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
            paddingBottom: 8,
            borderBottom: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
            flexShrink: 0,
          }}
        >
          <div style={{ minWidth: 0, flex: 1 }}>
            <div
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: 'var(--imp-accent-active-text, #f5e1be)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {track ? track.title : 'No Track Loaded'}
            </div>
            {track && (
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--imp-text-secondary, #8b92a1)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {primaryArtist || track.album || track.source}
              </div>
            )}
          </div>
          <button
            type="button"
            data-player-actions-close="true"
            onClick={() => setPlayerActionsOpen(false)}
            style={{
              minHeight: 30,
              padding: '0 10px',
              borderRadius: 6,
              background: 'var(--imp-surface-card, #1a1d24)',
              border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
              color: 'var(--imp-text-primary, #eef0f4)',
              fontFamily: 'monospace',
              fontSize: 11.5,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            ✕<span className="simp-gp-badge"> B</span>
          </button>
        </div>

        {/* Focused Object Tabs: Track | Queue */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 6,
            flexShrink: 0,
          }}
        >
          <button
            type="button"
            data-select-active={activeTab === 'track' ? 'true' : undefined}
            onClick={() => setActiveTab('track')}
            style={{
              minHeight: 32,
              borderRadius: 6,
              background:
                activeTab === 'track'
                  ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))'
                  : 'var(--imp-surface-card, #1a1d24)',
              border:
                activeTab === 'track'
                  ? '1px solid var(--imp-focus-ring, #e8b86d)'
                  : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
              color:
                activeTab === 'track'
                  ? 'var(--imp-accent-active-text, #f5e1be)'
                  : 'var(--imp-text-secondary, #8b92a1)',
              fontSize: 12,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            Track
          </button>
          <button
            type="button"
            data-select-active={activeTab === 'queue' ? 'true' : undefined}
            onClick={() => setActiveTab('queue')}
            style={{
              minHeight: 32,
              borderRadius: 6,
              background:
                activeTab === 'queue'
                  ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))'
                  : 'var(--imp-surface-card, #1a1d24)',
              border:
                activeTab === 'queue'
                  ? '1px solid var(--imp-focus-ring, #e8b86d)'
                  : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
              color:
                activeTab === 'queue'
                  ? 'var(--imp-accent-active-text, #f5e1be)'
                  : 'var(--imp-text-secondary, #8b92a1)',
              fontSize: 12,
              fontWeight: 800,
              cursor: 'pointer',
            }}
          >
            {queueTabLabel}
          </button>
        </div>

        {/* Body */}
        {activeTab === 'track' ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              overflowY: 'auto',
              paddingRight: 2,
            }}
          >
            {track ? (
              <>
                <button
                  type="button"
                  data-default-focus="true"
                  onClick={() => {
                    if (handleFavoriteTrack) {
                      handleFavoriteTrack(track);
                    } else {
                      showToast?.('Favorites handler unavailable');
                    }
                  }}
                  style={{
                    ...rowBtnStyle,
                    background: isCurrentTrackFavorited
                      ? 'rgba(244, 63, 94, 0.14)'
                      : rowBtnStyle.background,
                    border: isCurrentTrackFavorited
                      ? '1px solid rgba(244, 63, 94, 0.55)'
                      : rowBtnStyle.border,
                    color: isCurrentTrackFavorited ? '#fda4af' : rowBtnStyle.color,
                  }}
                >
                  <span>{isCurrentTrackFavorited ? 'Favorited' : 'Favorite'}</span>
                  <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
                    {isCurrentTrackFavorited ? 'On' : 'Off'}
                  </span>
                </button>

                {handleAddTracksToPlaylist && (
                  <button
                    type="button"
                    onClick={() => {
                      setPlayerActionsOpen(false);
                      handleAddTracksToPlaylist([track.uri], `"${track.title}"`, [track]);
                    }}
                    style={rowBtnStyle}
                  >
                    <span>Add to Playlist...</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--imp-text-secondary, #8b92a1)' }}>
                      +
                    </span>
                  </button>
                )}

                {track.source === 'apple_music' && handleAddAppleToCloudLibrary && (
                  <button
                    type="button"
                    onClick={() => {
                      setPlayerActionsOpen(false);
                      handleAddAppleToCloudLibrary(track.uri, 'songs', track.title);
                    }}
                    style={rowBtnStyle}
                  >
                    <span>Add to Apple Library</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#fda4af' }}>
                      +
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={handleOpenCurrentCollection}
                  style={rowBtnStyle}
                >
                  <span>Go to Album</span>
                  <span style={{ fontFamily: 'monospace', fontSize: 11, color: 'var(--imp-text-secondary, #8b92a1)' }}>
                    →
                  </span>
                </button>

                {primaryArtist && handleMoreByArtist && (
                  <button
                    type="button"
                    onClick={() => {
                      setPlayerActionsOpen(false);
                      setVideoTheatreExpanded(false);
                      handleMoreByArtist(
                        primaryArtist,
                        track.source,
                        scTrackUserId || undefined
                      );
                    }}
                    style={rowBtnStyle}
                  >
                    <span>Go to Artist</span>
                    <span
                      style={{
                        fontFamily: 'monospace',
                        fontSize: 11,
                        color: 'var(--imp-text-secondary, #8b92a1)',
                        maxWidth: 190,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {primaryArtist}
                    </span>
                  </button>
                )}

                {!isVideoTrack && (track.source === 'soundcloud' || primaryArtist) && (
                  <button
                    type="button"
                    onClick={() => {
                      setPlayerActionsOpen(false);
                      if (
                        track.source === 'soundcloud' &&
                        handleStartSoundCloudTrackRadio
                      ) {
                        handleStartSoundCloudTrackRadio(track);
                      } else if (primaryArtist && handleMoreByArtist) {
                        handleMoreByArtist(
                          primaryArtist,
                          track.source,
                          scTrackUserId || undefined
                        );
                      }
                    }}
                    style={rowBtnStyle}
                  >
                    <span>
                      {track.source === 'soundcloud' ? 'Track Radio' : 'Artist Radio'}
                    </span>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#fdba74' }}>
                      →
                    </span>
                  </button>
                )}

                {isSoundCloudTrack && scTrackUserId && primaryArtist && (
                  <button
                    type="button"
                    onClick={() => {
                      const nextFollow = !scCreatorFollowed;
                      toggleFollowSoundCloudUser(
                        scTrackUserId,
                        nextFollow,
                        primaryArtist,
                        showToast
                      )
                        .then((ok) => {
                          if (ok) setScCreatorFollowed(nextFollow);
                        })
                        .catch((err: any) => {
                          showToast?.(
                            err?.message || 'Sign in with SoundCloud to follow creators'
                          );
                        });
                    }}
                    style={rowBtnStyle}
                  >
                    <span>{scCreatorFollowed ? 'Following Creator' : 'Follow Creator'}</span>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#fdba74' }}>
                      {scCreatorFollowed ? 'On' : 'Off'}
                    </span>
                  </button>
                )}

                {!isSoundCloudTrack && !isVideoTrack && Boolean(track.title) && (
                  <button
                    type="button"
                    disabled={scCrossMatchLoading}
                    onClick={() => {
                      if (scCrossMatch && scCrossMatchCheckedUri === track.uri) {
                        openSoundCloudPermalink({
                          permalinkUrl: scCrossMatch.permalink_url,
                          kind: 'track',
                          id: scCrossMatch.id,
                        });
                        return;
                      }
                      setScCrossMatchLoading(true);
                      matchTrackOnSoundCloud(track.title, primaryArtist, track.duration_ms)
                        .then((matched) => {
                          setScCrossMatchCheckedUri(track.uri);
                          setScCrossMatch(matched);
                          if (matched) {
                            openSoundCloudPermalink({
                              permalinkUrl: matched.permalink_url,
                              kind: 'track',
                              id: matched.id,
                            });
                          } else {
                            showToast?.('No SoundCloud match found');
                          }
                        })
                        .catch((err: any) => {
                          showToast?.(err?.message || 'Unable to look up track');
                        })
                        .finally(() => {
                          setScCrossMatchLoading(false);
                        });
                    }}
                    style={{
                      ...rowBtnStyle,
                      opacity: scCrossMatchLoading ? 0.7 : 1,
                    }}
                  >
                    <span>
                      {scCrossMatchLoading
                        ? 'Searching SoundCloud...'
                        : scCrossMatch && scCrossMatchCheckedUri === track.uri
                          ? 'SoundCloud Comments ↗'
                          : 'Find on SoundCloud'}
                    </span>
                    <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#fdba74' }}>
                      {scCrossMatch && scCrossMatchCheckedUri === track.uri
                        ? `${scCrossMatch.comment_count}`
                        : '→'}
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  data-track-properties-trigger="true"
                  onClick={() => {
                    window.dispatchEvent(
                      new CustomEvent('simp-open-track-properties', { detail: track })
                    );
                  }}
                  style={{
                    ...rowBtnStyle,
                    border: `1px solid ${playerTheme.accentBorder}`,
                    color: playerTheme.accent,
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <ImpIcon name="sliders" size={13} color={playerTheme.accent} />
                    Track Info
                  </span>
                  <span style={{ fontFamily: 'monospace', fontSize: 11 }}>▸</span>
                </button>
              </>
            ) : (
              <div style={{ padding: 14, color: 'var(--imp-text-secondary, #8b92a1)', fontSize: 12 }}>
                No track loaded.
              </div>
            )}
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              overflow: 'hidden',
              flex: 1,
            }}
          >
            {chapterModalItems.length > 0 && queueModalItems.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 11, fontFamily: 'monospace', color: 'var(--imp-text-secondary, #8b92a1)' }}>
                  {activeRightColItems.length > 0 ? currentQueueIdx + 1 : 0} / {activeRightColItems.length}
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setRightColMode((prev) => (prev === 'chapters' ? 'queue' : 'chapters'))
                  }
                  style={{
                    padding: '3px 8px',
                    borderRadius: 6,
                    background: 'var(--imp-surface-card, #1a1d24)',
                    border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                    color: 'var(--imp-accent-active-text, #f5e1be)',
                    fontSize: 10.5,
                    fontFamily: 'monospace',
                    fontWeight: 700,
                    cursor: 'pointer',
                  }}
                >
                  {rightColMode === 'chapters' ? 'Show Queue' : 'Show Chapters'}
                </button>
              </div>
            )}

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
                overflowY: 'auto',
                paddingRight: 2,
                flex: 1,
              }}
            >
              {activeRightColItems.length > 0 ? (
                activeRightColItems.map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    data-queue-current={item.isCurrent ? 'true' : undefined}
                    data-default-focus={item.isCurrent ? 'true' : undefined}
                    onClick={item.onSelect}
                    style={{
                      width: '100%',
                      padding: '7px 10px',
                      borderRadius: 6,
                      background: item.isCurrent
                        ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))'
                        : 'var(--imp-surface-card, #1a1d24)',
                      border: item.isCurrent
                        ? '1px solid var(--imp-focus-ring, #e8b86d)'
                        : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                      color: item.isCurrent
                        ? 'var(--imp-accent-active-text, #f5e1be)'
                        : 'var(--imp-text-primary, #eef0f4)',
                      textAlign: 'left',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: 10,
                      cursor: 'pointer',
                      flexShrink: 0,
                    }}
                  >
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: item.isCurrent ? 800 : 600,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {item.isCurrent ? '▶ ' : `${item.index + 1}. `}
                        {item.title}
                      </div>
                      {item.subtitle && (
                        <div
                          style={{
                            fontSize: 10.5,
                            color: 'var(--imp-text-secondary, #8b92a1)',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                    <span
                      style={{
                        fontSize: 10.5,
                        fontFamily: 'monospace',
                        color: 'var(--imp-text-secondary, #8b92a1)',
                        flexShrink: 0,
                      }}
                    >
                      {item.durationMs > 0 ? formatDuration(item.durationMs) : item.badgeLabel}
                    </span>
                  </button>
                ))
              ) : (
                <div style={{ padding: 14, color: 'var(--imp-text-secondary, #8b92a1)', fontSize: 12 }}>
                  Queue is empty.
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
