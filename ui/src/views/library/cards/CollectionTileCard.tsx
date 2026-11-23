import React from 'react';

export interface CollectionTileCardProps {
  tileKey: string;
  artwork: React.ReactNode;
  badge?: React.ReactNode;
  badgeStyle?: React.CSSProperties;
  title: string;
  subtitle?: React.ReactNode;
  subtitleColor?: string;
  titleAttr?: string;
  isSelected?: boolean;
  selectedBg?: string;
  selectedBorder?: string;
  cardBg?: string;
  cardBorder?: string;
  onSelect: () => void;
  onOpenContextMenu?: () => void;
}

/**
 * Shared fixed-proportion square collection card with inset artwork badge,
 * hover-only options button, and clamped title/subtitle footer.
 */
export const CollectionTileCard: React.FC<CollectionTileCardProps> = ({
  tileKey,
  artwork,
  badge,
  badgeStyle,
  title,
  subtitle,
  subtitleColor,
  titleAttr,
  isSelected = false,
  selectedBg = 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
  selectedBorder = '1px solid var(--imp-focus-ring, #e8b86d)',
  cardBg = 'var(--imp-surface-card, #1a1d24)',
  cardBorder = '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
  onSelect,
  onOpenContextMenu,
}) => {
  return (
    <button
      type="button"
      data-right-tile="true"
      data-tile-key={tileKey}
      title={titleAttr}
      onContextMenu={
        onOpenContextMenu
          ? (e) => {
              e.preventDefault();
              onOpenContextMenu();
            }
          : undefined
      }
      onClick={onSelect}
      style={{
        width: '100%',
        minWidth: 0,
        padding: 9,
        borderRadius: 10,
        overflow: 'hidden',
        background: isSelected ? selectedBg : cardBg,
        border: isSelected ? selectedBorder : cardBorder,
        color: 'var(--imp-text-primary, #eef0f4)',
        textAlign: 'left',
        cursor: 'pointer',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          position: 'relative',
          width: '100%',
          aspectRatio: '1 / 1',
          borderRadius: 7,
          overflow: 'hidden',
          flexShrink: 0,
          background: '#11141a',
        }}
      >
        {artwork}
        {badge && (
          <span
            style={{
              position: 'absolute',
              bottom: 6,
              right: 6,
              maxWidth: 'calc(100% - 12px)',
              padding: '2px 6px',
              borderRadius: 5,
              background: 'rgba(12, 14, 18, 0.86)',
              border: '1px solid rgba(255, 255, 255, 0.16)',
              color: '#eef0f4',
              fontSize: 10,
              fontFamily: 'monospace',
              fontWeight: 700,
              lineHeight: 1.15,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              pointerEvents: 'none',
              ...badgeStyle,
            }}
          >
            {badge}
          </span>
        )}
        {onOpenContextMenu && (
          <span
            role="button"
            tabIndex={-1}
            className="imp-tile-hover-menu"
            data-tile-aux="true"
            data-context-select="true"
            title="More options (SELECT / Right-Click)"
            onClick={(e) => {
              e.stopPropagation();
              onOpenContextMenu();
            }}
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              width: 24,
              height: 24,
              borderRadius: 6,
              background: 'rgba(12, 14, 18, 0.88)',
              border: '1px solid rgba(255, 255, 255, 0.2)',
              color: '#eef0f4',
              fontSize: 12,
              fontWeight: 800,
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              lineHeight: 1,
            }}
          >
            •••
          </span>
        )}
      </div>

      <div
        style={{
          minWidth: 0,
          width: '100%',
          display: 'flex',
          flexDirection: 'column',
          gap: 3,
        }}
      >
        <div
          style={{
            fontSize: 12.5,
            fontWeight: 700,
            lineHeight: 1.28,
            color: 'var(--imp-text-primary, #eef0f4)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
            minHeight: '2.56em',
          }}
        >
          {title}
        </div>
        <div
          style={{
            fontSize: 11,
            lineHeight: 1.3,
            color: subtitleColor || 'var(--imp-text-secondary, #8b92a1)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            minHeight: '1.3em',
          }}
        >
          {subtitle}
        </div>
      </div>
    </button>
  );
};
