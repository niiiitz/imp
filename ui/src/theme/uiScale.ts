import { useEffect, useState } from 'react';

export type UiScalePreset = 'auto' | 100 | 125 | 150 | 175;

const UI_SCALE_STORAGE_KEY = 'imp_ui_scale_v1';
const UI_SCALE_EVENT = 'imp-ui-scale-changed';
const UI_SCALE_ORDER: readonly UiScalePreset[] = ['auto', 100, 125, 150, 175];

/**
 * Loads the persisted UI scale preset, defaulting to `'auto'`.
 */
export function loadUiScalePreset(): UiScalePreset {
  if (typeof window === 'undefined') return 'auto';
  try {
    const raw = window.localStorage.getItem(UI_SCALE_STORAGE_KEY);
    if (raw === '100') return 100;
    if (raw === '125') return 125;
    if (raw === '150') return 150;
    if (raw === '175') return 175;
    if (raw === 'auto') return 'auto';
  } catch {
    // ignore storage access failures
  }
  return 'auto';
}

/**
 * Computes responsive UI scaling from viewport dimensions:
 * 1.0x at 800p baseline (<= 1340x840) and gently scaled up to 1.35x on 1440p/4K displays.
 */
export function computeAutoUiScale(
  vw = typeof window !== 'undefined' ? window.innerWidth : 1280,
  vh = typeof window !== 'undefined' ? window.innerHeight : 800
): number {
  if (vw <= 1340 && vh <= 840) return 1;
  const minRatio = Math.min(vw / 1280, vh / 800);
  const scaled = 1 + (minRatio - 1) * 0.38;
  return Math.round(Math.min(1.35, Math.max(1, scaled)) * 100) / 100;
}

/**
 * Resolves the numeric scale factor for a given preset and viewport dimensions.
 */
export function resolveUiScale(
  preset: UiScalePreset = loadUiScalePreset(),
  vw = typeof window !== 'undefined' ? window.innerWidth : 1280,
  vh = typeof window !== 'undefined' ? window.innerHeight : 800
): number {
  if (preset === 'auto') {
    return computeAutoUiScale(vw, vh);
  }
  return preset / 100;
}

/**
 * Harmonizes PlayerView control scaling with the active UI Scale preset while
 * clamping safely to viewport bounds so transport controls never clip off-screen.
 */
export function computeEffectivePlayerScale(
  isVideo = false,
  preset: UiScalePreset = loadUiScalePreset()
): number {
  if (typeof window === 'undefined') {
    return preset === 'auto' ? 1 : preset / 100;
  }
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxScale = isVideo ? 1.65 : 1.75;
  const autoPlayerScale =
    vw <= 1340 && vh <= 840
      ? 1
      : Math.min(
          maxScale,
          Math.max(
            1,
            Math.min((vw - 192) / (isVideo ? 1160 : 1080), (vh - 210) / 520)
          )
        );
  if (preset === 'auto') {
    return autoPlayerScale;
  }
  return (
    Math.round(
      Math.min(
        maxScale,
        Math.max(
          0.85,
          Math.min(preset / 100, (vw - 80) / (isVideo ? 960 : 880), (vh - 120) / 420)
        )
      ) * 100
    ) / 100
  );
}

/**
 * Cycles through `auto -> 100 -> 125 -> 150 -> 175 -> auto`.
 */
export function cycleUiScalePreset(current: UiScalePreset): UiScalePreset {
  const idx = UI_SCALE_ORDER.indexOf(current);
  return UI_SCALE_ORDER[(idx + 1) % UI_SCALE_ORDER.length];
}

/**
 * Formats the UI scale preset into a concise menu label.
 */
export function formatUiScaleLabel(
  preset: UiScalePreset,
  effectiveScale?: number
): string {
  if (preset === 'auto') {
    const resolved = effectiveScale ?? resolveUiScale('auto');
    return `Auto (${Math.round(resolved * 100)}%)`;
  }
  return `${preset}%`;
}

/**
 * Applies `--imp-ui-scale` onto `:root` and returns the resolved scale factor.
 */
export function applyUiScaleToDocument(
  preset: UiScalePreset = loadUiScalePreset()
): number {
  const scale = resolveUiScale(preset);
  if (typeof document !== 'undefined') {
    document.documentElement.style.setProperty('--imp-ui-scale', String(scale));
  }
  return scale;
}

/**
 * Persists a new UI scale preset, updates `--imp-ui-scale`, and notifies active listeners.
 */
export function saveUiScalePreset(preset: UiScalePreset): void {
  try {
    window.localStorage.setItem(UI_SCALE_STORAGE_KEY, String(preset));
  } catch {
    // ignore storage access failures
  }
  const scale = applyUiScaleToDocument(preset);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(UI_SCALE_EVENT, { detail: { preset, scale } })
    );
  }
}

/**
 * React hook returning the active UI scale preset and live effective scale factor.
 */
export function useUiScale(): { preset: UiScalePreset; scale: number } {
  const [state, setState] = useState<{ preset: UiScalePreset; scale: number }>(() => {
    const preset = loadUiScalePreset();
    return { preset, scale: resolveUiScale(preset) };
  });

  useEffect(() => {
    const sync = () => {
      const preset = loadUiScalePreset();
      const scale = applyUiScaleToDocument(preset);
      setState((prev) =>
        prev.preset === preset && prev.scale === scale ? prev : { preset, scale }
      );
    };
    sync();
    window.addEventListener('resize', sync);
    window.addEventListener(UI_SCALE_EVENT, sync);
    return () => {
      window.removeEventListener('resize', sync);
      window.removeEventListener(UI_SCALE_EVENT, sync);
    };
  }, []);

  return state;
}
