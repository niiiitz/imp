import React from "react";
import {
  ArchiveItemSummary,
  PlaylistRecord,
} from "@simp/client";
import {
  type BrowseHubTarget,
  tileGridStyle,
} from "../libraryHelpers";
import { FilterTriggerButton, PinnableSectionHeader } from "../PinnableSectionHeader";
import { TTL_ARCHIVE_SEC } from "../../../api/servicesCacheApi";

export interface InternetArchiveDiscoverPaneProps {
  activeHubLabel: string;
  browseHubTarget: BrowseHubTarget;
  browserSearch: string;
  browserSourceFilter: "all" | "local" | "apple_music" | "soundcloud" | "internet_archive";
  filteredIaItems: ArchiveItemSummary[];
  handleDeletePlaylist: any;
  handlePinArchiveCollection: any;
  iaHasMore: boolean;
  iaLoading: boolean;
  iaLoadingMore: boolean;
  iaSubFilter: string;
  iaSubTab: "pinned" | "trending" | "films" | "tv" | "audio";
  loadIaDiscover: any;
  loadMoreIaDiscover: any;
  onOpenFilters?: () => void;
  playlists: PlaylistRecord[];
  renderArchiveItemCard: any;
}

export const InternetArchiveDiscoverPane: React.FC<InternetArchiveDiscoverPaneProps> = ({
  activeHubLabel,
  browseHubTarget,
  browserSearch,
  filteredIaItems,
  handleDeletePlaylist,
  handlePinArchiveCollection,
  iaHasMore,
  iaLoading,
  iaLoadingMore,
  iaSubFilter,
  iaSubTab,
  loadIaDiscover,
  loadMoreIaDiscover,
  onOpenFilters,
  playlists,
  renderArchiveItemCard,
}) => {
  return (
    <>
                {/* ---------------------------------------------------------
                    9. 🏛️ INTERNET ARCHIVE DISCOVERY HUB (Trending, Films, TV, Concerts & Audio)
                   --------------------------------------------------------- */}
                {browseHubTarget === 'ia_discover' && iaSubTab !== 'pinned' && (
                  <>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        paddingBottom: 10,
                        borderBottom: '1px solid #16161c',
                        flexWrap: 'wrap',
                        gap: 8,
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span
                          style={{
                            fontSize: 14,
                            fontWeight: 800,
                            color: '#fde68a',
                            marginRight: 4,
                          }}
                        >
                          🏛️ {activeHubLabel}
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                        <FilterTriggerButton
                          summary={iaSubFilter === 'all' ? 'All' : iaSubFilter.replace('_', ' ')}
                          active={iaSubFilter !== 'all'}
                          accentColor="#f59e0b"
                          activeBg="#261a0b"
                          activeText="#fde68a"
                          onClick={onOpenFilters}
                        />
                        {filteredIaItems.length > 0 &&
                          (() => {
                            const collKey = `${iaSubTab}:${iaSubFilter}`;
                            const collId = `archive:collection:${collKey}`;
                            const isCollPinned = playlists.some((p) => p.id === collId);
                            const collTitle = `${activeHubLabel}${
                              iaSubFilter !== 'all' ? ` (${iaSubFilter.replace('_', ' ')})` : ''
                            }`;
                            return (
                              <button
                                data-right-filter-pill="true"
                                data-right-pin-collection="true"
                                onClick={() => {
                                  if (isCollPinned) {
                                    handleDeletePlaylist(collId, collTitle);
                                  } else {
                                    handlePinArchiveCollection(collKey, collTitle, filteredIaItems);
                                  }
                                }}
                                style={{
                                  padding: '4px 10px',
                                  borderRadius: 6,
                                  background: isCollPinned ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))' : '#261a0b',
                                  border: isCollPinned ? '1px solid var(--imp-focus-ring, #e8b86d)' : '1px solid #d97706',
                                  color: isCollPinned ? 'var(--imp-accent-active-text, #f5e1be)' : '#fde68a',
                                  fontSize: 11,
                                  fontWeight: 800,
                                  cursor: 'pointer',
                                }}
                              >
                                {isCollPinned ? '✓ 📌 Pinned Collection' : '📌 Pin Collection'}
                              </button>
                            );
                          })()}
                        <button
                          data-right-filter-pill="true"
                          onClick={() => loadIaDiscover(iaSubTab, iaSubFilter)}
                          style={{
                            padding: '4px 9px',
                            borderRadius: 6,
                            background: '#161620',
                            border: '1px solid #2a2a38',
                            color: '#fde68a',
                            fontSize: 11,
                            fontWeight: 700,
                            cursor: 'pointer',
                          }}
                        >
                          ↻ Refresh
                        </button>
                      </div>
                    </div>

                    {filteredIaItems.length > 0 ? (
                      <section
                        data-section-anchor="ia_discover_grid"
                        style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0 }}
                      >
                        <PinnableSectionHeader
                          title={`ARCHIVE ITEMS (${filteredIaItems.length})`}
                          accentColor="#fde68a"
                          descriptor={{
                            shelfUid: `ia:discover:${iaSubTab}:${iaSubFilter || 'all'}`,
                            cacheKey: `ia:discover:${iaSubTab}:${iaSubFilter || 'all'}`,
                            provider: 'internet_archive',
                            title: `Internet Archive • ${activeHubLabel}${
                              iaSubFilter && iaSubFilter !== 'all'
                                ? ` (${iaSubFilter.replace('_', ' ')})`
                                : ''
                            }`,
                            itemKind: 'ia_items',
                            fetchSpec: {
                              kind: 'ia_discover',
                              tab: iaSubTab,
                              subFilter: iaSubFilter || 'all',
                            },
                            originRoute: {
                              sourceFilter: 'internet_archive',
                              iaSubTab,
                              iaSubFilter: iaSubFilter || 'all',
                              sectionAnchor: 'ia_discover_grid',
                            },
                            ttlSec: TTL_ARCHIVE_SEC,
                          }}
                          liveItems={filteredIaItems}
                        />
                        <div style={tileGridStyle}>{filteredIaItems.map(renderArchiveItemCard)}</div>
                        {iaHasMore && !browserSearch.trim() && (
                          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
                            <button
                              data-focusable="true"
                              data-load-more="true"
                              aria-busy={iaLoadingMore}
                              onClick={loadMoreIaDiscover}
                              style={{
                                minHeight: 38,
                                padding: '0 20px',
                                borderRadius: 10,
                                background: '#1c140a',
                                border: '1px solid #d97706',
                                color: '#fcd34d',
                                fontSize: 12,
                                fontWeight: 800,
                                cursor: iaLoadingMore ? 'wait' : 'pointer',
                              }}
                            >
                              {iaLoadingMore ? '⏳ Loading More Archive Items...' : '⬇ Load More Archive Items'}
                            </button>
                          </div>
                        )}
                      </section>
                    ) : (
                      !iaLoading && (
                        <div style={{ fontSize: 12, color: '#8e8e99', padding: '12px 4px' }}>
                          {iaSubFilter === 'favorites'
                            ? 'No public Internet Archive favorites found. Add your @username in Folders & Connected Accounts to sync fav-{username}.'
                            : 'No items returned from Internet Archive for this filter.'}
                        </div>
                      )
                    )}
                  </>
                )}
    </>
  );
};
