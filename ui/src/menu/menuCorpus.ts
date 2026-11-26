import {
  formatVisualizerFpsCapLabel,
  type VisualizerFpsCap,
} from '../components/visualizers/sceneRegistry';
import { loadStatsHudEnabled } from '../components/StatsHudPill';
import { formatUiScaleLabel, type UiScalePreset } from '../theme/uiScale';

export interface SimpUpdateStatus {
  current_version?: string;
  latest_version?: string;
  latest_tag?: string;
  update_available?: boolean;
  channel_switch_available?: boolean;
  target_arch?: string;
  channel?: string;
  checking?: boolean;
  applying?: boolean;
  error?: string;
}

export interface SourceVisibilityPrefs {
  internet_archive: boolean;
  apple_music: boolean;
  soundcloud: boolean;
  optical_drive: boolean;
}

export interface NetworkedRetrievalPrefs {
  lyrics: boolean;
  artwork: boolean;
  factoids: boolean;
  discMetadata: boolean;
  scComments: boolean;
}

export const DEFAULT_NETWORKED_RETRIEVAL_PREFS: NetworkedRetrievalPrefs = {
  lyrics: true,
  artwork: true,
  factoids: true,
  discMetadata: true,
  scComments: true,
};

export type GamepadFocusPolicy = 'focused_only' | 'always' | 'off';

const GAMEPAD_POLICY_STORAGE_KEY = 'imp_gamepad_focus_policy_v1';

export function loadGamepadFocusPolicy(): GamepadFocusPolicy {
  try {
    const raw = window.localStorage.getItem(GAMEPAD_POLICY_STORAGE_KEY);
    if (raw === 'always' || raw === 'off' || raw === 'focused_only') {
      return raw;
    }
  } catch {
    // ignore storage errors
  }
  return 'focused_only';
}

export function saveGamepadFocusPolicy(policy: GamepadFocusPolicy): void {
  try {
    window.localStorage.setItem(GAMEPAD_POLICY_STORAGE_KEY, policy);
  } catch {
    // ignore storage errors
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('imp-gamepad-policy-change', { detail: { policy } }));
  }
}

export function cycleGamepadFocusPolicy(current: GamepadFocusPolicy): GamepadFocusPolicy {
  if (current === 'focused_only') return 'always';
  if (current === 'always') return 'off';
  return 'focused_only';
}

export function formatGamepadFocusPolicyLabel(policy: GamepadFocusPolicy): string {
  if (policy === 'always') return 'Always';
  if (policy === 'off') return 'Off';
  return 'Focused Only';
}

const IDLE_TIMER_PRESETS_SEC = [0, 15, 30, 60, 180] as const;

export function formatIdleTimerLabel(sec: number): string {
  if (!sec || sec <= 0) return 'Off';
  if (sec < 60) return `${sec}s`;
  const mins = Math.round(sec / 60);
  return `${mins}m`;
}

export function cycleIdleTimerSec(current: number): number {
  const idx = IDLE_TIMER_PRESETS_SEC.indexOf(
    current as (typeof IDLE_TIMER_PRESETS_SEC)[number]
  );
  if (idx === -1) return 30;
  return IDLE_TIMER_PRESETS_SEC[(idx + 1) % IDLE_TIMER_PRESETS_SEC.length];
}

export type XmbColumnId = 'display' | 'audio_sources' | 'system_network';

export type XmbSourceSubPanelId =
  | 'visualizer_options'
  | 'accounts'
  | 'folders'
  | 'optical_drive'
  | 'networked_retrieval'
  | 'database_reset';

