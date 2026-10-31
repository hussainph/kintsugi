import type { ComponentPartId } from './component-parts';
import { componentReferenceSource } from './component-references';
import { colorWithOpacity } from './dialkit-color';
import type {
  ButtonVariant,
  ColorKey,
  ColorMode,
  ComponentId,
  ComponentState,
  ComponentStyle,
  ComponentTokens,
  ThemeDefinition,
  ThemeDocument,
} from './theme-model';

/** KI-20's approved dark-only semantic assignments, not a palette replacement. */
export const DARK_CONTRAST_ROLES = {
  foreground: 'neutral-9',
  focus: 'neutral-9',
  indicator: 'neutral-10',
  onIndicator: 'neutral-1',
} as const satisfies Record<string, ColorKey>;

export function hasCapturedDarkContrast(theme: ThemeDefinition, mode: ColorMode) {
  return mode === 'dark' && theme.name === 'Charter' &&
    theme.colors.dark['color-1'].toLowerCase() === '#0a0a0a' &&
    theme.colors.dark['neutral-1'].toLowerCase() === '#191919';
}

/** Call only for default semantic roles; authored assignments stay literal. */
export function contrastRoleColorKey(
  theme: ThemeDefinition,
  mode: ColorMode,
  key: ColorKey,
  role: keyof typeof DARK_CONTRAST_ROLES,
): ColorKey {
  return hasCapturedDarkContrast(theme, mode) &&
    (key === 'color-1' || key === 'color-1-transparent')
    ? DARK_CONTRAST_ROLES[role]
    : key;
}

/** The default focus halo needs visible ink, not 24% of an already 20% token.
 * Preserve its geometry and every other elevation layer. Authored rings bypass it. */
export function defaultComponentFocusShadow(theme: ThemeDefinition, mode: ColorMode) {
  return hasCapturedDarkContrast(theme, mode)
    ? `0 0 0 ${theme.border.l}px ${theme.colors.dark[DARK_CONTRAST_ROLES.focus]}`
    : undefined;
}

/** Apply the approved differences to a resolved appearance. This is also usable
 * by spec samplers: pass the captured tokens/style (including referenced parts).
 * Only color roles change; geometry, edge placement, effects and source data do not.
 */
