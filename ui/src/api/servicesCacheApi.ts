import { useEffect, useState } from 'react';
import { AlbumRecord, ArchiveItemSummary, TrackMetadata } from '@simp/client';
import {
  AppleCloudAlbumSummary,
  AppleCloudPlaylistSummary,
  AppleRadioStationSummary,
  AppleRecommendationShelf,
  fetchAppleCloudPlaylists,
  fetchAppleLibraryRecentlyAdded,
  fetchAppleNewFeed,
  fetchAppleRadioAndForYou,
} from '../drivers/AppleMusicDriver';
import {
  fetchSoundCloudDiscover,
  fetchSoundCloudFollowings,
  fetchSoundCloudLikesAndPlaylists,
  fetchSoundCloudStreamAndRadio,
  SoundCloudPlaylistSummary,
  SoundCloudUserSummary,
} from '../drivers/SoundCloudDriver';

export type FypProvider = 'local' | 'apple_music' | 'soundcloud' | 'internet_archive';

export type FypItemKind =
  | 'artists'
  | 'albums'
  | 'playlists'
  | 'stations'
  | 'ia_items'
  | 'tracks'
  | 'mixed';

export interface LocalSmartStation {
  id: string;
  title: string;
  subtitle: string;
  station_kind: 'mix' | 'lossless' | 'karaoke' | 'soundtracks' | string;
  art_url?: string | null;
  track_count: number;
  tracks: TrackMetadata[];
}

export interface LocalDiscoverResponse {
  recent_albums: AlbumRecord[];
  rediscover_albums: AlbumRecord[];
  smart_stations: LocalSmartStation[];
}

export interface FypOriginRoute {
  sourceFilter: 'all' | 'local' | 'apple_music' | 'soundcloud' | 'internet_archive';
  localSubTab?: 'overview' | 'artists' | 'albums' | 'folders' | 'videos';
  appleSubTab?: 'pinned' | 'for_you' | 'cloud_playlists' | 'new' | 'radio';
  soundCloudSubTab?: 'pinned' | 'likes_sets' | 'stream_radio' | 'trending';
  iaSubTab?: 'pinned' | 'trending' | 'films' | 'tv' | 'audio';
  iaSubFilter?: string;
  scSelectedGenre?: string;
  artistProfile?: {
    source: 'apple_music' | 'soundcloud' | 'local';
    idOrName: string;
    displayName: string;
  };
  sectionAnchor: string;
}

export type FypFetchSpec =
  | {
      kind: 'local_discover';
      section: 'smart_stations' | 'rediscover_albums' | 'recent_albums';
    }
  | {
      kind: 'apple_for_you';
      section:
        | 'personal_stations'
        | 'new_releases'
        | 'recently_played'
        | 'recent_library'
        | 'for_you_playlists'
        | 'for_you_albums'
        | 'shelf';
      shelfId?: string;
    }
  | {
      kind: 'apple_new';
      section: 'recent_releases' | 'albums' | 'playlists' | 'songs';
    }
  | {
      kind: 'apple_radio';
      section: 'live' | 'shows' | 'mixes' | 'genre';
    }
  | {
      kind: 'sc_discover';
      section:
        | 'more_of_what_you_like'
        | 'recommended_artists'
        | 'fresh_uploads'
        | 'featured_sets'
        | 'dj_mixes'
        | 'trending_tracks';
      genre?: string;
    }
  | {
      kind: 'sc_stream';
      section: 'stream_tracks' | 'stream_sets';
    }
  | {
      kind: 'sc_likes';
      section: 'sets' | 'liked_tracks' | 'followings';
    }
  | {
      kind: 'ia_discover';
      tab: 'trending' | 'films' | 'tv' | 'audio';
      subFilter: string;
    }
  | {
      kind: 'artist_section';
      artistSource: 'apple_music' | 'soundcloud' | 'local';
      idOrName: string;
      displayName: string;
      section: 'top_tracks' | 'albums' | 'singles_or_sets' | 'related_or_following';
    };

