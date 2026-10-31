import { componentRadius } from "./component-radius";
import type { CSSProperties } from 'react';
import {
  resolveComponentPartStyle,
  type ComponentPartId,
} from "./component-parts";
import {
  componentCssStyle,
  componentEffectStyle,
  componentBoxShadow,
  withFocusBorder,
  type ColorMode,
  type ComponentId,
  type ComponentState,
  type ThemeDocument,
} from "./theme-model";

export function controlAppearances(
  document: ThemeDocument,
  mode: ColorMode,
  component: 'input' | 'select',
) {
  const resolve = (state: ComponentState) =>
    resolveComponentPartStyle(document, mode, component, 'control', state);
  return {
    rest: resolve('rest'),
    hover: resolve('hover'),
    focus: resolve('focus'),
    disabled: resolve('disabled'),
    invalid: resolve('invalid'),
    valid: resolve('valid'),
    readonly: resolve('readonly'),
  };
}

/** Validation/read-only surfaces are independent of interaction focus. Keep the
 * semantic edge while the stylesheet draws the separate focus-visible outline. */
export function inputAppearanceState(state: {
  disabled: boolean;
  valid: boolean | null;
  focused: boolean;
  hovered: boolean;
  readOnly?: boolean;
  invalid?: boolean;
}): 'rest' | 'hover' | 'focus' | 'disabled' | 'invalid' | 'valid' | 'readonly' {
  return state.disabled ? 'disabled'
    : state.invalid || state.valid === false ? 'invalid'
    : state.valid === true ? 'valid'
    : state.readOnly ? 'readonly'
    : state.focused ? 'focus'
    : state.hovered ? 'hover'
    : 'rest';
}

export function partCss(
  document: ThemeDocument,
  mode: ColorMode,
  component: ComponentId,
  part: ComponentPartId,
  state: ComponentState = 'rest',
) {
  return componentCssStyle(
    resolveComponentPartStyle(document, mode, component, part, state),
  );
}
export function choiceState(state: {
  checked: boolean;
  disabled: boolean;
  indeterminate?: boolean;
  focused?: boolean;
  hovered?: boolean;
}): ComponentState {
  return state.disabled
    ? 'disabled'
    : state.indeterminate
      ? 'indeterminate'
      : state.checked
        ? 'checked'
        : state.focused
          ? 'focus'
          : state.hovered
            ? 'hover'
            : 'rest';
}
export function choiceAppearance(
  document: ThemeDocument,
  mode: ColorMode,
  component: 'checkbox' | 'switch',
) {
  return (state: Parameters<typeof choiceState>[0]) =>
    withFocusBorder(
      resolveComponentPartStyle(
        document,
        mode,
        component,
        'control',
        choiceState(state),
      ),
      state.focused && !state.disabled
        ? resolveComponentPartStyle(
            document,
            mode,
            component,
            'control',
            'focus',
          )
        : undefined,
    );
}
export function choiceMarkStyle(
  document: ThemeDocument,
  mode: ColorMode,
  component: 'checkbox' | 'switch',
  state: ComponentState,
): CSSProperties {
  const style = resolveComponentPartStyle(
    document,
    mode,
    component,
    component === 'checkbox' ? 'indicator' : 'thumb',
    state,
  );
  return component === 'checkbox'
    ? { color: style.foreground }
    : {
        ...componentEffectStyle(style),
        backgroundColor: style.background,
        backgroundImage: style.backgroundImage,
        borderRadius: componentRadius(style),
        borderWidth: 0,
        boxShadow: componentBoxShadow(style),
      };
}
export function selectAppearances(
  document: ThemeDocument,
  mode: ColorMode,
  themeVariables: CSSProperties,
) {
  const control = controlAppearances(document, mode, 'select');
  return {
    labelStyle: partCss(document, mode, 'select', 'label'),
    triggerStyle: ({
      hovered,
      focused,
      open,
      disabled,
    }: {
      hovered: boolean;
      focused: boolean;
      open: boolean;
      disabled: boolean;
    }) =>
      componentCssStyle(
        control[
          disabled
            ? 'disabled'
            : focused || open
              ? 'focus'
              : hovered
                ? 'hover'
                : 'rest'
        ],
      ),
    popupStyle: {
      ...themeVariables,
      ...partCss(document, mode, 'select', 'popover'),
    },
    sideOffset: resolveComponentPartStyle(document, mode, 'select', 'popover')
      .gap,
    optionStyle: ({
      disabled,
      selected,
      highlighted,
    }: {
      disabled: boolean;
      selected: boolean;
      highlighted: boolean;
    }) =>
      partCss(
        document,
        mode,
        'select',
        'option',
        disabled
          ? 'disabled'
          : highlighted
            ? 'highlighted'
            : selected
              ? 'selected'
              : 'rest',
      ),
  };
}
