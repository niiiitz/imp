import React from "react";
import {
  AlbumRecord,
  OpticalDiscStatus,
  PlaylistRecord,
  SimpStateSnapshot,
  TrackMetadata,
} from "@simp/client";
import { AppleCloudPlaylistSummary } from "../../../drivers/AppleMusicDriver";
import { SoundCloudPlaylistSummary } from "../../../drivers/SoundCloudDriver";
import { SoundCloudLogo } from "../../../components/SoundCloudLogo";
import { AppleMusicLogo } from "../../../components/AppleMusicLogo";
import { OskTargetKind } from "../../../hooks/useGamepadNavigation";
import { BrowserTarget } from "../../PlayerView";
import { SourceVisibilityPrefs } from "../../SettingsModal";
import {
  cleanCollectionTitle,
  type BrowseHubTarget,
  type LocalSubTab,
} from "../libraryHelpers";
import { ImpIcon, ImpIconName } from "../../../components/icons/ImpIcon";
import { LocalSmartStation } from "../../../api/servicesCacheApi";

export interface LibrarySourceFilterPillsProps {
  browserSourceFilter: "all" | "local" | "apple_music" | "soundcloud" | "internet_archive";
  selectedSources: Array<"local" | "apple_music" | "soundcloud" | "internet_archive">;
  setSelectedSources: React.Dispatch<
    React.SetStateAction<Array<"local" | "apple_music" | "soundcloud" | "internet_archive">>
  >;
  setBrowserSourceFilterRaw: React.Dispatch<
    React.SetStateAction<"all" | "local" | "apple_music" | "soundcloud" | "internet_archive">
  >;
  sourceVisibility: SourceVisibilityPrefs;
  snap: SimpStateSnapshot | null;
  appleAuthState: "connected" | "reauth_required" | "never_used";
  pushCurrentNavState: () => void;
}

export const LibrarySourceFilterPills: React.FC<LibrarySourceFilterPillsProps> = ({
  browserSourceFilter,
  selectedSources,
  setSelectedSources,
  setBrowserSourceFilterRaw,
  sourceVisibility,
  snap,
  appleAuthState,
  pushCurrentNavState,
}) => {
  const lastPillTapRef = React.useRef<{ id: string; ts: number; wasAll: boolean } | null>(null);
  const sourceTabs: Array<{
    id: 'local' | 'apple_music' | 'soundcloud' | 'internet_archive';
    label: string;
    icon: ImpIconName;
    accent: 'local' | 'apple' | 'soundcloud' | 'archive';
  }> = [
    { id: 'local', label: 'Local', icon: 'local', accent: 'local' },
    ...(sourceVisibility.apple_music &&
    (snap?.apple_authenticated || appleAuthState === 'reauth_required')
      ? [
          {
            id: 'apple_music' as const,
            label: appleAuthState === 'reauth_required' ? 'Apple!' : 'Apple',
            icon: 'apple' as const,
            accent: 'apple' as const,
          },
        ]
      : []),
    ...(sourceVisibility.soundcloud
      ? [
          {
            id: 'soundcloud' as const,
            label: 'SC',
            icon: 'soundcloud' as const,
            accent: 'soundcloud' as const,
          },
        ]
      : []),
    ...(sourceVisibility.internet_archive && snap?.internet_archive_authenticated
      ? [
          {
            id: 'internet_archive' as const,
            label: 'Archive',
            icon: 'archive' as const,
            accent: 'archive' as const,
          },
        ]
      : []),
  ];

  const enabledIds = sourceTabs.map((t) => t.id);
  const rawActive =
    selectedSources.length === 0
      ? browserSourceFilter !== 'all' && enabledIds.includes(browserSourceFilter)
        ? [browserSourceFilter]
        : enabledIds
      : selectedSources.filter((s) => enabledIds.includes(s));
  const activeList = rawActive.length > 0 ? rawActive : enabledIds;
  const allActive = enabledIds.length > 0 && activeList.length === enabledIds.length;

  const commitSelectedSources = (nextList: Array<(typeof sourceTabs)[number]['id']>) => {
    const deduped = enabledIds.filter((id) => nextList.includes(id));
    if (deduped.length === 0) return;
    if (deduped.length === enabledIds.length) {
      setSelectedSources([]);
      setBrowserSourceFilterRaw('all');
    } else if (deduped.length === 1) {
      setSelectedSources(deduped);
      setBrowserSourceFilterRaw(deduped[0]);
    } else {
      setSelectedSources(deduped);
      setBrowserSourceFilterRaw('all');
    }
  };

  const applyDoubleTap = (
    tabId: (typeof sourceTabs)[number]['id'],
    wasAllBeforeFirstTap: boolean
  ) => {
    pushCurrentNavState();
    if (wasAllBeforeFirstTap) {
      commitSelectedSources([tabId]);
    } else {
      commitSelectedSources(enabledIds);
    }
  };

  const splitRows =
    sourceTabs.some((t) => t.id === 'internet_archive') || sourceTabs.length > 3;
  const topRowTabs = splitRows
    ? sourceTabs.filter((t) => t.id !== 'soundcloud' && t.id !== 'internet_archive')
    : sourceTabs;
  const bottomRowTabs = splitRows
    ? sourceTabs.filter((t) => t.id === 'soundcloud' || t.id === 'internet_archive')
    : [];
  const pillRows = bottomRowTabs.length > 0 ? [topRowTabs, bottomRowTabs] : [topRowTabs];
  const pillMinHeight = bottomRowTabs.length > 0 ? 24 : 28;

  const renderSourcePill = (tab: (typeof sourceTabs)[number]) => {
    const active = activeList.includes(tab.id);
    return (
      <button
        key={tab.id}
        onClick={(e) => {
          if (e.detail >= 2) return;
          const now = Date.now();
          const prev = lastPillTapRef.current;
          if (prev && prev.id === tab.id && now - prev.ts <= 320) {
            lastPillTapRef.current = null;
            applyDoubleTap(tab.id, prev.wasAll);
            return;
          }
          lastPillTapRef.current = { id: tab.id, ts: now, wasAll: allActive };
          if (active) {
            if (activeList.length <= 1) return;
            pushCurrentNavState();
            commitSelectedSources(activeList.filter((s) => s !== tab.id));
          } else {
            pushCurrentNavState();
            commitSelectedSources([...activeList, tab.id]);
          }
        }}
        onDoubleClick={() => {
          const prev = lastPillTapRef.current;
          const wasAll = prev && prev.id === tab.id ? prev.wasAll : allActive;
          lastPillTapRef.current = null;
          applyDoubleTap(tab.id, wasAll);
        }}
        style={{
          flex: '1 1 0%',
          minWidth: 0,
          minHeight: pillMinHeight,
          padding: '0 7px',
          borderRadius: 8,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          background: active
            ? tab.accent === 'apple'
              ? '#28111b'
              : tab.accent === 'soundcloud'
              ? '#2c140a'
              : tab.accent === 'archive'
              ? '#261a0b'
              : '#0b241c'
            : '#0a0a0e',
          border: active
            ? tab.accent === 'apple'
              ? '1px solid #fa243c'
              : tab.accent === 'soundcloud'
              ? '1px solid #ea580c'
              : tab.accent === 'archive'
              ? '1px solid #f59e0b'
              : '1px solid #34d399'
            : '1px solid #1e1e26',
          color: active
            ? tab.accent === 'apple'
              ? '#fecdd3'
              : tab.accent === 'soundcloud'
              ? '#fdba74'
              : tab.accent === 'archive'
              ? '#fde68a'
              : '#6ee7b7'
            : '#9ca3af',
          fontSize: 11,
          fontWeight: 800,
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
        }}
      >
        {tab.id === 'local' ? (
          <span style={{ fontSize: 11, lineHeight: 1 }}>💾</span>
        ) : (
          <ImpIcon name={tab.icon} size={tab.icon === 'soundcloud' ? 10 : 11.5} />
        )}
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {tab.label}
        </span>
      </button>
    );
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        width: '100%',
        minWidth: 0,
      }}
    >
      {pillRows.map((rowTabs, rowIdx) => (
        <div
          key={rowIdx}
          style={{
            display: 'flex',
            alignItems: 'stretch',
            gap: 4,
            width: '100%',
            minWidth: 0,
          }}
        >
          {rowTabs.map(renderSourcePill)}
        </div>
      ))}
    </div>
  );
};