export interface FypShelfDescriptor {
  shelfUid: string;
  cacheKey: string;
  provider: FypProvider;
  title: string;
  itemKind: FypItemKind;
  fetchSpec: FypFetchSpec;
  originRoute: FypOriginRoute;
  ttlSec: number;
}

export interface CachedShelfRecord {
  cache_key: string;
  provider: string;
  shelf_id: string;
  title: string;
  payload_json: string;
  fetched_at: number;
  ttl_sec: number;
}

export interface FypShelfRecord {
  shelf_uid: string;
  provider: string;
  shelf_kind: string;
  title: string;
  descriptor_json: string;
  sort_order: number;
  enabled: boolean;
}

export const TTL_FAST_FEED_SEC = 1800; // 30 minutes
export const TTL_CATALOG_FEED_SEC = 3600; // 1 hour
export const TTL_ARCHIVE_SEC = 86400; // 24 hours
export const TTL_STRUCTURAL_ARTIST_SEC = 172800; // 48 hours

export function resolveDaemonUrl(path: string): string {
  if (typeof window !== 'undefined' && window.location?.hostname) {
    const host = window.location.hostname;
    if (
      window.location.protocol === 'http:' &&
      host !== 'steamloopback.host' &&
      host !== '127.0.0.1' &&
      host !== 'localhost'
    ) {
      const port = window.location.port === '1420' ? '18888' : window.location.port || '18888';
      return `http://${host}:${port}${path}`;
    }
    if (window.location.port === '18888') {
      return path;
    }
  }
  return `http://127.0.0.1:18888${path}`;
}

export function emitSimpToast(message: string): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('simp-show-toast', { detail: { message } }));
  }
}

export const DEFAULT_STARTER_FYP_DESCRIPTORS: FypShelfDescriptor[] = [
  {
    shelfUid: 'local:discover:smart_stations',
    cacheKey: 'local:discover:smart_stations',
    provider: 'local',
    title: 'Local • Smart Stations',
    itemKind: 'stations',
    fetchSpec: { kind: 'local_discover', section: 'smart_stations' },
    originRoute: { sourceFilter: 'local', localSubTab: 'overview', sectionAnchor: 'local_smart_stations' },
    ttlSec: TTL_CATALOG_FEED_SEC,
  },
  {
    shelfUid: 'local:discover:rediscover_albums',
    cacheKey: 'local:discover:rediscover_albums',
    provider: 'local',
    title: 'Local • Rediscover Local Gems',
    itemKind: 'albums',
    fetchSpec: { kind: 'local_discover', section: 'rediscover_albums' },
    originRoute: { sourceFilter: 'local', localSubTab: 'overview', sectionAnchor: 'local_rediscover' },
    ttlSec: TTL_CATALOG_FEED_SEC,
  },
  {
    shelfUid: 'local:discover:recent_albums',
    cacheKey: 'local:discover:recent_albums',
    provider: 'local',
    title: 'Local • Recently Added Releases',
    itemKind: 'albums',
    fetchSpec: { kind: 'local_discover', section: 'recent_albums' },
    originRoute: { sourceFilter: 'local', localSubTab: 'overview', sectionAnchor: 'local_recent_releases' },
    ttlSec: TTL_CATALOG_FEED_SEC,
  },
  {
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
  },
  {
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
  },
  {
    shelfUid: 'soundcloud:discover:trending_tracks',
    cacheKey: 'soundcloud:discover:trending_tracks:all',
    provider: 'soundcloud',
    title: 'SoundCloud • Trending & Hot Tracks',
    itemKind: 'tracks',
    fetchSpec: { kind: 'sc_discover', section: 'trending_tracks' },
    originRoute: {
      sourceFilter: 'soundcloud',
      soundCloudSubTab: 'trending',
      scSelectedGenre: '',
      sectionAnchor: 'sc_trending_tracks',
    },
    ttlSec: TTL_FAST_FEED_SEC,
  },
  {
    shelfUid: 'ia:discover:trending:all',
    cacheKey: 'ia:discover:trending:all',
    provider: 'internet_archive',
    title: 'Internet Archive • Trending',
    itemKind: 'ia_items',
    fetchSpec: { kind: 'ia_discover', tab: 'trending', subFilter: 'all' },
    originRoute: {
      sourceFilter: 'internet_archive',
      iaSubTab: 'trending',
      iaSubFilter: 'all',
      sectionAnchor: 'ia_discover_grid',
    },
    ttlSec: TTL_ARCHIVE_SEC,
  },
];

