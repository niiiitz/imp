import React from 'react';
import { AlbumRecord, PlaylistRecord } from '@simp/client';
import { BrowserTarget } from '../../PlayerView';
import { LibraryContextTarget } from '../../LibraryBrowserView';
import {
  cleanCollectionTitle,
  extractAlbumFormatBadge,
  formatPlaylistSourceBadge,
  stripAlbumFormatSuffix,
} from '../libraryHelpers';
import { ContentRatingBadge } from '../ContentRatingBadge';
import { ResilientTileArtwork } from '../ResilientTileArtwork';
import { AppleMusicLogo } from '../../../components/AppleMusicLogo';
import { SoundCloudLogo } from '../../../components/SoundCloudLogo';
import { ImpIcon } from '../../../components/icons/ImpIcon';

export interface SimpPlaylistCardProps {
  pl: PlaylistRecord;
  activePlaylistId: string;
  rightPaneMode: 'browse' | 'tracks' | 'artist';
  browserTarget: BrowserTarget | null;
  isEditableRemote?: boolean;
  setActivePlaylistId: (id: string) => void;
  selectLocalCollection: (target: BrowserTarget) => void;
  openLibraryContextMenu: (target: LibraryContextTarget) => void;
  handleAddSimpPlaylistToHybrid: (pl: PlaylistRecord) => void;
  handleDeletePlaylist: (playlistId: string, playlistName: string) => void;
}

