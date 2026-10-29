import { Platform, useColorScheme } from 'react-native';

/** The desktop's shadcn neutral palette, so both apps feel like one thing. */
const palette = {
  light: {
    background: '#ffffff',
    surface: '#f5f5f5',
    text: '#0a0a0a',
    muted: '#737373',
    faint: '#a3a3a3',
    border: '#e5e5e5',
    primary: '#171717',
    onPrimary: '#fafafa',
    danger: '#dc2626',
  },
  dark: {
    background: '#0a0a0a',
    surface: '#171717',
    text: '#fafafa',
    muted: '#a3a3a3',
    faint: '#737373',
    border: '#262626',
    primary: '#e5e5e5',
    onPrimary: '#171717',
    danger: '#f87171',
  },
};

export type Theme = (typeof palette)['light'];

export function useTheme(): Theme {
  return palette[useColorScheme() === 'dark' ? 'dark' : 'light'];
}

export const fonts = {
  /** New York on iOS, like the desktop editor. */
  serif: Platform.select({ ios: 'ui-serif', default: 'serif' }),
};