export function mapAppleShelfToFypItems(shelf: AppleRecommendationShelf): unknown[] {
  return [
    ...(shelf.stations || []).map((st) => ({ ...st, _fypKind: 'station' as const })),
    ...(shelf.playlists || []).map((pl) => ({ ...pl, _fypKind: 'playlist' as const })),
    ...(shelf.albums || []).map((alb) => ({ ...alb, _fypKind: 'album' as const })),
  ];
}

export function inferAppleShelfItemKind(shelf: AppleRecommendationShelf): FypItemKind {
  const hasSt = (shelf.stations?.length || 0) > 0;
  const hasPl = (shelf.playlists?.length || 0) > 0;
  const hasAlb = (shelf.albums?.length || 0) > 0;
  const countKinds = Number(hasSt) + Number(hasPl) + Number(hasAlb);
  if (countKinds > 1) return 'mixed';
  if (hasSt) return 'stations';
  if (hasAlb) return 'albums';
  return 'playlists';
}

export async function fetchLocalDiscover(): Promise<LocalDiscoverResponse> {
  try {
    const resp = await fetch(resolveDaemonUrl('/api/library/local-discover'));
    const json = await resp.json();
    if (json?.ok && json.data) {
      return json.data as LocalDiscoverResponse;
    }
  } catch {
    // Ignore local discover errors when daemon is starting
  }
  return { recent_albums: [], rediscover_albums: [], smart_stations: [] };
}

export async function readProviderCachedShelves(provider: FypProvider): Promise<{
  nowUnix: number;
  byShelfId: Record<string, { data: any; stale: boolean; fetchedAt: number }>;
}> {
  try {
    const resp = await fetch(
      resolveDaemonUrl(`/api/cache/shelves?provider=${encodeURIComponent(provider)}`)
    );
    const json = await resp.json();
    if (!json?.ok || !Array.isArray(json.shelves)) {
      return { nowUnix: Math.floor(Date.now() / 1000), byShelfId: {} };
    }
    const nowUnix = typeof json.now_unix === 'number' ? json.now_unix : Math.floor(Date.now() / 1000);
    const byShelfId: Record<string, { data: any; stale: boolean; fetchedAt: number }> = {};
    for (const rec of json.shelves as CachedShelfRecord[]) {
      try {
        const parsed = JSON.parse(rec.payload_json);
        const stale = nowUnix - (rec.fetched_at || 0) > Math.max(1, rec.ttl_sec || 60);
        byShelfId[rec.shelf_id] = { data: parsed, stale, fetchedAt: rec.fetched_at };
      } catch {
        // Ignore malformed payload JSON
      }
    }
    return { nowUnix, byShelfId };
  } catch {
    return { nowUnix: Math.floor(Date.now() / 1000), byShelfId: {} };
  }
}

export async function writeCachedShelves(
  shelves: Array<{
    cacheKey: string;
    provider: FypProvider;
    shelfId: string;
    title: string;
    data: unknown;
    ttlSec: number;
  }>
): Promise<void> {
  if (shelves.length === 0) return;
  try {
    const nowUnix = Math.floor(Date.now() / 1000);
    let updatedSnapshots = false;
    const nextSnapshots = { ...fypStore.snapshots };
    for (const s of shelves) {
      if (Array.isArray(s.data)) {
        nextSnapshots[s.cacheKey] = {
          items: s.data,
          fetchedAt: nowUnix,
          ttlSec: s.ttlSec,
        };
        updatedSnapshots = true;
      }
    }
    if (updatedSnapshots) {
      fypStore.snapshots = nextSnapshots;
      notifyFypListeners();
    }
    const records: CachedShelfRecord[] = shelves.map((s) => ({
      cache_key: s.cacheKey,
      provider: s.provider,
      shelf_id: s.shelfId,
      title: s.title,
      payload_json: JSON.stringify(s.data),
      fetched_at: nowUnix,
      ttl_sec: s.ttlSec,
    }));
    await fetch(resolveDaemonUrl('/api/cache/shelves'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shelves: records }),
    });
  } catch {
    // Non-fatal cache write error
  }
}

