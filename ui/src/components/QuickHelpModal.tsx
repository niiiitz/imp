import React, { useState } from 'react';
import type { SourceVisibilityPrefs } from '../menu/menuCorpus';
import { AppleMusicLogo } from './AppleMusicLogo';
import { SoundCloudLogo } from './SoundCloudLogo';
import { ImpIcon } from './icons/ImpIcon';

export interface QuickHelpModalProps {
  onClose: () => void;
  onOpenFoldersAccounts: () => void;
  sourceVisibility: SourceVisibilityPrefs;
  onToggleSourceVisibility: (key: keyof SourceVisibilityPrefs) => void;
}

type HelpTabId = 'overview' | 'shortcuts' | 'audio_display' | 'library_sources';

const HELP_TABS: Array<{ id: HelpTabId; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'shortcuts', label: 'Shortcuts' },
  { id: 'audio_display', label: 'Audio & Display' },
  { id: 'library_sources', label: 'Library & Sources' },
];

const KEYBOARD_ROWS: Array<[string, string]> = [
  ['P / F1 / F2 / F10', 'Open START menu (Audio, Sources, System)'],
  ['Tab / Right-Click', 'Open SELECT context menu for focused item'],
  ['Space / K', 'Play or Pause'],
  ['N / >', 'Next track'],
  ['B / <', 'Previous track (or Back inside modals)'],
  ['J / -   and   L / =', 'Seek backward 10s / forward 10s'],
  ['M', 'Mute or restore volume'],
  ['1 / [   and   2 / ]', 'Switch Player / Library views'],
  ['/   or   Ctrl+F', 'Focus library search bar'],
  ['Y / X / R', 'Filters / Collapse section / Cycle repeat'],
  ['F / F11 / Alt+Enter', 'Toggle Fullscreen / Video Theatre'],
  ['Esc / Backspace', 'Back or close active menu'],
];

const GAMEPAD_ROWS: Array<[string, string]> = [
  ['START', 'Open 3-column menu (Left/Right columns, Up/Down items)'],
  ['SELECT', 'Context menu for focused track, collection, or folder'],
  ['L1 / R1', 'Switch between Player and Library views'],
  ['A / B', 'Activate / Step back or close'],
  ['X', 'Collapse/expand section (or cycle repeat in modals)'],
  ['Y', 'Open Library Filters (or Repeat in Player)'],
  ['L2 / R2', 'Seek −10s / +10s'],
  ['D-Pad Up / Down', 'Volume ±5% on Player view, spatial focus elsewhere'],
];