export interface AudioDisplayBridgeState {
  dspEnabled: boolean;
  vocalMode: string;
  vizModeLabel: string;
  vizFpsCap: VisualizerFpsCap;
  vizFpsLabel: string;
  vizPauseUnfocused: boolean;
  idleFadeEnabled: boolean;
  idleOpacityPct: number;
  lyricsKaraokeEnabled: boolean;
  lyricsVizEnabled: boolean;
  factoidsEnabled: boolean;
  scCommentsEnabled: boolean;
  isVideoTrack: boolean;
  videoTheatreExpanded: boolean;
  videoQualityLabel: string;
  videoQualitiesCount: number;
  videoSubtitleLabel: string;
  videoSubtitlesCount: number;
}

export const DEFAULT_AUDIO_DISPLAY_BRIDGE_STATE: AudioDisplayBridgeState = {
  dspEnabled: false,
  vocalMode: 'off',
  vizModeLabel: 'Auto Cycle',
  vizFpsCap: 30,
  vizFpsLabel: formatVisualizerFpsCapLabel(30),
  vizPauseUnfocused: false,
  idleFadeEnabled: true,
  idleOpacityPct: 0,
  lyricsKaraokeEnabled: true,
  lyricsVizEnabled: true,
  factoidsEnabled: false,
  scCommentsEnabled: true,
  isVideoTrack: false,
  videoTheatreExpanded: false,
  videoQualityLabel: 'Auto',
  videoQualitiesCount: 0,
  videoSubtitleLabel: 'Off',
  videoSubtitlesCount: 0,
};

let latestAudioDisplayBridgeState: AudioDisplayBridgeState = {
  ...DEFAULT_AUDIO_DISPLAY_BRIDGE_STATE,
};

export function publishAudioDisplayState(next: AudioDisplayBridgeState): void {
  latestAudioDisplayBridgeState = next;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('imp-audio-display-state', { detail: next }));
  }
}

export function readAudioDisplayState(): AudioDisplayBridgeState {
  return latestAudioDisplayBridgeState;
}

export type AudioDisplayCommand =
  | { type: 'open_equalizer' }
  | { type: 'open_visualizer' }
  | { type: 'cycle_fps_cap' }
  | { type: 'toggle_pause_unfocused' }
  | { type: 'toggle_idle_fade' }
  | { type: 'set_idle_fade'; enabled: boolean }
  | { type: 'step_idle_opacity'; delta: number }
  | { type: 'toggle_lyrics_karaoke' }
  | { type: 'toggle_lyrics_viz' }
  | { type: 'toggle_factoids' }
  | { type: 'toggle_sc_comments' }
  | { type: 'toggle_theatre_fullscreen' }
  | { type: 'cycle_video_quality' }
  | { type: 'cycle_video_subtitles' };

export function dispatchAudioDisplayCommand(cmd: AudioDisplayCommand): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('imp-audio-display-cmd', { detail: cmd }));
  }
}

export type MenuItemKind = 'action' | 'toggle' | 'cycle' | 'submenu' | 'slider' | 'separator';

export interface MenuItemDescriptor {
  id: string;
  label: string;
  value?: string;
  kind: MenuItemKind;
  active?: boolean;
  attention?: boolean;
  danger?: boolean;
  hidden?: boolean;
  subPanelId?: XmbSourceSubPanelId;
}

export interface MenuColumnDescriptor {
  id: XmbColumnId;
  label: string;
  attention?: boolean;
  items: MenuItemDescriptor[];
}

export interface BuildMenuCorpusContext {
  audio: AudioDisplayBridgeState;
  isDeckyEmbedded: boolean;
  desktopMode: boolean;
  uiScalePreset: UiScalePreset;
  uiScaleEffective: number;
  idleTimerSec: number;
  statsHudEnabled: boolean;
  folderCount: number;
  sourceVisibility: SourceVisibilityPrefs;
  appleConnected: boolean;
  soundCloudUserLabel: string;
  expiredAuthProviders?: Array<'apple' | 'soundcloud'>;
  brightnessPct: number;
  gamepadPolicy: GamepadFocusPolicy;
  networkedRetrieval: NetworkedRetrievalPrefs;
  updateStatus: SimpUpdateStatus;
}