export function cacheAppleRecentLibraryShelf(albums: unknown[]): Promise<void> {
  return writeCachedShelves([
    {
      cacheKey: 'apple:for_you:recent_library',
      provider: 'apple_music',
      shelfId: 'apple:for_you:recent_library',
      title: 'Apple Music • Recently Added Library',
      data: albums,
      ttlSec: TTL_CATALOG_FEED_SEC,
    },
  ]);
}

// =========================================================================
// Reactive Global Imp FYP Store + Throttled Max-2 Concurrent Revalidator
// =========================================================================

export interface FypStoreSnapshot {
  shelves: FypShelfRecord[];
  snapshots: Record<string, { items: unknown[]; fetchedAt: number; ttlSec: number }>;
  nowUnix: number;
  loaded: boolean;
  revalidatingKeys: string[];
}

const fypStore: FypStoreSnapshot = {
  shelves: [],
  snapshots: {},
  nowUnix: Math.floor(Date.now() / 1000),
  loaded: false,
  revalidatingKeys: [],
};

const listeners = new Set<() => void>();
let initialLoadPromise: Promise<void> | null = null;

function notifyFypListeners(): void {
  for (const l of listeners) {
    l();
  }
}

function applyFypServerPayload(payload: {
  now_unix?: number;
  shelves?: FypShelfRecord[];
  snapshots?: CachedShelfRecord[];
}): void {
  if (typeof payload.now_unix === 'number') {
    fypStore.nowUnix = payload.now_unix;
  } else {
    fypStore.nowUnix = Math.floor(Date.now() / 1000);
  }
  if (Array.isArray(payload.shelves)) {
    fypStore.shelves = payload.shelves;
  }
  if (Array.isArray(payload.snapshots)) {
    const map: FypStoreSnapshot['snapshots'] = {};
    for (const rec of payload.snapshots) {
      try {
        const parsed = JSON.parse(rec.payload_json);
        if (Array.isArray(parsed)) {
          map[rec.cache_key] = {
            items: parsed,
            fetchedAt: rec.fetched_at,
            ttlSec: rec.ttl_sec,
          };
        }
      } catch {
        // Skip invalid snapshot JSON
      }
    }
    fypStore.snapshots = map;
  }
  fypStore.loaded = true;
  notifyFypListeners();
}

export async function refreshFypFromDb(): Promise<void> {
  try {
    const resp = await fetch(resolveDaemonUrl('/api/fyp/shelves'));
    const json = await resp.json();
    if (!json?.ok) return;
    const serverShelves: FypShelfRecord[] = Array.isArray(json.shelves) ? json.shelves : [];
    const alreadySeeded =
      typeof window !== 'undefined' && window.localStorage.getItem('simp_fyp_seeded_v1') === '1';

    if (serverShelves.length === 0 && !alreadySeeded) {
      try {
        window.localStorage.setItem('simp_fyp_seeded_v1', '1');
      } catch {}
      const starterRecords: FypShelfRecord[] = DEFAULT_STARTER_FYP_DESCRIPTORS.map((d, idx) => ({
        shelf_uid: d.shelfUid,
        provider: d.provider,
        shelf_kind: d.itemKind,
        title: d.title,
        descriptor_json: JSON.stringify(d),
        sort_order: idx,
        enabled: true,
      }));
      await saveAllFypShelves(starterRecords);
      return;
    }

    applyFypServerPayload(json);
  } catch {
    fypStore.loaded = true;
    notifyFypListeners();
  }
}

