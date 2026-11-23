import React from 'react';
import { defaultSimpClient, PlaylistRecord, TrackMetadata } from '@simp/client';
import { OskTargetKind } from '../hooks/useGamepadNavigation';
import {
  addTracksToAppleCloudPlaylist,
  AppleCloudPlaylistSummary,
  createAppleCloudPlaylist,
  fetchApplePlaylistTracks,
} from '../drivers/appleApi';
import {
  addTracksToSoundCloudSet,
  SoundCloudPlaylistSummary,
} from '../drivers/SoundCloudDriver';
import { BrowserTarget } from '../views/PlayerView';
import { cleanCollectionTitle } from '../views/library/libraryHelpers';
import { ImpIcon } from './icons/ImpIcon';

export interface PendingHybridAddJob {
  uris: string[];
  label: string;
  trackMetadata?: TrackMetadata[];
  creatingNew?: boolean;
}

interface PendingOnlineForkChoice {
  provider: 'apple' | 'soundcloud';
  cloudPlaylistId: string;
  pinnedPlaylistId?: string;
  title: string;
  trackCount: number;
}

export interface HybridPlaylistPickerModalProps {
  pendingHybridAdd: PendingHybridAddJob | null;
  setPendingHybridAdd: React.Dispatch<React.SetStateAction<PendingHybridAddJob | null>>;
  setOskTarget: React.Dispatch<React.SetStateAction<OskTargetKind>>;
  playlists: PlaylistRecord[];
  activePlaylistId: string;
  commitAddTracksToPlaylist: (
    uris: string[],
    label: string,
    trackMetadata?: TrackMetadata[],
    explicitPlaylistId?: string,
    createNewName?: string
  ) => Promise<void>;
  setNewPlaylistName: React.Dispatch<React.SetStateAction<string>>;
  applyFocusMarker: (el: HTMLElement | null) => void;
  newPlaylistName: string;
  cloudPlaylists?: AppleCloudPlaylistSummary[];
  setCloudPlaylists?: React.Dispatch<React.SetStateAction<AppleCloudPlaylistSummary[]>>;
  scPlaylists?: SoundCloudPlaylistSummary[];
  setScPlaylists?: React.Dispatch<React.SetStateAction<SoundCloudPlaylistSummary[]>>;
  appleAuthenticated?: boolean;
  scAuthenticated?: boolean;
  browserTarget?: BrowserTarget | null;
  setBrowserTracks?: React.Dispatch<React.SetStateAction<TrackMetadata[]>>;
  refreshLibraryData?: () => void;
  showToast?: (msg: string) => void;
}

