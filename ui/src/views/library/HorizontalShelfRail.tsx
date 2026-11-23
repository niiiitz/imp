import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tileGridStyle } from './libraryHelpers';
import { useExpandedShelf } from './ExpandedShelfContext';

export interface HorizontalShelfRailProps {
  variant?: 'tiles' | 'tracks';
  itemCount?: number;
  shelfId?: string;
  shelfTitle?: string;
  accentColor?: string;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: () => void;
  children: React.ReactNode;
}

const chevronBtnBaseStyle: React.CSSProperties = {
  position: 'absolute',
  top: '50%',
  transform: 'translateY(-50%)',
  width: 30,
  height: 44,
  borderRadius: 8,
  background: 'var(--imp-surface-elevated, #21252f)',
  border: '1px solid var(--imp-border-strong, rgba(255, 255, 255, 0.16))',
  color: 'var(--imp-text-primary, #eef0f4)',
  fontSize: 18,
  fontWeight: 800,
  lineHeight: 1,
  cursor: 'pointer',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  boxShadow: '0 8px 20px rgba(0, 0, 0, 0.72)',
  zIndex: 4,
};

/**
 * Horizontal overflow rail for 1-row collection shelves and 3-row single-track shelves
 * with edge overflow chevrons, smooth push-through scrolling, and optional "See All ›" grid pop-out.
 */