export async function pinFypShelfWithSnapshot(
  descriptor: FypShelfDescriptor,
  liveItems: unknown[]
): Promise<void> {
  const nowUnix = Math.floor(Date.now() / 1000);
  const shelf: FypShelfRecord = {
    shelf_uid: descriptor.shelfUid,
    provider: descriptor.provider,
    shelf_kind: descriptor.itemKind,
    title: descriptor.title,
    descriptor_json: JSON.stringify(descriptor),
    sort_order: fypStore.shelves.length,
    enabled: true,
  };
  const snapshot: CachedShelfRecord = {
    cache_key: descriptor.cacheKey,
    provider: descriptor.provider,
    shelf_id: descriptor.shelfUid,
    title: descriptor.title,
    payload_json: JSON.stringify(liveItems),
    fetched_at: nowUnix,
    ttl_sec: descriptor.ttlSec,
  };

  // Optimistic update for zero-latency UI response
  fypStore.snapshots = {
    ...fypStore.snapshots,
    [descriptor.cacheKey]: {
      items: liveItems,
      fetchedAt: nowUnix,
      ttlSec: descriptor.ttlSec,
    },
  };
  const existingIdx = fypStore.shelves.findIndex((s) => s.shelf_uid === descriptor.shelfUid);
  if (existingIdx >= 0) {
    const next = [...fypStore.shelves];
    next[existingIdx] = { ...next[existingIdx], ...shelf, sort_order: next[existingIdx].sort_order };
    fypStore.shelves = next;
  } else {
    fypStore.shelves = [...fypStore.shelves, shelf];
  }
  notifyFypListeners();

  try {
    const resp = await fetch(resolveDaemonUrl('/api/fyp/shelves'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'pin', shelf, snapshot }),
    });
    const json = await resp.json();
    if (json?.ok) {
      applyFypServerPayload(json);
    }
  } catch {
    // Keep optimistic state if request fails transiently
  }
}

export async function unpinFypShelf(shelfUid: string): Promise<void> {
  fypStore.shelves = fypStore.shelves.filter((s) => s.shelf_uid !== shelfUid);
  notifyFypListeners();

  try {
    const resp = await fetch(resolveDaemonUrl('/api/fyp/shelves'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unpin', shelf_uid: shelfUid }),
    });
    const json = await resp.json();
    if (json?.ok) {
      applyFypServerPayload(json);
    }
  } catch {}
}

export async function saveAllFypShelves(nextShelves: FypShelfRecord[]): Promise<void> {
  fypStore.shelves = nextShelves.map((s, idx) => ({ ...s, sort_order: idx }));
  notifyFypListeners();

  try {
    const resp = await fetch(resolveDaemonUrl('/api/fyp/shelves'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save_all', shelves: fypStore.shelves }),
    });
    const json = await resp.json();
    if (json?.ok) {
      applyFypServerPayload(json);
    }
  } catch {}
}

// Viewport-lazy background revalidation throttled to max 2 concurrent network refreshes
const MAX_CONCURRENT_REVALIDATIONS = 2;
const inFlightCacheKeys = new Set<string>();
const pendingQueue: Array<() => Promise<void>> = [];
let activeRevalidations = 0;

function pumpRevalidationQueue(): void {
  while (activeRevalidations < MAX_CONCURRENT_REVALIDATIONS && pendingQueue.length > 0) {
    const job = pendingQueue.shift();
    if (!job) continue;
    activeRevalidations += 1;
    job().finally(() => {
      activeRevalidations = Math.max(0, activeRevalidations - 1);
      pumpRevalidationQueue();
    });
  }
}