export interface LibraryXmbLeftColumnProps {
  browserSourceFilter: "all" | "local" | "apple_music" | "soundcloud" | "internet_archive";
  browseHubTarget: BrowseHubTarget;
  setBrowseHubTarget: React.Dispatch<React.SetStateAction<BrowseHubTarget>>;
  setOskTarget: React.Dispatch<React.SetStateAction<OskTargetKind>>;
  sourceVisibility: SourceVisibilityPrefs;
  snap: SimpStateSnapshot | null;
  appleAuthState: "connected" | "reauth_required" | "never_used";
  pushCurrentNavState: () => void;
  localSubTab: LocalSubTab;
  setLocalSubTab: React.Dispatch<React.SetStateAction<LocalSubTab>>;
  setLocalFolderPath: React.Dispatch<React.SetStateAction<string>>;
  localAlbumsCount: number;
  localArtistsCount: number;
  localVideosCount: number;
  appleSubTab: "pinned" | "for_you" | "cloud_playlists" | "new" | "radio";
  setAppleSubTab: React.Dispatch<
    React.SetStateAction<"pinned" | "for_you" | "cloud_playlists" | "new" | "radio">
  >;
  soundCloudSubTab: "pinned" | "likes_sets" | "stream_radio" | "trending";
  setSoundCloudSubTab: React.Dispatch<
    React.SetStateAction<"pinned" | "likes_sets" | "stream_radio" | "trending">
  >;
  iaSubTab: "pinned" | "trending" | "films" | "tv" | "audio";
  setIaSubTab: React.Dispatch<
    React.SetStateAction<"pinned" | "trending" | "films" | "tv" | "audio">
  >;
  setIaSubFilter: React.Dispatch<React.SetStateAction<string>>;
  rightPaneMode: "browse" | "tracks" | "artist";
  setRightPaneMode: React.Dispatch<React.SetStateAction<"browse" | "tracks" | "artist">>;
  activeMountRoot: string | null;
  setActiveMountRoot: React.Dispatch<React.SetStateAction<string | null>>;
  placesOpen: boolean;
  togglePlacesOpen: () => void;
  filteredPlaylists: PlaylistRecord[];
  filteredAlbums: AlbumRecord[];
  pinnedAppleAlbumCount: number;
  scLikedTracks: TrackMetadata[];
  scPlaylists: SoundCloudPlaylistSummary[];
  cloudPlaylists: AppleCloudPlaylistSummary[];
  xmbPreviewTriggerRef: React.MutableRefObject<boolean>;
  focusRightPaneFirstTile: () => void;
  isSourceIncluded: (src: "local" | "apple_music" | "soundcloud" | "internet_archive") => boolean;
  opticalDisc: OpticalDiscStatus | null;
  cdScanning: boolean;
  browserTarget: BrowserTarget | null;
  selectLocalCollection: (target: BrowserTarget) => void;
  handleScanOpticalDisc: (forceRefresh?: boolean, silent?: boolean) => Promise<void>;
  handleEjectOpticalDisc: () => void;
  setSourceModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  playlistsOpen: boolean;
  togglePlaylistsOpen: () => void;
  creatingPlaylist: boolean;
  setCreatingPlaylist: React.Dispatch<React.SetStateAction<boolean>>;
  newPlaylistName: string;
  setNewPlaylistName: React.Dispatch<React.SetStateAction<string>>;
  handleCreatePlaylist: () => Promise<void>;
  activePlaylistId: string;
  setActivePlaylistId: React.Dispatch<React.SetStateAction<string>>;
  setImpFypActive: React.Dispatch<React.SetStateAction<boolean>>;
  localSmartStations: LocalSmartStation[];
  onPlayLocalSmartStation: (st: LocalSmartStation, shuffle?: boolean) => void;
  openLeftItemContextMenu: (
    kind: 'simp_album' | 'simp_playlist' | 'mount' | 'cdda',
    id?: string
  ) => void;
  onOpenOpticalDisc: () => void;
}