export const QuickHelpModal: React.FC<QuickHelpModalProps> = ({
  onClose,
  onOpenFoldersAccounts,
  sourceVisibility,
  onToggleSourceVisibility,
}) => {
  const [activeTab, setActiveTab] = useState<HelpTabId>('overview');

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.78)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        boxSizing: 'border-box',
        zIndex: 92,
      }}
    >
      <div
        data-modal-root="true"
        data-quick-help-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 680,
          maxHeight: '88vh',
          overflow: 'hidden',
          background: 'var(--imp-surface-panel, #161920)',
          border: '1px solid var(--imp-border-strong, rgba(255, 255, 255, 0.16))',
          borderRadius: 10,
          padding: 16,
          boxSizing: 'border-box',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.88)',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          color: 'var(--imp-text-primary, #eef0f4)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div>
            <div
              style={{
                fontSize: 15,
                fontWeight: 800,
                color: 'var(--imp-accent-active-text, #f5e1be)',
              }}
            >
              Imp Help & Reference
            </div>
            <div style={{ fontSize: 11, color: 'var(--imp-text-secondary, #8b92a1)', marginTop: 2 }}>
              Open anytime via START (P / F1 / ☰) → System & Help → Quick Help
            </div>
          </div>
          <button
            type="button"
            data-quick-help-close="true"
            onClick={onClose}
            style={{
              minHeight: 30,
              padding: '0 10px',
              borderRadius: 6,
              background: 'var(--imp-surface-card, #1a1d24)',
              border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
              color: 'var(--imp-text-primary, #eef0f4)',
              fontFamily: 'monospace',
              fontSize: 11.5,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            ✕<span className="simp-gp-badge"> B</span>
          </button>
        </div>

        {/* Section Tabs */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            borderBottom: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
            gap: 4,
            flexShrink: 0,
          }}
        >
          {HELP_TABS.map((tab) => {
            const selected = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                style={{
                  minHeight: 32,
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
                }}
              >
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Scrollable Content */}
        <div
          style={{
            overflowY: 'auto',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            paddingRight: 2,
          }}
        >
          {activeTab === 'overview' && (
            <>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>Enabled Sources</div>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
                    gap: 8,
                  }}
                >
                  <button
                    type="button"
                    onClick={() => onToggleSourceVisibility('apple_music')}
                    style={sourceChipStyle(sourceVisibility.apple_music, '#f43f5e')}
                  >
                    {sourceVisibility.apple_music ? (
                      <AppleMusicLogo size={14} />
                    ) : (
                      <ImpIcon name="ban" size={13} color="#6b7280" />
                    )}
                    <span>Apple Music</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleSourceVisibility('soundcloud')}
                    style={sourceChipStyle(sourceVisibility.soundcloud, '#ea580c')}
                  >
                    {sourceVisibility.soundcloud ? (
                      <SoundCloudLogo width={30} />
                    ) : (
                      <ImpIcon name="ban" size={13} color="#6b7280" />
                    )}
                    <span>SoundCloud</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleSourceVisibility('internet_archive')}
                    style={sourceChipStyle(sourceVisibility.internet_archive, '#34d399')}
                  >
                    <ImpIcon
                      name={sourceVisibility.internet_archive ? 'archive' : 'ban'}
                      size={13}
                      color={sourceVisibility.internet_archive ? '#34d399' : '#6b7280'}
                    />
                    <span>Internet Archive</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => onToggleSourceVisibility('optical_drive')}
                    style={sourceChipStyle(sourceVisibility.optical_drive, '#f59e0b')}
                  >
                    <ImpIcon
                      name={sourceVisibility.optical_drive ? 'disc' : 'ban'}
                      size={13}
                      color={sourceVisibility.optical_drive ? '#f59e0b' : '#6b7280'}
                    />
                    <span>Optical Drive</span>
                  </button>
                </div>
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
                  gap: 10,
                }}
              >
                <div style={cardStyle}>
                  <div style={cardTitleStyle}>1. START Menu (P / F1 / ☰)</div>
                  <div style={cardBodyStyle}>
                    3-column menu across <strong>Display</strong>,{' '}
                    <strong>Audio &amp; Sources</strong>, and <strong>System &amp; Network</strong>.
                    Use <strong>Left / Right</strong> to switch columns and <strong>Up / Down</strong> to adjust items.
                  </div>
                  <button
                    type="button"
                    data-default-focus="true"
                    onClick={() => {
                      onClose();
                      onOpenFoldersAccounts();
                    }}
                    style={primaryActionBtnStyle}
                  >
                    Open Accounts &amp; Sources →
                  </button>
                </div>

                <div style={cardStyle}>
                  <div style={cardTitleStyle}>2. SELECT Context Menu (Tab / Right-Click)</div>
                  <div style={cardBodyStyle}>
                    Acts strictly on what is focused: current playing track &amp; queue in Player,
                    or focused track, album, playlist, local folder (Rescan), or optical disc in Library.
                  </div>
                </div>

                <div style={cardStyle}>
                  <div style={cardTitleStyle}>3. Compact Stats HUD</div>
                  <div style={cardBodyStyle}>
                    The monochrome pill in the top bar shows live daemon CPU %, RAM MB, and active
                    format. Click it to toggle minimal CPU-only view, or disable via{' '}
                    <strong>Stats HUD</strong> in <strong>Display</strong>.
                  </div>
                </div>

                <div style={cardStyle}>
                  <div style={cardTitleStyle}>4. Display Sleep &amp; Dimmer</div>
                  <div style={cardBodyStyle}>
                    <strong>Brightness</strong> and <strong>Idle Opacity</strong> dim the Studio Graphite
                    UI cleanly toward black. <strong>Sleep Display</strong> blanks to pure{' '}
                    <code>#000000</code> until any key, click, or button press wakes it.
                  </div>
                </div>
              </div>
            </>
          )}

          {activeTab === 'shortcuts' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>Keyboard</div>
                <div style={bindingGridStyle}>
                  {KEYBOARD_ROWS.map(([keys, desc]) => (
                    <React.Fragment key={keys}>
                      <span style={kbdBadgeStyle}>{keys}</span>
                      <span style={bindingDescStyle}>{desc}</span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>Gamepad</div>
                <div style={bindingGridStyle}>
                  {GAMEPAD_ROWS.map(([keys, desc]) => (
                    <React.Fragment key={keys}>
                      <span style={kbdBadgeStyle}>{keys}</span>
                      <span style={bindingDescStyle}>{desc}</span>
                    </React.Fragment>
                  ))}
                </div>
              </div>
            </div>
          )}

          {activeTab === 'audio_display' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>Equalizer &amp; Vocal Stage</div>
                <div style={cardBodyStyle}>
                  10-band biquad EQ (32 Hz – 16 kHz) with presets and mid/side vocal isolation
                  (Vocal Remover / Karaoke) synced across local audio and OS loopback capture.
                </div>
              </div>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>Visualizer &amp; Gaming Frame Pacing</div>
                <div style={cardBodyStyle}>
                  Open <strong>Visualizers...</strong> in <strong>Display</strong> to pick or cycle
                  scenes, and open <strong>Visualizer Options...</strong> for{' '}
                  <strong>20 / 30 (Default) / 40 FPS / Uncapped</strong> pacing,{' '}
                  <strong>Pause While Unfocused</strong>, lyrics overlays, trivia factoids, and
                  timed SoundCloud comment polling.
                </div>
              </div>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>Gamepad Focus Policy</div>
                <div style={cardBodyStyle}>
                  Under <strong>System &amp; Network</strong>, <strong>Focused Only</strong> (default)
                  prevents controller presses from reaching Imp while you are inside another fullscreen
                  or VR game. Switch to <strong>Always</strong> for background media control or{' '}
                  <strong>Off</strong> to disable gamepad capture completely.
                </div>
              </div>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>UI Scale &amp; Display Legibility</div>
                <div style={cardBodyStyle}>
                  Cycle <strong>UI Scale</strong> under <strong>Display</strong> between{' '}
                  <strong>Auto</strong> (100% on 800p handhelds, up to 135% on high-res displays) and
                  fixed presets (<strong>100% / 125% / 150% / 175%</strong>) to scale the header,
                  library, player controls, and all modals cleanly for 10–14 ft TVs or ultrawides
                  while keeping visualizer canvases crisp at native resolution.
                </div>
              </div>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>Idle Timer, Opacity &amp; Privacy Toggles</div>
                <div style={cardBodyStyle}>
                  Set <strong>Idle Timer</strong> and <strong>Idle Opacity</strong> under{' '}
                  <strong>Display</strong>. Under <strong>System &amp; Network → Networked Retrieval...</strong>,
                  independently gate online retrieval for <strong>Lyrics</strong>, <strong>Artwork</strong>,{' '}
                  <strong>Factoids</strong>, <strong>Album/DVD Track Data</strong>, and{' '}
                  <strong>SoundCloud Comments</strong>, or set <strong>Update Channel</strong> to{' '}
                  <strong>Off</strong> to disable background release checks while keeping cached items.
                </div>
              </div>
            </div>
          )}

          {activeTab === 'library_sources' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>Local Folders &amp; Accounts</div>
                <div style={cardBodyStyle}>
                  Manage local paths under <strong>Audio &amp; Sources → Folders...</strong> (or drag
                  and drop a folder onto the window). Connect or hide Apple Music, SoundCloud, and
                  Internet Archive under <strong>Accounts...</strong>, and manage CD/DVD drives under{' '}
                  <strong>Optical Drive...</strong>.
                </div>
              </div>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>Hybrid Playlists &amp; Imp FYP</div>
                <div style={cardBodyStyle}>
                  Mix local files, Apple Music, SoundCloud, and Internet Archive items inside unified
                  playlists. Pin shelves across any source to your <strong>Imp FYP</strong> dashboard
                  with <strong>+ FYP</strong> and reorder them in FYP Customize.
                </div>
              </div>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>Track Info &amp; Per-Track Curation</div>
                <div style={cardBodyStyle}>
                  Open <strong>Track Info</strong> from the SELECT menu to refetch or suppress synced
                  lyrics, adjust lyric timing offset (±250ms), override cover artwork, or hide overlays
                  for individual tracks.
                </div>
              </div>
              <div style={cardStyle}>
                <div style={cardTitleStyle}>Updates &amp; Database Maintenance</div>
                <div style={cardBodyStyle}>
                  Imp checks your selected <strong>Update Channel</strong> (Stable / Alpha / Off) and
                  notifies once per version tag. Use{' '}
                  <strong>System &amp; Network → Database &amp; Reset...</strong> to reset the
                  library index, purge per-source caches, or perform a full factory reset.
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

const cardStyle: React.CSSProperties = {
  padding: '10px 12px',
  borderRadius: 6,
  background: 'var(--imp-surface-card, #1a1d24)',
  border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: 12.5,
  fontWeight: 800,
  color: 'var(--imp-accent-active-text, #f5e1be)',
};

const cardBodyStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--imp-text-secondary, #8b92a1)',
  lineHeight: 1.5,
};

const bindingGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  columnGap: 12,
  rowGap: 6,
  alignItems: 'center',
};

const bindingDescStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--imp-text-primary, #eef0f4)',
};

const kbdBadgeStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 10.5,
  fontWeight: 800,
  color: 'var(--imp-accent-active-text, #f5e1be)',
  background: 'var(--imp-bg-canvas, #121418)',
  border: '1px solid var(--imp-border-strong, rgba(255, 255, 255, 0.16))',
  borderRadius: 5,
  padding: '2px 7px',
  whiteSpace: 'nowrap',
};

const primaryActionBtnStyle: React.CSSProperties = {
  marginTop: 2,
  minHeight: 32,
  padding: '0 12px',
  borderRadius: 6,
  background: 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
  border: '1px solid var(--imp-focus-ring, #e8b86d)',
  color: 'var(--imp-accent-active-text, #f5e1be)',
  fontSize: 11.5,
  fontWeight: 800,
  cursor: 'pointer',
  alignSelf: 'flex-start',
};

function sourceChipStyle(active: boolean, accent: string): React.CSSProperties {
  return {
    minHeight: 34,
    padding: '0 10px',
    borderRadius: 6,
    background: active
      ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))'
      : 'var(--imp-bg-canvas, #121418)',
    border: active
      ? `1px solid ${accent}`
      : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
    color: active ? 'var(--imp-text-primary, #eef0f4)' : '#6b7280',
    fontSize: 11.5,
    fontWeight: active ? 800 : 600,
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    whiteSpace: 'nowrap',
    gap: 6,
  };
}
