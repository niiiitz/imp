import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlbumRecord,
  AppleMusicAuthConfig,
  defaultSimpClient,
  OpticalDiscStatus,
  PlaylistRecord,
  SimpStateSnapshot,
  SoundCloudAuthConfig,
  TrackMetadata,
} from '@imp/client';
import { CompanionPairView } from './components/CompanionPairView';
import {
  clearFypProviderAuthErrorsAndRevalidate,
  deleteDaemonUiPrefs,
  ExpiredAuthProvider,
  fetchDaemonUiPrefs,
  quitNativeAppWindow,
  resolveDaemonUrl,
  saveDaemonUiPrefs,
  toggleAppFullscreen,
} from './api/servicesCacheApi';
import { saveStatsHudEnabled } from './components/StatsHudPill';
import type { BrowseHubTarget } from './views/library/libraryHelpers';
import { computeRelativeSubpath } from './views/library/localFolderTree';
import {
  addAppleItemToCloudLibrary,
  AppleCatalogSearchResults,
  AppleCloudAlbumSummary,
  AppleCloudPlaylistSummary,
  AppleMusicDriver,
  AppleRadioStationSummary,
  AppleRecommendationShelf,
  fetchAppleCloudPlaylists,
  fetchAppleNewFeed,
  fetchApplePlaylistTracks,
  fetchAppleRadioAndForYou,
  fetchFullAppleAlbum,
  pinAppleAlbumToSimp,
  pinApplePlaylistToSimp,
  searchAppleMusicCatalog,
  setAppleItemFavorited,
} from './drivers/AppleMusicDriver';
import {
  fetchSoundCloudDiscover,
  fetchSoundCloudLikesAndPlaylists,
  fetchSoundCloudPlaylistTracks,
  fetchSoundCloudStreamAndRadio,
  likeSoundCloudTrack,
  pinSoundCloudPlaylistToSimp,
  searchSoundCloudCatalog,
  setSoundCloudPlaylistLiked,
  SoundCloudCatalogSearchResults,
  SoundCloudPlaylistSummary,
  SoundCloudUserSummary,
  startSoundCloudTrackRadio,
  unlikeSoundCloudTrack,
} from './drivers/SoundCloudDriver';
import { OskTargetKind, useGamepadNavigation } from './hooks/useGamepadNavigation';
import { BrowserTarget, isUiVideoTrack, PlayerView } from './views/PlayerView';
import { LibraryBrowserView } from './views/LibraryBrowserView';
import { XmbUnifiedMenu } from './components/XmbUnifiedMenu';
import type { SimpUpdateStatus, SourceVisibilityPrefs } from './menu/menuCorpus';
import { QuickHelpModal } from './components/QuickHelpModal';
import { TrackPropertiesModal, TrackPropertiesTarget } from './components/TrackPropertiesModal';
import { ImpIcon } from './components/icons/ImpIcon';
import { AppTopHeaderBar } from './components/AppTopHeaderBar';
import { HybridPlaylistPickerModal } from './components/HybridPlaylistPickerModal';
import { FolderDropModal } from './components/FolderDropModal';
import { AppOnScreenKeyboardBar } from './components/AppOnScreenKeyboardBar';
import { applySkinPackToDocument, loadActiveSkinPackId } from './theme/skinPacks';
import { applyUiScaleToDocument } from './theme/uiScale';
import {
  readProviderCachedShelves,
  refreshFypFromDb,
  TTL_CATALOG_FEED_SEC,
  TTL_FAST_FEED_SEC,
  writeCachedShelves,
} from './api/servicesCacheApi';

const isCompanionPairRoute =
  typeof window !== 'undefined' &&
  (window.location.pathname.startsWith('/pair') ||
    new URLSearchParams(window.location.search).get('pair') === '1');

const isDedicatedAppleWorkerRoute =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('worker') === 'apple';

const DedicatedAppleWorkerApp: React.FC = () => {
  useEffect(() => {
    document.title = 'Imp Headless Audio Worker';
    defaultSimpClient.connect();
  }, []);
  return <AppleMusicDriver />;
};

