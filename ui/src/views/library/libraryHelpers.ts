import React from 'react';
import { PlaylistRecord } from '@simp/client';

export const CLOUD_PAGE_SIZE = 50;

export type BrowseHubTarget =
  | 'imp_fyp'
  | 'imp_library'
  | 'local_discover'
  | 'apple_discover'
  | 'soundcloud_discover'
  | 'ia_discover'
  | 'mount';

export type LocalSubTab = 'overview' | 'artists' | 'albums' | 'folders' | 'videos';
export type LocalArtworkFilter = 'all' | 'has_art' | 'missing_art';
export type LocalLyricsFilter = 'all' | 'synced' | 'has_lyrics' | 'missing_lyrics';

export function normalizeParentFolderPath(raw?: string | null): string {
  if (!raw) return '';
  const norm = raw.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
  return norm === '/' ? '' : norm;
}

export function decadeFromYear(year?: number | null): string | null {
  if (!year || year < 1000 || year > 2100) return null;
  const dec = Math.floor(year / 10) * 10;
  return `${dec}s`;
}

export type AlphaBucket = 'all' | 'num' | 'a_f' | 'g_l' | 'm_r' | 's_z';

export function matchesAlphaBucket(name: string, bucket: AlphaBucket): boolean {
  if (bucket === 'all') return true;
  const cleaned = name.replace(/^[\s🍎☁️📌🎵💿]+/u, '').trim();
  const first = (cleaned[0] || '').toUpperCase();
  if (!first || first < 'A' || first > 'Z') {
    return bucket === 'num';
  }
  if (bucket === 'a_f') return first >= 'A' && first <= 'F';
  if (bucket === 'g_l') return first >= 'G' && first <= 'L';
  if (bucket === 'm_r') return first >= 'M' && first <= 'R';
  if (bucket === 's_z') return first >= 'S' && first <= 'Z';
  return true;
}

export const iaItemCountCache = new Map<string, number>();
export const iaItemCountPending = new Set<string>();
export const iaItemRatingCache = new Map<string, string>();

export interface FormattedContentRating {
  label: string;
  title: string;
  tone: 'explicit' | 'clean' | 'mature' | 'film' | 'stars';
}

export function formatContentRatingBadge(raw?: string | null): FormattedContentRating | null {
  const cleaned = (raw || '').trim();
  if (!cleaned) return null;
  const upper = cleaned.toUpperCase();
  if (upper === 'EXPLICIT' || upper === 'E') {
    return { label: 'E', title: 'Explicit Content', tone: 'explicit' };
  }
  if (upper === 'CLEAN') {
    return { label: 'CLEAN', title: 'Clean Edition', tone: 'clean' };
  }
  if (upper === 'R' || upper === 'NC-17' || upper === 'X' || upper === 'TV-MA' || upper === '18+') {
    return { label: upper, title: `Content Rating: ${upper}`, tone: 'mature' };
  }
  if (upper.startsWith('★')) {
    return {
      label: upper,
      title: `Internet Archive Community Rating (${upper})`,
      tone: 'stars',
    };
  }
  return { label: upper, title: `Content Rating: ${upper}`, tone: 'film' };
}

