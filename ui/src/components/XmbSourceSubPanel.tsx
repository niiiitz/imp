import React, { useState } from 'react';
import {
  AppleMusicAuthConfig,
  defaultSimpClient,
  OpticalDiscStatus,
  SimpStateSnapshot,
  SoundCloudAuthConfig,
} from '@imp/client';
import { QrCodeSvg } from './QrCodeSvg';
import {
  authorizeAppleMusic,
  disconnectAppleMusicCleanSlate,
} from '../drivers/AppleMusicDriver';
import {
  disconnectSoundCloudCleanSlate,
  startSoundCloudOAuthLogin,
} from '../drivers/SoundCloudDriver';
import { AppleMusicLogo } from './AppleMusicLogo';
import { SoundCloudLogo } from './SoundCloudLogo';
import { OskTargetKind } from '../hooks/useGamepadNavigation';
import { ImpIcon } from './icons/ImpIcon';
import { resolveDaemonUrl } from '../api/servicesCacheApi';
import {
  type AudioDisplayBridgeState,
  dispatchAudioDisplayCommand,
  type NetworkedRetrievalPrefs,
  type SourceVisibilityPrefs,
  type XmbSourceSubPanelId,
} from '../menu/menuCorpus';

export interface XmbSourceSubPanelProps {
  activeSubPanel: XmbSourceSubPanelId;
  onCloseSubPanel: () => void;
  audioState: AudioDisplayBridgeState;
  networkedRetrieval: NetworkedRetrievalPrefs;
  onToggleNetworkedRetrieval: (key: keyof NetworkedRetrievalPrefs) => void;
  snap: SimpStateSnapshot | null;
  customFolderPath: string;
  setCustomFolderPath: React.Dispatch<React.SetStateAction<string>>;
  setOskTarget: React.Dispatch<React.SetStateAction<OskTargetKind>>;
  handleAddFolder: (folderPath: string, opts?: { navigateAfterAdd?: boolean }) => void;
  handleRemoveFolder: (mountRoot: string, label: string) => void;
  folderChooserOpen: boolean;
  setFolderChooserOpen: React.Dispatch<React.SetStateAction<boolean>>;
  sourceVisibility: SourceVisibilityPrefs;
  toggleSourceVisible: (key: keyof SourceVisibilityPrefs) => void;
  setSourceVisibility: React.Dispatch<React.SetStateAction<SourceVisibilityPrefs>>;
  appleAuthCfg: AppleMusicAuthConfig | null;
  setAppleAuthCfg: React.Dispatch<React.SetStateAction<AppleMusicAuthConfig | null>>;
  appleBusy: boolean;
  setAppleBusy: React.Dispatch<React.SetStateAction<boolean>>;
  soundcloudAuthCfg: SoundCloudAuthConfig | null;
  setSoundcloudAuthCfg: React.Dispatch<React.SetStateAction<SoundCloudAuthConfig | null>>;
  soundcloudBusy: boolean;
  setSoundcloudBusy: React.Dispatch<React.SetStateAction<boolean>>;
  iaUsername: string;
  savedIaUsername: string;
  setIaUsername: React.Dispatch<React.SetStateAction<string>>;
  onCommitIaUsername: (raw: string) => void;
  iaSafeSearch: boolean;
  setIaSafeSearch: React.Dispatch<React.SetStateAction<boolean>>;
  iaEnabledLocal: boolean;
  setIaEnabledLocal: React.Dispatch<React.SetStateAction<boolean>>;
  opticalDisc: OpticalDiscStatus | null;
  cdScanning: boolean;
  handleScanOpticalDisc: (forceRefresh?: boolean, silent?: boolean) => Promise<void>;
  handleEjectOpticalDisc: () => void;
  confirmHardReset: boolean;
  setConfirmHardReset: React.Dispatch<React.SetStateAction<boolean>>;
  onResetLibraryDb: () => void;
  onExecuteHardReset: () => void;
  refreshLibraryData: () => void;
  showToast: (msg: string) => void;
}

