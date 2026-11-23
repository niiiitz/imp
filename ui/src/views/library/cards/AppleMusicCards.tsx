import React from 'react';
import { AlbumRecord, PlaylistRecord, TrackMetadata } from '@simp/client';
import {
  AppleArtistSummary,
  AppleCloudAlbumSummary,
  AppleCloudPlaylistSummary,
  AppleRadioStationSummary,
} from '../../../drivers/AppleMusicDriver';
import { BrowserTarget } from '../../PlayerView';
import { LibraryContextTarget } from '../../LibraryBrowserView';
import { ContentRatingBadge } from '../ContentRatingBadge';
import { ResilientTileArtwork } from '../ResilientTileArtwork';
import { CollectionTileCard } from './CollectionTileCard';
import { AppleMusicLogo } from '../../../components/AppleMusicLogo';
import { ImpIcon } from '../../../components/icons/ImpIcon';

export interface CloudPlaylistCardProps {
  pl: AppleCloudPlaylistSummary;
  playlists: PlaylistRecord[];
  browserTarget: BrowserTarget | null;
  selectCloudPlaylist: (pl: AppleCloudPlaylistSummary) => void;
  setCloudPlaylists: React.Dispatch<React.SetStateAction<AppleCloudPlaylistSummary[]>>;
  openLibraryContextMenu: (target: LibraryContextTarget) => void;
  handleAddAppleToCloudLibrary?: (
    idOrUri: string,
    kind?: 'songs' | 'albums' | 'playlists',
    label?: string
  ) => Promise<void>;
  handleAddCloudPlaylistToHybrid: (pl: AppleCloudPlaylistSummary) => void;
  handleDeletePlaylist: (playlistId: string, playlistName: string) => void;
  handlePinCloudPlaylist: (pl: AppleCloudPlaylistSummary) => void;
}

export const CloudPlaylistCard: React.FC<CloudPlaylistCardProps> = ({
  pl,
  playlists,
  browserTarget,
  selectCloudPlaylist,
  setCloudPlaylists,
  openLibraryContextMenu,
}) => {
  const isSelected = browserTarget?.kind === 'cloud_playlist' && browserTarget.id === pl.id;
  const isPinned = playlists.some((p) => p.id === `applemusic:playlist:${pl.id}`);
  const ctxTarget: LibraryContextTarget = {
    type: 'collection',
    kind: 'cloud_playlist',
    id: pl.id,
    title: pl.name,
    subtitle: pl.description || 'Apple Music Playlist',
    art_url: pl.art_url,
    source: 'apple_music',
    rawItem: pl,
  };

  return (
    <CollectionTileCard
      tileKey={`cloud_playlist:${pl.id}`}
      isSelected={isSelected}
      selectedBg="#28111b"
      selectedBorder="1px solid #fa243c"
      title={pl.name}
      subtitle={pl.description || 'Apple Music Playlist'}
      artwork={
        <ResilientTileArtwork
          square
          src={pl.art_url}
          fallbackIcon={<AppleMusicLogo size={28} />}
          bg="#181118"
          border="1px solid rgba(255, 255, 255, 0.08)"
          playlistCoverId={pl.id}
          playlistKind={pl.kind}
          onResolvedCover={(url) => {
            setCloudPlaylists((prev) =>
              prev.map((item) => (item.id === pl.id ? { ...item, art_url: url } : item))
            );
          }}
        />
      }
      badge={
        <>
          <AppleMusicLogo size={11} />
          {isPinned && <span>★</span>}
        </>
      }
      onSelect={() => selectCloudPlaylist(pl)}
      onOpenContextMenu={() => openLibraryContextMenu(ctxTarget)}
    />
  );
};

export interface CloudAlbumCardProps {
  alb: AppleCloudAlbumSummary;
  albums: AlbumRecord[];
  browserTarget: BrowserTarget | null;
  selectCloudAlbum: (params: {
    albumId?: string | null;
    songUri?: string | null;
    fallbackTitle?: string;
  }) => void;
  openLibraryContextMenu: (target: LibraryContextTarget) => void;
  handleAddAppleToCloudLibrary?: (
    idOrUri: string,
    kind?: 'songs' | 'albums' | 'playlists',
    label?: string
  ) => Promise<void>;
  handleAddCloudAlbumToHybrid: (alb: AppleCloudAlbumSummary) => void;
  handleDeleteAlbum: (albumId: string, albumTitle: string) => void;
  setCloudLoading: React.Dispatch<React.SetStateAction<boolean>>;
  handlePinCloudAlbum: (album: AppleCloudAlbumSummary, tracks: TrackMetadata[]) => Promise<void>;
}

