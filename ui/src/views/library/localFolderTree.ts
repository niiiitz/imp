import { AlbumRecord, TrackMetadata } from '@simp/client';
import { normalizeParentFolderPath } from './libraryHelpers';

export interface LocalSubfolderSummary {
  name: string;
  fullRelPath: string;
  trackCount: number;
  albumCount: number;
  artUrls: string[];
}

export interface LocalFolderDrillData {
  curPrefix: string;
  breadcrumbs: string[];
  subfolders: LocalSubfolderSummary[];
  directTracks: TrackMetadata[];
  subtreeTracks: TrackMetadata[];
  albumsHere: AlbumRecord[];
}

/** Returns the parent relative folder path (`"a/b/c"` -> `"a/b"`, `"a"` -> `""`). */
export function parentFolderPath(curPrefix: string): string {
  const norm = normalizeParentFolderPath(curPrefix);
  if (!norm) return '';
  const parts = norm.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

/** Normalizes paths across POSIX, Windows drive letters, and WSL `/mnt/<drive>/...`. */
function normalizeFsPathForSubpath(raw: string): { norm: string; rawClean: string } {
  let p = raw.trim().replace(/^["']+|["']+$/g, '').replace(/\\/g, '/').replace(/\/+$/, '');
  const winDrive = p.match(/^([a-zA-Z]):\/(.*)$/);
  if (winDrive) {
    p = `/mnt/${winDrive[1].toLowerCase()}/${winDrive[2]}`;
  }
  const caseFold = p.startsWith('/mnt/') || /^[a-zA-Z]:/.test(raw.trim());
  return { norm: caseFold ? p.toLowerCase() : p, rawClean: p };
}

/** Computes the relative subfolder path inside `mountRoot` when `targetPath` sits under it. */
export function computeRelativeSubpath(mountRoot: string, targetPath: string): string {
  const root = normalizeFsPathForSubpath(mountRoot);
  const cand = normalizeFsPathForSubpath(targetPath);
  if (!root.norm || !cand.norm || cand.norm === root.norm) return '';
  if (root.norm === '/') {
    return cand.rawClean.replace(/^\/+/, '');
  }
  const prefix = `${root.norm}/`;
  if (!cand.norm.startsWith(prefix)) return '';
  return cand.rawClean.slice(prefix.length).replace(/^\/+|\/+$/g, '');
}

/** Computes immediate subfolders, breadcrumbs, direct tracks, and albums at `localFolderPath`. */
export function buildLocalFolderDrillData(params: {
  mountRoot: string | null | undefined;
  allLocalTracks: TrackMetadata[];
  mountTracks: TrackMetadata[];
  localFolderPath: string;
  filteredAlbumsList?: AlbumRecord[];
  trackFilter?: (t: TrackMetadata) => boolean;
}): LocalFolderDrillData {
  const {
    mountRoot,
    allLocalTracks,
    mountTracks,
    localFolderPath,
    filteredAlbumsList = [],
    trackFilter,
  } = params;

  if (!mountRoot) {
    return {
      curPrefix: '',
      breadcrumbs: [],
      subfolders: [],
      directTracks: [],
      subtreeTracks: [],
      albumsHere: [],
    };
  }

  const sourceTracks =
    allLocalTracks.length > 0
      ? allLocalTracks.filter((t) => t.mount_root === mountRoot)
      : mountTracks;
  const scopedTracks = trackFilter ? sourceTracks.filter(trackFilter) : sourceTracks;
  const curPrefix = normalizeParentFolderPath(localFolderPath);
  const breadcrumbs = curPrefix ? curPrefix.split('/').filter(Boolean) : [];

  const childMap = new Map<
    string,
    {
      name: string;
      fullRelPath: string;
      tracks: number;
      albumIds: Set<string>;
      artUrls: string[];
    }
  >();
  const directTracks: TrackMetadata[] = [];
  const subtreeTracks: TrackMetadata[] = [];
  const directAlbumIds = new Set<string>();

  for (const t of scopedTracks) {
    const rel = normalizeParentFolderPath(t.parent_folder);
    if (rel === curPrefix) {
      directTracks.push(t);
      subtreeTracks.push(t);
      if (t.album_id) directAlbumIds.add(t.album_id);
      continue;
    }
    const isChild = curPrefix === '' ? rel.length > 0 : rel.startsWith(`${curPrefix}/`);
    if (!isChild) continue;
    subtreeTracks.push(t);
    const remainder = curPrefix === '' ? rel : rel.slice(curPrefix.length + 1);
    const seg = remainder.split('/')[0];
    if (!seg) continue;
    const fullRelPath = curPrefix ? `${curPrefix}/${seg}` : seg;
    let entry = childMap.get(seg);
    if (!entry) {
      entry = {
        name: seg,
        fullRelPath,
        tracks: 0,
        albumIds: new Set<string>(),
        artUrls: [],
      };
      childMap.set(seg, entry);
    }
    entry.tracks += 1;
    if (t.album_id) entry.albumIds.add(t.album_id);
    if (t.art_url && entry.artUrls.length < 4 && !entry.artUrls.includes(t.art_url)) {
      entry.artUrls.push(t.art_url);
    }
  }

  const subfolders = Array.from(childMap.values())
    .map((s) => ({
      name: s.name,
      fullRelPath: s.fullRelPath,
      trackCount: s.tracks,
      albumCount: s.albumIds.size,
      artUrls: s.artUrls,
    }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const albumsHere =
    filteredAlbumsList.length > 0
      ? filteredAlbumsList.filter((alb) => directAlbumIds.has(alb.id))
      : [];

  return {
    curPrefix,
    breadcrumbs,
    subfolders,
    directTracks,
    subtreeTracks,
    albumsHere,
  };
}

/** Fast O(n) check for whether `folderPath` inside `mountRoot` has nested child folders. */
export function hasSubfoldersAtPath(params: {
  mountRoot: string | null | undefined;
  allLocalTracks: TrackMetadata[];
  mountTracks: TrackMetadata[];
  folderPath: string;
}): boolean {
  const { mountRoot, allLocalTracks, mountTracks, folderPath } = params;
  if (!mountRoot) return false;
  const sourceTracks =
    allLocalTracks.length > 0
      ? allLocalTracks.filter((t) => t.mount_root === mountRoot)
      : mountTracks;
  const normTarget = normalizeParentFolderPath(folderPath);
  const childPrefix = normTarget === '' ? '' : `${normTarget}/`;
  for (const t of sourceTracks) {
    const rel = normalizeParentFolderPath(t.parent_folder);
    if (normTarget === '' ? rel.length > 0 : rel.startsWith(childPrefix)) {
      return true;
    }
  }
  return false;
}