function subToggleStyle(active: boolean, accent: string): React.CSSProperties {
  return {
    minHeight: 30,
    padding: '0 10px',
    borderRadius: 6,
    background: active ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))' : '#21252f',
    border: active ? `1px solid ${accent}` : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
    color: active ? accent : 'var(--imp-text-secondary, #8b92a1)',
    fontSize: 11,
    fontWeight: 800,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 5,
    whiteSpace: 'nowrap',
  };
}

const subBtnStyle: React.CSSProperties = {
  minHeight: 32,
  padding: '0 11px',
  borderRadius: 6,
  background: 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
  border: '1px solid var(--imp-focus-ring, #e8b86d)',
  color: 'var(--imp-accent-active-text, #f5e1be)',
  fontSize: 11.5,
  fontWeight: 800,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  whiteSpace: 'nowrap',
};

const subDangerBtnStyle: React.CSSProperties = {
  minHeight: 30,
  padding: '0 10px',
  borderRadius: 6,
  background: '#221115',
  border: '1px solid #5c222d',
  color: '#fca5a5',
  fontSize: 11,
  fontWeight: 700,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 5,
  whiteSpace: 'nowrap',
};

const subInputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 120,
  minHeight: 32,
  padding: '0 9px',
  borderRadius: 6,
  background: 'var(--imp-bg-canvas, #121418)',
  border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
  color: 'var(--imp-text-primary, #eef0f4)',
  fontSize: 11.5,
  fontFamily: 'monospace',
};

const optionRowBtnStyle = (active?: boolean): React.CSSProperties => ({
  width: '100%',
  minHeight: 36,
  padding: '6px 10px',
  borderRadius: 6,
  background: active
    ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))'
    : 'var(--imp-surface-card, #1a1d24)',
  border: active
    ? '1px solid var(--imp-accent-active-border, rgba(232, 184, 109, 0.52))'
    : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
  color: 'var(--imp-text-primary, #eef0f4)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 10,
  fontSize: 12,
  fontWeight: 700,
  cursor: 'pointer',
  textAlign: 'left',
});

