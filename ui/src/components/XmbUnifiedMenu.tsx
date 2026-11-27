import React, { useEffect, useRef, useState } from 'react';
import {
  AppleMusicAuthConfig,
  defaultSimpClient,
  OpticalDiscStatus,
  SimpStateSnapshot,
  SoundCloudAuthConfig,
} from '@imp/client';
import { OskTargetKind } from '../hooks/useGamepadNavigation';
import { FolderChooserModal } from './FolderChooserModal';
import { deleteDaemonUiPrefs, resolveDaemonUrl, saveDaemonUiPrefs } from '../api/servicesCacheApi';
import { loadStatsHudEnabled, saveStatsHudEnabled } from './StatsHudPill';
import { XmbSourceSubPanel } from './XmbSourceSubPanel';
import {
  cycleUiScalePreset,
  formatUiScaleLabel,
  saveUiScalePreset,
  useUiScale,
} from '../theme/uiScale';
import {
  type AudioDisplayBridgeState,
  buildMenuCorpus,
  cycleGamepadFocusPolicy,
  cycleIdleTimerSec,
  DEFAULT_NETWORKED_RETRIEVAL_PREFS,
  dispatchAudioDisplayCommand,
  formatIdleTimerLabel,
  type GamepadFocusPolicy,
  loadGamepadFocusPolicy,
  type NetworkedRetrievalPrefs,
  readAudioDisplayState,
  saveGamepadFocusPolicy,
  type SimpUpdateStatus,
  type SourceVisibilityPrefs,
  type XmbColumnId,
  type XmbSourceSubPanelId,
} from '../menu/menuCorpus';

interface DaemonPerfSnapshot {
  cpu_percent: number;
  rss_mb: number;
  platform: string;
  audio_backend: string;
}

export interface XmbUnifiedMenuProps {
  snap: SimpStateSnapshot | null;
  customFolderPath: string;
  setCustomFolderPath: React.Dispatch<React.SetStateAction<string>>;
  setOskTarget: React.Dispatch<React.SetStateAction<OskTargetKind>>;
  handleAddFolder: (folderPath: string, opts?: { navigateAfterAdd?: boolean }) => void;
  handleRemoveFolder: (mountRoot: string, label: string) => void;
  setSourceModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setPowerModalOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setIsSleeping: React.Dispatch<React.SetStateAction<boolean>>;
  dismissConsole: () => void;
  brightnessPct: number;
  setBrightnessPct: React.Dispatch<React.SetStateAction<number>>;
  idleTimerSec?: number;
  onChangeIdleTimerSec?: (sec: number) => void;
  updateStatus: SimpUpdateStatus;
  setUpdateStatus?: React.Dispatch<React.SetStateAction<SimpUpdateStatus>>;
  checkSimpUpdates: (silent?: boolean) => Promise<void>;
  applySimpUpdate: () => Promise<void>;
  confirmHardReset: boolean;
  setConfirmHardReset: React.Dispatch<React.SetStateAction<boolean>>;
  opticalDisc: OpticalDiscStatus | null;
  cdScanning: boolean;
  handleScanOpticalDisc: (forceRefresh?: boolean, silent?: boolean) => Promise<void>;
  handleEjectOpticalDisc: () => void;
  appleAuthCfg: AppleMusicAuthConfig | null;
  setAppleAuthCfg: React.Dispatch<React.SetStateAction<AppleMusicAuthConfig | null>>;
  appleBusy: boolean;
  setAppleBusy: React.Dispatch<React.SetStateAction<boolean>>;
  soundcloudAuthCfg: SoundCloudAuthConfig | null;
  setSoundcloudAuthCfg: React.Dispatch<React.SetStateAction<SoundCloudAuthConfig | null>>;
  soundcloudBusy: boolean;
  setSoundcloudBusy: React.Dispatch<React.SetStateAction<boolean>>;
  sourceVisibility: SourceVisibilityPrefs;
  setSourceVisibility: React.Dispatch<React.SetStateAction<SourceVisibilityPrefs>>;
  refreshLibraryData: () => void;
  applyFocusMarker?: (el: HTMLElement | null) => void;
  showToast: (msg: string) => void;
  onOpenQuickHelp?: () => void;
  initialOpenFoldersAccounts?: boolean;
  isDeckyEmbedded?: boolean;
  desktopMode?: boolean;
  onToggleDesktopMode?: (next: boolean) => void;
  expiredAuthProviders?: Array<'apple' | 'soundcloud'>;
}

const smallStepBtnStyle: React.CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 5,
  background: 'var(--imp-surface-panel, #161920)',
  border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
  color: 'var(--imp-text-primary, #eef0f4)',
  fontSize: 12,
  fontWeight: 800,
  cursor: 'pointer',
  flexShrink: 0,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  userSelect: 'none',
};

const RETRIEVAL_KEY_MAP: Record<
  keyof NetworkedRetrievalPrefs,
  { field: string; label: string }