export const CloudAlbumCard: React.FC<CloudAlbumCardProps> = ({
  alb,
  albums,
  browserTarget,
  selectCloudAlbum,
  openLibraryContextMenu,
}) => {
  const isSelected = browserTarget?.kind === 'cloud_album' && browserTarget.id === alb.id;
  const isPinned = albums.some((a) => a.id === `applemusic:album:${alb.id}`);
  const ctxTarget: LibraryContextTarget = {
    type: 'collection',
    kind: 'cloud_album',
    id: alb.id,
    title: alb.title,
    subtitle: `${alb.artist}${alb.release_year ? ` • ${alb.release_year}` : ''}`,
    art_url: alb.art_url,
    artistName: alb.artist,
    source: 'apple_music',
    rawItem: alb,
  };

  return (
    <CollectionTileCard
      tileKey={`cloud_album:${alb.id}`}
      isSelected={isSelected}
      selectedBg="#28111b"
      selectedBorder="1px solid #fa243c"
      title={alb.title}
      subtitleColor={alb.kind === 'library' ? '#fda4af' : undefined}
      subtitle={
        <>
          <ContentRatingBadge rating={alb.content_rating} style={{ marginRight: 5 }} />
          {alb.artist}
          {alb.release_year ? ` • ${alb.release_year}` : ''}
          {alb.track_count ? ` • ${alb.track_count} trk` : ''}
        </>
      }
      artwork={
        <ResilientTileArtwork
          square
          src={alb.art_url}
          fallbackIcon={<ImpIcon name="disc" size={28} color="#fda4af" />}
          bg="#181118"
          border="1px solid rgba(255, 255, 255, 0.08)"
        />
      }
      badge={
        <>
          <AppleMusicLogo size={11} />
          {isPinned && <span>★</span>}
        </>
      }
      onSelect={() =>
        selectCloudAlbum({
          albumId: alb.id,
          fallbackTitle: alb.title,
        })
      }
      onOpenContextMenu={() => openLibraryContextMenu(ctxTarget)}
    />
  );
};

export interface StationCardProps {
  st: AppleRadioStationSummary;
  playingContextId: string;
  handleStartAppleStation: (st: AppleRadioStationSummary) => void;
  openLibraryContextMenu?: (target: LibraryContextTarget) => void;
}

export const StationCard: React.FC<StationCardProps> = ({
  st,
  playingContextId,
  handleStartAppleStation,
  openLibraryContextMenu,
}) => {
  const isPlayingStation = playingContextId === `station:${st.id}`;
  const openCtx = openLibraryContextMenu
    ? () =>
        openLibraryContextMenu({
          type: 'collection',
          kind: 'apple_station',
          id: st.id,
          title: st.name,
          subtitle: st.subtitle || 'Apple Music Station',
          art_url: st.art_url,
          source: 'apple_music',
          rawItem: st,
        })
    : undefined;

  return (
    <CollectionTileCard
      tileKey={`station:${st.id}`}
      isSelected={isPlayingStation}
      selectedBg="#28111b"
      selectedBorder="1px solid #fa243c"
      title={st.name}
      subtitle={st.subtitle || 'Apple Music Station'}
      artwork={
        <ResilientTileArtwork
          square
          src={st.art_url}
          fallbackIcon={<ImpIcon name="radio" size={28} color="#fda4af" />}
          bg="#221118"
          border="1px solid rgba(255, 255, 255, 0.08)"
        />
      }
      badge="▶ LIVE"
      badgeStyle={{ color: '#fda4af' }}
      onSelect={() => handleStartAppleStation(st)}
      onOpenContextMenu={openCtx}
    />
  );
};

export interface AppleArtistCardProps {
  artist: AppleArtistSummary;
  isSelected: boolean;
  onSelect: () => void;
  openLibraryContextMenu?: (target: LibraryContextTarget) => void;
}

export const AppleArtistCard: React.FC<AppleArtistCardProps> = ({
  artist,
  isSelected,
  onSelect,
  openLibraryContextMenu,
}) => {
  const openCtx = openLibraryContextMenu
    ? () =>
        openLibraryContextMenu({
          type: 'collection',
          kind: 'artist',
          id: artist.id || `name:${artist.name}`,
          title: artist.name,
          subtitle: artist.genre || 'Apple Music Artist',
          art_url: artist.art_url,
          artistName: artist.name,
          source: 'apple_music',
          rawItem: artist,
        })
    : undefined;

  return (
    <CollectionTileCard
      tileKey={`artist:apple_music:${artist.id || `name:${artist.name}`}`}
      isSelected={isSelected}
      selectedBg="#28111b"
      selectedBorder="1px solid #fa243c"
      title={artist.name}
      subtitle={artist.genre || 'Apple Music Artist'}
      artwork={
        <ResilientTileArtwork
          square
          src={artist.art_url}
          fallbackIcon={<ImpIcon name="music" size={28} color="#fda4af" />}
          bg="#221118"
          border="1px solid rgba(255, 255, 255, 0.08)"
        />
      }
      badge={
        <>
          <AppleMusicLogo size={11} />
          <span>Artist</span>
        </>
      }
      onSelect={onSelect}
      onOpenContextMenu={openCtx}
    />
  );
};
