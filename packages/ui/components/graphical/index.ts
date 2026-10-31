export * from './components/library/consumer';
export { theme } from './theme';
export type { ThemeDocument, ColorMode } from './lib/theme-model';
// Non-visual integration utilities follow the installed Base UI API unchanged.
export { CSPProvider } from '@base-ui/react/csp-provider';
export { DirectionProvider } from '@base-ui/react/direction-provider';
export { mergeProps } from '@base-ui/react/merge-props';
export { useRender } from '@base-ui/react/use-render';