> = {
  lyrics: { field: 'fetch_lyrics_online', label: 'Lyrics Retrieval' },
  artwork: { field: 'fetch_artwork_online', label: 'Artwork Retrieval' },
  factoids: { field: 'fetch_factoids_online', label: 'Factoids Retrieval' },
  discMetadata: { field: 'fetch_disc_metadata_online', label: 'Album/DVD Track Data' },
  scComments: { field: 'fetch_sc_comments_online', label: 'SoundCloud Comments Retrieval' },
};

// Pure in-memory session recall for the last accessed XMB column and cursor item per column.
let lastXmbColMemory: XmbColumnId = 'system_network';
const lastXmbItemIdByCol: Partial<Record<XmbColumnId, string>> = {};

export const XmbUnifiedMenu: React.FC<XmbUnifiedMenuProps> = ({
  snap,
  customFolderPath,
  setCustomFolderPath,
  setOskTarget,
  handleAddFolder,
  handleRemoveFolder,
  setSourceModalOpen,
  setPowerModalOpen,
  setIsSleeping,
  dismissConsole,
  brightnessPct,
  setBrightnessPct,
  idleTimerSec = 30,
  onChangeIdleTimerSec,
  updateStatus,
  setUpdateStatus,
  checkSimpUpdates,
  applySimpUpdate,
  confirmHardReset,
  setConfirmHardReset,
  opticalDisc,
  cdScanning,
  handleScanOpticalDisc,
  handleEjectOpticalDisc,
  appleAuthCfg,
  setAppleAuthCfg,
  appleBusy,
  setAppleBusy,
  soundcloudAuthCfg,
  setSoundcloudAuthCfg,
  soundcloudBusy,
  setSoundcloudBusy,
  sourceVisibility,
  setSourceVisibility,
  refreshLibraryData,
  applyFocusMarker,
  showToast,
  onOpenQuickHelp,
  initialOpenFoldersAccounts,
  isDeckyEmbedded = false,
  desktopMode = false,
  onToggleDesktopMode,
  expiredAuthProviders = [],
}) => {
  const [activeCol, setActiveCol] = useState<XmbColumnId>(
    initialOpenFoldersAccounts ? 'audio_sources' : lastXmbColMemory
  );
  const [activeSubPanel, setActiveSubPanel] = useState<XmbSourceSubPanelId | null>(
    initialOpenFoldersAccounts ? 'accounts' : null
  );
  const mainColRef = useRef<HTMLDivElement | null>(null);
  const [folderChooserOpen, setFolderChooserOpen] = useState(false);
  const [brightnessScrubActive, setBrightnessScrubActive] = useState(false);

  const [audioState, setAudioState] = useState<AudioDisplayBridgeState>(() =>
    readAudioDisplayState()
  );
  const [statsHudEnabled, setStatsHudEnabled] = useState<boolean>(() => loadStatsHudEnabled());
  const [gamepadPolicy, setGamepadPolicy] = useState<GamepadFocusPolicy>(() =>
    loadGamepadFocusPolicy()
  );
  const { preset: uiScalePreset, scale: uiScaleEffective } = useUiScale();
  const [networkedRetrieval, setNetworkedRetrieval] = useState<NetworkedRetrievalPrefs>(
    DEFAULT_NETWORKED_RETRIEVAL_PREFS
  );
  const [perfSnap, setPerfSnap] = useState<DaemonPerfSnapshot | null>(null);

  const [iaUsername, setIaUsername] = useState('');
  const [savedIaUsername, setSavedIaUsername] = useState('');
  const [iaEnabledLocal, setIaEnabledLocal] = useState(
    snap?.internet_archive_authenticated ?? true
  );
  const [iaSafeSearch, setIaSafeSearch] = useState(true);

  const closeMenu = () => {
    setSourceModalOpen(false);
    setPowerModalOpen(false);
    setConfirmHardReset(false);
    setBrightnessScrubActive(false);
    setActiveSubPanel(null);
  };

  useEffect(() => {
    setIaEnabledLocal(snap?.internet_archive_authenticated ?? true);
    defaultSimpClient
      .getInternetArchiveConfig()
      .then((cfg) => {
        if (cfg) {
          setIaEnabledLocal(cfg.enabled ?? true);
          const loadedUser = cfg.username || '';
          setIaUsername(loadedUser);
          setSavedIaUsername(loadedUser);
          setIaSafeSearch(cfg.safe_search ?? true);
        }
      })
      .catch(() => {});
  }, [snap?.internet_archive_authenticated]);

  useEffect(() => {
    let cancelled = false;
    fetch(resolveDaemonUrl('/api/settings/privacy'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled || !data?.ok) return;
        setNetworkedRetrieval({
          lyrics: data.fetch_lyrics_online ?? true,
          artwork: data.fetch_artwork_online ?? true,
          factoids: data.fetch_factoids_online ?? true,
          discMetadata: data.fetch_disc_metadata_online ?? true,
          scComments: data.fetch_sc_comments_online ?? true,
        });
        const ch = typeof data.update_channel === 'string' ? data.update_channel.toLowerCase() : '';
        if (ch && setUpdateStatus) {
          setUpdateStatus((prev) => ({ ...prev, channel: ch }));
        }
        if (ch !== 'off' && !updateStatus.latest_version && !updateStatus.checking) {
          checkSimpUpdates(true);
        }
      })
      .catch(() => {
        const chLower = (updateStatus.channel || 'stable').toLowerCase();
        if (chLower !== 'off' && !updateStatus.latest_version && !updateStatus.checking) {
          checkSimpUpdates(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onAudioState = (ev: Event) => {
      const detail = (ev as CustomEvent<AudioDisplayBridgeState>).detail;
      if (detail) setAudioState(detail);
    };
    const onStatsHudChanged = () => setStatsHudEnabled(loadStatsHudEnabled());
    const onBrightnessStep = (ev: Event) => {
      const delta = (ev as CustomEvent<{ delta?: number }>).detail?.delta ?? 0;
      if (delta !== 0) {
        setBrightnessPct((b) => Math.max(25, Math.min(100, b + delta)));
      }
    };
    const onBrightnessExit = () => setBrightnessScrubActive(false);
    const onSwitchCol = (ev: Event) => {
      const dir = (ev as CustomEvent<{ dir?: 'left' | 'right' }>).detail?.dir;
      if (!dir) return;
      const order: XmbColumnId[] = ['display', 'audio_sources', 'system_network'];
      setActiveCol((prev) => {
        const idx = order.indexOf(prev);
        const nextIdx =
          dir === 'right' ? (idx + 1) % order.length : (idx + order.length - 1) % order.length;
        return order[nextIdx];
      });
      setActiveSubPanel(null);
      window.setTimeout(() => {
        const target =
          document.querySelector<HTMLElement>(
            '[data-xmb-col="main"] [data-xmb-item="true"][data-default-focus="true"]:not([disabled])'
          ) ||
          document.querySelector<HTMLElement>(
            '[data-xmb-col="main"] [data-xmb-item="true"]:not([disabled])'
          );
        if (target && applyFocusMarker) applyFocusMarker(target);
      }, 20);
    };

    window.addEventListener('imp-audio-display-state', onAudioState);
    window.addEventListener('imp-stats-hud-changed', onStatsHudChanged);
    window.addEventListener('simp-brightness-step', onBrightnessStep);
    window.addEventListener('simp-brightness-exit', onBrightnessExit);
    window.addEventListener('simp-xmb-switch-col', onSwitchCol);
    return () => {
      window.removeEventListener('imp-audio-display-state', onAudioState);
      window.removeEventListener('imp-stats-hud-changed', onStatsHudChanged);
      window.removeEventListener('simp-brightness-step', onBrightnessStep);
      window.removeEventListener('simp-brightness-exit', onBrightnessExit);
      window.removeEventListener('simp-xmb-switch-col', onSwitchCol);
    };
  }, [applyFocusMarker, setBrightnessPct]);

  useEffect(() => {
    lastXmbColMemory = activeCol;
  }, [activeCol]);

  useEffect(() => {
    const root = mainColRef.current;
    if (!root || typeof MutationObserver === 'undefined') return;
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type !== 'attributes' || m.attributeName !== 'data-simp-active-focus') continue;
        const el = m.target as HTMLElement | null;
        const itemId = el?.dataset?.xmbItemId;
        if (el?.getAttribute('data-simp-active-focus') === 'true' && itemId) {
          lastXmbItemIdByCol[activeCol] = itemId;
        }
      }
    });
    observer.observe(root, {
      subtree: true,
      attributes: true,
      attributeFilter: ['data-simp-active-focus'],
    });
    return () => observer.disconnect();
  }, [activeCol]);

  useEffect(() => {
    let cancelled = false;
    const pollPerf = async () => {
      if (document.visibilityState === 'hidden') return;
      try {
        const res = await fetch(resolveDaemonUrl('/api/v1/system/perf'));
        if (res.ok) {
          const data = (await res.json()) as DaemonPerfSnapshot;
          if (!cancelled) setPerfSnap(data);
        }
      } catch {
        // Ignore offline error
      }
    };
    pollPerf();
    const timer = window.setInterval(pollPerf, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const toggleSourceVisible = (key: keyof SourceVisibilityPrefs) => {
    setSourceVisibility((prev) => {
      const nextVal = !prev[key];
      const next = { ...prev, [key]: nextVal };
      try {
        window.localStorage.setItem('simp_source_visibility_v2', JSON.stringify(next));
      } catch {}
      void saveDaemonUiPrefs({ source_visibility_v2: next });
      if (key === 'internet_archive') {
        defaultSimpClient.configureInternetArchive({
          enabled: nextVal,
          username: iaUsername.trim(),
          safe_search: iaSafeSearch,
        });
        setIaEnabledLocal(nextVal);
      }
      return next;
    });
  };

  const handleCommitIaUsername = (raw: string) => {
    const normalized = raw.trim().replace(/^@+/, '');
    const nextEnabled = normalized ? true : sourceVisibility.internet_archive || iaEnabledLocal;
    defaultSimpClient.configureInternetArchive({
      enabled: nextEnabled,
      username: normalized,
      safe_search: iaSafeSearch,
    });
    setIaUsername(normalized);
    setSavedIaUsername(normalized);
    setIaEnabledLocal(nextEnabled);
    if (normalized) {
      setSourceVisibility((p) => {
        const next = { ...p, internet_archive: true };
        void saveDaemonUiPrefs({ source_visibility_v2: next });
        return next;
      });
    }
    showToast(normalized ? `Saved Archive @${normalized}` : 'Cleared Archive username');
    refreshLibraryData();
  };

  const handleToggleNetworkedRetrieval = async (key: keyof NetworkedRetrievalPrefs) => {
    const meta = RETRIEVAL_KEY_MAP[key];
    const nextVal = !networkedRetrieval[key];
    setNetworkedRetrieval((prev) => ({ ...prev, [key]: nextVal }));
    try {
      const resp = await fetch(resolveDaemonUrl('/api/settings/privacy'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [meta.field]: nextVal }),
      });
      const json = await resp.json().catch(() => null);
      if (json?.ok) {
        setNetworkedRetrieval({
          lyrics: json.fetch_lyrics_online ?? true,
          artwork: json.fetch_artwork_online ?? true,
          factoids: json.fetch_factoids_online ?? true,
          discMetadata: json.fetch_disc_metadata_online ?? true,
          scComments: json.fetch_sc_comments_online ?? true,
        });
      }
      showToast(`${meta.label}: ${nextVal ? 'On (Online)' : 'Off (Cached Only)'}`);
    } catch {
      setNetworkedRetrieval((prev) => ({ ...prev, [key]: !nextVal }));
      showToast('Failed to save retrieval policy');
    }
  };

  const soundCloudUserLabel =
    soundcloudAuthCfg?.auth_mode === 'user' &&
    soundcloudAuthCfg?.username &&
    soundcloudAuthCfg.username !== 'Public Discovery (Client Credentials)'
      ? `@${soundcloudAuthCfg.username}`
      : 'Public';

  const columns = buildMenuCorpus({
    audio: audioState,
    isDeckyEmbedded,
    desktopMode,
    uiScalePreset,
    uiScaleEffective,
    idleTimerSec,
    statsHudEnabled,
    folderCount: snap?.mounts?.length || 0,
    sourceVisibility,
    appleConnected: Boolean(snap?.apple_authenticated),
    soundCloudUserLabel,
    expiredAuthProviders,
    brightnessPct,
    gamepadPolicy,
    networkedRetrieval,
    updateStatus,
  });

  const currentColumn = columns.find((c) => c.id === activeCol) || columns[0];
  const focusableColumnItems = currentColumn.items.filter((i) => i.kind !== 'separator');
  const rememberedItemId = lastXmbItemIdByCol[activeCol];
  const defaultFocusItemId =
    (rememberedItemId && focusableColumnItems.some((i) => i.id === rememberedItemId)
      ? rememberedItemId
      : focusableColumnItems[0]?.id) || undefined;

  const openSubPanel = (panelId: XmbSourceSubPanelId) => {
    setActiveSubPanel((prev) => {
      const next = prev === panelId ? null : panelId;
      if (next) {
        window.setTimeout(() => {
          const firstSub =
            document.querySelector<HTMLElement>(
              '[data-xmb-col="sub"] [data-sub-default="true"]:not([disabled])'
            ) ||
            document.querySelector<HTMLElement>('[data-xmb-col="sub"] button:not([disabled])');
          if (firstSub && applyFocusMarker) applyFocusMarker(firstSub);
        }, 30);
      }
      return next;
    });
  };

  const executeResetLibraryDb = () => {
    defaultSimpClient.resetDatabaseCache();
    showToast('Rescanning folders...');
    closeMenu();
    window.setTimeout(() => refreshLibraryData(), 600);
  };

  const executeHardResetImp = () => {
    defaultSimpClient.factoryReset();
    try {
      window.localStorage.removeItem('simp_source_visibility_v2');
      window.localStorage.removeItem('simp_brightness_pct_v2');
      window.localStorage.removeItem('simp_idle_opacity_pct');
      window.localStorage.removeItem('simp_factoids_enabled');
      window.localStorage.removeItem('simp_oobe_help_seen_v1');
      window.localStorage.removeItem('imp_update_channel_v1');
      window.localStorage.removeItem('imp_stats_hud_enabled_v1');
      window.localStorage.setItem('simp.visualizer_mode', 'cycle');
    } catch {}
    saveStatsHudEnabled(false, false);
    setStatsHudEnabled(false);
    void deleteDaemonUiPrefs(['source_visibility_v2', 'stats_hud_enabled_v1']);
    setBrightnessPct(100);
    setSourceVisibility({
      internet_archive: true,
      apple_music: true,
      soundcloud: true,
      optical_drive: false,
    });
    setIaEnabledLocal(true);
    setIaUsername('');
    setSavedIaUsername('');
    setIaSafeSearch(true);
    setNetworkedRetrieval(DEFAULT_NETWORKED_RETRIEVAL_PREFS);
    lastXmbColMemory = 'system_network';
    (Object.keys(lastXmbItemIdByCol) as XmbColumnId[]).forEach((k) => {
      delete lastXmbItemIdByCol[k];
    });
    closeMenu();
    showToast('Factory reset complete');
    window.setTimeout(() => refreshLibraryData(), 600);
  };

  const handleItemAction = (id: string, subPanelId?: XmbSourceSubPanelId, shiftKey = false) => {
    if (subPanelId) {
      openSubPanel(subPanelId);
      return;
    }

    switch (id) {
      case 'equalizer':
        closeMenu();
        dispatchAudioDisplayCommand({ type: 'open_equalizer' });
        return;
      case 'visualizer':
        closeMenu();
        dispatchAudioDisplayCommand({ type: 'open_visualizer' });
        return;
      case 'desktop_mode':
        if (!isDeckyEmbedded && onToggleDesktopMode) {
          onToggleDesktopMode(!desktopMode);
        }
        return;
      case 'ui_scale': {
        const next = cycleUiScalePreset(uiScalePreset);
        saveUiScalePreset(next);
        showToast(`UI Scale: ${formatUiScaleLabel(next)}`);
        return;
      }
      case 'idle_timer': {
        const nextSec = cycleIdleTimerSec(idleTimerSec);
        if (onChangeIdleTimerSec) {
          onChangeIdleTimerSec(nextSec);
        }
        dispatchAudioDisplayCommand({ type: 'set_idle_fade', enabled: nextSec > 0 });
        showToast(`Idle Timer: ${formatIdleTimerLabel(nextSec)}`);
        return;
      }
      case 'idle_opacity':
        dispatchAudioDisplayCommand({
          type: 'step_idle_opacity',
          delta: audioState.idleOpacityPct >= 90 ? -90 : 15,
        });
        return;
      case 'stats_hud': {
        const next = !statsHudEnabled;
        saveStatsHudEnabled(next);
        setStatsHudEnabled(next);
        return;
      }
      case 'theatre_fullscreen':
        dispatchAudioDisplayCommand({ type: 'toggle_theatre_fullscreen' });
        return;
      case 'video_quality':
        dispatchAudioDisplayCommand({ type: 'cycle_video_quality' });
        return;
      case 'video_subtitles':
        dispatchAudioDisplayCommand({ type: 'cycle_video_subtitles' });
        return;
      case 'sleep_screen':
        closeMenu();
        setIsSleeping(true);
        return;
      case 'brightness':
        setBrightnessScrubActive((v) => !v);
        return;
      case 'gamepad_focus': {
        const next = cycleGamepadFocusPolicy(gamepadPolicy);
        saveGamepadFocusPolicy(next);
        setGamepadPolicy(next);
        return;
      }
      case 'update_channel': {
        const cur = (updateStatus.channel || 'stable').toLowerCase();
        const nextChannel = cur === 'stable' ? 'alpha' : cur === 'alpha' ? 'off' : 'stable';
        try {
          window.localStorage.setItem('imp_update_channel_v1', nextChannel);
        } catch {}
        if (setUpdateStatus) {
          setUpdateStatus((prev) => ({
            ...prev,
            channel: nextChannel,
            update_available: nextChannel === 'off' ? false : prev.update_available,
            channel_switch_available:
              nextChannel === 'off' ? false : prev.channel_switch_available,
          }));
        }
        fetch(resolveDaemonUrl('/api/update/channel'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: nextChannel }),
        })
          .then(() => {
            showToast(
              nextChannel === 'off'
                ? 'Update Channel: Off (auto-check disabled)'
                : nextChannel === 'stable'
                  ? 'Channel: Stable'
                  : 'Channel: Alpha'
            );
            if (nextChannel !== 'off') {
              checkSimpUpdates(false);
            }
          })
          .catch(() => {
            showToast('Failed to switch update channel');
          });
        return;
      }
      case 'check_updates':
        if (updateStatus.update_available || updateStatus.channel_switch_available) {
          applySimpUpdate();
        } else {
          checkSimpUpdates(false);
        }
        return;
      case 'quick_help':
        if (onOpenQuickHelp) {
          closeMenu();
          onOpenQuickHelp();
        }
        return;
      case 'quit_imp':
        if (shiftKey) {
          defaultSimpClient.pause();
          defaultSimpClient.restartDaemon();
          fetch(resolveDaemonUrl('/api/v1/transport'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: 'restart_daemon' }),
            keepalive: true,
          }).catch(() => {});
          showToast('Restarting service...');
          closeMenu();
          if (window.parent && window.parent !== window) {
            window.setTimeout(() => dismissConsole(), 300);
          } else {
            window.setTimeout(() => window.location.reload(), 900);
          }
          return;
        }
        defaultSimpClient.shutdownDaemon();
        fetch(resolveDaemonUrl('/api/v1/transport'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command: 'shutdown_daemon' }),
          keepalive: true,
        }).catch(() => {});
        closeMenu();
        window.setTimeout(() => dismissConsole(), 180);
        return;
    }
  };

  const hasNestedChildOpen =
    brightnessScrubActive || confirmHardReset || activeSubPanel !== null || folderChooserOpen;

  const handleWalkBack = () => {
    const chooserClose = document.querySelector<HTMLElement>('[data-folder-chooser-close="true"]');
    if (chooserClose) {
      chooserClose.click();
    } else if (brightnessScrubActive) {
      setBrightnessScrubActive(false);
    } else if (confirmHardReset) {
      setConfirmHardReset(false);
    } else if (activeSubPanel !== null) {
      const prevPanel = activeSubPanel;
      setActiveSubPanel(null);
      window.setTimeout(() => {
        const trigger = document.querySelector<HTMLElement>(
          `[data-xmb-col="main"] [data-xmb-sub-id="${prevPanel}"]`
        );
        if (trigger && applyFocusMarker) applyFocusMarker(trigger);
      }, 20);
    }
  };

  return (
    <div
      onClick={closeMenu}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.72)',
        zIndex: 55,
      }}
    >
      {hasNestedChildOpen && (
        <button
          type="button"
          data-xmb-walk-back="true"
          onClick={handleWalkBack}
          style={{ display: 'none' }}
        />
      )}

      <div
        data-modal-root="true"
        data-xmb-menu="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          top: 56,
          right: 16,
          maxWidth: 'calc(100vw / var(--imp-ui-scale, 1) - 32px)',
          maxHeight: 'calc(100vh / var(--imp-ui-scale, 1) - 72px)',
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'flex-start',
          gap: 10,
        }}
      >
        {activeSubPanel !== null && (
          <XmbSourceSubPanel
            activeSubPanel={activeSubPanel}
            onCloseSubPanel={handleWalkBack}
            audioState={audioState}
            networkedRetrieval={networkedRetrieval}
            onToggleNetworkedRetrieval={handleToggleNetworkedRetrieval}
            snap={snap}
            customFolderPath={customFolderPath}
            setCustomFolderPath={setCustomFolderPath}
            setOskTarget={setOskTarget}
            handleAddFolder={handleAddFolder}
            handleRemoveFolder={handleRemoveFolder}
            folderChooserOpen={folderChooserOpen}
            setFolderChooserOpen={setFolderChooserOpen}
            sourceVisibility={sourceVisibility}
            toggleSourceVisible={toggleSourceVisible}
            setSourceVisibility={setSourceVisibility}
            appleAuthCfg={appleAuthCfg}
            setAppleAuthCfg={setAppleAuthCfg}
            appleBusy={appleBusy}
            setAppleBusy={setAppleBusy}
            soundcloudAuthCfg={soundcloudAuthCfg}
            setSoundcloudAuthCfg={setSoundcloudAuthCfg}
            soundcloudBusy={soundcloudBusy}
            setSoundcloudBusy={setSoundcloudBusy}
            iaUsername={iaUsername}
            savedIaUsername={savedIaUsername}
            setIaUsername={setIaUsername}
            onCommitIaUsername={handleCommitIaUsername}
            iaSafeSearch={iaSafeSearch}
            setIaSafeSearch={setIaSafeSearch}
            iaEnabledLocal={iaEnabledLocal}
            setIaEnabledLocal={setIaEnabledLocal}
            opticalDisc={opticalDisc}
            cdScanning={cdScanning}
            handleScanOpticalDisc={handleScanOpticalDisc}
            handleEjectOpticalDisc={handleEjectOpticalDisc}
            confirmHardReset={confirmHardReset}
            setConfirmHardReset={setConfirmHardReset}
            onResetLibraryDb={executeResetLibraryDb}
            onExecuteHardReset={executeHardResetImp}
            refreshLibraryData={refreshLibraryData}
            showToast={showToast}
          />
        )}

        {/* Primary 3-Column XMB Cross-Bar */}
        <div
          ref={mainColRef}
          data-xmb-col="main"
          style={{
            width: 'min(520px, calc(100vw / var(--imp-ui-scale, 1) - 32px))',
            maxHeight: 'calc(100vh / var(--imp-ui-scale, 1) - 72px)',
            overflowY: 'auto',
            background: 'var(--imp-surface-panel, #161920)',
            border: '1px solid var(--imp-border-strong, rgba(255, 255, 255, 0.16))',
            borderRadius: 8,
            padding: 14,
            boxSizing: 'border-box',
            boxShadow: '0 20px 52px rgba(0, 0, 0, 0.78)',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            flexShrink: 1,
            minWidth: 0,
          }}
        >
          {/* Top Bar */}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <strong
              style={{
                fontSize: 13,
                color: 'var(--imp-accent-active-text, #f5e1be)',
                letterSpacing: '0.02em',
              }}
            >
              Imp Menu<span className="simp-gp-badge"> (START)</span>
            </strong>
            <button
              type="button"
              data-xmb-close="true"
              onClick={closeMenu}
              style={{
                minHeight: 28,
                padding: '0 10px',
                borderRadius: 6,
                background: 'var(--imp-surface-card, #1a1d24)',
                border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                color: 'var(--imp-text-primary, #eef0f4)',
                fontFamily: 'monospace',
                fontSize: 11.5,
                cursor: 'pointer',
              }}
            >
              ✕<span className="simp-gp-badge"> B</span>
            </button>
          </div>

          {/* 3-Column Cross-Bar Selector */}
          <div
            data-xmb-tabs="true"
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
              borderBottom: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
              gap: 4,
            }}
          >
            {columns.map((col) => {
              const selected = col.id === activeCol;
              return (
                <button
                  key={col.id}
                  type="button"
                  data-xmb-tab={col.id}
                  data-no-dpad-focus="true"
                  onClick={() => {
                    setActiveCol(col.id);
                    setActiveSubPanel(null);
                  }}
                  style={{
                    minHeight: 34,
                    padding: '4px 6px',
                    background: 'transparent',
                    border: 'none',
                    borderBottom: selected
                      ? '2px solid var(--imp-focus-ring, #e8b86d)'
                      : '2px solid transparent',
                    color: selected
                      ? 'var(--imp-accent-active-text, #f5e1be)'
                      : 'var(--imp-text-secondary, #8b92a1)',
                    fontSize: 12,
                    fontWeight: selected ? 800 : 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 5,
                  }}
                >
                  <span>{col.label}</span>
                  {col.attention && (
                    <span
                      style={{
                        width: 14,
                        height: 14,
                        borderRadius: '50%',
                        background: '#ef4444',
                        color: '#ffffff',
                        fontSize: 9.5,
                        fontWeight: 900,
                        lineHeight: 1,
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      !
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Vertical Item List */}
          <div
            data-xmb-list="true"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {currentColumn.items.map((item) => {
                if (item.kind === 'separator') {
                  return (
                    <div
                      key={item.id}
                      style={{
                        height: 1,
                        margin: '3px 0',
                        background: 'var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                      }}
                    />
                  );
                }

                const isSubOpen = Boolean(item.subPanelId && activeSubPanel === item.subPanelId);
                const isBrightnessRow = item.id === 'brightness';
                const isIdleOpacityRow = item.id === 'idle_opacity';

                return (
                  <React.Fragment key={item.id}>
                    <button
                      type="button"
                      data-xmb-item="true"
                      data-xmb-item-id={item.id}
                      data-xmb-sub-id={item.subPanelId || undefined}
                      data-default-focus={item.id === defaultFocusItemId ? 'true' : undefined}
                      data-brightness-slider={isBrightnessRow ? 'true' : undefined}
                      data-brightness-scrub-active={
                        isBrightnessRow && brightnessScrubActive ? 'true' : undefined
                      }
                      onFocus={() => {
                        lastXmbItemIdByCol[activeCol] = item.id;
                      }}
                      onClick={(e) => {
                        lastXmbItemIdByCol[activeCol] = item.id;
                        handleItemAction(item.id, item.subPanelId, e.shiftKey);
                      }}
                    style={{
                      width: '100%',
                      minHeight: 36,
                      padding: '0 10px',
                      borderRadius: 6,
                      background: isSubOpen || (isBrightnessRow && brightnessScrubActive)
                        ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))'
                        : item.danger
                          ? '#221115'
                          : 'var(--imp-surface-card, #1a1d24)',
                      border: isSubOpen || (isBrightnessRow && brightnessScrubActive)
                        ? '1px solid var(--imp-focus-ring, #e8b86d)'
                        : item.danger
                          ? '1px solid #5c222d'
                          : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                      color: item.danger
                        ? '#fca5a5'
                        : isSubOpen
                          ? 'var(--imp-accent-active-text, #f5e1be)'
                          : 'var(--imp-text-primary, #eef0f4)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      gap: 10,
                      fontSize: 12.5,
                      fontWeight: 700,
                      cursor: 'pointer',
                      textAlign: 'left',
                    }}
                  >
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <span>{item.label}</span>
                      {item.attention && (
                        <span
                          style={{
                            width: 14,
                            height: 14,
                            borderRadius: '50%',
                            background: '#ef4444',
                            color: '#ffffff',
                            fontSize: 9.5,
                            fontWeight: 900,
                            lineHeight: 1,
                            display: 'inline-flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          !
                        </span>
                      )}
                    </span>
                    {item.value !== undefined && (
                      <span
                        style={{
                          fontFamily: 'monospace',
                          fontSize: 11,
                          fontWeight: 700,
                          color: item.attention
                            ? '#fca5a5'
                            : item.active
                            ? 'var(--imp-accent-active-text, #f5e1be)'
                            : 'var(--imp-text-secondary, #8b92a1)',
                        }}
                      >
                        {item.id === 'brightness' && brightnessScrubActive
                          ? `◄ ${brightnessPct}% ►`
                          : item.subPanelId
                            ? `${item.value} ▸`
                            : item.value}
                      </span>
                    )}
                  </button>

                  {isBrightnessRow && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'var(--imp-bg-canvas, #121418)',
                        border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() => setBrightnessPct((b) => Math.max(25, b - 5))}
                        style={smallStepBtnStyle}
                      >
                        −
                      </button>
                      <input
                        type="range"
                        tabIndex={-1}
                        min={25}
                        max={100}
                        step={5}
                        value={brightnessPct}
                        onChange={(e) => setBrightnessPct(Number(e.target.value))}
                        style={{
                          flex: 1,
                          accentColor: 'var(--imp-focus-ring, #e8b86d)',
                          cursor: 'pointer',
                          minWidth: 0,
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => setBrightnessPct((b) => Math.min(100, b + 5))}
                        style={smallStepBtnStyle}
                      >
                        +
                      </button>
                    </div>
                  )}

                  {isIdleOpacityRow && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '4px 10px',
                        borderRadius: 6,
                        background: 'var(--imp-bg-canvas, #121418)',
                        border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                      }}
                    >
                      <button
                        type="button"
                        onClick={() =>
                          dispatchAudioDisplayCommand({ type: 'step_idle_opacity', delta: -5 })
                        }
                        style={smallStepBtnStyle}
                      >
                        −
                      </button>
                      <input
                        type="range"
                        tabIndex={-1}
                        min={0}
                        max={90}
                        step={5}
                        value={audioState.idleOpacityPct}
                        onChange={(e) => {
                          const target = Number(e.target.value);
                          const delta = target - audioState.idleOpacityPct;
                          if (delta !== 0) {
                            dispatchAudioDisplayCommand({ type: 'step_idle_opacity', delta });
                          }
                        }}
                        style={{
                          flex: 1,
                          accentColor: 'var(--imp-focus-ring, #e8b86d)',
                          cursor: 'pointer',
                          minWidth: 0,
                        }}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          dispatchAudioDisplayCommand({ type: 'step_idle_opacity', delta: 5 })
                        }
                        style={smallStepBtnStyle}
                      >
                        +
                      </button>
                    </div>
                  )}
                </React.Fragment>
              );
            })}
          </div>

          {updateStatus.error && (
            <div style={{ fontSize: 10.5, color: '#fca5a5' }}>{updateStatus.error}</div>
          )}

          {/* Terse System Load Footer */}
          <div
            style={{
              paddingTop: 8,
              borderTop: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              fontFamily: 'monospace',
              fontSize: 10.5,
              color: 'var(--imp-text-secondary, #8b92a1)',
            }}
          >
            <span>
              CPU {perfSnap?.cpu_percent.toFixed(1) ?? '0.0'}% ·{' '}
              {perfSnap?.rss_mb.toFixed(1) ?? '0.0'} MB
            </span>
            <span>
              {perfSnap?.audio_backend || 'PipeWire'} · {perfSnap?.platform || 'Linux'}
            </span>
          </div>
        </div>
      </div>

      <FolderChooserModal
        open={folderChooserOpen}
        initialPath={customFolderPath}
        applyFocusMarker={applyFocusMarker}
        onSelectFolder={(folderPath) => {
          setCustomFolderPath(folderPath);
          setFolderChooserOpen(false);
          handleAddFolder(folderPath, { navigateAfterAdd: true });
        }}
        onClose={() => {
          setFolderChooserOpen(false);
          window.setTimeout(() => {
            const browseTrigger =
              document.querySelector<HTMLElement>(
                '[data-folder-browse-trigger="true"]:not([disabled])'
              ) ||
              document.querySelector<HTMLElement>(
                '[data-xmb-col="sub"] button:not([disabled])'
              );
            if (browseTrigger && applyFocusMarker) {
              applyFocusMarker(browseTrigger);
            }
          }, 30);
        }}
      />
    </div>
  );
};
