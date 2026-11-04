import { Platform } from 'react-native';

import { useResolvedScheme } from '@/lib/appearance-store';

/** The desktop's shadcn neutral palette, so both apps feel like one thing. */
const palette = {
  light: {
    background: '#ffffff',
    surface: '#f5f5f5',
    text: '#0a0a0a',
    muted: '#737373',
    faint: '#a3a3a3',
    border: '#e5e5e5',
    selected: '#ffffff',
    primary: '#171717',
    onPrimary: '#fafafa',
    danger: '#dc2626',
    /** Kin gold (KI-23): only for what Kin made. */
    kin: '#b4852f',
    kinInk: '#7d5f22',
  },
  dark: {
    background: '#0a0a0a',
    surface: '#171717',
    text: '#fafafa',
    muted: '#a3a3a3',
    faint: '#737373',
    border: '#262626',
    selected: '#494949',
    primary: '#e5e5e5',
    onPrimary: '#171717',
    danger: '#f87171',
    kin: '#d8b45c',
    kinInk: '#e0c27a',
  },
};

export type Theme = (typeof palette)['light'];

export function useTheme(): Theme {
  return palette[useResolvedScheme()];
}

/** KI-100 Paper Phone 1. Native controls keep the phone's existing type. */
export const appearanceStyle = {
  inset: 16,
  gap: 16,
  radius: 12,
  segmentRadius: 10,
  segmentInset: 3,
  segmentItemRadius: 7,
  hit: 44,
  row: 56,
  reserved: 24,
  label: { fontSize: 16, lineHeight: 20 },
  value: { fontSize: 17, lineHeight: 22 },
  percent: { fontSize: 15, lineHeight: 20 },
  step: { fontSize: 24, lineHeight: 30 },
  previewTitle: { fontSize: 22, lineHeight: 28 },
  previewBody: { fontSize: 19, lineHeight: 29 },
} as const;

export const fonts = {
  /** New York on iOS, like the desktop editor. */
  serif: Platform.select({ ios: 'ui-serif', default: 'serif' }),
  /** Matches the phone editor's native monospace fallback. */
  mono: Platform.select({ ios: 'Menlo', default: 'monospace' }),
};