export const App: React.FC = () => {
  useEffect(() => {
    applySkinPackToDocument(loadActiveSkinPackId());
    applyUiScaleToDocument();
    const onResize = () => applyUiScaleToDocument();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  if (isDedicatedAppleWorkerRoute) {
    return <DedicatedAppleWorkerApp />;
  }
  if (isCompanionPairRoute) {
    return <CompanionPairView />;
  }
  return <ConsoleMainApp />;
};

const ConsoleMainApp: React.FC = () => {
  const isDeckyEmbedded = typeof window !== 'undefined' && window.parent !== window;
  const [snap, setSnap] = useState<SimpStateSnapshot | null>(null);
  const snapRef = useRef<SimpStateSnapshot | null>(null);
  snapRef.current = snap;
  const [desktopModeRaw, setDesktopModeRaw] = useState<boolean>(() => {
    if (isDeckyEmbedded) return false;
    try {
      return window.localStorage.getItem('simp_desktop_mode') === '1';
    } catch {
      return false;
    }
  });
  const desktopMode = !isDeckyEmbedded && desktopModeRaw;
  const [desktopVizIdleSec, setDesktopVizIdleSecState] = useState<number>(() => {
    try {
      const raw = window.localStorage.getItem('simp_desktop_viz_idle_sec');
      if (raw === null) return 30;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : 30;
    } catch {
      return 30;
    }
  });
  const [desktopScreensaverActive, setDesktopScreensaverActive] = useState<boolean>(false);
  const screensaverPointerGraceUntilRef = useRef<number>(0);
  const [view, setViewState] = useState<'lock' | 'browser'>(() =>
    desktopMode ? 'browser' : 'lock'
  );
  const setView: React.Dispatch<React.SetStateAction<'lock' | 'browser'>> = useCallback(
    (action) => {
      setViewState((prev) => {
        const resolved = typeof action === 'function' ? action(prev) : action;
        if (resolved === 'browser') {
          setDesktopScreensaverActive(false);
        }
        if (
          desktopMode &&
          resolved === 'lock' &&
          !isUiVideoTrack(snapRef.current?.current_track)
        ) {
          return 'browser';
        }
        return resolved;
      });
    },
    [desktopMode]
  );
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [powerModalOpen, setPowerModalOpen] = useState(false);
  const [initialOpenFoldersAccounts, setInitialOpenFoldersAccounts] = useState(false);
  const [quickHelpOpen, setQuickHelpOpen] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem('simp_oobe_help_seen_v1') !== '1';
    } catch {
      return false;
    }
  });
  const [isSleeping, setIsSleeping] = useState(false);
  const [confirmHardReset, setConfirmHardReset] = useState(false);

  // Library & Playlist Browser state
  const [albums, setAlbums] = useState<AlbumRecord[]>([]);
  const [playlists, setPlaylists] = useState<PlaylistRecord[]>([]);
  const [browserSourceFilter, setBrowserSourceFilterState] = useState<
    'all' | 'local' | 'apple_music' | 'soundcloud' | 'internet_archive'
  >('all');
  const [selectedSources, setSelectedSources] = useState<
    Array<'local' | 'apple_music' | 'soundcloud' | 'internet_archive'>
  >([]);
  const [browseHubTarget, setBrowseHubTargetState] = useState<BrowseHubTarget>(() => {
    try {
      const saved = window.localStorage.getItem('simp_imp_fyp_active');
      return saved === '0' ? 'imp_library' : 'imp_fyp';
    } catch {
      return 'imp_fyp';
    }
  });
  const setBrowseHubTarget: React.Dispatch<React.SetStateAction<BrowseHubTarget>> = useCallback((action) => {
    setBrowseHubTargetState((prev) => {
      const next = typeof action === 'function' ? action(prev) : action;
      try {
        window.localStorage.setItem('simp_imp_fyp_active', next === 'imp_fyp' ? '1' : '0');
      } catch { }
      return next;
    });
  }, []);
  const setBrowserSourceFilter: React.Dispatch<
    React.SetStateAction<'all' | 'local' | 'apple_music' | 'soundcloud' | 'internet_archive'>
  > = useCallback((action) => {
    setBrowserSourceFilterState((prev) => {
      const next = typeof action === 'function' ? action(prev) : action;
      setSelectedSources(next === 'all' ? [] : [next]);
      return next;
    });
  }, []);
  const [browserSearch, setBrowserSearch] = useState('');
  const [searchPreferredSource, setSearchPreferredSource] = useState<
    'local' | 'apple_music' | 'soundcloud' | 'internet_archive' | null
  >(null);
  const [browserTarget, setBrowserTarget] = useState<BrowserTarget | null>(null);
  const [browserTracks, setBrowserTracks] = useState<TrackMetadata[]>([]);

  // Optical CD-ROM (`cdda://`) drive status (scanned only on-demand / when CD source is in view & awake)
  const [opticalDisc, setOpticalDisc] = useState<OpticalDiscStatus | null>(null);
  const [cdScanning, setCdScanning] = useState(false);

  // Source Visibility preferences (Show / Hide Internet Archive, Apple Music, SoundCloud, Optical Drive)
  const [sourceVisibility, setSourceVisibility] = useState<SourceVisibilityPrefs>(() => {
    try {
      const raw = window.localStorage.getItem('simp_source_visibility_v2');
      if (raw) {
        const parsed = JSON.parse(raw);
        return {
          internet_archive: parsed.internet_archive !== false,
          apple_music: parsed.apple_music !== false,
          soundcloud: parsed.soundcloud !== false,
          optical_drive: parsed.optical_drive === true,
        };
      }
    } catch {
      // Ignore storage access errors
    }
    return {
      internet_archive: true,
      apple_music: true,
      soundcloud: true,
      optical_drive: false,
    };
  });

  useEffect(() => {
    try {
      window.localStorage.setItem('simp_source_visibility_v2', JSON.stringify(sourceVisibility));
    } catch {
      // Ignore storage access errors
    }
  }, [sourceVisibility]);

  // Recently Played history (`simp_recently_played_v1` + SQLite `/api/history`, max 40 items)
  const [recentlyPlayed, setRecentlyPlayed] = useState<TrackMetadata[]>(() => {
    try {
      const raw = window.localStorage.getItem('simp_recently_played_v1');
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.slice(0, 40);
      }
    } catch {
      // Ignore storage access errors
    }
    return [];
  });
  const [favoritedUris, setFavoritedUris] = useState<string[]>([]);

  // Hydrate persistent SQLite `play_history` and `local_favorites` on mount
  useEffect(() => {
    fetch(resolveDaemonUrl('/api/history?limit=40'))
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok && Array.isArray(d.data) && d.data.length > 0) {
          setRecentlyPlayed((prev) => {
            const seen = new Set<string>();
            const merged: TrackMetadata[] = [];
            for (const item of [...d.data, ...prev]) {
              if (item?.uri && !seen.has(item.uri)) {
                seen.add(item.uri);
                merged.push(item);
              }
            }
            const next = merged.slice(0, 40);
            try {
              window.localStorage.setItem('simp_recently_played_v1', JSON.stringify(next));
            } catch { }
            return next;
          });
        }
      })
      .catch(() => { });

    fetch(resolveDaemonUrl('/api/favorites'))
      .then((r) => r.json())
      .then((d) => {
        if (d?.ok && Array.isArray(d.uris)) {
          setFavoritedUris(d.uris);
        }
      })
      .catch(() => { });

    let rawLocalVisibility: string | null = null;
    try {
      rawLocalVisibility = window.localStorage.getItem('simp_source_visibility_v2');
    } catch { }
    let rawLocalStats: string | null = null;
    try {
      rawLocalStats = window.localStorage.getItem('imp_stats_hud_enabled_v1');
    } catch { }

    fetchDaemonUiPrefs().then((prefs) => {
      if (!prefs) return;
      const remoteVis = prefs.source_visibility_v2;
      if (remoteVis && typeof remoteVis === 'object' && !Array.isArray(remoteVis)) {
        const v = remoteVis as Record<string, unknown>;
        setSourceVisibility({
          internet_archive: v.internet_archive !== false,
          apple_music: v.apple_music !== false,
          soundcloud: v.soundcloud !== false,
          optical_drive: v.optical_drive === true,
        });
      } else if (rawLocalVisibility) {
        try {
          const parsed = JSON.parse(rawLocalVisibility);
          if (parsed && typeof parsed === 'object') {
            void saveDaemonUiPrefs({ source_visibility_v2: parsed });
          }
        } catch { }
      }

      if (typeof prefs.stats_hud_enabled_v1 === 'boolean') {
        saveStatsHudEnabled(prefs.stats_hud_enabled_v1, false);
      } else if (rawLocalStats !== null) {
        void saveDaemonUiPrefs({
          stats_hud_enabled_v1: rawLocalStats === '1' || rawLocalStats === 'true',
        });
      }
    });
  }, []);

  useEffect(() => {
    const cur = snap?.current_track;
    if (!cur?.uri || !snap?.is_playing) return;
    fetch(resolveDaemonUrl('/api/history'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cur),
    }).catch(() => { });
    setRecentlyPlayed((prev) => {
      if (prev[0]?.uri === cur.uri) return prev;
      const next = [cur, ...prev.filter((t) => t.uri !== cur.uri)].slice(0, 40);
      try {
        window.localStorage.setItem('simp_recently_played_v1', JSON.stringify(next));
      } catch {
        // Ignore storage access errors
      }
      return next;
    });
  }, [snap?.current_track?.uri, snap?.is_playing]);

  // Apple Music Cloud Hub state
  const [appleSubTab, setAppleSubTab] = useState<
    'pinned' | 'for_you' | 'cloud_playlists' | 'new' | 'radio'
  >('pinned');
  const [cloudPlaylists, setCloudPlaylists] = useState<AppleCloudPlaylistSummary[]>([]);
  const [radioStations, setRadioStations] = useState<AppleRadioStationSummary[]>([]);
  const [personalRadioStations, setPersonalRadioStations] = useState<AppleRadioStationSummary[]>([]);
  const [liveRadioStations, setLiveRadioStations] = useState<AppleRadioStationSummary[]>([]);
  const [artistRadioShows, setArtistRadioShows] = useState<AppleCloudPlaylistSummary[]>([]);
  const [clubMixes, setClubMixes] = useState<AppleCloudPlaylistSummary[]>([]);
  const [genreRadioStations, setGenreRadioStations] = useState<AppleRadioStationSummary[]>([]);
  const [forYouPlaylists, setForYouPlaylists] = useState<AppleCloudPlaylistSummary[]>([]);
  const [forYouAlbums, setForYouAlbums] = useState<AppleCloudAlbumSummary[]>([]);
  const [forYouNewReleases, setForYouNewReleases] = useState<AppleCloudAlbumSummary[]>([]);
  const [forYouShelves, setForYouShelves] = useState<AppleRecommendationShelf[]>([]);
  const [appleRecentlyPlayedTracks, setAppleRecentlyPlayedTracks] = useState<TrackMetadata[]>([]);
  const [newFeedRecentReleases, setNewFeedRecentReleases] = useState<AppleCloudAlbumSummary[]>([]);
  const [newFeedAlbums, setNewFeedAlbums] = useState<AppleCloudAlbumSummary[]>([]);
  const [newFeedPlaylists, setNewFeedPlaylists] = useState<AppleCloudPlaylistSummary[]>([]);
  const [newFeedSongs, setNewFeedSongs] = useState<TrackMetadata[]>([]);
  const [catalogSearchResults, setCatalogSearchResults] = useState<AppleCatalogSearchResults>({
    songs: [],
    albums: [],
    playlists: [],
    stations: [],
    artists: [],
  });
  const [cloudLoading, setCloudLoading] = useState(false);
  const [activeCloudAlbum, setActiveCloudAlbum] = useState<AppleCloudAlbumSummary | null>(null);
  const [activeCloudPlaylist, setActiveCloudPlaylist] = useState<AppleCloudPlaylistSummary | null>(null);

  // SoundCloud Cloud Hub state
  const [soundCloudSubTab, setSoundCloudSubTab] = useState<
    'pinned' | 'likes_sets' | 'stream_radio' | 'trending'
  >('trending');
  const [scLikedTracks, setScLikedTracks] = useState<TrackMetadata[]>([]);
  const [scPlaylists, setScPlaylists] = useState<SoundCloudPlaylistSummary[]>([]);
  const [scStreamTracks, setScStreamTracks] = useState<TrackMetadata[]>([]);
  const [scStreamPlaylists, setScStreamPlaylists] = useState<SoundCloudPlaylistSummary[]>([]);
  const [scTrendingTracks, setScTrendingTracks] = useState<TrackMetadata[]>([]);
  const [scTrendingMixes, setScTrendingMixes] = useState<TrackMetadata[]>([]);
  const [scTrendingPlaylists, setScTrendingPlaylists] = useState<SoundCloudPlaylistSummary[]>([]);
  const [scMoreOfWhatYouLike, setScMoreOfWhatYouLike] = useState<TrackMetadata[]>([]);
  const [scFreshUploads, setScFreshUploads] = useState<TrackMetadata[]>([]);
  const [scRecommendedArtists, setScRecommendedArtists] = useState<SoundCloudUserSummary[]>([]);
  const [scDiscoverNextHref, setScDiscoverNextHref] = useState<string | null>(null);
  const [scSelectedGenre, setScSelectedGenre] = useState<string>('');
  const [scCatalogSearchResults, setScCatalogSearchResults] =
    useState<SoundCloudCatalogSearchResults>({
      songs: [],
      playlists: [],
      users: [],
      next_tracks_href: null,
    });
  const [activeScPlaylist, setActiveScPlaylist] = useState<SoundCloudPlaylistSummary | null>(null);

  // Playlist creation, active playback context & target state
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [newPlaylistName, setNewPlaylistName] = useState('');
  const [activePlaylistId, setActivePlaylistId] = useState<string>('');
  const [playingContextId, setPlayingContextId] = useState<string>('');

  // Custom folder input inside Source Modal + Controller On-Screen Keyboard (OSK) state
  const [customFolderPath, setCustomFolderPath] = useState('');
  const [oskTarget, setOskTarget] = useState<OskTargetKind>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const [pendingHybridAdd, setPendingHybridAdd] = useState<{
    uris: string[];
    label: string;
    trackMetadata?: TrackMetadata[];
    creatingNew?: boolean;
  } | null>(null);

  // Automatically dismiss the On-Screen Keyboard whenever its target context closes or view switches to Player
  useEffect(() => {
    if (!oskTarget) return;
    if (oskTarget === 'search' && view !== 'browser') {
      setOskTarget(null);
      return;
    }
    if (oskTarget === 'folder' && !sourceModalOpen && !powerModalOpen) {
      setOskTarget(null);
      return;
    }
    if (oskTarget === 'playlist' && !creatingPlaylist && !pendingHybridAdd) {
      setOskTarget(null);
      return;
    }
    if (view !== 'browser' && !sourceModalOpen && !powerModalOpen && !pendingHybridAdd) {
      setOskTarget(null);
    }
  }, [oskTarget, view, sourceModalOpen, powerModalOpen, creatingPlaylist, pendingHybridAdd]);

  // Dismiss the On-Screen Keyboard when clicking outside it (and outside its target input) or pressing Escape
  useEffect(() => {
    if (!oskTarget) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-osk-root="true"]') || target.closest('[data-osk-input]')) {
        return;
      }
      setOskTarget(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOskTarget(null);
      }
    };
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [oskTarget]);

  // Apple Music & SoundCloud Auth Modal state
  const [appleAuthCfg, setAppleAuthCfg] = useState<AppleMusicAuthConfig | null>(null);
  const [appleBusy, setAppleBusy] = useState(false);
  const [soundcloudAuthCfg, setSoundcloudAuthCfg] = useState<SoundCloudAuthConfig | null>(null);
  const [soundcloudBusy, setSoundcloudBusy] = useState(false);
  const scAutoClientAuthRef = useRef(false);

  // OLED auto-dim, active luminance percentage, popovers & sub-pixel orbit state
  const [isDimmed, setIsDimmed] = useState(false);
  const [libraryIdleDimmed, setLibraryIdleDimmed] = useState(false);
  const [brightnessPct, setBrightnessPct] = useState<number>(() => {
    try {
      const saved = window.localStorage.getItem('simp_brightness_pct_v2');
      if (saved) {
        const parsed = Number(saved);
        if (Number.isFinite(parsed) && parsed >= 25 && parsed <= 100) {
          return Math.round(parsed);
        }
      }
    } catch {
      // Ignore storage access errors
    }
    return 100;
  });
  const brightnessHydratedRef = useRef(false);
  const [volumePopoverOpen, setVolumePopoverOpen] = useState(false);
  const [brightnessPopoverOpen, setBrightnessPopoverOpen] = useState(false);
  const [orbitStep, setOrbitStep] = useState(0);

  // Hydrate brightnessPct once from daemon settings.vdf snapshot if not overridden in localStorage
  useEffect(() => {
    if (!brightnessHydratedRef.current && snap?.brightness_pct && snap.brightness_pct >= 25) {
      brightnessHydratedRef.current = true;
      try {
        if (!window.localStorage.getItem('simp_brightness_pct_v2')) {
          setBrightnessPct(Math.max(25, Math.min(100, Math.round(snap.brightness_pct))));
        }
      } catch {
        setBrightnessPct(Math.max(25, Math.min(100, Math.round(snap.brightness_pct))));
      }
    }
  }, [snap?.brightness_pct]);

  // Persist brightnessPct to localStorage & daemon settings.vdf after 3 seconds of being unchanged
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem('simp_brightness_pct_v2', String(brightnessPct));
      } catch {
        // Ignore storage errors
      }
      defaultSimpClient.setBrightness(brightnessPct);
    }, 3000);
    return () => window.clearTimeout(timer);
  }, [brightnessPct]);

  // 8-point ±2px circular sub-pixel orbit to prevent static OLED sub-pixel image retention
  const ORBIT_OFFSETS: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [1, 1],
    [2, 0],
    [1, -1],
    [0, -2],
    [-1, -1],
    [-2, 0],
    [-1, 1],
  ];
  const [orbitX, orbitY] = ORBIT_OFFSETS[orbitStep % ORBIT_OFFSETS.length];
  const baseOpacity = Math.max(0.25, Math.min(1, brightnessPct / 100));
  const activeOpacity =
    view === 'browser' && libraryIdleDimmed && !desktopScreensaverActive
      ? Math.max(0.12, baseOpacity * 0.5)
      : baseOpacity;

  const showToast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.setTimeout(() => {
      setToastMsg((prev) => (prev === msg ? null : prev));
    }, 2600);
  }, []);

  useEffect(() => {
    const onToast = (ev: Event) => {
      const msg = (ev as CustomEvent<{ message?: string }>).detail?.message;
      if (msg) showToast(msg);
    };
    window.addEventListener('simp-show-toast', onToast);
    return () => window.removeEventListener('simp-show-toast', onToast);
  }, [showToast]);

  const handleToggleDesktopMode = useCallback(
    (next: boolean) => {
      if (isDeckyEmbedded) return;
      setDesktopModeRaw(next);
      setDesktopScreensaverActive(false);
      try {
        window.localStorage.setItem('simp_desktop_mode', next ? '1' : '0');
      } catch {
        // Ignore storage errors
      }
      if (next) {
        setViewState('browser');
        showToast('Desktop Mode enabled — audio plays stay in Library');
      } else {
        showToast('Restored Player + Library dual view');
      }
    },
    [isDeckyEmbedded, showToast]
  );

  const handleChangeDesktopVizIdleSec = useCallback((sec: number) => {
    const safeSec = Number.isFinite(sec) && sec >= 0 ? Math.round(sec) : 30;
    setDesktopVizIdleSecState(safeSec);
    if (safeSec === 0) {
      setDesktopScreensaverActive(false);
    }
    try {
      window.localStorage.setItem('simp_desktop_viz_idle_sec', String(safeSec));
    } catch {
      // Ignore storage errors
    }
  }, []);

  const triggerDesktopScreensaver = useCallback(() => {
    if (!desktopMode) return;
    screensaverPointerGraceUntilRef.current = performance.now() + 1800;
    setDesktopScreensaverActive(true);
  }, [desktopMode]);

  const [updateStatus, setUpdateStatus] = useState<SimpUpdateStatus>(() => {
    try {
      const saved = window.localStorage.getItem('imp_update_channel_v1');
      if (saved === 'alpha' || saved === 'off' || saved === 'stable') {
        return { channel: saved };
      }
    } catch {}
    return { channel: 'stable' };
  });
  const updateChannelRef = useRef<string>(updateStatus.channel || 'stable');
  const notifiedUpdateTagRef = useRef<string | null>(
    (() => {
      try {
        return window.localStorage.getItem('imp_notified_update_tag_v1');
      } catch {
        return null;
      }
    })()
  );
  const startupUpdateCheckedRef = useRef(false);

  useEffect(() => {
    if (updateStatus.channel) {
      updateChannelRef.current = updateStatus.channel;
      try {
        window.localStorage.setItem('imp_update_channel_v1', updateStatus.channel);
      } catch {}
    }
  }, [updateStatus.channel]);

  useEffect(() => {
    if (snap?.daemon_version) {
      setUpdateStatus((prev) =>
        prev.current_version === snap.daemon_version
          ? prev
          : { ...prev, current_version: snap.daemon_version }
      );
    }
  }, [snap?.daemon_version]);

  const resolveDaemonBaseUrl = useCallback(() => resolveDaemonUrl(''), []);

  const compareSemverStrings = useCallback((currentRaw: string, candidateRaw: string): boolean => {
    const parseTuple = (v: string): [number, number, number, number, number] => {
      const cleaned = v.trim().replace(/^v/i, '');
      const [core, pre = ''] = cleaned.split('-', 2);
      const parts = core.split('.').map((n) => parseInt(n, 10) || 0);
      const major = parts[0] || 0;
      const minor = parts[1] || 0;
      const patch = parts[2] || 0;
      if (!pre) return [major, minor, patch, 1, 0];
      const preParts = pre.split('.');
      const preNum = parseInt(preParts[preParts.length - 1] || '0', 10) || 0;
      return [major, minor, patch, 0, preNum];
    };
    const cur = parseTuple(currentRaw);
    const cand = parseTuple(candidateRaw);
    for (let i = 0; i < 5; i++) {
      if (cand[i] !== cur[i]) return cand[i] > cur[i];
    }
    return false;
  }, []);

  const checkSimpUpdates = useCallback(async (_silent = false) => {
    if (_silent) {
      let cachedCh = updateChannelRef.current;
      try {
        const stored = window.localStorage.getItem('imp_update_channel_v1');
        if (stored) cachedCh = stored;
      } catch {}
      if (cachedCh.toLowerCase() === 'off') {
        return;
      }
    }
    setUpdateStatus((prev) => ({ ...prev, checking: true, error: undefined }));
    const base = resolveDaemonBaseUrl();
    const maybeNotifyAvailableUpdate = (
      available: boolean,
      tag: string | undefined,
      channelName: string
    ) => {
      if (!available || !tag || notifiedUpdateTagRef.current === tag) return;
      notifiedUpdateTagRef.current = tag;
      try {
        window.localStorage.setItem('imp_notified_update_tag_v1', tag);
      } catch {}
      const chLabel = channelName.toLowerCase() === 'alpha' ? 'Alpha' : 'Stable';
      showToast(`✨ Imp ${tag} available (${chLabel}) — open Settings to update`);
    };

    try {
      const resp = await fetch(`${base}/api/update/check?t=${Date.now()}`, { cache: 'no-store' });
      const text = await resp.text();
      if (text.trim().startsWith('{')) {
        const data = JSON.parse(text);
        if (data.ok) {
          const ch = String(data.channel || 'stable');
          const available = Boolean(data.update_available);
          updateChannelRef.current = ch;
          setUpdateStatus({
            current_version: data.current_version,
            latest_version: data.latest_version,
            latest_tag: data.latest_tag,
            update_available: available,
            channel_switch_available: Boolean(data.channel_switch_available),
            target_arch: data.target_arch,
            channel: ch,
            checking: false,
          });
          maybeNotifyAvailableUpdate(available, data.latest_tag, ch);
          return;
        } else if (data.error && !String(data.error).includes('<!DOCTYPE')) {
          setUpdateStatus((prev) => ({
            ...prev,
            current_version: data.current_version || prev.current_version,
            target_arch: data.target_arch || prev.target_arch,
            channel: data.channel || prev.channel || 'stable',
            checking: false,
            error: data.error,
          }));
          return;
        }
      }

      // Fallback: query GitHub Releases API directly if the daemon endpoint returned HTML or was unreachable
      const activeChannel =
        updateChannelRef.current.toLowerCase() === 'alpha' ? 'alpha' : 'stable';
      const ghResp = await fetch('https://api.github.com/repos/niiiitz/imp/releases?per_page=100', {
        headers: { Accept: 'application/vnd.github+json' },
        cache: 'no-store',
      });
      const ghText = await ghResp.text();
      if (!ghText.trim().startsWith('[')) {
        throw new Error('Could not query GitHub Releases API');
      }
      const releases = JSON.parse(ghText) as Array<{
        tag_name?: string;
        draft?: boolean;
        prerelease?: boolean;
      }>;
      const isPrereleaseTag = (t: string) => /-(alpha|beta|rc)\b/i.test(t);
      const valid = releases.filter((r) => {
        if (r.draft || !r.tag_name) return false;
        if (activeChannel === 'stable') {
          return !r.prerelease && !isPrereleaseTag(String(r.tag_name));
        }
        return true;
      });
      if (valid.length === 0) {
        if (activeChannel === 'stable') {
          setUpdateStatus((prev) => ({
            ...prev,
            latest_tag: 'No stable release yet',
            update_available: false,
            channel_switch_available: false,
            checking: false,
            error: undefined,
          }));
          return;
        }
        throw new Error('No published releases found on GitHub');
      }
      valid.sort((a, b) => {
        const ta = String(a.tag_name || '').replace(/^v/i, '');
        const tb = String(b.tag_name || '').replace(/^v/i, '');
        if (compareSemverStrings(ta, tb)) return 1;
        if (compareSemverStrings(tb, ta)) return -1;
        return 0;
      });
      const newest = valid[valid.length - 1];
      const newestTag = String(newest.tag_name || '');
      const latestVer = newestTag.replace(/^v/i, '');
      const curVer = snapRef.current?.daemon_version || '';
      const isNewer = curVer ? compareSemverStrings(curVer, latestVer) : false;
      setUpdateStatus((prev) => {
        const effCur = curVer || prev.current_version || '';
        const effNewer = effCur ? compareSemverStrings(effCur, latestVer) : false;
        const effSwitchAvail =
          activeChannel === 'stable' &&
          Boolean(effCur) &&
          isPrereleaseTag(effCur) &&
          !isPrereleaseTag(latestVer) &&
          !effNewer;
        return {
          ...prev,
          current_version: effCur || undefined,
          latest_version: latestVer,
          latest_tag: newestTag,
          update_available: effNewer,
          channel_switch_available: effSwitchAvail,
          checking: false,
          error: undefined,
        };
      });
      maybeNotifyAvailableUpdate(isNewer, newestTag, activeChannel);
    } catch (e: any) {
      const rawMsg = String(e?.message || 'Could not reach update server');
      const cleanMsg =
        rawMsg.includes('<!DOCTYPE') || rawMsg.includes('Unexpected token')
          ? 'Daemon binary needs restart to enable self-update endpoint'
          : rawMsg;
      setUpdateStatus((prev) => ({
        ...prev,
        checking: false,
        error: cleanMsg,
      }));
    }
  }, [resolveDaemonBaseUrl, compareSemverStrings, showToast]);

  // Background startup check (~3.5s after mount) so users get a toast when an update is available
  useEffect(() => {
    if (isDeckyEmbedded || startupUpdateCheckedRef.current) return;
    startupUpdateCheckedRef.current = true;
    const tid = window.setTimeout(async () => {
      const base = resolveDaemonBaseUrl();
      try {
        const pResp = await fetch(`${base}/api/settings/privacy`, { cache: 'no-store' });
        if (pResp.ok) {
          const pData = await pResp.json();
          if (typeof pData?.update_channel === 'string') {
            const ch = pData.update_channel.toLowerCase();
            updateChannelRef.current = ch;
            setUpdateStatus((prev) => ({ ...prev, channel: ch }));
            try {
              window.localStorage.setItem('imp_update_channel_v1', ch);
            } catch {}
            if (ch === 'off') return;
          }
        }
      } catch {
        // fallback cleanly to checkSimpUpdates local guard
      }
      checkSimpUpdates(true);
    }, 3500);
    return () => window.clearTimeout(tid);
  }, [isDeckyEmbedded, resolveDaemonBaseUrl, checkSimpUpdates]);

  const applySimpUpdate = useCallback(async () => {
    setUpdateStatus((prev) => ({ ...prev, applying: true, error: undefined }));
    showToast('Downloading & installing latest Imp release from GitHub...');
    const base = resolveDaemonBaseUrl();
    try {
      const resp = await fetch(`${base}/api/update/apply`, { method: 'POST', cache: 'no-store' });
      const text = await resp.text();
      if (!text.trim().startsWith('{')) {
        throw new Error('Daemon binary does not support /api/update/apply yet — rebuild or restart imp --daemon');
      }
      const data = JSON.parse(text);
      if (data.ok) {
        const nextVer = String(data.updated_version || '').replace(/^v/, '');
        if (nextVer) {
          setUpdateStatus((prev) => ({
            ...prev,
            current_version: nextVer,
            update_available: false,
          }));
        }
        showToast(`${data.message} — restarting Imp...`);
        await new Promise((r) => window.setTimeout(r, 950));
        for (let attempt = 0; attempt < 15; attempt++) {
          try {
            const hr = await fetch(`${base}/health?t=${Date.now()}`, { cache: 'no-store' });
            if (hr.ok) {
              const hj = await hr.json();
              const reported = String(hj?.version || '').replace(/^v/, '');
              if (reported && (!nextVer || reported === nextVer)) {
                break;
              }
            }
          } catch {
            // Daemon is still restarting
          }
          await new Promise((r) => window.setTimeout(r, 400));
        }
        window.location.replace(
          `${window.location.pathname}?v=${encodeURIComponent(nextVer || 'latest')}&t=${Date.now()}`
        );
      } else {
        setUpdateStatus((prev) => ({
          ...prev,
          applying: false,
          error: data.error || 'Self-update failed',
        }));
        showToast(`Update failed: ${data.error || 'Unknown error'}`);
      }
    } catch (e: any) {
      setUpdateStatus((prev) => ({
        ...prev,
        applying: false,
        error: e?.message || 'Update request failed',
      }));
      showToast('Update failed — check network connection');
    }
  }, [resolveDaemonBaseUrl, showToast]);

  const dismissConsole = useCallback(() => {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'SIMP_EXIT_CONSOLE' }, '*');
    } else {
      quitNativeAppWindow();
    }
  }, []);

  // 1. Connect to `simp --daemon` (`ws://127.0.0.1:18888/ws`)
  useEffect(() => {
    defaultSimpClient.connect();
    const unsub = defaultSimpClient.subscribeState((nextState) => {
      setSnap({ ...nextState });
    });
    return unsub;
  }, []);

  // 1b. Auto-reload open UI window when background daemon restarts on a new version (e.g. after CLI `simp update`)
  const knownDaemonVersionRef = useRef<string | null>(null);
  useEffect(() => {
    const reported = (snap?.daemon_version || '').trim().replace(/^v/, '');
    if (!reported) return;
    if (!knownDaemonVersionRef.current) {
      knownDaemonVersionRef.current = reported;
      return;
    }
    if (knownDaemonVersionRef.current !== reported && !updateStatus.applying) {
      knownDaemonVersionRef.current = reported;
      window.location.replace(
        `${window.location.pathname}?v=${encodeURIComponent(reported)}&t=${Date.now()}`
      );
    }
  }, [snap?.daemon_version, updateStatus.applying]);

  // 2. Refresh Albums & Playlists helper
  const refreshLibraryData = useCallback(() => {
    const sourceParam =
      browserSourceFilter === 'all' ? null : browserSourceFilter;
    const searchParam = browserSearch.trim() ? browserSearch.trim() : null;

    defaultSimpClient
      .query<AlbumRecord[]>('get_albums', {
        source: sourceParam,
        mount_root: null,
        search: searchParam,
        limit: 25000,
        offset: 0,
      })
      .then((res) => {
        setAlbums(res);
        setBrowserTarget((prev) => {
          if (!prev && res.length > 0) {
            return { kind: 'album', id: res[0].id };
          }
          return prev;
        });
      })
      .catch(() => { });

    defaultSimpClient
      .query<PlaylistRecord[]>('get_playlists')
      .then((pls) => {
        setPlaylists(pls);
        const writable = pls.filter((p) => p.origin === 'simp_local');
        if (writable.length > 0) {
          setActivePlaylistId((prev) =>
            writable.some((w) => w.id === prev) ? prev : writable[0].id
          );
        }
      })
      .catch(() => { });
  }, [browserSourceFilter, browserSearch]);

  useEffect(() => {
    const onRefreshNeeded = () => refreshLibraryData();
    window.addEventListener('simp-library-refresh-needed', onRefreshNeeded);
    return () => window.removeEventListener('simp-library-refresh-needed', onRefreshNeeded);
  }, [refreshLibraryData]);

  useEffect(() => {
    if (view === 'browser' || sourceModalOpen || powerModalOpen) {
      refreshLibraryData();
    }
    defaultSimpClient
      .getSoundCloudAuthConfig()
      .then((cfg) => {
        setSoundcloudAuthCfg(cfg);
        // Auto-bootstrap Tier 1 Public Mode (client_credentials) if credentials exist and not yet authenticated
        if (
          cfg.configured &&
          !cfg.soundcloud_authenticated &&
          !scAutoClientAuthRef.current
        ) {
          scAutoClientAuthRef.current = true;
          fetch(resolveDaemonUrl('/api/soundcloud/client-auth'), { method: 'POST' })
            .then(() => defaultSimpClient.getSoundCloudAuthConfig())
            .then((nextCfg) => setSoundcloudAuthCfg(nextCfg))
            .catch(() => { });
        }
      })
      .catch(() => { });
    if (sourceModalOpen || powerModalOpen) {
      defaultSimpClient
        .getAppleMusicAuthConfig()
        .then((cfg) => {
          setAppleAuthCfg(cfg);
        })
        .catch(() => { });
    }
    if (!sourceModalOpen && !powerModalOpen) {
      setConfirmHardReset(false);
    } else {
      checkSimpUpdates(true);
    }
  }, [view, sourceModalOpen, powerModalOpen, snap?.mounts, refreshLibraryData, checkSimpUpdates]);

  // 3. Load tracks for whichever Album, Playlist, Storage Mount, or Apple Cloud item is selected in the Browser
  useEffect(() => {
    if (!browserTarget) {
      setBrowserTracks([]);
      return;
    }
    if (browserTarget.kind === 'album') {
      defaultSimpClient
        .query<TrackMetadata[]>('get_album_tracks', { album_id: browserTarget.id })
        .then(setBrowserTracks)
        .catch(() => { });
    } else if (browserTarget.kind === 'playlist') {
      defaultSimpClient
        .query<TrackMetadata[]>('get_playlist_items', {
          playlist_id: browserTarget.id,
          limit: 10000,
          offset: 0,
        })
        .then(setBrowserTracks)
        .catch(() => { });
    } else if (browserTarget.kind === 'mount') {
      defaultSimpClient
        .query<TrackMetadata[]>('get_tracks', {
          source: null,
          mount_root: browserTarget.id,
          search: browserSearch.trim() ? browserSearch.trim() : null,
          limit: 50000,
          offset: 0,
        })
        .then(setBrowserTracks)
        .catch(() => { });
    } else if (browserTarget.kind === 'cdda') {
      setBrowserTracks(opticalDisc?.tracks || []);
    } else if (
      browserTarget.kind === 'cloud_playlist' &&
      browserTarget.id !== 'active_queue' &&
      activeCloudPlaylist?.id !== browserTarget.id
    ) {
      fetchApplePlaylistTracks(browserTarget.id)
        .then((tracks) => {
          setBrowserTracks(tracks);
        })
        .catch(() => { });
    } else if (
      browserTarget.kind === 'soundcloud_playlist' &&
      browserTarget.id !== 'active_queue' &&
      activeScPlaylist?.id !== browserTarget.id
    ) {
      fetchSoundCloudPlaylistTracks(browserTarget.id)
        .then((tracks) => {
          setBrowserTracks(tracks);
        })
        .catch(() => { });
    } else if (
      browserTarget.kind === 'cloud_album' &&
      activeCloudAlbum?.id !== browserTarget.id
    ) {
      fetchFullAppleAlbum({ albumId: browserTarget.id })
        .then(({ album, tracks }) => {
          setActiveCloudAlbum(album);
          setBrowserTracks(tracks);
        })
        .catch(() => { });
    }
  }, [
    browserTarget,
    browserSearch,
    opticalDisc,
    activeCloudPlaylist?.id,
    activeScPlaylist?.id,
    activeCloudAlbum?.id,
  ]);

  // 3b. Keep live queue synchronized in real time when viewing the Playing Queue collection
  useEffect(() => {
    if (browserTarget?.kind !== 'playing_queue') return;
    const liveQueue =
      snap?.queue && snap.queue.length > 0
        ? snap.queue
        : snap?.current_track
        ? [snap.current_track]
        : [];
    setBrowserTracks(liveQueue);
  }, [browserTarget?.kind, snap?.queue, snap?.current_track]);

  // 3a. Optical CD-ROM (`cdda://`) & DVD-Video Scanner & Eject Handler
  const handleScanOpticalDisc = useCallback(
    async (forceRefresh = false, silent = false) => {
      if (!silent) {
        setCdScanning(true);
      }
      try {
        const res = await defaultSimpClient.scanOpticalDisc(
          forceRefresh,
          opticalDisc?.drive_present ? opticalDisc.device_path || undefined : undefined
        );
        setOpticalDisc(res);
        setBrowserTarget((prev) => {
          if (prev?.kind === 'cdda') {
            if (!res.is_audio_cd && !res.is_dvd_video) {
              return null;
            }
            if (res.is_dvd_video) {
              return {
                kind: 'cdda',
                id: res.disc_id || res.device_path || '/dev/sr0',
                title: `📀 ${res.album_title || 'DVD Video'}`,
                subtitle: `${res.artist_name || 'DVD-Video'}${res.release_year ? ` • ${res.release_year}` : ''
                  }`,
                art_url: res.art_url,
              };
            }
            return {
              kind: 'cdda',
              id: res.disc_id || res.device_path || '/dev/sr0',
              title: `💿 ${res.album_title || 'Audio CD'}`,
              subtitle: `${res.artist_name || 'Unknown Artist'}${res.release_year ? ` • ${res.release_year}` : ''
                }${res.disc_id ? ` • DiscID ${res.disc_id.slice(0, 8)}…` : ''}`,
              art_url: res.art_url,
            };
          }
          return prev;
        });
        if (!silent) {
          showToast(res.status_message);
        }
      } catch {
        if (!silent) {
          showToast('Optical drive scan failed');
        }
      } finally {
        setCdScanning(false);
      }
    },
    [opticalDisc?.device_path, showToast]
  );

  const handleEjectOpticalDisc = useCallback(() => {
    defaultSimpClient.ejectOpticalDisc(opticalDisc?.device_path || undefined);
    setOpticalDisc((prev) =>
      prev
        ? {
          ...prev,
          disc_present: false,
          is_audio_cd: false,
          is_dvd_video: false,
          dvd_titles: [],
          tracks: [],
          status_message: 'Tray ejected',
        }
        : null
    );
    setBrowserTarget((prev) => (prev?.kind === 'cdda' ? null : prev));
    showToast('⏏ Ejecting optical disc...');
  }, [opticalDisc?.device_path, showToast]);

  // Perform a single non-intrusive optical drive check when opening the Browser or Sources modal while awake
  useEffect(() => {
    if (isSleeping || isDimmed || !sourceVisibility.optical_drive) return;
    const isCdActiveInView =
      sourceModalOpen || (view === 'browser' && browserTarget?.kind === 'cdda');
    const isStreamingCd =
      snap?.is_playing && snap?.current_track?.source === 'cdda';

    if ((view === 'browser' || sourceModalOpen) && !opticalDisc && !isStreamingCd) {
      handleScanOpticalDisc(false, true);
    }

    if (!isCdActiveInView || isStreamingCd || opticalDisc?.disc_present) return;
    const timer = window.setInterval(() => {
      handleScanOpticalDisc(false, true);
    }, 8000);
    return () => window.clearInterval(timer);
  }, [
    view,
    sourceModalOpen,
    browserTarget?.kind,
    isSleeping,
    isDimmed,
    sourceVisibility.optical_drive,
    opticalDisc,
    snap?.is_playing,
    snap?.current_track?.source,
    handleScanOpticalDisc,
  ]);

  const applePlaylistsFetchedAtRef = useRef<number>(0);
  const appleForYouFetchedAtRef = useRef<number>(0);
  const appleNewFetchedAtRef = useRef<number>(0);
  const scLikesFetchedAtRef = useRef<number>(0);
  const scStreamFetchedAtRef = useRef<number>(0);
  const scTrendingFetchedAtRef = useRef<Record<string, number>>({});
  const swrInFlightRef = useRef<Set<string>>(new Set());

  // Hydrate discovery shelves immediately from SQLite servicesCache.db on startup
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [appleCache, scCache] = await Promise.all([
        readProviderCachedShelves('apple_music'),
        readProviderCachedShelves('soundcloud'),
      ]);
      if (cancelled) return;

      const acp = appleCache.byShelfId['bundle:cloud_playlists'];
      if (acp && Array.isArray(acp.data)) {
        setCloudPlaylists((prev) => (prev.length === 0 ? acp.data : prev));
        applePlaylistsFetchedAtRef.current = acp.stale ? 0 : acp.fetchedAt;
      }

      const afy = appleCache.byShelfId['bundle:for_you_radio'];
      if (afy && afy.data && typeof afy.data === 'object') {
        const res = afy.data;
        setRadioStations((prev) => (prev.length === 0 ? res.stations || [] : prev));
        setPersonalRadioStations((prev) => (prev.length === 0 ? res.personal_stations || [] : prev));
        setLiveRadioStations((prev) => (prev.length === 0 ? res.live_stations || [] : prev));
        setArtistRadioShows((prev) => (prev.length === 0 ? res.artist_shows || [] : prev));
        setClubMixes((prev) => (prev.length === 0 ? res.club_mixes || [] : prev));
        setGenreRadioStations((prev) => (prev.length === 0 ? res.genre_stations || [] : prev));
        setForYouPlaylists((prev) => (prev.length === 0 ? res.playlists || [] : prev));
        setForYouAlbums((prev) => (prev.length === 0 ? res.albums || [] : prev));
        setForYouNewReleases((prev) => (prev.length === 0 ? res.new_releases || [] : prev));
        setForYouShelves((prev) => (prev.length === 0 ? res.shelves || [] : prev));
        setAppleRecentlyPlayedTracks((prev) =>
          prev.length === 0 ? res.recently_played || [] : prev
        );
        appleForYouFetchedAtRef.current = afy.stale ? 0 : afy.fetchedAt;
      }

      const anew = appleCache.byShelfId['bundle:new_feed'];
      if (anew && anew.data && typeof anew.data === 'object') {
        const res = anew.data;
        setNewFeedRecentReleases((prev) => (prev.length === 0 ? res.recent_releases || [] : prev));
        setNewFeedAlbums((prev) => (prev.length === 0 ? res.albums || [] : prev));
        setNewFeedPlaylists((prev) => (prev.length === 0 ? res.playlists || [] : prev));
        setNewFeedSongs((prev) => (prev.length === 0 ? res.songs || [] : prev));
        appleNewFetchedAtRef.current = anew.stale ? 0 : anew.fetchedAt;
      }

      const scLikes = scCache.byShelfId['bundle:likes_sets'];
      if (scLikes && scLikes.data && typeof scLikes.data === 'object') {
        setScLikedTracks((prev) => (prev.length === 0 ? scLikes.data.likedTracks || [] : prev));
        setScPlaylists((prev) => (prev.length === 0 ? scLikes.data.playlists || [] : prev));
        scLikesFetchedAtRef.current = scLikes.stale ? 0 : scLikes.fetchedAt;
      }

      const scStream = scCache.byShelfId['bundle:stream_radio'];
      if (scStream && scStream.data && typeof scStream.data === 'object') {
        setScStreamTracks((prev) =>
          prev.length === 0 ? scStream.data.streamTracks || [] : prev
        );
        setScStreamPlaylists((prev) =>
          prev.length === 0 ? scStream.data.streamPlaylists || [] : prev
        );
        scStreamFetchedAtRef.current = scStream.stale ? 0 : scStream.fetchedAt;
      }

      const scTr = scCache.byShelfId['bundle:trending:all'];
      if (scTr && scTr.data && typeof scTr.data === 'object') {
        const res = scTr.data;
        setScTrendingTracks((prev) => (prev.length === 0 ? res.tracks || [] : prev));
        setScTrendingMixes((prev) => (prev.length === 0 ? res.mixes || [] : prev));
        setScTrendingPlaylists((prev) => (prev.length === 0 ? res.playlists || [] : prev));
        setScMoreOfWhatYouLike((prev) =>
          prev.length === 0 ? res.more_of_what_you_like || [] : prev
        );
        setScFreshUploads((prev) => (prev.length === 0 ? res.fresh_uploads || [] : prev));
        setScRecommendedArtists((prev) =>
          prev.length === 0 ? res.recommended_artists || [] : prev
        );
        setScDiscoverNextHref((prev) => prev || res.next_tracks_href || null);
        scTrendingFetchedAtRef.current['all'] = scTr.stale ? 0 : scTr.fetchedAt;
      }
    })();

    const onPurged = (ev: Event) => {
      const src = ((ev as CustomEvent<{ source?: string }>).detail?.source || '').toLowerCase();
      refreshFypFromDb();
      if (src.includes('apple')) {
        applePlaylistsFetchedAtRef.current = 0;
        appleForYouFetchedAtRef.current = 0;
        appleNewFetchedAtRef.current = 0;
        setCloudPlaylists([]);
        setRadioStations([]);
        setForYouPlaylists([]);
        setForYouAlbums([]);
        setForYouShelves([]);
        setNewFeedAlbums([]);
        setNewFeedPlaylists([]);
        setNewFeedSongs([]);
      } else if (src.includes('soundcloud') || src === 'sc') {
        scLikesFetchedAtRef.current = 0;
        scStreamFetchedAtRef.current = 0;
        scTrendingFetchedAtRef.current = {};
        setScLikedTracks([]);
        setScPlaylists([]);
        setScStreamTracks([]);
        setScStreamPlaylists([]);
        setScTrendingTracks([]);
        setScTrendingMixes([]);
        setScTrendingPlaylists([]);
        setScMoreOfWhatYouLike([]);
        setScFreshUploads([]);
        setScRecommendedArtists([]);
      }
    };
    window.addEventListener('simp-source-purged', onPurged);
    return () => {
      cancelled = true;
      window.removeEventListener('simp-source-purged', onPurged);
    };
  }, []);

  // 3b. Apple Music Cloud Hub data loader (Stale-While-Revalidate via servicesCache.db)
  useEffect(() => {
    if (view !== 'browser' || !snap?.apple_authenticated || !sourceVisibility.apple_music) {
      return;
    }
    const nowUnix = Math.floor(Date.now() / 1000);
    const needCloudPlaylists =
      ((browseHubTarget === 'apple_discover' && appleSubTab === 'cloud_playlists') ||
        Boolean(browserSearch.trim()) ||
        cloudPlaylists.length === 0) &&
      (cloudPlaylists.length === 0 ||
        nowUnix - applePlaylistsFetchedAtRef.current > TTL_CATALOG_FEED_SEC) &&
      !swrInFlightRef.current.has('apple:cloud_playlists');
    if (needCloudPlaylists) {
      swrInFlightRef.current.add('apple:cloud_playlists');
      if (cloudPlaylists.length === 0 && browseHubTarget === 'apple_discover') setCloudLoading(true);
      fetchAppleCloudPlaylists()
        .then((list) => {
          setCloudPlaylists(list);
          applePlaylistsFetchedAtRef.current = Math.floor(Date.now() / 1000);
          writeCachedShelves([
            {
              cacheKey: 'apple:bundle:cloud_playlists',
              provider: 'apple_music',
              shelfId: 'bundle:cloud_playlists',
              title: 'Apple Cloud Playlists',
              data: list,
              ttlSec: TTL_CATALOG_FEED_SEC,
            },
          ]);
        })
        .catch((err: any) => {
          if (cloudPlaylists.length === 0 && browseHubTarget === 'apple_discover') {
            showToast(err?.message || 'Failed to load Cloud Playlists');
          }
        })
        .finally(() => {
          swrInFlightRef.current.delete('apple:cloud_playlists');
          setCloudLoading(false);
        });
    } else if (
      browseHubTarget === 'apple_discover' &&
      (appleSubTab === 'for_you' || appleSubTab === 'radio') &&
      ((radioStations.length === 0 && forYouPlaylists.length === 0 && forYouAlbums.length === 0) ||
        nowUnix - appleForYouFetchedAtRef.current > TTL_FAST_FEED_SEC) &&
      !swrInFlightRef.current.has('apple:for_you_radio')
    ) {
      swrInFlightRef.current.add('apple:for_you_radio');
      const isEmpty =
        radioStations.length === 0 && forYouPlaylists.length === 0 && forYouAlbums.length === 0;
      if (isEmpty) setCloudLoading(true);
      fetchAppleRadioAndForYou()
        .then((res) => {
          setRadioStations(res.stations);
          setPersonalRadioStations(res.personal_stations || []);
          setLiveRadioStations(res.live_stations || []);
          setArtistRadioShows(res.artist_shows || []);
          setClubMixes(res.club_mixes || []);
          setGenreRadioStations(res.genre_stations || []);
          setForYouPlaylists(res.playlists);
          setForYouAlbums(res.albums);
          setForYouNewReleases(res.new_releases || []);
          setForYouShelves(res.shelves || []);
          setAppleRecentlyPlayedTracks(res.recently_played || []);
          appleForYouFetchedAtRef.current = Math.floor(Date.now() / 1000);
          writeCachedShelves([
            {
              cacheKey: 'apple:bundle:for_you_radio',
              provider: 'apple_music',
              shelfId: 'bundle:for_you_radio',
              title: 'Apple For You & Radio',
              data: res,
              ttlSec: TTL_FAST_FEED_SEC,
            },
          ]);
        })
        .catch((err: any) => {
          if (isEmpty) showToast(err?.message || 'Failed to load For You & Radio');
        })
        .finally(() => {
          swrInFlightRef.current.delete('apple:for_you_radio');
          setCloudLoading(false);
        });
    } else if (
      browseHubTarget === 'apple_discover' &&
      appleSubTab === 'new' &&
      ((newFeedAlbums.length === 0 && newFeedPlaylists.length === 0 && newFeedSongs.length === 0) ||
        nowUnix - appleNewFetchedAtRef.current > TTL_CATALOG_FEED_SEC) &&
      !swrInFlightRef.current.has('apple:new_feed')
    ) {
      swrInFlightRef.current.add('apple:new_feed');
      const isEmpty =
        newFeedAlbums.length === 0 && newFeedPlaylists.length === 0 && newFeedSongs.length === 0;
      if (isEmpty) setCloudLoading(true);
      fetchAppleNewFeed()
        .then((res) => {
          setNewFeedRecentReleases(res.recent_releases || []);
          setNewFeedAlbums(res.albums);
          setNewFeedPlaylists(res.playlists);
          setNewFeedSongs(res.songs);
          appleNewFetchedAtRef.current = Math.floor(Date.now() / 1000);
          writeCachedShelves([
            {
              cacheKey: 'apple:bundle:new_feed',
              provider: 'apple_music',
              shelfId: 'bundle:new_feed',
              title: 'Apple New & Charts',
              data: res,
              ttlSec: TTL_CATALOG_FEED_SEC,
            },
          ]);
        })
        .catch((err: any) => {
          if (isEmpty) showToast(err?.message || 'Failed to load Apple Music New feed');
        })
        .finally(() => {
          swrInFlightRef.current.delete('apple:new_feed');
          setCloudLoading(false);
        });
    }
  }, [
    view,
    browseHubTarget,
    sourceVisibility.apple_music,
    snap?.apple_authenticated,
    appleSubTab,
    browserSearch,
    cloudPlaylists.length,
    radioStations.length,
    forYouPlaylists.length,
    forYouAlbums.length,
    newFeedAlbums.length,
    newFeedPlaylists.length,
    newFeedSongs.length,
    showToast,
  ]);

  // 3c. SoundCloud Cloud Hub data loader (Stale-While-Revalidate via servicesCache.db)
  useEffect(() => {
    if (view !== 'browser' || !sourceVisibility.soundcloud) {
      return;
    }
    const nowUnix = Math.floor(Date.now() / 1000);
    const needScLikesSets =
      ((browseHubTarget === 'soundcloud_discover' && soundCloudSubTab === 'likes_sets') ||
        (Boolean(snap?.soundcloud_authenticated) && scPlaylists.length === 0)) &&
      ((scLikedTracks.length === 0 && scPlaylists.length === 0) ||
        nowUnix - scLikesFetchedAtRef.current > TTL_CATALOG_FEED_SEC) &&
      !swrInFlightRef.current.has('sc:likes_sets');
    if (needScLikesSets) {
      swrInFlightRef.current.add('sc:likes_sets');
      const isEmpty = scLikedTracks.length === 0 && scPlaylists.length === 0;
      if (isEmpty && browseHubTarget === 'soundcloud_discover') setCloudLoading(true);
      fetchSoundCloudLikesAndPlaylists()
        .then((res) => {
          setScLikedTracks(res.likedTracks);
          setScPlaylists(res.playlists);
          scLikesFetchedAtRef.current = Math.floor(Date.now() / 1000);
          writeCachedShelves([
            {
              cacheKey: 'soundcloud:bundle:likes_sets',
              provider: 'soundcloud',
              shelfId: 'bundle:likes_sets',
              title: 'SoundCloud Likes & Sets',
              data: res,
              ttlSec: TTL_CATALOG_FEED_SEC,
            },
          ]);
        })
        .catch(() => { })
        .finally(() => {
          swrInFlightRef.current.delete('sc:likes_sets');
          setCloudLoading(false);
        });
    } else if (
      browseHubTarget === 'soundcloud_discover' &&
      soundCloudSubTab === 'stream_radio' &&
      ((scStreamTracks.length === 0 && scStreamPlaylists.length === 0) ||
        nowUnix - scStreamFetchedAtRef.current > TTL_FAST_FEED_SEC) &&
      !swrInFlightRef.current.has('sc:stream_radio')
    ) {
      swrInFlightRef.current.add('sc:stream_radio');
      const isEmpty = scStreamTracks.length === 0 && scStreamPlaylists.length === 0;
      if (isEmpty) setCloudLoading(true);
      fetchSoundCloudStreamAndRadio()
        .then((res) => {
          setScStreamTracks(res.streamTracks);
          setScStreamPlaylists(res.streamPlaylists);
          scStreamFetchedAtRef.current = Math.floor(Date.now() / 1000);
          writeCachedShelves([
            {
              cacheKey: 'soundcloud:bundle:stream_radio',
              provider: 'soundcloud',
              shelfId: 'bundle:stream_radio',
              title: 'SoundCloud Stream & Radio',
              data: res,
              ttlSec: TTL_FAST_FEED_SEC,
            },
          ]);
        })
        .catch(() => { })
        .finally(() => {
          swrInFlightRef.current.delete('sc:stream_radio');
          setCloudLoading(false);
        });
    } else if (
      browseHubTarget === 'soundcloud_discover' &&
      soundCloudSubTab === 'trending'
    ) {
      const genreKey = scSelectedGenre || 'all';
      const lastFetched = scTrendingFetchedAtRef.current[genreKey] || 0;
      const isEmpty =
        scTrendingTracks.length === 0 &&
        scTrendingMixes.length === 0 &&
        scTrendingPlaylists.length === 0;
      if (
        (isEmpty || nowUnix - lastFetched > TTL_FAST_FEED_SEC) &&
        !swrInFlightRef.current.has(`sc:trending:${genreKey}`)
      ) {
        swrInFlightRef.current.add(`sc:trending:${genreKey}`);
        if (isEmpty) setCloudLoading(true);
        fetchSoundCloudDiscover(scSelectedGenre || undefined)
          .then((res) => {
            setScTrendingTracks(res.tracks);
            setScTrendingMixes(res.mixes);
            setScTrendingPlaylists(res.playlists);
            setScMoreOfWhatYouLike(res.more_of_what_you_like || []);
            setScFreshUploads(res.fresh_uploads || []);
            setScRecommendedArtists(res.recommended_artists || []);
            setScDiscoverNextHref(res.next_tracks_href || null);
            scTrendingFetchedAtRef.current[genreKey] = Math.floor(Date.now() / 1000);
            writeCachedShelves([
              {
                cacheKey: `soundcloud:bundle:trending:${genreKey}`,
                provider: 'soundcloud',
                shelfId: `bundle:trending:${genreKey}`,
                title: `SoundCloud Trending (${genreKey})`,
                data: res,
                ttlSec: TTL_FAST_FEED_SEC,
              },
            ]);
          })
          .catch((err: any) => {
            if (isEmpty) showToast(err?.message || 'Failed to load SoundCloud Trending & Mixes');
          })
          .finally(() => {
            swrInFlightRef.current.delete(`sc:trending:${genreKey}`);
            setCloudLoading(false);
          });
      }
    }
  }, [
    view,
    browseHubTarget,
    sourceVisibility.soundcloud,
    snap?.soundcloud_authenticated,
    soundcloudAuthCfg?.soundcloud_authenticated,
    soundCloudSubTab,
    scLikedTracks.length,
    scPlaylists.length,
    scStreamTracks.length,
    scStreamPlaylists.length,
    scTrendingTracks.length,
    scTrendingMixes.length,
    scTrendingPlaylists.length,
    scSelectedGenre,
    showToast,
  ]);

  // Debounced live Apple Music & SoundCloud Catalog Search
  useEffect(() => {
    const term = browserSearch.trim();
    if (!term) {
      setCatalogSearchResults({ songs: [], albums: [], playlists: [], stations: [] });
      setScCatalogSearchResults({ songs: [], playlists: [] });
      return;
    }
    const isAppleIncluded =
      sourceVisibility.apple_music &&
      (selectedSources.length === 0
        ? browserSourceFilter === 'all' || browserSourceFilter === 'apple_music'
        : selectedSources.includes('apple_music'));
    const isScIncluded =
      sourceVisibility.soundcloud &&
      (selectedSources.length === 0
        ? browserSourceFilter === 'all' || browserSourceFilter === 'soundcloud'
        : selectedSources.includes('soundcloud'));
    if (!isAppleIncluded && !isScIncluded) {
      setCatalogSearchResults({ songs: [], albums: [], playlists: [], stations: [] });
      setScCatalogSearchResults({ songs: [], playlists: [] });
      return;
    }
    const timer = window.setTimeout(() => {
      const promises: Promise<any>[] = [];
      if (isAppleIncluded && snap?.apple_authenticated) {
        promises.push(
          searchAppleMusicCatalog(term)
            .then((res) => setCatalogSearchResults(res))
            .catch(() => { })
        );
      } else {
        setCatalogSearchResults({ songs: [], albums: [], playlists: [], stations: [] });
      }
      if (isScIncluded) {
        promises.push(
          searchSoundCloudCatalog(term)
            .then((res) => setScCatalogSearchResults(res))
            .catch(() => { })
        );
      } else {
        setScCatalogSearchResults({ songs: [], playlists: [] });
      }
      if (promises.length > 0) {
        setCloudLoading(true);
        Promise.all(promises).finally(() => setCloudLoading(false));
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    browserSearch,
    browserSourceFilter,
    selectedSources,
    sourceVisibility.apple_music,
    sourceVisibility.soundcloud,
    snap?.apple_authenticated,
    snap?.soundcloud_authenticated,
    soundcloudAuthCfg?.soundcloud_authenticated,
  ]);

  const handleOpenSoundCloudPlaylist = useCallback(
    async (pl: SoundCloudPlaylistSummary) => {
      const initialTracks = pl.tracks && pl.tracks.length > 0 ? pl.tracks : [];
      setActiveScPlaylist(pl);
      setActiveCloudPlaylist(null);
      setActiveCloudAlbum(null);
      setBrowserTracks(initialTracks);
      setBrowserTarget({
        kind: 'soundcloud_playlist',
        id: pl.id,
        title: `☁️ ${pl.name}`,
        subtitle: pl.description,
        art_url: pl.art_url,
      });
      setCloudLoading(true);
      try {
        const tracks = await fetchSoundCloudPlaylistTracks(pl.id);
        if (tracks.length > 0) {
          setBrowserTracks(tracks);
        } else if (initialTracks.length === 0) {
          setBrowserTracks([]);
          showToast(`No streamable tracks available in "${pl.name}"`);
        }
      } catch (err: any) {
        if (initialTracks.length === 0) {
          setBrowserTracks([]);
          showToast(err?.message || 'Could not load SoundCloud set tracks');
        }
      } finally {
        setCloudLoading(false);
      }
    },
    [showToast]
  );

  const handleStartSoundCloudTrackRadio = useCallback(
    (seedTrack: TrackMetadata) => {
      setPlayingContextId(`sc:radio:${seedTrack.uri}`);
      startSoundCloudTrackRadio(seedTrack.uri, seedTrack.title, showToast);
      setView('lock');
    },
    [showToast]
  );

  const handleOpenCloudPlaylist = useCallback(
    async (pl: AppleCloudPlaylistSummary) => {
      setActiveCloudPlaylist(pl);
      setActiveScPlaylist(null);
      setActiveCloudAlbum(null);
      setBrowserTracks([]);
      setBrowserTarget({
        kind: 'cloud_playlist',
        id: pl.id,
        title: pl.name,
        subtitle: pl.description,
        art_url: pl.art_url,
      });
      setCloudLoading(true);
      try {
        const tracks = await fetchApplePlaylistTracks(pl.id, pl.kind);
        setBrowserTracks(tracks);
        const fallbackArt = tracks.find(
          (t) => t.art_url && !t.art_url.includes('blobstore.apple.com')
        )?.art_url;
        if (fallbackArt && (!pl.art_url || pl.art_url.includes('blobstore.apple.com'))) {
          setCloudPlaylists((prev) =>
            prev.map((item) => (item.id === pl.id ? { ...item, art_url: fallbackArt } : item))
          );
          setActiveCloudPlaylist((prev) =>
            prev && prev.id === pl.id ? { ...prev, art_url: fallbackArt } : prev
          );
          setBrowserTarget((prev) =>
            prev && prev.kind === 'cloud_playlist' && prev.id === pl.id
              ? { ...prev, art_url: fallbackArt }
              : prev
          );
        }
      } catch (err: any) {
        showToast(err?.message || 'Could not load playlist tracks');
      } finally {
        setCloudLoading(false);
      }
    },
    [showToast]
  );

  const handleOpenFullAppleAlbum = useCallback(
    async (params: { albumId?: string | null; songUri?: string | null; fallbackTitle?: string }) => {
      setCloudLoading(true);
      if (params.fallbackTitle) {
        showToast(`Loading full album for "${params.fallbackTitle}"...`);
      }
      try {
        const { album, tracks } = await fetchFullAppleAlbum({
          albumId: params.albumId,
          songUri: params.songUri,
        });
        setActiveCloudAlbum(album);
        setActiveCloudPlaylist(null);
        setBrowserTarget({
          kind: 'cloud_album',
          id: album.id,
          title: album.title,
          subtitle: `${album.artist}${album.release_year ? ` • ${album.release_year}` : ''}`,
          art_url: album.art_url,
          content_rating: album.content_rating ?? null,
        });
        setBrowserTracks(tracks);
        setView('browser');
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent('simp-open-collection-in-library'));
        }, 0);
      } catch (err: any) {
        if (snap?.queue && snap.queue.length > 0) {
          setBrowserTracks(snap.queue);
          setBrowserTarget({
            kind: 'cloud_playlist',
            id: 'active_queue',
            title: params.fallbackTitle || 'Active Playback Queue',
            subtitle: `${snap.queue.length} tracks in queue`,
            art_url: snap.current_track?.art_url || null,
          });
          setView('browser');
          window.setTimeout(() => {
            window.dispatchEvent(new CustomEvent('simp-open-collection-in-library'));
          }, 0);
        } else {
          showToast(err?.message || 'Could not resolve full catalog album');
        }
      } finally {
        setCloudLoading(false);
      }
    },
    [showToast, snap?.queue, snap?.current_track?.art_url]
  );

  const handleStartAppleStation = useCallback(
    (st: AppleRadioStationSummary) => {
      const stationUri = `applemusic:station:${st.id}`;
      const stationTrack: TrackMetadata = {
        uri: stationUri,
        title: `📻 ${st.name}`,
        artists: [st.subtitle || 'Apple Music Radio'],
        album: 'Apple Music Radio',
        album_id: null,
        track_number: 1,
        disc_number: 1,
        art_url: st.art_url,
        duration_ms: 0,
        source: 'apple_music',
        mount_root: null,
      };
      setPlayingContextId(`station:${st.id}`);
      defaultSimpClient.loadQueue([stationUri], 0, [stationTrack]);
      showToast(`Tuning into 📻 ${st.name}...`);
      setView('lock');
    },
    [showToast]
  );

  // 4. Volume helpers
  const currentVolume = snap?.volume ?? 0.8;
  const volPct = Math.round(currentVolume * 100);
  const isPlaying = Boolean(snap?.is_playing);

  const applyVolume = useCallback((nextVol: number) => {
    const clamped = Math.max(0.05, Math.min(1, Math.round(nextVol * 100) / 100));
    defaultSimpClient.setVolume(clamped);
  }, []);

  // 5. Continuous OLED Sub-Pixel Shifter (rotates ±2px every 20s) + Universal 30s Idle Auto-Dim
  useEffect(() => {
    const orbitTimer = window.setInterval(() => {
      setOrbitStep((s) => (s + 1) % 8);
    }, 20_000);
    return () => window.clearInterval(orbitTimer);
  }, []);

  const isActiveVideoPlayback = Boolean(
    isUiVideoTrack(snap?.current_track) && snap?.is_playing && view === 'lock'
  );

  const isOverlayOrPopoverOpen = Boolean(
    sourceModalOpen ||
    powerModalOpen ||
    volumePopoverOpen ||
    brightnessPopoverOpen ||
    quickHelpOpen ||
    oskTarget ||
    pendingHybridAdd
  );

  // Auto-dismiss transient volume/brightness popovers after 8s of inactivity so
  // leaving them open never suppresses lock-screen or screensaver idle timers.
  useEffect(() => {
    if (!volumePopoverOpen && !brightnessPopoverOpen) return;

    let dismissTimerId: number | undefined;
    const armDismissTimer = () => {
      if (dismissTimerId) window.clearTimeout(dismissTimerId);
      dismissTimerId = window.setTimeout(() => {
        setVolumePopoverOpen(false);
        setBrightnessPopoverOpen(false);
      }, 8_000);
    };

    armDismissTimer();
    window.addEventListener('pointerdown', armDismissTimer, { passive: true });
    window.addEventListener('wheel', armDismissTimer, { passive: true });
    window.addEventListener('keydown', armDismissTimer);
    window.addEventListener('touchstart', armDismissTimer, { passive: true });
    window.addEventListener('simp-wake-idle', armDismissTimer);

    return () => {
      if (dismissTimerId) window.clearTimeout(dismissTimerId);
      window.removeEventListener('pointerdown', armDismissTimer);
      window.removeEventListener('wheel', armDismissTimer);
      window.removeEventListener('keydown', armDismissTimer);
      window.removeEventListener('touchstart', armDismissTimer);
      window.removeEventListener('simp-wake-idle', armDismissTimer);
    };
  }, [volumePopoverOpen, brightnessPopoverOpen, currentVolume, brightnessPct]);

  useEffect(() => {
    let timerId: number | undefined;
    const resetIdleTimer = () => {
      setIsDimmed(false);
      if (timerId) window.clearTimeout(timerId);
      if (view === 'lock' && !isOverlayOrPopoverOpen) {
        timerId = window.setTimeout(() => setIsDimmed(true), 6_000);
      }
    };

    if (!isDimmed) {
      resetIdleTimer();
    }
    window.addEventListener('pointerdown', resetIdleTimer, { passive: true });
    window.addEventListener('pointermove', resetIdleTimer, { passive: true });
    window.addEventListener('wheel', resetIdleTimer, { passive: true });
    window.addEventListener('keydown', resetIdleTimer);
    window.addEventListener('touchstart', resetIdleTimer, { passive: true });
    window.addEventListener('simp-wake-idle', resetIdleTimer);

    let lastGpSig = '';
    const gpPoll =
      view === 'lock'
        ? window.setInterval(() => {
          const pads = navigator.getGamepads ? navigator.getGamepads() : [];
          for (const p of pads) {
            if (!p) continue;
            const pressed = p.buttons.map((b) => (b.pressed ? '1' : '0')).join('');
            const axes = p.axes.map((a) => (Math.abs(a) > 0.3 ? a.toFixed(1) : '0')).join(',');
            const sig = `${pressed}|${axes}`;
            if (lastGpSig && sig !== lastGpSig) {
              resetIdleTimer();
            }
            lastGpSig = sig;
            break;
          }
        }, 150)
        : undefined;

    return () => {
      if (timerId) window.clearTimeout(timerId);
      if (gpPoll) window.clearInterval(gpPoll);
      window.removeEventListener('pointerdown', resetIdleTimer);
      window.removeEventListener('pointermove', resetIdleTimer);
      window.removeEventListener('wheel', resetIdleTimer);
      window.removeEventListener('keydown', resetIdleTimer);
      window.removeEventListener('touchstart', resetIdleTimer);
      window.removeEventListener('simp-wake-idle', resetIdleTimer);
    };
  }, [view, isOverlayOrPopoverOpen, isDimmed]);

  useEffect(() => {
    document.documentElement.dataset.impDesktopMode = desktopMode ? 'true' : 'false';
  }, [desktopMode]);

  useEffect(() => {
    document.documentElement.dataset.impDesktopScreensaver = desktopScreensaverActive
      ? 'true'
      : 'false';
  }, [desktopScreensaverActive]);

  const prevDesktopVideoUriRef = useRef<string | null>(null);
  useEffect(() => {
    const curUri = snap?.current_track?.uri || null;
    if (curUri === prevDesktopVideoUriRef.current) return;
    prevDesktopVideoUriRef.current = curUri;
    if (desktopMode && isUiVideoTrack(snap?.current_track)) {
      setDesktopScreensaverActive(false);
      setViewState('lock');
    }
  }, [desktopMode, snap?.current_track]);

  useEffect(() => {
    if (view !== 'browser') {
      setDesktopScreensaverActive(false);
      setLibraryIdleDimmed(false);
      return;
    }

    if (!isPlaying) {
      setDesktopScreensaverActive(false);
    }

    if (isPlaying && desktopMode && desktopVizIdleSec <= 0) {
      setDesktopScreensaverActive(false);
      setLibraryIdleDimmed(false);
      return;
    }

    const idleSec = desktopVizIdleSec > 0 ? desktopVizIdleSec : 30;
    let timerId: number | undefined;
    const armTimer = () => {
      if (timerId) window.clearTimeout(timerId);
      timerId = window.setTimeout(() => {
        const activeTag = document.activeElement?.tagName;
        const isTyping =
          activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT';
        const modalOpen =
          isOverlayOrPopoverOpen ||
          isTyping ||
          Boolean(document.querySelector('[data-modal-root="true"], [data-osk-root="true"]'));
        if (modalOpen) {
          armTimer();
          return;
        }
        if (isPlaying && desktopMode && desktopVizIdleSec > 0) {
          screensaverPointerGraceUntilRef.current = performance.now() + 350;
          setDesktopScreensaverActive(true);
          setLibraryIdleDimmed(false);
        } else {
          setDesktopScreensaverActive(false);
          setLibraryIdleDimmed(true);
        }
      }, idleSec * 1000);
    };

    const onUserActivity = (ev?: Event) => {
      if (
        ev?.type === 'pointermove' &&
        performance.now() < screensaverPointerGraceUntilRef.current
      ) {
        return;
      }
      setDesktopScreensaverActive(false);
      setLibraryIdleDimmed(false);
      armTimer();
    };

    armTimer();
    window.addEventListener('pointerdown', onUserActivity, { passive: true });
    window.addEventListener('pointermove', onUserActivity, { passive: true });
    window.addEventListener('wheel', onUserActivity, { passive: true });
    window.addEventListener('keydown', onUserActivity);
    window.addEventListener('touchstart', onUserActivity, { passive: true });
    window.addEventListener('simp-wake-idle', onUserActivity);

    let lastGpSig = '';
    const gpPoll = window.setInterval(() => {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      for (const p of pads) {
        if (!p) continue;
        const pressed = p.buttons.map((b) => (b.pressed ? '1' : '0')).join('');
        const axes = p.axes.map((a) => (Math.abs(a) > 0.3 ? a.toFixed(1) : '0')).join(',');
        const sig = `${pressed}|${axes}`;
        if (lastGpSig && sig !== lastGpSig) {
          onUserActivity();
        }
        lastGpSig = sig;
        break;
      }
    }, 200);

    return () => {
      if (timerId) window.clearTimeout(timerId);
      window.clearInterval(gpPoll);
      window.removeEventListener('pointerdown', onUserActivity);
      window.removeEventListener('pointermove', onUserActivity);
      window.removeEventListener('wheel', onUserActivity);
      window.removeEventListener('keydown', onUserActivity);
      window.removeEventListener('touchstart', onUserActivity);
      window.removeEventListener('simp-wake-idle', onUserActivity);
    };
  }, [desktopMode, view, desktopVizIdleSec, isOverlayOrPopoverOpen, isPlaying]);

  // 6 & 7. Gamepad / Spatial Focus Navigation Hook
  const { applyFocusMarker } = useGamepadNavigation({
    view,
    setView,
    sourceModalOpen,
    setSourceModalOpen,
    powerModalOpen,
    setPowerModalOpen,
    volumePopoverOpen,
    setVolumePopoverOpen,
    brightnessPopoverOpen,
    setBrightnessPopoverOpen,
    confirmHardReset,
    setConfirmHardReset,
    isSleeping,
    setIsSleeping,
    setIsDimmed,
    oskTarget,
    setOskTarget,
    activeCloudAlbum,
    setActiveCloudAlbum,
    activeCloudPlaylist,
    setActiveCloudPlaylist,
    shuffle: Boolean(snap?.shuffle),
    currentVolume,
    applyVolume,
  });

  const [trackPropertiesTarget, setTrackPropertiesTarget] =
    useState<TrackPropertiesTarget | null>(null);
  const [expiredAuthAlert, setExpiredAuthAlert] = useState<{
    provider: ExpiredAuthProvider;
    label: string;
    reason?: string;
  } | null>(null);
  const [expiredAuthProviders, setExpiredAuthProviders] = useState<ExpiredAuthProvider[]>([]);
  const toastedExpiredProvidersRef = useRef<Set<ExpiredAuthProvider>>(new Set());

  const openConnectedAccountsModal = useCallback(() => {
    setVolumePopoverOpen(false);
    setBrightnessPopoverOpen(false);
    setPowerModalOpen(false);
    setInitialOpenFoldersAccounts(true);
    setSourceModalOpen(true);
  }, []);

  const markProviderExpired = useCallback(
    (provider: ExpiredAuthProvider, _reason?: string) => {
      setExpiredAuthProviders((prev) => (prev.includes(provider) ? prev : [...prev, provider]));
      if (!toastedExpiredProvidersRef.current.has(provider)) {
        toastedExpiredProvidersRef.current.add(provider);
        const label = provider === 'apple' ? 'Apple Music' : 'SoundCloud';
        showToast(`${label} session expired — open START → Accounts to reconnect`);
      }
    },
    [showToast]
  );

  const clearProviderExpired = useCallback(
    (provider: ExpiredAuthProvider, triggerRevalidate = true) => {
      toastedExpiredProvidersRef.current.delete(provider);
      setExpiredAuthProviders((prev) =>
        prev.includes(provider) ? prev.filter((p) => p !== provider) : prev
      );
      setExpiredAuthAlert((prev) => (prev && prev.provider === provider ? null : prev));
      if (triggerRevalidate) {
        clearFypProviderAuthErrorsAndRevalidate(
          provider === 'apple' ? 'apple_music' : 'soundcloud'
        );
      }
    },
    []
  );
  const [pendingDroppedFolder, setPendingDroppedFolder] = useState<string | null>(null);
  const mountsRef = useRef<Array<{ mount_root: string }>>([]);
  mountsRef.current = snap?.mounts || [];

  const findCoveringParentMount = useCallback(
    (candidatePath: string, mountsList: Array<{ mount_root: string }>): string | null => {
      const normalizeForPrefix = (raw: string) => {
        let p = raw.trim().replace(/^["']+|["']+$/g, '').replace(/\\/g, '/').replace(/\/+$/, '');
        const winDrive = p.match(/^([a-zA-Z]):\/(.*)$/);
        if (winDrive) {
          p = `/mnt/${winDrive[1].toLowerCase()}/${winDrive[2]}`;
        }
        if (p.startsWith('/mnt/') || /^[a-zA-Z]:/.test(raw.trim())) {
          return { norm: p.toLowerCase(), raw: p };
        }
        return { norm: p, raw: p };
      };
      const cand = normalizeForPrefix(candidatePath);
      if (!cand.norm) return null;
      for (const m of mountsList) {
        const root = normalizeForPrefix(m.mount_root);
        if (!root.norm) continue;
        if (
          cand.norm === root.norm ||
          (root.norm === '/' ? cand.norm.startsWith('/') : cand.norm.startsWith(`${root.norm}/`))
        ) {
          return m.mount_root;
        }
      }
      return null;
    },
    []
  );

  const openLocalMountInBrowser = useCallback(
    (mountRoot: string, targetPath?: string, toastMsg?: string) => {
      const subpath = targetPath ? computeRelativeSubpath(mountRoot, targetPath) : '';
      if (toastMsg) {
        showToast(toastMsg);
      } else if (subpath) {
        showToast(`Already indexed — opening "${subpath}"`);
      } else {
        showToast(`Already indexed under "${mountRoot}" — opening folder`);
      }
      setSourceModalOpen(false);
      setView('browser');
      window.dispatchEvent(
        new CustomEvent('simp-open-local-mount', { detail: { path: mountRoot, subpath } })
      );
    },
    [setView, showToast]
  );
  const openLocalMountInBrowserRef = useRef(openLocalMountInBrowser);
  openLocalMountInBrowserRef.current = openLocalMountInBrowser;

  useEffect(() => {
    const onOpenTrackProps = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (detail && detail.uri) {
        setTrackPropertiesTarget(detail);
      }
    };
    window.addEventListener('simp-open-track-properties', onOpenTrackProps);
    return () => window.removeEventListener('simp-open-track-properties', onOpenTrackProps);
  }, []);

  // Proactive Auth Probe (startup + every 30 minutes) + reactive auth expiry/restore listeners
  useEffect(() => {
    const runProbe = async () => {
      try {
        const resp = await fetch(resolveDaemonUrl('/api/auth/probe'));
        const json = await resp.json();
        if (!json?.ok || !json.data) return;
        const { apple, soundcloud } = json.data;
        if (apple?.was_connected && apple?.expired) {
          markProviderExpired('apple', apple.reason);
        } else if (apple?.was_connected && !apple?.expired) {
          clearProviderExpired('apple', false);
        }
        if (soundcloud?.was_connected && soundcloud?.expired) {
          markProviderExpired('soundcloud', soundcloud.reason);
        } else if (soundcloud?.was_connected && !soundcloud?.expired) {
          clearProviderExpired('soundcloud', false);
        }

        if (localStorage.getItem('simp_mute_auth_reminders') === '1') return;
        if (apple?.was_connected && apple?.expired) {
          setExpiredAuthAlert({
            provider: 'apple',
            label: 'Apple Music',
            reason: apple.reason,
          });
        } else if (soundcloud?.was_connected && soundcloud?.expired) {
          setExpiredAuthAlert({
            provider: 'soundcloud',
            label: 'SoundCloud',
            reason: soundcloud.reason,
          });
        }
      } catch { }
    };
    const initialTimer = window.setTimeout(runProbe, 3500);
    const interval = window.setInterval(runProbe, 30 * 60 * 1000);
    const onAuthExpired = (ev: Event) => {
      const detail = (ev as CustomEvent<{ provider?: ExpiredAuthProvider; reason?: string }>)
        .detail;
      if (detail?.provider === 'apple' || detail?.provider === 'soundcloud') {
        markProviderExpired(detail.provider, detail.reason);
      }
    };
    const onAuthRestored = (ev: Event) => {
      const detail = (ev as CustomEvent<{ provider?: ExpiredAuthProvider }>).detail;
      if (detail?.provider === 'apple' || detail?.provider === 'soundcloud') {
        clearProviderExpired(detail.provider, true);
      }
    };
    window.addEventListener('imp-auth-expired', onAuthExpired);
    window.addEventListener('imp-auth-restored', onAuthRestored);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(interval);
      window.removeEventListener('imp-auth-expired', onAuthExpired);
      window.removeEventListener('imp-auth-restored', onAuthRestored);
    };
  }, [markProviderExpired, clearProviderExpired]);

  useEffect(() => {
    if (snap?.apple_authenticated && expiredAuthProviders.includes('apple')) {
      clearProviderExpired('apple', true);
    }
  }, [snap?.apple_authenticated, expiredAuthProviders, clearProviderExpired]);

  useEffect(() => {
    if (
      soundcloudAuthCfg?.soundcloud_authenticated &&
      soundcloudAuthCfg?.auth_mode === 'user' &&
      expiredAuthProviders.includes('soundcloud')
    ) {
      clearProviderExpired('soundcloud', true);
    }
  }, [
    soundcloudAuthCfg?.soundcloud_authenticated,
    soundcloudAuthCfg?.auth_mode,
    expiredAuthProviders,
    clearProviderExpired,
  ]);

  // Global Window Drag-and-Drop Interceptor (Folder Ingestion Only — Never Navigate or Play Unindexed Files)
  useEffect(() => {
    const supportedExts = new Set([
      'flac',
      'mp3',
      'wav',
      'm4a',
      'aac',
      'ogg',
      'opus',
      'aiff',
      'aif',
      'wma',
      'alac',
      'mp4',
      'mkv',
      'webm',
      'mov',
      'avi',
      'm4v',
    ]);

    const onDragOver = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
    };

    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const dt = e.dataTransfer;
      if (!dt) return;

      const items = Array.from(dt.items || []);
      const files = Array.from(dt.files || []);
      let hasDirectory = false;
      let droppedFolderName = '';
      let droppedDirEntry: any = null;
      for (const item of items) {
        const entry = (item as any).webkitGetAsEntry ? (item as any).webkitGetAsEntry() : null;
        if (entry && entry.isDirectory) {
          hasDirectory = true;
          if (!droppedDirEntry) droppedDirEntry = entry;
          if (!droppedFolderName && entry.name) {
            droppedFolderName = String(entry.name);
          }
        }
      }

      let supportedFileFound = false;
      let unsupportedExt: string | null = null;
      let sampleMediaFile: File | null = null;
      for (const f of files) {
        const parts = f.name.split('.');
        if (parts.length > 1) {
          const ext = parts[parts.length - 1].toLowerCase();
          if (supportedExts.has(ext)) {
            supportedFileFound = true;
            if (!sampleMediaFile) sampleMediaFile = f;
          } else {
            unsupportedExt = `.${ext}`;
          }
        }
      }

      if (!hasDirectory && !supportedFileFound && unsupportedExt) {
        showToast(
          `Unsupported filetype (${unsupportedExt}) — drop audio/video files or a media folder to index`,
        );
        return;
      }

      const stripVerbatimPrefix = (p: string) =>
        p.replace(/^(\\\\?\\\?\\|\/\/\?\/|\/\?\/)/, '');

      // Extract native filesystem path if exposed by Tauri/WebView or URI list
      let extractedPath = '';
      const uriList = dt.getData('text/uri-list') || dt.getData('text/plain') || '';
      const firstLine = uriList
        .split(/\r?\n/)
        .map((l) => l.trim())
        .find((l) => l && !l.startsWith('#'));

      if (files.length > 0 && (files[0] as any).path) {
        const rawPath = stripVerbatimPrefix(String((files[0] as any).path));
        if (hasDirectory) {
          extractedPath = rawPath;
        } else {
          extractedPath = rawPath.replace(/[\\/][^\\/]+$/, '');
        }
      } else if (firstLine) {
        const cleaned = stripVerbatimPrefix(
          decodeURIComponent(firstLine.replace(/^file:\/\/\/?/i, '')),
        );
        if (cleaned.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(cleaned)) {
          extractedPath = hasDirectory ? cleaned : cleaned.replace(/[\\/][^\\/]+$/, '');
        }
      }

      const resolveViaDaemon = (childHint: string | null) => {
        fetch('/api/fs/resolve-drop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            folder_name:
              droppedFolderName || (hasDirectory && files[0]?.name ? files[0].name : null),
            child_name: childHint,
            file_name: sampleMediaFile ? sampleMediaFile.name : null,
            file_size: sampleMediaFile ? sampleMediaFile.size : null,
            uri_hint: firstLine || null,
          }),
        })
          .then((r) => r.json())
          .then((res) => {
            if (res && res.ok && res.resolved_folder) {
              const resolved = stripVerbatimPrefix(String(res.resolved_folder));
              const covering = findCoveringParentMount(resolved, mountsRef.current);
              if (covering) {
                openLocalMountInBrowserRef.current(covering, resolved);
              } else {
                setPendingDroppedFolder(resolved);
              }
            } else {
              setSourceModalOpen(true);
              showToast('Select the folder in Local Folders -> [Browse...] to index it into Imp');
            }
          })
          .catch(() => {
            setSourceModalOpen(true);
            showToast('Select the folder in Local Folders -> [Browse...] to index it into Imp');
          });
      };

      if (extractedPath) {
        const covering = findCoveringParentMount(extractedPath, mountsRef.current);
        if (covering) {
          openLocalMountInBrowserRef.current(covering, extractedPath);
        } else {
          setPendingDroppedFolder(extractedPath);
        }
      } else if (hasDirectory || supportedFileFound) {
        if (droppedDirEntry && typeof droppedDirEntry.createReader === 'function') {
          let settled = false;
          const finish = (childHint: string | null) => {
            if (settled) return;
            settled = true;
            resolveViaDaemon(childHint);
          };
          const timer = window.setTimeout(() => finish(null), 180);
          try {
            droppedDirEntry.createReader().readEntries(
              (entries: any[]) => {
                window.clearTimeout(timer);
                const firstChild = (entries || []).find(
                  (en) => en && en.name && !String(en.name).startsWith('.'),
                );
                finish(firstChild ? String(firstChild.name) : null);
              },
              () => {
                window.clearTimeout(timer);
                finish(null);
              },
            );
          } catch {
            window.clearTimeout(timer);
            finish(null);
          }
        } else {
          resolveViaDaemon(null);
        }
      }
    };

    window.addEventListener('dragover', onDragOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  // 8. Playlist & Custom Folder Handlers
  const handleCreatePlaylist = async () => {
    const trimmed = newPlaylistName.trim();
    if (!trimmed) return;
    try {
      const created = await defaultSimpClient.query<PlaylistRecord>('create_playlist', {
        name: trimmed,
        description: 'Created in Imp',
      });
      setNewPlaylistName('');
      setCreatingPlaylist(false);
      setActivePlaylistId(created.id);
      refreshLibraryData();
      setBrowserTarget({ kind: 'playlist', id: created.id });
      showToast(`Created playlist "${created.name}"`);
    } catch {
      showToast('Failed to create playlist');
    }
  };

  const commitAddTracksToPlaylist = async (
    uris: string[],
    label: string,
    trackMetadata?: TrackMetadata[],
    explicitPlaylistId?: string,
    createNewName?: string
  ) => {
    if (uris.length === 0) return;
    try {
      const appleTracks = (trackMetadata || browserTracks).filter(
        (t) => t.source === 'apple_music' && uris.includes(t.uri)
      );
      if (appleTracks.length > 0) {
        defaultSimpClient.importCatalogTracks({
          source: 'apple_music',
          album: null,
          playlist: null,
          tracks: appleTracks,
        });
      }
      const scTracks = (trackMetadata || browserTracks).filter(
        (t) => t.source === 'soundcloud' && uris.includes(t.uri)
      );
      if (scTracks.length > 0) {
        defaultSimpClient.importCatalogTracks({
          source: 'soundcloud',
          album: null,
          playlist: null,
          tracks: scTracks,
        });
      }
      const iaTracks = (trackMetadata || browserTracks).filter(
        (t) =>
          (t.source === 'internet_archive' ||
            t.source === 'ia_video' ||
            t.source === 'local_video' ||
            t.source === 'dvd') &&
          uris.includes(t.uri)
      );
      if (iaTracks.length > 0) {
        defaultSimpClient.importCatalogTracks({
          source: 'internet_archive',
          album: null,
          playlist: null,
          tracks: iaTracks,
        });
      }

      const writablePlaylists = playlists.filter((p) => p.origin === 'simp_local');
      let targetPlId = '';
      let targetPlName = 'Favorites';

      if (createNewName !== undefined) {
        const trimmedName = createNewName.trim() || 'New Imp Playlist';
        const created = await defaultSimpClient.query<PlaylistRecord>('create_playlist', {
          name: trimmedName,
          description: 'Hybrid Local + Apple Music Imp playlist',
        });
        targetPlId = created.id;
        targetPlName = created.name;
        setActivePlaylistId(created.id);
        setNewPlaylistName('');
      } else if (explicitPlaylistId) {
        const found = playlists.find((p) => p.id === explicitPlaylistId);
        if (found && found.origin && found.origin !== 'simp_local') {
          await fetch('/api/library/playlists/convert-to-hybrid', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playlist_id: found.id }),
          }).catch(() => { });
        }
        targetPlId = found?.id || explicitPlaylistId;
        targetPlName = found?.name || 'Imp Playlist';
        setActivePlaylistId(targetPlId);
      } else if (writablePlaylists.length === 1) {
        targetPlId = writablePlaylists[0].id;
        targetPlName = writablePlaylists[0].name;
        setActivePlaylistId(targetPlId);
      } else {
        const selectedWritable = writablePlaylists.find((p) => p.id === activePlaylistId);
        targetPlId = selectedWritable?.id || '';
        targetPlName = selectedWritable?.name || 'Favorites';
      }

      if (!targetPlId) {
        const created = await defaultSimpClient.query<PlaylistRecord>('create_playlist', {
          name: 'Favorites',
          description: 'Hybrid Local + Apple Music Imp playlist',
        });
        targetPlId = created.id;
        targetPlName = created.name;
        setActivePlaylistId(created.id);
      }

      await defaultSimpClient.query('add_tracks_to_playlist', {
        playlist_id: targetPlId,
        uris,
      });
      refreshLibraryData();
      if (browserTarget?.kind === 'playlist' && browserTarget.id === targetPlId) {
        const updated = await defaultSimpClient.query<TrackMetadata[]>('get_playlist_items', {
          playlist_id: targetPlId,
          limit: 2000,
          offset: 0,
        });
        setBrowserTracks(updated);
      }
      showToast(`Added ${label} to "★ ${targetPlName}"`);
    } catch {
      showToast('Could not add tracks to playlist');
    }
  };

  const handleAddTracksToPlaylist = async (
    uris: string[],
    label: string,
    trackMetadata?: TrackMetadata[]
  ) => {
    if (uris.length === 0) return;
    // Always open the playlist picker so users can pick an existing playlist,
    // update an editable online Apple/SoundCloud collection, or create a new playlist.
    setPendingHybridAdd({
      uris,
      label,
      trackMetadata,
      creatingNew: false,
    });
    window.setTimeout(() => {
      const firstChoice = document.querySelector<HTMLElement>(
        '[data-hybrid-picker-modal="true"] button[data-default-focus="true"], [data-hybrid-picker-modal="true"] button:not([disabled])'
      );
      if (firstChoice) applyFocusMarker(firstChoice);
    }, 30);
  };

  const handleFavoriteTrack = async (favTrack: TrackMetadata) => {
    const isCurrentlyFav = favoritedUris.includes(favTrack.uri);
    const nextFav = !isCurrentlyFav;
    setFavoritedUris((prev) =>
      nextFav
        ? prev.includes(favTrack.uri)
          ? prev
          : [favTrack.uri, ...prev]
        : prev.filter((u) => u !== favTrack.uri)
    );
    fetch(resolveDaemonUrl(`/api/favorites?favorited=${nextFav ? '1' : '0'}`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(favTrack),
    }).catch(() => { });

    if (favTrack.source === 'apple_music') {
      setAppleItemFavorited(favTrack.uri, 'songs', nextFav, showToast).catch(() => { });
    } else if (favTrack.source === 'soundcloud') {
      if (nextFav) {
        likeSoundCloudTrack(favTrack.uri, showToast).catch(() => { });
        setScLikedTracks((prev) =>
          prev.some((t) => t.uri === favTrack.uri) ? prev : [favTrack, ...prev]
        );
      } else {
        unlikeSoundCloudTrack(favTrack.uri, showToast).catch(() => { });
        setScLikedTracks((prev) => prev.filter((t) => t.uri !== favTrack.uri));
      }
    }

    const writablePlaylists = playlists.filter((p) => p.origin === 'simp_local');
    const favPl = writablePlaylists.find(
      (p) =>
        p.name.toLowerCase().includes('favorite') ||
        p.name.toLowerCase().includes('liked')
    );
    if (nextFav) {
      if (favPl) {
        await commitAddTracksToPlaylist(
          [favTrack.uri],
          `"${favTrack.title}"`,
          [favTrack],
          favPl.id
        );
      } else {
        await commitAddTracksToPlaylist(
          [favTrack.uri],
          `"${favTrack.title}"`,
          [favTrack],
          undefined,
          '❤️ Favorites'
        );
      }
    } else if (favPl) {
      await defaultSimpClient
        .query('remove_track_from_playlist', {
          playlist_id: favPl.id,
          track_uri: favTrack.uri,
        })
        .catch(() => { });
      refreshLibraryData();
      if (favTrack.source !== 'apple_music' && favTrack.source !== 'soundcloud') {
        showToast(`Removed "${favTrack.title}" from ❤️ Favorites`);
      }
    }
  };

  const handleAddAppleToCloudLibrary = useCallback(
    async (
      idOrUri: string,
      kind: 'songs' | 'albums' | 'playlists' = 'songs',
      label?: string
    ) => {
      try {
        await addAppleItemToCloudLibrary(idOrUri, kind, (msg) => {
          showToast(label ? `☁️ Added "${label}" to Apple Music Cloud Library!` : msg);
        });
        window.dispatchEvent(
          new CustomEvent('simp-apple-library-updated', { detail: { idOrUri, kind } })
        );
        if (kind === 'playlists') {
          fetchAppleCloudPlaylists()
            .then((list) => {
              setCloudPlaylists(list);
              applePlaylistsFetchedAtRef.current = Math.floor(Date.now() / 1000);
              writeCachedShelves([
                {
                  cacheKey: 'apple:bundle:cloud_playlists',
                  provider: 'apple_music',
                  shelfId: 'bundle:cloud_playlists',
                  title: 'Apple Cloud Playlists',
                  data: list,
                  ttlSec: TTL_CATALOG_FEED_SEC,
                },
              ]);
            })
            .catch(() => { });
        }
      } catch (err: any) {
        showToast(err?.message || 'Could not add to Apple Music Cloud Library');
      }
    },
    [showToast]
  );

  const handleMoreByArtist = (
    artistName: string,
    preferredSource?: string,
    artistId?: string
  ) => {
    const cleaned = artistName.trim();
    if (!cleaned) return;
    const raw = (preferredSource || snap?.current_track?.source || '').toLowerCase();
    let mapped: 'local' | 'apple_music' | 'soundcloud' | 'internet_archive' = 'local';
    if (raw === 'apple_music') mapped = 'apple_music';
    else if (raw === 'soundcloud') mapped = 'soundcloud';
    else if (raw === 'internet_archive' || raw === 'ia_video') mapped = 'internet_archive';
    setSearchPreferredSource(mapped);
    setView('browser');
    if (mapped === 'internet_archive') {
      setSelectedSources(['internet_archive']);
      setBrowserSourceFilterState('internet_archive');
      setBrowserSearch(cleaned);
    } else {
      window.setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('simp-open-artist-profile', {
            detail: {
              artistName: cleaned,
              source: mapped,
              artistId: artistId || null,
            },
          })
        );
      }, 20);
    }
  };

  // Automatically reset `browserSourceFilter` to `'all'` if the user disconnects or is not signed into that service
  useEffect(() => {
    if (!snap) return;
    if (browserSourceFilter === 'apple_music' && !snap.apple_authenticated) {
      setBrowserSourceFilter('all');
    } else if (
      browserSourceFilter === 'internet_archive' &&
      !snap.internet_archive_authenticated
    ) {
      setBrowserSourceFilter('all');
    }
  }, [
    snap?.apple_authenticated,
    snap?.soundcloud_authenticated,
    snap?.internet_archive_authenticated,
    browserSourceFilter,
  ]);

  const handleRemoveTrackFromPlaylist = async (playlistId: string, trackUri: string, title: string) => {
    try {
      await defaultSimpClient.query('remove_track_from_playlist', {
        playlist_id: playlistId,
        track_uri: trackUri,
      });
      refreshLibraryData();
      if (browserTarget?.kind === 'playlist' && browserTarget.id === playlistId) {
        const updated = await defaultSimpClient.query<TrackMetadata[]>('get_playlist_items', {
          playlist_id: playlistId,
          limit: 2000,
          offset: 0,
        });
        setBrowserTracks(updated);
      }
      showToast(`Removed "${title}" from playlist`);
    } catch {
      showToast('Could not remove track from playlist');
    }
  };

  const handleDeletePlaylist = async (playlistId: string, playlistName: string) => {
    try {
      await defaultSimpClient.query('delete_playlist', { playlist_id: playlistId });
      if (playlistId.startsWith('soundcloud:playlist:')) {
        setSoundCloudPlaylistLiked(playlistId, false).catch(() => { });
      }
      setBrowserTarget((prev) =>
        prev?.kind === 'playlist' && prev.id === playlistId
          ? albums.length > 0
            ? { kind: 'album', id: albums[0].id }
            : null
          : prev
      );
      setActivePlaylistId((prev) => (prev === playlistId ? '' : prev));
      refreshLibraryData();
      showToast(`Removed playlist "${playlistName}" from Imp`);
    } catch {
      showToast('Could not remove playlist');
    }
  };

  const handleDeleteAlbum = async (albumId: string, albumTitle: string) => {
    try {
      await defaultSimpClient.query('delete_album', { album_id: albumId });
      setBrowserTarget((prev) =>
        prev?.kind === 'album' && prev.id === albumId
          ? albums.length > 1
            ? { kind: 'album', id: albums.find((a) => a.id !== albumId)?.id || '' }
            : null
          : prev
      );
      refreshLibraryData();
      showToast(`Unpinned album "${albumTitle}" from Imp`);
    } catch {
      showToast('Could not remove album');
    }
  };

  const handlePinCloudPlaylist = async (
    pl: AppleCloudPlaylistSummary,
    preloadedTracks?: TrackMetadata[]
  ) => {
    setCloudLoading(true);
    try {
      await pinApplePlaylistToSimp(pl, preloadedTracks, showToast);
      refreshLibraryData();
    } catch (err: any) {
      showToast(err?.message || 'Failed to pin playlist to Imp');
    } finally {
      setCloudLoading(false);
    }
  };

  const handlePinCloudAlbum = async (album: AppleCloudAlbumSummary, tracks: TrackMetadata[]) => {
    setCloudLoading(true);
    try {
      await pinAppleAlbumToSimp(album, tracks, showToast);
      refreshLibraryData();
    } catch (err: any) {
      showToast(err?.message || 'Failed to pin album to Imp');
    } finally {
      setCloudLoading(false);
    }
  };

  const handlePinSoundCloudPlaylist = async (
    pl: SoundCloudPlaylistSummary,
    preloadedTracks?: TrackMetadata[]
  ) => {
    setCloudLoading(true);
    try {
      await pinSoundCloudPlaylistToSimp(pl, preloadedTracks, showToast);
      refreshLibraryData();
    } catch (err: any) {
      showToast(err?.message || 'Failed to pin SoundCloud set to Imp');
    } finally {
      setCloudLoading(false);
    }
  };

  const handleAddFolder = (folderPath: string, opts?: { navigateAfterAdd?: boolean }) => {
    const cleaned = folderPath.trim();
    if (!cleaned) return;
    const covering = findCoveringParentMount(cleaned, mountsRef.current);
    if (covering) {
      if (opts?.navigateAfterAdd) {
        openLocalMountInBrowser(covering, cleaned);
      } else {
        showToast(`Already included under parent Local Folder: ${covering}`);
      }
      return;
    }
    defaultSimpClient.addLibraryPath(cleaned);
    setCustomFolderPath('');
    showToast(`Scanning folder: ${cleaned}`);
    if (opts?.navigateAfterAdd) {
      openLocalMountInBrowser(cleaned, undefined, `Scanning folder: ${cleaned}`);
    }
    window.setTimeout(() => refreshLibraryData(), 700);
  };

  const handleRemoveFolder = (mountRoot: string, label: string) => {
    defaultSimpClient.removeLibraryPath(mountRoot);
    showToast(`Removed folder: ${label}`);
    window.setTimeout(() => refreshLibraryData(), 350);
  };

  const track = snap?.current_track;
  const isNavBarHidden = view === 'lock' && isDimmed && !isOverlayOrPopoverOpen;

  return (
    <div
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement | null;
        if (!target) return;
        if (
          target.closest(
            'button, input, select, textarea, a, [role="button"], [data-osk-root="true"], [data-modal-root="true"], [data-focusable="true"]'
          )
        ) {
          return;
        }
        if (view === 'lock') {
          window.dispatchEvent(new CustomEvent('simp-player-fullscreen-toggle'));
        } else {
          toggleAppFullscreen();
        }
      }}
      style={{
        width: '100%',
        maxWidth: '100vw',
        height: '100%',
        maxHeight: '100vh',
        boxSizing: 'border-box',
        overflow: 'hidden',
        background:
          isDimmed || isSleeping || desktopScreensaverActive
            ? '#000000'
            : 'var(--imp-bg-canvas, #121418)',
        color: 'var(--imp-text-primary, #eef0f4)',
        display: 'flex',
        flexDirection: 'column',
        opacity: activeOpacity,
        transform: isActiveVideoPlayback ? undefined : `translate3d(${orbitX}px, ${orbitY}px, 0)`,
        transition: 'opacity 450ms ease, transform 4000ms linear',
        position: 'relative',
      }}
    >
      {/* Headless Apple Music Virtual Sink Bridge (MusicKit v3) */}
      <AppleMusicDriver />

      {/* Gamepad & Keyboard Focus Ring Style + Adaptive Input Modality (`data-simp-input="pointer" | "gamepad"`) */}
      <style>{`
        button:focus, button:focus-visible,
        input:focus, input:focus-visible,
        select:focus, select:focus-visible,
        [data-focusable="true"]:focus, [data-focusable="true"]:focus-visible,
        .simp-gpfocus, [data-simp-active-focus="true"] {
          outline: 2px solid var(--imp-focus-ring, #e8b86d) !important;
          outline-offset: 2px !important;
          box-shadow: 0 0 0 3px var(--imp-focus-glow, rgba(232, 184, 109, 0.26)) !important;
        }
        html[data-simp-input="pointer"] .simp-gp-badge {
          display: none !important;
        }
        html[data-simp-input="gamepad"] .simp-mouse-only {
          display: none !important;
        }
        html[data-simp-input="pointer"] .simp-gpfocus,
        html[data-simp-input="pointer"] [data-simp-active-focus="true"],
        html[data-simp-input="pointer"] button:focus:not(:focus-visible) {
          outline: none !important;
          box-shadow: none !important;
        }
      `}</style>

      {/* True-Black OLED Sleep Screen (Wake on Tap or Any Controller Button) */}
      {isSleeping && (
        <div
          onPointerDown={(e) => {
            e.stopPropagation();
            setIsSleeping(false);
            setIsDimmed(false);
          }}
          onClick={(e) => {
            e.stopPropagation();
            setIsSleeping(false);
            setIsDimmed(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            background: '#000000',
            zIndex: 120,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            userSelect: 'none',
          }}
        >
          <div
            style={{
              transform: `translate3d(${orbitX * 3}px, ${orbitY * 3}px, 0)`,
              transition: 'transform 4000ms linear',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 6,
              opacity: 0.22,
              color: '#71717a',
              fontFamily: 'monospace',
              fontSize: 12,
              textAlign: 'center',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <ImpIcon name="moon" size={12} /> Imp Screen Sleep • {snap?.is_playing && track ? `▶ ${track.title}` : 'Standby'}
            </span>
            <span style={{ fontSize: 11 }}>Tap anywhere or press any button to wake</span>
          </div>
        </div>
      )}

      {/* Backdrop for Top-Right Volume / Brightness Vertical Slider Popovers */}
      {(volumePopoverOpen || brightnessPopoverOpen) && (
        <div
          onClick={() => {
            setVolumePopoverOpen(false);
            setBrightnessPopoverOpen(false);
          }}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 35,
          }}
        />
      )}

      {/* Toast Notification Pill */}
      {toastMsg && (
        <div
          style={{
            position: 'fixed',
            bottom: 22,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--imp-surface-elevated, #21252f)',
            border: '1px solid var(--imp-focus-ring, #e8b86d)',
            color: 'var(--imp-text-primary, #eef0f4)',
            padding: '8px 14px',
            borderRadius: 8,
            fontSize: 12.5,
            fontWeight: 700,
            zIndex: 90,
            boxShadow: '0 8px 24px rgba(0,0,0,0.65)',
          }}
        >
          {toastMsg}
        </div>
      )}

      {/* Top Action Bar: Source Pop-Up Trigger | View Switcher (L1/R1) | Interactive Volume & Brightness (PlayerView only; LibraryView integrates them into its 2-row header) */}
      {view === 'lock' && (
        <AppTopHeaderBar
          isNavBarHidden={isNavBarHidden || desktopScreensaverActive}
          setVolumePopoverOpen={setVolumePopoverOpen}
          setBrightnessPopoverOpen={setBrightnessPopoverOpen}
          setPowerModalOpen={setPowerModalOpen}
          setSourceModalOpen={setSourceModalOpen}
          view={view}
          setView={setView}
          track={track}
          applyVolume={applyVolume}
          currentVolume={currentVolume}
          volumePopoverOpen={volumePopoverOpen}
          isPlaying={isPlaying}
          volPct={volPct}
          brightnessPopoverOpen={brightnessPopoverOpen}
          brightnessPct={brightnessPct}
          setBrightnessPct={setBrightnessPct}
          sourceModalOpen={sourceModalOpen}
          powerModalOpen={powerModalOpen}
          desktopMode={desktopMode}
          expiredAuthProviders={expiredAuthProviders}
        />
      )}

      {/* Main Viewport: Lock Screen (PlayerView stays mounted across L1/R1 so video audio continues in background) + Persistent Split Browser */}
      <PlayerView
        hidden={view !== 'lock' && !desktopScreensaverActive}
        isPlayerIdle={isNavBarHidden || desktopScreensaverActive}
        isDesktopScreensaver={desktopScreensaverActive}
        isDeckyEmbedded={isDeckyEmbedded}
        desktopMode={desktopMode}
        onToggleDesktopMode={handleToggleDesktopMode}
        desktopVizIdleSec={desktopVizIdleSec}
        onChangeDesktopVizIdleSec={handleChangeDesktopVizIdleSec}
        snap={snap}
        track={track}
        isPlaying={isPlaying}
        opticalDisc={opticalDisc}
        browserTarget={browserTarget}
        playingContextId={playingContextId}
        setBrowserTarget={setBrowserTarget}
        setBrowserTracks={setBrowserTracks}
        setView={setView}
        handleOpenFullAppleAlbum={handleOpenFullAppleAlbum}
        handleStartSoundCloudTrackRadio={handleStartSoundCloudTrackRadio}
        handleAddTracksToPlaylist={handleAddTracksToPlaylist}
        handleFavoriteTrack={handleFavoriteTrack}
        handleAddAppleToCloudLibrary={handleAddAppleToCloudLibrary}
        favoritedUris={favoritedUris}
        handleMoreByArtist={handleMoreByArtist}
        applyFocusMarker={applyFocusMarker}
        showToast={showToast}
      />
      <LibraryBrowserView
        hidden={view !== 'browser' || desktopScreensaverActive}
        desktopMode={desktopMode}
        onTriggerScreensaver={triggerDesktopScreensaver}
        applyVolume={applyVolume}
        currentVolume={currentVolume}
        volumePopoverOpen={volumePopoverOpen}
        setVolumePopoverOpen={setVolumePopoverOpen}
        isPlaying={isPlaying}
        volPct={volPct}
        brightnessPopoverOpen={brightnessPopoverOpen}
        setBrightnessPopoverOpen={setBrightnessPopoverOpen}
        brightnessPct={brightnessPct}
        setBrightnessPct={setBrightnessPct}
        sourceModalOpen={sourceModalOpen}
        powerModalOpen={powerModalOpen}
        setPowerModalOpen={setPowerModalOpen}
        snap={snap}
        track={track}
        albums={albums}
        playlists={playlists}
        browserSourceFilter={browserSourceFilter}
        setBrowserSourceFilter={setBrowserSourceFilter}
        selectedSources={selectedSources}
        setSelectedSources={setSelectedSources}
        setBrowserSourceFilterRaw={setBrowserSourceFilterState}
        browseHubTarget={browseHubTarget}
        setBrowseHubTarget={setBrowseHubTarget}
        browserSearch={browserSearch}
        setBrowserSearch={setBrowserSearch}
        searchPreferredSource={searchPreferredSource}
        browserTarget={browserTarget}
        setBrowserTarget={setBrowserTarget}
        browserTracks={browserTracks}
        setBrowserTracks={setBrowserTracks}
        opticalDisc={opticalDisc}
        cdScanning={cdScanning}
        handleScanOpticalDisc={handleScanOpticalDisc}
        handleEjectOpticalDisc={handleEjectOpticalDisc}
        appleSubTab={appleSubTab}
        setAppleSubTab={setAppleSubTab}
        cloudPlaylists={cloudPlaylists}
        setCloudPlaylists={setCloudPlaylists}
        radioStations={radioStations}
        setRadioStations={setRadioStations}
        personalRadioStations={personalRadioStations}
        setPersonalRadioStations={setPersonalRadioStations}
        liveRadioStations={liveRadioStations}
        setLiveRadioStations={setLiveRadioStations}
        artistRadioShows={artistRadioShows}
        setArtistRadioShows={setArtistRadioShows}
        clubMixes={clubMixes}
        setClubMixes={setClubMixes}
        genreRadioStations={genreRadioStations}
        setGenreRadioStations={setGenreRadioStations}
        forYouPlaylists={forYouPlaylists}
        setForYouPlaylists={setForYouPlaylists}
        forYouAlbums={forYouAlbums}
        setForYouAlbums={setForYouAlbums}
        forYouNewReleases={forYouNewReleases}
        setForYouNewReleases={setForYouNewReleases}
        forYouShelves={forYouShelves}
        setForYouShelves={setForYouShelves}
        appleRecentlyPlayedTracks={appleRecentlyPlayedTracks}
        setAppleRecentlyPlayedTracks={setAppleRecentlyPlayedTracks}
        newFeedRecentReleases={newFeedRecentReleases}
        setNewFeedRecentReleases={setNewFeedRecentReleases}
        newFeedAlbums={newFeedAlbums}
        setNewFeedAlbums={setNewFeedAlbums}
        newFeedPlaylists={newFeedPlaylists}
        setNewFeedPlaylists={setNewFeedPlaylists}
        newFeedSongs={newFeedSongs}
        setNewFeedSongs={setNewFeedSongs}
        catalogSearchResults={catalogSearchResults}
        cloudLoading={cloudLoading}
        setCloudLoading={setCloudLoading}
        activeCloudAlbum={activeCloudAlbum}
        activeCloudPlaylist={activeCloudPlaylist}
        soundCloudSubTab={soundCloudSubTab}
        setSoundCloudSubTab={setSoundCloudSubTab}
        scLikedTracks={scLikedTracks}
        setScLikedTracks={setScLikedTracks}
        scPlaylists={scPlaylists}
        setScPlaylists={setScPlaylists}
        scStreamTracks={scStreamTracks}
        setScStreamTracks={setScStreamTracks}
        scStreamPlaylists={scStreamPlaylists}
        setScStreamPlaylists={setScStreamPlaylists}
        scTrendingTracks={scTrendingTracks}
        setScTrendingTracks={setScTrendingTracks}
        scTrendingMixes={scTrendingMixes}
        setScTrendingMixes={setScTrendingMixes}
        scTrendingPlaylists={scTrendingPlaylists}
        setScTrendingPlaylists={setScTrendingPlaylists}
        scMoreOfWhatYouLike={scMoreOfWhatYouLike}
        scFreshUploads={scFreshUploads}
        scRecommendedArtists={scRecommendedArtists}
        scDiscoverNextHref={scDiscoverNextHref}
        setScDiscoverNextHref={setScDiscoverNextHref}
        scSelectedGenre={scSelectedGenre}
        setScSelectedGenre={setScSelectedGenre}
        scCatalogSearchResults={scCatalogSearchResults}
        setScCatalogSearchResults={setScCatalogSearchResults}
        activeScPlaylist={activeScPlaylist}
        creatingPlaylist={creatingPlaylist}
        setCreatingPlaylist={setCreatingPlaylist}
        newPlaylistName={newPlaylistName}
        setNewPlaylistName={setNewPlaylistName}
        activePlaylistId={activePlaylistId}
        setActivePlaylistId={setActivePlaylistId}
        playingContextId={playingContextId}
        setPlayingContextId={setPlayingContextId}
        setOskTarget={setOskTarget}
        setSourceModalOpen={setSourceModalOpen}
        setView={setView}
        applyFocusMarker={applyFocusMarker}
        handleCreatePlaylist={handleCreatePlaylist}
        handleAddTracksToPlaylist={handleAddTracksToPlaylist}
        handleFavoriteTrack={handleFavoriteTrack}
        handleAddAppleToCloudLibrary={handleAddAppleToCloudLibrary}
        favoritedUris={favoritedUris}
        handleRemoveTrackFromPlaylist={handleRemoveTrackFromPlaylist}
        handleDeletePlaylist={handleDeletePlaylist}
        handleDeleteAlbum={handleDeleteAlbum}
        handlePinCloudPlaylist={handlePinCloudPlaylist}
        handlePinCloudAlbum={handlePinCloudAlbum}
        handleOpenCloudPlaylist={handleOpenCloudPlaylist}
        handleOpenFullAppleAlbum={handleOpenFullAppleAlbum}
        handleStartAppleStation={handleStartAppleStation}
        handleOpenSoundCloudPlaylist={handleOpenSoundCloudPlaylist}
        handlePinSoundCloudPlaylist={handlePinSoundCloudPlaylist}
        handleStartSoundCloudTrackRadio={handleStartSoundCloudTrackRadio}
        sourceVisibility={sourceVisibility}
        recentlyPlayed={recentlyPlayed}
        showToast={showToast}
        handleRemoveFolder={handleRemoveFolder}
        expiredAuthProviders={expiredAuthProviders}
        onOpenConnectedAccounts={openConnectedAccountsModal}
      />

      {/* Unified Top-Right 3-Column XMB START Menu */}
      {(sourceModalOpen || powerModalOpen) && (
        <XmbUnifiedMenu
          snap={snap}
          customFolderPath={customFolderPath}
          setCustomFolderPath={setCustomFolderPath}
          setOskTarget={setOskTarget}
          handleAddFolder={handleAddFolder}
          handleRemoveFolder={handleRemoveFolder}
          setSourceModalOpen={setSourceModalOpen}
          setPowerModalOpen={setPowerModalOpen}
          setIsSleeping={setIsSleeping}
          dismissConsole={dismissConsole}
          brightnessPct={brightnessPct}
          setBrightnessPct={setBrightnessPct}
          idleTimerSec={desktopVizIdleSec}
          onChangeIdleTimerSec={handleChangeDesktopVizIdleSec}
          updateStatus={updateStatus}
          setUpdateStatus={setUpdateStatus}
          checkSimpUpdates={checkSimpUpdates}
          applySimpUpdate={applySimpUpdate}
          confirmHardReset={confirmHardReset}
          setConfirmHardReset={setConfirmHardReset}
          sourceVisibility={sourceVisibility}
          setSourceVisibility={setSourceVisibility}
          opticalDisc={opticalDisc}
          cdScanning={cdScanning}
          handleScanOpticalDisc={handleScanOpticalDisc}
          handleEjectOpticalDisc={handleEjectOpticalDisc}
          appleAuthCfg={appleAuthCfg}
          setAppleAuthCfg={setAppleAuthCfg}
          appleBusy={appleBusy}
          setAppleBusy={setAppleBusy}
          soundcloudAuthCfg={soundcloudAuthCfg}
          setSoundcloudAuthCfg={setSoundcloudAuthCfg}
          soundcloudBusy={soundcloudBusy}
          setSoundcloudBusy={setSoundcloudBusy}
          refreshLibraryData={refreshLibraryData}
          applyFocusMarker={applyFocusMarker}
          showToast={showToast}
          expiredAuthProviders={expiredAuthProviders}
          initialOpenFoldersAccounts={initialOpenFoldersAccounts}
          isDeckyEmbedded={isDeckyEmbedded}
          desktopMode={desktopMode}
          onToggleDesktopMode={handleToggleDesktopMode}
          onOpenQuickHelp={() => {
            setInitialOpenFoldersAccounts(false);
            setQuickHelpOpen(true);
            window.setTimeout(() => {
              const btn = document.querySelector<HTMLElement>(
                '[data-quick-help-modal="true"] button[data-default-focus="true"]'
              );
              if (btn) applyFocusMarker(btn);
            }, 35);
          }}
        />
      )}

      {/* First-Time Run (OOBE) & START -> Help Overlay Modal */}
      {quickHelpOpen && (
        <QuickHelpModal
          onClose={() => {
            try {
              window.localStorage.setItem('simp_oobe_help_seen_v1', '1');
            } catch { }
            setQuickHelpOpen(false);
          }}
          onOpenFoldersAccounts={() => {
            try {
              window.localStorage.setItem('simp_oobe_help_seen_v1', '1');
            } catch { }
            setQuickHelpOpen(false);
            setInitialOpenFoldersAccounts(true);
            setSourceModalOpen(true);
          }}
          sourceVisibility={sourceVisibility}
          onToggleSourceVisibility={(key) => {
            setSourceVisibility((prev) => {
              const nextVal = !prev[key];
              const next = { ...prev, [key]: nextVal };
              try {
                window.localStorage.setItem('simp_source_visibility_v2', JSON.stringify(next));
              } catch { }
              void saveDaemonUiPrefs({ source_visibility_v2: next });
              if (key === 'internet_archive') {
                defaultSimpClient.configureInternetArchive({
                  enabled: nextVal,
                  username: '',
                  safe_search: true,
                });
              }
              return next;
            });
          }}
        />
      )}

      {/* On-Demand SIMP Hybrid & Cloud Playlist Chooser Modal */}
      <HybridPlaylistPickerModal
        pendingHybridAdd={pendingHybridAdd}
        setPendingHybridAdd={setPendingHybridAdd}
        setOskTarget={setOskTarget}
        playlists={playlists}
        activePlaylistId={activePlaylistId}
        commitAddTracksToPlaylist={commitAddTracksToPlaylist}
        setNewPlaylistName={setNewPlaylistName}
        applyFocusMarker={applyFocusMarker}
        newPlaylistName={newPlaylistName}
        cloudPlaylists={cloudPlaylists}
        setCloudPlaylists={setCloudPlaylists}
        scPlaylists={scPlaylists}
        setScPlaylists={setScPlaylists}
        appleAuthenticated={Boolean(snap?.apple_authenticated)}
        scAuthenticated={Boolean(snap?.soundcloud_authenticated)}
        browserTarget={browserTarget}
        setBrowserTracks={setBrowserTracks}
        refreshLibraryData={refreshLibraryData}
        showToast={showToast}
      />

      <AppOnScreenKeyboardBar
        oskTarget={oskTarget}
        setOskTarget={setOskTarget}
        view={view}
        sourceModalOpen={sourceModalOpen}
        powerModalOpen={powerModalOpen}
        pendingHybridAdd={pendingHybridAdd}
        browserSearch={browserSearch}
        setBrowserSearch={setBrowserSearch}
        newPlaylistName={newPlaylistName}
        setNewPlaylistName={setNewPlaylistName}
        customFolderPath={customFolderPath}
        setCustomFolderPath={setCustomFolderPath}
        applyFocusMarker={applyFocusMarker}
      />

      {/* Track Properties & Local Curation Modal */}
      {trackPropertiesTarget && (
        <TrackPropertiesModal
          track={trackPropertiesTarget}
          onClose={() => setTrackPropertiesTarget(null)}
          onToast={showToast}
        />
      )}

      {/* Proactive Auth Probe Banner */}
      <FolderDropModal
        expiredAuthAlert={expiredAuthAlert}
        setExpiredAuthAlert={setExpiredAuthAlert}
        setSourceModalOpen={setSourceModalOpen}
        showToast={showToast}
        pendingDroppedFolder={pendingDroppedFolder}
        setPendingDroppedFolder={setPendingDroppedFolder}
        handleAddFolder={handleAddFolder}
      />
    </div>
  );
};