export const HorizontalShelfRail: React.FC<HorizontalShelfRailProps> = ({
  variant = 'tiles',
  itemCount,
  shelfId,
  shelfTitle,
  accentColor,
  hasMore = false,
  loadingMore = false,
  onLoadMore,
  children,
}) => {
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);
  const [discoveredMeta, setDiscoveredMeta] = useState<{
    id: string;
    title: string;
    accent: string;
  }>({ id: '', title: '', accent: '#e2e8f0' });

  const {
    expandedShelfId,
    portalHost,
    openShelf,
    closeShelf,
    setShelfExpandable,
  } = useExpandedShelf();

  const count = itemCount ?? React.Children.count(children);
  const trackRows = Math.min(3, Math.max(1, count));

  const resolvedShelfId = shelfId || discoveredMeta.id;
  const resolvedTitle = shelfTitle || discoveredMeta.title;
  const resolvedAccent = accentColor || discoveredMeta.accent || '#e2e8f0';
  const isExpanded = Boolean(resolvedShelfId && expandedShelfId === resolvedShelfId);
  const canExpand =
    isExpanded ||
    (Boolean(resolvedShelfId) && (canScrollRight || count > 4 || Boolean(hasMore)));

  useEffect(() => {
    if (shelfId) return;
    const wrapperEl = wrapperRef.current;
    const parentEl = wrapperEl?.parentElement;
    if (!parentEl) return;
    const headerEl = Array.from(parentEl.children).find((child) =>
      child.hasAttribute('data-section-shelf-uid')
    ) as HTMLElement | undefined;
    if (!headerEl) return;
    const uid = headerEl.getAttribute('data-section-shelf-uid') || '';
    const accent = headerEl.getAttribute('data-section-accent') || '#e2e8f0';
    const titleNode = headerEl.querySelector<HTMLElement>('[data-section-title-text="true"]');
    const rawTitle = (titleNode?.textContent || '').replace(/^[▸▾]\s*/, '').trim();
    if (!uid) return;
    setDiscoveredMeta((prev) =>
      prev.id === uid && prev.title === rawTitle && prev.accent === accent
        ? prev
        : { id: uid, title: rawTitle, accent }
    );
  }, [shelfId, shelfTitle, count]);

  useEffect(() => {
    if (!resolvedShelfId) return;
    setShelfExpandable(resolvedShelfId, canExpand);
  }, [resolvedShelfId, canExpand, setShelfExpandable]);

  useEffect(() => {
    return () => {
      if (resolvedShelfId) {
        setShelfExpandable(resolvedShelfId, false);
      }
    };
  }, [resolvedShelfId, setShelfExpandable]);

  const syncOverflowState = useCallback(() => {
    const el = scrollerRef.current;
    if (!el || el.clientWidth === 0) return;
    const left = el.scrollLeft > 4;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 4;
    setCanScrollLeft((prev) => (prev === left ? prev : left));
    setCanScrollRight((prev) => (prev === right ? prev : right));
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const rafId = window.requestAnimationFrame(syncOverflowState);
    const onScroll = () => syncOverflowState();
    el.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', syncOverflowState);
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => syncOverflowState())
        : null;
    observer?.observe(el);
    return () => {
      window.cancelAnimationFrame(rafId);
      el.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', syncOverflowState);
      observer?.disconnect();
    };
  }, [syncOverflowState, count, variant, isExpanded]);

  const scrollByPage = (direction: -1 | 1) => {
    const el = scrollerRef.current;
    if (!el) return;
    const step = Math.max(240, Math.round(el.clientWidth * 0.78));
    el.scrollBy({ left: direction * step, behavior: 'smooth' });
  };

  return (
    <div ref={wrapperRef} style={{ position: 'relative', minWidth: 0, width: '100%' }}>
      {isExpanded &&
        portalHost &&
        createPortal(
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 14,
              minWidth: 0,
              width: '100%',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                paddingBottom: 8,
                borderBottom:
                  '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                flexWrap: 'wrap',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  minWidth: 0,
                  flexWrap: 'wrap',
                }}
              >
                <button
                  type="button"
                  data-right-back-grid="true"
                  data-right-filter-pill="true"
                  onClick={closeShelf}
                  style={{
                    minHeight: 30,
                    padding: '0 10px',
                    borderRadius: 7,
                    background: 'var(--imp-surface-card, #1a1d24)',
                    border:
                      '1px solid var(--imp-border-strong, rgba(255, 255, 255, 0.16))',
                    color: 'var(--imp-text-primary, #eef0f4)',
                    fontSize: 11.5,
                    fontWeight: 800,
                    fontFamily: 'monospace',
                    cursor: 'pointer',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  <span>← Back</span>
                  <span className="simp-gp-badge">B</span>
                </button>
                <strong
                  style={{
                    fontSize: 13.5,
                    color: resolvedAccent,
                    letterSpacing: '0.02em',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                >
                  {resolvedTitle || 'Shelf Items'}
                </strong>
                <span
                  style={{
                    padding: '2px 8px',
                    borderRadius: 999,
                    background: 'var(--imp-surface-card, #1a1d24)',
                    border:
                      '1px solid var(--imp-border-subtle, rgba(255, 255, 255, 0.08))',
                    color: 'var(--imp-text-secondary, #8b92a1)',
                    fontSize: 10.5,
                    fontFamily: 'monospace',
                    fontWeight: 700,
                  }}
                >
                  {count} items
                </span>
              </div>
            </div>

            {variant === 'tiles' ? (
              <div style={tileGridStyle}>{children}</div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  width: '100%',
                  minWidth: 0,
                }}
              >
                {children}
              </div>
            )}

            {hasMore && onLoadMore && (
              <div style={{ display: 'flex', justifyContent: 'center', paddingTop: 6 }}>
                <button
                  type="button"
                  data-load-more="true"
                  data-right-tile="true"
                  disabled={loadingMore}
                  onClick={onLoadMore}
                  style={{
                    minHeight: 36,
                    padding: '0 18px',
                    borderRadius: 8,
                    background: 'var(--imp-surface-card, #1a1d24)',
                    border: '1px solid var(--imp-focus-ring, #e8b86d)',
                    color: 'var(--imp-accent-active-text, #f5e1be)',
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: loadingMore ? 'wait' : 'pointer',
                    opacity: loadingMore ? 0.65 : 1,
                  }}
                >
                  {loadingMore ? 'Loading more...' : '⬇ Load More'}
                </button>
              </div>
            )}
          </div>,
          portalHost
        )}

      <div
        ref={scrollerRef}
        data-h-rail="true"
        data-h-rail-variant={variant}
        style={
          variant === 'tracks'
            ? {
                display: 'grid',
                gridAutoFlow: 'column',
                gridTemplateRows: `repeat(${trackRows}, auto)`,
                gridAutoColumns: 'var(--imp-track-col-width, 288px)',
                gap: 8,
                overflowX: 'auto',
                overflowY: 'hidden',
                padding: '2px 2px 4px 2px',
                scrollBehavior: 'smooth',
                minWidth: 0,
              }
            : {
                display: 'flex',
                flexDirection: 'row',
                flexWrap: 'nowrap',
                gap: 10,
                overflowX: 'auto',
                overflowY: 'hidden',
                padding: '2px 2px 4px 2px',
                scrollBehavior: 'smooth',
                minWidth: 0,
              }
        }
      >
        {!isExpanded && children}
        {!isExpanded && canExpand && resolvedShelfId && (
          variant === 'tiles' ? (
            <button
              type="button"
              data-right-tile="true"
              data-tile-key={`see-all:${resolvedShelfId}`}
              data-shelf-see-all={resolvedShelfId}
              onClick={() => openShelf(resolvedShelfId)}
              style={{
                width: 'var(--imp-tile-width, 184px)',
                flex: '0 0 var(--imp-tile-width, 184px)',
                alignSelf: 'stretch',
                minHeight: 160,
                padding: 12,
                borderRadius: 10,
                background: 'var(--imp-surface-card, #1a1d24)',
                border:
                  '1px dashed var(--imp-border-strong, rgba(255, 255, 255, 0.16))',
                color: resolvedAccent,
                fontSize: 12,
                fontWeight: 800,
                cursor: 'pointer',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 8,
                textAlign: 'center',
                boxSizing: 'border-box',
              }}
            >
              <span style={{ fontSize: 22, lineHeight: 1 }}>›</span>
              <span>See All ({count})</span>
            </button>
          ) : (
            <button
              type="button"
              data-right-tile="true"
              data-tile-key={`see-all:${resolvedShelfId}`}
              data-shelf-see-all={resolvedShelfId}
              onClick={() => openShelf(resolvedShelfId)}
              style={{
                minWidth: 112,
                height: '100%',
                minHeight: 54,
                padding: '0 14px',
                borderRadius: 8,
                background: 'var(--imp-surface-card, #1a1d24)',
                border:
                  '1px dashed var(--imp-border-strong, rgba(255, 255, 255, 0.16))',
                color: resolvedAccent,
                fontSize: 11.5,
                fontWeight: 800,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                whiteSpace: 'nowrap',
                boxSizing: 'border-box',
              }}
            >
              <span>See All ({count}) ›</span>
            </button>
          )
        )}
      </div>

      {canScrollLeft && !isExpanded && (
        <>
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 0,
              top: 0,
              bottom: 4,
              width: 38,
              pointerEvents: 'none',
              background: 'linear-gradient(to right, rgba(18, 20, 24, 0.92), transparent)',
              zIndex: 3,
            }}
          />
          <button
            type="button"
            data-no-dpad-focus="true"
            aria-label="Scroll left"
            title="Previous items"
            onClick={() => scrollByPage(-1)}
            style={{ ...chevronBtnBaseStyle, left: 4 }}
          >
            ‹
          </button>
        </>
      )}

      {canScrollRight && !isExpanded && (
        <>
          <div
            aria-hidden="true"
            style={{
              position: 'absolute',
              right: 0,
              top: 0,
              bottom: 4,
              width: 42,
              pointerEvents: 'none',
              background: 'linear-gradient(to left, rgba(18, 20, 24, 0.94), transparent)',
              zIndex: 3,
            }}
          />
          <button
            type="button"
            data-no-dpad-focus="true"
            aria-label="Scroll right"
            title="More items"
            onClick={() => scrollByPage(1)}
            style={{ ...chevronBtnBaseStyle, right: 4 }}
          >
            ›
          </button>
        </>
      )}
    </div>
  );
};
