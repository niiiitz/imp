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
import { CollectionTileCard } from './CollectionTileCard';
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
  setActivePlaylistId,
  selectLocalCollection,
  openLibraryContextMenu,
}) => {
  const isLocal = pl.origin === 'simp_local';
  const isActiveTarget = isLocal && activePlaylistId === pl.id;
  const isSelected =
    rightPaneMode === 'tracks' && browserTarget?.kind === 'playlist' && browserTarget.id === pl.id;
  const cleanTitle = cleanCollectionTitle(pl.name);
  const sourceBadge = formatPlaylistSourceBadge(pl);
  const trackLabel = `${pl.track_count} ${pl.track_count === 1 ? 'track' : 'tracks'}`;

  const ctxTarget: LibraryContextTarget = {
    type: 'collection',
    kind: 'simp_playlist',
    id: pl.id,
    title: cleanTitle,
    subtitle: trackLabel,
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
  };

  const badgeContent =
    pl.origin === 'apple_remote' ? (
      <AppleMusicLogo size={11} />
    ) : pl.origin === 'soundcloud_remote' ? (
      <SoundCloudLogo width={24} color="#fdba74" />
    ) : pl.origin === 'archive_remote' ? (
      <>
        <ImpIcon name="archive" size={11} color="#fde68a" />
        <span>Archive</span>
      </>
    ) : (
      <>
        <ImpIcon name="imp" size={11} color="#f5e1be" />
        <span>{isActiveTarget ? `★ ${sourceBadge}` : sourceBadge}</span>
      </>
    );

  return (
    <CollectionTileCard
      tileKey={`playlist:${pl.id}`}
      isSelected={isSelected}
      title={cleanTitle}
      subtitle={trackLabel}
      artwork={
        <ResilientTileArtwork
          square
          src={pl.cover_art_url}
          fallbackIcon={
            isLocal ? (
              <ImpIcon name="imp" size={28} color="var(--imp-accent-active-text, #f5e1be)" />
            ) : pl.origin === 'soundcloud_remote' ? (
              <SoundCloudLogo width={42} color="#fdba74" />
            ) : pl.origin === 'archive_remote' ? (
              <ImpIcon name="archive" size={28} color="#fde68a" />
            ) : (
              <AppleMusicLogo size={28} />
            )
          }
          bg={isLocal ? '#1e1b16' : '#251018'}
          border={
            isLocal
              ? '1px solid rgba(232, 184, 109, 0.35)'
              : '1px solid rgba(255, 255, 255, 0.08)'
          }
          playlistCoverId={
            pl.id.startsWith('applemusic:playlist:')
              ? pl.id.replace('applemusic:playlist:', '')
              : undefined
          }
        />
      }
      badge={badgeContent}
      onSelect={() => {
        if (isLocal) {
          setActivePlaylistId(pl.id);
        }
        selectLocalCollection({ kind: 'playlist', id: pl.id });
      }}
      onOpenContextMenu={() => openLibraryContextMenu(ctxTarget)}
    />
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
}) => {
  const isAppleAlbum = alb.id.startsWith('applemusic:album:');
  const isLocalPinned =
    !isAppleAlbum && playlists.some((p) => p.id === `local:album:${alb.id}`);
  const isSelected =
    rightPaneMode === 'tracks' && browserTarget?.kind === 'album' && browserTarget.id === alb.id;
  const cleanTitle = cleanCollectionTitle(alb.title);
  const artistDisplay = stripAlbumFormatSuffix(alb.album_artist);
  const formatBadge = extractAlbumFormatBadge(alb.album_artist);

  const ctxTarget: LibraryContextTarget = {
    type: 'collection',
    kind: 'simp_album',
    id: alb.id,
    title: cleanTitle,
    subtitle: `${artistDisplay} • ${alb.track_count} tracks`,
    art_url: alb.art_url,
    artistName: artistDisplay,
    source: isAppleAlbum ? 'apple_music' : 'local',
    rawItem: alb,
  };

  return (
    <CollectionTileCard
      tileKey={`album:${alb.id}`}
      isSelected={isSelected}
      title={cleanTitle}
      subtitle={
        <>
          <ContentRatingBadge rating={alb.content_rating} style={{ marginRight: 5 }} />
          {artistDisplay}
          {!isAppleAlbum && alb.release_year ? ` • ${alb.release_year}` : ''}
          {` • ${alb.track_count} trk`}
        </>
      }
      artwork={
        <ResilientTileArtwork
          square
          src={alb.art_url}
          fallbackIcon={<ImpIcon name="disc" size={28} color="#94a3b8" />}
          bg="#121820"
          border="1px solid rgba(255, 255, 255, 0.08)"
        />
      }
      badge={
        isAppleAlbum ? (
          <AppleMusicLogo size={11} />
        ) : (
          <span>
            {isLocalPinned ? '★ ' : ''}
            {formatBadge || 'Local'}
          </span>
        )
      }
      onSelect={() => selectLocalCollection({ kind: 'album', id: alb.id })}
      onOpenContextMenu={() => openLibraryContextMenu(ctxTarget)}
    />
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
  const openCtx = openLibraryContextMenu
    ? () =>
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
        })
    : undefined;

  return (
    <CollectionTileCard
      tileKey={`artist:local:name:${artistName}`}
      isSelected={isSelected}
      title={artistName}
      subtitle={subtitle || 'Local Library Artist'}
      artwork={
        <ResilientTileArtwork
          square
          src={artUrl}
          fallbackIcon={<ImpIcon name="music" size={28} color="var(--imp-accent-active-text, #f5e1be)" />}
          bg="#1a1814"
          border="1px solid rgba(232, 184, 109, 0.28)"
        />
      }
      badge="Artist"
      onSelect={onSelect}
      onOpenContextMenu={openCtx}
    />
  );
};