async function fetchLiveItemsForSpec(spec: FypFetchSpec): Promise<unknown[] | null> {
  switch (spec.kind) {
    case 'local_discover': {
      const data = await fetchLocalDiscover();
      return spec.section === 'smart_stations'
        ? data.smart_stations
        : spec.section === 'rediscover_albums'
          ? data.rediscover_albums
          : data.recent_albums;
    }
    case 'apple_for_you': {
      if (spec.section === 'recent_library') {
        return (await fetchAppleLibraryRecentlyAdded()) || [];
      }
      const res = await fetchAppleRadioAndForYou();
      if (spec.section === 'personal_stations') return res.personal_stations || [];
      if (spec.section === 'new_releases') return res.new_releases || [];
      if (spec.section === 'recently_played') return res.recently_played || [];
      if (spec.section === 'for_you_playlists') return res.playlists || [];
      if (spec.section === 'for_you_albums') return res.albums || [];
      if (spec.section === 'shelf' && spec.shelfId) {
        const shelf = (res.shelves || []).find((s) => s.id === spec.shelfId);
        return shelf ? mapAppleShelfToFypItems(shelf) : [];
      }
      return null;
    }
    case 'apple_new': {
      const res = await fetchAppleNewFeed();
      if (spec.section === 'recent_releases') return res.recent_releases || [];
      if (spec.section === 'albums') return res.albums || [];
      if (spec.section === 'playlists') return res.playlists || [];
      return res.songs || [];
    }
    case 'apple_radio': {
      const res = await fetchAppleRadioAndForYou();
      if (spec.section === 'live') return res.live_stations || res.stations || [];
      if (spec.section === 'shows') return res.artist_shows || [];
      if (spec.section === 'mixes') return res.club_mixes || [];
      return res.genre_stations || [];
    }
    case 'sc_discover': {
      const res = await fetchSoundCloudDiscover(spec.genre || undefined);
      if (spec.section === 'more_of_what_you_like') return res.more_of_what_you_like || [];
      if (spec.section === 'recommended_artists') return res.recommended_artists || [];
      if (spec.section === 'fresh_uploads') return res.fresh_uploads || [];
      if (spec.section === 'featured_sets') return res.playlists || [];
      if (spec.section === 'dj_mixes') return res.mixes || [];
      return res.tracks || [];
    }
    case 'sc_stream': {
      const res = await fetchSoundCloudStreamAndRadio();
      return spec.section === 'stream_sets' ? res.streamPlaylists || [] : res.streamTracks || [];
    }
    case 'sc_likes': {
      if (spec.section === 'followings') {
        return await fetchSoundCloudFollowings();
      }
      const res = await fetchSoundCloudLikesAndPlaylists();
      return spec.section === 'sets' ? res.playlists || [] : res.likedTracks || [];
    }
    case 'ia_discover': {
      const resp = await fetch(
        resolveDaemonUrl(
          `/api/ia/discover?hub=${encodeURIComponent(spec.tab)}&sub=${encodeURIComponent(
            spec.subFilter || 'all'
          )}&page=1`
        )
      );
      const d = await resp.json();
      if (!d?.ok) return null;
      return Array.isArray(d.items) ? d.items : Array.isArray(d.data) ? d.data : [];
    }
    case 'artist_section': {
      if (spec.artistSource === 'soundcloud') {
        const resp = await fetch(
          resolveDaemonUrl(`/api/soundcloud/user-tracks?id=${encodeURIComponent(spec.idOrName)}`)
        );
        const j = await resp.json();
        const data = j?.data;
        if (!j?.ok || !data) return null;
        return spec.section === 'top_tracks'
          ? data.tracks || []
          : spec.section === 'albums'
            ? data.playlists || []
            : spec.section === 'singles_or_sets'
              ? data.liked_tracks || []
              : data.followings || [];
      }
      if (spec.artistSource === 'apple_music') {
        const resp = await fetch(
          resolveDaemonUrl(`/api/apple/artist?id=${encodeURIComponent(spec.idOrName)}`)
        );
        const j = await resp.json();
        const data = j?.data;
        if (!j?.ok || !data) return null;
        return spec.section === 'top_tracks'
          ? data.top_tracks || []
          : spec.section === 'albums'
            ? data.albums || []
            : spec.section === 'singles_or_sets'
              ? data.singles || []
              : data.related_artists || [];
      }
      const cleanName = spec.idOrName.startsWith('name:')
        ? spec.idOrName.slice(5)
        : spec.displayName || spec.idOrName;
      const resp = await fetch(
        resolveDaemonUrl(`/api/local/artist?name=${encodeURIComponent(cleanName)}`)
      );
      const j = await resp.json();
      const data = j?.data;
      if (!j?.ok || !data) return null;
      return spec.section === 'top_tracks' ? data.tracks || [] : data.albums || [];
    }
  }
}