export const SimpPlaylistCard: React.FC<SimpPlaylistCardProps> = ({
  pl,
  activePlaylistId,
  rightPaneMode,
  browserTarget,
  isEditableRemote,
  setActivePlaylistId,
  selectLocalCollection,
  openLibraryContextMenu,
  handleAddSimpPlaylistToHybrid,
  handleDeletePlaylist,
}) => {
  const isLocal = pl.origin === 'simp_local';
  const isActiveTarget = isLocal && activePlaylistId === pl.id;
  const isSelected =
    rightPaneMode === 'tracks' && browserTarget?.kind === 'playlist' && browserTarget.id === pl.id;
  const cleanTitle = cleanCollectionTitle(pl.name);
  const sourceBadge = formatPlaylistSourceBadge(pl);
  return (
    <button
      data-right-tile="true"
      data-tile-key={`playlist:${pl.id}`}
      onContextMenu={(e) => {
        e.preventDefault();
        openLibraryContextMenu({
          type: 'collection',
          kind: 'simp_playlist',
          id: pl.id,
          title: cleanTitle,
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
      }}
      onClick={() => {
        if (isLocal) {
          setActivePlaylistId(pl.id);
        }
        selectLocalCollection({ kind: 'playlist', id: pl.id });
      }}
      style={{
        minWidth: 0,
        minHeight: 124,
        padding: 10,
        borderRadius: 12,
        background: isSelected ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))' : 'var(--imp-surface-card, #1a1d24)',
        border: isSelected ? '1px solid var(--imp-focus-ring, #e8b86d)' : '1px solid #181822',
        color: '#d4d4dc',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 8,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 6,
        }}
      >
        <ResilientTileArtwork
          src={pl.cover_art_url}
          fallbackIcon={
            isLocal ? (
              <ImpIcon name="imp" size={20} color="var(--imp-accent-active-text, #f5e1be)" />
            ) : pl.origin === 'soundcloud_remote' ? (
              <SoundCloudLogo width={30} color="#fdba74" />
            ) : pl.origin === 'archive_remote' ? (
              <ImpIcon name="archive" size={20} color="#fde68a" />
            ) : (
              <AppleMusicLogo size={20} />
            )
          }
          bg={isLocal ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))' : '#251018'}
          border={isLocal ? '1px solid var(--imp-focus-ring, #e8b86d)' : '1px solid #4c1d2e'}
          playlistCoverId={
            pl.id.startsWith('applemusic:playlist:')
              ? pl.id.replace('applemusic:playlist:', '')
              : undefined
          }
        />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 4,
            flexShrink: 0,
            minWidth: 0,
          }}
        >
          <span
            title={
              isLocal
                ? 'Editable IMP Hybrid Playlist'
                : isEditableRemote ?? (pl.origin === 'apple_remote' && pl.id.replace(/^applemusic:playlist:/, '').startsWith('p.'))
                  ? 'Editable Cloud Collection (supports online write-back or local fork)'
                  : 'Read-Only Pinned Collection (fork to IMP Hybrid to edit)'
            }
            style={{
              padding: '2px 6px',
              borderRadius: 6,
              background: isLocal ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))' : '#251018',
              border: isLocal ? '1px solid var(--imp-focus-ring, #e8b86d)' : '1px solid #4c1d2e',
              color: isLocal ? 'var(--imp-accent-active-text, #f5e1be)' : '#fda4af',
              fontSize: 10,
              fontFamily: 'monospace',
              fontWeight: 800,
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {pl.origin === 'apple_remote' ? (
              <>
                <AppleMusicLogo size={11} />
                <span>
                  {(isEditableRemote ??
                  pl.id.replace(/^applemusic:playlist:/, '').startsWith('p.'))
                    ? '✎'
                    : '🔒'}
                </span>
              </>
            ) : pl.origin === 'soundcloud_remote' ? (
              <>
                <SoundCloudLogo width={26} color="#ffffff" />
                <span>{isEditableRemote ? '✎' : '🔒'}</span>
              </>
            ) : (
              <>
                <ImpIcon name="imp" size={11} color={isLocal ? 'var(--imp-accent-active-text, #f5e1be)' : '#fda4af'} />
                <span>{isActiveTarget ? `★ ${sourceBadge}` : sourceBadge}</span>
              </>
            )}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            {!isLocal ? (
              <span
                role="button"
                data-tile-aux="true"
                data-tile-select="true"
                title="Add all tracks to active ★ Imp Hybrid Playlist"
                onClick={(e) => {
                  e.stopPropagation();
                  handleAddSimpPlaylistToHybrid(pl);
                }}
                style={{
                  padding: '2px 6px',
                  borderRadius: 6,
                  background: 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
                  border: '1px solid var(--imp-focus-ring, #e8b86d)',
                  color: 'var(--imp-accent-active-text, #f5e1be)',
                  fontSize: 10,
                  fontWeight: 800,
                  cursor: 'pointer',
                }}
              >
                +
              </span>
            ) : (
              <span
                role="button"
                data-tile-aux="true"
                data-tile-select="true"
                title="Set as active ★ target playlist"
                onClick={(e) => {
                  e.stopPropagation();
                  setActivePlaylistId(pl.id);
                }}
                style={{
                  padding: '2px 6px',
                  borderRadius: 6,
                  background: isActiveTarget ? '#13303d' : '#12141c',
                  border: isActiveTarget ? '1px solid var(--imp-focus-ring, #e8b86d)' : '1px solid #262a38',
                  color: isActiveTarget ? 'var(--imp-accent-active-text, #f5e1be)' : '#71717a',
                  fontSize: 10,
                  fontWeight: 800,
                  cursor: 'pointer',
                }}
              >
                ★
              </span>
            )}
            <span
              role="button"
              data-tile-aux="true"
              data-tile-y="true"
              title={isLocal ? 'Delete Imp Playlist (Y)' : 'Unpin Playlist from Imp (Y)'}
              onClick={(e) => {
                e.stopPropagation();
                handleDeletePlaylist(pl.id, cleanTitle);
              }}
              style={{
                padding: '2px 6px',
                borderRadius: 6,
                background: '#1c1115',
                border: '1px solid #4c2228',
                color: '#fca5a5',
                fontSize: 10,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              {isLocal ? '🗑' : '✕'}
            </span>
          </div>
        </div>
      </div>
      <div style={{ minWidth: 0, width: '100%' }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 800,
            lineHeight: 1.3,
            color: '#e4e4ec',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
          }}
        >
          {cleanTitle}
        </div>
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.35,
            color: '#8e8e99',
            marginTop: 4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
          }}
        >
          {pl.track_count} {pl.track_count === 1 ? 'track' : 'tracks'}
        </div>
      </div>
    </button>
  );
};

export interface SimpAlbumCardProps {
  alb: AlbumRecord;
  playlists: PlaylistRecord[];
  rightPaneMode: 'browse' | 'tracks' | 'artist';
  browserTarget: BrowserTarget | null;
  selectLocalCollection: (target: BrowserTarget) => void;
  openLibraryContextMenu: (target: LibraryContextTarget) => void;
  handleAddSimpAlbumToHybrid: (alb: AlbumRecord) => void;
  handleDeleteAlbum: (albumId: string, albumTitle: string) => void;
  handleTogglePinLocalAlbum: (alb: AlbumRecord) => void;
}