export function extractAudioFormat(uri?: string | null): string | null {
  if (!uri || !uri.startsWith('file://')) return null;
  const m = uri.match(/\.([a-zA-Z0-9]{2,5})(?:$|[?#])/);
  if (!m) return null;
  const ext = m[1].toUpperCase();
  if (
    ext === 'FLAC' ||
    ext === 'MP3' ||
    ext === 'WAV' ||
    ext === 'OGG' ||
    ext === 'OPUS' ||
    ext === 'M4A' ||
    ext === 'AAC' ||
    ext === 'ALAC' ||
    ext === 'AIFF'
  ) {
    return ext;
  }
  return null;
}

const CODEC_TOKEN = '(?:FLAC|MP3|WAV|OGG|OPUS|M4A|AAC|ALAC|AIFF)';
const ALBUM_FORMAT_SUFFIX_RE = new RegExp(
  `\\s*•\\s*(${CODEC_TOKEN}(?:\\s*\\+\\s*${CODEC_TOKEN})*)$`,
  'i'
);

export function stripAlbumFormatSuffix(raw: string): string {
  return raw.replace(ALBUM_FORMAT_SUFFIX_RE, '').trim();
}

export function extractAlbumFormatBadge(raw: string): string | null {
  const m = raw.match(ALBUM_FORMAT_SUFFIX_RE);
  return m ? m[1].toUpperCase() : null;
}

export function cleanCollectionTitle(raw: string): string {
  return raw.replace(/^[\s📌💾🍎☁️🏛️🎵💿]+/u, '').trim() || raw;
}

export function formatPlaylistSourceBadge(pl: PlaylistRecord): string {
  if (pl.origin === 'local_pinned') {
    return '💾';
  }
  if (pl.origin === 'soundcloud_remote') {
    return '☁️';
  }
  if (pl.origin === 'archive_remote') {
    return '🏛️';
  }
  if (pl.origin !== 'simp_local') {
    return '🍎';
  }
  const parts: string[] = [];
  if (pl.has_local) parts.push('💾');
  if (pl.has_apple) parts.push('🍎');
  if (pl.has_soundcloud) parts.push('☁️');
  if (pl.has_archive) parts.push('🏛️');
  if (parts.length > 0) {
    return parts.join(' + ');
  }
  return '★ IMP';
}

// Fixed-proportion tile grid style (3+ cols at 800p, fills cleanly across 1080p/UW/5K/8K without stretching)
export const tileGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, var(--imp-tile-width, 184px))',
  justifyContent: 'start',
  gap: 10,
  width: '100%',
  minWidth: 0,
};

let cachedSyncedLyricsUris = new Set<string>();
let cachedAllLyricsUris = new Set<string>();
let lastLyricsStatusFetchMs = 0;
let pendingLyricsStatusPromise: Promise<void> | null = null;
const lyricsStatusListeners = new Set<() => void>();

export function refreshLibraryLyricsStatus(force = false): Promise<void> {
  const now = Date.now();
  if (!force && now - lastLyricsStatusFetchMs < 8_000 && cachedAllLyricsUris.size > 0) {
    return Promise.resolve();
  }
  if (pendingLyricsStatusPromise) {
    return pendingLyricsStatusPromise;
  }
  lastLyricsStatusFetchMs = now;
  pendingLyricsStatusPromise = fetch('http://127.0.0.1:18888/api/library/lyrics-status')
    .then((r) => r.json())
    .then((json) => {
      if (json?.ok) {
        cachedSyncedLyricsUris = new Set(Array.isArray(json.synced_uris) ? json.synced_uris : []);
        cachedAllLyricsUris = new Set(
          Array.isArray(json.all_lyrics_uris) ? json.all_lyrics_uris : []
        );
        lyricsStatusListeners.forEach((cb) => cb());
      }
    })
    .catch(() => {})
    .finally(() => {
      pendingLyricsStatusPromise = null;
    });
  return pendingLyricsStatusPromise;
}

export function getTrackLyricsBadge(uri?: string | null): 'LRC' | 'LYR' | null {
  if (!uri) return null;
  if (cachedSyncedLyricsUris.has(uri)) return 'LRC';
  if (cachedAllLyricsUris.has(uri)) return 'LYR';
  return null;
}

export function markTrackLyricsStatus(uri: string, hasSynced: boolean): void {
  if (!uri) return;
  const hadAll = cachedAllLyricsUris.has(uri);
  const hadSynced = cachedSyncedLyricsUris.has(uri);
  cachedAllLyricsUris.add(uri);
  if (hasSynced) {
    cachedSyncedLyricsUris.add(uri);
  }
  if (!hadAll || (hasSynced && !hadSynced)) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('simp-lyrics-badge-updated', { detail: { uri, hasSynced } })
      );
    } else {
      lyricsStatusListeners.forEach((cb) => cb());
    }
  }
}

