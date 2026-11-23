import React from 'react';
import { SourceVisibilityPrefs } from '../views/SettingsModal';
import { AppleMusicLogo } from './AppleMusicLogo';
import { SoundCloudLogo } from './SoundCloudLogo';
import { ImpIcon } from './icons/ImpIcon';

export interface QuickHelpModalProps {
  onClose: () => void;
  onOpenFoldersAccounts: () => void;
  sourceVisibility: SourceVisibilityPrefs;
  onToggleSourceVisibility: (key: keyof SourceVisibilityPrefs) => void;
}

export const QuickHelpModal: React.FC<QuickHelpModalProps> = ({
  onClose,
  onOpenFoldersAccounts,
  sourceVisibility,
  onToggleSourceVisibility,
}) => {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.84)',
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
          maxWidth: 640,
          maxHeight: '88vh',
          overflowY: 'auto',
          background: 'var(--imp-surface-panel, #161920)',
          border: '2px solid var(--imp-focus-ring, #e8b86d)',
          borderRadius: 18,
          padding: 20,
          boxSizing: 'border-box',
          boxShadow: '0 24px 60px rgba(0, 0, 0, 0.94)',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
          color: '#e4e4ec',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 12,
            paddingBottom: 10,
            borderBottom: '1px solid #1e1e2c',
          }}
        >
          <div>
            <div style={{ fontSize: 15, fontWeight: 900, color: 'var(--imp-accent-active-text, #f5e1be)', display: 'flex', alignItems: 'center', gap: 7 }}>
              <ImpIcon name="bolt" size={15} color="#fb923c" />
              <span>IMP Quick Guide</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--imp-text-secondary, #8b92a1)', marginTop: 2 }}>
              Re-open via START (☰) → Help
            </div>
          </div>
          <button
            type="button"
            data-quick-help-close="true"
            onClick={onClose}
            style={{
              minHeight: 36,
              padding: '0 12px',
              borderRadius: 9,
              background: '#16161f',
              border: '1px solid #2e2e3a',
              color: '#d4d4dc',
              fontFamily: 'monospace',
              fontSize: 12,
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            ✕<span className="simp-gp-badge"> B</span>
          </button>
        </div>

        {/* Choose Sources Bar (Above Steps 1-4) */}
        <div
          style={{
            padding: '10px 12px',
            borderRadius: 12,
            background: '#0e1018',
            border: '1px solid #222638',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ fontSize: 12, fontWeight: 800, color: 'var(--imp-accent-active-text, #f5e1be)' }}>
            Choose Sources:
          </div>
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
              {sourceVisibility.apple_music ? <AppleMusicLogo size={14} /> : <ImpIcon name="ban" size={13} color="#6b7280" />}
              <span>Apple Music</span>
            </button>
            <button
              type="button"
              onClick={() => onToggleSourceVisibility('soundcloud')}
              style={sourceChipStyle(sourceVisibility.soundcloud, '#ea580c')}
            >
              {sourceVisibility.soundcloud ? <SoundCloudLogo width={30} /> : <ImpIcon name="ban" size={13} color="#6b7280" />}
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
              <span>Optical Disc</span>
            </button>
          </div>
        </div>

        {/* Tip Cards Grid (Steps 1-4) */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
            gap: 10,
          }}
        >
          {/* 1. START Menu */}
          <div style={tipCardStyle}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: 'var(--imp-accent-active-text, #f5e1be)' }}>
              1. START Menu
            </div>
            <div style={tipBodyStyle}>
              Configure accounts and local folders from <strong>START (☰)</strong>.
            </div>
            <button
              type="button"
              data-default-focus="true"
              onClick={() => {
                onClose();
                onOpenFoldersAccounts();
              }}
              style={{
                marginTop: 4,
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
              }}
            >
              Folders &amp; Accounts →
            </button>
          </div>

          {/* 2. [SELECT] Context Actions */}
          <div style={tipCardStyle}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#fdba74', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>2.</span>
              <ImpIcon name="gamepad-select" size={13} color="#fdba74" />
              <span>SELECT Actions</span>
            </div>
            <div style={tipBodyStyle}>
              Press <strong>SELECT</strong> or right-click any focused item for track, queue, visualizer, and pin actions.
            </div>
          </div>

          {/* 3. Gamepad Controls */}
          <div style={tipCardStyle}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#fda4af', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>3.</span>
              <ImpIcon name="gamepad" size={13} color="#fda4af" />
              <span>Controls</span>
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'auto 1fr',
                columnGap: 10,
                rowGap: 4,
                fontSize: 11.5,
                color: '#cbd5e1',
                marginTop: 2,
              }}
            >
              <span style={kbdBadgeStyle}>R1 / L1</span>
              <span>Player ↔ Library / Tabs</span>
              <span style={kbdBadgeStyle}>A / B</span>
              <span>Select / Back</span>
              <span style={kbdBadgeStyle}>X / Y</span>
              <span>Shuffle / Search</span>
              <span style={kbdBadgeStyle}>R2 / L2</span>
              <span>Seek ±10s</span>
            </div>
          </div>

          {/* 4. Library Management */}
          <div style={tipCardStyle}>
            <div style={{ fontSize: 12.5, fontWeight: 800, color: '#a7f3d0', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span>4.</span>
              <ImpIcon name="folder" size={13} color="#a7f3d0" />
              <span>Library</span>
            </div>
            <div style={tipBodyStyle}>
              Search across enabled sources, build hybrid playlists, and pin collections.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

const tipCardStyle: React.CSSProperties = {
  padding: '11px 13px',
  borderRadius: 12,
  background: '#10111a',
  border: '1px solid #222436',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const tipBodyStyle: React.CSSProperties = {
  fontSize: 12,
  color: '#cbd5e1',
  lineHeight: 1.48,
};

const kbdBadgeStyle: React.CSSProperties = {
  fontFamily: 'monospace',
  fontSize: 10.5,
  fontWeight: 800,
  color: 'var(--imp-accent-active-text, #f5e1be)',
  background: '#141c24',
  border: '1px solid #243b4a',
  borderRadius: 5,
  padding: '1px 6px',
  alignSelf: 'start',
};

function sourceChipStyle(active: boolean, accent: string): React.CSSProperties {
  return {
    minHeight: 34,
    padding: '0 10px',
    borderRadius: 8,
    background: active ? 'rgba(232, 184, 109, 0.14)' : '#12121a',
    border: active ? `1px solid ${accent}` : '1px solid transparent',
    color: active ? '#f8fafc' : '#6b7280',
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

