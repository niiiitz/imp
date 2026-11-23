import React from 'react';
import { ArchiveItemSummary, PlaylistRecord } from '@simp/client';
import {
  SoundCloudPlaylistSummary,
  SoundCloudUserSummary,
} from '../../../drivers/SoundCloudDriver';
import { BrowserTarget } from '../../PlayerView';
import { LibraryContextTarget } from '../../LibraryBrowserView';
import { iaItemCountCache, iaItemRatingCache } from '../libraryHelpers';
import { ContentRatingBadge } from '../ContentRatingBadge';
import { ResilientTileArtwork } from '../ResilientTileArtwork';
import { CollectionTileCard } from './CollectionTileCard';
import { SoundCloudLogo } from '../../../components/SoundCloudLogo';
import { ImpIcon } from '../../../components/icons/ImpIcon';

export interface SoundCloudPlaylistCardProps {
  pl: SoundCloudPlaylistSummary;
  playlists: PlaylistRecord[];
  browserTarget: BrowserTarget | null;
  selectSoundCloudPlaylist: (pl: SoundCloudPlaylistSummary) => void;
  openLibraryContextMenu: (target: LibraryContextTarget) => void;
  handleAddSoundCloudPlaylistToHybrid: (pl: SoundCloudPlaylistSummary) => void;
  handleDeletePlaylist: (playlistId: string, playlistName: string) => void;
  handlePinSoundCloudPlaylist: (pl: SoundCloudPlaylistSummary) => void;
}

export const SoundCloudPlaylistCard: React.FC<SoundCloudPlaylistCardProps> = ({
  pl,
  playlists,
  browserTarget,
  selectSoundCloudPlaylist,
  openLibraryContextMenu,
}) => {
  const isSelected = browserTarget?.kind === 'soundcloud_playlist' && browserTarget.id === pl.id;
  const isPinned = playlists.some((p) => p.id === `soundcloud:playlist:${pl.id}`);
  const subtitle = `${pl.track_count ? `${pl.track_count} tracks • ` : ''}${pl.description || 'SoundCloud Set'}`;

  return (
    <CollectionTileCard
      tileKey={`soundcloud_playlist:${pl.id}`}
      isSelected={isSelected}
      selectedBg="#2c140a"
      selectedBorder="1px solid #ea580c"
      title={pl.name}
      subtitle={subtitle}
      artwork={
        <ResilientTileArtwork
          square
          src={pl.art_url}
          fallbackIcon={<SoundCloudLogo width={42} color="#fdba74" />}
          bg="#23120b"
          border="1px solid rgba(255, 255, 255, 0.08)"
        />
      }
      badge={
        <>
          <SoundCloudLogo width={24} color="#fdba74" />
          {isPinned && <span>★</span>}
        </>
      }
      onSelect={() => selectSoundCloudPlaylist(pl)}
      onOpenContextMenu={() =>
        openLibraryContextMenu({
          type: 'collection',
          kind: 'sc_playlist',
          id: pl.id,
          title: pl.name,
          subtitle,
          art_url: pl.art_url,
          source: 'soundcloud',
          rawItem: pl,
        })
      }
    />
  );
};

export interface SoundCloudUserCardProps {
  user: SoundCloudUserSummary;
  browserTarget: BrowserTarget | null;
  selectSoundCloudUser: (user: SoundCloudUserSummary) => void;
  openLibraryContextMenu?: (target: LibraryContextTarget) => void;
}