export function buildMenuCorpus(ctx: BuildMenuCorpusContext): MenuColumnDescriptor[] {
  const { audio } = ctx;
  const chLower = (ctx.updateStatus.channel || 'stable').toLowerCase();
  const updateLabel = ctx.updateStatus.applying
    ? 'Updating...'
    : ctx.updateStatus.checking
      ? 'Checking...'
      : ctx.updateStatus.update_available
        ? `Update (${ctx.updateStatus.latest_tag})`
        : ctx.updateStatus.channel_switch_available
          ? 'Switch to Stable'
          : 'Check for Updates...';

  const hasExpiredAuth = Boolean(
    ctx.expiredAuthProviders && ctx.expiredAuthProviders.length > 0
  );
  const activeAccountBadges = [
    ctx.sourceVisibility.apple_music ? (ctx.appleConnected ? 'Apple★' : 'Apple') : null,
    ctx.sourceVisibility.soundcloud ? 'SC' : null,
    ctx.sourceVisibility.internet_archive ? 'IA' : null,
  ].filter(Boolean);
  const accountsSummary = hasExpiredAuth
    ? 'Re-sign in'
    : activeAccountBadges.length > 0
      ? activeAccountBadges.join(' · ')
      : 'Hidden';

  const retrievalFlags = Object.values(ctx.networkedRetrieval);
  const retrievalEnabledCount = retrievalFlags.filter(Boolean).length;
  const retrievalSummary =
    retrievalEnabledCount === retrievalFlags.length
      ? 'All On'
      : retrievalEnabledCount === 0
        ? 'Off'
        : `${retrievalEnabledCount}/${retrievalFlags.length} On`;

  const displayItems: MenuItemDescriptor[] = [];

  if (audio.isVideoTrack) {
    displayItems.push(
      {
        id: 'theatre_fullscreen',
        label: 'Theatre Fullscreen',
        value: audio.videoTheatreExpanded ? 'On' : 'Off',
        kind: 'toggle',
        active: audio.videoTheatreExpanded,
      },
      {
        id: 'video_quality',
        label: 'Quality',
        value: audio.videoQualitiesCount > 0 ? audio.videoQualityLabel : 'Default',
        kind: 'cycle',
      },
      {
        id: 'video_subtitles',
        label: 'Subtitles',
        value: audio.videoSubtitleLabel,
        kind: 'cycle',
        active: audio.videoSubtitleLabel !== 'Off',
      },
      { id: 'sep_d0', label: '', kind: 'separator' }
    );
  }

  displayItems.push(
    {
      id: 'sleep_screen',
      label: 'Sleep Display',
      value: '0%',
      kind: 'action',
    },
    {
      id: 'brightness',
      label: 'Brightness',
      value: `${ctx.brightnessPct}%`,
      kind: 'slider',
    },
    {
      id: 'ui_scale',
      label: 'UI Scale',
      value: formatUiScaleLabel(ctx.uiScalePreset, ctx.uiScaleEffective),
      kind: 'cycle',
      active: ctx.uiScalePreset !== 'auto',
    },
    { id: 'sep_d1', label: '', kind: 'separator' },
    {
      id: 'idle_timer',
      label: 'Idle Timer',
      value: formatIdleTimerLabel(ctx.idleTimerSec),
      kind: 'cycle',
      active: ctx.idleTimerSec > 0,
    },
    {
      id: 'idle_opacity',
      label: 'Idle Opacity',
      value: `${audio.idleOpacityPct}%`,
      kind: 'slider',
    },
    { id: 'sep_d2', label: '', kind: 'separator' },
    {
      id: 'visualizer',
      label: 'Visualizers...',
      value: audio.vizModeLabel,
      kind: 'action',
      active: audio.vizModeLabel !== 'Off',
    },
    {
      id: 'viz_options',
      label: 'Visualizer Options...',
      value: audio.vizFpsLabel,
      kind: 'submenu',
      subPanelId: 'visualizer_options',
      active:
        audio.lyricsKaraokeEnabled ||
        audio.lyricsVizEnabled ||
        audio.factoidsEnabled ||
        audio.scCommentsEnabled,
    },
    {
      id: 'stats_hud',
      label: 'Stats HUD',
      value: ctx.statsHudEnabled ? 'On' : 'Off',
      kind: 'toggle',
      active: ctx.statsHudEnabled,
    }
  );

  const channelLabel =
    chLower === 'off' ? 'Off' : chLower === 'alpha' ? 'Alpha' : 'Stable';

  const systemItems: MenuItemDescriptor[] = [
    {
      id: 'desktop_mode',
      label: 'Desktop Mode',
      value: ctx.desktopMode ? 'On' : 'Off',
      kind: 'toggle',
      active: ctx.desktopMode,
      hidden: ctx.isDeckyEmbedded,
    },
    {
      id: 'gamepad_focus',
      label: 'Gamepad Focus',
      value: formatGamepadFocusPolicyLabel(ctx.gamepadPolicy),
      kind: 'cycle',
    },
    { id: 'sep_n1', label: '', kind: 'separator' },
    {
      id: 'networked_retrieval',
      label: 'Networked Retrieval...',
      value: retrievalSummary,
      kind: 'submenu',
      active: retrievalEnabledCount > 0,
      subPanelId: 'networked_retrieval',
    },
    {
      id: 'update_channel',
      label: 'Update Channel',
      value: channelLabel,
      kind: 'cycle',
      active: chLower !== 'off',
    },
    {
      id: 'check_updates',
      label: updateLabel,
      value: ctx.updateStatus.current_version ? `v${ctx.updateStatus.current_version}` : undefined,
      kind: 'action',
      active: Boolean(
        ctx.updateStatus.update_available || ctx.updateStatus.channel_switch_available
      ),
    },
    {
      id: 'db_reset',
      label: 'Database & Reset...',
      kind: 'submenu',
      subPanelId: 'database_reset',
    },
    {
      id: 'quick_help',
      label: 'Help...',
      kind: 'action',
    },
    { id: 'sep_n2', label: '', kind: 'separator' },
    {
      id: 'quit_imp',
      label: 'Quit Imp',
      kind: 'action',
      danger: true,
    },
  ];

  return [
    {
      id: 'display',
      label: 'Display',
      items: displayItems.filter((item) => !item.hidden),
    },
    {
      id: 'audio_sources',
      label: 'Audio & Sources',
      attention: hasExpiredAuth,
      items: [
        {
          id: 'equalizer',
          label: 'Equalizer...',
          value: audio.dspEnabled ? 'On' : 'Off',
          kind: 'action',
          active: audio.dspEnabled,
        },
        { id: 'sep_s0', label: '', kind: 'separator' },
        {
          id: 'src_accounts',
          label: 'Accounts...',
          value: accountsSummary,
          kind: 'submenu',
          active: activeAccountBadges.length > 0,
          attention: hasExpiredAuth,
          subPanelId: 'accounts',
        },
        {
          id: 'src_folders',
          label: 'Folders...',
          value: String(ctx.folderCount),
          kind: 'submenu',
          subPanelId: 'folders',
        },
        {
          id: 'src_optical',
          label: 'Optical Drive...',
          value: ctx.sourceVisibility.optical_drive ? 'Shown' : 'Hidden',
          kind: 'submenu',
          active: ctx.sourceVisibility.optical_drive,
          subPanelId: 'optical_drive',
        },
      ],
    },
    {
      id: 'system_network',
      label: 'System & Network',
      items: systemItems.filter((item) => !item.hidden),
    },
  ];
}

export function getInitialStatsHudEnabled(): boolean {
  return loadStatsHudEnabled();
}