export function queueFypRevalidation(descriptor: FypShelfDescriptor, force = false): void {
  const existing = fypStore.snapshots[descriptor.cacheKey];
  const nowSec = Math.floor(Date.now() / 1000);
  if (!force && existing && nowSec - existing.fetchedAt <= Math.max(1, descriptor.ttlSec)) {
    return;
  }
  if (inFlightCacheKeys.has(descriptor.cacheKey)) {
    return;
  }
  inFlightCacheKeys.add(descriptor.cacheKey);
  fypStore.revalidatingKeys = Array.from(inFlightCacheKeys);
  notifyFypListeners();

  pendingQueue.push(async () => {
    try {
      const items = await fetchLiveItemsForSpec(descriptor.fetchSpec);
      if (Array.isArray(items)) {
        const fetchedAt = Math.floor(Date.now() / 1000);
        fypStore.snapshots = {
          ...fypStore.snapshots,
          [descriptor.cacheKey]: {
            items,
            fetchedAt,
            ttlSec: descriptor.ttlSec,
          },
        };
        if (typeof window !== 'undefined') {
          window.dispatchEvent(
            new CustomEvent('simp-fyp-shelf-updated', {
              detail: { cacheKey: descriptor.cacheKey, items },
            })
          );
        }
        await writeCachedShelves([
          {
            cacheKey: descriptor.cacheKey,
            provider: descriptor.provider,
            shelfId: descriptor.shelfUid,
            title: descriptor.title,
            data: items,
            ttlSec: descriptor.ttlSec,
          },
        ]);
      }
    } catch {
      // Preserve last-known cached items on transient network error
    } finally {
      inFlightCacheKeys.delete(descriptor.cacheKey);
      fypStore.revalidatingKeys = Array.from(inFlightCacheKeys);
      notifyFypListeners();
    }
  });
  pumpRevalidationQueue();
}

export function useFypShelves(): FypStoreSnapshot & {
  pinShelfWithSnapshot: (descriptor: FypShelfDescriptor, liveItems: unknown[]) => Promise<void>;
  unpinShelf: (shelfUid: string) => Promise<void>;
  saveAllShelves: (nextShelves: FypShelfRecord[]) => Promise<void>;
  refreshFypFromDb: () => Promise<void>;
  restoreDefaultShelves: () => Promise<void>;
} {
  const [, setTick] = useState(0);

  useEffect(() => {
    const onChange = () => setTick((t) => t + 1);
    listeners.add(onChange);
    if (!initialLoadPromise) {
      initialLoadPromise = refreshFypFromDb();
    }
    return () => {
      listeners.delete(onChange);
    };
  }, []);

  const restoreDefaultShelves = async () => {
    const existingMap = new Map(fypStore.shelves.map((s) => [s.shelf_uid, s]));
    const merged: FypShelfRecord[] = [...fypStore.shelves];
    for (const d of DEFAULT_STARTER_FYP_DESCRIPTORS) {
      if (!existingMap.has(d.shelfUid)) {
        merged.push({
          shelf_uid: d.shelfUid,
          provider: d.provider,
          shelf_kind: d.itemKind,
          title: d.title,
          descriptor_json: JSON.stringify(d),
          sort_order: merged.length,
          enabled: true,
        });
      }
    }
    await saveAllFypShelves(merged);
  };

  return {
    ...fypStore,
    pinShelfWithSnapshot: pinFypShelfWithSnapshot,
    unpinShelf: unpinFypShelf,
    saveAllShelves: saveAllFypShelves,
    refreshFypFromDb,
    restoreDefaultShelves,
  };
}

// Re-export imported helper functions so App/Discover consumers share one type module cleanly
export type {
  AppleCloudAlbumSummary,
  AppleCloudPlaylistSummary,
  AppleRadioStationSummary,
  AppleRecommendationShelf,
  ArchiveItemSummary,
  SoundCloudPlaylistSummary,
  SoundCloudUserSummary,
};
export { fetchAppleCloudPlaylists };