export const SoundCloudUserCard: React.FC<SoundCloudUserCardProps> = ({
  user,
  browserTarget,
  selectSoundCloudUser,
  openLibraryContextMenu,
}) => {
  const isSelected = browserTarget?.kind === 'soundcloud_user' && browserTarget.id === user.id;
  const openCtx = openLibraryContextMenu
    ? () =>
        openLibraryContextMenu({
          type: 'collection',
          kind: 'artist',
          id: user.id,
          title: `@${user.username}`,
          subtitle: user.description || `${user.track_count} tracks`,
          art_url: user.avatar_url,
          artistName: user.username,
          source: 'soundcloud',
          rawItem: user,
        })
    : undefined;

  return (
    <CollectionTileCard
      tileKey={`artist:soundcloud:${user.id}`}
      isSelected={isSelected}
      selectedBg="#2c140a"
      selectedBorder="1px solid #ea580c"
      title={`@${user.username}`}
      subtitle={user.description || `${user.track_count} tracks`}
      artwork={
        <ResilientTileArtwork
          square
          src={user.avatar_url}
          fallbackIcon={<SoundCloudLogo width={42} color="#fdba74" />}
          bg="#23120b"
          border="1px solid rgba(255, 255, 255, 0.08)"
        />
      }
      badge={`${user.track_count} Trk`}
      onSelect={() => selectSoundCloudUser(user)}
      onOpenContextMenu={openCtx}
    />
  );
};

export interface ArchiveItemCardProps {
  item: ArchiveItemSummary;
  playlists: PlaylistRecord[];
  browserTarget: BrowserTarget | null;
  iaResolvedCounts: Record<string, number>;
  iaResolvedRatings?: Record<string, string>;
  openIaItem: (item: ArchiveItemSummary, autoPlayFirst?: boolean) => void;
  openLibraryContextMenu: (target: LibraryContextTarget) => void;
  handleAddArchiveItemToHybrid: (item: ArchiveItemSummary) => void;
  handleDeletePlaylist: (playlistId: string, playlistName: string) => void;
  handlePinArchiveItem: (item: ArchiveItemSummary) => void;
}

export const ArchiveItemCard: React.FC<ArchiveItemCardProps> = ({
  item,
  playlists,
  browserTarget,
  iaResolvedCounts,
  iaResolvedRatings,
  openIaItem,
  openLibraryContextMenu,
}) => {
  const isVideo = item.mediatype === 'movies';
  const isSelected = browserTarget?.kind === 'ia_item' && browserTarget.id === item.identifier;
  const isPinned = playlists.some((p) => p.id === `archive:item:${item.identifier}`);
  const count =
    item.item_count ??
    iaResolvedCounts[item.identifier] ??
    iaItemCountCache.get(item.identifier);
  const badgeLabel =
    count !== undefined && count > 0
      ? isVideo
        ? count === 1
          ? 'Film'
          : `${count} Ep`
        : count === 1
        ? 'Audio'
        : `${count} Trk`
      : isVideo
      ? 'Video'
      : 'Audio';

  return (
    <CollectionTileCard
      tileKey={`ia_item:${item.identifier}`}
      isSelected={isSelected}
      selectedBg="#261a0b"
      selectedBorder="1px solid #f59e0b"
      title={item.title}
      subtitle={
        <>
          <ContentRatingBadge
            rating={
              item.content_rating ||
              iaResolvedRatings?.[item.identifier] ||
              iaItemRatingCache.get(item.identifier)
            }
            style={{ marginRight: 5 }}
          />
          {item.creator}
          {item.year ? ` • ${item.year}` : ''}
        </>
      }
      artwork={
        <ResilientTileArtwork
          square
          src={item.art_url}
          fallbackIcon={<ImpIcon name="archive" size={28} color="#fde68a" />}
          bg="#1f160b"
          border="1px solid rgba(255, 255, 255, 0.08)"
        />
      }
      badge={
        <>
          <ImpIcon name="archive" size={11} color="#fde68a" />
          <span>
            {isPinned ? '★ ' : ''}
            {badgeLabel}
          </span>
        </>
      }
      onSelect={() => openIaItem(item, false)}
      onOpenContextMenu={() =>
        openLibraryContextMenu({
          type: 'collection',
          kind: 'ia_item',
          id: item.identifier,
          title: item.title,
          subtitle: `${item.creator}${item.year ? ` • ${item.year}` : ''}`,
          art_url: item.art_url,
          artistName: item.creator,
          source: 'internet_archive',
          rawItem: item,
        })
      }
    />
  );
};
