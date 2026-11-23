import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

export interface ExpandedShelfContextValue {
  expandedShelfId: string | null;
  portalHost: HTMLDivElement | null;
  registerPortalHost: (node: HTMLDivElement | null) => void;
  openShelf: (shelfId: string) => void;
  closeShelf: () => void;
  setShelfExpandable: (shelfId: string, expandable: boolean) => void;
  isShelfExpandable: (shelfId: string) => boolean;
}

const ExpandedShelfContext = createContext<ExpandedShelfContextValue>({
  expandedShelfId: null,
  portalHost: null,
  registerPortalHost: () => {},
  openShelf: () => {},
  closeShelf: () => {},
  setShelfExpandable: () => {},
  isShelfExpandable: () => false,
});

export interface ExpandedShelfProviderProps {
  resetKey: string;
  applyFocusMarker?: (el: HTMLElement | null) => void;
  children: React.ReactNode;
}

/**
 * Coordinates inline "See All ›" shelf expansion inside the Library Browser right pane.
 * Uses CSS-selector containment and React Portals so any HorizontalShelfRail can pop out
 * to a multi-row grid or vertical tracklist without altering its data flow or mounting state.
 */
export const ExpandedShelfProvider: React.FC<ExpandedShelfProviderProps> = ({
  resetKey,
  applyFocusMarker,
  children,
}) => {
  const [expandedShelfId, setExpandedShelfId] = useState<string | null>(null);
  const [portalHost, setPortalHost] = useState<HTMLDivElement | null>(null);
  const [expandableIds, setExpandableIds] = useState<Set<string>>(() => new Set());
  const savedScrollTopRef = useRef<number>(0);

  useEffect(() => {
    setExpandedShelfId(null);
    savedScrollTopRef.current = 0;
  }, [resetKey]);

  const registerPortalHost = useCallback((node: HTMLDivElement | null) => {
    setPortalHost((prev) => (prev === node ? prev : node));
  }, []);

  const setShelfExpandable = useCallback((shelfId: string, expandable: boolean) => {
    if (!shelfId) return;
    setExpandableIds((prev) => {
      const has = prev.has(shelfId);
      if (has === expandable) return prev;
      const next = new Set(prev);
      if (expandable) {
        next.add(shelfId);
      } else {
        next.delete(shelfId);
      }
      return next;
    });
  }, []);

  const isShelfExpandable = useCallback(
    (shelfId: string) => Boolean(shelfId && expandableIds.has(shelfId)),
    [expandableIds]
  );

  const openShelf = useCallback(
    (shelfId: string) => {
      if (!shelfId) return;
      const rightPane = document.querySelector<HTMLElement>('[data-nav-col="right"]');
      if (rightPane) {
        savedScrollTopRef.current = rightPane.scrollTop;
        rightPane.scrollTop = 0;
      }
      setExpandedShelfId(shelfId);
      window.setTimeout(() => {
        const firstInteractive =
          document.querySelector<HTMLElement>(
            '[data-expanded-shelf-portal="true"] [data-right-tile="true"]:not([disabled]), [data-expanded-shelf-portal="true"] [data-single-song-play="true"]:not([disabled])'
          ) ||
          document.querySelector<HTMLElement>(
            '[data-expanded-shelf-portal="true"] button:not([disabled])'
          );
        if (firstInteractive && applyFocusMarker) {
          applyFocusMarker(firstInteractive);
        }
      }, 35);
    },
    [applyFocusMarker]
  );

  const closeShelf = useCallback(() => {
    const prevId = expandedShelfId;
    const restoreScroll = savedScrollTopRef.current;
    setExpandedShelfId(null);
    window.setTimeout(() => {
      const rightPane = document.querySelector<HTMLElement>('[data-nav-col="right"]');
      if (rightPane) {
        rightPane.scrollTop = restoreScroll;
      }
      if (prevId && applyFocusMarker) {
        const headerEl = Array.from(
          document.querySelectorAll<HTMLElement>('[data-section-shelf-uid]')
        ).find((el) => el.getAttribute('data-section-shelf-uid') === prevId);
        const sectionEl = headerEl?.parentElement;
        const target =
          sectionEl?.querySelector<HTMLElement>(
            '[data-right-tile="true"]:not([disabled]), [data-single-song-play="true"]:not([disabled])'
          ) ||
          Array.from(
            document.querySelectorAll<HTMLElement>('[data-shelf-see-all]')
          ).find((el) => el.getAttribute('data-shelf-see-all') === prevId) ||
          null;
        if (target) {
          applyFocusMarker(target);
        }
      }
    }, 35);
  }, [expandedShelfId, applyFocusMarker]);

  const value = useMemo<ExpandedShelfContextValue>(
    () => ({
      expandedShelfId,
      portalHost,
      registerPortalHost,
      openShelf,
      closeShelf,
      setShelfExpandable,
      isShelfExpandable,
    }),
    [
      expandedShelfId,
      portalHost,
      registerPortalHost,
      openShelf,
      closeShelf,
      setShelfExpandable,
      isShelfExpandable,
    ]
  );

  return (
    <ExpandedShelfContext.Provider value={value}>
      {children}
    </ExpandedShelfContext.Provider>
  );
};

export function useExpandedShelf(): ExpandedShelfContextValue {
  return useContext(ExpandedShelfContext);
}
