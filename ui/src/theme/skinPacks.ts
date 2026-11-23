import { ImpIconName } from '../components/icons/ImpIcon';

export type SkinPackId =
  | 'studio-graphite'
  | 'imp-portal-dark'
  | 'classic-clickwheel'
  | 'demoscene-phosphor';

export interface SkinPackDefinition {
  id: SkinPackId;
  name: string;
  tagline: string;
  badge: string;
  tokens: {
    bgCanvas: string;
    surfacePanel: string;
    surfaceCard: string;
    surfaceElevated: string;
    borderSubtle: string;
    borderStrong: string;
    textPrimary: string;
    textSecondary: string;
    brandPrimary: string;
    brandSecondary: string;
    focusRing: string;
    focusGlow: string;
    accentActiveBg: string;
    accentActiveBorder: string;
    accentActiveText: string;
    iconStrokeWidth: number;
  };
  iconOverrides?: Partial<Record<ImpIconName, ImpIconName>>;
}

export const SKIN_PACK_REGISTRY: SkinPackDefinition[] = [
  {
    id: 'studio-graphite',
    name: 'Studio Graphite',
    tagline: 'Flat studio graphite surfaces, 1px hairlines, and warm ivory focus',
    badge: 'DEFAULT • STUDIO',
    tokens: {
      bgCanvas: '#121418',
      surfacePanel: '#161920',
      surfaceCard: '#1a1d24',
      surfaceElevated: '#21252f',
      borderSubtle: 'rgba(255, 255, 255, 0.08)',
      borderStrong: 'rgba(255, 255, 255, 0.16)',
      textPrimary: '#eef0f4',
      textSecondary: '#8b92a1',
      brandPrimary: '#e8b86d',
      brandSecondary: '#94a3b8',
      focusRing: '#e8b86d',
      focusGlow: 'rgba(232, 184, 109, 0.26)',
      accentActiveBg: 'rgba(232, 184, 109, 0.13)',
      accentActiveBorder: 'rgba(232, 184, 109, 0.52)',
      accentActiveText: '#f5e1be',
      iconStrokeWidth: 2,
    },
  },
  {
    id: 'imp-portal-dark',
    name: 'IMP Portal Dark',
    tagline: 'OLED dark surfaces with warm amber & slate accents',
    badge: 'OLED',
    tokens: {
      bgCanvas: '#0b0c10',
      surfacePanel: '#101218',
      surfaceCard: 'rgba(18, 21, 29, 0.94)',
      surfaceElevated: 'rgba(25, 30, 41, 0.96)',
      borderSubtle: 'rgba(255, 255, 255, 0.10)',
      borderStrong: 'rgba(255, 255, 255, 0.18)',
      textPrimary: '#f1f5f9',
      textSecondary: '#94a3b8',
      brandPrimary: '#e8b86d',
      brandSecondary: '#fb923c',
      focusRing: '#e8b86d',
      focusGlow: 'rgba(232, 184, 109, 0.26)',
      accentActiveBg: 'rgba(232, 184, 109, 0.14)',
      accentActiveBorder: 'rgba(232, 184, 109, 0.52)',
      accentActiveText: '#f5e1be',
      iconStrokeWidth: 2,
    },
  },
  {
    id: 'classic-clickwheel',
    name: 'Classic Click-Wheel',
    tagline: 'Anodized slate & brushed silver tribute to the pocket MP3 player',
    badge: 'RETRO • MP3',
    tokens: {
      bgCanvas: '#131720',
      surfacePanel: '#181e29',
      surfaceCard: 'rgba(26, 33, 46, 0.95)',
      surfaceElevated: 'rgba(34, 44, 61, 0.98)',
      borderSubtle: 'rgba(148, 163, 184, 0.18)',
      borderStrong: 'rgba(203, 213, 225, 0.28)',
      textPrimary: '#f1f5f9',
      textSecondary: '#cbd5e1',
      brandPrimary: '#e2e8f0',
      brandSecondary: '#4ade80',
      focusRing: '#e2e8f0',
      focusGlow: 'rgba(226, 232, 240, 0.24)',
      accentActiveBg: 'rgba(226, 232, 240, 0.12)',
      accentActiveBorder: 'rgba(226, 232, 240, 0.45)',
      accentActiveText: '#f8fafc',
      iconStrokeWidth: 2.1,
    },
  },
  {
    id: 'demoscene-phosphor',
    name: 'Demoscene CRT Phosphor',
    tagline: 'High-contrast emerald & amber vector CRT terminal aesthetic',
    badge: '64K • CRT',
    tokens: {
      bgCanvas: '#0c120e',
      surfacePanel: '#101913',
      surfaceCard: 'rgba(16, 29, 20, 0.94)',
      surfaceElevated: 'rgba(22, 40, 28, 0.98)',
      borderSubtle: 'rgba(74, 222, 128, 0.18)',
      borderStrong: 'rgba(74, 222, 128, 0.34)',
      textPrimary: '#ecfdf5',
      textSecondary: '#86efac',
      brandPrimary: '#4ade80',
      brandSecondary: '#facc15',
      focusRing: '#4ade80',
      focusGlow: 'rgba(74, 222, 128, 0.26)',
      accentActiveBg: 'rgba(74, 222, 128, 0.14)',
      accentActiveBorder: 'rgba(74, 222, 128, 0.5)',
      accentActiveText: '#dcfce7',
      iconStrokeWidth: 1.9,
    },
  },
];