export const SimpAlbumCard: React.FC<SimpAlbumCardProps> = ({
  alb,
  playlists,
  rightPaneMode,
  browserTarget,
  selectLocalCollection,
  openLibraryContextMenu,
  handleAddSimpAlbumToHybrid,
  handleDeleteAlbum,
  handleTogglePinLocalAlbum,
}) => {
  const isAppleAlbum = alb.id.startsWith('applemusic:album:');
  const isLocalPinned =
    !isAppleAlbum && playlists.some((p) => p.id === `local:album:${alb.id}`);
  const isSelected =
    rightPaneMode === 'tracks' && browserTarget?.kind === 'album' && browserTarget.id === alb.id;
  const cleanTitle = cleanCollectionTitle(alb.title);
  return (
    <button
      data-right-tile="true"
      data-tile-key={`album:${alb.id}`}
      onContextMenu={(e) => {
        e.preventDefault();
        openLibraryContextMenu({
          type: 'collection',
          kind: 'simp_album',
          id: alb.id,
          title: cleanTitle,
          subtitle: `${alb.album_artist} • ${alb.track_count} tracks`,
          art_url: alb.art_url,
          artistName: stripAlbumFormatSuffix(alb.album_artist),
          source: isAppleAlbum ? 'apple_music' : 'local',
          rawItem: alb,
        });
      }}
      onClick={() => selectLocalCollection({ kind: 'album', id: alb.id })}
      style={{
        minWidth: 0,
        minHeight: 124,
        padding: 10,
        borderRadius: 12,
        background: isSelected ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))' : 'var(--imp-surface-card, #1a1d24)',
        border: isSelected ? '1px solid var(--imp-focus-ring, #e8b86d)' : '1px solid #181822',
        color: '#d4d4dc',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 8,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 6,
        }}
      >
        <ResilientTileArtwork
          src={alb.art_url}
          fallbackIcon="💿"
          bg="#121820"
          border="1px solid #222e3c"
        />
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-end',
            gap: 4,
            flexShrink: 0,
            minWidth: 0,
          }}
        >
          <span
            style={{
              padding: '2px 6px',
              borderRadius: 6,
              background: isAppleAlbum ? '#251018' : 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
              border: isAppleAlbum ? '1px solid #4c1d2e' : '1px solid var(--imp-focus-ring, #e8b86d)',
              color: isAppleAlbum ? '#fda4af' : 'var(--imp-accent-active-text, #f5e1be)',
              fontSize: 10,
              fontFamily: 'monospace',
              fontWeight: 800,
              whiteSpace: 'nowrap',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {isAppleAlbum ? (
              <AppleMusicLogo size={12} />
            ) : (
              (() => {
                const badge = extractAlbumFormatBadge(alb.album_artist);
                return badge ? `💾 ${badge}` : '💾';
              })()
            )}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <span
              role="button"
              data-tile-aux="true"
              data-tile-select="true"
              title="Add album tracks to active ★ Imp Hybrid Playlist"
              onClick={(e) => {
                e.stopPropagation();
                handleAddSimpAlbumToHybrid(alb);
              }}
              style={{
                padding: '2px 6px',
                borderRadius: 6,
                background: 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
                border: '1px solid var(--imp-focus-ring, #e8b86d)',
                color: 'var(--imp-accent-active-text, #f5e1be)',
                fontSize: 10,
                fontWeight: 800,
                cursor: 'pointer',
              }}
            >
              +
            </span>
            {isAppleAlbum ? (
              <span
                role="button"
                data-tile-aux="true"
                data-tile-y="true"
                title="Unpin Album from Imp (Y)"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteAlbum(alb.id, cleanTitle);
                }}
                style={{
                  padding: '2px 6px',
                  borderRadius: 6,
                  background: '#1c1115',
                  border: '1px solid #4c2228',
                  color: '#fca5a5',
                  fontSize: 10,
                  fontWeight: 800,
                  cursor: 'pointer',
                }}
              >
                ✕
              </span>
            ) : (
              <span
                role="button"
                data-tile-aux="true"
                data-tile-y="true"
                title={
                  isLocalPinned
                    ? 'Unpin Local Album from Imp Library (Y)'
                    : 'Pin Local Album to Imp Library (Y)'
                }
                onClick={(e) => {
                  e.stopPropagation();
                  handleTogglePinLocalAlbum(alb);
                }}
                style={{
                  padding: '3px 6px',
                  borderRadius: 6,
                  background: isLocalPinned ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))' : '#121820',
                  border: isLocalPinned ? '1px solid var(--imp-focus-ring, #e8b86d)' : '1px solid #283848',
                  color: isLocalPinned ? 'var(--imp-accent-active-text, #f5e1be)' : 'var(--imp-accent-active-text, #f5e1be)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                }}
              >
                <ImpIcon
                  name={isLocalPinned ? 'check' : 'imp'}
                  size={11}
                  color={isLocalPinned ? 'var(--imp-accent-active-text, #f5e1be)' : 'var(--imp-accent-active-text, #f5e1be)'}
                />
              </span>
            )}
          </div>
        </div>
      </div>
      <div style={{ minWidth: 0, width: '100%' }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 800,
            lineHeight: 1.3,
            color: '#e4e4ec',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
          }}
        >
          {cleanTitle}
        </div>
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.35,
            color: '#8e8e99',
            marginTop: 4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
          }}
        >
          <ContentRatingBadge rating={alb.content_rating} style={{ marginRight: 5 }} />
          {alb.album_artist}
          {!isAppleAlbum && alb.release_year ? ` • ${alb.release_year}` : ''}
          {!isAppleAlbum && alb.genre ? ` • ${alb.genre}` : ''} • {alb.track_count} tracks
        </div>
        {!isAppleAlbum && alb.parent_folder && alb.parent_folder !== '/' && (
          <div
            title={`Folder: ${alb.parent_folder}`}
            style={{
              fontSize: 9.5,
              fontFamily: 'monospace',
              color: '#6ee7b7',
              opacity: 0.78,
              marginTop: 2,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            📂 {alb.parent_folder}
          </div>
        )}
      </div>
    </button>
  );
};