export function useLibraryLyricsStatus(): {
  syncedUris: Set<string>;
  allLyricsUris: Set<string>;
  refresh: () => void;
} {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    lyricsStatusListeners.add(listener);
    refreshLibraryLyricsStatus(false);
    const onBadgeUpdated = () => {
      setTick((t) => t + 1);
    };
    const onPropsUpdated = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{
          uri?: string;
          hasSynced?: boolean;
          properties?: unknown;
          lyrics?: { found?: boolean; synced_lines?: unknown[] };
        }>
      ).detail;
      if (detail?.uri && detail?.lyrics?.found) {
        markTrackLyricsStatus(
          detail.uri,
          Array.isArray(detail.lyrics.synced_lines) && detail.lyrics.synced_lines.length > 0
        );
      }
      if (detail?.properties !== undefined || detail?.lyrics !== undefined) {
        refreshLibraryLyricsStatus(true);
      }
    };
    window.addEventListener('simp-lyrics-badge-updated', onBadgeUpdated);
    window.addEventListener('simp-track-properties-updated', onPropsUpdated);
    return () => {
      lyricsStatusListeners.delete(listener);
      window.removeEventListener('simp-lyrics-badge-updated', onBadgeUpdated);
      window.removeEventListener('simp-track-properties-updated', onPropsUpdated);
    };
  }, []);
  return {
    syncedUris: cachedSyncedLyricsUris,
    allLyricsUris: cachedAllLyricsUris,
    refresh: () => refreshLibraryLyricsStatus(true),
  };
}

const COLLAPSED_SECTIONS_STORAGE_KEY = 'simp_collapsed_sections_v1';
let collapsedSectionsLoaded = false;
const collapsedSectionKeys = new Set<string>();
const collapsedSectionListeners = new Set<() => void>();

function ensureCollapsedSectionsLoaded(): void {
  if (collapsedSectionsLoaded) return;
  collapsedSectionsLoaded = true;
  if (typeof window === 'undefined') return;
  try {
    const raw = window.localStorage.getItem(COLLAPSED_SECTIONS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        for (const k of parsed) {
          if (typeof k === 'string' && k) {
            collapsedSectionKeys.add(k);
          }
        }
      }
    }
  } catch {
    // ignore storage errors
  }
}

function persistCollapsedSections(): void {
  if (typeof window !== 'undefined') {
    try {
      window.localStorage.setItem(
        COLLAPSED_SECTIONS_STORAGE_KEY,
        JSON.stringify(Array.from(collapsedSectionKeys))
      );
    } catch {
      // ignore
    }
  }
  collapsedSectionListeners.forEach((cb) => cb());
}

export function isSectionCollapsed(sectionKey: string): boolean {
  ensureCollapsedSectionsLoaded();
  return collapsedSectionKeys.has(sectionKey);
}

export function setSectionCollapsed(sectionKey: string, collapsed: boolean): void {
  if (!sectionKey) return;
  ensureCollapsedSectionsLoaded();
  const had = collapsedSectionKeys.has(sectionKey);
  if (collapsed && !had) {
    collapsedSectionKeys.add(sectionKey);
    persistCollapsedSections();
  } else if (!collapsed && had) {
    collapsedSectionKeys.delete(sectionKey);
    persistCollapsedSections();
  }
}

export function toggleSectionCollapsed(sectionKey: string): boolean {
  if (!sectionKey) return false;
  ensureCollapsedSectionsLoaded();
  const nextCollapsed = !collapsedSectionKeys.has(sectionKey);
  setSectionCollapsed(sectionKey, nextCollapsed);
  return nextCollapsed;
}

export function useCollapsedSections(): {
  isCollapsed: (sectionKey: string) => boolean;
  toggle: (sectionKey: string) => boolean;
  setCollapsed: (sectionKey: string, collapsed: boolean) => void;
} {
  ensureCollapsedSectionsLoaded();
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const listener = () => setTick((t) => t + 1);
    collapsedSectionListeners.add(listener);
    return () => {
      collapsedSectionListeners.delete(listener);
    };
  }, []);
  return {
    isCollapsed: (key: string) => collapsedSectionKeys.has(key),
    toggle: (key: string) => toggleSectionCollapsed(key),
    setCollapsed: (key: string, collapsed: boolean) => setSectionCollapsed(key, collapsed),
  };
}
