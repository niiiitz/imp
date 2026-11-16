import React from 'react';
import {
  emitSimpToast,
  FypShelfDescriptor,
  useFypShelves,
} from '../../api/servicesCacheApi';
import { ImpIcon } from '../../components/icons/ImpIcon';

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
    <div
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
      <div
        style={{
          fontSize: 11,
          fontFamily: 'monospace',
          fontWeight: 800,
          letterSpacing: 0.4,
          color: accentColor,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          minWidth: 0,
          flexWrap: 'wrap',
        }}
      >
        {title}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
        {trailing}
        <button
          type="button"
          data-focusable="true"
          data-row-aux="true"
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
            background: isPinned ? '#0f222a' : '#12131c',
            border: isPinned ? '1px solid #2aa3c4' : '1px solid #282a3a',
            color: isPinned ? '#67e8f9' : '#cbd5e1',
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
            color={isPinned ? '#67e8f9' : '#fde047'}
          />
          <span>{isPinned ? 'In FYP' : '+ FYP'}</span>
        </button>
      </div>
    </div>
  );
};