const SKIN_STORAGE_KEY = 'imp_active_skin_pack';
const SKIN_GRAPHITE_MIGRATION_KEY = 'imp_skin_migrated_graphite_v1';

export function loadActiveSkinPackId(): SkinPackId {
  try {
    const migrated = window.localStorage.getItem(SKIN_GRAPHITE_MIGRATION_KEY);
    const raw = window.localStorage.getItem(SKIN_STORAGE_KEY);
    if (!migrated) {
      window.localStorage.setItem(SKIN_GRAPHITE_MIGRATION_KEY, '1');
      if (!raw || raw === 'imp-portal-dark') {
        window.localStorage.setItem(SKIN_STORAGE_KEY, 'studio-graphite');
        return 'studio-graphite';
      }
    }
    if (raw && SKIN_PACK_REGISTRY.some((s) => s.id === raw)) {
      return raw as SkinPackId;
    }
  } catch {
    // ignore storage errors
  }
  return 'studio-graphite';
}

export function getSkinPack(id: SkinPackId): SkinPackDefinition {
  return SKIN_PACK_REGISTRY.find((s) => s.id === id) || SKIN_PACK_REGISTRY[0];
}

export function applySkinPackToDocument(id: SkinPackId): SkinPackDefinition {
  const pack = getSkinPack(id);
  try {
    window.localStorage.setItem(SKIN_STORAGE_KEY, pack.id);
  } catch {
    // ignore
  }
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    root.setAttribute('data-imp-skin', pack.id);
    root.style.setProperty('--imp-bg-canvas', pack.tokens.bgCanvas);
    root.style.setProperty('--imp-surface-panel', pack.tokens.surfacePanel);
    root.style.setProperty('--imp-surface-card', pack.tokens.surfaceCard);
    root.style.setProperty('--imp-surface-elevated', pack.tokens.surfaceElevated);
    root.style.setProperty('--imp-border-subtle', pack.tokens.borderSubtle);
    root.style.setProperty('--imp-border-strong', pack.tokens.borderStrong);
    root.style.setProperty('--imp-text-primary', pack.tokens.textPrimary);
    root.style.setProperty('--imp-text-secondary', pack.tokens.textSecondary);
    root.style.setProperty('--imp-brand-primary', pack.tokens.brandPrimary);
    root.style.setProperty('--imp-brand-secondary', pack.tokens.brandSecondary);
    root.style.setProperty('--imp-focus-ring', pack.tokens.focusRing);
    root.style.setProperty('--imp-focus-glow', pack.tokens.focusGlow);
    root.style.setProperty('--imp-accent-active-bg', pack.tokens.accentActiveBg);
    root.style.setProperty('--imp-accent-active-border', pack.tokens.accentActiveBorder);
    root.style.setProperty('--imp-accent-active-text', pack.tokens.accentActiveText);
    root.style.setProperty('--imp-accent-primary', pack.tokens.focusRing);
    root.style.setProperty('--imp-accent-glow', pack.tokens.focusGlow);
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('imp-skin-pack-changed', { detail: pack }));
  }
  return pack;
}
