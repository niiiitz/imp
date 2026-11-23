import React, { useEffect } from 'react';
import { ImpIcon } from '../icons/ImpIcon';
import {
  formatVisualizerFpsCapLabel,
  VISUALIZER_SCENES,
  type VisualizerEngine,
  type VisualizerFpsCap,
  type VisualizerMode,
} from './sceneRegistry';

interface VisualizerDrawerModalProps {
  open: boolean;
  onClose: () => void;
  vizMode: VisualizerMode;
  activeEngine: VisualizerEngine;
  enabledScenes: VisualizerEngine[];
  fpsCap: VisualizerFpsCap;
  pauseWhenUnfocused?: boolean;
  onSelectMode: (mode: VisualizerMode) => void;
  onToggleSceneInRotation: (engine: VisualizerEngine) => void;
  onToggleFpsCap: () => void;
  onTogglePauseWhenUnfocused?: () => void;
  onSetAllScenesInRotation?: (engines: VisualizerEngine[]) => void;
}

export const VisualizerDrawerModal: React.FC<VisualizerDrawerModalProps> = ({
  open,
  onClose,
  vizMode,
  activeEngine,
  enabledScenes,
  fpsCap,
  pauseWhenUnfocused = false,
  onSelectMode,
  onToggleSceneInRotation,
  onToggleFpsCap,
  onTogglePauseWhenUnfocused,
}) => {
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      const target =
        document.querySelector<HTMLElement>(
          '[data-viz-drawer-modal="true"] button[data-default-focus="true"]:not([disabled])',
        ) ||
        document.querySelector<HTMLElement>(
          '[data-viz-drawer-modal="true"] button:not([disabled])',
        );
      if (!target) return;
      document
        .querySelectorAll<HTMLElement>('[data-simp-active-focus="true"], .simp-gpfocus')
        .forEach((node) => {
          if (node !== target) {
            node.removeAttribute('data-simp-active-focus');
            node.classList.remove('simp-gpfocus');
          }
        });
      target.setAttribute('data-simp-active-focus', 'true');
      target.classList.add('simp-gpfocus');
      target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }, 25);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

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
        padding: 18,
        zIndex: 92,
      }}
    >
      <div
        data-modal-root="true"
        data-viz-drawer-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 650,
          maxHeight: '88vh',
          background: 'var(--imp-surface-panel, #161920)',
          border: '1px solid var(--imp-border-strong, rgba(255, 255, 255, 0.16))',
          borderRadius: 10,
          padding: 16,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          boxShadow: '0 20px 50px rgba(0, 0, 0, 0.85)',
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
            <div style={{ fontSize: 15, fontWeight: 800, color: 'var(--imp-accent-active-text, #f5e1be)' }}>
              Visualizer Scenes
            </div>
            <div style={{ fontSize: 11, color: 'var(--imp-text-secondary, #8b92a1)' }}>
              Toggle rotation on left or click a row to lock scene
            </div>
          </div>
          <button
            type="button"
            data-viz-drawer-close="true"
            onClick={onClose}
            style={{
              minHeight: 32,
              padding: '0 10px',
              borderRadius: 6,
              background: 'var(--imp-surface-card, #1a1d24)',
              border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
              color: 'var(--imp-text-primary, #eef0f4)',
              fontFamily: 'monospace',
              fontWeight: 700,
              fontSize: 11.5,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <ImpIcon name="close" size={13} />
            <span className="simp-gp-badge">B</span>
          </button>
        </div>

        {/* Playback Mode Pills: Cycle | Shuffle | Off */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 6,
          }}
        >
          <button
            type="button"
            data-default-focus={vizMode === 'cycle' ? 'true' : undefined}
            onClick={() => onSelectMode('cycle')}
            style={{
              minHeight: 36,
              padding: '6px 10px',
              borderRadius: 6,
              background:
                vizMode === 'cycle'
                  ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))'
                  : 'var(--imp-surface-card, #1a1d24)',
              border:
                vizMode === 'cycle'
                  ? '1px solid var(--imp-focus-ring, #e8b86d)'
                  : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
              color:
                vizMode === 'cycle'
                  ? 'var(--imp-accent-active-text, #f5e1be)'
                  : 'var(--imp-text-secondary, #8b92a1)',
              fontWeight: 800,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <ImpIcon
              name="refresh"
              size={13}
              color={vizMode === 'cycle' ? 'var(--imp-focus-ring, #e8b86d)' : '#8b92a1'}
            />
            <span>Cycle ({enabledScenes.length})</span>
          </button>

          <button
            type="button"
            data-default-focus={vizMode === 'shuffle' ? 'true' : undefined}
            onClick={() => onSelectMode('shuffle')}
            style={{
              minHeight: 36,
              padding: '6px 10px',
              borderRadius: 6,
              background:
                vizMode === 'shuffle'
                  ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))'
                  : 'var(--imp-surface-card, #1a1d24)',
              border:
                vizMode === 'shuffle'
                  ? '1px solid var(--imp-focus-ring, #e8b86d)'
                  : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
              color:
                vizMode === 'shuffle'
                  ? 'var(--imp-accent-active-text, #f5e1be)'
                  : 'var(--imp-text-secondary, #8b92a1)',
              fontWeight: 800,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <ImpIcon
              name="shuffle"
              size={13}
              color={vizMode === 'shuffle' ? 'var(--imp-focus-ring, #e8b86d)' : '#8b92a1'}
            />
            <span>Shuffle ({enabledScenes.length})</span>
          </button>

          <button
            type="button"
            data-default-focus={vizMode === 'off' ? 'true' : undefined}
            onClick={() => onSelectMode('off')}
            style={{
              minHeight: 36,
              padding: '6px 10px',
              borderRadius: 6,
              background: vizMode === 'off' ? 'rgba(244, 63, 94, 0.16)' : 'var(--imp-surface-card, #1a1d24)',
              border:
                vizMode === 'off'
                  ? '1px solid rgba(251, 113, 133, 0.65)'
                  : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
              color: vizMode === 'off' ? '#fecdd3' : 'var(--imp-text-secondary, #8b92a1)',
              fontWeight: 800,
              fontSize: 12,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <ImpIcon name="ban" size={13} color={vizMode === 'off' ? '#fb7185' : '#8b92a1'} />
            <span>Off</span>
          </button>
        </div>

        {/* Rotation Legend + Frame Rate Cap + Unfocused Pause Toggle */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: 8,
            padding: '0 2px',
            fontSize: 11,
            color: '#94a3b8',
          }}
        >
          <span>
            <strong>Left toggle</strong> = rotation • <strong>Row</strong> = lock scene
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button
              type="button"
              onClick={onToggleFpsCap}
              title="Cycle visualizer frame rate: 20 FPS, 30 FPS (default), 40 FPS, or Uncapped"
              style={{
                minHeight: 28,
                padding: '3px 10px',
                borderRadius: 8,
                background:
                  fpsCap === 0 ? 'rgba(56, 189, 248, 0.16)' : 'rgba(16, 185, 129, 0.14)',
                border:
                  fpsCap === 0
                    ? '1px solid rgba(56, 189, 248, 0.48)'
                    : '1px solid rgba(52, 211, 153, 0.45)',
                color: fpsCap === 0 ? '#7dd3fc' : '#6ee7b7',
                fontSize: 10.5,
                fontFamily: 'monospace',
                fontWeight: 800,
                cursor: 'pointer',
                letterSpacing: '0.03em',
                whiteSpace: 'nowrap',
              }}
            >
              {formatVisualizerFpsCapLabel(fpsCap)}
            </button>
            {onTogglePauseWhenUnfocused && (
              <button
                type="button"
                onClick={onTogglePauseWhenUnfocused}
                title="When enabled, pauses visualizer rendering at 0 FPS whenever Imp is unfocused (keep off for dual-monitor setups)"
                style={{
                  minHeight: 28,
                  padding: '3px 10px',
                  borderRadius: 8,
                  background: pauseWhenUnfocused
                    ? 'rgba(245, 158, 11, 0.16)'
                    : 'rgba(148, 163, 184, 0.12)',
                  border: pauseWhenUnfocused
                    ? '1px solid rgba(245, 158, 11, 0.48)'
                    : '1px solid rgba(148, 163, 184, 0.32)',
                  color: pauseWhenUnfocused ? '#fcd34d' : '#cbd5e1',
                  fontSize: 10.5,
                  fontFamily: 'monospace',
                  fontWeight: 800,
                  cursor: 'pointer',
                  letterSpacing: '0.02em',
                  whiteSpace: 'nowrap',
                }}
              >
                {pauseWhenUnfocused ? 'Unfocused: Pause' : 'Unfocused: Active'}
              </button>
            )}
          </div>
        </div>

        {/* Scrollable Scene Roster */}
        <div
          style={{
            overflowY: 'auto',
            overflowX: 'hidden',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
            paddingRight: 4,
          }}
        >
          {VISUALIZER_SCENES.map((scene) => {
            const isLockedSingle = vizMode === scene.id;
            const isCurrentlyRendering = vizMode !== 'off' && activeEngine === scene.id;
            const isInRotation = enabledScenes.includes(scene.id);

            return (
              <div
                key={scene.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '76px minmax(0, 1fr)',
                  alignItems: 'stretch',
                  gap: 8,
                }}
              >
                {/* Left-Aligned Rotation Enable Toggle */}
                <button
                  type="button"
                  onClick={() => onToggleSceneInRotation(scene.id)}
                  title="Include or exclude this scene when Cycle or Shuffle is active"
                  style={{
                    width: '100%',
                    minHeight: 44,
                    borderRadius: 6,
                    background: isInRotation
                      ? 'rgba(16, 185, 129, 0.14)'
                      : 'var(--imp-surface-card, #1a1d24)',
                    border: isInRotation
                      ? '1px solid rgba(52, 211, 153, 0.45)'
                      : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                    color: isInRotation ? '#34d399' : '#64748b',
                    fontSize: 11,
                    fontFamily: 'monospace',
                    fontWeight: 800,
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    gap: 5,
                  }}
                >
                  <ImpIcon
                    name={isInRotation ? 'check' : 'close'}
                    size={12}
                    color={isInRotation ? '#34d399' : '#64748b'}
                  />
                  <span>{isInRotation ? 'On' : 'Off'}</span>
                </button>

                {/* Right Scene Lock Card */}
                <button
                  type="button"
                  data-default-focus={isLockedSingle ? 'true' : undefined}
                  onClick={() => onSelectMode(scene.id)}
                  style={{
                    minWidth: 0,
                    minHeight: 44,
                    padding: '6px 12px',
                    borderRadius: 6,
                    background: isCurrentlyRendering
                      ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))'
                      : 'var(--imp-surface-card, #1a1d24)',
                    border: isLockedSingle || isCurrentlyRendering
                      ? '1px solid var(--imp-focus-ring, #e8b86d)'
                      : '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                    color: 'var(--imp-text-primary, #eef0f4)',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    textAlign: 'left',
                    overflow: 'hidden',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 800,
                          color: isCurrentlyRendering
                            ? 'var(--imp-accent-active-text, #f5e1be)'
                            : 'var(--imp-text-primary, #eef0f4)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {scene.label}
                      </span>
                      <span
                        style={{
                          fontSize: 9.5,
                          fontFamily: 'monospace',
                          fontWeight: 800,
                          padding: '1px 6px',
                          borderRadius: 5,
                          flexShrink: 0,
                          background: 'var(--imp-bg-canvas, #121418)',
                          color: 'var(--imp-text-secondary, #8b92a1)',
                          border: '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                        }}
                      >
                        {scene.eraBadge}
                      </span>
                      {isCurrentlyRendering && (
                        <span
                          style={{
                            fontSize: 9.5,
                            fontFamily: 'monospace',
                            fontWeight: 800,
                            color: '#facc15',
                            flexShrink: 0,
                          }}
                        >
                          LIVE
                        </span>
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: 'var(--imp-text-secondary, #8b92a1)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {scene.subtitle}
                    </div>
                  </div>

                  <span
                    style={{
                      fontFamily: 'monospace',
                      fontSize: 10.5,
                      fontWeight: 800,
                      color: isLockedSingle ? 'var(--imp-focus-ring, #e8b86d)' : '#64748b',
                      flexShrink: 0,
                    }}
                  >
                    {isLockedSingle ? 'LOCKED' : scene.shortLabel}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
