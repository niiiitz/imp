import React from 'react';
import {
  emitSimpToast,
  FypShelfDescriptor,
  useFypShelves,
} from '../../api/servicesCacheApi';
import { ImpIcon } from '../../components/icons/ImpIcon';
import { useCollapsedSections } from './libraryHelpers';
import { useExpandedShelf } from './ExpandedShelfContext';

export interface FilterTriggerButtonProps {
  summary?: string;
  active?: boolean;
  accentColor?: string;
  activeBg?: string;
  activeText?: string;
  onClick?: () => void;
}

export const FilterTriggerButton: React.FC<FilterTriggerButtonProps> = ({
  summary,
  active = false,
  accentColor = 'var(--imp-focus-ring, #e8b86d)',
  activeBg = 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
  activeText = 'var(--imp-accent-active-text, #f5e1be)',
  onClick,
}) => {
  if (!onClick) return null;
  return (
    <button
      type="button"
      data-right-filter-pill="true"
      data-open-filter-modal="true"
      onClick={onClick}
      style={{
        padding: '4px 10px',
        borderRadius: 7,
        background: active ? activeBg : '#12121b',
        border: active ? `1px solid ${accentColor}` : '1px solid #262635',
        color: active ? activeText : '#cbd5e1',
        fontSize: 11,
        fontWeight: 800,
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
      }}
    >
      <span>⚲ Filters{summary ? `: ${summary}` : ''}</span>
      <span className="simp-gp-badge">Y</span>
    </button>
  );
};

export interface CollapsibleSectionHeaderProps {
  sectionKey: string;
  title: React.ReactNode;
  accentColor?: string;
  trailing?: React.ReactNode;
}

export const CollapsibleSectionHeader: React.FC<CollapsibleSectionHeaderProps> = ({
  sectionKey,
  title,
  accentColor = '#94a3b8',
  trailing,
}) => {
  const { isCollapsed, toggle } = useCollapsedSections();
  const { isShelfExpandable, openShelf } = useExpandedShelf();
  const collapsed = isCollapsed(sectionKey);

  if (collapsed) {
    return (
      <div
        data-section-collapsed-header="true"
        data-section-shelf-uid={sectionKey}
        style={{ width: '100%' }}
      >
        <button
          type="button"
          data-right-tile="true"
          data-section-collapsed-bar={sectionKey}
          onClick={() => toggle(sectionKey)}
          style={{
            width: '100%',
            padding: '8px 12px',
            borderRadius: 9,
            background: '#0c0c14',
            border: '1px solid #1e1e2b',
            color: accentColor,
            fontSize: 11,
            fontFamily: 'monospace',
            fontWeight: 800,
            letterSpacing: 0.4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 10,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            <span>▸</span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title}
            </span>
          </span>
          <span style={{ fontSize: 10, color: '#64748b', flexShrink: 0 }}>
            Press X or A to expand
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      data-section-shelf-uid={sectionKey}
      data-section-accent={accentColor}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 10,
        paddingBottom: 6,
        borderBottom: '1px solid #181822',
        flexWrap: 'wrap',
      }}
    >
      <button
        type="button"
        tabIndex={-1}
        data-no-dpad-focus="true"
        data-section-toggle="true"
        onClick={() => toggle(sectionKey)}
        title="Click (or press X on any item below) to collapse section"
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          fontSize: 11,
          fontFamily: 'monospace',
          fontWeight: 800,
          letterSpacing: 0.4,
          color: accentColor,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          minWidth: 0,
          flexWrap: 'wrap',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ opacity: 0.75 }}>▾</span>
        <span data-section-title-text="true">{title}</span>
      </button>
      {(trailing || isShelfExpandable(sectionKey)) && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          {isShelfExpandable(sectionKey) && (
            <button
              type="button"
              tabIndex={-1}
              data-no-dpad-focus="true"
              data-right-filter-pill="true"
              data-shelf-see-all-header={sectionKey}
              onClick={() => openShelf(sectionKey)}
              title="Expand shelf to full grid"
              style={{
                minHeight: 26,
                padding: '0 9px',
                borderRadius: 7,
                background: '#12151d',
                border: '1px solid rgba(255, 255, 255, 0.14)',
                color: accentColor,
                fontSize: 10.5,
                fontWeight: 800,
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4,
                cursor: 'pointer',
              }}
            >
              <span>See All ›</span>
            </button>
          )}
          {trailing}
        </div>
      )}
    </div>
  );
};

export interface PinnableSectionHeaderProps {
  title: React.ReactNode;
  descriptor: FypShelfDescriptor;
  liveItems: unknown[];
  trailing?: React.ReactNode;
  accentColor?: string;
}

export const PinnableSectionHeader: React.FC<PinnableSectionHeaderProps> = ({
  title,
  descriptor,
  liveItems,
  trailing,
  accentColor = '#94a3b8',
}) => {
  const { shelves, pinShelfWithSnapshot, unpinShelf } = useFypShelves();
  const isPinned = shelves.some((s) => s.shelf_uid === descriptor.shelfUid && s.enabled);

  return (
    <CollapsibleSectionHeader
      sectionKey={descriptor.shelfUid}
      title={title}
      accentColor={accentColor}
      trailing={
        <>
          {trailing}
          <button
            type="button"
            tabIndex={-1}
            data-no-dpad-focus="true"
            data-right-filter-pill="true"
            data-fyp-pin-btn="true"
            data-fyp-shelf-uid={descriptor.shelfUid}
            data-fyp-shelf-title={descriptor.title}
            data-fyp-shelf-pinned={isPinned ? 'true' : 'false'}
            onClick={() => {
              if (isPinned) {
                unpinShelf(descriptor.shelfUid);
                emitSimpToast(`Removed "${descriptor.title}" from Imp FYP`);
              } else {
                pinShelfWithSnapshot(descriptor, liveItems);
                emitSimpToast(`Pinned "${descriptor.title}" to Imp FYP`);
              }
            }}
            title={
              isPinned
                ? `Remove "${descriptor.title}" from Imp FYP`
                : `Pin "${descriptor.title}" to top-level Imp FYP dashboard`
            }
            style={{
              minHeight: 26,
              padding: '0 9px',
              borderRadius: 7,
              background: isPinned ? '#161822' : '#0c0d14',
              border: isPinned ? '1px solid #383c52' : '1px solid #222432',
              color: isPinned ? '#e2e8f0' : '#9ca3af',
              fontSize: 10.5,
              fontWeight: 800,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              cursor: 'pointer',
            }}
          >
            <ImpIcon
              name={isPinned ? 'check' : 'bolt'}
              size={11}
              color={isPinned ? '#e2e8f0' : '#9ca3af'}
            />
            <span>{isPinned ? 'In FYP' : '+ FYP'}</span>
          </button>
        </>
      }
    />
  );
};