export function correctComponentContrastStyle(
  document: ThemeDocument,
  mode: ColorMode,
  component: ComponentId,
  part: ComponentPartId,
  state: ComponentState,
  variant: ButtonVariant | 'default',
  tokens: ComponentTokens,
  captured: ComponentStyle,
): ComponentStyle {
  const theme = document.theme;
  if (!hasCapturedDarkContrast(theme, mode)) return captured;
  const source = componentReferenceSource(document, component, part);
  if (source) {
    component = source.component;
    part = source.part;
    variant = source.variant ?? 'default';
  }
  const authored = (
    key: keyof ComponentTokens,
    targetPart = part,
    targetState = state,
  ) => ['rest', targetState].some(value => [
    `${component}:${variant}:${value}`,
    `${component}:${variant}:part:${targetPart}:${value}`,
  ].some(id => document.componentTokens[id]?.[key] !== undefined));
  const color = (role: keyof typeof DARK_CONTRAST_ROLES) =>
    theme.colors.dark[DARK_CONTRAST_ROLES[role]];
  const palette1 = (key: ColorKey) => key === 'color-1' || key === 'color-1-transparent';
  const fill = (role: keyof typeof DARK_CONTRAST_ROLES) => {
    const opacity = Math.max(0, Math.min(100, tokens.backgroundOpacity ?? 100));
    return opacity === 100 ? color(role)
      : `color-mix(in srgb, ${color(role)} ${opacity}%, transparent)`;
  };
  const style = { ...captured };
  const radioDot = component === 'radio' && part === 'indicator';
  const range = ['slider', 'progress', 'meter'].includes(component);
  const rangeFill = range && part === 'indicator';
  const counterpart = component === 'radio' && (radioDot || part === 'control')
    ? 'control'
    : range && (rangeFill || part === 'thumb') ? 'track' : undefined;
  const prefix = `${component}:${variant}:`;
  // Enabled counterpart states can differ (a focused Slider track still uses
  // its rest-state indicator), but disabled and enabled surfaces cannot coexist.
  // Rest is the inherited base; otherwise preserve only edits in the same
  // enabled/disabled partition, not an unrelated disabled-only customization.
  const preserveCounterpart = counterpart !== undefined &&
    Object.entries(document.componentTokens).some(([id, overrides]) => {
      if (overrides.background === undefined) return false;
      const partPrefix = `${prefix}part:${counterpart}:`;
      const counterpartState = id.startsWith(partPrefix)
        ? id.slice(partPrefix.length)
        : id.startsWith(prefix) && !id.slice(prefix.length).includes(':')
          ? id.slice(prefix.length) : undefined;
      return counterpartState !== undefined &&
        (counterpartState === 'rest' ||
          (counterpartState === 'disabled') === (state === 'disabled'));
    });

  // The separate outline is available in checked/selected/invalid/etc. appearances
  // too. A local or shared authored ring always wins, even if it chooses Color 1.
  if (!theme.focusRing && !tokens.focusRing && !authored('focusRing', part, 'focus')) {
    const oldOutline = `${Math.max(2, theme.border.m)}px solid ${theme.colors.dark['color-1']}`;
    if (style.focusOutline === oldOutline)
      style.focusOutline = `${Math.max(2, theme.border.m)}px solid ${color('focus')}`;
    if (state === 'focus') {
      const transparent = colorWithOpacity(theme.colors.dark['color-1'],
        Math.max(0, Math.min(100, theme.colorTranslucency?.dark?.['color-1'] ?? 20)) / 100);
      const oldHalo = `0 0 0 ${theme.border.l}px color-mix(in srgb, ${transparent} 24%, transparent)`;
      // Exact default layer only; never recolor authored elevation/shadow stacks.
      if (style.shadow.endsWith(oldHalo))
        style.shadow = style.shadow.slice(0, -oldHalo.length) + defaultComponentFocusShadow(theme, mode);
    }
  }
  if (state === 'focus' && palette1(tokens.borderColor) && !authored('borderColor') && !preserveCounterpart)
    style.borderColor = color('focus');
  const checkedFill = ['checkbox', 'switch'].includes(component) && part === 'control' &&
    (state === 'checked' || state === 'indeterminate');
  const defaultPair = theme.primaryForeground?.dark === undefined;
  const authoredPair = authored('foreground') ||
    (checkedFill && component === 'checkbox' && authored('foreground', 'indicator')) ||
    (checkedFill && component === 'switch' && authored('background', 'thumb'));
  const indicatorFill = (radioDot || ((rangeFill || checkedFill) && defaultPair && !authoredPair)) &&
    tokens.background === 'color-1' && !authored('background') && !preserveCounterpart;
  if (indicatorFill) {
    style.background = fill('indicator');
    if (!authored('foreground') && ['neutral-1', 'neutral-10'].includes(tokens.foreground))
      style.foreground = color('onIndicator');
  }
  if (tokens.foreground === 'color-1' && !authored('foreground') && !preserveCounterpart)
    style.foreground = color(radioDot ? 'indicator' : 'foreground');

  // Checked boundaries and the range thumb are foreground graphics, not brand
  // surfaces. Completion is the OTP field's persistent value indicator.
  if (state !== 'focus' && palette1(tokens.borderColor) && !authored('borderColor') && !preserveCounterpart &&
    (checkedFill || (component === 'radio' && part === 'control' && state === 'checked') ||
      (component === 'slider' && part === 'thumb') ||
      (component === 'otp-field' && part === 'input' && state === 'complete')))
    style.borderColor = color('indicator');

  if (component === 'checkbox' && part === 'indicator' &&
    (state === 'checked' || state === 'indeterminate') && defaultPair &&
    !authored('foreground') && !authored('foreground', 'control') && !authored('background', 'control'))
    style.foreground = color('onIndicator');

  // The unchecked thumb must contrast against Neutral 4; the checked thumb must
  // invert against the corrected light track. Disabled/customized thumbs survive.
  if (component === 'switch' && part === 'thumb' && state !== 'disabled' && defaultPair &&
    tokens.background === 'neutral-1' && !authored('background') &&
    !authored('background', 'control') && !authored('foreground', 'control')) {
    const role = state === 'checked' ? 'onIndicator' : 'indicator';
    style.background = fill(role);
    if (!authored('foreground') && tokens.foreground === 'neutral-1')
      style.foreground = color(role);
  }
  return style;
}