export interface LocalArtistCardProps {
  artistName: string;
  artUrl?: string | null;
  subtitle?: string;
  isSelected: boolean;
  onSelect: () => void;
  openLibraryContextMenu?: (target: LibraryContextTarget) => void;
}

export const LocalArtistCard: React.FC<LocalArtistCardProps> = ({
  artistName,
  artUrl,
  subtitle,
  isSelected,
  onSelect,
  openLibraryContextMenu,
}) => {
  return (
    <button
      data-right-tile="true"
      data-tile-key={`artist:local:name:${artistName}`}
      onContextMenu={(e) => {
        if (!openLibraryContextMenu) return;
        e.preventDefault();
        openLibraryContextMenu({
          type: 'collection',
          kind: 'artist',
          id: `name:${artistName}`,
          title: artistName,
          subtitle: subtitle || 'Local Library Artist',
          art_url: artUrl,
          artistName,
          source: 'local',
          rawItem: { name: artistName, artUrl, subtitle },
        });
      }}
      onClick={onSelect}
      style={{
        minWidth: 0,
        minHeight: 124,
        padding: 10,
        borderRadius: 12,
        background: isSelected ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))' : 'var(--imp-surface-card, #1a1d24)',
        border: isSelected ? '1px solid var(--imp-focus-ring, #e8b86d)' : '1px solid #181822',
        color: '#d4d4dc',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        alignItems: 'flex-start',
        gap: 8,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 6,
        }}
      >
        <ResilientTileArtwork
          src={artUrl}
          fallbackIcon="🎤"
          bg="var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))"
          border="1px solid var(--imp-focus-ring, #e8b86d)"
        />
        <span
          style={{
            padding: '2px 6px',
            borderRadius: 6,
            background: 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
            border: '1px solid var(--imp-focus-ring, #e8b86d)',
            color: 'var(--imp-accent-active-text, #f5e1be)',
            fontSize: 10,
            fontFamily: 'monospace',
            fontWeight: 800,
            whiteSpace: 'nowrap',
          }}
        >
          💾 Artist
        </span>
      </div>
      <div style={{ minWidth: 0, width: '100%' }}>
        <div
          style={{
            fontSize: 13,
            fontWeight: 800,
            lineHeight: 1.3,
            color: '#e4e4ec',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
          }}
        >
          {artistName}
        </div>
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.35,
            color: '#8e8e99',
            marginTop: 4,
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
          }}
        >
          {subtitle || 'Local Library Artist'}
        </div>
      </div>
    </button>
  );
};