export const LibraryXmbLeftColumn: React.FC<LibraryXmbLeftColumnProps> = ({
  browserSourceFilter,
  browseHubTarget,
  setBrowseHubTarget,
  setOskTarget,
  sourceVisibility,
  snap,
  appleAuthState,
  pushCurrentNavState,
  localSubTab,
  setLocalSubTab,
  setLocalFolderPath,
  localAlbumsCount,
  localArtistsCount,
  localVideosCount,
  appleSubTab,
  setAppleSubTab,
  soundCloudSubTab,
  setSoundCloudSubTab,
  iaSubTab,
  setIaSubTab,
  setIaSubFilter,
  rightPaneMode,
  setRightPaneMode,
  activeMountRoot,
  setActiveMountRoot,
  placesOpen,
  togglePlacesOpen,
  filteredPlaylists,
  filteredAlbums,
  scLikedTracks,
  scPlaylists,
  cloudPlaylists,
  xmbPreviewTriggerRef,
  focusRightPaneFirstTile,
  isSourceIncluded,
  opticalDisc,
  cdScanning,
  browserTarget,
  selectLocalCollection,
  handleScanOpticalDisc,
  handleEjectOpticalDisc,
  setSourceModalOpen,
  playlistsOpen,
  togglePlaylistsOpen,
  creatingPlaylist,
  setCreatingPlaylist,
  newPlaylistName,
  setNewPlaylistName,
  handleCreatePlaylist,
  activePlaylistId,
  setActivePlaylistId,
  setImpFypActive,
  localSmartStations,
  onPlayLocalSmartStation,
  openLeftItemContextMenu,
  onOpenOpticalDisc,
}) => {
  const [impNavOpen, setImpNavOpen] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem('simp_sec_imp_nav') !== '0';
    } catch {
      return true;
    }
  });
  const toggleImpNavOpen = () => {
    setImpNavOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('simp_sec_imp_nav', next ? '1' : '0');
      } catch {}
      return next;
    });
  };
  const [localNavOpen, setLocalNavOpen] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem('simp_sec_local_nav') !== '0';
    } catch {
      return true;
    }
  });
  const toggleLocalNavOpen = () => {
    setLocalNavOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('simp_sec_local_nav', next ? '1' : '0');
      } catch {}
      return next;
    });
  };
  const [localStationsSecOpen, setLocalStationsSecOpen] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem('simp_sec_local_stations') !== '0';
    } catch {
      return true;
    }
  });
  const toggleLocalStationsSecOpen = () => {
    setLocalStationsSecOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('simp_sec_local_stations', next ? '1' : '0');
      } catch {}
      return next;
    });
  };
  const [appleNavOpen, setAppleNavOpen] = React.useState<boolean>(
    browseHubTarget === 'apple_discover'
  );
  const [scNavOpen, setScNavOpen] = React.useState<boolean>(
    browseHubTarget === 'soundcloud_discover'
  );
  const [iaNavOpen, setIaNavOpen] = React.useState<boolean>(
    browseHubTarget === 'ia_discover'
  );
  const [albumsSecOpen, setAlbumsSecOpen] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem('simp_sec_albums') !== '0';
    } catch {
      return true;
    }
  });
  const [stationsSecOpen, setStationsSecOpen] = React.useState<boolean>(() => {
    try {
      return window.localStorage.getItem('simp_sec_stations') !== '0';
    } catch {
      return true;
    }
  });
  const [showAllRailAlbums, setShowAllRailAlbums] = React.useState<boolean>(false);

  const toggleAlbumsSecOpen = () => {
    setAlbumsSecOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('simp_sec_albums', next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  const toggleStationsSecOpen = () => {
    setStationsSecOpen((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('simp_sec_stations', next ? '1' : '0');
      } catch {}
      return next;
    });
  };

  React.useEffect(() => {
    const onRailToggle = (ev: Event) => {
      const key = (ev as CustomEvent<{ key?: string }>).detail?.key;
      if (key === 'places') togglePlacesOpen();
      else if (key === 'imp_nav') toggleImpNavOpen();
      else if (key === 'local_nav') toggleLocalNavOpen();
      else if (key === 'local_stations') toggleLocalStationsSecOpen();
      else if (key === 'imp_albums') toggleAlbumsSecOpen();
      else if (key === 'imp_stations') toggleStationsSecOpen();
      else if (key === 'apple_nav') setAppleNavOpen((v) => !v);
      else if (key === 'sc_nav') setScNavOpen((v) => !v);
      else if (key === 'ia_nav') setIaNavOpen((v) => !v);
      else if (key === 'imp_playlists') togglePlaylistsOpen();
    };
    window.addEventListener('simp-left-rail-toggle-collapse', onRailToggle);
    return () => window.removeEventListener('simp-left-rail-toggle-collapse', onRailToggle);
  }, [togglePlacesOpen, togglePlaylistsOpen]);

  const savedStationsAndSets = filteredPlaylists.filter(
    (p) => p.origin === 'soundcloud_remote' || p.origin === 'archive_remote'
  );
  const railSmartStations = isSourceIncluded('local') ? localSmartStations : [];
  const totalStationsAndSets = savedStationsAndSets.length;
  return (
    <>
      {/* =====================================================================
          LEFT COLUMN (32%): Inline Places Navigation + Collapsible Quick-Jump Library
         ===================================================================== */}
      <div
        data-nav-col="left"
        style={{
          borderRight: '1px solid #16161c',
          padding: 14,
          overflowY: 'auto',
          overflowX: 'hidden',
          minWidth: 0,
          WebkitOverflowScrolling: 'touch',
          touchAction: 'pan-y',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* =================================================================
            COLLAPSIBLE BUCKET 0: ▾ PLACES (Unified Non-Zeroing Hierarchy)
           ================================================================= */}
        <button
          data-rail-collapse-key="places"
          onClick={togglePlacesOpen}
          style={{
            marginTop: 2,
            background: '#0d0d14',
            border: '1px solid #1e1e28',
            borderRadius: 8,
            padding: '6px 10px',
            color: '#c8c8d4',
            fontSize: 11,
            fontFamily: 'monospace',
            fontWeight: 800,
            textAlign: 'left',
            cursor: 'pointer',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>{placesOpen ? '▾' : '▸'} PLACES</span>
        </button>

        {placesOpen && (
          <div
            data-rail-collapse-key="places"
            style={{ display: 'flex', flexDirection: 'column', gap: 5 }}
          >
            {/* Primary Destination: 😈 Imp (Defaults into Imp FYP, expands inline for Imp Library + Albums + Stations) */}
            <button
              data-rail-collapse-key="imp_nav"
              data-xmb-drill-right="true"
              data-left-active={
                (browseHubTarget === 'imp_fyp' || browseHubTarget === 'imp_library') &&
                rightPaneMode === 'browse'
                  ? 'true'
                  : undefined
              }
              onClick={() => {
                if (browseHubTarget !== 'imp_fyp' || rightPaneMode !== 'browse') {
                  if (!impNavOpen) {
                    setImpNavOpen(true);
                    try {
                      window.localStorage.setItem('simp_sec_imp_nav', '1');
                    } catch {}
                  }
                  pushCurrentNavState();
                  setActiveMountRoot(null);
                  setBrowseHubTarget('imp_fyp');
                  setRightPaneMode('browse');
                } else {
                  toggleImpNavOpen();
                }
              }}
              style={{
                minHeight: 36,
                padding: '0 10px',
                borderRadius: 8,
                background:
                  browseHubTarget === 'imp_fyp' || browseHubTarget === 'imp_library'
                    ? '#0f1c22'
                    : '#0a0a0e',
                border:
                  browseHubTarget === 'imp_fyp' || browseHubTarget === 'imp_library'
                    ? '1px solid #2aa3c4'
                    : '1px solid #181820',
                color: '#bfeaf5',
                fontSize: 12.5,
                fontWeight: 800,
                cursor: 'pointer',
                textAlign: 'left',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <ImpIcon name="imp" size={14} color="#67e8f9" />
                <span>Imp</span>
              </span>
              <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#67e8f9' }}>
                {impNavOpen ? '▾' : '▸'}
              </span>
            </button>

            {impNavOpen && (
              <div
                data-rail-collapse-key="imp_nav"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  paddingLeft: 10,
                  marginLeft: 6,
                  borderLeft: '2px solid #1b3642',
                }}
              >
                {/* 1. Imp FYP */}
                {(() => {
                  const fypIsActive =
                    browseHubTarget === 'imp_fyp' && !activeMountRoot && rightPaneMode === 'browse';
                  return (
                    <button
                      data-default-focus={browseHubTarget === 'imp_fyp' ? 'true' : undefined}
                      data-left-active={fypIsActive ? 'true' : undefined}
                      data-xmb-preview="true"
                      onClick={() => {
                        const isPreview = xmbPreviewTriggerRef.current;
                        if (
                          !isPreview &&
                          (browseHubTarget !== 'imp_fyp' ||
                            activeMountRoot !== null ||
                            rightPaneMode !== 'browse')
                        ) {
                          pushCurrentNavState();
                        }
                        setActiveMountRoot(null);
                        setBrowseHubTarget('imp_fyp');
                        setRightPaneMode('browse');
                        if (!isPreview) {
                          focusRightPaneFirstTile();
                        }
                      }}
                      style={{
                        minHeight: 32,
                        padding: '0 10px',
                        borderRadius: 8,
                        background: fypIsActive ? '#1c1808' : '#0a0a0e',
                        border: fypIsActive ? '1px solid #eab308' : '1px solid #181820',
                        color: fypIsActive ? '#fef08a' : '#e2e8f0',
                        fontSize: 12,
                        fontWeight: 800,
                        cursor: 'pointer',
                        textAlign: 'left',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <ImpIcon
                          name="bolt"
                          size={12.5}
                          color={fypIsActive ? '#fde047' : '#94a3b8'}
                        />
                        <span>Imp FYP</span>
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          fontFamily: 'monospace',
                          color: fypIsActive ? '#fde047' : '#71717a',
                        }}
                      >
                        ⊞
                      </span>
                    </button>
                  );
                })()}

                {/* 2. Imp Library */}
                {(() => {
                  const impLibIsActive =
                    browseHubTarget === 'imp_library' &&
                    !activeMountRoot &&
                    rightPaneMode === 'browse';
                  return (
                    <button
                      data-default-focus={browseHubTarget === 'imp_library' ? 'true' : undefined}
                      data-left-active={impLibIsActive ? 'true' : undefined}
                      data-xmb-preview="true"
                      onClick={() => {
                        const isPreview = xmbPreviewTriggerRef.current;
                        if (
                          !isPreview &&
                          (browseHubTarget !== 'imp_library' ||
                            activeMountRoot !== null ||
                            rightPaneMode !== 'browse')
                        ) {
                          pushCurrentNavState();
                        }
                        setActiveMountRoot(null);
                        setBrowseHubTarget('imp_library');
                        setRightPaneMode('browse');
                        if (!isPreview) {
                          focusRightPaneFirstTile();
                        }
                      }}
                      style={{
                        minHeight: 32,
                        padding: '0 10px',
                        borderRadius: 8,
                        background: impLibIsActive ? '#0f222a' : '#0a0a0e',
                        border: impLibIsActive ? '1px solid #2aa3c4' : '1px solid #181820',
                        color: impLibIsActive ? '#bfeaf5' : '#c8c8d2',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                        textAlign: 'left',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <ImpIcon
                          name="imp"
                          size={12.5}
                          color={impLibIsActive ? '#bfeaf5' : '#67e8f9'}
                        />
                        <span>
                          Imp Library ({filteredPlaylists.length + filteredAlbums.length})
                        </span>
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          fontFamily: 'monospace',
                          color: impLibIsActive ? '#2aa3c4' : '#71717a',
                        }}
                      >
                        ⊞
                      </span>
                    </button>
                  );
                })()}

                {/* 3. IMP ALBUMS & SOUNDTRACKS (Nested under Imp) */}
                {filteredAlbums.length > 0 && (
                  <div
                    data-rail-collapse-key="imp_albums"
                    style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}
                  >
                    <button
                      data-xmb-drill-right="true"
                      data-rail-collapse-key="imp_albums"
                      onClick={toggleAlbumsSecOpen}
                      style={{
                        background: '#0d0d14',
                        border: '1px solid #1e1e28',
                        borderRadius: 8,
                        padding: '5px 10px',
                        color: '#c8c8d4',
                        fontSize: 10.5,
                        fontFamily: 'monospace',
                        fontWeight: 800,
                        textAlign: 'left',
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span>
                        {albumsSecOpen ? '▾' : '▸'} IMP ALBUMS &amp; SOUNDTRACKS (
                        {filteredAlbums.length})
                      </span>
                    </button>

                    {albumsSecOpen &&
                      (showAllRailAlbums ? filteredAlbums : filteredAlbums.slice(0, 20)).map(
                        (alb) => {
                          const isSelected =
                            rightPaneMode === 'tracks' &&
                            browserTarget?.kind === 'album' &&
                            browserTarget.id === alb.id;
                          const isApple = alb.id.startsWith('apple_album:');
                          return (
                            <button
                              key={alb.id}
                              data-left-active={isSelected ? 'true' : undefined}
                              data-left-context-kind="simp_album"
                              data-left-context-id={alb.id}
                              data-xmb-preview="true"
                              onContextMenu={(e) => {
                                e.preventDefault();
                                openLeftItemContextMenu('simp_album', alb.id);
                              }}
                              onClick={() => {
                                setImpFypActive(false);
                                selectLocalCollection({
                                  kind: 'album',
                                  id: alb.id,
                                  title: alb.title,
                                  subtitle: alb.album_artist,
                                  art_url: alb.art_url,
                                });
                              }}
                              style={{
                                minHeight: 32,
                                padding: '0 10px',
                                borderRadius: 8,
                                background: isSelected ? '#0d1b22' : '#0a0a0e',
                                border: isSelected
                                  ? '1px solid #2aa3c4'
                                  : '1px solid #181820',
                                color: '#d4d4dc',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 8,
                                textAlign: 'left',
                                cursor: 'pointer',
                                width: '100%',
                                boxSizing: 'border-box',
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 11.5,
                                  fontWeight: 700,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  minWidth: 0,
                                  flex: 1,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 6,
                                }}
                              >
                                {isApple ? (
                                  <AppleMusicLogo size={11} />
                                ) : (
                                  <span style={{ fontSize: 11, lineHeight: 1 }}>💾</span>
                                )}
                                <span
                                  style={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {cleanCollectionTitle(alb.title)}
                                </span>
                              </span>
                              <span
                                style={{
                                  fontSize: 10.5,
                                  fontFamily: 'monospace',
                                  color: alb.steam_app_id != null ? '#c4b5fd' : '#64748b',
                                  flexShrink: 0,
                                }}
                              >
                                {alb.steam_app_id != null ? 'OST ' : ''}
                                {alb.track_count}
                              </span>
                            </button>
                          );
                        }
                      )}

                    {albumsSecOpen && filteredAlbums.length > 20 && (
                      <button
                        type="button"
                        onClick={() => setShowAllRailAlbums((v) => !v)}
                        style={{
                          minHeight: 28,
                          padding: '0 10px',
                          borderRadius: 8,
                          background: '#0d1018',
                          border: '1px solid #202432',
                          color: '#7dd3fc',
                          fontSize: 10.5,
                          fontFamily: 'monospace',
                          fontWeight: 700,
                          cursor: 'pointer',
                        }}
                      >
                        {showAllRailAlbums
                          ? 'Show Top 20 Albums ▴'
                          : `Show All Albums (${filteredAlbums.length}) ▾`}
                      </button>
                    )}
                  </div>
                )}

                {/* 4. IMP STATIONS & SETS (Nested under Imp) */}
                {totalStationsAndSets > 0 && (
                  <div
                    data-rail-collapse-key="imp_stations"
                    style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}
                  >
                    <button
                      data-xmb-drill-right="true"
                      data-rail-collapse-key="imp_stations"
                      onClick={toggleStationsSecOpen}
                      style={{
                        background: '#0d0d14',
                        border: '1px solid #1e1e28',
                        borderRadius: 8,
                        padding: '5px 10px',
                        color: '#c8c8d4',
                        fontSize: 10.5,
                        fontFamily: 'monospace',
                        fontWeight: 800,
                        textAlign: 'left',
                        cursor: 'pointer',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span>
                        {stationsSecOpen ? '▾' : '▸'} IMP STATIONS &amp; SETS ({totalStationsAndSets})
                      </span>
                    </button>

                    {stationsSecOpen && (
                      <>
                        {savedStationsAndSets.map((pl) => {
                          const isSelected =
                            rightPaneMode === 'tracks' &&
                            browserTarget?.kind === 'playlist' &&
                            browserTarget.id === pl.id;
                          return (
                            <button
                              key={`station-set-${pl.id}`}
                              data-left-active={isSelected ? 'true' : undefined}
                              data-left-context-kind="simp_playlist"
                              data-left-context-id={pl.id}
                              onContextMenu={(e) => {
                                e.preventDefault();
                                openLeftItemContextMenu('simp_playlist', pl.id);
                              }}
                              onClick={() => {
                                setImpFypActive(false);
                                selectLocalCollection({ kind: 'playlist', id: pl.id });
                              }}
                              style={{
                                minHeight: 32,
                                padding: '0 10px',
                                borderRadius: 8,
                                background: isSelected ? '#0d1b22' : '#0a0a0e',
                                border: isSelected
                                  ? '1px solid #2aa3c4'
                                  : '1px solid #181820',
                                color: '#d4d4dc',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 8,
                                textAlign: 'left',
                                cursor: 'pointer',
                                width: '100%',
                                boxSizing: 'border-box',
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 11.5,
                                  fontWeight: 700,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  minWidth: 0,
                                  flex: 1,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 6,
                                }}
                              >
                                {pl.origin === 'soundcloud_remote' ? (
                                  <ImpIcon name="soundcloud" size={11} color="#fdba74" />
                                ) : (
                                  <ImpIcon name="archive" size={12} color="#facc15" />
                                )}
                                <span
                                  style={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {cleanCollectionTitle(pl.name)}
                                </span>
                              </span>
                              <span
                                style={{
                                  fontSize: 10.5,
                                  fontFamily: 'monospace',
                                  color: '#94a3b8',
                                  flexShrink: 0,
                                }}
                              >
                                {pl.track_count}
                              </span>
                            </button>
                          );
                        })}
                      </>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Inline Local Music & Storage Accordion (Canonical Emerald Green) */}
            {isSourceIncluded('local') && (
              <div
                data-rail-collapse-key="local_nav"
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                {(() => {
                  const isLocalHubActive =
                    (browseHubTarget === 'local_discover' || browseHubTarget === 'mount') &&
                    rightPaneMode === 'browse';
                  return (
                    <button
                      data-xmb-drill-right="true"
                      data-rail-collapse-key="local_nav"
                      data-left-active={isLocalHubActive ? 'true' : undefined}
                      onClick={() => {
                        if (!isLocalHubActive) {
                          pushCurrentNavState();
                          setActiveMountRoot(null);
                          setLocalFolderPath('');
                          setLocalNavOpen(true);
                          try {
                            window.localStorage.setItem('simp_sec_local_nav', '1');
                          } catch {}
                          setBrowseHubTarget('local_discover');
                          setRightPaneMode('browse');
                        } else {
                          toggleLocalNavOpen();
                        }
                      }}
                      style={{
                        minHeight: 34,
                        padding: '0 10px',
                        borderRadius: 8,
                        background: isLocalHubActive ? '#0b241c' : '#0a0a0e',
                        border: isLocalHubActive
                          ? '1px solid #34d399'
                          : '1px solid #181820',
                        color: '#6ee7b7',
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: 'pointer',
                        textAlign: 'left',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span>💾</span>
                        <span>Local</span>
                      </span>
                      <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#34d399' }}>
                        {localNavOpen ? '▾' : '▸'}
                      </span>
                    </button>
                  );
                })()}

                {localNavOpen && (
                  <div
                    data-rail-collapse-key="local_nav"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      paddingLeft: 10,
                      marginLeft: 6,
                      borderLeft: '2px solid #143328',
                    }}
                  >
                    {(
                      [
                        { id: 'overview', label: '⚡ Overview' },
                        { id: 'artists', label: `🎤 Artists (${localArtistsCount})` },
                        { id: 'albums', label: `💿 Albums (${localAlbumsCount})` },
                        {
                          id: 'folders',
                          label: `📂 Mounts & Folders (${snap?.mounts.length || 0})`,
                        },
                        ...(localVideosCount > 0
                          ? [{ id: 'videos' as const, label: `🎬 Videos (${localVideosCount})` }]
                          : []),
                      ] as const
                    ).map((hub) => {
                      const active =
                        browseHubTarget === 'local_discover' &&
                        localSubTab === hub.id &&
                        rightPaneMode === 'browse';
                      return (
                        <button
                          key={hub.id}
                          data-left-active={active ? 'true' : undefined}
                          data-xmb-preview="true"
                          onClick={() => {
                            const isPreview = xmbPreviewTriggerRef.current;
                            if (
                              !isPreview &&
                              (browseHubTarget !== 'local_discover' ||
                                localSubTab !== hub.id ||
                                rightPaneMode !== 'browse')
                            ) {
                              pushCurrentNavState();
                            }
                            if (hub.id !== 'folders') {
                              setActiveMountRoot(null);
                              setLocalFolderPath('');
                            }
                            setLocalSubTab(hub.id);
                            setBrowseHubTarget('local_discover');
                            setRightPaneMode('browse');
                            if (!isPreview) focusRightPaneFirstTile();
                          }}
                          style={{
                            minHeight: 30,
                            padding: '0 10px',
                            borderRadius: 7,
                            background: active ? '#0b241c' : '#08120e',
                            border: active ? '1px solid #34d399' : '1px solid #142820',
                            color: active ? '#a7f3d0' : '#d1fae5',
                            fontSize: 11.5,
                            fontWeight: active ? 800 : 600,
                            cursor: 'pointer',
                            textAlign: 'left',
                          }}
                        >
                          {hub.label}
                        </button>
                      );
                    })}

                    {/* Local Smart Stations */}
                    {railSmartStations.length > 0 && (
                      <div
                        data-rail-collapse-key="local_stations"
                        style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 2 }}
                      >
                        <button
                          data-xmb-drill-right="true"
                          data-rail-collapse-key="local_stations"
                          onClick={toggleLocalStationsSecOpen}
                          style={{
                            background: '#081510',
                            border: '1px solid #143328',
                            borderRadius: 7,
                            padding: '4px 9px',
                            color: '#6ee7b7',
                            fontSize: 10,
                            fontFamily: 'monospace',
                            fontWeight: 800,
                            textAlign: 'left',
                            cursor: 'pointer',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span>
                            {localStationsSecOpen ? '▾' : '▸'} LOCAL SMART STATIONS (
                            {railSmartStations.length})
                          </span>
                        </button>
                        {localStationsSecOpen &&
                          railSmartStations.map((st) => (
                            <button
                              key={st.id}
                              onClick={() => onPlayLocalSmartStation(st, false)}
                              title={`${st.title} — ${st.subtitle}`}
                              style={{
                                minHeight: 30,
                                padding: '0 10px',
                                borderRadius: 7,
                                background: '#081510',
                                border: '1px solid #143328',
                                color: '#ccfbf1',
                                display: 'flex',
                                justifyContent: 'space-between',
                                alignItems: 'center',
                                gap: 8,
                                textAlign: 'left',
                                cursor: 'pointer',
                                width: '100%',
                                boxSizing: 'border-box',
                              }}
                            >
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 700,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                  minWidth: 0,
                                  flex: 1,
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: 6,
                                }}
                              >
                                <ImpIcon name="radio" size={11} color="#34d399" />
                                <span
                                  style={{
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {st.title}
                                </span>
                              </span>
                              <span
                                style={{
                                  fontSize: 10,
                                  fontFamily: 'monospace',
                                  color: '#6ee7b7',
                                  flexShrink: 0,
                                }}
                              >
                                ▶ {st.track_count}
                              </span>
                            </button>
                          ))}
                      </div>
                    )}

                    {/* Storage Mounts inside Local */}
                    {snap?.mounts.map((m) => {
                      const isMountActive =
                        (browseHubTarget === 'mount' ||
                          (browseHubTarget === 'local_discover' && localSubTab === 'folders')) &&
                        activeMountRoot === m.mount_root &&
                        rightPaneMode === 'browse';
                      return (
                        <button
                          key={m.mount_root}
                          data-left-active={isMountActive ? 'true' : undefined}
                          data-left-context-kind="mount"
                          data-left-context-id={m.mount_root}
                          data-xmb-preview="true"
                          onContextMenu={(e) => {
                            e.preventDefault();
                            openLeftItemContextMenu('mount', m.mount_root);
                          }}
                          onClick={() => {
                            const isPreview = xmbPreviewTriggerRef.current;
                            if (
                              !isPreview &&
                              (browseHubTarget !== 'mount' ||
                                activeMountRoot !== m.mount_root ||
                                rightPaneMode !== 'browse')
                            ) {
                              pushCurrentNavState();
                            }
                            setActiveMountRoot(m.mount_root);
                            setLocalFolderPath('');
                            setLocalSubTab('folders');
                            setBrowseHubTarget('mount');
                            setRightPaneMode('browse');
                            if (!isPreview) {
                              focusRightPaneFirstTile();
                            }
                          }}
                          title={m.mount_root}
                          style={{
                            minHeight: 32,
                            padding: '0 10px',
                            borderRadius: 7,
                            background: isMountActive ? '#0b241c' : '#08120e',
                            border: isMountActive ? '1px solid #34d399' : '1px solid #143328',
                            color: isMountActive ? '#6ee7b7' : '#34d399',
                            fontSize: 11.5,
                            fontWeight: 700,
                            cursor: 'pointer',
                            textAlign: 'left',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                            gap: 8,
                            opacity: m.is_online ? 1 : 0.65,
                          }}
                        >
                          <span
                            style={{
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              minWidth: 0,
                              flex: 1,
                            }}
                          >
                            💾 {m.label}
                            {!m.is_online ? ' (Offline)' : ''} ({m.track_count})
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontFamily: 'monospace',
                              color: isMountActive ? '#6ee7b7' : '#34d399',
                              flexShrink: 0,
                            }}
                          >
                            ⊞
                          </span>
                        </button>
                      );
                    })}

                    {/* Optical Disc Drive (cdda:// or dvd://) inside Local */}
                    {sourceVisibility.optical_drive && (
                      <div
                        style={{
                          padding: '6px 9px',
                          borderRadius: 8,
                          background:
                            rightPaneMode === 'tracks' && browserTarget?.kind === 'cdda'
                              ? '#1f160d'
                              : opticalDisc?.is_audio_cd || opticalDisc?.is_dvd_video
                              ? '#12100e'
                              : '#0a0a0e',
                          border:
                            rightPaneMode === 'tracks' && browserTarget?.kind === 'cdda'
                              ? '1px solid #f59e0b'
                              : opticalDisc?.is_audio_cd || opticalDisc?.is_dvd_video
                              ? '1px solid #78350f'
                              : '1px solid #181820',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: 6,
                        }}
                      >
                        <button
                          data-left-active={
                            rightPaneMode === 'tracks' && browserTarget?.kind === 'cdda'
                              ? 'true'
                              : undefined
                          }
                          data-left-context-kind="cdda"
                          data-xmb-preview={
                            opticalDisc?.is_audio_cd || opticalDisc?.is_dvd_video
                              ? 'true'
                              : undefined
                          }
                          onContextMenu={(e) => {
                            e.preventDefault();
                            openLeftItemContextMenu('cdda');
                          }}
                          onClick={() => {
                            if (opticalDisc?.is_audio_cd || opticalDisc?.is_dvd_video) {
                              onOpenOpticalDisc();
                            } else if (!xmbPreviewTriggerRef.current) {
                              handleScanOpticalDisc(false, false);
                            }
                          }}
                          style={{
                            minWidth: 0,
                            flex: 1,
                            background: 'transparent',
                            border: 'none',
                            color:
                              opticalDisc?.is_audio_cd || opticalDisc?.is_dvd_video
                                ? '#fcd34d'
                                : '#c8c8d2',
                            textAlign: 'left',
                            cursor: 'pointer',
                            padding: 0,
                            fontSize: 11.5,
                            fontWeight: 700,
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {cdScanning
                            ? '⏳ 💿 Scanning Disc...'
                            : opticalDisc?.is_audio_cd
                            ? `💿 ${opticalDisc.album_title || 'Audio CD'} (${opticalDisc.tracks.length})`
                            : opticalDisc?.is_dvd_video
                            ? `📀 ${opticalDisc.album_title || 'DVD Video'} (${
                                opticalDisc.dvd_titles?.length || 0
                              })`
                            : '💿 Optical Disc Drive'}
                        </button>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            flexShrink: 0,
                          }}
                        >
                          <button
                            data-row-aux="true"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleScanOpticalDisc(true, false);
                            }}
                            disabled={cdScanning}
                            style={{
                              padding: '3px 7px',
                              borderRadius: 6,
                              background: '#161622',
                              border: '1px solid #2e2e3e',
                              color: '#fcd34d',
                              fontSize: 10,
                              fontWeight: 700,
                              cursor: 'pointer',
                            }}
                          >
                            {cdScanning ? '⏳' : '🔄'}
                          </button>
                          {opticalDisc?.drive_present && (
                            <button
                              data-row-aux="true"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleEjectOpticalDisc();
                              }}
                              title="Eject Optical Disc"
                              style={{
                                padding: '3px 6px',
                                borderRadius: 6,
                                background: '#1f1216',
                                border: '1px solid #4c2228',
                                color: '#fca5a5',
                                fontSize: 10,
                                fontWeight: 700,
                                cursor: 'pointer',
                              }}
                            >
                              ⏏
                            </button>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Inline Apple Music Accordion (never zeros other sources in PLACES) */}
            {sourceVisibility.apple_music && snap?.apple_authenticated && (
              <div
                data-rail-collapse-key="apple_nav"
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <button
                  data-xmb-drill-right="true"
                  data-rail-collapse-key="apple_nav"
                  data-left-active={browseHubTarget === 'apple_discover' ? 'true' : undefined}
                  onClick={() => {
                    pushCurrentNavState();
                    setActiveMountRoot(null);
                    if (browseHubTarget === 'apple_discover') {
                      setAppleNavOpen((v) => !v);
                    } else {
                      setAppleNavOpen(true);
                      setBrowseHubTarget('apple_discover');
                      if (appleSubTab === 'pinned') setAppleSubTab('for_you');
                      setRightPaneMode('browse');
                    }
                  }}
                  style={{
                    minHeight: 34,
                    padding: '0 10px',
                    borderRadius: 8,
                    background: browseHubTarget === 'apple_discover' ? '#241018' : '#0a0a0e',
                    border:
                      browseHubTarget === 'apple_discover'
                        ? '1px solid #fb7185'
                        : '1px solid #181820',
                    color: '#fecdd3',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <AppleMusicLogo size={13} />
                    <span>Apple Music</span>
                  </span>
                  <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#fda4af' }}>
                    {appleNavOpen ? '▾' : '▸'}
                  </span>
                </button>
                {appleNavOpen && (
                  <div
                    data-rail-collapse-key="apple_nav"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      paddingLeft: 10,
                      marginLeft: 6,
                      borderLeft: '2px solid #4c1d2e',
                    }}
                  >
                    {[
                      { id: 'for_you', label: '✨ For You' },
                      {
                        id: 'cloud_playlists',
                        label: `Apple Playlists${
                          cloudPlaylists.length ? ` (${cloudPlaylists.length})` : ''
                        }`,
                      },
                      { id: 'new', label: '🔥 New & Charts' },
                      { id: 'radio', label: '📻 Radio' },
                    ].map((hub) => {
                      const active =
                        browseHubTarget === 'apple_discover' &&
                        !activeMountRoot &&
                        appleSubTab === hub.id &&
                        rightPaneMode === 'browse';
                      return (
                        <button
                          key={hub.id}
                          data-left-active={active ? 'true' : undefined}
                          data-xmb-preview="true"
                          onClick={() => {
                            const isPreview = xmbPreviewTriggerRef.current;
                            if (
                              !isPreview &&
                              (browseHubTarget !== 'apple_discover' ||
                                appleSubTab !== hub.id ||
                                rightPaneMode !== 'browse')
                            ) {
                              pushCurrentNavState();
                            }
                            setActiveMountRoot(null);
                            setBrowseHubTarget('apple_discover');
                            setAppleSubTab(hub.id as any);
                            setRightPaneMode('browse');
                            if (!isPreview) focusRightPaneFirstTile();
                          }}
                          style={{
                            minHeight: 32,
                            padding: '0 10px',
                            borderRadius: 8,
                            background: active ? '#28111b' : '#0a0a0e',
                            border: active ? '1px solid #fa243c' : '1px solid #181820',
                            color: active ? '#fecdd3' : '#c8c8d2',
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: 'pointer',
                            textAlign: 'left',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span>
                            {hub.id === 'cloud_playlists' ? (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                                <AppleMusicLogo size={12} />
                                <span>{hub.label}</span>
                              </span>
                            ) : (
                              hub.label
                            )}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              fontFamily: 'monospace',
                              color: active ? '#fda4af' : '#71717a',
                            }}
                          >
                            ⊞
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Inline SoundCloud Accordion (never zeros other sources in PLACES) */}
            {sourceVisibility.soundcloud && (
              <div
                data-rail-collapse-key="sc_nav"
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <button
                  data-xmb-drill-right="true"
                  data-rail-collapse-key="sc_nav"
                  data-left-active={browseHubTarget === 'soundcloud_discover' ? 'true' : undefined}
                  onClick={() => {
                    pushCurrentNavState();
                    setActiveMountRoot(null);
                    if (browseHubTarget === 'soundcloud_discover') {
                      setScNavOpen((v) => !v);
                    } else {
                      setScNavOpen(true);
                      setBrowseHubTarget('soundcloud_discover');
                      if (soundCloudSubTab === 'pinned') setSoundCloudSubTab('trending');
                      setRightPaneMode('browse');
                    }
                  }}
                  style={{
                    minHeight: 34,
                    padding: '0 10px',
                    borderRadius: 8,
                    background:
                      browseHubTarget === 'soundcloud_discover' ? '#24130a' : '#0a0a0e',
                    border:
                      browseHubTarget === 'soundcloud_discover'
                        ? '1px solid #fb923c'
                        : '1px solid #181820',
                    color: '#fdba74',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <SoundCloudLogo width={28} color="#ffffff" />
                    <span>SoundCloud</span>
                  </span>
                  <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#fdba74' }}>
                    {scNavOpen ? '▾' : '▸'}
                  </span>
                </button>
                {scNavOpen && (
                  <div
                    data-rail-collapse-key="sc_nav"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      paddingLeft: 10,
                      marginLeft: 6,
                      borderLeft: '2px solid #59260a',
                    }}
                  >
                    {[
                      { id: 'trending', label: '🔥 Trending & Mixes' },
                      {
                        id: 'likes_sets',
                        label: `❤️ Likes & Sets${
                          scPlaylists.length + scLikedTracks.length
                            ? ` (${scPlaylists.length + (scLikedTracks.length > 0 ? 1 : 0)})`
                            : ''
                        }`,
                      },
                      { id: 'stream_radio', label: '⚡ Stream & Radio' },
                    ].map((hub) => {
                      const active =
                        browseHubTarget === 'soundcloud_discover' &&
                        !activeMountRoot &&
                        soundCloudSubTab === hub.id &&
                        rightPaneMode === 'browse';
                      return (
                        <button
                          key={hub.id}
                          data-left-active={active ? 'true' : undefined}
                          data-xmb-preview="true"
                          onClick={() => {
                            const isPreview = xmbPreviewTriggerRef.current;
                            if (
                              !isPreview &&
                              (browseHubTarget !== 'soundcloud_discover' ||
                                soundCloudSubTab !== hub.id ||
                                rightPaneMode !== 'browse')
                            ) {
                              pushCurrentNavState();
                            }
                            setActiveMountRoot(null);
                            setBrowseHubTarget('soundcloud_discover');
                            setSoundCloudSubTab(hub.id as any);
                            setRightPaneMode('browse');
                            if (!isPreview) focusRightPaneFirstTile();
                          }}
                          style={{
                            minHeight: 32,
                            padding: '0 10px',
                            borderRadius: 8,
                            background: active ? '#281409' : '#0a0a0e',
                            border: active ? '1px solid #ea580c' : '1px solid #181820',
                            color: active ? '#fdba74' : '#c8c8d2',
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: 'pointer',
                            textAlign: 'left',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span>{hub.label}</span>
                          <span
                            style={{
                              fontSize: 10,
                              fontFamily: 'monospace',
                              color: active ? '#fdba74' : '#71717a',
                            }}
                          >
                            ⊞
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* Inline Internet Archive Accordion (never zeros other sources in PLACES) */}
            {sourceVisibility.internet_archive && snap?.internet_archive_authenticated && (
              <div
                data-rail-collapse-key="ia_nav"
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
              >
                <button
                  data-xmb-drill-right="true"
                  data-rail-collapse-key="ia_nav"
                  data-left-active={browseHubTarget === 'ia_discover' ? 'true' : undefined}
                  onClick={() => {
                    pushCurrentNavState();
                    setActiveMountRoot(null);
                    if (browseHubTarget === 'ia_discover') {
                      setIaNavOpen((v) => !v);
                    } else {
                      setIaNavOpen(true);
                      setBrowseHubTarget('ia_discover');
                      if (iaSubTab === 'pinned') {
                        setIaSubTab('trending');
                        setIaSubFilter('all');
                      }
                      setRightPaneMode('browse');
                    }
                  }}
                  style={{
                    minHeight: 34,
                    padding: '0 10px',
                    borderRadius: 8,
                    background: browseHubTarget === 'ia_discover' ? '#261a0b' : '#0a0a0e',
                    border:
                      browseHubTarget === 'ia_discover'
                        ? '1px solid #f59e0b'
                        : '1px solid #181820',
                    color: '#fde68a',
                    fontSize: 12,
                    fontWeight: 700,
                    cursor: 'pointer',
                    textAlign: 'left',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <span>🏛️ Internet Archive</span>
                  <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#fde68a' }}>
                    {iaNavOpen ? '▾' : '▸'}
                  </span>
                </button>
                {iaNavOpen && (
                  <div
                    data-rail-collapse-key="ia_nav"
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      paddingLeft: 10,
                      marginLeft: 6,
                      borderLeft: '2px solid #78350f',
                    }}
                  >
                    {[
                      { id: 'trending', label: '🔥 Trending' },
                      { id: 'films', label: '🎬 Films & Cinema' },
                      { id: 'tv', label: '📺 TV & Animation' },
                      { id: 'audio', label: '🎵 Concerts & Audio' },
                    ].map((hub) => {
                      const active =
                        browseHubTarget === 'ia_discover' &&
                        !activeMountRoot &&
                        iaSubTab === hub.id &&
                        rightPaneMode === 'browse';
                      return (
                        <button
                          key={hub.id}
                          data-left-active={active ? 'true' : undefined}
                          data-xmb-preview="true"
                          onClick={() => {
                            const isPreview = xmbPreviewTriggerRef.current;
                            if (
                              !isPreview &&
                              (browseHubTarget !== 'ia_discover' ||
                                iaSubTab !== hub.id ||
                                rightPaneMode !== 'browse')
                            ) {
                              pushCurrentNavState();
                            }
                            setActiveMountRoot(null);
                            setBrowseHubTarget('ia_discover');
                            setIaSubTab(hub.id as any);
                            setIaSubFilter('all');
                            setRightPaneMode('browse');
                            if (!isPreview) focusRightPaneFirstTile();
                          }}
                          style={{
                            minHeight: 32,
                            padding: '0 10px',
                            borderRadius: 8,
                            background: active ? '#261a0b' : '#0a0a0e',
                            border: active ? '1px solid #f59e0b' : '1px solid #181820',
                            color: active ? '#fde68a' : '#c8c8d2',
                            fontSize: 12,
                            fontWeight: 700,
                            cursor: 'pointer',
                            textAlign: 'left',
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <span>{hub.label}</span>
                          <span
                            style={{
                              fontSize: 10,
                              fontFamily: 'monospace',
                              color: active ? '#fde68a' : '#71717a',
                            }}
                          >
                            ⊞
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          </div>
        )}

        {/* Re-Auth Prompt Pill (only shown when user has pinned Apple content while signed out) */}
        {appleAuthState === 'reauth_required' && browserSourceFilter !== 'local' && (
          <div
            style={{
              padding: '8px 10px',
              borderRadius: 10,
              background: '#1f1410',
              border: '1px solid #78350f',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span style={{ fontSize: 11, color: '#fcd34d', fontWeight: 700 }}>
              ⚠️ Apple Music session signed out
            </span>
            <button
              onClick={() => setSourceModalOpen(true)}
              style={{
                padding: '4px 8px',
                borderRadius: 6,
                background: '#2a131c',
                border: '1px solid #fa243c',
                color: '#fecdd3',
                fontSize: 10,
                fontWeight: 800,
                cursor: 'pointer',
                flexShrink: 0,
              }}
            >
              Reconnect
            </button>
          </div>
        )}

        {/* =================================================================
            COLLAPSIBLE BUCKET 1: ▾ SIMP PLAYLISTS (HYBRID & PINNED) + Embedded [+]
           ================================================================= */}
        <div
          style={{
            marginTop: 2,
            background: '#0d0d14',
            border: '1px solid #1e1e28',
            borderRadius: 8,
            padding: '3px 6px 3px 10px',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <button
            data-xmb-drill-right="true"
            data-rail-collapse-key="imp_playlists"
            onClick={togglePlaylistsOpen}
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              padding: '3px 0',
              color: '#c8c8d4',
              fontSize: 11,
              fontFamily: 'monospace',
              fontWeight: 800,
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            {playlistsOpen ? '▾' : '▸'} IMP PLAYLISTS ({filteredPlaylists.length})
          </button>
          <button
            data-xmb-drill-action="true"
            onClick={(e) => {
              e.stopPropagation();
              if (!playlistsOpen) {
                togglePlaylistsOpen();
              }
              setCreatingPlaylist((v) => {
                const next = !v;
                if (next) {
                  window.setTimeout(() => {
                    const inputEl = document.querySelector<HTMLElement>(
                      '[data-osk-input="playlist"]'
                    );
                    if (inputEl) inputEl.focus();
                  }, 30);
                }
                return next;
              });
            }}
            title={creatingPlaylist ? 'Cancel New IMP Playlist' : 'Create New IMP Hybrid Playlist'}
            style={{
              padding: '2px 8px',
              borderRadius: 6,
              background: creatingPlaylist ? '#221116' : '#0f222a',
              border: creatingPlaylist ? '1px solid #5c222d' : '1px solid #2aa3c4',
              color: creatingPlaylist ? '#fca5a5' : '#67e8f9',
              fontSize: 11,
              fontFamily: 'monospace',
              fontWeight: 800,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            {creatingPlaylist ? '✕' : '+'}
          </button>
        </div>

        {playlistsOpen && creatingPlaylist && (
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              type="text"
              data-osk-input="playlist"
              placeholder="New IMP Playlist name..."
              value={newPlaylistName}
              onChange={(e) => setNewPlaylistName(e.target.value)}
              onClick={(e) => {
                if (e.detail === 0 || document.documentElement.dataset.simpInput === 'gamepad') {
                  setOskTarget('playlist');
                  if (window.parent && window.parent !== window) {
                    window.parent.postMessage({ type: 'SIMP_OPEN_OSK' }, '*');
                  }
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreatePlaylist();
              }}
              style={{
                flex: 1,
                minHeight: 36,
                padding: '0 10px',
                borderRadius: 8,
                background: '#08080c',
                border: '1px solid #2e2e3c',
                color: '#d4d4dc',
                fontSize: 12,
              }}
            />
            <button
              data-row-aux="true"
              onClick={handleCreatePlaylist}
              style={{
                minHeight: 36,
                padding: '0 12px',
                borderRadius: 8,
                background: '#0f222a',
                color: '#bfeaf5',
                border: '1px solid #2aa3c4',
                fontWeight: 800,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Save
            </button>
          </div>
        )}

        {playlistsOpen &&
          filteredPlaylists.map((pl) => {
            const isSelected =
              rightPaneMode === 'tracks' &&
              browserTarget?.kind === 'playlist' &&
              browserTarget.id === pl.id;
            const isLocalPlaylist = pl.origin === 'simp_local';
            const isActiveTarget = isLocalPlaylist && activePlaylistId === pl.id;
            const cleanTitle = cleanCollectionTitle(pl.name);
            return (
              <button
                key={pl.id}
                data-left-active={isSelected ? 'true' : undefined}
                data-left-hybrid-id={isLocalPlaylist ? pl.id : undefined}
                data-left-playlist-id={pl.id}
                data-left-playlist-name={cleanTitle}
                data-left-context-kind="simp_playlist"
                data-left-context-id={pl.id}
                data-xmb-preview="true"
                onContextMenu={(e) => {
                  e.preventDefault();
                  openLeftItemContextMenu('simp_playlist', pl.id);
                }}
                onClick={() => {
                  if (isLocalPlaylist) {
                    setActivePlaylistId(pl.id);
                  }
                  setImpFypActive(false);
                  selectLocalCollection({ kind: 'playlist', id: pl.id });
                }}
                style={{
                  minHeight: 36,
                  padding: '0 10px',
                  borderRadius: 9,
                  background: isSelected ? '#0d1b22' : '#0a0a0e',
                  border: isSelected ? '1px solid #2aa3c4' : '1px solid #181820',
                  color: '#d4d4dc',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  gap: 8,
                  textAlign: 'left',
                  cursor: 'pointer',
                  width: '100%',
                  boxSizing: 'border-box',
                }}
              >
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    minWidth: 0,
                    flex: 1,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  {isLocalPlaylist ? (
                    <ImpIcon
                      name={isActiveTarget ? 'star' : 'imp'}
                      size={12}
                      color={isActiveTarget ? '#67e8f9' : '#94a3b8'}
                    />
                  ) : pl.origin === 'local_pinned' ? (
                    <ImpIcon name="local" size={12} color="#34d399" />
                  ) : pl.origin === 'soundcloud_remote' ? (
                    <ImpIcon name="soundcloud" size={11} color="#fdba74" />
                  ) : pl.origin === 'archive_remote' ? (
                    <ImpIcon name="archive" size={12} color="#facc15" />
                  ) : (
                    <AppleMusicLogo size={12} />
                  )}
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {cleanTitle}
                  </span>
                </span>
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: '#2aa3c4',
                    flexShrink: 0,
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 3,
                  }}
                >
                  {isLocalPlaylist && pl.has_local && <ImpIcon name="local" size={10} color="#34d399" />}
                  {isLocalPlaylist && pl.has_apple && <AppleMusicLogo size={10} />}
                  {isLocalPlaylist && pl.has_soundcloud && <ImpIcon name="soundcloud" size={9} color="#fdba74" />}
                  {isLocalPlaylist && pl.has_archive && <ImpIcon name="archive" size={10} color="#facc15" />}
                  <span>{pl.track_count}</span>
                </span>
              </button>
            );
          })}

      </div>
    </>
  );
};