const sectionCardStyle: React.CSSProperties = {
  padding: 10,
  borderRadius: 7,
  background: 'var(--imp-surface-card, #1a1d24)',
  border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const accountDividerStyle: React.CSSProperties = {
  padding: '10px 0',
  borderBottom: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'flex-end',
  gap: 8,
};

const PANEL_TITLES: Record<XmbSourceSubPanelId, string> = {
  visualizer_options: 'Visualizer Options',
  accounts: 'Accounts',
  folders: 'Folders',
  optical_drive: 'Optical Drive',
  networked_retrieval: 'Networked Retrieval',
  database_reset: 'Database & Reset',
};

export const XmbSourceSubPanel: React.FC<XmbSourceSubPanelProps> = ({
  activeSubPanel,
  onCloseSubPanel,
  audioState,
  networkedRetrieval,
  onToggleNetworkedRetrieval,
  snap,
  customFolderPath,
  setCustomFolderPath,
  setOskTarget,
  handleAddFolder,
  handleRemoveFolder,
  folderChooserOpen,
  setFolderChooserOpen,
  sourceVisibility,
  toggleSourceVisible,
  setSourceVisibility,
  appleAuthCfg,
  setAppleAuthCfg,
  appleBusy,
  setAppleBusy,
  soundcloudAuthCfg,
  setSoundcloudAuthCfg,
  soundcloudBusy,
  setSoundcloudBusy,
  iaUsername,
  savedIaUsername,
  setIaUsername,
  onCommitIaUsername,
  iaSafeSearch,
  setIaSafeSearch,
  iaEnabledLocal,
  setIaEnabledLocal,
  opticalDisc,
  cdScanning,
  handleScanOpticalDisc,
  handleEjectOpticalDisc,
  confirmHardReset,
  setConfirmHardReset,
  onResetLibraryDb,
  onExecuteHardReset,
  refreshLibraryData,
  showToast,
}) => {
  const [addPathOpen, setAddPathOpen] = useState(false);
  const [confirmPurgeSource, setConfirmPurgeSource] = useState<string | null>(null);

  const handlePurgeSource = async (
    source: 'local' | 'apple' | 'soundcloud' | 'ia',
    label: string
  ) => {
    if (confirmPurgeSource !== source) {
      setConfirmPurgeSource(source);
      showToast(`Confirm Purge ${label} DB`);
      return;
    }
    setConfirmPurgeSource(null);
    try {
      const resp = await fetch(resolveDaemonUrl('/api/library/purge-source'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source }),
      });
      const json = await resp.json();
      if (json?.ok) {
        showToast(`Purged ${label} DB (${json.removed || 0} items)`);
        window.dispatchEvent(new CustomEvent('simp-source-purged', { detail: { source } }));
        refreshLibraryData();
      } else {
        showToast(`Failed to purge ${label} DB`);
      }
    } catch {
      showToast(`Failed to purge ${label} DB`);
    }
  };

  const isSoundCloudSignedIn =
    soundcloudAuthCfg?.auth_mode === 'user' &&
    Boolean(
      soundcloudAuthCfg?.username &&
        soundcloudAuthCfg.username !== 'Public Discovery (Client Credentials)'
    );

  const normalizedIaDraft = iaUsername.trim().replace(/^@+/, '');
  const normalizedIaSaved = savedIaUsername.trim().replace(/^@+/, '');
  const isIaHandleValid =
    normalizedIaDraft.length === 0 || /^[a-zA-Z0-9._-]{2,64}$/.test(normalizedIaDraft);
  const isIaHandleDirty = normalizedIaDraft !== normalizedIaSaved;

  const vizOptionRows: Array<{
    id: string;
    label: string;
    subtext?: string;
    value: string;
    active: boolean;
    onClick: () => void;
    isDefaultFocus?: boolean;
  }> = [
    {
      id: 'fps_cap',
      label: 'Frame Rate',
      value: audioState.vizFpsLabel,
      active: audioState.vizFpsCap === 0,
      onClick: () => dispatchAudioDisplayCommand({ type: 'cycle_fps_cap' }),
      isDefaultFocus: true,
    },
    {
      id: 'pause_unfocused',
      label: 'Pause While Unfocused',
      value: audioState.vizPauseUnfocused ? 'On' : 'Off',
      active: audioState.vizPauseUnfocused,
      onClick: () => dispatchAudioDisplayCommand({ type: 'toggle_pause_unfocused' }),
    },
    {
      id: 'lyrics_viz',
      label: 'Embed Lyrics',
      value: audioState.lyricsVizEnabled ? 'On' : 'Off',
      active: audioState.lyricsVizEnabled,
      onClick: () => dispatchAudioDisplayCommand({ type: 'toggle_lyrics_viz' }),
    },
    {
      id: 'lyrics_karaoke',
      label: 'Karaoke Style Lyrics',
      value: audioState.lyricsKaraokeEnabled ? 'On' : 'Off',
      active: audioState.lyricsKaraokeEnabled,
      onClick: () => dispatchAudioDisplayCommand({ type: 'toggle_lyrics_karaoke' }),
    },
    {
      id: 'factoids',
      label: 'Factoids',
      subtext: 'Show lore overlays (stops polling when Off)',
      value: audioState.factoidsEnabled ? 'On' : 'Off',
      active: audioState.factoidsEnabled,
      onClick: () => dispatchAudioDisplayCommand({ type: 'toggle_factoids' }),
    },
    {
      id: 'sc_comments',
      label: 'SoundCloud Comments',
      subtext: 'Show timed comment bubbles (stops polling when Off)',
      value: audioState.scCommentsEnabled ? 'On' : 'Off',
      active: audioState.scCommentsEnabled,
      onClick: () => dispatchAudioDisplayCommand({ type: 'toggle_sc_comments' }),
    },
  ];

  const networkedRetrievalRows: Array<{
    key: keyof NetworkedRetrievalPrefs;
    label: string;
    subtext: string;
    isDefaultFocus?: boolean;
  }> = [
    {
      key: 'lyrics',
      label: 'Lyrics',
      subtext: 'LRCLIB synced & plain lyrics (.lrc & cached DB still load)',
      isDefaultFocus: true,
    },
    {
      key: 'artwork',
      label: 'Artwork',
      subtext: 'MusicBrainz & Cover Art Archive (cached/embedded still load)',
    },
    {
      key: 'factoids',
      label: 'Factoids',
      subtext: 'Wikipedia & MusicBrainz lore (previously cached still load)',
    },
    {
      key: 'discMetadata',
      label: 'Album/DVD Track Data',
      subtext: 'Online Audio CD TOC & DVD catalog lookups',
    },
    {
      key: 'scComments',
      label: 'SoundCloud Comments',
      subtext: 'Timed comment retrieval on SoundCloud tracks',
    },
  ];

  return (
    <div
      data-xmb-col="sub"
      style={{
        width:
          activeSubPanel === 'accounts'
            ? 'min(300px, calc(100vw / var(--imp-ui-scale, 1) - 32px))'
            : 'min(400px, calc(100vw / var(--imp-ui-scale, 1) - 32px))',
        maxHeight: 'calc(100vh / var(--imp-ui-scale, 1) - 72px)',
        overflowY: 'auto',
        flexShrink: 1,
        minWidth: 0,
        background: 'var(--imp-surface-panel, #161920)',
        border: '1px solid var(--imp-border-strong, rgba(255, 255, 255, 0.16))',
        borderRadius: 8,
        padding: 14,
        boxSizing: 'border-box',
        boxShadow: '0 20px 52px rgba(0, 0, 0, 0.72)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingBottom: 8,
          borderBottom: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
        }}
      >
        <strong style={{ fontSize: 13, color: 'var(--imp-accent-active-text, #f5e1be)' }}>
          {PANEL_TITLES[activeSubPanel]}
        </strong>
        <button
          type="button"
          onClick={onCloseSubPanel}
          style={{
            minHeight: 28,
            padding: '0 9px',
            borderRadius: 6,
            background: 'var(--imp-surface-card, #1a1d24)',
            border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
            color: 'var(--imp-text-primary, #eef0f4)',
            fontFamily: 'monospace',
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Back →
        </button>
      </div>

      {/* 1. Visualizer Options */}
      {activeSubPanel === 'visualizer_options' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {vizOptionRows.map((row) => (
            <button
              key={row.id}
              type="button"
              data-sub-default={row.isDefaultFocus ? 'true' : undefined}
              onClick={row.onClick}
              style={optionRowBtnStyle(row.active)}
            >
              <div style={{ minWidth: 0 }}>
                <div>{row.label}</div>
                {row.subtext && (
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      color: 'var(--imp-text-muted, #646b7a)',
                      marginTop: 1,
                    }}
                  >
                    {row.subtext}
                  </div>
                )}
              </div>
              <span
                style={{
                  fontFamily: 'monospace',
                  fontSize: 11,
                  fontWeight: 700,
                  flexShrink: 0,
                  color: row.active
                    ? 'var(--imp-accent-active-text, #f5e1be)'
                    : 'var(--imp-text-secondary, #8b92a1)',
                }}
              >
                {row.value}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* 2. Consolidated Accounts (Right-Aligned Spacious Rows) */}
      {activeSubPanel === 'accounts' && (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Apple Music */}
          <div style={{ ...accountDividerStyle, paddingTop: 2 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 800, color: '#fda4af' }}>
              <AppleMusicLogo size={14} />
              <span>Apple Music</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
              {!snap?.apple_authenticated ? (
                <button
                  type="button"
                  data-sub-default="true"
                  disabled={appleBusy}
                  onClick={async () => {
                    setAppleBusy(true);
                    try {
                      await authorizeAppleMusic(showToast);
                      const updated = await defaultSimpClient.getAppleMusicAuthConfig();
                      setAppleAuthCfg(updated);
                      refreshLibraryData();
                    } catch (err: any) {
                      showToast(err?.message || 'Apple Music auth failed');
                    } finally {
                      setAppleBusy(false);
                    }
                  }}
                  style={{
                    ...subBtnStyle,
                    background: '#31101b',
                    borderColor: '#f43f5e',
                    color: '#fda4af',
                  }}
                >
                  {appleBusy ? 'Working...' : 'Sign In'}
                </button>
              ) : (
                <button
                  type="button"
                  data-sub-default="true"
                  onClick={async () => {
                    await disconnectAppleMusicCleanSlate(showToast);
                    const updated = await defaultSimpClient
                      .getAppleMusicAuthConfig()
                      .catch(() => null);
                    if (updated) setAppleAuthCfg(updated);
                  }}
                  style={subDangerBtnStyle}
                >
                  <ImpIcon name="sign-out" size={11} />
                  <span>Sign Out</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => toggleSourceVisible('apple_music')}
                style={subToggleStyle(sourceVisibility.apple_music, '#f43f5e')}
              >
                <ImpIcon name={sourceVisibility.apple_music ? 'eye' : 'eye-off'} size={11} />
                <span>{sourceVisibility.apple_music ? 'Shown' : 'Hidden'}</span>
              </button>
            </div>

            {!snap?.apple_authenticated && appleAuthCfg?.pair_url && (
              <div
                style={{
                  width: '100%',
                  boxSizing: 'border-box',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: 8,
                  borderRadius: 6,
                  background: 'var(--imp-bg-canvas, #121418)',
                  border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                }}
              >
                <QrCodeSvg value={appleAuthCfg.pair_url} size={62} />
                <div style={{ minWidth: 0, flex: 1, fontSize: 10, color: 'var(--imp-text-secondary, #8b92a1)' }}>
                  <div style={{ fontWeight: 800, color: '#fda4af', marginBottom: 2 }}>
                    Companion Pairing QR
                  </div>
                  <div
                    style={{
                      fontFamily: 'monospace',
                      color: 'var(--imp-accent-active-text, #f5e1be)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      wordBreak: 'break-all',
                    }}
                  >
                    {appleAuthCfg.pair_url}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* SoundCloud */}
          <div style={accountDividerStyle}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', fontSize: 12.5, fontWeight: 800, color: '#fdba74' }}>
              <SoundCloudLogo width={24} color="#ffffff" />
              <span>SoundCloud</span>
              {isSoundCloudSignedIn && soundcloudAuthCfg?.username && (
                <span
                  style={{
                    fontSize: 11,
                    fontFamily: 'monospace',
                    color: 'var(--imp-text-secondary, #8b92a1)',
                    maxWidth: 145,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  @{soundcloudAuthCfg.username}
                </span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
              {isSoundCloudSignedIn ? (
                <button
                  type="button"
                  onClick={async () => {
                    await disconnectSoundCloudCleanSlate(showToast);
                    const updated = await defaultSimpClient
                      .getSoundCloudAuthConfig()
                      .catch(() => null);
                    if (updated) setSoundcloudAuthCfg(updated);
                    refreshLibraryData();
                  }}
                  style={subDangerBtnStyle}
                >
                  <ImpIcon name="sign-out" size={11} />
                  <span>Sign Out</span>
                </button>
              ) : (
                <button
                  type="button"
                  disabled={soundcloudBusy}
                  onClick={async () => {
                    setSoundcloudBusy(true);
                    try {
                      await startSoundCloudOAuthLogin(showToast);
                      const updated = await defaultSimpClient.getSoundCloudAuthConfig();
                      setSoundcloudAuthCfg(updated);
                      refreshLibraryData();
                    } catch (err: any) {
                      showToast(err?.message || 'SoundCloud OAuth failed');
                    } finally {
                      setSoundcloudBusy(false);
                    }
                  }}
                  style={{
                    ...subBtnStyle,
                    background: '#2c140a',
                    borderColor: '#ea580c',
                    color: '#fdba74',
                  }}
                >
                  {soundcloudBusy ? 'Working...' : 'Sign In'}
                </button>
              )}
              <button
                type="button"
                onClick={() => toggleSourceVisible('soundcloud')}
                style={subToggleStyle(sourceVisibility.soundcloud, '#ea580c')}
              >
                <ImpIcon name={sourceVisibility.soundcloud ? 'eye' : 'eye-off'} size={11} />
                <span>{sourceVisibility.soundcloud ? 'Shown' : 'Hidden'}</span>
              </button>
            </div>
          </div>

          {/* Internet Archive */}
          <div style={{ ...accountDividerStyle, borderBottom: 'none', paddingBottom: 2 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, fontWeight: 800, color: '#6ee7b7' }}>
              <ImpIcon name="archive" size={13} color="#6ee7b7" />
              <span>Internet Archive</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6 }}>
              <button
                type="button"
                onClick={() => {
                  const nextSafe = !iaSafeSearch;
                  setIaSafeSearch(nextSafe);
                  defaultSimpClient.configureInternetArchive({
                    enabled: sourceVisibility.internet_archive || iaEnabledLocal,
                    username: iaUsername.trim(),
                    safe_search: nextSafe,
                  });
                  showToast(nextSafe ? 'Safe Search: On' : 'Safe Search: Off');
                  refreshLibraryData();
                }}
                style={subToggleStyle(iaSafeSearch, '#34d399')}
              >
                <ImpIcon name="shield" size={11} />
                <span>Safer Search: {iaSafeSearch ? 'On' : 'Off'}</span>
              </button>
              <button
                type="button"
                onClick={() => toggleSourceVisible('internet_archive')}
                style={subToggleStyle(sourceVisibility.internet_archive, '#34d399')}
              >
                <ImpIcon name={sourceVisibility.internet_archive ? 'eye' : 'eye-off'} size={11} />
                <span>{sourceVisibility.internet_archive ? 'Shown' : 'Hidden'}</span>
              </button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, width: '100%' }}>
              <input
                type="text"
                placeholder="Archive.org @username"
                value={iaUsername}
                onChange={(e) => setIaUsername(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && isIaHandleDirty && isIaHandleValid) {
                    e.preventDefault();
                    onCommitIaUsername(iaUsername);
                    e.currentTarget.blur();
                  }
                }}
                onBlur={() => {
                  if (isIaHandleDirty && isIaHandleValid) {
                    onCommitIaUsername(iaUsername);
                  }
                }}
                style={{
                  ...subInputStyle,
                  flex: '0 1 210px',
                  width: 210,
                  maxWidth: '100%',
                  minWidth: 140,
                  borderColor: !isIaHandleValid
                    ? '#7f1d1d'
                    : !isIaHandleDirty && normalizedIaSaved
                      ? 'rgba(52, 211, 153, 0.45)'
                      : undefined,
                }}
              />
              {isIaHandleDirty && isIaHandleValid && (
                <button
                  type="button"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onCommitIaUsername(iaUsername)}
                  style={subBtnStyle}
                >
                  Save
                </button>
              )}
            </div>
            {!isIaHandleValid && (
              <div style={{ fontSize: 10, color: '#fca5a5', textAlign: 'right' }}>
                Use @username (letters, numbers, ., _, -)
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. Folders */}
      {activeSubPanel === 'folders' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              data-sub-default="true"
              data-folder-browse-trigger="true"
              onClick={() => setFolderChooserOpen(true)}
              style={subToggleStyle(folderChooserOpen, '#34d399')}
            >
              <ImpIcon name="folder-plus" size={12} />
              <span>Browse...</span>
            </button>
            <button
              type="button"
              onClick={() => setAddPathOpen((v) => !v)}
              style={subToggleStyle(addPathOpen, 'var(--imp-focus-ring, #e8b86d)')}
            >
              + Add Path
            </button>
            <button
              type="button"
              onClick={() => {
                defaultSimpClient.rescanStorage();
                showToast('Rescanning local folders...');
              }}
              style={subToggleStyle(false, 'var(--imp-accent-active-text, #f5e1be)')}
            >
              <ImpIcon name="refresh" size={11} />
              <span>Rescan All</span>
            </button>
          </div>

          {addPathOpen && (
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                type="text"
                data-osk-input="folder"
                placeholder="/path/to/media"
                value={customFolderPath}
                onChange={(e) => setCustomFolderPath(e.target.value)}
                onClick={(e) => {
                  if (
                    e.detail === 0 ||
                    document.documentElement.dataset.simpInput === 'gamepad'
                  ) {
                    setOskTarget('folder');
                    if (window.parent && window.parent !== window) {
                      window.parent.postMessage({ type: 'SIMP_OPEN_OSK' }, '*');
                    }
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    handleAddFolder(customFolderPath, { navigateAfterAdd: true });
                  }
                }}
                style={subInputStyle}
              />
              <button
                type="button"
                onClick={() => handleAddFolder(customFolderPath, { navigateAfterAdd: true })}
                style={subBtnStyle}
              >
                Add
              </button>
            </div>
          )}

          {snap?.mounts && snap.mounts.length > 0 ? (
            <div
              style={{
                maxHeight: 240,
                overflowY: 'auto',
                display: 'flex',
                flexDirection: 'column',
                gap: 5,
              }}
            >
              {snap.mounts.map((m) => (
                <div
                  key={m.mount_root}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 8px',
                    borderRadius: 6,
                    background: 'var(--imp-surface-card, #1a1d24)',
                    border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                    fontSize: 11,
                  }}
                >
                  <span
                    title={m.mount_root}
                    style={{
                      fontFamily: 'monospace',
                      color: m.is_online ? 'var(--imp-text-primary, #eef0f4)' : '#71717a',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    {m.mount_root} ({m.track_count})
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      defaultSimpClient.addLibraryPath(m.mount_root);
                      showToast(`Rescanning folder: ${m.label}`);
                    }}
                    style={subToggleStyle(false, 'var(--imp-focus-ring, #e8b86d)')}
                    title={`Rescan ${m.mount_root}`}
                  >
                    Rescan
                  </button>
                  <button
                    type="button"
                    onClick={() => handleRemoveFolder(m.mount_root, m.label)}
                    style={subDangerBtnStyle}
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--imp-text-secondary, #8b92a1)' }}>
              No local folders added
            </div>
          )}
        </div>
      )}

      {/* 4. Optical Drive */}
      {activeSubPanel === 'optical_drive' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              data-sub-default="true"
              onClick={() => toggleSourceVisible('optical_drive')}
              style={subToggleStyle(sourceVisibility.optical_drive, '#f59e0b')}
            >
              <ImpIcon name={sourceVisibility.optical_drive ? 'eye' : 'eye-off'} size={11} />
              <span>{sourceVisibility.optical_drive ? 'Shown' : 'Hidden'}</span>
            </button>
            {sourceVisibility.optical_drive && (
              <>
                <button
                  type="button"
                  disabled={cdScanning}
                  onClick={() => handleScanOpticalDisc(true, false)}
                  style={subToggleStyle(false, '#fcd34d')}
                >
                  <ImpIcon name="refresh" size={11} />
                  <span>{cdScanning ? 'Scanning...' : 'Scan'}</span>
                </button>
                {opticalDisc?.drive_present && (
                  <button
                    type="button"
                    onClick={handleEjectOpticalDisc}
                    style={subDangerBtnStyle}
                  >
                    <ImpIcon name="eject" size={11} />
                    <span>Eject</span>
                  </button>
                )}
              </>
            )}
          </div>
          {opticalDisc?.disc_present && (
            <div style={{ fontSize: 11, color: '#fcd34d', fontFamily: 'monospace' }}>
              {opticalDisc.album_title || (opticalDisc.is_dvd_video ? 'DVD Video Disc' : 'Audio CD')}
            </div>
          )}
        </div>
      )}

      {/* 5. Networked Retrieval (Privacy Controls) */}
      {activeSubPanel === 'networked_retrieval' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {networkedRetrievalRows.map((row) => {
            const enabled = networkedRetrieval[row.key];
            return (
              <button
                key={row.key}
                type="button"
                data-sub-default={row.isDefaultFocus ? 'true' : undefined}
                onClick={() => onToggleNetworkedRetrieval(row.key)}
                style={optionRowBtnStyle(enabled)}
              >
                <div style={{ minWidth: 0 }}>
                  <div>{row.label}</div>
                  <div
                    style={{
                      fontSize: 10,
                      fontWeight: 500,
                      color: 'var(--imp-text-muted, #646b7a)',
                      marginTop: 1,
                    }}
                  >
                    {row.subtext}
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 11,
                    fontWeight: 700,
                    flexShrink: 0,
                    color: enabled
                      ? 'var(--imp-accent-active-text, #f5e1be)'
                      : 'var(--imp-text-secondary, #8b92a1)',
                  }}
                >
                  {enabled ? 'On' : 'Off'}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {/* 6. Consolidated Database & Reset Maintenance */}
      {activeSubPanel === 'database_reset' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button
            type="button"
            data-sub-default="true"
            onClick={onResetLibraryDb}
            style={optionRowBtnStyle(false)}
          >
            <span>Reset Library DB (Re-index Folders)</span>
            <ImpIcon name="refresh" size={12} color="#8b92a1" />
          </button>

          <div style={sectionCardStyle}>
            <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--imp-text-secondary, #8b92a1)' }}>
              Purge Per-Source Caches
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              {(
                [
                  { id: 'local', label: 'Local DB' },
                  { id: 'apple', label: 'Apple Music DB' },
                  { id: 'soundcloud', label: 'SoundCloud DB' },
                  { id: 'ia', label: 'Archive DB' },
                ] as const
              ).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => handlePurgeSource(entry.id, entry.label.replace(' DB', ''))}
                  style={{ ...subDangerBtnStyle, justifyContent: 'center' }}
                >
                  <ImpIcon name="database" size={11} />
                  <span>
                    {confirmPurgeSource === entry.id
                      ? 'Confirm Purge'
                      : `Purge ${entry.label}`}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={() => setConfirmHardReset((v) => !v)}
            style={{
              width: '100%',
              minHeight: 36,
              padding: '0 10px',
              borderRadius: 6,
              background: '#221115',
              border: '1px solid #5c222d',
              color: '#fca5a5',
              fontSize: 12,
              fontWeight: 800,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <span>{confirmHardReset ? 'Cancel Hard Reset' : 'Hard Reset Imp...'}</span>
            <ImpIcon name="ban" size={12} color="#fca5a5" />
          </button>

          {confirmHardReset && (
            <div
              style={{
                padding: 8,
                borderRadius: 6,
                background: '#2a0e13',
                border: '1px solid #ef4444',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 700, color: '#fecaca' }}>
                Wipe auth, playlists &amp; settings?
              </span>
              <button
                type="button"
                onClick={onExecuteHardReset}
                style={{
                  minHeight: 28,
                  padding: '0 10px',
                  borderRadius: 6,
                  background: '#dc2626',
                  border: '1px solid #f87171',
                  color: '#fff',
                  fontSize: 11,
                  fontWeight: 800,
                  cursor: 'pointer',
                }}
              >
                Confirm
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