export const HybridPlaylistPickerModal: React.FC<HybridPlaylistPickerModalProps> = ({
  pendingHybridAdd,
  setPendingHybridAdd,
  setOskTarget,
  playlists,
  activePlaylistId,
  commitAddTracksToPlaylist,
  setNewPlaylistName,
  applyFocusMarker,
  newPlaylistName,
  cloudPlaylists = [],
  setCloudPlaylists,
  scPlaylists = [],
  setScPlaylists,
  appleAuthenticated = false,
  scAuthenticated = false,
  browserTarget,
  setBrowserTracks,
  refreshLibraryData,
  showToast,
}) => {
  const [onlineChoice, setOnlineChoice] = React.useState<PendingOnlineForkChoice | null>(null);
  const [creatingCloudApple, setCreatingCloudApple] = React.useState(false);
  const [busyMsg, setBusyMsg] = React.useState<string | null>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const wasOpenRef = React.useRef(false);

  React.useEffect(() => {
    setOnlineChoice(null);
    setCreatingCloudApple(false);
    setBusyMsg(null);
    if (pendingHybridAdd && !wasOpenRef.current) {
      returnFocusRef.current =
        (document.querySelector<HTMLElement>('[data-simp-active-focus="true"]') as HTMLElement | null) ||
        (document.activeElement as HTMLElement | null);
    }
    wasOpenRef.current = Boolean(pendingHybridAdd);
  }, [pendingHybridAdd]);

  if (!pendingHybridAdd) return null;

  const isAppleBatch =
    pendingHybridAdd.uris.length > 0 &&
    pendingHybridAdd.uris.every((u) => u.startsWith('applemusic:')) &&
    (!pendingHybridAdd.trackMetadata ||
      pendingHybridAdd.trackMetadata.every((t) => t.source === 'apple_music'));

  const isSoundCloudBatch =
    pendingHybridAdd.uris.length > 0 &&
    pendingHybridAdd.uris.every((u) => u.startsWith('soundcloud:')) &&
    (!pendingHybridAdd.trackMetadata ||
      pendingHybridAdd.trackMetadata.every((t) => t.source === 'soundcloud'));

  const editableApplePlaylists = appleAuthenticated
    ? cloudPlaylists.filter((p) => Boolean(p.can_edit) || p.id.startsWith('p.'))
    : [];
  const editableAppleIdSet = new Set(editableApplePlaylists.map((p) => p.id));

  const editableScSets = scAuthenticated
    ? scPlaylists.filter((p) => p.kind === 'user_set')
    : [];
  const editableScIdSet = new Set(
    editableScSets.map((p) => p.id.replace(/^soundcloud:playlist:/, ''))
  );

  // Deduplicate unpinned editable cloud playlists that are already represented as pinned SIMP playlists
  const pinnedAppleRawIds = new Set(
    playlists
      .filter((p) => p.origin === 'apple_remote')
      .map((p) => p.id.replace(/^applemusic:playlist:/, ''))
  );
  const pinnedScRawIds = new Set(
    playlists
      .filter((p) => p.origin === 'soundcloud_remote')
      .map((p) => p.id.replace(/^soundcloud:playlist:/, ''))
  );

  const unpinnedEditableApple = isAppleBatch
    ? editableApplePlaylists.filter((p) => !pinnedAppleRawIds.has(p.id))
    : [];
  const unpinnedEditableSc = isSoundCloudBatch
    ? editableScSets.filter(
        (p) => !pinnedScRawIds.has(p.id.replace(/^soundcloud:playlist:/, ''))
      )
    : [];

  const restoreFocusAfterClose = () => {
    const saved = returnFocusRef.current;
    returnFocusRef.current = null;
    window.setTimeout(() => {
      const target =
        (saved && document.body.contains(saved) ? saved : null) ||
        document.querySelector<HTMLElement>(
          '[data-nav-col="right"] [data-right-track="true"][data-track-playing="true"]'
        ) ||
        document.querySelector<HTMLElement>('[data-nav-col="right"] [data-right-track="true"]');
      if (target) {
        applyFocusMarker(target);
      }
    }, 25);
  };

  const closeModal = () => {
    setPendingHybridAdd(null);
    setOskTarget(null);
    setOnlineChoice(null);
    setCreatingCloudApple(false);
    setBusyMsg(null);
    restoreFocusAfterClose();
  };

  const focusFirstModalButton = () => {
    window.setTimeout(() => {
      const btn = document.querySelector<HTMLElement>(
        '[data-hybrid-picker-modal="true"] button[data-default-focus="true"], [data-hybrid-picker-modal="true"] button:not([disabled])'
      );
      if (btn) applyFocusMarker(btn);
    }, 30);
  };

  const handleUpdateOnlineCollection = async (choice: PendingOnlineForkChoice) => {
    const job = pendingHybridAdd;
    setBusyMsg(
      choice.provider === 'apple'
        ? 'Updating Apple Music Cloud Playlist...'
        : 'Updating SoundCloud Set...'
    );
    try {
      if (choice.provider === 'apple') {
        await addTracksToAppleCloudPlaylist(choice.cloudPlaylistId, job.uris);
        if (
          browserTarget?.kind === 'cloud_playlist' &&
          browserTarget.id === choice.cloudPlaylistId &&
          setBrowserTracks
        ) {
          const updated = await fetchApplePlaylistTracks(choice.cloudPlaylistId, 'library').catch(
            () => []
          );
          if (updated.length > 0) setBrowserTracks(updated);
        }
        if (choice.pinnedPlaylistId) {
          refreshLibraryData?.();
          if (
            browserTarget?.kind === 'playlist' &&
            browserTarget.id === choice.pinnedPlaylistId &&
            setBrowserTracks
          ) {
            const updated = await defaultSimpClient
              .query<TrackMetadata[]>('get_playlist_items', {
                playlist_id: choice.pinnedPlaylistId,
                limit: 2000,
                offset: 0,
              })
              .catch(() => []);
            if (updated.length > 0) setBrowserTracks(updated);
          }
        }
        showToast?.(`☁️ Added ${job.label} to Apple Playlist "${choice.title}"`);
      } else {
        const updatedTracks = await addTracksToSoundCloudSet(choice.cloudPlaylistId, job.uris);
        if (updatedTracks.length > 0) {
          setScPlaylists?.((prev) =>
            prev.map((sp) =>
              sp.id.replace(/^soundcloud:playlist:/, '') === choice.cloudPlaylistId
                ? { ...sp, track_count: updatedTracks.length, tracks: updatedTracks }
                : sp
            )
          );
          if (
            setBrowserTracks &&
            ((browserTarget?.kind === 'soundcloud_playlist' &&
              browserTarget.id.replace(/^soundcloud:playlist:/, '') === choice.cloudPlaylistId) ||
              (choice.pinnedPlaylistId &&
                browserTarget?.kind === 'playlist' &&
                browserTarget.id === choice.pinnedPlaylistId))
          ) {
            setBrowserTracks(updatedTracks);
          }
        }
        refreshLibraryData?.();
        showToast?.(`☁️ Added ${job.label} to SoundCloud Set "${choice.title}"`);
      }
      closeModal();
    } catch (err: any) {
      setBusyMsg(null);
      showToast?.(err?.message || 'Failed to update online collection');
    }
  };

  const handleForkOnlineToHybrid = async (choice: PendingOnlineForkChoice) => {
    const job = pendingHybridAdd;
    closeModal();
    if (choice.pinnedPlaylistId) {
      await commitAddTracksToPlaylist(
        job.uris,
        job.label,
        job.trackMetadata,
        choice.pinnedPlaylistId
      );
    } else {
      await commitAddTracksToPlaylist(
        job.uris,
        job.label,
        job.trackMetadata,
        undefined,
        choice.title
      );
    }
  };

  const openNameKeyboardOrInput = (inputSelector: string) => {
    if (document.documentElement.dataset.simpInput === 'gamepad') {
      setOskTarget('playlist');
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ type: 'SIMP_OPEN_OSK' }, '*');
      }
      window.setTimeout(() => {
        const firstKey = document.querySelector<HTMLElement>(
          '[data-osk-root="true"] button[data-default-focus="true"], [data-osk-root="true"] button'
        );
        if (firstKey) applyFocusMarker(firstKey);
      }, 40);
    } else {
      window.setTimeout(() => {
        const inp = document.querySelector<HTMLInputElement>(inputSelector);
        inp?.focus();
      }, 30);
    }
  };

  const handleCreateAppleCloudPlaylist = async (rawName: string) => {
    const trimmed = rawName.trim() || 'New Apple Cloud Playlist';
    const job = pendingHybridAdd;
    setBusyMsg(`Creating "${trimmed}" on Apple Music...`);
    try {
      const created = await createAppleCloudPlaylist(
        trimmed,
        'Created from IMP',
        job.uris
      );
      setCloudPlaylists?.((prev) => [created, ...prev]);
      setNewPlaylistName('');
      showToast?.(`☁️ Created Apple Cloud Playlist "${created.name}" with ${job.label}`);
      closeModal();
    } catch (err: any) {
      setBusyMsg(null);
      showToast?.(err?.message || 'Could not create Apple Cloud Playlist');
    }
  };

  return (
    <div
      onClick={closeModal}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0, 0, 0, 0.86)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
        boxSizing: 'border-box',
        zIndex: 80,
      }}
    >
      <div
        data-modal-root="true"
        data-hybrid-picker-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 480,
          maxHeight: '84vh',
          overflowY: 'auto',
          background: 'var(--imp-surface-card, #1a1d24)',
          border: '2px solid var(--imp-focus-ring, #e8b86d)',
          borderRadius: 18,
          padding: 20,
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          boxShadow: '0 16px 40px rgba(0, 0, 0, 0.85)',
        }}
      >
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: 'var(--imp-accent-active-text, #f5e1be)' }}>
              {onlineChoice
                ? '☁️ Online Sync vs. ★ Local Hybrid'
                : '★ Add to Playlist or Set'}
            </div>
            <div
              style={{
                fontSize: 11,
                color: '#8e8e99',
                marginTop: 2,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {onlineChoice
                ? `Target: "${onlineChoice.title}" • Adding ${pendingHybridAdd.label}`
                : `Adding ${pendingHybridAdd.label}`}
            </div>
          </div>
          <button
            data-hybrid-picker-close="true"
            onClick={closeModal}
            style={{
              minHeight: 38,
              padding: '0 12px',
              borderRadius: 9,
              background: '#16161f',
              border: '1px solid #2e2e3a',
              color: '#d4d4dc',
              fontFamily: 'monospace',
              cursor: 'pointer',
              flexShrink: 0,
            }}
          >
            ✕<span className="simp-gp-badge"> B</span>
          </button>
        </div>

        {busyMsg && (
          <div
            style={{
              padding: '10px 12px',
              borderRadius: 10,
              background: '#111824',
              border: '1px solid var(--imp-focus-ring, #e8b86d)',
              color: 'var(--imp-accent-active-text, #f5e1be)',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            ⏳ {busyMsg}
          </div>
        )}

        {onlineChoice ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
            <button
              type="button"
              disabled={Boolean(busyMsg)}
              data-default-focus="true"
              onClick={() => handleUpdateOnlineCollection(onlineChoice)}
              style={{
                minHeight: 54,
                padding: '10px 14px',
                borderRadius: 11,
                background: onlineChoice.provider === 'apple' ? '#251018' : '#261409',
                border:
                  onlineChoice.provider === 'apple'
                    ? '1px solid #fb7185'
                    : '1px solid #fb923c',
                color: '#f4f4f6',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 3,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  fontSize: 13,
                  fontWeight: 800,
                  color: onlineChoice.provider === 'apple' ? '#fda4af' : '#fdba74',
                }}
              >
                ☁️ Update Online {onlineChoice.provider === 'apple' ? 'Apple Playlist' : 'SoundCloud Set'}
              </span>
              <span style={{ fontSize: 11, color: '#cbd5e1' }}>
                Write directly to "{onlineChoice.title}" on{' '}
                {onlineChoice.provider === 'apple' ? 'Apple Music' : 'SoundCloud'} (re-syncs IMP if pinned)
              </span>
            </button>

            <button
              type="button"
              disabled={Boolean(busyMsg)}
              onClick={() => handleForkOnlineToHybrid(onlineChoice)}
              style={{
                minHeight: 54,
                padding: '10px 14px',
                borderRadius: 11,
                background: 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
                border: '1px solid var(--imp-focus-ring, #e8b86d)',
                color: '#f4f4f6',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 3,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 800, color: 'var(--imp-accent-active-text, #f5e1be)' }}>
                ★ Fork / Save as Local Imp Hybrid Playlist
              </span>
              <span style={{ fontSize: 11, color: '#cbd5e1' }}>
                {onlineChoice.pinnedPlaylistId
                  ? 'Convert pinned copy into an editable multi-source Local Hybrid Playlist'
                  : 'Create a local multi-source ★ IMP Hybrid copy without changing the cloud list'}
              </span>
            </button>

            <button
              type="button"
              disabled={Boolean(busyMsg)}
              onClick={() => {
                setOnlineChoice(null);
                focusFirstModalButton();
              }}
              style={{
                minHeight: 38,
                padding: '0 12px',
                borderRadius: 9,
                background: '#14141d',
                border: '1px solid #2a2a36',
                color: '#a1a1aa',
                fontSize: 12,
                fontWeight: 700,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              ← Back to Playlist List
            </button>
          </div>
        ) : (
          <>
            {!pendingHybridAdd.creatingNew && !creatingCloudApple ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
                <button
                  disabled={Boolean(busyMsg)}
                  data-default-focus={playlists.length === 0 ? 'true' : undefined}
                  onClick={() => {
                    setNewPlaylistName('');
                    setCreatingCloudApple(false);
                    setPendingHybridAdd((prev) =>
                      prev ? { ...prev, creatingNew: true } : null
                    );
                    openNameKeyboardOrInput(
                      '[data-hybrid-picker-modal="true"] input[data-osk-input="playlist"]'
                    );
                  }}
                  style={{
                    minHeight: 42,
                    padding: '0 14px',
                    borderRadius: 10,
                    background: '#121822',
                    border: '1px dashed var(--imp-focus-ring, #e8b86d)',
                    color: 'var(--imp-accent-active-text, #f5e1be)',
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  ★ + Create New IMP Hybrid Playlist...
                </button>
                {isAppleBatch && appleAuthenticated && (
                  <button
                    disabled={Boolean(busyMsg)}
                    onClick={() => {
                      setNewPlaylistName('');
                      setPendingHybridAdd((prev) =>
                        prev ? { ...prev, creatingNew: false } : null
                      );
                      setCreatingCloudApple(true);
                      openNameKeyboardOrInput(
                        '[data-hybrid-picker-modal="true"] input[data-osk-input="playlist"]'
                      );
                    }}
                    style={{
                      minHeight: 42,
                      padding: '0 14px',
                      borderRadius: 10,
                      background: '#1c0d14',
                      border: '1px dashed #fb7185',
                      color: '#fda4af',
                      fontSize: 12,
                      fontWeight: 800,
                      cursor: 'pointer',
                      textAlign: 'left',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <ImpIcon name="apple" size={13} color="#fb7185" />
                    <span>+ Create New Apple Cloud Playlist...</span>
                  </button>
                )}
              </div>
            ) : (
              <div
                style={{
                  display: 'flex',
                  gap: 8,
                  padding: 10,
                  borderRadius: 10,
                  background: creatingCloudApple ? '#1c0d14' : 'var(--imp-surface-card, #1a1d24)',
                  border: creatingCloudApple ? '1px solid #fb7185' : '1px solid var(--imp-focus-ring, #e8b86d)',
                }}
              >
                <input
                  type="text"
                  data-osk-input="playlist"
                  placeholder={
                    creatingCloudApple
                      ? 'New Apple Cloud Playlist name...'
                      : 'New IMP Playlist name...'
                  }
                  value={newPlaylistName}
                  onChange={(e) => setNewPlaylistName(e.target.value)}
                  onClick={() => {
                    if (document.documentElement.dataset.simpInput === 'gamepad') {
                      setOskTarget('playlist');
                      if (window.parent && window.parent !== window) {
                        window.parent.postMessage({ type: 'SIMP_OPEN_OSK' }, '*');
                      }
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      if (creatingCloudApple) {
                        handleCreateAppleCloudPlaylist(newPlaylistName);
                      } else {
                        const job = pendingHybridAdd;
                        const chosenName = newPlaylistName;
                        closeModal();
                        commitAddTracksToPlaylist(
                          job.uris,
                          job.label,
                          job.trackMetadata,
                          undefined,
                          chosenName
                        );
                      }
                    }
                  }}
                  style={{
                    flex: 1,
                    minHeight: 38,
                    padding: '0 12px',
                    borderRadius: 8,
                    background: 'var(--imp-bg-canvas, #121418)',
                    border: '1px solid #2e2e3c',
                    color: '#d4d4dc',
                    fontSize: 12,
                  }}
                />
                <button
                  disabled={Boolean(busyMsg)}
                  data-hybrid-picker-submit="true"
                  data-default-focus="true"
                  onClick={() => {
                    if (creatingCloudApple) {
                      handleCreateAppleCloudPlaylist(newPlaylistName);
                    } else {
                      const job = pendingHybridAdd;
                      const chosenName = newPlaylistName;
                      closeModal();
                      commitAddTracksToPlaylist(
                        job.uris,
                        job.label,
                        job.trackMetadata,
                        undefined,
                        chosenName
                      );
                    }
                  }}
                  style={{
                    minHeight: 38,
                    padding: '0 14px',
                    borderRadius: 8,
                    background: creatingCloudApple ? '#251018' : 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))',
                    color: creatingCloudApple ? '#fda4af' : 'var(--imp-accent-active-text, #f5e1be)',
                    border: creatingCloudApple ? '1px solid #fb7185' : '1px solid var(--imp-focus-ring, #e8b86d)',
                    fontWeight: 800,
                    fontSize: 12,
                    cursor: 'pointer',
                    flexShrink: 0,
                  }}
                >
                  {creatingCloudApple ? 'Create Cloud' : 'Create & Add'}
                </button>
              </div>
            )}

            <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
              {[...playlists]
                .sort((a, b) => (a.origin === 'simp_local' ? -1 : 1) - (b.origin === 'simp_local' ? -1 : 1))
                .map((p, idx) => {
                  const isLocal = p.origin === 'simp_local';
                  const isPinnedApple = p.origin === 'apple_remote';
                  const isPinnedSc = p.origin === 'soundcloud_remote';
                  const rawAppleId = isPinnedApple ? p.id.replace(/^applemusic:playlist:/, '') : '';
                  const rawScId = isPinnedSc ? p.id.replace(/^soundcloud:playlist:/, '') : '';
                  const isAppleEditable =
                    isPinnedApple &&
                    appleAuthenticated &&
                    (editableAppleIdSet.has(rawAppleId) || rawAppleId.startsWith('p.'));
                  const isScEditable =
                    isPinnedSc && scAuthenticated && editableScIdSet.has(rawScId);
                  const canSameSourceOnlineWrite =
                    (isAppleBatch && isAppleEditable) || (isSoundCloudBatch && isScEditable);
                  const isPreferred =
                    p.id === activePlaylistId || (!activePlaylistId && idx === 0);

                  return (
                    <button
                      key={p.id}
                      disabled={Boolean(busyMsg)}
                      data-default-focus={
                        !pendingHybridAdd.creatingNew && !creatingCloudApple && isPreferred
                          ? 'true'
                          : undefined
                      }
                      onClick={() => {
                        if (canSameSourceOnlineWrite) {
                          setOnlineChoice({
                            provider: isAppleEditable ? 'apple' : 'soundcloud',
                            cloudPlaylistId: isAppleEditable ? rawAppleId : rawScId,
                            pinnedPlaylistId: p.id,
                            title: cleanCollectionTitle(p.name),
                            trackCount: p.track_count,
                          });
                          focusFirstModalButton();
                          return;
                        }
                        const job = pendingHybridAdd;
                        closeModal();
                        commitAddTracksToPlaylist(
                          job.uris,
                          job.label,
                          job.trackMetadata,
                          p.id
                        );
                      }}
                      style={{
                        minHeight: 44,
                        padding: '0 14px',
                        borderRadius: 10,
                        background: isPreferred ? 'var(--imp-accent-active-bg, rgba(232, 184, 109, 0.13))' : '#101018',
                        border: isPreferred ? '1px solid var(--imp-focus-ring, #e8b86d)' : '1px solid #222230',
                        color: '#e4e4ec',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 10,
                        cursor: 'pointer',
                        textAlign: 'left',
                      }}
                    >
                      <span
                        style={{
                          fontSize: 13,
                          fontWeight: 800,
                          color: isLocal ? 'var(--imp-accent-active-text, #f5e1be)' : '#fde68a',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {isLocal ? '★ ' : '📌 '}
                        {cleanCollectionTitle(p.name)}
                      </span>
                      <span
                        style={{
                          fontSize: 10.5,
                          fontFamily: 'monospace',
                          color: isLocal
                            ? 'var(--imp-accent-active-text, #f5e1be)'
                            : canSameSourceOnlineWrite
                              ? '#fda4af'
                              : '#fbbf24',
                          whiteSpace: 'nowrap',
                          flexShrink: 0,
                        }}
                      >
                        {isLocal
                          ? `${p.track_count} ${p.track_count === 1 ? 'track' : 'tracks'}`
                          : canSameSourceOnlineWrite
                            ? `☁️ Editable / Fork • ${p.track_count}`
                            : isPinnedApple || isPinnedSc
                              ? `🔒 Read-Only (Fork) • ${p.track_count}`
                              : `Fork to Hybrid • ${p.track_count}`}
                      </span>
                    </button>
                  );
                })}

              {unpinnedEditableApple.map((cp) => (
                <button
                  key={`apple-cloud-${cp.id}`}
                  disabled={Boolean(busyMsg)}
                  onClick={() => {
                    setOnlineChoice({
                      provider: 'apple',
                      cloudPlaylistId: cp.id,
                      title: cp.name,
                      trackCount: 0,
                    });
                    focusFirstModalButton();
                  }}
                  style={{
                    minHeight: 44,
                    padding: '0 14px',
                    borderRadius: 10,
                    background: '#180c12',
                    border: '1px solid #4c1d2e',
                    color: '#e4e4ec',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 800,
                      color: '#fda4af',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 6,
                    }}
                  >
                    <ImpIcon name="apple" size={13} color="#fb7185" />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{cp.name}</span>
                  </span>
                  <span
                    style={{
                      fontSize: 10.5,
                      fontFamily: 'monospace',
                      color: '#fb7185',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    ☁️ Editable Cloud
                  </span>
                </button>
              ))}

              {unpinnedEditableSc.map((sp) => (
                <button
                  key={`sc-set-${sp.id}`}
                  disabled={Boolean(busyMsg)}
                  onClick={() => {
                    setOnlineChoice({
                      provider: 'soundcloud',
                      cloudPlaylistId: sp.id.replace(/^soundcloud:playlist:/, ''),
                      title: sp.name,
                      trackCount: sp.track_count,
                    });
                    focusFirstModalButton();
                  }}
                  style={{
                    minHeight: 44,
                    padding: '0 14px',
                    borderRadius: 10,
                    background: '#1a0e07',
                    border: '1px solid #59260a',
                    color: '#e4e4ec',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 800,
                      color: '#fdba74',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    ☁️ {sp.name}
                  </span>
                  <span
                    style={{
                      fontSize: 10.5,
                      fontFamily: 'monospace',
                      color: '#fb923c',
                      whiteSpace: 'nowrap',
                      flexShrink: 0,
                    }}
                  >
                    ☁️ Editable Set • {sp.track_count}
                  </span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
};
